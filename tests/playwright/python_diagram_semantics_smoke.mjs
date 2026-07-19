import { chromium } from 'playwright';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  authenticateCapabilitySmokeUser,
  bearerHeaders,
  installBrowserAuthentication,
} from './smokeAuth.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '../..');
const BASE_URL = process.env.SCIFIGURE_URL || '';
if (!BASE_URL) throw new Error('SCIFIGURE_URL is required; run through scripts/testing/run_with_isolated_server.mjs');
const FIXTURE_PATH = path.join(ROOT, 'tests/fixtures/capability_matrix/python/network_path_sem.py');
const SCRIPT = fs.readFileSync(FIXTURE_PATH, 'utf8');
const TEST_PROJECT_PREFIX = 'Python diagram semantics smoke';
const APP_STATE_KEY = 'scifigure:app-state:v2';

let authToken = '';
const apiRequests = [];
const consoleErrors = [];
const pageErrors = [];

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function assertIsolatedEnvironment() {
  assert(process.env.SCIFIGURE_TEST_ISOLATED === '1', 'test must run under scripts/testing/run_with_isolated_server.mjs');
  const url = new URL(BASE_URL);
  assert(url.hostname === '127.0.0.1', `test must target isolated 127.0.0.1 server, got ${BASE_URL}`);
  assert(url.port !== '3000', 'test refuses localhost:3000/default port');

  const dataDir = process.env.SCIFIGURE_DATA_DIR || '';
  const dbPath = process.env.SCIFIGURE_DB_PATH || '';
  const resolvedData = path.resolve(dataDir);
  const resolvedDb = path.resolve(dbPath);
  assert(dataDir && path.basename(path.dirname(resolvedData)).startsWith('scifigure-isolated-smoke-'), `unsafe data dir: ${dataDir}`);
  assert(dbPath && resolvedDb.startsWith(`${resolvedData}${path.sep}`), `unsafe db path: ${dbPath}`);
}

function isIgnorableDevServerNoise(message) {
  return message.includes('[vite] failed to connect to websocket')
    || /WebSocket connection to 'ws:\/\/(?:localhost|127\.0\.0\.1):24678\//.test(message)
    || message.includes('WebSocket closed without opened');
}

function parseJson(value) {
  if (!value) return null;
  try {
    return JSON.parse(value);
  } catch {
    return null;
  }
}

function stableJson(value) {
  if (Array.isArray(value)) return value.map(stableJson);
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, item]) => [key, stableJson(item)]),
    );
  }
  return value;
}

function normalizeEditLog(editLog) {
  return (Array.isArray(editLog) ? editLog : []).map((entry) => stableJson({
    gid: entry.gid,
    prop: entry.prop,
    value: entry.value,
    mode: entry.mode,
    type: entry.type,
    stableKey: entry.stableKey,
    fingerprint: entry.fingerprint,
    fingerprintVersion: entry.fingerprintVersion,
    identity: entry.identity,
  }));
}

function editSignature(editLog) {
  return JSON.stringify(normalizeEditLog(editLog));
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

function exportSnapshotEditLog(editLog, manifest) {
  const previewGlobalProps = ['figure.width_in', 'figure.height_in', 'figure.dpi'];
  const explicitProps = new Set(
    (Array.isArray(editLog) ? editLog : [])
      .filter((entry) => entry.gid === 'global' && previewGlobalProps.includes(entry.prop))
      .map((entry) => entry.prop),
  );
  const recovered = previewGlobalProps.flatMap((prop) => {
    if (explicitProps.has(prop)) return [];
    const field = manifest?.globals?.[prop];
    const value = Number(field?.value);
    if (field?.type !== 'number' || !Number.isFinite(value)) return [];
    return [{ gid: 'global', prop, value, mode: 'backend_patch' }];
  });
  return [...(Array.isArray(editLog) ? editLog : []), ...recovered];
}

async function requestJson(pathname, options = {}) {
  const response = await fetch(`${BASE_URL}${pathname}`, {
    ...options,
    headers: {
      ...(options.body ? { 'Content-Type': 'application/json' } : {}),
      ...bearerHeaders(authToken),
      ...(options.headers || {}),
    },
  });
  const data = await response.json().catch(() => null);
  if (!response.ok) {
    throw new Error(`${options.method || 'GET'} ${pathname} failed: ${response.status} ${JSON.stringify(data)}`);
  }
  return data;
}

async function cleanupSmokeProjects() {
  const data = await requestJson('/api/projects');
  await Promise.all((data.projects || [])
    .filter((project) => String(project?.name || '').startsWith(TEST_PROJECT_PREFIX))
    .map((project) => requestJson(`/api/projects/${project.id || project.projectId}`, { method: 'DELETE' }).catch(() => null)));
}

async function createFixture() {
  const spec = {
    plot_type: 'custom',
    custom_script: SCRIPT,
    script: SCRIPT,
    script_language: 'python',
    figure: { width: 190, height: 90, unit: 'mm', dpi: 300 },
  };
  const created = await requestJson('/api/projects', {
    method: 'POST',
    body: JSON.stringify({ name: `${TEST_PROJECT_PREFIX} ${Date.now()}`, spec }),
  });
  const rendered = await requestJson(`/api/projects/${created.id}/figures/render`, {
    method: 'POST',
    body: JSON.stringify({
      script: SCRIPT,
      editLogs: { fig_1: [] },
      language: 'python',
      requestId: `python-diagram-ui-${Date.now()}`,
    }),
  });
  assert(rendered.status === 'success' && rendered.figures?.[0]?.manifest, `fixture render failed: ${JSON.stringify(rendered)}`);
  return { projectId: created.id, spec, rendered };
}

function findByRelation(objects, role, relationMatch = {}) {
  return objects.find((object) => {
    if (object.role !== role) return false;
    const relation = object.identity?.relation || {};
    return Object.entries(relationMatch).every(([key, value]) => relation[key] === value);
  });
}

function findDiagramObjects(manifest) {
  const objects = manifest?.objects || [];
  const latentNode = findByRelation(objects, 'diagram_node', { nodeId: 'latent_a' });
  const observedNode = findByRelation(objects, 'diagram_node', { nodeId: 'observed_b' });
  const edge = findByRelation(objects, 'diagram_edge', {
    edgeId: 'latent_a_to_observed_b',
    sourceNodeId: 'latent_a',
    targetNodeId: 'observed_b',
  });
  const arrow = findByRelation(objects, 'diagram_arrow', {
    edgeId: 'latent_a_to_observed_b',
    sourceNodeId: 'latent_a',
    targetNodeId: 'observed_b',
  });
  const latentLabel = findByRelation(objects, 'diagram_node_label', { nodeId: 'latent_a' });
  const observedLabel = findByRelation(objects, 'diagram_node_label', { nodeId: 'observed_b' });
  const coefficientLabel = findByRelation(objects, 'diagram_coefficient_label', { edgeId: 'latent_a_to_observed_b' });
  const fitAnnotation = findByRelation(objects, 'diagram_fit_annotation', {});

  const required = { latentNode, observedNode, edge, arrow, latentLabel, observedLabel, coefficientLabel, fitAnnotation };
  for (const [name, object] of Object.entries(required)) {
    assert(object, `missing ${name} semantic object`);
    const relation = object.identity?.relation || {};
    assert(relation.diagramId === 'sem.demo', `${name} lost diagramId: ${JSON.stringify(object)}`);
    assert(relation.diagramType === 'sem', `${name} lost diagramType: ${JSON.stringify(object)}`);
    assert(object.source?.callName === 'SciFigure.semantic_gid', `${name} lost trusted source call: ${JSON.stringify(object.source)}`);
    assert(object.semanticCoverage?.family === 'diagram' && object.semanticCoverage?.status === 'dedicated', `${name} lost dedicated coverage: ${JSON.stringify(object.semanticCoverage)}`);
    assert((object.propertyCapabilities || []).every((capability) => capability.patchMode === 'backend_patch'), `${name} exposes non-backend patch capability`);
  }

  assert(latentNode.id === 'patch.0.0', `latent node raw gid changed: ${latentNode.id}`);
  assert(observedNode.id === 'collection.0.0', `observed node raw gid changed: ${observedNode.id}`);
  assert(edge.id === 'line.0.0', `edge raw gid changed: ${edge.id}`);
  assert(arrow.id === 'patch.0.1', `arrow raw gid changed: ${arrow.id}`);
  assert(latentLabel.id === 'text.0.0', `latent label raw gid changed: ${latentLabel.id}`);
  assert(coefficientLabel.id === 'text.0.2', `coefficient label raw gid changed: ${coefficientLabel.id}`);
  assert(fitAnnotation.id === 'text.0.3', `fit annotation raw gid changed: ${fitAnnotation.id}`);
  assert(!coefficientLabel.editable?.includes('text'), 'coefficient label exposed protected text editing');
  assert(!fitAnnotation.editable?.includes('text'), 'fit annotation exposed protected text editing');

  const ordinary = objects.filter((object) => ['ordinary scatter', 'ordinary line', 'ordinary arrow'].includes(object.label) || object.id === 'text.1.0');
  assert(ordinary.length >= 4, `missing ordinary negative controls: ${JSON.stringify(ordinary)}`);
  for (const object of ordinary) {
    assert(!String(object.role || '').startsWith('diagram_'), `ordinary object got diagram role: ${JSON.stringify(object)}`);
    assert(!object.identity?.relation?.diagramId, `ordinary object got diagram relation: ${JSON.stringify(object)}`);
  }

  return required;
}

async function installFixtureState(page, fixture) {
  await page.evaluate(({ projectId, spec, rendered }) => {
    const projectFigures = {};
    rendered.figures.forEach((figure, index) => {
      projectFigures[figure.figureId] = {
        figureId: figure.figureId,
        index,
        manifest: figure.manifest,
        editLog: figure.editLog || [],
        revision: figure.revision || 1,
        svg: figure.svg,
        fingerprint: figure.fingerprint,
        codeSlice: figure.codeSlice || null,
        renderStatus: 'success',
      };
    });
    window.sessionStorage.setItem('scifigure:app-state:v2', JSON.stringify({
      spec,
      history: [spec],
      historyIndex: 0,
      projectId,
      projectName: 'Python diagram semantics smoke',
      projectFigures,
      activeFigureId: 'fig_1',
      selectedFigureIds: ['fig_1'],
      datasets: [],
      selectedGids: [],
      projectHistory: {},
      projectDrafts: {},
      currentView: 'workspace',
      subView: 'home',
      renderLog: ['> Python diagram fixture ready'],
      figSession: null,
    }));
  }, fixture);
  await page.reload({ waitUntil: 'networkidle', timeout: 30000 });
  await waitForWorkspaceReady(page);
}

async function getBodyText(page) {
  return (await page.textContent('body').catch(() => '')) || '';
}

async function waitForWorkspaceReady(page, timeoutMs = 90000) {
  const start = Date.now();
  let lastBody = '';
  while (Date.now() - start < timeoutMs) {
    const body = await getBodyText(page);
    lastBody = body;
    if (
      await page.locator('svg').count().catch(() => 0) > 0
      && body.includes('属性编辑')
      && !body.includes('正在恢复项目预览')
      && !body.includes('正在重新渲染当前图形')
    ) {
      return;
    }
    await page.waitForTimeout(500);
  }
  throw new Error(`workspace did not become ready: ${lastBody.slice(0, 600)}`);
}

async function openComponentCenter(page) {
  await page.getByRole('button', { name: '组件中心', exact: true }).click();
  await page.waitForTimeout(300);
}

function group(page, label) {
  return page.locator(`[data-component-group-label="${label}"]`).first();
}

async function selectedGids(page) {
  return page.evaluate((storageKey) => {
    const raw = window.sessionStorage.getItem(storageKey);
    const state = raw ? JSON.parse(raw) : {};
    return Array.isArray(state.selectedGids) ? state.selectedGids : [];
  }, APP_STATE_KEY);
}

async function selectObjectInGroup(page, label, gid) {
  const button = group(page, label).locator(`button[data-component-object-id="${gid}"]`).first();
  await button.waitFor({ state: 'visible', timeout: 30000 });
  await button.click();
  const start = Date.now();
  while (Date.now() - start < 5000) {
    const selected = await selectedGids(page);
    if (selected.length === 1 && selected[0] === gid) return;
    await page.waitForTimeout(100);
  }
  throw new Error(`failed to select ${gid} in ${label}: ${JSON.stringify(await selectedGids(page))}`);
}

async function setColorInGroup(page, label, value, suffix = ':color') {
  const input = group(page, label).locator([
    'input[data-color-role="text"][data-param-prop="color"]',
    `input[data-color-role="text"][data-color-scope$="${suffix}"]`,
  ].join(', ')).first();
  await input.waitFor({ state: 'visible', timeout: 30000 });
  await input.fill(value);
  await input.press('Enter').catch(() => {});
  await input.evaluate((node) => node.blur());
  await page.waitForTimeout(500);
}

async function setNumberInGroup(page, label, prop, value) {
  const input = group(page, label).locator(`input[data-param-role="number"][data-param-prop="${prop}"]`).first();
  await input.waitFor({ state: 'visible', timeout: 30000 });
  await input.fill(String(value));
  await input.press('Enter').catch(() => {});
  await input.evaluate((node) => node.blur());
  await page.waitForTimeout(500);
}

async function assertComponentGroups(page, diagram) {
  await openComponentCenter(page);
  const expected = new Map([
    ['图示节点', [diagram.latentNode.id, diagram.observedNode.id]],
    ['图示连线 / 路径', [diagram.edge.id]],
    ['图示箭头', [diagram.arrow.id]],
    ['图示节点标签', [diagram.latentLabel.id, diagram.observedLabel.id]],
    ['路径系数标签', [diagram.coefficientLabel.id]],
    ['模型拟合注释', [diagram.fitAnnotation.id]],
  ]);
  const entries = await page.locator('.scifig-editor-panel-right [data-component-group-label]').evaluateAll((nodes) => nodes.map((node) => ({
    label: node.getAttribute('data-component-group-label'),
    objectIds: Array.from(node.querySelectorAll('button[data-component-object-id]')).map((button) => button.getAttribute('data-component-object-id')),
  })));
  const byLabel = new Map(entries.map((entry) => [entry.label, entry.objectIds]));
  for (const [label, ids] of expected.entries()) {
    const actual = byLabel.get(label) || [];
    assert(JSON.stringify(actual.sort()) === JSON.stringify([...ids].sort()), `${label} objects mismatch: ${JSON.stringify(actual)}`);
  }

  const semanticIds = new Set([...expected.values()].flat());
  const appearances = new Map([...semanticIds].map((id) => [id, []]));
  for (const entry of entries) {
    for (const id of entry.objectIds) {
      if (appearances.has(id)) appearances.get(id).push(entry.label);
    }
  }
  for (const [id, labels] of appearances.entries()) {
    assert(labels.length === 1, `semantic gid ${id} appeared in duplicate/generic component groups: ${JSON.stringify(labels)}`);
  }
}

async function applyCurrentDraft(page, expectedPatchKeys) {
  const start = apiRequests.length;
  const responsePromise = page.waitForResponse((response) => (
    new URL(response.url()).pathname === '/api/figure/patch'
    && response.request().method() === 'POST'
  ), { timeout: 60000 });
  await page.getByRole('button', { name: '应用当前图', exact: true }).click();
  const response = await responsePromise;
  assert(response.ok(), `patch failed: ${response.status()}`);
  const data = await response.json();
  assert(data.status === 'success', `patch returned non-success status: ${JSON.stringify(data)}`);
  await waitForWorkspaceReady(page);
  const requests = apiRequests.slice(start).filter((request) => new URL(request.url).pathname === '/api/figure/patch');
  assert(requests.length === 1, `expected one patch request, got ${requests.length}`);
  const body = parseJson(requests[0].postData);
  const patches = body?.patches || [];
  const actualKeys = patches.map((patch) => `${patch.gid}:${patch.prop}`).sort();
  assert(JSON.stringify(actualKeys) === JSON.stringify([...expectedPatchKeys].sort()), `unexpected patch keys: ${JSON.stringify(patches)}`);
  assert(patches.every((patch) => patch.mode === 'backend_patch'), `diagram patches must be backend_patch only: ${JSON.stringify(patches)}`);
  return body;
}

async function readFigureState(page) {
  return page.evaluate((storageKey) => {
    const raw = window.sessionStorage.getItem(storageKey);
    const state = raw ? JSON.parse(raw) : {};
    const figure = state.projectFigures?.[state.activeFigureId || 'fig_1'];
    return {
      revision: figure?.revision || null,
      editLog: figure?.editLog || [],
      projectDrafts: state.projectDrafts || {},
      svg: figure?.svg || '',
      manifest: figure?.manifest || null,
    };
  }, APP_STATE_KEY);
}

function hasEdit(editLog, expected) {
  return Array.isArray(editLog) && editLog.some((entry) => (
    entry.gid === expected.gid
    && entry.prop === expected.prop
    && (
      typeof entry.value === 'string' && typeof expected.value === 'string'
        ? entry.value.toLowerCase() === expected.value.toLowerCase()
        : JSON.stringify(entry.value) === JSON.stringify(expected.value)
    )
    && entry.mode === (expected.mode || 'backend_patch')
  ));
}

async function waitForEdits(page, expectedEdits, timeoutMs = 60000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const state = await readFigureState(page);
    if (expectedEdits.every((edit) => hasEdit(state.editLog, edit))) return state;
    await page.waitForTimeout(500);
  }
  const state = await readFigureState(page);
  throw new Error(`edits not found in figure state: ${JSON.stringify({ expectedEdits, editLog: state.editLog })}`);
}

async function clickUndo(page) {
  const responsePromise = page.waitForResponse((response) => (
    new URL(response.url()).pathname.endsWith('/figures/render')
    && response.request().method() === 'POST'
  ), { timeout: 60000 });
  await page.getByRole('button', { name: '撤销', exact: true }).click();
  const response = await responsePromise;
  assert(response.ok(), `undo render failed: ${response.status()}`);
  await waitForWorkspaceReady(page);
  return response.json();
}

async function clickRedo(page) {
  const responsePromise = page.waitForResponse((response) => (
    new URL(response.url()).pathname.endsWith('/figures/render')
    && response.request().method() === 'POST'
  ), { timeout: 60000 });
  await page.getByRole('button', { name: '重做', exact: true }).click();
  const response = await responsePromise;
  assert(response.ok(), `redo render failed: ${response.status()}`);
  await waitForWorkspaceReady(page);
  return response.json();
}

async function saveCurrentProject(page) {
  const responsePromise = page.waitForResponse((response) => (
    response.request().method() === 'PUT'
    && /\/api\/projects\/[^/]+$/.test(new URL(response.url()).pathname)
  ), { timeout: 40000 });
  await page.getByRole('button', { name: /^保存$/ }).first().click();
  const response = await responsePromise;
  assert(response.ok(), `save failed: ${response.status()}`);
}

async function applyNodeLabelPositionPatch(page, projectId, nodeLabel) {
  const props = nodeLabel.currentProps || {};
  const currentX = Number(props.x);
  const currentY = Number(props.y);
  assert(Number.isFinite(currentX) && Number.isFinite(currentY), `node label has no editable numeric position: ${JSON.stringify(props)}`);
  const nextPosition = {
    x: Number((currentX + 0.035).toFixed(6)),
    y: Number((currentY + 0.045).toFixed(6)),
    coord_system: String(props.coord_system || 'data'),
  };
  const patch = {
    op: 'set',
    mode: 'backend_patch',
    gid: nodeLabel.id,
    prop: 'position',
    value: nextPosition,
    ...identityFields(nodeLabel),
  };
  const start = apiRequests.length;
  const data = await page.evaluate(async ({ storageKey, baseUrl, projectId: pid, patchItem }) => {
    const raw = window.sessionStorage.getItem(storageKey);
    const state = raw ? JSON.parse(raw) : {};
    const figureId = state.activeFigureId || 'fig_1';
    const figure = state.projectFigures?.[figureId] || {};
    const response = await fetch(`${baseUrl}/api/figure/patch`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        sessionId: `${pid}_${figureId}`,
        projectId: pid,
        figureId,
        patches: [patchItem],
        requestId: `python-diagram-position-${Date.now()}`,
        baseRevision: figure.revision || 1,
      }),
    });
    const payload = await response.json();
    if (!response.ok || payload.status !== 'success') {
      throw new Error(`position patch failed: ${response.status} ${JSON.stringify(payload)}`);
    }
    const nextState = {
      ...state,
      projectFigures: {
        ...(state.projectFigures || {}),
        [figureId]: {
          ...figure,
          svg: payload.svg || figure.svg,
          manifest: payload.manifest || figure.manifest,
          editLog: payload.editLog || figure.editLog || [],
          revision: payload.revision || figure.revision || 1,
          codeSlice: payload.codeSlice ?? figure.codeSlice ?? null,
          renderStatus: 'success',
          error: undefined,
        },
      },
    };
    window.sessionStorage.setItem(storageKey, JSON.stringify(nextState));
    return payload;
  }, { storageKey: APP_STATE_KEY, baseUrl: BASE_URL, projectId, patchItem: patch });
  assert(data.status === 'success', `position patch returned failure: ${JSON.stringify(data)}`);
  await page.reload({ waitUntil: 'networkidle', timeout: 30000 });
  await waitForWorkspaceReady(page);
  const requests = apiRequests.slice(start).filter((request) => new URL(request.url).pathname === '/api/figure/patch');
  assert(requests.length === 1, `expected one position patch request, got ${requests.length}`);
  const body = parseJson(requests[0].postData);
  const patches = body?.patches || [];
  assert(patches.length === 1 && patches[0].gid === nodeLabel.id && patches[0].prop === 'position', `unexpected position patches: ${JSON.stringify(patches)}`);
  assert(patches[0].mode === 'backend_patch', `position patch must be backend_patch: ${JSON.stringify(patches[0])}`);
  return patches[0];
}

function textObjectById(manifest, id) {
  return (manifest?.objects || []).find((object) => object.id === id);
}

async function main() {
  assertIsolatedEnvironment();
  authToken = await authenticateCapabilitySmokeUser(BASE_URL, 'python diagram semantics');
  await cleanupSmokeProjects();
  const fixture = await createFixture();
  const diagram = findDiagramObjects(fixture.rendered.figures[0].manifest);
  const browser = await chromium.launch({ headless: true, args: ['--no-sandbox'] });
  const context = await browser.newContext({ viewport: { width: 1500, height: 980 } });
  await installBrowserAuthentication(context, authToken);
  const page = await context.newPage();

  page.on('console', (message) => {
    if (message.type() === 'error' && !isIgnorableDevServerNoise(message.text())) consoleErrors.push(message.text());
  });
  page.on('pageerror', (error) => {
    if (!isIgnorableDevServerNoise(error.message)) pageErrors.push(error.message);
  });
  page.on('request', (request) => {
    const pathname = new URL(request.url()).pathname;
    if (pathname.startsWith('/api/figure') || pathname.startsWith('/api/projects')) {
      apiRequests.push({ method: request.method(), url: request.url(), postData: request.postData() });
    }
  });

  let exportAsset = null;
  try {
    await page.goto(BASE_URL, { waitUntil: 'domcontentloaded', timeout: 30000 });
    await installFixtureState(page, fixture);
    await assertComponentGroups(page, diagram);

    const nodeFill = '#228833';
    const edgeColor = '#3355aa';
    const arrowColor = '#aa6633';
    const nodeLabelColor = '#1166aa';
    const coefficientColor = '#aa3377';
    const nodeLabelSize = 14.5;
    const coefficientSize = 12.5;

    await selectObjectInGroup(page, '图示节点', diagram.latentNode.id);
    await setColorInGroup(page, '图示节点', nodeFill, ':color');
    await selectObjectInGroup(page, '图示连线 / 路径', diagram.edge.id);
    await setColorInGroup(page, '图示连线 / 路径', edgeColor, ':color');
    await selectObjectInGroup(page, '图示箭头', diagram.arrow.id);
    await setColorInGroup(page, '图示箭头', arrowColor, ':color');
    await selectObjectInGroup(page, '图示节点标签', diagram.latentLabel.id);
    await setNumberInGroup(page, '图示节点标签', 'fontsize', nodeLabelSize);
    await setColorInGroup(page, '图示节点标签', nodeLabelColor, ':color');
    await selectObjectInGroup(page, '路径系数标签', diagram.coefficientLabel.id);
    await setNumberInGroup(page, '路径系数标签', 'fontsize', coefficientSize);
    await setColorInGroup(page, '路径系数标签', coefficientColor, ':color');

    assert((await getBodyText(page)).includes('已暂存'), 'draft indicator did not appear after diagram edits');
    const protectedTextInputs = await page.locator(`textarea[data-param-gid="${diagram.coefficientLabel.id}"][data-param-prop="text"], textarea[data-param-gid="${diagram.fitAnnotation.id}"][data-param-prop="text"]`).count();
    assert(protectedTextInputs === 0, 'protected coefficient/fit text content became editable in UI');

    const stylePatchKeys = [
      `${diagram.latentNode.id}:facecolor`,
      `${diagram.edge.id}:color`,
      `${diagram.arrow.id}:facecolor`,
      `${diagram.latentLabel.id}:fontsize`,
      `${diagram.latentLabel.id}:color`,
      `${diagram.coefficientLabel.id}:fontsize`,
      `${diagram.coefficientLabel.id}:color`,
    ];
    const stylePatchBody = await applyCurrentDraft(page, stylePatchKeys);
    assert(!stylePatchBody.patches.some((patch) => patch.prop === 'text'), `protected text patch was sent: ${JSON.stringify(stylePatchBody.patches)}`);
    const styleEdits = [
      { gid: diagram.latentNode.id, prop: 'facecolor', value: nodeFill },
      { gid: diagram.edge.id, prop: 'color', value: edgeColor },
      { gid: diagram.arrow.id, prop: 'facecolor', value: arrowColor },
      { gid: diagram.latentLabel.id, prop: 'fontsize', value: nodeLabelSize },
      { gid: diagram.latentLabel.id, prop: 'color', value: nodeLabelColor },
      { gid: diagram.coefficientLabel.id, prop: 'fontsize', value: coefficientSize },
      { gid: diagram.coefficientLabel.id, prop: 'color', value: coefficientColor },
    ];
    await waitForEdits(page, styleEdits);

    await saveCurrentProject(page);
    await page.reload({ waitUntil: 'networkidle', timeout: 30000 });
    await waitForWorkspaceReady(page);
    await waitForEdits(page, styleEdits);

    const undoRender = await clickUndo(page);
    const undoFigure = undoRender.figures?.find((figure) => figure.figureId === 'fig_1');
    assert(!hasEdit(undoFigure?.editLog, styleEdits.find((edit) => edit.prop === 'facecolor')), `undo retained later style edit: ${JSON.stringify(undoFigure?.editLog)}`);
    const redoRender = await clickRedo(page);
    const redoFigure = redoRender.figures?.find((figure) => figure.figureId === 'fig_1');
    assert(styleEdits.every((edit) => hasEdit(redoFigure?.editLog, edit)), `redo lost diagram style edits: ${JSON.stringify(redoFigure?.editLog)}`);
    await waitForEdits(page, styleEdits);

    const positionPatch = await applyNodeLabelPositionPatch(page, fixture.projectId, diagram.latentLabel);
    const expectedEdits = [
      ...styleEdits,
      { gid: diagram.latentLabel.id, prop: 'position', value: positionPatch.value },
    ];
    await waitForEdits(page, expectedEdits);

    let project = await requestJson(`/api/projects/${fixture.projectId}`);
    let persistedFigure = project.project?.figures?.find((figure) => figure.figureId === 'fig_1');
    assert(expectedEdits.every((edit) => hasEdit(persistedFigure?.editLog, edit)), `persisted project lost diagram edits: ${JSON.stringify(persistedFigure?.editLog)}`);

    await saveCurrentProject(page);
    await page.reload({ waitUntil: 'networkidle', timeout: 30000 });
    await waitForWorkspaceReady(page);
    await waitForEdits(page, expectedEdits);
    const exportTimeState = await waitForEdits(page, expectedEdits);
    const exportTimeSnapshotLog = exportSnapshotEditLog(exportTimeState.editLog, exportTimeState.manifest);
    const exportTimeSignature = editSignature(exportTimeSnapshotLog);

    const exported = await requestJson(`/api/projects/${fixture.projectId}/export`, {
      method: 'POST',
      body: JSON.stringify({ figureId: 'fig_1', format: 'svg', dpi: 150, saveToLibrary: true }),
    });
    exportAsset = exported.figures?.[0]?.asset;
    assert(exportAsset?.assetId && exportAsset.hasEditingSnapshot === true, `export did not create snapshot: ${JSON.stringify(exportAsset)}`);
    const exportedSvg = String(exported.figures?.[0]?.svg || '').toLowerCase();
    for (const value of [nodeFill, edgeColor, arrowColor, nodeLabelColor, coefficientColor]) {
      assert(exportedSvg.includes(value), `export SVG missing edited value ${value}`);
    }
    assert(exportedSvg.includes('beta = 0.42') && exportedSvg.includes('cfi = 0.96') && exportedSvg.includes('rmsea = 0.04'), 'export SVG missing protected coefficient/fit text');
    assert(!exportedSvg.includes('beta = 9.99'), 'export SVG contained mutated protected coefficient text');

    await openComponentCenter(page);
    await selectObjectInGroup(page, '图示节点', diagram.latentNode.id);
    const laterNodeFill = '#cc6677';
    await setColorInGroup(page, '图示节点', laterNodeFill, ':color');
    await applyCurrentDraft(page, [`${diagram.latentNode.id}:facecolor`]);
    project = await requestJson(`/api/projects/${fixture.projectId}`);
    persistedFigure = project.project?.figures?.find((figure) => figure.figureId === 'fig_1');
    assert(hasEdit(persistedFigure?.editLog, { gid: diagram.latentNode.id, prop: 'facecolor', value: laterNodeFill }), 'later node edit did not persist before restore');

    const restored = await requestJson(`/api/projects/${fixture.projectId}/export-assets/${exportAsset.assetId}/restore`, { method: 'POST' });
    assert(restored.status === 'success', `restore failed: ${JSON.stringify(restored)}`);
    await page.reload({ waitUntil: 'networkidle', timeout: 30000 });
    await waitForWorkspaceReady(page);
    const restoredState = await waitForEdits(page, expectedEdits);
    assert(editSignature(restoredState.editLog) === exportTimeSignature, `restore did not return exactly to export-time edit state: ${JSON.stringify({ exportTime: normalizeEditLog(exportTimeSnapshotLog), restored: normalizeEditLog(restoredState.editLog) })}`);
    assert(!hasEdit(restoredState.editLog, { gid: diagram.latentNode.id, prop: 'facecolor', value: laterNodeFill }), `restore retained later node edit: ${JSON.stringify(restoredState.editLog)}`);
    assert(textObjectById(restoredState.manifest, diagram.coefficientLabel.id)?.currentProps?.text === 'beta = 0.42***', 'restore mutated protected coefficient content');
    assert(textObjectById(restoredState.manifest, diagram.fitAnnotation.id)?.currentProps?.text === 'CFI = 0.96; RMSEA = 0.04', 'restore mutated protected fit content');

    if (consoleErrors.length > 0 || pageErrors.length > 0) {
      throw new Error(`console errors=${JSON.stringify(consoleErrors)}, page errors=${JSON.stringify(pageErrors)}`);
    }

    console.log(JSON.stringify({
      status: 'PASS',
      projectId: fixture.projectId,
      assetId: exportAsset.assetId,
      checked: [
        'component center exposes separate Chinese diagram groups with no duplicate generic memberships',
        'trusted semantic ids and relation metadata drive all node/edge/arrow/label patches',
        'draft and position patch requests contain exact backend diagram ids only',
        'protected coefficient and fit text cannot be content-edited and survive SVG export',
        'save, refresh, undo, redo, export, later edit, and export snapshot restore return to export-time state',
      ],
    }, null, 2));
  } finally {
    await browser.close();
    await requestJson(`/api/projects/${fixture.projectId}`, { method: 'DELETE' }).catch(() => null);
  }
}

main().catch((error) => {
  console.error(JSON.stringify({
    status: 'FAIL',
    message: error.stack || error.message,
    consoleErrors,
    pageErrors,
  }, null, 2));
  process.exitCode = 1;
});
