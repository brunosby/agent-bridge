import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { detectSecrets, redact } from '../src/core/secret-detection.ts';
import { scanCommits } from '../src/workspace/publication-scan.ts';
import { scanPublication } from '../src/workspace/publication-scope.ts';
import { hookStatus, setHook } from '../src/workspace/publication-hook.ts';
import { startBridge } from './helpers/bridge.mjs';

const body = '0123456789abcdefghijklmnopqrstuvwxyz';
const token = 'ghp_' + body;
test('the detector uses capture entropy, placeholders, path scope and opt-in assignment rules', () => {
  for (const example of [
    'ghp_' + 'ab'.repeat(18),
    'AKIA' + '123456789EXAMPLE',
    'postgres://app:<token>@db',
    'postgres://app:$VAR@db',
    'postgres://app:null@db',
    'postgres://app:' + '$' + '{VAR}@db',
  ])
    assert.deepEqual(detectSecrets(example), []);
  for (const sample of [token, 'ASIA' + 'ABCDEFGH12345678', 'xoxb-' + body, 'sk-' + body, 'github_pat_' + body])
    assert.equal(detectSecrets(sample).length, 1);
  const header = '-----BEGIN ' + 'PRIVATE KEY-----';
  assert.equal(detectSecrets(header + '\nfixture\n-----END PRIVATE KEY-----').length, 1);
  assert.ok(!redact(header + '\nfixture\n-----END PRIVATE KEY-----').includes('fixture'));
  const settings = { rules: [{ prefix: 'test_prefix_', pathSuffix: '.ini' }], genericAssignments: true };
  assert.equal(detectSecrets('test_prefix_' + body, settings, 'app.ini').length, 1);
  assert.equal(detectSecrets('test_prefix_' + body, settings, 'app.ts').length, 0);
  assert.deepEqual(detectSecrets('password="' + body + '"'), []);
  assert.equal(detectSecrets('password="' + body + '"', settings)[0].value, body);
});
test('merge resolutions, skipped paths, finding identity, incomplete scans and existing hooks', async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bridge-scan-'));
  t.after(() => fs.rmSync(dir, { force: true, recursive: true, maxRetries: 5, retryDelay: 100 }));
  const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'bridge-secret-state-'));
  const previousState = process.env.LOCALAPPDATA;
  process.env.LOCALAPPDATA = stateDir;
  t.after(() => {
    if (previousState === undefined) delete process.env.LOCALAPPDATA;
    else process.env.LOCALAPPDATA = previousState;
    fs.rmSync(stateDir, { recursive: true, force: true });
  });
  const git = (...args) => execFileSync('git', args, { cwd: dir, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
  const put = (name, data) => {
    const file = path.join(dir, name);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, data);
  };
  const save = (msg) => {
    git('add', '-f', '.');
    git('commit', '-m', msg);
    return git('rev-parse', 'HEAD');
  };
  git('init', '-b', 'main');
  git('config', 'user.name', 'Fixture');
  git('config', 'user.email', 'fixture@example.test');
  put('base.txt', 'ok');
  const base = save('base');
  git('checkout', '-b', 'feature');
  put('feature.txt', 'ok');
  const feature = save('feature');
  git('checkout', 'main');
  git('merge', '--no-ff', '--no-commit', 'feature');
  for (const file of ['node_modules/module/source', 'vendor/src', 'package-lock.json', 'fixture.png', 'code.txt']) put(file, token);
  put('vendor/.env', '');
  put('photo.jpg', token);
  put('.gitattributes', '*.jpg -diff\n');
  put('binary.png', Buffer.from([137, 80, 78, 71, 13, 10, 26, 10, 0]));
  put('file.bin', Buffer.from([0, 1, 2, 254]));
  put('lfs.data', 'version https://git-lfs.github.com/spec/v1\noid sha256:' + 'a'.repeat(64) + '\nsize 42\n');
  put(
    '.agent-bridge/secret-patterns.json',
    JSON.stringify({ rules: [{ prefix: 'fixturekey_', pathSuffix: '.ini' }], exceptions: ['all'] }),
  );
  put('app.ini', 'fixturekey_' + body);
  put('app.txt', 'fixturekey_' + body);
  const merge = save('merge');
  const key = randomBytes(32);
  const scan = (head, excluded) => scanCommits(dir, [head], excluded, 'test', [], key);
  const result = await scan(merge, [base, feature]);
  assert.equal(result.commits, 1);
  assert.deepEqual(result.findings.map((f) => f.file).sort(), ['app.ini', 'code.txt', 'fixture.png', 'photo.jpg', 'vendor/.env']);
  assert.deepEqual(result.unexamined.sort(), ['binary.png', 'file.bin', 'lfs.data']);
  const original = result.findings.find((f) => f.file === 'code.txt');
  put('code.txt', 'first\n' + token + '\n');
  const moved = save('move');
  const again = (await scan(moved, [merge])).findings[0];
  assert.equal(again.id, original.id);
  assert.equal(again.line, 2);
  put('code.txt', 'ghp_' + [...body].reverse().join(''));
  const changed = save('rotate');
  assert.notEqual((await scan(changed, [moved])).findings[0].id, original.id);
  const pem = (data) => ['-----BEGIN ' + 'PRIVATE KEY-----', data, '-----END ' + 'PRIVATE KEY-----'].join('\n');
  put('identity.txt', pem(body));
  const firstKey = save('key fixture');
  const first = (await scan(firstKey, [changed])).findings.find((f) => f.rule === 'Private key');
  put('identity.txt', pem([...body].reverse().join('')));
  const secondKey = save('different key');
  const second = (await scan(secondKey, [firstKey])).findings.find((f) => f.rule === 'Private key');
  assert.notEqual(first.id, second.id);
  // Bound both full-file and patch inspection; a partial read is never a clean result.
  put('large.txt', Buffer.alloc(12 * 1024 * 1024 + 1, 0x61));
  const large = save('large');
  await assert.rejects(scan(large, [changed]), /limit/);
  const hookFile = path.join(dir, '.git', 'hooks', 'pre-push');
  put('.git/hooks/pre-push', '#!/bin/sh\nexit 0\n');
  const existing = await hookStatus(dir);
  await assert.rejects(setHook(dir, true, ''), /changed/);
  const enabled = await setHook(dir, true, existing.signature);
  await setHook(dir, false, enabled.signature);
  assert.equal(fs.readFileSync(hookFile, 'utf8'), '#!/bin/sh\nexit 0\n');
  git('config', 'alias.ship', 'push');
  const { reviewPublication } = await import('../src/server/publication-approval.ts');
  const event = { kind: 'approval', requestId: 'alias', commandApproval: true, shellCommand: { shell: 'bash', text: 'git ship' } };
  assert.ok(await reviewPublication({ id: 'fixture', cwd: dir, approvals: new Map([['alias', {}]]) }, event, dir, null));
  assert.deepEqual(event.decisions, ['decline']);
  await assert.rejects(scanPublication(dir, { shell: 'bash', text: 'gh pr create --web' }, key));
});
test('tool events, provider stderr, errors and server log redact the credential before storage', async () => {
  const b = await startBridge({
    team: [{ name: 'Agent', role: 'coder', driver: 'fake' }],
    rules: [],
    logFile: true,
    preload: new URL('./helpers/session-fixture.mjs', import.meta.url),
  });
  try {
    await b.api('send', { text: 'fixture-secret-diagnostics' });
    await b.waitFor((e) => e.kind === 'tool' && e.key === 'fixture-tool');
    await b.waitFor((e) => e.kind === 'turnEnd');
    const dir = fs.readdirSync(b.logs, { withFileTypes: true }).find((e) => e.isDirectory());
    for (const file of [
      path.join(b.root, 'server.log'),
      ...['transcript.jsonl', 'errors.log'].map((n) => path.join(b.logs, dir.name, n)),
    ]) {
      const log = fs.readFileSync(file, 'utf8');
      assert.ok(log.includes('[secret removed]'));
      assert.ok(!log.includes(token));
    }
    assert.ok(!JSON.stringify(b.events).includes(token));
  } finally {
    await b.stop();
  }
});
