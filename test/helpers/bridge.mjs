// @ts-check
// Starts a real Agent Bridge server with the scripted "fake" provider and talks to it like the page does.
import { randomBytes } from 'node:crypto';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import { fileURLToPath } from 'node:url';

const APP_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
export const SERVER = process.env.AGENT_BRIDGE_ENTRY
  ? path.resolve(APP_DIR, process.env.AGENT_BRIDGE_ENTRY)
  : path.join(APP_DIR, 'bin', 'agent-bridge.mjs');

const sleep = (/** @type {number} */ ms) => new Promise((r) => setTimeout(r, ms));

/** Servers started by this test run; stopped on any exit (the servers also watch their stdin, see below). */
const running = new Set();
process.on('exit', () => {
  for (const c of running) c.kill();
});

function freePort() {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.listen(0, '127.0.0.1', () => {
      const addr = srv.address();
      const port = typeof addr === 'object' && addr ? addr.port : 0;
      srv.close(() => resolve(port));
    });
    srv.on('error', reject);
  });
}

/**
 * @param {{ team: object[], rules: object[], settings?: Record<string, unknown>, resume?: string|boolean, dir?: string, logFile?: boolean, preload?: URL }} opts
 */
export async function startBridge({ team, rules, settings = {}, resume, dir, logFile = false, preload }) {
  const root = dir || fs.mkdtempSync(path.join(os.tmpdir(), 'agent-bridge-test-'));
  const work = path.join(root, 'work');
  const logs = path.join(root, 'logs');
  fs.mkdirSync(work, { recursive: true });
  const configPath = path.join(root, 'config.json');
  fs.writeFileSync(
    configPath,
    JSON.stringify(
      { enableFakeProvider: true, openBrowser: false, userName: 'Tester', defaultTeam: team, fake: { rules, delayMs: 10 }, ...settings },
      null,
      2,
    ),
  );
  const port = await freePort();
  // --exit-with-parent: the server ends when this process dies, even if the test run is killed.
  // --max-lifetime: a last safety net in case the pipe is inherited by something that lives on.
  const args = [
    SERVER,
    '--config',
    configPath,
    '--logs',
    logs,
    '--port',
    String(port),
    '--no-open',
    '--session-stdin',
    '--exit-with-parent',
    '--max-lifetime',
    '600',
  ];
  if (logFile) args.push('--log-file', path.join(root, 'server.log'));
  if (resume) args.push('--resume', ...(resume === true ? [] : [String(resume)]));
  else args.push('--cwd', work);
  if (preload) args.unshift('--import', preload.href);
  const child = preload
    ? spawn(process.execPath, args, { stdio: ['pipe', 'pipe', 'pipe', 'ipc'], windowsHide: true })
    : spawn(process.execPath, args, { stdio: 'pipe', windowsHide: true });
  if (!child.stdin || !child.stdout || !child.stderr) throw new Error('Missing test server pipes');
  const token = randomBytes(18).toString('hex');
  child.stdin.write(token);
  running.add(child);
  child.on('exit', () => running.delete(child));
  let output = '';
  child.stdout.on('data', (d) => (output += d));
  child.stderr.on('data', (d) => (output += d));

  const base = `http://127.0.0.1:${port}`;
  let ready = false;
  for (let i = 0; i < 100 && !ready; i++) {
    try {
      ready = (await fetch(base + '/')).ok;
    } catch {
      await sleep(100);
    }
  }
  if (!ready) throw new Error(`bridge did not start:\n${output}`);

  /** @type {any[]} */
  const events = [];
  const ctrl = new AbortController();
  (async () => {
    const res = await fetch(`${base}/events?token=${token}`, { signal: ctrl.signal });
    if (!res.body) return;
    const reader = res.body.getReader();
    const dec = new TextDecoder();
    let buf = '';
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      buf += dec.decode(value, { stream: true });
      let i;
      while ((i = buf.indexOf('\n\n')) >= 0) {
        const line = buf.slice(0, i);
        buf = buf.slice(i + 2);
        if (line.startsWith('data: ')) events.push(JSON.parse(line.slice(6)));
      }
    }
  })().catch(() => {});

  /** @param {string} action @param {object} [body] */
  async function api(action, body = {}) {
    const res = await fetch(`${base}/api/${action}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Bridge-Token': token },
      body: JSON.stringify(body),
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || res.statusText);
    return data;
  }

  /** Wait until an event matches. @param {(e: any) => boolean} pred @param {number} [ms] */
  async function waitFor(pred, ms = 8000) {
    const end = Date.now() + ms;
    while (Date.now() < end) {
      const e = events.find(pred);
      if (e) return e;
      await sleep(25);
    }
    throw new Error(
      `timeout waiting for event. Last events:\n${events
        .slice(-15)
        .map((e) => `${e.kind} ${e.agent || ''} ${(e.text || '').slice(0, 80)}`)
        .join('\n')}`,
    );
  }

  const state = () => events.filter((e) => e.kind === 'state').pop();
  const nameOf = (/** @type {string} */ id) => state()?.team.find((/** @type {any} */ a) => a.id === id)?.name;

  async function stop() {
    ctrl.abort();
    child.kill();
    await sleep(100);
  }

  return { token, api, events, waitFor, state, nameOf, stop, root, work, logs, port, child };
}
