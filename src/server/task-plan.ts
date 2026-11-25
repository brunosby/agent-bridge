import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import type { Conversation, TaskPlan, SpecDoc, TaskDecision, Question } from '../core/types.ts';
import { workingPaths, changedCommitPaths } from '../workspace/git-context.ts';

export async function captureTaskBaseline(owner: Conversation) {
  const baseline: TaskPlan['baseline'] = {};
  await Promise.all(
    [...new Set([owner.workDir, ...owner.team.flatMap((member) => (member.cwd ? [member.cwd] : []))])]
      .filter((dir) => owner.project[dir]?.git)
      .map(async (dir) => {
        const snapshot = await workingPaths(dir);
        if (snapshot) baseline[dir] = snapshot;
      }),
  );
  return baseline;
}
export function startPlan(seq: number, baseline: TaskPlan['baseline']): TaskPlan {
  return { seq, size: 'medium', reason: '', manual: false, classified: false, nudged: false, warned: false, baseline };
}

export async function growth(plan: TaskPlan) {
  if (plan.size !== 'small' || plan.warned) return '';
  const modules = new Set<string>();
  let count = 0;
  for (const [dir, before] of Object.entries(plan.baseline)) {
    const current = await workingPaths(dir);
    if (!current) continue;
    const dirty = new Set(before.paths);
    const files = new Set([...current.paths, ...((await changedCommitPaths(dir, before.head, current.head)) ?? [])]);
    for (const file of files) {
      if (dirty.has(file)) continue;
      count++;
      modules.add(file.includes('/') ? file.split('/')[0] : '.');
    }
  }
  return count > 8 || modules.size > 2 ? count + ' files in ' + modules.size + ' modules' : '';
}

function documents(input: unknown): SpecDoc[] {
  if (!Array.isArray(input) || !input.length || input.length > 20) throw new Error('Provide 1–20 specification documents.');
  const names = new Set<string>();
  const result: SpecDoc[] = [];
  for (const doc of input) {
    if (
      typeof doc?.path !== 'string' ||
      !/^docs\/(?:spec\/[a-z0-9][a-z0-9-]{0,95}|decisions\/\d{3,}-[a-z0-9][a-z0-9-]{0,85})\.md$/i.test(doc.path) ||
      names.has(doc.path.toLowerCase()) ||
      /\/(?:con|aux|prn|nul|com[0-9]|lpt[0-9])\.md$/i.test(doc.path)
    )
      throw new Error('Each document needs a unique Markdown path under docs/spec or docs/decisions.');
    if (typeof doc.text !== 'string' || !doc.text.trim() || doc.text.length > 64000) throw new Error('Invalid document text.');
    names.add(doc.path.toLowerCase());
    result.push({ path: doc.path, text: doc.text });
  }
  if (!result.some((doc) => doc.path.startsWith('docs/spec/'))) throw new Error('Include a specification under docs/spec/.');
  return result;
}

export function specification(agent: string, value: string): TaskDecision {
  return { kind: 'spec', id: randomUUID(), agent, docs: documents(JSON.parse(value)) };
}

export function question(agent: string, value: string): TaskDecision {
  const fields: Record<string, keyof Question> = {
    pergunta: 'question',
    question: 'question',
    opções: 'options',
    options: 'options',
    recomendação: 'recommendation',
    recommendation: 'recommendation',
    evidência: 'evidence',
    evidence: 'evidence',
  };
  const labeled: Partial<Question>[] = [];
  if (!value.trimStart().startsWith('[')) {
    for (const line of value.split(/\r?\n/).filter((l) => l.trim())) {
      const colon = line.indexOf(':');
      const key = fields[line.slice(0, colon).trim().toLowerCase()];
      if (colon < 0 || !key) throw new Error('Unknown question field.');
      const item = line.slice(colon + 1).trim();
      if (key === 'question') labeled.push({ question: item });
      else {
        const current = labeled.at(-1);
        if (!current) throw new Error('Start with a question.');
        if (key === 'options')
          current.options = item
            .split('|')
            .map((opt) => opt.trim())
            .filter(Boolean);
        else current[key] = item;
      }
    }
  }
  const input = labeled.length ? labeled : JSON.parse(value);
  if (!Array.isArray(input) || !input.length || input.length > 3) throw new Error('Provide 1–3 questions.');
  const questions = input.map((q) => {
    if (
      !q ||
      typeof q.question !== 'string' ||
      !q.question.trim() ||
      !Array.isArray(q.options) ||
      q.options.length > 8 ||
      q.options.some((v: unknown) => typeof v !== 'string') ||
      typeof q.recommendation !== 'string' ||
      typeof q.evidence !== 'string'
    )
      throw new Error('Include the question, options, recommendation and evidence.');
    return { question: q.question, options: q.options, recommendation: q.recommendation, evidence: q.evidence };
  });
  return { kind: 'question', id: randomUUID(), agent, questions };
}

/** Only create the reviewed filenames, exclusively, in real project directories. */
export function saveSpecification(root: string, draft: SpecDoc[], input: unknown) {
  const docs = documents(input);
  if (docs.length !== draft.length || docs.some((d, i) => d.path !== draft[i].path))
    throw new Error('The proposed document paths changed.');
  const base = fs.realpathSync(root);
  const created: string[] = [];
  try {
    for (const doc of docs) {
      let dir = base;
      for (const part of doc.path.split('/').slice(0, -1)) {
        dir = path.join(dir, part);
        try {
          fs.mkdirSync(dir);
        } catch (e) {
          if ((e as NodeJS.ErrnoException).code !== 'EEXIST') throw e;
        }
        if (fs.realpathSync(dir) !== dir || !fs.lstatSync(dir).isDirectory())
          throw new Error('Specification folders must be inside the project.');
      }
      const dest = path.join(base, doc.path);
      const fd = fs.openSync(dest, 'wx');
      created.push(dest);
      try {
        fs.writeFileSync(fd, doc.text);
      } finally {
        fs.closeSync(fd);
      }
    }
  } catch (error) {
    for (const file of created) fs.unlinkSync(file);
    throw error;
  }
  return docs.map((d) => d.path);
}
