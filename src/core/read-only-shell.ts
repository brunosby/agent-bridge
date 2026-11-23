import { readdirSync, realpathSync, statSync } from 'node:fs';
import path from 'node:path';

export type KnownShell = 'bash' | 'powershell';
export interface ShellCommand {
  text: string;
  shell: KnownShell;
}

interface Stage {
  words: string[];
  raw: string[];
  start: number;
  end: number;
  next?: string;
}

function hasOnlyShortNameTildes(value: string): boolean {
  return (
    process.platform === 'win32' &&
    value.split(/[\\/]/).every((part) => !part.includes('~') || /^[a-z0-9_-]{1,6}~[1-9]\d*(?:\.[a-z0-9_-]{1,3})?$/i.test(part))
  );
}

function parseStages({ text, shell }: ShellCommand): Stage[] | null {
  if (!text || text.length > 8192 || /(?!\t)[\p{Cc}\u2018-\u201f]/u.test(text)) return null;
  const syntax = /\s+|2>&1|&&|\|\||[;|]|"[^"]*"|'(?:[^']|'')*'/.source;
  const tokens = new RegExp(syntax + '|' + /[a-z0-9_.:/\\*?+=,~-]+/.source, 'iy');
  const childItemTokens = new RegExp(syntax + '|' + /,|[a-z0-9_.:/\\*?+=~-]+/.source, 'iy');
  const stages: Stage[] = [];
  let words: string[] = [];
  let raw: string[] = [];
  let start = 0;
  let end = 0;
  let separated = true;
  let merged = false;
  while (end < text.length) {
    const childItems = shell === 'powershell' && words[0]?.toLowerCase() === 'get-childitem';
    const tokenizer = childItems ? childItemTokens : tokens;
    const index = end;
    tokenizer.lastIndex = index;
    const match = tokenizer.exec(text);
    if (!match) return null;
    const [piece] = match;
    end = tokenizer.lastIndex;
    if (/^\s+$/.test(piece)) {
      if (/[^\t ]/.test(piece)) return null;
      separated = true;
      continue;
    }
    if (/^(?:&&|\|\||[;|])$/.test(piece)) {
      if (!words.length) return null;
      stages.push({ words, raw, start, end: index, next: piece });
      words = [];
      raw = [];
      separated = true;
      merged = false;
      continue;
    }
    if (childItems && piece === ',') {
      if (merged || words.length < 2 || words.at(-1) === ',') return null;
      words.push(piece);
      raw.push(piece);
      separated = true;
      continue;
    }
    if (!separated || merged) return null;
    separated = false;
    if (piece === '2>&1') {
      if (!words.length) return null;
      merged = true;
      continue;
    }
    const single = piece.startsWith("'");
    const quoted = single || piece.startsWith('"');
    const literal = single && shell === 'powershell';
    let word = quoted ? piece.slice(1, -1) : piece;
    if (literal) word = word.replaceAll("''", "'");
    else if (/[$`!%#{}<>()[\]"']/.test(word)) return null;
    if (!quoted && word.includes('~') && !hasOnlyShortNameTildes(word)) return null;
    if (!word || (!quoted && !childItems && /[*?]/.test(word)) || (!words.length && quoted)) return null;
    if (shell === 'bash' && !single && piece.includes('\\')) return null;
    if (!words.length) start = index;
    words.push(word);
    raw.push(piece);
  }
  if (!words.length) return null;
  return [...stages, { words, raw, start, end }];
}

function localPath(value: string, cwd: string): string | null {
  if (value.includes('~') && !hasOnlyShortNameTildes(value)) return null;
  if (!/^[a-z0-9_.~ \\/-]+$/i.test(value) && !/^[a-z]:[\\/][a-z0-9_.~ \\/-]*$/i.test(value)) return null;
  if (/^[\\/]{2}|(?:^|[\\/])(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|[\\/]|$)/i.test(value)) return null;
  if (process.platform === 'win32') {
    const drive = /^\/([a-z])(?:\/(.*))?$/i.exec(value);
    if (drive) value = drive[1] + ':/' + (drive[2] || '');
    else if (value.startsWith('/') || value.startsWith('\\')) return null;
  }
  return path.resolve(cwd, value);
}

function within(root: string, cwd: string, value: string, directory = false): string | null {
  const candidate = localPath(value, cwd);
  if (!candidate) return null;
  try {
    const resolved = realpathSync.native(candidate);
    if (/^[\\/]{2}/.test(resolved)) return null;
    const relative = path.relative(root, resolved);
    if (path.isAbsolute(relative) || relative === '..' || relative.startsWith('..' + path.sep)) return null;
    const type = statSync(resolved);
    if (!type.isDirectory() && (directory || !type.isFile())) return null;
    return resolved;
  } catch {
    return null;
  }
}

const PS_READS: Record<string, { paths: string[]; flags: string[]; counts?: string[] }> = {
  'get-childitem': { paths: ['-path', '-literalpath'], flags: ['-force', '-file', '-directory', '-name', '-recurse'] },
  'get-content': { paths: ['-path', '-literalpath'], flags: ['-raw'], counts: ['-totalcount', '-tail'] },
  'get-item': { paths: ['-path', '-literalpath'], flags: ['-force'] },
  'test-path': { paths: ['-path', '-literalpath'], flags: [] },
  'resolve-path': { paths: ['-path', '-literalpath'], flags: ['-relative'] },
};
const PS_FILTERS = new Set(['sort-object', 'measure-object']);
const BASH_READS: Record<string, string[]> = {
  ls: ['-l', '-a', '-la', '-al', '-h'],
  cat: ['-n'],
  wc: ['-l', '-w', '-c'],
  head: ['-n'],
  tail: ['-n'],
};

function literalPattern(value: string | undefined, raw: string | undefined): boolean {
  return Boolean(value && !value.startsWith('-') && (raw?.startsWith("'") || /^[\p{L}\p{N} _.-]+$/u.test(value)));
}

function namePattern(value: string | undefined, raw: string | undefined): boolean {
  return Boolean(value && !value.startsWith('-') && !raw?.startsWith('"') && /^[\p{L}\p{N}_. *?-]+$/u.test(value));
}

function selectObjectArgs(args: string[]): boolean {
  if (args[0]?.toLowerCase() === '-first') {
    if (!/^\d{1,9}$/.test(args[1] || '')) return false;
    args = args.slice(2);
  }
  if (args.length >= 2 && args[0].toLowerCase() === '-property') args = args.slice(1);
  return args.length <= 1 && args.every((arg) => /^[a-z][a-z0-9_]*$/i.test(arg));
}

// Check the actual tree before authorizing recursion, including with older PowerShell versions.
function recursiveListingAllowed(directory: string, depth: number): boolean {
  const pending = [{ directory, depth }];
  let remaining = 10_000;
  try {
    while (pending.length) {
      const { directory: current, depth } = pending.pop()!;
      if (path.relative(current, realpathSync.native(current))) return false;
      const entries = readdirSync(current, { withFileTypes: true });
      remaining -= entries.length;
      if (remaining < 0 || entries.some((entry) => entry.isSymbolicLink())) return false;
      if (depth > 0) {
        for (const entry of entries) {
          if (entry.isDirectory()) pending.push({ directory: path.join(current, entry.name), depth: depth - 1 });
        }
      }
    }
    return true;
  } catch {
    return false;
  }
}

function simpleFilter(stage: Stage, shell: KnownShell): boolean {
  const [program, ...args] = stage.words;
  const name = program.toLowerCase();
  if (shell === 'powershell' && name === 'select-string') {
    const index = args[0]?.toLowerCase() === '-pattern' ? 1 : 0;
    return args.length === index + 1 && literalPattern(args[index], stage.raw[index + 1]);
  }
  if (shell === 'powershell' && (name === 'select' || name === 'select-object')) return selectObjectArgs(args);
  if (shell === 'powershell' && PS_FILTERS.has(name))
    return args.length <= 2 && args.every((arg, i) => /^[a-z][a-z0-9_]*$/i.test(arg) || (i === 0 && arg.toLowerCase() === '-property'));
  return ['head', 'tail'].includes(program) && (args.length === 0 || (args.length === 2 && args[0] === '-n' && /^\d+$/.test(args[1])));
}

function readStage(stage: Stage, shell: KnownShell, root: string, cwd: string, knownCwd: boolean): boolean {
  const [program, ...args] = stage.words;
  const name = shell === 'powershell' ? program.toLowerCase() : program;
  const local = (value: string) => (value && (knownCwd || /^(?:[a-z]:[\\/]|\/)/i.test(value)) ? within(root, cwd, value) : null);
  if (shell === 'powershell' && Object.hasOwn(PS_READS, name)) {
    const spec = PS_READS[name];
    const paths: string[] = [];
    let recurse = false;
    let include = false;
    let depth = Infinity;
    for (let i = 0; i < args.length; i++) {
      const option = args[i].toLowerCase();
      if (spec.flags.includes(option)) {
        if (option === '-recurse') recurse = true;
        continue;
      }
      if (name === 'get-childitem' && option === '-depth') {
        const value = args[++i];
        if (!/^\d{1,10}$/.test(value || '') || stage.raw[i + 1].startsWith('"') || Number(value) > 0xffffffff) return false;
        depth = Number(value);
        recurse = true;
        continue;
      }
      if (name === 'get-childitem' && option === '-filter') {
        if (!namePattern(args[++i], stage.raw[i + 1])) return false;
        continue;
      }
      if (name === 'get-childitem' && option === '-include') {
        include = true;
        while (true) {
          if (!namePattern(args[++i], stage.raw[i + 1])) return false;
          if (args[i + 1] !== ',' || stage.raw[i + 2] !== ',') break;
          i++;
        }
        continue;
      }
      if (spec.counts?.includes(option)) {
        if (!/^\d+$/.test(args[++i] || '')) return false;
      } else {
        if (spec.paths.includes(option)) i++;
        const target = args[i]?.startsWith('-') ? null : local(args[i]);
        if (!target) return false;
        paths.push(target);
      }
    }
    if (!paths.length && knownCwd && name === 'get-childitem') paths.push(cwd);
    // Windows PowerShell 5.1 can ignore -Depth when -Include is present.
    const checkedDepth = include ? Infinity : depth;
    return paths.length > 0 && (!recurse || paths.every((directory) => recursiveListingAllowed(directory, checkedDepth)));
  }
  if (shell === 'powershell' && name === 'select-string') {
    const index = args[0]?.toLowerCase() === '-pattern' ? 1 : 0;
    if (index) args.shift();
    const pattern = args.shift();
    if (args[0]?.toLowerCase() === '-literalpath' || args[0]?.toLowerCase() === '-path') args.shift();
    return literalPattern(pattern, stage.raw[index + 1]) && args.length === 1 && Boolean(local(args[0]));
  }
  if (name === 'rg' && args[0] === '--no-config') {
    args.shift();
    // An explicit file avoids implicit traversal.
    while (['-n', '-i', '-F'].includes(args[0])) args.shift();
    return args.length === 2 && !args[0].startsWith('-') && Boolean(local(args[1])) && !within(root, cwd, args[1], true);
  }
  if (shell === 'bash' && name === 'pwd') return knownCwd && !args.length;
  if (shell === 'bash' && Object.hasOwn(BASH_READS, name)) {
    let paths = 0;
    for (let i = 0; i < args.length; i++) {
      const arg = args[i];
      if (BASH_READS[name].includes(arg)) {
        if (arg === '-n' && (name === 'head' || name === 'tail') && !/^\d+$/.test(args[++i] || '')) return false;
      } else {
        if (arg.startsWith('-') || !local(arg)) return false;
        paths++;
      }
    }
    return paths > 0 || (knownCwd && name === 'ls');
  }
  return false;
}

function approvedTest(stage: Stage): boolean {
  const [program, action, script, ...args] = stage.words;
  if (program === 'node' && action === '--test')
    return stage.words
      .slice(2)
      .every((word, i) => /^[./\\a-z0-9_-]+$/i.test(word) || (/^[./\\*?a-z0-9_-]+$/i.test(word) && /^["']/.test(stage.raw[i + 2])));
  return (
    program === 'npm' && ((action === 'test' && !script) || (action === 'run' && /^[a-z0-9:_-]+$/i.test(script || '') && !args.length))
  );
}

/** A restricted literal subset. Unknown shells, options and unresolved paths require a decision. */
export function inspectShell(
  command: ShellCommand,
  workspace: string,
  initial?: string,
): { readOnly: boolean; sessionKey?: string; guardedText?: string } {
  const manual = { readOnly: false };
  const stages = parseStages(command);
  if (!stages || /^[\\/]{2}/.test(workspace)) return manual;
  let root: string;
  try {
    root = realpathSync.native(workspace);
  } catch {
    return manual;
  }
  const start = initial ? within(root, root, initial, true) : null;
  if (initial && !start) return manual;
  let cwd = start || root;
  let knownCwd = Boolean(start);
  let readOnly = true;
  let sessionKey: string | undefined;
  const prefix: unknown[] = [];
  const guards: { start: number; end: number; text: string }[] = [];
  for (let i = 0; i < stages.length; i++) {
    const stage = stages[i];
    const [program, ...args] = stage.words;
    const inPipe = i > 0 && stages[i - 1].next === '|';
    const name = command.shell === 'powershell' ? program.toLowerCase() : program;
    if (!inPipe && (name === 'cd' || (command.shell === 'powershell' && name === 'set-location'))) {
      const folder = args.length === 1 && within(root, cwd, args[0], true);
      if (!folder || stage.next === '|' || stage.next === '||' || sessionKey) return manual;
      const guard = stage.next === ';' && (!knownCwd || path.relative(cwd, folder) !== '');
      if (guard && command.shell !== 'powershell') return manual;
      if (!knownCwd && (!/^(?:[a-z]:[\\/]|\/)/i.test(args[0]) || (!guard && stage.next !== '&&'))) return manual;
      if (guard) {
        if (/[\p{Cc}\u2018-\u201f]/u.test(folder)) return manual;
        guards.push({
          start: stage.start,
          end: stage.end,
          text: "Set-Location -LiteralPath '" + folder.replaceAll("'", "''") + "' -ErrorAction Stop",
        });
      }
      prefix.push([stage.raw, stage.next]);
      cwd = folder;
      knownCwd = true;
      continue;
    }
    if (inPipe && simpleFilter(stage, command.shell)) {
      if (sessionKey && stage.next && stage.next !== '|') return manual;
      if (!sessionKey) prefix.push([stage.raw, stage.next]);
      continue;
    }
    if (sessionKey) return manual;
    if (!inPipe && readStage(stage, command.shell, root, cwd, knownCwd)) {
      prefix.push([stage.raw, stage.next]);
      continue;
    }
    if (!knownCwd || inPipe || (stage.next && stage.next !== '|') || !approvedTest(stage)) return manual;
    readOnly = false;
    sessionKey = JSON.stringify([command.shell, root, start, cwd, prefix, stage.raw]);
  }
  let guardedText = command.text;
  for (const guard of guards.reverse()) guardedText = guardedText.slice(0, guard.start) + guard.text + guardedText.slice(guard.end);
  return { readOnly, sessionKey, guardedText: guards.length ? guardedText : undefined };
}

export function wrappedShellCommand(command: unknown): ShellCommand | null {
  if (typeof command !== 'string') return null;
  const wrapper = /^\s*(?:"([^"]+)"|(\S+))\s+(-NoProfile\s+)?(?:-NonInteractive\s+)?(-Command|-c)\s+(.*)$/i.exec(command);
  if (!wrapper) return null;
  const executable = (wrapper[1] || wrapper[2]).replaceAll('\\', '/').toLowerCase();
  const inner = wrapper[5];
  const text =
    (inner.startsWith('"') && inner.endsWith('"')) || (inner.startsWith("'") && inner.endsWith("'")) ? inner.slice(1, -1) : inner;
  if (
    /^(?:[a-z]:\/windows\/system32\/windowspowershell\/v1\.0\/powershell\.exe|[a-z]:\/program files\/powershell\/7\/pwsh\.exe|\/(?:usr\/)?bin\/pwsh)$/.test(
      executable,
    )
  )
    return wrapper[3] ? { text, shell: 'powershell' } : null;
  if (wrapper[4] === '-c' && !process.env.BASH_ENV && /^\/(?:usr\/)?bin\/bash$/.test(executable)) return { text, shell: 'bash' };
  return null;
}
