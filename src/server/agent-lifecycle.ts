import type { Agent, AgentEvent } from '../core/types.ts';
import { agentStatus, type StartupState } from '../core/agent-status.ts';
import type { RuntimeStatus } from '../providers/accounts.ts';

const startups = new WeakMap<Agent, { state: StartupState; reason: string | null }>();

const abandonStartup = new WeakMap<Agent, () => void>();
const operations = new WeakSet<Agent>();

export function agentOperationPending(agent: Agent): boolean {
  return operations.has(agent);
}

export async function runAgentOperation<T>(agent: Agent, run: () => Promise<T>): Promise<T> {
  if (operations.has(agent)) throw new Error('This agent is already being updated. Try again when it finishes.');
  operations.add(agent);
  try {
    return await run();
  } finally {
    operations.delete(agent);
  }
}

export function statusOf(agent: Agent | undefined, account?: RuntimeStatus | null, changingProvider = false) {
  const startup = agent && startups.get(agent);
  return agentStatus({
    startup: startup?.state || 'starting',
    startupReason: startup?.reason,
    available: agent?.available,
    unavailableReason: agent?.unavailableReason,
    busy: agent?.busy,
    waitingApproval: agent?.approvals.size,
    account,
    changingProvider,
  });
}

export function startAndWait(agent: Agent, launch: () => unknown, changed: () => void, timeout = 30000): Promise<boolean> {
  abandonStartup.get(agent)?.();
  const startup = { state: 'starting' as StartupState, reason: null as string | null };
  startups.set(agent, startup);
  changed();
  return new Promise((resolve) => {
    let models = false;
    let launched = false;
    function finish(reason: string | null) {
      clearTimeout(timer);
      agent.off('event', onEvent);
      abandonStartup.delete(agent);
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
    const timer = setTimeout(() => {
      startup.state = 'failed';
      startup.reason = 'No model list arrived before the startup deadline.';
      changed();
      resolve(false);
    }, timeout);
    abandonStartup.set(agent, () => {
      clearTimeout(timer);
      agent.off('event', onEvent);
      resolve(false);
    });
    timer.unref();
    agent.on('event', onEvent);
    Promise.resolve()
      .then(launch)
      .then(
        () => {
          if (startups.get(agent) !== startup || !abandonStartup.has(agent)) return;
          launched = true;
          if (!agent.available) finish(agent.unavailableReason || 'Provider startup failed.');
          else if (models) finish(null);
        },
        (error: unknown) => {
          if (startups.get(agent) === startup && abandonStartup.has(agent)) finish(error instanceof Error ? error.message : String(error));
        },
      );
  });
}
