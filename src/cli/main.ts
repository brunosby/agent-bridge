// Entry point: start the server, open or restore a conversation, restart and quit.
import { browserSession, setBridgePort } from '../server/browser-session.ts';
import { S } from '../server/state.ts';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { execFile, spawn, spawnSync } from 'node:child_process';
import { setupLogFile } from '../config/logging.ts';
import { argv } from '../config/args.ts';
import { listConversations } from '../core/history.ts';
import { APP_DIR, LOGS_DIR, config, port, setting } from '../config/settings.ts';
import { closeConversation, openConversation, startAgents } from '../server/conversation.ts';
import { logError, publish, publishState } from '../server/events.ts';
import { clients } from '../server/state.ts';
import { server } from '../server/http.ts';
import { setReviewMcpPort } from '../server/review-mcp.ts';
import { ROUTING_MODES } from '../core/prompts.ts';
setupLogFile();

let restoreId: string | null = null;
if (argv.resume) {
  const list = listConversations(LOGS_DIR);
  restoreId = argv.resume === true ? (list[0]?.id ?? null) : String(argv.resume);
  const exists = restoreId && (list.some((c) => c.id === restoreId) || fs.existsSync(path.join(LOGS_DIR, restoreId, 'transcript.jsonl')));
  if (!exists) fail(argv.resume === true ? 'no earlier conversation to resume' : `conversation ${argv.resume} not found in ${LOGS_DIR}`);
}

function initializeConversation() {
  try {
    const workDir = typeof argv.cwd === 'string' ? argv.cwd : config.workDir || process.cwd();
    const { saved } = openConversation({ workDir: path.resolve(workDir), restoreId });
    if (saved)
      publish({
        kind: 'system',
        text: `Restored conversation from ${new Date(saved.startedAt || Date.now()).toLocaleString()} with ${S.conv.team.length} agent(s). Relay is paused until you send a message.`,
      });
  } catch (err) {
    fail(err instanceof Error ? err.message : String(err));
  }
}

process.on('uncaughtException', (err) => {
  logError('bridge', `uncaught: ${err.stack || err.message}`);
  console.error(err);
});
process.on('unhandledRejection', (err) => {
  logError('bridge', `unhandled rejection: ${err instanceof Error ? err.stack : String(err)}`);
});

// After a restart the old process may still hold the port for a moment: retry for a few seconds.
let listenTries = 0;
const launchDirectory = path.resolve(typeof argv.cwd === 'string' ? argv.cwd : config.workDir || process.cwd());
const instanceKey = createHash('sha256')
  .update(process.platform === 'win32' ? launchDirectory.toLowerCase() : launchDirectory)
  .digest('hex');
const instanceFile = path.join(LOGS_DIR, '.instance-' + instanceKey);
async function reopen(port: number) {
  if (!Number.isInteger(port) || port <= 0 || port > 65535) return false;
  for (let attempt = 0; attempt < 3; attempt++) {
    let result;
    try {
      result = await fetch('http://127.0.0.1:' + port + '/open', {
        method: 'POST',
        headers: { 'x-bridge-instance': instanceKey, connection: 'close' },
        signal: AbortSignal.timeout(1500),
        redirect: 'error',
      });
    } catch {
      return false;
    }
    if (result.headers.get('x-bridge-instance') !== instanceKey) return false;
    if (result.status !== 429) return result.status === 204;
    const seconds = Number(result.headers.get('retry-after')) || 1;
    await new Promise((r) => setTimeout(r, Math.min(3, Math.max(1, seconds)) * 1000));
  }
  return fail('A browser tab was requested repeatedly. Reopen the shortcut in a few seconds.');
}
const reopened =
  argv.hidden && !port && !restoreId && fs.existsSync(instanceFile) && (await reopen(Number(fs.readFileSync(instanceFile, 'utf8'))));
server.on('error', async (err: NodeJS.ErrnoException) => {
  if (err.code === 'EADDRINUSE' && argv['wait-port'] && listenTries++ < 40) {
    setTimeout(() => server.listen(port, '127.0.0.1'), 250);
    return;
  }
  if (err.code === 'EADDRINUSE' && !argv['session-stdin']) {
    if (await reopen(port)) return;
  }
  fail(err.code === 'EADDRINUSE' ? `Port ${port} is already in use. Is Agent Bridge already running?` : err.message);
});

server.on('instance-key', (reply: (key: string) => void) => reply(instanceKey));
server.on('open-browser', () => openBrowser(browserSession.openUrl(listeningPort())));
if (argv['session-stdin']) await browserSession.inherit(process.stdin);
if (!reopened)
  server.listen(port, '127.0.0.1', () => {
    initializeConversation();
    if (argv.hidden && !restoreId) fs.writeFileSync(instanceFile, String(listeningPort()), { mode: 0o600 });
    setBridgePort(listeningPort());
    setReviewMcpPort(listeningPort());
    const address = `http://127.0.0.1:${listeningPort()}/`;
    console.log(`Agent Bridge running at ${address}`);
    console.log(`Working directory: ${S.conv.workDir}`);
    console.log(`Team: ${S.conv.team.map((a) => `${a.name} (${a.driver}, ${a.role})`).join(', ')}`);
    console.log(`Transcript: ${path.join(S.conv.runDir, 'transcript.jsonl')}`);
    console.log('Stop or restart from the buttons at the top of the page (or Ctrl+C here).');
    if (!restoreId)
      publish({
        kind: 'system',
        text: `Session started in ${S.conv.workDir}. Team: ${S.conv.team.map((a) => `${a.name} (${S.roles[a.role]?.name})`).join(', ')}. Routing: ${ROUTING_MODES[S.conv.routingMode].label}.`,
      });
    startAgents();
    publishState();
    if (argv['session-stdin']) return;
    const url = browserSession.openUrl(listeningPort());
    if ((argv['no-open'] || setting('openBrowser') === false) && process.stdout.isTTY && !argv['log-file'])
      process.stdout.write(url + '\n');
    else openBrowser(url);
  });

let shuttingDown = false;
export async function shutdown() {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log('\nShutting down agents...');
  // Stop accepting requests first, so the page sees the app as closed right away.
  server.close();
  for (const res of clients) res.end();
  const saved = await closeConversation();
  process.exit(saved ? 0 : 1);
}

/**
 * Restart from the page: start a new server process on the same port that resumes this conversation,
 * then exit. Used instead of closing the console window (which does not exist with the hidden launcher).
 */
export async function restartServer() {
  const keep = [];
  const skip = new Set(['resume', 'port', 'cwd', 'no-open', 'main', 'exit-with-parent', 'max-lifetime', 'session-stdin']);
  for (const [k, v] of Object.entries(argv)) if (!skip.has(k)) keep.push(`--${k}`, ...(v === true ? [] : [String(v)]));
  const childArgs = [
    path.join(APP_DIR, 'bin', 'agent-bridge.mjs'),
    ...keep,
    '--cwd',
    launchDirectory,
    '--resume',
    S.conv.id,
    '--port',
    String(listeningPort()),
    '--no-open',
    '--wait-port',
    '--session-stdin',
  ];
  await closeConversation();
  // End the open event streams first: server.close() waits for every connection, and a browser tab
  // keeps its event stream open, so closing before ending them never finished.
  for (const res of clients) res.end();
  clients.clear();
  server.closeAllConnections?.();
  await new Promise<void>((r) => {
    const t = setTimeout(r, 3000);
    server.close(() => {
      clearTimeout(t);
      r();
    });
  });
  // The new process writes its own log (--log-file); without one, use the app's logs/server.log.
  if (!argv['log-file']) childArgs.push('--log-file', path.join(APP_DIR, 'logs', 'server.log'));
  const child = spawn(process.execPath, childArgs, {
    cwd: process.cwd(),
    detached: true,
    windowsHide: true,
    stdio: ['pipe', 'ignore', 'ignore'],
  });
  child.stdin.end(browserSession.token);
  child.unref();
  setTimeout(() => process.exit(0), 200);
}
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);

// For test harnesses, so a killed test run never leaves a server behind:
// --exit-with-parent ends the server when its stdin pipe closes, which the OS does when the parent dies,
// even on a forced kill; --max-lifetime <seconds> ends it after that time whatever happens.
if (argv['exit-with-parent']) {
  process.stdin.on('end', () => void shutdown());
  process.stdin.on('error', () => void shutdown());
  process.stdin.resume();
}
const maxLifetime = Number(argv['max-lifetime']);
if (maxLifetime > 0) setTimeout(() => void shutdown(), maxLifetime * 1000).unref();

export function openBrowser(url: string): void {
  publish({ kind: 'system', text: 'A new Agent Bridge tab was opened at ' + new Date().toLocaleTimeString() + '.' });
  if (process.platform === 'win32') execFile('cmd', ['/c', 'start', '', url]);
  else if (process.platform === 'darwin') execFile('open', [url]);
  else execFile('xdg-open', [url]);
}

export function fail(msg: string): never {
  console.error(`agent-bridge: ${msg}`);
  // Started by the hidden launcher: nobody sees the console, so show the error in a message box.
  if (argv.hidden && process.platform === 'win32') {
    const text = `Agent Bridge could not start:\n\n${msg}`.replace(/'/g, "''");
    try {
      spawnSync(
        'powershell.exe',
        [
          '-NoProfile',
          '-WindowStyle',
          'Hidden',
          '-Command',
          `Add-Type -AssemblyName PresentationFramework; [System.Windows.MessageBox]::Show('${text}', 'Agent Bridge') | Out-Null`,
        ],
        { windowsHide: true, timeout: 600000 },
      );
    } catch {
      // nothing else to do
    }
  }
  process.exit(1);
}

/** Port the server is listening on (a free one is chosen when --port is not given). */
function listeningPort(): number {
  const addr = server.address();
  return typeof addr === 'object' && addr ? addr.port : port;
}
