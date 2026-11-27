import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { Window } from 'happy-dom';

test('question card preserves a typed answer while individual deliveries change', async (t) => {
  const window = new Window({ url: 'http://localhost' });
  t.after(() => window.happyDOM.close());
  const { document } = window;
  document.write(readFileSync(new URL('../public/index.html', import.meta.url), 'utf8').replace(/<script[^>]+><\/script>/g, ''));
  const calls = [];
  Object.assign(globalThis, {
    document,
    sessionStorage: window.sessionStorage,
    fetch: async (url, options) => {
      calls.push([url, JSON.parse(options.body)]);
      return { ok: true, json: async () => ({}) };
    },
  });
  const { renderWorkflow } = await import('../public/js/features/task-workflow.js');
  const { store } = await import('../public/js/core/store.js');
  const targets = [
    { agent: 'a2', state: 'pending' },
    { agent: 'a3', state: 'pending' },
  ];
  const pending = {
    id: 'question-2',
    kind: 'question',
    agent: 'a1',
    questions: [{ question: 'Which label?', options: ['A', 'B'] }],
    delegation: { text: '@a2 build @a3 test', targets },
  };
  const state = (store.state = {
    conversationId: 'test',
    team: [
      { id: 'a2', name: 'Dev' },
      { id: 'a3', name: 'Tests' },
    ],
    earlierDecisions: [{ seq: 2, pending }],
  });
  renderWorkflow(state);
  const box = document.querySelector('.question-delegations');
  assert.match(box.textContent, /@Dev, @Tests/);
  const input = document.querySelector('.workflow-card textarea');
  input.value = 'answer in progress';
  const button = (label) => [...box.querySelectorAll('button')].find((b) => b.textContent === label);
  button('Wait for my answer').click();
  assert.equal(document.activeElement, input);
  assert.equal(calls.length, 0);
  button('Send now').click();
  await new Promise((r) => setImmediate(r));
  assert.deepEqual(calls, [['/api/taskDecision', { conversationId: 'test', seq: 2, requestId: 'question-2', action: 'sendDelegations' }]]);
  targets[0].state = 'received';
  targets[1].reason = 'specification approval is pending';
  renderWorkflow(state);
  assert.equal(document.querySelector('.workflow-card textarea'), input);
  assert.equal(input.value, 'answer in progress');
  assert.match(box.textContent, /@Dev · Received/);
  assert.match(box.textContent, /@Tests · specification approval is pending/);
  assert.equal(box.querySelector('.actions').hidden, false);
  targets[1].state = 'received';
  delete targets[1].reason;
  renderWorkflow(state);
  assert.equal(box.querySelector('.actions').hidden, true);
});
