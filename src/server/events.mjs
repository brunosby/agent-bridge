// Event bus: everything the page shows goes through publish() and the state snapshot.
import fs from 'node:fs';
import path from 'node:path';
import { S, clients, relay } from './state.mjs';
import { safeRegex, setting } from '../config/settings.mjs';
import { providerBlocked } from './team.mjs';
import { isRecommended } from '../core/roles.mjs';
import { DRIVERS } from '../providers/registry.mjs';

export function publish(ev) {
  const full = { seq: ++S.seq, at: Date.now(), ...ev };
  S.history.push(full);
  if (S.history.length > 20000) S.history.splice(0, S.history.length - 20000);
  S.conv?.transcript.write(JSON.stringify(full) + '\n');
  if (full.kind === 'error') logError(full.agent ? agentName(full.agent) : 'bridge', full.text);
  const line = `data: ${JSON.stringify(full)}\n\n`;
  for (const res of clients) res.write(line);
}

/** errors.log next to the transcript: one line per problem, for finding causes later. */
export function logError(source, text) {
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

export const agentName = (id) => S.conv?.team.find((a) => a.id === id)?.name || id;

export function decorateModels(spec, agent) {
  const role = S.roles[spec.role];
  const sensitive = setting('sensitiveModelPatterns')
    .map((p) => safeRegex(p))
    .filter(Boolean);
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
      available: a ? a.available !== false : false,
      unavailableReason: a?.unavailableReason || null,
      account: providerBlocked(spec.driver),
    };
  });
}

export function stateEvent() {
  const team = teamState();
  return {
    kind: 'state',
    conversationId: S.conv.id,
    workDir: S.conv.workDir,
    routingMode: S.conv.routingMode,
    relay: { ...relay },
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
    for (const ev of S.history) res.write(`data: ${JSON.stringify(ev)}\n\n`);
  }
}
