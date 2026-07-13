# SciFigure Ubuntu 24.04 单机部署运行手册

> 状态：当前有效，首次云端部署执行中
> 创建时间：2026-07-13 19:42:42 +08:00
> 最后更新：2026-07-13 19:42:42 +08:00
> 目标：2 核 4 GB 调试服务器；本人和少量协作者使用

## 1. 部署边界

```text
公网 80/443
-> Nginx
-> 127.0.0.1:3101 单个 SciFigure Node 服务
-> rootless Docker renderer（并发 1）
-> /srv/scifigure/data
```

服务器只运行最新升级版。release 构建期间旧版本可以继续运行；切换阶段旧实例排空并停止后才启动新实例，禁止两个 Node 进程同时写 SQLite。

## 2. 文件布局

```text
/opt/scifigure/releases/<build-id>  不可变 release
/opt/scifigure/current              当前 release 软链接
/etc/scifigure/common.env           运行边界与资源配置
/etc/scifigure/release.env          当前 build/image
/srv/scifigure/data                 用户数据库、项目和导出资产
/var/lib/scifigure                  rootless Docker、观察和发布状态
```

部署脚本不得删除或覆盖 `/srv/scifigure/data`。首次服务器没有用户数据时也保持同一红线。

## 3. 首次安装

1. 在本地通过完整测试并提交不可变 commit。
2. 使用 `git archive` 生成源码包，不包含 `data/`、`.env`、密钥、`node_modules` 和临时测试资产。
3. 上传源码包和 `ops/`，先在 `/tmp` 执行 `bash -n`。
4. 运行 `bootstrap-ubuntu.sh` 安装 Node 22、Nginx、rootless Docker、Certbot、SQLite 和备份工具。
5. 创建 4 GB Swap；renderer 使用 1 CPU、896 MB、并发 1。
6. 运行 `scifigure-deploy-release <artifact> <build-id>`。
7. 验证 `/api/health/live`、`/api/health/ready` 和 `unified-editing-build.json`。
8. 配置 TLS 后才允许注册、登录和上传真实数据。

## 4. 发布和回滚

正常发布：

```bash
sudo scifigure-deploy-release /tmp/scifigure-<build-id>.tar.gz <build-id>
```

失败行为：

```text
构建失败：当前服务不变
renderer 镜像失败：当前服务不变
新服务 readiness 失败：自动恢复上一 release
```

人工回滚：

```bash
sudo scifigure-rollback
```

回滚只使用 `previous-release` 中记录的 last-known-good 版本，不猜测槽位。

## 5. TLS 和公网入口

Node 端口只绑定 loopback，云安全组和 UFW 不开放 3101。公网仅开放：

```text
SSH：实际 sshd 端口，云安全组优先限制为管理员来源 IP
HTTP 80：证书签发和 HTTPS 跳转
HTTPS 443：平台访问
```

Nginx 覆盖客户端传入的 `X-Forwarded-For`。TLS 配置使用固定域名跳转，证书续期后通过 deploy hook 执行 `nginx -t` 和 reload。

## 6. 首次云端验收

必须保留证据：

```text
Node 22、Nginx、rootless Docker 版本
只有 80/443/SSH 对公网开放
只有一个 scifigure.service 活跃
renderer network=none、read-only、非 root、资源限制
Python/R 正常绘图
危险网络和宿主文件读取失败
SIGTERM 等待在途渲染后退出
readiness 失败自动恢复上一 release
跨用户项目访问被拒绝
备份、独立目录恢复和 SQLite integrity_check 通过
```

未完成以上验收前，该服务器只能作为调试环境，不能宣称为正式生产环境。
