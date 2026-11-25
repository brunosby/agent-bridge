/** Control blocks occupy their own lines. Fenced examples remain ordinary chat text. */
export function workflowMarkers(source) {
  const blocks = [];
  if (!source.includes('[[')) return { text: source, blocks };
  const visible = [];
  let current = null;
  let fence = '';
  for (const line of source.split(/\r?\n/)) {
    const token = line.trim();
    if (current) {
      if (token === '[[/' + current.kind + ']]') {
        blocks.push({ kind: current.kind, size: current.size, value: current.lines.join('\n').trim() });
        current = null;
      } else current.lines.push(line);
      continue;
    }
    const marker = !fence && /^\[\[(?:SIZE:\s*(small|medium|large)|(QUESTION|SPEC))\]\]$/i.exec(token);
    if (marker) {
      current = { kind: marker[2]?.toUpperCase() || 'SIZE', size: marker[1]?.toLowerCase(), lines: [] };
      continue;
    }
    const run = /^ {0,3}(`{3,}|~{3,})(.*)$/.exec(line);
    if (run && !fence) fence = run[1];
    else if (run && run[1].startsWith(fence) && !run[2].trim()) fence = '';
    visible.push(line);
  }
  return { text: visible.join('\n'), blocks };
}
