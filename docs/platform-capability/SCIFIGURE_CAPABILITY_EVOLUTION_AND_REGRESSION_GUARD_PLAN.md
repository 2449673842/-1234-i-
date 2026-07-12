# SciFigure 平台能力增强与回归保护升级方案

> 状态：当前专项执行方案  
> 更新时间：2026-07-12 12:32:39 +08:00  
> 适用范围：图元识别、选择作用域、属性编辑、拖拽、布局、保存历史、Python/R 对齐和渲染性能  
> 基线：当前本地工作区，不等同于已发布版本  
> 总原则：增强现有能力，不重建平行编辑链路；任何新能力都必须证明不会误改对象、错写坐标或破坏保存与渲染主链路。

## 1. 方案目标

当前平台已经具备完整的编辑工作台骨架：

```text
Python/R renderer
-> manifest 图元内省
-> StandardFigureModel
-> EditingIntent
-> Draft Patch Batch
-> 按 Figure 调度
-> 保存、历史和导出
```

下一阶段不是继续堆叠控件，而是增强以下四个核心结果：

```text
识别正确：知道用户选中的到底是什么对象
作用域正确：知道修改单个、整组、子图还是跨 Figure
写回正确：知道参数应写回哪个 renderer 对象和坐标系
执行高效：只提交最终修改，只重绘受影响 Figure
```

本方案不引入 AI 自动改图，不替换现有 `/api/figure/patch`，不强行合并 Python/R renderer，也不以“大重构”作为升级前提。

## 2. 当前可复用基础

| 基础能力 | 当前实现 | 升级策略 |
|---|---|---|
| 统一图形模型 | `src/schemas/standardFigureModel.ts` | 保留 v1 字段，增量增加可选身份和能力字段 |
| 原始图元协议 | `src/schemas/manifest.ts` | 继续作为 renderer 事实来源，不由前端猜测 SVG 语义 |
| 编辑意图 | `src/schemas/editingIntent.ts` | 扩展目标解析报告，不替换现有 intent |
| 意图编译 | `src/utils/editingIntentCompiler.ts` | 抽离统一 Target Resolver，旧编译结果先做影子比对 |
| 跨图映射 | `src/utils/semanticPatchMapping.ts` | 保留兼容路径，逐步取消不确定的“最佳分数猜测” |
| 草稿批次 | `src/schemas/draftPatchBatch.ts`、`src/App.tsx` | 从“先清草稿再执行”升级为“成功后提交” |
| stale guard | `src/App.tsx` 的 per-Figure `requestId` | 保留并下沉到统一 Figure 调度器 |
| 多目标拖拽 | `src/components/ChartPreview.tsx` | 保留最终位置累积模式，补坐标和身份契约 |
| Python 内省 | `renderer/introspector.py` | 增强稳定身份、关系和属性级能力声明 |
| R 内省 | `renderer/r_renderer.R` | 输出同一前端协议，但继续使用 R 专用写回逻辑 |
| 渲染缓存 | `server.ts` 的 Figure render cache | 增加分段耗时和命中诊断，不另造第二套缓存 |
| 自动化回归 | `tests/playwright`、`tests/api`、单元测试 | 先建立基线，再允许行为切换 |

## 3. 不可破坏的基础行为

以下行为是后续升级的硬约束。任一项回归都应阻断合并：

1. 拖拽关闭时，单击图元仍能选中并打开对应属性。
2. 拖拽开启时，不需要按空格；拖动只改变可定位对象。
3. 单对象文本内容修改不能扩展到同角色的其他文本。
4. 组样式修改必须覆盖组内全部可编辑目标，不能只修改第一个。
5. `axis label`、`tick label`、`tick line` 和 `spine` 必须保持独立。
6. 当前 Figure 修改默认只重绘当前 Figure。
7. 内容和位置修改默认禁止跨 Figure 传播。
8. 不支持的目标必须跳过并说明原因，不能猜测写回。
9. Draft Batch 必须保持 last-write-wins，并作为一次历史操作提交。
10. 保存成功后刷新页面必须恢复同一 revision、editLog 和视觉结果。
11. 撤销、重做、导出锚点必须绑定真正完成的 revision。
12. Python/R 共用前端语义，但任何共享协议修改必须分别验证两个 renderer。
13. renderer 沙箱、用户数据隔离和 `data/` 红线不得因性能优化被绕过。
14. 原有 `gid`、`editable`、`currentProps` 和 patch API 在迁移期保持兼容。
15. 项目、Figure、session、历史和导出资产的所有权必须绑定认证用户；不得按注册顺序、首次登录或测试账号名称推断归属。
16. 已保存 Figure 的 editLog/history 必须有项目级持久化副本；临时 session 清理不得删除被项目引用的数据。
17. 自动化测试必须使用临时数据库或明确的测试项目，禁止在真实 `data/scifigure.db` 中创建测试账号后执行所有权迁移。

## 4. 当前真实薄弱点

### 4.1 对象身份仍可能漂移

Python 已输出 `stableKey` 和 `fingerprint`，但无标签对象仍可能退化为 axes/index 组合；`fingerprint` 又包含颜色、字号等可编辑属性，修改样式后可能变化。R 侧大量对象仍主要依赖 layer、panel 和数组序号。

风险：

```text
重渲染后同一个对象换 ID
第二次拖拽命中第一次对象
历史回放找不到原对象
跨图应用错误选择“最像”的对象
```

### 4.2 子图归属存在数字后缀兜底

`editingIntentCompiler.ts` 在缺少 `subplotId` 时会从对象 ID 数字后缀推断子图。该策略对普通 `xtick.0.2` 有帮助，但对 figure-level legend、复合容器和自定义命名可能产生错误归属。

升级后，renderer 明确提供的 `subplotId` 必须优先且成为可编辑对象的必需事实。数字后缀只能作为旧 manifest 的兼容读取路径，不能用于高风险位置和跨图操作。

### 4.3 能力声明颗粒度不足

当前 `editable: string[]` 只能回答“属性是否可编辑”，不能回答：

```text
走 local patch 还是 backend patch
是否支持单对象、组、子图或跨 Figure
位置使用 data/axes/figure/display 哪种坐标
能否本地预览
能否稳定重放
修改后是否可能引发布局联动
```

这会导致前端控件存在，但 renderer 实际不能可靠执行。

### 4.4 目标解析逻辑分散

目标选择和批量扩展目前分布在：

```text
editingIntentCompiler.ts
semanticPatchMapping.ts
RightSidebar.tsx
ChartPreview.tsx
App.tsx
```

同一“选中整组”可能经过不同规则，造成组件中心、字体中心、配色中心和跨 Figure 应用结果不一致。

### 4.5 跨图分数匹配存在歧义

当前跨图兼容路径会综合 `stableKey`、role、kind、subplotId、parentId 和 label 选择最高分目标。该策略比复制 raw gid 安全，但当多个目标同分时仍缺少明确的歧义拒绝机制。

原则应改为：

```text
唯一确定命中 -> 应用
明确语义组 fan-out -> 应用全部目标
多个同等候选 -> 跳过并报告 ambiguous
无匹配 -> 跳过
```

### 4.6 草稿提交不是完整事务

当前跨 Figure 应用会在请求执行前清除源草稿。如果后端失败、超时或部分 Figure 失败，用户可能丢失尚未成功应用的修改。

应升级为：

```text
预检
-> 生成 PatchPlan
-> 执行各 Figure job
-> 成功目标提交历史和 revision
-> 全部成功后清除对应草稿
-> 失败目标保留草稿并允许重试
```

### 4.7 性能缺少分段证据

当前已有 `timingMs`、缓存和按 Figure requestId，但仍难回答时间花在：

```text
队列等待
容器启动
脚本执行
图元内省
SVG 序列化
数据库保存
网络传输
浏览器解析
```

没有分段耗时前，不应通过取消沙箱、减少内省或扩大并发进行盲目优化。

## 5. 目标架构

升级后的编辑链路仍使用现有 renderer 和 patch API，但在前端编译阶段增加清晰边界：

```text
Renderer Manifest
-> Object Identity Adapter
-> Property Capability Registry
-> Selection + Target Resolver
-> PatchPlan Preflight
-> Figure Transaction Executor
-> Per-Figure Render Scheduler
-> Persistence + History + Export Anchor
```

### 5.1 对象身份层

在保留现有字段的前提下，为对象增量增加：

```ts
interface ObjectIdentityV2 {
  semanticKey?: string;      // 与样式无关的语义身份
  instanceKey?: string;      // 当前 Figure 内唯一实例身份
  seriesKey?: string;        // 数据系列、scale 或 layer 身份
  coordinateSpace?: 'data' | 'axes' | 'figure' | 'display' | 'container' | 'none';
  relation?: {
    parentId?: string;
    subplotId?: string;
    legendId?: string;
    colorbarId?: string;
    mappableId?: string;
  };
}
```

约束：

- `semanticKey` 不得包含颜色、字号、位置等可编辑样式。
- `instanceKey` 在相同代码、数据和 Figure 结构重渲染后保持稳定。
- 同一 Figure 作用域内不能出现重复 `instanceKey`。
- figure-level 对象显式标记为无 `subplotId`，不得自动归入 `subplot.0`。
- legend、colorbar 和 annotation 使用容器关系，不靠 SVG 邻近关系绑定。

### 5.2 属性级能力层

保留 `editable` 兼容字段，新增可选属性能力：

```ts
interface PropertyCapability {
  prop: string;
  patchMode: 'local_patch' | 'backend_patch';
  scopes: Array<'object' | 'group' | 'subplot' | 'figure' | 'cross_figure'>;
  preview: 'exact' | 'approximate' | 'none';
  replay: 'stable' | 'conditional' | 'unsupported';
  coordinateSpace?: 'data' | 'axes' | 'figure' | 'display' | 'container';
  derivedEffects?: string[];
  unsupportedReason?: string;
}
```

前端控件必须以能力交集决定是否显示。批量选择时，若 8 个对象只有 6 个支持 `linewidth`，UI 应显示“可修改 6，跳过 2”，不能静默只改第一个。

### 5.3 统一目标解析器

新增单一 Target Resolver，所有入口只提交选择和意图，不自行展开 gids：

```text
画布单击
图层结构
字体中心
组件中心
配色中心
子图中心
跨 Figure 应用
```

解析结果必须包含：

```ts
interface TargetResolutionReport {
  requested: string[];
  resolved: Array<{ figureId: string; objectId: string; match: 'exact' | 'semantic' | 'fanout' }>;
  skipped: Array<{ figureId: string; objectId?: string; reason: string }>;
  ambiguous: Array<{ figureId: string; candidates: string[]; reason: string }>;
}
```

任何 `ambiguous` 默认不生成 patch。

### 5.4 PatchPlan 与影响边界

Draft 在应用前编译为不可变 PatchPlan：

```ts
interface PatchPlan {
  planId: string;
  sourceFigureId: string;
  baseRevisions: Record<string, number>;
  operations: PatchEntry[];
  targets: TargetResolutionReport;
  jobs: Array<{ figureId: string; patches: PatchEntry[]; requiresRender: boolean }>;
  historyLabel: string;
}
```

每类操作定义允许影响范围：

| 操作 | 直接允许变化 | 允许的派生变化 | 禁止变化 |
|---|---|---|---|
| 文本内容 | 目标对象 `text` | 文本 bounds、局部布局 | 其他文本内容、数据系列 |
| 文本样式 | 目标样式属性 | bounds、换行占用 | 其他语义组样式 |
| 颜色/线宽 | 目标对象属性 | SVG 表现 | 非目标系列身份和数据 |
| 位置 | 目标 position 或容器 bounds | 目标选框 | 其他对象 position |
| 子图布局 | 指定 subplot bounds | 其子对象显示位置 | 字体、颜色和数据 |
| 画布尺寸 | figure size | 全图显示缩放或布局 | 数据内容和编辑日志语义 |

后端成功后执行轻量 postflight：确认目标属性已出现在新 manifest，且没有出现明确禁止的语义属性变化。SVG 像素差异不能单独作为失败依据，因为字体和布局可能产生合法派生变化。

### 5.5 Figure 事务执行器

事务边界按 Figure 维护：

```text
baseRevision 校验
-> 请求幂等 requestId
-> stale response guard
-> 成功写入 revision/editLog/history
-> 失败保留草稿
```

跨 Figure 批量不是数据库意义上的全局原子事务，但 UI 必须保留每张图的成功、失败和可重试状态。成功 Figure 不重复渲染，失败 Figure 不丢草稿。

### 5.6 现有能力的统一增强生命周期

平台能力增强不以“增加一个控件”或“某个示例能运行”作为完成标准。每个能力域都沿用同一条升级链路：

```text
现状基线
-> renderer 输出事实对象
-> identity 声明稳定身份和对象关系
-> propertyCapabilities 声明真实可编辑边界
-> Target Resolver 生成唯一、可解释的目标集合
-> 独立 feature flag 受控接入具体中心
-> Draft/Figure 事务成功后提交
-> 保存、刷新、历史和导出锚点验证
-> Python/R 与复杂 fixture 回归后放行
```

每一步的失败处理固定如下：

| 阶段 | 缺失或冲突时的行为 | 禁止行为 |
|---|---|---|
| renderer 事实 | 标记未识别或只读 | 前端根据 SVG 位置臆造可写对象 |
| identity | 旧 manifest 走兼容路径；新协议重复身份则跳过 | 从多个同等对象中任选一个 |
| relation | 允许无风险只读展示；高风险联动跳过 | 用最近距离覆盖明确但冲突的关系 |
| capability | 隐藏/禁用控件并说明原因 | 显示 renderer 无法稳定执行的属性 |
| resolver | 返回命中、跳过和歧义报告 | 自动扩大对象、子图或跨 Figure 作用域 |
| transaction | 失败目标保留草稿，仅重试失败 Figure | 请求前清草稿或失败后写成功历史 |
| persistence | 不宣称完成，保留原 revision | 只凭当前 SVG 预览判断已保存 |
| regression | feature flag 保持关闭或回退 | 一次性切换所有中心和全部项目 |

增强现有能力时必须遵守四种兼容状态：

```text
legacy：旧 manifest 缺少新增协议，保持原功能
shadow：新旧解析同时运行，只记录差异
strict-enabled：仅已通过门槛的能力中心使用严格协议
strict-skipped：协议存在但关系歧义或能力不足，明确跳过且不回退猜测
```

#### 5.6.1 能力增强的五层状态模型

后续任何“增强已有能力”的任务，都必须先说明它改变的是哪一层。禁止在显示层为了方便直接修改事实层，也禁止在交互层绕过事务和持久化层。

| 层级 | 唯一职责 | 可以增强的内容 | 不得越界的内容 |
|---|---|---|---|
| 事实层 | renderer 输出完整对象、关系、能力和坐标事实 | 增加稳定 identity、relation、propertyCapabilities | 前端根据 SVG 距离或序号补造高风险语义 |
| 投影层 | 将完整事实投影成当前可见 UI | 搜索、筛选、窗口化、折叠、缩略图延迟挂载 | 删除 manifest 对象、改变 gid、把未显示等同于未识别 |
| 意图层 | 把用户选择编译为明确作用域 | 单对象、组、子图、Figure、跨 Figure 的严格解析 | 控件自行扩展 gids、同分候选任选一个 |
| 事务层 | 累积最终修改并按 Figure 执行 | Draft last-write-wins、失败重试、stale guard、只重绘目标 Figure | 请求前清草稿、部分失败写成全部成功、重复重绘无关 Figure |
| 持久化层 | 固定 revision、历史、保存和导出锚点 | 保存后刷新恢复、导出标记绑定历史步骤 | 仅更新当前 SVG、不保存 editLog/revision 却宣称完成 |

增强任务必须同时给出以下五项说明：

```text
Source of truth：此次能力依赖哪个 renderer/manifest 字段
Display projection：UI 是否只展示子集，完整对象是否仍保留
Target boundary：单对象、组、子图和跨图的允许作用域
Write-back path：local/backend/code patch 及坐标空间
Recovery proof：失败、撤销、刷新、重渲染后如何恢复一致
```

统一放行规则：

```text
只增强投影层 -> 不得改变 patch 数量、目标 gid、revision 和导出结果
增强意图层 -> 必须提供 resolved/skipped/ambiguous 证据，ambiguous 为 0 才能默认启用
增强坐标或拖拽 -> 必须验证连续多目标、缩放比例、松手停留、确认/取消和重渲染位置
增强批量编辑 -> 必须验证单对象不扩散、组不漏项、不同属性不串改、一次批次一次历史
增强 renderer -> 必须分别验证 Python/R，旧 manifest 保持兼容读取
增强性能 -> 只能减少重复计算和可见 DOM，不能减少语义对象或放宽安全隔离
```

当性能、便利性和准确性冲突时，优先级固定为：

```text
目标正确性 > 保存可恢复性 > 坐标一致性 > 交互即时性 > 极限吞吐
```

因此，无法唯一证明目标时宁可跳过；无法确认保存成功时保留草稿；无法保持完整语义时不做延迟卸载。

### 5.7 平台能力工作包与当前增强方向

| 工作包 | 已具备基础 | 当前增强重点 | 放行证据 |
|---|---|---|---|
| 图元识别 | Python/R manifest、StandardFigureModel | heatmap/colorbar、legend container、annotation/arrow 显式关系 | 双热图、共享图例、箭头 fixture 身份稳定 |
| 精准编辑 | EditingIntent、字体/组件/配色中心 | 所有入口统一 resolver；歧义拒绝；容器优先于 children | 单对象不扩散、整组不漏项、跨图不误配 |
| 拖拽 | 最终位置累积、确认/取消 | drag session 固定 identity；多目标独立坐标转换 | 连续拖动 3 个以上对象且重渲染不跳回 |
| 多子图布局 | bounds、重排、间距、绘图区尺寸 | 色条占位、交换、局部扩宽、固定物理 axes 尺寸 | 几何变化不覆盖字体/颜色/数据身份 |
| Python/R 对齐 | 两引擎一协议 | R facet/guide/annotation/layer 的真实能力声明 | 同一前端操作分别通过 Python/R 回归 |
| 保存历史 | Draft、revision、history、导出锚点 | 混合 local/backend 批次与失败重试一致性 | 保存刷新一致、一次批次一次历史 |
| 代码历史 | Monaco 草稿、代码同步、Figure history | 只记录成功同步版本；脚本与 editLog 一起撤回/重做 | 失败不入历史、刷新可恢复、入口行为一致 |
| 项目归属与数据恢复 | `user_id`、project_figures、SQLite 备份 | 显式 legacy owner、项目级 editLog/history、测试数据库隔离 | 项目数守恒、跨用户不可见、刷新后历史恢复 |
| 渲染性能 | 按 Figure 调度、缓存、stale guard | 分段耗时、任务合并、数据 staging、预热 | 同 fixture 冷热基线和只重绘目标 Figure |
| 大图前端性能 | SVG 预览、图层结构、多 Figure | 非活动 Figure/图层延迟解析，不删除语义对象 | 大 SVG 选择、滚动和拖拽响应基线 |

工作包可以和安全部署代码并行推进，但不得绕过 renderer 沙箱、用户数据边界和 `data/` 红线。安全 P0 阻断公网部署；图元误改、保存丢失和重渲染错位同样阻断对应能力默认启用。

### 5.8 Annotation、箭头与锚点的增量契约

Annotation 不新建平行编辑器，继续复用现有文本属性、组件中心、拖拽确认和 `/api/figure/patch`。协议只补充原链路缺少的对象关系和坐标事实。

Python/Matplotlib 约定：

```text
现有 text.{axesIndex}.{index} gid 保持不变，作为 annotation 文本主对象
FancyArrowPatch 使用 annotation_arrow.{axesIndex}.{index} 独立对象
annotation 文本 relation.annotationId 指向自身
annotation 文本 relation.arrowId 指向箭头对象（存在时）
annotation 箭头 relation.annotationId/textId 指回文本对象
currentProps.position 表示文字端位置
currentProps.anchor_position 表示箭头指向端位置
position patch 只移动文字端，保持 anchor 不变
anchor_position patch 只移动指向端，保持文字端不变
箭头颜色、线宽、透明度走 annotation_arrow 样式目标，不混入普通数据 patch
```

R/ggplot2 约定：

```text
GeomText/GeomLabel 继续使用 r.text.{layer}.{row}
声明 annotationId 和文本位置坐标能力
GeomSegment/GeomCurve 即使带 arrow，也不根据空间距离自动配对文本
只有未来 renderer 能从同一结构化 annotation 来源证明关系时才输出 arrowId/textId
coord_flip、polar、map、非线性 position scale 等不稳定坐标继续禁用位置写回
```

前端行为：

```text
拖动 annotation 文本仍只产生最终 position patch
多选拖动按 figureId + instanceKey 独立累计
箭头随 Matplotlib annotation 布局自动连接文字端和 anchor，不单独自由拖拽
组件中心单列“标注箭头”，不与数据线、误差棒或普通 patch 合并
字体中心将 annotation_text 归入“其它文本标注”
内容、position、anchor_position 默认禁止跨 Figure
关系缺失时保留普通文本编辑；关系冲突时禁用联动，不回退几何猜测
```

放行门槛：

- 修改文字内容、字体和位置后，`instanceKey/annotationId/arrowId` 保持稳定。
- 连续拖动多个 annotation 时，每个 gid 只保留最后一条位置 patch。
- 移动文字端不改变 anchor；移动 anchor 不改变文字端。
- 修改 annotation 箭头样式不命中普通数据线和普通 patch。
- 无箭头 annotation、普通 `ax.text` 和旧 manifest 行为保持不变。
- Python/R 既有语义中心、多子图、跨 Figure、拖拽和导出回归继续通过。

### 5.9 分段性能协议与安全优化边界

保留现有顶层 `timingMs` 和 `cache.hit/key`，增量增加结构化 `performance`，旧客户端无需读取新字段即可继续工作。

```ts
interface RenderPerformanceV1 {
  schemaVersion: '1.0';
  cacheHit: boolean;
  renderer: null | {
    staticScanMs?: number;
    scriptExecutionMs?: number;
    dynamicScanMs?: number;
    figureDiscoveryMs?: number;
    editApplyMs?: number;
    introspectionMs?: number;
    svgSerializeMs?: number;
    binaryExportMs?: number;
    totalMs: number;
  };
  runtime: null | {
    mode: 'local' | 'docker';
    queueMs?: number;
    payloadStageMs?: number;
    processMs?: number;
    outputParseMs?: number;
    totalMs: number;
  };
  server: {
    cacheLookupMs?: number;
    persistMs?: number;
    cacheWriteMs?: number;
    totalMs: number;
  };
}
```

测量规则：

```text
所有时间使用单调时钟，不使用 Date 字符串相减
cache hit 的 renderer/runtime 为 null，不伪造 0ms 渲染
Docker queueMs 只记录真实等待 render slot 的时间
无法从 renderer handshake 证明的 containerStartMs 暂不输出
SVG 浏览器指标使用 performance.mark/measure 和 data-* 诊断属性
指标只记录耗时、字节数、对象数量和命中状态，不记录代码、文本、路径或用户数据
```

优化顺序：

1. 先补分段指标和固定 fixture 基线。
2. 缓存命中直接复用目标 Figure，不启动 renderer。
3. 同一 SVG 字符串只清洗一次，React 状态变化不得重复运行 sanitizer。
4. 非活动缩略图使用 memo/content-visibility，不能删除 manifest 语义对象。
5. 只有证据显示瓶颈后才调整队列、缓存或预热。

禁止项：

- 不关闭 Docker 沙箱、禁网、资源限制或 AST/R 风险预检换取速度。
- 不减少图元内省覆盖或删除 SVG gid 换取更小输出。
- 不复用执行过不可信用户代码的 Python/R 进程。
- 不让批量导出占满全部交互式 renderer slot。
- 不以本地 unsafe renderer 成绩代替生产 Docker 基线。

## 6. 分阶段实施

### Phase 0：冻结当前行为基线

目标：任何升级前先证明旧功能还能工作。

任务：

```text
CAP-0.1 建立无用户数据的固定 Python/R fixture 集
CAP-0.2 保存代表性 manifest 契约快照
CAP-0.3 保存选择 -> intent -> patch 的期望映射
CAP-0.4 保存拖拽前后 position patch 样例
CAP-0.5 建立保存 -> 刷新 -> 恢复回归
CAP-0.6 记录冷启动/热缓存分段性能基线
```

fixture 至少包括：

```text
Python 单图
Python 三 Figure
Python 2x2 和 2x4
共享图例与每子图图例
双热图与 colorbar
annotation + arrow
boxplot/violin/errorbar/scatter
R ggplot 单图
R facet
R heatmap + continuous guide
```

本阶段不改变生产行为。

### Phase 1：对象身份和能力协议 v1.1

目标：先增加事实，不切换用户行为。

任务：

```text
CAP-1.1 给 ManifestObject 增加可选 identity/capability 字段
CAP-1.2 Python renderer 输出 v1 与 v1.1 双兼容字段
CAP-1.3 R renderer 输出同结构字段
CAP-1.4 增加 manifest validator 和重复 identity 检查
CAP-1.5 对重渲染前后身份稳定率生成报告
```

上线方式：shadow mode。现有 UI 继续读 `gid/editable`，测试同时比较 v1.1 是否能得到相同或更精确的目标。

切换门槛：

- 固定 fixture 中可编辑对象 identity 无重复。
- 只修改样式后，同一对象 identity 保持不变。
- figure-level legend 不被错误归入 subplot。
- Python/R normalizer 对缺少新字段的旧项目仍能读取。

### Phase 2：统一选择与目标解析

目标：消除各中心自行拼接 gids 的差异。

任务：

```text
CAP-2.1 新增纯函数 targetResolver
CAP-2.2 先接入字体中心和组件中心
CAP-2.3 再接入配色中心和子图中心
CAP-2.4 最后接入跨 Figure retarget
CAP-2.5 UI 展示命中、跳过和歧义数量
```

迁移期间旧编译器和新 resolver 同时运行：

```text
结果相同 -> 正常继续
新 resolver 更保守 -> UI 提示并保留旧行为开关供测试
新 resolver 命中不同对象 -> 记录诊断，不自动切换
```

严禁一次性把所有中心切换到新 resolver。

### Phase 3：Draft 事务与保存历史

目标：失败不丢修改，成功只产生一次历史。

任务：

```text
CAP-3.1 PatchPlan last-write-wins 统一去重
CAP-3.2 应用前校验 baseRevision
CAP-3.3 草稿改为成功后清除
CAP-3.4 部分失败按 Figure 保留草稿和重试入口
CAP-3.5 local/backend 混合批次明确执行顺序
CAP-3.6 一批修改只写一条 history snapshot
CAP-3.7 保存后重新 GET 项目校验持久化结果
```

当前 `/api/figure/patch` 保持不变；PatchPlan 是前端和调度层结构，发送后端前继续剥离 intent metadata。

### Phase 4：多目标拖拽稳定化

目标：拖动多个对象时，每个目标独立、可累计、可取消、可回放。

任务：

```text
CAP-4.1 drag session 固定捕获 object identity，不读取随后变化的 selectedObject
CAP-4.2 pending patch 以 figureId + instanceKey + prop 去重
CAP-4.3 position capability 明确坐标系
CAP-4.4 data/axes/figure 坐标使用独立转换器
CAP-4.5 legend 只移动 container，不移动内部 children
CAP-4.6 tick label 不开放自由 position，继续使用 tick_pad/dx/dy
CAP-4.7 annotation 绑定 text 与 arrow 的移动策略
CAP-4.8 确认作为一个 PatchPlan，取消恢复全部目标
```

拖动过程仍只做 SVG 临时预览，松手只记录最终参数，不连续调用 renderer。

### Phase 5：复杂图元能力增强

优先顺序：

1. legend container、title、text、marker、line、patch 的关系绑定。
2. colorbar container、label、tick 和 heatmap/mappable 绑定。
3. annotation text、arrow、anchor 和 coordinate space。
4. axis frame、四边 spine、tick line、grid 的独立语义。
5. line、scatter、bar、errorbar、boxplot、violin 的 seriesKey。

每新增一种对象必须同时完成：

```text
renderer 识别
identity
属性能力
前端分类
target resolver
patch 写回
重渲染验证
Python/R 能力矩阵更新
```

只完成前端面板不算能力完成。

### Phase 6：多子图布局增强

布局中心统一处理：

```text
Figure 画布尺寸
axes 绘图区 bounds
外边距
wspace/hspace
colorbar 占位
固定绘图区物理尺寸
子图交换和局部扩宽
原图布局恢复
```

布局操作必须生成独立 layout intent，不能复用普通 position patch。

保护规则：

- 紧凑/标准/宽松只改变间距，不改变用户选择的行列。
- 子图交换只交换位置，不交换数据、样式、历史身份。
- 原图布局只恢复几何，不覆盖字体、颜色、线宽等编辑。
- 修改画布时明确“缩放全图”与“固定 axes 物理尺寸”两种模式。
- 检测并提示 `tight_layout`/`constrained_layout` 对手动 bounds 的覆盖风险。

### Phase 7：R/Python 能力对齐

目标不是数量对齐，而是前端声明真实、操作结果可预测。

对齐顺序：

```text
标题/轴标签/tick 样式
legend/guide
离散 scale 和系列颜色
heatmap/continuous colorbar
facet panel 与 strip
text annotation
layer 线、点、填充
```

R facet 独立 bounds、第三方 grob 和 base R 对象在无法稳定写回时继续标记 `conditional/unsupported`，不得为了表面对齐开放无效控件。

### Phase 8：性能与可观测性

先增加分段指标：

```text
queueMs
containerStartMs
scriptExecutionMs
introspectionMs
svgSerializeMs
persistMs
networkMs
browserParseMs
totalMs
cacheHit
```

然后按证据优化：

1. 保证只重绘受影响 Figure。
2. 合并同一 Figure 的重复未开始任务，只保留最新 revision。
3. 复用现有 render cache，增加命中率和失效原因。
4. 缓存数据 staging 指纹，避免重复复制和解析。
5. 预热 renderer 镜像和字体缓存，但不复用不可信用户进程。
6. 大 SVG 延迟加载图层面板和非活动 Figure，不移除图元语义。
7. 批量导出进入受控队列，不与交互式编辑抢占全部 renderer。

性能门槛使用固定 fixture 比较：

```text
选择和属性面板响应不明显退化
拖拽预览保持连续且不触发后端请求
热缓存重复 patch 比冷启动更快
只改 Figure 2 时 Figure 1/3 不出现 rendering 状态
相同功能修改后的总耗时不得无解释恶化超过基线
```

## 7. 回归保护策略

### 7.1 增量协议，不破坏旧项目

- 新字段全部先设为 optional。
- `schemaVersion` 升级时 normalizer 同时接受 1.0 和 1.1。
- 旧项目缺少 identity/capability 时走现有兼容路径。
- 不批量迁移用户项目文件，不修改 `data/`。

### 7.2 影子比对，不直接切换

身份、目标解析和 PatchPlan 均先在 shadow mode 运行：

```text
旧结果
vs
新结果
```

只记录对象集合、作用域和 patch 差异，不影响用户结果。差异经过 fixture 和真实项目确认后，再按入口逐个切换。

### 7.3 功能开关按能力域拆分

推荐独立开关：

```text
objectIdentityV2
targetResolverV2
draftTransactionV2
dragCoordinatesV2
layoutPlanV2
renderTimingsV2
```

不要使用一个总开关一次切换全部编辑功能。发生回归时只回退对应能力域。

### 7.4 错改零容忍

验收优先级：

```text
错改其他对象 = 失败
修改目标不完整 = 失败或部分通过
不确定目标被安全跳过并提示 = 可接受
控件看起来可用但重渲染无效 = 失败
```

平台宁可明确跳过，也不能静默猜测。

## 8. 测试门槛

### 每个阶段的基础门槛

```text
npx tsc --noEmit
npm test
npm run build
```

### 编辑协议修改

```text
npm run test:semantic-smoke
npm run test:multisubplot-smoke
npm run test:cross-figure-smoke
npm run test:component-kind-matrix
npm run test:r-semantic-smoke
```

### 拖拽和布局修改

```text
npm run test:drag-extended-smoke
npm run test:behavior-smoke
```

并增加真实浏览器检查：

```text
连续拖动三个不同文本
多选三个以上对象一起拖动
取消后全部恢复
确认后重渲染位置与预览一致
切换 Figure 后 pending drag 不串图
```

### 保存、历史和导出修改

```text
npm run test:export-matrix-smoke
npm run test:project-history-persistence
npm run test:user-isolation
npm run test:code-history-smoke
```

人工验证：

```text
修改 -> 应用 -> 保存 -> 退出 -> 刷新
撤销 -> 重做 -> 保存
第一次导出 -> 修改 -> 第二次导出 -> 定位导出锚点
主图与子图格式一致
```

### 性能修改

```text
npm run test:cache-smoke
npm run test:cross-figure-concurrency
npm run test:render-performance
```

性能测试必须保留沙箱和相同 fixture，不能用关闭 Docker 或删除内省作为“优化结果”。

## 9. 第一实施批次

第一批只做基础增强，不改变用户编辑结果：

```text
1. 新增固定 fixture 和当前 manifest/patch 基线
2. 给协议增加 optional identity/capability 字段
3. Python/R 以 shadow mode 输出新字段
4. 新增 manifest identity validator
5. 新增 targetResolver 纯函数和单元测试
6. 比较旧编译器与新 resolver 的目标差异
7. 生成报告，不切换 RightSidebar 和 ChartPreview
```

第一批明确不做：

```text
不改现有后端 patch API
不改用户保存格式
不移除旧 gid/editable
不一次性重构 App.tsx
不切换拖拽坐标实现
不开放新的 R unsupported 控件
不修改用户数据
```

完成第一批后，再根据差异报告决定先切换字体中心还是组件中心。推荐先切换字体中心，因为其目标角色更明确，风险低于配色和布局。

## 10. 完成定义

本专项不能以“页面上出现新按钮”作为完成。完成必须同时满足：

```text
图元身份在重渲染后稳定
所有编辑入口使用同一目标解析规则
批量修改不会只改第一个或误改其他组
多目标拖拽可累计、取消和准确重放
复杂 legend/colorbar/annotation 有明确关系和能力声明
布局修改不覆盖字体颜色等独立编辑
R/Python 前端能力声明真实
失败不丢草稿，保存刷新结果一致
只重绘受影响 Figure
性能有分段指标和可重复基线
全部自动测试和真实项目矩阵通过
```

在这些证据齐全前，应将状态写为“阶段完成”或“部分覆盖”，不能写成“平台所有图元能力已完整实现”。

## 11. 实施进度

### 2026-07-11：第一批 shadow 基础完成

已实现：

```text
ManifestObject 增加 optional identity/propertyCapabilities
StandardFigureModel 保留并透传新增字段
Python renderer 为全部对象输出 style-independent instanceKey/semanticKey
R renderer 为全部对象输出同结构 shadow metadata
Python/R 为每个 editable 属性输出属性级 capability
manifest identity validator 和重渲染 identity comparison
严格 subplot 归属的 shadow target resolver
旧 compiler 与 shadow resolver 的 patch target 差异报告
figure-level legend 不再被 shadow resolver 按数字后缀归入 subplot
重复 instanceKey 进入 ambiguous，不选择任意目标
```

本批次没有切换：

```text
RightSidebar 仍使用现有 EditingIntent 编译路径
ChartPreview 仍使用现有拖拽路径
/api/figure/patch 请求结构未改变
项目保存格式未迁移
旧 gid/editable/currentProps 未删除
```

附带修复：

```text
修复 semantic_scanner 在部分 Python AST 版本中把 ast.Constant 对象写入字典 paletteId 的问题，避免 Weak/Mixed 等字典配色系列错误绑定。
```

验证结果：

```text
npx tsc --noEmit                                      PASS
npm test                                              PASS (10 files / 74 tests)
npm run build                                         PASS
python tests/test_introspection.py                    PASS (26 tests)
python tests/test_r_renderer.py                       PASS (18 tests)
```

已知非阻断构建警告保持不变：

```text
主前端 chunk 大于 500 kB
server CJS 构建中的 import.meta warning
```

下一批应先把 shadow 差异报告接入无副作用的开发诊断输出，并用固定真实 fixture 收集差异；在证据完成前，不切换字体中心、组件中心、配色中心或拖拽路径。

### 2026-07-11：第二批 shadow 诊断与 Draft 事务完成

已实现：

```text
target resolver shadow 诊断接入 RightSidebar 编译入口
诊断默认关闭，仅 VITE_SCIFIGURE_TARGET_RESOLVER_SHADOW=1 时运行
诊断不记录 operation value、文本内容或用户数据
Draft 应用不再在请求前清空
每个 Figure job 记录实际消费的 draft keys
全部成功后才清除对应草稿
部分失败保留 pendingFigureIds，仅重试失败 Figure
stale response 按失败结算，不误清草稿
请求期间用户写入的新草稿不会被旧请求结算覆盖
保存动作不会吞掉等待失败重试的 local draft
暂存条直接展示“上次应用部分失败，仅待重试：fig_n”
local patch 改为 API 成功后再提交运行时 SVG/manifest/history
```

附带稳定性处理：

```text
移除 Navbar 对 i.pravatar.cc 的外部头像依赖，改用本地 UserRound 图标
更新跨图 smoke，使子图边框组和网格线保持独立语义
导出 smoke 增加真实认证，当前服务端代码下主图/子图 PNG 格式一致
```

关键浏览器事务证据：

```text
第一次应用全部图：fig_1、fig_2、fig_3 均发起请求
注入 fig_2 一次性 500：fig_1/fig_3 成功，草稿保留
第二次应用全部图：只请求 fig_2
fig_2 成功后：草稿清除
```

验证结果：

```text
npx tsc --noEmit                         PASS
npm test                                 PASS (12 files / 84 tests)
npm run build                            PASS
npm run test:semantic-smoke              PASS (6/6)
npm run test:cross-figure-smoke          PASS (8/8)
npm run test:r-semantic-smoke            PASS (5/5)
npm run test:export-matrix-smoke         PASS (12/12，当前代码独立服务 + 认证)
```

仍未切换：

```text
shadow target resolver 尚未成为正式目标解析器
拖拽仍使用现有坐标和确认路径
复杂 legend/colorbar/annotation 尚未迁移到属性级 capability 控制
```

### 2026-07-11：第三批字体中心受控迁移完成

本批次只迁移字体中心，不切换组件中心、配色中心、布局中心、跨 Figure 映射或拖拽路径。

已实现：

```text
targetResolver 增加严格 patch 编译接口
严格编译以 propertyCapabilities 的属性和作用域交集决定目标
严格编译直接采用 renderer 声明的 patchMode
旧 manifest 缺少 instanceKey 或 propertyCapabilities 时整次操作回退旧编译器
重复 instanceKey 保持 ambiguous 并跳过，不允许回退旧规则猜选
figure-level legend 不通过数字后缀归入 subplot.0
字体中心通过独立 VITE_SCIFIGURE_FONT_TARGET_RESOLVER_V2 开关接入
开关关闭时字体中心行为与原链路一致
字体中心产生的 patch 继续携带 EditingIntent，并继续进入现有 Draft/历史/逐 Figure 调度
```

严格迁移保护规则：

```text
协议缺失 -> legacy fallback，保留旧项目可编辑性
协议完整且目标唯一 -> strict compile
协议完整但身份重复 -> skip，不执行 legacy fallback
目标属性存在但当前作用域未授权 -> skip unsupported_scope
目标属性未声明 -> skip unsupported_prop
严格 resolver 返回空或歧义时不自动扩大选择范围
```

测试基础设施同步：

```text
新增共享 Playwright capability smoke 认证工具
Python/R/多子图/跨 Figure smoke 使用隔离测试账号
测试账号只创建并清理各自名称前缀的测试项目
修正多子图测试对“图例线条”和“数据线条”的模糊卡片定位
开发服务器 HMR 端口冲突继续作为测试噪声忽略，不掩盖业务 console error
```

验证结果（在独立 3001 当前代码服务上开启字体 resolver v2）：

```text
npx tsc --noEmit                         PASS
npm test                                 PASS (12 files / 91 tests)
npm run build                            PASS
python tests/test_introspection.py       PASS (26 tests)
python tests/test_r_renderer.py          PASS (18 tests)
npm run test:semantic-smoke              PASS (6/6)
npm run test:r-semantic-smoke            PASS (5/5)
npm run test:multisubplot-smoke          PASS (4/4)
npm run test:cross-figure-smoke           PASS (8/8)
```

已证明的关键行为：

```text
Python/R X 轴刻度字号仍写入 axis.x.0/tick_labelsize
选定 subplot.0 时只生成一个 axis.x.0 字体 patch
数据线卡片修改 subplot.3 时命中 line.3.0，不命中 legend_line.3.0
跨 Figure 应用只调用逐 Figure patch，不调用项目全量 render
单图字体样式应用到 2x2 Figure 时准确扇出四个 axis.x.*
内容编辑仍禁止跨 Figure 传播
部分失败后只重试失败 Figure，草稿成功后才清除
字体迁移没有破坏组件、配色、保存刷新和语义应用结果面板
```

下一批迁移门槛：

```text
先扩展 targetResolver 对组件容器/子对象关系的严格 fan-out 测试
组件中心第一步只迁移 spine_group、grid、data_line 和 legend_marker
明确 legend_marker 与 data_line 永不进入同一目标集合
组件中心仍使用独立开关，禁止与字体中心共用一个总开关
真实 2x2、2x4、共享图例和 errorbar fixture 全部通过后才允许默认开启
```

### 2026-07-11：第四批组件中心首组对象受控迁移完成

本批次只覆盖以下组件角色：

```text
axis_frame：spine_group 或独立 spine
grid：网格线
data_line：真实数据线/拟合线
legend_marker：图例内部示例线、点和色块
```

仍未迁移：

```text
散点与 collection
errorbar/boxplot/violin 容器
bar/patch
axes tick 系统
legend container
heatmap/colorbar
subplot/layout
```

已实现：

```text
组件中心增加独立 VITE_SCIFIGURE_COMPONENT_TARGET_RESOLVER_V2 开关
仅四类已迁移对象通过严格 resolver 编译
其他组件继续使用原 compileEditingIntent 路径
组件 intent 在新开关下携带明确 targetRole
跨 Figure data_line retarget 不再只依赖 kind=line
legend_marker 与 data_line 在源 Figure 和目标 Figure 都保持角色隔离
边框组使用 axis_frame，不与 grid 混合
旧 manifest 协议缺失时仍按整次操作回退旧编译器
重复身份与能力作用域不满足时继续跳过，不猜测目标
```

新增自动证据：

```text
严格 resolver 即使请求同时包含 line.* 和 legend_line.*，data_line 也只生成 line.* patch
4 个 spine_group.* 批量修改生成 4 条 patch，grid.* 为 0
legend_marker 和 grid 分别使用独立角色与 patchMode
跨 Figure 浏览器操作共生成 6 条数据线 patch：fig_1 1 条、fig_2 1 条、fig_3 4 条
同一次跨 Figure 数据线操作中 legend_line.* patch 数量为 0
2x2 单子图作用域继续只修改 line.3.0
R 数据线仍准确写入 r.layer.1/linewidth
```

验证结果（独立 3001 当前代码服务，同时开启字体/组件 resolver v2）：

```text
npx tsc --noEmit                         PASS
npm test                                 PASS (12 files / 94 tests)
npm run build                            PASS
npm run test:semantic-smoke              PASS (6/6)
npm run test:r-semantic-smoke            PASS (5/5)
npm run test:multisubplot-smoke          PASS (4/4)
npm run test:cross-figure-smoke           PASS (9/9)
```

下一批建议：

```text
先迁移配色中心的 seriesKey/Binding 精确目标，不直接切换全部 palette 操作
优先覆盖单系列、同色不同语义系列、字典 palette 和跨 Figure 颜色应用
明确“修改数据系列颜色”和“修改图例符号颜色”是否联动，由 binding 声明而不是 kind 推断
准备 Weak/Mixed 同色或相近色 fixture，证明只修改指定语义系列
```

### 2026-07-11：第五批配色中心精确 Binding 受控迁移完成

本批次继续保留原有 palette、group、binding、code_patch 和 Draft 结构，在 Binding 上增量增加逐目标事实：

```text
targetMode：exact / semantic / conditional / ambiguous / unresolved
targets[].gid
targets[].prop
targets[].instanceKey
targets[].seriesKey
targets[].match
targets[].confidence
warnings[]
```

兼容字段继续保留：

```text
paletteId
groupId
gids
props
```

Python binding engine 升级：

```text
优先使用“精确标签 + 精确颜色”绑定
不再使用 Weak 包含 Weak response 一类模糊子串标签匹配
同一 palette 的 line/color 与 patch/facecolor 分别记录目标属性
同色但不同标签的 Weak/Mixed 分别生成无交集目标集合
多个 palette 同时缺少语义且颜色相同 -> ambiguous，gids/targets 为空
多个 palette 的精确标签和颜色签名完全相同 -> ambiguous
只有颜色全局唯一且没有标签命中时才允许 conditional 颜色绑定
Binding 记录 renderer 生成的 instanceKey 和 seriesKey
```

R binding 升级：

```text
manual scale 每个键生成 scale_key exact target
color/fill 分别绑定 color/facecolor
Binding 记录 r.group.* 的 instanceKey 和 seriesKey
R 配色仍走 backend object patch，不伪造 Python code_patch
```

前端受控接入：

```text
新增 VITE_SCIFIGURE_PALETTE_TARGET_RESOLVER_V2 独立开关
严格模式读取同一 paletteId 的全部 bindings，不再只使用 bindings.find() 第一项
逐目标使用自己的 prop，不再把 props[0] 应用给全部对象
绑定中的 instanceKey/seriesKey 与当前对象不一致时跳过
重复 instanceKey、ambiguous binding 不执行对象级颜色 patch
旧 manifest 缺少 targets/targetMode 时自动回退原 binding 逻辑
“仅修改已选”只允许命中 binding targets，并显式禁止跨 Figure
Python 整组修改仍按唯一 target_id 修改代码常量，gids 改为严格影响对象
Python binding 歧义时允许只修改明确代码常量，但不宣称影响对象
R binding 歧义时阻止修改
UI 显示精确绑定、条件绑定或绑定歧义
```

同色真实浏览器证据：

```text
Weak 与 Mixed 初始颜色均为 #446688
Weak binding：legend_line.0.2 + line.0.1
Mixed binding：line.0.2
两个目标集合交集为 0
修改 Weak 后 code_patch.target_id = dict_SERIES_COLORS__Weak
Weak 变为 #22aa66
Mixed 保持 #446688
```

验证结果（三个 resolver v2 同时开启）：

```text
npx tsc --noEmit                         PASS
npm test                                 PASS (13 files / 100 tests)
python tests/test_introspection.py       PASS (30 tests)
python tests/test_r_renderer.py          PASS (18 tests)
npm run build                            PASS
npm run test:semantic-smoke              PASS (8/8)
npm run test:r-semantic-smoke            PASS (5/5)
npm run test:multisubplot-smoke          PASS (4/4)
npm run test:cross-figure-smoke           PASS (9/9)
npm run test:export-matrix-smoke          PASS (12/12)
```

部署注意：

```text
前端开关开启前必须重新构建 Docker renderer 镜像。
旧 renderer 镜像只输出 gids/props，前端会安全回退，但不会启用精确 Binding。
不得只更新前端 bundle 后直接宣称配色 v2 已上线。
生产环境应先更新 renderer 镜像，再用固定 Weak/Mixed fixture 验证 manifest.targetMode/targets。
```

下一批建议：

```text
迁移散点、collection、errorbar、bar/patch 和复合容器的组件目标
为容器与 children 定义“样式联动”和“只改容器”的明确规则
之后再进入多目标拖拽坐标与 annotation/legend container 迁移
```

### 2026-07-11：第六批散点与复合容器受控迁移完成

新增语义目标角色：

```text
data_bar
data_errorbar
data_boxplot
data_violin
```

目标解析规则：

```text
bar_series/errorbar_series/boxplot_group/violin_group 优先于普通 line/collection/patch kind
同一编辑意图同时包含 container 和其 owned children 时，严格 resolver 只保留 container
只有不存在对应 container 时，旧 manifest 的系列 child 才作为兼容目标
data_point 排除 legend_marker
data_patch 不吸收已归属 bar/boxplot container 的 patch child
```

组件中心分组升级：

```text
柱形系列 -> BarContainer
误差棒系列 -> ErrorbarContainer
箱线图系列 -> BoxplotContainer
小提琴图系列 -> ViolinplotContainer
普通点/散点 -> 非 legend 的 collection 或 marker line
普通图形块 -> 未被 container 认领的 patch
```

容器存在时，组件中心通过 `children` 建立 claimed child 集合，并从普通线条、散点、误差线集合和 patch 分组中排除这些 child。该规则只在组件 resolver v2 开启时生效；关闭开关仍保持旧 UI 分组。

补齐的真实属性：

```text
ErrorbarContainer capsize 原先出现在 editable 中，但 renderer 没有读取/应用实现
现在读取 cap line markersize / 2
写回时设置 cap line markersize = capsize * 2
组件中心新增误差线宽、端帽长度、端帽线宽
箱线图新增箱体颜色和中位线颜色
柱形/小提琴容器使用各自 facecolor/edgecolor/linewidth/alpha
```

新增浏览器容器烟测：

```text
C0：4 个 container 共认领 27 个 children
C1：柱形线宽只提交 container.bar.0.0
C2：误差棒 capsize 只提交 container.errorbar.1.0
C3：中位线颜色只提交 container.boxplot.2.0
C4：小提琴线宽只提交 container.violinplot.3.0
所有 patch 数量均为 1，owned child gid 数量为 0
```

其它关键证据：

```text
散点大小只提交 collection.0.0，不提交 legend_collection.*
component-kind API 矩阵验证 14 个属性步骤和 container ownership
普通 collection 测试明确排除 role=legend_marker
Errorbar capsize 7 在重渲染 manifest 中稳定恢复
R renderer 没有上述 Python container 时继续使用原 layer 路径
```

验证结果：

```text
npx tsc --noEmit                         PASS
npm test                                 PASS (13 files / 102 tests)
python tests/test_introspection.py       PASS (30 tests)
npm run build                            PASS
npm run test:component-container-smoke   PASS (6/6)
npm run test:component-kind-matrix       PASS (14 patch steps)
npm run test:semantic-smoke              PASS (9/9)
npm run test:r-semantic-smoke            PASS (5/5)
npm run test:multisubplot-smoke          PASS (4/4)
npm run test:cross-figure-smoke           PASS (9/9)
```

仍未迁移：

```text
stem_container 和通用 container
heatmap/mappable/colorbar 的完整关系写回
legend container 与内部 children 的统一布局能力
annotation text/arrow/anchor
多目标拖拽坐标契约
```

### 2026-07-11：第七批热图、色条与图例容器关系升级完成

本批次不改变 patch API，不重写布局中心，重点把原先依赖几何位置和 gid 前缀的关系提升为 renderer 事实。

Python renderer：

```text
Colorbar.mappable -> identity.relation.mappableId
唯一 mappable 对应色条 -> heatmap identity.relation.colorbarId
mappable 所属 Axes -> colorbar identity.relation.subplotId
colorbar 顶层 subplotId 改为真实数据主图，不再使用色条 Axes 序号
source.axesIndex 保留原色条 Axes 序号
source.ownerAxesIndex 新增真实主图 Axes 序号
```

R renderer：

```text
r.heatmap.{kind}.{scaleIndex} 与 r.colorbar.{kind}.{scaleIndex} 使用同一连续 scale 索引
heatmap 输出 colorbarId
colorbar 输出 mappableId
关系写入 identity 后移除 renderer 内部临时字段
原有 R 专用 scale/guide patch 路径保持不变
```

前端关系消费：

```text
优先读取 colorbar identity.relation.subplotId
其次从唯一 mappable 的显式 subplot 关系解析
双向关系冲突、引用缺失或重复对象 -> invalid，禁止几何猜测
完全缺少新关系的旧 manifest -> 保留原几何兼容匹配
UI 分别显示明确关系匹配数量和几何兼容匹配数量
legend child 优先读取 identity.relation.legendId，gid 正则仅作兼容回退
组件严格角色新增 heatmap、colorbar、legend_container
legend container 修改不吸收内部 marker/line/text child
```

新增回归证据：

```text
Python 双热图/双色条：两组 mappableId/colorbarId/subplotId 无交叉
R heatmap/continuous guide：重渲染后双向关系仍存在
前端关系解析：冲突关系返回 invalid，旧 manifest 返回 absent
严格 resolver：单个 colorbar/heatmap 只生成自己的 patch
严格 resolver：legend container 只修改容器，不修改 legend child
拖拽 smoke 补齐隔离测试账号认证，不访问或清理真实用户项目
```

验证结果（三个 resolver v2 同时开启，独立 3002 服务）：

```text
npx tsc --noEmit                         PASS
npm test                                 PASS (14 files / 107 tests)
python tests/test_introspection.py       PASS (31 tests)
python tests/test_r_renderer.py          PASS (18 tests)
npm run build                            PASS
npm run test:component-container-smoke   PASS (6/6)
npm run test:component-kind-matrix       PASS
npm run test:semantic-smoke              PASS (9/9)
npm run test:r-semantic-smoke            PASS (5/5)
npm run test:multisubplot-smoke          PASS (4/4)
npm run test:cross-figure-smoke           PASS (9/9)
npm run test:drag-extended-smoke          PASS (7/7)
npm run test:export-matrix-smoke          PASS (12/12)
```

本批次后仍未完成：

```text
共享 colorbar 对多个 subplot 的显式多归属协议
Python colorbar label/tick 独立 child 对象
annotation text/arrow/anchor 关系与坐标契约
通用 stem/container 语义
性能分段指标和大 SVG 延迟解析
```

### 2026-07-11：第八批 Annotation、箭头与锚点关系升级完成

本批次保留现有文本 gid、拖拽开关、确认条、Draft/Figure 事务和 patch API，只补充 annotation 内部关系与独立样式目标。

Python renderer：

```text
text.{axesIndex}.{index} 继续作为 annotation 文本主对象
annotation_arrow.{axesIndex}.{index} 暴露 FancyArrowPatch 样式对象
annotation_text relation.annotationId 指向自身
annotation_text relation.arrowId 指向箭头
annotation_arrow relation.annotationId/textId 指回文本
currentProps.anchor_position 保存锚点 x/y/coord_system
position 只写文字端；anchor_position 只写指向端
普通 ax.text 和无箭头 Annotation 保持原 gid 与文本编辑路径
```

前端与目标解析：

```text
新增 annotation_text / annotation_arrow 语义角色
组件中心新增“标注箭头”，并从普通 patch 组排除 annotation_arrow
字体中心将 Python/R annotation 文本归入其它文本标注
属性面板提供锚点 X/Y/坐标系控件
position/anchor_position capability 仅允许 object scope
拖拽 pending patch 使用 sessionId + instanceKey 去重
annotation 拖拽只提交文本 position，不提交箭头 patch
关系目标进入 manifest identity validator
```

R renderer：

```text
GeomText/GeomLabel 输出 relation.annotationId
既有文本内容、字体、颜色和受控 position 写回不变
GeomSegment/GeomCurve 不按空间距离与文本配对
复杂 coord/scale 继续禁用位置写回并保留原因
```

验证结果（三个 resolver v2 同时开启，独立 3002 服务）：

```text
npx tsc --noEmit                         PASS
npm test                                 PASS (14 files / 108 tests)
python tests/test_introspection.py       PASS (31 tests)
python tests/test_r_renderer.py          PASS (18 tests)
npm run build                            PASS
npm run test:component-container-smoke   PASS (8/8，含 annotation 关系和箭头样式)
npm run test:drag-extended-smoke          PASS (9/9，含真实 annotation 拖拽)
npm run test:semantic-smoke              PASS (9/9)
npm run test:r-semantic-smoke            PASS (5/5)
npm run test:multisubplot-smoke          PASS (4/4)
npm run test:cross-figure-smoke           PASS (9/9)
npm run test:export-matrix-smoke          PASS (12/12)
```

仍保持受限：

```text
callable、offset points、混合 tuple transform 等复杂 Annotation 坐标不开放锚点写回
R 独立 text + segment/curve 不声明虚假父子关系
箭头形状、connectionstyle 和 mutation_scale 尚未进入稳定属性协议
共享 colorbar 多归属、通用 stem/container 和性能分段指标仍待后续批次
```

### 2026-07-11：第九批性能分段协议与前端 SVG 热点保护完成

本批次不修改 manifest 对象身份、gid、目标解析、patch 写回、布局计算或保存历史语义。先增加可解释的分段证据，再做不改变图形结果的前端重复工作消除。

Renderer 分段指标：

```text
Python 使用 time.perf_counter() 记录静态扫描、脚本执行、动态扫描、Figure 发现、编辑应用、图元内省、SVG 序列化和二进制导出
R 使用 proc.time()[["elapsed"]] 记录脚本执行、SVG 读取、manifest 构建和 SVG 语义后处理
保留顶层 timingMs，新增 timingBreakdown；错误响应也保留已采集的总耗时
指标不包含脚本、文本、路径、文件名或用户数据
```

Server 性能协议：

```text
新增 performance.schemaVersion = 1.0
renderer/runtime/server 分层，保留原 cache.hit/key
local/docker 分别报告 payloadStageMs、processMs、outputParseMs 和 totalMs
Docker withRenderSlot 报告真实 queueMs，不推测 containerStartMs
figure patch 额外报告 cacheLookupMs、persistMs 和 cacheWriteMs
缓存命中时 renderer/runtime 明确为 null，不伪造 0ms 渲染
R 在 Windows 上即使进程非零退出但已产生有效 JSON，仍保留 runtime 指标和既有警告
```

前端保护：

```text
ChartPreview 按原始 SVG 字符串 useMemo 缓存 sanitizeSvg 结果
选择图元、切换侧栏和拖拽状态变化不会重复清洗同一 SVG
组合代码项目的 Figure 缩略图使用 memo 化预览组件
非活动缩略图启用 content-visibility: auto 和稳定占位尺寸
DOM 保留完整 SVG、gid 和事件委托，不删除图元语义
data-svg-bytes / data-svg-sanitize-ms 只用于本地性能诊断
```

固定 fixture 性能证据：

```text
本地 Python：renderer 约 1.4-1.8s，进程 runtime 约 3.4-4.3s
本地 R：renderer 约 3.4s，进程 runtime 约 4.7s
Docker Python 热运行：renderer 约 0.6-0.75s，容器 runtime 约 4.3-5.5s
Docker R：renderer 约 3.5s，容器 runtime 约 5.6s
Docker 并发限制 2、同时 4 个任务：后两项 queueMs 约 4.8-4.9s，总墙钟约 10.9s
结论：当前主要成本在隔离进程/容器和依赖加载，不应通过削减图元内省或关闭沙箱换速度
```

验证结果（三个 resolver v2 同时开启，独立 3003 服务；Docker 探针使用独立 3004 服务和临时 overlay 测试镜像）：

```text
npx tsc --noEmit                         PASS
npm test                                 PASS (14 files / 108 tests)
python tests/test_introspection.py       PASS (32 tests)
python tests/test_r_renderer.py          PASS (19 tests)
npm run build                            PASS
npm run test:render-performance          PASS (local + Docker)
npm run test:cache-smoke                 PASS (miss/hit/changed)
npm run test:semantic-smoke              PASS (9/9)
npm run test:component-container-smoke   PASS (8/8)
npm run test:r-semantic-smoke            PASS (5/5)
npm run test:multisubplot-smoke          PASS (4/4)
npm run test:cross-figure-smoke           PASS (9/9)
npm run test:drag-extended-smoke          PASS (9/9)
npm run test:export-matrix-smoke          PASS (12/12)
```

验证边界与后续方向：

```text
Docker Hub 拉取基础镜像曾连接超时，因此本批使用本机既有正式镜像覆盖当前 renderer/ 代码完成沙箱验证
不引入复用不可信用户代码进程的常驻 Python/R worker
下一步先评估预构建镜像、字体/Matplotlib 缓存层和交互/批量任务队列隔离
共享 colorbar 多归属和通用 stem/container 进入下一批；更大 SVG 的浏览器内存基线仍待后续批次
```

### 2026-07-11：第十批共享 Colorbar 多归属与 StemContainer 升级完成

本批次继续遵循“renderer 提供事实、前端不按几何或 kind 猜测语义”。单色条、双独立色条、现有 heatmap、普通 line/collection 和旧 manifest 兼容路径保持不变。

共享 Colorbar 协议：

```text
Matplotlib Colorbar 从 cbar.ax._colorbar_info.parents 读取真实 owner Axes
单 owner 继续输出 subplotId，并增量输出 subplotIds=[subplotId]
多 owner 只输出 subplotIds，不伪造一个主 subplotId
source.ownerAxesIndices 保存全部 owner axes index；单 owner 继续保留 ownerAxesIndex
mappableId 继续指向实际 ScalarMappable；mappable 所在子图必须包含于 subplotIds
共享 colorbar identity.scope=container，几何属性不声明 subplot scope
```

前端解析与布局规则：

```text
resolveExplicitColorbarOwner 新增 resolved_shared，重复、缺失或冲突关系返回 invalid
Manifest identity validator 校验 subplotIds 唯一性、引用存在性和顶层/identity 一致性
布局中心按全部 owner subplot 的联合外框计算 colorbar left/bottom/height
交换单个子图时不移动共享 colorbar，避免把共享容器错误绑定到其中一个 panel
旧 manifest 完全缺少关系时仍允许原几何兼容匹配
```

StemContainer 协议：

```text
stem_container role=stem_series，children 显式包含 markerline、stemlines 和 baseline
children identity.relation.parentId 回指唯一容器
可编辑属性：stem_color、stem_linewidth、marker、marker_color、markersize、baseline_color、baseline_linewidth、baseline_visible、alpha
所有 stem container 属性使用 backend_patch，避免对不存在的单一 SVG 容器节点做虚假 local preview
新增 data_stem 语义角色；严格 resolver 优先容器并排除其 line/collection children
组件中心新增“茎叶图系列”，renderer propertyCapabilities 优先于旧 kind 白名单
旧 kind 白名单只作为没有能力声明的历史 manifest 兼容路径
```

浏览器错位保护证据：

```text
共享 colorbar 显示为 2 个 subplot owner，不产生单一 subplotId
“对齐全部色条”只提交 colorbar.4 的 left/bottom/width/height 四个 patch
共享色条对齐不提交任何 subplot patch
stem_linewidth 只提交 container.stem.* 一个 patch
stem 内部 line/collection child 不进入重复 patch
现有 bar/errorbar/boxplot/violin/annotation 各自仍只提交对应容器或箭头 patch
```

验证结果（三个 resolver v2 同时开启，独立 3003 服务）：

```text
npx tsc --noEmit                         PASS
npm test                                 PASS (14 files / 112 tests)
python tests/test_introspection.py       PASS (34 tests)
python tests/test_r_renderer.py          PASS (19 tests)
npm run build                            PASS
npm run test:component-kind-matrix       PASS (含 stem replay)
npm run test:component-container-smoke   PASS (12/12，含 stem UI 与共享 colorbar 布局)
npm run test:semantic-smoke              PASS (9/9)
npm run test:r-semantic-smoke            PASS (5/5)
npm run test:multisubplot-smoke          PASS (4/4)
npm run test:cross-figure-smoke           PASS (9/9)
npm run test:drag-extended-smoke          PASS (9/9)
npm run test:export-matrix-smoke          PASS (12/12)
```

仍保持受限：

```text
共享 colorbar 的 owner 事实依赖 Matplotlib 当前提供的 _colorbar_info.parents；缺失时只回退到可证明的 mappable owner
共享 colorbar 不参与单 subplot 作用域修改；用户需直接选中 colorbar 或使用布局中心
R ggplot continuous guide 目前仍按单 panel/guide 关系输出，不虚构 Python 风格多 owner Axes
更大 SVG 的浏览器内存、图层面板虚拟化和非活动 Figure 延迟解析仍待下一批
```

### 2026-07-11：第十一批大 SVG 前端渲染保护完成

本批次只处理浏览器侧交互性能，不改变 renderer 输出、manifest 对象、gid、identity、propertyCapabilities、patch 编译、保存历史或导出结果。核心原则是：完整语义对象仍保存在内存和协议中，UI 只减少当前可见 DOM 数量，避免大图项目因为调试表格或图层树一次性渲染过多节点而卡顿。

已落地保护：

```text
ManifestViewer 默认只渲染前 250 个 manifest object 表格行
ManifestViewer 可手动展开显示全部对象，完整 manifest 不被截断
ManifestViewer 支持按 id、角色、标签、文本、identity 和 kind 筛选完整对象集
LeftSidebar 每个树节点默认只渲染前 220 个直接子节点
LeftSidebar 对超过上限但处于当前选中状态的节点继续保留可见
LeftSidebar 的搜索、完整 flattenTree、shift 多选、显隐、锁定和 patch 仍基于完整 tree 数据
大图窗口和筛选逻辑抽为纯函数，单元测试锁定“不修改原对象列表”和“窗口外选中项保留”
ChartPreview 为 SVG sanitize 增加只读调用计数，便于证明选择操作不会重复清洗同一 SVG
```

不变项：

```text
不删除 manifest.objects
不删除 SVG gid 或 data-fig-id
不改变 selection / selectedGids 数据结构
不改变拖拽 overlay、patch 写回、Draft 批次、保存历史或导出
不把“未渲染在列表里”解释为“不可编辑”或“未识别”
```

本批浏览器验证：

```text
固定 fixture：620 个可编辑文本对象 + 1 个 subplot，共 621 个 manifest object
图层树默认仅渲染 220 个文本节点，并提示隐藏 400 个
第 599 个对象可通过搜索定位，清除搜索后因处于选中状态继续可见
选择图层和直接点击 SVG 图元均未增加 sanitize 次数
Manifest 默认渲染 250 行，可通过 semantic identity 搜索第 619 个对象
浏览器 page error 0，console error 0
```

后续继续补齐：

```text
记录固定 fixture 的 SVG 字节数、首屏渲染耗时、滚动帧响应和内存趋势
给 LeftSidebar 增加真正窗口化滚动，而不是只做 bounded rendering
非活动 Figure 的 SVG DOM 延迟挂载，但切换回来必须恢复完整选择、gid 映射和语义关系
增加多 Figure 大图切换回归，验证非活动 Figure 优化后语义完整
```

验证结果：

```text
npm test -- src/utils/largeFigureUi.test.ts   PASS (4 tests)
npm run lint                                  PASS
npm run test:large-figure-ui-smoke            PASS (8/8)
```

验证边界：

```text
本批次是前端 DOM 数量保护，不是 renderer 性能优化
本批次不能代替 Docker 沙箱、资源限制、R/Python 风险预检或真实云端性能基线
如果出现“搜索不到对象”或“选中后不可见”，应优先检查 bounded render 的保留规则，而不是修改 target resolver
```

### 2026-07-11：第十二批多 Figure 前端状态隔离完成

代码核查确认编辑器主画布原本就只挂载活动 Figure 的 `ChartPreview`，Figure 选项卡没有同时创建非活动 SVG DOM。因此本批没有增加重复的“延迟挂载框架”，而是补齐切换 Figure 时真正缺失的状态隔离。

发现的风险：

```text
selectedGids 原为 App 全局数组
不同 Figure 常复用 title.0、line.0、text.0 等 raw gid
切换 Figure 后，同名 gid 可能在新图中继续显示为选中
拖拽待确认状态只监听 renderedSVG；两张 Figure SVG 字符串相同时可能不清理会话
React StrictMode 会重复计算 useMemo，导致开发环境同一 SVG 被重复 sanitize
```

已落地增强：

```text
Figure 选择状态按 figureId 在前端会话内分桶
切换 Figure 时恢复目标 Figure 自己的 selectedGids，不复制来源 Figure 选择
manifest 更新后重新校验当前 Figure 选择，只保留仍存在的 gid
加载其他项目时清空旧项目的 Figure 选择桶
ChartPreview 的拖拽预览和待确认位置同时监听 sessionId 与 SVG，Figure 切换必定清理
活动画布只缓存最近一个原始 SVG 的 sanitize 结果，StrictMode 重算直接复用
缓存只保留一个 SVG，不长期保留多个大图副本
图层节点增加只读测试标识，不改变点击、选择或 patch 行为
```

不变项：

```text
projectFigures 中所有 Figure 的 manifest、editLog、revision、草稿和 SVG 数据保持完整
仍然只挂载一个活动 Figure 的 ChartPreview
切换 Figure 不发起 renderer patch，不增加历史，不修改 revision
Figure 勾选批量应用目标 selectedFigureIds 与图元 selectedGids 继续独立
同一 Figure 内的 Ctrl/Shift 多选、拖拽累计和属性编辑行为不变
刷新页面继续恢复当前活动 Figure 的现有 selectedGids；其他 Figure 的临时选择桶不作为持久业务数据保存
```

浏览器验证：

```text
3 个 Figure 使用重复 title.0 gid 和各自唯一 annotation gid
Figure 1 的 title.0 不会在首次进入 Figure 2 时被继承
Figure 2 选择独立 annotation 后，切回 Figure 1 恢复 title.0
再次进入 Figure 2 恢复其独立 annotation 选择
每次切换只对新的活动 SVG sanitize 一次
页面始终只有一个 data-svg-sanitize-count 预览节点
page error 0，console error 0
```

验证结果：

```text
npm run lint                                  PASS
npm run test:multi-figure-ui-state-smoke      PASS (9/9)
npm run test:large-figure-ui-smoke             PASS (8/8)
```

后续继续补齐：

```text
继续扩大大 SVG 基线并记录浏览器内存趋势
只有当前保护无法满足阈值时再升级为自定义 DOM 窗口化，保持 flattenTree 的 shift 多选顺序不变
```

### 2026-07-11：第十三批未确认拖拽切图保护完成

本批次补齐拖拽事务与 Figure 导航之间的边界。拖拽预览仍属于当前 Figure 的临时事务；在用户点击“确认位置”或“取消”之前，不允许导航动作隐式销毁它。

交互契约：

```text
ChartPreview 向 MainWorkspace 只上报 pending position patch 数量
上报内容不包含坐标值，不复制 patch，也不改变 Draft/历史所有权
pending 数量大于 0 时，点击其他 Figure 被阻止
Figure 导航旁显示当前未确认对象数量和处理提示
用户继续使用画布原有“确认位置”或“取消”按钮
pending 清零后提示自动消失，Figure 切换恢复正常
点击当前 Figure 不产生提示，也不改变选择或拖拽状态
```

安全边界：

```text
阻止切换不自动确认，不自动取消，不自动提交 patch
不使用浏览器 confirm 弹窗，避免阻塞 pointer 和渲染状态
不把 pending position patch 写入全局 project draft
不改变一次多目标拖拽只提交一次后端渲染的事务规则
组件卸载时主动上报 pending=0，避免离开编辑器后残留导航锁
```

浏览器验证：

```text
Figure 2 拖动一个 annotation 后出现“已累计移动 1 个文本对象”
点击 Figure 3 时切换被阻止，仍显示 Figure 2
Figure 导航显示未确认位移提示
点击取消后 pending 与提示同时清零
再次点击 Figure 3 可正常切换
page error 0，console error 0
```

验证结果：

```text
npm run lint                                  PASS
npm run test:multi-figure-ui-state-smoke      PASS (11/11)
```

### 2026-07-12 04:44:30 +08:00：Batch 17 复杂对象精准编辑阶段完成

本批采用显式 renderer 关系，不使用 SVG 距离或当前颜色猜测复杂对象归属：

```text
legend：容器、标题、文字和真实 handle 双向关联
colorbar：全部 mappable、全部 owner subplot 和子对象归属
twin/shared axes：对称 twin/sharedX/sharedY 关系
tick：tick line 与 tick label 样式目标分离
Target Resolver：默认启用，显式环境值 0 回滚
```

关键不变量验证：

```text
整组边框只生成容器 patch，不重复展开子 spine
tick line 改色不触碰 tick label
共享 colorbar 从任一 owner subplot 解析都不重复 patch
twin secondary axes 不计入物理布局 panel 数
单文本、数据线和图例对象不发生跨角色扩散
连续两个对象和三目标拖拽身份保持独立
跨 Figure 部分失败只保留并重试失败 Figure
```

验证证据：轴样式 5/5、复杂容器 15/15、语义中心 9/9、多子图 4/4、跨 Figure 9/9、扩展拖拽全部通过；TypeScript、129 个 Vitest、36 个 Python 内省测试、Python/R 能力矩阵、生产构建和差异检查通过。

剩余边界：任意第三方 annotation、嵌套 parasite axes、复杂真实共享轴和超大项目仍需按真实项目矩阵逐项放行，不因本批 fixture 通过而宣称全覆盖。

### 2026-07-12 05:09:45 +08:00：Batch 19 R 细粒度对齐阶段完成

本批将 R 的稳定语义从整 layer 扩展到可证明的 `layer + group + panel + aesthetic + scale + guide`：

```text
默认/显式离散 color/fill scale -> 独立 group 对象与单组 patch
group -> layerIds/subplotIds/aesthetic/scaleId/guideId/legendId
layer/legend -> groupIds 反向关系
heatmap/colorbar -> layerIds/subplotIds/scaleId/guideId/mappableIds
GeomText/GeomLabel -> layerId/subplotId/annotationId + conditional row identity
```

安全降级：重复颜色不能唯一映射时 SVG 保留 `r.layer.N`，scale/guide 对象不开放伪造的 subplot 写回范围；`coord_flip`、`coord_polar`、X/Y log scale 禁止位置近似；base R 和无稳定 ggplot 对象的输出只预览/导出并报告 unsupported。

验证结果：TypeScript、18 files / 130 tests、25 个 R renderer 测试、Python/R capability matrix、默认离散 scale 浏览器语义中心和生产构建通过。`ggnewscale`、任意第三方 grob、base R artist 编辑与 code patch 后文本行自动迁移仍在当前边界外。

#### 2026-07-12 12:32:39 +08:00 R5-C 增量

Batch 19 继续补齐可逆坐标和身份边界：`coord_flip` 与 X/Y log 使用 ggplot coordinate transform 和 scale inverse 精确重放；`coord_polar` 仅接受圆内可逆目标；显式唯一数据键生成稳定 text gid 并随 layer 重建保留。未知 geom 和重命名多 scale aesthetic 进入 readonly/unsupported，不生成猜测 patch。

增量验证：29 个 R renderer 测试、130 个前端单元测试、Python/R capability matrix、R 浏览器语义中心、扩展拖拽 smoke 和生产构建通过。`ggrepel`、`ggnewscale` 专用写回、地图投影与 base R artist 编辑仍需独立 adapter 和 fixture。

## 12. 下一阶段升级逻辑：能力增强列车

本节用于把“已有能力如何继续增强”转化为统一执行规则。后续不再以页面、组件或语言分别立项，而是以一个可证明的用户能力为一个升级单元。

### 12.1 单个能力的完整链路

每项能力必须沿同一条链路增强：

```text
真实 renderer 事实
-> 稳定对象身份与容器关系
-> 属性级 capability
-> 统一 Target Resolver
-> PatchPlan 预检
-> 当前 Figure 事务执行
-> 项目级持久化与历史
-> 导出/刷新重放
-> Python/R 和真实项目回归
```

只完成其中一层不算能力完成。例如：

```text
只有前端按钮，没有 renderer capability          -> 不开放
能够选中，但重渲染后对象身份变化                  -> 不开放
能够修改，但批量作用域会误扩散                    -> 不开放
能够渲染，但保存刷新后丢失                        -> 不开放
Python 通过但 R 声明同样支持却未验证              -> R 保持 unsupported/partial
```

### 12.2 每次升级的五个阶段

| 阶段 | 行为 | 用户影响 | 放行条件 |
|---|---|---|---|
| Baseline | 固定旧结果、manifest、patch、历史和性能样例 | 无 | 当前主链路测试和真实 fixture 可重复 |
| Shadow | 新协议、新 resolver 或新身份只生成诊断 | 无 | 与旧路径差异有明确分类，不记录用户敏感值 |
| Scoped Enable | 只对一个能力域或明确对象类型启用 | 小范围 | 错改为 0，unsupported/ambiguous 可解释 |
| Default Enable | 对满足新协议的对象默认使用新路径 | 正常 | Python/R 对应矩阵、保存刷新和导出通过 |
| Legacy Retire | 删除旧兜底或猜测逻辑 | 有迁移风险 | 旧项目已迁移或存在明确兼容适配器和回滚点 |

禁止从 Baseline 直接跳到 Default Enable。任何阶段出现错改、历史丢失、项目归属变化或坐标漂移，都必须回退对应能力域，而不是回退整个平台。

### 12.3 变更分类与最小验证集合

| 变更类型 | 典型文件 | 必须证明 |
|---|---|---|
| Renderer 内省 | `renderer/introspector.py`、`renderer/r_renderer.R` | gid/identity 稳定，旧对象数量不减少，Python/R 各自验证 |
| 目标解析 | `targetResolver.ts`、`editingIntentCompiler.ts` | 单对象不扩散、整组不漏项、歧义拒绝 |
| 属性/批量编辑 | `RightSidebar.tsx`、`App.tsx` | last-write-wins、一次应用一次历史、只重绘目标 Figure |
| 拖拽/坐标 | `ChartPreview.tsx`、renderer position patch | 多目标独立累计、缩放准确、确认/取消、重渲染不跳回 |
| 布局 | 布局中心、subplot bounds patch | 只改变几何，不覆盖字体、颜色、数据系列和 Figure 数量 |
| 保存/历史 | `db.ts`、`server.ts`、`App.tsx` | 保存刷新一致、session 清理不伤项目、项目数与归属守恒 |
| 性能 | scheduler/cache/SVG 展示 | 只减少重复工作，不减少语义、不关闭沙箱、不接受 stale response |

### 12.4 下一批能力顺序

#### Batch 15：项目归属与历史持久化保护

目标：把项目可见性、编辑历史和测试数据边界纳入能力回归，而不再只作为安全问题处理。

必须完成：

```text
legacy ownership 只允许显式配置目标账号
project_figures 独立保存 editLog/history
session 清理排除项目引用
项目替换和全图重绘保留 history
测试账号和 fixture 使用临时数据库
数据库迁移前备份、迁移后项目数守恒和 integrity_check
```

当前状态：代码修复、专项测试和持续集成门禁已完成；真实账号项目列表已恢复并完成数据库数量/完整性核对，仍需把“登录 -> 打开旧项目 -> 保存 -> 刷新 -> 历史恢复”作为发布前人工回归固定下来。

#### Batch 16：真实项目能力矩阵

目标：用脱敏副本或固定 fixture 覆盖当前最常见的科研图，不直接在用户真实项目上运行破坏性测试。

最低矩阵：

```text
Python：单图、多 Figure、2x2、2x4、共享 legend、双 heatmap/colorbar、annotation、twinx
R：ggplot 单图、多图、facet、manual scale、continuous guide、heatmap、annotation
通用：保存刷新、撤销重做、导出锚点、主图+子图导出、Word/A4 预览
```

每个 fixture 保存：对象身份摘要、能力摘要、关键 patch 结果和视觉截图，不保存用户原始路径、账号、代码全文或敏感数据。

当前已建立机器可读矩阵：

```text
tests/fixtures/capability_matrix/matrix.json
tests/test_capability_matrix.py
```

首批固定 fixture：

```text
Python：5 Figure、2x4 + Figure shared legend、双 heatmap/colorbar、annotation arrow、twinx
R：2x2 facet、heatmap/continuous colorbar、manual scale/legend、annotation text
```

统一验证：

```text
fixture 只能使用代码内合成数据
Figure 数量和关键 kind/role/object id 符合目录声明
同一 manifest 的 object id 和 instanceKey 不重复
editable 与 propertyCapabilities 一致
legend/colorbar/annotation 等关键 relation 指向正确对象
SVG 非空，Python/R renderer 均真实执行
```

当前状态：首批 5 个 Python + 4 个 R fixture 已通过，并已加入 GitHub Actions。浏览器层已在独立 `SCIFIGURE_DATA_DIR` 中验证：本地草稿保存持久化、SVG/PNG/PDF/TIFF、主图与子图同格式、导出资产库、渲染中导出阻断和编辑器 A4 旁览。A4 旁览已保留真实截图证据。尚未完成的矩阵项包括 R 多 Figure、保存后完整退出/重新登录恢复、全部 fixture 的视觉截图基线；这些不能因当前首批测试通过而标记为完成。

#### Batch 17：复杂对象精准编辑

按风险从低到高依次增强：

```text
tick line 与 tick label 分离
legend container/marker/text 对齐与缩放
colorbar 与一个或多个 mappable/owner subplot 关系
annotation text/arrow/anchor
twinx/twiny 和共享轴
```

每类对象独立 feature flag；不得用几何距离或当前颜色作为唯一身份依据。

#### Batch 18：坐标与布局统一

建立 data/axes/figure/display/container 的统一坐标转换契约，拖拽、轴标签整体平移、tick label 整体平移、legend 移动和 subplot bounds 共用同一基础转换，但保留各对象的写回规则。

布局增强顺序：

```text
局部间距和外边距
子图交换
目标子图对齐参考对象外沿
统一 axes 物理尺寸
固定绘图区模式下反算 Figure 尺寸
```

任何布局 patch 都必须只修改 geometry 属性；字体、颜色、editLog 中非布局项和数据系列 identity 必须保持不变。

#### Batch 19：R 细粒度对齐

R 不追求复制 Matplotlib artist tree，而是提高真实 ggplot 结构的可证明颗粒度：

```text
layer + group + panel + aesthetic identity
facet panel 归属和顺序
scale/guide/legend/colorbar 关系
GeomText/GeomLabel 位置能力
unsupported 坐标和第三方 grob 的明确降级
```

R 侧无法稳定回放的属性必须保持 readonly/unsupported，不能因为 Python 支持就自动显示同一控件。

#### Batch 20：性能与可观测性

先根据分段指标选择优化点：

```text
queue 高       -> 用户级公平队列和交互任务优先级
container 高   -> 镜像瘦身和安全预热，不复用不可信解释器
script 高      -> 数据 staging/Parquet/Arrow 和用户代码提示
introspection 高 -> 增量结构缓存，但不得减少对象覆盖
SVG 高         -> 一次 sanitize、非活动 Figure 延迟解析、图层窗口化
persist 高     -> 事务批量写入和合理索引
```

性能结果必须同时报告正确性测试、沙箱模式、冷/热状态和 fixture；单独报告“快了多少”不能放行。

### 12.5 回滚单位

回滚按能力域执行，不按整个平台执行：

```text
字体中心 resolver v2
组件中心 resolver v2
配色中心 resolver v2
annotation position v2
subplot layout v2
R fine-grained capability v2
large SVG optimization v2
```

旧 manifest、旧 gid 和旧 patch API 在迁移期继续可读。新字段缺失时只能回到已验证的兼容路径；若旧路径本身依赖猜测，高风险操作应禁用并提示，而不是静默回退。

### 12.6 每批完成报告

每个 Batch 完成时必须记录：

```text
改变了哪个用户能力
哪些对象和语言被覆盖
哪些对象仍 unsupported/partial
旧路径与新路径差异
自动测试、真实 fixture 和人工视觉结果
数据库/历史/项目归属是否受影响
性能变化及测试环境
feature flag 和回滚方式
```

只有上述证据齐全，才能把状态从“影子完成”改为“受控启用”或“默认启用”。

### 12.7 当前能力增强矩阵

下表是功能开发时的统一入口。它不重复罗列所有按钮，而是把平台已经具备的主链路、下一步增强方向、禁止破坏的行为和默认启用门槛放在同一张表中。

| 能力域 | 当前已具备基线 | 下一步增强逻辑 | 必须保持不变 | 默认启用证据 |
|---|---|---|---|---|
| 项目与数据 | 认证用户项目、Figure、文件、导出资产和项目历史持久化 | 补齐旧项目显式归属、项目级 editLog/history、测试数据库隔离和恢复校验 | 不删除 `data/`；不按账号顺序猜归属；项目数量和文件引用守恒 | 登录后旧项目可见；保存、退出、重新登录后恢复；跨用户访问失败；数据库 `integrity_check` 通过 |
| Python/R 渲染 | Python Matplotlib 与 R ggplot2 双 renderer，共用前端 Figure 协议 | 继续补真实对象 identity、relation 和 property capability；R 只对可证明能力开放编辑 | 不强行合并 renderer；Python 已有 patch 不因 R 对齐而变化；unsupported 不伪装成 editable | 同一前端操作分别通过 Python/R fixture；旧 manifest 可读；对象数和关键关系不退化 |
| 图元识别 | manifest、StandardFigureModel、稳定 gid、部分 container/relation | 优先增强 legend、colorbar、annotation/arrow、twin axes 和复合容器关系 | 前端不靠 SVG 距离或当前颜色臆造高风险关系；新增识别不能让旧对象消失 | 重渲染前后 instanceKey 稳定；关系双向一致；重复身份和歧义为 0；关键对象数量不减少 |
| 精准选择与属性编辑 | 单对象、角色组、子图、Figure 和跨 Figure 的 EditingIntent/Target Resolver 基础 | 所有字体、组件、配色和图层入口统一走同一 resolver，并输出 resolved/skipped/ambiguous | 单文本不扩散；axis label、tick label、tick line、spine 分离；整组不能只改首项 | 单对象错改 0；组目标不漏项；歧义默认拒绝；属性能力和作用域交集可解释 |
| 草稿与批量修改 | Draft Patch Batch、last-write-wins、一次应用一次渲染基础 | 升级为按 Figure 预检、执行、成功提交、失败保留和仅重试失败目标 | 请求前不清草稿；失败不写成功历史；同属性后写覆盖前写 | 全成功清除对应草稿；部分失败仅保留失败 Figure；一次批次只产生一个历史节点 |
| 拖拽与坐标 | 拖拽开关、最终位置累计、确认/取消、位置 patch | 固定 drag session identity，统一 data/axes/figure/display/container 转换，支持连续多目标 | 关闭拖拽仍可点击选中；第二个对象不能复用第一个身份；松手预览不能跳回 | 连续拖动至少 3 个对象；缩放 50%/100%/200% 位移一致；确认、取消、保存、重渲染和撤销一致 |
| 多子图布局 | 子图识别、bounds、重排、间距和物理 axes 尺寸基础 | 增强子图交换、局部扩宽、共享色条占位、对齐参考外沿和固定绘图区模式 | 布局 patch 只改 geometry；不覆盖字体、颜色、数据、Figure 数量和已有非布局 editLog | 交换前后内容身份保持；目标尺寸误差在导出单位容差内；原图回退只撤销布局变化 |
| 图例与色条 | legend/colorbar 基础识别、样式和部分位置编辑 | 建立 container-marker-text、mappable-colorbar-owner 的显式关系，统一符号缩放、文字对齐和间距 | 图例文字不能脱离符号；共享 colorbar 不得错误归属左上子图；配色不能按相同当前颜色串改 | 双热图、共享图例、共享色条 fixture 通过；目标容器和子对象作用域明确；导出结果一致 |
| 保存、历史与代码版本 | Figure revision、项目历史、撤销/重做、代码变更摘要和导出锚点 | 将 local/backend/code/layout 混合操作统一绑定成功 revision，并补完整退出恢复 | 只更新 SVG 不算保存；失败同步不入代码历史；导出标记不能漂移到最新步骤 | 保存后刷新视觉、script、editLog、revision 一致；撤销/重做同步恢复；每次导出锚定当时历史节点 |
| 导出与版面预览 | SVG/PNG/PDF/TIFF、主图/子图导出、资产库、A4/Word 预览 | 补导出进度、失败状态、真实插入尺寸与子图同格式一致性 | 导出中不能显示假完成；子图格式不能与主图不一致；预览不改变 Figure 数据 | 格式矩阵通过；导出资产可重新定位；A4/Word 尺寸和字体估算有固定 fixture |
| 多 Figure 调度 | per-Figure requestId、renderStatus、stale guard 和缓存基础 | 抽离统一 scheduler，合并同 Figure 重复任务，跨 Figure 批量使用受控请求池 | 修改一张图不重绘全部；旧响应不能覆盖新响应；失败 Figure 不阻塞其他已完成 Figure | 网络请求证明只包含受影响 Figure；stale 响应被丢弃；并发上限和部分失败状态可见 |
| 大图与性能 | 分段 timing、render cache、SVG sanitize 复用、图层 DOM 窗口和离屏渲染保护 | 根据 queue/container/script/introspection/SVG/persist 指标逐段优化 | 不通过减少语义对象、关闭沙箱、降低身份精度或删除图层来换速度 | 固定 fixture 冷/热数据可比较；正确性测试不退化；安全模式和测试环境一并记录 |

### 12.8 增强任务的变更判定规则

每个功能请求先判断它改变哪一层，再决定最小实现范围。若一个需求同时跨层，必须拆成可独立回滚的提交或功能开关。

```text
只改变展示方式
-> 允许改 UI projection
-> 禁止改变目标 gid、patch 数量、revision 和保存结果

改变可选对象或批量范围
-> 必须经过 Target Resolver
-> 必须输出 resolved/skipped/ambiguous
-> ambiguous 非 0 时禁止静默应用

改变属性或位置写回
-> 必须有 renderer capability 和 coordinateSpace
-> 必须验证重渲染、保存和撤销后的同一对象

改变布局
-> PatchPlan 只能包含 geometry 属性
-> postflight 必须比较非布局 identity/style/data 不变量

改变调度或性能
-> 必须先证明请求和缓存边界
-> 只能减少重复工作，不能减少语义、隔离或历史证据

改变持久化、账号或项目归属
-> 视为高风险变更
-> 必须使用测试数据库、迁移前备份和数量/引用完整性检查
```

统一停止条件：只要出现对象误改、坐标漂移、保存刷新不一致、历史节点丢失、项目归属变化、Figure 数量变化或安全隔离退化，该能力域立即停止向 Default Enable 推进。修复只回滚对应能力开关，不回滚用户已经保存的项目数据。

### 2026-07-11：第十四批大图离屏渲染保护与量化基线完成

本批没有直接重写层级树为自定义虚拟列表。原因是图层树包含展开关系、不同高度的文字副标题、同级拖动、shift 连选、显隐和锁定；未经量化直接扁平化会显著增加顺序错乱和选中错位风险。

采用的渐进策略：

```text
继续保留每个父节点最多 220 个直接子节点的 DOM 窗口
每个 TreeItem 分支启用 CSS content-visibility: auto
离开可视区的分支由浏览器跳过布局和绘制
使用 contain-intrinsic-size 提供稳定滚动占位
完整 tree、flattenTree、selectedGids 和 manifest 不改变
搜索仍针对完整 tree，不依赖当前已经布局的节点
```

这种方案属于浏览器原生离屏渲染保护，不宣称已经完成自定义 DOM 虚拟列表。是否继续做完整窗口化，改由固定性能阈值决定，而不是仅凭对象数量决定。

固定基线 fixture：

```text
manifest 对象：621
可编辑文本：620
SVG 字节数：67,882 bytes
默认图层 DOM：235 个节点
首个可交互画布：1,534 ms
滚动到底部双 requestAnimationFrame：22.1 ms
搜索第 599 个对象：39 ms
选择图层后新增 sanitize：0
点击 SVG 图元后新增 sanitize：0
page error：0
console error：0
```

当前放行阈值：

```text
621 对象 fixture 首个可交互画布 < 5,000 ms
默认图层 DOM <= 260
双帧滚动响应 < 250 ms
完整树搜索结果出现 < 1,000 ms
选择和点击不得重复 sanitize
```

升级到自定义 DOM 窗口化的触发条件：

```text
固定 fixture 连续三次超过滚动或搜索阈值
真实项目出现 2,000+ 同级对象且浏览器交互明显失速
content-visibility 在目标浏览器中不可用或出现滚动高度异常
能够先证明扁平行模型不会改变 shift 多选顺序、父子展开和同级拖动
```

验证结果：

```text
npm run lint                                  PASS
npm run test:large-figure-ui-smoke            PASS (12/12)
npm run test:multi-figure-ui-state-smoke      PASS (11/11)
```
