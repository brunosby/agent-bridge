// Shared types of the app: agents (drivers), events, models, roles and the conversation.
import type { EventEmitter } from 'node:events';
import type { WriteStream } from 'node:fs';

export type Size = 'small' | 'medium' | 'large';
export type SpecDoc = { path: string; text: string };
export type Question = { question: string; options: string[]; recommendation: string; evidence: string };
export type TaskDecision =
  { kind: 'spec'; id: string; agent: string; docs: SpecDoc[] } | { kind: 'question'; id: string; agent: string; questions: Question[] };
export interface TaskPlan {
  seq: number;
  size: Size;
  reason: string;
  manual: boolean;
  finished?: boolean;
  classified: boolean;
  nudged: boolean;
  correctionRequested?: boolean;
  warned: boolean;
  baseline: Record<string, { head: string | null; paths: string[] }>;
  approved?: string[];
  pending?: TaskDecision;
  queuedDecisions?: TaskDecision[];
  specRequestedFrom?: string;
  /** 'manual' means the first draft still needs the user's explicit send. */
  specNeedsRetry?: boolean | 'manual';
  pendingRoutingNotices?: string[];
  awaitingSpecRevision?: boolean;
  baselineDeferred?: boolean;
  routingNotices?: string[];
}
export type Succession = { id: string; agent: string; summary: string; removed: boolean; waiting?: boolean };

export type DriverId = 'claude' | 'codex' | 'opencode' | 'fake' | 'fake-alternate';
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
  /** Context window in tokens, when the provider reports it (OpenCode). */
  contextWindow?: number | null;
}

/** Everything an agent reports goes through one event shape; `kind` says what it is. */
export interface AgentEvent {
  agent: string;
  kind: string;
  [key: string]: any;
}

export interface ProviderTaskPayloads {
  taskStarted: { taskIds: string[]; turnId?: string | null };
  inputAccepted: { taskIds: string[] };
  tasksCancelled: { taskIds: string[] };
  turnEnd: { taskIds: string[]; text: string; ok: boolean; turnId?: string | null; detail?: string; costUsd?: number };
}

export type ProviderEventArgs<K extends string> = K extends keyof ProviderTaskPayloads
  ? [data: ProviderTaskPayloads[K]]
  : [data?: Record<string, unknown>];

type TaskLifecycleKind = Exclude<keyof ProviderTaskPayloads, 'inputAccepted'>;
export type AgentTaskEvent = {
  [K in TaskLifecycleKind]: { agent: string; kind: K } & ProviderTaskPayloads[K];
}[TaskLifecycleKind];
export type TurnEnded = Extract<AgentTaskEvent, { kind: 'turnEnd' }>;

export type SpecAttempt = 'draft' | 'correction';

export interface TrackedTask {
  requestSeq?: number;
  specAttempt?: SpecAttempt;
  id: string;
  agent: string;
  from: string;
  sourceSeq: number | null;
  state: 'queued' | 'working';
  activity?: string;
}

export type TaskEvent = AgentTaskEvent | ({ kind: 'taskQueued'; state: 'queued' } & TrackedTask);

export interface RelayPart {
  requestSeq?: number;
  from: string;
  text: string;
  shortText?: string;
  sourceSeq?: number;
}

export interface DeliveryBatch {
  pending: Map<string, string>;
  results: RelayPart[];
}

export type BatchEvent =
  { kind: 'batchProgress'; agent: string; pending: string[]; text: string } | { kind: 'batchCompleted'; agents: string[] };

/** Per-provider settings from config.json (`claude`, `codex`, `opencode`, `fake`). */
export interface DriverConfig {
  command?: string;
  model?: string | null;
  effort?: string | null;
  extraArgs?: string[];
  instructions?: string | null;
  resumeSessionId?: string | null;
  resumeThreadId?: string | null;
  reviewMcp?: () => { url: string; token: string } | undefined;
  [key: string]: any;
}

/** Options given to every driver constructor. */
export interface AgentInput {
  text: string;
  taskId?: string;
}

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
  /** Allow-list mode (lean roles): only these skills may run; null = deny-list mode with skillsOff. */
  skillsOnly?: string[] | null;
}

export interface ReconfigureOptions {
  readOnly?: boolean;
  maxTurns?: number | null;
  profile?: 'full' | 'lean';
  skillsOff?: string[];
  skillsOnly?: string[] | null;
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
  isDestructive?: (input: { command?: string; cwd?: string; deletePaths?: string[] }) => Promise<string | null>;
  readonly busy: boolean;
  readonly model: string | null;
  readonly effort: string | null;
  start(): unknown;
  send(text: string, taskId?: string): unknown;
  setModel(model: string): Promise<void>;
  setEffort(effort: string | null): Promise<void>;
  reconfigure(opts: ReconfigureOptions): Promise<void>;
  respondApproval(requestId: string, decision: string, reason?: string): boolean;
  approveShellCommand?(requestId: string, command: string): boolean;
  interrupt(): Promise<void>;
  restart(): Promise<void>;
  shutdown(): Promise<void>;
  setInstructions?(text: string): void;
  syncThreadName?(): Promise<void>;
}

export type AgentClass = new (opts: AgentOptions) => Agent;

export interface Role {
  warning?: string;
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
  /** Full roles: skills switched off (names or patterns). */
  skillsOff: string[];
  /** Lean roles: the only skills allowed; everything else is blocked. */
  skillsOn?: string[];
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
  baseTokens?: number;
  baseCachedTokens?: number;
  providerChangeId?: string;
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

export interface GitSnapshot {
  head: string | null;
  branch: string | null;
  files: { path: string; status: string }[];
}

export interface RoleSuggestion {
  driver: string;
  driverLabel: string;
  model: string | null;
  modelLabel: string;
  name: string;
  bypass: boolean;
  worktree: boolean;
}

export interface RoleRecommendation {
  id: string;
  name: string;
  reason: string;
  suggestion: RoleSuggestion;
}

export type RoleDecisionEvent =
  | { kind: 'recommendRoles'; agent: string; requestId: string; roles: RoleRecommendation[] }
  | { kind: 'recommendRolesClosed' | 'needRoleClosed'; requestId: string; action: string };

export interface MilestoneDefinition {
  title: string;
  criterion: string;
}

export interface MilestoneView extends MilestoneDefinition {
  number: number;
  status: 'pending' | 'working' | 'checking' | 'waiting_for_commit' | 'blocked' | 'committed';
  detail?: string;
  commits: { workspace: string; head: string }[];
}

export type MilestoneEvent =
  | {
      kind: 'milestonePlanProposed';
      agent: string;
      requestId: string;
      milestones: MilestoneDefinition[];
      command: string;
      commandSaved: boolean;
    }
  | {
      kind: 'milestoneCommitProposed';
      agent: string;
      requestId: string;
      milestone: MilestoneView;
      message: string;
      files: { workspace: string; paths: string[] }[];
    }
  | { kind: 'milestoneDecisionClosed'; requestId: string; action: string }
  | { kind: 'milestoneProgress'; milestones: MilestoneView[] };

export type AgentIdentity = Pick<AgentSpec, 'id' | 'name' | 'driver' | 'role'>;

export interface HeldRelay {
  requestSeq?: number;
  from: string;
  parts: RelayPart[];
  targets: string[];
  sourceSeq?: number;
  kind: 'reply' | 'batch' | 'spec';
}

export interface ProviderHandoff {
  id: string;
  summary: string;
  taskIds: Set<string>;
}

export interface Conversation {
  id: string;
  runDir: string;
  transcript: WriteStream;
  workDir: string;
  routingMode: RoutingMode;
  relay: { hops: number; halted: boolean; userPaused: boolean; limitPause?: 'tokens' | 'hops' };
  plan?: TaskPlan;
  succession?: Succession;
  stoppedTasks: Set<string>;
  heldRelays: HeldRelay[];
  team: AgentSpec[];
  agents: Record<string, Agent>;
  nextAgent: number;
  retiredAgents: Map<string, AgentIdentity>;
  pendingAgentNames: Set<string>;
  rosterVersion: number;
  rosterSeen: Record<string, number>;
  pendingRoleNote: Record<string, string>;
  providerChanges: Set<string>;
  providerHandoffs: Map<string, ProviderHandoff>;
  lastSender: Record<string, string>;
  lastUserText?: string;
  project: Record<string, { initial: GitSnapshot | null; git: boolean; branch: string | null; detached: boolean }>;
  tasks: Map<string, TrackedTask>;
  testResults: string[];
  possibleTests: Map<string, string>;
  lastAnswerSeq: Record<string, number>;
  batch?: DeliveryBatch | null;
  reviewRounds?: number;
  pendingRoleRequest?: { requestId: string; roleId: string; suggestion: RoleSuggestion; resolving: boolean } | null;
  pendingRecommendation?: { requestId: string; roles: RoleRecommendation[]; resolving: boolean } | null;
  roleDecisionVersion: number;
  refusedRoles: Set<string>;
  pendingFinal?: string | null;
  /** Git fingerprints and confirmed edit signals for the latest user message. */
  changeMark?: { before: Map<string, string | null>; editTools: Map<string, string>; editedFolders: Set<string> } | null;
}
