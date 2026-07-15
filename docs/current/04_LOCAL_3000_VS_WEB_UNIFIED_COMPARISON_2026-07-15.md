# SciFigure 本地 3000 与网页统一编辑版对比

> 状态：当前有效
> 创建时间：2026-07-15 11:34:43 +08:00
> 最后更新：2026-07-15 11:38:30 +08:00
> 根目录同步时间：2026-07-15 11:45:53 +08:00
> 本地对象：`http://127.0.0.1:3000`，根工作区 `feature/standard-figure-model-v1`
> 网页对象：`http://117.72.208.91`，线上 build `d625000-jd14`
> 说明：文中“3200 版本”指统一编辑中心升级分支。3200 是早期隔离验证端口，不是当前线上长期端口。

## 1. 一句话结论

网页统一编辑版不是另一个缩水重写版，而是在本地 3000 核心绘图能力之上增加了三类能力：

```text
统一、严格的编辑协议
+ 管理员与错误处理能力
+ 可恢复的 Linux 生产部署和 renderer 隔离
```

两版的 Python/R 绘图、项目、Figure、拖拽、布局、导出和组合图主链路来自同一平台基础。网页版本最大的提升不是“多了几个按钮”，而是让不同编辑中心尽量通过同一份属性、目标、作用域和 renderer capability 工作，并把本地开发服务升级成可认证、可隔离、可审计、可回滚的网页服务。

当前不应把网页版本理解为已经全面替代本地 3000：网页仍受 2 核 4 GB、网络往返、Docker 单并发和 Linux 文件权限影响；XLSX parser 权限修复和增强的数据依赖提示仍在网页 worktree 中，尚未进入 `d625000-jd14`。

## 2. 两个版本的真实身份

| 项目 | 本地 3000 | 网页统一编辑版 |
|---|---|---|
| 运行形态 | Windows Vite/Node 开发服务 | Ubuntu 24.04 + Nginx + systemd + rootless Docker |
| 当前代码身份 | commit `c95d366` 加 9 个未提交文件 | 不可变发布 `d625000-jd14` |
| 分支 | `feature/standard-figure-model-v1` | `upgrade/unified-editing-centers` |
| 共同基线 | `a6857d5` | `a6857d5` |
| 基线后独有提交 | 3 个 | 45 个 |
| 相对基线改动 | 19 文件，+817/-155 | 114 文件，+14,594/-559 |
| renderer | 本机进程，启动快 | 每任务隔离容器，禁网、限资源、较慢 |
| 用户数据 | 本机 `data/`，不应清理 | `/srv/scifigure/data`，当前 5 用户/7 项目 |
| 发布方式 | 修改后热更新 | 不可变 release、readiness、失败回滚 |

本地 3000 当前不是干净、可重现的 release：它包含轴标题拖拽、SVG 实体跟随、DPI 同步和 TIFF 元数据等未提交修改。网页版本已经包含这些能力的已提交等价实现，并额外包含统一编辑、管理员和生产部署能力。

## 3. 3200 升级阶段到底做了什么

### 3.1 Shadow 基础

先建立独立构建目录、build marker 和 3200 隔离端口，在不影响 3000 和真实数据的前提下验证新协议。此阶段主要是基础设施，用户界面变化很少。

### 3.2 属性编辑 V2

新增 `PropertyDescriptor`、`ProjectedPropertyDescriptor` 和通用 `PropertyControl`：

```text
属性定义
-> renderer capability
-> 当前对象/作用域投影
-> 控件状态
-> Draft
-> 精确 patch
```

本地 3000 主要依赖 `editable + kind 白名单 + 专用控件`；网页版本会区分 editable、partial、readonly、unsupported、mixed 和 legacy fallback。

### 3.3 字体中心统一

网页字体中心不再只靠固定的五项属性和前端猜测目标，而是按标题、轴标签、刻度、图例等角色投影能力，并通过严格 resolver 生成真实 gid/prop。

当前额外修复包括：

- X/Y 轴字体、字号、颜色、字重和字形可编辑。
- 轴组操作展开为 `axis.x.*`、`axis.y.*`，不再误落到 `title.*`。
- Times New Roman 在 Linux renderer 中安装了微软原版字体。
- requested family 和 resolved family 分开记录，当前二者均为 `Times New Roman`。
- 目标 SVG 字体链第一项为 Times New Roman，Word/SVG 与 renderer 一致。

### 3.4 组件中心统一

组件中心增加 descriptor projection 和 container 关系：bar、errorbar、stem、boxplot、violin、legend、heatmap、colorbar、subplot、axis 不再只按颜色或相同 kind 猜测目标。

主要收益：

- “选中整组只改左上角第一个”的风险降低。
- 容器和 child 不再重复接收同一 patch。
- 轴框、网格、刻度与字体属性分层。
- 无法安全写回的属性显示只读原因，而不是生成无效 patch。

### 3.5 配色中心统一

网页版本增加 palette property projection、精确 target/prop、向量颜色保护和歧义阻止：

- 同色但不同语义组不再只因颜色值相同被一起修改。
- 一个 collection 内多组向量颜色不会被单个 facecolor 覆盖成同色。
- 数据驱动颜色可组合 code patch 与 backend target。
- renderer 未声明安全写回时阻止假保存。

### 3.6 布局中心统一

布局属性开始强制使用声明的 coordinate space：

- subplot/colorbar 的 `left/bottom/width/height` 使用 figure 坐标。
- aspect 使用 container 语义。
- 普通文本、轴标题、子图标题、annotation 和图例位置分别处理。
- R facet 没有可靠物理边界时不再假装可拖动或可重排。

### 3.7 Strict 默认与 Legacy 观察

网页 build 将属性、字体、组件、配色和布局 V2 默认开启，并记录 legacy fallback 的匿名统计。目标是逐步移除重复旧逻辑，但当前尚未完成 legacy 删除。

严格模式的优点是减少改错对象；代价是旧 manifest 或 renderer capability 不完整时会显示只读。网页早期出现“本地能改、网页只读”，主要就是严格协议暴露了 capability/alias 覆盖缺口，而不是绘图引擎整体损坏。

### 3.8 生产部署与管理员能力

统一编辑分支增加了完整的 Linux 单机部署路径和管理员后台：

- `/admin` 独立前端 chunk 和独立 API。
- 用户元数据、错误中心、脱敏 AI 修复包、审计日志。
- 订阅权限受控调整，要求密码 re-auth、reason、requestId 和审计。
- Nginx、systemd、rootless Docker renderer。
- readiness、draining、单实例 SQLite writer、自动回滚。
- 不可变 build marker，可确认浏览器实际加载哪个版本。

## 4. 功能逐项对比

| 能力 | 本地 3000 | 网页 `d625000-jd14` | 网页升级效果 |
|---|---|---|---|
| Python/Matplotlib | 可用，启动快 | 可用，Docker 隔离 | 功能接近，网页安全边界更强 |
| R/ggplot2 | 可用 | 可用，capability 更严格 | R 主链路增强，但细粒度仍弱于 Python |
| 属性编辑 | legacy 专用控件为主 | Descriptor + PropertyControl V2 | 同属性的单位、范围、状态更统一 |
| 字体中心 | 固定属性集合、部分目标靠推断 | capability 投影 + strict resolver | 批量范围更精确，轴字体已补齐 |
| Times New Roman | Windows 本机已有 | Linux 安装原版 Core Font | 当前网页不再用 Liberation 冒充 |
| 组件中心 | 宽松、部分场景更容易出现控件 | 容器关系 + descriptor | 减少误扩散和只改第一个，但不安全属性会只读 |
| 配色中心 | legacy/binding 混合 | 精确 palette target + 向量保护 | 同色不同组和多色 collection 更安全 |
| 布局中心 | 直接 patch 较多 | coordinate-space/capability 门禁 | 减少拖动后回原位和无效布局 patch |
| Draft Batch | 已有 | 事务清理、跨中心保留、假保存阻止 | 当前公网 Draft 5 秒和跨四中心验证通过 |
| 文字换行/上下标 | 已有专用编辑器 | 保留原编辑器并强制 backend patch | 换行/mathtext 会重排，不再只改 SVG 表面 |
| 多目标拖拽 | 本地参考基线 | 实体 SVG 跟随、轴/标题专用坐标写回 | 当前已修复“只动框”和“贴回框线” |
| DPI/导出 | 当前脏工作区含修复 | 已提交并发布 | 属性 DPI 与导出 DPI 同源，TIFF 元数据正确 |
| SVG/PNG/PDF/TIFF | 可用 | 可用并带导出进度、资产记录 | 网页拥有生产格式矩阵和资产持久化证据 |
| 项目创建 | 旧流程更直接 | 脚本优先、首屏 py/R 拖放、依赖提示 | 更适合网页新用户；增强提示尚未发布 |
| 剪贴板 | 浏览器安全上下文依赖较强 | HTTP fallback | 未启用 TLS 时复制提示词仍可用 |
| 错误记录 | 本地日志/诊断文件 | 结构化错误中心、脱敏、去重 | 更适合 AI 阅读和管理员修复 |
| 管理员后台 | 无独立后台 | 已部署 | 网页独有 |
| 发布回滚 | 无 | 原子切换、readiness 失败回滚 | 网页独有 |
| renderer 禁网/限资源 | 开发环境不强制 | 生产强制 | 网页独有的安全提升 |
| 运行速度 | 快 | 较慢 | 本地明显占优 |

## 5. 网页版本真正提升最大的部分

### 5.1 修改目标更精确

过去“改 Weak 连带 Mixed”“改一个 tick 变成全部”“整组只改第一个”等问题，本质是对象身份、属性别名和作用范围混在 UI 中。网页版本增加 identity、property capability、target resolver 和 EditingIntent 联动，目标是让每条修改都能回答：

```text
改哪个语义对象
改哪个真实 gid
使用哪个真实 prop
作用到 object/group/subplot/figure 中哪一层
由前端预览还是 renderer 重放
```

### 5.2 五个编辑中心的行为更一致

同一个 `fontfamily`、`fontsize`、`color` 或 `linewidth` 在多个中心出现时，网页版本尽量共享 descriptor、mixed state、readonly reason、Draft 和 patch mode。本地 3000 的专用控件更宽松，但同一属性在不同入口的精细度容易不一致。

### 5.3 保存更可信

网页版本阻止在 engine draft 尚未应用时执行“看似保存成功”的操作；文字立即应用只清理值完全匹配的 Draft；静默自动保存不再吞掉用户正在编辑的 Draft。

### 5.4 可部署和可恢复

网页版本把开发应用变成了可发布服务：候选版本在后台构建，只有 renderer、前端、readiness 全通过后才切换；失败自动恢复上一 release。用户数据库不进入发布包，发布前后检查 SQLite 完整性和计数。

### 5.5 可运营

管理员能看错误摘要、脱敏修复包、用户元数据、审计和订阅状态，而不直接读取用户脚本、数据、图片和 token。这部分在本地 3000 中没有对应完整界面。

## 6. 网页版本当前仍不如本地的地方

### 6.1 性能

2026-07-14 的同类测试中，Python 语义中心本地约 35.3 秒、旧网页约 104.9 秒。该数字不是 jd14 的最新基准，但能说明当前差异来源：

```text
公网往返
+ 2 核 4 GB
+ rootless Docker 逐任务启动
+ renderer 并发 1
```

本地 3000 更适合高频个人改图；当前网页更偏安全、共享和真实部署验证。

### 6.2 XLSX parser 权限修复尚未发布

网页 worktree 已有 `taskRoot 0700 + work 0755 + input 0444` 修复和 sandbox workbook 测试，但它仍是未提交改动，没有进入 `d625000-jd14`。因此网页仍可能出现：

```text
Workbook parsing failed: Permission denied: /work/input.xlsx
```

这是下一次发布的明确 P0，不应误称为已完成。

### 6.3 数据依赖提示增强尚未发布

“没有识别到固定数据文件名”的蓝色说明块已经在 worktree 中实现，但未进入当前不可变 release。当前网页仍可能只显示较弱的单行提示。

### 6.4 HTTPS 尚未完成

服务器当前仍通过公网 HTTP 使用；域名、TLS、备份目标和完整恢复演练仍是正式生产前工作。HTTP clipboard fallback 可用不等于安全上线已经完成。

### 6.5 复杂图形仍需真实项目回归

共享 figure legend、复杂 annotation、R 非标准 grob、5+ Figure、复杂 facet 和大文件仍需要用户项目矩阵。Strict 模式不会自动创造 renderer 未声明的能力。

## 7. 当前验证证据

### 7.1 最新公网专项

build `d625000-jd14`：

- readiness=`ready`，单一 Node 实例。
- SQLite `integrity_check=ok`，用户/项目保持 `5/7`。
- `fc-match 'Times New Roman'` 返回 `Times_New_Roman.ttf`。
- 公网真实浏览器 `public_editing_regressions_smoke`：6/6 PASS。
- Times requested/resolved/SVG 第一字体均为 Times New Roman。
- 换行、上下标、立即应用、Draft 跨中心、X/Y 轴字重 fanout 通过。
- Console Error=0，Page Error=0。

### 7.2 本轮代码与构建验证

- Python introspection：45/45 PASS。
- deployment package smoke：PASS。
- production bundle smoke：PASS。
- jd14 renderer 最终 fontconfig 门禁：PASS。

### 7.3 验证边界

本轮没有在 jd14 上重新跑全部 Python/R、组合图、导出矩阵和所有 47 条历史错误。7 月 14 日旧报告仍可作为广度证据，但其中针对 `eea68fb-jd7` 的失败和性能结果不能直接等同于 jd14 当前状态。

## 8. 建议的版本收敛方式

1. 将网页统一编辑版作为后续产品主线，不再把“3200”当作独立产品名称。
2. 本地 3000 暂时保留为快速绘图和行为参考，不直接继续堆叠另一套编辑逻辑。
3. 先把 XLSX parser 权限修复和数据依赖提示形成独立提交、容器回归并发布。
4. 对真实项目跑 Python/R、配色、组件、拖拽、布局、保存和导出矩阵。
5. 完成域名/TLS、备份恢复和监控后，再把网页版本定义为正式生产基线。
6. 验收稳定后，将本地 3000 所需的开发体验建立在同一统一编辑代码上，减少双分支长期漂移。

## 9. 子代理 502 诊断附录

### 9.1 现象

本次对比曾启动两个 `explore` 子代理，均返回：

```text
502 Bad Gateway
Upstream request failed
http://localhost:8081/responses
```

请求 ID：

- `21c01175-3ed4-4f54-bdd6-bb04591e7145`
- `b87cf8d7-c943-471d-90ff-b7f3b47bf9dc`
- 并发调整后复测：`15421601-f061-49da-995f-45e0906aea59`

### 9.2 直接原因

只读检查确认：

- `localhost:8081` TCP 正常。
- Sub2API `/health` 返回 200。
- `sub2api` 容器状态 healthy，未重启、未修改。
- 两个失败请求都使用 `gpt-5.3-codex-spark`。
- Sub2API 日志中的真实上游错误为：

```text
The 'gpt-5.3-codex-spark' model is not supported when using Codex with a ChatGPT account.
```

Sub2API 将上游 400 包装为对客户端的 502。失败账号为 ChatGPT OAuth 类型；同一时间主对话的 `gpt-5.6-sol` 请求经支持账号返回 200。

2026-07-15 11:38:30 +08:00，在用户完成并发配置调整后再次启动相同 `explore` 角色，仍返回 502。因此并发可能是其他代理失败的影响因素，但不能解释或修复这三个已核实请求；这三次失败的直接原因仍是 Spark 模型与被选 ChatGPT OAuth 账号不兼容。

### 9.3 为什么主对话正常、子代理失败

主对话与 `explore` 子代理没有使用同一模型：

```text
主对话：gpt-5.6-sol -> 支持账号 -> 200
explore：gpt-5.3-codex-spark -> ChatGPT OAuth 不支持 -> 400 -> Sub2API 502
```

因此这不是 SciFigure、Docker Desktop或本机网络整体故障，而是子代理模型与 Sub2API 账号路由不兼容。

### 9.4 处理建议

- 在该账号支持 Spark 之前，不使用固定为 `gpt-5.3-codex-spark` 的 `explore` 角色。
- 子代理改为继承主模型，或使用 Sub2API 当前账号明确支持的模型。
- 如果必须使用 Spark，在 Sub2API 中将该模型路由到支持它的 API 账号，而不是 ChatGPT OAuth 账号。
- 调整并发后应分别复测主模型和 `explore` 角色；主模型成功不能代替 Spark 路由验证。
- 保留 502 原始请求 ID；排查时应读取 `openai.forward_failed` 的上游 400 文本，不能只看外层 502。

## 10. 最终判断

网页统一编辑版的主要价值是：**编辑更一致、目标更精确、保存更可信、部署更安全、错误更可运营**。本地 3000 的主要价值是：**快、直接、适合个人高频试图和作为兼容参考**。

当前正确方向不是继续维护两个长期分叉产品，而是以网页统一编辑协议为主线，保留本地快速运行方式，并逐项消除 Linux/Docker/网络带来的部署差异。
