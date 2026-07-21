export interface CompressibleEditEntry {
  gid: string;
  prop: string;
  matchColor?: string;
}

function compressionKey(entry: CompressibleEditEntry): string {
  return `${entry.gid}\0${entry.prop}`;
}

export function compressEditLogEntries<T extends CompressibleEditEntry>(log: readonly T[]): T[] {
  const seen = new Set<string>();
  const result: T[] = [];
  for (let index = log.length - 1; index >= 0; index -= 1) {
    const entry = log[index];
    // Conditional color edits are order-dependent: a later edit may match the
    // value produced by an earlier one, so none of them can be discarded.
    if (entry.matchColor?.trim()) {
      result.unshift(entry);
      continue;
    }
    const key = compressionKey(entry);
    if (seen.has(key)) continue;
    seen.add(key);
    result.unshift(entry);
  }
  return result;
}
