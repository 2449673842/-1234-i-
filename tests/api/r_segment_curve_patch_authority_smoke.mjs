import Database from 'better-sqlite3';
import path from 'node:path';

const BASE_URL = process.env.SCIFIGURE_URL || '';

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

function stable(value) {
  if (Array.isArray(value)) return value.map(stable);
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(Object.keys(value).sort().map((key) => [key, stable(value[key])]));
}

function assertSame(label, before, after) {
  assert(
    JSON.stringify(stable(before)) === JSON.stringify(stable(after)),
    `${label} changed persisted state\nbefore=${JSON.stringify(before, null, 2)}\nafter=${JSON.stringify(after, null, 2)}`,
  );
}

function assertIsolatedEnvironment() {
  assert(process.env.SCIFIGURE_TEST_ISOLATED === '1', 'test must run through run_with_isolated_server.mjs');
  assert(BASE_URL, 'SCIFIGURE_URL is required');
  const url = new URL(BASE_URL);
  assert(url.hostname === '127.0.0.1' && url.port !== '3000', `unsafe smoke URL: ${BASE_URL}`);

  const dataDir = process.env.SCIFIGURE_DATA_DIR;
  const dbPath = process.env.SCIFIGURE_DB_PATH;
  assert(dataDir && dbPath, 'isolated data and database paths are required');
  const resolvedDataDir = path.resolve(dataDir);
  const resolvedDbPath = path.resolve(dbPath);
  assert(path.basename(path.dirname(resolvedDataDir)).startsWith('scifigure-isolated-smoke-'), `unsafe data dir: ${resolvedDataDir}`);
  assert(resolvedDbPath.startsWith(`${resolvedDataDir}${path.sep}`), `database is outside isolated data dir: ${resolvedDbPath}`);
  assert(resolvedDataDir !== path.resolve(process.cwd(), 'data'), 'test refuses repository data/');
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
      email: `r-segment-curve-${Date.now()}-${Math.random().toString(36).slice(2)}@example.test`,
      password: 'R-Segment-Curve-Authority-2026',
    }),
  });
  assert(result.response.ok && result.data?.token, `registration failed: ${JSON.stringify(result.data)}`);
  return result.data.token;
}

const rScript = [
  'library(ggplot2)',
  'library(grid)',
  'segment_df <- data.frame(x=c(1, 2), y=c(1, 2), xend=c(2.5, 3.5), yend=c(2.2, 1.2), label=c("S1", "S2"))',
  'curve_df <- data.frame(x=1.2, y=3.2, xend=3.8, yend=3.6)',
  'p <- ggplot() +',
  '  geom_segment(data=segment_df, aes(x=x, y=y, xend=xend, yend=yend), colour="#1F78B4", linewidth=0.8, linetype="dashed", alpha=0.75, lineend="round", linejoin="mitre", arrow=arrow(length=unit(3, "mm"), type="closed", ends="last")) +',
  '  geom_curve(data=curve_df, aes(x=x, y=y, xend=xend, yend=yend), colour="#33A02C", linewidth=1.1, curvature=0.35, angle=75, ncp=8, lineend="butt", arrow=arrow(length=unit(0.15, "in"), type="open", ends="both")) +',
  '  geom_text(data=segment_df[1, ], aes(x=xend, y=yend, label=label), nudge_y=0.15) +',
  '  theme_classic()',
  'p',
].join('\n');

const mappedRScript = [
  'library(ggplot2)',
  'segment_df <- data.frame(x=c(1, 2, 1.5, 2.5), y=c(1, 2, 2.5, 1.5), xend=c(2, 3, 2.5, 3.5), yend=c(2, 1, 3.2, 2.2), group=c("A", "A", "B", "B"), weight=c(0.6, 0.9, 1.2, 1.5))',
  'curve_df <- data.frame(x=c(1, 2), y=c(3.5, 4), xend=c(2.5, 3.5), yend=c(4.1, 3.4), opacity=c(0.35, 0.8))',
  'p <- ggplot() +',
  '  geom_segment(data=segment_df, aes(x=x, y=y, xend=xend, yend=yend, colour=group, linewidth=weight, linetype=group), alpha=0.7) +',
  '  geom_curve(data=curve_df, aes(x=x, y=y, xend=xend, yend=yend, alpha=opacity), colour="#33A02C", linewidth=0.9, curvature=0.3) +',
  '  scale_colour_manual(values=c(A="#1F78B4", B="#E31A1C")) +',
  '  scale_linetype_manual(values=c(A="solid", B="dashed")) +',
  '  scale_linewidth_continuous(range=c(0.5, 1.5)) +',
  '  scale_alpha_continuous(range=c(0.3, 0.9)) +',
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

function backendPatch(object, prop, value, mode = 'backend_patch') {
  return {
    op: 'set',
    mode,
    gid: object.id,
    prop,
    value,
    ...identityFields(object),
  };
}

function samePatch(left, right) {
  return left?.gid === right?.gid
    && left?.prop === right?.prop
    && JSON.stringify(left?.value) === JSON.stringify(right?.value);
}

function findFamily(manifest, adapterFamily, requireAllStyles = true) {
  const object = (manifest?.objects || []).find((candidate) => candidate?.currentProps?.adapterFamily === adapterFamily);
  assert(object?.id, `missing ${adapterFamily} object: ${JSON.stringify(manifest)}`);
  const expectedClass = adapterFamily === 'segment' ? 'GeomSegment' : 'GeomCurve';
  assert(object.kind === 'line', `${adapterFamily} kind drifted: ${JSON.stringify(object)}`);
  assert(object.role === `ggplot_${expectedClass}`, `${adapterFamily} role drifted: ${JSON.stringify(object)}`);
  assert(object.source?.adapterClass === expectedClass, `${adapterFamily} adapter class drifted: ${JSON.stringify(object)}`);
  assert(object.id.startsWith('r.layer.'), `${adapterFamily} legacy gid drifted: ${object.id}`);
  assert(Array.isArray(object.currentProps?.structureReadonly), `${adapterFamily} readonly structure is missing`);
  for (const prop of ['x', 'y', 'xend', 'yend', 'arrow']) {
    assert(object.currentProps.structureReadonly.includes(prop), `${adapterFamily} does not mark ${prop} readonly`);
    assert(!object.editable?.includes(prop), `${adapterFamily} exposes ${prop} as editable`);
    assert(!object.propertyCapabilities?.some((capability) => capability?.prop === prop), `${adapterFamily} exposes a ${prop} capability`);
  }
  if (requireAllStyles) {
    for (const prop of ['color', 'linewidth', 'linestyle', 'alpha']) {
      assert(object.editable?.includes(prop), `${adapterFamily} is missing editable ${prop}`);
      assert(object.propertyCapabilities?.some((capability) => capability?.prop === prop && capability.patchMode === 'backend_patch'), `${adapterFamily} is missing backend capability ${prop}`);
    }
  }
  const relation = object.identity?.relation || {};
  assert(!relation.arrowId && !relation.textId, `${adapterFamily} guessed an arrow/text relation: ${JSON.stringify(relation)}`);
  return object;
}

function assertNoArrowChild(manifest) {
  const forbiddenRoles = new Set(['diagram_arrow', 'annotation_arrow', 'ggplot_segment_arrow', 'ggplot_curve_arrow']);
  assert(
    !(manifest?.objects || []).some((object) => forbiddenRoles.has(object?.role)),
    `renderer created an unproven arrow child: ${JSON.stringify(manifest?.objects)}`,
  );
}

function structuralSnapshot(object) {
  const result = {};
  for (const prop of object.currentProps?.structureReadonly || []) result[prop] = clone(object.currentProps?.[prop]);
  return result;
}

function readDatabaseState(projectId, standaloneSessionId) {
  const database = new Database(process.env.SCIFIGURE_DB_PATH, { readonly: true });
  try {
    database.pragma('busy_timeout = 5000');
    const sessionIds = [`${projectId}_fig_1`, standaloneSessionId].filter(Boolean);
    const sessions = Object.fromEntries(sessionIds.map((id) => {
      const row = database.prepare(`
        SELECT id, script, data_payload, edit_log, revision, created_at, updated_at
        FROM sessions
        WHERE id = ?
      `).get(id);
      return [id, row ? {
        script: row.script,
        dataPayload: parseJson(row.data_payload, null),
        revision: Number(row.revision),
        editLog: parseJson(row.edit_log, []),
        createdAt: row.created_at,
        updatedAt: row.updated_at,
      } : null];
    }));
    const figure = database.prepare(`
      SELECT revision, edit_log, history, preview_svg, manifest, code_slice, fingerprint, preview_updated_at
      FROM project_figures
      WHERE project_id = ? AND figure_index = 0
    `).get(projectId);
    const renderCache = database.prepare('SELECT cache_key, svg, manifest, code_slice, created_at FROM render_cache ORDER BY cache_key').all();
    const exportAssets = database.prepare('SELECT id, figure_id, name, format, metadata, tags, created_at FROM export_assets WHERE project_id = ? ORDER BY id').all(projectId);
    const exportSnapshots = database.prepare('SELECT asset_id, figure_id, schema_version, snapshot_hash, snapshot_json, created_at FROM export_asset_snapshots WHERE project_id = ? ORDER BY asset_id').all(projectId);
    return {
      sessions,
      figure: figure ? {
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
        createdAt: row.created_at,
      })),
      exportAssets: exportAssets.map((row) => ({ ...row, metadata: parseJson(row.metadata, {}), tags: parseJson(row.tags, []) })),
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

async function createProject(token) {
  const created = await jsonRequest('/api/projects', token, {
    method: 'POST',
    body: JSON.stringify({
      name: `R segment curve authority ${Date.now()}`,
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
      requestId: `r-segment-curve-render-${Date.now()}-${Math.random().toString(36).slice(2)}`,
    }),
  });
  assert(rendered.response.ok && rendered.data?.status === 'success', `project render failed: ${JSON.stringify(rendered.data)}`);
  const figure = rendered.data.figures?.find((item) => item.figureId === 'fig_1');
  assert(figure?.manifest, `project render returned no manifest: ${JSON.stringify(rendered.data)}`);
  assertNoArrowChild(figure.manifest);
  return {
    projectId,
    figure,
    segment: findFamily(figure.manifest, 'segment'),
    curve: findFamily(figure.manifest, 'curve'),
  };
}

async function createStandalone(token) {
  const rendered = await jsonRequest('/api/figure/render', token, {
    method: 'POST',
    body: JSON.stringify({ script: rScript, language: 'r', dataPayload: null, editLog: [], renderOptions: { dpi: 150 } }),
  });
  assert(rendered.response.ok && rendered.data?.status === 'success' && rendered.data?.sessionId, `standalone render failed: ${JSON.stringify(rendered.data)}`);
  assertNoArrowChild(rendered.data.manifest);
  return {
    sessionId: rendered.data.sessionId,
    revision: Number(rendered.data.revision || 1),
    segment: findFamily(rendered.data.manifest, 'segment'),
    curve: findFamily(rendered.data.manifest, 'curve'),
  };
}

async function createMappedStandalone(token) {
  const rendered = await jsonRequest('/api/figure/render', token, {
    method: 'POST',
    body: JSON.stringify({ script: mappedRScript, language: 'r', dataPayload: null, editLog: [], renderOptions: { dpi: 150 } }),
  });
  assert(rendered.response.ok && rendered.data?.status === 'success' && rendered.data?.sessionId, `mapped standalone render failed: ${JSON.stringify(rendered.data)}`);
  const segment = findFamily(rendered.data.manifest, 'segment', false);
  const curve = findFamily(rendered.data.manifest, 'curve', false);
  assert(segment.currentProps?.colorMapped && segment.currentProps?.linewidthMapped && segment.currentProps?.linetypeMapped, `mapped segment flags are incomplete: ${JSON.stringify(segment)}`);
  assert(!segment.editable?.includes('color') && !segment.editable?.includes('linewidth') && !segment.editable?.includes('linestyle'), `mapped segment exposes scale-owned styles: ${JSON.stringify(segment)}`);
  assert(curve.currentProps?.alphaMapped && !curve.editable?.includes('alpha'), `mapped curve exposes scale-owned alpha: ${JSON.stringify(curve)}`);
  return {
    sessionId: rendered.data.sessionId,
    revision: Number(rendered.data.revision || 1),
    segment,
    curve,
  };
}

async function submitProjectPatch(token, projectId, patches, baseRevision) {
  return jsonRequest('/api/figure/patch', token, {
    method: 'POST',
    body: JSON.stringify({
      requestId: `r-segment-curve-project-${Date.now()}-${Math.random().toString(36).slice(2)}`,
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
      requestId: `r-segment-curve-standalone-${Date.now()}-${Math.random().toString(36).slice(2)}`,
      sessionId,
      baseRevision,
      patches,
    }),
  });
}

function assertAccepted(label, result, patches, baseRevision) {
  assert(result.response.ok && result.data?.status === 'success', `${label} failed: ${JSON.stringify(result.data)}`);
  assert(Number(result.data?.revision) === baseRevision + 1, `${label} revision drifted: ${JSON.stringify(result.data)}`);
  for (const patch of patches) {
    const applied = result.data?.applied?.find((entry) => samePatch(entry, patch));
    assert(applied, `${label} did not acknowledge ${JSON.stringify(patch)}: ${JSON.stringify(result.data)}`);
    assert(applied.mode === 'backend_patch', `${label} trusted client mode: ${JSON.stringify(applied)}`);
  }
}

function assertHasPatch(label, editLog, patch) {
  const entry = editLog?.find((candidate) => samePatch(candidate, patch));
  assert(entry, `${label} is missing ${JSON.stringify(patch)}: ${JSON.stringify(editLog)}`);
  assert(entry.mode === 'backend_patch', `${label} persisted a non-authoritative mode: ${JSON.stringify(entry)}`);
}

function manifestObject(manifest, id) {
  return manifest?.objects?.find((object) => object?.id === id);
}

function assertManifestValue(label, manifest, patch) {
  const actual = manifestObject(manifest, patch.gid)?.currentProps?.[patch.prop];
  if (typeof patch.value === 'string') {
    assert(String(actual).toLowerCase() === patch.value.toLowerCase(), `${label} has ${actual} instead of ${patch.value}`);
  } else {
    assert(Number(actual) === Number(patch.value), `${label} has ${actual} instead of ${patch.value}`);
  }
}

async function assertRejectedWithoutPersistence(label, before, submit, rejectedPatches, expectedRevision, projectId, standaloneSessionId) {
  const result = await submit();
  assert(result.response.ok && result.data?.status === 'conflict', `${label} did not conflict: ${JSON.stringify(result.data)}`);
  assert(Number(result.data?.revision) === expectedRevision, `${label} changed response revision: ${JSON.stringify(result.data)}`);
  assert(Array.isArray(result.data?.applied) && result.data.applied.length === 0, `${label} applied a partial batch: ${JSON.stringify(result.data)}`);
  for (const patch of rejectedPatches) {
    assert(result.data?.rejected?.some((entry) => samePatch(entry, patch)), `${label} did not identify ${JSON.stringify(patch)}: ${JSON.stringify(result.data)}`);
  }
  assertSame(label, before, readDatabaseState(projectId, standaloneSessionId));
}

async function main() {
  assertIsolatedEnvironment();
  const token = await register();
  let projectId = null;
  try {
    const project = await createProject(token);
    projectId = project.projectId;
    const standalone = await createStandalone(token);
    const mappedStandalone = await createMappedStandalone(token);
    let projectRevision = Number(project.figure.revision || 1);
    let standaloneRevision = standalone.revision;

    const projectStructure = {
      segment: structuralSnapshot(project.segment),
      curve: structuralSnapshot(project.curve),
    };
    const projectPatches = [
      backendPatch(project.segment, 'color', '#D62728'),
      backendPatch(project.curve, 'linewidth', 2.2, 'local_patch'),
    ];
    const projectAccepted = await submitProjectPatch(token, projectId, projectPatches, projectRevision);
    assertAccepted('project segment/curve patch', projectAccepted, projectPatches, projectRevision);
    projectRevision += 1;

    const projectState = readDatabaseState(projectId, standalone.sessionId);
    assert(Number(projectState.figure?.revision) === projectRevision, 'project Figure revision did not persist');
    assert(Number(projectState.sessions[`${projectId}_fig_1`]?.revision) === projectRevision, 'project session revision did not persist');
    for (const patch of projectPatches) {
      assertHasPatch('project Figure edit log', projectState.figure?.editLog, patch);
      assertHasPatch('project session edit log', projectState.sessions[`${projectId}_fig_1`]?.editLog, patch);
      assertManifestValue('project manifest', projectState.figure?.manifest, patch);
    }
    assertSame('project segment structure', projectStructure.segment, structuralSnapshot(manifestObject(projectState.figure?.manifest, project.segment.id)));
    assertSame('project curve structure', projectStructure.curve, structuralSnapshot(manifestObject(projectState.figure?.manifest, project.curve.id)));

    const standalonePatch = backendPatch(standalone.curve, 'linestyle', 'dotted', 'local_patch');
    const standaloneAccepted = await submitStandalonePatch(token, standalone.sessionId, [standalonePatch], standaloneRevision);
    assertAccepted('standalone curve patch', standaloneAccepted, [standalonePatch], standaloneRevision);
    standaloneRevision += 1;
    const standaloneState = readDatabaseState(projectId, standalone.sessionId);
    assert(Number(standaloneState.sessions[standalone.sessionId]?.revision) === standaloneRevision, 'standalone revision did not persist');
    assertHasPatch('standalone edit log', standaloneState.sessions[standalone.sessionId]?.editLog, standalonePatch);

    const mappedPatches = [
      backendPatch(mappedStandalone.segment, 'color', '#AA00AA', 'local_patch'),
      backendPatch(mappedStandalone.curve, 'alpha', 0.1),
    ];
    const mappedBefore = readDatabaseState(projectId, mappedStandalone.sessionId);
    const mappedRejected = await submitStandalonePatch(
      token,
      mappedStandalone.sessionId,
      mappedPatches,
      mappedStandalone.revision,
    );
    assert(mappedRejected.response.ok && mappedRejected.data?.status === 'conflict', `mapped style override did not conflict: ${JSON.stringify(mappedRejected.data)}`);
    assert(Number(mappedRejected.data?.revision) === mappedStandalone.revision, `mapped style rejection changed revision: ${JSON.stringify(mappedRejected.data)}`);
    assert(Array.isArray(mappedRejected.data?.applied) && mappedRejected.data.applied.length === 0, `mapped style rejection partially applied: ${JSON.stringify(mappedRejected.data)}`);
    for (const patch of mappedPatches) {
      assert(mappedRejected.data?.rejected?.some((entry) => samePatch(entry, patch)), `mapped style rejection did not identify ${JSON.stringify(patch)}: ${JSON.stringify(mappedRejected.data)}`);
    }
    assertSame(
      'mapped standalone rejection',
      mappedBefore,
      readDatabaseState(projectId, mappedStandalone.sessionId),
    );

    const structuralPatch = backendPatch(project.segment, 'xend', [9, 10]);
    const beforeStructural = readDatabaseState(projectId, standalone.sessionId);
    await assertRejectedWithoutPersistence(
      'segment endpoint rejection',
      beforeStructural,
      () => submitProjectPatch(token, projectId, [structuralPatch], projectRevision),
      [structuralPatch],
      projectRevision,
      projectId,
      standalone.sessionId,
    );

    const mixedValidPatch = backendPatch(project.segment, 'alpha', 0.35, 'local_patch');
    const mixedStructuralPatch = backendPatch(project.curve, 'arrow', { ends: 'last' });
    const beforeMixed = readDatabaseState(projectId, standalone.sessionId);
    await assertRejectedWithoutPersistence(
      'mixed segment/curve atomic rejection',
      beforeMixed,
      () => submitProjectPatch(token, projectId, [mixedValidPatch, mixedStructuralPatch], projectRevision),
      [mixedValidPatch, mixedStructuralPatch],
      projectRevision,
      projectId,
      standalone.sessionId,
    );

    const exported = await jsonRequest(`/api/projects/${projectId}/export`, token, {
      method: 'POST',
      body: JSON.stringify({ figureId: 'fig_1', format: 'svg', dpi: 150, saveToLibrary: true, name: `r-segment-curve-${Date.now()}` }),
    });
    assert(exported.response.ok && exported.data?.status === 'success', `project export failed: ${JSON.stringify(exported.data)}`);
    const exportedFigure = exported.data?.figures?.[0];
    const asset = exportedFigure?.asset;
    assert(String(exportedFigure?.svg || '').includes('<svg'), 'project export returned no SVG');
    assert(asset?.assetId && asset.hasEditingSnapshot === true, `project export returned no editing snapshot: ${JSON.stringify(exported.data)}`);
    const exportState = readDatabaseState(projectId, standalone.sessionId);
    const snapshot = exportState.exportSnapshots.find((row) => row.asset_id === asset.assetId);
    const snapshotFigure = snapshot?.snapshotJson?.figures?.find((figure) => figure.figureId === 'fig_1');
    assert(snapshotFigure, `export snapshot is missing fig_1: ${JSON.stringify(snapshot)}`);
    for (const patch of projectPatches) assertHasPatch('export snapshot edit log', snapshotFigure.editLog, patch);
    const immutableSnapshot = clone(snapshot);

    const laterPatch = backendPatch(project.segment, 'color', '#6A3D9A');
    const laterAccepted = await submitProjectPatch(token, projectId, [laterPatch], projectRevision);
    assertAccepted('later segment patch', laterAccepted, [laterPatch], projectRevision);
    projectRevision += 1;
    const laterState = readDatabaseState(projectId, standalone.sessionId);
    assertHasPatch('later active Figure edit log', laterState.figure?.editLog, laterPatch);

    const restored = await jsonRequest(`/api/projects/${projectId}/export-assets/${asset.assetId}/restore`, token, { method: 'POST' });
    assert(restored.response.ok && restored.data?.status === 'success', `snapshot restore failed: ${JSON.stringify(restored.data)}`);
    assert(restored.data?.targetFigureId === 'fig_1', `snapshot restore targeted the wrong Figure: ${JSON.stringify(restored.data)}`);
    const restoredState = readDatabaseState(projectId, standalone.sessionId);
    for (const patch of projectPatches) {
      assertHasPatch('restored Figure edit log', restoredState.figure?.editLog, patch);
      assertHasPatch('restored session edit log', restoredState.sessions[`${projectId}_fig_1`]?.editLog, patch);
    }
    assert(!restoredState.figure?.editLog?.some((entry) => samePatch(entry, laterPatch)), 'restore retained the post-export patch');
    assert(
      restoredState.figure?.previewSvg === null
        && restoredState.figure?.manifest === null
        && restoredState.figure?.codeSlice === null
        && restoredState.figure?.fingerprint === null
        && restoredState.figure?.previewUpdatedAt === null,
      'restore retained stale rendered state',
    );
    assertSame('immutable export snapshot', immutableSnapshot, restoredState.exportSnapshots.find((row) => row.asset_id === asset.assetId));

    const refreshed = await jsonRequest(`/api/projects/${projectId}/figures?includePreview=1`, token);
    assert(refreshed.response.ok && refreshed.data?.status === 'success', `post-restore refresh failed: ${JSON.stringify(refreshed.data)}`);
    const refreshedFigure = refreshed.data?.figures?.find((figure) => figure.figureId === 'fig_1');
    assert(refreshedFigure?.previewSource === 'rendered', `post-restore refresh did not replay renderer state: ${JSON.stringify(refreshedFigure)}`);
    for (const patch of projectPatches) {
      assertHasPatch('refreshed edit log', refreshedFigure?.editLog, patch);
      assertManifestValue('refreshed manifest', refreshedFigure?.manifest, patch);
    }
    assertNoArrowChild(refreshedFigure?.manifest);

    console.log(JSON.stringify({
      status: 'PASS',
      projectId,
      standaloneSessionId: standalone.sessionId,
      exportAssetId: asset.assetId,
      checked: [
        'segment and curve preserve legacy line identities with readonly endpoint, curve, and arrow metadata',
        'project and standalone visual patches are server-authoritative backend patches',
        'endpoint and arrow structure patches conflict atomically without persistence',
        'mapped segment/curve styles remain scale-owned and reject layer overrides without persistence',
        'style replay preserves endpoint, curvature, and arrow direction metadata',
        'export snapshot and restore preserve export-time segment/curve edits',
        'no arrow child or text relation is inferred without a structured source',
      ],
    }, null, 2));
  } finally {
    if (projectId) await jsonRequest(`/api/projects/${projectId}`, token, { method: 'DELETE' }).catch(() => null);
  }
}

main().catch((error) => {
  console.error(JSON.stringify({ status: 'FAIL', message: error.message, stack: error.stack }, null, 2));
  process.exitCode = 1;
});
