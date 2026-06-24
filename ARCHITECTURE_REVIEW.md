# Architecture Review — SciFigure Studio

## How to Use This Document

Read each issue below and verify:

1. **Is the description accurate?** Read the referenced source lines.
2. **Is the severity correct?** P0=crash/data loss, P1=broken UX, P2=tech debt.
3. **Is the suggested fix sufficient?** Does it close the hole without over-engineering?

Mark each issue `✅ Confirmed` or `❌ Disagree` with a brief reason.

---

## P0 Issues

### P0-1: Python subprocess cancel-not-propagated

**File:** `E:\ai绘图修改编辑\server.ts:36-40`

```ts
const pythonProcess = spawn(pythonBin, [plotScript]);
const killTimer = setTimeout(() => {
  timedOut = true;
  pythonProcess.kill('SIGKILL');
}, 20000);
```

Frontend sends `AbortController.signal` in the fetch. When the user clicks 取消, the HTTP request is cancelled, but **the Python subprocess keeps running until the 20s timeout**. If the user cancels and re-renders 3+ times, 3 Python processes accumulate server-side.

**Check:** Is there any `req.on('close', () => pythonProcess.kill())`? If not, confirm this leak exists.

**Fix:** Add `req.on('close', () => { if (!timedOut) { clearTimeout(killTimer); pythonProcess.kill('SIGKILL'); } })` after line 46.

---

### P0-2: editableSvg write competition with autoSync

**Files:** `E:\ai绘图修改编辑\src\components\RightSidebar.tsx`, `src/App.tsx:23-31`, `src/components/MainWorkspace.tsx:130-154`

The state machine has three SVG slots:

| Slot | Set by | Used by |
|------|--------|---------|
| `liveSvg` | autoSync (800ms debounce) | ChartPreview for bar/scatter |
| `renderedSvg` | User clicks 同步 | Fullscreen modal |
| `editableSvg` | `annotateEditableSvg(renderedSvg)` | ChartPreview for custom |
| `editableSvg` | RightSidebar `onEditableSvgChange` | RightSidebar reads it |

**Race:** RightSidebar calls `updateSvgElement(editableSvg)` → `onEditableSvgChange(newSvg)` → but `renderedSvg` and `liveSvg` are unchanged. Next autoSync fires (code edit, spec change) → `liveSvg` overwrites from backend → `editableSvg` is recomputed from `liveSvg` → **RightSidebar's DOM edits are lost silently**.

**Check:** Reproduce: render custom script → select a text element in SVG → change its color in RightSidebar → wait 1s (autoSync fires) → see if color reverts.

**Fix (choose one):**
- **A:** Remove `editableSvg`. Make all SVG edits go through `spec` → `onSpecChange` → backend re-render. Delete `annotateEditableSvg` pathway entirely.
- **B:** In `autoSync`, preserve `editableSvg` if it was manually changed (add a `_dirtyEditableSvg` flag). This is fragile.

---

## P1 Issues

### P1-1: Three render functions duplicate identical boilerplate

**File:** `E:\ai绘图修改编辑\renderer/plot.py`

Three functions repeat the same setup pattern:
- `render_matplotlib` (line 162)
- `render_scatter_fit` (line 306)
- `render_ranked_response` (line 400)

Each one independently:
1. Calls `configure_fonts_from_spec`
2. Reads `font_spec`, `axes_cfg`, `fig_cfg` from spec
3. Creates `fig, ax = plt.subplots(figsize=..., dpi=...)`
4. Configures spines (4 sides)
5. Calls `tick_params`
6. Sets title/labels
7. Renders legend

This is ~40 lines of identical code × 3 = **120 lines of boilerplate**. Adding a new chart type requires copy-pasting all of it.

**Fix:** Extract a `create_axes(spec) -> (fig, ax)` helper that does lines (2)–(6). Each render function only does the draw logic:

```python
def render(spec, draw_fn):
    configure_fonts_from_spec(spec)
    fig, ax = create_axes(spec)
    draw_fn(ax, spec)
    apply_legend(ax, spec)
    svg = render_figure_to_svg(fig)
    plt.close(fig)
    return svg
```

---

### P1-2: Frontend hand-coded SVG duplicates backend rendering

**File:** `E:\ai绘图修改编辑\src/components/ChartPreview.tsx`

Frontend maintains **two hand-coded SVG implementations** of chart rendering:

| plot_type | Frontend (ChartPreview.tsx) | Backend (plot.py) |
|-----------|---------------------------|-------------------|
| `bar` | Lines 307–502 (~200 lines) | `render_matplotlib` |
| `ranked_response` | Lines 174–305 (~130 lines) | `render_ranked_response` |
| `scatter_fit` | Placeholder text (no SVG) | `render_scatter_fit` |
| `custom` | Shows backend SVG | `exec()` + `apply_spec_overrides` |

The frontend versions are approximations — they don't handle:
- Error bars correctly (missing SEM calculation, fixed cap style)
- Significance brackets (frontend: none; backend: drawn at fixed position)
- Tick direction `inout` (frontend: binary in/out)
- Legend positioning (frontend: pixel-based; backend: matplotlib anchor)

When the user exports, the backend SVG is the real output. The frontend preview is just a mock. This is misleading.

**Fix:** Make `ChartPreview` a pure SVG viewer for ALL plot types. Route everything through `/api/render`. Use `liveSvg` for the live preview pane. Delete the hand-coded bar and ranked_response SVG blocks (lines 174–502).

This also eliminates the `liveSvg` vs `renderedSvg` distinction — there's only one SVG source.

---

### P1-3: RightSidebar is 602 lines, does too much

**File:** `E:\ai绘图修改编辑\src\components\RightSidebar.tsx`

602 lines handling: color pickers, spine toggles, tick settings, font controls, legend config, SVG element property editors, custom Script Output properties. All in a single flat component.

No `useMemo` boundaries, no sub-component extraction. Every state change re-renders the entire 600-line tree.

**Suggestion (not blocking):** Split into `GlobalSettingsPanel`, `AxesPanel`, `DataLayerPanel`, `SvgElementPanel` sub-components.

---

## P2 Issues

### P2-1: render_matplotlib has hard-coded default data

**File:** `E:\ai绘图修改编辑\renderer/plot.py:221-230`

```python
default_raw = {
    'categories': ['SOT', 'MOT', 'DOT'],
    'groups': {
        'EWR': {'values': [47, 10, 4], 'errors': [2, 1, 0.5]},
        'NEWR': {'values': [2, 10, 20], 'errors': [0.5, 1, 2]},
    },
}
raw_data = spec.get('raw_data', default_raw)
```

If `spec.raw_data` is missing, the backend silently renders fake data. The user sees a chart with wrong labels → wastes time debugging. Should return an error instead.

### P2-2: Scatter fit FeP text is hard-coded

**File:** `E:\ai绘图修改编辑\renderer/plot.py:387`

```python
notes.append(r'FeP threshold = mean (1.47 mg$\cdot$g$^{-1}$)')
```

This is research-specific text from the original use case (FL9 Ferrihydrite data). It appears in every scatter fit output regardless of what data the user plotted. Should either read from spec or be removed.

### P2-3: server.ts format conversion spawns Python per request

**File:** `E:\ai绘图修改编辑\server.ts:86-133`

For SVG→PDF/PNG/TIFF conversion, the server spawns a new Python subprocess per request using `python -c '...'` with inline script. This:
- Spawns a full Python interpreter for every export
- The conversion script is embedded as a string (no error checking)
- No caching

**Fix:** Move conversion to `renderer/convert.py` and use the main Python process (read format from spec, output converted binary alongside SVG in stdout).

### P2-4: favicon.ico 404

**File:** `E:\ai绘图修改编辑\index.html:4-6`, `public/` does not exist

No `<link rel="icon">` in `<head>`. Browsers request `/favicon.ico` by default → 404 in network tab. Minor but makes the tool feel unpolished.

**Fix:** Put a 16×16 SVG favicon at `public/favicon.svg` and add `<link rel="icon" type="image/svg+xml" href="/favicon.svg">` to `index.html`.

---

## Summary Table

| ID | Severity | Area | Root Cause |
|----|----------|------|------------|
| P0-1 | Leak | server.ts | Python subprocess not killed on HTTP cancel |
| P0-2 | Data loss | App/RightSidebar | editableSvg overwritten by autoSync |
| P1-1 | Tech debt | plot.py | 3× copied boilerplate in render functions |
| P1-2 | Misleading UX | ChartPreview.tsx | Frontend SVG ≠ backend SVG |
| P1-3 | Maintainability | RightSidebar.tsx | 602-line flat component |
| P2-1 | Silent wrong | plot.py | Fake default data when raw_data missing |
| P2-2 | Wrong output | plot.py | Hard-coded FeP text in scatter fit |
| P2-3 | Performance | server.ts | Python subprocess per format conversion |
| P2-4 | Polish | index.html | Missing favicon |

## Verification Checklist

After fixes, confirm:

- [ ] `npx tsc --noEmit` = 0 errors
- [ ] `python renderer/plot.py < test_input.json` works for all 4 plot_types
- [ ] Custom script: render → edit text in RightSidebar → wait 5s → text unchanged (no overwrite)
- [ ] Custom script: click 取消 during render → backend Python process is killed (check task manager)
- [ ] Bar chart with no raw_data → error message, not fake chart
- [ ] `render_matplotlib` / `render_scatter_fit` / `render_ranked_response` each < 80 lines after refactor
- [ ] `ChartPreview.tsx` no longer contains `<svg>...</svg>` drawing logic for bar/ranked_response
- [ ] RightSidebar < 400 lines
