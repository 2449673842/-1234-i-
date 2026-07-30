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
    || /WebSocket connection to 'ws:\/\/[^']+:24678\//.test(message)
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
  'DYNAMIC_COLOR = "#123456"',
  'VECTOR_A = "#2A9D8F"',
  'VECTOR_B = "#E76F51"',
  'HIST_COLOR = "#884422"',
  'STAIRS_COLOR = "#7755AA"',
  'STEP_COLOR = "#116699"',
  'SERIES_COLORS = {"Weak": "#446688", "Mixed": "#446688"}',
  'dynamic_color = "#" + "123456"',
  'vector_colors = [VECTOR_A, VECTOR_B, VECTOR_A, VECTOR_B]',
  'from matplotlib.patches import Rectangle',
  'fig, ax = plt.subplots(figsize=(5, 3.5))',
  'ax.plot([0, 1, 2, 3], [1, 3, 2, 4], color=LINE_COLOR, linewidth=1.5, marker="o", label="Line A")',
  'ax.scatter([0, 1, 2, 3], [1.2, 2.8, 2.2, 3.7], c=POINT_COLOR, s=55, label="Points")',
  'ax.plot([0, 1, 2, 3], [2.0, 2.4, 2.1, 2.8], color=SERIES_COLORS["Weak"], label="Weak")',
  'ax.plot([0, 1, 2, 3], [2.8, 2.1, 2.6, 2.2], color=SERIES_COLORS["Mixed"], label="Mixed")',
  'ax.plot([0, 1, 2, 3], [3.2, 3.0, 3.4, 3.1], color=dynamic_color, label="Data driven")',
  'ax.hist([0, 0.4, 1.1, 1.6, 2.2, 2.5, 2.8], bins=[0, 1, 2, 3], color=HIST_COLOR, alpha=0.55, label="Histogram")',
  'ax.bar([0.35, 1.35, 2.35], [0.25, 0.35, 0.22], width=0.16, color="#884422", alpha=0.7, label="Plain bar")',
  'ax.plot([0, 1, 2, 3], [0.85, 0.95, 0.75, 0.9], color="#884422", linewidth=1.1, label="Same color line")',
  'ax.stairs([0.45, 0.65, 0.4], [0, 1, 2, 3], color=STAIRS_COLOR, linewidth=1.1, label="Stairs")',
  'ax.add_patch(Rectangle((2.55, 0.2), 0.3, 0.35, facecolor=STAIRS_COLOR, edgecolor=STAIRS_COLOR, alpha=0.7, label="Plain patch"))',
  'ax.step([0, 1, 2, 3], [1.5, 1.7, 1.4, 1.6], where="mid", color=STEP_COLOR, linewidth=1.1, label="Step")',
  'ax.plot([0, 1, 2, 3], [1.72, 1.55, 1.65, 1.5], drawstyle="steps-mid", color=STEP_COLOR, linewidth=1.1, label="Plain stepdraw line")',
  'for vector_idx in range(7):',
  '    ax.scatter([0.2, 1.2, 2.2, 3.2], [0.25 + vector_idx * 0.06, 0.28 + vector_idx * 0.06, 0.25 + vector_idx * 0.06, 0.28 + vector_idx * 0.06], c=vector_colors, s=35)',
  'ax.set_title("Semantic Centers")',
  'ax.set_xlabel("X Axis")',
  'ax.set_ylabel("Y Axis")',
  'ax.set_ylim(0, 4.6)',
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
    const manifest = rendered.figures[0]?.manifest || {};
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
      semanticObjects: (manifest.objects || []).map((object) => ({
        id: object.id,
        kind: object.kind,
        role: object.role,
        label: object.label,
        parentId: object.parentId,
        children: object.children || [],
        currentProps: object.currentProps || {},
        identity: object.identity || {},
      })),
      weakBinding: manifest.bindings?.find((binding) => binding.paletteId === 'dict_SERIES_COLORS__Weak') || null,
      mixedBinding: manifest.bindings?.find((binding) => binding.paletteId === 'dict_SERIES_COLORS__Mixed') || null,
      dynamicBinding: manifest.bindings?.find((binding) => binding.paletteId === 'DYNAMIC_COLOR') || null,
      vectorABinding: manifest.bindings?.find((binding) => binding.paletteId === 'VECTOR_A') || null,
      vectorBBinding: manifest.bindings?.find((binding) => binding.paletteId === 'VECTOR_B') || null,
      histBinding: manifest.bindings?.find((binding) => binding.paletteId === 'HIST_COLOR') || null,
    };
  }, { baseUrl: BASE_URL, script });
  await page.reload({ waitUntil: 'domcontentloaded', timeout: 60000 });
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

async function setComponentNumberByGroup(page, groupId, prop, value) {
  const input = page.locator(
    `[data-component-group-id="${groupId}"] input[data-param-role="number"][data-param-prop="${prop}"]`,
  ).first();
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
  const propertyInput = page.locator(`input[data-property-control="color-text"][data-property-scope="${scope}"]`).first();
  if (await propertyInput.isVisible({ timeout: 3000 }).catch(() => false)) {
    await propertyInput.fill(value);
    await propertyInput.press('Enter').catch(() => {});
    await propertyInput.evaluate((node) => node.blur());
    await page.waitForTimeout(700);
    return true;
  }
  const textInput = page.locator(`input[data-color-role="text"][data-color-scope="${scope}"]`).first();
  if (!(await textInput.isVisible({ timeout: 3000 }).catch(() => false))) return false;
  await textInput.fill(value);
  await textInput.press('Enter').catch(() => {});
  await textInput.evaluate((node) => node.blur());
  await page.waitForTimeout(700);
  return true;
}

async function setColorByScopeInPaletteCard(page, scope, cardText, value) {
  const handle = await page.evaluateHandle(({ scope, cardText }) => {
    const normalize = (text) => String(text || '').replace(/\s+/g, '').toLowerCase();
    const visible = (node) => {
      const rect = node.getBoundingClientRect();
      const style = window.getComputedStyle(node);
      return rect.width > 0 && rect.height > 0 && style.display !== 'none' && style.visibility !== 'hidden';
    };
    const rightSide = (node) => node.getBoundingClientRect().left > window.innerWidth * 0.70;
    const inputs = Array.from(document.querySelectorAll(`input[data-color-role="text"][data-color-scope="${scope}"]`))
      .filter((node) => visible(node) && rightSide(node));
    return inputs.find((node) => {
      let current = node.parentElement;
      while (current && rightSide(current)) {
        if (normalize(current.textContent).includes(normalize(cardText))) return true;
        current = current.parentElement;
      }
      return false;
    }) || null;
  }, { scope, cardText });
  const element = handle.asElement();
  if (!element) return false;
  await element.scrollIntoViewIfNeeded().catch(() => {});
  await element.fill(value);
  await element.press('Enter').catch(() => {});
  await element.evaluate((node) => node.blur());
  await page.waitForTimeout(700);
  return true;
}

async function setPaletteSubplotScope(page, scope) {
  const select = page.getByTestId('palette-subplot-scope');
  if (!(await select.isVisible({ timeout: 3000 }).catch(() => false))) return scope === 'all';
  await select.selectOption(scope);
  await page.waitForTimeout(300);
  return (await select.inputValue()) === scope;
}

async function setColorInComponentGroup(page, groupId, value, prop = 'color') {
  const selector = prop === 'color'
    ? `input[data-color-role="text"][data-param-prop="${prop}"]`
    : 'input[data-color-role="text"][data-color-scope$=":color"]';
  const input = page.locator(`[data-component-group-id="${groupId}"] ${selector}`).first();
  if (!(await input.isVisible({ timeout: 5000 }).catch(() => false))) return false;
  await input.scrollIntoViewIfNeeded().catch(() => {});
  await input.fill(value);
  await input.press('Enter').catch(() => {});
  await input.evaluate((node) => node.blur());
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

async function readRuntimeFigureRevision(page) {
  return page.evaluate(() => {
    const raw = window.sessionStorage.getItem('scifigure:app-state:v2');
    if (!raw) return null;
    const state = JSON.parse(raw);
    return state.projectFigures?.[state.activeFigureId || 'fig_1']?.revision ?? null;
  });
}

async function waitForRuntimePaletteColor(page, paletteId, expectedColor, timeoutMs = 15000) {
  try {
    await page.waitForFunction(({ id, expected }) => {
      const raw = window.sessionStorage.getItem('scifigure:app-state:v2');
      if (!raw) return false;
      const state = JSON.parse(raw);
      const figure = state.projectFigures?.[state.activeFigureId || 'fig_1'];
      const palette = (figure?.manifest?.palettes || []).find((item) => item.id === id);
      return String(palette?.color || '').toLowerCase() === expected;
    }, {
      id: paletteId,
      expected: expectedColor.toLowerCase(),
    }, { timeout: timeoutMs });
    return true;
  } catch {
    return false;
  }
}

async function readRuntimePaletteBinding(page, paletteId) {
  return page.evaluate((id) => {
    const raw = window.sessionStorage.getItem('scifigure:app-state:v2');
    if (!raw) return null;
    const state = JSON.parse(raw);
    const figure = state.projectFigures?.[state.activeFigureId || 'fig_1'];
    const manifest = figure?.manifest || {};
    const palette = (manifest.palettes || []).find((item) => item.id === id);
    const binding = (manifest.bindings || []).find((item) => item.paletteId === id);
    const objects = new Map((manifest.objects || []).map((item) => [item.id, item]));
    return {
      color: palette?.color || null,
      gids: binding?.gids || [],
      editLog: figure?.editLog || [],
      objectColors: (binding?.gids || []).map((gid) => {
        const object = objects.get(gid);
        const prop = (binding?.props || []).find((candidate) => object?.currentProps?.[candidate] !== undefined)
          || 'color';
        return { gid, prop, color: object?.currentProps?.[prop] || null };
      }),
      targets: binding?.targets || [],
    };
  }, paletteId);
}

async function readRuntimeObjectColors(page, gids, prop = 'facecolor') {
  return page.evaluate(({ targetGids, targetProp }) => {
    const raw = window.sessionStorage.getItem('scifigure:app-state:v2');
    if (!raw) return [];
    const state = JSON.parse(raw);
    const figure = state.projectFigures?.[state.activeFigureId || 'fig_1'];
    const objects = new Map((figure?.manifest?.objects || []).map((item) => [item.id, item]));
    return targetGids.map((gid) => ({ gid, color: objects.get(gid)?.currentProps?.[targetProp] || null }));
  }, { targetGids: gids, targetProp: prop });
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
  const responsePromise = page.waitForResponse((response) => (
    response.request().method() === 'POST'
    && new URL(response.url()).pathname === '/api/figure/patch'
  ), { timeout: 60000 });
  const clicked = await clickText(page, '应用当前图');
  if (!clicked) return { clicked: false, patchRequest: null, patchBody: null, successful: false };
  const patchResponse = await responsePromise;
  const responseData = await patchResponse.json().catch(() => null);
  await waitForApiSettle(start, 60000);
  await waitForPreviewReady(page);
  const patchRequest = apiRequests.slice(start).find((request) => request.url.includes('/api/figure/patch')) || null;
  const patchBody = parseJson(patchRequest?.postData);
  const successful = apiResponses.slice(start).some((response) => response.url.includes('/api/figure/patch') && response.status >= 200 && response.status < 300);
  return { clicked, patchRequest, patchBody, responseData, successful };
}

async function saveProjectAndReadPut(page) {
  const start = apiRequests.length;
  const saveButton = page.getByRole('button', { name: /^保存$/ }).first();
  if (!(await saveButton.isVisible({ timeout: 5000 }).catch(() => false))) {
    return { clicked: false, putRequest: null, putBody: null, successful: false };
  }
  const responsePromise = page.waitForResponse((response) => (
    response.request().method() === 'PUT'
    && /\/api\/projects\/[^/]+$/.test(new URL(response.url()).pathname)
  ), { timeout: 40000 });
  await saveButton.click();
  const putResponse = await responsePromise;
  const responseData = await putResponse.json().catch(() => null);
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
  return { clicked: true, putRequest, putBody, successful, responseData };
}

function patchList(body) {
  return Array.isArray(body?.patches) ? body.patches : [];
}

function colorToHex(value) {
  if (typeof value === 'string') return value.startsWith('#') ? value.toLowerCase() : null;
  const tuple = Array.isArray(value?.[0]) ? value[0] : value;
  if (!Array.isArray(tuple) || tuple.length < 3) return null;
  return `#${tuple.slice(0, 3).map((channel) => {
    const numeric = Number(channel);
    const scaled = numeric <= 1 ? numeric * 255 : numeric;
    return Math.round(scaled).toString(16).padStart(2, '0');
  }).join('')}`;
}

async function readRuntimeObjectColorMap(page, objectIds) {
  return page.evaluate((ids) => {
    const raw = window.sessionStorage.getItem('scifigure:app-state:v2');
    if (!raw) return {};
    const state = JSON.parse(raw);
    const figure = state.projectFigures?.[state.activeFigureId || 'fig_1'];
    const objects = figure?.manifest?.objects || [];
    return Object.fromEntries(ids.map((id) => {
      const object = objects.find((item) => item.id === id);
      const props = object?.currentProps || {};
      return [id, props.facecolor ?? props.color ?? props.edgecolor ?? null];
    }));
  }, objectIds);
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
    await page.goto(BASE_URL, { waitUntil: 'domcontentloaded', timeout: 60000 });
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
    const componentChanged = await setComponentNumberByGroup(page, 'lines', 'linewidth', 2.5);
    const componentDraft = (await getBodyText(page)).includes('已暂存');
    const componentApply = componentChanged ? await applyDraftAndReadPatch(page) : { patchBody: null, successful: false };
    const componentPatches = patchList(componentApply.patchBody);
    const componentOk = componentChanged && componentDraft && componentApply.successful && componentPatches.some((patch) => patch.prop === 'linewidth' && Number(patch.value) === 2.5);
    record('G1', componentOk ? 'PASS' : 'FAIL', `changed=${componentChanged}, draft=${componentDraft}, patches=${JSON.stringify(componentPatches)}`);

    await clickText(page, '组件中心');
    const componentDescriptorOnlyChanged = await setComponentNumberByGroup(page, 'texts', 'rotation', 17);
    const componentDescriptorOnlyDraft = (await getBodyText(page)).includes('已暂存');
    const componentDescriptorOnlyApply = componentDescriptorOnlyChanged ? await applyDraftAndReadPatch(page) : { patchBody: null, successful: false };
    const componentDescriptorOnlyPatches = patchList(componentDescriptorOnlyApply.patchBody);
    const componentControlsV2Expected = process.env.VITE_SCIFIGURE_COMPONENT_CONTROLS_V2 !== '0';
    const componentDescriptorOnlyOk = componentControlsV2Expected
      ? componentDescriptorOnlyChanged
        && componentDescriptorOnlyDraft
        && componentDescriptorOnlyApply.successful
        && componentDescriptorOnlyPatches.length > 1
        && componentDescriptorOnlyPatches.every((patch) => patch.prop === 'rotation' && Number(patch.value) === 17)
      : !componentDescriptorOnlyChanged && componentDescriptorOnlyPatches.length === 0;
    record(
      'G1b-component-descriptor-only-fanout',
      componentDescriptorOnlyOk ? 'PASS' : 'FAIL',
      `expected=${componentControlsV2Expected}, changed=${componentDescriptorOnlyChanged}, draft=${componentDescriptorOnlyDraft}, patches=${JSON.stringify(componentDescriptorOnlyPatches)}`,
    );

    await clickText(page, '组件中心');
    const pointSizeChanged = await setNumberByParam(page, 'component-points', 'size_scale', 1.5);
    const pointDraft = (await getBodyText(page)).includes('已暂存');
    const pointApply = pointSizeChanged ? await applyDraftAndReadPatch(page) : { patchBody: null, successful: false };
    const pointPatches = patchList(pointApply.patchBody);
    const pointScaleInput = page.locator('input[data-param-role="number"][data-param-gid="component-points"][data-param-prop="size_scale"]').first();
    const pointScaleReflected = await page.waitForFunction(() => {
      const input = document.querySelector('input[data-param-role="number"][data-param-gid="component-points"][data-param-prop="size_scale"]');
      return input instanceof HTMLInputElement && Number(input.value) === 1.5;
    }, null, { timeout: 15_000 }).then(() => true).catch(() => false);
    const persistedPointState = await requestJson(`/api/projects/${projectId}/figures?includePreview=1`);
    const persistedPointObjects = persistedPointState.figures?.[0]?.manifest?.objects || [];
    const persistedPointScales = pointPatches.map((patch) => (
      persistedPointObjects.find((object) => object.id === patch.gid)?.currentProps?.size_scale
    ));
    const pointOk = pointSizeChanged
      && pointDraft
      && pointApply.successful
      && await pointScaleInput.isVisible().catch(() => false)
      && pointScaleReflected
      && pointPatches.length >= 2
      && pointPatches.every((patch) => (
        /^collection\.\d+\.\d+$/.test(String(patch?.gid || ''))
        && patch?.prop === 'size_scale'
        && Number(patch?.value) === 1.5
      ))
      && Number(pointPatches[0]?.value) === 1.5
      && persistedPointScales.length === pointPatches.length
      && persistedPointScales.every((value) => Number(value) === 1.5);
    record('G2-scatter-excludes-legend', pointOk ? 'PASS' : 'FAIL', `changed=${pointSizeChanged}, draft=${pointDraft}, reflected=${pointScaleReflected}, persistedScales=${JSON.stringify(persistedPointScales)}, patches=${JSON.stringify(pointPatches)}`);

    const semanticObjects = fixture.semanticObjects || [];
    const stairsIds = semanticObjects.filter((object) => object.role === 'stairs_series').map((object) => object.id);
    const stepIds = semanticObjects.filter((object) => object.role === 'step_series').map((object) => object.id);
    const ordinaryPatchIds = semanticObjects
      .filter((object) => object.kind === 'patch' && object.role !== 'stairs_series' && object.role !== 'legend_marker')
      .map((object) => object.id);
    const ordinaryLineIds = semanticObjects
      .filter((object) => object.kind === 'line' && object.role !== 'step_series' && object.role !== 'legend_marker')
      .map((object) => object.id);

    await clickText(page, '组件中心');
    const stairsChanged = await setColorInComponentGroup(page, 'stairs', '#334455', 'edgecolor');
    const stairsDraft = (await getBodyText(page)).includes('已暂存');
    const stairsApply = stairsChanged ? await applyDraftAndReadPatch(page) : { patchBody: null, successful: false };
    const stairsPatches = patchList(stairsApply.patchBody);
    const stairsIsolationOk = stairsIds.length > 0
      && ordinaryPatchIds.length > 0
      && stairsChanged
      && stairsDraft
      && stairsApply.successful
      && stairsPatches.length === stairsIds.length
      && stairsPatches.every((patch) => (
        stairsIds.includes(patch.gid)
        && patch.prop === 'edgecolor'
        && String(patch.value).toLowerCase() === '#334455'
      ))
      && stairsPatches.every((patch) => !ordinaryPatchIds.includes(patch.gid));
    record(
      'G3-stairs-dedicated-role-isolation',
      stairsIsolationOk ? 'PASS' : 'FAIL',
      `stairs=${JSON.stringify(stairsIds)}, ordinaryPatches=${JSON.stringify(ordinaryPatchIds)}, changed=${stairsChanged}, draft=${stairsDraft}, patches=${JSON.stringify(stairsPatches)}`,
    );

    await clickText(page, '组件中心');
    const stepChanged = await setColorInComponentGroup(page, 'steps', '#2255cc', 'color');
    const stepDraft = (await getBodyText(page)).includes('已暂存');
    const stepApply = stepChanged ? await applyDraftAndReadPatch(page) : { patchBody: null, successful: false };
    const stepPatches = patchList(stepApply.patchBody);
    const stepIsolationOk = stepIds.length > 0
      && ordinaryLineIds.length > 0
      && stepChanged
      && stepDraft
      && stepApply.successful
      && stepPatches.length === stepIds.length
      && stepPatches.every((patch) => (
        stepIds.includes(patch.gid)
        && patch.prop === 'color'
        && String(patch.value).toLowerCase() === '#2255cc'
      ))
      && stepPatches.every((patch) => !ordinaryLineIds.includes(patch.gid));
    record(
      'G4-step-dedicated-role-isolation',
      stepIsolationOk ? 'PASS' : 'FAIL',
      `steps=${JSON.stringify(stepIds)}, ordinaryLines=${JSON.stringify(ordinaryLineIds)}, changed=${stepChanged}, draft=${stepDraft}, patches=${JSON.stringify(stepPatches)}`,
    );

    await clickText(page, '配色中心');
    const paletteV2Expected = process.env.VITE_SCIFIGURE_PALETTE_CONTROLS_V2 !== '0';
    const paletteV2Count = await page.locator('[data-palette-controls-version="2"]').count();
    const strictPaletteControlCount = await page.locator('input[data-property-control="color-text"][data-property-scope="palette:LINE_COLOR"]').count();
    record(
      'P6-palette-descriptor-controls',
      (paletteV2Expected ? paletteV2Count > 0 && strictPaletteControlCount === 1 : paletteV2Count === 0) ? 'PASS' : 'FAIL',
      `expected=${paletteV2Expected}, controls=${paletteV2Count}, lineColor=${strictPaletteControlCount}`,
    );
    const selectedPaletteObject = await clickFirstPaletteAffectedObject(page, 'LINE_COLOR');
    const subsetChanged = await setColorByScope(page, 'palette-subset:LINE_COLOR', '#4455aa')
      || await setColorControl(page, 'LINE_COLOR', '仅修改已选', '#4455aa');
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
    await setPaletteSubplotScope(page, 'all');
    const paletteChanged = await setColorByScope(page, 'palette:LINE_COLOR', '#118833') ||
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
    const weakObjectPatches = weakPatches.filter((patch) => patch.type !== 'code_patch');
    const weakRuntimeSynced = await waitForRuntimePaletteColor(page, weakPaletteId, '#22aa66');
    const runtimePaletteColors = await readRuntimePaletteColors(page, [weakPaletteId, mixedPaletteId]);
    const weakRuntimeRevision = await readRuntimeFigureRevision(page);
    const weakResponsePalette = weakApply.responseData?.manifest?.palettes?.find((item) => item.id === weakPaletteId);
    const weakIsolationOk = weakChanged
      && weakDraft
      && weakApply.successful
      && weakRuntimeSynced
      && weakCodePatch?.target_id === weakPaletteId
      && Array.isArray(weakCodePatch?.gids)
      && weakCodePatch.gids.length === weakGids.length
      && weakCodePatch.gids.every((gid) => weakGids.includes(gid) && !mixedGids.includes(gid))
      && weakObjectPatches.length === weakGids.length
      && weakObjectPatches.every((patch) => weakGids.includes(patch.gid) && !mixedGids.includes(patch.gid))
      && String(runtimePaletteColors[weakPaletteId]).toLowerCase() === '#22aa66'
      && String(runtimePaletteColors[mixedPaletteId]).toLowerCase() === '#446688';
    record(
      'H1b-same-color-weak-only',
      weakIsolationOk ? 'PASS' : 'FAIL',
      `changed=${weakChanged}, draft=${weakDraft}, synced=${weakRuntimeSynced}, responseRevision=${weakApply.responseData?.revision}, runtimeRevision=${weakRuntimeRevision}, responseColor=${weakResponsePalette?.color}, patch=${JSON.stringify(weakCodePatch)}, colors=${JSON.stringify(runtimePaletteColors)}`,
    );

    await clickText(page, '配色中心');
    const dynamicGids = fixture.dynamicBinding?.gids || [];
    const dynamicChanged = await setColorByScope(page, 'palette:DYNAMIC_COLOR', '#654321');
    const dynamicDraft = (await getBodyText(page)).includes('已暂存');
    const dynamicApply = dynamicChanged ? await applyDraftAndReadPatch(page) : { patchBody: null, successful: false };
    const dynamicPatches = patchList(dynamicApply.patchBody);
    const dynamicCodePatch = dynamicPatches.find((patch) => patch.type === 'code_patch' && patch.target_id === 'DYNAMIC_COLOR');
    const dynamicObjectPatches = dynamicPatches.filter((patch) => patch.type !== 'code_patch');
    const dynamicApplied = Array.isArray(dynamicApply.responseData?.applied)
      ? dynamicApply.responseData.applied.filter((patch) => patch?.gid && patch?.prop)
      : [];
    const dynamicRuntimeSynced = await waitForRuntimePaletteColor(page, 'DYNAMIC_COLOR', '#654321');
    const dynamicRuntime = await readRuntimePaletteBinding(page, 'DYNAMIC_COLOR');
    const dynamicFallbackOk = dynamicChanged
      && dynamicDraft
      && dynamicApply.successful
      && dynamicRuntimeSynced
      && dynamicGids.length > 0
      && dynamicCodePatch?.new_value === '#654321'
      && dynamicObjectPatches.length === dynamicGids.length
      && dynamicObjectPatches.every((patch) => dynamicGids.includes(patch.gid) && String(patch.value).toLowerCase() === '#654321')
      && String(dynamicRuntime?.color).toLowerCase() === '#654321'
      && dynamicRuntime?.gids?.length === dynamicGids.length
      && dynamicRuntime?.objectColors?.every((item) => String(item.color).toLowerCase() === '#654321')
      && dynamicGids.every((gid) => dynamicRuntime?.editLog?.some((entry) => (
        entry.gid === gid
        && ['color', 'facecolor', 'edgecolor'].includes(entry.prop)
        && String(entry.value).toLowerCase() === '#654321'
        && dynamicApplied.some((applied) => (
          applied.gid === entry.gid
          && applied.prop === entry.prop
          && applied.mode === entry.mode
        ))
      )));
    record(
      'H1c-data-driven-color-fallback',
      dynamicFallbackOk ? 'PASS' : 'FAIL',
      `changed=${dynamicChanged}, draft=${dynamicDraft}, synced=${dynamicRuntimeSynced}, patches=${JSON.stringify(dynamicPatches)}, response=${JSON.stringify(dynamicApply.responseData)}, runtime=${JSON.stringify(dynamicRuntime)}`,
    );

    await clickText(page, '配色中心');
    const vectorCard = page.locator('[data-palette-id="VECTOR_A"]').first();
    const vectorGroupSelectionAvailable = await vectorCard
      .getByRole('button', { name: '选中整组', exact: true })
      .isEnabled()
      .catch(() => false);
    const vectorChanged = await setColorByScope(page, 'palette:VECTOR_A', '#33AA77');
    const vectorDraft = (await getBodyText(page)).includes('已暂存');
    const vectorApply = vectorChanged ? await applyDraftAndReadPatch(page) : { patchBody: null, successful: false };
    const vectorPatches = patchList(vectorApply.patchBody);
    const vectorRuntimeA = await readRuntimePaletteBinding(page, 'VECTOR_A');
    const vectorRuntimeB = await readRuntimePaletteBinding(page, 'VECTOR_B');
    const vectorColors = (vectorRuntimeA?.objectColors || []).flatMap((item) => item.color || []).map((row) => (
      `#${row.slice(0, 3).map((value) => Math.round(Number(value) * 255).toString(16).padStart(2, '0')).join('')}`
    ));
    const vectorIsolationOk = vectorChanged
      && vectorDraft
      && vectorApply.successful
      && vectorPatches.length === 1
      && vectorPatches[0]?.type === 'code_patch'
      && vectorPatches[0]?.target_id === 'VECTOR_A'
      && vectorGroupSelectionAvailable
      && vectorRuntimeA?.targets?.every((target) => target.replayMode === 'code_only')
      && String(vectorRuntimeA?.color).toLowerCase() === '#33aa77'
      && String(vectorRuntimeB?.color).toLowerCase() === '#e76f51'
      && vectorColors.filter((color) => color === '#33aa77').length === 14
      && vectorColors.filter((color) => color === '#e76f51').length === 14;
    record(
      'H1d-vector-color-group-isolation',
      vectorIsolationOk ? 'PASS' : 'FAIL',
      `patches=${JSON.stringify(vectorPatches)}, A=${JSON.stringify(vectorRuntimeA)}, B=${JSON.stringify(vectorRuntimeB)}`,
    );

    await clickText(page, '配色中心');
    await vectorCard.getByRole('button', { name: '选中整组', exact: true }).click();
    await page.waitForTimeout(300);
    const vectorSubsetChanged = await setColorByScope(page, 'palette-subset:VECTOR_A', '#7744AA');
    const vectorSubsetDraft = (await getBodyText(page)).includes('已暂存');
    const vectorSubsetApply = vectorSubsetChanged ? await applyDraftAndReadPatch(page) : { patchBody: null, successful: false };
    const vectorSubsetPatches = patchList(vectorSubsetApply.patchBody);
    const vectorSubsetObjects = await readRuntimeObjectColors(page, fixture.vectorABinding?.gids || []);
    const vectorSubsetColors = vectorSubsetObjects.flatMap((item) => item.color || []).map((row) => (
      `#${row.slice(0, 3).map((value) => Math.round(Number(value) * 255).toString(16).padStart(2, '0')).join('')}`
    ));
    const vectorSubsetOk = vectorSubsetChanged
      && vectorSubsetDraft
      && vectorSubsetApply.successful
      && vectorSubsetPatches.length === 14
      && vectorSubsetPatches.every((patch) => (
        patch.type !== 'code_patch'
        && /^collection\.\d+\.\d+$/.test(String(patch.gid || ''))
        && ['facecolor', 'edgecolor'].includes(patch.prop)
        && String(patch.matchColor).toLowerCase() === '#33aa77'
        && String(patch.value).toLowerCase() === '#7744aa'
      ))
      && vectorSubsetColors.filter((color) => color === '#7744aa').length === 14
      && vectorSubsetColors.filter((color) => color === '#e76f51').length === 14;
    record(
      'H1e-vector-rendered-color-subset',
      vectorSubsetOk ? 'PASS' : 'FAIL',
      `changed=${vectorSubsetChanged}, draft=${vectorSubsetDraft}, patches=${JSON.stringify(vectorSubsetPatches)}, objects=${JSON.stringify(vectorSubsetObjects)}`,
    );

    await clickText(page, '配色中心');
    const secondSubsetChanged = await setColorByScope(page, 'palette-subset:VECTOR_B', '#CC3366');
    const secondSubsetApply = secondSubsetChanged ? await applyDraftAndReadPatch(page) : { patchBody: null, successful: false };
    const secondSubsetPatches = patchList(secondSubsetApply.patchBody);
    const objectsAfterTwoSubsets = await readRuntimeObjectColors(page, fixture.vectorABinding?.gids || []);
    const colorsAfterTwoSubsets = objectsAfterTwoSubsets.flatMap((item) => item.color || []).map((row) => (
      `#${row.slice(0, 3).map((value) => Math.round(Number(value) * 255).toString(16).padStart(2, '0')).join('')}`
    ));
    const twoSubsetReplayOk = secondSubsetChanged
      && secondSubsetApply.successful
      && secondSubsetPatches.length === 14
      && secondSubsetPatches.every((patch) => String(patch.matchColor).toLowerCase() === '#e76f51')
      && colorsAfterTwoSubsets.filter((color) => color === '#7744aa').length === 14
      && colorsAfterTwoSubsets.filter((color) => color === '#cc3366').length === 14;
    record(
      'H1f-vector-multiple-subset-replay',
      twoSubsetReplayOk ? 'PASS' : 'FAIL',
      `patches=${JSON.stringify(secondSubsetPatches)}, objects=${JSON.stringify(objectsAfterTwoSubsets)}`,
    );

    await clickText(page, '配色中心');
    await setPaletteSubplotScope(page, 'all');
    const histogramObjects = semanticObjects.filter((object) => object.role === 'histogram_series');
    const histogramIds = histogramObjects.map((object) => object.id);
    const histogramChildIds = new Set(histogramObjects.flatMap((object) => object.children || []));
    const parentOwnedHistogramChildIds = new Set(semanticObjects
      .filter((object) => histogramChildIds.has(object.id) || object.currentProps?.parentOwned === true)
      .map((object) => object.id));
    const relatedHistogramLegendIds = new Set(histogramObjects.flatMap((object) => (
      object.identity?.relation?.legendMarkerIds || []
    )));
    const allowedHistogramPaletteIds = new Set([
      ...histogramIds,
      ...relatedHistogramLegendIds,
    ]);
    const ordinarySameColorDecoyIds = semanticObjects
      .filter((object) => (
        !allowedHistogramPaletteIds.has(object.id)
        && !parentOwnedHistogramChildIds.has(object.id)
        && ['Plain bar', 'Same color line'].includes(String(object.label || ''))
        && object.role !== 'legend_marker'
      ))
      .map((object) => object.id);
    const histChanged =
      await setColorByScopeInPaletteCard(page, 'palette:HIST_COLOR', 'HIST_COLOR', '#bb6633') ||
      await setColorByScope(page, 'palette:HIST_COLOR', '#bb6633');
    const histDraft = (await getBodyText(page)).includes('已暂存');
    const histApply = histChanged ? await applyDraftAndReadPatch(page) : { patchBody: null, successful: false };
    const histPatches = patchList(histApply.patchBody);
    const histCodePatch = histPatches.find((patch) => patch.type === 'code_patch' && patch.target_id === 'HIST_COLOR');
    const histObjectPatches = histPatches.filter((patch) => patch.type !== 'code_patch');
    const histCodeGids = Array.isArray(histCodePatch?.gids) ? histCodePatch.gids : [];
    const histRuntime = await readRuntimePaletteBinding(page, 'HIST_COLOR');
    const histRuntimeGids = Array.isArray(histRuntime?.gids) ? histRuntime.gids : [];
    const histRuntimeColors = await readRuntimeObjectColorMap(page, [
      ...allowedHistogramPaletteIds,
      ...ordinarySameColorDecoyIds,
    ]);
    const allowedRuntimeColorsChanged = [...allowedHistogramPaletteIds]
      .every((gid) => colorToHex(histRuntimeColors[gid]) === '#bb6633');
    const ordinaryRuntimeColorsUnchanged = ordinarySameColorDecoyIds
      .every((gid) => colorToHex(histRuntimeColors[gid]) === '#884422');
    const forbiddenHistogramPaletteIds = new Set([
      ...parentOwnedHistogramChildIds,
      ...ordinarySameColorDecoyIds,
    ]);
    const histPaletteIsolationOk = histogramIds.length > 0
      && relatedHistogramLegendIds.size > 0
      && parentOwnedHistogramChildIds.size > 0
      && ordinarySameColorDecoyIds.length > 0
      && histChanged
      && histDraft
      && histApply.successful
      && String(histCodePatch?.new_value).toLowerCase() === '#bb6633'
      && (histCodeGids.length === 0 || histCodeGids.every((gid) => allowedHistogramPaletteIds.has(gid)))
      && String(histRuntime?.color).toLowerCase() === '#bb6633'
      && allowedRuntimeColorsChanged
      && ordinaryRuntimeColorsUnchanged
      && histObjectPatches.every((patch) => (
        allowedHistogramPaletteIds.has(patch.gid)
        && !parentOwnedHistogramChildIds.has(patch.gid)
        && !ordinarySameColorDecoyIds.includes(patch.gid)
        && ['color', 'facecolor', 'edgecolor'].includes(patch.prop)
        && String(patch.value).toLowerCase() === '#bb6633'
      ))
      && [...forbiddenHistogramPaletteIds].every((gid) => (
        !histRuntimeGids.includes(gid)
        && !histCodeGids.includes(gid)
        && !histObjectPatches.some((patch) => patch.gid === gid)
      ));
    record(
      'H1g-histogram-palette-relation-isolation',
      histPaletteIsolationOk ? 'PASS' : 'FAIL',
      `histograms=${JSON.stringify(histogramIds)}, legendMarkers=${JSON.stringify([...relatedHistogramLegendIds])}, parentOwned=${JSON.stringify([...parentOwnedHistogramChildIds])}, decoys=${JSON.stringify(ordinarySameColorDecoyIds)}, changed=${histChanged}, draft=${histDraft}, patches=${JSON.stringify(histPatches)}, runtime=${JSON.stringify(histRuntime)}, runtimeColors=${JSON.stringify(histRuntimeColors)}`,
    );

    await clickText(page, '配色中心');
    const selectedForSave = await clickFirstPaletteAffectedObject(page, 'LINE_COLOR');
    const saveDraftChanged = await setColorByScope(page, 'palette-subset:LINE_COLOR', '#aa3377')
      || await setColorControl(page, 'LINE_COLOR', '仅修改已选', '#aa3377');
    const saveDraftVisible = (await getBodyText(page)).includes('已暂存');
    const saveResult = saveDraftChanged ? await saveProjectAndReadPut(page) : { clicked: false, putBody: null, successful: false };
    const savedFigureLog = Array.isArray(saveResult.putBody?.figures?.[0]?.editLog)
      ? saveResult.putBody.figures[0].editLog
      : [];
    const savedLocalColor = savedFigureLog.some((entry) => (
      entry?.mode === 'local_patch' &&
      ['color', 'facecolor', 'edgecolor'].includes(entry?.prop) &&
      String(entry?.value).toLowerCase() === '#aa3377' &&
      typeof entry?.stableKey === 'string' &&
      entry?.fingerprintVersion === 2 &&
      typeof entry?.identity?.instanceKey === 'string'
    ));
    const persistedProject = projectId ? await requestJson(`/api/projects/${projectId}`).catch(() => null) : null;
    const persistedLog = Array.isArray(persistedProject?.project?.figures?.[0]?.editLog)
      ? persistedProject.project.figures[0].editLog
      : [];
    const persistedLocalColor = persistedLog.some((entry) => (
      entry?.mode === 'local_patch' &&
      ['color', 'facecolor', 'edgecolor'].includes(entry?.prop) &&
      String(entry?.value).toLowerCase() === '#aa3377' &&
      typeof entry?.stableKey === 'string' &&
      entry?.fingerprintVersion === 2 &&
      typeof entry?.identity?.instanceKey === 'string'
    ));
    const draftClearedAfterSave = !(await getBodyText(page)).includes('已暂存');
    record(
      'H2-save-local-draft',
      selectedForSave.clicked && saveDraftChanged && saveDraftVisible && saveResult.clicked && saveResult.successful && savedLocalColor && persistedLocalColor && draftClearedAfterSave ? 'PASS' : 'FAIL',
      `selected=${JSON.stringify(selectedForSave)}, changed=${saveDraftChanged}, draft=${saveDraftVisible}, savedLocalColor=${savedLocalColor}, persistedLocalColor=${persistedLocalColor}, response=${JSON.stringify(saveResult.responseData)}, persistedLog=${JSON.stringify(persistedLog)}, draftCleared=${draftClearedAfterSave}`,
    );

    await clickText(page, '配色中心');
    const engineDraftChanged = await setColorByScope(page, 'palette:LINE_COLOR', '#bb5522');
    const engineDraftVisible = (await getBodyText(page)).includes('已暂存');
    const saveRequestStart = apiRequests.length;
    let blockedSaveMessage = '';
    page.once('dialog', async (dialog) => {
      blockedSaveMessage = dialog.message();
      await dialog.accept();
    });
    const saveButton = page.getByRole('button', { name: /^保存$/ }).first();
    const saveButtonClicked = await saveButton.isVisible({ timeout: 3000 }).catch(() => false);
    if (saveButtonClicked) await saveButton.click();
    await page.waitForTimeout(900);
    const blockedSavePut = apiRequests.slice(saveRequestStart).some((request) => (
      request.method === 'PUT' && /\/api\/projects\/[^/]+$/.test(new URL(request.url).pathname)
    ));
    const engineDraftRetained = (await getBodyText(page)).includes('已暂存');
    record(
      'H3-save-blocks-engine-draft',
      engineDraftChanged && engineDraftVisible && saveButtonClicked && !blockedSavePut && engineDraftRetained && blockedSaveMessage.includes('需要先应用') ? 'PASS' : 'FAIL',
      `changed=${engineDraftChanged}, draft=${engineDraftVisible}, clicked=${saveButtonClicked}, put=${blockedSavePut}, retained=${engineDraftRetained}, dialog=${JSON.stringify(blockedSaveMessage)}`,
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
