import Database from 'better-sqlite3';
import os from 'node:os';
import path from 'node:path';

const BASE_URL = process.env.SCIFIGURE_URL || 'http://localhost:3000';

const OPTIONAL_EXTENSION_PACKAGES = [
  'ggrepel',
  'ggnewscale',
  'sf',
  'ggraph',
  'igraph',
  'tidygraph',
  'semPlot',
  'DiagrammeR',
];

const coordSfScript = [
  'library(ggplot2)',
  '',
  'df <- data.frame(',
  '  id = c("site-a", "site-b"),',
  '  x = c(1, 2),',
  '  y = c(1.2, 2.1),',
  '  label = c("Site A", "Site B")',
  ')',
  '',
  'p <- ggplot(df, aes(x, y)) +',
  '  geom_point(size = 3, colour = "#1F78B4") +',
  '  geom_text(aes(label = label), nudge_y = 0.12) +',
  '  theme_classic()',
  '',
  'coord_sf_shadow <- coord_cartesian()',
  'class(coord_sf_shadow) <- c("CoordSf", class(coord_sf_shadow))',
  'p$coordinates <- coord_sf_shadow',
  'p',
].join('\n');

const baseRScript = [
  'x <- 1:5',
  'y <- c(1.0, 1.8, 1.4, 2.6, 3.1)',
  'plot(x, y, type = "b", col = "#2C7FB8", xlab = "Time", ylab = "Response")',
].join('\n');

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

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function stableDeep(value) {
  if (Array.isArray(value)) return value.map(stableDeep);
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(Object.keys(value).sort().map((key) => [key, stableDeep(value[key])]));
}

function assertSameState(label, before, after) {
  assert(
    JSON.stringify(stableDeep(after)) === JSON.stringify(stableDeep(before)),
    `${label} changed persisted state\nbefore=${JSON.stringify(before, null, 2)}\nafter=${JSON.stringify(after, null, 2)}`,
  );
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
      email: `r-wp8-boundaries-${Date.now()}-${Math.random().toString(36).slice(2)}@example.test`,
      password: 'R-WP8-Extension-Boundaries-2026',
    }),
  });
  assert(result.response.ok && result.data?.token, `registration failed: ${JSON.stringify(result.data)}`);
  return result.data.token;
}

function openReadonlyDb() {
  const db = new Database(process.env.SCIFIGURE_DB_PATH, { readonly: true });
  db.pragma('busy_timeout = 5000');
  return db;
}

function readProjectBoundaryState(projectId) {
  const db = openReadonlyDb();
  try {
    const sessionId = `${projectId}_fig_1`;
    const session = db.prepare('SELECT id, edit_log, revision FROM sessions WHERE id = ?').get(sessionId);
    const figure = db.prepare(`
      SELECT session_id, revision, edit_log, history, preview_svg, manifest, code_slice, fingerprint, preview_updated_at
      FROM project_figures
      WHERE project_id = ? AND figure_index = 0
    `).get(projectId);
    const renderCache = db.prepare('SELECT cache_key, svg, manifest, code_slice FROM render_cache ORDER BY cache_key').all();
    return {
      session: session ? {
        id: session.id,
        revision: Number(session.revision),
        editLog: parseJson(session.edit_log, []),
      } : null,
      figure: figure ? {
        sessionId: figure.session_id,
        revision: Number(figure.revision),
        editLog: parseJson(figure.edit_log, []),
        history: parseJson(figure.history, { past: [], future: [] }),
        previewSvg: figure.preview_svg,
        manifest: parseJson(figure.manifest, null),
        codeSlice: parseJson(figure.code_slice, null),
        fingerprint: figure.fingerprint,
        previewUpdatedAt: figure.preview_updated_at,
      } : null,
      renderCache: renderCache.map((row) => ({
        cacheKey: row.cache_key,
        svg: row.svg,
        manifest: parseJson(row.manifest, null),
        codeSlice: parseJson(row.code_slice, null),
      })),
    };
  } finally {
    db.close();
  }
}

function readStandaloneBoundaryState(sessionId) {
  const db = openReadonlyDb();
  try {
    const session = db.prepare('SELECT id, edit_log, revision FROM sessions WHERE id = ?').get(sessionId);
    const renderCache = db.prepare('SELECT cache_key, svg, manifest, code_slice FROM render_cache ORDER BY cache_key').all();
    return {
      session: session ? {
        id: session.id,
        revision: Number(session.revision),
        editLog: parseJson(session.edit_log, []),
      } : null,
      renderCache: renderCache.map((row) => ({
        cacheKey: row.cache_key,
        svg: row.svg,
        manifest: parseJson(row.manifest, null),
        codeSlice: parseJson(row.code_slice, null),
      })),
    };
  } finally {
    db.close();
  }
}

function identityFields(object) {
  return {
    ...(object.stableKey !== undefined ? { stableKey: object.stableKey } : {}),
    ...(object.fingerprintVersion === 2
      ? { fingerprint: object.fingerprint, fingerprintVersion: 2 }
      : {}),
    ...(object.identity !== undefined ? { identity: clone(object.identity) } : {}),
  };
}

function makePatch(object, prop, value, mode = 'backend_patch') {
  return {
    op: 'set',
    mode,
    gid: object.id,
    prop,
    value,
    ...identityFields(object),
  };
}

function isSamePatch(left, right) {
  return left?.gid === right.gid
    && left?.prop === right.prop
    && JSON.stringify(left?.value) === JSON.stringify(right.value);
}

function assertRejectedAll(label, result, patches, expectedRevision) {
  assert(result.response.ok, `${label} failed at HTTP layer: ${result.response.status} ${JSON.stringify(result.data)}`);
  assert(result.data?.status === 'conflict', `${label} should return business conflict: ${JSON.stringify(result.data)}`);
  assert(Number(result.data?.revision) === expectedRevision, `${label} changed response revision: ${JSON.stringify(result.data)}`);
  assert(Array.isArray(result.data?.applied) && result.data.applied.length === 0, `${label} applied part of the batch: ${JSON.stringify(result.data)}`);
  for (const patch of patches) {
    assert(
      Array.isArray(result.data?.rejected) && result.data.rejected.some((entry) => isSamePatch(entry, patch)),
      `${label} did not report rejected patch ${JSON.stringify(patch)}: ${JSON.stringify(result.data)}`,
    );
  }
}

async function createCoordSfProject(token) {
  const created = await jsonRequest('/api/projects', token, {
    method: 'POST',
    body: JSON.stringify({
      name: `R WP8 CoordSf boundary ${Date.now()}-${Math.random().toString(36).slice(2)}`,
      spec: {
        plot_type: 'custom',
        custom_script: coordSfScript,
        script: coordSfScript,
        script_language: 'r',
      },
    }),
  });
  assert(created.response.ok && created.data?.id, `CoordSf project creation failed: ${JSON.stringify(created.data)}`);
  const projectId = created.data.id;
  const rendered = await jsonRequest(`/api/projects/${projectId}/figures/render`, token, {
    method: 'POST',
    body: JSON.stringify({
      script: coordSfScript,
      editLogs: { fig_1: [] },
      language: 'r',
      requestId: `r-wp8-coordsf-render-${Date.now()}-${Math.random().toString(36).slice(2)}`,
    }),
  });
  assert(rendered.response.ok && rendered.data?.status === 'success', `CoordSf initial render failed: ${JSON.stringify(rendered.data)}`);
  const figure = rendered.data?.figures?.find((item) => item.figureId === 'fig_1');
  assert(figure?.manifest?.objects?.length > 0, `CoordSf initial render returned no manifest: ${JSON.stringify(rendered.data)}`);
  return { projectId, figure };
}

async function submitProjectPatch(token, projectId, patches, baseRevision, label) {
  return jsonRequest('/api/figure/patch', token, {
    method: 'POST',
    body: JSON.stringify({
      requestId: `r-wp8-${label}-${Date.now()}-${Math.random().toString(36).slice(2)}`,
      sessionId: `${projectId}_fig_1`,
      projectId,
      figureId: 'fig_1',
      baseRevision,
      patches,
    }),
  });
}

async function submitStandalonePatch(token, sessionId, patches, baseRevision, label) {
  return jsonRequest('/api/figure/patch', token, {
    method: 'POST',
    body: JSON.stringify({
      requestId: `r-wp8-${label}-${Date.now()}-${Math.random().toString(36).slice(2)}`,
      sessionId,
      baseRevision,
      patches,
    }),
  });
}

function findCoordSfTextObject(manifest) {
  const textObject = (manifest?.objects || []).find((object) => object?.role === 'ggplot_text_data');
  assert(textObject?.id, `CoordSf manifest is missing ggplot text data object: ${JSON.stringify(manifest)}`);
  assert(textObject.currentProps?.positionCoordinateClass === 'CoordSf', `CoordSf text object lost coordinate class: ${JSON.stringify(textObject)}`);
  assert(textObject.currentProps?.positionAdapterStatus === 'shadow_unsupported', `CoordSf text object lost shadow diagnostic: ${JSON.stringify(textObject)}`);
  assert(!textObject.editable?.includes('position'), `CoordSf text object exposed position as editable: ${JSON.stringify(textObject)}`);
  assert(
    !textObject.propertyCapabilities?.some((capability) => capability?.prop === 'position'),
    `CoordSf text object exposed position capability: ${JSON.stringify(textObject)}`,
  );
  assert(textObject.editable?.includes('color'), `CoordSf text object needs a valid style prop for mixed-batch coverage: ${JSON.stringify(textObject)}`);
  return textObject;
}

async function verifyCoordSfMixedBatchRejection(token) {
  const { projectId, figure } = await createCoordSfProject(token);
  const baselineRevision = Number(figure.revision || 1);
  const textObject = findCoordSfTextObject(figure.manifest);
  const patches = [
    makePatch(textObject, 'color', '#00AA00'),
    makePatch(textObject, 'position', { x: 1.5, y: 1.5, coord_system: 'data' }),
  ];
  const before = readProjectBoundaryState(projectId);
  const result = await submitProjectPatch(token, projectId, patches, baselineRevision, 'coordsf-mixed-atomic-rejection');
  assertRejectedAll('CoordSf mixed style/position batch', result, patches, baselineRevision);
  assertSameState('CoordSf mixed style/position rejection', before, readProjectBoundaryState(projectId));
  return { projectId, baselineRevision };
}

async function verifyBaseRZeroPersistence(token) {
  const rendered = await jsonRequest('/api/figure/render', token, {
    method: 'POST',
    body: JSON.stringify({
      script: baseRScript,
      language: 'r',
      dataPayload: null,
      editLog: [],
      renderOptions: { width_in: 7, height_in: 5 },
    }),
  });
  assert(rendered.response.ok && rendered.data?.status === 'success', `base R initial render failed: ${JSON.stringify(rendered.data)}`);
  assert(rendered.data?.sessionId, `base R render did not persist a standalone session: ${JSON.stringify(rendered.data)}`);
  assert(Array.isArray(rendered.data?.manifest?.objects) && rendered.data.manifest.objects.length === 0, `base R should expose no objects: ${JSON.stringify(rendered.data?.manifest)}`);
  assert(rendered.data?.manifest?.capabilities?.backendPatch === false, `base R should disable backendPatch: ${JSON.stringify(rendered.data?.manifest)}`);
  assert(String(rendered.data?.svg || '').includes('<svg'), 'base R preview did not return SVG');

  const sessionId = rendered.data.sessionId;
  const baselineRevision = Number(rendered.data.revision || 1);
  const rejectedPatch = {
    op: 'set',
    mode: 'backend_patch',
    gid: 'r.layer.0',
    prop: 'color',
    value: '#00AA00',
  };
  const before = readStandaloneBoundaryState(sessionId);
  const result = await submitStandalonePatch(token, sessionId, [rejectedPatch], baselineRevision, 'base-r-object-patch');
  assertRejectedAll('base R object patch', result, [rejectedPatch], baselineRevision);
  assertSameState('base R object patch rejection', before, readStandaloneBoundaryState(sessionId));
  return { sessionId, baselineRevision };
}

function assertNoLocalPathLeak(label, value) {
  const serialized = JSON.stringify(value);
  const knownLocalPaths = [
    process.cwd(),
    process.env.SCIFIGURE_DATA_DIR,
    process.env.SCIFIGURE_DB_PATH,
  ].filter(Boolean).map((entry) => path.resolve(entry).replace(/\\/g, '/'));
  const normalized = serialized.replace(/\\\\/g, '/').replace(/\\/g, '/');
  for (const localPath of knownLocalPaths) {
    assert(!normalized.includes(localPath), `${label} leaked local path ${localPath}: ${serialized}`);
  }
  assert(!/[A-Za-z]:\/[^"\\\s]+/.test(normalized), `${label} leaked a Windows absolute path: ${serialized}`);
  assert(!normalized.includes(os.tmpdir().replace(/\\/g, '/')), `${label} leaked OS temp path: ${serialized}`);
}

function chooseMissingExtensionPackage(inventory) {
  const packages = inventory?.packages || {};
  return OPTIONAL_EXTENSION_PACKAGES.find((packageName) => packages[packageName]?.installed === false)
    || 'scifigureMissingExtensionPackageForDiagnostics';
}

async function verifyMissingExtensionPackageDiagnostic(token, inventory) {
  const packageName = chooseMissingExtensionPackage(inventory);
  const result = await jsonRequest('/api/figure/render', token, {
    method: 'POST',
    body: JSON.stringify({
      script: `library("${packageName}")\nplot(1:2, 1:2)`,
      language: 'r',
      editLog: [],
      renderOptions: { width_in: 7, height_in: 5 },
    }),
  });
  assert(result.response.ok, `missing extension package render failed at HTTP layer: ${result.response.status} ${JSON.stringify(result.data)}`);
  assert(result.data?.status === 'error', `missing extension package should be a structured render error: ${JSON.stringify(result.data)}`);
  const diagnostic = result.data?.diagnostic || {};
  assert(diagnostic.type === 'missing_package' && diagnostic.category === 'missing_package', `missing extension package was misclassified: ${JSON.stringify(result.data)}`);
  assert(diagnostic.severity === 'error' && diagnostic.schemaVersion === '1.0', `missing extension package diagnostic contract drifted: ${JSON.stringify(diagnostic)}`);
  assert(diagnostic.details?.package === packageName, `missing extension package diagnostic omitted package name: ${JSON.stringify(diagnostic)}`);
  assert(typeof result.data.message === 'string' && result.data.message.length > 0, `missing extension package response has no readable message: ${JSON.stringify(result.data)}`);
  assert(typeof diagnostic.message === 'string' && diagnostic.message.includes(packageName), `missing extension package diagnostic message is not user readable: ${JSON.stringify(diagnostic)}`);
  assert(typeof diagnostic.suggestion === 'string' && diagnostic.suggestion.length > 10, `missing extension package diagnostic has no useful suggestion: ${JSON.stringify(diagnostic)}`);
  assertNoLocalPathLeak('missing extension package response', result.data);
  const publicInventory = result.data.runtimeInventory || {};
  for (const privateKey of ['executable', 'libraryPaths', 'environment', 'workingDirectory', 'temporaryDirectory', 'fonts']) {
    assert(!(privateKey in publicInventory), `missing package response exposed runtimeInventory.${privateKey}: ${JSON.stringify(result.data)}`);
  }
  assert(!('home' in (publicInventory.r || {})), `missing package response exposed R home: ${JSON.stringify(result.data)}`);
  return { packageName };
}

async function main() {
  assertIsolatedEnvironment();
  const token = await register();
  const projectIds = [];
  try {
    const coordSf = await verifyCoordSfMixedBatchRejection(token);
    projectIds.push(coordSf.projectId);
    const baseR = await verifyBaseRZeroPersistence(token);
    const baseRRender = await jsonRequest('/api/figure/render', token, {
      method: 'POST',
      body: JSON.stringify({
        script: 'plot(1:2, 1:2, main = "Runtime inventory")',
        language: 'r',
        editLog: [],
        renderOptions: { width_in: 7, height_in: 5 },
      }),
    });
    assert(baseRRender.response.ok && baseRRender.data?.status === 'success', `runtime inventory render failed: ${JSON.stringify(baseRRender.data)}`);
    const missing = await verifyMissingExtensionPackageDiagnostic(token, baseRRender.data.runtimeInventory);

    console.log(JSON.stringify({
      status: 'PASS',
      coordSfProjectId: coordSf.projectId,
      baseRSessionId: baseR.sessionId,
      missingPackage: missing.packageName,
      checked: [
        'CoordSf mixed valid style plus readonly position batch was rejected atomically',
        'CoordSf rejection left session revision/editLog, project figure revision/editLog/history, and render cache unchanged',
        'base R preview exposed no patchable objects and rejected object patch without session/cache persistence',
        'missing extension package diagnostic stayed structured, user-readable, and free of local path leaks',
      ],
    }, null, 2));
  } finally {
    for (const projectId of projectIds) {
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
