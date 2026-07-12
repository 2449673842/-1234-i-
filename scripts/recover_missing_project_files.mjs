import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import Database from 'better-sqlite3';

const ROOT = process.cwd();
const DATA_ROOT = process.env.SCIFIGURE_DATA_DIR
  ? path.resolve(process.env.SCIFIGURE_DATA_DIR)
  : path.resolve(ROOT, 'data');
const DB_PATH = process.env.SCIFIGURE_DB_PATH
  ? path.resolve(process.env.SCIFIGURE_DB_PATH)
  : path.join(DATA_ROOT, 'scifigure.db');
const BACKUPS_ROOT = path.join(DATA_ROOT, 'backups');
const APPLY = process.argv.includes('--apply');

function resolveStoredPath(storedPath) {
  return path.isAbsolute(storedPath) ? path.resolve(storedPath) : path.resolve(ROOT, storedPath);
}

function sha256(filePath) {
  return createHash('sha256').update(fs.readFileSync(filePath)).digest('hex');
}

function normalizedColumns(value) {
  try {
    const parsed = JSON.parse(value || '[]');
    return JSON.stringify(Array.isArray(parsed) ? parsed : []);
  } catch {
    return String(value || '');
  }
}

function assertMissingTargetPath(projectId, storedPath) {
  const projectFilesRoot = path.resolve(DATA_ROOT, 'projects', projectId, 'files');
  const target = resolveStoredPath(storedPath);
  if (target !== projectFilesRoot && !target.startsWith(`${projectFilesRoot}${path.sep}`)) {
    throw new Error(`Project file path escapes its project directory: ${storedPath}`);
  }
  return target;
}

if (!fs.existsSync(DB_PATH)) {
  throw new Error(`Database not found: ${DB_PATH}`);
}

const db = new Database(DB_PATH, { readonly: true });
const rows = db.prepare(`
  SELECT
    f.id,
    f.project_id,
    f.original_name,
    f.stored_path,
    f.columns,
    f.row_count,
    f.uploaded_at,
    p.name AS project_name
  FROM project_files f
  JOIN projects p ON p.id = f.project_id
  ORDER BY f.uploaded_at, f.id
`).all();
db.close();

const existingByName = new Map();
const missing = [];
for (const row of rows) {
  const absolutePath = resolveStoredPath(row.stored_path);
  if (!fs.existsSync(absolutePath)) {
    missing.push({ ...row, absolutePath });
    continue;
  }
  const candidate = {
    ...row,
    absolutePath,
    sizeBytes: fs.statSync(absolutePath).size,
    sha256: sha256(absolutePath),
  };
  const candidates = existingByName.get(row.original_name) || [];
  candidates.push(candidate);
  existingByName.set(row.original_name, candidates);
}

const analyses = missing.map(row => {
  const candidates = (existingByName.get(row.original_name) || []).map(candidate => ({
    projectId: candidate.project_id,
    projectName: candidate.project_name,
    fileId: candidate.id,
    storedPath: candidate.stored_path,
    absolutePath: candidate.absolutePath,
    uploadedAt: candidate.uploaded_at,
    sizeBytes: candidate.sizeBytes,
    sha256: candidate.sha256,
    metadataMatch:
      Number(candidate.row_count) === Number(row.row_count)
      && normalizedColumns(candidate.columns) === normalizedColumns(row.columns),
  }));
  const metadataMatches = candidates.filter(candidate => candidate.metadataMatch);
  const matchingHashes = new Set(metadataMatches.map(candidate => candidate.sha256));
  const confidence = metadataMatches.length > 0 && matchingHashes.size === 1 ? 'high' : candidates.length > 0 ? 'review' : 'none';
  return {
    projectId: row.project_id,
    projectName: row.project_name,
    fileId: row.id,
    fileName: row.original_name,
    storedPath: row.stored_path,
    uploadedAt: row.uploaded_at,
    rowCount: row.row_count,
    columns: JSON.parse(row.columns || '[]'),
    confidence,
    candidates,
    selectedCandidate: confidence === 'high' ? metadataMatches[0] : null,
  };
});

const report = {
  createdAt: new Date().toISOString(),
  mode: APPLY ? 'apply' : 'dry-run',
  dataRoot: DATA_ROOT,
  missingCount: analyses.length,
  highConfidenceCount: analyses.filter(item => item.confidence === 'high').length,
  reviewCount: analyses.filter(item => item.confidence === 'review').length,
  unresolvedCount: analyses.filter(item => item.confidence === 'none').length,
  restored: [],
  skipped: [],
  files: analyses,
};

if (APPLY) {
  fs.mkdirSync(BACKUPS_ROOT, { recursive: true });
  for (const item of analyses) {
    if (!item.selectedCandidate) {
      report.skipped.push({ fileId: item.fileId, fileName: item.fileName, reason: `confidence=${item.confidence}` });
      continue;
    }
    const target = assertMissingTargetPath(item.projectId, item.storedPath);
    if (fs.existsSync(target)) {
      report.skipped.push({ fileId: item.fileId, fileName: item.fileName, reason: 'target already exists' });
      continue;
    }
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.copyFileSync(item.selectedCandidate.absolutePath, target, fs.constants.COPYFILE_EXCL);
    const restoredHash = sha256(target);
    if (restoredHash !== item.selectedCandidate.sha256) {
      throw new Error(`Hash mismatch after restoring ${item.fileName}`);
    }
    report.restored.push({
      fileId: item.fileId,
      projectId: item.projectId,
      fileName: item.fileName,
      targetPath: target,
      sourcePath: item.selectedCandidate.absolutePath,
      sizeBytes: fs.statSync(target).size,
      sha256: restoredHash,
    });
  }
  const stamp = report.createdAt.replace(/[:.]/g, '-');
  const reportPath = path.join(BACKUPS_ROOT, `project-files-recovery-${stamp}.json`);
  fs.writeFileSync(reportPath, JSON.stringify(report, null, 2), 'utf8');
  report.reportPath = path.relative(ROOT, reportPath);
}

console.log(JSON.stringify(report, null, 2));
if (report.reviewCount > 0 || report.unresolvedCount > 0) process.exitCode = 1;
