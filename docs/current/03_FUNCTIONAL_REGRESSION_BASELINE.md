# SciFigure 当前功能不可回退基线

> 状态：当前有效，所有平台功能升级的合并阻断基线
> 最后修改时间：2026-07-19 19:51:21 +08:00
> 证据截止时间：2026-07-19 19:51:21 +08:00
> 代码范围：`feature/standard-figure-model-v1`，`HEAD 986767c` 加当前工作区尚未提交的 `pie/wedge` 专用语义、身份隔离和回归保护
> 部署状态：未推送、未部署；本文件不代表服务器当前版本
> 数据边界：不得删除、迁移、覆盖或用测试数据替换真实 `data/`

## 1. 文档目的

本文件把此前分散在当前主文档、能力架构文档、统一编辑中心升级方案、能力增强方案和错误日志中的回归约束合并为一份可执行基线。

后续任何 Python、R、编辑中心、布局、历史、导出、组合、安全或性能修改，都必须同时满足：

```text
新增能力有直接证据
现有能力没有回退
旧项目和旧 editLog 继续兼容
真实用户数据没有被测试污染
修改可以按能力域独立回滚
```

“新测试通过”不能代替“旧能力未回退”。如果本文件与早期计划冲突，以当前代码、最新可重复测试和本文件为准。

## 2. 当前证据快照

2026-07-19 本轮已经获得的最新证据：

| 检查项 | 最新结果 | 说明 |
|---|---:|---|
| TypeScript | 通过 | `npm run lint` |
| 前端单元测试 | 最近全量 1006/1006；最终映射 26 项定向通过 | 最终改动按 changed-path gate 验证，完整回归留到 Python 阶段候选 |
| Python renderer/身份/复杂覆盖 | 既有完整 discovery 通过；pie 兼容门禁 4/4 | 本地 3.7.2 基线、3.8.4 定向兼容和网页 3.11.0 记录分开管理 |
| 组件中心真实浏览器 | 既有 41/41；pie 专用分组直接回归通过 | 网格、图例、容器、四个 WP6 家族、父层重定向、保存刷新和拖拽模式多选保护 |
| Python 完整用户链路 | 通过 | 选择、Draft、整批应用、刷新、撤销/重做、导出、后续编辑和快照恢复 |
| `fill_between` 专用语义 | 通过 | dedicated kind/role、旧 GID/stableKey、配色、组件、历史和导出恢复均通过 |
| `contour/contourf` 专用语义 | 通过 | 父对象、只读子层、colorbar 关系、属性 scope、跨 Figure、旧项目和导出恢复均通过 |
| `hist/stairs/step` 专用语义 | 通过 | 专用 role、hist 父子关系、普通对象负例、结构只读、配色、组件、历史和导出恢复均通过 |
| `pie/wedge` 专用语义 | 通过 | 扇区/标签/百分比/图例/Wedge 独立 role，`pieId + sliceIndex` 身份隔离，结构只读、跨 Figure、导出和恢复均通过 |
| R 共享协议回归 | 通过 | R renderer 31/31、R 浏览器 5/5、Python/R capability matrix 2/2 |
| patch 事务保护 | 通过 | standalone 与项目 Figure 均由服务端按可信 manifest/renderer 决定 mode；拒绝批次不改变 revision、session、history、cache 或导出锚点 |
| 导出快照恢复事务 | 通过 | renderer dry-run、事务内并发状态复核、v1 兼容、不安全多 Figure 拒绝和全项目导出先全量预检后持久化均有专项回归 |
| 导出文件事务 | 通过 | DB 创建失败清理新文件；删除失败恢复暂存文件；成功后数据库与文件状态一致 |
| 项目 PUT 保存预检 | 通过 | editLog/history 先预检；revision/hash CAS 阻止旧保存覆盖；GET/PUT 统一旧项目恢复源；排队保存与新 Draft 不丢失 |
| 跨 Figure 目标保护 | 通过 | 无授权显式对象不 fanout；目标 mode 重算；同分语义候选跳过；组件语义组显式授权 fanout 保持 |
| 跨 Figure 浏览器回归 | 18/18 通过 | 字体、内容限制、组件组 fanout、图例隔离、四个 WP6 家族 role 分离、单 pie slice 映射和部分失败 Draft 保留 |
| 扩展拖拽 | 10/10 通过 | 真实 Ctrl 三选、累计确认、取消、只读命中、annotation 和 R native 保护 |
| Python cache | 通过 | 首次 miss、同语义重复 hit、值变化 miss；只信任本进程已确认 key |
| 生产构建 | 通过 | 保留既有 bundle 体积和 CJS `import.meta` 警告 |
| 数据完整性 | 0 个错误 | 25 用户、121 项目、263 项目文件、101 导出资产；23 条历史测试账号警告未删除 |

本轮还重新运行了编辑、R、跨 Figure、历史、导出、页面、组合、安全和隔离 smoke。所有请求均使用随机 `127.0.0.1` 端口和临时数据库；未访问 3000，未修改 Docker/WSL。

三轮独立代码审查发现的 standalone mode 权威、保存 CAS 绕过、排队保存旧闭包和旧项目 GET/PUT 恢复源不一致均已修复。当前项目保存接口同时执行可信 manifest 预检与 revision/hash CAS；新增 PUT、history、无 manifest、旧 contour 项目和跨 Figure 回归均通过。WP8 的恢复/导出事务证据已补齐，`fill_between`、`contour/contourf`、`hist/stairs/step` 与 `pie/wedge` 已完成专用适配；后续仍需对其余复杂对象、特殊 axes 和性能门禁补齐证据。

第一轮隔离浏览器基线补充结果：

| 流程 | 结果 | 结论 |
|---|---:|---|
| 编辑主流程 | PASS | Draft、应用、导出准备和运行时错误检查通过 |
| 语义编辑中心 | PASS | 语义分组、配色和组件编辑通过 |
| 坐标轴样式 | 8/8 PASS | frame、tick line、grid 隔离、数字自动暂存和字体格式刷通过 |
| 扩展拖拽 | 10/10 PASS | Python 多目标、取消、不支持目标、annotation 和 R native 坐标保护通过 |

`D4-r-native-protection` 已改为不依赖伪造项目 ID 的单图 R fixture；测试继续证明 native 坐标文本不会生成错误位置 patch，而不是跳过该能力边界。

2026-07-19 06:19:06 的 contour/拖拽/导出补充证据：

```text
contour/contourf 使用专用父对象；levels/X/Y/Z 保持只读
contour child collection 标记 parentOwned，现代批量面板不再产生子层 editLog
cmap/vmin/vmax 只在属性声明的 scope 内应用，未声明 cross_figure 时保守留在当前对象
明确命中的只读 SVG 图元不会吸附到附近文本；Ctrl/Shift 多选不会被后续单选回调覆盖
旧 identity-bearing contour child editLog 可加载、保存、导出和快照恢复
contour child 点击在普通和拖拽模式下都重定向到父对象，modifier 可保留两个父对象
其他 Figure 的 stale edit 会阻断项目级代码 patch；全项目导出在全部目标通过前零资产写入
```

2026-07-19 16:22:04 的 `hist/stairs/step` 与保存并发补充证据：

```text
histogram/stairs/step 使用专用 role；普通 bar、手工 StepPatch 和 drawstyle line 不误分类
histogram child patch 标记 parentOwned，点击和批量编辑重定向到父系列
结构参数只读；拒绝请求不增加 revision，不写 session/history/cache/export/snapshot
项目保存要求 baseRevision + baseEditLogHash，旧请求不能覆盖新 editLog/history
语义相同的旧项目 payload 可保存名称/spec，但 Figure 状态保持原样
排队保存等待最新 React 状态；旧响应不清除请求期间产生的新 Draft
保存刷新、撤销重做、跨 Figure、四格式导出和导出快照恢复一致
```

版本边界：开发、预发布和生产应使用同一套固定 renderer 镜像及精确依赖。上一生产/验证环境只在升级窗口内作为旧项目迁移门禁，不是长期支持矩阵；历史 manifest/editLog 兼容必须由数据协议测试证明，不能靠同时运行多套 renderer 规避。

2026-07-19 19:51:21 的 `pie/wedge` 补充证据：

```text
Axes.pie 扇区、类别标签、autopct 数值标签和关联 legend marker 使用 pieId + sliceIndex 建立双向关系
手工 Wedge 与 pie slice 分开分类；普通 patch、bar 和普通 legend marker 不被误归类
选中单个扇区跨 Figure 只映射对应扇区及其唯一关联 marker，不扩散到同图其他扇区
不同 pieId、同分重复候选和缺失关系元数据均跳过，不按数组顺序猜测
values/角度/圆心/半径/width/explode 等结构参数只读，拒绝操作不产生 Draft 或持久化副作用
Python 语义工作流、跨 Figure 18/18、26 项定向单测、Matplotlib 3.8.4 定向门禁和生产构建通过
独立 5.5 high 审查 APPROVE，0 HIGH、0 MEDIUM；唯一 LOW 已 fail-closed 修复并回归
```

2026-07-18 21:03:51 的 WP3/WP4 补充证据：

```text
统一 propertyPatchMode helper 已接入 EditingIntent、target resolver、palette、右侧编辑中心和左侧图层树
项目 PUT 的 editLog/history 保存先预检后单事务写入
显式跨 Figure 对象默认一对一映射；组件语义组通过 crossFigure: allow 保留有意 fanout
现代 manifest 缺少 capability 属性时前端不再生成可应用 patch
```

## 3. 不可触碰边界

### 3.1 用户数据

- 不得删除、清空、重命名、迁移或覆盖真实 `data/`。
- 不得用 fixture、临时账号或测试项目替换真实项目。
- 数据库、项目、Figure、session、上传文件、历史或导出资产相关修改，前后必须运行只读 `npm run data:audit`。
- 恢复脚本默认只能 dry-run；带 `--apply` 的恢复或迁移需要单独授权和备份。
- 任何用户数据数量、项目归属、文件哈希或引用完整性变化都阻断继续执行。

### 3.2 本机服务

- 自动化测试不得使用现有 `http://localhost:3000`。
- 自动化测试必须通过 `scripts/testing/run_with_isolated_server.mjs` 使用临时端口和临时 `SCIFIGURE_DATA_DIR`。
- 不得停止或修改本机 3000、Docker Desktop、WSL 或 sub2api。
- 测试结束后必须确认临时监听端口和临时服务已经退出。

### 3.3 代码和版本

- 不得整线合并旧 `unified-editing`、`security`、`admin-console` 或其他历史工作树。
- 不得用旧版文件覆盖当前主线文件。
- 不得删除现有功能来让新测试通过。
- 不得执行破坏性 Git 历史重写，除非用户单独授权。
- 未经明确要求不得推送或部署。

## 4. 平台功能基线

### 4.1 访问、认证和导航

| 必须保持的行为 | 回归入口 |
|---|---|
| 未登录访问优先进入宣传页；登录或注册后进入平台 | `test:public-auth-smoke` |
| 帮助页可从公开和登录状态访问，内容面向用户而不是开发者 | `test:help-center-smoke` |
| 项目、数据、导出、组合和设置导航保持当前返回关系 | `test:navigation-reconfigure-smoke`、`test:behavior-smoke` |
| 首页仪表盘、项目列表、模板、数据文件和设置页面保持可进入、可返回且不丢登录状态 | `test:workspace-visual-smoke`、`test:navigation-reconfigure-smoke`、`test:behavior-smoke` |
| 账号级资产库不能错误显示“未登录”或只查询当前项目 | `test:export-library-global-smoke` |
| 用户只能读取自己的项目、文件、Figure 和导出资产 | `test:user-isolation` |

### 4.2 项目创建、脚本和数据文件

| 必须保持的行为 | 回归入口 |
|---|---|
| 新建项目使用“脚本优先”，先识别脚本引用的数据文件名 | `test:navigation-reconfigure-smoke` |
| 未发现固定文件名时只提示，不限制用户上传其他表 | 项目创建浏览器回归 |
| 首屏脚本上传区支持点击和真实拖放；文案声明支持拖入时必须存在对应 drop 行为 | `test:behavior-smoke`、`test:drag-extended-smoke` |
| 一个项目可上传多张 CSV/Excel，脚本必须按明确文件名读取 | 组合项目/API fixture |
| 重新配置保留 projectId、已有文件、Figure 历史和导出资产 | `test:navigation-reconfigure-smoke` |
| `ProjectCreatePage`、脚本先行导入和 `ProjectReconfigurePage` 保持当前流程；旧 `DataImportPage` 只保留兼容入口，不重新成为默认主流程 | `test:navigation-reconfigure-smoke`、`test:behavior-smoke` |
| 代码面板支持修改、同步渲染、撤回和代码历史 | `test:code-history-smoke` |

### 4.3 Python/R 渲染与协议

| 必须保持的行为 | 回归入口 |
|---|---|
| Python Matplotlib 与 R ggplot2 保持两套 renderer、一个前端协议 | `test:capability-matrix`、Python/R renderer tests |
| renderer manifest 是对象事实来源，前端不得根据 SVG 距离猜测高风险关系 | introspection/target resolver tests |
| 旧 manifest 缺少 `identity/propertyCapabilities` 时继续可读 | StandardFigureModel tests |
| `gid/editable/currentProps` 和现有 patch wire format继续兼容 | 单元测试和 API smoke |
| unsupported/ambiguous 对象必须跳过并说明，不得伪装可编辑 | capability/target resolver tests |
| 共享前端协议修改必须同时验证 Python 和 R | Python/R 双 renderer gate |
| Monaco 代码编辑器继续使用同源静态资源，不因前端升级恢复为外部 CDN 依赖 | 生产构建、仓库边界检查；当前缺专项 smoke |

### 4.4 图元选择和图层结构

| 必须保持的行为 | 回归入口 |
|---|---|
| 拖拽关闭时，画布单击可精确选择对象并打开属性 | `test:behavior-smoke` |
| 左侧图层树与画布选择同步，搜索使用完整对象集 | `test:large-figure-ui-smoke` |
| Ctrl/Cmd 可取消多选中的单个对象，框选不能丢失目标 | 组件/拖拽 smoke |
| 子图选择后所有编辑中心自动跟随该子图；跨子图选择回退全部子图 | `test:subplot-scope-follow` |
| figure-level legend、共享 colorbar 和 twin axes 不得错误归入普通子图 | capability/component tests |
| 重叠或歧义对象不得自动选择“最像”的一个 | target resolver tests |

### 4.5 五个编辑中心

#### 属性编辑

- 单对象修改不得扩大到同角色的其他对象。
- 文本、axis label、tick label、tick line、spine、legend 和 colorbar 必须保持职责分离。
- 控件只能在 renderer 声明支持时可编辑；只读状态必须解释原因。

#### 布局中心

- “仅调整上下行间距”只能修改相关 `subplot/colorbar.bottom`。
- 整体网格重排和物理尺寸重建必须继续明确说明会重算宽高或画布。
- 子图交换只交换位置，不交换数据、样式、历史身份。
- 色条对齐继续按真实 owner subplot 和联合边界工作。

#### 组件中心

- line、point、bar、errorbar、stem、boxplot、violin、annotation、legend、grid、spine、heatmap 和 colorbar 继续分组。
- 容器存在时不得重复修改其 children。
- 整组修改必须覆盖全部支持目标；部分支持时明确显示跳过数量。
- 网格显隐与图例边框继续进入 Draft，并在应用时后端重绘。

#### 配色中心

- 同色不同语义组保持隔离。
- 数据列或向量颜色不得把整个 collection 错染为一种颜色。
- palette 常量写回与精确对象 fallback 保持同一批次。
- 作用范围、已绑定/未绑定状态和重渲染后的再次选择能力保持一致。

#### 字体中心

- 字体家族、字号、字重、字形和颜色保持可用。
- 组件中心和坐标轴系统的字体投影不得变成只读或无效控件。
- 格式刷只复制字体样式，不复制文本、位置或旋转。
- Times New Roman 等字体必须以 renderer 实际字体为准，不能只回显选择值。

对应入口：`test:semantic-smoke`、`test:axis-style-semantics-smoke`、`test:component-container-smoke`、`test:subplot-scope-follow`。

### 4.6 Draft、应用和渲染调度

- 有效控件输入后自动进入 Draft，不要求 Enter 或失焦。
- 同一 `gid/prop` 保持 last-write-wins。
- 切换编辑中心不得清空或隐藏已有 Draft。
- “应用当前图”默认只重绘当前 Figure。
- local patch 只能用于可精确预览且可直接持久化的属性。
- 创建、删除或重建 renderer artist 的属性必须使用 backend patch。
- 每个 Figure 保持独立 `requestId/baseRevision`；旧响应不得覆盖新结果。
- 部分失败只清除成功目标草稿，失败目标保留并可重试。
- 一次应用形成一个历史动作，不能按底层 patch 数拆成多步。

### 4.7 拖拽和位置

- 拖拽开启后无需按空格。
- 拖动时对象在目标位置实时显示，不只显示选框。
- 松手只累计最终位置，不连续调用 renderer。
- 确认后进入一次 Draft/历史；取消恢复全部目标。
- 多对象累计位移保持各自独立基准。
- 文本、legend container 和 annotation anchor 使用各自坐标契约。
- tick label 等不稳定子对象不得开放独立位置重放。
- callable、offset points 和混合 transform 等不可证明坐标继续拒绝写回。

对应入口：`test:drag-extended-smoke`、`test:behavior-smoke`。

### 4.8 多 Figure、跨 Figure 和组合布局

- 每个 Figure 保留独立 script、manifest、editLog、revision、history 和选择状态。
- 当前 Figure 修改不得串到其他 Figure。
- 内容、位置和布局默认禁止跨 Figure。
- 样式跨图必须唯一匹配；歧义跳过并报告。
- 切换 Figure 时只挂载活动 Figure，其他 Figure 状态不得丢失。
- 组合项目来源排序、物理 axes 尺寸、复制数据文件和提示词保持一致。
- 组合提示词必须使用源 Figure 当前已编辑脚本，而不是初始脚本。

对应入口：`test:multi-figure-ui-state-smoke`、`test:cross-figure-smoke`、`test:cross-figure-concurrency`、`test:composition-code-project`、`test:composition-selector-ui-smoke`、`test:composer-smoke`、`test:composer-stale-smoke`。

### 4.9 历史、保存、导出和恢复

- 保存、刷新、退出重进后恢复同一 Figure revision、editLog、history 和视觉结果。
- 过期自动保存、同 revision 缺 hash 和 hash 漂移请求必须 409 且零写入；旧项目无状态保存不得被误伤。
- 保存请求期间产生的新 Draft 不得被旧响应清除；排队保存必须基于最新提交后的状态。
- 撤销/重做恢复 SVG、manifest、editLog 和 revision 的一致状态。
- 导出必须使用最后一次成功预览状态，不得退回初始脚本尺寸或样式。
- SVG、PNG、PDF、TIFF 和子图导出保持格式、DPI、方向和尺寸一致。
- 导出资产与不可变编辑快照原子关联。
- 恢复导出状态前校验所有权、Figure 结构和数据哈希，并先保存当前检查点。
- 旧资产无快照时保持可下载，但不得虚报可恢复。
- 账号级历史资产、当前项目筛选和物理文件完整性保持一致。

对应入口：`test:project-history-persistence`、`test:export-matrix-smoke`、`test:export-snapshot-db`、`test:export-snapshot-restore`、`test:export-snapshot-restore-ui`、`test:export-library-global-smoke`。

### 4.10 安全、管理员和运行边界

- 认证、所有权、路径边界和 renderer 沙箱不得因功能或性能优化被绕过。
- Python/R 用户代码不得访问主数据库、`.env`、项目根目录或外网。
- 正常科研脚本必须与恶意输入同时测试，不能靠扩大黑名单误伤正常功能。
- 管理员 API 保持独立授权与审计；普通用户不能通过隐藏路由访问。
- 生产密钥、TLS、防火墙、备份恢复等部署事项不以本地测试代替。

对应入口：`test:security-baseline`、`test:user-isolation`、`test:auth-refresh`、`test:admin-authorization`、`test:r-security-precheck`、`test:renderer-sandbox`、`security:repo-boundary`。

### 4.11 页面工具与辅助视图

- `HomeDashboard`、`TemplatesPage`、`DataFilesPage` 和 `SettingsPage` 是现有产品页面，不得在编辑链路升级中被隐藏、改回旧入口或破坏返回关系。
- `ChartPreview` 的选择、拖拽和 Draft 预览，`ManifestViewer` 的图元搜索与能力诊断，均须继续读取当前 Figure，不能串到其他 Figure。
- `WordA4Preview` 保持当前真实尺寸、方向和导出状态投影；编辑器预览、Word/A4 预览与实际导出不得使用三套不同状态。
- `ExportLibraryPage` 保持账号级资产、项目筛选、下载和导出时状态恢复入口。
- `ComposerPage` 与组合项目选择器保持来源排序、物理 axes 尺寸、当前编辑脚本和 stale source 检测。
- 帮助中心的快速上手、科研模板和 AI 提示词面向最终用户；开发者安全细节不得直接暴露为攻击说明。

对应入口：`test:workspace-visual-smoke`、`test:help-center-smoke`、`test:export-matrix-smoke`、`test:export-library-global-smoke`、`test:export-snapshot-restore-ui`、`test:composer-smoke`、`test:composer-stale-smoke`、`test:composition-selector-ui-smoke`。

当前直接证据缺口：Word/A4 物理尺寸数学、帮助页模板数量与复制文本、Monaco 同源加载和工作区视觉 token 尚无各自独立命名的专项 smoke；在补齐前只能引用间接回归，不能宣称专项覆盖已经完成。

## 5. Python 当前不可退化能力

Python renderer 当前已经识别并提供稳定编辑入口的基础对象包括：

```text
Figure / Subplot / Axes
Text / axis label / tick label / tick style
Spine / axes frame / grid
Line / Patch / Collection
Bar / Errorbar / Stem / Boxplot / Violin container
Fill-between / Contour / Histogram / Stairs / Step / Pie / Wedge 专用语义
Legend container / title / text / marker
Heatmap / Colorbar
Annotation text / arrow / anchor
Multi-Figure / twin/shared axes relationship
```

任何 Python 能力增强必须保持：

1. 现有对象数量不因新增 adapter 无故减少。
2. 现有 GID 和旧 editLog 继续可重放。
3. 容器新增关系不能让 children 重复进入批量修改。
4. 同色不同组、向量颜色和数据驱动颜色继续保持隔离。
5. legend、colorbar、annotation 和 twin axes 的关系继续双向一致。
6. 复杂对象若不能稳定写回，必须降级为 readonly/unsupported，而不是错误编辑。
7. Python 增强不得因共享协议变化降低 R 的真实能力或放宽 R 的 unsupported 边界。

当前尚不能宣称完整覆盖的范围包括：

```text
结构变化后的对象身份迁移
任意第三方 Matplotlib Artist
3D、地图投影、broken/inset/secondary axes 的完整位置编辑
stackplot、quiver、streamplot 等尚未完成的专用语义容器
超大数据图的交互性能
全部真实科研项目和全部视觉截图基线
```

这些是后续增强项，不允许为了“完整”宣传而伪装为已支持。

## 6. 回归测试分级与证据复用

验证按改动影响范围分层，避免每写一处代码就重复执行全部历史门禁：

1. 开发循环：只运行改动文件的单元测试，并追加一条直接相关的真实用户工作流。
2. 工作包收敛：运行共享路径门禁，例如 renderer、manifest、target resolver、Draft、跨 Figure 或导出中实际受影响的部分。
3. 阶段或发布候选：集中运行一次完整回归、安全门禁、构建和数据审计。
4. 每条证据记录代码基线 SHA、未提交差异范围、runtime/依赖版本、命令、时间与结果。
5. 上下文切换不使证据自动失效。只有相关文件、依赖版本、基线 SHA 或测试前置条件变化时才重跑。

当前工作包未提交时使用“父 commit SHA + 明确工作包差异”作为候选键；形成提交后，后续工作包直接使用新 commit SHA。不得把较早全量结果冒充为最终改动的新鲜证据，必须同时列出最终改动的 changed-path gate。

### 6.1 `pie/wedge` 证据台账

| 代码键 | Runtime / 版本 | 命令或证据 | 时间 | 结果 |
|---|---|---|---|---|
| `986767c + pie/wedge worktree` | 本地 renderer / Matplotlib 3.7.2 基线 | `npm run test:python-semantic-workflow` | 2026-07-19 | PASS，含导出与快照恢复 |
| `986767c + pie/wedge worktree` | Chromium 隔离服务 | `npm run test:cross-figure-smoke` | 2026-07-19 19:49 +08:00 | 18/18 PASS |
| `986767c + pie/wedge worktree` | Vitest | `npm test -- src/utils/semanticPatchMapping.test.ts` | 2026-07-19 19:49 +08:00 | 4 文件 / 26 项 PASS |
| `986767c + pie/wedge worktree` | Python 3.12 / Matplotlib 3.8.4 临时容器 | 三项 pie identity + Python capability matrix | 2026-07-19 | 4/4 PASS；wheel SHA-256 已核对 |
| `986767c + pie/wedge worktree` | TypeScript / Vite | `npm run lint`、`npm run build`、`git diff --check` | 2026-07-19 | PASS；仅既有 bundle/CJS 警告 |
| `986767c + pie/wedge worktree` | 独立 gpt-5.5 high | 最终代码审查 | 2026-07-19 | APPROVE；0 HIGH、0 MEDIUM；唯一 LOW 已修复并回归 |

最近一次完整 Vitest 为 1006/1006，发生在最终 pie 语义映射收敛前；之后没有重跑无关全量，而是用上表 26 项单元测试和 18/18 真实跨 Figure 工作流覆盖最终改动。下一次完整回归安排在 Python 阶段候选，而不是在每个对象家族内重复执行。

### Gate A：任何代码修改

```text
npm run lint
改动文件对应的定向单元测试
一条直接相关的真实工作流
git diff --check
```

### Gate B：Python renderer 或图元协议修改

```text
python -m unittest tests.test_introspection
npm run test:capability-matrix
npm run test:component-kind-matrix
npm run test:semantic-smoke
npm run test:component-container-smoke
npm run test:axis-style-semantics-smoke
npm run test:python-semantic-workflow
npm run test:patch-rejection-persistence
npm run test:cache-smoke
npm run build
```

共享 `manifest/identity/propertyCapabilities/EditingIntent/target resolver` 修改还必须追加 R renderer、R semantic smoke 和跨 Figure smoke。

若修改触及共享 patch、session、history、export metadata 或恢复协议，还必须追加：

```text
npm run test:r-semantic-smoke
npm run test:r-security-precheck
npm run test:cross-figure-smoke
npm run test:project-history-persistence
npm run test:export-matrix-smoke
npm run test:composition-code-project
```

### Gate C：Draft、拖拽、历史、布局或导出修改

按影响范围至少追加：

```text
npm run test:behavior-smoke
npm run test:multisubplot-smoke
npm run test:subplot-scope-follow
npm run test:drag-extended-smoke
npm run test:multi-figure-ui-state-smoke
npm run test:cross-figure-smoke
npm run test:code-history-smoke
npm run test:export-matrix-smoke
npm run test:export-snapshot-restore
npm run test:export-snapshot-restore-ui
npm run test:export-library-global-smoke
npm run test:composer-smoke
npm run test:composer-stale-smoke
npm run test:composition-selector-ui-smoke
npm run test:navigation-reconfigure-smoke
npm run test:workspace-visual-smoke
```

### Gate D：候选发布

- 运行一次完整 `npm test`，不得只引用工作包定向结果。
- 运行 Gate A-C 中全部适用项。
- 运行安全、隔离、缓存、组合、导航、帮助和公开认证 smoke。
- 执行生产构建与仓库边界检查。
- 修改前后各执行一次 `npm run data:audit`，问题数必须保持 0。
- 人工检查至少一个 Python、一个 R、一个多 Figure、一个热图色条、一个组合项目。
- 确认临时测试服务退出，3000 和 Docker 状态未被测试改变。

注意：`package.json` 中没有隔离 wrapper 的脚本，在确认其自建临时数据库前不得直接运行；禁止让默认 `SCIFIGURE_URL` 指向 3000。

## 7. 合并阻断条件

出现以下任一情况必须停止合并和部署：

- 现有基线测试失败且无法证明与修改无关。
- 对象数量、identity、relation 或 property capability 无解释退化。
- 控件显示成功但没有 Draft、没有 renderer 写回或刷新后丢失。
- 单对象修改扩大到整组，或整组修改只命中第一个。
- Python 修复导致 R 控件、patch 或导出退化。
- 多 Figure 状态串联、旧响应覆盖新结果或部分失败丢草稿。
- 编辑器预览、导出文件和导出快照不一致。
- 测试访问真实 data、3000、Docker 或创建真实测试账号。
- 数据审计出现新增问题、项目/文件/资产数量异常或所有权变化。
- 新能力缺少关闭开关、独立回滚单位或 unsupported 降级路径。
- renderer 返回 missing gid、unsupported setter、capability mismatch 或其他未应用警告，但服务端仍把该 patch 写入 editLog/history/export snapshot。
- 任一 UI 路径在目标 `propertyCapabilities` 明确要求 backend patch 时仍用硬编码属性表生成 local patch。
- 任一 standalone 或项目 Figure 的服务端 patch 路径仍信任客户端 mode，而未按可信 manifest 分类或保守提升为 backend 验证。
- 导出快照恢复在写数据库前没有证明当前 renderer 可以无错误重放全部目标 Figure。
- 导出文件创建/删除失败时，文件和数据库记录没有补偿清理或回滚语义。
- Python 能力扩展绕过生产 Docker 沙箱或依赖未启用的 AST 检查作为唯一安全边界。

## 8. 基线变更规则

基线不是只增不减的按钮清单，而是经过证据确认的用户合同。只有满足以下条件才允许更新本文件：

1. 代码已经实现，而不是仅存在计划。
2. 单元、API 或真实浏览器测试能够重复证明。
3. 旧项目兼容和数据边界已经验证。
4. 已记录默认启用条件、已知限制和回滚方式。
5. 文档写明实际修改时间和证据截止时间。

删除或改变既有基线行为属于产品兼容性变更，必须单独评审，不能夹带在图元扩展或性能优化中。
