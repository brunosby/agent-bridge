import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { startBridge } from './helpers/bridge.mjs';

const team = ['orchestrator', 'coder', 'tester', 'architect'].map((role, i) => ({
  driver: 'fake',
  role,
  name: ['Lead', 'Dev', 'Tests', 'Design'][i],
}));
const question =
  '[[QUESTION]]\n' +
  JSON.stringify([{ question: 'Which label?', options: ['A', 'B'], recommendation: 'A', evidence: 'Preference' }]) +
  '\n[[/QUESTION]]';
const instructions = '@Dev implement the change.\n@Tests check the result.';
const ask = (size = 'medium') => '[[SIZE: ' + size + ']]\nFixture\n[[/SIZE]]\n' + instructions + '\n' + question;
async function start(t, rules, settings = {}) {
  const b = await startBridge({ team, rules, settings });
  t.after(() => b.stop());
  return b;
}
const card = (b) => b.waitFor((e) => e.kind === 'state' && e.taskPlan?.pending?.kind === 'question');
const decide = (b, s, action, extra = {}) =>
  b.api('taskDecision', { conversationId: s.conversationId, seq: s.taskPlan.seq, requestId: s.taskPlan.pending.id, action, ...extra });
const work = (b) => b.events.filter((e) => e.kind === 'taskQueued' && ['a2', 'a3'].includes(e.agent));
const stateWhere = (b, predicate) =>
  b.waitFor((e) => e.kind === 'state' && e.taskPlan?.pending?.delegation && predicate(e.taskPlan.pending.delegation.targets));

test('question holds the original routing text; answering and dismissing return it exactly once without auto-delivery', async (t) => {
  for (const action of ['answer', 'dismiss']) {
    const b = await start(t, [
      { agent: 'Lead', match: 'Delegations from the question', reply: 'instructions returned' },
      { agent: 'Lead', match: 'mixed request', reply: ask() },
    ]);
    await b.api('send', { text: 'mixed request' });
    const s = await card(b);
    assert.deepEqual(
      s.taskPlan.pending.delegation.targets.map((t) => t.agent),
      ['a2', 'a3'],
    );
    assert.doesNotMatch(s.taskPlan.pending.delegation.text, /QUESTION/);
    assert.equal(s.relay.held, 0);
    await decide(b, s, action, { answers: ['B'] });
    await b.waitFor((e) => e.kind === 'turnEnd' && e.text === 'instructions returned');
    assert.equal(work(b).length, 0);
    const report = b.events.find((e) => e.kind === 'system' && e.text.includes('[Delegations from the question]')).text;
    assert.match(report, /@a2 implement the change/);
    assert.match(report, /@a3 — not sent/);
    await assert.rejects(decide(b, s, 'sendDelegations'), /no longer open/);
  }
});
test('Send now dispatches eligible recipients once, leaves the question open and charges one hop per worker', async (t) => {
  const b = await start(t, [{ agent: 'Lead', match: 'mixed request', reply: ask() }]);
  await b.api('send', { text: 'mixed request' });
  const s = await card(b);
  await Promise.all([decide(b, s, 'sendDelegations'), decide(b, s, 'sendDelegations')]);
  const confirmed = await stateWhere(b, (ts) => ts.every((t) => t.state === 'received'));
  assert.equal(confirmed.relay.hops, 2);
  assert.equal(confirmed.taskPlan.pending.id, s.taskPlan.pending.id);
  await decide(b, s, 'answer', { answers: ['A'] });
  await b.waitFor((e) => e.kind === 'system' && e.text.includes('All delegations have already been submitted'));
  assert.equal(work(b).length, 2);
});
test('partial sends preserve the small-task and specification gates across retries', async (t) => {
  for (const size of ['small', 'large']) {
    const b = await start(t, [{ agent: 'Lead', match: 'mixed request', reply: ask(size) }], { finalConfirmation: true });
    await b.api('send', { text: 'mixed request' });
    const s = await card(b);
    await decide(b, s, 'sendDelegations');
    const complete = await stateWhere(b, (ts) => ts.some((t) => t.state === 'received') && ts.some((t) => t.reason));
    const [delivered] = complete.taskPlan.pending.delegation.targets.filter((t) => t.state === 'received');
    assert.equal(delivered.agent, size === 'large' ? 'a3' : 'a2');
    await decide(b, s, 'sendDelegations');
    await decide(b, s, 'answer', { answers: ['A'] });
    const report = await b.waitFor((e) => e.kind === 'system' && e.text.includes('[Delegations from the question]'));
    assert.match(report.text, /not sent/);
    assert.match(report.text, /received/);
    assert.equal(work(b).length, 1);
  }
});
test('token pause leaves the record on the card and Resume keeps the question open', async (t) => {
  const b = await start(t, [{ agent: 'Lead', match: 'mixed request', reply: ask() }], { tokenLimit: 1 });
  await b.api('send', { text: 'mixed request' });
  const s = await card(b);
  await decide(b, s, 'sendDelegations');
  await stateWhere(b, (ts) => ts.every((t) => t.reason === 'token limit reached'));
  assert.equal(work(b).length, 0);
  await b.api('settings', { tokenLimit: 0 });
  await b.api('relay', { resume: true });
  await decide(b, s, 'sendDelegations');
  await stateWhere(b, (ts) => ts.every((t) => t.state === 'received'));
});
test('a queued question owns its delegation and delivery status survives restore', async (t) => {
  const b = await start(
    t,
    [
      { agent: 'Lead', match: 'opening request', reply: question },
      { agent: 'Lead', match: 'user selected task size', reply: instructions + '\n' + question },
    ],
    { finalConfirmation: true },
  );
  await b.api('send', { text: 'opening request' });
  const first = await card(b);
  await decide(b, first, 'size', { size: 'small' });
  await b.waitFor((e) => e.kind === 'system' && e.text.includes('question was queued'));
  assert.equal(first.taskPlan.pending.delegation, undefined);
  await assert.rejects(decide(b, first, 'sendDelegations'), /no delegations/);
  await decide(b, first, 'dismiss');
  const second = await stateWhere(b, (ts) => ts.length === 2);
  assert.notEqual(second.taskPlan.pending.id, first.taskPlan.pending.id);
  await decide(b, second, 'sendDelegations');
  await stateWhere(b, (ts) => ts.some((t) => t.state === 'received'));
  await b.api('new', { workDir: b.work });
  const before = b.events.length;
  await b.api('restore', { id: second.conversationId });
  const restored = await b.waitFor(
    (e) => b.events.indexOf(e) >= before && e.kind === 'state' && e.taskPlan?.pending?.id === second.taskPlan.pending.id,
  );
  assert.deepEqual(
    restored.taskPlan.pending.delegation.targets.map((t) => t.state),
    ['received', 'pending'],
  );
  await decide(b, restored, 'dismiss');
  await b.waitFor(
    (e) => b.events.indexOf(e) >= before && e.kind === 'system' && e.text.includes('@a2 — received') && e.text.includes('@a3 — not sent'),
  );
});
test('Stop all and a superseding user message discard held instructions visibly', async (t) => {
  for (const action of ['interrupt', 'send']) {
    const b = await start(t, [{ agent: 'Lead', match: 'mixed request', reply: ask() }]);
    await b.api('send', { text: 'mixed request' });
    const s = await card(b);
    await b.api(action, action === 'send' ? { text: 'new objective' } : {});
    await b.waitFor((e) => e.kind === 'system' && e.text.includes('Discarded pending question delegations'));
    assert.equal(work(b).length, 0);
    await assert.rejects(decide(b, s, 'sendDelegations'));
  }
});
test('a correction stays tied to the worker delegation active when the question was asked', async (t) => {
  const b = await start(t, [
    { agent: 'Lead', match: 'launch fixture', reply: '@Dev first assignment' },
    { agent: 'Lead', match: 'ask update', reply: '@Dev correction\n' + question },
    { agent: 'Dev', match: 'first assignment', reply: 'original done', waitForFile: 'release' },
  ]);
  await b.api('send', { text: 'launch fixture' });
  await b.waitFor((e) => e.kind === 'taskStarted' && e.agent === 'a2');
  await b.api('send', { text: 'ask update' });
  const s = await card(b);
  assert.ok(s.taskPlan.pending.delegation.targets[0].updateOf);
  await decide(b, s, 'sendDelegations');
  const queued = await b.waitFor((e) => e.kind === 'taskQueued' && e.updateOf);
  assert.equal(queued.updateOf, s.taskPlan.pending.delegation.targets[0].updateOf);
  fs.writeFileSync(path.join(b.work, 'release'), 'ok');
});
test('Architect notes are routed to the coordinator with the decision, including revision and invalid submissions', async (t) => {
  for (const action of ['approve', 'revise', 'invalid']) {
    const docs = [{ path: 'docs/spec/fixture.md', text: 'Scope' }];
    const b = await start(t, [
      { agent: 'Lead', match: 'Architect.s notes with the specification', reply: 'coordinator received notes' },
      { agent: 'Lead', match: 'request draft', reply: '[[SIZE: large]]\nAPI\n[[/SIZE]]\n@Design prepare a specification' },
      {
        agent: 'Design',
        match: 'prepare a specification',
        reply: '@Dev remains a proposed owner.\n[[SPEC]]\n' + (action === 'invalid' ? 'invalid' : JSON.stringify(docs)) + '\n[[/SPEC]]',
      },
    ]);
    await b.api('send', { text: 'request draft' });
    if (action !== 'invalid') {
      const s = await b.waitFor((e) => e.kind === 'state' && e.taskPlan?.pending?.kind === 'spec');
      assert.equal(s.taskPlan.pending.delegation, undefined);
      assert.match(s.taskPlan.pending.notes, /@a2/);
      await decide(b, s, action, action === 'approve' ? { docs } : { feedback: 'Clarify scope' });
    }
    await b.waitFor((e) => e.kind === 'turnEnd' && e.text === 'coordinator received notes');
    assert.equal(work(b).length, 0);
  }
});
