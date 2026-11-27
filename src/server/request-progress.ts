import { AsyncLocalStorage } from 'node:async_hooks';
import { startActivity, endActivity, recordActivity, type TaskActivity } from './task-activity.ts';
import { milestonePending } from './milestones.ts';
import type { BridgeEvent, Conversation, MilestoneView, TaskPlan } from '../core/types.ts';

type TaskStatus = 'queued' | 'working' | 'completed' | 'cancelled' | 'failed' | 'interrupted';
type Delegation = TaskActivity & {
  id: string;
  agent: string;
  name: string;
  role: string;
  stage: string;
  round: number;
  sourceSeq?: number;
  description: string;
  state: TaskStatus;
  delivered: boolean;
  start: number;
  end?: number;
};
type Request = {
  seq: number;
  text: string;
  start: number;
  end?: number;
  tasks: Delegation[];
  milestones: (MilestoneView & { start?: number; end?: number })[];
  blocked: string[];
  approvals: Record<string, string>;
  original: string;
  preparing?: number;
  plan?: TaskPlan;
};
const context = new AsyncLocalStorage<{ owner: Conversation; seq: number }>();
const successions = new WeakMap<Conversation, string>();
const origins = new WeakMap<Conversation, Map<string, number>>();
export function requestContext(owner: Conversation) {
  const c = context.getStore();
  return c?.owner === owner ? c.seq : undefined;
}
export function withRequest<T>(owner: Conversation, seq: number | undefined, run: () => T): T {
  return seq ? context.run({ owner, seq }, run) : run();
}
export function decisionOrigin(owner: Conversation, id?: string) {
  return id ? origins.get(owner)?.get(id) : undefined;
}
export function agentRequest(owner: Conversation, agent: string, ids: unknown) {
  const tasks = Array.isArray(ids)
    ? ids.flatMap((id) => owner.tasks.get(id) || [])
    : [...owner.tasks.values()].filter((t) => t.agent === agent);
  return tasks.findLast((t) => t.agent === agent && t.state === 'working')?.requestSeq ?? tasks.find((t) => t.agent === agent)?.requestSeq;
}
const registers = new WeakMap<Conversation, Map<number, Request>>();
const roles: Record<string, string> = {
  orchestrator: 'Plan',
  architect: 'Specification',
  coder: 'Code',
  reviewer: 'Review',
  tester: 'Tests',
  researcher: 'Research',
};
const active = (task: Delegation) => task.state === 'queued' || task.state === 'working';
export function register(owner: Conversation) {
  let entries = registers.get(owner);
  if (!entries) registers.set(owner, (entries = new Map()));
  return entries;
}
export function latest(owner: Conversation) {
  return [...register(owner).values()].at(-1);
}
export function forTask(owner: Conversation, id: string) {
  return [...register(owner).values()].find((r) => r.tasks.some((t) => t.id === id));
}
export function originPlan(owner: Conversation, seq?: number) {
  return seq && owner.plan?.seq !== seq ? register(owner).get(seq)?.plan : owner.plan;
}
export function observeProgress(owner: Conversation, event: BridgeEvent) {
  const changedAgent = recordActivity(owner, event);
  if (['tool', 'toolResult', 'delta', 'info'].includes(event.kind)) return changedAgent;
  const rows = register(owner);
  const now = event.at ?? Date.now();
  if (event.kind === 'workflowChanged') {
    const previous = successions.get(owner);
    if (previous && previous !== event.succession?.id) {
      origins.get(owner)?.delete(previous);
      successions.delete(owner);
    }
    if (event.succession) successions.set(owner, event.succession.id);
  }
  if (
    (event.requestId &&
      ['approval', 'needRole', 'recommendRoles', 'finalReview', 'milestonePlanProposed', 'milestoneCommitProposed'].includes(event.kind)) ||
    (event.kind === 'workflowChanged' && event.succession)
  ) {
    const id = event.requestId || event.succession.id;
    let map = origins.get(owner);
    if (!map) origins.set(owner, (map = new Map()));
    const seq =
      event.requestSeq ??
      requestContext(owner) ??
      agentRequest(owner, event.agent, undefined) ??
      [...rows.values()].find((r) => r.tasks.some((t) => t.agent === event.agent && active(t)))?.seq ??
      latest(owner)?.seq;
    if (seq && !map.has(id)) map.set(id, seq);
  } else if (event.requestId && event.kind.endsWith('Closed')) origins.get(owner)?.delete(event.requestId);
  if (event.kind === 'user' && event.seq) {
    rows.set(event.seq, {
      seq: event.seq,
      text: String(event.text).slice(0, 200),
      original: String(event.text),
      start: now,
      tasks: [],
      blocked: [],
      approvals: {},
      milestones: [],
    });
    for (const row of [...rows.values()].slice(0, -10)) {
      if (
        !row.tasks.some(active) &&
        !Object.keys(row.approvals).length &&
        ![...(origins.get(owner)?.values() || [])].includes(row.seq) &&
        !row.plan?.pending &&
        !row.plan?.specNeedsRetry &&
        !row.blocked.length &&
        !owner.heldRelays.some((h) => h.requestSeq === row.seq) &&
        !row.preparing
      )
        rows.delete(row.seq);
    }
    return;
  }
  if (event.kind === 'workflowChanged' && event.plan) {
    const row = rows.get(event.plan.seq);
    if (row) row.plan = owner.plan?.seq === row.seq ? owner.plan : event.plan;
    return;
  }
  if (event.kind === 'taskQueued') {
    const row = rows.get(event.requestSeq ?? event.sourceSeq) ?? latest(owner);
    if (!row || row.tasks.some((t) => t.id === event.id)) return;
    const role = event.role || owner.team.find((m) => m.id === event.agent)?.role || 'agent';
    const stage = roles[role] || role;
    const previous = row.tasks.findLast((t) => t.stage === stage);
    const round = previous
      ? previous.round +
        Number(
          (role === 'coder' || role === 'reviewer') &&
            row.tasks.slice(row.tasks.indexOf(previous) + 1).some((t) => t.role === (role === 'coder' ? 'reviewer' : 'coder')),
        )
      : 1;
    row.tasks.push({
      id: event.id,
      agent: event.agent,
      name: event.name || event.agent,
      role,
      stage,
      round,
      sourceSeq: event.sourceSeq,
      description: event.description || '',
      state: 'queued',
      delivered: false,
      start: now,
    });
    row.blocked = row.blocked.filter((id) => id !== event.agent);
    delete row.end;
    return;
  }
  if (['turnEnd', 'taskStarted', 'tasksCancelled', 'inputAccepted'].includes(event.kind)) {
    for (const id of Array.isArray(event.taskIds) ? event.taskIds : []) {
      const row = forTask(owner, id);
      const task = row?.tasks.find((t) => t.id === id && t.agent === event.agent);
      if (!task || !row) continue;
      if (event.kind === 'inputAccepted') task.delivered = true;
      else if (active(task)) {
        task.state =
          event.kind === 'taskStarted'
            ? 'working'
            : event.kind === 'tasksCancelled'
              ? event.interrupted
                ? 'interrupted'
                : 'cancelled'
              : event.ok === false
                ? 'failed'
                : 'completed';
        if (task.state === 'working') startActivity(owner, task, now);
        if (!active(task)) {
          task.end = now;
          endActivity(owner, task);
        }
      }
      if (!row.tasks.some(active)) row.end = now;
    }
  }
  if (event.kind === 'approval') {
    const row =
      rows.get(decisionOrigin(owner, event.requestId) ?? -1) ??
      [...rows.values()].find((r) => r.tasks.some((t) => t.agent === event.agent && t.state === 'working')) ??
      latest(owner);
    if (row) row.approvals[event.requestId] = event.agent;
  } else if (event.kind === 'approvalClosed') {
    for (const row of rows.values()) delete row.approvals[event.requestId];
  } else if (event.kind === 'milestoneProgress') {
    const row = rows.get(event.requestSeq ?? requestContext(owner) ?? owner.plan?.seq ?? latest(owner)?.seq ?? 0);
    if (row && Array.isArray(event.milestones))
      row.milestones = event.milestones.map((m: MilestoneView) => {
        const old = row.milestones.find((p) => p.number === m.number && p.title === m.title);
        return {
          ...m,
          start: old?.start ?? (m.status === 'pending' ? undefined : now),
          end: m.status === 'committed' ? (old?.end ?? now) : undefined,
        };
      });
  } else if (event.kind === 'delegationBlocked') {
    const row = rows.get(event.requestSeq);
    if (row) row.blocked = [...new Set([...row.blocked, ...(event.agents as string[])])];
  }
  return changedAgent;
}
export function restoreProgress(owner: Conversation, events: BridgeEvent[]) {
  for (const event of events) observeProgress(owner, event);
  for (const row of register(owner).values()) {
    row.approvals = {};
    row.blocked = [];
    if (row.plan?.specRequestedFrom && !row.plan.finished && !row.plan.approved && !row.plan.pending) row.plan.specNeedsRetry ??= true;
    for (const task of row.tasks)
      if (active(task)) {
        task.state = 'interrupted';
        endActivity(owner, task);
      }
  }
}
type Wait = { reason: string; action?: string; card?: string; agent?: string; seq?: number };
export function pendingWork(owner: Conversation): Wait[] {
  const waits: Wait[] = [];
  const add = (reason: string, action?: string, card?: string, agent?: string, seq = latest(owner)?.seq) =>
    waits.push({ reason, action, card, agent, seq: decisionOrigin(owner, card) ?? seq });
  if (owner.succession) add('Choose a coordinator', 'Choose coordinator', owner.succession.id);
  for (const row of register(owner).values())
    for (const [id, agent] of Object.entries(row.approvals)) add('Tool approval requested', 'Open approval', id, agent, row.seq);
  for (const row of register(owner).values()) {
    const p = originPlan(owner, row.seq);
    for (const item of [p?.pending, ...(p?.queuedDecisions || [])])
      if (item)
        add(
          item.kind === 'spec' ? 'Specification needs approval' : 'Question needs an answer',
          'Open decision',
          p?.pending?.id,
          item.agent,
          row.seq,
        );
    if (p?.specNeedsRetry === 'manual' && !p.finished)
      add('Specification request has not been sent', 'Request specification', 'retry', p.specRequestedFrom, row.seq);
    else if (p?.specNeedsRetry && !p.finished)
      add('Specification needs another attempt', 'Retry specification', 'retry', p.specRequestedFrom, row.seq);
    else if (p?.specRequestedFrom && !p.pending && !p.approved && !p.finished)
      add('Preparing specification', undefined, undefined, p.specRequestedFrom, row.seq);
    for (const id of row.blocked) add('Coder delegation needs to be resent', undefined, undefined, id, row.seq);
  }
  if (owner.pendingRoleRequest) add('Missing role', 'Choose role', owner.pendingRoleRequest.requestId);
  if (owner.pendingRecommendation) add('Role recommendation', 'Review roles', owner.pendingRecommendation.requestId);
  const milestone = milestonePending(owner);
  if (milestone) add(milestone.reason, milestone.action, milestone.card);
  if (owner.pendingFinal) add('Final confirmation', 'Open confirmation', owner.pendingFinal);
  for (const [key, item] of owner.staleUpdates || [])
    add('Update needs a new delegation', 'Review update', key, item.targets[0], item.requestSeq);
  for (const h of owner.heldRelays) add('Held reply to ' + h.targets.join(', '), 'Resume', 'resume', h.from, h.requestSeq);
  for (const [id, task] of owner.batch?.pending || [])
    add(
      'Waiting for ' + (owner.team.find((m) => m.id === id)?.name || id),
      undefined,
      undefined,
      owner.team.find((m) => m.role === 'orchestrator')?.id,
      task.requestSeq ?? forTask(owner, task.id)?.seq,
    );
  for (const member of owner.team) {
    if (owner.providerChanges.has(member.id)) add('Switching provider', undefined, undefined, member.id);
    if (owner.agents[member.id]?.approvals.size && !waits.some((w) => w.agent === member.id && w.action === 'Open approval'))
      add('Pending approval', 'Open approval', undefined, member.id);
    if (owner.agents[member.id]?.busy || [...owner.tasks.values()].some((t) => t.agent === member.id))
      add('Agent is working', undefined, undefined, member.id);
  }
  for (const row of register(owner).values()) if (row.preparing) add('Preparing delivery', undefined, undefined, undefined, row.seq);
  if (owner.relay.userPaused && [...owner.tasks.values()].length && !owner.heldRelays.length) add('Hand-offs paused', 'Resume', 'resume');
  if (owner.relay.limitPause) add('Hand-offs paused by ' + owner.relay.limitPause, 'Resume', 'resume');
  return waits;
}
export function progressView(owner: Conversation, waits: Wait[], manualMode = false) {
  const current = manualMode ? latest(owner) : undefined;
  return [...register(owner).values()].map((row) => {
    const reasons = waits.filter((w) => w.seq === row.seq && w.reason !== 'Agent is working');
    const waiting = reasons.find((w) => w.action);
    const stages = [...new Set(row.tasks.map((t) => t.stage))];
    const running = row.tasks.some(active) || reasons.length > 0;
    const answered = !running && stages.length === 1 && stages[0] === 'Plan' && row.tasks.every((t) => t.state === 'completed');
    const broken = row.tasks.some((t) => ['cancelled', 'failed', 'interrupted'].includes(t.state));
    return {
      seq: row.seq,
      text: row.text,
      start: row.start,
      end: running ? undefined : row.end,
      status: waiting ? 'Waiting for you' : running ? 'In progress' : broken ? 'Interrupted' : answered ? 'Answered' : 'Done',
      stages: row.milestones.length
        ? row.milestones.map((m) => ({ name: m.title, state: m.status, start: m.start, end: m.end }))
        : stages.map((name) => {
            const tasks = row.tasks.filter((t) => t.stage === name),
              live = tasks.filter(active);
            const waitingOn = waiting?.agent && live.some((t) => t.agent === waiting.agent);
            return {
              name: answered ? 'Answer' : name,
              state: waitingOn ? 'waiting' : live.length ? 'working' : tasks.at(-1)?.state,
              start: tasks[0].start,
              end: live.length ? undefined : tasks.reduce((end, t) => Math.max(end, t.end || t.start), 0),
              agents: [...new Set((live.length ? live : tasks).map((t) => t.name))],
              round: tasks.at(-1)?.round,
            };
          }),
      total: row.milestones.length || undefined,
      tasks: row.tasks,
      waiting,
      reasons: row === current ? [...reasons, { reason: 'Manual mode: replies are not forwarded' }] : reasons,
    };
  });
}
