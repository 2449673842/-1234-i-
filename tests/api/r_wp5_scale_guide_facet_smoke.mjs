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
      email: `r-wp5-scale-guide-facet-${Date.now()}-${Math.random().toString(36).slice(2)}@example.test`,
      password: 'R-WP5-Scale-Guide-Facet-2026',
    }),
  });
  assert(result.response.ok && result.data?.token, `registration failed: ${JSON.stringify(result.data)}`);
  return result.data.token;
}

const facetScript = [
  '# language: r',
  'library(ggplot2)',
  'df <- data.frame(',
  '  x=c(1, 2, 10, 20),',
  '  y=c(1, 2, 100, 200),',
  '  facet=rep(c("F1", "F2"), each=2)',
  ')',
  'p <- ggplot(df, aes(x, y)) +',
  '  geom_point(size=4) +',
  '  facet_wrap(~facet, scales="free", strip.position="bottom") +',
  '  theme_classic() +',
  '  theme(panel.spacing.x=grid::unit(7, "pt"), panel.spacing.y=grid::unit(9, "pt"))',
  'p',
].join('\n');

const colorFirstScript = [
  '# language: r',
  'library(ggplot2)',
  'df <- data.frame(',
  '  x=c("A", "B"), y=c(1, 2),',
  '  group=c("A", "B"), condition=c("A", "B")',
  ')',
  'p <- ggplot(df, aes(x, y, color=group, fill=condition)) +',
  '  geom_point(shape=21, size=4) +',
  '  scale_color_manual(values=c(A="#1F78B4", B="#D62728"), name="Group") +',
  '  scale_fill_manual(values=c(A="#A6CEE3", B="#FB9A99"), name="Condition") +',
  '  theme_classic()',
  'p',
].join('\n');

const fillFirstScript = colorFirstScript.replace(
  'scale_color_manual(values=c(A="#1F78B4", B="#D62728"), name="Group") +\n  scale_fill_manual(values=c(A="#A6CEE3", B="#FB9A99"), name="Condition")',
  'scale_fill_manual(values=c(A="#A6CEE3", B="#FB9A99"), name="Condition") +\n  scale_color_manual(values=c(A="#1F78B4", B="#D62728"), name="Group")',
);

const continuousDualScript = [
  '# language: r',
  'library(ggplot2)',
  'df <- data.frame(',
  '  x=1:8,',
  '  y=c(2, 4, 3, 6, 5, 7, 6, 8),',
  '  color_value=seq(0, 1, length.out=8),',
  '  fill_value=seq(1, 0, length.out=8)',
  ')',
  'p <- ggplot(df, aes(x, y, colour=color_value, fill=fill_value)) +',
  '  geom_point(shape=21, size=5, stroke=1.2) +',
  '  scale_colour_gradient(low="#132B43", high="#56B1F7", limits=c(0, 1), name="Color value") +',
  '  scale_fill_gradient(low="#FDE725", high="#440154", limits=c(0, 1), name="Fill value") +',
  '  theme_classic()',
  'p',
].join('\n');

function objects(manifest) {
  return Array.isArray(manifest?.objects) ? manifest.objects : [];
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
  return left?.gid === right?.gid
    && left?.prop === right?.prop
    && JSON.stringify(left?.value) === JSON.stringify(right?.value);
}

function findObject(manifest, predicate, label) {
  const object = objects(manifest).find(predicate);
  assert(object?.id, `${label} was not exposed in the R manifest: ${JSON.stringify(manifest)}`);
  return object;
}

function findCapability(object, prop) {
  return Array.isArray(object?.propertyCapabilities)
    ? object.propertyCapabilities.find((capability) => capability?.prop === prop)
    : null;
}

function assertPatchable(object, prop, label) {
  const capability = findCapability(object, prop);
  assert(
    capability && capability.replay !== 'unsupported' && Array.isArray(capability.scopes) && capability.scopes.includes('object'),
    `${label}.${prop} is not object-replayable: ${JSON.stringify(object)}`,
  );
}

function readDatabaseState(projectId) {
  const database = new Database(process.env.SCIFIGURE_DB_PATH, { readonly: true });
  try {
    database.pragma('busy_timeout = 5000');
    const project = database.prepare('SELECT id, spec, script, updated_at FROM projects WHERE id = ?').get(projectId);
    const session = database.prepare('SELECT id, script, edit_log, revision, updated_at FROM sessions WHERE id = ?').get(`${projectId}_fig_1`);
    const figure = database.prepare(`
      SELECT session_id, revision, edit_log, history, preview_svg, manifest, code_slice, fingerprint, preview_updated_at
      FROM project_figures
      WHERE project_id = ? AND figure_index = 0
    `).get(projectId);
    const exportAssets = database.prepare(`
      SELECT id, figure_id, name, format, dpi, metadata, tags, created_at
      FROM export_assets
      WHERE project_id = ?
      ORDER BY id
    `).all(projectId);
    const exportSnapshots = database.prepare(`
      SELECT asset_id, figure_id, schema_version, snapshot_hash, snapshot_json, created_at
      FROM export_asset_snapshots
      WHERE project_id = ?
      ORDER BY asset_id
    `).all(projectId);
    return {
      project: project ? { ...project, spec: parseJson(project.spec, null) } : null,
      session: session ? {
        id: session.id,
        script: session.script,
        editLog: parseJson(session.edit_log, []),
        revision: Number(session.revision),
        updatedAt: session.updated_at,
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
  const rendered = await renderProject(token, projectId, script, {}, `${label}-initial`);
  const figure = rendered.data?.figures?.find((item) => item.figureId === 'fig_1');
  assert(figure?.manifest?.objects?.length > 0, `${label} initial render did not return a fig_1 manifest`);
  const persisted = readDatabaseState(projectId).figure;
  assert(persisted?.manifest?.objects?.length > 0, `${label} initial render did not persist a fig_1 manifest`);
  return { projectId, figure: persisted };
}

async function renderProject(token, projectId, script, editLogs, label) {
  const rendered = await jsonRequest(`/api/projects/${projectId}/figures/render`, token, {
    method: 'POST',
    body: JSON.stringify({
      script,
      editLogs,
      language: 'r',
      requestId: `${label}-${Date.now()}-${Math.random().toString(36).slice(2)}`,
    }),
  });
  assert(rendered.response.ok && rendered.data?.status === 'success', `${label} render failed: ${JSON.stringify(rendered.data)}`);
  return rendered;
}

async function submitProjectPatch(token, projectId, patches, baseRevision, label) {
  return jsonRequest('/api/figure/patch', token, {
    method: 'POST',
    body: JSON.stringify({
      requestId: `${label}-${Date.now()}-${Math.random().toString(36).slice(2)}`,
      sessionId: `${projectId}_fig_1`,
      projectId,
      figureId: 'fig_1',
      baseRevision,
      patches,
    }),
  });
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

function assertAcceptedPatches(label, result, expectedPatches, expectedRevision) {
  assert(result.response.ok && result.data?.status === 'success', `${label} did not succeed: ${JSON.stringify(result.data)}`);
  assert(Number(result.data?.revision) === expectedRevision + 1, `${label} did not increment revision once: ${JSON.stringify(result.data)}`);
  for (const patch of expectedPatches) {
    const applied = result.data?.applied?.find((entry) => isSamePatch(entry, patch));
    assert(applied, `${label} did not report applied patch ${JSON.stringify(patch)}: ${JSON.stringify(result.data)}`);
    assert(applied.mode === 'backend_patch', `${label} did not enforce backend authority: ${JSON.stringify(applied)}`);
  }
}

async function assertNoPersistence(projectId, label, patchBody, rejectedPatches, expectedRevision) {
  const before = readDatabaseState(projectId);
  const result = await patchBody();
  assertConflictResponse(label, result, rejectedPatches, expectedRevision);
  const after = readDatabaseState(projectId);
  assertSameState(label, before, after);
}

async function exportProjectSnapshot(token, projectId, label) {
  const result = await jsonRequest(`/api/projects/${projectId}/export`, token, {
    method: 'POST',
    body: JSON.stringify({
      figureId: 'fig_1',
      format: 'svg',
      dpi: 150,
      saveToLibrary: true,
      name: `${label}-${Date.now()}`,
    }),
  });
  assert(result.response.ok && result.data?.status === 'success', `${label} export failed: ${JSON.stringify(result.data)}`);
  const exportedFigure = result.data?.figures?.[0];
  const asset = exportedFigure?.asset;
  assert(asset?.assetId && asset.hasEditingSnapshot === true, `${label} export did not create a restorable snapshot: ${JSON.stringify(result.data)}`);
  assert(String(exportedFigure?.svg || '').includes('<svg'), `${label} export did not return SVG`);
  return { asset, exportedFigure };
}

function assertEditLogHasPatch(label, editLog, expectedPatch) {
  const matched = Array.isArray(editLog)
    ? editLog.find((entry) => isSamePatch(entry, expectedPatch))
    : null;
  assert(matched, `${label} is missing ${JSON.stringify(expectedPatch)}: ${JSON.stringify(editLog)}`);
  assert(matched.mode === 'backend_patch', `${label} persisted non-backend mode: ${JSON.stringify(matched)}`);
  return matched;
}

function findLegendTextByDataKey(manifest, dataKey) {
  return findObject(
    manifest,
    (object) => object?.role === 'legend_text' && object?.identity?.relation?.dataKey === dataKey,
    `legend text ${dataKey}`,
  );
}

async function main() {
  assertIsolatedEnvironment();
  const token = await register();
  const facetProject = await createProject(token, facetScript, 'R WP5 facet physical bounds');
  const facetProjectId = facetProject.projectId;
  const facetRevision = Number(facetProject.figure.revision || 1);

  const facetLayout = findObject(
    facetProject.figure.manifest,
    (object) => object?.id === 'r.facet.layout.0' || object?.role === 'ggplot_facet_layout',
    'facet layout',
  );
  assert(facetLayout.currentProps?.physicalPanelBounds === 'readonly', `facet physical bounds must be readonly: ${JSON.stringify(facetLayout)}`);
  assert(!findCapability(facetLayout, 'physicalPanelBounds'), `facet physical bounds must not expose a patch capability: ${JSON.stringify(facetLayout)}`);
  const facetBoundsPatch = makePatch(facetLayout, 'physicalPanelBounds', { left: 0.1, bottom: 0.1, width: 0.8, height: 0.8 });
  await assertNoPersistence(
    facetProjectId,
    'facet physical bounds rejection',
    () => submitProjectPatch(token, facetProjectId, [facetBoundsPatch], facetRevision, 'facet-bounds-reject'),
    [facetBoundsPatch],
    facetRevision,
  );

  const { projectId, figure } = await createProject(token, colorFirstScript, 'R WP5 scale guide reorder');
  let revision = Number(figure.revision || 1);

  const colorLegendA = findLegendTextByDataKey(figure.manifest, 'legend:color:A');
  assertPatchable(colorLegendA, 'text', 'color legend A text');
  const exportTimePatch = makePatch(colorLegendA, 'text', 'Group A export');
  const firstPatch = await submitProjectPatch(token, projectId, [exportTimePatch], revision, 'legend-text-export-time');
  assertAcceptedPatches('legend text export-time patch', firstPatch, [exportTimePatch], revision);
  revision += 1;
  let state = readDatabaseState(projectId);
  assertEditLogHasPatch('legend export-time session edit log', state.session?.editLog, exportTimePatch);
  assertEditLogHasPatch('legend export-time Figure edit log', state.figure?.editLog, exportTimePatch);

  const reorderedRender = await renderProject(token, projectId, fillFirstScript, undefined, 'guide-reordered-render');
  const reorderedFigure = readDatabaseState(projectId).figure;
  assert(reorderedFigure?.manifest?.objects?.length > 0, `guide-reordered render persisted no manifest: ${JSON.stringify(reorderedRender.data)}`);
  const remappedColorA = findLegendTextByDataKey(reorderedFigure.manifest, 'legend:color:A');
  const ordinalFillA = findLegendTextByDataKey(reorderedFigure.manifest, 'legend:fill:A');
  const semanticColorGuide = findObject(
    reorderedFigure.manifest,
    (object) => object?.role === 'ggplot_semantic_guide'
      && object?.identity?.relation?.scaleIds?.includes('r.scale.color.0'),
    'semantic color guide',
  );
  assert(remappedColorA.id !== ordinalFillA.id, `guide reorder did not keep color/fill legend identities separate: ${JSON.stringify(reorderedFigure.manifest)}`);
  assert(remappedColorA.currentProps?.text === 'Group A export', `legend text patch did not follow color guide identity after reorder: ${JSON.stringify(remappedColorA)}`);
  assert(ordinalFillA.currentProps?.text === 'A', `legend text patch leaked to fill guide ordinal after reorder: ${JSON.stringify(ordinalFillA)}`);
  assert(reorderedRender.data?.applied?.some((entry) => entry.gid === colorLegendA.id && entry.resolvedGid === remappedColorA.id), `guide reorder did not report legend text remap: ${JSON.stringify(reorderedRender.data?.applied)}`);

  const exported = await exportProjectSnapshot(token, projectId, 'r-wp5-guide-reorder');
  const exportedSvg = String(exported.exportedFigure.svg || '');
  const exportedSvgLower = exportedSvg.toLowerCase();
  for (const expectedText of ['Condition', 'Group A export']) {
    assert(exportedSvg.includes(expectedText), `exported SVG lost guide text ${expectedText}: ${exportedSvg.slice(0, 1200)}`);
  }
  for (const expectedColor of ['#A6CEE3', '#FB9A99', '#1F78B4', '#D62728']) {
    assert(exportedSvgLower.includes(expectedColor.toLowerCase()), `exported SVG lost guide color ${expectedColor}`);
  }
  assert(
    exportedSvg.indexOf('Condition') < exportedSvg.indexOf('Group A export'),
    'exported SVG did not preserve fill-first guide order after script reorder',
  );
  state = readDatabaseState(projectId);
  const immutableSnapshot = state.exportSnapshots.find((row) => row.asset_id === exported.asset.assetId);
  assert(immutableSnapshot?.snapshotJson, `export snapshot was not persisted: ${JSON.stringify(state.exportSnapshots)}`);
  const snapshotFigure = immutableSnapshot.snapshotJson?.figures?.find((item) => item.figureId === 'fig_1');
  assertEditLogHasPatch('guide reorder export snapshot edit log', snapshotFigure?.editLog, exportTimePatch);
  assert(snapshotFigure?.script === fillFirstScript, 'guide reorder export snapshot did not capture the reordered script');

  assertPatchable(semanticColorGuide, 'visible', 'semantic color guide');
  const hideGuidePatch = makePatch(semanticColorGuide, 'visible', false);
  const hideGuideResult = await submitProjectPatch(token, projectId, [hideGuidePatch], revision, 'semantic-guide-hide');
  assertAcceptedPatches('semantic guide hide', hideGuideResult, [hideGuidePatch], revision);
  revision += 1;
  state = readDatabaseState(projectId);
  const hiddenGuide = findObject(state.figure?.manifest, (object) => object?.id === semanticColorGuide.id, 'hidden semantic color guide');
  assert(hiddenGuide.currentProps?.visible === false, `semantic guide did not become hidden: ${JSON.stringify(hiddenGuide)}`);
  const hiddenSvg = String(state.figure?.previewSvg || '');
  const hiddenTextIndex = hiddenSvg.indexOf('Group A export');
  assert(
    hiddenTextIndex < 0,
    `hidden color guide text remained in preview SVG: ${hiddenSvg.slice(Math.max(0, hiddenTextIndex - 260), hiddenTextIndex + 320)}`,
  );

  const showGuidePatch = makePatch(hiddenGuide, 'visible', true);
  const showGuideResult = await submitProjectPatch(token, projectId, [showGuidePatch], revision, 'semantic-guide-show');
  assertAcceptedPatches('semantic guide show', showGuideResult, [showGuidePatch], revision);
  revision += 1;
  state = readDatabaseState(projectId);
  const shownGuide = findObject(state.figure?.manifest, (object) => object?.id === semanticColorGuide.id, 'shown semantic color guide');
  assert(shownGuide.currentProps?.visible === true, `semantic guide did not become visible again: ${JSON.stringify(shownGuide)}`);
  assert(String(state.figure?.previewSvg || '').includes('Group A export'), 'restored color guide text is missing from preview SVG');

  const laterPatch = makePatch(remappedColorA, 'color', '#2CA02C');
  assertPatchable(remappedColorA, 'color', 'post-export color legend A text');
  const laterResult = await submitProjectPatch(token, projectId, [laterPatch], revision, 'legend-text-post-export');
  assertAcceptedPatches('legend text post-export patch', laterResult, [laterPatch], revision);
  revision += 1;

  const restored = await jsonRequest(`/api/projects/${projectId}/export-assets/${exported.asset.assetId}/restore`, token, {
    method: 'POST',
    body: JSON.stringify({}),
  });
  assert(restored.response.ok && restored.data?.status === 'success', `guide reorder snapshot restore failed: ${JSON.stringify(restored.data)}`);
  const restoredState = readDatabaseState(projectId);
  assert(Number(restoredState.figure?.revision) > revision, `restore did not advance revision: ${JSON.stringify(restoredState.figure)}`);
  assert(restoredState.session?.script === fillFirstScript, 'restore did not restore the export-time reordered script');
  assertEditLogHasPatch('restored Figure edit log', restoredState.figure?.editLog, exportTimePatch);
  assertEditLogHasPatch('restored session edit log', restoredState.session?.editLog, exportTimePatch);
  assert(
    !restoredState.figure?.editLog?.some((entry) => isSamePatch(entry, laterPatch))
      && !restoredState.session?.editLog?.some((entry) => isSamePatch(entry, laterPatch))
      && !restoredState.figure?.editLog?.some((entry) => isSamePatch(entry, hideGuidePatch) || isSamePatch(entry, showGuidePatch))
      && !restoredState.session?.editLog?.some((entry) => isSamePatch(entry, hideGuidePatch) || isSamePatch(entry, showGuidePatch)),
    `restore retained the later post-export legend text edit: ${JSON.stringify(restoredState)}`,
  );
  assert(
    restoredState.figure?.previewSvg === null
      && restoredState.figure?.manifest === null
      && restoredState.figure?.codeSlice === null
      && restoredState.figure?.fingerprint === null
      && restoredState.figure?.previewUpdatedAt === null,
    'restore retained stale preview/manifest state instead of invalidating it',
  );
  const restoredSnapshot = restoredState.exportSnapshots.find((row) => row.asset_id === exported.asset.assetId);
  assertSameState('immutable guide reorder export snapshot', immutableSnapshot, restoredSnapshot);

  const continuousProject = await createProject(token, continuousDualScript, 'R WP5 dual continuous scale');
  const continuousManifest = continuousProject.figure.manifest;
  const colorContinuous = objects(continuousManifest).find((object) => (
    object?.identity?.relation?.scaleId === 'r.scale.color.continuous.0'
    && Array.isArray(object.propertyCapabilities)
    && findCapability(object, 'vmin')
    && findCapability(object, 'vmax')
  ));
  const fillContinuous = objects(continuousManifest).find((object) => (
    object?.identity?.relation?.scaleId === 'r.scale.fill.continuous.0'
    && Array.isArray(object.propertyCapabilities)
    && findCapability(object, 'vmin')
    && findCapability(object, 'vmax')
  ));
  assert(colorContinuous, 'dual continuous color scale must expose an object-replayable target');
  assert(fillContinuous, 'dual continuous fill scale must expose an object-replayable target');
  const colorPatch = makePatch(colorContinuous, 'vmin', 0.2);
  const fillPatch = makePatch(fillContinuous, 'vmax', 0.8);
  const dualResult = await submitProjectPatch(
    token,
    continuousProject.projectId,
    [colorPatch, fillPatch],
    Number(continuousProject.figure.revision || 1),
    'dual-continuous-color-fill',
  );
  assertAcceptedPatches(
    'dual continuous color/fill isolation',
    dualResult,
    [colorPatch, fillPatch],
    Number(continuousProject.figure.revision || 1),
  );
  const dualState = readDatabaseState(continuousProject.projectId);
  assertEditLogHasPatch('dual continuous session edit log', dualState.session?.editLog, colorPatch);
  assertEditLogHasPatch('dual continuous session edit log', dualState.session?.editLog, fillPatch);
  const patchedColor = objects(dualState.figure?.manifest).find((object) => object?.id === colorContinuous.id);
  const patchedFill = objects(dualState.figure?.manifest).find((object) => object?.id === fillContinuous.id);
  assert(patchedColor?.identity?.relation?.scaleId === 'r.scale.color.continuous.0', `color continuous scale identity changed: ${JSON.stringify(patchedColor)}`);
  assert(patchedFill?.identity?.relation?.scaleId === 'r.scale.fill.continuous.0', `fill continuous scale identity changed: ${JSON.stringify(patchedFill)}`);
  assert(Number(patchedColor?.currentProps?.vmin) === 0.2, `color continuous vmin was not isolated: ${JSON.stringify(patchedColor)}`);
  assert(Number(patchedFill?.currentProps?.vmax) === 0.8, `fill continuous vmax was not isolated: ${JSON.stringify(patchedFill)}`);

  console.log('PASS facet physical bounds rejection leaves zero persisted state changes');
  console.log('PASS guide reorder, export SVG, visibility, and snapshot restore preserve guide semantics');
  console.log('PASS dual continuous color/fill isolation');
}

main().catch((error) => {
  console.error('FAIL r_wp5_scale_guide_facet_smoke');
  console.error(error?.stack || error);
  process.exit(1);
});
