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
const FIXTURE_PATH = path.join(ROOT, 'tests/fixtures/capability_matrix/r/network_path_sem.R');
const SCRIPT = fs.readFileSync(FIXTURE_PATH, 'utf8');
const TEST_PROJECT_PREFIX = 'R WP7 diagram semantics smoke';
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
  assert(BASE_URL, 'SCIFIGURE_URL is required from the isolated server wrapper');
  const url = new URL(BASE_URL);
  assert(url.hostname === '127.0.0.1', `test must target isolated 127.0.0.1 server, got ${BASE_URL}`);
  assert(url.port && url.port !== '3000', `test refuses default port 3000: ${BASE_URL}`);

  const dataDir = process.env.SCIFIGURE_DATA_DIR || '';
  const dbPath = process.env.SCIFIGURE_DB_PATH || '';
  const resolvedDataDir = path.resolve(dataDir);
  const resolvedDbPath = path.resolve(dbPath);
  assert(dataDir && path.basename(path.dirname(resolvedDataDir)).startsWith('scifigure-isolated-smoke-'), `unsafe data dir: ${dataDir}`);
  assert(dbPath && resolvedDbPath.startsWith(`${resolvedDataDir}${path.sep}`), `unsafe db path: ${dbPath}`);
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
    script_language: 'r',
    figure: { width: 190, height: 100, unit: 'mm', dpi: 300 },
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
      language: 'r',
      requestId: `r-wp7-diagram-ui-${Date.now()}`,
    }),
  });
  assert(rendered.status === 'success' && rendered.figures?.[0]?.manifest, `fixture render failed: ${JSON.stringify(rendered)}`);
  return { projectId: created.id, spec, rendered };
}

function findByIdentity(objects, role, diagramObjectId) {
  return objects.find((object) => (
    object.role === role
    && object.identity?.relation?.diagramObjectId === diagramObjectId
  ));
}

function assertReadonly(object, forbiddenProps, label) {
  const editable = new Set(object.editable || []);
  const capabilities = new Set((object.propertyCapabilities || []).map((capability) => capability.prop));
  const exposed = forbiddenProps.filter((prop) => editable.has(prop) || capabilities.has(prop));
  assert(exposed.length === 0, `${label} exposes protected fields: ${JSON.stringify(exposed)}`);
  assert(
    (object.propertyCapabilities || []).every((capability) => capability.patchMode === 'backend_patch'),
    `${label} exposes a non-backend style capability: ${JSON.stringify(object.propertyCapabilities)}`,
  );
}

function findDiagramObjects(manifest) {
  const objects = manifest?.objects || [];
  const diagram = {
    latentNode: findByIdentity(objects, 'diagram_node', 'latent_a'),
    observedNode: findByIdentity(objects, 'diagram_node', 'observed_b'),
    edge: findByIdentity(objects, 'diagram_edge', 'latent_a_to_observed_b'),
    pathEdge: findByIdentity(objects, 'diagram_edge', 'latent_a_path_to_observed_b'),
    arrow: findByIdentity(objects, 'diagram_arrow', 'arrow_a_b'),
    latentLabel: findByIdentity(objects, 'diagram_node_label', 'label_latent_a'),
    observedLabel: findByIdentity(objects, 'diagram_node_label', 'label_observed_b'),
    coefficient: findByIdentity(objects, 'diagram_coefficient_label', 'coef_a_b'),
    fit: findByIdentity(objects, 'diagram_fit_annotation', 'fit_summary'),
    group: findByIdentity(objects, 'diagram_group', 'measurement_model'),
  };

  for (const [label, object] of Object.entries(diagram)) {
    assert(object, `missing ${label} semantic object`);
    const relation = object.identity?.relation || {};
    assert(relation.diagramId === 'sem.demo', `${label} lost diagramId: ${JSON.stringify(relation)}`);
    assert(relation.diagramType === 'sem', `${label} lost diagramType: ${JSON.stringify(relation)}`);
    assert(object.source?.callName === 'SciFigure.semantic_gid', `${label} lost trusted semantic source: ${JSON.stringify(object.source)}`);
    assert(object.semanticCoverage?.family === 'diagram' && object.semanticCoverage?.status === 'dedicated', `${label} lost dedicated diagram coverage`);
  }

  assert(diagram.edge.identity.relation.sourceNodeId === 'latent_a', 'edge lost source topology');
  assert(diagram.edge.identity.relation.targetNodeId === 'observed_b', 'edge lost target topology');
  assert(diagram.pathEdge.identity.relation.sourceNodeId === 'latent_a', 'path edge lost source topology');
  assert(diagram.pathEdge.identity.relation.targetNodeId === 'observed_b', 'path edge lost target topology');
  assert(diagram.arrow.identity.relation.edgeId === 'latent_a_to_observed_b', 'arrow lost edge topology');
  assert(diagram.latentLabel.identity.relation.nodeId === 'latent_a', 'node label lost node topology');

  assertReadonly(diagram.latentNode, ['diagram_id', 'diagram_type', 'node_id', 'x', 'y'], 'latent node');
  assertReadonly(diagram.edge, ['edge_id', 'source_node_id', 'target_node_id', 'direction', 'path', 'vertices', 'control_points'], 'edge');
  assertReadonly(diagram.pathEdge, ['edge_id', 'source_node_id', 'target_node_id', 'direction', 'path', 'vertices', 'control_points'], 'path edge');
  assertReadonly(diagram.arrow, ['edge_id', 'source_node_id', 'target_node_id', 'direction', 'path', 'vertices', 'control_points'], 'arrow');
  assertReadonly(diagram.latentLabel, ['text', 'node_id'], 'node label');
  assertReadonly(diagram.coefficient, ['text', 'edge_id', 'coefficient', 'value', 'p_value', 'pvalue', 'significance'], 'coefficient label');
  assertReadonly(diagram.fit, ['text', 'fit', 'fit_indices', 'cfi', 'rmsea', 'p_value', 'pvalue'], 'fit annotation');
  assertReadonly(diagram.group, ['diagram_id', 'diagram_type', 'members', 'node_ids'], 'diagram group');

  return diagram;
}

async function installFixtureState(page, fixture) {
  await page.evaluate(({ projectId, spec, rendered, storageKey }) => {
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
    window.sessionStorage.setItem(storageKey, JSON.stringify({
      spec,
      history: [spec],
      historyIndex: 0,
      projectId,
      projectName: 'R WP7 diagram semantics smoke',
      projectFigures,
      activeFigureId: 'fig_1',
      selectedFigureIds: ['fig_1'],
      datasets: [],
      selectedGids: [],
      projectHistory: {},
      projectDrafts: {},
      currentView: 'workspace',
      subView: 'home',
      renderLog: ['> R WP7 diagram fixture ready'],
      figSession: null,
    }));
  }, { projectId: fixture.projectId, spec: fixture.spec, rendered: fixture.rendered, storageKey: APP_STATE_KEY });
  await page.reload({ waitUntil: 'networkidle', timeout: 30000 });
  await waitForWorkspaceReady(page);
}

async function getBodyText(page) {
  return (await page.textContent('body').catch(() => '')) || '';
}

async function waitForWorkspaceReady(page, timeoutMs = 120000) {
  const start = Date.now();
  let lastBody = '';
  while (Date.now() - start < timeoutMs) {
    lastBody = await getBodyText(page);
    if (
      await page.locator('svg').count().catch(() => 0) > 0
      && lastBody.includes('属性编辑')
      && !lastBody.includes('正在恢复项目预览')
      && !lastBody.includes('正在重新渲染当前图形')
    ) {
      return;
    }
    await page.waitForTimeout(500);
  }
  throw new Error(`workspace did not become ready: ${lastBody.slice(0, 800)}`);
}

async function selectedGids(page) {
  return page.evaluate((storageKey) => {
    const raw = window.sessionStorage.getItem(storageKey);
    const state = raw ? JSON.parse(raw) : {};
    return Array.isArray(state.selectedGids) ? state.selectedGids : [];
  }, APP_STATE_KEY);
}

async function selectObject(page, groupId, gid) {
  const button = page.locator(`[data-component-group-id="${groupId}"] button[data-component-object-id="${gid}"]`).first();
  await button.waitFor({ state: 'visible', timeout: 30000 });
  await button.click();
  const deadline = Date.now() + 5000;
  while (Date.now() < deadline) {
    const selected = await selectedGids(page);
    if (selected.length === 1 && selected[0] === gid) return;
    await page.waitForTimeout(100);
  }
  throw new Error(`failed to select ${gid} from ${groupId}: ${JSON.stringify(await selectedGids(page))}`);
}

async function assertSvgIdentities(page, objects) {
  for (const [label, object] of Object.entries(objects)) {
    const inspection = await page.evaluate(({ gid, childIds }) => {
      const svg = document.querySelector('[data-scifigure-canvas-svg="true"] svg');
      if (!svg) return { resolved: null, ids: [], dataFigIds: [] };
      const find = (id) => (
        svg.querySelector(`#${CSS.escape(id)}`)
        || svg.querySelector(`[data-fig-id="${CSS.escape(id)}"]`)
      );
      const resolved = find(gid) ? gid : childIds.find((childId) => find(childId)) || null;
      return {
        resolved,
        ids: Array.from(svg.querySelectorAll('[id]')).map((node) => node.id).filter(Boolean),
        dataFigIds: Array.from(svg.querySelectorAll('[data-fig-id]')).map((node) => node.getAttribute('data-fig-id')).filter(Boolean),
      };
    }, { gid: object.id, childIds: object.children || [] });
    assert(
      inspection.resolved,
      `${label} manifest identity ${object.id} has no live SVG element or owned child: ${JSON.stringify({
        children: object.children || [],
        source: object.source || {},
        relation: object.identity?.relation || {},
        ids: inspection.ids,
        dataFigIds: inspection.dataFigIds,
      })}`,
    );
  }
}

async function assertSvgObjectMarkup(page, object, expectedTags, styleToken) {
  const markup = await page.locator(
    `[data-scifigure-canvas-svg="true"] [data-fig-id="${object.id}"]`,
  ).first().evaluate((node) => ({ tag: node.tagName.toLowerCase(), html: node.outerHTML }));
  assert(expectedTags.includes(markup.tag), `${object.id} was bound to unexpected <${markup.tag}>: ${markup.html}`);
  assert(markup.html.toLowerCase().includes(styleToken.toLowerCase()), `${object.id} was bound to wrong geometry style: ${markup.html}`);
}

async function assertDedicatedGroups(page, diagram) {
  await page.getByRole('button', { name: '组件中心', exact: true }).click();
  await page.waitForTimeout(300);
  const expected = new Map([
    ['diagramGroups', ['图示 / SEM 整体组', [diagram.group.id]]],
    ['diagramNodes', ['图示节点', [diagram.latentNode.id, diagram.observedNode.id]]],
    ['diagramEdges', ['图示连线 / 路径', [diagram.edge.id, diagram.pathEdge.id]]],
    ['diagramArrows', ['图示箭头', [diagram.arrow.id]]],
    ['diagramNodeLabels', ['图示节点标签', [diagram.latentLabel.id, diagram.observedLabel.id]]],
    ['diagramCoefficientLabels', ['路径系数标签', [diagram.coefficient.id]]],
    ['diagramFitAnnotations', ['模型拟合注释', [diagram.fit.id]]],
  ]);
  const entries = await page.locator('.scifig-editor-panel-right [data-component-group-id]').evaluateAll((nodes) => nodes.map((node) => ({
    id: node.getAttribute('data-component-group-id'),
    label: node.getAttribute('data-component-group-label'),
    objectIds: Array.from(node.querySelectorAll('button[data-component-object-id]')).map((button) => button.getAttribute('data-component-object-id')),
  })));
  const byId = new Map(entries.map((entry) => [entry.id, entry]));
  for (const [groupId, [label, objectIds]] of expected.entries()) {
    const entry = byId.get(groupId);
    assert(entry?.label === label, `missing dedicated diagram group ${groupId}/${label}: ${JSON.stringify(entry)}`);
    assert(
      JSON.stringify([...entry.objectIds].sort()) === JSON.stringify([...objectIds].sort()),
      `${groupId} object identity mismatch: ${JSON.stringify(entry.objectIds)}`,
    );
  }

  const semanticIds = new Set([...expected.values()].flatMap(([, objectIds]) => objectIds));
  for (const gid of semanticIds) {
    const memberships = entries.filter((entry) => entry.objectIds.includes(gid)).map((entry) => entry.id);
    assert(memberships.length === 1, `${gid} appears outside its dedicated diagram group: ${JSON.stringify(memberships)}`);
  }
}

async function assertProtectedControlsAbsent(page) {
  const protectedProps = [
    'text', 'diagram_id', 'diagram_type', 'node_id', 'edge_id', 'source_node_id', 'target_node_id',
    'direction', 'path', 'vertices', 'control_points', 'members', 'node_ids', 'coefficient', 'value',
    'p_value', 'pvalue', 'significance', 'fit', 'fit_indices', 'cfi', 'rmsea',
  ];
  for (const prop of protectedProps) {
    const count = await page.locator(`[data-component-group-id^="diagram"] [data-param-prop="${prop}"]`).count();
    assert(count === 0, `protected diagram field ${prop} is exposed in the right sidebar`);
  }
}

async function setNodeFill(page, diagram, value) {
  await selectObject(page, 'diagramNodes', diagram.latentNode.id);
  const input = page.locator('[data-component-group-id="diagramNodes"] input[data-color-role="text"][data-color-scope$=":color"]').first();
  await input.waitFor({ state: 'visible', timeout: 30000 });
  await input.fill(value);
  await input.press('Enter').catch(() => {});
  await input.evaluate((node) => node.blur());
  await page.waitForTimeout(500);
}

async function applyDraft(page, expectedGid, expectedColor) {
  const requestStart = apiRequests.length;
  const responsePromise = page.waitForResponse((response) => (
    new URL(response.url()).pathname === '/api/figure/patch'
    && response.request().method() === 'POST'
  ), { timeout: 90000 });
  await page.getByRole('button', { name: '应用当前图', exact: true }).click();
  const response = await responsePromise;
  const payload = await response.json();
  assert(response.ok() && payload.status === 'success', `diagram style patch failed: ${response.status()} ${JSON.stringify(payload)}`);
  await waitForWorkspaceReady(page);

  const requests = apiRequests.slice(requestStart).filter((request) => new URL(request.url).pathname === '/api/figure/patch');
  assert(requests.length === 1, `expected one figure patch request, got ${requests.length}`);
  const body = parseJson(requests[0].postData);
  const patches = body?.patches || [];
  assert(patches.length === 1, `expected one legal style patch, got ${JSON.stringify(patches)}`);
  const patch = patches[0];
  assert(patch.gid === expectedGid && patch.prop === 'facecolor', `unexpected diagram patch target: ${JSON.stringify(patch)}`);
  assert(String(patch.value).toLowerCase() === expectedColor.toLowerCase(), `unexpected diagram patch value: ${JSON.stringify(patch)}`);
  assert(patch.mode === 'backend_patch', `diagram style patch must use backend_patch: ${JSON.stringify(patch)}`);
  assert(patch.identity?.relation?.diagramObjectId === 'latent_a', `patch lost semantic identity: ${JSON.stringify(patch.identity)}`);
  assert(!patches.some((item) => ['text', 'source_node_id', 'target_node_id', 'node_id', 'edge_id'].includes(item.prop)), `protected patch escaped UI: ${JSON.stringify(patches)}`);
  return payload;
}

async function readFigureState(page) {
  return page.evaluate((storageKey) => {
    const raw = window.sessionStorage.getItem(storageKey);
    const state = raw ? JSON.parse(raw) : {};
    const figure = state.projectFigures?.[state.activeFigureId || 'fig_1'];
    return {
      manifest: figure?.manifest || null,
      editLog: figure?.editLog || [],
      svg: figure?.svg || '',
    };
  }, APP_STATE_KEY);
}

async function main() {
  assertIsolatedEnvironment();
  authToken = await authenticateCapabilitySmokeUser(BASE_URL, 'R WP7 diagram semantics');
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

  try {
    await page.goto(BASE_URL, { waitUntil: 'domcontentloaded', timeout: 30000 });
    await installFixtureState(page, fixture);
    await assertSvgIdentities(page, {
      node: diagram.latentNode,
      edge: diagram.edge,
      pathEdge: diagram.pathEdge,
      arrow: diagram.arrow,
      nodeLabel: diagram.latentLabel,
      diagramGroup: diagram.group,
    });
    await assertSvgObjectMarkup(page, diagram.latentNode, ['circle'], '#4477aa');
    await assertSvgObjectMarkup(page, diagram.edge, ['line', 'polyline', 'path'], '#333333');
    await assertSvgObjectMarkup(page, diagram.pathEdge, ['polyline', 'path'], '#8844aa');
    await assertSvgObjectMarkup(page, diagram.arrow, ['line', 'polyline', 'path', 'polygon'], '#333333');
    await assertSvgObjectMarkup(page, diagram.group, ['rect', 'polygon', 'path'], '#999999');
    await assertDedicatedGroups(page, diagram);

    await selectObject(page, 'diagramNodes', diagram.latentNode.id);
    await selectObject(page, 'diagramEdges', diagram.edge.id);
    await selectObject(page, 'diagramEdges', diagram.pathEdge.id);
    await selectObject(page, 'diagramArrows', diagram.arrow.id);
    await selectObject(page, 'diagramNodeLabels', diagram.latentLabel.id);
    await selectObject(page, 'diagramGroups', diagram.group.id);
    await assertProtectedControlsAbsent(page);

    const nodeFill = '#1188cc';
    await setNodeFill(page, diagram, nodeFill);
    assert((await getBodyText(page)).includes('已暂存'), 'draft indicator did not appear after legal node style edit');
    await applyDraft(page, diagram.latentNode.id, nodeFill);

    const state = await readFigureState(page);
    const updatedNode = findByIdentity(state.manifest?.objects || [], 'diagram_node', 'latent_a');
    assert(String(updatedNode?.currentProps?.facecolor || '').toLowerCase() === nodeFill, `manifest did not reflect node fill: ${JSON.stringify(updatedNode?.currentProps)}`);
    assert(state.editLog.some((entry) => (
      entry.gid === diagram.latentNode.id
      && entry.prop === 'facecolor'
      && String(entry.value).toLowerCase() === nodeFill
      && entry.mode === 'backend_patch'
    )), `edit log did not retain node fill: ${JSON.stringify(state.editLog)}`);
    const liveNodeMarkup = await page.locator(
      `[data-scifigure-canvas-svg="true"] [data-fig-id="${diagram.latentNode.id}"]`,
    ).first().evaluate((node) => node.outerHTML);
    assert(liveNodeMarkup.toLowerCase().includes(nodeFill), `live SVG node did not reflect the legal fill edit: ${liveNodeMarkup}`);
    const canvasText = await page.locator('[data-scifigure-canvas-svg="true"]').innerText();
    assert(canvasText.includes('beta = 0.42, p = 0.003'), 'coefficient scientific text changed or disappeared');
    assert(canvasText.includes('CFI = 0.96; RMSEA = 0.04'), 'fit scientific text changed or disappeared');

    if (consoleErrors.length > 0 || pageErrors.length > 0) {
      throw new Error(`console errors=${JSON.stringify(consoleErrors)}, page errors=${JSON.stringify(pageErrors)}`);
    }

    console.log(JSON.stringify({
      status: 'PASS',
      projectId: fixture.projectId,
      checked: [
        'node, edge, arrow, node label, and diagram group select through live SVG/manifest ids',
        'right sidebar exposes dedicated diagram groups without generic duplicates',
        'legal R diagram node style patch is reflected in manifest, edit log, and SVG',
        'coefficient/fit scientific text and topology fields are not editable',
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
