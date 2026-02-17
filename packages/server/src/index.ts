import type { ServerWebSocket } from 'bun';
import { decodeBase64, parseMessage, randomId, toMessage } from '@auger/shared';
import type {
  ClientToServerMessage,
  HelloMessage,
  HttpResponseChunkMessage,
  HttpResponseEndMessage,
  HttpResponseMessage,
  HttpResponseStartMessage,
  TunnelType,
} from '@auger/shared';
import { loadConfig } from './config';
import { AugerDb } from './db';
import { buildHttpRequestMessage, buildHttpResponse, extractSubdomain } from './http-proxy';
import { findAvailableSubdomain } from './subdomain';
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
  streamController?: ReadableStreamDefaultController<Uint8Array>;
  streamStarted: boolean;
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
      streamStarted: false,
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

function handleHttpResponseStart(clientId: string, message: HttpResponseStartMessage): void {
  const pending = pendingHttp.get(message.id);
  if (!pending) return;
  if (pending.clientId !== clientId) return;
  if (pending.streamStarted) return;

  pending.streamStarted = true;
  clearTimeout(pending.timeout);

  const headers = new Headers(message.headers);
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      pending.streamController = controller;
    },
  });

  pending.resolve(
    new Response(body, {
      status: message.status,
      headers,
    })
  );
}

function handleHttpResponseChunk(clientId: string, message: HttpResponseChunkMessage): void {
  const pending = pendingHttp.get(message.id);
  if (!pending) return;
  if (pending.clientId !== clientId) return;
  if (!pending.streamStarted || !pending.streamController) return;

  pending.streamController.enqueue(decodeBase64(message.chunkBase64));
}

function handleHttpResponseEnd(clientId: string, message: HttpResponseEndMessage): void {
  const pending = pendingHttp.get(message.id);
  if (!pending) return;
  if (pending.clientId !== clientId) return;

  clearTimeout(pending.timeout);

  if (pending.streamStarted && pending.streamController) {
    pending.streamController.close();
  }

  pendingHttp.delete(message.id);
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
      if (pending.streamStarted && pending.streamController) {
        pending.streamController.error(new Error('Client disconnected'));
      } else {
        pending.reject(new Error('Client disconnected'));
      }
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
    const subdomain = findAvailableSubdomain(hello.requestedSubdomain, (candidate) =>
      subdomainToClient.has(candidate)
    );
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
        case 'http_response_start':
          handleHttpResponseStart(clientId, message);
          break;
        case 'http_response_chunk':
          handleHttpResponseChunk(clientId, message);
          break;
        case 'http_response_end':
          handleHttpResponseEnd(clientId, message);
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
