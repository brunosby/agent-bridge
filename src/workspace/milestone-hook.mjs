// Invoked with Git's temporary index for a path-limited commit.
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { error } from 'node:console';

const [hook, ...args] = process.argv.slice(2);
const { hooks, base, paths } = JSON.parse(readFileSync(process.env.AGENT_BRIDGE_MILESTONE_GUARD_DATA, 'utf8'));
if (existsSync(path.join(hooks, hook))) {
  const original = spawnSync('git', ['-c', 'core.hooksPath=' + hooks, 'hook', 'run', '--ignore-missing', hook, '--', ...args], {
    stdio: 'inherit',
  });
  if (original.status !== 0) process.exit(original.status || 1);
}
if (hook === 'post-commit' || hook === 'reference-transaction') process.exit(0);
const staged = spawnSync('git', ['diff', '--cached', '--name-only', '-z', '--no-renames', base, '--'], { encoding: 'utf8' });
if (staged.status !== 0) process.exit(1);
const allowed = new Set(paths);
const committed = staged.stdout.split('\0').filter(Boolean);
if (committed.length !== allowed.size || committed.some((name) => !allowed.has(name))) {
  error('Milestone hook changed the approved set of files.');
  process.exit(1);
}
