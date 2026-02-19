import { decodeBase64, encodeBase64, parseMessage, toMessage } from '@auger/shared';
import type {
  HelloMessage,
  HttpRequestMessage,
  HttpResponseChunkMessage,
  HttpResponseEndMessage,
  HttpResponseMessage,
  HttpResponseStartMessage,
  WsCloseMessage,
  WsFrameMessage,
  WsOpenMessage,
} from '@auger/shared';
import { buildWsUrl } from '../utils';

export type HttpCommandOptions = {
  localPort: number;
  serverUrl: string;
  token?: string;
  wsPath: string;
  subdomain?: string;
};

type LocalSocketEntry = {
  socket: WebSocket;
  open: boolean;
  closingFromServer: boolean;
  queuedFrames: Array<{ payload: Uint8Array; isBinary: boolean }>;
};

const textEncoder = new TextEncoder();
const textDecoder = new TextDecoder();

function normalizeCloseCode(code: number | undefined): number {
  if (code === undefined) return 1000;
  if (!Number.isInteger(code)) return 1000;
  if (code < 1000 || code > 4999) return 1000;
  return code;
}

async function messageDataToText(data: unknown): Promise<string> {
  if (typeof data === 'string') return data;
  if (data instanceof ArrayBuffer) return Buffer.from(data).toString('utf8');
  if (ArrayBuffer.isView(data)) {
    return Buffer.from(data.buffer, data.byteOffset, data.byteLength).toString('utf8');
  }
  if (data instanceof Blob) {
    return Buffer.from(await data.arrayBuffer()).toString('utf8');
  }
  return String(data);
}

async function messageDataToPayload(
  data: unknown
): Promise<{ payload: Uint8Array; isBinary: boolean } | null> {
  if (typeof data === 'string') {
    return {
      payload: textEncoder.encode(data),
      isBinary: false,
    };
  }

  if (data instanceof ArrayBuffer) {
    return {
      payload: new Uint8Array(data),
      isBinary: true,
    };
  }

  if (ArrayBuffer.isView(data)) {
    return {
      payload: new Uint8Array(
        data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength)
      ),
      isBinary: true,
    };
  }

  if (data instanceof Blob) {
    return {
      payload: new Uint8Array(await data.arrayBuffer()),
      isBinary: true,
    };
  }

  return null;
}

async function handleHttpRequest(
  ws: WebSocket,
  localPort: number,
  message: HttpRequestMessage,
  label: string
): Promise<void> {
  const send = (
    payload:
      | HttpResponseMessage
      | HttpResponseStartMessage
      | HttpResponseChunkMessage
      | HttpResponseEndMessage
  ) => {
    if (ws.readyState === WebSocket.OPEN) {
      ws.send(toMessage(payload));
    }
  };

  try {
    const headers = new Headers(message.headers);
    headers.delete('host');
    const body = decodeBase64(message.bodyBase64);
    const bodyBuffer =
      body.byteLength > 0
        ? new Uint8Array(
            body.buffer.slice(body.byteOffset, body.byteOffset + body.byteLength) as ArrayBuffer
          )
        : null;
    const bodyBlob = bodyBuffer ? new Blob([bodyBuffer]) : undefined;

    const response = await fetch(`http://127.0.0.1:${localPort}${message.path}`, {
      method: message.method,
      headers,
      body: bodyBlob,
    });

    const responseHeaders: Record<string, string> = {};
    for (const [key, value] of response.headers.entries()) {
      responseHeaders[key] = value;
    }

    const startPayload: HttpResponseStartMessage = {
      type: 'http_response_start',
      id: message.id,
      status: response.status,
      headers: responseHeaders,
    };
    send(startPayload);

    if (response.body) {
      const reader = response.body.getReader();
      let doneReading = false;
      while (!doneReading) {
        const { done: chunkDone, value } = await reader.read();
        if (chunkDone) {
          doneReading = true;
          continue;
        }
        if (!value || value.byteLength === 0) continue;

        const chunkPayload: HttpResponseChunkMessage = {
          type: 'http_response_chunk',
          id: message.id,
          chunkBase64: encodeBase64(value),
        };
        send(chunkPayload);
      }
    }

    const endPayload: HttpResponseEndMessage = {
      type: 'http_response_end',
      id: message.id,
    };
    send(endPayload);
    console.log(`[${label}] ${message.method} ${message.path} -> ${response.status}`);
  } catch (error) {
    const payload: HttpResponseMessage = {
      type: 'http_response',
      id: message.id,
      status: 502,
      headers: { 'content-type': 'text/plain' },
      bodyBase64: encodeBase64(Buffer.from('Bad Gateway')),
    };
    send(payload);
    console.log(`[${label}] ${message.method} ${message.path} -> 502`);
  }
}

export async function runHttpCommand(options: HttpCommandOptions): Promise<void> {
  const wsUrl = buildWsUrl(options.serverUrl, options.wsPath);
  const label = options.subdomain
    ? `${options.subdomain}:${options.localPort}`
    : `${options.localPort}`;
  let ws: WebSocket | null = null;
  const localSockets = new Map<string, LocalSocketEntry>();
  let consecutiveFailures = 0;
  let reconnectScheduled = false;
  let fatalError = false;

  const sendControl = (
    payload:
      | HelloMessage
      | HttpResponseMessage
      | HttpResponseStartMessage
      | HttpResponseChunkMessage
      | HttpResponseEndMessage
      | WsFrameMessage
      | WsCloseMessage
  ) => {
    if (ws?.readyState === WebSocket.OPEN) {
      ws.send(toMessage(payload));
    }
  };

  const closeAllLocalSockets = (code: number, reason: string) => {
    for (const [id, entry] of localSockets.entries()) {
      entry.closingFromServer = true;
      localSockets.delete(id);
      entry.socket.close(code, reason);
    }
  };

  const flushQueuedFrames = (entry: LocalSocketEntry) => {
    while (entry.queuedFrames.length > 0) {
      const frame = entry.queuedFrames.shift();
      if (!frame) continue;
      if (frame.isBinary) {
        entry.socket.send(frame.payload);
      } else {
        entry.socket.send(textDecoder.decode(frame.payload));
      }
    }
  };

  const handleWsOpen = (message: WsOpenMessage) => {
    const localUrl = new URL(message.path, `ws://127.0.0.1:${options.localPort}`).toString();
    const localSocket =
      message.protocols.length > 0
        ? new WebSocket(localUrl, message.protocols)
        : new WebSocket(localUrl);
    localSocket.binaryType = 'arraybuffer';

    const entry: LocalSocketEntry = {
      socket: localSocket,
      open: false,
      closingFromServer: false,
      queuedFrames: [],
    };
    localSockets.set(message.id, entry);

    localSocket.addEventListener('open', () => {
      entry.open = true;
      flushQueuedFrames(entry);
    });

    localSocket.addEventListener('message', async (event) => {
      const payload = await messageDataToPayload(event.data);
      if (!payload) return;
      sendControl({
        type: 'ws_frame',
        id: message.id,
        dataBase64: encodeBase64(payload.payload),
        isBinary: payload.isBinary,
      });
    });

    localSocket.addEventListener('close', (event) => {
      localSockets.delete(message.id);
      if (entry.closingFromServer) return;
      sendControl({
        type: 'ws_close',
        id: message.id,
        code: event.code,
        reason: event.reason,
      });
    });
  };

  const handleWsFrame = (message: WsFrameMessage) => {
    const entry = localSockets.get(message.id);
    if (!entry) return;

    const payload = decodeBase64(message.dataBase64);
    if (!entry.open) {
      entry.queuedFrames.push({
        payload,
        isBinary: message.isBinary,
      });
      return;
    }

    if (message.isBinary) {
      entry.socket.send(payload);
    } else {
      entry.socket.send(textDecoder.decode(payload));
    }
  };

  const handleWsClose = (message: WsCloseMessage) => {
    const entry = localSockets.get(message.id);
    if (!entry) return;

    entry.closingFromServer = true;
    localSockets.delete(message.id);
    entry.socket.close(normalizeCloseCode(message.code), message.reason ?? '');
  };

  const scheduleReconnect = (reason: string) => {
    closeAllLocalSockets(1011, 'Tunnel connection lost');
    if (fatalError) {
      process.exit(1);
    }
    if (reconnectScheduled) return;
    reconnectScheduled = true;
    consecutiveFailures += 1;
    if (consecutiveFailures > 5) {
      console.error(`[${label}] Connection lost. Retry limit reached, exiting.`);
      process.exit(1);
    }
    const attempt = consecutiveFailures;
    console.warn(`[${label}] Connection lost (${reason}). Retrying (${attempt}/5) in 2s...`);
    setTimeout(() => {
      reconnectScheduled = false;
      connect();
    }, 2000);
  };

  const connect = () => {
    ws = new WebSocket(wsUrl);
    ws.binaryType = 'arraybuffer';

    ws.addEventListener('open', () => {
      consecutiveFailures = 0;
      const hello: HelloMessage = {
        type: 'hello',
        tunnelType: 'http',
        localPort: options.localPort,
        token: options.token,
        requestedSubdomain: options.subdomain,
      };

      sendControl(hello);
    });

    ws.addEventListener('message', async (event) => {
      const data = await messageDataToText(event.data);
      const message = parseMessage(data);

      if (message.type === 'error') {
        console.error(`[${label}] Server error: ${message.message}`);
        fatalError = true;
        ws?.close();
        return;
      }

      if (message.type === 'welcome') {
        if (message.publicUrl) {
          console.log(`[${label}] Tunnel ready: ${message.publicUrl}`);
        } else {
          console.log(`[${label}] Tunnel ready.`);
        }
        return;
      }

      if (message.type === 'http_request') {
        await handleHttpRequest(ws as WebSocket, options.localPort, message, label);
        return;
      }

      if (message.type === 'ws_open') {
        handleWsOpen(message);
        return;
      }

      if (message.type === 'ws_frame') {
        handleWsFrame(message);
        return;
      }

      if (message.type === 'ws_close') {
        handleWsClose(message);
      }
    });

    ws.addEventListener('close', () => {
      scheduleReconnect('close');
    });

    ws.addEventListener('error', (error) => {
      console.error(`[${label}] WebSocket error`, error);
      scheduleReconnect('error');
    });
  };

  connect();
}
