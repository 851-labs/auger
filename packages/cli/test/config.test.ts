import { describe, expect, test } from 'bun:test';
import { mergeConfig } from '../src/config';

describe('mergeConfig', () => {
  test('flags override env and file', () => {
    const file = { serverUrl: 'file', token: 'file' };
    const env = { server: 'env', token: 'env' };
    const flags = { server: 'flag', token: 'flag' };

    const merged = mergeConfig(file, env, flags);
    expect(merged.serverUrl).toBe('flag');
    expect(merged.token).toBe('flag');
  });

  test('env overrides file', () => {
    const file = { serverUrl: 'file', token: 'file' };
    const env = { server: 'env', token: 'env' };
    const flags = {};

    const merged = mergeConfig(file, env, flags);
    expect(merged.serverUrl).toBe('env');
    expect(merged.token).toBe('env');
  });
});
