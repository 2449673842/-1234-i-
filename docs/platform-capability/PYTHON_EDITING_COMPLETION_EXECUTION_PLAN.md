# Python 图元编辑与分组识别收敛执行计划

> 状态：WP3/WP4 核心边界和 WP8 已完成；WP6 的 `fill_between`、`contour/contourf`、`hist/stairs/step` 已通过完整门禁，下一家族为 `pie/wedge`
> 最后修改时间：2026-07-19 16:22:04 +08:00
> 基线入口：`docs/current/03_FUNCTIONAL_REGRESSION_BASELINE.md`
> 适用范围：Python/Matplotlib 图元识别、语义分组、编辑写回、Draft、历史、导出和复杂图形扩展
> 当前部署状态：未推送、未部署；本计划不改变线上版本
> 执行模型：协调者负责基线和集成，具体核查与实现由 5.5 high 子代理承担

## 1. 目标

目标不是继续增加普通按钮，而是把 Python 编辑能力从“常见二维图上功能丰富”提升为“能力边界可见、对象身份可靠、错误不会被持久化、复杂图形按证据逐类开放”。

完成标准：

```text
每个默认开放能力都有 renderer 事实
每个对象和关系都有稳定身份或明确 conditional 状态
每个属性都有真实 patchMode、作用域和重放能力
每次编辑都能从 Draft 重放到刷新、历史、导出和恢复
不支持或歧义目标不会被错误持久化
任何新增能力不破坏当前功能基线
```

## 2. 当前结论

### 2.1 已具备基础

- 常见 Python 二维图元、legend、colorbar、annotation、container、twin/shared axes 已有真实 renderer 和测试基础。
- 组件中心、字体中心、配色中心、布局中心、Draft、拖拽、历史、导出快照等主链路已经可用。
- `identity`、`relation`、`propertyCapabilities` 和严格 target resolver 已部分接入。
- 当前全量单元测试为 144 文件 / 966 项；Matplotlib 3.7.2 与 3.8.4 两套升级验证环境均为完整 Python 110/110；组件浏览器 41/41。

### 2.2 尚未完整证明

- 已有一条隔离 E2E 连续证明“选择 -> 语义分组 -> Draft -> 后端重绘 -> 刷新 -> 撤销/重做 -> 导出 -> 后续编辑 -> 快照恢复”，但尚未扩展到全部复杂对象家族。
- 当前 Python capability matrix 只有 5 个 renderer 级 fixture，不等同于完整用户流程。
- line、scatter、bar、errorbar、boxplot、violin 等文档能力仍缺少完整浏览器矩阵证据。
- 结构变化后的对象身份、复杂 collection 的真实语义和特殊 axes 坐标契约仍不完整。

### 2.3 已发现的高风险问题

1. [已在 WP2 修复] missing gid 或 unsupported setter 可能只产生 renderer warning，但服务端仍把请求 patch 当作成功 editLog 持久化。
2. [已在 WP3 修复] 部分前端入口仍使用硬编码 `LOCAL_PROPS`，可能绕过 renderer `propertyCapabilities`。
3. [已在 WP8 修复] 导出快照恢复在数据库事务前没有先 dry-run 重放全部 Figure。
4. [已在 WP8 修复] 导出文件与数据库记录之间只有补偿式流程，没有完整失败回滚证据。
5. `instanceKey` 仍以 GID 为核心，插入、删除或重排 artist 后可能漂移。
6. [已在 WP4 修复] `fingerprint` 包含可编辑样式，不适合作为结构身份锚点。
7. quiver、streamplot 和 pie 仍会被压平成普通 collection/patch/container；`fill_between`、`contour/contourf` 与 `hist/stairs/step` 已完成专用适配。
8. [renderer 已修复，用户摘要待 WP5] `coverageReport` 不能区分“真正语义支持”和“被普通基类接住”。

### 2.4 2026-07-18 首轮执行结果

- 新 patch 在执行时携带目标 Figure 当前 manifest 的 `stableKey/identity`；v2 结构 fingerprint 不再包含颜色、线宽、字号等可编辑样式。
- `fingerprintVersion=2` 只对新算法做严格比较；旧 manifest 没有版本时不比较旧 fingerprint，继续使用 stableKey/seriesKey 兼容核验。
- renderer 对 `missing_gid` 和 `identity_mismatch` 返回结构化 warning；有身份凭据但不匹配时保守跳过，不自动 remap。
- 项目 Figure 的 Python patch 以 manifest `propertyCapabilities.patchMode` 为权威；客户端不能把 backend 属性伪装成 local。
- 预检或 renderer 拒绝任一新 patch 时，整批返回 `conflict`，revision、session、项目 Figure、history、cache、导出锚点和快照均不改变。
- 合法 local/backend 混合批次完整重放并只增加一次 revision；前端 conflict 保留 Draft，不把现有 Figure 标成渲染失败。
- 复杂对象新增 `semanticCoverage` Shadow 报告，只标记有强证据的 fill_between、quiver、stairs、wedge、contour 和 streamplot candidate；不改变现有 kind、editable 或控件。
- Python patch cache 只命中本进程已通过 renderer 确认的 key；旧磁盘 cache 在重启后先重新验证。
- 项目 PUT 保存接口现在复用可信 manifest/propertyCapabilities 预检；editLog、history 和无 manifest 新编辑均不会绕过验证。
- 统一 `resolvePatchMode` 已接入前端编译器、配色、属性/组件/字体/图层入口；现代 manifest 缺失属性声明时不再使用 legacy 猜测。
- 跨 Figure 无授权显式对象不再 fanout，目标 Figure mode 重新解析；语义组 fanout 必须由 `crossFigure: allow` 明确授权。

第二轮代码审查发现的 standalone mode 权威问题已修复，并由 `test:patch-rejection-persistence` 覆盖无 projectId 伪报 local、missing gid 和 mixed batch。项目 PUT 另由 `test:project-save-preflight` 覆盖保存入口和 history 侧门。

仍未完成：WP3 全入口的剩余 legacy 兼容审计、WP4 无标签 collection 的结构身份矩阵、WP5 用户可见能力报告、WP6 其余复杂对象家族、WP7 特殊 axes、WP9 性能与碰撞、WP10 默认启用与旧路径退役。WP8 已完成；WP6 的 `fill_between`、`contour/contourf`、`hist/stairs/step` 已完成专用写回和完整用户链路。

### 2.5 2026-07-18 WP8 执行结果

- 快照恢复在任何数据库写入前，通过 renderer dry-run 验证 Python/R 脚本、editLog、GID、能力声明和对象身份；拒绝项不会改变项目、session、history、cache、导出锚点或快照。
- dry-run 后、进入数据库事务内再次核对项目、Figure、文件、导出资产和快照状态；并发变化返回 `EXPORT_SNAPSHOT_CONCURRENT_MODIFICATION`，避免旧验证结果覆盖新编辑。
- 单 Figure v1 快照保持兼容；信息不足的多 Figure v1 和当前无法安全证明的多 Figure R 恢复明确拒绝，不猜测映射。
- 导出文件创建在数据库插入失败时清理新文件；资产删除先暂存文件，数据库删除失败时恢复，成功时同时收敛数据库与文件状态。
- `test:export-snapshot-restore`、`test:export-snapshot-concurrency`、`test:export-file-transaction`、`test:export-snapshot-db`、`test:export-snapshot-restore-ui` 和完整导出矩阵均通过；测试使用隔离端口和临时数据目录。

### 2.6 2026-07-19 WP6 `fill_between` 执行结果

- renderer 拦截可信 `Axes.fill_between` 调用，在 Matplotlib 3.7 的通用 `PolyCollection` 上记录来源；仅有该来源证据的对象提升为 `kind=fill_between`、`role=fill_between_series`。
- 历史 GID 继续使用 `collection.<axes>.<index>`，stableKey/seriesKey 继续使用 `axN.collection...`；旧 gid-only editLog 和 v2 身份校验均可重放。
- 只开放 `facecolor`、`edgecolor`、`alpha`、`linewidth` 和 `zorder`，不开放数据上下界或统计含义。
- 前端新增 `data_band` 目标角色和独立“置信区间带”组件组；配色中心的静态绑定与渲染色回退均支持 band，不再混入散点大小控件。
- 完整 E2E 已证明 band 的 Draft、后端重绘、保存刷新、撤销重做、导出快照、后续编辑和恢复一致；R renderer 31/31 与 R 浏览器 5/5 未回退。
- 独立 5.5 high code review 为 PASS，CRITICAL/HIGH/MEDIUM/LOW 均为 0。

### 2.7 2026-07-19 WP6 `contour/contourf` 执行结果

- renderer 输出 `contour`/`contourf` 专用父对象、父子 relation 和 mappable/colorbar relation；子 collection 标记 `contour_child_collection`、`parentOwned`，不再作为现代编辑目标。
- 只开放可证明的视觉属性；`levels`、X/Y/Z、paths 和 segments 保持只读，避免编辑改变科学数据与等值线结构。
- `resolveCrossFigurePolicy` 只在全部目标属性明确声明 `cross_figure` 时允许 fanout；`cmap/vmin/vmax` 在当前对象/Figure 正常生成 Draft，不再被错误的全局 `allow` 跳过。
- 旧 contour child editLog 继续兼容，但必须保持 stableKey/seriesKey 一致；只允许已知 Matplotlib 版本差异导致的 fingerprint 漂移，不放宽其他身份字段。
- 组件中心只展示父对象；SVG 命中 contour child 时重定向到对应父对象，普通和拖拽模式 Ctrl/Shift 都可保留多个父对象，不生成新的 child patch。
- Python 完整用户链路、组件 31/31、跨 Figure 11/11、SVG/PNG/PDF/TIFF 与子图导出、快照恢复、旧项目 API、Matplotlib 3.7.2/3.8.4 升级兼容和 R 共享回归均通过。

### 2.8 2026-07-19 最终审查收敛

- 项目级代码 patch 现在检查全部 Figure 的有效 editLog；其他 Figure 的 renderer replay warning 会让整批在持久化前冲突，不增加 revision，也不写 session、history、cache、导出锚点或快照。
- 单 Figure 和全项目导出都在保存资产前检查 replay warning；全项目导出先完成全部目标的渲染预检，避免前一个 Figure 已落库、后一个 Figure 才失败。
- contour child 在拖拽模式下的 modifier 多选使用同步选择引用并抑制同一次 click 二次处理。
- 新增失败回归后，`test:replay-warning-persistence`、组件 31/31、导出矩阵、拖拽 10/10、完整 Python 用户链路和最终独立复审均通过；没有 HIGH/MEDIUM 未解决问题。

### 2.9 2026-07-19 WP6 `hist/stairs/step` 与保存并发收敛

- renderer 只把可信 `Axes.hist`、`Axes.stairs` 和 `Axes.step` 调用提升为 `histogram_series`、`stairs_series` 和 `step_series`；普通 bar、手工 `StepPatch` 和仅设置 drawstyle 的 line 不会误分类。
- histogram 父容器拥有系列级视觉属性，内部 patch 标记 `histogram_child_patch + parentOwned` 并重定向到父对象；`bins/counts/edges/values/density/cumulative/orientation/weights/where/x/y/baseline` 等结构参数保持只读。
- 组件中心、配色中心、Draft、跨 Figure、保存刷新、历史、四格式导出和导出快照恢复均使用专用 role，不按同色普通对象扩散。
- 修复过期自动保存覆盖新 editLog 的竞态：项目 PUT 以 `baseRevision + baseEditLogHash` 做 CAS；缺前置条件、revision 漂移或 hash 漂移均在事务前 409 且零写入。
- GET/PUT 统一使用 `session -> project_figures -> 单 Figure legacy spec` 恢复顺序；语义相同的旧 Figure payload可保存名称/spec，但没有 CAS 时不会覆盖 Figure editLog/history/revision。
- 保存期间的新 Draft 只在值与已确认持久化值完全一致时清除；排队保存等待下一次 React 提交后再读取最新状态。
- 最终证据：Vitest 144 文件/966 项、两套 Matplotlib 110/110、组件浏览器 41/41、语义中心 14/14、跨 Figure 16/16、R 浏览器 5/5、完整 Python 工作流、历史/导出/安全/隔离门禁和生产构建通过；数据审计保持 0 错误；第三轮独立 5.5 high 复审 PASS。

## 3. 决策原则

### 3.1 原则

1. 基线先于增强：现有功能没有新鲜证据时，不切换默认行为。
2. 测试先于修复：先复现错误，再修改最小代码路径。
3. 能力逐类开放：按对象家族和编辑中心拆分，不做全局 strict resolver 一次切换。
4. 不猜测：missing、ambiguous、unsupported 默认跳过并报告。
5. 可回滚：每个工作包有独立 flag、协议兼容路径或文件级回滚单位。
6. 固定运行时：生产只运行一套精确锁定的 renderer 镜像；上一环境只作为升级期历史项目回归，不承担长期多版本服务。

### 3.2 决策驱动因素

- 用户现有项目和历史记录不能被新身份规则误映射。
- 编辑器预览、刷新、历史、导出和恢复必须指向同一状态。
- Python 增强不能破坏 R、数据隔离、renderer 沙箱或生产部署边界。

### 3.3 方案选择

| 方案 | 优点 | 缺点 | 结论 |
|---|---|---|---|
| 全局切换 strict identity/resolver | 架构表面简单 | 旧项目、旧 manifest 和未迁移入口风险极高 | 拒绝 |
| 保持所有 legacy 路径，只增加新图元 | 短期改动少 | 继续积累错误持久化和身份漂移 | 拒绝 |
| Baseline -> Shadow -> Scoped Enable -> Default Enable | 可验证、可逐类回滚 | 执行周期较长，测试矩阵更大 | 采用 |

## 4. 非目标

- 不重写整个 renderer。
- 不把 Matplotlib artist tree 转成前端自绘图。
- 不改变 `/api/figure/patch` 的基本 wire format。
- 不在本轮强行实现任意第三方 Artist、任意 3D/地图对象或所有绘图库。
- 不用真实用户数据作为自动化 fixture。
- 不顺便重构宣传页、管理员后台或服务器部署。

## 5. 工作包与执行顺序

### WP0：冻结并验证当前基线

**任务**

- 维护 `docs/current/03_FUNCTIONAL_REGRESSION_BASELINE.md`。
- 运行全部编辑主链路的隔离 smoke。
- 修复 `D4-r-native-protection` fixture 阻塞，不能删除用例或放宽断言。
- 审计 8 个未直接使用公共隔离 wrapper 的测试命令，确认其是否自建临时数据库和端口。
- 记录修改前 `data:audit`、Git 状态、监听端口和测试报告路径。

**验收**

- 现有基线除明确记录的历史债务外全部为 PASS。
- 任何 BLOCKED 都有 owner、根因和处理计划。
- 测试过程没有访问 3000 或真实 `data/`。

**回滚单位**

- 仅测试、fixture 和文档；不修改产品行为。

### WP1：建立完整 Python 用户链路 E2E

**新增资产**

- `tests/fixtures/capability_matrix/python/semantic_workflow_end_to_end.py`
- `tests/playwright/python_semantic_workflow_regression_smoke.mjs`
- `test:python-semantic-workflow` package script

**必须连续验证**

```text
选择对象
-> 选择语义组
-> 修改后只进入 Draft，不提前请求 renderer
-> 应用生成一个 backend patch batch
-> revision 增加
-> 页面刷新后视觉和 editLog 保持
-> undo 恢复
-> redo 重放
-> SVG/PNG 导出带编辑快照
-> 导出后继续修改
-> 从资产恢复到导出时状态
-> 恢复前的新状态成为历史检查点
```

**硬保护**

- 测试必须拒绝 `localhost:3000`。
- 必须存在临时 `SCIFIGURE_DATA_DIR/SCIFIGURE_DB_PATH`。
- 不满足隔离条件时测试直接失败，不静默降级。

### WP2：renderer 应用确认与持久化正确性

**测试先行**

- missing gid patch 不得写入 editLog。
- unsupported prop/setter 不得写入 editLog。
- capability mismatch 不得写入 history、export anchor 或 snapshot。
- 同一批次部分成功时，只持久化确认成功的 patch，失败项保留 Draft。

**实现边界**

- renderer 返回结构化 `applied/skipped/warnings`，而不是只返回笼统 warning。
- 服务端只持久化 renderer 明确认可的 applied patch。
- API 对全失败、部分失败和冲突使用明确状态。
- 旧 renderer 返回缺少新字段时进入兼容策略，但不得默认把 unknown 当成功。

**回滚单位**

- renderer patch acknowledgement 和 server persistence adapter；不修改 UI 控件。

### WP3：以 propertyCapabilities 统一 patchMode

**任务**

- 建立单一 `resolvePatchMode(manifest, object, prop)`。
- 新 manifest 必须以 `propertyCapabilities[prop]` 为最终事实。
- 旧 manifest 才允许受控 legacy fallback，并记录 shadow diagnostic。
- 字体、组件、配色、属性编辑和批量编辑分别迁移，不同时切换。

**验收**

- UI 不会在 capability 要求 backend 时生成 local patch。
- local patch 只允许 `preview=exact` 且 `replay=stable`。
- 每个中心可独立通过环境 flag 回滚。
- Python/R 共用前端 helper，但分别验证 renderer 结果。

### WP4：对象身份和结构变化保护

**测试矩阵**

- 在目标前插入一条 line。
- 删除目标前一条 line。
- 交换两条有 label 的 series 顺序。
- 数据排序改变 tick 和 collection 顺序。
- legend 条目增删和重排。
- container children 数量变化。

**正确行为**

```text
唯一稳定身份 -> 精确重放
明确可迁移语义 -> 受控 remap 并记录原因
多个候选 -> ambiguous，跳过
目标消失 -> missing，跳过
绝不按旧数组索引静默修改新对象
```

**实现要求**

- 区分结构身份和样式 fingerprint；可编辑颜色、字号、线宽不能参与结构 identity。
- `instanceKey` 在相同结构重渲染时唯一稳定。
- 旧 editLog 不进行不可证明的自动迁移。
- legacy numeric suffix 只保留低风险兼容读取，不能用于位置和跨 Figure 高风险操作。

### WP5：能力覆盖事实与用户可见报告

**renderer 升级**

- `coverageReport` 区分 recognized、semantic、flattened、readonly 和 unsupported。
- `byKind` 统计属性能力并集、交集或变体，不能只复制第一个对象。
- flattened 对象记录原始 Matplotlib class、来源调用和降级原因。

**用户界面**

- 工作区提供简洁能力摘要：可编辑、部分可编辑、只读、暂不支持。
- 用户可展开查看对象类型、原因和建议，不暴露内部安全实现细节。
- 控件缺失时能区分“该图没有此对象”和“当前对象不支持”。
- 将轴范围、对数、vmin/vmax 等标记为可能改变科学表达的编辑。

### WP6：复合科研对象按家族适配

按以下顺序一次只处理一个家族：

1. `fill_between` / 置信区间带。[已完成首轮专用适配与完整门禁]
2. `contour/contourf` / 等高线与连续色标。[已完成专用父对象、兼容重放与完整门禁]
3. `hist/stairs/step` / 直方与阶梯系列。[已完成专用语义、结构只读、保存并发与完整门禁]
4. `pie/wedge` / 扇区、标签和图例。
5. `quiver/streamplot` / 向量场。
6. 网络图、路径图和 SEM 的节点/边/箭头/系数文字关系。

下一执行家族为 `pie/wedge`。在其 fixture、身份、能力、浏览器、历史和导出链路全部建立前，不修改默认组件分类。

每个家族必须依次完成：

```text
合成 fixture
-> renderer kind/role/relation
-> propertyCapabilities
-> target resolver
-> Draft/backend replay
-> 浏览器选择与组件中心
-> 保存刷新
-> undo/redo
-> 导出和快照恢复
-> 用户可见限制
```

不允许用普通 collection/patch 的“能改颜色”冒充专用语义支持。

### WP7：特殊 axes 和坐标契约

先识别和分类，再开放编辑：

```text
polar
3D
inset axes
secondary_xaxis / secondary_yaxis
broken axes / parasite axes
地图投影 / Cartopy
```

默认策略：样式可证明则开放；位置、布局或跨轴归属不可证明则 readonly/unsupported。不得把所有 `fig.axes` 都当普通二维 subplot。

### WP8：恢复和导出事务安全

**状态：已完成首轮实现与专项回归；继续作为后续对象家族和 R 阶段的不可回退门禁。**

**快照恢复**

- 数据库事务前 dry-run 重放所有恢复 Figure。
- renderer error、missing、unsupported 或 capability mismatch 阻断恢复。
- dry-run 不写项目、session、history 或预览文件。

**导出文件**

- 创建失败时清理临时文件和未完成 DB 记录。
- DB 写入失败时删除新文件或进入可审计 pending 状态。
- 删除使用可回滚顺序，避免先删文件后 DB 失败。
- 数据完整性工具覆盖孤儿文件和缺失文件。

### WP9：确定性、布局碰撞和性能

- 对无 seed 随机数、当前时间、外部状态和不可重放副作用给出确定性警告。
- 为字体、图例、色条和标题变化增加裁切/重叠检查。
- 扩展 621 对象基线到系列级超大 scatter、密集 tick 和多子图。
- 优化只基于分段指标；不得取消沙箱、减少身份事实或缩减 manifest。

### WP10：默认启用与旧路径退役

默认启用条件：

- 对应对象家族完整矩阵全部通过。
- shadow 结果连续稳定，无 silent retarget。
- 真实项目人工回归通过。
- save/reload/history/export/restore 和安全 gate 通过。
- 有独立回滚 flag 或兼容 adapter。

旧 suffix/score guess 只能在一个稳定发布周期后逐项退役，不能与新 adapter 同批删除。

## 6. 5.5 high 代理分工

### 协调者

- 维护基线、计划、工作区边界和任务依赖。
- 不把同一文件同时交给多个代理。
- 审查代理 diff，执行集成测试和数据审计。
- 决定何时从 Baseline 进入 Shadow/Scoped Enable。

### Agent A：基线与测试夹具

- 修复拖拽 D4 fixture。
- 审计隔离测试入口。
- 只修改测试/fixture，不改产品行为。

### Agent B：完整 Python E2E

- 创建 WP1 fixture 和浏览器 smoke。
- 拥有新测试文件和对应 package script。
- 不修改 renderer、App 或 server。

### Agent C：身份与复杂图元测试

- 新建结构变化和 flattened kind 测试文件。
- 先提供可复现失败，不直接设计全局 remap。
- 产品修复由后续单一 owner 接手。

### Agent D：patch acknowledgement

- 在 WP2 测试通过前只负责 renderer/server 这一条链路。
- 与身份、UI 代理保持文件范围隔离。

### Agent E：能力报告 UI

- 在 WP5 renderer 合同稳定后实现用户可见摘要。
- 只消费正式 coverage contract，不自行扫描 SVG。

### Agent F：独立 verifier/code reviewer

- 不参与实现。
- 检查基线、旧项目兼容、测试真实性和 diff 范围。
- 对 silent wrong edit、数据污染或跨 Figure 串联拥有阻断权。

## 7. 首批执行批次

首批执行状态：

```text
Batch 0A：完成；D4 R native 单图 fixture 10/10 拖拽回归通过
Batch 0B：完成；完整 Python 用户链路 E2E 通过
Batch 0C：完成；结构身份 7/7，通过 v2/legacy 双路径验证
Batch 0D：完成；复杂图元 Shadow coverage 7/7，不改变现有编辑能力
Batch 0E：部分完成；项目 Figure 的 missing/unsupported/renderer rejection 零持久化、mixed batch 与 legacy manifest 已通过，standalone mode 权威待修
```

Batch 0 已形成大部分可靠证据；WP2 的项目 Figure 服务端确认与持久化正确性已完成首轮实现。standalone patch mode 权威修复及其回归是进入 WP3 的前置门禁。WP3 及后续工作包仍按 Shadow -> Scoped Enable -> Default Enable 顺序推进，不允许一次性全局切换。

## 8. 验收与停止条件

每个工作包必须满足 `03_FUNCTIONAL_REGRESSION_BASELINE.md` 的适用 Gate，并额外证明：

- 新增测试先在旧行为上正确失败或暴露明确 debt。
- 修复后新增和既有测试同时通过。
- 临时服务退出，3000 与 Docker 未改变。
- 修改前后数据审计问题数均为 0。
- 文档状态只按实际证据更新。

以下情况立即停止：

- 测试访问真实数据或 3000。
- 新增能力让旧对象、旧控件、旧历史或导出状态消失。
- renderer warning 仍被持久化为成功。
- identity 无法唯一证明却发生自动 remap。
- Python 修改导致 R 或共享前端协议退化。
- 代理修改超出分配文件范围或覆盖其他人的未提交改动。

## 9. 预演失败场景

### 场景一：新 identity 修复了新图，却改错旧项目

防护：旧 manifest 兼容读取、shadow 比对、歧义拒绝、按对象家族 flag、真实旧项目只读回归。

### 场景二：浏览器显示修改成功，但 renderer 没有应用

防护：结构化 applied/skipped acknowledgement、服务端只持久化确认项、刷新和导出重放验证。

### 场景三：测试全部通过，但污染真实项目或漏测线上链路

防护：强制隔离环境变量、拒绝 3000、前后 data audit、完整 E2E、独立 verifier 和人工真实项目回归。

## 10. 完成定义

本专项完成不是“所有 Matplotlib 对象都能编辑”，而是：

```text
当前支持对象有完整证据且不回退
复杂对象按明确家族逐项支持
不支持对象对用户透明可见
错误、歧义和身份漂移不会静默写入历史
编辑状态可从预览稳定走到刷新、撤销、导出和恢复
```

超出已验证矩阵的对象继续标记部分支持或 unsupported，不扩大宣传口径。
