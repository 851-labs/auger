export type ParsedArgs = {
  command: string;
  positionals: string[];
  flags: Record<string, string | boolean>;
};

export function parseArgs(argv: string[]): ParsedArgs {
  const [command = '', ...rest] = argv;
  const positionals: string[] = [];
  const flags: Record<string, string | boolean> = {};

  for (let i = 0; i < rest.length; i += 1) {
    const arg = rest[i];
    if (arg.startsWith('--')) {
      const key = arg.slice(2);
      const next = rest[i + 1];
      if (next && !next.startsWith('--')) {
        flags[key] = next;
        i += 1;
      } else {
        flags[key] = true;
      }
    } else {
      positionals.push(arg);
    }
  }

  return { command, positionals, flags };
}

export function buildWsUrl(serverUrl: string, wsPath: string): string {
  const base = new URL(serverUrl);
  const wsUrl = new URL(wsPath, base);
  if (wsUrl.protocol === 'http:') wsUrl.protocol = 'ws:';
  if (wsUrl.protocol === 'https:') wsUrl.protocol = 'wss:';
  return wsUrl.toString();
}

export function getNumber(value: string | undefined): number | null {
  if (!value) return null;
  const parsed = Number.parseInt(value, 10);
  return Number.isNaN(parsed) ? null : parsed;
}
