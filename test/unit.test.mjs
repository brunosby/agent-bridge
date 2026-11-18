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
  assert.match(t, /@Lead: Orchestrator \(read-only\).*\(you\)/);
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
});
