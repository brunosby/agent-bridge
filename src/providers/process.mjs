import { spawn, execFile } from 'node:child_process';
import readline from 'node:readline';

/**
 * Spawn a child process that speaks newline-delimited JSON on stdout.
 * Calls onMessage for every parsed line and onText for non-JSON lines.
 */
export function spawnJsonl(command, args, { cwd, shell = false, onMessage, onText, onStderr, onExit }) {
  const child = spawn(command, args, {
    cwd,
    shell,
    windowsHide: true,
    stdio: ['pipe', 'pipe', 'pipe'],
    env: process.env,
  });
  child.stdout.setEncoding('utf8');
  child.stderr.setEncoding('utf8');
  const rl = readline.createInterface({ input: child.stdout });
  rl.on('line', (line) => {
    if (!line.trim()) return;
    let msg;
    try {
      msg = JSON.parse(line);
    } catch {
      onText?.(line);
      return;
    }
    try {
      onMessage(msg);
    } catch (err) {
      onStderr?.(`handler error: ${err.stack || err}`);
    }
  });
  child.stderr.on('data', (d) => onStderr?.(d));
  child.stdin.on('error', (err) => onStderr?.(`stdin error: ${err.message}`));
  child.on('error', (err) => onStderr?.(`process error: ${err.message}`));
  child.on('exit', (code, signal) => onExit?.(code, signal));
  return {
    child,
    write(obj) {
      if (child.exitCode === null && child.stdin.writable) child.stdin.write(JSON.stringify(obj) + '\n');
    },
    kill() {
      return killTree(child);
    },
  };
}

/** Kill a process and its children (needed on Windows when a .cmd shim is used). */
export function killTree(child) {
  return new Promise((resolve) => {
    if (!child || child.exitCode !== null || child.signalCode !== null) return resolve();
    const timer = setTimeout(resolve, 5000);
    child.once('exit', () => {
      clearTimeout(timer);
      resolve();
    });
    if (process.platform === 'win32') execFile('taskkill', ['/PID', String(child.pid), '/T', '/F'], () => {});
    else child.kill('SIGTERM');
  });
}
