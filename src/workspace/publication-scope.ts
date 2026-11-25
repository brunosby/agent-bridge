import { remoteTips, simpleRef as simple } from './publication-remote.ts';
import { redact } from '../core/secret-detection.ts';
import { projectRules } from './secret-patterns.ts';
import path from 'node:path';
import { parseStages, type ShellCommand } from '../core/read-only-shell.ts';
import { gitRead, gitObjects, oid, scanCommits } from './publication-scan.ts';

function wordsOf(command: ShellCommand) {
  const stages = parseStages(command, true);
  if (stages?.length !== 1 || /[^\S ]/.test(command.text) || /[!$\x60%\\]|2>&1/.test(command.text))
    throw new Error('Submit the publication as one command with literal arguments.');
  return [...stages[0].words];
}

export async function scanPublication(cwd: string, command: ShellCommand, key: Buffer) {
  const words = wordsOf(command);
  const program = words
    .shift()
    ?.toLowerCase()
    .replace(/\.exe$/, '');
  const extra: string[] = [];
  const sources: string[] = [];
  let remote = '',
    all = false,
    tags = false,
    followTags = false,
    deletion = false,
    fill = false;
  // Parse literal aliases as Git arguments; never run an alias to discover what it does.
  let sub = words.shift();
  const aliases: string[] = [];
  if (program === 'git') {
    while (sub === '-C' && words.length >= 2) {
      cwd = path.resolve(cwd, words.shift()!);
      sub = words.shift();
    }
    while (sub && sub !== 'push' && /^[a-z0-9][a-z0-9-]*$/i.test(sub)) {
      if (aliases.includes(sub) || aliases.length >= 8) throw new Error('Use an explicit git push command.');
      aliases.push(sub);
      const definition = (await gitRead(cwd, ['config', '--get', 'alias.' + sub])).trim();
      if (!/^[a-z0-9_.:+/-]+(?: +[a-z0-9_.:+/-]+)*$/i.test(definition)) throw new Error('Use an explicit git push command.');
      words.unshift(...definition.split(/ +/));
      sub = words.shift();
    }
  }
  let baseRef = '';
  if (program === 'git' && sub === 'push') {
    for (const word of words) {
      if (['-d', '--delete'].includes(word)) {
        deletion = true;
        continue;
      }
      if (word === '--all' || word === '--branches') {
        all = true;
        continue;
      }
      if (word === '--follow-tags') {
        followTags = true;
        continue;
      }
      if (word === '--tags') {
        tags = true;
        continue;
      }
      if (/^(?:--(?:force|force-with-lease|no-verify|set-upstream|atomic|porcelain)|-[uf]+)$/.test(word)) continue;
      if (word.startsWith('-')) throw new Error('Unknown push options. Use explicit remote and branch names.');
      if (!remote) {
        remote = word;
        continue;
      }
      sources.push(word);
    }
  } else if (program === 'gh' && sub === 'pr' && words.shift() === 'create') {
    let head = '',
      title: string | undefined,
      body: string | undefined;
    while (words.length) {
      const flag = words.shift()!;
      if (['--fill', '--fill-first', '--fill-verbose'].includes(flag)) {
        fill = true;
        continue;
      }
      if (flag === '--draft') continue;
      if (!['--head', '--title', '--body', '--base', '-H', '-t', '-b', '-B'].includes(flag) || !words.length)
        throw new Error('Use --head and explicit --title/--body or --fill for a verifiable PR.');
      const val = words.shift()!;
      if (['--head', '-H'].includes(flag)) head = val;
      if (['--base', '-B'].includes(flag)) baseRef = val;
      if (['--title', '-t'].includes(flag)) title = val;
      if (['--body', '-b'].includes(flag)) body = val;
    }
    if (!simple(head) || (baseRef && !simple(baseRef)) || (!fill && (title === undefined || body === undefined)))
      throw new Error('Provide a local --head and the final PR text.');
    sources.push(head);
    extra.push(title || '', body || '');
  } else throw new Error('Submit the push or PR as a separate command.');
  const configured = async (name: string) => (await gitRead(cwd, ['config', '--get', name]).catch(() => '')).trim();
  const branch = (await gitRead(cwd, ['symbolic-ref', '--quiet', 'HEAD']).catch(() => '')).trim().replace(/^refs\/heads\//, '');
  if (!remote)
    remote =
      (program === 'git' && branch && (await configured('branch.' + branch + '.pushRemote'))) ||
      (program === 'git' && (await configured('remote.pushDefault'))) ||
      (branch && (await configured('branch.' + branch + '.remote'))) ||
      'origin';
  const urls = simple(remote)
    ? (await gitRead(cwd, ['remote', 'get-url', '--push', '--all', remote]).catch(() => '')).trim().split('\n').filter(Boolean)
    : [remote];
  if (urls.length > 8) throw new Error('Too many publication destinations to verify.');
  const refs = new Set<string>();
  for (const spec of sources) {
    const parts = spec.replace(/^\+/, '').split(':');
    if (parts.length > 2 || (parts[1] !== undefined && !simple(parts[1])) || (parts[0] && !simple(parts[0])))
      throw new Error('Use literal branch or tag names.');
    if (parts[0] && !deletion) refs.add(program === 'gh' ? 'refs/heads/' + parts[0] : parts[0]);
  }
  const implicit = !sources.length && !all && !tags;
  if (program === 'git' && (await configured('push.recurseSubmodules')).match(/^(?:on-demand|only|true)$/i))
    throw new Error('Use separate pushes for submodules.');
  if (implicit && (await configured('remote.' + remote + '.push'))) throw new Error('Use explicit refs for a configured push mapping.');
  if (deletion && (!sources.length || all || tags)) throw new Error('Use explicit refs for deletion.');
  const booleanConfig = async (name: string) =>
    (await gitRead(cwd, ['config', '--type=bool', '--get', name]).catch(() => '')).trim() === 'true';
  if (program === 'git' && (await booleanConfig('remote.' + remote + '.mirror')))
    throw new Error('Mirror publishing requires separate verification.');
  tags ||= program === 'git' && (followTags || (await booleanConfig('push.followTags'))) && !deletion;
  let fullListing = all || tags || sources.length > 64;
  const destinationsToQuery = new Set<string>();
  if (implicit) {
    const mode = ((await configured('push.default')) || 'simple').toLowerCase();
    if (mode === 'nothing') throw new Error('Use an explicit ref for push.default=nothing.');
    if (branch && simple(branch) && ['simple', 'upstream', 'tracking', 'current'].includes(mode)) {
      const local = 'refs/heads/' + branch;
      refs.add(local);
      const upstream = await configured('branch.' + branch + '.merge');
      const upstreamRemote = await configured('branch.' + branch + '.remote');
      const usesUpstream = mode !== 'current' && (!upstreamRemote || upstreamRemote === remote);
      destinationsToQuery.add(usesUpstream && upstream.startsWith('refs/heads/') && simple(upstream) ? upstream : local);
    } else {
      // Matching and ambiguous modes keep a conservative superset of possible source branches.
      all = fullListing = true;
      refs.add('HEAD');
    }
  }
  if (all || tags) {
    const prefix = [...(all ? ['refs/heads'] : []), ...(tags ? ['refs/tags'] : [])];
    const list = (await gitRead(cwd, ['for-each-ref', '--format=%(refname)', ...prefix])).trim();
    if (list) list.split('\n').forEach((ref) => refs.add(ref));
  }
  if (refs.size > 4096) throw new Error('Too many local refs to verify. Use an explicit ref.');
  if (!fullListing && sources.length) {
    if (program === 'gh') {
      for (const name of [sources[0], baseRef].filter(Boolean)) destinationsToQuery.add('refs/heads/' + name);
    } else {
      const specs = sources.map((spec) => spec.replace(/^\+/, '').split(':'));
      const candidates = [
        ...new Set(
          specs.flatMap(([from, to]) => (from && !from.startsWith('refs/') && !to?.startsWith('refs/') ? ['refs/tags/' + from] : [])),
        ),
      ];
      const tagObjects = await gitObjects(cwd, candidates);
      const tagRefs = new Set(candidates.filter((_, i) => tagObjects[i]));
      for (const [from, to] of specs) {
        let destination = to || from;
        if (destination === 'HEAD') destination = branch;
        if (!destination) continue;
        if (!destination.startsWith('refs/')) {
          const isTag = from.startsWith('refs/tags/') || tagRefs.has('refs/tags/' + from);
          destination = (isTag ? 'refs/tags/' : 'refs/heads/') + destination;
        }
        destinationsToQuery.add(destination);
      }
    }
  }
  const tips = new Set<string>(),
    annotations = new Set<string>(),
    bindings = [];
  const ordered = [...refs].sort();
  const objects = await gitObjects(cwd, ordered);
  const peeledTags = new Map<string, string>();
  for (const [index, ref] of ordered.entries()) {
    const object = objects[index];
    if (!object || !['commit', 'tag'].includes(object.type)) throw new Error('Use a ref pointing to a commit.');
    let id = object.id;
    if (object.type === 'tag') {
      const chain: string[] = [];
      while (!peeledTags.has(id)) {
        chain.push(id);
        annotations.add(id);
        const tag = await gitRead(cwd, ['cat-file', '-p', id]);
        const target = /^object ([0-9a-f]+)\ntype (commit|tag)\n/.exec(tag);
        if (!target || !oid.test(target[1])) throw new Error('Unverified tag.');
        id = target[1];
        if (target[2] === 'commit') break;
      }
      id = peeledTags.get(id) || id;
      for (const tag of chain) peeledTags.set(tag, id);
    }
    tips.add(id);
    bindings.push([ref, object.id]);
  }
  const destinations = await Promise.all(urls.map((url) => remoteTips(cwd, url, fullListing ? null : destinationsToQuery)));
  const remoteRefLimit = destinations.some((result) => result.overLimit);
  // A tip confirmed at only one push destination cannot exclude history from the scan.
  const otherDestinations = destinations.slice(1).map(({ commits }) => new Set(commits));
  const exclude =
    !destinations.length || (program === 'gh' && (process.env.GH_REPO || urls.length !== 1))
      ? []
      : destinations[0].commits.filter((id) => otherDestinations.every((commits) => commits.has(id)));
  if (program === 'gh' && fill) {
    const messages = await gitRead(cwd, ['log', '--format=%B', ...tips, '--']);
    extra.push(messages);
    extra.push(...sources);
  }
  const scope = JSON.stringify({
    remote,
    urls,
    bindings,
    sources,
    all,
    tags,
    deletion,
    fill,
    baseRef,
    aliases,
    remoteRefLimit,
    queriedRefs: fullListing ? null : [...destinationsToQuery],
    command: command.text,
  });
  const scan = await scanCommits(cwd, [...tips], exclude, scope, extra, key, [...annotations]);
  scan.remoteRefLimit = remoteRefLimit;
  // Keep raw destinations in the signature only: URL userinfo, query strings and fragments can carry credentials.
  const display = (value: string) => {
    if (/^[a-z]+:\/\//i.test(value)) {
      try {
        const url = new URL(value);
        return url.protocol + '//' + url.host + url.pathname;
      } catch {
        return '(destination)';
      }
    }
    return value;
  };
  const root = (await gitRead(cwd, ['rev-parse', '--show-toplevel'])).trim();
  scan.scope = redact(
    JSON.stringify(
      {
        remote: display(remote),
        destinations: urls.map(display),
        refspecs: sources,
        base: baseRef || undefined,
        refs: bindings,
        commits: scan.revisions,
      },
      null,
      2,
    ),
    projectRules(root),
  );
  return scan;
}
