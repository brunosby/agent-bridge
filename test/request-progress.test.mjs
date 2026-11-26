import test from 'node:test';
import assert from 'node:assert/strict';
import { Window } from 'happy-dom';
import { readFileSync } from 'node:fs';
import { observeProgress, pendingWork, progressView, restoreProgress } from '../src/server/request-progress.ts';
const owner = () => ({ tasks: new Map(), team: [], heldRelays: [], relay: {}, agents: {}, providerChanges: new Set() });
test('late acceptance and approval stay with the original request across ten newer messages', () => {
  const c = owner();
  const emit = (kind, event) => observeProgress(c, { kind, ...event });
  emit('user', { seq: 1, text: 'first' });
  emit('taskQueued', { requestSeq: 1, agent: 'a1', id: 't', role: 'reviewer' });
  emit('taskStarted', { taskIds: ['t'], agent: 'a1' });
  for (let seq = 2; seq <= 12; seq++) emit('user', { seq, text: 'next' });
  emit('inputAccepted', { taskIds: ['t'], agent: 'a1' });
  emit('approval', { requestId: 'card', agent: 'a1' });
  const rows = progressView(c, pendingWork(c));
  assert.equal(rows.length, 11);
  assert.equal(rows[0].status, 'Waiting for you');
  assert.equal(rows[0].tasks[0].state, 'working');
  assert.equal(rows[0].tasks[0].delivered, true);
  assert.equal(rows.at(-1).waiting, undefined);
  emit('approvalClosed', { requestId: 'card' });
  emit('turnEnd', { taskIds: ['t'], agent: 'a1', ok: true });
  emit('taskStarted', { taskIds: ['t'], agent: 'a1' });
  assert.equal(progressView(c, [])[0].tasks[0].state, 'completed');
});
test('restoration interrupts open tasks without inventing future steps', () => {
  const c = owner();
  restoreProgress(c, [
    { kind: 'user', seq: 1, text: 'direct' },
    { kind: 'taskQueued', agent: 'a1', id: 't', role: 'researcher', requestSeq: 1 },
  ]);
  const [r] = progressView(c, pendingWork(c));
  assert.equal(r.status, 'Interrupted');
  assert.deepEqual(
    r.stages.map((s) => s.name),
    ['Research'],
  );
  assert.equal(r.total, undefined);
});
test('sidebar and top panel keep independent collapse choices', async (t) => {
  const win = new Window({ url: 'http://localhost', width: 1280 });
  t.after(() => win.happyDOM.close());
  win.document.write(readFileSync(new URL('../public/index.html', import.meta.url), 'utf8').replace(/<script[^>]+><\/script>/g, ''));
  globalThis.document = win.document;
  globalThis.window = win;
  const { renderProgress } = await import('../public/js/features/request-progress.js');
  const c = owner();
  observeProgress(c, { kind: 'user', seq: 2, text: 'latest' });
  const state = { progress: progressView(c, []) };
  renderProgress(state);
  const host = win.document.getElementById('requestProgress');
  assert.equal(host.parentNode.id, 'progressDock');
  host.querySelector('button').click();
  assert.equal(host.querySelector('button').getAttribute('aria-expanded'), 'false');
  renderProgress({ ...state, progressLayout: 'top' });
  assert.equal(host.parentNode.id, 'progressTop');
  assert.equal(host.querySelector('button').getAttribute('aria-expanded'), 'true');
  renderProgress(state);
  assert.equal(host.querySelector('button').getAttribute('aria-expanded'), 'false');
});
