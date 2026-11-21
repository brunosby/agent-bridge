const SYNTAX = /`+|\n|@[\w-]*/g;
const WORD = /[\p{L}\p{N}_]/u;
const EMBEDDED = /[\p{L}\p{N}_@./\\+%=-]/u;

export function mapMentions(text, visit) {
  let code = 0;
  let offset = 0;
  let result = '';
  for (const match of text.matchAll(SYNTAX)) {
    const token = match[0];
    const start = match.index;
    const end = start + token.length;
    const previous = text[start - 1] || '';
    result += text.slice(offset, start);
    const opening = token[0] === '`';
    const mention = token[0] === '@' && !code && !EMBEDDED.test(previous);
    if (opening) {
      if (!code) code = token.length;
      else if (token.length === code || (code >= 3 && token.length > code)) code = 0;
    } else if (token === '\n' && code < 3) {
      code = 0;
    }
    const next = text[end] || '';
    const literal = next === '/' || WORD.test(next) || (next === '.' && WORD.test(text[end + 1] || ''));
    result += mention && token.length > 1 && !literal ? (visit(token.slice(1), start, end) ?? token) : token;
    offset = end;
  }
  return result + text.slice(offset);
}

export function mentionTokens(text) {
  const tokens = [];
  mapMentions(text, (name, start, end) => {
    tokens.push({ name, start, end });
  });
  return tokens;
}

export function leadingMentionTokens(text) {
  const leading = [];
  let end = 0;
  for (const token of mentionTokens(text)) {
    if (!/^[\s,:]*$/.test(text.slice(end, token.start))) break;
    leading.push(token);
    end = token.end;
  }
  return leading;
}
