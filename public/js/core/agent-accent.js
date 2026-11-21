const PALETTE_SIZE = 8;

export function agentAccent(id) {
  const ordinal = /^(?:a)([1-9]\d*)$/.test(id) ? Number(id.slice(1)) : { claude: 1, codex: 2 }[id];
  if (!Number.isSafeInteger(ordinal)) return 'var(--color-text-muted)';
  if (ordinal <= PALETTE_SIZE) return 'var(--color-agent-' + ordinal + ')';
  // Spread later additions around the hue circle without recycling a finite palette.
  const hue = (ordinal * 137.50776405) % 360;
  return 'oklch(var(--agent-accent-lightness) var(--agent-accent-chroma) ' + hue.toFixed(5) + ')';
}

export function applyAgentAccent(element, id) {
  element.style.setProperty('--agent-accent', agentAccent(id));
}
