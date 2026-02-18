#!/usr/bin/env bun
import { runHttpCommand } from './commands/http';
import { getConfigPaths, loadConfigFile, mergeConfig, readEnvConfig } from './config';
import { runOnboarding } from './onboarding';
import { parseArgs, parsePortSpec, type PortSpec } from './utils';

function printUsage(): void {
  console.log(`Usage:
  auger init
  auger http <localPort...> [--server url] [--token token]
  auger http <localPort:subdomain> [--server url] [--token token]
  auger <localPort...> (alias for auger http <localPort...>)
`);
}

async function resolveConfig(flags: Record<string, string | boolean>) {
  const overrides = {
    server: typeof flags.server === 'string' ? flags.server : undefined,
    token: typeof flags.token === 'string' ? flags.token : undefined,
    wsPath: typeof flags['ws-path'] === 'string' ? (flags['ws-path'] as string) : undefined,
  };

  const { configFile } = getConfigPaths();
  const fileConfig = await loadConfigFile(configFile);
  const envConfig = readEnvConfig();
  let merged = mergeConfig(fileConfig, envConfig, overrides);

  if (!merged.serverUrl) {
    merged = mergeConfig(await runOnboarding(), envConfig, overrides);
  }

  if (!merged.token) {
    console.warn('No auth token set. If the server requires auth, connection will fail.');
  }

  return merged;
}

async function main() {
  const rawArgs = process.argv.slice(2);
  if (rawArgs.length === 0) {
    printUsage();
    process.exit(1);
  }

  if (rawArgs[0] === 'init') {
    await runOnboarding();
    console.log('Config saved.');
    return;
  }

  const isAlias = !Number.isNaN(Number.parseInt(rawArgs[0], 10));
  const args = isAlias ? ['http', ...rawArgs] : rawArgs;
  const { command, positionals, flags } = parseArgs(args);

  if (positionals.length === 0) {
    console.error('At least one local port is required.');
    printUsage();
    process.exit(1);
  }

  const config = await resolveConfig(flags);

  if (command === 'http') {
    if (flags.subdomain !== undefined) {
      console.error(
        'The --subdomain flag has been removed. Use <port>:<subdomain>, for example: auger http 3000:test'
      );
      printUsage();
      process.exit(1);
    }
    const specs: PortSpec[] = [];

    for (const value of positionals) {
      const parsed = parsePortSpec(value);
      if (parsed.error) {
        console.error(parsed.error);
        printUsage();
        process.exit(1);
      }
      if (parsed.spec) {
        specs.push(parsed.spec);
      }
    }

    const seenSubdomains = new Set<string>();
    for (const spec of specs) {
      if (!spec.subdomain) continue;
      if (seenSubdomains.has(spec.subdomain)) {
        console.error(`Subdomain "${spec.subdomain}" was provided more than once.`);
        process.exit(1);
      }
      seenSubdomains.add(spec.subdomain);
    }

    await Promise.all(
      specs.map((spec) =>
        runHttpCommand({
          localPort: spec.localPort,
          serverUrl: config.serverUrl,
          token: config.token,
          wsPath: config.wsPath || '/ws',
          subdomain: spec.subdomain,
        })
      )
    );
    return;
  }

  printUsage();
  process.exit(1);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
