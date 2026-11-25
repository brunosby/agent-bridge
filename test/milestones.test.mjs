import { createWorktree } from '../src/workspace/worktree.ts';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { parseMilestoneMarkers } from '../public/js/core/milestone-markers.js';
import { startBridge as startTestServer } from './helpers/bridge.mjs';
import { captureMilestoneWorkspace, commitMilestone, findMilestoneChanges } from '../src/workspace/milestone-git.ts';

const proposal =
  'Plan ready.\n[[MILESTONES]]\n1. Data model | done when: model tests pass\n2. API | done when: API tests pass\n[[/MILESTONES]]';
const team = [{ driver: 'fake', name: 'Lead', role: 'orchestrator' }];

function startBridge(opts) {
  const scripted = opts.settings?.fake?.rules || opts.rules;
  const rules = [
    {
      agent: 'Planner',
      match: 'prepare the spec',
      reply: '[[SPEC]]\n[{"path":"docs/spec/plan.md","text":"Implement the verified objectives."}]\n[[/SPEC]]',
    },
    {
      agent: 'Lead',
      match: 'begin milestone scenario',
      reply: '[[SIZE: large]]\nMultiple milestones\n[[/SIZE]]\n@Planner prepare the spec',
    },
    { agent: 'Lead', match: 'Specification approved and saved', reply: proposal },
    ...scripted,
  ];
  return startTestServer({
    ...opts,
    team: [...opts.team, { driver: 'fake', role: 'architect', name: 'Planner' }],
    rules,
    settings: { ...opts.settings, fake: { ...opts.settings?.fake, rules } },
  });
}
async function approveSpec(bridge) {
  await bridge.api('send', { text: 'begin milestone scenario' });
  const state = await bridge.waitFor((e) => e.kind === 'state' && e.taskPlan?.pending?.kind === 'spec');
  await bridge.api('taskDecision', {
    action: 'approve',
    conversationId: state.conversationId,
    seq: state.taskPlan.seq,
    requestId: state.taskPlan.pending.id,
    docs: state.taskPlan.pending.docs,
  });
}
function fixture() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bridge-milestones-'));
  const work = path.join(dir, 'work');
  fs.mkdirSync(work);
  const git = (...args) => execFileSync('git', args, { cwd: work, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
  git('init');
  git('config', 'user.name', 'Agent Bridge fixture');
  git('config', 'user.email', 'fixture@example.invalid');
  const write = (name, data) => fs.writeFileSync(path.join(work, name), data);
  write('protected.txt', 'original\n');
  write('.env', 'SYNTHETIC_BEFORE=1\n');
  write('package.json', JSON.stringify({ scripts: { check: 'node -e "process.exit(0)"' } }));
  git('add', '.');
  git('commit', '-m', 'fixture baseline');
  return { dir, work, git, write, head: git('rev-parse', 'HEAD') };
}

const waitStatus = (bridge, number, status, reason) =>
  bridge.waitFor(
    (event) =>
      event.kind === 'milestoneProgress' &&
      event.milestones.some((item) => item.number === number && item.status === status && (!reason || reason.test(item.detail || ''))),
  );

test('milestone markers stay out of visible text, even before the stream closes', () => {
  assert.equal(parseMilestoneMarkers('Visible\n[[MILES').text, 'Visible\n');
  assert.equal(parseMilestoneMarkers('Visible\n[[MILESTONES]]\n1. Do not show yet').text, 'Visible\n');
  assert.equal(parseMilestoneMarkers('Summary\n[[MILESTONE_DONE: 2]]').number, 2);
  assert.deepEqual(
    parseMilestoneMarkers(proposal).proposed.map((item) => item.title),
    ['Data model', 'API'],
  );
  assert.equal(parseMilestoneMarkers('[[MILESTONES]]\n2. Wrong | done when: done\n[[/MILESTONES]]').invalid, true);
});

test('two approved milestones create scoped commits and a final review without staging user changes', async () => {
  const project = fixture();
  project.write('protected.txt', 'staged before the milestone plan\n');
  project.git('add', 'protected.txt');
  const bridge = await startBridge({
    dir: project.dir,
    team,
    rules: [],
    settings: {
      fake: {
        rules: [
          { match: 'Milestone 1 committed', reply: 'API finished.\n[[MILESTONE_DONE: 2]]', writeFile: ['api.txt', 'step two'] },
          { match: 'Milestone plan approved', reply: 'Model finished.\n[[MILESTONE_DONE: 1]]', writeFile: ['model.txt', 'step one'] },
          { match: 'large objective', reply: proposal },
        ],
      },
    },
  });
  try {
    await approveSpec(bridge);
    const offered = await bridge.waitFor((event) => event.kind === 'milestonePlanProposed');
    assert.equal(offered.command, 'npm run check');
    assert.equal(project.git('rev-parse', 'HEAD'), project.head);
    const edited = [{ title: 'Schema', criterion: 'schema test passes' }, offered.milestones[1]];
    project.write('.env', 'SYNTHETIC_ONLY_DO_NOT_COMMIT=1\n');
    await bridge.api('resolveMilestonePlan', {
      requestId: offered.requestId,
      action: 'approve',
      milestones: edited,
      command: 'node -e "process.exit(0)"',
    });
    const first = await bridge.waitFor((event) => event.kind === 'milestoneCommitProposed' && event.milestone.number === 1);
    assert.equal(first.message, 'Milestone 1: Schema');
    assert.deepEqual(first.files, [{ workspace: 'Project', paths: ['model.txt'] }]);
    assert.equal(project.git('rev-parse', 'HEAD'), project.head);
    await bridge.api('resolveMilestoneCommit', { requestId: first.requestId, action: 'approve' });
    const second = await bridge.waitFor((event) => event.kind === 'milestoneCommitProposed' && event.milestone.number === 2);
    assert.deepEqual(
      second.files.map((entry) => entry.paths),
      [['api.txt']],
    );
    await bridge.api('resolveMilestoneCommit', { requestId: second.requestId, action: 'approve' });
    const final = await bridge.waitFor((event) => event.kind === 'finalReview');
    assert.equal(final.summary, 'API finished.');
    assert.deepEqual(project.git('log', '-2', '--format=%s').split(/\r?\n/), ['Milestone 2: API', 'Milestone 1: Schema']);
    assert.deepEqual(project.git('diff', '--name-only', project.head, 'HEAD').split(/\r?\n/), ['api.txt', 'model.txt']);
    assert.equal(project.git('diff', '--cached', '--name-only'), 'protected.txt');
    assert.equal(project.git('show', 'HEAD:.env'), 'SYNTHETIC_BEFORE=1');
    assert.match(project.git('log', '-1', '--format=%an'), /Agent Bridge fixture/);
    assert.ok(bridge.events.filter((event) => event.kind === 'turnEnd').every((event) => !event.text.includes('[[MILESTONE')));
    const saved = JSON.parse(fs.readFileSync(path.join(project.dir, 'config.local.json'), 'utf8'));
    assert.deepEqual(Object.values(saved.milestoneChecks), ['node -e "process.exit(0)"']);
    const log = fs.readFileSync(path.join(bridge.logs, bridge.state().conversationId, 'transcript.jsonl'), 'utf8');
    assert.doesNotMatch(log, /npm run check|SYNTHETIC_ONLY_DO_NOT_COMMIT/);
  } finally {
    await bridge.stop();
  }
});

test('automatic milestones need a passing check and approval from any configured Reviewer', async () => {
  for (const scenario of ['passed', 'failed', 'reviewer requested changes', 'reviewer approved', 'no changes']) {
    const project = fixture();
    const withReviewer = scenario.startsWith('reviewer');
    const agents = withReviewer ? [...team, { driver: 'fake', name: 'Rev', role: 'reviewer' }] : team;
    const rules = [
      {
        agent: 'Lead',
        match: 'Milestone plan approved',
        reply: withReviewer ? '@Rev review model' : 'Finished.\n[[MILESTONE_DONE: 1]]',
        writeFile: scenario === 'no changes' ? undefined : ['model.txt', 'step'],
      },
      { agent: 'Lead', match: 'Message from @a2', reply: 'Finished.\n[[MILESTONE_DONE: 1]]' },
      { agent: 'Lead', match: 'large objective', reply: proposal },
      {
        agent: 'Rev',
        reply:
          (scenario === 'reviewer approved' ? 'APPROVED' : 'CHANGES REQUESTED\n- incomplete work') +
          '\n[[SUMMARY]]\nChecks reviewed.\n[[/SUMMARY]]',
      },
    ];
    const bridge = await startBridge({ dir: project.dir, team: agents, rules, settings: { milestoneCommitMode: 'automatic' } });
    try {
      await approveSpec(bridge);
      const event = await bridge.waitFor((item) => item.kind === 'milestonePlanProposed');
      const command = scenario === 'failed' ? 'node -e "process.exit(3)"' : 'node -e "process.exit(0)"';
      await bridge.api('resolveMilestonePlan', { requestId: event.requestId, action: 'approve', command });
      if (scenario === 'passed' || scenario === 'reviewer approved') {
        await waitStatus(bridge, 1, 'committed');
        assert.equal(project.git('log', '-1', '--format=%s'), 'Milestone 1: Data model');
      } else {
        await waitStatus(
          bridge,
          1,
          'blocked',
          withReviewer ? /Reviewer has not approved/ : scenario === 'no changes' ? /No eligible changes/ : /verification command failed/,
        );
        assert.equal(project.git('rev-parse', 'HEAD'), project.head);
      }
      assert.equal(
        bridge.events.some((item) => item.kind === 'milestoneCommitProposed'),
        false,
      );
    } finally {
      await bridge.stop();
    }
  }
});

test('a linked worktree uses its own branch and commits literal approved paths', async () => {
  const project = fixture();
  const branchDir = path.join(project.dir, 'linked');
  project.git('worktree', 'add', '-b', 'milestone-fixture', branchDir);
  const baseline = await captureMilestoneWorkspace(branchDir, 'Coder');
  fs.writeFileSync(path.join(branchDir, 'code with spaces.txt'), 'fixture');
  const candidate = await findMilestoneChanges(baseline, []);
  assert.deepEqual(candidate.paths, ['code with spaces.txt']);
  const record = await commitMilestone(candidate, 'Milestone 1: worktree', () => true);
  assert.equal(project.git('rev-parse', 'HEAD'), project.head);
  assert.equal(project.git('rev-parse', 'milestone-fixture'), record.head);
});

test('a non-Git workspace does not offer milestone approval', async () => {
  const bridge = await startBridge({ team, rules: [{ reply: proposal }] });
  try {
    await approveSpec(bridge);
    await bridge.waitFor((event) => event.kind === 'turnEnd');
    assert.equal(bridge.state().milestoneCommitAvailable, false);
    assert.equal(
      bridge.events.some((event) => event.kind === 'milestonePlanProposed'),
      false,
    );
  } finally {
    await bridge.stop();
  }
});

test('a Git hook cannot expand a milestone commit beyond the approved paths', async () => {
  const project = fixture();
  const hooks = path.join(project.dir, 'fixture-hooks');
  fs.mkdirSync(hooks);
  project.git('config', 'core.hooksPath', hooks);
  fs.writeFileSync(path.join(hooks, 'pre-commit'), '#!/bin/sh\ngit add -- .env\n', { mode: 0o755 });
  const baseline = await captureMilestoneWorkspace(project.work, 'Project');
  project.write('new.txt', 'approved content');
  project.write('.env', 'SYNTHETIC_SECRET=2\n');
  const candidate = await findMilestoneChanges(baseline, []);
  assert.deepEqual(candidate.paths, ['new.txt']);
  await assert.rejects(
    commitMilestone(candidate, 'Milestone 1: approved', () => true),
    /could not commit/,
  );
  assert.equal(project.git('rev-parse', 'HEAD'), project.head);
  assert.equal(project.git('diff', '--cached', '--name-only'), '');
  assert.match(project.git('status', '--porcelain'), /\?\? new\.txt/);
});

test('a pending agent task blocks a milestone even when its files are ready', async () => {
  const project = fixture();
  const bridge = await startBridge({
    dir: project.dir,
    team: [...team, { driver: 'fake', name: 'Dev', role: 'coder' }],
    rules: [
      { agent: 'Lead', match: 'large objective', reply: proposal },
      { agent: 'Lead', match: 'parallel work', reply: 'Done.\n[[MILESTONE_DONE: 1]]', writeFile: ['step.txt', 'work'] },
      { agent: 'Lead', match: 'Milestone plan approved', reply: 'I will wait for the next task.' },
      { agent: 'Dev', reply: 'Other work completed.' },
    ],
  });
  try {
    await approveSpec(bridge);
    const milestone = await bridge.waitFor((event) => event.kind === 'milestonePlanProposed');
    await bridge.api('resolveMilestonePlan', { requestId: milestone.requestId, action: 'approve', command: '' });
    await bridge.waitFor((event) => event.seq > milestone.seq && event.kind === 'turnEnd');
    await bridge.api('send', { text: 'parallel work', target: 'all' });
    await waitStatus(bridge, 1, 'blocked', /Tasks or approvals are still pending/);
    assert.equal(project.git('rev-parse', 'HEAD'), project.head);
  } finally {
    await bridge.stop();
  }
});

test('worktree identity uses the full conversation ID and the immutable agent ID', async () => {
  const project = fixture();
  try {
    const first = await createWorktree({ repoDir: project.work, conversationId: '2026-11-21T17-06-11-100Z', agentId: 'a2' });
    const sameConversation = await createWorktree({ repoDir: project.work, conversationId: '2026-11-21T17-06-11-100Z', agentId: 'a3' });
    const sameSecond = await createWorktree({ repoDir: project.work, conversationId: '2026-11-21T17-06-11-900Z', agentId: 'a2' });
    assert.equal(new Set([first.path, sameConversation.path, sameSecond.path]).size, 3);
    assert.equal(new Set([first.branch, sameConversation.branch, sameSecond.branch]).size, 3);
    await assert.rejects(
      createWorktree({ repoDir: project.work, conversationId: '2026-11-21T17-06-11-100Z', agentId: 'a2' }),
      /already exists/,
    );
  } finally {
    fs.rmSync(project.dir, { recursive: true, force: true });
  }
});

test('an aliased project subfolder maps to the same subfolder of the new worktree', async () => {
  const project = fixture();
  try {
    const nested = path.join(project.work, 'nested');
    fs.mkdirSync(nested);
    project.write('nested/tracked.txt', 'fixture');
    project.git('add', 'nested');
    project.git('commit', '-m', 'Add fixture subfolder');
    const alias = path.join(project.dir, 'workspace-alias');
    fs.symlinkSync(project.work, alias, process.platform === 'win32' ? 'junction' : 'dir');
    const tree = await createWorktree({ repoDir: path.join(alias, 'nested'), conversationId: 'fixture', agentId: 'a1' });
    assert.equal(tree.path, path.join(tree.root, 'nested'));
    assert.equal(fs.readFileSync(path.join(tree.path, 'tracked.txt'), 'utf8'), 'fixture');
  } finally {
    fs.rmSync(project.dir, { recursive: true, force: true });
  }
});

test('restore keeps a legacy worktree path and branch that were saved by name', async () => {
  const project = fixture();
  let bridge;
  try {
    const legacy = path.join(project.dir, 'legacy-reviewer');
    const branch = 'agent-bridge/legacy/Reviewer';
    project.git('worktree', 'add', '-b', branch, legacy);
    const logs = path.join(project.dir, 'logs', 'legacy');
    fs.mkdirSync(logs, { recursive: true });
    const member = {
      id: 'a1',
      name: 'Reviewer',
      driver: 'fake',
      role: 'orchestrator',
      cwd: legacy,
      worktree: { path: legacy, root: legacy, branch },
    };
    const state = { kind: 'state', seq: 1, workDir: project.work, team: [member] };
    const message = { kind: 'user', seq: 2, text: 'keep my branch', to: ['a1'] };
    fs.writeFileSync(path.join(logs, 'transcript.jsonl'), JSON.stringify(state) + '\n' + JSON.stringify(message) + '\n');
    bridge = await startBridge({ team: [], rules: [], dir: project.dir, resume: 'legacy' });
    const restored = await bridge.waitFor((event) => event.kind === 'state' && event.conversationId === 'legacy');
    assert.equal(restored.team[0].cwd, legacy);
    assert.deepEqual(restored.team[0].worktree, member.worktree);
  } finally {
    if (bridge) await bridge.stop();
    fs.rmSync(project.dir, { recursive: true, force: true });
  }
});

test('milestone approval fails closed when the tracked diff exceeds the capture limit', async () => {
  const project = fixture();
  try {
    const baseline = await captureMilestoneWorkspace(project.work, 'Project');
    project.write('protected.txt', 'x'.repeat(21 * 1024 * 1024));
    await assert.rejects(findMilestoneChanges(baseline, []), /Could not fingerprint/);
    assert.equal(project.git('rev-parse', 'HEAD'), project.head);
  } finally {
    fs.rmSync(project.dir, { recursive: true, force: true });
  }
});

test('a formatting hook cannot replace the approved content of the same file', async () => {
  const project = fixture();
  try {
    const hooks = path.join(project.dir, 'format-hooks');
    fs.mkdirSync(hooks);
    project.git('config', 'core.hooksPath', hooks);
    fs.writeFileSync(path.join(hooks, 'pre-commit'), '#!/bin/sh\nprintf formatted > new.txt\ngit add -- new.txt\n', { mode: 0o755 });
    const baseline = await captureMilestoneWorkspace(project.work, 'Project');
    project.write('new.txt', 'approved');
    const candidate = await findMilestoneChanges(baseline, []);
    await assert.rejects(
      commitMilestone(candidate, 'Milestone: format', () => true),
      /could not commit/,
    );
    assert.equal(project.git('rev-parse', 'HEAD'), project.head);
    assert.equal(project.git('diff', '--cached', '--name-only'), '');
  } finally {
    fs.rmSync(project.dir, { recursive: true, force: true });
  }
});
