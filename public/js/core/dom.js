// DOM helpers: element creation, scrolling the conversation, time and number formats, safe markdown.
export const $ = (id) => document.getElementById(id);
export const log = $('log');

export function nearBottom() {
  return log.scrollHeight - log.scrollTop - log.clientHeight < 120;
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
 * Recognized @mentions in prose are displayed as colored chips.
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
    appendInline(p, part.replace(/^\n+|\n+$/g, ''), findAgent);
    container.appendChild(p);
  });
}

const MENTION = /(@[\p{L}\p{N}_.-]*[\p{L}\p{N}_])/u;

function appendInline(parent, text, findAgent) {
  for (const seg of text.split(/(`[^`\n]+`|\*\*[^*\n]+\*\*)/)) {
    if (!seg) continue;
    if (seg.startsWith('`') && seg.endsWith('`') && seg.length > 1) parent.appendChild(h('code', null, seg.slice(1, -1)));
    else if (seg.startsWith('**') && seg.endsWith('**') && seg.length > 3) {
      const strong = h('strong');
      appendMentions(strong, seg.slice(2, -2), findAgent);
      parent.appendChild(strong);
    } else appendMentions(parent, seg, findAgent);
  }
}

function chipFor(text, agent) {
  const chip = h('span', 'mention', text);
  chip.style.setProperty('--accent', `var(--color-${agent.driver}, var(--color-text-muted))`);
  chip.title = `${agent.name}${agent.role ? ` (${agent.role})` : ''}`;
  return chip;
}

function appendMentions(parent, text, findAgent) {
  if (!findAgent) {
    parent.appendChild(document.createTextNode(text));
    return;
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
