# 安全审计报告当前状态校准

## 1. 结论

原报告对限流、安全响应头、Argon2id、R 风险扫描、路径边界和管理审计的识别方向基本正确，但部分结论已经过时，部分建议不能在未做兼容性验证时直接执行。

当前平台的主要安全边界是：

```text
认证与 user_id 所有权检查
路径真实边界检查
生产环境强制 Docker renderer
renderer 禁网、只读、低权限和资源限制
用户文件仅以单次任务副本进入容器
渲染、表格解析和导出转换的超时与输出限制
静态预检作为补充告警/阻断层
```

静态 AST 或 R 正则扫描不能替代 Docker 沙箱。

## 2. 原报告结论校准

| 原报告结论 | 当前证据 | 校准结果 |
|---|---|---|
| 登录/注册限流是否挂载待确认 | `server.ts` 的 register、login、refresh 均挂载 `authRateLimit` | 已确认完成 |
| JWT 双 Token 服务层未接入 | `server.ts` 已签发 access/refresh token，refresh 使用 HttpOnly Cookie 并执行 rotation；`db.ts` 存储哈希 | 功能已完成；采用不透明 Token，不依赖 `jsonwebtoken` |
| 用户隔离路由层待验证 | 项目和 session 查询绑定认证用户，并有 `test:user-isolation` | 已实现并有专项测试 |
| Argon2id 19 MB 明显不足 | 当前参数为 memoryCost 19456、timeCost 2、parallelism 1 | 属于可接受基线；不应在未做并发基准时直接提高到 64 MB |
| 必须立即同时开启 Python/R enforce | 当前默认 log-only，生产最终边界为 Docker | 需先跑真实脚本兼容矩阵，再分阶段启用；不可直接强开 |
| R 高风险包应直接阻断 | 当前只对具体危险能力调用进行阻断，单纯加载 parallel/Rcpp 等为 warning | 已调整，降低正常科研脚本误伤 |
| Phase 2/3 均未开始 | 已有 refresh rotation、admin 二次鉴权、审计、备份脚本、Docker renderer 等 | 原完成率已过时 |
| CSP 尚未设置 | 当前安全头中确实没有 CSP | 风险仍存在，需要专项设计和浏览器回归 |

## 3. 不应直接照搬的建议

### 3.1 不直接使用含 unsafe-inline 的 CSP 模板

原报告建议的 CSP 包含：

```text
script-src 'self' 'unsafe-inline'
style-src 'self' 'unsafe-inline'
```

这类策略会降低 CSP 对内联脚本注入的防护能力，而且没有覆盖当前 Vite 开发模式、SVG 展示、Blob 下载、Web Worker、字体和数据 URL 的完整资源清单。

正确流程应为：

```text
先以 Content-Security-Policy-Report-Only 上线
收集真实违规项
建立 script/style nonce 或 hash 策略
验证 SVG、导出、预览和开发服务器
再切换为强制 CSP
```

### 3.2 不直接提高 Argon2 内存参数

提高单次密码哈希内存会同时放大登录并发时的服务器内存消耗。参数调整必须结合目标服务器、登录限流和并发压测，不能只依据单个推荐值修改。

### 3.3 不把静态扫描当作 RCE 安全边界

Python/R 都支持反射、动态调用、原生扩展和复杂包内部行为。即使开启 enforce，也不能证明用户代码安全。公网生产必须继续保持 Docker renderer、禁网、只读文件系统、最小环境变量和资源限制。

## 4. 报告生成后新增的安全能力

截至当前代码，原报告未覆盖或未完全覆盖的新增能力包括：

- 非 development/test 环境禁止降级到 local renderer。
- R 风险扫描覆盖反引号、命名空间和已知危险动态分派。
- R 能力包加载为 warning，具体进程、联网和原生代码调用保持阻断。
- XLS/XLSX 服务端解析移出 Express 进程。
- 表格解析使用异步子进程、独立并发队列和预览行数限制。
- 表格 metadata 不再加载完整工作簿，records 不进入长期缓存。
- 未登记上传文件在解析失败时清理。
- R SVG 转 PNG/PDF/TIFF 在生产 Docker 沙箱中执行。
- Docker 构建上下文排除 `data/`、数据库、`tmp/` 和输出资产。
- renderer/parser 容器使用唯一名称和管理标签，异常时强制删除。
- 沙箱测试验证 R 死循环恢复、R PNG 导出和零残留容器。

## 5. 仍需处理的事项

### 上线前阻断项

- 云服务器上的 Docker、文件权限和网络隔离复测。
- TLS、防火墙、SSH 最小权限和安全组配置。
- 加密备份真实执行及恢复演练。
- CSP Report-Only 设计与前端兼容回归。
- 真实 Python/R 项目兼容矩阵完成后再决定 enforce 策略。
- 镜像漏洞扫描、依赖固定和基础镜像 digest 管理。

### 非阻断但应继续验证

- 真实 BIFF `.xls` 文件兼容性。
- 大型合法工作簿的解析时间和资源阈值。
- renderer worker 独立进程/服务化及孤儿容器巡检。
- 管理审计归档和异常操作告警。

## 6. 已验证命令

最近一次安全升级已验证：

```text
npx tsc --noEmit
npm test
npm run build
npm run test:security-baseline
npm run test:r-security-precheck
npm run test:renderer-sandbox
npm run security:repo-boundary
tests/test_tabular_parser.py
```

原报告中的评分和完成率是时间点判断，不作为当前验收结论。当前是否允许公网部署，应以 P0 阻断项和云服务器实测结果为准。

