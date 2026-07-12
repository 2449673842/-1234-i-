# SciFig 安全升级审计报告

> 审计时间：2026-07-10  
> 审计范围：`server.ts`、`db.ts`、`src/utils/rRiskScanner.ts`、`package.json`、`tests/`  
> 归档说明：本文件来自 Gemini Antigravity 原始报告。报告中的状态和建议保留原意，但以同目录 `CURRENT_STATE_REVIEW.md` 的校准结果为当前口径。

---

## 总体评分

| 阶段 | 计划项 | 已完成 | 完成率 |
|---|---:|---:|---:|
| Phase 0（今天） | 3 项 | 2.5 项 | 83% |
| Phase 1（本周） | 4 项 | 3 项 | 75% |
| Phase 2（本月） | 4 项 | 0 项 | 0% |
| Phase 3（长期） | 4 项 | 0 项 | 0% |

原报告评价：整体防御等级从 D 升级到 B-，已完成最关键的基础层建设。

## Phase 0 详细审计

### P0.1 速率限制

原报告认为平台实现了自定义原生速率限制器，包括：

```text
认证接口：IP + 邮箱维度
全局 API：每分钟 240 次
渲染接口：每分钟 30 次
管理接口：15 分钟 60 次
```

原报告提出需要确认 `authRateLimit` 是否挂载到登录和注册路由。

### P0.2 安全响应头

原报告确认：

```text
禁用 x-powered-by
X-Content-Type-Options: nosniff
X-Frame-Options: SAMEORIGIN
Referrer-Policy: no-referrer
Permissions-Policy
Cross-Origin-Resource-Policy: same-origin
生产环境 HSTS
```

原报告认为仍缺少 CSP，并建议评估是否把 `X-Frame-Options` 改为 `DENY`。

### P0.3 Argon2 密码哈希

原报告确认新密码使用 Argon2id，旧 PBKDF2 用户在成功登录后自动迁移。原报告建议评估是否将 `memoryCost` 从 19456 提升到 65536。

## Phase 1 详细审计

### P1.1 R 脚本风险扫描

原报告确认扫描器覆盖系统命令、网络、原生代码、子进程、命名空间调用和危险包，并指出 `SCIFIGURE_R_RISK_ENFORCE` 默认关闭。

原报告建议在环境变量中开启：

```text
SCIFIGURE_R_RISK_ENFORCE=1
SCIFIGURE_AST_ENFORCE=1
```

### P1.2 Python AST 验证

原报告确认 `validateAst()` 和 `ast_validator.py` 已存在，但 enforce 默认关闭。

### P1.3 用户数据隔离

原报告确认 projects 和 sessions 已增加 `user_id` 字段、索引和 legacy ownership 迁移，但提出需要继续验证路由查询是否全部绑定用户。

### P1.4 双 Token

原报告发现 refresh token 数据字段与数据库函数存在，但因为没有 `jsonwebtoken` 依赖而判断服务层尚未接入 JWT 双 Token。

## 计划外安全能力

原报告还识别到：

| 功能 | 说明 |
|---|---|
| `admin_audit_logs` | 管理操作审计日志 |
| `logAdminAudit()` | 管理审计写入 |
| `UserRole` | admin/user 角色体系 |
| `safeResolveUnder()` | 路径与符号链接边界 |
| `resolveSafeRendererCwd()` | renderer cwd 安全解析 |
| `clientIp()` | 反向代理客户端 IP 处理 |
| API 安全测试 | baseline、isolation、refresh、admin、R precheck、sandbox |

## 原报告提出的立即操作

### 1. 开启 AST/R 强制执行模式

原报告认为两个扫描器处于 log-only 是最大安全缺口，建议立即开启 enforce。

### 2. 增加 CSP

原报告建议在安全头中增加 CSP，允许 self、内联脚本/样式、Google Fonts、data 图片等资源。

### 3. 验证认证限流

原报告建议运行：

```text
npm run test:security-baseline
npm run test:auth-refresh
npm run test:admin-authorization
```

## 原报告升级前后对比

| 攻击手段 | 升级前 | 原报告判断的升级后状态 |
|---|---|---|
| 暴力破解登录 | 无防御 | 双维度速率限制 |
| 密码数据库泄漏 | PBKDF2 | Argon2id |
| R 脚本 RCE | 提示词限制 | 扫描器已建，需开启 enforce |
| Python 脚本 RCE | 提示词限制 | AST 已建，需开启 enforce |
| MIME 嗅探/点击劫持 | 无防御 | 安全响应头 |
| 路径穿越 | 基础防护 | 双层路径和符号链接检测 |
| 用户数据越权 | 无 user_id | 字段已加，路由待验证 |
| Admin 越权操作 | 无角色系统 | admin/user 角色和审计 |
| 服务器标识泄漏 | 暴露 Express | x-powered-by 已禁用 |

## 归档备注

以上是原报告的结构化归档。以下结论已由后续代码和测试推翻或更新：

```text
authRateLimit 已挂载
Access + Refresh 双 Token 已完整接入
用户隔离已有专项测试
Phase 2/3 并非全部未开始
R/Python enforce 不应在未做兼容矩阵时直接强开
CSP 不能直接使用含 unsafe-inline 的示例作为最终生产策略
```

详细证据见 `CURRENT_STATE_REVIEW.md`。
