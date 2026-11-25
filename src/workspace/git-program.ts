import fs from 'node:fs';
import path from 'node:path';

// Resolve from absolute PATH entries before running a check inside a project.
let executable: string | undefined;
export function gitProgram(): string {
  if (executable) return executable;
  for (const dir of (process.env.PATH || '').split(path.delimiter)) {
    if (!path.isAbsolute(dir)) continue;
    const file = path.join(dir, process.platform === 'win32' ? 'git.exe' : 'git');
    try {
      if (!fs.statSync(file).isFile()) continue;
      fs.accessSync(file, fs.constants.X_OK);
      executable = file;
      return file;
    } catch {
      continue;
    }
  }
  throw new Error('Git could not be located.');
}
