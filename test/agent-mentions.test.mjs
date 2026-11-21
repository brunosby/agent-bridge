import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync, mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { startBridge } from './helpers/bridge.mjs';
import { toMentionIds } from '../src/core/recipients.ts';
import { CodexAgent } from '../src/providers/codex.ts';

const team = [
  { driver: 'fake', role: 'orchestrator', name: 'Lead' },
  { driver: 'fake', role: 'reviewer', name: 'Revisor' },
];

test('the mention parser preserves code, e-mail, and package scopes', () => {
  const members = [{ id: 'a2', name: 'Revisor' }];
  const original = [
    '@Revisor please look at user@Revisor and @Revisor/package.',
    'Use `@Revisor` and @Revisor.example.',
    '```js',
    '@Revisor',
    '```',
    'Then ask @REVIsor.',
  ].join('\n');
  const expected = original.replace(/^@Revisor/, '@a2').replace('@REVIsor.', '@a2.');
  assert.equal(toMentionIds(original, members), expected);
});

test('streaming preserves raw deltas and gives chat, routing and saved search a canonical final answer', async () => {
  const reply = '@Revisor inspect `@Revisor` and user@Revisor.';
  const bridge = await startBridge({
    team,
    rules: [
      { agent: 'Lead', match: 'start stream', reply, streamAt: 4 },
      { agent: 'Revisor', reply: 'inspection complete' },
    ],
  });
  try {
    await bridge.api('send', { text: 'start stream' });
    const final = await bridge.waitFor((event) => event.kind === 'text' && event.agent === 'a1' && event.final);
    assert.equal(final.text, '@a2 inspect `@Revisor` and user@Revisor.');
    assert.equal(
      bridge.events
        .filter((event) => event.kind === 'delta' && event.key === final.key)
        .map((event) => event.text)
        .join(''),
      reply,
    );
    await bridge.waitFor((event) => event.kind === 'routed' && event.from === 'a1' && event.to === 'a2');
    const state = bridge.state();
    await bridge.api('rename', { agent: 'a2', name: 'Quality' });
    const result = await bridge.api('searchTranscript', { query: '@Quality inspect' });
    assert.equal(result.results[0].excerpt, '@Quality inspect `@Revisor` and user@Revisor.');
    const file = path.join(bridge.logs, state.conversationId, 'transcript.jsonl');
    const events = readFileSync(file, 'utf8')
      .trimEnd()
      .split('\n')
      .map((line) => JSON.parse(line));
    assert.equal(
      events
        .filter((event) => event.kind === 'delta' && event.key === final.key)
        .map((event) => event.text)
        .join(''),
      reply,
    );
    assert.equal(events.find((event) => event.kind === 'text' && event.key === final.key).text, final.text);
  } finally {
    await bridge.stop();
  }
});

test('rename preserves running work, validates names and checks typed mention ownership', async () => {
  const bridge = await startBridge({
    team,
    settings: {
      autoRelay: false,
      fake: {
        delayMs: 250,
        rules: [{ agent: 'Quality', match: 'Your display name is now Quality[\\s\\S]*@a2: Quality', reply: 'new roster received' }],
      },
    },
    rules: [],
  });
  try {
    for (const name of ['', 'Lead', 'A9', 'x'.repeat(25)]) {
      await assert.rejects(bridge.api('rename', { agent: 'a2', name }));
      await assert.rejects(bridge.api('addAgent', { driver: 'fake', role: 'reviewer', name }));
    }
    const sent = { text: '@Revisor check', target: 'auto' };
    await bridge.api('send', sent);
    const user = await bridge.waitFor((event) => event.kind === 'user');
    assert.equal(user.text, '@a2 check');
    const task = await bridge.waitFor((event) => event.kind === 'taskQueued' && event.agent === 'a2');
    const oldSession = bridge.state().team.find(({ id }) => id === 'a2').sessionId;
    await bridge.api('rename', { agent: 'a2', name: 'Quality' });
    const renamed = await bridge.waitFor((event) => event.kind === 'state' && event.team.some(({ name }) => name === 'Quality'));
    assert.equal(renamed.team.find(({ id }) => id === 'a2').sessionId, oldSession);
    await bridge.waitFor((event) => event.kind === 'turnEnd' && event.taskIds.includes(task.id));
    assert.equal(
      bridge.events.some((event) => event.kind === 'tasksCancelled' && event.taskIds.includes(task.id)),
      false,
    );
    await bridge.api('send', { text: '@a2 verify roster' });
    await bridge.waitFor((event) => event.kind === 'text' && event.text === 'new roster received');
    const mentionChecks = [{ name: 'Revisor', id: 'a2' }];
    await assert.rejects(bridge.api('previewTarget', { prefix: '@Revisor' }), /Unknown recipient/);
    const { agent } = await bridge.api('addAgent', { driver: 'fake', role: 'reviewer', name: 'Revisor' });
    assert.equal(agent.id, 'a3');
    await assert.rejects(bridge.api('previewTarget', { prefix: '@a2', mentionChecks }), /Check the mention @Revisor/);
    await assert.rejects(bridge.api('send', { text: '@a2 stale draft', mentionChecks }), /Check the mention @Revisor/);
  } finally {
    await bridge.stop();
  }
});

test('restoring a legacy history preserves removed names and IDs seen only on events', async () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'agent-bridge-legacy-'));
  const logDir = path.join(dir, 'logs', 'legacy');
  mkdirSync(logDir, { recursive: true });
  const active = { ...team[0], id: 'a1' };
  const removed = { ...team[1], id: 'a2' };
  const oldRows =
    [
      { kind: 'state', seq: 1, team: [active, removed] },
      { kind: 'user', seq: 2, text: '@a2 inspect then', to: ['a2'] },
      { kind: 'state', seq: 3, team: [active] },
      { kind: 'text', seq: 4, agent: 'a7', key: 'old', text: 'last message', final: true },
    ]
      .map((event) => JSON.stringify(event))
      .join('\n') + '\n';
  const file = path.join(logDir, 'transcript.jsonl');
  writeFileSync(file, oldRows);
  const bridge = await startBridge({ team: [], rules: [], dir, resume: 'legacy' });
  try {
    const state = await bridge.waitFor((event) => event.kind === 'state' && event.conversationId === 'legacy');
    assert.equal(state.lastAgentId, 7);
    assert.deepEqual(
      state.knownAgents.find(({ id }) => id === 'a2'),
      { ...removed, removed: true },
    );
    const { agent } = await bridge.api('addAgent', { driver: 'fake', role: 'reviewer', name: 'NewReviewer' });
    assert.equal(agent.id, 'a8');
    const result = await bridge.api('searchTranscript', { query: '@Revisor inspect' });
    assert.equal(result.results[0].excerpt, '@Revisor inspect then');
    assert.ok(readFileSync(file, 'utf8').startsWith(oldRows));
  } finally {
    await bridge.stop();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('Codex updates the existing thread title without changing the thread or process', async () => {
  const agent = new CodexAgent({ cwd: process.cwd(), id: 'a2', name: 'Revisor' });
  const processStub = {};
  agent.proc = processStub;
  agent.threadId = 'same-thread';
  const requests = [];
  agent.request = async (method, body) => {
    requests.push({ method, body });
  };
  agent.name = 'Quality';
  await agent.syncThreadName();
  assert.equal(agent.proc, processStub);
  assert.deepEqual(requests, [
    {
      method: 'thread/name/set',
      body: { threadId: 'same-thread', name: 'Agent Bridge \u00b7 ' + path.basename(process.cwd()) + ' \u00b7 Quality' },
    },
  ]);
});
