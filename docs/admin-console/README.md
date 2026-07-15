# SciFigure 管理员后台

> 更新时间：2026-07-15 16:40:00 +08:00
> 当前状态：Phase A、部分 Phase B 和 Phase C4 订阅修正已部署到调试服务器

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
```

尚未实现：

```text
兑换码只读页
备份状态与更完整的渲染指标
错误分流/解决写操作
账号暂停和会话撤销
唯一管理员保护与管理员 2FA
```

管理员后台已合入统一编辑发布分支，并随 `eea68fb-jd7` 部署到 `117.72.208.91`。线上功能开关已启用，账号 `2449673842@qq.com` 已通过受审计的服务器引导操作授予 `admin` 角色。

本地使用时，先通过 `security:set-user-role` 授予自己的账号 `admin` 角色，再设置：

```text
SCIFIGURE_ADMIN_CONSOLE_ENABLED=1
```

登录后直接访问 `/admin`。功能开关关闭时，新增管理 API 返回 404，普通用户平台不受影响。

