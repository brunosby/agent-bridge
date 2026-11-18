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
  '\\bgit\\b.*\\bpush\\b.*(--force|\\s-f\\b|--mirror|--delete|\\s:)',
  '\\bgit\\b.*\\breset\\b.*--hard',
  '\\bgit\\b.*\\bclean\\b.*-[a-z]*f',
  '\\bgit\\b.*\\bcheckout\\b.*\\s--\\s',
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

const RECURSIVE = [
  '\\brm\\s+(-[a-z]*r|--recursive)',
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
}): (input: MatchInput) => string | null {
  const destructiveRx = destructive.map((p) => new RegExp(p, 'i'));
  const deletionRx = deletion.map((p) => new RegExp(p, 'i'));
  const root = normalize(workDir);

  const inside = (p: string, base: string): boolean => {
    const full = normalize(path.resolve(base, toNativePath(p)));
    return full === root || full.startsWith(root + path.sep);
  };

  /** Returns a short reason when the action must be approved by the user, otherwise null. */
  return function classify({ command, cwd, deletePaths }: MatchInput): string | null {
    const base = cwd || workDir;
    for (const p of deletePaths || []) {
      if (!inside(p, base)) return `deletes ${p}, outside the project folder`;
    }
    const text = String(command || '').replace(WRAPPER, '');
    const d = destructiveRx.find((r) => r.test(text));
    if (d) return `destructive action (matches ${d.source})`;

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
