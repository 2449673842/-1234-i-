import assert from 'node:assert/strict';
import { chromium } from 'playwright';

const BASE_URL = process.env.SCIFIGURE_URL || '';
const PYTHON_SCRIPT = [
  'from __future__ import annotations',
  'import matplotlib.pyplot as plt',
  'fig, ax = plt.subplots()',
  'ax.plot([0, 1], [1, 0], color="#1f77b4")',
].join('\n');

function assertIsolatedEnvironment() {
  assert.equal(process.env.SCIFIGURE_TEST_ISOLATED, '1');
  const url = new URL(BASE_URL);
  assert.equal(url.hostname, '127.0.0.1');
  assert.notEqual(url.port, '3000');
}

async function installRoutes(page) {
  await page.route('**/api/auth/me', route => route.fulfill({
    status: 200,
    contentType: 'application/json',
    body: JSON.stringify({ status: 'success', user: { id: 'script-drop-smoke', email: 'script-drop@example.test' }, license: { status: 'free' } }),
  }));
  await page.route('**/api/auth/refresh', route => route.fulfill({
    status: 200,
    contentType: 'application/json',
    body: JSON.stringify({ status: 'error' }),
  }));
  await page.route('**/api/projects**', route => route.fulfill({
    status: 200,
    contentType: 'application/json',
    body: JSON.stringify({ status: 'success', projects: [] }),
  }));
}

async function dropFile(page, target, { name, type, content }) {
  const dataTransfer = await page.evaluateHandle(({ fileName, fileType, fileContent }) => {
    const transfer = new DataTransfer();
    transfer.items.add(new File([fileContent], fileName, { type: fileType, lastModified: 1_700_000_000_000 }));
    return transfer;
  }, { fileName: name, fileType: type, fileContent: content });
  await target.dispatchEvent('dragenter', { dataTransfer });
  await target.dispatchEvent('dragover', { dataTransfer });
  await target.dispatchEvent('drop', { dataTransfer });
  await dataTransfer.dispose();
}

async function main() {
  assertIsolatedEnvironment();
  const browser = await chromium.launch({ headless: true });
  try {
    const context = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
    const page = await context.newPage();
    page.setDefaultTimeout(20_000);
    await installRoutes(page);
    await page.goto(BASE_URL, { waitUntil: 'domcontentloaded' });
    await page.getByRole('button', { name: '新建图形项目', exact: true }).click();
    await page.getByRole('heading', { name: '新建图形项目', exact: true }).waitFor();

    const textarea = page.locator('textarea[placeholder*="拖入 .py / .R 文件"]');
    const introDropZone = page.getByTestId('project-create-script-drop-zone');
    await dropFile(page, introDropZone, { name: 'dragged_analysis.PY', type: 'text/x-python', content: PYTHON_SCRIPT });
    await page.waitForFunction(expected => document.querySelector('textarea[placeholder*="拖入 .py / .R 文件"]')?.value === expected, PYTHON_SCRIPT);
    assert.equal(await textarea.inputValue(), PYTHON_SCRIPT);
    assert.equal(await page.locator('select').filter({ has: page.locator('option[value="python"]') }).last().inputValue(), 'python');

    const dropZone = textarea.locator('..');
    await dropFile(page, dropZone, { name: 'not-a-script.txt', type: 'text/plain', content: 'not python' });
    assert.equal(await textarea.inputValue(), PYTHON_SCRIPT, 'unsupported files must not replace the script');

    await page.evaluate(() => {
      const baselineScript = 'import matplotlib.pyplot as plt\nfig, ax = plt.subplots()';
      const spec = {
        plot_type: 'custom',
        custom_script: baselineScript,
        script: baselineScript,
        script_language: 'python',
        figure: { width: 120, height: 85, unit: 'mm', dpi: 300 },
      };
      sessionStorage.setItem('scifigure:app-state:v2', JSON.stringify({
        spec,
        history: [spec],
        historyIndex: 0,
        projectId: 'script-drop-project',
        projectName: 'Script drop project',
        projectFigures: {
          fig_1: {
            figureId: 'fig_1', index: 0, revision: 1, renderStatus: 'success', editLog: [],
            svg: '<svg xmlns="http://www.w3.org/2000/svg" width="300" height="180"><line id="line.0.0" data-fig-id="line.0.0" x1="20" y1="150" x2="270" y2="30" stroke="#336699" /></svg>',
            manifest: {
              generatedBy: 'introspection', globals: {}, palettes: [], groups: [], bindings: [],
              objects: [{ id: 'line.0.0', kind: 'line', label: 'line', editable: ['color'], currentProps: { color: '#336699' } }],
            },
          },
        },
        activeFigureId: 'fig_1', selectedFigureIds: [], selectedGids: [], datasets: [], projectHistory: {}, projectDrafts: {},
        currentView: 'editor', subView: 'home', renderLog: ['> Script drop fixture ready'], figSession: null,
      }));
    });
    await page.reload({ waitUntil: 'domcontentloaded' });
    const workspaceDropZone = page.getByTestId('workspace-script-drop-zone');
    await workspaceDropZone.waitFor();
    assert.equal(await page.getByTestId('workspace-code-editor').count(), 0, 'fixture should start on preview, not code');
    await dropFile(page, workspaceDropZone, { name: 'workspace_drop.py', type: 'text/x-python', content: PYTHON_SCRIPT });
    await page.getByTestId('workspace-code-editor').waitFor();
    await page.waitForFunction(expected => {
      const state = JSON.parse(sessionStorage.getItem('scifigure:app-state:v2') || '{}');
      return state.spec?.custom_script === expected && state.spec?.script_language === 'python';
    }, PYTHON_SCRIPT);
    const workspaceState = await page.evaluate(() => JSON.parse(sessionStorage.getItem('scifigure:app-state:v2') || '{}'));
    assert.equal(workspaceState.spec.custom_script, PYTHON_SCRIPT);
    assert.equal(workspaceState.spec.script, PYTHON_SCRIPT);

    await dropFile(page, workspaceDropZone, { name: 'workspace-data.csv', type: 'text/csv', content: 'x,y\n1,2' });
    const afterUnsupportedDrop = await page.evaluate(() => JSON.parse(sessionStorage.getItem('scifigure:app-state:v2') || '{}'));
    assert.equal(afterUnsupportedDrop.spec.custom_script, PYTHON_SCRIPT, 'unsupported workspace drops must not replace the script');
    console.log('PASS project creation and the full editor workspace accept dropped .py scripts without touching unsupported files');
  } finally {
    await browser.close();
  }
}

main().catch(error => { console.error(error); process.exitCode = 1; });
