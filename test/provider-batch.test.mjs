import test from 'node:test';
import assert from 'node:assert/strict';
import { ClaudeAgent } from '../src/providers/claude.ts';
import { CodexAgent } from '../src/providers/codex.ts';
import { OpenCodeAgent } from '../src/providers/opencode.ts';

const args = { cwd: '.', instructions: '', config: {} };

test('Claude sends immediately and completes only the inputs acknowledged before each result', () => {
  const agent = new ClaudeAgent(args);
  const sent = [];
  const events = [];
  agent.proc = { write: (event) => sent.push(event) };
  agent.on('event', (event) => events.push(event));
  const acknowledge = (input) => agent.handle({ type: 'user', uuid: input.uuid, message: { content: [] } });
  agent.send('First', 'a');
  acknowledge(sent[0]);
  agent.send('Second', 'b');
  agent.send('Third', 'c');
  assert.deepEqual(
    sent.map((event) => event.message.content),
    ['First', 'Second', 'Third'],
  );
  assert.equal(new Set(sent.map((event) => event.uuid)).size, 3);
  agent.handle({ type: 'result', result: 'First complete' });
  assert.deepEqual(events.find((event) => event.kind === 'turnEnd').taskIds, ['a']);
  assert.equal(agent.busy, true);
  acknowledge(sent[1]);
  acknowledge(sent[2]);
  agent.handle({ type: 'result', result: 'Batch complete' });
  assert.deepEqual(events.filter((event) => event.kind === 'turnEnd').at(-1).taskIds, ['b', 'c']);
  assert.equal(agent.busy, false);
});

test('Claude cancels unconfirmed task tracking rather than resending ambiguous input', () => {
  const agent = new ClaudeAgent(args);
  const sent = [];
  const events = [];
  agent.proc = { write: (event) => sent.push(event) };
  agent.on('event', (event) => events.push(event));
  agent.send('First', 'a');
  agent.handle({ type: 'result', result: 'Unknown origin' });
  assert.deepEqual(events.find((event) => event.kind === 'tasksCancelled').taskIds, ['a']);
  assert.equal(sent.length, 1);
  assert.equal(agent.busy, false);
});

const settle = () => new Promise((resolve) => setImmediate(resolve));

async function codexHarness() {
  const agent = new CodexAgent(args);
  const sent = [];
  const events = [];
  agent.threadId = 'thread';
  agent.start = async () => {};
  agent.proc = { write: (request) => sent.push(request) };
  agent.on('event', (event) => events.push(event));
  await agent.send('First', 'a');
  agent.handle({ id: sent[0].id, result: { turn: { id: 'turn-1' } } });
  await settle();
  return { agent, sent, events };
}

test('Codex associates an accepted steer with a completion received before its reply', async () => {
  const { agent, sent, events } = await codexHarness();
  await agent.send('Correction', 'b');
  assert.equal(sent[1].method, 'turn/steer');
  assert.equal(sent[1].params.expectedTurnId, 'turn-1');
  agent.handleNotification('turn/completed', { turn: { id: 'turn-1', status: 'completed' } });
  assert.equal(
    events.some((event) => event.kind === 'turnEnd'),
    false,
  );
  agent.handle({ id: sent[1].id, result: { turnId: 'turn-1' } });
  await settle();
  assert.deepEqual(events.find((event) => event.kind === 'turnEnd').taskIds, ['a', 'b']);
  assert.equal(agent.busy, false);
});

test('an explicit Codex steer rejection leaves the input for the next turn', async () => {
  const { agent, sent, events } = await codexHarness();
  await agent.send('Correction', 'b');
  agent.handle({ id: sent[1].id, error: { code: -32602, message: 'No active turn' } });
  await settle();
  assert.equal(sent.length, 2);
  agent.handleNotification('turn/completed', { turn: { id: 'turn-1', status: 'completed' } });
  assert.equal(sent[2].method, 'turn/start');
  agent.handle({ id: sent[2].id, result: { turn: { id: 'turn-2' } } });
  await settle();
  agent.handleNotification('turn/completed', { turn: { id: 'turn-2', status: 'completed' } });
  assert.deepEqual(
    events.filter((event) => event.kind === 'turnEnd').map((event) => event.taskIds),
    [['a'], ['b']],
  );
});

test('an unconfirmed Codex steer is never resent automatically', async () => {
  const { agent, sent, events } = await codexHarness();
  agent.request = async () => {
    throw new Error('turn/steer timed out');
  };
  await agent.send('Correction', 'b');
  await settle();
  agent.handleNotification('turn/completed', { turn: { id: 'turn-1', status: 'completed' } });
  assert.equal(sent.length, 1);
  assert.deepEqual(events.find((event) => event.kind === 'tasksCancelled').taskIds, ['b']);
  assert.deepEqual(events.find((event) => event.kind === 'turnEnd').taskIds, ['a']);
});

test('OpenCode links a joined queue to one HTTP answer', async () => {
  const agent = new OpenCodeAgent(args);
  agent.sessionId = 'session';
  const events = [];
  agent.on('event', (event) => events.push(event));
  agent.http = async (_method, _path, body) => {
    assert.equal(body.parts[0].text, 'First\n\nSecond');
    return { info: { role: 'assistant' }, parts: [{ type: 'text', text: 'Done' }] };
  };
  agent.queue.push({ text: 'First', taskId: 'a' }, { text: 'Second', taskId: 'b' });
  await agent.pump();
  assert.deepEqual(events.find((event) => event.kind === 'turnEnd').taskIds, ['a', 'b']);
  assert.equal(agent.busy, false);
});
