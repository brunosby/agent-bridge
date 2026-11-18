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
      { agent: 'Dev', reply: 'built' },
      { agent: 'Res', reply: 'found' },
    ],
  });
  try {
    await b.waitFor((e) => e.kind === 'state' && e.team.length === 3);
    await b.api('send', { text: 'please do the task', target: 'auto' });
    const user = await b.waitFor((e) => e.kind === 'user');
    assert.deepEqual(user.to.map(b.nameOf), ['Lead']);

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
      { agent: 'Lead', match: 'Message from Rev', reply: '@Dev fix the findings' },
      { agent: 'Lead', match: 'Message from Dev', reply: '@Rev review it' },
      { agent: 'Lead', match: 'Message from Tester', reply: '@Dev build it' },
      { agent: 'Dev', reply: 'done' },
      { agent: 'Rev', reply: 'CHANGES REQUESTED\n- fix x' },
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
      { agent: 'Lead', match: 'No Reviewer will be added', reply: 'ok then\n[[DONE]]' },
      { agent: 'Lead', match: 'as Reviewer', reply: 'thanks\n[[DONE]]' },
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
  const rules = [{ agent: 'Lead', reply: 'done\n[[DONE]]' }];
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
