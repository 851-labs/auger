import { encodeBase64, decodeBase64 } from '@auger/shared';
import type { HttpRequestMessage, HttpResponseMessage } from '@auger/shared';

export function extractSubdomain(hostHeader: string, baseDomain: string): string | null {
  const host = hostHeader.split(':')[0].toLowerCase();
  const normalizedBase = baseDomain.toLowerCase();

  if (host === normalizedBase) {
    return null;
  }

  if (!host.endsWith(`.${normalizedBase}`)) {
    return null;
  }

  const subdomain = host.slice(0, -(normalizedBase.length + 1));
  return subdomain || null;
}

export async function buildHttpRequestMessage(
  request: Request,
  id: string
): Promise<HttpRequestMessage> {
  const url = new URL(request.url);
  const body = await request.arrayBuffer();
  const headers: Record<string, string> = {};
  for (const [key, value] of request.headers.entries()) {
    headers[key] = value;
  }

  return {
    type: 'http_request',
    id,
    method: request.method,
    path: url.pathname + url.search,
    headers,
    bodyBase64: encodeBase64(body),
  };
}

export function buildHttpResponse(message: HttpResponseMessage): Response {
  const body = decodeBase64(message.bodyBase64);
  const bodyBuffer =
    body.byteLength > 0
      ? new Uint8Array(
          body.buffer.slice(body.byteOffset, body.byteOffset + body.byteLength) as ArrayBuffer
        )
      : null;
  const bodyBlob = bodyBuffer ? new Blob([bodyBuffer]) : undefined;
  const headers = new Headers(message.headers);
  return new Response(bodyBlob, {
    status: message.status,
    headers,
  });
}
