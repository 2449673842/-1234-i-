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
  'fig, axes = plt.subplots(2, 3, figsize=(9, 5))',
  'ax0, ax1, ax2, ax3, ax4, ax5 = axes.ravel()',
  'ax0.plot([0, 1, 2], [1, 3, 2], color="#225577", linewidth=1.2, label="series")',
  'ax0.set_title("Patch rejection persistence")',
  'ax0.set_xlabel("Original X")',
  'ax0.set_ylabel("Original Y")',
  'ax0.legend(loc="upper left")',
  'ax1.hist([0, 1, 1, 2, 2, 2], bins=[0, 1, 2, 3], color="#4477aa", alpha=0.6, label="hist")',
  'ax1.legend(loc="upper right")',
  'ax2.stairs([1, 2, 1], [0, 1, 2, 3], color="#cc6677", label="stairs")',
  'ax2.legend(loc="upper right")',
  'ax3.step([0, 1, 2], [2, 1, 3], where="mid", color="#228833", label="step")',
  'ax3.legend(loc="upper right")',
  'wedges, labels, values = ax4.pie([2, 3, 5], labels=["A", "B", "C"], colors=["#4477aa", "#cc6677", "#228833"], autopct="%1.0f%%")',
  'ax4.legend(wedges, ["A", "B", "C"], loc="upper right")',
  'ax5.plot([0, 1], [0, 1], color="#555555", label="control")',
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

function patchValueEquals(actual, expected) {
  return JSON.stringify(actual) === JSON.stringify(expected);
}

function collectJsonDoesNotContainRejectedTriplets(label, value, rejectedPatches, leaks) {
  const leaked = [];
  const visit = (node) => {
    if (!node || typeof node !== 'object') return;
    if (rejectedPatches.some(rejected => isRejectedPatch(node, rejected))) {
      leaked.push(node);
    }
    if (Array.isArray(node)) {
      node.forEach(visit);
      return;
    }
    Object.values(node).forEach(visit);
  };
  visit(value);
  if (leaked.length > 0) {
    leaks.push(`${label} contains rejected patch object(s): ${JSON.stringify(leaked)}`);
  }
}

function collectManifestDoesNotApplyStructuralPatches(label, manifest, rejectedPatches, leaks) {
  assert(Array.isArray(manifest?.objects), `${label} manifest is missing objects`);
  for (const rejected of rejectedPatches) {
    const object = manifest.objects.find(item => item.id === rejected.gid);
    assert(object, `${label} manifest is missing structural rejection target ${rejected.gid}`);
    if (patchValueEquals(object.currentProps?.[rejected.prop], rejected.value)) {
      leaks.push(`${label} applied rejected structural value ${rejected.gid}.${rejected.prop}=${JSON.stringify(rejected.value)}`);
    }
  }
}

function capabilityProps(object) {
  return Array.isArray(object?.propertyCapabilities)
    ? object.propertyCapabilities.map(capability => capability?.prop)
    : [];
}

function assertStructuralTarget(object, role, kind, prop) {
  assert(object?.id, `initial render has no ${role} target`);
  assert(object.kind === kind, `${role} should retain historical kind ${kind}: ${JSON.stringify(object)}`);
  assert(!object.editable?.includes(prop), `${role} exposes structural ${prop} as editable: ${JSON.stringify(object)}`);
  assert(!capabilityProps(object).includes(prop), `${role} exposes structural ${prop} capability: ${JSON.stringify(object)}`);
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
    object.kind === 'line' && object.role !== 'step_series' && object.editable?.includes('linewidth')
  ));
  const histogramTarget = figure.manifest.objects.find(object => (
    object.kind === 'bar_container' && object.role === 'histogram_series'
  ));
  const stairsTarget = figure.manifest.objects.find(object => (
    object.kind === 'patch' && object.role === 'stairs_series'
  ));
  const stepTarget = figure.manifest.objects.find(object => (
    object.kind === 'line' && object.role === 'step_series'
  ));
  const pieTarget = figure.manifest.objects.find(object => (
    object.kind === 'patch' && object.role === 'pie_slice'
  ));
  const localTarget = figure.manifest.objects.find(object => (
    Array.isArray(object.propertyCapabilities)
      && object.propertyCapabilities.some(capability => capability?.prop === 'color' && capability?.patchMode === 'local_patch')
  ));
  assert(lineTarget?.id, 'initial render has no editable line target for mixed batch regression');
  assertStructuralTarget(histogramTarget, 'histogram_series', 'bar_container', 'bins');
  assertStructuralTarget(stairsTarget, 'stairs_series', 'patch', 'edges');
  assertStructuralTarget(stepTarget, 'step_series', 'line', 'where');
  assertStructuralTarget(pieTarget, 'pie_slice', 'patch', 'radius');
  assert(localTarget?.id, 'initial render has no capability-declared local color target for cache invalidation regression');
  return {
    projectId,
    unsupportedPatch: unsupportedPatchFor(target.id),
    rendererOnlyPatch: rendererOnlyRejectedPatchFor(target.id),
    structuralRejectedPatches: [
      {
        op: 'set',
        mode: 'backend_patch',
        gid: histogramTarget.id,
        prop: 'bins',
        value: [0, 1, 3],
        ...identityFields(histogramTarget),
      },
      {
        op: 'set',
        mode: 'backend_patch',
        gid: stairsTarget.id,
        prop: 'edges',
        value: [0, 2, 3, 4],
        ...identityFields(stairsTarget),
      },
      {
        op: 'set',
        mode: 'backend_patch',
        gid: stepTarget.id,
        prop: 'where',
        value: 'post',
        ...identityFields(stepTarget),
      },
      {
        op: 'set',
        mode: 'backend_patch',
        gid: pieTarget.id,
        prop: 'radius',
        value: 2,
        ...identityFields(pieTarget),
      },
    ],
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

function omitModernCapabilityButKeepLegacyEditable(projectId, gid, prop) {
  const database = new Database(process.env.SCIFIGURE_DB_PATH);
  try {
    database.pragma('busy_timeout = 5000');
    const row = database.prepare(
      'SELECT manifest FROM project_figures WHERE project_id = ? AND figure_index = 0',
    ).get(projectId);
    const manifest = parseJson(row?.manifest, null);
    const object = manifest?.objects?.find(item => item.id === gid);
    assert(object, `modern omitted capability target missing from stored manifest: ${gid}`);
    const original = {
      editable: clone(object.editable || []),
      propertyCapabilities: clone(object.propertyCapabilities || []),
    };
    object.editable = Array.from(new Set([...(object.editable || []), prop]));
    object.propertyCapabilities = Array.isArray(object.propertyCapabilities)
      ? object.propertyCapabilities.filter(item => item?.prop !== prop)
      : [];
    database.prepare(
      'UPDATE project_figures SET manifest = ? WHERE project_id = ? AND figure_index = 0',
    ).run(JSON.stringify(manifest), projectId);
    return original;
  } finally {
    database.close();
  }
}

function restoreStoredObjectCapabilityFields(projectId, gid, fields) {
  const database = new Database(process.env.SCIFIGURE_DB_PATH);
  try {
    database.pragma('busy_timeout = 5000');
    const row = database.prepare(
      'SELECT manifest FROM project_figures WHERE project_id = ? AND figure_index = 0',
    ).get(projectId);
    const manifest = parseJson(row?.manifest, null);
    const object = manifest?.objects?.find(item => item.id === gid);
    assert(object, `capability restore target missing from stored manifest: ${gid}`);
    object.editable = clone(fields.editable || []);
    object.propertyCapabilities = clone(fields.propertyCapabilities || []);
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

async function collectApiStateLeaks(token, projectId, editLogRejectedPatches, nonStructuralRejectedPatches, structuralRejectedPatches, leaks) {
  const loaded = await jsonRequest(`/api/projects/${projectId}`, token);
  assert(loaded.response.ok && loaded.data?.status === 'success', `project load failed: ${JSON.stringify(loaded.data)}`);
  const figure = loaded.data.project?.figures?.find(item => item.figureId === 'fig_1');
  assert(figure, 'project load did not return fig_1');
  collectNoRejectedEntries('project API figure', figure.editLog, editLogRejectedPatches, leaks);
  collectJsonDoesNotContainRejected('project API history', figure.history, nonStructuralRejectedPatches, leaks);
  collectJsonDoesNotContainRejectedTriplets('project API history', figure.history, structuralRejectedPatches, leaks);

  const figures = await jsonRequest(`/api/projects/${projectId}/figures`, token);
  assert(figures.response.ok && figures.data?.status === 'success', `project figures load failed: ${JSON.stringify(figures.data)}`);
  const listed = figures.data.figures?.find(item => item.figureId === 'fig_1');
  assert(listed, 'project figures endpoint did not return fig_1');
  collectNoRejectedEntries('project figures API row', listed.editLog, editLogRejectedPatches, leaks);
  collectJsonDoesNotContainRejected('project figures API history', listed.history, nonStructuralRejectedPatches, leaks);
  collectJsonDoesNotContainRejectedTriplets('project figures API history', listed.history, structuralRejectedPatches, leaks);
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

async function collectExportStateLeaks(token, projectId, rejectedPatches, structuralRejectedPatches, baselineMetadata, leaks) {
  const asset = await exportProjectFigure(token, projectId, 'patch-rejection-export-anchor');
  if (asset.metadata?.editCount !== baselineMetadata.editCount) {
    leaks.push(`export asset anchor editCount changed after rejected patches: baseline=${baselineMetadata.editCount}, actual=${asset.metadata?.editCount}`);
  }
  if (asset.metadata?.editLogHash !== baselineMetadata.editLogHash) {
    leaks.push(`export asset anchor editLogHash changed after rejected patches: baseline=${baselineMetadata.editLogHash}, actual=${asset.metadata?.editLogHash}`);
  }
  collectJsonDoesNotContainRejected('export response asset metadata', asset.metadata, rejectedPatches, leaks);
  collectJsonDoesNotContainRejectedTriplets('export response asset metadata', asset.metadata, structuralRejectedPatches, leaks);
  return asset;
}

function collectProjectPreviewCacheLeaks(projectId, structuralRejectedPatches, baselineRevision, leaks) {
  const stored = readProjectFigurePreviewCache(projectId);
  assert(stored, 'project figure preview cache row is missing after rejected patches');
  if (Number(stored.revision) !== baselineRevision) {
    leaks.push(`project preview cache revision changed after rejected patches: baseline=${baselineRevision}, actual=${stored.revision}`);
  }
  collectManifestDoesNotApplyStructuralPatches('project preview cache', stored.manifest, structuralRejectedPatches, leaks);
  collectJsonDoesNotContainRejectedTriplets('project preview cache manifest', stored.manifest, structuralRejectedPatches, leaks);
}

function collectDbStateLeaks(projectId, editLogRejectedPatches, nonStructuralRejectedPatches, structuralRejectedPatches, baselineMetadata, baselineRevision, assetId, leaks) {
  const persisted = readPersistedFigure(projectId, assetId);
  assert(persisted.session, 'DB session row missing');
  assert(persisted.figure, 'DB project figure row missing');
  collectNoRejectedEntries('DB session', persisted.session.editLog, editLogRejectedPatches, leaks);
  collectNoRejectedEntries('DB project_figure', persisted.figure.editLog, editLogRejectedPatches, leaks);
  if (Number(persisted.session.revision) !== baselineRevision) {
    leaks.push(`DB session revision changed after rejected patches: baseline=${baselineRevision}, actual=${persisted.session.revision}`);
  }
  if (Number(persisted.figure.revision) !== baselineRevision) {
    leaks.push(`DB project_figure revision changed after rejected patches: baseline=${baselineRevision}, actual=${persisted.figure.revision}`);
  }
  collectJsonDoesNotContainRejected('DB project_figure history', persisted.figure.history, nonStructuralRejectedPatches, leaks);
  collectJsonDoesNotContainRejectedTriplets('DB project_figure history', persisted.figure.history, structuralRejectedPatches, leaks);
  assert(persisted.asset, 'DB export asset row missing');
  if (persisted.asset.metadata?.editCount !== baselineMetadata.editCount) {
    leaks.push(`DB export asset editCount changed after rejected patches: baseline=${baselineMetadata.editCount}, actual=${persisted.asset.metadata?.editCount}`);
  }
  if (persisted.asset.metadata?.editLogHash !== baselineMetadata.editLogHash) {
    leaks.push(`DB export asset editLogHash changed after rejected patches: baseline=${baselineMetadata.editLogHash}, actual=${persisted.asset.metadata?.editLogHash}`);
  }
  collectJsonDoesNotContainRejected('DB export asset metadata', persisted.asset.metadata, nonStructuralRejectedPatches, leaks);
  collectJsonDoesNotContainRejectedTriplets('DB export asset metadata', persisted.asset.metadata, structuralRejectedPatches, leaks);
  assert(persisted.snapshot, 'DB export editing snapshot missing');
  const snapshotFigure = persisted.snapshot.figures?.find(item => item.figureId === 'fig_1');
  assert(snapshotFigure, 'DB export editing snapshot missing fig_1');
  collectNoRejectedEntries('DB export editing snapshot fig_1', snapshotFigure.editLog, editLogRejectedPatches, leaks);
  collectJsonDoesNotContainRejected('DB export editing snapshot', persisted.snapshot, nonStructuralRejectedPatches, leaks);
  collectJsonDoesNotContainRejectedTriplets('DB export editing snapshot', persisted.snapshot, structuralRejectedPatches, leaks);
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
    const allRejectedPatches = [...rejectedPatches, ...created.structuralRejectedPatches];
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
    const structuralResults = [];
    for (const structuralPatch of created.structuralRejectedPatches) {
      const structuralResult = await submitRejectedPatch(
        token,
        projectId,
        structuralPatch,
        `structural-${structuralPatch.prop}`,
        baselineRevision,
      );
      assertConflictResponse(`structural ${structuralPatch.prop} patch`, structuralResult, structuralPatch, baselineRevision);
      if (structuralResult.manifest) {
        const responseManifestLeaks = [];
        collectManifestDoesNotApplyStructuralPatches(
          `structural ${structuralPatch.prop} response`,
          structuralResult.manifest,
          [structuralPatch],
          responseManifestLeaks,
        );
        assert(responseManifestLeaks.length === 0, responseManifestLeaks.join('\n'));
      }
      structuralResults.push(structuralResult);
    }
    const leaks = [];

    collectJsonDoesNotContainRejected('missing gid patch response editLog', missingResult?.editLog || [], rejectedPatches, leaks);
    collectJsonDoesNotContainRejected('unsupported prop patch response editLog', unsupportedResult?.editLog || [], rejectedPatches, leaks);
    collectJsonDoesNotContainRejected('renderer-only patch response editLog', rendererOnlyResult?.editLog || [], rejectedPatches, leaks);
    for (const structuralResult of structuralResults.filter(result => result?.status)) {
      collectNoRejectedEntries('structural patch response editLog', structuralResult?.editLog || [], allRejectedPatches, leaks);
      collectJsonDoesNotContainRejectedTriplets('structural patch response editLog', structuralResult?.editLog || [], created.structuralRejectedPatches, leaks);
    }
    await collectApiStateLeaks(token, projectId, allRejectedPatches, rejectedPatches, created.structuralRejectedPatches, leaks);
    collectProjectPreviewCacheLeaks(projectId, created.structuralRejectedPatches, baselineRevision, leaks);
    const postPatchAsset = await collectExportStateLeaks(token, projectId, rejectedPatches, created.structuralRejectedPatches, baselineMetadata, leaks);
    collectDbStateLeaks(projectId, allRejectedPatches, rejectedPatches, created.structuralRejectedPatches, baselineMetadata, baselineRevision, postPatchAsset.assetId, leaks);
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
    const staleProjectSave = await jsonRequest(`/api/projects/${projectId}`, token, {
      method: 'PUT',
      body: JSON.stringify({
        name: 'Patch rejection persistence regression',
        spec: {
          plot_type: 'custom',
          custom_script: script,
          script,
          script_language: 'python',
        },
        figures: [{
          figureId: 'fig_1',
          index: 0,
          baseRevision: baselineRevision + 1,
          revision: baselineRevision + 1,
          editLog: mixedResult.editLog,
        }],
      }),
    });
    assert(
      staleProjectSave.response.status === 409
        && staleProjectSave.data?.status === 'conflict'
        && staleProjectSave.data?.code === 'PROJECT_SAVE_REVISION_CONFLICT',
      `stale project save did not return a revision conflict: ${JSON.stringify(staleProjectSave.data)}`,
    );
    const missingHashProjectSave = await jsonRequest(`/api/projects/${projectId}`, token, {
      method: 'PUT',
      body: JSON.stringify({
        name: 'Patch rejection persistence regression',
        spec: {
          plot_type: 'custom',
          custom_script: script,
          script,
          script_language: 'python',
        },
        figures: [{
          figureId: 'fig_1',
          index: 0,
          baseRevision: baselineRevision + 2,
          revision: baselineRevision + 2,
          editLog: mixedResult.editLog,
        }],
      }),
    });
    assert(
      missingHashProjectSave.response.status === 409
        && missingHashProjectSave.data?.status === 'conflict'
        && missingHashProjectSave.data?.code === 'PROJECT_SAVE_PRECONDITION_REQUIRED',
      `same-revision stale project save without hash was not rejected: ${JSON.stringify(missingHashProjectSave.data)}`,
    );
    const sameRevisionStaleProjectSave = await jsonRequest(`/api/projects/${projectId}`, token, {
      method: 'PUT',
      body: JSON.stringify({
        name: 'Patch rejection persistence regression',
        spec: {
          plot_type: 'custom',
          custom_script: script,
          script,
          script_language: 'python',
        },
        figures: [{
          figureId: 'fig_1',
          index: 0,
          baseRevision: baselineRevision + 2,
          baseEditLogHash: 'stale-edit-log-hash',
          revision: baselineRevision + 2,
          editLog: mixedResult.editLog,
        }],
      }),
    });
    assert(
      sameRevisionStaleProjectSave.response.status === 409
        && sameRevisionStaleProjectSave.data?.status === 'conflict'
        && sameRevisionStaleProjectSave.data?.code === 'PROJECT_SAVE_EDIT_LOG_CONFLICT',
      `same-revision stale project save did not return an edit-log conflict: ${JSON.stringify(sameRevisionStaleProjectSave.data)}`,
    );
    const afterStaleProjectSave = readPersistedFigure(projectId, null);
    assert(
      Number(afterStaleProjectSave.session?.revision) === baselineRevision + 2
        && Number(afterStaleProjectSave.figure?.revision) === baselineRevision + 2,
      `stale project save changed revision: ${JSON.stringify(afterStaleProjectSave)}`,
    );
    assert(
      afterStaleProjectSave.session?.editLog?.some(entry => isRejectedPatch(entry, created.pureLocalPatch))
        && afterStaleProjectSave.figure?.editLog?.some(entry => isRejectedPatch(entry, created.pureLocalPatch)),
      `stale project save removed the newer local patch: ${JSON.stringify(afterStaleProjectSave)}`,
    );
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

    const originalModernCapabilityFields = omitModernCapabilityButKeepLegacyEditable(projectId, lineIdentitySource.gid, 'linewidth');
    const modernOmittedCapabilityPatch = {
      op: 'set',
      // Service must reject this before renderer replay: the stored manifest is
      // modern because propertyCapabilities exists, and linewidth is omitted.
      mode: 'backend_patch',
      gid: lineIdentitySource.gid,
      prop: 'linewidth',
      value: 4.5,
      stableKey: lineIdentitySource.stableKey,
      fingerprint: lineIdentitySource.fingerprint,
      fingerprintVersion: lineIdentitySource.fingerprintVersion,
      identity: lineIdentitySource.identity,
    };
    const modernOmittedCapabilityResult = await submitRejectedPatch(
      token,
      projectId,
      modernOmittedCapabilityPatch,
      'modern-omitted-capability',
      baselineRevision + 2,
    );
    assertConflictResponse(
      'modern manifest omitted capability patch',
      modernOmittedCapabilityResult,
      modernOmittedCapabilityPatch,
      baselineRevision + 2,
    );
    const afterModernOmittedCapability = readPersistedFigure(projectId, null);
    assert(
      Number(afterModernOmittedCapability.session?.revision) === baselineRevision + 2
        && Number(afterModernOmittedCapability.figure?.revision) === baselineRevision + 2,
      `modern omitted capability rejection changed revision: ${JSON.stringify(afterModernOmittedCapability)}`,
    );
    assert(
      !afterModernOmittedCapability.session?.editLog?.some(entry => isRejectedPatch(entry, modernOmittedCapabilityPatch))
        && !afterModernOmittedCapability.figure?.editLog?.some(entry => isRejectedPatch(entry, modernOmittedCapabilityPatch)),
      `modern omitted capability patch leaked into DB: ${JSON.stringify(afterModernOmittedCapability)}`,
    );
    restoreStoredObjectCapabilityFields(projectId, lineIdentitySource.gid, originalModernCapabilityFields);

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
        'histogram bins, stairs edges, step where, and pie radius structural patches were rejected without persistence',
        'standalone direct session forced lying local patches through backend validation',
        'standalone missing gid conflict did not change revision or editLog',
        'session editLog, project figure edit_log/history, and export anchors stayed clean',
        'valid mixed local/backend batch persisted both edits in one revision',
        'pure local project patch invalidated stale preview and refreshed from latest editLog',
        'stale project save was rejected without removing a newer server patch',
        'same-revision editLog mutation without a base hash was rejected without persistence',
        'same-revision stale editLog hash was rejected without persistence',
        'modern manifest omitted capability did not fall back to legacy editable on the server',
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
