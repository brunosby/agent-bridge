// Follow a provider sign-in that runs in a terminal window, without reading any credential.
// Completion comes from the login command ending (Windows) and is confirmed with the CLI's own status
// command. While the login is open, the status is also checked every few seconds as a fallback,
// with a back-off on errors and a time limit, in the spirit of RFC 8628 device-flow polling.
import type { EventEmitter } from 'node:events';
import type { AccountStatus } from '../providers/accounts.ts';
import type { Conversation } from '../core/types.ts';
import { cliStatus, PROVIDERS } from '../providers/accounts.ts';
import { config } from '../config/settings.ts';
import { cliCache, providerRuntime, S } from './state.ts';
import { publish, publishState } from './events.ts';
import { startAgent } from './team.ts';

type Timer = ReturnType<typeof setTimeout>;
export interface WatchOptions {
  interval?: number;
  maxInterval?: number;
  limit?: number;
  check?: () => Promise<AccountStatus>;
  now?: () => number;
  schedule?: (run: () => void, ms: number) => Timer;
  cancel?: (timer: Timer | undefined) => void;
  done?: (driver: string, status: AccountStatus | undefined, blocked: boolean) => void;
}
interface Watch {
  timer?: Timer;
  stopped: boolean;
}

const watches = new Map<string, Watch>();
let version = 0;

/** Providers whose sign-in is being followed, and a counter that changes whenever one ends. */
export function signInState() {
  return { waiting: [...watches.keys()], version };
}

export function signedIn(status: AccountStatus | undefined): boolean {
  return status?.state === 'ok' && status.signedIn !== false;
}

export function stopLoginWatches() {
  for (const [driver, watch] of watches) {
    watch.stopped = true;
    clearTimeout(watch.timer);
    watches.delete(driver);
  }
}

/** Start (or restart) following the sign-in of one provider. */
export function watchLogin(driver: string, finished: EventEmitter | null, blocked: boolean, options: WatchOptions = {}): Watch {
  const {
    interval = 5000,
    maxInterval = 60000,
    limit = 10 * 60000,
    check = () => cliStatus(driver, config[driver]),
    now = Date.now,
    schedule = (run, ms) => setTimeout(run, ms),
    cancel = (timer) => clearTimeout(timer),
    done = finishLogin,
  } = options;
  const previous = watches.get(driver);
  if (previous) {
    previous.stopped = true;
    cancel(previous.timer);
  }
  const started = now();
  const watch: Watch = { stopped: false };
  watches.set(driver, watch);
  let delay = interval,
    running = false,
    ended = false;
  const stop = (status: AccountStatus | undefined) => {
    if (watch.stopped) return;
    watch.stopped = true;
    cancel(watch.timer);
    if (watches.get(driver) === watch) watches.delete(driver);
    version++;
    done(driver, status, blocked);
  };
  const tick = async () => {
    if (watch.stopped || running) return;
    running = true;
    let status: AccountStatus | undefined;
    try {
      status = await check();
      delay = interval;
    } catch {
      delay = Math.min(delay * 2, maxInterval);
    }
    running = false;
    if (watch.stopped) return;
    if (status) cliCache[driver] = { at: now(), status };
    // The login command ended, the provider reports a sign-in, or the time limit passed: stop following.
    if (signedIn(status) || ended || now() - started >= limit) return stop(status);
    watch.timer = schedule(() => void tick(), delay);
    (watch.timer as { unref?: () => void })?.unref?.();
  };
  finished?.once('exit', () => {
    ended = true;
    cancel(watch.timer);
    void tick();
  });
  watch.timer = schedule(() => void tick(), interval);
  (watch.timer as { unref?: () => void })?.unref?.();
  return watch;
}

/** Idle agents of the provider that could not work: unavailable, or blocked by the account before the sign-in. */
export function agentsToRestart(owner: Pick<Conversation, 'team' | 'agents'>, driver: string, blocked: boolean) {
  return owner.team.filter((member) => {
    const agent = owner.agents[member.id];
    return member.driver === driver && agent && !agent.busy && (agent.available === false || blocked);
  });
}

/** When the sign-in is confirmed, clear the provider block and restart its agents that could not work. */
export function finishLogin(driver: string, status: AccountStatus | undefined, blocked: boolean) {
  const owner = S.conv;
  if (!owner) return;
  if (signedIn(status)) {
    delete providerRuntime[driver];
    const restart = agentsToRestart(owner, driver, blocked);
    publish({
      kind: 'system',
      text:
        `${PROVIDERS[driver]?.label || driver}: signed in.` +
        (restart.length ? ' Restarting ' + restart.map((m) => '@' + m.id).join(', ') + '.' : ''),
    });
    for (const member of restart) {
      const agent = owner.agents[member.id];
      void startAgent(agent, () => agent.restart()).catch(() => {});
    }
    owner.rosterVersion += 1;
  }
  publishState();
}
