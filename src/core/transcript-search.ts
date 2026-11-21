import { mapMentions } from '../../public/js/core/mentions.js';
import { parseMilestoneMarkers } from '../../public/js/core/milestone-markers.js';
import { parseRoleMarkers } from '../../public/js/core/role-markers.js';
import { open, realpath } from 'node:fs/promises';
import path from 'node:path';
import { parseTranscriptLine } from './history.ts';
import { mentionLookup } from './recipients.ts';
import type { AgentIdentity, AgentSpec } from './types.ts';

interface Message {
  authorId: string | null;
  at: number | null;
  openSeq: number | null;
  text: string;
  final?: boolean;
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
  conversation: { id: string; runDir: string; team: AgentSpec[]; retiredAgents?: Map<string, AgentIdentity> },
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
    const authors = new Map<string, { id: string; name: string }>();
    if (cursor.untilByte > 0) {
      const stream = file.createReadStream({ start: 0, end: cursor.untilByte - 1, encoding: 'utf8', autoClose: false });
      let pending = '';
      for await (const chunk of stream) {
        const lines = (pending + chunk).split('\n');
        pending = lines.pop() ?? '';
        for (const line of lines) {
          const event = parseTranscriptLine(line);
          if (!event) continue;
          if (event.kind === 'state') {
            for (const members of [event.knownAgents, event.team]) {
              if (!Array.isArray(members)) continue;
              for (const member of members) {
                if (typeof member?.id === 'string' && typeof member.name === 'string') authors.set(member.id, member);
              }
            }
          }
          if (typeof event.text !== 'string') continue;
          const at = typeof event.at === 'number' ? event.at : null;
          const openSeq = typeof event.seq === 'number' && Number.isSafeInteger(event.seq) ? event.seq : null;
          if (event.kind === 'user') {
            messages.push({ authorId: null, at, openSeq, text: event.text });
          } else if ((event.kind === 'delta' || event.kind === 'text') && typeof event.agent === 'string') {
            const key = JSON.stringify([event.agent, event.key]);
            let message = fragments.get(key);
            if (!message) {
              message = { authorId: event.agent, at, openSeq, text: '' };
              messages.push(message);
              fragments.set(key, message);
            }
            if (message.final && !(event.kind === 'text' && event.final)) continue;
            message.text = event.kind === 'delta' ? message.text + event.text : event.text;
            message.final = event.kind === 'text' && Boolean(event.final);
          }
        }
      }
      // The file may be growing. Its last partial line is outside this search snapshot.
    }
    for (const member of conversation.retiredAgents?.values() || []) authors.set(member.id, member);
    for (const member of conversation.team) authors.set(member.id, member);
    const find = mentionLookup([...authors.values()]);
    const results: (Omit<Message, 'text' | 'authorId' | 'final'> & { author: string; excerpt: string })[] = [];
    for (let index = cursor.index; index < messages.length; index += 1) {
      const { text, authorId, openSeq, at } = messages[index];
      const clean = authorId === null ? text : parseRoleMarkers(parseMilestoneMarkers(text).text).text;
      const normalized = mapMentions(clean, (name: string) => {
        const member = find(name);
        return member ? '@' + member.name : undefined;
      })
        .replace(/\s+/g, ' ')
        .trim();
      const match = normalized.toLowerCase().indexOf(query);
      if (match < 0) continue;
      if (results.length === limit) return { results, cursor: { ...cursor, index } };
      const author =
        authorId === null
          ? 'You'
          : authors.get(authorId)?.name || ({ claude: 'Claude', codex: 'Codex' } as Record<string, string>)[authorId] || authorId;
      results.push({ at, openSeq, author, excerpt: excerpt(normalized, match) });
    }
    return { results, cursor: null };
  } finally {
    await file.close();
  }
}
