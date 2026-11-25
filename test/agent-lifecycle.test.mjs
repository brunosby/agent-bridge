import test from 'node:test';
import assert from 'node:assert/strict';
import { FakeAgent } from '../src/providers/fake.ts';
import { canReceiveWork } from '../src/core/agent-status.ts';
import { startAndWait, statusOf } from '../src/server/agent-lifecycle.ts';
import { addBatchPart, finishBatchPart } from '../src/server/batch.ts';

test('startup waits for the model handshake and a busy agent can receive work unless its account is blocked', async () => {
  const agent = new FakeAgent({ cwd: '.' });
  const ready = startAndWait(
    agent,
    () => {},
    () => {},
  );
  assert.equal(statusOf(agent).availability, 'starting');
  agent.emitEvent('models');
  assert.equal(await ready, true);
  agent.busyCount = 1;
  assert.equal(statusOf(agent).activity, 'working');
  assert.equal(canReceiveWork(statusOf(agent)), true);
  assert.equal(canReceiveWork(statusOf(agent, { state: 'rate_limited', detail: 'retry later' })), false);
  const timer = setTimeout(() => {}, 50);
  try {
    assert.equal(
      await startAndWait(
        agent,
        () => {},
        () => {},
        10,
      ),
      false,
    );
    assert.equal(statusOf(agent).availability, 'startup_failed');
    agent.emitEvent('models');
    assert.equal(statusOf(agent).availability, 'ready');
  } finally {
    clearTimeout(timer);
  }
});

test('only the reserved task can finish its part, and cancellation only counts once', () => {
  const owner = {};
  const first = addBatchPart(owner, 'a1');
  const second = addBatchPart(owner, 'a2');
  assert.equal(addBatchPart(owner, 'a1'), undefined);
  assert.equal(finishBatchPart(owner, 'a1', 'other queued task', 'wrong'), undefined);
  const batch = finishBatchPart(owner, 'a1', first, 'cancelled');
  assert.equal(batch.pending.size, 1);
  assert.equal(finishBatchPart(owner, 'a1', first, 'late'), undefined);
  assert.deepEqual(
    finishBatchPart(owner, 'a2', second, 'finished').results.map((result) => result.text),
    ['cancelled', 'finished'],
  );
  assert.equal(owner.batch, null);
});
