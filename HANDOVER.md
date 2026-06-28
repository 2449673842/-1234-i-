# IFC v2 Handover

> 外部 AI 尤其是 Gemini 接手代码修改前，必须先阅读 `docs/GEMINI_CODING_PROTOCOL.md`。该文件是防止无证据判断、大范围重构和未验证交付的项目级约束。

> 本会话实现了 IFC v2 架构的 Phase 1 + Phase 2 核心管线。剩余 Phase 3–5 和 4 项 P1 遗留债。

---

## 什么是 IFC v2

核心变更：运行时内省 artist 树 → 自动生成 manifest → 前端按 manifest 渲染控件 → 编辑写入 editLog → 重放 rerender。不再依赖 AI 翻译脚本。

---

## 已交付（6 个文件）

### 1. `src/schemas/manifest.ts`
完整的 TypeScript 协议类型：
- `Manifest` / `ManifestObject` / `ManifestField` / `CoverageReport`
- `EditEntry` / `FigureSession`
- `RenderRequest` / `RenderResponse`
- `PatchResponse` / `CodePatchResponse` / `ExportBundle`

### 2. `renderer/introspector.py` (399 行)
Python 内省 + 重放引擎：
- `iter_attists(fig)` — yield (gid, kind, artist)，**这是 gid→artist 映射的唯一真相来源**
- `introspect_figure(fig)` — 遍历艺树，set_gid()，读 currentProps，输出确定性的 SVG + manifest
- `apply_edit_log(fig, edit_log)` — 重放时应用 edits
- `replay_render(script, data, edit_log)` — 全流程：执行脚本 → 应用 edits → 内省输出
- 确定性 SVG：`svg.hashsalt="scifigure-v1"` + `metadata={"Date": None}`

**已验证**：lollipop 脚本跑通全链路，title 编辑后重放正确，SVG 确定。

### 3. `server.ts` — 新 API 路由（strangler pattern）
- `POST /api/figure/render` — 接收 `{script, editLog, renderOptions}` → spawn introspector.py → 返回 `{svg, manifest, sessionId, revision, timingMs}`
- `POST /api/figure/patch` — 接收 `{sessionId, patches}` → local_patch 仅确认，backend_patch 累积 editLog 后 rerender
- 旧 `/api/render` 路由完全不动

**已验证**：API e2e test 全通过（render → patch title → 验证 SVG 改变 → local_patch 不 rerender）。

### 4. `src/hooks/useFigureSession.ts`
前端 Hook 封装：
- `render(script)` — 调用新 API
- `patch(patches)` — 发送 edits，自动更新 session state
- `reset()` — 清空 session
- 内置 AbortController / loading / error 状态

### 5. `src/components/ManifestViewer.tsx`
展示 manifest 的调试组件：globals / coverage / objects 表格 / 限制说明。在 bottom tab 中通过「Manifest (v2)」查看。

### 6. `src/components/MainWorkspace.tsx` — UI 集成
- 「内省引擎」按钮（emerald 色）在「同步至引擎」旁
- bottom tab 新增「Manifest (v2)」标签页
- 触发后调用新 API，结果显示在 ManifestViewer 中

---

## 核心架构决策（继承方必读）

### iter_artists 是唯一真相来源
```python
def iter_artists(fig):
    for ax_idx, ax in enumerate(fig.axes):
        yield "title.{idx}", "text", ax.title
        yield "xlabel.{idx}", "text", ax.xaxis.label
        ...
        yield "line.{idx}.{i}", "line", line
        yield "collection.{idx}.{i}", "collection", coll
```
**introspect_figure 和 apply_edit_log 都调这个函数**，不存在两套索引逻辑。

### gid 命名规则
```
title.{ax_idx}
xlabel.{ax_idx}
ylabel.{ax_idx}
spine.{side}.{ax_idx}           # side ∈ {left,right,top,bottom}
legend.{ax_idx}
line.{ax_idx}.{i}               # i = ax.lines 索引
collection.{ax_idx}.{i}         # i = ax.collections 索引
```
gid 前缀 = kind。没有 `series.` 前缀（早期版本有，已改）。

### prop → setter 映射
`_PROP_TO_SETTER` 定义了 manifest prop 名 → matplotlib setter 方法名的映射：
```
"text" → "set_text", "fontsize" → "set_fontsize",
"color" → "set_color", "visible" → "set_visible",
"linewidth" → "set_linewidth", "alpha" → "set_alpha",
"facecolor" → "set_facecolor", "edgecolor" → "set_edgecolor"
```
**新增 editable prop 时两个地方要一起改**：_EDITABLE（声明可编辑）+ _PROP_TO_SETTER（声明如何 apply）。

---

## 未交付（待完成）

### Phase 3 — Manifest 驱动前端（6 项，建议优先）

| # | 文件 | 工作 |
|---|------|------|
| 1 | `RightSidebar.tsx` | 删除 14 个硬编码面板函数（renderFigurePanel / renderSpinePanel / renderLegendPanel 等），改为从 manifest.objects + manifest.globals 循环渲染通用控件。manifest 的 `editable[]` + `currentProps` + `ManifestField.type` 决定控件类型（number/string/boolean/color/select）。 |
| 2 | `ChartPreview.tsx:136-165` | 删除 `handleDoubleClick` 中按 `spec.axes.title` 等检查旧文本的 hack，统一走 manifest gid → editLog 路径。 |
| 3 | `ChartPreview.tsx:274-276` | `onClick` 按 `data-scifigure-id` 找元素 → 改为按 `id` 找元素（set_gid 输出标准 id 属性）。 |
| 4 | `svgEditor.ts` | 瘦身：只保留 `getElementById` → 改 textContent / setAttribute。删除 `data-scifigure-id` 标注和 `applySvgEdits` 旧函数。 |
| 5 | `App.tsx` | 简化 RenderState（liveSvg / renderedSvg / editableSvgBase / editableSvgPreview / editableSvgEdits 五态）为 FigureSession 单态。sessionStorage 持久化键不变。 |
| 6 | `MainWorkspace.tsx` | autoSync 800ms debounce 从 `/api/render` 改为走 `/api/figure/render`。删除 `applyEditableState` 分支（no longer needed）。 |

### Phase 4 — code_patch + gid 漂移（3 项）

| # | 工作 |
|---|------|
| 7 | `server.ts` → `POST /api/figure/code-patch` 端点。接收 `{sessionId, patchedScript}` → 新沙箱执行 → 对比新旧 gid 集合 → 返回 `driftedGids`（missing[] + new[]）。 |
| 8 | AST 质量门禁（作为合规检查，不是安全边界）。检查：require_figure_output / warn_savefig / warn_plt_show / warn_hardcoded_file_path。Python `ast` 模块实现。 |
| 9 | 前端代码编辑器集成 + gid 漂移确认流程。飘移时弹面板让用户选择：保留/丢弃/重应用 editLog 条目。 |

### Phase 5 — 导出（3 项）

| # | 工作 |
|---|------|
| 10 | `POST /api/figure/export` 端点。SVG / PNG(Pillow) / PDF(cairosvg) + 可复现包。 |
| 11 | 可复现包格式定义：script + editLog + dataFingerprint(SHA256) + 环境快照。 |
| 12 | 格式转换拆到独立 `renderer/convert.py`（现在内联在 server.ts:109-161 的 inline script 中）。 |

### P1 遗留债（新架构已天然解决，但旧代码仍在）

| ID | 问题 | 旧路径 | 新架构方案 |
|----|------|--------|-----------|
| A | editableSvg 写入竞争 | MainWorkspace + RightSidebar 同时改 SVG DOM | 全 editLog 路径，无并行写入 |
| B | 前端 SVG 与后端不一致 | ChartPreview 旧手绘分支 | 全后端渲染，前端纯显示 |
| C | 缺 raw_data 时画假数据 | `plot.py:223-231` | 新 architecture 不依赖 raw_data 字段 |
| D | FeP 硬编码文本 | `plot.py:389` | 旧 render_scatter_fit 在新路径中不会被使用 |

---

## 验证清单（给下一 AI）

### 快速确认管线正常
```bash
cd /project/root
npx tsc --noEmit                # 必须零错误
python -c "from renderer.introspector import introspect_figure, replay_render; print('import OK')"
python tests/test_introspect.py # 或自定义 lollipop 测试
```

### 浏览器手动测试
1. `npm run dev`（Vite + tsx server.ts）
2. 打开 http://localhost:3000
3. 进入编辑器，选择任意图表类型
4. 点击「同步至引擎并预览 SVG」— 确认旧渲染正常
5. 点击「内省引擎」— 确认产出 manifest 并在 bottom 面板展示
6. 切换到「Manifest (v2)」tab — 确认看到 objects / globals / coverage

---

## 文件清单

| 文件 | 修改类型 | 说明 |
|------|---------|------|
| `src/schemas/manifest.ts` | **新建** | 协议类型 |
| `renderer/introspector.py` | **新建** | 内省+重放引擎 |
| `src/hooks/useFigureSession.ts` | **新建** | 前端 hook |
| `src/components/ManifestViewer.tsx` | **新建** | manifest 展示组件 |
| `server.ts` | **修改** | 追加 2 个新路由 |
| `src/components/MainWorkspace.tsx` | **修改** | 新增按纽 + manifest tab |
| `src/components/ChartPreview.tsx` | 未改 | 等待 Phase 3 |
| `src/components/RightSidebar.tsx` | 未改 | 等待 Phase 3 |
| `src/App.tsx` | 未改 | 等待 Phase 3 |
| `src/utils/svgEditor.ts` | 未改 | 等待 Phase 3 瘦身 |
| `renderer/plot.py` | 未改 | 旧路由仍用此文件 |
