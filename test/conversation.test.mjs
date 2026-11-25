// @ts-check
// End-to-end tests of the conversation flow, using the scripted "fake" provider (no CLIs, no tokens).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { startBridge } from './helpers/bridge.mjs';

const team3 = [
  { driver: 'fake', role: 'orchestrator', name: 'Lead' },
  { driver: 'fake', role: 'coder', name: 'Dev' },
  { driver: 'fake', role: 'researcher', name: 'Res' },
];

test('orchestrator delegates in parallel, gets both results in one message, then asks for final approval', async () => {
  const b = await startBridge({
    team: team3,
    rules: [
      { agent: 'Lead', match: 'Results from 2 agents', reply: 'Built and researched.\n[[DONE]]' },
      { agent: 'Lead', match: 'Message from Tester', reply: '@Dev build it\n@Res look it up' },
      { agent: 'Dev', reply: 'built', edit: true },
      { agent: 'Res', reply: 'found' },
    ],
  });
  try {
    await b.waitFor((e) => e.kind === 'state' && e.team.length === 3);
    await b.api('send', { text: 'please do the task', target: 'auto' });
    const user = await b.waitFor((e) => e.kind === 'user');
    assert.deepEqual(user.to.map(b.nameOf), ['Lead']);

    await b.waitFor((e) => e.kind === 'batchProgress' && e.pending.length === 1);
    await b.waitFor((e) => e.kind === 'batchCompleted' && e.agents.length === 2);
    const final = await b.waitFor((e) => e.kind === 'finalReview');
    assert.match(final.summary, /Built and researched/);

    const routes = b.events.filter((e) => e.kind === 'routed').map((e) => `${b.nameOf(e.from)}>${b.nameOf(e.to)}`);
    assert.ok(routes.includes('Lead>Dev') && routes.includes('Lead>Res'), routes.join(','));
    // fan-in: one delivery back to the orchestrator for the two results
    assert.equal(routes.filter((r) => r.endsWith('>Lead')).length, 1, routes.join(','));
    assert.ok(b.events.some((e) => e.kind === 'system' && /Waiting for/.test(e.text)));

    await b.api('finalReview', { requestId: final.requestId, action: 'approve' });
    await b.waitFor((e) => e.kind === 'system' && /approved the result/.test(e.text));
  } finally {
    await b.stop();
  }
});

test('review loop stops after the configured number of rounds', async () => {
  const b = await startBridge({
    team: [
      { driver: 'fake', role: 'orchestrator', name: 'Lead' },
      { driver: 'fake', role: 'coder', name: 'Dev' },
      { driver: 'fake', role: 'reviewer', name: 'Rev' },
    ],
    settings: { maxReviewRounds: 1, maxHops: 50 },
    rules: [
      { agent: 'Lead', match: 'limit \\(1\\) reached', reply: 'Open findings remain.\n[[DONE]]' },
      { agent: 'Lead', match: 'Message from @a3', reply: '@Dev fix the findings' },
      { agent: 'Lead', match: 'Message from @a2', reply: '@Rev review it' },
      { agent: 'Lead', match: 'Message from Tester', reply: '@Dev build it' },
      { agent: 'Dev', reply: 'done', edit: true },
      { agent: 'Rev', reply: 'CHANGES REQUESTED\n- fix x\n[[SUMMARY]]\nFix the missing check.\n[[/SUMMARY]]' },
    ],
  });
  try {
    await b.api('send', { text: 'build', target: 'auto' });
    await b.waitFor((e) => e.kind === 'system' && /still requests changes after 1/.test(e.text));
    const final = await b.waitFor((e) => e.kind === 'finalReview');
    assert.match(final.summary, /Open findings/);
  } finally {
    await b.stop();
  }
});

test('missing role: continue with the closest agent, or add the role', async () => {
  const b = await startBridge({
    team: [
      { driver: 'fake', role: 'orchestrator', name: 'Lead' },
      { driver: 'fake', role: 'coder', name: 'Dev' },
    ],
    rules: [
      { agent: 'Lead', match: 'No Reviewer will be added', reply: 'ok then\n[[DONE]]', edit: true },
      { agent: 'Lead', match: 'as Reviewer', reply: 'thanks\n[[DONE]]', edit: true },
      { agent: 'Lead', match: 'Message from Tester', reply: '[[NEED_ROLE: reviewer]]' },
    ],
  });
  try {
    await b.api('send', { text: 'needs review', target: 'auto' });
    const need = await b.waitFor((e) => e.kind === 'needRole');
    assert.equal(need.role, 'reviewer');
    await b.api('resolveRole', { requestId: need.requestId, action: 'closest' });
    await b.waitFor((e) => e.kind === 'finalReview');

    await b.api('send', { text: 'again', target: 'auto' });
    const need2 = await b.waitFor((e) => e.kind === 'needRole' && e.requestId !== need.requestId);
    await b.api('resolveRole', { requestId: need2.requestId, action: 'add' });
    await b.waitFor((e) => e.kind === 'state' && e.team.some((/** @type {any} */ a) => a.role === 'reviewer'));
  } finally {
    await b.stop();
  }
});

test('a message that starts with @Name goes to that agent', async () => {
  const b = await startBridge({ team: team3, rules: [{ reply: 'hi' }] });
  try {
    await b.api('send', { text: '@Res hello', target: 'auto' });
    const user = await b.waitFor((e) => e.kind === 'user');
    assert.deepEqual(user.to.map(b.nameOf), ['Res']);
  } finally {
    await b.stop();
  }
});

test('settings are saved to config.local.json, not config.json', async () => {
  const b = await startBridge({ team: team3, rules: [] });
  try {
    const before = fs.readFileSync(path.join(b.root, 'config.json'), 'utf8');
    await b.api('settings', { tokenLimit: 1234 });
    assert.equal(fs.readFileSync(path.join(b.root, 'config.json'), 'utf8'), before);
    const local = JSON.parse(fs.readFileSync(path.join(b.root, 'config.local.json'), 'utf8'));
    assert.equal(local.tokenLimit, 1234);
  } finally {
    await b.stop();
  }
});

test('restore brings back the team, models and messages', async () => {
  const rules = [{ agent: 'Lead', reply: 'done\n[[DONE]]', edit: true }];
  const b = await startBridge({ team: team3, rules });
  let root = '';
  try {
    root = b.root;
    await b.waitFor((e) => e.kind === 'state' && e.team.length === 3);
    const dev = b.state().team.find((/** @type {any} */ a) => a.name === 'Dev');
    await b.api('model', { agent: dev.id, model: 'fake-small' });
    await b.api('send', { text: 'remember me', target: 'auto' });
    await b.waitFor((e) => e.kind === 'finalReview');
    await b.waitFor((e) => e.kind === 'state' && e.team.find((/** @type {any} */ a) => a.name === 'Dev')?.model === 'fake-small');
  } finally {
    await b.stop();
  }
  const r = await startBridge({ team: [], rules, resume: true, dir: root });
  try {
    const st = await r.waitFor((e) => e.kind === 'state' && e.team.length === 3);
    assert.deepEqual(
      st.team.map((/** @type {any} */ a) => a.name),
      ['Lead', 'Dev', 'Res'],
    );
    assert.equal(st.team.find((/** @type {any} */ a) => a.name === 'Dev').model, 'fake-small');
    await r.waitFor((e) => e.kind === 'user' && e.text === 'remember me');
  } finally {
    await r.stop();
  }
});

test('an answer without file changes ends without the final approval card', async () => {
  const b = await startBridge({
    team: [{ driver: 'fake', role: 'orchestrator', name: 'Lead' }],
    rules: [
      { agent: 'Lead', match: 'try an edit', reply: 'Edit failed.\n[[DONE]]', edit: 'failed' },
      { agent: 'Lead', reply: 'The answer is 42.\n[[DONE]]' },
    ],
  });
  try {
    await b.waitFor((e) => e.kind === 'state' && e.team.length === 1);
    await b.api('send', { text: 'what is the answer?' });
    const first = await b.waitFor((e) => e.kind === 'system' && /nothing to approve/.test(e.text));
    await b.api('send', { text: 'try an edit' });
    await b.waitFor((e) => e.seq > first.seq && e.kind === 'system' && /nothing to approve/.test(e.text));
    assert.ok(!b.events.some((e) => e.kind === 'finalReview'));
  } finally {
    await b.stop();
  }
});

test('a failed restore preserves the active session and concurrent switches finish in order', async () => {
  const bridge = await startBridge({ team: [team3[0]], rules: [] });
  try {
    const { conversationId } = await bridge.waitFor((event) => event.kind === 'state');
    const saved = path.join(bridge.logs, 'moved');
    fs.mkdirSync(saved);
    const rows = [
      { kind: 'state', workDir: path.join(bridge.root, 'missing-folder'), team: [team3[0]] },
      { kind: 'user', text: 'saved message' },
    ];
    fs.writeFileSync(path.join(saved, 'transcript.jsonl'), rows.map((row) => JSON.stringify(row)).join('\n') + '\n');
    await assert.rejects(bridge.api('restore', { id: 'moved' }), /Working directory does not exist/);
    assert.equal((await bridge.api('conversations')).current, conversationId);
    await bridge.api('send', { text: 'still active' });
    await bridge.waitFor((event) => event.kind === 'user' && event.text === 'still active');
    const dirs = ['one', 'two'].map((name) => path.join(bridge.root, name));
    for (const dir of dirs) fs.mkdirSync(dir);
    await Promise.all(dirs.map((workDir) => bridge.api('new', { workDir })));
    const current = (await bridge.api('conversations')).current;
    const state = await bridge.waitFor((event) => event.kind === 'state' && event.conversationId === current);
    assert.ok(dirs.includes(state.workDir));
    const opened = bridge.events.filter((event) => event.kind === 'state' && dirs.includes(event.workDir));
    assert.equal(new Set(opened.map((event) => event.conversationId)).size, 2);
  } finally {
    await bridge.stop();
  }
});

test('graceful shutdown saves the final event before the process exits', async () => {
  const bridge = await startBridge({ team: [team3[0]], rules: [] });
  try {
    const { conversationId } = await bridge.waitFor((event) => event.kind === 'state');
    const exit = new Promise((resolve) => bridge.child.once('exit', resolve));
    await bridge.api('quit');
    assert.equal(await exit, 0);
    const events = fs
      .readFileSync(path.join(bridge.logs, conversationId, 'transcript.jsonl'), 'utf8')
      .trimEnd()
      .split('\n')
      .map((line) => JSON.parse(line));
    assert.ok(events.some((event) => event.kind === 'system' && event.text.startsWith('Agent Bridge is closing.')));
  } finally {
    await bridge.stop();
  }
});
