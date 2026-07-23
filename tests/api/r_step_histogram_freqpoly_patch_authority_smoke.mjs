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
      email: `r-step-hist-freq-${Date.now()}-${Math.random().toString(36).slice(2)}@example.test`,
      password: 'R-Step-Histogram-Freqpoly-Authority-2026',
    }),
  });
  assert(result.response.ok && result.data?.token, `registration failed: ${JSON.stringify(result.data)}`);
  return result.data.token;
}

const rScript = [
  'library(ggplot2)',
  'step_df <- data.frame(x = 1:4, y = c(1, 3, 2, 5))',
  'bin_df <- data.frame(x = c(1.1, 1.4, 1.8, 2.2, 2.7, 3.1, 3.6, 3.9))',
  'p <- ggplot() +',
  '  geom_step(data = step_df, aes(x = x, y = y), direction = "vh", colour = "#756BB1", linewidth = 0.75) +',
  '  geom_histogram(data = bin_df, aes(x = x), binwidth = 1, boundary = 1, fill = "#9ECAE1", colour = "#2171B5", linewidth = 0.45, alpha = 0.65) +',
  '  geom_freqpoly(data = bin_df, aes(x = x), bins = 4, boundary = 1, colour = "#E6550D", linewidth = 0.8) +',
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

function patchValue(prop, numberValue, colorValue) {
  if (String(prop).toLowerCase().includes('color')) return colorValue;
  if (prop === 'visible') return false;
  return numberValue;
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

function findFamilyTarget(manifest, adapterFamily, preferredProps, structuralProps) {
  const object = (manifest?.objects || []).find((candidate) => (
    candidate?.currentProps?.adapterFamily === adapterFamily
    && Array.isArray(candidate.propertyCapabilities)
  ));
  assert(object?.id, `R render did not expose an ${adapterFamily} target: ${JSON.stringify(manifest)}`);
  const prop = preferredProps.find((name) => (
    object.propertyCapabilities.some((capability) => capability?.prop === name && capability?.replay !== 'unsupported')
  )) || (Array.isArray(object.editable) ? object.editable.find((name) => preferredProps.includes(name)) : null);
  assert(prop, `R ${adapterFamily} target did not expose an editable visual prop: ${JSON.stringify(object)}`);
  for (const readonlyProp of structuralProps) {
    assert(!Array.isArray(object.editable) || !object.editable.includes(readonlyProp), `R ${adapterFamily} target incorrectly exposes structural prop ${readonlyProp}: ${JSON.stringify(object)}`);
    assert(!object.propertyCapabilities.some((capability) => capability?.prop === readonlyProp), `R ${adapterFamily} target incorrectly exposes structural capability ${readonlyProp}: ${JSON.stringify(object)}`);
  }
  return { object, prop };
}

async function createProject(token) {
  const created = await jsonRequest('/api/projects', token, {
    method: 'POST',
    body: JSON.stringify({
      name: `R step histogram freqpoly authority ${Date.now()}`,
      spec: { plot_type: 'custom', custom_script: rScript, script: rScript, script_language: 'r' },
    }),
  });
  assert(created.response.ok && created.data?.id, `project creation failed: ${JSON.stringify(created.data)}`);
  const projectId = created.data.id;
  const rendered = await jsonRequest(`/api/projects/${projectId}/figures/render`, token, {
    method: 'POST',
    body: JSON.stringify({
      script: rScript,
      editLogs: { fig_1: [] },
      language: 'r',
      requestId: `r-step-histogram-freqpoly-render-${Date.now()}-${Math.random().toString(36).slice(2)}`,
    }),
  });
  assert(rendered.response.ok && rendered.data?.status === 'success', `initial R project render failed: ${JSON.stringify(rendered.data)}`);
  const figure = rendered.data.figures?.find((item) => item.figureId === 'fig_1');
  assert(figure?.manifest?.objects?.length > 0, 'initial R project render did not return fig_1 manifest');
  return {
    projectId,
    figure,
    step: findFamilyTarget(figure.manifest, 'step', ['color', 'linewidth', 'linestyle', 'alpha'], ['stepDirection', 'where', 'drawstyle', 'x', 'y']),
    histogram: findFamilyTarget(figure.manifest, 'histogram', ['facecolor', 'edgecolor', 'alpha', 'linewidth'], ['binwidth', 'bins', 'breaks', 'counts', 'density']),
    freqpoly: findFamilyTarget(figure.manifest, 'freqpoly', ['color', 'linewidth', 'linestyle', 'alpha'], ['bins', 'density', 'yStat']),
  };
}

async function createStandaloneSession(token) {
  const rendered = await jsonRequest('/api/figure/render', token, {
    method: 'POST',
    body: JSON.stringify({
      script: rScript,
      language: 'r',
      dataPayload: null,
      editLog: [],
      renderOptions: { dpi: 150 },
    }),
  });
  assert(rendered.response.ok && rendered.data?.status === 'success', `standalone R render failed: ${JSON.stringify(rendered.data)}`);
  assert(rendered.data?.sessionId, `standalone R render did not return a sessionId: ${JSON.stringify(rendered.data)}`);
  return {
    sessionId: rendered.data.sessionId,
    revision: Number(rendered.data.revision || 1),
    step: findFamilyTarget(rendered.data.manifest, 'step', ['linewidth', 'color', 'linestyle', 'alpha'], ['stepDirection', 'where', 'drawstyle', 'x', 'y']),
    histogram: findFamilyTarget(rendered.data.manifest, 'histogram', ['facecolor', 'edgecolor', 'alpha', 'linewidth'], ['binwidth', 'bins', 'breaks', 'counts', 'density']),
    freqpoly: findFamilyTarget(rendered.data.manifest, 'freqpoly', ['color', 'linewidth', 'linestyle', 'alpha'], ['bins', 'density', 'yStat']),
  };
}

async function submitProjectPatch(token, projectId, patches, baseRevision) {
  return jsonRequest('/api/figure/patch', token, {
    method: 'POST',
    body: JSON.stringify({
      requestId: `r-step-histogram-freqpoly-${Date.now()}-${Math.random().toString(36).slice(2)}`,
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
      requestId: `r-step-histogram-freqpoly-${Date.now()}-${Math.random().toString(36).slice(2)}`,
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
  assert(
    matched,
    `${label} is missing ${JSON.stringify(expectedPatch)}: ${JSON.stringify(editLog)}`,
  );
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
  return Number(actual) === Number(expectedPatch.value);
}

async function exportProjectSnapshot(token, projectId) {
  const result = await jsonRequest(`/api/projects/${projectId}/export`, token, {
    method: 'POST',
    body: JSON.stringify({
      figureId: 'fig_1',
      format: 'svg',
      dpi: 150,
      saveToLibrary: true,
      name: `r-step-histogram-freqpoly-export-${Date.now()}`,
    }),
  });
  assert(result.response.ok && result.data?.status === 'success', `R family 7 export failed: ${JSON.stringify(result.data)}`);
  const exportedFigure = result.data?.figures?.[0];
  const asset = exportedFigure?.asset;
  assert(asset?.assetId && asset.hasEditingSnapshot === true, `R family 7 export did not create a restorable snapshot: ${JSON.stringify(result.data)}`);
  assert(String(exportedFigure?.svg || '').includes('<svg'), 'R family 7 export did not return SVG output');
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

async function main() {
  assertIsolatedEnvironment();
  const token = await register();
  let projectId = null;
  try {
    const project = await createProject(token);
    projectId = project.projectId;
    const standalone = await createStandaloneSession(token);

    let projectRevision = Number(project.figure.revision || 1);
    let standaloneRevision = standalone.revision;

    const projectStepBackendPatch = {
      op: 'set',
      mode: 'backend_patch',
      gid: project.step.object.id,
      prop: project.step.prop,
      value: patchValue(project.step.prop, 1.1, '#6A51A3'),
      ...identityFields(project.step.object),
    };
    const projectHistogramLocalPatch = {
      op: 'set',
      mode: 'local_patch',
      gid: project.histogram.object.id,
      prop: project.histogram.prop,
      value: patchValue(project.histogram.prop, 0.58, '#7FCDBB'),
      ...identityFields(project.histogram.object),
    };
    const projectFreqpolyBackendPatch = {
      op: 'set',
      mode: 'backend_patch',
      gid: project.freqpoly.object.id,
      prop: project.freqpoly.prop,
      value: patchValue(project.freqpoly.prop, 1.35, '#2CA25F'),
      ...identityFields(project.freqpoly.object),
    };
    const exportTimePatches = [
      projectStepBackendPatch,
      projectHistogramLocalPatch,
      projectFreqpolyBackendPatch,
    ];
    const standaloneFreqpolyLocalPatch = {
      op: 'set',
      mode: 'local_patch',
      gid: standalone.freqpoly.object.id,
      prop: standalone.freqpoly.prop,
      value: patchValue(standalone.freqpoly.prop, 2.2, '#D95F0E'),
      ...identityFields(standalone.freqpoly.object),
    };
    const histogramStructuralPatch = {
      op: 'set',
      mode: 'backend_patch',
      gid: project.histogram.object.id,
      prop: 'binwidth',
      value: 2,
      ...identityFields(project.histogram.object),
    };
    const stepStructuralPatch = {
      op: 'set',
      mode: 'backend_patch',
      gid: project.step.object.id,
      prop: 'stepDirection',
      value: 'hv',
      ...identityFields(project.step.object),
    };
    const freqpolyStructuralPatch = {
      op: 'set',
      mode: 'backend_patch',
      gid: project.freqpoly.object.id,
      prop: 'bins',
      value: 8,
      ...identityFields(project.freqpoly.object),
    };
    const mixedValidPatch = {
      op: 'set',
      mode: 'local_patch',
      gid: project.histogram.object.id,
      prop: project.histogram.prop,
      value: patchValue(project.histogram.prop, 0.55, '#7FCDBB'),
      ...identityFields(project.histogram.object),
    };
    const mixedRejectedPatch = {
      ...histogramStructuralPatch,
      value: 12,
    };
    const laterPatches = [
      { ...projectStepBackendPatch, value: patchValue(project.step.prop, 2.6, '#CB181D') },
      { ...projectHistogramLocalPatch, value: patchValue(project.histogram.prop, 0.82, '#FED976') },
      { ...projectFreqpolyBackendPatch, value: patchValue(project.freqpoly.prop, 2.1, '#756BB1') },
    ];

    const projectAccepted = await submitProjectPatch(token, projectId, exportTimePatches, projectRevision);
    assertAcceptedPatches('project family 7 backend patches', projectAccepted, exportTimePatches, projectRevision);
    const projectAfter = readDatabaseState(projectId, standalone.sessionId);
    assert(Number(projectAfter.sessions[`${projectId}_fig_1`]?.revision) === projectRevision + 1, 'project family 7 patches did not persist one revision');
    for (const patch of exportTimePatches) {
      assertHasPatch('project family 7 session edit log', projectAfter.sessions[`${projectId}_fig_1`]?.editLog, patch, 'backend_patch');
      assertHasPatch('project family 7 Figure edit log', projectAfter.figure?.editLog, patch, 'backend_patch');
      assert(manifestHasPatchValue(projectAfter.figure?.manifest, patch), `project family 7 manifest did not confirm ${patch.gid}.${patch.prop}`);
    }
    projectRevision += 1;

    const standaloneAccepted = await submitStandalonePatch(
      token,
      standalone.sessionId,
      [standaloneFreqpolyLocalPatch],
      standaloneRevision,
    );
    assertAcceptedPatch('standalone local freqpoly patch', standaloneAccepted, standaloneFreqpolyLocalPatch, standaloneRevision);
    standaloneRevision += 1;
    const standaloneState = readDatabaseState(null, standalone.sessionId);
    assert(Number(standaloneState.sessions[standalone.sessionId]?.revision) === standaloneRevision, 'standalone local freqpoly patch did not persist revision');
    assertHasPatch('standalone local freqpoly edit log', standaloneState.sessions[standalone.sessionId]?.editLog, standaloneFreqpolyLocalPatch, 'backend_patch');

    const exported = await exportProjectSnapshot(token, projectId);
    const exportedState = readDatabaseState(projectId, standalone.sessionId);
    const exportedSnapshot = exportedState.exportSnapshots.find((row) => row.asset_id === exported.asset.assetId);
    assert(exportedSnapshot?.snapshotJson, `R family 7 export snapshot was not persisted: ${JSON.stringify(exportedState.exportSnapshots)}`);
    const snapshotFigure = exportedSnapshot.snapshotJson?.figures?.find((figure) => figure.figureId === 'fig_1');
    for (const patch of exportTimePatches) {
      assertHasPatch('R family 7 export snapshot', snapshotFigure?.editLog, patch, 'backend_patch');
    }
    const immutableSnapshot = clone(exportedSnapshot);

    await assertNoPersistence(
      projectId,
      standalone.sessionId,
      'R step histogram structural step rejection',
      () => submitProjectPatch(token, projectId, [stepStructuralPatch], projectRevision),
      [stepStructuralPatch],
      projectRevision,
    );
    await assertNoPersistence(
      projectId,
      standalone.sessionId,
      'R step histogram structural histogram rejection',
      () => submitProjectPatch(token, projectId, [histogramStructuralPatch], projectRevision),
      [histogramStructuralPatch],
      projectRevision,
    );
    await assertNoPersistence(
      projectId,
      standalone.sessionId,
      'R step histogram structural freqpoly rejection',
      () => submitProjectPatch(token, projectId, [freqpolyStructuralPatch], projectRevision),
      [freqpolyStructuralPatch],
      projectRevision,
    );
    await assertNoPersistence(
      projectId,
      standalone.sessionId,
      'R mixed batch atomic conflict',
      () => submitProjectPatch(token, projectId, [mixedValidPatch, mixedRejectedPatch], projectRevision),
      [mixedValidPatch, mixedRejectedPatch],
      projectRevision,
    );

    const laterAccepted = await submitProjectPatch(token, projectId, laterPatches, projectRevision);
    assertAcceptedPatches('project family 7 later patches', laterAccepted, laterPatches, projectRevision);
    projectRevision += 1;
    const laterState = readDatabaseState(projectId, standalone.sessionId);
    for (const patch of laterPatches) {
      assertHasPatch('R family 7 later active edit log', laterState.figure?.editLog, patch, 'backend_patch');
      assert(manifestHasPatchValue(laterState.figure?.manifest, patch), `R family 7 later manifest did not confirm ${patch.gid}.${patch.prop}`);
    }

    const restored = await jsonRequest(`/api/projects/${projectId}/export-assets/${exported.asset.assetId}/restore`, token, {
      method: 'POST',
    });
    assert(restored.response.ok && restored.data?.status === 'success', `R family 7 snapshot restore failed: ${JSON.stringify(restored.data)}`);
    assert(restored.data?.targetFigureId === 'fig_1', `R family 7 restore targeted the wrong Figure: ${JSON.stringify(restored.data)}`);

    const restoredState = readDatabaseState(projectId, standalone.sessionId);
    assert(Number(restoredState.figure?.revision) === Number(restoredState.sessions[`${projectId}_fig_1`]?.revision), 'R family 7 restore left session/Figure revisions inconsistent');
    assert(Number(restoredState.figure?.revision) > projectRevision, 'R family 7 restore did not advance the active revision');
    for (const patch of exportTimePatches) {
      assertHasPatch('R family 7 restored Figure edit log', restoredState.figure?.editLog, patch, 'backend_patch');
      assertHasPatch('R family 7 restored session edit log', restoredState.sessions[`${projectId}_fig_1`]?.editLog, patch, 'backend_patch');
    }
    assert(
      restoredState.figure?.previewSvg === null
        && restoredState.figure?.manifest === null
        && restoredState.figure?.codeSlice === null
        && restoredState.figure?.fingerprint === null
        && restoredState.figure?.previewUpdatedAt === null,
      'R family 7 restore retained stale preview/manifest state instead of invalidating it',
    );
    for (const patch of laterPatches) {
      assertMissingPatch('R family 7 restored Figure edit log', restoredState.figure?.editLog, patch);
      assertMissingPatch('R family 7 restored session edit log', restoredState.sessions[`${projectId}_fig_1`]?.editLog, patch);
      const checkpointPatch = restoredState.figure?.history?.past
        ?.flatMap((checkpoint) => checkpoint?.editLog || [])
        .find((entry) => isSamePatch(entry, patch));
      assert(checkpointPatch, `R family 7 restore did not checkpoint later edit ${JSON.stringify(patch)}`);
      assert(checkpointPatch.mode === 'backend_patch', `R family 7 restore checkpoint persisted non-authoritative mode: ${JSON.stringify(checkpointPatch)}`);
    }
    const restoredSnapshot = restoredState.exportSnapshots.find((row) => row.asset_id === exported.asset.assetId);
    assertSameState('R family 7 immutable export snapshot', immutableSnapshot, restoredSnapshot);

    const refreshed = await jsonRequest(`/api/projects/${projectId}/figures?includePreview=1`, token);
    assert(refreshed.response.ok && refreshed.data?.status === 'success', `R family 7 post-restore refresh failed: ${JSON.stringify(refreshed.data)}`);
    const refreshedFigure = refreshed.data?.figures?.find((figure) => figure.figureId === 'fig_1');
    assert(refreshedFigure?.previewSource === 'rendered', `R family 7 post-restore refresh reused stale preview state: ${JSON.stringify(refreshedFigure)}`);
    for (const patch of exportTimePatches) {
      assertHasPatch('R family 7 refreshed edit log', refreshedFigure?.editLog, patch, 'backend_patch');
      assert(manifestHasPatchValue(refreshedFigure?.manifest, patch), `R family 7 refreshed manifest lost ${patch.gid}.${patch.prop}`);
    }

    const finalProjectState = readDatabaseState(projectId, standalone.sessionId);
    assert(Number(finalProjectState.sessions[`${projectId}_fig_1`]?.revision) === Number(restoredState.figure?.revision), 'project revision changed after restore refresh');
    for (const patch of exportTimePatches) {
      assertHasPatch('project accepted family 7 patch after restore', finalProjectState.sessions[`${projectId}_fig_1`]?.editLog, patch, 'backend_patch');
    }
    const finalStandaloneState = readDatabaseState(null, standalone.sessionId);
    assert(Number(finalStandaloneState.sessions[standalone.sessionId]?.revision) === standaloneRevision, 'standalone revision changed after rejected patches');
    assertHasPatch('standalone accepted patch after rejected project edits', finalStandaloneState.sessions[standalone.sessionId]?.editLog, standaloneFreqpolyLocalPatch, 'backend_patch');

    console.log(JSON.stringify({
      status: 'PASS',
      projectId,
      standaloneSessionId: standalone.sessionId,
      exportAssetId: exported.asset.assetId,
      checked: [
        'project step/histogram/freqpoly patches accepted and persisted atomically with backend authority',
        'standalone freqpoly local patch normalized to backend authority',
        'step/histogram/freqpoly structural properties were rejected without persistence',
        'mixed batch conflicts applied nothing and left project, standalone, cache, export anchor, and snapshot state unchanged',
        'export captured all family 7 edits in an immutable editing snapshot',
        'later family 7 edits were checkpointed and snapshot restore returned to export-time SVG/manifest/edit state',
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
