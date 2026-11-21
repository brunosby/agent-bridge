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
      id: 'a1',
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

    // Codex lists its models (with effort levels) before it is ready; the effort menu must unlock once it is.
    const codex = {
      ...agent,
      id: 'codex',
      driver: 'codex',
      name: 'Codex',
      effort: 'default',
      model: 'default',
      resolvedModel: null,
      available: false,
      models: [{ value: 'gpt-6.2-sol', label: 'GPT-6.2-Sol', isDefault: true, efforts: ['low', 'high'], defaultEffort: 'low' }],
    };
    renderCard(codex);
    const effort = cards.codex.effort;
    assert.equal(effort.disabled, true);
    renderCard({ ...codex, available: true });
    assert.equal(effort.disabled, false);
    assert.deepEqual(
      [...effort.options].map((o) => o.value),
      ['default', 'low', 'high'],
    );

    const { handle } = await import('../public/js/features/conversation-log.js');
    const lead = { ...codex, id: 'a1', name: 'Lead', model: 'gpt-6.2-sol', available: true };
    const peer = { ...lead, id: 'a2', name: 'Peer' };
    const tone = (node) => node.style.getPropertyValue('--agent-accent');
    const state = {
      kind: 'state',
      conversationId: 'test',
      team: [lead, peer],
      knownAgents: [],
      relay: { auto: false, hops: 0, maxHops: 8 },
      routingMode: 'orchestrator',
      totalTokens: 0,
    };
    handle(state);
    assert.notEqual(tone(cards.a1.el), tone(cards.a2.el));
    const peerColor = tone(cards.a2.el);
    handle({ kind: 'delta', agent: 'a1', key: 'stream', text: '@Pe' });
    handle({ kind: 'delta', agent: 'a1', key: 'stream', text: 'er draft' });
    handle({ kind: 'text', agent: 'a1', key: 'stream', text: '@a2 final answer', final: true });
    handle({ kind: 'delta', agent: 'a1', key: 'stream', text: ' stale text' });
    handle({ kind: 'text', agent: 'a2', key: 'second', text: 'second message', final: true });
    handle({ kind: 'replayComplete' });
    const log = window.document.getElementById('log');
    const messages = [...log.querySelectorAll('.msg.agent')];
    assert.deepEqual(messages.map(tone), [tone(cards.a1.el), peerColor]);
    assert.match(messages[0].textContent, /@Peer final answer/);
    assert.doesNotMatch(messages[0].textContent, /draft|stale/);
    assert.equal(tone(messages[0].querySelector('.mention')), peerColor);

    const renamed = { ...peer, name: 'Quality', model: 'default' };
    handle({ ...state, team: [lead, renamed] });
    handle({ kind: 'replayComplete' });
    assert.equal(tone(cards.a2.el), peerColor);
    assert.equal(messages[0].querySelector('.mention').textContent, '@Quality');
    assert.equal(messages[1].querySelector('.who').textContent, 'Quality');
    assert.equal(window.document.querySelector('#logAgent option[value="a2"]').textContent, 'Quality');

    handle({ ...state, team: [lead], knownAgents: [{ ...renamed, removed: true }] });
    handle({ kind: 'replayComplete' });
    const removed = messages[0].querySelector('.mention');
    assert.equal(removed.textContent, '@Quality (removed)');
    assert.equal(tone(removed), 'var(--color-text-muted)');
  } finally {
    await window.happyDOM.close();
  }
});
