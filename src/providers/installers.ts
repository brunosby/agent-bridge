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
export async function openInstaller(id: string, platform = process.platform, launch = spawn) {
  const { shell, command } = installer(id, platform);
  if (!command) throw new Error('Use the official installation guide for this system.');
  // Every command passed to a shell comes from the fixed installer table.
  const file = platform === 'win32' ? shell : platform === 'darwin' ? 'osascript' : 'x-terminal-emulator';
  const args =
    platform === 'win32'
      ? shell === 'cmd.exe'
        ? ['/d', '/k', command]
        : ['-NoProfile', '-NoExit', '-Command', command]
      : platform === 'darwin'
        ? ['-e', 'tell application "Terminal" to do script ' + JSON.stringify(command)]
        : ['-e', 'sh', '-c', command + '; printf "\\nPress Enter to close..."; read answer'];
  const child = launch(file, args, { cwd: os.homedir(), detached: true, windowsHide: false, stdio: 'ignore' });
  await new Promise<void>((resolve, reject) => {
    child.once('error', reject);
    child.once('spawn', () => {
      child.unref();
      resolve();
    });
  });
}
