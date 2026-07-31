import { chromium } from 'playwright';

const BASE_URL = process.env.SCIFIGURE_URL || 'http://localhost:3000';

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function subplot(id, index, left) {
  const properties = ['left', 'bottom', 'width', 'height'];
  return {
    id,
    kind: 'subplot',
    label: `Panel ${index + 1}`,
    subplotId: id,
    editable: properties,
    currentProps: {
      label: `Panel ${index + 1}`,
      subplotIndex: index,
      left,
      bottom: 0.15,
      width: 0.38,
      height: 0.72,
    },
    propertyCapabilities: properties.map(prop => ({
      prop,
      patchMode: 'backend_patch',
      scopes: ['object'],
      preview: 'none',
      replay: 'stable',
      coordinateSpace: 'figure',
    })),
    identity: {
      semanticKey: `subplot:${index}`,
      instanceKey: `figure:${id}`,
      scope: 'figure',
      coordinateSpace: 'figure',
      relation: {},
    },
  };
}

function fixture() {
  const manifest = {
    generatedBy: 'introspection',
    globals: {},
    objects: [
      subplot('subplot.0', 0, 0.08),
      subplot('subplot.1', 1, 0.56),
      {
        id: 'colorbar.shared.0',
        kind: 'colorbar',
        label: 'Shared colorbar',
        editable: [],
        currentProps: { left: 0.95, bottom: 0.15, width: 0.02, height: 0.72 },
        propertyCapabilities: [],
        identity: {
          semanticKey: 'shared-colorbar',
          instanceKey: 'figure:colorbar.shared.0',
          scope: 'figure',
          coordinateSpace: 'figure',
          relation: { subplotIds: ['subplot.0', 'subplot.1'], sharedAcrossSubplots: true },
        },
      },
    ],
    palettes: [],
    groups: [],
    bindings: [],
    capabilities: { localPatch: true, backendPatch: true, codePatch: true },
  };
  const svg = '<svg xmlns="http://www.w3.org/2000/svg" width="800" height="420" viewBox="0 0 800 420"><rect id="axes.patch.0" x="40" y="50" width="300" height="300" fill="white" stroke="#333"/><rect id="axes.patch.1" x="450" y="50" width="300" height="300" fill="white" stroke="#333"/></svg>';
  const spec = {
    plot_type: 'custom',
    custom_script: '',
    script_language: 'python',
    figure: { width: 160, height: 90, unit: 'mm', dpi: 300 },
  };
  return {
    spec,
    history: [spec],
    historyIndex: 0,
    projectId: 'layout-swap-project',
    projectName: 'Layout swap fixture',
    figSession: null,
    renderLog: [],
    projectFigures: {
      fig_1: { figureId: 'fig_1', index: 0, manifest, editLog: [], revision: 1, svg, renderStatus: 'success' },
    },
    activeFigureId: 'fig_1',
    selectedFigureIds: [],
    datasets: [],
    selectedGids: ['subplot.0'],
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
    const renderedManifest = structuredClone(initial.projectFigures.fig_1.manifest);
    const editLog = [];
    let revision = 1;
    let lastPatchRequest = null;
    const context = await browser.newContext({ viewport: { width: 1600, height: 1000 } });
    await context.addInitScript(value => {
      window.sessionStorage.setItem('scifigure:app-state:v2', JSON.stringify(value));
    }, initial);
    const page = await context.newPage();
    page.setDefaultTimeout(20_000);
    await page.route('**/api/auth/me', route => route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ status: 'success', user: { id: 'layout-user', email: 'layout@example.test' }, license: { status: 'free' } }),
    }));
    await page.route('**/api/figure/patch', async (route) => {
      lastPatchRequest = route.request().postDataJSON();
      for (const patch of lastPatchRequest.patches || []) {
        const object = renderedManifest.objects.find(item => item.id === patch.gid);
        if (!object) continue;
        object.currentProps[patch.prop] = patch.value;
        editLog.push({ ...patch, timestamp: Date.now() });
      }
      revision += 1;
      await new Promise(resolve => setTimeout(resolve, 300));
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          status: 'success',
          revision,
          manifest: renderedManifest,
          svg: initial.projectFigures.fig_1.svg,
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
    await page.getByRole('button', { name: '布局中心' }).last().click();
    const swapButton = page.getByTestId('swap-subplots-apply');
    await swapButton.waitFor();
    assert(await swapButton.isEnabled(), 'shared read-only colorbar disabled independent subplot swapping');

    const response = page.waitForResponse(item => item.url().includes('/api/figure/patch'));
    await swapButton.click();
    await page.getByText('交换中...', { exact: true }).waitFor();
    assert(await swapButton.getAttribute('aria-busy') === 'true', 'subplot swap did not expose in-flight feedback');
    await response;

    const patches = lastPatchRequest?.patches || [];
    assert(
      patches.length === 4
        && patches.some(patch => patch.gid === 'subplot.0' && patch.prop === 'left' && patch.value === 0.56)
        && patches.some(patch => patch.gid === 'subplot.1' && patch.prop === 'left' && patch.value === 0.08)
        && patches.every(patch => patch.mode === 'backend_patch')
        && patches.every(patch => patch.gid !== 'colorbar.shared.0'),
      `subplot swap emitted the wrong patch batch: ${JSON.stringify(lastPatchRequest)}`,
    );
    await page.waitForFunction(() => {
      const input = document.querySelector('input[data-param-gid="subplot.0"][data-param-prop="left"]');
      return input?.value === '0.56';
    });

    console.log('PASS shared read-only colorbars do not block independent subplot swapping');
    console.log('PASS subplot swap exposes in-flight feedback and persists swapped bounds');
  } finally {
    await browser.close();
  }
}

main().catch(error => {
  console.error(JSON.stringify({ status: 'FAIL', message: error.message }, null, 2));
  process.exitCode = 1;
});
