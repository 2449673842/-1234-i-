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
  const data = new TextEncoder().encode(input);
  const digest = await crypto.subtle.digest('SHA-256', data);
  return Array.from(new Uint8Array(digest)).map((byte) => byte.toString(16).padStart(2, '0')).join('');
}
```

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

## 6. Phase D — Backend Targeted Render

### Task D1: API Contract for Targeted Project Render

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

### Task D2: Backend Cache and Fingerprint Check

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

### Task D3: CodePatch Affected Figure Detection

**Files:**
- Modify: `server.ts`
- Use existing `codeSlice` / `fingerprint` fields.

Algorithm:

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

- Modify code for one figure slice.
- Confirm only affected figure refreshes.
- Confirm warning appears if script structure prevents targeted detection.

---

## 7. Phase E — Drag Mode Built on Single-Figure Scheduler

### Task E1: Drag Mode Is Opt-In and Single-Figure Scoped

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

### Task E2: Position Patch Mapping

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

## 8. Phase F — Export Consistency

### Task F1: Export Uses Target Figure Revision

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

### Task F2: Composition Uses Asset Revisions

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

## 9. Final Verification Matrix

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
- Export after pending render.
- Composition export after source figure edits.

---

## 10. Stop Conditions

Stop and report instead of continuing if:

- A stale response overwrites newer figure state.
- A one-figure patch refreshes all figures.
- Existing Python edit flow regresses.
- Existing R edit flow regresses.
- UI behavior is claimed complete without browser evidence.
- A renderer change is proposed before proving the problem is not in frontend scheduling.

---

## 11. Recommended Execution Order

1. Phase A: protocol tests and read-only debug.
2. Phase B: UI read migration.
3. Phase C: frontend scheduler and stale response guard.
4. Phase D: backend targeted render/cache.
5. Phase E: drag mode on top of the scheduler.
6. Phase F: export consistency.

Do not start Phase E drag work before Phase C is stable. Dragging creates fast repeated UI state changes; without per-figure scheduler and stale response guards it will reproduce flicker, jump-back, and wrong-position bugs.

