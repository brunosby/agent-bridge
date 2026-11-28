// Hold the simulated provider until this test explicitly confirms the end of its turn.
import { mock } from 'node:test';
import { FakeAgent } from '../../src/providers/fake.ts';
import { deliver } from '../../src/server/delivery.ts';

const pending = new Map();
FakeAgent.prototype.compact = function (instructions, signal) {
  this.emitEvent('info', { text: 'Fixture compact: ' + instructions });
  signal.addEventListener('abort', () => this.emitEvent('info', { text: 'Fixture interrupt requested' }), { once: true });
  return new Promise((resolve, reject) => pending.set(this.id, { resolve, reject }));
};
const send = FakeAgent.prototype.send;
FakeAgent.prototype.send = function (text, id) {
  this.contextTokens = 18000;
  this.emitEvent('contextUsage', {});
  return send.call(this, text, id);
};
process.on('message', ({ op, id = 'a1', value }) => {
  if (op === 'clock') mock.timers.enable({ apis: ['setTimeout'] });
  if (op === 'tick') mock.timers.tick(value);
  if (op === 'realClock') mock.timers.reset();
  if (op === 'relay') deliver(id, value, { from: 'a2' });
  if (op === 'finish' || op === 'fail') {
    const run = pending.get(id);
    pending.delete(id);
    if (op === 'finish') run.resolve({ compacted: true, before: value ?? 230000 });
    else run.reject(new Error('fixture failure'));
  }
  process.send({ ack: op });
});
