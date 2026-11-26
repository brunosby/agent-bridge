import path from 'node:path';
import { isTestCommand } from './test-command.ts';
import { redact } from './secret-detection.ts';

const clip = (s: string, limit = 60) => (s.length > limit ? s.slice(0, limit - 1) + '…' : s);
const firstLine = (s: string) => s.split(/[\r\n]/, 1)[0].trim();

function relativeFile(input: string, cwd: string) {
  if (!input || !cwd || /[\p{Cc}{}<>|]/u.test(input)) return '';
  const paths = /^(?:[a-z]:|\\\\)/i.test(cwd) ? path.win32 : path.posix;
  if ((paths === path.posix && path.win32.isAbsolute(input) && !path.posix.isAbsolute(input)) || /^~(?:[\\/]|$)/.test(input))
    return 'outside the project';
  const rel = paths.relative(cwd, paths.resolve(cwd, input));
  if (paths.isAbsolute(rel) || rel === '..' || rel.startsWith('..' + paths.sep)) return 'outside the project';
  return rel.split(paths.sep).join('/') || '.';
}

// Normalize absolute paths embedded in a short description as well as stand-alone file inputs.
function safeDescription(value: string, cwd: string) {
  return value.replace(/(?:[A-Za-z]:[\\/]|\\\\[^\\/\s]+[\\/]|(?<!\S)\/)[^\r\n"'<>|]*/g, (file) => relativeFile(file.trimEnd(), cwd));
}

// A command can contain literals, credentials or an inline script. Retain the program and
// recognizable subcommand, never copy arbitrary operands, assignments, or quoted bodies.
export function commandLabel(input: string) {
  const line = firstLine(input);
  if (isTestCommand(line)) return 'Running tests';
  const command = line.replace(/^(?:\s*(?:export\s+)?[A-Za-z_]\w*=(?:"[^"]*"|'[^']*'|[^\s]+)\s+)+/, '');
  const match = /^([a-z][\w.-]*)(?:\s+([a-z][\w:-]*))?(?:\s|$)/i.exec(command);
  if (!match || /^(?:set|export|env)$/i.test(match[1])) return 'Running a command';
  const sub =
    /^(?:git|npm|pnpm|yarn|cargo|dotnet|go)$/i.test(match[1]) &&
    /^(?:status|diff|log|show|switch|checkout|add|commit|push|pull|fetch|install|run|build|check|fmt|list|restore|update)$/i.test(
      match[2] || '',
    )
      ? ' ' + match[2]
      : '';
  return 'Running ' + clip(match[1] + sub, 40);
}

export function describeActivity(title: string, detail: string, cwd: string) {
  const name = /^[\w. -]+$/.test(title) ? title : 'tool';
  let text = 'Using ' + name;
  let files: string[] = [];
  // Some adapters supply structured inputs as JSON. Read only identified fields,
  // never display serialized inputs (which may include new file contents).
  let args: Record<string, unknown> = {};
  const structured = /^\s*(?:\{\s*["}]|\[\s*[{"])/.test(detail);
  if (structured) {
    try {
      args = JSON.parse(detail) || {};
    } catch {
      /* clipped adapter payload */
    }
  }
  const field = (...keys: string[]) => {
    for (const key of keys) if (typeof args[key] === 'string') return args[key] as string;
    return structured ? '' : detail;
  };
  const edit = /^(?:edit|write|multiedit|notebookedit|fileChange|patch|apply_patch)$/i.test(name);
  if (edit || /^(?:read|readFile)$/i.test(name)) {
    const raw = field('file_path', 'filePath', 'path', 'notebook_path');
    const lines = raw.split(/\r?\n/);
    // Multi-file detail from Codex contains one change kind and path per line.
    const entries = lines.length === 1 || lines.every((s) => /^(?:add|update|delete|modify|rename)\s+/i.test(s)) ? lines : [];
    const names = entries.map((s) => relativeFile(s.replace(/^(?:add|update|delete|modify|rename)\s+/i, ''), cwd)).filter(Boolean);
    if (names.length) text = (edit ? 'Editing ' : 'Reading ') + names[0] + (names.length > 1 ? ' +' + (names.length - 1) + ' files' : '');
    if (edit) files = names.filter((n) => n !== 'outside the project').slice(0, 50);
  } else if (/^(?:shell|bash|powershell|commandExecution)$/i.test(name)) text = commandLabel(field('command'));
  else if (/^(?:grep|glob|search)$/i.test(name)) {
    const term = firstLine(field('pattern', 'query')).split(' in ')[0];
    text = term ? "Searching '" + safeDescription(term, cwd) + "'" : 'Searching';
  } else if (/^web\s?search$/i.test(name)) text = 'Searching the web';
  else if (/^webfetch$/i.test(name)) {
    try {
      const url = new URL(field('url'));
      if (/^https?:$/.test(url.protocol)) text = 'Fetching ' + url.hostname;
    } catch {
      /* no URL */
    }
  } else if (/^(?:task|agent)$/i.test(name)) {
    const desc = firstLine(field('description'));
    text = 'Running a sub-agent' + (desc ? ': ' + safeDescription(desc, cwd) : '');
  } else {
    const m = /^mcp__(.+?)__(.+)$/.exec(name) || /^([^.]+)\.(.+)$/.exec(name);
    if (m) text = m[2] === 'bridge_diff' ? 'Reviewing the diff' : 'Using ' + m[2] + ' (' + m[1] + ')';
    else if (name === 'bridge_diff') text = 'Reviewing the diff';
  }
  return { text: clip(redact(text, { genericAssignments: true })), files };
}
