# SciFigure 错误记录与修复日志

> 用于记录真实诊断文件、根因、修复动作和遗留风险。结论必须区分“平台问题”和“AI 转义脚本问题”。

---

## 2026-07-03：R 项目渲染误走 Python 校验与上传 CSV 读取失败

**相关诊断文件**

- `C:\Users\SZC\OneDrive\Desktop\发票报账\R语言测试_render_diagnostic_2026-07-03T09-09-49-298Z.md`

**现象**

- 诊断中的脚本内容是 R/ggplot2，但代码块标记显示为 `python`。
- 日志同时出现两类错误：
  - `脚本安全校验失败: Syntax Error: invalid syntax at line 7`
  - `R script failed: 'file'...`
- 用户脚本使用：

```r
read.csv(uploaded_file_paths[["cluster_type_TP_boxplot_altscheme_analysis_data.csv"]], check.names = FALSE)
read.csv(uploaded_file_paths[["cluster_type_TP_altscheme_group_statistics(1).csv"]], check.names = FALSE)
```

**根因**

- 平台问题 1：项目级 `/api/projects/:id/figures/render` 之前按 Python 路径先做 AST 校验，R 脚本中的 `library()` / `<-` 会被 Python parser 当成语法错误。
- 平台问题 2：R 渲染路径直接把项目文件路径交给 R `read.csv()`。在 Windows 下，项目根路径包含中文时，R 对 `setwd()` 和绝对路径读取不稳定。
- 平台问题 3：该 CSV 包含中文表头、Unicode 单位、引号内逗号等内容，base R `read.csv()` 对这类上传文件解析不稳定，出现 `no lines available in input` / 列数不匹配等错误。
- AI 转义脚本本身不是首要问题：脚本按平台约定使用 `uploaded_file_paths[[原始文件名]]` 读取多文件，这个用法是合理的。

**修复记录**

- `server.ts`：
  - 新增/统一 `inferScriptLanguage()`，项目渲染接口按 R/Python 分流。
  - R 项目渲染不再调用 Python `validateAst()`。
  - R 渲染前把上传文件复制到 ASCII 临时目录，避免 R 直接访问中文项目路径。
  - 对 CSV/TSV/TXT 上传文件使用 PapaParse 预解析，生成 `.scifigure-table.json` sidecar，并通过 `csv_json_paths` 注入 R renderer。
- `renderer/r_renderer.R`：
  - `read.csv()` / `read.table()` 优先检测 `csv_json_paths`。
  - 命中平台 sidecar 时，直接把 JSON rows 转成 data.frame，并尊重 `check.names = FALSE`，避免 base R CSV parser 处理复杂中文 CSV。
  - 未命中 sidecar 时继续回退到 base R 读取，兼容普通本地 R 脚本。
- `tests/test_r_renderer.py`：
  - 新增上传 CSV JSON bridge 回归测试，覆盖中文表头、引号内逗号、`uploaded_file_paths[[...]]` 读取路径。

**验证**

- 真实诊断项目 `cc147f0d-be84-4fd7-9af7-cc68516af537` 重新调用 `/api/projects/:id/figures/render`：
  - `status: success`
  - `language: r`
  - `figures: 1`
  - `manifest.objects: 20`
  - `svgLength: 33283`
- `C:\Users\SZC\.conda\envs\Machine-learning\python.exe tests/test_r_renderer.py`：通过，9/9。
- `C:\Users\SZC\.conda\envs\Machine-learning\python.exe tests/test_introspection.py`：通过，12/12。
- `npx tsc --noEmit`：通过。
- `npm run lint`：通过。
- `npm run build`：通过；仍存在项目既有警告：前端 chunk 超过 500KB、CJS build 下 `import.meta.url` 警告。

**状态**

- 平台 R 多文件读取路径已修复并通过真实项目验证。
- 诊断导出中代码块语言标记仍显示 `python`，属于诊断文档展示问题，不影响渲染；后续可把诊断导出按 `script_language` 标成 `r`。

---

## 2026-07-02：多文件项目单图渲染数据绑定错误

**相关诊断文件**

- `C:\Users\SZC\OneDrive\Desktop\发票报账\示例_render_diagnostic_2026-07-02T06-57-51-031Z.md`
- `C:\Users\SZC\OneDrive\Desktop\发票报账\示例_render_diagnostic_2026-07-02T07-12-20-022Z.md`

**现象**

- 早期错误：脚本通过 `_uploaded_file_paths["文件名"]` 读取多文件时，在部分 patch/code-patch 路径里找不到上传文件路径。
- 当前错误：`脚本执行失败: 'feature'`，诊断显示当前 `_uploaded_data` 的列是 `FL9_机制重绘输入矩阵.csv` 的列：
  `Sample_ID, LNRR, Response_Group, OPR, NaHCO3_P, DOC, OPR_FeP, FeII, NH4_NO3_Ratio, log_nosZ_norB_Ratio`
- 但脚本在 `plot_fl9_panel()` 中执行 `stats_df["feature"]`，实际需要的是 `FL9_机制变量统计表.csv`。

**根因**

- 平台问题已修：项目模式的 patch/code-patch 路径之前过度依赖 `sessionId`，当 session 上下文缺失或不完整时，无法稳定重建 `_uploaded_file_paths`。
- 当前诊断的新问题是 AI 转义脚本的数据绑定错误：脚本使用 `pd.DataFrame(_uploaded_data)` 作为 `stats_df`，但 `_uploaded_data` 在该项目中对应第一个上传文件 `FL9_机制重绘输入矩阵.csv`，不是统计表。因此缺少 `feature` 列。

**平台修复记录**

- `server.ts`：新增项目 Figure 上下文回退解析，支持从 `projectId + figureId` 或 `${projectId}_fig_N` 形式的 session 标识重建项目文件路径、主数据、工作目录和数据集上下文。
- `src/App.tsx`：项目模式下调用 `/api/figure/patch` 和 `/api/figure/code-patch` 时同时发送 `projectId` 与 `figureId`，避免后端只能依赖 session。
- 验证：创建临时多文件项目，脚本通过 `_uploaded_file_paths["input.csv"]` 读取数据；随后用错误 `sessionId` 但正确 `projectId + figureId` 调用 code-patch，仍能重建文件路径并成功渲染。

**AI 转义修复要求**

多文件脚本不要用 `_uploaded_data` 代替任意表。每一张表必须按原始文件名显式读取：

```python
def load_data() -> tuple[pd.DataFrame, pd.DataFrame, pd.DataFrame]:
    fl9_data = pd.read_csv(_uploaded_file_paths["FL9_机制重绘输入矩阵.csv"])
    stats_df = pd.read_csv(_uploaded_file_paths["FL9_机制变量统计表.csv"])
    opr_fep_df = pd.read_excel(
        _uploaded_file_paths["OPR_FeP二维交互响应图_绘图数据.xlsx"],
        sheet_name="输入数据与预测",
    )
    return fl9_data, stats_df, opr_fep_df


fl9_data, stats_df, opr_fep_df = load_data()
build_figure(fl9_data, stats_df, opr_fep_df)
```

**预防动作**

- 已更新 `docs/AI-PROMPT.md`：多文件项目必须显式读取每个文件，禁止把 `_uploaded_data` 当成统计表、映射表或预测表。
- AI 转义脚本应在读取后校验每个文件的必需列，错误信息必须包含文件名、缺失列和当前列。

**状态**

- 平台上下文注入问题：已修复并验证。
- 当前 `feature` 缺列问题：属于当前转义脚本的数据绑定错误，需要按上面的多文件读取结构修正脚本。

---

## 2026-07-02：配色中心改颜色后无法撤销

**现象**

- 用户在配色中心修改颜色后，点击撤销没有恢复到改色前的颜色。
- 普通属性颜色修改通常走 `editLog`，但配色中心的“修改组颜色代码常量”走 `code_patch`。

**根因**

- 项目模式的历史快照只保存了 `editLog`。
- 配色中心全局改色会修改 Python 脚本里的颜色常量，即修改 `script`，但不会形成对应的普通 `editLog` 颜色条目。
- 撤销时系统只把 `editLog` 回退，再用当前脚本重新渲染；当前脚本已经是改色后的脚本，所以颜色不会回退。

**修复记录**

- `src/schemas/manifest.ts`：`HistorySnapshot` 增加可选 `script` 字段。
- `src/App.tsx`：
  - `makeHistorySnapshot()` 支持保存当前脚本。
  - 项目撤销、重做、历史跳转时，如果快照包含脚本，则用快照脚本重新渲染。
  - 撤销由 code_patch 产生的颜色变化时，即使 `editLog` 为空，也允许根据历史快照回退。
  - 回退脚本后同步更新 `spec.custom_script`，避免下一次重渲染又使用改色后的脚本。

**验证**

- `npx tsc --noEmit`：通过。
- `npm run lint`：通过。
- `npm run build`：通过；仍存在已知打包警告：chunk size 超过 500KB、`server.ts` 的 CJS `import.meta.url` 警告。

**状态**

- 新产生的配色中心 code_patch 历史已支持撤销/重做。
- 旧 sessionStorage 中已经存在的历史快照不包含 `script` 字段，无法补全过去的脚本快照；重新改色后生成的新历史可正常回退。

---

## 2026-07-02：拖拽模式引入后普通选中、文本拖动和子图选框失效

**现象**

- 未开启拖拽开关时，用户不能像旧版一样单击 SVG 图元后在右侧属性面板编辑。
- 开启拖拽开关后，用户期望直接拖动文本/标签，不需要按空格；实际拖不动任何内容。
- 在子图面板中选中某个子图时，画布没有出现对应子图选框。

**根因**

- `ChartPreview.tsx` 使用了 `[id="${CSS.escape(gid)}"]` 形式的属性选择器查找 SVG 节点。
- `CSS.escape("title.0")` 会生成带反斜杠的字符串，放进属性选择器后会查找字面量反斜杠，导致 `title.0`、`axes.0`、`spine.left.0` 等 Matplotlib gid 查找失败。
- 选中框、框选和拖拽预览都依赖这个查找链路，所以表现为“选中了但没有框”“拖拽找不到元素”。
- `subplot.N` 是平台生成的逻辑对象，不一定有同名 SVG 节点；真实 SVG 里对应的是 Matplotlib 输出的 `axes.N` 分组，因此子图选中需要显式回退映射。

**修复记录**

- `src/components/ChartPreview.tsx`：
  - 新增 `querySvgElementById()`，统一使用 `#${CSS.escape(id)}` 的 ID 选择器查找真实 SVG 节点。
  - 新增 `getSelectableSvgElement()`，当选中 `subplot.N` 时回退到 `axes.N`，保证子图面板选中能显示画布选框。
  - 选中框、框选、多选、拖拽预览和拖拽恢复全部切到同一套查找函数，避免不同交互路径行为不一致。
  - 拖拽模式下，文本对象显示 `grab` 光标并允许直接拖动；空格只保留为平移画布用途。
  - 只有实际移动超过阈值时才生成“确认位置”patch，避免单击文本就产生无意义的位置修改。

**验证**

- `npx tsc --noEmit`：通过。
- `npm run lint`：通过。
- `npm run build`：通过；仍存在项目既有警告：前端 chunk 超过 500KB、`server.ts` 的 CJS `import.meta.url` 警告。

**状态**

- 已完成代码修复和静态验证。

---

## 2026-07-02：拖拽后文本跳回原位且没有确认/取消提示

**现象**

- 拖拽模式开启后，文本拖动过程中可以跟随鼠标移动。
- 松开鼠标后，文本立即跳回原来的位置。
- 画布上没有出现“确认位置 / 取消”的提示条，因此位置无法写回 Python 坐标。

**根因**

- 拖拽过程中只是对 SVG 节点临时写入 `transform translate(...)`，真正持久化依赖松手时生成 `position` 类型的 `backend_patch`。
- `buildPositionPatch()` 对 axes 坐标系文本需要找到所属子图的坐标框；旧 manifest 或部分文本对象可能缺少 `subplotId/source.axesIndex`，导致无法计算归一化坐标变化，最终返回空 patch。
- patch 数组为空时，前端会调用 `clearDragPreview()` 清掉临时 transform，所以表现为文本跳回原位。
- 另外，原逻辑在生成 pending patch 后立刻清空 `dragStartRef`，会破坏后续“取消”恢复预览位置的能力。

**修复记录**

- `src/components/ChartPreview.tsx`：
  - 新增 `inferAxesIndexFromGid()`，从 `source.axesIndex`、`subplotId` 和常见 gid 后缀（如 `title.0`、`xlabel.0`、`legend_text.0.1`）多级推断所属子图。
  - `getAxesBoxForObject()` 使用该推断结果作为兜底，避免旧 manifest/缺字段文本无法生成位置 patch。
  - 如果仍无法找到物理 axes 框，则用 SVG viewBox 尺寸做保底换算，避免静默放弃 patch。
  - window `pointerup` 处理器使用最终松手坐标重新计算位移，避免最后一帧 pointermove 丢失导致 patch 为零。
  - React 画布容器自身的 `onPointerUp` 也会调用同一套 finalize 逻辑，避免 pointer capture 场景下只依赖 window 事件导致结束拖拽不稳定。
  - 有待确认 patch 时保留拖拽预览上下文，不立即清空 transform；只有取消、无有效移动或 SVG 重新渲染时才清理。
  - 增加 `dragPendingRef`，防止用户点击“确认/取消”按钮时的 pointerup 被误当作新的拖拽结束重新计算位置。
  - 点击“确认位置”时保留当前预览 transform，只清理内部拖拽状态，避免确认瞬间先跳回原位再等待后端渲染的闪烁。

**验证**

- `npx tsc --noEmit`：通过。
- `npm run lint`：通过。
- `npm run build`：通过；仍存在项目既有警告：前端 chunk 超过 500KB、`server.ts` 的 CJS `import.meta.url` 警告。
- 已重启 `npm run dev` 服务；新服务监听 `http://localhost:3000`，启动时间约 `2026-07-02 18:50`。

**状态**

- 已完成代码修复和静态验证。
- 仍需浏览器手动确认：拖动文本后提示条出现；点击取消恢复原位；点击确认后重新渲染并保留新位置。

**后续实测补充**

- 现象：确认/取消条已经出现，拖动中对象能随鼠标移动，但松手后对象仍像“粘在鼠标上”；必须取消选中才能点击确认/取消。
- 进一步根因：`dragStartRef` 同时承担“正在拖动”和“待确认可恢复”的两种状态。进入待确认后它仍然存在，`pointermove` 继续按正在拖动处理，导致对象持续跟随鼠标。
- 二次修复：
  - 拆分 `dragStartRef`（拖动中）与 `dragRestoreRef`（待确认恢复用）。
  - 松手生成 pending patch 后释放 pointer capture，并把 session 移入 `dragRestoreRef`，同时清空 `dragStartRef`。
  - `pointermove` 在 `dragPendingRef` 为 true 时直接返回，冻结当前位置。
  - 确认/取消浮层阻止 pointer/click 冒泡，避免点击按钮时继续触发底层画布事件。
- 二次验证：
  - `npx tsc --noEmit`：通过。
  - `npm run lint`：通过。
  - `npm run build`：通过；仍存在项目既有警告。
  - 已重启 `npm run dev` 服务；新服务监听 `http://localhost:3000`，启动时间约 `2026-07-02 18:57`。

**第三次实测补充**

- 现象：松手后仍有闪烁；确认后能重渲染，但最终位置与拖拽预览不一致，例如向右拖很远，实际只移动约一半距离。
- 进一步根因：拖拽预览和写回 patch 使用的是 `screenDelta / scale` 估算 SVG 位移。该估算没有严格等价于 Matplotlib SVG 的 user units，尤其在 CSS scale、SVG viewBox、导出 width/height 单位同时存在时会产生比例误差。
- 三次修复：
  - `DragSession` 改为记录 `startSvg`，不再只记录屏幕坐标。
  - `pointermove` 和 `pointerup` 都通过 `getSvgPoint(clientX, clientY)` 转为 SVG 坐标。
  - 预览 transform 和 `position` patch 共用同一个 SVG 坐标差 `currentSvg - startSvg`，避免“看见的位置”和“写回的位置”使用两套坐标。
- 三次验证：
  - `npx tsc --noEmit`：通过。
  - `npm run lint`：通过。
  - `npm run build`：通过；仍存在项目既有警告。
  - 已重启 `npm run dev` 服务；新服务监听 `http://localhost:3000`，启动时间约 `2026-07-02 20:50`。

**第四次浏览器自动化实测补充**

- 现象：确认后位置已经准确，但松手待确认阶段仍闪烁/回原位。
- 进一步根因：
  - React 状态更新 `setPendingPositionPatches()` 会触发组件重渲染，`dangerouslySetInnerHTML` 重新写入 SVG 内容，覆盖掉命令式写入的临时 `transform`。
  - 因此即使最终 patch 坐标正确，待确认状态下的预览位置也会丢失。
- 四次修复：
  - 将待确认 transform 保存在 `dragPreview` 状态中。
  - 增加 `applyDragPreviewTransform()`，在 `dragPreview/pendingPositionPatches` 变化后重新把 transform 写回 SVG。
  - 后端 `introspector.py` 给 `ax.patch` 写入稳定 `axes.patch.{idx}` gid。
  - 前端 axes 坐标换算优先使用 `axes.patch.{idx}`，旧 SVG 兜底 `patch_{idx+2}`，最后才使用整图 viewBox。
- 自动浏览器验证：
  - 测试图：单 axes，文本 `text.0.0` 使用 `ax.transAxes`。
  - 操作：拖拽 `120px` 向右、`40px` 向下。
  - 松手待确认位置：`+120.000px, +39.999px`。
  - 点击确认并后端重渲染后位置：`+119.999px, +40.157px`。
  - 结论：预览位置与确认后位置已保持像素级一致。
- 四次验证：
  - `npx tsc --noEmit`：通过。
  - `npm run lint`：通过。
  - `C:\Users\SZC\.conda\envs\Machine-learning\python.exe tests\test_introspection.py`：12/12 通过。
  - `npm run build`：通过；仍存在项目既有警告。

**第五次功能小修：连续拖动多个对象后一次性确认**

- 现象：进入拖拽模式后，用户可能连续移动多个文本/标签，再统一确认。但旧逻辑每次开始拖动都会清空上一轮 `pendingPositionPatches`，只能记录最后一次移动。
- 根因：拖拽 pending 状态以数组保存，缺少按 gid 聚合的累计状态；取消恢复也只保留当前拖拽 session。
- 修复：
  - 新增 `pendingDragDeltasRef`：按 gid 累计每个对象相对原始位置的 SVG 位移。
  - 新增 `pendingPatchMapRef`：按 gid 保存最终要提交的 position patch，同一对象多次移动时只保留最后位置。
  - 新增 `pendingOriginalTransformsRef`：保存每个移动过对象的原始 transform，用于取消时一次性恢复所有对象。
  - 新拖动不再清空已有 pending；确认时提交所有移动过对象，取消时恢复所有移动过对象。
  - 提示文案改为“已累计移动 N 个文本对象”。
- 自动浏览器验证：
  - 连续拖动 `text.0.0`：`+80px, +20px`。
  - 连续拖动 `text.0.1`：`-60px, +35px`。
  - 松手待确认提示：`已累计移动 2 个文本对象`。
  - 确认后重渲染：
    - `text.0.0`：`+79.999px, +20.157px`。
    - `text.0.1`：`-60.000px, +35.157px`。
  - 结论：多对象累计拖动与一次性确认已按预期工作。
- 验证：
  - `npx tsc --noEmit`：通过。
  - `npm run lint`：通过。
  - `npm run build`：通过；仍存在项目既有警告。
