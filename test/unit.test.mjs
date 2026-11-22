// @ts-check
// Unit tests of the pure modules: safety rules, roles, prompts and saved conversations.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const SRC = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'src');
/** Import a module whether it lives in src/ (phase 1) or in a layer folder (later phases). */
async function load(/** @type {string[]} */ ...candidates) {
  for (const c of candidates) {
    const p = path.join(SRC, c);
    if (fs.existsSync(p)) return import(new URL(`file:///${p.replace(/\\/g, '/')}`).href);
  }
  throw new Error(`module not found: ${candidates.join(', ')}`);
}

const safety = await load('core/safety.ts');
const roles = await load('core/roles.ts');
const prompts = await load('core/prompts.ts');
const history = await load('core/history.ts');

test('safety: single deletions inside the project pass, the rest is flagged', () => {
  const root = process.platform === 'win32' ? 'C:\\proj' : '/proj';
  const c = safety.buildMatcher({ workDir: root });
  assert.equal(c({ command: 'rm notes.txt' }), null);
  assert.equal(c({ command: 'npm test' }), null);
  assert.match(c({ command: 'rm -rf build' }), /recursive/);
  assert.match(c({ command: 'rm ../other.txt' }), /outside/);
  assert.match(c({ command: 'cd /tmp && rm x' }), /changing directory/);
  assert.match(c({ command: 'git push --force origin main' }), /destructive/);
  assert.match(c({ command: 'git reset --hard HEAD~1' }), /destructive/);
  assert.match(c({ command: 'rm a.txt', cwd: process.platform === 'win32' ? 'C:\\elsewhere' : '/elsewhere' }), /outside/);
});

test('roles: glob matching and recommended models', () => {
  assert.equal(roles.globMatch('*:long-task', 'plugin:long-task'), true);
  assert.equal(roles.globMatch('*:long-task', 'plugin:loop-design'), false);
  const role = { recommended: { label: '', patterns: ['opus', 'gpt-6\\.2'] } };
  assert.equal(roles.isRecommended(role, { value: 'claude-opus-5-5' }), true);
  assert.equal(roles.isRecommended(role, { value: 'haiku' }), false);
});

test('roles: the shipped catalog loads with the expected roles', () => {
  const catalog = roles.loadRoles(path.join(SRC, '..', 'roles'));
  for (const id of ['orchestrator', 'architect', 'coder', 'reviewer', 'tester', 'researcher']) assert.ok(catalog[id], id);
  assert.equal(catalog.reviewer.context, 'diff');
  assert.equal(catalog.coder.canEdit, 'all');
  assert.equal(catalog.researcher.profile, 'lean');
});

test('prompts: the team list says when nobody can edit code', () => {
  const t = prompts.rosterText(
    [
      { id: 'a1', name: 'Lead', roleName: 'Orchestrator', canEdit: 'none' },
      { id: 'a2', name: 'Rev', roleName: 'Reviewer', canEdit: 'none' },
    ],
    'a1',
    'orchestrator',
  );
  assert.match(t, /@a1: Lead \(Orchestrator, read-only\).*\(you\)/);
  assert.match(t, /No agent in this team can edit production code/);
});

test('history: old two-agent logs are converted to the team format', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-bridge-hist-'));
  const id = '2026-01-01T00-00-00-000Z';
  fs.mkdirSync(path.join(dir, id));
  const lines = [
    { seq: 1, at: 1, kind: 'user', text: 'hello', to: ['claude'] },
    { seq: 2, at: 2, kind: 'delta', agent: 'codex', key: 'k', text: 'partial' },
    {
      seq: 3,
      at: 3,
      kind: 'state',
      mainId: 'claude',
      workDir: dir,
      agents: { claude: { sessionId: 's1', model: 'opus' }, codex: { sessionId: 't1' } },
    },
  ];
  fs.writeFileSync(path.join(dir, id, 'transcript.jsonl'), lines.map((l) => JSON.stringify(l)).join('\n'));
  const [summary] = history.listConversations(dir);
  assert.equal(summary.team.length, 2);
  assert.equal(summary.team[0].role, 'orchestrator');
  const loaded = history.loadConversation(dir, id);
  assert.equal(loaded.events.find((/** @type {any} */ e) => e.kind === 'user').to[0], 'a1');
  // the unfinished Codex turn is closed so the page does not show it as still streaming
  assert.ok(loaded.events.some((/** @type {any} */ e) => e.kind === 'turnEnd' && e.agent === 'a2'));
  const updatedState = {
    seq: 4,
    at: 4,
    kind: 'state',
    workDir: dir,
    team: loaded.team.map((/** @type {import('../src/core/types.ts').AgentSpec} */ member) =>
      member.id === 'a2' ? { ...member, driver: 'claude' } : member,
    ),
  };
  fs.appendFileSync(path.join(dir, id, 'transcript.jsonl'), '\n' + JSON.stringify(updatedState));
  const switched = history.loadConversation(dir, id);
  assert.equal(switched.team[1].driver, 'claude');
  assert.equal(
    switched.events.find((/** @type {import('../src/core/types.ts').BridgeEvent} */ event) => event.kind === 'delta').agent,
    'a2',
  );
});

test('history: malformed lines are skipped without losing the valid events', (t) => {
  const warn = t.mock.method(console, 'warn', () => {});
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-bridge-hist-'));
  const id = 'malformed-history';
  fs.mkdirSync(path.join(dir, id));
  fs.writeFileSync(
    path.join(dir, id, 'transcript.jsonl'),
    [
      JSON.stringify({ seq: 1, at: 1, kind: 'user', text: 'valid request' }),
      'null',
      '{}',
      JSON.stringify({ seq: 2, at: 2, kind: 'system', text: 'valid event' }),
      '{"kind":',
    ].join('\n'),
  );
  const loaded = history.loadConversation(dir, id);
  assert.equal(loaded.title, 'valid request');
  assert.deepEqual(
    loaded.events.map((/** @type {import('../src/core/types.ts').BridgeEvent} */ event) => event.seq),
    [1, 2],
  );
  assert.match(warn.mock.calls[0].arguments[0], /Skipped 3 invalid lines?/);
});

const { OpenCodeAgent } = await load('providers/opencode.ts');

test('opencode: only answer text is shown; reasoning and compaction summaries are not', () => {
  const agent = new OpenCodeAgent({ id: 'o1', name: 'OC', cwd: '.', config: {}, instructions: '' });
  agent.sessionId = 's1';
  /** @type {any[]} */
  const shown = [];
  agent.on('event', (/** @type {any} */ e) => {
    if (e.kind === 'delta' || e.kind === 'text' || e.kind === 'info') shown.push(e);
  });
  const ev = (/** @type {string} */ type, /** @type {any} */ properties) =>
    agent.onEvent({ type, properties: { sessionID: 's1', ...properties } });
  // A delta that arrives before its part is known waits, then shows once the part is an answer.
  ev('message.part.delta', { partID: 'p1', field: 'text', delta: 'Hello' });
  ev('message.updated', { info: { id: 'm1', role: 'assistant' } });
  ev('message.part.updated', { part: { id: 'p1', messageID: 'm1', type: 'text', text: 'Hello' } });
  // Reasoning streams through the same delta event and must stay hidden.
  ev('message.part.updated', { part: { id: 'r1', messageID: 'm1', type: 'reasoning', text: '' } });
  ev('message.part.delta', { partID: 'r1', field: 'text', delta: 'We need to think' });
  // A compaction: one notice, and the summary message is not shown as an answer.
  ev('message.part.updated', { part: { id: 'c1', messageID: 'm0', type: 'compaction', auto: true, overflow: true } });
  ev('message.updated', { info: { id: 'm2', role: 'assistant', summary: true } });
  ev('message.part.updated', { part: { id: 'p2', messageID: 'm2', type: 'text', text: '## Objective' } });
  ev('message.part.delta', { partID: 'p2', field: 'text', delta: '## Objective' });
  const texts = shown.filter((e) => e.kind !== 'info').map((e) => e.text);
  assert.deepEqual(texts, ['Hello', 'Hello']);
  assert.equal(shown.filter((e) => e.kind === 'info').length, 1);
});

test('opencode: lean roles block every skill except the allowed ones', () => {
  const lean = new OpenCodeAgent({ id: 'o2', name: 'OC', cwd: '.', config: {}, instructions: '', skillsOnly: ['tools:fetch-docs'] });
  const skills = lean.permissionRules().filter((/** @type {any} */ r) => r.permission === 'skill');
  assert.deepEqual(skills[0], { permission: 'skill', pattern: '*', action: 'deny' });
  assert.ok(skills.some((/** @type {any} */ r) => r.pattern === 'fetch-docs' && r.action === 'allow'));
  const full = new OpenCodeAgent({ id: 'o3', name: 'OC', cwd: '.', config: {}, instructions: '', skillsOff: ['p:long-task'] });
  const off = full.permissionRules().filter((/** @type {any} */ r) => r.permission === 'skill');
  assert.deepEqual(off.map((/** @type {any} */ r) => r.pattern).sort(), ['long-task', 'p:long-task']);
});

test('opencode: the final answer passed on skips compaction summaries and synthetic text', async () => {
  const run = async (/** @type {any} */ reply) => {
    const agent = new OpenCodeAgent({ id: 'o4', name: 'OC', cwd: '.', config: {}, instructions: '' });
    agent.sessionId = 's1';
    agent.http = async () => reply;
    /** @type {any[]} */
    const events = [];
    agent.on('event', (/** @type {any} */ e) => events.push(e));
    agent.queue.push({ text: 'hi', taskId: 'test-task' });
    await agent.pump();
    return { end: events.find((e) => e.kind === 'turnEnd'), shown: events.filter((e) => e.kind === 'text').map((e) => e.text) };
  };
  const normal = await run({
    info: { id: 'm1', role: 'assistant' },
    parts: [
      { id: 'a', type: 'text', text: 'The answer.' },
      { id: 'b', type: 'text', text: 'Continue if you have next steps', synthetic: true },
      { id: 'c', type: 'reasoning', text: 'thinking' },
    ],
  });
  assert.equal(normal.end.text, 'The answer.');
  assert.deepEqual(normal.shown, ['The answer.']);
  const summary = await run({
    info: { id: 'm2', role: 'assistant', summary: true },
    parts: [{ id: 'd', type: 'text', text: '## Objective' }],
  });
  assert.equal(summary.end.text, '');
  assert.deepEqual(summary.shown, []);
});
