# SciFigure 安全、部署与运维副文档

> 状态：当前有效  
> 更新时间：2026-07-14 09:55:23 +08:00
> 复核范围：当前本地工作区；尚未等同于已提交发布版本  
> 适用范围：用户账号、数据保护、代码执行、Docker、备份、管理员能力和生产上线

## 1. 安全目标

SciFigure 接收用户数据并执行 Python/R 绘图代码，最高风险不是普通页面样式问题，而是：

```text
用户代码读取服务器敏感文件
用户代码联网外传数据
路径穿越和符号链接逃逸
跨用户项目越权
管理员接口被滥用
渲染、上传和导出耗尽资源
备份不可恢复
用户数据进入 Git 或 Docker 构建上下文
```

安全设计采用纵深防御。静态扫描只能做预检，最终边界必须由认证、所有权、文件边界、沙箱、禁网、低权限和资源限制共同构成。

## 2. 用户数据红线

```text
不得删除、覆盖或自动迁移本地 data/
不得清空数据库
不得使用测试数据替换真实项目
不得在无备份时执行破坏性迁移
不得把用户内容写入日志或审计 metadata
不得把 data、数据库、项目文件和导出资产加入 Git 或 Docker build context
```

备份、恢复、迁移和 Git 历史重写属于独立高风险操作，必须有明确目标路径、快照、校验和回滚方案。

平台支持通过 `SCIFIGURE_DATA_DIR` 显式指定统一数据根目录。未配置时保持现有 `./data` 行为；测试、恢复演练和生产部署可使用独立目录，使 SQLite、项目文件和导出资产处于同一隔离边界。自动化浏览器测试不得只切换数据库路径而继续写入真实 `data/projects`。

### 2.1 自动化测试数据隔离

所有会注册账号、创建项目、上传文件、渲染、导出或删除测试项目的 npm 脚本，必须通过 `scripts/testing/run_with_isolated_server.mjs` 启动：

```text
随机空闲端口
系统临时目录下的 SCIFIGURE_DATA_DIR
临时 SQLite 数据库
SCIFIGURE_TEST_ISOLATED=1
仅清理经过 os.tmpdir + scifigure-isolated-smoke-* 双重校验的目录
```

测试不得默认连接已运行的 `localhost:3000` 正式开发服务。新增烟雾测试时，验收必须包含真实数据库文件大小、修改时间及真实项目文件数量在测试前后不变。

`npm run data:audit` 是只读检查；恢复命令默认 dry-run。`--apply` 恢复必须满足不覆盖目标、记录来源和哈希、数据库写入前建立在线备份的约束。

### 2.2 对外安全宣传口径

宣传页、注册页、产品说明和销售材料只能陈述当前代码和可重复测试已经证明的安全能力。

允许公开陈述：

```text
账号、项目、文件和导出资产按认证用户校验所有权
上传、读取和导出路径经过目录边界检查
生产 renderer 支持独立容器、禁网、只读、低权限和资源限制
单次任务只挂载必要数据副本，不挂载主数据库、项目根目录或 .env
用户数据、数据库和密钥被仓库边界检查阻止进入 Git / Docker build context
```

必须标记为“正式部署后启用并复测”，不得写成已经在线生效：

```text
云服务器数据盘加密
restic 异地加密备份
真实备份恢复演练
生产 Compose / systemd 到 renderer 的完整调用链
WAF、云端告警和生产密钥托管
```

禁止使用“绝对安全”“银行级/支付宝级安全”“数据永不泄露”等无法工程证明的表述。安全页面必须同时说明已实现边界和仍待部署验证项。

公开页面采用“保护结果层”，只说明用户能够获得的安全结果：

```text
传输过程加密
服务器存储加密
备份独立加密并经过恢复验证
账号与项目访问隔离
绘图任务在独立受限环境中运行
最小权限、限流、权限校验与关键操作审计
```

以下内容属于内部安全实现层，不得直接出现在宣传页、注册页、公开帮助或销售材料：

```text
真实目录结构、数据库位置和配置文件名称
密钥、备份目标、内部服务地址、端口和网络拓扑
容器名称、挂载规则、系统调用策略和具体沙箱参数
CPU、内存、PID、超时和请求频率的精确阈值
路径拦截正则、静态扫描规则和危险调用黑名单
管理员接口路径、审计表结构和告警触发条件
```

公开文案可以说明“独立受限环境”“仅获得本次任务所需数据”“无法访问其他用户项目”，但不得给出可用于推测或绕过防线的实现细节。内部技术文档仍应保留完整配置、威胁模型和测试证据，不能因为公开脱敏而降低工程记录颗粒度。

## 3. 当前已实现的安全能力

### 3.1 账号与会话

```text
Argon2id 新密码哈希
旧密码成功登录后自动迁移
短期 access token
HttpOnly + SameSite=Strict refresh cookie
refresh token rotation
旧 refresh token 重放拒绝
logout 撤销
设备记录
登录/注册限流
```

平台使用不透明随机 Token，不依赖 `jsonwebtoken`。服务端数据库保存 Token 哈希而不是明文。

### 3.2 用户隔离

```text
projects 和 sessions 绑定 user_id
项目读取、更新、删除使用认证用户边界
Figure、上传文件和导出资产先确认所属项目
前端不能通过提交 user_id 决定资源归属
双用户 API smoke 验证越权返回 404/拒绝
```

当前是同一数据库内的逻辑隔离，不是 Database-Per-User。第一阶段单机部署不需要为了形式上的独立数据库增加迁移风险。

### 3.3 管理员

```text
users.role: user/admin
新用户默认 user
管理 API 每次实时查库确认 admin
旧 x-admin-secret 无效
角色撤销后现有 access token 立即失去管理权限
管理员操作写入 admin_audit_logs
兑换码明文不进入数据库审计日志
```

当前管理员授权/撤销仍通过服务器命令完成。独立网页管理员后台已在 `feature/admin-console` 完成 Phase A 和部分 Phase B，尚未合并或部署到云服务器。

当前已实现的管理 API 包括：

```text
POST /api/admin/redeem-codes
GET /api/admin/audit-logs
GET /api/admin/overview
GET /api/admin/users
GET /api/admin/error-reports
GET /api/admin/error-reports/:id
POST /api/error-reports（认证用户的脱敏结构化错误上报）
```

用户元数据列表已实现；账号暂停、会话撤销、订阅修正、recent re-auth、2FA 和最后管理员保护仍属于后续计划，不是当前能力。

### 3.4 Web 与接口

```text
隐藏 X-Powered-By
nosniff、frame、referrer、permissions、CORP 等响应头
生产 HSTS
全局 API 限流
认证接口双维度限流
渲染和管理接口独立限流
JSON 请求体限制
上传文件大小和数量限制
统一 Multer 错误响应
```

Content-Security-Policy 尚未强制。上线前应先使用 Report-Only 收集真实资源需求，不能直接复制包含宽泛 `unsafe-inline` 的模板。

### 3.5 路径和文件

```text
项目 ID 格式检查
safeResolveUnder 目录边界
绝对路径、协议路径和 NUL 拒绝
真实路径和符号链接父级检查
上传文件名清理
上传落盘前确认项目所有权
组合项目只复制用户有权访问的文件
```

任何新增文件 API 必须复用同一边界，不能自行拼接路径。

## 4. 用户代码执行边界

### 4.1 生产模式

非 development/test 环境默认使用 Docker。显式设置 local 会拒绝启动，除非管理员主动设置仅限开发应急的 unsafe override。

生产 renderer 参数包括：

```text
network=none
read-only root filesystem
cap-drop=ALL
no-new-privileges
uid/gid 65532
CPU、内存和 PID 限制
受限 tmpfs
单次任务只读挂载
唯一容器名和管理标签
输出大小限制
超时和请求取消强制删除容器
```

renderer 不挂载：

```text
主数据库
.env
整个 data/
其他用户项目
Docker socket
服务器密钥目录
```

### 4.2 Python

Python AST 预检识别明显危险 import 和调用。默认 log-only 是兼容性策略，不表示没有安全边界；生产安全依靠 Docker。

启用强制模式前必须运行真实 Python 项目矩阵，确认没有把正常路径、字体或辅助代码误拦。

### 4.3 R

R 风险扫描覆盖：

```text
system/system2/shell/pipe
socket 和下载
install.packages
dyn.load/Rcpp::sourceCpp
processx/callr 进程调用
httr/curl/ssh 网络调用
反引号函数
get/match.fun/do.call 已知危险目标
parse(text="危险调用")
```

为减少误伤，单纯加载 `parallel`、`future`、`Rcpp` 等能力包只产生 warning；`source`、`setwd` 和环境变量设置也以告警为主。具体进程、联网、原生代码和明确破坏操作保持高风险。

R 正则扫描仍可被复杂反射绕过，不能替代沙箱。

## 5. XLS/XLSX 解析

服务端不再在 Express 进程中直接使用 JavaScript `xlsx` 解析用户工作簿。

当前链路：

```text
后端确认项目所有权和文件路径
→ 复制单个文件到任务临时目录
→ 生产使用受限 Docker parser
→ 开发使用独立本地 Python 进程
→ 返回 metadata 或受 limit 约束的 records
```

已实现：

```text
.xlsx/openpyxl
.xls/xlrd
首 worksheet
metadata 只读取表头和行数
预览按 limit 读取
records 不进入长期缓存
parser 独立并发队列
超时、输出、CPU、内存和 PID 限制
解析失败清理未登记上传文件
```

浏览器端仍保留 `xlsx` 用于本地预览兼容。真实 BIFF `.xls`、超大合法工作簿和复杂日期/公式仍需生产前回归。

## 6. 导出安全

R 生成的 SVG 转 PNG/PDF/TIFF 不再回流宿主机执行。Docker 模式下 `svg_convert.py` 使用同一禁网、只读、低权限容器。

导出需要继续遵守：

```text
格式和 DPI 白名单
输出大小限制
安全文件名
项目所有权
下载 Content-Type/Content-Disposition
不解析外部网络资源
导出任务限流和超时
```

SVG 前端展示仍需持续检查 sanitize 和 CSP，不能把用户生成 SVG 当作普通可信 HTML。

## 7. Docker 构建和镜像

专用 `Dockerfile.renderer.dockerignore` 只允许：

```text
Dockerfile.renderer
requirements.txt
renderer/**
```

仓库 `.dockerignore` 额外排除：

```text
data
数据库
tmp/output
测试结果和 Playwright 快照
.env
日志和临时 payload
```

当前镜像仍需在生产阶段完成：

```text
依赖版本固定策略
基础镜像 digest
镜像漏洞扫描
定期更新流程
Linux 宿主机复测
```

## 8. 备份与恢复

仓库已经准备：

```text
SQLite 一致性快照
integrity_check
restic 客户端加密备份脚本
备份恢复验证脚本
systemd 定时任务模板
生产数据安全运行手册
```

代码存在不等于备份已经生效。购买服务器后必须实际完成：

```text
初始化 restic 仓库
把密码和云凭据放入受限密钥文件
执行首次完整备份
在独立临时目录恢复
验证数据库完整性和项目文件数量
记录恢复时间和操作人
启用定时任务和失败告警
```

网页管理员后台未来只能展示备份状态，不提供一键恢复按钮。

## 9. 推荐生产拓扑

第一阶段推荐单机部署，不立即建设多节点集群：

```text
8 核 16 GB 云服务器
10 Mbps 带宽
Nginx/TLS
Node/Express Web 服务
SQLite 数据库
本机独立 Docker renderer
加密数据盘
restic 加密异地备份
日志和基础监控
```

该拓扑是推荐目标，不代表现有 `docker-compose.yml` 已经完成生产链路。部署前必须实际验证 Web 服务如何调用 renderer 镜像、Docker 权限如何隔离、任务目录如何挂载以及异常容器如何清理。

初始资源建议：

```text
renderer 并发 4
每任务 CPU 1
每任务内存 1 GB
parser 并发 2
同一用户并发 1-2
API 超时小于容器强杀上限
```

不建议第一阶段直接引入：

```text
Database-Per-User
SQLCipher 全量迁移
Kubernetes
多 Web 节点
公共 Web 容器挂载 Docker socket
```

这些能力不能替代当前更重要的沙箱、备份、权限和恢复验证。

### 9.1 发布排空基础

当前代码已经提供应用层发布控制：

```text
GET  /api/health/live
GET  /api/health/ready
GET  /api/admin/deployment-state
POST /api/admin/deployment-state
```

进入 draining 后，新的 render、patch、code-patch、项目重绘、导出、压缩和组合任务返回 `503 INSTANCE_DRAINING`；已经开始的任务继续完成。客户端断线会取消排队任务和对应 renderer worker，但不会在 worker 停止前提前释放发布 lease。管理员状态变更写入 `deployment.mode.change` 审计，`SIGTERM/SIGINT` 代码会等待在途请求和 renderer active/queued/worker 排空。

这只是应用层基础。Linux 信号行为、真实 renderer 并发和失败恢复仍必须在云服务器复测。

### 9.2 2 核 4 GB 调试服务器

2026-07-13 已完成一台 Ubuntu 24.04.2 LTS、2 核、3.8 GiB 内存、约 50 GiB 可用磁盘服务器的只读预检。该主机用于本人和少量同学共同调试，采用单实例而不是长期 Blue/Green 双实例：

```text
Nginx 公网入口 80/443
-> 127.0.0.1:3101 单个 Node/systemd 服务
-> rootless Docker renderer
-> /srv/scifigure/data 独立数据目录
```

资源基线：

```text
4 GB Swap
renderer 并发 1
单 renderer 任务 1 CPU / 896 MB / 96 PID
tabular parser 并发 1
Node 构建最大堆 2 GB，仅发生在 release 构建阶段
```

发布采用不可变 release + `current` 原子软链接。候选依赖和 renderer 镜像先在后台构建；切换时当前服务通过 SIGTERM 排空并停止，随后只启动新 release。新版本 readiness 失败时自动恢复上一 release 和对应环境文件。整个过程不允许两个 Node 进程同时写同一个 SQLite。

真正零停机 Blue/Green 暂不启用。若未来要求并行写流量，必须先引入跨进程部署锁、明确数据库迁移策略，或迁移到适合多实例写入的数据库，不能直接让两个实例共享 SQLite。

## 10. 云服务器上线阻断项

以下项目未完成前不得开放公网用户：

```text
系统盘和数据盘加密
只开放 80/443 和受限 SSH 的安全组
SSH 密钥登录、禁止密码和 root 远程登录
Nginx TLS 和可信代理配置
生产 .env 权限和密钥轮换方案
NODE_ENV=production + SCIFIGURE_RENDER_MODE=docker
Docker renderer 文件、网络和资源隔离复测
真实备份和恢复演练
管理员账号和紧急撤销流程
日志轮转、磁盘和备份失败告警
跨用户数据隔离 smoke
真实 Python/R 项目兼容回归
把当前脏工作树整理为经过审查的可复现提交
验证生产 Compose/systemd 到 renderer 的实际调用链
配置可信反向代理，禁止客户端伪造 X-Forwarded-For 影响限流和审计
Linux SIGTERM 排空、单实例原子替换和自动回滚实测
```

## 11. 管理员后台

管理员后台独立于绘图主线，规划路径为：

```text
/admin 独立入口
src/admin 独立前端模块
/api/admin/* 独立路由
默认功能开关关闭
先只读，后受控写操作
```

第一阶段只展示：

```text
系统概览
用户、项目、订阅和存储元数据
渲染队列和失败率
兑换码批次元数据
审计日志
备份状态
```

后台不得提供任意命令、SQL、文件浏览、用户代码/数据查看或网页备份恢复。

当前实现状态：

```text
已完成：/admin 独立分包、功能开关、概览、用户元数据、错误中心、审计日志
已完成：错误上报限流、字段白名单、路径/敏感键拒绝、去重计数
待完成：订阅/兑换码只读页、备份/渲染指标、错误处理状态写入
待完成：Phase C 的 recent re-auth、reason、幂等和最后管理员保护
```

写操作必须具备：

```text
recent re-auth
reason
幂等 requestId
成功/失败审计
最后管理员保护
不删除用户项目
```

详细计划保留在 `docs/admin-console/ADMIN_CONSOLE_DEVELOPMENT_PLAN.md`。

## 12. CSP 与浏览器安全

当前 CSP 尚未正式部署。建议顺序：

```text
资源清单
Content-Security-Policy-Report-Only
收集违规
为 script/style 建立 nonce 或 hash
验证 Vite 生产包、SVG、Blob 下载、字体和 Web Worker
切换强制 CSP
```

不能直接使用宽泛的 `unsafe-inline` 作为最终生产策略。

## 13. 安全测试矩阵

| 边界 | 必测内容 |
|---|---|
| 认证 | 注册、登录、refresh rotation、logout、旧 token 重放 |
| 用户隔离 | A 用户不能读写 B 用户项目、文件和导出资产 |
| 管理员 | 普通用户 403、角色撤销即时、审计脱敏 |
| 路径 | `..`、绝对路径、协议路径、符号链接逃逸 |
| 数据根目录 | 默认 `./data` 兼容、自定义绝对路径、数据库/项目/导出同目录隔离 |
| Python/R | 正常绘图成功，危险代码在 Docker 内无法读取宿主或联网 |
| 超时 | 死循环强杀，后续任务恢复，无残留容器 |
| XLS/XLSX | metadata、limit、损坏文件、超限和失败清理 |
| 导出 | R PNG 转换在沙箱内，格式和输出受限 |
| 发布控制 | readiness/draining、在途任务计数、503 门禁、管理员审计、恢复 accepting |
| 仓库 | 用户数据、数据库、密钥不进入 Git |
| 备份 | 可恢复，不只存在备份文件 |

## 14. 验收命令

```text
npx tsc --noEmit
npm test
npm run build
npm run test:security-baseline
npm run test:user-isolation
npm run test:auth-refresh
npm run test:admin-authorization
npm run test:deployment-lifecycle
npm run test:r-security-precheck
npm run test:renderer-sandbox
npm run security:repo-boundary
npm run test:capability-matrix
python tests/test_r_renderer.py
python tests/test_tabular_parser.py
```

云端还需要人工执行：

```text
端口扫描
TLS 检查
SSH 配置检查
容器网络和挂载检查
备份恢复演练
磁盘满和 renderer 超时演练
真实账号越权测试
```

## 15. 剩余风险

```text
静态 Python/R 规则仍可被复杂写法绕过
浏览器端 xlsx 依赖仍存在
镜像和 Python/R 依赖尚未完全固定
CSP 尚未强制
管理员 2FA 尚未实现
独立 renderer worker 和持久任务队列尚未实现
孤儿容器目前依赖唯一名称、强制删除和测试，缺少生产定时巡检
真实 BIFF .xls 和大型工作簿覆盖有限
本地 Git 状态中已有历史用户数据删除标记，不能擅自恢复或提交
当前 Web 服务使用 X-Forwarded-For 参与客户端 IP 判断，生产代理必须清洗该请求头并建立可信代理边界
当前 Compose 和 Web 镜像不能单独证明生产 renderer 已正确接通
Windows 无法可靠模拟 Linux 子进程 SIGTERM；云端必须复测在途渲染完成后进程退出
Linux 单实例原子替换和失败自动回滚尚未完成首次云端实测
```

## 16. 详细参考文档

```text
USER_SERVER_SECURITY_UPGRADE_PLAN.md
PRODUCTION_DATA_SECURITY_RUNBOOK.md
PRODUCTION_DEPLOYMENT_ARCHITECTURE.md
ADMIN_AUTHORIZATION_AND_AUDIT.md
R_SECURITY_RISK_AUDIT.md
XLSX_PARSER_SECURITY.md
security-audit-2026-07-10/CURRENT_STATE_REVIEW.md
admin-console/ADMIN_CONSOLE_DEVELOPMENT_PLAN.md
```
