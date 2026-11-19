import path from 'node:path';
import type { Conversation } from '../core/types.ts';
import { committedPaths, projectSnapshot } from '../workspace/git-context.ts';

export function captureProject(conv: Conversation, cwd: string, baseline: boolean): void {
  const snapshot = projectSnapshot(cwd);
  const initial = Object.hasOwn(conv.project, cwd) ? conv.project[cwd].initial : baseline ? snapshot : null;
  conv.project[cwd] = { initial, git: !!snapshot, branch: snapshot?.branch || null, detached: Boolean(snapshot?.head && !snapshot.branch) };
}

export function summarizeProject(conv: Conversation) {
  return Object.entries(conv.project).map(([cwd, entry]) => {
    const title = cwd === conv.workDir ? 'Project' : conv.team.find((agent) => agent.cwd === cwd)?.name || 'Worktree';
    const current = projectSnapshot(cwd);
    const initial = entry.initial;
    const committed = current && initial ? committedPaths(cwd, initial.head, current.head) : [];
    if (!current || !initial) return { title, status: current ? 'no-baseline' : 'no-git', files: [] };
    const before = new Map(initial.files.map((file) => [file.path, file.status]));
    const files = new Map(current.files.map((file) => [file.path, { ...file, preexisting: before.has(file.path) }]));
    for (const file of committed || []) {
      if (!files.has(file)) files.set(file, { path: file, status: 'committed change', preexisting: before.has(file) });
    }
    for (const file of initial.files) {
      if (!files.has(file.path)) files.set(file.path, { ...file, status: 'no longer listed', preexisting: true });
    }
    return { title, status: committed === null || (!initial.head && current.head) ? 'partial' : 'ok', files: [...files.values()] };
  });
}

export function projectLabel(conv: Conversation) {
  const entry = conv.project[conv.workDir];
  return {
    name: path.basename(conv.workDir) || conv.workDir,
    git: !!entry?.git,
    branch: entry?.branch || null,
    detached: !!entry?.detached,
  };
}
