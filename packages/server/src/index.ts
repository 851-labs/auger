import type { ServerWebSocket } from 'bun';
import { decodeBase64, encodeBase64, parseMessage, randomId, toMessage } from '@auger/shared';
import type {
  ClientToServerMessage,
  HelloMessage,
  HttpResponseChunkMessage,
  HttpResponseEndMessage,
  HttpResponseMessage,
  HttpResponseStartMessage,
  TunnelType,
  WsCloseMessage,
  WsFrameMessage,
} from '@auger/shared';
import { loadConfig } from './config';
import { AugerDb } from './db';
import { buildHttpRequestMessage, buildHttpResponse, extractSubdomain } from './http-proxy';
import { findAvailableSubdomain } from './subdomain';
import { mkdir } from 'node:fs/promises';
import path from 'node:path';

const HTTP_TIMEOUT_MS = 30_000;

type ControlWsData = {
  kind: 'control';
  clientId: string | null;
};

type PublicWsData = {
  kind: 'public';
  clientId: string;
  socketId: string;
  path: string;
  headers: Record<string, string>;
  protocols: string[];
};

type WsData = ControlWsData | PublicWsData;

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

type PublicSocketEntry = {
  id: string;
  clientId: string;
  socket: ServerWebSocket<WsData>;
};

type UpgradeServer = {
  upgrade: (
    request: Request,
    options: { data: WsData; headers?: Record<string, string> }
  ) => boolean;
};

const config = loadConfig();
const clients = new Map<string, ClientEntry>();
const subdomainToClient = new Map<string, string>();
const pendingHttp = new Map<string, PendingHttp>();
const publicSockets = new Map<string, PublicSocketEntry>();
const textEncoder = new TextEncoder();
const textDecoder = new TextDecoder();

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

function getClientForRequest(request: Request): { clientId: string; client: ClientEntry } | null {
  const hostHeader = request.headers.get('host') || '';
  const subdomain = extractSubdomain(hostHeader, config.baseDomain);
  if (!subdomain) {
    return null;
  }

  const clientId = subdomainToClient.get(subdomain);
  if (!clientId) {
    return null;
  }

  const client = clients.get(clientId);
  if (!client || client.tunnelType !== 'http') {
    return null;
  }

  return { clientId, client };
}

function isWebSocketUpgradeRequest(request: Request): boolean {
  const upgrade = request.headers.get('upgrade');
  return typeof upgrade === 'string' && upgrade.toLowerCase() === 'websocket';
}

async function handleHttpRequest(request: Request): Promise<Response> {
  const resolvedClient = getClientForRequest(request);
  if (!resolvedClient) {
    const hostHeader = request.headers.get('host') || '';
    const subdomain = extractSubdomain(hostHeader, config.baseDomain);
    if (!subdomain) {
      return new Response('Not Found', { status: 404 });
    }
    if (!subdomainToClient.has(subdomain)) {
      return new Response('Tunnel not found', { status: 404 });
    }
    return new Response('Tunnel unavailable', { status: 502 });
  }

  const { clientId, client } = resolvedClient;
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

function handleWebSocketUpgrade(request: Request, server: UpgradeServer): Response | undefined {
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

  const url = new URL(request.url);
  const headers: Record<string, string> = {};
  for (const [key, value] of request.headers.entries()) {
    headers[key] = value;
  }

  const protocolHeader = request.headers.get('sec-websocket-protocol');
  const requestedProtocols =
    protocolHeader
      ?.split(',')
      .map((value) => value.trim())
      .filter(Boolean) ?? [];
  const protocols = requestedProtocols.length > 0 ? [requestedProtocols[0]] : [];

  const socketId = randomId('ws');
  const upgraded = server.upgrade(request, {
    data: {
      kind: 'public',
      clientId,
      socketId,
      path: url.pathname + url.search,
      headers,
      protocols,
    },
    headers: protocols.length > 0 ? { 'sec-websocket-protocol': protocols[0] } : undefined,
  });

  if (!upgraded) {
    return new Response('Upgrade failed', { status: 500 });
  }

  return;
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

function normalizeCloseCode(code: number | undefined): number {
  if (code === undefined) return 1000;
  if (!Number.isInteger(code)) return 1000;
  if (code < 1000 || code > 4999) return 1000;
  return code;
}

function handleWsFrame(clientId: string, message: WsFrameMessage): void {
  const socket = publicSockets.get(message.id);
  if (!socket) return;
  if (socket.clientId !== clientId) return;

  const decoded = decodeBase64(message.dataBase64);
  if (message.isBinary) {
    socket.socket.send(decoded);
  } else {
    socket.socket.send(textDecoder.decode(decoded));
  }
}

function handleWsClose(clientId: string, message: WsCloseMessage): void {
  const socket = publicSockets.get(message.id);
  if (!socket) return;
  if (socket.clientId !== clientId) return;

  publicSockets.delete(message.id);
  socket.socket.close(normalizeCloseCode(message.code), message.reason ?? '');
}

function handlePublicWsMessage(
  ws: ServerWebSocket<WsData>,
  rawMessage: string | Buffer | Uint8Array
): void {
  if (ws.data.kind !== 'public') return;
  const client = clients.get(ws.data.clientId);
  if (!client) {
    ws.close(1011, 'Tunnel unavailable');
    return;
  }

  let payload: Uint8Array;
  let isBinary = true;
  if (typeof rawMessage === 'string') {
    payload = textEncoder.encode(rawMessage);
    isBinary = false;
  } else if (rawMessage instanceof Uint8Array) {
    payload = rawMessage;
  } else {
    payload = new Uint8Array(rawMessage);
  }

  client.socket.send(
    toMessage({
      type: 'ws_frame',
      id: ws.data.socketId,
      dataBase64: encodeBase64(payload),
      isBinary,
    })
  );
}

function handlePublicWsOpen(ws: ServerWebSocket<WsData>): void {
  if (ws.data.kind !== 'public') return;

  publicSockets.set(ws.data.socketId, {
    id: ws.data.socketId,
    clientId: ws.data.clientId,
    socket: ws,
  });

  const client = clients.get(ws.data.clientId);
  if (!client) {
    publicSockets.delete(ws.data.socketId);
    ws.close(1011, 'Tunnel unavailable');
    return;
  }

  client.socket.send(
    toMessage({
      type: 'ws_open',
      id: ws.data.socketId,
      path: ws.data.path,
      headers: ws.data.headers,
      protocols: ws.data.protocols,
    })
  );
}

function handlePublicWsClose(ws: ServerWebSocket<WsData>, code?: number, reason?: string): void {
  if (ws.data.kind !== 'public') return;
  const socketId = ws.data.socketId;
  const socket = publicSockets.get(socketId);
  if (!socket) {
    return;
  }

  publicSockets.delete(socketId);

  const client = clients.get(ws.data.clientId);
  if (!client) {
    return;
  }

  client.socket.send(
    toMessage({
      type: 'ws_close',
      id: socketId,
      code,
      reason,
    })
  );
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

  for (const [socketId, socket] of publicSockets.entries()) {
    if (socket.clientId !== clientId) continue;
    publicSockets.delete(socketId);
    socket.socket.close(1011, 'Tunnel disconnected');
  }

  db.markDisconnected(clientId, new Date().toISOString());
  clients.delete(clientId);
}

function registerClient(ws: ServerWebSocket<WsData>, hello: HelloMessage): ClientEntry {
  if (!isTokenValid(hello.token)) {
    throw new Error('Invalid token');
  }

  const clientId = randomId('client');
  ws.data = { kind: 'control', clientId };

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
    if (
      url.pathname === config.wsPath &&
      server.upgrade(request, { data: { kind: 'control', clientId: null } })
    ) {
      return;
    }

    if (isWebSocketUpgradeRequest(request)) {
      return handleWebSocketUpgrade(request, server);
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
    open(ws) {
      if (ws.data.kind === 'public') {
        handlePublicWsOpen(ws);
      }
    },
    message(ws, rawMessage) {
      if (ws.data.kind === 'public') {
        handlePublicWsMessage(ws, rawMessage);
        return;
      }

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
        case 'ws_frame':
          handleWsFrame(clientId, message);
          break;
        case 'ws_close':
          handleWsClose(clientId, message);
          break;
        default:
          break;
      }
    },
    close(ws, code, reason) {
      if (ws.data.kind === 'public') {
        handlePublicWsClose(ws, code, reason);
        return;
      }

      const clientId = ws.data.clientId;
      if (clientId !== null) {
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
