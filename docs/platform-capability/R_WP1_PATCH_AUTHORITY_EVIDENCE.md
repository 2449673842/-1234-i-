# R-WP1 Patch 权威与零错误持久化证据

> 状态：本地候选完成，独立复审 APPROVE
> 最后修改时间：2026-07-21 23:13:21 +08:00
> 部署状态：未推送、未部署；未访问或停止本机 3000

> 后续状态（2026-07-22 09:24:42 +08:00）：R-WP2 已完成结构 fingerprint v2 和旧无版本兼容，WP1 留下的 group ordinal 漂移阻断已关闭。renderer remap 的 `resolvedGid` 现在由 API 返回，但不会污染持久 editLog。最新证据见 `R_WP2_IDENTITY_V2_EVIDENCE.md`；本文件保留 WP1 当时的事务证据，不回写其历史测试数量。

## 1. 本轮结论

R patch 不再信任客户端声明的 `local_patch/backend_patch`。服务端从当前可信 manifest 的 `propertyCapabilities` 计算实际 mode；没有可信 manifest 的 standalone 会话一律进入 R backend renderer 验证。

R renderer 现在返回结构化 `applied/skipped/warnings/conflict`。missing gid、unsupported property、identity mismatch、setter 未确认、renderer error 或 mixed batch 中任一失败都会使整批修改保持未应用，不增加 revision，也不写 session、项目 Figure、history、preview、render cache、导出资产或导出快照。

合法项目 patch 在同一个数据库事务内更新 session editLog/revision 以及项目 Figure 的 SVG、manifest、fingerprint 和 revision。R cache 只有在当前进程已完成 manifest 复核后才可命中；旧版本留下的 cache 不会被直接信任。

项目级 R 导出不再误送 Python introspector。它使用 R renderer，并在创建资产和编辑快照前重新核验完整 editLog。R 渲染失败不再返回空的伪成功结果。

## 2. 旧版兼容边界

- 现有不带 fingerprint 的 R editLog 继续可读；本工作包没有批量迁移或改写真实项目。
- 已携带 `semanticKey/seriesKey` 的旧记录会与当前 manifest 比较；身份不一致时拒绝，不能按相同 ordinal GID 静默改到另一组。
- 旧记录正常重放和结构漂移后的安全拒绝由 R-WP2 继续收敛。WP0 冻结的 group ordinal 漂移测试仍为一个明确 `expectedFailure`，因此本文件不宣称 identity v2 已完成。
- 客户端伪报 local 不是用户错误：合法属性由服务端改为 backend 并成功；只有目标或身份无法证明时才拒绝。

## 3. 隔离回归

`tests/api/r_patch_authority_persistence_smoke.mjs` 强制使用 `127.0.0.1` 随机非 3000 端口、临时 `SCIFIGURE_DATA_DIR` 和临时 `SCIFIGURE_DB_PATH`。它覆盖：

- standalone R 客户端伪报 local，服务端改为 backend 后成功；
- 项目 R 客户端伪报 local，原子更新 SVG/manifest 和一次 revision；
- 合法 local/backend mixed batch 只形成一次 revision；
- missing gid、unsupported property、identity mismatch；
- capability 合法但 renderer setter 未确认；
- valid + rejected mixed batch 整批拒绝；
- 拒绝前后 session、Figure、history、preview、render cache、既有导出资产及编辑快照完全一致；
- 项目 R 导出真实创建 `hasEditingSnapshot=true` 的资产。
- 项目 R PNG 导出真实返回二进制，并以 PNG 格式创建编辑快照；转换失败时不创建资产。

## 4. 新鲜证据

| 命令 | 结果 |
|---|---|
| `npm run test:r-patch-authority` | PASS；10 个权威/事务场景，含语义 group 配色 acknowledgement，SVG/PNG 导出资产和快照非空 |
| `node scripts/testing/run_pinned_python_unittest.mjs tests.test_r_renderer` | 32 个正向测试 PASS；1 个 WP2 legacy identity 漂移为明确 expected failure |
| `npm run test:r-semantic-smoke` | 6/6 PASS；字体、组件、配色、Draft/apply 和 SVG 导出状态一致 |
| `npm run test:r-security-precheck` | PASS |
| `npm run lint` | PASS |
| `git diff --check` | PASS，仅工作区既有 LF/CRLF 提示 |
| `npm run data:audit` | 25 用户、122 项目、266 文件、107 导出资产、0 issue；23 条既有测试账号 warning |

独立 gpt-5.5 high 首轮审查发现两个 MEDIUM：非 SVG 项目导出会静默回退 SVG，以及服务端没有正向核对 `applied/skipped`。修复后复审确认两个问题均关闭，最终 APPROVE、0 HIGH/MEDIUM。真实浏览器复测还发现 mixed 数值+颜色 editLog 会被 R 的简化 JSON 解析整列转成字符串；editLog 现改用不简化解析保留原始类型，R semantic smoke 恢复 6/6。

真实 `data/` 计数相对 WP0 开始时有并发增长；全部新增自动化均强制临时 data/DB 和随机非 3000 端口，因此没有回滚或改写这些用户侧变化。

## 5. 下一门禁

R-WP2 必须给 R layer/group/panel/scale/guide/text 增加纯结构 fingerprint v2，并为旧无版本 manifest 提供不依赖 ordinal 的兼容核验。只有移除 WP0 的 `expectedFailure`，并完成旧项目打开、继续编辑、刷新、导出和快照恢复，才可以宣称旧 identity 兼容完成。
