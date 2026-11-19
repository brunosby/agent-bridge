import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { Window } from 'happy-dom';

test('the composer handles keyboard input and displays only useful recipient previews', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const window = new Window({ url: 'http://localhost' });
  window.document.write(readFileSync(new URL('../public/index.html', import.meta.url), 'utf8').replace(/<script[^>]+><\/script>/g, ''));
  const sent = [];
  const claude = { id: 'claude', name: 'Claude', role: 'orchestrator', available: true };
  const codex = { id: 'codex', name: 'Codex', role: 'coder', available: true };
  let preview = { targets: [claude], changedByMention: false };
  Object.assign(globalThis, {
    document: window.document,
    sessionStorage: window.sessionStorage,
    requestAnimationFrame: window.requestAnimationFrame.bind(window),
    cancelAnimationFrame: window.cancelAnimationFrame.bind(window),
    fetch: async (url, init) => {
      if (String(url).endsWith('/send')) sent.push(JSON.parse(init.body).text);
      return { ok: true, json: async () => preview };
    },
  });
  try {
    const { updateComposer } = await import('../public/js/features/controls.js');
    const { store } = await import('../public/js/core/store.js');
    store.state = {
      conversationId: 'test-conversation',
      routingMode: 'orchestrator',
      team: [claude, codex],
    };
    updateComposer();

    const input = window.document.getElementById('input');
    const suggestions = window.document.getElementById('mentionSuggestions');
    const key = (init = {}) => {
      const event = new window.KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true, ...init });
      input.dispatchEvent(event);
      return event.defaultPrevented;
    };
    const type = (value) => {
      input.value = value;
      input.setSelectionRange(value.length, value.length);
      input.dispatchEvent(new window.Event('input', { bubbles: true }));
    };
    const settle = () => new Promise((resolve) => setImmediate(resolve));

    type('first line');
    assert.equal(key({ shiftKey: true }), false, 'Shift+Enter is left to the textarea');
    assert.equal(key({ isComposing: true }), false, 'Enter during IME composition is ignored');
    assert.equal(key({ keyCode: 229 }), false, 'legacy IME events are also ignored');
    assert.deepEqual(sent, []);

    type('first line\nsecond line');
    assert.equal(key(), true, 'Enter sends');
    await settle();
    assert.deepEqual(sent, ['first line\nsecond line']);

    type('@Cla');
    assert.equal(suggestions.hidden, false);
    assert.equal(key({ shiftKey: true }), false, 'Shift+Enter is left to the textarea with suggestions open');
    assert.equal(key(), true, 'Enter inserts the selected mention');
    assert.equal(input.value, '@Claude ');
    assert.equal(suggestions.hidden, true);
    assert.equal(sent.length, 1);

    type('@Claude\n@Claude');
    assert.equal(suggestions.hidden, false);
    assert.equal(key({ ctrlKey: true }), true, 'Ctrl+Enter still sends with suggestions open');
    await settle();
    assert.deepEqual(sent, ['first line\nsecond line', '@Claude\n@Claude']);

    const output = window.document.getElementById('targetPreview');
    const flushPreview = async () => {
      t.mock.timers.tick(120);
      await settle();
    };
    await flushPreview();
    assert.equal(output.textContent, '');

    type('@Claude looks good');
    await flushPreview();
    assert.equal(output.textContent, '', 'mentioning the selected recipient is redundant');

    preview = { targets: [codex], changedByMention: true };
    type('@Codex looks good');
    await flushPreview();
    assert.equal(output.textContent, 'To Codex');
    assert.equal(output.parentElement.querySelector('label[for="target"]').textContent, 'Send to');

    preview = { targets: [claude], changedByMention: false };
    type('no mention');
    await flushPreview();
    assert.equal(output.textContent, '');

    preview = { targets: [{ ...claude, available: false }], changedByMention: false };
    store.state.team = [{ ...claude, available: false }, codex];
    updateComposer();
    await flushPreview();
    assert.equal(output.textContent, 'To Claude (unavailable)');
  } finally {
    await window.happyDOM.close();
  }
});
