# R-WP0 基线、隔离与旧版兼容证据

> 状态：本地候选完成，等待独立审查与本地提交  
> 基线提交：`c29e93d`  
> 证据时间：2026-07-21 22:06:41 +08:00  
> 产品行为：未修改 R renderer、前端协议、数据库 schema 或运行服务  
> 部署状态：未推送、未部署

> 后续状态（2026-07-22 09:24:42 +08:00）：R-WP2 当前完整 renderer 为 51/51，已关闭本文件冻结的 ordinal group 漂移 `expectedFailure`，并补齐 layer subset、无键文本和 guide identity 漂移门禁。旧 fixture 继续原样保留；本文件仍作为升级前基线，不改写历史测试数量。

## 1. 兼容合同

R 后续升级必须同时保护新能力和旧项目，不能把“当前新 fixture 可编辑”当成兼容证据。

- `tests/fixtures/r_editing_baseline/legacy_identity_v1.json` 冻结于 R fingerprint v2 之前，包含无 `fingerprintVersion/fingerprint` 的 R group identity 和已持久化 editLog。
- 该 fixture 是静态升级前证据，后续测试不得在新 renderer 下动态生成后再冒充旧记录。
- R-WP2 引入 v2 后，新 manifest 使用严格结构身份；旧无版本记录只核对现有 `semanticKey/seriesKey/relation` 等可证明字段，不比较旧样式 fingerprint。
- 旧记录第一次成功重渲染可返回新 manifest，但不得批量改写真实数据库，也不得在 renderer 尚未确认时提前迁移。
- 多候选、group/scale/facet 关系冲突或身份缺失时必须拒绝，不能退回 ordinal、颜色距离或 SVG 几何猜测。
- 每次修改 manifest、identity、propertyCapabilities、patch、history 或 snapshot 协议，都要用这份静态旧记录继续证明：打开、继续编辑、刷新、撤销/重做、导出和恢复可用；拒绝路径持久化变化为 0。

当前 WP0 已证明 renderer 级静态旧 editLog 在身份未变化时可重放，同时固化了一个 `expectedFailure`：分组语义变化但 ordinal GID 相同时，当前 R renderer 仍会误应用旧颜色。该测试是 R-WP2 的阻断门禁；修复后必须移除 `expectedFailure` 并真实通过。完整项目事务、历史和快照生命周期属于 R-WP1/R-WP2，尚未在 WP0 宣称完成。

## 2. 本机运行时清单

| 项目 | 当前实测值 | 说明 |
|---|---|---|
| Rscript | `C:\Users\SZC\.conda\envs\Machine-learning\Scripts\Rscript.exe` | 测试通过显式 resolver 使用，不依赖 3000 |
| R | 4.1.3 | 当前本机基线，不等于生产镜像承诺 |
| ggplot2 | 3.4.2 | 当前语义 fixture 基线 |
| svglite | 2.1.3 | 当前 SVG device |
| jsonlite | 1.8.8 | payload/结果协议依赖 |
| systemfonts | 1.1.0 | 字体枚举依赖 |
| ragg/readr/readxl | 未安装 | 当前 fixture 不得把这些包描述为稳定可用 |
| Cairo capability | false | 当前不以 Cairo 输出作为本机基准 |
| Locale | Simplified Chinese / CP936 | Unicode 数据桥已有专项测试 |
| Timezone | Asia/Taipei | 不作为图形身份字段 |
| 可发现字体 | Times New Roman、Microsoft YaHei、SimHei、Arial | 生产仍需独立核验字体文件与 fallback |

`Dockerfile.renderer` 当前使用 `python:3.12-slim`、未精确固定的 apt R 包以及 Noto CJK/FreeFont。它与本机 R 4.1.3 环境不一致；该差异记录为 R-WP3 阻断项，WP0 不修改 Docker，也不宣称本地/生产像素一致。

## 3. 可执行 fixture 矩阵

`tests/fixtures/capability_matrix/r/` 当前包含 15 个纯合成 fixture：

| 能力族 | fixture / 证据 |
|---|---|
| 默认离散 color 散点 | `default_discrete_scatter.R` |
| 手动 color scale + legend | `manual_scale_legend.R` |
| 手动 fill + 分组柱图 | `manual_fill_grouped_col.R` |
| line/path + 多 group | `grouped_line_path.R` |
| errorbar/linerange | `errorbar_linerange.R` |
| facet_wrap 2 x 2 | `facet_2x2.R` |
| facet_grid 2 x 2 | `facet_grid.R` |
| tile/raster + continuous colorbar | `heatmap_colorbar.R`、`raster_colorbar.R` |
| geom_text/geom_label/annotate | `annotation_text.R`、`geom_text_label.R` |
| coord_flip | `coord_flip.R` |
| X/Y log | `log_scale.R` |
| coord_polar | `coord_polar.R` |
| base R 预览边界 | `base_r_preview.R`，断言 SVG 非空且 semantic objects 为空、限制类型明确 |

`tests/test_r_renderer.py` 继续覆盖 patch 写回、默认/手动 scale、重复颜色 fail-closed、legend、box/violin、facet、colorbar 对齐、坐标反变换、上传 CSV JSON bridge、网格和性能分段。新增 legacy fixture 测试明确断言冻结对象没有 fingerprint 版本，并按旧 identity 重放已持久化颜色编辑。

## 4. 测试隔离

| 入口 | 隔离状态 |
|---|---|
| R renderer unit | 只创建 OS 临时 payload；不启动服务，不访问真实项目 |
| capability matrix | 只读取仓库合成 fixture；禁止数据读取函数、uploaded paths、数据库路径和仓库 `data/` |
| R security precheck | 自建临时根、临时 data、临时 DB 和三个系统分配端口；production/staging guard 同样隔离 |
| R semantic browser | 强制 isolated wrapper、`127.0.0.1` 随机非 3000 端口、临时 data/DB；直接运行会 fail-closed |
| renderer sandbox | 已补临时 data/DB，但属于 Docker gate；WP0 按边界未运行 |

自动化没有打开真实用户项目。真实项目只允许在发布候选阶段做人工只读抽样：记录项目 ID 和 revision，先复制数据库备份或使用导出快照，执行打开、无修改重绘、单项编辑、撤销、刷新和导出比对；不得把真实项目复制成自动化 fixture。

## 5. 已知限制

- base R 和任意 grid 输出当前只支持预览/导出，不支持 artist 级编辑。
- 未知 ggplot geom 明确 readonly；不得通过通用 layer 属性假装专用语义已支持。
- 重复离散颜色无法唯一映射时 group 不可从 SVG 点击猜测，但 layer 仍可按已声明能力编辑。
- `ggnewscale` 重命名 aesthetic 只报告限制，不自动合并 scale。
- 圆外 polar 文本位置拒绝；`coord_sf`、ggrepel 和第三方 grob 仍未开放。
- R runtime/包/字体/locale 与生产镜像尚未固定一致，属于 R-WP3。
- R patch acknowledgement、零错误持久化和完整旧项目事务仍属于 R-WP1/R-WP2，WP0 不扩大完成结论。

## 6. 新鲜证据

| 命令 | 结果 |
|---|---|
| `node scripts/testing/run_pinned_python_unittest.mjs tests.test_r_renderer` | 32 个既有/正向测试 PASS；1 个 legacy 分组漂移为明确 `expectedFailure`，作为 R-WP2 阻断项 |
| `npm run test:capability-matrix` | Python/R 2/2 PASS；R 15 个 fixture 全部通过 |
| `npm run test:r-semantic-smoke` | 6/6 PASS；字体、组件、分组配色、Draft/apply 和 SVG 导出 editLog 一致 |
| `npm run test:r-security-precheck` | PASS；路径注入、生产 local renderer、命令/动态执行阻断和正常包加载 |
| `git diff --check` | PASS，仅既有 LF/CRLF 提示 |
| `npm run data:audit` | 25 用户、121 项目、263 文件、105 导出资产、0 issue；23 条既有测试账号 warning |

本工作包未访问或停止 3000，未操作 Docker/WSL/sub2api，未访问线上服务，未写入真实 `data/`。
