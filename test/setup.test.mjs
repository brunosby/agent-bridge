import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { Window } from 'happy-dom';
import { readFileSync, mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { EventEmitter } from 'node:events';
import { fileURLToPath } from 'node:url';
import { openInstaller, installer } from '../src/providers/installers.ts';
import { refreshPath, shortcutArgs, setup } from '../src/server/setup.ts';
import { startBridge } from './helpers/bridge.mjs';
const probe = fileURLToPath(new URL('../bin/ts-check.ts', import.meta.url));
test('probe exercises native TypeScript, including the real Windows preflight', () => {
  assert.equal(spawnSync(process.execPath, [probe], { encoding: 'utf8' }).stdout.trim(), 'ok');
  const result = spawnSync(process.execPath, ['--no-strip-types', probe], { encoding: 'utf8' });
  assert.notEqual(result.status, 0);
  assert.notEqual(result.stdout.trim(), 'ok');
  if (process.platform === 'win32') {
    const launcher = fileURLToPath(new URL('../bin/check-node.vbs', import.meta.url));
    const run = spawnSync('cscript.exe', ['//nologo', launcher], { input: 'C\r\n', encoding: 'utf8', timeout: 10000 });
    assert.equal(run.status, 0, run.stdout + run.stderr);
    const envWithoutPath = Object.fromEntries(Object.entries(process.env).filter(([key]) => key.toLowerCase() !== 'path'));
    const missing = spawnSync(path.join(process.env.SystemRoot, 'System32', 'cscript.exe'), ['//nologo', launcher], {
      env: { ...envWithoutPath, Path: path.join(process.env.SystemRoot, 'System32') },
      input: 'C\r\n',
      encoding: 'utf8',
      timeout: 10000,
    });
    assert.equal(missing.status, 1);
    assert.match(missing.stdout, /Found Node.js: not found/);
  }
});
test('known installer targets select visible terminals, and Windows PATH is refreshed in system/user order', async () => {
  const opened = [];
  const spawn = (...args) => {
    opened.push(args);
    const child = new EventEmitter();
    child.unref = () => {};
    queueMicrotask(() => child.emit('spawn'));
    return child;
  };
  for (const [id, platform] of [
    ['claude', 'win32'],
    ['codex', 'win32'],
    ['opencode', 'linux'],
    ['git', 'darwin'],
  ])
    await openInstaller(id, platform, spawn);
  assert.deepEqual(
    opened.map((a) => a[0]),
    ['powershell.exe', 'cmd.exe', 'x-terminal-emulator', 'osascript'],
  );
  assert.equal(
    opened.every((a) => a[2].windowsHide === false),
    true,
  );
  assert.equal(installer('git', 'linux').command, '');
  await assert.rejects(openInstaller('custom', 'win32', spawn), /Unknown/);
  assert.equal(opened.length, 4);
  const env = { Path: 'inherited;SYSTEM' };
  await refreshPath('win32', async () => ({ stdout: 'system;user' }), env);
  assert.equal(env.Path, 'system;user;inherited');
  assert.equal(shortcutArgs(false).includes('/desktop'), false);
  assert.ok(shortcutArgs(true).includes('/desktop'));
  await assert.rejects(setup({ action: 'shortcut' }), /Confirmation/);
});
test('setup can be reopened, keeps desktop opt-in, and switches to a guide without an installer', async (t) => {
  const win = new Window({ url: 'http://localhost' });
  t.after(() => win.happyDOM.close());
  win.document.write(readFileSync(new URL('../public/index.html', import.meta.url), 'utf8').replace(/<script[^>]+><\/script>/g, ''));
  globalThis.document = win.document;
  globalThis.Option = function Option(text, value) {
    const node = win.document.createElement('option');
    node.value = value;
    node.textContent = text;
    return node;
  };
  let windows = false;
  const sent = [];
  t.mock.method(globalThis, 'fetch', async (url, options) => {
    const body = JSON.parse(options.body);
    sent.push(body);
    return {
      ok: true,
      json: async () =>
        body.action === 'status'
          ? {
              windows,
              items: [
                { id: 'git', label: 'Git', state: 'not_installed', command: '', guide: 'https://git-scm.com/install/' },
                { id: 'opencode', label: 'OpenCode', state: 'ok', signedIn: false },
              ],
            }
          : { ok: true },
    };
  });
  const { openSetup } = await import('../public/js/features/setup.js');
  const el = (id) => win.document.getElementById(id);
  openSetup();
  await new Promise((r) => setTimeout(r, 0));
  assert.ok(el('setupDialog').open);
  assert.ok(el('setupShortcut').hidden);
  assert.match(el('setupItems').textContent, /Open install guide/);
  assert.match(el('setupItems').textContent, /Free models only/);
  const selected = [...el('setupTeam').querySelectorAll('select')];
  assert.equal(selected.length, 3);
  assert.ok(selected.every((select) => select.value === 'opencode' && select.selectedOptions[0].textContent.includes('free models only')));
  await el('setupSkip').onclick();
  assert.equal(el('setupDialog').open, false);
  assert.equal(sent.at(-1).action, 'finish');
  windows = true;
  el('runSetup').click();
  await new Promise((r) => setTimeout(r, 0));
  assert.equal(el('setupShortcut').hidden, false);
  assert.equal(el('setupDesktop').checked, false);
  assert.equal(
    sent.some((b) => b.action === 'shortcut' || b.action === 'install'),
    false,
  );
});
test('setup saves a default team with anonymous OpenCode as the only provider', async () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'bridge-free-setup-'));
  const win = process.platform === 'win32';
  const command = 'bridge-test-free-opencode';
  writeFileSync(
    path.join(dir, command + (win ? '.cmd' : '')),
    win
      ? '@echo off\r\nif "%1"=="--version" (echo 1.0.0) else (echo 0 credentials)\r\n'
      : '#!/bin/sh\nif [ "$1" = "--version" ]; then echo 1.0.0; else echo "0 credentials"; fi\n',
    { mode: 0o755 },
  );
  const prev = process.env.PATH;
  let bridge;
  try {
    process.env.PATH = dir + path.delimiter + prev;
    bridge = await startBridge({ dir, team: [{ driver: 'fake', role: 'coder' }], rules: [], settings: { opencode: { command } } });
    const members = [{ role: 'coder', name: 'Coder', driver: 'opencode' }];
    await bridge.api('setup', { action: 'finish', members });
    const saved = await bridge.api('teams');
    assert.equal(saved.teams.find((t) => t.name === saved.defaultTeamName).members[0].driver, 'opencode');
  } finally {
    process.env.PATH = prev;
    try {
      await bridge?.stop();
    } finally {
      rmSync(dir, { recursive: true, force: true, maxRetries: 8, retryDelay: 100 });
    }
  }
});
test('skipping setup persists across restarts', async () => {
  let b = await startBridge({ team: [{ driver: 'fake', role: 'coder' }], rules: [] });
  try {
    assert.equal((await b.api('catalog')).setupCompleted, false);
    await b.api('setup', { action: 'finish' });
    const dir = b.root;
    await b.stop();
    b = await startBridge({ dir, team: [{ driver: 'fake', role: 'coder' }], rules: [] });
    assert.equal((await b.api('catalog')).setupCompleted, true);
  } finally {
    await b.stop();
  }
});
