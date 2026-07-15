/**
 * SciFigure Studio strict behavior smoke test.
 *
 * This script verifies behavior, not only UI presence:
 * - Draft edits do not immediately hit backend patch/render APIs.
 * - Applying a draft sends exactly one current-figure patch request.
 * - Undo becomes available after an applied draft.
 * - Export page can be reached after a confirmed edit.
 *
 * Run:
 *   node tests/playwright/scifigure_behavior_smoke.mjs
 *
 * Prerequisite:
 *   The app is running at http://localhost:3000.
 */

import { chromium } from 'playwright';
import * as fs from 'fs';
import * as path from 'path';
import { fileURLToPath } from 'url';
import Database from 'better-sqlite3';
import {
  authenticateCapabilitySmokeUser,
  bearerHeaders,
  installBrowserAuthentication,
} from './smokeAuth.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '../..');
const BASE_URL = process.env.SCIFIGURE_URL || 'http://localhost:3000';
const RUN_ID = new Date().toISOString().replace(/[:.]/g, '-');
const OUTPUT_DIR = path.join(ROOT, 'output', 'playwright', `behavior-smoke-${RUN_ID}`);

const results = [];
const consoleErrors = [];
const pageErrors = [];
const apiRequests = [];
const apiResponses = [];
const diagnostics = {};
let delayNextPatchRequest = false;
let delayedPatchRequests = 0;

function record(id, status, note, extra = {}) {
  results.push({ id, status, note, ...extra });
  const icon = status === 'PASS' ? 'PASS' : status === 'FAIL' ? 'FAIL' : 'BLOCKED';
  console.log(`${icon} ${id}: ${note}`);
}

async function screenshot(page, name) {
  const file = path.join(OUTPUT_DIR, `${name.replace(/[^a-zA-Z0-9_-]/g, '_')}.png`);
  await page.screenshot({ path: file, fullPage: false }).catch(() => {});
  return file;
}

async function getBodyText(page) {
  return (await page.textContent('body').catch(() => '')) || '';
}

async function clickVisibleText(page, text, timeout = 4000) {
  const candidates = [
    page.getByRole('button', { name: new RegExp(text) }).first(),
    page.getByText(text, { exact: false }).first(),
  ];
  for (const locator of candidates) {
    if (await locator.isVisible({ timeout }).catch(() => false)) {
      await locator.click();
      return true;
    }
  }
  return false;
}

async function cleanupSmokeProjects(token) {
  const res = await fetch(`${BASE_URL}/api/projects`, {
    headers: bearerHeaders(token),
  }).catch(() => null);
  if (!res) return;
  const data = await res.json().catch(() => null);
  const projects = Array.isArray(data?.projects) ? data.projects : [];
  await Promise.all(projects
    .filter((project) => String(project?.name || '').startsWith('Drag smoke'))
    .map((project) => {
      const id = project.id || project.projectId;
      return id ? fetch(`${BASE_URL}/api/projects/${id}`, {
        method: 'DELETE',
        headers: bearerHeaders(token),
      }).catch(() => null) : null;
    }));
}

async function navigateToEditor(page) {
  await page.goto(BASE_URL, { waitUntil: 'networkidle', timeout: 30000 });
  await page.waitForTimeout(1500);

  let body = await getBodyText(page);
  if (body.includes('属性编辑') && body.includes('预览')) {
    return true;
  }

  const myProjects = page.getByRole('button', { name: /^我的项目$/ }).first();
  if (await myProjects.isVisible({ timeout: 5000 }).catch(() => false)) {
    await myProjects.click();
  } else {
    await clickVisibleText(page, '打开已有项目', 3000).catch(() => false);
  }
  await page.waitForTimeout(1000);
  await page.waitForLoadState('networkidle').catch(() => {});

  body = await getBodyText(page);
  if (!body.includes('搜索项目') && !body.includes('共 ')) {
    return false;
  }

  const projectCardSelectors = [
    'div.cursor-pointer.group',
    'div[class*="cursor-pointer"][class*="group"]',
    'div[class*="cursor-pointer"][class*="rounded-xl"]',
  ];
  for (const selector of projectCardSelectors) {
    const cards = page.locator(selector).filter({ hasText: /组\s*·|样品|个样品/ });
    const count = await cards.count().catch(() => 0);
    if (count > 0) {
      await cards.first().click().catch(() => {});
      await page.waitForTimeout(6000);
      body = await getBodyText(page);
      if (body.includes('属性编辑') && body.includes('预览')) {
        return true;
      }
    }
  }

  return false;
}

async function waitForPreviewReady(page, timeoutMs = 90000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const body = await getBodyText(page);
    const rendering = body.includes('正在重新渲染当前图形') || body.includes('等待 Python 渲染结果') || body.includes('正在恢复项目预览');
    const textCount = await page.locator('svg text').count().catch(() => 0);
    if (!rendering && textCount > 0) {
      return true;
    }
    await page.waitForTimeout(1000);
  }
  return false;
}

async function selectFirstSvgText(page) {
  const count = await page.locator('svg text').count().catch(() => 0);
  for (let i = 0; i < Math.min(count, 20); i += 1) {
    const target = page.locator('svg text').nth(i);
    const visible = await target.isVisible().catch(() => false);
    if (!visible) continue;
    const box = await target.boundingBox().catch(() => null);
    if (!box || box.width <= 0 || box.height <= 0) continue;
    await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
    await page.waitForTimeout(500);
    const body = await getBodyText(page);
    if (!body.includes('未选择任何对象')) {
      return true;
    }
  }
  return false;
}

async function findRightPanelInput(page, labelText) {
  return page.evaluateHandle((label) => {
    const normalize = (value) => String(value || '').replace(/\s+/g, '');
    const isVisible = (node) => {
      const rect = node.getBoundingClientRect();
      const style = window.getComputedStyle(node);
      return rect.width > 0 && rect.height > 0 && style.visibility !== 'hidden' && style.display !== 'none';
    };
    const isInRightSidebar = (node) => {
      const rect = node.getBoundingClientRect();
      return rect.left > window.innerWidth * 0.72;
    };
    const nodes = Array.from(document.querySelectorAll('span, label, div, p'));
    const labelNode = nodes
      .filter((node) => (
      isVisible(node) &&
      isInRightSidebar(node) &&
      normalize(node.textContent).includes(normalize(label))
      ))
      .sort((a, b) => a.getBoundingClientRect().top - b.getBoundingClientRect().top)[0];
    const rightControls = () => Array.from(document.querySelectorAll('input, textarea, select'))
      .filter((candidate) => (
        isVisible(candidate) &&
        isInRightSidebar(candidate) &&
        !candidate.disabled &&
        candidate.getAttribute('type') !== 'hidden'
      ));

    const normalizedLabel = normalize(label);
    const directControls = rightControls();
    if (normalizedLabel.includes('文字内容')) return directControls[0] || null;
    if (normalizedLabel.includes('字号')) return directControls[1] || null;
    if (!labelNode) return null;

    const labelRect = labelNode.getBoundingClientRect();
    const controls = rightControls()
      .map((candidate) => {
        const rect = candidate.getBoundingClientRect();
        const verticalDistance = Math.abs((rect.top + rect.height / 2) - (labelRect.top + labelRect.height / 2));
        const rowPenalty = rect.top < labelRect.top - 8 ? 1000 : 0;
        const leftPenalty = rect.left < labelRect.left ? 100 : 0;
        return { candidate, score: verticalDistance + rowPenalty + leftPenalty };
      })
      .sort((a, b) => a.score - b.score);

    return controls[0]?.candidate || null;
  }, labelText);
}

async function fillLabeledInput(page, labelText, value) {
  const handle = await findRightPanelInput(page, labelText);
  const element = handle.asElement();
  if (!element) {
    return false;
  }
  try {
    await element.scrollIntoViewIfNeeded({ timeout: 3000 }).catch(() => {});
    await element.fill(String(value), { timeout: 5000 });
    await element.press('Enter', { timeout: 2000 }).catch(() => {});
    await element.evaluate((node) => node.blur());
    return true;
  } catch {
    return false;
  }
}

async function fillRightColorHex(page, value) {
  const handle = await page.evaluateHandle(() => {
    const isVisible = (node) => {
      const rect = node.getBoundingClientRect();
      const style = window.getComputedStyle(node);
      return rect.width > 0 && rect.height > 0 && style.visibility !== 'hidden' && style.display !== 'none';
    };
    const isInRightSidebar = (node) => {
      const rect = node.getBoundingClientRect();
      return rect.left > window.innerWidth * 0.72;
    };
    return Array.from(document.querySelectorAll('input[type="text"]'))
      .find((candidate) => (
        isVisible(candidate) &&
        isInRightSidebar(candidate) &&
        !candidate.disabled &&
        /^#[0-9a-fA-F]{6}$/.test(candidate.value || '')
      )) || null;
  });
  const element = handle.asElement();
  if (!element) return false;
  try {
    await element.scrollIntoViewIfNeeded({ timeout: 3000 }).catch(() => {});
    await element.fill(value, { timeout: 5000 });
    await element.press('Enter', { timeout: 2000 }).catch(() => {});
    await element.evaluate((node) => node.blur());
    return true;
  } catch {
    return false;
  }
}

async function snapshotRightControls(page) {
  return page.evaluate(() => Array.from(document.querySelectorAll('input, textarea, select')).map((node) => {
    const rect = node.getBoundingClientRect();
    const style = window.getComputedStyle(node);
    return {
      tag: node.tagName,
      type: node.getAttribute('type') || '',
      value: node.value || '',
      placeholder: node.getAttribute('placeholder') || '',
      disabled: Boolean(node.disabled),
      display: style.display,
      visibility: style.visibility,
      rect: {
        left: Math.round(rect.left),
        top: Math.round(rect.top),
        width: Math.round(rect.width),
        height: Math.round(rect.height),
      },
      rightSide: rect.left > window.innerWidth * 0.72,
    };
  }).filter((item) => item.rightSide));
}

function interestingApi(request) {
  const url = request.url();
  if (!url.includes('/api/')) return false;
  return (
    url.includes('/api/figure') ||
    url.includes('/api/projects') ||
    url.includes('/api/export')
  );
}

function isPatchOrRender(request) {
  const url = request.url();
  return (
    url.includes('/api/figure/render') ||
    url.includes('/api/figure/patch') ||
    url.includes('/api/figure/code-patch') ||
    url.includes('/api/projects/') && url.includes('/figures/render')
  );
}

function parseJson(value) {
  if (!value) return null;
  try {
    return JSON.parse(value);
  } catch {
    return null;
  }
}

async function waitForApiSettle(page, startIndex, timeoutMs = 15000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    await page.waitForTimeout(400);
    const recent = apiResponses.slice(startIndex);
    const pendingCount = apiRequests.slice(startIndex).length - recent.length;
    if (pendingCount <= 0 && recent.length > 0) return recent;
  }
  return apiResponses.slice(startIndex);
}

async function waitForRequestAfter(startIndex, timeoutMs = 10000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (apiRequests.length > startIndex) return true;
    await new Promise((resolve) => setTimeout(resolve, 150));
  }
  return false;
}

async function applyCurrentDraft(page, id) {
  const applyStart = apiRequests.length;
  const applyClicked = await clickVisibleText(page, '应用当前图', 3000);
  if (!applyClicked) {
    record(id, 'FAIL', '暂存后没有找到“应用当前图”按钮');
    return { patchRequests: [], successful: false, draftCleared: false };
  }
  const responses = await waitForApiSettle(page, applyStart, 30000);
  await waitForPreviewReady(page, 90000);
  await page.waitForTimeout(500);
  const patchRequests = apiRequests.slice(applyStart).filter((r) => isPatchOrRender({ url: () => r.url }));
  const successful = responses.some((r) => r.status >= 200 && r.status < 300);
  const bodyAfterApply = await getBodyText(page);
  const draftCleared = !bodyAfterApply.includes('已暂存');
  return { patchRequests, successful, draftCleared };
}

async function applyCurrentDraftNoWait(page) {
  const applyStart = apiRequests.length;
  const applyClicked = await clickVisibleText(page, '应用当前图', 3000);
  return { applyStart, applyClicked };
}

async function readSvgTextContent(page) {
  return page.evaluate(() => Array.from(document.querySelectorAll('svg text'))
    .map((node) => node.textContent || '')
    .join('\n'));
}

async function getSelectedObjectLabel(page) {
  return page.evaluate(() => {
    const text = document.body.innerText || '';
    const match = text.match(/选中对象[:：]\s*([^\n]+)/);
    return match?.[1]?.trim() || '';
  }).catch(() => '');
}

async function findDraggableTextBox(page) {
  return page.evaluate(() => {
    const candidates = Array.from(document.querySelectorAll('svg [id], svg [data-fig-id]'))
      .map((node) => {
        const id = node.id || node.getAttribute('data-fig-id') || '';
        const text = node.textContent || '';
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
      .filter((item) => (
        item.id &&
        item.width > 2 &&
        item.height > 2 &&
        /^(r\.text|text|title|xlabel|ylabel|legend_text|legend_title|fig_text)\./.test(item.id)
      ))
      .sort((a, b) => {
        const aDrag = a.text.includes('DRAG_ME') ? -1 : 0;
        const bDrag = b.text.includes('DRAG_ME') ? -1 : 0;
        return aDrag - bDrag;
      });
    return candidates[0] || null;
  });
}

async function ensureDragMode(page, enabled) {
  const button = page.getByRole('button', { name: /拖拽微调/ }).first();
  if (!(await button.isVisible({ timeout: 3000 }).catch(() => false))) {
    return false;
  }
  const text = (await button.textContent().catch(() => '')) || '';
  const isEnabled = text.includes('开');
  if (isEnabled !== enabled) {
    await button.click();
    await page.waitForTimeout(500);
  }
  const nextText = (await button.textContent().catch(() => '')) || '';
  return enabled ? nextText.includes('开') : nextText.includes('关');
}

async function dragTextAndWaitForConfirm(page, box, dx = 90, dy = 30) {
  await page.mouse.move(box.x, box.y);
  await page.mouse.down();
  await page.mouse.move(box.x + dx, box.y + dy, { steps: 10 });
  await page.waitForTimeout(150);
  await page.mouse.up();
  await page.waitForTimeout(800);
  const body = await getBodyText(page);
  return body.includes('确认位置') && body.includes('已累计移动');
}

async function prepareDragFixtureProject(page) {
  const fixture = await page.evaluate(async ({ baseUrl }) => {
    const script = [
      'import matplotlib.pyplot as plt',
      'fig, ax = plt.subplots(figsize=(5, 3))',
      'ax.plot([0, 1, 2], [1, 3, 2], color="#336699")',
      'ax.set_title("Drag Smoke Figure")',
      'ax.set_xlabel("X Axis")',
      'ax.set_ylabel("Y Axis")',
      'ax.text(0.5, 0.65, "DRAG_ME", transform=ax.transAxes, ha="center", va="center", fontsize=14)',
      'fig.tight_layout()',
      'fig2, ax2 = plt.subplots(figsize=(5, 3))',
      'ax2.scatter([0, 1, 2], [2, 1, 3], color="#8b5e34")',
      'ax2.set_title("Second Smoke Figure")',
      'ax2.set_xlabel("Second X")',
      'ax2.set_ylabel("Second Y")',
      'fig2.tight_layout()',
    ].join('\n');
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
      body: JSON.stringify({ name: `Drag smoke ${Date.now()}`, spec }),
    });
    const created = await createRes.json();
    if (created.status !== 'success') throw new Error(created.message || 'create project failed');
    const renderRes = await fetch(`${baseUrl}/api/projects/${created.id}/figures/render`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ script, editLogs: {}, language: 'python', requestId: `drag-fixture-${Date.now()}` }),
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
      projectName: 'Drag smoke fixture',
      projectFigures,
      activeFigureId: 'fig_1',
      datasets: [],
      selectedGids: [],
      projectHistory: {},
      figSession: null,
      renderLog: ['> Drag smoke fixture ready'],
      currentView: 'workspace',
      subView: 'home',
    }));
    return {
      projectId: created.id,
      objectCount: rendered.figures[0]?.manifest?.objects?.length || 0,
      editablePositionCount: (rendered.figures[0]?.manifest?.objects || [])
        .filter((object) => Array.isArray(object.editable) && object.editable.includes('position')).length,
    };
  }, { baseUrl: BASE_URL });
  await page.reload({ waitUntil: 'networkidle', timeout: 30000 });
  await waitForPreviewReady(page, 90000);
  return fixture;
}

async function runDragFixtureCheck(page) {
  await clickVisibleText(page, '属性编辑', 3000);
  await waitForPreviewReady(page, 90000);
  const fixture = await prepareDragFixtureProject(page);
  diagnostics.dragFixture = fixture;
  await clickVisibleText(page, '属性编辑', 3000);
  await waitForPreviewReady(page, 90000);
  const dragModeOff = await ensureDragMode(page, false);
  const dragCandidate = await findDraggableTextBox(page);
  if (!dragCandidate) {
    record('K1', 'BLOCKED', '当前项目未找到可拖拽文本对象');
    record('K2', 'BLOCKED', '当前项目未找到可拖拽文本对象');
    return;
  }

  await page.mouse.click(dragCandidate.x, dragCandidate.y);
  await page.waitForTimeout(600);
  const selectedBody = await getBodyText(page);
  const selectionActive = !selectedBody.includes('未选择任何对象');
  record(
    'K1',
    dragModeOff && selectionActive ? 'PASS' : 'FAIL',
    `dragModeOff=${dragModeOff}, selectionActive=${selectionActive}, candidate=${dragCandidate.id}`,
  );

  const dragModeOn = await ensureDragMode(page, true);
  const dragHadConfirm = dragModeOn
    ? await dragTextAndWaitForConfirm(page, dragCandidate)
    : false;
  const confirmStart = apiRequests.length;
  const confirmed = dragHadConfirm && await clickVisibleText(page, '确认位置', 3000);
  if (confirmed) {
    await waitForApiSettle(page, confirmStart, 30000);
    await waitForPreviewReady(page, 90000);
  }
  const dragPatchRequests = apiRequests.slice(confirmStart).filter((r) => r.url.includes('/api/figure/patch'));
  const dragPatchBody = parseJson(dragPatchRequests[0]?.postData);
  const positionPatchCount = Array.isArray(dragPatchBody?.patches)
    ? dragPatchBody.patches.filter((patch) => patch?.prop === 'position').length
    : 0;
  const undoAfterDrag = page.getByRole('button', { name: /撤销/ }).first();
  const undoReadyAfterDrag = await undoAfterDrag.isVisible({ timeout: 3000 }).catch(() => false)
    && !(await undoAfterDrag.isDisabled().catch(() => true));
  record(
    'K2',
    dragModeOn && dragHadConfirm && confirmed && dragPatchRequests.length === 1 && positionPatchCount >= 1 && undoReadyAfterDrag ? 'PASS' : 'FAIL',
    `dragModeOn=${dragModeOn}, confirmBar=${dragHadConfirm}, confirmed=${confirmed}, patchRequests=${dragPatchRequests.length}, positionPatches=${positionPatchCount}, undoReady=${undoReadyAfterDrag}`,
  );
  await ensureDragMode(page, false);
}

async function chooseExportFormat(page, format) {
  const button = page.getByRole('button', { name: new RegExp(`^${format}$`, 'i') }).first();
  if (await button.isVisible({ timeout: 3000 }).catch(() => false)) {
    await button.click();
    await page.waitForTimeout(300);
    return true;
  }
  return false;
}

async function triggerProjectSvgExportAndReadResponse(page) {
  const responsePromise = page.waitForResponse(
    (response) => response.url().includes('/api/projects/') && response.url().endsWith('/export'),
    { timeout: 60000 },
  ).catch(() => null);
  const exportButtons = [
    page.getByRole('button', { name: /导出高质量图形/ }).first(),
    page.getByRole('button', { name: /导出当前|开始导出|导出 SVG/ }).first(),
  ];
  let clicked = false;
  for (const button of exportButtons) {
    if (await button.isVisible({ timeout: 3000 }).catch(() => false)) {
      await button.click();
      clicked = true;
      break;
    }
  }
  if (!clicked) return { clicked: false, data: null };
  const response = await responsePromise;
  if (!response) return { clicked: true, data: null };
  const data = await response.json().catch(() => null);
  return { clicked: true, data };
}

async function verifyRejectedProjectExportRollsBack(projectId, authToken) {
  if (process.env.SCIFIGURE_TEST_ISOLATED !== '1' || !process.env.SCIFIGURE_DB_PATH || !process.env.SCIFIGURE_DATA_DIR) {
    return { checked: false };
  }
  const database = new Database(process.env.SCIFIGURE_DB_PATH);
  const beforeAssets = database.prepare('SELECT COUNT(*) AS count FROM export_assets WHERE project_id = ?').get(projectId).count;
  const exportsDir = path.join(process.env.SCIFIGURE_DATA_DIR, 'projects', projectId, 'exports');
  const beforeFiles = fs.existsSync(exportsDir) ? fs.readdirSync(exportsDir).length : 0;
  const windowStartMs = Math.floor(Date.now() / 3_600_000) * 3_600_000;
  const windowStart = new Date(windowStartMs).toISOString();
  const configuredMb = Number(process.env.SCIFIGURE_GLOBAL_DOWNLOAD_MAX_MB_PER_HOUR || 512);
  const globalLimitBytes = Math.max(100, Number.isFinite(configuredMb) ? configuredMb : 512) * 1024 * 1024;
  database.prepare(`
    INSERT INTO global_usage_budgets (category, window_start, amount, updated_at)
    VALUES ('download_bytes', ?, ?, datetime('now'))
    ON CONFLICT(category, window_start) DO UPDATE SET amount = excluded.amount, updated_at = datetime('now')
  `).run(windowStart, globalLimitBytes);
  database.close();

  let response;
  try {
    response = await fetch(`${BASE_URL}/api/projects/${projectId}/export`, {
      method: 'POST',
      headers: bearerHeaders(authToken, { 'Content-Type': 'application/json' }),
      body: JSON.stringify({ figureId: 'fig_1', format: 'svg', dpi: 300, saveToLibrary: true }),
    });
  } finally {
    const cleanupDb = new Database(process.env.SCIFIGURE_DB_PATH);
    cleanupDb.prepare(`
      DELETE FROM global_usage_budgets
      WHERE category = 'download_bytes' AND window_start = ?
    `).run(windowStart);
    cleanupDb.close();
  }

  const verifyDb = new Database(process.env.SCIFIGURE_DB_PATH, { readonly: true });
  const afterAssets = verifyDb.prepare('SELECT COUNT(*) AS count FROM export_assets WHERE project_id = ?').get(projectId).count;
  verifyDb.close();
  const afterFiles = fs.existsSync(exportsDir) ? fs.readdirSync(exportsDir).length : 0;
  return { checked: true, status: response.status, beforeAssets, afterAssets, beforeFiles, afterFiles };
}

async function run() {
  fs.mkdirSync(OUTPUT_DIR, { recursive: true });
  const authToken = await authenticateCapabilitySmokeUser(BASE_URL, 'behavior-smoke');
  await cleanupSmokeProjects(authToken);

  const browser = await chromium.launch({ headless: true, args: ['--no-sandbox'] });
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  await installBrowserAuthentication(context, authToken);
  const page = await context.newPage();

  await page.route('**/api/figure/patch', async (route) => {
    if (delayNextPatchRequest) {
      delayNextPatchRequest = false;
      delayedPatchRequests += 1;
      await new Promise((resolve) => setTimeout(resolve, 4500));
    }
    await route.continue();
  });

  page.on('console', (msg) => {
    if (msg.type() === 'error') consoleErrors.push(msg.text());
  });
  page.on('pageerror', (err) => pageErrors.push(err.message));
  page.on('request', (request) => {
    if (interestingApi(request)) {
      apiRequests.push({ method: request.method(), url: request.url(), postData: request.postData() });
    }
  });
  page.on('response', async (response) => {
    const request = response.request();
    if (interestingApi(request)) {
      let json = null;
      if (request.url().includes('/api/figure/patch')) {
        json = await response.json().catch(() => null);
      }
      apiResponses.push({
        method: request.method(),
        url: request.url(),
        status: response.status(),
        postData: request.postData(),
        json,
      });
    }
  });

  try {
    await page.goto(BASE_URL, { waitUntil: 'networkidle', timeout: 30000 });
    diagnostics.initialFixture = await prepareDragFixtureProject(page);
    const loaded = await navigateToEditor(page);
    if (!loaded) {
      await screenshot(page, '01-editor-blocked');
      record('A1', 'BLOCKED', '无法进入编辑器页面');
      return;
    }

    const ready = await waitForPreviewReady(page);
    await screenshot(page, '01-editor');
    if (!ready) {
      record('A1', 'BLOCKED', '进入编辑器但等待预览 SVG 渲染完成超时');
      return;
    }

    const body = await getBodyText(page);
    const crashed = body.includes('Objects are not valid') || body.includes('编辑器出现异常');
    record('A1', crashed ? 'FAIL' : 'PASS', crashed ? '页面出现 React crash' : '编辑器加载且无 React crash');

    await clickVisibleText(page, '属性编辑', 3000);
    await page.waitForTimeout(500);
    await selectFirstSvgText(page);
    await page.waitForTimeout(500);

    const beforeDraftApiCount = apiRequests.filter((r) => isPatchOrRender({ url: () => r.url })).length;
    const uniqueText = `SMOKE_${Date.now()}`;
    const textEdited = await fillLabeledInput(page, '文字内容', uniqueText);
    const sizeEdited = await fillLabeledInput(page, '字号', '18');
    await page.waitForTimeout(1200);
    await screenshot(page, '02-after-draft-edits');

    if (!textEdited && !sizeEdited) {
      diagnostics.rightControls = await snapshotRightControls(page);
      record('C1', 'BLOCKED', '没有找到可编辑的文字内容或字号输入框');
    } else {
      const afterDraftApiCount = apiRequests.filter((r) => isPatchOrRender({ url: () => r.url })).length;
      const draftText = await getBodyText(page);
      const hasDraftBar = draftText.includes('已暂存');
      const noBackendBeforeApply = afterDraftApiCount === beforeDraftApiCount;
      record(
        'C1',
        hasDraftBar && noBackendBeforeApply ? 'PASS' : 'FAIL',
        `暂存条=${hasDraftBar}, 应用前后端请求增量=${afterDraftApiCount - beforeDraftApiCount}`,
      );
    }

    const firstApply = await applyCurrentDraft(page, 'C2');
    await screenshot(page, '03-after-apply');
    record(
      'C2',
      firstApply.patchRequests.length === 1 && firstApply.successful && firstApply.draftCleared ? 'PASS' : 'FAIL',
      `应用请求数=${firstApply.patchRequests.length}, 有成功响应=${firstApply.successful}, 暂存条清除=${firstApply.draftCleared}`,
      { requests: firstApply.patchRequests.map((r) => `${r.method} ${r.url}`) },
    );
    const firstPatchBody = parseJson(firstApply.patchRequests[0]?.postData);
    const firstPatchTargetsCurrentFigure = firstPatchBody?.figureId === 'fig_1';
    const firstPatchAvoidsProjectWideRender = firstApply.patchRequests.every((request) => !request.url.includes('/figures/render'));
    record(
      'E2',
      firstPatchTargetsCurrentFigure && firstPatchAvoidsProjectWideRender ? 'PASS' : 'FAIL',
      `figureId=${firstPatchBody?.figureId || 'missing'}, projectWideRender=${!firstPatchAvoidsProjectWideRender}`,
    );
    const firstPatchResponse = apiResponses
      .filter((r) => r.url.includes('/api/figure/patch') && parseJson(r.postData)?.requestId === firstPatchBody?.requestId)
      .at(-1);
    const hasCacheMeta = typeof firstPatchResponse?.json?.cache?.hit === 'boolean'
      && typeof firstPatchResponse?.json?.cache?.key === 'string'
      && firstPatchResponse.json.cache.key.length > 0;
    record(
      'E4',
      hasCacheMeta ? 'PASS' : 'FAIL',
      `cacheMeta=${hasCacheMeta}, hit=${firstPatchResponse?.json?.cache?.hit ?? 'missing'}`,
    );

    const undoButton = page.getByRole('button', { name: /撤销/ }).first();
    const undoVisible = await undoButton.isVisible({ timeout: 3000 }).catch(() => false);
    const undoDisabled = undoVisible ? await undoButton.isDisabled().catch(() => false) : true;
    record('D1', undoVisible && !undoDisabled ? 'PASS' : 'FAIL', `撤销可见=${undoVisible}, 撤销禁用=${undoDisabled}`);

    await selectFirstSvgText(page);
    await page.waitForTimeout(500);
    const colorDraftStart = apiRequests.filter((r) => isPatchOrRender({ url: () => r.url })).length;
    const colorEdited = await fillRightColorHex(page, '#123456');
    await page.waitForTimeout(800);
    const colorDraftText = await getBodyText(page);
    const colorHasDraft = colorDraftText.includes('已暂存');
    const colorDraftEnd = apiRequests.filter((r) => isPatchOrRender({ url: () => r.url })).length;
    if (!colorEdited) {
      record('H2', 'BLOCKED', '未找到右侧颜色 hex 输入框');
    } else if (!colorHasDraft || colorDraftEnd !== colorDraftStart) {
      record('H2', 'FAIL', `颜色暂存=${colorHasDraft}, 应用前请求增量=${colorDraftEnd - colorDraftStart}`);
    } else {
      const colorApply = await applyCurrentDraft(page, 'H2');
      const undoStart = apiRequests.length;
      const undoNow = page.getByRole('button', { name: /撤销/ }).first();
      const canUndoColor = await undoNow.isVisible({ timeout: 3000 }).catch(() => false)
        && !(await undoNow.isDisabled().catch(() => true));
      if (canUndoColor) {
        await undoNow.click();
        await waitForApiSettle(page, undoStart, 30000);
        await waitForPreviewReady(page, 90000);
      }
      const undoRequests = apiRequests.slice(undoStart).filter((r) => isPatchOrRender({ url: () => r.url }));
      record(
        'H2',
        colorApply.patchRequests.length === 1 && canUndoColor && undoRequests.length >= 1 ? 'PASS' : 'FAIL',
        `颜色应用请求=${colorApply.patchRequests.length}, 撤销可用=${canUndoColor}, 撤销重渲染请求=${undoRequests.length}`,
      );
    }

    await selectFirstSvgText(page);
    await page.waitForTimeout(500);
    const staleOld = `STALE_OLD_${Date.now()}`;
    const staleNew = `STALE_NEW_${Date.now()}`;
    const staleFirstEdited = await fillLabeledInput(page, '文字内容', staleOld);
    await page.waitForTimeout(500);
    delayNextPatchRequest = true;
    const firstStaleApply = await applyCurrentDraftNoWait(page);
    const firstRequestStarted = await waitForRequestAfter(firstStaleApply.applyStart, 8000);
    const staleSecondEdited = await fillLabeledInput(page, '文字内容', staleNew);
    await page.waitForTimeout(500);
    const secondStaleApply = await applyCurrentDraftNoWait(page);
    await waitForApiSettle(page, firstStaleApply.applyStart, 90000);
    await waitForPreviewReady(page, 90000);
    await page.waitForTimeout(1000);
    const stalePatchRequests = apiRequests.slice(firstStaleApply.applyStart)
      .filter((r) => isPatchOrRender({ url: () => r.url }));
    const finalSvgText = await readSvgTextContent(page);
    const finalHasNew = finalSvgText.includes(staleNew);
    const finalHasOld = finalSvgText.includes(staleOld);
    record(
      'E3',
      staleFirstEdited &&
        staleSecondEdited &&
        firstStaleApply.applyClicked &&
        secondStaleApply.applyClicked &&
        firstRequestStarted &&
        delayedPatchRequests >= 1 &&
        stalePatchRequests.length >= 2 &&
        finalHasNew &&
        !finalHasOld
        ? 'PASS'
        : 'FAIL',
      `firstEdited=${staleFirstEdited}, secondEdited=${staleSecondEdited}, firstReqStarted=${firstRequestStarted}, delayed=${delayedPatchRequests}, patchRequests=${stalePatchRequests.length}, finalHasNew=${finalHasNew}, finalHasOld=${finalHasOld}`,
    );

    const figureButtons = await page.getByRole('button', { name: /Figure\s+\d+/ }).count().catch(() => 0);
    record('E1', figureButtons > 1 ? 'PASS' : 'BLOCKED', `检测到 Figure 切换按钮=${figureButtons}`);

    await clickVisibleText(page, '属性编辑', 3000);
    await waitForPreviewReady(page, 90000);
    await selectFirstSvgText(page);
    await page.waitForTimeout(500);
    const exportUniqueText = `EXPORT_SMOKE_${Date.now()}`;
    const exportTextEdited = await fillLabeledInput(page, '文字内容', exportUniqueText);
    await page.waitForTimeout(800);
    const exportDraftReady = (await getBodyText(page)).includes('已暂存');
    const exportApply = exportTextEdited && exportDraftReady
      ? await applyCurrentDraft(page, 'L1-prep')
      : { patchRequests: [], successful: false, draftCleared: false };
    const exportSvgAfterApply = await readSvgTextContent(page);
    diagnostics.exportUniqueText = exportUniqueText;
    diagnostics.exportPrep = {
      exportTextEdited,
      exportDraftReady,
      applyRequests: exportApply.patchRequests.length,
      successful: exportApply.successful,
      previewHasUniqueText: exportSvgAfterApply.includes(exportUniqueText),
    };

    const exportButton = page.getByRole('button', { name: /^导出图形$/ }).first();
    const exportClicked = await exportButton.isVisible({ timeout: 3000 }).catch(() => false);
    if (exportClicked) await exportButton.click();
    const exportPageReady = await page.getByRole('heading', { name: '导出与出版设置' })
      .isVisible({ timeout: 5000 })
      .catch(() => false);
    const exportHasOptions = exportPageReady
      && await page.getByRole('button', { name: /^SVG$/ }).isVisible({ timeout: 3000 }).catch(() => false)
      && await page.locator('[data-export-dpi]').isVisible({ timeout: 3000 }).catch(() => false);
    if (exportClicked && exportHasOptions) {
      await chooseExportFormat(page, 'SVG');
      const exported = await triggerProjectSvgExportAndReadResponse(page);
      const exportedFigure = exported.data?.figures?.find((figure) => figure.figureId === 'fig_1') || exported.data?.figures?.[0];
      const exportedSvg = exportedFigure?.svg || '';
      const exportHasLatestText = exportedSvg.includes(exportUniqueText);
      record(
        'L1',
        exportApply.successful && exported.clicked && exported.data?.status === 'success' && exportHasLatestText ? 'PASS' : 'FAIL',
        `进入导出=${exportClicked}, 导出选项=${exportHasOptions}, exportClicked=${exported.clicked}, status=${exported.data?.status || 'none'}, svgHasLatestText=${exportHasLatestText}`,
      );
    } else {
      record('L1', 'FAIL', `进入导出=${exportClicked}, 导出选项=${exportHasOptions}`);
    }

    const rejectedExport = await verifyRejectedProjectExportRollsBack(diagnostics.initialFixture.projectId, authToken);
    if (rejectedExport.checked) {
      record(
        'L2',
        rejectedExport.status === 429
          && rejectedExport.beforeAssets === rejectedExport.afterAssets
          && rejectedExport.beforeFiles === rejectedExport.afterFiles
          ? 'PASS'
          : 'FAIL',
        `status=${rejectedExport.status}, assets=${rejectedExport.beforeAssets}->${rejectedExport.afterAssets}, files=${rejectedExport.beforeFiles}->${rejectedExport.afterFiles}`,
      );
    }

    await runDragFixtureCheck(page);

    if (consoleErrors.length > 0 || pageErrors.length > 0) {
      record('N1', 'FAIL', `Console/Page errors: ${consoleErrors.length}/${pageErrors.length}`);
    } else {
      record('N1', 'PASS', '全程无 console error / pageerror');
    }
  } finally {
    await browser.close();
    await cleanupSmokeProjects(authToken);
  }
}

function generateReport() {
  const passCount = results.filter((r) => r.status === 'PASS').length;
  const failCount = results.filter((r) => r.status === 'FAIL').length;
  const blockedCount = results.filter((r) => r.status === 'BLOCKED').length;
  const conclusion = failCount > 0 ? 'FAIL' : blockedCount > 0 ? 'PARTIAL' : 'PASS';
  const lines = [
    '# SciFigure Studio Strict Behavior Smoke Report',
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
    ...results.map((r) => `| ${r.id} | ${r.status} | ${String(r.note).replace(/\|/g, '\\|')} |`),
    '',
    '## API Requests',
    '',
    ...apiRequests.map((r, index) => `${index + 1}. ${r.method} ${r.url}`),
    '',
    '## Console Errors',
    '',
    ...(consoleErrors.length ? consoleErrors.map((e, index) => `${index + 1}. ${e}`) : ['None']),
    '',
    '## Page Errors',
    '',
    ...(pageErrors.length ? pageErrors.map((e, index) => `${index + 1}. ${e}`) : ['None']),
    '',
    '## Diagnostics',
    '',
    '```json',
    JSON.stringify(diagnostics, null, 2),
    '```',
  ];
  const report = lines.join('\n');
  const file = path.join(OUTPUT_DIR, 'report.md');
  fs.writeFileSync(file, report, 'utf-8');
  return { file, conclusion, passCount, failCount, blockedCount };
}

try {
  await run();
} catch (error) {
  record('HARNESS', 'FAIL', `测试脚本异常: ${error?.message || String(error)}`);
}
const report = generateReport();
console.log(`\nReport: ${report.file}`);
console.log(`Conclusion: ${report.conclusion}, PASS=${report.passCount}, FAIL=${report.failCount}, BLOCKED=${report.blockedCount}`);
