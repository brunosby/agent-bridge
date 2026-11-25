#!/usr/bin/env node
import { gitRead, oid, scanCommits } from '../src/workspace/publication-scan.ts';
import { remoteTips } from '../src/workspace/publication-remote.ts';
import { signingKey, exceptionReason } from '../src/workspace/publication-store.ts';
import { createInterface } from 'node:readline';
try {
  const cwd = process.cwd();
  const tips = [],
    remote = [],
    tags = [];
  let newRef = false;
  for await (const line of createInterface({ input: process.stdin })) {
    const fields = line.split(' ');
    if (fields.length !== 4 || !oid.test(fields[1]) || !oid.test(fields[3])) throw new Error();
    if (/^0+$/.test(fields[1])) continue;
    let id = fields[1];
    while ((await gitRead(cwd, ['cat-file', '-t', id])).trim() === 'tag') {
      tags.push(id);
      id = (await gitRead(cwd, ['cat-file', '-p', id])).split('\n')[0].slice(7);
      if (!oid.test(id)) throw new Error();
    }
    tips.push((await gitRead(cwd, ['rev-parse', '--verify', id + '^{commit}'])).trim());
    if (/^0+$/.test(fields[3])) newRef = true;
    else {
      try {
        remote.push((await gitRead(cwd, ['rev-parse', '--verify', fields[3] + '^{commit}'])).trim());
      } catch {
        newRef = true;
      }
    }
  }
  if (tips.length) {
    const url = process.argv[3];
    const excluded = newRef ? (url ? (await remoteTips(cwd, url, new Set())).commits : []) : remote;
    const scan = await scanCommits(cwd, tips, excluded, 'pre-push', [], signingKey(), tags);
    for (const file of scan.unexamined) console.error('Binary/LFS file not examined:', file);
    for (const hit of scan.findings.filter((hit) => !exceptionReason(hit.id))) {
      console.error(hit.rule, hit.commit, hit.file, hit.line || '');
      process.exitCode = 1;
    }
  }
} catch {
  console.error('Agent Bridge could not verify the entire publication. Push blocked.');
  process.exitCode = 1;
}
