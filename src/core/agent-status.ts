import type { AccountState } from './types.ts';

export type StartupState = 'starting' | 'ready' | 'failed';

export function agentStatus(input: {
  startup: StartupState;
  startupReason?: string | null;
  available?: boolean;
  unavailableReason?: string | null;
  busy?: boolean;
  waitingApproval?: number;
  account?: { state: AccountState; detail?: string | null } | null;
}) {
  const activity = input.waitingApproval ? 'waiting' : input.busy ? 'working' : 'idle';
  const state = input.account?.state;
  if (state === 'logged_out' || state === 'no_access' || state === 'rate_limited')
    return { activity, availability: state, reason: input.account?.detail || null };
  if (input.startup === 'failed') return { activity, availability: 'startup_failed', reason: input.startupReason || null };
  if (input.available === false) return { activity, availability: 'unavailable', reason: input.unavailableReason || null };
  return { activity, availability: input.startup, reason: null };
}

export function canReceiveWork(status: ReturnType<typeof agentStatus>): boolean {
  return status.availability === 'ready';
}
