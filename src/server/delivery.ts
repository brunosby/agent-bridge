import { canReceiveWork } from '../core/agent-status.ts';
import { rosterText } from '../core/prompts.ts';
import { reviewChanges } from '../workspace/git-context.ts';
import { closeReview, openReview } from './review-mcp.ts';
import { randomUUID } from 'node:crypto';
import { config, setting } from '../config/settings.ts';
import { agentName, publish } from './events.ts';
import { statusFor } from './team.ts';
import { S } from './state.ts';

/** Send a message to one agent, adding the team roster or a role note when they changed. */
type Delivery = { from: string; sourceSeq?: number; taskId?: string; discarded?: (reason: string) => void };
const reviewerQueues = new WeakMap<typeof S.conv, Map<string, Promise<void>>>();

export function deliver(toId: string, text: string, delivery: Delivery): void {
  const owner = S.conv;
  const agent = owner.agents[toId];
  const spec = owner.team.find((member) => member.id === toId);
  if (!agent || !spec) return delivery.discarded?.('agent is no longer on the team');
  const role = spec.role;
  const needsDiff = S.roles[role]?.context === 'diff' && delivery.from !== 'user';
  let queue = reviewerQueues.get(owner);
  const previous = queue?.get(toId);
  if (!needsDiff && !previous) return sendDelivery(toId, text, delivery);
  if (!queue) reviewerQueues.set(owner, (queue = new Map()));
  const original = needsDiff ? '[Original request from ' + setting('userName') + ']\n' + (owner.lastUserText || '(not available)') : '';
  const valid = () =>
    S.conv === owner &&
    owner.agents[toId] === agent &&
    spec.role === role &&
    (!delivery.taskId || owner.batch?.pending.get(toId) === delivery.taskId);
  const discard = () => delivery.discarded?.('agent or batch changed while preparing the delivery');
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
  });
}

function sendDelivery(toId: string, text: string, delivery: Delivery, context: string[] = []): void {
  const { from, sourceSeq, taskId, discarded } = delivery;
  const owner = S.conv;
  const agent = owner.agents[toId];
  const status = statusFor(owner, toId);
  if (!agent || !canReceiveWork(status)) {
    const reason = status.reason || status.availability;
    publish({ kind: 'error', agent: toId, text: agentName(toId) + ' is unavailable: ' + reason + '.' });
    discarded?.(reason);
    return;
  }
  const extras = [];
  if (S.conv.pendingRoleNote[toId]) {
    extras.push(S.conv.pendingRoleNote[toId]);
    delete S.conv.pendingRoleNote[toId];
  }
  if ((S.conv.rosterSeen[toId] || 0) < S.conv.rosterVersion) {
    const team = S.conv.team.map((a) => ({
      id: a.id,
      name: a.name,
      roleName: S.roles[a.role]?.name || a.role,
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
  extras.push(...context);
  S.conv.lastSender[toId] = from;
  if (from !== 'user') publish({ kind: 'routed', from, to: toId, relayed: true, hop: S.conv.relay.hops });
  const id = taskId || randomUUID();
  const task = { id, agent: toId, from, sourceSeq: sourceSeq || null, state: 'queued' as const };
  S.conv.tasks.set(id, task);
  publish({ kind: 'taskQueued', ...task });
  try {
    agent.send(extras.length ? extras.join('\n\n') + '\n\n' + text : text, id);
  } catch {
    owner.tasks.delete(id);
    publish({ kind: 'tasksCancelled', agent: toId, taskIds: [id] });
    discarded?.('provider rejected the delivery');
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
