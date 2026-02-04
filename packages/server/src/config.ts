export type ServerConfig = {
  baseDomain: string;
  httpPort: number;
  wsPath: string;
  dbPath: string;
  tokens: string[];
};

function parseNumber(value: string | undefined, fallback: number): number {
  if (!value) return fallback;
  const parsed = Number.parseInt(value, 10);
  return Number.isNaN(parsed) ? fallback : parsed;
}

export function loadConfig(): ServerConfig {
  const baseDomain = (process.env.AUGER_BASE_DOMAIN || '').trim();
  if (!baseDomain) {
    throw new Error('AUGER_BASE_DOMAIN is required');
  }

  const httpPort = parseNumber(process.env.AUGER_HTTP_PORT, 8080);
  const wsPathRaw = (process.env.AUGER_WS_PATH || '/ws').trim();
  const wsPath = wsPathRaw.startsWith('/') ? wsPathRaw : `/${wsPathRaw}`;
  const dbPath = (process.env.AUGER_DB_PATH || './data/auger.db').trim();
  const tokens = (process.env.AUGER_TOKENS || '')
    .split(',')
    .map((token) => token.trim())
    .filter(Boolean);
  return {
    baseDomain: baseDomain.toLowerCase(),
    httpPort,
    wsPath,
    dbPath,
    tokens,
  };
}
