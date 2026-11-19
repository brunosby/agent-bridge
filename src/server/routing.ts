// Routing: who receives each message, review rounds, missing roles, delivery to agents.
import type { AgentEvent, AgentSpec, Conversation } from '../core/types.ts';
import { S } from './state.ts';
import { agentName, logError, publish, publishState } from './events.ts';
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
import { resolveRecipients } from '../core/recipients.ts';
import { summarizeProject } from './project.ts';
export function orchestratorId() {
  return (S.conv.team.find((a) => a.role === 'orchestrator') || S.conv.team[0])?.id;
}

/** @mentions of team members in a message, in order, without duplicates. */
export function mentions(text: string, selfId: string | null): string[] {
  const byName = new Map(S.conv.team.map((a) => [a.name.toLowerCase(), a.id]));
  const out: string[] = [];
  for (const m of String(text).matchAll(/@([\w-]+)/g)) {
    const id = byName.get(m[1].toLowerCase());
    if (id && id !== selfId && !out.includes(id)) out.push(id);
  }
  return out;
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
      text: `The Reviewer still requests changes after ${max} fix round(s). ${agentName(orchestratorId())} will report to you instead of starting another round.`,
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
    publish({
      kind: 'system',
      text: agentName(agent) + ' finished. Waiting for ' + [...batch.pending.keys()].map(agentName).join(', ') + '.',
    });
    return;
  }
  if (!relay.auto || owner.relay.halted || checkTokenLimit() || !canReceiveWork(statusFor(owner, orch))) return;
  owner.relay.hops += 1;
  const body = batch.results.map((item) => '[Message from ' + agentName(item.from) + ']\n' + item.text).join('\n\n');
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

export function onTurnEnd(fromId: string, ev: AgentEvent): void {
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
  if (DONE_MARKER.test(text) && closes) {
    S.conv.relay.halted = true;
    publish({ kind: 'system', text: `${agentName(fromId)} marked the work as done. Waiting for you.` });
    // Final confirmation: the user approves the result or asks for changes.
    if (setting('finalConfirmation') && S.conv.routingMode === 'orchestrator') {
      const requestId = `final-${Date.now()}`;
      S.conv.pendingFinal = requestId;
      publish({
        kind: 'finalReview',
        agent: fromId,
        requestId,
        summary: text.replace(DONE_MARKER, '').trim(),
        project: summarizeProject(S.conv),
        tests: [...S.conv.testResults],
      });
    }
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
    ? 'Unavailable: ' + blocked.map(agentName).join(', ') + '. Choose available agents or explain what cannot proceed.'
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
    publish({ kind: 'system', text: `${agentName(fromId)} replied to you.` });
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
    deliver(to, '[Message from ' + agentName(fromId) + ']\n' + text, {
      from: fromId,
      sourceSeq: ev.sourceSeq ?? ev.seq,
      taskId,
      discarded: taskId ? (reason) => completeBatch(owner, to, taskId, '(not delivered: ' + reason + ')') : undefined,
    });
  }
}

export const NEED_ROLE = /\[\[NEED_ROLE:\s*([\w-]+)\s*\]\]/i;

/** Closest agent for a missing role: the role's fallback list, then the orchestrator. */
export function closestAgent(roleId: string): AgentSpec | undefined {
  for (const fb of S.roles[roleId]?.fallback || []) {
    const a = S.conv.team.find((x) => x.role === fb);
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
    resolveMissingRole(roleId, 'closest');
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

export async function resolveMissingRole(roleId: string, action: string): Promise<void> {
  const role = S.roles[roleId];
  const orch = orchestratorId();
  S.conv.pendingRoleRequest = null;
  S.conv.relay.halted = false;
  S.conv.relay.hops = 0;
  if (action === 'add') {
    const sug = suggestFor(roleId);
    const spec = await addAgent({ driver: sug.driver, role: roleId, model: sug.model });
    publish({ kind: 'system', text: `Added ${spec.name} for the missing ${role.name} role.` });
    deliver(orch, `[Message from ${setting('userName')}]\nI added @${spec.name} as ${role.name}. Continue and delegate that work to it.`, {
      from: 'user',
    });
  } else {
    const closest = closestAgent(roleId);
    publish({
      kind: 'system',
      text: `No ${role.name} added: continuing with ${closest?.name || 'the orchestrator'} as the closest agent.`,
    });
    logError('bridge', `missing role ${roleId}: continued with ${closest?.name || 'orchestrator'}`);
    deliver(
      orch,
      `[Message from ${setting('userName')}]\nNo ${role.name} will be added. ${closest && closest.id !== orch ? `Give that work to @${closest.name} (${S.roles[closest.role]?.name}), the closest role in the team.` : 'Handle that part yourself as far as your role allows, and tell me what is left.'}`,
      { from: 'user' },
    );
  }
  publishState();
}

export function userTargets(target?: string, prefix?: string) {
  return resolveRecipients(S.conv.team, S.conv.routingMode, target, prefix).filter((id) => Object.hasOwn(S.conv.agents, id));
}

export function userSend(text: string, target?: string): void {
  const targets = userTargets(target, text);
  if (!targets.length) throw new Error('no agent to receive this message');
  S.conv.lastUserText = text;
  S.conv.relay.hops = 0;
  S.conv.relay.halted = false;
  const source = publish({ kind: 'user', text, to: targets });
  const note = targets.length > 1 ? ` (sent to ${targets.length} agents)` : '';
  for (const t of targets) deliver(t, `[Message from ${setting('userName')}${note}]\n${text}`, { from: 'user', sourceSeq: source.seq });
  publishState();
}
