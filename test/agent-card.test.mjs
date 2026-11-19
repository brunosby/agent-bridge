import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { Window } from 'happy-dom';

test('agent card shows the role and a short model name, with the full id and effort in the tooltip', async () => {
  const window = new Window({ url: 'http://localhost' });
  window.document.write(readFileSync(new URL('../public/index.html', import.meta.url), 'utf8').replace(/<script[^>]+><\/script>/g, ''));
  Object.assign(globalThis, {
    document: window.document,
    sessionStorage: window.sessionStorage,
    requestAnimationFrame: window.requestAnimationFrame.bind(window),
    cancelAnimationFrame: window.cancelAnimationFrame.bind(window),
    // Happy DOM does not expose the browser's Option constructor.
    Option: function Option(text, value) {
      const option = window.document.createElement('option');
      option.textContent = text;
      option.value = value;
      return option;
    },
  });
  try {
    const { renderCard } = await import('../public/js/features/agents.js');
    const { cards, store } = await import('../public/js/core/store.js');
    store.state = { tasks: [] };
    store.catalog.roles = [{ id: 'orchestrator', name: 'Orchestrator' }];
    const agent = {
      id: 'agent',
      driver: 'claude',
      name: 'Claude',
      role: 'orchestrator',
      available: true,
      tokens: 0,
      effort: 'high',
      model: 'default',
      resolvedModel: 'claude-opus-5-5',
      models: [
        { value: 'default', label: 'Default (recommended)', resolved: 'claude-opus-5-5' },
        { value: 'opus', label: 'Opus 5.5', resolved: 'claude-opus-5-5', efforts: ['high'] },
      ],
    };

    renderCard(agent);
    const { el } = cards[agent.id];
    const role = el.querySelector('.card-role');
    assert.equal(el.querySelector('.name').textContent, 'Claude');
    assert.equal(role.textContent, 'Orchestrator · Opus 5.5');
    assert.equal(role.title, 'Model: claude-opus-5-5\nEffort: high');

    renderCard({ ...agent, model: 'opus', resolvedModel: 'previous-model' });
    assert.equal(role.title, 'Model: claude-opus-5-5\nEffort: high');

    renderCard({
      ...agent,
      driver: 'opencode',
      model: 'opencode/big-pickle',
      models: [{ value: 'opencode/big-pickle', label: 'OpenCode Zen: Big Pickle (free)' }],
    });
    assert.equal(role.textContent, 'Orchestrator · Big Pickle');
    assert.equal(role.title, 'Model: opencode/big-pickle\nEffort: high');

    renderCard({
      ...agent,
      resolvedModel: 'ollama/gpt-oss:120b',
      models: [{ value: 'other-model', label: 'Other Model', isDefault: true }],
    });
    assert.equal(role.textContent, 'Orchestrator · gpt-oss:120b');
    assert.equal(role.title, 'Model: ollama/gpt-oss:120b\nEffort: high');

    renderCard({ ...agent, resolvedModel: null, models: [], effort: 'default' });
    assert.equal(role.textContent, 'Orchestrator');
    assert.equal(role.title, 'Effort: default');
  } finally {
    await window.happyDOM.close();
  }
});
