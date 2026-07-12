import { describe, it, expect } from 'vitest';
import {
  inferFigureEngine,
  normalizeFigureModel,
  normalizeFigureObject,
  normalizeProjectFigures,
  normalizeProjectFigure,
  normalizeRenderResponse,
} from './standardFigureModel';
import type { Manifest, ManifestObject, EditEntry, RenderResponse } from '../schemas/manifest';
import type { FigureEntry, SavedEditEntry } from '../types';
import type { StandardFigureInput } from '../schemas/standardFigureModel';

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

/** Minimal Python/Matplotlib manifest */
function makePythonManifest(overrides?: Partial<Manifest>): Manifest {
  return {
    generatedBy: 'introspection',
    globals: {
      dpi: { type: 'number', value: 100, min: 50, max: 600, step: 10 },
    },
    objects: [
      {
        id: 'title.0',
        kind: 'text',
        label: 'Figure Title',
        editable: ['text', 'fontsize', 'color', 'fontfamily', 'fontweight', 'fontstyle'],
        currentProps: { text: 'My Figure', fontsize: 14, color: '#000000' },
        role: 'figure_title',
      },
      {
        id: 'axis.x.0',
        kind: 'axis_x',
        label: 'X Axis',
        editable: ['limits', 'tick_rotation', 'tick_fontsize'],
        currentProps: { limits: [0, 10], tick_rotation: 0, tick_fontsize: 10 },
        role: 'x_axis',
      },
      {
        id: 'legend.0',
        kind: 'legend',
        label: 'Legend',
        editable: ['visible', 'loc', 'fontsize'],
        currentProps: { visible: true, loc: 'best', fontsize: 10 },
      },
    ] as ManifestObject[],
    capabilities: { localPatch: true, backendPatch: true, codePatch: true },
    colorGroups: [
      { color: '#1f77b4', label: 'Series 1', gids: ['line.0'], count: 1 },
    ],
    palettes: [
      { id: 'pal_0', label: 'Series 1', color: '#1f77b4', source: 'auto', line: 5 },
    ],
    groups: [
      { groupId: 'grp_0', label: 'Lines', paletteId: 'pal_0', kind: 'line' },
    ],
    bindings: [
      { paletteId: 'pal_0', groupId: 'grp_0', gids: ['line.0'], props: ['color'] },
    ],
    coverageReport: {
      summary: { recognized: 10, editable: 8, readonly: 1, unsupported: 1 },
      byKind: { text: { count: 3, editableProps: ['text', 'fontsize', 'color'] } },
      unsupportedArtists: [],
    },
    unsupportedNotes: ['FancyArrowPatch not supported'],
    ...overrides,
  };
}

/** Minimal R/ggplot manifest */
function makeRManifest(overrides?: Partial<Manifest>): Manifest {
  return {
    generatedBy: 'r_svg',
    globals: {},
    objects: [
      {
        id: 'text.title.0',
        kind: 'text',
        label: 'Plot Title',
        editable: ['text', 'fontsize', 'color'],
        currentProps: { text: 'R Plot', fontsize: 12, color: '#333333' },
        role: 'figure_title',
      },
      {
        id: 'axis.x.0',
        kind: 'axis_x',
        label: 'X Axis',
        editable: ['tick_rotation'],
        currentProps: { tick_rotation: 0 },
      },
    ] as ManifestObject[],
    capabilities: { localPatch: false, backendPatch: true, codePatch: false },
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// inferFigureEngine
// ---------------------------------------------------------------------------

describe('inferFigureEngine', () => {
  it('returns python_matplotlib for introspection manifest', () => {
    expect(inferFigureEngine(makePythonManifest())).toBe('python_matplotlib');
  });

  it('returns python_matplotlib when language is python', () => {
    expect(inferFigureEngine(null, 'python')).toBe('python_matplotlib');
  });

  it('returns r_ggplot for r_svg manifest', () => {
    expect(inferFigureEngine(makeRManifest())).toBe('r_ggplot');
  });

  it('returns r_ggplot when language is r', () => {
    expect(inferFigureEngine(null, 'r')).toBe('r_ggplot');
  });

  it('returns unknown for null manifest and no language', () => {
    expect(inferFigureEngine(null)).toBe('unknown');
    expect(inferFigureEngine(undefined)).toBe('unknown');
  });

  it('language takes precedence when manifest is ambiguous', () => {
    // language=r should win even if manifest is missing generatedBy
    const manifest = { ...makePythonManifest(), generatedBy: undefined as any };
    expect(inferFigureEngine(manifest, 'r')).toBe('r_ggplot');
  });
});

// ---------------------------------------------------------------------------
// normalizeFigureObject
// ---------------------------------------------------------------------------

describe('normalizeFigureObject', () => {
  it('normalizes a manifest object with all fields', () => {
    const obj: ManifestObject = {
      id: 'title.0',
      kind: 'text',
      label: 'Title',
      editable: ['text', 'fontsize'],
      currentProps: { text: 'Hello', fontsize: 14 },
      role: 'figure_title',
      subplotId: 'subplot.0',
      parentId: 'figure.0',
      children: ['child.0'],
      stableKey: 'sk_title_0',
      fingerprint: 'fp_abc',
      identity: {
        semanticKey: 'figure_title:subplot.0',
        instanceKey: 'subplot:title.0',
        scope: 'subplot',
        coordinateSpace: 'axes',
        relation: { subplotId: 'subplot.0' },
      },
      propertyCapabilities: [{
        prop: 'fontsize',
        patchMode: 'backend_patch',
        scopes: ['object', 'group', 'subplot', 'figure', 'cross_figure'],
        preview: 'none',
        replay: 'stable',
        derivedEffects: ['text_bounds'],
      }],
      source: { artistClass: 'Text', axesIndex: 0 },
    };
    const result = normalizeFigureObject(obj);
    expect(result.id).toBe('title.0');
    expect(result.kind).toBe('text');
    expect(result.label).toBe('Title');
    expect(result.editable).toEqual(['text', 'fontsize']);
    expect(result.props).toEqual({ text: 'Hello', fontsize: 14 });
    expect(result.currentProps).toEqual({ text: 'Hello', fontsize: 14 });
    expect(result.role).toBe('figure_title');
    expect(result.subplotId).toBe('subplot.0');
    expect(result.parentId).toBe('figure.0');
    expect(result.children).toEqual(['child.0']);
    expect(result.stableKey).toBe('sk_title_0');
    expect(result.fingerprint).toBe('fp_abc');
    expect(result.identity?.instanceKey).toBe('subplot:title.0');
    expect(result.propertyCapabilities?.[0]?.prop).toBe('fontsize');
  });

  it('handles missing optional fields gracefully', () => {
    const obj: ManifestObject = {
      id: 'line.0',
      kind: 'line',
      label: 'Line',
      editable: [],
      currentProps: {},
    };
    const result = normalizeFigureObject(obj);
    expect(result.editable).toEqual([]);
    expect(result.props).toEqual({});
    expect(result.role).toBeUndefined();
    expect(result.subplotId).toBeUndefined();
  });

  it('handles undefined currentProps by defaulting to empty object', () => {
    const obj = {
      id: 'patch.0',
      kind: 'patch',
      label: 'Patch',
      editable: ['color'],
      // currentProps intentionally missing
    } as unknown as ManifestObject;
    const result = normalizeFigureObject(obj);
    expect(result.props).toEqual({});
    expect(result.currentProps).toEqual({});
  });
});

// ---------------------------------------------------------------------------
// normalizeFigureModel
// ---------------------------------------------------------------------------

describe('normalizeFigureModel', () => {
  it('normalizes a Python manifest input', () => {
    const manifest = makePythonManifest();
    const input: StandardFigureInput = {
      figureId: 'fig_1',
      language: 'python',
      svg: '<svg>python</svg>',
      manifest,
      revision: 3,
      editLog: [
        { gid: 'title.0', prop: 'text', value: 'Updated', mode: 'backend_patch', timestamp: 1000 },
      ],
      fingerprint: 'fp_123',
      codeSlice: { figureId: 'fig_1', title: 'Main Plot', startLine: 1, endLine: 20, code: 'plt.plot(...)', confidence: 'high', mode: 'exact_range', reason: 'detected' },
    };
    const model = normalizeFigureModel(input);

    expect(model.schemaVersion).toBe('1.0');
    expect(model.figureId).toBe('fig_1');
    expect(model.engine).toBe('python_matplotlib');
    expect(model.language).toBe('python');
    expect(model.revision).toBe(3);
    expect(model.svg).toBe('<svg>python</svg>');
    expect(model.manifest).toBe(manifest); // same reference
    expect(model.objects).toHaveLength(3);
    expect(model.objects[0].id).toBe('title.0');
    expect(model.globals).toEqual(manifest.globals);
    expect(model.colorGroups).toHaveLength(1);
    expect(model.palettes).toHaveLength(1);
    expect(model.groups).toHaveLength(1);
    expect(model.bindings).toHaveLength(1);
    expect(model.capabilities.localPatch).toBe(true);
    expect(model.capabilities.backendPatch).toBe(true);
    expect(model.capabilities.codePatch).toBe(true);
    expect(model.editLog).toHaveLength(1);
    expect(model.fingerprint).toBe('fp_123');
    expect(model.codeSlice?.figureId).toBe('fig_1');
    expect(model.unsupportedNotes).toEqual(['FancyArrowPatch not supported']);
  });

  it('normalizes an R manifest input', () => {
    const manifest = makeRManifest();
    const input: StandardFigureInput = {
      manifest,
      language: 'r',
      svg: '<svg>r plot</svg>',
    };
    const model = normalizeFigureModel(input);

    expect(model.engine).toBe('r_ggplot');
    expect(model.language).toBe('r');
    expect(model.figureId).toBe('fig_1'); // default
    expect(model.revision).toBe(0); // default
    expect(model.objects).toHaveLength(2);
    expect(model.capabilities.localPatch).toBe(false);
    expect(model.capabilities.codePatch).toBe(false);
    expect(model.editLog).toEqual([]);
    expect(model.colorGroups).toEqual([]);
    expect(model.palettes).toEqual([]);
    expect(model.groups).toEqual([]);
    expect(model.bindings).toEqual([]);
    expect(model.warnings).toEqual([]);
  });

  it('defaults missing optional fields', () => {
    const manifest = makeRManifest();
    const model = normalizeFigureModel({ manifest });
    expect(model.figureId).toBe('fig_1');
    expect(model.revision).toBe(0);
    expect(model.svg).toBe('');
    expect(model.editLog).toEqual([]);
    expect(model.warnings).toEqual([]);
    expect(model.fingerprint).toBeUndefined();
    expect(model.codeSlice).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// normalizeRenderResponse
// ---------------------------------------------------------------------------

describe('normalizeRenderResponse', () => {
  it('converts a render response to StandardFigureModel', () => {
    const manifest = makePythonManifest();
    const response: RenderResponse = {
      status: 'success',
      sessionId: 'sess_001',
      language: 'python',
      svg: '<svg>rendered</svg>',
      manifest,
      revision: 2,
      editLog: [
        { gid: 'title.0', prop: 'fontsize', value: 16, mode: 'backend_patch', timestamp: 500 },
      ],
      timingMs: 1234,
      message: 'Rendered successfully',
    };
    const model = normalizeRenderResponse(response, 'fig_2');

    expect(model.figureId).toBe('fig_2');
    expect(model.engine).toBe('python_matplotlib');
    expect(model.svg).toBe('<svg>rendered</svg>');
    expect(model.revision).toBe(2);
    expect(model.editLog).toHaveLength(1);
    expect(model.warnings).toEqual(['Rendered successfully']);
  });

  it('defaults figureId to fig_1 when not specified', () => {
    const response: RenderResponse = {
      status: 'success',
      sessionId: 'sess_002',
      svg: '<svg/>',
      manifest: makeRManifest(),
      revision: 1,
      timingMs: 100,
    };
    const model = normalizeRenderResponse(response);
    expect(model.figureId).toBe('fig_1');
  });
});

// ---------------------------------------------------------------------------
// normalizeProjectFigure — legacy SavedEditEntry compatibility
// ---------------------------------------------------------------------------

describe('normalizeProjectFigure (legacy compatibility)', () => {
  it('normalizes a FigureEntry with modern editLog', () => {
    const figure: FigureEntry = {
      figureId: 'fig_3',
      index: 2,
      manifest: makePythonManifest(),
      editLog: [
        { gid: 'title.0', prop: 'text', value: 'New', mode: 'backend_patch', timestamp: 1234 },
      ],
      revision: 5,
      svg: '<svg>fig3</svg>',
      fingerprint: 'fp_fig3',
    };
    const model = normalizeProjectFigure(figure, 'python');
    expect(model).not.toBeNull();
    expect(model!.figureId).toBe('fig_3');
    expect(model!.engine).toBe('python_matplotlib');
    expect(model!.revision).toBe(5);
    expect(model!.editLog).toHaveLength(1);
    expect(model!.editLog[0].mode).toBe('backend_patch');
    expect(model!.editLog[0].timestamp).toBe(1234);
  });

  it('normalizes legacy SavedEditEntry with missing mode and timestamp', () => {
    const figure: FigureEntry = {
      figureId: 'fig_legacy',
      index: 0,
      manifest: makePythonManifest(),
      editLog: [
        // Legacy entry: no mode, no timestamp
        { gid: 'title.0', prop: 'fontsize', value: 18 } as SavedEditEntry,
        // Legacy entry: mode is some unexpected string
        { gid: 'axis.x.0', prop: 'limits', value: [0, 5], mode: 'some_old_mode' } as SavedEditEntry,
        // Modern entry with local_patch
        { gid: 'legend.0', prop: 'visible', value: false, mode: 'local_patch', timestamp: 9999 },
      ],
      revision: 1,
    };
    const model = normalizeProjectFigure(figure, 'python');
    expect(model).not.toBeNull();
    const log = model!.editLog;
    expect(log).toHaveLength(3);

    // Legacy entry without mode → defaults to backend_patch
    expect(log[0].mode).toBe('backend_patch');
    expect(log[0].timestamp).toBe(0);
    expect(log[0].gid).toBe('title.0');
    expect(log[0].value).toBe(18);

    // Legacy entry with unknown mode → defaults to backend_patch
    expect(log[1].mode).toBe('backend_patch');
    expect(log[1].timestamp).toBe(0);

    // Modern entry with local_patch → preserved
    expect(log[2].mode).toBe('local_patch');
    expect(log[2].timestamp).toBe(9999);
  });

  it('returns null for FigureEntry without manifest', () => {
    const figure: FigureEntry = {
      figureId: 'fig_empty',
      index: 0,
      manifest: null as any,
      editLog: [],
      revision: 0,
    };
    const model = normalizeProjectFigure(figure);
    expect(model).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// normalizeProjectFigures
// ---------------------------------------------------------------------------

describe('normalizeProjectFigures', () => {
  it('normalizes an array of FigureEntries', () => {
    const figures: FigureEntry[] = [
      {
        figureId: 'fig_1',
        index: 0,
        manifest: makePythonManifest(),
        editLog: [],
        revision: 1,
        svg: '<svg>1</svg>',
      },
      {
        figureId: 'fig_2',
        index: 1,
        manifest: makeRManifest(),
        editLog: [{ gid: 'text.title.0', prop: 'text', value: 'Changed' } as SavedEditEntry],
        revision: 2,
        svg: '<svg>2</svg>',
      },
    ];
    const project = normalizeProjectFigures('proj_001', figures, 'python');

    expect(project.schemaVersion).toBe('1.0');
    expect(project.projectId).toBe('proj_001');
    expect(project.figures).toHaveLength(2);
    expect(project.figures[0].figureId).toBe('fig_1');
    expect(project.figures[1].figureId).toBe('fig_2');
    // Fig 2 has r_svg manifest, so engine should be r_ggplot regardless of project language
    expect(project.figures[1].engine).toBe('r_ggplot');
  });

  it('normalizes a Record of FigureEntries', () => {
    const figures: Record<string, FigureEntry> = {
      fig_a: {
        figureId: 'fig_a',
        index: 0,
        manifest: makePythonManifest(),
        editLog: [],
        revision: 1,
      },
    };
    const project = normalizeProjectFigures('proj_002', figures);
    expect(project.figures).toHaveLength(1);
    expect(project.figures[0].figureId).toBe('fig_a');
  });

  it('filters out figures without manifests', () => {
    const figures: FigureEntry[] = [
      {
        figureId: 'fig_ok',
        index: 0,
        manifest: makePythonManifest(),
        editLog: [],
        revision: 1,
      },
      {
        figureId: 'fig_no_manifest',
        index: 1,
        manifest: null as any,
        editLog: [],
        revision: 0,
      },
    ];
    const project = normalizeProjectFigures('proj_003', figures);
    expect(project.figures).toHaveLength(1);
    expect(project.figures[0].figureId).toBe('fig_ok');
  });

  it('handles empty figures array', () => {
    const project = normalizeProjectFigures('proj_empty', []);
    expect(project.figures).toEqual([]);
  });
});
