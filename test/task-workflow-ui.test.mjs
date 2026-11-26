import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { Window } from 'happy-dom';

test('decision cards preserve drafts across live updates and submit the edited inputs', async (t) => {
  const win = new Window({ url: 'http://localhost' });
  t.after(() => win.happyDOM.close());
  win.document.write(readFileSync(new URL('../public/index.html', import.meta.url), 'utf8').replace(/<script[^>]+><\/script>/g, ''));
  globalThis.document = win.document;
  const sent = [];
  t.mock.method(globalThis, 'fetch', async (route, opts) => {
    sent.push([route, JSON.parse(opts.body)]);
    return { ok: true, json: async () => ({}) };
  });
  const { renderWorkflow } = await import('../public/js/features/task-workflow.js');
  const state = {
    conversationId: 'sample',
    taskPlan: { seq: 4, pending: { id: 's', kind: 'spec', docs: [{ path: 'docs/spec/spec.md', text: 'Draft' }] } },
  };
  const card = () => win.document.querySelector('.workflow-card');
  const button = (title) => Array.from(card().querySelectorAll('button')).find((b) => b.textContent === title);
  renderWorkflow(state);
  card().querySelector('textarea').value = 'Edited draft';
  renderWorkflow(state);
  await button('Approve and save').onclick();
  assert.equal(sent[0][1].docs[0].text, 'Edited draft');
  const q = { question: 'Pick one', options: ['A', 'B'], recommendation: 'A', evidence: 'A user preference' };
  state.taskPlan.pending = { id: 'q', kind: 'question', questions: [q, { ...q, question: 'Second question' }] };
  renderWorkflow(state);
  button('B').click();
  const inputs = card().querySelectorAll('textarea');
  assert.equal(inputs[0].value, 'B');
  inputs[1].value = 'Free text';
  await button('Send answers').onclick();
  assert.deepEqual(sent[1], [
    '/api/taskDecision',
    { conversationId: 'sample', seq: 4, requestId: 'q', action: 'answer', answers: ['B', 'Free text'] },
  ]);
  renderWorkflow({ ...state, taskPlan: null });
  assert.equal(card(), null);
  assert.equal(win.document.getElementById('pending').hidden, true);

  await t.test('the original task offers a single retry only while a specification needs attention', async () => {
    const { sizeBadge } = await import('../public/js/features/task-workflow.js');
    const node = win.document.createElement('article');
    node.innerHTML = '<div class="head"><select class="task-size"><option value="large">large task</option></select></div>';
    const current = { conversationId: 'sample', taskPlan: { seq: 4, size: 'large', specNeedsRetry: true } };
    sizeBadge(node, current);
    sizeBadge(node, current);
    assert.equal(node.querySelectorAll('.retry-spec').length, 1);
    assert.equal(node.querySelector('.retry-spec').textContent, 'Retry specification');
    current.taskPlan.specNeedsRetry = 'manual';
    sizeBadge(node, current);
    assert.equal(node.querySelector('.retry-spec').textContent, 'Request specification');
    await node.querySelector('.retry-spec').onclick();
    assert.deepEqual(sent.at(-1), ['/api/taskDecision', { conversationId: 'sample', seq: 4, action: 'retrySpec' }]);
    sizeBadge(node, current, false);
    assert.equal(node.querySelector('.retry-spec'), null);
    delete current.taskPlan.specNeedsRetry;
    sizeBadge(node, current);
    assert.equal(node.querySelector('.retry-spec'), null);
  });
});
