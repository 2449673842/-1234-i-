import { chromium } from 'playwright';

const BASE_URL = process.env.SCIFIGURE_URL || 'http://localhost:3000';

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function fixture() {
  const manifest = {
    generatedBy: 'introspection',
    globals: {},
    objects: [
      {
        id: 'subplot.0',
        kind: 'subplot',
        label: 'Panel 1',
        subplotId: 'subplot.0',
        editable: ['left', 'bottom', 'width', 'height'],
        currentProps: { label: 'Panel 1', subplotIndex: 0, left: 0.1, bottom: 0.1, width: 0.8, height: 0.8 },
        identity: {
          semanticKey: 'subplot:0',
          instanceKey: 'figure:subplot.0',
          scope: 'figure',
          coordinateSpace: 'figure',
          relation: {},
        },
      },
      {
        id: 'line.0',
        kind: 'line',
        label: 'Treatment',
        subplotId: 'subplot.0',
        editable: ['color'],
        currentProps: { color: '#0f3cf0', linewidth: 2 },
        propertyCapabilities: [{
          prop: 'color',
          patchMode: 'local_patch',
          scopes: ['object', 'group', 'subplot', 'figure', 'cross_figure'],
          preview: 'exact',
          replay: 'stable',
        }],
        identity: {
          semanticKey: 'line:treatment',
          instanceKey: 'subplot:line.0',
          seriesKey: 'treatment',
          scope: 'subplot',
          coordinateSpace: 'data',
          relation: { subplotId: 'subplot.0' },
        },
      },
    ],
    palettes: [{ id: 'BLUE', label: 'Treatment blue', color: '#0f3cf0', source: 'constant', line: 1, usageCount: 1 }],
    groups: [],
    bindings: [{
      paletteId: 'BLUE',
      groupId: 'treatment',
      gids: ['line.0'],
      props: ['color'],
      targetMode: 'exact',
      targets: [{
        gid: 'line.0',
        prop: 'color',
        instanceKey: 'subplot:line.0',
        seriesKey: 'treatment',
        match: 'label_and_color',
        confidence: 'exact',
        replayMode: 'object_patch',
      }],
    }],
    capabilities: { localPatch: true, backendPatch: true, codePatch: true },
  };
  const svg = '<svg xmlns="http://www.w3.org/2000/svg" width="600" height="400" viewBox="0 0 600 400"><rect id="axes.patch.0" x="50" y="40" width="500" height="320" fill="white" stroke="#333"/><path id="line.0" data-fig-id="line.0" d="M90 300L300 120L510 250" fill="none" stroke="#0f3cf0" stroke-width="3"/></svg>';
  const spec = {
    plot_type: 'custom',
    custom_script: 'BLUE = "#0f3cf0"',
    script_language: 'python',
    figure: { width: 120, height: 80, unit: 'mm', dpi: 300 },
  };
  return {
    spec,
    history: [spec],
    historyIndex: 0,
    projectId: 'palette-feedback-project',
    projectName: 'Palette feedback fixture',
    figSession: null,
    renderLog: [],
    projectFigures: {
      fig_1: { figureId: 'fig_1', index: 0, manifest, editLog: [], revision: 1, svg, renderStatus: 'success' },
    },
    activeFigureId: 'fig_1',
    selectedFigureIds: [],
    datasets: [],
    selectedGids: ['line.0'],
    projectHistory: {},
    projectDrafts: {},
    currentView: 'workspace',
    subView: 'home',
  };
}

async function main() {
  const browser = await chromium.launch({ headless: true });
  try {
    const initial = fixture();
    let revision = 1;
    let lastPatchRequest = null;
    const editLog = [];
    const context = await browser.newContext({ viewport: { width: 1600, height: 1000 } });
    await context.addInitScript(value => {
      window.sessionStorage.setItem('scifigure:app-state:v2', JSON.stringify(value));
    }, initial);
    const page = await context.newPage();
    page.setDefaultTimeout(20_000);
    await page.route('**/api/auth/me', route => route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ status: 'success', user: { id: 'palette-user', email: 'palette@example.test' }, license: { status: 'free' } }),
    }));
    await page.route('**/api/figure/patch', async (route) => {
      lastPatchRequest = route.request().postDataJSON();
      editLog.push(...(lastPatchRequest.patches || []).map(patch => ({ ...patch, timestamp: Date.now() })));
      revision += 1;
      await new Promise(resolve => setTimeout(resolve, 400));
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          status: 'success',
          revision,
          editLog,
          applied: lastPatchRequest.patches || [],
        }),
      });
    });
    await page.route('**/api/projects/**', route => route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ status: 'success', figures: [] }),
    }));

    await page.goto(BASE_URL, { waitUntil: 'domcontentloaded' });
    await page.getByRole('button', { name: '配色中心' }).last().click();
    const scope = page.getByTestId('palette-subplot-scope');
    await scope.waitFor();
    assert(await scope.inputValue() === 'subplot.0', `palette scope did not follow the selected subplot: ${await scope.inputValue()}`);

    const palette = page.locator('[data-palette-id="BLUE"]');
    await palette.waitFor();
    const colorInput = palette.locator('input[data-color-role="picker"]').first();
    await colorInput.fill('#22aa77');
    await page.getByText(/^已暂存 \d+ 项修改$/, { exact: true }).first().waitFor();

    const response = page.waitForResponse(item => item.url().includes('/api/figure/patch'));
    await page.getByRole('button', { name: '应用当前图', exact: true }).click();
    const applyingButton = page.getByRole('button', { name: '应用中...', exact: true });
    await applyingButton.waitFor();
    assert(await applyingButton.getAttribute('aria-busy') === 'true', 'local palette persistence did not expose an applying state');
    await response;

    const patches = lastPatchRequest?.patches || [];
    assert(
      patches.length === 1
        && patches[0].gid === 'line.0'
        && patches[0].prop === 'color'
        && patches[0].value === '#22aa77'
        && patches[0].mode === 'local_patch'
        && patches.every(patch => patch.type !== 'code_patch'),
      `scoped palette apply did not remain a local object patch: ${JSON.stringify(lastPatchRequest)}`,
    );
    await page.getByRole('button', { name: '应用中...', exact: true }).waitFor({ state: 'detached' });
    assert(
      (await page.locator('[data-fig-id="line.0"]').getAttribute('stroke'))?.toLowerCase() === '#22aa77',
      'local palette apply did not keep the updated SVG preview',
    );

    console.log('PASS local palette persistence exposes applying feedback');
    console.log('PASS scoped palette persistence remains local and keeps the updated preview');
  } finally {
    await browser.close();
  }
}

main().catch(error => {
  console.error(JSON.stringify({ status: 'FAIL', message: error.message }, null, 2));
  process.exitCode = 1;
});
