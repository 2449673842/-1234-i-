import Database from 'better-sqlite3';
import fs from 'node:fs';
import path from 'node:path';

const BASE_URL = process.env.SCIFIGURE_URL || 'http://localhost:3000';

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function assertIsolatedEnvironment() {
  assert(process.env.SCIFIGURE_TEST_ISOLATED === '1', 'export transaction smoke requires the isolated wrapper');
  assert(process.env.SCIFIGURE_DB_PATH, 'SCIFIGURE_DB_PATH is required');
  assert(process.env.SCIFIGURE_DATA_DIR, 'SCIFIGURE_DATA_DIR is required');
  const url = new URL(BASE_URL);
  assert(url.hostname === '127.0.0.1' && url.port !== '3000', `unsafe smoke URL: ${BASE_URL}`);
}

async function jsonRequest(requestPath, token, options = {}) {
  const response = await fetch(`${BASE_URL}${requestPath}`, {
    ...options,
    headers: {
      ...(options.body ? { 'Content-Type': 'application/json' } : {}),
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...(options.headers || {}),
    },
  });
  const data = await response.json().catch(() => null);
  return { response, data };
}

async function register() {
  const result = await jsonRequest('/api/auth/register', '', {
    method: 'POST',
    body: JSON.stringify({
      email: `export-transaction-${Date.now()}-${Math.random().toString(36).slice(2)}@example.test`,
      password: 'Export-Transaction-Test-Password-2026',
    }),
  });
  assert(result.response.ok && result.data?.token, `registration failed: ${JSON.stringify(result.data)}`);
  return result.data.token;
}

const script = `
import matplotlib
matplotlib.use("Agg")
import matplotlib.pyplot as plt

fig, ax = plt.subplots(figsize=(4, 3))
ax.plot([0, 1, 2], [1, 3, 2], color="#176b5b")
ax.set_title("Export transaction smoke")
plt.show()
`;

function exportFiles(projectId) {
  const exportsDir = path.join(process.env.SCIFIGURE_DATA_DIR, 'projects', projectId, 'exports');
  if (!fs.existsSync(exportsDir)) return [];
  return fs.readdirSync(exportsDir).sort();
}

function openDatabase() {
  const database = new Database(process.env.SCIFIGURE_DB_PATH);
  database.pragma('busy_timeout = 5000');
  return database;
}

async function exportFigure(token, projectId, name) {
  return jsonRequest(`/api/projects/${projectId}/export`, token, {
    method: 'POST',
    body: JSON.stringify({
      figureId: 'fig_1',
      format: 'svg',
      dpi: 150,
      name,
      saveToLibrary: true,
    }),
  });
}

async function main() {
  assertIsolatedEnvironment();
  const token = await register();
  const created = await jsonRequest('/api/projects', token, {
    method: 'POST',
    body: JSON.stringify({
      name: 'Export file transaction smoke',
      spec: { plot_type: 'custom', custom_script: script, script_language: 'python' },
    }),
  });
  assert(created.response.ok && created.data?.id, `project creation failed: ${JSON.stringify(created.data)}`);
  const projectId = created.data.id;

  try {
    const rendered = await jsonRequest(`/api/projects/${projectId}/figures/render`, token, {
      method: 'POST',
      body: JSON.stringify({ script, editLogs: {}, language: 'python' }),
    });
    assert(rendered.response.ok && rendered.data?.status === 'success', `initial render failed: ${JSON.stringify(rendered.data)}`);

    const beforeCreateFailureFiles = exportFiles(projectId);
    const createFailureDb = openDatabase();
    try {
      createFailureDb.exec(`
        CREATE TRIGGER fail_export_asset_insert
        BEFORE INSERT ON export_assets
        WHEN NEW.name = 'forced-create-failure'
        BEGIN
          SELECT RAISE(ABORT, 'injected export insert failure');
        END;
      `);
    } finally {
      createFailureDb.close();
    }

    const failedCreate = await exportFigure(token, projectId, 'forced-create-failure');
    assert(failedCreate.response.status === 500, `injected export create should fail: ${JSON.stringify(failedCreate.data)}`);
    const afterCreateFailureDb = openDatabase();
    try {
      const row = afterCreateFailureDb.prepare(
        'SELECT id FROM export_assets WHERE project_id = ? AND name = ?',
      ).get(projectId, 'forced-create-failure');
      assert(!row, 'failed export create left an export_assets row');
      afterCreateFailureDb.exec('DROP TRIGGER fail_export_asset_insert');
    } finally {
      afterCreateFailureDb.close();
    }
    assert(
      JSON.stringify(exportFiles(projectId)) === JSON.stringify(beforeCreateFailureFiles),
      'failed export create left an orphan physical file',
    );

    const successfulCreate = await exportFigure(token, projectId, 'forced-delete-failure');
    assert(
      successfulCreate.response.ok && successfulCreate.data?.figures?.[0]?.asset?.assetId,
      `baseline export failed: ${JSON.stringify(successfulCreate.data)}`,
    );
    const asset = successfulCreate.data.figures[0].asset;
    const deleteFailureDb = openDatabase();
    let assetPath;
    try {
      const row = deleteFailureDb.prepare(
        'SELECT file_path FROM export_assets WHERE id = ? AND project_id = ?',
      ).get(asset.assetId, projectId);
      assert(row?.file_path, 'baseline export DB row is missing');
      assetPath = path.isAbsolute(row.file_path)
        ? row.file_path
        : path.resolve(process.cwd(), row.file_path);
      assert(fs.existsSync(assetPath), 'baseline export file is missing');
      deleteFailureDb.exec(`
        CREATE TRIGGER fail_export_asset_delete
        BEFORE DELETE ON export_assets
        WHEN OLD.name = 'forced-delete-failure'
        BEGIN
          SELECT RAISE(ABORT, 'injected export delete failure');
        END;
      `);
    } finally {
      deleteFailureDb.close();
    }

    const failedDelete = await jsonRequest(`/api/projects/${projectId}/export-assets`, token, {
      method: 'DELETE',
      body: JSON.stringify({ assetIds: [asset.assetId] }),
    });
    assert(failedDelete.response.status === 500, `injected export delete should fail: ${JSON.stringify(failedDelete.data)}`);
    const afterDeleteFailureDb = openDatabase();
    try {
      const row = afterDeleteFailureDb.prepare(
        'SELECT id FROM export_assets WHERE id = ? AND project_id = ?',
      ).get(asset.assetId, projectId);
      assert(row?.id === asset.assetId, 'failed export delete removed the DB row');
      assert(fs.existsSync(assetPath), 'failed export delete removed the physical file');
      afterDeleteFailureDb.exec('DROP TRIGGER fail_export_asset_delete');
    } finally {
      afterDeleteFailureDb.close();
    }

    const deleted = await jsonRequest(`/api/projects/${projectId}/export-assets`, token, {
      method: 'DELETE',
      body: JSON.stringify({ assetIds: [asset.assetId] }),
    });
    assert(deleted.response.ok && deleted.data?.deleted === 1, `normal export delete failed: ${JSON.stringify(deleted.data)}`);
    assert(!fs.existsSync(assetPath), 'successful export delete left the physical file');

    console.log('PASS export DB failure removes the newly written physical file');
    console.log('PASS delete DB failure restores the physical file and keeps the DB row');
    console.log('PASS successful delete removes both DB state and physical file');
  } finally {
    const cleanupDb = openDatabase();
    try {
      cleanupDb.exec('DROP TRIGGER IF EXISTS fail_export_asset_insert');
      cleanupDb.exec('DROP TRIGGER IF EXISTS fail_export_asset_delete');
    } finally {
      cleanupDb.close();
    }
    await jsonRequest(`/api/projects/${projectId}`, token, { method: 'DELETE' }).catch(() => null);
  }
}

main().catch(error => {
  console.error(JSON.stringify({ status: 'FAIL', message: error.message }, null, 2));
  process.exitCode = 1;
});
