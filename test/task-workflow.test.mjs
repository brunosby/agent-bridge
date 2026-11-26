import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { execFileSync } from 'node:child_process';
import { changeFingerprint } from '../src/workspace/git-context.ts';
import { captureTaskBaseline, startPlan, growth, question } from '../src/server/task-plan.ts';
import { startBridge } from './helpers/bridge.mjs';
import { workflowMarkers } from '../public/js/core/workflow-markers.js';
import { buildMatcher } from '../src/core/safety.ts';
const team = ['orchestrator', 'coder', 'architect'].map((role, i) => ({ driver: 'fake', role, name: ['Lead', 'Dev', 'Design'][i] }));
const decision = (bridge, kind) => bridge.waitFor((e) => e.kind === 'state' && e.taskPlan?.pending?.kind === kind);
const reply = (bridge, text) => bridge.waitFor((e) => e.kind === 'turnEnd' && e.text === text);
const action = (bridge, state, values) =>
  bridge.api('taskDecision', {
    conversationId: state.conversationId,
    seq: state.taskPlan.seq,
    requestId: state.taskPlan.pending?.id,
    ...values,
  });
const mark = (name, body) => '[[' + name + ']]\n' + body + '\n[[/' + name.split(':')[0] + ']]';
const size = mark('SIZE: large', 'Public API change');
const docs = [{ path: 'docs/spec/change-api.md', text: 'Draft' }];
const questions = [{ question: 'Choose a label', options: ['A', 'B'], recommendation: 'A', evidence: 'User preference' }];

test('fingerprints ignore Git textconv and growth excludes pre-existing dirty paths', async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bridge-growth-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const git = (...args) => execFileSync('git', args, { cwd: dir, stdio: 'pipe' });
  git('init');
  fs.writeFileSync(path.join(dir, '.gitattributes'), 'checked.txt diff=fixture\n');
  fs.writeFileSync(path.join(dir, 'checked.txt'), 'before');
  git('add', '.');
  git('-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '-m', 'baseline');
  git('config', 'diff.fixture.textconv', 'false');
  fs.writeFileSync(path.join(dir, 'checked.txt'), 'updated');
  assert.ok(await changeFingerprint(dir, true));
  const owner = { workDir: dir, team: [], project: { [dir]: { git: true } } };
  for (let i = 0; i < 9; i++) fs.writeFileSync(path.join(dir, 'before' + i), '');
  const plan = startPlan(1, await captureTaskBaseline(owner));
  plan.size = 'small';
  assert.equal(await growth(plan), '');
  for (let i = 0; i < 9; i++) fs.writeFileSync(path.join(dir, 'after' + i), '');
  assert.match(await growth(plan), /9 files/);
  assert.equal(await growth({ ...plan, baseline: {} }), '');
});
test('medium and large tasks skip the Git growth check', async () => {
  for (const size of ['medium', 'large']) {
    const plan = {
      size,
      get baseline() {
        throw Error('unexpected Git scan');
      },
    };
    assert.equal(await growth(plan), '');
  }
});
test('questions accept the field labels in the plan', () => {
  const input = 'pergunta: Escolha\nopções: A | B\nrecomendação: A\nevidência: Preferência';
  assert.deepEqual(question('a1', input).questions, [
    { question: 'Escolha', options: ['A', 'B'], recommendation: 'A', evidence: 'Preferência' },
  ]);
});

test('control blocks preserve fenced examples and return the delegation separately', () => {
  const code = '~~~\n' + size + '\n~~~';
  assert.deepEqual(workflowMarkers(code + '\n' + size + '\n@Dev go'), {
    text: code + '\n@Dev go',
    blocks: [{ kind: 'SIZE', size: 'large', value: 'Public API change' }],
  });
});
test('external writes, destructive checkouts and recursive deletion require review', async () => {
  const classify = buildMatcher({ workDir: process.cwd() });
  for (const command of [
    'git push',
    'git push -fu',
    'git push origin +main',
    'git push --force-with-lease',
    'git checkout .',
    'git checkout HEAD .',
    'bash -lc "git checkout HEAD ."',
    'pwsh -Command "git push"',
    'git checkout -f main',
    'git switch -f main',
    'git switch main --discard-changes',
    'git switch --force feature/safety',
    'git -C . switch -qf main',
    'git checkout main --force',
    'git checkout HEAD -- package.json',
    'git -C . checkout HEAD package.json',
    'git checkout package.json',
    'rm -f -r temp',
    'gh pr merge',
    'gh pr create',
    'gh api -X POST issues',
    'curl -d sample example.invalid',
    'Invoke-WebRequest example.invalid -Method Post',
  ])
    assert.ok(await classify({ command }), command);
  for (const command of [
    'git status',
    'git checkout fixture-branch',
    'git checkout feature/safety',
    'git switch feature/safety',
    'git switch -c new-feature',
    'git log --grep="git switch -f"',
    'git stash push -m update',
    'git log --grep="git push"',
    'git checkout push',
    'git commit -m "push --force"',
    'gh pr view',
    'curl example.invalid',
  ])
    assert.equal(await classify({ command }), null, command);
});
test('checkout distinguishes a branch from existing and deleted tracked paths', async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'checkout-policy-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const git = (...args) => execFileSync('git', args, { cwd: dir, stdio: 'pipe' });
  git('init');
  fs.mkdirSync(path.join(dir, 'feature'));
  fs.writeFileSync(path.join(dir, 'feature', 'item'), 'sample');
  git('add', '.');
  git('-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '-m', 'fixture');
  const classify = (command) => buildMatcher({ workDir: dir })({ command });
  assert.ok(await classify('git checkout feature/item'));
  fs.unlinkSync(path.join(dir, 'feature', 'item'));
  assert.ok(await classify('git checkout feature/item'));
  git('branch', 'feature/item');
  assert.equal(await classify('git checkout feature/item'), null);
  assert.ok(await classify('git checkout -f feature/item'));
  assert.equal(await classify('git stash push -m "update"'), null);
  assert.equal(await classify('git log --grep push'), null);
  assert.equal(await classify('node example.js git push'), null);
});
test('large tasks gate coding and save only the reviewed specification outside Git', async (t) => {
  const bridge = await startBridge({
    team,
    rules: [
      { agent: 'Design', reply: mark('SPEC', JSON.stringify(docs)) },
      { agent: 'Lead', match: 'Specification approved and saved', reply: '@Dev implement the approved design' },
      { agent: 'Lead', match: 'start design', reply: size + '\n@Dev implement' },
      { agent: 'Dev', reply: 'implementation received' },
    ],
  });
  t.after(() => bridge.stop());
  await bridge.api('send', { text: 'start design' });
  const first = await decision(bridge, 'spec');
  assert.equal(first.taskPlan.size, 'large');
  assert.ok(!bridge.events.some((e) => e.kind === 'taskQueued' && e.agent === 'a2'));
  await action(bridge, first, { action: 'revise', feedback: 'Clarify constraints' });
  const second = await bridge.waitFor(
    (e) => e.kind === 'state' && e.taskPlan?.pending?.kind === 'spec' && e.taskPlan.pending.id !== first.taskPlan.pending.id,
  );
  assert.ok(!fs.existsSync(path.join(bridge.work, docs[0].path)));
  await assert.rejects(action(bridge, first, { action: 'approve', docs }), /no longer open/);
  await action(bridge, second, { action: 'approve', docs: [{ ...docs[0], text: 'Exactly as edited.\n' }] });
  assert.equal(fs.readFileSync(path.join(bridge.work, docs[0].path), 'utf8'), 'Exactly as edited.\n');
  await reply(bridge, 'implementation received');
});
test('an Architect can correct a prose draft before coding starts', async (t) => {
  const bridge = await startBridge({
    team,
    rules: [
      { agent: 'Lead', match: 'start draft', reply: size + '\n@Dev implement' },
      { agent: 'Design', match: 'Resubmit the specification', reply: mark('SPEC', JSON.stringify(docs)) },
      { agent: 'Design', reply: 'Here is the design in prose.' },
    ],
  });
  t.after(() => bridge.stop());
  await bridge.api('send', { text: 'start draft' });
  await decision(bridge, 'spec');
  assert.deepEqual(
    bridge.events.filter((e) => e.kind === 'taskQueued' && e.agent === 'a3').map((e) => e.specAttempt),
    ['draft', 'correction'],
  );
  assert.ok(!bridge.events.some((e) => e.kind === 'taskQueued' && e.agent === 'a2'));
});

test('after one failed correction the user can restore and retry the same specification', async (t) => {
  const rules = [
    { agent: 'Lead', match: 'start draft', reply: size + '\n@Design specify' },
    { agent: 'Design', match: 'Retry the specification', reply: mark('SPEC', JSON.stringify(docs)) },
    { agent: 'Design', match: 'Resubmit the specification', reply: mark('SPEC', 'invalid') },
    { agent: 'Design', reply: 'Here is an incomplete draft.\n[[SPEC]]\n[]' },
  ];
  let bridge = await startBridge({ team, rules });
  t.after(() => bridge.stop());
  await bridge.api('send', { text: 'start draft' });
  const stalled = await bridge.waitFor((e) => e.kind === 'state' && e.taskPlan?.specNeedsRetry);
  await bridge.waitFor((e) => e.kind === 'error' && e.text.includes('after one correction'));
  assert.equal(bridge.events.filter((e) => e.kind === 'taskQueued' && e.agent === 'a3').length, 2);
  await bridge.stop();
  bridge = await startBridge({ dir: bridge.root, resume: stalled.conversationId, team, rules });
  await bridge.waitFor((e) => e.kind === 'state' && e.taskPlan?.specNeedsRetry && e.team.every((a) => a.available));
  await action(bridge, stalled, { action: 'retrySpec' });
  const spec = await decision(bridge, 'spec');
  assert.equal(spec.taskPlan.seq, stalled.taskPlan.seq);
  assert.ok(!spec.taskPlan.specNeedsRetry);
  await assert.rejects(action(bridge, stalled, { action: 'retrySpec' }), /waiting for a retry/);
});

test('a size-only reply gets one follow-up and manual classification survives the next model estimate', async (t) => {
  const bridge = await startBridge({
    team,
    rules: [
      { agent: 'Lead', match: 'new estimate', reply: mark('SIZE: small', 'one file') },
      { agent: 'Lead', match: 'The user selected task size', reply: mark('SIZE: large', 'model override') },
      { agent: 'Lead', match: 'Size recorded', reply: mark('SIZE: small', 'one file') },
    ],
  });
  t.after(() => bridge.stop());
  await bridge.api('send', { text: 'new estimate' });
  const state = await bridge.waitFor(
    (e) => e.kind === 'state' && e.taskPlan?.size === 'small' && e.team[0].tokens >= 200 && !e.team[0].busy,
  );
  assert.equal(bridge.events.filter((e) => e.kind === 'taskQueued' && e.agent === 'a1').length, 2);
  assert.ok(bridge.events.some((e) => e.kind === 'system' && e.text.includes('without taking action')));
  await action(bridge, state, { action: 'size', size: 'medium' });
  await bridge.waitFor((e) => e.kind === 'state' && e.team[0].tokens >= 300 && !e.team[0].busy);
  assert.equal(bridge.state().taskPlan.size, 'medium');
});
test('consecutive decisions survive restore, notify only when opened and advance in order', async (t) => {
  const ask = mark('QUESTION', JSON.stringify(questions));
  const second = mark('QUESTION', JSON.stringify([{ ...questions[0], question: 'Choose another label' }]));
  const rules = [
    { agent: 'Lead', match: 'Answer to question', reply: '[[DONE]]' },
    { agent: 'Lead', match: 'two decisions', reply: ask + '\n' + second },
  ];
  let bridge = await startBridge({ team, rules });
  t.after(() => bridge.stop());
  await bridge.api('send', { text: 'two decisions' });
  const first = await decision(bridge, 'question');
  await bridge.waitFor((e) => e.kind === 'system' && e.text.includes('was queued'));
  assert.equal(bridge.events.filter((e) => e.kind === 'workflowRequest').length, 1);
  await bridge.stop();
  bridge = await startBridge({ dir: bridge.root, resume: first.conversationId, team, rules });
  await bridge.waitFor((e) => e.kind === 'state' && e.taskPlan?.pending?.id === first.taskPlan.pending.id && e.team[0].available);
  await action(bridge, first, { action: 'answer', answers: ['A'] });
  const next = await bridge.waitFor((e) => e.kind === 'state' && e.taskPlan?.pending?.questions?.[0].question === 'Choose another label');
  const opened = bridge.events.find((e) => e.kind === 'workflowRequest' && e.requestId === next.taskPlan.pending.id);
  assert.ok(opened.seq > bridge.events.find((e) => e.kind === 'workflowClosed' && e.requestId === first.taskPlan.pending.id).seq);
  await bridge.waitFor((e) => e.kind === 'info' && e.text.includes('before it can finish'));
  await action(bridge, next, { action: 'dismiss' });
  await bridge.waitFor((e) => e.kind === 'state' && e.seq > next.seq && !e.taskPlan?.pending);
});

test('large delegations reach the other workers, defer the routing notice until the specification approval', async (t) => {
  const rules = [
    { agent: 'Lead', match: 'mixed delegation', reply: size + '\n@Dev implement\n@Design specify\n@Scout investigate' },
    {
      agent: 'Lead',
      match: 'Agent Bridge routing[\\s\\S]*Specification approved and saved',
      reply: mark('QUESTION', JSON.stringify(questions)),
    },
    { agent: 'Design', waitForFile: 'release-design', reply: mark('SPEC', JSON.stringify(docs)) },
    { agent: 'Scout', reply: 'investigation complete' },
  ];
  const bridge = await startBridge({ team: [...team, { role: 'researcher', driver: 'fake', name: 'Scout' }], rules });
  t.after(() => bridge.stop());
  await bridge.api('send', { text: 'mixed delegation' });
  await reply(bridge, 'investigation complete');
  assert.equal(bridge.events.filter((e) => e.kind === 'taskQueued' && e.agent === 'a1').length, 1);
  fs.writeFileSync(path.join(bridge.work, 'release-design'), '');
  const spec = await decision(bridge, 'spec');
  await action(bridge, spec, { action: 'approve', docs });
  await decision(bridge, 'question');
  assert.equal(bridge.events.filter((e) => e.kind === 'taskQueued' && e.agent === 'a3').length, 1);
  assert.ok(!bridge.events.some((e) => e.kind === 'taskQueued' && e.agent === 'a2'));
});

test('when nobody can receive the delegation the coordinator is notified immediately and only once', async (t) => {
  const rules = [
    { agent: 'Lead', match: 'repeat delegation', reply: size + '\n@Dev first assignment' },
    { agent: 'Lead', match: 'Agent Bridge routing', reply: '@Dev second assignment' },
  ];
  const bridge = await startBridge({ team: team.slice(0, 2), rules, settings: { recommendRoles: 'off' } });
  t.after(() => bridge.stop());
  await bridge.api('send', { text: 'repeat delegation' });
  await reply(bridge, '@a2 second assignment');
  await bridge.waitFor((e) => e.kind === 'state' && e.team[0].tokens >= 200 && !e.team[0].busy);
  assert.equal(bridge.events.filter((e) => e.kind === 'taskQueued' && e.agent === 'a1').length, 2);
  assert.ok(!bridge.events.some((e) => e.kind === 'taskQueued' && e.agent === 'a2'));
});
test('small delegation tells the coordinator which agent was skipped', async (t) => {
  const rules = [
    { agent: 'Lead', match: 'small delegation', reply: mark('SIZE: small', 'one module') + '\n@Dev build\n@Design inspect' },
    { agent: 'Dev', waitForFile: 'worker-ready', reply: 'worker result' },
    { agent: 'Lead', match: 'Do not wait for @a3[\\s\\S]*worker result', reply: 'skipped worker acknowledged' },
  ];
  const bridge = await startBridge({ team, rules, settings: { finalConfirmation: false } });
  t.after(() => bridge.stop());
  await bridge.api('send', { text: 'small delegation' });
  await bridge.waitFor((e) => e.kind === 'taskQueued' && e.agent === 'a2');
  assert.equal(bridge.events.filter((e) => e.kind === 'taskQueued' && e.agent === 'a1').length, 1);
  fs.writeFileSync(path.join(bridge.work, 'worker-ready'), '');
  await reply(bridge, 'skipped worker acknowledged');
  assert.equal(bridge.events.filter((e) => e.kind === 'taskQueued' && e.agent === 'a1').length, 2);
  assert.ok(!bridge.events.some((e) => e.kind === 'taskQueued' && e.agent === 'a3'));
});

test('a late question belongs to the earlier request and answers resume that request', async (t) => {
  const bridge = await startBridge({
    team,
    rules: [
      { agent: 'Lead', match: 'first request', waitForFile: 'release-first', reply: mark('QUESTION', JSON.stringify(questions)) },
      { agent: 'Dev', match: 'second request', waitForFile: 'release-second', reply: 'Second answer' },
    ],
    settings: { autoRelay: false },
  });
  t.after(() => bridge.stop());
  await bridge.api('send', { text: 'first request' });
  const first = await bridge.waitFor((e) => e.kind === 'user' && e.text === 'first request');
  await bridge.api('send', { text: 'second request', target: 'a2' });
  fs.writeFileSync(path.join(bridge.work, 'release-first'), '');
  const state = await bridge.waitFor((e) => e.kind === 'state' && e.earlierDecisions?.some((d) => d.seq === first.seq));
  const old = state.progress.find((r) => r.seq === first.seq);
  assert.equal(old.status, 'Waiting for you');
  assert.equal(state.progress.at(-1).status, 'In progress');
  const id = old.waiting.card;
  await bridge.api('taskDecision', {
    conversationId: state.conversationId,
    seq: first.seq,
    requestId: id,
    action: 'answer',
    answers: ['A'],
  });
  await bridge.waitFor((e) => e.kind === 'taskQueued' && e.requestSeq === first.seq && e.seq > state.seq);
  fs.writeFileSync(path.join(bridge.work, 'release-second'), '');
});
test('removing the last agent fails without opening succession', async (t) => {
  const bridge = await startBridge({ team: [team[0]], rules: [] });
  t.after(() => bridge.stop());
  await assert.rejects(bridge.api('removeAgent', { agent: 'a1' }), /at least one/);
  assert.ok(!bridge.events.some((e) => e.kind === 'workflowRequest'));
});
test('question answers continue the task and a new message closes the previous request', async (t) => {
  const bridge = await startBridge({
    team,
    rules: [
      { agent: 'Lead', match: 'Answer to question', reply: 'answer received' },
      { agent: 'Lead', match: 'ask me', reply: mark('QUESTION', JSON.stringify(questions)) },
    ],
  });
  t.after(() => bridge.stop());
  await bridge.api('send', { text: 'ask me' });
  const first = await decision(bridge, 'question');
  assert.equal(first.taskPlan.size, 'medium');
  await action(bridge, first, { action: 'answer', answers: ['Custom choice'] });
  await reply(bridge, 'answer received');
  assert.equal(bridge.state().taskPlan.seq, first.taskPlan.seq);
  await bridge.api('send', { text: 'ask me again' });
  const second = await bridge.waitFor((e) => e.kind === 'state' && e.taskPlan?.seq > first.taskPlan.seq && e.taskPlan.pending);
  await bridge.api('send', { text: 'Different task' });
  await assert.rejects(action(bridge, second, { action: 'answer', answers: ['A'] }), /no longer current/);
});
test('pause retains a late batch, while Stop all never delivers it after Resume', async (t) => {
  for (const stop of [false, true]) {
    const rules = [
      { agent: 'Lead', match: 'run worker', reply: '@Dev work' },
      { agent: 'Dev', reply: 'worker result', waitForFile: 'release-worker' },
      { agent: 'Lead', match: 'worker result', reply: 'result received' },
    ];
    const bridge = await startBridge({ team, rules, settings: { fake: { rules, finishAfterInterrupt: true } } });
    t.after(() => bridge.stop());
    await bridge.api('send', { text: 'run worker' });
    await bridge.waitFor((e) => e.kind === 'taskStarted' && e.agent === 'a2');
    if (stop) await bridge.api('interrupt');
    else await bridge.api('relay', { pause: true });
    fs.writeFileSync(path.join(bridge.work, 'release-worker'), '');
    await reply(bridge, 'worker result');
    assert.ok(!bridge.events.some((e) => e.kind === 'routed' && e.to === 'a1'));
    await bridge.api('relay', { resume: true });
    if (stop) {
      await bridge.api('send', { text: 'next request' });
      await bridge.waitFor((e) => e.kind === 'turnEnd' && e.agent === 'a1' && e.text.startsWith('ok'));
      assert.ok(!bridge.events.some((e) => e.kind === 'routed' && e.to === 'a1'));
    } else await reply(bridge, 'result received');
  }
});
test('coordinator removal requires an explicit successor and sends the handoff', async (t) => {
  const bridge = await startBridge({
    team,
    rules: [
      { agent: 'Lead', match: 'begin work', reply: '@Dev work' },
      { agent: 'Dev', waitForFile: 'release-work', reply: 'worker result' },
      { agent: 'Design', match: 'handoff', reply: 'handoff received' },
      { agent: 'Design', match: 'worker result', reply: 'held result received' },
    ],
  });
  t.after(() => bridge.stop());
  await bridge.waitFor((e) => e.kind === 'state' && e.team.length === 3 && e.team.every((a) => a.available));
  await bridge.api('send', { text: 'begin work' });
  await bridge.waitFor((e) => e.kind === 'taskStarted' && e.agent === 'a2');
  await bridge.api('removeAgent', { agent: 'a1' });
  const state = await bridge.waitFor((e) => e.kind === 'state' && e.team.length === 2 && e.succession);
  const removed = bridge.events.find((e) => e.kind === 'system' && e.text.startsWith('Removed @a1'));
  assert.ok(removed.seq < bridge.events.find((e) => e.kind === 'workflowRequest' && e.requestId === state.succession.id).seq);
  assert.deepEqual(
    state.succession.choices.map((m) => m.id),
    ['a3'],
  );
  fs.writeFileSync(path.join(bridge.work, 'release-work'), '');
  await bridge.waitFor((e) => e.kind === 'batchCompleted');
  await bridge.api('coordinatorDecision', {
    action: 'transfer',
    agent: 'a3',
    requestId: state.succession.id,
    conversationId: state.conversationId,
  });
  await reply(bridge, 'handoff received');
  await reply(bridge, 'held result received');
  assert.deepEqual(
    bridge
      .state()
      .team.filter((a) => a.role === 'orchestrator')
      .map((a) => a.id),
    ['a3'],
  );
});
