// Routing: who receives each message, review rounds, missing roles, delivery to agents.
import type { AgentEvent, AgentSpec } from '../core/types.ts';
import { S } from './state.ts';
import { spawnSync } from 'node:child_process';
import { agentName, logError, publish, publishState } from './events.ts';
import { setting } from '../config/settings.ts';
import { DONE_MARKER, relay } from './state.ts';
import { checkTokenLimit } from './conversation.ts';
import { DRIVERS } from '../providers/registry.ts';
import { addAgent, providerBlocked } from './team.ts';
import { driverModelCache } from './state.ts';
import { isRecommended } from '../core/roles.ts';
import { rosterText } from '../core/prompts.ts';
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

export function onTurnEnd(fromId: string, ev: AgentEvent): void {
  const text = reviewNote(fromId, (ev.text || '').trim());
  const orch = orchestratorId();

  // Orchestrator mode: results of the agents the orchestrator delegated to are collected and delivered
  // in one message once all of them have finished (one orchestrator turn instead of one per result).
  if (S.conv.routingMode === 'orchestrator' && fromId !== orch && S.conv.batch?.pending.has(fromId)) {
    S.conv.batch.pending.delete(fromId);
    S.conv.batch.results.push({ from: fromId, text: text || `(no answer${ev.detail ? `: ${ev.detail}` : ''})` });
    if (S.conv.batch.pending.size) {
      publish({
        kind: 'system',
        text: `${agentName(fromId)} finished. Waiting for ${[...S.conv.batch.pending].map(agentName).join(', ')} before passing the results to ${agentName(orch)}.`,
      });
      return;
    }
    const results = S.conv.batch.results;
    S.conv.batch = null;
    if (!relay.auto || relay.halted || checkTokenLimit()) return;
    relay.hops += 1;
    const body = results.map((r) => `[Message from ${agentName(r.from)}]\n${r.text}`).join('\n\n');
    deliver(orch, results.length > 1 ? `[Results from ${results.length} agents]\n\n${body}` : body, { from: results[0].from });
    return;
  }
  if (!text) return;

  if (fromId === orch && handleNeedRole(fromId, text)) return;

  // In orchestrator mode only the orchestrator closes the work; a worker's [[DONE]] still goes back to it.
  const closes = S.conv.routingMode !== 'orchestrator' || fromId === orch;
  if (DONE_MARKER.test(text) && closes) {
    relay.halted = true;
    publish({ kind: 'system', text: `${agentName(fromId)} marked the work as done. Waiting for you.` });
    // Final confirmation: the user approves the result or asks for changes.
    if (setting('finalConfirmation') && S.conv.routingMode === 'orchestrator') {
      const requestId = `final-${Date.now()}`;
      S.conv.pendingFinal = requestId;
      publish({ kind: 'finalReview', agent: fromId, requestId, summary: text.replace(DONE_MARKER, '').trim() });
    }
    S.conv.reviewRounds = 0;
    publishState();
    return;
  }
  if (!relay.auto || relay.halted) return;
  if (checkTokenLimit()) return;
  const targets = routeTargets(fromId, text).filter((t) => S.conv.agents[t]);
  if (!targets.length) {
    publish({ kind: 'system', text: `${agentName(fromId)} replied to you.` });
    return;
  }
  if (relay.hops + targets.length > relay.maxHops) {
    relay.halted = true;
    publish({
      kind: 'system',
      text: `Relay paused after ${relay.hops} hand-offs (limit ${relay.maxHops}). Send a message or press Resume to continue.`,
    });
    publishState();
    return;
  }
  if (S.conv.routingMode === 'orchestrator' && fromId === orch) {
    S.conv.batch = S.conv.batch || { pending: new Set(), results: [] };
    for (const t of targets) S.conv.batch.pending.add(t);
  }
  for (const to of targets) {
    relay.hops += 1;
    deliver(to, `[Message from ${agentName(fromId)}]\n${text}`, { from: fromId });
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
  relay.halted = true;
  const sug = suggestFor(roleId);
  const requestId = `role-${Date.now()}`;
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
  relay.halted = false;
  relay.hops = 0;
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

/** Send a message to one agent, adding the team roster or a role note when they changed. */
export function deliver(toId: string, text: string, { from }: { from: string }): void {
  const agent = S.conv.agents[toId];
  if (!agent) return;
  const blocked = providerBlocked(S.conv.team.find((a) => a.id === toId)?.driver);
  if (blocked) {
    publish({ kind: 'error', agent: toId, text: `${agentName(toId)} was skipped: ${blocked.detail || blocked.state}.` });
    return;
  }
  if (agent.available === false) {
    publish({
      kind: 'error',
      agent: toId,
      text: `${agentName(toId)} is unavailable, so the message was not delivered. ${agent.unavailableReason || ''}`,
    });
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
      model: S.conv.agents[a.id]?.resolvedModel || S.conv.agents[a.id]?.model,
    }));
    extras.push(rosterText(team, toId, S.conv.routingMode));
    S.conv.rosterSeen[toId] = S.conv.rosterVersion;
  }
  // Roles with context "diff" (Reviewer) get the original request and the current changes, so they
  // review what changed instead of reading the whole conversation.
  const spec = S.conv.team.find((a) => a.id === toId);
  if (spec && S.roles[spec.role]?.context === 'diff' && from !== 'user') {
    extras.push(`[Original request from ${setting('userName')}]\n${S.conv.lastUserText || '(not available)'}`);
    extras.push(diffContext(agent.cwd || S.conv.workDir));
  }
  S.conv.lastSender[toId] = from;
  if (from !== 'user') publish({ kind: 'routed', from, to: toId, relayed: true, hop: relay.hops });
  agent.send(extras.length ? `${extras.join('\n\n')}\n\n${text}` : text);
}

/** git diff of the working tree (tracked changes + list of new files), trimmed to a reasonable size. */
export function diffContext(dir: string): string {
  const git = (args: string[]) =>
    spawnSync('git', args, { cwd: dir, encoding: 'utf8', windowsHide: true, timeout: 15000, maxBuffer: 20 * 1024 * 1024 });
  const inside = git(['rev-parse', '--is-inside-work-tree']);
  if (inside.status !== 0)
    return '[Current changes]\n(The project folder is not a git repository: read the files the coder reported as changed.)';
  const diff = git(['diff', 'HEAD', '--no-color']).stdout || '';
  const untracked = (git(['ls-files', '--others', '--exclude-standard']).stdout || '').trim();
  const limit = 40000;
  const body = diff.length > limit ? `${diff.slice(0, limit)}\n... (diff cut at ${limit} characters; run git diff for the rest)` : diff;
  return `[Current changes (git diff HEAD)]\n${body.trim() ? `\`\`\`diff\n${body.trim()}\n\`\`\`` : '(no changes to tracked files)'}${untracked ? `\nNew files not in git yet:\n${untracked}` : ''}`;
}

export function userSend(text: string, target?: string): void {
  S.conv.lastUserText = text;
  let targets;
  if (target === 'all') targets = S.conv.team.map((a) => a.id);
  else if (!target || target === 'auto') {
    // Only @mentions at the very start pick the receiver; mentions inside the text are instructions.
    const lead = (String(text).match(/^\s*(?:@[\w-]+[\s,:]*)+/) || [''])[0];
    const ment = mentions(lead, null);
    targets = ment.length ? ment : [S.conv.routingMode === 'orchestrator' ? orchestratorId() : S.conv.team[0]?.id];
  } else targets = [target];
  targets = targets.filter((t) => S.conv.agents[t]);
  if (!targets.length) throw new Error('no agent to receive this message');
  relay.hops = 0;
  relay.halted = false;
  publish({ kind: 'user', text, to: targets });
  const note = targets.length > 1 ? ` (sent to ${targets.length} agents)` : '';
  for (const t of targets) deliver(t, `[Message from ${setting('userName')}${note}]\n${text}`, { from: 'user' });
  publishState();
}
