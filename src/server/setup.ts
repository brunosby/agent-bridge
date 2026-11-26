import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import path from 'node:path';
import { APP_DIR, config, saveLocalConfig } from '../config/settings.ts';
import { cliStatus, checkInstalled, PROVIDERS } from '../providers/accounts.ts';
import { installer, openInstaller } from '../providers/installers.ts';
import { cliCache } from './state.ts';
import { savedTeams, templateMembers } from './saved-teams.ts';
const run = promisify(execFile);
export async function refreshPath(platform = process.platform, read = run, env = process.env) {
  if (platform !== 'win32') return;
  const script =
    "[Console]::OutputEncoding=[Text.UTF8Encoding]::new($false); [Environment]::ExpandEnvironmentVariables(([Environment]::GetEnvironmentVariable('Path','Machine')+';'+[Environment]::GetEnvironmentVariable('Path','User')))";
  const ps = path.win32.join(env.SystemRoot || env.windir || '', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
  const { stdout } = await read(ps, ['-NoProfile', '-NonInteractive', '-Command', script], {
    windowsHide: true,
    timeout: 8000,
    encoding: 'utf8',
  });
  const entries = new Map<string, string>();
  const key = Object.keys(env).find((k) => k.toLowerCase() === 'path') || 'Path';
  for (const dir of (String(stdout).trim() + ';' + (env[key] || '')).split(';').filter(Boolean))
    if (!entries.has(dir.toLowerCase())) entries.set(dir.toLowerCase(), dir);
  env[key] = [...entries.values()].join(';');
}
export function shortcutArgs(desktop: boolean) {
  return ['//nologo', path.join(APP_DIR, 'bin', 'create-shortcut.vbs'), ...(desktop ? ['/desktop'] : [])];
}
export async function setup(body: Record<string, unknown>) {
  if (body.action === 'status') {
    let pathWarning = '';
    if (body.refresh === true)
      try {
        await refreshPath();
      } catch {
        pathWarning = 'Could not refresh PATH.';
      }
    const accounts = await Promise.all(
      Object.keys(PROVIDERS).map(async (id) => {
        const status = await cliStatus(id, config[id]);
        cliCache[id] = { at: Date.now(), status };
        return { id, label: PROVIDERS[id].label, ...status, ...installer(id) };
      }),
    );
    const git = await checkInstalled('git');
    return {
      windows: process.platform === 'win32',
      pathWarning,
      items: [
        ...accounts,
        { id: 'git', label: 'Git', state: git.installed ? 'ok' : 'not_installed', version: git.version, ...installer('git') },
      ],
    };
  }
  if (body.action === 'finish') {
    if (body.members !== undefined) {
      if (!Array.isArray(body.members) || body.members.length > 8) throw new Error('Invalid initial team.');
      const available = new Map<string, boolean>();
      for (const member of body.members) {
        if (!member || !Object.hasOwn(PROVIDERS, member.driver)) throw new Error('Unknown setup provider.');
        if (!available.has(member.driver))
          available.set(member.driver, (await cliStatus(member.driver, config[member.driver])).state === 'ok');
        if (!available.get(member.driver)) throw new Error('Provider no longer available. Check again.');
      }
      const members = templateMembers(body.members);
      const { teams } = savedTeams();
      let name = 'Setup team';
      for (let n = 2; teams.some((t) => t.name.toLowerCase() === name.toLowerCase()); n++) name = 'Setup team ' + n;
      saveLocalConfig({ teams: [...teams, { name, members }], defaultTeamName: name, setupCompleted: true });
      return { ok: true };
    }
    saveLocalConfig({ setupCompleted: true });
    return { ok: true };
  }
  if (body.confirm !== true) throw new Error('Confirmation required.');
  if (body.action === 'install' && typeof body.id === 'string') {
    await openInstaller(body.id);
    return { ok: true };
  }
  if (body.action === 'shortcut' && process.platform === 'win32') {
    await run('cscript.exe', shortcutArgs(body.desktop === true), { cwd: APP_DIR, windowsHide: true, timeout: 10000 });
    return { ok: true };
  }
  throw new Error('Unknown setup action.');
}
