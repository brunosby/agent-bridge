// Command-line options: --name value, or --flag (true).
export type Argv = Record<string, string | true>;

export function parseArgs(list: string[]): Argv {
  const out: Argv = {};
  for (let i = 0; i < list.length; i++) {
    const a = list[i];
    if (!a.startsWith('--')) continue;
    const key = a.slice(2);
    const next = list[i + 1];
    if (next === undefined || next.startsWith('--')) out[key] = true;
    else {
      out[key] = next;
      i++;
    }
  }
  return out;
}

export const argv = parseArgs(process.argv.slice(2));
