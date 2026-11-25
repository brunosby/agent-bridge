import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { startBridge } from './helpers/bridge.mjs';

const team = [
  { driver: 'fake', role: 'orchestrator', name: 'Lead' },
  { driver: 'fake', role: 'coder', name: 'Dev' },
];
const newDriver = 'fake-alternate';
const member = (state, id) => state.team.find((agent) => agent.id === id);
const idle = (bridge, id, after = 0) =>
  bridge.waitFor((event) => event.kind === 'state' && event.seq > after && member(event, id)?.available && !member(event, id).busy);

test('provider change keeps identity, worktree and usage and sends the handoff on the first confirmed delivery', async () => {
  const rules = [
    { agent: 'Dev', match: 'before the switch', reply: 'previous reply' },
    { agent: 'Lead', match: 'provider Alternate Fake', reply: 'updated team roster' },
  ];
  const alternateRules = [
    {
      agent: 'Dev',
      match: '\\[Provider handoff\\][\\s\\S]*before the switch[\\s\\S]*previous reply[\\s\\S]*first new input',
      reply: 'context received',
    },
    { agent: 'Dev', match: '\\[Provider handoff\\]', reply: 'unexpected repeated handoff' },
    { agent: 'Dev', reply: 'new input without handoff' },
  ];
  const bridge = await startBridge({ team: [team[0]], rules, settings: { autoRelay: false, 'fake-alternate': { rules: alternateRules } } });
  try {
    const git = (...args) => execFileSync('git', args, { cwd: bridge.work, stdio: 'pipe' });
    git('init');
    git('-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '--allow-empty', '-m', 'baseline');
    const { agent } = await bridge.api('addAgent', { ...team[1], bypass: true, worktree: true });
    const initial = await idle(bridge, agent.id);
    await bridge.api('send', { target: agent.id, text: 'before the switch' });
    const reply = await bridge.waitFor((event) => event.kind === 'turnEnd' && event.agent === agent.id);
    const beforeSwitch = await idle(bridge, agent.id, reply.seq);
    await assert.rejects(bridge.api('changeProvider', { agent: agent.id, driver: newDriver, model: 'invalid' }), /unavailable/);
    await assert.rejects(
      bridge.api('changeProvider', { agent: agent.id, driver: newDriver, model: 'fake-small', effort: 'high' }),
      /effort/,
    );
    assert.equal(member(bridge.state(), agent.id).driver, 'fake');
    const result = await bridge.api('changeProvider', { agent: agent.id, driver: newDriver, model: 'fake-large', effort: 'high' });
    assert.equal(result.ready, true);
    const switched = await idle(bridge, agent.id, beforeSwitch.seq);
    const old = member(initial, agent.id);
    const updated = member(switched, agent.id);
    assert.equal(updated.driver, newDriver);
    for (const field of ['id', 'name', 'role', 'cwd', 'worktree', 'bypass']) assert.deepEqual(updated[field], old[field]);
    assert.notEqual(updated.sessionId, old.sessionId);
    assert.equal(updated.model, 'fake-large');
    assert.equal(updated.effort, 'high');
    assert.equal(updated.tokens, 100);
    assert.equal(switched.totalTokens, 100);
    assert.equal(switched.knownAgents.find(({ id }) => id === agent.id).driver, newDriver);

    await bridge.api('send', { target: agent.id, text: 'first new input' });
    const handedOff = await bridge.waitFor((event) => event.kind === 'turnEnd' && event.text === 'context received');
    const afterHandoff = await idle(bridge, agent.id, handedOff.seq);
    assert.equal(afterHandoff.totalTokens, 200);
    await bridge.api('send', { target: agent.id, text: 'after-confirmation' });
    await bridge.waitFor((event) => event.kind === 'text' && event.text === 'new input without handoff');
    await bridge.api('send', { target: 'a1', text: 'check roster' });
    await bridge.waitFor((event) => event.kind === 'text' && event.text === 'updated team roster');

    const transcript = readFileSync(path.join(bridge.logs, switched.conversationId, 'transcript.jsonl'), 'utf8');
    const handoff = transcript
      .split('\n')
      .filter(Boolean)
      .map(JSON.parse)
      .find((event) => event.kind === 'providerHandoff');
    assert.deepEqual(handoff.previous, { driver: 'fake', sessionId: old.sessionId });
    assert.ok(!bridge.events.some((event) => event.kind.startsWith('providerHandoff')));
  } finally {
    await bridge.stop();
  }
});

test('a failed first delivery preserves the handoff and session usage across restore', async () => {
  const rules = [
    { match: '\\[Provider handoff\\][\\s\\S]*saved request[\\s\\S]*try again', reply: 'restored context' },
    { match: 'saved request', reply: 'old session context' },
  ];
  const settings = { autoRelay: false, 'fake-alternate': { rejectFirstInput: true } };
  let bridge = await startBridge({ team, rules, settings });
  try {
    await idle(bridge, 'a2');
    await bridge.api('send', { target: 'a2', text: 'saved request' });
    const old = await bridge.waitFor((event) => event.kind === 'turnEnd' && event.agent === 'a2');
    await idle(bridge, 'a2', old.seq);
    await bridge.api('changeProvider', { agent: 'a2', driver: newDriver });
    await bridge.api('send', { target: 'a2', text: 'initial delivery' });
    const failed = await bridge.waitFor((event) => event.kind === 'turnEnd' && event.agent === 'a2' && !event.ok);
    const state = await idle(bridge, 'a2', failed.seq);
    const session = member(state, 'a2').sessionId;
    await bridge.stop();
    bridge = await startBridge({ dir: bridge.root, team, rules, settings: { autoRelay: false }, resume: state.conversationId });
    const restored = await idle(bridge, 'a2');
    assert.equal(member(restored, 'a2').sessionId, session);
    assert.equal(restored.totalTokens, 100);
    await bridge.api('send', { target: 'a2', text: 'try again' });
    const received = await bridge.waitFor((event) => event.kind === 'turnEnd' && event.text === 'restored context');
    assert.equal((await idle(bridge, 'a2', received.seq)).totalTokens, 200);
  } finally {
    await bridge.stop();
  }
});

test('a batch finishing during an orchestrator provider change reaches the new session', async () => {
  const rules = [
    { agent: 'Lead', match: 'start', reply: '@a2 build' },
    { agent: 'Dev', reply: 'batch result', waitForFile: 'release-worker' },
  ];
  const bridge = await startBridge({
    team,
    rules,
    settings: {
      fake: { rules },
      'fake-alternate': {
        startWhenFile: 'release-start',
        rules: [{ match: '\\[Provider handoff\\][\\s\\S]*batch result', reply: 'batch received' }],
      },
    },
  });
  try {
    await idle(bridge, 'a1');
    await bridge.api('send', { text: 'start' });
    await bridge.waitFor((event) => event.kind === 'taskQueued' && event.agent === 'a2');
    const changing = bridge.api('changeProvider', { agent: 'a1', driver: newDriver });
    try {
      const reserved = await bridge.waitFor(
        (event) => event.kind === 'state' && member(event, 'a1')?.status.availability === 'switching_provider',
      );
      writeFileSync(path.join(bridge.work, 'release-worker'), '');
      const completed = await bridge.waitFor((event) => event.kind === 'batchCompleted');
      assert.ok(completed.seq > reserved.seq);
      assert.equal(bridge.events.filter((event) => event.kind === 'routed' && event.to === 'a1').length, 0);
      await assert.rejects(bridge.api('changeProvider', { agent: 'a1', driver: 'fake' }), /switching provider|different provider/);
    } finally {
      writeFileSync(path.join(bridge.work, 'release-start'), '');
      assert.equal((await changing).ready, true);
    }
    await bridge.waitFor((event) => event.kind === 'turnEnd' && event.text === 'batch received');
    assert.equal(bridge.events.filter((event) => event.kind === 'routed' && event.to === 'a1').length, 1);
  } finally {
    await bridge.stop();
  }
});

test('a busy agent refuses a switch and a failed startup closes queued deliveries and can be retried', async () => {
  const rules = [
    { agent: 'Dev', match: 'work in progress', reply: 'working', waitForFile: 'release-work' },
    { agent: 'Lead', match: 'delegate', reply: '@a2 build', waitForFile: 'release-delegation' },
    { agent: 'Lead', match: 'not delivered', reply: 'handled failed delivery' },
  ];
  const bridge = await startBridge({
    team,
    rules,
    settings: { fake: { rules }, 'fake-alternate': { failRoleStartup: 'Dev', startWhenFile: 'release-start' } },
  });
  try {
    await idle(bridge, 'a2');
    await bridge.api('send', { target: 'a2', text: 'work in progress' });
    await bridge.waitFor((event) => event.kind === 'taskStarted' && event.agent === 'a2');
    await assert.rejects(bridge.api('changeProvider', { agent: 'a2', driver: newDriver }), /Use Stop/);
    await bridge.api('interrupt', { agent: 'a2' });
    await bridge.api('send', { text: 'delegate' });
    const changing = bridge.api('changeProvider', { agent: 'a2', driver: newDriver });
    try {
      await bridge.waitFor((e) => e.kind === 'state' && member(e, 'a2')?.status.availability === 'switching_provider');
      writeFileSync(path.join(bridge.work, 'release-delegation'), '');
      await bridge.waitFor((e) => e.kind === 'turnEnd' && e.text === '@a2 build');
    } finally {
      writeFileSync(path.join(bridge.work, 'release-start'), '');
    }
    assert.equal((await changing).ready, false);
    await bridge.waitFor((event) => event.kind === 'state' && member(event, 'a2')?.status.availability === 'startup_failed');
    await bridge.waitFor((event) => event.kind === 'text' && event.text === 'handled failed delivery');
    await bridge.api('retry', { agent: 'a2' });
    await bridge.waitFor((event) => event.kind === 'state' && member(event, 'a2')?.driver === newDriver && member(event, 'a2').available);
  } finally {
    await bridge.stop();
  }
});
