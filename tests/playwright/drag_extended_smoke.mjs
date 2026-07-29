/**
 * SciFigure Studio drag extended behavior smoke test.
 *
 * Verifies:
 * - Multiple selected draggable text objects are accumulated into one confirm batch.
 * - Canceling a drag does not send /api/figure/patch.
 * - Unsupported objects in drag mode show a hint and do not generate patches.
 * - R/native-coordinate text is protected from drag position patches.
 *
 * Prerequisite:
 *   The app is running at http://localhost:3000.
 */

import { chromium } from 'playwright';
import * as fs from 'fs';
import * as path from 'path';
import { fileURLToPath } from 'url';
import {
  authenticateCapabilitySmokeUser,
  bearerHeaders,
  installBrowserAuthentication,
} from './smokeAuth.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '../..');
const BASE_URL = process.env.SCIFIGURE_URL || 'http://localhost:3000';
const RUN_ID = new Date().toISOString().replace(/[:.]/g, '-');
const OUTPUT_DIR = path.join(ROOT, 'output', 'playwright', `drag-extended-${RUN_ID}`);

const results = [];
const apiRequests = [];
const consoleErrors = [];
const pageErrors = [];
const diagnostics = {};
let authToken = '';

function record(id, status, note) {
  results.push({ id, status, note });
  console.log(`${status} ${id}: ${note}`);
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
  const url = request.url();
  return url.includes('/api/figure') || url.includes('/api/projects');
}

async function requestJson(pathname, options = {}) {
  const res = await fetch(`${BASE_URL}${pathname}`, {
    ...options,
    headers: {
      'Content-Type': 'application/json',
      ...bearerHeaders(authToken),
      ...(options.headers || {}),
    },
  });
  const data = await res.json().catch(() => null);
  if (!res.ok) {
    throw new Error(`${options.method || 'GET'} ${pathname} failed: ${res.status} ${JSON.stringify(data)}`);
  }
  return data;
}

async function cleanupSmokeProjects() {
  const data = await requestJson('/api/projects');
  const projects = Array.isArray(data.projects) ? data.projects : [];
  await Promise.all(projects
    .filter((project) => String(project?.name || '').startsWith('Drag extended smoke'))
    .map((project) => {
      const id = project.id || project.projectId;
      return id ? requestJson(`/api/projects/${id}`, { method: 'DELETE' }).catch(() => null) : null;
    }));
}

async function getBodyText(page) {
  return (await page.textContent('body').catch(() => '')) || '';
}

async function waitForPreviewReady(page, timeoutMs = 90000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const body = await getBodyText(page);
    const rendering = body.includes('正在重新渲染当前图形') || body.includes('等待 Python 渲染结果') || body.includes('正在恢复项目预览');
    const svgCount = await page.locator('svg').count().catch(() => 0);
    if (!rendering && svgCount > 0 && body.includes('属性编辑')) return true;
    await page.waitForTimeout(600);
  }
  return false;
}

async function clickVisibleText(page, text, timeout = 5000) {
  const locators = [
    page.getByRole('button', { name: new RegExp(text) }).first(),
    page.getByText(new RegExp(text)).first(),
  ];
  for (const locator of locators) {
    if (await locator.isVisible({ timeout }).catch(() => false)) {
      await locator.click();
      await page.waitForTimeout(300);
      return true;
    }
  }
  return false;
}

async function ensureDragMode(page, enabled) {
  const button = page.getByRole('button', { name: /拖拽微调/ }).first();
  if (!(await button.isVisible({ timeout: 5000 }).catch(() => false))) return false;
  const text = (await button.textContent().catch(() => '')) || '';
  const isEnabled = text.includes('开');
  if (isEnabled !== enabled) {
    await button.click();
    await page.waitForTimeout(500);
  }
  const nextText = (await button.textContent().catch(() => '')) || '';
  return enabled ? nextText.includes('开') : nextText.includes('关');
}

async function findBoxByText(page, marker) {
  return page.evaluate((needle) => {
    const textIdPattern = /^(r\.text|text|title|xlabel|ylabel|legend_text|legend_title|fig_text)\./;
    const candidates = Array.from(document.querySelectorAll('svg [id], svg [data-fig-id]'))
      .map((node) => {
        const text = node.textContent || '';
        const id = node.id || node.getAttribute('data-fig-id') || '';
        const rect = node.getBoundingClientRect();
        return {
          id,
          text,
          x: rect.left + rect.width / 2,
          y: rect.top + rect.height / 2,
          width: rect.width,
          height: rect.height,
        };
      })
      .filter((item) => textIdPattern.test(item.id) && item.text.includes(needle) && item.width > 2 && item.height > 2)
      .sort((a, b) => {
        const exactA = a.text.trim() === needle ? 0 : 1;
        const exactB = b.text.trim() === needle ? 0 : 1;
        return exactA - exactB || a.id.length - b.id.length;
      });
    return candidates[0] || null;
  }, marker);
}

async function findBoxByGid(page, gid) {
  return page.evaluate((targetGid) => {
    const node = document.querySelector(`svg #${CSS.escape(targetGid)}, svg [data-fig-id="${targetGid}"]`);
    if (!node) return null;
    const rect = node.getBoundingClientRect();
    if (rect.width <= 2 || rect.height <= 2) return null;
    return {
      id: node.id || node.getAttribute('data-fig-id') || targetGid,
      text: node.textContent || '',
      x: rect.left + rect.width / 2,
      y: rect.top + rect.height / 2,
      width: rect.width,
      height: rect.height,
    };
  }, gid);
}

async function findUnsupportedLineBox(page) {
  return page.evaluate(() => {
    const candidates = Array.from(document.querySelectorAll('svg [id]'))
      .map((node) => {
        const id = node.id || '';
        const rect = node.getBoundingClientRect();
        const path = node instanceof SVGGeometryElement
          ? node
          : node.querySelector('path');
        let x = rect.left + rect.width / 2;
        let y = rect.top + rect.height / 2;
        if (path instanceof SVGGeometryElement) {
          const point = path.getPointAtLength(path.getTotalLength() * 0.08);
          const matrix = path.getScreenCTM();
          if (matrix) {
            const screenPoint = new DOMPoint(point.x, point.y).matrixTransform(matrix);
            x = screenPoint.x;
            y = screenPoint.y;
          }
        }
        return {
          id,
          x,
          y,
          width: rect.width,
          height: rect.height,
        };
      })
      .filter((item) => /^line\.\d+\.\d+/.test(item.id) && item.width > 10 && item.height > 2);
    return candidates[0] || null;
  });
}

async function dragBox(page, box, dx = 80, dy = 28) {
  const before = await page.evaluate((gid) => {
    const escaped = CSS.escape(gid);
    const node = document.querySelector(`svg #${escaped}, svg [data-fig-id="${escaped}"]`);
    if (!node) return null;
    const rect = node.getBoundingClientRect();
    return { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2, tag: node.tagName, transform: node.getAttribute('transform') };
  }, box.id);
  await page.mouse.move(box.x, box.y);
  await page.mouse.down();
  await page.mouse.move(box.x + dx, box.y + dy, { steps: 10 });
  await page.waitForTimeout(150);
  const during = await page.evaluate((gid) => {
    const escaped = CSS.escape(gid);
    const node = document.querySelector(`svg #${escaped}, svg [data-fig-id="${escaped}"]`);
    if (!node) return null;
    const rect = node.getBoundingClientRect();
    return { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2, tag: node.tagName, transform: node.getAttribute('transform') };
  }, box.id);
  await page.mouse.up();
  await page.waitForTimeout(700);
  const after = await page.evaluate((gid) => {
    const escaped = CSS.escape(gid);
    const node = document.querySelector(`svg #${escaped}, svg [data-fig-id="${escaped}"]`);
    if (!node) return null;
    const rect = node.getBoundingClientRect();
    return { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2, tag: node.tagName, transform: node.getAttribute('transform') };
  }, box.id);
  return { before, during, after };
}

function didObjectFollowDrag(geometry, minimumDistance = 20) {
  return Boolean(
    geometry?.before
    && geometry?.during
    && geometry?.after
    && Math.hypot(
      geometry.during.x - geometry.before.x,
      geometry.during.y - geometry.before.y,
    ) > minimumDistance
    && Math.hypot(
      geometry.after.x - geometry.before.x,
      geometry.after.y - geometry.before.y,
    ) > minimumDistance
  );
}

async function waitForApiSettle(page, startIndex, timeoutMs = 30000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (apiRequests.length > startIndex) {
      await page.waitForTimeout(1200);
      return true;
    }
    await page.waitForTimeout(250);
  }
  return false;
}

async function preparePythonProject(page) {
  const script = [
    'import matplotlib.pyplot as plt',
    'fig, ax = plt.subplots(figsize=(5, 3))',
    'ax.plot([0, 1, 2], [1, 3, 2], color="#336699", linewidth=1.5)',
    'ax.set_title("Drag Extended Figure")',
    'ax.set_xlabel("X Axis")',
    'ax.set_ylabel("Y Axis")',
    'ax.text(0.34, 0.72, "DRAG_A", transform=ax.transAxes, ha="center", va="center", fontsize=14)',
    'ax.text(0.66, 0.42, "DRAG_B", transform=ax.transAxes, ha="center", va="center", fontsize=14)',
    'ax.text(0.50, 0.25, "DRAG_C", transform=ax.transAxes, ha="center", va="center", fontsize=14)',
    'ax.annotate("DRAG_ANN", xy=(1.0, 3.0), xytext=(1.55, 3.25), arrowprops=dict(arrowstyle="->"), fontsize=12)',
    'plt.tight_layout()',
  ].join('\n');

  const fixture = await page.evaluate(async ({ baseUrl, script }) => {
    const spec = {
      plot_type: 'custom',
      custom_script: script,
      script,
      script_language: 'python',
      figure: { width: 120, height: 80, unit: 'mm', dpi: 300 },
    };
    const createRes = await fetch(`${baseUrl}/api/projects`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: `Drag extended smoke ${Date.now()}`, spec }),
    });
    const created = await createRes.json();
    if (created.status !== 'success') throw new Error(created.message || 'create project failed');

    const renderRes = await fetch(`${baseUrl}/api/projects/${created.id}/figures/render`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ script, editLogs: { fig_1: [] }, language: 'python', requestId: `drag-extended-${Date.now()}` }),
    });
    const rendered = await renderRes.json();
    if (rendered.status !== 'success' || !Array.isArray(rendered.figures) || rendered.figures.length === 0) {
      throw new Error(rendered.message || 'render fixture failed');
    }
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
    const currentRaw = window.sessionStorage.getItem('scifigure:app-state:v2');
    const current = currentRaw ? JSON.parse(currentRaw) : {};
    window.sessionStorage.setItem('scifigure:app-state:v2', JSON.stringify({
      ...current,
      spec,
      history: [spec],
      historyIndex: 0,
      projectId: created.id,
      projectName: 'Drag extended fixture',
      projectFigures,
      activeFigureId: 'fig_1',
      datasets: [],
      selectedGids: [],
      projectHistory: {},
      figSession: null,
      renderLog: ['> Drag extended fixture ready'],
      currentView: 'workspace',
      subView: 'home',
    }));
    const objects = rendered.figures[0]?.manifest?.objects || [];
    const annotation = objects.find(object => object?.currentProps?.text === 'DRAG_ANN');
    const title = objects.find(object => object?.id === 'title.0');
    const xlabel = objects.find(object => object?.id === 'xlabel.0');
    const ylabel = objects.find(object => object?.id === 'ylabel.0');
    return {
      projectId: created.id,
      objectCount: objects.length,
      annotationId: annotation?.id || null,
      annotationArrowId: annotation?.identity?.relation?.arrowId || null,
      annotationRole: annotation?.role || null,
      titlePosition: title?.currentProps || null,
      xlabelPosition: xlabel?.currentProps || null,
      ylabelPosition: ylabel?.currentProps || null,
    };
  }, { baseUrl: BASE_URL, script });

  await page.reload({ waitUntil: 'domcontentloaded', timeout: 60000 });
  await waitForPreviewReady(page);
  await clickVisibleText(page, '属性编辑', 3000);
  return fixture;
}

async function setSelectedGidsAndReload(page, gids) {
  await page.evaluate((selectedGids) => {
    const raw = window.sessionStorage.getItem('scifigure:app-state:v2');
    const state = raw ? JSON.parse(raw) : {};
    state.selectedGids = selectedGids;
    window.sessionStorage.setItem('scifigure:app-state:v2', JSON.stringify(state));
  }, gids);
  await page.reload({ waitUntil: 'domcontentloaded', timeout: 60000 });
  await waitForPreviewReady(page);
  await clickVisibleText(page, '属性编辑', 3000);
}

async function clearSelectionInUi(page) {
  const clearButton = page.getByRole('button', { name: /^取消选择$/ }).first();
  if (await clearButton.isVisible({ timeout: 1000 }).catch(() => false)) {
    await clearButton.click();
    await page.waitForTimeout(300);
  }
  return !(await getBodyText(page)).includes('批量编辑已选图元');
}

async function selectTextBoxesWithControl(page, labels) {
  const states = [];
  for (const label of labels) {
    const box = await findBoxByText(page, label);
    if (!box) return { selected: [], states, body: await getBodyText(page) };
    await page.keyboard.down('Control');
    try {
      await page.mouse.click(box.x, box.y);
    } finally {
      await page.keyboard.up('Control');
    }
    await page.waitForTimeout(250);
    const actual = await page.evaluate(() => {
      const raw = window.sessionStorage.getItem('scifigure:app-state:v2');
      const state = raw ? JSON.parse(raw) : {};
      return Array.isArray(state.selectedGids) ? state.selectedGids : [];
    });
    states.push({ label, expectedGid: box.id, actual });
  }
  return {
    selected: states.at(-1)?.actual || [],
    states,
    body: await getBodyText(page),
  };
}

async function injectRNativeCoordinateFixture(page) {
  const svg = [
    '<svg width="420" height="260" viewBox="0 0 420 260" xmlns="http://www.w3.org/2000/svg">',
    '<rect id="r.panel.0" data-fig-id="r.panel.0" x="40" y="30" width="320" height="180" fill="white" stroke="#222"/>',
    '<text id="r.text.0" data-fig-id="r.text.0" x="180" y="120" font-size="18">R_NATIVE_TEXT</text>',
    '</svg>',
  ].join('');
  const manifest = {
    version: '1.0',
    generatedBy: 'r_svg',
    objects: [
      {
        id: 'r.text.0',
        kind: 'text',
        label: 'R native text',
        editable: ['position', 'text'],
        currentProps: { x: 1.5, y: 2.5, coord_system: 'native' },
        role: 'annotation',
        subplotId: 'subplot.0',
      },
      {
        id: 'r.panel.0',
        kind: 'spine',
        label: 'R panel',
        editable: [],
        currentProps: {},
        subplotId: 'subplot.0',
      },
    ],
    palettes: [],
    groups: [],
    bindings: [],
  };
  const spec = {
    plot_type: 'custom',
    custom_script: '# fake R drag protection fixture',
    script: '# fake R drag protection fixture',
    script_language: 'r',
    figure: { width: 120, height: 80, unit: 'mm', dpi: 300 },
  };
  for (let attempt = 0; attempt < 2; attempt += 1) {
    await page.evaluate(({ svg, manifest, spec }) => {
      const figSession = {
        sessionId: 'drag-r-protection-fixture',
        script: spec.script,
        language: 'r',
        dataPayload: {},
        editLog: [],
        revision: 1,
        svg,
        manifest,
        createdAt: Date.now(),
        updatedAt: Date.now(),
      };
      window.sessionStorage.setItem('scifigure:app-state:v2', JSON.stringify({
        spec,
        history: [spec],
        historyIndex: 0,
        projectId: null,
        projectName: 'Drag R native protection fixture',
        projectFigures: {},
        activeFigureId: 'fig_1',
        datasets: [],
        selectedGids: [],
        projectHistory: {},
        figSession,
        renderLog: ['> Drag R native fixture ready'],
        currentView: 'workspace',
        subView: 'home',
      }));
    }, { svg, manifest, spec });
    await page.reload({ waitUntil: 'networkidle', timeout: 30000 });
    await waitForPreviewReady(page);
    if (await findBoxByGid(page, 'r.text.0')) break;
  }
  await clickVisibleText(page, '属性编辑', 3000);
}

async function run() {
  fs.mkdirSync(OUTPUT_DIR, { recursive: true });
  authToken = await authenticateCapabilitySmokeUser(BASE_URL, 'drag extended');
  await cleanupSmokeProjects();

  const browser = await chromium.launch({ headless: true, args: ['--no-sandbox'] });
  const context = await browser.newContext({ viewport: { width: 1440, height: 950 } });
  await installBrowserAuthentication(context, authToken);
  const page = await context.newPage();
  let fixtureProjectId = null;

  page.on('console', (msg) => {
    if (['error'].includes(msg.type())) consoleErrors.push(msg.text());
  });
  page.on('pageerror', (err) => pageErrors.push(err.message));
  page.on('request', (request) => {
    if (interestingApi(request)) {
      apiRequests.push({ url: request.url(), method: request.method(), postData: request.postData() });
    }
  });

  try {
    await page.goto(BASE_URL, { waitUntil: 'domcontentloaded', timeout: 60000 });
    const fixture = await preparePythonProject(page);
    fixtureProjectId = fixture.projectId;
    const boxA = await findBoxByText(page, 'DRAG_A');
    const boxB = await findBoxByText(page, 'DRAG_B');
    const boxC = await findBoxByText(page, 'DRAG_C');
    const lineBox = await findUnsupportedLineBox(page);
    diagnostics.boxA = boxA;
    diagnostics.boxB = boxB;
    diagnostics.boxC = boxC;
    diagnostics.lineBox = lineBox;
    diagnostics.annotation = fixture;

    record(
      'D0-annotation-relation',
      fixture.annotationId && fixture.annotationArrowId && fixture.annotationRole === 'annotation_text' ? 'PASS' : 'FAIL',
      `text=${fixture.annotationId}, arrow=${fixture.annotationArrowId}, role=${fixture.annotationRole}`,
    );

    if (!boxA || !boxB) {
      record('D0-fixture', 'BLOCKED', `missing draggable text boxes: A=${Boolean(boxA)}, B=${Boolean(boxB)}`);
    } else {
      record('D0-fixture', 'PASS', `found text boxes ${boxA.id}, ${boxB.id}`);

      const dragModeOn = await ensureDragMode(page, true);
      const multiLabels = ['DRAG_A', 'DRAG_B', ...(boxC ? ['DRAG_C'] : [])];
      const multiSelection = await selectTextBoxesWithControl(page, multiLabels);
      const expectedMultiCount = boxC ? 3 : 2;
      const selectionReady = multiSelection.selected.length === expectedMultiCount
        && multiSelection.body.includes(`已选择 ${expectedMultiCount} 个对象`);
      const freshBoxA = await findBoxByText(page, 'DRAG_A');
      await dragBox(page, freshBoxA || boxA, 70, 25);
      const bodyAfterMultiDrag = await getBodyText(page);
      const multiConfirm = bodyAfterMultiDrag.includes(`已累计移动 ${expectedMultiCount} 个文本对象`);
      const confirmStart = apiRequests.length;
      const confirmed = multiConfirm && await clickVisibleText(page, '确认位置', 3000);
      if (confirmed) {
        await waitForApiSettle(page, confirmStart, 30000);
        await waitForPreviewReady(page);
      }
      const patchRequests = apiRequests.slice(confirmStart).filter((r) => r.url.includes('/api/figure/patch'));
      const patchBody = parseJson(patchRequests[0]?.postData);
      const positionPatches = Array.isArray(patchBody?.patches)
        ? patchBody.patches.filter((patch) => patch?.prop === 'position')
        : [];
      record(
        'D1-multi-drag',
        dragModeOn && selectionReady && multiConfirm && confirmed && patchRequests.length === 1 && positionPatches.length === expectedMultiCount ? 'PASS' : 'FAIL',
        `dragMode=${dragModeOn}, selectionReady=${selectionReady}, selected=${multiSelection.selected.join(',')}, states=${JSON.stringify(multiSelection.states)}, confirmBar=${multiConfirm}, confirmed=${confirmed}, patchRequests=${patchRequests.length}, positionPatches=${positionPatches.length}`,
      );

      await clearSelectionInUi(page);
      const sequentialDragModeOn = await ensureDragMode(page, true);
      const firstDragGeometry = await dragBox(page, await findBoxByText(page, 'DRAG_A'), 70, 25);
      diagnostics.firstDragGeometry = firstDragGeometry;
      record(
        'D1a-live-object-preview',
        didObjectFollowDrag(firstDragGeometry) ? 'PASS' : 'FAIL',
        `geometry=${JSON.stringify(firstDragGeometry)}`,
      );
      const bodyAfterFirstSequentialDrag = await getBodyText(page);
      const firstSequentialPending = bodyAfterFirstSequentialDrag.includes('已累计移动 1 个文本对象');
      await dragBox(page, await findBoxByText(page, 'DRAG_B'), -60, 35);
      const bodyAfterSecondSequentialDrag = await getBodyText(page);
      const secondSequentialPending = bodyAfterSecondSequentialDrag.includes('已累计移动 2 个文本对象');
      const sequentialConfirmStart = apiRequests.length;
      const sequentialConfirmed = secondSequentialPending && await clickVisibleText(page, '确认位置', 3000);
      if (sequentialConfirmed) {
        await waitForApiSettle(page, sequentialConfirmStart, 30000);
        await waitForPreviewReady(page);
      }
      const sequentialPatchRequests = apiRequests.slice(sequentialConfirmStart).filter((r) => r.url.includes('/api/figure/patch'));
      const sequentialPatchBody = parseJson(sequentialPatchRequests[0]?.postData);
      const sequentialPositionPatches = Array.isArray(sequentialPatchBody?.patches)
        ? sequentialPatchBody.patches.filter((patch) => patch?.prop === 'position')
        : [];
      const sequentialGids = sequentialPositionPatches.map((patch) => patch?.gid).sort();
      const hasDistinctSequentialGids = sequentialGids.includes(boxA.id) && sequentialGids.includes(boxB.id) && new Set(sequentialGids).size === 2;
      record(
        'D1-sequential-drag',
        sequentialDragModeOn && firstSequentialPending && secondSequentialPending && sequentialConfirmed && sequentialPatchRequests.length === 1 && sequentialPositionPatches.length === 2 && hasDistinctSequentialGids ? 'PASS' : 'FAIL',
        `dragMode=${sequentialDragModeOn}, firstPending=${firstSequentialPending}, secondPending=${secondSequentialPending}, confirmed=${sequentialConfirmed}, patchRequests=${sequentialPatchRequests.length}, positionPatches=${sequentialPositionPatches.length}, gids=${sequentialGids.join(',')}`,
      );

      await setSelectedGidsAndReload(page, []);
      const xlabelBox = await findBoxByText(page, 'X Axis');
      const ylabelBox = await findBoxByText(page, 'Y Axis');
      const axisDragModeOn = await ensureDragMode(page, true);
      if (!xlabelBox || !ylabelBox || !fixture.xlabelPosition || !fixture.ylabelPosition) {
        record('D1b-axis-label-drag', 'BLOCKED', `xlabel=${Boolean(xlabelBox)}, ylabel=${Boolean(ylabelBox)}`);
      } else {
        const xlabelDragGeometry = await dragBox(page, xlabelBox, 60, 30);
        const xlabelPending = (await getBodyText(page)).includes('已累计移动 1 个文本对象');
        const ylabelDragGeometry = await dragBox(page, await findBoxByText(page, 'Y Axis'), -45, -25);
        diagnostics.axisLabelDragGeometry = { xlabel: xlabelDragGeometry, ylabel: ylabelDragGeometry };
        const axisLabelsFollowed = didObjectFollowDrag(xlabelDragGeometry)
          && didObjectFollowDrag(ylabelDragGeometry);
        const ylabelPending = (await getBodyText(page)).includes('已累计移动 2 个文本对象');
        const axisConfirmStart = apiRequests.length;
        const axisResponsePromise = page.waitForResponse(response => (
          response.url().includes('/api/figure/patch')
          && response.request().method() === 'POST'
        ), { timeout: 30000 });
        const axisConfirmed = ylabelPending && await clickVisibleText(page, '确认位置', 3000);
        const axisResponse = axisConfirmed ? await axisResponsePromise : null;
        const axisResponseBody = axisResponse ? await axisResponse.json().catch(() => null) : null;
        if (axisConfirmed) {
          await waitForApiSettle(page, axisConfirmStart, 30000);
          await waitForPreviewReady(page);
        }
        const axisRequests = apiRequests.slice(axisConfirmStart).filter(request => request.url.includes('/api/figure/patch'));
        const axisRequestBody = parseJson(axisRequests[0]?.postData);
        const axisPatches = Array.isArray(axisRequestBody?.patches)
          ? axisRequestBody.patches.filter(patch => patch?.prop === 'position')
          : [];
        const xlabelPatch = axisPatches.find(patch => patch?.gid === 'xlabel.0');
        const ylabelPatch = axisPatches.find(patch => patch?.gid === 'ylabel.0');
        const returnedObjects = axisResponseBody?.manifest?.objects || [];
        const returnedXlabel = returnedObjects.find(object => object?.id === 'xlabel.0');
        const returnedYlabel = returnedObjects.find(object => object?.id === 'ylabel.0');
        const returnedMatches = [
          [returnedXlabel, xlabelPatch],
          [returnedYlabel, ylabelPatch],
        ].every(([object, patch]) => (
          object && patch
          && Math.abs(Number(object.currentProps?.x) - Number(patch.value?.x)) < 0.01
          && Math.abs(Number(object.currentProps?.y) - Number(patch.value?.y)) < 0.01
          && object.currentProps?.coord_system === 'axes'
        ));
        const directionsCorrect = xlabelPatch
          && ylabelPatch
          && Number(xlabelPatch.value?.x) > Number(fixture.xlabelPosition.x)
          && Number(xlabelPatch.value?.y) < Number(fixture.xlabelPosition.y)
          && Number(ylabelPatch.value?.x) < Number(fixture.ylabelPosition.x)
          && Number(ylabelPatch.value?.y) > Number(fixture.ylabelPosition.y);
        record(
          'D1b-axis-label-drag',
          axisDragModeOn && axisLabelsFollowed && xlabelPending && ylabelPending && axisConfirmed && axisRequests.length === 1
            && axisPatches.length === 2 && directionsCorrect && returnedMatches ? 'PASS' : 'FAIL',
          `dragMode=${axisDragModeOn}, livePreview=${axisLabelsFollowed}, xlabelPending=${xlabelPending}, ylabelPending=${ylabelPending}, confirmed=${axisConfirmed}, patches=${JSON.stringify(axisPatches)}, returnedMatches=${returnedMatches}`,
        );
      }

      await setSelectedGidsAndReload(page, []);
      const titleBox = await findBoxByText(page, 'Drag Extended Figure');
      if (!titleBox || !fixture.titlePosition) {
        record('D1c-title-drag', 'BLOCKED', `title=${Boolean(titleBox)}, props=${Boolean(fixture.titlePosition)}`);
      } else {
        await ensureDragMode(page, true);
        const titleGeometry = await dragBox(page, titleBox, 55, -35);
        diagnostics.titleDragGeometry = titleGeometry;
        const titlePending = (await getBodyText(page)).includes('已累计移动 1 个文本对象');
        const titleConfirmStart = apiRequests.length;
        const titleResponsePromise = page.waitForResponse(response => (
          response.url().includes('/api/figure/patch')
          && response.request().method() === 'POST'
        ), { timeout: 30000 });
        const titleConfirmed = titlePending && await clickVisibleText(page, '确认位置', 3000);
        const titleResponse = titleConfirmed ? await titleResponsePromise : null;
        const titleResponseBody = titleResponse ? await titleResponse.json().catch(() => null) : null;
        if (titleConfirmed) {
          await waitForApiSettle(page, titleConfirmStart, 30000);
          await waitForPreviewReady(page);
        }
        const titleRequests = apiRequests.slice(titleConfirmStart).filter(request => request.url.includes('/api/figure/patch'));
        const titleRequestBody = parseJson(titleRequests[0]?.postData);
        const titlePatches = Array.isArray(titleRequestBody?.patches)
          ? titleRequestBody.patches.filter(patch => patch?.gid === 'title.0' && patch?.prop === 'position')
          : [];
        const titlePatch = titlePatches[0];
        const returnedTitle = (titleResponseBody?.manifest?.objects || []).find(object => object?.id === 'title.0');
        const returnedMatches = Boolean(
          returnedTitle && titlePatch
          && Math.abs(Number(returnedTitle.currentProps?.x) - Number(titlePatch.value?.x)) < 0.01
          && Math.abs(Number(returnedTitle.currentProps?.y) - Number(titlePatch.value?.y)) < 0.01
          && returnedTitle.currentProps?.coord_system === 'axes'
        );
        const directionsCorrect = titlePatch
          && Number(titlePatch.value?.x) > Number(fixture.titlePosition.x)
          && Number(titlePatch.value?.y) > Number(fixture.titlePosition.y);
        record(
          'D1c-title-drag',
          didObjectFollowDrag(titleGeometry)
            && titlePending
            && titleConfirmed
            && titleRequests.length === 1
            && titlePatches.length === 1
            && directionsCorrect
            && returnedMatches ? 'PASS' : 'FAIL',
          `livePreview=${didObjectFollowDrag(titleGeometry)}, pending=${titlePending}, confirmed=${titleConfirmed}, patches=${JSON.stringify(titlePatches)}, returnedMatches=${returnedMatches}`,
        );
      }

      await clearSelectionInUi(page);
      await ensureDragMode(page, true);
      await dragBox(page, await findBoxByText(page, 'DRAG_A'), 45, 18);
      const cancelBody = await getBodyText(page);
      const cancelConfirm = cancelBody.includes('确认位置');
      const cancelStart = apiRequests.length;
      const canceled = cancelConfirm && await clickVisibleText(page, '取消', 3000);
      await page.waitForTimeout(1000);
      const cancelPatchRequests = apiRequests.slice(cancelStart).filter((r) => r.url.includes('/api/figure/patch'));
      const cancelBodyAfter = await getBodyText(page);
      record(
        'D2-cancel',
        cancelConfirm && canceled && cancelPatchRequests.length === 0 && !cancelBodyAfter.includes('确认位置') ? 'PASS' : 'FAIL',
        `confirmBeforeCancel=${cancelConfirm}, canceled=${canceled}, patchRequestsAfterCancel=${cancelPatchRequests.length}`,
      );
    }

    await setSelectedGidsAndReload(page, []);
    const freshLineBox = await findUnsupportedLineBox(page);
    if (!freshLineBox) {
      record('D3-unsupported', 'BLOCKED', 'missing line object for unsupported drag check');
    } else {
      await ensureDragMode(page, true);
      const unsupportedStart = apiRequests.length;
      await dragBox(page, freshLineBox, 60, 20);
      const body = await getBodyText(page);
      const unsupportedPatches = apiRequests.slice(unsupportedStart).filter((r) => r.url.includes('/api/figure/patch'));
      const unsupportedPending = body.includes('确认位置');
      record(
        'D3-unsupported',
        body.includes('当前对象不支持拖拽') && unsupportedPatches.length === 0 && !unsupportedPending ? 'PASS' : 'FAIL',
        `hint=${body.includes('当前对象不支持拖拽')}, patchRequests=${unsupportedPatches.length}, confirm=${unsupportedPending}`,
      );
      if (unsupportedPending) await clickVisibleText(page, '取消', 3000);
    }

    await setSelectedGidsAndReload(page, []);
    const annotationBox = await findBoxByText(page, 'DRAG_ANN');
    if (!annotationBox) {
      record('D3b-annotation-drag', 'BLOCKED', 'missing annotation text box');
    } else {
      await ensureDragMode(page, true);
      const annotationStart = apiRequests.length;
      await dragBox(page, annotationBox, 50, -16);
      const annotationPending = (await getBodyText(page)).includes('确认位置');
      const annotationConfirmed = annotationPending && await clickVisibleText(page, '确认位置', 3000);
      if (annotationConfirmed) await waitForApiSettle(page, annotationStart, 30000);
      const annotationRequests = apiRequests.slice(annotationStart).filter(request => request.url.includes('/api/figure/patch'));
      const annotationBody = annotationRequests[0]?.postData ? parseJson(annotationRequests[0].postData) : null;
      const annotationPatches = Array.isArray(annotationBody?.patches) ? annotationBody.patches : [];
      const positionPatches = annotationPatches.filter(patch => patch?.prop === 'position');
      const arrowPatches = annotationPatches.filter(patch => String(patch?.gid || '').startsWith('annotation_arrow.'));
      record(
        'D3b-annotation-drag',
        annotationConfirmed
          && annotationRequests.length === 1
          && positionPatches.length === 1
          && positionPatches[0]?.gid === fixture.annotationId
          && arrowPatches.length === 0 ? 'PASS' : 'FAIL',
        `confirmed=${annotationConfirmed}, requests=${annotationRequests.length}, position=${JSON.stringify(positionPatches)}, arrowPatches=${arrowPatches.length}`,
      );
    }

    await injectRNativeCoordinateFixture(page);
    // The reload path now relies on the exact SVG gid; the literal text can be
    // sanitized or wrapped differently, so verify the native object by id.
    const rBox = await findBoxByGid(page, 'r.text.0') || await findBoxByText(page, 'R_NATIVE_TEXT');
    if (!rBox) {
      record('D4-r-native-protection', 'BLOCKED', 'missing R native coordinate text fixture');
    } else {
      await ensureDragMode(page, true);
      const rStart = apiRequests.length;
      await dragBox(page, rBox, 70, 20);
      const body = await getBodyText(page);
      const rPatchRequests = apiRequests.slice(rStart).filter((r) => r.url.includes('/api/figure/patch'));
      record(
        'D4-r-native-protection',
        body.includes('当前对象不支持拖拽') && rPatchRequests.length === 0 && !body.includes('确认位置') ? 'PASS' : 'FAIL',
        `hint=${body.includes('当前对象不支持拖拽')}, patchRequests=${rPatchRequests.length}, confirm=${body.includes('确认位置')}`,
      );
    }

    record(
      'N1',
      consoleErrors.length === 0 && pageErrors.length === 0 ? 'PASS' : 'FAIL',
      `consoleErrors=${consoleErrors.length}, pageErrors=${pageErrors.length}`,
    );

    await page.screenshot({ path: path.join(OUTPUT_DIR, 'final.png'), fullPage: true });
  } finally {
    diagnostics.apiRequests = apiRequests;
    diagnostics.consoleErrors = consoleErrors;
    diagnostics.pageErrors = pageErrors;
    await browser.close();
    if (fixtureProjectId) {
      await requestJson(`/api/projects/${fixtureProjectId}`, { method: 'DELETE' }).catch(() => null);
    }
    await cleanupSmokeProjects().catch(() => null);
  }

  const pass = results.filter((r) => r.status === 'PASS').length;
  const fail = results.filter((r) => r.status === 'FAIL').length;
  const blocked = results.filter((r) => r.status === 'BLOCKED').length;
  const conclusion = fail === 0 && blocked === 0 ? 'PASS' : fail > 0 ? 'FAIL' : 'BLOCKED';
  const report = [
    '# Drag Extended Smoke Report',
    '',
    `Run: ${RUN_ID}`,
    `Conclusion: ${conclusion}, PASS=${pass}, FAIL=${fail}, BLOCKED=${blocked}`,
    '',
    '| ID | Status | Note |',
    '|---|---|---|',
    ...results.map((r) => `| ${r.id} | ${r.status} | ${String(r.note).replace(/\|/g, '\\|')} |`),
    '',
    '## Diagnostics',
    '',
    '```json',
    JSON.stringify(diagnostics, null, 2),
    '```',
  ].join('\n');
  fs.writeFileSync(path.join(OUTPUT_DIR, 'report.md'), report, 'utf8');
  console.log(`\nReport: ${path.join(OUTPUT_DIR, 'report.md')}`);
  if (conclusion !== 'PASS') process.exitCode = 1;
}

run().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
