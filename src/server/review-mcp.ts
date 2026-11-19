import type { IncomingMessage, ServerResponse } from 'node:http';
import { randomBytes, randomUUID } from 'node:crypto';
import type { Agent, Conversation } from '../core/types.ts';
import { config } from '../config/settings.ts';
import { isReviewExcluded, reviewChanges } from '../workspace/git-context.ts';

interface Review {
  id: string;
  dir: string;
  files: Set<string>;
  omitted: Set<string>;
  limit: number;
  calls: number;
}
interface Client {
  agent: Agent;
  token: string;
  allowed: () => boolean;
  ready: boolean;
  review?: Review;
}

const clients = new WeakMap<Conversation, Map<string, Client>>();
const endpoint = '/mcp/review';
let origin: string | undefined;

export function setReviewMcpPort(port: number) {
  origin = 'http://127.0.0.1:' + port;
}

export function configureReviewMcp(owner: Conversation, id: string, allowed: () => boolean) {
  if (!origin || !allowed()) return;
  const agent = owner.agents[id];
  if (!agent) return;
  let group = clients.get(owner);
  if (!group) clients.set(owner, (group = new Map()));
  const previous = group.get(id);
  const token = previous?.agent === agent ? previous.token : randomBytes(32).toString('hex');
  group.set(id, { agent, token, allowed, ready: false });
  return { url: origin + endpoint, token };
}

export function openReview(owner: Conversation, agentId: string, dir: string, files: string[], omitted: string[], limit: number) {
  const client = clients.get(owner)?.get(agentId);
  if (!client || client.agent !== owner.agents[agentId] || !client.allowed() || !client.ready) return;
  const id = randomUUID();
  client.review = { id, dir, files: new Set(files), omitted: new Set(omitted), limit, calls: 0 };
  return id;
}

export function closeReview(owner: Conversation, agentId: string) {
  const client = clients.get(owner)?.get(agentId);
  if (client) delete client.review;
}

export function revokeReviewClient(owner: Conversation, agentId: string) {
  clients.get(owner)?.delete(agentId);
}

const tool = {
  name: 'bridge_diff',
  description: 'Read the filtered Git patch for one file listed in your active Agent Bridge review.',
  annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
  inputSchema: {
    type: 'object',
    required: ['reviewId', 'path'],
    properties: { reviewId: { type: 'string' }, path: { type: 'string' } },
    additionalProperties: false,
  },
};
type Rpc = { jsonrpc?: string; id?: string | number; method?: string; params?: Record<string, unknown> };

function toolText(text: string, isError = false) {
  return { content: [{ type: 'text', text }], ...(isError ? { isError } : {}) };
}

async function readPatch(client: Client, args: unknown, current: () => boolean) {
  if (!args || typeof args !== 'object') return toolText('A review ID and file path are required.', true);
  const { reviewId, path } = args as { reviewId?: unknown; path?: unknown };
  const review = client.review;
  if (!review || reviewId !== review.id) return toolText('Review closed or unavailable.', true);
  if (++review.calls > 20) return toolText('Review quota reached. Finish using the files already inspected.', true);
  if (typeof path !== 'string' || !path || path.length > 4096) return toolText('A file path is required.', true);
  if (review.omitted.has(path) || isReviewExcluded(path, config.reviewDiffExcludePatterns))
    return toolText('Omitted because this path may contain sensitive data.', true);
  if (!review.files.has(path)) return toolText('File is outside the review list.', true);
  const changes = await reviewChanges(review.dir, config.reviewDiffExcludePatterns, path);
  if (!current() || client.review !== review) return toolText('Review closed or unavailable.', true);
  if (changes?.omittedPaths.includes(path)) return toolText('Omitted because this path may contain sensitive data.', true);
  const patch = changes?.patch;
  if (patch == null) return toolText('The filtered patch is no longer available for this file.', true);
  if (review.limit > 0 && patch.length > review.limit)
    return toolText(patch.slice(0, review.limit) + '\n(Truncated: ' + review.limit + ' of ' + patch.length + ' characters.)');
  return toolText(patch || '(No visible changes for this file.)');
}

export async function serveReviewMcp(
  req: IncomingMessage,
  res: ServerResponse,
  active: () => Conversation | null,
  read: () => Promise<unknown>,
) {
  const owner = active();
  const group = owner && clients.get(owner);
  const token = req.headers.authorization;
  const candidate = group && [...group].find(([, client]) => token === 'Bearer ' + client.token);
  if (!owner || !candidate || (req.headers.origin && req.headers.origin !== origin)) {
    res.writeHead(403).end();
    return;
  }
  const [id, client] = candidate;
  const current = () => active() === owner && group?.get(id) === client && owner.agents[id] === client.agent && client.allowed();
  if (!current()) {
    res.writeHead(403).end();
    return;
  }
  if (req.method !== 'POST') {
    res.writeHead(405, { Allow: 'POST' }).end();
    return;
  }
  const payload = await read();
  const rpc = (payload && typeof payload === 'object' && !Array.isArray(payload) ? payload : {}) as Rpc;
  const respond = (body: unknown, status = 200) =>
    res.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' }).end(JSON.stringify(body));
  const envelope = { jsonrpc: '2.0', id: rpc.id ?? null };
  if (!current()) {
    res.writeHead(403).end();
    return;
  }
  if (rpc.jsonrpc !== '2.0' || typeof rpc.method !== 'string') {
    respond({ ...envelope, error: { code: -32600, message: 'Invalid request' } }, 400);
    return;
  }
  if (rpc.id == null) {
    res.writeHead(202).end();
    return;
  }
  switch (rpc.method) {
    case 'initialize': {
      const supported = ['2025-11-25', '2025-06-18', '2025-03-26', '2024-11-05'];
      const requested = rpc.params?.protocolVersion;
      const protocolVersion = typeof requested === 'string' && supported.includes(requested) ? requested : supported[0];
      respond({
        ...envelope,
        result: { protocolVersion, capabilities: { tools: {} }, serverInfo: { name: 'agent-bridge-review', version: '1' } },
      });
      return;
    }
    case 'ping':
      respond({ ...envelope, result: {} });
      return;
    case 'tools/list':
      client.ready = true;
      respond({ ...envelope, result: { tools: [tool] } });
      return;
    case 'tools/call':
      if (rpc.params?.name === tool.name) {
        respond({ ...envelope, result: await readPatch(client, rpc.params.arguments, current) });
        return;
      }
  }
  respond({ ...envelope, error: { code: -32601, message: 'Unknown method or tool' } });
}
