import { randomUUID } from 'node:crypto';
import { canReceiveWork } from '../core/agent-status.ts';
import type { Agent, AgentSpec, Conversation } from '../core/types.ts';
import { DRIVERS } from '../providers/registry.ts';
import { agentOperationPending, statusOf } from './agent-lifecycle.ts';
import { finishProviderDeliveries, isPreparingDelivery } from './delivery.ts';
import { publish, publishState } from './events.ts';
import { flushMentionStreams } from './mention-stream.ts';
import { buildProviderHandoff, saveProviderHandoff } from './provider-handoff.ts';
import { revokeReviewClient } from './review-mcp.ts';
import { cancelBatchPart } from './routing.ts';
import { revokeShellApprovals } from './shell-approvals.ts';
import { S } from './state.ts';
import { buildAgent, installAgent, providerBlocked, startAgent, validateAgentChoice } from './team.ts';

function checkIdle(owner: Conversation, agent: Agent): void {
  if (S.conv !== owner || owner.agents[agent.id] !== agent) throw new Error('The conversation or agent changed. Try again.');
  if (agentOperationPending(agent) || statusOf(agent).availability === 'starting')
    throw new Error('Wait for the current agent update to finish before changing provider.');
  if (agent.busy || agent.approvals.size || isPreparingDelivery(owner, agent.id))
    throw new Error('Use Stop or wait for the agent to finish before changing provider.');
}

export async function changeProvider(id: string, input: { driver: unknown; model?: unknown; effort?: unknown }) {
  const owner = S.conv;
  const current = owner.agents[id];
  const spec = owner.team.find((member) => member.id === id);
  if (!current || !spec) throw new Error('Unknown agent.');
  if (input.driver === spec.driver) throw new Error('Choose a different provider.');
  if (owner.providerChanges.has(id)) throw new Error('This agent is already switching provider.');
  checkIdle(owner, current);
  const choice = await validateAgentChoice(owner, { ...input, role: spec.role });
  if (owner.providerChanges.has(id)) throw new Error('This agent is already switching provider.');
  checkIdle(owner, current);

  owner.providerChanges.add(id);
  let failure: string | undefined;
  try {
    publishState();
    const changeId = randomUUID();
    const next: AgentSpec = {
      ...spec,
      driver: choice.driver,
      model: choice.model ?? null,
      effort: choice.effort ?? null,
      sessionId: null,
      tokens: 0,
      cachedTokens: 0,
      providerChangeId: changeId,
    };
    const replacement = buildAgent(owner, next);
    checkIdle(owner, current);
    const previous = { driver: spec.driver, sessionId: current.sessionId || current.threadId || spec.sessionId || null };
    const summary = buildProviderHandoff(owner, spec, S.roles[spec.role], S.history);
    const previousHandoff = owner.providerHandoffs.get(id);
    flushMentionStreams(owner, id);
    await current.shutdown();
    if (S.conv !== owner || owner.agents[id] !== current) throw new Error('The conversation or agent changed. Try again.');

    revokeShellApprovals(owner, id);
    revokeReviewClient(owner, id);
    delete owner.lastAnswerSeq[id];
    next.baseTokens = (spec.baseTokens || 0) + current.tokens;
    next.baseCachedTokens = (spec.baseCachedTokens || 0) + current.cachedTokens;
    owner.team[owner.team.indexOf(spec)] = next;
    installAgent(owner, replacement);
    const context = previousHandoff ? summary + '\n\nEarlier handoff still pending:\n' + previousHandoff.summary.slice(0, 2500) : summary;
    saveProviderHandoff(owner, id, changeId, context, previous);
    cancelBatchPart(owner, id, 'cancelled: provider changed');
    publish({
      kind: 'system',
      agent: id,
      text: `@${id} switched from ${DRIVERS[previous.driver].label} to ${DRIVERS[next.driver].label}.`,
    });
    await startAgent(replacement);
    if (S.conv !== owner || owner.agents[id] !== replacement) throw new Error('The conversation or agent changed. Try again.');
    const status = statusOf(replacement, providerBlocked(next.driver));
    const ready = canReceiveWork(status);
    if (!ready) failure = status.reason || status.availability;
    return { ok: true, ready, reason: failure };
  } finally {
    owner.providerChanges.delete(id);
    if (S.conv === owner) {
      owner.rosterVersion++;
      publishState();
      finishProviderDeliveries(owner, id, failure);
    }
  }
}
