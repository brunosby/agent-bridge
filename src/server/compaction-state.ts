import type { Agent } from '../core/types.ts';

export type CompactionRun = {
  signal: AbortController;
  timer?: NodeJS.Timeout;
  reason?: 'stop' | 'timeout';
  retry: boolean;
  session?: string | null;
};
export const compactRuns = new WeakMap<Agent, CompactionRun>();
export const isCompacting = (agent?: Agent) => Boolean(agent && compactRuns.has(agent));
export const needsCompactRetry = (agent?: Agent) => Boolean(agent && compactRuns.get(agent)?.retry);
