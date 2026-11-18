// Paths, configuration (config.json defaults + config.local.json user changes) and the Settings schema.
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import fs from 'node:fs';
import { LOGS_DIR_NAME } from '../core/history.ts';
import { argv } from './args.ts';
import { ROUTING_MODES } from '../core/prompts.ts';
import { DEFAULT_DELETION_PATTERNS, DEFAULT_DESTRUCTIVE_PATTERNS } from '../core/safety.ts';
export const APP_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
export const PUBLIC_DIR = path.join(APP_DIR, 'public');
export let LOGS_DIR = path.join(APP_DIR, LOGS_DIR_NAME);
export const ROLES_DIR = path.join(APP_DIR, 'roles');
export const configPath = path.resolve(typeof argv.config === 'string' ? argv.config : path.join(APP_DIR, 'config.json'));
if (typeof argv.logs === 'string') LOGS_DIR = path.resolve(argv.logs);
// config.json holds the shipped defaults; what the user changes in Settings is saved to config.local.json
// next to it (ignored by git), so personal settings never end up in the repository.
export const localConfigPath = configPath.replace(/\.json$/i, '') + '.local.json';
export type Config = Record<string, any>;
export const readJsonFile = (p: string): Config => (fs.existsSync(p) ? JSON.parse(fs.readFileSync(p, 'utf8')) : {});
export let localConfig: Config = readJsonFile(localConfigPath);
export let config: Config = { ...readJsonFile(configPath), ...localConfig };

/** Save user changes: merged into config.local.json, then into the running config. */
export function saveLocalConfig(changes: Config): void {
  localConfig = { ...localConfig, ...changes };
  fs.writeFileSync(localConfigPath, JSON.stringify(localConfig, null, 2) + '\n');
  config = { ...readJsonFile(configPath), ...localConfig };
}
export const port = Number(typeof argv.port === 'string' ? argv.port : (config.port ?? 0));

export interface SettingDef {
  type: 'string' | 'enum' | 'boolean' | 'number' | 'list';
  default: unknown;
  values?: string[];
  min?: number;
}

/** Settings that the Settings screen can change (saved to config.local.json). */
export const SETTINGS: Record<string, SettingDef> = {
  userName: { type: 'string', default: 'the user' },
  routingMode: { type: 'enum', values: Object.keys(ROUTING_MODES), default: 'orchestrator' },
  autoRelay: { type: 'boolean', default: true },
  maxHops: { type: 'number', min: 0, default: 8 },
  tokenLimit: { type: 'number', min: 0, default: 0 },
  approvalTimeoutSec: { type: 'number', min: 0, default: 120 },
  bypassNewAgents: { type: 'boolean', default: false },
  warnOnExtraAgents: { type: 'boolean', default: true },
  missingRolePolicy: { type: 'enum', values: ['ask', 'closest'], default: 'ask' },
  maxReviewRounds: { type: 'number', min: 0, default: 2 },
  finalConfirmation: { type: 'boolean', default: true },
  sensitiveModelPatterns: { type: 'list', default: ['big-pickle', 'stealth', ':free', '-free'] },
  destructivePatterns: { type: 'list', default: DEFAULT_DESTRUCTIVE_PATTERNS },
  deletionPatterns: { type: 'list', default: DEFAULT_DELETION_PATTERNS },
  openBrowser: { type: 'boolean', default: true },
};
export const setting = (key: string): any => config[key] ?? SETTINGS[key].default;

export function safeRegex(p: string): RegExp | null {
  try {
    return new RegExp(p, 'i');
  } catch {
    return null;
  }
}
