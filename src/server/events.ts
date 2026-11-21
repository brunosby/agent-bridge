import { mapMentions } from '../../public/js/core/mentions.js';
import { milestoneCommitAvailable, milestoneViews } from './milestones.ts';
// Event bus: everything the page shows goes through publish() and the state snapshot.
import type { Agent, AgentSpec, BridgeEvent, ModelInfo } from '../core/types.ts';
import type { ServerResponse } from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { S, clients, relay } from './state.ts';
import { safeRegex, setting } from '../config/settings.ts';
import { providerBlocked, statusFor } from './team.ts';
import { canReceiveWork } from '../core/agent-status.ts';
import { isRecommended } from '../core/roles.ts';
import { projectLabel } from './project.ts';
import { DRIVERS } from '../providers/registry.ts';

export function publish(ev: BridgeEvent): BridgeEvent {
  const full: BridgeEvent = { seq: ++S.seq, at: Date.now(), ...ev };
  S.history.push(full);
  if (S.history.length > 20000) S.history.splice(0, S.history.length - 20000);
  const saved = full.kind === 'milestonePlanProposed' ? { ...full, command: '', commandSaved: false } : full;
  S.conv?.transcript.write(JSON.stringify(saved) + '\n');
  if (full.kind === 'error')
    logError(
      full.agent ? agentName(full.agent) : 'bridge',
      mapMentions(String(full.text), (id: string) => {
        const name = agentName(id);
        return name === id ? undefined : '@' + name;
      }),
    );
  const line = `data: ${JSON.stringify(full)}\n\n`;
  if (full.kind !== 'projectBaseline') for (const res of clients) res.write(line);
  return full;
}

/** errors.log next to the transcript: one line per problem, for finding causes later. */
export function logError(source: string, text: unknown): void {
  if (!S.conv) return;
  try {
    fs.appendFileSync(
      path.join(S.conv.runDir, 'errors.log'),
      `${new Date().toISOString()} [${source}] ${String(text).replace(/\s+$/g, '')}\n`,
    );
  } catch {
    // logging must never break the app
  }
}

export const agentName = (id: string): string => S.conv?.team.find((a) => a.id === id)?.name || S.conv?.retiredAgents.get(id)?.name || id;

export function decorateModels(spec: AgentSpec, agent: Agent): ModelInfo[] {
  const role = S.roles[spec.role];
  const sensitive = (setting('sensitiveModelPatterns') as string[]).map((p) => safeRegex(p)).filter((r): r is RegExp => r !== null);
  const blocked = providerBlocked(spec.driver);
  return (agent.models || []).map((m) => ({
    ...m,
    recommended: isRecommended(role, m),
    sensitive: sensitive.some((r) => r.test(`${m.value} ${m.label || ''}`)),
    disabled: Boolean(m.disabled) || !agent.available || Boolean(blocked),
    disabledReason: m.disabledReason || (!agent.available ? agent.unavailableReason : blocked ? blocked.detail || blocked.state : null),
  }));
}

export function teamState() {
  return S.conv.team.map((spec) => {
    const a = S.conv.agents[spec.id];
    const status = statusFor(S.conv, spec.id);
    return {
      id: spec.id,
      name: spec.name,
      driver: spec.driver,
      driverLabel: DRIVERS[spec.driver]?.label || spec.driver,
      role: spec.role,
      cwd: a?.cwd || S.conv.workDir,
      worktree: spec.worktree || null,
      busy: Boolean(a?.busy),
      waitingApproval: a?.approvals?.size || 0,
      bypass: Boolean(spec.bypass),
      sessionId: a?.sessionId || a?.threadId || spec.sessionId || null,
      model: a?.model || 'default',
      effort: a?.effort || 'default',
      resolvedModel: a?.resolvedModel || null,
      models: a ? decorateModels(spec, a) : [],
      tokens: a?.tokens || 0,
      cachedTokens: a?.cachedTokens || 0,
      status,
      available: canReceiveWork(status),
      unavailableReason: status.reason,
      account: providerBlocked(spec.driver),
    };
  });
}

export function stateEvent() {
  const team = teamState();
  return {
    kind: 'state',
    tasks: [...S.conv.tasks.values()],
    project: projectLabel(S.conv),
    milestones: milestoneViews(S.conv),
    milestoneCommitAvailable: milestoneCommitAvailable(S.conv),
    conversationId: S.conv.id,
    workDir: S.conv.workDir,
    routingMode: S.conv.routingMode,
    lastAgentId: S.conv.nextAgent,
    knownAgents: [
      ...[...S.conv.retiredAgents.values()].map((member) => ({ ...member, removed: true })),
      ...team.map(({ id, name, driver, role }) => ({ id, name, driver, role, removed: false })),
    ],
    relay: { ...relay, ...S.conv.relay, held: S.conv.heldRelays.length },
    tokenLimit: Number(setting('tokenLimit')),
    totalTokens: team.reduce((s, a) => s + a.tokens, 0),
    totalCachedTokens: team.reduce((s, a) => s + a.cachedTokens, 0),
    team,
  };
}

export function publishState() {
  if (!S.conv) return;
  publish(stateEvent());
}

/** A state snapshot sent before replaying S.history, so names and S.roles are known while it renders. */
export function snapshotLine() {
  return S.conv ? `data: ${JSON.stringify({ seq: 0, at: Date.now(), ...stateEvent() })}\n\n` : '';
}

export function resetClients() {
  for (const res of clients) {
    res.write(`data: ${JSON.stringify({ kind: 'reset' })}\n\n`);
    res.write(snapshotLine());
    replayHistory(res);
  }
}

export function replayHistory(res: ServerResponse): void {
  for (const ev of S.history) {
    if (ev.kind === 'state' || ev.kind === 'projectBaseline') continue;
    res.write(`data: ${JSON.stringify(ev)}\n\n`);
  }
  res.write('data: {"kind":"replayComplete"}\n\n');
}
