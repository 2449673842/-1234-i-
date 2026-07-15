# SciFig 管理员授权与审计说明

> 最后更新：2026-07-16 01:55:49 +08:00

## 1. 安全目标

管理接口不再依赖可复制、可泄露的 `x-admin-secret` 请求头，而是使用：

```text
正常账号登录
→ Bearer access token
→ auth_sessions 实时查库
→ users.role 实时确认 admin
→ 管理员 TOTP/MFA 会话确认
→ 执行管理操作
→ 写入 admin_audit_logs
```

角色不写入可长期信任的前端状态。即使用户持有尚未过期的 access token，数据库角色被撤销后，下一次管理请求也会立即返回 403。

## 2. 角色模型

当前角色：

```text
user：普通用户，默认角色
admin：管理员，可访问 /api/admin/*
```

新注册用户始终为 `user`。平台不提供普通用户可调用的角色提升 API。

管理员角色与 MFA 是两个独立门槛：角色决定“是否属于管理员”，MFA 证明“本次管理员会话是否完成第二因素”。撤销角色永远优先于已验证 MFA 会话。

## 3. 授予和撤销管理员

### 3.1 本地管理员完整操作流程

1. 先在 SciFig 网页正常注册自己的账号，例如 `admin@example.com`。
2. 确认当前运行的是包含数据库角色鉴权的最新后端代码。
3. 在项目根目录授予管理员角色：

```powershell
npm run security:set-user-role -- --email "admin@example.com" --role admin --reason initial_owner
```

4. 本地私有迁移阶段配置独立 MFA key，并临时使用观察模式：

```powershell
$env:SCIFIGURE_ADMIN_CONSOLE_ENABLED = "1"
$env:SCIFIGURE_ADMIN_MFA_MODE = "observe"
$env:SCIFIGURE_ADMIN_MFA_ENCRYPTION_KEY = "<32-byte-base64-key>"
```

5. 登录后访问 `/admin/security`，输入管理员密码，按页面显示的手动 key 绑定验证器，再输入新的 6 位动态码确认。恢复码只显示一次，必须离线保存。
6. 确认绑定完成后改为强制模式，再重新登录：

```powershell
$env:SCIFIGURE_ADMIN_MFA_MODE = "enforce"
```

之后管理员密码登录只会产生短时 MFA challenge；输入验证器代码或未使用的恢复码后才签发 access/refresh 会话。订阅写操作还会再次要求管理员密码与一个新的动态码。

7. 不再需要管理员权限时撤销角色：

```powershell
npm run security:set-user-role -- --email "admin@example.com" --role user --reason access_revoked
```

角色变更实时生效。撤销后，即使原 access token 尚未过期，也不能继续调用管理接口。

网页管理员后台入口为 `/admin`。后台只显示账号 ID、脱敏账号标识、订阅与运行元数据，不显示其他用户原始邮箱、昵称、脚本、数据、Figure 或导出内容。

### 3.2 生产离线 MFA 引导

生产默认 `enforce`，不应先开放一个 password-only 管理员网页会话。设置 keyring 和数据库路径后分两步执行：

```bash
export SCIFIGURE_DB_PATH=/srv/scifigure/data/scifigure.db
export SCIFIGURE_ADMIN_MFA_ENCRYPTION_KEYS="2026q3:<base64-32-byte-key>"
npm run security:admin-mfa-bootstrap -- --email admin@example.com
npm run security:admin-mfa-bootstrap -- --email admin@example.com --confirm
```

第一步只创建十分钟有效的加密 pending factor；第二步在 TTY 中隐藏读取 token 和动态码，启用 TOTP、撤销该管理员旧会话并一次性显示恢复码。终端输出含敏感的手动 key/token/恢复码，完成后应清屏，不得进入工单、聊天或 Git。

轮换密钥时把新 `kid:key` 放在 keyring 第一位，并暂时保留旧 key：

```bash
SCIFIGURE_ADMIN_MFA_ENCRYPTION_KEYS="2026q4:<new-key>,2026q3:<old-key>"
```

新 factor 使用第一把 key，加密旧 factor 仍可由旧 key 解密。在所有旧 factor 重新绑定或完成受控 rewrap 前不得删除旧 key。

### 3.3 角色命令参考

在服务器项目目录执行：

```bash
npm run security:set-user-role -- --email admin@example.com --role admin --reason initial_provisioning
```

撤销：

```bash
npm run security:set-user-role -- --email admin@example.com --role user --reason access_revoked
```

如果生产数据库不在默认 `data/scifigure.db`：

```bash
SCIFIGURE_DB_PATH=/srv/scifigure/data/scifigure.db \
npm run security:set-user-role -- --email admin@example.com --role admin
```

该命令只修改指定账号的 `role` 字段，并写入 `user_role.set_offline` 审计记录，不修改项目、Figure、上传文件或导出资产。

## 4. 管理接口

### 创建兑换码

```text
POST /api/admin/redeem-codes
Authorization: Bearer <access-token>
```

审计操作名：

```text
redeem_codes.create
```

审计 metadata 仅保存数量、有效期、使用次数和标签，不保存生成的兑换码明文。

### 查询审计日志

```text
GET /api/admin/audit-logs?limit=100
Authorization: Bearer <admin-access-token>
```

最大返回 500 条。读取审计日志本身也会记录 `admin_audit_logs.read`。

### 查询与切换发布状态

```text
GET /api/admin/deployment-state
Authorization: Bearer <admin-access-token>
```

返回当前 `accepting/draining`、各类在途任务数和 renderer active/queued/workers/concurrency。状态不包含用户、项目、脚本或文件内容。

开始排空：

```text
POST /api/admin/deployment-state
Authorization: Bearer <admin-access-token>
Content-Type: application/json

{"mode":"draining","reason":"deployment"}
```

取消排空并恢复接收任务：

```text
{"mode":"accepting","reason":"manual"}
```

允许的 reason 只有 `deployment`、`maintenance`、`rollback`、`manual`。状态变更审计操作名为 `deployment.mode.change`。进入 draining 后普通读取继续可用，但新的渲染和导出任务返回 503；应等待 `activeJobsTotal=0` 且 renderer active/queued/workers 均为 0 后再停止旧实例。

## 5. 审计字段

```text
actor_user_id
action
resource_type
resource_id
success
status_code
ip_address
user_agent
metadata
created_at
```

不得写入：

```text
密码
access token
refresh token
Cookie
兑换码明文
完整上传文件内容
```

## 6. 生产要求

```text
至少准备两个独立管理员账号，避免单账号锁死
管理员使用独立高强度密码和独立设备
管理员接口只能通过 HTTPS
定期审查失败的 401/403 管理请求
角色变更必须填写 reason
禁止恢复 x-admin-secret 兼容入口
```

## 7. 验证

```bash
npm run test:admin-authorization
npm run test:admin-console-readonly
npm run test:admin-mfa
npm run test:deployment-lifecycle
```

专项测试使用临时 SQLite，验证：

```text
新用户默认为 user
旧 x-admin-secret 无效
普通用户返回 403
数据库 admin 角色可以执行管理操作
审计日志不包含兑换码明文
角色撤销后现有 token 立即失去管理权限
管理员密码登录在 MFA challenge 前不签发会话
设置页和首页登录均能完成管理员 MFA challenge
恢复码一次性消费，TOTP time-step 不可重放
其他用户原始邮箱和昵称不进入管理员 DTO
```

`2026-07-16 01:55:49 +08:00` 本地隔离验证通过：Vitest `42/42` 文件、`266/266` 测试；管理员 MFA、后台只读、管理员授权、认证刷新、邮箱验证、部署生命周期、生产构建与 production bundle 均通过。测试使用临时数据库和随机端口，未连接本地 `3000`、真实数据或 Docker。
