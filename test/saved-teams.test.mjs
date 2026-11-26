import test from 'node:test';
import assert from 'node:assert/strict';
import { startBridge } from './helpers/bridge.mjs';
const team = [
  { name: 'Lead', driver: 'fake', role: 'orchestrator', bypass: true },
  { name: 'Dev', driver: 'fake', role: 'coder' },
];
test('named teams replace idle rosters atomically, retain history, and never restore bypass', async (t) => {
  const b = await startBridge({ team, rules: [] });
  t.after(() => b.stop());
  const initial = await b.waitFor((e) => e.kind === 'state' && e.team.every((a) => a.status.availability === 'ready'));
  const change = (operation, extra = {}) => b.api('manageTeam', { operation, name: 'Review', ...extra });
  const result = await change('save');
  assert.deepEqual(Object.keys(result.teams[0].members[0]).sort(), ['driver', 'effort', 'model', 'name', 'role']);
  await assert.rejects(change('save'), /Confirm replacement/);
  const apply = () => b.api('applyTeam', { name: 'Review', conversationId: initial.conversationId });
  assert.match((await apply()).pending.join(' '), /Pause/);
  await b.api('relay', { pause: true });
  await apply();
  const updated = await b.waitFor(
    (e) => e.kind === 'state' && e.team[0].id === 'a3' && e.team.every((a) => a.status.availability === 'ready'),
  );
  assert.equal(updated.team[0].bypass, false);
  assert.equal(updated.knownAgents.find((a) => a.id === 'a1').name, 'Lead');
  await change('default');
  await change('rename', { newName: 'Editing' });
  assert.equal((await b.api('teams')).defaultTeamName, 'Editing');
  await b.api('new', { teamName: 'Editing', workDir: b.work });
  const fresh = await b.waitFor((e) => e.kind === 'state' && e.conversationId !== initial.conversationId && e.team[0].id === 'a1');
  assert.equal(fresh.team[0].bypass, false);
  await b.api('manageTeam', { operation: 'delete', name: 'Editing', confirm: true });
  assert.equal((await b.api('teams')).defaultTeamName, null);
});
test('an unknown role stays unavailable until a valid role is chosen', async (t) => {
  const b = await startBridge({ team: [{ driver: 'fake', role: 'obsolete', name: 'Reader', bypass: true }], rules: [] });
  t.after(() => b.stop());
  const initial = await b.waitFor((e) => e.kind === 'state' && e.team[0]?.unavailableReason?.includes('obsolete'));
  assert.equal(initial.team[0].available, false);
  assert.equal(initial.team[0].bypass, false);
  await b.api('role', { agent: 'a1', role: 'researcher' });
  await b.waitFor((e) => e.kind === 'state' && e.team[0]?.role === 'researcher' && e.team[0].available);
});
