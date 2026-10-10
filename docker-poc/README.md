# 博客号 Docker 自托管（docker-poc/）

> **与 Cloudflare 版共用同一份业务代码**（根目录 `src/`）：全部适配都收在本目录
> （`server.ts` 与 `shims/`），不修改主代码任何文件、不动根 `package.json` /
> `tsconfig.json`、不装任何新依赖进主工程；不想要 Docker 方案时删掉本目录即可，
> 主工程零残留。

## 这是什么

把跑在 Cloudflare Workers（D1 + R2）上的博客号，**业务代码零改动**地搬到一个
普通 Node 进程里，单进程按域名跑多个完全独立的博客站——一台服务器托管 N 个博客。
Cloudflare 在这个架构里只做 DNS + CDN，不再运行代码。已在甲骨文 ARM 实机全链路
排练通过（选机、反代、灵活 SSL、验收 45 项，过程记录见 `REHEARSAL-REPORT.md`）。

```
一个 Node 进程（Docker 容器）
 ├─ Host 路由：按域名切租户
 │    ├─ data/tenants/demo.localhost/blog.db     ← D1 → node:sqlite（WAL）
 │    ├─ data/tenants/demo.localhost/uploads/    ← R2 → 磁盘目录
 │    ├─ data/tenants/main.localhost/blog.db     ← 每个租户完全独立，互不可见
 │    └─ …
 ├─ 静态资源 public/ 直出（对齐 wrangler assets 行为）
 └─ cron：每分钟定时发布；北京时间 00:30 备份/清理（复用 src/index.ts 的 scheduled）
```

## 适配层（shim）只覆盖实际用到的 API 面

对 `src/` 全量 grep 过，Workers 专有 API 的使用面就这些，两个 shim 各一两百行：

| Workers 侧 | 本 POC 侧 | 备注 |
|---|---|---|
| D1 `prepare().bind().first/all/run`、`batch`、`meta.changes/last_row_id` | Node 内置 `node:sqlite` | 行统一转普通对象（node:sqlite 返回 null 原型对象）；batch 用事务实现 |
| R2 `put/get/head/delete/list`、流式 `body`、`httpEtag`、`writeHttpMetadata` | 磁盘目录 + 旁车 `.meta.json` | 正文流式读出，导出 zip「边流边算 CRC」不变；etag 带引号，304 协商同口径 |
| `ExecutionContext.waitUntil` | 记日志的 Promise 兜底 | 经 Hono `app.fetch(req, env, ctx)` 第三参注入 |
| wrangler assets（`public/`） | server.ts 内置静态文件层 | 文件命中才返回，其余进应用 |
| `triggers.crons` | 进程内 setInterval | 分钟级扫定时发布；UTC 16:30 触发备份窗口 |

未触任何雷区的证据：`crypto.subtle`/`getRandomValues`/`TextEncoder` 是全局标准 API，
`src/` 里没有 `HTMLRewriter`/`caches`/KV/Durable Objects。

## 本地跑（不需要 Docker）

```bash
cd docker-poc
npm install          # 只装 esbuild 一个开发依赖（装在本目录，不碰主工程）
npm run build        # 打包成 dist/server.js 单文件（css/sql 以文本内联，同 Workers Text 规则）
npm start            # 默认 127.0.0.1:8787
```

浏览器直接开（`*.localhost` 现代浏览器自动解析到 127.0.0.1）：

- http://demo.localhost:8787 —— 演示租户，首次访问自动建表+播种（demo 账号 demo / demo1234）
- http://t1.localhost:8787 —— 第二个演示租户（种子内容相同，库完全独立）
- http://main.localhost:8787 —— 空库真实租户：首次进 `/admin/` 走「创建管理员」

## 冒烟验证

```bash
npm run smoke
```

覆盖：三租户健康检查、演示租户播种与 RSS、真实租户 注册→登录→发文→传图→图片回读、
**跨租户隔离**（A 租户的文章/图片在 B 租户 404）、后台 SPA 静态直出。

## 存储后端二选一：本地盘 / Cloudflare R2

每个租户独立选择图片存哪：`storage` 缺省/`"local"` = 本地磁盘目录（默认，快、零依赖）；
`"r2"` = Cloudflare R2 共享桶（服务器可随时重建、磁盘无天花板、备份自动异地）。
R2 **零出口流量费**，200GB 图片约 $3/月。

**Cloudflare 后台一次性准备（约 2 分钟）**：

1. R2 → 创建桶（如 `xwblog-images`，位置选 APAC 更近）
2. R2 概览右侧记下 **账户 ID**
3. R2 → 管理 R2 API 令牌 → 创建 API 令牌（权限：对象读和写）→ 记下**访问密钥 ID** 和**机密访问密钥**（只显示一次）

**tenants.json 切到新格式**（旧平铺格式仍兼容）：

```json
{
  "r2": {
    "accountId": "你的账户ID",
    "bucket": "xwblog-images",
    "accessKeyId": "xxx",
    "secretAccessKey": "xxx"
  },
  "tenants": {
    "blog1.example.com": { "demo": false, "storage": "r2" },
    "main.localhost": { "demo": false }
  }
}
```

多租户共享一个桶时按 `<域名>/` 前缀隔离，互相不可见。tenants.json 里是 R2 访问密钥，
注意权限：`chmod 644 tenants.json`——不能 600，容器内 node（uid 1000）经 bind mount 直读
此文件，600 会启动崩溃循环（add-tenant.sh 会自动校正）；宿主机其他普通用户能看到密钥
时，改用把数据目录整体归入独立用户/组的部署方式。

**启用步骤**：

```bash
git pull && XWLBLOG_BIND=127.0.0.1 docker compose up --build -d
# 启动日志出现 [r2] 自检通过：桶 xxx 可达 即配置正确（凭据错会直接启动失败并说明原因）
# 存量图片迁移（幂等，跳过已存在；本地目录保留作回退）：
docker compose exec xwblog node docker-poc/dist/server.js --copy-local-to-r2 blog1.example.com
```

**顺带收益**：应用自带的每晚备份 cron 把数据库快照写进图床桶 `backups/`——桶在 R2 上时
备份自动变成异地备份。进阶（可选）：给桶绑自定义域名后，让 openresty 把 `/images/*`
映射过去，图片请求连服务器都不回源。

## Docker 跑

```bash
cd docker-poc
docker compose up --build      # 镜像约 70MB（node:26-alpine + server.js + public/）
```

数据落在 `docker-poc/data/<域名>/`（挂载进容器 `/data/tenants`）。Linux 服务器上
宿主目录属主不用手工准备——容器入口 `entrypoint.sh` 以 root 起步把数据卷 chown
给 node 后降权运行（与官方 postgres 镜像同款模式，只递归一次，之后跳过）。

## 加一个租户（新博客）

```bash
./add-tenant.sh blog1.example.com           # 登记 → 重启 → 健康检查，一条命令
./add-tenant.sh try.example.com --demo      # 演示种子站（每 2 小时清库重灌）
./add-tenant.sh blog1.example.com --remove  # 下线（数据目录保留）
```

DNS 用泛域名（`*.example.com` 一条 A 记录指向服务器）时无需再动 DNS；逐域名解析
时先加 DNS 再跑脚本。脚本要求宿主机有 jq 或 node 之一（改 JSON 用）。手工方式：

1. `tenants.json` 加一行 `"新域名": { "demo": false }`
2. 重启进程（重启 < 1s）
3. 域名 DNS 指到这台服务器（Cloudflare 橙云代理即可）

## 进阶与边界

- **TLS**：前置 Caddy/nginx 终结 HTTPS（`X-Forwarded-Proto: https` 传进来后，
  会话 cookie 的 Secure 自动恢复）；图片可让反代直接吐 `uploads/` 目录并带
  `Cache-Control: immutable`，连应用都不过
- **CDN**：Cloudflare 橙云代理 + Cache Rule 缓存 `/images/*` 与静态资源
- **备份**：应用内备份 cron 随容器在跑（落每个租户的 `uploads/backups/`，
  图床桶在 R2 上时快照自动异地）；更进一步的实时复制可上 litestream
- **扩容**：进程内 SQLite 连接与租户注册表已是按需懒建形态，横向扩容时把
  「Host→租户」路由换成一致性哈希/分片即可；单机拆机用 rsync 按租户目录迁移
- **热加载租户**：当前加租户要重启进程（重启 < 1s）
- **实测边界**：已在甲骨文 ARM 实机全链路排练通过（`REHEARSAL-REPORT.md`：
  时间线、5 个真 bug 的根因与修复、线上验收 45/45 明细、容量测算）；
  单进程入口另有 `smoke.sh` 端到端冒烟（含 R2 自检断言 20/20）可随时复验

## 访客 IP 信任档位（TRUST_PROXY）

登录 / 文章密码解锁 / 评论 / 点赞的限流都按访客 IP 分桶。自托管时业务读到的 IP
来自 `CF-Connecting-IP` / `X-Forwarded-For` 头——这些头客户端可以随意伪造，**档位
必须与真实部署形态一致**，否则换一个假 IP 就能重置所有限流桶（密码爆破敞开）：

| TRUST_PROXY | 部署形态 | 行为 |
|---|---|---|
| `proxy`（默认） | 本机自控反代（Caddy / Nginx / openresty） | 剥掉入站 `CF-Connecting-IP` / `X-Real-IP`，取 `X-Forwarded-For` **最后一跳**——反代把真实客户端 IP 追加在末尾，客户端伪造的值都在前面 |
| `cf` | Cloudflare 橙云代理直连源站 | 保留 `CF-Connecting-IP`（CF 边缘强制写入不可伪造），剥掉其余可伪造头 |
| `off` | Node 直接暴露公网（无反代） | 全部剥掉，以 socket 远端地址注入 |

旧值 `1`/`0` 分别按 `proxy`/`off` 兼容。三种形态之外的接法（例如多层不可控代理、
CDN 套 CDN）不在覆盖范围，请收敛成上表之一。

## 控制面（多租户管理面板，可选）

`CONTROL_HOST` + `CONTROL_PASSWORD` 两个环境变量都设置才启用：在控制面域名下提供
网页化运维——开通 / 停用 / 启用 / 彻底删除 / 重置站点管理员密码，可选配套
`CF_API_TOKEN` + `CF_ZONE_ID`（开通自动建 DNS 记录）。安全模型：主密码常时比较 +
登录限流、同源 Origin 校验、会话 Cookie HttpOnly（https 链路带 Secure）12 小时、
全部操作进 ops.log。**注意**：控制面要热写 tenants.json，docker compose 里的
tenants.json 挂载不能是 `:ro`；不用控制面时保持未配置状态即可（整体 404 不存在）。

## 文件清单

| 文件 | 说明 |
|---|---|
| `server.ts` | 多租户入口：http 适配、Host 路由、静态资源、cron、TRUST_PROXY 档位 |
| `scheme.ts` | 浏览器侧真实 scheme 判定（租户请求组装与控制面 Cookie Secure 共用） |
| `control.ts` | 多租户控制面（`CONTROL_HOST` 启用）：开通 / 停用 / 删除 / 重置密码 / 操作日志 |
| `shims/d1.ts` | D1 → node:sqlite |
| `shims/r2disk.ts` | R2 → 磁盘目录（默认存储后端） |
| `shims/r2s3.ts` | R2 S3 兼容接口适配层（租户选 `storage: "r2"` 时启用，SigV4 零依赖） |
| `tenants.json` | 域名 → 租户配置（demo 种子开关） |
| `add-tenant.sh` | 开台脚本：登记域名 → 重启 → 健康检查（`--demo` 演示种子 / `--remove` 下线） |
| `smoke.sh` | 端到端冒烟 |
| `entrypoint.sh` | 容器入口：修数据卷属主 → 降权 node 运行 |
| `Dockerfile` / `docker-compose.yml` | 容器化（构建上下文 = 仓库根目录） |
| `DEPLOY.md` | 上服务器排练清单（选型 / 步骤 / Cloudflare 配置 / 排练后事项） |
| `DEPLOY-MICRO.md` | 1GB 小机（甲骨文 E2.1.Micro）部署清单：30~50 站、Caddy 泛域名、迁 R2 节奏 |
