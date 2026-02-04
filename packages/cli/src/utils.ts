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

export type PortSpec = {
  localPort: number;
  subdomain?: string;
};

export function parsePortSpec(value: string): { spec?: PortSpec; error?: string } {
  const colonIndex = value.indexOf(':');
  let portPart = value;
  let subdomainPart: string | undefined;

  if (colonIndex >= 0) {
    portPart = value.slice(0, colonIndex);
    subdomainPart = value.slice(colonIndex + 1);
    if (subdomainPart.includes(':')) {
      return { error: `Invalid port spec "${value}". Use <port> or <port>:<subdomain>.` };
    }
  }

  if (!portPart) {
    return { error: `Invalid port spec "${value}". Port is required.` };
  }

  const localPort = Number.parseInt(portPart, 10);
  if (Number.isNaN(localPort) || localPort <= 0) {
    return { error: `Invalid port "${portPart}".` };
  }

  if (subdomainPart !== undefined && subdomainPart.length === 0) {
    return { error: `Invalid port spec "${value}". Subdomain is required after ":".` };
  }

  return {
    spec: {
      localPort,
      subdomain: subdomainPart,
    },
  };
}
