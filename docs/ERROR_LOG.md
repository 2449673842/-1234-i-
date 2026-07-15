# SciFigure 错误记录与修复日志

> 用于记录真实诊断文件、根因、修复动作和遗留风险。结论必须区分“平台问题”和“AI 转义脚本问题”。
> 最后修改时间：2026-07-15 23:43:28 +08:00

---

## 2026-07-15 23:43:28 +08:00 相同脚本可碰撞跨用户 session，组合项目复制可绕过存储预算

**现象**

- 两个用户提交完全相同脚本时，服务端可能生成相同的短 session ID。
- 旧 `saveSession`/批量 Figure upsert 在 ID 冲突时会更新 `user_id`，存在后提交用户接管既有会话的风险。
- 组合代码项目复制来源数据时只校验来源所有权，没有逐文件进入目标项目、账号和全平台累计存储预算。

**根因**

- session ID 由脚本 MD5 的 12 字符前缀生成，既不是随机能力标识，也没有用户命名空间。
- SQLite `ON CONFLICT` 把所有者字段当成普通可更新字段，破坏了“所有权创建后不可转移”的不变量。
- 组合复制链路绕过了普通上传入口，未复用统一的存储预算函数。

**修复**

- 新会话统一使用服务端随机 UUID；只有明确重渲染且已验证归属时才保留既有 session ID。
- session upsert 和项目 Figure 批量替换不再更新 `user_id`，冲突返回错误并回滚整个事务。
- 批量替换前校验项目所有权、每个 session 记录、Figure 历史和项目累计批次大小。
- 组合项目复制每个文件前校验目标项目、账号和全平台存储预算；失败只清理本轮新目标，不改动来源项目。

**验证**

- 双用户相同脚本得到不同 session ID；跨用户直接 patch 被拒，原所有者仍可继续使用。
- 直接数据库所有者冲突测试证明脚本和 user_id 均不改变。
- 超大 Figure 历史在替换前被拒，旧 Figure revision、history 和 session script 完整保留。
- `test:user-isolation`、`test:security-baseline`、组合代码项目 Python/R smoke 和 254 项 Vitest 通过。

**防复发规则**

- 任何用户资源 ID 不得只由用户内容摘要生成；摘要只可用于缓存键，不能作为所有权标识。
- 所有者字段创建后不可通过 upsert 更新；冲突必须失败，不得“最后写入者获胜”。
- 任何复制、导入、恢复或组合入口都必须复用与普通上传相同的所有权和容量边界。

---

## 2026-07-15 23:43:28 +08:00 SVG 安全校验误拒 Matplotlib 标准声明，导致缓存持续 miss

**现象**

- 相同语义 patch 首次渲染后，第二次仍显示 `cache.hit=false`。
- 缓存写入函数捕获异常后不影响渲染响应，因此用户只会感到缓存失效，不会看到明确报错。
- 同一校验路径也可能阻止 Matplotlib SVG 持久化为导出资产。

**根因**

- Matplotlib 默认 SVG 包含固定的 W3C SVG 1.1 `DOCTYPE`。
- 新增的服务端 SVG 校验正确拒绝任意 DTD/实体，但没有区分这一固定声明，导致正常 renderer 输出也被拒绝。

**修复**

- 只对精确匹配的 Matplotlib/W3C SVG 1.1 公共声明执行移除，再对规范化后的 SVG 运行完整安全校验。
- 任意其他 DTD、内部实体、外部 URL、事件属性、主动元素和危险 CSS 继续拒绝。
- 缓存读取时再次校验 SVG；损坏或不安全的缓存项作为可丢弃数据删除。

**验证**

- SVG 安全单测覆盖标准声明规范化、恶意外部 DTD 和 XXE 拒绝。
- 缓存 smoke 结果为首次 miss、同 key 第二次 hit、参数变化后新 key miss。
- 导出矩阵 SVG/PNG/PDF/TIFF、子图格式跟随主图、资产持久化和零浏览器错误全部通过。

**防复发规则**

- 安全校验新增拦截规则时，必须同时使用真实 Python/R renderer 输出做兼容回归。
- 缓存写入异常不能只看接口成功；必须断言第二次真实命中和 key 稳定。
- 对安全格式做兼容规范化只能接受精确白名单，并在规范化后重新执行完整验证。

---

## 2026-07-14 09:55:23 +08:00 管理员动态入口生产构建未加载独立 CSS

**现象**

- `/admin` 的语义结构、鉴权和 API 数据正常，浏览器也没有 React 崩溃。
- 首次生产截图却显示为未样式化 HTML，深色导航、表格、抽屉和响应式布局均未生效。
- `AdminApp-*.css` 文件已正常生成且直接请求返回 200，但浏览器网络记录中没有请求该 CSS。

**根因**

- `src/main.tsx` 用单个三元表达式在 `import('./admin/AdminApp')` 和 `import('./App')` 之间选择。
- Vite 将两个动态导入合并成一个 preload 调用，但使用了普通 `App` 的依赖列表，遗漏 `AdminApp-*.css`。

**修复**

- 将管理员入口和普通应用入口拆成 `loadAdminApp()` 与 `loadUserApp()` 两个独立动态加载函数。
- 修复后构建产物为管理员分支生成独立 `__vite__mapDeps([0,1,2])`，明确包含 `AdminApp-*.css`。
- 移动端表格设置最小扫描宽度，由容器横向滚动，避免各列被压成狭窄文字柱。

**验证**

- 生产构建中 `AdminApp` JS/CSS 继续独立分包，普通应用不首屏加载后台模块。
- Playwright 网络记录确认 `AdminApp-*.css` 返回 200。
- 1440×960 的错误中心、详情抽屉、用户元数据和审计日志可用。
- 390×844 视口导航收缩、筛选换行、表格横向滚动正常。
- 管理 API 专项、旧鉴权回归、203 项 Vitest、TypeScript 和 production bundle 通过。

**防复发规则**

- 独立动态入口验收不能只检查页面 DOM 和 API，必须检查 CSS 请求并审阅真实截图。
- 条件动态导入必须保留每个分支的独立 preload 依赖，不得只以生成 chunk 文件作为分包成功证据。

---

## 2026-07-13 15:24:50 +08:00 Phase 8b staging renderer 版本错配导致 strict 控件全部只读

**现象**

- 3200 可以正常出图，但语义 smoke 中字体和线宽控件变为 readonly，配色 binding 缺 `targetMode/targets`，修改不会形成 patch。
- 同一前端候选使用 `scifigure-renderer:phase8a` 时恢复正常，说明不是统一编辑 UI 或图元选择系统损坏。

**根因**

- staging 启动器从稳定 `.env` 继承了 `SCIFIGURE_RENDERER_IMAGE=scifigure-renderer:latest`。
- `latest` 是旧 renderer，能返回 SVG 和旧 manifest，但缺 Phase 8a identity、property capability 和精确 palette target 协议；默认 strict 因而正确阻止写回。
- 旧 marker 只绑定前端 build，没有声明 renderer 镜像，前后端协议版本可以静默错配。

**修复**

- staging build marker 新增 `rendererImage`，并校验镜像名格式。
- staging 启动器只使用 marker 绑定镜像，覆盖稳定 `.env` 的旧值；marker 缺字段时拒绝启动。
- Phase 8b 候选绑定 `scifigure-renderer:phase8b`，marker 同时声明 `legacyRetireObservationV1`。

**验证**

- 旧镜像复现：语义 0/3、组件 3/18、拖拽 3/9，控件均因协议缺失只读。
- 正确镜像：属性 9/9、Python 语义 14/14、组件/布局 18/18、拖拽 9/9、R 7/7。
- 3200 marker 显示 `rendererImage=scifigure-renderer:phase8b`；3000 PID `196020` 未改变。

**防复发规则**

- production-like staging 必须把前端 build、Git revision、协议 marker 和 renderer image 视为一个不可拆分候选。
- “能出 SVG”不能证明 renderer 协议兼容；放行必须检查 identity、propertyCapabilities 和 palette targetMode。
- 测试报告出现大面积 readonly/空 patch 时，先核对 marker 与 renderer 哈希，不得先修改前端放宽 strict。

---

## 2026-07-13 15:24:50 +08:00 R facet 多面板 layer 因 `$` 部分匹配在 Docker R 4.5 渲染失败

**现象**

- R 语义 fixture 在 Docker 中报 `R script failed: 'length = 2' in coercion to 'logical(1)'`，本地基础 renderer 测试可通过。
- 错误发生在 manifest identity 构建，不是 ggplot 绘制、SVG 序列化或前端解析阶段。

**根因**

- R list 的 `$` 会部分匹配字段名。facet layer 只有 `subplotIds=[subplot.0, subplot.1]` 时，读取 `obj$subplotId` 会错误命中复数字段。
- 旧 R 版本可能只给警告并取首值，R 4.5 对长度 2 的 `&&` 标量转换直接报错；即使不报错，也会错误伪造单一 subplot 归属。
- 同类风险还存在于 `layerId/layerIds` 和 `mappableId/mappableIds`。

**修复**

- 新增 R manifest 精确字段和标量字段读取函数，禁止 `$` 部分匹配进入 identity 协议。
- 单值 relation 只读取精确同名字段；复数 `subplotIds/layerIds/groupIds/mappableIds` 独立保留全部去重值。
- facet identity 回归开启 `options(warn=2)`，使旧 R 上的部分匹配警告也能阻断测试。

**验证**

- 本地目标 R 回归通过；Docker R 4.5 只读挂载修复版 renderer 后同一 fixture 成功，layer relation 保留两个 subplot。
- Python introspection、R renderer 和 capability matrix 共 70 项通过。
- `scifigure-renderer:phase8b` 构建通过；R 语义浏览器 7/7、Docker sandbox smoke 通过。

**防复发规则**

- R 协议对象存在单复数字段时必须使用 `[[name, exact=TRUE]]`，禁止用 `$singular` 读取。
- 多面板 layer/group 的 relation 必须断言完整 `subplotIds`，不能只验证渲染成功。
- 本地 R 和生产 Docker R 版本不同必须双跑语义 fixture；本地通过不能替代容器证据。

---

## 2026-07-13 12:11:40 +08:00 Phase 8 默认 strict 导致旧 manifest 假可编辑与拖拽回滚失效

**现象**

- 旧 manifest 只有 `editable/currentProps`、缺少 identity 或 property capability 时，V2 控件仍显示可编辑，但 strict resolver 返回空 patch，用户会看到控件变化却无法应用。
- 拖拽确认硬编码 strict resolver；旧对象可以进入拖拽预览，但松手确认时无法生成 position patch。
- 只关闭字体或组件 V2 控件时，旧 UI 仍可能调用默认 strict resolver，回滚不是完整的用户行为回滚。
- 隔离 Playwright 多次刷新时错误连接稳定 3000 的 Vite HMR 端口，功能断言全部通过但 N1 被假 console/page error 阻断。

**根因**

- descriptor 的 legacy fallback 与 resolver 的 strict readiness 使用了两套独立判断，没有共享“是否允许旧协议写回”的策略。
- `ChartPreview.buildPositionPatch()` 把 resolver 参数写死为 `true`。
- UI 控件开关和底层 resolver 开关缺少明确的两层回滚契约。
- 多个 Vite middleware 测试实例共用默认 HMR 端口，测试 HTTP 端口虽然隔离，WebSocket 端口没有隔离。

**修复**

- property projection 新增 `allowLegacyFallback`；strict 下 legacy editable 投影为 readonly 并显示缺 capability 原因，显式回滚时才恢复 editable。
- position 投影和最终 patch 统一由布局 V2 开关控制，默认 strict、显式 `0` legacy，不再出现预览与确认协议不一致。
- 字体/组件旧控件启用时使用 legacy compiler；UI 回滚保留 renderer 的容器识别，底层 resolver 回滚单独作为旧 manifest 应急入口。
- 隔离测试同时分配独立 HTTP/HMR 端口，稳定服务和 smoke 不再共享 WebSocket。

**验证**

- Vitest：26 files / 188 tests；新增 strict readonly、legacy position 回滚等回归。
- Python/R/capability matrix：70 tests；TypeScript 通过。
- 默认路径：属性 9 PASS、语义 14 PASS、组件/布局 18 PASS、R 7 PASS、拖拽 9 PASS。
- UI 显式回滚：语义 14 PASS、组件/布局 18 PASS；console/page error 为 0。
- `scifigure-renderer:phase8a` 构建通过；增强 sandbox smoke 确认 Python/R capability manifest、禁网、敏感路径隔离、R 超时终止和容器清理。
- 3000 稳定 PID `196020` 未改变，所有 smoke 使用隔离临时数据目录。

**防复发规则**

- 控件投影为 editable 时，必须存在同一模式下可生成 patch 的 resolver 证据；禁止“可编辑 UI + 空 patch”。
- 拖拽资格判断、坐标换算和确认编译必须使用同一开关与协议模式。
- UI 回滚和 resolver 回滚必须分开记录；测试不得把关闭底层 resolver 后缺失的新语义能力误报为 UI 回滚失败。
- 隔离浏览器测试必须同时隔离 HTTP、数据库、数据目录和 HMR/WebSocket 端口。

---

## 2026-07-13 02:14:35 +08:00 布局能力缺少坐标空间门禁并误放行未知坐标拖拽

**现象**

- 多子图布局按钮只依赖对象存在和 currentProps，R facet 不支持独立 bounds 时仍可能表现为按钮可点但不生效。
- `unsupportedProps` 只有声明没有进入 descriptor 投影，用户看不到不支持原因。
- position 若缺少有效坐标空间，旧兼容路径可能把未知 `native` 坐标误当 axes，拖动后出现确认条但无法可靠重放。

**根因**

- renderer capability 没有为 layout geometry 声明 coordinateSpace。
- layout center 没有独立 descriptor family 和 capability gate。
- position 投影使用了过宽的默认 axes fallback，最终 patch 也没有复用严格 Target Resolver。

**修复**

- Python/R 为 bounds 声明 `coordinateSpace=figure`，为 aspect 声明 `coordinateSpace=container`；R facet aspect 限定为 figure scope。
- 新增 layout geometry/position descriptor，显式投影 editable/readonly/unsupported、scope 和 per-object coordinateSpace。
- 布局批量操作在应用前验证每个目标的 prop 与坐标空间；R facet bounds 显示 renderer 原因并禁用。
- 显式未知坐标投影为 `none`；拖拽资格和 patch 构造复用 position descriptor，最终 patch 由严格 Target Resolver 编译。

**验证**

- 全量 Vitest：26 files / 185 tests；Python/R renderer：68 tests。
- Python 多子图/共享色条：18 PASS；R facet：7 PASS；扩展拖拽：9 PASS。
- R native coordinate 保护、多个文本连续/同时拖拽、取消零 patch、annotation data coordinate 均通过。
- TypeScript、staging build/dry-run、diff check 和独立代码审查通过。

**防复发规则**

- layout patch 必须同时满足属性 capability、作用域和 coordinateSpace，不能只检查 `editable`。
- renderer 明确 unsupported 的属性必须显示原因，不得隐藏后继续走 legacy 按钮。
- position 不得为未知坐标系猜测 axes；只有 `axes/figure/data` 可进入当前拖拽换算。
- 拖拽确认状态机可以复用 descriptor/resolver，但不得改成即时提交或拆散多目标批次。

---

## 2026-07-13 01:04:32 +08:00 配色中心严格协议缺失与未应用颜色草稿假保存

**现象**

- 新配色控件如果直接按 canonical `color` 投影，会遗漏 binding 指定的 `facecolor/edgecolor`，或把同一 palette 的不同 target 错套为一个 prop。
- palette resolver 开启后，旧 manifest 缺少 target identity/capability 时仍会回退 legacy GID，存在恢复同色串改的风险。
- 用户暂存全局颜色常量后直接点击“保存”，旧保存链只持久化 local patch，`code_patch/backend_patch` 被过滤，但界面仍可能显示保存完成。

**根因**

- descriptor 与 palette resolver 之间没有传递 per-target prop 的协议接缝。
- strict resolver 把协议缺失视为兼容 fallback，而不是候选放行门禁。
- `MainWorkspace.handleSave()` 只收集 local draft，没有识别必须先经过 renderer 的草稿类型。

**修复**

- descriptor 投影新增可选 `resolvedPropByKey`；palette 适配器只消费 resolver 已确认的 target/prop，并统一 mixed/partial 状态。
- Phase 6 controls 开启时要求完整 binding/object protocol；缺失时 object patch 为空，Python 只允许明确代码常量修改，R 直接阻止。
- `code_only` 与 selected subset 继续分离，向量 collection 不生成对象颜色 patch。
- Draft 工具明确区分可直接持久化 local patch 与必须先应用的 backend/code patch；保存遇到后者不发送 PUT，并保留草稿。

**验证**

- 全量 Vitest：26 files / 177 tests；Python/R renderer：68 tests。
- Python 语义 smoke：14 PASS / 0 FAIL；R 语义 smoke：6 PASS / 0 FAIL。
- strict protocol 缺失、unresolved、per-target prop、mixed、code_only 和保存阻止均有独立回归。
- 3200 使用当前本地 renderer 时 Python/R capability 端到端通过；旧 Docker image 会被严格门阻止对象配色，证明门禁有效。

**遗留门禁**

- Docker Desktop/BuildKit 未响应，Phase 6 renderer 镜像未能重建。3200 的本地 renderer 仅用于隔离升级测试，不可作为生产安全配置。

**防复发规则**

- palette target/prop 只能来自 binding resolver，descriptor 不得重新猜测 `color/facecolor/edgecolor`。
- strict 模式缺 identity/capability 时必须阻止对象 patch，不得静默降级同色匹配。
- 保存不得把未应用的 backend/code draft 标记为已持久化；必须先应用或明确阻止。

---

## 2026-07-12 23:56:37 +08:00 组件中心 V2 边框组被判为只读，整组编辑可能回退到错误控件

**现象**

- 组件中心统一控件启用后，`子图边框 / 坐标轴框线` 卡片没有可编辑线宽控件。
- 自动化测试若使用全局 fallback，会误命中上一张图例卡片的线宽控件，表现为想改边框却生成 `legend.0:linewidth`。
- 旧组件中心依赖 kind 白名单，曾掩盖这一协议缺口。

**根因**

- Python renderer `_determine_role()` 识别 `spine.*`，但遗漏虚拟对象 `spine_group.*`。
- `_build_property_capabilities()` 只有对象具备 role 时才为普通样式属性声明 `group` scope；因此 `spine_group.linewidth` 只声明 `object`。
- descriptor 按 capability 正确显示 readonly，而旧 `supportsBatchProp()` 白名单仍允许整组写入，两条能力判断不一致。

**修复**

- renderer 将 `spine_group.*` 识别为 `role=axis_frame`，线宽、颜色、显隐等稳定属性获得 group scope。
- 组件中心 V2 只对 projection 中逐对象 `editable` 的目标写回，并按真实 prop alias 分桶后一次提交。
- owned child 排除同时读取 container `children` 和 child `parentId`，降低单侧 ownership 元数据缺失造成的重复分组风险。
- 浏览器 smoke 改用 `data-component-group-id + data-param-prop` 精确定位，不再使用会跨卡片命中的全局 fallback。

**验证**

- Python 内省新增 `spine_group role/group capability` 回归并通过；完整 introspector 39 项通过。
- 组件容器 smoke：17 PASS / 0 FAIL；6 个 `spine_group` 均生成 `linewidth=1.7` backend patch。
- Python 五中心语义 smoke：12 PASS / 0 FAIL；4 条 line 均生成 `linewidth=2.5`，28 个文本均生成 `rotation=17` backend patch。
- R 五中心语义 smoke：5 PASS / 0 FAIL；`r.layer.1:linewidth=2.2` 正确写入。
- 全量 Vitest：25 files / 166 tests；TypeScript 和 production-like build 通过。

**防复发规则**

- 虚拟组对象必须在 renderer 明确声明语义 role 和组级 capability，前端不得用 kind 白名单扩大 capability。
- 组控件的 representative 只用于显示，写回目标必须来自完整 projection，禁止只取第一个对象。
- 自动化控件定位必须使用中心、分组和 prop 的稳定 DOM 协议；不得在精确卡片失败后静默回退到全局第一个同类型控件。

---

## 2026-07-12 12:32:39 +08:00 R 复杂坐标被整体禁用、文本重排串对象和未知 geom 伪装可编辑

**状态与级别**

- 状态：可逆坐标与稳定数据键已修复；不可证明扩展对象改为明确降级。
- 级别：P1。旧逻辑过度禁用了可逆坐标，同时可能在代码重排行后按旧行号命中错误文本。
- 证据等级：E5。

**根因**

- 文本位置只使用 panel min/max 线性换算，没有消费 ggplot coordinate transform 和 scale inverse。
- `r.text.L.R` 永久依赖 build 后行号，源数据即使有唯一 `id/key` 也没有进入身份。
- 应用文本 patch 时重建 layer 会丢失源数据键。
- 未知 ggplot geom 退化为普通 container，并错误暴露颜色和线宽控件。

**修复**

- `CoordCartesian/CoordFlip` 使用三点仿射逆解，X/Y log 调用 scale inverse 恢复原始数据。
- `CoordPolar` 使用 theta/r、start 和 direction 精确逆解；圆外请求拒绝且 manifest 不回显未应用目标。
- 唯一 `.scifigure_id/scifigure_id/id/ID/key/label_id` 转为稳定文本 gid；layer 重建保留内部 `.scifigure_id`。
- 无稳定键继续使用行号和 conditional capability，不虚报稳定。
- 未知 geom 改为 readonly/unsupported；重命名多 scale aesthetic 单独报告，不错误合并。

**验证**

- `npm run lint`：通过。
- `npm test`：18 files / 130 tests 通过。
- `tests/test_r_renderer.py`：29 项通过。
- `npm run test:capability-matrix`：Python/R 通过。
- `npm run test:r-semantic-smoke`：5/5 通过。
- `npm run test:drag-extended-smoke`：全部通过。
- `npm run build`：通过；保留既有 bundle 大小与 CJS `import.meta` 警告。

---

## 2026-07-12 05:09:45 +08:00 R 默认离散色标退化为整层选择且 guide 标题来源错误

**状态与级别**

- 状态：已修复并完成 renderer、能力矩阵和浏览器回归。
- 级别：P1；会导致 R 同一 layer 多组无法精确选择，或改色后 manifest 图例标题与实际图不一致。
- 证据等级：E5。

**现象与根因**

- 显式 `scale_color_manual()` 能生成 `r.group.*`，但 ggplot2 默认离散色标在 SVG 中仍统一写成 `r.layer.N`。
- 旧检测只遍历原始 `plot_obj$scales`；默认 scale 由 `ggplot_build()` 补充，因此写回和 SVG 映射阶段看不到。
- group 没有显式 layer、facet panel、aesthetic、scale 和 guide 关系。
- manifest 图例标题只读 `plot_obj$labels$colour/fill`，忽略 `scale_*(name=...)` 的真实 guide 标题。

**修复**

- 基于 build 后 scale catalog 统一处理默认和显式离散 color/fill scale。
- group identity 使用与样式无关的 aesthetic + group key，并关联 layer、全部 panel、scale、guide 和 legend。
- 单组改色通过 ggplot scale 重放，保留 limits、breaks、labels、name、NA、drop 和 guide 配置。
- SVG 仅在颜色到语义组唯一时写入 group ID；重复颜色退回 layer ID。
- scale/guide 对象记录 panel 归属但不声明 subplot 写回能力，避免“选一个 facet 实际改全部”的错误承诺。
- guide 标题优先读取实际 scale name。
- text layer 行身份标记 conditional；base R/grid 输出明确报告 semantic editing unsupported。

**验证**

- `npm run lint`：通过。
- `npm test`：18 files / 130 tests 通过。
- `tests/test_r_renderer.py`：25 项通过。
- `npm run test:capability-matrix`：Python/R 通过，R 2×2 facet fixture 校验 group/layer/panel 双向关系。
- `npm run test:r-semantic-smoke`：5/5 通过，fixture 使用默认离散 scale。
- `npm run build`：通过；保留既有 bundle 大小与 CJS `import.meta` 警告。

---

## 2026-07-12 04:44:30 +08:00 轴样式 smoke 被公开首页认证拦截

**状态与级别**

- 状态：已修复测试隔离，产品代码无需回退。
- 级别：测试基础设施 P1；不影响真实登录用户编辑结果。
- 证据等级：E5，已完成独立 smoke、复杂 renderer、跨 Figure 和完整构建回归。

**现象**

- `test:axis-style-semantics-smoke` 恢复了内存 Figure fixture，但页面停留在公开宣传页。
- 失败诊断显示 `/api/auth/me` 返回 401，右侧属性编辑器没有挂载。

**根因**

- 宣传页和注册入口升级后，未认证访问工作台会被顶层访问控制正确拦截。
- 该测试只 mock 了项目和 patch API，没有 mock 当前认证用户；它把旧的“匿名可直接进入编辑器”误当成测试前提。
- 这是测试隔离缺口，不是复杂图元协议、React 渲染或项目数据故障。

**修复**

- 在测试中增加隔离的 `/api/auth/me` mock，使用固定测试用户和 free license。
- 不读取真实账号、真实数据库或 `data/` 项目，不降低公开首页访问控制。

**关联完成项**

- legend 标题、文字、handle 关系显式化。
- shared colorbar 关联全部 mappable 和 owner subplot，子对象继承真实归属。
- twinx/twiny/sharex/sharey 输出对称关系，secondary twin 不计入物理布局 panel。
- tick line 和 tick label 的颜色编辑目标分离。

**验证**

- `npm run test:axis-style-semantics-smoke`：5/5 通过。
- `npm run test:component-container-smoke`：15/15 通过。
- `npm run test:semantic-smoke`：9/9 通过。
- `npm run test:multisubplot-smoke`：4/4 通过。
- `npm run test:drag-extended-smoke`：通过，包含连续双目标和三目标拖拽。
- `npm run test:cross-figure-smoke`：9/9 通过。
- `npm run lint`、`npm test`（18 files / 129 tests）、Python 内省 36 项、Python/R capability matrix、`npm run build` 和 `git diff --check`：通过。

---

## 2026-07-12 02:32:07 +08:00 导出资产返回错误与重新配置进入旧导入流程

**状态与级别**

- 状态：已修复并完成浏览器级保存、渲染和返回回归。
- 级别：P1。旧流程会让已有项目脱离 `projectId`，存在用户误以为修改原项目、实际进入临时导入状态的风险。
- 证据等级：E5，已完成源码定位、单元测试、生产构建和真实 Playwright 流程验证。

**现象**

- 导出资产页返回按钮写死为导出设置，无法回到用户真正进入资产页之前的页面。
- 编辑器顶栏“重新配置”直接进入旧 `DataImportPage`。
- 旧导入完成时 `handleImportSpec()` 会把 `projectId` 设为 `null`、项目名改为未命名并重置渲染状态，不适合作为已有项目重新配置。
- 新项目流程要求先猜测上传数据，再放入脚本，无法根据代码中的具名文件依赖提示用户补齐表格。

**修复**

- App 在进入导出资产库时记录来源 View，资产页返回按钮调用真实返回处理；“去配置导出”仍保留为明确命令。
- 新增独立 `project_reconfigure` 页面。默认保留项目 ID、名称、现有数据、Figure editLog/history/revision、导出资产和当前脚本。
- 重新配置只追加用户选择的新文件，不静默删除旧数据；保存时携带现有 Figure 历史，再按用户选择的 Python/R 语言执行项目级重绘。
- 新增脚本数据依赖提取器，识别 Python/R 中常见 CSV/Excel 文件引用，并展示“已提供/待上传”。
- 新建项目增加脚本先行入口；所有额外上传表格仍使用现有 `buildTranslationPrompt`，没有新建或分叉 AI 提示词协议。
- 顶栏普通“导入数据”进入新版项目创建页；旧单文件导入路由保留兼容，但从主入口隐藏。

**数据保留约束**

- 重新配置不是新建项目，不得调用 `handleImportSpec()`。
- 默认保留所有现有文件；删除和同名替换必须留在显式危险操作中。
- 脚本或数据变化可能造成 Figure 数量和 gid 漂移，重绘必须继续携带 editLog，并由现有 renderer 返回漂移诊断。
- 脚本依赖提取只做静态提示，不作为安全边界，也不能替代 renderer 的真实缺列/缺文件错误。

**验证**

- `npm run lint`：通过。
- `npm test`：17 files / 123 tests 通过，其中新增 4 项 Python/R 文件依赖提取测试。
- `npm run build`：通过；保留既有 bundle 大小与 CJS `import.meta` 警告。
- `npm run test:public-auth-smoke`：通过。
- `npm run test:workspace-visual-smoke`：桌面和移动端无水平溢出。
- `npm run test:navigation-reconfigure-smoke`：通过，覆盖资产来源返回、重新配置取消、当前脚本与已有数据恢复、保存 Figure 历史 payload、按语言重绘并返回编辑器。

---

## 2026-07-12 01:56:15 +08:00 编辑器重复渲染提示、无效工具轨与状态标签截断

**状态与级别**

- 状态：已修复并完成真实编辑器回归。
- 级别：P1，影响操作理解与入口可用性，但未改变渲染结果和保存数据。
- 证据等级：E5，已完成源码检查、实现、类型/单元/构建验证及真实 Playwright 编辑器交互。

**现象**

- 顶部已有渲染进度条和画布内进度浮层，预览工具条仍重复显示“正在应用 N 个参数”和耗时，挤占 Figure 操作空间。
- 编辑器最左侧项目资源、图层、资产、字体、历史和设置图标只有本地高亮状态，点击后不执行对应动作。
- 黑色“当前对象 / 右侧编辑”和绿色“实时渲染”状态块在窄工作区被压缩换行，文字显示不完整。

**根因**

- 渲染状态在命令层、工具层和画布层重复表达，没有明确唯一主状态位置。
- `IconSidebar` 只维护 `activeIndex`，没有连接 App 导航、左栏定位、右栏 tab 或历史菜单。
- 状态块缺少 `shrink-0` 和 `white-space: nowrap`，对象名称截断与固定动作标签共用同一收缩空间。

**修复**

- 删除预览工具条内重复的渲染过程 chip，保留已有进度条和画布内渲染反馈。
- 建立 `scifigure:editor-rail-action` 工作区事件：项目资源与图层结构定位左栏，图层按钮聚焦搜索框，字体按钮切换字体中心，历史按钮打开历史菜单；导出资产与设置使用现有 App 导航。
- 当前对象名称可以截断，但“右侧编辑”和“实时渲染”固定保持完整单行；工具条空间不足时横向滚动。
- 保留 SVG 命中、拖拽、Draft、历史、保存和 renderer 数据流不变。

**验证**

- `npm run lint`：通过。
- `npm test`：16 files / 119 tests 通过。
- `npm run build`：通过；保留既有 bundle 大小与 CJS `import.meta` 警告。
- `npm run test:public-auth-smoke`：通过。
- `npm run test:workspace-visual-smoke`：桌面 1440×960 与移动端 390×844 无水平溢出。
- `npm run test:drag-extended-smoke`：全部通过，覆盖连续拖拽、多选拖拽、取消、不支持对象、annotation 与 R native 保护。
- `npm run test:multi-figure-ui-state-smoke`：全部通过，并新增图层搜索聚焦和字体中心切换断言。

---

## 2026-07-12 01:34:47 +08:00 工作区视觉升级后窄画布工具条与右侧中心标签换行

**状态与级别**

- 状态：已修复并完成类型、单元、构建和认证浏览器回归。
- 级别：P2，布局可读性问题，不涉及图元、保存或渲染数据错误。
- 证据等级：E4，浏览器截图发现并完成源码与自动化验证；复杂编辑器拖拽矩阵仍有既有测试基线问题待单独处理。

**现象**

- 编辑器左右栏保持默认宽度时，中间画布工具条中的长按钮会逐字换行并拉高工具条。
- 右侧栏同时显示属性、布局、组件、配色和字体五个中心时，图标与四字标签在 320px 内被压成竖排。

**根因**

- 工具条按钮允许 flex 收缩且未声明 `white-space: nowrap`。
- 右侧中心 tab 同时保留图标、文字和等分宽度，最小内容宽度超过默认右栏宽度。

**修复与约束**

- 工作区工具条按钮使用稳定单行尺寸，容器继续横向滚动，不改变按钮事件和状态。
- 右侧中心 tab 设置最小宽度与横向滚动；常规桌面宽度下隐藏重复图标以保留完整文字。
- 本次视觉升级只改容器类名和 CSS token，不修改 SVG 命中、拖拽 patch、Draft Batch、保存、历史、Figure identity 或 renderer 路径。
- 后续任何工作区视觉调整都必须遵循根目录 `DESIGN.md` 并检查窄工作区下的文字换行和控件遮挡。

**验证**

- `npm run lint`：通过。
- `npm test`：16 files / 119 tests 通过。
- `npm run build`：通过；保留既有 bundle 大小和 CJS `import.meta` 警告。
- `npm run test:public-auth-smoke`：通过。

---

## 2026-07-12 00:18:03 +08:00 宣传页未形成匿名访问门禁，注册入口隐藏在工作台设置页

**状态与级别**

- 状态：Gap，已修复并完成浏览器回归。
- 级别：P1。未登录用户可以看到工作台外壳并尝试导航，产品访问顺序不符合公开服务要求；后端 API 已有认证和所有权检查，因此不是数据越权型 P0。
- 证据等级：E5，已完成源码检查、实现、类型检查、生产构建和真实浏览器自动化验证。

**现象**

- 项目已经存在 `LandingPage`，但它只是 `currentView === 'landing'` 时显示的工作台内部页面。
- `Navbar` 对所有访问者始终渲染，匿名用户仍可看到项目、导入、创建项目和账号设置入口。
- 注册和登录表单只位于设置页，宣传页的主按钮会直接跳转项目创建或项目列表。
- access token 失效时，前端原行为是跳到设置页账号标签，而不是退出到公开宣传页。

**根因**

- 后端 `/api/auth/register`、`/api/auth/login`、`/api/auth/me` 和 refresh cookie 链路已经存在，缺口位于前端顶层访问控制。
- `App.tsx` 没有 `checking/authenticated/anonymous` 认证状态，宣传页和工作台共用同一渲染外壳。
- 项目预览恢复 effect 只判断 `projectId` 和本地 Figure 状态，未把认证成功作为启动条件。

**修复**

- `App.tsx` 新增顶层认证状态检查：加载时检查 access token，并在需要时尝试 refresh cookie。
- 匿名状态只渲染公开宣传页，不渲染工作台 `Navbar`、项目页、编辑器或导出入口。
- 宣传页新增注册/登录对话框，注册或登录成功后保存 access token 并进入工作台首页。
- `scifigure:auth-required` 和退出登录统一返回公开宣传页；设置页登录/退出通过 `scifigure:auth-changed` 同步顶层状态。
- 项目预览恢复渲染增加 `authenticated` 前置条件，匿名访问不会根据旧 session 自动请求项目或渲染。
- 新增 `test:public-auth-smoke`，锁定“匿名宣传页 -> 注册 -> 工作台 -> 刷新保持登录”流程；接口在浏览器测试中使用 mock，不向真实数据库写入测试账号。

**防复发规则**

```text
宣传页不是工作台内部普通 tab，而是匿名用户唯一可见的应用入口。
任何新增工作台页面必须位于 authenticated 分支内。
任何恢复项目、自动渲染或项目数据请求必须等待认证状态确定。
认证失效和退出登录必须清除访问入口并返回宣传页，不能只跳到设置页。
浏览器测试不得直接向真实 data/scifigure.db 创建测试账号。
```

**验证**

- `npm run lint`：通过。
- `npm run build`：通过；保留既有主 bundle 大于 500 kB 和 CJS `import.meta` warning。
- `npm run test:public-auth-smoke`：通过。
- 桌面 2048×1152 截图检查：宣传页品牌、登录和免费注册入口可见，工作台导航不可见。
- 移动端 390×844 截图检查：登录和免费注册按钮保持单行，无首屏遮挡。
- 测试服务使用独立 `SCIFIGURE_DATA_DIR` 和备用端口，未读取或修改真实用户项目数据库。

**2026-07-12 00:46:12 +08:00 宣传页视觉与安全口径复核**

- 宣传页主视觉由独立 `SCIFIGURE_DATA_DIR`、临时测试账号和代码内合成数据生成 2×2 Figure，再从真实编辑器截图裁剪；不使用现有用户项目、研究数据、文件路径或导出资产。
- 主定位从“AI 生成代码”调整为“Python / R 科研 Figure 可编辑工作台”，避免把尚未接入的 AI 自动改图宣传为现有能力。
- 删除“¥10/月建议”等内部规划文案，公开页面不展示尚未形成真实收费闭环的承诺。
- 新增数据与代码安全区块，只陈述已实现的所有权、路径边界和 renderer 隔离能力。
- 云端加密数据盘、备份恢复和生产容器调用链明确标记为上线前仍需部署复测，避免把代码准备误写成在线生效。
- 桌面 1440×1000、移动端 390×844 检查无横向溢出；首屏、编辑能力、安全区块和注册 CTA 均完成截图复核。
- `npm run lint`、`npm test`（16 files / 119 tests）、`npm run build` 和 `npm run test:public-auth-smoke` 均通过。

**2026-07-12 01:03:44 +08:00 用户安全文案与内部实现脱敏复核**

- 安全标题改为“你的数据如何被保护”，不再使用 renderer、挂载目录、环境变量或攻击方式解释平台安全。
- 用户侧分为“数据加密方案”和“服务器安全保护”：传输加密、存储加密、备份加密、账号隔离、受限绘图环境、最小权限与访问记录。
- 页面只承诺正式生产服务经过部署验收后启用的保护结果；内部文档继续保留真实路径、配置、阈值、隔离参数和测试证据。
- 明确禁止在公开页面展示内部目录、服务地址、端口、容器配置、精确资源阈值、拦截规则、管理员接口和告警条件。
- 桌面 1440×1000 和移动端 390×844 浏览器检查无横向溢出，注册、刷新登录和退出回退流程保持通过。

**2026-07-12 01:14:58 +08:00 宣传页动态效果回归保护**

- 首屏真实编辑器背景增加滚动纵深，最大位移受限，不改变文字和按钮几何位置。
- 工作流、编辑能力、安全区块和最终 CTA 首次进入视口时分层显现，不重复闪烁。
- 安全区块增加“加密传输 -> 加密存储 -> 加密备份 -> 受限计算”的连续生命周期提示。
- 浏览器启用 `prefers-reduced-motion: reduce` 时，滚动纵深、循环提示和进入动画全部关闭，内容立即可见。
- `test:public-auth-smoke` 新增进入视口显现检查；浏览器计算样式验证滚动前后背景 transform 变化、生命周期动画存在、减少动态模式不隐藏内容。

---

## 2026-07-07 白色输出画布与真实绘图区控制入口不清晰

**现象**

- 用户在编辑器中看到标签跑到白色画布外，但不知道应调整“整张白色画布”还是“坐标轴框/真实绘图区”。
- 右侧面板已有 `figure.width_in` / `figure.height_in` 控件，也已有 `subplot.left/bottom/width/height` 控件，但命名为“画布尺寸与精度”“子图位置与比例”，用户容易理解成只能改画布，找不到真正的坐标轴框宽高入口。
- R/ggplot facet 子图不支持独立 bounds，但前端批量能力之前没有统一读取 `unsupportedProps` 做禁用保护，容易造成“控件可见但实际不应支持”的误解。

**根因**

- 后端协议已经区分两类尺寸：
  - `global:figure.width_in/figure.height_in` 控制最终白色输出画布。
  - `subplot.*:left/bottom/width/height` 控制 Matplotlib Axes 在白色画布内的真实绘图区/坐标轴框。
- 前端文案没有把这两类尺寸解释清楚，也没有在组件中心批量入口中明确“绘图区宽高”和“画布宽高”的边界。
- R facet 使用 ggplot gtable 共享布局，独立 panel bounds 不等价于 Matplotlib axes bounds，因此只能明确提示不支持，不能假装支持。

**修复**

- 将右侧全局面板标题改为“整张白色画布 / 输出尺寸”，并增加说明：它控制最终导出的白色画布大小和 DPI。
- 将 `subplot.*` 专用面板标题改为“真实绘图区 / 坐标轴框”，将 `left/bottom/width/height` 显示为“绘图区左边距/下边距/宽度/高度”。
- 在 `subplot.*` 面板中增加工作流提示：先固定白色画布，再调整真实绘图区；标签出界时通常需要增大画布或移动/缩小绘图区。
- 前端读取 `currentProps.unsupportedProps`，对 R facet 等不支持独立 bounds 的对象隐藏对应控件并展示不支持原因。
- 组件中心的批量“真实绘图区 / 坐标轴框”入口只对 `subplot` 对象显示，避免误用于 colorbar 等其它 `width/height` 语义不同的对象。

**验证**

- `npx tsc --noEmit`：通过。
- `python tests/test_introspection.py`：通过，16 tests。
- `python tests/test_r_renderer.py`：通过，17 tests。
- `npm test`：通过，5 files / 42 tests。
- `npm run build`：通过；仍存在项目既有 chunk size warning 与 `server.ts` 的 `import.meta` CJS warning。

---

## 2026-07-07 拖动刻度标签后重绘回到原位置

**现象**

- 用户开启拖拽模式后拖动坐标轴刻度标签，例如 `xtick.*` / `ytick.*`。
- SVG 预览阶段标签会跟随鼠标移动，但确认重绘后又回到轴系统原来的布局位置。

**根因**

- Matplotlib 的刻度标签不是普通自由文本，而是由 Axis/Tick layout engine 管理。
- 平台之前把 tick label 按普通 `text` 对象继承了 `position` 编辑能力，前端也允许其进入拖拽写回流程。
- 重绘时 `_freeze_ticklabels_preserving_style()` 和 Matplotlib tick 系统会重新固化刻度位置，因此自由 `position` patch 不具备稳定回放语义。
- 正确的稳定控制参数应是 `axis.x/y.*` 上的 `tick_pad`、`tick_rotation`、`tick_labelsize`、`tick_labelfamily`、`tick_labelcolor`，以及 `subplot.*` 绘图区边距/宽高。

**修复**

- `renderer/introspector.py`：
  - 对 `xtick.*` / `ytick.*` 移除 `position` 可编辑字段。
  - 保留 `fontsize`、`fontfamily`、`fontweight`、`fontstyle`、`color`、`rotation` 等样式编辑。
  - 在 `currentProps` 中加入 `positionEditable=false` 与原因说明。
- `src/components/ChartPreview.tsx`：
  - 拖拽模式下显式排除 `xtick.*` / `ytick.*` 及 `x_tick_label` / `y_tick_label` 角色。
  - 用户尝试拖动刻度标签时提示改用轴面板的刻度间距、旋转、字号或绘图区边距。
- `tests/test_introspection.py`：
  - 新增回归测试，确认 tick label 不再暴露不稳定的 `position`，但仍保留样式编辑能力。

**验证**

- `python tests/test_introspection.py`：通过，17 tests。
- `python tests/test_r_renderer.py`：通过，17 tests。
- `npx tsc --noEmit`：通过。
- `npm test`：通过，5 files / 42 tests。
- `npm run build`：通过；仍存在项目既有 chunk size warning 与 `server.ts` 的 `import.meta` CJS warning。

---

## 2026-07-07 需要整体平移刻度文字但保持刻度线不动

**需求**

- 用户希望将横坐标刻度文字整体向右微调一点。
- 刻度线、刻度值和数据坐标范围不能变化。
- 不能回到之前“自由拖拽单个 tick label”的不稳定方案。

**设计**

- 新增轴级稳定参数：
  - `tick_label_dx`：刻度文字水平偏移，单位 pt。
  - `tick_label_dy`：刻度文字垂直偏移，单位 pt。
- 该参数作用在 `axis.x.*` / `axis.y.*`，通过 Matplotlib text transform 加 `ScaledTranslation` 实现。
- 偏移只作用于 tick label 文本，不调用 `set_xticks` / `set_xlim`，因此不会移动刻度线、不会改变数据范围。
- R/ggplot 暂不暴露该控件；ggplot 需要另走 theme margin / justification 映射，不能复用 Matplotlib transform 方案。

**修复**

- `renderer/introspector.py`：
  - 在 axis manifest 中加入 `tick_label_dx` / `tick_label_dy`。
  - 在 axis patch 中支持这两个参数。
  - 在 `_freeze_ticklabels_preserving_style()` 后重新应用 tick label offset，避免 Matplotlib 固化 tick labels 时丢失偏移。
- `src/components/RightSidebar.tsx`：
  - 在轴详情面板中显示“刻度文字水平偏移(pt)”和“刻度文字垂直偏移(pt)”。
  - 仅当 manifest 明确声明 editable 时显示，避免 R 路径出现假控件。
- `tests/test_introspection.py`：
  - 新增回归测试，确认设置 offset 后 manifest 可读回，同时轴 limits 不变。

**验证**

- `python tests/test_introspection.py`：通过，18 tests。
- `python tests/test_r_renderer.py`：通过，17 tests。
- `npx tsc --noEmit`：通过。
- `npm test`：通过，5 files / 42 tests。
- `npm run build`：通过；仍存在项目既有 chunk size warning 与 `server.ts` 的 `import.meta` CJS warning。

---

## 2026-07-07 拖动图例内部文字导致文字跑到左下角

**现象**

- 用户在拖拽模式下移动图例相关内容。
- 图例中的线条/点/色块位置不变，但图例文字脱离图例布局，跑到左下角或其它异常位置。

**根因**

- Matplotlib legend 是一个容器布局系统。
- `legend.0` 是可稳定移动的图例容器。
- `legend_text.*` / `legend_title.*` / `legend_line.*` / `legend_patch.*` 是容器内部子对象，位置由 legend layout 管理。
- 旧协议把 `legend_text.*` / `legend_title.*` 作为普通 text 继承了 `position` 编辑能力；一旦写入 position patch，文字会脱离 legend 容器，而图例符号仍留在容器布局中。

**修复**

- `src/components/ChartPreview.tsx`：
  - 拖拽模式下点击 `legend_text.*` / `legend_title.*` / `legend_line.*` / `legend_patch.*` 时，自动归一到对应 `legend.N` 容器。
  - `legend_text` / `legend_marker` 角色不再作为独立可拖拽对象。
- `renderer/introspector.py`：
  - `legend_text.*` / `legend_title.*` 不再暴露 `position` 编辑能力。
  - 保留图例文字的字体、字号、颜色、字重、斜体等样式编辑能力。
  - 对旧 editLog 中的 `legend_text.* position` / `legend_title.* position` 返回 `unsupported_legend_child_position`，避免继续破坏图例布局。
- `tests/test_introspection.py`：
  - 新增回归测试，确认 `legend.0` 仍可移动，`legend_text.*` 不暴露 `position`，旧子文字 position patch 会被拒绝并产生 warning。

**验证**

- `python tests/test_introspection.py`：通过，19 tests。
- `python tests/test_r_renderer.py`：通过，17 tests。
- `npx tsc --noEmit`：通过。
- `npm test`：通过，5 files / 42 tests。
- `npm run build`：通过；仍存在项目既有 chunk size warning 与 `server.ts` 的 `import.meta` CJS warning。

---

## 2026-07-07 多图模式从 3 张扩展到更多 Figure 时前端不显示新增图

**现象**

- 用户怀疑多图模式被限制为最多 3 张 Figure。
- Python 后端实际可以捕获任意数量的 Matplotlib Figure，但当前前端在项目已有 3 张图时，如果代码重新渲染生成 4 张或更多，Figure 切换条仍可能只显示旧的 3 张。

**根因**

- 后端 `renderer/introspector.py` 按 `unique_figures` 循环返回 `fig_1 ... fig_N`，没有 3 张上限。
- 前端 `src/App.tsx` 多个全量项目渲染成功分支使用 `Object.keys(projectFigures)` 作为更新范围。
- 当代码生成了新增 Figure，例如 `fig_4` / `fig_5`，这些 id 不在旧 `projectFigures` 中，因此前端不会把后端返回的新 Figure 合并进状态。
- 这表现为“后端说捕获了更多图，但编辑器仍只能切到旧的几张图”。

**修复**

- `src/App.tsx`：
  - 新增 `mergeReturnedProjectFigures()`，全量项目渲染成功后以后端返回的 `data.figures` 为准重建 `projectFigures`。
  - 保留同名 Figure 的 editLog / revision fallback，但允许新增 `fig_N` 自动进入前端状态。
  - 当 Figure 数量减少时，前端状态也随返回结果收敛，避免旧 Figure 残留。
  - 清理 `selectedFigureIds`，移除已不存在的 Figure；当前 active Figure 不存在时自动切到返回的第一张。
  - 修复空 Figure 项目首次渲染时 requestId 无绑定导致渲染状态可能不结束的边界。
- `tests/test_introspection.py`：
  - 新增 Python 回归测试，脚本创建 5 张 Matplotlib Figure 时必须返回 `fig_1` 到 `fig_5`。

**验证**

- `python tests/test_introspection.py`：通过，20 tests。
- `python tests/test_r_renderer.py`：通过，17 tests。
- `npx tsc --noEmit`：通过。
- `npm test`：通过，5 files / 42 tests。
- `npm run build`：通过；仍存在项目既有 chunk size warning 与 `server.ts` 的 `import.meta` CJS warning。

**遗留说明**

- Python/Matplotlib 多 Figure 路径现在按代码实际生成数量显示。
- R 项目渲染当前仍由 `server.ts` 包装为单 `fig_1`，这是 R 渲染路径的现有限制，不属于 Python 多图显示上限。

---

## 2026-07-06：画布顶栏控件覆盖 Figure 批量选择复选框

**现象**

- 画布升级时把 Figure 切换器从画布浮层移动到顶部预览工具栏。
- 在自动化回归中，点击 `选择 Figure 2 作为批量应用目标` 超时。
- Playwright 证据显示右侧状态胶囊（`实时渲染` / `真实 SVG 对象可直接编辑`）拦截了 Figure 复选框的 pointer event。

**根因**

- 平台 UI 布局问题。
- Figure 选择器和右侧状态区放在同一行，窄宽度或状态文案较长时发生视觉重叠，导致复选框虽然可见但点击目标被右侧元素覆盖。

**修复记录**

- `src/components/MainWorkspace.tsx`：
  - 将 Figure 选择器从顶栏同一行拆到预览区上方的独立窄工具条。
  - 工具条保持在画布外部，不再遮挡图形内容。
  - 选中对象黑色浮层从画布内部移到顶部状态 chip，避免中间黑色浮层裁切/遮挡。
- `src/components/ChartPreview.tsx`：
  - 画布铺满预览区域。
  - 缩放和操作提示移动到底部 HUD。
  - 拖拽确认条移动到顶部安全区。

**验证**

- `npx tsc --noEmit`：通过。
- `npm test`：通过，42/42。
- `npm run test:drag-extended-smoke`：通过，覆盖连续拖拽、多选拖拽、取消、R native 保护。
- `npm run test:cross-figure-smoke`：通过，覆盖 Figure 复选框点击、应用全部、应用选中、多子图 grid/spine fanout。
- `npm run build`：通过；仍存在项目既有 Vite chunk 过大和 `server.ts import.meta` CJS 警告。

**遗留风险**

- `npm run test:behavior-smoke` 在 `http://localhost:3100` 仍有 3 项失败：stale 文本最终断言、导出最新文本断言、Vite HMR WebSocket console/page error。导出矩阵专项测试已通过，行为 smoke 的 patch/export 最新文本一致性需单独调查，不能归因于本次画布布局改动。

---

## 2026-07-03：R 项目渲染误走 Python 校验与上传 CSV 读取失败

**相关诊断文件**

- `C:\Users\SZC\OneDrive\Desktop\发票报账\R语言测试_render_diagnostic_2026-07-03T09-09-49-298Z.md`

**现象**

- 诊断中的脚本内容是 R/ggplot2，但代码块标记显示为 `python`。
- 日志同时出现两类错误：
  - `脚本安全校验失败: Syntax Error: invalid syntax at line 7`
  - `R script failed: 'file'...`
- 用户脚本使用：

```r
read.csv(uploaded_file_paths[["cluster_type_TP_boxplot_altscheme_analysis_data.csv"]], check.names = FALSE)
read.csv(uploaded_file_paths[["cluster_type_TP_altscheme_group_statistics(1).csv"]], check.names = FALSE)
```

**根因**

- 平台问题 1：项目级 `/api/projects/:id/figures/render` 之前按 Python 路径先做 AST 校验，R 脚本中的 `library()` / `<-` 会被 Python parser 当成语法错误。
- 平台问题 2：R 渲染路径直接把项目文件路径交给 R `read.csv()`。在 Windows 下，项目根路径包含中文时，R 对 `setwd()` 和绝对路径读取不稳定。
- 平台问题 3：该 CSV 包含中文表头、Unicode 单位、引号内逗号等内容，base R `read.csv()` 对这类上传文件解析不稳定，出现 `no lines available in input` / 列数不匹配等错误。
- AI 转义脚本本身不是首要问题：脚本按平台约定使用 `uploaded_file_paths[[原始文件名]]` 读取多文件，这个用法是合理的。

**修复记录**

- `server.ts`：
  - 新增/统一 `inferScriptLanguage()`，项目渲染接口按 R/Python 分流。
  - R 项目渲染不再调用 Python `validateAst()`。
  - R 渲染前把上传文件复制到 ASCII 临时目录，避免 R 直接访问中文项目路径。
  - 对 CSV/TSV/TXT 上传文件使用 PapaParse 预解析，生成 `.scifigure-table.json` sidecar，并通过 `csv_json_paths` 注入 R renderer。
- `renderer/r_renderer.R`：
  - `read.csv()` / `read.table()` 优先检测 `csv_json_paths`。
  - 命中平台 sidecar 时，直接把 JSON rows 转成 data.frame，并尊重 `check.names = FALSE`，避免 base R CSV parser 处理复杂中文 CSV。
  - 未命中 sidecar 时继续回退到 base R 读取，兼容普通本地 R 脚本。
- `tests/test_r_renderer.py`：
  - 新增上传 CSV JSON bridge 回归测试，覆盖中文表头、引号内逗号、`uploaded_file_paths[[...]]` 读取路径。

**验证**

- 真实诊断项目 `cc147f0d-be84-4fd7-9af7-cc68516af537` 重新调用 `/api/projects/:id/figures/render`：
  - `status: success`
  - `language: r`
  - `figures: 1`
  - `manifest.objects: 20`
  - `svgLength: 33283`
- `C:\Users\SZC\.conda\envs\Machine-learning\python.exe tests/test_r_renderer.py`：通过，9/9。
- `C:\Users\SZC\.conda\envs\Machine-learning\python.exe tests/test_introspection.py`：通过，12/12。
- `npx tsc --noEmit`：通过。
- `npm run lint`：通过。
- `npm run build`：通过；仍存在项目既有警告：前端 chunk 超过 500KB、CJS build 下 `import.meta.url` 警告。

**状态**

- 平台 R 多文件读取路径已修复并通过真实项目验证。
- 诊断导出中代码块语言标记仍显示 `python`，属于诊断文档展示问题，不影响渲染；后续可把诊断导出按 `script_language` 标成 `r`。

---

## 2026-07-02：多文件项目单图渲染数据绑定错误

**相关诊断文件**

- `C:\Users\SZC\OneDrive\Desktop\发票报账\示例_render_diagnostic_2026-07-02T06-57-51-031Z.md`
- `C:\Users\SZC\OneDrive\Desktop\发票报账\示例_render_diagnostic_2026-07-02T07-12-20-022Z.md`

**现象**

- 早期错误：脚本通过 `_uploaded_file_paths["文件名"]` 读取多文件时，在部分 patch/code-patch 路径里找不到上传文件路径。
- 当前错误：`脚本执行失败: 'feature'`，诊断显示当前 `_uploaded_data` 的列是 `FL9_机制重绘输入矩阵.csv` 的列：
  `Sample_ID, LNRR, Response_Group, OPR, NaHCO3_P, DOC, OPR_FeP, FeII, NH4_NO3_Ratio, log_nosZ_norB_Ratio`
- 但脚本在 `plot_fl9_panel()` 中执行 `stats_df["feature"]`，实际需要的是 `FL9_机制变量统计表.csv`。

**根因**

- 平台问题已修：项目模式的 patch/code-patch 路径之前过度依赖 `sessionId`，当 session 上下文缺失或不完整时，无法稳定重建 `_uploaded_file_paths`。
- 当前诊断的新问题是 AI 转义脚本的数据绑定错误：脚本使用 `pd.DataFrame(_uploaded_data)` 作为 `stats_df`，但 `_uploaded_data` 在该项目中对应第一个上传文件 `FL9_机制重绘输入矩阵.csv`，不是统计表。因此缺少 `feature` 列。

**平台修复记录**

- `server.ts`：新增项目 Figure 上下文回退解析，支持从 `projectId + figureId` 或 `${projectId}_fig_N` 形式的 session 标识重建项目文件路径、主数据、工作目录和数据集上下文。
- `src/App.tsx`：项目模式下调用 `/api/figure/patch` 和 `/api/figure/code-patch` 时同时发送 `projectId` 与 `figureId`，避免后端只能依赖 session。
- 验证：创建临时多文件项目，脚本通过 `_uploaded_file_paths["input.csv"]` 读取数据；随后用错误 `sessionId` 但正确 `projectId + figureId` 调用 code-patch，仍能重建文件路径并成功渲染。

**AI 转义修复要求**

多文件脚本不要用 `_uploaded_data` 代替任意表。每一张表必须按原始文件名显式读取：

```python
def load_data() -> tuple[pd.DataFrame, pd.DataFrame, pd.DataFrame]:
    fl9_data = pd.read_csv(_uploaded_file_paths["FL9_机制重绘输入矩阵.csv"])
    stats_df = pd.read_csv(_uploaded_file_paths["FL9_机制变量统计表.csv"])
    opr_fep_df = pd.read_excel(
        _uploaded_file_paths["OPR_FeP二维交互响应图_绘图数据.xlsx"],
        sheet_name="输入数据与预测",
    )
    return fl9_data, stats_df, opr_fep_df


fl9_data, stats_df, opr_fep_df = load_data()
build_figure(fl9_data, stats_df, opr_fep_df)
```

**预防动作**

- 已更新 `docs/AI-PROMPT.md`：多文件项目必须显式读取每个文件，禁止把 `_uploaded_data` 当成统计表、映射表或预测表。
- AI 转义脚本应在读取后校验每个文件的必需列，错误信息必须包含文件名、缺失列和当前列。

**状态**

- 平台上下文注入问题：已修复并验证。
- 当前 `feature` 缺列问题：属于当前转义脚本的数据绑定错误，需要按上面的多文件读取结构修正脚本。

---

## 2026-07-02：配色中心改颜色后无法撤销

**现象**

- 用户在配色中心修改颜色后，点击撤销没有恢复到改色前的颜色。
- 普通属性颜色修改通常走 `editLog`，但配色中心的“修改组颜色代码常量”走 `code_patch`。

**根因**

- 项目模式的历史快照只保存了 `editLog`。
- 配色中心全局改色会修改 Python 脚本里的颜色常量，即修改 `script`，但不会形成对应的普通 `editLog` 颜色条目。
- 撤销时系统只把 `editLog` 回退，再用当前脚本重新渲染；当前脚本已经是改色后的脚本，所以颜色不会回退。

**修复记录**

- `src/schemas/manifest.ts`：`HistorySnapshot` 增加可选 `script` 字段。
- `src/App.tsx`：
  - `makeHistorySnapshot()` 支持保存当前脚本。
  - 项目撤销、重做、历史跳转时，如果快照包含脚本，则用快照脚本重新渲染。
  - 撤销由 code_patch 产生的颜色变化时，即使 `editLog` 为空，也允许根据历史快照回退。
  - 回退脚本后同步更新 `spec.custom_script`，避免下一次重渲染又使用改色后的脚本。

**验证**

- `npx tsc --noEmit`：通过。
- `npm run lint`：通过。
- `npm run build`：通过；仍存在已知打包警告：chunk size 超过 500KB、`server.ts` 的 CJS `import.meta.url` 警告。

**状态**

- 新产生的配色中心 code_patch 历史已支持撤销/重做。
- 旧 sessionStorage 中已经存在的历史快照不包含 `script` 字段，无法补全过去的脚本快照；重新改色后生成的新历史可正常回退。

---

## 2026-07-02：拖拽模式引入后普通选中、文本拖动和子图选框失效

**现象**

- 未开启拖拽开关时，用户不能像旧版一样单击 SVG 图元后在右侧属性面板编辑。
- 开启拖拽开关后，用户期望直接拖动文本/标签，不需要按空格；实际拖不动任何内容。
- 在子图面板中选中某个子图时，画布没有出现对应子图选框。

**根因**

- `ChartPreview.tsx` 使用了 `[id="${CSS.escape(gid)}"]` 形式的属性选择器查找 SVG 节点。
- `CSS.escape("title.0")` 会生成带反斜杠的字符串，放进属性选择器后会查找字面量反斜杠，导致 `title.0`、`axes.0`、`spine.left.0` 等 Matplotlib gid 查找失败。
- 选中框、框选和拖拽预览都依赖这个查找链路，所以表现为“选中了但没有框”“拖拽找不到元素”。
- `subplot.N` 是平台生成的逻辑对象，不一定有同名 SVG 节点；真实 SVG 里对应的是 Matplotlib 输出的 `axes.N` 分组，因此子图选中需要显式回退映射。

**修复记录**

- `src/components/ChartPreview.tsx`：
  - 新增 `querySvgElementById()`，统一使用 `#${CSS.escape(id)}` 的 ID 选择器查找真实 SVG 节点。
  - 新增 `getSelectableSvgElement()`，当选中 `subplot.N` 时回退到 `axes.N`，保证子图面板选中能显示画布选框。
  - 选中框、框选、多选、拖拽预览和拖拽恢复全部切到同一套查找函数，避免不同交互路径行为不一致。
  - 拖拽模式下，文本对象显示 `grab` 光标并允许直接拖动；空格只保留为平移画布用途。
  - 只有实际移动超过阈值时才生成“确认位置”patch，避免单击文本就产生无意义的位置修改。

**验证**

- `npx tsc --noEmit`：通过。
- `npm run lint`：通过。
- `npm run build`：通过；仍存在项目既有警告：前端 chunk 超过 500KB、`server.ts` 的 CJS `import.meta.url` 警告。

**状态**

- 已完成代码修复和静态验证。

---

## 2026-07-02：拖拽后文本跳回原位且没有确认/取消提示

**现象**

- 拖拽模式开启后，文本拖动过程中可以跟随鼠标移动。
- 松开鼠标后，文本立即跳回原来的位置。
- 画布上没有出现“确认位置 / 取消”的提示条，因此位置无法写回 Python 坐标。

**根因**

- 拖拽过程中只是对 SVG 节点临时写入 `transform translate(...)`，真正持久化依赖松手时生成 `position` 类型的 `backend_patch`。
- `buildPositionPatch()` 对 axes 坐标系文本需要找到所属子图的坐标框；旧 manifest 或部分文本对象可能缺少 `subplotId/source.axesIndex`，导致无法计算归一化坐标变化，最终返回空 patch。
- patch 数组为空时，前端会调用 `clearDragPreview()` 清掉临时 transform，所以表现为文本跳回原位。
- 另外，原逻辑在生成 pending patch 后立刻清空 `dragStartRef`，会破坏后续“取消”恢复预览位置的能力。

**修复记录**

- `src/components/ChartPreview.tsx`：
  - 新增 `inferAxesIndexFromGid()`，从 `source.axesIndex`、`subplotId` 和常见 gid 后缀（如 `title.0`、`xlabel.0`、`legend_text.0.1`）多级推断所属子图。
  - `getAxesBoxForObject()` 使用该推断结果作为兜底，避免旧 manifest/缺字段文本无法生成位置 patch。
  - 如果仍无法找到物理 axes 框，则用 SVG viewBox 尺寸做保底换算，避免静默放弃 patch。
  - window `pointerup` 处理器使用最终松手坐标重新计算位移，避免最后一帧 pointermove 丢失导致 patch 为零。
  - React 画布容器自身的 `onPointerUp` 也会调用同一套 finalize 逻辑，避免 pointer capture 场景下只依赖 window 事件导致结束拖拽不稳定。
  - 有待确认 patch 时保留拖拽预览上下文，不立即清空 transform；只有取消、无有效移动或 SVG 重新渲染时才清理。
  - 增加 `dragPendingRef`，防止用户点击“确认/取消”按钮时的 pointerup 被误当作新的拖拽结束重新计算位置。
  - 点击“确认位置”时保留当前预览 transform，只清理内部拖拽状态，避免确认瞬间先跳回原位再等待后端渲染的闪烁。

**验证**

- `npx tsc --noEmit`：通过。
- `npm run lint`：通过。
- `npm run build`：通过；仍存在项目既有警告：前端 chunk 超过 500KB、`server.ts` 的 CJS `import.meta.url` 警告。
- 已重启 `npm run dev` 服务；新服务监听 `http://localhost:3000`，启动时间约 `2026-07-02 18:50`。

**状态**

- 已完成代码修复和静态验证。
- 仍需浏览器手动确认：拖动文本后提示条出现；点击取消恢复原位；点击确认后重新渲染并保留新位置。

**后续实测补充**

- 现象：确认/取消条已经出现，拖动中对象能随鼠标移动，但松手后对象仍像“粘在鼠标上”；必须取消选中才能点击确认/取消。
- 进一步根因：`dragStartRef` 同时承担“正在拖动”和“待确认可恢复”的两种状态。进入待确认后它仍然存在，`pointermove` 继续按正在拖动处理，导致对象持续跟随鼠标。
- 二次修复：
  - 拆分 `dragStartRef`（拖动中）与 `dragRestoreRef`（待确认恢复用）。
  - 松手生成 pending patch 后释放 pointer capture，并把 session 移入 `dragRestoreRef`，同时清空 `dragStartRef`。
  - `pointermove` 在 `dragPendingRef` 为 true 时直接返回，冻结当前位置。
  - 确认/取消浮层阻止 pointer/click 冒泡，避免点击按钮时继续触发底层画布事件。
- 二次验证：
  - `npx tsc --noEmit`：通过。
  - `npm run lint`：通过。
  - `npm run build`：通过；仍存在项目既有警告。
  - 已重启 `npm run dev` 服务；新服务监听 `http://localhost:3000`，启动时间约 `2026-07-02 18:57`。

**第三次实测补充**

- 现象：松手后仍有闪烁；确认后能重渲染，但最终位置与拖拽预览不一致，例如向右拖很远，实际只移动约一半距离。
- 进一步根因：拖拽预览和写回 patch 使用的是 `screenDelta / scale` 估算 SVG 位移。该估算没有严格等价于 Matplotlib SVG 的 user units，尤其在 CSS scale、SVG viewBox、导出 width/height 单位同时存在时会产生比例误差。
- 三次修复：
  - `DragSession` 改为记录 `startSvg`，不再只记录屏幕坐标。
  - `pointermove` 和 `pointerup` 都通过 `getSvgPoint(clientX, clientY)` 转为 SVG 坐标。
  - 预览 transform 和 `position` patch 共用同一个 SVG 坐标差 `currentSvg - startSvg`，避免“看见的位置”和“写回的位置”使用两套坐标。
- 三次验证：
  - `npx tsc --noEmit`：通过。
  - `npm run lint`：通过。
  - `npm run build`：通过；仍存在项目既有警告。
  - 已重启 `npm run dev` 服务；新服务监听 `http://localhost:3000`，启动时间约 `2026-07-02 20:50`。

**第四次浏览器自动化实测补充**

- 现象：确认后位置已经准确，但松手待确认阶段仍闪烁/回原位。
- 进一步根因：
  - React 状态更新 `setPendingPositionPatches()` 会触发组件重渲染，`dangerouslySetInnerHTML` 重新写入 SVG 内容，覆盖掉命令式写入的临时 `transform`。
  - 因此即使最终 patch 坐标正确，待确认状态下的预览位置也会丢失。
- 四次修复：
  - 将待确认 transform 保存在 `dragPreview` 状态中。
  - 增加 `applyDragPreviewTransform()`，在 `dragPreview/pendingPositionPatches` 变化后重新把 transform 写回 SVG。
  - 后端 `introspector.py` 给 `ax.patch` 写入稳定 `axes.patch.{idx}` gid。
  - 前端 axes 坐标换算优先使用 `axes.patch.{idx}`，旧 SVG 兜底 `patch_{idx+2}`，最后才使用整图 viewBox。
- 自动浏览器验证：
  - 测试图：单 axes，文本 `text.0.0` 使用 `ax.transAxes`。
  - 操作：拖拽 `120px` 向右、`40px` 向下。
  - 松手待确认位置：`+120.000px, +39.999px`。
  - 点击确认并后端重渲染后位置：`+119.999px, +40.157px`。
  - 结论：预览位置与确认后位置已保持像素级一致。
- 四次验证：
  - `npx tsc --noEmit`：通过。
  - `npm run lint`：通过。
  - `C:\Users\SZC\.conda\envs\Machine-learning\python.exe tests\test_introspection.py`：12/12 通过。
  - `npm run build`：通过；仍存在项目既有警告。

**第五次功能小修：连续拖动多个对象后一次性确认**

- 现象：进入拖拽模式后，用户可能连续移动多个文本/标签，再统一确认。但旧逻辑每次开始拖动都会清空上一轮 `pendingPositionPatches`，只能记录最后一次移动。
- 根因：拖拽 pending 状态以数组保存，缺少按 gid 聚合的累计状态；取消恢复也只保留当前拖拽 session。
- 修复：
  - 新增 `pendingDragDeltasRef`：按 gid 累计每个对象相对原始位置的 SVG 位移。
  - 新增 `pendingPatchMapRef`：按 gid 保存最终要提交的 position patch，同一对象多次移动时只保留最后位置。
  - 新增 `pendingOriginalTransformsRef`：保存每个移动过对象的原始 transform，用于取消时一次性恢复所有对象。
  - 新拖动不再清空已有 pending；确认时提交所有移动过对象，取消时恢复所有移动过对象。
  - 提示文案改为“已累计移动 N 个文本对象”。
- 自动浏览器验证：
  - 连续拖动 `text.0.0`：`+80px, +20px`。
  - 连续拖动 `text.0.1`：`-60px, +35px`。
  - 松手待确认提示：`已累计移动 2 个文本对象`。
  - 确认后重渲染：
    - `text.0.0`：`+79.999px, +20.157px`。
    - `text.0.1`：`-60.000px, +35.157px`。
  - 结论：多对象累计拖动与一次性确认已按预期工作。
- 验证：
  - `npx tsc --noEmit`：通过。
  - `npm run lint`：通过。
  - `npm run build`：通过；仍存在项目既有警告。

---

## 2026-07-06 跨图“应用全部图”从单图应用到多子图时只改左上角

**现象**

- 一段代码生成 3 张 Figure，其中 `fig_3` 是 2x2 多子图。
- 用户在 `fig_2` 单图里修改框线/刻度等样式后点击“应用全部图”。
- 结果 `fig_3` 只有左上角第一个子图生效，其余子图没有同步。

**根因**

- `src/utils/semanticPatchMapping.ts` 的跨 Figure 映射每条 patch 只返回一个目标 gid。
- 当源 Figure 是单子图，目标 Figure 是多子图时，`spine_group.0`、`axis.x.0` 等 gid 会优先命中目标的 `subplot.0` 相关对象。
- 对于样式类操作，用户语义是“把这个样式应用到目标 Figure 的所有同类子图”；旧逻辑错误地按“找一个最佳匹配对象”处理。
- 进一步验证发现组件中心“边框 / 网格”实际会发送 `grid.*` 和四边 `spine.left/right/top/bottom.*` patch；旧 fanout 如果不保留 spine 边方向，会把 left/right/top/bottom 都映射到目标 left 边，造成重复和漏改。

**修复**

- 为跨 Figure 语义映射增加样式类 fanout：
  - 仅当源 Figure 为单子图、目标 Figure 为多子图时触发。
  - 仅对样式类属性触发，例如 `linewidth`、`color`、`tick_labelsize`、`tick_width`、`visible` 等。
  - 文本内容、坐标范围、位置、布局类 patch 仍保持一对一，避免误改。
- 为单边 `spine` 增加同边约束：
  - `spine.left.0` 只映射到目标 `spine.left.*`。
  - `spine.right/top/bottom` 同理。
- 扩展 `tests/playwright/cross_figure_apply_smoke.mjs`：
  - fixture 改为 3 张图，`fig_3` 为 2x2 多子图。
  - 新增 `X3-single-to-multisubplot-style-fanout`，验证从 `fig_2` 单图修改“边框 / 网格”线宽后，`fig_3` 收到 `grid.0-3` 和四边 `spine.left/right/top/bottom.0-3` patch。

**验证**

- `npm test`：通过，5 files / 42 tests。
- `npx tsc --noEmit`：通过。
- `npm run test:cross-figure-smoke`：通过。
- 最新报告：
  - `output/playwright/cross-figure-apply-2026-07-06T13-16-03-214Z/report.md`
  - `Conclusion: PASS, PASS=5, FAIL=0, BLOCKED=0`

---

## 2026-07-06 拖拽模式连续移动第二个文本时仍停留在第一个对象

**现象**

- 用户开启拖拽模式后，先拖动第一个文本对象，不点击“确认位置”。
- 再尝试拖动第二个文本对象时，第二个对象没有进入待确认队列；表现为只能记录第一次拖拽，继续选第二个时状态仍像停留在第一个对象。
- 该路径不等同于“预先多选两个对象后拖动一次”，旧自动化只覆盖了后者。

**根因**

- 待确认浮层位于画布上方，文案容器使用默认 `pointer-events:auto`。
- 当待确认浮层覆盖在第二个文本对象上方时，浏览器命中的是浮层 `div`，不是 SVG 文本节点，`handleSvgPointerDown` 无法进入文本拖拽分支。
- 前端拖拽协议之前没有明确区分“待确认 UI”与“画布交互层”的指针事件边界，也缺少“先拖 A 待确认，再拖 B 待确认”的 sequential regression test。

**修复**

- 将待确认浮层和拖拽提示浮层改为 `pointer-events:none`，避免遮挡画布拖拽命中。
- 将“确认位置 / 取消”按钮单独保留 `pointer-events:auto`，确保按钮仍可点击。
- 增加坐标级拖拽命中兜底：拖拽模式下优先使用 `event.target`，若目标不是可拖文本，则按鼠标坐标扫描可拖文本 bbox，降低 SVG path / overlay / target retargeting 导致的误命中。
- 拖拽结束后抑制紧随其后的 click 事件，避免 click 事件把已拖动对象又改回旧选中态。
- active drag 期间重放已有 pending transform，但不让 pending replay 覆盖正在拖动的新对象。

**验证**

- 新增 `tests/playwright/drag_extended_smoke.mjs` 的 `D1-sequential-drag`：
  - 拖动 `text.0.0` 后不确认，确认条显示累计 1 个文本对象。
  - 继续拖动 `text.0.1` 后不确认，确认条显示累计 2 个文本对象。
  - 点击确认后只发送 1 个 `/api/figure/patch` 请求，包含 `text.0.0` 与 `text.0.1` 两条不同 `position` patch。
- `npm run test:drag-extended-smoke`：通过。
- 最新报告：
  - `output/playwright/drag-extended-2026-07-06T13-37-15-217Z/report.md`
  - `Conclusion: PASS, PASS=7, FAIL=0, BLOCKED=0`
- `npx tsc --noEmit`：通过。
- `npm test`：通过，5 files / 42 tests。
- `npm run build`：通过；仍存在既有 chunk size warning 与 `server.ts` 的 `import.meta` CJS warning。

---

## 2026-07-07 组合代码项目多文件数据源错配与渲染中不停止

**现象**

- 用户从多个 Figure 创建“组合代码项目”后，AI 转写出的脚本渲染失败。
- 诊断文件 `组图_render_diagnostic_2026-07-07T03-12-24-487Z.md` 报错：
  - `SHAP data must contain 'display_name' and 'mean_abs_shap' columns`
- 前端同时出现“渲染中”状态不停止的问题。

**根因**

- 当前组合项目包含多个数据文件，第一份文件是 `Table4_classification_metric_summary.csv`，SHAP 表实际是 `Table6_logistic_shap_summary.csv`。
- AI 转写代码中的 `load_shap_data()` 使用 `pd.DataFrame(_uploaded_data)`，但平台多文件项目里 `_uploaded_data` 是默认/首个数据表，不等于用户想要的 SHAP 表。
- 因此 `display_name`、`mean_abs_shap` 不存在，脚本主动抛出 ValueError。
- 渲染状态不停止的前端问题来自项目级渲染请求的全局 loading 收敛条件过窄：部分分支用当前 active figure 的 `requestId` 判断是否关闭 `projectIsRendering`。用户切换 Figure、跨图渲染、或错误返回后，目标 Figure 已进入 error，但全局 loading 可能仍保持 true。

**修复**

- 收紧组合代码项目生成的网页 AI 提示词：
  - 多文件项目禁止使用 `_uploaded_data` 猜当前数据。
  - 必须通过 `_uploaded_file_paths["具体文件名.csv"]` / `_uploaded_file_paths["具体文件名.xlsx"]` 精确读取每个面板需要的数据。
  - 绘图前必须断言对应 DataFrame 是否包含所需列，并在错误中明确文件名和缺失列。
- 前端项目级渲染状态改为活跃请求集合：
  - 开始项目级渲染时登记 `requestId`。
  - 成功、失败、异常、stale response 结束时注销该 `requestId`。
  - 只有活跃请求集合为空时才关闭 `projectIsRendering` 和 `renderProgressText`。
  - 图级 stale response guard 仍保留，只是不再用 active figure 判断全局 loading 是否收敛。

**当前诊断对应的代码修正建议**

- 将：
  - `df = pd.DataFrame(_uploaded_data)`
- 改为：
  - `df = pd.read_csv(_uploaded_file_paths["Table6_logistic_shap_summary.csv"])`
- 如果新项目中复制后的文件名带项目名前缀，应使用组合提示词列出的 copied filename。

**验证**

- 待本次代码改动完成后运行：
  - `npx tsc --noEmit`
  - `npm test`
  - `npm run build`
  - `npm run test:composition-code-project`

---

## 2026-07-08 语义层升级后本地颜色修改保存刷新丢失

**现象**

- 用户在配色中心/属性面板中只修改某个散点、线条或图例对象颜色。
- 页面预览能立即看到颜色变化，点击顶部“保存”后也没有报错。
- 刷新或重新进入项目后，该颜色修改消失，表现为“保存功能受限”。

**根因**

- 语义编辑意图层引入 Draft Patch Batch 后，`local_patch` 不再立即走后端重绘，而是先保存在前端 `projectDrafts` 并直接作用于 SVG 预览。
- 旧保存链路只保存项目 `spec.editLog` 或当前 Figure 的已有 `editLog`，没有把尚未“应用重绘”的 `local_patch` 草稿写入对应 `project_figures` 的 Figure session。
- 后端 `PUT /api/projects/:id` 旧实现只更新 `projects` 表，没有同步更新每张 Figure session 的 `editLog`。因此保存 payload 即使包含草稿，刷新时 `GET /api/projects/:id` 仍从旧 session 读回，导致修改丢失。
- 实测中还发现 3000 端口运行的是升级前启动的旧 `tsx server.ts` 进程；后端保存接口代码修复后，如果不重启服务，测试仍会命中旧逻辑并继续失败。

**修复**

- 前端保存按钮在项目模式下构建 `figures` payload：
  - 遍历 `projectFigures`。
  - 将每张图已有 `editLog` 与该图未应用的 `local_patch` 草稿合并。
  - 保存成功后把已落库的本地草稿合并回前端 `projectFigures`，并从 `projectDrafts` 清除，避免刷新前状态不一致。
- `App` 的 sessionStorage 持久化补充 `projectDrafts`，避免短暂刷新或页面恢复时丢失未应用草稿上下文。
- 后端 `PUT /api/projects/:id` 支持 `figures` 字段：
  - 根据 `figureId` 找到对应 `project_figures.session_id`。
  - 合并服务端现有 session `editLog` 与前端提交的 Figure `editLog`。
  - 使用 `compressEditLog` 保留每个 `(gid, prop)` 的最新值。
  - 调用 `saveSession` 写回 Figure session，并同步 revision。
- 修复后重启 3000 端口服务，确保运行中的后端加载最新 `server.ts`。

**验证**

- 复现测试（旧服务进程）：`npm run test:semantic-smoke`
  - `H2-save-local-draft` 失败。
  - 证据：保存 PUT payload 中 `savedLocalColor=true`，但保存后 GET 项目 `persistedLocalColor=false`。
- 重启服务后回归：`npm run test:semantic-smoke`
  - 通过。
  - `H2-save-local-draft` 证据：`savedLocalColor=true`、`persistedLocalColor=true`、`draftCleared=true`。
  - 最新报告：`output/playwright/semantic-centers-2026-07-08T01-05-58-545Z/report.md`
- `npx tsc --noEmit`：通过。
- `npm test`：通过，7 files / 59 tests。

**经验规则**

- 任何引入前端草稿、前端 SVG 预览或语义中间层的修改，都必须同步检查三段链路：
  - 预览态：前端是否能看到草稿效果。
  - 保存态：项目保存 payload 是否包含草稿。
  - 恢复态：刷新后 `GET /api/projects/:id` 是否能从 Figure session 读回同一条 `editLog`。
- 修改 `server.ts` 后必须重启当前 3000 端口服务再做网页回归；否则会出现“代码已修但浏览器仍命中旧后端”的假失败。

---

## 2026-07-08 Figure-level 共享图例无法识别

**现象**

- 用户生成 2×4 多子图后，在底部用 `fig.legend(...)` 放置四个共享图例项。
- SVG 中肉眼可见底部图例，但图层结构、字体中心、组件中心无法选中或批量编辑这些图例。
- 诊断文件 `示例_render_diagnostic_2026-07-08T01-19-36-712Z.md` 显示：
  - `coverageReport.byKind` 没有 `legend`。
  - `unsupportedArtists` 中有 `Legend count=1`。

**根因**

- Python 内省器只遍历每个 Axes 的 `ax.get_legend()`。
- `fig.legend(...)` 创建的是 Figure-level shared legend，挂在 `fig.legends`，不属于任何单个 Axes。
- 因此平台 coverage 能发现一个未支持的 `Legend` Artist，但没有把它注册为 manifest 对象，也就无法进入语义层、图层结构、字体中心或拖拽系统。

**修复**

- 在 `renderer/introspector.py` 中额外遍历 `fig.legends`。
- 为 Figure-level 图例分配稳定且不和 Axes-level 图例冲突的 gid：
  - `legend.figure.{i}`：共享图例容器。
  - `legend_title.figure.{i}`：共享图例标题。
  - `legend_text.figure.{i}.{j}`：共享图例文字。
  - `legend_line.figure.{i}.{j}` / `legend_patch.figure.{i}.{j}`：共享图例标记。
- 保留现有 `legend.{ax_idx}` 命名给 `ax.legend(...)`，避免破坏旧项目和已有测试。
- 更新 `ChartPreview` 的图例子项拖拽映射：
  - 点击 `legend_text.figure.0.0`、`legend_line.figure.0.0` 等子项时，映射回 `legend.figure.0` 容器移动。
- 更新 `LeftSidebar`：
  - Figure-level 共享图例归入画布级对象，避免错误挂到某个子图下面。

**验证**

- 新增 `tests.test_introspection.TestArtistIntrospection.test_figure_level_shared_legend_is_introspected_and_patchable`：
  - `fig.legend(...)` 生成的共享图例进入 manifest。
  - `legend.figure.0` 支持 `position`。
  - `legend_text.figure.0.*` 正确读出 `"Promoted"` / `"Suppressed"`。
  - `Legend` 不再出现在 unsupportedArtists。
  - 回放 `legend.figure.0 position` 与 `legend_text.figure.0.0 fontsize` patch 成功。
- `python -m unittest tests.test_introspection.TestArtistIntrospection.test_figure_level_shared_legend_is_introspected_and_patchable`：通过。
- `python -m unittest tests.test_introspection`：通过，23 tests。
- `npx tsc --noEmit`：通过。
- `npm test`：通过，7 files / 59 tests。
- `npm run build`：通过；仍存在既有 chunk size warning 与 `server.ts import.meta` CJS warning。

**经验规则**

- 图例识别不能只覆盖 `ax.legend()`；科研多面板图常用 `fig.legend()` 做共享图例，必须把 `fig.legends` 作为一等图元来源。
- 任何 Figure-level 对象都应使用独立 gid 命名空间，避免和 Axes index 冲突，并在图层结构中归入画布级对象。

---

## 2026-07-08 组件中心“选中整组”仍只修改首个子图边框

**现象**

- 在 2×4 或类似多子图 Figure 中，用户进入组件中心，点击“子图边框 / 坐标轴框线”的“选中整组”。
- UI 看起来进入了整组操作，但调整边框线宽/颜色后，实际只修改左上角第一个子图边框。
- 用户感知为“语义层升级后仍没有整组生效”。

**根因**

- 语义层编译器本身支持显式对象列表：多个 `spine_group.*` 可以编译为多条 `backend_patch`。
- 问题出在右侧面板的选择状态更新顺序：
  - `onSelectGids(gids)` 已经把整组 gid 写入多选状态。
  - 但同一个点击处理器随后又调用 `onSelectObject(gids[0])`。
  - `App.handleSelectObject()` 会把 `selectedGids` 重置为 `[obj]`，因此整组状态被立即覆盖成首个对象。
- 配色中心公共函数 `selectPaletteTargets()` 也存在同样模式，会让“选中整组”退化为首个目标。

**修复**

- 组件中心整组选中按钮只调用 `onSelectGids(gids)`，不再额外调用 `onSelectObject(gids[0])`。
- 配色中心 `selectPaletteTargets()` 同步修复，只保留多选 gid 状态。
- 保留单个对象点击的单选行为，不影响用户精确编辑某一个对象。
- 新增语义编译回归测试：8 个 `spine_group.*` 批量修改 `linewidth` 必须生成 8 条 patch。

**验证**

- `npx tsc --noEmit`：通过。
- `npm test`：通过，7 files / 60 tests。
- `npm run build`：通过；仍存在既有 chunk size warning 与 `server.ts import.meta` CJS warning。

**经验规则**

- 多选语义必须只通过 `onSelectGids()` 表达；不能在同一事件中再调用会重置多选的单选入口。
- 语义层只能保证“给定一组目标时”正确编译 patch，不能自动修复前端在进入语义层之前把整组目标压缩成一个目标的问题。

---

## 2026-07-11 保存项目的改图历史被 session 过期清理

**现象**

- 项目和 Figure 条目仍然存在，但重新打开后编辑历史为空。
- 用户已经保存和修改过图，刷新或隔一段时间重新进入后，需要重新调整。
- 数据库中大量 `project_figures.session_id` 已找不到对应 `sessions` 行。

**根因**

- `sessions` 同时承担了两种互相冲突的职责：
  - 临时单图渲染会话。
  - 已保存项目 Figure 的唯一 `edit_log` 存储。
- 服务启动时无条件执行 `cleanExpiredSessions(120)`，删除超过 2 小时的所有 session。
- 清理 SQL 没有排除被 `project_figures` 引用的 session。
- `project_figures` 原来只持久化 revision、preview、manifest 等信息，没有独立保存 `edit_log` 和历史快照。
- 前端 `projectHistory` 只保存在浏览器 sessionStorage；重新打开项目时还会执行 `setProjectHistory({})`。

**影响范围**

- 临时历史时间线可能永久丢失。
- 部分旧项目的最终修改仍保存在 `projects.spec.editLog`，可以恢复。
- 多 Figure 旧项目只有一份项目级 editLog 时，无法证明属于哪个 Figure，不能自动猜测套用。

**修复**

- `cleanExpiredSessions()` 只删除未被 `project_figures` 引用的临时 session。
- `project_figures` 新增：
  - `edit_log TEXT NOT NULL DEFAULT '[]'`
  - `history TEXT NOT NULL DEFAULT '{"past":[],"future":[]}'`
- patch 成功后同步 revision 时，同时把 session editLog 写入项目 Figure。
- 全项目重渲染替换 Figure 前先保留旧 history，避免 delete/insert 清空历史。
- 手动保存项目时，每张 Figure 同时保存 editLog、revision 和 projectHistory。
- 重新打开项目时：
  - 优先读取持久化 history。
  - history 缺失但 editLog 存在时，按 editLog 顺序重建可撤销时间线。
  - 单 Figure 旧项目自动从 `spec.editLog` 回填。
  - 多 Figure 归属不明确时只报告恢复候选，不自动应用。

**数据保护与恢复结果**

- 修复前创建一致性备份：
  - `data/backups/scifigure-before-history-fix-2026-07-11T10-08-56-914Z.db`
- 迁移后：
  - 91 个项目 Figure 中，32 个已有独立持久化 editLog。
  - 29 个 session 已缺失的旧单 Figure 项目从 `spec.editLog` 自动回填。
  - 4 个旧多 Figure 项目存在归属歧义，等待用户指定目标 Figure：`水库2`、`二维交互ORP`、`老金图3`、`3`。

**验证**

- `npm run test:project-history-persistence`：通过。
  - 过期但被保存项目引用的 session 保留。
  - 过期且未被项目引用的临时 session 删除。
  - 全项目 Figure 替换后 history 保持不变。
- `npm run lint`：通过。
- `npm test`：15 files / 116 tests 通过。
- `npm run build`：通过。
- 服务已使用新代码重启并监听 `http://localhost:3000`。

**经验规则**

- 临时运行缓存不能作为用户项目数据的唯一持久化来源。
- 任何清理任务必须排除被项目、导出资产或历史记录引用的数据。
- 多 Figure editLog 归属不明确时必须拒绝自动恢复，不能因为 gid 相同就套用到第一张或全部 Figure。

---

## 2026-07-11 用户登录后看不到原有项目

**现象**

- 用户使用真实账号 `2449673842@qq.com` 登录后，项目列表为空。
- 数据目录和 SQLite 数据库仍存在，项目文件没有被删除。

**根因**

- 用户隔离升级为旧数据增加 `user_id` 后，`claimLegacyOwnership()` 会把无归属项目自动分配给数据库中最早创建的账号。
- 最早创建的账号是自动化测试产生的 `Smoke User`，不是真实用户账号。
- 结果是 100 个旧项目全部归到测试账号，真实账号项目数为 0；这是数据归属错误，不是项目删除。

**修复**

- `claimLegacyOwnership()` 不再根据账号创建顺序推断旧数据所有者。
- 只有显式配置 `SCIFIGURE_LEGACY_OWNER_EMAIL`，并且当前请求者正是该账号时，才允许认领仍无 `user_id` 的旧数据。
- 将 `Smoke User` 名下 100 个旧项目迁移到 `2449673842@qq.com`，并同步迁移这些项目仍存在的 Figure session 归属。
- `capability-regression-smoke@example.test` 名下 3 个测试项目保持不动。

**数据保护与迁移结果**

- 迁移前一致性备份：
  - `data/backups/scifigure-before-owner-repair-2026-07-11T10-26-37-521Z.db`
- 迁移前：真实账号 0 个项目，Smoke User 100 个项目，总计 103 个项目。
- 迁移后：真实账号 100 个项目，Smoke User 0 个项目，能力测试账号 3 个项目，总计仍为 103 个项目。
- SQLite `integrity_check`：`ok`；`foreign_key_check`：0 条异常。

**验证**

- `npm run test:project-history-persistence`：通过，并新增以下边界检查：
  - 未配置旧数据所有者时，任何账号都不能自动认领旧项目。
  - 非配置账号不能触发认领。
  - 只有显式配置的目标账号可以认领无归属项目及其 session。
- `npm run lint`：通过。

**经验规则**

- 用户数据所有权不能通过“最早账号”“第一个登录账号”或测试账号命名规则推断。
- 旧数据迁移必须使用显式目标账号、事务、迁移前备份和迁移后数量守恒检查。
- 自动化测试账号必须使用独立数据库；不得在真实数据数据库中运行会创建账号或项目的隔离测试。

---

## 2026-07-11 自定义数据目录在 Windows 被误判为协议路径

**现象**

- 使用 `SCIFIGURE_DATA_DIR=C:\\...\\Temp\\...` 启动隔离测试服务后，项目可以创建，但渲染返回“禁止的路径格式”。
- 修正第一处后，导出又因内部仍拼接固定 `data/projects/...` 而返回“路径越界已拦截”。

**根因**

- `safeResolveUnder()` 使用通用 URI scheme 正则检查路径，错误地把 Windows 盘符 `C:` 当成 `file:`、`http:` 一类协议。
- 项目根目录已切换到自定义数据目录，但导出目录和组合项目复制仍使用固定 `data/projects/...` 相对路径，导致新旧根目录混用。

**修复**

- 增加统一 `DATA_ROOT` 和 `PROJECTS_ROOT`：默认仍为 `./data`，显式设置时数据库、项目文件和导出共同切换。
- 原生绝对路径先由 `path.isAbsolute()` 识别；仅对非原生绝对路径拦截协议格式。
- 导出目录改为当前项目根目录下的 `exports`。
- 组合项目复制目标改为当前项目 `files` 目录，不再重新拼接固定仓库路径。
- 最终路径、真实路径和符号链接边界检查保持不变。

**验证**

- 临时数据根目录中的两 Figure 项目真实渲染通过。
- SVG、PNG、PDF、TIFF 导出通过。
- 主图与两个子图同格式导出通过，导出资产库元数据正确。
- 渲染进行中导出被阻断。
- 字体/组件/配色语义中心及 local draft 保存持久化浏览器测试通过。
- 编辑器 A4 旁览真实截图通过，示例文字、字号、Word 缩放和最小字号统计可见。
- 真实 `data/scifigure.db` 项目归属和项目数量未被隔离测试修改。

**经验规则**

- 测试隔离必须覆盖数据库、项目文件、上传、导出和临时资产，不能只替换 SQLite 路径。
- Windows 盘符绝对路径与 URI scheme 必须使用平台路径 API 区分，不能只靠正则。
- 数据根目录切换必须由一个配置源派生所有子目录，禁止局部继续拼接固定 `data/projects`。

---

## 2026-07-11 项目代码修改没有可持久化的撤销记录

**现象**

- Monaco 编辑器内部可以临时撤销输入，但点击“同步至引擎并预览 SVG”后，平台历史主要记录图元 editLog。
- 用户修改代码并成功重绘后，顶部撤销无法可靠恢复上一版代码；刷新后也没有“这是一次代码修改”的记录。

**根因**

- `specHistory` 在项目模式下不是主要撤销来源，项目使用 per-Figure `projectHistory`。
- 代码同步成功只更新 `spec.custom_script`，没有在 `projectHistory` 中写入同步前脚本。
- 编辑器输入会立即更新 `spec.custom_script`，因此不能用当前 spec 作为“上次成功代码”基线。
- 历史快照只有 `editLog/script/label/timestamp`，无法区分图元编辑和代码版本。

**修复**

- 增加最后成功渲染代码基线 `committedScriptRef`；键盘输入只改变草稿，不改变提交基线。
- 仅在代码同步或项目代码重绘成功后记录历史；失败和漂移取消不记录。
- `HistorySnapshot` 增加 `changeType` 和 `codeSummary`，历史菜单显示“代码版本”和 `+N/-N 行`摘要。
- 撤销/重做同时重放 snapshot 中的脚本和 editLog，并保留代码版本元数据。
- 代码面板 Python code-patch、顶部项目同步和 R 项目同步统一使用成功后提交规则。
- Monaco 输入和文件载入不再向 `specHistory` 写入每次字符变化。
- 修复编辑器顶部工具栏和视图标签栏在窄工作区下互相覆盖的问题。

**验证**

- 成功同步新代码后历史出现“代码版本”。
- 撤销后 SVG 恢复旧标题，重做后恢复新标题。
- 保存请求和项目 GET 均保留代码快照、脚本和差异摘要。
- `npm run test:code-history-smoke`：通过。
- `npm run lint`、`npm test`、`npm run build`：通过。

**经验规则**

- 编辑器草稿和成功渲染代码必须是两个状态；不能从同一 `spec.custom_script` 推断代码是否已提交。
- 代码历史以成功渲染为事务提交点，不以键盘输入、按钮点击或请求发出为提交点。
- 图元和代码共享时间线时，快照必须同时保存脚本和 editLog，不能只恢复其中一半。

---

## 2026-07-12 03:35:38 +08:00 组合代码项目选择器 C1-C5 验收问题

**现象**

- 初版 UI smoke 使用不完整 manifest，编辑器读取 `currentProps.label` 时进入错误边界。
- 后端代码修改后，旧 `tsx server.ts` 进程仍返回缺少 `language` 等字段的旧 Figure picker 响应。
- 900 px 窗口下双栏退化为隐式 grid 行，左侧内容与右侧创建检查发生重叠，创建按钮难以到达。
- 30 Figure 虽使用 `content-visibility`，但 React `useMemo` 仍立即 sanitize 全部 SVG。
- 全 R 来源被识别为 R 项目，但提示词仍包含 `fig.add_axes`、`plt.subplots` 等 Matplotlib 指令。
- 缺失数据依赖只在前端提示，初始来源或直接 API 调用可以绕过。
- 直接 API 可以保存 `auto` 或容量不足的布局，导致项目 spec 与 panel 位置计划不一致。

**根因**

- 测试 fixture 没有遵守 StandardFigureModel 最小对象契约。
- `tsx` 开发进程不会自动重载后端文件。
- 窄窗口继续使用隐式 grid 行并保留 `min-h-0/overflow-hidden`。
- CSS 离屏渲染只减少布局绘制，不会推迟 JavaScript SVG 清洗。
- 组合提示词的语言目标和布局 helper 没有分支。
- 数据依赖和布局正确性错误地依赖前端预检，没有在创建事务入口复核。

**修复**

- UI smoke 改用完整 manifest fixture，并模拟项目恢复、资产读取和认证链路。
- Figure picker 增加语言、子图数、宽高比、图例、色条、数据文件与依赖状态。
- 窄窗口使用纵向 flex 和弹窗级滚动；宽屏继续使用双栏独立滚动。
- `SanitizedSvgPreview` 增加 64 项 LRU 和 IntersectionObserver 可见区预加载。
- Python 与 R 分别生成 Matplotlib `fig.add_axes` 和 R `ggplotGrob + grid::unit` 物理绘图区提示词。
- 创建 API 按用户所有权重新读取来源脚本和文件，缺少引用数据时返回 400。
- 后端复用共享 composition planner，将 `auto` 保存为具体布局，并拒绝容量不足的显式布局。

**验证**

- `npm run lint`：通过。
- `npm test`：18 个测试文件、127 项测试通过。
- `npm run build`：通过；保留既有 bundle 体积和 CJS `import.meta` 警告。
- `npm run test:composition-selector-ui-smoke`：通过；覆盖 30 Figure、可见区清洗、最近使用、排序、布局、风险和 900/1680 px。
- `npm run test:composition-code-project`：通过；覆盖 Python/R 组合、数据复制、动态标签、后端布局、重复来源和缺失依赖。
- 多 Figure 状态、拖拽和公开注册门禁回归通过。

**经验规则**

- `content-visibility` 不等于延迟执行 JavaScript；大 SVG 必须量化 sanitize 次数。
- 创建项目的布局、依赖和所有权必须由后端最终校验，前端检查只用于解释和提前反馈。
- 语言目标、脚手架和提示词 helper 必须作为同一协议分支测试，不能只改其中一处。
- 响应式验收不能只使用 `isVisible()`；必须确认关键操作能滚入真实视口且截图无重叠。

---

## 2026-07-12 13:44:49 +08:00 帮助中心动态图标崩溃与开发服务旧模块缓存

**现象**

- 从公开宣传页点击“帮助中心”后页面变空，React 报 `Element type is invalid`，调用栈指向 `HelpCenterPage` 内的按钮。
- 修复源代码分类文案后，浏览器截图仍显示旧分类，静态类型检查和生产构建均正常。

**根因**

- 帮助页在按钮映射中直接渲染动态图标组件；图标包经开发服务器预打包后存在导出未定义的运行时可能，TypeScript 无法发现该类浏览器模块差异。
- 3000 端口运行的是较早启动的 `tsx server.ts`，Vite 模块图未可靠消费外部并行写入后的内容模块更新。

**修复**

- 动态图标映射统一增加语义相近的稳定回退图标，单个图标导出异常不再击穿整页。
- 确认端口进程属于当前项目后重启开发服务，再执行全新浏览器上下文回归。
- Playwright 回归覆盖公开入口、登录后入口、搜索、模板切换、复制反馈、FAQ 多项同时展开和移动端横向溢出。

**验证**

- `npm run lint`：通过。
- `npm test`：18 个测试文件、130 项测试通过。
- `npm run build`：通过；保留既有 bundle 体积和 CJS `import.meta` 警告。
- `npm run test:help-center-smoke`：通过。

**经验规则**

- 由数据驱动的 React 组件映射必须为外部图标或插件组件提供回退，不允许一个装饰性组件导致整页不可用。
- 并行代理或外部工具写入前端模块后，真实浏览器验收前必须确认开发服务已加载最新模块；静态构建通过不能证明当前常驻进程没有旧缓存。

---

## 2026-07-12 13:56:33 +08:00 科研模板图片路径与内容契约不一致

**现象**

- 散点回归模板的数据记录引用 `/help-template-scatter-regression.png`，实际生成文件为 `/help-template-regression.png`。
- 帮助页本身可正常打开，但切换到该模板时示例图加载失败。

**根因**

- 初版浏览器测试只验证了热图模板，没有遍历全部模板图片。
- 模板内容数据和图片生成脚本使用了不同的文件命名，没有共享的逐条资产验收。

**修复**

- 统一散点回归模板图片路径。
- 模板库扩展到 7 套，并保持每套同时提供示例图、Python、R、CSV 和说明。
- Playwright 回归遍历全部模板，逐条检查图片完成加载且 `naturalWidth > 0`。

**验证**

- 7 张模板 PNG 均为 `1600 x 1000 px`。
- `npm run lint`：通过。
- `npm run test:help-center-smoke`：通过。

**经验规则**

- 内容驱动的静态资产不能只检查文件是否存在；必须从真实页面按内容记录逐条加载。
- 模板示例图与复制代码应表达同一视觉语义；示例图包含置信椭圆时，Python/R 模板也应包含对应绘制逻辑。

---

## 2026-07-12 14:05:43 +08:00 帮助页会话状态导致宣传页被误认为替换

**现象**

- 匿名用户进入帮助中心后刷新，仍停留在帮助页。
- 帮助页复用了宣传页视觉系统，且返回宣传页入口只绑定在品牌标识上，用户容易认为原宣传页被替换。

**根因**

- `help` 被作为普通 `ViewState` 保存到会话状态，匿名认证完成后没有恢复公开默认首页。
- 返回入口缺少明确文字，只靠品牌点击行为表达导航关系。

**修复**

- 匿名认证检查完成或失败时，公开默认视图统一恢复为 `landing`。
- 帮助页桌面顶部增加“返回官网”，移动端菜单增加同名入口；品牌标识补充可访问名称。
- 浏览器回归增加“匿名帮助页刷新后回到宣传页”和登录用户返回工作区检查。

**验证**

- `npm run lint`：通过。
- `npm run test:help-center-smoke`：通过。

**经验规则**

- 共享视觉语言不等于共享页面身份；二级公开页面必须有明确返回主站的文字入口。
- 没有 URL 路由的公开二级页面不得覆盖匿名根入口的默认恢复行为。

---

## 2026-07-12 14:24:55 +08:00 帮助内容受众越界与忽略目录热更新失效

**现象**

- 用户帮助页出现面向开发者的内省、patch、服务端和核心实现保护说明，不符合最终用户阅读对象。
- 帮助内容位于 `src/data/`，受到仓库通用 `data/` 忽略规则影响；新增导出后开发服务器继续使用旧模块，导致页面入口无法加载。

**根因**

- 产品帮助、开发架构和知识产权保护没有按受众拆分。
- 将前端内容模块放入了与用户数据目录同名且被忽略的路径。

**修复**

- 用户帮助页只保留操作流程、模板、公开提示词和用户问答。
- 核心实现与知识产权保护迁移到内部开发文档。
- 帮助内容模块从 `src/data/helpContent.ts` 迁移到 `src/content/helpContent.ts`，恢复可靠文件监听。

**经验规则**

- 写任何文案前必须先标明受众：最终用户、管理员、开发者或安全运维；不同受众内容不得混写。
- `src/data`、`tmp`、`output` 等可能被忽略的路径不得承载前端源码模块。

---

## 2026-07-12 14:57:42 +08:00 历史导出资产看似丢失

**现象**

- 用户进入“历史导出资产”后看不到过去保存的图片，认为导出记录被清空。

**证据与根因**

- 数据库仍有 81 条 `export_assets` 记录，全部关联到账号 `2449673842@qq.com` 拥有的项目。
- 原页面只请求当前 `projectId` 的资产；最近项目没有导出记录时，页面显示“当前项目没有资产”，造成全部历史丢失的错觉。
- 磁盘检查发现 78 个原文件存在，`10聚类` 的 2 个 PNG 和 1 个组合 SVG 缺失，但数据库仍保留完整 SVG 缩略内容。

**修复与恢复**

- 使用 `scripts/recover_missing_export_assets.mjs` 在不修改数据库记录的前提下重建 3 个缺失文件。
- 恢复报告和 SHA-256 写入 `data/backups/export-assets-recovery-*.json`。
- 新增账号级 `/api/export-assets` 查询、跨项目 ZIP 和跨项目删除接口，所有数据继续按认证用户项目所有权限定。
- 资产库默认汇总账号全部项目，显示来源项目并支持项目筛选。
- 单项删除不再依赖异步 selection state，直接按明确资产 ID 执行。

**验证**

- 数据库记录：81 条；磁盘文件存在：81 个。
- `npm run lint`：通过。
- `npm run test:export-library-global-smoke`：通过。

**经验规则**

- 名为“历史资产库”的入口默认作用域必须与用户理解一致；项目级视图必须明确标注，不能把空项目解释为账号无历史。
- 导出记录与物理文件需要定期一致性检查，缩略内容可作为最后恢复来源，但不能替代原始文件备份。

---

## 2026-07-12 15:25:57 +08:00 升级测试污染正式数据与持久化状态检查不完整

**现象**

- 升级后多次出现项目、上传文件、Figure 历史或导出资产“突然没有了”的现象。
- 数据库记录有时仍在，但页面只查询当前项目；另一些记录存在，但物理文件或 Figure session 已缺失。

**根因**

- 旧烟雾测试默认连接 `localhost:3000`，在正式开发服务运行时会把测试账号、测试项目和删除清理请求写入真实 `data/`。
- 升级回归只关注当前页面和 SVG，没有统一检查 `projects`、`project_files`、`project_figures`、`sessions`、`export_assets` 与物理文件的一致性。
- 旧 session 清理逻辑曾删除已保存 Figure 引用的 session；页面读取有 `project_figures` 回退，因此问题未立即暴露，但继续 patch、组合和导出链路存在降级风险。
- 账号级历史与项目级历史的 UI/API 作用域没有统一标注，空项目造成“全部历史丢失”的错觉。

**修复与恢复**

- 新增 `scripts/testing/run_with_isolated_server.mjs`，会写数据的 npm 烟雾测试统一使用临时数据根目录、临时数据库和随机端口。
- 新增 `scripts/audit_data_integrity.mjs`，检查所有权、计数、物理文件、Figure JSON、session 引用和历史测试账号。
- 新增 `scripts/recover_missing_project_files.mjs`：23 个缺失文件均通过同名、列结构、行数和候选 SHA-256 校验后非覆盖恢复。
- 新增 `scripts/recover_missing_figure_sessions.mjs`：先创建 SQLite 在线备份，再从 `project_figures + projects` 事务重建 78 个 session。
- 发现 23 个历史测试账号，其中一个账号持有 12 个测试项目；按用户数据红线仅记录警告，未删除账号或项目。

**恢复证据**

- `data/backups/project-files-recovery-2026-07-12T07-16-41-202Z.json`
- `data/backups/pre-session-recovery-2026-07-12T07-21-58-748Z.db`
- `data/backups/figure-session-recovery-2026-07-12T07-21-58-748Z.json`
- 恢复后 `npm run data:audit`：`issueCount=0`，保留 23 条历史测试账号警告。

**验证**

- `npm run test:data-integrity-tools`：通过，dry-run 不写文件、apply 哈希一致、session 重建后审计归零。
- `npm run test:cache-smoke`：通过；正式数据库大小、修改时间和项目文件数量测试前后不变。
- `npm run test:export-matrix-smoke`：12/12 通过，控制台和页面错误均为 0。
- `npm run test:export-library-global-smoke`、`npm run test:public-auth-smoke`：通过且运行于隔离服务。
- `npm run lint`：通过。
- `npm test`：18 个测试文件、130 项测试通过。
- `npm run build`：通过；保留既有 bundle 体积和 CJS `import.meta` 警告。

**经验规则**

- 页面显示为空时先区分“账号级/项目级查询”“数据库记录”“物理文件”“运行 session”，不能直接判断数据丢失。
- 测试数据隔离必须同时隔离数据库和项目文件根目录，仅换账号或仅换数据库都不够。
- 升级前后必须执行数据完整性审计；恢复默认 dry-run，apply 必须非覆盖、可追溯、有哈希和数据库备份。

---

## 2026-07-12 22:06:47 +08:00 Python 数据驱动颜色整组修改无效并导致后续 palette 失去目标

**现象**

- 配色中心首次可以选中一组图元，修改颜色并应用后画面没有变化。
- 重渲染后该 palette 变成 0 个目标，界面提示“当前 Figure 没有使用这个脚本颜色”，无法再次选中整组。

**真实项目证据**

- 只读检查最新项目 `1排序图`：Figure revision 为 71，项目和 session 在问题发生时继续更新，但成功预览时间停留在更早时刻。
- manifest 中 `BLUE`、`RED` 和 `ZERO` 原本均有 binding；脚本虽然定义 `BLUE/RED`，实际循环绘图使用 `row["Color"]`。
- 修改 `BLUE` 常量不会改变已经存在的数据列颜色，因此旧的纯 `code_patch` 不能改变实际 artist；常量颜色与 artist 颜色分离后，下一次 binding 得到 0 个 GID。

**为什么旧版正常、后来退化**

- 旧路径更偏向直接修改已识别图元，所以数据列控制颜色时仍能立即生效。
- 后续为了让颜色修改写回 Python 常量并在刷新后可复现，整组改色改成只提交 `code_patch`。
- 该升级错误地假设“扫描到的脚本颜色常量一定是当前 artist 的真实控制源”，遗漏了数据列、计算结果和动态映射控制颜色的脚本。
- 这不是文本、边框、拖拽或整体图元识别失效，而是 palette 整组写回策略缺少对象级 fallback。

**修复**

- Python 单组改色和配色预设统一生成一个批次：`code_patch + binding 精确对象 patch`。
- 与 `code_patch` 同批的对象颜色强制使用 `backend_patch`，确保 renderer 在 introspection 和 binding 重建前 replay 颜色；仅修改已选图元仍保持 local patch。
- 代码常量、字典和内联颜色替换迁移到可测试的 `applyColorCodePatch()`；目标不存在时明确报错，不再静默返回成功。
- 字典替换支持带下划线名称和类型注解，并限制在目标字典作用域内。
- R 语言继续使用对象 patch，不引入不受支持的 R code patch。

**验证**

- 新增数据驱动 fixture：`DYNAMIC_COLOR` 与实际绘图颜色初值相同，但 artist 不读取该常量。
- 浏览器回归确认应用请求包含 1 个 code patch 和全部目标对象 backend patch。
- 重渲染后 palette 颜色、对象颜色和 binding GID 均保持为新颜色，可继续选中整组。
- `npm run test:semantic-smoke`：10 PASS / 0 FAIL，console/page error 为 0。
- 全量 Vitest：41 files / 285 tests 通过。
- TypeScript 和生产构建通过；仅保留既有 bundle 体积和 CJS `import.meta` 警告。
- 独立代码审查发现并修复 project code-patch 顶层 `editLog/revision/script` 缺口；复审 PASS，无剩余 blocking finding。

**防复发规则**

- palette 常量只能作为代码持久化目标，不能被假设为 artist 的唯一真实颜色来源。
- 任何触发后端重渲染的 code patch 若依赖对象 fallback，对象 patch 必须参加同一次 backend replay；不能只在前端局部预览。
- 配色回归必须同时检查视觉颜色、manifest currentProps、binding GID 和刷新后的可再次选择能力。

---

## 2026-07-12 22:50:07 +08:00 向量散点配色无法区分组并可能整体染色

**现象**

- 项目 `3方差线2` 的配色中心提示没有绑定，无法可靠选中 `PROMOTION` 与 `INHIBITION`。
- 两组颜色位于同一个 Matplotlib scatter collection；选中其中一组时另一组也显示被选中，旧对象 patch 可能把整个 collection 临时染成同色。

**真实项目证据**

- 只读检查项目 `3d90a529-ab92-4b2a-9f03-40d787cfd052`，Figure revision 105，未写入真实数据库。
- 脚本同时定义 `PRIMARY_COLOR/PROMOTION=#1F78B4` 与 `SECONDARY_COLOR/INHIBITION=#D62728`；前两项未使用，实际 `df["Color"]` 由 `PROMOTION/INHIBITION` 生成。
- `collection.0.1.facecolor` 包含 33 个蓝色和 9 个红色点，两个语义组共享同一个物理 GID，不能用普通对象级 `facecolor` patch 区分。
- `3000` 未开启严格 palette resolver；legacy fallback 曾把 renderer 已声明的 `ambiguous` 状态降级成“当前图未使用”。

**责任判断**

- 转义脚本存在重复且未使用的同色常量，增加了歧义，但不是用户无法编辑的充分理由。
- 主要问题属于平台：binding 协议未区分 collection 整体颜色与逐点向量颜色，legacy resolver 又丢失歧义信息。

**修复**

- semantic scanner 为脚本常量记录 `usageCount`；未使用的重复常量仍可显示，但不再参与 rendered-color owner 竞争。
- binding target 新增 `replayMode`；多色数组命中标记为 `code_only`，只修改精确 Python 常量并重绘，不生成会覆盖整个 collection 的对象 patch。
- legacy resolver 保留 `ambiguous/unresolved`，即使严格 resolver flag 关闭，也不再错误显示为未使用。
- 配色中心不再把共享 vector collection 当作可选颜色组；两个代码颜色组不会因共用 GID 同时进入选中态。
- AI 转义提示词新增规则：每个语义组只保留一个权威颜色常量，逐点颜色列必须由这些常量生成，禁止同色未使用别名。

**验证**

- 使用真实项目脚本和已保存 manifest 进行 SQLite `mode=ro` 验证：`PRIMARY_COLOR/SECONDARY_COLOR usageCount=0`；`PROMOTION/INHIBITION` 分别生成 `code_only` binding。
- Python introspection：38 项通过。
- 全量 Vitest：42 files / 290 tests 通过。
- `npm run test:semantic-smoke`：11 PASS / 0 FAIL，其中向量颜色用例确认只提交一条目标常量 `code_patch`，另一组颜色和点数保持不变。
- TypeScript、生产构建与 `git diff --check` 通过；仅保留既有 bundle 体积和 CJS `import.meta` 警告。

**防复发规则**

- 同一个 artist 属性包含多个离散颜色时，不得生成普通对象级颜色 fallback。
- “相同 GID”不等于“相同语义颜色组”；向量颜色必须保留变量、scale key 或元素掩码级身份。
- legacy compatibility path 不得抹掉 renderer 已明确声明的歧义或不支持状态。

---

## 2026-07-12 23:20:50 +08:00 编辑器横向画布导出后恢复为脚本竖向尺寸

**现象**

- 编辑器中 Figure 显示为横向，导出 PNG 后变成竖向，导出内容与最后一次成功预览不一致。

**真实项目证据**

- 只读检查项目 `3方差线2` revision 118：当前 preview manifest 为 `9 × 7.5 in`，SVG 为 `648 × 540 pt`，明确是横向。
- 同 revision 最新导出缩略 SVG 为 `590.4 × 633.6 pt`，对应脚本原始 `8.2 × 8.8 in`，明确是竖向。
- session 保留 28 项图元编辑，但 `gid=global` 的画布宽高编辑已丢失；脚本仍为 `figsize=(8.2, 8.8)`。

**根因**

- `/api/figure/code-patch` 漂移检测只把 `manifest.objects[].id` 视为有效 GID。
- `global` 是 renderer 支持的可重放虚拟目标，不属于普通 objects；旧逻辑将它误判为 orphan，并在 force code sync 时从 session editLog 删除。
- preview SVG 在删除前已经按横向 global patch 生成并保存，因此编辑器继续显示横向；导出接口重新执行 session script + session editLog，缺少 global patch 后恢复为脚本竖向尺寸。

**修复**

- 漂移检测保留 `global`、`font-center-xticks` 和 `font-center-yticks` 等可重放虚拟目标，不再把它们当作孤儿清理。
- 单 Figure 导出和项目 Figure 导出都从最后一次成功 preview manifest 合并 `figure.width_in`、`figure.height_in` 和 `figure.dpi`，兼容已经丢失 global editLog 的历史项目。
- 导出 bundle 和导出历史锚点使用同一份有效导出 editLog，避免文件内容与元数据再次分叉。

**验证**

- 新增 preview global 恢复单元测试：2 项通过。
- `npm run test:export-matrix-smoke` 全部通过：`8 × 4 in` 横向预览经过代码同步后导出 viewBox 为 `576 × 288`；SVG/PNG/PDF/TIFF、全部 Figure、子图同格式和导出中阻止均通过。
- TypeScript 与 `git diff --check` 通过。

**防复发规则**

- drift/orphan 检查必须同时认识真实 artist GID 和 renderer 声明的虚拟可重放 GID。
- 导出必须以最后一次成功预览状态为基准，不得只相信可能被兼容流程清理过的 session editLog。
- 导出回归必须比较 preview 与 export 的 viewBox、物理宽高和方向，revision 相同不代表内容天然一致。

---

## 2026-07-14 11:35:28 +08:00 新建项目首屏脚本上传区文案支持拖入但未绑定 drop 事件

**现象**

- “1. 先读取绘图脚本”明确提示支持拖入 `.py/.R`，但把文件拖到该区域没有反应。
- 页面下方脚本编辑框和进入工作区后的代码编辑器支持拖放，导致同一流程的交互不一致。

**根因**

- 首屏区域只有隐藏文件输入框和点击上传标签，没有 `dragenter/dragover/dragleave/drop` 事件。
- 既有网页测试只调用文件输入框 `setInputFiles()`，没有构造真实 `DataTransfer` 和 `File`，因此未覆盖文案承诺的拖放路径。

**修复**

- 首屏整个脚本区域成为明确 drop zone，拖入时显示边框和“松开以上传”状态。
- drop 继续复用 `readScriptFile()`，只接受 `.py/.R`，保留原语言识别、脚本内容和数据文件依赖提取逻辑。
- 使用拖入深度计数处理子元素间的 `dragenter/dragleave`，减少状态闪烁。

**验证**

- 新增 `project_create_script_drop_smoke.mjs`，真实构造浏览器 `DataTransfer + File` 并触发 `dragenter/dragover/drop`。
- R fixture 成功写入编辑器、识别为 `R / ggplot2`，并将 `stats.csv` 标记为待上传。
- `scriptDataDependencies` 单测补充直接 `read.csv("stats.csv")` 覆盖。
- 公网 `http://117.72.208.91` 使用同一 `DataTransfer/drop` 脚本复测通过，线上 build 为 `eea68fb-jd7`。

**防复发规则**

- 上传区文案只要出现“拖入/拖拽”，对应区域必须有真实 drop 回归，不能用点击文件输入框代替。
- 文件上传测试至少分别覆盖 file input 和 `DataTransfer/drop` 两条浏览器事件链。
---

## 2026-07-14 11:04:33 +08:00 管理员错误记录缺少 AI 修复交接格式，订阅权限只能查看不能受控修改

**现象**

- 错误中心可以查看脱敏摘要，但 AI 工具需要人工重新整理事件字段，容易漏掉组件、操作、错误码和验证边界。
- 用户页只能展示订阅状态，管理员无法在不直接操作数据库的情况下安全调整套餐、状态和到期时间。

**修复**

- 新增稳定的 `scifigure.error-handoff.v1` JSON schema，并提供 Markdown/JSON 下载与一键复制。
- AI 交接包只包含脱敏事件、组件/操作、项目/Figure 标识、允许元数据、建议代码区域和验证清单。
- 新增订阅权限页面，只允许调整 `free/pro`、`active/paused/expired` 和到期时间。
- 写操作要求管理员密码二次验证、短时一次性令牌、至少 3 字符原因和唯一 `requestId`。
- 令牌只保存 SHA-256 哈希；重复 `requestId` 返回原结果，不重复创建订阅记录。
- 订阅变更保留历史记录，并审计成功、失败和重放；不修改用户项目、Figure、文件、导出资产或会话。

**验证**

- 管理后台专项 smoke 通过：匿名/普通用户拒绝、AI 包脱敏、错误密码拒绝、令牌过期和一次性、幂等重放、订阅授权和资源聚合不变。
- `npm run test:admin-authorization`、`npm run lint`、`npm run build` 通过。
- 真实浏览器检查桌面订阅对话框和 390px 移动端错误详情；未发现遮挡或表单溢出。
- `eea68fb-jd7` 部署后 `/api/admin/overview` 未登录返回 401 而非功能关闭的 404，确认管理员开关生效；数据库完整性和用户资源计数保持不变。

**防复发规则**

- 错误中心给 AI 的内容必须使用固定脱敏 schema，禁止把用户脚本、数据、traceback、图像、账号身份、令牌或绝对路径加入交接包。
- 管理员写操作不得仅依赖登录态；必须同时具备实时 admin 校验、recent re-auth、reason、幂等和审计。
- 订阅调整测试必须比较操作前后的项目、Figure、文件、导出和会话聚合，确保权限变更不触碰用户内容。

---

## 2026-07-14 17:30:24 +08:00 生产统一编辑中心字体目标错配、strict 只读与重复 patch

**现象**

- 用户在生产网页选择 X/Y 轴后，字体、字重等多项显示只读，只剩部分刻度方向控制可用。
- 同一张图在本地 3000 legacy 控件可修改，在生产 `eea68fb-jd7` V2 控件中部分操作不生成 patch。
- 生产跨 Figure 修改“X 轴刻度文字”字号时，实际请求生成 `title.* / fontsize`，而不是 `axis.x.* / tick_labelsize`。
- 组件中心连续应用时，第二次及后续请求会重复包含之前已经应用的 patch。

**定位**

- 生产默认启用 `PropertyDescriptor + propertyCapabilities` strict resolver；本地 3000 仍允许 legacy `editable` fallback。
- `propertyDescriptors.ts` 在缺少属性级 capability 或作用域不匹配时会正确转为只读，但 font/component projection 存在目标属性映射不完整。
- 连续组件请求的 patch 数从 1 条递增到 2、3、4 条，说明 apply 成功后的 draft 清理或状态回写未正确收敛。

**验证**

- 生产 Python semantic smoke：14/14 PASS，说明图元协议和配色主链路没有整体失效。
- 生产 axis style smoke：3/5 PASS；边框组、网格线未形成 patch。本地 3000：5/5 PASS。
- 生产 cross-Figure smoke：单图边框 fanout 到 4 个子图通过；字体跨图目标错配失败。
- 生产 component container smoke：关系和控件可见性通过，但连续请求出现累计 patch。本地 3000 每次只发送当前 patch。

**状态**

- 生产仍可使用基础字体和图元编辑，但不能视为全部 V2 控件正常。
- 尚未修复生产代码。后续必须在 strict resolver 内补齐精确 target/prop，禁止用全局 legacy fallback 回退。

**详细报告**

- `docs/current/03_PRODUCTION_REGRESSION_AND_LOCAL_COMPARISON_2026-07-14.md`

---

## 2026-07-14 17:31:12 +08:00 生产 XLSX 隔离解析因 UMask 0077 无法读取 staged workbook

**现象**

```text
上传 FL9_classification_SHAP_results.xlsx 失败:
Workbook parsing failed: [Errno 13] Permission denied: '/work/input.xlsx'
```

**根因**

- 生产 systemd 使用 `UMask=0077`，`parseWorkbookIsolated()` 直接创建的临时目录为 `0700`、复制文件为 `0600`。
- 表格解析容器使用 UID/GID `65532:65532`，只读 bind mount 成功，但容器进程没有权限读取 `/work/input.xlsx`。
- `20c7c38` 已修复绘图 renderer 的同类 staging 权限，tabular parser 路径未复用该模型。

**本地修复**

- 使用随机 `0700` 私有外层目录保护宿主机临时任务。
- 在其下创建容器 bind mount 的 `0755` 工作目录，并把 staged workbook 设置为 `0444`。
- 仍保持只读挂载、禁网、低权限 UID 和原有资源限制，不放宽 systemd 全局 UMask。

**验证**

- `SCIFIGURE_SANDBOX_WORKBOOK_ONLY=1 node tests/api/renderer_sandbox_smoke.mjs`：PASS。
- 在 `UMask=0077` 下，UID `65532` 容器成功解析 `sandbox-results.xlsx`，返回 `sample/value` 两列、2 行。
- `npm.cmd run build`：PASS。

**状态**

- 本地升级分支已修复并验证。
- 生产 `eea68fb-jd7` 尚未部署该修复，线上同类 XLSX 上传仍会失败。

**防复发规则**

- 所有宿主机到低权限容器的 staged input 必须在 `UMask=0077` 下做真实容器读取测试。
- renderer、tabular parser、导出转换等隔离任务必须共享同一 staging 权限模型，不能只修主 renderer。

---

## 2026-07-14 18:26:45 +08:00 X/Y 轴标题拖拽后吸附框线、无法拖动或应用无反应

**现象**

- `xlabel.0` / `ylabel.0` 在拖拽预览时可以移动，但确认并重渲染后回到轴框附近，或者完全没有变化。
- 同一问题同时存在于本机 3000 和生产统一编辑版。

**根因**

- Matplotlib axis label 使用“轴向坐标 + display offset”的混合 transform，`artist.axes` 为空，不是普通 `ax.transAxes` 文本。
- renderer 把 axis label 的原始 `(0.5, displayY)` / `(displayX, 0.5)` 错报为 axes fraction。
- 普通 text position replay 依赖 `artist.axes`，因此返回 `unsupported_text_position_coord`；预览 transform 随后被重渲染覆盖。
- 现有拖拽 smoke 只覆盖普通 text 和 annotation，没有覆盖 `xlabel/ylabel`，所以长期未被自动化发现。

**修复**

- 内省时把 axis label 的真实 display anchor 反算为对应 axes fraction，保留原始 labelpad 外侧位置。
- replay 时使用 `XAxis/YAxis.set_label_coords(..., transform=ax.transAxes)`，不再走普通 Text transform 分支。
- 对历史遗留的像素型错误 axes 坐标进行保护性拒绝，避免升级后把标签甩出画布；新拖拽会覆盖旧 position patch。
- 拖拽 smoke 新增 X/Y 标题连续拖动、单次确认、不同 gid、方向正确和 renderer response 坐标一致断言。
- smoke 清理改为按 fixture projectId 删除，避免自动保存改名后残留测试项目。

**验证**

- 本机运行中的 3000：真实 Playwright 10/10 PASS，`xlabel.0=(0.649308,-0.304202)`、`ylabel.0=(-0.201334,0.630881)`，renderer 返回与请求一致。
- 隔离统一编辑版：真实 Playwright 10/10 PASS。
- Python introspection：40/40 PASS。
- production build：PASS。

**状态**

- 本机 3000 已读取修复后的 renderer，真实浏览器验证通过。
- 2026-07-14 22:21:29 +08:00：已随生产 build `6f6fcb7-jd8` 发布；公网 X/Y 标题连续拖动、真实对象跟随和 renderer 坐标一致性验证通过。

**防复发规则**

- axis label、tick label、legend child 和普通 text 必须分别声明 position 语义，禁止按 `kind=text` 一概复用。
- 拖拽回归必须同时断言“能开始拖动、请求 patch、renderer response、最终 manifest/SVG”，不能只检查确认条出现。

---

## 2026-07-14 21:34:21 +08:00 拖拽预览只移动选框，真实 SVG 对象不跟随

**现象**

- 开启拖拽微调后，选区边框会跟随鼠标移动，但文字对象仍停留在原位置。
- 松开鼠标后确认条和 position patch 均正常，因此旧测试会误判为拖拽功能正常。

**根因**

- `ChartPreview` 通过 DOM `transform` 实时移动 SVG 图元，同时用 React state 更新选框。
- `dangerouslySetInnerHTML` 每次渲染都收到新的包装对象，React 状态更新后重新写入相同 SVG 内容，清除了刚设置的临时 `transform`。
- 选框由 React 状态单独绘制，不受 SVG 内容重写影响，因此形成“只移动框”的视觉错觉。

**修复**

- 将 sanitized SVG 的 `dangerouslySetInnerHTML` 参数按 SVG 内容进行 memoize；拖动状态更新不再重建 SVG DOM。
- 保留现有真实 SVG 节点变换、取消恢复、批量确认和后端重绘流程，不引入复制文本或伪预览层。
- 拖拽 smoke 新增普通文本与 X/Y 轴标题的真实 DOM 中心点和 `transform` 断言。

**验证**

- 本机 3000 真实 Playwright：11/11 PASS。
- 普通文本拖动 `70 x 25 px` 时，真实对象在拖动中及松手后均移动到对应位置。
- `xlabel.0`、`ylabel.0` 连续拖动：真实对象跟随、单次确认、renderer 返回坐标一致。
- 主线与统一编辑工作树 production build：PASS。

**状态**

- 本机 3000 已通过热更新生效。
- 2026-07-14 22:21:29 +08:00：统一编辑 build `6f6fcb7-jd8` 已部署；公网真实 Playwright 全部通过。
- 发布后 `/api/health/ready` 为 ready，数据库 `integrity_check=ok`，用户/项目计数为 5/7，测试项目清理后计数未变化。

**防复发规则**

- 所有拖拽 smoke 必须至少采样 `pointerdown` 前、`pointermove` 中、`pointerup` 后三个真实图元位置。
- “选框移动、确认条出现、patch 请求成功”不能作为对象实时跟随的替代证据。

---

## 2026-07-14 22:44:11 +08:00 统一编辑版文字内容面板与 3000 使用顺序不一致

**现象**

- `3000` 中选中文字后，首先看到多行文字内容编辑器及上标、下标、换行、暂存和立即应用。
- 统一编辑版把 V2 字体、字号和颜色控件排在前面，文字内容编辑器被移到后方，用户操作习惯被打断。

**原因**

- 属性中心接入 V2 descriptor projection 后，协议控件和 legacy 专用文字编辑器被拆成两段渲染。
- 专用文字编辑器没有丢失，但默认排在所有 descriptor 控件之后。

**修复**

- 文本对象仍使用原有完整文字编辑器，并将其恢复到对象属性面板首位。
- V2 字体、字号、颜色、旋转和对齐能力继续保留在文字编辑器之后。
- 不回退目标解析、property capability、Draft Batch、拖拽或 renderer 写回链路。

**验证**

- 隔离统一编辑候选：Property Inspector Playwright 全部通过。
- 文字编辑器唯一可见、位于 V2 控件之前，上标/下标/换行按钮均可见。
- V2 字号精确 patch、字体中心混合值和刻度旋转继续通过。
- production build、PropertyControl 单测 5/5、`git diff --check` 通过。

**生产状态**

- 2026-07-14 23:04:50 +08:00：已随 build `c0128df-jd9` 发布。
- 公网真实浏览器确认文字编辑器唯一可见、位于 V2 控件之前，上标/下标/换行完整，字号精确 patch 正常。
- 同一回归中的后续刻度旋转请求仍携带上一条已应用字号 patch；这是既有 Draft 清理差异，已独立保留为后续修复项，不影响本次文字面板排序结论。

**防复发规则**

- 协议控件升级不得改变高频专用编辑器的首要操作位置。
- 文字内容、公式、换行等内容编辑能力必须作为一个完整控件保留，不能拆散成通用字符串输入。

---

## 2026-07-14 23:26:46 +08:00 子图标题拖动后被自动布局贴回框线

**现象**

- `title.0` 拖动时选框和标题本体可以跟随，但确认重绘后标题回到坐标轴框上方。
- X/Y 轴标题和普通文本已修复，子图标题仍会复现。

**根因**

- Matplotlib `Axes._update_title_position()` 会在每次 draw 时把自动标题 Y 坐标重置为 `1.0`，再按装饰元素自动调整。
- 普通 `Text.set_position()` 已执行成功，但随后被标题自动布局覆盖。
- 既有拖拽回归没有单独覆盖 `title.*`。

**修复**

- 为 `title.0`、`title.left.0`、`title.right.0` 建立专用 axes 标题上下文。
- 内省时将带 titlepad 的真实显示锚点反算为 axes fraction。
- 确认位置后关闭该 Axes 的自动标题定位，并按 `ax.transAxes` 重放目标坐标。

**验证**

- Python introspection：41/41 PASS，覆盖中心、左、右三类标题。
- 本地 3000 真实拖拽回归全部通过；`title.0` 预览跟随、单次确认和 renderer 返回坐标一致。
- production build：PASS。

**防复发规则**

- Matplotlib 自动布局管理对象必须按专用语义回放，不能仅按 `kind=text` 调用通用 setter。
- 拖拽回归必须分别覆盖普通文本、轴标题、子图标题、annotation 和图例容器。

---

## 2026-07-15 00:04:33 +08:00 属性编辑 DPI 与导出 DPI 分裂，TIFF 元数据错误

**现象**

- 在“属性编辑 → 整张白色画布 / 输出尺寸”修改 `figure.dpi` 后，进入导出页仍可能显示旧 DPI。
- SVG/PDF 选择不同 DPI 后画面不变，界面没有解释矢量格式与 DPI 的关系。
- 主图 TIFF 即使选择 600 DPI，文件元数据显示为 1 DPI。

**根因**

- `figure.dpi` 只写入 Figure edit log，没有同步项目 `spec.figure.dpi` 和 `spec.export.dpi`。
- 导出页维护独立 DPI 状态，形成两个事实来源。
- TIFF 主图经 PNG 中转后调用 Pillow 保存时没有传入 `dpi=(dpi, dpi)`。
- 导出资产对 SVG/PDF 等矢量格式也记录数值 DPI，进一步造成误导。

**修复**

- `figure.dpi` 成功应用后同步到预览配置和导出配置；刷新及进入导出页使用同一数值。
- 属性编辑 DPI 上限与导出页统一为 1200。
- TIFF 保存写入正确 X/Y DPI 元数据。
- 导出页仅对 PNG/TIFF启用 DPI 选择；SVG/PDF/EPS 明确显示为矢量输出。
- 导出资产只对 PNG/TIFF记录 DPI，矢量资产记录为 `null` 并显示“矢量”。

**验证**

- PNG 端到端像素：150 DPI=`1061x536`，300 DPI=`2123x1072`，600 DPI=`4248x2149`。
- TIFF 600 DPI 元数据测试通过。
- 导出矩阵 SVG/PNG/PDF/TIFF、全部 Figure、子图同格式导出和资产记录全部通过。
- DPI 状态同步 Vitest 3/3、production build 通过。

**说明**

- SVG/PDF/EPS 的文字与线条是矢量对象，整体清晰度不由 DPI 决定；DPI 主要作用于 PNG/TIFF及矢量文件中的栅格化对象。

**生产状态**

- 2026-07-15 00:42:05 +08:00：已随 build `8f956ca-jd10` 发布到公网调试服务器。
- 发布后 readiness=`ready`、单实例 active、SQLite `integrity_check=ok`，用户/项目计数保持 `5/7`。
- 公网真实浏览器窄测试通过：属性页 600 DPI 同步到 Figure/导出配置，矢量格式禁用 DPI 控件，PNG 保留 600 DPI 且控件可用，console error=0。
- 公网完整导出矩阵已通过 SVG/PNG/PDF/TIFF、150/300/600 DPI 像素倍率和子图导出；后续因 10 秒 TCP 连接超时中断，未将该次完整矩阵记为全部通过。测试项目已清理。

**防复发规则**

- 属性页和导出页不得各自维护独立 DPI 事实来源。
- 栅格格式必须同时验证像素尺寸和文件 DPI 元数据；矢量格式不得记录误导性数值 DPI。

---

## 2026-07-15 10:30:21 +08:00 网页端字体、文本工具栏、Draft 与轴字体控件回归

**现象**

- 网页端选择 Times New Roman 后曾回退为 DejaVu Sans。
- 换行、上下标和“立即应用”没有稳定进入 Draft 或触发后端重绘。
- 切换属性、字体、组件和配色中心时，未应用 Draft 可能消失。
- 组件中心的 X/Y 轴字体、字号、颜色和字重被错误显示为只读。

**根因**

- renderer 没有稳定区分用户请求字体和 Linux 实际解析字体，镜像也缺少 Times 兼容字体及显式别名。
- 文字内容仍可能沿用 `local_patch`，但换行和 mathtext 必须由 renderer 重排。
- 静默自动保存和立即应用完成后的 Draft 清理缺少事务边界，可能消费新输入或跨中心丢失状态。
- 严格 component capability 只投影 group scope，旧 manifest 的 axis typography 实际只声明在 object scope。

**修复**

- 请求字体保留为 `Times New Roman`，renderer 使用 `Liberation Serif` 作为 Linux 运行时字体；Docker renderer 安装 `fonts-liberation` 并配置 fontconfig 别名。
- 文字内容统一强制为 `backend_patch`；换行、上下标点击后立即写入 Draft，“立即应用”完成后只清理值完全匹配的 Draft。
- 任何待处理 Draft 存在时，静默自动保存不再消费 Draft；Draft 在四个编辑中心间保持。
- 仅为 axes 增加安全的 object-scope typography 兼容，并精确展开为 `axis.x.*`、`axis.y.*` patch，不放宽其他组件能力。

**验证**

- 本地候选：Vitest 38/38、Python introspection 45/45、semantic centers 14/14、axis semantics 5/5、production build 全部通过。
- 公网真实浏览器 `public_editing_regressions_smoke`：6/6 PASS。
- Times patch 为 `backend_patch`，manifest 请求值为 `Times New Roman`，解析值为 `Liberation Serif`，目标 `title.0` SVG 也使用 `Liberation Serif`。
- 换行、上下标、立即应用、Draft 5 秒存活、跨中心保持、X/Y 轴字重双轴精确 patch 全部通过。
- Console error=0，Page error=0。

**生产状态**

- 2026-07-15 10:06:08 +08:00：已发布 build `65d3b9e-jd12`；候选构建改用清华 Debian、Debian Security 和 PyPI 镜像。
- 发布后 readiness=`ready`、单实例 active、SQLite `integrity_check=ok`，用户/项目计数保持 `5/7`。
- renderer 内 `fc-match 'Times New Roman'` 返回 `Liberation Serif`。
- 本地 `3000` 根目录和本机 Docker 均未在本轮修改或停止。

**测试修正**

- 首次公网 smoke 将整张 SVG 中其他未修改文本的 DejaVu Sans 误认为目标字体回退，产生 5/6 的假失败。
- 断言现按被编辑 gid 提取目标 SVG group，只检查目标对象的字体声明，并保存目标响应 SVG 作为证据；修正后公网 6/6 PASS。

**原版 Times New Roman 后续修正（2026-07-15 11:27:34 +08:00）**

- 用户明确要求实际使用微软 Times New Roman，不接受界面显示 Times New Roman、renderer 实际使用 Liberation Serif 的兼容方案。
- Docker renderer 启用 Debian `contrib`，通过 `ttf-mscorefonts-installer 3.8.1` 接受 Core Fonts 许可并安装 `Times.TTF`、粗体、斜体和粗斜体文件。
- Matplotlib 字体解析优先查找真实 `Times New Roman`；SVG 字体链将 Times New Roman 放在第一位，兼容字体只作为不可用环境的后续 fallback。
- 删除曾把 `Times New Roman` 反向覆盖为 Liberation Serif 的旧 fontconfig alias，只保留 `Times -> Times New Roman` 兼容映射。
- Docker 构建门禁移到所有 fontconfig 配置加载之后，最终 `fc-match 'Times New Roman'` 必须返回 `Times_New_Roman.ttf`，否则禁止发布。
- 公网 build `d625000-jd14` 验证：requested family=`Times New Roman`、resolved family=`Times New Roman`、目标 `title.0` SVG 第一字体=`Times New Roman`。
- 公网真实浏览器回归 6/6 PASS，Console/Page Error=0；readiness=`ready`、单实例 active、SQLite `integrity_check=ok`，用户/项目保持 `5/7`。
- 本地 `3000` 和本机 Docker 未修改、未停止。

**防复发规则**

- 字体协议必须同时记录 requested family 和 resolved runtime family，不能用 Linux 替代字体覆盖用户选择值。
- 字体 E2E 必须检查 patch、manifest requested/resolved family 和目标 gid 的 SVG 第一字体，禁止只检查下拉框标签或整张 SVG 的任意字体字符串。
- 安装真实字体后不得保留会覆盖该字体的兼容 alias；Docker 字体门禁必须在最终 fontconfig 状态下执行。
- 文字内容不得降级为纯前端 patch；Draft 清理必须比较 gid、prop、mode 和 value 后再删除。
- 严格 capability 的兼容只能按明确对象类型和属性白名单开放，禁止全局回退。

---

## 2026-07-15 21:14:30 +08:00 导出资产库误报账号未登录

**现象**

- 用户已登录且编辑区可正常访问，但点击“历史导出资产”后立即提示账号未登录。
- 本地 `3000` 与网页统一版同时存在，项目级导出资产列表不一定复现。

**根因**

- 全局认证请求包装器只覆盖 `/api/projects`、`/api/figure` 等受保护路径。
- 导出资产库调用 `GET /api/export-assets`、`POST /api/export-assets/zip` 和 `DELETE /api/export-assets`，该全局路由根未加入匹配器。
- 请求因此没有携带 Bearer Token；后端所有权校验正确返回 `401`，前端将其显示为未登录。

**修复**

- 在中央 `authenticatedFetch` 路径匹配器中精确加入 `/api/export-assets` 及其子路径。
- 不在页面组件内手工拼接 Authorization，继续统一复用 token refresh、重试和退出登录行为。
- 浏览器回归在 session/local storage 注入测试令牌，并直接断言资产库请求头为 `Bearer asset-smoke-token`。

**验证**

- 本地统一工作树隔离浏览器回归：PASS。
- 本地正在运行的 `http://127.0.0.1:3000` 真实浏览器回归：PASS，未重启或停止服务。
- 网页 `http://117.72.208.91` 真实浏览器回归：PASS。
- 线上 build `864ce62-jd19`：live=`live`、ready=`ready`、`acceptingNewJobs=true`。

**发布与下载源记录**

- 认证热修复提交：`7ae65b4`。
- 国内镜像部署基线提交：`864ce62`；线上 release：`864ce62-jd19`。
- 官方 Debian 源在候选 `jd17` 下载阶段停滞，未切换线上流量；改用阿里云 Debian/PyPI 与 npmmirror npm 后，`jd18` 成功发布，随后 `jd19` 全层缓存发布约 25 秒完成。

**防复发规则**

- 新增受认证 API 根路径时，必须同步加入中央认证匹配器并增加请求头断言。
- 页面级组件不得绕过中央 refresh/retry 链路自行管理 Bearer Token。
- 认证回归不能只 mock `200` 响应，必须验证实际发出的 Authorization 请求头。

---

## 2026-07-15 22:45:42 +08:00 登录限流重启清零与账号枚举时序风险

**现象**

- 登录、注册和验证码限流只保存在 Node 进程内，服务重启或同机多进程会各自重新计数。
- 不存在账号时登录会跳过密码哈希，和真实 Argon2id 账号的响应耗时不同，可形成账号枚举旁路。
- 只增加账号硬锁会带来新问题：攻击者知道邮箱后可以故意输错密码，让真实用户在冷却期暂时无法登录。
- 对不存在账号补 dummy Argon2 后，如果攻击者不断更换邮箱，可能反过来利用昂贵哈希消耗 CPU。

**修复**

- 新增 SQLite `auth_request_budgets` 与 `auth_login_throttles` 安全计数；使用 immediate transaction 原子扣减，同一数据库上的重启和多进程不会清零。
- 计数键使用独立生产 HMAC 密钥，只保存 HMAC(IP)、HMAC(IP+邮箱) 和 HMAC(邮箱)，不保存邮箱/IP 明文。
- 邮箱发送按 IP、IP+邮箱和全平台三层持久预算；登录按单 IP、全平台预算及账号失败次数共同约束。
- 不存在账号执行 dummy PBKDF2 + dummy Argon2；Argon2id 账号执行 dummy PBKDF2 + 真实 Argon2；旧 PBKDF2 账号执行真实 PBKDF2 + dummy Argon2，成功后继续迁移到 Argon2id。
- 达到账号阈值后，陌生设备在密码校验前统一返回 429；最近 45 天内数据库已登记的设备仍须提供正确密码才可解除软锁，降低定向拒绝服务风险。
- 生产缺少独立 `SCIFIGURE_AUTH_THROTTLE_SECRET` 时拒绝启动。

**验证**

- `npm test`：41/41 文件、248/248 PASS；TypeScript、生产构建和仓库边界通过。
- 跨重启认证 smoke：存在/不存在账号同错误响应、dummy 密码工作、第三次失败跨重启锁定、Retry-After、陌生设备阻断、可信设备正确密码软解锁、PBKDF2 迁移和 HMAC-only 存储全部 PASS。
- 邮箱验证、refresh、管理员只读、安全基线和用户隔离回归继续通过。
- 生产 bundle 在缺少邮箱配置或认证 throttle 密钥时均拒绝启动。

**限制与后续**

- 新设备仍可能在账号冷却期等待；后续需提供密码找回、邮箱解锁或风险验证流程。
- 邮件发送目前仍同步调用提供器；持久预算已限制滥用，但可靠 outbox/发送状态仍是后续可用性增强。
- 所有验证使用临时数据库和随机端口，未接触真实用户数据、本地 3000 或 Docker。

**防复发规则**

- 认证安全计数不得仅存在进程内；多进程共享边界必须由持久事务证明。
- 防账号枚举不能用“跳过昂贵工作”的快捷分支；旧密码算法也必须纳入时序模型。
- 引入 dummy 密码工作时必须同步增加单 IP 与全平台预算，避免把枚举修复变成 CPU DoS。
- 账号冷却必须提供受控恢复路径，不能让任意攻击者永久锁死真实用户。

---

## 2026-07-15 22:17:55 +08:00 邮箱验证预创建账号与管理员运营文本泄露风险

**现象**

- 旧邮箱验证流程在用户收到并输入验证码之前就创建永久账号并保存攻击者提交的密码；攻击者可抢先占用他人邮箱。
- 已注册邮箱返回假 challenge，新邮箱同步调用邮件提供器，虽然状态码一致，但响应延迟可以被用于枚举账号状态。
- 新验证码在邮件发送前就使旧验证码失效；提供器失败会让用户同时失去新旧验证码。
- 注册、验证与 Argon2 哈希的密码长度规则不一致，超长密码可能先触发邮件再无法完成验证。
- 管理员订阅原因、备注和审计 metadata 可能包含误粘贴的邮箱、路径、令牌或用户表格片段。

**根因**

- 邮箱 challenge 绑定预创建的 `users` 行，账号创建和邮箱所有权证明顺序倒置。
- 已注册邮箱和新邮箱使用不同控制流，邮件发送延迟成为旁路信号。
- challenge 持久化/旧码失效发生在邮件提供器确认之前。
- 密码规则散落在 API 和数据库层，没有共享策略；有效 challenge 唯一性只依赖应用约定。
- 管理员运营文本只做长度截断，没有内容边界和历史读取时的二次脱敏。

**修复**

- 新增待注册 challenge 表；验证成功前不创建永久用户、不保存待注册密码，也不签发会话。
- 新邮箱、待验证邮箱和已注册邮箱统一调用邮件提供器并返回相同结构；已注册账号验证后只提示登录，不修改原密码。
- 改为邮件发送成功后再原子替换 challenge；发送失败时上一条可用 challenge 保持有效。
- SQLite 部分唯一索引强制每个规范化邮箱最多一个未消费 challenge，并在建索引前只把历史重复 challenge 标记为已消费，不删除用户或项目数据。
- 注册、验证、登录迁移和 Argon2 哈希统一使用 8-1024 位密码策略；无效密码在发送邮件和昂贵哈希前拒绝。
- 邮箱发送增加 `IP + email` 与单 IP 总量双层限流；生产缺少强验证密钥和 Resend/HTTPS webhook 时拒绝启动。
- 管理员订阅原因、备注和审计 metadata 在写入与读取时过滤邮箱、绝对路径、Bearer/高熵秘密、结构化内容及敏感键。

**验证**

- `npm test`：40/40 文件、244/244 PASS。
- 邮箱验证 smoke：13 项 PASS，覆盖验证前无用户、账号状态同提供器路径、发送失败保留旧码、数据库唯一索引、密码前置校验和 HMAC-only 存储。
- 公开注册、refresh、管理员只读/授权、安全基线、用户隔离、数据完整性工具、生产 bundle、仓库边界和生产构建全部通过。
- 所有测试使用系统临时目录和随机端口；未连接本地 3000，未停止 Docker，未读取或修改真实用户数据。

**发布状态**

- 当前改动仅位于独立安全分支，尚未提交或部署。
- 公网调试服务器仍为 `864ce62-jd19`；未配置真实邮件提供器前禁止发布本轮邮箱验证代码。

**防复发规则**

- 永久账号创建必须发生在邮箱所有权验证之后；待验证层不得保存密码。
- 防账号枚举必须同时检查状态码、响应体和外部依赖造成的时序差异。
- 替换验证码不得在新邮件确认发送前破坏上一条可用验证码。
- 安全不变量必须由数据库约束和共享策略共同保证，不能只依赖路由约定。
- 管理后台只允许账号、订阅和脱敏运行元数据，禁止接收或返回用户脚本、数据、SVG、Figure、导出内容、路径、令牌和秘密。

---
