# SciFigure 管理员后台

> 更新时间：2026-07-14 09:55:23 +08:00
> 当前状态：Phase A 已完成，Phase B 只读 MVP 部分完成

本目录用于管理员后台的独立规划、验收和后续变更记录。

管理员后台不属于绘图编辑主线。其开发必须满足：

```text
独立入口
独立前端模块
独立 API 路由
默认关闭
失败不影响普通用户编辑器
不读取用户原始数据和代码
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
```

尚未实现：

```text
订阅与兑换码只读页
备份状态与更完整的渲染指标
错误分流/解决写操作
账号暂停、会话撤销和订阅修正
recent re-auth、幂等 requestId 和唯一管理员保护
```

本地使用时，先通过 `security:set-user-role` 授予自己的账号 `admin` 角色，再设置：

```text
SCIFIGURE_ADMIN_CONSOLE_ENABLED=1
```

登录后直接访问 `/admin`。功能开关关闭时，新增管理 API 返回 404，普通用户平台不受影响。

