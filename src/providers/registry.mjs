// Providers that can run an agent.
import { ClaudeAgent } from './claude.mjs';
import { CodexAgent } from './codex.mjs';
import { OpenCodeAgent } from './opencode.mjs';
import { config } from '../config/settings.mjs';
import { FakeAgent } from './fake.mjs';
export const DRIVERS = {
  claude: { label: 'Claude Code', Agent: ClaudeAgent },
  codex: { label: 'Codex', Agent: CodexAgent },
  opencode: { label: 'OpenCode', Agent: OpenCodeAgent },
};
// Scripted provider for automated tests only.
if (config.enableFakeProvider) DRIVERS.fake = { label: 'Fake (tests)', Agent: FakeAgent };
