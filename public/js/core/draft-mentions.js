import { leadingMentionTokens, mentionTokens } from './mentions.js';

function nameLookup(team) {
  const names = new Map(team.map(({ name, id }) => [name.toLowerCase(), id]));
  const ids = new Map(team.map(({ id }) => [id.toLowerCase(), id]));
  return (name) => {
    const key = name.toLowerCase();
    return ids.get(key) || (/^a\d+$/.test(key) ? undefined : names.get(key));
  };
}

export function updateDraft(previous, text, team) {
  if (previous && previous.text === text) return previous;
  const old = previous?.text || '';
  let start = 0;
  while (start < old.length && old[start] === text[start]) start++;
  let oldEnd = old.length;
  let newEnd = text.length;
  while (oldEnd > start && newEnd > start && old[oldEnd - 1] === text[newEnd - 1]) {
    oldEnd--;
    newEnd--;
  }
  const shift = newEnd - oldEnd;
  const unchanged = new Map();
  for (const binding of previous?.bindings || []) {
    if (binding.end <= start) unchanged.set(binding.start, binding);
    else if (binding.start >= oldEnd)
      unchanged.set(binding.start + shift, { ...binding, start: binding.start + shift, end: binding.end + shift });
  }
  const find = nameLookup(team);
  const bindings = mentionTokens(text).map(({ name, start, end }) => {
    const prior = unchanged.get(start);
    return prior?.end === end && prior.id ? prior : { start, end, id: find(name) || null, selected: false };
  });
  return { text, bindings };
}

export function selectDraftMention(draft, start, id) {
  return { ...draft, bindings: draft.bindings.map((binding) => (binding.start === start ? { ...binding, id, selected: true } : binding)) };
}

export function refreshSelectedMentions(draft, team) {
  const names = new Map(team.map(({ id, name }) => [id, name]));
  const changes = [];
  let shift = 0;
  const bindings = draft.bindings.map((binding) => {
    const { id, start, end, selected } = binding;
    const next = { ...binding, start: start + shift, end: end + shift };
    const name = selected && names.get(id);
    if (!name) return next;
    const label = '@' + name;
    if (draft.text.slice(start, end) === label) return next;
    changes.push({ start, end, label });
    const extra = label.length - (end - start);
    next.end += extra;
    shift += extra;
    return next;
  });
  if (!changes.length) return { draft, changes };
  let text = draft.text;
  for (const { start, end, label } of changes.toReversed()) text = text.slice(0, start) + label + text.slice(end);
  return { draft: { text, bindings }, changes };
}

export function draftForSend(draft, team, target) {
  const { text, bindings } = draft;
  const active = new Set(team.map(({ id }) => id));
  const find = nameLookup(team);
  const leading = new Set((!target || target === 'auto' ? leadingMentionTokens(text) : []).map(({ start }) => start));
  const checks = [];
  let canonical = '';
  let offset = 0;
  for (const { id, start, end, selected } of bindings) {
    const name = text.slice(start + 1, end);
    if (!id && !leading.has(start)) continue;
    if (!active.has(id) || (!selected && find(name) !== id)) {
      return { text, problem: 'Check the mention @' + name + '. Pick the intended agent or edit the mention.' };
    }
    if (!selected) checks.push({ name, id });
    canonical += text.slice(offset, start) + '@' + id;
    offset = end;
  }
  return { text: canonical + text.slice(offset), checks, problem: '' };
}
