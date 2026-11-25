import assert from 'node:assert/strict';
import test from 'node:test';
import { ClaudeAgent } from '../src/providers/claude.ts';
import { CodexAgent } from '../src/providers/codex.ts';
import { OpenCodeAgent } from '../src/providers/opencode.ts';
import { createServer } from 'node:https';
import { gitProgram } from '../src/workspace/git-program.ts';
import { once } from 'node:events';
import { execFileSync, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomBytes } from 'node:crypto';
import { scanPublication } from '../src/workspace/publication-scope.ts';
import { detectSecrets, redact } from '../src/core/secret-detection.ts';
import { reviewPublication, verifyDecision, confirmException } from '../src/server/publication-approval.ts';
import { setHook } from '../src/workspace/publication-hook.ts';
import { createBrowserSession, setBridgePort, requestsBridgeAccess } from '../src/server/browser-session.ts';
import { SERVER, startBridge } from './helpers/bridge.mjs';

test('opening codes expire and can be exchanged exactly once; local access requires review', async () => {
  let now = 0;
  const s = createBrowserSession(() => now);
  const code = () => new URLSearchParams(new URL(s.openUrl(4381)).hash.slice(1)).get('abrir');
  const first = code(),
    second = code();
  assert.deepEqual(s.exchange(first), { status: 200, token: s.token });
  assert.equal(s.exchange(first).status, 409);
  s.rotate();
  assert.equal(s.exchange(second).status, 403);
  assert.equal(s.exchange(first).status, 409);
  const expires = code();
  now = 60000;
  assert.equal(s.exchange(expires).status, 403);
  now = 5 * 60000 - 1;
  assert.equal(s.exchange(first).status, 409);
  now++;
  assert.equal(s.exchange(first).status, 403);
  assert.equal(s.exchange(second).status, 403);
  setBridgePort(4381);
  for (const host of ['localhost', '127.0.0.1', '[::1]']) assert.equal(requestsBridgeAccess('fetch http://' + host + ':4381/'), true);
  assert.equal(requestsBridgeAccess('http://localhost:43810/'), false);
  const b = await startBridge({ team: [{ name: 'Lead', driver: 'fake', role: 'orchestrator' }], rules: [] });
  try {
    const base = 'http://127.0.0.1:' + b.port;
    assert.doesNotMatch(await (await fetch(base)).text(), /bridge-token|__BRIDGE_TOKEN__|#abrir=/);
    for (const [p, method] of [
      ['/api/catalog', 'POST'],
      ['/events', 'GET'],
      ['/session', 'POST'],
    ])
      assert.equal((await fetch(base + p, { method })).status, 403);
    assert.equal((await fetch(base + '/open', { method: 'POST', headers: { origin: 'http://localhost:9999' } })).status, 403);
    assert.ok(await b.api('catalog'));
    const marker = 'ghp_' + 'abcdefghijklmnopqrstuvwxyz0123456789';
    await b.api('send', { text: 'inspect ' + marker });
    await b.waitFor((e) => e.kind === 'user' && e.text.includes('[secret removed]'));
    const run = fs.readdirSync(b.logs, { withFileTypes: true }).find((entry) => entry.isDirectory());
    const transcript = fs.readFileSync(path.join(b.logs, run.name, 'transcript.jsonl'), 'utf8');
    assert.ok(!transcript.includes(marker));
  } finally {
    await b.stop();
  }
});

test('restart preserves access without printing the session key', async () => {
  const b = await startBridge({ team: [], rules: [], logFile: true });
  const exited = once(b.child, 'exit');
  try {
    await b.api('restart');
    await exited;
    let ready = false;
    for (let i = 0; i < 80 && !ready; i++) {
      try {
        ready = Boolean(await b.api('catalog'));
      } catch {
        await new Promise((r) => setTimeout(r, 100));
      }
    }
    assert.ok(ready, 'replacement server accepts the original session');
    const log = fs.readFileSync(path.join(b.root, 'server.log'), 'utf8');
    assert.doesNotMatch(log, /#abrir=|\b[a-f0-9]{36}\b/);
  } finally {
    await b.api('quit').catch(() => {});
    await b.stop();
  }
});

test('a private HTTPS remote uses system and user settings outside the worktree', async (t) => {
  const bundled = path.resolve(path.dirname(gitProgram()), '../usr/bin/openssl.exe');
  const openssl = process.platform === 'win32' && fs.existsSync(bundled) ? bundled : 'openssl';
  if (spawnSync(openssl, ['version']).error?.code === 'ENOENT') return t.skip('OpenSSL is required for the local TLS fixture');
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'bridge-private-remote-'));
  t.after(() => fs.rmSync(tmp, { recursive: true, force: true, maxRetries: 5 }));
  const cwd = path.join(tmp, 'work');
  fs.mkdirSync(cwd);
  const cert = path.join(tmp, 'test.crt');
  const key = path.join(tmp, 'test.key');
  execFileSync(
    openssl,
    [
      'req',
      '-x509',
      '-newkey',
      'rsa:2048',
      '-nodes',
      '-days',
      '1',
      '-subj',
      '/CN=127.0.0.1',
      '-addext',
      'subjectAltName=IP:127.0.0.1',
      '-keyout',
      key,
      '-out',
      cert,
    ],
    { stdio: 'ignore' },
  );
  const git = (...args) => execFileSync(gitProgram(), args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
  for (const [key, value] of Object.entries({
    GIT_CONFIG_GLOBAL: path.join(tmp, 'user.config'),
    GIT_CONFIG_SYSTEM: path.join(tmp, 'system.config'),
    GIT_CONFIG_NOSYSTEM: '0',
  })) {
    const previous = process.env[key];
    process.env[key] = value;
    t.after(() => {
      if (previous === undefined) delete process.env[key];
      else process.env[key] = previous;
    });
  }
  git('init', '-b', 'main');
  git('config', 'user.name', 'Fixture');
  git('config', 'user.email', 'fixture@example.test');
  git('commit', '--allow-empty', '-m', 'published');
  const published = git('rev-parse', 'HEAD');
  git('commit', '--allow-empty', '-m', 'outgoing');
  let authenticated = false;
  const server = createServer({ cert: fs.readFileSync(cert), key: fs.readFileSync(key) }, (req, res) => {
    if (req.headers.authorization !== 'Basic ' + Buffer.from('fixture:fixture').toString('base64')) {
      res.writeHead(401, { 'WWW-Authenticate': 'Basic realm="local test"' }).end();
      return;
    }
    authenticated = true;
    if (req.url?.startsWith('/repo/info/refs')) res.writeHead(200, { 'Content-Type': 'text/plain' }).end(published + '\trefs/heads/main\n');
    else if (req.url === '/repo/HEAD') res.end('ref: refs/heads/main\n');
    else res.writeHead(404).end();
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise((resolve) => server.close(resolve)));
  const host = '127.0.0.1:' + server.address().port;
  const store = path.join(tmp, 'credentials').replaceAll('\\', '/');
  fs.writeFileSync(store, 'https://fixture:fixture@' + host + '\n', { mode: 0o600 });
  git('config', '--file', process.env.GIT_CONFIG_SYSTEM, 'http.sslCAInfo', cert);
  if (process.platform === 'win32') git('config', '--file', process.env.GIT_CONFIG_SYSTEM, 'http.sslBackend', 'openssl');
  git('config', '--global', 'credential.helper', 'store --file="' + store + '"');
  git('config', 'credential.helper', '');
  git('config', 'http.sslCAInfo', path.join(tmp, 'missing'));
  git('remote', 'add', 'origin', 'https://' + host + '/repo');
  const scan = await scanPublication(cwd, { text: 'git push origin main', shell: 'bash' }, randomBytes(32));
  assert.ok(authenticated);
  assert.deepEqual(scan.revisions, [git('rev-parse', 'HEAD')]);
  fs.writeFileSync(store, '');
  const fallback = await scanPublication(cwd, { text: 'git push origin main', shell: 'bash' }, randomBytes(32));
  assert.equal(fallback.commits, 2);
});

test('remote scope follows destination refs, HEAD, and the full-listing limit', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'bridge-ref-scope-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true, maxRetries: 5 }));
  const previousState = process.env.LOCALAPPDATA;
  process.env.LOCALAPPDATA = root;
  t.after(() => {
    if (previousState === undefined) delete process.env.LOCALAPPDATA;
    else process.env.LOCALAPPDATA = previousState;
  });
  const cwd = path.join(root, 'work'),
    remote = path.join(root, 'remote');
  fs.mkdirSync(cwd);
  const git = (...args) => execFileSync(gitProgram(), args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
  const onRemote = (...args) => git('--git-dir', remote, ...args);
  const key = randomBytes(32);
  const scan = (text) => scanPublication(cwd, { text, shell: 'bash' }, key);
  git('init', '-b', 'main');
  git('config', 'user.name', 'Fixture');
  git('config', 'user.email', 'fixture@example.test');
  git('init', '--bare', '-b', 'main', remote);
  git('remote', 'add', 'origin', remote);
  git('commit', '--allow-empty', '-m', 'previously published ' + 'ghp_' + '0123456789abcdefghijklmnopqrstuvwxyz');
  const base = git('rev-parse', 'HEAD');
  git('push', 'origin', 'main');
  git('checkout', '-b', 'feature');
  git('commit', '--allow-empty', '-m', 'first');
  const first = git('rev-parse', 'HEAD');
  git('commit', '--allow-empty', '-m', 'second');
  const second = git('rev-parse', 'HEAD');
  // Unrelated remote refs already reach the tip, making a full listing distinguishable from a selective one.
  git('push', 'origin', 'feature:refs/tags/published-tip');
  const setTags = (dir, count) => {
    const entries = Array.from({ length: count }, (_, i) => base + ' refs/tags/bulk-' + String(i).padStart(5, '0'));
    fs.writeFileSync(path.join(dir, 'packed-refs'), '# pack-refs with: sorted\n' + entries.join('\n') + '\n');
  };
  setTags(remote, 300);
  setTags(path.join(cwd, '.git'), 300);
  const outgoing = [second, first];
  assert.deepEqual((await scan('git push origin feature')).revisions, outgoing);
  git('config', 'push.default', 'current');
  assert.deepEqual((await scan('git push')).revisions, outgoing);
  const hook = path.join(path.dirname(SERVER), 'check-publication.mjs');
  const hookResult = (url) =>
    spawnSync(process.execPath, [hook, 'origin', url], {
      cwd,
      encoding: 'utf8',
      input: 'refs/heads/feature ' + second + ' refs/heads/feature ' + '0'.repeat(base.length) + '\n',
      env: { ...process.env, LOCALAPPDATA: root },
    });
  assert.equal(hookResult(remote).status, 0);
  const failed = hookResult(path.join(root, 'absent'));
  assert.equal(failed.status, 1);
  assert.match(failed.stderr, /commit message/);
  onRemote('symbolic-ref', 'HEAD', 'refs/heads/missing');
  assert.equal((await scan('git push origin feature')).commits, 3);
  onRemote('symbolic-ref', 'HEAD', 'refs/heads/main');
  onRemote('update-ref', 'refs/heads/release', first);
  assert.deepEqual((await scan('git push origin feature:release')).revisions, [second]);
  git('config', 'branch.feature.remote', 'origin');
  git('config', 'branch.feature.merge', 'refs/heads/release');
  git('config', 'push.default', 'upstream');
  assert.deepEqual((await scan('git push')).revisions, [second]);
  assert.deepEqual((await scan('gh pr create --head feature --base release --title Review --body ok')).revisions, [second]);
  assert.deepEqual((await scan('gh pr create --head feature --title Review --body ok')).revisions, outgoing);
  git('tag', 'light', second);
  onRemote('update-ref', 'refs/tags/light', first);
  assert.deepEqual((await scan('git push origin light')).revisions, [second]);
  const remoteOnly = onRemote(
    '-c',
    'user.name=Fixture',
    '-c',
    'user.email=fixture@example.test',
    'commit-tree',
    git('rev-parse', 'HEAD^{tree}'),
    '-m',
    'remote only',
  );
  onRemote('update-ref', 'refs/heads/unfetched', remoteOnly);
  assert.deepEqual((await scan('git push origin feature:release main:unfetched')).revisions, [second]);
  // Both destination branches contribute a different history.
  git('checkout', '-b', 'side', 'main');
  git('commit', '--allow-empty', '-m', 'side');
  git('push', 'origin', 'side:other');
  assert.deepEqual((await scan('git push origin feature:release side:other')).revisions, [second]);
  const mappings = (count) => Array.from({ length: count }, (_, i) => 'feature:new-' + i).join(' ');
  assert.deepEqual((await scan('git push origin ' + mappings(64))).revisions, outgoing);
  assert.equal((await scan('git push origin ' + mappings(65))).commits, 0);
  const tagPush = await scan('git push origin --tags');
  assert.equal(tagPush.commits, 0);
  assert.equal(tagPush.remoteRefLimit, false);
  const looseRefs = Number(onRemote('for-each-ref', '--format=%(refname)').split('\n').length) - 300;
  setTags(remote, 4096 - looseRefs);
  assert.equal((await scan('git push origin --tags')).remoteRefLimit, false);
  setTags(remote, 4097 - looseRefs);
  assert.deepEqual((await scan('git push origin feature')).revisions, outgoing);
  const ev = {
    kind: 'approval',
    requestId: 'limit',
    commandApproval: true,
    shellCommand: { shell: 'bash', text: 'git push origin --tags' },
  };
  assert.ok(await reviewPublication({ cwd, approvals: new Map([['limit', {}]]) }, ev, cwd, 'external action'));
  assert.match(ev.warning, /3 commit\(s\) examined.*too many refs.*full outgoing history/i);
  assert.ok(ev.findings.some((hit) => hit.commit === base));
  assert.deepEqual(ev.decisions, ['decline']);
});

test('historic credentials, push URLs, exceptions, changed tips, PR text and pre-push', async (t) => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'bridge-security-'));
  const cwd = path.join(tmp, 'work'),
    remote = path.join(tmp, 'remote'),
    alternate = path.join(tmp, 'alternate');
  fs.mkdirSync(cwd);
  const old = process.env.LOCALAPPDATA;
  process.env.LOCALAPPDATA = path.join(tmp, 'state');
  t.after(() => {
    if (old === undefined) delete process.env.LOCALAPPDATA;
    else process.env.LOCALAPPDATA = old;
    fs.rmSync(tmp, { recursive: true, force: true });
  });
  const git = (...args) => execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
  git('init', '-b', 'main');
  git('config', 'user.name', 'Fixture');
  git('config', 'user.email', 'fixture@example.test');
  git('init', '--bare', '-b', 'main', remote);
  git('init', '--bare', alternate);
  git('remote', 'add', 'origin', remote);
  const value = 'ghp_' + '0123456789abcdefghijklmnopqrstuvwxyz';
  const key = randomBytes(32);
  const command = (text) => ({ text, shell: 'bash' });
  const scan = (text) => scanPublication(cwd, command(text), key);
  const save = (text, msg) => {
    fs.writeFileSync(path.join(cwd, 'code.txt'), text);
    git('add', '.');
    git('commit', '-m', msg);
  };
  save('clean\n', 'initial');
  git('push', 'origin', 'main');
  save('clean\n' + value + '\n', 'synthetic example');
  const secretCommit = git('rev-parse', 'HEAD');
  save('clean\n', 'remove fixture');
  const result = await scan('git push --no-verify origin main:feature');
  assert.equal(result.commits, 2);
  assert.equal(result.findings[0].commit, secretCommit);
  assert.equal(result.findings[0].line, 2);
  assert.ok(!JSON.stringify(result).includes(value));
  const deleted = await scan('git push origin --delete feature');
  assert.equal(deleted.commits, 0);
  assert.deepEqual(JSON.parse(deleted.scope).refspecs, ['feature']);
  git('config', 'alias.publish-fixture', 'push');
  const alias = await scan('git -C . publish-fixture origin main');
  assert.ok(alias.findings.some((f) => f.commit === secretCommit));
  await assert.rejects(scan('git commit -m later && git push origin main'));
  await assert.rejects(scan('gh pr create --head main --body-file note'));
  assert.ok((await scan('gh pr create --head main --title Review --body ' + value)).findings.some((f) => f.commit === 'PR'));
  const opaque = { kind: 'approval', agent: 'x', requestId: 'unknown', commandApproval: true, matchText: 'git push origin main' };
  await reviewPublication({ cwd, approvals: new Map([['unknown', {}]]) }, opaque, cwd, 'external action');
  assert.deepEqual(opaque.decisions, ['decline']);
  const push = 'git push --no-verify origin main';
  const agents = [
    new ClaudeAgent({ id: 'claude-test', cwd }),
    new CodexAgent({ id: 'codex-test', cwd }),
    new OpenCodeAgent({ id: 'oc-test', cwd, config: { askFor: [] } }),
  ];
  assert.ok(agents[2].permissionRules().some((rule) => rule.pattern === 'git push *' && rule.action === 'ask'));
  for (const adapter of agents) {
    const received = once(adapter, 'event');
    if (adapter instanceof ClaudeAgent)
      adapter.handleControlRequest({
        request_id: 'push',
        request: { subtype: 'can_use_tool', tool_name: 'Bash', input: { command: push } },
      });
    else if (adapter instanceof CodexAgent)
      adapter.handleServerRequest({ method: 'item/commandExecution/requestApproval', id: 1, params: { command: push, cwd } });
    else adapter.onEvent({ type: 'permission.asked', properties: { id: 'push', permission: 'bash', metadata: { command: push } } });
    const [event] = await received;
    assert.equal(event.kind, 'approval');
    assert.ok(await reviewPublication(adapter, event, cwd, null));
    assert.deepEqual(event.decisions, ['decline']);
    assert.ok(event.findings.some((f) => f.commit === secretCommit));
  }
  const compound = {
    kind: 'approval',
    requestId: 'compound',
    agent: 'agent',
    commandApproval: true,
    shellCommand: command('git checkout -f main && git push origin main'),
  };
  assert.ok(await reviewPublication({ cwd, approvals: new Map([['compound', {}]]) }, compound, cwd, 'checkout may replace working files'));
  assert.deepEqual(compound.decisions, ['decline']);
  assert.ok((await scan('git push --follow-tags origin')).findings.some((f) => f.commit === secretCommit));
  const ev = { kind: 'approval', requestId: 'one', agent: 'agent', commandApproval: true, shellCommand: command('git push origin main') };
  const agent = { cwd, approvals: new Map([['one', {}]]) };
  assert.ok(await reviewPublication(agent, ev, cwd, 'external action'));
  assert.deepEqual(ev.decisions, ['decline']);
  await assert.rejects(verifyDecision(agent, 'one', 'accept', () => {}));
  const finding = ev.findings[0];
  assert.deepEqual(ev.appliedExceptions, []);
  await confirmException(agent, 'one', finding.id, 'test fixture', () => {});
  assert.deepEqual(ev.appliedExceptions, [{ ...finding, reason: 'test fixture' }]);
  const record = path.join(process.env.LOCALAPPDATA, 'agent-bridge', 'publication', finding.id + '.json');
  fs.writeFileSync(record, JSON.stringify({ id: finding.id, reason: 'false positive' }));
  await assert.rejects(
    verifyDecision(agent, 'one', 'accept', () => {}),
    /changed/,
  );
  assert.deepEqual(ev.appliedExceptions, [{ ...finding, reason: 'false positive' }]);
  fs.writeFileSync(record, '{}');
  await assert.rejects(
    verifyDecision(agent, 'one', 'accept', () => {}),
    /blocked/,
  );
  assert.deepEqual(ev.findings, [finding]);
  await confirmException(agent, 'one', finding.id, 'test fixture', () => {});
  await verifyDecision(agent, 'one', 'accept', () => {});
  save('different clean text\n', 'more work');
  await assert.rejects(
    verifyDecision(agent, 'one', 'accept', () => {}),
    /changed/,
  );
  await verifyDecision(agent, 'one', 'accept', () => {});
  git('push', 'origin', 'main');
  assert.equal((await scan('git push origin main')).commits, 0);
  const pr = await scan('gh pr create --head main --title Review --body ' + value);
  assert.equal(pr.commits, 0);
  assert.ok(pr.findings.some((hit) => hit.file === 'description'));
  git('remote', 'set-url', '--add', '--push', 'origin', remote);
  git('remote', 'set-url', '--add', '--push', 'origin', alternate);
  assert.ok((await scan('git push origin main')).findings.some((f) => f.commit === secretCommit));
  assert.equal(detectSecrets('postgres://user:password@localhost').length, 0);
  assert.equal(redact('postgres://user:abc123@localhost'), 'postgres://user:[secret removed]@localhost');
  fs.writeFileSync(path.join(cwd, 'sign.jks'), '');
  git('add', '.');
  git('commit', '-m', 'empty sensitive file');
  git('tag', 'fixture');
  assert.ok((await scan('git push --tags origin')).findings.some((f) => f.rule === 'Sensitive filename'));
  await setHook(cwd, true, '');
  const attempt = spawnSync('git', ['push', 'origin', 'main'], { cwd, encoding: 'utf8' });
  assert.notEqual(attempt.status, 0);
  assert.match(attempt.stderr, /Sensitive filename/);
  assert.ok(!attempt.stderr.includes(value));
});
