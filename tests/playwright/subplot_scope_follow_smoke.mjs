import { chromium } from 'playwright';

const BASE_URL = process.env.SCIFIGURE_URL || 'http://localhost:3000';

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function normalizeHex(value) {
  return typeof value === 'string' ? value.trim().toLowerCase() : '';
}

function rgbaToHex(value) {
  if (!Array.isArray(value) || value.length < 3) return '';
  return `#${value.slice(0, 3).map(component => (
    Math.round(Number(component) * 255).toString(16).padStart(2, '0')
  )).join('')}`;
}

function hexToRgba(value) {
  const hex = normalizeHex(value).replace('#', '');
  return [0, 2, 4].map(index => Number.parseInt(hex.slice(index, index + 2), 16) / 255).concat(1);
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
    makeObject('legend_line.1.0', 'line', 'subplot.1', { color: '#1188ff', linewidth: 1.5 }, ['color', 'linewidth']),
    makeObject('collection.1.0', 'collection', 'subplot.1', {
      facecolor: [
        [0.0666666667, 0.5333333333, 1, 1],
        [0.8392156863, 0.1529411765, 0.1568627451, 1],
      ],
      size_scale: 1,
    }, ['facecolor', 'size_scale']),
    makeObject('collection.1.1', 'collection', 'subplot.1', {
      facecolor: [
        [0.0666666667, 0.5333333333, 1, 1],
        [0.7882352941, 0.2823529412, 0.2196078431, 1],
      ],
      size_scale: 1,
    }, ['facecolor', 'size_scale']),
    makeObject('line.0.red', 'line', 'subplot.0', { color: '#c94838', linewidth: 2 }, ['color', 'linewidth']),
    ...Array.from({ length: 7 }, (_, index) => makeObject(`collection.1.extra.${index}`, 'collection', 'subplot.1', {
      size: 10,
      size_scale: 1,
    }, ['size_scale'])),
    makeObject('annotation.1.0', 'text', 'subplot.1', { text: 'Panel B note 1', color: '#444444', fontsize: 9, fontfamily: 'Arial' }, ['text', 'color', 'fontsize', 'fontfamily']),
    makeObject('annotation.1.1', 'text', 'subplot.1', { text: 'Panel B note 2', color: '#444444', fontsize: 9, fontfamily: 'Arial' }, ['text', 'color', 'fontsize', 'fontfamily']),
    makeObject('title.0', 'text', 'subplot.0', { text: 'Panel A', color: '#176b5b', fontsize: 12, fontfamily: 'Arial' }, ['text', 'color', 'fontsize', 'fontfamily']),
    makeObject('title.1', 'text', 'subplot.1', { text: 'Panel B', color: '#c94838', fontsize: 12, fontfamily: 'Arial' }, ['text', 'color', 'fontsize', 'fontfamily']),
  ];
  const manifest = {
    generatedBy: 'introspection',
    globals: {},
    objects,
    palettes: [
      { id: 'GREEN', label: 'Green', color: '#176b5b', source: 'constant', line: 1, usageCount: 1 },
      { id: 'RED', label: 'Red', color: '#c94838', source: 'constant', line: 2, usageCount: 3 },
      { id: 'BLUE', label: 'Blue', color: '#0f3cf0', source: 'constant', line: 3, usageCount: 2 },
    ],
    groups: [],
    bindings: [
      {
        paletteId: 'GREEN', groupId: 'green', gids: ['line.0', 'title.0'], props: ['color'], targetMode: 'exact',
        targets: ['line.0', 'title.0'].map(gid => ({ gid, prop: 'color', instanceKey: `subplot:${gid}`, seriesKey: gid, match: 'label_and_color', confidence: 'exact', replayMode: 'object_patch' })),
      },
      {
        paletteId: 'RED', groupId: 'red', gids: ['line.0.red', 'line.1', 'title.1', 'collection.1.1'], props: ['color', 'facecolor'], targetMode: 'exact',
        targets: [
          { gid: 'line.0.red', prop: 'color', instanceKey: 'subplot:line.0.red', seriesKey: 'line.0.red', match: 'label_and_color', confidence: 'exact', replayMode: 'object_patch' },
          ...['line.1', 'title.1'].map(gid => ({ gid, prop: 'color', instanceKey: `subplot:${gid}`, seriesKey: gid, match: 'label_and_color', confidence: 'exact', replayMode: 'object_patch' })),
          { gid: 'collection.1.1', prop: 'facecolor', instanceKey: 'subplot:collection.1.1', seriesKey: 'collection.1.1', match: 'label_and_color', confidence: 'exact', replayMode: 'code_only' },
        ],
      },
      {
        paletteId: 'BLUE', groupId: 'blue', gids: ['legend_line.1.0', 'collection.1.0'], props: ['color', 'facecolor'], targetMode: 'exact',
        targets: [
          { gid: 'legend_line.1.0', prop: 'color', instanceKey: 'subplot:legend_line.1.0', seriesKey: 'legend_line.1.0', match: 'label_and_color', confidence: 'exact', replayMode: 'object_patch' },
          { gid: 'collection.1.0', prop: 'facecolor', instanceKey: 'subplot:collection.1.0', seriesKey: 'collection.1.0', match: 'label_and_color', confidence: 'exact', replayMode: 'code_only' },
        ],
      },
    ],
    capabilities: { localPatch: true, backendPatch: true, codePatch: true },
  };
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="800" height="420" viewBox="0 0 800 420">
    <rect id="axes.patch.0" x="40" y="50" width="300" height="300" fill="white" stroke="#333"/>
    <rect id="axes.patch.1" x="450" y="50" width="300" height="300" fill="white" stroke="#333"/>
    <path id="line.0" data-fig-id="line.0" d="M70 300L180 160L310 230" fill="none" stroke="#176b5b" stroke-width="3"/>
    <path id="line.1" data-fig-id="line.1" d="M480 280L590 130L720 210" fill="none" stroke="#c94838" stroke-width="3"/>
    <path id="line.0.red" data-fig-id="line.0.red" d="M95 285L180 250" fill="none" stroke="#c94838" stroke-width="2"/>
    <path id="legend_line.1.0" data-fig-id="legend_line.1.0" d="M650 95L690 95" fill="none" stroke="#1188ff" stroke-width="3"/>
    <g id="collection.1.0" data-fig-id="collection.1.0"><circle cx="540" cy="235" r="7" fill="#1188ff"/><circle cx="630" cy="190" r="9" fill="#d62728"/></g>
    <g id="collection.1.1" data-fig-id="collection.1.1"><circle cx="565" cy="265" r="6" fill="#1188ff"/><circle cx="585" cy="265" r="8" fill="#c94838"/></g>
    <text id="annotation.1.0" data-fig-id="annotation.1.0" x="500" y="320">Panel B note 1</text>
    <text id="annotation.1.1" data-fig-id="annotation.1.1" x="610" y="320">Panel B note 2</text>
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
    const fixture = buildFixture();
    let renderedManifest = JSON.parse(JSON.stringify(fixture.projectFigures.fig_1.manifest));
    let renderedSvg = fixture.projectFigures.fig_1.svg;
    let revision = 1;
    const editLog = [];
    const patchRequests = [];
    const context = await browser.newContext({ viewport: { width: 1600, height: 1000 } });
    await context.addInitScript(fixture => {
      window.sessionStorage.setItem('scifigure:app-state:v2', JSON.stringify(fixture));
    }, fixture);
    const page = await context.newPage();
    page.setDefaultTimeout(20_000);
    await page.route('**/api/auth/me', route => route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ status: 'success', user: { id: 'scope-user', email: 'scope@example.test' }, license: { status: 'free' } }),
    }));
    await page.route('**/api/figure/patch', async (route) => {
      const payload = route.request().postDataJSON();
      patchRequests.push(payload);
      for (const patch of payload.patches || []) {
        const object = renderedManifest.objects.find(item => item.id === patch.gid);
        if (!object) continue;
        if (patch.matchColor && Array.isArray(object.currentProps?.[patch.prop])) {
          const matchColor = normalizeHex(patch.matchColor);
          object.currentProps[patch.prop] = object.currentProps[patch.prop].map(row => (
            rgbaToHex(row) === matchColor ? hexToRgba(patch.value) : row
          ));
          renderedSvg = renderedSvg.replaceAll(matchColor, normalizeHex(patch.value));
        } else {
          object.currentProps[patch.prop] = patch.value;
        }
        editLog.push({ ...patch, timestamp: Date.now() });
      }
      revision += 1;
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          status: 'success',
          revision,
          manifest: renderedManifest,
          svg: renderedSvg,
          editLog,
          applied: payload.patches || [],
        }),
      });
    });
    await page.route('**/api/projects/**', route => route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ status: 'success', figures: [] }),
    }));
    await page.goto(BASE_URL, { waitUntil: 'domcontentloaded' });
    await page.locator('[data-layer-node-id="line.0"]').waitFor();

    const renderLogButton = page.getByRole('button', { name: '打开渲染日志' });
    await renderLogButton.click();
    await page.getByTestId('render-log-dialog').waitFor();
    assert(await page.getByRole('dialog', { name: '渲染日志' }).isVisible(), 'render log dialog did not open beside Word preview');
    await page.keyboard.press('Escape');
    await page.getByTestId('render-log-dialog').waitFor({ state: 'hidden' });
    assert(await renderLogButton.evaluate(element => element === document.activeElement), 'render log opener did not regain focus after Escape');
    await renderLogButton.click();
    await page.getByTestId('render-log-dialog').waitFor();
    await page.getByRole('dialog', { name: '渲染日志' }).getByRole('button', { name: '关闭' }).click();

    await page.getByRole('button', { name: '组件中心' }).last().click();
    const componentScope = page.getByTestId('component-subplot-scope');
    await componentScope.waitFor();
    assert(await componentScope.inputValue() === 'subplot.0', 'component center did not follow the initial Panel A selection');

    await componentScope.selectOption('all');
    const pointGroup = page.locator('[data-component-group-id="points"]');
    await pointGroup.waitFor();
    assert(
      await pointGroup.locator('[data-component-object-id]').count() === 8,
      'point group preview did not expose its first eight Panel B scatter collections',
    );
    await pointGroup.getByRole('button', { name: '选中整组' }).click();
    await page.waitForFunction(() => {
      const state = JSON.parse(window.sessionStorage.getItem('scifigure:app-state:v2') || '{}');
      return Array.isArray(state.selectedGids) && state.selectedGids.length === 9;
    });
    assert(
      await componentScope.inputValue() === 'all',
      'component group selection overwrote the explicit all-subplots scope',
    );
    await page.getByRole('button', { name: '字体中心' }).last().click();
    assert(
      await page.getByTestId('font-subplot-scope').inputValue() === 'subplot.1',
      'component group selection left the unrelated font center on a stale subplot',
    );
    await page.getByRole('button', { name: '配色中心' }).last().click();
    assert(
      await page.getByTestId('palette-subplot-scope').inputValue() === 'subplot.1',
      'component group selection left the unrelated palette center on a stale subplot',
    );
    await page.getByRole('button', { name: '组件中心' }).last().click();
    assert(await componentScope.inputValue() === 'all', 'component center lost its explicit scope after switching centers');
    await pointGroup.locator('[data-component-object-id]').first().click();
    assert(
      await componentScope.inputValue() === 'all',
      'component object-row selection overwrote the explicit all-subplots scope',
    );

    await page.locator('[data-layer-node-id="line.0"]').click();
    await page.waitForFunction(() => document.querySelector('[data-testid="component-subplot-scope"]')?.value === 'subplot.0');
    await componentScope.selectOption('all');
    await pointGroup.getByRole('button', { name: /查看\/选中其余/ }).click();
    await page.waitForFunction(() => {
      const state = JSON.parse(window.sessionStorage.getItem('scifigure:app-state:v2') || '{}');
      return Array.isArray(state.selectedGids) && state.selectedGids.length === 9;
    });
    assert(
      await componentScope.inputValue() === 'all',
      'component overflow selection overwrote the explicit all-subplots scope',
    );

    await page.locator('[id="axes.patch.1"]').click({ position: { x: 20, y: 280 } });
    await page.waitForFunction(() => document.querySelector('[data-testid="component-subplot-scope"]')?.value === 'subplot.1');
    assert(await componentScope.inputValue() === 'subplot.1', 'normal axes.patch click did not select logical subplot.1');

    await page.locator('[data-layer-node-id="line.1"]').click();
    await page.waitForFunction(() => document.querySelector('[data-testid="component-subplot-scope"]')?.value === 'subplot.1');

    await componentScope.selectOption('all');
    await page.locator('[data-layer-node-id="title.1"]').click();
    await page.waitForFunction(() => document.querySelector('[data-testid="component-subplot-scope"]')?.value === 'subplot.1');

    await page.getByRole('button', { name: '字体中心' }).last().click();
    const fontScope = page.getByTestId('font-subplot-scope');
    assert(await fontScope.inputValue() === 'subplot.1', 'font center did not follow Panel B');
    await fontScope.selectOption('all');
    const otherTextFontGroup = page.locator('[data-font-group-id="other_text"]');
    await otherTextFontGroup.getByRole('button', { name: '选中整组' }).click();
    await page.waitForFunction(() => {
      const state = JSON.parse(window.sessionStorage.getItem('scifigure:app-state:v2') || '{}');
      return Array.isArray(state.selectedGids)
        && state.selectedGids.length === 2
        && state.selectedGids.every(gid => gid.startsWith('annotation.1.'));
    });
    assert(
      await fontScope.inputValue() === 'all',
      'font group selection overwrote the explicit all-subplots scope',
    );

    await page.getByRole('button', { name: '布局中心' }).last().click();
    const layoutObject = page.locator('[data-layout-controls-version="2"]').first();
    await layoutObject.waitFor();
    assert(await layoutObject.getAttribute('data-layout-object-id') === 'subplot.1', 'layout center did not follow Panel B');

    await page.getByRole('button', { name: '配色中心' }).last().click();
    const paletteScope = page.getByTestId('palette-subplot-scope');
    if (await paletteScope.count()) {
      assert(await paletteScope.inputValue() === 'subplot.1', 'palette center did not follow Panel B');
      const redPalette = page.locator('[data-palette-id="RED"]');
      await redPalette.waitFor();
      await paletteScope.selectOption('all');
      await redPalette.locator('[data-palette-object-id="collection.1.1"]').click();
      assert(
        await paletteScope.inputValue() === 'all',
        'palette object-row selection overwrote the explicit all-subplots scope',
      );
      await paletteScope.selectOption('subplot.1');
      const selectedRedInput = redPalette.locator('input[data-color-role="text"][data-color-scope="palette-subset:RED"]');
      await selectedRedInput.waitFor();
      assert(
        normalizeHex(await selectedRedInput.inputValue()) === '#c94838',
        `nested scatter color preview resolved incorrectly: ${await selectedRedInput.inputValue()}`,
      );
      await paletteScope.selectOption('all');
      const globalRedInput = redPalette.locator('input[data-color-role="text"][data-color-scope="palette:RED"]');
      await globalRedInput.fill('#EE7700');
      await page.getByText(/^已暂存 \d+ 项修改$/, { exact: true }).first().waitFor();
      await paletteScope.selectOption('subplot.1');
      assert(
        await redPalette.getByText(/统一修改代码全局常量/).count() === 0,
        'scoped palette still exposes the global code-constant control',
      );
      const scopedRedInput = redPalette.locator('input[data-color-role="text"][data-color-scope="palette:RED"]');
      await scopedRedInput.fill('#AA00CC');
      await page.getByText('已暂存 3 项修改', { exact: true }).waitFor();
      const scopedRedPatchResponse = page.waitForResponse(response => response.url().includes('/api/figure/patch'));
      await page.getByRole('button', { name: '应用当前图', exact: true }).click();
      await scopedRedPatchResponse;
      const scopedRedRequest = patchRequests.at(-1);
      const scopedRedPatches = (scopedRedRequest?.patches || []).filter(patch => patch.type !== 'code_patch');
      const expectedScopedRedGids = ['line.1', 'title.1', 'collection.1.1'];
      assert(
        !(scopedRedRequest?.patches || []).some(patch => patch.type === 'code_patch'),
        `scoped palette emitted a global code patch: ${JSON.stringify(scopedRedRequest)}`,
      );
      assert(
        scopedRedPatches.length === expectedScopedRedGids.length
          && expectedScopedRedGids.every(gid => scopedRedPatches.some(patch => patch.gid === gid))
          && scopedRedPatches.every(patch => expectedScopedRedGids.includes(patch.gid)),
        `scoped palette leaked a stale global replay into another subplot: ${JSON.stringify(scopedRedRequest)}`,
      );

      const bluePalette = page.locator('[data-palette-id="BLUE"]');
      await bluePalette.waitFor();
      assert(
        await bluePalette.locator('[data-palette-object-id="legend_line.1.0"]').count() === 1,
        'scoped blue palette lost its exact legend target',
      );
      assert(
        await bluePalette.locator('[data-palette-object-id="collection.1.0"]').count() === 1,
        'second scoped blue palette edit did not recover the replayed mixed scatter color',
      );
      const blueInput = bluePalette.locator('input[data-color-role="text"][data-color-scope="palette:BLUE"]');
      await blueInput.fill('#22AA77');
      await page.getByText(/^已暂存 \d+ 项修改$/, { exact: true }).first().waitFor();
      const firstPatchResponse = page.waitForResponse(response => response.url().includes('/api/figure/patch'));
      await page.getByRole('button', { name: '应用当前图', exact: true }).click();
      await firstPatchResponse;
      const firstBlueRequest = patchRequests.at(-1);
      const firstBluePatches = firstBlueRequest?.patches || [];
      const expectedBlueGids = ['legend_line.1.0', 'collection.1.0', 'collection.1.1'];
      assert(
        firstBluePatches.length === expectedBlueGids.length
          && expectedBlueGids.every(gid => firstBluePatches.some(patch => patch.gid === gid))
          && firstBluePatches.every(patch => expectedBlueGids.includes(patch.gid))
          && firstBluePatches.every(patch => patch.type !== 'code_patch'),
        `first scoped blue edit included stale or cross-subplot drafts: ${JSON.stringify(firstBlueRequest)}`,
      );
      const firstCollectionPatch = firstBlueRequest?.patches?.find(patch => patch.gid === 'collection.1.0');
      assert(firstCollectionPatch?.matchColor === '#1188ff',
        `first browser palette apply lost replayed matchColor: ${JSON.stringify(firstBlueRequest)}`);

      await blueInput.fill('#AA55CC');
      await page.getByText(/^已暂存 \d+ 项修改$/, { exact: true }).first().waitFor();
      const secondPatchResponse = page.waitForResponse(response => response.url().includes('/api/figure/patch'));
      await page.getByRole('button', { name: '应用当前图', exact: true }).click();
      await secondPatchResponse;
      const secondBlueRequest = patchRequests.at(-1);
      const secondBluePatches = secondBlueRequest?.patches || [];
      assert(
        secondBluePatches.length === expectedBlueGids.length
          && expectedBlueGids.every(gid => secondBluePatches.some(patch => patch.gid === gid))
          && secondBluePatches.every(patch => expectedBlueGids.includes(patch.gid))
          && secondBluePatches.every(patch => patch.type !== 'code_patch'),
        `second scoped blue edit included stale or cross-subplot drafts: ${JSON.stringify(secondBlueRequest)}`,
      );
      const secondCollectionPatch = secondBlueRequest?.patches?.find(patch => patch.gid === 'collection.1.0');
      assert(secondCollectionPatch?.matchColor === '#22aa77',
        `second browser palette apply used a stale matchColor: ${JSON.stringify(secondBlueRequest)}`);

      await page.getByRole('button', { name: 'Nature', exact: true }).click();
      await page.getByText(/^已暂存 \d+ 项修改$/, { exact: true }).first().waitFor();
      const presetPatchResponse = page.waitForResponse(response => response.url().includes('/api/figure/patch'));
      await page.getByRole('button', { name: '应用当前图', exact: true }).click();
      await presetPatchResponse;
      const scopedPresetRequest = patchRequests.at(-1);
      const panelBPaletteGids = new Set([
        'line.1',
        'title.1',
        'legend_line.1.0',
        'collection.1.0',
        'collection.1.1',
      ]);
      assert(
        !(scopedPresetRequest?.patches || []).some(patch => patch.type === 'code_patch'),
        `scoped palette preset emitted a global code patch: ${JSON.stringify(scopedPresetRequest)}`,
      );
      assert(
        (scopedPresetRequest?.patches || []).length > 0
          && Array.from(panelBPaletteGids).every(gid => scopedPresetRequest.patches.some(patch => patch.gid === gid))
          && scopedPresetRequest.patches.every(patch => panelBPaletteGids.has(patch.gid)),
        `scoped palette preset leaked into another subplot: ${JSON.stringify(scopedPresetRequest)}`,
      );
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

    await page.getByRole('button', { name: '配色中心' }).last().click();
    await page.waitForFunction(() => document.querySelector('[data-testid="palette-subplot-scope"]')?.value === 'all');
    const globalGreenInput = page.locator('[data-palette-id="GREEN"] input[data-color-role="text"][data-color-scope="palette:GREEN"]');
    await globalGreenInput.fill('#336699');
    await page.getByText('已暂存 3 项修改', { exact: true }).waitFor();
    const globalPatchResponse = page.waitForResponse(response => response.url().includes('/api/figure/patch'));
    await page.getByRole('button', { name: '应用当前图', exact: true }).click();
    await globalPatchResponse;
    const globalGreenRequest = patchRequests.at(-1);
    assert(
      (globalGreenRequest?.patches || []).some(patch => patch.type === 'code_patch' && patch.target_id === 'GREEN'),
      `explicit all-subplots palette update lost its global code patch: ${JSON.stringify(globalGreenRequest)}`,
    );

    console.log('PASS selected subplot automatically follows across component, font, and palette centers');
    console.log('PASS a new selection restores automatic following after a manual scope override');
    console.log('PASS explicit all-subplots scope survives component group selection');
    console.log('PASS component overflow and font group selection preserve explicit subplot scopes');
    console.log('PASS component and palette object-row selection preserve explicit subplot scopes');
    console.log('PASS scoped palette updates remain object-local and nested scatter colors preview correctly');
    console.log('PASS scoped scientific palette presets cannot rewrite global code constants');
    console.log('PASS two browser-applied scoped palette edits preserve replayed mixed-color matchColor');
    console.log('PASS normal axes.patch backgrounds select logical subplots and the log button opens a dialog');
    console.log('PASS cross-subplot multi-selection safely falls back to all subplots');
    console.log('PASS explicit all-subplots palette updates retain global code synchronization');
  } finally {
    await browser.close();
  }
}

main().catch(error => {
  console.error(JSON.stringify({ status: 'FAIL', message: error.message }, null, 2));
  process.exitCode = 1;
});
