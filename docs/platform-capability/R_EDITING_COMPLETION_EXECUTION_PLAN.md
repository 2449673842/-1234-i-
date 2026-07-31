# R/ggplot2 图元编辑与渲染一致性收敛开发计划

> 状态：R-WP0-R-WP10 已合入当前集成分支并进入生产 release `ffea793-jd31`；旧路径和无版本 identity 兼容读取继续保留一个稳定发布周期
> 最后修改时间：2026-08-01 01:00:40 +08:00
> 当前部署状态：已推送并部署至新服务器 `117.72.117.195`；即时回退 release 为 `f4be690-jd31`，旧服务器未停机
> 基线入口：`docs/current/03_FUNCTIONAL_REGRESSION_BASELINE.md`
> 现状入口：`docs/R_COMPATIBILITY_PLAN.md`
> 适用范围：R/ggplot2 渲染、语义图元、对象身份、patch 写回、Draft、历史、导出、复杂坐标、网络图/路径图/SEM 与生产一致性

## 1. 文档目的

本计划用于把 R 路径从“ggplot2 主链路可用”提升为“支持边界明确、对象身份稳定、编辑可以可靠重放、常用科研对象具有专用语义、服务器与本地渲染一致”。

它独立于 Python 图元编辑专项，不把 Matplotlib artist tree 强行复制到 R，也不以直接修改 SVG DOM 作为主要实现方式。目标链路保持为：

```text
R script + uploaded data
-> ggplot object / supported R plot object
-> semantic manifest
-> StandardFigureModel
-> EditingIntent / Draft Patch Batch
-> R backend patch
-> rerender
-> history / export / snapshot restore
```

完成标准：

```text
现有 R 能力不回退
旧项目和旧 manifest 继续可编辑或明确降级
样式修改不会导致对象身份漂移
每个开放控件都有 R renderer 的真实写回能力
未应用 patch 不进入 revision、history、cache 或导出快照
预览、刷新、撤销、导出和快照恢复使用同一编辑状态
本地和生产容器使用可核验的 R、包、字体和图形设备
复杂对象按家族逐类开放，不把普通 layer 改色冒充专用语义编辑
```

## 2. 当前阶段结论

### 2.1 已有稳定基础

当前 R 路径已经完成早期 `Phase R1-R5-C / Batch 19` 约定范围：

| 能力域 | 当前状态 | 当前边界 |
|---|---|---|
| Rscript 真实执行 | 已具备 | 依赖可发现的 `Rscript`、包和字体环境 |
| SVG/PNG/PDF/TIFF 导出 | 已具备 | 必须继续验证字体、尺寸、DPI 和透明背景一致性 |
| ggplot 标题、轴标签、刻度、图例字体 | 已具备 | 任意第三方 grob 不在默认支持范围 |
| point/line/bar/errorbar layer 样式 | 已具备 | layer 修改默认作用于整层 |
| 默认与显式离散 scale 分组改色 | 已具备 | 重复颜色无法唯一映射时必须降级，不猜测 group |
| facet panel 识别 | 已具备 | 单个 facet 的物理 bounds 和独立 strip 样式仍有限 |
| heatmap、连续 scale、colorbar | 基础可用 | R colorbar 物理位置和尺寸弱于 Matplotlib |
| ggplot 文本标注选择和拖拽 | 已具备 | 只在可逆坐标和可证明身份下开放 |
| `coord_flip`、X/Y log、圆内 polar | 已具备受控写回 | 圆外 polar 和未验证复杂坐标继续拒绝 |
| 文本身份 | 已具备受控 replay | 显式键或唯一 `panel+x+y+label` 派生键可稳定重放；重复且无法唯一识别的无键文本为 unsupported；位置仍按坐标能力单独判定 |
| base R 图 | 可预览和导出 | 当前不提供 artist 级编辑 |

最近阶段证据记录包括 R renderer 31/31、Python/R capability matrix、R semantic smoke、扩展拖拽、导出和生产构建。该证据是既有基线，不代表本计划中的新增能力已经实现；每个新工作包完成后必须重新取得新鲜证据。

### 2.2 R-WP0-WP3 关闭后的剩余核心问题

R-WP1 已关闭服务端 patch 权威、结构化 acknowledgement 和失败批次零持久化；R-WP2 已关闭 layer/group/panel/scale/guide/tick/text 的结构 fingerprint v2 与旧无版本兼容；R-WP3 已固定生产候选 R/包/字体/locale/设备事实，并证明本地、直接 Docker 与 Web/API Docker 的关键语义 parity。剩余问题为：

1. facet、guide、colorbar、boxplot、ribbon、contour、segment/curve 等对象的细粒度不统一。
2. `ggrepel`、`ggnewscale`、`coord_sf`、第三方 grob 和 base R 没有专用 adapter。
3. 网络图、路径图和 SEM 尚未形成 node/edge/arrow/coefficient/label 的专用语义协议。
4. R 多 Figure、复杂项目回归、性能分段指标和用户可见能力报告仍不完整。

### 2.3 与当前 Python 专项的关系

standalone Python patch 的客户端 mode 绕过已经修复：无 `projectId/projectContext` 时也会保守进入服务端/renderer 验证；拒绝请求不会增加 revision 或写入 session、history、cache、导出锚点和快照。该前置阻断项已由 `test:patch-rejection-persistence` 证明关闭，但 R 产品工作仍须等待 Python 完整 release gate 和稳定候选提交，避免两种 renderer 同时修改共享主链路。

Python 专项修改共享协议时，R renderer、R semantic smoke 和导出回归仍是强制门禁；R 专项修改共享协议时，同样必须回归 Python，不允许以“只改 R”为理由跳过 Python 基线。

2026-07-21 的 R-WP0 冻结了 15 个合成 capability fixture 和一份无 fingerprint 版本的静态旧 identity/editLog fixture。当时证据为 R renderer 32 个正向测试通过，另有 1 个 ordinal group 漂移 `expectedFailure`；该历史失败现已由 R-WP2 关闭，但 fixture 继续作为升级前证据保留。详细清单见 `R_WP0_BASELINE_EVIDENCE.md`。

2026-07-21 的 R-WP1 完成服务端 mode 权威、R renderer 结构化 acknowledgement、失败批次零持久化、项目 Figure 预览原子更新以及项目级 R 导出/快照路由修复。当时保留的 group ordinal 漂移已在 R-WP2 关闭；WP1 历史测试数量不回写，当前状态覆盖见下一段和 `R_WP2_IDENTITY_V2_EVIDENCE.md`。

2026-07-22 的 R-WP2 已为 layer、group、panel/facet、scale、guide、tick 和 text 输出纯结构 `fingerprintVersion=2`，并为旧无版本 manifest/editLog 建立唯一候选兼容核验。layer 数据作用域包含规范数据内容摘要；guide identity 隔离标题和类型；唯一派生键文本可稳定重放，重复无键文本保持 unsupported。API 返回 renderer `resolvedGid`，但持久化 editLog 不包含该响应辅助字段。样式变化不改变 fingerprint；layer 插入、factor/facet/guide 重排可按结构键重映射；missing、结构漂移和多候选在应用前拒绝。完整 R renderer 当前为 51/51，项目刷新、导出和快照恢复由隔离 API smoke 证明。详细证据见 `R_WP2_IDENTITY_V2_EVIDENCE.md`。

2026-07-22 的 R-WP3 已固定生产候选 Docker/Web 的 R 4.5.0、ggplot2 3.5.1、关键包、字体、locale、svglite 和组合镜像依赖；本地 Rscript 使用绝对路径、`--vanilla` 与每请求隔离目录。37 个关键语义对象在本地、直接 Docker 和 Web/API Docker 路径一致；不同目录下同名数据文件保持隔离。镜像构建与服务端请求同时核对 R renderer 源码 SHA，陈旧镜像结构化拒绝；完整 Python 传递依赖使用哈希锁。详细证据见 `R_WP3_RUNTIME_PARITY_EVIDENCE.md`。

## 3. 执行原则

### 3.1 放行顺序

所有 R 能力按以下顺序推进：

```text
Baseline
-> Shadow
-> Scoped Enable
-> Default Enable
-> Legacy Retire
```

- `Baseline`：先锁定当前可用能力和真实项目结果。
- `Shadow`：生成新 identity、relation、capability 或诊断，但不改变现有控件和写回。
- `Scoped Enable`：只对已通过 fixture 的对象家族启用新能力，并保留独立回滚单位。
- `Default Enable`：完成用户流程、导出、历史、旧项目和真实项目验证后才默认开启。
- `Legacy Retire`：至少经过一个稳定发布周期后，才逐项退出旧猜测路径。

### 3.2 不变量

1. 不删除、迁移、覆盖或用 fixture 替换真实 `data/`。
2. 自动化不得访问本机 3000，不得停止 Docker、WSL 或 sub2api。
3. R 增强不得破坏 Python、项目归属、多 Figure、Draft、历史、导出或安全沙箱。
4. 当前已支持的 ggplot2 对象不能因为新 identity 或 capability 字段缺失而消失。
5. missing、ambiguous、unsupported 和 identity mismatch 不得写入成功历史。
6. 前端不得根据 SVG 距离、当前颜色或 DOM 顺序猜测高风险对象关系。
7. 任何位置写回必须证明坐标可逆；无法证明时保持 readonly/unsupported。
8. 任何涉及统计结果、路径系数或显著性的内容默认不可通过样式控件改写科学含义。
9. 下载 R、包、字体或系统依赖时使用批准的国内镜像、固定版本和校验值；生产 renderer 运行时继续禁网。
10. 生产只运行一套固定 R renderer 镜像，精确锁定 R、包、字体、locale 和图形设备；旧环境只用于升级期历史项目回归，不作为长期并行版本。

### 3.3 非目标

- 不把 Python/R renderer 合并成一个内省器。
- 不承诺任意 R 包、任意 grid grob 或任意 SVG 节点都可编辑。
- 不通过直接修改最终 SVG 代替可重放的 R 代码/对象 patch。
- 不在本计划中接入网页 AI 自动改图。
- 不自动修改模型估计值、p 值、显著性、路径系数或原始数据。
- 不为了追求 R/Python 表面对齐而展示无效控件。
- 不把 base R artist 级编辑作为第一阶段上线阻断项。

## 4. R 语义与身份设计

### 4.1 身份层级

R 对象身份按 ggplot 真实结构建立，而不是按最终 SVG 节点编号建立：

| 对象 | 首选结构身份 | 低风险兼容身份 | 禁止作为唯一身份 |
|---|---|---|---|
| Figure | Figure id + source plot slot | 单 Figure `fig_1` | 当前 SVG 哈希 |
| facet panel | facet 变量和值的规范化 tuple | panel row/col + layout signature | DOM 顺序 |
| layer | geom class + mapping signature + source layer key | layer ordinal + geom class | 当前颜色 |
| group | aesthetic + scale identity + canonical group key | label + layer relation | palette 索引 |
| scale | aesthetic + scale class + source key | 唯一同类 scale | 当前色值 |
| guide/legend/colorbar | guide type + scale relation + aesthetic | 唯一 owner 关系 | 屏幕距离 |
| text/label | 显式 `.scifigure_id`、`ID`、`key` 等稳定数据键 | layer + row 条件身份 | 文本坐标或行号单独使用 |
| SEM node/edge | 显式 node id / from-to edge key | 唯一 label 组合 | 绘制顺序 |

### 4.2 版本化结构 fingerprint

R 新 manifest 应引入明确的身份算法版本，版本命名与共享协议保持一致，但算法由 R renderer 独立实现：

```text
fingerprintVersion = 2
fingerprint = 纯结构摘要
```

结构摘要可以包含对象类型、父子关系、facet/scale/aesthetic 关系和稳定数据键，但不得包含颜色、线宽、字号、透明度、字体或其他可编辑样式。

兼容规则：

- 新 manifest 使用 v2 严格核验。
- 旧 manifest 没有版本时，不比较旧样式 fingerprint。
- 旧项目首次编辑只通过可证明的 `stableKey/seriesKey/identity relation` 核验。
- 无唯一身份时返回 `ambiguous` 或 `identity_mismatch`，不得按旧数组下标静默改对象。
- 首次成功重渲染后生成 v2 manifest；不批量改写旧数据库。

### 4.3 propertyCapabilities

R renderer 必须为每个对象和属性声明：

```text
editable / readonly / unsupported
patchMode: backend_patch | code_patch | local_patch
scope: object | group | layer | panel | figure
preview: exact | approximate | none
replay: stable | conditional | unsupported
reason / warning
```

R 的绝大多数语义编辑应使用 `backend_patch`。只有不创建对象、预览与重放均可证明精确的属性才允许 `local_patch`。前端不得通过硬编码属性表将 R backend 属性伪装为 local。

## 5. 工作包与执行顺序

### R-WP0：冻结 R 功能基线

**任务**

- 建立 R 专用 fixture 清单和真实项目只读回归矩阵。
- 固定当前标题、轴、刻度、图例、layer、group、facet、heatmap/colorbar 和文本拖拽行为。
- 记录本机实际 `Rscript` 路径、R 版本、关键包版本、字体和图形设备。
- 核对所有 R 测试使用临时端口、临时数据库和临时数据目录。
- 在修改前执行只读 `npm run data:audit`。

**最低 fixture**

```text
普通散点 + 默认离散 color
显式 scale_color_manual / scale_fill_manual
line/path + 多 group
bar/col + fill group
errorbar/linerange
facet_wrap / facet_grid
tile/raster + continuous fill + colorbar
geom_text / geom_label
coord_flip / log / polar
base R 预览导出
```

**验收**

- 现有 R renderer、semantic smoke、导出和安全测试全部通过。
- 每项已知限制都有 fixture 或明确记录，不能只靠文字说明。
- 测试未访问 3000、真实数据、Docker Desktop 控制面或线上服务。

**回滚单位**

- 仅测试、fixture、诊断和文档，不改变产品行为。

### R-WP1：patch 确认、服务端权威与零错误持久化

**前置条件**

- 共享 `/api/figure/patch` 已完成单图和项目图的服务端 mode 权威修复。

**任务**

- R patch 统一由服务端根据可信 manifest `propertyCapabilities` 决定 mode。
- 无可信能力声明时保守进入 backend renderer 验证，不信任客户端 mode。
- R renderer 返回结构化 `applied/skipped/warnings/conflict`。
- 每个 Figure 的 patch batch 在写 session、project figure、history、cache、export anchor 前完成预检和 renderer 确认。
- missing、unsupported、identity mismatch、setter failure 和 renderer error 均为未应用事实。
- 冲突批次不增加 revision，不清除 Draft，不写历史或导出快照。

**新增回归**

```text
无 projectId 单图会话伪报 local
项目 Figure 伪报 local
missing R gid
unsupported R property
identity mismatch
合法 local/backend mixed batch
renderer 部分 warning
刷新后 editLog/revision 守恒
```

**验收**

- 所有失败场景持久化变化为 0。
- 合法批次完整重放并只形成一次 revision。
- 前端显示“未应用”并保留可重试 Draft，不显示虚假成功。

**回滚单位**

- R patch acknowledgement adapter 和共享服务端 R 分支；不同时扩展图元类型。

### R-WP2：R 身份 v2 与旧项目兼容

**任务**

- 为 layer、group、panel、scale、guide、text 输出结构 identity 和 `fingerprintVersion=2`。
- 建立旧无版本 manifest 的兼容核验。
- 识别代码重排、layer 插入/删除、group 顺序变化、facet 重排和 guide 增删。
- 明确 stable、conditional、ambiguous、missing 和 identity mismatch 状态。
- identity Shadow 阶段只报告新旧解析差异，不改变默认 target。

**测试矩阵**

```text
修改颜色/字号/线宽后身份不变
在目标 layer 前插入新 layer
删除目标前一个 layer
交换两个相同 geom layer
改变 factor level 顺序
facet 数据顺序变化但 facet key 不变
legend/guide 增删和重排
文本存在稳定 key / 不存在稳定 key
旧 manifest 第一次正常编辑
```

**验收**

- 样式修改不会触发身份漂移。
- 有稳定语义键的对象可精确重放。
- 多个候选时拒绝，不按 ordinal 猜测。
- 旧项目无需批量数据库迁移即可继续使用。

**回滚单位**

- R identity v2 输出与 resolver 适配器；旧字段继续可读。

### R-WP3：R 执行、依赖与视觉一致性

**任务**

- 启动时记录并校验 `RSCRIPT_BIN`、R 版本、关键包版本和 library path。
- 统一 locale、timezone、字符编码、工作目录和临时目录。
- 固定生产镜像中的 `svglite`、`ggplot2`、`jsonlite` 及所需系统库版本。
- 建立字体 inventory，明确 Times New Roman、中文回退字体和数学文本策略。
- 保持 CSV/TSV sidecar 与 XLS/XLSX 隔离 parser，覆盖中文表头、Unicode 单位和带逗号字段。
- 区分语法错误、缺包、缺字体、数据列缺失、文件权限、超时和沙箱拒绝，生成用户可理解、AI 可读取的结构化诊断。
- 检测未设 seed 的随机绘制、当前时间、外部状态和不可重放副作用，先告警，不自动修改用户脚本。

**本地与容器矩阵**

```text
同一脚本和数据
-> 本地指定 Rscript
-> 隔离开发 renderer
-> 生产 Docker renderer
-> Web/API -> scheduler -> 生产 Docker renderer 的真实应用链路
比较：SVG 非空、对象清单、关键文字、字体、bounds、颜色和导出尺寸
```

**验收**

- 同一 fixture 在本地和生产容器的关键语义对象一致。
- 缺包/缺字体不会伪装成代码错误。
- 正常科研脚本不会因安全预检扩大而被误伤。
- 生产 renderer 运行时保持禁网、只读、低权限和资源限制。

**回滚单位**

- R runtime preflight、诊断和容器依赖清单；不改变编辑协议。

**完成证据（2026-07-22）**

- `test:r-runtime-parity` 证明本地、直接 Docker、Web/API Docker 的 37 个关键语义对象和 SVG 根几何一致，并覆盖同名文件隔离、stale image 拒绝和容器清理。
- R renderer 54/54、runtime diagnostics 6/6、runtime consistency、identity v2 compatibility、镜像合同、lint 和 diff-check 通过。
- 修复后独立复审 APPROVE，0 HIGH/MEDIUM；当前未推送、未部署。完整记录见 `R_WP3_RUNTIME_PARITY_EVIDENCE.md`。

### R-WP4：常用 ggplot2 图元家族精细化

一次只处理一个对象家族，顺序如下：

1. `GeomPoint/Jitter`：点大小、填充、边框、透明度、shape 和 group。本地候选已实现：shape 19 只开放可见 `color`，shape 21-25 开放 `facecolor/edgecolor/linewidth`，`size_scale` 保留映射大小比例，`marker` 支持 R 数字 shape，`PositionJitter` 以 `adapterClass=GeomJitter` 表达且保留 `artistClass=GeomPoint`。
2. `GeomLine/Path/Smooth`：线色、线宽、线型、透明度、marker/point relation。本地候选已实现：保留旧 `r.layer.N`，输出 `adapterFamily=line`、mapped linewidth/linetype/color 回读、`linewidthValues` 诊断和 `smoothLayer` 边界标记；`GeomSmooth` 只按线层样式开放，不把置信带填充冒充为 ribbon 专用编辑。
3. `GeomBar/Col`：fill/edge/linewidth/alpha、stack/dodge group。本地候选已实现：保留旧 `r.layer.N`，输出 `adapterFamily=bar`、mapped fill/color、渲染后 fill 列表、position class 和 bar count；离散分组继续通过既有 `r.group.fill.*` scale identity 单独改色，整层 adapter 不伪装成单个分组对象。
4. `GeomErrorbar/Linerange/Pointrange/Crossbar`：主线、端帽、点和容器关系。本地候选已实现：容器保留旧 `r.layer.N`，按 geom 声明 `interval_line/caps/point/crossbar` 组件角色；`elinewidth` 控制区间线，旧 `linewidth` editLog 兼容映射；Errorbar/Crossbar 的 `capsize` 明确为数据单位，Pointrange 才开放 marker/markersize，可填充 Pointrange 与 Crossbar 才开放 facecolor。
5. `GeomBoxplot/Violin`：box、median、whisker、staple、outlier、body 关系。本地候选已实现：Boxplot 声明 box body、median、whiskers、staples、outliers 组件角色，整体线色、箱体填充与稳定 outlier 属性分离；旧 `median_color` 仅作为兼容 alias 映射到整体轮廓并返回 warning，新 manifest/UI 不再把它冒充为独立中位线 setter。Violin 声明 body/quantile-lines 边界，琴身样式可编辑，quantile 独立属性保持只读。
6. `GeomRibbon/Area`：置信区间带、边界线、fill 和 owner series。本地候选已实现：保留旧 `r.layer.N`、`kind=patch` 和 GeomRibbon/GeomArea role，增加 `adapterFamily=ribbon/area` 与 `body/boundary_lines` 关系，只开放 `facecolor/edgecolor/linewidth/alpha`；`x/y/ymin/ymax`、堆叠、边界拆分和 `GeomSmooth(se=TRUE)` 置信带保持只读。离散 fill group 使用 `ribbon/area/band` 语义，整层 style override 只恢复可信 baseline 的 scale/guide 结构身份，不恢复旧颜色；`scaleActive=false` 的休眠 group 保留用于身份诊断但拒绝编辑。
7. `GeomStep/Histogram/Freqpoly`：bin/step 语义和连续系列身份。本地候选已实现：Step 保留 `GeomStep` role，Histogram/Freqpoly 分别保留旧 `GeomBar/GeomPath` role 和 `r.layer.N`，通过 `adapterClass=GeomHistogram/GeomFreqpoly` 区分统计层；只开放真实样式 setter，step direction、binwidth/bins、breaks/counts/density/yStat 等科学结构保持只读。离散 scale 身份恢复只接受唯一的一对一 `aesthetic + scaleId + groupKey`，重复结构键不再 first-wins 合并。
8. `GeomTile/Raster/Rect/Contour`：mappable、scale、guide 和 panel 关系。本地候选已实现：Tile/Raster/Rect 保留旧 `kind=patch`、`r.layer.N` 和 role，Contour/ContourFilled 使用 `kind=contour/contourf`；mapped fill 由 scale/mappable 关系负责，不暴露虚假整层 `facecolor`，Raster 不开放边框 setter。连续 contour 可编辑 `cmap/vmin/vmax`，`levels/x/y/z/bins/breaks` 等科学结构保持只读；layer、mappable、scale、guide、colorbar 和 panel 使用显式双向关系。
9. `GeomSegment/Curve`：线、箭头和端点语义，不自动与任意文本配对。本地候选已实现：保留旧 `r.layer.N`、line kind 和 role，分别输出 `adapterFamily=segment/curve`；颜色、线宽、线型和透明度只在未被 mapping/scale 控制时开放，端点、曲率、箭头方向和箭头类型保持只读。箭头作为父线对象拥有的显式只读 child 输出，不按距离推断文本关系；SVG 归属按 panel 内图层绘制顺序领取完整 body/arrow 结构，使多个线家族改成同色后仍保留各自 GID。

每个家族必须完成：

```text
fixture
-> renderer kind/role/relation
-> identity v2
-> propertyCapabilities
-> target resolver
-> Draft/backend replay
-> 组件中心/配色中心/属性编辑
-> 保存刷新
-> undo/redo
-> 导出和快照恢复
-> 用户可见限制
```

**验收**

- 单对象、整组、当前 panel 和当前 Figure 作用范围可解释。
- group 修改不会扩大到其他语义组。
- 比例型大小修改保留原数据相对比例；绝对覆盖必须单独标明。
- container 存在时不重复修改 children。
- 不用普通 `r.layer.N` 的整层改色冒充专用对象支持。

**回滚单位**

- 每个 geom 家族独立 adapter 和 capability flag。

**GeomPoint/Jitter 本地候选证据（2026-07-22 23:26:50 +08:00）**

- R renderer 定向 10/10 通过，覆盖 shape 21 fill/outline/stroke/alpha/absolute size、GeomJitter identity、mapped size 的 `size_scale`、absolute size 与比例缩放分离、shape 19/21 能力边界、旧 shape 19 `facecolor` 迁移、mapped shape 全部可填充、mapped 19/21 混合不可填充、同批 `marker + facecolor + edgecolor`、`color/edgecolor` latest-value alias。
- 旧兼容定向 5/5 通过，覆盖冻结旧 identity fixture、v2 layer remap、style edit 下 shadow identity 稳定、普通 layer style 和 manual scale palette。
- 前端 R Point 协议测试 3/3 通过，覆盖 strict backend resolver、fillable 子集和 non-fillable 点层过滤。
- `npm run test:r-semantic-smoke` 通过，隔离随机端口真实浏览器覆盖 Point `size_scale`、marker、保存刷新、撤销、重做、导出状态和 0 console/page error。
- `npm run lint` 与相关文件 `git diff --check` 通过。
- 当前仍未形成独立本地提交；不得把本段解释为 R-WP4 全部家族完成。

**GeomLine/Path/Smooth 本地候选证据（2026-07-23 00:21:34 +08:00）**

- R renderer Line/Path/Smooth 定向通过，覆盖旧 `layer_style_patch`、Line/Path/Smooth 三类 adapter、layer-local 与 plot-level inherited mapped linewidth/linetype/color、旧 `r.layer.0` GID 和 style edit 下 v2 identity/fingerprint 稳定。
- 同轮 Point/Jitter 回归 7/7 通过，证明新增 line adapter 未破坏 shape 21、mapped fillable shape、`color/edgecolor` alias 和 `size_scale`。
- `npm run test:r-semantic-smoke` 通过，隔离随机端口真实浏览器覆盖 line linewidth、Point `size_scale`、marker、保存刷新、撤销、重做、导出状态和 0 console/page error。
- `npm run lint` 通过。
- Errorbar、Boxplot/Violin、Ribbon/Area 等后续家族尚未完成，不得把本段解释为 R-WP4 全部完成。

**GeomBar/Col 本地候选证据（2026-07-23 01:14:18 +08:00）**

- R renderer 覆盖 GeomCol 与 StatCount GeomBar，验证 plot-level inherited fill/color mapping、facecolor/edgecolor/linewidth/alpha 重放、PositionStack/Dodge、bar count、旧 `r.layer.0` GID 和 style edit 下 v2 identity/fingerprint 稳定。
- Point adapter 同步补齐 inherited `colorMapped/fillMapped`；整层 mapped fill override 后，baseline layer-group-panel 关系恢复保证 scope、groupIds 和 subplotIds 不漂移，旧身份定向 7/7 通过。
- mapped fill 的单组颜色编辑继续由既有离散 scale 对象 `r.group.fill.*` 承担，Bar layer adapter 只表达整层样式，避免把整层 override 错当成单个分组改色。
- 隔离浏览器 R semantic 12/12：组件中心 Bar 整层 linewidth、配色中心单 fill group、保存刷新、撤销重做、导出和 0 console/page error 通过。
- `unsupportedNotes` 已同步列出 Bar/Col adapter；当前仍未推送、未部署。

**Errorbar/Linerange/Pointrange/Crossbar 本地候选证据（2026-07-23 01:14:18 +08:00）**

- R renderer 定向 2/2 通过，覆盖四类 geom 的组件角色、color/elinewidth/linestyle/alpha、Errorbar/Crossbar capsize、Pointrange marker/markersize、可填充点/Crossbar facecolor、旧 linewidth alias、mapped color 和 PositionDodge。
- 真实 built `PANEL` 直接写入 layer-subplot relation；单 panel 对象进入 subplot scope，多 panel 保留 plural subplotIds，stableKey/fingerprint 与旧 identity remap 规则不变。
- 前端 R Errorbar strict resolver 与 Point 合同合计 6/6；组件中心按数据单位给 R capsize 0.05 步进，并修复 errorbar markersize 控件曾过滤掉容器对象的问题。
- R capability matrix 连同 Point/Bar 定向 5/5 通过；隔离浏览器 R semantic 12/12 覆盖 Errorbar 批量线宽/端帽、Pointrange marker/markersize、Draft、保存刷新、撤销重做和导出状态。
- capthick 未开放：ggplot2 Errorbar 的端帽与主线没有跨版本稳定的独立线宽 setter；组件角色通过容器统一编辑，不伪造可单独选择的 grob children。

**Boxplot/Violin 本地候选证据（2026-07-23 02:30:50 +08:00）**

- R renderer 定向 6/6 通过：Boxplot 的 `color/box_color/linewidth/alpha` 与 `outlier_color/outlier_shape/outlier_size/outlier_stroke/outlier_alpha` 可稳定重放，`outlier_fill` 仅在 shape 21-25 时开放；Violin 的 body 样式可重放，旧 `color` 映射到 `edgecolor` 并告警，`draw_quantiles` 只输出 relation/只读元数据。
- `median_color` 已从 Boxplot editable、propertyCapabilities、能力矩阵和 R 组件中心移除；冻结旧 editLog 仍映射到整体 `color`，返回 `legacy_prop_alias`，不改变 stableKey、v2 fingerprint 或持久化条目原值。
- 前端 R Boxplot/Violin 合同 7/7 通过，覆盖现代 manifest、旧无 propertyCapabilities manifest、fill/outline 分离、条件化 `outlier_fill`、outlier backend patch、Violin 旧 alias 和 quantile setter 拒绝。
- Boxplot/Violin 共用离散 fill scale 时输出 `distribution` 语义和 `geomFamilies`；整层样式覆盖移除 scale 使用后，只从可信编辑前 baseline 恢复结构分组关系，不恢复旧样式值。
- 隔离浏览器 R semantic 12/12：同一 fixture 覆盖 Point、Line、Bar、Errorbar、Pointrange、Violin 和 Boxplot；组件中心真实修改 Boxplot outlier 与 Violin outline/linewidth，并通过 Draft、保存刷新、撤销、重做、配色 group、导出和 0 console/page error。
- `npm run lint` 与相关文件 `git diff --check` 通过；浏览器用例曾因选择页面首个图标 SVG 产生 11/12 假失败，改用 `[data-scifigure-canvas-svg="true"] > svg` 后稳定为 12/12。当前仍未推送、未部署，R-WP4 后续家族不得据此视为完成。
- 独立 `gpt-5.5 high` 只读审查 APPROVE、0 HIGH/MEDIUM。剩余 LOW 边界为浏览器尚未直接操作 `outlier_fill`，以及 layer-level fill override 后 palette 的既有优先级；前者已有 renderer 和前端合同覆盖，后者不作为本家族新增能力承诺。

**Ribbon/Area 本地候选证据（2026-07-23 04:45:54 +08:00）**

- R renderer 定向 3/3：Ribbon/Area 专用 adapter 的四项样式写回、mapped fill 的 `ribbon/area/band` 分组语义，以及 layer fill override 后继续使用当前样式但保持旧 group stableKey/fingerprint/identity 均通过。
- 前端 `rRibbonAreaEditingContract.test.ts` 3/3：现代 manifest 进入 data-band 组件，旧无 `propertyCapabilities` manifest 仅回退既有安全 patch 属性，`y/ymin/ymax/baseline` 等结构字段不进入 setter。
- 隔离浏览器 `test:r-semantic-smoke` 12/12：真实组件中心修改 Ribbon/Area fill 与 linewidth，配色中心同时修改 color/fill group，完成 Draft、保存刷新、撤销、重做和 SVG 导出；导出 bundle 包含两类 group edit，console/page error 为 0。
- 首轮 11/12 暴露测试假阳性：用例只检查请求和 HTTP 2xx，而服务端业务冲突同样返回 200。测试现在读取 `/api/figure/patch` 响应体，只有 `status=success` 才算应用成功，并把 warning 写入报告。
- 根因是 layer-level fill override 会让 ggplot scale 训练键从 A-F 缩短为 A-D，旧实现把该变化写入 group v2 fingerprint。最终 manifest 现在从同次原始脚本 baseline 恢复 `scaleId/scaleKey/guideId/guideKey/legendId/aesthetic/groupKey`，颜色等 currentProps 仍取编辑后值。
- baseline 恢复后的 group 同时报告 `scaleActive`；已被整层 fill override 覆盖的休眠 group 无论 palette edit 位于 override 前还是后都返回 conflict，服务端整批零持久化，不把图例与数据不一致冒充为 superseded 成功。
- 项目 PUT 保存预检同步拒绝 `scaleActive=false` 的 `r.group.*`；构造 editLog 回归返回 409/`no_setter`，并证明 session、Figure、history、cache、导出资产和快照均未变化。
- R remap 同步增加存在性与 GID 家族门禁：请求 GID 必须先存在于当前 manifest；合法 `r.group.*`、`r.layer.*`、tick/text 序号变化继续唯一 remap，伪造 missing GID 不能凭借复制 identity 跳到真实对象。`test:r-identity-v2-compatibility` 与 `test:r-patch-authority` 通过。
- 最新 Boxplot/Violin 与 Ribbon/Area renderer 定向 9/9、前端合同 10/10、隔离浏览器 12/12、R patch authority 11 场景通过；identity 回归新增现存跨家族 GID 拒绝。最终独立 `gpt-5.5 high` 代码审查 `APPROVE`、架构审查 `CLEAR`，无 HIGH/MEDIUM。当前仍未推送、未部署；后续证据见 Step/Histogram/Freqpoly 小节。

**GeomStep/Histogram/Freqpoly 本地候选证据（2026-07-23 12:07:51 +08:00）**

- R renderer 定向 9/9：覆盖 Step、Histogram、Freqpoly 的 kind/role/relation、v2 identity、专用 adapter、样式重放、旧 GID-only editLog、结构字段拒绝，以及 Ribbon/Area 与离散 group 身份回归。`GeomHistogram`/`GeomFreqpoly` 只作为 `source.adapterClass`，不改写旧 `GeomBar/GeomPath` role 或 `r.layer.N`。
- Step 的 `stepDirection`，Histogram/Freqpoly 的 `binwidth/bins/breaks/counts/density/yStat` 仅作结构诊断，不进入 editable/propertyCapabilities。前端 `rStepHistogramFreqpolyEditingContract.test.ts` 3/3，证明组件中心只生成权威 backend 样式 patch，结构字段 strict resolver 明确跳过。
- 修复离散 scale 活跃键压缩：当前 group 以 `aesthetic + scaleId + groupKey` 唯一匹配原脚本 baseline；只有当前与 baseline 都唯一且目标 ID 未被占用时才复用旧 group/palette ID。重复 groupKey fixture 证明 object/group/palette/binding/target instanceKey 不会合并；重复键对象同时标记 `identityAmbiguous=true`、`svgSelectable=false`、`editable=[]`，identity-bearing edit 明确 `ambiguous_identity`，旧 GID-only edit 明确 `unsupported_prop`。休眠 group 继续保持 `scaleActive=false` 并拒绝编辑。
- `ManifestObject.source.adapterClass` 使用共享 `KnownRLayerAdapterClass` / `RLayerAdapterClass` 类型；已知 adapter 由同一联合约束，扩展仅允许 `Geom${string}`，前端合同不再维护孤立字符串集合。
- 新增隔离 API smoke：项目 Step/Histogram/Freqpoly 三类样式在一个 batch 中原子持久化；standalone 和项目端伪 `local_patch` 均由服务端归一化为 backend，session/Figure/history/export snapshot/restore editLog 全部断言持久化 `mode=backend_patch`；step direction、bin/stat 结构 patch 和 mixed batch 均 conflict 且 revision、session、Figure、history、cache、导出锚点和快照不变。
- 同一 API fixture 完成 SVG 导出快照、导出后继续修改和快速恢复。恢复时旧 preview/manifest 先失效，刷新后由 R renderer 重建到导出时 editLog/manifest/SVG；后续修改进入 history checkpoint，导出快照内容保持不可变。
- `npm run test:r-semantic-smoke` 12/12：真实组件中心把 Step/Freqpoly 纳入 line 批量编辑、Histogram 纳入 patch 批量编辑，配色中心继续按活跃 color/fill group 修改，并完成 Draft、保存刷新、撤销重做和导出；console/page error 为 0。
- `npm run test:r-patch-authority`、`npm run test:r-identity-v2-compatibility`、`npm run lint`、`npm run build` 和 `git diff --check` 通过。identity 用例首次遇到一次 Windows R 进程 `0xC0000005` 启动异常，隔离重跑通过，未把单次解释器崩溃计为产品通过证据。
- 最终独立 `gpt-5.5 high` 复审发现旧 GID-only 重复组 patch 会在确认拒绝前进入 scale setter，造成 `conflict=true` 但返回 SVG/manifest 已变色；resolver 现于应用前拒绝 ambiguous group。直接 reproducer 验证 identity-bearing 与旧 GID-only 两条冲突路径均保持原 SVG/manifest，复审结论 `CLEAR`、0 HIGH/MEDIUM。Step scale group 同时修正为 `kind=line` / `semanticKind=line`。
- 当前仍未推送、未部署；后续证据见 Tile/Raster/Rect/Contour 小节。

**GeomTile/Raster/Rect/Contour/ContourFilled 本地候选证据（2026-07-23 15:39:23 +08:00）**

- 审查前 R renderer 全量 98/98；审查修复后 family 8 定向 6/6、capability matrix 2/2 通过。Tile/Raster/Rect 保留旧 `r.layer.N`、`kind=patch` 与既有 role；Contour/ContourFilled 分别输出 `kind=contour/contourf` 和受共享类型约束的专用 `adapterClass`。
- Tile/Rect 仅在 renderer 确有边框能力时开放 `edgecolor/linewidth`；Raster 只开放 `facecolor/alpha`。mapped fill 不生成虚假整层 fill setter，连续 contour 通过 mappable/scale 写回 `cmap/vmin/vmax`，`levels/x/y/z/bins/breaks` 仅作只读结构诊断。
- layer、mappable、scale、guide、colorbar 与 panel 建立显式关系；colorbar 关联仅处理真实 `kind=colorbar` 对象。旧 GID-only editLog 与无 fingerprint 版本旧 manifest 可继续重放，样式修改不改变 stableKey、v2 fingerprint 或 relation。
- 函数型 `breaks` 先转换为 JSON 安全的只读表达，关闭 `No method asJSON S3 class: name`。前端 family 8 合同 6/6，覆盖专用 target role、权威 propertyCapabilities、Raster 边框拒绝和结构字段 strict skip。
- 家族隔离 API smoke 证明客户端伪报 `local_patch` 会规范化为 `backend_patch`；合法样式 batch 成功，`levels/x/y/z/bins/breaks` 和 mixed batch 原子拒绝，revision、session、Figure、history、cache、导出锚点和快照均不变化；导出后继续编辑与快照恢复通过。
- `npm run test:r-semantic-smoke` 14/14：真实组件中心完成 Tile/Raster/Rect 与 Contour/ContourFilled 选择、批量样式、只读结构控件核验、Draft、保存刷新、撤销重做、导出后继续编辑和快照恢复；console/page error 为 0。`npm run lint`、`npm run build`、合同测试和 `git diff --check` 通过。
- 独立 `gpt-5.5 high` 初审发现 mapped Tile/Rect/ContourFilled 仍会开放整层 `edgecolor`，可能覆盖数据驱动 scale。renderer 现同时在 readback、editable/propertyCapabilities 和 setter 三层阻止 mapped edge override；被拒 patch 不再污染返回 manifest。新增三类 mapped-edge 回归后复审确认 `CLOSED`，最终无 HIGH/MEDIUM。
- 本节完成时 R-WP4 仍剩 GeomSegment/Curve；该历史状态已由下一节关闭。当前仍未推送、未部署。

**GeomSegment/Curve 本地候选证据（2026-07-24 00:35:27 +08:00）**

- Segment/Curve 使用专用 adapter，保留旧 `r.layer.N`、line kind、role、stableKey 和 v2 structural fingerprint。端点、`lineend/linejoin`、曲率、角度、控制点数量和 arrow 元数据仅作为只读结构；有结构化 arrow 来源时生成父线对象拥有的显式只读 child，但始终不生成猜测的 text relation。
- mapped `colour/linewidth/linetype/alpha` 继续由 scale 所有，非法 layer override 和 mixed batch 原子拒绝；项目与 standalone 请求中的客户端伪 `local_patch` 均由服务端规范化为 `backend_patch`。冲突请求不增加 revision，也不写 session、Figure、history、cache、导出锚点或快照。
- SVG identity 只在真实 panel clip group 内绑定，并与图层规划统一使用 geom 实际可绘制行。当前图层按绘制顺序领取最早的完整 body/arrow 结构；候选不足或最早序列无法组成完整结构时继续 fail-closed。该规则修复了 Step/Freqpoly/Segment/Curve 批量改成同色后 Segment/Curve 被标为 unresolved，以及可见行混合 NA 行时错误 unresolved 的回归，同时不允许后继图层偷认当前图元。
- 完整 R renderer 分三段并行复验为 `37/37 + 37/37 + 37/37 = 111/111`；NA 行与同色前继/后继的 Segment/Curve 定向回归 `3/3`。`npm run test:r-segment-curve-authority` 与 `npm run test:r-identity-v2-compatibility` 均通过。
- `npm run test:r-semantic-smoke` 14/14：真实组件中心完成 Segment/Curve 选择、line 组批量改色、Draft、backend replay、保存刷新、撤销重做、导出后继续编辑和快照恢复；最终 SVG 中 `r.layer.18` 保留 4 个 body/arrow 图元，`r.layer.19` 保留 3 个图元，console/page error 为 0。
- `npm run lint`、`npm run build` 和 `git diff --check` 通过；构建只保留既有大 chunk 和 CJS `import.meta` 警告。当前未推送、未部署；R-WP5 状态见下一节。

### R-WP5：scale、guide、facet 与布局关系

**任务**

- 默认/显式离散 color/fill scale 保持 label、limits、breaks、drop、NA 和 guide 语义。
- 连续 gradient/gradientn/viridis scale 建立 vmin/vmax/cmap 与 mappable 的显式关系。
- legend 关联 scale、layer、group、title、label 和 key glyph。
- colorbar 关联 scale、mappable、全部 owner panel 和 guide。
- facet panel 使用 facet key 而不是 panel ordinal 作为首选身份。
- `free_x/free_y/free`、strip、shared guide 和 panel spacing 分别声明能力。
- 只在可证明时开放 colorbar/legend 位置和尺寸；否则提供样式能力并说明物理布局限制。

**重点回归**

```text
相同颜色但不同 group
相同 label 出现在两个 scale
一个 guide 服务多个 layer
共享 colorbar 跨多个 panel
facet 重排
free scale facet
隐藏/恢复 guide
修改图例字号后 key 与文字不拥挤、不脱离
```

**验收**

- 选择一个 group 不串改其他 group。
- 选择一个 facet 时不会暗中修改全图级 scale/guide。
- 图例符号和文字缩放后保持同一容器布局。
- 预览与导出中 guide 顺序、标题和颜色一致。

**回滚单位**

- R scale/guide v2、facet identity v2 和 R guide layout adapter 分开回滚。

**本地候选证据（2026-07-24 03:10:00 +08:00）**

- 当前实现已为离散 color/fill scale 输出 label、limits、breaks、drop、NA、guide 类型、guide 可见性和 group/layer/facet 关系；相同颜色或同名 label 不再作为唯一身份。连续 color/fill scale 输出独立 `r.scale.color.continuous.0` / `r.scale.fill.continuous.0`，并通过 mappable、guide/colorbar 和 owner panel 关系隔离 `vmin/vmax/cmap` 写回。
- legend/guide 现在关联 scale、group、layer、title、label、key glyph 和容器样式；`markerscale`、spacing、border、字体与可见性走 R backend patch。colorbar 继续关联 scale、mappable 和 owner panel；只有有可核验布局锚点时开放位置/尺寸，否则保留样式能力并说明物理布局限制。
- facet panel 首选 `facetKey` 身份，`free_x/free_y/free`、strip 位置和 panel spacing 写入 facet layout 语义。单个 facet 的物理 `left/bottom/width/height` bounds 保持 readonly，不向 UI 或 patch capability 暴露；facet `aspect` 已从单 panel 移到 `r.facet.layout.0`，旧 `subplot.N` aspect patch 作为 legacy alias 解析到 layout 并返回 alias warning。
- targeted renderer evidence 通过：facet manifest/strip patch、legacy facet panel aspect alias、非首个 facet panel tick edit 与全局 axis theme 隔离、连续 colorbar 对齐与 scale relation 写回均覆盖。完整 R renderer 先跑通 111/111；随后 6 个 WP5 失败修复后定向 rerun 6/6，合计覆盖 117 个 renderer 用例。
- API smoke 覆盖 3 条路径并全部通过：facet physical bounds rejection 零持久化；guide reorder 后 legend text identity 经导出和 snapshot restore 保持；dual continuous color/fill isolation 同批写回后 `r.scale.color.continuous.0` 与 `r.scale.fill.continuous.0` 分别保持身份和值。
- 浏览器 `r_wp5_scale_guide_facet_smoke` 6/6：离散 scale/guide fixture、facet bounds readonly manifest、配色中心单 group 改色、legend 属性真实控件、facet 物理 bounds 控件不出现、console/page error 为 0。既有 `npm run test:r-semantic-smoke` 14/14 继续通过。
- `npm run test:r-identity-v2-compatibility` PASS；`npm run lint`、`npm run build` 和 `git diff --check` PASS。当前未推送、未部署；本段只声明 R-WP5 本地候选，不声明 R-WP6 或后续工作包完成。
- `2026-07-24 21:54:52 +08:00` 重新复验：R-WP5 renderer 定向 14/14、隔离 API 3/3、真实浏览器 6/6、R 语义黄金样例 14/14、identity v2 compatibility、共享 resolver/mapping 214 项、lint、build 与 diff-check 全部通过。浏览器首轮遇到一次 Windows R `0xC0000005` 进程启动崩溃，隔离重跑完整通过；该偶发运行时故障保留记录，不计入产品正确性证据。
- `2026-07-25 19:12:43 +08:00` 审查收敛补齐：字符型 `colourbar/colorbar` 统一识别为连续色条；隐藏/恢复同时更新 colorbar 与 owning scale；多个离散 guide 分别拥有稳定 `legend_title.N`，标题文字和 SVG 字体样式只写回所属 scale。图例条目标签对显式 scale 原位更新，避免重建 scale 改变同次 replay 的 GID/identity。新增同脚本 legend text replay 回归后，renderer 定向 6/6 与 guide 相关 4/4、隔离 API 3/3、真实浏览器 6/6、R 语义黄金样例 14/14、identity v2 compatibility、共享 resolver/mapping 214 项、lint、build 与 diff-check 全部通过；仍未推送、未部署。
- `2026-07-25 20:33:34 +08:00` 独立审查三轮收敛完成：legacy continuous absolute-index alias 仅容忍已知会变化的 fingerprint/scaleKey/guideKey，stableKey、semantic/seriesKey、aesthetic 等稳定证据仍须匹配；R 跨 Figure relation 必须至少有一个双方共享且相等的稳定字段，legacy score fallback 不能绕过冲突。完整 R renderer 124/124、共享 resolver/mapping 216/216、隔离 API 3/3、真实浏览器 6/6、R 语义黄金样例 14/14、identity v2 compatibility 与 lint 通过；最终独立复审 0 HIGH/MEDIUM。仍未推送、未部署。

### R-WP6：文本、annotation 与复杂坐标

**任务**

- 扩展 `GeomText/GeomLabel` 的字体、对齐、旋转、换行、上下标和位置能力。
- 明确 `annotate("text")`、数据驱动文本和统计层生成文本的身份差异。
- 为 `GeomSegment/GeomCurve` 的 arrow 建立独立对象，不凭距离猜测其关联文字。
- 统一 Cartesian、flip、log、polar 的 forward/inverse contract。
- 对 `coord_sf`、地图投影、非线性 transform 和第三方 coord 先输出 Shadow 诊断。
- 拖拽只写最终位置，一次确认形成一个 Draft/历史动作。

**验收**

- 拖动后对象在目标位置实时预览，不只显示选框。
- 确认、刷新、撤销、导出和恢复位置一致。
- 无法精确逆变换时不生成位置 patch。
- 字体和文本编辑不改变数据映射、统计量或 annotation anchor 语义。

**实现与验证证据（2026-07-26 13:45:59 +08:00）**

- `GeomText/GeomLabel` 明确区分 `ggplot_text_data`、`ggplot_text_annotation` 和只读 `ggplot_text_stat`；数据键、annotationId、statClass 和 layer/panel 关系进入 v2 identity。旧 pre-role-split manifest 只在 stableKey、semanticKey、dataKey 和结构 fingerprint 可证明兼容时迁移。
- 数据/annotation 文本支持文字、字体、字重、字形、颜色、hjust/vjust、旋转、lineheight、plotmath/多行文本和位置；统计层文字保持只读。冻结 `geom_label` 文本行时保留 mapped fill，文本编辑不再把分组背景退回白色。
- Cartesian、CoordFlip、x/y log 与 panel 内 CoordPolar 位置 forward/inverse 已验证；polar 越界、CoordSf 和第三方 coord 输出 shadow/readonly 诊断，不生成不可证明的位置 patch。Segment/Curve arrow 使用独立对象和显式关系，不按邻近文字猜测。
- R renderer 125 个场景以四个互斥分片完成覆盖（32、32、32、29；首分片 3 个升级前角色断言修正后定向通过）；capability matrix 2/2、`test:r-identity-v2-compatibility`、`test:r-segment-curve-authority` 和 `test:r-security-precheck` 通过。
- `test:r-semantic-smoke` 19/19：真实拖动只提交最终位置，历史只增加一次，刷新、撤销、重做、导出和快照恢复一致。通用拖动新增失败/重试场景：后端拒绝时保留待确认补丁和视觉位置、零持久化；提交中禁止重复请求；重试成功后才清空。
- 共享门禁通过：组件容器 42/42（补回 Python 箱线图中位线颜色控件，R 旧伪能力继续隐藏）、拖动扩展、patch rejection、项目历史、导出矩阵、快照恢复/API+UI、cross-Figure、用户隔离、Python semantic、`npm test` 213 文件/1720 项、lint、build 与 diff-check。当前未推送、未部署；下一工作包为 R-WP7。

**回滚单位**

- 各坐标 adapter 和 annotation relation 分开启用。

### R-WP7：网络图、路径图与 SEM 专用语义

**目标**

优先支持具有可证明 node/edge 数据结构的 ggplot/ggraph 风格图。`semPlot`、DiagrammeR 或任意 grid grob 只有在能够取得稳定模型对象和节点/边键时才进入专用 adapter；否则继续预览/导出或只读。

**语义对象**

```text
sem.node
sem.edge / sem.path
sem.arrow
sem.coefficient_label
sem.node_label
sem.group / cluster
sem.legend
sem.fit_annotation
```

**允许的编辑**

- node：fill、edge、linewidth、shape、size、字体和布局位置。
- edge/path：颜色、线宽、线型、透明度和箭头样式。
- label：字体、字号、颜色、位置和避免拥挤的布局参数。
- group/legend：样式和布局。

**默认禁止或需二次确认**

- 修改路径系数、p 值、置信区间、拟合指标和显著性。
- 把一条路径重新连接到其他节点。
- 删除代表真实模型关系的 edge。
- 通过拖拽改变模型结构而不只是视觉布局。

**身份要求**

- node 必须有稳定 node id。
- edge 必须由 source id + target id + edge type 唯一确定。
- 系数文字必须显式关联 edge id。
- 多重边必须增加稳定 edge key，不能只靠 source/target。

**验收**

- 选择 node、edge、arrow、label 时不会互相串改。
- 调整布局不修改模型数据和系数。
- 导出和快照恢复保持对象关系。
- 缺少稳定键的图明确提示部分支持，不猜测。

**2026-07-26 本地候选证据**

- R renderer 接受 `.scifigure_semantic_gid` / `scifigure-sem-v1` 显式声明，输出 `diagram_node/edge/arrow/node_label/coefficient_label/fit_annotation/group` 七类 role，并携带 `diagramId/diagramType/diagramObjectId/nodeId/edgeId/sourceNodeId/targetNodeId` 稳定关系；未标记 lookalike 保持通用 ggplot 对象。
- 专用对象只开放 manifest 可证明的视觉能力。路径系数、p 值、拟合指标、显著性、节点/边身份和拓扑字段不进入 `editable/propertyCapabilities`；任一非法项与合法样式组成 mixed batch 时，renderer 在应用前整批拒绝。
- GID 纳入 diagram type、diagram id、完整 semantic role 和 object id；所有字段内容均使用 Base64URL，ASCII token 使用 `a_`、非 ASCII token 使用 `b_`，类型命名空间和字段边界均无歧义。manifest 构建期拒绝重复完整 diagram identity 生成的 GID。相同 marker 的多行按原顺序保留为一个语义图层，多顶点 `GeomPath` 不拆断。
- 文本层重建保留 diagram metadata 和结构身份。`clip="off"` 不产生 panel clip group 时，diagram 场景先从可证明的 panel 边框建立受限几何范围，普通已建模图层按绘制顺序领取通用 owner，显式对象再获得 diagram GID；无法证明 panel 范围时要求候选精确唯一并 fail-closed。
- renderer 专项 10/10、R capability matrix、4 个旧 fingerprint/动态批次关键回归通过；新增 ASCII `bw6k` 与 Unicode `é` 的跨命名空间碰撞、含 `.` 字段边界碰撞，以及重复完整 diagram identity 构建期拒绝回归。隔离 API 证明合法样式 revision 1→2 并可刷新重放；非法 mixed batch 对 project/session/history/cache/export anchor/snapshot 零持久化。隔离 Chromium 证明 node、segment edge、多顶点 path edge、arrow、node label、group 可从 live SVG 选择且绑定到正确 tag/样式，专用组件组无重复，节点配色进入真实 SVG，科学字段不暴露。
- 当前仅支持显式关系声明的 ggplot2 图层；未承诺自动识别任意 `ggraph`、`semPlot`、DiagrammeR 或 grid grob。未推送、未部署；下一工作包为 R-WP8。

**回滚单位**

- ggraph adapter、semPlot adapter 和通用 grid adapter 独立，不整线启用。

### R-WP8：扩展包和 base R 能力边界

**优先级**

1. `ggrepel`：先保留其排斥布局结果和稳定数据键，再考虑样式/位置写回。
2. `ggnewscale`：为同一 aesthetic 的多个 scale 建立独立 scale/guide identity。
3. `coord_sf`：先在 Shadow fixture 中证明对象身份和关系稳定，再受控开放样式与对象选择；位置 patch 在没有投影逆变换证据前保持 unsupported。
4. 常见 `ggraph`/网络图扩展：与 R-WP7 共用 node/edge 协议。
5. base R：继续预览/导出优先，只有形成可重放 adapter 后才开放编辑。

**禁止策略**

- 不把未知 geom 自动当普通 point/line/patch 并开放全部控件。
- 不直接保存浏览器修改后的 SVG 作为唯一历史事实。
- 不通过 AI 猜测将任意 base R 图自动迁移为 ggplot2 后覆盖原脚本。

**验收**

- 每个扩展包有版本固定、最小 fixture、unsupported fixture 和导出验证。
- 包未安装时诊断明确，不能导致整个工作区空白或历史损坏。
- adapter 关闭后回到原有预览/导出或只读路径。

**2026-07-26 本地候选证据**

- 固定 renderer 镜像当前未安装 `ggrepel`、`ggnewscale`、`sf`、`ggraph`、`igraph`、`tidygraph`、`semPlot` 或 `DiagrammeR`。R-WP8 因此完成 Shadow/readonly 边界，不把缺少版本固定和专用 replay adapter 的对象虚报为可编辑。
- runtime inventory 使用 `find.package()` 和 `packageVersion()` 只读报告上述包的安装状态，不加载命名空间。缺包脚本返回结构化 `missing_package` 诊断，包含包名且不泄露本地路径。
- `GeomTextRepel/GeomLabelRepel` 和原生 `GeomNode*/GeomEdge*` 在可渲染环境中保留预览/导出结果，但 manifest 明确输出 `extensionPackage`、`extensionSupport=shadow_unsupported`、空 `editable/propertyCapabilities`。未带 `scifigure-sem-v1` marker 的 ggraph lookalike 不升级为 diagram 语义。
- `ggnewscale` 或重命名 aesthetic 进入 coverage report 的独立 unsupported 条目，不与当前 color/fill scale 合并。`CoordSf` 普通已证明样式保持既有能力，但位置 patch 在无投影逆变换证据时 readonly；合法颜色与非法位置组成 mixed batch 时 setter 前整批拒绝。
- base R/grid 输出继续支持预览和导出，manifest `objects=[]`、`backendPatch=false`。对象 patch、CoordSf mixed batch 和缺包失败均不增加 revision，不写 session、project Figure、history 或 render cache。
- 新增 4 个合成 Shadow fixture、7 个 renderer 边界测试和隔离 API smoke。R-WP8 7/7、Python/R capability matrix、R-WP7 10/10、旧 R 身份 4/4、identity v2 API、R-WP7 API/Chromium、R security precheck、renderer image contract、完整 R semantic Chromium、lint 和 diff-check 通过。当前未推送、未部署；下一工作包为 R-WP9。

### R-WP9：完整用户链路、性能与可观测性

**新增完整 E2E**

```text
创建 R 项目
-> 上传脚本与多文件数据
-> 真实 R 渲染
-> 选择 layer/group/panel/guide/text
-> 修改只进入 Draft
-> 整批应用
-> revision 增加一次
-> 刷新保持
-> undo/redo
-> SVG/PNG/PDF/TIFF 导出
-> 导出后继续编辑
-> 恢复导出时快照
-> 恢复前状态成为检查点
```

**性能分段**

```text
queue
R process/container startup
package load
script execution
ggplot_build/gtable
semantic introspection
SVG generation
sanitize/parse
persist/export conversion
```

**优化顺序**

- 缓存只允许命中已由当前可信 renderer 确认的语义 key。
- 优先复用只读数据 staging 和已验证包层，不复用不可信 R 解释器状态。
- 大 SVG 使用单次 sanitize、非活动 Figure 延迟解析和图层窗口化。
- 不通过取消沙箱、减少对象清单或忽略 warning 换取速度。

**可观测性**

- 错误中心记录语言、阶段、R/包版本、对象 gid/identity、patch mode、warning 和 requestId。
- 面向用户的信息说明缺包、脚本、数据或暂不支持，不暴露服务器路径、密钥或安全规则细节。
- 面向管理员/AI 的诊断提供脱敏调用链和可重复 fixture 信息。

**验收**

- 新 R E2E 连续通过且使用隔离环境。
- 冷/热渲染指标分别记录，不用单次平均值宣传性能。
- 超时、错误和取消后无残留 renderer 进程或受管容器。

**2026-07-26 本地候选证据**

- 复用既有 `r_semantic_centers_smoke.mjs` 作为浏览器黄金链路，不重复维护第二套巨型 UI 流程；新增隔离 API workflow 真实创建 R 项目、multipart 上传两个 CSV，并由脚本通过精确 `uploaded_file_paths[[filename]]` 读取。合法 backend patch 只增加一次 revision，刷新、四格式导出、导出后编辑和快照恢复保持一致。
- R renderer 新增真实分段计时：`scriptEvalMs`、`semanticPreflightMs`、`editResolutionMs`、`editApplyMs`、`ggplotRenderMs`、`deviceOpenMs`、`deviceCloseMs`；保留旧 `scriptExecutionMs/svgSerializeMs/manifestBuildMs/svgPostprocessMs/totalMs`，不伪造无法独立测量的 `packageLoadMs`。
- render cache key 升级为 schema v2，并纳入服务端可信的 renderer source、实际 Docker image ID/RepoDigests/labels、runtime 和 package/Dockerfile contract；客户端字段不参与 authority。renderer source、镜像或运行合同变化会产生新 key，旧缓存不能跨合同误命中。
- `/api/figure/export` 与项目导出返回 `exportRenderMs/exportConvertMs/exportPersistMs/totalMs`。成功 SVG 在写 session、project preview、render cache、导出资产或快照前执行 UTF-8 字节预算；超限返回 `SVG_PERSISTENCE_BUDGET_EXCEEDED` 和 `persisted=false`。
- 项目导出在任何资产写入前生成并预算检查全部主图/子图 SVG。隔离持久化测试分别证明超大直接渲染、超大 patch 和带 `includeSubplots` 的超大项目导出不会改变 session、revision、editLog、history、preview、render cache、export asset/snapshot 或导出文件。R timeout 清理测试证明请求创建的 Rscript job、临时目录和受管容器无残留，且不写任何渲染状态。
- `test:r-wp9-workflow`、`test:r-wp9-performance-persistence`、`test:r-wp9-timeout-cleanup`、`test:render-performance`、`test:cache-smoke`、R timing 3/3、lint、build、diff-check 和 data audit 通过。数据审计为 25 用户、128 项目、286 文件、112 导出资产、0 issue。当前未推送、未部署；下一工作包为 R-WP10。

### R-WP10：默认启用、发布与旧路径退役

默认启用条件：

- 对应对象家族的 renderer、resolver、浏览器、历史、导出和恢复矩阵全部通过。
- Shadow 连续稳定，无 silent retarget、跨 panel 串改或错误持久化。
- 至少一个本地真实 R 项目和一个生产容器项目人工视觉回归通过。
- Python 全功能基线、R 安全预检、用户隔离和 renderer 沙箱通过。
- 修改前后 `data:audit` 均为 0 个错误。
- 每项能力有独立回滚单位和用户可见限制。

发布顺序：

```text
固定候选提交
-> 隔离构建
-> 开发服务器单用户验证
-> 小范围账号验证
-> 监控错误率/渲染时间/身份冲突
-> 默认启用
```

**2026-07-26 本地候选证据**

- 默认 V2 resolver 域开启、legacy adapter 保留、弱跨 Figure score mapper 默认关闭；`test:wp10-default-enable` 17 个文件、248 项通过。
- `test:r-identity-v2-compatibility` 证明旧 identity-only editLog、旧文本角色、合法唯一 remap、导出后继续编辑和快照恢复仍可工作；缺失 GID、跨 family、身份漂移和歧义对象继续 fail-closed 且零持久化。
- R-WP9 三条用户链路重新通过：双 CSV 精确路径与四格式导出、超大 SVG 直接渲染/patch/项目导出零持久化、timeout 后 Rscript/临时目录/本轮容器清理。
- 以独立 `scifigure-renderer:rwp10-candidate` 镜像运行 renderer sandbox；镜像源码 SHA、固定 Python/R/package/font/locale 合同和宿主隔离通过。测试超时仅从 5 秒调整到 15 秒以容纳 Windows Docker 冷启动，产品默认超时未改变；临时 SQLite 清理增加受限路径校验和 EBUSY/EPERM/ENOTEMPTY 重试。
- `test:r-security-precheck`、`test:user-isolation`、`test:render-performance`、`test:cache-smoke`、lint、build、diff-check 和 data audit 通过。审计仍为 25 用户、128 项目、286 文件、112 导出资产、0 issue。
- 共享 server/export/cache 路由的最终 Python 回归按风险串行验证：`test:cross-figure-smoke` 18/18、`test:patch-rejection-persistence`、`test:python-semantic-workflow` 和 `test:export-matrix-smoke` 全部通过。浏览器门禁并行运行时曾因 Vite HMR 端口竞争记录一次 404 console error；串行重跑同一用例为 0 console/page error，因此后续浏览器发布门禁保持串行。
- 独立 `gpt-5.5 high` 审查结论为 `APPROVE/CLEAR`，无 HIGH/MEDIUM；确认 15 秒仅是测试隔离阈值，临时目录清理具有受限路径和有界重试。
- 本地候选不等于生产发布：未推送、未部署，尚未完成生产不可变镜像/构建、线上小范围账号和生产容器人工视觉回归。旧 ordinal、无版本 identity 和 legacy adapter 因此继续保留，不能在本轮退役。

**2026-07-29 R/ggplot2 雷达图专项补充证据**

- 当前稳定支持范围是严格单 panel、非 facet、`coord_polar(theta="x")`、恰好一组 polygon 和一组 line/path，且维度标签、闭合坐标、离散 color/fill scale 与系列可以唯一对应的手写 ggplot2 雷达。普通 polar 柱图不会获得雷达语义；`ggradar`、`fmsb`、facet radar、任意 grid grob 和歧义 scale 继续 fail-closed，不能写成已支持。
- renderer 为维度标签、系列轮廓、填充区域和图例条目输出 `radarId/radarSemanticRole/radarSeriesId/radarDimensionIndex`。维度标签保留文字编辑并使用 display-space `radar_label_offset`；系列线和填充分别由 `r.group.color.*` 与 `r.group.fill.*` 权威对象写回，不改变维度、数值或闭合几何。
- R scale group 带 `legendId` 时，组件中心必须优先按雷达 `series/fill` 映射为 `data_line/data_patch`，不能误归为 `legend_marker`。真实浏览器已证明 Control 线和 Treatment 填充各自产生一个显式对象 patch，未选线和填充不变，Draft、backend replay、刷新持久化、图例文字、维度文字和拖动均通过。
- 旧 R 雷达填充允许从旧 `kind=line / r:line:*` 窄迁移到当前 `kind=patch / r:patch:*`。v2 记录只有 radar series、scale、group、aesthetic、semanticKey、seriesKey 和旧 fingerprint 全部一致时放行；`fingerprint/fingerprintVersion` 均不存在的更早记录，只在旧 stableKey、semanticKey、seriesKey 和 `aesthetic/groupKey/scaleKey` 完整一致且不携带 radar 关系字段时放行。只缺一个版本字段、缺关键关系、伪造 radar 字段或 mixed batch 在 renderer 前/后均拒绝，revision、session、history、cache、导出锚点和快照不写入。
- 同轮修复 Python 雷达图例 replay index 的关系不对称：临时 GID index 现在为 legend container 重建 `legendTitleId/legendTextIds/legendMarkerIds`，使完整 v2 identity 的正常位置编辑不再被误判，同时保留伪造 relation 的严格拒绝。
- 新鲜门禁：`test:radar-chart-python` 16/16、`test:r-radar-renderer` 7/7、`test:radar-chart-api` PASS、`test:r-radar-api` PASS、`test:radar-chart-ui` 16/16、RightSidebar/ChartPreview 4 files 52 tests、lint、build 和 diff-check PASS。新增 renderer/API 回归证明无版本旧 fill 可原样持久化并在刷新后重放，同时缺关系、错误 aesthetic/scale、伪造 radar 字段、不完整 v2 和 mixed batch 均 fail-closed；隔离项目进一步证明该旧 editLog 可导出 SVG/快照、恢复到导出状态并重新渲染，篡改 scaleKey 的快照恢复返回 409 且项目/session 零变化。浏览器使用随机 localhost 端口与临时数据库/数据目录，未访问 3000、线上或真实 `data/`；未推送、未部署。

**2026-07-29 R 五个编辑中心真实浏览器补充证据**

- `npm run test:r-semantic-smoke`：19/19 PASS。真实页面覆盖字体中心、组件中心和配色中心，且在同一隔离流程中验证 Draft 自动暂存、立即应用、backend patch、保存刷新、撤销/重做、文本拖拽、SVG 导出和导出快照恢复。
- `npm run test:r-property-layout-centers`：7/7 PASS。真实页面覆盖属性中心的 X 轴刻度间距/宽度/颜色、网格显隐，以及布局中心单图 `aspect`、保存刷新和 facet 共享布局 `aspect`；facet 的物理 `left/bottom/width/height` 控件保持只读。
- 两份报告均使用随机 `127.0.0.1` 端口和临时数据/数据库，`consoleErrors=0`、`pageErrors=0`、`failedRequests=0`。本轮未访问 3000/3100、线上服务或真实用户数据，未提交、推送或部署。
- 属性/布局 smoke 首轮点击隐藏 checkbox 曾被 switch 装饰层拦截；已改为对同一真实 checkbox 使用 `force` 操作并重跑通过。该问题属于测试 harness，不是产品网格/Draft 功能失败，记录在 `docs/ERROR_LOG.md`。

**2026-08-01 生产发布收尾证据**

- R-WP0-R-WP10 已随 `ffea793-jd31` 进入生产 release；默认 V2 resolver、旧 R identity/editLog 兼容、legacy adapter、安全预检、renderer sandbox、用户隔离、性能和缓存门禁均以同一候选提交部署。
- 新服务器当前 release 为 `/opt/scifigure/releases/ffea793-jd31`，上一可回退 release 为 `/opt/scifigure/releases/f4be690-jd31`；`scifigure`/`nginx` active、`NRestarts=0`、readiness 为 `ready/acceptingNewJobs=true`。
- 线上 R smoke 返回 `200`，生成 30 个 manifest 对象且 runtime warning 为 0；Python 共享路由、认证 refresh、导出资产认证和真实 Chromium 历史导出页面也通过，证明共享发布链路未回退。
- 部署后数据审计为 6 用户、52 项目、251 项目文件、75 导出资产、0 issue；本地 `3000` 未访问或修改，旧服务器保持运行。生产通过 HTTP/IP 访问，真实域名 TLS 尚未配置。

本文件中带明确历史日期的“未推送/未部署”条目保留当时阶段事实，不代表当前部署状态。

旧 ordinal、颜色匹配或不带版本 identity 的兼容读取至少保留一个稳定发布周期。新 adapter 与旧路径退役不能在同一批次完成。

## 6. 测试与验收门禁

### Gate A：任何 R 代码或文档状态修改

```text
npm run lint
npm test
git diff --check
```

纯计划文档修改至少执行 Markdown 链接/路径核验和 `git diff --check`；不得把未实现工作标成完成。

### Gate B：R renderer、identity 或 capability 修改

```text
C:\Users\SZC\.conda\envs\Machine-learning\python.exe tests/test_r_renderer.py
npm run test:capability-matrix
npm run test:r-semantic-smoke
npm run test:r-security-precheck
npm run test:semantic-smoke
npm run test:component-container-smoke
npm run test:drag-extended-smoke
npm run build
```

共享 `manifest/StandardFigureModel/EditingIntent/target resolver` 发生变化时追加 Python introspection、Python semantic workflow、cross-Figure 和导出矩阵。

### Gate C：patch、历史、导出或恢复修改

```text
npm run test:patch-rejection-persistence
npm run test:project-history-persistence
npm run test:export-matrix-smoke
npm run test:export-snapshot-restore
npm run test:export-snapshot-restore-ui
npm run test:cross-figure-smoke
npm run test:user-isolation
```

计划新增但尚不存在的专项脚本：

```text
test:r-semantic-workflow
test:r-patch-rejection-persistence
test:r-real-project-matrix
test:r-sem-network-smoke
test:r-runtime-parity
```

这些名称只有在对应测试文件、隔离 wrapper 和 package script 实际落地后才能写入当前功能基线。

任何 Gate A-C 中没有使用 `scripts/testing/run_with_isolated_server.mjs` 的命令，执行前必须先审计或补上等价隔离保护。命令必须使用临时数据库、临时数据目录和临时端口，不得访问 3000、真实 `data/`，不得控制 Docker Desktop、WSL 或 sub2api；无法证明时不得直接运行。

### Gate D：候选发布

- 运行全部适用 Gate A-C。
- 运行 Python/R renderer 沙箱、用户隔离、安全基线和仓库边界检查。
- 本地与生产容器各完成至少一个普通 ggplot、一个 facet、一个连续色标、一个 annotation 和一个复杂对象项目。
- 人工核对字体、图例、色条、坐标、导出尺寸和恢复状态。
- 修改前后各执行一次只读 `npm run data:audit`。
- 确认临时服务退出，3000、Docker Desktop、WSL 和 sub2api 未被停止或修改。

## 7. 对现有平台的影响与联动

| 影响层 | 可能修改 | 必须保护 |
|---|---|---|
| `renderer/r_renderer.R` | identity、relation、capability、patch acknowledgement、对象 adapter | 现有 R 标题/轴/layer/group/facet/heatmap/text 能力 |
| `server.ts` | mode 权威、事务、runtime preflight、诊断 | Python patch、revision、cache、history、导出和用户隔离 |
| manifest/schema | R v2 identity 和 capability 字段 | 旧 manifest、Python manifest 和 wire format 可读 |
| StandardFigureModel | 归一化 R 对象关系 | Python 对象数量、类型和现有选择行为 |
| EditingIntent/target resolver | R 作用域和能力交集 | 单对象不扩散、组编辑不漏项、歧义拒绝 |
| 五个编辑中心 | R 专用控件投影和限制说明 | Draft 自动暂存、中心切换不丢草稿、当前子图自动跟随 |
| 历史/导出/快照 | R 重放和恢复 preflight | 预览与导出一致、旧资产可下载、恢复前检查点 |
| 安全/部署 | R 包和字体镜像、Docker runtime | 禁网、只读、低权限、资源限制和路径边界 |

任何共享文件修改都必须先读取并保留当前工作区中的未提交改动；禁止用旧工作树整文件覆盖当前版本。

## 8. 代理与文件所有权建议

使用最多 6 个独立 5.5 high 代理时，按以下边界分工：

### Agent A：基线与 fixture

- 只负责 R fixture、隔离测试入口和现状报告。
- 不修改 renderer、server 或前端产品代码。

### Agent B：R renderer identity

- 负责 `r_renderer.R` 的 identity/relation/capability Shadow 输出。
- 不同时修改共享 server 和前端。

### Agent C：patch 事务

- 负责 R acknowledgement、server 权威和拒绝持久化测试。
- 与 identity 代理按批次串行接触共享文件。

### Agent D：前端语义中心

- 在 renderer contract 固定后接入 R resolver 和控件投影。
- 不自行扫描 SVG 或发明关系。

### Agent E：科研对象与 SEM

- 一次只拥有一个 geom/SEM adapter 及其 fixture。
- 不修改全局 identity 或 patch 事务。

### Agent F：独立 verifier/code reviewer

- 不参与实现。
- 检查旧项目兼容、Python 回归、测试真实性、安全边界和文档状态。
- 对 silent wrong edit、数据污染、跨 panel 串改或本地/容器不一致拥有阻断权。

## 9. 优先级与首批执行批次

### P0：正确性阻断

```text
共享 standalone patch mode 权威缺口
R patch 未应用零持久化
R identity v2 和旧 manifest 兼容
本地/容器 R runtime 与包/字体诊断
完整 R 用户链路 E2E
```

### P1：常用科研图精细化

```text
point/line/bar/errorbar
boxplot/violin/ribbon
scale/guide/legend/colorbar
facet 和 annotation
复杂坐标的明确能力边界
```

### P2：专业对象

```text
网络图、路径图和 SEM
ggrepel
ggnewscale
coord_sf / 地图投影
复杂 contour 和第三方 geom
```

### P3：长期边界

```text
base R artist 级编辑
任意第三方 grob
无法获得稳定模型对象的专有绘图库
```

首批建议批次：

```text
R-Batch 0A：冻结现有 R 基线和 runtime inventory
R-Batch 0B：新增 R 完整用户链路与拒绝持久化失败测试
R-Batch 0C：R identity v2 Shadow 和 legacy manifest 兼容
R-Batch 0D：服务端 mode 权威与 R acknowledgement
R-Batch 0E：本地/容器 parity fixture 和结构化诊断
```

只有 Batch 0 全部通过，才进入常用 geom 家族的 Scoped Enable。

## 10. 预演失败场景

### 场景一：改过颜色后 R 对象显示未绑定

原因：身份包含样式或只依赖 palette index。

防护：纯结构 fingerprint v2、group/scale stable key、旧 manifest 兼容和样式修改身份回归。

### 场景二：选择一个分组却改了整层

原因：group 无唯一 relation，前端回退到 `r.layer.N`。

防护：group-layer-scale-guide 显式关系；歧义时拒绝，不静默扩大范围。

### 场景三：本地能渲染，服务器缺包或字体导致结果不同

原因：R、包、locale、字体或图形设备不一致。

防护：runtime inventory、固定容器依赖、字体核验、本地/容器 parity fixture 和结构化错误。

### 场景四：facet 控件看似可用，实际修改全部 panel

原因：panel 级属性与 plot 级 theme/scale 混淆。

防护：能力声明包含真实 scope；plot 级属性不伪装 panel 级能力。

### 场景五：拖动 annotation 后位置错误

原因：复杂 coord 不可逆或使用了错误数据范围。

防护：forward/inverse round-trip、圆外/投影坐标拒绝和刷新/导出位置验证。

### 场景六：SEM 样式编辑改变科学结果

原因：显示文本与模型字段未分层。

防护：样式、布局和科学数据分离；系数/p 值默认只读；修改模型语义需要独立明确流程。

### 场景七：新 R 功能修好但 Python 回退

原因：共享 schema、resolver、server 或 history 修改未跑 Python 门禁。

防护：共享协议双 renderer gate、不可回退基线和独立 verifier。

### 场景八：为了兼容更多 R 代码削弱安全边界

原因：把 Docker、路径或风险预检误认为编译障碍。

防护：正常脚本 fixture 与恶意脚本同时验证；不以禁网、只读、低权限和资源限制换取兼容性。

## 11. 停止条件

出现以下任一情况立即停止当前批次：

- 测试访问真实 `data/`、3000 或线上环境。
- 修改要求停止 Docker Desktop、WSL 或 sub2api。
- 旧 R 项目、Figure、history、导出资产或已支持控件消失。
- identity 无法唯一证明却发生自动 remap。
- renderer warning 或 rejected patch 被写成成功历史。
- 单 group 修改扩大到 layer、panel 或 Figure 且没有明确用户授权。
- R 共享协议修改导致 Python 基线失败。
- 本地和容器关键语义结果不一致且原因未解释。
- 新 adapter 依赖削弱 renderer 沙箱或读取宿主敏感目录。
- 代理覆盖其他未提交修改或超出文件所有权。

## 12. 完成定义

本计划完成不等于“任何 R 图都能像 Matplotlib 一样逐节点编辑”。完成含义是：

```text
当前支持的 ggplot2 能力有完整、可重复的用户链路证据
R 对象身份不随正常样式编辑漂移
旧项目无强制迁移且不会误改新对象
错误或不支持的 patch 不进入持久化状态
常用科研图元具有可解释的专用语义和作用范围
SEM/路径图的视觉编辑与科学模型数据严格分离
本地与生产容器的 R、包、字体和导出结果可核验
不支持的扩展包、复杂坐标和 base R 对用户明确可见
任何 R 增强都未破坏 Python、用户数据、安全或既有平台功能
```
