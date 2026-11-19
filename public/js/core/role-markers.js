const OPEN = '[[RECOMMEND_ROLES]]';
const CLOSE = '[[/RECOMMEND_ROLES]]';

/** @param {string} text */
export function parseRoleMarkers(text) {
  const roles = [];
  let visible = '';
  let rest = text;
  for (;;) {
    const start = rest.indexOf(OPEN);
    if (start < 0) {
      let length = Math.min(rest.length, OPEN.length - 1);
      while (length > 1 && !OPEN.startsWith(rest.slice(-length))) length -= 1;
      return { text: visible + (length > 1 ? rest.slice(0, -length) : rest), roles, incomplete: false };
    }
    visible += rest.slice(0, start);
    const end = rest.indexOf(CLOSE, start + OPEN.length);
    if (end < 0) return { text: visible, roles, incomplete: true };
    const block = rest.slice(start + OPEN.length, end);
    for (const line of block.split('\n')) {
      const match = /^\s*([a-z0-9_-]+)\s*:\s*(.+?)\s*$/i.exec(line);
      if (match) roles.push({ id: match[1].toLowerCase(), reason: match[2].slice(0, 200) });
    }
    rest = rest.slice(end + CLOSE.length);
  }
}
