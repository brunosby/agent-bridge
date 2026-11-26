import test from 'node:test';
import assert from 'node:assert/strict';
import { hopBudget, hopCost } from '../src/core/relay-limit.ts';
import { startBridge } from './helpers/bridge.mjs';

const team = [
  { driver: 'fake', role: 'orchestrator', name: 'Lead' },
  { driver: 'fake', role: 'researcher', name: 'Research' },
];
const classify = (size) => '[[SIZE: ' + size + ']]\nScope of the request\n[[/SIZE]]\n';

for (const [size, limit] of [
  ['small', 8],
  ['medium', 16],
  ['large', 32],
  [null, 8],
]) {
  test('orchestrator pauses on delegation ' + (limit + 1) + ' for ' + (size ?? 'unclassified') + ' work', async (t) => {
    const b = await startBridge({
      team,
      rules: [
        { agent: 'Lead', match: 'start the loop', reply: (size ? classify(size) : '') + '@a2 inspect' },
        { agent: 'Research', reply: 'Inspection ready' },
        { agent: 'Lead', reply: '@a2 inspect again' },
      ],
    });
    t.after(() => b.stop());
    await b.api('send', { text: 'start the loop' });
    const state = await b.waitFor((e) => e.kind === 'state' && e.relay.limitPause === 'hops' && e.relay.held === 1, 15000);
    assert.equal(state.relay.hops, limit);
    assert.equal(state.relay.effectiveMaxHops, limit);
    assert.equal(state.relay.maxHops, 8);
    const routes = b.events.filter((e) => e.kind === 'routed');
    assert.equal(routes.filter((e) => e.to === 'a1').length, limit);
    assert.equal(routes.filter((e) => e.to === 'a2').length, limit);
    const pause = b.events.find((e) => e.kind === 'system' && e.text.startsWith('Relay paused after'));
    assert.ok(pause.text.includes('limit ' + limit));
    assert.ok(pause.text.includes('base 8'));
    if (size) assert.ok(pause.text.includes(size + ' task'));
  });
}

test('an automatic Architect delegation observes the same budget and can resume', async (t) => {
  const b = await startBridge({
    team: [...team, { driver: 'fake', role: 'coder', name: 'Dev' }, { driver: 'fake', role: 'architect', name: 'Design' }],
    settings: { maxHops: 1 },
    rules: [
      { agent: 'Lead', match: 'start', reply: classify('large') + '@a2 investigate' },
      { agent: 'Research', reply: 'pass {n}' },
      { agent: 'Lead', match: 'pass 4', reply: '@a3 implement' },
      { agent: 'Lead', reply: '@a2 inspect again' },
      { agent: 'Design', reply: '[[SPEC]]\n[{"path":"docs/spec/task.md","text":"Draft"}]\n[[/SPEC]]' },
    ],
  });
  t.after(() => b.stop());
  await b.api('send', { text: 'start' });
  await b.waitFor((e) => e.kind === 'state' && e.relay.hops === 4 && e.relay.held === 1);
  assert.equal(
    b.events.some((e) => e.kind === 'routed' && e.to === 'a4'),
    false,
  );
  await b.api('relay', { resume: true });
  const state = await b.waitFor((e) => e.kind === 'state' && e.taskPlan?.pending?.kind === 'spec');
  assert.equal(state.relay.hops, 1);
  assert.equal(b.events.filter((e) => e.kind === 'routed' && e.to === 'a4').length, 1);
});

for (const [scenario, reply] of [
  ['milestones', '[[MILESTONES]]\n1. Data | done when: model tests pass\n2. API | done when: API tests pass\n[[/MILESTONES]]'],
  ['Architect mention', '@Design draft the specification'],
  ['Coder mention', '@Dev implement the feature'],
]) {
  test('manual mode offers an explicit specification request for ' + scenario, async (t) => {
    const options = {
      team: [team[0], { driver: 'fake', role: 'architect', name: 'Design' }, { driver: 'fake', role: 'coder', name: 'Dev' }],
      settings: { autoRelay: false },
      rules: [
        { agent: 'Lead', reply: classify('large') + reply },
        { agent: 'Design', match: 'Original requirements', reply: '[[SPEC]]\n[{"path":"docs/spec/task.md","text":"Draft"}]\n[[/SPEC]]' },
      ],
    };
    let b = await startBridge(options);
    t.after(() => b.stop());
    await b.api('send', { text: 'Original requirements' });
    const state = await b.waitFor(
      (e) =>
        e.kind === 'state' && e.team[0].tokens >= 100 && !e.team[0].busy && e.progress.at(-1)?.waiting?.action === 'Request specification',
    );
    assert.ok(b.events.some((e) => e.kind === 'system' && e.text.includes('Manual mode') && e.text.includes('Request specification')));
    assert.equal(
      b.events.some((e) => e.kind === 'taskQueued' && e.agent !== 'a1'),
      false,
    );
    if (scenario === 'milestones') {
      await b.stop();
      b = await startBridge({ ...options, dir: b.root, resume: state.conversationId });
      await b.waitFor(
        (e) => e.kind === 'state' && e.team.every((a) => a.available) && e.progress.at(-1)?.waiting?.action === 'Request specification',
      );
    }
    const body = { action: 'retrySpec', conversationId: state.conversationId, seq: state.taskPlan.seq };
    await b.api('taskDecision', body);
    const draft = await b.waitFor((e) => e.kind === 'state' && e.taskPlan?.pending?.kind === 'spec');
    assert.equal(draft.relay.auto, false);
    assert.equal(draft.relay.hops, 0);
    assert.equal(b.events.filter((e) => e.kind === 'taskQueued' && e.agent === 'a2').length, 1);
    await assert.rejects(b.api('taskDecision', body));
  });
}

test('a two-agent mentions loop pauses at the base limit', async (t) => {
  const b = await startBridge({
    team,
    settings: { routingMode: 'mentions', maxHops: 2 },
    rules: [
      { agent: 'Lead', reply: '@a2 inspect' },
      { agent: 'Research', reply: '@a1 review' },
    ],
  });
  t.after(() => b.stop());
  await b.api('send', { target: 'a1', text: 'start' });
  await b.waitFor((e) => e.kind === 'state' && e.relay.limitPause === 'hops' && e.relay.held === 1);
  assert.deepEqual(
    b.events.filter((e) => e.kind === 'routed').map((e) => [e.to, e.hop]),
    [
      ['a2', 1],
      ['a1', 2],
    ],
  );
});

test('changing size on the original request preserves its used budget', async (t) => {
  const b = await startBridge({
    team,
    rules: [
      { agent: 'Lead', match: 'start', reply: classify('medium') + '@a2 inspect' },
      { agent: 'Research', reply: 'inspection complete' },
      { agent: 'Lead', reply: 'Ready.' },
    ],
  });
  t.after(() => b.stop());
  await b.api('send', { text: 'start' });
  const previous = await b.waitFor(
    (e) => e.kind === 'state' && e.relay.hops === 1 && e.relay.effectiveMaxHops === 16 && e.team[0].tokens >= 200,
  );
  await b.api('taskDecision', { action: 'size', size: 'large', seq: previous.taskPlan.seq, conversationId: previous.conversationId });
  await b.waitFor((e) => e.kind === 'state' && e.relay.hops === 1 && e.relay.effectiveMaxHops === 32);
});

test('return to Lead with a zero budget is held even when its hop cost is zero', async (t) => {
  const b = await startBridge({ team, settings: { maxHops: 0 }, rules: [{ agent: 'Research', reply: 'Research result' }] });
  t.after(() => b.stop());
  await b.api('send', { target: 'a2', text: 'inspect' });
  await b.waitFor((e) => e.kind === 'state' && e.relay.limitPause === 'hops' && e.relay.held === 1);
  assert.equal(
    b.events.some((e) => e.kind === 'routed'),
    false,
  );
  for (const size of ['small', 'medium', 'large']) assert.equal(hopBudget('orchestrator', 0, { classified: true, size }).limit, 0);
});

test('unavailable destinations can prompt Lead once without spending a hop', async (t) => {
  const b = await startBridge({ team: [team[0], { ...team[1], role: 'obsolete' }], rules: [{ agent: 'Lead', reply: '@a2 inspect' }] });
  t.after(() => b.stop());
  await b.api('send', { text: 'start' });
  const state = await b.waitFor((e) => e.kind === 'state' && e.team[0].tokens >= 200 && !e.team[0].busy);
  assert.equal(state.relay.hops, 0);
  assert.equal(b.events.filter((e) => e.kind === 'taskQueued' && e.agent === 'a1').length, 2);
});

test('other routing modes charge both directions and use the base budget', () => {
  for (const mode of ['mentions', 'pipeline', 'roundrobin']) {
    assert.equal(hopBudget(mode, 8, { size: 'large', classified: true }).limit, 8);
    assert.equal(hopCost(mode, 'a1', 'a1', 'a2'), 1);
    assert.equal(hopCost(mode, 'a1', 'a2', 'a1'), 1);
  }
});

test('manual mode from configuration shows a reason, skips forwarding, and can be turned off', async (t) => {
  const b = await startBridge({
    team,
    settings: { autoRelay: false },
    rules: [
      { agent: 'Lead', reply: '@a2 inspect' },
      { agent: 'Research', reply: 'ready' },
    ],
  });
  t.after(() => b.stop());
  await b.api('send', { text: 'inspect' });
  const manual = await b.waitFor((e) => e.kind === 'state' && e.team[0].tokens >= 100 && !e.team[0].busy);
  assert.ok(manual.progress.at(-1).reasons.some((w) => w.reason.includes('Manual mode')));
  assert.ok(b.events.some((e) => e.kind === 'text' && e.text.includes('@a2 inspect')));
  assert.equal(manual.relay.held, 0);
  assert.equal(
    b.events.some((e) => e.kind === 'routed'),
    false,
  );
  await b.api('settings', { autoRelay: true, maxHops: 1 });
  await b.waitFor(
    (e) =>
      e.kind === 'state' && e.seq > manual.seq && e.relay.auto && !e.progress.at(-1).reasons.some((w) => w.reason.includes('Manual mode')),
  );
  await b.api('send', { text: 'inspect again' });
  await b.waitFor((e) => e.kind === 'routed' && e.to === 'a2');
});
