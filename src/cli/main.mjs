// Entry point: start the server, open or restore a conversation, restart and quit.
import { S } from '../server/state.mjs';
import fs from 'node:fs';
import path from 'node:path';
import { execFile, spawn, spawnSync } from 'node:child_process';
import { setupLogFile } from '../config/logging.mjs';
import { argv } from '../config/args.mjs';
import { listConversations } from '../core/history.mjs';
import { APP_DIR, LOGS_DIR, config, port, setting } from '../config/settings.mjs';
import { closeConversation, openConversation, startAgents } from '../server/conversation.mjs';
import { logError, publish, publishState } from '../server/events.mjs';
import { clients } from '../server/state.mjs';
import { server } from '../server/http.mjs';
import { ROUTING_MODES } from '../core/prompts.mjs';
setupLogFile();

export let restoreId = null;
if (argv.resume) {
  const list = listConversations(LOGS_DIR);
  restoreId = argv.resume === true ? list[0]?.id : String(argv.resume);
  const exists = restoreId && (list.some((c) => c.id === restoreId) || fs.existsSync(path.join(LOGS_DIR, restoreId, 'transcript.jsonl')));
  if (!exists) fail(argv.resume === true ? 'no earlier conversation to resume' : `conversation ${argv.resume} not found in ${LOGS_DIR}`);
}

try {
  const { saved } = openConversation({ workDir: path.resolve(argv.cwd || config.workDir || process.cwd()), restoreId });
  if (saved)
    publish({
      kind: 'system',
      text: `Restored conversation from ${new Date(saved.startedAt).toLocaleString()} with ${S.conv.team.length} agent(s). Relay is paused until you send a message.`,
    });
} catch (err) {
  fail(err.message);
}

process.on('uncaughtException', (err) => {
  logError('bridge', `uncaught: ${err.stack || err.message}`);
  console.error(err);
});
process.on('unhandledRejection', (err) => {
  logError('bridge', `unhandled rejection: ${err?.stack || err}`);
});

// After a restart the old process may still hold the port for a moment: retry for a few seconds.
export let listenTries = 0;
server.on('error', (err) => {
  if (err.code === 'EADDRINUSE' && argv['wait-port'] && listenTries++ < 40) {
    setTimeout(() => server.listen(port, '127.0.0.1'), 250);
    return;
  }
  fail(err.code === 'EADDRINUSE' ? `Port ${port} is already in use. Is Agent Bridge already running?` : err.message);
});

server.listen(port, '127.0.0.1', () => {
  const address = `http://127.0.0.1:${server.address().port}/`;
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
  if (!argv['no-open'] && setting('openBrowser') !== false) openBrowser(address);
});

export async function shutdown() {
  console.log('\nShutting down agents...');
  // Stop accepting requests first, so the page sees the app as closed right away.
  server.close();
  for (const res of clients) res.end();
  await closeConversation();
  process.exit(0);
}

/**
 * Restart from the page: start a new server process on the same port that resumes this conversation,
 * then exit. Used instead of closing the console window (which does not exist with the hidden launcher).
 */
export async function restartServer() {
  const keep = [];
  const skip = new Set(['resume', 'port', 'cwd', 'no-open', 'main']);
  for (const [k, v] of Object.entries(argv)) if (!skip.has(k)) keep.push(`--${k}`, ...(v === true ? [] : [String(v)]));
  const childArgs = [
    path.join(APP_DIR, 'bin', 'agent-bridge.mjs'),
    ...keep,
    '--resume',
    S.conv.id,
    '--port',
    String(server.address().port),
    '--no-open',
    '--wait-port',
  ];
  await closeConversation();
  // End the open event streams first: server.close() waits for every connection, and a browser tab
  // keeps its event stream open, so closing before ending them never finished.
  for (const res of clients) res.end();
  clients.clear();
  server.closeAllConnections?.();
  await new Promise((r) => {
    const t = setTimeout(r, 3000);
    server.close(() => {
      clearTimeout(t);
      r();
    });
  });
  // The new process writes its own log (--log-file); without one, use the app's logs/server.log.
  if (!argv['log-file']) childArgs.push('--log-file', path.join(APP_DIR, 'logs', 'server.log'));
  const child = spawn(process.execPath, childArgs, { cwd: process.cwd(), detached: true, windowsHide: true, stdio: 'ignore' });
  child.unref();
  setTimeout(() => process.exit(0), 200);
}
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);

export function openBrowser(url) {
  if (process.platform === 'win32') execFile('cmd', ['/c', 'start', '', url]);
  else if (process.platform === 'darwin') execFile('open', [url]);
  else execFile('xdg-open', [url]);
}

export function fail(msg) {
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
