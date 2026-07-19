export function stableStringify(value) {
  if (value === null) return 'null';
  if (value === undefined) return '';
  if (typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`;
  return `{${Object.keys(value).sort().map(key => {
    const item = stableStringify(value[key]);
    return item === '' ? '' : `${JSON.stringify(key)}:${item}`;
  }).filter(Boolean).join(',')}}`;
}

export function fnv1a(value) {
  let hash = 2166136261;
  for (let index = 0; index < value.length; index += 1) {
    const charCode = value.charCodeAt(index);
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
      index += 1;
      const nextCharCode = value.charCodeAt(index);
      const utf32 = 0x10000 + (((charCode & 0x3ff) << 10) | (nextCharCode & 0x3ff));
      for (const byte of [
        (utf32 >> 18) | 0xf0,
        ((utf32 >> 12) & 0x3f) | 0x80,
        ((utf32 >> 6) & 0x3f) | 0x80,
        (utf32 & 0x3f) | 0x80,
      ]) {
        hash ^= byte;
        hash = Math.imul(hash, 16777619);
      }
    }
  }
  return (hash >>> 0).toString(16).padStart(8, '0');
}

export function projectFigureSaveBase(figure) {
  return {
    baseRevision: Number(figure?.revision || 1),
    baseEditLogHash: fnv1a(stableStringify(figure?.editLog || [])),
  };
}
