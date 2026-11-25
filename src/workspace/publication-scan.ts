import { gitProgram } from './git-program.ts';
import { execFile, spawn } from 'node:child_process';
import { createHash, createHmac } from 'node:crypto';
import { projectRules } from './secret-patterns.ts';
import { detectSecrets, redact } from '../core/secret-detection.ts';
import { isReviewExcluded } from './git-context.ts';

export interface Finding {
  id: string;
  commit: string;
  file: string;
  line: number;
  rule: string;
}
export interface Scan {
  findings: Finding[];
  unexamined: string[];
  remoteRefLimit?: boolean;
  commits: number;
  revisions: string[];
  signature: string;
  scope: string;
}
export const oid = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/;
export async function gitRead(cwd: string, args: string[], timeout = 5000, input?: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = execFile(
      gitProgram(),
      [
        '--no-optional-locks',
        '--no-replace-objects',
        '--literal-pathspecs',
        '-c',
        'core.fsmonitor=false',
        '-c',
        'log.showSignature=false',
        ...args,
      ],
      {
        cwd,
        windowsHide: true,
        timeout,
        maxBuffer: 12 * 1024 * 1024,
        encoding: 'utf8',
        env: { ...process.env, LC_ALL: 'C', GIT_TERMINAL_PROMPT: '0', GCM_INTERACTIVE: 'never', GIT_NO_LAZY_FETCH: '1' },
      },
      (error, stdout) => (error ? reject(new Error('Git could not verify the publication.')) : resolve(stdout)),
    );
    child.stdin?.on('error', reject);
    child.stdin?.end(input);
  });
}

export async function gitObjects(cwd: string, expressions: string[]) {
  if (!expressions.length) return [];
  const out = await gitRead(cwd, ['cat-file', '--batch-check=%(objectname) %(objecttype)'], 5000, expressions.join('\n') + '\n');
  const lines = out.trimEnd().split('\n');
  if (lines.length !== expressions.length) throw new Error('Incomplete object lookup.');
  return lines.map((line) => {
    const [id, type] = line.trimEnd().split(' ');
    return oid.test(id) && ['commit', 'tag', 'tree', 'blob'].includes(type) ? { id, type } : null;
  });
}

// Git attributes may suppress a textual patch. Check the blob itself before classifying it as binary.
async function binaryBlob(cwd: string, object: string) {
  if (!oid.test(object)) throw new Error('Invalid blob.');
  const child = spawn(gitProgram(), ['--no-replace-objects', 'cat-file', 'blob', object], {
    cwd,
    stdio: ['ignore', 'pipe', 'ignore'],
    windowsHide: true,
    timeout: 5000,
    env: { ...process.env, GIT_NO_LAZY_FETCH: '1', GIT_TERMINAL_PROMPT: '0' },
  });
  return new Promise<boolean>((resolve, reject) => {
    let length = 0;
    let inspected: boolean | undefined;
    child.stdout.on('data', (chunk: Buffer) => {
      if (inspected !== undefined) return;
      const prefix = chunk.subarray(0, 8000 - length);
      length += prefix.length;
      const binary = prefix.includes(0);
      if (binary || length === 8000) {
        inspected = binary;
        child.kill();
      }
    });
    child.once('error', () => reject(new Error('Could not inspect Git blob.')));
    child.once('close', (code) => {
      if (inspected !== undefined) resolve(inspected);
      else if (code === 0) resolve(false);
      else reject(new Error('Incomplete Git blob.'));
    });
  });
}

export async function scanCommits(
  cwd: string,
  tips: string[],
  exclude: string[],
  scope: string,
  extra: string[],
  key: Buffer,
  annotations: string[] = [],
): Promise<Scan> {
  const root = (await gitRead(cwd, ['rev-parse', '--show-toplevel'])).trim();
  const prefixes = projectRules(root);
  const signature = createHash('sha256').update(JSON.stringify([root, tips, exclude, scope, extra, prefixes, annotations]));
  const findings = new Map<string, Finding>();
  const unexamined = new Set<string>();
  const start = Date.now();
  const check = () => {
    if (Date.now() - start > 120000 || findings.size > 1000) throw new Error('Scan limit reached. Publication is pending.');
  };
  function report(commit: string, file: string, line: number, rule: string, value: string) {
    const id = createHmac('sha256', key)
      .update(JSON.stringify([root, commit === 'PR' ? [scope, extra] : null, file, rule, value]))
      .digest('hex');
    if (!findings.has(id)) findings.set(id, { id, commit, file: redact(file, prefixes), line, rule });
  }
  function inspect(commit: string, file: string, line: number, text: string, keyFiles?: Set<string>) {
    if (keyFiles && /^[A-Za-z0-9+/]{16,}={0,2}\s*$/.test(text)) keyFiles.add(file);
    for (const hit of detectSecrets(text, prefixes, file)) {
      if (hit.rule === 'Private key' && keyFiles) keyFiles.add(file);
      else report(commit, file, line, hit.rule, hit.rule === 'Private key' ? commit + ':' + line + ':' + hit.value : hit.value);
    }
  }
  extra.forEach((value, i) => value.split(/\r?\n/).forEach((line, n) => inspect('PR', i === 0 ? 'title' : 'description', n + 1, line)));
  for (const ref of annotations) {
    if (!oid.test(ref)) throw new Error('Unverified tag.');
    const tag = await gitRead(root, ['cat-file', '-p', ref]);
    tag.split('\n').forEach((line, i) => inspect(ref, 'tag message', i + 1, line));
  }
  if (![...tips, ...exclude].every((id) => oid.test(id))) throw new Error('Unverified revision.');
  if (tips.length && (await gitRead(root, ['rev-parse', '--is-shallow-repository'])).trim() !== 'false')
    throw new Error('Full commit history is required.');
  const revisions = tips.length
    ? (await gitRead(root, ['rev-list', '--stdin'], 5000, [...tips, ...exclude.map((id) => '^' + id)].join('\n') + '\n'))
        .trim()
        .split(/\s+/)
        .filter(Boolean)
    : [];
  if (revisions.length > 10000) throw new Error('Too many commits to verify.');
  for (const commit of revisions) {
    check();
    signature.update(commit);
    const meta = await gitRead(root, ['show', '-s', '--format=%P%x00%B', commit]);
    const sep = meta.indexOf('\0');
    if (sep < 0) throw new Error('Missing commit metadata.');
    const parent = meta.slice(0, sep).split(' ')[0];
    meta
      .slice(sep + 1)
      .split('\n')
      .forEach((line, i) => inspect(commit, 'commit message', i + 1, line));
    const base = [
      'diff-tree',
      '--ignore-submodules=none',
      '--no-relative',
      '--root',
      '-r',
      '--no-commit-id',
      '--no-renames',
      '--no-ext-diff',
      '--no-textconv',
      '--diff-filter=AMT',
    ];
    const range = parent ? [parent, commit, '--'] : [commit, '--'];
    const names = (await gitRead(root, [...base, '--name-only', '-z', ...range])).split('\0').filter(Boolean);
    if (!names.length) continue;
    const entries = new Map<string, { size: number; object: string }>();
    const tree = await gitRead(root, ['ls-tree', '-r', '-l', '-z', commit]);
    for (const entry of tree.split('\0')) {
      const split = entry.indexOf('\t');
      if (split < 0) continue;
      const [, , object, size] = entry.slice(0, split).trim().split(/\s+/);
      entries.set(entry.slice(split + 1), { size: Number(size), object });
    }
    const paths = [];
    for (const file of names) {
      const entry = entries.get(file);
      if (!entry) throw new Error('Incomplete tree.');
      if (isReviewExcluded(file)) report(commit, file, 0, 'Sensitive filename', entry.object);
      if (
        /(?:^|\/)(?:node_modules|vendor)\//i.test(file) ||
        /(?:^|\/)(?:package-lock\.json|npm-shrinkwrap\.json|yarn\.lock|pnpm-lock\.yaml|bun\.lockb?|Cargo\.lock|composer\.lock|Gemfile\.lock|poetry\.lock)$/i.test(
          file,
        )
      )
        continue;
      if (entry.size > 12 * 1024 * 1024) {
        if (!(await binaryBlob(root, entry.object))) throw new Error('Scan limit reached for a changed file.');
        unexamined.add(redact(file, prefixes));
        continue;
      }
      paths.push(file);
    }
    const keyFiles = new Set<string>();
    let bytes = 0;
    for (let offset = 0; offset < paths.length; offset += 48) {
      check();
      const batch = paths.slice(offset, offset + 48);
      const patch = await gitRead(root, [...base, '-p', '--no-color', '--unified=0', ...range, ...batch]);
      bytes += Buffer.byteLength(patch);
      if (bytes > 12 * 1024 * 1024) throw new Error('Scan limit reached for this commit.');
      let index = -1,
        number = 0,
        hunk = false;
      for (const line of patch.split('\n')) {
        if (line.startsWith('diff --git ')) {
          index++;
          number = 0;
          hunk = false;
          if (index >= batch.length) throw new Error('Unrecognized patch.');
        } else if (line.startsWith('@@ ')) {
          const match = /^@@ -\d+(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(line);
          if (!match) throw new Error('Unrecognized patch.');
          number = Number(match[1]);
          hunk = true;
        } else if (hunk && line.startsWith('+')) {
          const text = line.slice(1);
          if (text === 'version https://git-lfs.github.com/spec/v1') unexamined.add(redact(batch[index], prefixes));
          inspect(commit, batch[index], number++, text, keyFiles);
        } else if (hunk && line.startsWith(' ')) number++;
        else if (!hunk && line.startsWith('Binary files ')) {
          const file = batch[index],
            entry = entries.get(file)!;
          if (await binaryBlob(root, entry.object)) unexamined.add(redact(file, prefixes));
          else {
            bytes += entry.size;
            if (bytes > 12 * 1024 * 1024) throw new Error('Scan limit reached for this commit.');
            const contents = await gitRead(root, ['cat-file', 'blob', entry.object]);
            contents.split('\n').forEach((text, n) => inspect(commit, file, n + 1, text, keyFiles));
          }
        }
      }
      if (index + 1 !== batch.length) throw new Error('Incomplete patch.');
    }
    // A header is shared by many credentials. Bind an exception to the actual PEM block,
    // including when the only changed line is encoded key material.
    for (const file of keyFiles) {
      check();
      const blob = await gitRead(root, ['cat-file', 'blob', entries.get(file)!.object]);
      let pos = 0,
        line = 1;
      for (const match of blob.matchAll(/-----BEGIN ([A-Z0-9 ]*PRIVATE KEY)-----[\s\S]*?(?:-----END \1-----|$)/g)) {
        line += blob.slice(pos, match.index).split('\n').length - 1;
        report(commit, file, line, 'Private key', match[0]);
        pos = match.index;
      }
    }
  }
  check();
  return {
    findings: [...findings.values()],
    unexamined: [...unexamined],
    commits: revisions.length,
    revisions,
    scope: redact(scope, prefixes),
    signature: signature.digest('hex'),
  };
}
