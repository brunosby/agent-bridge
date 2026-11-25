// --log-file: write console output to a file ourselves (shell redirection locks the file on Windows).
import { loggingPrefixes } from '../workspace/secret-patterns.ts';
import { redact } from '../core/secret-detection.ts';
import path from 'node:path';
import fs from 'node:fs';
import { argv } from './args.ts';

export function setupLogFile(): void {
  if (!argv['log-file']) return;
  const logPath = path.resolve(String(argv['log-file']));
  fs.mkdirSync(path.dirname(logPath), { recursive: true });
  const fd = fs.openSync(logPath, 'a');
  const write = (...parts: unknown[]): void => {
    try {
      fs.writeSync(
        fd,
        redact(
          parts.map((p) => (typeof p === 'string' ? p : p instanceof Error ? p.stack : JSON.stringify(p))).join(' '),
          loggingPrefixes(),
        ) + '\n',
      );
    } catch {
      // never let logging break the app
    }
  };
  console.log = write;
  console.error = write;
  write(`--- ${new Date().toISOString()} start (pid ${process.pid}) ---`);
}
