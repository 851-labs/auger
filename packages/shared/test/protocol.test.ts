import { describe, expect, test } from 'bun:test';
import { decodeBase64, encodeBase64, parseMessage, toMessage } from '../src/protocol';

describe('protocol', () => {
  test('base64 roundtrip', () => {
    const data = new Uint8Array([1, 2, 3, 4]);
    const encoded = encodeBase64(data);
    const decoded = decodeBase64(encoded);
    expect(Array.from(decoded)).toEqual([1, 2, 3, 4]);
  });

  test('parse http_request message', () => {
    const raw = toMessage({
      type: 'http_request',
      id: 'req-1',
      method: 'GET',
      path: '/hello',
      headers: { host: 'example.com' },
      bodyBase64: '',
    });
    const message = parseMessage(raw);
    expect(message.type).toBe('http_request');
  });

  test('rejects unknown message type', () => {
    expect(() => parseMessage('{"type":"nope"}')).toThrow();
  });

  test('parse streamed http response messages', () => {
    const start = parseMessage(
      toMessage({
        type: 'http_response_start',
        id: 'req-1',
        status: 200,
        headers: { 'content-type': 'text/event-stream' },
      })
    );
    expect(start.type).toBe('http_response_start');

    const chunk = parseMessage(
      toMessage({
        type: 'http_response_chunk',
        id: 'req-1',
        chunkBase64: encodeBase64(new Uint8Array([1, 2, 3])),
      })
    );
    expect(chunk.type).toBe('http_response_chunk');

    const end = parseMessage(
      toMessage({
        type: 'http_response_end',
        id: 'req-1',
      })
    );
    expect(end.type).toBe('http_response_end');
  });
});
