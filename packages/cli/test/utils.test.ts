import { describe, expect, test } from 'bun:test';
import { parsePortSpec } from '../src/utils';

describe('parsePortSpec', () => {
  test('parses port only', () => {
    const result = parsePortSpec('3000');
    expect(result.error).toBeUndefined();
    expect(result.spec).toEqual({ localPort: 3000, subdomain: undefined });
  });

  test('parses port with subdomain', () => {
    const result = parsePortSpec('3000:test');
    expect(result.error).toBeUndefined();
    expect(result.spec).toEqual({ localPort: 3000, subdomain: 'test' });
  });

  test('rejects missing port', () => {
    const result = parsePortSpec(':test');
    expect(result.error).toBeDefined();
    expect(result.spec).toBeUndefined();
  });

  test('rejects missing subdomain', () => {
    const result = parsePortSpec('3000:');
    expect(result.error).toBeDefined();
    expect(result.spec).toBeUndefined();
  });

  test('rejects non-numeric port', () => {
    const result = parsePortSpec('port:test');
    expect(result.error).toBeDefined();
    expect(result.spec).toBeUndefined();
  });

  test('rejects port less than 1', () => {
    const result = parsePortSpec('0:test');
    expect(result.error).toBeDefined();
    expect(result.spec).toBeUndefined();
  });

  test('rejects multiple colons', () => {
    const result = parsePortSpec('3000:test:extra');
    expect(result.error).toBeDefined();
    expect(result.spec).toBeUndefined();
  });
});
