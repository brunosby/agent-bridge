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

test('progress groups parallel agents, refreshes activity and preserves the open decision history and keyboard focus', async (t) => {
  const win = new Window({ url: 'http://localhost', width: 1280 });
  t.after(() => win.happyDOM.close());
  win.document.write(readFileSync(new URL('../public/index.html', import.meta.url), 'utf8').replace(/<script[^>]+><\/script>/g, ''));
  globalThis.document = win.document;
  globalThis.window = win;
  const { renderProgress } = await import('../public/js/features/request-progress.js');
  const c = owner();
  const emit = (kind, data) => observeProgress(c, { kind, ...data });
  emit('user', { seq: 3, text: 'First request' });
  emit('taskQueued', { requestSeq: 3, id: 'first', agent: 'a1', role: 'coder' });
  emit('taskStarted', { taskIds: ['first'], agent: 'a1' });
  emit('approval', { agent: 'a1', requestId: 'older-card' });
  emit('user', { seq: 4, text: 'Second request' });
  for (const agent of ['a2', 'a3']) {
    emit('taskQueued', { requestSeq: 4, id: agent, agent, name: 'Dev ' + agent, role: 'coder' });
    emit('taskStarted', { taskIds: [agent], agent });
  }
  const state = { conversationId: 'parallel', progress: progressView(c, pendingWork(c)), tasks: [{ id: 'a2', activity: 'reading files' }] };
  renderProgress({ ...state, progressLayout: 'top' });
  const host = win.document.getElementById('requestProgress');
  assert.equal(host.querySelectorAll('.progress-stage.active').length, 1);
  assert.equal(host.querySelectorAll('.progress-live li').length, 2);
  assert.match(host.querySelector('.progress-live').textContent, /reading files/);
  assert.doesNotMatch(host.textContent, /Step \d+ of/);
  const earlier = host.querySelector('.progress-earlier');
  earlier.open = true;
  earlier.querySelector('summary').focus();
  renderProgress({ ...state, progressLayout: 'top', tasks: [{ id: 'a2', activity: 'editing files' }] });
  assert.equal(host.querySelector('.progress-earlier').open, true);
  assert.equal(win.document.activeElement.dataset.focus, 'earlier');
  assert.match(host.querySelector('.progress-live').textContent, /editing files/);
  const card = win.document.createElement('button');
  card.id = 'older-card';
  win.document.body.append(card);
  host.querySelector('.progress-earlier button').click();
  assert.equal(win.document.activeElement, card);
  emit('approval', { agent: 'a2', requestId: 'current-card' });
  renderProgress({ ...state, progressLayout: 'top', progress: progressView(c, pendingWork(c)) });
  assert.match(host.querySelector('.progress-live').textContent, /Waiting for your approval/);
  assert.doesNotMatch(host.querySelector('.progress-live').textContent, /reading files/);
  renderProgress({ ...state, progress: [] });
  assert.equal(host.hidden, true);
});

test('live activity and its local clock appear in the top panel, rail, collapsed summaries and mobile launcher', async (t) => {
  const win = new Window({ url: 'http://localhost', width: 1280 });
  t.after(() => win.happyDOM.close());
  win.document.write(readFileSync(new URL('../public/index.html', import.meta.url), 'utf8').replace(/<script[^>]+><\/script>/g, ''));
  globalThis.document = win.document;
  globalThis.window = win;
  const { renderProgress, applyActivity } = await import('../public/js/features/request-progress.js');
  const { updateActivityClocks } = await import('../public/js/features/progress-view.js');
  const c = owner();
  for (const e of [
    { kind: 'user', seq: 10, text: 'Review the change' },
    { kind: 'taskQueued', requestSeq: 10, agent: 'a2', id: 't', name: 'Dev', role: 'coder' },
    { kind: 'taskStarted', agent: 'a2', taskIds: ['t'] },
  ])
    observeProgress(c, { ...e, at: 100 });
  const state = { conversationId: 'clock', progress: progressView(c, []), progressLayout: 'top' };
  const host = win.document.getElementById('requestProgress');
  renderProgress(state, true);
  if (host.querySelector('[data-focus="toggle"]').getAttribute('aria-expanded') === 'false') host.querySelector('button').click();
  updateActivityClocks(host, 4100);
  assert.equal(host.querySelector('[data-thinking]').hidden, true);
  updateActivityClocks(host, 6100);
  assert.match(host.querySelector('[data-thinking]').textContent, /Thinking · 6 s/);
  applyActivity(state, {
    conversationId: 'clock',
    agent: 'a2',
    updates: [{ id: 't', now: { text: 'Editing src/file.ts', at: 9000 }, actions: 2, files: 1 }],
  });
  updateActivityClocks(host, 49000);
  assert.match(host.querySelector('.progress-live').textContent, /Editing src\/file.ts · 40 s · 2 actions · 1 file changed/);
  host.querySelector('button').click();
  assert.match(host.querySelector('.progress-brief').textContent, /Dev: Editing file.ts/);
  state.progressLayout = 'sidebar';
  renderProgress(state);
  if (host.querySelector('.progress-strip')) host.querySelector('button').click();
  assert.match(host.querySelector('.progress-stage').textContent, /Editing src\/file.ts/);
  host.querySelector('button').click();
  assert.match(host.querySelector('.progress-vertical').title, /Dev: Editing src\/file.ts/);
  win.happyDOM.setWindowSize({ width: 390, height: 780 });
  renderProgress(state, true);
  assert.match(win.document.getElementById('progressFloat').textContent, /Code · Dev: Editing file.ts/);
});
