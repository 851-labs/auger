#!/usr/bin/env bun
import { closeSync, openSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { runHttpCommand } from './commands/http';
import { getConfigPaths, loadConfigFile, mergeConfig, readEnvConfig } from './config';
import { runOnboarding } from './onboarding';
import {
  createDaemonId,
  ensureRuntimeDirs,
  getRuntimePaths,
  isProcessRunning,
  listDaemonRecords,
  removeDaemonRecord,
  removeDaemonRecordSync,
  saveDaemonRecord,
} from './runtime';
import { parseArgs, parsePortSpec, type PortSpec } from './utils';

function printUsage(): void {
  console.log(`Usage:
  auger init
  auger list
  auger kill <id|port>
  auger http <localPort...> [--server url] [--token token]
  auger http <localPort:subdomain> [--server url] [--token token]
  auger http <localPort...> --daemon
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

function isTruthyFlag(value: string | boolean | undefined): boolean {
  return value === true || value === 'true' || value === '1';
}

function formatSpec(spec: PortSpec): string {
  return spec.subdomain ? `${spec.localPort}:${spec.subdomain}` : `${spec.localPort}`;
}

function setupDaemonCleanup(daemonId: string): void {
  process.on('exit', () => {
    removeDaemonRecordSync(daemonId);
  });
}

async function startDaemon(specs: PortSpec[], config: { serverUrl: string; token?: string; wsPath?: string }) {
  const daemonId = createDaemonId();
  const wsPath = config.wsPath || '/ws';
  const entrypoint = process.argv[1];
  if (!entrypoint) {
    throw new Error('Unable to resolve CLI entrypoint for daemon mode.');
  }

  const workerArgs = [
    'http',
    ...specs.map(formatSpec),
    '--daemon-worker-id',
    daemonId,
  ];

  const { logsDir } = getRuntimePaths();
  await ensureRuntimeDirs();
  const logFile = `${logsDir}/${daemonId}.log`;
  const logFd = openSync(logFile, 'a');

  const child = spawn(process.execPath, [entrypoint, ...workerArgs], {
    detached: true,
    stdio: ['ignore', logFd, logFd],
    env: {
      ...process.env,
      AUGER_SERVER: config.serverUrl,
      AUGER_WS_PATH: wsPath,
      AUGER_TOKEN: config.token || '',
    },
  });

  closeSync(logFd);
  child.unref();

  if (!child.pid) {
    throw new Error('Failed to start daemon process.');
  }

  await saveDaemonRecord({
    id: daemonId,
    pid: child.pid,
    startedAt: new Date().toISOString(),
    specs,
    config: {
      serverUrl: config.serverUrl,
      wsPath,
    },
    logFile,
  });

  console.log(`Started daemon ${daemonId} (pid ${child.pid}).`);
  console.log(`Run "auger list" to view active tunnels.`);
}

async function listDaemons(): Promise<void> {
  const records = await listDaemonRecords();
  const sorted = records.sort((a, b) => b.startedAt.localeCompare(a.startedAt));
  const active: typeof sorted = [];

  for (const record of sorted) {
    if (!isProcessRunning(record.pid)) {
      await removeDaemonRecord(record.id);
      continue;
    }
    active.push(record);
  }

  if (active.length === 0) {
    console.log('No running daemon tunnels.');
    return;
  }

  for (const record of active) {
    console.log(
      `${record.id}  pid=${record.pid}  started=${new Date(record.startedAt).toLocaleString()}`
    );
    console.log(`  tunnels: ${record.specs.map(formatSpec).join(', ')}`);
    console.log(`  server: ${record.config.serverUrl} (ws path: ${record.config.wsPath || '/ws'})`);
    console.log(`  logs: ${record.logFile}`);
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

async function waitForExit(pid: number, timeoutMs: number): Promise<boolean> {
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    if (!isProcessRunning(pid)) return true;
    await sleep(100);
  }
  return !isProcessRunning(pid);
}

async function terminateProcess(pid: number): Promise<'stopped' | 'already-exited' | 'failed'> {
  if (!isProcessRunning(pid)) return 'already-exited';

  try {
    process.kill(pid, 'SIGTERM');
  } catch {
    return isProcessRunning(pid) ? 'failed' : 'already-exited';
  }

  if (await waitForExit(pid, 2000)) return 'stopped';

  try {
    process.kill(pid, 'SIGKILL');
  } catch {
    return isProcessRunning(pid) ? 'failed' : 'stopped';
  }

  return (await waitForExit(pid, 1000)) ? 'stopped' : 'failed';
}

async function killDaemon(target: string): Promise<void> {
  const records = await listDaemonRecords();
  const activeRecords = [];

  for (const record of records) {
    if (!isProcessRunning(record.pid)) {
      await removeDaemonRecord(record.id);
      continue;
    }
    activeRecords.push(record);
  }

  const byId = activeRecords.find((record) => record.id === target);
  let selected = byId;

  if (!selected) {
    const parsedPort = Number.parseInt(target, 10);
    const isPortLookup = !Number.isNaN(parsedPort) && `${parsedPort}` === target;

    if (isPortLookup) {
      const byPort = activeRecords.filter((record) =>
        record.specs.some((spec) => spec.localPort === parsedPort)
      );

      if (byPort.length > 1) {
        console.error(
          `More than one daemon matches port ${parsedPort}: ${byPort.map((record) => record.id).join(', ')}`
        );
        console.error('Use "auger kill <id>" to choose a specific daemon.');
        process.exit(1);
      }

      selected = byPort[0];
    }
  }

  if (!selected) {
    console.error(`No running daemon found for "${target}".`);
    process.exit(1);
  }

  const result = await terminateProcess(selected.pid);
  await removeDaemonRecord(selected.id);

  if (result === 'failed') {
    console.error(`Failed to stop daemon ${selected.id} (pid ${selected.pid}).`);
    process.exit(1);
  }

  const status = result === 'already-exited' ? 'was already stopped' : 'stopped';
  console.log(`Daemon ${selected.id} (${selected.specs.map(formatSpec).join(', ')}) ${status}.`);
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

  if (command === 'list') {
    await listDaemons();
    return;
  }

  if (command === 'kill') {
    if (positionals.length !== 1) {
      console.error('Provide exactly one daemon id or local port.');
      printUsage();
      process.exit(1);
    }
    await killDaemon(positionals[0]);
    return;
  }

  if (command === 'http') {
    if (positionals.length === 0) {
      console.error('At least one local port is required.');
      printUsage();
      process.exit(1);
    }

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

    const daemonMode = isTruthyFlag(flags.daemon);
    const daemonWorkerId =
      typeof flags['daemon-worker-id'] === 'string' ? flags['daemon-worker-id'] : undefined;

    if (daemonMode && daemonWorkerId) {
      console.error('Invalid daemon flags.');
      process.exit(1);
    }

    if (daemonWorkerId) {
      setupDaemonCleanup(daemonWorkerId);
    }

    const config = await resolveConfig(flags);

    if (daemonMode) {
      await startDaemon(specs, config);
      return;
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
