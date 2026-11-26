import { exec } from 'node:child_process';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { promisify } from 'node:util';
import type { Conversation, MilestoneDefinition, MilestoneEvent, MilestoneView } from '../core/types.ts';
import { config, saveLocalConfig, setting } from '../config/settings.ts';
import {
  captureMilestoneWorkspace,
  commitMilestone,
  findMilestoneChanges,
  type MilestoneCommitCandidate,
  type MilestoneWorkspace,
} from '../workspace/milestone-git.ts';
import { publish, publishState } from './events.ts';
import { relay, S } from './state.ts';
import { deliver } from './delivery.ts';
import { publishFinalReview } from './final-review.ts';

interface Proposal {
  id: string;
  agent: string;
  draft: MilestoneDefinition[];
  command: string;
  saved: boolean;
}
interface CommitRequest {
  id: string;
  agent: string;
  summary: string;
  milestone: MilestoneView;
  candidates: MilestoneCommitCandidate[];
}
interface MilestoneFlow {
  milestones: MilestoneView[];
  workspaces: MilestoneWorkspace[];
  command: string;
  revision: number;
  busy: boolean;
  declined: boolean;
  proposal?: Proposal;
  commit?: CommitRequest;
  verification?: AbortController;
  review?: { number: number; fingerprints: Promise<(string | null)[]> };
}

const flows = new WeakMap<Conversation, MilestoneFlow>();
const archivedViews = new WeakMap<Conversation, MilestoneView[]>();
const run = promisify(exec);

export function milestoneViews(owner: Conversation): MilestoneView[] {
  const active = flows.get(owner)?.milestones;
  return (active?.length ? active : archivedViews.get(owner) || []).map((item) => ({ ...item, commits: [...item.commits] }));
}

export function restoreMilestoneViews(owner: Conversation, previous: unknown) {
  if (!Array.isArray(previous)) return;
  const restored = previous.flatMap((item: unknown): MilestoneView[] => {
    if (!item || typeof item !== 'object') return [];
    const { number, title, criterion, status, commits } = item as Partial<MilestoneView>;
    if (typeof number !== 'number' || typeof title !== 'string' || typeof criterion !== 'string') return [];
    const records = Array.isArray(commits)
      ? commits.filter((record) => typeof record?.workspace === 'string' && typeof record.head === 'string')
      : [];
    if (status === 'committed') return [{ number, title, criterion, status, commits: records }];
    return [
      {
        number,
        title,
        criterion,
        status: 'blocked',
        detail: 'Approve a new milestone plan to continue after restoration.',
        commits: records,
      },
    ];
  });
  if (restored.length) archivedViews.set(owner, restored);
}

export function milestonePending(owner: Conversation) {
  const flow = flows.get(owner);
  const card = flow?.proposal || flow?.commit;
  return card
    ? {
        reason: flow?.proposal ? 'Milestone plan needs approval' : 'Milestone commit needs approval',
        action: 'Open milestone',
        card: card.id,
      }
    : flow?.busy || hasActiveMilestones(owner)
      ? { reason: 'Milestone in progress' }
      : undefined;
}
export function hasActiveMilestones(owner: Conversation) {
  const flow = flows.get(owner);
  return owner.routingMode === 'orchestrator' && Boolean(flow && activeMilestone(flow));
}

export function milestoneCommitAvailable(owner: Conversation) {
  return Boolean(owner.project[owner.workDir]?.git);
}

function emit(event: MilestoneEvent) {
  publish(event);
}

function progress(owner: Conversation) {
  if (S.conv !== owner) return;
  emit({ kind: 'milestoneProgress', milestones: milestoneViews(owner) });
  publishState();
}

function normalizeMilestones(input: unknown): MilestoneDefinition[] {
  if (!Array.isArray(input) || input.length < 2 || input.length > 12) throw new Error('A milestone plan needs 2 to 12 steps.');
  return input.map((item: unknown) => {
    if (!item || typeof item !== 'object') throw new Error('Enter a title and a completion criterion for every milestone.');
    const { title, criterion } = item as Partial<MilestoneDefinition>;
    if (
      typeof title !== 'string' ||
      !title.trim() ||
      title.length > 100 ||
      /[\r\n\0]/.test(title) ||
      typeof criterion !== 'string' ||
      !criterion.trim() ||
      criterion.length > 320
    )
      throw new Error('Enter a title and a completion criterion for every milestone.');
    return { title: title.trim(), criterion: criterion.trim() };
  });
}

function suggestedCommand(dir: string): string {
  const exists = (name: string) => existsSync(path.join(dir, name));
  try {
    if (exists('package.json')) {
      const { scripts } = JSON.parse(readFileSync(path.join(dir, 'package.json'), 'utf8'));
      if (typeof scripts?.check === 'string') return 'npm run check';
      if (typeof scripts?.test === 'string') return 'npm test';
    }
  } catch {
    /* a malformed manifest does not establish a command */
  }
  if (exists('pom.xml')) return 'mvn -q verify';
  if (exists('pyproject.toml')) return 'pytest';
  if (exists('Cargo.toml')) return 'cargo test';
  if (exists('go.mod')) return 'go test ./...';
  if (readdirSync(dir).some((name) => /\.sln$/i.test(name))) return 'dotnet test';
  return exists('Makefile') ? 'make test' : '';
}

function activeMilestone(flow: MilestoneFlow) {
  return flow.milestones.find((milestone) => milestone.status !== 'committed');
}

function pendingWork(owner: Conversation) {
  return (
    owner.tasks.size > 0 ||
    Boolean(owner.batch?.pending.size || owner.pendingRoleRequest || owner.pendingRecommendation || owner.pendingFinal) ||
    Object.values(owner.agents).some((agent) => agent.approvals.size > 0)
  );
}

function announce(owner: Conversation, agent: string, text: string, asResponse = false) {
  if (S.conv !== owner) return;
  publish({ kind: 'system', text });
  const limit = Number(setting('tokenLimit'));
  const exhausted = limit > 0 && Object.values(owner.agents).reduce((sum, member) => sum + member.tokens, 0) >= limit;
  if (owner.relay.userPaused || exhausted || (asResponse && (!relay.auto || owner.relay.hops >= relay.maxHops))) return;
  if (asResponse) owner.relay.hops += 1;
  deliver(agent, '[Message from Agent Bridge]\n' + text + '\n' + milestoneInstructions(owner), { from: 'user' });
}

function release(owner: Conversation) {
  owner.relay.halted = owner.relay.userPaused;
}

export function milestoneInstructions(owner: Conversation): string {
  if (!milestoneCommitAvailable(owner) || owner.routingMode !== 'orchestrator') return '';
  const flow = flows.get(owner);
  if (flow?.declined) return '[Milestones] The user chose to continue without milestones.';
  if (flow?.proposal) return '[Milestones] Wait for the user to approve the plan before delegating.';
  const active = flow && activeMilestone(flow);
  if (active)
    return (
      '[Milestones] Current milestone ' +
      active.number +
      ': ' +
      active.title +
      '. Completion criterion: ' +
      active.criterion +
      '. Declare [[MILESTONE_DONE: ' +
      active.number +
      ']] only when the criterion is met.'
    );
  return flow?.milestones.length
    ? '[Milestones] All milestones are committed.'
    : '[Milestones] On a large coding task, before delegating, propose 2–12 milestones in a block [[MILESTONES]] with one numbered line N. Title | done when: verifiable criterion, then [[/MILESTONES]]. Wait for the user to approve. Skip milestones for small tasks and questions. If recommending roles, do that first.';
}

export function offerMilestonePlan(owner: Conversation, agent: string, proposed: unknown): boolean {
  if (!milestoneCommitAvailable(owner) || owner.routingMode !== 'orchestrator') return false;
  const existing = flows.get(owner);
  if (existing?.proposal || existing?.milestones.length || existing?.declined) return false;
  if (pendingWork(owner)) return false;
  const milestones = normalizeMilestones(proposed);
  const saved: unknown = config.milestoneChecks?.[owner.workDir];
  const proposal = {
    id: 'milestones-' + randomUUID(),
    agent,
    draft: milestones,
    command: typeof saved === 'string' ? saved : suggestedCommand(owner.workDir),
    saved: typeof saved === 'string',
  };
  flows.set(owner, { milestones: [], workspaces: [], command: '', revision: 0, busy: false, declined: false, proposal });
  owner.relay.halted = true;
  emit({
    kind: 'milestonePlanProposed',
    agent,
    requestId: proposal.id,
    milestones,
    command: proposal.command,
    commandSaved: proposal.saved,
  });
  publishState();
  return true;
}

async function captureWorkspaces(owner: Conversation): Promise<MilestoneWorkspace[]> {
  const folders = [
    [owner.workDir, 'Project'],
    ...owner.team.flatMap((agent) => (agent.worktree && agent.cwd ? [[agent.cwd, agent.name]] : [])),
  ];
  const workspaces = await Promise.all(folders.map(([dir, label]) => captureMilestoneWorkspace(dir, label)));
  if (!workspaces[0]?.initial.head || !workspaces[0].initial.branch)
    throw new Error('The project needs an existing Git commit and a checked-out branch.');
  return [
    ...new Map(
      workspaces
        .filter((item): item is MilestoneWorkspace => item !== null)
        .reverse()
        .map((item) => [item.root, item]),
    ).values(),
  ].reverse();
}

export async function resolveMilestonePlan(
  owner: Conversation,
  requestId: string,
  action: 'approve' | 'dismiss',
  rows: unknown,
  command: unknown,
) {
  const flow = flows.get(owner);
  const proposal = flow?.proposal;
  if (!flow || !proposal || proposal.id !== requestId || flow.busy) throw new Error('This milestone plan is no longer pending.');
  if (action === 'dismiss') {
    flow.declined = true;
    delete flow.proposal;
    emit({ kind: 'milestoneDecisionClosed', requestId, action });
    release(owner);
    announce(owner, proposal.agent, 'The user chose to continue without milestones.');
    publishState();
    return;
  }
  const items = normalizeMilestones(rows ?? proposal.draft);
  const check = command ?? (proposal.saved ? proposal.command : '');
  if (typeof check !== 'string' || check.length > 400 || /[\r\n\0]/.test(check)) throw new Error('Enter a single verification command.');
  const revision = flow.revision;
  flow.busy = true;
  try {
    const workspaces = await captureWorkspaces(owner);
    if (S.conv !== owner || flow.revision !== revision || flow.proposal !== proposal) return;
    if (pendingWork(owner)) throw new Error('Wait for pending work to finish before approving the milestone plan.');
    if (typeof command === 'string') saveLocalConfig({ milestoneChecks: { ...config.milestoneChecks, [owner.workDir]: check.trim() } });
    flow.command = check.trim();
    flow.workspaces = workspaces;
    archivedViews.delete(owner);
    flow.milestones = items.map((item, index) => ({
      ...item,
      number: index + 1,
      status: index === 0 ? 'working' : 'pending',
      commits: [],
    }));
    delete flow.proposal;
    emit({ kind: 'milestoneDecisionClosed', requestId, action });
    release(owner);
    progress(owner);
    const plan = items.map((item, index) => index + 1 + '. ' + item.title + ' | done when: ' + item.criterion).join('\n');
    announce(owner, proposal.agent, 'Milestone plan approved. Start with milestone 1.\n' + plan);
  } finally {
    flow.busy = false;
  }
}

export function observeMilestoneReview(owner: Conversation, text: string) {
  const flow = flows.get(owner);
  const active = flow && activeMilestone(flow);
  if (!flow || !active) return;
  if (/^\W*CHANGES REQUESTED\b/i.test(text)) delete flow.review;
  else if (/^\W*APPROVED\b/i.test(text)) {
    flow.review = {
      number: active.number,
      fingerprints: Promise.all(
        flow.workspaces.map(async (workspace) => {
          try {
            const candidate = await findMilestoneChanges(workspace, config.reviewDiffExcludePatterns);
            return candidate ? candidate.fingerprint + candidate.tree : null;
          } catch {
            return null;
          }
        }),
      ),
    };
  }
}

function fail(owner: Conversation, flow: MilestoneFlow, milestone: MilestoneView, agent: string, error: unknown) {
  const reason = error instanceof Error ? error.message : 'Could not verify the milestone.';
  const repeated = milestone.detail === reason;
  milestone.status = 'blocked';
  milestone.detail = reason;
  delete flow.commit;
  release(owner);
  progress(owner);
  if (!repeated) announce(owner, agent, 'Milestone ' + milestone.number + ' is blocked. ' + reason, true);
}

async function commit(owner: Conversation, flow: MilestoneFlow, request: CommitRequest, revision: number) {
  const current = () => S.conv === owner && owner.routingMode === 'orchestrator' && flow.revision === revision && !pendingWork(owner);
  const { milestone, agent, summary } = request;
  milestone.status = 'checking';
  progress(owner);
  for (const candidate of request.candidates) {
    const record = await commitMilestone(candidate, titleFor(milestone), current);
    candidate.workspace.initial = record.snapshot;
    milestone.commits.push({ workspace: candidate.workspace.label, head: record.head });
  }
  if (!current()) return;
  milestone.status = 'committed';
  delete milestone.detail;
  delete flow.review;
  const next = activeMilestone(flow);
  if (next) {
    next.status = 'working';
    release(owner);
    progress(owner);
    announce(
      owner,
      agent,
      'Milestone ' + milestone.number + ' committed. Continue with milestone ' + next.number + ': ' + next.title + '.',
      true,
    );
  } else {
    owner.relay.halted = true;
    progress(owner);
    publishFinalReview(owner, agent, summary || 'All approved milestones are committed.');
  }
}

const titleFor = (milestone: MilestoneView) => 'Milestone ' + milestone.number + ': ' + milestone.title;

export async function finishMilestone(owner: Conversation, agent: string, number: number, summary: string) {
  const flow = flows.get(owner);
  const milestone = flow && activeMilestone(flow);
  if (!flow || !milestone || milestone.number !== number) {
    publish({ kind: 'info', agent, text: 'No matching approved milestone is active.' });
    return;
  }
  if (flow.busy || flow.commit) return;
  const revision = flow.revision;
  const current = () => S.conv === owner && owner.routingMode === 'orchestrator' && flow.revision === revision;
  flow.busy = true;
  owner.relay.halted = true;
  milestone.status = 'checking';
  progress(owner);
  try {
    if (pendingWork(owner)) throw new Error('Tasks or approvals are still pending.');
    const scan = () => Promise.all(flow.workspaces.map((workspace) => findMilestoneChanges(workspace, config.reviewDiffExcludePatterns)));
    const candidates = (await scan()).filter((candidate): candidate is MilestoneCommitCandidate => candidate !== null);
    if (!current()) return;
    if (!candidates.length && !milestone.commits.length) throw new Error('No eligible changes were found since the last checkpoint.');
    if (flow.command && candidates.length) {
      const verification = new AbortController();
      flow.verification = verification;
      try {
        for (const { workspace } of candidates) {
          await run(flow.command, {
            cwd: path.resolve(workspace.root, workspace.prefix),
            windowsHide: true,
            timeout: 120000,
            maxBuffer: 1024 * 1024,
            signal: verification.signal,
          }).catch(() => {
            throw new Error('The approved verification command failed or timed out in ' + workspace.label + '.');
          });
          if (!current()) return;
        }
      } finally {
        if (flow.verification === verification) delete flow.verification;
      }
      const after = (await scan()).filter((candidate): candidate is MilestoneCommitCandidate => candidate !== null);
      if (
        after.length !== candidates.length ||
        after.some(
          (candidate, index) =>
            candidate.fingerprint !== candidates[index].fingerprint ||
            candidate.tree !== candidates[index].tree ||
            candidate.workspace !== candidates[index].workspace,
        )
      )
        throw new Error('Git files changed while verifying the milestone. Declare it again after reviewing the changes.');
    }
    if (!current()) return;
    if (pendingWork(owner)) throw new Error('Tasks or approvals are still pending.');
    const reviewerRequired = owner.team.some((member) => member.role === 'reviewer');
    if (reviewerRequired) {
      if (flow.review?.number !== number) throw new Error('The Reviewer has not approved this milestone.');
      const approved = await flow.review.fingerprints;
      if (candidates.some((candidate) => approved[flow.workspaces.indexOf(candidate.workspace)] !== candidate.fingerprint + candidate.tree))
        throw new Error('Files changed after the Reviewer approved them. Request a fresh review.');
    }
    if (!current()) return;
    const request = { id: 'milestone-commit-' + randomUUID(), agent, summary, milestone, candidates };
    if (setting('milestoneCommitMode') !== 'automatic' || (!flow.command && !reviewerRequired) || owner.relay.userPaused) {
      flow.commit = request;
      milestone.status = 'waiting_for_commit';
      delete milestone.detail;
      emit({
        kind: 'milestoneCommitProposed',
        agent,
        requestId: request.id,
        milestone: { ...milestone },
        message: titleFor(milestone),
        files: candidates.map(({ paths, workspace }) => ({ workspace: workspace.label, paths })),
      });
      progress(owner);
    } else await commit(owner, flow, request, revision);
  } catch (error) {
    if (current()) fail(owner, flow, milestone, agent, error);
  } finally {
    flow.busy = false;
  }
}

export async function resolveMilestoneCommit(owner: Conversation, requestId: string, action: 'approve' | 'dismiss') {
  const flow = flows.get(owner);
  const request = flow?.commit;
  if (!flow || !request || request.id !== requestId || flow.busy) throw new Error('This commit is no longer pending.');
  if (action === 'approve' && pendingWork(owner)) throw new Error('Tasks or approvals are still pending.');
  delete flow.commit;
  emit({ kind: 'milestoneDecisionClosed', requestId, action });
  const revision = flow.revision;
  flow.busy = true;
  try {
    if (action === 'approve') await commit(owner, flow, request, revision);
    else fail(owner, flow, request.milestone, request.agent, new Error('The user declined the commit.'));
  } catch (error) {
    if (S.conv === owner && flow.revision === revision) fail(owner, flow, request.milestone, request.agent, error);
  } finally {
    flow.busy = false;
  }
}

export function discardMilestones(owner: Conversation) {
  cancelMilestoneDecision(owner, 'stop');
  flows.delete(owner);
  archivedViews.delete(owner);
}
export function cancelMilestoneDecision(owner: Conversation, action: string) {
  const flow = flows.get(owner);
  if (!flow) return;
  const request = flow.proposal || flow.commit;
  if (request) emit({ kind: 'milestoneDecisionClosed', requestId: request.id, action });
  delete flow.proposal;
  delete flow.commit;
  flow.revision += 1;
  flow.verification?.abort();
  const active = activeMilestone(flow);
  const verifying = active?.status === 'checking' || active?.status === 'waiting_for_commit';
  if (action === 'routing changed' && (request || verifying)) release(owner);
  if (active && verifying) {
    active.status = 'working';
    progress(owner);
  }
}
