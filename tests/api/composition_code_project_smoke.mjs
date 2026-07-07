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

const BASE_URL = process.env.SCIFIGURE_URL || 'http://localhost:3000';

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

async function requestJson(path, options = {}) {
  const res = await fetch(`${BASE_URL}${path}`, {
    ...options,
    headers: {
      'Content-Type': 'application/json',
      ...(options.headers || {}),
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
  await uploadCsv(created.id, fileName, csv);
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
  return { projectId: created.id, script, rendered };
}

async function main() {
  await cleanupSmokeProjects();
  const createdProjectIds = [];
  try {
    const sourceA = await createSourceProject('Source A', 'source_a.csv', [2, 4, 3]);
    const sourceB = await createSourceProject('Source B', 'source_b.csv', [1, 3, 5]);
    createdProjectIds.push(sourceA.projectId, sourceB.projectId);

    const previewList = await requestJson(`/api/projects/${sourceA.projectId}/figures?includePreview=1`);
    assert(previewList.status === 'success', 'Preview figure list failed');
    assert(previewList.figures?.[0]?.svg?.includes('<svg'), 'Preview figure list did not include SVG');
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

    const loaded = await requestJson(`/api/projects/${composed.projectId}`);
    assert(loaded.status === 'success', 'Failed to load created composition project');
    assert(loaded.project?.datasets?.length === 2, 'Created project should contain copied datasets');
    assert(String(loaded.project?.script || '').includes('TARGET_AXES_WIDTH_IN = 2.4'), 'Created project scaffold missing target axes width');

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
