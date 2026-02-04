import { createInterface } from 'node:readline/promises';
import { stdin as input, stdout as output } from 'node:process';
import { getConfigPaths, saveConfigFile } from './config';
import type { CliConfig } from './config';

export async function runOnboarding(): Promise<CliConfig> {
  const rl = createInterface({ input, output });
  const serverUrl = (await rl.question('Server URL (e.g., https://auger.example.com): ')).trim();
  const token = (await rl.question('Auth token (leave blank if none): ')).trim();
  rl.close();

  if (!serverUrl) {
    throw new Error('Server URL is required');
  }

  const config: CliConfig = {
    serverUrl,
    token: token || undefined,
    wsPath: '/ws',
  };

  const { configFile } = getConfigPaths();
  await saveConfigFile(configFile, config);

  return config;
}
