import type { Agent, Conversation } from '../core/types.ts';
import { compactRuns as active, isCompacting, type CompactionRun } from './compaction-state.ts';
import { setting } from '../config/settings.ts';
import { S, orchestratorId } from './state.ts';
import { publish, publishState } from './events.ts';
import { latest, pendingWork } from './request-progress.ts';
import { agentOperationPending } from './agent-lifecycle.ts';
import { statusFor } from './team.ts';
import { hasPendingSend } from './routing.ts';
import { finishProviderDeliveries, isPreparingDelivery } from './delivery.ts';

const instructions =
  "Keep the user's goals and preferences, decisions made, project paths and branches, agent roles and assignments, approved specifications and open items. Drop intermediate tool output and finished worker reports.";

const awaitingNextCall = new WeakSet<Agent>();

const session = (agent: Agent) => agent.sessionId || agent.threadId;
const counts = new Intl.NumberFormat('en', { notation: 'compact', maximumFractionDigits: 1 });

export function reportContext(agent: Agent) {
  if (agent.contextTokens !== undefined && awaitingNextCall.delete(agent)) {
    publish({
      kind: 'system',
      text: '@' + agent.id + "'s next call used " + counts.format(agent.contextTokens) + ' tokens.',
    });
  }
}

export function canCompact(owner: Conversation, agent: Agent, waits = pendingWork(owner)) {
  return (
    Boolean(agent.compact) &&
    owner === S.conv &&
    owner.agents[agent.id] === agent &&
    !agent.busy &&
    !isCompacting(agent) &&
    !agentOperationPending(agent) &&
    statusFor(owner, agent.id).availability === 'ready' &&
    !hasPendingSend(owner) &&
    !isPreparingDelivery(owner, agent.id) &&
    !owner.batch?.pending.size &&
    !waits.some((w) => w.reason !== 'Agent is working' || w.agent === agent.id)
  );
}

export function compactAfterResult(owner: Conversation, id: string | undefined | null, request = latest(owner)?.seq) {
  if (!id || owner.routingMode !== 'orchestrator' || !setting('compactCoordinatorAfterResult')) return;
  const agent = owner.agents[id];
  // Some providers finish clearing their work queue immediately after emitting turnEnd.
  setImmediate(() => {
    if (
      S.conv !== owner ||
      agent !== owner.agents[id] ||
      !agent?.compact ||
      orchestratorId() !== id ||
      request !== latest(owner)?.seq ||
      !owner.relay.halted ||
      owner.relay.userPaused ||
      !setting('compactCoordinatorAfterResult')
    )
      return;
    if (canCompact(owner, agent)) startCompaction(owner, agent);
  });
}

export function startCompaction(owner: Conversation, agent: Agent) {
  if (!agent.compact || !canCompact(owner, agent))
    throw new Error('Compaction requires an idle agent and no pending decisions or deliveries.');
  const run: CompactionRun = { signal: new AbortController(), retry: false, session: session(agent) };
  active.set(agent, run);
  awaitingNextCall.delete(agent);
  const current = () => S.conv === owner && owner.agents[agent.id] === agent && active.get(agent) === run;
  run.timer = setTimeout(() => stopCompaction(owner, agent, false, 'timeout'), 300000);
  run.timer.unref();
  publish({ kind: 'system', text: 'Compacting @' + agent.id + "'s context…" });
  const perform = async () => {
    try {
      const result = await agent.compact!(instructions, run.signal.signal);
      if (!current() || run.reason || run.retry) return;
      if (result.compacted) {
        awaitingNextCall.add(agent);
        agent.contextTokens = undefined;
      }
      publish({
        kind: 'system',
        text: result.compacted ? 'Compacted @' + agent.id + "'s context." : '@' + agent.id + ' had no history to compact.',
      });
    } catch (error) {
      if (current() && !run.reason && !run.retry)
        publish({
          kind: 'error',
          text: 'Could not compact @' + agent.id + "'s context: " + (error instanceof Error ? error.message : String(error)),
        });
    } finally {
      clearTimeout(run.timer);
      if (current() && !run.retry) {
        if (run.reason)
          publish({
            kind: 'system',
            text: 'Compaction of @' + agent.id + (run.reason === 'timeout' ? ' timed out and was interrupted.' : ' was stopped.'),
          });
        if (!agent.available) {
          run.retry = true;
        } else {
          active.delete(agent);
          finishProviderDeliveries(owner, agent.id);
        }
        publishState();
      }
    }
  };
  void perform();
  publishState();
}

export function stopCompaction(owner: Conversation, agent: Agent, discard: boolean, reason: 'stop' | 'timeout' = 'stop') {
  const run = active.get(agent);
  if (!run) return false;
  if (discard && S.conv === owner) finishProviderDeliveries(owner, agent.id, 'the conversation was stopped');
  if (run.reason || run.retry || S.conv !== owner || owner.agents[agent.id] !== agent) return true;
  run.reason = reason;
  clearTimeout(run.timer);
  run.timer = setTimeout(() => {
    if (active.get(agent) !== run || owner !== S.conv || owner.agents[agent.id] !== agent) return;
    run.retry = true;
    agent.available = false;
    agent.unavailableReason = 'Compaction did not stop';
    publish({ kind: 'error', text: 'Compaction did not stop. Retry @' + agent.id + ' to resume queued deliveries.' });
    publishState();
  }, 30000);
  run.timer.unref();
  run.signal.abort();
  return true;
}

export function recoverCompaction(owner: Conversation, agent: Agent) {
  const run = active.get(agent);
  if (
    !run?.retry ||
    owner !== S.conv ||
    owner.agents[agent.id] !== agent ||
    agent.busy ||
    statusFor(owner, agent.id).availability !== 'ready'
  )
    return;
  active.delete(agent);
  finishProviderDeliveries(
    owner,
    agent.id,
    run.session && run.session !== session(agent) ? 'the original session could not be restored' : undefined,
  );
  publishState();
}
