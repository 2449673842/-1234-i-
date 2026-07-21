# SciFigure 错误记录与修复日志

> 用于记录真实诊断文件、根因、修复动作和遗留风险。结论必须区分“平台问题”和“AI 转义脚本问题”。
> 最后修改时间：2026-07-30 15:15:32 +08:00

---

## 2026-07-30 15:15:32 +08:00 代码配色重放成功后前端仍保留旧 palette 元数据

**状态与级别**

- 状态：本地发布候选已修复，真实浏览器语义中心 `19/19 PASS`；尚未部署。
- 级别：P1 编辑状态一致性。服务端脚本、SVG、manifest、editLog 和 revision 已正确更新，但前端可能继续显示旧 palette 颜色，导致后续配色控件看似未绑定或再次编辑目标错误。

**根因**

- Python `code_patch` 会触发服务端权威重放，但响应的 `applied` 只包含最终对象 edit entries，不重复包含 code patch；其中可精确重放的对象颜色还会由服务端归一为 `local_patch`。
- 前端此前仅根据 `applied[].mode` 判断是否接收响应 SVG/manifest，因此把已经完成 renderer 重放的响应误当成纯 local patch，丢弃了新 palette 元数据，只把对象颜色补到旧 manifest。
- 旧语义测试只验证请求中存在 code patch、响应成功和对象 patch 正确，没有等待并核对 `sessionStorage` 中运行时 palette，因而未发现“服务端正确、前端状态陈旧”。

**修复与验证**

- 前端现在以成功响应是否同时携带服务端 SVG 和 manifest 作为权威重放证据；有该证据时安装响应结果，纯 local 响应仍使用即时 SVG/manifest patch。判断不依赖客户端声明的 mode。
- 浏览器测试等待指定 palette ID 的运行时颜色写回，再核对脚本常量、目标 GID、对象属性、editLog、applied mode 和同色分组隔离；超时会保留响应/运行态 revision 与颜色诊断。
- 散点验收改用保持相对大小的 `size_scale=1.5`；从子集配色切换到全局配色时显式选择“全部子图”，保留控制面板随当前子图自动跟随的产品行为。
- `npm run test:semantic-smoke`：`19 PASS / 0 FAIL / 0 BLOCKED`，console error 和 page error 均为 0。

**防复发规则**

- 服务端 renderer 已返回权威 SVG/manifest 时，前端不得因 `applied` 列表省略 code patch 或将对象降为 local mode 而丢弃该结果。
- code patch 验收必须同时验证请求、服务端响应和前端运行时 manifest；只验证 HTTP、payload 或 SVG 均不足以证明编辑状态一致。
- 测试全局作用域前必须显式选择全局，不能依赖上一次对象选择前的隐式范围。

---

## 2026-07-21 22:06:41 +08:00 R 安全测试缺少临时数据根与旧 identity 缺少静态升级证据

**状态与级别**

- 状态：测试隔离与 R-WP0 基线已修复；未修改产品行为，未推送、未部署。
- 级别：P1 测试数据边界与兼容证据真实性。测试虽使用临时 DB，但未显式设置数据根时仍可能让服务端默认初始化仓库真实 `data/`；动态生成的“旧 manifest”也不能证明未来升级兼容真实旧记录。

**根因与修复**

- `r_security_precheck_smoke.mjs` 原先只设置临时 `SCIFIGURE_DB_PATH`，主服务和 production/staging guard 没有设置 `SCIFIGURE_DATA_DIR`；端口使用随机区间而非系统分配。
- R semantic 浏览器脚本有 `localhost:3000` fallback，即使 package 入口通常走隔离 wrapper，直接执行仍可能误触运行服务。
- 当前 R identity 尚无 fingerprint 版本；若等 R-WP2 完成后才生成兼容 fixture，测试会把新 renderer 结果伪装成旧项目。
- 当前安全测试为主服务和 guard 设置独立临时 data/DB、`SCIFIGURE_TEST_ISOLATED=1`、空 legacy owner 和系统分配端口。R semantic 测试缺少 wrapper、临时路径或使用 3000 时立即拒绝。
- 冻结 `legacy_identity_v1.json`，保留升级前无 `fingerprintVersion/fingerprint` 的 group identity 和 durable editLog；renderer 定向测试先证明当前基线可重放。
- capability matrix 扩展为 15 个纯合成 R fixture，base R 的预览/导出但不可语义编辑边界也成为可执行断言。

**验证与防复发**

- R renderer 32 个正向测试通过；另有 1 个 legacy 分组语义漂移 `expectedFailure`，明确证明当前 ordinal GID 仍可能误应用旧 editLog，作为 R-WP2 阻断项；Python/R capability matrix 2/2。
- R semantic 浏览器 6/6，覆盖字体、组件、分组配色、Draft/apply 和导出 bundle editLog；R 安全预检通过。
- 后续旧版兼容测试必须引用升级前冻结的静态记录，不能在新 renderer 下即时生成。
- 自建 server 或浏览器 smoke 必须同时设置临时 data、临时 DB、随机非 3000 端口和 isolation marker；只设置临时 DB 不算完整隔离。

---

## 2026-07-20 16:10:50 +08:00 local 修改后 backend 编辑冲突与线上 spine 旧镜像崩溃

**状态与级别**

- 状态：本地候选已修复并通过定向回归；尚未推送、尚未部署，线上旧 renderer 仍会出现对应 `KeyError`。
- 级别：P0/P1。前者会让一次合法 local 修改后的 backend 修改被误判为冲突；后者会让不包含 `left` spine 的 axes 在 introspection 阶段直接退出。

**现象与根因**

- 纯 local patch 成功后会按既有设计清空项目 preview manifest，等待下一次权威 renderer 结果。后续 backend patch 的服务端预检此前把“存储 manifest 缺失”直接判为 `manifest_unavailable`，没有进入 renderer 验证。
- 线上诊断 `KeyError: 'left'` 来自旧 renderer 镜像中的 `_read_spine_group_props` 固定访问 `ax.spines['left']`。当前仓库已按实际可用 spine 通用读取，因此线上代码与本地候选不一致。
- Python 完整语义链路首次复跑还暴露一条旧测试假设：组件中心已统一把 set 修改交给 backend renderer 验证，但饼图测试仍要求 facecolor 为 `local_patch`。

**修复与验证**

- 存储 manifest 存在时继续执行严格服务端预检；缺失时不信任客户端 mode，而是交给 backend renderer 验证，并在持久化前核验返回 manifest。
- `tests/api/patch_rejection_persistence_regression.mjs` 覆盖 local 后 backend 成功和 renderer 拒绝零持久化；`test:patch-rejection-persistence` 通过。
- `tests/test_introspection.py` 新增无 left spine 的 polar axes 回归；introspection 50/50 通过。
- Python 完整语义测试要求饼图及关联图例的请求 set patch 全部走 `backend_patch`，并检查响应 JSON `status`；同时验证服务端按可信 manifest 将可精确本地重放的 facecolor 归一为 `local_patch`、linewidth 保持 `backend_patch`，防止 HTTP 200 掩盖业务冲突；`test:python-semantic-workflow` 通过。
- 本轮直接相关门禁通过：`test:semantic-smoke` 14/14、`test:project-save-preflight`、`test:drag-extended-smoke`、`test:cache-smoke`、`test:cross-figure-smoke` 18/18。

**防复发规则**

- preview manifest 缺失不是客户端 mode 的授权依据；只能转入权威 renderer 验证，失败时 revision、editLog、history、session、cache、export anchor 和 snapshot 必须零变化。
- introspector 不得假设所有 axes 都存在 left/right/top/bottom 四条 spine，必须按实际容器成员读取。
- 浏览器/API smoke 必须同时检查 HTTP 状态和业务响应 `status`，不能只以 2xx 判定编辑成功。

---

## 2026-07-20 15:21:44 +08:00 现代 capability 仍存在旧 contour、专用控件和快照恢复旁路

**状态与级别**

- 状态：已修复并通过定向单元、旧项目、快照、导出、组件中心和轴样式隔离回归；未推送、未部署。
- 级别：P0/P1 编辑权威与错误持久化边界。不会直接删除数据，但可能把 renderer 未声明的属性送入 patch，或让新快照按旧 contour 兼容规则重放未授权编辑。

**现象与根因**

- 项目全渲染曾以 `allowLegacyContourChild` 按对象形态放行 contour child，现代对象即使声明空 `propertyCapabilities` 也可能被旧规则绕过。
- 导出快照恢复同样只判断“是否像旧 contour child”，没有证明该编辑确实来自旧 manifest。
- `RightSidebar` 的轴、网格、边框、图例、批量刻度和风格预设仍有直接构造 patch 的入口；配色 legacy resolver 也未检查 `object` scope。
- 初次给 `handlePatch` 加对象门禁时未单独处理 `gid=global`，短暂导致画布尺寸和 DPI 等全局控件被静默拦截；该问题由独立审查发现后在同一工作包内修复。
- standalone local patch 的服务端回传若被提升为 backend，前端曾只更新 editLog/revision，没有接收权威 SVG/manifest。

**修复**

- 现代 manifest 的属性存在性、`replay` 和 `scopes` 共同作为服务端与前端事实；直接对象编辑必须包含 `object` scope。
- 旧 contour child 只在目标 patch 与已持久化旧 editLog 的 `gid/prop/value` 完全一致时兼容；新的未持久化 child patch 一律冲突且零写入。
- 新导出快照升级为 schema v4，每个 Figure 保存服务端生成的 `legacyReplaySignatures`；v4 只重放签名内旧编辑，v1-v3 继续可读。
- `RightSidebar` 统一使用 capability-aware helper；声明过的 global 字段继续生成 backend patch，未知 global 和现代对象未声明属性被前端拦截。
- 专用轴/网格/边框/图例控件、文字立即应用、图例字号联动、批量刻度、轴/边框风格预设和配色 legacy fallback 全部接入同一能力边界。
- `ChartPreview` 双击文字只对声明 `text` 能力的对象开放；standalone local 响应被服务端提升为 backend 时采用权威 SVG/manifest。

**验证**

- 定向 Vitest：快照、属性作用域、RightSidebar、ChartPreview、配色和 session 对账最高一轮 13 文件、210 项通过；最终旁路补充 9 文件、199 项通过。
- `npm run test:legacy-contour-project-compatibility`：现代 child 拒绝且零持久化、v4 未签名旁路拒绝、真实旧 editLog 保存/导出/恢复通过。
- `test:export-snapshot-db`、`test:export-snapshot-restore`、`test:export-snapshot-concurrency`：全部通过，包含 v1、contour、hist/stairs/step、pie 和多 Figure 恢复。
- `test:export-matrix-smoke`：全局画布比例与 SVG/PNG/PDF/TIFF/子图导出通过。
- `test:component-container-smoke`：41/41；`test:axis-style-semantics-smoke`：8/8。
- `npm run lint` 与 `git diff --check`：通过。

**防复发规则**

- 任何 legacy 兼容都必须有可验证来源，不得只按 kind/role/GID 形态放行。
- 新快照若需要兼容旧编辑，必须记录服务端生成的精确 allowlist；客户端字段或对象外观不能成为授权依据。
- 所有 UI patch 出口，包括立即应用、预设、批量和 fallback，都必须复用统一 capability helper；global 必须有独立声明检查。
- 新增属性必须同时验证属性存在、`replay` 和作用域；现代 capability 省略即拒绝，只有完全缺失 capability 数组的旧 manifest 才允许受控 fallback。

---

## 2026-07-20 11:36:50 +08:00 组件中心批量入口仍可能显示未声明属性并残留已应用 Draft

**状态与级别**

- 状态：已修复并通过 RightSidebar、Draft transaction、lint、组件中心真实浏览器 smoke 和 diff 检查；随本轮本地候选提交保存，未推送或部署。
- 级别：P1 编辑入口一致性与暂存状态正确性。不会删除数据，但可能让现代 manifest 未声明的组件属性出现在批量控件中，或在应用成功后残留同一批已确认 Draft，导致下一次保存预检冲突。

**现象**

- 组件中心批量入口的 `supportsBatchProp` 与子图详情入口已开始收敛，但批量组内仍有部分控件按 kind/legacy 规则整体显示。
- 现代对象只有部分 `propertyCapabilities` 时，批量区块可能出现未声明的 `left/bottom/height/aspect` 等控件。
- 部分组件中心 set patch 以 local 方式暂存后，保存成功响应返回时可能仍读取旧 React state；已持久化的 Draft 没有立即从当前 scope 清除，后续批次可能再次提交同一 patch。

**根因**

- 组件中心批量支持判断仍是 RightSidebar 内部局部函数，外部测试无法直接覆盖，并且部分 legacy fallback 没有统一暴露为可测 helper。
- `apply current drafts` 在异步执行期间读取闭包中的 `projectDrafts`，可能落后于最新 Draft 状态。
- Draft 清理只依赖 settlement 流程，没有在当前 Figure 成功应用后做同内容确认删除。

**修复**

- 新增并导出 `supportsComponentBatchProp`，批量控件统一复用 capability-aware 规则：现代 `propertyCapabilities` 为权威，旧 manifest 才走 legacy fallback。
- 子图批量 bounds 控件改为按 `left/bottom/width/height/aspect` 逐项显示，不再因 `width` 可编辑而展示其他未声明字段。
- 组件中心生成的 set patch 保守标记为 `backend_patch`，由 renderer 验证后再持久化，避免语义组件编辑被未验证 local Draft 误认为成功。
- `projectDraftsRef` 与 state 同步；成功应用当前 Figure 后，仅当当前 Draft 与执行快照内容完全一致时删除该 Draft，避免误删保存期间用户新改动。
- 新增 `isSameDraftPatch` 做内容级比较，不再依赖对象引用相同。

**验证**

- `npm test -- RightSidebar`：8 项通过。
- `npm test -- draftTransaction`：4 个测试文件、32 项通过。
- `npm run lint`：通过。
- `npm run test:component-container-smoke`：PASS=41、FAIL=0。
- `git diff --check`：通过，仅有既有 LF/CRLF 提示。

**防复发规则**

- 组件中心、配色中心、字体中心和布局中心不得各自维护不可测试的 capability 判断；新增批量属性必须暴露或复用可测 helper。
- 已应用 Draft 的清理必须比较执行前快照与当前 Draft 内容，不能按 `gid/prop` 粗略删除，也不能保留已确认成功的同内容 Draft。
- 组件中心语义 set patch 默认走 renderer 验证；只有 capability 明确证明可本地安全应用时，才允许 local persistence。

---

## 2026-07-20 10:37:13 +08:00 子图 bounds 外层 capability 通过后内部仍显示未声明属性

**状态与级别**

- 状态：已修复并通过 RightSidebar/property/target 相关单元回归；尚未提交、推送或部署。
- 级别：P1 前端控件边界一致性。不会删除数据，但可能让 modern manifest 只声明部分子图 bounds 能力时，未声明的 `left/bottom/width/height` 输入框仍显示。

**现象**

- `RightSidebar.renderSubplotPanel` 的外层 `canEditBounds` 已使用 capability 判断。
- 但进入 bounds 区块后，四个输入框仍只检查 `unsupportedProps`，没有逐项检查 `propertyCapabilities`。
- 结果是：只要 `left/bottom/width/height` 中任意一个属性可编辑，其他未声明属性也可能显示。

**根因**

- 前一轮修复把区块级入口切到 `supportsObjectProp`，但没有把区块内部每个字段的显示条件一并收敛。
- 这是典型“外层门禁正确，内层字段旧逻辑残留”的 UI 漏口。

**修复**

- 新增并导出 `supportsSubplotBoundProp`，当前复用 `supportsObjectProp`，用于子图 bounds 字段级显示。
- `left/bottom/width/height` 四个输入框全部改为逐项检查 `supportsSubplotBoundProp(obj, prop)`。
- 保留旧 manifest 无 `propertyCapabilities` 时的 legacy editable fallback。

**验证**

- `npm test -- RightSidebar propertyPatchMode targetResolver`：18 个测试文件、310 项通过。
- `npm run lint`：通过。
- `git diff --check`：通过，仅有既有 LF/CRLF 提示。
- `npm run data:audit`：25 用户、121 项目、263 项目文件、101 导出资产，issue 0；23 条既有测试账号 warning 保持不变。
- 新增回归覆盖：modern subplot 仍有 `editable: ["left","bottom","width","height"]`，但 capability 只声明 `width` 时，只支持 `width`；legacy subplot 无 capability 字段时仍按 `editable` 支持。

**防复发规则**

- UI 区块级门禁通过后，区块内部每个输入控件仍必须逐项检查 capability，不得用 `unsupportedProps` 替代 capability。
- 子图 bounds、图例 layout、轴细项这类组合控件必须同时覆盖“部分属性可编辑”的测试。

---

## 2026-07-20 10:32:45 +08:00 capability 支持判定在多个工具中重复实现，存在再次分叉风险

**状态与级别**

- 状态：已收敛到统一 helper，并通过相关单元矩阵；尚未提交、推送或部署。
- 级别：P2 维护性/回归预防。当前未发现直接数据损坏，但重复逻辑容易让后续某个入口再次回退到旧 `editable` 行为。

**现象**

- `editingIntentCompiler`、`targetResolver` 和 `semanticPatchMapping` 各自实现了一份 `supportsProp`。
- 这些实现大体遵守现代 `propertyCapabilities` 边界，但细节不同，例如 unsupported、contour 结构属性、legacy editable fallback 和 parent-owned 对象边界需要人工保持一致。

**根因**

- WP3 是逐入口收敛，早期为了快速封堵风险在多个文件内各自加了 capability 判断。
- 缺少单一对象级能力判定函数时，后续新增图元或属性容易只改其中一个入口。

**修复**

- `supportsObjectProp` 增加 contour 结构属性拒绝，避免 `levels/x/y/z` 这类结构属性被普通对象控件放行。
- `editingIntentCompiler`、`targetResolver` 和 `semanticPatchMapping` 的普通对象属性支持判断改为复用 `supportsObjectProp`。
- strict `targetResolver` 仍保留额外 `capability.scopes` 校验，避免把 object 支持误认为 cross-Figure/figure/subplot 支持。

**验证**

- `npm test -- paletteTargetResolver propertyPatchMode targetResolver semanticPatchMapping editingIntentCompiler`：25 个测试文件、441 项通过。
- 新增回归：contour 对象即使声明 `levels` capability，`supportsObjectProp(contour, "levels")` 仍返回 false。

**防复发规则**

- 新增普通对象控件、语义 intent 或 editLog 映射前，先复用 `supportsObjectProp`；只有 scope、cross-Figure 或特殊事务语义才允许在外层追加判断。
- contour、histogram、pie、quiver、streamplot、diagram 等结构属性不得因 capability 字段存在而被当作普通样式控件开放。

---

## 2026-07-20 10:27:46 +08:00 单对象详情和拖拽入口仍可绕过现代 propertyCapabilities

**状态与级别**

- 状态：已修复并通过 `propertyPatchMode` 单元回归；尚未提交、推送或部署。
- 级别：P1 前端能力边界一致性。不会删除数据，但可能让现代 manifest 中 renderer 未声明的属性仍显示控件或进入拖拽流程，造成“看起来能改，实际不可安全重放”的错误体验。

**现象**

- `ChartPreview` 文本拖拽仍直接判断 `editable.includes("position")`。
- `RightSidebar` 单对象详情面板中，子图 bounds/aspect、轴刻度文字偏移、图例 layout 细项、annotation anchor 和通用属性列表仍直接读取 `editable`。
- WP3 已规定：对象存在 `propertyCapabilities` 数组时，未声明属性必须视为不可编辑；`editable` 只能兼容没有 capability 字段的旧 manifest。

**根因**

- 早期前端将 `editable` 同时作为旧 UI 控件开关和编辑能力来源；后续服务端、批量入口、配色入口逐步切到 `propertyCapabilities`，但拖拽和单对象详情入口没有统一使用同一判定函数。
- 这类问题不一定触发数据损坏，因为服务端仍会校验，但会制造不可用控件、错误 Draft 或用户误判。

**修复**

- 新增 `supportsObjectProp(object, prop)`：
  - 现代 manifest：只接受 `propertyCapabilities` 中声明且 `replay !== "unsupported"` 的属性。
  - 旧 manifest：没有 `propertyCapabilities` 字段时继续使用 `editable + unsupportedProps` 兼容。
  - parent-owned 对象和 Python 结构属性仍不开放普通对象控件。
- `ChartPreview.isDraggableTextObject` 改为用 `supportsObjectProp(obj, "position")`。
- `RightSidebar` 单对象详情中的子图、轴、图例、annotation anchor 和通用属性列表改为使用同一 helper。

**验证**

- `npm test -- propertyPatchMode`：4 个测试文件、115 项通过。
- `npm test -- paletteTargetResolver propertyPatchMode targetResolver semanticPatchMapping editingIntentCompiler`：25 个测试文件、441 项通过。
- `npm run test:drag-extended-smoke`：通过，覆盖多选拖拽、实时对象预览、取消、unsupported 拦截、annotation 拖拽和 R 原生保护。
- `npm run lint`：通过。
- `git diff --check`：通过，仅有既有 LF/CRLF 提示。
- `npm run data:audit`：25 用户、121 项目、263 项目文件、101 导出资产，issue 0；23 条既有测试账号 warning 保持不变。
- 新增回归覆盖：现代对象 `editable` 仍包含 `position` 但 capability 未声明时不支持；旧对象无 capability 字段时仍支持；unsupported、parent-owned 和结构属性均拒绝。

**防复发规则**

- 前端所有“是否显示控件/是否允许拖拽”的对象级判断必须复用 capability-aware helper，不能直接读取 `editable.includes`。
- `editable` fallback 只服务旧 manifest 兼容；新协议对象的 capability 省略是明确拒绝，不是待猜测状态。
- 修复 UI 入口后仍要检查服务端预检、导出快照、配色 fallback 和批量入口是否使用同一边界。

---

## 2026-07-19 22:48:05 +08:00 图示对象关系身份不完整且受保护文字重放被误判身份漂移

**状态与级别**

- 状态：已修复并通过 renderer、API、真实浏览器、跨 Figure、导出恢复、R 共享协议和数据审计；首次独立审查发现的关系补齐 HIGH 已修复，最终复审 APPROVE、0 HIGH/MEDIUM。实现已包含于本地提交 `b20b103`，尚未推送或部署。
- 级别：P0/P1 编辑正确性。不会删除源数据，但可能把网络图、路径图或 SEM 图元按外观错误联动，或把合法字体修改拒绝为 `identity_mismatch`。

**根因**

- 普通 Matplotlib patch、collection、line、arrow 和 text 无法仅凭颜色、形状或标签可靠区分节点、边、箭头、路径系数和拟合指标。
- 第一版专用语义的初始 manifest 对受保护图示文字使用真实文本生成 stableKey/fingerprint；renderer 重放身份校验仍使用内部 GID 标签，两条路径不一致。
- 第一版图示 `seriesKey` 只包含 diagram、role 和 object id，未包含 `diagramType/nodeId/edgeId/sourceNodeId/targetNodeId`；相同 GID、几何和 object id 但端点变化时，旧样式可能静默作用于新的科学关系。
- 对已经携带部分 identity 的旧 Draft 使用当前 manifest 补齐缺失端点，会掩盖本应被发现的拓扑漂移。
- 新浏览器测试把“导出前 session editLog”直接当成导出快照状态，遗漏既有契约会补齐最后成功预览的 `figure.width_in/height_in/dpi`，产生假失败。

**修复**

- renderer 注入 `_scifigure_semantic_gid(...)`，只接受脚本显式声明的 diagram、node 和 edge 关系；普通外观相似对象保持通用分类。
- 新增 `diagram_node/edge/arrow/node_label/coefficient_label/fit_annotation/group` 七类 role、独立组件与配色分组，全部样式使用 backend replay。
- 路径系数、p 值、显著性、拟合指标、方向、端点、节点身份和模型拓扑保持只读；拒绝请求不写 revision、session、history、cache、导出锚点或快照。
- 初始 manifest 与 `_current_identity_signature()` 对受保护文字统一使用真实文本标签，保留完整 v2 stableKey/fingerprint/seriesKey 校验。
- renderer、项目 patch 预检和导出快照 dry-run 统一比较七个关系字段组成的完整 diagram relation signature；关系缺失、类型异常或任一端点变化均整批 fail-closed。
- patch 只有在 identity 完全缺失时才从当前 manifest 首次捕获；已存在的完整或部分 identity 原样保留，不使用较新的 manifest 回填证据。
- `scifigure-sem-v1:` / `_scifigure_semantic_gid(...)` 是用户脚本的显式声明协议，不是密码、签名或科学真实性认证；合法手写 marker 可识别，畸形 marker 保持普通图元。
- 导出恢复浏览器测试按 `mergePreviewGlobalsIntoEditLog` 的既有契约计算期望快照，不修改产品恢复逻辑。

**验证与防复发**

- Vitest 145 文件、1078/1078；complex artist 26/26、结构身份漂移 7/7、R renderer 31/31。
- 图示 API 持久化覆盖 7 类合法视觉样式和 13 类科学结构属性零持久化拒绝。
- 真实浏览器覆盖 Draft、应用、保存刷新、撤销重做、文字位置、SVG 导出、后续编辑和快照恢复；跨 Figure 覆盖关系不同、缺失和重复三类 fail-closed 场景。
- 组合代码项目、R 浏览器 5/5、R 风险预检、TypeScript、生产构建和 `git diff --check` 通过。
- 图示 API 额外覆盖拓扑变化、关系缺失、合法+冲突混合批次和篡改导出快照；拒绝后 revision、session、history、cache、export anchor 和 snapshot 均不改变。
- 数据审计保持 25 用户、121 项目、263 项目文件、101 导出资产、0 错误。
- 后续新增身份标签规则必须同时修改初始 manifest 与重放身份路径，并用携带完整 v2 身份的 backend patch 回归；不得通过删除 fingerprint 校验修复合法编辑。
- 后续图示能力只能由显式语义或可证明的库级 adapter 开放，不能按外观、颜色或文字内容猜测科学关系。

---

## 2026-07-19 21:02:01 +08:00 向量场被压平、跨 Figure 关系绕过与结构参数误编辑风险

**状态与级别**

- 状态：已修复并完成单元、renderer、API、真实浏览器、跨 Figure、历史、导出、兼容门禁和独立审查；尚未提交、推送或部署。
- 级别：P0/P1 编辑正确性。不会删除源数据，但可能把向量场误当普通 collection/patch、把一个 Figure 的修改扩散到关系不匹配的 Figure，或把科学结构参数当成视觉样式持久化。

**根因**

- quiver 和 streamplot 过去只有通用 Matplotlib children，缺少可信调用来源、语义父对象和稳定关系字段。
- streamplot 的 line collection 与 arrow patch 可被普通组件入口直接命中，无法证明它们属于同一流线对象。
- 第一版真实跨 Figure 测试通过直接写 `sessionStorage` 注入 Draft，绕过了实际组件控件；改为真实控件后暴露 `App.tsx` 中显式 `crossFigure: allow` 只对 pie 使用身份约束、对向量场退回 role-wide fanout 的问题。
- 非字符串 Matplotlib line color 可表现为 ndarray，旧 JSON 输出路径会触发 500。

**修复**

- quiver 提升为 `kind=quiver`、`role=quiver_field`，保留历史 `collection.*` GID/stableKey；streamplot 新增 `container.streamplot.*` 父对象，内部 line/arrow 标记 `parentOwned` 且只读。
- 组件中心新增 Quiver/Streamplot 独立分组；唯一标签和图例 marker 按 `quiverId`/`streamplotId` 关联。
- 跨 Figure 对向量场及其图例 marker 强制使用可信关系的一对一映射；关系缺失、冲突、重复或不匹配全部 fail-closed。
- 只开放颜色、透明度、线宽、显隐和层级等视觉属性；向量、尺度、angles/pivot/units、箭头几何、密度、起点、积分方向和路径结构显式只读。
- Matplotlib 非字符串颜色在 manifest JSON 输出前统一规范化。

**验证与防复发**

- Vitest 144 文件、1035/1035；Python complex artist coverage 22/22。
- 向量场 API 持久化、真实浏览器完整工作流、真实组件控件跨 Figure、Python 完整语义工作流、patch 拒绝零持久化、组件 41/41、跨 Figure 18/18 和 R 5/5 通过。
- Matplotlib 3.8.4 临时兼容门禁 5/5；lint、build、`git diff --check` 通过。
- quiver `scale` 与 streamplot `density` 拒绝后，revision、session、history、cache、export anchor 和 snapshot 均不改变。
- 独立 gpt-5.5 high 审查 APPROVE，0 HIGH/MEDIUM/LOW。
- 后续复杂对象浏览器回归必须通过真实 UI 控件产生 Draft；不得把直接写 storage 的测试作为真实交互证据。

---

## 2026-07-19 21:01:16 +08:00 Python 运行时与 Matplotlib 包版本口径混淆

**状态与影响**

- 状态：文档已纠正；本轮未修改依赖、运行服务、Dockerfile 或部署版本。
- 影响：此前主文档把本地 Matplotlib 3.7.2、兼容门禁 Matplotlib 3.8.4 和“网页 3.11.0”并列，容易把 Python 3.11.0 误读成 Matplotlib 版本，导致错误的兼容结论。

**事实与防复发**

- 当前本机 renderer fallback 是 Python 3.8.19 / Matplotlib 3.7.2；`Dockerfile.renderer` 当前声明 `python:3.12-slim`；`requirements.txt` 当前声明 `matplotlib>=3.8`。
- Matplotlib 3.8.4 仅是 Python 3.12 临时容器中的定向兼容门禁，不是当前本机运行版本，也不是依赖 pin。
- 网页 Python runtime 版本只有在运行时命令或不可变镜像元数据证明后记录；不得再把 `3.11.0` 写成 Matplotlib 版本。
- 后续版本台账固定分列记录 OS、Python、Matplotlib、R、关键包、字体和镜像 digest；测试基线、兼容门禁与生产运行版本分别标注。

---

## 2026-07-19 19:51:21 +08:00 饼图扇区跨 Figure 扩散、关系歧义与结构参数误开放风险

**状态与级别**

- 状态：已修复并完成定向单元、真实浏览器、完整语义工作流、Matplotlib 3.8.4 兼容门禁和独立审查；尚未提交、推送或部署。
- 级别：P0/P1 编辑正确性。不会删除源数据，但可能把单个扇区修改扩大到其他扇区、把源 Figure 身份写入目标 Figure，或把科学结构参数误当视觉样式。

**根因**

- `Axes.pie` 过去只表现为普通 `Wedge/Text/legend patch`，缺少扇区、类别标签、数值标签和图例标记的稳定关系。
- 单对象跨 Figure 曾沿用通用语义 fanout，选中一个 slice 后可能扩展到目标 Figure 的全部 slice。
- 语义评分最初只给相同 `pieId/sliceIndex` 加分，没有把不同、重复或缺失关系元数据作为硬拒绝条件。
- 目标映射曾保留源 Figure 的 stableKey/fingerprint/identity，存在后续重放身份漂移风险。

**修复**

- 拦截可信 `Axes.pie` 调用，输出 `pie_slice`、`pie_label`、`pie_value_label`，并以 `pieId + sliceIndex` 关联唯一 legend marker；手工 `Wedge` 使用独立 `wedge_slice`。
- 组件和配色中心新增专用分组；扇区颜色与唯一关联 marker 作为一个 Draft/历史动作，普通 patch、bar 和 legend marker 不混入。
- 单 slice 跨 Figure 使用一对一身份映射；目标 patch 替换为目标 Figure 的 stableKey/fingerprint/identity。
- 不同 `pieId`、不同 sliceIndex、同分重复候选和缺失 pie 关系元数据全部 fail-closed。
- `values/value/fraction/center/radius/theta/width/explode/startangle` 等结构参数显式只读并加入零持久化拒绝回归。

**验证与防复发**

- 定向 Vitest 4 文件/26 项通过；覆盖错误 pieId、重复候选、缺失关系和普通 legend marker 兼容。
- `test:python-semantic-workflow` 通过；包含 Draft、后端重绘、导出、后续编辑和快照恢复。
- `test:cross-figure-smoke` 18/18；每个目标 Figure 只有一个对应 slice 和一个关联 marker。
- Matplotlib 3.8.4 清华镜像 wheel SHA-256 为 `f51c4c869d4b60d769f7b4406eec39596648d9d70246428745a681c327a8ad30`，三项 pie 身份测试和 Python capability matrix 4/4 通过。
- `npm run lint`、`npm run build`、`git diff --check` 通过；独立 5.5 high 审查 APPROVE，0 HIGH、0 MEDIUM，唯一 LOW 已修复。
- 后续任何复合对象一对一映射必须把关系字段作为硬边界；关系缺失、重复或无法证明时跳过，不按颜色、数组位置或相似标签猜测。

---

## 2026-07-19 16:22:04 +08:00 直方/阶梯对象误归类与过期保存覆盖新编辑

**状态与级别**

- 状态：已修复并通过两套 Matplotlib、浏览器、历史、导出、安全、旧项目兼容和三轮独立复审；尚未提交、推送或部署。
- 级别：P0 编辑正确性与数据一致性。不会删除源数据，但可能把结构参数当样式开放、把修改写到内部子 patch，或由旧自动保存覆盖用户刚完成的编辑。

**现象**

- `hist`、`stairs`、`step` 与普通 bar、patch、line 共用基础类，组件和配色无法稳定区分系列边界。
- histogram 内部多个 rectangle 可被单独选中，系列改色可能扩散到同色普通对象。
- 旧自动保存与 patch/手动保存并发时，可在相同 revision 下用旧 editLog 覆盖新值；保存期间的新 Draft 也可能被旧响应按 `gid/prop` 粗略清除。
- 旧项目加载会从 `project_figures` 或 `spec.editLog` 恢复，但 PUT 曾只比较 session，导致合法旧项目保存被误判冲突。

**根因**

- 只依赖 Matplotlib artist class，缺少 `Axes.hist/stairs/step` 的可信调用来源和父子关系。
- 项目 PUT 没有 revision/editLog hash CAS，且本地样式保存不一定增加 revision。
- 排队保存直接在旧 Promise 的 `finally` 中调用旧 React 闭包；草稿清理只比较 key，不比较已持久化值。
- GET 与 PUT 使用了不同的 editLog 恢复优先级。

**修复**

- 记录可信绘图调用来源，输出 `histogram_series`、`stairs_series`、`step_series`；histogram 子 patch 标记 `parentOwned` 并重定向到父系列。
- 只开放颜色、线宽、线型、透明度、marker 和 zorder 等可证明视觉属性；数据、分箱、边界、where 和 baseline 等结构参数保持只读。
- 项目 PUT 要求 `baseRevision + baseEditLogHash`；缺前置条件、revision 漂移或 hash 漂移均在事务前 409，冲突请求零写入。
- 排队保存等待下一次 React 提交；草稿只在当前值与服务端确认值完全相同时清除。
- GET/PUT 统一使用非空 session、`project_figures.edit_log`、单 Figure `spec.editLog` 的恢复顺序；缺 CAS 的语义相同旧 payload 不覆盖 Figure 状态。

**验证**

- Vitest 144 文件/966 项；Matplotlib 3.7.2 与 3.8.4 均为 110/110。
- 组件浏览器 41/41、语义中心 14/14、跨 Figure 16/16、扩展拖拽 10/10、R 浏览器 5/5。
- patch 拒绝、项目保存预检、旧 contour 项目、历史、导出快照、并发恢复、文件事务、安全和用户隔离通过。
- `npm run build`、`git diff --check` 通过；数据审计保持 25 用户、121 项目、263 文件、101 导出资产、0 错误和 23 条既有告警。
- 最终独立 5.5 high 复审 PASS，无 HIGH/MEDIUM。

**防复发规则**

- 复合图元必须用可信 provenance 或等强证据分类，不能只看通用 artist class。
- 内部 child 不能作为现代编辑目标；结构参数必须显式只读并有拒绝持久化测试。
- 不增加 revision 的状态保存必须同时校验稳定 hash；缺 CAS 的请求不得改写 Figure 状态。
- GET 与 PUT 必须复用同一恢复函数；旧项目兼容测试必须覆盖加载、无状态保存、真实改写、导出和恢复。
- 保存回调只能清除它实际确认的值；排队异步操作不得复用旧 React 状态闭包。

---

## 2026-07-16 22:46:02 +08:00 生产静态目录暴露后端 bundle 与 source map

**现象**

- 公网请求 `/server.cjs` 返回生产后端 bundle，请求 `/server.cjs.map` 返回包含 `sourcesContent` 的 source map。
- 未登录管理 API、`.env` 和 SQLite URL 没有返回敏感数据，但公开后端源码会降低攻击者枚举接口和分析防线的成本。

**根因**

- Vite 前端和 esbuild 后端共同输出到 `dist/`，生产服务又把整个 `dist/` 交给 `express.static`。
- esbuild 生产命令启用了 `--sourcemap`，且缺少后端产物与前端公共资产之间的显式边界。
- 既有生产 bundle smoke 只验证服务启动和健康接口，没有请求构建产物及敏感文件形态路径。

**修复**

- 生产构建停止生成 `server.cjs.map`。
- Vite 前端公共文件迁到 `dist/public/`，后端 bundle 保留在非公共的 `dist/server.cjs`，从目录结构上分离浏览器资产与服务端产物。
- Express 静态服务前拒绝后端脚本、source map、数据库、密钥、环境文件和 TypeScript 路径，并拒绝隐藏路径。
- HTTP 和 TLS Nginx 模板对 `/server.cjs` 与 `/server.cjs.map` 增加精确 `404`，形成边缘与应用双层防护。
- 生产 bundle smoke 增加敏感路径 `404`、source map 不存在和前端应用壳仍可访问的回归断言。

**验证**

- TypeScript、41 个 Vitest 文件/250 项、生产构建、生产 bundle、部署包、安全基线和仓库数据边界检查通过。
- 修复前回归稳定复现 `/server.cjs` 返回 `200`；修复后隔离生产 bundle 中敏感路径全部返回 `404`。
- `e35f4a4-jd22` 已于 2026-07-16 23:04:58 +08:00 原子部署；直接访问 Node 和经公网 Nginx 访问 `/server.cjs`、`/server.cjs.map` 均返回 `404`。
- 大小写、URL 编码、隐藏文件、SQLite、source map 和密钥扩展名变体全部返回 `404`；首页、`/admin`、构建标记和 ready 正常。部署后数据审计 `issueCount=0`，用户/项目/文件/导出资产计数保持 5/10/26/4。
- Nginx 历史访问日志中仅发现本次诊断使用的单一出口与 `curl/8.7.1` 请求：修复前 3 次 `200`、修复后均为 `404`；当前没有其他来源下载这两个后端产物的日志证据。

**防复发规则**

- 后端可执行文件、source map、数据库、环境文件和密钥文件不得位于可无条件静态下载的命名空间。
- 生产安全回归必须以未登录公网请求验证敏感路径，而不能只检查文件权限或假定构建目录只含前端资产。
- 发现源码暴露时必须同时修复生成、应用静态边界和边缘代理，不能只依赖隐藏文件名或代码混淆。

---

## 2026-07-16 20:41:53 +08:00 编辑作用域、暂存、框选与导出状态恢复不完整

**现象**

- 用户选择某个子图内对象后，切换组件、字体、布局或配色中心仍需重复选择作用范围。
- 数值输入部分路径必须按 Enter/失焦才进入暂存；右侧列表 Ctrl 取消单个选择和画布框选存在不稳定状态。
- 图例符号放大后与文字易错位；散点统一改 size 会丢失原有相对比例；垂直间距操作容易误触整套布局重排。
- 导出资产只能下载，无法直接恢复到该次导出时的脚本和 Figure editLog；“保存全部 Figure”可能忽略其他 Figure 的未应用 Draft。
- 同一 collection 的多个颜色子集在传输压缩时可能互相覆盖。

**根因**

- 编辑中心各自保存作用域，未统一从当前选择解析 subplot；布局中心只识别直接选中的 subplot。
- V2 `PropertyControl` 的 number 控件仍在 blur 提交；`matchColor` 未完整进入 Draft key、类型、服务端压缩和 renderer 重放。
- 框选结束后的 click 抑制标记在浏览器不产生合成 click 时残留，吞掉下一次真实单击。
- 导出资产只记录 revision 锚点，没有不可变编辑快照；项目 gate 只统计在途任务，不能阻止导出与上传/删除并发。
- 初版回归误选页面第一个 Lucide 图标 SVG，并错误要求逻辑子图“选中全部”包含 twin axis，形成假失败。

**修复**

- 当前选择统一解析所属 subplot；组件、字体和布局中心自动跟随，配色中心继续使用选中对象投影，跨子图多选回退到全部。
- 有效数值输入立即进入 Draft；增加字体格式刷、图例布局参数、散点 `size_scale`、保持宽高的垂直行间距和稳定 Ctrl/Command 列表切换。
- 框选 click 抑制只保留当前事件循环；测试改为定位真实 Figure SVG，并按逻辑子图而非 twin 物理 Axes 验证。
- `matchColor` 贯穿前端 Draft、API、editLog 压缩和 Python renderer，同一 collection 可顺序重放多个颜色子集。
- 新导出资产与编辑快照原子保存；恢复校验账号、项目/Figure 结构、脚本风险和数据集精确成员/SHA-256，恢复前写 history 检查点。
- 导出改为项目级独占操作；上传和删除使用同一独占锁。“保存全部 Figure”检查项目全部 Draft。

**验证**

- TypeScript、生产构建、production bundle、41 个 Vitest 文件/250 项通过。
- Python 内省 48 项、R renderer 30 项、Python 语义 16/16、组件/布局 24/24、严格行为 15/15、扩展拖拽和 R 语义 7/7 通过。
- 导出快照 DB/API/UI 通过；实测同名额外数据拒绝、所有权、恢复检查点、在途 render draining、导出期间上传/删除阻断和旧资产兼容。

**防复发规则**

- 自动作用域必须由当前选择统一派生；新增编辑中心不得维护互不联动的默认目标。
- 所有导出入口必须阻止相关未应用 Draft；生成资产与恢复快照必须在同一事务中完成。
- 数据文件成员或内容变化时不得声称能精确恢复；多进程部署前必须把进程内项目锁升级为外部协调锁。
- 浏览器测试必须定位真实 Figure SVG；逻辑 subplot 与 twin/shared 物理 Axes 的计数不得混用。

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
- 通用 artist class 不能证明复杂图元来源；专用语义必须来自可信调用 provenance 或等强证据。
- 语义 kind 升级不得改变已持久化的 GID/stableKey/seriesKey，除非提供版本化迁移和旧项目回归。
- 新专用 kind 必须同步 renderer reader/editable、binding、schema、resolver、组件中心、配色和完整用户链路。
- local 属性与 backend 属性必须由 capability 决定；测试不得通过伪报 mode 把 local 路径冒充 renderer 重放。
- 专用对象不得开放会改变科学含义的数据参数，除非另有明确产品与审计门禁。

---

## 2026-07-19 04:59:37 +08:00 contour 属性无 Draft、子层绕过与旧项目身份兼容

**状态与级别**

- 状态：已修复并通过两套 Matplotlib、浏览器、跨 Figure、导出和旧项目专项回归；尚未提交、推送或部署。
- 级别：P0 编辑正确性。不会删除源数据，但可能让可用属性显示“无法绑定”、把编辑写到 contour 内部子层，或让旧项目在版本差异后误判身份漂移。

**现象**

- 组件中心能够显示 contour 的 `cmap/vmin/vmax`，但修改后不生成 Draft；`alpha` 等部分属性却正常。
- `contour/contourf` 在不同 Matplotlib 版本中可能表现为一个 `ContourSet` 或多个 collection，旧 editLog 的内部 GID 和 fingerprint 容易漂移。
- 虽然专用组件卡只展示 contour 父对象，用户仍可能从 SVG/图层选择子 collection，再通过普通批量属性入口生成新的子层 editLog。
- 项目级代码 patch 重绘曾丢失新返回的 manifest、codeSlice 和 fingerprint，后续编辑可能继续使用过期对象模型。

**根因**

- 组件意图把所有属性硬编码为 `crossFigure: allow`；严格 resolver 因此要求 `cross_figure` capability，并把只允许 object/group 的科学属性当作作用域不安全跳过。
- 旧批量能力回退只按 `kind=collection` 判断，没有优先尊重 `role=contour_child_collection`、`parentOwned` 和空 capability 列表。
- Matplotlib 3.7/3.8 的 contour 内部 artist 结构不同，不能把内部 collection class 或数量作为稳定产品身份。
- 代码重绘响应合并遗漏了新的 Figure 语义字段。

**修复**

- renderer 输出 `contour`/`contourf` 专用父对象、父子 relation、mappable/colorbar relation 和结构 v2 fingerprint；`levels/X/Y/Z/paths/segments` 保持只读。
- 新增按属性能力计算的跨 Figure 策略：只有全部目标明确声明 `cross_figure` 才允许 fanout，否则使用当前对象作用域。
- contour child 标记 `contour_child_collection` 与 `parentOwned`；组件、配色和普通批量面板都不再产生新的子层 patch，并向用户显示父对象托管说明。
- 旧 identity-bearing child editLog 仅在 stableKey/seriesKey 一致且差异只限 fingerprint 时兼容；其他身份漂移继续拒绝。
- 项目代码重绘保留 previewSvg、manifest、codeSlice 和 fingerprint；导出 warning 按目标 Figure 过滤。

**验证**

- Vitest 143 文件/923 项通过；Matplotlib 3.7.2 和 3.8.4 均为 Python 105/105。
- 组件中心 30/30、Python 完整用户链路、跨 Figure 11/11、语义中心 11/11 通过。
- SVG/PNG/PDF/TIFF、子图导出、快照恢复并发/文件事务和旧 contour 项目加载/PUT/history/export/restore 通过。
- R renderer 31/31、R 浏览器 5/5、R 安全预检、生产构建和仓库数据边界通过。
- `npm run data:audit`：25 用户、121 项目、263 文件、101 导出资产，完整性问题 0；23 条历史测试账号警告未清理。

**防复发规则**

- 入口不得因为“希望支持跨 Figure”就无条件声明 `allow`；必须由目标属性 capability 决定。
- 专用父对象的内部 child 只用于关系、渲染和旧历史兼容；现代 UI 不得生成新的 child editLog。
- 兼容 Matplotlib 版本差异只能放宽已证明会变化的字段，不得同时忽略 stableKey、seriesKey 或其他 identity 字段。
- 新复杂对象必须覆盖当前 Figure、跨 Figure、旧项目、四格式导出和快照恢复，不能只验证 renderer setter。

---

## 2026-07-19 04:59:37 +08:00 拖拽命中吸附错误、多选被覆盖与测试状态污染

**状态与级别**

- 状态：已修复并由真实 Ctrl 三选和完整拖拽浏览器门禁验证；尚未提交、推送或部署。
- 级别：P0 用户编辑正确性。错误可能把用户拖动线条的动作记到附近文字，或把上一个未确认文本与下一次 annotation 一起提交。

**现象**

- 拖拽模式点击明确的只读线条时，有时不显示“不支持拖拽”，反而进入附近文本的位置确认。
- Ctrl/Shift 连续选择多个文字后，选择可能退回单个对象，无法整体拖动。
- 一次错误命中的 pending 文本未清理时，下一次 annotation 拖动会把两个对象合并进同一 patch batch。
- 旧测试直接修改 `sessionStorage.selectedGids`，与每 Figure 选择缓存和自动保存竞争，既可能制造假失败，也无法证明真实用户操作。

**根因**

- 命中函数在已经找到有效但不可拖拽的 GID 后仍继续扫描附近文本，覆盖了更精确的事件目标。
- 修饰键分支先调用多选回调，随后又调用单选回调；快速连续操作时内部 `selectedGidsRef` 也没有同步更新。
- 测试场景先移动文字导致后续文字重叠，又使用整条折线包围框中心和会话注入，命中证据不可靠。

**修复**

- 已命中有效只读对象时立即保留该 GID，不再吸附附近文本；只有目标本身是已 pending 的可拖拽文字时才寻找下一个候选。
- Ctrl/Shift 分支只提交多选状态，并同步更新内部选择引用，不再调用会覆盖数组的单选回调。
- 浏览器回归改为在原始非重叠位置真实 Ctrl 点击三个文字，再整体拖动并确认；顺序拖拽、取消和只读命中作为后续独立场景。
- 折线只读用例从真实 SVG path 的 8% 位置取屏幕坐标，避免包围框中心被移动后的文字覆盖；R native fixture 增加状态安装验证重试。

**验证**

- `test:drag-extended-smoke` 10/10：Ctrl 三选生成 3 个 position patch；顺序拖动生成 2 个不同 GID；取消不请求 patch；只读线条仅提示；annotation 只提交自身；R native 不生成位置 patch。
- `test:component-container-smoke` 30/30、`test:semantic-smoke` 11/11、TypeScript、Vitest 和生产构建通过。

**防复发规则**

- SVG 事件目标已有有效 GID 时，几何邻近搜索不能覆盖更精确的命中结果。
- 多选回调与单选回调不得在同一修饰键操作中连续写同一状态。
- 拖拽测试必须通过真实指针/键盘操作并读取实际选择结果；禁止仅修改持久化状态冒充用户多选。
- 连续场景必须清理选择和 pending 状态，且点击点应落在真实绘制路径而不是大包围框中心。

---

## 2026-07-19 06:19:06 +08:00 跨 Figure 重放冲突、批量导出部分落库与 contour 子层多选

**状态与级别**

- 状态：已修复，新增失败回归后通过全部受影响门禁和独立复审；尚未提交、推送或部署。
- 级别：P0 状态一致性。错误不会删除源数据，但可能让项目级代码修改在其他 Figure 已过期时仍写入、让批量导出留下部分资产，或让 contour 子层的 Ctrl/Shift 多选被覆盖。

**现象**

- 从 `fig_1` 发起项目级代码 patch 时，renderer 可能报告 `fig_2` 的旧 editLog 无法重放；旧路径只核对当前请求的新 patch，未把其他 Figure 的 warning 当作整批冲突。
- 无 `figureId` 的全项目导出逐 Figure 渲染并立即保存；若 `fig_1` 成功、`fig_2` 出现 replay warning，接口返回 409 前已经留下 `fig_1` 资产和恢复快照。
- SVG contour child 已重定向到父对象，但开启拖拽微调后，非拖拽对象分支会用单选覆盖 Ctrl/Shift 选择；原测试只派发 `click`，没有覆盖 `pointerdown -> click` 顺序。

**根因**

- 项目代码 patch 的冲突检查没有按 Figure 遍历完整 effective editLog。
- 导出把 renderer 校验与资产持久化放在同一个逐 Figure 循环中，没有先完成全部目标的只读预检。
- 拖拽模式的不可拖拽命中分支没有复用 modifier toggle 语义，也没有抑制后续 click 的二次处理。

**修复**

- 新增按 Figure 收集 renderer replay conflict 的检查；任一 Figure 冲突时恢复内存 session 的 script/editLog/revision，并在任何项目、session、history、cache、export anchor 或 snapshot 写入前返回 conflict。
- 全项目导出拆成两阶段：先渲染并检查全部 target Figure；全部通过后才保存主图、子图资产和编辑快照。任一 replay warning 返回 `EXPORT_REPLAY_CONFLICT` 且零资产写入。
- contour child 点击统一重定向到父对象；拖拽模式下 Ctrl/Meta/Shift 对不可拖拽父对象使用同步 toggle，只更新多选，不调用单选回调，并抑制同一次 click 二次处理。
- 浏览器测试使用明确的 `pointerdown -> pointerup -> click` 序列覆盖拖拽模式，不再用单独 click 代替完整事件链。

**验证**

- `test:replay-warning-persistence` 通过：其他 Figure 的 stale edit 阻断项目代码 patch；单 Figure 和全项目导出冲突均不写资产或快照；持久化状态逐字段保持不变。
- `test:component-container-smoke` 31/31：普通点击和拖拽模式 modifier 点击都只选择 contour/contourf 父对象，两个父对象可同时保留。
- `test:export-matrix-smoke`、`test:python-semantic-workflow`、`test:drag-extended-smoke` 10/10、跨 Figure 11/11、R semantic 5/5 通过。
- TypeScript、Vitest 143 文件/923 项、两套升级验证环境 Python 105/105、生产构建、安全、用户隔离、renderer 沙箱和仓库边界通过。
- `npm run data:audit`：25 用户、121 项目、263 文件、101 导出资产，完整性问题 0；23 条历史测试账号警告保持不变。
- 最终独立 5.5 high 复审：PASS，HIGH/MEDIUM/LOW 均为 0。

**防复发规则**

- 项目级代码重绘必须按全部 Figure 的实际 editLog 检查 warning，不能只检查当前 Figure 或本次新增 patch。
- 批量导出在全部目标通过 renderer 重放检查前不得创建任何主图、子图资产或恢复快照。
- 同一 modifier 操作不得同时调用多选和单选写入；测试必须覆盖 pointerdown 与 click 的组合顺序。
- 生产 renderer 固定唯一镜像和精确依赖版本；旧 Matplotlib 环境只作为升级期历史项目兼容门禁，不作为长期多版本支持承诺。

---

## 2026-07-30 04:35:45 +08:00 V2 组件布尔控件缺口与跨 Figure 测试误点

**状态与级别**

- 状态：已修复并通过隔离浏览器回归；当前仅存在于生产集成候选，尚未部署。
- 级别：P1 编辑入口与验证可靠性。图例边框在 V2 组件中心没有控件；旧测试定位器还可能把刻度字号操作误点到标题字号。

**现象**

- 组件中心开启 V2 后，网格显隐和图例背景框测试不产生 Draft。
- 跨 Figure 字体回归报告生成 `title.0:fontsize`，而用户场景要求 `axis.x.*:tick_labelsize`。
- contour 跨 Figure 回归显示 `changed=false`，但 renderer 已输出正确的 contour/contourf 父对象能力。

**根因**

- 通用 `visible` descriptor 已存在，但 V2 开关把既有 DOM 角色从 `boolean` 改为 `toggle`；`frameon` 未注册到属性 descriptor。
- 字体测试按整个右侧栏祖先文本查找 `fontsize`，V2 下会命中第一个标题控件，没有使用 `data-font-group="xticks"` 与 canonical `data-property-control="fontsize"`。
- contour 测试只寻找旧版 `range` 透明度滑块，没有兼容 V2 的 number descriptor 控件。

**修复**

- 注册 `frameon` 布尔 descriptor，并恢复开关的 `data-param-role="boolean"` 兼容契约。
- 增加 grid `visible` 与 legend `frameon` 的 capability 投影单测。
- 跨 Figure 浏览器助手优先按 `data-font-group` 和 `data-property-control` 定位 V2 控件，同时保留旧控件回退；透明度助手同时支持 V2 number 和 legacy range。

**验证**

- `test:component-container-smoke`：35/35，通过网格 backend Draft、图例 `frameon`、等高线父对象和分组控件。
- `test:cross-figure-smoke`：11/11，刻度字号只写 `axis.x.*:tick_labelsize`，contour/contourf 只写父对象。
- `test:drag-extended-smoke`、`test:export-matrix-smoke`、TypeScript、Vitest 43 文件/284 项、Python renderer 63/63 均通过。

**防复发规则**

- 新旧控件并存期间，自动化必须以语义容器和 canonical control key 定位，不得依赖整个侧栏的祖先文本或控件出现顺序。
- descriptor 控件替换旧控件前，必须覆盖所有原有布尔属性，并保留稳定的测试与可访问性 DOM 契约。
- 测试出现 `changed=false` 时先证明目标控件是否被真实操作，不能把定位器失效误判为 resolver 或 renderer 失败。

---

## 2026-07-30 06:48:58 +08:00 生产集成冲突遗漏导致身份、分色与导出恢复回归

**状态与级别**

- 状态：已在生产集成候选中修复，定向 Python 身份、语义、保存预检、拒绝零持久化及导出快照恢复回归通过；尚未部署。
- 级别：P0 编辑与恢复正确性。错误可能阻断旧项目重放、扩大分色修改范围，或让导出/恢复丢失检查点内容。

**现象**

- 图例代理对象的派生坐标变化会触发 v2 fingerprint 漂移，正常旧项目编辑被拒绝。
- 带 `matchColor` 的 collection 分色修改可能被判为 local，无法由 renderer 精确修改向量颜色中的匹配子集。
- 项目中存在已失效的无关数据记录时，导出快照直接报错；放宽后恢复又会把该记录误判为导出后新增文件。
- 导出恢复并发测试只向同步渲染传入 backend 编辑子集，却要求恢复前检查点保留未传入的 local 编辑；该测试输入与同步渲染的完整 editLog 契约冲突。

**根因**

- cherry-pick 冲突处理遗漏了源提交中部分 `server.ts`、`App.tsx` 与 renderer 合并语义。
- `legend_marker` 的结构 fingerprint 错误包含图例布局派生坐标，而非只描述代理对象结构。
- local SVG/manifest 路径不具备按 `matchColor` 修改向量颜色子集的能力，服务端却仍允许客户端 mode 影响分流。
- 快照成员比较只按数据库记录 ID 判断，没有区分缺失存储文件的历史脏记录和真实新增文件。
- 测试把同步渲染请求误当成 backend 增量；实际该接口的 `editLogs[figureId]` 表示完整目标状态，省略属性需要继续承担撤销语义。

**修复**

- `legend_marker` v2 fingerprint 排除派生 handle 坐标；真实数据 series 仍保留数据形状与统计结构。
- 非空 `matchColor` 统一由服务端强制进入 backend renderer，不信任客户端伪报 mode。
- 导出快照跳过缺失文件并记录 `snapshotWarnings`；恢复仅把具有真实存储文件的未快照记录判为导出后新增。
- 保持同步渲染完整替换契约；并发恢复 fixture 改为传入全部恢复前编辑，使检查点断言与真实用户状态一致。

**验证**

- `tests/test_structural_identity_drift.py`：8/8。
- `test:semantic-smoke`：19/19；`test:project-save-preflight` 与 `test:patch-rejection-persistence` 通过。
- `test:export-snapshot-restore` 全通过，覆盖快照 warning、真实新增数据拒绝、恢复前检查点、并发锁、旧 v1 快照和预览重建。

**防复发规则**

- cherry-pick 共享主链路后必须逐项对照源提交的行为测试，不得以“冲突已解决”替代语义核验。
- 结构 fingerprint 不得包含图例布局等派生样式坐标；颜色子集编辑不得走无法表达子集语义的 local 路径。
- 缺失文件只能作为可审计 warning 被排除，真实新增或内容变化仍必须阻断精确恢复。
- 测试不得把完整状态接口当成增量接口；撤销必须能够通过省略已撤销项生成新的完整 editLog。

---

## 2026-07-20 08:41:21 +08:00 特殊轴关系缺失可经全渲染入口持久化

**状态与级别**

- 状态：已修复并通过失败回归与共享路由回归；修复后的最终独立复审因 sub2api 上游 503 尚未完成，尚未提交、推送或部署。
- 级别：P0 编辑状态正确性。不会删除源数据，但可能保存 renderer 未可靠确认的 editLog，或在拒绝项目重放时提前修改项目脚本。

**现象**

- `/api/figure/patch` 已对特殊轴 relation fail-closed，但 `/api/figure/render` 可以接收缺失 relation 的新 editLog，并在 renderer 返回 `success` 后直接写 session。
- renderer 为兼容历史日志，会允许 stableKey 可识别但缺失新 relation 的旧形态；因此只检查 renderer warnings 仍不足以区分客户端新日志和数据库已知旧日志。
- `/api/projects/:id/figures/render` 在重放全部 Figure editLog 前先更新项目脚本，且未用返回 manifest/warnings 阻断 rejected mixed batch，可能同时写入脚本、Figure、session 和 preview。
- 初版严格预检会误拒绝历史 contour child 的受限 alpha/zorder 重放，说明新门禁如果不复用既有兼容协议也会破坏旧项目。

**根因**

- patch 路由已有 manifest 权威预检，但 full render 路由仍把 `result.status === success` 当成可持久化证明。
- 特殊轴 relation 是 WP7 新增身份字段，旧 editLog 没有独立版本号；兼容与新请求不能仅靠字段是否缺失区分。
- 项目脚本更新与 Figure/session 替换不在同一后验证事务中。
- contour child 的历史兼容白名单此前只用于快照恢复，没有复用到 full render 返回 manifest 预检。

**修复**

- standalone full render 对压缩后的新 editLog 执行返回 manifest 权威预检，并对应检查 renderer conflict warning；冲突时返回 `RENDERER_EDIT_REPLAY_REJECTED`，不创建或修改 session。
- 只有与现有 session/project 数据库 editLog 语义相同且 stableKey 一致的条目才可走旧日志兼容；旧条目若已有 fingerprint 或 seriesKey，也必须分别一致。gid-only 历史日志继续阻断，客户端新增缺 relation 日志必须携带完整特殊轴身份。
- standalone 重渲染复用请求中的已归属 session，避免成功重放后生成重复 session。
- 项目 full render 在任何写入前按 Figure 检查返回 manifest 和 warnings；任一新条目冲突时脚本、Figure、session、history 和 preview 全部保持不变。
- `replaceProjectFiguresAndSessions` 增加可选项目更新参数，在同一 SQLite 事务提交项目脚本与 Figure/session。
- full render 预检复用既有 contour child 兼容白名单和 stableKey/seriesKey 约束，避免误伤已证明安全的旧 alpha/zorder 日志。

**验证**

- `test:special-axes-api`：standalone/project full render mixed batch 拒绝零持久化，旧 standalone editLog 可继续重放且不创建重复 session。
- `test:patch-rejection-persistence`：missing/unsupported/renderer rejected 和 mixed batch 门禁通过。
- `test:legacy-contour-project-compatibility`：旧 contour child 加载、PUT、history、导出和快照恢复通过。
- `test:project-history-persistence` 与 `test:r-semantic-smoke` 通过，证明共享事务和 R 项目渲染未回退。
- `test:special-axes-python`：10 项中 8 通过；Cartopy/brokenaxes 因固定环境未安装跳过并保持未验证状态。
- `npm run lint`、`npm run build`、`git diff --check` 通过；仅保留既有 bundle 体积和 CJS `import.meta` 警告。
- 修复后的 gpt-5.5 high 独立只读复审已多次发起，但 sub2api 返回 503；该门禁必须在本工作包提交前重新完成。

**防复发规则**

- full render 的 `success` 只表示脚本执行完成，不等于所有 editLog 已被当前 manifest 认可；任何写入前必须同时检查 manifest 和 renderer warning。
- 旧日志兼容必须以数据库已知记录或明确版本化协议为依据，并继续核验 stableKey 及条目已经携带的 fingerprint/seriesKey；gid-only 或客户端缺字段不能自动解释为 legacy。
- 项目脚本与其 Figure/session 重渲染结果必须原子提交；验证失败前不得更新项目行。
- 新身份字段必须覆盖 patch、full render、cache、history、导出和快照恢复全部入口，并新增旁路失败测试。
- 可选第三方包未安装时只能声明分类占位或只读降级，不能把 skipped test 写成支持证据。

---

## 2026-07-20 09:42:45 +08:00 RightSidebar 现代 capability 省略属性仍走 legacy fallback

**状态与级别**

- 状态：已修复并通过针对性单测、TypeScript 和数据审计；尚未提交、推送或部署。
- 级别：P1 编辑入口一致性。不会删除数据，但可能让现代 manifest 未声明的属性在组件/批量入口继续显示，并生成随后会被后端拒绝或需要 backend 验证的 patch，造成“控件看起来能改但应用失败”的体验。

**现象**

- `resolvePatchMode` 已经规定：现代对象只要存在 `propertyCapabilities` 数组，未声明属性就不再使用旧版 `editable` 猜测。
- `RightSidebar` 的 `supportsBatchProp` 在未找到声明 capability 后，仍用 `obj.editable.includes(prop)` 和按 kind 的启发式规则放行。
- 这会让前端控件可见性与 renderer 权威能力声明不一致，尤其影响组件中心/批量属性入口。

**根因**

- WP3 之前主要收敛 patch mode 生成路径，但右侧面板仍保留一处用于“控件是否显示”的旧启发式判断。
- 该判断没有区分现代 capability protocol 与旧 manifest 兼容路径。

**修复**

- 新增 `hasAuthoritativePropertyCapabilities`，把“对象是否进入现代 capability 协议”作为统一边界。
- `RightSidebar.supportsBatchProp` 在现代对象未声明目标属性时直接返回 false；只有旧 manifest 没有 `propertyCapabilities` 字段时才继续使用 legacy fallback。
- 旧项目兼容不变；R SVG 仍按既有 backend 路径处理。

**线上诊断备注**

- 用户提供的网页诊断 `3_render_diagnostic_2026-07-20T01-00-19-837Z.md` 中，项目 ID `d794390a-7be7-42c4-91ba-e3a0ea9d07a0` 的当前脚本是从 `fig, ax = plt.subplots(...)` 开始的代码片段，缺少导入、常量和数据加载，因此 `name 'plt' is not defined` 只是首个表面错误。
- 2026-07-20 只读 SSH 核验当前线上库 `/srv/scifigure/data/scifigure.db`：该旧项目 ID 不存在，项目目录也不存在；同名数据文件当前属于 `ad6c9cce-f007-43a0-bb98-e31cb6ae48b8`（`figure5（3）`），其 `projects.script` 和 session script 均包含 `import matplotlib.pyplot as plt`、`load_data()` 和完整 `build_figure(df)` 尾部。
- 因此旧诊断不能作为当前线上项目仍缺 `plt` 的证据；若再次出现同类错误，应先以当前项目 ID 只读核验数据库中的 `projects.script/spec.custom_script/project_figures.session_id/sessions.script`。

**验证**

- `npm test -- propertyPatchMode targetResolver editingIntentCompiler semanticPatchMapping`：25 个测试文件、437 项通过。
- `npm run lint`：通过。
- `npm run data:audit`：25 用户、121 项目、263 项目文件、101 导出资产，issue 0；23 条既有测试账号 warning 保持不变。

**防复发规则**

- 新协议对象存在 `propertyCapabilities` 数组时，前端控件显示、批量编辑、语义 resolver 和 patch mode 生成都必须以该数组为权威；未声明属性不得由 `editable` 或 kind 启发式放行。
- legacy fallback 只能用于没有 `propertyCapabilities` 字段的旧 manifest。
- 诊断文件中的项目 ID 必须与当前线上数据库和项目目录核对后再判断线上真实状态，不能用旧诊断覆盖当前事实。

---

## 2026-07-20 10:08:30 +08:00 线上 polar 雷达图因固定二维 spine 遍历崩溃

**状态与级别**

- 状态：线上已做最小热修并重建当前 renderer 镜像 `scifigure-renderer:e35f4a4-jd22`；本地当前分支已覆盖同类修复并通过隔离回归。
- 级别：P0 线上渲染可用性。不会删除数据，但会让极坐标/雷达图项目在 renderer 内省阶段失败，导致用户无法进入编辑上下文。

**现象**

- 用户线上项目 `未命名项目2`，项目 ID `f6e86a96-ba7b-4766-a175-5ab1150bafb7`，脚本为完整 Python polar radar 图。
- 线上 Docker renderer 报错：

```text
KeyError: 'left'
File "/opt/scifigure/renderer/introspector.py", line 330, in iter_artists
yield f"spine.{side}.{ax_idx}", "spine", ax.spines[side]
```

**根因**

- 极坐标轴的 `ax.spines` 通常只有 `polar`，没有普通二维轴的 `left/right/top/bottom`。
- 线上部署包仍按固定二维 spine 名称访问 `ax.spines['left']`，而不是按实际存在的 spine key 遍历。
- 第一处修复 `iter_artists` 后，线上继续暴露第二处同类入口：`_read_spine_group_props` 仍硬取 `ax.spines["left"]`，在 `_read_props(..., "spine_group")` 阶段再次崩溃。

**修复**

- 本地当前 `renderer/introspector.py` 已使用 `_ordered_spines(ax)`：先按 `left/right/top/bottom` 输出实际存在的二维 spine，再追加其他实际存在的 spine，例如 `polar`。
- 该修复属于 WP7 special axes 范围，避免把 polar 图当普通二维 subplot 处理。
- 本轮还补充项目级 patch 对完整 merged editLog 的返回 manifest 校验，防止同类 special-axes 不安全旧日志随新 patch 推进 revision/cache。
- 线上当前 release `/opt/scifigure/current` 以最小热修方式同步两处兼容：
  - `iter_artists` 不再固定访问 `ax.spines[side]`，改为先输出实际存在的普通二维 spine，再输出其他实际存在的 spine。
  - `_read_spine_group_props` 不再使用 `ax.spines["left"]` 作为样本，改为使用实际存在的第一个 spine；无 spine 时返回安全默认。
- 线上保留备份：
  - `/opt/scifigure/current/renderer/introspector.py.bak-20260720100106`
  - `/opt/scifigure/current/renderer/introspector.py.spinegroup-bak-20260720100641`

**验证**

- `npm run test:special-axes-api` 通过，包含 `polar_subplot.0` 完整 relation、polar line 可编辑、unsafe special-axes editLog 拒绝零持久化、snapshot restore 兼容等检查。
- `npm run lint` 通过。
- `npm run test:patch-rejection-persistence` 通过。
- 线上 rootless Docker 重建 `scifigure-renderer:e35f4a4-jd22` 后，真实 `introspector.py --payload-file` polar smoke 返回 `status=success`，manifest object count 为 29。
- 线上 `scifigure.service` 保持 `active`，HTTP 本地端口 `127.0.0.1:3101` 可返回首页；本轮未重启 Web 服务，未修改 `/srv/scifigure/data`。
- 2026-07-20 10:50:47 +08:00 复核：线上 `/opt/scifigure/current` 指向 `/opt/scifigure/releases/e35f4a4-jd22`；`SCIFIGURE_RENDERER_IMAGE=scifigure-renderer:e35f4a4-jd22`；rootless Docker 镜像内部 `_read_spine_group_props` 第 1117 行为 `spines = list(getattr(ax, "spines", {}).values())`，不再硬取 `ax.spines["left"]`；10:00 后 `journalctl -u scifigure` 未再出现 `KeyError: left` 或 `Docker renderer exited 1`，仅出现用户脚本安全预检 `Forbidden function call: globals`。

**防复发规则**

- renderer 遍历 Matplotlib 容器时不能假定所有 axes 都有普通二维对象；spine、axis、projection、layout 均必须按实际对象存在性检查。
- 线上诊断中的 renderer traceback 必须先判断是用户脚本执行失败还是平台 introspection 失败；发生在 `introspect_figure/iter_artists` 的异常优先视为平台兼容缺口。
- special axes 修复必须覆盖 artist 遍历和属性读取两个阶段，不能只修第一个 traceback。

---

## 2026-07-20 10:14:45 +08:00 服务端项目 patch 预检仍对现代 manifest 使用 legacy editable fallback

**状态与级别**

- 状态：已修复并通过隔离 API 回归、特殊 axes API 和 TypeScript；尚未提交、推送或完整部署。
- 级别：P0 编辑状态正确性。不会删除源数据，但可能让现代 manifest 未声明的属性通过服务端预检，并由 renderer 成功应用后写入 revision、session、project_figure、history 或导出锚点。

**现象**

- WP3 已规定：对象只要存在 `propertyCapabilities` 数组，未声明属性就不得再使用旧 `editable` 字段猜测可编辑性。
- 前端 `RightSidebar` 已修复该规则，但服务端 `precheckProjectFigurePatches` 仍在 `capability` 缺失时回退 `editable.includes(prop)`。
- 导出快照恢复 dry-run 的属性可重放检查也存在同类 fallback。

**根因**

- 早期兼容逻辑把 `editable` 作为旧 manifest 的兜底能力来源，但没有把“存在 `propertyCapabilities` 数组”作为现代协议边界。
- 前端控件显示和服务端持久化预检没有同时收敛，导致只修 UI 仍可能留下 API 侧绕过。

**修复**

- `precheckProjectFigurePatches` 增加 `hasAuthoritativeCapabilities = Array.isArray(object.propertyCapabilities)`；现代对象缺失目标 capability 时直接拒绝，只有旧 manifest 没有该字段时才使用 `editable.includes(prop)`。
- 导出快照恢复预检同步使用同一规则，避免恢复旧资产时把现代 manifest 未声明属性解释为 legacy 可重放。
- 新增回归：将存储 manifest 人为改成 `propertyCapabilities` 省略 `linewidth`、但旧 `editable` 仍包含 `linewidth`；提交 `linewidth` patch 必须返回 conflict，且 revision、session editLog 和 project_figure editLog 不变。

**验证**

- `npm run test:patch-rejection-persistence`：通过，新增检查项 `modern manifest omitted capability did not fall back to legacy editable on the server`。
- `npm run test:special-axes-api`：通过，确认 WP7/WP8 特殊轴和快照恢复门禁未被误伤。
- `npm run lint`：通过。
- `git diff --check`：通过，仅有既有 LF/CRLF 提示。

**防复发规则**

- `propertyCapabilities` 的存在本身就是现代能力协议标志；属性省略代表未声明/不可编辑，不是“回退旧猜测”。
- 任何新增前端 capability 规则，必须同步检查服务端 patch 预检、full render 预检、导出快照 dry-run 和历史恢复入口。
- `editable` fallback 只能用于没有 `propertyCapabilities` 字段的旧 manifest；不能用于现代对象、空 capability 数组或 capability 被 renderer 有意省略的属性。

---

## 2026-07-20 10:17:38 +08:00 配色中心 legacy binding fallback 可绕过现代 capability 省略

**状态与级别**

- 状态：已修复并通过配色/target/property 相关单元回归和 TypeScript；尚未提交、推送或部署。
- 级别：P1 配色入口一致性。不会删除数据，但可能让现代 manifest 中 renderer 未声明的颜色属性通过配色中心生成对象 patch，造成“显示能改但后端拒绝”或错误 patch mode。

**现象**

- `paletteTargetResolver` 在 binding 协议不完整或进入 legacy strategy 时，会用 `binding.props` 与 `object.editable`、`kind === "line"`、`facecolor/color` 猜测配色属性。
- 现代对象即使存在 `propertyCapabilities: []` 或省略某个颜色属性，也可能被旧 `editable` 或 kind 启发式选为配色目标。

**根因**

- 配色中心的 fallback 早于 WP3 capability 协议，只区分 binding 是否完整，没有把“对象已进入现代 propertyCapabilities 协议”作为属性选择边界。
- 严格路径已使用 binding target 的显式 prop，但 legacy binding fallback 仍可能在组合图、旧 binding 或颜色扫描不完整时被调用。

**修复**

- 新增 `colorPropSupportedByObject`：现代对象只接受 `propertyCapabilities` 中声明且 `replay !== "unsupported"` 的颜色属性；旧 manifest 才使用 `editable` 兜底。
- `fallbackProp` 找不到可证明颜色属性时返回 `null`。
- `legacyResolution` 对无可证明 prop 的目标跳过，并记录 `unsupported_prop`，不再生成对象 patch。

**验证**

- `npm test -- paletteTargetResolver propertyPatchMode targetResolver semanticPatchMapping editingIntentCompiler`：25 文件、438 项通过。
- 新增测试：现代 line 对象保留 `editable: ["color"]` 但 `propertyCapabilities: []` 时，legacy palette binding 不产生 target，也不生成 object patch。
- `npm run lint`：通过。

**防复发规则**

- 配色中心不能把颜色相似、对象 kind 或旧 `editable` 当作现代能力证明。
- binding 协议不完整时可以降级为 legacy strategy，但每个对象属性仍必须遵守对象自己的 capability 边界。
- 组合图和旧 binding 的便利 fallback 只能跳过不可信对象，不能为了“尽量改上”而生成不可证明 patch。

---

## 2026-07-20 11:02:23 +08:00 无标签 collection 交换顺序后可静默改错散点组

**状态与级别**

- 状态：已修复并通过 renderer 结构身份、复杂对象、特殊轴、patch 拒绝持久化和数据审计回归；尚未推送或部署。
- 级别：P0 编辑状态正确性。不会删除源数据，但可能让带身份 metadata 的旧 `collection.*` 补丁在两个无标签 scatter/PathCollection 交换顺序后打到另一组点上。

**现象**

- 两个无标签 `ax.scatter(...)` 生成 `collection.0.0` 和 `collection.0.1`。
- 用户保存针对 `collection.0.1` 的 size/color 等样式 editLog 后，如果脚本把两个 scatter 调用顺序交换，旧 `collection.0.1` GID 会指向另一组点。
- 修复前 `stableKey=ax0.collection.idx.1` 和 fingerprint 都仍按索引通过，renderer 无 warning，并把补丁静默应用到错误散点组。

**根因**

- 无标签 collection 的 `stableKey` 为兼容旧项目保留了 `idx.N`。
- v2 fingerprint 只包含 `stableKey` 和 artist class，没有纳入 collection 的数据 offsets 结构，因此无法区分两个无标签 scatter 的数据身份。
- 旧弱 fingerprint 在同一 axes 存在多个 collection 时没有歧义门禁。

**修复**

- `renderer/introspector.py` 的 collection v2 fingerprint 增加 offsets 结构签名：shape、有限值 mean/min/max 和前若干 offsets 预览。
- 颜色、size、linewidth、alpha 等可编辑样式不进入 fingerprint，避免正常样式修改导致身份漂移。
- 保留旧 `stableKey`，避免破坏 GID/seriesKey 基础兼容。
- 旧弱 collection fingerprint 只在当前 axes 没有多个 collection sibling 时兼容；存在多个 sibling 时拒绝，返回 `identity_mismatch`，不再冒险按索引应用。

**验证**

- `python -m unittest tests.test_structural_identity_drift -v`：10/10 通过，新增无标签 collection reorder 拒绝、style edit fingerprint 稳定、单 collection 旧弱 fingerprint 可读三项。
- `python -m unittest tests.test_complex_artist_coverage -v`：26/26 通过。
- `python -m unittest tests.test_special_axes_coverage -v`：10 项中 8 通过、2 项因未安装 `brokenaxes`/`cartopy` 跳过。
- `python -m py_compile renderer/introspector.py tests/test_structural_identity_drift.py`：通过。
- `npm run test:patch-rejection-persistence`：通过，确认 renderer 拒绝不会写 revision、session、project figure、history、cache、export anchor 或 snapshot。
- `npm run data:audit`：25 用户、121 项目、263 项目文件、101 导出资产、0 issue，23 条既有测试账号 warning。
- `git diff --check`：通过，仅有既有 LF/CRLF 提示。

**防复发规则**

- 无标签对象不能只靠数组索引证明身份；collection 必须包含数据结构指纹或明确语义关系。
- 可编辑样式不得进入结构 fingerprint；数据 offsets、artist class 和受保护关系可以进入。
- 旧弱身份只能在没有同类 sibling 歧义时兼容；存在多个候选时必须 fail-closed，而不是按旧索引继续应用。

---

## 2026-07-20 18:19:18 +08:00 RightSidebar 直接读取 sessionStorage 绕过 Figure 状态边界

**状态与级别**

- 状态：当前工作区已移除该读取边界；静态检查和 WP5 隔离浏览器 smoke 通过。相关工作区变更尚未提交、推送或部署。
- 级别：P1 编辑状态一致性。该问题可能让 RightSidebar 绕过 App 提供的当前 Figure、选择和 Draft，上下文在 Figure 切换、恢复或异步保存时可能与页面状态不一致。

**现象**

- RightSidebar 曾直接从 `sessionStorage` 取得 Figure/编辑上下文，组件可以在不经过其 props 的情况下决定当前状态。
- 这种读取把浏览器持久化实现当成组件输入，无法保证与当前 `figSession`、`activeFigureId`、选择和 `projectDrafts` 同步。

**修复**

- 当前 RightSidebar 只从 `figSession`、`activeFigureId`、选择和 Draft props 获取 Figure/编辑状态，并由 `normalizeFigureModel()` 生成当前能力模型。
- 2026-07-20 静态检查确认 `src/components/RightSidebar.tsx` 不含 `sessionStorage` 调用；组件中保留的 `localStorage` 仅用于用户预设，不参与 Figure、选择或 Draft 的状态判定。

**验证**

- `rg -n 'sessionStorage|localStorage' src/components/RightSidebar.tsx`：未发现 `sessionStorage`；仅命中预设读写的 `localStorage`。
- `npm run test:capability-report-smoke`：通过，真实 UI 覆盖部分可编辑、无可识别对象和已识别但只读状态。该 smoke 在页面初始化前写入隔离 fixture，但不把此测试辅助写入当作 RightSidebar 的状态读取路径。

**防复发规则**

- RightSidebar 不得直接读取 `sessionStorage` 来决定当前 Figure、选择、Draft 或编辑能力；新增状态必须通过 props 或现有状态容器显式注入。
- 浏览器测试可在启动前写入隔离 `sessionStorage` fixture，但验证用户操作时必须走实际控件和 props 驱动更新，不能用存储注入伪造已完成的交互。
- 修改 RightSidebar 状态来源时，必须复查组件内 `sessionStorage` 使用并覆盖 Figure 切换、Draft 和能力摘要的隔离回归。

---

## 2026-07-20 20:03:22 +08:00 渲染诊断在缓存命中和项目重开后丢失

**状态与级别**

- 状态：当前工作区已修复，定向 API smoke 通过；尚未提交、推送或部署。
- 级别：P1 可诊断性与恢复一致性。图形本身仍可显示，但缓存命中或项目重开后丢失确定性/布局警告，会让同一 revision 在不同入口展示不同风险信息。

**现象与首次失败**

- renderer 实时响应包含 `determinismWarnings`、`layoutWarnings` 和 `layoutDiagnosticsMs`。
- 首版实现只在当前响应中归一化这些字段；写入 render cache 和 `project_figures.manifest` 时仍保存未附加诊断的 manifest。
- 新增 smoke 首次运行暴露：重复 backend patch 可以命中 cache，但 cache hit 响应没有重放 `random` 警告；随后读取项目 preview 时也可能找不到 `manifest.renderDiagnostics`。

**根因与修复**

- cache、session/project Figure 持久化和 HTTP 响应此前分别组装 manifest，没有共享同一个诊断归一化边界。
- 新增 `renderDiagnosticsFrom()` 与 `withRenderDiagnostics()`，在响应、cache 写入和项目 Figure 持久化前统一附加经过结构过滤的诊断。
- StandardFigureModel、manifest schema 和项目重开归一化继续读取同一个 `renderDiagnostics`，诊断异常保持非阻断，不影响成功渲染或编辑提交。

**验证与防复发**

- `npm run test:render-diagnostics-cache`：首次 patch 为 cache miss；重置后相同 patch 为 cache hit，仍包含 `random` 确定性警告和布局诊断耗时；项目 preview 重开继续保留相同诊断。
- cache 命中不能只证明 SVG/manifest 可复用，还必须证明当前用户可见诊断随同缓存值传播。
- 新增 renderer 响应字段时，必须同时检查实时响应、cache hit、session/project 持久化和项目重开四条路径。

---

## 2026-07-20 20:03:22 +08:00 编辑 V2 默认启用缺少统一开关合同

**状态与级别**

- 状态：当前工作区已收敛为统一开关模块并完成定向及阶段回归；尚未提交、推送或部署。
- 级别：P1 发布与回滚风险。多个入口各自读取环境变量时，可能出现字体中心走 V2、配色或跨 Figure 仍走旧规则的混合版本，也难以在重大回归时只回退受影响能力域。

**修复**

- 新增 `editingFeatureFlags.ts`，统一普通编辑、字体、组件、配色、跨 Figure identity、旧 manifest compiler adapter、弱 score adapter 和 Shadow 证据的默认值。
- 五个 V2 能力域默认启用并可独立设为 `0`；旧 manifest compiler adapter 默认保留，弱跨 Figure score adapter 默认关闭。
- 关闭旧 manifest adapter 后，协议不完整的目标保守跳过并给出 warning，不回退到猜测编译器。
- Shadow 证据使用独立、版本化 localStorage envelope，最多 500 条，只记录目标 metadata 和补丁键，不保存用户操作值。

**验证与防复发**

- `npm run test:wp10-default-enable`：覆盖默认值、逐域回退、旧 manifest adapter、弱 score adapter、严格跳过和 Shadow 持久化。
- 语义中心 14/14、组件中心 41/41、跨 Figure 18/18 以及完整 Python/R 共享门禁通过。
- 后续新增编辑入口不得直接读取 `import.meta.env` 决定 resolver 路径，必须复用统一开关合同。
- 重大错误优先回退对应能力域；整版 release 回退只用于共享主链路、构建或数据协议级故障。

---

## 2026-07-20 20:36:26 +08:00 Python WP9/WP10 最终审查发现 same-GID 绕过与多 Figure 诊断串写

**状态与级别**

- 状态：首轮及修复后复审发现的问题已全部关闭；完整候选门禁通过，最终独立复审 APPROVE、0 HIGH/MEDIUM，尚未提交、推送或部署。
- 级别：P0/P1。same-GID 绕过可能把跨 Figure 修改静默应用到不同系列；诊断串写不会改图，但会让 Figure A 显示 Figure B 的裁切风险；构建时开关若被描述为即时开关，会造成错误回退预期。

**问题与修复**

- 跨 Figure 映射原先先接受同 GID、同 role/kind/subplot，再执行 V2 identity resolver。现在现代非专用 relation 对象要求 source 的 `instanceKey/stableKey/seriesKey/semanticKey` 全部在 target 中存在且一致；任一缺失或冲突直接 skip，即使 weak score adapter 开启也不继续猜测。旧 manifest 仍走受控兼容路径。
- 多 Figure renderer 结果缺少单 Figure `layoutWarnings` 时，原实现会回退 aggregate `result.layoutWarnings`。现在三条项目持久化/预览路径只取目标 Figure 自身警告、其 manifest 已存诊断或空数组；两 Figure smoke 覆盖 cache hit、缓存重开和强制预览重开。
- `VITE_*` 开关由 Vite 在构建时固化。逐域回退明确为“同一提交 + 修改构建变量 + 重建 + 新 release”；紧急重大故障使用上一不可变 release 整版回退，不再宣称修改运行环境变量即可即时切换。
- NumPy 模块别名和死分支 seed 已加入确定性诊断；用户能力报告不再直接显示 renderer 内部 `unsupportedNotes/reason`，统一转换为用户级限制说明。

**验证与防复发**

- `npm run test:wp10-default-enable`：167/167。
- `npm test -- src/utils/semanticPatchMapping.test.ts src/utils/standardFigureModel.test.ts`：138/138。
- `npm run test:cross-figure-smoke`：18/18。
- `npm run test:wp9-release-gate`：11/11。
- `npm run test:render-diagnostics-cache`、`npm run test:capability-report-smoke`、`npm run lint`：通过。
- 同 GID 不能作为现代跨 Figure 身份证明；稳定凭据冲突必须优先于 weak score fail-closed。
- 新增聚合 renderer 字段时必须证明单 Figure 响应、缓存和项目重开不会跨 Figure 污染。
- 文档中的 feature flag 必须标明 build-time 或 runtime，不能把构建时变量描述为无需重建的即时开关。

**修复后独立审查补充（2026-07-20 21:53:58 +08:00）**

- 首轮修复后复审继续发现：非同 GID identity remap 会先按单个 `instanceKey` 命中，其他稳定凭据冲突时仍可能错改；严格过滤后还可能被 legacy score 再次猜回。
- 当前 remap 允许 `instanceKey` 随 GID 改变，但 source 声明的 `stableKey/seriesKey/semanticKey` 必须在 target 中存在且一致；任一冲突返回显式 `conflict`，禁止进入 weak score。
- Shadow diagnostics 现在只加载和报告当前 `releaseCandidateId` 的记录，回退、重建或新候选不会把旧 release 证据计入当前总数。
- 新增失败回归覆盖“instanceKey 相同但 stableKey/seriesKey 冲突”“非同 GID 稳定凭据一致仍可合法映射”和“旧 release Shadow 记录不被加载”。
- 第二次复审继续发现 `App.tsx` 的跨 Figure Draft role 编译仍直接调用 legacy compiler；当前已改用与 RightSidebar 相同的受控 resolver 和 general/legacy-adapter 开关合同，并增加 WP10 源码守卫。
- 修复后 `npm test` 为 150 文件、1144/1144，WP10 167/167、跨 Figure 18/18、lint、build、diff-check 和数据审计全部通过。
- 最终独立 gpt-5.5 high 只读复审：APPROVE，0 HIGH/MEDIUM；审查代理未独立重跑测试，其结论与本地新鲜测试证据共同构成候选门禁。

**补充验证（2026-07-20 21:12:16 +08:00）**

- `test:component-container-smoke`：PASS=41，FAIL=0；覆盖组件父子关系、网格、图例边框、容器颜色、colorbar、保存刷新和多选撤销。
- `test:drag-extended-smoke`：10/10；覆盖真实 Ctrl 多选、累计拖拽、取消、只读命中、annotation 和 R native 坐标保护。
- `test:cache-smoke`、`test:project-history-persistence`、`test:export-snapshot-restore`、`test:export-file-transaction`、`test:security-baseline`、`test:user-isolation`、`test:renderer-sandbox`：全部通过。
- `npm run build`、`git diff --check` 和 `npm run data:audit`：通过；构建仅保留既有 bundle/CJS `import.meta` 警告，数据审计为 25 用户、121 项目、263 文件、101 导出资产、0 issue、23 条既有测试账号 warning。
- 防复发回归：以后发布前必须先固定候选提交，再执行不可变 release；重大故障整版切回上一 release，不从脏工作区或单独修改运行时变量回退。

---

## 2026-07-21 15:21:24 +08:00 旧项目完整重渲染误拒绝与文本立即应用竞态

**状态与级别**

- 状态：当前本地候选已修复并通过定向 API、真实浏览器和共享 R 回归；尚未推送或部署。
- 级别：P0/P1。误拒绝会让原本可编辑的旧项目统一显示“编辑记录未通过当前 Figure 身份或 renderer 重放确认”；文本竞态会表现为“立即应用没有反应”、必须手动同步，或旧请求返回后覆盖用户刚输入的新内容。

**根因**

- 项目完整重渲染只从 session 读取旧 editLog。部分旧项目的 durable editLog 位于 `project_figures` 或受控单 Figure 旧 spec 中，session 缺失时 renderer 实际应用了编辑，但服务端预检使用了错误的“已知日志”来源。
- 空文本和隐藏对象重放后可能从新 manifest 消失，旧轴字体又使用 `fontweight/fontsize/fontfamily/color/fontstyle` 名称；通用预检把这些已持久化旧条目分别报成 `missing_gid` 和 `unsupported_prop`。
- Matplotlib SVG 经常把文本输出为 glyph path 组，本地替换 `textContent` 不是可信预览；立即应用又在 renderer 成功前清理 Draft。
- RightSidebar 的对象代理会用 Draft 覆盖 `currentProps`。如果把代理值当成已提交值，按钮会误判“没有变化”；Figure revision 更新还会清空组件本地输入，覆盖请求期间的新文本。

**修复**

- 完整重渲染复用统一的 durable editLog 解析，并在 renderer 返回后使用同一已知日志执行兼容预检。
- 空文本/隐藏对象和旧轴字体只允许数据库中已经存在且值、`stableKey`、fingerprint 版本/值和 identity 完全一致的条目继续重放。两轮独立审查发现的伪造 disappearing identity 和弱化 axis identity 均已 fail-closed。
- 文本统一使用 backend renderer；输入时立即写当前 Figure Draft，比较是否已应用时只读取原始 manifest，不读取 Draft proxy。
- 与原始 manifest 相同的 no-op Draft 在 App Draft 入口删除；成功请求只清除提交时快照仍一致的 Draft，请求期间的新输入保留。

**验证与防复发**

- `npm run test:special-axes-api`：通过；覆盖 durable fallback、伪造 line identity、伪造 disappearing identity、弱化 axis font identity，以及所有拒绝请求的完整 persistence state 不变。
- `npm run test:python-semantic-workflow`：通过；B0E 证明立即应用真实 renderer 写回，B0G 证明改回已提交值删除 no-op Draft，B0F 证明旧请求完成时保留更新文本；批量应用、刷新、撤销/重做、导出和快照恢复继续通过。
- `npm test -- src/components/RightSidebar.test.ts src/utils/propertyPatchMode.test.ts`：242/242；`npm run test:r-semantic-smoke`：5/5；`npm run test:patch-rejection-persistence`、`npm run lint`、`npm run build` 和 `git diff --check`：通过。
- `npm run data:audit`：25 用户、121 项目、263 文件、103 导出资产、0 issue；测试未访问 3000 或真实项目。
- 以后新增 legacy 兼容例外时，必须同时证明“只接受 durable known entry”“客户端不能弱化身份”“拒绝后完整 persistence state 不变”，不能只比较 `gid/prop/value`。
- 文本和其他可异步重绘控件必须区分原始 manifest、项目 Draft 与 renderer 已提交状态，并覆盖请求期间继续编辑的竞态。

---

## 2026-07-30 11:21:35 +08:00 连续组件编辑丢失可信 manifest，且旧 Figure 绑定校验不完整

**状态与级别**

- 状态：已修复；隔离 API、组件矩阵、TypeScript 和真实浏览器 `45/45` 门禁通过；尚未部署。
- 级别：P0 编辑状态正确性。可能让第二次正常编辑被拒绝，或让损坏的同用户 Figure 绑定指向错误会话；不会跨用户读取数据。

**现象与根因**

- Python `local_patch` 持久化后调用旧 preview invalidation，同时清空 manifest、codeSlice 和 fingerprint；下一次编辑因缺少可信 manifest 被拒绝。
- 客户端声明的 patch mode 可能与服务端 manifest 能力不一致，前端又用请求前预测决定是否安装 renderer SVG。
- 显式 `projectId/figureId` 查到的 `project_figures` 行未再次校验其 `session_id`，损坏或错误绑定可能映射到同用户另一 Figure。
- 直方图语义父容器没有单一 SVG 节点，且浏览器把 `#339966` 规范化为 `rgb(51, 153, 102)`；旧浏览器断言因此误报视觉更新失败。

**修复**

- local patch 只清空过期 `preview_svg`，保留 codeSlice/fingerprint，并用 patch 更新 manifest `currentProps`；旧 manifest 缺失时强制 backend renderer 重建并核验。
- 服务端依据可信 manifest 归一化 mode，前端依据响应中的 authoritative `applied[].mode` 安装 local 或 backend 结果。
- stale project revision、请求 Figure 身份不一致和存储 session binding 不一致均 fail-closed，revision/session/history/cache/导出状态零写入。
- bar/histogram 等父容器能力统一声明 `backend_patch`；浏览器门禁检查其真实子 SVG 节点，并按 CSS 颜色语义归一化比较。
- Draft apply 增加同 Figure 防重入和 renderer 期间禁用，settlement 按内容清理成功草稿并保留失败项。

**验证**

- `npm run test:local-patch-manifest-recovery`：通过，覆盖连续 local patch、缺失 manifest 恢复、错误存储绑定、身份不一致和 stale revision 零写入。
- `npm run test:component-kind-matrix`：通过，20 类组件连续重放；直方图响应 SVG 的全部子柱均命中目标颜色。
- `npm run test:component-container-smoke`：`45/45 PASS`，覆盖即时 DOM、保存刷新、分组选择、布局、网格、图例和散点比例。
- 生产集成门禁同步更新旧拒绝测试：纯 local patch 应清除过期 `preview_svg/preview_updated_at`，但必须保留并更新 manifest、codeSlice 和 fingerprint；旧断言“同时清空 manifest”已删除。
- `npm run lint`、3 个新增/修改 Node 测试的 `node --check`、focused histogram unittest 和 `git diff --check` 均通过。

**防复发规则**

- local preview 失效不能删除仍可信的结构 manifest、codeSlice 或 fingerprint。
- mode、Figure identity 和 revision 以服务端持久化状态为权威；无法证明时必须 backend 验证或拒绝。
- 语义父容器的视觉断言必须检查其 renderer 声明的真实子图元，不能假设父对象一定有 SVG 节点。
- 浏览器颜色验证必须比较规范化 CSS 色值，不能直接比较十六进制与 `rgb(...)` 字符串。

---

## 2026-07-21 19:02:40 +08:00 旧项目 `line.visible` 阻断、组合图蓝色漏绑定与散点比例假回读

**状态与级别**

- 状态：当前本地候选已修复并通过定向单元、隔离 API 和真实浏览器门禁；尚未提交、推送或部署。
- 级别：P0 旧项目可用性 + P1 组合图作用域与状态回读。

**根因**

- Python renderer 已成功重放 42 条历史 `line.visible=true`，但新 manifest 不再声明 line `visible` capability；Node 二次预检因此把已保存旧记录误判为 `unsupported_prop`，进而阻断整个项目。
- 旧编辑的导出快照签名仅覆盖 contour child；若只修打开流程，`line.visible` 仍会在快照恢复时失败。
- 子图 scoped 配色一旦命中任意可 object-patch 的精确目标（通常是图例）就提前返回，同一 binding 中 `code_only` 的红蓝 mixed collection 不会进入按实际颜色子集 fallback，表现为蓝色只能选图例。
- 第一次 scoped 改色后，脚本颜色常量仍是旧值，但 renderer manifest 已是新值；第二次若继续按静态常量匹配，会再次丢掉 mixed collection。
- mixed collection 的 `matchColor` 此前在转成 Draft 时被丢弃；服务端 editLog 压缩又只按 `gid+prop` 去重，不同颜色子集及同一颜色的连续变换会互相覆盖。
- `size_scale` 已正确放大 marker area 并保留逐点比例，但 `_read_collection_props` 始终返回 `1.0`，导致重渲染后控件看似没有应用。
- Matplotlib SVG 中普通子图背景是 `axes.patch.N`；点击映射只处理特殊 axes，未映射普通 `subplot.N`。日志另外只藏在底部面板，用户检查错误需要改变布局。

**修复**

- 旧 `line.visible` 仅在 patch 与数据库 durable editLog 的 `gid/prop/value/identity` 完全一致，且当前对象仍是 line 时受控放行；未保存新值继续冲突。
- 当前导出快照升级为 schema v5，并为已保存旧 `line.visible` 生成包含 `stableKey/fingerprint/identity` 的 replay signature；签名机制加入前的 v4 仍按严格 `line + visible + boolean` 边界恢复，v5 缺少精确签名则拒绝。v1-v4 继续可读，不要求真实旧五字段 editLog 凭空具备新身份字段。
- 新增 scoped palette resolver：合并可重放的精确目标与子图内 rendered-color fallback；mixed collection 生成 `matchColor` backend patch；identity/series/duplicate 风险仍 fail closed。
- 连续 scoped 配色从当前 manifest 的精确标量目标推导有效颜色；即使脚本常量仍是旧蓝色，第二次也会用第一次重放后的蓝色匹配 mixed collection。
- collection-only 场景通过已持久化的 `matchColor -> value` 链解析当前颜色；Draft 以 `gid+prop+matchColor` 独立存储，服务端压缩保留不同颜色子集和连续颜色链。普通旧 Draft 仍使用原 `gid:prop` 键，不要求迁移。
- `axes.patch.N` 反向映射到普通 `subplot.N`；`size_scale` 应用后回读 renderer 保存的实际绝对比例，`size` 绝对设置会重置该比例。
- Word 真实预览旁新增日志弹窗，保留原底部日志页签和诊断导出能力。

**验证与防复发**

- `npm run test:special-axes-api`：旧 `line.visible=false` 打开、继续编辑、导出、后续编辑、签名 v5 恢复、无签名 v4 恢复和刷新通过；无签名 v5、未保存的相反值均冲突且完整 persistence state 不变。
- 快照、palette、Draft、editLog compression、保存并发和 identity 定向 Vitest：19 文件、189/189；真实浏览器 `test:subplot-scope-follow` 以“静态常量旧蓝色、manifest 已是新蓝色”连续提交两次 scoped 改色，直接核对两次 API 请求的 collection `matchColor` 依次为当前颜色；普通 axes 背景选中对应子图，日志弹窗支持 Escape 关闭并返回焦点。
- `npm run test:legacy-contour-project-compatibility`：当前 v5 继续拒绝未签名 contour child，真实旧 contour editLog 的保存、导出和恢复没有回退。
- Python `size_scale` 定向单测通过；`test:semantic-smoke` 14/14，8 个 scatter collection 在 API 持久 manifest 和页面控件中均回读 `1.5`。
- 新增 Gate L：后续协议升级必须用 durable 旧记录走完打开、继续编辑、历史、导出、恢复和拒绝零写入；不得只跑新项目 fixture。

**修复后独立审查补充（2026-07-21 21:05:56 +08:00）**

- 独立复审发现条件配色日志具有顺序依赖：若按 `gid + prop + matchColor` 只保留末值，`蓝 -> 青 -> 绿` 后追加一个对旧蓝色的无效修改时，压缩重放可能错误变成紫色。
- 当前仅压缩不带 `matchColor` 的普通属性；所有条件颜色子集编辑保持原始顺序完整重放。Draft 等价比较同时按 storage key 规则对 `matchColor` 执行 trim 和小写归一化，避免同一颜色因大小写差异残留为无法清除的 Draft。
- 防复发回归加入“后续编辑依赖前一颜色输出”和“旧源颜色的末尾 stale edit”序列；定向 Vitest 46/46、`test:subplot-scope-follow`、`test:special-axes-api` 均通过。本地 3000 已重启到该实现，HTTP 200 且 stderr 为空。
- 后续不得把 conditional patch 当作普通 last-write-wins 属性压缩；任何压缩优化必须先证明与原始顺序重放语义等价。

---

## 2026-07-21 21:33:30 +08:00 Browser MCP 默认信任全部 localhost 端口

**状态与级别**

- 状态：独立安全审查发现后已修复，定向安全与真实 UI smoke 通过；尚未推送或部署。
- 级别：P0 安全边界。浏览器 MCP 具备读取可见页面文字和截图的能力，不能把“本机地址”直接等同于“SciFigure 服务”。

**根因与修复**

- URL 校验曾默认允许 `localhost`、`127.0.0.1` 和 `::1` 的任意端口。提示注入或错误工具调用可据此打开其他本地管理页、数据库 UI 或调试端口并读取可见内容。
- 当前删除 hostname 级默认信任；包括本机服务在内，所有目标必须精确匹配 `SCIFIGURE_URL` 或 `SCIFIGURE_MCP_ALLOWED_ORIGINS` 中声明的 origin。重定向、HTTP 子资源、blob 和 WebSocket 继续复用同一精确边界。
- `SciFigureBrowserSession` 支持测试显式注入 origin 集合，隔离测试不再依赖宽泛 localhost 例外。

**验证与防复发**

- `test:scifigure-browser-mcp-security` 4/4：明确允许的本机端口通过，相邻未声明端口、远程 origin、跨 origin blob、重定向和子资源均拒绝。
- `test:scifigure-browser-mcp-ui`：真实 UI 的选择、修改、应用、撤销、重做、截图和 SVG 导出继续通过；`npm run lint` 通过。
- 后续浏览器工具不得基于 localhost、私网 IP 或域名后缀隐式扩权；每个可访问 origin、输入目录和输出目录都必须由调用方显式声明并有拒绝回归。

---

## 2026-07-21 22:46:34 +08:00 R patch 信任客户端 mode、失败后仍持久化与项目导出误用 Python renderer

**状态与级别**

- 状态：R-WP1 本地修复完成，定向 API、renderer、真实浏览器和安全门禁通过；等待独立审查和本地提交，未推送、未部署。
- 级别：P0 数据一致性与旧项目可用性。失败 patch 可能增加 revision 或进入 editLog；项目级 R 导出会返回空的伪成功，无法形成可恢复快照。

**根因**

- `/api/figure/patch` 的 R 分支跳过服务端 mode 归一化和可信 manifest 预检，并在构造新 editLog 时丢弃 `stableKey/fingerprint/identity`。
- R cache hit 直接写 session/revision，cache miss 只要 renderer 返回 success 就持久化；缺少 returned manifest 和逐 patch acknowledgement 复核。
- 项目 R patch 只同步 revision/editLog，没有原子更新 preview SVG/manifest；standalone R full render 又没有把请求 editLog 传给 renderer。
- 项目级导出无条件调用 Python introspector。R 渲染失败后循环跳过目标，接口仍返回 `status=success, figures=[]`，因此没有资产或编辑快照。

**修复**

- 所有语言先由可信 `propertyCapabilities` 计算实际 mode；无 manifest 的 standalone 强制 backend 验证。R 新 editLog 保留完整身份字段。
- R renderer 返回 `applied/skipped/warnings/conflict`；missing、unsupported、identity mismatch、setter 未确认和 renderer warning 均视为未应用事实。
- R cache 只读取当前进程已验证的 key，并在命中后再次核对 manifest。成功项目 patch 在同一事务中更新 session、Figure revision、SVG、manifest 与 fingerprint；失败批次不写任何 durable state。
- 项目导出按 session language 路由。R 使用 R renderer，并在创建资产/快照前复核完整 editLog；R renderer error 返回错误，不再产生空伪成功。

**验证与防复发**

- `npm run test:r-patch-authority`：合法 standalone/project fake-local 被改为 backend；合法 mixed batch 一次 revision；missing、unsupported、identity mismatch、setter 未确认和 valid+invalid mixed batch 原子拒绝；既有 session/Figure/history/preview/cache/export asset/snapshot 均不变。
- R 项目 SVG/PNG 导出在测试中真实返回 `assetId` 且 `hasEditingSnapshot=true`；PNG 同时返回二进制，禁止悄悄回退为 SVG。
- R renderer 32 个正向测试通过；一个旧 group ordinal 漂移仍为 R-WP2 expected failure。`test:r-semantic-smoke` 6/6、R 安全预检、lint 和 diff-check 通过。
- 后续任何 renderer 新入口必须先形成结构化应用确认，再写 revision、history、cache 或导出快照；“renderer 进程成功退出”不等于 patch 已应用。
- 旧 manifest 兼容只能使用已保存的 stable/series/relation 证据；身份变化时 fail-closed，不能为了兼容恢复 ordinal 猜测。

**独立审查与浏览器复测补充（2026-07-21 23:09:30 +08:00）**

- 首轮独立审查发现项目 R PNG/PDF/TIFF 会静默保存 SVG，以及服务端只看 `conflict/warnings`、没有逐项核对 renderer `applied/skipped`。当前非 SVG 必须先通过 `svg_convert.py`，失败在任何资产/快照写入前返回错误；patch、完整 render、项目 render、standalone export 和项目 export 均要求每个发送的 R patch 出现在 `applied`，任何 skipped 或缺失确认都拒绝。
- 修复后真实浏览器暴露 mixed editLog 类型问题：R `simplifyVector=TRUE` 会因同一 value 列同时含数值和颜色字符串，把历史数值 `3.3` 转为字符串，服务端遂把已应用旧 patch 误判为 acknowledgement 缺失。当前 data payload 保持原解析，只有 editLog 使用 `simplifyVector=FALSE`，数值、布尔、列表和嵌套 identity 类型不再被整列强制转换。
- 新增语义 group 配色持久化和 PNG 二进制导出回归；`test:r-patch-authority` 10 个场景、`test:r-semantic-smoke` 6/6 通过。修复后独立复审 APPROVE，0 HIGH/MEDIUM。
