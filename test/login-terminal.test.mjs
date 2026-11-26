import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { loginCommand, openLoginTerminal } from '../src/providers/accounts.ts';

function fakeSpawn(fail) {
  const opened = [];
  const spawn = (...args) => {
    opened.push(args);
    const child = new EventEmitter();
    child.unref = () => {};
    queueMicrotask(() => (fail ? child.emit('error', new Error(fail)) : child.emit('spawn')));
    return child;
  };
  return { opened, spawn };
}

test('Windows sign-in opens cmd.exe directly, without a start title that Windows reads as a program', async () => {
  const { opened, spawn } = fakeSpawn();
  const login = await openLoginTerminal('claude', {}, 'win32', spawn);
  assert.equal(login.command, 'claude auth login');
  assert.ok(login.finished, 'the login process is returned so its end can be followed');
  const [file, args, options] = opened[0];
  assert.equal(file, 'cmd.exe');
  // The window closes after a successful login and stays open with the error otherwise.
  assert.deepEqual(args, ['/d', '/s', '/c', '"claude auth login || pause"']);
  assert.ok(!args.includes('start') && !args.some((a) => a.endsWith('-login')));
  assert.equal(options.detached, true);
  assert.equal(options.windowsHide, false);
  assert.equal(options.windowsVerbatimArguments, true);
});

test('a configured CLI path with spaces stays quoted inside the terminal command', async () => {
  const { opened, spawn } = fakeSpawn();
  const command = String.raw`C:\Program Files\Claude\claude.exe`;
  await openLoginTerminal('claude', { command }, 'win32', spawn);
  assert.equal(opened[0][1][3], String.raw`""C:\Program Files\Claude\claude.exe" auth login || pause"`);
  assert.equal(loginCommand('codex', { command: '/opt/my tools/codex' }, 'linux'), "'/opt/my tools/codex' login");
  assert.equal(loginCommand('codex', { command: '/opt/tools/$edition/codex' }, 'linux'), "'/opt/tools/$edition/codex' login");
  assert.throws(() => loginCommand('claude', { command: 'claude & calc' }, 'win32'), /characters/);
});

test('a terminal that cannot be opened is reported instead of failing silently', async () => {
  const { spawn } = fakeSpawn('spawn cmd.exe ENOENT');
  await assert.rejects(openLoginTerminal('opencode', {}, 'win32', spawn), /ENOENT/);
});

test('macOS and Linux keep using the system terminal', async () => {
  const { opened, spawn } = fakeSpawn();
  await openLoginTerminal('codex', {}, 'darwin', spawn);
  const linux = await openLoginTerminal('codex', {}, 'linux', spawn);
  // The desktop terminal launchers return at once, so there is no login process to follow there.
  assert.equal(linux.finished, null);
  assert.deepEqual(
    opened.map((a) => a[0]),
    ['osascript', 'x-terminal-emulator'],
  );
  assert.match(opened[0][1][1], /do script "codex login"/);
  assert.deepEqual(opened[1][1].slice(0, 3), ['-e', 'sh', '-c']);
});
