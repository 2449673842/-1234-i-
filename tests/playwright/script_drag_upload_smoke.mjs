import assert from 'node:assert/strict';
import { chromium } from 'playwright';

const BASE_URL = process.env.SCIFIGURE_URL || '';
const PYTHON_SCRIPT = [
  'from __future__ import annotations',
  'import matplotlib.pyplot as plt',
  'fig, ax = plt.subplots()',
  'ax.plot([0, 1], [1, 0], color="#1f77b4")',
].join('\n');
const DATA_ZONE_PYTHON_SCRIPT = `${PYTHON_SCRIPT}\nax.set_title("Dropped on the data zone")`;

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
  const dataTransfer = await beginFileDrag(page, target, { name, type, content });
  await target.dispatchEvent('drop', { dataTransfer });
  await dataTransfer.dispose();
}

async function beginFileDrag(page, target, { name, type, content }) {
  const dataTransfer = await page.evaluateHandle(({ fileName, fileType, fileContent }) => {
    const transfer = new DataTransfer();
    transfer.items.add(new File([fileContent], fileName, { type: fileType, lastModified: 1_700_000_000_000 }));
    return transfer;
  }, { fileName: name, fileType: type, fileContent: content });
  await target.dispatchEvent('dragenter', { dataTransfer });
  await target.dispatchEvent('dragover', { dataTransfer });
  return dataTransfer;
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
    const pageHeading = page.getByRole('heading', { name: '新建图形项目', exact: true });
    const passivePageDrag = await beginFileDrag(page, pageHeading, { name: 'passive_page_drag.py', type: 'text/x-python', content: PYTHON_SCRIPT });
    assert.equal(await page.getByTestId('project-create-script-drop-overlay').count(), 0, 'page-level fallback must not show a full-page overlay');
    assert.equal(await page.getByTestId('project-create-script-editor-drop-overlay').count(), 0, 'page-level fallback must not activate another drop zone');
    await pageHeading.dispatchEvent('dragleave', { dataTransfer: passivePageDrag });
    await passivePageDrag.dispose();

    await dropFile(page, introDropZone, { name: 'dragged_analysis.PY', type: 'text/x-python', content: PYTHON_SCRIPT });
    await page.waitForFunction(expected => document.querySelector('textarea[placeholder*="拖入 .py / .R 文件"]')?.value === expected, PYTHON_SCRIPT);
    assert.equal(await textarea.inputValue(), PYTHON_SCRIPT);
    assert.equal(await page.locator('select').filter({ has: page.locator('option[value="python"]') }).last().inputValue(), 'python');
    await page.getByTestId('project-create-imported-script-name').getByText('已导入 dragged_analysis.PY', { exact: true }).waitFor();

    const PAGE_DROP_PYTHON_SCRIPT = `${PYTHON_SCRIPT}\nax.set_ylabel("Dropped anywhere")`;
    await dropFile(page, pageHeading, { name: 'dropped_on_page.py', type: 'text/x-python', content: PAGE_DROP_PYTHON_SCRIPT });
    await page.waitForFunction(expected => document.querySelector('textarea[placeholder*="拖入 .py / .R 文件"]')?.value === expected, PAGE_DROP_PYTHON_SCRIPT);
    assert.equal(await textarea.inputValue(), PAGE_DROP_PYTHON_SCRIPT, 'the new-project page must accept .py drops outside dedicated zones');

    const dataDropZone = page.getByTestId('project-create-data-drop-zone');
    await dropFile(page, dataDropZone, { name: 'dropped_on_data_zone.py', type: 'text/x-python', content: DATA_ZONE_PYTHON_SCRIPT });
    await page.waitForFunction(expected => document.querySelector('textarea[placeholder*="拖入 .py / .R 文件"]')?.value === expected, DATA_ZONE_PYTHON_SCRIPT);
    assert.equal(await textarea.inputValue(), DATA_ZONE_PYTHON_SCRIPT, 'the visible data drop zone must also route .py files into the script editor');

    const dropZone = textarea.locator('..');
    await dropFile(page, dropZone, { name: 'not-a-script.txt', type: 'text/plain', content: 'not python' });
    assert.equal(await textarea.inputValue(), DATA_ZONE_PYTHON_SCRIPT, 'unsupported files must not replace the script');

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
    const passiveWorkspaceDrag = await beginFileDrag(page, workspaceDropZone, { name: 'passive_workspace_drag.py', type: 'text/x-python', content: PYTHON_SCRIPT });
    assert.equal(await page.getByTestId('workspace-code-drop-overlay').count(), 0, 'workspace fallback must not cover the full editor while preview is active');
    await workspaceDropZone.dispatchEvent('dragleave', { dataTransfer: passiveWorkspaceDrag });
    await passiveWorkspaceDrag.dispose();
    assert.equal(await page.getByTestId('workspace-code-editor').count(), 0, 'fixture should start on preview, not code');
    await dropFile(page, workspaceDropZone, { name: 'workspace_drop.py', type: 'text/x-python', content: PYTHON_SCRIPT });
    const workspaceCodeEditor = page.getByTestId('workspace-code-editor');
    await workspaceCodeEditor.waitFor();
    await page.waitForFunction(expected => {
      const state = JSON.parse(sessionStorage.getItem('scifigure:app-state:v2') || '{}');
      return state.spec?.custom_script === expected && state.spec?.script_language === 'python';
    }, PYTHON_SCRIPT);
    const workspaceState = await page.evaluate(() => JSON.parse(sessionStorage.getItem('scifigure:app-state:v2') || '{}'));
    assert.equal(workspaceState.spec.custom_script, PYTHON_SCRIPT);
    assert.equal(workspaceState.spec.script, PYTHON_SCRIPT);

    const localEditorDrag = await beginFileDrag(page, workspaceCodeEditor, { name: 'local_editor_drag.py', type: 'text/x-python', content: PYTHON_SCRIPT });
    const localOverlay = page.getByTestId('workspace-code-drop-overlay');
    await localOverlay.waitFor();
    const [editorBox, overlayBox, workspaceBox] = await Promise.all([
      workspaceCodeEditor.boundingBox(),
      localOverlay.boundingBox(),
      workspaceDropZone.boundingBox(),
    ]);
    assert.ok(editorBox && overlayBox && workspaceBox);
    assert.ok(overlayBox.x >= editorBox.x && overlayBox.y >= editorBox.y, 'drop overlay must start inside the code editor zone');
    assert.ok(overlayBox.x + overlayBox.width <= editorBox.x + editorBox.width + 1, 'drop overlay must stay within the code editor width');
    assert.ok(overlayBox.y + overlayBox.height <= editorBox.y + editorBox.height + 1, 'drop overlay must stay within the code editor height');
    assert.ok(overlayBox.height < workspaceBox.height, 'drop overlay must not cover the full workspace');
    await workspaceCodeEditor.dispatchEvent('dragleave', { dataTransfer: localEditorDrag });
    await localEditorDrag.dispose();
    await localOverlay.waitFor({ state: 'detached' });

    await dropFile(page, workspaceDropZone, { name: 'workspace-data.csv', type: 'text/csv', content: 'x,y\n1,2' });
    const afterUnsupportedDrop = await page.evaluate(() => JSON.parse(sessionStorage.getItem('scifigure:app-state:v2') || '{}'));
    assert.equal(afterUnsupportedDrop.spec.custom_script, PYTHON_SCRIPT, 'unsupported workspace drops must not replace the script');
    console.log('PASS project creation accepts .py drops from the page, script, and data zones, and the full editor ignores unsupported files');
  } finally {
    await browser.close();
  }
}

main().catch(error => { console.error(error); process.exitCode = 1; });
