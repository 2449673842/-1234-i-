# R/ggplot2 图元编辑与渲染一致性收敛开发计划

> 状态：R-WP0 本地候选完成；R-WP1 尚未开始
> 最后修改时间：2026-07-21 22:06:41 +08:00
> 当前部署状态：R-WP0 仅新增隔离测试、合成 fixture、旧 identity 基线和证据文档；未推送、未部署
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
| 稳定数据键文本身份 | 已具备 | 无稳定键时仍是 conditional 身份 |
| base R 图 | 可预览和导出 | 当前不提供 artist 级编辑 |

最近阶段证据记录包括 R renderer 31/31、Python/R capability matrix、R semantic smoke、扩展拖拽、导出和生产构建。该证据是既有基线，不代表本计划中的新增能力已经实现；每个新工作包完成后必须重新取得新鲜证据。

### 2.2 尚未完成的核心问题

1. R 尚未完整对齐 Python 已建立的 patch 冲突零持久化、服务端能力权威和结构化 applied/skipped/conflict 合同。
2. 当前 `fingerprintVersion=2` 主要落在 Python introspector，R 的 layer/group/panel/scale/guide/text 仍需独立的版本化结构身份方案。
3. 本地可运行不等于服务器可重复运行；R 版本、包版本、字体、locale、图形设备和文件解析差异仍可能导致编译或视觉不一致。
4. facet、guide、colorbar、boxplot、ribbon、contour、segment/curve 等对象的细粒度不统一。
5. `ggrepel`、`ggnewscale`、`coord_sf`、第三方 grob 和 base R 没有专用 adapter。
6. 网络图、路径图和 SEM 尚未形成 node/edge/arrow/coefficient/label 的专用语义协议。
7. R 多 Figure、复杂项目回归、性能分段指标和用户可见能力报告仍不完整。

### 2.3 与当前 Python 专项的关系

standalone Python patch 的客户端 mode 绕过已经修复：无 `projectId/projectContext` 时也会保守进入服务端/renderer 验证；拒绝请求不会增加 revision 或写入 session、history、cache、导出锚点和快照。该前置阻断项已由 `test:patch-rejection-persistence` 证明关闭，但 R 产品工作仍须等待 Python 完整 release gate 和稳定候选提交，避免两种 renderer 同时修改共享主链路。

Python 专项修改共享协议时，R renderer、R semantic smoke 和导出回归仍是强制门禁；R 专项修改共享协议时，同样必须回归 Python，不允许以“只改 R”为理由跳过 Python 基线。

2026-07-21 的 R-WP0 已冻结 15 个合成 capability fixture 和一份无 fingerprint 版本的静态旧 identity/editLog fixture。当前新鲜证据为 R renderer 32 个正向测试通过，另有 1 个“ordinal GID 相同但分组语义已变化”的明确 `expectedFailure`；该失败是 R-WP2 必须关闭的兼容阻断项。Python/R capability matrix 2/2、R semantic 浏览器 6/6（含 SVG 导出状态）、R 安全预检和数据审计 0 issue。详细清单见 `R_WP0_BASELINE_EVIDENCE.md`。该结论只完成 Baseline，不代表 R-WP1 至 R-WP10 已实现。

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

### R-WP4：常用 ggplot2 图元家族精细化

一次只处理一个对象家族，顺序如下：

1. `GeomPoint/Jitter`：点大小、填充、边框、透明度、shape 和 group。
2. `GeomLine/Path/Smooth`：线色、线宽、线型、透明度、marker/point relation。
3. `GeomBar/Col`：fill/edge/linewidth/alpha、stack/dodge group。
4. `GeomErrorbar/Linerange/Pointrange/Crossbar`：主线、端帽、点和容器关系。
5. `GeomBoxplot/Violin`：box、median、whisker、staple、outlier、body 关系。
6. `GeomRibbon/Area`：置信区间带、边界线、fill 和 owner series。
7. `GeomStep/Histogram/Freqpoly`：bin/step 语义和连续系列身份。
8. `GeomTile/Raster/Rect/Contour`：mappable、scale、guide 和 panel 关系。
9. `GeomSegment/Curve`：线、箭头和端点语义，不自动与任意文本配对。

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
