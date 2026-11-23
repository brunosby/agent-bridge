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
 * Created next to the repository: <repo>-agent-worktrees/<conversation-id>/<agent-id>, on a new branch
 * agent-bridge/<conversation-id>/<agent-id>. Nothing is deleted automatically; merge or remove it with git.
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
  agentId,
}: {
  repoDir: string;
  conversationId: string;
  agentId: string;
}): Promise<Worktree> {
  let top: string;
  try {
    top = await git(repoDir, ['rev-parse', '--show-toplevel']);
  } catch {
    throw new Error('The project folder is not a git repository, so a separate worktree cannot be created.');
  }
  if (!/^[\w-]+$/.test(conversationId) || !/^a[1-9]\d*$/.test(agentId)) throw new Error('Invalid worktree identity.');
  const conv = conversationId;
  const base = path.join(path.dirname(top), `${path.basename(top)}-agent-worktrees`, conv);
  const dir = path.join(base, agentId);
  const branch = `agent-bridge/${conv}/${agentId}`;
  // Keep the agent in the same sub-folder of the repository as the conversation.
  const sub = path.relative(fs.realpathSync.native(top), fs.realpathSync.native(repoDir));
  if (path.isAbsolute(sub) || sub === '..' || sub.startsWith('..' + path.sep))
    throw new Error('The project folder is outside the Git worktree.');
  const agentDir = path.join(dir, sub);
  if (fs.existsSync(dir)) throw new Error('A worktree already exists for this agent identity.');
  fs.mkdirSync(base, { recursive: true });
  await git(top, ['worktree', 'add', '-b', branch, dir]);
  return { path: agentDir, root: dir, branch };
}
