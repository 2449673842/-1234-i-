# SciFigure Studio 语义能力矩阵

> 最后修改时间：2026-07-18 19:06:26 +08:00

本矩阵记录了 SciFigure Studio 对于各类科研绘图图元的内省识别、可视化编辑以及渲染一致性的支持级别。

## 1. 语义能力矩阵一览表

| 图元对象 | 源码实现 | 单元测试 | 浏览器验证 | 可编辑属性 | 导出一致性 | 测试 Fixture | 已知风险 / 注意事项 |
| :--- | :--- | :--- | :--- | :--- | :--- | :--- | :--- |
| **text** (普通文本) | 🟢 是 | 🟢 通过 | 🟢 已验证 | `text`, `fontsize`, `fontfamily`, `color`, `ha`, `va`, `rotation`, `position`, `zorder` | 🟢 高一致性 | 🟢 有 | 数学公式 `$` 语法渲染暂不可进行纯文本修改，建议通过 `code_patch` 调整。 |
| **axis** (坐标轴系统) | 🟢 是 | 🟢 通过 | 🟢 已验证 | `xlim`, `ylim`, `show_minor_ticks`, `x_tick_rotation`, `tick_direction`, `zorder` | 🟢 高一致性 | 🟢 有 | 部分复杂的 twinx / twiny 双轴共享需要特别注意坐标轴重叠。 |
| **tick** (刻度线/刻度标签) | 🟢 是 | 🟢 通过 | 🟡 未验证 | `limits`, `label`, `label_fontsize`, `label_color`, `tick_rotation`, `tick_direction`, `tick_length`, `tick_width`, `tick_color`, `tick_pad`, `show_minor_ticks` | 🟢 高一致性 | 🟢 有 | 动态添加刻度位置在 matplotlib 脚本层 and 图元 patch 层可能有少量偏移。 |
| **spine** (外框线) | 🟢 是 | 🟢 通过 | 🟡 未验证 | `visible`, `color`, `linewidth`, `zorder` | 🟢 高一致性 | 🟢 有 | 隐藏 top/right spine 后若进行局部修改，可能触发重新着色。 |
| **grid** (网格线) | 🟢 是 | 🟢 通过 | 🟢 已验证 | `visible`, `color`, `linewidth`, `linestyle`, `alpha`, `zorder` | 🟢 高一致性 | 🟢 有 | 显隐属于后端补丁，因为开启网格可能创建新图元；密度与坐标轴 tick 数目自动关联。 |
| **legend** (图例) | 🟢 是 | 🟢 通过 | 🟢 已验证 | `visible`, `fontsize`, `frameon`, `facecolor`, `edgecolor`, `linewidth`, `alpha`, `loc`, `ncol`, `markerscale`, `title`, `fontfamily`, `zorder` | 🟢 高一致性 | 🟢 有 | 组件中心已支持边框显隐；修改文字或间距会触发图例框尺寸重算。 |
| **line** (折线) | 🟢 是 | 🟢 通过 | 🟡 未验证 | `color`, `linewidth`, `linestyle`, `alpha`, `marker`, `markersize`, `zorder` | 🟢 高一致性 | 🟢 有 | 单条线中的某个点不支持单独修改颜色（需通过 scatter 替代）。 |
| **scatter** (散点/集合) | 🟢 是 | 🟢 通过 | 🟡 未验证 | `facecolor`, `edgecolor`, `alpha`, `linewidth`, `size`, `zorder` | 🟢 高一致性 | 🟢 有 | 当数据点数超大（>10,000）时，内省操作可能有几十毫秒延迟。 |
| **bar** (条形图) | 🟢 是 | 🟢 通过 | 🟡 未验证 | `color`, `facecolor`, `edgecolor`, `alpha`, `linewidth`, `zorder` | 🟢 高一致性 | 🟢 有 | 堆叠柱状图 of rect patches 支持分组改色。 |
| **errorbar** (误差棒) | 🟢 是 | 🟢 通过 | 🟡 未验证 | `color`, `linewidth`, `elinewidth`, `capsize`, `capthick`, `alpha`, `marker`, `markersize`, `zorder` | 🟢 高一致性 | 🟢 有 | 需要在脚本中通过 `ax.errorbar()` 正确产生 container，方可进行批量识别。 |
| **stem** (茎叶图) | 🟢 是 | 🟢 通过 | 🟢 已验证 | `stem_color`, `stem_linewidth`, `marker`, `marker_color`, `markersize`, `baseline_color`, `baseline_linewidth`, `baseline_visible`, `alpha` | 🟢 高一致性 | 🟢 有 | `StemContainer` 统一拥有 markerline、stemlines 和 baseline；组件中心不会重复修改其内部 line/collection children。 |
| **boxplot** (箱线图) | 🟢 是 | 🟢 通过 | 🟡 未验证 | `color`, `linewidth`, `alpha`, `box_color`, `median_color`, `zorder` | 🟢 高一致性 | 🟢 有 | 箱线图内部元素（fliers, whiskers, caps）通过 container 聚合进行批量覆盖。 |
| **violinplot** (小提琴图) | 🟢 是 | 🟢 通过 | 🟡 未验证 | `color`, `facecolor`, `edgecolor`, `linewidth`, `alpha`, `zorder` | 🟢 高一致性 | 🟢 有 | 小提琴图内部轮廓填充通过 `bodies` 分组进行批量控制。 |
| **heatmap** (热图) | 🟢 是 | 🟢 通过 | 🟢 已验证 | `cmap`, `vmin`, `vmax`, `alpha` | 🟢 高一致性 | 🟢 有 | `imshow` / `pcolormesh` 底层对象目前已实现全自动只读识别和 patch 安全应用。 |
| **colorbar** (色条) | 🟢 是 | 🟢 通过 | 🟢 已验证 | `label`, `tick_fontsize`, `left`, `bottom`, `width`, `height` | 🟢 高一致性 | 🟢 有 | 单色条保留 `subplotId`；共享色条使用 `subplotIds` 显式多归属，并按全部 owner 的联合外框对齐，不压缩为 mappable 所在单图。 |
| **annotation** (标注) | 🟢 Python / 🟡 R | 🟢 通过 | 🟢 已验证 | 文本：`text`, `fontsize`, `fontfamily`, `color`, `position`, `anchor_position`；箭头：`edgecolor`, `facecolor`, `linewidth`, `alpha` | 🟢 标准坐标高一致性 | 🟢 有 | Python 标准 Annotation 已建立 text/arrow/anchor 关系；callable/复合坐标与 R 独立 segment/curve 不猜测配对。 |
| **multi-panel** (多子图拼图) | 🟢 是 | 🟢 通过 | 🟢 已验证 | `layout` (位置，子图宽高，间距，编号) | 🟢 高一致性 | 🟢 有 | 拼图项目在组合图高级工作台中进行统一的排版布局及撤销、重做历史回放。 |

## 2. 状态说明

* **🟢 已验证 / 通过 / 是**：具备完整的 Matplotlib 底层对象类型探测能力，支持属性双向提取，已通过自动化集成测试或 headless 浏览器级的实测验证。
* **🟡 未验证 / 部分**：源码已实现且测试用例覆盖，但尚未通过 headless 浏览器级的物理点击流程进行最终视觉审查，列为“Code Path 已验证，待物理验证”。
* **🔴 未接入 / 无**：尚未在该维度覆盖或支持。

### 2.1 Python 复杂图元 Shadow 覆盖

2026-07-18 增加 `semanticCoverage` 与 `coverageReport.complexArtists`，用于区分“专用语义支持”“由普通 kind 承接”和“只有候选关系”。该字段只做事实报告，不改变现有 `kind/role/editable/propertyCapabilities`。

| 对象家族 | 当前 Shadow 状态 | 当前默认编辑行为 | 限制 |
|---|---|---|---|
| `fill_between` | `FillBetweenPolyCollection -> flattened` | 保留 collection 既有控件 | 还没有置信带专用上下边界语义 |
| `quiver` | `Quiver -> flattened` | 保留 collection 既有控件 | 未开放向量方向/尺度专用写回 |
| `stairs` | `StepPatch -> flattened` | 保留 patch 既有控件 | `ax.step` 的 `Line2D` 暂不猜测来源 |
| `wedge/pie` | `Wedge -> flattened` | 保留 patch 既有控件 | 只证明 wedge，不把任意 wedge 宣称为完整 pie 语义 |
| `contour/contourf` | yielded `ContourSet -> flattened` | 保留通用控件 | Matplotlib 版本若只暴露普通 collection，则不伪造专用来源 |
| `streamplot` | 同 axes 的 `LineCollection + FancyArrowPatch -> ambiguous` | 保留原通用控件 | 只记录候选，不宣称 dedicated |
| `hist/step` 通用 `BarContainer/Rectangle/Line2D` | 未按类名强行标记 | 继续按已验证 bar/line 基线工作 | 需要后续调用来源 provenance 才能区分 |

对象结构身份使用 `fingerprintVersion=2`。颜色、线宽、字号等可编辑样式不再改变结构 fingerprint；旧 manifest 无版本时只使用兼容 stableKey/seriesKey，不比较历史 fingerprint。

## 3. 前端语义编辑意图角色

语义编辑意图层不替代后端内省；它读取 Manifest 中的 `kind` / `role` / `subplotId` / `editable`，把用户操作安全编译为底层 patch。以下角色已进入前端协议：

| 语义角色 | 对应对象 | 当前状态 | 说明 |
| :--- | :--- | :--- | :--- |
| `title` | `title.*`, `suptitle.*` | 🟢 已接入 | 标题样式批量修改。 |
| `x_axis_label` / `y_axis_label` | `xlabel.*`, `ylabel.*` | 🟢 已接入 | 与 tick label 严格隔离，避免改轴标题误伤刻度。 |
| `x_tick_label` / `y_tick_label` | `xtick.*`, `ytick.*`, `axis_x`, `axis_y` | 🟢 已接入 | 组编辑映射到 axis-level `tick_label*`；单个 `content.text` 不扩展。 |
| `legend_container` | `legend` | 🟢 已接入 | 图例容器样式和位置。 |
| `legend_text` | `legend_text.*` | 🟢 已接入 | 图例正文文字。 |
| `legend_title` | `legend_title.*` 或 `role=legend_title` | 🟢 单元测试通过 | 与 legend 正文分离，避免标题和条目一起改。 |
| `legend_marker` | `legend_line.*`, `legend_patch.*`, `role=legend_marker` | 🟢 单元测试通过 | 用于图例符号/线段样式，避免误改 legend 文本。 |
| `colorbar` | `colorbar` | 🟢 已接入 | 色条容器。 |
| `colorbar_label` | `colorbar_label.*`, `role=colorbar_label` | 🟢 单元测试通过 | 与色条 tick label 分离。 |
| `colorbar_tick_label` | `colorbar_tick.*`, `role=colorbar_tick_label` | 🟢 单元测试通过 | 色条刻度文字样式。 |
| `subplot_axes_box` | `subplot` | 🟢 已接入 | 子图绘图区 bounds / 真实尺寸布局。 |
| `axis_frame` | `spine_group`, 兼容 `spine` | 🟢 单元测试通过 | 旧的整体框线角色，兼容具体 spine。 |
| `axis_spine` | `spine` | 🟢 单元测试通过 | 单条 top/right/bottom/left spine。 |
| `tick_line` | `tick_line.*`, `role=tick_line` | 🟡 协议预留 | 需要后端稳定输出 tick line manifest 后开放。 |
| `grid` | `grid` | 🟢 已接入 | 网格线样式。 |
| `data_line` / `data_point` / `data_patch` | `line`, `collection`, `patch`/container | 🟢 已接入 | 数据图元样式。 |
| `data_stem` | `stem_container`, `role=stem_series` | 🟢 已接入并浏览器验证 | 统一修改茎线、标记和基线，内部 children 只作为关系对象。 |
| `heatmap` | `heatmap` | 🟢 已接入 | 热图色阶和透明度。 |
| `annotation_text` | Python `text.*` Annotation、R `r.text.*` | 🟢 已接入 | 文本内容/字体/位置；位置默认禁止跨 Figure。 |
| `annotation_arrow` | `annotation_arrow.*` | 🟢 已接入 | 箭头样式独立于普通数据线和普通 patch。 |
| `component` | fallback | 🟢 已接入 | 未细分对象的安全降级角色。 |

跨 Figure 默认策略：

- 样式类 intent 可跨图 retarget。
- 内容类 intent 默认禁止跨图。
- 位置类 intent 默认禁止跨图。
- 布局类 intent 默认禁止跨图，除非显式 `crossFigure: allow`。

## 4. 大图前端性能保护

这部分不是新的图元语义角色，而是现有语义协议的 UI 承载约束。目标是在 manifest 对象很多、SVG 很大的项目里，保持选择、编辑和拖拽可用，同时不为了性能删减识别结果。

| 区域 | 当前策略 | 不变约束 | 后续增强 |
| :--- | :--- | :--- | :--- |
| SVG 预览 | `ChartPreview` 按 SVG 字符串缓存 `sanitizeSvg()` | 不删除 gid / data-fig-id，不改变事件委托 | 增加大 SVG fixture 的浏览器耗时基线 |
| 多 Figure 主画布 | 只挂载活动 Figure 的 `ChartPreview`；选择状态按 figureId 分桶；存在未确认拖拽时阻止切图并提示 | 非活动 Figure 的 manifest、editLog、revision、草稿和 SVG 数据完整保留；导航不自动确认或取消拖拽 | 增加连续切换内存基线 |
| 组合 Figure 缩略图 | memo + `content-visibility: auto` | 缩略图优化不影响源 Figure manifest | 大量导出资产时增加缩略图窗口化 |
| Manifest 调试表 | 默认渲染前 250 个 object；支持按 id、角色、标签、文本、identity 和 kind 搜索完整对象集 | `manifest.objects` 完整保留，筛选不能影响 patch / export | 增加超大对象集的滚动和内存基线 |
| 左侧图层树 | 每个父节点默认渲染前 220 个直接子节点；分支使用 `content-visibility:auto` 跳过离屏布局/绘制；搜索使用完整树；已选中节点越过窗口限制保留可见 | 完整 tree、shift 多选、显隐、锁定和 patch 仍基于全量对象 | 仅在量化阈值连续失败时升级为自定义 DOM 窗口化 |

禁止把 UI 未显示的对象视为未识别、只读或不可编辑；目标解析仍只看 renderer manifest 与 `propertyCapabilities`。

当前浏览器证据：620 个文本对象夹具下，窗口外对象可搜索和选中，清除搜索后仍保留可见；图层选择和 SVG 点击均未重复执行同一 SVG 的 sanitize；Manifest 可从 621 个对象中按 identity 精确筛选第 619 个对象。

固定性能基线：621 个 manifest 对象、67,882 bytes SVG、235 个默认图层 DOM；首个可交互画布约 1.53 秒，滚动双帧约 22 毫秒，搜索第 599 个对象约 39 毫秒。该数据是当前本机 Chromium 基线，不代表云端或所有终端的绝对性能承诺。

多 Figure 浏览器证据：3 个 Figure 复用相同 `title.0` gid 时，选择不会跨 Figure 串联；各 Figure 独立选择可在会话内恢复；切换时只清洗新的活动 SVG 一次；页面始终只挂载一个活动 Figure SVG；存在未确认位移时切图被阻止，取消后恢复导航。
