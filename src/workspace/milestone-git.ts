import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdtemp, rm, rmdir, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { changeFingerprint, isReviewExcluded, projectSnapshot, reviewChanges } from './git-context.ts';
import type { GitSnapshot } from '../core/types.ts';

const gitAsync = promisify(execFile);

async function git(cwd: string, args: string[], env = process.env): Promise<string> {
  if (process.platform === 'win32' && args.reduce((length, arg) => length + 2 * arg.length + 3, 0) > 28000)
    throw new Error('The milestone contains too many file paths for one Git commit. Split it into smaller milestones.');
  const result = await gitAsync('git', args, { cwd, env, windowsHide: true, timeout: 120000, maxBuffer: 1024 * 1024 });
  return result.stdout;
}

const hookRunner = fileURLToPath(new URL('./milestone-hook.mjs', import.meta.url)).replaceAll('\\', '/');
const guardedHooks = ['pre-commit', 'prepare-commit-msg', 'commit-msg', 'post-commit', 'reference-transaction'];

async function commitWithScopedHooks(root: string, base: string, paths: string[], message: string, current: () => boolean) {
  const original = path.resolve(root, (await git(root, ['rev-parse', '--git-path', 'hooks'])).trim());
  const dir = await mkdtemp(path.join(os.tmpdir(), 'agent-bridge-milestone-hooks-'));
  const dataFile = path.join(dir, 'scope.json');
  const wrappers = guardedHooks.map((hook) => path.join(dir, hook));
  try {
    await writeFile(dataFile, JSON.stringify({ hooks: original, base, paths }));
    await Promise.all(
      guardedHooks.map((hook, index) =>
        writeFile(wrappers[index], '#!/bin/sh\nexec "$AGENT_BRIDGE_GIT_NODE" "$AGENT_BRIDGE_GIT_HOOK" ' + hook + ' "$@"\n', {
          mode: 0o755,
        }),
      ),
    );
    if (!current()) throw new Error('This milestone is no longer active.');
    const env = {
      ...process.env,
      AGENT_BRIDGE_GIT_NODE: process.execPath.replaceAll('\\', '/'),
      AGENT_BRIDGE_GIT_HOOK: hookRunner,
      AGENT_BRIDGE_MILESTONE_GUARD_DATA: dataFile,
    };
    await git(root, ['-c', 'core.hooksPath=' + dir, '--literal-pathspecs', 'commit', '--only', '-m', message, '--', ...paths], env);
  } finally {
    await Promise.allSettled([dataFile, ...wrappers].map((file) => rm(file, { force: true })));
    await rmdir(dir).catch(() => {});
  }
}

export interface MilestoneWorkspace {
  root: string;
  prefix: string;
  label: string;
  initial: GitSnapshot;
}

export interface MilestoneCommitCandidate {
  workspace: MilestoneWorkspace;
  paths: string[];
  fingerprint: string;
}

export async function captureMilestoneWorkspace(cwd: string, label: string): Promise<MilestoneWorkspace | null> {
  try {
    const [directory, prefix] = await Promise.all([git(cwd, ['rev-parse', '--show-toplevel']), git(cwd, ['rev-parse', '--show-prefix'])]);
    const root = directory.replace(/\r?\n$/, '');
    const initial = projectSnapshot(root);
    return initial ? { root, prefix: prefix.replace(/\r?\n$/, ''), label, initial } : null;
  } catch {
    return null;
  }
}

export async function findMilestoneChanges(workspace: MilestoneWorkspace, exclusions: unknown): Promise<MilestoneCommitCandidate | null> {
  const { root, prefix, initial } = workspace;
  const snapshot = projectSnapshot(root);
  if (!snapshot || !snapshot.head || !snapshot.branch)
    throw new Error(workspace.label + ' needs an existing Git commit and a checked-out branch.');
  if (snapshot.head !== initial.head || snapshot.branch !== initial.branch)
    throw new Error('The Git branch or HEAD changed in ' + workspace.label + '. Start a new milestone plan before committing.');
  const protectedPaths = new Set(initial.files.map((file) => file.path));
  const status = new Map(snapshot.files.map((file) => [file.path, file.status]));
  const changes = await reviewChanges(root, exclusions, { metadataOnly: true });
  if (!changes) throw new Error('Could not read the Git changes for ' + workspace.label + '.');
  const paths = changes.files
    .filter(({ names }) =>
      names.every((name) => {
        const fileStatus = status.get(name);
        return (
          name.startsWith(prefix) &&
          !protectedPaths.has(name) &&
          !isReviewExcluded(name.slice(prefix.length), exclusions) &&
          Boolean(fileStatus && (fileStatus === '??' || fileStatus.startsWith(' ')))
        );
      }),
    )
    .flatMap(({ names }) => names);
  if (!paths.length) return null;
  const fingerprint = await changeFingerprint(root);
  if (!fingerprint) throw new Error('Could not fingerprint the Git changes for ' + workspace.label + '.');
  return { workspace, paths: [...new Set(paths)].sort(), fingerprint };
}

export async function commitMilestone(candidate: MilestoneCommitCandidate, message: string, current: () => boolean) {
  const { workspace, paths, fingerprint } = candidate;
  const { root, initial } = workspace;
  const snapshot = projectSnapshot(root);
  if (
    !current() ||
    !initial.head ||
    snapshot?.head !== initial.head ||
    snapshot?.branch !== initial.branch ||
    (await changeFingerprint(root)) !== fingerprint
  )
    throw new Error('The approved changes moved before the commit. Declare the milestone again.');
  const gitDir = path.resolve(root, (await git(root, ['rev-parse', '--absolute-git-dir'])).trim());
  if (
    ['MERGE_HEAD', 'CHERRY_PICK_HEAD', 'REVERT_HEAD', 'rebase-apply', 'rebase-merge', 'sequencer'].some((name) =>
      existsSync(path.join(gitDir, name)),
    )
  )
    throw new Error('Finish the Git operation in ' + workspace.label + ' before committing the milestone.');
  const selected = new Set(paths);
  const newPaths = snapshot.files.filter((file) => file.status === '??' && selected.has(file.path)).map((file) => file.path);
  if (!current()) throw new Error('This milestone is no longer active.');
  try {
    if (newPaths.length) await git(root, ['--literal-pathspecs', 'add', '--intent-to-add', '--', ...newPaths]);
    if (!current()) throw new Error('This milestone is no longer active.');
    await commitWithScopedHooks(root, initial.head, paths, message, current);
  } catch {
    const after = projectSnapshot(root);
    if (after?.head === initial.head && newPaths.length) {
      const stillUnstaged = new Set(after.files.filter((file) => file.status === ' A').map((file) => file.path));
      const marked = newPaths.filter((name) => stillUnstaged.has(name));
      if (marked.length) await git(root, ['--literal-pathspecs', 'reset', '-q', 'HEAD', '--', ...marked]).catch(() => {});
    }
    throw new Error('Git could not commit the selected files in ' + workspace.label + '. Check Git hooks and the working tree.');
  }
  const head = (await git(root, ['rev-parse', '--verify', 'HEAD'])).trim();
  const next = projectSnapshot(root);
  if (!next || next.head !== head) throw new Error('Git created a commit but the working tree could not be verified.');
  return { head, snapshot: next };
}
