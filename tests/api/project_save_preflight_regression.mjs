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

function assertIsolatedEnvironment() {
  assert(process.env.SCIFIGURE_TEST_ISOLATED === '1', 'test must run under the isolated server wrapper');
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
      email: `project-save-preflight-${Date.now()}-${Math.random().toString(36).slice(2)}@example.test`,
      password: 'Project-Save-Preflight-2026',
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
  'ax.set_title("Project save preflight")',
  'ax.set_xlabel("Original X")',
  'ax.set_ylabel("Original Y")',
  'ax.legend(loc="upper left")',
  'fig.tight_layout()',
].join('\n');

function identityFields(object) {
  return {
    ...(object.stableKey !== undefined ? { stableKey: object.stableKey } : {}),
    ...(object.fingerprintVersion === 2
      ? { fingerprint: object.fingerprint, fingerprintVersion: 2 }
      : {}),
    ...(object.identity !== undefined ? { identity: object.identity } : {}),
  };
}

function figureFrom(project, figureId = 'fig_1') {
  return project?.figures?.find(figure => figure.figureId === figureId) || null;
}

function matchingEntry(figure, patch) {
  return (figure?.editLog || []).find(entry => (
    entry.gid === patch.gid
      && entry.prop === patch.prop
      && JSON.stringify(entry.value) === JSON.stringify(patch.value)
  ));
}

async function main() {
  assertIsolatedEnvironment();
  const token = await register();

  const created = await jsonRequest('/api/projects', token, {
    method: 'POST',
    body: JSON.stringify({
      name: `Project save preflight ${Date.now()}`,
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
      requestId: `project-save-preflight-${Date.now()}`,
    }),
  });
  assert(rendered.response.ok && rendered.data?.status === 'success', `initial render failed: ${JSON.stringify(rendered.data)}`);
  const renderedFigure = rendered.data.figures?.find(figure => figure.figureId === 'fig_1');
  assert(renderedFigure?.manifest?.objects?.length > 0, 'initial render did not return a manifest');

  const line = renderedFigure.manifest.objects.find(object => object.kind === 'line' && object.editable?.includes('linewidth'));
  const title = renderedFigure.manifest.objects.find(object => object.id === 'title.0')
    || renderedFigure.manifest.objects.find(object => object.kind === 'text' && object.editable?.includes('fontsize'));
  const localColorTarget = renderedFigure.manifest.objects.find(object => (
    Array.isArray(object.propertyCapabilities)
      && object.propertyCapabilities.some(capability => capability?.prop === 'color' && capability?.patchMode === 'local_patch')
  ));
  assert(line?.id, 'manifest has no editable line width target');
  assert(title?.id, 'manifest has no editable title font target');
  assert(localColorTarget?.id, 'manifest has no local color target to invalidate preview');

  const lyingLocalPatch = {
    op: 'set',
    mode: 'local_patch',
    gid: line.id,
    prop: 'linewidth',
    value: 2.75,
    ...identityFields(line),
  };
  const saved = await jsonRequest(`/api/projects/${projectId}`, token, {
    method: 'PUT',
    body: JSON.stringify({
      name: 'Project save preflight',
      figures: [{
        figureId: 'fig_1',
        ...projectFigureSaveBase(renderedFigure),
        revision: renderedFigure.revision,
        editLog: [lyingLocalPatch],
      }],
    }),
  });
  assert(saved.response.ok && saved.data?.status === 'success', `valid save failed: ${JSON.stringify(saved.data)}`);

  const afterValid = await jsonRequest(`/api/projects/${projectId}`, token);
  assert(afterValid.response.ok && afterValid.data?.status === 'success', 'could not reload project after valid save');
  const validFigure = figureFrom(afterValid.data.project);
  const persistedValid = matchingEntry(validFigure, lyingLocalPatch);
  assert(persistedValid, 'valid PUT edit was not persisted');
  assert(persistedValid.mode === 'backend_patch', `PUT trusted client mode: ${JSON.stringify(persistedValid)}`);

  const cleared = await jsonRequest(`/api/projects/${projectId}`, token, {
    method: 'PUT',
    body: JSON.stringify({
      name: 'Project save preflight',
      figures: [{ figureId: 'fig_1', ...projectFigureSaveBase(validFigure), revision: validFigure.revision, editLog: [] }],
    }),
  });
  assert(cleared.response.ok && cleared.data?.status === 'success', `authoritative empty editLog save failed: ${JSON.stringify(cleared.data)}`);
  const afterCleared = await jsonRequest(`/api/projects/${projectId}`, token);
  const clearedFigure = figureFrom(afterCleared.data.project);
  assert(!matchingEntry(clearedFigure, lyingLocalPatch), 'PUT editLog replacement resurrected a removed edit');
  const baselineRevision = Number(clearedFigure.revision || 1);
  const baselineEditLog = JSON.stringify(clearedFigure.editLog || []);

  const secondValidPatch = {
    op: 'set',
    mode: 'local_patch',
    gid: title.id,
    prop: 'fontsize',
    value: 37,
    ...identityFields(title),
  };
  const rejectedPatch = {
    op: 'set',
    mode: 'local_patch',
    gid: 'missing.project-save.gid',
    prop: 'fontsize',
    value: 99,
  };
  const mixed = await jsonRequest(`/api/projects/${projectId}`, token, {
    method: 'PUT',
    body: JSON.stringify({
      name: 'Project save preflight',
      figures: [{
        figureId: 'fig_1',
        ...projectFigureSaveBase(clearedFigure),
        revision: baselineRevision,
        editLog: [secondValidPatch, rejectedPatch],
      }],
    }),
  });
  assert(mixed.response.status === 409 && mixed.data?.status === 'conflict', `mixed invalid save was accepted: ${mixed.response.status} ${JSON.stringify(mixed.data)}`);
  assert(Array.isArray(mixed.data?.rejected) && mixed.data.rejected.some(patch => patch.gid === rejectedPatch.gid), 'conflict response did not identify rejected PUT patch');

  const afterRejected = await jsonRequest(`/api/projects/${projectId}`, token);
  assert(afterRejected.response.ok && afterRejected.data?.status === 'success', 'could not reload project after rejected save');
  const rejectedFigure = figureFrom(afterRejected.data.project);
  assert(Number(rejectedFigure.revision || 1) === baselineRevision, 'rejected PUT changed revision');
  assert(JSON.stringify(rejectedFigure.editLog || []) === baselineEditLog, 'rejected PUT changed persisted editLog');
  assert(!matchingEntry(rejectedFigure, secondValidPatch), 'valid member of rejected mixed PUT leaked into editLog');
  assert(!matchingEntry(rejectedFigure, rejectedPatch), 'invalid member of rejected mixed PUT leaked into editLog');

  const historyRejectedPatch = {
    op: 'set',
    mode: 'local_patch',
    gid: 'missing.project-save.history.gid',
    prop: 'color',
    value: '#c026d3',
  };
  const historyAttempt = await jsonRequest(`/api/projects/${projectId}`, token, {
    method: 'PUT',
    body: JSON.stringify({
      name: 'Project save preflight',
      figures: [{
        figureId: 'fig_1',
        ...projectFigureSaveBase(clearedFigure),
        revision: baselineRevision,
        editLog: [],
        history: {
          past: [{ label: 'untrusted history', timestamp: Date.now(), editLog: [historyRejectedPatch] }],
          future: [],
        },
      }],
    }),
  });
  assert(historyAttempt.response.status === 409 && historyAttempt.data?.status === 'conflict', `history-only invalid save was accepted: ${historyAttempt.response.status} ${JSON.stringify(historyAttempt.data)}`);

  const afterHistoryRejected = await jsonRequest(`/api/projects/${projectId}`, token);
  assert(afterHistoryRejected.response.ok && afterHistoryRejected.data?.status === 'success', 'could not reload project after rejected history save');
  const historyFigure = figureFrom(afterHistoryRejected.data.project);
  assert(JSON.stringify(historyFigure.history || { past: [], future: [] }) === JSON.stringify(validFigure.history || { past: [], future: [] }), 'rejected history PUT changed persisted history');

  for (const malformedHistory of [
    { past: [null], future: [] },
    { past: [{ label: 'malformed edit log', editLog: {} }], future: [] },
  ]) {
    const malformedAttempt = await jsonRequest(`/api/projects/${projectId}`, token, {
      method: 'PUT',
      body: JSON.stringify({
        name: 'Project save preflight',
        figures: [{
          figureId: 'fig_1',
          ...projectFigureSaveBase(clearedFigure),
          revision: baselineRevision,
          editLog: [],
          history: malformedHistory,
        }],
      }),
    });
    assert(malformedAttempt.response.status === 409 && malformedAttempt.data?.status === 'conflict', `malformed history was accepted: ${JSON.stringify(malformedAttempt.data)}`);
  }

  const invalidatePreview = await jsonRequest('/api/figure/patch', token, {
    method: 'POST',
    body: JSON.stringify({
      sessionId: `${projectId}_fig_1`,
      projectId,
      figureId: 'fig_1',
      baseRevision: baselineRevision,
      requestId: `project-save-preflight-invalidate-${Date.now()}`,
      patches: [{
        op: 'set',
        mode: 'local_patch',
        gid: localColorTarget.id,
        prop: 'color',
        value: '#0f766e',
        ...identityFields(localColorTarget),
      }],
    }),
  });
  assert(invalidatePreview.response.ok && invalidatePreview.data?.status === 'success', `local preview invalidation failed: ${JSON.stringify(invalidatePreview.data)}`);

  const afterInvalidation = await jsonRequest(`/api/projects/${projectId}`, token);
  assert(afterInvalidation.response.ok && afterInvalidation.data?.status === 'success', 'could not reload project after preview invalidation');
  const invalidatedFigure = figureFrom(afterInvalidation.data.project);
  const noManifestRevision = Number(invalidatedFigure.revision || 1);
  const noManifestEditLog = JSON.stringify(invalidatedFigure.editLog || []);
  const noManifestPatch = {
    op: 'set',
    mode: 'local_patch',
    gid: title.id,
    prop: 'fontsize',
    value: 41,
    ...identityFields(title),
  };
  const noManifestSave = await jsonRequest(`/api/projects/${projectId}`, token, {
    method: 'PUT',
    body: JSON.stringify({
      name: 'Project save preflight',
      figures: [{
        figureId: 'fig_1',
        ...projectFigureSaveBase(invalidatedFigure),
        revision: noManifestRevision,
        editLog: [noManifestPatch],
      }],
    }),
  });
  assert(noManifestSave.response.status === 409 && noManifestSave.data?.status === 'conflict', `new edit without manifest was accepted: ${noManifestSave.response.status} ${JSON.stringify(noManifestSave.data)}`);
  const afterNoManifestRejected = await jsonRequest(`/api/projects/${projectId}`, token);
  const noManifestFigure = figureFrom(afterNoManifestRejected.data.project);
  assert(Number(noManifestFigure.revision || 1) === noManifestRevision, 'no-manifest rejected PUT changed revision');
  assert(JSON.stringify(noManifestFigure.editLog || []) === noManifestEditLog, 'no-manifest rejected PUT changed editLog');

  console.log(JSON.stringify({
    status: 'PASS',
    checks: [
      'project PUT derives patch mode from trusted manifest capabilities',
      'mixed valid+invalid project PUT is atomic',
      'rejected project PUT does not change revision or editLog',
      'history cannot bypass project PUT preflight',
      'new project PUT edits are rejected when the trusted manifest is unavailable',
    ],
  }, null, 2));
}

main().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
