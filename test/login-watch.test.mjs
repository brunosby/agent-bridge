import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { agentsToRestart, signInState, stopLoginWatches, watchLogin } from '../src/server/login-watch.ts';
import { cliCache } from '../src/server/state.ts';
import { cliStatus } from '../src/providers/accounts.ts';

// A manual clock and scheduler, so the follow-up runs without real waiting.
function harness(statuses) {
  let time = 0;
  const queue = [];
  const checks = [];
  const ended = [];
  const options = {
    now: () => time,
    schedule: (run, ms) => {
      const timer = { run, at: time + ms, cancelled: false };
      queue.push(timer);
      return timer;
    },
    cancel: (timer) => {
      if (timer) timer.cancelled = true;
    },
    check: async () => {
      checks.push(time);
      const next = statuses.shift();
      if (next instanceof Error) throw next;
      return next;
    },
    done: (driver, status, blocked) => ended.push({ driver, status, blocked }),
  };
  const advance = async () => {
    const timer = queue.filter((t) => !t.cancelled).sort((a, b) => a.at - b.at)[0];
    if (!timer) return false;
    timer.cancelled = true;
    time = timer.at;
    timer.run();
    await new Promise((r) => setImmediate(r));
    return true;
  };
  return { options, advance, checks, ended, queue };
}

test('the follow-up checks every 5 s and stops as soon as the provider reports a sign-in', async (t) => {
  t.after(stopLoginWatches);
  const h = harness([{ state: 'logged_out' }, { state: 'logged_out' }, { state: 'ok' }]);
  const before = signInState().version;
  watchLogin('claude', null, true, h.options);
  assert.deepEqual(signInState().waiting, ['claude']);
  while (await h.advance());
  assert.deepEqual(h.checks, [5000, 10000, 15000]);
  assert.equal(h.ended.length, 1);
  assert.equal(h.ended[0].status.state, 'ok');
  assert.equal(h.ended[0].blocked, true);
  assert.deepEqual(signInState().waiting, []);
  assert.equal(signInState().version, before + 1);
});

test('the end of the login command triggers an immediate check and ends the follow-up', async (t) => {
  t.after(stopLoginWatches);
  const h = harness([{ state: 'logged_out' }]);
  const login = new EventEmitter();
  watchLogin('codex', login, false, h.options);
  login.emit('exit', 1);
  await new Promise((r) => setImmediate(r));
  assert.deepEqual(h.checks, [0]);
  assert.equal(h.ended.length, 1);
  assert.equal(h.ended[0].status.state, 'logged_out');
  assert.equal(h.queue.filter((t) => !t.cancelled).length, 0);
});

test('a free OpenCode session is not a sign-in, failures back off, and the follow-up ends at the time limit', async (t) => {
  t.after(stopLoginWatches);
  const h = harness([{ state: 'ok', signedIn: false }, new Error('status failed'), { state: 'logged_out' }, { state: 'logged_out' }]);
  watchLogin('opencode', null, false, { ...h.options, limit: 25000 });
  while (await h.advance());
  // 5 s, then 10 s after the failure, then back to 5 s; the check at 25 s reaches the limit.
  assert.deepEqual(h.checks, [5000, 10000, 20000, 25000]);
  assert.equal(h.ended.length, 1);
  assert.equal(h.ended[0].status.state, 'logged_out');
});

test('clicking Sign in again replaces the earlier follow-up', async (t) => {
  t.after(stopLoginWatches);
  const first = harness([{ state: 'logged_out' }]);
  const second = harness([{ state: 'ok' }]);
  watchLogin('claude', null, false, first.options);
  watchLogin('claude', null, false, second.options);
  assert.equal(first.queue.filter((t) => !t.cancelled).length, 0);
  while (await second.advance());
  assert.equal(first.ended.length, 0);
  assert.equal(second.ended.length, 1);
});

test('an earlier check finishing late preserves the confirmed sign-in', async (t) => {
  t.after(stopLoginWatches);
  const pending = Promise.withResolvers();
  const first = harness([pending.promise]);
  const second = harness([{ state: 'ok' }]);
  watchLogin('claude', null, false, first.options);
  await first.advance();
  watchLogin('claude', null, false, second.options);
  await second.advance();
  pending.resolve({ state: 'logged_out' });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(cliCache.claude.status.state, 'ok');
  assert.equal(first.ended.length, 0);
});

test('after a sign-in only idle agents of that provider that could not work are restarted', () => {
  const owner = {
    team: [
      { id: 'a1', driver: 'claude' },
      { id: 'a2', driver: 'claude' },
      { id: 'a3', driver: 'claude' },
      { id: 'a4', driver: 'codex' },
    ],
    agents: {
      a1: { available: false, busy: false },
      a2: { available: false, busy: true },
      a3: { available: true, busy: false },
      a4: { available: false, busy: false },
    },
  };
  assert.deepEqual(
    agentsToRestart(owner, 'claude', false).map((m) => m.id),
    ['a1'],
  );
  // When the account was blocked before the sign-in, idle agents restart to pick up the new credentials.
  assert.deepEqual(
    agentsToRestart(owner, 'claude', true).map((m) => m.id),
    ['a1', 'a3'],
  );
});

test('Claude sign-in follows the documented exit code of `claude auth status`', { skip: process.platform !== 'win32' }, async (t) => {
  const dir = mkdtempSync(path.join(tmpdir(), 'bridge-claude-status-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const fake = (name, json, code) => {
    const file = path.join(dir, name + '.cmd');
    writeFileSync(
      file,
      ['@echo off', 'if "%1"=="--version" (', '  echo 9.9.9 Claude Code', '  exit /b 0', ')', 'echo ' + json, 'exit /b ' + code, ''].join(
        '\r\n',
      ),
    );
    return file;
  };
  assert.equal(
    (await cliStatus('claude', { command: fake('out', '{"loggedIn": true, "authMethod": "claude.ai"}', 1) })).state,
    'logged_out',
  );
  const signed = await cliStatus('claude', { command: fake('in', '{"loggedIn": true, "authMethod": "claude.ai"}', 0) });
  assert.equal(signed.state, 'ok');
  assert.match(signed.detail, /Claude account/);
});
