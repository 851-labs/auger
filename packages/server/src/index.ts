import type { ServerWebSocket } from 'bun';
import { parseMessage, randomId, toMessage } from '@auger/shared';
import type {
  ClientToServerMessage,
  HelloMessage,
  HttpResponseMessage,
  TunnelType,
} from '@auger/shared';
import { loadConfig } from './config';
import { AugerDb } from './db';
import { buildHttpRequestMessage, buildHttpResponse, extractSubdomain } from './http-proxy';
import { generateSubdomain } from './subdomain';
import { mkdir } from 'node:fs/promises';
import path from 'node:path';

const HTTP_TIMEOUT_MS = 30_000;

type WsData = {
  clientId: string | null;
};

type ClientEntry = {
  id: string;
  socket: ServerWebSocket<WsData>;
  tunnelType: TunnelType;
  subdomain?: string;
  localPort: number;
  token?: string;
};

type PendingHttp = {
  clientId: string;
  resolve: (response: Response) => void;
  reject: (error: Error) => void;
  timeout: ReturnType<typeof setTimeout>;
};

const config = loadConfig();
const clients = new Map<string, ClientEntry>();
const subdomainToClient = new Map<string, string>();
const pendingHttp = new Map<string, PendingHttp>();

if (config.dbPath !== ':memory:') {
  await mkdir(path.dirname(config.dbPath), { recursive: true });
}

const db = new AugerDb(config.dbPath);
db.init();

function logInfo(message: string): void {
  console.log(`[auger] ${message}`);
}

function sendError(ws: ServerWebSocket<WsData>, message: string): void {
  ws.send(
    JSON.stringify({
      type: 'error',
      message,
    })
  );
}

function isTokenValid(token?: string): boolean {
  if (config.tokens.length === 0) return true;
  return token !== undefined && config.tokens.includes(token);
}

function findAvailableSubdomain(requested?: string): string {
  if (requested && !subdomainToClient.has(requested)) {
    return requested;
  }

  for (let attempt = 0; attempt < 10; attempt += 1) {
    const subdomain = generateSubdomain();
    if (!subdomainToClient.has(subdomain)) {
      return subdomain;
    }
  }

  return `${generateSubdomain()}-${Math.floor(Math.random() * 1000)}`;
}

async function handleHttpRequest(request: Request): Promise<Response> {
  const hostHeader = request.headers.get('host') || '';
  const subdomain = extractSubdomain(hostHeader, config.baseDomain);
  if (!subdomain) {
    return new Response('Not Found', { status: 404 });
  }

  const clientId = subdomainToClient.get(subdomain);
  if (!clientId) {
    return new Response('Tunnel not found', { status: 404 });
  }

  const client = clients.get(clientId);
  if (!client || client.tunnelType !== 'http') {
    return new Response('Tunnel unavailable', { status: 502 });
  }

  const requestId = randomId('req');
  const message = await buildHttpRequestMessage(request, requestId);

  const responsePromise = new Promise<Response>((resolve, reject) => {
    const timeout = setTimeout(() => {
      pendingHttp.delete(requestId);
      reject(new Error('Tunnel response timeout'));
    }, HTTP_TIMEOUT_MS);

    pendingHttp.set(requestId, {
      clientId,
      resolve,
      reject,
      timeout,
    });
  });

  client.socket.send(toMessage(message));

  try {
    return await responsePromise;
  } catch (error) {
    return new Response('Gateway Timeout', { status: 504 });
  }
}

function handleHttpResponse(clientId: string, message: HttpResponseMessage): void {
  const pending = pendingHttp.get(message.id);
  if (!pending) return;
  if (pending.clientId !== clientId) return;

  clearTimeout(pending.timeout);
  pendingHttp.delete(message.id);
  pending.resolve(buildHttpResponse(message));
}

function cleanupClient(clientId: string): void {
  const client = clients.get(clientId);
  if (!client) return;

  if (client.subdomain) {
    subdomainToClient.delete(client.subdomain);
  }

  for (const [requestId, pending] of pendingHttp.entries()) {
    if (pending.clientId === clientId) {
      clearTimeout(pending.timeout);
      pending.reject(new Error('Client disconnected'));
      pendingHttp.delete(requestId);
    }
  }

  db.markDisconnected(clientId, new Date().toISOString());
  clients.delete(clientId);
}

function registerClient(ws: ServerWebSocket<WsData>, hello: HelloMessage): ClientEntry {
  if (!isTokenValid(hello.token)) {
    throw new Error('Invalid token');
  }

  const clientId = randomId('client');
  ws.data = { clientId };

  const entry: ClientEntry = {
    id: clientId,
    socket: ws,
    tunnelType: hello.tunnelType,
    subdomain: undefined,
    localPort: hello.localPort,
    token: hello.token,
  };

  if (hello.tunnelType === 'http') {
    const subdomain = findAvailableSubdomain(hello.requestedSubdomain);
    entry.subdomain = subdomain;
    subdomainToClient.set(subdomain, clientId);

    ws.send(
      toMessage({
        type: 'welcome',
        clientId,
        subdomain,
        publicUrl: `http://${subdomain}.${config.baseDomain}`,
        baseDomain: config.baseDomain,
        heartbeatSeconds: 30,
      })
    );
  }

  clients.set(clientId, entry);
  db.insertClient({
    id: clientId,
    token: hello.token ?? null,
    tunnelType: hello.tunnelType,
    subdomain: entry.subdomain ?? null,
    publicPort: null,
    localPort: hello.localPort,
    connectedAt: new Date().toISOString(),
    disconnectedAt: null,
  });

  logInfo(`Client ${clientId} connected (${hello.tunnelType}).`);
  return entry;
}

const server = Bun.serve<WsData>({
  port: config.httpPort,
  fetch(request, server) {
    const url = new URL(request.url);
    if (url.pathname === config.wsPath && server.upgrade(request, { data: { clientId: null } })) {
      return;
    }

    if (url.pathname === '/') {
      const hostHeader = request.headers.get('host') || '';
      const subdomain = extractSubdomain(hostHeader, config.baseDomain);
      if (!subdomain) {
        return new Response('Auger server running', { status: 200 });
      }
    }

    return handleHttpRequest(request);
  },
  websocket: {
    message(ws, rawMessage) {
      const text =
        typeof rawMessage === 'string' ? rawMessage : Buffer.from(rawMessage).toString('utf8');
      let message: ClientToServerMessage;
      try {
        message = parseMessage(text) as ClientToServerMessage;
      } catch (error) {
        sendError(ws, (error as Error).message);
        return;
      }

      const clientId = ws.data?.clientId ?? null;

      if (message.type === 'hello') {
        if (clientId) return;
        try {
          registerClient(ws, message);
        } catch (error) {
          sendError(ws, (error as Error).message);
          ws.close();
        }
        return;
      }

      if (!clientId) {
        sendError(ws, 'Client not registered');
        return;
      }

      const client = clients.get(clientId);
      if (!client) {
        sendError(ws, 'Client not found');
        return;
      }

      switch (message.type) {
        case 'http_response':
          handleHttpResponse(clientId, message);
          break;
        default:
          break;
      }
    },
    close(ws) {
      const clientId = ws.data?.clientId ?? null;
      if (clientId) {
        cleanupClient(clientId);
        logInfo(`Client ${clientId} disconnected.`);
      }
    },
  },
});

logInfo(`HTTP server listening on :${config.httpPort}`);
logInfo(`WebSocket path: ${config.wsPath}`);
logInfo(`Base domain: ${config.baseDomain}`);

export { server };
