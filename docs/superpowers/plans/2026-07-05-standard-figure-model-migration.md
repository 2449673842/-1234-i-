# StandardFigureModel Migration Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Gradually migrate SciFigure Studio from separate Python/R frontend handling to a shared `StandardFigureModel` contract without regressing the existing Python Matplotlib and R ggplot render/edit paths.

**Architecture:** Keep Python and R renderers unchanged. Normalize their existing `manifest + svg + editLog` outputs into `StandardFigureModel`, then migrate UI consumers one module at a time. The raw `manifest` remains the source of truth until all editors are migrated and tested.

**Tech Stack:** React + TypeScript, Vite, Node API, Python Matplotlib renderer, R ggplot renderer, existing Manifest/EditLog protocol.

---

## Non-Negotiable Constraints

- Do not rewrite `renderer/introspector.py` or `renderer/r_renderer.R` during Tasks 1-4 unless a test proves a renderer bug.
- Do not remove `manifest`, `svg`, `editLog`, or `generatedBy` fields from existing responses.
- Do not replace `RightSidebar.tsx` wholesale. Migrate one helper or panel at a time.
- Do not change database schema in this plan.
- Do not delete Python/R-specific behavior until both engines pass equivalent tests.
- Every task must end with `npx tsc --noEmit`. Larger tasks must also run `npm run build`.
- If browser behavior is changed, verify with a real browser or Playwright, not only TypeScript.

## Current Baseline

- Backup commit before this work: `ada3dc2 stabilize R editing before protocol unification`.
- First protocol-layer commit: `7c5a337 Introduce a shared figure model before renderer unification`.
- Current branch: `feature/standard-figure-model-v1`.
- Existing protocol files:
  - `src/schemas/standardFigureModel.ts`
  - `src/utils/standardFigureModel.ts`
  - `docs/STANDARD_FIGURE_MODEL_V1.md`

## File Structure

- `src/schemas/standardFigureModel.ts`
  - Owns the shared TypeScript contract.
- `src/utils/standardFigureModel.ts`
  - Owns all normalization from existing render/project structures.
- `src/utils/standardFigureModel.test.ts`
  - Add pure unit-style assertions for the normalizer.
- `src/components/MainWorkspace.tsx`
  - First read-only integration point for passing normalized models down.
- `src/components/RightSidebar.tsx`
  - Gradual migration target for object grouping, font center, palette center, and component center.
- `src/components/ChartPreview.tsx`
  - Later migration target for selection and drag-capable object lookup.
- `src/components/ExportSettingsPage.tsx`
  - Later migration target for export consistency checks.
- `docs/STANDARD_FIGURE_MODEL_V1.md`
  - Update after each task with actual migration status.

---

## Task 1: Add Normalizer Regression Tests

**Files:**
- Modify: `src/utils/standardFigureModel.ts`
- Create: `src/utils/standardFigureModel.test.ts`
- Modify: `package.json` only if no existing script can run the test.

- [ ] **Step 1: Inspect current scripts**

Run:

```powershell
Get-Content package.json
```

Expected: identify whether there is an existing test runner. If none exists, do not add a large dependency. Use `tsx` only if already installed; otherwise create a small TypeScript file compiled by `tsc`.

- [ ] **Step 2: Create normalizer sample data**

Create `src/utils/standardFigureModel.test.ts` with direct assertions:

```ts
import { inferFigureEngine, normalizeFigureModel, normalizeProjectFigures } from './standardFigureModel';
import type { Manifest } from '../schemas/manifest';
import type { FigureEntry } from '../types';

function assert(condition: unknown, message: string): void {
  if (!condition) {
    throw new Error(message);
  }
}

const pythonManifest: Manifest = {
  generatedBy: 'introspection',
  globals: {},
  objects: [
    {
      id: 'title.0',
      kind: 'text',
      label: 'Title',
      editable: ['text', 'fontsize'],
      currentProps: { text: 'A', fontsize: 12 },
      role: 'figure_title',
    },
  ],
  capabilities: { localPatch: true, backendPatch: true, codePatch: true },
};

const rManifest: Manifest = {
  generatedBy: 'r_svg',
  globals: {},
  objects: [
    {
      id: 'axis.x.0',
      kind: 'axis_x',
      label: 'X Axis',
      editable: ['limits'],
      currentProps: { limits: [0, 1] },
      role: 'x_axis',
    },
  ],
  capabilities: { localPatch: false, backendPatch: true, codePatch: false },
};

assert(inferFigureEngine(pythonManifest) === 'python_matplotlib', 'Python manifest should infer python_matplotlib');
assert(inferFigureEngine(rManifest) === 'r_ggplot', 'R manifest should infer r_ggplot');

const model = normalizeFigureModel({
  figureId: 'fig_a',
  language: 'python',
  svg: '<svg />',
  manifest: pythonManifest,
  revision: 3,
  editLog: [{ gid: 'title.0', prop: 'text', value: 'B', mode: 'backend_patch', timestamp: 1 }],
});

assert(model.schemaVersion === '1.0', 'schemaVersion should be 1.0');
assert(model.objects[0].props.text === 'A', 'object props should mirror currentProps');
assert(model.manifest === pythonManifest, 'raw manifest must be preserved by reference');

const projectFigure: FigureEntry = {
  figureId: 'fig_r',
  index: 0,
  manifest: rManifest,
  editLog: [{ gid: 'axis.x.0', prop: 'limits', value: [0, 2], mode: undefined, timestamp: undefined }],
  revision: 1,
  svg: '<svg />',
};

const projectModel = normalizeProjectFigures('project_1', [projectFigure], 'r');

assert(projectModel.figures.length === 1, 'project should keep one normalized figure');
assert(projectModel.figures[0].editLog[0].mode === 'backend_patch', 'legacy missing mode should default to backend_patch');
assert(projectModel.figures[0].editLog[0].timestamp === 0, 'legacy missing timestamp should default to 0');

console.log('standardFigureModel tests passed');
```

- [ ] **Step 3: Make the test runnable without new dependencies**

If `tsx` is already available in `devDependencies`, add:

```json
"test:standard-model": "tsx src/utils/standardFigureModel.test.ts"
```

If `tsx` is not available, do not add a dependency. Instead rely on `npx tsc --noEmit` for type coverage and skip a runtime script. Record this in the task report.

- [ ] **Step 4: Run verification**

Run:

```powershell
npx tsc --noEmit
npm run build
```

If a runtime script was added, also run:

```powershell
npm run test:standard-model
```

Expected: all pass.

- [ ] **Step 5: Commit**

Commit only files touched in Task 1:

```powershell
git add src\utils\standardFigureModel.ts src\utils\standardFigureModel.test.ts package.json
git commit -m "Validate the shared figure model normalizer" -m "Constraint: Keep validation independent from renderer behavior.\nRejected: Adding a full test framework | unnecessary for this narrow protocol check.\nConfidence: high\nScope-risk: narrow\nDirective: Keep protocol tests pure and renderer-free.\nTested: npx tsc --noEmit; npm run build; npm run test:standard-model if available.\nNot-tested: Browser UI consumers."
```

---

## Task 2: Add Read-Only Standard Model Debug Integration

**Files:**
- Modify: `src/components/MainWorkspace.tsx`
- Modify: `src/components/ManifestViewer.tsx`
- Modify: `docs/STANDARD_FIGURE_MODEL_V1.md`

- [ ] **Step 1: Locate current manifest viewer props**

Run:

```powershell
rg "ManifestViewer|figSession|projectFigures|manifest" src\components\MainWorkspace.tsx src\components\ManifestViewer.tsx
```

Expected: identify the exact prop shape before editing.

- [ ] **Step 2: Compute standard model in MainWorkspace without changing behavior**

Import normalizer:

```ts
import { normalizeFigureModel } from '../utils/standardFigureModel';
```

Where the active figure/session is already known, compute:

```ts
const standardFigureModel = activeManifest
  ? normalizeFigureModel({
      figureId: activeFigureId ?? figSession?.sessionId ?? 'fig_1',
      language: figSession?.language ?? spec.script_language,
      svg: activeSvg ?? figSession?.svg ?? '',
      manifest: activeManifest,
      revision: activeRevision ?? figSession?.revision ?? 0,
      editLog: activeEditLog ?? figSession?.editLog ?? [],
      fingerprint: activeFigure?.fingerprint,
      codeSlice: activeFigure?.codeSlice ?? null,
    })
  : null;
```

Use the actual variable names from the file. Do not introduce a second source of truth; this value must be derived only from existing state.

- [ ] **Step 3: Pass model to ManifestViewer as optional debug data**

Extend props:

```ts
interface ManifestViewerProps {
  manifest: Manifest | null;
  standardModel?: StandardFigureModel | null;
}
```

Render only small metadata, not the full SVG:

```tsx
{standardModel && (
  <div className="mb-4 rounded border border-cyan-500/30 bg-cyan-500/5 p-3 text-xs text-cyan-100">
    <div>Standard Model: {standardModel.engine}</div>
    <div>Objects: {standardModel.objects.length}</div>
    <div>Revision: {standardModel.revision}</div>
  </div>
)}
```

- [ ] **Step 4: Guard object rendering**

Fix any manifest fields that may be objects before rendering them into `<span>`. Use:

```ts
function renderDebugValue(value: unknown): string {
  if (value === null || value === undefined) return '';
  if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') return String(value);
  return JSON.stringify(value);
}
```

This directly prevents the known React crash: `Objects are not valid as a React child`.

- [ ] **Step 5: Run verification**

Run:

```powershell
npx tsc --noEmit
npm run build
```

Then manually open the editor page and confirm:

- Existing figure still renders.
- Manifest panel does not crash on `coverageReport.summary`.
- Standard model metadata appears.
- No edit behavior changes.

- [ ] **Step 6: Commit**

```powershell
git add src\components\MainWorkspace.tsx src\components\ManifestViewer.tsx docs\STANDARD_FIGURE_MODEL_V1.md
git commit -m "Expose the shared figure model as read-only debug data" -m "Constraint: Do not change edit behavior while introducing the standard model.\nRejected: Replacing ManifestViewer with a new debug panel | unnecessary and higher risk.\nConfidence: medium\nScope-risk: moderate\nDirective: Keep standard model derived from current state only.\nTested: npx tsc --noEmit; npm run build; browser smoke check.\nNot-tested: Full component-center migration."
```

---

## Task 3: Migrate Component Grouping Helpers to Standard Objects

**Files:**
- Modify: `src/components/RightSidebar.tsx`
- Optional create: `src/utils/figureObjectGroups.ts`

- [ ] **Step 1: Extract grouping without changing UI**

Search:

```powershell
rg "getFontGroups|get.*Groups|ManifestObject|manifest.objects|generatedBy" src\components\RightSidebar.tsx
```

Identify helpers that only group/read objects. Do not touch patch sending yet.

- [ ] **Step 2: Create a pure grouping utility if RightSidebar is too large**

Create `src/utils/figureObjectGroups.ts`:

```ts
import type { StandardFigureObject } from '../schemas/standardFigureModel';

export interface FigureObjectGroup {
  id: string;
  label: string;
  objects: StandardFigureObject[];
}

export function groupObjectsByRole(objects: StandardFigureObject[]): FigureObjectGroup[] {
  const map = new Map<string, StandardFigureObject[]>();
  for (const object of objects) {
    const key = object.role || object.kind || 'unknown';
    map.set(key, [...(map.get(key) ?? []), object]);
  }
  return Array.from(map.entries()).map(([id, groupedObjects]) => ({
    id,
    label: id,
    objects: groupedObjects,
  }));
}
```

- [ ] **Step 3: Feed the utility with normalized objects**

Inside `RightSidebar`, derive standard objects from existing `manifest`:

```ts
const standardModel = figSession?.manifest
  ? normalizeFigureModel({
      figureId: figSession.sessionId,
      language: figSession.language,
      svg: figSession.svg,
      manifest: figSession.manifest,
      revision: figSession.revision,
      editLog: figSession.editLog,
    })
  : null;
```

Use `standardModel?.objects ?? []` only in read-only grouping helpers. Do not change patch payloads in this task.

- [ ] **Step 4: Verify no UI behavior changed**

Run:

```powershell
npx tsc --noEmit
npm run build
```

Manual browser checks:

- Python figure component center still lists the same categories.
- R figure component center still lists objects.
- Clicking a group still selects the same GIDs.
- Editing a selected object still sends the old patch format.

- [ ] **Step 5: Commit**

```powershell
git add src\components\RightSidebar.tsx src\utils\figureObjectGroups.ts
git commit -m "Read component groups from standard figure objects" -m "Constraint: Preserve existing patch payloads while moving grouping reads to StandardFigureModel.\nRejected: Rewriting RightSidebar patch flow | too risky before read migration is proven.\nConfidence: medium\nScope-risk: moderate\nDirective: Patch generation must remain manifest-compatible until all groups are migrated.\nTested: npx tsc --noEmit; npm run build; browser smoke check for Python and R figures.\nNot-tested: Drag mode migration."
```

---

## Task 4: Migrate Font Center Reads, Keep Patch Writes Unchanged

**Files:**
- Modify: `src/components/RightSidebar.tsx`
- Optional modify: `src/utils/figureObjectGroups.ts`

- [ ] **Step 1: Identify font center source**

Run:

```powershell
rg "font|Font|fontsize|fontfamily|getFontGroups|legend_text|xticks|yticks" src\components\RightSidebar.tsx
```

Expected: find the current `getFontGroups` or equivalent logic.

- [ ] **Step 2: Implement role-based font grouping**

Add a pure helper:

```ts
export function getStandardFontGroups(objects: StandardFigureObject[]): FigureObjectGroup[] {
  const fontRoles = new Map<string, string[]>([
    ['titles', ['figure_title', 'axes_title']],
    ['xlabels', ['x_axis_label']],
    ['ylabels', ['y_axis_label']],
    ['xticks', ['x_tick_label']],
    ['yticks', ['y_tick_label']],
    ['legend_text', ['legend_text']],
    ['other_text', ['annotation', 'text']],
  ]);

  return Array.from(fontRoles.entries())
    .map(([id, roles]) => ({
      id,
      label: id,
      objects: objects.filter((object) => object.kind === 'text' && roles.includes(object.role ?? 'text')),
    }))
    .filter((group) => group.objects.length > 0);
}
```

If existing R roles differ, adapt by reading actual manifest roles from a real R render. Do not guess.

- [ ] **Step 3: Use standard font groups in the panel**

Replace only the read side of the font group list. Existing patch calls must still use object `id`, `prop`, and `value`.

- [ ] **Step 4: Browser verify the exact bug class**

Manual checks:

- Select X tick group and change font size.
- Confirm all X tick labels in a multi-panel Python figure update after rerender.
- Select Y tick group and change font size.
- Confirm all Y tick labels update after rerender.
- Repeat with one R figure if available.

- [ ] **Step 5: Run automated checks**

```powershell
npx tsc --noEmit
npm run build
```

- [ ] **Step 6: Commit**

```powershell
git add src\components\RightSidebar.tsx src\utils\figureObjectGroups.ts
git commit -m "Read font center groups from standard figure roles" -m "Constraint: Keep font patch payloads unchanged.\nRejected: Combining font and palette migration | separate failure domains.\nConfidence: medium\nScope-risk: moderate\nDirective: Verify multi-panel tick labels in browser before claiming completion.\nTested: npx tsc --noEmit; npm run build; browser font-center checks.\nNot-tested: Palette-center migration."
```

---

## Task 5: Migrate Palette Center Reads, Preserve Safe Scope Writes

**Files:**
- Modify: `src/components/RightSidebar.tsx`
- Optional modify: `src/utils/figureObjectGroups.ts`

- [ ] **Step 1: Identify palette center code paths**

Run:

```powershell
rg "palette|Palette|colorGroups|bindings|code_patch|selectedTargets|isSubsetEditing" src\components\RightSidebar.tsx
```

Expected: identify both read grouping and write scope selection.

- [ ] **Step 2: Read palettes and bindings from StandardFigureModel**

Use:

```ts
const palettes = standardModel?.palettes ?? [];
const bindings = standardModel?.bindings ?? [];
const colorGroups = standardModel?.colorGroups ?? [];
```

Do not change the distinction between:

- selected subset attribute patch
- whole-group `code_patch`

- [ ] **Step 3: Make the UI show what will be changed**

For every palette/group row, show:

```tsx
<span>{selectedCount > 0 ? `仅已选 ${selectedCount} 个` : `整组 ${allCount} 个`}</span>
```

This addresses the user complaint that palette center does not make clear “who is being edited”.

- [ ] **Step 4: Browser verify subset vs whole group**

Manual checks:

- Select one scatter subgroup point/series.
- Change color using “only selected”.
- Confirm only selected GIDs change.
- Change color using “whole code constant”.
- Confirm whole group changes.
- Undo both operations separately.

- [ ] **Step 5: Run checks**

```powershell
npx tsc --noEmit
npm run build
```

- [ ] **Step 6: Commit**

```powershell
git add src\components\RightSidebar.tsx
git commit -m "Read palette center data from the standard figure model" -m "Constraint: Preserve subset-vs-whole-group color editing semantics.\nRejected: Forcing all palette edits through code_patch | caused previous accidental whole-group edits.\nConfidence: medium\nScope-risk: moderate\nDirective: Always show selected target counts before applying palette changes.\nTested: npx tsc --noEmit; npm run build; browser subset color edit and undo.\nNot-tested: Drag mode."
```

---

## Task 6: Prepare Drag Mode on Standard Position-Capable Objects

**Files:**
- Modify: `src/components/ChartPreview.tsx`
- Modify: `src/components/MainWorkspace.tsx`
- Optional create: `src/utils/dragPatch.ts`

- [ ] **Step 1: Define drag eligibility**

Create `src/utils/dragPatch.ts`:

```ts
import type { StandardFigureObject } from '../schemas/standardFigureModel';

export function isDragCapableObject(object: StandardFigureObject): boolean {
  return object.editable.includes('position')
    || object.editable.includes('x')
    || object.editable.includes('y')
    || object.editable.includes('left')
    || object.editable.includes('bottom');
}
```

- [ ] **Step 2: Keep drag mode opt-in**

In `ChartPreview.tsx`, ensure normal single-click selection works when drag mode is off:

```ts
if (!dragModeEnabled) {
  handleNormalSelection(event);
  return;
}
```

Do not require spacebar when drag mode is on. Drag mode means drag-only mode.

- [ ] **Step 3: Record final drag patch only**

Store draft drag deltas in local component state:

```ts
interface DraftDragPatch {
  gid: string;
  prop: 'position' | 'x' | 'y' | 'bounds';
  value: unknown;
}
```

On pointer move: only update SVG preview transform.

On pointer up: compute final patch and add it to `pendingDragPatches`. Do not call backend yet.

- [ ] **Step 4: Add confirm/cancel bar**

Show a fixed confirm bar when `pendingDragPatches.length > 0`:

```tsx
<button onClick={confirmDragPatches}>确认移动 {pendingDragPatches.length} 项</button>
<button onClick={cancelDragPatches}>取消</button>
```

Confirm sends all patches once. Cancel clears transforms and pending patches.

- [ ] **Step 5: Verify multi-drag behavior**

Manual checks:

- Drag one text label, release, it stays visually at final position.
- Drag a second label before confirming.
- Confirm bar says 2 items.
- Confirm sends both patches.
- Undo returns both moves according to existing undo stack behavior.
- Drag mode off: normal click selection still works.

- [ ] **Step 6: Run checks**

```powershell
npx tsc --noEmit
npm run build
```

- [ ] **Step 7: Commit**

```powershell
git add src\components\ChartPreview.tsx src\components\MainWorkspace.tsx src\utils\dragPatch.ts
git commit -m "Stage drag edits through standard position-capable objects" -m "Constraint: Drag mode must be opt-in and must not break normal selection.\nRejected: Sending backend patches on every pointer move | too slow and caused flicker.\nConfidence: medium\nScope-risk: broad\nDirective: Only final pointer-up patches may enter editLog.\nTested: npx tsc --noEmit; npm run build; browser drag confirm/cancel smoke test.\nNot-tested: All matplotlib transform variants."
```

---

## Task 7: Update Documentation and Migration Status

**Files:**
- Modify: `docs/STANDARD_FIGURE_MODEL_V1.md`
- Modify: `docs/ERROR_LOG.md` only if bugs were fixed during migration.

- [ ] **Step 1: Update migration matrix**

Add this table to `docs/STANDARD_FIGURE_MODEL_V1.md`:

```md
## Migration Status

| Module | Status | Notes |
|---|---|---|
| Normalizer | Complete | Pure TypeScript, renderer-free |
| ManifestViewer | Read-only integrated | No edit behavior change |
| Component Center | Migrated reads | Patch writes unchanged |
| Font Center | Migrated reads | Patch writes unchanged |
| Palette Center | Migrated reads | Subset/code_patch split preserved |
| Drag Mode | Pending/Complete | Update after Task 6 |
| Export | Pending | Still uses existing manifest/session path |
```

- [ ] **Step 2: Record any real regressions**

Only add to `docs/ERROR_LOG.md` if a bug was reproduced and fixed. Include:

- symptoms
- root cause
- files changed
- verification

- [ ] **Step 3: Final verification**

Run:

```powershell
npx tsc --noEmit
npm run build
C:\Users\SZC\.conda\envs\Machine-learning\python.exe tests\test_r_renderer.py
C:\Users\SZC\.conda\envs\Machine-learning\python.exe tests\test_introspection.py
```

- [ ] **Step 4: Commit**

```powershell
git add docs\STANDARD_FIGURE_MODEL_V1.md docs\ERROR_LOG.md
git commit -m "Document standard figure model migration status" -m "Constraint: Keep documentation tied to verified implementation state.\nRejected: Marking pending modules complete without browser checks | previously caused false completion claims.\nConfidence: high\nScope-risk: narrow\nDirective: Do not advance migration status without evidence.\nTested: npx tsc --noEmit; npm run build; Python and R renderer tests.\nNot-tested: Any module still marked Pending."
```

---

## Final Acceptance Criteria

The migration is acceptable only when:

- Existing Python figures still render, edit, undo, redo, and export.
- Existing R figures still render and support the currently implemented edit subset.
- `RightSidebar` can read groups from `StandardFigureModel` without Python/R `generatedBy` branching for read grouping.
- Patch writes still use existing stable `gid/prop/value/mode` structures.
- Drag mode is opt-in, records only final positions, and does not break normal click selection.
- Browser checks are performed for any UI behavior change.
- `docs/STANDARD_FIGURE_MODEL_V1.md` accurately lists completed vs pending modules.

## Known Stop Conditions

Stop and report before continuing if:

- A renderer test fails after a UI-only change.
- A patch format change appears necessary.
- A database schema change appears necessary.
- R and Python cannot share a grouping rule without losing behavior.
- Browser shows a regression in normal click selection or edit application.

