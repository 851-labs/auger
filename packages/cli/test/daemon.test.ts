import { describe, expect, test } from 'bun:test';
import { spawn } from 'node:child_process';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const cliEntrypoint = new URL('../src/index.ts', import.meta.url).pathname;

type CliResult = {
  code: number | null;
  stdout: string;
  stderr: string;
};

async function createTestDir(): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'auger-cli-test-'));
  return dir;
}

async function runCli(args: string[], xdgConfigHome: string): Promise<CliResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [cliEntrypoint, ...args], {
      env: {
        ...process.env,
        XDG_CONFIG_HOME: xdgConfigHome,
      },
    });

    let stdout = '';
    let stderr = '';

    child.stdout.on('data', (chunk) => {
      stdout += chunk.toString();
    });

    child.stderr.on('data', (chunk) => {
      stderr += chunk.toString();
    });

    child.on('error', reject);
    child.on('close', (code) => {
      resolve({
        code,
        stdout,
        stderr,
      });
    });
  });
}

function parseDaemonId(stdout: string): string {
  const match = stdout.match(/Started daemon ([^\s]+) \(pid \d+\)\./);
  if (!match) {
    throw new Error(`Could not parse daemon id from output: ${stdout}`);
  }
  return match[1];
}

async function cleanupTestDir(xdgConfigHome: string): Promise<void> {
  const daemonsDir = path.join(xdgConfigHome, 'auger', 'runtime', 'daemons');

  try {
    const files = await fs.readdir(daemonsDir);
    for (const file of files) {
      if (!file.endsWith('.json')) continue;
      try {
        const raw = await fs.readFile(path.join(daemonsDir, file), 'utf8');
        const parsed = JSON.parse(raw) as { pid?: number };
        if (typeof parsed.pid === 'number' && parsed.pid > 0) {
          try {
            process.kill(parsed.pid, 'SIGKILL');
          } catch {
            // no-op
          }
        }
      } catch {
        // no-op
      }
    }
  } catch {
    // no-op
  }

  await fs.rm(xdgConfigHome, { recursive: true, force: true });
}

describe('daemon CLI commands', () => {
  test('starts daemon, lists it, and kills by port', async () => {
    const xdgConfigHome = await createTestDir();
    try {
      const start = await runCli(
        ['http', '3000', '--server', 'http://127.0.0.1:1', '--daemon'],
        xdgConfigHome
      );
      expect(start.code).toBe(0);
      const daemonId = parseDaemonId(start.stdout);
      expect(daemonId.length).toBeGreaterThan(0);

      const list = await runCli(['list'], xdgConfigHome);
      expect(list.code).toBe(0);
      expect(list.stdout).toContain(daemonId);
      expect(list.stdout).toContain('tunnels: 3000');

      const kill = await runCli(['kill', '3000'], xdgConfigHome);
      expect(kill.code).toBe(0);
      expect(kill.stdout).toContain(`Daemon ${daemonId} (3000)`);

      const finalList = await runCli(['list'], xdgConfigHome);
      expect(finalList.code).toBe(0);
      expect(finalList.stdout).toContain('No running daemon tunnels.');
    } finally {
      await cleanupTestDir(xdgConfigHome);
    }
  }, 30000);

  test('kills daemon by id', async () => {
    const xdgConfigHome = await createTestDir();
    try {
      const start = await runCli(
        ['http', '3001', '--server', 'http://127.0.0.1:1', '--daemon'],
        xdgConfigHome
      );
      expect(start.code).toBe(0);
      const daemonId = parseDaemonId(start.stdout);

      const kill = await runCli(['kill', daemonId], xdgConfigHome);
      expect(kill.code).toBe(0);
      expect(kill.stdout).toContain(`Daemon ${daemonId} (3001)`);

      const list = await runCli(['list'], xdgConfigHome);
      expect(list.code).toBe(0);
      expect(list.stdout).toContain('No running daemon tunnels.');
    } finally {
      await cleanupTestDir(xdgConfigHome);
    }
  }, 30000);

  test('list prunes stale daemon records', async () => {
    const xdgConfigHome = await createTestDir();
    try {
      const daemonsDir = path.join(xdgConfigHome, 'auger', 'runtime', 'daemons');
      await fs.mkdir(daemonsDir, { recursive: true });

      const staleId = 'stale-daemon';
      const stalePath = path.join(daemonsDir, `${staleId}.json`);
      await fs.writeFile(
        stalePath,
        JSON.stringify(
          {
            id: staleId,
            pid: 999999,
            startedAt: new Date().toISOString(),
            specs: [{ localPort: 3999 }],
            config: { serverUrl: 'http://127.0.0.1:1', wsPath: '/ws' },
            logFile: '/tmp/stale.log',
          },
          null,
          2
        ),
        'utf8'
      );

      const list = await runCli(['list'], xdgConfigHome);
      expect(list.code).toBe(0);
      expect(list.stdout).toContain('No running daemon tunnels.');

      let removed = false;
      try {
        await fs.access(stalePath);
      } catch {
        removed = true;
      }
      expect(removed).toBe(true);
    } finally {
      await cleanupTestDir(xdgConfigHome);
    }
  }, 30000);

  test('kill by port fails when multiple daemons match', async () => {
    const xdgConfigHome = await createTestDir();
    try {
      const startA = await runCli(
        ['http', '3010', '--server', 'http://127.0.0.1:1', '--daemon'],
        xdgConfigHome
      );
      expect(startA.code).toBe(0);
      const daemonA = parseDaemonId(startA.stdout);

      const startB = await runCli(
        ['http', '3010:test', '--server', 'http://127.0.0.1:1', '--daemon'],
        xdgConfigHome
      );
      expect(startB.code).toBe(0);
      const daemonB = parseDaemonId(startB.stdout);

      const killByPort = await runCli(['kill', '3010'], xdgConfigHome);
      expect(killByPort.code).toBe(1);
      expect(killByPort.stderr).toContain('More than one daemon matches port 3010');

      await runCli(['kill', daemonA], xdgConfigHome);
      await runCli(['kill', daemonB], xdgConfigHome);
    } finally {
      await cleanupTestDir(xdgConfigHome);
    }
  }, 30000);
});
