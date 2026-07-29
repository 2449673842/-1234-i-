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
const FIXTURE_SCRIPT = fs.readFileSync(FIXTURE_PATH, 'utf8');
const RUN_ID = new Date().toISOString().replace(/[:.]/g, '-');
const OUTPUT_DIR = path.join(ROOT, 'output', 'playwright', `python-semantic-workflow-${RUN_ID}`);
const TEST_PROJECT_PREFIX = 'Python semantic workflow smoke';

const results = [];
const apiRequests = [];
const consoleErrors = [];
const pageErrors = [];
let authToken = '';

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

async function editLineWidth(page, nextValue) {
  const group = lineGroupLocator(page);
  const input = group.locator('input[data-param-role="number"][data-param-prop="linewidth"]').first();
  await input.waitFor({ state: 'visible', timeout: 30000 });
  await input.fill(String(nextValue));
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
  const input = group.locator('input[data-param-role="range"][data-param-prop="alpha"]').first();
  await input.waitFor({ state: 'visible', timeout: 30000 });
  await input.fill(String(nextValue));
  assert(Number(await input.inputValue()) === nextValue, `contour alpha control did not reach ${nextValue}`);
  await page.waitForTimeout(500);
}

async function applyCurrentDraft(page, expectedPatchCount = 2) {
  const start = apiRequests.length;
  const patchResponsePromise = page.waitForResponse((response) => (
    new URL(response.url()).pathname === '/api/figure/patch' &&
    response.request().method() === 'POST'
  ), { timeout: 60000 });
  await page.getByRole('button', { name: '应用当前图', exact: true }).click();
  const patchResponse = await patchResponsePromise;
  assert(patchResponse.ok(), `patch request failed: ${patchResponse.status()}`);
  await waitForWorkspaceReady(page);

  const patchRequests = apiRequests.slice(start).filter((request) => new URL(request.url).pathname === '/api/figure/patch');
  assert(patchRequests.length === 1, `expected one patch request, got ${patchRequests.length}`);
  const patchBody = parseJson(patchRequests[0].postData);
  assert(patchBody?.figureId === 'fig_1', `patch targeted wrong figure: ${JSON.stringify(patchBody)}`);
  assert(Array.isArray(patchBody?.patches) && patchBody.patches.length === expectedPatchCount, `expected backend batch of ${expectedPatchCount} patches, got ${JSON.stringify(patchBody?.patches)}`);
  assert(patchBody.patches.every((patch) => patch.mode === 'backend_patch'), `patch batch was not backend-only: ${JSON.stringify(patchBody.patches)}`);
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
  const initialRevision = fixture.rendered.figures[0]?.revision || 1;
  const fillBetweenBand = fixture.rendered.figures[0]?.manifest?.objects?.find((object) => (
    object.kind === 'fill_between' && object.role === 'fill_between_series'
  ));
  assert(fillBetweenBand?.id, 'fixture manifest is missing the dedicated fill_between object');
  const contourFill = fixture.rendered.figures[0]?.manifest?.objects?.find((object) => (
    object.kind === 'contourf' && object.role === 'contourf_series'
  ));
  assert(contourFill?.id, 'fixture manifest is missing the dedicated contourf parent');
  const browser = await chromium.launch({ headless: true, args: ['--no-sandbox'] });
  const context = await browser.newContext({ viewport: { width: 1440, height: 960 } });
  await installBrowserAuthentication(context, authToken);
  const page = await context.newPage();

  page.on('console', (message) => {
    if (message.type() === 'error' && !isIgnorableDevServerNoise(message.text())) {
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

    const patchBody = await applyCurrentDraft(page, 5);
    const bandPatch = patchBody.patches.find((patch) => patch.gid === fillBetweenBand.id && patch.prop === 'linewidth');
    const contourPatch = patchBody.patches.find((patch) => patch.gid === contourFill.id && patch.prop === 'vmax');
    const contourAlphaPatch = patchBody.patches.find((patch) => patch.gid === contourFill.id && patch.prop === 'alpha');
    record(
      'B0B-apply-batch',
      patchBody.patches.length === 5
        && Number(bandPatch?.value) === 2.1
        && Number(contourPatch?.value) === 1.25
        && Number(contourAlphaPatch?.value) === 0.35 ? 'PASS' : 'FAIL',
      `patches=${JSON.stringify(patchBody.patches)}`,
    );

    const persistedAfterApply = await requestJson(`/api/projects/${fixture.projectId}`);
    const persistedFigure = persistedAfterApply.project?.figures?.find((figure) => figure.figureId === 'fig_1');
    assert(persistedFigure?.revision === initialRevision + 1, `revision did not increase after apply: ${persistedFigure?.revision}`);
    assert(Array.isArray(persistedFigure?.editLog) && persistedFigure.editLog.some((entry) => entry.prop === 'linewidth' && Number(entry.value) === 1.9), 'persisted editLog does not contain the applied linewidth edit');
    assert(persistedFigure.editLog.some((entry) => entry.gid === fillBetweenBand.id && entry.prop === 'linewidth' && Number(entry.value) === 2.1), 'persisted editLog does not contain the fill_between edit');
    assert(persistedFigure.editLog.some((entry) => entry.gid === contourFill.id && entry.prop === 'vmax' && Number(entry.value) === 1.25), 'persisted editLog does not contain the contourf edit');
    assert(persistedFigure.editLog.some((entry) => entry.gid === contourFill.id && entry.prop === 'alpha' && Number(entry.value) === 0.35), 'persisted editLog does not contain the contourf alpha edit');

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
