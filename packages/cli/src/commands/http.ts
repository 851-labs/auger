import { decodeBase64, encodeBase64, parseMessage, toMessage } from '@auger/shared';
import type {
  HelloMessage,
  HttpRequestMessage,
  HttpResponseChunkMessage,
  HttpResponseEndMessage,
  HttpResponseMessage,
  HttpResponseStartMessage,
} from '@auger/shared';
import { buildWsUrl } from '../utils';

export type HttpCommandOptions = {
  localPort: number;
  serverUrl: string;
  token?: string;
  wsPath: string;
  subdomain?: string;
};

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
  let consecutiveFailures = 0;
  let reconnectScheduled = false;
  let fatalError = false;

  const scheduleReconnect = (reason: string) => {
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

    ws.addEventListener('open', () => {
      consecutiveFailures = 0;
      const hello: HelloMessage = {
        type: 'hello',
        tunnelType: 'http',
        localPort: options.localPort,
        token: options.token,
        requestedSubdomain: options.subdomain,
      };

      ws?.send(toMessage(hello));
    });

    ws.addEventListener('message', async (event) => {
      const data =
        typeof event.data === 'string'
          ? event.data
          : Buffer.from(event.data as ArrayBuffer).toString('utf8');
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
