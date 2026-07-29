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
const APP_STATE_KEY = 'scifigure:app-state:v2';
const MATRIX_PATH = path.join(ROOT, 'tests/fixtures/capability_matrix/matrix.json');
const FIXTURE_ROOT = path.join(ROOT, 'tests/fixtures/capability_matrix');
const RUN_ID = new Date().toISOString().replace(/[:.]/g, '-');
const OUTPUT_DIR = path.join(ROOT, 'output/playwright', `python-capability-matrix-ui-${RUN_ID}`);
const TEST_PROJECT_PREFIX = 'Python capability matrix UI smoke';

const SAFE_STYLE_PROPS = ['color', 'facecolor', 'edgecolor', 'linewidth', 'alpha', 'fontsize'];
const DENIED_PROPS = [
  'text',
  'values',
  'data',
  'xdata',
  'ydata',
  'offsets',
  'center',
  'radius',
  'theta1',
  'theta2',
  'explode',
  'bins',
  'edges',
  'levels',
  'where',
  'density',
  'norm',
  'mappable',
  'colorbarId',
  'mappableId',
  'nodeId',
  'edgeId',
  'sourceNodeId',
  'targetNodeId',
  'diagramId',
];

const results = [];
const diagnostics = {};
const apiRequests = [];
const apiResponses = [];
const consoleErrors = [];
const pageErrors = [];
const createdProjectIds = new Set();
let authToken = '';

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function record(entryId, check, status, note, extra = {}) {
  const row = { entryId, check, status, note, ...extra };
  results.push(row);
  console.log(`${status} ${entryId} ${check}: ${note}`);
}

function parseJson(value) {
  if (!value) return null;
  try {
    return JSON.parse(value);
  } catch {
    return null;
  }
}

function isIgnorableDevServerNoise(message) {
  return message.includes('[vite] failed to connect to websocket')
    || /WebSocket connection to 'ws:\/\/(?:localhost|127\.0\.0\.1):24678\//.test(message)
    || message.includes('WebSocket closed without opened');
}

function assertIsolatedEnvironment() {
  assert(process.env.SCIFIGURE_TEST_ISOLATED === '1', 'must run through scripts/testing/run_with_isolated_server.mjs');
  assert(BASE_URL, 'SCIFIGURE_URL is required from scripts/testing/run_with_isolated_server.mjs');
  const url = new URL(BASE_URL);
  assert(url.hostname === '127.0.0.1', `test must target isolated 127.0.0.1 server, got ${BASE_URL}`);
  assert(url.port !== '3000', 'test refuses localhost:3000/default port');
  const dataDir = process.env.SCIFIGURE_DATA_DIR || '';
  const dbPath = process.env.SCIFIGURE_DB_PATH || '';
  assert(dataDir && dbPath, 'isolated data dir and DB path are required');
  const resolvedData = path.resolve(dataDir);
  const resolvedDb = path.resolve(dbPath);
  assert(path.basename(path.dirname(resolvedData)).startsWith('scifigure-isolated-smoke-'), `unsafe data dir: ${dataDir}`);
  assert(resolvedDb.startsWith(`${resolvedData}${path.sep}`), `unsafe DB path: ${dbPath}`);
}

function interestingApi(request) {
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
    .filter(project => String(project?.name || '').startsWith(TEST_PROJECT_PREFIX))
    .map(project => {
      const id = project.id || project.projectId;
      return id ? requestJson(`/api/projects/${id}`, { method: 'DELETE' }).catch(() => null) : null;
    }));
}

function readMatrix() {
  const matrix = JSON.parse(fs.readFileSync(MATRIX_PATH, 'utf8'));
  assert(Array.isArray(matrix.python) && matrix.python.length > 0, 'matrix.json has no python entries');
  const idsArgument = process.argv.find(argument => argument.startsWith('--ids='));
  const requestedIds = new Set(
    String(process.env.SCIFIGURE_MATRIX_IDS || idsArgument?.slice('--ids='.length) || '')
      .split(',')
      .map(value => value.trim())
      .filter(Boolean),
  );
  if (requestedIds.size === 0) return matrix.python;
  const selected = matrix.python.filter(entry => requestedIds.has(entry.id));
  const missing = [...requestedIds].filter(id => !selected.some(entry => entry.id === id));
  assert(missing.length === 0, `unknown Python capability matrix ids: ${missing.join(', ')}`);
  return selected;
}

function readScript(entry) {
  const file = path.resolve(FIXTURE_ROOT, entry.file);
  assert(file.startsWith(`${FIXTURE_ROOT}${path.sep}`), `fixture path escaped root: ${entry.file}`);
  assert(fs.existsSync(file), `fixture script missing: ${entry.file}`);
  return fs.readFileSync(file, 'utf8');
}

async function createAndRenderEntry(entry) {
  const script = readScript(entry);
  const spec = {
    plot_type: 'custom',
    custom_script: script,
    script,
    script_language: 'python',
    figure: { width: 150, height: 100, unit: 'mm', dpi: 300 },
  };
  const created = await requestJson('/api/projects', {
    method: 'POST',
    body: JSON.stringify({ name: `${TEST_PROJECT_PREFIX} ${entry.id} ${Date.now()}`, spec }),
  });
  assert(created.id, `project create returned no id for ${entry.id}: ${JSON.stringify(created)}`);
  createdProjectIds.add(created.id);
  const editLogs = Object.fromEntries(
    Array.from({ length: Math.max(1, Number(entry.expectedFigures || 1)) }, (_, index) => [`fig_${index + 1}`, []]),
  );
  const rendered = await requestJson(`/api/projects/${created.id}/figures/render`, {
    method: 'POST',
    body: JSON.stringify({
      script,
      editLogs,
      language: 'python',
      requestId: `python-capability-matrix-${entry.id}-${Date.now()}`,
    }),
  });
  assert(rendered.status === 'success', `render failed for ${entry.id}: ${JSON.stringify(rendered)}`);
  assert(Array.isArray(rendered.figures) && rendered.figures.length > 0, `render returned no figures for ${entry.id}`);
  return { projectId: created.id, spec, rendered };
}

function figureById(rendered, figureId = 'fig_1') {
  return (rendered.figures || []).find(figure => figure.figureId === figureId) || rendered.figures?.[0] || null;
}

function manifestObjects(figure) {
  return Array.isArray(figure?.manifest?.objects) ? figure.manifest.objects : [];
}

function objectById(manifest, id) {
  return (manifest?.objects || []).find(object => object.id === id) || null;
}

function editableProps(object) {
  return Array.from(new Set([
    ...(Array.isArray(object?.editable) ? object.editable : []),
    ...(Array.isArray(object?.propertyCapabilities) ? object.propertyCapabilities.map(capability => capability?.prop).filter(Boolean) : []),
  ]));
}

function relationValue(object, field) {
  if (Object.hasOwn(object || {}, field)) return object[field];
  if (Object.hasOwn(object?.currentProps || {}, field)) return object.currentProps[field];
  if (Object.hasOwn(object?.identity?.relation || {}, field)) return object.identity.relation[field];
  return undefined;
}

function valuesEqual(actual, expected) {
  return JSON.stringify(actual) === JSON.stringify(expected);
}

function countByKind(objects) {
  const counts = {};
  for (const object of objects) counts[object.kind] = (counts[object.kind] || 0) + 1;
  return counts;
}

function validateMatrixManifest(entry, figures) {
  const figureList = Array.isArray(figures) ? figures : [];
  const objects = figureList.flatMap(figure => manifestObjects(figure));
  const manifest = { objects };
  const counts = countByKind(objects);
  const failures = [];
  const invalidFigures = figureList
    .filter(figure => !figure?.svg || !String(figure.svg).includes('<svg'))
    .map(figure => figure?.figureId || 'unknown');
  if (invalidFigures.length > 0) failures.push(`empty or invalid SVG: ${invalidFigures.join(',')}`);
  if (objects.length === 0) failures.push('manifest missing objects');
  for (const [kind, minCount] of Object.entries(entry.minKindCounts || {})) {
    if ((counts[kind] || 0) < minCount) failures.push(`${kind} count ${counts[kind] || 0} < ${minCount}`);
  }
  for (const id of entry.requiredIds || []) {
    if (!objectById(manifest, id)) failures.push(`missing required id ${id}`);
  }
  for (const role of entry.requiredRoles || []) {
    if (!objects.some(object => object.role === role)) failures.push(`missing required role ${role}`);
  }
  for (const relation of entry.relations || []) {
    const object = objectById(manifest, relation.from);
    if (!object) {
      failures.push(`relation source missing ${relation.from}`);
      continue;
    }
    const actual = relationValue(object, relation.field);
    if (!valuesEqual(actual, relation.equals)) {
      failures.push(`relation ${relation.from}.${relation.field} expected ${JSON.stringify(relation.equals)} got ${JSON.stringify(actual)}`);
    }
  }
  return { ok: failures.length === 0, failures, counts };
}

async function installProjectState(page, entry, fixture) {
  await page.evaluate(({ storageKey, entryId, projectId, spec, rendered }) => {
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
      projectName: `Python capability matrix UI smoke ${entryId}`,
      projectFigures,
      activeFigureId: rendered.figures[0]?.figureId || 'fig_1',
      selectedFigureIds: [rendered.figures[0]?.figureId || 'fig_1'],
      datasets: [],
      selectedGids: [],
      projectHistory: {},
      projectDrafts: {},
      currentView: 'workspace',
      subView: 'home',
      renderLog: [`> Python capability matrix fixture ${entryId} ready`],
      figSession: null,
    }));
  }, {
    storageKey: APP_STATE_KEY,
    entryId: entry.id,
    projectId: fixture.projectId,
    spec: fixture.spec,
    rendered: fixture.rendered,
  });
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
    const rendering = body.includes('正在恢复项目预览')
      || body.includes('正在重新渲染当前图形')
      || body.includes('等待 Python 渲染结果');
    if (!rendering && (await page.locator('svg').count().catch(() => 0)) > 0 && body.includes('属性编辑')) return;
    await page.waitForTimeout(500);
  }
  throw new Error(`workspace did not become ready: ${lastBody.slice(0, 900)}`);
}

async function clickCenter(page, label) {
  const button = page.getByRole('button', { name: label, exact: true }).first();
  if (!(await button.isVisible({ timeout: 5000 }).catch(() => false))) return false;
  await button.click();
  await page.waitForTimeout(500);
  return true;
}

async function centerEvidence(page) {
  return page.evaluate(() => ({
    ...(() => {
      const root = document.querySelector('.scifig-editor-panel-right') || document;
      const visible = node => {
        const rect = node.getBoundingClientRect();
        const style = window.getComputedStyle(node);
        return rect.width > 0
          && rect.height > 0
          && style.display !== 'none'
          && style.visibility !== 'hidden';
      };
      const visibleNodes = selector => Array.from(root.querySelectorAll(selector)).filter(visible);
      const activeTab = Array.from(root.querySelectorAll('button[aria-label]'))
        .find(button => visible(button) && String(button.className).includes('border-blue-500'))
        ?.getAttribute('aria-label') || null;
      return {
        activeTab,
        componentGroups: visibleNodes('[data-component-group-id]').map(node => ({
      id: node.getAttribute('data-component-group-id'),
      label: node.getAttribute('data-component-group-label'),
      objectIds: Array.from(node.querySelectorAll('[data-component-object-id]')).map(child => child.getAttribute('data-component-object-id')),
      props: Array.from(node.querySelectorAll('[data-param-prop]')).map(child => child.getAttribute('data-param-prop')),
      colorScopes: Array.from(node.querySelectorAll('[data-color-scope]')).map(child => child.getAttribute('data-color-scope')),
        })),
        colorControlCount: visibleNodes('input[data-color-role="text"]').length,
        fontControlCount: visibleNodes([
          '[data-param-prop="fontsize"]',
          '[data-param-prop="tick_labelsize"]',
          '[data-param-prop="fontfamily"]',
          '[data-param-prop="fontweight"]',
          '[data-param-prop="fontstyle"]',
        ].join(',')).length,
        numberControlCount: visibleNodes('input[data-param-role="number"], input[data-param-role="range"]').length,
        layoutControlCount: visibleNodes('[data-layout-role], [data-layout-action], [data-layout-section]').length,
        visibleControlCount: visibleNodes('input, select, textarea, button').length,
        body: root.innerText.slice(0, 1600),
      };
    })(),
  }));
}

async function verifyCenters(page, entry, manifest) {
  const objects = manifest?.objects || [];
  const palettes = manifest?.palettes || [];
  const hasFonts = objects.some(object => editableProps(object).some(prop => ['fontsize', 'fontfamily', 'fontweight', 'fontstyle', 'color'].includes(prop)) && object.kind === 'text');
  const hasLayout = objects.some(object => editableProps(object).some(prop => ['left', 'bottom', 'width', 'height', 'aspect'].includes(prop)));
  const centers = [
    { label: '组件中心', capability: objects.length > 0 },
    { label: '配色中心', capability: palettes.length > 0 },
    { label: '字体中心', capability: hasFonts },
    { label: '布局中心', capability: hasLayout },
  ];
  for (const center of centers) {
    const clicked = await clickCenter(page, center.label);
    const evidence = clicked ? await centerEvidence(page) : {};
    if (!clicked) {
      record(entry.id, `center:${center.label}`, 'FAIL', 'center button was not visible/clickable');
      continue;
    }
    const active = evidence.activeTab === center.label;
    const hasControls = center.label === '组件中心'
      ? evidence.componentGroups?.length > 0
      : center.label === '配色中心'
        ? evidence.colorControlCount > 0
        : center.label === '字体中心'
          ? evidence.fontControlCount > 0
          : evidence.layoutControlCount > 0 || evidence.numberControlCount > 0;
    const status = active && hasControls ? 'PASS' : center.capability ? 'FAIL' : 'N/A';
    const note = hasControls
      ? `active=${evidence.activeTab}, groups=${evidence.componentGroups?.length || 0}, colors=${evidence.colorControlCount || 0}, fonts=${evidence.fontControlCount || 0}, numbers=${evidence.numberControlCount || 0}, layout=${evidence.layoutControlCount || 0}`
      : center.capability
        ? `manifest indicates capability but this active center exposed no matching visible controls; active=${evidence.activeTab}`
        : 'opened; manifest exposes no relevant capability for this center';
    record(entry.id, `center:${center.label}`, status, note, { evidence: { ...evidence, body: undefined } });
  }
}

function chooseSafeEdit(manifest) {
  const objects = manifest?.objects || [];
  const kindPriority = new Map([
    ['heatmap', 0], ['contourf', 1], ['contour', 2], ['fill_between', 3],
    ['quiver', 4], ['streamplot', 5], ['bar', 6], ['errorbar', 7],
    ['stem', 8], ['boxplot', 9], ['violin', 10], ['histogram', 11],
    ['stairs', 12], ['line', 13], ['patch', 14], ['collection', 15],
  ]);
  const dataKinds = new Set([
    'line', 'patch', 'collection', 'fill_between', 'contour', 'contourf',
    'heatmap', 'quiver', 'streamplot', 'bar', 'errorbar', 'stem', 'boxplot',
    'violin', 'histogram', 'stairs',
  ]);
  const ordinaryObjects = objects.filter(candidate => (
    dataKinds.has(candidate.kind)
    && candidate.currentProps?.parentOwned !== true
    && !String(candidate.role || '').includes('child_')
    && !String(candidate.role || '').includes('legend_')
    && !String(candidate.role || '').includes('coefficient')
    && !String(candidate.role || '').includes('fit_annotation')
  )).sort((left, right) => (
    (kindPriority.get(left.kind) ?? 99) - (kindPriority.get(right.kind) ?? 99)
  ));
  const fallbackObjects = objects.filter(candidate => !ordinaryObjects.includes(candidate));
  for (const candidates of [ordinaryObjects, fallbackObjects]) {
    for (const object of candidates) {
      if (
        object.currentProps?.parentOwned === true
        || object.role === 'grid'
        || String(object.role || '').includes('coefficient')
        || String(object.role || '').includes('fit_annotation')
      ) continue;
      const preferred = SAFE_STYLE_PROPS.find(prop => editableProps(object).includes(prop) && !DENIED_PROPS.includes(prop));
      if (preferred) return { object, prop: preferred };
    }
  }
  return null;
}

function nextSafeValue(object, prop) {
  const current = object?.currentProps?.[prop];
  if (['color', 'facecolor', 'edgecolor'].includes(prop)) return '#1177cc';
  if (prop === 'linewidth') return Number.isFinite(Number(current)) ? Number((Number(current) + 0.75).toFixed(2)) : 2.25;
  if (prop === 'alpha') {
    const numeric = Number.isFinite(Number(current)) ? Number(current) : 0.65;
    return Number(Math.max(0.15, Math.min(0.95, numeric > 0.55 ? numeric - 0.2 : numeric + 0.2)).toFixed(2));
  }
  if (prop === 'fontsize') return Number.isFinite(Number(current)) ? Number((Number(current) + 1.5).toFixed(2)) : 13.5;
  throw new Error(`unsupported safe prop ${prop}`);
}

async function selectObject(page, gid) {
  const componentButton = page.locator(`button[data-component-object-id="${gid}"]`).first();
  if (await componentButton.isVisible({ timeout: 1500 }).catch(() => false)) {
    await componentButton.click();
    await page.waitForTimeout(300);
    return true;
  }
  const svgTarget = page.locator(`svg [id="${gid}"], svg [data-fig-id="${gid}"]`).first();
  if (await svgTarget.count().catch(() => 0) > 0) {
    const leaf = svgTarget.locator('path, rect, use, polygon, polyline, text, circle').first();
    const target = await leaf.count().catch(() => 0) > 0 ? leaf : svgTarget;
    const box = await target.boundingBox().catch(() => null);
    await target.dispatchEvent('click', {
      button: 0,
      clientX: box ? box.x + box.width / 2 : 1,
      clientY: box ? box.y + box.height / 2 : 1,
    });
    await page.waitForTimeout(300);
    return true;
  }
  return false;
}

async function visibleDeniedControls(page) {
  return page.evaluate((deniedProps) => {
    const visible = node => {
      const rect = node.getBoundingClientRect();
      const style = window.getComputedStyle(node);
      return rect.width > 0 && rect.height > 0 && style.display !== 'none' && style.visibility !== 'hidden';
    };
    return Array.from(document.querySelectorAll('[data-param-prop]'))
      .filter(node => visible(node) && deniedProps.includes(node.getAttribute('data-param-prop') || ''))
      .map(node => ({
        prop: node.getAttribute('data-param-prop'),
        gid: node.getAttribute('data-param-gid'),
        group: node.closest('[data-component-group-id]')?.getAttribute('data-component-group-id') || null,
      }));
  }, DENIED_PROPS);
}

async function findEditableControl(page, gid, prop) {
  if (['color', 'facecolor', 'edgecolor'].includes(prop)) {
    const exact = page.locator(`input[data-color-role="text"][data-color-scope="${gid}:${prop}"]`).first();
    if (await exact.isVisible({ timeout: 1000 }).catch(() => false)) return { locator: exact, kind: 'color', scope: `${gid}:${prop}` };
    const fallback = await page.evaluateHandle(({ gid, prop }) => {
      const visible = node => {
        const rect = node.getBoundingClientRect();
        const style = window.getComputedStyle(node);
        return rect.width > 0 && rect.height > 0 && style.display !== 'none' && style.visibility !== 'hidden' && !node.disabled;
      };
      const button = document.querySelector(`button[data-component-object-id="${CSS.escape(gid)}"]`);
      const group = button?.closest('[data-component-group-id]');
      const selectors = [
        `input[data-color-role="text"][data-color-scope$=":${prop}"]`,
        'input[data-color-role="text"][data-color-scope$=":color"]',
      ];
      for (const selector of selectors) {
        const scoped = group ? Array.from(group.querySelectorAll(selector)).find(visible) : null;
        if (scoped) return scoped;
      }
      return null;
    }, { gid, prop });
    const element = fallback.asElement();
    if (element) return { locator: element, kind: 'color', scope: await element.getAttribute('data-color-scope') };
  }
  const exactNumber = page.locator(`input[data-param-gid="${gid}"][data-param-prop="${prop}"]`).first();
  if (await exactNumber.isVisible({ timeout: 1000 }).catch(() => false)) return { locator: exactNumber, kind: 'number', scope: `${gid}:${prop}` };
  const fallbackNumber = await page.evaluateHandle(({ gid, prop }) => {
    const visible = node => {
      const rect = node.getBoundingClientRect();
      const style = window.getComputedStyle(node);
      return rect.width > 0 && rect.height > 0 && style.display !== 'none' && style.visibility !== 'hidden' && !node.disabled;
    };
    const button = document.querySelector(`button[data-component-object-id="${CSS.escape(gid)}"]`);
    const group = button?.closest('[data-component-group-id]');
    const selector = `input[data-param-role="number"][data-param-prop="${CSS.escape(prop)}"], input[data-param-role="range"][data-param-prop="${CSS.escape(prop)}"]`;
    return group ? Array.from(group.querySelectorAll(selector)).find(visible) || null : null;
  }, { gid, prop });
  const numberElement = fallbackNumber.asElement();
  if (numberElement) return { locator: numberElement, kind: 'number', scope: `${await numberElement.getAttribute('data-param-gid')}:${prop}` };
  return null;
}

async function setControlValue(control, value) {
  await control.locator.scrollIntoViewIfNeeded().catch(() => {});
  if (control.kind === 'color') {
    await control.locator.fill(String(value));
  } else {
    const tag = await control.locator.evaluate(node => node.tagName.toLowerCase());
    const type = await control.locator.getAttribute('type');
    if (type === 'range') {
      await control.locator.evaluate((node, nextValue) => {
        const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value')?.set;
        setter?.call(node, String(nextValue));
        node.dispatchEvent(new Event('input', { bubbles: true }));
        node.dispatchEvent(new Event('change', { bubbles: true }));
      }, value);
    } else if (tag === 'select') {
      await control.locator.selectOption(String(value));
    } else {
      await control.locator.fill(String(value));
    }
  }
  await control.locator.press('Enter').catch(() => {});
  await control.locator.evaluate(node => node.blur()).catch(() => {});
  await new Promise(resolve => setTimeout(resolve, 700));
}

async function stateSnapshot(page) {
  return page.evaluate((storageKey) => {
    const raw = window.sessionStorage.getItem(storageKey);
    const state = raw ? JSON.parse(raw) : {};
    const figureId = state.activeFigureId || 'fig_1';
    const figure = state.projectFigures?.[figureId] || {};
    return {
      activeFigureId: figureId,
      revision: figure.revision || null,
      editLog: figure.editLog || [],
      svg: figure.svg || '',
      manifest: figure.manifest || null,
      drafts: state.projectDrafts?.[figureId] || {},
      selectedGids: state.selectedGids || [],
    };
  }, APP_STATE_KEY);
}

async function waitForApiSettle(startIndex, timeoutMs = 60000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    await new Promise(resolve => setTimeout(resolve, 350));
    const pending = apiRequests.slice(startIndex).length - apiResponses.slice(startIndex).length;
    if (pending <= 0 && apiResponses.length > startIndex) return;
  }
}

async function applyCurrentDraft(page) {
  const start = apiRequests.length;
  const button = page.getByRole('button', { name: '应用当前图', exact: true }).first();
  if (!(await button.isVisible({ timeout: 5000 }).catch(() => false))) return { clicked: false, successful: false };
  const responsePromise = page.waitForResponse(response => (
    response.request().method() === 'POST'
    && new URL(response.url()).pathname === '/api/figure/patch'
  ), { timeout: 60000 });
  await button.click();
  const response = await responsePromise;
  const responseData = await response.json().catch(() => null);
  await waitForApiSettle(start);
  await waitForWorkspaceReady(page);
  const request = apiRequests.slice(start).find(item => new URL(item.url).pathname === '/api/figure/patch') || null;
  return {
    clicked: true,
    successful: response.ok() && responseData?.status === 'success',
    requestBody: parseJson(request?.postData),
    responseData,
  };
}

function editLogHasPatch(editLog, patch) {
  return Array.isArray(editLog) && editLog.some(entry => (
    entry?.gid === patch.gid
    && entry?.prop === patch.prop
    && String(entry?.value).toLowerCase() === String(patch.value).toLowerCase()
  ));
}

function summarizePatchResponse(responseData) {
  if (!responseData || typeof responseData !== 'object') return responseData || null;
  const summarizeEntries = entries => (Array.isArray(entries)
    ? entries.map(entry => ({ gid: entry?.gid, prop: entry?.prop, mode: entry?.mode }))
    : []);
  return {
    status: responseData.status,
    message: responseData.message,
    revision: responseData.revision,
    applied: summarizeEntries(responseData.applied),
    rejected: summarizeEntries(responseData.rejected),
    warnings: Array.isArray(responseData.warnings)
      ? responseData.warnings.map(warning => ({
        type: warning?.type,
        gid: warning?.gid,
        prop: warning?.prop,
        mismatches: warning?.mismatches,
      }))
      : [],
    requestId: responseData.requestId,
  };
}

function isLegendPatchLinkedToTarget(manifest, target, patch) {
  if (!patch?.gid || patch.gid === target?.id) return false;
  const targetRelation = target?.identity?.relation || {};
  const patchObject = objectById(manifest, patch.gid);
  const patchRelation = patchObject?.identity?.relation || {};
  return Array.isArray(targetRelation.legendMarkerIds)
    && targetRelation.legendMarkerIds.includes(patch.gid)
    && patchRelation.parentId === target.id
    && Boolean(patchRelation.legendId);
}

async function verifySafeStyleEdit(page, entry, manifest, projectId) {
  await clickCenter(page, '组件中心');
  const deniedBefore = await visibleDeniedControls(page);
  if (deniedBefore.length > 0) {
    record(entry.id, 'denied-structural-scientific-controls', 'FAIL', `visible denied controls: ${JSON.stringify(deniedBefore)}`);
    return null;
  }
  record(entry.id, 'denied-structural-scientific-controls', 'PASS', 'no visible controls for structural/scientific properties');

  const target = chooseSafeEdit(manifest);
  if (!target) {
    record(entry.id, 'safe-style-edit', 'N/A', 'manifest exposes no safe non-scientific style property');
    return null;
  }
  const { object, prop } = target;
  const value = nextSafeValue(object, prop);
  const selected = await selectObject(page, object.id);
  if (!selected) {
    record(entry.id, 'safe-style-edit', 'FAIL', `safe target ${object.id}:${prop} could not be selected`);
    return null;
  }
  if (prop === 'fontsize') await clickCenter(page, '字体中心');
  else await clickCenter(page, '组件中心');
  const control = await findEditableControl(page, object.id, prop);
  if (!control) {
    record(entry.id, 'safe-style-edit', 'FAIL', `manifest exposes ${object.id}:${prop}, but no matching UI control was visible`);
    return null;
  }

  const before = await stateSnapshot(page);
  await setControlValue(control, value);
  const afterDraft = await stateSnapshot(page);
  const body = await getBodyText(page);
  const hasDraft = Object.keys(afterDraft.drafts || {}).length > 0 || body.includes('已暂存');
  if (!hasDraft) {
    record(entry.id, 'safe-style-draft', 'FAIL', `editing ${object.id}:${prop} did not create a visible/runtime draft`);
    return null;
  }

  const applied = await applyCurrentDraft(page);
  const patches = Array.isArray(applied.requestBody?.patches) ? applied.requestBody.patches : [];
  const unsafePatch = patches.find(patch => DENIED_PROPS.includes(patch?.prop));
  const stylePatches = patches.filter(patch => SAFE_STYLE_PROPS.includes(patch?.prop));
  const targetPatch = patches.find(patch => patch?.gid === object.id && patch?.prop === prop);
  const unrelatedObjectPatches = patches.filter(patch => (
    patch?.gid !== object.id
    && !isLegendPatchLinkedToTarget(manifest, object, patch)
  ));
  const afterApply = await stateSnapshot(page);
  const revisionOk = Number(afterApply.revision) > Number(before.revision || 0);
  const editLogOk = stylePatches.length > 0 && stylePatches.every(patch => editLogHasPatch(afterApply.editLog, patch));
  const ok = applied.clicked
    && applied.successful
    && Boolean(targetPatch)
    && !unsafePatch
    && unrelatedObjectPatches.length === 0
    && revisionOk
    && editLogOk;
  record(
    entry.id,
    'safe-style-edit',
    ok ? 'PASS' : 'FAIL',
    `target=${object.id}:${prop}, control=${control.scope}, targetPatch=${Boolean(targetPatch)}, unrelated=${JSON.stringify(unrelatedObjectPatches)}, patches=${JSON.stringify(patches)}, revision=${before.revision}->${afterApply.revision}, response=${JSON.stringify(summarizePatchResponse(applied.responseData))}`,
  );
  if (!ok) return null;

  const persisted = await requestJson(`/api/projects/${projectId}/figures?includePreview=1`);
  const persistedFigure = (persisted.figures || []).find(figure => figure.figureId === afterApply.activeFigureId);
  const databaseOk = stylePatches.every(patch => editLogHasPatch(persistedFigure?.editLog, patch));
  await page.reload({ waitUntil: 'networkidle', timeout: 30000 });
  await waitForWorkspaceReady(page);
  const afterRefresh = await stateSnapshot(page);
  const sessionOk = stylePatches.every(patch => editLogHasPatch(afterRefresh.editLog, patch));
  const refreshOk = databaseOk && sessionOk;
  record(entry.id, 'safe-style-refresh-persistence', refreshOk ? 'PASS' : 'FAIL',
    `database=${databaseOk}, refreshedSession=${sessionOk}, editLog=${JSON.stringify(afterRefresh.editLog)}`);
  return { target: object, prop, value, patches: stylePatches, beforeRevision: before.revision, afterRevision: afterApply.revision };
}

async function clickHistoryButton(page, name) {
  const button = page.getByRole('button', { name, exact: true }).first();
  if (!(await button.isVisible({ timeout: 5000 }).catch(() => false))) return { visible: false, enabled: false };
  const enabled = await button.isEnabled().catch(() => false);
  if (!enabled) return { visible: true, enabled: false };
  const responsePromise = page.waitForResponse(response => (
    response.request().method() === 'POST'
    && new URL(response.url()).pathname.endsWith('/figures/render')
  ), { timeout: 60000 }).catch(() => null);
  await button.click();
  const response = await responsePromise;
  await waitForWorkspaceReady(page);
  return { visible: true, enabled, ok: Boolean(response?.ok()) };
}

async function verifyUndoRedo(page, entry, editResult) {
  if (!editResult) {
    record(entry.id, 'undo-redo', 'N/A', 'no safe edit was applied, so no history operation is expected');
    return;
  }
  const undo = await clickHistoryButton(page, '撤销');
  if (!undo.visible || !undo.enabled) {
    record(entry.id, 'undo-redo', 'N/A', `history not available after applied edit: ${JSON.stringify(undo)}`);
    return;
  }
  const undoState = await stateSnapshot(page);
  const removed = editResult.patches.every(patch => !editLogHasPatch(undoState.editLog, patch));
  const redo = await clickHistoryButton(page, '重做');
  const redoState = await stateSnapshot(page);
  const restored = editResult.patches.every(patch => editLogHasPatch(redoState.editLog, patch));
  record(entry.id, 'undo-redo', undo.ok && removed && redo.ok && restored ? 'PASS' : 'FAIL',
    `undo=${JSON.stringify(undo)}, removed=${removed}, redo=${JSON.stringify(redo)}, restored=${restored}`);
}

async function verifyExport(page, entry, projectId) {
  const state = await stateSnapshot(page);
  const exported = await requestJson(`/api/projects/${projectId}/export`, {
    method: 'POST',
    body: JSON.stringify({ figureId: state.activeFigureId || 'fig_1', format: 'svg', dpi: 150, saveToLibrary: false }),
  });
  const svg = String(exported.figures?.[0]?.svg || exported.svg || '');
  const ok = svg.includes('<svg') && svg.length > 100;
  record(entry.id, 'export-svg', ok ? 'PASS' : 'FAIL', `figure=${state.activeFigureId}, bytes=${svg.length}`);
}

function stableHash(text) {
  let hash = 2166136261;
  for (let index = 0; index < text.length; index += 1) {
    hash ^= text.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0).toString(16);
}

async function verifyMultiFigure5(page, entry) {
  if (entry.id !== 'python_multi_figure_5') return;
  const expectedIds = ['fig_1', 'fig_2', 'fig_3', 'fig_4', 'fig_5'];
  const signatures = [];
  for (let index = 0; index < expectedIds.length; index += 1) {
    const label = `Figure ${index + 1}`;
    const clicked = await page.getByRole('button', { name: new RegExp(`^${label}\\s*$`) }).click({ timeout: 10000 }).then(() => true).catch(() => false);
    await waitForWorkspaceReady(page);
    await page.waitForTimeout(250);
    const snapshot = await stateSnapshot(page);
    const expectedTitle = `Synthetic Figure ${index + 1}`;
    const liveSvgHtml = (await page.locator('[data-scifigure-canvas-svg="true"] > svg').first()
      .evaluate(node => node.outerHTML).catch(() => '')) || '';
    const liveSvgHash = stableHash(liveSvgHtml);
    const manifestTitles = manifestObjects({ manifest: snapshot.manifest })
      .filter(object => object.role === 'axes_title')
      .map(object => String(object.currentProps?.text || object.label || ''));
    const ids = manifestObjects({ manifest: snapshot.manifest }).map(object => object.id).sort().slice(0, 12);
    const titleMatches = manifestTitles.includes(expectedTitle);
    signatures.push({ figureId: snapshot.activeFigureId, clicked, expectedTitle, manifestTitles, liveSvgHash, liveSvgBytes: liveSvgHtml.length, ids });
    record(entry.id, `multi-figure-switch-${index + 1}`, clicked && snapshot.activeFigureId === expectedIds[index] && titleMatches ? 'PASS' : 'FAIL',
      `active=${snapshot.activeFigureId}, expected=${expectedIds[index]}, title=${expectedTitle}, manifest=${JSON.stringify(manifestTitles)}, liveHash=${liveSvgHash}, liveBytes=${liveSvgHtml.length}, sampleIds=${JSON.stringify(ids)}`);
  }
  const uniqueTitles = new Set(signatures.flatMap(item => item.manifestTitles));
  const uniqueLiveSvgs = new Set(signatures.map(item => item.liveSvgHash));
  record(entry.id, 'multi-figure-no-state-bleed', uniqueTitles.size === 5 && uniqueLiveSvgs.size === 5 ? 'PASS' : 'FAIL', `signatures=${JSON.stringify(signatures)}`);
  const returned = await page.getByRole('button', { name: /^Figure\s*1\s*$/ }).click({ timeout: 10000 }).then(() => true).catch(() => false);
  await waitForWorkspaceReady(page);
  const returnedState = await stateSnapshot(page);
  record(entry.id, 'multi-figure-return-to-edit-target', returned && returnedState.activeFigureId === 'fig_1' ? 'PASS' : 'FAIL',
    `returned=${returned}, active=${returnedState.activeFigureId}`);
}

function checkSpecialScopes(entry, manifest) {
  const objects = manifest?.objects || [];
  const roles = new Set(objects.map(object => object.role).filter(Boolean));
  if (entry.id === 'python_2x4_shared_legend') {
    const subplots = objects.filter(object => object.kind === 'subplot');
    const legends = objects.filter(object => object.kind === 'legend');
    const legend = objectById(manifest, 'legend.figure.0') || legends[0];
    const relation = legend?.identity?.relation || {};
    const ok = subplots.length >= 8 && legends.length === 1 && Boolean(legend) && !relation.subplotId;
    record(entry.id, 'special-shared-legend-scope', ok ? 'PASS' : 'FAIL',
      `subplots=${subplots.length}, legends=${legends.map(item => item.id).join(',')}, relation=${JSON.stringify(relation)}`);
  }
  if (entry.id === 'python_dual_heatmap_colorbar') {
    const heatmap0 = objectById(manifest, 'heatmap.image.0.0');
    const heatmap1 = objectById(manifest, 'heatmap.image.1.0');
    const colorbar2 = objectById(manifest, 'colorbar.2');
    const colorbar3 = objectById(manifest, 'colorbar.3');
    const ok = relationValue(heatmap0, 'colorbarId') === 'colorbar.2'
      && relationValue(heatmap1, 'colorbarId') === 'colorbar.3'
      && relationValue(colorbar2, 'mappableId') === 'heatmap.image.0.0'
      && relationValue(colorbar3, 'mappableId') === 'heatmap.image.1.0';
    record(entry.id, 'special-dual-heatmap-colorbar-scope', ok ? 'PASS' : 'FAIL',
      `h0=${JSON.stringify(heatmap0?.identity?.relation)}, h1=${JSON.stringify(heatmap1?.identity?.relation)}, c2=${JSON.stringify(colorbar2?.identity?.relation)}, c3=${JSON.stringify(colorbar3?.identity?.relation)}`);
  }
  if (entry.id === 'python_pie_wedge') {
    const pieSlices = objects.filter(object => object.role === 'pie_slice');
    const wedgeSlices = objects.filter(object => object.role === 'wedge_slice');
    const ok = pieSlices.length >= 3 && wedgeSlices.length >= 1 && pieSlices.every(object => object.identity?.relation?.pieId && Number.isInteger(object.identity?.relation?.sliceIndex));
    record(entry.id, 'special-pie-wedge-relations', ok ? 'PASS' : 'FAIL',
      `pie=${pieSlices.map(item => `${item.id}:${JSON.stringify(item.identity?.relation)}`).join(';')}, wedge=${wedgeSlices.map(item => item.id).join(',')}`);
  }
  if (entry.id === 'python_quiver_streamplot') {
    const ok = roles.has('quiver_field')
      && roles.has('streamplot_field')
      && roles.has('streamplot_child_line')
      && roles.has('streamplot_child_arrow')
      && (objectById(manifest, 'collection.0.0')?.identity?.relation?.legendMarkerIds || []).includes('legend_patch.0.0')
      && (objectById(manifest, 'container.streamplot.1.0')?.identity?.relation?.legendMarkerIds || []).includes('legend_line.1.0');
    record(entry.id, 'special-quiver-streamplot-relations', ok ? 'PASS' : 'FAIL', `roles=${JSON.stringify([...roles])}`);
  }
  if (entry.id === 'python_network_path_sem') {
    const diagramObjects = objects.filter(object => String(object.role || '').startsWith('diagram_'));
    const protectedText = diagramObjects.filter(object => ['diagram_coefficient_label', 'diagram_fit_annotation'].includes(object.role));
    const ok = diagramObjects.length >= 7
      && protectedText.every(object => !editableProps(object).includes('text'))
      && objectById(manifest, 'line.0.0')?.identity?.relation?.sourceNodeId === 'latent_a'
      && objectById(manifest, 'line.0.0')?.identity?.relation?.targetNodeId === 'observed_b';
    record(entry.id, 'special-network-sem-relations', ok ? 'PASS' : 'FAIL',
      `diagramObjects=${diagramObjects.map(item => `${item.id}:${item.role}`).join(',')}, protected=${protectedText.map(item => `${item.id}:${editableProps(item).join('/')}`).join(',')}`);
  }
}

async function verifyDeniedPropsAbsentForSpecialUi(page, entry) {
  if (!['python_pie_wedge', 'python_quiver_streamplot', 'python_network_path_sem', 'python_dual_heatmap_colorbar', 'python_2x4_shared_legend'].includes(entry.id)) return;
  await clickCenter(page, '组件中心');
  const denied = await visibleDeniedControls(page);
  record(entry.id, 'special-ui-denies-structural-scientific-props', denied.length === 0 ? 'PASS' : 'FAIL', `denied=${JSON.stringify(denied)}`);
}

async function runEntry(page, entry) {
  const fixture = await createAndRenderEntry(entry);
  diagnostics[entry.id] = { projectId: fixture.projectId, expectedFigures: entry.expectedFigures, renderedFigures: fixture.rendered.figures.length };
  const figure = figureById(fixture.rendered, 'fig_1');
  const manifestCheck = validateMatrixManifest(entry, fixture.rendered.figures);
  record(entry.id, 'render-svg-manifest-matrix', manifestCheck.ok ? 'PASS' : 'FAIL',
    manifestCheck.ok ? `figures=${fixture.rendered.figures.length}, counts=${JSON.stringify(manifestCheck.counts)}` : manifestCheck.failures.join('; '));
  if (entry.expectedFigures) {
    record(entry.id, 'expected-figure-count', fixture.rendered.figures.length === entry.expectedFigures ? 'PASS' : 'FAIL',
      `expected=${entry.expectedFigures}, actual=${fixture.rendered.figures.length}`);
  }
  checkSpecialScopes(entry, figure?.manifest);

  await page.goto(BASE_URL, { waitUntil: 'domcontentloaded', timeout: 30000 });
  await installProjectState(page, entry, fixture);
  await verifyCenters(page, entry, figure?.manifest);
  await verifyMultiFigure5(page, entry);
  await verifyDeniedPropsAbsentForSpecialUi(page, entry);
  const editResult = await verifySafeStyleEdit(page, entry, figure?.manifest, fixture.projectId);
  await verifyUndoRedo(page, entry, editResult);
  await verifyExport(page, entry, fixture.projectId);
}

async function deleteCreatedProjects() {
  await Promise.all([...createdProjectIds].map(projectId => (
    requestJson(`/api/projects/${projectId}`, { method: 'DELETE' }).then(() => {
      createdProjectIds.delete(projectId);
    }).catch(error => {
      record('cleanup', projectId, 'FAIL', `delete failed: ${error.message}`);
    })
  )));
}

function writeReport() {
  fs.mkdirSync(OUTPUT_DIR, { recursive: true });
  const passCount = results.filter(result => result.status === 'PASS').length;
  const failCount = results.filter(result => result.status === 'FAIL').length;
  const naCount = results.filter(result => result.status === 'N/A').length;
  const conclusion = failCount > 0 ? 'FAIL' : 'PASS';
  const report = {
    runId: RUN_ID,
    baseUrl: BASE_URL,
    outputDir: OUTPUT_DIR,
    conclusion,
    counts: { pass: passCount, fail: failCount, na: naCount },
    results,
    diagnostics,
    consoleErrors,
    pageErrors,
  };
  fs.writeFileSync(path.join(OUTPUT_DIR, 'report.json'), JSON.stringify(report, null, 2), 'utf8');
  const lines = [
    '# Python Capability Matrix UI Smoke',
    '',
    `- Run: ${RUN_ID}`,
    `- URL: ${BASE_URL}`,
    `- Conclusion: ${conclusion}`,
    `- PASS: ${passCount}`,
    `- FAIL: ${failCount}`,
    `- N/A: ${naCount}`,
    '',
    '| Entry | Check | Status | Evidence |',
    '|---|---|---|---|',
    ...results.map(result => `| ${result.entryId} | ${result.check} | ${result.status} | ${String(result.note).replace(/\|/g, '\\|')} |`),
    '',
    '## Runtime Errors',
    '',
    '```json',
    JSON.stringify({ consoleErrors, pageErrors }, null, 2),
    '```',
  ];
  fs.writeFileSync(path.join(OUTPUT_DIR, 'report.md'), lines.join('\n'), 'utf8');
  return report;
}

async function main() {
  assertIsolatedEnvironment();
  fs.mkdirSync(OUTPUT_DIR, { recursive: true });
  const entries = readMatrix();
  authToken = await authenticateCapabilitySmokeUser(BASE_URL, 'python capability matrix ui');
  await cleanupSmokeProjects();

  const browser = await chromium.launch({ headless: true, args: ['--no-sandbox'] });

  try {
    for (const entry of entries) {
      const context = await browser.newContext({ viewport: { width: 1500, height: 980 } });
      await installBrowserAuthentication(context, authToken);
      const page = await context.newPage();
      page.setDefaultTimeout(30000);
      page.on('console', message => {
        if (message.type() === 'error' && !isIgnorableDevServerNoise(message.text())) consoleErrors.push(message.text());
      });
      page.on('pageerror', error => {
        if (!isIgnorableDevServerNoise(error.message)) pageErrors.push(error.message);
      });
      page.on('request', request => {
        if (interestingApi(request)) apiRequests.push({ method: request.method(), url: request.url(), postData: request.postData() });
      });
      page.on('response', response => {
        if (interestingApi(response.request())) {
          apiResponses.push({
            method: response.request().method(),
            url: response.url(),
            status: response.status(),
            postData: response.request().postData(),
          });
        }
      });
      try {
        await runEntry(page, entry);
        await page.screenshot({ path: path.join(OUTPUT_DIR, `${entry.id}.png`), fullPage: true }).catch(() => {});
      } catch (error) {
        record(entry.id, 'entry-harness', 'FAIL', error.stack || error.message || String(error));
      } finally {
        await context.close();
        await deleteCreatedProjects();
      }
    }
    record('runtime', 'console-page-errors', consoleErrors.length === 0 && pageErrors.length === 0 ? 'PASS' : 'FAIL',
      `console=${JSON.stringify(consoleErrors)}, page=${JSON.stringify(pageErrors)}`);
  } finally {
    await browser.close();
    await deleteCreatedProjects();
  }

  const report = writeReport();
  console.log(`Report: ${path.join(OUTPUT_DIR, 'report.md')}`);
  console.log(`Conclusion: ${report.conclusion}, PASS=${report.counts.pass}, FAIL=${report.counts.fail}, N/A=${report.counts.na}`);
  if (report.conclusion !== 'PASS') process.exitCode = 1;
}

main().catch(error => {
  record('harness', 'fatal', 'FAIL', error.stack || error.message || String(error));
  const report = writeReport();
  console.error(`Report: ${path.join(OUTPUT_DIR, 'report.md')}`);
  console.error(`Conclusion: ${report.conclusion}, PASS=${report.counts.pass}, FAIL=${report.counts.fail}, N/A=${report.counts.na}`);
  process.exitCode = 1;
});
