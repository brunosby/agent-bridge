import test from 'node:test';
import assert from 'node:assert/strict';
import { writeFileSync } from 'node:fs';
import path from 'node:path';
import { startBridge } from './helpers/bridge.mjs';
import { addBatchPart, finishBatchPart } from '../src/server/batch.ts';
import { OpenCodeAgent } from '../src/providers/opencode.ts';
import { ClaudeAgent } from '../src/providers/claude.ts';
const team = [
  { driver: 'fake', role: 'orchestrator', name: 'Lead' },
  { driver: 'fake', role: 'coder', name: 'Dev' },
  { driver: 'fake', role: 'researcher', name: 'Research' },
];
const ready = (b) => b.waitFor((e) => e.kind === 'state' && e.team.length === 3 && e.team.every((a) => a.status.availability === 'ready'));
const active = (b, id) => b.waitFor((e) => e.kind === 'state' && e.tasks.some((t) => t.agent === id && t.turnId));
const run = async (t, opts) => {
  const b = await startBridge({ team, rules: [], settings: { finalConfirmation: false }, ...opts });
  t.after(() => b.stop());
  await ready(b);
  return b;
};
test('two updates leave one worker result with the original request even when completions arrive out of order', () => {
  const owner = {};
  const root = addBatchPart(owner, 'dev', undefined, 1);
  const b = addBatchPart(owner, 'dev', root, 2);
  const c = addBatchPart(owner, 'dev', root, 3);
  assert.equal(finishBatchPart(owner, 'dev', c, 'latest'), undefined);
  assert.equal(finishBatchPart(owner, 'dev', root, 'first'), undefined);
  assert.deepEqual(
    finishBatchPart(owner, 'dev', b, 'middle').results.map((r) => [r.text, r.requestSeq]),
    [['latest', 1]],
  );
});
test('busy-only and mixed delegations reach workers, count hops and return the updated result', async (t) => {
  const b = await run(t, {
    rules: [
      { agent: 'Lead', match: 'launch job', reply: '@Dev original delegation' },
      { agent: 'Lead', match: 'update both', reply: '@Dev @Research mixed correction' },
      { agent: 'Lead', match: 'update one', reply: '@Dev latest correction' },
      { agent: 'Dev', match: 'original delegation', waitForFile: 'release', reply: 'original result' },
      { agent: 'Dev', match: 'latest correction', reply: 'latest result' },
      { agent: 'Lead', match: 'latest result', reply: 'received final result\n[[DONE]]' },
    ],
  });
  await b.api('send', { text: 'launch job' });
  await active(b, 'a2');
  await b.api('send', { text: 'update both' });
  await b.waitFor((e) => e.kind === 'taskQueued' && e.agent === 'a3');
  await b.api('send', { text: 'update one' });
  await b.waitFor((e) => e.kind === 'text' && e.agent === 'a2' && e.text === 'latest result');
  writeFileSync(path.join(b.work, 'release'), 'ok');
  await b.waitFor((e) => e.kind === 'text' && e.agent === 'a1' && e.text.startsWith('received final result'));
  assert.equal(b.events.filter((e) => e.kind === 'batchCompleted').length, 1);
  assert.equal(b.events.filter((e) => e.kind === 'taskQueued' && e.agent === 'a2' && e.updateOf).length, 2);
  assert.ok(b.events.some((e) => e.kind === 'routed' && e.to === 'a3' && e.hop === 2));
});
test('Resume offers the user a choice when the delegated task has already finished', async (t) => {
  const b = await run(t, {
    rules: [
      { agent: 'Lead', match: 'launch job', reply: '@Dev original delegation' },
      { agent: 'Lead', match: 'please update', waitForFile: 'send-update', reply: '@Dev correction' },
      { agent: 'Dev', match: 'original delegation', waitForFile: 'finish', reply: 'original result' },
      { agent: 'Dev', match: 'correction', reply: 'correction delivered' },
    ],
  });
  await b.api('send', { text: 'launch job' });
  await active(b, 'a2');
  await b.api('send', { text: 'please update' });
  await b.api('relay', { pause: true });
  writeFileSync(path.join(b.work, 'send-update'), 'ok');
  await b.waitFor((e) => e.kind === 'system' && e.text.includes('waiting for Resume') && e.text.includes('to @a2'));
  writeFileSync(path.join(b.work, 'finish'), 'ok');
  await b.waitFor((e) => e.kind === 'batchCompleted');
  await b.api('relay', { resume: true });
  const state = await b.waitFor((e) => e.kind === 'state' && e.staleUpdates?.length);
  assert.equal(b.events.filter((e) => e.kind === 'taskQueued' && e.agent === 'a2').length, 1);
  const body = { conversationId: state.conversationId, key: state.staleUpdates[0].key, action: 'send' };
  await b.api('resolveUpdate', body);
  await b.waitFor((e) => e.kind === 'text' && e.text === 'correction delivered');
  await assert.rejects(b.api('resolveUpdate', body), /no longer pending/);
});
test('interrupt and send pins the confirmed turn and conversation, and records cancellation before delivery', async (t) => {
  const b = await run(t, {
    rules: [
      { agent: 'Dev', match: 'long job', waitForFile: 'never', reply: 'old result' },
      { agent: 'Dev', match: 'replacement', reply: 'new result' },
    ],
  });
  await b.api('send', { text: 'long job', target: 'a2' });
  const state = await active(b, 'a2');
  const { turnId } = state.tasks.find((x) => x.agent === 'a2');
  const body = { text: 'replacement', target: 'a2', conversationId: state.conversationId, interrupt: { agent: 'a2', turnId } };
  await assert.rejects(b.api('send', { ...body, conversationId: 'other' }), /conversation changed/i);
  await assert.rejects(b.api('send', { ...body, interrupt: { agent: 'a2', turnId: 'finished' } }), /already finished/);
  await b.api('send', body);
  await b.waitFor((e) => e.kind === 'text' && e.text === 'new result');
  const cancelled = b.events.find((e) => e.kind === 'tasksCancelled' && e.interrupted);
  const sent = b.events.find((e) => e.kind === 'user' && e.text === 'replacement');
  assert.ok(cancelled.seq < sent.seq);
  await assert.rejects(b.api('send', body), /already finished/);
});
test('reorder validates ownership, preserves the acting coordinator and persists for restore and templates', async (t) => {
  const b = await run(t, {
    team: team.map((a) => ({ ...a, role: 'coder' })),
    rules: [
      { agent: 'Lead', match: 'launch job', reply: '@Dev long job' },
      { agent: 'Dev', match: 'long job', waitForFile: 'finish', reply: 'result' },
    ],
  });
  const { conversationId } = b.state();
  const order = ['a2', 'a3', 'a1'];
  const reorder = (ids, conv = conversationId) => b.api('reorder', { conversationId: conv, order: ids });
  for (const invalid of [['a1'], ['a1', 'a1', 'a3'], ['a1', 'a2', 'absent']]) await assert.rejects(reorder(invalid), /membership/);
  await assert.rejects(reorder(order, 'old'), /conversation changed/i);
  await b.api('send', { text: 'launch job' });
  await active(b, 'a2');
  await assert.rejects(reorder(order), /coordinates/);
  await reorder(['a1', 'a3', 'a2']);
  writeFileSync(path.join(b.work, 'finish'), 'ok');
  await b.waitFor((e) => e.kind === 'system' && e.text.includes('replied to you'));
  await reorder(order);
  assert.deepEqual(
    (await b.api('manageTeam', { operation: 'save', name: 'Reordered' })).teams[0].members.map((m) => m.name),
    ['Dev', 'Research', 'Lead'],
  );
  for (const mode of ['pipeline', 'roundrobin']) {
    await b.api('routing', { mode });
    assert.equal((await b.api('previewTarget', { target: 'auto' })).targets[0].id, 'a2');
    await b.api('send', { text: mode });
    await b.waitFor((e) => e.kind === 'routed' && e.from === 'a2' && e.to === 'a3');
    await b.api('interrupt', {});
  }
  await b.api('new', { workDir: b.work });
  await b.api('restore', { id: conversationId });
  assert.deepEqual(
    (await b.api('previewTarget', { target: 'all' })).targets.map((a) => a.id),
    order,
  );
});
test('a missing OpenAPI uses the local queue and an expired live session is recovered without resending', async (t) => {
  const agent = new OpenCodeAgent({ cwd: '.', config: {} });
  agent.sessionId = 'lost';
  agent.base = 'http://fixture.invalid';
  agent.start = async () => {};
  let spec = null;
  const calls = [];
  t.mock.method(globalThis, 'fetch', async (url, init) => {
    const pathname = new URL(url).pathname;
    calls.push([init.method, pathname]);
    if (pathname === '/doc') {
      if (!spec) throw Error('unavailable');
      return Response.json(spec);
    }
    if (pathname === '/session' && init.method === 'POST') return Response.json({ id: 'new-session' });
    return Response.json({ error: 'SessionNotFoundError' }, { status: 404 });
  });
  assert.equal(await agent.supportsLiveInputs(), false);
  spec = { paths: {} };
  assert.equal(await agent.supportsLiveInputs(), false);
  const post = (properties) => ({ post: { requestBody: { content: { 'application/json': { schema: { properties } } } } } });
  spec.paths['/api/session/{sessionID}/prompt'] = post({ delivery: { enum: ['queue', 'steer'] } });
  spec.paths['/session/{sessionID}/message'] = post({ messageID: { type: 'string' } });
  agent.liveInputs = await agent.supportsLiveInputs();
  assert.equal(agent.liveInputs, true);
  agent.queue.push({ text: 'lost', taskId: 'test' });
  await agent.pump();
  assert.equal(agent.sessionId, 'new-session');
  assert.equal(agent.liveInputs, true);
  assert.equal(calls.filter(([m, p]) => m === 'POST' && p.endsWith('/message')).length, 1);
  assert.ok(calls.some(([m, p]) => m === 'GET' && p === '/session/lost'));
});

test('an interrupt acknowledgement alone cannot release the replacement message', async (t) => {
  const { EventEmitter } = await import('node:events');
  const { interruptConfirmed } = await import('../src/server/interrupt-send.ts');
  const { S } = await import('../src/server/state.ts');
  const agent = new EventEmitter();
  agent.interruptTurn = async () => {};
  const saved = S.conv;
  const owner = (S.conv = { agents: { a1: agent }, tasks: new Map([['id', { id: 'id', agent: 'a1', turnId: 'turn' }]]) });
  t.after(() => {
    S.conv = saved;
  });
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const waiting = interruptConfirmed(owner, { agent: 'a1', turnId: 'turn' });
  agent.emit('event', { kind: 'turnEnd', turnId: 'other', taskIds: ['other'] });
  t.mock.timers.tick(15000);
  await assert.rejects(waiting, /Timed out/);
  assert.equal(agent.listenerCount('event'), 0);
});

test('Claude interrupts with a control request in the existing session', async () => {
  const a = new ClaudeAgent({ cwd: '.', config: {} });
  const sent = [];
  a.proc = { write: (msg) => sent.push(msg) };
  a.activeBatch = { uuid: 'running', taskIds: ['work'] };
  await assert.rejects(a.interruptTurn('old'));
  await a.interruptTurn('running');
  assert.equal(sent[0].type, 'control_request');
  assert.equal(sent[0].request.subtype, 'interrupt');
});
test('OpenCode confirms updates against their own message and emits one final answer for coalesced requests', async () => {
  const agent = new OpenCodeAgent({ cwd: '.', config: { model: 'local/test' }, instructions: 'role', readOnly: true });
  agent.liveInputs = true;
  agent.sessionId = 'session';
  agent.start = async () => {};
  const posts = [],
    events = [];
  agent.on('event', (e) => events.push(e));
  agent.http = (method, path, body) => new Promise((resolve, reject) => posts.push({ method, path, body, resolve, reject }));
  await agent.send('original', 'one');
  await agent.send('correction', 'two');
  assert.equal(posts.length, 1);
  const update = (role, info) => agent.onEvent({ type: 'message.updated', properties: { info: { sessionID: 'session', role, ...info } } });
  update('user', { id: posts[0].body.messageID });
  assert.equal(posts.length, 2);
  assert.equal(posts[1].body.agent, 'plan');
  assert.equal(posts[1].body.system, 'role');
  assert.equal(posts[1].body.model.modelID, 'test');
  assert.equal(events.filter((e) => e.kind === 'taskStarted').length, 1);
  update('assistant', { id: 'answer', parentID: posts[1].body.messageID });
  assert.deepEqual(
    events.filter((e) => e.kind === 'taskStarted').map((e) => e.turnId),
    ['one', 'one'],
  );
  const answer = { info: { id: 'answer' }, parts: [{ id: 'p', type: 'text', text: 'done' }] };
  posts[1].resolve(answer);
  posts[0].resolve(answer);
  await new Promise((r) => setImmediate(r));
  assert.deepEqual(
    events.filter((e) => e.kind === 'turnEnd').map((e) => e.taskIds),
    [['one', 'two']],
  );
  await agent.send('ambiguous', 'third');
  posts.at(-1).reject(new Error('timeout'));
  await new Promise((r) => setImmediate(r));
  assert.equal(posts.length, 3);
  assert.ok(events.some((e) => e.kind === 'inputUnconfirmed' && e.taskIds.includes('third')));
});
