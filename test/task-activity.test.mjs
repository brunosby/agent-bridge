import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { describeActivity } from '../src/core/activity-description.ts';
import { observeProgress, progressView, restoreProgress } from '../src/server/request-progress.ts';
import { activityPublisher } from '../src/server/task-activity.ts';
import { startBridge } from './helpers/bridge.mjs';

test('provider tool descriptions use bounded, safe input fields and project-relative paths', () => {
  const root = path.resolve('test-project');
  const describe = (name, detail) => describeActivity(name, detail, root).text;
  assert.equal(describe('Edit', path.join(root, 'src', 'file.ts')), 'Editing src/file.ts');
  assert.equal(describe('edit', 'update src/file.ts\nadd src/new.ts'), 'Editing src/file.ts +1 files');
  assert.equal(describe('read', path.join(root, '..', 'other.txt')), 'Reading outside the project');
  assert.equal(describe('Write', JSON.stringify({ filePath: 'app.ts', content: 'private body' })), 'Editing app.ts');
  assert.equal(describe('Bash', 'npm test'), 'Running tests');
  assert.equal(describe('PowerShell', 'git status\nprivate output'), 'Running git status');
  assert.equal(describe('shell', 'AUTH="private value" git status --token private'), 'Running git status');
  assert.equal(describe('bash', 'echo "private payload"'), 'Running echo');
  assert.equal(describe('WebFetch', 'https://user:pass@example.org/private?token=secret'), 'Fetching example.org');
  assert.equal(describe('web search', 'private query'), 'Searching the web');
  assert.equal(describe('Grep', 'needle in ' + root), "Searching 'needle'");
  assert.equal(
    describe('Task', JSON.stringify({ description: 'Check types', prompt: 'private body' })),
    'Running a sub-agent: Check types',
  );
  assert.equal(describe('mcp__bridge__bridge_diff', 'private body'), 'Reviewing the diff');
  assert.equal(describe('docs.lookup', 'private body'), 'Using lookup (docs)');
  assert.equal(describe('unknown', JSON.stringify({ content: 'private body' })), 'Using unknown');
  assert.ok(describe('Glob', 'a'.repeat(200)).length <= 60);
});

const owner = () => ({ id: 'sample', tasks: new Map(), agents: {}, team: [], heldRelays: [], workDir: path.resolve('test-project') });
function batch(c) {
  const events = [];
  const emit = (kind, data = {}) => {
    const event = { at: Date.now(), kind, agent: 'a1', ...data };
    events.push(event);
    return observeProgress(c, event);
  };
  emit('user', { seq: 1, text: 'Check files' });
  for (const id of ['x', 'y', 'z']) emit('taskQueued', { requestSeq: 1, id, role: 'coder' });
  emit('taskStarted', { taskIds: ['x', 'y'] });
  return { emit, events };
}

test('activity follows working tasks, keeps simultaneous approvals, counts successful distinct edits and restores the last action', () => {
  const c = owner(),
    { emit, events } = batch(c);
  const tasks = () => progressView(c, [])[0].tasks;
  emit('tool', { key: '1', title: 'Edit', detail: 'app.ts' });
  emit('toolResult', { key: '1', ok: true });
  emit('tool', { key: '2', title: 'Edit', detail: 'app.ts' });
  emit('toolResult', { key: '2', ok: true });
  emit('tool', { key: '3', title: 'Write', detail: 'failed.ts' });
  emit('toolResult', { key: '3', ok: false, detail: 'private output' });
  emit('approval', { requestId: 'p', shellCommand: { text: 'git status' } });
  emit('approval', { requestId: 'q' });
  emit('delta', { text: 'private reply' });
  assert.equal(tasks()[0].now.text, 'Waiting for your approval: git status');
  emit('approvalClosed', { agent: undefined, requestId: 'p' });
  assert.equal(tasks()[0].now.text, 'Waiting for your approval');
  emit('approvalClosed', { requestId: 'q' });
  assert.equal(tasks()[0].now.text, 'Writing the reply');
  emit('tool', { key: '4', title: 'Read', detail: 'src/a.ts' });
  emit('delta', { text: 'second fragment' });
  for (const task of tasks().slice(0, 2)) {
    assert.equal(task.now.text, 'Reading src/a.ts');
    assert.equal(task.actions, 4);
    assert.equal(task.files, 1);
  }
  assert.equal(tasks()[2].actions, undefined);
  const restored = owner();
  restoreProgress(restored, events);
  const [task] = progressView(restored, [])[0].tasks;
  assert.equal(task.state, 'interrupted');
  assert.equal(task.now.text, 'Reading src/a.ts');
  assert.equal(task.files, 1);
});

test('activity events coalesce by agent, using the most recent action after one second', (t) => {
  t.mock.timers.enable({ apis: ['Date', 'setTimeout'], now: 1000 });
  const c = owner(),
    { emit } = batch(c);
  const sent = [];
  const push = activityPublisher((_owner, event) => sent.push(event));
  const tool = (title, detail) => {
    emit('tool', { title, detail });
    push(c, 'a1');
  };
  tool('Edit', 'one.ts');
  tool('Read', 'one.ts');
  tool('Read', 'two.ts');
  t.mock.timers.tick(999);
  assert.equal(sent.length, 1);
  t.mock.timers.tick(1);
  assert.equal(sent.length, 2);
  assert.equal(sent[1].text, 'Reading two.ts');
  assert.deepEqual(sent[1].taskIds, ['x', 'y']);
  assert.equal(sent[1].actions, 3);
  push(c, 'a1');
  t.mock.timers.tick(1000);
  assert.equal(sent.length, 2);
  tool('Read', 'two.ts');
  t.mock.timers.tick(1000);
  assert.equal(sent.at(-1).actions, 4);
});

test('live snapshots and activity reach clients, but only restore checkpoints and original tool events reach disk', async (t) => {
  const b = await startBridge({
    team: [{ name: 'Dev', driver: 'fake', role: 'coder' }],
    rules: [{ edit: true, reply: 'Done' }],
    settings: { autoRelay: false },
  });
  t.after(() => b.stop());
  const ready = await b.waitFor((e) => e.kind === 'state' && e.team[0]?.available && e.team[0]?.sessionId);
  const file = path.join(b.logs, ready.conversationId, 'transcript.jsonl');
  const rows = async () =>
    (await fs.readFile(file, 'utf8'))
      .trim()
      .split('\n')
      .map((s) => JSON.parse(s));
  await b.api('send', { target: 'a1', text: 'Edit the sample' });
  const activity = await b.waitFor((e) => e.kind === 'activity');
  assert.equal(activity.text, 'Editing file.txt');
  await b.waitFor((e) => e.kind === 'state' && e.progress.at(-1)?.tasks[0]?.state === 'completed');
  await b.api('rename', { agent: 'a1', name: 'Build' });
  await b.waitFor((e) => e.kind === 'state' && e.team[0]?.name === 'Build');
  const { agent } = await b.api('addAgent', { name: 'Peer', driver: 'fake', role: 'researcher' });
  await b.waitFor((e) => e.kind === 'state' && e.team.find((a) => a.id === agent.id)?.available);
  await b.api('changeProvider', { agent: agent.id, driver: 'fake-alternate' });
  await b.waitFor((e) => e.kind === 'state' && e.team.find((a) => a.id === agent.id)?.driver === 'fake-alternate');
  const exit = new Promise((resolve) => b.child.once('exit', resolve));
  await b.api('quit');
  assert.equal(await exit, 0);
  const events = await rows(),
    states = events.filter((e) => e.kind === 'state');
  assert.equal(states.filter((e) => e.team[0]?.sessionId === ready.team[0].sessionId && e.team[0]?.name === 'Dev').length, 1);
  assert.ok(states.some((e) => e.team[0].name === 'Build' && e.team.length === 1));
  assert.ok(states.some((e) => e.team.find((a) => a.id === agent.id)?.driver === 'fake'));
  assert.ok(states.some((e) => e.team.find((a) => a.id === agent.id)?.driver === 'fake-alternate'));
  assert.equal(events.at(-1).kind, 'state');
  assert.equal(events.at(-1).team[0].name, 'Build');
  assert.ok(states.every((e) => !('progress' in e)));
  assert.ok(events.some((e) => e.kind === 'tool'));
  assert.ok(!events.some((e) => e.kind === 'activity'));
  const replay = await startBridge({ dir: b.root, resume: ready.conversationId, team: [], rules: [] });
  t.after(() => replay.stop());
  await replay.waitFor((e) => e.kind === 'replayComplete');
  const restored = replay.events.find((e) => e.kind === 'state');
  assert.equal(restored.team[0].id, 'a1');
  assert.equal(restored.team[0].name, 'Build');
  assert.equal(restored.progress.at(-1).tasks[0].files, 1);
  assert.ok(!replay.events.some((e) => e.kind === 'activity'));
});
