export type RRiskSeverity = 'critical' | 'high' | 'medium';

export interface RRiskFinding {
  severity: RRiskSeverity;
  category: 'process' | 'network' | 'dynamic_code' | 'filesystem' | 'environment' | 'package';
  symbol: string;
  line: number;
  message: string;
}

const CALL_RISKS = new Map<string, Omit<RRiskFinding, 'symbol' | 'line'>>([
  ['system', { severity: 'critical', category: 'process', message: 'Runs an operating-system command.' }],
  ['system2', { severity: 'critical', category: 'process', message: 'Runs an operating-system command.' }],
  ['shell', { severity: 'critical', category: 'process', message: 'Runs a shell command.' }],
  ['pipe', { severity: 'critical', category: 'process', message: 'Opens a process pipe.' }],
  ['fifo', { severity: 'high', category: 'process', message: 'Creates or opens a named pipe.' }],
  ['socketConnection', { severity: 'critical', category: 'network', message: 'Opens a network socket.' }],
  ['serverSocket', { severity: 'critical', category: 'network', message: 'Creates a network server socket.' }],
  ['url', { severity: 'high', category: 'network', message: 'Opens a URL connection.' }],
  ['download.file', { severity: 'critical', category: 'network', message: 'Downloads remote content.' }],
  ['download.packages', { severity: 'critical', category: 'network', message: 'Downloads R packages.' }],
  ['install.packages', { severity: 'critical', category: 'network', message: 'Installs packages at runtime.' }],
  ['source', { severity: 'medium', category: 'dynamic_code', message: 'Executes code from another file or connection.' }],
  ['sys.source', { severity: 'medium', category: 'dynamic_code', message: 'Executes code from another file.' }],
  ['dyn.load', { severity: 'critical', category: 'dynamic_code', message: 'Loads a native shared library.' }],
  ['eval', { severity: 'medium', category: 'dynamic_code', message: 'Evaluates a dynamically constructed expression.' }],
  ['parse', { severity: 'medium', category: 'dynamic_code', message: 'Parses dynamically constructed R code.' }],
  ['do.call', { severity: 'medium', category: 'dynamic_code', message: 'Invokes a function selected at runtime.' }],
  ['unlink', { severity: 'high', category: 'filesystem', message: 'Deletes files or directories.' }],
  ['file.remove', { severity: 'high', category: 'filesystem', message: 'Deletes files.' }],
  ['file.rename', { severity: 'high', category: 'filesystem', message: 'Renames files.' }],
  ['file.copy', { severity: 'medium', category: 'filesystem', message: 'Copies files.' }],
  ['dir.create', { severity: 'medium', category: 'filesystem', message: 'Creates directories.' }],
  ['setwd', { severity: 'medium', category: 'filesystem', message: 'Changes the working directory.' }],
  ['readLines', { severity: 'medium', category: 'filesystem', message: 'Reads arbitrary text files or connections.' }],
  ['readRDS', { severity: 'medium', category: 'filesystem', message: 'Reads an R serialization file.' }],
  ['load', { severity: 'medium', category: 'filesystem', message: 'Loads an R workspace file.' }],
  ['file', { severity: 'medium', category: 'filesystem', message: 'Opens an arbitrary file connection.' }],
  ['gzfile', { severity: 'medium', category: 'filesystem', message: 'Opens a compressed file connection.' }],
  ['bzfile', { severity: 'medium', category: 'filesystem', message: 'Opens a compressed file connection.' }],
  ['xzfile', { severity: 'medium', category: 'filesystem', message: 'Opens a compressed file connection.' }],
  ['unz', { severity: 'medium', category: 'filesystem', message: 'Reads files from a zip archive.' }],
  ['Sys.getenv', { severity: 'medium', category: 'environment', message: 'Reads process environment variables.' }],
  ['Sys.setenv', { severity: 'medium', category: 'environment', message: 'Changes process environment variables.' }],
  ['Sys.unsetenv', { severity: 'medium', category: 'environment', message: 'Removes process environment variables.' }],
]);

const CAPABILITY_PACKAGES = new Set([
  'callr', 'curl', 'doParallel', 'future', 'httr', 'httr2', 'parallel', 'processx',
  'RCurl', 'Rcpp', 'reticulate', 'ssh',
]);

const NAMESPACE_CALL_RISKS = new Map<string, Omit<RRiskFinding, 'symbol' | 'line'>>([
  ['processx::run', { severity: 'critical', category: 'process', message: 'Runs an operating-system process.' }],
  ['processx::run_command', { severity: 'critical', category: 'process', message: 'Runs an operating-system process.' }],
  ['processx::run_bg', { severity: 'critical', category: 'process', message: 'Runs a background operating-system process.' }],
  ['callr::r', { severity: 'critical', category: 'process', message: 'Runs R code in another process.' }],
  ['callr::r_safe', { severity: 'critical', category: 'process', message: 'Runs R code in another process.' }],
  ['callr::r_bg', { severity: 'critical', category: 'process', message: 'Runs R code in a background process.' }],
  ['httr::GET', { severity: 'high', category: 'network', message: 'Performs an HTTP request.' }],
  ['httr::POST', { severity: 'high', category: 'network', message: 'Performs an HTTP request.' }],
  ['httr::PUT', { severity: 'high', category: 'network', message: 'Performs an HTTP request.' }],
  ['httr::DELETE', { severity: 'high', category: 'network', message: 'Performs an HTTP request.' }],
  ['httr2::req_perform', { severity: 'high', category: 'network', message: 'Performs an HTTP request.' }],
  ['curl::curl_fetch_memory', { severity: 'high', category: 'network', message: 'Fetches remote content.' }],
  ['curl::curl_fetch_disk', { severity: 'high', category: 'network', message: 'Fetches remote content.' }],
  ['reticulate::py_run_string', { severity: 'high', category: 'dynamic_code', message: 'Executes dynamically supplied Python code.' }],
  ['reticulate::py_run_file', { severity: 'high', category: 'dynamic_code', message: 'Executes Python code from a file.' }],
  ['Rcpp::sourceCpp', { severity: 'critical', category: 'dynamic_code', message: 'Compiles and loads native code.' }],
  ['ssh::ssh_connect', { severity: 'high', category: 'network', message: 'Opens an SSH connection.' }],
]);

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
      if (escaped) {
        escaped = false;
      } else if (char === '\\') {
        escaped = true;
      } else if (char === quote) {
        quote = null;
      }
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

function lineAt(script: string, index: number): number {
  return script.slice(0, index).split('\n').length;
}

function normalizeBacktickIdentifiers(script: string): string {
  return script.replace(/`([A-Za-z.][\w.]*)`/g, (full, identifier: string) => (
    identifier + ' '.repeat(Math.max(0, full.length - identifier.length))
  ));
}

function stripComments(script: string): string {
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
      result += char;
      if (escaped) escaped = false;
      else if (char === '\\') escaped = true;
      else if (char === quote) quote = null;
      continue;
    }
    if (char === '#') {
      comment = true;
      result += ' ';
      continue;
    }
    if (char === '"' || char === "'") quote = char;
    result += char;
  }
  return result;
}

export function scanRScriptRisks(script: string): RRiskFinding[] {
  if (!script.trim()) return [];
  const masked = normalizeBacktickIdentifiers(maskStringsAndComments(script));
  const findings: RRiskFinding[] = [];
  const seen = new Set<string>();
  const callPattern = /(?:(\b[A-Za-z][\w.]*)\s*:{2,3}\s*)?(\b[A-Za-z.][\w.]*)\s*\(/g;
  let match: RegExpExecArray | null;
  while ((match = callPattern.exec(masked)) !== null) {
    const namespace = match[1] || '';
    const symbol = match[2];
    if (symbol === 'library' || symbol === 'require' || symbol === 'requireNamespace') {
      const argumentStart = match.index + match[0].lastIndexOf('(') + 1;
      const packageMatch = script.slice(argumentStart).match(/^\s*(?:package\s*=\s*)?["']?([A-Za-z][\w.]*)/);
      const packageName = packageMatch?.[1];
      if (packageName && CAPABILITY_PACKAGES.has(packageName)) {
        const line = lineAt(masked, match.index);
        const key = `package:${packageName}:${line}`;
        if (!seen.has(key)) {
          seen.add(key);
          findings.push({
            severity: 'medium',
            category: 'package',
            symbol: packageName,
            line,
            message: 'Loads a package that can create processes, network connections, native code, or parallel workers.',
          });
        }
      }
    }
    const namespacedSymbol = namespace ? `${namespace}::${symbol}` : '';
    const definition = (namespacedSymbol ? NAMESPACE_CALL_RISKS.get(namespacedSymbol) : undefined)
      || CALL_RISKS.get(symbol);
    if (!definition) continue;
    const line = lineAt(masked, match.index);
    const key = `${symbol}:${line}`;
    if (seen.has(key)) continue;
    seen.add(key);
    findings.push({ ...definition, symbol: namespace ? `${namespace}::${symbol}` : symbol, line });
  }

  const dynamicTargetPattern = /\b(get|match\.fun|do\.call)\s*\(\s*["'](system2?|shell|pipe|socketConnection|serverSocket|download\.file|download\.packages|install\.packages|source|sys\.source|dyn\.load|unlink|file\.remove)["']/g;
  const commentFree = stripComments(script);
  while ((match = dynamicTargetPattern.exec(commentFree)) !== null) {
    const dispatcher = match[1];
    const target = match[2];
    const definition = CALL_RISKS.get(target);
    if (!definition) continue;
    const line = lineAt(commentFree, match.index);
    const key = `${dispatcher}:${target}:${line}`;
    if (seen.has(key)) continue;
    seen.add(key);
    findings.push({
      ...definition,
      symbol: `${dispatcher}(${target})`,
      line,
    });
  }

  const parsedCodeTargetPattern = /\bparse\s*\([^)]*\btext\s*=\s*["'][^"'\n]*\b(system2?|shell|pipe|socketConnection|serverSocket|download\.file|download\.packages|install\.packages|source|sys\.source|dyn\.load|unlink|file\.remove)\s*\(/g;
  while ((match = parsedCodeTargetPattern.exec(commentFree)) !== null) {
    const target = match[1];
    const definition = CALL_RISKS.get(target);
    if (!definition) continue;
    const line = lineAt(commentFree, match.index);
    const key = `parse-target:${target}:${line}`;
    if (seen.has(key)) continue;
    seen.add(key);
    findings.push({
      ...definition,
      symbol: `parse(${target})`,
      line,
    });
  }

  const severityOrder: Record<RRiskSeverity, number> = { critical: 0, high: 1, medium: 2 };
  return findings.sort((a, b) => severityOrder[a.severity] - severityOrder[b.severity] || a.line - b.line);
}

export function blockingRRisks(findings: RRiskFinding[]): RRiskFinding[] {
  return findings.filter((finding) => finding.severity === 'critical' || finding.severity === 'high');
}
