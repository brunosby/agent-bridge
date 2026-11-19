/** Recognize test signals from command names and npm scripts, without scanning arbitrary arguments. */
export function isTestCommand(command: string): boolean {
  let start = true;
  let npm = false;
  const tokens = command.match(/"[^"]*"|'[^']*'|&&|\|\||[|;\n]|[^\s|;&"']+/g) || [];
  for (let i = 0; i < tokens.length; i++) {
    const token = tokens[i];
    if (/^(?:&&|\|\||[|;\n])$/.test(token)) {
      start = true;
      npm = false;
      continue;
    }
    if (!start) continue;
    start = false;
    const name = token.replace(/^["']|["']$/g, '').toLowerCase();
    npm = /^npm(?:\.cmd)?$/.test(name);
    const action = tokens[i + 1]?.toLowerCase();
    const script = tokens[i + 2]?.replace(/^["']|["']$/g, '') || '';
    if (npm && (action === 'test' || (/^(?:run|run-script)$/.test(action || '') && /test|check|lint/i.test(script)))) return true;
    if (
      /^(pytest|vitest|jest)$/.test(name) ||
      (name === 'node' && action === '--test') ||
      (/^(cargo|go|dotnet)$/.test(name) && action === 'test')
    )
      return true;
  }
  return false;
}
