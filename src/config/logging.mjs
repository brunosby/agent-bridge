// --log-file: write console output to a file ourselves (shell redirection locks the file on Windows).
import path from 'node:path';
import fs from 'node:fs';
import { argv } from './args.mjs';
export function setupLogFile() {
  if (argv['log-file']) {
    const logPath = path.resolve(String(argv['log-file']));
    fs.mkdirSync(path.dirname(logPath), { recursive: true });
    const fd = fs.openSync(logPath, 'a');
    const write = (...parts) => {
      try {
        fs.writeSync(fd, `${parts.map((p) => (typeof p === 'string' ? p : p instanceof Error ? p.stack : JSON.stringify(p))).join(' ')}\n`);
      } catch {
        // never let logging break the app
      }
    };
    console.log = write;
    console.error = write;
    write(`--- ${new Date().toISOString()} start (pid ${process.pid}) ---`);
  }
}
