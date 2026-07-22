import { describe, expect, it } from 'vitest';
import { createUtf8StreamCollector } from './utf8StreamCollector';

describe('createUtf8StreamCollector', () => {
  it('preserves UTF-8 text when a code point is split across chunks', () => {
    const payload = JSON.stringify({ message: '中文标题'.repeat(22000) });
    const bytes = Buffer.from(payload, 'utf8');
    const collector = createUtf8StreamCollector();

    for (let index = 0; index < bytes.length; index += 1) {
      collector.append(bytes.subarray(index, index + 1));
    }

    expect(JSON.parse(collector.finish())).toEqual(JSON.parse(payload));
    expect(collector.value()).not.toContain('\uFFFD');
    expect(collector.byteLength()).toBe(bytes.length);
  });

  it('flushes a trailing incomplete sequence deterministically', () => {
    const collector = createUtf8StreamCollector();
    collector.append(Buffer.from([0xe4, 0xb8]));

    expect(collector.finish()).toBe('\uFFFD');
    expect(collector.finish()).toBe('\uFFFD');
  });
});
