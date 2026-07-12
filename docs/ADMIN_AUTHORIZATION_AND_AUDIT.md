# SciFig 管理员授权与审计说明

## 1. 安全目标

管理接口不再依赖可复制、可泄露的 `x-admin-secret` 请求头，而是使用：

```text
正常账号登录
→ Bearer access token
→ auth_sessions 实时查库
→ users.role 实时确认 admin
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

## 3. 授予和撤销管理员

### 3.1 本地管理员完整操作流程

1. 先在 SciFig 网页正常注册自己的账号，例如 `admin@example.com`。
2. 确认当前运行的是包含数据库角色鉴权的最新后端代码。
3. 在项目根目录授予管理员角色：

```powershell
npm run security:set-user-role -- --email "admin@example.com" --role admin --reason initial_owner
```

4. 通过 PowerShell 登录并取得短期 access token：

```powershell
$login = Invoke-RestMethod `
  -Method Post `
  -Uri "http://localhost:3000/api/auth/login" `
  -ContentType "application/json" `
  -Body (@{
    email = "admin@example.com"
    password = "你的密码"
  } | ConvertTo-Json)

$headers = @{
  Authorization = "Bearer $($login.token)"
}
```

5. 创建兑换码：

```powershell
$result = Invoke-RestMethod `
  -Method Post `
  -Uri "http://localhost:3000/api/admin/redeem-codes" `
  -Headers $headers `
  -ContentType "application/json" `
  -Body (@{
    count = 10
    durationDays = 31
    maxUses = 1
    label = "首批测试用户"
  } | ConvertTo-Json)

$result.codes
```

兑换码只在创建响应中返回明文，数据库和审计日志只保留哈希或脱敏参数，无法再次查询原始兑换码。因此生成后应立即保存到受控位置。

6. 查看最近的管理审计日志：

```powershell
Invoke-RestMethod `
  -Method Get `
  -Uri "http://localhost:3000/api/admin/audit-logs?limit=100" `
  -Headers $headers
```

7. 不再需要管理员权限时撤销角色：

```powershell
npm run security:set-user-role -- --email "admin@example.com" --role user --reason access_revoked
```

角色变更实时生效。撤销后，即使原 access token 尚未过期，也不能继续调用管理接口。

当前版本尚未提供网页管理员后台，管理员操作通过服务器控制台和受认证 API 完成。

### 3.2 角色命令参考

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
```

专项测试使用临时 SQLite，验证：

```text
新用户默认为 user
旧 x-admin-secret 无效
普通用户返回 403
数据库 admin 角色可以执行管理操作
审计日志不包含兑换码明文
角色撤销后现有 token 立即失去管理权限
```
