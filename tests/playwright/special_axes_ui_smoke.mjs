import { chromium } from 'playwright';

const BASE_URL = process.env.SCIFIGURE_URL || 'http://localhost:3000';

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function isIgnorableDevServerNoise(message) {
  return message.includes('[vite] failed to connect to websocket')
    || /WebSocket connection to 'ws:\/\/(?:localhost|127\.0\.0\.1):24678\//.test(message)
    || message.includes('WebSocket closed without opened');
}

function capability(prop, patchMode = 'local_patch') {
  return {
    prop,
    patchMode,
    scopes: ['object', 'group', 'subplot', 'figure'],
    preview: 'exact',
    replay: 'stable',
  };
}

function relation(subplotId, extra = {}) {
  return { subplotId, ...extra };
}

function identity(id, subplotId, extraRelation = {}, coordinateSpace = 'data') {
  return {
    semanticKey: id,
    instanceKey: `subplot:${id}`,
    seriesKey: id,
    scope: 'subplot',
    coordinateSpace,
    relation: relation(subplotId, extraRelation),
  };
}

function makeObject(id, kind, subplotId, currentProps, editable, extra = {}) {
  return {
    id,
    kind,
    label: id,
    subplotId,
    editable,
    currentProps,
    propertyCapabilities: editable.map(prop => capability(prop)),
    identity: identity(id, subplotId),
    ...extra,
  };
}

function buildFixture() {
  const polarRelation = {
    axesFamily: 'polar',
    projection: 'polar',
    parentSubplotId: 'subplot.0',
    ownerSubplotId: 'polar_subplot.0',
  };
  const objects = [
    makeObject('subplot.0', 'subplot', 'subplot.0', {
      label: 'Main Panel',
      subplotIndex: 0,
      left: 0.1,
      bottom: 0.15,
      width: 0.38,
      height: 0.7,
    }, ['left', 'bottom', 'width', 'height'], {
      subplotId: undefined,
      identity: {
        semanticKey: 'subplot.0',
        instanceKey: 'figure:subplot.0',
        scope: 'figure',
        coordinateSpace: 'figure',
        relation: {},
      },
      source: { artistClass: 'Axes', axesIndex: 0 },
    }),
    makeObject('polar_subplot.0', 'polar_subplot', 'polar_subplot.0', {
      label: 'Polar Panel',
      subplotIndex: 1,
      left: 0.56,
      bottom: 0.18,
      width: 0.32,
      height: 0.58,
    }, [], {
      identity: identity('polar_subplot.0', 'polar_subplot.0', polarRelation, 'axes'),
      source: { artistClass: 'PolarAxes', axesIndex: 1 },
    }),
    makeObject('line.0', 'line', 'subplot.0', {
      color: '#2f6f8f',
      linewidth: 2,
    }, ['color', 'linewidth'], {
      role: 'data_line',
      source: { artistClass: 'Line2D', axesIndex: 0 },
    }),
    makeObject('line.polar.0', 'line', 'polar_subplot.0', {
      color: '#c33a5b',
      linewidth: 2,
    }, ['color', 'linewidth'], {
      role: 'data_line',
      identity: identity('line.polar.0', 'polar_subplot.0', polarRelation),
      source: { artistClass: 'Line2D', axesIndex: 1 },
    }),
    makeObject('title.polar.0', 'text', 'polar_subplot.0', {
      text: 'Polar Title',
      fontsize: 13,
      fontfamily: 'Arial',
      color: '#111111',
    }, ['text', 'fontsize', 'fontfamily', 'color'], {
      role: 'axes_title',
      identity: identity('title.polar.0', 'polar_subplot.0', polarRelation, 'axes'),
      source: { artistClass: 'Text', axesIndex: 1 },
    }),
    makeObject('secondary_yaxis.0', 'secondary_yaxis', 'subplot.0', {
      label: 'Secondary Y',
      tick_color: '#555555',
    }, ['label', 'tick_color'], {
      role: 'secondary_y_axis',
      identity: identity('secondary_yaxis.0', 'subplot.0', {
        axesFamily: 'secondary_y',
        projection: 'rectilinear',
        parentSubplotId: 'subplot.0',
        ownerSubplotId: 'secondary_yaxis.0',
      }, 'axes'),
      source: { artistClass: 'SecondaryAxis', axesIndex: 2, ownerAxesIndex: 0 },
    }),
    makeObject('three_d_subplot.0', 'three_d_subplot', 'three_d_subplot.0', {
      label: '3D Panel',
      axesFamily: '3d',
      projection: '3d',
      layoutEditable: false,
      projectionEditable: false,
      cameraEditable: false,
    }, [], {
      role: 'three_d_subplot_panel',
      identity: identity('three_d_subplot.0', 'three_d_subplot.0', {
        axesFamily: '3d',
        projection: '3d',
        parentSubplotId: 'three_d_subplot.0',
        ownerSubplotId: 'three_d_subplot.0',
      }, 'axes'),
      source: { artistClass: 'Axes3D', axesIndex: 3 },
    }),
    makeObject('axis.z.3', 'axis_z', 'three_d_subplot.0', {
      label: 'Depth',
      label_fontsize: 11,
      label_color: '#222222',
      tick_labelsize: 9,
      tick_labelcolor: '#222222',
      tick_labelfamily: 'Arial',
      tick_fontweight: 'normal',
      tick_fontstyle: 'normal',
    }, [
      'label', 'label_fontsize', 'label_color', 'tick_labelsize',
      'tick_labelcolor', 'tick_labelfamily', 'tick_fontweight', 'tick_fontstyle',
    ], {
      identity: identity('axis.z.3', 'three_d_subplot.0', {
        axesFamily: '3d',
        projection: '3d',
        parentSubplotId: 'three_d_subplot.0',
        ownerSubplotId: 'three_d_subplot.0',
      }, 'axes'),
      source: { artistClass: 'ZAxis', axesIndex: 3 },
    }),
    makeObject('zlabel.3', 'text', 'three_d_subplot.0', {
      text: 'Depth',
      fontsize: 11,
      fontfamily: 'Arial',
      fontweight: 'normal',
      fontstyle: 'normal',
      color: '#222222',
    }, ['text', 'fontsize', 'fontfamily', 'fontweight', 'fontstyle', 'color'], {
      role: 'z_axis_label',
      identity: identity('zlabel.3', 'three_d_subplot.0', {
        axesFamily: '3d',
        projection: '3d',
        parentSubplotId: 'three_d_subplot.0',
        ownerSubplotId: 'three_d_subplot.0',
      }, 'axes'),
      source: { artistClass: 'Text', axesIndex: 3 },
    }),
    makeObject('ztick.3.0', 'text', 'three_d_subplot.0', {
      text: '0',
      fontsize: 9,
      fontfamily: 'Arial',
      color: '#222222',
    }, ['text', 'fontsize', 'fontfamily', 'fontweight', 'fontstyle', 'color'], {
      role: 'z_tick_label',
      identity: identity('ztick.3.0', 'three_d_subplot.0', {
        axesFamily: '3d',
        projection: '3d',
        parentSubplotId: 'three_d_subplot.0',
        ownerSubplotId: 'three_d_subplot.0',
      }, 'axes'),
      source: { artistClass: 'Text', axesIndex: 3 },
    }),
  ];
  const manifest = {
    generatedBy: 'introspection',
    globals: {},
    objects,
    palettes: [
      { id: 'POLAR_RED', label: 'Polar red', color: '#c33a5b', source: 'constant', line: 1, usageCount: 1 },
    ],
    groups: [],
    bindings: [{
      paletteId: 'POLAR_RED',
      groupId: 'polar-line',
      gids: ['line.polar.0'],
      props: ['color'],
      targetMode: 'exact',
      targets: [{
        gid: 'line.polar.0',
        prop: 'color',
        instanceKey: 'subplot:line.polar.0',
        seriesKey: 'line.polar.0',
        match: 'label_and_color',
        confidence: 'exact',
        replayMode: 'object_patch',
      }],
    }],
    capabilities: { localPatch: true, backendPatch: true, codePatch: true },
  };
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="820" height="440" viewBox="0 0 820 440">
    <rect id="axes.0" data-fig-id="subplot.0" x="70" y="70" width="280" height="280" fill="white" stroke="#222"/>
    <path id="line.0" data-fig-id="line.0" d="M95 305L180 180L330 240" fill="none" stroke="#2f6f8f" stroke-width="3"/>
    <circle id="axes.patch.1" cx="590" cy="215" r="135" fill="white" stroke="#222"/>
    <g id="axes.1" data-fig-id="polar_subplot.0">
      <circle cx="590" cy="215" r="95" fill="none" stroke="#ddd"/>
      <path id="line.polar.0" data-fig-id="line.polar.0" d="M590 215L660 160L705 215L610 305" fill="none" stroke="#c33a5b" stroke-width="3"/>
      <text id="title.polar.0" data-fig-id="title.polar.0" x="590" y="54" text-anchor="middle">Polar Title</text>
    </g>
  </svg>`;
  const spec = {
    plot_type: 'custom',
    custom_script: '',
    script: '',
    script_language: 'python',
    figure: { width: 160, height: 90, unit: 'mm', dpi: 300 },
  };
  return {
    spec,
    history: [spec],
    historyIndex: 0,
    projectId: 'special-axes-ui-fixture',
    projectName: 'Special axes UI fixture',
    figSession: null,
    renderLog: ['> Special axes fixture ready'],
    projectFigures: {
      fig_1: {
        figureId: 'fig_1',
        index: 0,
        manifest,
        editLog: [],
        revision: 1,
        svg,
        fingerprint: 'special-axes-ui-fixture',
        renderStatus: 'success',
      },
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

async function clickTab(page, name) {
  await page.getByRole('button', { name }).last().click();
}

async function waitForInputValue(page, testId, expected, label) {
  const locator = page.getByTestId(testId);
  await locator.waitFor();
  const deadline = Date.now() + 5_000;
  let actual = await locator.inputValue();
  while (Date.now() < deadline && actual !== expected) {
    await page.waitForTimeout(100);
    actual = await locator.inputValue();
  }
  assert(actual === expected, `${label}: expected ${expected}, got ${actual}`);
}

async function waitForLayerSelection(page, gid, label) {
  const locator = page.locator(`[data-layer-node-id="${gid}"]`);
  const deadline = Date.now() + 5_000;
  let selected = await locator.getAttribute('data-selected');
  while (Date.now() < deadline && selected !== 'true') {
    await page.waitForTimeout(100);
    selected = await locator.getAttribute('data-selected');
  }
  assert(selected === 'true', `${label}: ${gid} was not selected`);
}

async function treeParentSectionId(page, gid) {
  return page.evaluate((targetGid) => {
    const target = document.querySelector(`[data-layer-node-id="${CSS.escape(targetGid)}"]`);
    if (!target) return null;
    const nodes = Array.from(document.querySelectorAll('[data-layer-node-id]'));
    let closestSection = null;
    for (const node of nodes) {
      if (node === target) break;
      const id = node.getAttribute('data-layer-node-id');
      if (id?.endsWith('_Section')) closestSection = id;
    }
    return closestSection;
  }, gid);
}

async function specialPanelIsAssigned(page) {
  return page.evaluate(() => {
    const panel = document.querySelector('[data-layer-node-id="polar_subplot.0"]');
    const unassigned = document.querySelector('[data-layer-node-id="Unassigned_Section"]');
    const subplots = document.querySelector('[data-layer-node-id="Subplots_Section"]');
    if (!panel || !subplots) return false;
    const inSubplots = Boolean(subplots.compareDocumentPosition(panel) & Node.DOCUMENT_POSITION_FOLLOWING);
    const inUnassigned = unassigned
      ? Boolean(unassigned.compareDocumentPosition(panel) & Node.DOCUMENT_POSITION_FOLLOWING)
      : false;
    return inSubplots && !inUnassigned;
  });
}

async function run() {
  const browser = await chromium.launch({ headless: true });
  try {
    const context = await browser.newContext({ viewport: { width: 1600, height: 1000 } });
    await context.addInitScript(fixture => {
      window.sessionStorage.setItem('scifigure:app-state:v2', JSON.stringify(fixture));
    }, buildFixture());
    const page = await context.newPage();
    page.setDefaultTimeout(20_000);

    const pageErrors = [];
    const consoleErrors = [];
    page.on('pageerror', error => {
      if (!isIgnorableDevServerNoise(error.message)) pageErrors.push(error.message);
    });
    page.on('console', message => {
      if (message.type() === 'error' && !isIgnorableDevServerNoise(message.text())) {
        consoleErrors.push(message.text());
      }
    });

    await page.route('**/api/auth/me', route => route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        status: 'success',
        user: { id: 'special-axes-user', email: 'special-axes@example.test' },
        license: { status: 'free' },
      }),
    }));
    await page.route('**/api/projects**', route => route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ status: 'success', projects: [], figures: [], assets: [] }),
    }));

    await page.goto(BASE_URL, { waitUntil: 'domcontentloaded', timeout: 30_000 });
    await page.locator('[data-layer-node-id="polar_subplot.0"]').waitFor();

    const capabilitySummary = page.getByTestId('figure-capability-summary');
    await capabilitySummary.waitFor();
    const capabilitySummaryText = await capabilitySummary.innerText();
    assert(capabilitySummaryText.includes('当前 Figure：部分可编辑'), `capability summary did not report partial editability: ${capabilitySummaryText}`);
    assert(capabilitySummaryText.includes('8/10 objects'), `capability summary object count drifted: ${capabilitySummaryText}`);
    assert(capabilitySummaryText.includes('可编辑 8 · 只读 2 · 不支持 0'), `capability summary breakdown drifted: ${capabilitySummaryText}`);

    assert(await specialPanelIsAssigned(page), 'polar panel is not assigned under the subplot structure');
    const polarLineSection = await treeParentSectionId(page, 'line.polar.0');
    const polarTitleSection = await treeParentSectionId(page, 'title.polar.0');
    const secondaryAxisSection = await treeParentSectionId(page, 'secondary_yaxis.0');
    assert(polarLineSection?.startsWith('polar_subplot.0_'), `polar line is not under the polar panel section: ${polarLineSection}`);
    assert(polarTitleSection?.startsWith('polar_subplot.0_'), `polar title is not under the polar panel section: ${polarTitleSection}`);
    assert(secondaryAxisSection?.startsWith('subplot.0_'), `secondary axis is not owned by subplot.0: ${secondaryAxisSection}`);

    await page.locator('[data-layer-node-id="line.polar.0"]').click();
    await page.waitForFunction(() => {
      const raw = window.sessionStorage.getItem('scifigure:app-state:v2');
      const state = raw ? JSON.parse(raw) : {};
      return Array.isArray(state.selectedGids)
        && state.selectedGids.length === 1
        && state.selectedGids[0] === 'line.polar.0';
    });
    await clickTab(page, '组件中心');
    await waitForInputValue(page, 'component-subplot-scope', 'polar_subplot.0', 'component scope did not follow polar line');

    await clickTab(page, '字体中心');
    await waitForInputValue(page, 'font-subplot-scope', 'polar_subplot.0', 'font scope did not follow polar line');

    await page.locator('[data-layer-node-id="secondary_yaxis.0"]').click();
    await clickTab(page, '组件中心');
    await waitForInputValue(page, 'component-subplot-scope', 'subplot.0', 'secondary axis scope did not resolve to subplot.0');

    await page.locator('[data-layer-node-id="zlabel.3"]').click();
    await clickTab(page, '字体中心');
    await waitForInputValue(page, 'font-subplot-scope', 'three_d_subplot.0', 'font scope did not follow 3D Z label');
    const fontCenterText = await page.locator('.scifig-editor-panel-right').innerText();
    assert(fontCenterText.includes('Z 轴标签'), 'font center did not expose the 3D Z axis label group');
    assert(fontCenterText.includes('Z 轴刻度文字'), 'font center did not expose the stable axis.z tick group');

    await clickTab(page, '布局中心');
    const layoutText = await page.locator('.scifig-editor-panel-right').innerText();
    const layoutObjectId = await page.locator('[data-layout-controls-version="2"]').getAttribute('data-layout-object-id');
    assert(layoutObjectId === 'subplot.0', `layout center did not retain the ordinary subplot object: ${layoutObjectId}`);
    assert(!layoutText.includes('多子图版面重排'), 'layout center counted special panels as ordinary layout subplots');
    assert(!layoutText.includes('Polar Panel'), 'layout center exposed polar panel bounds controls');
    assert(!layoutText.includes('polar_subplot.0'), 'layout center exposed polar subplot id in bounds controls');

    await page.locator('#axes\\.patch\\.1').click({ position: { x: 25, y: 135 } });
    await waitForLayerSelection(page, 'polar_subplot.0', 'axes.patch click did not select special panel');
    const selectedAfterPatchClick = await page.locator('[data-layer-node-id="polar_subplot.0"]').getAttribute('data-selected');
    assert(selectedAfterPatchClick === 'true', 'clicking axes.patch did not select the special panel');

    await page.locator('[data-layer-node-id="title.polar.0"]').click();
    await clickTab(page, '属性编辑');
    await page.getByText('GID：title.polar.0').waitFor();
    const positionControls = await page.locator('[data-param-gid="title.polar.0"][data-param-prop="position"]').count();
    assert(positionControls === 0, 'special title exposed a position editor');
    const titleHasPosition = await page.evaluate(() => {
      const raw = window.sessionStorage.getItem('scifigure:app-state:v2');
      const state = raw ? JSON.parse(raw) : {};
      const title = state.projectFigures?.fig_1?.manifest?.objects?.find(item => item.id === 'title.polar.0');
      return title?.editable?.includes('position') || Object.hasOwn(title?.currentProps || {}, 'position');
    });
    assert(!titleHasPosition, 'special title fixture unexpectedly has editable/current position metadata');

    const titleFontSize = page.locator('[data-param-gid="title.polar.0"][data-param-prop="fontsize"]');
    await titleFontSize.fill('15');
    await page.getByText('已暂存 1 项修改').waitFor();
    const stagedTitleFontSize = await page.evaluate(() => {
      const raw = window.sessionStorage.getItem('scifigure:app-state:v2');
      const state = raw ? JSON.parse(raw) : {};
      return state.projectDrafts?.fig_1?.['title.polar.0:fontsize']?.value;
    });
    assert(Number(stagedTitleFontSize) === 15, `special title fontsize did not enter Draft: ${stagedTitleFontSize}`);

    assert(pageErrors.length === 0, `page errors: ${JSON.stringify(pageErrors)}`);
    assert(consoleErrors.length === 0, `console errors: ${JSON.stringify(consoleErrors)}`);

    console.log('PASS special panel is assigned under subplot structure');
    console.log('PASS capability summary reports partial special-axes editability');
    console.log('PASS polar line drives component and font scopes');
    console.log('PASS secondary axis resolves to subplot.0');
    console.log('PASS 3D Z-axis label and tick fonts use dedicated font-center groups');
    console.log('PASS layout center excludes special panel bounds');
    console.log('PASS axes.patch maps to the special panel');
    console.log('PASS special title has no position editing metadata');
    console.log('PASS special title style enters Draft without exposing geometry');
  } finally {
    await browser.close();
  }
}

run().catch(error => {
  console.error(JSON.stringify({ status: 'FAIL', message: error.message }, null, 2));
  process.exitCode = 1;
});
