import { execFile, spawnSync } from 'node:child_process';
import type { GitSnapshot } from '../core/types.ts';
import { globMatch } from '../core/roles.ts';

const sensitiveNames = ['.env', '.env.*', '*.pem', '*.key', 'id_rsa*', '*.p12', 'credentials*.json'];

function git(cwd: string, args: string[]): string | null {
  const result = spawnSync('git', args, { cwd, encoding: 'utf8', windowsHide: true, timeout: 5000, maxBuffer: 8 * 1024 * 1024 });
  return result.status === 0 ? result.stdout : null;
}

export function isReviewExcluded(file: string, configured: unknown = []): boolean {
  const normalized = file.replaceAll('\\', '/');
  const name = normalized.split('/').at(-1) || '';
  const patterns = Array.isArray(configured) ? configured : [];
  return [...sensitiveNames, ...patterns].some((pattern) => {
    if (typeof pattern !== 'string' || !pattern.trim()) return false;
    const normalizedPattern = pattern.trim().replaceAll('\\', '/');
    return globMatch(normalizedPattern, normalizedPattern.includes('/') ? normalized : name);
  });
}

function gitAsync(cwd: string, args: string[]): Promise<string | null> {
  return new Promise((resolve) => {
    execFile('git', args, { cwd, encoding: 'utf8', windowsHide: true, timeout: 15000, maxBuffer: 20 * 1024 * 1024 }, (error, stdout) =>
      resolve(error ? null : stdout),
    );
  });
}

export async function reviewChanges(cwd: string, excluded: unknown) {
  // Git resolves junctions and alternate path spellings before reporting its root and prefix.
  const [rootOutput, prefixOutput] = await Promise.all([
    gitAsync(cwd, ['rev-parse', '--show-toplevel']),
    gitAsync(cwd, ['rev-parse', '--show-prefix']),
  ]);
  const root = rootOutput?.replace(/\r?\n$/, '');
  if (!root || prefixOutput === null) return null;
  const prefix = prefixOutput.replace(/\r?\n$/, '');
  const relative = prefix.replace(/\/$/, '');
  const withinScope = (name: string) => name.startsWith(prefix);
  const excludedPath = (name: string) =>
    isReviewExcluded(name, excluded) || (prefix && withinScope(name) && isReviewExcluded(name.slice(prefix.length), excluded));
  const [tracked, untracked] = await Promise.all([
    gitAsync(root, ['diff', 'HEAD', '--find-renames', '--name-status', '--no-ext-diff', '--no-textconv', '-z', '--']),
    gitAsync(root, ['ls-files', '--others', '--exclude-standard', '-z']),
  ]);
  if (tracked === null || untracked === null) return null;
  const records = tracked.split('\0').filter(Boolean);
  const files: { status: string; names: string[] }[] = [];
  const denied = new Set<string>();
  for (let index = 0; index < records.length;) {
    const status = records[index++];
    const names = records.slice(index, index + (/^[RC]/.test(status) ? 2 : 1));
    index += names.length;
    if (!names.length) break;
    if (!names.some(withinScope)) continue;
    if (names.some(excludedPath)) for (const name of names) denied.add(name);
    files.push({ status, names });
  }
  for (const name of untracked.split('\0').filter(Boolean)) {
    if (!withinScope(name)) continue;
    if (excludedPath(name)) denied.add(name);
    files.push({ status: '??', names: [name] });
  }
  const visible = files
    .filter((file) => file.names.every((name) => !denied.has(name)))
    .map((file) => ({
      status: file.status,
      names: file.names.filter(withinScope).map((name) => name.slice(prefix.length)),
    }));
  const configured = Array.isArray(excluded) ? excluded.filter((item): item is string => typeof item === 'string') : [];
  const safeBasenames = configured.map((name) => name.trim()).filter((name) => /^[\w.*-]+$/.test(name));
  const common = [...sensitiveNames, ...safeBasenames].map((name) => ':(exclude,icase,glob)**/' + name);
  const exact = [...denied].map((name) => ':(exclude,icase,literal)' + name);
  const args = [
    'diff',
    'HEAD',
    ...(relative ? ['--relative=' + relative] : []),
    '--no-renames',
    '--no-color',
    '--no-ext-diff',
    '--no-textconv',
    '--',
    ...(relative ? [':(literal)' + relative] : []),
    ...common,
    ...exact,
  ];
  // Large allow-lists never go on the command line. If exclusions alone are too large, use metadata only.
  const fits = process.platform !== 'win32' || args.reduce((sum, arg) => sum + 2 * arg.length + 3, 0) < 28000;
  const patch = visible.some((file) => file.status !== '??') ? (fits ? await gitAsync(root, args) : null) : '';
  return { patch, files: visible, omitted: denied.size > 0 };
}

export function projectSnapshot(cwd: string): GitSnapshot | null {
  const status = git(cwd, ['status', '--porcelain=v1', '-z', '--no-renames', '--untracked-files=all']);
  if (status === null) return null;
  return {
    head: git(cwd, ['rev-parse', '--verify', 'HEAD'])?.trim() || null,
    branch: git(cwd, ['symbolic-ref', '--quiet', '--short', 'HEAD'])?.trim() || null,
    files: status
      .split('\0')
      .filter(Boolean)
      .map((entry) => ({ status: entry.slice(0, 2), path: entry.slice(3) })),
  };
}

export function committedPaths(cwd: string, previous: string | null, current: string | null) {
  if (!previous || !current || previous === current) return [];
  // Object IDs originate from Git snapshots. Reject invalid persisted IDs before invoking Git.
  if (![previous, current].every((id) => /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/.test(id))) return null;
  const names = git(cwd, ['diff', '--no-renames', '--name-only', '-z', previous, current, '--']);
  return names?.split('\0').filter(Boolean) ?? null;
}
