import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { Window } from 'happy-dom';

test('team cards support click, drag, Escape, touch handles and optimistic rollback', async (t) => {
  const w = new Window({ url: 'http://localhost' });
  t.after(() => w.happyDOM.close());
  w.document.write(readFileSync(new URL('../public/index.html', import.meta.url), 'utf8').replace(/<script[^>]+><\/script>/g, ''));
  const { document } = w;
  let reject = false;
  const calls = [];
  Object.assign(globalThis, {
    document,
    sessionStorage: w.sessionStorage,
    requestAnimationFrame: () => 1,
    cancelAnimationFrame: () => {},
    fetch: async (url, options) => {
      calls.push([url, JSON.parse(options.body)]);
      return { ok: !reject, json: async () => (reject ? { error: 'order refused' } : { ok: true }) };
    },
  });
  const { installAgentDrag, moveAgent } = await import('../public/js/features/team-order.js');
  const { store, cards } = await import('../public/js/core/store.js');
  const box = document.getElementById('agents');
  const team = ['a1', 'a2', 'a3'].map((id) => ({ id, name: id.toUpperCase() }));
  store.state = { team, conversationId: 'c' };
  let details = 0;
  for (const [i, { id }] of team.entries()) {
    const el = document.createElement('button'),
      handle = document.createElement('span');
    el.dataset.agentId = id;
    el.append(handle);
    box.append(el);
    cards[id] = { el, handle };
    el.getBoundingClientRect = () => ({ top: 50 + i * 40, height: 40 });
    installAgentDrag(el, handle);
    el.onclick = () => details++;
  }
  const { el, handle } = cards.a1;
  const pointer = (target, type, y, kind = 'mouse') =>
    target.dispatchEvent(new w.PointerEvent(type, { bubbles: true, pointerId: 1, pointerType: kind, button: 0, clientX: 10, clientY: y }));
  const click = () => el.dispatchEvent(new w.MouseEvent('click', { bubbles: true, detail: 1 }));
  pointer(el, 'pointerdown', 60);
  pointer(el, 'pointerup', 62);
  click();
  assert.equal(details, 1);
  pointer(el, 'pointerdown', 60);
  pointer(el, 'pointermove', 155);
  document.dispatchEvent(new w.KeyboardEvent('keydown', { key: 'Escape' }));
  pointer(el, 'pointerup', 155);
  click();
  assert.equal(calls.length, 0);
  assert.equal(details, 1);
  pointer(el, 'pointerdown', 60, 'touch');
  pointer(el, 'pointermove', 155, 'touch');
  pointer(el, 'pointerup', 155, 'touch');
  assert.equal(calls.length, 0);
  pointer(handle, 'pointerdown', 60, 'touch');
  pointer(el, 'pointermove', 155, 'touch');
  pointer(el, 'pointerup', 155, 'touch');
  click();
  await new Promise((r) => setImmediate(r));
  assert.deepEqual(calls[0], ['/api/reorder', { conversationId: 'c', order: ['a2', 'a3', 'a1'] }]);
  assert.equal(details, 1);
  assert.equal(document.activeElement, el);
  assert.match(document.getElementById('reorderNotice').textContent, /A1 moved from position 1 to 3 of 3/);
  reject = true;
  await moveAgent('a1', 1, 'c');
  assert.deepEqual(
    [...box.children].map((node) => node.dataset.agentId),
    ['a1', 'a2', 'a3'],
  );
  await moveAgent('a1', 2, 'stale');
  assert.equal(calls.length, 2);
});
