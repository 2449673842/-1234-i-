/**
 * Serializes any JavaScript value to a stable, key-sorted JSON string.
 */
export function stableStringify(value: unknown): string {
  if (value === null) return 'null';
  if (value === undefined) return '';
  if (typeof value !== 'object') {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return '[' + value.map(stableStringify).join(',') + ']';
  }
  if (value instanceof Date) {
    return JSON.stringify(value.toISOString());
  }
  if (value instanceof RegExp) {
    return JSON.stringify(value.toString());
  }

  const obj = value as Record<string, unknown>;
  const keys = Object.keys(obj).sort();
  const parts = keys.map(key => {
    const valStr = stableStringify(obj[key]);
    if (valStr === '') return ''; // omit undefined properties
    return JSON.stringify(key) + ':' + valStr;
  }).filter(p => p !== '');
  return '{' + parts.join(',') + '}';
}

/**
 * Generates a fast 32-bit FNV-1a hash hex string of the input string.
 */
export function fnv1a(str: string): string {
  let hash = 2166136261;
  for (let i = 0; i < str.length; i++) {
    const charCode = str.charCodeAt(i);
    // Handle surrogate pairs / multi-byte character codes
    if (charCode < 0x80) {
      hash ^= charCode;
      hash = Math.imul(hash, 16777619);
    } else if (charCode < 0x800) {
      hash ^= (charCode >> 6) | 0xc0;
      hash = Math.imul(hash, 16777619);
      hash ^= (charCode & 0x3f) | 0x80;
      hash = Math.imul(hash, 16777619);
    } else if (charCode < 0xd800 || charCode >= 0xe000) {
      hash ^= (charCode >> 12) | 0xe0;
      hash = Math.imul(hash, 16777619);
      hash ^= ((charCode >> 6) & 0x3f) | 0x80;
      hash = Math.imul(hash, 16777619);
      hash ^= (charCode & 0x3f) | 0x80;
      hash = Math.imul(hash, 16777619);
    } else {
      // surrogate pair
      i++;
      const nextCharCode = str.charCodeAt(i);
      const utf32 = 0x10000 + (((charCode & 0x3ff) << 10) | (nextCharCode & 0x3ff));
      hash ^= (utf32 >> 18) | 0xf0;
      hash = Math.imul(hash, 16777619);
      hash ^= ((utf32 >> 12) & 0x3f) | 0x80;
      hash = Math.imul(hash, 16777619);
      hash ^= ((utf32 >> 6) & 0x3f) | 0x80;
      hash = Math.imul(hash, 16777619);
      hash ^= (utf32 & 0x3f) | 0x80;
      hash = Math.imul(hash, 16777619);
    }
  }
  return (hash >>> 0).toString(16).padStart(8, '0');
}

/**
 * Computes a stable cryptographic hash (SHA-256) of the input string,
 * falling back to non-cryptographic FNV-1a if window.crypto or crypto.subtle
 * is unavailable (e.g. non-HTTPS environments).
 */
export async function stableHash(str: string): Promise<string> {
  if (
    typeof window !== 'undefined' &&
    window.crypto &&
    window.crypto.subtle
  ) {
    try {
      const msgUint8 = new TextEncoder().encode(str);
      const hashBuffer = await window.crypto.subtle.digest('SHA-256', msgUint8);
      const hashArray = Array.from(new Uint8Array(hashBuffer));
      return hashArray.map(b => b.toString(16).padStart(2, '0')).join('');
    } catch {
      // Fallback on error
    }
  }
  return fnv1a(str);
}
