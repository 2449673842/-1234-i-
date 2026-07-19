import { chromium } from 'playwright';
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
const TEST_PROJECT_PREFIX = 'Python vector field cross figure smoke';

let authToken = '';
const apiRequests = [];
const apiResponses = [];
const consoleErrors = [];
const pageErrors = [];

const SCRIPT = [
  'import numpy as np',
  'import matplotlib.pyplot as plt',
  'from matplotlib.patches import Rectangle',
  '',
  'grid = np.linspace(-2.0, 2.0, 7)',
  'x, y = np.meshgrid(grid, grid)',
  'u = -y',
  'v = x',
  '',
  'def add_decoys(ax, idx):',
  '    ax.scatter([-1.5, 0.0, 1.5], [0.8, -0.5, 0.5], c="#999999", alpha=0.5, label=f"ordinary collection {idx}")',
  '    ax.add_patch(Rectangle((-1.8, -1.8), 0.45, 0.35, facecolor="#777777", edgecolor="#333333", alpha=0.55, label=f"ordinary patch {idx}"))',
  '',
  'def draw_matching(fig, idx):',
  '    quiver_ax, stream_ax = fig.subplots(1, 2)',
  '    quiver_ax.quiver(x, y, u, v, color="#4477aa", alpha=0.72, linewidth=1.1)',
  '    add_decoys(quiver_ax, idx)',
  '    quiver_ax.set_title(f"Matching quiver {idx}")',
  '    quiver_ax.set_xlabel("qx")',
  '    quiver_ax.set_ylabel("qy")',
  '    stream_ax.streamplot(x, y, u, v, color="#228833", density=0.65, linewidth=1.25, arrowsize=1.1)',
  '    add_decoys(stream_ax, idx + 10)',
  '    stream_ax.set_title(f"Matching stream {idx}")',
  '    stream_ax.set_xlabel("sx")',
  '    stream_ax.set_ylabel("sy")',
  '    fig.tight_layout()',
  '',
  'fig1 = plt.figure(figsize=(7.2, 3.4))',
  'draw_matching(fig1, 1)',
  '',
  'fig2 = plt.figure(figsize=(7.2, 3.4))',
  'draw_matching(fig2, 2)',
  '',
  'fig3, (decoy_ax, quiver_ax, stream_ax) = plt.subplots(1, 3, figsize=(9.2, 3.2))',
  'add_decoys(decoy_ax, 30)',
  'decoy_ax.set_title("Ordinary decoys")',
  'quiver_ax.quiver(x, y, u * 0.8, v * 0.8, color="#aa7744", alpha=0.72, linewidth=1.1)',
  'add_decoys(quiver_ax, 31)',
  'quiver_ax.set_title("Different quiver relation")',
  'stream_ax.streamplot(x, y, u * 1.15, v * 1.15, color="#668855", density=0.65, linewidth=1.25, arrowsize=1.1)',
  'add_decoys(stream_ax, 32)',
  'stream_ax.set_title("Missing stream relation")',
  'fig3.tight_layout()',
].join('\n');

function assert(condition, message) {
  if (!condition) throw new Error(message);
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
  assert(path.basename(path.dirname(path.resolve(dataDir))).startsWith('scifigure-isolated-smoke-'), `unsafe data dir: ${dataDir}`);
  assert(path.resolve(dbPath).startsWith(path.resolve(dataDir) + path.sep), `unsafe DB path: ${dbPath}`);
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

function isInterestingApi(request) {
  const pathname = new URL(request.url()).pathname;
  return pathname.startsWith('/api/figure') || pathname.startsWith('/api/projects');
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

async function createFixtureProject() {
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
  assert(created.id, `project creation failed: ${JSON.stringify(created)}`);
  const rendered = await requestJson(`/api/projects/${created.id}/figures/render`, {
    method: 'POST',
    body: JSON.stringify({
      script: SCRIPT,
      editLogs: { fig_1: [], fig_2: [], fig_3: [] },
      language: 'python',
      requestId: `python-vector-cross-figure-${Date.now()}`,
    }),
  });
  assert(rendered.status === 'success' && rendered.figures?.length === 3, `fixture render failed: ${JSON.stringify(rendered)}`);
  return { projectId: created.id, spec, rendered };
}

function objectsFor(figure) {
  return figure?.manifest?.objects || [];
}

function findVectorObjects(figure, label) {
  const objects = objectsFor(figure);
  const quiver = objects.find((object) => object.kind === 'quiver' && object.role === 'quiver_field');
  const stream = objects.find((object) => object.kind === 'streamplot' && object.role === 'streamplot_field');
  const streamLine = objects.find((object) => object.role === 'streamplot_child_line');
  const streamArrow = objects.find((object) => object.role === 'streamplot_child_arrow');
  assert(quiver, `${label} missing quiver parent`);
  assert(stream, `${label} missing streamplot parent`);
  assert(stream.children?.includes(streamLine?.id) && stream.children?.includes(streamArrow?.id), `${label} streamplot children are not parent-owned`);
  return { quiver, stream, streamLine, streamArrow };
}

function objectById(figureSummary, figureId, gid) {
  return (figureSummary[figureId] || []).find((object) => object.id === gid) || null;
}

function patchList(body) {
  return Array.isArray(body?.patches) ? body.patches : [];
}

function patchSummary(figureSummary, patchBodies) {
  return patchBodies.flatMap((body) => patchList(body).map((patch) => {
    const object = objectById(figureSummary, body?.figureId, patch.gid);
    return {
      figureId: body?.figureId,
      gid: patch.gid,
      prop: patch.prop,
      value: patch.value,
      mode: patch.mode,
      type: patch.type,
      kind: object?.kind || null,
      role: object?.role || null,
      relation: object?.identity?.relation || null,
    };
  }));
}

function prepareRenderedFixture(fixture) {
  const figures = fixture.rendered.figures;
  const fig1 = figures.find((figure) => figure.figureId === 'fig_1');
  const fig2 = figures.find((figure) => figure.figureId === 'fig_2');
  const fig3 = figures.find((figure) => figure.figureId === 'fig_3');
  const source = findVectorObjects(fig1, 'fig_1');
  const matching = findVectorObjects(fig2, 'fig_2');
  const closed = findVectorObjects(fig3, 'fig_3');

  assert(source.quiver.identity?.relation?.quiverId === matching.quiver.identity?.relation?.quiverId, 'fig_2 quiver relation does not match source');
  assert(source.stream.identity?.relation?.streamplotId === matching.stream.identity?.relation?.streamplotId, 'fig_2 streamplot relation does not match source');
  assert(source.quiver.identity?.relation?.quiverId !== closed.quiver.identity?.relation?.quiverId, 'fig_3 quiver relation unexpectedly matches source');
  assert(source.stream.identity?.relation?.streamplotId !== closed.stream.identity?.relation?.streamplotId, 'fig_3 streamplot relation unexpectedly matches source before missing-relation mutation');

  const streamRelation = closed.stream.identity?.relation || {};
  delete streamRelation.streamplotId;
  closed.stream.identity = {
    ...(closed.stream.identity || {}),
    relation: streamRelation,
  };

  assert(!closed.stream.identity?.relation?.streamplotId, 'fig_3 streamplot relation mutation failed');
  return { source, matching, closed };
}

async function installFixtureState(page, fixture) {
  await page.evaluate(({ spec, rendered, projectId }) => {
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
      projectName: 'Python vector field cross figure smoke',
      projectFigures,
      activeFigureId: 'fig_1',
      selectedFigureIds: ['fig_1'],
      datasets: [],
      selectedGids: [],
      projectHistory: {},
      projectDrafts: {},
      currentView: 'workspace',
      subView: 'home',
      renderLog: ['> Python vector field cross-figure fixture ready'],
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
    const svgCount = await page.locator('svg').count().catch(() => 0);
    const rendering = body.includes('正在恢复项目预览')
      || body.includes('正在重新渲染当前图形')
      || body.includes('等待 Python 渲染结果');
    if (svgCount > 0 && body.includes('属性编辑') && !rendering) return;
    await page.waitForTimeout(500);
  }
  throw new Error(`workspace did not become ready: ${lastBody.slice(0, 600)}`);
}

async function openComponentCenter(page) {
  await page.getByRole('button', { name: '组件中心', exact: true }).click();
  await page.waitForTimeout(400);
}

function group(page, label) {
  return page.locator(`[data-component-group-label="${label}"]`).first();
}

async function setColorInGroup(page, label, value) {
  const input = group(page, label).locator('input[data-color-role="text"]').first();
  await input.waitFor({ state: 'visible', timeout: 30000 });
  await input.scrollIntoViewIfNeeded().catch(() => {});
  await input.fill(value);
  await input.press('Enter').catch(() => {});
  await input.evaluate((node) => node.blur()).catch(() => {});
  await page.waitForTimeout(600);
}

async function setNumberInGroup(page, label, prop, value) {
  const input = group(page, label).locator(`input[data-param-role="number"][data-param-prop="${prop}"]`).first();
  await input.waitFor({ state: 'visible', timeout: 30000 });
  await input.scrollIntoViewIfNeeded().catch(() => {});
  await input.fill(String(value));
  await input.press('Enter').catch(() => {});
  await input.evaluate((node) => node.blur()).catch(() => {});
  await page.waitForTimeout(600);
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
  await page.waitForTimeout(400);
}

async function waitForApiSettle(startIndex, timeoutMs = 90000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    await new Promise((resolve) => setTimeout(resolve, 350));
    const recent = apiResponses.slice(startIndex);
    const pendingCount = apiRequests.slice(startIndex).length - recent.length;
    if (pendingCount <= 0 && recent.length > 0) return recent;
  }
  return apiResponses.slice(startIndex);
}

async function applyAllAndReadPatches(page) {
  const start = apiRequests.length;
  await page.getByRole('button', { name: '应用全部图', exact: true }).click();
  await waitForApiSettle(start, 90000);
  await waitForWorkspaceReady(page);
  const patchRequests = apiRequests.slice(start)
    .filter((request) => new URL(request.url).pathname === '/api/figure/patch');
  const patchBodies = patchRequests.map((request) => parseJson(request.postData));
  const successful = patchRequests.length > 0
    && apiResponses.slice(start)
      .filter((response) => new URL(response.url).pathname === '/api/figure/patch')
      .every((response) => response.status >= 200 && response.status < 300);
  const fullRenderCalls = apiRequests.slice(start)
    .filter((request) => new URL(request.url).pathname.endsWith('/figures/render'));
  return { start, patchRequests, patchBodies, successful, fullRenderCalls };
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
  return Array.isArray(editLog) && editLog.some((entry) => {
    const valueOk = typeof expected.value === 'number'
      ? Math.abs(Number(entry?.value) - expected.value) < 0.001
      : String(entry?.value || '').toLowerCase() === String(expected.value).toLowerCase();
    return entry?.gid === expected.gid
      && entry?.prop === expected.prop
      && valueOk
      && (!expected.mode || entry?.mode === expected.mode);
  });
}

function assertEditLogExactly(figure, expectedEdits, label) {
  const editLog = figure?.editLog || [];
  assert(editLog.length === expectedEdits.length, `${label} editLog length mismatch: ${JSON.stringify(editLog)}`);
  for (const expected of expectedEdits) {
    assert(editLogHasEntry(editLog, expected), `${label} missing editLog entry ${JSON.stringify(expected)} in ${JSON.stringify(editLog)}`);
  }
}

async function main() {
  assertIsolatedEnvironment();
  authToken = await authenticateCapabilitySmokeUser(BASE_URL, 'python vector field cross figure');
  await cleanupSmokeProjects();

  const fixture = await createFixtureProject();
  const vectors = prepareRenderedFixture(fixture);
  const figureSummary = Object.fromEntries(fixture.rendered.figures.map((figure) => [
    figure.figureId,
    objectsFor(figure).map((object) => ({
      id: object.id,
      kind: object.kind,
      role: object.role,
      identity: object.identity || {},
      currentProps: object.currentProps || {},
    })),
  ]));

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
    if (isInterestingApi(request)) {
      apiRequests.push({ method: request.method(), url: request.url(), postData: request.postData() });
    }
  });
  page.on('response', (response) => {
    if (isInterestingApi(response.request())) {
      apiResponses.push({
        method: response.request().method(),
        url: response.url(),
        status: response.status(),
        postData: response.request().postData(),
      });
    }
  });

  const quiverColor = '#cc6677';
  const streamColor = '#8844bb';
  const streamLinewidth = 2.05;

  try {
    await page.goto(BASE_URL, { waitUntil: 'domcontentloaded', timeout: 30000 });
    await installFixtureState(page, fixture);
    await openComponentCenter(page);

    const labels = await page.locator('.scifig-editor-panel-right [data-component-group-label]')
      .evaluateAll((nodes) => nodes.map((node) => node.getAttribute('data-component-group-label')));
    assert(labels.includes('矢量场 (Quiver)'), `component center missing Quiver group: ${JSON.stringify(labels)}`);
    assert(labels.includes('流线场 (Streamplot)'), `component center missing Streamplot group: ${JSON.stringify(labels)}`);

    await clickSvgObject(page, vectors.source.quiver.id);
    await setColorInGroup(page, '矢量场 (Quiver)', quiverColor);
    await clickSvgObject(page, vectors.source.streamLine.id);
    await setColorInGroup(page, '流线场 (Streamplot)', streamColor);
    await setNumberInGroup(page, '流线场 (Streamplot)', 'linewidth', streamLinewidth);
    assert((await getBodyText(page)).includes('已暂存'), 'draft indicator did not appear after source vector-field edits');

    const applied = await applyAllAndReadPatches(page);
    assert(applied.successful, `apply-all patch requests failed: ${JSON.stringify(applied.patchBodies)}`);
    assert(applied.fullRenderCalls.length === 0, `apply-all called project figures/render: ${JSON.stringify(applied.fullRenderCalls)}`);

    const patchBodiesByFigure = Object.fromEntries(applied.patchBodies.map((body) => [body?.figureId, body]));
    const patchedFigureIds = Object.keys(patchBodiesByFigure).sort();
    assert(
      JSON.stringify(patchedFigureIds) === JSON.stringify(['fig_1', 'fig_2']),
      `unexpected patched figures: ${JSON.stringify({ patchedFigureIds, patchBodies: applied.patchBodies })}`,
    );
    assert(!patchBodiesByFigure.fig_3, `fail-closed fig_3 received patches: ${JSON.stringify(patchBodiesByFigure.fig_3)}`);

    const patches = patchSummary(figureSummary, applied.patchBodies);
    assert(patches.length === 6, `expected 6 vector-field patches, got ${JSON.stringify(patches)}`);
    assert(patches.every((patch) => patch.type !== 'code_patch' && patch.gid !== 'code_patch'), `cross-figure apply leaked code_patch: ${JSON.stringify(patches)}`);
    assert(patches.every((patch) => (
      (patch.kind === 'quiver' && patch.role === 'quiver_field' && patch.prop === 'color' && String(patch.value).toLowerCase() === quiverColor)
      || (patch.kind === 'streamplot' && patch.role === 'streamplot_field' && patch.prop === 'color' && String(patch.value).toLowerCase() === streamColor)
      || (patch.kind === 'streamplot' && patch.role === 'streamplot_field' && patch.prop === 'linewidth' && Math.abs(Number(patch.value) - streamLinewidth) < 0.001)
    )), `apply-all patched non-vector or unexpected props: ${JSON.stringify(patches)}`);
    assert(!patches.some((patch) => patch.kind === 'collection' || patch.kind === 'patch'), `ordinary collection/patch was modified: ${JSON.stringify(patches)}`);

    const fig2Patches = patches.filter((patch) => patch.figureId === 'fig_2');
    assert(fig2Patches.some((patch) => patch.gid === vectors.matching.quiver.id && patch.prop === 'color'), `fig_2 missing mapped quiver color: ${JSON.stringify(fig2Patches)}`);
    assert(fig2Patches.some((patch) => patch.gid === vectors.matching.stream.id && patch.prop === 'color'), `fig_2 missing mapped stream color: ${JSON.stringify(fig2Patches)}`);
    assert(fig2Patches.some((patch) => patch.gid === vectors.matching.stream.id && patch.prop === 'linewidth'), `fig_2 missing mapped stream linewidth: ${JSON.stringify(fig2Patches)}`);
    assert((await getBodyText(page)).includes('fig_3') && (await getBodyText(page)).includes('跳过'), 'cross-figure report did not show skipped fail-closed target');

    await saveCurrentProject(page);
    const project = await requestJson(`/api/projects/${fixture.projectId}`);
    const figures = Object.fromEntries((project.project?.figures || []).map((figure) => [figure.figureId, figure]));
    const expectedFig1 = [
      { gid: vectors.source.quiver.id, prop: 'color', value: quiverColor, mode: 'backend_patch' },
      { gid: vectors.source.stream.id, prop: 'color', value: streamColor, mode: 'backend_patch' },
      { gid: vectors.source.stream.id, prop: 'linewidth', value: streamLinewidth, mode: 'backend_patch' },
    ];
    const expectedFig2 = [
      { gid: vectors.matching.quiver.id, prop: 'color', value: quiverColor, mode: 'backend_patch' },
      { gid: vectors.matching.stream.id, prop: 'color', value: streamColor, mode: 'backend_patch' },
      { gid: vectors.matching.stream.id, prop: 'linewidth', value: streamLinewidth, mode: 'backend_patch' },
    ];
    assertEditLogExactly(figures.fig_1, expectedFig1, 'fig_1');
    assertEditLogExactly(figures.fig_2, expectedFig2, 'fig_2');
    assertEditLogExactly(figures.fig_3, [], 'fig_3');

    if (consoleErrors.length > 0 || pageErrors.length > 0) {
      throw new Error(`console errors=${JSON.stringify(consoleErrors)}, page errors=${JSON.stringify(pageErrors)}`);
    }

    console.log(JSON.stringify({
      status: 'PASS',
      projectId: fixture.projectId,
      patchedFigureIds,
      checked: [
        'same quiverId and streamplotId target Figure maps visual attributes with apply-all',
        'different quiver relation and missing streamplot relation fail closed',
        'ordinary collection and patch decoys are not modified',
        'apply-all does not call project-wide figures/render',
        'saved project editLog is exact for fig_1, fig_2, and fig_3',
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
