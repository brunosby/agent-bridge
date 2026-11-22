// Invoked with Git's temporary index for a path-limited commit.
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { error } from 'node:console';

const [hook, ...args] = process.argv.slice(2);
const { hooks, tree } = JSON.parse(readFileSync(process.env.AGENT_BRIDGE_MILESTONE_GUARD_DATA, 'utf8'));
if (existsSync(path.join(hooks, hook))) {
  const original = spawnSync('git', ['-c', 'core.hooksPath=' + hooks, 'hook', 'run', '--ignore-missing', hook, '--', ...args], {
    stdio: 'inherit',
  });
  if (original.status !== 0) process.exit(original.status || 1);
}
if (hook === 'post-commit' || hook === 'reference-transaction') process.exit(0);
const staged = spawnSync('git', ['write-tree'], { encoding: 'utf8' });
if (staged.status !== 0 || staged.stdout.trim() !== tree) {
  error('Milestone content differs from the approved Git tree.');
  process.exit(1);
}
