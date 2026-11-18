/** Instructions given to each agent so it knows it is part of a live multi-agent conversation. */

export const ROUTING_MODES = {
  orchestrator: {
    label: 'Orchestrator + mentions',
    rule: 'The orchestrator delegates with @AgentName. Every other agent replies to the orchestrator only. When the orchestrator writes no @mention, its message goes to the user.',
  },
  mentions: {
    label: 'Free mentions',
    rule: 'Any agent can hand work to another with @AgentName. A reply without @mention goes back to whoever sent you the last message; if that was the user, it goes to the user.',
  },
  pipeline: {
    label: 'Fixed pipeline',
    rule: 'Agents work in the listed order. Your reply goes to the next agent in the list; the last agent answers the user.',
  },
  roundrobin: {
    label: 'Round robin',
    rule: 'Agents take turns in the listed order, in a loop, until someone ends with [[DONE]] or the hand-off limit is reached.',
  },
};

export function buildInstructions({ name, role, routingMode, workDir, userName, extra }) {
  const mode = ROUTING_MODES[routingMode] || ROUTING_MODES.orchestrator;
  const editRule =
    role?.canEdit === 'none'
      ? 'Your role does not edit files. Read, run read-only commands and report.'
      : role?.canEdit === 'tests'
        ? 'Your role edits only tests and test fixtures.'
        : 'You may edit files when your task needs it. Say which files you are taking before you change them, and never edit a file another agent has taken.';
  return [
    `You are ${name}, one of several AI agents working together on a task from ${userName}.`,
    `Shared working directory: ${workDir}`,
    `Your role: ${role?.name || 'General'}. ${role?.summary || ''}`,
    role?.instructions || '',
    editRule,
    '',
    'How the conversation works:',
    `- ${userName} watches the whole conversation live and may write to any agent at any time.`,
    `- Messages start with a header such as "[Message from ${userName}]" or "[Message from <AgentName>]".`,
    '- "[Team]" blocks list the current agents with their roles and models. Use those exact names in @mentions.',
    `- Routing: ${mode.rule}`,
    '- Write your final message for its reader: short, concrete, with file paths and what you need.',
    `- When the whole task is complete, or only ${userName} can decide something, address ${userName} directly and end with a line containing only [[DONE]]. This stops the automatic hand-offs.`,
    '- Do not use [[DONE]] just to end your own turn while work remains.',
    extra ? `\nAdditional instructions:\n${extra}` : '',
  ]
    .filter((l) => l !== '')
    .join('\n');
}

/** Short roster sent to an agent when the team changes. */
export function rosterText(team, selfId, routingMode) {
  const lines = team.map((a) => `- @${a.name}: ${a.roleName}${a.model ? `, model ${a.model}` : ''}${a.id === selfId ? ' (you)' : ''}`);
  const mode = ROUTING_MODES[routingMode] || ROUTING_MODES.orchestrator;
  return `[Team]\n${lines.join('\n')}\nRouting: ${mode.label}.`;
}
