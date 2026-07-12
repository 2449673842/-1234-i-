const DATA_FILE_EXTENSION = /\.(?:csv|tsv|txt|xlsx|xls)$/i;

function normalizeCandidate(value: string): string | null {
  const trimmed = value.trim().replace(/\\/g, '/');
  if (!trimmed || /^(?:https?|file|s3):\/\//i.test(trimmed)) return null;
  const fileName = trimmed.split('/').pop() || '';
  return DATA_FILE_EXTENSION.test(fileName) ? fileName : null;
}

export function extractReferencedDataFiles(script: string): string[] {
  const found = new Set<string>();
  const patterns = [
    /_uploaded_file_paths\s*\[\s*["']([^"']+)["']\s*\]/g,
    /uploaded_file_paths\s*\[\[\s*["']([^"']+)["']\s*\]\]/g,
    /(?:read_csv|read_table|read_excel|read\.csv|read\.table|read_excel|readxl::read_excel)\s*\(\s*["']([^"']+)["']/g,
    /(?:pandas|pd)\.(?:read_csv|read_table|read_excel)\s*\(\s*["']([^"']+)["']/g,
  ];

  patterns.forEach(pattern => {
    for (const match of script.matchAll(pattern)) {
      const candidate = normalizeCandidate(match[1] || '');
      if (candidate) found.add(candidate);
    }
  });

  return Array.from(found);
}

export function matchesReferencedDataFile(expected: string, actual: string): boolean {
  return expected.localeCompare(actual, undefined, { sensitivity: 'accent' }) === 0
    || expected.toLocaleLowerCase() === actual.toLocaleLowerCase();
}
