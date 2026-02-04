export type TunnelType = 'http';

export type HelloMessage = {
  type: 'hello';
  token?: string;
  tunnelType: TunnelType;
  localPort: number;
  requestedSubdomain?: string;
};

export type WelcomeMessage = {
  type: 'welcome';
  clientId: string;
  subdomain?: string;
  publicUrl?: string;
  baseDomain: string;
  heartbeatSeconds: number;
};

export type ErrorMessage = {
  type: 'error';
  message: string;
};

export type HttpRequestMessage = {
  type: 'http_request';
  id: string;
  method: string;
  path: string;
  headers: Record<string, string>;
  bodyBase64: string;
};

export type HttpResponseMessage = {
  type: 'http_response';
  id: string;
  status: number;
  headers: Record<string, string>;
  bodyBase64: string;
};

export type ServerToClientMessage = WelcomeMessage | ErrorMessage | HttpRequestMessage;

export type ClientToServerMessage = HelloMessage | HttpResponseMessage;

export type AnyMessage = ServerToClientMessage | ClientToServerMessage;

export function encodeBase64(data: Uint8Array | ArrayBuffer): string {
  const buffer = data instanceof ArrayBuffer ? new Uint8Array(data) : data;
  return Buffer.from(buffer).toString('base64');
}

export function decodeBase64(data: string): Uint8Array {
  return new Uint8Array(Buffer.from(data, 'base64'));
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function assertString(value: unknown, field: string): asserts value is string {
  if (typeof value !== 'string') {
    throw new Error(`Expected ${field} to be string`);
  }
}

function assertNumber(value: unknown, field: string): asserts value is number {
  if (typeof value !== 'number' || Number.isNaN(value)) {
    throw new Error(`Expected ${field} to be number`);
  }
}

function assertHeaders(value: unknown): asserts value is Record<string, string> {
  if (!isRecord(value)) {
    throw new Error('Expected headers to be object');
  }
  for (const [key, headerValue] of Object.entries(value)) {
    if (typeof key !== 'string' || typeof headerValue !== 'string') {
      throw new Error('Expected headers to be string map');
    }
  }
}

export function parseMessage(raw: string): AnyMessage {
  const parsed = JSON.parse(raw) as unknown;
  if (!isRecord(parsed)) {
    throw new Error('Message must be an object');
  }
  const type = parsed.type;
  assertString(type, 'type');

  switch (type) {
    case 'hello':
      assertString(parsed.tunnelType, 'tunnelType');
      assertNumber(parsed.localPort, 'localPort');
      if (parsed.tunnelType !== 'http') {
        throw new Error('Invalid tunnelType');
      }
      if (parsed.token !== undefined) {
        assertString(parsed.token, 'token');
      }
      if (parsed.requestedSubdomain !== undefined) {
        assertString(parsed.requestedSubdomain, 'requestedSubdomain');
      }
      return parsed as HelloMessage;
    case 'welcome':
      assertString(parsed.clientId, 'clientId');
      assertString(parsed.baseDomain, 'baseDomain');
      assertNumber(parsed.heartbeatSeconds, 'heartbeatSeconds');
      if (parsed.subdomain !== undefined) {
        assertString(parsed.subdomain, 'subdomain');
      }
      if (parsed.publicUrl !== undefined) {
        assertString(parsed.publicUrl, 'publicUrl');
      }
      return parsed as WelcomeMessage;
    case 'error':
      assertString(parsed.message, 'message');
      return parsed as ErrorMessage;
    case 'http_request':
      assertString(parsed.id, 'id');
      assertString(parsed.method, 'method');
      assertString(parsed.path, 'path');
      assertHeaders(parsed.headers);
      assertString(parsed.bodyBase64, 'bodyBase64');
      return parsed as HttpRequestMessage;
    case 'http_response':
      assertString(parsed.id, 'id');
      assertNumber(parsed.status, 'status');
      assertHeaders(parsed.headers);
      assertString(parsed.bodyBase64, 'bodyBase64');
      return parsed as HttpResponseMessage;
    default:
      throw new Error(`Unknown message type: ${type}`);
  }
}

export function toMessage<T extends AnyMessage>(message: T): string {
  return JSON.stringify(message);
}

export function randomId(prefix = ''): string {
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  const hex = Array.from(bytes)
    .map((byte) => byte.toString(16).padStart(2, '0'))
    .join('');
  return prefix ? `${prefix}_${hex}` : hex;
}
