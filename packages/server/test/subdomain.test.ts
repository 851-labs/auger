import { describe, expect, test } from 'bun:test';
import { extractSubdomain } from '../src/http-proxy';
import { findAvailableSubdomain, generateSubdomain } from '../src/subdomain';

describe('extractSubdomain', () => {
  test('returns subdomain when host matches base domain', () => {
    const result = extractSubdomain('pickle.example.com', 'example.com');
    expect(result).toBe('pickle');
  });

  test('ignores port and returns subdomain', () => {
    const result = extractSubdomain('pickle.example.com:8080', 'example.com');
    expect(result).toBe('pickle');
  });

  test('returns null for base domain only', () => {
    const result = extractSubdomain('example.com', 'example.com');
    expect(result).toBeNull();
  });
});

describe('generateSubdomain', () => {
  test('generates deterministic values with custom random', () => {
    let seed = 0;
    const random = () => {
      seed += 0.1;
      return seed % 1;
    };
    const first = generateSubdomain(random);
    const second = generateSubdomain(random);
    expect(first).not.toBe(second);
  });
});

describe('findAvailableSubdomain', () => {
  test('returns requested subdomain when available', () => {
    const subdomain = findAvailableSubdomain('custom', () => false);
    expect(subdomain).toBe('custom');
  });

  test('throws when requested subdomain is taken', () => {
    expect(() => findAvailableSubdomain('taken', () => true)).toThrow(
      'Subdomain "taken" is already in use'
    );
  });

  test('returns generated subdomain when no request provided', () => {
    const random = () => 0;
    const subdomain = findAvailableSubdomain(undefined, () => false, random);
    expect(subdomain).toBe('brave-pickle');
  });
});
