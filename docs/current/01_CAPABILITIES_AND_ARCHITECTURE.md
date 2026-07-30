# SciFigure 能力与架构副文档

> 状态：当前有效  
> 更新时间：2026-07-30 23:12:16 +08:00
> 证据截止时间：2026-07-30 23:12:16 +08:00
> 复核范围：集成分支 `deploy/prod-integration-v3` 与生产 release `336f64e-jd30`；含 Python WP7/WP10、雷达图专用语义、全渲染事务边界、旧 editLog 兼容，以及 R-WP0-WP10 对象身份、事务边界、显式 diagram 语义、扩展包/base R Shadow 边界和五个编辑中心真实浏览器验收；当前批次已部署
> 适用范围：产品能力、前后端协议、Python/R 渲染、编辑与导出链路

## 1. 总体设计

SciFigure 的核心结构是：

```text
多来源代码和数据
→ 各语言 renderer
→ 图元内省
→ StandardFigureModel
→ EditingIntent
→ Draft Patch Batch
→ 按 Figure 调度重绘
→ 保存、历史和导出
```

设计目标不是消除 Python/R 差异，而是在可靠边界内统一用户操作和前端协议。

## 2. 前端架构

主要页面：

```text
首页和项目列表
项目创建与代码编辑
数据文件
Figure 编辑器
导出设置和资产库
组合图工作台
设置与账号
```

核心编辑状态：

```text
当前项目和 Figure
Figure session/revision
manifest 与标准图形模型
当前选中对象和语义作用域
draft patches
pending drag patches
历史与导出锚点
per-figure render status/requestId
```

普通对象编辑不应直接依赖 renderer 语言。语言差异应在模型归一化、能力声明和后端 patch 阶段处理。

### 2.1 页面导航与项目配置

```text
导出资产页返回：记录进入资产页前的真实来源，返回到该页面
新建项目：脚本优先 → 提取引用的数据文件名 → 补齐或追加多张表 → 创建项目
重新配置：保留 projectId、已有数据、Figure editLog/history 和导出资产
             → 可替换脚本、追加文件 → 保存配置 → 项目级重新渲染
旧 DataImportPage：保留兼容路由，但不再作为顶栏、首页或新建项目主入口
```

脚本数据依赖提取当前覆盖 Python/R 常见显式文件读取方式，包括 `_uploaded_file_paths`、`uploaded_file_paths`、`read_csv`、`read_excel`、`read.csv` 和 `readxl::read_excel`。提取结果只用于用户提示，不执行脚本，也不限制用户上传额外数据文件。

重新配置默认只追加新文件，不静默替换或删除已有文件。缺失脚本依赖时允许用户继续，但必须二次确认；保存时继续携带现有 Figure 的 editLog、revision 和 history。

## 3. 后端架构

Node/Express 负责：

```text
账号和会话
项目、文件和 Figure 元数据
渲染和 patch API
按 Figure revision/requestId 调度
用户数据所有权检查
导出资产和组合项目
渲染缓存
安全预检和 Docker renderer
```

SQLite 保存：

```text
users/auth_sessions/devices
projects/project_files/project_figures/sessions
export_assets
subscriptions/redeem_codes/redeem_records
admin_audit_logs
```

用户上传数据和导出文件保存在项目目录，数据库保存所有权、路径和元数据。任何路径读取都必须经过项目所有权和目录边界检查。

### 3.1 持久化状态边界

升级时必须同时检查以下状态，不能只验证 SVG 是否还能显示：

| 状态 | 主存储 | 作用域 | 典型遗漏后果 |
|---|---|---|---|
| 项目与脚本 | `projects` | 账号内项目 | 项目不可见、代码回退 |
| 上传数据 | `project_files` + 项目文件目录 | 当前项目 | 重绘报缺文件 |
| Figure 当前编辑 | `project_figures.edit_log/revision` | 当前 Figure | 刷新后修改消失 |
| 撤销/重做与代码历史 | `project_figures.history` | 当前 Figure/项目代码锚点 | 历史记录消失 |
| 运行 session | `sessions` | Figure session | patch、组合或导出链路降级 |
| 导出记录 | `export_assets` + 导出文件 | 账号全局或明确项目筛选 | 历史资产看似丢失 |
| 临时草稿与选择 | React state/sessionStorage | 当前浏览器会话 | 切页后草稿或选中状态变化 |

账号级页面必须使用账号级 API，并明确提供项目筛选；项目级页面必须明确写“当前项目”。UI 空状态不能把“当前项目没有记录”表述为“账号没有历史”。

`project_figures` 是编辑日志、revision 和 history 的持久化事实来源；`sessions` 是运行链路所需副本。当前清理逻辑不得删除被 `project_figures.session_id` 引用的 session，完整性审计会检查两者是否一致。

项目保存使用乐观并发控制。当前客户端提交 Figure 状态时携带 `baseRevision` 和稳定 `baseEditLogHash`；服务端在事务前比较当前恢复态，冲突返回 409 且不写 project、session、history、cache、导出锚点或快照。缺 CAS 的旧请求只有在 editLog/history 语义完全未变时才可保存名称或 spec，并保持 Figure 状态原样。GET/PUT 统一按“非空 session → `project_figures.edit_log` → 单 Figure 旧 `spec.editLog`”恢复，避免旧项目加载与保存使用不同事实来源。

自动保存不在 renderer 工作或 Draft 未结算时启动。同一时刻只允许一个保存请求；排队请求在下一次 React 状态提交后读取最新 Figure/Draft。旧响应只清除值与已持久化快照完全一致的 Draft，用户在请求期间修改的新值继续保留。

## 4. 两引擎一协议

### Python

Python renderer 以 Matplotlib 为主，内省对象包括：

```text
Figure
Axes/Subplot
Text
Axis label
Tick label/tick line
Spine/axes frame
Line
Patch
Collection/scatter
Legend/title/text/marker
Colorbar
Annotation/arrow
Histogram series / parent-owned bars
Stairs / step series
```

Python 路径在 artist 级对象定位、坐标变换和细粒度属性写回方面更成熟。

### R

R renderer 以 ggplot2、grob 和 SVG 语义映射为主，当前覆盖：

```text
标题、轴标签和刻度文本
theme 字体和样式
ggplot layer 整体样式
scale/aes 分组颜色
facet panel
heatmap 与连续色标
legend 和 colorbar
文本 annotation
基础拖拽和位置 patch
```

R 不承诺任意 SVG 节点都能像 Matplotlib artist 一样写回。复杂坐标、二次扩展包生成对象和 base R 图形仍需专项适配。

### 统一协议

StandardFigureModel 统一暴露：

```text
对象 id/gid
kind/role
figureId/subplotId
bounds/position
editable/read-only/unsupported 能力
属性值
语义分组
语言和来源信息
```

当前 renderer 会增量输出 `identity` 和 `propertyCapabilities` metadata，用于对象身份稳定性、容器关系、属性级作用域和重放能力。字体中心、组件中心和配色中心已经通过各自独立 feature flag 受控接入严格 resolver；未迁移入口以及缺少新字段的旧项目继续使用 `gid/editable/currentProps` 兼容路径。重复身份或明确关系冲突不会回退到猜测规则。

renderer 返回的 `manifest` 仍是渲染事实来源，StandardFigureModel 是前端归一化消费模型，不替代 Python/R 原始 manifest。

EditingIntent 统一表达：

```text
用户想改什么
目标对象或语义角色
作用于当前对象、当前子图、当前 Figure、选中 Figure 或全部 Figure
属性和值
无法应用时的跳过原因
```

它解决“用户意图”和“renderer 具体 patch”之间的映射，不负责 AI 自动改图。

当前真实接口仍是前端编译 EditingIntent 为 patch 后调用 `/api/figure/patch`。历史设计中的 `/api/figure/intent`、后端直接按 intent 修改 AST 和 intent 级数据库历史尚未落地。

## 5. 图元识别与选择

对象选择入口包括：

```text
画布单击
图层结构
组件中心
字体中心
配色中心
子图面板
语义组选择
```

单击模式和拖拽模式必须互斥：

```text
拖拽关闭：点击选择对象并在属性编辑中修改
拖拽开启：直接拖动可定位对象，积累最终位置 patch
```

子图选择后应显示对应绘图区选框。多子图识别按实际 axes bounds 和空间关系工作，不写死 2x2、2x4 等固定模板。

## 6. 编辑能力

### 文本

```text
文本内容
字体族
字号
粗体/斜体
颜色
对齐
旋转
上下标
换行
可见性
位置
```

下划线等能力只有 renderer 和目标对象可靠支持时才应开放，不能只在前端显示无效控件。

### 坐标轴

```text
axis label 与 tick label 分离
单个 tick 与整组 tick 分离
文字颜色与刻度线颜色分离
tick 文本旋转
轴标签整体平移
刻度文本整体平移但不改变 tick 位置
spine 颜色、线宽和可见性
```

位置编辑必须尊重坐标系。数据坐标文本、axes fraction、figure fraction、display pixel 和 legend 内部布局不能使用同一个位移公式。

### 图例和色条

```text
图例整体位置
图例文字
图例 marker/line/patch
marker scale
文字与符号对齐
共享或独立图例
colorbar 距主图间距
colorbar 宽度、标签和刻度
```

图例移动必须优先移动 legend 容器，不把内部文字和 marker 拆散写回。

### 线、点和填充

```text
颜色
线宽
线型
marker 大小
marker 边框
透明度
填充色
分组颜色语义
```

批量改颜色必须依赖稳定的系列身份、layer/scale 或 semantic key，不能只按当前颜色匹配，否则两个分组可能被连带修改。

## 7. 字体中心、组件中心和配色中心

### 字体中心

按语义角色组织：

```text
标题
X/Y 轴标签
X/Y 刻度
图例文字和图例标题
annotation
colorbar label/tick
```

组内修改通过 EditingIntent 找到对应角色，不应只修改第一个命中对象。

### 组件中心

主要分类：

```text
文本
坐标轴和边框
线
散点/collection
填充和 patch
图例
色条
annotation
子图/axes
```

边框应作为独立分类，并提供整组选中后的线宽、颜色、可见性等共同属性。

### 配色中心

颜色修改按对象身份和语义系列绑定。单一分组修改只作用于该分组；跨 Figure 批量应用需要显式语义作用域和映射报告。

### 编辑中心一致性升级（受控迁移中）

组件、字体和配色中心的子图作用范围跟随统一选择状态：单选对象或同一子图内多选时自动切换到对应子图；跨子图多选、共享对象、全图对象和 `Figure` 选择回到“全部子图”。用户仍可临时手动切换范围；右侧中心内部的“选中整组”保留该显式范围，下一次画布或图层直接选择才重新按真实对象归属同步。配色范围不是 `all` 时，普通颜色修改和科研配色预设都只能产生当前子图对象补丁，不得生成全局代码常量补丁。

当前五个中心已经具备各自的主要能力。网页统一版已接入“统一属性描述器 + renderer 属性能力 + 中心职责投影”，用于共同处理属性状态、目标解析、Draft 和 patch mode；专项方案 `docs/platform-capability/UNIFIED_EDITING_CENTERS_UPGRADE_PLAN.md` 继续作为迁移和回归约束。

五个中心不会变成相同面板：属性编辑仍是单对象完整检查器，字体中心负责语义角色排版，组件中心负责结构类别，配色中心负责颜色绑定，布局中心负责几何。2026-07-16 候选增加统一选择作用域：单选图元后自动解析所属 subplot，组件、字体和布局中心随之切换，配色中心投影该选中对象；跨子图多选回退到全部子图。手动作用域只保留到下一次选择。

## 8. Draft Patch Batch

需要后端重绘的连续修改先进入草稿：

```text
字体族、字号、粗斜体
颜色
线宽和线型
坐标范围
子图尺寸和间距
```

同一目标同一属性使用 last-write-wins。点击“应用”后：

```text
草稿去重
编译为 patch batch
只更新受影响 Figure
单次进入历史
单次后端渲染
```

应用事务按 Figure 结算：成功目标提交 revision/history，失败目标保留 `pendingFigureIds`。部分失败后的再次应用只调度失败 Figure；请求执行期间用户重新修改同一属性时，新草稿不会被旧请求清除。等待失败重试的草稿也不会被普通保存动作直接消费。

拖拽保留自己的确认流程，但最终可复用同一批量 patch 和历史基础设施。

V2 数值控件在输入形成有效数字时立即写入 Draft，不再要求 Enter 或失焦；无效中间态仍只保留在输入框。字体格式刷只复制字体族、字号、字重、字形和颜色，不复制文字内容或位置。向量颜色子集 patch 使用 `matchColor` 参与 Draft key、传输、压缩和 renderer 重放，允许同一 collection 的多个颜色组分别保留。

## 9. 按 Figure 调度

每个 Figure 应独立维护：

```text
revision
requestId
renderStatus
lastSuccessfulRender
cache key
error
```

修改 Figure 2 时只重绘 Figure 2。跨 Figure 批量操作按用户勾选的 Figure 集合调度，并使用受控并发队列。

stale response guard 必须丢弃旧 requestId 返回，防止较慢请求覆盖较新结果。

## 10. 拖拽

拖拽过程只在前端预览，不持续调用后端。松手时记录最终参数：

```text
开始位置
最终显示位置
目标对象坐标系
最终 position patch
```

用户可以连续拖动多个目标。确认时一次提交全部 pending patches，取消时恢复拖拽前状态。

标准 Matplotlib Annotation 已拆分为明确关系：`text.*` 保持原文本 gid，`annotation_arrow.*` 作为箭头样式对象，`position` 表示文字端，`anchor_position` 表示指向端。拖动文字只提交文本位置，箭头由 Matplotlib 自动保持连接；pending patch 使用 session + instanceKey 去重。R 的 GeomText/GeomLabel 声明 annotation 文本身份，但不会把独立 GeomSegment/GeomCurve 按空间距离猜成同一箭头。

高风险对象：

```text
annotation 与箭头标签
数据坐标文本
tick label 组
legend 内部对象
colorbar 相关文字
跨 subplot 对象
```

这些对象必须使用明确坐标转换和稳定 gid，不能用最近一次选中对象替代当前目标。

## 11. 多子图与布局

平台区分：

```text
Figure 画布尺寸
subplot/axes 绘图区尺寸
subplot 间距
外边距
图例和 colorbar 占用空间
```

改变画布可以有两种模式：

```text
缩放全图：子图比例随画布变化
固定绘图区：保持 axes 物理宽高，反算 Figure 尺寸和边距
```

布局能力包括：

```text
自动识别行列
1xn、nx1 和常用网格重排
水平/垂直间距
紧凑、标准、宽松密度
恢复原图布局但保留字体颜色等编辑
子图位置交换
单个子图扩展到指定参考边界
统一子图绘图区物理尺寸
```

密度预设只能调整当前选中布局的间距，不能擅自把 4x2 改成 3x3。

“只调整行间垂直间距”使用 `bottom` patch 移动下方各行，保持子图 `left/width/height` 和画布不变；显式关联的 colorbar 只同步相同垂直位移。该操作与整套网格重排分开，避免调整上下间距时破坏已经对齐的宽度和色条。

## 12. 保存、历史和导出锚点

保存成功必须持久化：

```text
脚本
editLog
revision
Figure session
项目 Figure 关系
必要的 manifest/preview
```

刷新后应从服务器恢复，不依赖浏览器临时状态。

项目所有权和历史持久化属于编辑能力的一部分，而不只是账号安全：

```text
project/user_id 必须来自认证用户
legacy 项目只能由显式配置的目标账号认领
project_figures 独立保存 editLog/history
临时 session 清理不得删除项目引用
测试账号必须使用临时数据库，不能接管真实项目
```

历史记录按编辑批次组织。导出不是单独插入一条编辑历史，而是在对应 revision 上记录导出锚点：

```text
第一次导出
第二次导出
上次导出
```

这样可以定位用户当时真正导出的版式。

2026-07-16 网页候选将“导出锚点”升级为资产级不可变编辑快照。新资产与快照在同一数据库事务中保存，快照包含项目 spec/script、目标语言、全部 Figure 的 editLog/revision、数据集 ID/名称/列/行数/字节数/SHA-256 以及导出格式参数。旧资产继续下载，但没有快照时不显示为可恢复状态。

恢复流程不直接覆盖当前项目：先校验认证用户所有权、快照与资产/项目关联、Figure 结构、脚本安全和数据集精确成员及哈希；随后把恢复前状态写入 history 检查点，再事务性恢复并重新渲染目标 Figure。新增、删除、替换或同名追加数据文件都会阻止恢复，避免 `_uploaded_file_paths` 别名指向不同内容。

项目导出使用进程内项目级独占锁：先等待在途渲染/编辑结束，再阻止新的渲染、编辑、上传和删除，直到导出文件、资产和快照全部持久化。上传和删除使用同一独占边界。“保存全部 Figure 到图库”检查整个项目的 Draft，任一 Figure 未应用时禁止保存。当前生产拓扑是单 Node/SQLite writer；未来若改为多进程或多节点，必须升级为数据库或外部协调锁。

代码历史按“成功同步渲染”提交，不记录 Monaco 每次键盘输入：

```text
编辑器输入                    -> 代码草稿，不进入项目历史
同步渲染成功                  -> 记录同步前脚本、行级摘要和目标 Figure
渲染失败/漂移取消             -> 不写入代码历史
撤销/重做                     -> 同时恢复脚本与 Figure editLog 并重新渲染
保存/自动保存                 -> 持久化代码版本元数据
刷新后历史                    -> 显示“代码版本”和 +N/-N 行摘要
```

代码版本复用现有 Figure 历史和 `project_figures.history`，不建立第二套互相冲突的撤销系统。项目级代码同步由当时的 active Figure 承载历史入口，但重绘仍覆盖代码实际生成的全部 Figure。

## 13. 导出与组合

支持目标：

```text
SVG
PNG
PDF
TIFF
主图与子图同时导出
格式和 DPI 一致
导出资产库
导出资产恢复到导出时编辑状态
可复现代码和数据包
Word/A4 页面尺寸预览
```

Word 预览区分：

```text
A4 页面
Word 版心
导出物理尺寸
插入后尺寸
页面缩放
估算最终字号
```

组合图推荐路径：

```text
从当前或其他项目选择 Figure
→ 显示缩略图和来源
→ 复制所需代码与数据到新组合代码项目
→ 生成按实际 Figure 数量适配的转写提示词
→ 生成组合代码
→ 按统一 axes 物理尺寸重新渲染
```

该路径比只移动位图更容易保证字体、图例、框线和子图尺寸一致。

### 13.1 组合代码项目选择器升级（C1-C5 已完成阶段验收）

当前能力继续复用跨项目读取 Figure、来源代码回退、数据文件复制和组合提示词 API，没有建立第二套位图拼图模型。本次升级完成了“创建组合代码项目”的 Figure 选择、顺序和布局决策界面。

目标信息架构采用三栏结构：

```text
左栏：来源项目
  → 区分单图项目与组合代码项目
  → 搜索、最近使用、更新时间和项目类型筛选

中栏：Figure 可视化选择
  → 稳定缩略图
  → Figure 编号、子图数量、宽高比、Python/R 来源
  → 图例、色条、代码片段和数据依赖状态

右栏：已选 Figure 与组合预览
  → 拖动排序、移除和交换顺序
  → 显示 panel label 对应关系
  → 实时显示推荐行列数、单个绘图区尺寸和预计组合图尺寸
```

这里的“智能化”优先使用可解释、可复现的确定性规则，不依赖 AI：

```text
按 Figure 数量推荐 1×N、2×2、2×3、2×4、4×2 等候选布局
按来源 Figure 宽高比判断横排、竖排或多行更合适
把 auto 解析为明确结果，例如“推荐 2×3，预计 7.4×5.1 in”
根据目标 axes 宽高、间距、边距、图例和色条预留计算整体物理尺寸
检查是否超过论文单栏、双栏或 Word/A4 版心
检测重复 Figure、重复项目嵌套和组合项目再次嵌套
检查代码片段、数据文件和可重放上下文是否完整
根据实际选择数量生成 panel label，不写死 (a)(b)(c)
```

创建前确认区必须展示：

```text
已选 Figure 数量与顺序
推荐或用户指定的 rows×cols
单个绘图区目标宽高
预计组合图物理尺寸
需要复制的数据文件数量
Python/R 来源分布
panel label 顺序
缺失依赖、重复来源和尺寸超限警告
```

实施阶段：

| 阶段 | 内容 | 验收重点 |
|---|---|---|
| C1 | 来源项目分类、搜索和缩略图网格 | 不再依赖文字盲选；缩略图不拉伸、不串项目 |
| C2 | 已选队列、拖动排序、移除和 panel label | 顺序与最终提示词、代码和标签完全一致 |
| C3 | auto 布局解析和实时尺寸预览 | 显示明确 rows×cols 与整体物理尺寸，不只显示 `auto` |
| C4 | 重复、依赖、嵌套和版面风险检查 | 阻止重复选择，缺失项可定位并说明原因 |
| C5 | 大项目性能与回归 | 缩略图使用 memo、稳定占位和 `content-visibility`，不删除真实 Figure 语义 |

当前实现结果：

```text
C1：项目名称搜索、单图/多图/组合项目筛选、最近使用筛选、更新时间和 Figure 数量
C2：缩略图选择、拖动排序、上下移动、移除、动态 panel label 和行列位置
C3：auto 解析为具体 rows×cols，显示绘图区尺寸和预计整体英寸尺寸
C4：前后端共同阻止重复来源和缺失数据依赖；提示嵌套组合项目、语言混合、版面超限和代码片段回退
C5：Sanitized SVG 使用 64 项 LRU；IntersectionObserver 只清洗可见区附近缩略图；窄窗口改为可滚动上下布局
```

后端不再信任前端布局结果：`auto` 会再次通过共享 planner 解析为具体布局，容量不足的显式布局返回 400。全 Python 来源生成 Matplotlib `fig.add_axes` 物理绘图区提示词；全 R 来源生成 `ggplotGrob + grid::unit` 提示词；混合来源明确以 Python 为转写目标。

当前限制：

```text
单次最多选择 24 张 Figure
组合代码项目作为来源时显示警告，但不自动递归展开
缺少代码片段时允许使用完整项目脚本回退
缺少脚本引用的数据文件时由后端最终阻断创建
预计尺寸使用固定边距/间距模型，属于创建前估算，最终尺寸仍以生成代码和渲染结果为准
```

实现约束：

- 继续复用现有组合代码项目 API、源文件复制和 AI 提示词契约，不建立第二套组合项目模型。
- 可视化选择只改变前端投影和选择体验，不能改变 Figure identity、codeSlice、数据所有权或来源项目。
- `auto` 推荐必须允许用户覆盖；标准、紧凑、宽松只调整所选布局的间距，不能擅自改变 rows×cols。
- 组合项目作为来源时必须显示嵌套来源和重复风险，不能静默递归复制。
- 非活动缩略图应延迟挂载，避免大量 SVG 同时清洗和渲染造成浏览器卡顿。

验收标准：用户可以在多个项目中依靠缩略图准确选择 Figure，调整最终顺序，看到明确布局与尺寸，理解所有警告，并在不改变现有代码/数据复制结果的前提下创建组合代码项目。

2026-07-12 03:35:38 +08:00 验证证据：

```text
npm run lint                                  PASS
npm test                                      PASS（18 files / 127 tests）
npm run build                                 PASS
npm run test:composition-selector-ui-smoke    PASS（30 Figure、延迟清洗、排序、布局、风险、900/1680 px）
npm run test:composition-code-project         PASS（Python/R、数据复制、布局、依赖、重复来源）
npm run test:multi-figure-ui-state-smoke      PASS（11/11）
npm run test:drag-extended-smoke               PASS
npm run test:public-auth-smoke                 PASS
```

### 13.2 复杂对象精准编辑阶段结果

2026-07-12 04:44:30 +08:00 完成 Batch 17 当前约定范围的阶段验收：

```text
legend container -> title/text/handle 双向关系
shared colorbar -> 全部 mappableIds + owner subplotIds
colorbar child -> colorbarId + 真实 owner subplot 继承
twin/shared axes -> 对称 twin/sharedX/sharedY 关系
tick line color -> axis tick_color
tick label color -> 单独文本 labelcolor/color 路径
```

物理子图计数会排除 twin secondary axes；共享 colorbar 可从任一 owner subplot 解析且不会生成重复 patch。组件中心能显示双轴/共享轴关系，图例符号缩放写回真实 Matplotlib handle。

验证结果：

```text
npm run test:axis-style-semantics-smoke    PASS（5/5）
npm run test:component-container-smoke     PASS（15/15）
npm run test:semantic-smoke                PASS（9/9）
npm run test:multisubplot-smoke            PASS（4/4）
npm run test:drag-extended-smoke            PASS
npm run test:cross-figure-smoke             PASS（9/9）
npm run lint                                PASS
npm test                                    PASS（18 files / 129 tests）
Python introspection                        PASS（36 tests）
Python/R capability matrix                  PASS
npm run build                               PASS
git diff --check                            PASS
```

这表示显式关系和当前 fixture 已通过，不表示任意第三方 annotation、嵌套 parasite axes 或超大真实项目已经全覆盖。

### 13.3 Python 复杂对象父级语义（2026-07-19 21:57:22 +08:00）

`fill_between`、`contour/contourf`、`hist/stairs/step`、`pie/wedge`、`quiver/streamplot` 和显式标记的网络图/路径图/SEM 已从通用 collection/patch/line/container 提升为可审计的专用语义：

```text
fill_between -> fill_between_series -> data_band
contour      -> contour_series      -> 专用父对象
contourf     -> contourf_series     -> 专用父对象 + mappable/colorbar relation
child collection -> contour_child_collection + parentOwned + readonly
hist container   -> histogram_series -> child patch parentOwned
stairs patch     -> stairs_series
step line        -> step_series
Axes.pie slice   -> pie_slice + pieId/sliceIndex
manual Wedge     -> wedge_slice
Quiver           -> quiver + quiver_field，保留 collection.* 历史身份
StreamplotSet    -> container.streamplot.* + streamplot_field
stream children  -> streamplot_child_line/arrow + parentOwned + readonly
diagram node     -> diagram_node
diagram edge     -> diagram_edge + sourceNodeId/targetNodeId
diagram arrow    -> diagram_arrow + edgeId
diagram text     -> diagram_node_label/coefficient_label/fit_annotation
diagram group    -> diagram_group
```

父对象持有可证明的视觉能力；contour、histogram 和 streamplot 的内部 child 只保留用于渲染关系和旧 editLog 重放，现代组件中心、配色中心和批量属性入口不会新建子层编辑。`levels/X/Y/Z/paths/segments`、`bins/counts/edges/values/density/cumulative/orientation/weights/where/x/y/baseline`、pie 数值/角度/几何、quiver 向量/尺度/箭头几何以及 streamplot 密度/起点/积分方向等结构属性不开放。图示对象只允许样式、字体和位置等视觉编辑；路径系数、p 值、显著性、拟合指标、方向和拓扑保持只读。跨 Figure 只有在属性能力明确包含 `cross_figure` 时才允许 fanout；pie、向量场和图示对象还必须分别匹配可信关系，其中图示 edge/arrow/coefficient 需要完整边关系且目标唯一，否则 fail-closed。

兼容范围不是支持任意历史版本：新 manifest 使用 v2 结构 fingerprint；旧 contour child 只在 stableKey/seriesKey 一致且差异仅为已知 fingerprint 漂移时兼容。quiver 保留原 `collection.*` GID/stableKey，streamplot 内部 line/arrow 保留历史 GID，但由新的语义父对象拥有。图示语义只接受脚本通过 `_scifigure_semantic_gid(...)` 提供的显式声明；该 marker 是声明协议，不是认证或科学真实性证明。renderer、项目 patch 预检和快照 dry-run 逐字段比较完整 diagram relation signature，已有部分 identity 不从新 manifest 回填。普通 `LineCollection`、`FancyArrowPatch`、bar、手工 `StepPatch`、drawstyle line、scatter、line、arrow 和 text 保持原分类。项目加载、PUT、history、四格式导出、子图导出和快照恢复均有隔离测试。

### 13.4 Python 特殊 axes 与全渲染提交边界（2026-07-20 08:41:21 +08:00）

特殊坐标轴先建立类型和父子关系，再决定可编辑能力。普通二维轴继续使用原 GID 和能力；特殊轴及其 artist 在 identity relation 中携带 `axesFamily/projection/parentSubplotId/ownerSubplotId`，跨 Figure 映射必须完整匹配该关系。

| 家族 | 当前分类与编辑策略 | 当前证据边界 |
|---|---|---|
| polar / radar | 普通 polar 保持受保护；可信 radar 额外开放维度文字、稳定偏移、图例容器移动、数据线/填充样式和文字背景，布局/投影/数据值只读 | radar renderer 15/15、隔离 API 持久化/刷新/导出、真实浏览器 9/9；普通闭合 polar、混合图例和同样式歧义负例通过 |
| 3D | `three_d_subplot`；Z 轴标签和刻度字体可编辑，相机、投影和 box aspect 只读 | 固定 Python renderer 与浏览器控件通过 |
| inset | `inset_subplot`；保留 parent relation，内容样式按能力开放，bounds/归属只读 | renderer 关系测试通过 |
| secondary x/y | `secondary_xaxis/secondary_yaxis`；归属父 subplot，安全轴文字样式可编辑 | renderer 与 UI scope 测试通过 |
| parasite | `parasite_subplot/parasite_axis`；host/child 关系完整，整族只读 | 固定 Matplotlib 3.7.2 直接回归通过 |
| brokenaxes | `brokenaxes_group` 只读降级协议 | 无依赖 synthetic 分类通过；真实 brokenaxes 包未安装、未验证 |
| GeoAxes/Cartopy | `geo_subplot` 只读降级协议 | 分类代码存在；Cartopy 未安装、真实包测试跳过 |
| 未知自定义投影 | `unsupported_axes`，记录原因并禁止布局/投影编辑 | 畸形投影安全降级通过 |

雷达图不是按“看起来像圆形图”猜测。renderer 只在闭合 line/polygon 的角度数量等于 polar 维度刻度数加闭合点，且各角度与 `xticks` 在单位圆上一一对应时建立 `radarId/radarSeriesId/radarSemanticRole`。高分辨率闭合周期曲线仍是普通 polar，不获得雷达标签拖动或雷达图例位置能力。

可信雷达图的维度名继续使用原 `xtick.*` GID，并新增 `radar_label_offset={dx,dy}` 屏幕点偏移；文字内容、字体和颜色继续使用既有属性。拖动 `legend_text.*` 会归一到 `legend.* position`，保证文字、符号和边框作为一个容器移动；图例文字内容仍可单独修改。只有图例 handle 在全部 axes lines 中唯一命中真实雷达线时才写入 `radarSeriesId`，普通/雷达线样式冲突时保持普通图例文字并拒绝猜测。闭合轮廓线和填充区分别进入“雷达图数据线”和“雷达图填充区域”组件组，同组 line/fill 通过相同 `radarSeriesId` 关联，但颜色、线宽和透明度仍可分别调整。普通 Text 的背景开放 `bbox_visible/facecolor/edgecolor/alpha/linewidth/pad/boxstyle`，不会改变雷达维度、半径数据或系列数值。

特殊轴 editLog 的持久化不是由客户端 mode 或 renderer 是否返回 `success` 单独决定。standalone 与项目全渲染都会在任何写入前执行：

```text
返回 manifest 权威预检
-> renderer warning 与 editLog 对应检查
-> 新日志 relation / stableKey / v2 fingerprint 核验
-> 冲突时返回 conflict 且零持久化
-> 全部通过后提交 session 或项目事务
```

项目全渲染把项目脚本与 Figure/session 替换放入同一 SQLite 事务。数据库中已经存在且 stableKey 一致的旧 editLog 才可按受控规则继续重放；旧条目若已有 fingerprint 或 seriesKey，也必须与当前目标一致，只有 GID 的历史日志保持阻断。客户端新提交的缺失 relation 日志不能借兼容路径进入。导出快照 schema v3 强制完整特殊轴 relation；v1/v2 只在 stableKey 与 v2 fingerprint 同时一致时兼容。

专项验证：`test:special-axes-python` 10 项中 8 通过、Cartopy/brokenaxes 2 项因依赖缺失跳过；`test:special-axes-api`、`test:special-axes-ui`、`test:patch-rejection-persistence`、`test:legacy-contour-project-compatibility`、`test:project-history-persistence`、`test:r-semantic-smoke`、`npm run lint`、`npm run build` 和 `git diff --check` 通过。

### 13.5 R 显式网络图、路径图和 SEM 语义（2026-07-26 18:19:46 +08:00）

R 不从图形外观推断模型结构。脚本必须在图层数据中提供 `.scifigure_semantic_gid`，值使用版本化 `scifigure-sem-v1` marker，并显式给出 diagram、role、object id 及适用的 node/edge/source/target id。renderer 将标记行拆成稳定的一行语义图层，输出与 Python 前端协议一致的 `diagram_node/edge/arrow/node_label/coefficient_label/fit_annotation/group`；未标记点、线、箭头和文字继续使用通用 ggplot role。

专用关系参与 GID、stableKey、seriesKey、fingerprint v2 和 replay identity。GID 同时编码 diagram type、diagram id、完整 semantic role 和 object id；四个字段内容全部使用 Base64URL，ASCII token 固定使用 `a_` 前缀，非 ASCII token 固定使用 `b_` 前缀，因此编码结果和 `.` 字段分隔符均不会造成身份碰撞。manifest 构建期若发现重复完整 diagram identity 生成相同 GID，会直接拒绝渲染，不输出歧义对象。相同 marker 的多行按原顺序聚合为一个语义图层，因此多顶点 path 不会被拆成不可绘制的一行 layer。视觉样式只在 manifest `editable/propertyCapabilities` 明确声明时进入 backend patch；系数、p 值、置信区间、显著性、拟合指标、节点身份、边端点和拓扑不开放。任一非法 diagram patch 会在 setter 前使整批 fail-closed，合法样式不得部分写入 SVG、manifest 或持久化状态。

SVG owner 绑定通常限制在真实 panel clip 内。SEM 常用 `coord_cartesian(clip="off")` 绘制图外关系，可能没有 panel clip group；diagram 场景会从最大有效 panel 边框推导受限范围，普通已建模图层先按原绘制顺序领取通用 owner，显式对象再获得 diagram GID，从而排除图例 key 和图外装饰。只有范围已验证才允许顺序领取；无法证明范围时必须候选精确唯一，否则 unresolved。专项 renderer 10/10、R capability matrix、4 条旧身份兼容、隔离 API 和 Chromium live SVG 正确 tag/样式选择通过；当前未推送、未部署。

### 13.6 R 扩展包和 base R Shadow 边界（2026-07-26 19:26:25 +08:00）

固定 renderer 镜像只声明经过版本固定和镜像校验的 R 包。`ggrepel`、`ggnewscale`、`sf`、`ggraph`、`igraph`、`tidygraph`、`semPlot` 与 `DiagrammeR` 当前不在镜像契约中，因此 runtime inventory 仅以 `find.package()`/`packageVersion()` 报告状态，不加载这些包，也不因开发机偶然安装而开放写回能力。缺包执行返回 `missing_package`、包名和用户可读信息，不返回主机绝对路径。

可渲染的 `GeomTextRepel/GeomLabelRepel`、`GeomNode*/GeomEdge*` 对象在 manifest 中携带 `extensionPackage` 与 `extensionSupport=shadow_unsupported`，但 `editable/propertyCapabilities` 为空；预览和导出保留，不能通过普通 text/point/line adapter 绕过。`ggnewscale` 重命名 aesthetic 只进入 unsupported coverage，不会与活跃 color/fill scale 合并。`CoordSf` 的普通已证明样式继续沿用现有 ggplot adapter，但位置字段无可靠投影逆变换时保持 readonly；任一 shadow 拒绝会在 setter 前清空整批 accepted，防止合法颜色先写入。base R/grid 输出保持 `objects=[]`、`backendPatch=false` 的 preview/export-only 合同。

隔离 API 对 CoordSf mixed batch、base R object patch 和缺包失败进行持久化审计：冲突请求 `applied=[]`，revision、session editLog、project Figure editLog/history 和 render cache 不变化。该边界是能力真实性和旧项目安全门禁，不代表上述扩展包已获得专用 adapter。

## 14. Python/R 对齐表

| 能力 | Python | R | 当前判断 |
|---|---|---|---|
| 代码识别和渲染 | 成熟 | 已实现 | 对齐 |
| 多 Figure | 成熟 | 已实现 | 基本对齐 |
| 标题/轴标签/tick | artist 级 | theme/grob/scale | 基本对齐 |
| 字体和颜色批量编辑 | 成熟 | 已实现 MVP | 基本对齐 |
| line/scatter/patch | 细粒度 | layer + 可证明的离散 group/scale | 部分对齐，默认与 manual scale 已支持单组改色 |
| legend/colorbar | 细粒度对象 | 显式 scale/guide/layer/panel/mappable 关系 | 部分对齐 |
| facet/subplot | axes | facet panel | 基本对齐 |
| annotation 拖拽 | 标准 data/axes/figure 坐标支持 text/arrow/anchor | 线性、flip、X/Y log、圆内 polar 精确逆变换 | 部分对齐，R 不猜测独立箭头 |
| 网络图/路径图/SEM | 显式 `_scifigure_semantic_gid` 专用语义 | 显式 `scifigure-sem-v1` marker 专用语义 | 协议对齐；两端均不自动推断任意第三方图示 |
| base R 图形编辑 | 不适用 | 仅预览/导出 | 未对齐但边界明确 |
| 任意 SVG 节点写回 | 不承诺 | 不承诺 | 非目标 |
| 导出 | 已实现 | 已实现转换路径 | 需格式矩阵 |

## 15. 已知限制

```text
复杂 annotation 和箭头不是全覆盖成熟能力
R 第三方扩展包对象可能缺少稳定语义
R `ggnewscale`、任意第三方 grob 和 base R artist 级编辑仍不承诺
R 未知 geom 会只读显示并记录 unsupported；没有显式数据键的 text layer 在代码重排后仍为 conditional identity
超大 scatter/heatmap 的浏览器 DOM 和 SVG 成本较高
字体视觉一致性受服务器字体安装影响
部分布局代码会被 tight_layout/constrained_layout 二次改写
大型 Excel 完整 records 解析仍受输出和内存上限约束
浏览器端仍保留 xlsx 用于本地预览
AI 自动改图尚未接入
annotation/箭头仍只达到部分覆盖；tick line 与 tick label 的样式隔离已通过当前 Python fixture
secondary/parasite 代表链路已覆盖；更复杂的 twinx/twiny 共享轴组合和超大 scatter 真实项目验证仍不足
未使用显式语义声明的任意第三方网络图、路径图和 SEM 不会按外观自动推断关系
生产构建仍有主 bundle 大于 500 kB 和 CJS import.meta warning
```

## 16. 验证入口

单元和构建：

```text
npx tsc --noEmit
npm test
npm run build
```

核心 API：

```text
npm run test:cache-smoke
npm run test:cross-figure-concurrency
npm run test:composition-code-project
npm run test:component-kind-matrix
npm run test:capability-matrix
npm run test:code-history-smoke
```

编辑器浏览器回归：

```text
npm run test:behavior-smoke
npm run test:semantic-smoke
npm run test:multisubplot-smoke
npm run test:cross-figure-smoke
npm run test:drag-extended-smoke
npm run test:export-matrix-smoke
npm run test:r-semantic-smoke
npm run test:r-property-layout-centers
npm run test:subplot-scope-follow
npm run test:export-snapshot-db
npm run test:export-snapshot-restore
npm run test:export-snapshot-restore-ui
```

自动化通过不代表真实复杂项目完全覆盖。涉及坐标、布局、字体和导出的修改必须保留人工视觉检查。

2026-07-16 20:41:53 +08:00 生产基线证据：41 个 Vitest 文件/250 项、Python 48 项、R 30 项及既有语义、组件、拖拽、导出快照和 production bundle 门禁通过；该能力集随 `7e33044-jd21` 部署，静态资源安全边界修复随后随 `e35f4a4-jd22` 部署并完成公网复测。

2026-07-30 04:35:45 +08:00 集成候选证据：服务端权威、contour 父对象、V2 组件布尔控件和快照恢复批次已通过 TypeScript、284 项 Vitest、63 项 Python renderer、组件 35/35、跨 Figure 11/11、拖拽和导出矩阵；`hist/stairs/step` 批次正在当前隔离工作树中集成，尚未完成生产 Docker 或部署验收。

2026-07-19 向量场工作包原分支证据：TypeScript、Vitest 1035 项、Python complex artist 22/22、向量场 API 持久化、真实浏览器工作流、真实控件跨 Figure、结构参数拒绝零持久化和 Matplotlib 3.8.4 兼容门禁通过；该证据将在当前生产集成候选完成后重新运行适用门禁，不能替代最终 release gate。

2026-07-30 当前集成候选新增证据：向量场协议单测 180 项、complex artist 22/22、API、单 Figure 与跨 Figure 浏览器通过；网络/路径/SEM 协议单测 185 项、complex artist 26/26、API、单 Figure 与跨 Figure 浏览器通过。两类对象均覆盖 Draft、保存刷新、撤销重做、导出、快照恢复与关系缺失/冲突 fail-closed；完整 release gate 和生产 Docker 验收尚未完成。

2026-07-29 最新 R 编辑中心浏览器证据：`test:r-semantic-smoke` 19/19、`test:r-property-layout-centers` 7/7。字体、组件、配色、属性和布局五个中心均通过真实页面选择、控件修改、Draft、backend patch、保存刷新和运行时错误检查；公共链路还覆盖撤销/重做、文本拖拽、SVG 导出和导出快照恢复。属性测试首轮的隐藏 checkbox 点击失败属于 harness 定位问题，改用同一真实 checkbox 的强制操作后通过，不改变产品代码。两份报告均为 0 console/page error、0 failed request；证据只代表本地隔离候选。

2026-07-19 最新阶段证据：TypeScript 通过；Vitest 145/145 文件、1078/1078 测试；complex artist 26/26、结构身份 7/7、R renderer 31/31、R 浏览器 5/5。显式图示语义的 API 持久化、真实浏览器选择/Draft/重绘/保存刷新/撤销重做/位置修改/SVG 导出/快照恢复和真实控件跨 Figure 均通过；拓扑漂移、关系缺失和篡改快照拒绝后零持久化。组合代码项目、patch 拒绝、快照恢复、R 风险预检、生产构建和 `git diff --check` 通过；数据审计为 25 用户、121 项目、263 项目文件、101 导出资产、0 错误。保留既有大 chunk 与 CJS `import.meta` 非阻断警告。实现已提交为 `b20b103`，未推送、未部署；首次独立审查 HIGH 已修复，最终复审 APPROVE、0 HIGH/MEDIUM。

## 17. 详细参考文档

以下文件保留为专项参考，不再作为主入口：

```text
platform-capability/SCIFIGURE_CAPABILITY_EVOLUTION_AND_REGRESSION_GUARD_PLAN.md
STANDARD_FIGURE_MODEL_V1.md
EDITING_INTENT_SYSTEM_DESIGN.md
EDITING_INTENT_LAYER_UPGRADE_PLAN.md
SEMANTIC_CAPABILITY_MATRIX.md
R_COMPATIBILITY_PLAN.md
SCIFIG_EXCELLENT_UPGRADE_STATUS.md
artist_introspection_upgrade_plan.md
ERROR_LOG.md
```

专项方案第 12 节是当前能力增强执行逻辑。它规定每个能力域采用 `Baseline -> Shadow -> Scoped Enable -> Default Enable -> Legacy Retire` 的渐进放行方式，并以项目归属、保存历史、目标正确性和坐标一致性作为阻断门槛。

其中第 12.7 节按项目数据、双 renderer、图元识别、精准编辑、Draft、拖拽、布局、图例/色条、保存历史、导出、调度和性能列出“当前基线 -> 增强方向 -> 不变量 -> 放行证据”；第 12.8 节规定展示、目标、写回、布局、性能和持久化六类变更的最小安全边界。

## 18. 帮助中心能力边界（2026-07-12 13:44:49 +08:00）

帮助中心属于公共产品内容层，不读取项目、Figure、用户文件或 renderer 状态。公开访客可从宣传页进入；登录用户可从顶部导航或工作区侧栏进入。

内容由 `src/data/helpContent.ts` 提供稳定数据契约，页面组件负责搜索、分类、模板切换、复制反馈和 FAQ 展开状态。科研模板图片由可复现的 Matplotlib 脚本生成，代码与 CSV 示例直接随前端静态内容发布。

`2026-07-12 13:56:33 +08:00` 模板库扩展为 7 套，覆盖均值比较、连续变量关系、矩阵模式、组间分布、时间变化、效应量区间和排序分析。浏览器回归逐条验证模板入口与图片 `naturalWidth`，避免内容记录存在但静态资产缺失。

`2026-07-12 13:59:38 +08:00` 明确模板层与 renderer 层的边界：模板只提供示例，不限制可绘制图形类型。Python/R 能正常生成的 Figure 可进入渲染链路；对象级识别、批量修改和拖拽能力由 StandardFigureModel、各语言内省器及图元能力矩阵决定。

`2026-07-12 14:05:43 +08:00` 公开导航契约更新：匿名认证检查完成后默认进入 `landing`；`help` 只由帮助入口显式打开，匿名刷新返回宣传页。帮助页复用宣传页视觉令牌，但与宣传页保持独立组件、内容和导航状态。

`2026-07-12 14:12:14 +08:00` 帮助中心快速上手与项目创建页对齐：已有 Codex、Claude Code、DeepSeek、ChatGPT、Gemini 或本地流程脚本的用户直接导入；无脚本用户从模板代码和 CSV 起步。帮助文档不再把 AI 生成代码设为所有用户的必经步骤。

`2026-07-12 14:24:55 +08:00` 帮助中心增加公开 AI 绘图提示词，公开范围仅限用户生成兼容代码所需的数据入口与编写规范。知识产权、内省算法、编辑协议和安全实现属于内部开发文档范围。

`2026-07-12 14:57:42 +08:00` 导出资产读取由单一当前项目扩展为账号级聚合接口。后端只汇总认证用户拥有的项目，下载与删除继续执行项目所有权校验；前端默认显示全部历史资产，并提供项目筛选、跨项目打包和来源项目标识。

帮助中心新增能力不得改变以下不变量：

```text
匿名访问不能暴露项目导航或用户数据
登录后返回帮助页不能丢失工作区会话
模板代码不得包含绝对路径、show、savefig 或文件系统归档逻辑
动态效果必须尊重 prefers-reduced-motion
帮助页样式必须限制在 help-center-page 命名空间内
```

## 19. R-WP9 性能、缓存与持久化边界（2026-07-26 20:22:44 +08:00）

R renderer 的性能信息现在区分脚本求值、语义预检、编辑解析、编辑应用、ggplot 绘制、设备打开/关闭、SVG 读取、manifest 构建和后处理。旧总计字段继续保留；无法独立测量的 package load 不生成虚假字段。服务端只转发白名单计时，导出另提供 render、convert、persist 和总耗时。

render cache key 使用 schema v2，将脚本、数据、Figure、editLog 和 render options 与服务端可信 renderer source、镜像、runtime、包/Dockerfile contract 共同哈希。authority 不能由客户端提供；任一 renderer 合同变化都会形成新 key。

成功 SVG 在进入 session、project preview、render cache、导出资产、缩略图或编辑快照前执行 UTF-8 字节预算。超限响应固定为 `SVG_PERSISTENCE_BUDGET_EXCEEDED`、HTTP 413 和 `persisted=false`；直接渲染、patch、导出三条隔离回归均比较数据库与导出文件前后状态。R timeout 后清理请求创建的进程、临时目录和容器，不停止或误判测试前已存在的容器。
