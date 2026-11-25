const OPEN = '[[SUMMARY]]';
const CLOSE = '[[/SUMMARY]]';

/** Read a single trailing summary outside Markdown fences. Keep all prose on malformed input.
 * @param {string} source
 * @param {boolean} [streaming]
 */
export function parseSummary(source, streaming = false) {
  if (!source.includes('[[')) return { body: source, summary: '' };
  const lines = source.split(/\r?\n/);
  const body = [];
  let start = -1;
  let end = -1;
  let invalid = false;
  let fence = '';
  for (const [i, line] of lines.entries()) {
    const token = line.trim();
    const delimiter = /^ {0,3}(`{3,}|~{3,})(.*)$/.exec(line);
    if (!fence && (token === OPEN || token === CLOSE)) {
      if (token === OPEN && start === -1) start = body.length;
      else if (token === CLOSE && start !== -1 && end === -1) end = body.length;
      else invalid = true;
      continue;
    }
    if (!fence && streaming && i === lines.length - 1 && token.startsWith('[[') && [OPEN, CLOSE].some((marker) => marker.startsWith(token)))
      continue;
    if (end !== -1 && token && token !== '[[DONE]]') invalid = true;
    if (delimiter) {
      const run = delimiter[1];
      if (!fence) fence = run;
      else if (run.startsWith(fence) && !delimiter[2].trim()) fence = '';
    }
    body.push(line);
  }
  const value = !invalid && end !== -1 ? body.slice(start, end).join('\n').trim() : '';
  if (value) {
    // Keep any trailing control line in the full message, outside the summary card.
    return { body: body.slice(0, start).concat(body.slice(end)).join('\n').trimEnd(), summary: value };
  }
  return { body: body.join('\n'), summary: '' };
}
