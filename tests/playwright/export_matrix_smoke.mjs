/**
 * SciFigure Studio export matrix smoke test.
 *
 * Verifies:
 * - Project export supports SVG/PNG/PDF/TIFF for a selected figure.
 * - Selected figure export does not leak another figure's SVG content.
 * - Exported assets preserve figureId/format metadata.
 * - Project-wide SVG export returns all figures.
 * - Browser export is blocked while project render is pending.
 *
 * Prerequisite:
 *   The app is running at http://localhost:3000.
 */

import { chromium } from 'playwright';
import * as fs from 'fs';
import * as path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '../..');
const BASE_URL = process.env.SCIFIGURE_URL || 'http://localhost:3000';
const RUN_ID = new Date().toISOString().replace(/[:.]/g, '-');
const OUTPUT_DIR = path.join(ROOT, 'output', 'playwright', `export-matrix-${RUN_ID}`);

const results = [];
const apiRequests = [];
const consoleErrors = [];
const pageErrors = [];
const diagnostics = {};

const script = [
  'import matplotlib.pyplot as plt',
  'fig1, ax1 = plt.subplots(figsize=(4, 3))',
  'ax1.plot([0, 1, 2], [1, 3, 2], color="#336699", label="one")',
  'ax1.set_title("EXPORT_MATRIX_FIG_ONE")',
  'ax1.set_xlabel("X One")',
  'ax1.set_ylabel("Y One")',
  'ax1.legend(loc="upper left")',
  'fig2, ax2 = plt.subplots(figsize=(4, 3))',
  'ax2.plot([0, 1, 2], [2, 1, 4], color="#993366", label="two")',
  'ax2.set_title("EXPORT_MATRIX_FIG_TWO")',
  'ax2.set_xlabel("X Two")',
  'ax2.set_ylabel("Y Two")',
  'ax2.legend(loc="upper left")',
  'for fig in [fig1, fig2]:',
  '    fig.tight_layout()',
].join('\n');

function record(id, status, note) {
  results.push({ id, status, note });
  console.log(`${status} ${id}: ${note}`);
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
    .filter((project) => String(project?.name || '').startsWith('Export matrix smoke'))
    .map((project) => {
      const id = project.id || project.projectId;
      return id ? requestJson(`/api/projects/${id}`, { method: 'DELETE' }).catch(() => null) : null;
    }));
}

function interestingApi(request) {
  const url = request.url();
  return url.includes('/api/figure') || url.includes('/api/projects');
}

function bufferMagic(format, binaryB64) {
  if (!binaryB64) return false;
  const buf = Buffer.from(binaryB64, 'base64');
  if (format === 'png') return buf.length > 8 && buf.subarray(0, 4).toString('hex') === '89504e47';
  if (format === 'pdf') return buf.length > 8 && buf.subarray(0, 4).toString('ascii') === '%PDF';
  if (format === 'tiff') {
    const le = buf.subarray(0, 4).toString('hex') === '49492a00';
    const be = buf.subarray(0, 4).toString('hex') === '4d4d002a';
    return buf.length > 8 && (le || be);
  }
  return false;
}

async function createProjectAndRender() {
  const spec = {
    plot_type: 'custom',
    custom_script: script,
    script,
    script_language: 'python',
    figure: { width: 120, height: 85, unit: 'mm', dpi: 300 },
    export: { format: 'SVG', dpi: 300, color_mode: 'RGB', embed_fonts: true },
  };
  const created = await requestJson('/api/projects', {
    method: 'POST',
    body: JSON.stringify({ name: `Export matrix smoke ${Date.now()}`, spec }),
  });
  if (created.status !== 'success') throw new Error(created.message || 'create project failed');
  const rendered = await requestJson(`/api/projects/${created.id}/figures/render`, {
    method: 'POST',
    body: JSON.stringify({ script, editLogs: { fig_1: [], fig_2: [] }, language: 'python', requestId: `export-matrix-${Date.now()}` }),
  });
  if (rendered.status !== 'success') throw new Error(rendered.message || 'render failed');
  return { projectId: created.id, spec, rendered };
}

async function runApiExportMatrix(projectId) {
  const formats = ['svg', 'png', 'pdf', 'tiff'];
  const matrix = {};
  for (const format of formats) {
    const data = await requestJson(`/api/projects/${projectId}/export`, {
      method: 'POST',
      body: JSON.stringify({ figureId: 'fig_2', format, dpi: 300, saveToLibrary: true }),
    });
    const figure = Array.isArray(data.figures) ? data.figures[0] : null;
    const svg = figure?.svg || '';
    const hasOnlyFig2Svg = svg.includes('EXPORT_MATRIX_FIG_TWO') && !svg.includes('EXPORT_MATRIX_FIG_ONE');
    const formatOk = format === 'svg'
      ? figure?.format === 'svg' && !figure?.binary_b64
      : figure?.format === format && bufferMagic(format, figure?.binary_b64);
    const assetOk = figure?.asset?.figureId === 'fig_2'
      && figure?.asset?.format === figure?.format
      && figure?.asset?.metadata?.exportedFrom === 'fig_2'
      && figure?.asset?.metadata?.requestedFormat === format;
    matrix[format] = {
      status: data.status,
      figureId: figure?.figureId,
      format: figure?.format,
      hasOnlyFig2Svg,
      hasBinary: Boolean(figure?.binary_b64),
      assetId: figure?.asset?.assetId,
      assetOk,
      formatOk,
    };
    record(
      `X1-${format}`,
      data.status === 'success' && data.figures?.length === 1 && figure?.figureId === 'fig_2' && hasOnlyFig2Svg && formatOk && assetOk ? 'PASS' : 'FAIL',
      JSON.stringify(matrix[format]),
    );
  }

  const allSvg = await requestJson(`/api/projects/${projectId}/export`, {
    method: 'POST',
    body: JSON.stringify({ format: 'svg', dpi: 300, saveToLibrary: false }),
  });
  const ids = Array.isArray(allSvg.figures) ? allSvg.figures.map((fig) => fig.figureId).sort() : [];
  const allHasBoth = allSvg.figures?.some((fig) => (fig.svg || '').includes('EXPORT_MATRIX_FIG_ONE'))
    && allSvg.figures?.some((fig) => (fig.svg || '').includes('EXPORT_MATRIX_FIG_TWO'));
  record(
    'X2-all-svg',
    allSvg.status === 'success' && ids.join(',') === 'fig_1,fig_2' && allHasBoth ? 'PASS' : 'FAIL',
    `ids=${JSON.stringify(ids)}, allHasBoth=${Boolean(allHasBoth)}`,
  );

  const assets = await requestJson(`/api/projects/${projectId}/export-assets`);
  const exportedFormats = new Set((assets.assets || []).filter((asset) => asset.figureId === 'fig_2').map((asset) => asset.format));
  const assetSizesOk = (assets.assets || [])
    .filter((asset) => asset.figureId === 'fig_2')
    .every((asset) => typeof asset.sizeBytes === 'number' && asset.sizeBytes > 0 && asset.downloadUrl);
  record(
    'X3-assets',
    ['svg', 'png', 'pdf', 'tiff'].every((fmt) => exportedFormats.has(fmt)) && assetSizesOk ? 'PASS' : 'FAIL',
    `formats=${JSON.stringify(Array.from(exportedFormats).sort())}, assetSizesOk=${assetSizesOk}`,
  );

  diagnostics.matrix = matrix;
  diagnostics.assets = assets.assets;
}

async function getBodyText(page) {
  return (await page.textContent('body').catch(() => '')) || '';
}

async function waitForPreviewReady(page, timeoutMs = 90000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const body = await getBodyText(page);
    const rendering = body.includes('等待 Python 渲染结果') || body.includes('正在恢复项目预览');
    const svgCount = await page.locator('svg').count().catch(() => 0);
    if (!rendering && svgCount > 0 && body.includes('属性编辑')) return true;
    await page.waitForTimeout(600);
  }
  return false;
}

async function clickText(page, text, timeout = 5000) {
  const candidates = [
    page.getByRole('button', { name: new RegExp(text) }).first(),
    page.getByText(new RegExp(text)).first(),
  ];
  for (const locator of candidates) {
    if (await locator.isVisible({ timeout }).catch(() => false)) {
      await locator.click();
      await page.waitForTimeout(300);
      return true;
    }
  }
  return false;
}

async function setAppState(page, projectId, spec, rendered, currentView = 'workspace') {
  await page.evaluate(({ projectId, spec, rendered, currentView }) => {
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
      projectName: 'Export matrix smoke',
      projectFigures,
      activeFigureId: 'fig_2',
      datasets: [],
      selectedGids: [],
      projectHistory: {},
      currentView,
      subView: 'home',
      renderLog: ['> Export matrix fixture ready'],
      figSession: null,
    }));
  }, { projectId, spec, rendered, currentView });
}

async function runPendingExportBrowserCheck(projectId, spec, rendered) {
  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage({ viewport: { width: 1440, height: 950 } });
  const dialogs = [];
  let releaseRender;
  const renderHold = new Promise((resolve) => { releaseRender = resolve; });

  page.on('console', (msg) => {
    if (msg.type() === 'error' && !isIgnorableDevServerNoise(msg.text())) consoleErrors.push(msg.text());
  });
  page.on('pageerror', (err) => {
    if (!isIgnorableDevServerNoise(err.message)) pageErrors.push(err.message);
  });
  page.on('request', (request) => {
    if (interestingApi(request)) {
      apiRequests.push({ url: request.url(), method: request.method(), postData: request.postData() });
    }
  });
  page.on('dialog', async (dialog) => {
    dialogs.push(dialog.message());
    await dialog.accept();
  });

  try {
    await page.route(`**/api/projects/${projectId}/figures/render`, async (route) => {
      await renderHold;
      await route.continue();
    });

    await page.goto(BASE_URL, { waitUntil: 'networkidle', timeout: 60000 });
    await setAppState(page, projectId, spec, rendered, 'editor');
    await page.reload({ waitUntil: 'networkidle', timeout: 30000 });
    await waitForPreviewReady(page);

    const renderClicked = await clickText(page, '同步至引擎并预览 SVG', 5000);
    await page.waitForTimeout(800);
    const exportNavClicked = await clickText(page, '导出图形', 3000) || await clickText(page, '导出', 3000);
    await page.waitForTimeout(800);
    const beforeExportRequests = apiRequests.length;
    const exportClicked = await clickText(page, '导出高质量图形', 5000);
    await page.waitForTimeout(1000);
    const exportRequests = apiRequests.slice(beforeExportRequests).filter((req) => req.url.endsWith('/export'));
    const body = await getBodyText(page);
    const alertBlocked = dialogs.some((message) => message.includes('后台引擎正在渲染中'));
    const disabledOrBlocked = alertBlocked || body.includes('后台引擎正在渲染中');

    record(
      'X4-pending-block',
      renderClicked && exportNavClicked && exportClicked && exportRequests.length === 0 && disabledOrBlocked ? 'PASS' : 'FAIL',
      `renderClicked=${renderClicked}, exportNav=${exportNavClicked}, exportClicked=${exportClicked}, exportRequests=${exportRequests.length}, dialogs=${JSON.stringify(dialogs)}`,
    );

    releaseRender();
    await page.waitForTimeout(1000);
  } finally {
    if (releaseRender) releaseRender();
    await browser.close();
  }
}

async function run() {
  fs.mkdirSync(OUTPUT_DIR, { recursive: true });
  await cleanupSmokeProjects();

  let projectId = null;
  try {
    const fixture = await createProjectAndRender();
    projectId = fixture.projectId;
    diagnostics.fixture = {
      projectId,
      figureCount: fixture.rendered.figures?.length,
      figureIds: fixture.rendered.figures?.map((fig) => fig.figureId),
    };
    record(
      'X0-fixture',
      fixture.rendered.figures?.length === 2 ? 'PASS' : 'FAIL',
      JSON.stringify(diagnostics.fixture),
    );

    await runApiExportMatrix(projectId);
    await runPendingExportBrowserCheck(projectId, fixture.spec, fixture.rendered);

    record(
      'N1',
      consoleErrors.length === 0 && pageErrors.length === 0 ? 'PASS' : 'FAIL',
      `consoleErrors=${consoleErrors.length}, pageErrors=${pageErrors.length}`,
    );
  } finally {
    diagnostics.apiRequests = apiRequests;
    diagnostics.consoleErrors = consoleErrors;
    diagnostics.pageErrors = pageErrors;
    await cleanupSmokeProjects().catch(() => null);
  }

  const pass = results.filter((r) => r.status === 'PASS').length;
  const fail = results.filter((r) => r.status === 'FAIL').length;
  const blocked = results.filter((r) => r.status === 'BLOCKED').length;
  const conclusion = fail === 0 && blocked === 0 ? 'PASS' : fail > 0 ? 'FAIL' : 'BLOCKED';
  const report = [
    '# Export Matrix Smoke Report',
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
