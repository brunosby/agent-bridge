import type { ProjectRules } from '../core/secret-detection.ts';
import { gitProgram } from './git-program.ts';
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

let activeRoot = '';
const cache = new Map<string, { version: string; rules: ProjectRules }>();
export function activateSecretPatterns(cwd: string) {
  try {
    activeRoot = execFileSync(gitProgram(), ['rev-parse', '--show-toplevel'], {
      cwd,
      encoding: 'utf8',
      windowsHide: true,
      timeout: 1500,
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
  } catch {
    activeRoot = cwd;
  }
  cache.clear();
}
export function projectRules(root: string): ProjectRules {
  const file = path.join(root, '.agent-bridge', 'secret-patterns.json');
  try {
    const stat = fs.statSync(file, { bigint: true, throwIfNoEntry: false });
    if (!stat) return {};
    if (!stat.isFile() || stat.size > 32768n) throw new Error();
    const version = String(stat.mtimeNs) + '/' + stat.size;
    const cached = cache.get(root);
    if (cached?.version === version) return cached.rules;
    const data = JSON.parse(fs.readFileSync(file, 'utf8'));
    const prefix = (p: unknown) => typeof p === 'string' && /^[A-Za-z0-9_-]{3,48}$/.test(p);
    if (
      !data ||
      typeof data !== 'object' ||
      Array.isArray(data) ||
      !Array.isArray(data.prefixes ?? []) ||
      (data.prefixes ?? []).length > 32 ||
      !(data.prefixes ?? []).every(prefix) ||
      !Array.isArray(data.rules ?? []) ||
      (data.rules ?? []).length > 32 ||
      !(data.rules ?? []).every(
        (rule: { prefix?: unknown; pathSuffix?: unknown }) =>
          rule &&
          prefix(rule.prefix) &&
          (rule.pathSuffix === undefined ||
            (typeof rule.pathSuffix === 'string' && rule.pathSuffix.length > 0 && rule.pathSuffix.length <= 200)),
      ) ||
      (data.genericAssignments !== undefined && typeof data.genericAssignments !== 'boolean')
    )
      throw new Error();
    const rules = { prefixes: data.prefixes, rules: data.rules, genericAssignments: data.genericAssignments };
    cache.set(root, { version, rules });
    return rules;
  } catch {
    throw new Error('Invalid project secret patterns.');
  }
}
export function loggingPrefixes() {
  if (!activeRoot) return {};
  try {
    return projectRules(activeRoot);
  } catch {
    return cache.get(activeRoot)?.rules || {};
  }
}
