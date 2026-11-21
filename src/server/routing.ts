import { cancelMilestoneDecision, hasActiveMilestones, milestoneInstructions } from './milestones.ts';
// Routing: who receives each message, review rounds, missing roles, delivery to agents.
import type { AgentSpec, BatchEvent, Conversation, RoleDecisionEvent, RoleRecommendation, TurnEnded } from '../core/types.ts';
import { S } from './state.ts';
import { logError, publish, publishState } from './events.ts';
import { setting } from '../config/settings.ts';
import { DONE_MARKER, relay } from './state.ts';
import { checkTokenLimit } from './conversation.ts';
import { DRIVERS } from '../providers/registry.ts';
import { addAgent, providerBlocked, statusFor } from './team.ts';
import { canReceiveWork } from '../core/agent-status.ts';
import { addBatchPart, finishBatchPart } from './batch.ts';
import { deliver } from './delivery.ts';
import { driverModelCache } from './state.ts';
import { isRecommended } from '../core/roles.ts';
import { randomUUID } from 'node:crypto';
import { mentionedAgents, resolveRecipients, toMentionIds, validateMentionChecks } from '../core/recipients.ts';
import { changeFingerprint } from '../workspace/git-context.ts';
import { publishFinalReview } from './final-review.ts';
export function orchestratorId() {
  return (S.conv.team.find((a) => a.role === 'orchestrator') || S.conv.team[0])?.id;
}

/** @mentions of team members in a message, in order, without duplicates. */
export function mentions(text: string, selfId: string | null): string[] {
  return mentionedAgents(text, S.conv.team).filter((id) => id !== selfId);
}

export function nextInOrder(fromId: string, wrap: boolean): string | null {
  const ids = S.conv.team.map((a) => a.id);
  const i = ids.indexOf(fromId);
  if (i < 0) return null;
  if (i + 1 < ids.length) return ids[i + 1];
  return wrap && ids.length > 1 ? ids[0] : null;
}

/** Who receives an agent's final message, by routing mode. Empty list = it is for the user. */
export function routeTargets(fromId: string, text: string): string[] {
  const mode = S.conv.routingMode;
  const ment = mentions(text, fromId);
  if (mode === 'orchestrator') {
    const orch = orchestratorId();
    if (fromId === orch) return ment;
    return orch && orch !== fromId ? [orch] : [];
  }
  if (mode === 'mentions') {
    if (ment.length) return ment;
    const back = S.conv.lastSender[fromId];
    return back && back !== 'user' && S.conv.agents[back] ? [back] : [];
  }
  if (mode === 'pipeline') return [nextInOrder(fromId, false)].filter((x): x is string => Boolean(x));
  if (mode === 'roundrobin') return [nextInOrder(fromId, true)].filter((x): x is string => Boolean(x));
  return [];
}

/**
 * Review rounds: each CHANGES REQUESTED from a Reviewer counts one round; APPROVED resets the count.
 * Past maxReviewRounds the orchestrator is told to stop the fix loop and report to the user instead.
 */
export function reviewNote(fromId: string, text: string): string {
  if (S.conv.team.find((a) => a.id === fromId)?.role !== 'reviewer' || !text) return text;
  if (/^\W*APPROVED/i.test(text)) {
    S.conv.reviewRounds = 0;
    return text;
  }
  if (!/^\W*CHANGES REQUESTED/i.test(text)) return text;
  S.conv.reviewRounds = (S.conv.reviewRounds || 0) + 1;
  const max = Number(setting('maxReviewRounds'));
  if (S.conv.reviewRounds > max) {
    publish({
      kind: 'system',
      text: `The Reviewer still requests changes after ${max} fix round(s). @${orchestratorId()} will report to you instead of starting another round.`,
    });
    logError('bridge', `review round limit (${max}) reached`);
    return `${text}\n\n[Agent Bridge: review round limit (${max}) reached. Do not send this back to the coder. Summarize for the user what was done and the open findings, and end with [[DONE]].]`;
  }
  return `${text}\n\n[Agent Bridge: review round ${S.conv.reviewRounds} of ${max}. Send the findings to the coder.]`;
}

function completeBatch(owner: Conversation, agent: string, taskId: string, text: string, sourceSeq?: number) {
  if (owner !== S.conv) return;
  const batch = finishBatchPart(owner, agent, taskId, text, sourceSeq);
  if (!batch) return;
  const orch = orchestratorId();
  if (batch.pending.size) {
    const pending = [...batch.pending.keys()];
    publish({
      kind: 'batchProgress',
      agent,
      pending,
      text: '@' + agent + ' finished. Waiting for ' + pending.map((id) => '@' + id).join(', ') + '.',
    } satisfies BatchEvent);
    return;
  }
  publish({ kind: 'batchCompleted', agents: batch.results.map((part) => part.from) } satisfies BatchEvent);
  if (!relay.auto || owner.relay.halted || checkTokenLimit() || !canReceiveWork(statusFor(owner, orch))) return;
  owner.relay.hops += 1;
  const body = batch.results.map((item) => '[Message from @' + item.from + ']\n' + item.text).join('\n\n');
  const intro = batch.results.length > 1 ? '[Results from ' + batch.results.length + ' agents]\n\n' : '';
  deliver(orch, intro + body, {
    from: batch.results[0].from,
    sourceSeq: sourceSeq ?? batch.results.findLast((item) => item.sourceSeq)?.sourceSeq,
  });
}

export function cancelBatchPart(owner: Conversation, agent: string, reason: string, taskIds?: string[]) {
  const taskId = owner.batch?.pending.get(agent);
  if (taskId && (!taskIds || taskIds.includes(taskId))) completeBatch(owner, agent, taskId, '(' + reason + ')');
}

export function onTurnEnd(fromId: string, ev: TurnEnded & { seq?: number; sourceSeq?: number }): void {
  const text = reviewNote(fromId, (ev.text || '').trim());
  const orch = orchestratorId();

  const owner = S.conv;
  const task = owner.batch?.pending.get(fromId);
  if (task) {
    if (ev.taskIds?.includes(task)) {
      completeBatch(owner, fromId, task, text || '(no answer' + (ev.detail ? ': ' + ev.detail : '') + ')', ev.sourceSeq ?? ev.seq);
    }
    return;
  }
  if (!text) return;

  if (fromId === orch && handleNeedRole(fromId, text)) return;

  // In orchestrator mode only the orchestrator closes the work; a worker's [[DONE]] still goes back to it.
  const closes = S.conv.routingMode !== 'orchestrator' || fromId === orch;
  if (DONE_MARKER.test(text) && closes && hasActiveMilestones(owner)) {
    publish({ kind: 'info', agent: fromId, text: 'Approved milestones are still pending. Finish them before closing the work.' });
    return;
  }
  if (DONE_MARKER.test(text) && closes) {
    S.conv.relay.halted = true;
    publish({ kind: 'system', text: `@${fromId} marked the work as done. Waiting for you.` });
    // Final confirmation: the user approves the result or asks for changes, only when files changed.
    if (setting('finalConfirmation') && S.conv.routingMode === 'orchestrator') void offerFinalReview(fromId, text);
    S.conv.reviewRounds = 0;
    publishState();
    return;
  }
  if (!relay.auto || S.conv.relay.halted) return;
  if (checkTokenLimit()) return;
  const requested = routeTargets(fromId, text).filter((id) => owner.agents[id]);
  const targets = requested.filter((id) => canReceiveWork(statusFor(owner, id)) && !owner.batch?.pending.has(id));
  const blocked = requested.filter((id) => !canReceiveWork(statusFor(owner, id)));
  const note = blocked.length
    ? 'Unavailable: ' + blocked.map((id) => '@' + id).join(', ') + '. Choose available agents or explain what cannot proceed.'
    : '';
  if (note) publish({ kind: 'system', text: note });
  if (!targets.length) {
    if (note && fromId === orch) {
      if (owner.relay.hops < relay.maxHops) {
        owner.relay.hops += 1;
        deliver(orch, '[Message from Agent Bridge]\n' + note, { from: 'user' });
      }
      return;
    }
    publish({ kind: 'system', text: `@${fromId} replied to you.` });
    return;
  }
  if (S.conv.relay.hops + targets.length > relay.maxHops) {
    S.conv.relay.halted = true;
    publish({
      kind: 'system',
      text: `Relay paused after ${S.conv.relay.hops} hand-offs (limit ${relay.maxHops}). Send a message or press Resume to continue.`,
    });
    publishState();
    return;
  }
  const deliveries = targets.map((to) => ({
    to,
    taskId: owner.routingMode === 'orchestrator' && fromId === orch ? addBatchPart(owner, to) : undefined,
  }));
  for (const { to, taskId } of deliveries) {
    owner.relay.hops += 1;
    deliver(to, '[Message from @' + fromId + ']\n' + text, {
      from: fromId,
      sourceSeq: ev.sourceSeq ?? ev.seq,
      taskId,
      discarded: taskId ? (reason) => completeBatch(owner, to, taskId, '(not delivered: ' + reason + ')') : undefined,
    });
  }
}

export function clearRoleDecisions(owner: Conversation, action: string) {
  owner.roleDecisionVersion += 1;
  if (owner.pendingRoleRequest) {
    publish({ kind: 'needRoleClosed', requestId: owner.pendingRoleRequest.requestId, action } satisfies RoleDecisionEvent);
    owner.pendingRoleRequest = null;
  }
  if (owner.pendingRecommendation) {
    publish({ kind: 'recommendRolesClosed', requestId: owner.pendingRecommendation.requestId, action } satisfies RoleDecisionEvent);
    owner.pendingRecommendation = null;
  }
}

export function dismissRoleDecision(owner: Conversation) {
  clearRoleDecisions(owner, 'dismiss');
  owner.relay.halted = owner.relay.userPaused;
  publishState();
}

function sendRoleDecision(owner: Conversation, text: string) {
  const orch = orchestratorId();
  if (!orch) return;
  if (owner.relay.userPaused) {
    owner.pendingRoleNote[orch] = [owner.pendingRoleNote[orch], text].filter(Boolean).join('\n');
    return;
  }
  deliver(orch, '[Message from ' + setting('userName') + ']\n' + text, { from: 'user' });
}

export function offerRecommendedRoles(owner: Conversation, id: string, received: { id: string; reason: string }[]): boolean {
  if (owner.team.find((member) => member.id === id)?.role !== 'orchestrator' || setting('recommendRoles') !== 'ask') return false;
  if (owner.pendingRoleRequest || owner.pendingRecommendation) {
    publish({ kind: 'info', agent: id, text: 'A role decision is already waiting for you.' });
    return true;
  }
  const seen = new Set(owner.team.map((agent) => agent.role));
  const roles: RoleRecommendation[] = [];
  for (const { id: roleId, reason } of received) {
    if (!Object.hasOwn(S.roles, roleId) || seen.has(roleId) || owner.refusedRoles.has(roleId)) continue;
    seen.add(roleId);
    const suggestion = suggestFor(roleId);
    roles.push({
      id: roleId,
      name: S.roles[roleId].name,
      reason,
      suggestion: { ...suggestion, driverLabel: DRIVERS[suggestion.driver].label },
    });
    if (roles.length === 3) break;
  }
  if (!roles.length) return false;
  const requestId = 'recommend-' + randomUUID();
  owner.pendingRecommendation = { requestId, roles, resolving: false };
  owner.relay.halted = true;
  publish({ kind: 'recommendRoles', agent: id, requestId, roles } satisfies RoleDecisionEvent);
  publishState();
  return true;
}

export async function resolveRecommendedRoles(requestId: string, selected: string[]) {
  const owner = S.conv;
  const request = owner.pendingRecommendation;
  if (!request || request.requestId !== requestId || request.resolving) throw new Error('this recommendation is no longer pending');
  const choices = new Set(selected);
  if (choices.size !== selected.length || selected.some((id) => !request.roles.some((role) => role.id === id)))
    throw new Error('invalid recommended roles');
  request.resolving = true;
  const results: { role: string; ok: boolean; reason?: string }[] = [];
  for (const role of request.roles) {
    if (S.conv !== owner || owner.pendingRecommendation !== request) return { results };
    if (!choices.has(role.id)) {
      owner.refusedRoles.add(role.id);
      continue;
    }
    try {
      let spec = owner.team.find((member) => member.role === role.id);
      if (!spec) spec = await addAgent({ driver: role.suggestion.driver, role: role.id, model: role.suggestion.model }, true);
      if (S.conv !== owner || owner.pendingRecommendation !== request) return { results };
      const status = statusFor(owner, spec.id);
      const ok = canReceiveWork(status);
      results.push({ role: role.id, ok, ...(ok ? {} : { reason: status.reason || status.availability }) });
    } catch (error) {
      results.push({ role: role.id, ok: false, reason: error instanceof Error ? error.message : String(error) });
    }
  }
  if (S.conv !== owner || owner.pendingRecommendation !== request) return { results };
  clearRoleDecisions(owner, 'resolved');
  owner.relay.halted = owner.relay.userPaused;
  const ready = owner.team
    .filter((agent) => canReceiveWork(statusFor(owner, agent.id)))
    .map((agent) => '@' + agent.id + ' (' + agent.role + ')');
  const refused = request.roles.filter((role) => !choices.has(role.id)).map((role) => role.name);
  const failed = results.filter((result) => !result.ok).map((result) => result.role + ' (' + result.reason + ')');
  const added = results.filter((result) => result.ok).map((result) => result.role);
  const summary = [
    'Role decision completed. Available team: ' + (ready.join(', ') || 'none') + '.',
    added.length && 'Added: ' + added.join(', ') + '.',
    refused.length && 'Declined for this conversation: ' + refused.join(', ') + '.',
    failed.length && 'Could not start: ' + failed.join(', ') + '.',
  ]
    .filter(Boolean)
    .join(' ');
  publish({ kind: 'system', text: summary });
  sendRoleDecision(owner, summary + ' Continue with the available team.');
  publishState();
  return { results };
}

export const NEED_ROLE = /\[\[NEED_ROLE:\s*([\w-]+)\s*\]\]/i;

/** Closest agent for a missing role: the role's fallback list, then the orchestrator. */
export function closestAgent(roleId: string): AgentSpec | undefined {
  for (const fb of S.roles[roleId]?.fallback || []) {
    const a = S.conv.team.find((x) => x.role === fb && canReceiveWork(statusFor(S.conv, x.id)));
    if (a) return a;
  }
  return S.conv.team.find((x) => x.id === orchestratorId());
}

/** Provider and model to suggest for a role: the first available model recommended for it. */
export function suggestFor(roleId: string): { driver: string; model: string | null; modelLabel: string } {
  const role = S.roles[roleId];
  for (const driver of Object.keys(DRIVERS)) {
    const models = driverModelCache[driver]?.models || [];
    const m = models.find((x) => x.value !== 'default' && !x.disabled && isRecommended(role, x));
    if (m && !providerBlocked(driver)) return { driver, model: m.value, modelLabel: m.label || m.value };
  }
  // No recommended model known: use the provider of the first agent in the team.
  const driver = S.conv.team[0]?.driver || 'claude';
  return { driver, model: null, modelLabel: 'default model' };
}

/** The orchestrator asked for a role nobody has. Ask the user (default) or continue with the closest agent. */
export function handleNeedRole(fromId: string, text: string): boolean {
  const m = NEED_ROLE.exec(text);
  if (!m) return false;
  const roleId = m[1].toLowerCase();
  if (S.conv.pendingRoleRequest || S.conv.pendingRecommendation) {
    publish({ kind: 'info', agent: fromId, text: 'A role decision is already waiting for you.' });
    return true;
  }
  const existing = S.conv.team.find((a) => a.role === roleId);
  if (!S.roles[roleId] || existing) {
    deliver(
      fromId,
      `[Message from Agent Bridge]\n${existing ? `@${existing.name} already has the ${S.roles[roleId].name} role; delegate to it.` : `"${roleId}" is not a role in this app. Roles: ${Object.keys(S.roles).join(', ')}.`}`,
      { from: 'user' },
    );
    return true;
  }
  const closest = closestAgent(roleId);
  if (setting('missingRolePolicy') === 'closest') {
    void resolveMissingRole(roleId, 'closest');
    return true;
  }
  S.conv.relay.halted = true;
  const sug = suggestFor(roleId);
  const requestId = 'role-' + randomUUID();
  S.conv.pendingRoleRequest = { requestId, roleId };
  publish({
    kind: 'needRole',
    agent: fromId,
    requestId,
    role: roleId,
    roleName: S.roles[roleId].name,
    suggestion: { ...sug, driverLabel: DRIVERS[sug.driver].label },
    closest: closest ? { id: closest.id, name: closest.name, roleName: S.roles[closest.role]?.name } : null,
  });
  publishState();
  return true;
}

export async function resolveMissingRole(roleId: string, action: 'add' | 'closest'): Promise<void> {
  const owner = S.conv;
  const role = S.roles[roleId];
  const orch = orchestratorId();
  clearRoleDecisions(owner, action);
  const version = owner.roleDecisionVersion;
  if (action === 'add') {
    const sug = suggestFor(roleId);
    const spec = await addAgent({ driver: sug.driver, role: roleId, model: sug.model }, true);
    if (S.conv !== owner || owner.roleDecisionVersion !== version) return;
    const status = statusFor(owner, spec.id);
    const message = canReceiveWork(status)
      ? 'I added @' + spec.id + ' as ' + role.name + '. Continue and delegate that work to it.'
      : '@' +
        spec.id +
        ' could not start as ' +
        role.name +
        ': ' +
        (status.reason || status.availability) +
        '. Continue with the available team.';
    publish({ kind: 'system', text: message });
    sendRoleDecision(owner, message);
  } else {
    const closest = closestAgent(roleId);
    const message =
      'No ' +
      role.name +
      ' will be added. ' +
      (closest && closest.id !== orch
        ? 'Give that work to @' + closest.id + ' (' + S.roles[closest.role]?.name + '), the closest role in the team.'
        : 'Handle that part yourself as far as your role allows, and tell me what is left.');
    publish({ kind: 'system', text: message });
    sendRoleDecision(owner, message);
  }
  owner.relay.halted = owner.relay.userPaused;
  owner.relay.hops = 0;
  publishState();
}

/** Capture the Git state for the main workspace and any agent worktrees before delivery. */
async function captureChangeMark(owner: Conversation): Promise<NonNullable<Conversation['changeMark']>> {
  const folders = new Set([owner.workDir, ...owner.team.flatMap((agent) => (agent.cwd ? [agent.cwd] : []))]);
  const before = await Promise.all([...folders].map(async (folder) => [folder, await changeFingerprint(folder)] as const));
  return { before: new Map(before), editTools: new Map(), editedFolders: new Set() };
}

async function filesChanged(mark: Conversation['changeMark']): Promise<boolean> {
  if (!mark) return true; // No baseline was captured for restored work.
  if ([...mark.editedFolders].some((folder) => mark.before.get(folder) == null)) return true;
  const results = await Promise.all(
    [...mark.before].map(async ([folder, before]) => {
      const after = await changeFingerprint(folder);
      return after !== null && after !== before;
    }),
  );
  return results.some(Boolean);
}

async function offerFinalReview(fromId: string, text: string): Promise<void> {
  const conv = S.conv;
  const version = conv.roleDecisionVersion;
  const mark = conv.changeMark;
  const changed = await filesChanged(mark).catch(() => true);
  if (S.conv !== conv || conv.changeMark !== mark || conv.roleDecisionVersion !== version || !conv.relay.halted) return;
  if (!changed) {
    publish({ kind: 'system', text: 'No files changed, so there is nothing to approve.' });
    return;
  }
  publishFinalReview(conv, fromId, text);
}

export function userTargets(target?: string, prefix?: string) {
  return resolveRecipients(S.conv.team, S.conv.routingMode, target, prefix).filter((id) => Object.hasOwn(S.conv.agents, id));
}

const pendingUserSends = new WeakMap<Conversation, Promise<void>>();

export async function userSend(text: string, target?: string, mentionChecks?: unknown): Promise<void> {
  const owner = S.conv;
  const previous = pendingUserSends.get(owner);
  const delivery = (previous ?? Promise.resolve())
    .catch(() => {})
    .then(async () => {
      if (S.conv !== owner) throw new Error('conversation changed before sending');
      validateMentionChecks(owner.team, mentionChecks);
      const canonical = toMentionIds(text, owner.team);
      if (!userTargets(target, canonical).length) throw new Error('no agent to receive this message');
      const checkFiles = setting('finalConfirmation') && owner.routingMode === 'orchestrator';
      const mark = checkFiles ? await captureChangeMark(owner) : null;
      if (S.conv !== owner) throw new Error('conversation changed before sending');
      validateMentionChecks(owner.team, mentionChecks);
      const targets = userTargets(target, canonical);
      if (!targets.length) throw new Error('no agent to receive this message');
      clearRoleDecisions(owner, 'new message');
      cancelMilestoneDecision(owner, 'new message');
      owner.relay.userPaused = false;
      owner.lastUserText = canonical;
      owner.changeMark = mark;
      owner.relay.hops = 0;
      owner.relay.halted = owner.relay.userPaused;
      const source = publish({ kind: 'user', text: canonical, to: targets });
      const note = targets.length > 1 ? ' (sent to ' + targets.length + ' agents)' : '';
      for (const to of targets) {
        const instructions = to === orchestratorId() ? milestoneInstructions(owner) : '';
        const message = '[Message from ' + setting('userName') + ']' + note + '\n' + canonical;
        deliver(to, instructions ? instructions + '\n\n' + message : message, { from: 'user', sourceSeq: source.seq });
      }
      publishState();
    });
  pendingUserSends.set(owner, delivery);
  try {
    await delivery;
  } finally {
    if (pendingUserSends.get(owner) === delivery) pendingUserSends.delete(owner);
  }
}
