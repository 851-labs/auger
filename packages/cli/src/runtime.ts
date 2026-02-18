import { promises as fs, rmSync } from 'node:fs';
import path from 'node:path';
import type { CliConfig } from './config';
import { getConfigPaths } from './config';
import type { PortSpec } from './utils';

export type DaemonRecord = {
  id: string;
  pid: number;
  startedAt: string;
  specs: PortSpec[];
  config: Pick<CliConfig, 'serverUrl' | 'wsPath'>;
  logFile: string;
};

export function getRuntimePaths(): {
  runtimeDir: string;
  daemonsDir: string;
  logsDir: string;
} {
  const { configDir } = getConfigPaths();
  const runtimeDir = path.join(configDir, 'runtime');
  return {
    runtimeDir,
    daemonsDir: path.join(runtimeDir, 'daemons'),
    logsDir: path.join(runtimeDir, 'logs'),
  };
}

export async function ensureRuntimeDirs(): Promise<void> {
  const { daemonsDir, logsDir } = getRuntimePaths();
  await Promise.all([fs.mkdir(daemonsDir, { recursive: true }), fs.mkdir(logsDir, { recursive: true })]);
}

export function getDaemonRecordPath(id: string): string {
  const { daemonsDir } = getRuntimePaths();
  return path.join(daemonsDir, `${id}.json`);
}

export async function saveDaemonRecord(record: DaemonRecord): Promise<void> {
  await ensureRuntimeDirs();
  await fs.writeFile(getDaemonRecordPath(record.id), JSON.stringify(record, null, 2), 'utf8');
}

export async function listDaemonRecords(): Promise<DaemonRecord[]> {
  const { daemonsDir } = getRuntimePaths();
  let fileNames: string[] = [];

  try {
    fileNames = await fs.readdir(daemonsDir);
  } catch {
    return [];
  }

  const records = await Promise.all(
    fileNames
      .filter((fileName) => fileName.endsWith('.json'))
      .map(async (fileName) => {
        try {
          const raw = await fs.readFile(path.join(daemonsDir, fileName), 'utf8');
          return JSON.parse(raw) as DaemonRecord;
        } catch {
          return null;
        }
      })
  );

  return records.filter((record): record is DaemonRecord => record !== null);
}

export async function removeDaemonRecord(id: string): Promise<void> {
  try {
    await fs.rm(getDaemonRecordPath(id), { force: true });
  } catch {
    // no-op
  }
}

export function removeDaemonRecordSync(id: string): void {
  try {
    rmSync(getDaemonRecordPath(id), { force: true });
  } catch {
    // no-op
  }
}

export function createDaemonId(): string {
  const stamp = new Date().toISOString().replace(/[^\d]/g, '').slice(0, 14);
  const random = Math.random().toString(36).slice(2, 8);
  return `${stamp}-${random}`;
}

export function isProcessRunning(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    const err = error as NodeJS.ErrnoException;
    return err.code === 'EPERM';
  }
}
