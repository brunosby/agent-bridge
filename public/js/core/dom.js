// DOM helpers: element creation, scrolling the conversation, time and number formats, safe markdown.
export const $ = (id) => document.getElementById(id);
export const log = $('log');

export function nearBottom() {
  return log.scrollHeight - log.scrollTop - log.clientHeight < 120;
}
export function append(el) {
  const stick = nearBottom();
  log.appendChild(el);
  if (stick) log.scrollTop = log.scrollHeight;
}
export function keepScrolled(fn) {
  const stick = nearBottom();
  fn();
  if (stick) log.scrollTop = log.scrollHeight;
}
export function h(tag, cls, text) {
  const el = document.createElement(tag);
  if (cls) el.className = cls;
  if (text !== undefined) el.textContent = text;
  return el;
}
export function time(at) {
  return new Date(at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });
}
export function fmtTokens(n) {
  if (!n) return '0';
  return n >= 1e6 ? `${(n / 1e6).toFixed(1)}M` : n >= 1e3 ? `${(n / 1e3).toFixed(1)}k` : String(n);
}
export function closeDialog(id) {
  $(id).close();
}

/**
 * Minimal, safe markdown: fenced code, inline code, bold. Everything else is plain text.
 * With findAgent (name -> { name, driver, role } or null), @mentions of team members become coloured
 * chips, and each line that mentions one is highlighted, so hand-offs stand out ("who got which task").
 * A line that opens by addressing an agent by name ("Codex, please review...") is highlighted too.
 */
export function renderMarkdown(container, text, findAgent = null) {
  container.textContent = '';
  const parts = text.split(/```/);
  parts.forEach((part, i) => {
    if (i % 2 === 1) {
      const nl = part.indexOf('\n');
      const code = nl >= 0 ? part.slice(nl + 1) : part;
      const pre = h('pre');
      pre.appendChild(h('code', null, code.replace(/\n$/, '')));
      container.appendChild(pre);
      return;
    }
    if (!part.trim()) return;
    const p = h('p');
    const lines = part.replace(/^\n+|\n+$/g, '').split('\n');
    lines.forEach((line, n) => {
      const first = findAgent ? firstMention(line, findAgent) : null;
      if (first) {
        // A line that hands something to an agent: shown as a block in that agent's colour.
        const block = h('span', 'delegation');
        block.style.setProperty('--accent', `var(--color-${first.driver}, var(--color-text-muted))`);
        block.title = `For ${first.name}${first.role ? ` (${first.role})` : ''}`;
        const lead = first.addressed ? { word: first.addressed, agent: first, done: false } : null;
        appendInline(block, line, findAgent, lead);
        p.appendChild(block);
      } else {
        appendInline(p, line, findAgent);
        // Blocks break the line themselves; only plain lines need the newline.
        const nextIsBlock = n + 1 < lines.length && findAgent && firstMention(lines[n + 1], findAgent);
        if (n + 1 < lines.length && !nextIsBlock) p.appendChild(document.createTextNode('\n'));
      }
    });
    container.appendChild(p);
  });
}

const MENTION = /(@[\p{L}\p{N}_.-]*[\p{L}\p{N}_])/u;

// "Codex, ..." / "**Codex-Coder:** ..." / "- Codex, ...": a line that opens by addressing someone.
const ADDRESS = /^\s*(?:[-*]\s+|\d+[.)]\s+)?(?:\*\*)?([\p{L}\p{N}_.-]*[\p{L}\p{N}_])(?:\*\*)?\s*[,:]/u;

function firstMention(line, findAgent) {
  for (const seg of line.split(MENTION)) if (seg.startsWith('@') && findAgent(seg.slice(1))) return findAgent(seg.slice(1));
  const m = ADDRESS.exec(line);
  const agent = m ? findAgent(m[1], true) : null;
  return agent ? { ...agent, addressed: m[1] } : null;
}

function appendInline(parent, text, findAgent, lead = null) {
  for (const seg of text.split(/(`[^`\n]+`|\*\*[^*\n]+\*\*)/)) {
    if (!seg) continue;
    if (seg.startsWith('`') && seg.endsWith('`') && seg.length > 1) parent.appendChild(h('code', null, seg.slice(1, -1)));
    else if (seg.startsWith('**') && seg.endsWith('**') && seg.length > 3) {
      const strong = h('strong');
      appendMentions(strong, seg.slice(2, -2), findAgent, lead);
      parent.appendChild(strong);
    } else appendMentions(parent, seg, findAgent, lead);
  }
}

function chipFor(text, agent) {
  const chip = h('span', 'mention', text);
  chip.style.setProperty('--accent', `var(--color-${agent.driver}, var(--color-text-muted))`);
  chip.title = `${agent.name}${agent.role ? ` (${agent.role})` : ''}`;
  return chip;
}

function appendMentions(parent, text, findAgent, lead = null) {
  if (!findAgent) {
    parent.appendChild(document.createTextNode(text));
    return;
  }
  if (lead && !lead.done) {
    // The addressed name at the start of the line becomes a chip (once), without an @.
    const i = text.indexOf(lead.word);
    if (
      i >= 0 &&
      !text
        .slice(0, i)
        .trim()
        .replace(/^([-*]|\d+[.)])$/, '')
    ) {
      lead.done = true;
      if (i) parent.appendChild(document.createTextNode(text.slice(0, i)));
      parent.appendChild(chipFor(lead.word, lead.agent));
      appendMentions(parent, text.slice(i + lead.word.length), findAgent);
      return;
    }
  }
  for (const seg of text.split(MENTION)) {
    if (!seg) continue;
    const agent = seg.startsWith('@') ? findAgent(seg.slice(1)) : null;
    if (!agent) {
      parent.appendChild(document.createTextNode(seg));
      continue;
    }
    parent.appendChild(chipFor(seg, agent));
  }
}
