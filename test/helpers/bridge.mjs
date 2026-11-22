// @ts-check
// Starts a real Agent Bridge server with the scripted "fake" provider and talks to it like the page does.
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
 * @param {{ team: object[], rules: object[], settings?: Record<string, unknown>, resume?: string|boolean, dir?: string }} opts
 */
export async function startBridge({ team, rules, settings = {}, resume, dir }) {
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
    '--exit-with-parent',
    '--max-lifetime',
    '600',
  ];
  if (resume) args.push('--resume', ...(resume === true ? [] : [String(resume)]));
  else args.push('--cwd', work);
  const child = spawn(process.execPath, args, { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
  running.add(child);
  child.on('exit', () => running.delete(child));
  let output = '';
  child.stdout.on('data', (d) => (output += d));
  child.stderr.on('data', (d) => (output += d));

  const base = `http://127.0.0.1:${port}`;
  let token = '';
  for (let i = 0; i < 100 && !token; i++) {
    try {
      const html = await (await fetch(`${base}/`)).text();
      token = (html.match(/name="bridge-token" content="([0-9a-f]+)"/) || [])[1] || '';
    } catch {
      await sleep(100);
    }
  }
  if (!token) throw new Error(`bridge did not start:\n${output}`);

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

  return { api, events, waitFor, state, nameOf, stop, root, work, logs, port, child };
}
