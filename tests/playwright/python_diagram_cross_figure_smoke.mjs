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
const TEST_PROJECT_PREFIX = 'Python diagram cross figure smoke';

let authToken = '';
const apiRequests = [];
const apiResponses = [];
const consoleErrors = [];
const pageErrors = [];

const SCRIPT = [
  'import matplotlib.pyplot as plt',
  'from matplotlib.patches import Circle, FancyArrowPatch, Rectangle',
  '',
  'NODE_A_COLOR = "#4477aa"',
  'NODE_B_COLOR = "#cc6677"',
  'EDGE_COLOR = "#333333"',
  'ARROW_COLOR = "#333333"',
  '',
  'def add_ordinary_lookalikes(ax, suffix):',
  '    ax.add_patch(Circle((0.20, 0.20), 0.08, facecolor=NODE_A_COLOR, edgecolor="#223355", linewidth=1.4, label=f"ordinary node {suffix}"))',
  '    ax.scatter([0.45], [0.20], s=[340], marker="s", c=[NODE_B_COLOR], edgecolors=["#663344"], linewidths=1.2, label=f"ordinary scatter {suffix}")',
  '    ax.plot([0.58, 0.86], [0.20, 0.20], color=EDGE_COLOR, linewidth=1.8, label=f"ordinary line {suffix}")',
  '    ax.add_patch(FancyArrowPatch((0.78, 0.20), (0.86, 0.20), arrowstyle="-|>", mutation_scale=14, facecolor=ARROW_COLOR, edgecolor=ARROW_COLOR, linewidth=1.2, label=f"ordinary arrow {suffix}"))',
  '    ax.text(0.72, 0.29, "beta = 0.42***", ha="center", va="bottom", color="#111111")',
  '',
  'def draw_sem(ax, title, diagram_id, edge_id, source_id, target_id, prefix_decoy=False):',
  '    if prefix_decoy:',
  '        ax.add_patch(Rectangle((0.01, 0.01), 0.05, 0.04, facecolor="#eeeeee", edgecolor="#999999", linewidth=0.6, label=f"gid shift {title}"))',
  '    latent = Circle(',
  '        (0.25, 0.62),',
  '        0.12,',
  '        facecolor=NODE_A_COLOR,',
  '        edgecolor="#223355",',
  '        linewidth=1.4,',
  '        gid=_scifigure_semantic_gid(diagram_id, "node", source_id, diagram_type="sem"),',
  '    )',
  '    ax.add_patch(latent)',
  '    ax.scatter(',
  '        [0.75],',
  '        [0.62],',
  '        s=[620],',
  '        marker="s",',
  '        c=[NODE_B_COLOR],',
  '        edgecolors=["#663344"],',
  '        linewidths=1.2,',
  '        gid=_scifigure_semantic_gid(diagram_id, "node", target_id, diagram_type="sem"),',
  '    )',
  '    ax.plot(',
  '        [0.37, 0.63],',
  '        [0.62, 0.62],',
  '        color=EDGE_COLOR,',
  '        linewidth=1.8,',
  '        gid=_scifigure_semantic_gid(',
  '            diagram_id,',
  '            "edge",',
  '            edge_id,',
  '            diagram_type="sem",',
  '            source_node_id=source_id,',
  '            target_node_id=target_id,',
  '        ),',
  '    )',
  '    ax.add_patch(FancyArrowPatch(',
  '        (0.57, 0.62),',
  '        (0.64, 0.62),',
  '        arrowstyle="-|>",',
  '        mutation_scale=14,',
  '        facecolor=ARROW_COLOR,',
  '        edgecolor=ARROW_COLOR,',
  '        linewidth=1.2,',
  '        gid=_scifigure_semantic_gid(',
  '            diagram_id,',
  '            "arrow",',
  '            "arrow_a_b",',
  '            diagram_type="sem",',
  '            edge_id=edge_id,',
  '            source_node_id=source_id,',
  '            target_node_id=target_id,',
  '        ),',
  '    ))',
  '    ax.text(',
  '        0.25,',
  '        0.62,',
  '        "Latent A",',
  '        ha="center",',
  '        va="center",',
  '        gid=_scifigure_semantic_gid(',
  '            diagram_id,',
  '            "node_label",',
  '            "label_latent_a",',
  '            diagram_type="sem",',
  '            node_id=source_id,',
  '        ),',
  '    )',
  '    ax.text(',
  '        0.50,',
  '        0.68,',
  '        "beta = 0.42***",',
  '        ha="center",',
  '        va="bottom",',
  '        color="#111111",',
  '        gid=_scifigure_semantic_gid(',
  '            diagram_id,',
  '            "coefficient_label",',
  '            "coef_a_b",',
  '            diagram_type="sem",',
  '            edge_id=edge_id,',
  '            source_node_id=source_id,',
  '            target_node_id=target_id,',
  '        ),',
  '    )',
  '    add_ordinary_lookalikes(ax, title)',
  '    ax.set(xlim=(0, 1), ylim=(0, 1), title=title)',
  '    ax.axis("off")',
  '',
  'fig_1, ax1 = plt.subplots(figsize=(4.0, 3.2))',
  'draw_sem(ax1, "Source SEM", "sem.demo", "latent_a_to_observed_b", "latent_a", "observed_b")',
  'fig_1.tight_layout()',
  '',
  'fig_2, ax2 = plt.subplots(figsize=(4.0, 3.2))',
  'draw_sem(ax2, "Matching SEM shifted IDs", "sem.demo", "latent_a_to_observed_b", "latent_a", "observed_b", prefix_decoy=True)',
  'fig_2.tight_layout()',
  '',
  'fig_3, ax3 = plt.subplots(figsize=(4.0, 3.2))',
  'draw_sem(ax3, "Lookalike wrong relation", "sem.other", "latent_a_to_observed_b", "latent_a", "observed_b")',
  'fig_3.tight_layout()',
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

async function createFixtureProject(scenarioName) {
  const spec = {
    plot_type: 'custom',
    custom_script: SCRIPT,
    script: SCRIPT,
    script_language: 'python',
    figure: { width: 120, height: 90, unit: 'mm', dpi: 300 },
  };
  const created = await requestJson('/api/projects', {
    method: 'POST',
    body: JSON.stringify({ name: `${TEST_PROJECT_PREFIX} ${scenarioName} ${Date.now()}`, spec }),
  });
  assert(created.id, `project creation failed: ${JSON.stringify(created)}`);
  const rendered = await requestJson(`/api/projects/${created.id}/figures/render`, {
    method: 'POST',
    body: JSON.stringify({
      script: SCRIPT,
      editLogs: { fig_1: [], fig_2: [], fig_3: [] },
      language: 'python',
      requestId: `python-diagram-cross-figure-${scenarioName}-${Date.now()}`,
    }),
  });
  assert(rendered.status === 'success' && rendered.figures?.length === 3, `fixture render failed: ${JSON.stringify(rendered)}`);
  return { projectId: created.id, spec, rendered };
}

function objectsFor(figure) {
  return figure?.manifest?.objects || [];
}

function objectById(figureSummary, figureId, gid) {
  return (figureSummary[figureId] || []).find((object) => object.id === gid) || null;
}

function byRole(figure, role, label) {
  const matches = objectsFor(figure).filter((object) => object.role === role);
  assert(matches.length > 0, `${label} missing ${role}`);
  return matches;
}

function firstByRole(figure, role, label) {
  return byRole(figure, role, label)[0];
}

function relationOf(object) {
  return object?.identity?.relation || {};
}

function assertCompleteRelation(object, label) {
  const relation = relationOf(object);
  for (const field of ['diagramId', 'diagramType', 'diagramObjectId']) {
    assert(typeof relation[field] === 'string' && relation[field], `${label} missing ${field}: ${JSON.stringify(object)}`);
  }
  if (object.role === 'diagram_node' || object.role === 'diagram_node_label') {
    assert(typeof relation.nodeId === 'string' && relation.nodeId, `${label} missing nodeId`);
  }
  if (['diagram_edge', 'diagram_arrow', 'diagram_coefficient_label'].includes(object.role)) {
    for (const field of ['edgeId', 'sourceNodeId', 'targetNodeId']) {
      assert(typeof relation[field] === 'string' && relation[field], `${label} missing ${field}: ${JSON.stringify(object)}`);
    }
  }
}

function diagramObjects(figure, label) {
  const objects = {
    node: firstByRole(figure, 'diagram_node', label),
    edge: firstByRole(figure, 'diagram_edge', label),
    arrow: firstByRole(figure, 'diagram_arrow', label),
    coefficient: firstByRole(figure, 'diagram_coefficient_label', label),
  };
  Object.entries(objects).forEach(([key, object]) => assertCompleteRelation(object, `${label}.${key}`));
  return objects;
}

function sameRelation(left, right, fields) {
  const leftRelation = relationOf(left);
  const rightRelation = relationOf(right);
  return fields.every((field) => leftRelation[field] === rightRelation[field]);
}

function prepareRenderedFixture(fixture, scenario) {
  const figures = fixture.rendered.figures;
  const fig1 = figures.find((figure) => figure.figureId === 'fig_1');
  const fig2 = figures.find((figure) => figure.figureId === 'fig_2');
  const fig3 = figures.find((figure) => figure.figureId === 'fig_3');
  assert(fig1 && fig2 && fig3, 'fixture missing expected fig_1/fig_2/fig_3');

  const source = diagramObjects(fig1, 'fig_1');
  const matching = diagramObjects(fig2, 'fig_2');
  const closed = diagramObjects(fig3, 'fig_3');
  for (const object of [source.coefficient, matching.coefficient, closed.coefficient]) {
    delete object.stableKey;
    delete object.fingerprint;
    delete object.fingerprintVersion;
  }
  const relationFields = {
    node: ['diagramId', 'diagramType', 'diagramObjectId', 'nodeId'],
    edge: ['diagramId', 'diagramType', 'diagramObjectId', 'edgeId', 'sourceNodeId', 'targetNodeId'],
    arrow: ['diagramId', 'diagramType', 'diagramObjectId', 'edgeId', 'sourceNodeId', 'targetNodeId'],
    coefficient: ['diagramId', 'diagramType', 'diagramObjectId', 'edgeId', 'sourceNodeId', 'targetNodeId'],
  };

  for (const key of Object.keys(source)) {
    assert(sameRelation(source[key], matching[key], relationFields[key]), `fig_2 ${key} relation does not exactly match source`);
  }
  assert(
    Object.keys(source).some((key) => source[key].id !== matching[key].id),
    `fig_2 should exercise semantic mapping across different generated GIDs: ${JSON.stringify({ source, matching })}`,
  );
  assert(
    Object.keys(source).every((key) => !sameRelation(source[key], closed[key], relationFields[key])),
    'fig_3 unexpectedly starts with matching semantic relation',
  );

  if (scenario === 'missing-relation') {
    delete closed.node.identity.relation.nodeId;
    delete closed.edge.identity.relation.sourceNodeId;
    delete closed.arrow.identity.relation.targetNodeId;
    delete closed.coefficient.identity.relation.targetNodeId;
  }

  if (scenario === 'duplicate-relation') {
    const fig3Objects = objectsFor(fig3);
    for (const key of Object.keys(source)) {
      const duplicate = structuredClone(closed[key]);
      duplicate.id = `${closed[key].id}.duplicate`;
      duplicate.stableKey = `${closed[key].stableKey || closed[key].id}.duplicate`;
      duplicate.fingerprint = `${closed[key].fingerprint || closed[key].id}.duplicate`;
      duplicate.identity = structuredClone(source[key].identity);
      duplicate.identity.instanceKey = `${source[key].identity?.instanceKey || source[key].id}:duplicate`;
      duplicate.identity.seriesKey = source[key].identity?.seriesKey;
      duplicate.label = source[key].label;
      closed[key].identity = structuredClone(source[key].identity);
      closed[key].identity.instanceKey = `${source[key].identity?.instanceKey || source[key].id}:primary-duplicate`;
      closed[key].identity.seriesKey = source[key].identity?.seriesKey;
      closed[key].label = source[key].label;
      fig3Objects.push(duplicate);
    }
  }

  return { source, matching, closed };
}

function figureSummaryFrom(rendered) {
  return Object.fromEntries(rendered.figures.map((figure) => [
    figure.figureId,
    objectsFor(figure).map((object) => ({
      id: object.id,
      kind: object.kind,
      role: object.role,
      identity: object.identity || {},
      stableKey: object.stableKey,
      fingerprint: object.fingerprint,
      fingerprintVersion: object.fingerprintVersion,
      currentProps: object.currentProps || {},
    })),
  ]));
}

async function installFixtureState(page, fixture, scenarioName) {
  await page.evaluate(({ spec, rendered, projectId, scenarioName }) => {
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
      projectName: `Python diagram cross figure smoke ${scenarioName}`,
      projectFigures,
      activeFigureId: 'fig_1',
      selectedFigureIds: ['fig_1'],
      datasets: [],
      selectedGids: [],
      projectHistory: {},
      projectDrafts: {},
      currentView: 'workspace',
      subView: 'home',
      renderLog: [`> Python diagram cross-figure fixture ready: ${scenarioName}`],
      figSession: null,
    }));
  }, { ...fixture, scenarioName });
  await page.reload({ waitUntil: 'networkidle', timeout: 30000 });
  await waitForWorkspaceReady(page);
}

async function getBodyText(page) {
  return (await page.textContent('body').catch(() => '')) || '';
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
    const rendering = body.includes('正在恢复项目预览')
      || body.includes('正在重新渲染当前图形')
      || body.includes('等待 Python 渲染结果');
    if (svgCount > 0 && body.includes('属性编辑') && !rendering) return;
    await page.waitForTimeout(500);
  }
  throw new Error(`workspace did not become ready: svg=${lastSvgCount}, body=${lastBody.slice(0, 800)}`);
}

async function openComponentCenter(page) {
  await page.getByRole('button', { name: '组件中心', exact: true }).click();
  await page.waitForTimeout(400);
}

function group(page, label) {
  return page.locator(`[data-component-group-label="${label}"]`).first();
}

async function clickSvgObject(page, gid) {
  const target = page.locator(`svg [id="${gid}"], svg [data-fig-id="${gid}"]`).first();
  await target.waitFor({ state: 'attached', timeout: 30000 });
  const leaf = target.locator('path, rect, use, polygon, polyline, circle, ellipse').first();
  const clickable = await leaf.count() > 0 ? leaf : target;
  const box = await clickable.boundingBox();
  await clickable.dispatchEvent('click', {
    button: 0,
    clientX: box ? box.x + box.width / 2 : 1,
    clientY: box ? box.y + box.height / 2 : 1,
  });
  await page.waitForTimeout(400);
}

async function selectComponentObject(page, label, gid) {
  const button = group(page, label).locator(`button[data-component-object-id="${gid}"]`).first();
  await button.waitFor({ state: 'visible', timeout: 30000 });
  await button.scrollIntoViewIfNeeded().catch(() => {});
  await button.click();
  await page.waitForTimeout(400);
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
  const patchResponses = apiResponses.slice(start)
    .filter((response) => new URL(response.url).pathname === '/api/figure/patch');
  const fullRenderCalls = apiRequests.slice(start)
    .filter((request) => new URL(request.url).pathname.endsWith('/figures/render'));
  const successful = patchRequests.length > 0
    && patchResponses.length === patchRequests.length
    && patchResponses.every((response) => (
      response.status >= 200
      && response.status < 300
      && response.body?.status === 'success'
    ));
  return { start, patchRequests, patchBodies, patchResponses, successful, fullRenderCalls };
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
      identity: patch.identity || null,
      relation: object?.identity?.relation || null,
    };
  }));
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

function expectedEdits(objects, values) {
  return [
    { gid: objects.node.id, prop: 'facecolor', value: values.nodeFacecolor, mode: 'backend_patch' },
    { gid: objects.edge.id, prop: 'linewidth', value: values.edgeLinewidth, mode: 'backend_patch' },
    { gid: objects.arrow.id, prop: 'facecolor', value: values.arrowColor, mode: 'backend_patch' },
    { gid: objects.coefficient.id, prop: 'color', value: values.coefficientColor, mode: 'backend_patch' },
  ];
}

async function editSourceDiagramStyles(page, source, values) {
  await selectComponentObject(page, '图示节点', source.node.id);
  await setColorInGroup(page, '图示节点', values.nodeFacecolor);
  await selectComponentObject(page, '图示连线 / 路径', source.edge.id);
  await setNumberInGroup(page, '图示连线 / 路径', 'linewidth', values.edgeLinewidth);
  await selectComponentObject(page, '图示箭头', source.arrow.id);
  await setColorInGroup(page, '图示箭头', values.arrowColor);
  await selectComponentObject(page, '路径系数标签', source.coefficient.id);
  await setColorInGroup(page, '路径系数标签', values.coefficientColor);
  assert((await getBodyText(page)).includes('已暂存'), 'draft indicator did not appear after source diagram edits');
}

function assertExactCrossFigurePatches(applied, figureSummary, vectors, values, scenarioName) {
  assert(applied.successful, `${scenarioName} apply-all patch requests failed: ${JSON.stringify({ requests: applied.patchBodies, responses: applied.patchResponses })}`);
  assert(applied.fullRenderCalls.length === 0, `${scenarioName} apply-all called project figures/render: ${JSON.stringify(applied.fullRenderCalls)}`);
  const patchBodiesByFigure = Object.fromEntries(applied.patchBodies.map((body) => [body?.figureId, body]));
  const patchedFigureIds = Object.keys(patchBodiesByFigure).sort();
  assert(
    JSON.stringify(patchedFigureIds) === JSON.stringify(['fig_1', 'fig_2']),
    `${scenarioName} unexpected patched figures: ${JSON.stringify({ patchedFigureIds, patchBodies: applied.patchBodies })}`,
  );
  assert(!patchBodiesByFigure.fig_3, `${scenarioName} fail-closed fig_3 received patches: ${JSON.stringify(patchBodiesByFigure.fig_3)}`);

  const patches = patchSummary(figureSummary, applied.patchBodies);
  assert(patches.length === 8, `${scenarioName} expected 8 diagram style patches, got ${JSON.stringify(patches)}`);
  assert(patches.every((patch) => patch.type !== 'code_patch' && patch.gid !== 'code_patch'), `${scenarioName} leaked code_patch: ${JSON.stringify(patches)}`);
  assert(patches.every((patch) => patch.mode === 'backend_patch'), `${scenarioName} patch batch was not backend-only: ${JSON.stringify(patches)}`);
  assert(!patches.some((patch) => !String(patch.role || '').startsWith('diagram_')), `${scenarioName} ordinary lookalike was modified: ${JSON.stringify(patches)}`);

  const expectedByRole = new Map([
    ['diagram_node', { prop: 'facecolor', value: values.nodeFacecolor }],
    ['diagram_edge', { prop: 'linewidth', value: values.edgeLinewidth }],
    ['diagram_arrow', { prop: 'facecolor', value: values.arrowColor }],
    ['diagram_coefficient_label', { prop: 'color', value: values.coefficientColor }],
  ]);
  for (const patch of patches) {
    const expected = expectedByRole.get(patch.role);
    assert(expected, `${scenarioName} patched unexpected role: ${JSON.stringify(patch)}`);
    const valueOk = typeof expected.value === 'number'
      ? Math.abs(Number(patch.value) - expected.value) < 0.001
      : String(patch.value).toLowerCase() === String(expected.value).toLowerCase();
    assert(patch.prop === expected.prop && valueOk, `${scenarioName} unexpected patch prop/value: ${JSON.stringify(patch)}`);
  }

  const fig2Patches = patches.filter((patch) => patch.figureId === 'fig_2');
  for (const [key, object] of Object.entries(vectors.matching)) {
    const role = object.role;
    const expected = expectedByRole.get(role);
    const patch = fig2Patches.find((candidate) => candidate.gid === object.id && candidate.prop === expected.prop);
    assert(patch, `${scenarioName} fig_2 missing mapped ${key}: ${JSON.stringify(fig2Patches)}`);
    assert(JSON.stringify(patch.identity?.relation || {}) === JSON.stringify(object.identity?.relation || {}), `${scenarioName} fig_2 patch lost target identity: ${JSON.stringify(patch)}`);
  }

  return { patchedFigureIds, patches };
}

async function runScenario(page, scenarioName, values) {
  const fixture = await createFixtureProject(scenarioName);
  try {
    const vectors = prepareRenderedFixture(fixture, scenarioName);
    const figureSummary = figureSummaryFrom(fixture.rendered);
    await installFixtureState(page, fixture, scenarioName);
    await openComponentCenter(page);

    const labels = await page.locator('.scifig-editor-panel-right [data-component-group-label]')
      .evaluateAll((nodes) => nodes.map((node) => node.getAttribute('data-component-group-label')));
    for (const expected of ['图示节点', '图示连线 / 路径', '图示箭头', '路径系数标签']) {
      assert(labels.includes(expected), `${scenarioName} component center missing ${expected}: ${JSON.stringify(labels)}`);
    }

    await editSourceDiagramStyles(page, vectors.source, values);
    const applied = await applyAllAndReadPatches(page);
    const patchEvidence = assertExactCrossFigurePatches(applied, figureSummary, vectors, values, scenarioName);
    assert((await getBodyText(page)).includes('fig_3') && (await getBodyText(page)).includes('跳过'), `${scenarioName} report did not show skipped fail-closed target`);

    const project = await requestJson(`/api/projects/${fixture.projectId}`);
    const figures = Object.fromEntries((project.project?.figures || []).map((figure) => [figure.figureId, figure]));
    assertEditLogExactly(figures.fig_1, expectedEdits(vectors.source, values), `${scenarioName}.fig_1`);
    assertEditLogExactly(figures.fig_2, expectedEdits(vectors.matching, values), `${scenarioName}.fig_2`);
    assertEditLogExactly(figures.fig_3, [], `${scenarioName}.fig_3`);

    return {
      scenarioName,
      projectId: fixture.projectId,
      patchedFigureIds: patchEvidence.patchedFigureIds,
      patches: patchEvidence.patches,
      requestBodies: applied.patchBodies,
      responseState: applied.patchResponses,
    };
  } finally {
    await requestJson(`/api/projects/${fixture.projectId}`, { method: 'DELETE' }).catch(() => null);
  }
}

async function main() {
  assertIsolatedEnvironment();
  authToken = await authenticateCapabilitySmokeUser(BASE_URL, 'python diagram cross figure');
  await cleanupSmokeProjects();

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
  page.on('response', async (response) => {
    if (isInterestingApi(response.request())) {
      let body = null;
      try {
        body = await response.json();
      } catch {
        body = null;
      }
      apiResponses.push({
        method: response.request().method(),
        url: response.url(),
        status: response.status(),
        postData: response.request().postData(),
        body,
      });
    }
  });

  try {
    await page.goto(BASE_URL, { waitUntil: 'domcontentloaded', timeout: 30000 });
    const scenarios = [
      ['different-relation', {
        nodeFacecolor: '#228833',
        edgeLinewidth: 2.35,
        arrowColor: '#aa3377',
        coefficientColor: '#661100',
      }],
      ['missing-relation', {
        nodeFacecolor: '#ddcc77',
        edgeLinewidth: 2.85,
        arrowColor: '#117733',
        coefficientColor: '#114477',
      }],
      ['duplicate-relation', {
        nodeFacecolor: '#88ccee',
        edgeLinewidth: 3.1,
        arrowColor: '#cc6677',
        coefficientColor: '#552288',
      }],
    ];
    const results = [];
    for (const [scenarioName, values] of scenarios) {
      results.push(await runScenario(page, scenarioName, values));
    }

    if (consoleErrors.length > 0 || pageErrors.length > 0) {
      throw new Error(`console errors=${JSON.stringify(consoleErrors)}, page errors=${JSON.stringify(pageErrors)}`);
    }

    console.log(JSON.stringify({
      status: 'PASS',
      checked: [
        'fig_2 receives only exact complete diagram relation counterparts despite different generated GIDs',
        'node, edge, arrow, and coefficient-label style edits use backend_patch mode with target identities',
        'fig_3 same-color/same-label lookalikes with different, missing, or duplicate relation metadata receive no patches',
        'ordinary non-diagram primitives receive no patches',
        'missing and duplicate relation cases leave fig_3 revision/editLog unchanged after apply',
        'apply-all does not call project-wide figures/render',
      ],
      scenarios: results.map((result) => ({
        scenarioName: result.scenarioName,
        projectId: result.projectId,
        patchedFigureIds: result.patchedFigureIds,
        patchCount: result.patches.length,
        responseState: result.responseState.map((response) => ({
          method: response.method,
          pathname: new URL(response.url).pathname,
          status: response.status,
        })),
        requestBodies: result.requestBodies,
      })),
    }, null, 2));
  } finally {
    await browser.close();
    await cleanupSmokeProjects().catch(() => null);
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
