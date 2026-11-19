import type { Agent, AgentEvent } from '../core/types.ts';
import { agentStatus, type StartupState } from '../core/agent-status.ts';
import type { RuntimeStatus } from '../providers/accounts.ts';

const startups = new WeakMap<Agent, { state: StartupState; reason: string | null }>();

export function statusOf(agent: Agent | undefined, account?: RuntimeStatus | null) {
  const startup = agent && startups.get(agent);
  return agentStatus({
    startup: startup?.state || 'starting',
    startupReason: startup?.reason,
    available: agent?.available,
    unavailableReason: agent?.unavailableReason,
    busy: agent?.busy,
    waitingApproval: agent?.approvals.size,
    account,
  });
}

export function startAndWait(agent: Agent, launch: () => unknown, changed: () => void, timeout = 30000): Promise<boolean> {
  const startup = { state: 'starting' as StartupState, reason: null as string | null };
  startups.set(agent, startup);
  changed();
  return new Promise((resolve) => {
    let models = false;
    let launched = false;
    function finish(reason: string | null) {
      clearTimeout(timer);
      agent.off('event', onEvent);
      if (startups.get(agent) !== startup) return resolve(false);
      startup.state = reason ? 'failed' : 'ready';
      startup.reason = reason;
      changed();
      resolve(!reason);
    }
    function onEvent(event: AgentEvent) {
      if (event.kind === 'unavailable') finish(event.reason || 'Provider startup failed.');
      if (event.kind === 'models') {
        models = true;
        if (launched && agent.available) finish(null);
      }
    }
    const timer = setTimeout(() => finish('No model list arrived before the startup deadline.'), timeout);
    timer.unref();
    agent.on('event', onEvent);
    Promise.resolve()
      .then(launch)
      .then(
        () => {
          if (startup.state !== 'starting') return;
          launched = true;
          if (!agent.available) finish(agent.unavailableReason || 'Provider startup failed.');
          else if (models) finish(null);
        },
        (error: unknown) => {
          if (startup.state === 'starting') finish(error instanceof Error ? error.message : String(error));
        },
      );
  });
}
