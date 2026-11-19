import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, renameSync } from 'node:fs';
import { createServer } from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { configureReviewMcp, openReview, revokeReviewClient, serveReviewMcp, setReviewMcpPort } from '../src/server/review-mcp.ts';
import { reviewChanges } from '../src/workspace/git-context.ts';

test('MCP serves only the authorized, filtered file patch in the active review', async () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'bridge-review-test-'));
  const git = (...args) => execFileSync('git', args, { cwd: dir, stdio: 'ignore' });
  git('init');
  writeFileSync(path.join(dir, '.env'), 'SYNTHETIC_SECRET_123\n');
  writeFileSync(path.join(dir, 'safe.txt'), 'initial\n');
  git('add', '.');
  git('-c', 'user.name=Test', '-c', 'user.email=test@example.invalid', 'commit', '-m', 'fixture');
  renameSync(path.join(dir, '.env'), path.join(dir, 'renamed.txt'));
  const unstaged = await reviewChanges(dir, []);
  assert.ok(unstaged.omittedPaths.includes('renamed.txt'));
  assert.equal(
    unstaged.files.some((file) => file.names.includes('renamed.txt')),
    false,
  );
  git('add', '-A');
  writeFileSync(path.join(dir, 'safe.txt'), 'safe marker\n' + 'x'.repeat(500) + '\n');
  writeFileSync(path.join(dir, 'new file.txt'), 'untracked marker\n');
  const owner = { agents: { reviewer: {}, other: {} } };
  const server = createServer((req, res) =>
    serveReviewMcp(
      req,
      res,
      () => owner,
      async () => {
        let json = '';
        for await (const chunk of req) json += chunk;
        return JSON.parse(json);
      },
    ).catch(() => res.writeHead(500).end()),
  );
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  try {
    setReviewMcpPort(server.address().port);
    const reviewer = configureReviewMcp(owner, 'reviewer', () => true);
    const other = configureReviewMcp(owner, 'other', () => true);
    const send = (credential, method, params = {}, headers = {}) =>
      fetch(reviewer.url, {
        method: 'POST',
        headers: { Authorization: 'Bearer ' + credential, 'Content-Type': 'application/json', ...headers },
        body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
      });
    assert.equal((await send('wrong', 'tools/list')).status, 403);
    assert.equal((await send(reviewer.token, 'tools/list', {}, { Origin: 'https://untrusted.invalid' })).status, 403);
    const listing = await (await send(reviewer.token, 'tools/list')).json();
    assert.equal(listing.result.tools[0].name, 'bridge_diff');
    await send(other.token, 'tools/list');
    const changes = await reviewChanges(dir, []);
    const files = changes.files.flatMap((file) => file.names);
    assert.deepEqual(files.sort(), ['new file.txt', 'safe.txt']);
    const oldId = openReview(owner, 'reviewer', dir, files, changes.omittedPaths, 200);
    const active = openReview(owner, 'reviewer', dir, files, changes.omittedPaths, 200);
    const patch = async (name, id = active, token = reviewer.token) => {
      const response = await send(token, 'tools/call', { name: 'bridge_diff', arguments: { path: name, reviewId: id } });
      if (response.status !== 200) return response.status;
      return (await response.json()).result.content[0].text;
    };
    assert.match(await patch('safe.txt', oldId), /Review closed/);
    assert.match(await patch('safe.txt', active, other.token), /Review closed/);
    assert.match(await patch('.env'), /Omitted/);
    assert.match(await patch('renamed.txt'), /Omitted/);
    assert.match(await patch('outside.txt'), /outside the review list/);
    const visible = await patch('safe.txt');
    assert.match(visible, /safe marker/);
    assert.match(visible, /Truncated: 200 of /);
    assert.doesNotMatch(visible, /SYNTHETIC_SECRET/);
    assert.match(await patch('new file.txt'), /untracked marker/);
    for (let call = 0; call < 15; call++) assert.match(await patch('outside.txt'), /outside the review list/);
    assert.match(await patch('safe.txt'), /quota reached/);
    revokeReviewClient(owner, 'reviewer');
    assert.equal(await patch('safe.txt'), 403);
  } finally {
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
  }
});
