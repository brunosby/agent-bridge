/**
 * Model shown on the card: a short name for the second line and the full id for the tooltip.
 * "Default" resolves to the model the provider actually runs, when it reports one.
 */
export function modelInfo(a) {
  const models = a.models || [];
  const isDefault = !a.model || a.model === 'default';
  const selected = isDefault
    ? models.find((m) => m.value === 'default') || models.find((m) => m.isDefault)
    : models.find((m) => m.value === a.model);
  const selectedId = isDefault ? (selected?.value !== 'default' ? selected?.value : '') : a.model;
  const full = (isDefault && a.resolvedModel) || selected?.resolved || selectedId || '';
  const entry = isDefault ? models.find((m) => m.value !== 'default' && (m.value === full || m.resolved === full)) : selected;
  const label = entry?.label && !/^default\b/i.test(entry.label) ? entry.label : full;
  const short = label
    .replace(/^[^:/]+:\s+|^[^:/\s]+\/(?=\S)/, '') // "Provider: Name" or "provider/model"
    .replace(/\s*\((free|recommended)\)$/i, '')
    .trim();
  return { short, full };
}

export function matchesRole(role, m) {
  const text = `${m.value} ${m.label || ''} ${m.resolved || ''}`;
  return (role?.recommended?.patterns || []).some((p) => {
    try {
      return new RegExp(p, 'i').test(text);
    } catch {
      return false;
    }
  });
}

export function sortModels(models) {
  return models
    .filter((model) => model.value !== 'default')
    .sort(
      (a, b) =>
        Number(Boolean(a.disabled)) - Number(Boolean(b.disabled)) || Number(Boolean(b.recommended)) - Number(Boolean(a.recommended)),
    );
}

export const ACCOUNT_STATUS_TEXT = {
  ok: ['Ready', 'ok'],
  not_installed: ['Not installed', 'bad'],
  logged_out: ['Installed, not signed in', 'warn'],
  no_access: ['Signed in, no access', 'bad'],
  rate_limited: ['Usage limit reached', 'warn'],
  unknown: ['Unknown', 'warn'],
};

const labels = {
  starting: 'starting',
  switching_provider: 'switching provider',
  startup_failed: 'failed to start',
  unavailable: 'unavailable',
  logged_out: 'not signed in',
  no_access: 'no access',
  rate_limited: 'usage limit',
  waiting: 'waiting for approval',
  working: 'working',
  idle: 'idle',
};

export function describeAgent(agent) {
  const availability = agent.status?.availability || agent.account?.state || (agent.available ? 'ready' : 'unavailable');
  const activity = agent.status?.activity || (agent.waitingApproval ? 'waiting' : agent.busy ? 'working' : 'idle');
  return {
    available: availability === 'ready',
    switching: availability === 'switching_provider',
    retry: !['ready', 'starting', 'switching_provider'].includes(availability),
    label: labels[availability === 'ready' ? activity : availability] || labels.unavailable,
    activity,
  };
}

export function agentWarnings(a) {
  const warnings = [];
  const view = describeAgent(a);
  if (view.retry) {
    const reason = a.status?.reason || a.unavailableReason || a.account?.detail;
    let text = view.label.charAt(0).toUpperCase() + view.label.slice(1);
    if (reason) text += ': ' + reason;
    if (a.account?.resetsAt) text += ' until ' + new Date(a.account.resetsAt).toLocaleString();
    warnings.push(text + '. Press Retry after fixing it (Settings > Accounts).');
  }
  const current =
    a.models.find((m) => m.value === a.model) ||
    (a.model === 'default' ? a.models.find((m) => m.isDefault || m.value === a.resolvedModel) : null);
  if (current?.sensitive)
    warnings.push(
      `⚠ ${current.label || current.value} is a free/stealth model: your prompts may be used for training. Avoid sensitive code${a.role === 'orchestrator' ? ', and remember the orchestrator sees the whole task' : ''}.`,
    );
  // Research reads long pages; a smaller window fills up and OpenCode then summarises the conversation.
  if (a.role === 'researcher' && current?.contextWindow && current.contextWindow <= 200000)
    warnings.push(
      `Context window of ${Math.round(current.contextWindow / 1000)}k tokens: long pages can fill it and make the agent lose earlier findings. A model with a larger window suits research better.`,
    );
  return warnings;
}
