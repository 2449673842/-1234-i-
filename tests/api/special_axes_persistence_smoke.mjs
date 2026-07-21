import Database from 'better-sqlite3';
import crypto from 'node:crypto';
import path from 'node:path';

const BASE_URL = process.env.SCIFIGURE_URL || 'http://localhost:3000';

const UNSAFE_LAYOUT_PROPS = new Set([
  'left',
  'bottom',
  'width',
  'height',
  'position',
  'aspect',
  'box_aspect',
]);

const script = [
  'import matplotlib',
  'matplotlib.use("Agg")',
  'import matplotlib.pyplot as plt',
  '',
  'fig = plt.figure(figsize=(4, 3))',
  'ax = fig.add_subplot(111, projection="polar")',
  'ax.plot([0.0, 0.7, 1.4], [1.0, 2.0, 1.5], color="#1f77b4", linestyle="-", linewidth=1.2, label="polar response")',
  'ax.set_title("Special axes persistence")',
  'ax.legend(loc="upper right")',
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
      email: `special-axes-${Date.now()}-${Math.random().toString(36).slice(2)}@example.test`,
      password: 'Special-Axes-Persistence-2026',
    }),
  });
  assert(result.response.ok && result.data?.token, `registration failed: ${JSON.stringify(result.data)}`);
  return result.data.token;
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

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function styleValueMatches(actual, expected) {
  const normalizedActual = String(actual ?? '').toLowerCase();
  const normalizedExpected = String(expected ?? '').toLowerCase();
  const aliases = new Map([
    ['--', 'dashed'],
    ['-.', 'dashdot'],
    [':', 'dotted'],
    ['-', 'solid'],
  ]);
  return normalizedActual === normalizedExpected
    || aliases.get(normalizedActual) === normalizedExpected
    || aliases.get(normalizedExpected) === normalizedActual;
}

function patchTripletMatches(entry, patch) {
  return entry?.gid === patch.gid
    && entry?.prop === patch.prop
    && JSON.stringify(entry?.value) === JSON.stringify(patch.value);
}

function assertNoRejectedTriplet(label, value, rejected) {
  const leaked = [];
  const visit = (node) => {
    if (!node || typeof node !== 'object') return;
    if (patchTripletMatches(node, rejected)) leaked.push(node);
    Object.values(node).forEach(visit);
  };
  visit(value);
  assert(leaked.length === 0, `${label} leaked rejected patch: ${JSON.stringify(leaked)}`);
}

function assertJsonDoesNotContainRejectedValue(label, value, rejectedValue) {
  const serialized = JSON.stringify(value) || '';
  assert(!serialized.includes(String(rejectedValue)), `${label} contains rejected value ${rejectedValue}`);
}

function assertManifestPatchValue(manifest, patch, label) {
  const object = manifest?.objects?.find(item => item.id === patch.gid);
  assert(object, `${label} manifest is missing ${patch.gid}`);
  assert(
    styleValueMatches(object.currentProps?.[patch.prop], patch.value),
    `${label} manifest did not apply ${patch.gid}.${patch.prop}=${JSON.stringify(patch.value)}: ${JSON.stringify(object.currentProps)}`,
  );
}

function assertEditLogHasPatch(editLog, patch, label) {
  assert(
    Array.isArray(editLog) && editLog.some(entry => patchTripletMatches(entry, patch)),
    `${label} editLog is missing ${JSON.stringify(patch)}`,
  );
}

function readPersistenceState(projectId) {
  const database = new Database(process.env.SCIFIGURE_DB_PATH, { readonly: true });
  try {
    database.pragma('busy_timeout = 5000');
    const project = database.prepare(`
      SELECT name, spec, script, updated_at
      FROM projects
      WHERE id = ?
    `).get(projectId);
    const session = database.prepare(`
      SELECT id, revision, edit_log, updated_at
      FROM sessions
      WHERE id = ?
    `).get(`${projectId}_fig_1`);
    const figure = database.prepare(`
      SELECT revision, edit_log, history, preview_svg, manifest, fingerprint, preview_updated_at
      FROM project_figures
      WHERE project_id = ? AND figure_index = 0
    `).get(projectId);
    return {
      project: project || null,
      session: session ? { ...session, editLog: parseJson(session.edit_log, []) } : null,
      figure: figure ? {
        ...figure,
        editLog: parseJson(figure.edit_log, []),
        history: parseJson(figure.history, null),
        manifest: parseJson(figure.manifest, null),
      } : null,
    };
  } finally {
    database.close();
  }
}

function readStandaloneState(sessionId) {
  const database = new Database(process.env.SCIFIGURE_DB_PATH, { readonly: true });
  try {
    database.pragma('busy_timeout = 5000');
    const session = database.prepare(`
      SELECT id, revision, edit_log, updated_at
      FROM sessions
      WHERE id = ?
    `).get(sessionId);
    return session ? { ...session, editLog: parseJson(session.edit_log, []) } : null;
  } finally {
    database.close();
  }
}

function readSessionCount() {
  const database = new Database(process.env.SCIFIGURE_DB_PATH, { readonly: true });
  try {
    return Number(database.prepare('SELECT COUNT(*) AS count FROM sessions').get()?.count || 0);
  } finally {
    database.close();
  }
}

function writeStandaloneEditLog(sessionId, editLog) {
  const database = new Database(process.env.SCIFIGURE_DB_PATH);
  try {
    database.prepare('UPDATE sessions SET edit_log = ? WHERE id = ?').run(JSON.stringify(editLog), sessionId);
  } finally {
    database.close();
  }
}

function writeProjectFigureEditLog(projectId, editLog) {
  const database = new Database(process.env.SCIFIGURE_DB_PATH);
  try {
    database.pragma('busy_timeout = 5000');
    database.transaction(() => {
      database.prepare('UPDATE sessions SET edit_log = ? WHERE id = ?')
        .run(JSON.stringify(editLog), `${projectId}_fig_1`);
      database.prepare('UPDATE project_figures SET edit_log = ? WHERE project_id = ? AND figure_index = 0')
        .run(JSON.stringify(editLog), projectId);
    })();
  } finally {
    database.close();
  }
}

function writeProjectFigureOnlyEditLog(projectId, editLog) {
  const database = new Database(process.env.SCIFIGURE_DB_PATH);
  try {
    database.pragma('busy_timeout = 5000');
    database.transaction(() => {
      database.prepare('UPDATE sessions SET edit_log = ? WHERE id = ?')
        .run('[]', `${projectId}_fig_1`);
      database.prepare('UPDATE project_figures SET edit_log = ? WHERE project_id = ? AND figure_index = 0')
        .run(JSON.stringify(editLog), projectId);
    })();
  } finally {
    database.close();
  }
}

async function verifyStandaloneMissingRelationRejection(token) {
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
  assert(rendered.response.ok && rendered.data?.status === 'success', `standalone special-axes render failed: ${JSON.stringify(rendered.data)}`);
  const sessionId = rendered.data?.sessionId;
  assert(sessionId, `standalone special-axes render returned no sessionId: ${JSON.stringify(rendered.data)}`);
  const { line } = findPolarTargets(rendered.data.manifest);
  const revision = Number(rendered.data.revision || 1);
  const before = readStandaloneState(sessionId);
  const patch = {
    op: 'set',
    mode: 'local_patch',
    gid: line.id,
    prop: 'linestyle',
    value: '--',
    stableKey: line.stableKey,
    fingerprint: line.fingerprint,
    fingerprintVersion: line.fingerprintVersion,
  };
  const result = await jsonRequest('/api/figure/patch', token, {
    method: 'POST',
    body: JSON.stringify({
      sessionId,
      requestId: `standalone-special-axes-${Date.now()}-${Math.random().toString(36).slice(2)}`,
      baseRevision: revision,
      patches: [patch],
    }),
  });
  assert(result.response.ok && result.data?.status === 'conflict', `standalone missing relation should conflict: ${JSON.stringify(result.data)}`);
  assert(Number(result.data?.revision) === revision, `standalone missing relation changed response revision: ${JSON.stringify(result.data)}`);
  assert(
    result.data?.warnings?.some(warning => warning?.type === 'identity_mismatch' && warning?.gid === line.id),
    `standalone rejection did not report identity_mismatch: ${JSON.stringify(result.data)}`,
  );
  assert(
    JSON.stringify(readStandaloneState(sessionId)) === JSON.stringify(before),
    'standalone missing-relation rejection changed session revision or editLog',
  );
}

async function verifyStandaloneRenderRejectsInvalidEditLog(token) {
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
  assert(rendered.response.ok && rendered.data?.status === 'success', `standalone render baseline failed: ${JSON.stringify(rendered.data)}`);
  const sessionId = rendered.data?.sessionId;
  assert(sessionId, `standalone render baseline returned no sessionId: ${JSON.stringify(rendered.data)}`);
  const { line } = findPolarTargets(rendered.data.manifest);
  const validPatch = {
    op: 'set',
    mode: 'backend_patch',
    gid: line.id,
    prop: 'linewidth',
    value: 3.25,
    ...identityFields(line),
  };
  const missingRelationPatch = {
    op: 'set',
    mode: 'backend_patch',
    gid: line.id,
    prop: 'linestyle',
    value: '--',
    stableKey: line.stableKey,
    fingerprint: line.fingerprint,
    fingerprintVersion: line.fingerprintVersion,
  };
  const beforeSession = readStandaloneState(sessionId);
  const beforeSessionCount = readSessionCount();
  const rejected = await jsonRequest('/api/figure/render', token, {
    method: 'POST',
    body: JSON.stringify({
      sessionId,
      script,
      language: 'python',
      dataPayload: null,
      editLog: [validPatch, missingRelationPatch],
      renderOptions: { dpi: 150 },
    }),
  });
  assert(rejected.response.ok && rejected.data?.status === 'conflict', `standalone render accepted rejected editLog: ${JSON.stringify(rejected.data)}`);
  assert(
    rejected.data?.warnings?.some(warning => warning?.type === 'identity_mismatch' && warning?.gid === line.id),
    `standalone render rejection did not report identity_mismatch: ${JSON.stringify(rejected.data)}`,
  );
  assert(readSessionCount() === beforeSessionCount, 'standalone rejected render created or deleted a session');
  assert(
    JSON.stringify(readStandaloneState(sessionId)) === JSON.stringify(beforeSession),
    'standalone rejected render changed the existing session',
  );
}

async function verifyStandaloneRenderKeepsPersistedLegacyEditLog(token) {
  const rendered = await jsonRequest('/api/figure/render', token, {
    method: 'POST',
    body: JSON.stringify({ script, language: 'python', editLog: [] }),
  });
  assert(rendered.response.ok && rendered.data?.status === 'success', `legacy standalone baseline failed: ${JSON.stringify(rendered.data)}`);
  const sessionId = rendered.data?.sessionId;
  const { line } = findPolarTargets(rendered.data.manifest);
  const legacyPatch = {
    gid: line.id,
    prop: 'color',
    value: '#00aa55',
    mode: 'backend_patch',
    stableKey: line.stableKey,
  };
  writeStandaloneEditLog(sessionId, [legacyPatch]);
  const beforeSessionCount = readSessionCount();

  const replayed = await jsonRequest('/api/figure/render', token, {
    method: 'POST',
    body: JSON.stringify({
      sessionId,
      script,
      language: 'python',
      editLog: [legacyPatch],
    }),
  });
  assert(replayed.response.ok && replayed.data?.status === 'success', `persisted legacy editLog was rejected: ${JSON.stringify(replayed.data)}`);
  assert(replayed.data?.sessionId === sessionId, `legacy replay replaced the existing session: ${JSON.stringify(replayed.data)}`);
  assert(readSessionCount() === beforeSessionCount, 'legacy replay created a duplicate standalone session');
  assertManifestPatchValue(replayed.data?.manifest, legacyPatch, 'legacy standalone replay');
  assertEditLogHasPatch(readStandaloneState(sessionId)?.editLog, legacyPatch, 'persisted legacy standalone session');

  const unsafeGidOnlyPatch = {
    gid: line.id,
    prop: 'color',
    value: '#aa0055',
    mode: 'backend_patch',
  };
  writeStandaloneEditLog(sessionId, [unsafeGidOnlyPatch]);
  const beforeUnsafeReplay = readStandaloneState(sessionId);
  const rejectedUnsafeReplay = await jsonRequest('/api/figure/render', token, {
    method: 'POST',
    body: JSON.stringify({
      sessionId,
      script,
      language: 'python',
      editLog: [unsafeGidOnlyPatch],
    }),
  });
  assert(
    rejectedUnsafeReplay.response.ok && rejectedUnsafeReplay.data?.status === 'conflict',
    `gid-only persisted special-axes edit was treated as safe legacy identity: ${JSON.stringify(rejectedUnsafeReplay.data)}`,
  );
  assert(
    JSON.stringify(readStandaloneState(sessionId)) === JSON.stringify(beforeUnsafeReplay),
    'rejected gid-only legacy replay changed the existing session',
  );
}

function assertNoRejectedPersistenceLeak(state, rejected, baselineRevision) {
  assert(state.session, 'DB session row is missing');
  assert(state.figure, 'DB project figure row is missing');
  assert(Number(state.session.revision) === baselineRevision, `DB session revision changed after rejected patch: ${JSON.stringify(state.session)}`);
  assert(Number(state.figure.revision) === baselineRevision, `DB project figure revision changed after rejected patch: ${JSON.stringify(state.figure)}`);
  assertNoRejectedTriplet('DB session editLog', state.session.editLog, rejected);
  assertNoRejectedTriplet('DB project figure editLog', state.figure.editLog, rejected);
  assertNoRejectedTriplet('DB project figure history', state.figure.history, rejected);
  assertNoRejectedTriplet('DB project preview manifest', state.figure.manifest, rejected);
  assertJsonDoesNotContainRejectedValue('DB project figure state', state, 'axesFamily":"3d');
}

function assertPersistenceStateUnchanged(before, after, label) {
  assert(
    JSON.stringify(after) === JSON.stringify(before),
    `${label} changed project, session, history, or preview state`,
  );
}

async function createProject(token) {
  const created = await jsonRequest('/api/projects', token, {
    method: 'POST',
    body: JSON.stringify({
      name: `Special axes persistence ${Date.now()}`,
      spec: { plot_type: 'custom', custom_script: script, script_language: 'python' },
    }),
  });
  assert(created.response.ok && created.data?.id, `project creation failed: ${JSON.stringify(created.data)}`);

  const rendered = await jsonRequest(`/api/projects/${created.data.id}/figures/render`, token, {
    method: 'POST',
    body: JSON.stringify({
      script,
      editLogs: { fig_1: [] },
      language: 'python',
      requestId: `special-axes-render-${Date.now()}`,
    }),
  });
  assert(rendered.response.ok && rendered.data?.status === 'success', `initial render failed: ${JSON.stringify(rendered.data)}`);
  const figure = rendered.data.figures?.find(item => item.figureId === 'fig_1');
  assert(figure?.manifest?.objects?.length > 0, 'initial render returned no manifest objects');
  return { projectId: created.data.id, figure };
}

async function verifyProjectRenderRejectsInvalidEditLog(token, projectId, line) {
  const before = readPersistenceState(projectId);
  const rejectedScript = script.replace(
    'ax.set_title("Special axes persistence")',
    'ax.set_title("Rejected project render script")',
  );
  assert(rejectedScript !== script, 'project render rejection fixture did not change the script');
  const validPatch = {
    op: 'set',
    mode: 'backend_patch',
    gid: line.id,
    prop: 'linewidth',
    value: 4.5,
    ...identityFields(line),
  };
  const missingRelationPatch = {
    op: 'set',
    mode: 'backend_patch',
    gid: line.id,
    prop: 'linestyle',
    value: '--',
    stableKey: line.stableKey,
    fingerprint: line.fingerprint,
    fingerprintVersion: line.fingerprintVersion,
  };
  const rejected = await jsonRequest(`/api/projects/${projectId}/figures/render`, token, {
    method: 'POST',
    body: JSON.stringify({
      script: rejectedScript,
      language: 'python',
      editLogs: { fig_1: [validPatch, missingRelationPatch] },
      requestId: `special-axes-rejected-render-${Date.now()}`,
    }),
  });
  assert(rejected.response.ok && rejected.data?.status === 'conflict', `project render accepted rejected editLog: ${JSON.stringify(rejected.data)}`);
  assert(
    rejected.data?.warnings?.some(warning => warning?.type === 'identity_mismatch' && warning?.gid === line.id),
    `project render rejection did not report identity_mismatch: ${JSON.stringify(rejected.data)}`,
  );
  assertPersistenceStateUnchanged(before, readPersistenceState(projectId), 'project render rejection');
}

async function verifyProjectPatchRejectsPreexistingUnsafeEditLog(token) {
  const created = await createProject(token);
  const projectId = created.projectId;
  try {
    const baselineRevision = Number(created.figure.revision || 1);
    const { line } = findPolarTargets(created.figure.manifest);
    const unsafePersistedPatch = {
      gid: line.id,
      prop: 'color',
      value: '#aa0055',
      mode: 'backend_patch',
    };
    writeProjectFigureEditLog(projectId, [unsafePersistedPatch]);
    const before = readPersistenceState(projectId);
    const validPatch = {
      op: 'set',
      mode: 'backend_patch',
      gid: line.id,
      prop: 'linewidth',
      value: 2.75,
      ...identityFields(line),
    };
    const rejected = await submitPatchBatch(
      token,
      projectId,
      [validPatch],
      'reject-preexisting-unsafe-editlog',
      baselineRevision,
    );
    assert(
      rejected?.status === 'conflict',
      `project patch accepted pre-existing unsafe special-axes editLog: ${JSON.stringify(rejected)}`,
    );
    assert(
      rejected?.warnings?.some(warning => warning?.type === 'identity_mismatch' && warning?.gid === line.id),
      `pre-existing unsafe editLog rejection did not report identity_mismatch: ${JSON.stringify(rejected)}`,
    );
    assertPersistenceStateUnchanged(
      before,
      readPersistenceState(projectId),
      'pre-existing unsafe project patch rejection',
    );
  } finally {
    await jsonRequest(`/api/projects/${projectId}`, token, { method: 'DELETE' }).catch(() => null);
  }
}

async function verifyProjectRenderUsesDurableLegacyEditLog(token) {
  const created = await createProject(token);
  const projectId = created.projectId;
  try {
    const { line } = findPolarTargets(created.figure.manifest);
    const title = created.figure.manifest?.objects?.find(item => item.id === 'title.0');
    const axisY = created.figure.manifest?.objects?.find(item => item.id === 'axis.y.0');
    assert(title && axisY, 'durable legacy fixture is missing title.0 or axis.y.0');
    const legacyPatch = {
      gid: line.id,
      prop: 'color',
      value: '#00aa55',
      mode: 'backend_patch',
      stableKey: line.stableKey,
      fingerprint: line.fingerprint,
      fingerprintVersion: line.fingerprintVersion,
      identity: { seriesKey: line.identity?.seriesKey },
    };
    const disappearingTitlePatch = {
      gid: title.id,
      prop: 'text',
      value: '',
      mode: 'backend_patch',
    };
    const legacyAxisFontPatch = {
      gid: axisY.id,
      prop: 'fontweight',
      value: 'bold',
      mode: 'backend_patch',
      ...identityFields(axisY),
    };
    const legacyPatches = [legacyPatch, disappearingTitlePatch, legacyAxisFontPatch];
    writeProjectFigureOnlyEditLog(projectId, legacyPatches);

    const replayed = await jsonRequest(`/api/projects/${projectId}/figures/render`, token, {
      method: 'POST',
      body: JSON.stringify({
        script,
        language: 'python',
        editLogs: { fig_1: legacyPatches },
        requestId: `special-axes-durable-legacy-${Date.now()}`,
      }),
    });
    assert(
      replayed.response.ok && replayed.data?.status === 'success',
      `project render rejected the durable legacy editLog fallback: ${JSON.stringify(replayed.data)}`,
    );
    const figure = replayed.data.figures?.find(item => item.figureId === 'fig_1');
    assertManifestPatchValue(figure?.manifest, legacyPatch, 'durable legacy project render');
    assert(
      !figure?.manifest?.objects?.some(item => item.id === title.id && item.currentProps?.text),
      'empty persisted title should remain removed after replay',
    );
    const renderedAxisY = figure?.manifest?.objects?.find(item => item.id === axisY.id);
    assert(
      String(renderedAxisY?.currentProps?.tick_fontweight).toLowerCase() === 'bold',
      `legacy axis fontweight did not map to tick_fontweight: ${JSON.stringify(renderedAxisY?.currentProps)}`,
    );

    const forgedPatch = { ...legacyPatch, stableKey: `${line.stableKey}:forged` };
    const beforeForgedLine = readPersistenceState(projectId);
    const rejected = await jsonRequest(`/api/projects/${projectId}/figures/render`, token, {
      method: 'POST',
      body: JSON.stringify({
        script,
        language: 'python',
        editLogs: { fig_1: [disappearingTitlePatch, legacyAxisFontPatch, forgedPatch] },
        requestId: `special-axes-durable-forged-${Date.now()}`,
      }),
    });
    assert(
      rejected.response.ok && rejected.data?.status === 'conflict',
      `project render accepted a forged durable legacy identity: ${JSON.stringify(rejected.data)}`,
    );
    assertPersistenceStateUnchanged(
      beforeForgedLine,
      readPersistenceState(projectId),
      'forged durable legacy line rejection',
    );

    const forgedDisappearingPatch = {
      ...disappearingTitlePatch,
      stableKey: `${title.stableKey}:forged`,
      identity: { semanticKey: 'forged-disappearing-title' },
    };
    const beforeForgedDisappearing = readPersistenceState(projectId);
    const rejectedDisappearing = await jsonRequest(`/api/projects/${projectId}/figures/render`, token, {
      method: 'POST',
      body: JSON.stringify({
        script,
        language: 'python',
        editLogs: { fig_1: [forgedDisappearingPatch, legacyAxisFontPatch, legacyPatch] },
        requestId: `special-axes-durable-forged-disappearing-${Date.now()}`,
      }),
    });
    assert(
      rejectedDisappearing.response.ok && rejectedDisappearing.data?.status === 'conflict',
      `project render accepted forged identity metadata for a disappearing legacy edit: ${JSON.stringify(rejectedDisappearing.data)}`,
    );
    assertPersistenceStateUnchanged(
      beforeForgedDisappearing,
      readPersistenceState(projectId),
      'forged disappearing legacy edit rejection',
    );

    const weakenedAxisFontPatch = {
      gid: legacyAxisFontPatch.gid,
      prop: legacyAxisFontPatch.prop,
      value: legacyAxisFontPatch.value,
      mode: 'backend_patch',
    };
    const beforeWeakenedAxisFont = readPersistenceState(projectId);
    const rejectedWeakenedAxisFont = await jsonRequest(`/api/projects/${projectId}/figures/render`, token, {
      method: 'POST',
      body: JSON.stringify({
        script,
        language: 'python',
        editLogs: { fig_1: [disappearingTitlePatch, weakenedAxisFontPatch, legacyPatch] },
        requestId: `special-axes-durable-weakened-axis-font-${Date.now()}`,
      }),
    });
    assert(
      rejectedWeakenedAxisFont.response.ok && rejectedWeakenedAxisFont.data?.status === 'conflict',
      `project render accepted a weakened identity for a known legacy axis font edit: ${JSON.stringify(rejectedWeakenedAxisFont.data)}`,
    );
    assertPersistenceStateUnchanged(
      beforeWeakenedAxisFont,
      readPersistenceState(projectId),
      'weakened legacy axis font rejection',
    );
  } finally {
    await jsonRequest(`/api/projects/${projectId}`, token, { method: 'DELETE' }).catch(() => null);
  }
}

function findPolarTargets(manifest) {
  const objects = manifest?.objects || [];
  const polar = objects.find(object => object.id === 'polar_subplot.0');
  assert(polar, `manifest is missing polar_subplot.0: ${JSON.stringify(objects.map(object => ({ id: object.id, kind: object.kind, role: object.role })))}`);
  assert(polar.kind === 'polar_subplot', `polar panel kind drifted: ${JSON.stringify(polar)}`);
  assert(polar.role === 'polar_subplot_panel', `polar panel role drifted: ${JSON.stringify(polar)}`);
  assert(polar.currentProps?.projection === 'polar', `polar panel projection is incomplete: ${JSON.stringify(polar.currentProps)}`);

  const relation = polar.identity?.relation || {};
  assert(relation.axesFamily === 'polar', `polar relation axesFamily is incomplete: ${JSON.stringify(relation)}`);
  assert(relation.projection === 'polar', `polar relation projection is incomplete: ${JSON.stringify(relation)}`);
  for (const field of ['parentSubplotId', 'ownerSubplotId']) {
    assert(typeof relation[field] === 'string' && relation[field], `polar relation missing ${field}: ${JSON.stringify(relation)}`);
  }
  const editable = new Set(polar.editable || []);
  const capabilityProps = new Set((polar.propertyCapabilities || []).map(capability => capability?.prop));
  for (const prop of UNSAFE_LAYOUT_PROPS) {
    assert(!editable.has(prop), `polar panel exposes layout prop through editable: ${prop}`);
    assert(!capabilityProps.has(prop), `polar panel exposes layout prop through propertyCapabilities: ${prop}`);
  }

  const line = objects.find(object => object.id === 'line.0.0' && object.kind === 'line' && object.editable?.includes('linestyle'))
    || objects.find(object => object.kind === 'line' && String(object.id || '').startsWith('line.') && object.editable?.includes('linestyle'));
  assert(line?.id, `manifest has no editable polar data-line style target: ${JSON.stringify(objects.map(object => ({ id: object.id, kind: object.kind, editable: object.editable })))}`);
  const lineRelation = line.identity?.relation || {};
  assert(lineRelation.axesFamily === 'polar' && lineRelation.projection === 'polar', `line target lacks polar relation identity: ${JSON.stringify(line)}`);
  return { polar, line };
}

async function submitPatchBatch(token, projectId, patches, label, baseRevision) {
  const result = await jsonRequest('/api/figure/patch', token, {
    method: 'POST',
    body: JSON.stringify({
      sessionId: `${projectId}_fig_1`,
      projectId,
      figureId: 'fig_1',
      requestId: `special-axes-${label}-${Date.now()}-${Math.random().toString(36).slice(2)}`,
      baseRevision,
      patches,
    }),
  });
  assert(result.response.ok, `${label} patch request failed at HTTP layer: ${result.response.status} ${JSON.stringify(result.data)}`);
  return result.data;
}

async function assertProjectRefreshHasPatch(token, projectId, patch, expectedRevision) {
  const loaded = await jsonRequest(`/api/projects/${projectId}`, token);
  assert(loaded.response.ok && loaded.data?.status === 'success', `project load failed: ${JSON.stringify(loaded.data)}`);
  const loadedFigure = loaded.data.project?.figures?.find(item => item.figureId === 'fig_1');
  assert(Number(loadedFigure?.revision) === expectedRevision, `project load revision mismatch: ${JSON.stringify(loadedFigure)}`);
  assertEditLogHasPatch(loadedFigure?.editLog, patch, 'project load');

  const listing = await jsonRequest(`/api/projects/${projectId}/figures?includePreview=1`, token);
  assert(listing.response.ok && listing.data?.status === 'success', `project preview listing failed: ${JSON.stringify(listing.data)}`);
  const listedFigure = listing.data.figures?.find(item => item.figureId === 'fig_1');
  assert(Number(listedFigure?.revision) === expectedRevision, `project preview listing revision mismatch: ${JSON.stringify(listedFigure)}`);
  assertManifestPatchValue(listedFigure?.manifest, patch, 'project preview listing');

  const stored = readPersistenceState(projectId);
  assert(Number(stored.session?.revision) === expectedRevision, `DB session did not advance to ${expectedRevision}: ${JSON.stringify(stored.session)}`);
  assert(Number(stored.figure?.revision) === expectedRevision, `DB project figure did not advance to ${expectedRevision}: ${JSON.stringify(stored.figure)}`);
  assertEditLogHasPatch(stored.session?.editLog, patch, 'DB session');
  assertEditLogHasPatch(stored.figure?.editLog, patch, 'DB project figure');
  assertManifestPatchValue(stored.figure?.manifest, patch, 'DB project preview cache');
}

async function main() {
  assertIsolatedEnvironment();
  const token = await register();
  let projectId = null;

  try {
    await verifyStandaloneMissingRelationRejection(token);
    await verifyStandaloneRenderRejectsInvalidEditLog(token);
    await verifyStandaloneRenderKeepsPersistedLegacyEditLog(token);
    await verifyProjectPatchRejectsPreexistingUnsafeEditLog(token);
    await verifyProjectRenderUsesDurableLegacyEditLog(token);
    const created = await createProject(token);
    projectId = created.projectId;
    const baselineRevision = Number(created.figure.revision || 1);
    const { line } = findPolarTargets(created.figure.manifest);
    await verifyProjectRenderRejectsInvalidEditLog(token, projectId, line);

    const badIdentity = clone(line.identity);
    badIdentity.relation.axesFamily = '3d';
    const rejectedPatch = {
      op: 'set',
      mode: 'backend_patch',
      gid: line.id,
      prop: 'linestyle',
      value: '--',
      stableKey: line.stableKey,
      fingerprint: line.fingerprint,
      fingerprintVersion: line.fingerprintVersion,
      identity: badIdentity,
    };
    const rejected = await submitPatchBatch(token, projectId, [rejectedPatch], 'reject-axes-family-drift', baselineRevision);
    assert(rejected?.status === 'conflict', `axes-family drift patch should be rejected: ${JSON.stringify(rejected)}`);
    assert(Number(rejected?.revision) === baselineRevision, `rejected patch changed response revision: ${JSON.stringify(rejected)}`);
    assert(Array.isArray(rejected?.applied) && rejected.applied.length === 0, `rejected patch applied edits: ${JSON.stringify(rejected)}`);
    assert(Array.isArray(rejected?.rejected) && rejected.rejected.some(entry => patchTripletMatches(entry, rejectedPatch)), `response did not identify rejected patch: ${JSON.stringify(rejected)}`);
    assertNoRejectedTriplet('rejected response editLog', rejected.editLog || [], rejectedPatch);
    assertNoRejectedTriplet('rejected response manifest', rejected.manifest || {}, rejectedPatch);

    const afterRejectedState = readPersistenceState(projectId);
    assertNoRejectedPersistenceLeak(afterRejectedState, rejectedPatch, baselineRevision);
    const loadedAfterRejected = await jsonRequest(`/api/projects/${projectId}`, token);
    const figureAfterRejected = loadedAfterRejected.data?.project?.figures?.find(item => item.figureId === 'fig_1');
    assert(Number(figureAfterRejected?.revision) === baselineRevision, `project API revision advanced after rejected patch: ${JSON.stringify(figureAfterRejected)}`);
    assertNoRejectedTriplet('project API editLog after rejected patch', figureAfterRejected?.editLog || [], rejectedPatch);
    assertNoRejectedTriplet('project API history after rejected patch', figureAfterRejected?.history || {}, rejectedPatch);

    const missingRelationPatch = {
      op: 'set',
      mode: 'backend_patch',
      gid: line.id,
      prop: 'linestyle',
      value: '--',
      stableKey: line.stableKey,
      fingerprint: line.fingerprint,
      fingerprintVersion: line.fingerprintVersion,
    };
    const beforeMissingRelation = readPersistenceState(projectId);
    const missingRelation = await submitPatchBatch(
      token,
      projectId,
      [missingRelationPatch],
      'reject-missing-relation',
      baselineRevision,
    );
    assert(missingRelation?.status === 'conflict', `missing special-axes relation should be rejected: ${JSON.stringify(missingRelation)}`);
    assert(Number(missingRelation?.revision) === baselineRevision, `missing-relation patch changed response revision: ${JSON.stringify(missingRelation)}`);
    assert(Array.isArray(missingRelation?.applied) && missingRelation.applied.length === 0, `missing-relation patch applied edits: ${JSON.stringify(missingRelation)}`);
    assert(
      missingRelation?.warnings?.some(warning => warning?.type === 'identity_mismatch' && warning?.gid === line.id),
      `missing-relation rejection did not report identity_mismatch: ${JSON.stringify(missingRelation)}`,
    );
    assertPersistenceStateUnchanged(
      beforeMissingRelation,
      readPersistenceState(projectId),
      'missing-relation patch rejection',
    );

    const validMixedPatch = {
      op: 'set',
      mode: 'backend_patch',
      gid: line.id,
      prop: 'linewidth',
      value: 3.75,
      ...identityFields(line),
    };
    const missingRelationMixedPatch = {
      ...missingRelationPatch,
      value: '-.',
    };
    const beforeMixedRejection = readPersistenceState(projectId);
    const mixedRejected = await submitPatchBatch(
      token,
      projectId,
      [validMixedPatch, missingRelationMixedPatch],
      'reject-mixed-missing-relation',
      baselineRevision,
    );
    assert(mixedRejected?.status === 'conflict', `mixed batch with missing relation should be rejected: ${JSON.stringify(mixedRejected)}`);
    assert(Number(mixedRejected?.revision) === baselineRevision, `mixed rejection changed response revision: ${JSON.stringify(mixedRejected)}`);
    assert(Array.isArray(mixedRejected?.applied) && mixedRejected.applied.length === 0, `mixed rejection applied edits: ${JSON.stringify(mixedRejected)}`);
    assertPersistenceStateUnchanged(
      beforeMixedRejection,
      readPersistenceState(projectId),
      'mixed missing-relation rejection',
    );

    const validPatch = {
      op: 'set',
      mode: 'backend_patch',
      gid: line.id,
      prop: 'linestyle',
      value: ':',
      ...identityFields(line),
    };
    const applied = await submitPatchBatch(token, projectId, [validPatch], 'valid-style', baselineRevision);
    assert(applied?.status === 'success', `valid polar style patch failed: ${JSON.stringify(applied)}`);
    assert(Number(applied?.revision) === baselineRevision + 1, `valid patch revision mismatch: ${JSON.stringify(applied)}`);
    assertEditLogHasPatch(applied.editLog, validPatch, 'valid response');
    assertManifestPatchValue(applied.manifest, validPatch, 'valid response');
    await assertProjectRefreshHasPatch(token, projectId, validPatch, baselineRevision + 1);

    const exported = await jsonRequest(`/api/projects/${projectId}/export`, token, {
      method: 'POST',
      body: JSON.stringify({ figureId: 'fig_1', format: 'svg', dpi: 150, saveToLibrary: true }),
    });
    assert(exported.response.ok && exported.data?.status === 'success', `special axes export failed: ${JSON.stringify(exported.data)}`);
    const asset = exported.data.figures?.[0]?.asset;
    assert(asset?.assetId && asset.hasEditingSnapshot === true, `special axes export missing editing snapshot: ${JSON.stringify(asset)}`);

    const snapshotDb = new Database(process.env.SCIFIGURE_DB_PATH);
    let originalSnapshotJson = '';
    let originalSnapshotHash = '';
    try {
      snapshotDb.pragma('busy_timeout = 5000');
      const stored = snapshotDb.prepare(`
        SELECT snapshot_json, snapshot_hash
        FROM export_asset_snapshots
        WHERE asset_id = ?
      `).get(asset.assetId);
      assert(stored?.snapshot_json && stored?.snapshot_hash, 'special axes export snapshot row is missing');
      originalSnapshotJson = stored.snapshot_json;
      originalSnapshotHash = stored.snapshot_hash;
      const tampered = JSON.parse(stored.snapshot_json);
      const lineEdit = tampered.figures?.[0]?.editLog?.find(entry => patchTripletMatches(entry, validPatch));
      assert(lineEdit?.identity?.relation, `special axes snapshot edit has no relation identity: ${stored.snapshot_json}`);
      lineEdit.identity.relation.axesFamily = '3d';
      const tamperedJson = JSON.stringify(tampered);
      const tamperedHash = crypto.createHash('sha256').update(tamperedJson).digest('hex');
      snapshotDb.prepare(`
        UPDATE export_asset_snapshots
        SET snapshot_json = ?, snapshot_hash = ?
        WHERE asset_id = ?
      `).run(tamperedJson, tamperedHash, asset.assetId);
    } finally {
      snapshotDb.close();
    }

    const beforeSnapshotRejection = JSON.stringify(readPersistenceState(projectId));
    const rejectedRestore = await jsonRequest(
      `/api/projects/${projectId}/export-assets/${asset.assetId}/restore`,
      token,
      { method: 'POST' },
    );
    assert(
      rejectedRestore.response.status === 409
        && rejectedRestore.data?.code === 'EXPORT_SNAPSHOT_REPLAY_REJECTED',
      `special axes relation drift snapshot was not rejected: ${JSON.stringify(rejectedRestore.data)}`,
    );
    assert(
      rejectedRestore.data?.issues?.some(issue => (
        issue.type === 'identity_mismatch' && issue.gid === line.id
      )),
      `special axes snapshot rejection did not report identity_mismatch: ${JSON.stringify(rejectedRestore.data?.issues)}`,
    );
    assert(
      JSON.stringify(readPersistenceState(projectId)) === beforeSnapshotRejection,
      'rejected special axes snapshot changed project, session, history, or preview state',
    );

    const missingRelationSnapshotDb = new Database(process.env.SCIFIGURE_DB_PATH);
    try {
      missingRelationSnapshotDb.pragma('busy_timeout = 5000');
      const missingRelationSnapshot = JSON.parse(originalSnapshotJson);
      const missingRelationEdit = missingRelationSnapshot.figures?.[0]?.editLog?.find(entry => patchTripletMatches(entry, validPatch));
      assert(missingRelationEdit?.identity?.relation, `special axes snapshot edit has no removable relation: ${originalSnapshotJson}`);
      delete missingRelationEdit.identity.relation;
      const missingRelationJson = JSON.stringify(missingRelationSnapshot);
      const missingRelationHash = crypto.createHash('sha256').update(missingRelationJson).digest('hex');
      missingRelationSnapshotDb.prepare(`
        UPDATE export_asset_snapshots
        SET snapshot_json = ?, snapshot_hash = ?
        WHERE asset_id = ?
      `).run(missingRelationJson, missingRelationHash, asset.assetId);
    } finally {
      missingRelationSnapshotDb.close();
    }

    const beforeMissingSnapshotRejection = JSON.stringify(readPersistenceState(projectId));
    const rejectedMissingRelationRestore = await jsonRequest(
      `/api/projects/${projectId}/export-assets/${asset.assetId}/restore`,
      token,
      { method: 'POST' },
    );
    assert(
      rejectedMissingRelationRestore.response.status === 409
        && rejectedMissingRelationRestore.data?.code === 'EXPORT_SNAPSHOT_REPLAY_REJECTED',
      `v3 snapshot without special-axes relation was not rejected: ${JSON.stringify(rejectedMissingRelationRestore.data)}`,
    );
    assert(
      rejectedMissingRelationRestore.data?.issues?.some(issue => (
        issue.type === 'identity_mismatch' && issue.gid === line.id
      )),
      `missing-relation snapshot rejection did not report identity_mismatch: ${JSON.stringify(rejectedMissingRelationRestore.data?.issues)}`,
    );
    assert(
      JSON.stringify(readPersistenceState(projectId)) === beforeMissingSnapshotRejection,
      'rejected missing-relation snapshot changed project, session, history, or preview state',
    );

    const laterPatch = {
      op: 'set',
      mode: 'backend_patch',
      gid: line.id,
      prop: 'linestyle',
      value: '-.',
      ...identityFields(line),
    };
    const laterApplied = await submitPatchBatch(token, projectId, [laterPatch], 'later-valid-style', baselineRevision + 1);
    assert(laterApplied?.status === 'success', `later valid polar style patch failed: ${JSON.stringify(laterApplied)}`);
    assert(Number(laterApplied?.revision) === baselineRevision + 2, `later patch revision mismatch: ${JSON.stringify(laterApplied)}`);
    assertEditLogHasPatch(laterApplied.editLog, laterPatch, 'later valid response');
    assertManifestPatchValue(laterApplied.manifest, laterPatch, 'later valid response');
    await assertProjectRefreshHasPatch(token, projectId, laterPatch, baselineRevision + 2);

    const legacySnapshotDb = new Database(process.env.SCIFIGURE_DB_PATH);
    try {
      legacySnapshotDb.pragma('busy_timeout = 5000');
      const legacySnapshot = JSON.parse(originalSnapshotJson);
      legacySnapshot.schemaVersion = 2;
      const legacyEdit = legacySnapshot.figures?.[0]?.editLog?.find(entry => patchTripletMatches(entry, validPatch));
      assert(
        legacyEdit?.stableKey && legacyEdit?.fingerprintVersion === 2 && legacyEdit?.fingerprint,
        `legacy compatibility fixture lacks strong identity: ${originalSnapshotJson}`,
      );
      delete legacyEdit.identity.relation;
      const legacyJson = JSON.stringify(legacySnapshot);
      const legacyHash = crypto.createHash('sha256').update(legacyJson).digest('hex');
      legacySnapshotDb.prepare(`
        UPDATE export_asset_snapshots
        SET schema_version = 2, snapshot_json = ?, snapshot_hash = ?
        WHERE asset_id = ?
      `).run(legacyJson, legacyHash, asset.assetId);
    } finally {
      legacySnapshotDb.close();
    }

    const restored = await jsonRequest(
      `/api/projects/${projectId}/export-assets/${asset.assetId}/restore`,
      token,
      { method: 'POST' },
    );
    assert(restored.response.ok && restored.data?.status === 'success', `special axes snapshot restore failed: ${JSON.stringify(restored.data)}`);
    const projectAfterRestore = await jsonRequest(`/api/projects/${projectId}`, token);
    const restoredFigure = projectAfterRestore.data?.project?.figures?.find(item => item.figureId === 'fig_1');
    assertEditLogHasPatch(restoredFigure?.editLog, validPatch, 'restored special axes editLog');
    assertNoRejectedTriplet('restored current editLog', restoredFigure?.editLog || [], laterPatch);
    assertEditLogHasPatch(restoredFigure?.history?.past?.at(-1)?.editLog, laterPatch, 'restore history checkpoint');

    const regenerated = await jsonRequest(`/api/projects/${projectId}/figures?includePreview=1`, token);
    assert(regenerated.response.ok && regenerated.data?.status === 'success', `restored special axes preview regeneration failed: ${JSON.stringify(regenerated.data)}`);
    const regeneratedFigure = regenerated.data.figures?.find(item => item.figureId === 'fig_1');
    assertManifestPatchValue(regeneratedFigure?.manifest, validPatch, 'regenerated restored preview');
    findPolarTargets(regeneratedFigure?.manifest);

    console.log(JSON.stringify({
      status: 'PASS',
      projectId,
      lineGid: line.id,
      checked: [
        'polar_subplot.0 exists with complete polar relation identity',
        'polar panel layout props are absent from editable and capability surfaces',
        'polar line linestyle is editable',
        'axesFamily drift with copied identity is rejected without revision, editLog, history, or preview-cache leakage',
        'missing special-axes relation is rejected without revision, editLog, history, or preview-cache leakage',
        'standalone special-axes patches require renderer-confirmed relation identity before persistence',
        'standalone full render rejects mixed editLogs when renderer rejects one entry and writes no session',
        'standalone full render reuses its session and keeps already-persisted legacy editLogs readable',
        'persisted gid-only special-axes logs remain blocked without a matching stable identity',
        'project patch rejects a pre-existing unsafe special-axes editLog before advancing revision',
        'project full render rejects mixed editLogs before script, Figure, session, history, or preview persistence',
        'mixed batches roll back valid siblings when one special-axes relation is missing',
        'valid identity-bearing linestyle patch persists across project and preview refresh',
        'tampered special-axes export snapshot is rejected without persistence leakage',
        'v3 snapshot with removed relation is rejected without persistence leakage',
        'v2 snapshot with matching stableKey and v2 fingerprint remains restorable',
        'legacy-compatible export snapshot restores the special-axis style and checkpoints newer edits',
      ],
    }, null, 2));
  } finally {
    if (projectId) {
      await jsonRequest(`/api/projects/${projectId}`, token, { method: 'DELETE' }).catch(() => null);
    }
  }
}

main().catch(error => {
  console.error(JSON.stringify({ status: 'FAIL', message: error.stack || error.message }, null, 2));
  process.exitCode = 1;
});
