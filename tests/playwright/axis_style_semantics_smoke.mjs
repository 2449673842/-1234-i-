/**
 * Axis-style semantic isolation smoke.
 *
 * Uses an in-memory project and intercepted patch endpoint. It verifies the
 * browser target compiler without reading or writing real project data.
 */

import { chromium } from 'playwright';
import * as fs from 'fs';
import * as path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '../..');
const BASE_URL = process.env.SCIFIGURE_URL || 'http://localhost:3000';
const RUN_ID = new Date().toISOString().replace(/[:.]/g, '-');
const OUTPUT_DIR = path.join(ROOT, 'output', 'playwright', `axis-style-semantics-${RUN_ID}`);
const results = [];
const patchBodies = [];

function record(id, status, note) {
  results.push({ id, status, note });
  console.log(`${status} ${id}: ${note}`);
}

function makeObject(id, kind, editable, currentProps, extra = {}) {
  const role = extra.role;
  return {
    id,
    kind,
    label: id,
    editable,
    currentProps,
    subplotId: 'subplot.0',
    identity: extra.identity || {
      semanticKey: `${role || kind}:subplot.0`,
      instanceKey: `subplot:${id}`,
      scope: 'subplot',
      coordinateSpace: 'axes',
      relation: { subplotId: 'subplot.0' },
    },
    propertyCapabilities: editable.map(prop => ({
      prop,
      patchMode: ['color', 'visible', 'facecolor', 'edgecolor', 'alpha'].includes(prop) ? 'local_patch' : 'backend_patch',
      scopes: role ? ['object', 'group', 'subplot', 'figure'] : ['object', 'subplot', 'figure'],
      preview: ['color', 'visible', 'facecolor', 'edgecolor', 'alpha'].includes(prop) ? 'exact' : 'none',
      replay: 'stable',
    })),
    ...extra,
  };
}

function buildFixture() {
  const objects = [
    makeObject('subplot.0', 'subplot', ['left', 'bottom', 'width', 'height'], {
      label: 'Panel A', subplotIndex: 0, left: 0.12, bottom: 0.12, width: 0.78, height: 0.78,
    }, { subplotId: undefined }),
    makeObject('axis.x.0', 'axis_x', ['tick_direction', 'tick_length', 'tick_width', 'tick_color', 'show_minor_ticks'], {
      tick_direction: 'out', tick_length: 3.5, tick_width: 0.8, tick_color: '#111111', show_minor_ticks: false,
    }, { role: 'x_axis', source: { artistClass: 'XAxis', axesIndex: 0 } }),
    makeObject('axis.y.0', 'axis_y', ['tick_direction', 'tick_length', 'tick_width', 'tick_color', 'show_minor_ticks'], {
      tick_direction: 'out', tick_length: 3.5, tick_width: 0.8, tick_color: '#111111', show_minor_ticks: false,
    }, { role: 'y_axis', source: { artistClass: 'YAxis', axesIndex: 0 } }),
    makeObject('spine_group.0', 'spine_group', ['visible', 'color', 'linewidth'], {
      visible: true, color: '#222222', linewidth: 1,
    }, {
      role: 'axis_frame',
      children: ['spine.left.0', 'spine.right.0', 'spine.top.0', 'spine.bottom.0'],
      source: { artistClass: 'SpineGroup', axesIndex: 0 },
    }),
    ...['left', 'right', 'top', 'bottom'].map(side => makeObject(`spine.${side}.0`, 'spine', ['visible', 'color', 'linewidth'], {
      visible: true, color: '#222222', linewidth: 1,
    }, { role: 'axis_spine', parentId: 'spine_group.0', source: { artistClass: 'Spine', axesIndex: 0 } })),
    makeObject('grid.0', 'grid', ['visible', 'color', 'linewidth', 'linestyle', 'alpha'], {
      visible: true, color: '#cccccc', linewidth: 0.6, linestyle: '--', alpha: 0.8,
    }, { role: 'grid', source: { artistClass: 'Grid', axesIndex: 0 } }),
    makeObject('xtick.0.0', 'text', ['text', 'fontsize', 'color', 'rotation'], {
      text: 'X tick', fontsize: 9, color: '#111111', rotation: 0,
    }, { role: 'x_tick_label', source: { artistClass: 'Text', axesIndex: 0 } }),
    makeObject('ytick.0.0', 'text', ['text', 'fontsize', 'color', 'rotation'], {
      text: 'Y tick', fontsize: 9, color: '#111111', rotation: 0,
    }, { role: 'y_tick_label', source: { artistClass: 'Text', axesIndex: 0 } }),
  ];
  const manifest = {
    generatedBy: 'introspection',
    globals: {},
    objects,
    palettes: [],
    groups: [],
    bindings: [],
    capabilities: { localPatch: true, backendPatch: true, codePatch: true },
  };
  const svg = '<svg xmlns="http://www.w3.org/2000/svg" width="520" height="360" viewBox="0 0 520 360"><rect id="subplot.0" data-fig-id="subplot.0" x="60" y="35" width="400" height="270" fill="white" stroke="#222"/><g id="spine_group.0" data-fig-id="spine_group.0"><path id="spine.left.0" data-fig-id="spine.left.0" d="M60 35V305" stroke="#222"/><path id="spine.right.0" data-fig-id="spine.right.0" d="M460 35V305" stroke="#222"/><path id="spine.top.0" data-fig-id="spine.top.0" d="M60 35H460" stroke="#222"/><path id="spine.bottom.0" data-fig-id="spine.bottom.0" d="M60 305H460" stroke="#222"/></g><g id="grid.0" data-fig-id="grid.0"><path d="M60 170H460" stroke="#ccc" stroke-dasharray="4 3"/></g><text id="xtick.0.0" data-fig-id="xtick.0.0" x="250" y="330">X tick</text><text id="ytick.0.0" data-fig-id="ytick.0.0" x="20" y="170">Y tick</text></svg>';
  const spec = {
    plot_type: 'custom', custom_script: '', script: '', script_language: 'python',
    figure: { width: 140, height: 100, unit: 'mm', dpi: 300 },
  };
  return {
    svg,
    manifest,
    state: {
      spec,
      history: [spec],
      historyIndex: 0,
      projectId: 'axis-style-semantics-fixture',
      projectName: 'Axis style semantics fixture',
      figSession: null,
      renderLog: ['> Axis style fixture ready'],
      projectFigures: {
        fig_1: {
          figureId: 'fig_1', index: 0, manifest, editLog: [], revision: 1, svg,
          fingerprint: 'axis-style-fixture', codeSlice: null, renderStatus: 'success',
        },
      },
      activeFigureId: 'fig_1',
      selectedFigureIds: [],
      datasets: [],
      selectedGids: [],
      projectHistory: {},
      projectDrafts: {},
      currentView: 'workspace',
      subView: 'home',
    },
  };
}

async function clickButton(page, name) {
  const button = page.getByRole('button', { name: new RegExp(name) }).first();
  if (!(await button.isVisible({ timeout: 5000 }).catch(() => false))) return false;
  await button.click();
  return true;
}

async function controlInCard(page, cardText, selector, attribute, expected, endsWith = false) {
  return page.evaluateHandle(({ cardText, selector, attribute, expected, endsWith }) => {
    const normalize = value => String(value || '').replace(/\s+/g, '');
    const visible = node => {
      const rect = node.getBoundingClientRect();
      const style = getComputedStyle(node);
      return rect.width > 0 && rect.height > 0 && style.display !== 'none' && style.visibility !== 'hidden';
    };
    const headings = Array.from(document.querySelectorAll('span,div,p,h4'))
      .filter(node => visible(node) && normalize(node.textContent) === normalize(cardText))
      .sort((a, b) => a.getBoundingClientRect().height - b.getBoundingClientRect().height);
    for (const heading of headings) {
      let container = heading.parentElement;
      while (container) {
        const control = Array.from(container.querySelectorAll(selector)).find(node => {
          if (!visible(node) || node.disabled) return false;
          const actual = String(node.getAttribute(attribute) || '');
          return endsWith ? actual.endsWith(expected) : actual === expected;
        });
        if (control) return control;
        if (container.getBoundingClientRect().left < window.innerWidth * 0.65) break;
        container = container.parentElement;
      }
    }
    return null;
  }, { cardText, selector, attribute, expected, endsWith });
}

async function setNumber(page, card, prop, value) {
  const handle = await controlInCard(page, card, 'input[data-param-role="number"]', 'data-param-prop', prop);
  const element = handle.asElement();
  if (!element) return false;
  await element.scrollIntoViewIfNeeded();
  await element.fill(String(value));
  await element.press('Enter').catch(() => {});
  await element.evaluate(node => node.blur());
  return true;
}

async function setColor(page, card, prop, value) {
  let handle = await controlInCard(page, card, 'input[data-property-control="color-text"][type="text"]', 'data-param-prop', prop);
  let element = handle.asElement();
  if (!element) {
    handle = await controlInCard(page, card, 'input[data-color-role="text"]', 'data-color-scope', `:${prop}`, true);
    element = handle.asElement();
  }
  if (!element) return false;
  await element.scrollIntoViewIfNeeded();
  await element.fill(value);
  await element.press('Enter').catch(() => {});
  await element.evaluate(node => node.blur());
  return true;
}

async function applyDraft(page) {
  const start = patchBodies.length;
  const clicked = await clickButton(page, '应用当前图');
  if (!clicked) return [];
  const startedAt = Date.now();
  while (Date.now() - startedAt < 10000 && patchBodies.length === start) {
    await page.waitForTimeout(100);
  }
  return patchBodies[start]?.patches || [];
}

async function run() {
  fs.mkdirSync(OUTPUT_DIR, { recursive: true });
  const fixture = buildFixture();
  let revision = 1;
  let runtimeManifest = structuredClone(fixture.manifest);
  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({ viewport: { width: 1600, height: 1000 } });
  await context.addInitScript(state => {
    window.sessionStorage.setItem('scifigure:app-state:v2', JSON.stringify(state));
  }, fixture.state);
  const page = await context.newPage();
  await page.route('**/api/auth/me', route => route.fulfill({
    status: 200,
    contentType: 'application/json',
    body: JSON.stringify({
      status: 'success',
      user: { id: 'axis-style-user' },
      license: { status: 'free' },
    }),
  }));
  await page.route('**/api/projects**', route => route.fulfill({
    status: 200,
    contentType: 'application/json',
    body: JSON.stringify({ status: 'success', projects: [], assets: [] }),
  }));
  await page.route('**/api/figure/patch', async route => {
    const body = route.request().postDataJSON();
    patchBodies.push(body);
    for (const patch of body.patches || []) {
      const object = runtimeManifest.objects.find(item => item.id === patch.gid);
      if (object) object.currentProps[patch.prop] = patch.value;
    }
    revision += 1;
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        status: 'success', figureId: 'fig_1', svg: fixture.svg, manifest: runtimeManifest,
        editLog: (body.patches || []).map(patch => ({ ...patch, timestamp: Date.now() })), revision,
      }),
    });
  });

  const pageErrors = [];
  const consoleErrors = [];
  page.on('pageerror', error => pageErrors.push(error.message));
  page.on('console', message => { if (message.type() === 'error') consoleErrors.push(message.text()); });

  try {
    await page.goto(BASE_URL, { waitUntil: 'domcontentloaded', timeout: 30000 });
    const propertiesTab = page.getByRole('button', { name: '属性编辑', exact: true });
    const editorReady = await propertiesTab.waitFor({ state: 'visible', timeout: 30000 }).then(() => true).catch(() => false);
    if (!editorReady) {
      const bodyText = ((await page.textContent('body').catch(() => '')) || '').slice(0, 1600);
      throw new Error(`Axis style editor did not load. Body: ${bodyText}. Page errors: ${pageErrors.join(' | ')}. Console errors: ${consoleErrors.join(' | ')}`);
    }
    await clickButton(page, '组件中心');

    const frameChanged = await setNumber(page, '子图边框 / 坐标轴框线', 'linewidth', 2.2);
    const framePatches = frameChanged ? await applyDraft(page) : [];
    const frameOk = framePatches.length === 1
      && framePatches[0]?.gid === 'spine_group.0'
      && framePatches[0]?.prop === 'linewidth'
      && !framePatches.some(patch => String(patch.gid).startsWith('spine.'));
    record('AXIS-1-frame-group', frameOk ? 'PASS' : 'FAIL', JSON.stringify(framePatches));

    await clickButton(page, '组件中心');
    const tickChanged = await setColor(page, '坐标轴系统', 'tick_color', '#c0392b');
    const tickPatches = tickChanged ? await applyDraft(page) : [];
    const tickGids = tickPatches.map(patch => patch.gid).sort();
    const tickOk = tickPatches.length === 2
      && tickGids.join(',') === 'axis.x.0,axis.y.0'
      && tickPatches.every(patch => patch.prop === 'tick_color')
      && !tickPatches.some(patch => /^(x|y)tick\./.test(String(patch.gid)));
    record('AXIS-2-tick-line-isolation', tickOk ? 'PASS' : 'FAIL', JSON.stringify(tickPatches));

    await clickButton(page, '组件中心');
    const gridChanged = await setColor(page, '网格线', 'color', '#2980b9');
    const gridPatches = gridChanged ? await applyDraft(page) : [];
    const gridOk = gridPatches.length === 1 && gridPatches[0]?.gid === 'grid.0' && gridPatches[0]?.prop === 'color';
    record('AXIS-3-grid-isolation', gridOk ? 'PASS' : 'FAIL', JSON.stringify(gridPatches));

    const unrelatedTouched = [...framePatches, ...tickPatches, ...gridPatches]
      .some(patch => ['xtick.0.0', 'ytick.0.0'].includes(patch.gid));
    record('AXIS-4-no-text-spill', !unrelatedTouched ? 'PASS' : 'FAIL', `unrelatedTouched=${unrelatedTouched}`);
    record('AXIS-5-runtime', pageErrors.length === 0 && consoleErrors.length === 0 ? 'PASS' : 'FAIL',
      `pageErrors=${pageErrors.length}, consoleErrors=${consoleErrors.length}`);
    await page.screenshot({ path: path.join(OUTPUT_DIR, 'axis-style-semantics.png'), fullPage: true });
  } finally {
    await browser.close();
  }

  fs.writeFileSync(path.join(OUTPUT_DIR, 'report.json'), JSON.stringify({ results, patchBodies }, null, 2));
  const failures = results.filter(result => result.status === 'FAIL');
  if (failures.length > 0) throw new Error(`${failures.length} axis-style checks failed`);
}

run().catch(error => {
  console.error(error);
  process.exit(1);
});
