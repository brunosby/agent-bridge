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

/** Minimal, safe markdown: fenced code, inline code, bold. Everything else is plain text. */
export function renderMarkdown(container, text) {
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
    for (const seg of part.replace(/^\n+|\n+$/g, '').split(/(`[^`\n]+`|\*\*[^*\n]+\*\*)/)) {
      if (!seg) continue;
      if (seg.startsWith('`') && seg.endsWith('`') && seg.length > 1) p.appendChild(h('code', null, seg.slice(1, -1)));
      else if (seg.startsWith('**') && seg.endsWith('**') && seg.length > 3) p.appendChild(h('strong', null, seg.slice(2, -2)));
      else p.appendChild(document.createTextNode(seg));
    }
    container.appendChild(p);
  });
}
