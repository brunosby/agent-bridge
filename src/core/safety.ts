import { execFile } from 'node:child_process';
import { lstat } from 'node:fs/promises';
import path from 'node:path';

/**
 * Safety rules for bypass mode. In bypass mode every approval request is accepted automatically
 * unless classify() returns a reason; those requests still go to the user.
 *
 * - DESTRUCTIVE: always needs the user (git history rewrites, database drops, disk tools, publishing...).
 * - DELETION: needs the user when it is recursive or when it may touch anything outside the project
 *   folder. Deleting individual files inside the project folder is accepted in bypass mode.
 *
 * Patterns are case-insensitive regular expressions; override them in config.json with
 * "destructivePatterns" and "deletionPatterns".
 */
export const DEFAULT_DESTRUCTIVE_PATTERNS = [
  // Git history and uncommitted work
  '\\bgit\\b.*\\breset\\b.*--hard',
  '\\bgit\\b.*\\bclean\\b.*-[a-z]*f',
  '\\bgit\\b.*\\brestore\\b',
  '\\bgit\\b.*\\bbranch\\b.*\\s-D\\b',
  '\\bgit\\b.*\\bstash\\b.*\\b(drop|clear)\\b',
  '\\bgit\\b.*\\bfilter-(branch|repo)\\b',
  '\\bgit\\b.*\\breflog\\b.*\\b(delete|expire)\\b',
  // Wiping file contents
  '\\bClear-Content\\b',
  '\\bshred\\b',
  '\\bcipher\\s+/w',
  // Databases
  '\\bdrop\\s+(table|database|schema|index|view)\\b',
  '\\btruncate\\s+table\\b',
  '\\bdelete\\s+from\\b',
  // Disks, system and services
  '\\bformat(\\.com)?\\s+[a-z]:',
  '\\bdiskpart\\b',
  '\\bmkfs',
  '\\bdd\\s+if=',
  '\\b(shutdown|Stop-Computer|Restart-Computer)\\b',
  '\\breg(\\.exe)?\\s+delete\\b',
  '\\bsc(\\.exe)?\\s+delete\\b',
  // Publishing or deleting remote things
  '\\bnpm\\s+(publish|unpublish)\\b',
  '\\bgh\\s+(repo|release)\\s+delete\\b',
  '\\bdocker\\s+(system\\s+prune|volume\\s+(rm|prune))\\b',
  '\\bkubectl\\s+delete\\b',
  '\\bterraform\\s+destroy\\b',
];

export const DEFAULT_DELETION_PATTERNS = [
  '\\brm\\s',
  '\\brmdir\\b',
  '\\b(del|erase)\\s',
  '\\brd\\s',
  '\\bRemove-Item\\b',
  '\\bri\\s',
  '\\bunlink\\b',
  '\\bfind\\b.*\\s-delete\\b',
  '\\.(Delete|DeleteFile|DeleteFolder)\\s*\\(',
  '\\b(rmSync|rmdirSync|unlinkSync|shutil\\.rmtree|os\\.remove)\\b',
];

// These external operations always require an explicit decision on approval requests.
const externalAction = [
  /\bgh(?:\.exe)?\s+(?:pr|issue|release|repo|workflow|run|secret|variable|label|gist)\s+(?:create|merge|edit|delete|close|reopen|upload|fork|enable|disable|run|rerun|cancel|set|comment|review|ready)\b/i,
  /\bgh(?:\.exe)?\s+api\b[^;&|\n]*(?:graphql|--(?:method|field|raw-field|input)\b|-[XFf]\s*\S)/i,
  /\b(?:curl(?:\.exe)?|wget(?:\.exe)?)\b[^;&|\n]*(?:\s-(?:[dFT]|X\s*(?:POST|PUT|PATCH|DELETE))|--(?:data|form|upload-file|post-data|post-file|request)(?:[-=\s]|$))/i,
  /\b(?:Invoke-WebRequest|Invoke-RestMethod|iwr|irm)\b[^;|\n]*\s-(?:Body|InFile|Form|Method\s+['"]?(?:Post|Put|Patch|Delete))\b/i,
];

const RECURSIVE = [
  '\\brm\\s+(?:-[a-z]+\\s+)*(-[a-z]*r|--recursive)',
  '\\b(rmdir|rd|del|erase)\\b[^&|;]*\\s/s\\b',
  '\\b(Remove-Item|ri)\\b[^&|;]*-Recurse',
  '\\bfind\\b.*\\s-delete\\b',
  '\\b(rmSync|shutil\\.rmtree)\\b',
  'recursive\\s*:\\s*true',
].map((p) => new RegExp(p, 'i'));

// Anything that changes directory makes relative paths unreliable.
const CHANGES_DIR = /(^|[\s;&|(])(cd|pushd|chdir|Set-Location|sl)\s/i;
// Shell wrapper used by Codex on Windows: "...\powershell.exe" -Command "<real command>"
const WRAPPER = /^\s*"?[^"\s]*?(powershell|pwsh|cmd|bash|sh)(\.exe)?"?\s+(-NoProfile\s+)?(-Command|-c|\/c|\/d\s+\/s\s+\/c)\s+/i;

// Keep quoted arguments together so a commit message or a branch called "push" is data.
async function gitAction(text: string, cwd: string): Promise<string | null> {
  if (!/git/i.test(text)) return null;
  const wrapped = WRAPPER.test(text);
  let body = wrapped ? text.replace(WRAPPER, '') : text;
  if (wrapped && /^(['"])[\s\S]*\1$/.test(body)) body = body.slice(1, -1);
  const segments: string[][] = [[]];
  for (const [token] of body.matchAll(/(?:'[^']*'|"[^"]*"|[^\s'";&|()])+|[;&|()\n]/g)) {
    if (/^[;&|()\n]$/.test(token)) {
      segments.push([]);
      continue;
    }
    segments.at(-1)!.push(token.replace(/'([^']*)'|"([^"]*)"/g, (_m, s, d) => s ?? d));
  }
  let directory = cwd;
  for (const words of segments) {
    if (/^(?:cd|chdir|set-location)$/i.test(words[0] || '') && words.length === 2) {
      directory = path.resolve(directory, toNativePath(words[1]));
      continue;
    }
    const shell = words[0]
      ?.split(/[/\\]/)
      .at(-1)
      ?.replace(/\.exe$/i, '');
    if (shell && /^(?:powershell|pwsh|cmd|bash|sh)$/i.test(shell)) {
      const commandIndex = words.findIndex((word) => /^(?:-command|-[a-z]*c|\/c)$/i.test(word));
      if (commandIndex > 0) {
        const nested = await gitAction(words.slice(commandIndex + 1).join(' '), directory);
        if (nested) return nested;
        continue;
      }
    }
    const index = words.findIndex((w) => /(?:^|[/\\])git(?:\.exe)?$/i.test(w));
    if (index < 0) continue;
    const prefix = words.slice(0, index).filter((word) => !/^[A-Za-z_]\w*=/.test(word));
    if (prefix.length && !/^(?:env|sudo|command|exec|time|xargs|then|do|if)$/i.test(path.basename(prefix[0]))) continue;
    const args = words.slice(index + 1);
    let base = directory;
    let customTree = false;
    while (args[0]?.startsWith('-')) {
      const flag = args.shift()!;
      if (/^--(?:work-tree|git-dir)(?:=|$)/.test(flag)) customTree = true;
      if (flag === '-C') base = path.resolve(base, toNativePath(args.shift() || '.'));
      else if (flag.startsWith('-C')) base = path.resolve(base, toNativePath(flag.slice(2)));
      else if (['-c', '--git-dir', '--work-tree', '--namespace', '--config-env'].includes(flag)) args.shift();
    }
    const command = args.shift();
    if (command === 'push')
      return args.some((a) => a.startsWith('--force') || /^-[a-z]*f/.test(a) || a.startsWith('+')) ? 'destructive push' : 'external action';
    if (command === 'switch' && discardsWorkingChanges(args)) return 'switch may replace working files';
    if (command !== 'checkout') continue;
    const risk = await checkoutRisk(args, base, customTree);
    if (risk) return risk;
  }
  return null;
}

function discardsWorkingChanges(args: string[]): boolean {
  return args.some((arg) => arg === '--force' || arg === '--discard-changes' || /^-[a-zA-Z]*f/.test(arg));
}

async function checkoutRisk(args: string[], base: string, customTree: boolean): Promise<string | null> {
  const risk = 'checkout may replace working files';
  if (discardsWorkingChanges(args) || args.some((a) => a === '--' || a === '-B' || a.startsWith('--pathspec-from-file'))) return risk;
  const refs = args.filter((a) => !a.startsWith('-'));
  if (refs.some((a) => /^(?::|\.{1,2}(?:[/\\]|$)|[/\\]|[a-z]:)|[*?[\]$]/i.test(a))) return risk;
  if (!refs.length || args.includes('-b') || args.includes('--orphan')) return null;
  if (refs.length > 1 || customTree) return risk;
  const name = refs[0];
  const probe = (args: string[]) =>
    new Promise<number | string>((resolve) => {
      execFile(
        'git',
        ['--no-optional-locks', '-c', 'core.fsmonitor=false', ...args],
        { cwd: base, windowsHide: true, timeout: 1500 },
        (error) => resolve(error ? (error.code ?? 'unknown') : 0),
      );
    });
  // A local branch takes precedence over a path with the same name.
  if ((await probe(['show-ref', '--verify', '--quiet', 'refs/heads/' + name])) === 0) return null;
  // A tracked file is still a pathspec after its local copy has been deleted.
  if (
    await lstat(path.resolve(base, name)).then(
      () => true,
      (error: NodeJS.ErrnoException) => error.code !== 'ENOENT',
    )
  )
    return risk;
  const tracked = await probe(['--literal-pathspecs', 'ls-files', '--error-unmatch', '--', name]);
  if (tracked !== 1) return risk;
  return null;
}

export interface MatchInput {
  command?: string;
  cwd?: string;
  deletePaths?: string[];
}

export function buildMatcher({
  workDir,
  destructive = DEFAULT_DESTRUCTIVE_PATTERNS,
  deletion = DEFAULT_DELETION_PATTERNS,
}: {
  workDir: string;
  destructive?: string[];
  deletion?: string[];
}): (input: MatchInput) => Promise<string | null> {
  const destructiveRx = destructive.map((p) => new RegExp(p, 'i'));
  const deletionRx = deletion.map((p) => new RegExp(p, 'i'));
  const root = normalize(workDir);

  const inside = (p: string, base: string): boolean => {
    const full = normalize(path.resolve(base, toNativePath(p)));
    return full === root || full.startsWith(root + path.sep);
  };

  /** Returns a short reason when the action must be approved by the user, otherwise null. */
  return async function classify({ command, cwd, deletePaths }: MatchInput): Promise<string | null> {
    const base = cwd || workDir;
    for (const p of deletePaths || []) {
      if (!inside(p, base)) return `deletes ${p}, outside the project folder`;
    }
    const text = String(command || '').replace(WRAPPER, '');
    const d = destructiveRx.find((r) => r.test(text));
    if (d) return `destructive action (matches ${d.source})`;
    const gitRisk = await gitAction(String(command || ''), base);
    if (gitRisk) return gitRisk;
    if (externalAction.some((rule) => rule.test(text))) return 'external action';

    const del = deletionRx.map((r) => r.exec(text)).find(Boolean);
    if (!del) return null;
    if (RECURSIVE.some((r) => r.test(text))) return 'recursive deletion';
    if (!inside('.', base)) return 'deletion while working outside the project folder';
    if (CHANGES_DIR.test(text)) return 'deletion after changing directory';
    const after = text.slice(del.index);
    if (/(^|[\s"'=(])(~|\$HOME|\$env:|%[A-Z_]+%|\$\{?[A-Z_]+)/i.test(after)) return 'deletion using a path from a variable';
    for (const token of pathTokens(after)) {
      if (!inside(token, base)) return `deletes ${token}, outside the project folder`;
    }
    return null;
  };
}

/** Path-like tokens: quoted strings or words containing a slash, a backslash, a drive letter or "..". */
function pathTokens(text: string): string[] {
  const out: string[] = [];
  const rx = /"([^"]+)"|'([^']+)'|([^\s"';&|()]+)/g;
  let m;
  while ((m = rx.exec(text))) {
    const t = m[1] ?? m[2] ?? m[3];
    if (/^\/[a-z?]$/i.test(t) || /^-/.test(t)) continue; // flags such as /s, /q, -Force
    if (/^[a-z]:/i.test(t) || /[\\/]/.test(t) || t.includes('..')) out.push(t);
  }
  return out;
}

/** Git Bash style /d/project -> D:\project on Windows. */
function toNativePath(p: string): string {
  if (process.platform === 'win32') {
    const m = /^\/([a-z])(\/.*)?$/i.exec(p);
    if (m) return `${m[1].toUpperCase()}:${(m[2] || '\\').replace(/\//g, '\\')}`;
  }
  return p;
}

function normalize(p: string): string {
  const r = path.resolve(p).replace(/[\\/]+$/, '');
  return process.platform === 'win32' ? r.toLowerCase() : r;
}
