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
const FIXTURE_PATH = path.join(ROOT, 'tests/fixtures/capability_matrix/python/quiver_streamplot.py');
const SCRIPT = fs.readFileSync(FIXTURE_PATH, 'utf8');
const TEST_PROJECT_PREFIX = 'Python vector field semantics smoke';

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
  const dataDir = process.env.SCIFIGURE_DATA_DIR;
  assert(dataDir && path.basename(path.dirname(path.resolve(dataDir))).startsWith('scifigure-isolated-smoke-'), `unsafe data dir: ${dataDir}`);
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
    figure: { width: 150, height: 80, unit: 'mm', dpi: 300 },
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
      requestId: `python-vector-field-ui-${Date.now()}`,
    }),
  });
  assert(rendered.status === 'success' && rendered.figures?.[0]?.manifest, `fixture render failed: ${JSON.stringify(rendered)}`);
  return { projectId: created.id, spec, rendered };
}

function findVectorObjects(manifest) {
  const objects = manifest?.objects || [];
  const quiver = objects.find((object) => object.kind === 'quiver' && object.role === 'quiver_field');
  const stream = objects.find((object) => object.kind === 'streamplot' && object.role === 'streamplot_field');
  const lineChild = objects.find((object) => object.role === 'streamplot_child_line');
  const arrowChild = objects.find((object) => object.role === 'streamplot_child_arrow');
  assert(quiver?.id === 'collection.0.0', `missing quiver parent: ${JSON.stringify(quiver)}`);
  assert(stream?.id === 'container.streamplot.1.0', `missing streamplot parent: ${JSON.stringify(stream)}`);
  assert(stream.children?.includes(lineChild?.id) && stream.children?.includes(arrowChild?.id), 'streamplot children are not owned by parent');
  assert(lineChild.parentId === stream.id && arrowChild.parentId === stream.id, 'streamplot children do not point back to parent');
  const quiverMarker = objects.find((object) => quiver.identity?.relation?.legendMarkerIds?.includes(object.id));
  const streamMarker = objects.find((object) => stream.identity?.relation?.legendMarkerIds?.includes(object.id));
  assert(quiverMarker?.identity?.relation?.parentId === quiver.id, 'quiver legend marker is not linked to its field parent');
  assert(quiverMarker?.identity?.relation?.quiverId === quiver.identity?.relation?.quiverId, 'quiver legend marker lost trusted relation id');
  assert(streamMarker?.identity?.relation?.parentId === stream.id, 'streamplot legend marker is not linked to its field parent');
  assert(streamMarker?.identity?.relation?.streamplotId === stream.identity?.relation?.streamplotId, 'streamplot legend marker lost trusted relation id');
  return { quiver, stream, lineChild, arrowChild, quiverMarker, streamMarker };
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
      projectName: 'Python vector field semantics smoke',
      projectFigures,
      activeFigureId: 'fig_1',
      selectedFigureIds: ['fig_1'],
      datasets: [],
      selectedGids: [],
      projectHistory: {},
      projectDrafts: {},
      currentView: 'workspace',
      subView: 'home',
      renderLog: ['> Python vector field fixture ready'],
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

async function setColorInGroup(page, label, value) {
  const input = group(page, label).locator([
    'input[data-color-role="text"][data-param-prop="color"]',
    'input[data-color-role="text"][data-color-scope$=":color"]',
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

async function clickSvgObject(page, gid, ctrlKey = false) {
  const target = page.locator(`svg [id="${gid}"], svg [data-fig-id="${gid}"]`).first();
  await target.waitFor({ state: 'attached', timeout: 30000 });
  const leaf = target.locator('path, rect, use, polygon, polyline').first();
  const clickable = await leaf.count() > 0 ? leaf : target;
  const box = await clickable.boundingBox();
  await clickable.dispatchEvent('click', {
    button: 0,
    ctrlKey,
    clientX: box ? box.x + box.width / 2 : 1,
    clientY: box ? box.y + box.height / 2 : 1,
  });
  await page.waitForTimeout(300);
}

async function selectedGids(page) {
  return page.evaluate(() => {
    const raw = window.sessionStorage.getItem('scifigure:app-state:v2');
    const state = raw ? JSON.parse(raw) : {};
    return Array.isArray(state.selectedGids) ? state.selectedGids : [];
  });
}

async function applyCurrentDraft(page, expectedCount) {
  const start = apiRequests.length;
  const responsePromise = page.waitForResponse((response) => (
    new URL(response.url()).pathname === '/api/figure/patch'
    && response.request().method() === 'POST'
  ), { timeout: 60000 });
  await page.getByRole('button', { name: '应用当前图', exact: true }).click();
  const response = await responsePromise;
  assert(response.ok(), `patch failed: ${response.status()}`);
  await waitForWorkspaceReady(page);
  const requests = apiRequests.slice(start).filter((request) => new URL(request.url).pathname === '/api/figure/patch');
  assert(requests.length === 1, `expected one patch request, got ${requests.length}`);
  const body = parseJson(requests[0].postData);
  assert(body?.patches?.length === expectedCount, `expected ${expectedCount} patches, got ${JSON.stringify(body?.patches)}`);
  return body;
}

async function readFigureState(page) {
  return page.evaluate(() => {
    const raw = window.sessionStorage.getItem('scifigure:app-state:v2');
    const state = raw ? JSON.parse(raw) : {};
    const figure = state.projectFigures?.[state.activeFigureId || 'fig_1'];
    return {
      revision: figure?.revision || null,
      editLog: figure?.editLog || [],
      projectDrafts: state.projectDrafts || {},
    };
  });
}

function hasEdit(editLog, expected) {
  return Array.isArray(editLog) && editLog.some((entry) => (
    entry.gid === expected.gid
    && entry.prop === expected.prop
    && String(entry.value).toLowerCase() === String(expected.value).toLowerCase()
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
  throw new Error(`edits not found in figure state: ${JSON.stringify({ expectedEdits, state })}`);
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

async function main() {
  assertIsolatedEnvironment();
  authToken = await authenticateCapabilitySmokeUser(BASE_URL, 'python vector field semantics');
  await cleanupSmokeProjects();
  const fixture = await createFixture();
  const { quiver, stream, lineChild, arrowChild, quiverMarker, streamMarker } = findVectorObjects(fixture.rendered.figures[0].manifest);
  const browser = await chromium.launch({ headless: true, args: ['--no-sandbox'] });
  const context = await browser.newContext({ viewport: { width: 1440, height: 960 } });
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
    await openComponentCenter(page);

    const labels = await page.locator('.scifig-editor-panel-right [data-component-group-label]').evaluateAll(nodes => nodes.map(node => node.getAttribute('data-component-group-label')));
    assert(labels.includes('矢量场 (Quiver)'), `component center missing Quiver group: ${JSON.stringify(labels)}`);
    assert(labels.includes('流线场 (Streamplot)'), `component center missing Streamplot group: ${JSON.stringify(labels)}`);
    assert(await group(page, '矢量场 (Quiver)').locator('input[data-param-prop="size"], input[data-param-prop="sizes"], input[data-param-prop="size_scale"]').count() === 0, 'quiver group exposed scatter size controls');
    assert(await group(page, '矢量场 (Quiver)').locator('button[data-component-object-id]').count() === 1, 'quiver group does not expose one parent object');
    assert(await group(page, '流线场 (Streamplot)').locator('button[data-component-object-id]').count() === 1, 'streamplot group does not expose one parent object');

    await clickSvgObject(page, lineChild.id);
    let selected = await selectedGids(page);
    assert(selected.length === 1 && selected[0] === stream.id, `stream line child click did not resolve to parent: ${JSON.stringify(selected)}`);
    await clickSvgObject(page, arrowChild.id);
    selected = await selectedGids(page);
    assert(selected.length === 1 && selected[0] === stream.id, `stream arrow child click did not resolve to parent: ${JSON.stringify(selected)}`);

    const quiverColor = '#cc6677';
    const streamColor = '#8844bb';
    const streamLinewidth = 2.05;
    await clickSvgObject(page, quiver.id);
    await setColorInGroup(page, '矢量场 (Quiver)', quiverColor);
    await clickSvgObject(page, lineChild.id);
    await setColorInGroup(page, '流线场 (Streamplot)', streamColor);
    await setNumberInGroup(page, '流线场 (Streamplot)', 'linewidth', streamLinewidth);
    assert((await getBodyText(page)).includes('已暂存'), 'draft indicator did not appear after vector-field edits');
    const patchBody = await applyCurrentDraft(page, 7);
    assert(patchBody.patches.some((patch) => patch.gid === quiver.id && patch.prop === 'color' && String(patch.value).toLowerCase() === quiverColor), `missing quiver color patch: ${JSON.stringify(patchBody.patches)}`);
    assert(patchBody.patches.some((patch) => patch.gid === stream.id && patch.prop === 'color' && String(patch.value).toLowerCase() === streamColor), `missing stream color patch: ${JSON.stringify(patchBody.patches)}`);
    assert(patchBody.patches.some((patch) => patch.gid === stream.id && patch.prop === 'linewidth' && Number(patch.value) === streamLinewidth), `missing stream linewidth patch: ${JSON.stringify(patchBody.patches)}`);
    assert(patchBody.patches.some((patch) => patch.gid === quiverMarker.id && patch.prop === 'facecolor' && String(patch.value).toLowerCase() === quiverColor), `missing quiver legend facecolor patch: ${JSON.stringify(patchBody.patches)}`);
    assert(patchBody.patches.some((patch) => patch.gid === quiverMarker.id && patch.prop === 'edgecolor' && String(patch.value).toLowerCase() === quiverColor), `missing quiver legend edgecolor patch: ${JSON.stringify(patchBody.patches)}`);
    assert(patchBody.patches.some((patch) => patch.gid === streamMarker.id && patch.prop === 'color' && String(patch.value).toLowerCase() === streamColor), `missing stream legend color patch: ${JSON.stringify(patchBody.patches)}`);
    assert(patchBody.patches.some((patch) => patch.gid === streamMarker.id && patch.prop === 'linewidth' && Number(patch.value) === streamLinewidth), `missing stream legend linewidth patch: ${JSON.stringify(patchBody.patches)}`);

    const expectedEdits = [
      { gid: quiver.id, prop: 'color', value: quiverColor },
      { gid: quiverMarker.id, prop: 'facecolor', value: quiverColor, mode: 'local_patch' },
      { gid: quiverMarker.id, prop: 'edgecolor', value: quiverColor, mode: 'local_patch' },
      { gid: stream.id, prop: 'color', value: streamColor },
      { gid: stream.id, prop: 'linewidth', value: streamLinewidth },
      { gid: streamMarker.id, prop: 'color', value: streamColor, mode: 'local_patch' },
      { gid: streamMarker.id, prop: 'linewidth', value: streamLinewidth },
    ];
    await waitForEdits(page, expectedEdits);
    let project = await requestJson(`/api/projects/${fixture.projectId}`);
    let persistedFigure = project.project?.figures?.find((figure) => figure.figureId === 'fig_1');
    assert(expectedEdits.every((edit) => hasEdit(persistedFigure?.editLog, edit)), `persisted project lost vector-field edits: ${JSON.stringify(persistedFigure?.editLog)}`);

    await saveCurrentProject(page);
    await page.reload({ waitUntil: 'networkidle', timeout: 30000 });
    await waitForWorkspaceReady(page);
    await waitForEdits(page, expectedEdits);

    const undoRender = await clickUndo(page);
    const undoFigure = undoRender.figures?.find((figure) => figure.figureId === 'fig_1');
    assert(expectedEdits.every((edit) => !hasEdit(undoFigure?.editLog, edit)), `undo retained vector-field edits: ${JSON.stringify(undoFigure?.editLog)}`);
    const undoState = await readFigureState(page);
    assert(expectedEdits.every((edit) => !hasEdit(undoState.editLog, edit)), `undo state retained vector-field edits: ${JSON.stringify(undoState.editLog)}`);

    const redoRender = await clickRedo(page);
    const redoFigure = redoRender.figures?.find((figure) => figure.figureId === 'fig_1');
    assert(expectedEdits.every((edit) => hasEdit(redoFigure?.editLog, edit)), `redo lost vector-field edits: ${JSON.stringify(redoFigure?.editLog)}`);
    await waitForEdits(page, expectedEdits);

    const exported = await requestJson(`/api/projects/${fixture.projectId}/export`, {
      method: 'POST',
      body: JSON.stringify({ figureId: 'fig_1', format: 'svg', dpi: 150, saveToLibrary: true }),
    });
    exportAsset = exported.figures?.[0]?.asset;
    assert(exportAsset?.assetId && exportAsset.hasEditingSnapshot === true, `export did not create snapshot: ${JSON.stringify(exportAsset)}`);
    const exportedSvg = String(exported.figures?.[0]?.svg || '').toLowerCase();
    assert(exportedSvg.includes(quiverColor) && exportedSvg.includes(streamColor), 'export SVG does not include vector-field export-time colors');

    await openComponentCenter(page);
    await clickSvgObject(page, quiver.id);
    await setColorInGroup(page, '矢量场 (Quiver)', '#1166aa');
    await applyCurrentDraft(page, 3);
    project = await requestJson(`/api/projects/${fixture.projectId}`);
    persistedFigure = project.project?.figures?.find((figure) => figure.figureId === 'fig_1');
    assert(hasEdit(persistedFigure?.editLog, { gid: quiver.id, prop: 'color', value: '#1166aa' }), 'later quiver edit did not persist before restore');

    const restored = await requestJson(`/api/projects/${fixture.projectId}/export-assets/${exportAsset.assetId}/restore`, { method: 'POST' });
    assert(restored.status === 'success', `restore failed: ${JSON.stringify(restored)}`);
    await page.reload({ waitUntil: 'networkidle', timeout: 30000 });
    await waitForWorkspaceReady(page);
    const restoredState = await waitForEdits(page, expectedEdits);
    assert(!hasEdit(restoredState.editLog, { gid: quiver.id, prop: 'color', value: '#1166aa' }), `restore retained later quiver edit: ${JSON.stringify(restoredState.editLog)}`);

    if (consoleErrors.length > 0 || pageErrors.length > 0) {
      throw new Error(`console errors=${JSON.stringify(consoleErrors)}, page errors=${JSON.stringify(pageErrors)}`);
    }

    console.log(JSON.stringify({
      status: 'PASS',
      projectId: fixture.projectId,
      assetId: exportAsset.assetId,
      checked: [
        'component center exposes separate Quiver and Streamplot groups',
        'quiver group has no scatter size controls',
        'streamplot child clicks resolve to parent selection',
        'backend draft patches update quiver color and streamplot line/arrow parent state',
        'save, refresh, undo, redo, export, and export snapshot restore preserve exact vector-field edit state',
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
