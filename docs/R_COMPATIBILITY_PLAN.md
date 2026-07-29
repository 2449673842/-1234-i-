# R 语言兼容路线与当前边界

> 最后修改时间：2026-07-18 19:21:01 +08:00
> 第二阶段执行计划：`docs/platform-capability/R_EDITING_COMPLETION_EXECUTION_PLAN.md`

## 当前已落地：Phase R1-R5-C 渲染、语义编辑、离散组与坐标身份精细化

SciFigure Studio 当前支持将 R 脚本作为真实渲染输入：

- 前端代码编辑器可选择 `Python / Matplotlib` 或 `R / ggplot2 或 base plot`。
- 支持上传 `.py`、`.R`、`.r` 脚本文件。
- 后端通过 `Rscript` 调用 `renderer/r_renderer.R`，执行 R 脚本并捕获 SVG。
- 支持从 R SVG 转换导出科研常用格式：SVG、PNG、PDF、TIFF。
- R 脚本可读取运行环境中的 `uploaded_data`、`uploaded_file_paths`、`dataPayload`。
- 若脚本生成 ggplot 对象并赋值给 `p`、`plot_obj`、`figure` 或 `fig`，渲染器会自动 `print()`。
- 如果本机没有安装 R 或 `Rscript` 不在 PATH，会返回明确错误：
  `Rscript not found. Please install R and ensure Rscript is available in PATH, or set RSCRIPT_BIN.`

## 当前不承诺：R 的全 SVG 节点级任意编辑

当前 R 路径已经覆盖 ggplot2 的稳定语义层：标题、轴标签、刻度、图例、常见 layer、manual scale、facet、heatmap/colorbar、文本标注位置。它仍不等同于“任意 R 图或任意 SVG 节点都能像 Matplotlib artist tree 一样完整编辑”。

原因：

- 现有核心图元识别基于 Matplotlib artist tree。
- ggplot2 的语义对象、grob 结构和 SVG 节点绑定需要单独协议；当前只为可稳定回放的语义对象开放编辑。
- 如果直接把 R SVG 当普通 SVG 改，会破坏平台的 editLog/replay 可复现原则。

base R 图的 manifest 当前仍标记为：

- `generatedBy: "r_svg"`
- `objects: []`
- `capabilities.localPatch/backendPatch/codePatch: false`

ggplot2 图如果将对象赋值给 `p`、`plot_obj`、`figure` 或 `fig`，当前可识别：

- `title.0`：标题文字、字号、字体、字重、字形、颜色；
- `xlabel.0` / `ylabel.0`：X/Y 轴标签文字和字体样式；
- `axis.x.0` / `axis.y.0`：X/Y 刻度文字字号、字体、颜色；
- `legend.0`：图例标题与图例字体样式。
- `subplot.N`：facet 面板基本信息（面板序号、行列、facet 标签）；
- `facet.strip.0`：统一 facet strip 标题字体、字号、字重、字形、颜色。

这些属性通过 editLog 写回 ggplot `labs()` 和 `theme()`，再重新渲染，支持撤销/重做的重放模型。

## Phase R3-A：ggplot2 图层整体样式编辑

当前已支持识别 ggplot2 的常见 layer，并按 layer 整体修改样式：

- `r.layer.N` + `kind=collection`：`geom_point` / `geom_jitter`，支持 `color`、`facecolor`、`size`、`alpha`；
- `r.layer.N` + `kind=line`：`geom_line` / `geom_path` / `geom_smooth`，支持 `color`、`linewidth`、`linestyle`、`alpha`；
- `r.layer.N` + `kind=patch`：`geom_col` / `geom_bar` / `geom_tile` / `geom_rect`，支持 `facecolor`、`edgecolor`、`linewidth`、`alpha`；
- `r.layer.N` + `kind=errorbar_container`：`geom_errorbar` / `geom_linerange` 等，支持 `color`、`linewidth`、`alpha`。

重要边界：

- `r.layer.N` 是整层样式覆盖。
- R SVG 输出会为该 layer 对应的主 SVG primitive 写入 `data-fig-id="r.layer.N"`，前端单击点、线、柱、误差线元素即可选中对应 layer，并在右侧属性编辑中调整参数。
- 如果原图使用 `aes(color=group)`，并且希望只改某个分组颜色，应优先使用 R3-B 生成的 `r.group.color.*` / `r.group.fill.*` 对象。
- 如果修改某个 `r.layer.N` 的颜色，会把该 layer 统一覆盖为指定颜色，这是有意保留的“整层覆盖”能力。

## Phase R3-B：ggplot2 scale/aes 分组颜色语义

当前已支持 `scale_color_manual()` 与 `scale_fill_manual()` 的分组语义识别与重放：

- 识别 manual scale 中的命名颜色，例如 `A="#1F78B4"`、`B="#D62728"`；
- 在 manifest 中生成 `palettes`、`groups`、`bindings`；
- 为每个分组生成可编辑对象：
  - `r.group.color.S.I`：对应 `scale_color_manual` 的某个分组，支持 `color`；
  - `r.group.fill.S.I`：对应 `scale_fill_manual` 的某个分组，支持 `facecolor`；
- 配色中心修改 R 图时走 `backend_patch`，不会走 Python 专用的源码 `code_patch`；
- 导出时重放 editLog，因此 SVG/PNG/PDF/TIFF 与预览保持一致。

重要边界：

- 当前覆盖的是显式 `scale_color_manual()` / `scale_fill_manual()`。
- ggplot 默认离散色板、连续色阶、`scale_*_gradient*()` 暂未纳入 R3-B。
- 当前按 scale 分组改色，不是按单个 SVG 点/线片段改色。

## Phase R3-C：ggplot2 facet 子图语义识别

当前已支持 `facet_wrap()` / `facet_grid()` 产生的 facet 面板发现：

- 根据 `ggplot_build(plot)$layout$layout` 读取 panel、row、col 和 facet 变量；
- 在 manifest 中生成 `subplot.N` 对象，供组件中心按子图范围筛选；
- 生成 `facet.strip.0` 统一 strip 标题对象，支持 `fontsize`、`fontfamily`、`fontweight`、`fontstyle`、`color`；
- strip 标题样式通过 ggplot2 `theme(strip.text=element_text(...))` 重放，导出与预览一致。

重要边界：

- `subplot.N` 当前是面板识别对象，不直接修改 facet 面板位置和比例。
- ggplot2 原生不稳定支持逐个 facet strip 独立设置样式，因此当前只提供全局 strip 标题样式。
- facet 内具体 layer 数据仍按 ggplot layer / scale 语义编辑，不按 SVG 子节点猜测。

## Phase R3-D：ggplot2 heatmap / continuous scale / colorbar

当前已支持 ggplot2 热图和连续色阶的基础语义识别与重放：

- 识别 `geom_tile()` / `geom_raster()` / `geom_rect()` + 连续 `fill/color` scale 为 `heatmap`；
- 生成 `r.heatmap.fill.S` / `r.heatmap.color.S` 对象，支持 `cmap`、`vmin`、`vmax`、`alpha`；
- 生成 `r.colorbar.fill.S` / `r.colorbar.color.S` 对象，支持 `label`、`tick_fontsize`、`visible`；
- 修改 `cmap/vmin/vmax` 时通过 `scale_fill_gradientn()` / `scale_color_gradientn()` 重放；
- 修改 colorbar label/tick/visible 时通过 `labs()`、`theme(legend.text=...)`、`guides(...="none")` 重放；
- 导出时重放同一份 editLog，预览与 SVG/PNG/PDF/TIFF 保持一致。

当前内置色带名：

- `viridis`, `plasma`, `inferno`, `magma`, `cividis`
- `coolwarm`, `seismic`, `bwr`, `rainbow`, `jet`, `gray`, `hot`

重要边界：

- 当前覆盖 ggplot2 连续色阶的基础编辑，不解析任意自定义 palette 函数的语义名称。
- colorbar 在 ggplot2 中本质是 legend，因此当前提供 label、tick 字号、显隐，不提供像 Matplotlib colorbar 那样的物理 `left/bottom/width/height` 定位。
- `geom_tile()` 仍会同时以 `r.layer.N` 形式暴露整层样式；连续色阶应优先通过 `r.heatmap.*` 编辑。

## Phase R4-A/R4-B/R4-C：ggplot2 文本标注识别、拖拽联调与复杂坐标保护

当前已支持 ggplot2 文本标注的基础语义识别、SVG id 绑定与拖拽后端重放：

- 识别 `geom_text()` / `geom_label()` / `annotate("text", ...)` 生成的 `GeomText` / `GeomLabel` layer；
- 为每个文本行生成 `r.text.L.R` 对象；
- 在 R SVG 输出中为对应 `<text>` 节点注入同名 `id="r.text.L.R"`，确保前端画布能真实选中对象；
- 支持 `text`、`fontsize`、`fontfamily`、`fontweight`、`fontstyle`、`color`、`position`；
- manifest 中暴露 `x/y/coord_system="axes"`，可复用前端现有拖拽 patch 契约；
- 后端将 axes 归一化坐标映射回 ggplot 数据坐标，再通过替换对应文本 layer 的 data 重放；
- 前端 `ChartPreview` 已将 `r.text.*` 纳入可拖拽文本 gid，进入拖拽模式后可移动、确认并生成 `position` editLog；
- 导出时重放同一份 editLog，保持预览/导出一致。
- 对 `coord_flip()`、`coord_polar()`、`coord_trans()`、`coord_sf()`、`coord_map()`、`coord_quickmap()` 以及非 identity 的 x/y position scale，后端不暴露 `position` 编辑能力，前端不会进入拖拽；
- 如果旧 session 或手动请求仍然提交了不安全坐标下的 `position` patch，R 后端会忽略该 position 变更并返回 warning，避免把文本写到错误数据坐标。

重要边界：

- 当前覆盖 ggplot 文本 layer，不覆盖任意 grid grob 或 SVG 文本节点猜测。
- position 回写只在安全的线性 ggplot 坐标下开放；复杂坐标当前以禁用/警告保护为主，不做错误近似。
- 每个 `r.text.L.R` 对应 build 后的一行文本数据；如果代码补丁改变文本 layer 行数，gid 可能漂移，需要走后续漂移提示机制。

## 当前与 Python 路径仍未对齐的功能

| 能力 | Python / Matplotlib | R / ggplot2 当前状态 | 后续阶段 |
|---|---|---|---|
| 真实渲染 | 支持 | 支持 | 已完成 |
| SVG/PNG/PDF/TIFF 导出 | 支持 | 支持 | 已完成 |
| 标题/轴标签/图例字体编辑 | 支持 | 支持 ggplot2 | 已完成 R2 |
| 点/线/柱/误差线整体样式 | 支持 | 支持 ggplot2 layer 整体样式 | 已完成 R3-A |
| 按分组/颜色语义改色 | 支持部分 palette/binding | 支持默认/显式离散 color/fill scale，按 group 单独写回 | 已完成 R5-B |
| facet 子图识别 | 支持 Matplotlib 子图 | 支持 facet panel 发现与统一 strip 标题样式 | 已完成 R3-C |
| 热图/colorbar 语义 | 支持 Matplotlib heatmap/colorbar | 支持 ggplot tile/raster 连续色阶和 colorbar 基础编辑 | 已完成 R3-D |
| 文本拖拽位置重放 | 支持 Matplotlib 部分文本 | 支持线性、`coord_flip`、X/Y log 和圆内 `coord_polar` 精确逆变换 | 已完成 R5-C |
| 点/线/柱/误差线画布直选 | 支持 Matplotlib 已绑定 artist | R SVG primitive 可点击映射到 `r.layer.N`，右侧属性编辑按 layer patch | 已完成 R5-A |
| base R 图元编辑 | 不适用 | 只支持预览/导出 | 暂缓 |

## 自动化测试覆盖

R 兼容路径当前已有专用测试：

```bash
C:\Users\SZC\.conda\envs\Machine-learning\python.exe tests/test_r_renderer.py
```

覆盖范围：

- ggplot 标题、轴标签、刻度字体样式重放；
- ggplot layer 整体样式 patch；
- `scale_color_manual()` 分组配色 patch；
- facet panel manifest 与统一 strip 标题样式；
- heatmap / colorbar 连续色阶 patch。
- `geom_text()` / `geom_label()` / `annotate("text")` 文本标注位置 patch。
- R 文本标注对象必须在 SVG 中写出真实 `id="r.text.*"`，防止 manifest 可编辑但画布不可选。
- `coord_flip()`、`scale_x_log10()`、`scale_y_log10()` 使用 ggplot build 坐标和 scale inverse 精确写回。
- `coord_polar()` 圆形绘图区内使用 theta/r 逆解；圆外位置拒绝并保留真实渲染位置。
- 默认离散 color/fill scale 会输出 `layer + group + panel + aesthetic + scale + guide` 关系。
- 重复颜色无法唯一映射 SVG 图元时退回整 layer 选择，不猜测具体 group。
- base R / 未赋值 ggplot 的 grid 输出明确记录为 semantic editing unsupported，但继续支持预览和导出。

Python 主路径回归测试：

```bash
C:\Users\SZC\.conda\envs\Machine-learning\python.exe tests/test_introspection.py
```

## Phase R5-B 完成结果

2026-07-12 05:09:45 +08:00 已完成：

```text
默认与显式离散 scale 统一生成稳定 group 对象
group 显式关联 layerIds、subplotIds、aesthetic、scaleId、guideId 和 legendId
layer 与 legend 反向记录 groupIds
单组改色保留 scale 顺序、标签、标题、NA 和 drop/guide 语义
重复颜色只在映射唯一时写入 SVG group id
heatmap/colorbar 显式关联 layer、全部 panel、scale、guide 和 mappableIds
GeomText/GeomLabel 显式关联 layer、panel 和 annotation
文本行身份标记为 conditional，代码增删或重排行时提示可能漂移
scale_y_log10、coord_polar 和 base R unsupported fixture
```

验证证据：`npm run lint`、18 files / 130 tests、25 个 R renderer 测试、Python/R capability matrix、默认离散 scale 浏览器语义中心和生产构建通过。

## Phase R5-C 坐标、稳定身份与扩展对象边界

2026-07-12 12:32:39 +08:00 已完成：

```text
CoordCartesian/CoordFlip：基于 coord$transform 的仿射逆解
X/Y log scale：build 坐标逆解后调用 scale trans inverse 恢复原始数据
CoordPolar：圆内 theta/r 精确逆解，圆外拒绝
稳定文本键：优先 .scifigure_id/scifigure_id/id/ID/key/label_id
稳定键随 geom_text/geom_label layer 重建保留
代码重排行后同一数据键继续命中同一 gid 和 identity
无稳定键对象继续使用行号 gid，并保持 conditional 提示
未知 ggplot geom 改为 readonly/unsupported，不再显示伪造控件
重命名多 scale aesthetic 明确报告 unsupported，不与主 scale 错误合并
```

验证证据：18 files / 130 tests、29 个 R renderer 测试、Python/R capability matrix、R 浏览器语义中心、扩展拖拽 smoke 和生产构建通过。

## 下一阶段边界

后续只按真实项目证据继续适配，不把以下内容算作当前已完成：

- `ggnewscale` 等同一 aesthetic 多 scale 扩展包当前会被识别并报告 unsupported，尚未提供独立写回适配器；
- `ggrepel` 等第三方 geom 当前按未知 geom 只读处理，尚未保留其排斥布局后进行写回；
- 任意第三方 grid grob 或 SVG 节点写回；
- 没有显式稳定数据键时，code patch 改变 text layer 行数后的自动身份迁移；
- base R artist 级编辑；
- `CoordSf`、地图投影和其他未经 fixture 证明的复杂坐标逆变换。

R 路径的目标仍是：

`ggplot object -> semantic manifest -> editLog -> 修改 ggplot/theme/scale 参数 -> rerender`

而不是：

`SVG DOM 猜测 -> 直接改 SVG -> 无法复现`

## 环境要求

本机或服务器需要安装：

- R
- `Rscript` 可执行文件在 PATH 中，或设置环境变量 `RSCRIPT_BIN`
- R 包 `jsonlite`
- 推荐安装 R 包 `svglite`，Windows/Conda 环境下比 R 自带 `svg()` 更稳定
- 如使用 ggplot2 脚本，需要自行安装 `ggplot2`
- Python 转换依赖：`cairosvg`、`Pillow` 和 Cairo 运行库

示例：

```r
install.packages(c("jsonlite", "svglite", "ggplot2"))
```

## R 执行安全边界

当前 R 路径已经补充：

```text
客户端任意 cwd / uploaded_file_paths 拒绝
项目文件目录白名单
生产环境强制 Docker renderer
R 静态风险 log-only / block-high 预检
超时终止、输出上限、CPU/内存/PID/tmpfs 限制
R 主数据库读取与联网沙箱测试
```

完整风险说明和剩余边界见 `docs/R_SECURITY_RISK_AUDIT.md`。
