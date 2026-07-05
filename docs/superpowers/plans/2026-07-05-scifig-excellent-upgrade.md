# scifig优秀升级版 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Upgrade SciFigure Studio into a more maintainable, faster, and safer multi-engine scientific figure workspace by unifying Python/R figure protocols and adding per-figure incremental rendering with concurrency guards.

**Architecture:** Keep Python Matplotlib and R ggplot renderers as separate engines, but normalize both into `StandardFigureModel`. Treat each figure in a project as an independently versioned render unit with its own `revision`, `editLog`, `renderStatus`, `requestId`, and cache key. Repaint only the affected figure unless a code/data/global-style change proves a wider invalidation is required.

**Tech Stack:** React + TypeScript, Vite, Node API, SQLite project state, Python Matplotlib renderer, R ggplot renderer, existing Manifest/EditLog protocol, new `StandardFigureModel` protocol layer.

---

## 0. Non-Negotiable Constraints

- Do not rewrite Python and R renderers into one engine. The target is **two engines, one protocol**.
- Do not remove old response fields (`svg`, `manifest`, `editLog`, `generatedBy`) until all frontend consumers have migrated.
- Do not replace `RightSidebar.tsx`, `ChartPreview.tsx`, or `MainWorkspace.tsx` wholesale.
- Do not let one figure patch refresh all project figures unless the invalidation scope is explicitly project-wide.
- Do not allow stale render responses to overwrite newer figure state.
- Do not claim UI behavior complete without real browser verification.
- Keep changes phase-gated. Each task must be independently testable and revertible.
- Prioritize stale-response protection before broad UI migration. Current patch flow already creates request IDs in places, but a response that is not checked can still overwrite newer state.

## 1. Baseline

- Backup commit before protocol work: `ada3dc2 stabilize R editing before protocol unification`.
- Existing protocol-layer commit: `7c5a337 Introduce a shared figure model before renderer unification`.
- Current branch: `feature/standard-figure-model-v1`.
- Existing files:
  - `src/schemas/standardFigureModel.ts`
  - `src/utils/standardFigureModel.ts`
  - `docs/STANDARD_FIGURE_MODEL_V1.md`
  - `docs/superpowers/plans/2026-07-05-standard-figure-model-migration.md`

---

## 2. Target Concepts

### 2.1 StandardFigureModel

`StandardFigureModel` is the frontend-facing normalized figure model:

```ts
interface StandardFigureModel {
  schemaVersion: '1.0';
  figureId: string;
  engine: 'python_matplotlib' | 'r_ggplot' | 'unknown';
  language?: 'python' | 'r';
  revision: number;
  svg: string;
  manifest: Manifest;
  globals: Record<string, ManifestField>;
  objects: StandardFigureObject[];
  palettes: Palette[];
  groups: SemanticGroup[];
  bindings: Binding[];
  capabilities: StandardFigureCapabilities;
  editLog: EditEntry[];
}
```

The raw `manifest` remains the source of truth. Normalized fields are a stable read model for UI code.

### 2.2 Per-Figure Render State

Each project figure must have independent render state:

```ts
interface FigureRenderState {
  figureId: string;
  revision: number;
  editLog: EditEntry[];
  manifest: Manifest | null;
  svg: string;
  fingerprint?: string;
  renderStatus: 'idle' | 'queued' | 'rendering' | 'success' | 'error';
  latestRequestId?: string;
  lastRenderCacheKey?: string;
  error?: string;
}
```

### 2.3 Render Scope

Every edit must be classified before rendering:

| Scope | Meaning | Render behavior |
|---|---|---|
| `local_patch` | Safe frontend SVG-only operation | No backend render |
| `figure_patch` | Affects only one figure | Render only `figureId` |
| `project_patch` | Affects selected multiple figures | Render selected figures only |
| `code_patch` | Script logic may affect registry | Recompute registry, compare fingerprints |
| `data_patch` | Dataset changed | Invalidate figures depending on that dataset |

### 2.4 Draft Patch Batch

Parameter editing must not trigger backend rendering after every single control change. Real scientific figure styling is usually a batch operation:

```text
Set X axis label font family -> Times New Roman
Set Y axis label font family -> Times New Roman
Set tick label font size -> 8
Set legend font size -> 7
Render once
```

Use a draft batch model:

```ts
interface DraftPatchBatch {
  batchId: string;
  figureIds: string[];
  patches: Array<{
    gid: string;
    prop: string;
    value: unknown;
    mode: 'backend_patch' | 'local_patch';
  }>;
  status: 'draft' | 'applying' | 'applied' | 'cancelled';
  createdAt: number;
  updatedAt: number;
}
```

Rules:

- Slider/input changes update draft state, not backend render.
- Draft patches are last-write-wins by `${figureId}:${gid}:${prop}`. If the user changes X tick fontsize from 10 to 12 before applying, the draft contains one final patch, not two historical patches.
- Drafts are bucketed by `figureId`. Switching figures preserves the previous figure draft and shows a non-blocking notice such as `Figure 1 有 3 项未应用的修改`.
- Safe frontend-only changes may preview locally, but the committed state still waits for apply.
- Backend render happens only when the user clicks apply.
- Applying a draft creates one editLog batch and one render job per affected figure.
- Cancel discards draft values and restores committed manifest values.
- Undo/redo should show the applied draft as one user action, not many micro-actions.

Control behavior:

| Control type | Behavior | Reason |
|---|---|---|
| Font family / fontsize / bold / italic / underline | Draft | Usually edited as a coordinated set |
| Text color / line color / fill color | Draft with safe preview where possible | Avoid repeated backend renders |
| Axis limits | Draft | Requires backend recomputation |
| Line width / line style / marker size | Draft | Often backend-only or imprecise in SVG preview |
| Visibility | Immediate local patch when supported | Users expect instant show/hide feedback |
| Drag position | Dedicated drag confirm flow | Uses Phase F pending position patches |
| Code patch | Immediate explicit action | User intentionally edits script logic |

Safe preview boundaries:

- Safe preview: SVG `fill`, `stroke`, `visibility`, `display`, and `font-family` when the SVG node is directly addressable.
- Risky preview: `font-size` and `stroke-width`; may be shown as approximate preview but must still rerender on apply.
- No preview: axis limits, tick generation, layout bounds, subplot geometry, and code patches.

---

## 3. Phase A — Protocol Foundation

### Task A1: Lock Normalizer Tests

**Files:**
- Create: `src/utils/standardFigureModel.test.ts`
- Modify: `package.json` only if an existing lightweight runner is available.

- [ ] Add pure tests for `inferFigureEngine()`, `normalizeFigureModel()`, `normalizeProjectFigures()`.
- [ ] Include one Python manifest and one R manifest.
- [ ] Include legacy `SavedEditEntry` with missing `mode` and `timestamp`.
- [ ] Verify old edit entries normalize to `backend_patch` and timestamp `0`.
- [ ] Run:

```powershell
npx tsc --noEmit
npm run build
```

Expected: pass.

### Task A2: Add Read-Only Debug Integration

**Files:**
- Modify: `src/components/MainWorkspace.tsx`
- Modify: `src/components/ManifestViewer.tsx`

- [ ] Derive `StandardFigureModel` from current active figure/session.
- [ ] Pass it to `ManifestViewer` as optional debug data.
- [ ] Render only metadata: `engine`, `objects.length`, `revision`.
- [ ] Add safe value rendering to prevent React object-child crash:

```ts
function renderDebugValue(value: unknown): string {
  if (value === null || value === undefined) return '';
  if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') return String(value);
  return JSON.stringify(value);
}
```

- [ ] Browser verify ManifestViewer does not crash on `coverageReport.summary`.
- [ ] Run:

```powershell
npx tsc --noEmit
npm run build
```

---

## 4. Phase B — UI Read Migration

### Task B1: Component Center Reads Standard Objects

**Files:**
- Modify: `src/components/RightSidebar.tsx`
- Optional create: `src/utils/figureObjectGroups.ts`

- [ ] Extract object grouping into pure helper using `StandardFigureObject[]`.
- [ ] Keep existing patch writes unchanged.
- [ ] Verify Python and R figures still show component groups.
- [ ] Browser verify editing an object still sends existing `gid/prop/value/mode` patch.

### Task B2: Font Center Reads Standard Roles

**Files:**
- Modify: `src/components/RightSidebar.tsx`
- Optional modify: `src/utils/figureObjectGroups.ts`

- [ ] Group text objects by role:

```text
figure_title / axes_title -> titles
x_axis_label -> xlabels
y_axis_label -> ylabels
x_tick_label -> xticks
y_tick_label -> yticks
legend_text -> legend_text
annotation/text -> other_text
```

- [ ] Keep patch writes unchanged.
- [ ] Browser verify X tick and Y tick group edits persist after rerender.
- [ ] Browser verify multi-panel figures can target per-subplot text groups where roles/subplot IDs exist.

### Task B3: Palette Center Reads Standard Palettes

**Files:**
- Modify: `src/components/RightSidebar.tsx`

- [ ] Read `palettes`, `bindings`, and `colorGroups` from `StandardFigureModel`.
- [ ] Preserve two write modes:
  - selected subset attribute patch
  - whole-group code patch
- [ ] Show target counts before applying color changes:

```text
仅修改已选 3 个
修改整组 18 个
```

- [ ] Browser verify subset color edit does not recolor the whole scatter group.
- [ ] Browser verify undo works for color changes.

---

## 5. Phase C — Per-Figure Render Scheduler

Phase C is a stability prerequisite, not only a performance optimization. It prevents slow old responses from replacing newer user edits.

### Task C1: Define Figure Render Job Types

**Files:**
- Create: `src/schemas/renderScheduler.ts`
- Modify: `src/types.ts` only if needed.

Add:

```ts
export type RenderScope = 'local_patch' | 'figure_patch' | 'project_patch' | 'code_patch' | 'data_patch';

export interface FigureRenderJob {
  projectId: string;
  figureId: string;
  requestId: string;
  scope: RenderScope;
  baseRevision: number;
  targetRevision: number;
  editLogHash: string;
  scriptHash: string;
  dataHash: string;
  renderOptionsHash: string;
  createdAt: number;
}

export interface FigureRenderStatus {
  figureId: string;
  status: 'idle' | 'queued' | 'rendering' | 'success' | 'error';
  latestRequestId?: string;
  revision: number;
  message?: string;
}
```

Run:

```powershell
npx tsc --noEmit
```

### Task C2: Add Stable Cache Key Utility

**Files:**
- Create: `src/utils/renderCacheKey.ts`

Implement a deterministic browser-safe hash helper:

```ts
export function stableJson(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`;
  const obj = value as Record<string, unknown>;
  return `{${Object.keys(obj).sort().map((key) => `${JSON.stringify(key)}:${stableJson(obj[key])}`).join(',')}}`;
}

export async function sha256Text(input: string): Promise<string> {
  if (!globalThis.crypto?.subtle) {
    let hash = 2166136261;
    for (let i = 0; i < input.length; i += 1) {
      hash ^= input.charCodeAt(i);
      hash = Math.imul(hash, 16777619);
    }
    return `fnv1a:${(hash >>> 0).toString(16)}`;
  }
  const data = new TextEncoder().encode(input);
  const digest = await crypto.subtle.digest('SHA-256', data);
  return Array.from(new Uint8Array(digest)).map((byte) => byte.toString(16).padStart(2, '0')).join('');
}
```

The fallback is required because `crypto.subtle` can be unavailable outside secure contexts. A stable fallback is better than disabling cache keys.

Add:

```ts
export async function buildFigureRenderCacheKey(parts: {
  engine: string;
  figureId: string;
  scriptHash: string;
  dataHash: string;
  fingerprint?: string;
  editLog: unknown[];
  renderOptions?: unknown;
}): Promise<string> {
  return sha256Text(stableJson(parts));
}
```

Run:

```powershell
npx tsc --noEmit
```

### Task C3: Frontend Per-Figure Request Guard

**Files:**
- Modify: `src/App.tsx`
- Modify: `src/components/MainWorkspace.tsx`

- [ ] Add per-figure `latestRequestId`.
- [ ] When starting a render for `figureId`, set only that figure to `rendering`.
- [ ] When response returns, discard if:

```ts
response.requestId !== latestRequestIdByFigure[figureId]
```

- [ ] Also discard if:

```ts
response.revision < currentFigure.revision
```

- [ ] UI behavior:
  - Only the active/target figure shows “rendering”.
  - Other figures remain visible and switchable.
  - Failed render marks only the target figure as `error`.

Browser verification:

- Create/open project with multiple figures.
- Edit Figure 4.
- Confirm only Figure 4 shows loading and updates.
- Confirm Figures 1/2/3/5 SVGs are not replaced.

This task must be completed before Phase B broad UI migration if the current code path already emits `requestId` without checking returned `requestId`. Treat it as a hotfix-level stability task.

### Task C4: Patch Current Figure Only

**Files:**
- Modify: `src/hooks/useFigureSession.ts`
- Modify: `src/App.tsx`
- Modify: `server.ts` only if current API lacks `figureId`.

- [ ] Include `figureId` in figure patch requests where project figures exist.
- [ ] Server should apply editLog to the target figure session.
- [ ] Response should return the target figure only unless explicitly requested otherwise.
- [ ] Do not refresh `projectFigures` wholesale on single-figure patch.

Verification:

- Edit one figure title.
- Confirm only that figure revision increments.
- Confirm other figure revisions stay unchanged.
- Confirm undo affects only the active figure history.

---

## 6. Phase D — Draft Patch Batch and Apply-Once Editing

### Task D1: Add Draft Patch Types

**Files:**
- Create: `src/schemas/draftPatchBatch.ts`
- Modify: `src/schemas/renderScheduler.ts` if Task C1 already exists.

Add:

```ts
export type DraftPatchMode = 'local_patch' | 'backend_patch';

export interface DraftPatch {
  gid: string;
  prop: string;
  value: unknown;
  mode: DraftPatchMode;
}

export interface DraftPatchBatch {
  batchId: string;
  figureIds: string[];
  patches: DraftPatch[];
  status: 'draft' | 'applying' | 'applied' | 'cancelled';
  createdAt: number;
  updatedAt: number;
}
```

Run:

```powershell
npx tsc --noEmit
```

### Task D2: Add Draft State to RightSidebar

**Files:**
- Modify: `src/components/RightSidebar.tsx`

Rules:

- Font center, palette center, component center, and grouped controls must support draft edits.
- Existing immediate single-object editing can remain only for explicitly marked instant controls.
- Batch-capable controls must not call `onPatch` immediately.
- Batch-capable controls update `draftValues` keyed by:

```ts
`${figureId}:${gid}:${prop}`
```

Required UI:

```text
已暂存 6 项修改
[应用到当前图] [应用到选中图] [应用到全部图] [取消]
```

UI requirements:

- The draft bar is fixed at the bottom of `RightSidebar` and remains visible while scrolling.
- Modified controls show a small dirty marker.
- A collapsible draft detail list shows `label / prop / value`.
- Cancel asks for confirmation when more than one draft patch would be discarded.
- Switching figures does not discard drafts; it only changes which figure bucket is visible.

Verification:

- Change X label font family.
- Change Y label font family.
- Change tick label font size.
- Confirm no backend render starts before clicking apply.
- Click apply.
- Confirm one render job starts for the current figure.

### Task D3: Apply Draft as One Patch Batch

**Files:**
- Modify: `src/components/RightSidebar.tsx`
- Modify: `src/hooks/useFigureSession.ts`
- Modify: `src/App.tsx`

Rules:

- Apply sends all draft patches in one request.
- Target scope is explicit:
  - current figure
  - selected figures
  - all project figures
- For current figure, only current `figureId` enters render queue.
- For selected/all figures, create one render job per affected figure.
- Multi-figure apply uses a request pool with default concurrency `3`; do not fire 20 renderer jobs at once.
- Partial failures are reported per figure. Successful figures keep their applied result; failed figures keep draft/apply error state and can be retried.
- Undo/redo should treat the applied draft as one batch action.
- Move `pushProjectHistory` or equivalent history recording to the apply boundary. Draft changes must not enter history; one applied draft batch should create one undoable action.

Verification:

- Batch edit 5 font properties.
- Confirm edit history shows one batch action.
- Undo once reverts all 5 properties.
- Redo once reapplies all 5 properties.
- Apply to all on a project with more than 3 figures and confirm only 3 render jobs run concurrently.

### Task D4: Debounced Preview for Continuous Controls

**Files:**
- Modify: `src/components/RightSidebar.tsx`
- Modify: `src/utils/svgEditor.ts` only for safe local SVG preview helpers.

Rules:

- Text color, visibility, and simple SVG-safe color edits may preview locally.
- Font size, axis limits, subplot bounds, line width, and backend-only properties must not backend-render on every input event.
- Dragging a slider updates draft preview only.
- `pointerup` may update draft final value but must not backend-render.
- Backend render only happens on apply.

Verification:

- Drag font-size slider.
- Confirm no repeated backend calls during drag.
- Confirm draft count changes.
- Click apply.
- Confirm one backend call.

---

## 7. Phase E — Backend Targeted Render

### Task E1: API Contract for Targeted Project Render

**Files:**
- Modify: `server.ts`
- Modify: `src/schemas/manifest.ts` or create `src/schemas/projectRender.ts`

Add request shape without breaking old calls:

```ts
interface ProjectRenderRequest {
  projectId: string;
  figureId?: string;
  scope?: 'all' | 'figure';
  baseRevision?: number;
  requestId?: string;
}
```

Rules:

- Missing `figureId` keeps old all-render behavior.
- `scope: 'figure'` with `figureId` returns only that figure payload.
- Old frontend calls must still work.

### Task E2: Backend Cache and Fingerprint Check

**Files:**
- Modify: `server.ts`
- Optional create: `src/server/renderCache.ts` if server code is already too large.

- [ ] Compute render cache key from:

```text
engine
projectId
figureId
scriptHash
dataHash
figureFingerprint
editLogHash
renderOptionsHash
```

- [ ] If cache hit, return stored SVG/manifest without spawning Python/R.
- [ ] If cache miss, spawn renderer.
- [ ] Store only successful renders.
- [ ] Never cache error responses.

Verification:

- First patch render spawns renderer.
- Same patch render returns faster from cache.
- Changing editLog invalidates cache.
- Changing script invalidates cache.

### Task E3: CodePatch Affected Figure Detection

**Files:**
- Modify: `server.ts`
- Use existing `codeSlice` / `fingerprint` fields.

V1 algorithm:

1. Treat `code_patch` as project-wide invalidation.
2. Re-render all figures.
3. Return a warning that target-only code patch is not yet guaranteed.

This is correct-first and avoids false confidence when user scripts are not cleanly sliceable.

V2 optimization:

1. Apply code patch to script.
2. Re-run registry/fingerprint discovery.
3. Compare old and new figure fingerprints.
4. Mark changed figures as affected.
5. Preserve unchanged figure SVG/manifest.
6. If registry cannot be trusted, fallback to all figures and return warning.

Response should include:

```ts
{
  affectedFigureIds: string[];
  preservedFigureIds: string[];
  warnings: string[];
}
```

Browser verification:

- V1: modify code and confirm all figures rerender with a clear project-wide warning.
- V2 only after separate approval: modify code for one reliable figure slice, confirm only affected figure refreshes, and confirm warning appears if script structure prevents targeted detection.

---

## 8. Phase F — Drag Mode Built on Single-Figure Scheduler

### Task F1: Drag Mode Is Opt-In and Single-Figure Scoped

**Files:**
- Modify: `src/components/ChartPreview.tsx`
- Modify: `src/components/MainWorkspace.tsx`
- Optional create: `src/utils/dragPatch.ts`

Rules:

- Drag mode off: normal click selection must work exactly as before.
- Drag mode on: no spacebar needed; pointer drag is active.
- During pointer move: update local visual transform only.
- On pointer up: store final patch in pending patches.
- Confirm: send all pending patches once for current `figureId`.
- Cancel: clear transforms and pending patches.

Verification:

- Drag one text label, release, it stays visually in place.
- Drag two labels, confirm once, both patches are sent.
- Confirm rerender updates only active figure.
- Undo reverts the drag patches through existing figure history.

### Task F2: Position Patch Mapping

**Files:**
- Modify: `src/utils/dragPatch.ts`
- Modify renderer only if a proven unsupported object type blocks the feature.

Rules:

- Use manifest object `editable` to decide supported patch:
  - `position`
  - `x` / `y`
  - `left` / `bottom`
  - `bounds`
- If object lacks supported position props, show “该图元暂不支持拖拽定位”.
- Do not silently generate empty patches.

Verification:

- Drag supported text.
- Attempt to drag unsupported object.
- Confirm unsupported object does not flicker or create empty editLog.

---

## 9. Phase G — Export Consistency

### Task G1: Export Uses Target Figure Revision

**Files:**
- Modify: `src/components/ExportSettingsPage.tsx`
- Modify: `server.ts`

Rules:

- Export single figure by `figureId + revision`.
- If figure has pending render, block export or ask user to wait.
- Export must use latest confirmed editLog, not draft local transform.

Verification:

- Edit Figure 2.
- Export Figure 2.
- Confirm exported SVG matches Figure 2 latest revision.
- Confirm Figure 1 export is unchanged.

### Task G2: Composition Uses Asset Revisions

**Files:**
- Modify: `src/components/ComposerPage.tsx`
- Modify: `server.ts`

Rules:

- Composition should reference exported asset IDs and revisions.
- If source asset is stale, show warning.
- Composition edits do not mutate original single figures.

Verification:

- Export two figures.
- Compose them.
- Modify original Figure 1.
- Confirm existing composition remains unchanged until user explicitly refreshes asset.

---

## 10. Final Verification Matrix

Run after all phases:

```powershell
npx tsc --noEmit
npm run build
npm run lint
C:\Users\SZC\.conda\envs\Machine-learning\python.exe tests\test_r_renderer.py
C:\Users\SZC\.conda\envs\Machine-learning\python.exe tests\test_introspection.py
```

Browser verification:

- Python single figure render/edit/export.
- Python multi-figure project: edit one figure only.
- R single figure render/edit/export.
- R multi-figure project if supported.
- Font center batch edit.
- Palette center subset edit and undo.
- Drag mode confirm/cancel.
- Draft batch editing: change multiple font/style properties and apply once.
- Export after pending render.
- Composition export after source figure edits.

---

## 11. Stop Conditions

Stop and report instead of continuing if:

- A stale response overwrites newer figure state.
- A one-figure patch refreshes all figures.
- Existing Python edit flow regresses.
- Existing R edit flow regresses.
- A batch-capable control triggers backend render before the user clicks apply.
- Undo requires multiple clicks to revert one applied draft batch.
- UI behavior is claimed complete without browser evidence.
- A renderer change is proposed before proving the problem is not in frontend scheduling.

---

## 12. Recommended Execution Order

1. Phase A: protocol tests and read-only debug.
2. Phase C3 hotfix: stale response guard for current patch/render paths.
3. Phase B: UI read migration.
4. Phase C remaining scheduler and cache-key tasks.
5. Phase D: draft patch batch and apply-once editing.
6. Phase E: backend targeted render/cache.
7. Phase F: drag mode on top of the scheduler.
8. Phase G: export consistency.

Do not start Phase F drag work before Phase C and Phase D are stable. Dragging creates fast repeated UI state changes; without per-figure scheduler, stale response guards, and draft-batch semantics it will reproduce flicker, jump-back, wrong-position bugs, and excessive backend renders.
