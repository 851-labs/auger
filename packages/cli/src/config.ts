import { promises as fs } from 'node:fs';
import path from 'node:path';
import os from 'node:os';

export type CliConfig = {
  serverUrl: string;
  token?: string;
  wsPath?: string;
};

export type ConfigOverrides = {
  server?: string;
  token?: string;
  wsPath?: string;
};

export type EnvConfig = {
  server?: string;
  token?: string;
  wsPath?: string;
};

export function getConfigPaths(): { configDir: string; configFile: string } {
  const xdg = process.env.XDG_CONFIG_HOME?.trim();
  const baseDir = xdg || path.join(os.homedir(), '.config');
  const configDir = path.join(baseDir, 'auger');
  return {
    configDir,
    configFile: path.join(configDir, 'config.json'),
  };
}

export async function loadConfigFile(configFile: string): Promise<CliConfig | null> {
  try {
    const content = await fs.readFile(configFile, 'utf8');
    return JSON.parse(content) as CliConfig;
  } catch (error) {
    return null;
  }
}

export async function saveConfigFile(configFile: string, config: CliConfig): Promise<void> {
  const configDir = path.dirname(configFile);
  await fs.mkdir(configDir, { recursive: true });
  await fs.writeFile(configFile, JSON.stringify(config, null, 2), 'utf8');
}

export function readEnvConfig(): EnvConfig {
  return {
    server: process.env.AUGER_SERVER?.trim(),
    token: process.env.AUGER_TOKEN?.trim(),
    wsPath: process.env.AUGER_WS_PATH?.trim(),
  };
}

export function mergeConfig(
  fileConfig: CliConfig | null,
  envConfig: EnvConfig,
  overrides: ConfigOverrides
): CliConfig {
  return {
    serverUrl: overrides.server || envConfig.server || fileConfig?.serverUrl || '',
    token: overrides.token || envConfig.token || fileConfig?.token,
    wsPath: overrides.wsPath || envConfig.wsPath || fileConfig?.wsPath || '/ws',
  };
}
