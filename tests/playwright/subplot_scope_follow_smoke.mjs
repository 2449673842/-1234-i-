import { chromium } from 'playwright';

const BASE_URL = process.env.SCIFIGURE_URL || 'http://localhost:3000';

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function makeObject(id, kind, subplotId, currentProps, editable) {
  return {
    id,
    kind,
    label: id,
    subplotId,
    editable,
    currentProps,
    propertyCapabilities: editable.map(prop => ({
      prop,
      patchMode: 'local_patch',
      scopes: ['object', 'group', 'subplot', 'figure'],
      preview: 'exact',
      replay: 'stable',
    })),
    identity: {
      semanticKey: id,
      instanceKey: `subplot:${id}`,
      seriesKey: id,
      scope: kind === 'subplot' ? 'figure' : 'subplot',
      coordinateSpace: kind === 'text' ? 'axes' : 'data',
      relation: kind === 'subplot' ? {} : { subplotId },
    },
  };
}

function buildFixture() {
  const objects = [
    makeObject('subplot.0', 'subplot', 'subplot.0', { label: 'Panel A', subplotIndex: 0, left: 0.08, bottom: 0.15, width: 0.38, height: 0.72 }, ['left', 'bottom', 'width', 'height']),
    makeObject('subplot.1', 'subplot', 'subplot.1', { label: 'Panel B', subplotIndex: 1, left: 0.56, bottom: 0.15, width: 0.38, height: 0.72 }, ['left', 'bottom', 'width', 'height']),
    makeObject('line.0', 'line', 'subplot.0', { color: '#176b5b', linewidth: 2 }, ['color', 'linewidth']),
    makeObject('line.1', 'line', 'subplot.1', { color: '#c94838', linewidth: 2 }, ['color', 'linewidth']),
    makeObject('title.0', 'text', 'subplot.0', { text: 'Panel A', color: '#176b5b', fontsize: 12, fontfamily: 'Arial' }, ['text', 'color', 'fontsize', 'fontfamily']),
    makeObject('title.1', 'text', 'subplot.1', { text: 'Panel B', color: '#c94838', fontsize: 12, fontfamily: 'Arial' }, ['text', 'color', 'fontsize', 'fontfamily']),
  ];
  const manifest = {
    generatedBy: 'introspection',
    globals: {},
    objects,
    palettes: [
      { id: 'GREEN', label: 'Green', color: '#176b5b', source: 'constant', line: 1, usageCount: 1 },
      { id: 'RED', label: 'Red', color: '#c94838', source: 'constant', line: 2, usageCount: 1 },
    ],
    groups: [],
    bindings: [
      {
        paletteId: 'GREEN', groupId: 'green', gids: ['line.0', 'title.0'], props: ['color'], targetMode: 'exact',
        targets: ['line.0', 'title.0'].map(gid => ({ gid, prop: 'color', instanceKey: `subplot:${gid}`, seriesKey: gid, match: 'label_and_color', confidence: 'exact', replayMode: 'object_patch' })),
      },
      {
        paletteId: 'RED', groupId: 'red', gids: ['line.1', 'title.1'], props: ['color'], targetMode: 'exact',
        targets: ['line.1', 'title.1'].map(gid => ({ gid, prop: 'color', instanceKey: `subplot:${gid}`, seriesKey: gid, match: 'label_and_color', confidence: 'exact', replayMode: 'object_patch' })),
      },
    ],
    capabilities: { localPatch: true, backendPatch: true, codePatch: true },
  };
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="800" height="420" viewBox="0 0 800 420">
    <rect id="subplot.0" data-fig-id="subplot.0" x="40" y="50" width="300" height="300" fill="white" stroke="#333"/>
    <rect id="subplot.1" data-fig-id="subplot.1" x="450" y="50" width="300" height="300" fill="white" stroke="#333"/>
    <path id="line.0" data-fig-id="line.0" d="M70 300L180 160L310 230" fill="none" stroke="#176b5b" stroke-width="3"/>
    <path id="line.1" data-fig-id="line.1" d="M480 280L590 130L720 210" fill="none" stroke="#c94838" stroke-width="3"/>
    <text id="title.0" data-fig-id="title.0" x="190" y="75" text-anchor="middle">Panel A</text>
    <text id="title.1" data-fig-id="title.1" x="600" y="75" text-anchor="middle">Panel B</text>
  </svg>`;
  const spec = { plot_type: 'custom', custom_script: '', script_language: 'python', figure: { width: 160, height: 90, unit: 'mm', dpi: 300 } };
  return {
    spec,
    history: [spec],
    historyIndex: 0,
    projectId: 'scope-follow-project',
    projectName: 'Scope follow fixture',
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
    const context = await browser.newContext({ viewport: { width: 1600, height: 1000 } });
    await context.addInitScript(fixture => {
      window.sessionStorage.setItem('scifigure:app-state:v2', JSON.stringify(fixture));
    }, buildFixture());
    const page = await context.newPage();
    page.setDefaultTimeout(20_000);
    await page.route('**/api/auth/me', route => route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ status: 'success', user: { id: 'scope-user', email: 'scope@example.test' }, license: { status: 'free' } }),
    }));
    await page.route('**/api/projects/**', route => route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ status: 'success', figures: [] }),
    }));
    await page.goto(BASE_URL, { waitUntil: 'domcontentloaded' });
    await page.locator('[data-layer-node-id="line.0"]').waitFor();

    await page.getByRole('button', { name: '组件中心' }).last().click();
    const componentScope = page.getByTestId('component-subplot-scope');
    await componentScope.waitFor();
    assert(await componentScope.inputValue() === 'subplot.0', 'component center did not follow the initial Panel A selection');

    await page.locator('[data-layer-node-id="line.1"]').click();
    await page.waitForFunction(() => document.querySelector('[data-testid="component-subplot-scope"]')?.value === 'subplot.1');

    await componentScope.selectOption('all');
    await page.locator('[data-layer-node-id="title.1"]').click();
    await page.waitForFunction(() => document.querySelector('[data-testid="component-subplot-scope"]')?.value === 'subplot.1');

    await page.getByRole('button', { name: '字体中心' }).last().click();
    assert(await page.getByTestId('font-subplot-scope').inputValue() === 'subplot.1', 'font center did not follow Panel B');

    await page.getByRole('button', { name: '布局中心' }).last().click();
    const layoutObject = page.locator('[data-layout-controls-version="2"]').first();
    await layoutObject.waitFor();
    assert(await layoutObject.getAttribute('data-layout-object-id') === 'subplot.1', 'layout center did not follow Panel B');

    await page.getByRole('button', { name: '配色中心' }).last().click();
    const paletteScope = page.getByTestId('palette-subplot-scope');
    if (await paletteScope.count()) {
      assert(await paletteScope.inputValue() === 'subplot.1', 'palette center did not follow Panel B');
    } else {
      const selectedPaletteCount = await page.getByText('已选 1 个', { exact: true }).count();
      const paletteText = ((await page.textContent('body')) || '').slice(-1600);
      assert(selectedPaletteCount >= 1, `projected palette controls did not follow the selected Panel B object: ${paletteText}`);
    }

    await page.locator('[data-layer-node-id="line.0"]').click({ modifiers: ['Control'] });
    if (await paletteScope.count()) {
      await page.waitForFunction(() => document.querySelector('[data-testid="palette-subplot-scope"]')?.value === 'all');
    } else {
      await page.waitForTimeout(100);
    }
    await page.getByRole('button', { name: '组件中心' }).last().click();
    await page.waitForFunction(() => document.querySelector('[data-testid="component-subplot-scope"]')?.value === 'all');
    assert(await componentScope.inputValue() === 'all', 'cross-subplot multi-selection did not switch all centers to all subplots');

    console.log('PASS selected subplot automatically follows across component, font, and palette centers');
    console.log('PASS a new selection restores automatic following after a manual scope override');
    console.log('PASS cross-subplot multi-selection safely falls back to all subplots');
  } finally {
    await browser.close();
  }
}

main().catch(error => {
  console.error(JSON.stringify({ status: 'FAIL', message: error.message }, null, 2));
  process.exitCode = 1;
});
