# 下个 AI 的任务清单

> Gemini 接手任何代码修改前，必须先阅读并遵守 `docs/GEMINI_CODING_PROTOCOL.md`。未完成 Preflight、源码证据收集、影响面分析和验证前，不允许宣称修复完成。

以下每个任务是独立的 Task agent prompt，可以一次发送一个或多个。

---

## 任务 A：RightSidebar manifest 驱动化

**目标**：将 `RightSidebar.tsx`（610 行，14 个硬编码面板）改为从 manifest 循环渲染控件。

**参考文件**：
- `src/schemas/manifest.ts` — Manifest / ManifestObject / ManifestField 类型
- `src/hooks/useFigureSession.ts` — 提供 figSession (含 manifest + editLog + svg)
- `src/components/MainWorkspace.tsx` — 已集成 useFigureSession

**实现要求**：
1. `RightSidebar.tsx` props 签名从 `{spec, onChange, selectedObject, editableSvg*}` 改为 `{figSession, selectedObject, onSelectObject, onPatch}`
2. 删除以下 14 个硬编码函数：
   - `renderFigurePanel`, `renderSpinePanel`, `renderAxesFramePanel`
   - `renderLegendPanel`, `renderBarLayerPanel`, `renderRankedLayerPanel`
   - `renderTextPanel`, `renderSigPanel`, `renderTicksPanel`
   - `renderCustomGuidancePanel`, `renderSvgObjectPanel`, `renderCustomObjectPanel`
   - `renderContent` 中的 if/else 链
3. 新增通用渲染函数 `renderObjectPanel(obj: ManifestObject)`：
   - 遍历 `obj.editable[]`，按 prop 名从 `obj.currentProps` 取值
   - 根据 `ManifestField.type` 渲染对应控件（number → `<input type="number">`、string → `<input type="text">`、color → `<input type="color">`、boolean → checkbox toggle、select → `<select>`）
   - 编辑时调用 `onPatch([{gid: obj.id, prop, value, mode: isLocal ? 'local_patch' : 'backend_patch'}])`
4. 保留 GV 字体面板在下方（移入 `renderGlobalsPanel`，从 `manifest.globals` 渲染）
5. 删除对 `props.editableSvg` / `editableSvgEdits` / `onEditableSvgEditsChange` 的所有引用
6. `tsc --noEmit` 零错误

**成功标准**：选中 manifest 中的任意 object，右侧显示对应控件；编辑后通过 patch API 更新。

**约束**：
- local_patch vs backend_patch 判断规则：text/color/visible → local_patch，fontsize/linewidth → backend_patch（可写死映射 `LOCAL_PROPS = new Set(['text', 'color', 'visible', 'facecolor', 'edgecolor'])`）

---

## 任务 B：ChartPreview 清理 + SVG id 选中

**目标**：删除旧 `data-scifigure-id` 和 double-click text hack，改为按 SVG `id` 属性选中元素。

**参考文件**：
- `src/components/ChartPreview.tsx` — 当前 296 行
- `renderer/introspector.py` — `set_gid()` 写入标准 SVG `id` 属性

**实现要求**：
1. 删除 `handleDoubleClick` 函数中所有 `spec.axes.title` / `spec.axes.xlabel` / `spec.axes.ylabel` 检查分支（ChartPreview.tsx:136-165）
2. 保留 double-click 编辑功能，但改为调用 `onSelectObject` 选中后让用户通过右侧面板编辑（或弹 prompt 做 local_patch 改 textContent）
3. 删除 `data-scifigure-id` 相关代码。SVG 节点选中改为用 `element.closest('[id]')?.getAttribute('id')` 匹配 manifest.objects
4. 删除 `spec.plot_type === 'custom'` 的特殊分支（只在 `renderState.editableSvgPreview` 和 `renderState.liveSvg` 之间做判断）
5. `tsc --noEmit` 零错误

---

## 任务 C：App.tsx 状态简化（RenderState → FigureSession）

**目标**：将 `App.tsx` 中 5 个分散的 RenderState 字段合并为单一 FigureSession 模型。

**参考文件**：
- `src/App.tsx` — 当前 297 行
- `src/types.ts` — FigureSpec 定义（保留）
- `src/schemas/manifest.ts` — FigureSession 类型

**实现要求**：
1. 删除 `interface RenderState`（liveSvg / renderedSvg / editableSvgBase / editableSvgPreview / editableSvgEdits / renderLog / renderError / renderTraceback / lastRenderedAt）
2. 替换为 `figSession: FigureSession | null` + `isRendering: boolean` + `renderLog: string[]` + `renderError: string | null`
3. sessionStorage 持久化键保留不变，但内容改为 serialize FigureSession 而非 PersistedAppState
4. `MainWorkspace.tsx` 和 `RightSidebar.tsx` 的 props 做对应调整（传 figSession 而非 renderState）
5. `LeftSidebar.tsx` props 中 `editableSvg` 参数删除，改为接受 `manifest` 驱动图层树
6. `tsc --noEmit` 零错误

---

## 任务 D：MainWorkspace autoSync 迁移

**目标**：autoSync 800ms 防抖从旧 `/api/render` 改为走新 `/api/figure/render` 端点，删除旧 `applyEditableState` 路径。

**参考文件**：
- `src/components/MainWorkspace.tsx` — 当前 ~595 行

**实现要求**：
1. autoSync 的 `useEffect` 中 `/api/render` → `/api/figure/render`
2. 发送 body: `{script: generatePythonCode(spec), editLog: [], renderOptions: {dpi: 150}}`
3. 返回后更新 `figSession` 而非旧的 renderState
4. 删除 `applyEditableState` 辅助函数
5. 删除 `renderState.editableSvgBase` / `editableSvgPreview` / `editableSvgEdits` 相关的一切逻辑
6. 成功后自动更新 `ChartPreview` 的 `renderedSVG` prop 为 `figSession.svg`
7. `tsc --noEmit` 零错误

---

## 任务 E：svgEditor 瘦身

**目标**：删除 `data-scifigure-id` 标注逻辑和 `applySvgEdits` 旧函数，只保留 DOM 操作。

**参考文件**：
- `src/utils/svgEditor.ts`

**实现要求**：
1. 删除 `markEditableElements` 或类似给 SVG 添加 `data-scifigure-id` 属性的函数
2. 删除 `applySvgEdits(svg, edits)` 函数（旧 local_patch 叠加方式）
3. 仅保留两个导出函数：
   - `sanitizeSvg(svg: string): string` — 清理 XML/DOMParser 相关安全处理
   - `patchSvgNode(svg: string, id: string, prop: string, value: string): string` — 解析 SVG，按 id 找节点，改 textContent 或 setAttribute
4. 更新所有 import `applySvgEdits` 的地方为新的 `patchSvgNode`
5. `tsc --noEmit` 零错误

---

## 任务 F：P1 遗留债清理

**目标**：清理 4 项 P1 技术债（新架构已自然解决，但旧代码仍在）。

**参考文件**：
- `renderer/plot.py` — 旧 render 函数
- `ARCHITECTURE_REVIEW.md` — 原始问题描述

**实现要求**：
1. `renderer/plot.py:render_matplotlib` 中删除 `default_raw` fallback（硬编码假数据）。改为当 `raw_data.categories` 或 `raw_data.groups` 缺失时直接 raise ValueError（当前已部分实现，验证一致性）
2. `renderer/plot.py:render_scatter_fit` 中删除硬编码 FeP 文本。改为从 `spec.colors` 读取分组名，无颜色映射时用普通索引名
3. 确认 ChartPreview 不手绘 SVG（旧 bar / ranked_response 手绘代码已经不在？检查 `src/hooks/` 中是否残留。之前说已删除，确认一下）
4. `server.ts` 中格式转换不拆到独立文件，但加注释标明「拆出方向：renderer/convert.py」
5. 确认 editableSvg 竞争路径在主流程中已不可达（通过任务 A/B/C/D 后自然消失，不做额外修改）
6. `tsc --noEmit` 零错误

---

## 执行建议

```
推荐顺序：
  1. 任务 A（RightSidebar） ← 最可见，用户能立刻看到 manifest 控件
  2. 任务 B（ChartPreview） ← 清理旧残骸
  3. 任务 C（App.tsx）       ← 状态模型简化，依赖 A+B 完成
  4. 任务 D（autoSync）      ← 管线完全切到新路径
  5. 任务 E（svgEditor）     ← 清理工具函数
  6. 任务 F（P1 债）          ← 收尾

每个任务独立，可以并行执行（只要不互相依赖文件）。
```

---

## 前置检查

任何任务开始前，确认：

```bash
cd E:\ai绘图修改编辑
npx tsc --noEmit              # 必须零错误
python -c "from renderer.introspector import introspect_figure, replay_render; print('import OK')"
```

每个任务完成后，同样跑 `npx tsc --noEmit` 确认类型不损坏。
