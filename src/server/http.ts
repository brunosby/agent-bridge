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
import { redact } from '../core/secret-detection.ts';
import { loggingPrefixes } from '../workspace/secret-patterns.ts';
import { browserSession } from './browser-session.ts';
let lastOpen = 0;
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
    if (req.method === 'POST' && pathname === '/session') {
      let body;
      try {
        body = await readJson(req);
      } catch {
        return send(res, 400, 'Invalid session request');
      }
      const result = browserSession.exchange(body?.code);
      if (result.status === 409) {
        publish({
          kind: 'error',
          text:
            'A previously used opening code was presented again at ' +
            new Date().toLocaleTimeString() +
            '. If this was not you, close Agent Bridge and reopen it from its shortcut.',
        });
        return send(res, 409, JSON.stringify({ error: 'opening_code_used' }), 'application/json');
      }
      if (result.status === 403) return send(res, 403, 'forbidden');
      publish({ kind: 'system', text: 'An opening code was used at ' + new Date().toLocaleTimeString() + '.' });
      return send(res, 200, JSON.stringify({ token: result.token }), 'application/json');
    }
    if (req.method === 'POST' && pathname === '/open') {
      let key = '';
      server.emit('instance-key', (value: string) => {
        key = value;
      });
      if (!key || req.headers['x-bridge-instance'] !== key) return send(res, 403, 'forbidden');
      res.setHeader('x-bridge-instance', key);
      const remaining = 3000 - (Date.now() - lastOpen);
      if (remaining > 0) {
        res.setHeader('Retry-After', String(Math.ceil(remaining / 1000)));
        return send(res, 429, 'Opening a tab too frequently');
      }
      lastOpen = Date.now();
      browserSession.rotate();
      for (const client of clients) client.end('event: session-revoked\ndata: {}\n\n');
      clients.clear();
      server.emit('open-browser');
      return send(res, 204, '');
    }
    if (pathname === '/mcp/review')
      return await serveReviewMcp(
        req,
        res,
        () => S.conv,
        () => readJson(req),
      );
    if (req.method === 'GET' && url.pathname === '/events') {
      if (url.searchParams.get('token') !== browserSession.token) return send(res, 403, 'forbidden');
      res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive' });
      res.write(snapshotLine());
      replayHistory(res);
      clients.add(res);
      req.on('close', () => clients.delete(res));
      publishState();
      return;
    }
    if (req.method === 'POST' && url.pathname.startsWith('/api/')) {
      if (req.headers['x-bridge-token'] !== browserSession.token) return send(res, 403, 'forbidden');
      const body = await readJson(req);
      if (req.headers['x-bridge-token'] !== browserSession.token) return send(res, 403, 'forbidden');
      return send(res, 200, JSON.stringify(await api(url.pathname.slice(5), body)), 'application/json');
    }
    if (req.method === 'GET') return serveStatic(url.pathname, res);
    send(res, 404, 'not found');
  } catch (err) {
    const e = err instanceof Error ? err : new Error(String(err));
    logError('bridge', `${req.method} ${pathname}: ${e.stack || e.message}`);
    send(
      res,
      e instanceof BodyTooLargeError ? 413 : 400,
      JSON.stringify({ error: redact(e.message, loggingPrefixes()) }),
      'application/json',
    );
  }
});

export function serveStatic(pathname: string, res: ServerResponse): void {
  const rel = pathname === '/' ? 'index.html' : pathname.slice(1);
  const file = path.resolve(PUBLIC_DIR, rel);
  if (!file.startsWith(PUBLIC_DIR + path.sep) || !fs.existsSync(file)) return send(res, 404, 'not found');
  const content = fs.readFileSync(file);
  if (rel === 'index.html') {
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
