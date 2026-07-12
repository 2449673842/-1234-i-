# SciFigure Studio 项目总体说明与当前状态

> 当前统一文档入口已迁移到 `docs/current/00_SCIFIGURE_CURRENT_MASTER.md`。  
> 本文件保留为详细历史总览；当前能力与安全口径分别以 `docs/current/01_CAPABILITIES_AND_ARCHITECTURE.md` 和 `docs/current/02_SECURITY_DEPLOYMENT_AND_OPERATIONS.md` 为准。

更新时间：2026-07-10

## 1. 文档目的

本文用于统一 `docs/` 目录中多份升级计划、阶段报告、架构设计、安全方案和错误记录的口径，回答以下问题：

```text
当前平台已经具备什么能力
Python 和 R 如何共同维护
哪些内容已经真实实现并验证
哪些内容只是规划或部分实现
当前最重要的风险是什么
后续开发应按什么顺序推进
```

本文是项目总览，不替代各专项技术文档。判断某项能力是否完成时，证据优先级为：

```text
实际代码和可重复测试结果
> 最新专项状态文档
> 错误记录中的修复与验证证据
> 升级计划和架构设计文档
> 早期 walkthrough、历史恢复文档和旧版本计划
```

## 2. 当前阶段结论

SciFigure Studio 已经从普通绘图脚本执行器发展为具备以下核心链路的科研 Figure 工作台：

```text
项目与多文件管理
Python/R 真实代码执行
多 Figure 独立状态
图元内省和语义识别
属性编辑与批量修改
Draft Patch Batch
撤销/重做
文本和图例位置拖拽
多子图布局调整
科研格式导出
导出资产和组合图
账号、数据隔离与 renderer 沙箱
```

当前不适合再用“平台全部能力 100% 完成”描述整个产品。更准确的说法是：

```text
既定的 SciFig 优秀升级版主链路已经完成阶段验收；
产品仍存在图元覆盖、R 细粒度、真实项目回归、生产安全和部署运维缺口。
```

当前开发策略调整为：

```text
当前阶段不再追求新增编辑能力，而是进入安全加固、数据保护、
真实项目回归和生产部署准备阶段。
```

## 3. 用户数据保护红线

本地 `data/` 目录中的数据库、项目、上传文件和导出资产均为用户仍需使用的真实数据。

后续任何开发任务必须遵守：

```text
不得删除本地 data/ 目录及其内容
不得自动清空数据库
不得自动迁移、重命名或覆盖用户项目目录
不得用测试数据替换真实项目
不得因 Git 清理而删除工作区文件
数据库迁移前必须建立可恢复备份
破坏性 Git 历史重写必须单独授权
```

当前对 `data/`、`tmp/`、`output/` 等目录的 Git 处理仅是解除版本跟踪和增加忽略规则，不代表删除本地文件。平台仍按现有路径读取本地项目数据。

## 4. 当前推荐部署形态

第一阶段生产部署以单机、可恢复和边界清晰为原则，不直接采用多 Web 节点或复杂分布式架构。

推荐形态：

```text
单台 8 核 16 GB 云服务器
Nginx 反向代理和 TLS
Node.js / Express Web 服务
SQLite 本地数据库
独立 Docker renderer
加密系统盘和加密数据盘
restic 客户端加密备份
renderer 默认并发 4
```

部署边界：

```text
Web 服务不直接暴露公网端口
renderer 不暴露公网端口
不得把 Docker socket 挂载到公共 Web 容器
宿主机加密目录 /srv/scifigure/data 绑定到容器 /app/data
用户脚本只在禁网、只读、限资源的 renderer 中执行
```

该形态与当前代码结构最接近，迁移成本和运行风险低。需要多 Web 节点时，应先把 SQLite 迁移到 PostgreSQL 等支持并发访问的数据库。

## 5. 当前总体架构

### 5.1 前端

```text
React 19
Vite
TypeScript
Monaco Editor
SVG 画布与图元选择层
```

前端主要职责：

```text
项目和 Figure 状态管理
代码编辑
StandardFigureModel 归一化读取
字体中心、组件中心、配色中心和布局中心
语义 EditingIntent 编译
Draft Patch 暂存与批量应用
按 Figure 调度渲染请求
拖拽坐标采集和最终位置确认
导出和组合资产管理
```

### 5.2 后端

```text
Node.js / Express
SQLite / better-sqlite3
项目、Figure、session、export asset 和账号 API
按 Figure patch、revision、render cache 和 EditLog 持久化
```

后端主要职责：

```text
认证与用户边界
项目和文件访问
Python/R 渲染调度
patch 和 code patch 回放
渲染缓存
导出资产生成
组合代码项目与组合资产
文件路径和资源限制
```

### 5.3 渲染引擎

平台采用“两引擎一协议”：

```text
Python / Matplotlib renderer
R / ggplot2 renderer
StandardFigureModel 前端统一协议
EditingIntent 前端统一编辑语义
```

Python 和 R 并不是同一个内省器。它们保留各自可靠的渲染与回写方式，再通过标准协议向前端暴露统一对象。

正确链路：

```text
Python artist tree 或 ggplot object
→ 各自 introspection/semantic manifest
→ StandardFigureModel
→ EditingIntent
→ 对应引擎的安全 patch
→ 重新渲染
```

不采用：

```text
直接猜测任意 SVG 节点
→ 修改 SVG DOM
→ 无法回写代码和重放
```

## 6. 已落地的主要能力

以下“已落地”表示主链路已经实现，并有代码、单元测试、API smoke 或浏览器 smoke 证据；不表示已经覆盖所有复杂图形和真实项目脚本。复杂对象仍以语义能力矩阵和最新回归结果为准。

| 能力 | 主要实现位置 | 验证证据 | 当前边界 |
|---|---|---|---|
| 项目、多文件和多 Figure | `db.ts`、`server.ts`、`src/App.tsx` | `tests/api/cross_figure_concurrency_smoke.mjs`、`tests/playwright/cross_figure_apply_smoke.mjs` | 复杂项目仍需真实数据回归 |
| StandardFigureModel | `src/schemas/standardFigureModel.ts`、`src/utils/standardFigureModel.ts` | `src/utils/standardFigureModel.test.ts` | 原始 manifest 仍是事实来源 |
| EditingIntent | `src/schemas/editingIntent.ts`、`src/utils/editingIntentCompiler.ts` | `src/utils/editingIntentCompiler.test.ts`、`src/utils/semanticPatchMapping.test.ts` | unsupported 对象会安全跳过 |
| Draft Batch 和当前图重绘 | `src/App.tsx`、`src/components/RightSidebar.tsx` | `tests/playwright/scifigure_behavior_smoke.mjs` | 连续控件仍需关注真实渲染性能 |
| 多目标拖拽 | `src/components/ChartPreview.tsx`、`src/components/MainWorkspace.tsx` | `tests/playwright/drag_extended_smoke.mjs` | annotation、复杂坐标仍有限制 |
| 多子图语义和布局 | `src/components/RightSidebar.tsx`、`src/utils/subplotPhysicalLayout.ts` | `src/utils/subplotPhysicalLayout.test.ts`、`tests/playwright/multisubplot_semantics_smoke.mjs` | R facet 物理布局低于 Matplotlib |
| 导出和资产 | `src/components/ExportSettingsPage.tsx`、`src/components/ExportLibraryPage.tsx`、`server.ts` | `tests/playwright/export_matrix_smoke.mjs` | 大 TIFF/批量导出受带宽和磁盘影响 |
| R/ggplot 语义编辑 | `renderer/r_renderer.R`、`server.ts` | `tests/test_r_renderer.py`、`tests/playwright/r_semantic_centers_smoke.mjs` | base R 和复杂坐标不提供完整编辑 |

### 6.1 项目、文件与多 Figure

已具备：

```text
项目创建、读取、保存和删除
CSV/TSV/TXT/XLS/XLSX 多文件上传
上传文件路径注入
一段代码生成任意数量 Figure
Figure tabs 和独立 revision/session
当前 Figure 单独 patch 和重绘
跨 Figure 应用到选中图或全部图
```

当前按 Figure 独立渲染，不需要每次修改一张图都重新渲染项目中的全部 Figure。

### 6.2 StandardFigureModel

已建立 Python/R 前端归一化协议，主要统一：

```text
engine/language
figureId/revision
svg/manifest
objects
globals
palettes/groups/bindings
capabilities
editLog
```

原始 manifest 仍是事实来源，标准模型是前端消费视图，不替代原始渲染器输出。

### 6.3 语义编辑意图层

已解决的典型误改：

```text
修改 y 轴标题颜色时误改 y tick
修改单个 tick 内容时扩展到整组 tick
跨 Figure 直接复制 raw gid
拖拽位置被错误应用到其他 Figure
```

当前核心语义角色包括：

```text
title
x_axis_label / y_axis_label
x_tick_label / y_tick_label
legend_container / legend_text / legend_title / legend_marker
colorbar / colorbar_label / colorbar_tick_label
subplot_axes_box
axis_frame / axis_spine
grid
data_line / data_point / data_patch
heatmap
component fallback
```

内容和位置修改默认禁止跨 Figure；样式修改只有在目标图存在明确语义匹配时才允许映射。

### 6.4 编辑中心

当前主要入口：

```text
属性编辑
字体中心
组件中心
配色中心
布局中心
图层结构
```

已覆盖的常见修改：

```text
文字内容、字体、字号、颜色、粗体、斜体、旋转和位置
坐标轴标签和 tick 样式
线、散点、柱、误差棒、箱线图和小提琴图样式
spine、grid、legend、heatmap 和 colorbar
子图 bounds、宽高、间距和布局
```

### 6.5 Draft Batch、历史与保存

典型流程：

```text
用户连续修改多个属性
→ 修改进入当前 Figure draft
→ 点击应用
→ 合并为一次 patch batch
→ 当前 Figure 重新渲染一次
→ 作为一个历史动作进入 undo/redo
```

本地 SVG 预览修改和未应用草稿已补充保存链路，刷新后应从 Figure session 恢复对应 EditLog。

### 6.6 拖拽

已实现：

```text
拖拽模式开关
普通选择模式与拖拽模式隔离
拖动过程只做前端预览
松手后记录最终位置
确认后一次性发送 position patch
取消不写入后端
多个已选对象可形成一个拖拽批次
撤销/重做与普通编辑一致
```

复杂坐标或后端无法安全回放的对象会禁用拖拽或给出 warning。

### 6.7 多子图与布局

当前可以识别 Matplotlib 多子图和 R facet 基本面板信息。

已具备：

```text
按 subplot 范围筛选图元
单独修改某个子图
批量修改所有子图边框和网格
子图位置、宽度、高度和间距调整
紧凑/标准/宽松布局
预设行列布局
交换子图位置
按参考对象外沿扩展目标子图宽度
heatmap 与 colorbar 布局调整
```

### 6.8 导出与组合

已支持：

```text
SVG
PNG
PDF
TIFF
选中 Figure 导出
全项目导出
组合图和子图同时导出
导出资产库
导出 revision 记录
组合资产 source revision 快照
源图更新后的 stale 提示
A4/Word 最终尺寸预览
```

组合代码项目允许从多个项目选取 Figure 和数据，生成给网页 AI 的代码重写提示词，再创建新的组合项目。

## 7. Python 与 R 当前对齐情况

| 能力 | Python / Matplotlib | R / ggplot2 |
|---|---|---|
| 真实代码渲染 | 已支持 | 已支持 |
| SVG/PNG/PDF/TIFF | 已支持 | 已支持 |
| 标题、轴标签、tick、图例字体 | 已支持 | ggplot2 已支持 |
| 点、线、柱、误差线整体样式 | 已支持 | 按 ggplot layer 支持 |
| 分组改色 | palette/binding | manual color/fill scale |
| 多子图识别 | Matplotlib subplot | facet panel 基本识别 |
| heatmap/colorbar | 较完整 | 连续 scale 和 guide 基础能力 |
| 文本拖拽 | 部分 Matplotlib 文本 | 线性坐标下 ggplot text/label |
| 画布直选 | artist gid | layer/text SVG id |
| base R 图元编辑 | 不适用 | 仅预览和导出 |

当前差距：

```text
R 同一 layer 内的 group 细粒度仍低于 Python artist
R facet 面板物理位置和比例编辑不足
R colorbar 不支持 Matplotlib 式 left/bottom/width/height
复杂 R 坐标主要采用禁用和 warning
base R 不支持语义图元编辑
```

## 8. 当前图元覆盖状态

成熟度较高：

```text
普通文本
坐标轴系统
标题和轴标签
line/scatter/bar/errorbar
boxplot/violinplot
spine/grid
legend 和 Figure-level shared legend
heatmap/colorbar
multi-panel subplot
```

部分实现或验证不足：

```text
annotation 和箭头
tick line 独立对象
复杂 legend 内部 marker/text 绑定
复杂 colorbar 与 mappable 联动
twinx/twiny 和复杂共享轴
超大 scatter 的真实浏览器性能
R facet/guide/scale 深层语义
```

## 9. 当前安全状态

| 安全项 | 当前状态 | 主要证据 | 是否阻断公网生产 | 风险备注 |
|---|---|---|:---:|---|
| 项目和 Figure 强制认证 | 已实现 | `server.ts`、`tests/api/user_data_isolation_smoke.mjs` | 是 | 所有新增资源 API 必须复用认证边界 |
| `user_id` 数据隔离 | 已实现 | `db.ts`、`tests/api/user_data_isolation_smoke.mjs` | 是 | 当前是表级逻辑隔离，不是独立用户数据库 |
| Argon2id 和 refresh rotation | 已实现 | `db.ts`、`src/utils/authenticatedFetch.ts`、`tests/api/auth_refresh_smoke.mjs` | 是 | 生产必须使用 Secure Cookie 和 HTTPS |
| 限流、请求体和上传限制 | 已实现 | `server.ts`、`tests/api/security_baseline_smoke.mjs` | 是 | 阈值需按服务器容量复核 |
| `safeResolve` 路径边界 | 已实现 | `server.ts`、安全 baseline smoke | 是 | 新增文件 API 时必须继续接入 |
| Python/R Docker renderer | 已实现，待云端复测 | `Dockerfile.renderer`、`server.ts` | 是 | 生产禁止回退到不受控本地执行 |
| renderer 禁网、只读和资源限制 | 已实现，待云端复测 | `server.ts`、`tests/api/renderer_sandbox_smoke.mjs` | 是 | 云端 Docker/runtime 行为必须再次验证 |
| 主数据库和 `.env` 隔离 | 已实现，待云端复测 | renderer 挂载策略、`tests/api/renderer_sandbox_smoke.mjs` | 是 | Web 容器与 renderer worker 不能共享敏感目录 |
| 仓库用户数据门禁 | 已实现 | `scripts/security/check-repo-boundary.mjs`、`.github/workflows/security-baseline.yml` | 否 | 旧 Git 历史仍需单独评估 |
| 加密备份脚本 | 工具已完成，未生产启用 | `ops/backup/*`、`docs/PRODUCTION_DATA_SECURITY_RUNBOOK.md` | 是 | 必须完成真实备份和恢复演练 |
| 云盘/KMS 静态加密 | 未部署 | 云厂商控制台和部署记录 | 是 | 不能只依赖应用账号权限 |
| R 静态风险预检 | 已实现，生产待启用 | `src/utils/rRiskScanner.ts`、`tests/api/r_security_precheck_smoke.mjs` | 否 | 静态规则可绕过，不能替代 Docker 沙箱 |
| admin 二次鉴权和基础审计 | 已实现 | `db.ts`、`server.ts`、`tests/api/admin_authorization_smoke.mjs` | 否 | 生产仍需异常告警、审计归档和更多管理操作覆盖 |
| Excel 服务端解析隔离 | 已实现，待云端复测 | `renderer/tabular_parser.py`、`tests/test_tabular_parser.py`、`server.ts` | 是 | 异步 parser、按行预览、metadata-only cache；浏览器端仍保留 xlsx 兼容层 |
| Docker 构建数据边界 | 已实现 | `.dockerignore`、`Dockerfile.renderer.dockerignore` | 是 | 构建上下文不得包含 data、数据库或项目资产 |
| 导出转换沙箱 | 已实现，待云端复测 | `renderer/svg_convert.py`、`tests/api/renderer_sandbox_smoke.mjs` | 是 | R PNG/PDF/TIFF 转换不再在生产宿主机执行 |
| 防火墙、TLS、SSH 和告警 | 未部署 | 云服务器部署验收记录 | 是 | 必须在公网开放前完成 |

状态定义：

```text
已实现：代码和本地测试已有证据
待云端复测：本地成立，但依赖生产 Docker、网络或权限配置
工具已完成：已有脚本或模板，但尚未在生产运行
未部署/未完成：不能作为当前安全能力对外承诺
```

本地数据暂不做应用层逐文件加密。原因是逐文件加密会直接影响预览、渲染、组合和导出链路。当前优先采用对应用透明的加密云盘、加密快照和客户端加密备份。

## 10. 性能与并发状态

当前已具备：

```text
按 Figure 重绘
stale response guard
render cache
Figure 独立 requestId/revision
默认 renderer 并发队列 4
```

本地 Docker 基准：

```text
Python 冷启动约 3.2-4.0 秒
Python 后续约 2.4-3.1 秒
R 约 2.5-3.0 秒
4 个并发 Python 渲染约 4.6 秒完成
```

8 核 16 GB 云服务器建议初始并发为 4。10 Mbps 带宽对普通 SVG 和代码请求影响不大，但大 CSV、TIFF 和批量导出会受上传下载带宽限制。

仍可优化：

```text
项目文件 staging 缓存
大表转换为 Parquet/Arrow
样式类 patch 跳过不必要的完整 introspection
缓存命中率和队列指标
等待时间和队列进度 UI
Excel 解析移入受限 worker
```

## 11. 文档可信度与用途分类

### 11.1 当前事实来源

优先阅读：

```text
SCIFIGURE_PROJECT_MASTER_OVERVIEW.md
SEMANTIC_CAPABILITY_MATRIX.md
STANDARD_FIGURE_MODEL_V1.md
EDITING_INTENT_LAYER_UPGRADE_PLAN.md
R_COMPATIBILITY_PLAN.md
USER_SERVER_SECURITY_UPGRADE_PLAN.md
PRODUCTION_DATA_SECURITY_RUNBOOK.md
ERROR_LOG.md
GEMINI_CODING_PROTOCOL.md
```

### 11.2 阶段验收记录

```text
SCIFIG_EXCELLENT_UPGRADE_STATUS.md
V3.2-UPGRADE.md
RECOVERY_BASELINE_20260628.md
walkthrough.md
```

这些文档用于证明某个时间点的里程碑，不应单独作为当前全部能力完成度结论。

### 11.3 规划或历史设计

```text
SCI4.0_PLAN.md
SYSTEM_UPGRADE_AND_SECURITY_BLUEPRINT.md
PRODUCTION_DEPLOYMENT_ARCHITECTURE.md
artist_introspection_upgrade_plan.md
upgrade-plan.md
upgrade-plan-v3.2-final.md
implementation_plan.md
docs/superpowers/plans/*
```

这些文档包含大量未实施或已被后续方案替代的内容。引用时必须再与代码、测试和当前状态文档核对。

## 12. 文档之间的主要冲突

### 12.1 “100% 完成”口径

`SCIFIG_EXCELLENT_UPGRADE_STATUS.md` 中的 100% 表示当时定义的优秀升级版任务清单完成，不表示整个产品所有能力完成。

当前语义能力矩阵仍显示：

```text
annotation 部分实现
tick line 仅协议预留
部分对象缺少浏览器实测
R 细粒度低于 Python
生产安全和运维仍未最终部署
```

### 12.2 Database-Per-User 和 SQLCipher

`SYSTEM_UPGRADE_AND_SECURITY_BLUEPRINT.md` 中的 Database-Per-User、SQLCipher、信封加密和 WORM 审计属于长期设计，不是当前已实现能力。

当前实际状态是：

```text
单 SQLite 数据库
表级 user_id 隔离
项目文件目录隔离
云盘/备份透明加密方案
```

### 12.3 生产部署拓扑

`PRODUCTION_DEPLOYMENT_ARCHITECTURE.md` 中的多 Web 节点、EFS/NAS、RDS、SQS、Serverless renderer 和 S3 属于目标架构。

当前更现实的第一阶段部署是：

```text
单台 8 核 16 GB 云服务器
Nginx/TLS
Node Web 服务
独立 Docker renderer
加密数据盘
加密对象存储备份
4 个渲染并发槽
```

SQLite 不应直接作为多 Web 节点共享数据库运行在普通 NFS/EFS 上。真正扩展为多 Web 节点时，应迁移到 PostgreSQL 等支持多节点并发的数据库。

### 12.4 TLS 版本

旧蓝图提出“只允许 TLS 1.3”。当前生产部署不应强制禁用所有 TLS 1.2 客户端，应采用安全配置的 TLS 1.2 + TLS 1.3，并禁用旧协议和弱密码套件。

### 12.5 安全方案优先级

早期安全蓝图重点描述了 SQLCipher、KMS、Database-Per-User、WAF 和哈希链审计。这些属于中长期安全能力，不是当前最先要解决的问题。

当前优先级必须保持为：

```text
renderer 隔离和禁网
文件路径边界
user_id 数据访问控制
admin 二次鉴权
加密备份和真实恢复
云服务器防火墙、TLS 和最小权限
```

高级加密和多数据库架构不能替代上述基础边界，也不能在没有迁移备份和恢复验证时直接上线。

## 13. 当前优先级

P0 是上线前阻断项。P0 未完成或未通过验收时，平台不得进入公网生产使用，也不得继续扩展非必要绘图功能。P0 阶段禁止破坏性数据库迁移，所有数据结构变更必须先建立可恢复备份。

### P0：用户数据与生产安全

```text
保持本地 data/ 完整，不做删除或迁移
在云服务器启用加密系统盘和数据盘
部署 restic 加密备份
执行真实恢复演练
完成防火墙、TLS、SSH 和最小权限账号
完成 admin 异常告警、审计归档和剩余管理操作覆盖
启用 R block-high 前完成真实 R 项目兼容矩阵
将 renderer 调度从公共 Web 进程边界进一步隔离
评估 Git 历史中的用户数据
```

### P1：稳定性验证

安全基线稳定后再执行：

```text
Python 单图/多 Figure/多子图真实项目矩阵
R ggplot/facet/heatmap 真实项目矩阵
复杂 legend/colorbar
多目标拖拽
全部导出格式
保存、刷新、撤销和历史定位
```

### P2：性能

```text
staging 和数据解析缓存
渲染缓存指标
队列状态和等待时间
减少样式 patch 的完整重算
```

### P3：能力扩展

当前暂缓：

```text
annotation/arrow 深度编辑
R layer group 细粒度
更多自动布局
AI 语义改图
```

## 14. 当前验收基线

最近已验证：

```text
npx tsc --noEmit：通过
npm test：7 个文件、60 个测试通过
npm run build：通过
npm run security:repo-boundary：通过
```

生产构建仍保留两个已知 warning：

```text
前端主 bundle 超过 500 kB
server.ts 在 CJS bundle 中使用 import.meta warning
```

这两个 warning 当前不阻断本地功能，但应在正式部署前处理或形成明确接受记录。

## 15. AI / 开发协作约束

本节是后续 Codex、Gemini、其他 AI 和人工开发者共同遵守的执行规则。

### 15.1 状态判断

```text
不得把计划文档中的内容当作已实现事实
不得仅根据 UI 控件存在判断功能完成
判断完成状态必须引用代码、测试和真实运行结果
历史报告只能证明当时的里程碑，不能覆盖最新代码事实
```

### 15.2 修改前证据

修复 bug 或扩展安全能力前必须明确：

```text
复现现象
直接相关文件和函数
前端事件链
后端 API 契约
数据库或文件系统影响
Python/R 两条路径的影响
已有测试和缺失测试
```

没有完成调用链检查时，不得以猜测方式修改共享协议、状态结构、数据库 schema 或 renderer 调度。

### 15.3 数据和文件约束

```text
不得删除、清空、移动或覆盖 data/ 中的真实用户数据
不得用测试 fixture 替换真实项目文件
不得在无可恢复备份时执行数据库迁移
不得通过清理 Git 工作区删除被忽略的用户文件
不得提交 .env、数据库、上传文件、render diagnostic 或临时 payload
```

### 15.4 功能保护

```text
不得为了通过测试而删除、隐藏或绕过真实功能
不得把 unsupported 对象伪装成可编辑对象
不得直接修改 SVG DOM 代替可重放的 Python/R 参数回写
不得让 Python 专用 patch 进入 R 路径，反之亦然
不得让安全升级静默改变用户现有项目数据格式
```

### 15.5 交付要求

每次修改必须说明：

```text
修改目的和范围
未修改的边界
关键代码和协议变化
对用户数据的影响
回滚方式
执行过的验证命令
未验证项和剩余风险
```

安全或架构修改至少需要：

```text
npx tsc --noEmit
npm test
npm run build
npm run security:repo-boundary
与改动对应的 API 或浏览器 smoke test
```

## 16. 总结

SciFigure Studio 的核心优势已经形成：

```text
不是只修改 SVG 表面
而是识别 Python/R 图形语义
把用户编辑转换为可审查、可撤销、可保存、可重放的参数修改
并按 Figure 精确重绘和导出
```

当前最重要的工作不是继续增加更多按钮，而是保证：

```text
用户数据不丢失
用户之间不能越权
用户代码不能读取服务器敏感内容
备份能够真实恢复
已有编辑能力不会因安全升级而退化
```

在这些条件完成之前，平台功能保持冻结是合理的。
