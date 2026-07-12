import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import Database from 'better-sqlite3';
import { chromium } from 'playwright';

const ROOT = process.cwd();
const DATA_ROOT = process.env.SCIFIGURE_DATA_DIR
  ? path.resolve(process.env.SCIFIGURE_DATA_DIR)
  : path.resolve(ROOT, 'data');
const PROJECTS_ROOT = path.join(DATA_ROOT, 'projects');
const BACKUPS_ROOT = path.join(DATA_ROOT, 'backups');

function assertExportPath(projectId, filePath) {
  const projectRoot = path.resolve(PROJECTS_ROOT, projectId, 'exports');
  const target = path.resolve(ROOT, filePath);
  if (!target.startsWith(`${projectRoot}${path.sep}`)) {
    throw new Error(`Export path escapes project directory: ${filePath}`);
  }
  return target;
}

function sha256(filePath) {
  return createHash('sha256').update(fs.readFileSync(filePath)).digest('hex');
}

async function restorePngFromSvg(browser, svg, target) {
  const page = await browser.newPage({ viewport: { width: 1800, height: 1400 }, deviceScaleFactor: 1 });
  try {
    await page.setContent(`<style>html,body{margin:0;background:white}svg{display:block}</style>${svg}`);
    const image = page.locator('svg').first();
    await image.waitFor();
    await image.screenshot({ path: target, type: 'png', animations: 'disabled' });
  } finally {
    await page.close();
  }
}

async function main() {
  fs.mkdirSync(BACKUPS_ROOT, { recursive: true });
  const dbPath = process.env.SCIFIGURE_DB_PATH
    ? path.resolve(process.env.SCIFIGURE_DB_PATH)
    : path.join(DATA_ROOT, 'scifigure.db');
  const db = new Database(dbPath, { readonly: true });
  const rows = db.prepare(`
    SELECT e.*, p.name AS project_name
    FROM export_assets e
    JOIN projects p ON p.id = e.project_id
    ORDER BY e.created_at
  `).all();
  db.close();

  const missing = rows.filter(row => !fs.existsSync(path.resolve(ROOT, row.file_path)));
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const reportPath = path.join(BACKUPS_ROOT, `export-assets-recovery-${stamp}.json`);
  const report = {
    createdAt: new Date().toISOString(),
    totalRecords: rows.length,
    missingBefore: missing.map(row => ({
      id: row.id,
      projectId: row.project_id,
      projectName: row.project_name,
      figureId: row.figure_id,
      format: row.format,
      filePath: row.file_path,
      createdAt: row.created_at,
      thumbnailLength: String(row.thumbnail_svg || '').length,
    })),
    restored: [],
    failed: [],
  };
  fs.writeFileSync(reportPath, JSON.stringify(report, null, 2), 'utf8');

  let browser = null;
  try {
    for (const row of missing) {
      const target = assertExportPath(row.project_id, row.file_path);
      const svg = String(row.thumbnail_svg || '');
      if (!svg.includes('<svg')) {
        report.failed.push({ id: row.id, reason: 'No recoverable SVG thumbnail' });
        continue;
      }
      fs.mkdirSync(path.dirname(target), { recursive: true });
      if (String(row.format).toLowerCase() === 'svg') {
        fs.writeFileSync(target, svg, 'utf8');
      } else if (String(row.format).toLowerCase() === 'png') {
        browser ||= await chromium.launch({ headless: true });
        await restorePngFromSvg(browser, svg, target);
      } else {
        report.failed.push({ id: row.id, reason: `Unsupported recovery format: ${row.format}` });
        continue;
      }
      report.restored.push({
        id: row.id,
        filePath: row.file_path,
        sizeBytes: fs.statSync(target).size,
        sha256: sha256(target),
      });
    }
  } finally {
    if (browser) await browser.close();
    fs.writeFileSync(reportPath, JSON.stringify(report, null, 2), 'utf8');
  }

  console.log(JSON.stringify({ reportPath: path.relative(ROOT, reportPath), ...report }, null, 2));
  if (report.failed.length > 0) process.exitCode = 1;
}

main().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
