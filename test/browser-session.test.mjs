import test from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import fs from 'node:fs';
import path from 'node:path';
import { Window } from 'happy-dom';
import { initializeSession, storageKey } from '../public/js/core/browser-session.js';
import { SERVER, startBridge } from './helpers/bridge.mjs';

const start = () =>
  startBridge({
    team: [{ name: 'TesterAgent', role: 'coder', driver: 'fake', bypass: true }],
    rules: [],
    preload: new URL('./helpers/session-fixture.mjs', import.meta.url),
  });
async function reopen(b) {
  const response = once(b.child, 'message', { signal: AbortSignal.timeout(8000) });
  await promisify(execFile)(
    process.execPath,
    [SERVER, '--cwd', b.work, '--config', path.join(b.root, 'config.json'), '--logs', b.logs, '--port', String(b.port), '--no-open'],
    { windowsHide: true },
  );
  const [{ opening }] = await response;
  return opening;
}
function pageFor(url) {
  const page = new Window({ url });
  page.fetch = (route, options) => fetch(new URL(route, url), options);
  return page;
}
async function replay(url, token) {
  const ctrl = new AbortController();
  const res = await fetch(new URL('/events?token=' + token, url), { signal: ctrl.signal });
  assert.equal(res.status, 200);
  let text = '';
  try {
    for await (const chunk of res.body) {
      text += new TextDecoder().decode(chunk);
      if (text.includes('replayComplete')) break;
    }
  } finally {
    ctrl.abort();
  }
  return text;
}
test('a second launcher opens an authenticated tab, reports it and revokes previous access', async () => {
  const b = await start();
  try {
    await b.api('catalog');
    const stream = await fetch('http://127.0.0.1:' + b.port + '/events?token=' + b.token, { signal: AbortSignal.timeout(10000) });
    assert.equal(stream.status, 200);
    const url = await reopen(b);
    const page = pageFor(url);
    try {
      await initializeSession(page);
      const token = page.sessionStorage.getItem(storageKey);
      const res = await fetch(new URL('/api/catalog', url), { method: 'POST', headers: { 'X-Bridge-Token': token } });
      assert.equal(res.status, 200);
      assert.notEqual(token, b.token);
      assert.match(await stream.text(), /event: session-revoked/);
      const old = await fetch(new URL('/api/catalog', url), { method: 'POST', headers: { 'X-Bridge-Token': b.token } });
      assert.equal(old.status, 403);
      const history = await replay(url, token);
      assert.match(history, /A new Agent Bridge tab was opened at/);
      assert.match(history, /An opening code was used at/);
      const next = await reopen(b);
      assert.notEqual(next, url);
      const revoked = await fetch(new URL('/events?token=' + token, url));
      assert.equal(revoked.status, 403);
      assert.ok(!history.includes(token) && !history.includes(new URL(url).hash.slice(7)));
    } finally {
      await page.happyDOM.close();
    }
  } finally {
    await b.stop();
  }
});
test('a bypass-enabled agent asking for the local Bridge port reaches the approval card', async () => {
  const b = await start();
  try {
    await b.waitFor((e) => e.kind === 'state' && e.team.some((a) => a.bypass));
    await b.api('send', { text: 'fixture-shell-review', target: 'auto' });
    const ev = await b.waitFor((e) => e.kind === 'approval' && e.requestId === 'fixture-bridge-access');
    assert.match(ev.warning, /running Bridge/);
    assert.deepEqual(ev.decisions, ['accept', 'decline']);
    await b.api('approval', { requestId: ev.requestId, decision: 'decline' });
    assert.ok(!b.events.some((e) => e.kind === 'autoApproved'));
  } finally {
    await b.stop();
  }
});
test('the page removes the fragment before exchange and keeps the credential in tab storage', async () => {
  const page = new Window({ url: 'http://localhost:8888/chat?view=team#abrir=fixture' });
  try {
    page.fetch = async (route, req) => {
      assert.equal(page.location.href, 'http://localhost:8888/chat?view=team');
      assert.equal(route, '/session');
      assert.deepEqual(JSON.parse(req.body), { code: 'fixture' });
      return { ok: true, json: async () => ({ token: 'fixture-session' }) };
    };
    await initializeSession(page);
    assert.equal(page.sessionStorage.getItem(storageKey), 'fixture-session');
    assert.equal(page.localStorage.length, 0);
  } finally {
    await page.happyDOM.close();
  }
});
test('a redeemed link returns 409, alerts the page and writes a credential-free chat and error event', async () => {
  const b = await start();
  try {
    const url = await reopen(b),
      page = pageFor(url);
    try {
      const code = new URLSearchParams(new URL(url).hash.slice(1)).get('abrir');
      const exchange = () => fetch(new URL('/session', url), { method: 'POST', body: JSON.stringify({ code }) });
      const first = await exchange();
      assert.equal(first.status, 200);
      const { token } = await first.json();
      assert.equal((await exchange()).status, 409);
      page.sessionStorage.setItem(storageKey, 'stale');
      await assert.rejects(
        initializeSession(page),
        /already been used by another process.*If this was not you, close Agent Bridge and reopen it from its shortcut/,
      );
      assert.equal(page.sessionStorage.getItem(storageKey), null);
      const history = await replay(url, token);
      const run = fs.readdirSync(b.logs, { withFileTypes: true }).find((f) => f.isDirectory());
      const errors = fs.readFileSync(path.join(b.logs, run.name, 'errors.log'), 'utf8');
      for (const log of [history, errors]) {
        assert.match(log, /previously used opening code/);
        assert.ok(!log.includes(code) && !log.includes(token));
      }
    } finally {
      await page.happyDOM.close();
    }
  } finally {
    await b.stop();
  }
});
