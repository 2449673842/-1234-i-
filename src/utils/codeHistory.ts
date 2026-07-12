export interface CodeChangeSummary {
  previousLines: number;
  nextLines: number;
  addedLines: number;
  removedLines: number;
  changed: boolean;
  label: string;
}

function splitLines(script: string): string[] {
  if (!script) return [];
  return script.replace(/\r\n?/g, '\n').split('\n');
}

export function summarizeCodeChange(previousScript: string, nextScript: string): CodeChangeSummary {
  const previous = splitLines(previousScript);
  const next = splitLines(nextScript);

  let prefix = 0;
  while (prefix < previous.length && prefix < next.length && previous[prefix] === next[prefix]) {
    prefix += 1;
  }

  let suffix = 0;
  while (
    suffix < previous.length - prefix &&
    suffix < next.length - prefix &&
    previous[previous.length - 1 - suffix] === next[next.length - 1 - suffix]
  ) {
    suffix += 1;
  }

  const removedLines = Math.max(0, previous.length - prefix - suffix);
  const addedLines = Math.max(0, next.length - prefix - suffix);
  const changed = previousScript !== nextScript;

  return {
    previousLines: previous.length,
    nextLines: next.length,
    addedLines: changed ? addedLines : 0,
    removedLines: changed ? removedLines : 0,
    changed,
    label: changed ? `+${addedLines}/-${removedLines} 行` : '无代码变化',
  };
}
