import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { execFile } from 'node:child_process';
import { mkdtemp, rmdir } from 'node:fs/promises';
import { gitProgram } from './git-program.ts';
import { gitObjects, oid } from './publication-scan.ts';

export const simpleRef = (s: string) => /^[A-Za-z0-9_][A-Za-z0-9._/-]*$/.test(s) && !s.includes('..');

function credentialEnvironment(): NodeJS.ProcessEnv {
  // Pass locations needed by Git, the OS credential store and ssh-agent. Never inherit
  // repository selectors, command-line Git config or credentials from provider processes.
  const env: NodeJS.ProcessEnv = {};
  for (const key of [
    'PATH',
    'HOME',
    'USER',
    'LOGNAME',
    'USERNAME',
    'USERPROFILE',
    'HOMEDRIVE',
    'HOMEPATH',
    'SystemRoot',
    'SystemDrive',
    'ComSpec',
    'PATHEXT',
    'ProgramData',
    'ProgramFiles',
    'ProgramFiles(x86)',
    'ProgramW6432',
    'APPDATA',
    'LOCALAPPDATA',
    'TMP',
    'TEMP',
    'TMPDIR',
    'XDG_CONFIG_HOME',
    'XDG_DATA_HOME',
    'XDG_RUNTIME_DIR',
    'DBUS_SESSION_BUS_ADDRESS',
    'SSH_AUTH_SOCK',
    'GIT_CONFIG_SYSTEM',
    'GIT_CONFIG_GLOBAL',
    'GIT_CONFIG_NOSYSTEM',
  ]) {
    if (process.env[key] !== undefined) env[key] = process.env[key];
  }
  return env;
}

export async function remoteTips(cwd: string, url: string, refs: ReadonlySet<string> | null) {
  const empty = { commits: [] as string[], overLimit: false };
  // null requests the complete listing. An empty set requests only the default branch.
  if (refs && [...refs].some((ref) => !ref.startsWith('refs/') || !simpleRef(ref))) return empty;
  // Resolve refs outside the worktree so only system and user Git settings can supply credentials.
  if (/^https:\/\//i.test(url)) {
    const endpoint = URL.parse(url);
    if (!endpoint || endpoint.username || endpoint.password || endpoint.search) return empty;
  }
  let remote = url;
  const ssh = /^ssh:\/\/(?:[\w.-]+@)?[\w.-]+(?::\d+)?\/[\w./~-]+$|^(?:[\w.-]+@)[\w.-]+:[\w./~-]+$/.test(url);
  if (/^file:\/\//i.test(url)) {
    try {
      remote = fileURLToPath(url);
    } catch {
      return empty;
    }
  } else if (!ssh && !/^https:\/\//i.test(url)) {
    if (url.includes('::') || (!path.isAbsolute(url) && /:/.test(url))) return empty;
    remote = path.resolve(cwd, url);
  }
  const tmp = await mkdtemp(path.join(os.tmpdir(), 'bridge-refs-'));
  try {
    const out = await new Promise<string>((resolve, reject) =>
      execFile(
        gitProgram(),
        [
          '-c',
          'protocol.allow=never',
          '-c',
          'http.followRedirects=false',
          '-c',
          'protocol.file.allow=always',
          '-c',
          'protocol.https.allow=always',
          '-c',
          'protocol.ssh.allow=always',
          '-c',
          'credential.interactive=false',
          '-c',
          'core.askPass=',
          'ls-remote',
          refs ? '--symref' : '--refs',
          '--',
          remote,
          ...(refs ? ['HEAD', ...refs] : []),
        ],
        {
          cwd: tmp,
          windowsHide: true,
          timeout: 10000,
          maxBuffer: 2 * 1024 * 1024,
          env: {
            ...credentialEnvironment(),
            GIT_TERMINAL_PROMPT: '0',
            GCM_INTERACTIVE: 'never',
            GIT_SSH_COMMAND: 'ssh -o BatchMode=yes -o StrictHostKeyChecking=yes -o ConnectTimeout=3',
            GIT_CEILING_DIRECTORIES: path.dirname(tmp),
          },
        },
        (err, stdout) => {
          if (err?.code === 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER' && !refs && stdout.split('\n').length > 4097) resolve(stdout);
          else if (err) reject(err);
          else resolve(stdout);
        },
      ),
    );
    const ids = new Set<string>();
    const lines = out.trimEnd().split('\n').filter(Boolean);
    if (!refs && lines.length > 4096) return { commits: [], overLimit: true };
    for (const line of lines) {
      const [id, name] = line.trimEnd().split('\t');
      // --symref emits both a symbolic description and a separate object ID for HEAD.
      if (id.startsWith('ref: ') && name === 'HEAD') continue;
      if (refs && name !== 'HEAD' && !refs.has(name)) continue;
      if (!oid.test(id)) return empty;
      ids.add(id);
    }
    const objects = await gitObjects(
      cwd,
      [...ids].map((id) => id + '^{commit}'),
    );
    const commits = objects.flatMap((object) => (object?.type === 'commit' ? [object.id] : []));
    return { commits: [...new Set(commits)].sort(), overLimit: false };
  } catch {
    return empty;
  } finally {
    await rmdir(tmp);
  }
}
