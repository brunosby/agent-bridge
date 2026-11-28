import { isCompacting } from './compaction-state.ts';
import type { Conversation, SpecAttempt, TaskEvent, TrackedTask } from '../core/types.ts';
import { DRIVERS } from '../providers/registry.ts';
import { canReceiveWork } from '../core/agent-status.ts';
import { rosterText } from '../core/prompts.ts';
import { reviewChanges } from '../workspace/git-context.ts';
import { redact } from '../core/secret-detection.ts';
import { loggingPrefixes } from '../workspace/secret-patterns.ts';
import { requestContext, latest, register, originPlan } from './request-progress.ts';
import { closeReview, openReview } from './review-mcp.ts';
import { randomUUID } from 'node:crypto';
import { config, setting } from '../config/settings.ts';
import { publish, publishState, recordWorkflow } from './events.ts';
import { statusFor } from './team.ts';
import { orchestratorId, S } from './state.ts';

/** Send a message to one agent, adding the team roster or a role note when they changed. */
type Delivery = {
  requestSeq?: number;
  originalRequest?: string;
  updateOf?: string;
  specAttempt?: SpecAttempt;
  from: string;
  sourceSeq?: number;
  taskId?: string;
  beforeSend?: () => boolean;
  discarded?: (reason: string) => void;
};
const reviewerQueues = new WeakMap<Conversation, Map<string, Promise<void>>>();
const providerQueues = new WeakMap<Conversation, Map<string, { text: string; delivery: Delivery }[]>>();

export function isPreparingDelivery(owner: Conversation, id: string): boolean {
  return Boolean(reviewerQueues.get(owner)?.has(id));
}

export function finishProviderDeliveries(owner: Conversation, id: string, failure?: string): void {
  const queues = providerQueues.get(owner);
  const queued = queues?.get(id);
  if (!queued) return;
  queues?.delete(id);
  const stopped = Boolean(failure && isCompacting(owner.agents[id]) && failure === 'the conversation was stopped');
  if (stopped) publish({ kind: 'system', text: 'Stopped: discarded ' + queued.length + ' queued deliveries to @' + id + '.' });
  for (const { text, delivery } of queued) {
    const row = register(owner).get(delivery.requestSeq ?? -1);
    if (row?.preparing) row.preparing--;
    if (!failure && delivery.taskId && !owner.batch?.pending.get(id)?.tasks.has(delivery.taskId)) continue;
    if (!failure) deliver(id, text, delivery);
    else if (delivery.discarded) delivery.discarded(failure);
    else if (!stopped) publish({ kind: 'error', agent: id, text: `Queued delivery to @${id} failed: ${failure}.` });
  }
}

export function deliver(toId: string, text: string, delivery: Delivery): void {
  const owner = S.conv;
  const row =
    register(owner).get(delivery.requestSeq ?? delivery.sourceSeq ?? -1) ??
    register(owner).get(requestContext(owner) ?? -1) ??
    latest(owner);
  delivery = {
    ...delivery,
    requestSeq: delivery.requestSeq ?? row?.seq,
    originalRequest: delivery.originalRequest ?? row?.original ?? owner.lastUserText,
  };
  if (owner.providerChanges.has(toId) || isCompacting(owner.agents[toId])) {
    if (delivery.from === 'user' && isCompacting(owner.agents[toId]))
      publish({ kind: 'system', text: '@' + toId + ' is compacting; your message will be delivered when it finishes.' });
    let queues = providerQueues.get(owner);
    if (!queues) providerQueues.set(owner, (queues = new Map()));
    let queued = queues.get(toId);
    if (!queued) queues.set(toId, (queued = []));
    if (row) row.preparing = (row.preparing || 0) + 1;
    queued.push({ text, delivery: { ...delivery, originalRequest: delivery.originalRequest ?? owner.lastUserText ?? '' } });
    return;
  }
  const agent = owner.agents[toId];
  const spec = owner.team.find((member) => member.id === toId);
  if (!agent || !spec) return delivery.discarded?.('agent is no longer on the team');
  const role = spec.role;
  const needsDiff = S.roles[role]?.context === 'diff' && delivery.from !== 'user';
  let queue = reviewerQueues.get(owner);
  const previous = queue?.get(toId);
  if (!needsDiff && !previous) return sendDelivery(toId, text, delivery);
  if (!queue) reviewerQueues.set(owner, (queue = new Map()));
  const original = needsDiff
    ? '[Original request from ' + setting('userName') + ']\n' + ((delivery.originalRequest ?? owner.lastUserText) || '(not available)')
    : '';
  const valid = () =>
    S.conv === owner &&
    owner.agents[toId] === agent &&
    spec.role === role &&
    (!delivery.taskId || owner.batch?.pending.get(toId)?.tasks.has(delivery.taskId));
  const discard = () => delivery.discarded?.('agent or batch changed while preparing the delivery');
  if (row) row.preparing = (row.preparing || 0) + 1;
  const pending = (previous || Promise.resolve())
    .then(async () => {
      if (!valid()) return discard();
      const dir = agent.cwd || owner.workDir;
      const context = needsDiff ? await diffContext(dir) : null;
      if (!valid()) return discard();
      const extras: string[] = [];
      if (context) {
        closeReview(owner, toId);
        extras.push(original, context.text);
        if (context.review) {
          const { files, omitted, limit } = context.review;
          const id = openReview(owner, toId, dir, files, omitted, limit);
          if (id)
            extras.push(
              'Use the bridge_diff MCP tool with reviewId ' +
                id +
                ' and a path from the file list. Use this tool for the review diff, without reading it through Git or the shell.',
            );
        }
      }
      sendDelivery(toId, text, delivery, extras);
    })
    .catch(() => {
      if (valid()) publish({ kind: 'error', agent: toId, text: 'Could not prepare Reviewer context.' });
      delivery.discarded?.('could not prepare Reviewer context');
    });
  queue.set(toId, pending);
  void pending.then(() => {
    if (queue.get(toId) === pending) queue.delete(toId);
    if (row?.preparing) row.preparing--;
    if (owner === S.conv) publishState();
  });
}

function sendDelivery(toId: string, text: string, delivery: Delivery, context: string[] = []): void {
  const { from, sourceSeq, taskId, discarded } = delivery;
  const owner = S.conv;
  const agent = owner.agents[toId];
  const status = statusFor(owner, toId);
  if (!agent || !canReceiveWork(status)) {
    const reason = status.reason || status.availability;
    publish({ kind: 'error', agent: toId, text: '@' + toId + ' is unavailable: ' + reason + '.' });
    discarded?.(reason);
    return;
  }
  if (delivery.beforeSend && !delivery.beforeSend()) return discarded?.('the decision is closed');
  const id = taskId || randomUUID();
  const extras: string[] = [];
  const plan = originPlan(owner, delivery.requestSeq);
  const notices =
    plan && !plan.finished && (!sourceSeq || sourceSeq >= plan.seq) && toId === orchestratorId() ? plan.pendingRoutingNotices : undefined;
  if (notices?.length) extras.push(...notices.map((note) => '[Agent Bridge routing] ' + note));
  const handoff = owner.providerHandoffs.get(toId);
  if (handoff) {
    extras.push(handoff.summary);
    handoff.taskIds.add(id);
  }
  if (S.conv.pendingRoleNote[toId]) {
    extras.push(S.conv.pendingRoleNote[toId]);
    delete S.conv.pendingRoleNote[toId];
  }
  if ((S.conv.rosterSeen[toId] || 0) < S.conv.rosterVersion) {
    const team = S.conv.team.map((a) => ({
      id: a.id,
      name: a.name,
      roleName: S.roles[a.role]?.name || a.role,
      provider: DRIVERS[a.driver]?.label || a.driver,
      canEdit: S.roles[a.role]?.canEdit || 'all',
      model: owner.agents[a.id]?.resolvedModel || owner.agents[a.id]?.model,
      status: statusFor(owner, a.id),
    }));
    extras.push(rosterText(team, toId, S.conv.routingMode));
    S.conv.rosterSeen[toId] = S.conv.rosterVersion;
  }
  if (owner.team.some((member) => member.id === toId && member.role === 'orchestrator')) {
    const enabled = setting('recommendRoles') === 'ask';
    const declined = [...owner.refusedRoles].join(', ');
    extras.push(
      '[Role recommendations] ' +
        (enabled ? 'Enabled.' : 'Off. Do not emit recommendation blocks.') +
        (declined ? ' Declined roles: ' + declined + '.' : ''),
    );
  }
  if (plan?.approved?.length && owner.team.some((m) => m.id === toId && ['coder', 'reviewer'].includes(m.role)))
    extras.push('[Approved specification] ' + plan.approved.join(', '));
  extras.push(...context);
  S.conv.lastSender[toId] = from;
  if (from !== 'user') publish({ kind: 'routed', from, to: toId, relayed: true, hop: S.conv.relay.hops });
  const working = [...owner.tasks.values()].find((task) => task.agent === toId && task.state === 'working');
  const updateOf = delivery.updateOf || (from === 'user' ? working?.id : undefined);
  const task = {
    id,
    ...(updateOf && { updateOf, expectedTurn: working?.turnId }),
    ...(delivery.specAttempt && { specAttempt: delivery.specAttempt }),
    agent: toId,
    requestSeq: delivery.requestSeq,
    from,
    sourceSeq: sourceSeq ?? owner.plan?.seq ?? null,
    state: 'queued' as const,
  };
  S.conv.tasks.set(id, task);
  const member = owner.team.find((m) => m.id === toId);
  publish({
    kind: 'taskQueued',
    ...task,
    role: member?.role,
    name: member?.name,
    description:
      (updateOf ? 'Update: ' : '') +
      redact(text, loggingPrefixes())
        .split('\n')
        .filter((line) => line && !line.startsWith('['))
        .slice(0, 2)
        .join(' ')
        .slice(0, 180),
  });
  try {
    if (updateOf) updateNotice(owner, task, 'Update sent to @' + toId + '.');
    agent.send(extras.length ? extras.join('\n\n') + '\n\n' + text : text, id);
    if (notices?.length && plan && plan.pendingRoutingNotices === notices) {
      delete plan.pendingRoutingNotices;
      recordWorkflow(owner, plan);
    }
  } catch {
    handoff?.taskIds.delete(id);
    owner.tasks.delete(id);
    publish({ kind: 'tasksCancelled', agent: toId, taskIds: [id] } satisfies TaskEvent);
    discarded?.('provider rejected the delivery');
  }
}

export function updateNotice(owner: Conversation, task: TrackedTask, text: string) {
  if (!task.updateOf || task.updateStatus === text) return;
  task.updateStatus = text;
  publish({ kind: 'info', agent: task.agent, text, requestSeq: task.requestSeq });
  const part = owner.batch?.pending.get(task.agent);
  const plan = originPlan(owner, part?.requestSeq ?? task.requestSeq);
  if (plan && task.from !== 'user') {
    (plan.pendingRoutingNotices ??= []).push(text);
    recordWorkflow(owner, plan);
  }
}

/** git diff of the working tree (tracked changes + list of new files), trimmed to a reasonable size. */
async function diffContext(dir: string) {
  const changes = await reviewChanges(dir, config.reviewDiffExcludePatterns);
  if (!changes)
    return {
      text: '[Current changes]\n(No filtered file list is available. Git is unavailable, the folder has no Git history, or collection failed.)',
    };
  const { patch, files, omitted } = changes;
  const configured = Number(setting('reviewDiffMaxChars'));
  const limit = Number.isFinite(configured) && configured > 0 ? Math.max(1, Math.floor(configured)) : configured === 0 ? 0 : 40000;
  const metadataOnly = patch === null || (limit > 0 && patch.length > limit);
  const candidates = metadataOnly ? files : files.filter((file) => file.status === '??');
  let characters = 0;
  const shown = [];
  const lines = [];
  for (const file of candidates.slice(0, 5000)) {
    const line = file.status + ' ' + file.names.map((name) => JSON.stringify(name)).join(' \u2192 ');
    if (characters + line.length > 200000) break;
    characters += line.length + 1;
    lines.push(line);
    shown.push(file);
  }
  const list = lines.join('\n');
  const line =
    patch === null
      ? '(The filtered patch could not be read.)'
      : metadataOnly
        ? '(Patch exceeds the configured size limit. Showing file status only.)'
        : patch.trim() || '(no visible tracked changes)';
  return {
    text:
      '[Current changes (filtered git diff HEAD)]\n' +
      line +
      (list ? '\nFiltered files:\n' + list : '') +
      (shown.length < candidates.length ? '\nFile list truncated.' : '') +
      (omitted ? '\nSensitive paths omitted.' : ''),
    review: metadataOnly ? { files: shown.flatMap((file) => file.names), omitted: changes.omittedPaths, limit } : undefined,
  };
}
