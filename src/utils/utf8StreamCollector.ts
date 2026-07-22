import { StringDecoder } from 'node:string_decoder';

/**
 * Decode child-process output incrementally so a multibyte UTF-8 sequence
 * split across OS stream chunks is never replaced with U+FFFD.
 */
export function createUtf8StreamCollector() {
  const decoder = new StringDecoder('utf8');
  let text = '';
  let finished = false;
  let byteLength = 0;

  return {
    append(chunk: Buffer | Uint8Array): void {
      if (finished) return;
      const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      byteLength += buffer.length;
      text += decoder.write(buffer);
    },
    finish(): string {
      if (!finished) {
        text += decoder.end();
        finished = true;
      }
      return text;
    },
    value(): string {
      return text;
    },
    byteLength(): number {
      return byteLength;
    },
  };
}
