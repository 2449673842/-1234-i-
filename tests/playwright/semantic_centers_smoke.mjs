/**
 * SciFigure Studio semantic centers behavior smoke test.
 *
 * Verifies behavior, not only UI presence:
 * - Font Center group edit enters draft and applies one backend patch batch.
 * - Component Center group edit enters draft and applies one backend patch batch.
 * - Palette Center whole-group edit enters draft and applies a color/code patch batch.
 *
 * Prerequisite:
 *   The app is running at http://localhost:3000.
 *
 * Run:
 *   node tests/playwright/semantic_centers_smoke.mjs
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
const OUTPUT_DIR = path.join(ROOT, 'output', 'playwright', `semantic-centers-${RUN_ID}`);

const results = [];
const apiRequests = [];
const apiResponses = [];
const consoleErrors = [];
const pageErrors = [];
const diagnostics = {};
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
    .filter((project) => String(project?.name || '').startsWith('Semantic centers smoke'))
    .map((project) => {
      const id = project.id || project.projectId;
      return id ? requestJson(`/api/projects/${id}`, { method: 'DELETE' }).catch(() => null) : null;
    }));
}

const script = [
  'import matplotlib.pyplot as plt',
  'LINE_COLOR = "#225577"',
  'POINT_COLOR = "#cc5500"',
  'SERIES_COLORS = {"Weak": "#446688", "Mixed": "#446688"}',
  'fig, ax = plt.subplots(figsize=(5, 3.5))',
  'ax.plot([0, 1, 2, 3], [1, 3, 2, 4], color=LINE_COLOR, linewidth=1.5, marker="o", label="Line A")',
  'ax.scatter([0, 1, 2, 3], [1.2, 2.8, 2.2, 3.7], c=POINT_COLOR, s=55, label="Points")',
  'ax.plot([0, 1, 2, 3], [2.0, 2.4, 2.1, 2.8], color=SERIES_COLORS["Weak"], label="Weak")',
  'ax.plot([0, 1, 2, 3], [2.8, 2.1, 2.6, 2.2], color=SERIES_COLORS["Mixed"], label="Mixed")',
  'ax.set_title("Semantic Centers")',
  'ax.set_xlabel("X Axis")',
  'ax.set_ylabel("Y Axis")',
  'ax.legend(loc="upper left")',
  'plt.tight_layout()',
].join('\n');

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
      body: JSON.stringify({ name: `Semantic centers smoke ${Date.now()}`, spec }),
    });
    const created = await createRes.json();
    if (created.status !== 'success') throw new Error(created.message || 'create project failed');

    const renderRes = await fetch(`${baseUrl}/api/projects/${created.id}/figures/render`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ script, editLogs: { fig_1: [] }, language: 'python', requestId: `semantic-${Date.now()}` }),
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
      projectName: 'Semantic centers smoke',
      projectFigures,
      activeFigureId: 'fig_1',
      datasets: [],
      selectedGids: [],
      projectHistory: {},
      currentView: 'workspace',
      subView: 'home',
      renderLog: ['> Semantic centers fixture ready'],
      figSession: null,
    }));
    return {
      projectId: created.id,
      objectCount: rendered.figures[0]?.manifest?.objects?.length || 0,
      paletteCount: rendered.figures[0]?.manifest?.palettes?.length || 0,
      bindingCount: rendered.figures[0]?.manifest?.bindings?.length || 0,
      weakBinding: rendered.figures[0]?.manifest?.bindings?.find((binding) => binding.paletteId === 'dict_SERIES_COLORS__Weak') || null,
      mixedBinding: rendered.figures[0]?.manifest?.bindings?.find((binding) => binding.paletteId === 'dict_SERIES_COLORS__Mixed') || null,
    };
  }, { baseUrl: BASE_URL, script });
  await page.reload({ waitUntil: 'networkidle', timeout: 30000 });
  await waitForPreviewReady(page);
  return fixture;
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
    await page.waitForTimeout(800);
  }
  return false;
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

async function waitForApiSettle(startIndex, timeoutMs = 40000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    await new Promise((resolve) => setTimeout(resolve, 350));
    const recent = apiResponses.slice(startIndex);
    const pendingCount = apiRequests.slice(startIndex).length - recent.length;
    if (pendingCount <= 0 && recent.length > 0) return recent;
  }
  return apiResponses.slice(startIndex);
}

async function findControlInRightSidebar(page, options) {
  return page.evaluateHandle(({ sectionText, labelText, selector }) => {
    const normalize = (value) => String(value || '').replace(/\s+/g, '');
    const visible = (node) => {
      const rect = node.getBoundingClientRect();
      const style = window.getComputedStyle(node);
      return rect.width > 0 && rect.height > 0 && style.display !== 'none' && style.visibility !== 'hidden';
    };
    const rightSide = (node) => node.getBoundingClientRect().left > window.innerWidth * 0.70;
    const containers = Array.from(document.querySelectorAll('div'))
      .filter((node) => visible(node) && rightSide(node) && normalize(node.textContent).includes(normalize(sectionText)))
      .sort((a, b) => a.getBoundingClientRect().height - b.getBoundingClientRect().height);
    for (const container of containers) {
      const controls = Array.from(container.querySelectorAll(selector)).filter((node) => visible(node) && !node.disabled);
      if (!labelText) return controls[0] || null;
      for (const control of controls) {
        let current = control.parentElement;
        while (current && current !== container.parentElement) {
          if (
            current.contains(control) &&
            normalize(current.textContent).includes(normalize(labelText)) &&
            visible(current)
          ) {
            return control;
          }
          if (current === container) break;
          current = current.parentElement;
        }
      }
      const labelNode = Array.from(container.querySelectorAll('span, div, label'))
        .filter((node) => visible(node) && normalize(node.textContent).includes(normalize(labelText)))
        .sort((a, b) => a.getBoundingClientRect().top - b.getBoundingClientRect().top)[0];
      if (!labelNode) continue;
      const labelRect = labelNode.getBoundingClientRect();
      const ranked = controls
        .map((control) => {
          const rect = control.getBoundingClientRect();
          return {
            control,
            score: Math.abs((rect.top + rect.height / 2) - (labelRect.top + labelRect.height / 2)) + (rect.top < labelRect.top - 12 ? 1000 : 0),
          };
        })
        .sort((a, b) => a.score - b.score);
      if (ranked[0]) return ranked[0].control;
    }
    return null;
  }, options);
}

async function setNumberControl(page, sectionText, labelText, value) {
  const handle = await findControlInRightSidebar(page, { sectionText, labelText, selector: 'input[type="number"]' });
  const element = handle.asElement();
  if (!element) return false;
  await element.scrollIntoViewIfNeeded().catch(() => {});
  await element.fill(String(value));
  await element.press('Enter').catch(() => {});
  await element.evaluate((node) => node.blur());
  await page.waitForTimeout(700);
  return true;
}

async function setNumberByParam(page, gid, prop, value) {
  const input = page.locator(`input[data-param-role="number"][data-param-gid="${gid}"][data-param-prop="${prop}"]`).first();
  if (!(await input.isVisible({ timeout: 4000 }).catch(() => false))) return false;
  await input.fill(String(value));
  await input.press('Enter').catch(() => {});
  await input.evaluate((node) => node.blur());
  await page.waitForTimeout(700);
  return true;
}

async function setColorControl(page, sectionText, labelText, value) {
  const directHandle = await page.evaluateHandle(({ sectionText, labelText }) => {
    const normalize = (text) => String(text || '').replace(/\s+/g, '');
    const visible = (node) => {
      const rect = node.getBoundingClientRect();
      const style = window.getComputedStyle(node);
      return rect.width > 0 && rect.height > 0 && style.display !== 'none' && style.visibility !== 'hidden';
    };
    const rightSide = (node) => node.getBoundingClientRect().left > window.innerWidth * 0.70;
    const inputs = Array.from(document.querySelectorAll('input[data-color-role="text"]'))
      .filter((node) => visible(node) && rightSide(node));
    return inputs.find((node) => {
      const label = node.getAttribute('data-color-label') || '';
      const scope = node.getAttribute('data-color-scope') || '';
      let current = node.parentElement;
      let sectionMatched = false;
      while (current) {
        if (rightSide(current) && normalize(current.textContent).includes(normalize(sectionText))) {
          sectionMatched = true;
          break;
        }
        current = current.parentElement;
      }
      return sectionMatched &&
        (normalize(label).includes(normalize(labelText)) || normalize(scope).includes(normalize(labelText)));
    }) || null;
  }, { sectionText, labelText });
  const directElement = directHandle.asElement();
  if (directElement) {
    await directElement.scrollIntoViewIfNeeded().catch(() => {});
    await directElement.fill(value);
    await directElement.press('Enter').catch(() => {});
    await directElement.evaluate((node) => node.blur());
    await page.waitForTimeout(700);
    return true;
  }
  const handle = await findControlInRightSidebar(page, { sectionText, labelText, selector: 'input[type="text"]' });
  const element = handle.asElement();
  if (!element) return false;
  await element.scrollIntoViewIfNeeded().catch(() => {});
  await element.fill(value);
  await element.press('Enter').catch(() => {});
  await element.evaluate((node) => node.blur());
  await page.waitForTimeout(700);
  return true;
}

async function setColorByScope(page, scope, value) {
  const textInput = page.locator(`input[data-color-role="text"][data-color-scope="${scope}"]`).first();
  if (!(await textInput.isVisible({ timeout: 3000 }).catch(() => false))) return false;
  await textInput.fill(value);
  await textInput.press('Enter').catch(() => {});
  await textInput.evaluate((node) => node.blur());
  await page.waitForTimeout(700);
  return true;
}

async function readRuntimePaletteColors(page, paletteIds) {
  return page.evaluate((ids) => {
    const raw = window.sessionStorage.getItem('scifigure:app-state:v2');
    if (!raw) return {};
    const state = JSON.parse(raw);
    const figure = state.projectFigures?.[state.activeFigureId || 'fig_1'];
    const palettes = figure?.manifest?.palettes || [];
    return Object.fromEntries(ids.map((id) => [
      id,
      palettes.find((palette) => palette.id === id)?.color || null,
    ]));
  }, paletteIds);
}

async function clickFirstPaletteAffectedObject(page, sectionText) {
  const clicked = await page.evaluate((section) => {
    const normalize = (value) => String(value || '').replace(/\s+/g, '');
    const visible = (node) => {
      const rect = node.getBoundingClientRect();
      const style = window.getComputedStyle(node);
      return rect.width > 0 && rect.height > 0 && style.display !== 'none' && style.visibility !== 'hidden';
    };
    const rightSide = (node) => node.getBoundingClientRect().left > window.innerWidth * 0.70;
    const containers = Array.from(document.querySelectorAll('div'))
      .filter((node) => visible(node) && rightSide(node) && normalize(node.textContent).includes(normalize(section)))
      .sort((a, b) => a.getBoundingClientRect().height - b.getBoundingClientRect().height);
    for (const container of containers) {
      const objectButtons = Array.from(container.querySelectorAll('button'))
        .filter((button) => {
          const text = normalize(button.textContent);
          return visible(button) &&
            !button.disabled &&
            !text.includes('选中整组') &&
            !text.includes('修改') &&
            !text.includes('仅修改') &&
            (text.includes('line') || text.includes('Line') || text.includes('图例') || text.includes('线条'));
        });
      const target = objectButtons[0];
      if (target) {
        target.click();
        return { clicked: true, text: target.textContent || '' };
      }
    }
    return { clicked: false, text: '' };
  }, sectionText);
  await page.waitForTimeout(700);
  return clicked;
}

async function applyDraftAndReadPatch(page) {
  const start = apiRequests.length;
  const clicked = await clickText(page, '应用当前图');
  if (!clicked) return { clicked: false, patchRequest: null, patchBody: null, successful: false };
  await waitForApiSettle(start, 60000);
  await waitForPreviewReady(page);
  const patchRequest = apiRequests.slice(start).find((request) => request.url.includes('/api/figure/patch')) || null;
  const patchBody = parseJson(patchRequest?.postData);
  const successful = apiResponses.slice(start).some((response) => response.url.includes('/api/figure/patch') && response.status >= 200 && response.status < 300);
  return { clicked, patchRequest, patchBody, successful };
}

async function saveProjectAndReadPut(page) {
  const start = apiRequests.length;
  const saveButton = page.getByRole('button', { name: /^保存$/ }).first();
  if (!(await saveButton.isVisible({ timeout: 5000 }).catch(() => false))) {
    return { clicked: false, putRequest: null, putBody: null, successful: false };
  }
  await saveButton.click();
  await waitForApiSettle(start, 40000);
  const putRequest = apiRequests.slice(start).find((request) => (
    request.method === 'PUT' && /\/api\/projects\/[^/]+$/.test(new URL(request.url).pathname)
  )) || null;
  const putBody = parseJson(putRequest?.postData);
  const successful = apiResponses.slice(start).some((response) => (
    response.method === 'PUT' &&
    /\/api\/projects\/[^/]+$/.test(new URL(response.url).pathname) &&
    response.status >= 200 &&
    response.status < 300
  ));
  return { clicked: true, putRequest, putBody, successful };
}

function patchList(body) {
  return Array.isArray(body?.patches) ? body.patches : [];
}

async function run() {
  fs.mkdirSync(OUTPUT_DIR, { recursive: true });
  authToken = await authenticateCapabilitySmokeUser(BASE_URL, 'semantic centers');
  await cleanupSmokeProjects();

  const browser = await chromium.launch({ headless: true, args: ['--no-sandbox'] });
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  await installBrowserAuthentication(context, authToken);
  const page = await context.newPage();

  page.on('console', (msg) => {
    if (msg.type() === 'error' && !isIgnorableDevServerNoise(msg.text())) consoleErrors.push(msg.text());
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

    const weakGids = fixture.weakBinding?.gids || [];
    const mixedGids = fixture.mixedBinding?.gids || [];
    const sameColorBindingsOk = fixture.weakBinding?.targetMode === 'exact'
      && fixture.mixedBinding?.targetMode === 'exact'
      && weakGids.length > 0
      && mixedGids.length > 0
      && weakGids.every((gid) => !mixedGids.includes(gid));
    record(
      'H0-same-color-binding-isolation',
      sameColorBindingsOk ? 'PASS' : 'FAIL',
      `weak=${JSON.stringify(fixture.weakBinding)}, mixed=${JSON.stringify(fixture.mixedBinding)}`,
    );

    await clickText(page, '字体中心');
    const fontChanged = await setNumberControl(page, 'X 轴刻度文字', '字号', 13);
    const fontDraft = (await getBodyText(page)).includes('已暂存');
    const fontApply = fontChanged ? await applyDraftAndReadPatch(page) : { patchBody: null, successful: false };
    const fontPatches = patchList(fontApply.patchBody);
    const fontOk = fontChanged && fontDraft && fontApply.successful && fontPatches.some((patch) => patch.gid === 'axis.x.0' && patch.prop === 'tick_labelsize' && Number(patch.value) === 13);
    record('F1', fontOk ? 'PASS' : 'FAIL', `changed=${fontChanged}, draft=${fontDraft}, patches=${JSON.stringify(fontPatches)}`);

    await clickText(page, '组件中心');
    const componentChanged = await setNumberControl(page, '线条', '线宽', 2.5);
    const componentDraft = (await getBodyText(page)).includes('已暂存');
    const componentApply = componentChanged ? await applyDraftAndReadPatch(page) : { patchBody: null, successful: false };
    const componentPatches = patchList(componentApply.patchBody);
    const componentOk = componentChanged && componentDraft && componentApply.successful && componentPatches.some((patch) => patch.prop === 'linewidth' && Number(patch.value) === 2.5);
    record('G1', componentOk ? 'PASS' : 'FAIL', `changed=${componentChanged}, draft=${componentDraft}, patches=${JSON.stringify(componentPatches)}`);

    await clickText(page, '组件中心');
    const pointSizeChanged = await setNumberByParam(page, 'component-points', 'size', 90);
    const pointDraft = (await getBodyText(page)).includes('已暂存');
    const pointApply = pointSizeChanged ? await applyDraftAndReadPatch(page) : { patchBody: null, successful: false };
    const pointPatches = patchList(pointApply.patchBody);
    const pointOk = pointSizeChanged
      && pointDraft
      && pointApply.successful
      && pointPatches.length === 1
      && /^collection\.\d+\.\d+$/.test(String(pointPatches[0]?.gid || ''))
      && pointPatches[0]?.prop === 'size'
      && Number(pointPatches[0]?.value) === 90;
    record('G2-scatter-excludes-legend', pointOk ? 'PASS' : 'FAIL', `changed=${pointSizeChanged}, draft=${pointDraft}, patches=${JSON.stringify(pointPatches)}`);

    await clickText(page, '配色中心');
    const selectedPaletteObject = await clickFirstPaletteAffectedObject(page, 'LINE_COLOR');
    const subsetChanged = await setColorControl(page, 'LINE_COLOR', '仅修改已选', '#4455aa');
    const subsetDraft = (await getBodyText(page)).includes('已暂存');
    const subsetApply = subsetChanged ? await applyDraftAndReadPatch(page) : { patchBody: null, successful: false };
    const subsetPatches = patchList(subsetApply.patchBody);
    const subsetOk = selectedPaletteObject.clicked &&
      subsetChanged &&
      subsetDraft &&
      subsetApply.successful &&
      subsetPatches.length === 1 &&
      subsetPatches.every((patch) => patch.type !== 'code_patch') &&
      subsetPatches.some((patch) => ['color', 'facecolor', 'edgecolor'].includes(patch.prop) && String(patch.value).toLowerCase() === '#4455aa');
    record('H1-subset', subsetOk ? 'PASS' : 'FAIL', `selected=${JSON.stringify(selectedPaletteObject)}, changed=${subsetChanged}, draft=${subsetDraft}, patches=${JSON.stringify(subsetPatches)}`);

    await clickText(page, '配色中心');
    const paletteChanged =
      await setColorControl(page, 'LINE_COLOR', '统一修改代码全局常量', '#118833') ||
      await setColorControl(page, 'LINE_COLOR', '修改组颜色代码常量', '#118833');
    const paletteDraft = (await getBodyText(page)).includes('已暂存');
    const paletteApply = paletteChanged ? await applyDraftAndReadPatch(page) : { patchBody: null, successful: false };
    const palettePatches = patchList(paletteApply.patchBody);
    const paletteOk = paletteChanged && paletteDraft && paletteApply.successful && palettePatches.some((patch) => (
      (patch.type === 'code_patch' && patch.new_value === '#118833') ||
      (['color', 'facecolor', 'edgecolor'].includes(patch.prop) && patch.value === '#118833')
    ));
    record('H1-whole', paletteOk ? 'PASS' : 'FAIL', `changed=${paletteChanged}, draft=${paletteDraft}, patches=${JSON.stringify(palettePatches)}`);

    await clickText(page, '配色中心');
    const weakPaletteId = 'dict_SERIES_COLORS__Weak';
    const mixedPaletteId = 'dict_SERIES_COLORS__Mixed';
    const weakChanged = await setColorByScope(page, `palette:${weakPaletteId}`, '#22aa66');
    const weakDraft = (await getBodyText(page)).includes('已暂存');
    const weakApply = weakChanged ? await applyDraftAndReadPatch(page) : { patchBody: null, successful: false };
    const weakPatches = patchList(weakApply.patchBody);
    const weakCodePatch = weakPatches.find((patch) => patch.type === 'code_patch');
    const runtimePaletteColors = await readRuntimePaletteColors(page, [weakPaletteId, mixedPaletteId]);
    const weakIsolationOk = weakChanged
      && weakDraft
      && weakApply.successful
      && weakPatches.length === 1
      && weakCodePatch?.target_id === weakPaletteId
      && Array.isArray(weakCodePatch?.gids)
      && weakCodePatch.gids.length === weakGids.length
      && weakCodePatch.gids.every((gid) => weakGids.includes(gid) && !mixedGids.includes(gid))
      && String(runtimePaletteColors[weakPaletteId]).toLowerCase() === '#22aa66'
      && String(runtimePaletteColors[mixedPaletteId]).toLowerCase() === '#446688';
    record(
      'H1b-same-color-weak-only',
      weakIsolationOk ? 'PASS' : 'FAIL',
      `changed=${weakChanged}, draft=${weakDraft}, patch=${JSON.stringify(weakCodePatch)}, colors=${JSON.stringify(runtimePaletteColors)}`,
    );

    await clickText(page, '配色中心');
    const selectedForSave = await clickFirstPaletteAffectedObject(page, 'LINE_COLOR');
    const saveDraftChanged = await setColorControl(page, 'LINE_COLOR', '仅修改已选', '#aa3377');
    const saveDraftVisible = (await getBodyText(page)).includes('已暂存');
    const saveResult = saveDraftChanged ? await saveProjectAndReadPut(page) : { clicked: false, putBody: null, successful: false };
    const savedFigureLog = Array.isArray(saveResult.putBody?.figures?.[0]?.editLog)
      ? saveResult.putBody.figures[0].editLog
      : [];
    const savedLocalColor = savedFigureLog.some((entry) => (
      entry?.mode === 'local_patch' &&
      ['color', 'facecolor', 'edgecolor'].includes(entry?.prop) &&
      String(entry?.value).toLowerCase() === '#aa3377'
    ));
    const persistedProject = projectId ? await requestJson(`/api/projects/${projectId}`).catch(() => null) : null;
    const persistedLog = Array.isArray(persistedProject?.project?.figures?.[0]?.editLog)
      ? persistedProject.project.figures[0].editLog
      : [];
    const persistedLocalColor = persistedLog.some((entry) => (
      entry?.mode === 'local_patch' &&
      ['color', 'facecolor', 'edgecolor'].includes(entry?.prop) &&
      String(entry?.value).toLowerCase() === '#aa3377'
    ));
    const draftClearedAfterSave = !(await getBodyText(page)).includes('已暂存');
    record(
      'H2-save-local-draft',
      selectedForSave.clicked && saveDraftChanged && saveDraftVisible && saveResult.clicked && saveResult.successful && savedLocalColor && persistedLocalColor && draftClearedAfterSave ? 'PASS' : 'FAIL',
      `selected=${JSON.stringify(selectedForSave)}, changed=${saveDraftChanged}, draft=${saveDraftVisible}, savedLocalColor=${savedLocalColor}, persistedLocalColor=${persistedLocalColor}, persistedLog=${JSON.stringify(persistedLog)}, draftCleared=${draftClearedAfterSave}`,
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
    '# SciFigure Studio Semantic Centers Smoke Report',
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
