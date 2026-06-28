# SciFigure 图元识别能力强化方案

> 目的：把 SciFigure 的核心能力从“能识别常见 Matplotlib 图元”升级为“稳定、可解释、可扩展的科研图对象模型”。本文档给其他 AI/开发者作为强化任务书使用。

## 1. 当前能力定位

SciFigure 的核心不是“生成图片”，而是：

```text
真实 Python/Matplotlib 脚本
  -> 运行得到 Figure / Axes / Artist Tree
  -> 内省 Matplotlib Artist 对象
  -> 给对象绑定稳定 GID
  -> 生成 manifest
  -> 前端按 manifest 选中、编辑、重放、导出
```

关键文件：

- `renderer/introspector.py`：运行脚本、遍历 artist、生成 manifest、应用 editLog。
- `renderer/semantic_scanner.py`：扫描脚本中的颜色常量、字典、内联颜色。
- `renderer/binding_engine.py`：把脚本语义颜色和渲染后的图元 GID 绑定。
- `src/schemas/manifest.ts`：前后端 manifest / editLog 协议。
- `src/components/RightSidebar.tsx`：属性编辑、字体中心、配色中心、组件中心。
- `src/components/ChartPreview.tsx`：SVG 选中、hover、高亮、文本拖动。

当前已识别对象大类：

```text
figure text       fig_text.*
axes              axes.*
grid              grid.* / grid.*.line.*
axis              axis.x.* / axis.y.*
title             title.* / title.left.* / title.right.*
axis labels       xlabel.* / ylabel.*
tick labels       xtick.* / ytick.*
spines            spine.*.* / spine_group.*
legend            legend.* / legend_title.* / legend_text.* / legend_line.* / legend_patch.*
free text         text.*.*
lines             line.*.*
collections       collection.*.*
patches           patch.*.*
semantic palettes palettes / groups / bindings
```

## 2. 当前设计中必须保持的原则

### 2.1 原脚本优先，不重画假图

不要把用户脚本翻译成前端 SVG 或固定模板。平台必须继续走真实 Matplotlib 渲染。

正确路径：

```text
原脚本 -> 执行 -> Matplotlib Artist Tree -> 内省 -> SVG + manifest
```

错误路径：

```text
原脚本 -> AI 重写成前端图表 -> 手写 SVG 预览
```

### 2.2 `iter_artists(fig)` 是 GID 映射唯一来源

`renderer/introspector.py` 中 `iter_artists(fig)` 已经被设计为唯一 gid -> artist 映射来源。

强化时必须保持：

- `introspect_figure()` 使用它。
- `apply_edit_log()` 使用它。
- 不允许前端自己猜 SVG 语义。
- 不允许在多个文件里重复定义 gid 顺序。

### 2.3 editLog 是唯一编辑事实来源

任何属性修改都必须最终进入 editLog。前端 local patch 只用于即时视觉反馈，不能成为唯一状态。

正确状态公式：

```text
最终图 = 原始脚本 + 上传数据 + codePatch + editLog 重放
```

## 3. 当前薄弱点

### 3.1 GID 仍偏“索引稳定”，不是“语义稳定”

当前 GID 大多是：

```text
line.0.3
collection.1.0
patch.0.12
xtick.0.4
```

问题：

- 脚本增加一条线，后续索引会漂移。
- 数据排序变化后，同一语义组可能换 gid。
- code_patch 后旧 editLog 可能应用到错误对象。

需要升级到：

```text
line.ax0.label.Promoted
collection.ax1.label.Cluster_A
bar.ax0.container.Treatment_24h.3
errorbar.ax0.series.N2O_rate
```

但不能完全抛弃索引。建议采用“双层标识”：

```json
{
  "id": "line.0.3",
  "stableKey": "ax0.line.label.Promoted.color.#1F78B4",
  "fingerprint": "sha256(label + type + data bounds + color + marker + length)"
}
```

### 3.2 容器级语义不足

Matplotlib 中很多科研图不是单个 artist，而是一组 artist：

- `ax.errorbar()` 返回 `ErrorbarContainer`
- `ax.bar()` 返回 `BarContainer`
- `boxplot()` 返回 dict of artists
- `violinplot()` 返回 bodies / cbars / cmins / cmaxes
- `stem()` 返回 StemContainer

当前系统更多识别 child artist：

```text
line.*
collection.*
patch.*
```

用户真正想编辑的是：

```text
误差棒整体
箱线图整体
某一组柱子
某个散点分组
某个拟合线系列
```

需要新增“container object”。

### 3.3 覆盖率报告太粗

当前 coverageReport 是：

```json
{
  "title": "full",
  "axisLabels": "full",
  "spines": "full",
  "legend": "full",
  "dataSeries": "partial",
  "annotations": "partial"
}
```

这不足以指导用户或 AI 强化。应该扩展为：

```json
{
  "summary": {
    "recognized": 42,
    "editable": 38,
    "readonly": 4,
    "unsupported": 7
  },
  "byKind": {
    "text": { "count": 12, "editableProps": ["text", "fontsize", "fontfamily", "color"] },
    "errorbar": { "count": 2, "editableProps": ["color", "linewidth", "capsize"] },
    "boxplot": { "count": 1, "editableProps": ["medianColor", "boxFacecolor", "whiskerLinewidth"] }
  },
  "unsupportedArtists": [
    { "class": "QuadMesh", "count": 1, "reason": "heatmap colorbar not implemented" }
  ]
}
```

### 3.4 颜色绑定仍偏启发式

当前 `semantic_scanner.py + binding_engine.py` 主要通过：

- 颜色常量
- 颜色字典
- 内联 hex
- label 匹配
- rendered artist color 匹配

问题：

- 同色多组时仍可能误绑。
- scatter 一个 collection 里有多个 facecolors 时，单个 gid 可能对应多个分组。
- colormap / gradient / continuous colorbar 尚未被语义化。

需要把 palette binding 拆成：

```text
discrete palette binding
continuous colormap binding
per-point color membership
legend-traced group binding
```

### 3.5 前端组件中心分类还不够科研化

用户不是按 Matplotlib class 思考，而是按科研图元素思考：

```text
标题
X轴标题
Y轴标题
X轴刻度文字
Y轴刻度文字
散点组
折线组
误差棒
拟合线
柱子
箱体
中位线
须线
图例文字
图例标记
显著性标注
统计文本
```

manifest 应该提供 `role` / `semanticRole`，前端才能显示中文分类。

## 4. 建议的 Manifest v2 扩展

在 `ManifestObject` 上新增字段：

```ts
interface ManifestObject {
  id: string;
  kind: ManifestObjectKind;
  role?: SemanticRole;
  label: string;
  parentId?: string;
  children?: string[];
  stableKey?: string;
  fingerprint?: string;
  source?: {
    artistClass: string;
    axesIndex: number;
    containerClass?: string;
    label?: string;
    zorder?: number;
  };
  editable: string[];
  currentProps: Record<string, unknown>;
  editModeByProp?: Record<string, "local_patch" | "backend_patch" | "code_patch">;
  confidence?: number;
  warnings?: string[];
}
```

新增 `SemanticRole`：

```ts
type SemanticRole =
  | "figure_title"
  | "axes_title"
  | "x_axis_label"
  | "y_axis_label"
  | "x_tick_label"
  | "y_tick_label"
  | "legend"
  | "legend_text"
  | "legend_marker"
  | "spine"
  | "grid"
  | "scatter_series"
  | "line_series"
  | "fit_line"
  | "errorbar_series"
  | "bar_series"
  | "boxplot_group"
  | "violin_group"
  | "heatmap"
  | "colorbar"
  | "annotation"
  | "stat_text";
```

新增层级关系：

```json
{
  "id": "errorbar.ax0.label.N2O",
  "kind": "container",
  "role": "errorbar_series",
  "children": [
    "line.0.3",
    "line.0.4",
    "line.0.5"
  ],
  "editable": ["color", "linewidth", "capsize", "alpha"]
}
```

## 5. 后端强化路线

### Phase A：识别基线与回归测试

先不要继续堆功能，先建立测试集。

新增目录：

```text
tests/fixtures/artist_introspection/
  lollipop.py
  grouped_bar.py
  scatter_regression.py
  errorbar.py
  boxplot.py
  violin.py
  heatmap_colorbar.py
  multi_axes_shared_y.py
  twin_axis.py
  annotations_significance.py
```

每个 fixture 输出：

```text
expected_manifest_snapshot.json
expected_roles.json
expected_edit_smoke.json
```

最低测试项：

- render 成功。
- manifest objects 数量不为 0。
- 关键 role 存在。
- 每个 role 的核心属性可读。
- 对核心属性 apply editLog 后可重放。
- SVG 中对应 id 存在。

### Phase B：容器识别

优先支持：

1. `ErrorbarContainer`
2. `BarContainer`
3. `boxplot` 返回对象
4. `violinplot`
5. `PathCollection` 中离散颜色拆分

建议新增：

```python
def iter_containers(ax, ax_idx):
    yield container_gid, kind, container, children
```

不要把 container 和 child 混在一起。manifest 中应该同时保留：

- container object：用于批量编辑。
- child object：用于精细编辑。

### Phase C：稳定 key 与 drift 对齐

新增：

```python
def build_artist_fingerprint(artist, kind, ax_idx) -> str:
    ...
```

fingerprint 参与 code_patch 后对齐：

```text
旧 editLog gid -> old stableKey/fingerprint
新 manifest stableKey/fingerprint -> 新 gid
如果高置信匹配，则迁移 editLog
否则提示 drift
```

匹配优先级：

1. exact gid
2. stableKey exact match
3. fingerprint exact match
4. label + kind + axes + color 相似
5. 低置信，不自动迁移

### Phase D：科研语义角色

在 `_bind()` 或 manifest object 创建阶段补充：

```python
role = infer_role(gid, kind, artist, ax, container)
```

示例：

```text
title.0                  -> axes_title
xlabel.0                 -> x_axis_label
xtick.0.3                -> x_tick_label
legend_text.0.1          -> legend_text
collection.0.0 + marker  -> scatter_series
line.0.2 + linestyle --  -> fit_line / reference_line
line.0.* from errorbar   -> errorbar_series child
```

### Phase E：更精细属性读写

重点补齐：

#### Errorbar

```text
color
elinewidth
linewidth
capsize
capthick
alpha
marker
markersize
```

#### Boxplot

```text
box facecolor
box edgecolor
box linewidth
median color
median linewidth
whisker color
whisker linewidth
cap color
outlier marker
outlier size
```

#### Scatter

```text
facecolor
edgecolor
size
marker
alpha
linewidth
per-group discrete color
```

#### Heatmap / Colorbar

```text
cmap
vmin/vmax
colorbar label
colorbar tick fontsize
colorbar outline linewidth
```

### Phase F：Heatmap / Colorbar 增量实现防回归约束

Heatmap / Colorbar 很有价值，但必须作为独立增量做，不能影响已有 line / bar / errorbar / boxplot / violin / text / axis 能力。

#### F.1 只新增对象，不重写旧对象

允许新增：

```text
heatmap_container
colorbar
colorbar_axis
colorbar_label
colorbar_tick_label
```

禁止：

```text
重命名已有 line.* / collection.* / patch.* / text.* GID
改变已有 container.bar.* / container.errorbar.* / container.boxplot.* / container.violinplot.* 规则
把所有 AxesImage / QuadMesh 都无条件当成 heatmap
```

#### F.2 识别规则必须窄

Heatmap 可能来自：

```text
AxesImage       ax.imshow()
QuadMesh        ax.pcolormesh() / seaborn heatmap 底层
PolyCollection  某些特殊绘图封装
```

但并不是所有 `AxesImage` 都是科研热图。普通背景图、logo、imshow 图片也可能是 `AxesImage`。

建议识别条件：

```text
1. artist 类型是 AxesImage 或 QuadMesh；
2. artist 有 mappable / cmap / norm；
3. 数据维度是二维矩阵；
4. 所在 axes 有常规 x/y 轴；
5. 如果存在与其共享 mappable 的 colorbar axes，则提高置信度；
6. 如果只是 RGB/RGBA 图片数组，默认只读或 unsupported，不自动当作 heatmap。
```

manifest 中必须输出：

```json
{
  "kind": "heatmap_container",
  "role": "heatmap",
  "confidence": 0.82,
  "warnings": []
}
```

低置信对象：

```json
{
  "kind": "image",
  "role": "raster_image",
  "editable": [],
  "warnings": ["可能是普通图片，不自动开放 heatmap 编辑"]
}
```

#### F.3 分阶段开放编辑

第一阶段只做只读识别：

```text
输出 heatmap/colorbar manifest
输出 coverageReport
前端能在组件中心看到“热图 / 颜色条”
不开放 cmap/vmin/vmax patch
```

第二阶段再开放安全 patch：

```text
cmap
vmin
vmax
alpha
colorbar label fontsize
colorbar tick fontsize
colorbar outline linewidth
```

第三阶段才考虑：

```text
colorbar 位置/大小
离散色阶
单元格边框
annotation text 批量编辑
```

#### F.4 Heatmap 与 Colorbar 必须联动

`cmap / vmin / vmax` 属于 mappable 级属性。修改 heatmap 后，如果存在 colorbar，必须同步：

```python
mappable.set_cmap(...)
mappable.set_clim(vmin, vmax)
colorbar.update_normal(mappable)
```

禁止只改 heatmap 而不刷新 colorbar，否则用户会看到图和颜色条不一致。

#### F.5 新增测试必须保护旧功能

新增 heatmap/colorbar 后，必须继续通过：

```text
bar_container
errorbar_container
boxplot_container
violinplot_container
coverageReport
```

新增 fixture：

```text
tests/fixtures/artist_introspection/heatmap_imshow_fixture.py
tests/fixtures/artist_introspection/heatmap_pcolormesh_fixture.py
tests/fixtures/artist_introspection/colorbar_fixture.py
tests/fixtures/artist_introspection/raster_image_not_heatmap_fixture.py
```

最低测试项：

```text
imshow 二维矩阵 -> heatmap_container
pcolormesh -> heatmap_container
colorbar -> colorbar / colorbar_axis
RGB/RGBA image -> raster_image 或 unsupported，不自动当 heatmap
修改 cmap/vmin/vmax 后 colorbar 同步
旧 5 个测试继续通过
```

#### F.6 前端展示约束

前端不能把新增对象直接平铺到对象列表里。

必须按 role 分类：

```text
热图系统
  热图主体
  色带 / Colorbar
  色带标题
  色带刻度文字
```

第一阶段如果后端只读，前端要显示：

```text
已识别为热图，但当前版本仅支持查看；可通过代码编辑调整 cmap/vmin/vmax。
```

这样可以避免用户误以为控件坏了。

## 6. 前端强化路线

### 6.1 组件中心替代“按 class 分类”

右侧面板应基于 `role` 展示中文分组：

```text
文字系统
  图标题
  坐标标题
  刻度文字
  图例文字
  统计标注

坐标轴系统
  X 轴范围
  Y 轴范围
  刻度方向
  边框
  网格

数据图元
  散点组
  折线组
  拟合线
  误差棒
  柱子
  箱线图

图例系统
  位置
  字体
  标记
  边框
```

### 6.2 选中反馈要基于真实 SVG id

禁止前端根据文本内容或 DOM 结构猜对象。

正确做法：

```text
manifest object id
  -> SVG getElementById(id)
  -> getBBox()
  -> overlay selection rect
```

复杂 group 选中：

```text
container object children[]
  -> union(getBBox(child))
  -> 画组合选框
```

### 6.3 批量编辑规则

`supportsBatchProp()` 不应只看 kind，应看：

```text
role
editable
editModeByProp
prop type
```

例如：

```text
选中多个 x_tick_label -> 可批量 fontsize/fontfamily/color/rotation
选中多个 scatter_series -> 可批量 facecolor/edgecolor/alpha/size
选中多个 errorbar_series -> 可批量 color/elinewidth/capsize
```

## 7. 其他 AI 强化时的明确任务清单

### P0：必须先做

1. 建立 `tests/fixtures/artist_introspection` 测试集。
2. 给 manifest object 增加 `role/source/stableKey/fingerprint/parentId/children`。
3. 新增 `ErrorbarContainer` 识别和编辑。
4. 新增 `BarContainer` 容器级识别。
5. 改造 coverageReport，列出 unsupported artists。

### P1：显著提升体验

1. boxplot / violinplot 语义识别。
2. heatmap / colorbar 识别。
3. legend marker 与数据系列强绑定。
4. scatter 离散颜色拆组。
5. code_patch 后 gid 漂移自动迁移 editLog。

### P2：长期优化

1. twin axis / secondary axis。
2. polar axis。
3. 3D axes 只读识别。
4. seaborn/pandas plotting wrapper 的语义恢复。
5. SVG visual diff + manifest diff 报告。

## 8. 验收标准

每次强化必须至少通过：

```bash
npm run lint
npm run build
python renderer/introspector.py --payload-file <fixture_payload.json>
```

功能验收：

- 用户能在画布选中目标对象。
- 右侧能显示中文语义名称。
- 修改后能进入 editLog。
- 重渲染后修改不丢失。
- 导出后最终图保留修改。
- coverageReport 能说明哪些图元没被识别。

## 9. 不要做的事

不要：

- 用 AI 把用户图重画成模板图。
- 在前端猜 SVG 语义。
- 用文本内容匹配作为唯一 gid。
- 把所有 child artist 合并后丢掉精细编辑能力。
- 为了支持一个特殊图，写死某个论文脚本的列名或标题。
- 声称“任意 Matplotlib 脚本都能 Origin 级编辑”。

正确产品表述：

> 真实 Python 科学图表，对可识别的 Matplotlib 结构提供平台级交互编辑；无法识别的部分透明降级为只读 + 代码编辑模式。

## 10. 推荐给其他 AI 的执行提示词

```text
你要强化 SciFigure 的 Matplotlib 图元识别能力。

请先阅读：
- docs/artist_introspection_upgrade_plan.md
- renderer/introspector.py
- renderer/binding_engine.py
- renderer/semantic_scanner.py
- src/schemas/manifest.ts

约束：
1. 不允许前端猜 SVG 语义。
2. 不允许把用户图重画成前端假图。
3. iter_artists(fig) 必须继续作为 gid -> artist 的唯一来源。
4. 所有编辑必须能进入 editLog 并可重放。
5. 新增能力必须配 fixture 和最小验证。

优先任务：
1. 给 ManifestObject 增加 role/source/stableKey/fingerprint/parentId/children。
2. 新增 ErrorbarContainer 和 BarContainer 容器级识别。
3. 扩展 coverageReport，列出 unsupported artists。
4. 建立 tests/fixtures/artist_introspection 测试集。

如果继续做 Heatmap/Colorbar：
1. 先阅读本文 Phase F 的防回归约束。
2. 第一阶段只读识别，不要立刻开放 patch。
3. 识别规则必须窄，RGB/RGBA 普通图片不能误判为 heatmap。
4. 不允许重命名或改变已有 line/bar/errorbar/boxplot/violin/text/axis GID。
5. 开放 cmap/vmin/vmax 时必须同步 colorbar.update_normal(mappable)。
6. 新增测试必须证明旧的 bar/errorbar/boxplot/violin 测试继续通过。

输出要求：
- 先给设计差异说明。
- 再给具体代码修改。
- 最后给验证命令和结果。
```
