import { describe, it, expect } from 'vitest';
import { stableStringify, fnv1a, stableHash } from './stableJson';

describe('stableStringify', () => {
  it('handles primitives correctly', () => {
    expect(stableStringify(null)).toBe('null');
    expect(stableStringify(undefined)).toBe('');
    expect(stableStringify(123)).toBe('123');
    expect(stableStringify('hello')).toBe('"hello"');
    expect(stableStringify(true)).toBe('true');
  });

  it('sorts keys recursively', () => {
    const obj1 = { b: 2, a: 1, c: { y: 2, x: 1 } };
    const obj2 = { c: { x: 1, y: 2 }, a: 1, b: 2 };
    expect(stableStringify(obj1)).toBe('{"a":1,"b":2,"c":{"x":1,"y":2}}');
    expect(stableStringify(obj1)).toBe(stableStringify(obj2));
  });

  it('handles arrays and nested objects', () => {
    const arr = [{ y: 2, x: 1 }, 123, 'test'];
    expect(stableStringify(arr)).toBe('[{"x":1,"y":2},123,"test"]');
  });

  it('omits undefined properties in objects', () => {
    const obj = { a: 1, b: undefined, c: 3 };
    expect(stableStringify(obj)).toBe('{"a":1,"c":3}');
  });
});

describe('fnv1a', () => {
  it('generates consistent 8-char hex hashes', () => {
    const hash1 = fnv1a('hello world');
    const hash2 = fnv1a('hello world');
    expect(hash1).toBe(hash2);
    expect(hash1).toHaveLength(8);
  });

  it('handles UTF-8 and unicode characters correctly', () => {
    const hash = fnv1a('你好，世界！😊');
    expect(hash).toHaveLength(8);
  });
});

describe('stableHash', () => {
  it('falls back to fnv1a if web crypto is missing', async () => {
    const text = 'test input';
    const hash = await stableHash(text);
    // Since we are running in node (vitest), window is undefined, so it should fallback to fnv1a
    expect(hash).toBe(fnv1a(text));
  });

  it('formats web crypto SHA-256 as a 64-char hex string', async () => {
    const originalWindow = (globalThis as any).window;
    (globalThis as any).window = {
      crypto: {
        subtle: {
          digest: async () => new Uint8Array(32).fill(15).buffer,
        },
      },
    };

    try {
      const hash = await stableHash('browser path');
      expect(hash).toHaveLength(64);
      expect(hash).toBe('0f'.repeat(32));
    } finally {
      if (originalWindow === undefined) {
        delete (globalThis as any).window;
      } else {
        (globalThis as any).window = originalWindow;
      }
    }
  });
});
