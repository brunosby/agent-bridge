const OPEN = '[[MILESTONES]]';
const CLOSE = '[[/MILESTONES]]';
const DONE = '[[MILESTONE_DONE:';

/** @param {string} source */
export function parseMilestoneMarkers(source) {
  let rest = source;
  let text = '';
  let proposed = null;
  let number = null;
  let invalid = false;
  for (;;) {
    const openAt = rest.indexOf(OPEN);
    const doneAt = rest.indexOf(DONE);
    const pos = openAt < 0 ? doneAt : doneAt < 0 ? openAt : Math.min(openAt, doneAt);
    if (pos < 0) {
      const tail = rest.match(/\[\[[A-Z_]*$/)?.[0];
      if (tail && [OPEN, DONE].some((marker) => marker.startsWith(tail))) rest = rest.slice(0, -tail.length);
      return { text: text + rest, proposed, number, invalid };
    }
    text += rest.slice(0, pos);
    const start = pos === openAt ? OPEN : DONE;
    const end = start === OPEN ? CLOSE : ']]';
    const closeAt = rest.indexOf(end, pos + start.length);
    if (closeAt < 0) return { text, proposed, number, invalid: true };
    const value = rest.slice(pos + start.length, closeAt).trim();
    if (start === OPEN) {
      if (proposed) invalid = true;
      else {
        proposed = value.split(/\r?\n/).map((line, index) => {
          const item = /^\s*(\d+)\.\s*(.+?)\s*\|\s*(?:pronto quando|done when)\s*:\s*(.+?)\s*$/i.exec(line);
          return item && Number(item[1]) === index + 1 ? { title: item[2], criterion: item[3] } : null;
        });
        if (proposed.some((item) => !item)) invalid = true;
      }
    } else if (number !== null || !/^\d{1,2}$/.test(value) || Number(value) < 1) invalid = true;
    else number = Number(value);
    rest = rest.slice(closeAt + end.length);
  }
}
