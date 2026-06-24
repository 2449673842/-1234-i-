# Interactive Figure Refactor Plan

## 1. Objective

Build a real interactive scientific figure workflow on top of the current `data -> Python -> SVG` pipeline, so users can:

- upload data and Python plotting code
- get a true Python-rendered figure, not a hand-drawn frontend approximation
- modify figure appearance interactively in the canvas and sidebar
- export the final figure and reproducible code bundle

The product target is not "support arbitrary Python logic as fully drag-editable." The target is:

- arbitrary scripts can still run
- platform-recognized figure objects become interactive
- unrecognized logic falls back to code editing

This is the only realistic way to move toward an Origin-like experience without breaking rendering fidelity.

## 2. Core Problem

The current architecture loses semantic structure after rendering:

- `renderer/plot.py` produces real SVG, but SVG is only the final visual output
- the frontend does not reliably know which node is the title, legend, axis label, spine, or data series
- the sidebar therefore cannot safely provide stable editing controls for custom Python output

As a result:

- editing is fragile
- interaction is inconsistent across chart types
- custom scripts cannot become truly editable

The core issue is not rendering quality. The core issue is missing figure semantics between backend and frontend.

## 3. Required Solution Components

Prompt engineering alone is not enough. The system needs three explicit layers:

1. An interactive script standard
2. A frontend/backend manifest protocol
3. A validator that checks AI-translated scripts before they enter the interactive workflow

Without those three layers, the system will keep oscillating between:

- fake frontend previews
- one-off script-specific hacks
- brittle SVG guessing

## 4. Target Architecture

Recommended flow:

`Raw Python Script -> AI Translator -> IFC v1 Script -> Runtime Render -> SVG + Manifest -> Frontend Editor`

Where:

- the raw script is what the user or external AI provides
- the AI translator converts it into a platform-compatible script format
- the runtime executes that script safely
- the backend returns both rendered SVG and an editable manifest
- the frontend edits according to the manifest, not by guessing SVG semantics

## 5. Interactive Figure Contract: IFC v1

Define a platform-specific standard called `IFC v1` (`Interactive Figure Contract v1`).

This is not a replacement for matplotlib. It is a structured wrapper around matplotlib that makes figure objects editable.

### 5.1 IFC v1 requirements

Every interactive script must satisfy these rules:

- it exposes a single entry function such as `build_figure(ctx)`
- it reads input data from `ctx.data`
- it reads editable parameters from `ctx.params`
- it registers editable objects through runtime registration APIs
- it does not read or write arbitrary local files
- it does not call network APIs
- it does not save output directly with `plt.savefig`
- it renders deterministically for the same `data + params`

### 5.2 Minimal IFC v1 script shape

```python
from __future__ import annotations

import matplotlib
matplotlib.use("Agg")
import matplotlib.pyplot as plt


def build_figure(ctx):
    df = ctx.data["main"]
    p = ctx.params

    fig, ax = plt.subplots(
        figsize=(p["figure.width_in"], p["figure.height_in"]),
        dpi=p["figure.dpi"],
    )

    ax.set_facecolor(p["figure.axes_facecolor"])
    fig.patch.set_facecolor(p["figure.figure_facecolor"])

    title = ax.set_title(
        p["title.text"],
        fontsize=p["title.font_size"],
        color=p["title.color"],
        pad=p["title.pad"],
    )
    xlabel = ax.set_xlabel(p["xaxis.label"], fontsize=p["xaxis.label_size"])
    ylabel = ax.set_ylabel(p["yaxis.label"], fontsize=p["yaxis.label_size"])

    ctx.register_text("title.main", title, editable=["text", "fontSize", "fill", "x", "y"])
    ctx.register_text("label.x", xlabel, editable=["text", "fontSize", "fill"])
    ctx.register_text("label.y", ylabel, editable=["text", "fontSize", "fill"])
    ctx.register_spine("spine.left", ax.spines["left"], editable=["visible", "color", "lineWidth"])
    ctx.register_spine("spine.right", ax.spines["right"], editable=["visible", "color", "lineWidth"])
    ctx.register_axis("axis.x", ax, editable=["limits", "ticks", "tickLabelSize"])
    ctx.register_axis("axis.y", ax, editable=["limits", "ticks", "tickLabelSize"])

    return fig
```

### 5.3 Parameter philosophy

Editable parameters must be normalized and centralized.

Example:

```python
DEFAULT_PARAMS = {
    "figure.width_in": 8.2,
    "figure.height_in": 7.2,
    "figure.dpi": 300,
    "font.family": "Times New Roman",
    "title.text": "Ferrihydrite-induced N2O response ranked by site code",
    "title.font_size": 15,
    "title.color": "#111111",
    "xaxis.label": "LnRR = ln(DTR / DCK)",
    "xaxis.label_size": 12,
    "yaxis.label": "Site code",
    "yaxis.label_size": 12,
    "spine.line_width": 0.9,
}
```

This gives the platform one stable parameter namespace instead of script-specific ad hoc values.

## 6. Manifest Protocol

The backend must return both rendered output and edit metadata.

Suggested response:

```json
{
  "sessionId": "fig_01J...",
  "revision": 12,
  "svg": "<svg>...</svg>",
  "manifest": {
    "globals": {
      "figure.width_in": {"type": "number", "min": 2, "max": 20, "step": 0.1},
      "figure.height_in": {"type": "number", "min": 2, "max": 20, "step": 0.1},
      "font.family": {"type": "string"},
      "spine.line_width": {"type": "number", "min": 0, "max": 5, "step": 0.1}
    },
    "objects": [
      {
        "id": "title.main",
        "kind": "text",
        "label": "Main Title",
        "editable": ["text", "fontSize", "fill", "x", "y"]
      },
      {
        "id": "legend.main",
        "kind": "legend",
        "label": "Legend",
        "editable": ["x", "y", "fontSize", "visible"]
      },
      {
        "id": "spine.left",
        "kind": "spine",
        "label": "Left Spine",
        "editable": ["visible", "color", "lineWidth"]
      }
    ],
    "bindings": {
      "svgNodeMap": {
        "title.main": "data-fig-id=title.main",
        "legend.main": "data-fig-id=legend.main"
      }
    },
    "capabilities": {
      "localPatch": true,
      "backendPatch": true,
      "codePatch": true
    },
    "unsupportedNotes": [
      "Ranking logic is editable only via code patch",
      "Legend auto-layout may change after axis range updates"
    ]
  }
}
```

The manifest is the source of truth for the frontend editor.

## 7. Three Edit Modes

The system should explicitly separate editing into three paths.

### 7.1 `local_patch`

Use for operations that can be applied immediately on the existing SVG:

- text content
- fill color
- stroke color
- opacity
- temporary position nudging
- visibility toggles

Characteristics:

- frontend-only
- no rerender
- target latency under 50ms

### 7.2 `backend_patch`

Use for operations that affect matplotlib layout or geometry:

- font size
- figure width and height
- axis limits
- tick settings
- legend position
- spine width
- marker size
- line width

Characteristics:

- sent to backend runtime
- backend updates params and rerenders
- target latency roughly 200-500ms for normal figures

### 7.3 `code_patch`

Use for logic-level changes:

- sort order
- grouping logic
- derived columns
- fitting logic
- statistical computation
- annotation generation rules

Characteristics:

- changes IFC script logic
- requires validation before rerender
- this is not a style tweak path

This separation is essential. If every edit triggers rerender, interaction feels slow. If everything is local SVG patching, output becomes fake.

## 8. Backend API Design

Start with REST. Add WebSocket later only if drag-heavy operations need persistent low-latency coordination.

### 8.1 `POST /api/figure/prepare`

Purpose:

- accept raw user script and source data
- invoke AI translation into IFC v1
- validate the translated result

Input:

- raw script
- uploaded data references
- optional figure type hints

Output:

- translated IFC script
- default params
- validation report
- unsupported notes

### 8.2 `POST /api/figure/render`

Purpose:

- create or rerender a figure session

Input:

- `sessionId`
- IFC script
- data payload or data reference
- params

Output:

- `svg`
- `manifest`
- `revision`
- timing breakdown

### 8.3 `POST /api/figure/patch`

Purpose:

- apply edit operations to the active session

Input:

```json
[
  {"op": "set", "mode": "local_patch", "target": "title.main", "field": "text", "value": "New Title"},
  {"op": "set", "mode": "backend_patch", "path": "title.font_size", "value": 18},
  {"op": "set", "mode": "backend_patch", "target": "spine.left", "field": "lineWidth", "value": 1.2}
]
```

Output:

- for `local_patch`: confirmation and optional normalized patch
- for `backend_patch`: new `svg + manifest + revision`

### 8.4 `POST /api/figure/code-patch`

Purpose:

- update script logic safely

Input:

- session id
- code patch or full updated IFC script

Output:

- updated IFC script
- validation report
- optional rerender payload

### 8.5 `POST /api/figure/export`

Purpose:

- export final figure and reproducible assets

Output:

- SVG
- PNG
- PDF
- IFC script
- params JSON
- data fingerprint
- metadata
- zipped reproducibility bundle

## 9. Runtime Responsibilities

The backend should evolve from a one-shot render script runner into a session-based figure runtime.

Required responsibilities:

- maintain `sessionId`
- track `revision`
- preserve `params`
- preserve generated manifest
- support undo/redo snapshots
- support cancelation of in-flight rerenders
- enforce sandbox restrictions on translated scripts

This should live conceptually above the current one-shot flow in `server.ts` and `renderer/plot.py`.

## 10. AI Translation Workflow

AI should be treated as a translator, not as the source of runtime truth.

### 10.1 Translation steps

1. Accept raw Python plotting script
2. Identify:
   - figure size
   - fonts
   - labels
   - spines
   - legend
   - data series
   - annotations
3. Move editable values into `DEFAULT_PARAMS`
4. Wrap script in `build_figure(ctx)`
5. Replace direct data loading with `ctx.data`
6. Register editable objects with stable ids
7. Emit `unsupportedNotes` for logic that cannot be made live-editable

### 10.2 Prompt constraints for translator

The translation prompt must enforce:

- preserve output logic and visual appearance as closely as possible
- never simplify to a fake chart
- never replace true rendering with frontend approximations
- expose editable values through params
- register all key visible objects
- avoid filesystem writes and `plt.savefig`
- explicitly list unsupported interactive areas

## 11. Validator Design

Validator is mandatory. Without it, translated scripts will be inconsistent and unsafe.

### 11.1 Static validation

AST-level checks:

- forbid `savefig`
- forbid arbitrary file writes
- forbid `subprocess`
- forbid network calls
- require `build_figure(ctx)`
- require object registration APIs

### 11.2 Runtime validation

Dry-run checks:

- script renders successfully
- manifest is produced
- registered ids are unique
- required object classes exist
- same `data + params` rerender deterministically

### 11.3 Coverage scoring

Return a coverage report, for example:

- title registered: yes
- axis labels registered: yes
- legend registered: yes
- primary series registered: partial
- annotations registered: partial

This should produce a coverage score and a list of gaps.

If validation fails, the system should fall back to:

- read-only true rendering
- code editing mode

It should not pretend that interactive editing is available.

## 12. Frontend Refactor Direction

The frontend should become manifest-driven.

### 12.1 `src/components/MainWorkspace.tsx`

Should own:

- active figure session
- current revision
- params state
- manifest state
- undo/redo history
- patch dispatch

### 12.2 `src/components/ChartPreview.tsx`

Should remain the true SVG viewer and become responsible for:

- zoom
- pan
- fit-to-view
- object selection
- hover highlight
- drag handles where supported

It should not generate fake chart previews.

### 12.3 `src/components/RightSidebar.tsx`

Should render controls from `manifest.objects` and `manifest.globals`.

This is a major direction change:

- do not hardcode controls by chart type
- do not assume all plots expose the same editable fields
- show only the properties that the backend explicitly marks editable

### 12.4 `src/utils/svgEditor.ts`

Should focus narrowly on `local_patch` responsibilities:

- applying text edits
- color changes
- visibility toggles
- lightweight local transforms

It should not be responsible for guessing matplotlib semantics from arbitrary SVG.

### 12.5 `server.ts`

Should become the API and session coordinator for:

- prepare
- render
- patch
- export
- cancelation
- revision management

### 12.6 `renderer/plot.py`

Should evolve into:

- a safe rendering executor
- plus a runtime helper layer that exposes IFC registration and manifest generation

## 13. Recommended MVP Scope

Do not attempt universal chart support first.

Start with 3 high-frequency scientific plot types:

1. Ranked response / lollipop style plots
2. Bar and grouped bar plots
3. Scatter + regression / fit plots

For MVP, support these editable dimensions:

- title text
- font family
- font size
- text color
- figure width and height
- axis labels
- axis ranges
- tick label sizes
- legend position
- legend font size
- spine visibility
- spine color
- spine width
- annotation text
- annotation position

This is already enough to make the tool materially useful for scientific figure redrawing.

## 14. Implementation Roadmap

### Phase 1: Lock the contract

Deliverables:

- IFC v1 script shape
- manifest schema
- patch operation schema
- export bundle schema

Success condition:

- frontend and backend teams can work against one stable contract

### Phase 2: Build minimal runtime

Deliverables:

- session-based render runtime
- object registration helpers
- manifest generation
- patch routing

Success condition:

- one translated figure can render, rerender, and expose manifest-driven edits

### Phase 3: Convert frontend to manifest-driven editing

Deliverables:

- object selection mapped from SVG ids
- sidebar generated from manifest
- local patch engine separated from backend patch engine

Success condition:

- the frontend no longer relies on fake per-chart hardcoded editing paths

### Phase 4: Add AI translation + validator

Deliverables:

- translation prompt
- translation endpoint
- AST validator
- dry-run validator
- fallback modes

Success condition:

- user raw scripts can be translated into editable IFC scripts with explicit support boundaries

### Phase 5: Export and reproducibility

Deliverables:

- export panel
- reproducibility bundle
- code + params + metadata packaging

Success condition:

- the final edited figure can be reproduced outside the app

### Phase 6: Advanced interaction

Deliverables:

- drag-based positioning
- alignment tools
- multi-select
- batch styling
- more responsive incremental patching

Success condition:

- interaction quality materially approaches desktop plotting tools for supported chart classes

## 15. Risks and Tradeoffs

### Risk 1: AI translation is inconsistent

Mitigation:

- strict IFC schema
- validator gate
- fallback to read-only true rendering when confidence is low

### Risk 2: Attempting to support arbitrary plots too early

Mitigation:

- chart-family-based rollout
- explicit unsupported notes
- manifest-driven capability display

### Risk 3: Rerender latency feels too slow

Mitigation:

- keep `local_patch` for instant edits
- debounce `backend_patch`
- introduce incremental rerender optimizations later

### Risk 4: Frontend tries to infer too much from SVG again

Mitigation:

- make manifest the only source of editable semantics
- keep SVG parsing limited to node lookup and local visual patching

### Risk 5: Users think everything is live-editable

Mitigation:

- surface support boundaries clearly
- label unsupported logic as code-only edits
- never expose fake controls for unsupported objects

## 16. Product Positioning Decision

The product should not position itself as:

- "any matplotlib script becomes fully Origin-like"

It should position itself as:

- "true Python scientific figures with platform-aware interactive editing for recognized structures"

That claim is accurate, defensible, and extensible.

## 17. Immediate Next Step Recommendation

The next implementation step should not be UI polishing.

It should be a contract-first milestone:

1. define `IFC v1`
2. define `manifest` schema
3. define `patch` schema
4. build one end-to-end example for a ranked response plot

Once that single path is stable, the rest of the system can scale on a real foundation.
