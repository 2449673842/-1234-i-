# SciFig R 语言执行安全风险审计

更新时间：2026-07-10

## 1. 审计范围

本次审计覆盖：

```text
R 直接渲染 API
项目 R 渲染和 patch 重放
uploaded_file_paths / cwd 文件注入
本地 Rscript 子进程
Docker R renderer
R 脚本静态风险预检
进程超时、输出和资源限制
R 文件读取与联网测试
```

主要实现位置：

```text
server.ts
renderer/r_renderer.R
Dockerfile.renderer
src/utils/rRiskScanner.ts
tests/api/r_security_precheck_smoke.mjs
tests/api/renderer_sandbox_smoke.mjs
tests/test_r_renderer.py
```

## 2. 总体结论

R renderer 的最终安全边界是 Docker 沙箱，不是静态规则。

修复前存在一条可直接绕过容器挂载隔离的高危链路：客户端可以向 R 直接渲染接口提交任意 `cwd` 和 `uploaded_file_paths`，Web 进程会在启动容器前尝试复制这些宿主机文件。该链路现已关闭。

当前安全模型：

```text
客户端不能提交任意 R 文件路径
→ 项目接口从数据库读取用户所属上传文件
→ Web 进程只复制项目 files 目录中的文件
→ Docker 只读挂载单次任务目录
→ renderer 以非 root 用户运行
→ 禁网、限 CPU、限内存、限 PID、限 /tmp、限输出
→ 超时或请求取消时终止任务
```

## 3. 风险与处置结果

| 等级 | 风险 | 修复前表现 | 当前处置 | 验证 |
|---|---|---|---|---|
| 严重 | 客户端路径导致宿主机任意文件复制 | R 直接渲染可提交绝对路径和任意 cwd | 直接 R 渲染拒绝客户端路径；项目文件必须位于用户项目 files 目录 | `test:r-security-precheck` |
| 严重 | 生产环境误用 local renderer | R 代码可能以 Web 服务账号直接执行 | `NODE_ENV=production` 时强制 `SCIFIGURE_RENDER_MODE=docker`，错误配置拒绝启动 | `test:r-security-precheck` |
| 高 | 本地 R 超时未真正 kill | 超时回调先设置 settled，`killChild()` 随后直接返回 | 调整终止顺序；使用 SIGTERM 后按进程是否关闭决定 SIGKILL | 类型检查和 R 回归测试 |
| 高 | renderer 输出无上限 | 恶意脚本可持续打印，增加 Node 内存占用 | Docker 和本地 R 默认限制 stdout/stderr 合计 8 MB | 类型检查、构建 |
| 高 | R 无静态风险预检 | `system2()`、`download.file()` 等直接进入执行阶段 | 新增 log-only / block-high 风险扫描器 | 单元测试、`test:r-security-precheck` |
| 高 | 正则预检可被反引号、动态分派和命名空间调用绕过 | ``base::`system`()``、`get("system2")()`、`processx::run()` 未命中 | 增加反引号归一化、已知危险动态目标和命名空间函数规则 | 6 项单元测试、API smoke |
| 中 | 按包名阻断误伤科研脚本 | 加载 `parallel`、`Rcpp` 等即拒绝 | 包加载改为 medium warning，只阻断具体危险能力调用 | `test:r-security-precheck` |
| 高 | R 沙箱测试只验证正常绘图 | 未验证 R 读取主数据库和联网 | 增加 R 文件读取和网络访问探测 | `test:renderer-sandbox` |
| 高 | R 非 SVG 导出在宿主机转换 | CairoSVG 可能处理用户生成的 SVG 外部资源 | Docker 模式下 `svg_convert.py` 进入同一禁网、只读、低权限容器 | `test:renderer-sandbox` 的 R PNG 导出 |
| 中 | 容器用户依赖镜像默认 USER | 运行命令未显式指定用户 | Docker run 增加 `--user 65532:65532` | Docker sandbox smoke |

## 4. 文件访问边界

### 4.1 直接 R 渲染

`POST /api/figure/render` 不再接受：

```text
客户端 cwd
客户端 uploaded_file_paths
绝对路径
历史工程路径
服务器其他用户项目路径
```

需要读取文件时，用户必须先创建项目、上传文件，再使用项目渲染接口。

### 4.2 项目 R 渲染

项目渲染的允许文件来源为：

```text
data/projects/<当前用户拥有的 projectId>/files/
```

文件列表由后端根据项目数据库记录生成。复制前再次执行路径归一化、目录边界和真实文件检查。

### 4.3 Docker 挂载

容器只获得：

```text
/work/payload.json
/work/files/* 当前任务允许的数据副本
/tmp 限额临时目录
```

容器不挂载：

```text
data/scifigure.db
.env
项目根目录
其他用户目录
宿主机 Docker socket
```

## 5. R 静态风险预检

实现：`src/utils/rRiskScanner.ts`

默认模式：

```text
SCIFIGURE_R_RISK_ENFORCE=0
```

默认只记录并将风险信息附加到 warnings，不阻断兼容脚本。

生产审核后可启用：

```text
SCIFIGURE_R_RISK_ENFORCE=1
```

阻断的 critical/high 类别包括：

```text
system / system2 / shell / pipe
socketConnection / serverSocket / download.file
install.packages / download.packages
dyn.load
unlink / file.remove / file.rename
processx::run / callr::r
httr::GET / httr2::req_perform / curl fetch
reticulate::py_run_* / Rcpp::sourceCpp / ssh::ssh_connect
get("system2") / do.call("system", ...) 等已知危险动态目标
```

只记录、不作为默认阻断的动态能力包括：

```text
eval
parse
do.call
readLines
readRDS
file connections
Sys.getenv
source / sys.source / setwd / Sys.setenv
parallel / future / Rcpp 等能力包的单纯加载
```

这些调用在科研脚本中可能存在合法用途，因此当前依靠 Docker 文件系统、最小环境变量和禁网进行最终限制。

## 6. Docker 安全参数

当前 renderer 使用：

```text
--network none
--read-only
--cap-drop ALL
--security-opt no-new-privileges
--user 65532:65532
--pids-limit 128
--memory 1g
--cpus 1
--tmpfs /tmp:rw,noexec,nosuid,size=256m
单次输出默认最大 8 MB
单次任务超时默认 45 秒
```

## 7. 已验证结果

```text
npx tsc --noEmit：通过
npx vitest run src/utils/rRiskScanner.test.ts：5/5 通过
npm run test:r-security-precheck：通过
tests/test_r_renderer.py：17/17 通过
npm run test:renderer-sandbox：通过
```

专项验证证明：

```text
客户端路径注入返回 400
生产 local renderer 启动失败
system2 在 R 执行前被阻断
高风险 R 包在执行前被阻断
正常 R/ggplot 语义渲染测试保持通过
R 容器无法读取主数据库路径
R 容器无法访问公网
```

## 8. 剩余风险

### 8.1 local 模式仍是可信开发模式

开发环境设置 `SCIFIGURE_RENDER_MODE=local` 时，R 脚本仍由本机 Rscript 执行。local 模式只能用于开发者自己的可信脚本，不得用于公网用户代码。

### 8.2 静态扫描可以被绕过

R 允许别名、反射、动态函数查找和包内部调用。静态扫描只能拦截明显高危模式，不能证明脚本安全，也不能替代 Docker。

### 8.3 R renderer 使用 `eval(parse(...))`

执行用户脚本是平台的核心功能，因此 R renderer 必须解析并执行脚本。该能力不能通过删除 `eval(parse())` 解决，只能通过容器隔离、文件白名单、禁网和资源限制控制。

### 8.4 Docker 超时后的容器级确认

当前每个任务使用唯一容器名。超时、输出越界或请求中止时，服务端先执行 `docker rm -f`，再终止附着的 Docker 客户端；专项测试已验证 R 死循环终止后后续渲染可恢复。生产阶段仍建议增加孤儿容器定时巡检和告警。

### 8.5 镜像供应链

当前基础镜像和 apt/R 包未固定到不可变 digest。正式生产应锁定镜像 digest、执行镜像漏洞扫描并建立更新流程。

### 8.6 XLSX 服务端解析已隔离

XLS/XLSX 不再由 Express 进程中的 `xlsx` 包直接解析。生产环境将文件副本只读挂载到受限 Docker parser；开发环境使用独立 Python 子进程，并统一设置超时和输出限制。浏览器端仍保留 `xlsx` 用于本地预览兼容，但其结果不具有服务器文件系统权限。

## 9. 当前结论

R 路径中能够直接导致宿主机文件泄露、生产环境直接执行和进程失控的主要代码风险已经封堵，并已有独立测试证据。

公网部署前仍必须完成：

```text
在 Linux 云服务器复测 Docker 沙箱
启用 SCIFIGURE_R_RISK_ENFORCE=1 后运行真实 R 项目兼容矩阵，重点覆盖 source/setwd/临时文件清理
增加独立 renderer worker 和孤儿容器监控
完成镜像漏洞扫描和 digest 锁定
```
