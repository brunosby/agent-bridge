// HTTP server: page files, live event stream (SSE) and the API endpoint.
import crypto from 'node:crypto';
import path from 'node:path';
import fs from 'node:fs';
import http, { type ServerResponse } from 'node:http';
import { APP_DIR, PUBLIC_DIR } from '../config/settings.ts';
import { logError, publish, publishState, replayHistory, snapshotLine } from './events.ts';
import { clients, S } from './state.ts';
import { serveReviewMcp } from './review-mcp.ts';
import { api } from './api.ts';
import { BodyTooLargeError, readJson } from './request-body.ts';
export const token = crypto.randomBytes(18).toString('hex');
export const SRC_DIR = path.join(APP_DIR, 'src');
export const codeHash = () => {
  const h = crypto.createHash('sha1');
  const walk = (dir: string): void => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      const p = path.join(dir, e.name);
      if (e.isDirectory()) walk(p);
      else if (/\.(mjs|ts)$/.test(e.name)) h.update(p).update(fs.readFileSync(p));
    }
  };
  walk(SRC_DIR);
  return h.digest('hex');
};
export const bootHash = codeHash();
export let warnedOutdated = false;
export const codeChanged = () => {
  try {
    return codeHash() !== bootHash;
  } catch {
    return false;
  }
};
export const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
};

export const server = http.createServer(async (req, res) => {
  let pathname = '/';
  try {
    const port = req.socket.localPort;
    const suffix = port === 80 ? '' : ':' + port;
    const host = req.headers.host?.toLowerCase();
    if (!host || !['127.0.0.1', 'localhost'].some((name) => host === name + suffix || host === name + ':' + port))
      return send(res, 403, 'forbidden');
    if (req.headers.origin !== undefined && req.headers.origin !== 'http://' + host.replace(/:80$/, '')) return send(res, 403, 'forbidden');
    const url = new URL(req.url || '/', 'http://127.0.0.1');
    pathname = url.pathname;
    if (pathname === '/mcp/review')
      return await serveReviewMcp(
        req,
        res,
        () => S.conv,
        () => readJson(req),
      );
    if (req.method === 'GET' && url.pathname === '/events') {
      if (url.searchParams.get('token') !== token) return send(res, 403, 'forbidden');
      res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive' });
      res.write(snapshotLine());
      replayHistory(res);
      clients.add(res);
      req.on('close', () => clients.delete(res));
      publishState();
      return;
    }
    if (req.method === 'POST' && url.pathname.startsWith('/api/')) {
      if (req.headers['x-bridge-token'] !== token) return send(res, 403, 'forbidden');
      const body = await readJson(req);
      return send(res, 200, JSON.stringify(await api(url.pathname.slice(5), body)), 'application/json');
    }
    if (req.method === 'GET') return serveStatic(url.pathname, res);
    send(res, 404, 'not found');
  } catch (err) {
    const e = err instanceof Error ? err : new Error(String(err));
    logError('bridge', `${req.method} ${pathname}: ${e.stack || e.message}`);
    send(res, e instanceof BodyTooLargeError ? 413 : 400, JSON.stringify({ error: e.message }), 'application/json');
  }
});

export function serveStatic(pathname: string, res: ServerResponse): void {
  const rel = pathname === '/' ? 'index.html' : pathname.slice(1);
  const file = path.resolve(PUBLIC_DIR, rel);
  if (!file.startsWith(PUBLIC_DIR + path.sep) || !fs.existsSync(file)) return send(res, 404, 'not found');
  let content = fs.readFileSync(file);
  if (rel === 'index.html') {
    content = Buffer.from(content.toString('utf8').replace('__BRIDGE_TOKEN__', token));
    if (codeChanged() && !warnedOutdated) {
      warnedOutdated = true;
      publish({
        kind: 'error',
        text: 'Agent Bridge was updated after it started, so new buttons may not work. Press Restart at the top of the page.',
      });
    }
  }
  send(res, 200, content, MIME[path.extname(file)] || 'application/octet-stream');
}

export function send(res: ServerResponse, status: number, body: string | Buffer, type = 'text/plain; charset=utf-8'): void {
  res.writeHead(status, { 'Content-Type': type, 'Cache-Control': 'no-store' });
  res.end(body);
}
