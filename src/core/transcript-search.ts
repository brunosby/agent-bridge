import { parseRoleMarkers } from '../../public/js/core/role-markers.js';
import { open, realpath } from 'node:fs/promises';
import path from 'node:path';
import { parseTranscriptLine } from './history.ts';
import type { AgentSpec } from './types.ts';

interface Message {
  author: string;
  at: number | null;
  openSeq: number | null;
  text: string;
}

interface SearchCursor {
  conversationId: string;
  query: string;
  untilByte: number;
  index: number;
}

const DEFAULT_LIMIT = 20;
const MAX_LIMIT = 50;
const EXCERPT_LENGTH = 180;

function normalizeQuery(query: unknown): string {
  if (typeof query !== 'string' || !query.trim() || query.length > 200) throw new Error('enter a search query of up to 200 characters');
  return query.trim().replace(/\s+/g, ' ').toLowerCase();
}

function pageCursor(cursor: unknown, expected: SearchCursor): SearchCursor {
  if (cursor === undefined) return expected;
  if (!cursor || typeof cursor !== 'object') throw new Error('invalid saved history search cursor');
  const { conversationId, query, untilByte, index } = cursor as Partial<SearchCursor>;
  if (
    conversationId !== expected.conversationId ||
    query !== expected.query ||
    typeof untilByte !== 'number' ||
    !Number.isSafeInteger(untilByte) ||
    untilByte < 0 ||
    untilByte > expected.untilByte ||
    typeof index !== 'number' ||
    !Number.isSafeInteger(index) ||
    index < 0
  )
    throw new Error('invalid saved history search cursor');
  return { conversationId, query, untilByte, index };
}

function excerpt(text: string, matchIndex: number): string {
  const start = Math.max(0, matchIndex - 45);
  const end = start + EXCERPT_LENGTH;
  return (start ? '...' : '') + text.slice(start, end).trim() + (end < text.length ? '...' : '');
}

export async function searchSavedTranscript(
  logsDir: string,
  conversation: { id: string; runDir: string; team: AgentSpec[] },
  input: { query?: unknown; cursor?: unknown; limit?: unknown },
) {
  const query = normalizeQuery(input.query);
  const requested = input.limit ?? DEFAULT_LIMIT;
  if (typeof requested !== 'number' || !Number.isSafeInteger(requested) || requested < 1)
    throw new Error('invalid saved history search limit');
  const limit = Math.min(requested, MAX_LIMIT);
  const root = await realpath(logsDir);
  const runDir = await realpath(conversation.runDir);
  if (runDir !== path.join(root, conversation.id)) throw new Error('transcript is outside the logs directory');
  const filename = path.join(runDir, 'transcript.jsonl');
  if ((await realpath(filename)) !== filename) throw new Error('transcript is outside its expected location');
  const file = await open(filename, 'r');
  try {
    const stat = await file.stat();
    if (!stat.isFile()) throw new Error('transcript is not a file');
    const cursor = pageCursor(input.cursor, { conversationId: conversation.id, query, untilByte: stat.size, index: 0 });
    const messages: Message[] = [];
    const fragments = new Map<string, Message>();
    const authors = new Map([
      ['claude', 'Claude'],
      ['codex', 'Codex'],
      ...conversation.team.map((agent) => [agent.id, agent.name] as const),
    ]);
    if (cursor.untilByte > 0) {
      const stream = file.createReadStream({ start: 0, end: cursor.untilByte - 1, encoding: 'utf8', autoClose: false });
      let pending = '';
      for await (const chunk of stream) {
        const lines = (pending + chunk).split('\n');
        pending = lines.pop() ?? '';
        for (const line of lines) {
          const event = parseTranscriptLine(line);
          if (!event) continue;
          if (event.kind === 'state' && Array.isArray(event.team)) {
            for (const agent of event.team) {
              if (typeof agent?.id === 'string' && typeof agent.name === 'string') authors.set(agent.id, agent.name);
            }
          }
          if (typeof event.text !== 'string') continue;
          const at = typeof event.at === 'number' ? event.at : null;
          const openSeq = typeof event.seq === 'number' && Number.isSafeInteger(event.seq) ? event.seq : null;
          if (event.kind === 'user') {
            messages.push({ author: 'You', at, openSeq, text: event.text });
          } else if ((event.kind === 'delta' || event.kind === 'text') && typeof event.agent === 'string') {
            const key = JSON.stringify([event.agent, event.key]);
            let message = fragments.get(key);
            if (!message) {
              const author = authors.get(event.agent) || event.agent;
              message = { author, at, openSeq, text: '' };
              messages.push(message);
              fragments.set(key, message);
            }
            message.text = event.kind === 'delta' ? message.text + event.text : event.text;
          }
        }
      }
      // The file may be growing. Its last partial line is outside this search snapshot.
    }
    const results: (Omit<Message, 'text'> & { excerpt: string })[] = [];
    for (let index = cursor.index; index < messages.length; index += 1) {
      const { text, ...message } = messages[index];
      const normalized = (message.author === 'You' ? text : parseRoleMarkers(text).text).replace(/\s+/g, ' ').trim();
      const match = normalized.toLowerCase().indexOf(query);
      if (match < 0) continue;
      if (results.length === limit) return { results, cursor: { ...cursor, index } };
      results.push({ ...message, excerpt: excerpt(normalized, match) });
    }
    return { results, cursor: null };
  } finally {
    await file.close();
  }
}
