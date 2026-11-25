import { isTestCommand } from '../src/core/test-command.ts';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import os from 'node:os';
import { startBridge } from './helpers/bridge.mjs';
import { isReviewExcluded, reviewChanges } from '../src/workspace/git-context.ts';
import { resolveRecipients } from '../src/core/recipients.ts';
import { Transcript } from '../public/js/core/transcript.js';

test('recipient rule respects priority, team order and orchestration fallback', () => {
  const team = [
    { id: 'a', name: 'Dev', role: 'coder' },
    { id: 'b', name: 'Lead', role: 'orchestrator' },
  ];
  assert.deepEqual(resolveRecipients(team, 'orchestrator'), ['b']);
  assert.deepEqual(resolveRecipients(team, 'pipeline', 'auto', 'mention @Lead later'), ['a']);
  assert.deepEqual(resolveRecipients(team, 'pipeline', 'auto', '@Lead, @Dev @Lead message'), ['b', 'a']);
  assert.deepEqual(resolveRecipients(team, 'orchestrator', 'a', '@Lead'), ['a']);
  assert.deepEqual(resolveRecipients(team, 'orchestrator', 'all', '@Lead'), ['a', 'b']);
  assert.deepEqual(resolveRecipients(team, 'orchestrator', 'missing'), []);
});

test('review exclusions cover defaults, nested paths, Windows separators and local patterns', () => {
  const names = [
    '.env',
    '.ENV.Staging',
    'nested/root.pem',
    'nested\\root.key',
    'ssh/id_rsa.old',
    'a.p12',
    'credentials-work.JSON',
    'ssh/id_ed25519.pub',
    'id_ecdsa.bak',
    'id_dsa',
    '.npmrc',
    'nested/.netrc',
    '.pypirc',
    'cert.PFX',
  ];
  for (const name of names) assert.equal(isReviewExcluded(name), true, name);
  assert.equal(isReviewExcluded('vendor/private.settings', ['vendor/*.settings']), true);
  assert.equal(isReviewExcluded('public/a.js', ['vendor/*.settings']), false);
});

test('large transcript filters by data and retains per-agent turn identity', (t) => {
  const model = new Transcript();
  const start = performance.now();
  for (let seq = 1; seq <= 18000; seq++) {
    const entry = model.add({ seq }, 'entry ' + seq, seq % 2 === 0 ? 'message' : 'tool', [seq % 3 === 0 ? 'dev' : 'lead']);
    if (seq === 17999) model.track('lead', entry);
  }
  const modelMs = performance.now() - start;
  const searchStart = performance.now();
  const results = model.search('18000', 'messages', 'dev');
  t.diagnostic('18,000 entries, model ' + modelMs.toFixed(1) + ' ms; search ' + (performance.now() - searchStart).toFixed(1) + ' ms');
  assert.equal(results[0].seq, 18000);
  assert.deepEqual([...model.endTurn('dev')], []);
  assert.equal([...model.endTurn('lead')][0].seq, 17999);
  model.clear();
  assert.equal(model.entries.length, 0);
  assert.equal(model.bySequence.size, 0);
});

test('preview and sending agree, and tasks link back to the source message', async () => {
  const b = await startBridge({
    team: [
      { driver: 'fake', name: 'Dev', role: 'coder' },
      { driver: 'fake', name: 'Lead', role: 'orchestrator' },
    ],
    settings: { autoRelay: false },
    rules: [],
  });
  try {
    await b.waitFor((e) => e.kind === 'state' && e.team.length === 2);
    const initial = await b.api('previewTarget', { target: 'auto', prefix: '' });
    assert.equal(initial.targets[0].name, 'Lead');
    const preview = await b.api('previewTarget', { target: 'auto', prefix: '@Dev' });
    await b.api('send', { target: 'auto', text: '@Dev inspect' });
    const message = await b.waitFor((e) => e.kind === 'user');
    assert.deepEqual(
      message.to,
      preview.targets.map((agent) => agent.id),
    );
    const task = await b.waitFor((e) => e.kind === 'taskQueued');
    assert.equal(task.sourceSeq, message.seq);
    const turn = await b.waitFor((e) => e.kind === 'turnEnd');
    assert.deepEqual(turn.taskIds, [task.id]);
    await b.waitFor((e) => e.kind === 'state' && e.seq > turn.seq && e.tasks.length === 0);
  } finally {
    await b.stop();
  }
});

test('a Reviewer receives the allowed patch while tracked and untracked secrets stay out of its input', async () => {
  const team = [
    { driver: 'fake', name: 'Lead', role: 'orchestrator' },
    { driver: 'fake', name: 'Rev', role: 'reviewer' },
  ];
  const b = await startBridge({
    team,
    settings: { reviewDiffExcludePatterns: ['*.private'] },
    rules: [
      { agent: 'Lead', match: 'Message from Tester', reply: '@Rev inspect' },
      { agent: 'Rev', match: 'BRIDGE_SECRET_SENTINEL|credentials-untracked.json', reply: 'unexpected secret' },
      { agent: 'Rev', match: 'VISIBLE_CHANGE[\\s\\S]*Sensitive paths omitted', reply: 'safe patch received' },
    ],
  });
  try {
    const git = (...args) => execFileSync('git', args, { cwd: b.work, stdio: 'ignore' });
    git('init');
    fs.mkdirSync(path.join(b.work, 'nested'));
    for (const name of ['.env', 'nested/cert.pem', 'strategy.private', 'rename.key', 'allowed.txt'])
      fs.writeFileSync(path.join(b.work, name), 'before\n');
    fs.writeFileSync(path.join(b.work, '.gitignore'), '.env\n');
    git('add', '-f', '.env', 'nested/cert.pem', 'strategy.private', 'rename.key', 'allowed.txt', '.gitignore');
    fs.writeFileSync(path.join(b.work, 'rename.key'), 'BRIDGE_SECRET_SENTINEL\n');
    git('add', 'rename.key');
    git('-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.test', 'commit', '-m', 'Fixture');
    git('mv', 'rename.key', 'renamed.txt');
    for (const name of [
      '.env',
      'nested/cert.pem',
      'strategy.private',
      'credentials-untracked.json',
      'nested/sign.jks',
      'nested/sign.keystore',
      '.git-credentials',
      'config.tfvars',
    ]) {
      fs.writeFileSync(path.join(b.work, name), 'BRIDGE_SECRET_SENTINEL\n');
    }
    fs.writeFileSync(path.join(b.work, 'allowed.txt'), 'VISIBLE_CHANGE\n');
    await b.api('send', { text: 'request review' });
    const result = await b.waitFor((event) => event.kind === 'turnEnd' && b.nameOf(event.agent) === 'Rev');
    assert.equal(result.text, 'safe patch received');
  } finally {
    await b.stop();
  }
});

test('final review reports Git metadata relative to the original baseline without file contents', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bridge-project-test-'));
  const work = path.join(dir, 'work');
  fs.mkdirSync(work);
  const git = (...args) => execFileSync('git', args, { cwd: work, stdio: 'ignore' });
  git('init');
  fs.writeFileSync(path.join(work, 'old.txt'), 'base');
  git('add', 'old.txt');
  git('-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.test', 'commit', '-m', 'Fixture');
  fs.writeFileSync(path.join(work, 'old.txt'), 'pre-existing');
  const b = await startBridge({
    dir,
    team: [{ driver: 'fake', name: 'Lead', role: 'orchestrator' }],
    rules: [],
    // A fast change with no edit-tool signal still has to be detected by Git.
    settings: {
      fake: {
        rules: [
          { match: 'dry run', reply: 'Nothing to change.\n[[DONE]]', edit: true },
          { reply: 'Finished.\n[[DONE]]', writeFile: ['new.txt', 'DO_NOT_INCLUDE_FILE_CONTENT'] },
        ],
        delayMs: 0,
      },
    },
  });
  try {
    const state = await b.waitFor((e) => e.kind === 'state');
    assert.ok(state.project.branch);
    await b.api('send', { text: 'Finish' });
    const final = await b.waitFor((e) => e.kind === 'finalReview');
    const summary = final.project[0];
    assert.equal(summary.status, 'ok');
    assert.equal(summary.files.find((f) => f.path === 'old.txt').preexisting, true);
    assert.equal(summary.files.find((f) => f.path === 'new.txt').preexisting, false);
    assert.doesNotMatch(JSON.stringify(final.project), /DO_NOT_INCLUDE_FILE_CONTENT/);

    await b.api('finalReview', { requestId: final.requestId, action: 'approve' });
    await b.api('send', { text: 'dry run' });
    await b.waitFor((e) => e.seq > final.seq && e.kind === 'system' && /nothing to approve/.test(e.text));
    assert.equal(b.events.filter((e) => e.kind === 'finalReview').length, 1);
  } finally {
    await b.stop();
  }
});

test('data model search has no dependency on the server replay limit', () => {
  const model = new Transcript();
  for (let seq = 1; seq <= 21000; seq++) model.add({ seq }, 'message ' + seq, 'message');
  assert.equal(model.search('message 21000', 'messages', '')[0].seq, 21000);
  assert.equal(model.bySequence.get(1).text, 'message 1');
});

test('test-command detection checks the npm script name rather than its arguments', () => {
  for (const command of [
    'npm run check',
    'npm run test:unit',
    'npm.cmd run lint:fix',
    'npm test',
    'node --test',
    'cd app && npm run check',
  ])
    assert.ok(isTestCommand(command), command);
  for (const command of ['npm run build -- --test', 'echo "npm run check"', 'node script.js --test'])
    assert.equal(isTestCommand(command), false, command);
});

test('large reviewer patches fall back to filtered metadata at a configurable limit', async () => {
  const team = [
    { driver: 'fake', name: 'Lead', role: 'orchestrator' },
    { driver: 'fake', name: 'Rev', role: 'reviewer' },
  ];
  const b = await startBridge({
    team,
    settings: { reviewDiffMaxChars: 20 },
    rules: [
      { agent: 'Lead', match: 'Message from Tester', reply: '@Rev inspect' },
      { agent: 'Rev', match: 'SECRET_SENTINEL|\\.env', reply: 'secret leaked' },
      { agent: 'Rev', match: 'Showing file status only[\\s\\S]*public.txt', reply: 'filtered file list received' },
      { agent: 'Rev', match: 'PATCH_BODY', reply: 'full patch received' },
    ],
  });
  try {
    const git = (...args) => execFileSync('git', args, { cwd: b.work, stdio: 'ignore' });
    git('init');
    fs.writeFileSync(path.join(b.work, 'public.txt'), 'base');
    fs.writeFileSync(path.join(b.work, '.env'), 'base');
    git('add', 'public.txt', '.env');
    git('-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.test', 'commit', '-m', 'Fixture');
    fs.writeFileSync(path.join(b.work, 'public.txt'), 'PATCH_BODY'.repeat(4500));
    fs.writeFileSync(path.join(b.work, '.env'), 'SECRET_SENTINEL');
    await b.api('send', { text: 'request review' });
    const result = await b.waitFor((event) => event.kind === 'turnEnd' && b.nameOf(event.agent) === 'Rev');
    assert.equal(result.text, 'filtered file list received');
    await b.api('settings', { reviewDiffMaxChars: 0 });
    await b.api('send', { text: 'review without a character limit' });
    const full = await b.waitFor((event) => event.kind === 'turnEnd' && event.seq > result.seq && b.nameOf(event.agent) === 'Rev');
    assert.equal(full.text, 'full patch received');
  } finally {
    await b.stop();
  }
});

test('review diff resolves Git scope when the working directory is a junction or symlink', async () => {
  const fixture = fs.mkdtempSync(path.join(os.tmpdir(), 'bridge-review-scope-'));
  const real = path.join(fixture, 'repo');
  const alias = path.join(fixture, 'alias');
  fs.mkdirSync(path.join(real, 'nested'), { recursive: true });
  const git = (...args) => execFileSync('git', args, { cwd: real, stdio: 'ignore' });
  git('init');
  fs.writeFileSync(path.join(real, 'outside.txt'), 'base outside');
  fs.writeFileSync(path.join(real, 'nested', 'inside.txt'), 'base inside');
  git('add', '.');
  git('-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.test', 'commit', '-m', 'Fixture');
  fs.writeFileSync(path.join(real, 'outside.txt'), 'outside content');
  fs.writeFileSync(path.join(real, 'nested', 'inside.txt'), 'inside content');
  fs.symlinkSync(real, alias, process.platform === 'win32' ? 'junction' : 'dir');
  const atRoot = await reviewChanges(alias, []);
  assert.match(atRoot?.patch || '', /outside content/);
  assert.match(atRoot?.patch || '', /inside content/);
  const nested = await reviewChanges(path.join(alias, 'nested'), []);
  assert.match(nested?.patch || '', /inside content/);
  assert.doesNotMatch(nested?.patch || '', /outside content/);
  assert.deepEqual(
    nested?.files.map((file) => file.names),
    [['inside.txt']],
  );
});
