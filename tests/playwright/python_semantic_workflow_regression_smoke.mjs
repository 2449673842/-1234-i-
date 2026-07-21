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
const BASE_URL = process.env.SCIFIGURE_URL || 'http://localhost:3000';
const FIXTURE_PATH = path.join(ROOT, 'tests/fixtures/capability_matrix/python/semantic_workflow_end_to_end.py');
const BASE_FIXTURE_SCRIPT = fs.readFileSync(FIXTURE_PATH, 'utf8');
const FIXTURE_SCRIPT = BASE_FIXTURE_SCRIPT
  .replace(
    'fig, (ax, contour_ax) = plt.subplots(1, 2, figsize=(5.6, 3.6))',
    'fig, (ax, contour_ax, pie_ax) = plt.subplots(1, 3, figsize=(5.6, 3.6))',
  )
  .replace(
    'plt.tight_layout()',
    [
      'pie_wedges, pie_labels, pie_values = pie_ax.pie(',
      '    [2, 3, 5],',
      '    labels=["Alpha", "Beta", "Gamma"],',
      '    colors=["#4477aa", "#cc6677", "#228833"],',
      '    autopct="%1.0f%%",',
      '    wedgeprops={"linewidth": 0.7, "edgecolor": "#ffffff"},',
      ')',
      'pie_ax.legend(pie_wedges, ["Alpha", "Beta", "Gamma"], loc="lower center", bbox_to_anchor=(0.5, -0.2), fontsize=6)',
      'pie_ax.set_title("Pie slices")',
      'plt.tight_layout()',
    ].join('\n'),
  );
const RUN_ID = new Date().toISOString().replace(/[:.]/g, '-');
const OUTPUT_DIR = path.join(ROOT, 'output', 'playwright', `python-semantic-workflow-${RUN_ID}`);
const TEST_PROJECT_PREFIX = 'Python semantic workflow smoke';

const results = [];
const apiRequests = [];
const consoleErrors = [];
const pageErrors = [];
let authToken = '';
let expectedPatchFailureConsoleErrors = 0;

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function record(id, status, note) {
  results.push({ id, status, note });
  console.log(`${status} ${id}: ${note}`);
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

function interestingApi(request) {
  const pathname = new URL(request.url()).pathname;
  return pathname.startsWith('/api/figure')
    || pathname.startsWith('/api/projects')
    || pathname.startsWith('/api/export-assets');
}

function countPatchRequests(startIndex = 0) {
  return apiRequests.slice(startIndex).filter((request) => new URL(request.url).pathname === '/api/figure/patch').length;
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
  const projects = Array.isArray(data.projects) ? data.projects : [];
  await Promise.all(projects
    .filter((project) => String(project?.name || '').startsWith(TEST_PROJECT_PREFIX))
    .map((project) => {
      const id = project.id || project.projectId;
      return id ? requestJson(`/api/projects/${id}`, { method: 'DELETE' }).catch(() => null) : null;
    }));
}

async function createFixtureProject() {
  const spec = {
    plot_type: 'custom',
    custom_script: FIXTURE_SCRIPT,
    script: FIXTURE_SCRIPT,
    script_language: 'python',
    figure: { width: 140, height: 90, unit: 'mm', dpi: 300 },
  };
  const created = await requestJson('/api/projects', {
    method: 'POST',
    body: JSON.stringify({
      name: `${TEST_PROJECT_PREFIX} ${Date.now()}`,
      spec,
    }),
  });
  const rendered = await requestJson(`/api/projects/${created.id}/figures/render`, {
    method: 'POST',
    body: JSON.stringify({
      script: FIXTURE_SCRIPT,
      editLogs: { fig_1: [] },
      language: 'python',
      requestId: `python-semantic-workflow-${Date.now()}`,
    }),
  });
  assert(rendered.status === 'success' && Array.isArray(rendered.figures) && rendered.figures.length === 1, 'fixture render failed');
  return {
    projectId: created.id,
    spec,
    rendered,
  };
}

async function installWorkspaceState(page, fixture) {
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
      projectName: 'Python semantic workflow smoke',
      projectFigures,
      activeFigureId: 'fig_1',
      selectedFigureIds: ['fig_1'],
      datasets: [],
      selectedGids: [],
      projectHistory: {},
      projectDrafts: {},
      currentView: 'workspace',
      subView: 'home',
      renderLog: ['> Python semantic workflow fixture ready'],
      figSession: null,
    }));
  }, fixture);
  await page.reload({ waitUntil: 'networkidle', timeout: 30000 });
}

async function getBodyText(page) {
  return (await page.textContent('body').catch(() => '')) || '';
}

async function readWorkspaceFigureState(page) {
  return page.evaluate(() => {
    const raw = window.sessionStorage.getItem('scifigure:app-state:v2');
    if (!raw) return null;
    const state = JSON.parse(raw);
    const activeId = state.activeFigureId || 'fig_1';
    const figure = state.projectFigures?.[activeId] || null;
    return {
      activeId,
      revision: figure?.revision ?? null,
      editLog: Array.isArray(figure?.editLog) ? figure.editLog : [],
      history: figure?.history || null,
      selectedGids: Array.isArray(state.selectedGids) ? state.selectedGids : [],
      projectDrafts: state.projectDrafts || {},
    };
  }).catch(() => null);
}

async function waitForWorkspaceReady(page, timeoutMs = 90000) {
  const start = Date.now();
  let lastBody = '';
  let lastSvgCount = 0;
  while (Date.now() - start < timeoutMs) {
    const body = await getBodyText(page);
    const svgCount = await page.locator('svg').count().catch(() => 0);
    lastBody = body;
    lastSvgCount = svgCount;
    if (
      svgCount > 0 &&
      body.includes('属性编辑') &&
      !body.includes('正在恢复项目预览') &&
      !body.includes('正在重新渲染当前图形')
    ) {
      return true;
    }
    await page.waitForTimeout(500);
  }
  throw new Error(`workspace did not become ready: svg=${lastSvgCount}, body=${lastBody.slice(0, 800)}`);
}

async function waitForFigureState(page, expectedRevision, expectedLinewidth, expectedBand = null, expectedContour = null, timeoutMs = 60000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const state = await readWorkspaceFigureState(page);
    const editLog = Array.isArray(state?.editLog) ? state.editLog : [];
    const revisionOk = expectedRevision == null || state?.revision === expectedRevision;
    const linewidthOk = expectedLinewidth === null || editLog.some((entry) => (
      entry?.prop === 'linewidth' &&
      Number(entry?.value) === expectedLinewidth &&
      entry?.mode === 'backend_patch'
    ));
    const bandOk = expectedBand === null || editLog.some((entry) => (
      entry?.gid === expectedBand.gid
      && entry?.prop === 'linewidth'
      && Number(entry?.value) === expectedBand.linewidth
      && entry?.mode === 'backend_patch'
    ));
    const contourExpectations = expectedContour === null
      ? []
      : Array.isArray(expectedContour) ? expectedContour : [expectedContour];
    const contourOk = contourExpectations.every((expected) => editLog.some((entry) => (
      entry?.gid === expected.gid
      && entry?.prop === expected.prop
      && Number(entry?.value) === expected.value
      && entry?.mode === 'backend_patch'
    )));
    if (revisionOk && linewidthOk && bandOk && contourOk) return state;
    await page.waitForTimeout(500);
  }
  const state = await readWorkspaceFigureState(page);
  throw new Error(`figure state did not reach revision ${expectedRevision}: ${JSON.stringify(state)}`);
}

async function openComponentCenter(page) {
  await page.getByRole('button', { name: '组件中心', exact: true }).click();
  await page.waitForTimeout(300);
}

function lineGroupLocator(page) {
  return page.locator('[data-component-group-label="线条 / 拟合线"]').first();
}

function bandGroupLocator(page) {
  return page.locator('[data-component-group-label="置信区间带"]').first();
}

function contourGroupLocator(page) {
  return page.locator('[data-component-group-label="等高线/填充等高线"]').first();
}

function pieSliceGroupLocator(page) {
  return page.locator('[data-component-group-label="饼图扇区"]').first();
}

async function selectLineGroup(page) {
  const group = lineGroupLocator(page);
  await group.waitFor({ state: 'visible', timeout: 30000 });
  const objectButtons = group.locator('button[data-component-object-id]');
  const objectCount = await objectButtons.count();
  assert(objectCount === 2, `expected exactly 2 line objects, got ${objectCount}`);

  await objectButtons.first().click();
  await page.waitForTimeout(300);
  const selectedCount = await group.locator('button[data-component-object-id][aria-pressed="true"]').count();
  assert(selectedCount === 1, `expected one selected object before group selection, got ${selectedCount}`);

  await group.getByRole('button', { name: '选中整组', exact: true }).click();
  await page.waitForTimeout(300);
  const groupSelectedCount = await group.locator('button[data-component-object-id][aria-pressed="true"]').count();
  assert(groupSelectedCount === 2, `expected group selection to include both lines, got ${groupSelectedCount}`);
}

async function clickSvgObject(page, gid) {
  const target = page.locator(`svg [id="${gid}"], svg [data-fig-id="${gid}"]`).first();
  await target.waitFor({ state: 'attached', timeout: 30000 });
  const leaf = target.locator('path, rect, use, polygon, polyline').first();
  const clickable = await leaf.count() > 0 ? leaf : target;
  const box = await clickable.boundingBox();
  await clickable.dispatchEvent('click', {
    button: 0,
    clientX: box ? box.x + box.width / 2 : 1,
    clientY: box ? box.y + box.height / 2 : 1,
  });
  await page.waitForTimeout(300);
}

async function selectPieSliceGroup(page, pieSliceIds) {
  await clickSvgObject(page, pieSliceIds[0]);
  const group = pieSliceGroupLocator(page);
  await group.waitFor({ state: 'visible', timeout: 30000 });
  const objectButtons = group.locator('button[data-component-object-id]');
  const objectCount = await objectButtons.count();
  assert(objectCount === pieSliceIds.length, `expected ${pieSliceIds.length} pie slice objects, got ${objectCount}`);

  await group.getByRole('button', { name: '选中整组', exact: true }).click();
  await page.waitForTimeout(300);
  const groupSelectedCount = await group.locator('button[data-component-object-id][aria-pressed="true"]').count();
  assert(groupSelectedCount === pieSliceIds.length, `expected pie group selection to include ${pieSliceIds.length} slices, got ${groupSelectedCount}`);
}

async function editLineWidth(page, nextValue) {
  const group = lineGroupLocator(page);
  const input = group.locator('input[data-param-role="number"][data-param-prop="linewidth"]').first();
  await input.waitFor({ state: 'visible', timeout: 30000 });
  await input.fill(String(nextValue));
  await input.press('Enter').catch(() => {});
  await input.evaluate((node) => node.blur());
  await page.waitForTimeout(500);
}

async function editPieSliceLineWidth(page, nextValue) {
  const group = pieSliceGroupLocator(page);
  await group.waitFor({ state: 'visible', timeout: 30000 });
  const input = group.locator('input[data-param-role="number"][data-param-prop="linewidth"]').first();
  await input.waitFor({ state: 'visible', timeout: 30000 });
  await input.fill(String(nextValue));
  await input.press('Enter').catch(() => {});
  await input.evaluate((node) => node.blur());
  await page.waitForTimeout(500);
}

async function editPieSliceFaceColor(page, nextValue) {
  const group = pieSliceGroupLocator(page);
  await group.waitFor({ state: 'visible', timeout: 30000 });
  const input = group.locator('input[data-color-role="text"][data-color-scope^="component:pieSlices"][data-color-scope$=":color"]').first();
  await input.waitFor({ state: 'visible', timeout: 30000 });
  await input.fill(nextValue);
  await input.press('Enter').catch(() => {});
  await input.evaluate((node) => node.blur());
  await page.waitForTimeout(500);
}

async function editBandLineWidth(page, nextValue) {
  const group = bandGroupLocator(page);
  await group.waitFor({ state: 'visible', timeout: 30000 });
  const input = group.locator('input[data-param-role="number"][data-param-prop="linewidth"]').first();
  await input.waitFor({ state: 'visible', timeout: 30000 });
  await input.fill(String(nextValue));
  await input.press('Enter').catch(() => {});
  await input.evaluate((node) => node.blur());
  await page.waitForTimeout(500);
}

async function editContourVmax(page, nextValue) {
  const group = contourGroupLocator(page);
  await group.waitFor({ state: 'visible', timeout: 30000 });
  const input = group.locator('input[data-param-role="number"][data-param-prop="vmax"]').first();
  await input.waitFor({ state: 'visible', timeout: 30000 });
  await input.fill(String(nextValue));
  await input.press('Enter').catch(() => {});
  await input.evaluate((node) => node.blur());
  await page.waitForTimeout(500);
}

async function editContourAlpha(page, nextValue) {
  const group = contourGroupLocator(page);
  const input = group.locator([
    'input[data-property-control="alpha"][data-param-role="number"]',
    'input[data-param-role="range"][data-param-prop="alpha"]',
  ].join(', ')).first();
  await input.waitFor({ state: 'visible', timeout: 30000 });
  await input.fill(String(nextValue));
  if (await input.getAttribute('data-param-role') === 'number') {
    await input.press('Enter').catch(() => {});
    await input.evaluate((node) => node.blur());
  }
  assert(Number(await input.inputValue()) === nextValue, `contour alpha control did not reach ${nextValue}`);
  await page.waitForTimeout(500);
}

async function applyCurrentDraft(page, expectedPatchCount = 2, options = {}) {
  const requireBackendOnly = options.requireBackendOnly !== false;
  const start = apiRequests.length;
  const patchResponsePromise = page.waitForResponse((response) => (
    new URL(response.url()).pathname === '/api/figure/patch' &&
    response.request().method() === 'POST'
  ), { timeout: 60000 });
  await page.getByRole('button', { name: '应用当前图', exact: true }).click();
  const patchResponse = await patchResponsePromise;
  assert(patchResponse.ok(), `patch request failed: ${patchResponse.status()}`);
  const patchResponseBody = await patchResponse.json();
  assert(
    patchResponseBody?.status === 'success',
    `patch request returned a non-success application status: ${JSON.stringify(patchResponseBody)}`,
  );
  await waitForWorkspaceReady(page);

  const patchRequests = apiRequests.slice(start).filter((request) => new URL(request.url).pathname === '/api/figure/patch');
  assert(patchRequests.length === 1, `expected one patch request, got ${patchRequests.length}`);
  const patchBody = parseJson(patchRequests[0].postData);
  assert(patchBody?.figureId === 'fig_1', `patch targeted wrong figure: ${JSON.stringify(patchBody)}`);
  assert(Array.isArray(patchBody?.patches) && patchBody.patches.length === expectedPatchCount, `expected patch batch of ${expectedPatchCount} patches, got ${JSON.stringify(patchBody?.patches)}`);
  if (requireBackendOnly) {
    assert(patchBody.patches.every((patch) => patch.mode === 'backend_patch'), `patch batch was not backend-only: ${JSON.stringify(patchBody.patches)}`);
  }
  return { ...patchBody, response: patchResponseBody };
}

async function applyTextImmediately(page, projectId, gid, nextValue) {
  await clickSvgObject(page, gid);
  await page.getByRole('button', { name: '属性编辑', exact: true }).click();
  const input = page.locator(`textarea[data-param-gid="${gid}"][data-param-prop="text"]`);
  await input.waitFor({ state: 'visible', timeout: 30000 });
  await input.fill(nextValue);

  const requestStart = apiRequests.length;
  const button = input.locator('..').getByRole('button', { name: '立即应用', exact: true });
  await button.click();
  let patchRequest = null;
  const requestDeadline = Date.now() + 15000;
  while (Date.now() < requestDeadline) {
    patchRequest = apiRequests.slice(requestStart).find((request) => (
      new URL(request.url).pathname === '/api/figure/patch'
        && request.method === 'POST'
    ));
    if (patchRequest) break;
    await page.waitForTimeout(200);
  }
  if (!patchRequest) {
    const state = await readWorkspaceFigureState(page);
    const body = await getBodyText(page);
    throw new Error(`immediate text click emitted no patch request: input=${await input.inputValue()}, state=${JSON.stringify(state)}, body=${body.slice(-1200)}`);
  }
  const requestBody = parseJson(patchRequest.postData);
  assert(
    requestBody?.patches?.length === 1
      && requestBody.patches[0]?.gid === gid
      && requestBody.patches[0]?.prop === 'text'
      && requestBody.patches[0]?.mode === 'backend_patch'
      && requestBody.patches[0]?.value === nextValue,
    `immediate text patch did not use renderer replay: ${JSON.stringify(requestBody)}`,
  );
  await waitForWorkspaceReady(page);
  const persisted = await requestJson(`/api/projects/${projectId}`);
  const figure = persisted.project?.figures?.find((item) => item.figureId === 'fig_1');
  assert(
    figure?.editLog?.some((entry) => entry.gid === gid && entry.prop === 'text' && entry.value === nextValue && entry.mode === 'backend_patch'),
    `immediate text patch was not persisted: ${JSON.stringify(figure?.editLog)}`,
  );
  return figure;
}

async function applyTextImmediatelyWhileEditing(page, projectId, gid, submittedValue, newerValue) {
  await clickSvgObject(page, gid);
  await page.getByRole('button', { name: '属性编辑', exact: true }).click();
  const input = page.locator(`textarea[data-param-gid="${gid}"][data-param-prop="text"]`);
  await input.waitFor({ state: 'visible', timeout: 30000 });
  await input.fill(submittedValue);

  let releaseRequest;
  let markIntercepted;
  const releasePromise = new Promise((resolve) => { releaseRequest = resolve; });
  const interceptedPromise = new Promise((resolve) => { markIntercepted = resolve; });
  await page.route('**/api/figure/patch', async (route) => {
    markIntercepted();
    await releasePromise;
    await route.continue();
  }, { times: 1 });

  const responsePromise = page.waitForResponse((response) => (
    new URL(response.url()).pathname === '/api/figure/patch'
      && response.request().method() === 'POST'
  ), { timeout: 60000 });
  const button = input.locator('..').getByRole('button', { name: '立即应用', exact: true });
  await button.click();
  await interceptedPromise;
  await input.fill(newerValue);
  releaseRequest();

  const response = await responsePromise;
  assert(response.ok(), `delayed immediate text patch failed: ${response.status()}`);
  const responseBody = await response.json();
  assert(responseBody?.status === 'success', `delayed immediate text patch was not applied: ${JSON.stringify(responseBody)}`);
  await waitForWorkspaceReady(page);
  assert(
    await input.inputValue() === newerValue,
    `successful older text request cleared a newer local draft: ${await input.inputValue()}`,
  );
  const workspaceState = await readWorkspaceFigureState(page);
  assert(
    workspaceState?.projectDrafts?.fig_1?.[`${gid}:text`]?.value === newerValue,
    `successful older text request cleared a newer project Draft: ${JSON.stringify(workspaceState?.projectDrafts?.fig_1)}`,
  );
  const persisted = await requestJson(`/api/projects/${projectId}`);
  const figure = persisted.project?.figures?.find((item) => item.figureId === 'fig_1');
  assert(
    figure?.editLog?.some((entry) => entry.gid === gid && entry.prop === 'text' && entry.value === submittedValue),
    `delayed immediate text patch was not persisted: ${JSON.stringify(figure?.editLog)}`,
  );
  return figure;
}

async function applyCurrentDraftExpectFailure(page, expectedPatchCount) {
  const start = apiRequests.length;
  await page.route('**/api/figure/patch', async (route) => {
    await route.fulfill({
      status: 500,
      contentType: 'application/json',
      body: JSON.stringify({ status: 'error', message: 'forced pie draft failure' }),
    });
  }, { times: 1 });

  const patchResponsePromise = page.waitForResponse((response) => (
    new URL(response.url()).pathname === '/api/figure/patch' &&
    response.request().method() === 'POST'
  ), { timeout: 60000 });
  expectedPatchFailureConsoleErrors += 1;
  await page.getByRole('button', { name: '应用当前图', exact: true }).click();
  const patchResponse = await patchResponsePromise;
  assert(!patchResponse.ok(), `forced patch unexpectedly succeeded: ${patchResponse.status()}`);

  const patchRequests = apiRequests.slice(start).filter((request) => new URL(request.url).pathname === '/api/figure/patch');
  assert(patchRequests.length === 1, `expected one failed patch request, got ${patchRequests.length}`);
  const patchBody = parseJson(patchRequests[0].postData);
  assert(Array.isArray(patchBody?.patches) && patchBody.patches.length === expectedPatchCount, `expected failed backend batch of ${expectedPatchCount} patches, got ${JSON.stringify(patchBody?.patches)}`);

  await page.waitForFunction(() => {
    const raw = window.sessionStorage.getItem('scifigure:app-state:v2');
    const state = raw ? JSON.parse(raw) : {};
    const drafts = Object.values(state.projectDrafts?.fig_1 || {});
    return drafts.length > 0 && drafts.every((draft) => Array.isArray(draft.pendingFigureIds) && draft.pendingFigureIds.includes('fig_1'));
  }, null, { timeout: 10000 });
  return patchBody;
}

async function clickUndo(page) {
  const responsePromise = page.waitForResponse((response) => (
    new URL(response.url()).pathname.endsWith('/figures/render') &&
    response.request().method() === 'POST'
  ), { timeout: 60000 });
  await page.getByRole('button', { name: '撤销', exact: true }).click();
  const response = await responsePromise;
  assert(response.ok(), `undo render failed: ${response.status()}`);
  return response.json();
}

async function clickRedo(page) {
  const responsePromise = page.waitForResponse((response) => (
    new URL(response.url()).pathname.endsWith('/figures/render') &&
    response.request().method() === 'POST'
  ), { timeout: 60000 });
  await page.getByRole('button', { name: '重做', exact: true }).click();
  const response = await responsePromise;
  assert(response.ok(), `redo render failed: ${response.status()}`);
  return response.json();
}

async function saveCurrentProject(page) {
  const saveButton = page.getByRole('button', { name: /^保存$/ }).first();
  await saveButton.waitFor({ state: 'visible', timeout: 30000 });
  const responsePromise = page.waitForResponse((response) => (
    response.request().method() === 'PUT'
    && /\/api\/projects\/[^/]+$/.test(new URL(response.url()).pathname)
  ), { timeout: 40000 });
  await saveButton.click();
  const response = await responsePromise;
  assert(response.ok(), `project save failed: ${response.status()}`);
}

function editLogHasEntry(editLog, expected) {
  return editLog.some((entry) => {
    const valueOk = typeof expected.value === 'number'
      ? Math.abs(Number(entry?.value) - expected.value) < 0.001
      : String(entry?.value || '').toLowerCase() === String(expected.value).toLowerCase();
    return entry?.gid === expected.gid
      && entry?.prop === expected.prop
      && valueOk
      && (!expected.mode || entry?.mode === expected.mode);
  });
}

function assertPieStyleEdits(editLog, targetIds, facecolor, linewidth, label) {
  for (const gid of targetIds) {
    assert(editLogHasEntry(editLog, { gid, prop: 'facecolor', value: facecolor, mode: 'local_patch' }), `${label} lost pie facecolor for ${gid}`);
    assert(editLogHasEntry(editLog, { gid, prop: 'linewidth', value: linewidth, mode: 'backend_patch' }), `${label} lost pie linewidth for ${gid}`);
  }
}

function assertNoPieStyleEdits(editLog, targetIds, facecolor, linewidth, label) {
  for (const gid of targetIds) {
    assert(!editLogHasEntry(editLog, { gid, prop: 'facecolor', value: facecolor }), `${label} kept pie facecolor for ${gid}`);
    assert(!editLogHasEntry(editLog, { gid, prop: 'linewidth', value: linewidth }), `${label} kept pie linewidth for ${gid}`);
  }
}

async function waitForPieStyleEdits(page, targetIds, facecolor, linewidth, timeoutMs = 60000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const state = await readWorkspaceFigureState(page);
    const editLog = Array.isArray(state?.editLog) ? state.editLog : [];
    if (targetIds.every((gid) => (
      editLogHasEntry(editLog, { gid, prop: 'facecolor', value: facecolor, mode: 'local_patch' })
      && editLogHasEntry(editLog, { gid, prop: 'linewidth', value: linewidth, mode: 'backend_patch' })
    ))) {
      return state;
    }
    await page.waitForTimeout(500);
  }
  const state = await readWorkspaceFigureState(page);
  throw new Error(`pie slice state did not persist: ${JSON.stringify(state)}`);
}

async function main() {
  const url = new URL(BASE_URL);
  assert(process.env.SCIFIGURE_TEST_ISOLATED === '1', 'refusing to run outside the isolated server wrapper');
  assert(process.env.SCIFIGURE_DATA_DIR, 'missing SCIFIGURE_DATA_DIR');
  assert(process.env.SCIFIGURE_DB_PATH, 'missing SCIFIGURE_DB_PATH');
  assert(!(url.hostname === 'localhost' || url.hostname === '127.0.0.1') || url.port !== '3000', 'refusing to run against localhost:3000');

  fs.mkdirSync(OUTPUT_DIR, { recursive: true });
  authToken = await authenticateCapabilitySmokeUser(BASE_URL, 'python semantic workflow');
  await cleanupSmokeProjects();

  const fixture = await createFixtureProject();
  let initialRevision = fixture.rendered.figures[0]?.revision || 1;
  const fillBetweenBand = fixture.rendered.figures[0]?.manifest?.objects?.find((object) => (
    object.kind === 'fill_between' && object.role === 'fill_between_series'
  ));
  assert(fillBetweenBand?.id, 'fixture manifest is missing the dedicated fill_between object');
  const contourFill = fixture.rendered.figures[0]?.manifest?.objects?.find((object) => (
    object.kind === 'contourf' && object.role === 'contourf_series'
  ));
  assert(contourFill?.id, 'fixture manifest is missing the dedicated contourf parent');
  const textTarget = fixture.rendered.figures[0]?.manifest?.objects?.find((object) => (
    object.id?.startsWith('title.')
      && object.editable?.includes('text')
      && typeof object.currentProps?.text === 'string'
  ));
  assert(textTarget?.id, 'fixture manifest is missing an editable title text object');
  const pieSlices = fixture.rendered.figures[0]?.manifest?.objects?.filter((object) => object.role === 'pie_slice') || [];
  assert(pieSlices.length === 3, `fixture manifest expected 3 Axes.pie slices, got ${pieSlices.length}`);
  assert(
    pieSlices.every((object) => (
      object.kind === 'patch'
      && object.source?.callName === 'Axes.pie'
      && object.identity?.relation?.pieLabelId
      && object.identity?.relation?.pieValueLabelId
      && Array.isArray(object.identity?.relation?.legendMarkerIds)
      && object.identity.relation.legendMarkerIds.length > 0
    )),
    `fixture pie slices are missing labels, autopct, or legend relationships: ${JSON.stringify(pieSlices)}`,
  );
  const pieSliceIds = pieSlices.map((object) => object.id);
  const pieLegendMarkerIds = pieSlices.flatMap((object) => object.identity?.relation?.legendMarkerIds || []);
  const pieStyleTargetIds = [...pieSliceIds, ...pieLegendMarkerIds];
  const browser = await chromium.launch({ headless: true, args: ['--no-sandbox'] });
  const context = await browser.newContext({ viewport: { width: 1440, height: 960 } });
  await installBrowserAuthentication(context, authToken);
  const page = await context.newPage();

  page.on('console', (message) => {
    if (message.type() === 'error' && !isIgnorableDevServerNoise(message.text())) {
      if (
        expectedPatchFailureConsoleErrors > 0
        && message.text().includes('Failed to load resource: the server responded with a status of 500')
      ) {
        expectedPatchFailureConsoleErrors -= 1;
        return;
      }
      consoleErrors.push(message.text());
    }
  });
  page.on('pageerror', (error) => {
    if (!isIgnorableDevServerNoise(error.message)) pageErrors.push(error.message);
  });
  page.on('request', (request) => {
    if (interestingApi(request)) {
      apiRequests.push({ method: request.method(), url: request.url(), postData: request.postData() });
    }
  });

  let exportAsset = null;
  try {
    await page.goto(BASE_URL, { waitUntil: 'domcontentloaded', timeout: 30000 });
    await installWorkspaceState(page, fixture);
    await waitForWorkspaceReady(page);

    const immediateTextValue = 'Immediate renderer title';
    const immediateResponse = await applyTextImmediately(page, fixture.projectId, textTarget.id, immediateTextValue);
    const immediateObject = await page.evaluate((gid) => {
      const raw = window.sessionStorage.getItem('scifigure:app-state:v2');
      const state = raw ? JSON.parse(raw) : {};
      return state.projectFigures?.fig_1?.manifest?.objects?.find((object) => object.id === gid) || null;
    }, textTarget.id);
    assert(immediateObject?.currentProps?.text === immediateTextValue, `immediate text render did not update the manifest: ${JSON.stringify(immediateObject)}`);
    const immediateState = await readWorkspaceFigureState(page);
    assert(!immediateState?.projectDrafts?.fig_1?.[`${textTarget.id}:text`], 'successful immediate text apply left a stale Draft entry');
    initialRevision = Number(immediateResponse?.revision || initialRevision + 1);
    record('B0E-text-immediate-render', 'PASS', `gid=${textTarget.id}, value=${immediateTextValue}`);

    const immediateInput = page.locator(`textarea[data-param-gid="${textTarget.id}"][data-param-prop="text"]`);
    await immediateInput.fill('Temporary title draft');
    await page.waitForFunction(({ gid, expected }) => {
      const raw = window.sessionStorage.getItem('scifigure:app-state:v2');
      const state = raw ? JSON.parse(raw) : {};
      return state.projectDrafts?.fig_1?.[`${gid}:text`]?.value === expected;
    }, { gid: textTarget.id, expected: 'Temporary title draft' }, { timeout: 10000 });
    await immediateInput.fill(immediateTextValue);
    await page.waitForFunction((gid) => {
      const raw = window.sessionStorage.getItem('scifigure:app-state:v2');
      const state = raw ? JSON.parse(raw) : {};
      return !state.projectDrafts?.fig_1?.[`${gid}:text`];
    }, textTarget.id, { timeout: 10000 });
    record('B0G-text-noop-draft', 'PASS', `gid=${textTarget.id}, restored=${immediateTextValue}`);

    const submittedRaceValue = 'Submitted renderer title';
    const newerDraftValue = 'Newer unsaved title';
    const raceResponse = await applyTextImmediatelyWhileEditing(
      page,
      fixture.projectId,
      textTarget.id,
      submittedRaceValue,
      newerDraftValue,
    );
    initialRevision = Number(raceResponse?.revision || initialRevision + 1);
    record('B0F-text-immediate-race', 'PASS', `persisted=${submittedRaceValue}, retained=${newerDraftValue}`);

    await page.locator('[data-layer-node-id="Figure"]').click();
    await openComponentCenter(page);
    const patchRequestStart = apiRequests.length;
    await editContourVmax(page, 1.25);
    await editContourAlpha(page, 0.35);
    await selectLineGroup(page);
    await editLineWidth(page, 1.9);
    await editBandLineWidth(page, 2.1);
    const bodyAfterDraft = await getBodyText(page);
    assert(bodyAfterDraft.includes('已暂存'), 'draft indicator did not appear after editing');
    assert(countPatchRequests(patchRequestStart) === 0, 'draft emitted a backend patch before apply');

    await clickSvgObject(page, textTarget.id);
    await page.getByRole('button', { name: '属性编辑', exact: true }).click();
    const batchedTextValue = 'Batched renderer title';
    const batchedTextInput = page.locator(`textarea[data-param-gid="${textTarget.id}"][data-param-prop="text"]`);
    await batchedTextInput.waitFor({ state: 'visible', timeout: 30000 });
    await batchedTextInput.fill(batchedTextValue);

    const patchBody = await applyCurrentDraft(page, 6);
    const bandPatch = patchBody.patches.find((patch) => patch.gid === fillBetweenBand.id && patch.prop === 'linewidth');
    const contourPatch = patchBody.patches.find((patch) => patch.gid === contourFill.id && patch.prop === 'vmax');
    const contourAlphaPatch = patchBody.patches.find((patch) => patch.gid === contourFill.id && patch.prop === 'alpha');
    const textPatch = patchBody.patches.find((patch) => patch.gid === textTarget.id && patch.prop === 'text');
    record(
      'B0B-apply-batch',
      patchBody.patches.length === 6
        && Number(bandPatch?.value) === 2.1
        && Number(contourPatch?.value) === 1.25
        && Number(contourAlphaPatch?.value) === 0.35
        && textPatch?.mode === 'backend_patch'
        && textPatch?.value === batchedTextValue ? 'PASS' : 'FAIL',
      `patches=${JSON.stringify(patchBody.patches)}`,
    );

    const persistedAfterApply = await requestJson(`/api/projects/${fixture.projectId}`);
    const persistedFigure = persistedAfterApply.project?.figures?.find((figure) => figure.figureId === 'fig_1');
    assert(persistedFigure?.revision === initialRevision + 1, `revision did not increase after apply: ${persistedFigure?.revision}`);
    assert(Array.isArray(persistedFigure?.editLog) && persistedFigure.editLog.some((entry) => entry.prop === 'linewidth' && Number(entry.value) === 1.9), 'persisted editLog does not contain the applied linewidth edit');
    assert(persistedFigure.editLog.some((entry) => entry.gid === fillBetweenBand.id && entry.prop === 'linewidth' && Number(entry.value) === 2.1), 'persisted editLog does not contain the fill_between edit');
    assert(persistedFigure.editLog.some((entry) => entry.gid === contourFill.id && entry.prop === 'vmax' && Number(entry.value) === 1.25), 'persisted editLog does not contain the contourf edit');
    assert(persistedFigure.editLog.some((entry) => entry.gid === contourFill.id && entry.prop === 'alpha' && Number(entry.value) === 0.35), 'persisted editLog does not contain the contourf alpha edit');
    assert(persistedFigure.editLog.some((entry) => entry.gid === textTarget.id && entry.prop === 'text' && entry.value === batchedTextValue && entry.mode === 'backend_patch'), 'persisted editLog does not contain the batched text edit');

    await page.reload({ waitUntil: 'networkidle', timeout: 30000 });
    await waitForWorkspaceReady(page);
    const reloadedState = await waitForFigureState(
      page,
      initialRevision + 1,
      1.9,
      { gid: fillBetweenBand.id, linewidth: 2.1 },
      [
        { gid: contourFill.id, prop: 'vmax', value: 1.25 },
        { gid: contourFill.id, prop: 'alpha', value: 0.35 },
      ],
    );
    assert(reloadedState.revision === initialRevision + 1, `reload did not preserve revision: ${reloadedState.revision}`);

    const undoRender = await clickUndo(page);
    const undoFigure = undoRender.figures?.find((figure) => figure.figureId === 'fig_1');
    assert(!(undoFigure?.editLog || []).some((entry) => entry.prop === 'linewidth' && Number(entry.value) === 1.9), 'undo kept the applied linewidth edit');
    assert(!(undoFigure?.editLog || []).some((entry) => entry.gid === fillBetweenBand.id && entry.prop === 'linewidth' && Number(entry.value) === 2.1), 'undo kept the fill_between edit');
    assert(!(undoFigure?.editLog || []).some((entry) => entry.gid === contourFill.id && entry.prop === 'vmax'), 'undo kept the contourf edit');
    assert(!(undoFigure?.editLog || []).some((entry) => entry.gid === contourFill.id && entry.prop === 'alpha'), 'undo kept the contourf alpha edit');
    await waitForWorkspaceReady(page);
    const undoState = await readWorkspaceFigureState(page);
    assert(!(undoState?.editLog || []).some((entry) => entry.prop === 'linewidth' && Number(entry.value) === 1.9), 'undo state still contains the applied linewidth edit');

    const redoRender = await clickRedo(page);
    const redoFigure = redoRender.figures?.find((figure) => figure.figureId === 'fig_1');
    assert((redoFigure?.editLog || []).some((entry) => entry.prop === 'linewidth' && Number(entry.value) === 1.9), 'redo lost the applied linewidth edit');
    assert((redoFigure?.editLog || []).some((entry) => entry.gid === fillBetweenBand.id && entry.prop === 'linewidth' && Number(entry.value) === 2.1), 'redo lost the fill_between edit');
    assert((redoFigure?.editLog || []).some((entry) => entry.gid === contourFill.id && entry.prop === 'vmax' && Number(entry.value) === 1.25), 'redo lost the contourf edit');
    assert((redoFigure?.editLog || []).some((entry) => entry.gid === contourFill.id && entry.prop === 'alpha' && Number(entry.value) === 0.35), 'redo lost the contourf alpha edit');
    await waitForWorkspaceReady(page);
    const redoState = await readWorkspaceFigureState(page);
    assert((redoState?.editLog || []).some((entry) => entry.prop === 'linewidth' && Number(entry.value) === 1.9), 'redo state lost the applied linewidth edit');
    assert((redoState?.editLog || []).some((entry) => entry.gid === fillBetweenBand.id && entry.prop === 'linewidth' && Number(entry.value) === 2.1), 'redo state lost the fill_between edit');
    assert((redoState?.editLog || []).some((entry) => entry.gid === contourFill.id && entry.prop === 'vmax' && Number(entry.value) === 1.25), 'redo state lost the contourf edit');
    assert((redoState?.editLog || []).some((entry) => entry.gid === contourFill.id && entry.prop === 'alpha' && Number(entry.value) === 0.35), 'redo state lost the contourf alpha edit');

    const persistedAfterRedo = await requestJson(`/api/projects/${fixture.projectId}`);
    const persistedRedoFigure = persistedAfterRedo.project?.figures?.find((figure) => figure.figureId === 'fig_1');
    assert(
      (persistedRedoFigure?.editLog || []).some((entry) => entry.gid === contourFill.id && entry.prop === 'alpha' && Number(entry.value) === 0.35),
      `authoritative session lost contourf alpha after redo: ${JSON.stringify(persistedRedoFigure)}`,
    );

    const exportResult = await requestJson(`/api/projects/${fixture.projectId}/export`, {
      method: 'POST',
      body: JSON.stringify({
        figureId: 'fig_1',
        format: 'svg',
        dpi: 300,
        saveToLibrary: true,
      }),
    });
    exportAsset = exportResult.figures?.[0]?.asset || null;
    assert(exportAsset?.assetId, `export asset missing: ${JSON.stringify(exportResult)}`);
    assert(exportAsset.hasEditingSnapshot === true, `export did not capture an editing snapshot: ${JSON.stringify(exportAsset)}`);
    assert(Number(exportAsset?.metadata?.revision || exportAsset?.revision || 0) === initialRevision + 1, `export snapshot revision mismatch: ${JSON.stringify(exportAsset)}`);
    const exportedSvg = exportResult.figures?.[0]?.svg || '';
    const exportedOpacityStyles = Array.from(exportedSvg.matchAll(/(?:fill-opacity|opacity):\s*([0-9.]+)/g), match => match[0]);
    assert(
      exportedSvg.includes('fill-opacity: 0.35'),
      `exported SVG does not contain the applied contourf alpha state; opacity styles=${JSON.stringify(Array.from(new Set(exportedOpacityStyles)).slice(0, 20))}; warnings=${JSON.stringify(exportResult.figures?.[0]?.warnings || [])}`,
    );
    record('B0B-export-snapshot', 'PASS', `asset=${exportAsset.assetId}, format=${exportAsset.format}, snapshot=${exportAsset.hasEditingSnapshot}`);

    await openComponentCenter(page);
    await selectLineGroup(page);
    await editLineWidth(page, 2.4);
    await applyCurrentDraft(page);
    const laterEditProject = await requestJson(`/api/projects/${fixture.projectId}`);
    const laterFigure = laterEditProject.project?.figures?.find((figure) => figure.figureId === 'fig_1');
    const laterRevision = Number(laterFigure?.revision || 0);
    assert(laterRevision >= initialRevision + 2, `later edit did not advance revision: ${laterFigure?.revision}`);
    assert(Array.isArray(laterFigure?.editLog) && laterFigure.editLog.some((entry) => entry.prop === 'linewidth' && Number(entry.value) === 2.4), 'later edit was not persisted');

    const restoreResult = await requestJson(`/api/projects/${fixture.projectId}/export-assets/${exportAsset.assetId}/restore`, {
      method: 'POST',
    });
    assert(restoreResult.status === 'success', `restore failed: ${JSON.stringify(restoreResult)}`);
    await page.reload({ waitUntil: 'networkidle', timeout: 30000 });
    await waitForWorkspaceReady(page);

    const restoredState = await waitForFigureState(
      page,
      null,
      1.9,
      { gid: fillBetweenBand.id, linewidth: 2.1 },
      [
        { gid: contourFill.id, prop: 'vmax', value: 1.25 },
        { gid: contourFill.id, prop: 'alpha', value: 0.35 },
      ],
    );
    assert((restoredState?.editLog || []).some((entry) => entry.prop === 'linewidth' && Number(entry.value) === 1.9), 'restore did not return to export-time linewidth state');

    const restoredProject = await requestJson(`/api/projects/${fixture.projectId}`);
    const restoredFigure = restoredProject.project?.figures?.find((figure) => figure.figureId === 'fig_1');
    assert(Number(restoredFigure?.revision || 0) >= laterRevision, `restored revision regressed: ${restoredFigure?.revision} < ${laterRevision}`);
    assert(Array.isArray(restoredFigure?.editLog) && restoredFigure.editLog.some((entry) => entry.prop === 'linewidth' && Number(entry.value) === 1.9), 'restored editLog does not contain export-time state');
    assert(restoredFigure.editLog.some((entry) => entry.gid === fillBetweenBand.id && entry.prop === 'linewidth' && Number(entry.value) === 2.1), 'restored editLog lost the export-time fill_between state');
    assert(restoredFigure.editLog.some((entry) => entry.gid === contourFill.id && entry.prop === 'vmax' && Number(entry.value) === 1.25), 'restored editLog lost the export-time contourf state');
    assert(restoredFigure.editLog.some((entry) => entry.gid === contourFill.id && entry.prop === 'alpha' && Number(entry.value) === 0.35), 'restored editLog lost the export-time contourf alpha state');
    assert(Array.isArray(restoredFigure?.editLog) && restoredFigure.editLog.some((entry) => entry.gid === 'global' && entry.prop === 'figure.width_in' && Number(entry.value) === 5.6), 'restored editLog is missing figure.width_in');
    assert(Array.isArray(restoredFigure?.editLog) && restoredFigure.editLog.some((entry) => entry.gid === 'global' && entry.prop === 'figure.height_in' && Number(entry.value) === 3.6), 'restored editLog is missing figure.height_in');
    assert(Array.isArray(restoredFigure?.editLog) && restoredFigure.editLog.some((entry) => entry.gid === 'global' && entry.prop === 'figure.dpi' && Number(entry.value) === 100), 'restored editLog is missing figure.dpi');
    assert(!(restoredFigure?.editLog || []).some((entry) => entry.prop === 'linewidth' && Number(entry.value) === 2.4), 'later edit leaked into restored editLog');
    const checkpoint = restoredFigure?.history?.past?.at(-1);
    assert(checkpoint, 'restore did not preserve a history checkpoint');
    assert(
      checkpoint?.editLog?.some((entry) => entry.prop === 'linewidth' && Number(entry.value) === 2.4),
      'restore did not preserve the later edit as a history checkpoint',
    );
    record(
      'B0B-restore-checkpoint',
      'PASS',
      `restoredRevision=${restoredFigure?.revision}, checkpoint=${checkpoint?.label || 'unknown'}, checkpointEntries=${checkpoint?.editLog?.length || 0}`,
    );

    await openComponentCenter(page);
    await selectPieSliceGroup(page, pieSliceIds);
    const piePatchStart = apiRequests.length;
    const pieFacecolor = '#bb8844';
    const pieLinewidth = 1.75;
    await editPieSliceFaceColor(page, pieFacecolor);
    await editPieSliceLineWidth(page, pieLinewidth);
    const bodyAfterPieDraft = await getBodyText(page);
    assert(bodyAfterPieDraft.includes('已暂存'), 'pie draft indicator did not appear after editing');
    assert(countPatchRequests(piePatchStart) === 0, 'pie draft emitted a backend patch before apply');

    const piePatchBody = await applyCurrentDraft(page, pieStyleTargetIds.length * 2);
    const piePatchCorrect = pieStyleTargetIds.every((gid) => (
      piePatchBody.patches.some((patch) => patch.gid === gid && patch.prop === 'facecolor' && patch.mode === 'backend_patch' && String(patch.value).toLowerCase() === pieFacecolor)
      && piePatchBody.patches.some((patch) => patch.gid === gid && patch.prop === 'linewidth' && patch.mode === 'backend_patch' && Number(patch.value) === pieLinewidth)
    ));
    const authoritativePieModesCorrect = pieStyleTargetIds.every((gid) => (
      editLogHasEntry(piePatchBody.response?.applied || [], { gid, prop: 'facecolor', value: pieFacecolor, mode: 'local_patch' })
      && editLogHasEntry(piePatchBody.response?.applied || [], { gid, prop: 'linewidth', value: pieLinewidth, mode: 'backend_patch' })
    ));
    record(
      'B0C-pie-slice-apply-batch',
      piePatchCorrect && authoritativePieModesCorrect ? 'PASS' : 'FAIL',
      `pieSlices=${pieSliceIds.join(',')}, requestPatches=${JSON.stringify(piePatchBody.patches)}, authoritativeApplied=${JSON.stringify(piePatchBody.response?.applied || [])}`,
    );
    assert(piePatchCorrect, `pie slice batch did not target every slice: ${JSON.stringify(piePatchBody.patches)}`);
    assert(
      authoritativePieModesCorrect,
      `server did not derive authoritative persisted pie modes: ${JSON.stringify(piePatchBody.response?.applied || [])}`,
    );

    const persistedAfterPie = await requestJson(`/api/projects/${fixture.projectId}`);
    const persistedPieFigure = persistedAfterPie.project?.figures?.find((figure) => figure.figureId === 'fig_1');
    assertPieStyleEdits(persistedPieFigure?.editLog || [], pieStyleTargetIds, pieFacecolor, pieLinewidth, 'persisted pie editLog');

    await saveCurrentProject(page);
    await page.reload({ waitUntil: 'networkidle', timeout: 30000 });
    await waitForWorkspaceReady(page);
    const reloadedPieState = await waitForPieStyleEdits(page, pieStyleTargetIds, pieFacecolor, pieLinewidth);
    assertPieStyleEdits(reloadedPieState?.editLog || [], pieStyleTargetIds, pieFacecolor, pieLinewidth, 'reloaded pie state');

    const pieUndoRender = await clickUndo(page);
    const pieUndoFigure = pieUndoRender.figures?.find((figure) => figure.figureId === 'fig_1');
    assertNoPieStyleEdits(pieUndoFigure?.editLog || [], pieStyleTargetIds, pieFacecolor, pieLinewidth, 'pie undo render');
    await waitForWorkspaceReady(page);
    const pieUndoState = await readWorkspaceFigureState(page);
    assertNoPieStyleEdits(pieUndoState?.editLog || [], pieStyleTargetIds, pieFacecolor, pieLinewidth, 'pie undo state');

    const pieRedoRender = await clickRedo(page);
    const pieRedoFigure = pieRedoRender.figures?.find((figure) => figure.figureId === 'fig_1');
    assertPieStyleEdits(pieRedoFigure?.editLog || [], pieStyleTargetIds, pieFacecolor, pieLinewidth, 'pie redo render');
    await waitForWorkspaceReady(page);
    const pieRedoState = await waitForPieStyleEdits(page, pieStyleTargetIds, pieFacecolor, pieLinewidth);
    assertPieStyleEdits(pieRedoState?.editLog || [], pieStyleTargetIds, pieFacecolor, pieLinewidth, 'pie redo state');

    await openComponentCenter(page);
    await selectPieSliceGroup(page, pieSliceIds);
    const failedPieLinewidth = 2.25;
    await editPieSliceLineWidth(page, failedPieLinewidth);
    const failedDraftBody = await getBodyText(page);
    assert(failedDraftBody.includes('已暂存'), 'pie failed-apply draft indicator did not appear');
    const failedPiePatchBody = await applyCurrentDraftExpectFailure(page, pieStyleTargetIds.length);
    const retainedState = await readWorkspaceFigureState(page);
    const retainedDrafts = Object.values(retainedState?.projectDrafts?.fig_1 || {});
    assert(
      retainedDrafts.length === pieStyleTargetIds.length
        && retainedDrafts.every((draft) => (
          pieStyleTargetIds.includes(draft.gid)
          && draft.prop === 'linewidth'
          && Number(draft.value) === failedPieLinewidth
          && Array.isArray(draft.pendingFigureIds)
          && draft.pendingFigureIds.includes('fig_1')
        ))
        && pieSliceIds.every((gid) => retainedDrafts.some((draft) => draft.gid === gid && draft.prop === 'linewidth')),
      `failed pie apply did not retain drafts: ${JSON.stringify(retainedState?.projectDrafts?.fig_1)}`,
    );
    const bodyAfterFailedPieApply = await getBodyText(page);
    assert(bodyAfterFailedPieApply.includes('已暂存') && bodyAfterFailedPieApply.includes('上次应用部分失败'), 'failed pie apply did not keep draft UI visible');
    record(
      'B0D-pie-slice-failed-draft-retained',
      'PASS',
      `failedPatches=${JSON.stringify(failedPiePatchBody.patches)}, retainedDrafts=${retainedDrafts.length}`,
    );

    if (consoleErrors.length > 0 || pageErrors.length > 0) {
      throw new Error(`console errors=${consoleErrors.length}, page errors=${pageErrors.length}`);
    }

    console.log(JSON.stringify({
      status: 'PASS',
      projectId: fixture.projectId,
      assetId: exportAsset.assetId,
      revision: restoredFigure?.revision,
      checkpoints: restoredFigure?.history?.past?.length || 0,
      consoleErrors: consoleErrors.length,
      pageErrors: pageErrors.length,
    }, null, 2));
  } finally {
    await browser.close();
    await cleanupSmokeProjects().catch(() => null);
    if (fixture.projectId) {
      await requestJson(`/api/projects/${fixture.projectId}`, { method: 'DELETE' }).catch(() => null);
    }
  }
}

main().catch((error) => {
  record('HARNESS', 'FAIL', error?.message || String(error));
  console.error(JSON.stringify({
    status: 'FAIL',
    message: error?.stack || error?.message || String(error),
    consoleErrors,
    pageErrors,
  }, null, 2));
  process.exitCode = 1;
});
