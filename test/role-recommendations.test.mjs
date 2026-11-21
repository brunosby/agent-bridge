import test from 'node:test';
import assert from 'node:assert/strict';
import { parseRoleMarkers } from '../public/js/core/role-markers.js';
import { startBridge } from './helpers/bridge.mjs';

const team = [
  { driver: 'fake', name: 'Lead', role: 'orchestrator' },
  { driver: 'fake', name: 'Dev', role: 'coder' },
];
const recommendation =
  'I can make a plan.\n[[RECOMMEND_ROLES]]\nreviewer: review changes\ntester: test changes\ncoder: exists\nunknown: invalid\n[[/RECOMMEND_ROLES]]';

test('role markers can be split across deltas without exposing their content', () => {
  assert.equal(parseRoleMarkers('Response\n[[RECOM').text, 'Response\n');
  assert.equal(parseRoleMarkers('Response\n[[RECOMMEND_ROLES]]\nreviewer: reason').text, 'Response\n');
  assert.deepEqual(
    parseRoleMarkers(recommendation).roles.map((role) => role.id),
    ['reviewer', 'tester', 'coder', 'unknown'],
  );
});

test('the orchestrator offers only valid missing roles and additions report partial startup failures', async () => {
  const bridge = await startBridge({
    team,
    rules: [],
    settings: {
      fake: {
        failRoleStartup: 'Agent-Tester',
        rules: [
          { agent: 'Lead', match: 'Role decision completed', reply: 'Continuing with the available team.' },
          { agent: 'Lead', match: 'substantial objective', reply: recommendation },
        ],
      },
    },
  });
  try {
    await bridge.api('send', { text: 'substantial objective' });
    const request = await bridge.waitFor((event) => event.kind === 'recommendRoles');
    assert.deepEqual(
      request.roles.map((role) => role.id),
      ['reviewer', 'tester'],
    );
    assert.ok(
      bridge.events
        .filter((event) => event.kind === 'turnEnd' || event.kind === 'text')
        .every((event) => !event.text.includes('[[RECOMMEND_ROLES]]')),
    );
    await assert.rejects(
      bridge.api('resolveRecommendedRoles', { requestId: request.requestId, selected: ['unknown'] }),
      /invalid recommended roles/,
    );
    const { results } = await bridge.api('resolveRecommendedRoles', { requestId: request.requestId, selected: ['reviewer', 'tester'] });
    assert.deepEqual(
      results.map(({ role, ok }) => [role, ok]),
      [
        ['reviewer', true],
        ['tester', false],
      ],
    );
    const failedState = await bridge.waitFor(
      (event) =>
        event.kind === 'state' && event.team.some((agent) => agent.role === 'tester' && agent.status.availability === 'startup_failed'),
    );
    const failed = failedState.team.find((agent) => agent.role === 'tester');
    assert.equal(failed.status.availability, 'startup_failed');
    await bridge.api('retry', { agent: failed.id });
    await bridge.waitFor(
      (event) => event.kind === 'state' && event.team.some((agent) => agent.id === failed.id && agent.status.availability === 'ready'),
    );
    await assert.rejects(bridge.api('resolveRecommendedRoles', { requestId: request.requestId, selected: [] }), /no longer pending/);
  } finally {
    await bridge.stop();
  }
});

test('dismissing role requests preserves a manual pause and resume closes the pending card', async () => {
  const bridge = await startBridge({ team, rules: [{ agent: 'Lead', match: 'needs review', reply: '[[NEED_ROLE: reviewer]]' }] });
  try {
    await bridge.api('send', { text: 'needs review' });
    const first = await bridge.waitFor((event) => event.kind === 'needRole');
    await bridge.api('relay', { pause: true });
    await bridge.api('resolveRole', { action: 'dismiss', requestId: first.requestId });
    await bridge.waitFor((event) => event.kind === 'state' && event.relay.userPaused && event.relay.halted);
    await bridge.api('send', { text: 'needs review again' });
    const second = await bridge.waitFor((event) => event.kind === 'needRole' && event.requestId !== first.requestId);
    await bridge.api('relay', { resume: true });
    await bridge.waitFor((event) => event.kind === 'needRoleClosed' && event.requestId === second.requestId && event.action === 'resume');
  } finally {
    await bridge.stop();
  }
});

test('a declined role is not offered again and the recommendation setting suppresses offers', async () => {
  const rules = [{ agent: 'Lead', match: 'substantial objective', reply: recommendation }];
  const bridge = await startBridge({ team, rules });
  try {
    await bridge.api('send', { text: 'substantial objective one' });
    const request = await bridge.waitFor((event) => event.kind === 'recommendRoles');
    await bridge.api('resolveRecommendedRoles', { requestId: request.requestId, selected: [] });
    await bridge.waitFor((event) => event.kind === 'recommendRolesClosed' && event.requestId === request.requestId);
    const run = await bridge.api('send', { text: 'substantial objective two' });
    assert.equal(run.ok, true);
    const start = await bridge.waitFor((event) => event.kind === 'user' && event.text === 'substantial objective two');
    await bridge.waitFor((event) => event.seq > start.seq && event.kind === 'turnEnd');
    assert.equal(bridge.events.filter((event) => event.kind === 'recommendRoles').length, 1);
    await bridge.api('settings', { recommendRoles: 'off' });
    await bridge.api('new', { workDir: bridge.work });
    await bridge.api('send', { text: 'substantial objective with setting off' });
    const disabled = await bridge.waitFor((event) => event.kind === 'user' && event.text === 'substantial objective with setting off');
    await bridge.waitFor((event) => event.seq > disabled.seq && event.kind === 'turnEnd');
    assert.equal(bridge.events.filter((event) => event.kind === 'recommendRoles').length, 1);
  } finally {
    await bridge.stop();
  }
});

test('customized recommendations validate the whole batch and keep invalid requests open', async () => {
  const bridge = await startBridge({
    team,
    rules: [{ agent: 'Lead', match: 'substantial objective', reply: recommendation }],
  });
  try {
    await bridge.api('send', { text: 'substantial objective' });
    const request = await bridge.waitFor((event) => event.kind === 'recommendRoles');
    const resolve = (selected) => bridge.api('resolveRecommendedRoles', { requestId: request.requestId, selected });
    const duplicate = await resolve([
      { role: 'reviewer', name: 'Peer' },
      { role: 'tester', name: 'peer' },
    ]);
    assert.equal(duplicate.invalid.role, 'tester');
    assert.match(duplicate.invalid.reason, /same name/);
    const unsupported = await resolve([
      { role: 'reviewer', name: 'Peer' },
      { role: 'tester', model: 'fake-small', effort: 'high' },
    ]);
    assert.equal(unsupported.invalid.role, 'tester');
    assert.match(unsupported.invalid.reason, /does not support this effort/);
    assert.equal(bridge.state().team.length, team.length);
    assert.ok(!bridge.events.some((event) => event.kind === 'recommendRolesClosed'));
    await assert.rejects(bridge.api('addAgent', { role: 'reviewer', driver: 'fake', model: 'missing' }), /selected model is unavailable/);
    const chosen = { role: 'reviewer', name: 'Peer', model: 'fake-large', effort: 'high', bypass: true };
    const { results } = await resolve([chosen, { role: 'tester' }]);
    assert.ok(results.every((item) => item.ok));
    const state = await bridge.waitFor((event) => event.kind === 'state' && event.team.some((agent) => agent.name === 'Peer'));
    const member = state.team.find((agent) => agent.name === 'Peer');
    for (const [key, value] of Object.entries(chosen)) assert.equal(member[key], value);
  } finally {
    await bridge.stop();
  }
});

test('a missing-role request stays open when choices are invalid and accepts corrected values', async () => {
  const bridge = await startBridge({
    team,
    rules: [{ agent: 'Lead', match: 'need a check', reply: '[[NEED_ROLE: reviewer]]' }],
  });
  try {
    await bridge.api('send', { text: 'need a check' });
    const request = await bridge.waitFor((event) => event.kind === 'needRole');
    const decide = (choice) => bridge.api('resolveRole', { requestId: request.requestId, action: 'add', ...choice });
    const bad = await decide({ name: 'Lead' });
    assert.equal(bad.invalid.role, 'reviewer');
    assert.equal(bridge.state().team.length, team.length);
    assert.ok(!bridge.events.some((event) => event.kind === 'needRoleClosed'));
    await decide({ name: 'Quality', model: 'fake-large', effort: 'low' });
    const state = await bridge.waitFor((event) => event.kind === 'state' && event.team.some((agent) => agent.name === 'Quality'));
    assert.equal(state.team.find((agent) => agent.name === 'Quality').effort, 'low');
  } finally {
    await bridge.stop();
  }
});
