import type { AgentTaskEvent } from './types.ts';

export function taskIdsFromLog(ids: unknown): string[] {
  return Array.isArray(ids) ? ids.filter((id): id is string => typeof id === 'string' && id.length > 0) : [];
}

export function isTaskLifecycleKind(kind: string): kind is AgentTaskEvent['kind'] {
  return kind === 'taskStarted' || kind === 'tasksCancelled' || kind === 'turnEnd';
}

export function readAgentTaskEvent(event: {
  kind: string;
  agent?: unknown;
  taskIds?: unknown;
  text?: unknown;
  ok?: unknown;
}): AgentTaskEvent | null {
  if (!isTaskLifecycleKind(event.kind) || typeof event.agent !== 'string' || !Array.isArray(event.taskIds)) return null;
  if (taskIdsFromLog(event.taskIds).length !== event.taskIds.length) return null;
  if (event.kind === 'turnEnd' && (typeof event.text !== 'string' || typeof event.ok !== 'boolean')) return null;
  return event as AgentTaskEvent;
}
