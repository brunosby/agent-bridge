import type { Agent, AgentEvent, Conversation } from '../core/types.ts';
import { S } from './state.ts';

export interface ConfirmedTurn {
  agent: string;
  turnId: string;
}
type Cut = { turnId: string; tasks: Set<string> };
const pending = new WeakMap<Agent, Cut>();

export function currentTurn(owner: Conversation, agent: string) {
  return [...owner.tasks.values()].find((task) => task.agent === agent && task.state === 'working')?.turnId;
}

export function matchesCut(agent: Agent, event: AgentEvent) {
  const cut = pending.get(agent);
  if (!cut || !['tasksCancelled', 'turnEnd'].includes(event.kind)) return false;
  return event.turnId ? event.turnId === cut.turnId : [...cut.tasks].every((id) => event.taskIds?.includes(id));
}

export function validateTurns(owner: Conversation, targets: string[], turns: ConfirmedTurn[]) {
  if (
    !Array.isArray(turns) ||
    !turns.length ||
    turns.some((t) => !t || typeof t.agent !== 'string' || typeof t.turnId !== 'string') ||
    new Set(turns.map((t) => t.agent)).size !== turns.length
  )
    throw new Error('Invalid interrupt confirmation.');
  for (const { agent, turnId } of turns) {
    if (!targets.includes(agent) || currentTurn(owner, agent) !== turnId || !owner.agents[agent]?.interruptTurn)
      throw new Error('@' + agent + ' already finished that task. Use Send to deliver normally.');
  }
  if (targets.some((id) => currentTurn(owner, id) && !turns.some((t) => t.agent === id)))
    throw new Error('The active turns changed. Review the recipients again.');
}

export async function interruptConfirmed(owner: Conversation, { agent: id, turnId }: ConfirmedTurn) {
  const agent = owner.agents[id];
  const tasks = new Set([...owner.tasks.values()].filter((task) => task.agent === id && task.turnId === turnId).map((task) => task.id));
  if (pending.has(agent) || !tasks.size) throw new Error('The active turn changed.');
  pending.set(agent, { turnId, tasks });
  let listener: (event: AgentEvent) => void;
  let timer: NodeJS.Timeout;
  try {
    await new Promise<void>((resolve, reject) => {
      listener = (event) => {
        if (matchesCut(agent, event)) resolve();
      };
      agent.on('event', listener);
      timer = setTimeout(() => reject(new Error('Timed out waiting for @' + id + ' to stop. Your message was not sent.')), 15000);
      agent.interruptTurn!(turnId).catch(reject);
    });
    if (S.conv !== owner || owner.agents[id] !== agent) throw new Error('Conversation or agent changed before sending.');
  } finally {
    clearTimeout(timer!);
    agent.off('event', listener!);
    pending.delete(agent);
  }
}
