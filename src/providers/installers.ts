import { spawn } from 'node:child_process';
import os from 'node:os';
const guides: Record<string, string> = {
  claude: 'https://code.claude.com/docs/en/setup',
  codex: 'https://developers.openai.com/codex/cli',
  opencode: 'https://opencode.ai/v1/docs/',
  git: 'https://git-scm.com/install/',
};
export function installer(id: string, platform = process.platform) {
  if (!Object.hasOwn(guides, id)) throw new Error('Unknown installation target.');
  const windows = platform === 'win32',
    unix = platform === 'linux' || platform === 'darwin';
  const commands: Record<string, string> = {
    claude: windows ? 'irm https://claude.ai/install.ps1 | iex' : 'curl -fsSL https://claude.ai/install.sh | bash',
    codex: 'npm install -g @openai/codex',
    opencode: 'npm install -g --allow-scripts=opencode-ai opencode-ai',
    git: windows ? 'winget install --id Git.Git -e --source winget' : platform === 'darwin' ? 'xcode-select --install' : '',
  };
  return {
    guide: guides[id],
    command: windows || unix ? commands[id] : '',
    shell: windows ? (id === 'claude' ? 'powershell.exe' : 'cmd.exe') : 'sh',
  };
}
/**
 * Open a visible terminal window that runs one command, for installers and sign-in.
 * On Windows the console program is started directly: a detached console process gets its own window,
 * so there is no `start` command whose first quoted argument would be read as a window title.
 */
export async function openTerminal(
  command: string,
  shell: string,
  platform = process.platform,
  launch = spawn,
  { closeOnSuccess = false } = {},
) {
  const file = platform === 'win32' ? shell : platform === 'darwin' ? 'osascript' : 'x-terminal-emulator';
  // cmd.exe does not understand backslash-escaped quotes, so its command line is passed verbatim:
  // /s removes the outer quotes and keeps a quoted executable path intact.
  const verbatim = platform === 'win32' && shell === 'cmd.exe';
  // closeOnSuccess: the window closes when the command succeeds and stays open with its error when it fails,
  // so the console process ending is the signal that the command finished.
  const args =
    platform === 'win32'
      ? verbatim
        ? closeOnSuccess
          ? ['/d', '/s', '/c', '"' + command + ' || pause"']
          : ['/d', '/s', '/k', '"' + command + '"']
        : ['-NoProfile', '-NoExit', '-Command', command]
      : platform === 'darwin'
        ? ['-e', 'tell application "Terminal" to do script ' + JSON.stringify(command)]
        : ['-e', 'sh', '-c', command + '; printf "\\nPress Enter to close..."; read answer'];
  const child = launch(file, args, {
    cwd: os.homedir(),
    detached: true,
    windowsHide: false,
    windowsVerbatimArguments: verbatim,
    stdio: 'ignore',
  });
  await new Promise<void>((resolve, reject) => {
    child.once('error', reject);
    child.once('spawn', () => {
      child.unref();
      resolve();
    });
  });
  return child;
}

export async function openInstaller(id: string, platform = process.platform, launch = spawn) {
  const { shell, command } = installer(id, platform);
  if (!command) throw new Error('Use the official installation guide for this system.');
  // Every command passed to a shell comes from the fixed installer table.
  await openTerminal(command, shell, platform, launch);
}
