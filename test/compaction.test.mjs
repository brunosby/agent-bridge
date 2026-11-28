import test from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { startBridge } from './helpers/bridge.mjs';
import { ClaudeAgent } from '../src/providers/claude.ts';
import { CodexAgent } from '../src/providers/codex.ts';
import { OpenCodeAgent } from '../src/providers/opencode.ts';

test('Claude uses the compact boundary and waits for result without routing an internal turn', async () => {
  const a = new ClaudeAgent({ cwd: '.', config: {} });
  const sent = [],
    events = [];
  a.proc = { write: (m) => sent.push(m) };
  a.on('event', (e) => events.push(e));
  const signal = new AbortController();
  const result = a.compact('keep decisions', signal.signal);
  assert.equal(sent[0].message.content, '/compact keep decisions');
  a.handle({ type: 'assistant', message: { content: [{ type: 'text', text: 'internal' }] } });
  a.handle({ type: 'system', subtype: 'compact_boundary', compact_metadata: { pre_tokens: 23000 } });
  assert.equal(a.busy, true);
  signal.abort();
  assert.equal(sent[1].request.subtype, 'interrupt');
  a.handle({ type: 'result', subtype: 'success', usage: { input_tokens: 15 } });
  assert.deepEqual(await result, { compacted: true, before: 23000 });
  assert.equal(a.tokens, 15);
  const noop = a.compact('keep decisions', new AbortController().signal);
  a.handle({ type: 'result', subtype: 'success' });
  assert.equal((await noop).compacted, false);
  assert.ok(!events.some((e) => ['turnEnd', 'text', 'tasksCancelled', 'inputAccepted'].includes(e.kind)));
  a.handle({ type: 'assistant', message: { usage: { input_tokens: 20, cache_read_input_tokens: 60, cache_creation_input_tokens: 3 } } });
  a.handle({ type: 'result', subtype: 'success', usage: { input_tokens: 500 } });
  assert.equal(a.contextTokens, 83);
});

test('Codex waits for both the compaction item and the terminal event of its own thread and turn', async () => {
  const a = new CodexAgent({ cwd: '.', config: {} });
  const calls = [],
    events = [];
  a.threadId = 'thread';
  a.request = async (method, params) => {
    calls.push([method, params]);
    return {};
  };
  a.on('event', (e) => events.push(e));
  const ctrl = new AbortController();
  const work = a.compact('', ctrl.signal);
  assert.deepEqual(calls[0], ['thread/compact/start', { threadId: 'thread' }]);
  const note = (method, p) => a.handleNotification(method, { threadId: 'thread', ...p });
  note('turn/started', { turn: { id: 'compact' } });
  note('item/completed', { turnId: 'compact', item: { type: 'contextCompaction' } });
  note('turn/completed', { threadId: 'other', turn: { id: 'compact', status: 'completed' } });
  note('turn/completed', { turn: { id: 'old', status: 'completed' } });
  assert.equal(a.busy, true);
  ctrl.abort();
  assert.deepEqual(calls[1], ['turn/interrupt', { threadId: 'thread', turnId: 'compact' }]);
  note('turn/completed', { turn: { id: 'compact', status: 'completed' } });
  assert.equal((await work).compacted, true);
  assert.ok(!events.some((e) => e.kind === 'turnEnd'));
  note('thread/tokenUsage/updated', { tokenUsage: { last: { inputTokens: 51 }, total: { totalTokens: 7000 } } });
  assert.equal(a.contextTokens, 51);
  assert.equal(a.tokens, 7000);
});

test('OpenCode detects the summarize route, preserves the model and waits for the HTTP result after abort', async () => {
  const a = new OpenCodeAgent({ cwd: '.', config: { model: 'p/m/sub' } });
  a.sessionId = 's';
  const events = [],
    calls = [];
  a.on('event', (e) => events.push(e));
  assert.equal(a.compact, undefined);
  const properties = { providerID: {}, modelID: {} };
  const requestBody = { content: { 'application/json': { schema: { properties } } } };
  a.http = async () => ({ paths: { '/session/{sessionID}/summarize': { post: { requestBody } } } });
  await a.supportsLiveInputs();
  let finish;
  a.http = async (method, url, body) => {
    calls.push([method, url, body]);
    if (url.endsWith('/summarize')) return new Promise((resolve) => (finish = resolve));
    return true;
  };
  const signal = new AbortController();
  const work = a.compact('', signal.signal);
  assert.deepEqual(calls[0], ['POST', '/session/s/summarize', { providerID: 'p', modelID: 'm/sub' }]);
  signal.abort();
  assert.equal(calls[1][1], '/session/s/abort');
  assert.equal(a.busy, true);
  a.onEvent({ type: 'message.part.updated', properties: { part: { sessionID: 's', type: 'text', text: 'internal' } } });
  finish(true);
  assert.equal((await work).compacted, true);
  assert.equal(events.length, 0);
  a.reportAnswer({ info: { tokens: { input: 3, output: 9, cache: { read: 12, write: 4 } } } }, []);
  assert.equal(a.contextTokens, 19);
});

test('pending work blocks manual and automatic compaction until a later idle break', async (t) => {
  const { S } = await import('../src/server/state.ts');
  const { canCompact, startCompaction } = await import('../src/server/compaction.ts');
  const { startAndWait } = await import('../src/server/agent-lifecycle.ts');
  const { userSend } = await import('../src/server/routing.ts');
  const { FakeAgent } = await import('../src/providers/fake.ts');
  const agent = new FakeAgent({ id: 'a1', cwd: '.' });
  agent.compact = async () => {
    throw new Error('Unexpected provider invocation');
  };
  const previous = S.conv;
  const owner = (S.conv = {
    agents: { a1: agent },
    team: [{ id: 'a1', role: 'orchestrator' }],
    tasks: new Map(),
    providerChanges: new Set(),
    heldRelays: [],
    relay: {},
    routingMode: 'orchestrator',
  });
  t.after(() => {
    S.conv = previous;
  });
  await startAndWait(
    agent,
    () => agent.start(),
    () => {},
  );
  assert.equal(canCompact(owner, agent), true);
  for (const [key, value] of [
    ['heldRelays', [{ targets: ['a1'], from: 'a2' }]],
    ['batch', { pending: new Map([['a1', { id: 'task' }]]) }],
    ['pendingFinal', 'final'],
    ['tasks', new Map([['task', { id: 'task', agent: 'a1' }]])],
  ]) {
    const saved = owner[key];
    owner[key] = value;
    assert.throws(() => startCompaction(owner, agent), /pending/);
    owner[key] = saved;
  }
  const request = userSend('A new message');
  assert.equal(canCompact(owner, agent), false);
  S.conv = previous;
  await assert.rejects(request, /conversation changed/);
});

const team = [
  { name: 'Lead', role: 'orchestrator', driver: 'fake' },
  { name: 'Dev', role: 'coder', driver: 'fake' },
];
async function setup(t, rules = [], settings = {}) {
  const b = await startBridge({ team, rules, settings, preload: new URL('./helpers/compaction-fixture.mjs', import.meta.url) });
  t.after(() => b.stop());
  const state = await b.waitFor((e) => e.kind === 'state' && e.team.length === 2 && e.team.every((a) => a.available));
  const manual = (agent = 'a1') => b.api('compactContext', { agent, conversationId: state.conversationId });
  const command = async (op, value, id) => {
    const ack = once(b.child, 'message');
    b.child.send({ op, value, id });
    assert.equal((await ack)[0].ack, op);
  };
  return { b, manual, command };
}
const starts = (b) => b.events.filter((e) => e.kind === 'system' && /^Compacting /.test(e.text));
const queued = (b) => b.events.filter((e) => e.kind === 'taskQueued');

test('automatic compaction runs once at an approved or file-free completion, and skips a revision or disabled setting', async (t) => {
  for (const scenario of ['approve', 'unchanged', 'no confirmation', 'changes', 'disabled']) {
    const confirmation = !['no confirmation', 'disabled'].includes(scenario);
    const changed = ['approve', 'changes'].includes(scenario);
    const { b, manual, command } = await setup(t, [{ agent: 'Lead', reply: 'Finished.\n[[DONE]]', edit: changed }], {
      finalConfirmation: confirmation,
      compactCoordinatorAfterResult: scenario !== 'disabled',
    });
    await b.api('send', { text: 'finish the task' });
    if (changed) {
      const card = await b.waitFor((e) => e.kind === 'finalReview');
      await assert.rejects(manual(), /pending/);
      await b.api('finalReview', { requestId: card.requestId, action: scenario });
    }
    const last = await b.waitFor(
      (e) => e.kind === 'system' && /approved the result|asked for changes|nothing to approve|marked the work as done/i.test(e.text),
    );
    if (['changes', 'disabled'].includes(scenario)) {
      await b.api('catalog');
      await b.waitFor((e) => e.kind === 'state' && e.seq > last.seq);
      assert.equal(starts(b).length, 0);
    } else {
      await b.waitFor((e) => e.kind === 'info' && /Fixture compact: Keep the user's goals/.test(e.text));
      await command('finish');
      await b.waitFor((e) => e.kind === 'system' && /Compacted @a1/.test(e.text));
      assert.equal(starts(b).length, 1);
      assert.equal(queued(b).length, 1);
      assert.equal(b.events.filter((e) => e.kind === 'turnEnd').length, 1);
      assert.equal(b.state().relay.hops, 0);
    }
  }
});

test('held user, delegation and batch messages are released once in order on success or failure', async (t) => {
  for (const op of ['finish', 'fail']) {
    const { b, manual, command } = await setup(t);
    await manual();
    await assert.rejects(manual(), /idle/);
    await b.api('send', { target: 'a1', text: 'first user message' });
    await command('relay', 'second delegation');
    await command('relay', 'third batch result');
    assert.equal(queued(b).length, 0);
    await command(op, 1000); // The next input can be larger than the compacted history.
    await b.waitFor((e) => e.kind === 'taskQueued' && e.description.includes('third batch'));
    assert.deepEqual(
      queued(b).map((e) => e.description),
      ['first user message', 'second delegation', 'third batch result'],
    );
    await b.waitFor((e) =>
      op === 'fail'
        ? e.kind === 'error' && /fixture failure/.test(e.text)
        : e.kind === 'system' && e.text === "@a1's next call used 18K tokens.",
    );
    assert.equal(starts(b).length, 1);
  }
});

test('Stop drops all held work or waits for only the selected agent to finish', async (t) => {
  for (const stopAll of [true, false]) {
    const { b, manual, command } = await setup(t);
    await manual('a2');
    await b.api('send', { target: 'a2', text: 'held user message' });
    await b.api('interrupt', stopAll ? {} : { agent: 'a2' });
    await b.waitFor((e) => e.kind === 'info' && e.text === 'Fixture interrupt requested');
    assert.equal(queued(b).length, 0);
    await command('finish', null, 'a2');
    await b.waitFor((e) => e.kind === 'system' && e.text === 'Compaction of @a2 was stopped.');
    if (stopAll) await b.waitFor((e) => e.kind === 'system' && /discarded 1 queued deliver.*@a2/.test(e.text));
    else await b.waitFor((e) => e.kind === 'taskQueued');
    assert.equal(queued(b).filter((e) => e.agent === 'a2' && e.description === 'held user message').length, stopAll ? 0 : 1);
  }
});

test('a real delegation waits through recovery and its result returns to the coordinator', async (t) => {
  const { b, manual, command } = await setup(
    t,
    [
      { agent: 'Lead', match: 'ask the developer', reply: '@Dev report findings' },
      { agent: 'Dev', reply: 'worker finished' },
      { agent: 'Lead', match: 'worker finished', reply: 'Final result.\n[[DONE]]' },
    ],
    { compactCoordinatorAfterResult: false, finalConfirmation: false },
  );
  await command('clock');
  await manual('a2');
  await command('tick', 300000);
  await command('tick', 30000);
  await b.waitFor((e) => e.kind === 'state' && e.team[1].unavailableReason === 'Compaction did not stop');
  await command('realClock');
  await b.api('send', { text: 'ask the developer', target: 'a1' });
  await b.waitFor((e) => e.kind === 'state' && e.pendingWork.some((w) => w.reason === 'Waiting for Dev'));
  assert.equal(queued(b).filter((e) => e.agent === 'a2').length, 0);
  await command('finish', null, 'a2');
  await b.api('retry', { agent: 'a2' });
  await b.waitFor((e) => e.kind === 'turnEnd' && e.agent === 'a1' && e.text.includes('Final result'));
  assert.equal(queued(b).filter((e) => e.agent === 'a2').length, 1);
  assert.equal(b.events.filter((e) => e.kind === 'batchCompleted').length, 1);
});

test('the deadline requests interruption; an unconfirmed interruption holds work through Retry', async (t) => {
  for (const confirm of [true, false]) {
    const { b, manual, command } = await setup(t);
    await command('clock');
    await manual('a2');
    await b.api('send', { target: 'a2', text: 'deliver once' });
    await command('tick', 300000);
    await b.waitFor((e) => e.kind === 'info' && e.text === 'Fixture interrupt requested');
    assert.equal(queued(b).length, 0);
    if (confirm) {
      await command('finish', null, 'a2');
      await b.waitFor((e) => e.kind === 'system' && /timed out and was interrupted/.test(e.text));
    } else {
      await command('tick', 30000);
      await b.waitFor((e) => e.kind === 'state' && e.team[1].unavailableReason === 'Compaction did not stop');
      await command('finish', null, 'a2');
      assert.equal(queued(b).length, 0);
      await b.api('retry', { agent: 'a2' });
    }
    await b.waitFor((e) => e.kind === 'taskQueued' && e.description === 'deliver once');
    assert.equal(queued(b).filter((e) => e.agent === 'a2' && e.description === 'deliver once').length, 1);
    await command('realClock');
  }
});
