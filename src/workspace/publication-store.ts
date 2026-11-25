import os from 'node:os';
import path from 'node:path';
import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
function directory() {
  const location = path.join(
    process.env.LOCALAPPDATA || process.env.XDG_STATE_HOME || path.join(os.homedir(), '.local', 'state'),
    'agent-bridge',
    'publication',
  );
  mkdirSync(location, { recursive: true, mode: 0o700 });
  return location;
}
export function signingKey() {
  const file = path.join(directory(), 'key');
  try {
    writeFileSync(file, randomBytes(32), { flag: 'wx', mode: 0o600 });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
  }
  const key = readFileSync(file);
  if (key.length !== 32) throw new Error('Unavailable publication key.');
  return key;
}
function exceptionFile(id: string) {
  if (!/^[0-9a-f]{64}$/.test(id)) throw new Error('Invalid finding.');
  return path.join(directory(), id + '.json');
}
const reasons = ['test fixture', 'false positive'] as const;
type Reason = (typeof reasons)[number];
function validReason(value: unknown): value is Reason {
  return reasons.some((reason) => reason === value);
}
export function exceptionReason(id: string): Reason | null {
  const file = exceptionFile(id);
  try {
    const entry = JSON.parse(readFileSync(file, 'utf8'));
    return entry?.id === id && validReason(entry.reason) ? entry.reason : null;
  } catch (error) {
    if (error instanceof SyntaxError || (error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw error;
  }
}
export function allowFinding(id: string, reason: string) {
  if (!validReason(reason)) throw new Error('Choose a reason for the exception.');
  const file = exceptionFile(id);
  const pending = file + '.' + randomBytes(12).toString('hex') + '.tmp';
  writeFileSync(pending, JSON.stringify({ id, reason }), { mode: 0o600, flag: 'wx' });
  try {
    renameSync(pending, file);
  } finally {
    rmSync(pending, { force: true });
  }
}
