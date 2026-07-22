export type RDeterminismCategory = 'random' | 'clock' | 'environment' | 'filesystem' | 'network' | 'process';

export interface RDeterminismWarning {
  type: 'non_deterministic_source';
  category: RDeterminismCategory;
  message: string;
  suggestion: string;
  symbol: string;
  line: number;
}

export interface RDeterminismScanOptions {
  declaredFileSymbols?: string[];
}

const RANDOM_FUNCTIONS = new Set([
  'rbinom', 'rbeta', 'rchisq', 'rexp', 'rf', 'rgamma', 'rgeom', 'rhyper', 'rlnorm',
  'rlogis', 'rmultinom', 'rnbinom', 'rnorm', 'rpois', 'rsample', 'rsignrank', 'rt',
  'runif', 'rweibull', 'rwilcox', 'sample', 'sample.int',
]);

const NONDETERMINISTIC_CALLS = new Map<
  string,
  Omit<RDeterminismWarning, 'type' | 'symbol' | 'line'>
>([
  ['Sys.time', { category: 'clock', message: 'Current time changes between renders.', suggestion: 'Pass a fixed timestamp into the script.' }],
  ['Sys.Date', { category: 'clock', message: 'Current date changes between renders.', suggestion: 'Pass a fixed date into the script.' }],
  ['Sys.getenv', { category: 'environment', message: 'Environment variables can differ between renderers.', suggestion: 'Pass the required value as an explicit script input.' }],
  ['Sys.setenv', { category: 'environment', message: 'Changing environment variables creates process-dependent behavior.', suggestion: 'Avoid changing the renderer environment.' }],
  ['Sys.unsetenv', { category: 'environment', message: 'Changing environment variables creates process-dependent behavior.', suggestion: 'Avoid changing the renderer environment.' }],
  ['commandArgs', { category: 'environment', message: 'Command-line arguments can differ between renderers.', suggestion: 'Pass required values as explicit script inputs.' }],
  ['file', { category: 'filesystem', message: 'External file access can change between renders.', suggestion: 'Use declared, versioned input data.' }],
  ['read.csv', { category: 'filesystem', message: 'External file access can change between renders.', suggestion: 'Use declared, versioned input data.' }],
  ['read.table', { category: 'filesystem', message: 'External file access can change between renders.', suggestion: 'Use declared, versioned input data.' }],
  ['read.delim', { category: 'filesystem', message: 'External file access can change between renders.', suggestion: 'Use declared, versioned input data.' }],
  ['readLines', { category: 'filesystem', message: 'External file access can change between renders.', suggestion: 'Use declared, versioned input data.' }],
  ['readRDS', { category: 'filesystem', message: 'External file access can change between renders.', suggestion: 'Use declared, versioned input data.' }],
  ['load', { category: 'filesystem', message: 'External file access can change between renders.', suggestion: 'Use declared, versioned input data.' }],
  ['source', { category: 'filesystem', message: 'External code files can change between renders.', suggestion: 'Inline or version the required code.' }],
  ['write.csv', { category: 'filesystem', message: 'Writing external files creates render side effects.', suggestion: 'Return data through the renderer result instead.' }],
  ['write.table', { category: 'filesystem', message: 'Writing external files creates render side effects.', suggestion: 'Return data through the renderer result instead.' }],
  ['writeLines', { category: 'filesystem', message: 'Writing external files creates render side effects.', suggestion: 'Return data through the renderer result instead.' }],
  ['saveRDS', { category: 'filesystem', message: 'Writing external files creates render side effects.', suggestion: 'Return data through the renderer result instead.' }],
  ['url', { category: 'network', message: 'Network access can change between renders.', suggestion: 'Provide a local, versioned input instead.' }],
  ['download.file', { category: 'network', message: 'Network access can change between renders.', suggestion: 'Provide a local, versioned input instead.' }],
  ['download.packages', { category: 'network', message: 'Network access can change between renders.', suggestion: 'Provide dependencies before rendering.' }],
  ['socketConnection', { category: 'network', message: 'Network access can change between renders.', suggestion: 'Provide a local, versioned input instead.' }],
  ['serverSocket', { category: 'network', message: 'Network access can change between renders.', suggestion: 'Avoid opening network listeners during rendering.' }],
  ['system', { category: 'process', message: 'Starting a process creates renderer-dependent side effects.', suggestion: 'Remove process execution from the render script.' }],
  ['system2', { category: 'process', message: 'Starting a process creates renderer-dependent side effects.', suggestion: 'Remove process execution from the render script.' }],
  ['shell', { category: 'process', message: 'Starting a process creates renderer-dependent side effects.', suggestion: 'Remove process execution from the render script.' }],
  ['pipe', { category: 'process', message: 'Starting a process creates renderer-dependent side effects.', suggestion: 'Remove process execution from the render script.' }],
]);

const DECLARED_FILE_READ_FUNCTIONS = new Set([
  'file', 'read.csv', 'read.table', 'read.delim', 'readLines', 'readRDS', 'load',
]);

const INLINE_TEXT_READ_FUNCTIONS = new Set([
  'read.csv', 'read.table', 'read.delim',
]);

const DEFAULT_DECLARED_FILE_SYMBOLS = [
  'uploaded_file_paths',
  '_uploaded_file_paths',
  'csv_json_paths',
];

function maskStringsAndComments(script: string): string {
  let result = '';
  let quote: '"' | "'" | null = null;
  let escaped = false;
  let comment = false;

  for (const char of script) {
    if (comment) {
      if (char === '\n') {
        comment = false;
        result += '\n';
      } else {
        result += ' ';
      }
      continue;
    }
    if (quote) {
      if (escaped) escaped = false;
      else if (char === '\\') escaped = true;
      else if (char === quote) quote = null;
      result += char === '\n' ? '\n' : ' ';
      continue;
    }
    if (char === '#') {
      comment = true;
      result += ' ';
      continue;
    }
    if (char === '"' || char === "'") {
      quote = char;
      result += ' ';
      continue;
    }
    result += char;
  }
  return result;
}

function normalizeBacktickIdentifiers(script: string): string {
  return script.replace(/`([A-Za-z.][\w.]*)`/g, (full, identifier: string) => (
    identifier + ' '.repeat(Math.max(0, full.length - identifier.length))
  ));
}

function lineAt(script: string, index: number): number {
  return script.slice(0, index).split('\n').length;
}

function closingParenthesis(script: string, openIndex: number): number {
  let depth = 0;
  for (let index = openIndex; index < script.length; index += 1) {
    if (script[index] === '(') depth += 1;
    else if (script[index] === ')') {
      depth -= 1;
      if (depth === 0) return index;
    }
  }
  return -1;
}

function hasFixedSeed(maskedArguments: string): boolean {
  const firstArgument = maskedArguments.split(',', 1)[0]?.trim() ?? '';
  const value = firstArgument.replace(/^seed\s*=\s*/, '').trim();
  return /^[+-]?(?:(?:\d+(?:\.\d*)?)|(?:\.\d+))(?:e[+-]?\d+)?L?$/i.test(value);
}

function usesDeclaredFileInput(maskedArguments: string, declaredFileSymbols: string[]): boolean {
  return declaredFileSymbols.some((symbol) => {
    const escaped = symbol.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    return new RegExp(`(^|[^A-Za-z0-9_.])${escaped}([^A-Za-z0-9_.]|$)`).test(maskedArguments);
  });
}

function hasNamedArgument(maskedArguments: string, name: string): boolean {
  const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`(^|,)\\s*${escaped}\\s*=`).test(maskedArguments);
}

function collectDeclaredFileAliases(masked: string, declaredFileSymbols: string[]): Array<{ symbol: string; index: number }> {
  const availableSymbols = new Set(declaredFileSymbols);
  const aliases: Array<{ symbol: string; index: number }> = [];
  const assignmentPattern = /(?:^|[;\n])\s*([A-Za-z.][\w.]*)\s*(?:<-|=)\s*([^\n;]+)/g;
  let match: RegExpExecArray | null;

  while ((match = assignmentPattern.exec(masked)) !== null) {
    const [, symbol, expression] = match;
    if (/\b[A-Za-z.][\w.]*\s*\(/.test(expression)) continue;
    if (!usesDeclaredFileInput(expression, Array.from(availableSymbols))) continue;
    availableSymbols.add(symbol);
    aliases.push({ symbol, index: match.index });
  }

  return aliases;
}

function collectCustomFunctionDefinitions(masked: string): Array<{ symbol: string; index: number }> {
  const definitions: Array<{ symbol: string; index: number }> = [];
  const definitionPattern = /(?:^|[;\n])\s*([A-Za-z.][\w.]*)\s*(?:<-|=)\s*function\s*\(/g;
  let match: RegExpExecArray | null;

  while ((match = definitionPattern.exec(masked)) !== null) {
    definitions.push({ symbol: match[1], index: match.index });
  }

  return definitions;
}

export function scanRScriptDeterminism(
  script: string,
  options: RDeterminismScanOptions = {},
): RDeterminismWarning[] {
  if (!script.trim()) return [];

  const masked = normalizeBacktickIdentifiers(maskStringsAndComments(script));
  const declaredFileSymbols = Array.from(new Set([
    ...DEFAULT_DECLARED_FILE_SYMBOLS,
    ...(options.declaredFileSymbols ?? []),
  ])).filter(Boolean);
  const declaredFileAliases = collectDeclaredFileAliases(masked, declaredFileSymbols);
  const customFunctionDefinitions = collectCustomFunctionDefinitions(masked);
  const warnings: RDeterminismWarning[] = [];
  const seen = new Set<string>();
  let seeded = false;
  const callPattern = /(?:(\b[A-Za-z][\w.]*)\s*:{2,3}\s*)?(\b[A-Za-z.][\w.]*)\s*\(/g;
  let match: RegExpExecArray | null;

  while ((match = callPattern.exec(masked)) !== null) {
    const namespace = match[1] || '';
    const symbol = match[2];
    const displaySymbol = namespace ? `${namespace}::${symbol}` : symbol;
    const openIndex = match.index + match[0].lastIndexOf('(');
    const closeIndex = closingParenthesis(masked, openIndex);
    const maskedArguments = closeIndex === -1 ? '' : masked.slice(openIndex + 1, closeIndex);

    if (symbol === 'set.seed') {
      seeded = closeIndex !== -1 && hasFixedSeed(masked.slice(openIndex + 1, closeIndex));
      continue;
    }

    const line = lineAt(masked, match.index);
    const randomCall = RANDOM_FUNCTIONS.has(symbol);
    const definition = NONDETERMINISTIC_CALLS.get(symbol);
    if (!randomCall && !definition) continue;
    if (
      randomCall
      && !namespace
      && customFunctionDefinitions.some((entry) => entry.symbol === symbol && entry.index < match.index)
    ) {
      continue;
    }
    if (
      definition?.category === 'filesystem'
      && DECLARED_FILE_READ_FUNCTIONS.has(symbol)
      && (
        (INLINE_TEXT_READ_FUNCTIONS.has(symbol) && hasNamedArgument(maskedArguments, 'text'))
        || usesDeclaredFileInput(maskedArguments, [
          ...declaredFileSymbols,
          ...declaredFileAliases
            .filter((entry) => entry.index < match.index)
            .map((entry) => entry.symbol),
        ])
      )
    ) {
      continue;
    }

    const warning = randomCall
      ? {
        category: 'random' as const,
        message: 'Random sampling call has no fixed set.seed coverage.',
        suggestion: 'Call set.seed() with a fixed numeric value before random sampling.',
      }
      : definition;
    if (randomCall && seeded) continue;

    const key = `${displaySymbol}:${line}`;
    if (seen.has(key)) continue;
    seen.add(key);
    warnings.push({ type: 'non_deterministic_source', ...warning, symbol: displaySymbol, line });
  }

  return warnings;
}
