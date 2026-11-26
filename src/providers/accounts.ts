import { installer, openTerminal } from './installers.ts';
import { execFile, spawn } from 'node:child_process';
import type { AccountState, DriverConfig } from '../core/types.ts';

interface Step {
  text: string;
  command: string;
  docs?: string;
}

export interface AccountStatus {
  signedIn?: boolean;
  state: AccountState;
  detail?: string;
  version?: string;
  expiresAt?: string | null;
  resetsAt?: number | null;
}

export interface RuntimeStatus {
  state: AccountState;
  detail?: string | null;
  resetsAt?: number | null;
}

interface RunResult {
  code: number;
  out: string;
  notFound: boolean;
}

/**
 * Account status per provider, from each CLI's own commands. The app never reads or stores credentials:
 * logging in always happens in the provider's CLI, in a terminal window opened for the user.
 *
 * States: not_installed | logged_out | no_access | rate_limited | ok | unknown
 */
export const PROVIDERS: Record<string, { label: string; login: Step }> = {
  claude: {
    label: 'Claude Code',
    login: { text: 'Sign in with your Claude account or an API key:', command: 'claude auth login' },
  },
  codex: {
    label: 'Codex',
    login: { text: 'Sign in with ChatGPT or an API key:', command: 'codex login' },
  },
  opencode: {
    label: 'OpenCode',
    login: {
      text: 'Connect a provider (OpenCode Zen, OpenRouter, DeepSeek, ...) with a login or an API key:',
      command: 'opencode auth login',
    },
  },
};

function run(command: string, args: string[], timeoutMs = 15000): Promise<RunResult> {
  const isWin = process.platform === 'win32';
  // npm installs .cmd shims on Windows, which need cmd.exe. The commands and args here are fixed, never user input.
  const file = isWin ? 'cmd.exe' : command;
  const fullArgs = isWin ? ['/d', '/s', '/c', command, ...args] : args;
  return new Promise<RunResult>((resolve) => {
    execFile(file, fullArgs, { timeout: timeoutMs, windowsHide: true, maxBuffer: 1024 * 1024 }, (err, stdout, stderr) => {
      resolve({
        code: err ? (typeof err.code === 'number' ? err.code : 1) : 0,
        out: `${stdout || ''}${stderr || ''}`.trim(),
        notFound: Boolean(
          err && (err.code === 'ENOENT' || /not recognized|não é reconhecido|command not found/i.test(`${stderr}${stdout}`)),
        ),
      });
    });
  });
}

export async function checkInstalled(command: string): Promise<{ installed: boolean; detail?: string; version?: string }> {
  const r = await run(command, ['--version'], 10000);
  if (r.notFound || (r.code !== 0 && !r.out)) return { installed: false };
  if (r.code !== 0) return { installed: false, detail: r.out.split('\n')[0].slice(0, 200) };
  return { installed: true, version: r.out.split('\n')[0].slice(0, 80) };
}

/** Status from the CLI itself (installed, logged in). */
export async function cliStatus(driver: string, cfg: DriverConfig = {}): Promise<AccountStatus> {
  const command = cfg.command || driver;
  const inst = await checkInstalled(command);
  if (!inst.installed) return { state: 'not_installed', detail: inst.detail || `${command} was not found on PATH.` };

  if (driver === 'claude') {
    const r = await run(command, ['auth', 'status']);
    // Documented contract: `claude auth status` exits with 0 when signed in and 1 when not; the JSON only adds detail.
    let j: { loggedIn?: boolean; authMethod?: string; subscriptionType?: string; loginExpiresAt?: string | null } | null = null;
    try {
      j = JSON.parse(r.out.slice(r.out.indexOf('{')));
    } catch {
      j = null;
    }
    if (r.code !== 0 || j?.loggedIn === false)
      return {
        state: 'logged_out',
        version: inst.version,
        detail: j ? 'Not signed in.' : r.out.split('\n')[0].slice(0, 200) || 'Not signed in.',
      };
    const how = !j
      ? 'signed in'
      : j.authMethod === 'claude.ai'
        ? `Claude account${j.subscriptionType ? ` (${j.subscriptionType})` : ''}`
        : j.authMethod || 'signed in';
    return { state: 'ok', version: inst.version, detail: how, expiresAt: j?.loginExpiresAt || null };
  }
  if (driver === 'codex') {
    const r = await run(command, ['login', 'status']);
    const line = r.out.split('\n').find((l: string) => /logged|login|api key/i.test(l)) || r.out.split('\n')[0] || '';
    if (/not logged in/i.test(r.out) || r.code !== 0)
      return { state: 'logged_out', version: inst.version, detail: line.slice(0, 200) || 'Not signed in.' };
    return { state: 'ok', version: inst.version, detail: line.replace(/^.*?(Logged in)/i, '$1').slice(0, 200) };
  }
  if (driver === 'opencode') {
    const r = await run(command, ['auth', 'list']);
    // eslint-disable-next-line no-control-regex -- strips ANSI colour codes from the CLI output
    const text = r.out.replace(/\x1b\[[0-9;]*m/g, '');
    if (r.code !== 0) return { state: 'unknown', version: inst.version, detail: 'Could not check OpenCode sign-in.' };
    const none = /no credentials|\b0 credentials/i.test(text) || !text.trim();
    // OpenCode's built-in provider serves its free models without any sign-in, so "no credentials" is still usable.
    if (none)
      return {
        state: 'ok',
        version: inst.version,
        signedIn: false,
        detail: 'Free OpenCode models work without signing in. Use "Switch account" (opencode auth login) to connect other providers.',
      };
    return {
      state: 'ok',
      version: inst.version,
      detail: text
        .split('\n')
        .map((l: string) => l.replace(/^[^\w]+/, '').trim())
        .filter(Boolean)
        .slice(0, 6)
        .join(' · ')
        .slice(0, 300),
    };
  }
  return { state: 'unknown', version: inst.version };
}

/** Format the configured executable as a literal argument for the login terminal. */
export function loginCommand(driver: string, cfg: DriverConfig = {}, platform = process.platform): string {
  const p = PROVIDERS[driver];
  if (!p) throw new Error('unknown provider');
  const executable = String(cfg.command || driver);
  if (/["&|<>^%!\r\n]/.test(executable))
    throw new Error('The configured command contains characters that cannot be used in a terminal. Use the plain path to the CLI.');
  const needsQuotes = platform === 'win32' ? /[\s()]/.test(executable) : !/^[a-zA-Z0-9_./+-]+$/.test(executable);
  const quoted = needsQuotes
    ? platform === 'win32'
      ? '"' + executable + '"'
      : "'" + executable.replaceAll("'", "'\\''") + "'"
    : executable;
  return [quoted, ...p.login.command.split(' ').slice(1)].join(' ');
}

/**
 * Open a terminal window that runs the provider's own login command, for the user to finish.
 * On Windows the window closes after a successful login, so `finished` reports the end of the login itself.
 * Other systems hand the command to the desktop terminal, whose launcher returns at once: `finished` is null there.
 */
export async function openLoginTerminal(driver: string, cfg: DriverConfig = {}, platform = process.platform, launch = spawn) {
  const command = loginCommand(driver, cfg, platform);
  const child = await openTerminal(command, platform === 'win32' ? 'cmd.exe' : 'sh', platform, launch, { closeOnSuccess: true });
  return { command, finished: platform === 'win32' ? child : null };
}

/** Combine the CLI status with what the agents reported while running (no access, usage limit). */
export function mergeStatus(cli: AccountStatus, runtime: RuntimeStatus | null): AccountStatus {
  if (!runtime || ['not_installed', 'logged_out'].includes(cli.state)) return cli;
  if (runtime.state === 'rate_limited' && runtime.resetsAt && runtime.resetsAt < Date.now()) return cli;
  return { ...cli, state: runtime.state, detail: runtime.detail || cli.detail, resetsAt: runtime.resetsAt || null };
}

export function nextStep(
  driver: string,
  status: AccountStatus,
): { text: string; command?: string; docs?: string; action: 'login' | null } | null {
  const p = PROVIDERS[driver];
  switch (status.state) {
    case 'not_installed':
      return {
        text: 'Install ' + p.label + ' for this operating system.',
        command: installer(driver).command,
        docs: installer(driver).guide,
        action: null,
      };
    case 'logged_out':
      return { text: p.login.text, command: p.login.command, action: 'login' };
    case 'no_access':
      return {
        text: 'Signed in, but the account cannot use the models (plan inactive, invalid key or no credit). Check the plan or sign in with another account:',
        command: p.login.command,
        action: 'login',
      };
    case 'rate_limited':
      return {
        text: status.resetsAt
          ? `Usage limit reached. It resets at ${new Date(status.resetsAt).toLocaleString()}.`
          : 'Usage limit reached. Wait for the limit to reset or use another provider.',
        action: null,
      };
    default:
      return null;
  }
}
