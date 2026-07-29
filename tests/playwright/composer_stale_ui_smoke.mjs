/**
 * Composer stale source UI browser smoke test.
 *
 * Verifies:
 * - Composer marks a panel stale when the source figure revision is newer than
 *   the exported asset revision.
 * - Re-exporting the source figure and refreshing/reloading the latest asset
 *   clears the stale badge.
 */

import { chromium } from 'playwright';
import * as fs from 'fs';
import * as path from 'path';
import { fileURLToPath } from 'url';
import { authenticateCapabilitySmokeUser, bearerHeaders, installBrowserAuthentication } from './smokeAuth.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '../..');
const BASE_URL = process.env.SCIFIGURE_URL || 'http://localhost:3000';
const RUN_ID = new Date().toISOString().replace(/[:.]/g, '-');
const OUTPUT_DIR = path.join(ROOT, 'output', 'playwright', `composer-stale-ui-${RUN_ID}`);

const results = [];
const apiRequests = [];
const consoleErrors = [];
const pageErrors = [];
const diagnostics = {};
let authToken = '';

const script = [
  'import matplotlib.pyplot as plt',
  'fig1, ax1 = plt.subplots(figsize=(4, 3))',
  'ax1.plot([0, 1, 2], [1, 3, 2], color="#336699")',
  'ax1.set_title("COMPOSER_STALE_FIG_ONE")',
  'ax1.set_xlabel("X One")',
  'ax1.set_ylabel("Y One")',
  'fig2, ax2 = plt.subplots(figsize=(4, 3))',
  'ax2.plot([0, 1, 2], [2, 1, 4], color="#993366")',
  'ax2.set_title("COMPOSER_STALE_FIG_TWO")',
  'ax2.set_xlabel("X Two")',
  'ax2.set_ylabel("Y Two")',
  'for fig in [fig1, fig2]:',
  '    fig.tight_layout()',
].join('\n');

function record(id, status, note) {
  results.push({ id, status, note });
  console.log(`${status} ${id}: ${note}`);
}

function isIgnorableDevServerNoise(message) {
  return message.includes('[vite] failed to connect to websocket')
    || /WebSocket connection to 'ws:\/\/(?:localhost|127\.0\.0\.1):24678\//.test(message)
    || message.includes('WebSocket closed without opened');
}

async function requestJson(pathname, options = {}) {
  const res = await fetch(`${BASE_URL}${pathname}`, {
    ...options,
    headers: {
      ...bearerHeaders(authToken, {
        'Content-Type': 'application/json',
        ...(options.headers || {}),
      }),
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
    .filter((project) => String(project?.name || '').startsWith('Composer stale UI smoke'))
    .map((project) => {
      const id = project.id || project.projectId;
      return id ? requestJson(`/api/projects/${id}`, { method: 'DELETE' }).catch(() => null) : null;
    }));
}

async function createFixture() {
  const spec = {
    plot_type: 'custom',
    custom_script: script,
    script,
    script_language: 'python',
    figure: { width: 120, height: 85, unit: 'mm', dpi: 300 },
  };
  const created = await requestJson('/api/projects', {
    method: 'POST',
    body: JSON.stringify({ name: `Composer stale UI smoke ${Date.now()}`, spec }),
  });
  const projectId = created.id;
  const rendered = await requestJson(`/api/projects/${projectId}/figures/render`, {
    method: 'POST',
    body: JSON.stringify({ script, editLogs: { fig_1: [], fig_2: [] }, language: 'python', requestId: `composer-stale-${Date.now()}` }),
  });
  if (rendered.status !== 'success') throw new Error(rendered.message || 'render failed');

  const firstExport = await requestJson(`/api/projects/${projectId}/export`, {
    method: 'POST',
    body: JSON.stringify({ figureId: 'fig_1', format: 'svg', dpi: 300, saveToLibrary: true }),
  });
  const secondExport = await requestJson(`/api/projects/${projectId}/export`, {
    method: 'POST',
    body: JSON.stringify({ figureId: 'fig_2', format: 'svg', dpi: 300, saveToLibrary: true }),
  });
  const fig1Asset = firstExport.figures?.[0]?.asset;
  const fig2Asset = secondExport.figures?.[0]?.asset;
  if (!fig1Asset?.assetId || !fig2Asset?.assetId) throw new Error('initial export assets missing');

  const patch = await requestJson('/api/figure/patch', {
    method: 'POST',
    body: JSON.stringify({
      sessionId: `${projectId}_fig_1`,
      projectId,
      figureId: 'fig_1',
      baseRevision: 1,
      patches: [
        { op: 'set', mode: 'backend_patch', gid: 'title.0', prop: 'text', value: 'COMPOSER_STALE_FIG_ONE_UPDATED' },
      ],
      requestId: `composer-stale-patch-${Date.now()}`,
    }),
  });
  if (patch.status !== 'success') throw new Error(patch.message || 'patch fig_1 failed');

  return { projectId, spec, rendered, fig1Asset, fig2Asset, patchedRevision: patch.revision };
}

async function setComposerState(page, fixture) {
  await page.evaluate(({ fixture }) => {
    window.sessionStorage.setItem('scifigure:app-state:v2', JSON.stringify({
      spec: fixture.spec,
      history: [fixture.spec],
      historyIndex: 0,
      projectId: fixture.projectId,
      projectName: 'Composer stale UI smoke',
      projectFigures: {},
      activeFigureId: 'fig_1',
      datasets: [],
      selectedGids: [],
      projectHistory: {},
      currentView: 'composer',
      subView: 'composer',
      renderLog: ['> Composer stale UI fixture ready'],
      figSession: null,
    }));
  }, { fixture });
}

async function clickText(page, text, timeout = 5000) {
  const candidates = [
    page.getByRole('button', { name: new RegExp(text) }).first(),
    page.getByText(new RegExp(text)).first(),
  ];
  for (const locator of candidates) {
    if (await locator.isVisible({ timeout }).catch(() => false)) {
      await locator.click();
      await page.waitForTimeout(500);
      return true;
    }
  }
  return false;
}

async function waitForComposerAssets(page, minCount = 2, timeoutMs = 60000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const body = (await page.textContent('body').catch(() => '')) || '';
    const countMatch = body.match(/单图素材 \((\d+)\)/);
    const count = countMatch ? Number(countMatch[1]) : 0;
    if (body.includes('图库与拼图') && count >= minCount) return true;
    await page.waitForTimeout(600);
  }
  return false;
}

async function startTwoPanelLayout(page) {
  const clickedTemplate = await clickText(page, '左右双栏', 5000);
  if (clickedTemplate) return true;
  const selectedFirst = await page.locator('button').filter({ hasText: /fig_1|fig_2/ }).nth(0).click().then(() => true).catch(() => false);
  const selectedSecond = await page.locator('button').filter({ hasText: /fig_1|fig_2/ }).nth(1).click().then(() => true).catch(() => false);
  const started = await clickText(page, '用选中图片开始排版', 5000);
  return selectedFirst && selectedSecond && started;
}

async function run() {
  fs.mkdirSync(OUTPUT_DIR, { recursive: true });
  authToken = await authenticateCapabilitySmokeUser(BASE_URL, 'composer-stale-ui');
  await cleanupSmokeProjects();

  const browser = await chromium.launch({ headless: true, args: ['--no-sandbox'] });
  const context = await browser.newContext({ viewport: { width: 1500, height: 950 } });
  await installBrowserAuthentication(context, authToken);
  const page = await context.newPage();
  const dialogs = [];

  page.on('console', (msg) => {
    if (msg.type() === 'error' && !isIgnorableDevServerNoise(msg.text())) consoleErrors.push(msg.text());
  });
  page.on('pageerror', (err) => {
    if (!isIgnorableDevServerNoise(err.message)) pageErrors.push(err.message);
  });
  page.on('request', (request) => {
    const url = request.url();
    if (url.includes('/api/projects') || url.includes('/api/figure')) {
      apiRequests.push({ method: request.method(), url, postData: request.postData() });
    }
  });
  page.on('dialog', async (dialog) => {
    dialogs.push(dialog.message());
    await dialog.accept();
  });

  let projectId = null;
  try {
    const fixture = await createFixture();
    projectId = fixture.projectId;
    diagnostics.fixture = fixture;

    await page.goto(BASE_URL, { waitUntil: 'networkidle', timeout: 30000 });
    await setComposerState(page, fixture);
    await page.reload({ waitUntil: 'networkidle', timeout: 30000 });
    const assetsReady = await waitForComposerAssets(page, 2);
    const layoutStarted = assetsReady ? await startTwoPanelLayout(page) : false;
    await page.waitForTimeout(1200);
    const staleBadgeCount = await page.getByText('源图已更新').count().catch(() => 0);
    const staleBadgeVisible = staleBadgeCount > 0;
    record(
      'C1-stale-badge',
      assetsReady && layoutStarted && staleBadgeVisible ? 'PASS' : 'FAIL',
      `assetsReady=${assetsReady}, layoutStarted=${layoutStarted}, staleBadgeCount=${staleBadgeCount}, patchedRevision=${fixture.patchedRevision}`,
    );

    if (staleBadgeVisible) {
      await page.locator('[data-testid="composer-stale-badge"]').first().click({ force: true });
      await page.waitForTimeout(300);
    }
    const staleDialogOk = dialogs.some((message) => message.includes('当前版本 v2') && message.includes('导出资产版本 v1'));
    record('C2-stale-dialog', staleDialogOk ? 'PASS' : 'FAIL', JSON.stringify(dialogs));

    const reexport = await requestJson(`/api/projects/${projectId}/export`, {
      method: 'POST',
      body: JSON.stringify({ figureId: 'fig_1', format: 'svg', dpi: 300, saveToLibrary: true }),
    });
    const freshAsset = reexport.figures?.[0]?.asset;
    diagnostics.freshAsset = freshAsset;
    const freshAssetOk = freshAsset?.figureId === 'fig_1' && freshAsset?.metadata?.revision === fixture.patchedRevision;
    await clickText(page, '刷新', 5000);
    await waitForComposerAssets(page, 3);
    await startTwoPanelLayout(page);
    await page.waitForTimeout(1200);
    const staleAfterRefresh = await page.getByText('源图已更新').count().catch(() => 0);
    record(
      'C3-refresh-clears-stale',
      freshAssetOk && staleAfterRefresh === 0 ? 'PASS' : 'FAIL',
      `freshAssetOk=${freshAssetOk}, freshRevision=${freshAsset?.metadata?.revision}, staleAfterRefresh=${staleAfterRefresh}`,
    );

    record(
      'N1',
      consoleErrors.length === 0 && pageErrors.length === 0 ? 'PASS' : 'FAIL',
      `consoleErrors=${consoleErrors.length}, pageErrors=${pageErrors.length}`,
    );
  } finally {
    await browser.close();
    if (projectId) await requestJson(`/api/projects/${projectId}`, { method: 'DELETE' }).catch(() => null);
  }
}

function generateReport() {
  const passCount = results.filter((result) => result.status === 'PASS').length;
  const failCount = results.filter((result) => result.status === 'FAIL').length;
  const blockedCount = results.filter((result) => result.status === 'BLOCKED').length;
  const conclusion = failCount > 0 ? 'FAIL' : blockedCount > 0 ? 'PARTIAL' : 'PASS';
  const lines = [
    '# Composer Stale UI Smoke Report',
    '',
    `Run: ${RUN_ID}`,
    `Conclusion: ${conclusion}, PASS=${passCount}, FAIL=${failCount}, BLOCKED=${blockedCount}`,
    '',
    '| ID | Status | Note |',
    '|---|---|---|',
    ...results.map((result) => `| ${result.id} | ${result.status} | ${String(result.note).replace(/\|/g, '\\|')} |`),
    '',
    '## Diagnostics',
    '',
    '```json',
    JSON.stringify({ diagnostics, apiRequests, consoleErrors, pageErrors }, null, 2),
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
if (report.conclusion !== 'PASS') process.exitCode = 1;
