# SciFigure 管理员后台

> 更新时间：2026-07-16 01:55:49 +08:00
> 当前状态：旧版后台已部署；MFA、原始身份最小化和安全设置页仅在本地安全分支完成，尚未发布

本目录用于管理员后台的独立规划、验收和后续变更记录。

管理员后台不属于绘图编辑主线。其开发必须满足：

```text
独立入口
独立前端模块
独立 API 路由
默认关闭
失败不影响普通用户编辑器
不读取用户原始数据和代码
错误中心不返回报告者邮箱、用户 ID 或内部 fingerprint
错误关联的项目/Figure 必须先验证属于上报账号
所有敏感操作可审计、可撤销或可恢复
```

当前文件：

- `ADMIN_CONSOLE_DEVELOPMENT_PLAN.md`：完整开发计划。

当前已实现：

```text
/admin 独立动态入口和独立 CSS/JS chunk
SCIFIGURE_ADMIN_CONSOLE_ENABLED 功能开关
数据库 admin 角色实时二次校验
系统概览
用户元数据分页和筛选
错误中心及脱敏详情抽屉
管理审计日志
已认证用户的结构化错误上报、限流、服务端脱敏和去重
Python/R 渲染失败与编辑器崩溃自动记录摘要
错误事件 AI 修复交接包：复制 JSON、下载 Markdown/JSON
订阅权限列表和受控调整
管理员密码 recent re-auth、一次性短时令牌
订阅写操作 reason、幂等 requestId 和成功/失败审计
其他用户原始邮箱和昵称不进入管理员 API，只返回脱敏账号标识
管理员 TOTP 登录挑战、设备绑定、MFA 会话和防重放
一次性恢复码、恢复码轮换和离线生产引导
TOTP seed AES-256-GCM 加密与 key ID 轮换
管理员安全设置页
```

尚未实现：

```text
兑换码只读页
备份状态与更完整的渲染指标
错误分流/解决写操作
账号暂停和会话撤销
唯一管理员保护
```

管理员后台旧版已随 `eea68fb-jd7` 部署到调试服务器。本轮 MFA 和身份最小化仍只在本地安全分支，不能把下面的配置说明误认为线上已启用。

本地使用时，先通过 `security:set-user-role` 授予自己的账号 `admin` 角色，再设置：

```text
SCIFIGURE_ADMIN_CONSOLE_ENABLED=1
SCIFIGURE_ADMIN_MFA_MODE=observe
SCIFIGURE_ADMIN_MFA_ENCRYPTION_KEY=<32-byte-base64-key>
```

登录后直接访问 `/admin`。功能开关关闭时，新增管理 API 返回 404，普通用户平台不受影响。

生产环境应使用可轮换 keyring，并在开放后台前通过离线命令完成首个管理员绑定：

```bash
export SCIFIGURE_ADMIN_MFA_ENCRYPTION_KEYS="2026q3:<base64-32-byte-key>"
npm run security:admin-mfa-bootstrap -- --email admin@example.com
npm run security:admin-mfa-bootstrap -- --email admin@example.com --confirm
```

第二条命令只显示一次恢复码并撤销该管理员旧会话。完成后设置 `SCIFIGURE_ADMIN_MFA_MODE=enforce`，再启动公网服务。不得把密钥、手动绑定 key、确认 token 或恢复码写入文档、工单、聊天记录或 Git。

`2026-07-16 01:55:49 +08:00` 本地隔离验证已通过管理员 MFA、后台只读、管理员授权、部署生命周期和 production bundle；公网调试服务器仍是旧版，不得据此宣称线上已经启用 MFA。

