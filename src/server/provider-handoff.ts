import type { AgentSpec, BridgeEvent, Conversation, ProviderHandoff, Role } from '../core/types.ts';
import { publish } from './events.ts';

const clip = (text: string, limit: number) => (text.length > limit ? text.slice(0, limit) + '...' : text);

export function buildProviderHandoff(owner: Conversation, spec: AgentSpec, role: Role, history: BridgeEvent[]): string {
  const recent: string[] = [];
  for (let i = history.length - 1; i >= 0 && recent.length < 4; i--) {
    const event = history[i];
    if (event.agent === spec.id && event.kind === 'turnEnd' && typeof event.text === 'string' && event.text.trim())
      recent.unshift(clip(event.text.trim(), 1000));
  }
  const tasks = [...owner.tasks.values()]
    .filter((task) => task.agent === spec.id || (spec.role === 'orchestrator' && owner.batch?.pending.get(task.agent)?.tasks.has(task.id)))
    .slice(0, 5)
    .map((task) => {
      const source = task.sourceSeq ? history.findLast((event) => event.seq === task.sourceSeq) : undefined;
      const context = typeof source?.text === 'string' ? ' - ' + clip(source.text, 450) : '';
      return `- @${task.agent}, from ${task.from === 'user' ? 'the user' : '@' + task.from}, ${task.state}${context}`;
    });
  return [
    '[Provider handoff] You are continuing the same Agent Bridge conversation in a fresh provider session.',
    'Current user request:\n' + clip(owner.lastUserText || '(not available)', 2200),
    'Role: ' + role.name + '\n' + clip(role.instructions, 1600),
    'Recent replies from the previous session:\n' + (recent.join('\n\n') || '(none)'),
    'Open work at the time of the switch:\n' + (tasks.join('\n') || '(no tracked tasks)'),
  ].join('\n\n');
}

export function saveProviderHandoff(
  owner: Conversation,
  agent: string,
  id: string,
  summary: string,
  previous: { driver: string; sessionId: string | null },
) {
  owner.providerHandoffs.set(agent, { id, summary, taskIds: new Set() });
  publish({ kind: 'providerHandoff', agent, id, summary, previous });
}

export function restoreProviderHandoffs(events: BridgeEvent[], team: Partial<AgentSpec>[]): Map<string, ProviderHandoff> {
  const current = new Map(team.map((member) => [member.id, member.providerChangeId]));
  const pending = new Map<string, ProviderHandoff>();
  for (const event of events) {
    if (typeof event.id !== 'string' || current.get(event.agent) !== event.id) continue;
    if (event.kind === 'providerHandoff' && typeof event.summary === 'string')
      pending.set(event.agent, { id: event.id, summary: event.summary, taskIds: new Set() });
    if (event.kind === 'providerHandoffDelivered') pending.delete(event.agent);
  }
  return pending;
}

export function settleProviderHandoff(owner: Conversation, agent: string, taskIds: string[], accepted: boolean): void {
  const pending = owner.providerHandoffs.get(agent);
  if (!pending) return;
  if (accepted && taskIds.some((id) => pending.taskIds.has(id))) {
    owner.providerHandoffs.delete(agent);
    publish({ kind: 'providerHandoffDelivered', agent, id: pending.id });
  } else if (!accepted) {
    for (const id of taskIds) pending.taskIds.delete(id);
  }
}
