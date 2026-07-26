import Database from 'better-sqlite3';
import fs from 'node:fs';
import path from 'node:path';

const BASE_URL = process.env.SCIFIGURE_URL || 'http://localhost:3000';

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function parseJson(value, fallback) {
  if (!value) return fallback;
  try {
    return JSON.parse(value);
  } catch {
    return fallback;
  }
}

function stableDeep(value) {
  if (Array.isArray(value)) return value.map(stableDeep);
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(Object.keys(value).sort().map((key) => [key, stableDeep(value[key])]));
}

function assertIsolatedEnvironment() {
  assert(process.env.SCIFIGURE_TEST_ISOLATED === '1', 'test must run under scripts/testing/run_with_isolated_server.mjs');
  assert(BASE_URL, 'SCIFIGURE_URL is required from the isolated server wrapper');
  const url = new URL(BASE_URL);
  assert(url.hostname === '127.0.0.1', `test must target isolated 127.0.0.1 server, got ${BASE_URL}`);
  assert(url.port !== '3000', 'test refuses localhost:3000/default port');

  const dataDir = process.env.SCIFIGURE_DATA_DIR;
  const dbPath = process.env.SCIFIGURE_DB_PATH;
  assert(dataDir && dbPath, 'isolated test requires SCIFIGURE_DATA_DIR and SCIFIGURE_DB_PATH');
  const resolvedDataDir = path.resolve(dataDir);
  const resolvedDbPath = path.resolve(dbPath);
  assert(path.basename(path.dirname(resolvedDataDir)).startsWith('scifigure-isolated-smoke-'), `test refuses non-isolated data dir: ${resolvedDataDir}`);
  assert(resolvedDbPath.startsWith(resolvedDataDir + path.sep), `test refuses DB outside isolated data dir: ${resolvedDbPath}`);
  assert(resolvedDataDir !== path.resolve(process.cwd(), 'data'), 'test refuses repository data/ directory');

  const budgetMb = Number(process.env.SCIFIGURE_MAX_PERSISTED_SVG_MB);
  assert(Number.isFinite(budgetMb) && budgetMb > 0 && budgetMb <= 0.08, `test requires low SCIFIGURE_MAX_PERSISTED_SVG_MB <= 0.08, got ${process.env.SCIFIGURE_MAX_PERSISTED_SVG_MB || '<unset>'}`);
}

async function jsonRequest(route, token, options = {}) {
  const response = await fetch(`${BASE_URL}${route}`, {
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
      email: `r-wp9-performance-${Date.now()}-${Math.random().toString(36).slice(2)}@example.test`,
      password: 'R-WP9-Performance-Persistence-2026',
    }),
  });
  assert(result.response.ok && result.data?.token, `registration failed: ${JSON.stringify(result.data)}`);
  return result.data.token;
}

function openDb(readonly = true) {
  const db = new Database(process.env.SCIFIGURE_DB_PATH, { readonly });
  db.pragma('busy_timeout = 5000');
  return db;
}

function listFiles(root) {
  if (!fs.existsSync(root)) return [];
  const entries = [];
  const walk = (current) => {
    for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
      const absolute = path.join(current, entry.name);
      if (entry.isDirectory()) {
        walk(absolute);
      } else {
        const stat = fs.statSync(absolute);
        entries.push({
          path: path.relative(root, absolute).replace(/\\/g, '/'),
          size: stat.size,
        });
      }
    }
  };
  walk(root);
  return entries.sort((a, b) => a.path.localeCompare(b.path));
}

function projectExportsDir(projectId) {
  return path.join(process.env.SCIFIGURE_DATA_DIR, 'projects', projectId, 'exports');
}

function readPersistenceState(projectId) {
  const db = openDb(true);
  try {
    const sessionIds = db.prepare(`
      SELECT session_id
      FROM project_figures
      WHERE project_id = ?
      ORDER BY figure_index ASC
    `).all(projectId).map((row) => row.session_id);
    const sessions = sessionIds.map((sessionId) => {
      const row = db.prepare(`
        SELECT id, script, data_payload, edit_log, revision, updated_at
        FROM sessions
        WHERE id = ?
      `).get(sessionId);
      return row ? {
        id: row.id,
        script: row.script,
        dataPayload: parseJson(row.data_payload, null),
        editLog: parseJson(row.edit_log, []),
        revision: Number(row.revision),
        updatedAt: row.updated_at,
      } : null;
    });
    const figures = db.prepare(`
      SELECT session_id, figure_index, revision, edit_log, history, preview_svg, manifest, code_slice, fingerprint, preview_updated_at
      FROM project_figures
      WHERE project_id = ?
      ORDER BY figure_index ASC
    `).all(projectId).map((row) => ({
      sessionId: row.session_id,
      figureIndex: Number(row.figure_index),
      revision: Number(row.revision),
      editLog: parseJson(row.edit_log, []),
      history: parseJson(row.history, { past: [], future: [] }),
      previewSvg: row.preview_svg,
      manifest: parseJson(row.manifest, null),
      codeSlice: parseJson(row.code_slice, null),
      fingerprint: row.fingerprint,
      previewUpdatedAt: row.preview_updated_at,
    }));
    const renderCache = db.prepare(`
      SELECT cache_key, svg, manifest, code_slice
      FROM render_cache
      ORDER BY cache_key ASC
    `).all().map((row) => ({
      cacheKey: row.cache_key,
      svg: row.svg,
      manifest: parseJson(row.manifest, null),
      codeSlice: parseJson(row.code_slice, null),
    }));
    const exportAssets = db.prepare(`
      SELECT id, figure_id, name, format, dpi, file_path, thumbnail_svg, metadata, tags, created_at
      FROM export_assets
      WHERE project_id = ?
      ORDER BY id ASC
    `).all(projectId).map((row) => ({
      id: row.id,
      figureId: row.figure_id,
      name: row.name,
      format: row.format,
      dpi: row.dpi,
      filePath: row.file_path,
      thumbnailSvg: row.thumbnail_svg,
      metadata: parseJson(row.metadata, {}),
      tags: parseJson(row.tags, []),
      createdAt: row.created_at,
    }));
    const exportSnapshots = db.prepare(`
      SELECT asset_id, figure_id, schema_version, snapshot_json, snapshot_hash, created_at
      FROM export_asset_snapshots
      WHERE project_id = ?
      ORDER BY asset_id ASC
    `).all(projectId).map((row) => ({
      assetId: row.asset_id,
      figureId: row.figure_id,
      schemaVersion: Number(row.schema_version),
      snapshotJson: parseJson(row.snapshot_json, null),
      snapshotHash: row.snapshot_hash,
      createdAt: row.created_at,
    }));
    return {
      sessions,
      figures,
      renderCache,
      exportAssets,
      exportSnapshots,
      exportFiles: listFiles(projectExportsDir(projectId)),
    };
  } finally {
    db.close();
  }
}

function readGlobalRenderState() {
  const db = openDb(true);
  try {
    return {
      sessions: Number(db.prepare('SELECT COUNT(*) AS count FROM sessions').get().count || 0),
      projectFigures: Number(db.prepare('SELECT COUNT(*) AS count FROM project_figures').get().count || 0),
      renderCache: Number(db.prepare('SELECT COUNT(*) AS count FROM render_cache').get().count || 0),
      exportAssets: Number(db.prepare('SELECT COUNT(*) AS count FROM export_assets').get().count || 0),
      exportSnapshots: Number(db.prepare('SELECT COUNT(*) AS count FROM export_asset_snapshots').get().count || 0),
    };
  } finally {
    db.close();
  }
}

function writeSessionScript(sessionId, script) {
  const db = openDb(false);
  try {
    db.prepare('UPDATE sessions SET script = ? WHERE id = ?').run(`# language: r\n${script}`, sessionId);
  } finally {
    db.close();
  }
}

function assertSameState(label, before, after, failures) {
  if (JSON.stringify(stableDeep(after)) !== JSON.stringify(stableDeep(before))) {
    failures.push(`${label} changed persisted state\nbefore=${JSON.stringify(before, null, 2)}\nafter=${JSON.stringify(after, null, 2)}`);
  }
}

function assertPerformanceServerTiming(result, failures) {
  const serverTiming = result?.performance?.server;
  if (!serverTiming || typeof serverTiming !== 'object') {
    failures.push(`R export response did not expose performance.server: ${JSON.stringify(result)}`);
    return;
  }
  for (const key of ['exportRenderMs', 'exportConvertMs', 'exportPersistMs', 'totalMs']) {
    const value = Number(serverTiming[key]);
    if (!Number.isFinite(value) || value < 0) {
      failures.push(`R export performance.server.${key} is missing or invalid: ${JSON.stringify(serverTiming)}`);
    }
  }
}

const smallRScript = [
  'library(ggplot2)',
  'df <- data.frame(x = 1:3, y = c(1.0, 2.0, 1.5))',
  'p <- ggplot(df, aes(x, y)) + geom_line(colour = "#0072B2") + geom_point(colour = "#0072B2") + theme_classic() + labs(title = "R WP9 performance")',
  'p',
].join('\n');

const oversizedRScript = [
  'library(ggplot2)',
  'n <- 800',
  'df <- data.frame(',
  '  x = rep(seq(0, 1, length.out = 40), length.out = n),',
  '  y = rep(seq(0, 1, length.out = 20), each = 40, length.out = n)',
  ')',
  'p <- ggplot(df, aes(x = x, y = y)) +',
  '  geom_point(size = 0.65, alpha = 0.85, colour = "#D55E00") +',
  '  theme_void() +',
  '  labs(title = "R WP9 oversized SVG persistence budget")',
  'p',
].join('\n');

async function createRenderedProject(token) {
  const created = await jsonRequest('/api/projects', token, {
    method: 'POST',
    body: JSON.stringify({
      name: `R WP9 performance persistence ${Date.now()}-${Math.random().toString(36).slice(2)}`,
      spec: {
        plot_type: 'custom',
        custom_script: smallRScript,
        script: smallRScript,
        script_language: 'r',
      },
    }),
  });
  assert(created.response.ok && created.data?.id, `project creation failed: ${JSON.stringify(created.data)}`);
  const projectId = created.data.id;
  const rendered = await jsonRequest(`/api/projects/${projectId}/figures/render`, token, {
    method: 'POST',
    body: JSON.stringify({
      script: smallRScript,
      editLogs: { fig_1: [] },
      language: 'r',
      requestId: `r-wp9-performance-render-${Date.now()}-${Math.random().toString(36).slice(2)}`,
    }),
  });
  assert(rendered.response.ok && rendered.data?.status === 'success', `initial R render failed: ${JSON.stringify(rendered.data)}`);
  const figure = rendered.data.figures?.find((item) => item.figureId === 'fig_1');
  assert(figure?.svg?.includes('<svg'), `initial R render returned no SVG: ${JSON.stringify(rendered.data)}`);
  assert(Number(figure.revision || 0) === 1, `initial R render revision drifted: ${JSON.stringify(figure)}`);
  return { projectId, sessionId: `${projectId}_fig_1` };
}

async function main() {
  assertIsolatedEnvironment();
  const token = await register();
  const failures = [];
  let projectId = null;

  try {
    const directBefore = readGlobalRenderState();
    const rejectedDirectRender = await jsonRequest('/api/figure/render', token, {
      method: 'POST',
      body: JSON.stringify({
        language: 'r',
        script: oversizedRScript,
        requestId: `r-wp9-oversized-direct-${Date.now()}-${Math.random().toString(36).slice(2)}`,
      }),
    });
    const directAfter = readGlobalRenderState();
    assert(rejectedDirectRender.response.status === 413, `oversized direct R render returned HTTP ${rejectedDirectRender.response.status}: ${JSON.stringify(rejectedDirectRender.data)}`);
    assert(rejectedDirectRender.data?.code === 'SVG_PERSISTENCE_BUDGET_EXCEEDED', `oversized direct R render was not rejected by the SVG budget: ${JSON.stringify(rejectedDirectRender.data)}`);
    assertSameState('oversized direct R render rejection', directBefore, directAfter, failures);

    const project = await createRenderedProject(token);
    projectId = project.projectId;

    const initialProjectState = readPersistenceState(projectId);
    const colorTarget = initialProjectState.figures[0]?.manifest?.objects?.find((object) => (
      Array.isArray(object?.editable) && object.editable.includes('color')
    ));
    assert(colorTarget?.id, `initial R manifest exposed no editable color target: ${JSON.stringify(initialProjectState.figures[0]?.manifest)}`);
    writeSessionScript(project.sessionId, oversizedRScript);
    const patchBefore = readPersistenceState(projectId);
    const rejectedPatch = await jsonRequest('/api/figure/patch', token, {
      method: 'POST',
      body: JSON.stringify({
        sessionId: project.sessionId,
        projectId,
        figureId: 'fig_1',
        baseRevision: patchBefore.figures[0].revision,
        requestId: `r-wp9-oversized-patch-${Date.now()}-${Math.random().toString(36).slice(2)}`,
        patches: [{
          op: 'set',
          mode: 'backend_patch',
          gid: colorTarget.id,
          prop: 'color',
          value: '#D55E00',
          ...(colorTarget.stableKey !== undefined ? { stableKey: colorTarget.stableKey } : {}),
          ...(colorTarget.fingerprintVersion === 2
            ? { fingerprint: colorTarget.fingerprint, fingerprintVersion: 2 }
            : {}),
          ...(colorTarget.identity !== undefined ? { identity: colorTarget.identity } : {}),
        }],
      }),
    });
    const patchAfter = readPersistenceState(projectId);
    assert(rejectedPatch.response.status === 413, `oversized R patch returned HTTP ${rejectedPatch.response.status}: ${JSON.stringify(rejectedPatch.data)}`);
    assert(rejectedPatch.data?.code === 'SVG_PERSISTENCE_BUDGET_EXCEEDED', `oversized R patch was not rejected by the SVG budget: ${JSON.stringify(rejectedPatch.data)}`);
    assertSameState('oversized R patch rejection', patchBefore, patchAfter, failures);
    writeSessionScript(project.sessionId, smallRScript);

    const exported = await jsonRequest(`/api/projects/${projectId}/export`, token, {
      method: 'POST',
      body: JSON.stringify({
        figureId: 'fig_1',
        format: 'png',
        dpi: 120,
        name: 'r-wp9-performance-png',
        saveToLibrary: true,
      }),
    });
    assert(exported.response.ok && exported.data?.status === 'success', `baseline R PNG export failed: ${exported.response.status} ${JSON.stringify(exported.data)}`);
    assert(exported.data.figures?.[0]?.asset?.assetId, `baseline R PNG export did not persist an asset: ${JSON.stringify(exported.data)}`);
    assertPerformanceServerTiming(exported.data, failures);

    writeSessionScript(project.sessionId, oversizedRScript);
    const before = readPersistenceState(projectId);
    const rejected = await jsonRequest(`/api/projects/${projectId}/export`, token, {
      method: 'POST',
      body: JSON.stringify({
        figureId: 'fig_1',
        format: 'svg',
        dpi: 120,
        name: 'r-wp9-oversized-svg',
        saveToLibrary: true,
        includeSubplots: true,
      }),
    });
    const after = readPersistenceState(projectId);

    if (rejected.response.status !== 413) {
      failures.push(`oversized R SVG export returned HTTP ${rejected.response.status}, expected 413: ${JSON.stringify(rejected.data)}`);
    }
    if (rejected.data?.status !== 'error' || rejected.data?.code !== 'SVG_PERSISTENCE_BUDGET_EXCEEDED') {
      failures.push(`oversized R SVG export was not structured SVG_PERSISTENCE_BUDGET_EXCEEDED: ${JSON.stringify(rejected.data)}`);
    }
    if (rejected.data?.figureId !== 'fig_1') {
      failures.push(`oversized R SVG export omitted figureId fig_1: ${JSON.stringify(rejected.data)}`);
    }
    if (!Number.isFinite(Number(rejected.data?.actualBytes)) || !Number.isFinite(Number(rejected.data?.limitBytes)) || Number(rejected.data?.actualBytes) <= Number(rejected.data?.limitBytes)) {
      failures.push(`oversized R SVG export omitted valid actualBytes/limitBytes: ${JSON.stringify(rejected.data)}`);
    }
    if (rejected.data?.persisted !== false) {
      failures.push(`oversized R SVG export did not explicitly report persisted:false: ${JSON.stringify(rejected.data)}`);
    }
    assertSameState('oversized R SVG export rejection', before, after, failures);

    if (failures.length > 0) {
      throw new Error(failures.join('\n\n'));
    }

    console.log(JSON.stringify({
      status: 'PASS',
      projectId,
      baselineAssetId: exported.data.figures[0].asset.assetId,
      performanceServer: exported.data.performance.server,
      oversizedBudget: {
        actualBytes: rejected.data.actualBytes,
        limitBytes: rejected.data.limitBytes,
      },
      checked: [
        'isolated random-port temp DB/data guardrails and non-3000 refusal',
        'oversized direct R render leaves sessions/project figures/render_cache/export state unchanged',
        'oversized R patch leaves revision/history/preview/editLog/render_cache unchanged',
        'R project PNG export exposes performance.server exportRenderMs/exportConvertMs/exportPersistMs/totalMs',
        'low SCIFIGURE_MAX_PERSISTED_SVG_MB triggers structured SVG_PERSISTENCE_BUDGET_EXCEEDED for oversized R SVG export',
        'oversized R SVG export leaves sessions, revisions, project figure history/preview, render_cache, export_assets/snapshots, and export files unchanged',
      ],
    }, null, 2));
  } finally {
    if (projectId) {
      await jsonRequest(`/api/projects/${projectId}`, token, { method: 'DELETE' }).catch(() => null);
    }
  }
}

main().catch((error) => {
  console.error(JSON.stringify({
    status: 'FAIL',
    message: error.message,
    stack: error.stack,
  }, null, 2));
  process.exitCode = 1;
});
