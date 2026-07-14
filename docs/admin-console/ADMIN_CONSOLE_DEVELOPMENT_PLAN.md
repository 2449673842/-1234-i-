# SciFigure 管理员后台独立开发计划

> 文档状态：In Progress
> 最后修改时间：2026-07-14 09:55:23 +08:00
> 实现校准：Phase A 已完成；Phase B 已完成系统概览、用户元数据、错误中心和审计日志，订阅/兑换码、备份与完整渲染指标待完成
> 模块定位：独立安全运维模块  
> 与绘图主线关系：复用认证和数据库，不依赖编辑器、Figure 协议或渲染 UI  
> 默认开关：关闭  
> 开发原则：先只读、后写入；先元数据、后受控操作；不提供任意命令、SQL 或用户文件浏览

> 当前验证：管理 API 专项、旧管理员鉴权回归、203 项 Vitest、TypeScript、生产构建、production bundle 和 1440/390 真实浏览器验收通过

## 1. 建设目的

SciFigure 已经具备数据库管理员角色、实时服务端鉴权、管理接口限流和审计日志，但管理员仍主要通过服务器命令和直接 API 操作。

管理员后台用于把以下工作可视化：

```text
确认服务是否正常
查看用户、订阅、项目和存储的元数据
查看渲染队列、失败率和资源使用情况
管理兑换码和受控账号状态
查看管理操作审计与安全告警
确认备份是否按计划完成
```

它不是服务器控制面，也不是用户内容查看器。

## 2. 当前基础

当前代码已经提供以下可复用能力：

| 能力 | 当前证据 | 后台用途 |
|---|---|---|
| Bearer Token 认证 | `server.ts:571` | 管理 API 使用现有登录会话 |
| 数据库角色实时校验 | `server.ts:598` | 每次请求重新确认 `users.role=admin` |
| 管理接口限流 | `server.ts:221` | 防止后台接口滥用 |
| 管理审计写入 | `server.ts:609` | 记录管理员、IP、User-Agent、结果和元数据 |
| 兑换码创建 | `server.ts:1254` | 可迁移为后台表单操作 |
| 审计日志查询 | `server.ts:1300` | 可构建审计日志页面 |
| 用户与角色模型 | `db.ts:77` | 区分普通用户与管理员 |
| 订阅和兑换码表 | `db.ts:100` | 展示订阅及兑换码元数据 |
| 管理审计表 | `db.ts:150` | 支持后台操作追踪 |
| 管理员专项测试 | `tests/api/admin_authorization_smoke.mjs` | 作为新增后台 API 的回归基线 |

当前管理员授权流程继续以 `docs/ADMIN_AUTHORIZATION_AND_AUDIT.md` 为准。

## 3. 模块边界

### 3.1 必须独立的内容

```text
URL：/admin
前端目录：src/admin/
后端路由：/api/admin/*
数据查询：只使用专门的 admin query 函数
测试：独立 admin API 和 Playwright 测试
文档：docs/admin-console/
功能开关：SCIFIGURE_ADMIN_CONSOLE_ENABLED
```

管理员后台不得依赖：

```text
ChartPreview
RightSidebar
StandardFigureModel
EditingIntent
Figure patch、拖拽或导出页面状态
当前打开的项目或当前 Figure
```

### 3.2 允许共享的内容

```text
认证会话
authenticatedFetch
基础按钮、输入框、表格和对话框样式
数据库连接
管理员角色与审计工具
统一错误响应格式
时间、文件大小和分页工具
```

### 3.3 明确禁止的能力

管理员后台不提供：

```text
任意服务器命令执行
原始 SQL 输入框
服务器文件浏览器
Docker socket 或容器终端
查看用户上传文件内容
查看用户完整 Python/R 代码
查看用户 Figure SVG 或导出图
网页一键恢复备份
无确认的项目、用户或数据库删除
前端传入 user_id 决定权限
```

## 4. 推荐架构

### 4.1 前端

推荐在同一仓库建立独立懒加载入口：

```text
src/admin/AdminApp.tsx
src/admin/AdminShell.tsx
src/admin/adminRoutes.ts
src/admin/api/adminApi.ts
src/admin/pages/OverviewPage.tsx
src/admin/pages/UsersPage.tsx
src/admin/pages/SubscriptionsPage.tsx
src/admin/pages/RedeemCodesPage.tsx
src/admin/pages/RenderOperationsPage.tsx
src/admin/pages/AuditLogsPage.tsx
src/admin/pages/BackupStatusPage.tsx
src/admin/components/
src/admin/types.ts
```

`src/main.tsx` 只负责按路径选择入口：

```text
/admin/* → lazy import AdminApp
其他路径 → 原 App
```

管理员模块加载失败时不得影响普通用户主应用。普通用户导航中默认不显示管理员入口；管理员可直接访问 `/admin`，后续再决定是否在设置页增加受角色控制的入口。

### 4.2 后端

新建独立路由模块：

```text
server/admin/registerAdminRoutes.ts
server/admin/adminQueries.ts
server/admin/adminMetrics.ts
server/admin/adminValidation.ts
server/admin/adminAudit.ts
```

第一阶段可以通过依赖注入复用 `requireAdmin`、`adminRateLimit` 和 `writeAdminAudit`，避免立即重构整个 `server.ts`。

所有查询必须：

```text
后端重新执行 requireAdmin
使用参数化 SQL
使用固定字段白名单
分页并限制最大 pageSize
不返回 password_hash、salt、token hash、refresh hash
不返回用户代码、数据内容和文件绝对路径
对敏感读取也写入审计日志
```

### 4.3 功能开关

新增：

```text
SCIFIGURE_ADMIN_CONSOLE_ENABLED=0
```

行为：

| 配置 | `/admin` | 新增管理 API |
|---|---|---|
| `0` 或缺失 | 返回功能未启用页面 | 返回 404 |
| `1` | 管理员可访问 | 通过 `requireAdmin` 后可访问 |

现有兑换码和审计 API 可继续工作，不依赖 UI 开关，避免影响当前管理员命令流程。

## 5. 数据可见性规则

### 5.1 用户页面可显示

```text
用户 ID
脱敏邮箱或按权限显示完整邮箱
显示名称
角色
账号状态
注册时间
最近登录时间
活跃设备数量
当前订阅计划与到期时间
项目数量
上传文件数量
导出资产数量
估算存储占用
最近渲染时间和失败次数聚合
```

### 5.2 不可显示

```text
password_hash / password_salt
access token / refresh token 及其哈希
设备 fingerprint 原值
兑换码明文历史
用户数据表内容
Python/R 脚本正文
SVG、PNG、PDF、TIFF 内容
服务器绝对路径
完整异常堆栈中的用户代码
```

### 5.3 存储统计

不得在每次页面请求时递归扫描全部项目目录。推荐：

```text
上传和导出时记录文件大小
删除时扣减
历史数据由独立低优先级任务回填
后台读取聚合字段或缓存结果
提供“统计时间”而不是假装实时精确
```

## 6. 分阶段开发

## Phase A：边界和回归基线

目标：在开发 UI 前锁定权限、隐私和主线隔离。

任务：

1. 增加管理员后台功能开关和 `/admin` 空壳入口。
2. 建立 `src/admin/` 和 `server/admin/`，不得移动编辑器代码。
3. 定义统一的管理员 API 响应、分页和错误类型。
4. 建立敏感字段禁止返回测试。
5. 扩展现有管理员专项测试，锁定角色撤销即时生效。
6. 增加普通用户访问 `/admin` 和 `/api/admin/*` 的 403/404 测试。

验收标准：

```text
功能开关关闭时普通应用行为完全不变
管理员模块编译失败不能导致运行时主应用白屏
普通用户不能获得任何管理数据
角色撤销后现有 access token 立即失去后台访问权限
API 响应不包含密码、token、salt、代码和文件路径
```

## Phase B：只读后台 MVP

目标：先解决“看不见平台状态”，不增加高风险写操作。

### B1. 系统概览

显示：

```text
用户总数、近 24 小时活跃用户
项目、Figure、上传文件、导出资产数量
当前渲染并发、等待队列和最近失败率
Node 进程内存和运行时间
磁盘容量与剩余空间
最近备份时间和结果
最近 24 小时管理失败请求
```

不在网页中调用任意 shell。Docker、备份和系统状态应来自固定健康探针或受控状态文件。

### B2. 用户元数据

支持：

```text
分页
邮箱/用户 ID 搜索
角色和账号状态筛选
注册时间排序
查看订阅、项目和存储聚合
查看活跃会话数量，不显示 token
```

### B3. 订阅与兑换码只读页

显示：

```text
订阅计划、状态、来源和到期时间
兑换码批次标签、计划、有效期、最大次数、已用次数和停用时间
兑换记录数量
```

不显示历史兑换码明文。新生成兑换码仍只在创建响应中显示一次。

### B4. 审计日志

支持：

```text
按管理员、操作名、成功/失败、时间范围筛选
查看 resource type/id 和脱敏 metadata
导出脱敏 CSV
失败的 401/403 操作高亮
```

验收标准：

```text
所有页面只读
所有列表后端分页，pageSize 最大 100
10,000 用户规模下常用查询使用索引，无全表内容加载
后台读取敏感元数据也写审计记录
后台页面刷新不触发 Figure 渲染
普通编辑器 bundle 不同步加载后台页面代码
```

## Phase C：受控管理操作

目标：加入必要写操作，但每项都具备再认证、确认、审计和回滚边界。

### C1. 兑换码管理

```text
创建兑换码批次
停用未使用兑换码
查看批次使用统计
不支持恢复兑换码明文
```

### C2. 账号状态

数据库增加显式账号状态，而不是删除用户：

```text
status: active / suspended
suspended_at
suspended_reason
```

暂停账号时：

```text
要求再次输入管理员密码
要求填写 reason
撤销该用户全部 auth sessions
不删除项目、文件、导出资产或订阅记录
写入完整审计事件
```

恢复账号使用独立操作，同样要求 reason。

### C3. 会话管理

```text
撤销单个用户全部登录会话
显示会话数量和最后活动时间
不显示 token、token hash 或完整设备 fingerprint
```

### C4. 订阅修正

只允许：

```text
延长到期时间
暂停/恢复订阅状态
添加管理员备注
```

不允许直接执行任意 SQL 修改订阅。

验收标准：

```text
所有写操作要求 recent re-auth
所有写操作必须填写 reason
所有写操作必须写入成功或失败审计
双击、重试和网络重放不会重复执行
账号暂停不会删除或修改用户项目数据
不能暂停当前唯一管理员账号
至少保留两个管理员账号的生产规则有后端检查
```

## Phase D：运行状态和告警

目标：提供受控的运维可见性，不把服务器控制权放进网页。

功能：

```text
渲染队列和按语言耗时分位数
Python/R 成功率、超时率和输出超限次数
表格 parser 成功率和超时率
磁盘阈值告警
备份过期或失败告警
管理接口连续 401/403 告警
异常登录频率告警
Docker renderer 健康状态
```

任务终止只允许针对平台登记的任务 ID，不能接收 PID、容器名或命令字符串。

备份页面只显示：

```text
最后成功时间
备份仓库标识的脱敏值
快照数量
完整性检查结果
最近恢复演练时间
```

网页不提供“恢复备份”按钮。

## Phase E：生产强化

```text
管理员 2FA
管理员 IP allowlist 或 VPN 访问
Content-Security-Policy Report-Only 到强制模式
审计日志归档和外部告警
镜像漏洞扫描结果展示
管理员操作异常检测
安全事件导出包
```

2FA、VPN、WAF 和云告警依赖部署环境，代码可提前预留接口，但服务器购买前不伪造“已完成”状态。

## 7. 管理 API 草案

### 只读 API

```text
GET /api/admin/overview
GET /api/admin/users?page=1&pageSize=50&query=&status=&role=
GET /api/admin/users/:userId
GET /api/admin/subscriptions
GET /api/admin/redeem-codes
GET /api/admin/audit-logs
GET /api/admin/render-metrics
GET /api/admin/backup-status
```

### 写入 API

```text
POST /api/admin/redeem-codes
POST /api/admin/redeem-codes/:id/disable
POST /api/admin/users/:userId/suspend
POST /api/admin/users/:userId/restore
POST /api/admin/users/:userId/revoke-sessions
POST /api/admin/subscriptions/:id/extend
```

写入请求统一字段：

```json
{
  "reason": "required human-readable reason",
  "requestId": "client generated idempotency key",
  "reauthToken": "short-lived step-up token"
}
```

`reauthToken` 只能由管理员重新验证密码后取得，建议 5 分钟有效、一次或少量操作后失效，并只保存哈希。

## 8. 审计规范

操作名使用稳定命名：

```text
admin.overview.read
users.list
users.read
users.suspend
users.restore
auth_sessions.revoke_all
subscriptions.extend
redeem_codes.create
redeem_codes.disable
render_metrics.read
backup_status.read
```

每条写操作记录：

```text
actor_user_id
action
resource_type
resource_id
success
status_code
ip_address
user_agent
reason
request_id
修改前后的非敏感字段
created_at
```

不得进入审计 metadata：

```text
密码
token / Cookie
兑换码明文
用户代码
用户数据
文件内容
完整设备 fingerprint
服务器绝对路径
```

## 9. 前端交互要求

管理员后台是安静、紧凑、面向重复操作的工作界面，不采用营销页或卡片堆叠布局。

主要结构：

```text
左侧固定导航
顶部环境和管理员身份提示
中央表格/趋势/队列视图
右侧详情抽屉
底部不放永久操作条
危险操作使用独立确认对话框
```

状态必须明确：

```text
加载中
无数据
部分数据不可用
权限已撤销
后台功能关闭
请求被限流
服务指标过期
写操作处理中
写操作成功/失败
```

禁止只靠颜色区分风险状态。危险操作使用图标、文字和颜色共同表达。

## 10. 测试计划

### 10.1 单元测试

```text
管理员查询字段白名单
分页和排序参数限制
邮箱和设备标识脱敏
审计 metadata 脱敏
账号状态转换
唯一管理员保护
幂等 requestId
step-up token 过期和复用
```

### 10.2 API 测试

新增：

```text
tests/api/admin_console_readonly_smoke.mjs
tests/api/admin_console_actions_smoke.mjs
tests/api/admin_console_redaction_smoke.mjs
```

必须验证：

```text
未登录返回 401
普通用户返回 403
后台关闭返回 404
管理员可读取元数据
降级角色后旧 token 立即失效
响应不包含敏感字段
账号暂停撤销会话但保留项目
重复 requestId 不重复执行
每次成功/失败操作都有审计记录
```

### 10.3 浏览器测试

新增：

```text
tests/playwright/admin_console_smoke.mjs
tests/playwright/admin_console_accessibility_smoke.mjs
```

覆盖：

```text
/admin 独立加载
普通用户不能看到后台内容
管理员分页、搜索和筛选
审计详情抽屉
兑换码创建一次性明文提示
危险操作再认证和确认
角色撤销时页面立即退出后台
后台错误不影响普通 / 页面
```

### 10.4 性能与稳定性

```text
后台列表不执行用户文件读取
后台概览不触发递归目录扫描
后台查询不占用 renderer 并发槽
后台模块不进入普通编辑器首屏 chunk
页面轮询在不可见标签页暂停
轮询失败采用退避，不持续打满 API
```

## 11. 发布与回滚

### 11.1 独立开发

建议使用独立分支：

```text
feature/admin-console
```

开发期间：

```text
功能开关保持 0
不修改绘图协议
不修改项目文件格式
不迁移或删除 data/
数据库迁移仅新增可空字段或带默认值字段
每个 Phase 可单独回滚
```

### 11.2 灰度启用

```text
本地管理员账号测试
临时测试数据库验证
staging 启用功能开关
只读 Phase B 观察至少一周
再启用 Phase C 写操作
生产默认仅两个受控管理员账号可访问
```

### 11.3 回滚

关闭：

```text
SCIFIGURE_ADMIN_CONSOLE_ENABLED=0
```

关闭后台不能影响：

```text
普通登录
项目和数据上传
Python/R 渲染
图元编辑
拖拽
导出
现有服务器命令式管理员授权
```

账号状态等已经执行的写操作不能通过关闭 UI 自动回滚，必须使用受审计的恢复操作。

## 12. 风险与缓解

| 风险 | 影响 | 缓解措施 |
|---|---|---|
| 后台成为越权入口 | 全平台数据风险 | 每个 API 实时查库 `requireAdmin`，前端角色只用于展示 |
| 展示过多用户内容 | 隐私泄露 | 元数据白名单，禁止代码、数据和图像内容 |
| 管理员误操作 | 账号或订阅异常 | 再认证、reason、确认、幂等和审计 |
| 后台查询拖慢主服务 | 普通用户卡顿 | SQL 聚合、缓存、分页，禁止递归扫描和同步 shell |
| 管理 UI 破坏主应用 | 编辑器不可用 | 独立入口、懒加载、功能开关和独立 smoke |
| 唯一管理员被停用 | 无法管理 | 至少两个管理员，后端阻止最后管理员降级/暂停 |
| 审计日志包含敏感信息 | 二次泄露 | metadata schema 和脱敏测试 |
| 指标看似实时但已过期 | 错误判断 | 所有指标显示采集时间和 stale 状态 |

## 13. 完成定义

管理员后台不能以“页面能打开”作为完成标准。Phase B 完成需要同时满足：

```text
独立入口和独立 bundle 已验证
管理员角色实时鉴权通过
普通用户和降级管理员访问被拒绝
用户、订阅、兑换码、审计和系统概览只读页面可用
响应字段经过敏感信息白名单检查
后台请求不触发用户文件读取或 Figure 重绘
所有 API 和浏览器 smoke 通过
关闭功能开关后普通平台完整可用
```

Phase C 完成还必须满足：

```text
危险操作 recent re-auth
操作 reason 必填
幂等防重复执行
成功和失败均写审计
暂停账号不删除用户数据
最后管理员保护有效
明确的恢复路径已测试
```

## 14. 推荐实施顺序

```text
1. Phase A：独立入口、开关、API 边界和测试
2. Phase B4：审计日志页面，复用现有 API 快速验证后台骨架
3. Phase B1：系统概览
4. Phase B2：用户元数据
5. Phase B3：订阅和兑换码只读页
6. 只读后台稳定后再进入 Phase C
7. 服务器部署后完成 Phase D/E
```

当前最合理的首个可交付版本是：

```text
管理员登录
→ 访问 /admin
→ 查看系统概览、用户元数据和审计日志
→ 创建兑换码
→ 无法查看用户代码、数据和图像
→ 无法删除用户或项目
```

这能解决当前管理员操作不可视的问题，同时把新增安全风险控制在较小范围内。
