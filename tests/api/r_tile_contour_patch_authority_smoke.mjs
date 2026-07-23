import Database from 'better-sqlite3';
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
      email: `r-tile-contour-${Date.now()}-${Math.random().toString(36).slice(2)}@example.test`,
      password: 'R-Tile-Contour-Authority-2026',
    }),
  });
  assert(result.response.ok && result.data?.token, `registration failed: ${JSON.stringify(result.data)}`);
  return result.data.token;
}

const tileRasterRectScript = [
  'library(ggplot2)',
  'df <- expand.grid(x = 1:4, y = 1:3)',
  'df$value <- seq_len(nrow(df)) / 10',
  'p <- ggplot(df, aes(x = x, y = y, fill = value)) +',
  '  geom_tile(colour = "#333333", linewidth = 0.35, alpha = 0.85) +',
  '  geom_raster(alpha = 0.55) +',
  '  geom_rect(',
  '    aes(xmin = x - 0.45, xmax = x + 0.45, ymin = y - 0.45, ymax = y + 0.45),',
  '    inherit.aes = TRUE,',
  '    colour = "#111111",',
  '    linewidth = 0.25,',
  '    alpha = 0.35',
  '  ) +',
  '  scale_fill_gradient(low = "#132B43", high = "#56B1F7", limits = c(0, 2), name = "Intensity") +',
  '  theme_classic()',
  'p',
].join('\n');

const contourScript = [
  'library(ggplot2)',
  'df <- expand.grid(x = seq(-2, 2, length.out = 15), y = seq(-2, 2, length.out = 15))',
  'df$z <- with(df, x^2 + y^2)',
  'p <- ggplot(df, aes(x = x, y = y, z = z)) +',
  '  geom_contour(aes(colour = after_stat(level)), bins = 5, linewidth = 0.65) +',
  '  geom_contour_filled(bins = 5, alpha = 0.7) +',
  '  scale_colour_viridis_c(name = "Contour level") +',
  '  scale_fill_viridis_d(name = "Contour bands") +',
  '  theme_classic()',
  'p',
].join('\n');

function identityFields(object) {
  return {
    ...(object.stableKey !== undefined ? { stableKey: object.stableKey } : {}),
    ...(object.fingerprintVersion === 2
      ? { fingerprint: object.fingerprint, fingerprintVersion: 2 }
      : {}),
    ...(object.identity !== undefined ? { identity: clone(object.identity) } : {}),
  };
}

function isSamePatch(left, right) {
  return left?.gid === right?.gid
    && left?.prop === right?.prop
    && JSON.stringify(left?.value) === JSON.stringify(right?.value);
}

function patchValue(prop, numberValue, colorValue, stringValue = 'solid') {
  const normalized = String(prop).toLowerCase();
  if (normalized.includes('color')) return colorValue;
  if (normalized.includes('style')) return stringValue;
  if (prop === 'cmap') return 'plasma';
  if (prop === 'visible') return false;
  return numberValue;
}

function capabilityProps(object) {
  return Array.isArray(object?.propertyCapabilities)
    ? object.propertyCapabilities.map((capability) => capability?.prop)
    : [];
}

function assertCapabilityAuthority(object, label, expectedProps, rejectedProps) {
  assert(Array.isArray(object?.propertyCapabilities), `${label} did not expose modern propertyCapabilities: ${JSON.stringify(object)}`);
  const props = capabilityProps(object);
  for (const prop of expectedProps) {
    const capability = object.propertyCapabilities.find((item) => item?.prop === prop);
    assert(capability, `${label} did not expose editable capability ${prop}: ${JSON.stringify(object)}`);
    assert(capability.patchMode === 'backend_patch', `${label}.${prop} is not backend authoritative: ${JSON.stringify(capability)}`);
    assert(capability.replay !== 'unsupported', `${label}.${prop} is not replayable: ${JSON.stringify(capability)}`);
  }
  for (const prop of rejectedProps) {
    assert(!props.includes(prop), `${label} incorrectly exposes structural/unsupported ${prop}: ${JSON.stringify(object)}`);
    assert(!Array.isArray(object.editable) || !object.editable.includes(prop), `${label} editable list incorrectly exposes ${prop}: ${JSON.stringify(object)}`);
  }
}

function readDatabaseState(projectId, standaloneSessionId) {
  const database = new Database(process.env.SCIFIGURE_DB_PATH, { readonly: true });
  try {
    database.pragma('busy_timeout = 5000');
    const sessionIds = [projectId ? `${projectId}_fig_1` : null, standaloneSessionId].filter(Boolean);
    const sessions = Object.fromEntries(sessionIds.map((sessionId) => {
      const row = database.prepare('SELECT id, edit_log, revision FROM sessions WHERE id = ?').get(sessionId);
      return [sessionId, row ? { revision: Number(row.revision), editLog: parseJson(row.edit_log, []) } : null];
    }));
    const figure = projectId
      ? database.prepare(`
          SELECT session_id, revision, edit_log, history, preview_svg, manifest, code_slice, fingerprint, preview_updated_at
          FROM project_figures
          WHERE project_id = ? AND figure_index = 0
        `).get(projectId)
      : null;
    const renderCache = database.prepare('SELECT cache_key, svg, manifest, code_slice FROM render_cache ORDER BY cache_key').all();
    const exportAssets = projectId
      ? database.prepare(`
          SELECT id, figure_id, name, format, dpi, metadata, tags, created_at
          FROM export_assets
          WHERE project_id = ?
          ORDER BY id
        `).all(projectId)
      : [];
    const exportSnapshots = projectId
      ? database.prepare(`
          SELECT asset_id, figure_id, schema_version, snapshot_hash, snapshot_json, created_at
          FROM export_asset_snapshots
          WHERE project_id = ?
          ORDER BY asset_id
        `).all(projectId)
      : [];
    return {
      sessions,
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
      exportAssets: exportAssets.map((row) => ({
        ...row,
        metadata: parseJson(row.metadata, {}),
        tags: parseJson(row.tags, []),
      })),
      exportSnapshots: exportSnapshots.map((row) => ({
        ...row,
        schemaVersion: Number(row.schema_version),
        snapshotJson: parseJson(row.snapshot_json, null),
      })),
    };
  } finally {
    database.close();
  }
}

function findTarget(manifest, adapterClass, expectedProps, rejectedProps) {
  const object = (manifest?.objects || []).find((candidate) => (
    candidate?.source?.adapterClass === adapterClass
    || candidate?.currentProps?.adapterFamily === adapterClass.replace(/^Geom/, '').toLowerCase()
  ));
  assert(object?.id, `R render did not expose ${adapterClass}: ${JSON.stringify(manifest)}`);
  assertCapabilityAuthority(object, adapterClass, expectedProps, rejectedProps);
  return object;
}

async function createProject(token, script, label) {
  const created = await jsonRequest('/api/projects', token, {
    method: 'POST',
    body: JSON.stringify({
      name: `${label} ${Date.now()}`,
      spec: { plot_type: 'custom', custom_script: script, script, script_language: 'r' },
    }),
  });
  assert(created.response.ok && created.data?.id, `${label} project creation failed: ${JSON.stringify(created.data)}`);
  const projectId = created.data.id;
  const rendered = await jsonRequest(`/api/projects/${projectId}/figures/render`, token, {
    method: 'POST',
    body: JSON.stringify({
      script,
      editLogs: { fig_1: [] },
      language: 'r',
      requestId: `${label}-render-${Date.now()}-${Math.random().toString(36).slice(2)}`,
    }),
  });
  assert(rendered.response.ok && rendered.data?.status === 'success', `${label} initial render failed: ${JSON.stringify(rendered.data)}`);
  const figure = rendered.data.figures?.find((item) => item.figureId === 'fig_1');
  assert(figure?.manifest?.objects?.length > 0, `${label} initial render did not return fig_1 manifest`);
  return { projectId, figure };
}

async function createStandaloneSession(token) {
  const rendered = await jsonRequest('/api/figure/render', token, {
    method: 'POST',
    body: JSON.stringify({
      script: contourScript,
      language: 'r',
      dataPayload: null,
      editLog: [],
      renderOptions: { dpi: 150 },
    }),
  });
  assert(rendered.response.ok && rendered.data?.status === 'success', `standalone R contour render failed: ${JSON.stringify(rendered.data)}`);
  assert(rendered.data?.sessionId, `standalone R render did not return a sessionId: ${JSON.stringify(rendered.data)}`);
  const contour = findTarget(rendered.data.manifest, 'GeomContour', ['linewidth', 'alpha', 'cmap', 'vmin', 'vmax'], ['levels', 'x', 'y', 'z', 'bins', 'breaks']);
  return {
    sessionId: rendered.data.sessionId,
    revision: Number(rendered.data.revision || 1),
    contour,
  };
}

async function submitProjectPatch(token, projectId, patches, baseRevision) {
  return jsonRequest('/api/figure/patch', token, {
    method: 'POST',
    body: JSON.stringify({
      requestId: `r-tile-contour-${Date.now()}-${Math.random().toString(36).slice(2)}`,
      sessionId: `${projectId}_fig_1`,
      projectId,
      figureId: 'fig_1',
      baseRevision,
      patches,
    }),
  });
}

async function submitStandalonePatch(token, sessionId, patches, baseRevision) {
  return jsonRequest('/api/figure/patch', token, {
    method: 'POST',
    body: JSON.stringify({
      requestId: `r-tile-contour-${Date.now()}-${Math.random().toString(36).slice(2)}`,
      sessionId,
      baseRevision,
      patches,
    }),
  });
}

function assertAcceptedPatch(label, result, expectedPatch, expectedRevision) {
  assert(result.response.ok && result.data?.status === 'success', `${label} did not succeed: ${JSON.stringify(result.data)}`);
  assert(Number(result.data?.revision) === expectedRevision + 1, `${label} did not increment revision exactly once: ${JSON.stringify(result.data)}`);
  const applied = result.data?.applied?.find((entry) => isSamePatch(entry, expectedPatch));
  assert(applied, `${label} did not report the applied patch: ${JSON.stringify(result.data)}`);
  assert(applied.mode === 'backend_patch', `${label} trusted client mode instead of backend authority: ${JSON.stringify(applied)}`);
}

function assertAcceptedPatches(label, result, expectedPatches, expectedRevision) {
  for (const patch of expectedPatches) {
    assertAcceptedPatch(label, result, patch, expectedRevision);
  }
}

function assertHasPatch(label, editLog, expectedPatch, expectedMode = null) {
  const matched = Array.isArray(editLog)
    ? editLog.find((entry) => isSamePatch(entry, expectedPatch))
    : null;
  assert(matched, `${label} is missing ${JSON.stringify(expectedPatch)}: ${JSON.stringify(editLog)}`);
  if (expectedMode) {
    assert(matched.mode === expectedMode, `${label} persisted mode ${matched.mode} instead of ${expectedMode}: ${JSON.stringify(matched)}`);
  }
  return matched;
}

function assertMissingPatch(label, editLog, expectedPatch) {
  assert(
    !Array.isArray(editLog) || !editLog.some((entry) => isSamePatch(entry, expectedPatch)),
    `${label} unexpectedly contains ${JSON.stringify(expectedPatch)}: ${JSON.stringify(editLog)}`,
  );
}

function manifestHasPatchValue(manifest, expectedPatch) {
  const object = (manifest?.objects || []).find((candidate) => candidate?.id === expectedPatch.gid);
  const actual = object?.currentProps?.[expectedPatch.prop];
  if (typeof expectedPatch.value === 'string') {
    return String(actual).toLowerCase() === expectedPatch.value.toLowerCase();
  }
  return Math.abs(Number(actual) - Number(expectedPatch.value)) < 1e-9;
}

function assertPersistedProjectPatches(projectId, standaloneSessionId, patches, expectedRevision, label) {
  const state = readDatabaseState(projectId, standaloneSessionId);
  assert(Number(state.sessions[`${projectId}_fig_1`]?.revision) === expectedRevision, `${label} session revision mismatch`);
  assert(Number(state.figure?.revision) === expectedRevision, `${label} Figure revision mismatch`);
  for (const patch of patches) {
    assertHasPatch(`${label} session edit log`, state.sessions[`${projectId}_fig_1`]?.editLog, patch, 'backend_patch');
    assertHasPatch(`${label} Figure edit log`, state.figure?.editLog, patch, 'backend_patch');
    assert(manifestHasPatchValue(state.figure?.manifest, patch), `${label} manifest did not confirm ${patch.gid}.${patch.prop}`);
  }
  return state;
}

async function exportProjectSnapshot(token, projectId) {
  const result = await jsonRequest(`/api/projects/${projectId}/export`, token, {
    method: 'POST',
    body: JSON.stringify({
      figureId: 'fig_1',
      format: 'svg',
      dpi: 150,
      saveToLibrary: true,
      name: `r-tile-contour-export-${Date.now()}`,
    }),
  });
  assert(result.response.ok && result.data?.status === 'success', `R family 8 export failed: ${JSON.stringify(result.data)}`);
  const exportedFigure = result.data?.figures?.[0];
  const asset = exportedFigure?.asset;
  assert(asset?.assetId && asset.hasEditingSnapshot === true, `R family 8 export did not create a restorable snapshot: ${JSON.stringify(result.data)}`);
  assert(String(exportedFigure?.svg || '').includes('<svg'), 'R family 8 export did not return SVG output');
  return { asset, exportedFigure };
}

function assertConflictResponse(label, result, rejectedPatches, expectedRevision) {
  assert(result.response.ok, `${label} failed at HTTP layer: ${result.response.status} ${JSON.stringify(result.data)}`);
  assert(result.data?.status === 'conflict', `${label} should return conflict: ${JSON.stringify(result.data)}`);
  assert(Number(result.data?.revision) === expectedRevision, `${label} changed response revision: ${JSON.stringify(result.data)}`);
  assert(Array.isArray(result.data?.applied) && result.data.applied.length === 0, `${label} should apply nothing: ${JSON.stringify(result.data)}`);
  for (const patch of rejectedPatches) {
    assert(
      Array.isArray(result.data?.rejected) && result.data.rejected.some((entry) => isSamePatch(entry, patch)),
      `${label} response did not identify rejected patch ${JSON.stringify(patch)}: ${JSON.stringify(result.data)}`,
    );
  }
}

async function assertNoPersistence(projectId, standaloneSessionId, label, patchBody, rejectedPatches, expectedRevision) {
  const before = readDatabaseState(projectId, standaloneSessionId);
  const result = await patchBody();
  assertConflictResponse(label, result, rejectedPatches, expectedRevision);
  const after = readDatabaseState(projectId, standaloneSessionId);
  assertSameState(label, before, after);
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

async function main() {
  assertIsolatedEnvironment();
  const token = await register();
  const projectIds = [];
  try {
    const tileProject = await createProject(token, tileRasterRectScript, 'R tile raster rect authority');
    projectIds.push(tileProject.projectId);
    const contourProject = await createProject(token, contourScript, 'R contour authority');
    projectIds.push(contourProject.projectId);
    const standalone = await createStandaloneSession(token);

    const tile = findTarget(tileProject.figure.manifest, 'GeomTile', ['edgecolor', 'linewidth', 'alpha'], ['facecolor', 'cmap', 'vmin', 'vmax']);
    const raster = findTarget(tileProject.figure.manifest, 'GeomRaster', ['alpha'], ['edgecolor', 'linewidth', 'facecolor', 'cmap']);
    const rect = findTarget(tileProject.figure.manifest, 'GeomRect', ['edgecolor', 'linewidth', 'alpha'], ['facecolor', 'cmap', 'vmin', 'vmax']);
    const contour = findTarget(contourProject.figure.manifest, 'GeomContour', ['linewidth', 'alpha', 'cmap', 'vmin', 'vmax'], ['levels', 'x', 'y', 'z', 'bins', 'breaks']);
    const contourf = findTarget(contourProject.figure.manifest, 'GeomContourFilled', ['edgecolor', 'linewidth', 'alpha'], ['levels', 'x', 'y', 'z', 'bins', 'breaks']);

    let tileRevision = Number(tileProject.figure.revision || 1);
    let contourRevision = Number(contourProject.figure.revision || 1);
    let standaloneRevision = standalone.revision;

    const tileStyleBatch = [
      makePatch(tile, 'edgecolor', '#AA00AA', 'local_patch'),
      makePatch(tile, 'linewidth', 1.25),
      makePatch(raster, 'alpha', 0.42, 'local_patch'),
      makePatch(rect, 'edgecolor', '#D95F0E'),
      makePatch(rect, 'linewidth', 1.1, 'local_patch'),
    ];
    const tileAccepted = await submitProjectPatch(token, tileProject.projectId, tileStyleBatch, tileRevision);
    assertAcceptedPatches('tile/raster/rect legal style batch', tileAccepted, tileStyleBatch, tileRevision);
    tileRevision += 1;
    assertPersistedProjectPatches(tileProject.projectId, standalone.sessionId, tileStyleBatch, tileRevision, 'tile/raster/rect legal style batch');

    const standaloneFakeLocalPatch = makePatch(standalone.contour, 'linewidth', 1.9, 'local_patch');
    const standaloneAccepted = await submitStandalonePatch(
      token,
      standalone.sessionId,
      [standaloneFakeLocalPatch],
      standaloneRevision,
    );
    assertAcceptedPatch('standalone contour client-declared local patch', standaloneAccepted, standaloneFakeLocalPatch, standaloneRevision);
    standaloneRevision += 1;
    const standaloneState = readDatabaseState(null, standalone.sessionId);
    assert(Number(standaloneState.sessions[standalone.sessionId]?.revision) === standaloneRevision, 'standalone contour patch did not persist revision');
    assertHasPatch('standalone contour edit log', standaloneState.sessions[standalone.sessionId]?.editLog, standaloneFakeLocalPatch, 'backend_patch');

    const exportTimePatches = [
      makePatch(contour, 'cmap', 'plasma', 'local_patch'),
      makePatch(contour, 'vmin', 0.25),
      makePatch(contour, 'vmax', 6.75, 'local_patch'),
      makePatch(contourf, 'edgecolor', '#111111'),
      makePatch(contourf, 'linewidth', 1.35, 'local_patch'),
      makePatch(contourf, 'alpha', 0.45),
    ];
    const contourAccepted = await submitProjectPatch(token, contourProject.projectId, exportTimePatches, contourRevision);
    assertAcceptedPatches('contour/contourf legal style batch', contourAccepted, exportTimePatches, contourRevision);
    contourRevision += 1;
    assertPersistedProjectPatches(contourProject.projectId, standalone.sessionId, exportTimePatches, contourRevision, 'contour/contourf export-time style batch');

    const exported = await exportProjectSnapshot(token, contourProject.projectId);
    const exportedState = readDatabaseState(contourProject.projectId, standalone.sessionId);
    const exportedSnapshot = exportedState.exportSnapshots.find((row) => row.asset_id === exported.asset.assetId);
    assert(exportedSnapshot?.snapshotJson, `R family 8 export snapshot was not persisted: ${JSON.stringify(exportedState.exportSnapshots)}`);
    const snapshotFigure = exportedSnapshot.snapshotJson?.figures?.find((figure) => figure.figureId === 'fig_1');
    for (const patch of exportTimePatches) {
      assertHasPatch('R family 8 export snapshot', snapshotFigure?.editLog, patch, 'backend_patch');
    }
    const immutableSnapshot = clone(exportedSnapshot);

    const structuralProps = ['levels', 'x', 'y', 'z', 'bins', 'breaks'];
    for (const prop of structuralProps) {
      const rejectedContour = makePatch(contour, prop, prop === 'levels' || prop === 'breaks' ? [1, 2, 3] : 3);
      await assertNoPersistence(
        contourProject.projectId,
        standalone.sessionId,
        `R contour structural ${prop} rejection`,
        () => submitProjectPatch(token, contourProject.projectId, [rejectedContour], contourRevision),
        [rejectedContour],
        contourRevision,
      );

      const rejectedContourf = makePatch(contourf, prop, prop === 'levels' || prop === 'breaks' ? [1, 2, 3] : 3);
      await assertNoPersistence(
        contourProject.projectId,
        standalone.sessionId,
        `R contourf structural ${prop} rejection`,
        () => submitProjectPatch(token, contourProject.projectId, [rejectedContourf], contourRevision),
        [rejectedContourf],
        contourRevision,
      );
    }

    const mixedValidPatch = makePatch(contourf, 'alpha', 0.38, 'local_patch');
    const mixedRejectedPatch = makePatch(contour, 'bins', 9);
    await assertNoPersistence(
      contourProject.projectId,
      standalone.sessionId,
      'R family 8 mixed valid/structural batch atomic conflict',
      () => submitProjectPatch(token, contourProject.projectId, [mixedValidPatch, mixedRejectedPatch], contourRevision),
      [mixedValidPatch, mixedRejectedPatch],
      contourRevision,
    );

    const laterPatches = [
      makePatch(contour, 'cmap', 'inferno'),
      makePatch(contour, 'vmax', 7.25),
      makePatch(contourf, 'edgecolor', '#7F0000'),
      makePatch(contourf, 'linewidth', 1.8),
    ];
    const laterAccepted = await submitProjectPatch(token, contourProject.projectId, laterPatches, contourRevision);
    assertAcceptedPatches('R family 8 post-export edits', laterAccepted, laterPatches, contourRevision);
    contourRevision += 1;
    assertPersistedProjectPatches(contourProject.projectId, standalone.sessionId, laterPatches, contourRevision, 'R family 8 post-export edits');

    const restored = await jsonRequest(`/api/projects/${contourProject.projectId}/export-assets/${exported.asset.assetId}/restore`, token, {
      method: 'POST',
    });
    assert(restored.response.ok && restored.data?.status === 'success', `R family 8 snapshot restore failed: ${JSON.stringify(restored.data)}`);
    assert(restored.data?.targetFigureId === 'fig_1', `R family 8 restore targeted the wrong Figure: ${JSON.stringify(restored.data)}`);

    const restoredState = readDatabaseState(contourProject.projectId, standalone.sessionId);
    assert(Number(restoredState.figure?.revision) === Number(restoredState.sessions[`${contourProject.projectId}_fig_1`]?.revision), 'R family 8 restore left session/Figure revisions inconsistent');
    assert(Number(restoredState.figure?.revision) > contourRevision, 'R family 8 restore did not advance the active revision');
    for (const patch of exportTimePatches) {
      assertHasPatch('R family 8 restored Figure edit log', restoredState.figure?.editLog, patch, 'backend_patch');
      assertHasPatch('R family 8 restored session edit log', restoredState.sessions[`${contourProject.projectId}_fig_1`]?.editLog, patch, 'backend_patch');
    }
    assert(
      restoredState.figure?.previewSvg === null
        && restoredState.figure?.manifest === null
        && restoredState.figure?.codeSlice === null
        && restoredState.figure?.fingerprint === null
        && restoredState.figure?.previewUpdatedAt === null,
      'R family 8 restore retained stale preview/manifest state instead of invalidating it',
    );
    for (const patch of laterPatches) {
      assertMissingPatch('R family 8 restored Figure edit log', restoredState.figure?.editLog, patch);
      assertMissingPatch('R family 8 restored session edit log', restoredState.sessions[`${contourProject.projectId}_fig_1`]?.editLog, patch);
      const checkpointPatch = restoredState.figure?.history?.past
        ?.flatMap((checkpoint) => checkpoint?.editLog || [])
        .find((entry) => isSamePatch(entry, patch));
      assert(checkpointPatch, `R family 8 restore did not checkpoint later edit ${JSON.stringify(patch)}`);
      assert(checkpointPatch.mode === 'backend_patch', `R family 8 restore checkpoint persisted non-authoritative mode: ${JSON.stringify(checkpointPatch)}`);
    }
    const restoredSnapshot = restoredState.exportSnapshots.find((row) => row.asset_id === exported.asset.assetId);
    assertSameState('R family 8 immutable export snapshot', immutableSnapshot, restoredSnapshot);

    const refreshed = await jsonRequest(`/api/projects/${contourProject.projectId}/figures?includePreview=1`, token);
    assert(refreshed.response.ok && refreshed.data?.status === 'success', `R family 8 post-restore refresh failed: ${JSON.stringify(refreshed.data)}`);
    const refreshedFigure = refreshed.data?.figures?.find((figure) => figure.figureId === 'fig_1');
    assert(refreshedFigure?.previewSource === 'rendered', `R family 8 post-restore refresh reused stale preview state: ${JSON.stringify(refreshedFigure)}`);
    for (const patch of exportTimePatches) {
      assertHasPatch('R family 8 refreshed edit log', refreshedFigure?.editLog, patch, 'backend_patch');
      assert(manifestHasPatchValue(refreshedFigure?.manifest, patch), `R family 8 refreshed manifest lost ${patch.gid}.${patch.prop}`);
    }

    const finalStandaloneState = readDatabaseState(null, standalone.sessionId);
    assert(Number(finalStandaloneState.sessions[standalone.sessionId]?.revision) === standaloneRevision, 'standalone revision changed after project rejects/restores');
    assertHasPatch('standalone contour patch after project flow', finalStandaloneState.sessions[standalone.sessionId]?.editLog, standaloneFakeLocalPatch, 'backend_patch');

    console.log(JSON.stringify({
      status: 'PASS',
      tileProjectId: tileProject.projectId,
      contourProjectId: contourProject.projectId,
      standaloneSessionId: standalone.sessionId,
      exportAssetId: exported.asset.assetId,
      checked: [
        'GeomTile/GeomRaster/GeomRect expose only server-authoritative modern propertyCapabilities',
        'GeomContour/GeomContourFilled expose only server-authoritative modern propertyCapabilities',
        'client-declared local patches are persisted as backend_patch for project and standalone R targets',
        'legal style batches for Tile/Raster/Rect and Contour/ContourFilled succeed with business status/applied checks',
        'levels/x/y/z/bins/breaks are rejected for contour and contourf without persistence',
        'mixed valid/structural batch applies nothing and leaves revision/session/Figure/history/cache/export asset/snapshot state unchanged',
        'export captures family 8 edits and remains immutable after later edits',
        'snapshot restore returns to export-time family 8 edit state and checkpoints newer edits',
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
