# R-WP2 结构身份 v2 与旧项目兼容证据

> 状态：本地候选完成，独立复审 APPROVE，0 HIGH/MEDIUM
> 证据时间：2026-07-22 20:34:28 +08:00
> 部署状态：未推送、未部署
> 数据边界：自动化使用随机非 3000 端口、临时数据库和临时数据目录；未停止本机 3000、Docker、WSL 或既有容器

## 1. 本轮结论

R manifest 现在为 layer、group、panel/facet、scale、guide、tick 和 text 输出结构 identity、`stableKey`、纯结构 `fingerprint` 与 `fingerprintVersion=2`。fingerprint 使用单行规范 JSON 的 base64 表示，不包含颜色、线宽、字号、透明度、字体或其他可编辑样式。

结构键覆盖：

- layer 的 geom/stat/position、继承后的有效 aesthetic mapping，以及规范化数据内容摘要；同列名但不同 subset/filter 不再视为同一 layer；
- group 的 aesthetic、canonical group key、scale key 和 guide key；
- facet panel、subplot 和 tick 的统一 facet fallback key；
- scale/guide 的 aesthetic mapping、scale class、guide type、guide 标题和 group key；
- text 的显式稳定数据键，或由 `panel + x + y + label` 唯一派生的结构键，以及冻结的原始 layer key。重复且无法唯一识别的文本明确为 `unsupported`。

样式 patch 不改变身份。代码重排、目标前插入 layer、factor level 重排、facet panel 重排和并行 guide 重排可在唯一候选存在时重映射；结构漂移、missing 和多候选在应用前返回冲突，不按 ordinal、当前颜色或 SVG 距离猜测。

## 2. 旧 manifest/editLog 兼容

- 冻结 fixture `legacy_identity_v1.json` 仍不包含 `fingerprintVersion/fingerprint`，没有在新 renderer 下动态伪造旧记录。
- 旧记录只比较其原有 `semanticKey/seriesKey/relation` 字段；新 manifest 可以增加 `scaleKey/guideKey`，但所有旧字段必须保持一致。
- factor 顺序变化后，旧 group GID 可按 `groupKey` 唯一重映射；group 语义变化时拒绝，原 WP0 `expectedFailure` 已转为真实 PASS。
- 第一次成功重渲染返回 v2 manifest，不批量改写真实数据库。
- standalone/project patch、render cache、导出和快照恢复均执行独立身份核验；拒绝不会增加 revision 或写 session、Figure、history、preview、cache、export anchor 或 snapshot。
- renderer 唯一 remap 时返回的 `resolvedGid` 会出现在 API acknowledgement 中；持久化继续使用规范 editLog，不把响应辅助字段写入 session、项目或快照。

## 3. 新增回归

`tests/test_r_renderer.py` 新增或扩展以下场景：

- fingerprint 单行、可解码、只含结构字段，样式编辑前后稳定；
- 旧 fixture 正常重放、语义漂移拒绝、factor 重排唯一 remap；
- 目标前插入 layer、重复 layer 多候选拒绝、全局 `aes()` 科学变量变化拒绝；
- color/fill 合并图例去重、scale 顺序稳定、guide 标题/类型隔离，并行 guide 重排后只改正确图例文字；
- facet/tick 重排按 facet key 找回目标；
- layer subset 内容漂移、全局 mapping 漂移和重复候选均在应用前拒绝；
- text 稳定数据键和唯一派生结构键可跨代码行重排，并冻结原始 layer identity；单行内容漂移拒绝，重复无键文本不开放 replay。

`tests/api/r_identity_v2_compatibility_smoke.mjs` 使用隔离项目验证：旧身份第一次编辑、刷新、第二次编辑、导出快照、篡改快照拒绝、恢复导出时状态、missing/unsupported/语义漂移零写入、standalone 重复 layer 的 v2 多候选拒绝，以及 remap `resolvedGid` 只出现在响应、不污染持久 editLog。

## 4. 新鲜证据

| 命令 | 结果 |
|---|---|
| `node scripts/testing/run_pinned_python_unittest.mjs tests.test_r_renderer` | 51/51 PASS；legacy ordinal、layer subset、无键文本和 guide identity 回归全部关闭 |
| `npm run test:r-identity-v2-compatibility` | PASS；旧记录编辑、刷新、导出、快照恢复和拒绝零写入 |
| `npm run test:r-patch-authority` | PASS；10 个服务端权威与事务场景 |
| `npm run test:r-semantic-smoke` | 6/6 PASS；字体、组件、配色、Draft/apply 和导出状态一致 |
| `npm run test:capability-matrix` | Python/R 2/2 PASS |
| `npm test` | 204 个测试文件、1661/1661 PASS；Node 原生 MCP 测试从 Vitest 发现范围排除后由专用命令执行 |
| `npm run test:scifigure-browser-mcp-security` | 4/4 PASS |
| `npm run test:python-semantic-workflow` | PASS；即时文字、批量 Draft、导出和快照恢复 |
| `npm run test:semantic-smoke` | 14/14 PASS |
| `npm run test:component-container-smoke` | 41/41 PASS |
| `npm run test:drag-extended-smoke` | 10/10 PASS |
| `npm run test:cross-figure-smoke` | 18/18 PASS |
| `npm run test:patch-rejection-persistence` | PASS |
| `npm run test:export-snapshot-restore` | PASS |
| `npm run test:project-history-persistence` | PASS |
| `npm run test:export-snapshot-db` | PASS |
| `npm run test:cache-smoke` | PASS |
| `npm run test:r-security-precheck` | PASS |
| `npm run test:security-baseline` / `npm run test:user-isolation` | PASS |
| `npm run lint` | PASS |
| `npm run build` | PASS；仅保留既有 bundle 体积和 CJS `import.meta` 警告 |
| `git diff --check` | PASS；仅工作区 LF/CRLF 提示 |
| `npm run data:audit` | 25 用户、122 项目、266 文件、107 导出资产、0 issue；23 条既有测试账号 warning |

## 5. 同轮基线修复

完整共享门禁发现并关闭两个与 R identity 无关、但会使基线不可信的问题：

- 文字内容 patch 已按现有安全规则强制走 `backend_patch`，旧单元断言仍期待 `local_patch`；断言已与当前权威行为对齐。
- 两个 Node 原生 browser MCP 安全测试被 Vitest 误收集为“无测试套件”；`npm test` 现在排除该目录，专用 `node --test` 入口继续执行 4/4。

## 6. 剩余边界

- 当前 base64 fingerprint 仍有 manifest 体积与编码 CPU 成本，记录到后续性能工作包；R-WP2 不临时引入未固定版本和校验值的 digest 依赖。
- 本机 R 只作为显式 inventory 与语义 parity 路径；生产候选 R/包/字体/locale/设备固定、同名文件隔离和源码 SHA 门禁已由 R-WP3 关闭，见 `R_WP3_RUNTIME_PARITY_EVIDENCE.md`。
- `ggrepel`、`ggnewscale`、`coord_sf`、第三方 grob 和 base R artist 编辑仍按现有 readonly/unsupported 边界，不因 identity v2 自动开放。

## 7. 独立审查轨迹

首轮独立审查发现一个 HIGH 和两个 MEDIUM：layer 数据作用域只比较列名、无稳定键文本仍可能按 ordinal 静默重放、API 丢失 renderer `resolvedGid`。随后定向回归又暴露同 mapping 不同 guide 标题可能合并。四项均已按 fail-closed 原则修复。2026-07-22 20:34:28 的最终独立复审覆盖 R-WP2/WP3 共 32 个暂存文件，结论为 APPROVE、0 HIGH/MEDIUM，并确认未夹带 Python `renderViewport`、拖放或布局代码。
