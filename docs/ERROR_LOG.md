# SciFigure 错误记录与修复日志

> 用于记录真实诊断文件、根因、修复动作和遗留风险。结论必须区分“平台问题”和“AI 转义脚本问题”。

---

## 2026-07-07 白色输出画布与真实绘图区控制入口不清晰

**现象**

- 用户在编辑器中看到标签跑到白色画布外，但不知道应调整“整张白色画布”还是“坐标轴框/真实绘图区”。
- 右侧面板已有 `figure.width_in` / `figure.height_in` 控件，也已有 `subplot.left/bottom/width/height` 控件，但命名为“画布尺寸与精度”“子图位置与比例”，用户容易理解成只能改画布，找不到真正的坐标轴框宽高入口。
- R/ggplot facet 子图不支持独立 bounds，但前端批量能力之前没有统一读取 `unsupportedProps` 做禁用保护，容易造成“控件可见但实际不应支持”的误解。

**根因**

- 后端协议已经区分两类尺寸：
  - `global:figure.width_in/figure.height_in` 控制最终白色输出画布。
  - `subplot.*:left/bottom/width/height` 控制 Matplotlib Axes 在白色画布内的真实绘图区/坐标轴框。
- 前端文案没有把这两类尺寸解释清楚，也没有在组件中心批量入口中明确“绘图区宽高”和“画布宽高”的边界。
- R facet 使用 ggplot gtable 共享布局，独立 panel bounds 不等价于 Matplotlib axes bounds，因此只能明确提示不支持，不能假装支持。

**修复**

- 将右侧全局面板标题改为“整张白色画布 / 输出尺寸”，并增加说明：它控制最终导出的白色画布大小和 DPI。
- 将 `subplot.*` 专用面板标题改为“真实绘图区 / 坐标轴框”，将 `left/bottom/width/height` 显示为“绘图区左边距/下边距/宽度/高度”。
- 在 `subplot.*` 面板中增加工作流提示：先固定白色画布，再调整真实绘图区；标签出界时通常需要增大画布或移动/缩小绘图区。
- 前端读取 `currentProps.unsupportedProps`，对 R facet 等不支持独立 bounds 的对象隐藏对应控件并展示不支持原因。
- 组件中心的批量“真实绘图区 / 坐标轴框”入口只对 `subplot` 对象显示，避免误用于 colorbar 等其它 `width/height` 语义不同的对象。

**验证**

- `npx tsc --noEmit`：通过。
- `python tests/test_introspection.py`：通过，16 tests。
- `python tests/test_r_renderer.py`：通过，17 tests。
- `npm test`：通过，5 files / 42 tests。
- `npm run build`：通过；仍存在项目既有 chunk size warning 与 `server.ts` 的 `import.meta` CJS warning。

---

## 2026-07-07 拖动刻度标签后重绘回到原位置

**现象**

- 用户开启拖拽模式后拖动坐标轴刻度标签，例如 `xtick.*` / `ytick.*`。
- SVG 预览阶段标签会跟随鼠标移动，但确认重绘后又回到轴系统原来的布局位置。

**根因**

- Matplotlib 的刻度标签不是普通自由文本，而是由 Axis/Tick layout engine 管理。
- 平台之前把 tick label 按普通 `text` 对象继承了 `position` 编辑能力，前端也允许其进入拖拽写回流程。
- 重绘时 `_freeze_ticklabels_preserving_style()` 和 Matplotlib tick 系统会重新固化刻度位置，因此自由 `position` patch 不具备稳定回放语义。
- 正确的稳定控制参数应是 `axis.x/y.*` 上的 `tick_pad`、`tick_rotation`、`tick_labelsize`、`tick_labelfamily`、`tick_labelcolor`，以及 `subplot.*` 绘图区边距/宽高。

**修复**

- `renderer/introspector.py`：
  - 对 `xtick.*` / `ytick.*` 移除 `position` 可编辑字段。
  - 保留 `fontsize`、`fontfamily`、`fontweight`、`fontstyle`、`color`、`rotation` 等样式编辑。
  - 在 `currentProps` 中加入 `positionEditable=false` 与原因说明。
- `src/components/ChartPreview.tsx`：
  - 拖拽模式下显式排除 `xtick.*` / `ytick.*` 及 `x_tick_label` / `y_tick_label` 角色。
  - 用户尝试拖动刻度标签时提示改用轴面板的刻度间距、旋转、字号或绘图区边距。
- `tests/test_introspection.py`：
  - 新增回归测试，确认 tick label 不再暴露不稳定的 `position`，但仍保留样式编辑能力。

**验证**

- `python tests/test_introspection.py`：通过，17 tests。
- `python tests/test_r_renderer.py`：通过，17 tests。
- `npx tsc --noEmit`：通过。
- `npm test`：通过，5 files / 42 tests。
- `npm run build`：通过；仍存在项目既有 chunk size warning 与 `server.ts` 的 `import.meta` CJS warning。

---

## 2026-07-07 需要整体平移刻度文字但保持刻度线不动

**需求**

- 用户希望将横坐标刻度文字整体向右微调一点。
- 刻度线、刻度值和数据坐标范围不能变化。
- 不能回到之前“自由拖拽单个 tick label”的不稳定方案。

**设计**

- 新增轴级稳定参数：
  - `tick_label_dx`：刻度文字水平偏移，单位 pt。
  - `tick_label_dy`：刻度文字垂直偏移，单位 pt。
- 该参数作用在 `axis.x.*` / `axis.y.*`，通过 Matplotlib text transform 加 `ScaledTranslation` 实现。
- 偏移只作用于 tick label 文本，不调用 `set_xticks` / `set_xlim`，因此不会移动刻度线、不会改变数据范围。
- R/ggplot 暂不暴露该控件；ggplot 需要另走 theme margin / justification 映射，不能复用 Matplotlib transform 方案。

**修复**

- `renderer/introspector.py`：
  - 在 axis manifest 中加入 `tick_label_dx` / `tick_label_dy`。
  - 在 axis patch 中支持这两个参数。
  - 在 `_freeze_ticklabels_preserving_style()` 后重新应用 tick label offset，避免 Matplotlib 固化 tick labels 时丢失偏移。
- `src/components/RightSidebar.tsx`：
  - 在轴详情面板中显示“刻度文字水平偏移(pt)”和“刻度文字垂直偏移(pt)”。
  - 仅当 manifest 明确声明 editable 时显示，避免 R 路径出现假控件。
- `tests/test_introspection.py`：
  - 新增回归测试，确认设置 offset 后 manifest 可读回，同时轴 limits 不变。

**验证**

- `python tests/test_introspection.py`：通过，18 tests。
- `python tests/test_r_renderer.py`：通过，17 tests。
- `npx tsc --noEmit`：通过。
- `npm test`：通过，5 files / 42 tests。
- `npm run build`：通过；仍存在项目既有 chunk size warning 与 `server.ts` 的 `import.meta` CJS warning。

---

## 2026-07-07 拖动图例内部文字导致文字跑到左下角

**现象**

- 用户在拖拽模式下移动图例相关内容。
- 图例中的线条/点/色块位置不变，但图例文字脱离图例布局，跑到左下角或其它异常位置。

**根因**

- Matplotlib legend 是一个容器布局系统。
- `legend.0` 是可稳定移动的图例容器。
- `legend_text.*` / `legend_title.*` / `legend_line.*` / `legend_patch.*` 是容器内部子对象，位置由 legend layout 管理。
- 旧协议把 `legend_text.*` / `legend_title.*` 作为普通 text 继承了 `position` 编辑能力；一旦写入 position patch，文字会脱离 legend 容器，而图例符号仍留在容器布局中。

**修复**

- `src/components/ChartPreview.tsx`：
  - 拖拽模式下点击 `legend_text.*` / `legend_title.*` / `legend_line.*` / `legend_patch.*` 时，自动归一到对应 `legend.N` 容器。
  - `legend_text` / `legend_marker` 角色不再作为独立可拖拽对象。
- `renderer/introspector.py`：
  - `legend_text.*` / `legend_title.*` 不再暴露 `position` 编辑能力。
  - 保留图例文字的字体、字号、颜色、字重、斜体等样式编辑能力。
  - 对旧 editLog 中的 `legend_text.* position` / `legend_title.* position` 返回 `unsupported_legend_child_position`，避免继续破坏图例布局。
- `tests/test_introspection.py`：
  - 新增回归测试，确认 `legend.0` 仍可移动，`legend_text.*` 不暴露 `position`，旧子文字 position patch 会被拒绝并产生 warning。

**验证**

- `python tests/test_introspection.py`：通过，19 tests。
- `python tests/test_r_renderer.py`：通过，17 tests。
- `npx tsc --noEmit`：通过。
- `npm test`：通过，5 files / 42 tests。
- `npm run build`：通过；仍存在项目既有 chunk size warning 与 `server.ts` 的 `import.meta` CJS warning。

---

## 2026-07-07 多图模式从 3 张扩展到更多 Figure 时前端不显示新增图

**现象**

- 用户怀疑多图模式被限制为最多 3 张 Figure。
- Python 后端实际可以捕获任意数量的 Matplotlib Figure，但当前前端在项目已有 3 张图时，如果代码重新渲染生成 4 张或更多，Figure 切换条仍可能只显示旧的 3 张。

**根因**

- 后端 `renderer/introspector.py` 按 `unique_figures` 循环返回 `fig_1 ... fig_N`，没有 3 张上限。
- 前端 `src/App.tsx` 多个全量项目渲染成功分支使用 `Object.keys(projectFigures)` 作为更新范围。
- 当代码生成了新增 Figure，例如 `fig_4` / `fig_5`，这些 id 不在旧 `projectFigures` 中，因此前端不会把后端返回的新 Figure 合并进状态。
- 这表现为“后端说捕获了更多图，但编辑器仍只能切到旧的几张图”。

**修复**

- `src/App.tsx`：
  - 新增 `mergeReturnedProjectFigures()`，全量项目渲染成功后以后端返回的 `data.figures` 为准重建 `projectFigures`。
  - 保留同名 Figure 的 editLog / revision fallback，但允许新增 `fig_N` 自动进入前端状态。
  - 当 Figure 数量减少时，前端状态也随返回结果收敛，避免旧 Figure 残留。
  - 清理 `selectedFigureIds`，移除已不存在的 Figure；当前 active Figure 不存在时自动切到返回的第一张。
  - 修复空 Figure 项目首次渲染时 requestId 无绑定导致渲染状态可能不结束的边界。
- `tests/test_introspection.py`：
  - 新增 Python 回归测试，脚本创建 5 张 Matplotlib Figure 时必须返回 `fig_1` 到 `fig_5`。

**验证**

- `python tests/test_introspection.py`：通过，20 tests。
- `python tests/test_r_renderer.py`：通过，17 tests。
- `npx tsc --noEmit`：通过。
- `npm test`：通过，5 files / 42 tests。
- `npm run build`：通过；仍存在项目既有 chunk size warning 与 `server.ts` 的 `import.meta` CJS warning。

**遗留说明**

- Python/Matplotlib 多 Figure 路径现在按代码实际生成数量显示。
- R 项目渲染当前仍由 `server.ts` 包装为单 `fig_1`，这是 R 渲染路径的现有限制，不属于 Python 多图显示上限。

---

## 2026-07-06：画布顶栏控件覆盖 Figure 批量选择复选框

**现象**

- 画布升级时把 Figure 切换器从画布浮层移动到顶部预览工具栏。
- 在自动化回归中，点击 `选择 Figure 2 作为批量应用目标` 超时。
- Playwright 证据显示右侧状态胶囊（`实时渲染` / `真实 SVG 对象可直接编辑`）拦截了 Figure 复选框的 pointer event。

**根因**

- 平台 UI 布局问题。
- Figure 选择器和右侧状态区放在同一行，窄宽度或状态文案较长时发生视觉重叠，导致复选框虽然可见但点击目标被右侧元素覆盖。

**修复记录**

- `src/components/MainWorkspace.tsx`：
  - 将 Figure 选择器从顶栏同一行拆到预览区上方的独立窄工具条。
  - 工具条保持在画布外部，不再遮挡图形内容。
  - 选中对象黑色浮层从画布内部移到顶部状态 chip，避免中间黑色浮层裁切/遮挡。
- `src/components/ChartPreview.tsx`：
  - 画布铺满预览区域。
  - 缩放和操作提示移动到底部 HUD。
  - 拖拽确认条移动到顶部安全区。

**验证**

- `npx tsc --noEmit`：通过。
- `npm test`：通过，42/42。
- `npm run test:drag-extended-smoke`：通过，覆盖连续拖拽、多选拖拽、取消、R native 保护。
- `npm run test:cross-figure-smoke`：通过，覆盖 Figure 复选框点击、应用全部、应用选中、多子图 grid/spine fanout。
- `npm run build`：通过；仍存在项目既有 Vite chunk 过大和 `server.ts import.meta` CJS 警告。

**遗留风险**

- `npm run test:behavior-smoke` 在 `http://localhost:3100` 仍有 3 项失败：stale 文本最终断言、导出最新文本断言、Vite HMR WebSocket console/page error。导出矩阵专项测试已通过，行为 smoke 的 patch/export 最新文本一致性需单独调查，不能归因于本次画布布局改动。

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

---

## 2026-07-06 跨图“应用全部图”从单图应用到多子图时只改左上角

**现象**

- 一段代码生成 3 张 Figure，其中 `fig_3` 是 2x2 多子图。
- 用户在 `fig_2` 单图里修改框线/刻度等样式后点击“应用全部图”。
- 结果 `fig_3` 只有左上角第一个子图生效，其余子图没有同步。

**根因**

- `src/utils/semanticPatchMapping.ts` 的跨 Figure 映射每条 patch 只返回一个目标 gid。
- 当源 Figure 是单子图，目标 Figure 是多子图时，`spine_group.0`、`axis.x.0` 等 gid 会优先命中目标的 `subplot.0` 相关对象。
- 对于样式类操作，用户语义是“把这个样式应用到目标 Figure 的所有同类子图”；旧逻辑错误地按“找一个最佳匹配对象”处理。
- 进一步验证发现组件中心“边框 / 网格”实际会发送 `grid.*` 和四边 `spine.left/right/top/bottom.*` patch；旧 fanout 如果不保留 spine 边方向，会把 left/right/top/bottom 都映射到目标 left 边，造成重复和漏改。

**修复**

- 为跨 Figure 语义映射增加样式类 fanout：
  - 仅当源 Figure 为单子图、目标 Figure 为多子图时触发。
  - 仅对样式类属性触发，例如 `linewidth`、`color`、`tick_labelsize`、`tick_width`、`visible` 等。
  - 文本内容、坐标范围、位置、布局类 patch 仍保持一对一，避免误改。
- 为单边 `spine` 增加同边约束：
  - `spine.left.0` 只映射到目标 `spine.left.*`。
  - `spine.right/top/bottom` 同理。
- 扩展 `tests/playwright/cross_figure_apply_smoke.mjs`：
  - fixture 改为 3 张图，`fig_3` 为 2x2 多子图。
  - 新增 `X3-single-to-multisubplot-style-fanout`，验证从 `fig_2` 单图修改“边框 / 网格”线宽后，`fig_3` 收到 `grid.0-3` 和四边 `spine.left/right/top/bottom.0-3` patch。

**验证**

- `npm test`：通过，5 files / 42 tests。
- `npx tsc --noEmit`：通过。
- `npm run test:cross-figure-smoke`：通过。
- 最新报告：
  - `output/playwright/cross-figure-apply-2026-07-06T13-16-03-214Z/report.md`
  - `Conclusion: PASS, PASS=5, FAIL=0, BLOCKED=0`

---

## 2026-07-06 拖拽模式连续移动第二个文本时仍停留在第一个对象

**现象**

- 用户开启拖拽模式后，先拖动第一个文本对象，不点击“确认位置”。
- 再尝试拖动第二个文本对象时，第二个对象没有进入待确认队列；表现为只能记录第一次拖拽，继续选第二个时状态仍像停留在第一个对象。
- 该路径不等同于“预先多选两个对象后拖动一次”，旧自动化只覆盖了后者。

**根因**

- 待确认浮层位于画布上方，文案容器使用默认 `pointer-events:auto`。
- 当待确认浮层覆盖在第二个文本对象上方时，浏览器命中的是浮层 `div`，不是 SVG 文本节点，`handleSvgPointerDown` 无法进入文本拖拽分支。
- 前端拖拽协议之前没有明确区分“待确认 UI”与“画布交互层”的指针事件边界，也缺少“先拖 A 待确认，再拖 B 待确认”的 sequential regression test。

**修复**

- 将待确认浮层和拖拽提示浮层改为 `pointer-events:none`，避免遮挡画布拖拽命中。
- 将“确认位置 / 取消”按钮单独保留 `pointer-events:auto`，确保按钮仍可点击。
- 增加坐标级拖拽命中兜底：拖拽模式下优先使用 `event.target`，若目标不是可拖文本，则按鼠标坐标扫描可拖文本 bbox，降低 SVG path / overlay / target retargeting 导致的误命中。
- 拖拽结束后抑制紧随其后的 click 事件，避免 click 事件把已拖动对象又改回旧选中态。
- active drag 期间重放已有 pending transform，但不让 pending replay 覆盖正在拖动的新对象。

**验证**

- 新增 `tests/playwright/drag_extended_smoke.mjs` 的 `D1-sequential-drag`：
  - 拖动 `text.0.0` 后不确认，确认条显示累计 1 个文本对象。
  - 继续拖动 `text.0.1` 后不确认，确认条显示累计 2 个文本对象。
  - 点击确认后只发送 1 个 `/api/figure/patch` 请求，包含 `text.0.0` 与 `text.0.1` 两条不同 `position` patch。
- `npm run test:drag-extended-smoke`：通过。
- 最新报告：
  - `output/playwright/drag-extended-2026-07-06T13-37-15-217Z/report.md`
  - `Conclusion: PASS, PASS=7, FAIL=0, BLOCKED=0`
- `npx tsc --noEmit`：通过。
- `npm test`：通过，5 files / 42 tests。
- `npm run build`：通过；仍存在既有 chunk size warning 与 `server.ts` 的 `import.meta` CJS warning。

---

## 2026-07-07 组合代码项目多文件数据源错配与渲染中不停止

**现象**

- 用户从多个 Figure 创建“组合代码项目”后，AI 转写出的脚本渲染失败。
- 诊断文件 `组图_render_diagnostic_2026-07-07T03-12-24-487Z.md` 报错：
  - `SHAP data must contain 'display_name' and 'mean_abs_shap' columns`
- 前端同时出现“渲染中”状态不停止的问题。

**根因**

- 当前组合项目包含多个数据文件，第一份文件是 `Table4_classification_metric_summary.csv`，SHAP 表实际是 `Table6_logistic_shap_summary.csv`。
- AI 转写代码中的 `load_shap_data()` 使用 `pd.DataFrame(_uploaded_data)`，但平台多文件项目里 `_uploaded_data` 是默认/首个数据表，不等于用户想要的 SHAP 表。
- 因此 `display_name`、`mean_abs_shap` 不存在，脚本主动抛出 ValueError。
- 渲染状态不停止的前端问题来自项目级渲染请求的全局 loading 收敛条件过窄：部分分支用当前 active figure 的 `requestId` 判断是否关闭 `projectIsRendering`。用户切换 Figure、跨图渲染、或错误返回后，目标 Figure 已进入 error，但全局 loading 可能仍保持 true。

**修复**

- 收紧组合代码项目生成的网页 AI 提示词：
  - 多文件项目禁止使用 `_uploaded_data` 猜当前数据。
  - 必须通过 `_uploaded_file_paths["具体文件名.csv"]` / `_uploaded_file_paths["具体文件名.xlsx"]` 精确读取每个面板需要的数据。
  - 绘图前必须断言对应 DataFrame 是否包含所需列，并在错误中明确文件名和缺失列。
- 前端项目级渲染状态改为活跃请求集合：
  - 开始项目级渲染时登记 `requestId`。
  - 成功、失败、异常、stale response 结束时注销该 `requestId`。
  - 只有活跃请求集合为空时才关闭 `projectIsRendering` 和 `renderProgressText`。
  - 图级 stale response guard 仍保留，只是不再用 active figure 判断全局 loading 是否收敛。

**当前诊断对应的代码修正建议**

- 将：
  - `df = pd.DataFrame(_uploaded_data)`
- 改为：
  - `df = pd.read_csv(_uploaded_file_paths["Table6_logistic_shap_summary.csv"])`
- 如果新项目中复制后的文件名带项目名前缀，应使用组合提示词列出的 copied filename。

**验证**

- 待本次代码改动完成后运行：
  - `npx tsc --noEmit`
  - `npm test`
  - `npm run build`
  - `npm run test:composition-code-project`
