import Database from 'better-sqlite3';
import path from 'node:path';
import { projectFigureSaveBase } from '../helpers/project_save_hash.mjs';

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

function stable(value) {
  return JSON.stringify(value, Object.keys(value || {}).sort());
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
      email: `r-patch-authority-${Date.now()}-${Math.random().toString(36).slice(2)}@example.test`,
      password: 'R-Patch-Authority-Persistence-2026',
    }),
  });
  assert(result.response.ok && result.data?.token, `registration failed: ${JSON.stringify(result.data)}`);
  return result.data.token;
}

const rScript = [
  'library(ggplot2)',
  'df <- data.frame(x = 1:5, y = c(1, 3, 2, 5, 4), group = c("A", "A", "B", "B", "B"))',
  'p <- ggplot(df, aes(x = x, y = y, color = group)) +',
  '  geom_line(linewidth = 0.9) +',
  '  geom_point(size = 2.8) +',
  '  labs(title = "R Patch Authority", x = "Original X", y = "Original Y") +',
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

function findPatchTarget(manifest) {
  const objects = Array.isArray(manifest?.objects) ? manifest.objects : [];
  const byCapability = objects.find((object) => (
    Array.isArray(object.propertyCapabilities)
      && object.propertyCapabilities.some((capability) => capability?.prop === 'linewidth' && capability?.replay !== 'unsupported')
  ));
  const byEditable = objects.find((object) => Array.isArray(object.editable) && object.editable.includes('linewidth'));
  const fallback = objects.find((object) => Array.isArray(object.editable) && object.editable.length > 0);
  const object = byCapability || byEditable || fallback;
  assert(object?.id, `R render did not expose an editable patch target: ${JSON.stringify(manifest)}`);
  const capability = Array.isArray(object.propertyCapabilities)
    ? object.propertyCapabilities.find((item) => item?.prop === 'linewidth')
    : null;
  const prop = capability?.prop || (Array.isArray(object.editable) && object.editable.includes('linewidth') ? 'linewidth' : object.editable?.[0]);
  assert(prop, `R target did not expose an editable prop: ${JSON.stringify(object)}`);
  return { object, prop };
}

function findSecondaryPatchTarget(manifest, primary) {
  const preferredProps = ['fontsize', 'alpha', 'color', 'facecolor', 'edgecolor'];
  for (const prop of preferredProps) {
    const object = (manifest?.objects || []).find((candidate) => (
      candidate?.id !== primary.object.id
      && Array.isArray(candidate.propertyCapabilities)
      && candidate.propertyCapabilities.some((capability) => capability?.prop === prop && capability?.replay !== 'unsupported')
    ));
    if (object) return { object, prop };
  }
  throw new Error('R render did not expose a second editable target for a legal mixed batch');
}

function patchValue(prop, numberValue, colorValue) {
  if (String(prop).toLowerCase().includes('color')) return colorValue;
  if (prop === 'visible') return false;
  return numberValue;
}

function readDatabaseState(projectId, standaloneSessionId, exportAssetId) {
  const database = new Database(process.env.SCIFIGURE_DB_PATH, { readonly: true });
  try {
    database.pragma('busy_timeout = 5000');
    const projectSessionId = projectId ? `${projectId}_fig_1` : null;
    const sessionIds = [projectSessionId, standaloneSessionId].filter(Boolean);
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
    const exportAsset = exportAssetId
      ? database.prepare('SELECT id, metadata FROM export_assets WHERE id = ?').get(exportAssetId)
      : null;
    const exportSnapshot = exportAssetId
      ? database.prepare('SELECT asset_id, schema_version, snapshot_hash, snapshot_json FROM export_asset_snapshots WHERE asset_id = ?').get(exportAssetId)
      : null;
    const exportAssets = projectId
      ? database.prepare(`
          SELECT id, figure_id, name, format, dpi, file_path, metadata, tags, created_at
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
    const renderCache = database.prepare('SELECT cache_key, svg, manifest, code_slice FROM render_cache ORDER BY cache_key').all();
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
        schema_version: Number(row.schema_version),
        snapshotJson: parseJson(row.snapshot_json, null),
      })),
      exportAnchor: exportAsset ? {
        id: exportAsset.id,
        metadata: parseJson(exportAsset.metadata, null),
        snapshot: exportSnapshot ? {
          assetId: exportSnapshot.asset_id,
          schemaVersion: Number(exportSnapshot.schema_version),
          snapshotHash: exportSnapshot.snapshot_hash,
          snapshotJson: parseJson(exportSnapshot.snapshot_json, null),
        } : null,
      } : null,
    };
  } finally {
    database.close();
  }
}

function markPersistedGroupDormant(projectId, groupId) {
  const database = new Database(process.env.SCIFIGURE_DB_PATH);
  try {
    const row = database.prepare(`
      SELECT manifest
      FROM project_figures
      WHERE project_id = ? AND figure_index = 0
    `).get(projectId);
    const manifest = parseJson(row?.manifest, null);
    const target = manifest?.objects?.find((object) => object?.id === groupId);
    assert(target, `could not find ${groupId} in persisted R manifest`);
    target.currentProps = { ...(target.currentProps || {}), scaleActive: false };
    database.prepare(`
      UPDATE project_figures
      SET manifest = ?
      WHERE project_id = ? AND figure_index = 0
    `).run(JSON.stringify(manifest), projectId);
  } finally {
    database.close();
  }
}

async function createProject(token) {
  const created = await jsonRequest('/api/projects', token, {
    method: 'POST',
    body: JSON.stringify({
      name: `R patch authority ${Date.now()}`,
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
      requestId: `r-authority-render-${Date.now()}-${Math.random().toString(36).slice(2)}`,
    }),
  });
  assert(rendered.response.ok && rendered.data?.status === 'success', `initial R project render failed: ${JSON.stringify(rendered.data)}`);
  const figure = rendered.data.figures?.find((item) => item.figureId === 'fig_1');
  assert(figure?.manifest?.objects?.length > 0, 'initial R project render did not return fig_1 manifest');
  const target = findPatchTarget(figure.manifest);
  const secondaryTarget = findSecondaryPatchTarget(figure.manifest, target);
  const groupTarget = figure.manifest.objects.find((object) => (
    String(object?.id || '').startsWith('r.group.color.')
    && object?.editable?.includes('color')
  ));
  assert(groupTarget?.id, 'initial R project render did not expose an editable color group');
  return { projectId, figure, target, secondaryTarget, groupTarget };
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
  const target = findPatchTarget(rendered.data.manifest);
  return {
    sessionId: rendered.data.sessionId,
    revision: Number(rendered.data.revision || 1),
    target,
  };
}

async function exportProjectFigure(token, projectId, format = 'svg') {
  const exported = await jsonRequest(`/api/projects/${projectId}/export`, token, {
    method: 'POST',
    body: JSON.stringify({
      figureId: 'fig_1',
      format,
      dpi: 150,
      saveToLibrary: true,
      name: `r-patch-authority-${format}-export-anchor`,
    }),
  });
  assert(exported.response.ok && exported.data?.status === 'success', `R project export failed: ${JSON.stringify(exported.data)}`);
  const exportedFigure = exported.data.figures?.[0];
  const asset = exportedFigure?.asset;
  assert(asset?.assetId && asset.hasEditingSnapshot === true, `R project export did not create an editing snapshot: ${JSON.stringify(exported.data)}`);
  assert(asset.format === format, `R project export silently changed ${format} to ${asset.format}: ${JSON.stringify(exported.data)}`);
  if (format !== 'svg') {
    assert(exportedFigure?.binary_b64, `R project ${format} export did not return binary output`);
  }
  return asset;
}

async function submitPatch(token, body) {
  return jsonRequest('/api/figure/patch', token, {
    method: 'POST',
    body: JSON.stringify({
      requestId: `r-authority-${Date.now()}-${Math.random().toString(36).slice(2)}`,
      ...body,
    }),
  });
}

function assertRejectedResponse(label, result, rejectedPatches, expectedRevision) {
  assert(result.response.ok, `${label} failed at HTTP layer: ${result.response.status} ${JSON.stringify(result.data)}`);
  assert(result.data?.status === 'conflict', `${label} should be rejected with conflict: ${JSON.stringify(result.data)}`);
  assert(Number(result.data?.revision) === expectedRevision, `${label} changed response revision: ${JSON.stringify(result.data)}`);
  assert(Array.isArray(result.data?.applied) && result.data.applied.length === 0, `${label} should apply nothing: ${JSON.stringify(result.data)}`);
  for (const patch of rejectedPatches) {
    assert(
      Array.isArray(result.data?.rejected) && result.data.rejected.some((entry) => isSamePatch(entry, patch)),
      `${label} response did not identify rejected patch ${stable(patch)}: ${JSON.stringify(result.data)}`,
    );
  }
}

async function assertProjectRejectedWithoutPersistence(token, projectId, standaloneSessionId, exportAssetId, label, patchBody, rejectedPatches, expectedRevision) {
  const before = readDatabaseState(projectId, standaloneSessionId, exportAssetId);
  const result = await submitPatch(token, patchBody);
  assertRejectedResponse(label, result, rejectedPatches, expectedRevision);
  const after = readDatabaseState(projectId, standaloneSessionId, exportAssetId);
  assertSameState(label, before, after);

  const loaded = await jsonRequest(`/api/projects/${projectId}`, token);
  assert(loaded.response.ok && loaded.data?.status === 'success', `${label} project reload failed: ${JSON.stringify(loaded.data)}`);
  const apiFigure = loaded.data.project?.figures?.find((item) => item.figureId === 'fig_1');
  assert(apiFigure, `${label} project reload did not return fig_1`);
  for (const patch of rejectedPatches) {
    assert(!apiFigure.editLog?.some((entry) => isSamePatch(entry, patch)), `${label} leaked into project API editLog: ${JSON.stringify(apiFigure.editLog)}`);
    assert(!JSON.stringify(apiFigure.history || {}).includes(patch.gid), `${label} leaked gid into project API history: ${JSON.stringify(apiFigure.history)}`);
  }
}

async function assertDormantGroupProjectSaveRejected(token, projectId, standaloneSessionId, exportAssetId, patch) {
  markPersistedGroupDormant(projectId, patch.gid);
  const before = readDatabaseState(projectId, standaloneSessionId, exportAssetId);
  const figure = before.figure;
  const dormantObject = figure?.manifest?.objects?.find((object) => object?.id === patch.gid);
  assert(dormantObject?.currentProps?.scaleActive === false, 'dormant group marker was not persisted for save preflight');

  const dormantPatch = {
    ...patch,
    value: '#FF00FF',
    ...identityFields(dormantObject),
  };
  const attempt = await jsonRequest(`/api/projects/${projectId}`, token, {
    method: 'PUT',
    body: JSON.stringify({
      name: 'R patch authority dormant group rejection',
      figures: [{
        figureId: 'fig_1',
        ...projectFigureSaveBase(figure),
        revision: figure.revision,
        editLog: [...(figure.editLog || []), dormantPatch],
      }],
    }),
  });
  assert(
    attempt.response.status === 409
      && attempt.data?.status === 'conflict'
      && attempt.data?.warnings?.some((warning) => warning?.type === 'no_setter' && warning?.gid === dormantPatch.gid),
    `dormant R group project save was not rejected: ${attempt.response.status} ${JSON.stringify(attempt.data)}`,
  );
  assertSameState(
    'dormant R group project save rejection',
    before,
    readDatabaseState(projectId, standaloneSessionId, exportAssetId),
  );
}

async function assertAuthoritativeSuccess(token, {
  projectId,
  standaloneSessionId,
  exportAssetId,
  label,
  patchBody,
  expectedPatches,
  expectedRevision,
}) {
  const before = readDatabaseState(projectId, standaloneSessionId, exportAssetId);
  const result = await submitPatch(token, patchBody);
  assert(result.response.ok && result.data?.status === 'success', `${label} did not succeed: ${JSON.stringify(result.data)}`);
  assert(Number(result.data?.revision) === expectedRevision + 1, `${label} did not increment revision exactly once: ${JSON.stringify(result.data)}`);
  for (const patch of expectedPatches) {
    const applied = result.data?.applied?.find((entry) => isSamePatch(entry, patch));
    assert(applied, `${label} did not report applied patch ${stable(patch)}: ${JSON.stringify(result.data)}`);
    assert(applied.mode === 'backend_patch', `${label} trusted a client patch mode instead of backend authority: ${JSON.stringify(applied)}`);
  }

  const after = readDatabaseState(projectId, standaloneSessionId, exportAssetId);
  const sessionId = projectId ? `${projectId}_fig_1` : standaloneSessionId;
  assert(Number(after.sessions[sessionId]?.revision) === expectedRevision + 1, `${label} session revision mismatch: ${JSON.stringify(after.sessions[sessionId])}`);
  for (const patch of expectedPatches) {
    const stored = after.sessions[sessionId]?.editLog?.find((entry) => isSamePatch(entry, patch));
    assert(stored?.mode === 'backend_patch', `${label} did not persist the authoritative backend mode: ${JSON.stringify(after.sessions[sessionId])}`);
  }
  if (projectId) {
    assert(Number(after.figure?.revision) === expectedRevision + 1, `${label} Figure revision mismatch: ${JSON.stringify(after.figure)}`);
    assert(after.figure?.previewSvg && after.figure?.manifest, `${label} did not atomically refresh project SVG/manifest`);
    assertSameState(`${label} export anchor`, before.exportAnchor, after.exportAnchor);
  }
  return expectedRevision + 1;
}

function projectPatchBody(projectId, patches, baseRevision) {
  return {
    sessionId: `${projectId}_fig_1`,
    projectId,
    figureId: 'fig_1',
    baseRevision,
    patches,
  };
}

function standalonePatchBody(sessionId, patches, baseRevision) {
  return {
    sessionId,
    baseRevision,
    patches,
  };
}

async function main() {
  assertIsolatedEnvironment();
  const token = await register();
  let projectId = null;
  try {
    const project = await createProject(token);
    projectId = project.projectId;
    const standalone = await createStandaloneSession(token);
    const exportAsset = await exportProjectFigure(token, projectId, 'svg');
    const pngExportAsset = await exportProjectFigure(token, projectId, 'png');
    const exportAssetId = exportAsset.assetId;
    let projectRevision = Number(project.figure.revision || 1);
    let standaloneRevision = standalone.revision;

    const projectValidTargetPatch = {
      op: 'set',
      mode: 'backend_patch',
      gid: project.target.object.id,
      prop: project.target.prop,
      value: patchValue(project.target.prop, 2.4, '#1166aa'),
      ...identityFields(project.target.object),
    };
    const standaloneValidTargetPatch = {
      op: 'set',
      mode: 'backend_patch',
      gid: standalone.target.object.id,
      prop: standalone.target.prop,
      value: patchValue(standalone.target.prop, 2.2, '#2255aa'),
      ...identityFields(standalone.target.object),
    };
    const projectFakeLocalPatch = { ...projectValidTargetPatch, mode: 'local_patch', value: patchValue(project.target.prop, 3.3, '#aa2255') };
    const standaloneFakeLocalPatch = { ...standaloneValidTargetPatch, mode: 'local_patch', value: patchValue(standalone.target.prop, 3.1, '#aa5522') };
    const missingGidPatch = {
      op: 'set',
      mode: 'backend_patch',
      gid: 'missing.r.authority.gid',
      prop: project.target.prop,
      value: patchValue(project.target.prop, 4.4, '#334455'),
    };
    const unsupportedPropPatch = {
      op: 'set',
      mode: 'backend_patch',
      gid: project.target.object.id,
      prop: 'r_wp1_unsupported_prop',
      value: 'must-not-persist',
      ...identityFields(project.target.object),
    };
    const identityMismatchPatch = {
      ...projectValidTargetPatch,
      value: patchValue(project.target.prop, 5.5, '#445566'),
      stableKey: `mismatched-${project.target.object.stableKey || project.target.object.id}`,
      identity: {
        ...(project.target.object.identity || {}),
        seriesKey: `mismatched-${project.target.object.identity?.seriesKey || project.target.object.id}`,
      },
    };
    const setterFailurePatch = {
      ...projectValidTargetPatch,
      value: 'not-a-valid-numeric-style',
    };
    const mixedBatchRejectedPatch = {
      op: 'set',
      mode: 'backend_patch',
      gid: 'missing.r.authority.mixed.gid',
      prop: project.target.prop,
      value: patchValue(project.target.prop, 6.6, '#556677'),
    };
    const mixedBatchValidPatch = {
      ...projectValidTargetPatch,
      value: patchValue(project.target.prop, 1.7, '#117744'),
    };
    const legalMixedBackendPatch = {
      op: 'set',
      mode: 'backend_patch',
      gid: project.secondaryTarget.object.id,
      prop: project.secondaryTarget.prop,
      value: patchValue(project.secondaryTarget.prop, 13, '#336699'),
      ...identityFields(project.secondaryTarget.object),
    };
    const legalMixedLocalPatch = {
      ...projectValidTargetPatch,
      mode: 'local_patch',
      value: patchValue(project.target.prop, 1.9, '#228855'),
    };
    const groupColorPatch = {
      op: 'set',
      mode: 'backend_patch',
      gid: project.groupTarget.id,
      prop: 'color',
      value: '#2CA02C',
      ...identityFields(project.groupTarget),
    };

    standaloneRevision = await assertAuthoritativeSuccess(token, {
      projectId: null,
      standaloneSessionId: standalone.sessionId,
      exportAssetId: null,
      label: 'standalone client-declared local R patch',
      patchBody: standalonePatchBody(standalone.sessionId, [standaloneFakeLocalPatch], standaloneRevision),
      expectedPatches: [standaloneFakeLocalPatch],
      expectedRevision: standaloneRevision,
    });
    projectRevision = await assertAuthoritativeSuccess(token, {
      projectId,
      standaloneSessionId: standalone.sessionId,
      exportAssetId,
      label: 'project client-declared local R patch',
      patchBody: projectPatchBody(projectId, [projectFakeLocalPatch], projectRevision),
      expectedPatches: [projectFakeLocalPatch],
      expectedRevision: projectRevision,
    });
    projectRevision = await assertAuthoritativeSuccess(token, {
      projectId,
      standaloneSessionId: standalone.sessionId,
      exportAssetId,
      label: 'R semantic group color patch',
      patchBody: projectPatchBody(projectId, [groupColorPatch], projectRevision),
      expectedPatches: [groupColorPatch],
      expectedRevision: projectRevision,
    });
    projectRevision = await assertAuthoritativeSuccess(token, {
      projectId,
      standaloneSessionId: standalone.sessionId,
      exportAssetId,
      label: 'legal R local/backend mixed batch',
      patchBody: projectPatchBody(projectId, [legalMixedLocalPatch, legalMixedBackendPatch], projectRevision),
      expectedPatches: [legalMixedLocalPatch, legalMixedBackendPatch],
      expectedRevision: projectRevision,
    });
    await assertProjectRejectedWithoutPersistence(
      token,
      projectId,
      standalone.sessionId,
      exportAssetId,
      'R missing gid patch',
      projectPatchBody(projectId, [missingGidPatch], projectRevision),
      [missingGidPatch],
      projectRevision,
    );
    await assertProjectRejectedWithoutPersistence(
      token,
      projectId,
      standalone.sessionId,
      exportAssetId,
      'R unsupported prop patch',
      projectPatchBody(projectId, [unsupportedPropPatch], projectRevision),
      [unsupportedPropPatch],
      projectRevision,
    );
    await assertProjectRejectedWithoutPersistence(
      token,
      projectId,
      standalone.sessionId,
      exportAssetId,
      'R identity mismatch patch',
      projectPatchBody(projectId, [identityMismatchPatch], projectRevision),
      [identityMismatchPatch],
      projectRevision,
    );
    await assertProjectRejectedWithoutPersistence(
      token,
      projectId,
      standalone.sessionId,
      exportAssetId,
      'R setter acknowledgement failure',
      projectPatchBody(projectId, [setterFailurePatch], projectRevision),
      [setterFailurePatch],
      projectRevision,
    );
    await assertProjectRejectedWithoutPersistence(
      token,
      projectId,
      standalone.sessionId,
      exportAssetId,
      'R mixed valid and rejected batch',
      projectPatchBody(projectId, [mixedBatchValidPatch, mixedBatchRejectedPatch], projectRevision),
      [mixedBatchValidPatch, mixedBatchRejectedPatch],
      projectRevision,
    );
    await assertDormantGroupProjectSaveRejected(
      token,
      projectId,
      standalone.sessionId,
      exportAssetId,
      groupColorPatch,
    );

    console.log(JSON.stringify({
      status: 'PASS',
      projectId,
      standaloneSessionId: standalone.sessionId,
      exportAssetId,
      pngExportAssetId: pngExportAsset.assetId,
      checked: [
        'standalone R client-declared local patch normalized to backend and confirmed',
        'project R client-declared local patch normalized to backend and atomically persisted',
        'legal R local/backend mixed batch persisted with one revision',
        'R semantic group color patch receives a complete renderer acknowledgement',
        'R project PNG export creates binary output and an editing snapshot',
        'R missing gid patch rejected without persistence',
        'R unsupported prop patch rejected without persistence',
        'R identity mismatch patch rejected without persistence',
        'R setter acknowledgement failure rejected without persistence',
        'R mixed valid/rejected batch rejected atomically without persistence',
        'R dormant scale-group project save rejected without persistence',
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
