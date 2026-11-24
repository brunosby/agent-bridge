import { applyAgentAccent } from './agent-accent.js';
import { mentionTokens } from './mentions.js';
// DOM helpers: element creation, scrolling the conversation, time and number formats, safe markdown.
export const $ = (id) => document.getElementById(id);
export const log = $('log');

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
 * Small, safe markdown renderer (DOM nodes only, never HTML strings). Blocks: fenced code, headings,
 * lists, quotes, rules, tables and paragraphs. Inline: code, bold, italic and http(s) links.
 * Inline code is matched first, so markdown characters inside it (`**`, `|`, `_`) stay literal and
 * never break the formatting around it. Recognized @mentions in prose are displayed as colored chips.
 */
export function renderMarkdown(container, text, findAgent = null) {
  container.textContent = '';
  const parts = String(text).split(/```/);
  parts.forEach((part, i) => {
    if (i % 2 === 1) {
      const nl = part.indexOf('\n');
      const code = nl >= 0 ? part.slice(nl + 1) : part;
      const pre = h('pre');
      pre.appendChild(h('code', null, code.replace(/\n$/, '')));
      container.appendChild(pre);
      return;
    }
    for (const block of markdownBlocks(part)) container.appendChild(renderBlock(block, findAgent));
  });
}

/** Cells of one table row, split on unescaped pipes outside inline code. */
function tableCells(line) {
  const cells = [];
  let cell = '';
  let code = false;
  const body = line.trim().replace(/^\|/, '').replace(/\|$/, '');
  for (let i = 0; i < body.length; i++) {
    const char = body[i];
    if (char === '\\' && body[i + 1] === '|') {
      cell += '|';
      i++;
    } else if (char === '`') {
      code = !code;
      cell += char;
    } else if (char === '|' && !code) {
      cells.push(cell.trim());
      cell = '';
    } else cell += char;
  }
  cells.push(cell.trim());
  return cells;
}

const TABLE_RULE = /^\s*\|?\s*:?-{3,}:?\s*(\|\s*:?-{3,}:?\s*)*\|?\s*$/;
const HEADING = /^\s{0,3}(#{1,6})\s+(.*?)\s*#*\s*$/;
const RULE = /^\s{0,3}([-*_])(\s*\1){2,}\s*$/;
const LIST_ITEM = /^(\s*)([-*+]|\d{1,9}[.)])\s+(.*)$/;
const QUOTE = /^\s{0,3}>\s?(.*)$/;

/** Split text (outside fenced code) into blocks. Unknown lines become paragraphs. */
function markdownBlocks(text) {
  const lines = text.split('\n');
  const blocks = [];
  let paragraph = [];
  const endParagraph = () => {
    if (paragraph.some((line) => line.trim())) blocks.push({ type: 'p', text: paragraph.join('\n').replace(/^\n+|\n+$/g, '') });
    paragraph = [];
  };
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (!line.trim()) {
      endParagraph();
      continue;
    }
    if (line.trim().startsWith('|') && TABLE_RULE.test(lines[i + 1] || '') && lines[i + 1].includes('|')) {
      endParagraph();
      const rows = [tableCells(line)];
      let j = i + 2;
      while (j < lines.length && lines[j].trim().startsWith('|')) rows.push(tableCells(lines[j++]));
      blocks.push({ type: 'table', rows });
      i = j - 1;
      continue;
    }
    const heading = HEADING.exec(line);
    if (heading) {
      endParagraph();
      blocks.push({ type: 'heading', level: heading[1].length, text: heading[2] });
      continue;
    }
    if (RULE.test(line)) {
      endParagraph();
      blocks.push({ type: 'rule' });
      continue;
    }
    const item = LIST_ITEM.exec(line);
    if (item && (!paragraph.length || !paragraph.some((l) => l.trim()))) {
      endParagraph();
      const ordered = /\d/.test(item[2]);
      const items = [];
      let j = i;
      for (; j < lines.length; j++) {
        const next = LIST_ITEM.exec(lines[j]);
        if (next && /\d/.test(next[2]) === ordered) {
          items.push({ depth: Math.min(3, Math.floor(next[1].replace(/\t/g, '  ').length / 2)), text: next[3] });
        } else if (items.length && lines[j].trim() && /^\s+/.test(lines[j]) && !LIST_ITEM.test(lines[j])) {
          items[items.length - 1].text += '\n' + lines[j].trim();
        } else break;
      }
      blocks.push({ type: 'list', ordered, start: ordered ? parseInt(item[2], 10) : 1, items });
      i = j - 1;
      continue;
    }
    const quote = QUOTE.exec(line);
    if (quote) {
      endParagraph();
      const quoted = [];
      let j = i;
      for (; j < lines.length; j++) {
        const next = QUOTE.exec(lines[j]);
        if (!next) break;
        quoted.push(next[1]);
      }
      blocks.push({ type: 'quote', text: quoted.join('\n') });
      i = j - 1;
      continue;
    }
    paragraph.push(line);
  }
  endParagraph();
  return blocks;
}

function renderBlock(block, findAgent) {
  if (block.type === 'table') return renderTable(block.rows, findAgent);
  if (block.type === 'rule') return h('hr');
  if (block.type === 'heading') {
    const heading = h('h' + Math.min(6, block.level + 2), 'md-heading');
    appendInline(heading, block.text, findAgent);
    return heading;
  }
  if (block.type === 'list') {
    const list = h(block.ordered ? 'ol' : 'ul');
    if (block.ordered && block.start !== 1) list.start = block.start;
    for (const { depth, text } of block.items) {
      const li = h('li');
      if (depth) li.style.marginInlineStart = depth * 1.25 + 'em';
      appendInline(li, text, findAgent);
      list.appendChild(li);
    }
    return list;
  }
  if (block.type === 'quote') {
    const quote = h('blockquote');
    for (const inner of markdownBlocks(block.text)) quote.appendChild(renderBlock(inner, findAgent));
    return quote;
  }
  const p = h('p');
  appendInline(p, block.text, findAgent);
  return p;
}

function renderTable([header, ...rows], findAgent) {
  const wrap = h('div', 'md-table');
  const table = h('table');
  const head = h('thead');
  const headRow = h('tr');
  for (const cell of header) {
    const th = h('th');
    appendInline(th, cell, findAgent);
    headRow.appendChild(th);
  }
  head.appendChild(headRow);
  const body = h('tbody');
  for (const row of rows) {
    const tr = h('tr');
    for (let i = 0; i < header.length; i++) {
      const td = h('td');
      appendInline(td, row[i] || '', findAgent);
      tr.appendChild(td);
    }
    body.appendChild(tr);
  }
  table.append(head, body);
  wrap.appendChild(table);
  return wrap;
}

const INLINE = [
  // Code first: its content is never parsed again.
  { re: /^(`+)(?!`)([\s\S]*?[^`])\1(?!`)/, make: (m) => h('code', null, m[2].replace(/^ (.*) $/s, '$1')) },
  { re: /^\*\*(?=\S)([\s\S]*?\S)\*\*(?!\*)/, tag: 'strong', inner: 1 },
  { re: /^__(?=\S)([\s\S]*?\S)__(?![\w])/, tag: 'strong', inner: 1, word: true },
  { re: /^~~(?=\S)([\s\S]*?\S)~~/, tag: 's', inner: 1 },
  { re: /^\*(?=[^\s*])([^*\n]*?[^\s*])\*(?!\*)/, tag: 'em', inner: 1 },
  { re: /^_(?=[^\s_])([^_\n]*?[^\s_])_(?![\w])/, tag: 'em', inner: 1, word: true },
  { re: /^\[([^\]\n]+)\]\((https?:\/\/[^\s)]+)\)/, link: true },
];

/** Inline markdown; a delimiter inside a code span (or a word, for `_`) is plain text. */
export function appendInline(parent, text, findAgent) {
  let plain = '';
  const flush = () => {
    if (plain) appendMentions(parent, plain, findAgent);
    plain = '';
  };
  for (let i = 0; i < text.length;) {
    const rest = text.slice(i);
    let matched = false;
    if ('`*_~['.includes(text[i]))
      for (const rule of INLINE) {
        if (rule.word && /\w/.test(text[i - 1] || '')) continue;
        const m = rule.re.exec(rest);
        // Bold or italic must not end inside a code span (`**a `**` b**` keeps the code whole).
        if (!m || (rule.inner && hasOpenCode(m[rule.inner]))) continue;
        flush();
        if (rule.make) parent.appendChild(rule.make(m));
        else if (rule.link) {
          const a = h('a');
          a.href = m[2];
          a.target = '_blank';
          a.rel = 'noopener noreferrer';
          appendInline(a, m[1], findAgent);
          parent.appendChild(a);
        } else {
          const el = h(rule.tag);
          appendInline(el, m[rule.inner], findAgent);
          parent.appendChild(el);
        }
        i += m[0].length;
        matched = true;
        break;
      }
    if (!matched) plain += text[i++];
  }
  flush();
}

/** True when the text has an unclosed backtick run (the delimiter would cut a code span). */
function hasOpenCode(text) {
  let open = null;
  for (const run of text.match(/`+/g) || []) {
    if (open === null) open = run;
    else if (run === open) open = null;
  }
  return open !== null;
}

function chipFor(agent) {
  const chip = h('span', 'mention', '@' + agent.name + (agent.removed ? ' (removed)' : ''));
  applyAgentAccent(chip, agent.removed ? null : agent.id);
  chip.title = [agent.name, agent.role, agent.removed ? 'Removed from the conversation' : null].filter(Boolean).join(' \u00b7 ');
  return chip;
}

export function appendMentions(parent, text, findAgent) {
  let offset = 0;
  if (findAgent) {
    for (const { name, start, end } of mentionTokens(text)) {
      const agent = findAgent(name);
      if (!agent) continue;
      if (start > offset) parent.appendChild(document.createTextNode(text.slice(offset, start)));
      parent.appendChild(chipFor(agent));
      offset = end;
    }
  }
  if (offset < text.length) parent.appendChild(document.createTextNode(text.slice(offset)));
}
