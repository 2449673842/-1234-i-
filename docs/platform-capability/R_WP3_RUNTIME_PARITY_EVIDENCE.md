# R-WP3 运行时、依赖与视觉一致性证据

> 状态：本地候选完成，独立复审 APPROVE，0 HIGH/MEDIUM
> 最后修改时间：2026-07-22 20:34:28 +08:00
> 部署状态：未推送、未部署；未访问线上服务，未停止或替换本机 3000

## 1. 本轮结论

R 本地 renderer、直接 Docker renderer 和 Web/API 到 Docker renderer 现在使用同一份脚本与数据执行语义核验。37 个关键语义对象、关键文字、手动颜色和 SVG 根几何在三条路径中一致。该结论证明当前 fixture 的语义与画布一致，不把局部 parity 扩大解释为任意 R 脚本的像素级一致。

本地开发路径继续使用显式发现的绝对 `Rscript`，并通过 `--vanilla`、每请求独立 HOME/TMP/工作目录、UTC 和清理门禁隔离。生产候选 Docker/Web 的权威运行时固定为 R 4.5.0、ggplot2 3.5.1、jsonlite 1.9.1、readxl 1.4.5、svglite 2.1.3、systemfonts 1.2.1 和 textshaping 0.3.7。本地 R 版本会进入 inventory，但不伪装成与生产候选版本相同。

## 2. 可重复构建合同

- 基础镜像固定为 DaoCloud 的 Python 3.12 slim digest；Debian 包和 PyPI 使用阿里云镜像。
- Python 运行时固定为 3.12.13，Matplotlib 3.11.1、NumPy 2.5.1、pandas 3.0.3；完整传递依赖由 `requirements.renderer.lock` 和 `--require-hashes --only-binary=:all:` 锁定。
- Python lock SHA-256 为 `0633f3c17e123431076d7618469ecbe2d9fcdc8e910de3ad738bacaf6e0319d8`。
- `renderer/r_renderer.R` SHA-256 为 `4d927ec00fb2788209e4773da86b707683c8c4d1b0d5c840d311fe8bc0ae7ae5`。Docker 构建时核对源码，镜像写入 `org.scifigure.renderer.r-source-sha256` 标签；服务端首个 R Docker 请求会核对标签，不匹配时以 `renderer_image_stale` 结构化诊断 fail closed。
- `.gitattributes` 将两个哈希绑定文件固定为 LF，避免 Windows `core.autocrlf` 在重新检出后改变字节并造成伪 SHA 漂移；镜像合同同时核对实际 lock SHA、R 源码 SHA 和行尾规则。
- 保留已验证的 `ttf-mscorefonts-installer` 路径以提供真实 Times New Roman，同时固定安装 Liberation、Noto CJK 和 FreeFont 作为回退。镜像构建和 runtime inventory 必须验证 `Times New Roman` 解析到实际微软字体，不能只显示该名称后使用 Liberation Serif。

## 3. 文件、诊断与可重放性

- 本地和 Docker staging 均保留相对子目录，并为镜像文件加序号前缀；不同目录下的同名 CSV 不再互相覆盖。parity fixture 同时读取两个同名文件并验证 `3 / 30` 的独立结果。
- CSV/TSV 与 XLS/XLSX 继续走各自 parser；本工作包没有把表格格式混为一种读取路径。
- R renderer 返回 runtime inventory、locale、字体、包版本、执行路径、诊断和分段 timing。`LC_COLLATE=C`，字符类型继续使用容器 UTF-8 locale。
- 语法错误、缺包、缺数据、缺字体、超时和普通运行错误保持结构化分类。普通未知函数不会被误报为缺包，普通 `subscript out of bounds` 不会被误报为缺数据。
- 未设置 seed 的随机函数和时间/外部状态调用只生成 determinism warning；平台不自动改写用户脚本。显式 `set.seed()` 的 fixture 不产生随机性告警。
- Docker Web renderer 保持禁网、只读根文件系统、低权限用户和资源限制；测试结束后没有受管容器泄漏。

## 4. 新鲜证据

| 命令 | 结果 |
|---|---|
| `npm run test:r-runtime-parity` | PASS；37 个语义对象，本地/直接 Docker/Web Docker parity，同名文件隔离，stale image fail closed，无临时容器泄漏 |
| `node scripts/testing/run_pinned_python_unittest.mjs tests.test_r_renderer` | 54/54 PASS |
| `npm run test:r-identity-v2-compatibility` | PASS；旧 manifest/editLog、remap、刷新、导出和快照恢复继续兼容 |
| `npm run test:r-runtime-consistency` | PASS；绝对 Rscript、`--vanilla`、独立目录、UTC、可重放告警、结构化超时和清理 |
| `node scripts/testing/run_pinned_python_unittest.mjs tests.test_r_runtime_diagnostics` | 6/6 PASS |
| `npm run test:r-renderer-image-contract` | PASS；固定 digest、版本、字体、lock/source SHA 和镜像标签合同完整 |
| `npm run lint` | PASS |
| `git diff --check` | PASS，仅工作区 LF/CRLF 提示 |
| `npm run data:audit` | 25 用户、125 项目、283 项目文件、111 导出资产、0 issue；23 条既有测试账号 warning |

首轮独立审查发现四项阻断：本地同名文件覆盖、Docker tag 可能陈旧、微软字体包隐含外部下载、Python 只固定直接依赖。当前分别由目录保留与序号镜像、镜像源码标签核验、真实 Times New Roman 构建/运行时校验及运维例外记录、完整传递依赖哈希锁处理。字体来源仍不是完全可重复供应链，后续若有授权明确的校验制品应替换该例外；当前产品字体能力不以 Liberation Serif 冒充。

数据审计计数相对 R-WP3 开始时有并发增长；本轮 API 和浏览器测试均使用随机端口、临时数据库与临时数据目录，Docker 只清理本轮受管容器，因此这些自动化没有回滚或改写真实数据。

## 5. 下一门禁

下一工作包为 R-WP4。一次只开放一个常用 ggplot2 图元家族，按 fixture、renderer identity/relation、propertyCapabilities、resolver、Draft/backend replay、浏览器选择、保存刷新、undo/redo、导出和快照恢复的顺序推进。R-WP3 的运行时、镜像源码标签、字体和文件隔离合同成为不可回退基线。
