import { execFile } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

function git(cwd: string, args: string[]): Promise<string> {
  return new Promise<string>((resolve, reject) => {
    execFile('git', args, { cwd, windowsHide: true }, (err, stdout, stderr) => {
      if (err) reject(new Error((stderr || err.message).trim()));
      else resolve(stdout.trim());
    });
  });
}

/**
 * Give an agent its own git worktree so coders do not edit the same files at the same time.
 * Created next to the repository: <repo>-agent-worktrees/<conversation>/<agent>, on a new branch
 * agent-bridge/<conversation>/<agent>. Nothing is deleted automatically; merge or remove it with git.
 */
export interface Worktree {
  path: string;
  root: string;
  branch: string;
  reused?: boolean;
}

export async function createWorktree({
  repoDir,
  conversationId,
  agentName,
}: {
  repoDir: string;
  conversationId: string;
  agentName: string;
}): Promise<Worktree> {
  let top: string;
  try {
    top = await git(repoDir, ['rev-parse', '--show-toplevel']);
  } catch {
    throw new Error('The project folder is not a git repository, so a separate worktree cannot be created.');
  }
  const conv = conversationId.slice(0, 19).replace(/[^\w-]/g, '-');
  const safeName = agentName.replace(/[^\w-]/g, '-');
  const base = path.join(path.dirname(top), `${path.basename(top)}-agent-worktrees`, conv);
  const dir = path.join(base, safeName);
  const branch = `agent-bridge/${conv}/${safeName}`;
  // Keep the agent in the same sub-folder of the repository as the conversation.
  const sub = path.relative(top, repoDir);
  const agentDir = path.join(dir, sub);
  if (fs.existsSync(dir)) return { path: agentDir, root: dir, branch, reused: true };
  fs.mkdirSync(base, { recursive: true });
  await git(top, ['worktree', 'add', '-b', branch, dir]);
  return { path: agentDir, root: dir, branch };
}
