# SciFig 用户内容与服务器安全升级方案

## 1. 目标与边界

本方案用于指导 SciFig 后续围绕用户内容、用户代码、文件上传、项目数据、账号系统和服务器执行环境的安全加固。

SciFig 的核心风险不是普通 Web 页面风险，而是用户代码执行风险。平台允许用户上传数据、提交或生成 Python/R 绘图脚本，并由后端执行渲染任务。因此安全优先级必须围绕以下攻击链展开：

```text
恶意 Python/R 脚本
→ 读取 .env / 数据库 / 用户文件
→ 联网外传
→ 伪造管理员权限或窃取用户数据
→ 资源耗尽导致服务不可用
```

本方案的目标是：

```text
优先切断 RCE、路径穿越、敏感文件读取、联网外传、跨用户越权和资源耗尽；
在不明显破坏当前绘图链路的前提下，分阶段升级到生产级纵深防御。
```

不建议在正式工程文档中使用“支付宝级安全”这类表述。更准确的定位是：

```text
SciFig 纵深防御升级：用户代码、文件路径、数据隔离与服务器安全
```

## 2. 当前最高危攻击路径

| 编号 | 攻击路径 | 风险等级 | 典型后果 |
|---|---|---:|---|
| 1 | Python/R 远程代码执行 RCE | 极高 | 执行系统命令、读取服务器文件 |
| 2 | 用户代码读取 `.env` 或 SQLite 数据库 | 极高 | 泄露 JWT_SECRET、用户数据、兑换码 |
| 3 | 用户代码联网外传数据 | 极高 | 将数据上传到攻击者服务器 |
| 4 | 路径穿越读取敏感文件 | 高 | 读取配置、数据库、项目文件 |
| 5 | 伪造 admin token 或滥用 admin API | 高 | 生成兑换码、修改订阅、访问后台 |
| 6 | 登录暴力撞库 | 高 | 撞出账号或批量攻击 |
| 7 | 项目接口缺少 user_id 边界 | 高 | 用户 A 访问或删除用户 B 项目 |
| 8 | 渲染/导出接口被滥用 | 中高 | CPU、内存、磁盘、进程数被打满 |

优先级结论：

```text
Python/R 沙箱、禁网、低权限、路径边界、资源限制、user_id 越权控制必须进入 P0。
AST 静态分析有价值，但不能作为最终安全边界。
```

## 3. 设计原则

### 原则一：先修能直接打穿服务器的漏洞

优先处理：

```text
RCE
敏感文件读取
路径穿越
跨用户越权
admin 接口滥用
资源耗尽
```

后期再处理：

```text
SQLCipher
KMS
Database-Per-User
深度 WAF 规则
第三方渗透测试
```

### 原则二：AST 只是预检层

Python/R AST 或静态规则只能发现明显危险模式，例如：

```text
subprocess
socket
requests
urllib
eval
exec
compile
__import__
pickle
ctypes
threading
multiprocessing
```

真正的安全边界必须是：

```text
渲染沙箱
禁网
低权限用户
只读文件系统
文件访问白名单
资源限制
临时目录隔离
```

### 原则三：灰度上线，不一次性强拦截

推荐顺序：

```text
外层 Web 安全加固
路径与文件边界
资源限制
AST log-only
高危操作强拦截
容器级沙箱
账号与数据隔离深度升级
```

## 4. 分阶段升级计划

## 4.0 当前实施状态

截至本次升级，以下低风险安全基线已经落地：

```text
已完成：隐藏 X-Powered-By
已完成：基础安全响应头
已完成：全局 API 限流
已完成：登录 / 注册限流
已完成：渲染 / patch / code-patch / 导出 / 组合接口限流
已完成：JSON 请求体 50 MB 限制
已完成：上传文件 50 MB / 20 文件限制
已完成：Multer 上传错误统一 API 响应
已完成：safeResolveUnder 路径边界函数
已完成：项目上传目录、项目文件删除、数据集读取、组合项目复制、导出资产下载/删除/zip 路径边界
已完成：renderer 进程不再继承完整 process.env
已完成：renderer 最小 allowlist env，保留 PATH / 系统运行变量 / Matplotlib 缓存目录
已完成：Python AST 默认 log-only，SCIFIGURE_AST_ENFORCE=1 时强拦截
已完成：安全 baseline smoke 测试脚本
已完成：projects / sessions 增加 user_id 所有权字段和兼容迁移
已完成：项目、Figure、文件、导出资产和组合项目接口强制登录
已完成：项目 CRUD 使用 id + user_id 双条件访问
已完成：session 使用 session_id + user_id 双条件访问
已完成：上传落盘前执行项目所有权校验
已完成：前端项目与 Figure 请求统一携带 Bearer Token
已完成：双账号项目隔离真实 API 测试
已完成：Python / R 独立 renderer 镜像
已完成：renderer 禁网、只读根文件系统、cap_drop、no-new-privileges、PID / 内存 / CPU 限制
已完成：renderer 仅挂载单次任务 payload 和允许的数据副本，不挂载主数据库或项目根目录
已完成：Argon2id 新密码存储，旧 PBKDF2 登录后自动迁移
已完成：15 分钟 access token + HttpOnly SameSite=Strict refresh cookie
已完成：refresh token 单次轮换、旧令牌重放拒绝和 logout 撤销
已完成：前端 401 自动刷新 access token 并重试一次
已完成：data / tmp / output / Playwright 快照 / tmp_* 运行时内容解除 Git 跟踪，本地文件保留
已完成：仓库数据边界检查，阻止运行时用户数据、SQLite、私钥和常见 token 进入提交
已完成：GitHub Actions 安全门禁
已完成：restic 客户端加密备份脚本，SQLite 一致性快照和 integrity_check
已完成：加密备份恢复验证脚本
已完成：systemd 六小时备份定时任务模板
已完成：生产数据盘加密、权限、备份、恢复和 Git 历史清理运行手册
已完成：users.role 数据库角色模型，新用户默认 user
已完成：管理接口使用 Bearer Token + 数据库 admin 角色实时二次鉴权
已完成：旧 x-admin-secret 管理入口失效
已完成：admin_audit_logs 管理审计表和审计查询接口
已完成：兑换码创建审计脱敏，不记录兑换码明文
已完成：离线管理员授权/撤销命令
已完成：独立临时 SQLite 的管理员鉴权专项 API 测试
已完成：R 脚本静态风险预检，支持 log-only 和 block-high
已完成：R 直接渲染拒绝客户端 cwd / uploaded_file_paths
已完成：renderer 文件复制限制到用户所属项目 files 目录
已完成：生产环境强制 Docker renderer，local 配置拒绝启动
已完成：本地 R 超时终止顺序修复和 renderer 输出大小限制
已完成：R 容器主数据库读取与联网探测测试
已完成：XLS/XLSX 服务端解析移出 Express 进程，生产走受限 Docker parser，开发走独立本地 Python 进程
已完成：XLS/XLSX parser 超时、输出、内存、CPU、PID 和临时目录限制
已完成：Docker 构建上下文排除 data、数据库、tmp、output 和测试产物
已完成：每个 renderer/parser 任务使用唯一容器名，超时、输出越界或请求中止时执行 docker rm -f
已完成：R SVG 转 PNG/PDF/TIFF 在 Docker 模式下进入禁网、只读、低权限 renderer 容器
已完成：本地 Python renderer 补充输出上限，并修复 SIGTERM 后 SIGKILL 判断
已完成：非 development/test 环境默认使用 Docker；显式 local 配置会拒绝启动，除非设置仅限开发应急的 unsafe override
已完成：R 风险扫描覆盖反引号调用、已知危险动态分派和 processx/httr/curl/reticulate/Rcpp 等命名空间危险函数
已完成：能力包仅加载降级为 warning，避免误伤 parallel 等正常科研脚本
已完成：XLS/XLSX parser 改为异步子进程并设置独立并发队列，不再用 spawnSync 阻塞 Node 事件循环
已完成：工作簿 metadata 只读获取表头/行数；预览按 limit 读取，不再先序列化整张表
已完成：records 不进入长期缓存；解析失败时清理未登记的上传文件
已完成：上传文件在 Multer 落盘前执行项目所有权校验
```

验证记录：

```text
npx tsc --noEmit：通过
npm test：通过，8 files / 66 tests
npm run build：通过，仅保留既有 chunk size 与 import.meta CJS warning
npm run test:security-baseline：通过
npm run test:composition-code-project：通过
npm run test:auth-refresh：通过，refresh token 轮换且旧 token 重放返回 401
npm run test:renderer-sandbox：通过，Python/R 正常渲染，R PNG 导出成功，宿主数据库读取和网络访问失败，R 死循环终止后可恢复
tests/test_tabular_parser.py：通过，4 项 XLSX metadata、records、preview limit 和损坏文件测试
Docker renderer 简单图基准：Python 约 2.4-4.0 秒，R 约 2.5-3.0 秒
Docker renderer 4 并发基准：约 4.6 秒全部完成
```

仍未完成：

```text
R 静态风险预检已完成；生产启用 block-high 前仍需真实 R 项目兼容矩阵，包加载本身保持 warning-only
admin 鉴权与基础审计已完成；异常告警、审计归档和更完整的管理操作覆盖仍待生产化
Database-Per-User、SQLCipher、KMS 仍未进入实施阶段
当前 Git 索引已解除运行时数据跟踪，但尚未提交这一索引变更
旧 Git 提交历史仍可能保留用户数据；历史重写需要单独冻结仓库并获得明确授权
```

### Phase 0：立即安全基线

目标：先切断最高危攻击链，不等待完整安全体系。

任务：

```text
P0.1 renderer 独立低权限运行
P0.2 renderer 不继承服务器敏感环境变量
P0.3 renderer 无权访问 .env、data/scifigure.db、主数据库目录
P0.4 所有文件路径统一 safeResolve
P0.5 所有 project / figure / export 查询补 user_id 边界
P0.6 登录、注册、渲染、导出接口限流
P0.7 渲染任务超时，超时后 SIGTERM + SIGKILL
P0.8 请求体、上传文件、输出文件设置大小限制
P0.9 Helmet 安全响应头，隐藏 x-powered-by
P0.10 admin 接口服务端二次权限校验
```

验收标准：

```text
恶意脚本无法读取 process.env 中的敏感字段
恶意脚本无法读取 .env 和主数据库
../.env、../../data/scifigure.db 被拒绝
登录/注册/渲染/导出频繁请求返回 429
死循环渲染会被终止
用户 A 不能读取/删除用户 B 的项目
正常 Python/R 绘图不受影响
```

### Phase 1：用户代码执行防护

目标：让 Python/R 用户代码在可控边界内运行。

任务：

```text
P1.1 Python AST 静态预检
P1.2 R 脚本静态预检
P1.3 import 白名单策略
P1.4 禁止用户脚本直接读取任意路径
P1.5 统一通过平台注入的 _uploaded_data / _uploaded_file_paths 访问上传数据
P1.6 高危调用 log-only 后逐步 block
P1.7 renderer 禁网
P1.8 renderer 只读根文件系统
P1.9 tmpfs 限额
P1.10 CPU、内存、进程数限制
```

灰度策略：

```text
第一阶段：只记录风险，不阻断
第二阶段：阻断明确高危操作，如 subprocess、socket、requests、eval、exec
第三阶段：逐步收紧 import 白名单和文件访问白名单
```

验收标准：

```text
import subprocess 被记录或拦截
requests/socket 联网外传被拦截
正常 matplotlib/pandas/ggplot 脚本能继续运行
R 和 Python 走同一风险记录协议
```

### Phase 2：账号、会话与 admin 安全

目标：降低账号被盗、token 泄露、CSRF、admin 权限滥用风险。

任务：

```text
P2.1 密码迁移到 Argon2id
P2.2 access token 短期化
P2.3 refresh token 使用 httpOnly Cookie
P2.4 refresh token rotation
P2.5 logout / revoke token
P2.6 状态改变接口接入 CSRF 防护
P2.7 登录失败记录和账号维度限流
P2.8 异常登录提醒
P2.9 admin API 从数据库重新确认角色，不只相信 JWT role
P2.10 admin 操作审计日志
```

验收标准：

```text
旧密码可平滑迁移
refresh token 不能被前端 JS 读取
普通用户无法伪造 admin API
兑换码生成、订阅修改、用户状态变更有审计记录
```

### Phase 3：数据隔离与审计

目标：阻止越权访问，并让高风险操作可追踪、可恢复。

任务：

```text
P3.1 projects / project_figures / export_assets / project_files 补 user_id 访问边界
P3.2 所有 update/delete SQL 使用 WHERE id = ? AND user_id = ?
P3.3 禁止前端传 user_id 决定资源归属
P3.4 越权访问单元测试和接口测试
P3.5 项目删除、导出、订阅、兑换码、admin 操作接入审计日志
P3.6 审计日志 hash-chain
P3.7 定期备份
P3.8 恢复演练
```

验收标准：

```text
用户 A 无法读取用户 B 的项目、导出资产、上传文件
伪造 projectId / exportAssetId 不返回敏感数据
关键操作可在审计日志中追踪操作者、时间、资源 ID、结果
```

### Phase 4：生产运营安全

目标：从代码层安全升级到持续安全运营。

任务：

```text
P4.1 WAF
P4.2 云日志服务
P4.3 告警：邮件 / 企业微信 / 钉钉
P4.4 KMS 管理生产密钥
P4.5 依赖漏洞扫描
P4.6 镜像漏洞扫描
P4.7 半年一次第三方渗透测试
P4.8 安全事件应急预案
```

注意：

```text
WAF 不能替代应用层安全。
它能挡扫描器、路径探测、SQL 注入和异常流量，但挡不住合法接口提交的恶意 Python/R 代码。
```

## 5. 对当前服务的影响评估

| 升级项 | 服务影响 | 建议 |
|---|---:|---|
| Helmet | 很低 | 立即做 |
| 登录/注册限流 | 很低 | 立即做 |
| 全局 API 限流 | 低 | 立即做，阈值先宽松 |
| 请求体大小限制 | 低 | 立即做，结合真实 CSV 大小 |
| safeResolve | 低 | 立即做 |
| renderer 不继承敏感 env | 低 | 立即做 |
| user_id 查询边界 | 低到中 | 立即做，补测试 |
| 渲染超时 | 中 | 温和阈值，先 60 秒 |
| 上传大小限制 | 中 | 先宽松，如 50 MB |
| AST 静态分析 | 中到高 | 先 log-only |
| 容器禁网 | 中 | 先确认 Python/R 依赖不需联网 |
| 只读根文件系统 | 中 | 处理 Matplotlib / R 缓存目录 |
| Database-Per-User | 高 | 后期做 |
| SQLCipher | 高 | 后期做 |
| KMS | 中到高 | 生产化阶段做 |

## 6. 关键实现方案

### 6.1 safeResolve 路径边界

所有用户输入路径必须进入统一函数。

要求：

```text
禁止绝对路径
禁止 ..
禁止 \0
禁止 file://、http://、https://、s3:// 等协议
禁止符号链接逃逸
上传文件名由服务器重新生成
文件读取写入必须落在项目授权目录内
```

示意：

```typescript
import fs from 'fs';
import path from 'path';

export function safeResolve(baseDir: string, userPath: string): string {
  if (!userPath || typeof userPath !== 'string') {
    throw new Error('Invalid path');
  }

  if (
    userPath.includes('\0') ||
    path.isAbsolute(userPath) ||
    /^[a-zA-Z][a-zA-Z0-9+.-]*:/.test(userPath)
  ) {
    throw new Error('Forbidden path');
  }

  const resolvedBase = fs.realpathSync(path.resolve(baseDir));
  const resolvedPath = path.resolve(resolvedBase, userPath);
  const parent = fs.existsSync(resolvedPath)
    ? fs.realpathSync(resolvedPath)
    : path.resolve(resolvedBase, userPath);

  if (parent !== resolvedBase && !parent.startsWith(resolvedBase + path.sep)) {
    throw new Error('Path traversal blocked');
  }

  return resolvedPath;
}
```

### 6.2 renderer 进程环境隔离

错误方式：

```typescript
spawn(pythonBin, args, {
  env: process.env
});
```

推荐方式：

```typescript
spawn(pythonBin, args, {
  env: {
    PATH: '/usr/bin:/usr/local/bin',
    HOME: '/tmp',
    MPLCONFIGDIR: '/tmp/matplotlib',
    TMPDIR: '/tmp'
  },
  uid: 9999,
  gid: 9999
});
```

不得传入：

```text
JWT_SECRET
DB_PATH
DATABASE_URL
ADMIN_SECRET
STRIPE_SECRET
ALIPAY_SECRET
KMS_KEY
.env 内容
```

### 6.3 项目访问绑定 user_id

错误方式：

```sql
SELECT * FROM projects WHERE id = ?
```

推荐方式：

```sql
SELECT * FROM projects WHERE id = ? AND user_id = ?
UPDATE projects SET name = ? WHERE id = ? AND user_id = ?
DELETE FROM projects WHERE id = ? AND user_id = ?
```

后端必须从认证上下文取 userId，不接受前端传入的 user_id 决定资源归属。

### 6.4 渲染任务资源限制

建议默认值：

```text
单次渲染超时：60 秒
单用户并发渲染：1-2
单 IP 并发渲染：2-5
上传文件大小：50 MB 起步，生产可按套餐调整
独立 renderer worker、队列持久化和孤儿容器定时巡检仍待生产化
Excel 浏览器端预览仍使用前端 xlsx 包；服务端攻击面已隔离，后续可评估 Web Worker
```

进程终止策略：

```text
超时先 SIGTERM
3-5 秒后仍未退出则 SIGKILL
记录审计日志和渲染诊断
```

### 6.5 SVG 与导出内容安全

平台会返回和保存 SVG，因此还需要防止 SVG XSS。

要求：

```text
前端展示 SVG 必须 sanitize
后端保存外部导入 SVG 前应 sanitize 或标记来源
禁止 SVG 中 script、foreignObject、onload/onerror 等事件属性
下载文件使用安全 Content-Type 和 Content-Disposition
导出文件名必须 safeExportName
```

### 6.6 依赖与密钥安全

要求：

```text
.env 不进入 Git
生产密钥定期轮换
CI 检查密钥泄露
npm/pip/R package 依赖定期漏洞扫描
生产和开发使用不同密钥
日志不打印 token、cookie、password、license code 全量值
```

## 7. PR 拆分建议

### PR-1：低风险 Web 安全基线

```text
安装 helmet
安装 express-rate-limit
登录接口限流
注册接口限流
全局 API 限流
请求体大小限制
隐藏 x-powered-by
检查 .env 不进入 Git
```

### PR-2：路径与文件访问加固

```text
新增 safeResolve
所有文件读取写入统一接入 safeResolve
禁止绝对路径、..、协议路径
上传文件重命名
限制上传大小
导出文件名安全化
```

### PR-3：跨用户数据访问控制

```text
所有 project 查询加 user_id
所有 figure 查询加 user_id
所有 export 查询加 user_id
所有 update/delete 加 user_id
后端使用 auth userId
补越权访问测试
```

### PR-4：渲染进程隔离

```text
renderer 不继承 process.env
renderer 最小 env
renderer 低权限运行
renderer 超时强杀
渲染并发限制
临时文件清理
```

### PR-5：AST 风险预检

```text
Python AST validator
R validator
log-only 风险记录
高危 import / call 识别
正常脚本兼容性样本测试
```

### PR-6：沙箱容器化

```text
renderer 容器独立运行
network_mode: none
read_only: true
tmpfs /tmp
cap_drop: ALL
no-new-privileges
seccomp profile
```

### PR-7：账号与 admin 安全

```text
Argon2id
短期 access token
httpOnly refresh token
CSRF
admin 二次鉴权
admin 审计
```

## 8. 测试与验收矩阵

| 测试类型 | 核心用例 |
|---|---|
| 路径穿越 | `../.env`、`../../data/scifigure.db`、绝对路径、协议路径均拒绝 |
| RCE | `subprocess.run()`、`os.system()`、`socket`、`requests` 被记录或拦截 |
| 环境变量 | 用户脚本读取不到 JWT_SECRET / ADMIN_SECRET |
| 数据隔离 | 用户 A 无法读写用户 B 的项目和导出资产 |
| 限流 | 登录、注册、渲染、导出频繁请求返回 429 |
| 超时 | 死循环脚本被终止，服务不挂死 |
| 正常回归 | Python/R 正常绘图、编辑、导出不受影响 |
| SVG 安全 | 恶意 SVG script/event 属性不执行 |
| admin | 普通用户无法访问兑换码和订阅管理接口 |

## 9. 参考标准

- OWASP Password Storage Cheat Sheet：推荐使用 Argon2id 等专用慢哈希算法存储密码。
- OWASP Cross-Site Request Forgery Prevention Cheat Sheet：CSRF 应结合 token、SameSite Cookie 和请求头校验。
- OWASP File Upload Cheat Sheet：上传文件需要扩展名、大小、内容、路径和存储隔离多层校验。
- Docker 官方文档 Seccomp security profiles：seccomp 可限制容器内进程可用系统调用，是容器最小权限的重要控制面。

## 10. 最终结论

SciFig 的安全升级方向应从“账号和数据库安全优先”调整为：

```text
用户代码执行安全优先
文件路径安全优先
跨用户数据边界优先
资源限制优先
账号与审计随后完善
```

最应优先落地的是：

```text
renderer 沙箱隔离
renderer 禁网
renderer 不继承敏感 env
safeResolve
user_id 强边界
限流与超时
```

这些能力完成后，平台才能从“能运行用户绘图代码”升级为“能相对安全地运行用户绘图代码”。
