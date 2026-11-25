import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { readFile, writeFile, mkdir, lstat, unlink, rename } from 'node:fs/promises';
import { gitRead } from './publication-scan.ts';

const quote = (word: string) => "'" + word.replaceAll('\\', '/').replaceAll("'", "'\\''") + "'";
const tool = fileURLToPath(new URL('../../bin/check-publication.mjs', import.meta.url));
const script = '#!/bin/sh\n# Agent Bridge pre-push\nexec ' + quote(process.execPath) + ' ' + quote(tool) + ' "$@"\n';
async function inspect(cwd: string) {
  const root = (await gitRead(cwd, ['rev-parse', '--show-toplevel'])).trim();
  const dir = (await gitRead(root, ['rev-parse', '--absolute-git-dir'])).trim();
  const hook = (await gitRead(root, ['rev-parse', '--path-format=absolute', '--git-path', 'hooks/pre-push'])).trim();
  if (path.resolve(hook) !== path.resolve(dir, 'hooks', 'pre-push'))
    throw new Error('Shared or customized hooks directories are managed separately.');
  const folder = await lstat(path.dirname(hook)).catch((error: NodeJS.ErrnoException) => {
    if (error.code !== 'ENOENT') throw error;
  });
  if (folder && !folder.isDirectory()) throw new Error('Custom hooks directory.');
  let contents: Buffer | null = null;
  try {
    const meta = await lstat(hook);
    if (!meta.isFile() || meta.size > 1024 * 1024) throw new Error('Custom hook cannot be replaced.');
    contents = await readFile(hook);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }
  const text = contents?.toString();
  const previous = text?.startsWith(script) ? /^# original ([a-f0-9]{64})\n$/.exec(text.slice(script.length))?.[1] : undefined;
  return {
    hook,
    previous,
    enabled: text === script || Boolean(previous),
    existing: contents !== null,
    signature: contents ? createHash('sha256').update(contents).digest('hex') : '',
  };
}
export async function hookStatus(cwd: string) {
  const { enabled, existing, signature } = await inspect(cwd);
  return { enabled, existing, signature };
}
export async function setHook(cwd: string, enabled: boolean, expected: string) {
  const current = await inspect(cwd);
  if (current.enabled === enabled) return hookStatus(cwd);
  if (current.signature !== expected) throw new Error('Hook changed. Reopen settings.');
  const backup = current.hook + '.before-agent-bridge';
  if (enabled) {
    await mkdir(path.dirname(current.hook), { recursive: true });
    if (current.existing) {
      await writeFile(backup, await readFile(current.hook), { flag: 'wx', mode: (await lstat(current.hook)).mode });
      await unlink(current.hook);
    }
    try {
      await writeFile(current.hook, current.existing ? script + '# original ' + current.signature + '\n' : script, {
        flag: 'wx',
        mode: 0o755,
      });
    } catch (error) {
      if (current.existing && !(await lstat(current.hook).catch(() => null))) await rename(backup, current.hook);
      throw error;
    }
  } else {
    if (current.previous) {
      const meta = await lstat(backup);
      if (
        !meta.isFile() ||
        meta.size > 1024 * 1024 ||
        createHash('sha256')
          .update(await readFile(backup))
          .digest('hex') !== current.previous
      )
        throw new Error('The original hook backup changed. Restore it manually.');
      await rename(backup, current.hook);
    } else await unlink(current.hook);
  }
  return hookStatus(cwd);
}
