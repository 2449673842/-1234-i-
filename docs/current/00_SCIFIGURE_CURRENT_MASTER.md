# SciFigure Studio 当前主文档

> 状态：当前有效  
> 更新时间：2026-07-30 16:08:23 +08:00
> 证据截止时间：2026-07-30 16:08:23 +08:00
> 复核范围：生产 release `e35f4a4-jd22` 与隔离集成分支 `deploy/prod-integration-v3`；含 Python WP3-WP10 与 R-WP0-WP10 本地候选源分支能力；当前批次集成复验待完成，候选尚未部署
> 适用范围：产品定位、当前状态、优先级、验收口径与文档入口  
> 事实基准：当前工作区代码、最近可重复测试和专项状态文档

## 1. 文档体系

从本文件开始，SciFigure 的当前主要文档收敛为三份：

1. `00_SCIFIGURE_CURRENT_MASTER.md`：项目主文档，回答平台现在是什么、完成到哪一步、接下来先做什么。
2. `01_CAPABILITIES_AND_ARCHITECTURE.md`：能力与架构副文档，记录 Python/R、语义编辑、布局、拖拽、导出和渲染链路。
3. `02_SECURITY_DEPLOYMENT_AND_OPERATIONS.md`：安全与运维副文档，记录账号、数据隔离、沙箱、备份、管理员能力和云端上线门槛。

最新版本差异见 `04_LOCAL_3000_VS_WEB_UNIFIED_COMPARISON_2026-07-15.md`；`03_PRODUCTION_REGRESSION_AND_LOCAL_COMPARISON_2026-07-14.md` 保留为旧 build `eea68fb-jd7` 的历史回归证据。这些文件是带时间戳的专项报告，不增加新的主文档口径。

Free/Pro 待确认梯度见 `05_FREE_PRO_ENTITLEMENT_REVIEW_2026-07-15.md`。当前代码保持 `observe`，两档既有产品能力相同，未获得产品确认前不得启用额度拦截。

当前公网调试服务器基线为不可变 release `e35f4a4-jd22`。本地 `3000` 与网页统一版的全局导出资产库认证请求均已通过真实浏览器回归；重复发布默认使用受权限保护的国内优先镜像配置。

2026-07-16 网页统一版更新已部署：`7e33044-jd21` 上线编辑中心自动跟随、导出资产编辑快照与一键恢复、项目级导出独占锁，以及图例、散点、布局、框选、暂存和配色修复；`e35f4a4-jd22` 进一步修复后端 bundle/source map 暴露，建立 `dist/public`、应用拒绝和 Nginx 精确拒绝三层静态边界。

`docs/` 下其他文件继续保留，用于专项实现、历史决策、错误记录和恢复参考，但不再与这三份文档争夺“当前总口径”。

事实冲突时按以下顺序判断：

```text
当前代码和最新可重复测试
> docs/current/ 三份当前文档
> 最新专项审计或状态文档
> 历史计划、walkthrough、task 和旧升级方案
```

## 2. 项目定位

SciFigure Studio 是面向科研论文 Figure 的多来源图形编辑与投稿工作台。平台解决的核心问题不是“能不能画一张图”，而是：

```text
把来自 Python、R、不同数据文件和不同图形结构的结果，
整理成可识别、可编辑、可统一、可追踪、可导出的论文 Figure。
```

当前产品重点包括：

```text
项目和多 Figure 管理
Python/Matplotlib 与 R/ggplot2 渲染
图元内省和统一前端协议
文本、字体、颜色、线条、图例和坐标轴编辑
批量修改、草稿应用、撤销重做和保存
多目标拖拽与位置写回
多子图识别、布局和绘图区尺寸控制
科研格式导出、子图导出和 Word/A4 真实尺寸预览
跨项目 Figure 组合代码项目
账号、用户数据隔离和 renderer 沙箱
```

当前没有把网页 AI 自动改图作为已落地能力。组合代码项目可以生成给网页 AI 使用的提示词，但平台本身不执行 AI 改图。

## 3. 当前阶段结论

### 3.1 已达到的阶段

平台主链路已经具备可用基础：

```text
上传代码和数据
→ Python/R 渲染
→ 识别 Figure、子图和图元
→ 统一为前端语义对象
→ 单选、批量、字体中心、组件中心和配色中心编辑
→ 草稿合并后按 Figure 重绘
→ 保存、历史、撤销和导出
```

这表示平台已经从单纯“运行代码出图”进入“可视化编辑工作台”阶段，但不表示所有复杂图形、所有 R 对象和所有真实科研脚本都已完全覆盖。

### 3.2 当前工作重点

当前阶段不继续优先扩展绘图功能，主要顺序为：

```text
P0：用户数据安全、生产沙箱、备份恢复和云服务器上线准备
P1：真实 Python/R 项目矩阵回归和复杂图形稳定性
P2：渲染速度、队列、缓存和大文件性能
P3：管理员后台剩余页面/受控操作、更多编辑能力和 AI 接入
```

已购买 2 核 4 GB Ubuntu 24.04 调试服务器，统一编辑候选版已完成单机部署和公网 HTTP 健康检查。域名、可信 TLS、备份目标、恢复演练和完整云端渲染/隔离回归仍属于上线前阻断项。

生产当前仍运行不可变 release `e35f4a4-jd22`。Python/R 编辑升级在独立工作树 `prod-integration-v3` 中按功能提交边界移植，不能把工作树状态视为已经上线，也不得用候选整线覆盖生产认证、安全、资源限制或部署基线。部署前必须形成经过审查、测试、数据审计和备份的不可变制品。

### 3.3 工作区视觉基线

2026-07-12 已建立根目录 `DESIGN.md`，并完成登录后工作区第一阶段视觉升级：

```text
宣传页与工作区共享深墨绿、薄荷绿、暖金和中性科研灰视觉语言
工作区继续使用浅色高密度布局，不改造成营销页或卡片仪表盘
顶栏、应用侧栏、编辑器工具轨、首页和画布表面统一设计 token
保留原三栏结构、侧栏拖动宽度、SVG 命中、Draft、保存、历史和多 Figure 数据流
```

本阶段表示视觉基线已落地，不表示所有页面均已完成精细重构。项目、数据、导出、组合图和设置页仍需按 `DESIGN.md` 分阶段对齐。

编辑器最左工具轨已从纯视觉选中改为真实导航：项目资源和图层结构定位左栏，图层按钮同时聚焦搜索框，字体按钮切换右侧字体中心，导出资产和设置进入对应页面，历史按钮打开可用的项目历史菜单。

页面导航与导入流程已进一步收敛：导出资产返回按钮按真实来源页返回；编辑器“重新配置”进入已有项目的增量配置页，不再进入会清空项目身份的旧单文件导入页。新建项目支持脚本优先，平台先提取 Python/R 脚本引用的数据文件名，再提示补齐数据；用户额外上传的所有表格仍按原有契约进入 AI 提示词。

组合代码项目选择器 C1-C5 已于 2026-07-12 完成实现和阶段验收。当前支持来源项目搜索、项目类型与最近使用筛选、更新时间、Figure 缩略图和语义摘要、已选队列排序、`auto` 明确布局、物理尺寸预览、panel 位置映射以及重复、嵌套、版面和数据依赖检查。30 Figure fixture 已验证仅清洗可见区附近 SVG；Python/R 组合提示词按目标语言分别生成。详细状态和限制见能力架构文档第 13.1 节。

### 3.4 Python 编辑正确性保护（2026-07-20 08:41:21 +08:00）

本轮在保留既有编辑中心交互的前提下，补齐对象身份、三个复杂对象家族和 patch 持久化边界：

```text
新 patch 携带 stableKey / identity / v2 structural fingerprint
旧 manifest 不比较无版本的历史 fingerprint
missing、unsupported、identity mismatch 返回 conflict
冲突批次不增加 revision，不写 history、cache、导出锚点或快照
项目级代码 patch 检查全部 Figure 的有效 editLog，其他 Figure 冲突同样整批拒绝
全项目导出先预检全部目标 Figure，再统一进入资产和快照持久化
项目 Figure 路径以 propertyCapabilities.patchMode 为服务端权威
合法 local + backend 混合批次完整重放并只形成一个 revision
已完成家族使用专用 kind/role 和控件分组；未完成家族继续保持 Shadow/readonly
项目 PUT 保存 editLog/history 先按可信 manifest 预检，再单事务写入
现代 manifest 的 patch mode 由统一 capability helper 决定，跨 Figure 显式对象默认不 fanout
```

新隔离 E2E 已连续证明选择、Draft、整批应用、刷新、撤销/重做、导出、后续编辑和导出快照恢复。R semantic、跨 Figure、历史、导出、组合、安全、页面导航和数据审计均有对应基线证据。网络图、路径图和 SEM 只有在脚本通过平台注入的 `_scifigure_semantic_gid(...)` 显式声明对象关系时才进入专用语义；任意第三方 Artist 或没有关系声明的普通线、点、箭头和文字仍按通用能力处理，不按外观猜测。

独立代码审查发现的 standalone mode 权威、项目 PUT 侧门、跨 Figure replay warning、批量导出部分落库、contour 拖拽模式多选和保存 CAS 绕过均已修复。`test:patch-rejection-persistence`、`test:project-save-preflight`、`test:replay-warning-persistence`、跨 Figure 16/16 和组件浏览器 41/41 通过；最终复审没有 HIGH/MEDIUM 未解决问题。

WP8 已完成首轮收敛：导出快照先经 renderer dry-run，再在数据库事务内复核并发状态；错误恢复不会写入项目、session、history 或快照。导出文件创建和资产删除具备失败补偿，单 Figure v1 保持兼容，信息不足的旧多 Figure 快照安全拒绝。相关 API、数据库、UI、并发、文件事务和完整导出矩阵均已通过隔离回归。

WP6 已完成 `fill_between`、`contour/contourf`、`hist/stairs/step`、`pie/wedge`、`quiver/streamplot` 与网络图/路径图/SEM 六个复杂对象家族。前五个家族沿用已验证的专用父对象与关系模型；图示对象新增 `diagram_node`、`diagram_edge`、`diagram_arrow`、`diagram_node_label`、`diagram_coefficient_label`、`diagram_fit_annotation` 和 `diagram_group`，以 `diagramId/diagramObjectId/nodeId/edgeId/sourceNodeId/targetNodeId` 建立显式关系。平台只开放可证明的视觉样式；路径系数、p 值、显著性、拟合指标、边方向、节点身份和模型拓扑保持只读。

contour 的 `cmap/vmin/vmax` 按属性能力留在当前对象/Figure；只有属性在全部目标上明确声明 `cross_figure` 才允许 fanout。pie/wedge、向量场和显式图示语义均具备专用 identity/relation、组件分组、Draft/backend replay、跨 Figure 映射、导出和快照恢复；关系缺失、冲突或重复候选均 fail-closed。图示文本的初始 manifest 与重放身份统一使用真实文本标签，关系另由完整 signature 保护，已有部分 identity 不从新 manifest 回填。当前集成分支已重新通过向量场和网络/路径/SEM 的协议、renderer、API 与真实浏览器针对性门禁；WP7 特殊 axes 正在本分支集成，完整 release gate、性能、默认启用和剩余 legacy 审计仍待完成，不能据此宣布 Python 计划全部完成。

WP7 已完成当前固定运行时范围的特殊 axes 收敛。polar、3D、inset、secondary x/y axis 不再被当成普通二维 subplot；对象身份增加 `axesFamily/projection/parentSubplotId/ownerSubplotId`。polar 的可证明数据样式、标题和轴文字可继续编辑；3D 已接入 Z 轴标签和刻度字体；inset 与 secondary axis 保留可信父轴关系。parasite host/child、brokenaxes 占位分类、GeoAxes/Cartopy 和未知自定义投影默认只读或 unsupported，不开放相机、投影、布局和跨轴几何。当前固定测试环境未安装 Cartopy/brokenaxes，因此只能声明分类与只读降级代码存在，不能声明真实第三方包已完成支持。

导出编辑快照升级为 schema v3：新快照中的特殊轴 editLog 必须携带完整 relation；v1/v2 仅在 stableKey 与 v2 structural fingerprint 同时一致时兼容历史缺失 relation。`/api/figure/render` 和 `/api/projects/:id/figures/render` 现在同时核对返回 manifest 与 renderer warnings；任一新 editLog 目标缺失、属性不支持或关系身份不匹配时，不写 session、项目脚本、Figure、history 或 preview。只有数据库中已持久化且 stableKey 一致的旧 editLog 才能受控兼容；旧条目若已保存 fingerprint 或 seriesKey，对应字段也必须一致，gid-only 历史日志继续阻断。standalone 重渲染复用原 session；项目脚本与 figures/sessions 在同一数据库事务提交。

最新完整 Vitest 证据为 150 文件、1144/1144。WP5 能力摘要已覆盖对象类型、属性并集/交集/变体、只读/不支持/降级原因、科学影响属性和旧 manifest 补全；`test:capability-report-smoke` 验证部分可编辑、无对象和已识别但只读三种真实 UI 状态。renderer `unsupportedNotes` 和复杂对象内部 reason 不再原文展示，而转换为用户级限制提示。WP9 固定 Python 3.8.19 / Matplotlib 3.7.2 门禁现为 11/11：覆盖动态 seed、`random`/NumPy 模块别名、`default_rng(None)`、死分支 seed、布局诊断非阻断和宽松性能预算。诊断已随类型契约、StandardFigureModel、manifest、cache hit 和项目重开保留；两 Figure 隔离 smoke 证明不同 Figure 的布局警告不会串写。

2026-07-20 16:10 阶段补充：纯 local patch 后存储 manifest 暂时缺失时，下一次 backend 修改进入 renderer 权威验证，renderer 拒绝仍保持零持久化。线上 `spines['left']` 崩溃已确认来自旧镜像；当前仓库通用读取实际存在的 spine，并由 polar 回归覆盖。该时点完整 Vitest 为 148 文件、1127/1127，WP3-WP8 阶段独立复审为 APPROVE；这不是当前 WP9/WP10 最终复审结论。

生产部署只运行一套内容固定的 renderer 镜像，并锁定 Python、R、绘图库、字体和系统依赖。WP7 的固定测试启动器明确校验 Python `3.8.19` 与 Matplotlib `3.7.2`；本轮没有迁移到 Python 3.11，也没有把历史临时 Matplotlib 3.8.4 容器改成目标版本。当前仓库 `Dockerfile.renderer` 与依赖声明仍需在部署工作包中另行核对，本轮未修改运行服务或线上版本。

WP10 已达到当前计划范围的本地候选条件：普通编辑、字体、组件、配色和跨 Figure 统一从一个 feature-flag 合同读取；V2 默认开启，旧 compiler 和弱 score mapper 作为显式适配器保留。`VITE_*` 是构建时开关，逐域回退必须基于同一提交重建前端并部署新的不可变 release；重大错误优先原子切回上一整版，不能把修改服务器环境变量描述为即时生效。独立审查发现的 same-GID、非同 GID 和 App 跨 Figure Draft 编译旁路均已收敛到统一受控 resolver；稳定凭据冲突 fail-closed，多 Figure 诊断按 Figure 隔离，Shadow 证据按 release candidate 隔离。当前定向证据为 WP10 167/167、跨 Figure 18/18、WP9 11/11、组件 41/41、扩展拖拽 10/10、缓存、历史、导出事务、R 安全、用户隔离、renderer 沙箱、生产构建和数据审计均通过；最终独立 gpt-5.5 high 复审 APPROVE，0 HIGH/MEDIUM。当前候选未提交、推送或部署。

2026-07-21 兼容收尾：项目完整重渲染现在统一从 Figure、session 和受控单 Figure 旧 spec fallback 解析 durable editLog。已持久化的空文本/隐藏对象和旧轴字体属性可按当前 renderer 能力继续重放，但客户端不能以相同 `gid/prop/value` 弱化或伪造已知 `stableKey/fingerprint/identity`；任何差异均冲突且保持项目、session、history、preview 零写入。Matplotlib 文本统一走 backend renderer，文本键入即时进入当前 Figure Draft，改回已提交值会删除 no-op Draft；旧请求返回时不会清除期间产生的新文本。定向证据包括 `special-axes-api`、Python 完整语义工作流 B0E/B0F/B0G、RightSidebar/property mode 242/242、R semantic 5/5、patch rejection、lint、build 和 diff-check。当前改动仍未推送或部署。

2026-07-21 20:28 兼容门禁再收紧：旧 `line.visible` 不再因新 manifest 省略 capability 而阻断整个项目。只有数据库中已持久化且值与身份完全一致的历史记录可受控重放；当前导出快照升级为 v5 并保存服务端签名，签名前 v4 仍可恢复，缺少签名的 v5 必须拒绝且零写入。隔离 API 已用更敏感的隐藏线 `visible=false` 证明旧项目可打开、继续编辑、导出、后续编辑、恢复 v4/v5 快照和刷新，未保存的相反值仍冲突。旧项目全生命周期现已成为 Gate L，不得用新项目测试或 HTTP 200 替代。同一轮还修复明确子图中图例精确目标与 mixed scatter 颜色子集合并；`matchColor` 现会贯穿 Draft、应用请求和服务端压缩，连续两次 scoped 改色的真实浏览器请求均按当前颜色替换，不再覆盖 collection 内其它分组。普通 `axes.patch.N` 选中、`size_scale` 实际比例回读，以及支持 Escape/焦点返回的日志弹窗也已通过。当前仍未推送或部署。

2026-07-22 R-WP2/WP3 收敛：R layer 身份现在包含规范数据内容摘要，同列名的不同 subset/filter 不再静默复用旧样式；guide identity 同时区分 aesthetic、类型和标题；无显式键文本只有在 `panel+x+y+label` 唯一时才稳定重放，重复候选明确 unsupported。生产候选 Docker/Web 已固定 R 4.5.0、ggplot2 3.5.1、关键包、字体、locale 和 svglite；本地、直接 Docker 与 Web/API Docker 的 37 个关键语义对象及 SVG 根几何一致。镜像源码 SHA 不匹配时会结构化拒绝。R renderer 54/54，runtime diagnostics 6/6，独立复审 APPROVE、0 HIGH/MEDIUM。
## 4. 用户数据红线

本地 `data/` 中的数据库、项目、上传文件和导出资产是仍需使用的真实数据。

任何后续开发必须遵守：

```text
不得删除或清空 data/
不得用测试数据覆盖真实项目
不得自动迁移、重命名或重建用户项目目录
不得在没有可恢复备份时执行破坏性数据库迁移
不得把 data、数据库、用户代码或导出资产放入 Docker build context
不得把用户数据提交到 Git
不得为了测试方便直接清理真实项目
```

### 4.1 升级前后数据完整性门禁

任何涉及数据库、项目、Figure、session、上传文件、历史或导出资产的升级，必须在修改前后执行 `npm run data:audit`。当前审计覆盖：

```text
项目所有权与孤立记录
projects.file_count 与 project_files 实际数量
项目上传文件和导出资产的物理文件
project_figures 的 edit_log/history JSON
Figure 对应 session 是否存在且所有者一致
真实数据库中的历史测试账号警告
```

2026-07-12 发现并恢复了 23 个缺失项目数据文件和 78 个缺失 Figure session。文件恢复按同名、列结构、行数和候选 SHA-256 校验；session 恢复前创建 SQLite 在线备份。恢复后审计为 `0` 个数据错误。旧测试账号仅保留为警告，未删除任何账号或项目。

自动化测试统一通过 `scripts/testing/run_with_isolated_server.mjs` 使用临时 `SCIFIGURE_DATA_DIR` 和临时数据库。正式 `data/` 的数据库修改时间、大小和项目文件数量必须在隔离测试前后保持不变。

测试应使用临时 SQLite、操作系统临时目录或明确创建的测试项目，并在测试结束后只清理测试自己创建的内容。

## 5. 当前架构摘要

### 前端

```text
React 19 + TypeScript + Vite
项目/数据/编辑器/导出/组合图/设置等页面
StandardFigureModel 统一图形对象
EditingIntent 统一编辑意图
按 Figure 的 revision、requestId 和渲染状态
Draft Patch Batch 合并多项修改
```

### 后端

```text
Node.js + Express
SQLite + better-sqlite3
用户、会话、项目、Figure、文件、订阅、兑换码、导出资产和审计表
认证、所有权检查、限流、路径边界、任务调度和导出
```

### 渲染

```text
Python/Matplotlib renderer
R/ggplot2 renderer
生产 Docker 沙箱
禁网、只读、低权限、CPU/内存/PID/输出/超时限制
XLS/XLSX 独立 parser
SVG 到 PNG/PDF/TIFF 的受限转换
```

详细架构见 `01_CAPABILITIES_AND_ARCHITECTURE.md`，安全边界见 `02_SECURITY_DEPLOYMENT_AND_OPERATIONS.md`。

## 6. 当前能力状态

| 能力 | 当前状态 | 说明 |
|---|---|---|
| 公开宣传页与注册门禁 | 已实现，邮箱生产通道待配置 | 匿名访问先进入宣传页；启用邮箱验证后，新账号必须完成六位验证码验证才会获得会话；现有账号兼容迁移；安全文案隐藏内部防护细节 |
| 图形能力展厅 | 本地候选 | 作为帮助中心同级站内页面展示 11 个带能力边界的固定模拟数据样例，其中包含 LnRR 排序图和主项目结构 2 x 2 组合图；没有未经真实验收的样例被标为稳定支持 |
| Python 渲染与图元编辑 | 生产稳定，升级候选集成中 | 生产主链路保持不变；候选 WP6 六个复杂对象家族已有专用语义，其中网络图/路径图/SEM 依赖显式关系声明，不承诺按外观自动识别任意第三方图示；完成全部门禁和部署前不视为线上能力 |
| R 渲染与语义编辑 | R-WP0-WP10 本地候选已合入，当前批次待复验 | ggplot2 主链路、服务端 patch 权威、失败零持久化、identity v2、运行时 parity、复杂对象、scale/guide/facet、文本/复杂坐标、显式 diagram、扩展 Shadow 边界和完整用户链路已收敛。默认 V2 resolver、旧 R identity/editLog、候选镜像沙箱、安全、用户隔离、性能、缓存、构建和数据审计通过；当前批次总门禁完成前不标记为生产能力，生产人工视觉回归与旧路径退役未开始 |
| 多文件与多 Figure | 已实现 | Figure 数量按代码结果动态处理，不应写死三张 |
| 编辑器脚本拖放 | 本地候选 | `.py/.R` 可拖入新建项目脚本卡片、数据区、代码编辑区或完整编辑工作区；页面级接收继续可用，但视觉反馈限定在各分区内；成功后显示导入文件名，不支持的文件不会覆盖当前脚本 |
| 单图多子图识别 | 已实现 | 可按位置识别 subplot、轴框、文本、图例和色条 |
| 字体/颜色/线条编辑 | 已实现 | 支持单对象、语义分组、整图和跨 Figure 作用域 |
| 编辑中心子图跟随 | 已实现并部署 | 选择图元后组件、字体、布局和配色目标自动跟随其所属子图；跨子图多选安全回退到全部子图 |
| Draft Batch | 已实现 | 数值控件输入有效值后立即暂存，无需按 Enter；多项参数仍一次重绘 |
| 撤销、重做和保存 | 已实现 | 项目 PUT 已加入 revision/editLog hash CAS、旧项目恢复兼容和排队保存保护；仍需持续验证真实项目长会话 |
| 多目标拖拽 | 已实现并修复多轮 | 复杂 annotation、箭头和图例组合仍是高风险对象 |
| 布局与子图尺寸 | 已实现基础能力 | 包括重排、间距、画布和绘图区尺寸，复杂布局需实测 |
| Word/A4 真实尺寸预览 | 已实现 | 用于判断最终插入尺寸和可读字号 |
| 科研格式导出 | 已实现 | SVG/PNG/PDF/TIFF 路径已具备，需继续跑格式矩阵 |
| 子图同时导出 | 已实现 | 子图格式跟随主图，导出资产进入资产库 |
| 导出状态快照与恢复 | 已实现并部署 | 每个新导出资产原子绑定不可变编辑快照；恢复前校验账号、项目结构、脚本风险和数据集精确哈希，并先保存当前状态检查点 |
| 组合代码项目 | 已实现 | 可跨项目选择 Figure、复制数据并生成组合代码提示词 |
| AI 自动改图 | 未接入 | 当前只提供提示词和代码工作流，不执行 AI 修改 |
| 管理员后台 | Phase A、部分 Phase B、订阅修正切片已部署；本地隐私边界已加强 | 错误中心只接收结构化脱敏诊断，不返回报告者邮箱/内部指纹，也不读取用户脚本、数据、Figure 或导出内容；最新本地改动尚待发布 |
| Free/Pro 权益 | 观察模式 | 订阅状态和统一权益协议已具备，但 Free/Pro 暂不限制既有功能，梯度等待产品确认 |

## 7. Python 与 R 的统一方式

平台采用“两引擎一协议”，不是把 Python 和 R 强行合并为同一个 renderer：

```text
Python artist tree ┐
                   ├→ StandardFigureModel → EditingIntent → 统一前端
R ggplot/grob     ┘
```

前端统一：

```text
选择对象
属性面板
语义分组
草稿批量应用
历史和撤销
拖拽确认
按 Figure 调度
导出入口
```

引擎保留差异：

```text
Python 通过 Matplotlib artist、axes 和 transform 写回
R 通过 ggplot layer、scale、theme、grob 和专用 patch 写回
```

因此修复共享前端协议时可以同时受益，但 Python/R 内省和后端 patch 仍需分别测试。

## 8. 当前安全结论

本地代码已经具备：

```text
Argon2id 密码存储
短期 access token + HttpOnly refresh token rotation
access token 当前标签页存储、旧 localStorage token 自动迁移清除
默认 CSP Report-Only
可选强制邮箱验证码、验证码 HMAC 存储、过期/次数/单次使用限制
user_id 所有权隔离
数据库 admin 角色和管理审计
API、认证、渲染和管理接口限流
safeResolve 路径和符号链接边界
生产环境强制 Docker renderer
Python/R 禁网、只读、低权限和资源限制
R/Python 静态风险预检
XLS/XLSX 服务端解析隔离
CSV 流式元数据/预览、XLSX ZIP 解压预算、PNG/SVG 内容校验
50 MB 单文件硬上限、项目/账号/全平台存储上限、上传下载频率和原子化持久小时字节预算
管理员错误中心项目归属验证和内容最小化
Docker build context 用户数据排除
加密备份和恢复脚本
```

但平台现在仍不能仅凭本地代码宣布“可以安全公网生产”。以下事项必须在云服务器完成：

```text
系统盘和数据盘加密
防火墙、安全组、TLS 和 SSH 最小权限
生产密钥注入与轮换
Docker 沙箱 Linux 复测
真实 restic 备份和恢复演练
日志、监控和告警
CSP Report-Only 到强制策略
真实项目兼容矩阵后决定 AST/R enforce 强度
```

## 9. 性能与并发

当前本地出图通常为数秒到二十余秒，主要时间消耗在 Python/R 启动、脚本执行、图元内省、SVG 生成和 Docker 冷启动。

8 核 16 GB、10 Mbps 云服务器的初始建议：

```text
renderer 并发：4
单 renderer CPU：1 核
单 renderer 内存：1 GB
表格 parser 并发：2
同一用户并发渲染：1-2
超出任务进入队列
```

普通 SVG 和参数请求主要受计算限制；大 CSV、TIFF、批量导出和跨项目复制更容易受 10 Mbps 带宽影响。

性能优化优先顺序：

```text
只重绘受影响 Figure
合并多个属性修改后一次渲染
渲染结果和数据 staging 缓存
预热 renderer
任务队列和 stale response 丢弃
最后才考虑增加服务器数量
```

## 10. 当前优先级

### P0：上线前阻断

```text
保持本地用户数据完整
完成云服务器安全基线
部署加密备份并完成恢复演练
验证 Docker renderer 无宿主文件和网络权限
验证跨用户项目、文件和导出资产隔离
完成生产密钥和管理员账号准备
完成真实 Python/R 核心项目回归
把当前安全和渲染改动整理成可复现提交
修通并验证 Web 到 Docker renderer 的真实生产调用拓扑
```

### P1：稳定性

```text
复杂 legend/colorbar/annotation
Python 多 Figure、多子图和跨 Figure 批量修改
R facet、heatmap、连续色标和 layer 细粒度
多目标拖拽、保存、刷新、撤销和导出历史
全部科研格式与子图导出矩阵
```

平台能力增强按专项方案执行：

```text
docs/platform-capability/SCIFIGURE_CAPABILITY_EVOLUTION_AND_REGRESSION_GUARD_PLAN.md
docs/platform-capability/UNIFIED_EDITING_CENTERS_UPGRADE_PLAN.md
```

该方案采用增量协议、影子比对、按能力域切换和成功后提交，避免为了补图元识别或编辑功能而破坏现有选择、拖拽、保存和按 Figure 渲染链路。

`UNIFIED_EDITING_CENTERS_UPGRADE_PLAN.md` 专门处理属性编辑、布局中心、组件中心、配色中心和字体中心的交叉属性与精细度不一致。网页统一版已完成 PropertyDescriptor、capability projection、严格 resolver 和共同 Draft 语义的主要迁移；2026-07-16 候选继续补齐数值自动暂存、字体格式刷、选中子图自动跟随、图例间距、散点比例缩放和保持尺寸的垂直行间距。旧项目兼容路径和 legacy 控件尚未删除。

`PYTHON_EDITING_COMPLETION_EXECUTION_PLAN.md` 与 `R_EDITING_COMPLETION_EXECUTION_PLAN.md` 分别收敛两套 renderer 的对象身份、patch 事务、复杂图元和用户链路。两份计划共用前端协议和不可回退基线，但不把 Matplotlib artist tree 与 ggplot/grob 强行合并。R-WP0-WP10 已形成未部署的本地候选：R-WP5-WP9 的对象、用户链路、性能和资源边界已完成，R-WP10 重新证明默认 resolver、旧 R 项目兼容、安全隔离和候选 Docker 镜像合同。下一步是固定候选提交后的生产发布门禁，不是继续扩大未验证对象能力。

当前专项方案已补充“能力增强列车”：每项能力必须依次证明 renderer 事实、对象身份、属性能力、目标解析、PatchPlan、Figure 事务、项目级持久化以及 Python/R/真实项目回归。禁止从协议设计直接跳到默认启用。

专项方案第 12.7 节是当前功能开发的能力增强矩阵，第 12.8 节是变更判定规则。任何新增或增强需求都必须先标明影响层、保护不变量、默认启用证据和回滚单位；没有这些信息的任务只能进入 Baseline/Shadow，不能直接替换现有主链路。

下一批执行顺序（组合项目选择器 C1-C5、Batch 17 和 Batch 19 当前约定范围已完成；剩余主线为 Batch 18 与 Batch 20）：

```text
Batch 15：项目归属与历史持久化保护
Batch 16：真实 Python/R 项目能力矩阵
Batch 17：复杂 legend/colorbar/annotation/twin axes 精准编辑
Batch 18：拖拽坐标与多子图布局统一
Batch 19：R layer/group/panel/scale/guide 细粒度对齐
Batch 20：基于分段指标的性能与可观测性优化
```

Batch 17 已完成当前约定范围内的复杂对象协议和阶段回归：legend 容器显式关联标题、文字和真实 handle；共享 colorbar 显式关联全部 mappable 与 owner subplot；colorbar 子对象继承真实归属；twin/shared axes 输出对称关系；tick line 与 tick label 颜色独立。Target Resolver 已默认启用，显式环境值 `0` 可回滚。该结论不扩展为任意第三方 annotation、复杂共享轴和所有真实科研项目均已覆盖。

2026-07-12 04:44:30 +08:00 的验证证据包括：轴样式隔离 5/5、复杂容器 15/15、语义中心 9/9、多子图 4/4、跨 Figure 9/9、扩展拖拽全部通过；`npm run lint`、129 个 Vitest、36 个 Python 内省测试、Python/R 能力矩阵、生产构建和 `git diff --check` 通过。

Batch 19 已于 2026-07-12 12:32:39 +08:00 扩展完成当前稳定 ggplot2 语义范围：默认和显式离散 scale 均能按 group 独立编辑；`coord_flip`、X/Y log 和圆内 polar 文本位置可精确写回；具备唯一数据键的文本在代码重排后保持稳定 identity；未知 geom 和重命名多 scale 明确降级。验证包括 130 个前端单元测试、29 个 R renderer 测试、Python/R 能力矩阵、R 浏览器编辑、扩展拖拽和生产构建。该结论不包含 `ggnewscale/ggrepel` 专用写回、任意第三方 grob、base R artist 编辑或无稳定键文本的自动迁移。

其中 Batch 15 的本地代码修复已完成，但只有持续集成、真实账号项目列表和保存刷新回归均通过后，才能视为默认能力稳定。

平台能力不是等待服务器采购后才开始，而是与安全代码准备并行推进。当前按以下工作包连续增强已有能力：

```text
图元身份和容器关系：heatmap/colorbar、legend、annotation/arrow
精准改图：单对象、整组、子图、当前 Figure、跨 Figure 严格分层
多目标拖拽：固定 identity、独立坐标、最终参数批量确认
多子图布局：色条占位、交换、局部扩宽、固定物理绘图区尺寸
Python/R 对齐：统一前端协议，分别验证 renderer 写回
保存历史：成功后提交、部分失败重试、刷新恢复和导出锚点
渲染性能：按 Figure 重绘、缓存、任务合并、分段耗时和大 SVG 延迟解析
```

每个工作包都必须同时具备 renderer 事实、身份/关系、属性能力、目标解析、patch 写回、持久化和回归证据。只增加前端控件不算完成。

### P2：性能

```text
队列可视化
渲染耗时分位数
缓存命中率
大型文件和批量导出基准
Docker 镜像预热和依赖固定
```

### P3：后续能力

```text
管理员后台兑换码、备份/渲染指标和其余受控写操作
更多 R 图元颗粒度
更复杂布局和 publication template
AI 辅助改图
```

## 11. 验收基线

核心代码修改至少应验证：

```text
npx tsc --noEmit
npm test
npm run build
```

安全或渲染边界修改按影响范围增加：

```text
npm run test:security-baseline
npm run test:user-isolation
npm run test:auth-refresh
npm run test:admin-authorization
npm run test:r-security-precheck
npm run test:renderer-sandbox
npm run security:repo-boundary
npm run test:project-history-persistence
npm run test:capability-matrix
python tests/test_r_renderer.py
python tests/test_tabular_parser.py
```

涉及编辑器的修改还应运行对应 Playwright smoke，并用真实 Python/R 项目人工检查。

2026-07-15 18:30 +08:00 本轮安全与兼容修复的本地证据：37 个 Vitest 文件、235 个测试全部通过；严格行为 smoke 为 14 PASS / 0 FAIL / 0 BLOCKED，其中包含下载额度拒绝后的导出资产和文件回滚实测；安全基线、用户隔离、refresh、邮箱验证、管理员只读边界与授权、部署排空、生产 bundle、部署包和仓库数据边界均通过；生产构建和 TypeScript 检查通过。主数据只读审计仍为 25 个用户、118 个项目、245 个项目文件、89 个导出资产、0 个错误和 23 个历史测试账号警告，和修改前一致。

2026-07-16 20:41:53 +08:00 网页更新候选证据：TypeScript、生产构建、production bundle、41 个 Vitest 文件/250 项测试、Python 内省 48 项、R renderer 30 项通过；Python 语义中心 16/16、组件与布局 24/24、严格行为 15/15、扩展拖拽、R 语义 7/7、子图作用域跟随、导出快照数据库/API/UI 均通过。API 实测覆盖恢复前检查点、所有权、同名额外数据拒绝、在途渲染 draining、导出期间上传/删除阻断和旧资产只读兼容。本轮未读取、迁移或删除真实 `data/`。

2026-07-16 23:07:15 +08:00 生产证据：`e35f4a4-jd22` ready 且 `acceptingNewJobs=true`，单一 Node 进程、无错误级启动日志；公网与 Node 直连的后端 bundle/source map 请求均为 `404`。SQLite quick/外键检查和数据审计通过，计数保持 5 用户、10 项目、26 项目文件、4 导出资产。

本机旧 renderer 镜像仍未重建，因此 `test:renderer-sandbox` 不能作为本轮通过项。发布必须从同一不可变 commit 构建 renderer 后在 Linux 服务器复跑，不能用旧镜像的结果代替。

## 12. 开发协作约束

```text
不得把计划文档写成已实现事实
不得只根据测试名称判断功能完成
修改前必须定位代码、调用链和复现证据
共享前端协议修改必须检查 Python 和 R
保存、历史、拖拽和批量作用域修改必须检查多 Figure
安全限制必须同时验证恶意输入被阻断和正常科研脚本不被误伤
不得删除用户数据来解决测试或 Git 状态问题
```

## 13. 当前判断

SciFigure 已具备较完整的科研 Figure 编辑工作台能力，当前最大的缺口已经不是普通编辑控件数量，而是：

```text
真实项目覆盖
复杂对象稳定性
R 细粒度
生产安全与恢复
渲染性能和可观测性
```

因此当前正确路线是先完成安全部署和真实项目回归，再继续扩大产品能力范围。

## 14. 公开帮助中心（2026-07-12 13:44:49 +08:00）

帮助中心已作为公开访客和登录用户都可访问的独立页面落地，保持宣传页的深绿、薄荷绿与暖金视觉系统，不进入编辑器渲染状态链路。

当前内容包括：

```text
基础使用流程
可搜索的五类帮助问答
问答独立展开、展开全部与收起全部
七套科研模板：分组柱状图、散点回归、热图、箱线图、时间序列、森林图、PCA/PCoA 分组散点
每套模板的真实示例图、Python / R 代码和 CSV 示例数据
平台代码规范与 AI 转义规范
公开注册入口与登录后工作区返回入口
```

验证基线：

```text
npm run lint
npm test
npm run build
npm run test:help-center-smoke
```

模板库于 `2026-07-12 13:56:33 +08:00` 从 3 套扩展为 7 套。每套继续保持“真实示例图 + Python + R + CSV + 平台兼容说明”的完整交付契约。

`2026-07-12 13:59:38 +08:00` 增加模板能力声明：模板不是图形白名单。只要 Python/R 脚本能在平台运行环境中生成 Figure，平台即可执行并渲染；细粒度编辑能力仍以原生可内省图元和能力矩阵为准。

`2026-07-12 14:05:43 +08:00` 明确公开页面关系：原宣传页继续作为匿名访问和刷新的默认首页；帮助中心是独立二级页面，提供“返回官网”入口，不替代宣传页。登录用户从帮助页返回工作区。

`2026-07-12 14:12:14 +08:00` 重写帮助页快速上手：面向“已有外部工具生成脚本与数据”和“从平台示例代码起步”两类用户。导入路径按真实项目创建流程说明为脚本先行、识别数据依赖、补齐 CSV/Excel、检查配置、创建并渲染。

`2026-07-12 14:24:55 +08:00` 帮助页增加面向用户的 Python/R AI 绘图提示词分享；知识产权、核心实现保护和公开边界另行记录在内部文档 `INTELLECTUAL_PROPERTY_PROTECTION_PLAN.md`，不进入用户帮助内容。

`2026-07-12 14:57:42 +08:00` 恢复历史导出资产：账号 `2449673842@qq.com` 的 81 条导出记录全部确认归属正确，78 个原文件仍在，3 个缺失文件由数据库保存的 SVG 图形内容重建，最终达到 81/81 文件存在。资产库改为默认汇总当前账号全部项目，并支持按来源项目筛选。

`2026-07-16 19:10:16 +08:00` 编辑中心子图作用域接入统一选择状态；真实 Figure/子图导出新增独立不可变编辑快照。恢复前执行所有权、完整性、Figure 结构和数据文件哈希校验，成功后保存当前检查点并重新加载目标 Figure；旧资产继续可下载但不虚报可恢复。

`2026-07-17 17:44:15 +08:00` 阶段候选代码收敛为 `3faa789`：快照协议升级到 v2 并为每个 Figure 独立保存脚本，旧版多 Figure 快照安全拒绝恢复；旧 `workspace` 会话恢复保存、重新配置和导出入口；Monaco 改为站内同源加载。最终验证包括 140 个 Vitest 文件/889 项、Python 46/46、R 31/31、renderer 沙箱、完整 API/UI/导出矩阵、生产构建和数据审计 `0` 个问题。该提交尚未推送或部署。

`2026-07-21 17:06:15 +08:00` 新增站内图形能力展厅候选和开发者浏览器验收 MCP。展厅复用现有公开页面、认证和帮助中心导航，不建立第二套网站；目录记录 fixture、证据状态、限制和固定模拟数据来源。新增预览只复用主项目常见图形结构，不读取 `data/` 或真实用户项目。MCP 只通过页面进行选择、属性修改、应用、撤销/重做、诊断、截图和导出，限制允许 origin、主画布、属性面板、导出页及临时产物目录，不具备数据库或 renderer 直写工具。

同一候选把编辑器 `.py/.R` 拖放范围从代码面板扩展到整个工作区，预览页拖入脚本后自动切到代码页；不支持的文件仅记录提示，不覆盖当前脚本。当前定向证据为展厅单元 5/5、展厅隔离浏览器、MCP 安全 4/4、MCP 隔离真实 UI、脚本拖放隔离浏览器和 TypeScript 全部通过。该候选尚未提交、推送或部署，展厅“立即体验”仍进入现有项目创建流程，不代表免注册可编辑 Demo 已完成。

`2026-07-22 10:47:02 +08:00` 修复 Python Figure 越界 artist 的长期裁切问题。renderer 只扩展发生越界的 SVG 边缘并记录 `renderViewport`，原 Figure 物理尺寸和透明背景语义保持不变；旧 manifest 无该字段时继续按原 viewBox 工作。ChartPreview 的隐藏 axes/Figure 坐标拖动同步按原 Figure 区域换算，PNG/PDF/TIFF/EPS 与预览使用同一边界。越界色条单测、真实浏览器越界文字、拖拽回放和完整导出矩阵均通过；尚未推送或部署。

`2026-07-24 00:53:29 +08:00` 完成 R-WP4 GeomSegment/Curve 本地候选。renderer 以专用 adapter 表达端点、曲率和 arrow 只读结构，并在真实 panel 内对 geom 实际可绘制行按图层绘制顺序绑定完整 body/arrow 序列；Step、Freqpoly、Segment 和 Curve 批量改为同色或可见行混合 NA 行时不再丢失 Segment/Curve 的 SVG GID。完整 R renderer 111/111、真实浏览器 14/14、家族 patch authority、identity v2 compatibility、lint、build 和 diff-check 通过。当前未推送、未部署，R-WP5 尚未开始。

`2026-07-25 20:33:34 +08:00` 完成 R-WP5 独立审查收敛。除 scale/guide/facet、多 guide 标题与 SVG 样式隔离外，旧 continuous absolute-index alias 现在只容忍已知变化字段，伪造 stableKey/semantic/series/aesthetic 证据拒绝；R 跨 Figure relation 必须共享至少一个稳定字段，legacy score fallback 不能绕过冲突。完整 R renderer 124/124、隔离 API 3/3、真实浏览器 6/6、R 语义黄金样例 14/14、identity v2 compatibility、TypeScript 216 项和 lint 通过；最终独立复审 0 HIGH/MEDIUM。当前未推送、未部署，下一工作包为 R-WP6。

`2026-07-26 13:45:59 +08:00` 完成 R-WP6 本地候选收敛。R 文本拆分为 data、annotation、stat 三类身份，扩展对齐、旋转、lineheight、plotmath/多行和位置能力；统计文字只读，`geom_label` 文本编辑保留 mapped fill。Cartesian/flip/log/panel 内 polar 可逆重放，CoordSf、第三方 coord 和不可逆位置 fail-closed。修复 R `currentProps.position` 缺失导致 renderer acknowledgement 冲突，以及前端确认前清空拖动草稿的问题；真实浏览器失败/重试证明零持久化、单请求和成功后清空。R renderer 125 个场景、R semantic 19/19、组件容器 42/42、capability matrix、identity v2、历史/导出/恢复、1720 项前端单测、lint/build/diff-check 通过。当前未推送、未部署，下一工作包为 R-WP7。

`2026-07-26 18:19:46 +08:00` 完成 R-WP7 本地候选。R renderer 通过 `scifigure-sem-v1` 显式 marker 建立七类 diagram role 和完整 node/edge relation；GID 的四个身份字段全部使用 Base64URL，ASCII `a_` 与非 ASCII `b_` 命名空间分离，字段边界无歧义，重复完整 identity 在 manifest 构建期拒绝，同 marker 多行保留为一个有序 path。未标记 lookalike 保持通用对象，系数、p 值、拟合指标和拓扑只读。修复文本重建丢失 metadata、非法 mixed batch 部分应用，以及 `clip="off"` 下图例/同样式图元干扰 owner 的问题；只有可证明 panel 范围才允许按图层顺序绑定。renderer 10/10、R capability matrix、旧动态批次/fingerprint 4/4、隔离 API 和 Chromium 正确几何选择通过；当前未推送、未部署，下一工作包为 R-WP8。

`2026-07-26 19:26:25 +08:00` 完成 R-WP8 本地候选。固定 renderer 镜像未安装的 `ggrepel/ggnewscale/sf/ggraph/igraph/tidygraph/semPlot/DiagrammeR` 统一进入显式 Shadow/readonly 边界；runtime inventory 只读报告安装状态，缺包诊断结构化且不泄露路径。repel 与原生 ggraph geom 保留可用预览但不暴露写回控件，renamed aesthetic 不并入现有 scale，CoordSf 不可逆位置与合法样式混合时整批拒绝，base R 维持 preview/export only。隔离 API 证明拒绝后 session、Figure、revision、history 和 render cache 均不变化。R-WP8 7/7、capability matrix、旧身份、R-WP7 API/UI、完整 R semantic Chromium、安全预检、镜像契约和 lint 通过；当前未推送、未部署，下一工作包为 R-WP9。

`2026-07-26 20:22:44 +08:00` 完成 R-WP9 本地候选。新增双 CSV 精确路径 workflow，覆盖项目创建、真实上传、patch revision、刷新、SVG/PNG/PDF/TIFF、导出后编辑和快照恢复。R renderer 输出脚本、语义预检、编辑解析/应用、ggplot 绘制及设备开关分段计时；缓存 key 使用 renderer authority schema v2；导出响应提供 render/convert/persist 计时。UTF-8 SVG 超限在 session、preview、cache、资产和快照前返回结构化 413，直接渲染、patch 和导出均由数据库/文件前后快照证明零持久化。timeout smoke 证明本轮 Rscript job、临时目录和受管容器无残留。相关 workflow、性能持久化、timeout、render performance、cache、lint、build、diff-check 和 data audit 通过；当前未推送、未部署，下一工作包为 R-WP10。

`2026-07-26 21:12:19 +08:00` 完成 R-WP10 本地候选门禁。默认 V2 resolver 248 项、旧 R identity/editLog 兼容、安全预检、R-WP9 三条用户链路、renderer sandbox、用户隔离、性能、缓存、lint、build、diff-check 和 data audit 通过。沙箱使用独立 `scifigure-renderer:rwp10-candidate` 镜像，未替换或停止现有容器；仅修正测试的 5 秒冷启动阈值和 Windows 临时 SQLite 清理竞态。共享路由继续通过 Python cross-Figure 18/18、patch rejection、semantic workflow 和 export matrix；浏览器门禁串行时 console/page error 为 0。当前仍未推送、未部署，生产不可变构建、小范围账号和人工视觉回归未完成，旧兼容路径继续保留。

`2026-07-29 10:33:11 +08:00` 完成 R 五个编辑中心的真实浏览器补充验收。隔离 `r-semantic-smoke` 以 19/19 覆盖字体中心、组件中心和配色中心，并验证 Draft、立即应用、保存刷新、撤销/重做、文本拖拽、导出和导出快照恢复；隔离 `r-property-layout-centers` 以 7/7 覆盖属性中心的轴刻度/网格和布局中心的单图 aspect、facet 共享边界及只读物理 bounds。两份报告均为 0 console/page error、0 failed request。首轮属性测试的 checkbox 点击失败已确认是隐藏原生控件的 harness 定位问题，使用同一真实控件的 `force` 操作后通过；产品代码未因此改变。当前仍未提交、推送或部署，网页端和本机 3000/3100 不因本轮验收发生变化。
