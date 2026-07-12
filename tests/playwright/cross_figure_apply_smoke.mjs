/**
 * SciFigure Studio cross-figure apply smoke test.
 *
 * Verifies:
 * - "应用全部图" is enabled after a draft edit.
 * - Applying all sends per-figure /api/figure/patch requests.
 * - Applying all does not call project-wide /figures/render.
 * - Applying all skips code_patch payloads for cross-figure semantic application.
 * - Applying a single-panel style edit to a multi-panel target fans out to all target subplots.
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
const OUTPUT_DIR = path.join(ROOT, 'output', 'playwright', `cross-figure-apply-${RUN_ID}`);

const results = [];
const apiRequests = [];
const apiResponses = [];
const consoleErrors = [];
const pageErrors = [];
const diagnostics = {};
let failNextPatchFigureId = null;
let injectedPatchFailures = 0;
let authToken = '';

function record(id, status, note) {
  results.push({ id, status, note });
  console.log(`${status} ${id}: ${note}`);
}

function isIgnorableDevServerNoise(message) {
  return message.includes('[vite] failed to connect to websocket')
    || message.includes("WebSocket connection to 'ws://localhost:24678/")
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
    .filter((project) => String(project?.name || '').startsWith('Cross figure apply smoke'))
    .map((project) => {
      const id = project.id || project.projectId;
      return id ? requestJson(`/api/projects/${id}`, { method: 'DELETE' }).catch(() => null) : null;
    }));
}

const script = [
  'import matplotlib.pyplot as plt',
  'fig1, ax1 = plt.subplots(figsize=(4, 3))',
  'ax1.plot([0, 1, 2], [1, 3, 2], linewidth=1.2, label="A")',
  'ax1.set_title("Figure One")',
  'ax1.set_xlabel("Shared X")',
  'ax1.set_ylabel("Y One")',
  'ax1.legend(loc="upper left")',
  'fig2, ax2 = plt.subplots(figsize=(4, 3))',
  'ax2.plot([0, 1, 2], [2, 1, 4], linewidth=1.2, label="B")',
  'ax2.set_title("Figure Two")',
  'ax2.set_xlabel("Shared X")',
  'ax2.set_ylabel("Y Two")',
  'ax2.legend(loc="upper left")',
  'fig3, axs = plt.subplots(2, 2, figsize=(6, 5))',
  'for idx, ax in enumerate(axs.ravel()):',
  '    ax.plot([0, 1, 2], [idx + 1, idx + 2, idx + 1.5], linewidth=1.2, label=f"Panel {idx + 1}")',
  '    ax.set_title(f"Panel {idx + 1}")',
  '    ax.set_xlabel("Panel X")',
  '    ax.set_ylabel("Panel Y")',
  'for fig in [fig1, fig2, fig3]:',
  '    fig.tight_layout()',
].join('\n');

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
    await page.waitForTimeout(800);
  }
  return false;
}

async function prepareProject(page) {
  const fixture = await page.evaluate(async ({ baseUrl, script }) => {
    const spec = {
      plot_type: 'custom',
      custom_script: script,
      script,
      script_language: 'python',
      figure: { width: 120, height: 85, unit: 'mm', dpi: 300 },
    };
    const createRes = await fetch(`${baseUrl}/api/projects`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: `Cross figure apply smoke ${Date.now()}`, spec }),
    });
    const created = await createRes.json();
    if (created.status !== 'success') throw new Error(created.message || 'create project failed');

    const renderRes = await fetch(`${baseUrl}/api/projects/${created.id}/figures/render`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ script, editLogs: { fig_1: [], fig_2: [], fig_3: [] }, language: 'python', requestId: `cross-figure-${Date.now()}` }),
    });
    const rendered = await renderRes.json();
    if (rendered.status !== 'success') throw new Error(rendered.message || 'render failed');
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
      projectId: created.id,
      projectName: 'Cross figure apply smoke',
      projectFigures,
      activeFigureId: 'fig_1',
      datasets: [],
      selectedGids: [],
      projectHistory: {},
      currentView: 'workspace',
      subView: 'home',
      renderLog: ['> Cross figure fixture ready'],
      figSession: null,
    }));
    return {
      projectId: created.id,
      figureIds: rendered.figures.map((figure) => figure.figureId),
      figureCount: rendered.figures.length,
      axisIdsByFigure: Object.fromEntries(rendered.figures.map((figure) => [
        figure.figureId,
        (figure.manifest?.objects || []).filter((object) => object.kind === 'axis_x').map((object) => object.id),
      ])),
    };
  }, { baseUrl: BASE_URL, script });
  await page.reload({ waitUntil: 'networkidle', timeout: 30000 });
  await waitForPreviewReady(page);
  return fixture;
}

async function clickText(page, text) {
  const locators = [
    page.getByRole('button', { name: new RegExp(text) }).first(),
    page.getByText(text, { exact: false }).first(),
  ];
  for (const locator of locators) {
    if (await locator.isVisible({ timeout: 4000 }).catch(() => false)) {
      await locator.click();
      await page.waitForTimeout(500);
      return true;
    }
  }
  return false;
}

async function setNumberControl(page, sectionText, labelText, value) {
  const handle = await page.evaluateHandle(({ sectionText, labelText }) => {
    const normalize = (text) => String(text || '').replace(/\s+/g, '');
    const visible = (node) => {
      const rect = node.getBoundingClientRect();
      const style = window.getComputedStyle(node);
      return rect.width > 0 && rect.height > 0 && style.display !== 'none' && style.visibility !== 'hidden';
    };
    const rightSide = (node) => node.getBoundingClientRect().left > window.innerWidth * 0.70;
    const inputs = Array.from(document.querySelectorAll('input[data-param-role="number"]'))
      .filter((node) => visible(node) && rightSide(node));
    return inputs.find((node) => {
      const prop = node.getAttribute('data-param-prop') || '';
      let current = node.parentElement;
      let sectionMatched = false;
      while (current) {
        if (rightSide(current) && normalize(current.textContent).includes(normalize(sectionText))) {
          sectionMatched = true;
          break;
        }
        current = current.parentElement;
      }
      return sectionMatched && normalize(prop) === normalize(labelText);
    }) || null;
  }, { sectionText, labelText });
  const element = handle.asElement();
  if (!element) return false;
  await element.scrollIntoViewIfNeeded().catch(() => {});
  await element.fill(String(value));
  await element.press('Enter').catch(() => {});
  await element.evaluate((node) => node.blur());
  await page.waitForTimeout(700);
  return true;
}

async function setNumberControlInCardByText(page, cardText, prop, value) {
  const handle = await page.evaluateHandle(({ cardText, prop }) => {
    const normalize = (text) => String(text || '').replace(/\s+/g, '');
    const visible = (node) => {
      const rect = node.getBoundingClientRect();
      const style = window.getComputedStyle(node);
      return rect.width > 0 && rect.height > 0 && style.display !== 'none' && style.visibility !== 'hidden';
    };
    const rightSide = (node) => node.getBoundingClientRect().left > window.innerWidth * 0.70;
    const textNode = Array.from(document.querySelectorAll('span, div, p'))
      .filter((node) => visible(node) && rightSide(node) && normalize(node.textContent).includes(normalize(cardText)))
      .sort((a, b) => a.getBoundingClientRect().height - b.getBoundingClientRect().height)[0];
    if (!textNode) return null;
    let current = textNode.parentElement;
    while (current && rightSide(current)) {
      const controls = Array.from(current.querySelectorAll('input[data-param-role="number"]'))
        .filter((node) => visible(node) && !node.disabled && node.getAttribute('data-param-prop') === prop);
      if (controls.length > 0) return controls[0];
      current = current.parentElement;
    }
    return null;
  }, { cardText, prop });
  const element = handle.asElement();
  if (!element) return false;
  await element.scrollIntoViewIfNeeded().catch(() => {});
  await element.fill(String(value));
  await element.press('Enter').catch(() => {});
  await element.evaluate((node) => node.blur());
  await page.waitForTimeout(700);
  return true;
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

function patchList(body) {
  return Array.isArray(body?.patches) ? body.patches : [];
}

async function applyAllAndReadPatches(page) {
  const start = apiRequests.length;
  const clicked = await clickText(page, '应用全部图');
  if (!clicked) return { clicked: false, patchRequests: [], patchBodies: [], successful: false };
  await waitForApiSettle(start, 90000);
  await waitForPreviewReady(page);
  const patchRequests = apiRequests.slice(start).filter((request) => request.url.includes('/api/figure/patch'));
  const patchBodies = patchRequests.map((request) => parseJson(request.postData));
  const successful = patchRequests.length > 0 &&
    apiResponses.slice(start)
      .filter((response) => response.url.includes('/api/figure/patch'))
      .every((response) => response.status >= 200 && response.status < 300);
  return { clicked, patchRequests, patchBodies, successful, start };
}

async function applySelectedAndReadPatches(page) {
  const start = apiRequests.length;
  const clicked = await clickText(page, '应用选中图');
  if (!clicked) return { clicked: false, patchRequests: [], patchBodies: [], successful: false, start };
  await waitForApiSettle(start, 90000);
  await waitForPreviewReady(page);
  const patchRequests = apiRequests.slice(start).filter((request) => request.url.includes('/api/figure/patch'));
  const patchBodies = patchRequests.map((request) => parseJson(request.postData));
  const successful = patchRequests.length > 0 &&
    apiResponses.slice(start)
      .filter((response) => response.url.includes('/api/figure/patch'))
      .every((response) => response.status >= 200 && response.status < 300);
  return { clicked, patchRequests, patchBodies, successful, start };
}

async function seedContentTextDraft(page, figId, gid, nextText) {
  const seeded = await page.evaluate(({ figId, gid, nextText }) => {
    const key = 'scifigure:app-state:v2';
    const raw = window.sessionStorage.getItem(key);
    if (!raw) return false;
    const state = JSON.parse(raw);
    state.activeFigureId = figId;
    state.projectDrafts = {
      ...(state.projectDrafts || {}),
      [figId]: {
        [`${gid}:text`]: {
          gid,
          prop: 'text',
          value: nextText,
          mode: 'backend_patch',
          intent: {
            intent: 'content.text',
            scope: {
              selectionMode: 'explicit_objects',
              objectIds: [gid],
              targetKinds: ['text'],
              targetRole: 'title',
            },
            operation: { prop: 'text', value: nextText },
            commit: { mode: 'draft', applyAsOneHistoryStep: true },
            fallback: { onUnsupported: 'skip_with_warning' },
          },
        },
      },
    };
    window.sessionStorage.setItem(key, JSON.stringify(state));
    window.location.reload();
    return true;
  }, { figId, gid, nextText });
  if (!seeded) return false;
  await page.waitForLoadState('networkidle', { timeout: 30000 }).catch(() => {});
  await waitForPreviewReady(page);
  await page.waitForTimeout(500);
  return true;
}

async function selectBatchTargetFigure(page, figureNumber, checked = true) {
  const checkbox = page.getByLabel(`选择 Figure ${figureNumber} 作为批量应用目标`).first();
  if (!(await checkbox.isVisible({ timeout: 5000 }).catch(() => false))) return false;
  const current = await checkbox.isChecked().catch(() => false);
  if (current !== checked) {
    await checkbox.click();
    await page.waitForTimeout(300);
  }
  return true;
}

async function selectActiveFigure(page, figureNumber) {
  const button = page.getByRole('button', { name: new RegExp(`^Figure\\s*${figureNumber}$`) }).first();
  if (!(await button.isVisible({ timeout: 5000 }).catch(() => false))) return false;
  await button.click();
  await page.waitForTimeout(800);
  await waitForPreviewReady(page);
  return true;
}

async function run() {
  fs.mkdirSync(OUTPUT_DIR, { recursive: true });
  authToken = await authenticateCapabilitySmokeUser(BASE_URL, 'cross-figure apply');
  await cleanupSmokeProjects();

  const browser = await chromium.launch({ headless: true, args: ['--no-sandbox'] });
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  await installBrowserAuthentication(context, authToken);
  const page = await context.newPage();

  await page.route('**/api/figure/patch', async (route) => {
    const body = parseJson(route.request().postData());
    if (failNextPatchFigureId && body?.figureId === failNextPatchFigureId) {
      failNextPatchFigureId = null;
      injectedPatchFailures += 1;
      await route.fulfill({
        status: 500,
        contentType: 'application/json',
        body: JSON.stringify({ status: 'error', message: 'Injected draft transaction failure' }),
      });
      return;
    }
    await route.continue();
  });

  page.on('console', (msg) => {
    if (msg.type() !== 'error' || isIgnorableDevServerNoise(msg.text())) return;
    if (injectedPatchFailures > 0 && msg.text().includes('500 (Internal Server Error)')) {
      injectedPatchFailures -= 1;
      return;
    }
    consoleErrors.push(msg.text());
  });
  page.on('pageerror', (err) => {
    if (!isIgnorableDevServerNoise(err.message)) pageErrors.push(err.message);
  });
  page.on('request', (request) => {
    if (interestingApi(request)) {
      apiRequests.push({ method: request.method(), url: request.url(), postData: request.postData() });
    }
  });
  page.on('response', (response) => {
    if (interestingApi(response.request())) {
      apiResponses.push({ method: response.request().method(), url: response.url(), status: response.status(), postData: response.request().postData() });
    }
  });

  let projectId = null;
  try {
    await page.goto(BASE_URL, { waitUntil: 'networkidle', timeout: 30000 });
    const fixture = await prepareProject(page);
    projectId = fixture.projectId;
    diagnostics.fixture = fixture;

    record('X0-fixture', fixture.figureCount === 3 ? 'PASS' : 'FAIL', JSON.stringify(fixture));

    await clickText(page, '字体中心');
    const changed = await setNumberControl(page, 'X 轴刻度文字', 'fontsize', 15);
    const draftVisible = (await getBodyText(page)).includes('已暂存');
    const allButtonEnabled = await page.evaluate(() => {
      const buttons = Array.from(document.querySelectorAll('button'));
      const button = buttons.find((node) => String(node.textContent || '').includes('应用全部图'));
      return Boolean(button && !button.disabled);
    });
    const applyAll = changed ? await applyAllAndReadPatches(page) : { clicked: false, patchBodies: [], successful: false, start: apiRequests.length };
    const figureIds = applyAll.patchBodies.map((body) => body?.figureId).sort();
    const patches = applyAll.patchBodies.flatMap((body) => patchList(body));
    const fullRenderCalls = apiRequests.slice(applyAll.start || 0).filter((request) => request.url.includes('/figures/render'));
    const noCodePatch = patches.every((patch) => patch.type !== 'code_patch' && patch.gid !== 'code_patch');
    const allPatchesAreTickSize = patches.length >= 2 && patches.every((patch) => patch.prop === 'tick_labelsize' && Number(patch.value) === 15);
    const applyAllOk = changed &&
      draftVisible &&
      allButtonEnabled &&
      applyAll.clicked &&
      applyAll.successful &&
      figureIds.includes('fig_1') &&
      figureIds.includes('fig_2') &&
      figureIds.includes('fig_3') &&
      fullRenderCalls.length === 0 &&
      noCodePatch &&
      allPatchesAreTickSize;
    record('X1-apply-all', applyAllOk ? 'PASS' : 'FAIL', `changed=${changed}, draft=${draftVisible}, enabled=${allButtonEnabled}, figureIds=${JSON.stringify(figureIds)}, patches=${JSON.stringify(patches)}, fullRenderCalls=${fullRenderCalls.length}`);

    const reportBodyAfterApplyAll = await getBodyText(page);
    const intentReportVisible = reportBodyAfterApplyAll.includes('最近语义应用结果')
      && reportBodyAfterApplyAll.includes('全部图')
      && reportBodyAfterApplyAll.includes(`修改 ${patches.length} 项`);
    record('X1-report-visible', intentReportVisible ? 'PASS' : 'FAIL', `visible=${intentReportVisible}, expectedApplied=${patches.length}`);

    const contentEdited = await seedContentTextDraft(page, 'fig_1', 'title.0', 'Figure One Edited');
    const contentDraftVisible = (await getBodyText(page)).includes('已暂存');
    const applyContentAll = contentEdited ? await applyAllAndReadPatches(page) : { clicked: false, patchBodies: [], successful: false, start: apiRequests.length };
    const contentFigureIds = applyContentAll.patchBodies.map((body) => body?.figureId).sort();
    const contentPatches = applyContentAll.patchBodies.flatMap((body) => patchList(body));
    const contentReportBody = await getBodyText(page);
    const contentSkippedVisible = contentReportBody.includes('最近语义应用结果')
      && contentReportBody.includes('部分跳过')
      && contentReportBody.includes('跳过 2');
    const contentOnlyCurrentFigure = contentFigureIds.length === 1 && contentFigureIds[0] === 'fig_1';
    const contentPatchOk = contentPatches.length === 1
      && contentPatches[0]?.prop === 'text'
      && contentPatches[0]?.value === 'Figure One Edited';
    record(
      'X1-content-deny-cross-figure',
      contentEdited && contentDraftVisible && applyContentAll.clicked && applyContentAll.successful && contentOnlyCurrentFigure && contentPatchOk && contentSkippedVisible ? 'PASS' : 'FAIL',
      `edited=${contentEdited}, draft=${contentDraftVisible}, figureIds=${JSON.stringify(contentFigureIds)}, patches=${JSON.stringify(contentPatches)}, reportSkipped=${contentSkippedVisible}`,
    );

    await clickText(page, '字体中心');
    const changedSelected = await setNumberControl(page, 'X 轴刻度文字', 'fontsize', 16);
    const selectedDraftVisible = (await getBodyText(page)).includes('已暂存');
    const uncheckedFig1 = await selectBatchTargetFigure(page, 1, false);
    const checkedFig2 = await selectBatchTargetFigure(page, 2, true);
    const selectedButtonEnabled = await page.evaluate(() => {
      const buttons = Array.from(document.querySelectorAll('button'));
      const button = buttons.find((node) => String(node.textContent || '').includes('应用选中图'));
      return Boolean(button && !button.disabled);
    });
    const applySelected = changedSelected ? await applySelectedAndReadPatches(page) : { clicked: false, patchBodies: [], successful: false, start: apiRequests.length };
    const selectedFigureIds = applySelected.patchBodies.map((body) => body?.figureId).sort();
    const selectedPatches = applySelected.patchBodies.flatMap((body) => patchList(body));
    const selectedFullRenderCalls = apiRequests.slice(applySelected.start || 0).filter((request) => request.url.includes('/figures/render'));
    const selectedNoCodePatch = selectedPatches.every((patch) => patch.type !== 'code_patch' && patch.gid !== 'code_patch');
    const selectedPatchesAreTickSize = selectedPatches.length === 1 && selectedPatches.every((patch) => patch.prop === 'tick_labelsize' && Number(patch.value) === 16);
    const selectedOk = changedSelected &&
      selectedDraftVisible &&
      uncheckedFig1 &&
      checkedFig2 &&
      selectedButtonEnabled &&
      applySelected.clicked &&
      applySelected.successful &&
      selectedFigureIds.length === 1 &&
      selectedFigureIds[0] === 'fig_2' &&
      selectedFullRenderCalls.length === 0 &&
      selectedNoCodePatch &&
      selectedPatchesAreTickSize;
    record('X2-apply-selected', selectedOk ? 'PASS' : 'FAIL', `changed=${changedSelected}, draft=${selectedDraftVisible}, fig1Unchecked=${uncheckedFig1}, fig2Checked=${checkedFig2}, enabled=${selectedButtonEnabled}, figureIds=${JSON.stringify(selectedFigureIds)}, patches=${JSON.stringify(selectedPatches)}, fullRenderCalls=${selectedFullRenderCalls.length}`);

    const selectedFig2AsActive = await selectActiveFigure(page, 2);
    await clickText(page, '组件中心');
    const changedFrame = await setNumberControlInCardByText(page, '子图边框 / 坐标轴框线', 'linewidth', 2.25);
    const frameDraftVisible = (await getBodyText(page)).includes('已暂存');
    const applyFrameAll = changedFrame ? await applyAllAndReadPatches(page) : { clicked: false, patchBodies: [], successful: false, start: apiRequests.length };
    const fig3Body = applyFrameAll.patchBodies.find((body) => body?.figureId === 'fig_3');
    const fig3Patches = patchList(fig3Body);
    const fig3FramePatches = fig3Patches.filter((patch) => (
      String(patch.gid || '').startsWith('spine_group.') &&
      patch.prop === 'linewidth' &&
      Number(patch.value) === 2.25
    ));
    const uniqueFig3FrameGids = [...new Set(fig3FramePatches.map((patch) => patch.gid))].sort();
    const unexpectedGridPatches = fig3Patches.filter((patch) => String(patch.gid || '').startsWith('grid.'));
    const frameFullRenderCalls = apiRequests.slice(applyFrameAll.start || 0).filter((request) => request.url.includes('/figures/render'));
    const frameFanoutOk = selectedFig2AsActive &&
      changedFrame &&
      frameDraftVisible &&
      applyFrameAll.clicked &&
      applyFrameAll.successful &&
      uniqueFig3FrameGids.join(',') === 'spine_group.0,spine_group.1,spine_group.2,spine_group.3' &&
      unexpectedGridPatches.length === 0 &&
      frameFullRenderCalls.length === 0;
    record('X3-single-to-multisubplot-style-fanout', frameFanoutOk ? 'PASS' : 'FAIL', `activeFig2=${selectedFig2AsActive}, changed=${changedFrame}, draft=${frameDraftVisible}, fig3FrameGids=${JSON.stringify(uniqueFig3FrameGids)}, unexpectedGridPatches=${unexpectedGridPatches.length}, fig3Patches=${JSON.stringify(fig3Patches)}, fullRenderCalls=${frameFullRenderCalls.length}`);

    await clickText(page, '组件中心');
    const changedDataLine = await setNumberControlInCardByText(page, '线条 / 拟合线', 'linewidth', 2.75);
    const dataLineDraftVisible = (await getBodyText(page)).includes('已暂存');
    const applyDataLineAll = changedDataLine
      ? await applyAllAndReadPatches(page)
      : { clicked: false, patchBodies: [], successful: false, start: apiRequests.length };
    const dataLinePatches = applyDataLineAll.patchBodies.flatMap((body) => patchList(body));
    const actualDataLinePatches = dataLinePatches.filter((patch) => (
      /^line\.\d+\.\d+$/.test(String(patch.gid || ''))
      && patch.prop === 'linewidth'
      && Number(patch.value) === 2.75
    ));
    const legendLinePatches = dataLinePatches.filter((patch) => String(patch.gid || '').startsWith('legend_line.'));
    const dataLineFigureIds = applyDataLineAll.patchBodies.map((body) => body?.figureId).filter(Boolean).sort();
    const dataLineFullRenderCalls = apiRequests.slice(applyDataLineAll.start || 0).filter((request) => request.url.includes('/figures/render'));
    const dataLineIsolationOk = changedDataLine
      && dataLineDraftVisible
      && applyDataLineAll.clicked
      && applyDataLineAll.successful
      && dataLineFigureIds.join(',') === 'fig_1,fig_2,fig_3'
      && actualDataLinePatches.length === 6
      && legendLinePatches.length === 0
      && dataLinePatches.length === actualDataLinePatches.length
      && dataLineFullRenderCalls.length === 0;
    record(
      'X3b-data-line-excludes-legend-marker',
      dataLineIsolationOk ? 'PASS' : 'FAIL',
      `changed=${changedDataLine}, draft=${dataLineDraftVisible}, figureIds=${JSON.stringify(dataLineFigureIds)}, dataLines=${actualDataLinePatches.length}, legendLines=${legendLinePatches.length}, patches=${JSON.stringify(dataLinePatches)}, fullRenderCalls=${dataLineFullRenderCalls.length}`,
    );

    const activeFig1ForRetry = await selectActiveFigure(page, 1);
    await clickText(page, '字体中心');
    const retryDraftChanged = await setNumberControl(page, 'X 轴刻度文字', 'fontsize', 17);
    const retryDraftInitiallyVisible = (await getBodyText(page)).includes('已暂存');
    failNextPatchFigureId = 'fig_2';
    const partialApply = retryDraftChanged
      ? await applyAllAndReadPatches(page)
      : { clicked: false, patchBodies: [], successful: false, start: apiRequests.length };
    const partialFigureIds = partialApply.patchBodies.map((body) => body?.figureId).filter(Boolean).sort();
    const bodyAfterPartial = await getBodyText(page);
    const draftRetainedAfterPartial = bodyAfterPartial.includes('已暂存');
    const partialFailureVisible = bodyAfterPartial.includes('上次应用部分失败') && bodyAfterPartial.includes('fig_2');
    const retryApply = draftRetainedAfterPartial
      ? await applyAllAndReadPatches(page)
      : { clicked: false, patchBodies: [], successful: false, start: apiRequests.length };
    const retryFigureIds = retryApply.patchBodies.map((body) => body?.figureId).filter(Boolean).sort();
    const draftClearedAfterRetry = !(await getBodyText(page)).includes('已暂存');
    const transactionRetryOk = activeFig1ForRetry
      && retryDraftChanged
      && retryDraftInitiallyVisible
      && partialApply.clicked
      && !partialApply.successful
      && partialFigureIds.join(',') === 'fig_1,fig_2,fig_3'
      && draftRetainedAfterPartial
      && partialFailureVisible
      && retryApply.clicked
      && retryApply.successful
      && retryFigureIds.join(',') === 'fig_2'
      && draftClearedAfterRetry;
    record(
      'X4-partial-failure-retries-only-failed-figure',
      transactionRetryOk ? 'PASS' : 'FAIL',
      `initialDraft=${retryDraftInitiallyVisible}, partialFigures=${JSON.stringify(partialFigureIds)}, retained=${draftRetainedAfterPartial}, failureVisible=${partialFailureVisible}, retryFigures=${JSON.stringify(retryFigureIds)}, retrySuccess=${retryApply.successful}, cleared=${draftClearedAfterRetry}`,
    );

    if (consoleErrors.length > 0 || pageErrors.length > 0) {
      record('N1', 'FAIL', `console=${consoleErrors.length}, page=${pageErrors.length}`);
    } else {
      record('N1', 'PASS', '无 console error / pageerror');
    }
  } finally {
    await browser.close();
    if (projectId) {
      await requestJson(`/api/projects/${projectId}`, { method: 'DELETE' }).catch(() => null);
    }
  }
}

function generateReport() {
  const passCount = results.filter((result) => result.status === 'PASS').length;
  const failCount = results.filter((result) => result.status === 'FAIL').length;
  const blockedCount = results.filter((result) => result.status === 'BLOCKED').length;
  const conclusion = failCount > 0 ? 'FAIL' : blockedCount > 0 ? 'PARTIAL' : 'PASS';
  const lines = [
    '# SciFigure Studio Cross-Figure Apply Smoke Report',
    '',
    `- Time: ${new Date().toISOString()}`,
    `- URL: ${BASE_URL}`,
    `- Conclusion: ${conclusion}`,
    `- PASS: ${passCount}`,
    `- FAIL: ${failCount}`,
    `- BLOCKED: ${blockedCount}`,
    '',
    '## Matrix',
    '',
    '| ID | Status | Evidence |',
    '|---|---|---|',
    ...results.map((result) => `| ${result.id} | ${result.status} | ${String(result.note).replace(/\|/g, '\\|')} |`),
    '',
    '## Diagnostics',
    '',
    '```json',
    JSON.stringify({ diagnostics, consoleErrors, pageErrors }, null, 2),
    '```',
  ];
  const file = path.join(OUTPUT_DIR, 'report.md');
  fs.writeFileSync(file, lines.join('\n'), 'utf-8');
  return { file, conclusion, passCount, failCount, blockedCount };
}

try {
  await run();
} catch (error) {
  record('HARNESS', 'FAIL', error?.message || String(error));
}

const report = generateReport();
console.log(`\nReport: ${report.file}`);
console.log(`Conclusion: ${report.conclusion}, PASS=${report.passCount}, FAIL=${report.failCount}, BLOCKED=${report.blockedCount}`);
