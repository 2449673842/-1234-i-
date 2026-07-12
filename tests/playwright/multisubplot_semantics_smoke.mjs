/**
 * SciFigure Studio multi-subplot semantic grouping smoke test.
 *
 * Verifies:
 * - Font Center can scope edits to one subplot.
 * - Component Center can scope edits to one subplot.
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
const OUTPUT_DIR = path.join(ROOT, 'output', 'playwright', `multisubplot-semantics-${RUN_ID}`);

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

function isIgnorableDevServerNoise(message) {
  return message.includes('[vite] failed to connect to websocket')
    || message.includes("WebSocket connection to 'ws://localhost:24678/")
    || message.includes('WebSocket closed without opened');
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
    .filter((project) => String(project?.name || '').startsWith('Multi-subplot semantic smoke'))
    .map((project) => {
      const id = project.id || project.projectId;
      return id ? requestJson(`/api/projects/${id}`, { method: 'DELETE' }).catch(() => null) : null;
    }));
}

const script = [
  'import matplotlib.pyplot as plt',
  'fig, axs = plt.subplots(2, 2, figsize=(7, 5))',
  'for idx, ax in enumerate(axs.flat):',
  '    ax.plot([0, 1, 2], [idx + 1, idx + 2, idx + 1.5], linewidth=1.2, label=f"Line {idx + 1}")',
  '    ax.set_title(f"Panel {idx + 1}")',
  '    ax.set_xlabel(f"X {idx + 1}")',
  '    ax.set_ylabel(f"Y {idx + 1}")',
  '    ax.legend(loc="upper right")',
  'plt.tight_layout()',
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
      figure: { width: 170, height: 125, unit: 'mm', dpi: 300 },
    };
    const createRes = await fetch(`${baseUrl}/api/projects`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: `Multi-subplot semantic smoke ${Date.now()}`, spec }),
    });
    const created = await createRes.json();
    if (created.status !== 'success') throw new Error(created.message || 'create project failed');

    const renderRes = await fetch(`${baseUrl}/api/projects/${created.id}/figures/render`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ script, editLogs: { fig_1: [] }, language: 'python', requestId: `multi-subplot-${Date.now()}` }),
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
      projectName: 'Multi-subplot semantic smoke',
      projectFigures,
      activeFigureId: 'fig_1',
      datasets: [],
      selectedGids: [],
      projectHistory: {},
      currentView: 'workspace',
      subView: 'home',
      renderLog: ['> Multi-subplot fixture ready'],
      figSession: null,
    }));
    const objects = rendered.figures[0]?.manifest?.objects || [];
    return {
      projectId: created.id,
      objectCount: objects.length,
      subplotIds: objects.filter((object) => object.kind === 'subplot').map((object) => object.id),
      axisIds: objects.filter((object) => object.kind === 'axis_x').map((object) => object.id),
      lineIds: objects.filter((object) => object.kind === 'line' && !String(object.id).startsWith('legend_')).map((object) => object.id),
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

async function setRightSidebarScope(page, optionValue) {
  const changed = await page.evaluate((value) => {
    const visible = (node) => {
      const rect = node.getBoundingClientRect();
      const style = window.getComputedStyle(node);
      return rect.width > 0 && rect.height > 0 && style.display !== 'none' && style.visibility !== 'hidden';
    };
    const rightSide = (node) => node.getBoundingClientRect().left > window.innerWidth * 0.70;
    const selects = Array.from(document.querySelectorAll('select')).filter((node) => visible(node) && rightSide(node));
    const select = selects.find((node) => Array.from(node.options).some((option) => option.value === value));
    if (!select) return false;
    select.value = value;
    select.dispatchEvent(new Event('change', { bubbles: true }));
    return true;
  }, optionValue);
  await page.waitForTimeout(700);
  return changed;
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
  const directHandle = await page.evaluateHandle(({ sectionText, labelText }) => {
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
      const gid = node.getAttribute('data-param-gid') || '';
      let current = node.parentElement;
      let sectionMatched = false;
      while (current) {
        if (rightSide(current) && normalize(current.textContent).includes(normalize(sectionText))) {
          sectionMatched = true;
          break;
        }
        current = current.parentElement;
      }
      return sectionMatched && (normalize(prop) === normalize(labelText) || normalize(gid).includes(normalize(sectionText)));
    }) || null;
  }, { sectionText, labelText });
  const directElement = directHandle.asElement();
  if (directElement) {
    await directElement.scrollIntoViewIfNeeded().catch(() => {});
    await directElement.fill(String(value));
    await directElement.press('Enter').catch(() => {});
    await directElement.evaluate((node) => node.blur());
    await page.waitForTimeout(700);
    return true;
  }
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

async function setNumberControlInExactCard(page, cardText, prop, value) {
  const handle = await page.evaluateHandle(({ cardText, prop }) => {
    const normalize = (text) => String(text || '').replace(/\s+/g, '');
    const visible = (node) => {
      const rect = node.getBoundingClientRect();
      const style = window.getComputedStyle(node);
      return rect.width > 0 && rect.height > 0 && style.display !== 'none' && style.visibility !== 'hidden';
    };
    const rightSide = (node) => node.getBoundingClientRect().left > window.innerWidth * 0.70;
    const heading = Array.from(document.querySelectorAll('span, div, p'))
      .find((node) => visible(node) && rightSide(node) && normalize(node.textContent) === normalize(cardText));
    if (!heading) return null;
    let current = heading.parentElement;
    while (current && rightSide(current)) {
      const control = Array.from(current.querySelectorAll('input[data-param-role="number"]'))
        .find((node) => visible(node) && !node.disabled && node.getAttribute('data-param-prop') === prop);
      if (control) return control;
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

async function applyDraftAndReadPatch(page) {
  const start = apiRequests.length;
  const clicked = await clickText(page, '应用当前图');
  if (!clicked) return { clicked: false, patchBody: null, successful: false };
  await waitForApiSettle(start, 60000);
  await waitForPreviewReady(page);
  const patchRequest = apiRequests.slice(start).find((request) => request.url.includes('/api/figure/patch')) || null;
  const patchBody = parseJson(patchRequest?.postData);
  const successful = apiResponses.slice(start).some((response) => response.url.includes('/api/figure/patch') && response.status >= 200 && response.status < 300);
  return { clicked, patchBody, successful };
}

function patchList(body) {
  return Array.isArray(body?.patches) ? body.patches : [];
}

async function run() {
  fs.mkdirSync(OUTPUT_DIR, { recursive: true });
  authToken = await authenticateCapabilitySmokeUser(BASE_URL, 'multi-subplot semantics');
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

    const fixtureOk = fixture.subplotIds.length === 4 && fixture.axisIds.length === 4 && fixture.lineIds.length === 4;
    record('M0-fixture', fixtureOk ? 'PASS' : 'FAIL', JSON.stringify(fixture));

    await clickText(page, '字体中心');
    const fontScopeChanged = await setRightSidebarScope(page, 'subplot.0');
    const fontChanged = await setNumberControl(page, 'X 轴刻度文字', '字号', 14);
    const fontDraft = (await getBodyText(page)).includes('已暂存');
    const fontApply = fontChanged ? await applyDraftAndReadPatch(page) : { patchBody: null, successful: false };
    const fontPatches = patchList(fontApply.patchBody);
    const fontOk = fontScopeChanged &&
      fontChanged &&
      fontDraft &&
      fontApply.successful &&
      fontPatches.length === 1 &&
      fontPatches.some((patch) => patch.gid === 'axis.x.0' && patch.prop === 'tick_labelsize' && Number(patch.value) === 14);
    record('M1-font-subplot-scope', fontOk ? 'PASS' : 'FAIL', `scope=${fontScopeChanged}, changed=${fontChanged}, draft=${fontDraft}, patches=${JSON.stringify(fontPatches)}`);

    await clickText(page, '组件中心');
    const componentScopeChanged = await setRightSidebarScope(page, 'subplot.3');
    const componentChanged = await setNumberControlInExactCard(page, '线条 / 拟合线', 'linewidth', 3.3);
    const componentDraft = (await getBodyText(page)).includes('已暂存');
    const componentApply = componentChanged ? await applyDraftAndReadPatch(page) : { patchBody: null, successful: false };
    const componentPatches = patchList(componentApply.patchBody);
    const componentOk = componentScopeChanged &&
      componentChanged &&
      componentDraft &&
      componentApply.successful &&
      componentPatches.length === 1 &&
      componentPatches.some((patch) => /^line\.3\./.test(patch.gid) && patch.prop === 'linewidth' && Number(patch.value) === 3.3);
    record('M2-component-subplot-scope', componentOk ? 'PASS' : 'FAIL', `scope=${componentScopeChanged}, changed=${componentChanged}, draft=${componentDraft}, patches=${JSON.stringify(componentPatches)}`);

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
    '# SciFigure Studio Multi-Subplot Semantics Smoke Report',
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
