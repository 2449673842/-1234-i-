import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

const repoRoot = process.cwd();

function gitLines(args) {
  return execFileSync('git', args, {
    cwd: repoRoot,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  }).split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
}

const candidateFiles = gitLines(['ls-files', '--cached', '--others', '--exclude-standard']);
const violations = [];

const forbiddenPrefixes = [
  'data/',
  'tmp/',
  'output/',
  'test-results/',
  'test-results-v3/',
  '.playwright-mcp/',
];

const forbiddenExactNames = new Set([
  '.env',
  '.env.local',
  '.env.production',
  '.env.development',
  'scifigure.db',
]);

const forbiddenExtensions = new Set([
  '.db',
  '.sqlite',
  '.sqlite3',
  '.pem',
  '.p12',
  '.pfx',
  '.key',
]);

for (const file of candidateFiles) {
  const normalized = file.replace(/\\/g, '/');
  const baseName = path.posix.basename(normalized);
  const extension = path.posix.extname(normalized).toLowerCase();

  if (forbiddenPrefixes.some((prefix) => normalized.startsWith(prefix))) {
    violations.push(`${normalized}: runtime/user-data directory must not be tracked`);
  }
  if (forbiddenExactNames.has(normalized) || forbiddenExactNames.has(baseName)) {
    violations.push(`${normalized}: secret or runtime database file must not be tracked`);
  }
  if (forbiddenExtensions.has(extension)) {
    violations.push(`${normalized}: sensitive file extension ${extension} must not be tracked`);
  }
  if (/^tmp[_-]/i.test(baseName)) {
    violations.push(`${normalized}: temporary file must not be tracked`);
  }
  if (/_render_diagnostic_.*\.md$/i.test(baseName)) {
    violations.push(`${normalized}: render diagnostics may contain user data`);
  }
}

const secretPatterns = [
  { name: 'private key', pattern: /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/ },
  { name: 'AWS access key', pattern: /\bAKIA[0-9A-Z]{16}\b/ },
  { name: 'GitHub token', pattern: /\bgh[oprsu]_[A-Za-z0-9_]{30,}\b/ },
  { name: 'OpenAI-style token', pattern: /\bsk-[A-Za-z0-9_-]{24,}\b/ },
  { name: 'Google API key', pattern: /\bAIza[0-9A-Za-z_-]{30,}\b/ },
];

const textExtensions = new Set([
  '.cjs', '.css', '.dockerignore', '.env', '.example', '.gitignore', '.html', '.js',
  '.json', '.jsx', '.md', '.mjs', '.py', '.r', '.sh', '.toml', '.ts', '.tsx',
  '.txt', '.yaml', '.yml',
]);

for (const file of candidateFiles) {
  const fullPath = path.resolve(repoRoot, file);
  if (!fs.existsSync(fullPath) || !fs.statSync(fullPath).isFile()) continue;
  const extension = path.extname(file).toLowerCase();
  const baseName = path.basename(file);
  if (!textExtensions.has(extension) && !baseName.startsWith('.env')) continue;
  if (fs.statSync(fullPath).size > 2 * 1024 * 1024) continue;

  const content = fs.readFileSync(fullPath, 'utf8');
  for (const { name, pattern } of secretPatterns) {
    if (pattern.test(content)) {
      violations.push(`${file}: possible ${name} detected`);
    }
  }
}

if (violations.length > 0) {
  console.error('Repository data boundary check failed:');
  for (const violation of [...new Set(violations)]) {
    console.error(`- ${violation}`);
  }
  process.exit(1);
}

console.log(`Repository data boundary check passed (${candidateFiles.length} tracked or unignored files inspected).`);
