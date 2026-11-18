// Providers that can run an agent.
import type { AgentClass, DriverConfig } from '../core/types.ts';
import { ClaudeAgent } from './claude.ts';
import { CodexAgent } from './codex.ts';
import { OpenCodeAgent } from './opencode.ts';
import { config } from '../config/settings.ts';
import { FakeAgent } from './fake.ts';
export interface DriverEntry {
  label: string;
  Agent: AgentClass;
  /** Is the CLI installed? Used to grey out the provider in the Add agent form. */
  probe?: (cfg: DriverConfig) => { available: boolean; version?: string; reason?: string };
}

export const DRIVERS: Record<string, DriverEntry> = {
  claude: { label: 'Claude Code', Agent: ClaudeAgent },
  codex: { label: 'Codex', Agent: CodexAgent },
  opencode: { label: 'OpenCode', Agent: OpenCodeAgent, probe: (cfg) => OpenCodeAgent.probe(cfg) },
};
// Scripted provider for automated tests only.
if (config.enableFakeProvider) DRIVERS.fake = { label: 'Fake (tests)', Agent: FakeAgent };
