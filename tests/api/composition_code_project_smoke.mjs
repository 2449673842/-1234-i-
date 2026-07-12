/**
 * API smoke test for cross-project composition-code project creation.
 *
 * Verifies:
 * - sources can come from different projects,
 * - source project data files are copied into the new project,
 * - the returned AI prompt includes the equal axes-box requirement,
 * - codeSlice is used when the frontend supplies it, with full-script fallback otherwise.
 *
 * Prerequisite:
 *   The app is running at http://localhost:3000.
 */

import { authenticateCapabilitySmokeUser, bearerHeaders } from '../playwright/smokeAuth.mjs';

const BASE_URL = process.env.SCIFIGURE_URL || 'http://localhost:3000';
let authToken = '';

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

async function requestJson(path, options = {}) {
  const res = await fetch(`${BASE_URL}${path}`, {
    ...options,
    headers: {
      ...bearerHeaders(authToken, {
        'Content-Type': 'application/json',
        ...(options.headers || {}),
      }),
    },
  });
  const data = await res.json().catch(() => null);
  if (!res.ok) {
    throw new Error(`${options.method || 'GET'} ${path} failed: ${res.status} ${JSON.stringify(data)}`);
  }
  return data;
}

async function uploadCsv(projectId, fileName, csv) {
  const form = new FormData();
  form.append('file', new Blob([csv], { type: 'text/csv' }), fileName);
  const res = await fetch(`${BASE_URL}/api/projects/${projectId}/files`, {
    method: 'POST',
    headers: bearerHeaders(authToken),
    body: form,
  });
  const data = await res.json().catch(() => null);
  if (!res.ok) {
    throw new Error(`Upload ${fileName} failed: ${res.status} ${JSON.stringify(data)}`);
  }
  return data;
}

async function cleanupSmokeProjects() {
  const data = await requestJson('/api/projects');
  const projects = Array.isArray(data.projects) ? data.projects : [];
  await Promise.all(projects
    .filter((project) => String(project?.name || '').startsWith('Composition code project smoke'))
    .map((project) => {
      const id = project.id || project.projectId;
      return id ? requestJson(`/api/projects/${id}`, { method: 'DELETE' }).catch(() => null) : null;
    }));
}

async function createSourceProject(label, fileName, yValues) {
  const script = [
    'import pandas as pd',
    'import matplotlib.pyplot as plt',
    `df = pd.read_csv("${fileName}")`,
    'fig, ax = plt.subplots(figsize=(3, 2.4))',
    `ax.plot(df["x"], df["y"], marker="o", label="${label}")`,
    `ax.set_title("${label}")`,
    'ax.set_xlabel("Time")',
    'ax.set_ylabel("Value")',
    'ax.legend(loc="upper left")',
    'fig.tight_layout()',
  ].join('\n');
  const spec = {
    plot_type: 'custom',
    custom_script: script,
    script,
    script_language: 'python',
    figure: { width: 90, height: 70, unit: 'mm', dpi: 300 },
  };
  const created = await requestJson('/api/projects', {
    method: 'POST',
    body: JSON.stringify({ name: `Composition code project smoke ${label} ${Date.now()}`, spec }),
  });
  assert(created.status === 'success' && created.id, 'Project creation did not return id');
  const csv = ['x,y', ...yValues.map((value, index) => `${index + 1},${value}`)].join('\n');
  const uploaded = await uploadCsv(created.id, fileName, csv);
  const rendered = await requestJson(`/api/projects/${created.id}/figures/render`, {
    method: 'POST',
    body: JSON.stringify({
      script,
      editLogs: { fig_1: [] },
      language: 'python',
      requestId: `composition-code-render-${Date.now()}-${Math.random().toString(36).slice(2)}`,
    }),
  });
  assert(rendered.status === 'success', `Render failed for ${label}: ${rendered.message || 'unknown'}`);
  assert(Array.isArray(rendered.figures) && rendered.figures.length === 1, `Expected one figure for ${label}`);
  return { projectId: created.id, script, rendered, uploaded };
}

async function createRSourceProject(label, fileName, yValues) {
  const script = [
    'library(ggplot2)',
    `df <- read.csv(uploaded_file_paths[["${fileName}"]])`,
    `p <- ggplot(df, aes(x = x, y = y)) + geom_line() + geom_point() + labs(title = "${label}", x = "Time", y = "Value")`,
  ].join('\n');
  const spec = {
    plot_type: 'custom',
    custom_script: script,
    script,
    script_language: 'r',
    figure: { width: 90, height: 70, unit: 'mm', dpi: 300 },
  };
  const created = await requestJson('/api/projects', {
    method: 'POST',
    body: JSON.stringify({ name: `Composition code project smoke ${label} ${Date.now()}`, spec }),
  });
  assert(created.status === 'success' && created.id, 'R project creation did not return id');
  const csv = ['x,y', ...yValues.map((value, index) => `${index + 1},${value}`)].join('\n');
  const uploaded = await uploadCsv(created.id, fileName, csv);
  const rendered = await requestJson(`/api/projects/${created.id}/figures/render`, {
    method: 'POST',
    body: JSON.stringify({
      script,
      editLogs: { fig_1: [] },
      language: 'r',
      requestId: `composition-r-render-${Date.now()}-${Math.random().toString(36).slice(2)}`,
    }),
  });
  assert(rendered.status === 'success' && rendered.figures?.length === 1, `R render failed for ${label}: ${rendered.message || 'unknown'}`);
  return { projectId: created.id, script, rendered, uploaded };
}

async function main() {
  authToken = await authenticateCapabilitySmokeUser(BASE_URL, 'composition-code-project');
  await cleanupSmokeProjects();
  const createdProjectIds = [];
  try {
    const sourceA = await createSourceProject('Source A', 'source_a.csv', [2, 4, 3]);
    const sourceB = await createSourceProject('Source B', 'source_b.csv', [1, 3, 5]);
    createdProjectIds.push(sourceA.projectId, sourceB.projectId);

    const previewList = await requestJson(`/api/projects/${sourceA.projectId}/figures?includePreview=1`);
    assert(previewList.status === 'success', 'Preview figure list failed');
    assert(previewList.figures?.[0]?.svg?.includes('<svg'), 'Preview figure list did not include SVG');
    assert(previewList.figures?.[0]?.language === 'python', 'Figure picker metadata should include language');
    assert(previewList.figures?.[0]?.dataFileCount === 1, 'Figure picker metadata should include data file count');
    assert(previewList.figures?.[0]?.dependencyStatus === 'complete', 'Figure picker should report complete data dependencies');
    const previewCached = await requestJson(`/api/projects/${sourceA.projectId}/figures?includePreview=1`);
    assert(previewCached.status === 'success', 'Cached preview figure list failed');
    assert(previewCached.previewSource === 'cache', 'Second preview request should use cached SVG');

    const composed = await requestJson('/api/projects/create-composition-project', {
      method: 'POST',
      body: JSON.stringify({
        name: `Composition code project smoke combined ${Date.now()}`,
        targetAxesWidthIn: 2.4,
        targetAxesHeightIn: 1.8,
        layout: '1x2',
        sources: [
          {
            projectId: sourceA.projectId,
            figureId: 'fig_1',
            codeSlice: sourceA.rendered.figures[0].codeSlice,
          },
          {
            projectId: sourceB.projectId,
            figureId: 'fig_1',
          },
        ],
      }),
    });

    assert(composed.status === 'success', `Composition project failed: ${composed.message || 'unknown'}`);
    assert(composed.projectId, 'Composition project did not return projectId');
    createdProjectIds.push(composed.projectId);
    assert(Array.isArray(composed.sourceFigures) && composed.sourceFigures.length === 2, 'sourceFigures count mismatch');
    assert(composed.sourceFigures[0].usedCodeSlice === true, 'First source should use supplied codeSlice');
    assert(composed.sourceFigures[1].usedCodeSlice === false, 'Second source should use full-script fallback');
    assert(Array.isArray(composed.copiedFiles) && composed.copiedFiles.length === 2, 'Expected copied files from both source projects');
    assert(composed.prompt.includes('Required axes box size: 2.4 in × 1.8 in'), 'Prompt missing exact axes-box requirement');
    assert(composed.prompt.includes('source_a') && composed.prompt.includes('source_b'), 'Prompt missing copied file references');
    assert(composed.prompt.includes('make_equal_axes_figure'), 'Prompt missing Matplotlib equal-axes helper');
    assert(composed.prompt.includes('Do not replace it with `plt.subplots`'), 'Prompt missing strict no-subplots instruction');
    assert(composed.prompt.includes('_uploaded_file_paths["filename.csv"]'), 'Prompt missing exact uploaded_file_paths instruction');
    assert(composed.prompt.includes('Add exactly 2 panel labels in reading order: (a), (b).'), 'Prompt should adapt panel labels to selected figure count');
    assert(composed.prompt.includes('(a): Source 1') && composed.prompt.includes('row 1, column 1'), 'Prompt missing first panel placement');
    assert(composed.prompt.includes('(b): Source 2') && composed.prompt.includes('row 1, column 2'), 'Prompt missing second panel placement');
    assert(!composed.prompt.includes('Add panel labels (a), (b), (c) in reading order.'), 'Prompt should not contain hard-coded three-panel label instruction');

    const duplicateResponse = await fetch(`${BASE_URL}/api/projects/create-composition-project`, {
      method: 'POST',
      headers: bearerHeaders(authToken, { 'Content-Type': 'application/json' }),
      body: JSON.stringify({
        targetAxesWidthIn: 2.2,
        targetAxesHeightIn: 2.2,
        layout: '1x2',
        sources: [
          { projectId: sourceA.projectId, figureId: 'fig_1' },
          { projectId: sourceA.projectId, figureId: 'fig_1' },
        ],
      }),
    });
    const duplicateData = await duplicateResponse.json().catch(() => null);
    assert(duplicateResponse.status === 400, 'Duplicate source should be rejected');
    assert(String(duplicateData?.message || '').includes('重复选择'), 'Duplicate source error should be explicit');

    const autoComposed = await requestJson('/api/projects/create-composition-project', {
      method: 'POST',
      body: JSON.stringify({
        name: `Composition code project smoke auto ${Date.now()}`,
        targetAxesWidthIn: 2.2,
        targetAxesHeightIn: 2.2,
        layout: 'auto',
        sources: [
          { projectId: sourceA.projectId, figureId: 'fig_1' },
          { projectId: sourceB.projectId, figureId: 'fig_1' },
        ],
      }),
    });
    createdProjectIds.push(autoComposed.projectId);
    const loadedAuto = await requestJson(`/api/projects/${autoComposed.projectId}`);
    const loadedAutoSpec = typeof loadedAuto.project?.spec === 'string'
      ? JSON.parse(loadedAuto.project.spec)
      : loadedAuto.project?.spec;
    assert(/^\d+x\d+$/.test(String(loadedAutoSpec?.composition?.layout || '')), 'Backend should persist auto as a concrete grid');

    const undersizedLayoutResponse = await fetch(`${BASE_URL}/api/projects/create-composition-project`, {
      method: 'POST',
      headers: bearerHeaders(authToken, { 'Content-Type': 'application/json' }),
      body: JSON.stringify({
        targetAxesWidthIn: 2.2,
        targetAxesHeightIn: 2.2,
        layout: '1x1',
        sources: [
          { projectId: sourceA.projectId, figureId: 'fig_1' },
          { projectId: sourceB.projectId, figureId: 'fig_1' },
        ],
      }),
    });
    const undersizedLayoutData = await undersizedLayoutResponse.json().catch(() => null);
    assert(undersizedLayoutResponse.status === 400, 'Undersized explicit layout should be rejected');
    assert(String(undersizedLayoutData?.message || '').includes('无法容纳'), 'Undersized layout error should explain the capacity problem');

    const loaded = await requestJson(`/api/projects/${composed.projectId}`);
    assert(loaded.status === 'success', 'Failed to load created composition project');
    assert(loaded.project?.datasets?.length === 2, 'Created project should contain copied datasets');
    assert(String(loaded.project?.script || '').includes('TARGET_AXES_WIDTH_IN = 2.4'), 'Created project scaffold missing target axes width');

    const rSourceA = await createRSourceProject('R Source A', 'r_source_a.csv', [1, 4, 2]);
    const rSourceB = await createRSourceProject('R Source B', 'r_source_b.csv', [3, 2, 5]);
    createdProjectIds.push(rSourceA.projectId, rSourceB.projectId);
    const rComposed = await requestJson('/api/projects/create-composition-project', {
      method: 'POST',
      body: JSON.stringify({
        name: `Composition code project smoke R combined ${Date.now()}`,
        targetAxesWidthIn: 2.1,
        targetAxesHeightIn: 1.9,
        layout: '1x2',
        sources: [
          { projectId: rSourceA.projectId, figureId: 'fig_1' },
          { projectId: rSourceB.projectId, figureId: 'fig_1' },
        ],
      }),
    });
    createdProjectIds.push(rComposed.projectId);
    assert(rComposed.prompt.includes('Target language: R'), 'All-R composition should target R');
    assert(rComposed.prompt.includes('ggplot2::ggplotGrob') && rComposed.prompt.includes('grid::unit'), 'R prompt missing physical panel-size helper');
    assert(!rComposed.prompt.includes('fig.add_axes') && !rComposed.prompt.includes('plt.subplots'), 'R prompt contains contradictory Matplotlib instructions');

    await requestJson(`/api/projects/${sourceB.projectId}/files/${sourceB.uploaded.fileId}`, { method: 'DELETE' });
    const missingDependencyResponse = await fetch(`${BASE_URL}/api/projects/create-composition-project`, {
      method: 'POST',
      headers: bearerHeaders(authToken, { 'Content-Type': 'application/json' }),
      body: JSON.stringify({
        layout: '1x1',
        sources: [{ projectId: sourceB.projectId, figureId: 'fig_1' }],
      }),
    });
    const missingDependencyData = await missingDependencyResponse.json().catch(() => null);
    assert(missingDependencyResponse.status === 400, 'Missing source dependency should be rejected by the API');
    assert(String(missingDependencyData?.message || '').includes('缺少脚本所需数据文件'), 'Missing dependency error should name the dependency problem');

    console.log(JSON.stringify({
      status: 'PASS',
      sourceProjects: [sourceA.projectId, sourceB.projectId],
      compositionProjectId: composed.projectId,
      copiedFiles: composed.copiedFiles.map(file => file.copiedFileName),
    }, null, 2));
  } finally {
    await Promise.all(createdProjectIds.map(id => requestJson(`/api/projects/${id}`, { method: 'DELETE' }).catch(() => null)));
  }
}

main().catch((error) => {
  console.error(JSON.stringify({ status: 'FAIL', message: error.message }, null, 2));
  process.exitCode = 1;
});
