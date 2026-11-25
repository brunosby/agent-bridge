export interface ProjectRules {
  prefixes?: string[];
  rules?: { prefix: string; pathSuffix?: string }[];
  genericAssignments?: boolean;
}
interface Rule {
  id: string;
  keywords: string[];
  pattern: RegExp;
  entropy: number;
  // Group 1 is the candidate to measure. By default redact the whole matched token.
  captureOnly?: boolean;
  exceptions?: RegExp;
}
const rules: Rule[] = [
  { id: 'Private key', keywords: ['-----BEGIN'], pattern: /(-----BEGIN (?:[A-Z0-9]+ )*PRIVATE KEY-----)/g, entropy: 0 },
  {
    id: 'GitHub token',
    keywords: ['ghp_', 'gho_', 'ghu_', 'ghs_', 'ghr_', 'github_pat_'],
    pattern: /\b(?:gh[pousr]_([A-Za-z0-9]{20,})|github_pat_([A-Za-z0-9_]{22,}))/g,
    entropy: 3,
  },
  { id: 'AWS access key', keywords: ['AKIA', 'ASIA'], pattern: /\b(?:AKIA|ASIA)([A-Z0-9]{16})\b/g, entropy: 2.5 },
  { id: 'Slack token', keywords: ['xox'], pattern: /\bxox[baprs]-([A-Za-z0-9-]{10,})/g, entropy: 2.5 },
  {
    id: 'API key',
    keywords: ['sk-', 'AIza'],
    pattern: /\b(?:sk-(?:proj-|ant-)?([A-Za-z0-9_-]{20,})|AIza([A-Za-z0-9_-]{35}))/g,
    entropy: 3,
  },
  {
    id: 'Connection password',
    keywords: ['://'],
    pattern: /\b[a-z][a-z0-9+.-]*:\/\/[^\s/:@]+:([^\s/@]+)@/gi,
    entropy: 0,
    captureOnly: true,
    exceptions: /^(?:pass(?:word)?|senha|changeme)$/i,
  },
];
const assignment: Rule = {
  id: 'Credential assignment',
  keywords: ['password', 'secret', 'token'],
  pattern: /\b(?:password|secret|token)["']?\s*[:=]\s*["']?([a-z0-9._/+=-]{12,})/gi,
  entropy: 3.5,
  captureOnly: true,
};
function entropy(value: string) {
  const counts = new Map<string, number>();
  for (const char of value) counts.set(char, (counts.get(char) || 0) + 1);
  let result = 0;
  for (const count of counts.values()) {
    const p = count / value.length;
    result -= p * Math.log2(p);
  }
  return result;
}
function example(value: string) {
  return /example$|^(?:true|false|null|xxx+|<[^>]*>|\$\{[\s\S]*\}|\$[a-z_]\w*|(.)\1+)$/i.test(value);
}
export interface SecretMatch {
  rule: string;
  value: string;
}
export function detectSecrets(text: string, config: ProjectRules = {}, file?: string): SecretMatch[] {
  const matches: SecretMatch[] = [];
  const lower = text.toLowerCase();
  for (const rule of config.genericAssignments ? [...rules, assignment] : rules) {
    if (!rule.keywords.some((k) => lower.includes(k.toLowerCase()))) continue;
    for (const m of text.matchAll(rule.pattern)) {
      const value = m[1] ?? m[2];
      if (rule.exceptions?.test(value) || example(value) || (rule.entropy && entropy(value) < rule.entropy)) continue;
      matches.push({ rule: rule.id, value: rule.captureOnly ? value : m[0] });
    }
  }
  function checkPrefix(prefix: string) {
    let pos = 0;
    while (prefix && (pos = text.indexOf(prefix, pos)) !== -1) {
      pos += prefix.length;
      const value = /^[A-Za-z0-9_.-]+/.exec(text.slice(pos))?.[0];
      if (value && !example(value)) matches.push({ rule: 'Project token', value: prefix + value });
    }
  }
  for (const prefix of config.prefixes || []) checkPrefix(prefix);
  for (const rule of config.rules || []) if (!file || !rule.pathSuffix || file.endsWith(rule.pathSuffix)) checkPrefix(rule.prefix);
  return matches;
}
export function redact(text: string, config: ProjectRules = {}): string {
  text = text.replace(/-----BEGIN ([A-Z0-9 ]*PRIVATE KEY)-----[\s\S]*?(?:-----END \1-----|$)/g, '[secret removed]');
  for (const value of new Set(detectSecrets(text, config).map((hit) => hit.value)).values())
    text = text.replaceAll(value, '[secret removed]');
  return text;
}
export function redactRecord<T>(record: T, config: ProjectRules = {}): T {
  return JSON.parse(JSON.stringify(record, (_k, value) => (typeof value === 'string' ? redact(value, config) : value)));
}
