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

function assertIsolatedEnvironment() {
  assert(process.env.SCIFIGURE_TEST_ISOLATED === '1', 'test must run under scripts/testing/run_with_isolated_server.mjs');
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
      email: `patch-rejection-${Date.now()}-${Math.random().toString(36).slice(2)}@example.test`,
      password: 'Patch-Rejection-Persistence-2026',
    }),
  });
  assert(result.response.ok && result.data?.token, `registration failed: ${JSON.stringify(result.data)}`);
  return result.data.token;
}

const script = [
  'import matplotlib',
  'matplotlib.use("Agg")',
  'import matplotlib.pyplot as plt',
  '',
  'fig, ax = plt.subplots(figsize=(4, 3))',
  'ax.plot([0, 1, 2], [1, 3, 2], color="#225577", linewidth=1.2, label="series")',
  'ax.set_title("Patch rejection persistence")',
  'ax.set_xlabel("Original X")',
  'ax.set_ylabel("Original Y")',
  'ax.legend(loc="upper left")',
  'fig.tight_layout()',
].join('\n');

const rejectedMissingGid = {
  op: 'set',
  mode: 'backend_patch',
  gid: 'missing.gid.batch0e',
  prop: 'fontsize',
  value: 31,
};

function unsupportedPatchFor(gid) {
  return {
    op: 'set',
    mode: 'backend_patch',
    gid,
    prop: 'batch0e_unsupported_prop',
    value: 'must-not-persist',
  };
}

function rendererOnlyRejectedPatchFor(gid) {
  return {
    op: 'set',
    mode: 'backend_patch',
    gid,
    prop: 'batch0e_manifest_only_prop',
    value: 'renderer-must-reject',
  };
}

function identityFields(object) {
  return {
    ...(object.stableKey !== undefined ? { stableKey: object.stableKey } : {}),
    ...(object.fingerprintVersion === 2
      ? { fingerprint: object.fingerprint, fingerprintVersion: 2 }
      : {}),
    ...(object.identity !== undefined ? { identity: object.identity } : {}),
  };
}

function isRejectedPatch(entry, rejected) {
  return entry?.gid === rejected.gid
    && entry?.prop === rejected.prop
    && JSON.stringify(entry?.value) === JSON.stringify(rejected.value);
}

function findRejectedEntries(editLog, rejectedPatches) {
  if (!Array.isArray(editLog)) return [];
  return editLog.filter(entry => rejectedPatches.some(rejected => isRejectedPatch(entry, rejected)));
}

function collectNoRejectedEntries(label, editLog, rejectedPatches, leaks) {
  assert(Array.isArray(editLog), `${label} editLog is not an array`);
  const leaked = findRejectedEntries(editLog, rejectedPatches);
  if (leaked.length > 0) {
    leaks.push(`${label} leaked rejected patch(es): ${JSON.stringify(leaked)}`);
  }
}

function collectJsonDoesNotContainRejected(label, value, rejectedPatches, leaks) {
  const serialized = JSON.stringify(value) ?? '';
  for (const rejected of rejectedPatches) {
    if (serialized.includes(rejected.gid)) {
      leaks.push(`${label} contains rejected gid ${rejected.gid}`);
    }
    if (serialized.includes(rejected.prop)) {
      leaks.push(`${label} contains rejected prop ${rejected.prop}`);
    }
  }
}

async function createProject(token) {
  const created = await jsonRequest('/api/projects', token, {
    method: 'POST',
    body: JSON.stringify({
      name: `Patch rejection persistence ${Date.now()}`,
      spec: { plot_type: 'custom', custom_script: script, script_language: 'python' },
    }),
  });
  assert(created.response.ok && created.data?.id, `project creation failed: ${JSON.stringify(created.data)}`);
  const projectId = created.data.id;

  const rendered = await jsonRequest(`/api/projects/${projectId}/figures/render`, token, {
    method: 'POST',
    body: JSON.stringify({
      script,
      editLogs: { fig_1: [] },
      language: 'python',
      requestId: `patch-rejection-render-${Date.now()}`,
    }),
  });
  assert(rendered.response.ok && rendered.data?.status === 'success', `initial render failed: ${JSON.stringify(rendered.data)}`);
  const figure = rendered.data.figures?.find(item => item.figureId === 'fig_1');
  assert(figure?.manifest?.objects?.length > 0, 'initial render did not return a manifest for fig_1');
  const target = figure.manifest.objects.find(object => object.id === 'title.0')
    || figure.manifest.objects.find(object => object.kind === 'text' && Array.isArray(object.editable) && object.editable.length > 0);
  assert(target?.id, 'initial render has no known editable text target for unsupported prop regression');
  const lineTarget = figure.manifest.objects.find(object => (
    object.kind === 'line' && object.editable?.includes('linewidth')
  ));
  const localTarget = figure.manifest.objects.find(object => (
    Array.isArray(object.propertyCapabilities)
      && object.propertyCapabilities.some(capability => capability?.prop === 'color' && capability?.patchMode === 'local_patch')
  ));
  assert(lineTarget?.id, 'initial render has no editable line target for mixed batch regression');
  assert(localTarget?.id, 'initial render has no capability-declared local color target for cache invalidation regression');
  return {
    projectId,
    unsupportedPatch: unsupportedPatchFor(target.id),
    rendererOnlyPatch: rendererOnlyRejectedPatchFor(target.id),
    validMixedPatches: [
      {
        op: 'set',
        mode: 'local_patch',
        gid: target.id,
        prop: 'color',
        value: '#7a1f5c',
        ...identityFields(target),
      },
      {
        op: 'set',
        // Deliberately lie about the mode: server must honor propertyCapabilities.
        mode: 'local_patch',
        gid: lineTarget.id,
        prop: 'linewidth',
        value: 2.75,
        ...identityFields(lineTarget),
      },
    ],
    pureLocalPatch: {
      op: 'set',
      mode: 'local_patch',
      gid: localTarget.id,
      prop: 'color',
      value: '#4d7c0f',
      ...identityFields(localTarget),
    },
    initialRevision: Number(figure.revision || 1),
  };
}

async function createStandaloneSession(token) {
  const rendered = await jsonRequest('/api/figure/render', token, {
    method: 'POST',
    body: JSON.stringify({
      script,
      language: 'python',
      dataPayload: null,
      editLog: [],
      renderOptions: { dpi: 150 },
    }),
  });
  assert(rendered.response.ok && rendered.data?.status === 'success', `standalone render failed: ${JSON.stringify(rendered.data)}`);
  assert(rendered.data?.sessionId, `standalone render did not return a sessionId: ${JSON.stringify(rendered.data)}`);
  const manifest = rendered.data.manifest;
  assert(Array.isArray(manifest?.objects) && manifest.objects.length > 0, 'standalone render did not return a manifest');
  const titleTarget = manifest.objects.find(object => object.id === 'title.0')
    || manifest.objects.find(object => object.kind === 'text' && object.editable?.includes('color'));
  const lineTarget = manifest.objects.find(object => object.kind === 'line' && object.editable?.includes('linewidth'));
  assert(titleTarget?.id, 'standalone render has no editable text color target');
  assert(lineTarget?.id, 'standalone render has no editable line width target');
  return {
    sessionId: rendered.data.sessionId,
    revision: Number(rendered.data.revision || 1),
    patches: [
      {
        op: 'set',
        // Standalone sessions have no trusted stored manifest, so even a normally
        // local-capable property must be renderer-validated.
        mode: 'local_patch',
        gid: titleTarget.id,
        prop: 'color',
        value: '#1f6b4f',
        ...identityFields(titleTarget),
      },
      {
        op: 'set',
        mode: 'local_patch',
        gid: lineTarget.id,
        prop: 'linewidth',
        value: 3.25,
        ...identityFields(lineTarget),
      },
    ],
  };
}

async function submitStandalonePatchBatch(token, sessionId, patches, label, baseRevision) {
  const result = await jsonRequest('/api/figure/patch', token, {
    method: 'POST',
    body: JSON.stringify({
      sessionId,
      requestId: `standalone-patch-${label}-${Date.now()}-${Math.random().toString(36).slice(2)}`,
      baseRevision,
      patches,
    }),
  });
  assert(result.response.ok, `${label} standalone patch failed at HTTP layer: ${result.response.status} ${JSON.stringify(result.data)}`);
  return result.data;
}

function readStandaloneSession(sessionId) {
  const database = new Database(process.env.SCIFIGURE_DB_PATH, { readonly: true });
  try {
    database.pragma('busy_timeout = 5000');
    const row = database.prepare('SELECT id, edit_log, revision FROM sessions WHERE id = ?').get(sessionId);
    return row ? { ...row, editLog: parseJson(row.edit_log, []) } : null;
  } finally {
    database.close();
  }
}

function readProjectFigurePreviewCache(projectId) {
  const database = new Database(process.env.SCIFIGURE_DB_PATH, { readonly: true });
  try {
    database.pragma('busy_timeout = 5000');
    const row = database.prepare(`
      SELECT revision, preview_svg, manifest, code_slice, fingerprint, preview_updated_at
      FROM project_figures
      WHERE project_id = ? AND figure_index = 0
    `).get(projectId);
    return row ? {
      ...row,
      manifest: parseJson(row.manifest, null),
      codeSlice: parseJson(row.code_slice, null),
    } : null;
  } finally {
    database.close();
  }
}

function assertManifestPatchValue(manifest, patch, label) {
  const object = manifest?.objects?.find(item => item.id === patch.gid);
  assert(object, `${label} manifest is missing ${patch.gid}`);
  const actual = object.currentProps?.[patch.prop];
  const expected = patch.value;
  const matches = typeof expected === 'number'
    ? Number(actual) === Number(expected)
    : String(actual).toLowerCase() === String(expected).toLowerCase();
  assert(
    matches,
    `${label} manifest is stale for ${patch.gid}.${patch.prop}: ${JSON.stringify(object.currentProps)}`,
  );
}

async function assertProjectPreviewCacheFresh(token, projectId, patch, expectedRevision) {
  const stored = readProjectFigurePreviewCache(projectId);
  assert(stored, 'project figure preview cache row is missing');
  assert(Number(stored.revision) === expectedRevision, `project preview cache revision mismatch: ${JSON.stringify(stored)}`);
  assert(typeof stored.preview_svg === 'string' && stored.preview_svg.includes('<svg'), 'project preview SVG was not persisted after successful patch');
  assertManifestPatchValue(stored.manifest, patch, 'DB project preview');
  assert(stored.preview_updated_at, 'project preview cache timestamp was not refreshed after successful patch');

  const listed = await jsonRequest(`/api/projects/${projectId}/figures?includePreview=1`, token);
  assert(listed.response.ok && listed.data?.status === 'success', `project preview listing failed: ${JSON.stringify(listed.data)}`);
  const figure = listed.data.figures?.find(item => item.figureId === 'fig_1');
  assert(figure, 'project preview listing did not return fig_1');
  assert(Number(figure.revision) === expectedRevision, `project preview API revision mismatch: ${JSON.stringify(figure)}`);
  assertManifestPatchValue(figure.manifest, patch, 'project preview API');
}

async function verifyStandalonePatchAuthority(token) {
  const standalone = await createStandaloneSession(token);
  const applied = await submitStandalonePatchBatch(
    token,
    standalone.sessionId,
    standalone.patches,
    'lying-local-mixed-batch',
    standalone.revision,
  );
  assert(applied?.status === 'success', `standalone mixed batch failed: ${JSON.stringify(applied)}`);
  assert(Number(applied.revision) === standalone.revision + 1, `standalone mixed batch must advance exactly one revision: ${JSON.stringify(applied)}`);
  assert(typeof applied.svg === 'string' && applied.svg.includes('<svg'), 'standalone mixed batch did not execute the renderer');
  for (const patch of standalone.patches) {
    const persisted = applied.editLog?.find(entry => isRejectedPatch(entry, patch));
    assert(persisted, `standalone mixed batch lost patch: ${JSON.stringify({ patch, applied })}`);
    assert(persisted.mode === 'backend_patch', `standalone patch trusted client mode: ${JSON.stringify(persisted)}`);
  }

  const rejectedPatch = {
    op: 'set',
    mode: 'local_patch',
    gid: 'missing.standalone.gid',
    prop: 'fontsize',
    value: 44,
  };
  const rejected = await submitStandalonePatchBatch(
    token,
    standalone.sessionId,
    [rejectedPatch],
    'missing-gid',
    standalone.revision + 1,
  );
  assertConflictResponse('standalone missing gid patch', rejected, rejectedPatch, standalone.revision + 1);

  const persistedSession = readStandaloneSession(standalone.sessionId);
  assert(persistedSession, 'standalone session was not persisted');
  assert(Number(persistedSession.revision) === standalone.revision + 1, `standalone rejected patch changed DB revision: ${JSON.stringify(persistedSession)}`);
  assert(
    !persistedSession.editLog.some(entry => isRejectedPatch(entry, rejectedPatch)),
    `standalone rejected patch leaked into DB: ${JSON.stringify(persistedSession.editLog)}`,
  );
  for (const patch of standalone.patches) {
    const persisted = persistedSession.editLog.find(entry => isRejectedPatch(entry, patch));
    assert(persisted?.mode === 'backend_patch', `standalone DB editLog did not preserve authoritative backend mode: ${JSON.stringify(persistedSession.editLog)}`);
  }
}

function allowManifestOnlyProperty(projectId, patch) {
  const database = new Database(process.env.SCIFIGURE_DB_PATH);
  try {
    database.pragma('busy_timeout = 5000');
    const row = database.prepare(
      'SELECT manifest FROM project_figures WHERE project_id = ? AND figure_index = 0',
    ).get(projectId);
    const manifest = parseJson(row?.manifest, null);
    assert(manifest, 'cannot prepare renderer-only rejection without a stored manifest');
    const object = manifest.objects?.find(item => item.id === patch.gid);
    assert(object, `renderer-only rejection target missing from manifest: ${patch.gid}`);
    object.editable = Array.from(new Set([...(object.editable || []), patch.prop]));
    object.propertyCapabilities = [
      ...(object.propertyCapabilities || []).filter(item => item?.prop !== patch.prop),
      {
        prop: patch.prop,
        patchMode: 'backend_patch',
        scopes: ['object'],
        preview: 'none',
        replay: 'stable',
      },
    ];
    database.prepare(
      'UPDATE project_figures SET manifest = ? WHERE project_id = ? AND figure_index = 0',
    ).run(JSON.stringify(manifest), projectId);
  } finally {
    database.close();
  }
}

function downgradeStoredFingerprintToLegacy(projectId, gid) {
  const database = new Database(process.env.SCIFIGURE_DB_PATH);
  try {
    database.pragma('busy_timeout = 5000');
    const row = database.prepare(
      'SELECT manifest FROM project_figures WHERE project_id = ? AND figure_index = 0',
    ).get(projectId);
    const manifest = parseJson(row?.manifest, null);
    const object = manifest?.objects?.find(item => item.id === gid);
    assert(object, `legacy fingerprint target missing from stored manifest: ${gid}`);
    object.fingerprint = 'legacy-style-sensitive-fingerprint';
    delete object.fingerprintVersion;
    database.prepare(
      'UPDATE project_figures SET manifest = ? WHERE project_id = ? AND figure_index = 0',
    ).run(JSON.stringify(manifest), projectId);
  } finally {
    database.close();
  }
}

async function submitRejectedPatch(token, projectId, patch, label, baseRevision) {
  const result = await jsonRequest('/api/figure/patch', token, {
    method: 'POST',
    body: JSON.stringify({
      sessionId: `${projectId}_fig_1`,
      projectId,
      figureId: 'fig_1',
      requestId: `patch-rejection-${label}-${Date.now()}-${Math.random().toString(36).slice(2)}`,
      baseRevision,
      patches: [patch],
    }),
  });
  assert(result.response.ok, `${label} patch request failed at HTTP layer: ${result.response.status} ${JSON.stringify(result.data)}`);
  return result.data;
}

async function submitPatchBatch(token, projectId, patches, label, baseRevision) {
  const result = await jsonRequest('/api/figure/patch', token, {
    method: 'POST',
    body: JSON.stringify({
      sessionId: `${projectId}_fig_1`,
      projectId,
      figureId: 'fig_1',
      requestId: `patch-batch-${label}-${Date.now()}-${Math.random().toString(36).slice(2)}`,
      baseRevision,
      patches,
    }),
  });
  assert(result.response.ok, `${label} patch batch failed at HTTP layer: ${result.response.status} ${JSON.stringify(result.data)}`);
  return result.data;
}

function readPersistedFigure(projectId, assetId) {
  const database = new Database(process.env.SCIFIGURE_DB_PATH, { readonly: true });
  try {
    database.pragma('busy_timeout = 5000');
    const session = database.prepare('SELECT id, edit_log, revision FROM sessions WHERE id = ?').get(`${projectId}_fig_1`);
    const figure = database.prepare('SELECT session_id, edit_log, revision, history FROM project_figures WHERE project_id = ? AND figure_index = 0').get(projectId);
    const asset = assetId
      ? database.prepare('SELECT id, metadata FROM export_assets WHERE project_id = ? AND id = ?').get(projectId, assetId)
      : null;
    const snapshot = asset
      ? database.prepare('SELECT snapshot_json FROM export_asset_snapshots WHERE asset_id = ?').get(asset.id)
      : null;
    return {
      session: session ? { ...session, editLog: parseJson(session.edit_log, []) } : null,
      figure: figure ? { ...figure, editLog: parseJson(figure.edit_log, []), history: parseJson(figure.history, { past: [], future: [] }) } : null,
      asset: asset ? { ...asset, metadata: parseJson(asset.metadata, {}) } : null,
      snapshot: snapshot ? parseJson(snapshot.snapshot_json, null) : null,
    };
  } finally {
    database.close();
  }
}

async function collectApiStateLeaks(token, projectId, rejectedPatches, leaks) {
  const loaded = await jsonRequest(`/api/projects/${projectId}`, token);
  assert(loaded.response.ok && loaded.data?.status === 'success', `project load failed: ${JSON.stringify(loaded.data)}`);
  const figure = loaded.data.project?.figures?.find(item => item.figureId === 'fig_1');
  assert(figure, 'project load did not return fig_1');
  collectNoRejectedEntries('project API figure', figure.editLog, rejectedPatches, leaks);
  collectJsonDoesNotContainRejected('project API history', figure.history, rejectedPatches, leaks);

  const figures = await jsonRequest(`/api/projects/${projectId}/figures`, token);
  assert(figures.response.ok && figures.data?.status === 'success', `project figures load failed: ${JSON.stringify(figures.data)}`);
  const listed = figures.data.figures?.find(item => item.figureId === 'fig_1');
  assert(listed, 'project figures endpoint did not return fig_1');
  collectNoRejectedEntries('project figures API row', listed.editLog, rejectedPatches, leaks);
  collectJsonDoesNotContainRejected('project figures API history', listed.history, rejectedPatches, leaks);
}

async function exportProjectFigure(token, projectId, name) {
  const exported = await jsonRequest(`/api/projects/${projectId}/export`, token, {
    method: 'POST',
    body: JSON.stringify({
      figureId: 'fig_1',
      format: 'svg',
      dpi: 150,
      saveToLibrary: true,
      name,
    }),
  });
  assert(exported.response.ok && exported.data?.status === 'success', `project export failed: ${JSON.stringify(exported.data)}`);
  const asset = exported.data.figures?.[0]?.asset;
  assert(asset?.assetId, `project export did not create an export asset: ${JSON.stringify(exported.data)}`);
  return asset;
}

async function collectExportStateLeaks(token, projectId, rejectedPatches, baselineMetadata, leaks) {
  const asset = await exportProjectFigure(token, projectId, 'patch-rejection-export-anchor');
  if (asset.metadata?.editCount !== baselineMetadata.editCount) {
    leaks.push(`export asset anchor editCount changed after rejected patches: baseline=${baselineMetadata.editCount}, actual=${asset.metadata?.editCount}`);
  }
  if (asset.metadata?.editLogHash !== baselineMetadata.editLogHash) {
    leaks.push(`export asset anchor editLogHash changed after rejected patches: baseline=${baselineMetadata.editLogHash}, actual=${asset.metadata?.editLogHash}`);
  }
  collectJsonDoesNotContainRejected('export response asset metadata', asset.metadata, rejectedPatches, leaks);
  return asset;
}

function collectDbStateLeaks(projectId, rejectedPatches, baselineMetadata, baselineRevision, assetId, leaks) {
  const persisted = readPersistedFigure(projectId, assetId);
  assert(persisted.session, 'DB session row missing');
  assert(persisted.figure, 'DB project figure row missing');
  collectNoRejectedEntries('DB session', persisted.session.editLog, rejectedPatches, leaks);
  collectNoRejectedEntries('DB project_figure', persisted.figure.editLog, rejectedPatches, leaks);
  if (Number(persisted.session.revision) !== baselineRevision) {
    leaks.push(`DB session revision changed after rejected patches: baseline=${baselineRevision}, actual=${persisted.session.revision}`);
  }
  if (Number(persisted.figure.revision) !== baselineRevision) {
    leaks.push(`DB project_figure revision changed after rejected patches: baseline=${baselineRevision}, actual=${persisted.figure.revision}`);
  }
  collectJsonDoesNotContainRejected('DB project_figure history', persisted.figure.history, rejectedPatches, leaks);
  assert(persisted.asset, 'DB export asset row missing');
  if (persisted.asset.metadata?.editCount !== baselineMetadata.editCount) {
    leaks.push(`DB export asset editCount changed after rejected patches: baseline=${baselineMetadata.editCount}, actual=${persisted.asset.metadata?.editCount}`);
  }
  if (persisted.asset.metadata?.editLogHash !== baselineMetadata.editLogHash) {
    leaks.push(`DB export asset editLogHash changed after rejected patches: baseline=${baselineMetadata.editLogHash}, actual=${persisted.asset.metadata?.editLogHash}`);
  }
  collectJsonDoesNotContainRejected('DB export asset metadata', persisted.asset.metadata, rejectedPatches, leaks);
  assert(persisted.snapshot, 'DB export editing snapshot missing');
  const snapshotFigure = persisted.snapshot.figures?.find(item => item.figureId === 'fig_1');
  assert(snapshotFigure, 'DB export editing snapshot missing fig_1');
  collectNoRejectedEntries('DB export editing snapshot fig_1', snapshotFigure.editLog, rejectedPatches, leaks);
  collectJsonDoesNotContainRejected('DB export editing snapshot', persisted.snapshot, rejectedPatches, leaks);
}

function assertConflictResponse(label, result, rejectedPatch, baselineRevision) {
  assert(result?.status === 'conflict', `${label} should return conflict: ${JSON.stringify(result)}`);
  assert(Number(result?.revision) === baselineRevision, `${label} changed revision: ${JSON.stringify(result)}`);
  assert(Array.isArray(result?.applied) && result.applied.length === 0, `${label} should apply nothing: ${JSON.stringify(result)}`);
  assert(
    Array.isArray(result?.rejected) && result.rejected.some(entry => isRejectedPatch(entry, rejectedPatch)),
    `${label} response does not identify the rejected patch: ${JSON.stringify(result)}`,
  );
}

async function main() {
  assertIsolatedEnvironment();
  const token = await register();
  let projectId = null;
  try {
    await verifyStandalonePatchAuthority(token);
    const created = await createProject(token);
    projectId = created.projectId;
    const baselineRevision = created.initialRevision;
    const rejectedPatches = [rejectedMissingGid, created.unsupportedPatch, created.rendererOnlyPatch];
    const baselineAsset = await exportProjectFigure(token, projectId, 'patch-rejection-baseline-anchor');
    const baselineMetadata = {
      editCount: baselineAsset.metadata?.editCount,
      editLogHash: baselineAsset.metadata?.editLogHash,
    };
    assert(typeof baselineMetadata.editCount === 'number', `baseline export missing editCount: ${JSON.stringify(baselineAsset.metadata)}`);
    assert(typeof baselineMetadata.editLogHash === 'string', `baseline export missing editLogHash: ${JSON.stringify(baselineAsset.metadata)}`);

    const missingResult = await submitRejectedPatch(token, projectId, rejectedMissingGid, 'missing-gid', baselineRevision);
    assertConflictResponse('missing gid patch', missingResult, rejectedMissingGid, baselineRevision);
    const nextBaseRevision = typeof missingResult?.revision === 'number' ? missingResult.revision : baselineRevision;
    const unsupportedResult = await submitRejectedPatch(token, projectId, created.unsupportedPatch, 'unsupported-prop', nextBaseRevision);
    assertConflictResponse('unsupported prop patch', unsupportedResult, created.unsupportedPatch, baselineRevision);
    allowManifestOnlyProperty(projectId, created.rendererOnlyPatch);
    const rendererOnlyResult = await submitRejectedPatch(
      token,
      projectId,
      created.rendererOnlyPatch,
      'renderer-only-rejection',
      baselineRevision,
    );
    assertConflictResponse('renderer-only rejected patch', rendererOnlyResult, created.rendererOnlyPatch, baselineRevision);
    const leaks = [];

    collectJsonDoesNotContainRejected('missing gid patch response editLog', missingResult?.editLog || [], rejectedPatches, leaks);
    collectJsonDoesNotContainRejected('unsupported prop patch response editLog', unsupportedResult?.editLog || [], rejectedPatches, leaks);
    await collectApiStateLeaks(token, projectId, rejectedPatches, leaks);
    const postPatchAsset = await collectExportStateLeaks(token, projectId, rejectedPatches, baselineMetadata, leaks);
    collectDbStateLeaks(projectId, rejectedPatches, baselineMetadata, baselineRevision, postPatchAsset.assetId, leaks);
    assert(leaks.length === 0, `rejected patch persistence leak(s):\n- ${leaks.join('\n- ')}`);

    const mixedResult = await submitPatchBatch(
      token,
      projectId,
      created.validMixedPatches,
      'local-and-backend',
      baselineRevision,
    );
    assert(mixedResult?.status === 'success', `valid mixed patch batch failed: ${JSON.stringify(mixedResult)}`);
    assert(Number(mixedResult?.revision) === baselineRevision + 1, `mixed batch revision should advance once: ${JSON.stringify(mixedResult)}`);
    for (const patch of created.validMixedPatches) {
      assert(
        Array.isArray(mixedResult.editLog) && mixedResult.editLog.some(entry => isRejectedPatch(entry, patch)),
        `mixed batch editLog lost ${patch.mode} patch: ${JSON.stringify(mixedResult)}`,
      );
    }
    const lineIdentitySource = created.validMixedPatches.find(patch => patch.prop === 'linewidth');
    assert(lineIdentitySource, 'mixed batch is missing its linewidth identity source');
    const persistedColor = mixedResult.editLog.find(entry => entry.prop === 'color' && entry.value === '#7a1f5c');
    const persistedLinewidth = mixedResult.editLog.find(entry => entry.prop === 'linewidth' && Number(entry.value) === 2.75);
    assert(persistedColor?.mode === 'local_patch', `authoritative local color mode was not preserved: ${JSON.stringify(mixedResult)}`);
    assert(persistedLinewidth?.mode === 'backend_patch', `backend-only linewidth trusted the client local mode: ${JSON.stringify(mixedResult)}`);
    assert(typeof mixedResult.svg === 'string' && mixedResult.svg.includes('<svg'), 'mixed batch did not execute a backend render');
    await assertProjectPreviewCacheFresh(token, projectId, lineIdentitySource, baselineRevision + 1);

    const pureLocalResult = await submitPatchBatch(
      token,
      projectId,
      [created.pureLocalPatch],
      'pure-local-cache-invalidation',
      baselineRevision + 1,
    );
    assert(pureLocalResult?.status === 'success', `pure local patch failed: ${JSON.stringify(pureLocalResult)}`);
    assert(Number(pureLocalResult?.revision) === baselineRevision + 2, `pure local patch revision mismatch: ${JSON.stringify(pureLocalResult)}`);
    const invalidatedPreview = readProjectFigurePreviewCache(projectId);
    assert(invalidatedPreview, 'pure local patch removed project figure row');
    assert(
      invalidatedPreview.preview_svg === null && invalidatedPreview.manifest === null,
      `pure local patch retained stale preview cache: ${JSON.stringify(invalidatedPreview)}`,
    );
    const refreshedListing = await jsonRequest(`/api/projects/${projectId}/figures?includePreview=1`, token);
    assert(refreshedListing.response.ok && refreshedListing.data?.status === 'success', `pure local preview refresh failed: ${JSON.stringify(refreshedListing.data)}`);
    const refreshedFigure = refreshedListing.data.figures?.find(item => item.figureId === 'fig_1');
    assert(refreshedFigure, 'pure local preview refresh did not return fig_1');
    assert(Number(refreshedFigure.revision) === baselineRevision + 2, `pure local preview refresh revision mismatch: ${JSON.stringify(refreshedFigure)}`);
    assertManifestPatchValue(refreshedFigure.manifest, created.pureLocalPatch, 'pure local refreshed preview');
    await assertProjectPreviewCacheFresh(token, projectId, created.pureLocalPatch, baselineRevision + 2);
    const mixedPersisted = readPersistedFigure(projectId, null);
    for (const patch of created.validMixedPatches) {
      assert(
        mixedPersisted.session?.editLog?.some(entry => isRejectedPatch(entry, patch)),
        `DB session lost mixed ${patch.mode} patch: ${JSON.stringify(mixedPersisted.session)}`,
      );
      assert(
        mixedPersisted.figure?.editLog?.some(entry => isRejectedPatch(entry, patch)),
        `DB project figure lost mixed ${patch.mode} patch: ${JSON.stringify(mixedPersisted.figure)}`,
      );
    }

    downgradeStoredFingerprintToLegacy(projectId, lineIdentitySource.gid);
    const legacyManifestPatch = {
      op: 'set',
      mode: 'backend_patch',
      gid: lineIdentitySource.gid,
      prop: 'linestyle',
      value: '--',
      stableKey: lineIdentitySource.stableKey,
      identity: lineIdentitySource.identity,
    };
    const legacyResult = await submitPatchBatch(
      token,
      projectId,
      [legacyManifestPatch],
      'legacy-unversioned-fingerprint',
      baselineRevision + 2,
    );
    assert(legacyResult?.status === 'success', `legacy manifest first edit was rejected: ${JSON.stringify(legacyResult)}`);
    assert(Number(legacyResult?.revision) === baselineRevision + 3, `legacy manifest edit revision mismatch: ${JSON.stringify(legacyResult)}`);
    assert(
      legacyResult.editLog?.some(entry => isRejectedPatch(entry, legacyManifestPatch)),
      `legacy manifest edit did not persist: ${JSON.stringify(legacyResult)}`,
    );

    console.log(JSON.stringify({
      status: 'PASS',
      projectId,
      checked: [
        'missing gid rejected patch was not persisted',
        'unsupported prop rejected patch was not persisted',
        'renderer-rejected patch was not persisted after manifest precheck passed',
        'standalone direct session forced lying local patches through backend validation',
        'standalone missing gid conflict did not change revision or editLog',
        'session editLog, project figure edit_log/history, and export anchors stayed clean',
        'valid mixed local/backend batch persisted both edits in one revision',
        'pure local project patch invalidated stale preview and refreshed from latest editLog',
        'legacy unversioned fingerprint accepted a stableKey/seriesKey-compatible first edit',
      ],
    }, null, 2));
  } finally {
    if (projectId) {
      await jsonRequest(`/api/projects/${projectId}`, token, { method: 'DELETE' }).catch(() => null);
    }
  }
}

main().catch(error => {
  console.error(JSON.stringify({ status: 'FAIL', message: error.message }, null, 2));
  process.exitCode = 1;
});
