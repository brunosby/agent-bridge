import type { AgentInput } from '../core/types.ts';

export function inputTaskIds(items: readonly AgentInput[] | null | undefined): string[] {
  return items?.flatMap(({ taskId }) => (taskId ? [taskId] : [])) ?? [];
}

export function cancelQueuedTasks(queue: AgentInput[], notify: (ids: string[]) => void): void {
  const ids = inputTaskIds(queue.splice(0));
  if (ids.length) notify(ids);
}
