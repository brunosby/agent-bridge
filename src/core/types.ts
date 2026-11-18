// Shared types of the app: agents (drivers), events, models, roles and the conversation.
import type { EventEmitter } from 'node:events';
import type { WriteStream } from 'node:fs';

export type DriverId = 'claude' | 'codex' | 'opencode' | 'fake';
export type RoutingMode = 'orchestrator' | 'mentions' | 'pipeline' | 'roundrobin';
export type CanEdit = 'all' | 'none' | 'tests';
export type Decision = 'accept' | 'acceptForSession' | 'decline';
export type AccountState = 'not_installed' | 'logged_out' | 'no_access' | 'rate_limited' | 'ok' | 'unknown';

/** A model an agent can use, as listed by its provider. */
export interface ModelInfo {
  value: string;
  label?: string;
  resolved?: string | null;
  description?: string;
  isDefault?: boolean;
  efforts?: string[];
  defaultEffort?: string | null;
  disabled?: boolean;
  disabledReason?: string | null;
  recommended?: boolean;
  sensitive?: boolean;
}

/** Everything an agent reports goes through one event shape; `kind` says what it is. */
export interface AgentEvent {
  agent: string;
  kind: string;
  [key: string]: any;
}

/** Per-provider settings from config.json (`claude`, `codex`, `opencode`, `fake`). */
export interface DriverConfig {
  command?: string;
  model?: string | null;
  effort?: string | null;
  extraArgs?: string[];
  instructions?: string | null;
  resumeSessionId?: string | null;
  resumeThreadId?: string | null;
  [key: string]: any;
}

/** Options given to every driver constructor. */
export interface AgentOptions {
  id?: string;
  name?: string;
  cwd: string;
  config?: DriverConfig;
  instructions?: string;
  systemPromptFile?: string;
  readOnly?: boolean;
  tokens?: number;
  cachedTokens?: number;
  maxTurns?: number | null;
  profile?: 'full' | 'lean';
  skillsOff?: string[];
}

export interface ReconfigureOptions {
  readOnly?: boolean;
  maxTurns?: number | null;
  profile?: 'full' | 'lean';
  skillsOff?: string[];
}

/** The contract every provider driver implements (Claude Code, Codex, OpenCode, fake). */
export interface Agent extends EventEmitter {
  id: string;
  name: string;
  cwd: string;
  tokens: number;
  cachedTokens: number;
  available: boolean;
  unavailableReason: string | null;
  models: ModelInfo[];
  resolvedModel: string | null;
  approvals: Map<string, unknown>;
  sessionId?: string | null;
  threadId?: string | null;
  commands?: { name: string; description: string }[];
  isDestructive?: (input: { command?: string; cwd?: string; deletePaths?: string[] }) => string | null;
  readonly busy: boolean;
  readonly model: string | null;
  readonly effort: string | null;
  start(): unknown;
  send(text: string): unknown;
  setModel(model: string): Promise<void>;
  setEffort(effort: string | null): Promise<void>;
  reconfigure(opts: ReconfigureOptions): Promise<void>;
  respondApproval(requestId: string, decision: string, reason?: string): boolean;
  interrupt(): Promise<void>;
  restart(): Promise<void>;
  shutdown(): Promise<void>;
  setInstructions?(text: string): void;
}

export type AgentClass = new (opts: AgentOptions) => Agent;

export interface Role {
  id: string;
  name: string;
  summary: string;
  canEdit: CanEdit;
  recommended: { label: string; patterns: string[] };
  instructions: string;
  fallback: string[];
  maxTurns: number | null;
  context: 'diff' | null;
  profile: 'full' | 'lean';
  skillsOff: string[];
}

export type RoleCatalog = Record<string, Role>;

/** One member of the team, as saved in the conversation log. */
export interface AgentSpec {
  id: string;
  name: string;
  driver: string;
  role: string;
  model?: string | null;
  effort?: string | null;
  bypass?: boolean;
  sessionId?: string | null;
  tokens?: number;
  cachedTokens?: number;
  cwd?: string | null;
  worktree?: { path: string; root?: string; branch: string; reused?: boolean } | null;
}

/** An event shown in the page (and saved in transcript.jsonl). */
export interface BridgeEvent {
  seq?: number;
  at?: number;
  kind: string;
  [key: string]: any;
}

export interface Conversation {
  id: string;
  runDir: string;
  transcript: WriteStream;
  workDir: string;
  routingMode: RoutingMode;
  team: AgentSpec[];
  agents: Record<string, Agent>;
  nextAgent: number;
  rosterVersion: number;
  rosterSeen: Record<string, number>;
  pendingRoleNote: Record<string, string>;
  lastSender: Record<string, string>;
  lastUserText?: string;
  batch?: { pending: Set<string>; results: { from: string; text: string }[] } | null;
  reviewRounds?: number;
  pendingRoleRequest?: { requestId: string; roleId: string } | null;
  pendingFinal?: string | null;
}
