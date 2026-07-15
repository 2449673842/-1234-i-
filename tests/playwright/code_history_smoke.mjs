import { chromium } from 'playwright';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const BASE_URL = process.env.SCIFIGURE_URL || 'http://localhost:3000';
const RUN_ID = new Date().toISOString().replace(/[:.]/g, '-');
const OUTPUT_DIR = path.join(ROOT, 'output', 'playwright', `code-history-${RUN_ID}`);
const baselineScript = [
  'import matplotlib.pyplot as plt',
  'fig, ax = plt.subplots(figsize=(5, 3.5))',
  'ax.plot([0, 1, 2], [1, 3, 2], label="baseline")',
  'ax.set_title("CODE_HISTORY_BASELINE")',
  'ax.legend()',
].join('\n');
const updatedScript = [
  'import matplotlib.pyplot as plt',
  'fig, ax = plt.subplots(figsize=(5, 3.5))',
  'ax.plot([0, 1, 2], [1, 3, 2], color="#cc3355", label="updated")',
  'ax.set_title("CODE_HISTORY_UPDATED")',
  'ax.set_xlabel("Synthetic time")',
  'ax.legend()',
].join('\n');

let token = '';
let projectId = '';

async function requestJson(pathname, options = {}) {
  const response = await fetch(`${BASE_URL}${pathname}`, {
    ...options,
    headers: {
      ...(options.body ? { 'Content-Type': 'application/json' } : {}),
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...(options.headers || {}),
    },
  });
  const data = await response.json().catch(() => null);
  if (!response.ok) throw new Error(`${options.method || 'GET'} ${pathname}: ${response.status} ${JSON.stringify(data)}`);
  return data;
}

async function authenticate() {
  const response = await fetch(`${BASE_URL}/api/auth/register`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      email: `code-history-${Date.now()}@example.test`,
      password: 'Code-History-Smoke-2026',
      displayName: 'Code history smoke',
    }),
  });
  const data = await response.json();
  if (!response.ok || !data.token) throw new Error(`Authentication failed: ${response.status} ${JSON.stringify(data)}`);
  token = data.token;
}

async function prepareProject() {
  const spec = {
    plot_type: 'custom',
    custom_script: baselineScript,
    script: baselineScript,
    script_language: 'python',
    figure: { width: 120, height: 85, unit: 'mm', dpi: 300 },
  };
  const created = await requestJson('/api/projects', {
    method: 'POST',
    body: JSON.stringify({ name: `Code history smoke ${Date.now()}`, spec }),
  });
  projectId = created.id;
  const rendered = await requestJson(`/api/projects/${projectId}/figures/render`, {
    method: 'POST',
    body: JSON.stringify({
      script: baselineScript,
      editLogs: { fig_1: [] },
      language: 'python',
      requestId: `code-history-initial-${Date.now()}`,
    }),
  });
  return { spec, rendered };
}

async function setAppState(page, spec, rendered) {
  await page.evaluate(({ spec, rendered, projectId }) => {
    const projectFigures = {};
    rendered.figures.forEach((figure, index) => {
      projectFigures[figure.figureId] = { ...figure, index, renderStatus: 'success' };
    });
    sessionStorage.setItem('scifigure:app-state:v2', JSON.stringify({
      spec,
      history: [spec],
      historyIndex: 0,
      projectId,
      projectName: 'Code history smoke',
      projectFigures,
      activeFigureId: 'fig_1',
      selectedFigureIds: ['fig_1'],
      datasets: [],
      selectedGids: [],
      projectHistory: {},
      projectDrafts: {},
      currentView: 'editor',
      subView: 'home',
      renderLog: ['> Code history fixture ready'],
      figSession: null,
    }));
  }, { spec, rendered, projectId });
}

async function waitForSvgText(page, text, timeout = 90000) {
  await page.waitForFunction((expected) => {
    return Array.from(document.querySelectorAll('svg text')).some(node => node.textContent?.includes(expected));
  }, text, { timeout });
}

async function run() {
  fs.mkdirSync(OUTPUT_DIR, { recursive: true });
  await authenticate();
  const { spec, rendered } = await prepareProject();
  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({
    viewport: { width: 1500, height: 950 },
    extraHTTPHeaders: { Authorization: `Bearer ${token}` },
  });
  await context.addInitScript((accessToken) => sessionStorage.setItem('scifigure:auth-token', accessToken), token);
  const page = await context.newPage();
  const pageErrors = [];
  page.on('console', message => {
    if (message.type() === 'error' && !message.text().includes('WebSocket')) {
      pageErrors.push(`console: ${message.text()}`);
    }
  });
  page.on('pageerror', error => {
    if (!error.message.includes('WebSocket closed without opened')) pageErrors.push(error.message);
  });

  try {
    await page.goto(BASE_URL, { waitUntil: 'domcontentloaded', timeout: 60000 });
    await setAppState(page, spec, rendered);
    await page.reload({ waitUntil: 'domcontentloaded', timeout: 60000 });
    await waitForSvgText(page, 'CODE_HISTORY_BASELINE');

    const viewTabs = page.getByTestId('workspace-view-tabs');
    await viewTabs.getByRole('button', { name: '代码', exact: true }).click();
    const editor = page.locator('.monaco-editor').first();
    await editor.click({ position: { x: 300, y: 160 } });
    await page.keyboard.press('Control+A');
    await page.keyboard.insertText(updatedScript);

    const codePatchResponse = await Promise.all([
      page.waitForResponse(response => (
        response.url().includes('/api/figure/code-patch') && response.request().method() === 'POST'
      ), { timeout: 90000 }),
      page.getByRole('button', { name: '同步至引擎并预览 SVG', exact: true }).last().click(),
    ]);
    const response = codePatchResponse[0];
    if (!response.ok()) throw new Error(`Code patch failed: ${response.status()} ${await response.text()}`);

    await viewTabs.getByRole('button', { name: '预览', exact: true }).click();
    await waitForSvgText(page, 'CODE_HISTORY_UPDATED');

    await page.getByRole('button', { name: '历史', exact: true }).click();
    await page.getByText('代码版本', { exact: true }).waitFor({ state: 'visible', timeout: 10000 });
    const historyText = await page.textContent('body');
    if (!historyText.includes('代码更新前') || !historyText.includes('代码 +')) {
      throw new Error('Code history metadata is not visible');
    }
    await page.getByRole('button', { name: '历史', exact: true }).click();

    const undoRender = page.waitForResponse(res => (
      res.url().includes(`/api/projects/${projectId}/figures/render`) && res.request().method() === 'POST'
    ), { timeout: 90000 });
    await page.getByRole('button', { name: '撤销', exact: true }).click();
    if (!(await undoRender).ok()) throw new Error('Code undo render failed');
    await waitForSvgText(page, 'CODE_HISTORY_BASELINE');

    const redoRender = page.waitForResponse(res => (
      res.url().includes(`/api/projects/${projectId}/figures/render`) && res.request().method() === 'POST'
    ), { timeout: 90000 });
    await page.getByRole('button', { name: '重做', exact: true }).click();
    if (!(await redoRender).ok()) throw new Error('Code redo render failed');
    await waitForSvgText(page, 'CODE_HISTORY_UPDATED');

    const saveRequestPromise = page.waitForRequest(req => (
      new URL(req.url()).pathname === `/api/projects/${projectId}` && req.method() === 'PUT'
    ), { timeout: 30000 });
    const saveResponse = page.waitForResponse(res => (
      new URL(res.url()).pathname === `/api/projects/${projectId}` && res.request().method() === 'PUT'
    ), { timeout: 30000 });
    await page.getByRole('button', { name: '保存', exact: true }).click();
    const [saveRequest, savedResponse] = await Promise.all([saveRequestPromise, saveResponse]);
    if (!savedResponse.ok()) throw new Error('Project save failed');
    const savedBody = saveRequest.postDataJSON();

    const persisted = await requestJson(`/api/projects/${projectId}`);
    const persistedFigure = persisted.project?.figures?.[0];
    const history = persistedFigure?.history || { past: [] };
    const codeSnapshots = (history.past || []).filter(item => item.changeType === 'code');
    if (codeSnapshots.length !== 1 || codeSnapshots[0].script !== baselineScript) {
      throw new Error(`Persisted code history mismatch: ${JSON.stringify({
        sentHistory: savedBody?.figures?.[0]?.history,
        persistedFigure,
        codeSnapshots,
      })}`);
    }
    if (pageErrors.length) throw new Error(`Page errors: ${JSON.stringify(pageErrors)}`);

    const screenshot = path.join(OUTPUT_DIR, 'code-history.png');
    await page.getByRole('button', { name: '历史', exact: true }).click();
    await page.screenshot({ path: screenshot, fullPage: true });
    const report = {
      status: 'PASS',
      projectId,
      codeSnapshots: codeSnapshots.length,
      undoRestored: 'CODE_HISTORY_BASELINE',
      redoRestored: 'CODE_HISTORY_UPDATED',
      screenshot,
    };
    fs.writeFileSync(path.join(OUTPUT_DIR, 'report.json'), JSON.stringify(report, null, 2));
    console.log(JSON.stringify(report, null, 2));
  } finally {
    await browser.close();
    if (projectId) await requestJson(`/api/projects/${projectId}`, { method: 'DELETE' }).catch(() => null);
  }
}

run().catch(error => {
  console.error(error.stack || error.message);
  process.exitCode = 1;
});
