import { statSync } from 'node:fs';
import path from 'node:path';

function resolveCommand(command: string, cwd: string) {
  const qualified = /[\\/:]/.test(command);
  const directories = qualified
    ? [cwd]
    : (process.env.PATH || '')
        .split(path.delimiter)
        .map((dir) => dir.replace(/^"(.*)"$/, '$1'))
        .filter((dir) => path.isAbsolute(dir));
  const supported = /^\.(?:exe|com|cmd|bat)$/i;
  const extension = path.extname(command);
  const suffixes = extension
    ? supported.test(extension)
      ? ['']
      : []
    : (process.env.PATHEXT || '.COM;.EXE;.BAT;.CMD').split(';').filter((ext) => supported.test(ext));
  for (const dir of directories)
    for (const ext of suffixes) {
      const file = path.resolve(dir, command + ext);
      if (statSync(file, { throwIfNoEntry: false })?.isFile()) return file;
    }
  throw new Error('ENOENT: executable not found');
}

function escapeCmd(text: string) {
  return text.replace(/[\s"&|<>^()%!]/g, '^$&');
}

function batchArgument(value: string) {
  if (/[\0\r\n]/.test(value)) throw new Error('EINVAL: invalid line break or NUL in batch argument');
  // Quote for the executable's Windows argv parser, then protect both cmd.exe parsing passes
  // (the invocation of the shim, and the shim forwarding %*).
  const quoted = '"' + value.replace(/(\\*)"/g, '$1$1\\"').replace(/(\\+)$/, '$1$1') + '"';
  return escapeCmd(escapeCmd(quoted));
}

export function providerCommand(command: string, args: string[], cwd: string) {
  if (process.platform !== 'win32') return { file: command, args, verbatim: false };
  const file = resolveCommand(command, cwd);
  if (!/\.(?:bat|cmd)$/i.test(file)) return { file, args, verbatim: false };
  const line = [escapeCmd(file), ...args.map(batchArgument)].join(' ');
  return {
    file: path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'cmd.exe'),
    args: ['/d', '/v:off', '/s', '/c', '"' + line + '"'],
    verbatim: true,
  };
}
