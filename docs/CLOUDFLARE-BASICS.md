# Cloudflare 基础使用教程

> 围绕这套博客实际用到的 Cloudflare 功能，讲清楚「是什么、在控制台哪里看、日常怎么操作」。
> 与其它文档的分工：部署的完整步骤看 [部署教程](DEPLOY.md)，日常使用看 [使用手册](GUIDE.md)，演示站看 [演示站指南](DEMO.md)——本文只讲 Cloudflare 平台本身，不重复部署教学。
> 文中资源名以在线示例（blog.xiaowuleyi.com：Worker `xwblog`、数据库 `xwblog-db`、图床桶 `xwblog-images`，与仓库内 wrangler.jsonc 一致）为参照；部署自己的实例时换成你自己的资源名即可。

## 目录

1. [全景：这个博客用了 Cloudflare 的哪些东西](#1-全景这个博客用了-cloudflare-的哪些东西)
2. [两扇门：控制台与 wrangler 命令行](#2-两扇门控制台与-wrangler-命令行)
3. [Workers——博客的发动机](#3-workers博客的发动机)
4. [D1——数据库](#4-d1数据库)
5. [R2——图床和备份柜](#5-r2图床和备份柜)
6. [Cron Triggers——定时闹钟](#6-cron-triggers定时闹钟)
7. [域名与 DNS——门口的牌匾](#7-域名与-dns门口的牌匾)
8. [Turnstile——注册人机验证](#8-turnstile注册人机验证)
9. [环境变量与密钥（vars / secrets）](#9-环境变量与密钥vars--secrets)
10. [常用命令速查](#10-常用命令速查)
11. [免费额度与用量查看](#11-免费额度与用量查看)
12. [常见运维场景手册](#12-常见运维场景手册)
13. [安全注意事项](#13-安全注意事项)

---

## 1. 全景：这个博客用了 Cloudflare 的哪些东西

这个博客**没有自己的服务器**：代码、数据库、图片、定时任务全部跑在 Cloudflare 上。用到的产品一共 6 样：

| 产品 | 一句话解释 | 本项目的资源 | 控制台位置（大致） |
|---|---|---|---|
| **Workers** | 跑后端代码的运行时，整个博客的程序本体 | Worker `xwblog`（演示站另有 `xwblog-demo`） | Workers & Pages → xwblog |
| **D1** | 云端 SQLite 数据库，存文章/评论/设置/会员 | 库 `xwblog-db` | Storage & Databases → D1 |
| **R2** | 对象存储（文件柜），图床 + 数据库备份 | 桶 `xwblog-images` | Storage & Databases → R2 |
| **Cron Triggers** | 定时任务（闹钟），挂在 Worker 上 | 2 条 cron（见第 6 节） | Worker 的 Settings → Trigger Events |
| **自定义域名 / DNS** | 访客入口 `blog.xiaowuleyi.com`，自动 HTTPS | 域名 `xiaowuleyi.com` | DNS / Worker 的 Domains & Routes |
| **Turnstile** | 人机验证（验证码），拦注册机器人 | 一对密钥（配置在后台「设置」） | Turnstile 菜单 |

一次访问的完整链路：

```
浏览器
 │  https://blog.xiaowuleyi.com
 ▼
Cloudflare 边缘节点（全球就近接入，自动 HTTPS 证书）
 │
 ▼
Worker「xwblog」—— src/index.ts 编译后的程序
 ├─ /admin/ 的 JS/CSS 等静态文件 → ASSETS（public/ 目录直出）
 ├─ 文章页 / 接口 / 评论 / RSS / 搜索… → Worker 代码自己处理（hono 路由）
 ├─ 查文章、存评论、读设置…        → D1「xwblog-db」
 └─ 图片上传 / 输出（/images/…）   → R2「xwblog-images」
      └─ 每晚北京时间 00:30 备份：D1 全库导出成 JSON 存进 R2 的 backups/ 目录
```

记住这张图，后面每一节就是把它拆开讲。

## 2. 两扇门：控制台与 wrangler 命令行

操作 Cloudflare 有两个入口，干不同的事用不同的门：

**① 网页控制台** [dash.cloudflare.com](https://dash.cloudflare.com)
看数据、看日志、看用量、改 DNS、配 Turnstile——凡是「看」和「点」的操作都在这里。浏览器书签常备。

**② wrangler 命令行**（Cloudflare 官方 CLI，本项目 devDependencies 里已带，用 `npx wrangler` 调用）
部署代码、执行 SQL、实时看日志——凡是「执行」的操作走命令行。首次使用先登录（会弹浏览器授权）：

```bash
npx wrangler login    # 授权本机操作你的 Cloudflare 账号
npx wrangler whoami   # 确认登录成功，显示账号名
```

登录凭证保存在本机（`~/.wrangler/`），不进代码库；换电脑要重新 login。

**经验法则**：日常巡检用控制台；一切会改动线上的批量操作（部署、改数据、导出备份）用命令行，因为命令行动作都有明确记录、可重复、可回退。

## 3. Workers——博客的发动机

### 3.1 它是什么

Workers 是 Cloudflare 的**边缘计算运行时**：你把一段 TS/JS 代码交给它，它把代码分发到全球几百个数据中心，每个请求都由离访客最近的那台机器处理，没有传统意义上的「服务器」要维护——不用装系统、配 nginx、续证书。

本项目整个后端（30 余个 TS 文件 + hono 路由）就是一个 Worker。所谓「部署博客」= 把 `src/` 打包部署到 Workers。

### 3.2 本项目的配置：wrangler.jsonc 逐段解读

`wrangler.jsonc` 是 Worker 的「档案表」，部署时 wrangler 按它办事：

```jsonc
"name": "xwblog"                        // Worker 的名字，也是控制台里的资源名
"main": "src/index.ts"                  // 代码入口，整个后端从这里开始
"compatibility_date": "2025-09-01"      // 运行时行为基准日期（平台 API 变更按这个日期的语义执行，一般不轻易动）
"assets": { "directory": "./public", "binding": "ASSETS" }
                                        // 静态资源目录：public/ 里的文件直接对外，不进 Worker 代码
                                        // 后台 SPA（public/admin/）、表情图、favicon 都靠它
"rules": [{ "type": "Text", "globs": ["**/*.css", "**/*.sql"] }]
                                        // 主题 CSS 和 schema.sql 以文本形式打进包里（页面内联输出/冷启动建表用）
"d1_databases": [{ "binding": "DB", "database_name": "xwblog-db", "database_id": "…" }]
                                        // 绑定 D1：代码里用 env.DB 访问；database_id 是库的唯一标识
"r2_buckets": [{ "binding": "IMAGES", "bucket_name": "xwblog-images" }]
                                        // 绑定 R2：代码里用 env.IMAGES 访问
"triggers": { "crons": ["* * * * *", "30 16 * * *"] }
                                        // 两条定时任务（见第 6 节）
"workers_dev": false                    // 关闭 xxx.workers.dev 平行入口，唯一入口是自定义域名（安全口径）
"observability": { "enabled": true }    // 打开日志采集，控制台能看历史日志
```

**重要**：绑定（DB/IMAGES/ASSETS）、cron、域名这些配置**都以 wrangler.jsonc 为准**。在控制台里手动改的绑定，下次 `wrangler deploy` 会被仓库里的配置覆盖回去。想改配置，改文件再部署。

### 3.3 部署的三条路

| 路径 | 命令/触发 | 用途 |
|---|---|---|
| GitHub 自动部署 | 向已接入 **Workers Builds** 的仓库 push → Cloudflare 自动拉取、构建、部署 | 日常发布主路：一键部署的副本仓库默认就是这条 |
| 本地手动部署 | `npm run deploy`（即 `wrangler deploy`） | 想立刻把本地某个状态发上线时用 |
| 演示站部署 | `npm run deploy:demo`（`wrangler deploy -c wrangler.demo.jsonc`） | 部署 `xwblog-demo`，与生产资源完全隔离（当前演示站实际自托管在甲骨文，此路保留） |

仓库自带的 GitHub Actions 部署工作流在**没有配置部署密钥**时，push 只会跑测试并跳过部署——黄字警告属正常现象，部署已由 Cloudflare 侧接管；想改用 Actions 部署见 [部署教程](DEPLOY.md) 第 7 节。

### 3.4 版本与回滚

每次部署都会在 Worker 的 **Deployments** 标签留下一个版本。发现新版本有问题：控制台 → Deployments → 找上一个正常版本 → **Rollback**，一秒切回去。这是线上救急的第一手段。

### 3.5 看日志

- **实时日志**：`npx wrangler tail`——像看服务器终端一样，实时滚动每个请求的状态码和 `console.log`。排查线上报错的第一工具（Ctrl+C 退出）。
- **历史日志**：控制台 → Worker → **Logs** 标签（`observability` 已开启），能查过去一段时间内的请求与报错，适合复盘。

最常遇到的错误码：**1101 = Worker 代码抛了未捕获的异常**。看到 1101 就去 tail 里看堆栈，定位到具体文件行号。

## 4. D1——数据库

### 4.1 它是什么

D1 是 Cloudflare 的**无服务器 SQLite 数据库**：一个真正的 SQLite，但存在 Cloudflare 边缘、由 Worker 直接读写（本项目代码里就是 `env.DB.prepare("SELECT …")`）。不需要自己跑 MySQL、不用管备份服务器连接数，个人博客的量级完全够用。

本项目库名 **`xwblog-db`**，代码绑定名 **`DB`**。文章、页面、微博、评论、设置、会员、访问统计，全在这一个库里。

### 4.2 ⚠️ 最大的坑：`--local` 和 `--remote` 是两个世界

```bash
npx wrangler d1 execute DB --remote --command "SELECT …"   # 操作【线上真库】
npx wrangler d1 execute DB --local  --command "SELECT …"   # 操作【本地模拟库】
```

- `--remote`：**线上的 xwblog-db**，动的是真实数据。
- `--local`：本机 `.wrangler/state/` 目录下的模拟库，只服务 `npm run dev` 本地开发，**和线上毫无关系**。

执行任何 D1 命令前先看清有没有 `--remote`。反过来这也是安全垫：本地怎么折腾都不会伤到线上。

### 4.3 日常操作

```bash
# 查询（线上）：比如看有多少篇已发布文章
npx wrangler d1 execute xwblog-db --remote --command "SELECT count(*) FROM posts WHERE deleted_at IS NULL AND status='published'"

# 初始化/更新表结构（幂等，可重复执行；就是 package.json 里的 db:init:remote）
npx wrangler d1 execute DB --remote --file schema.sql

# 全库导出成 SQL 文件（手动备份的一种）
npx wrangler d1 export xwblog-db --remote --output=d1-backup.sql
```

库名 `xwblog-db` 和绑定名 `DB` 都能当命令参数，效果一样。另外，**控制台的 D1 页面也能直接浏览表、跑查询**，适合随手看看数据（只读心态使用）。

> 写 UPDATE/DELETE 前的纪律：先跑一次对应的 SELECT 确认影响范围，再导出一份备份，然后才动手。

### 4.4 备份：已经自动在做

不需要手动操心日常备份——每晚**北京时间 00:30** 的 cron 会把整个 D1 导出成 JSON，存进 R2 桶的 `backups/` 目录，命名 `xwblog-2026-10-12.json` 这样，**滚动保留最近 30 份**，备份完成/异常会发 Telegram 通知（实现在 `src/backup.ts`）。

恢复方法见 [使用手册](GUIDE.md#19-升级备份与数据导出)「升级、备份与数据导出」；核心就是把 R2 里的 JSON 逐表灌回 D1。

## 5. R2——图床和备份柜

### 5.1 它是什么

R2 是 Cloudflare 的**对象存储**（同类产品是 AWS S3）：一个存文件的桶，按「对象 = key + 内容」组织。最大的卖点：**出口流量免费**，图片再多也不收流量费。

本项目桶名 **`xwblog-images`**，代码绑定名 **`IMAGES`**。里面有两类东西：

1. **图片**：后台上传、文章里转存的图，key 形如 `images/xxxxx.png`
2. **数据库备份**：`backups/` 前缀下的每日 JSON（见上节）

### 5.2 桶是私有的——这是设计，不是遗漏

桶**没有开公开访问**。图片不是 `https://xxx.r2.dev/图名` 这种直链，而是统一走 Worker 的 `/images/` 路由输出（带缓存头）。好处：

- 桶的任何内容都不可能被外人直接列举/下载，更安全
- 删除图片立即生效，不存在「桶里删了缓存还在」的错位
- key 规则由代码统一把守（魔数校验、mime 纠正都在上传链路里）

所以**日常不要在控制台里手动上传/删除桶里的文件**：图片在 D1 里有登记，手动删除会留下死链；真要清理媒体，用后台「媒体 → 体检」的未引用扫描。

### 5.3 操作方式

- **看**：控制台 R2 页 → xwblog-images，可浏览对象、下载。查备份、抢救文件时用。
- **命令行**（偶尔用）：

```bash
# 取一份备份到本地
npx wrangler r2 object get xwblog-images/backups/xwblog-2026-10-12.json --file=backup.json

# 上传/删除单个对象（日常用不到，知道有这命令即可）
npx wrangler r2 object put xwblog-images/test.txt --file=./test.txt
npx wrangler r2 object delete xwblog-images/test.txt
```

## 6. Cron Triggers——定时闹钟

### 6.1 cron 表达式速成

Cron Trigger 就是「到点叫醒 Worker」。表达式 5 段，含义：`分 时 日 月 周`，通配符 `*` = 每，`*/2` = 每隔 2。**注意：cron 按 UTC 时间执行**，北京时间 = UTC + 8。

本项目 `wrangler.jsonc` 里两条：

| 表达式 | UTC 含义 | 北京时间 | 干什么 |
|---|---|---|---|
| `* * * * *` | 每分钟 | 每分钟 | 扫描「定时发布」的文章，到点就转成已发布（`scheduler.ts`） |
| `30 16 * * *` | 每天 16:30 | 每天 **00:30** | 夜间备份：D1 全库 → R2 `backups/`，滚动 30 份 |

（演示站配置里还有一条 `23 */2 * * *` = 每 2 小时清库重灌种子数据，那是 demo 站自己的。）

### 6.2 查看、修改、调试

- **看**：控制台 → Worker → Settings → Trigger Events；或直接看 `wrangler.jsonc` 的 `triggers`（代码为准）。
- **改**：改 `wrangler.jsonc` 再部署即可，免费版每账号可挂 5 条 cron（现用 2 条）。
- **本地调试**：`wrangler dev --test-scheduled` 启动后，手动触发一次：

```bash
curl "http://localhost:8787/__scheduled?cron=30+16+*+*+*"
```

> 时区换算易错点：想「北京时间每天 08:00」跑任务，cron 要写 `0 0 * * *`（UTC 0 点）。算完 UTC 再写进配置。

## 7. 域名与 DNS——门口的牌匾

### 7.1 域名托管与 DNS 记录

`xiaowuleyi.com` 的 NS（域名服务器）托管在 Cloudflare——不管域名当初在哪买的，解析都由 CF 管理。控制台 → 该域名 → **DNS** 页可以看/增/改记录。常见记录两种：

- **A 记录**：域名 → IPv4 地址（传统「指向一台服务器」的用法）
- **CNAME**：域名 → 另一个域名（「跟着它走」）

### 7.2 橙云与灰云

DNS 记录前有个云朵图标：**点亮的橙云 = 流量经过 Cloudflare 代理**（隐藏真实源站 IP、享受 CDN 缓存和自动 HTTPS）；灰云 = 仅做 DNS 解析、直连源站。本博客的域名指向 Cloudflare 自己的服务，天然全程橙色。

### 7.3 自定义域名绑定（博客入口的由来）

博客入口 `blog.xiaowuleyi.com` 是通过 **Custom Domain** 绑到 Worker 上的：控制台 → Workers & Pages → xwblog → Settings → **Domains & Routes** → Add Custom Domain。添加后 Cloudflare 自动完成三件事：建好 DNS 记录、签发 HTTPS 证书、把该域名的流量路由到 Worker。代码层面等价的写法是 wrangler.jsonc 里的 `routes`（`wrangler.demo.jsonc` 里有一条被注释的例子可参考），两种方式都行。

配合 `workers_dev: false`，现在**唯一入口**就是 `blog.xiaowuleyi.com`，`xwblog.<子域>.workers.dev` 的平行入口已关闭（2026-10-12 审计口径）。

### 7.4 别混的两个域名

- `blog.xiaowuleyi.com` —— 本博客，跑在 Cloudflare Worker 上
- `demo.bloghao.com` / `bloghao.com` —— 演示站与官网，**自托管在甲骨文服务器**（Caddy 直出），只是 DNS 记录仍由 CF 管理；它们不经过本 Worker，排查问题别往 Worker 身上找

## 8. Turnstile——注册人机验证

### 8.1 它是什么

Turnstile 是 Cloudflare 免费的人机验证组件（验证码的现代替代品，无使用量上限）：大多数真人**无感通过**，机器人则过不去。本博客用它拦会员注册的机器批量注册（2026-10 审计 A2 项）；登录和评论**不**校验，只守注册口。

### 8.2 两把钥匙

- **Site Key（站点密钥）**：公开的，嵌在前端页面里，谁都能看到，不是秘密
- **Secret Key（私钥）**：保密的，服务端拿它去 Cloudflare 验证用户提交的令牌

本项目这两把钥匙**存放在后台「设置」**（D1 的 settings 表，私钥在后台响应里打码显示），两个键**成对启用**：只填一把保存会被拒绝；**都留空 = 关闭验证**。校验在服务端 `/api/member/register`，fail closed——验证服务异常时宁可挡下注册，不留无验证窗口。

### 8.3 创建/更换 Turnstile 站点

1. 控制台左侧 → **Turnstile** → Add site
2. Hostname 填 `blog.xiaowuleyi.com`；Widget Mode 选 **Managed**（托管，无感体验最好）
3. 提交后得到 Site Key 和 Secret Key
4. 打开博客后台 → 设置 → 把两把钥匙**成对**填入 Turnstile 两栏 → 保存

换钥匙 = 旧钥匙作废，注意同时更新后台设置，否则注册页的验证会一直失败。

## 9. 环境变量与密钥（vars / secrets）

Workers 代码可以通过两种方式拿到「代码之外的配置」：

- **vars（明文变量）**：写在 wrangler.jsonc 的 `"vars"` 里，随代码部署。本项目唯一用例：演示站配置里的 `"vars": { "DEMO_MODE": "1" }`——生产配置没有任何 vars。
- **secrets（加密变量）**：`npx wrangler secret put 名字` 或控制台里设置，加密存储、设置后不可查看。适合 API Token 这类敏感值。

**本项目实际口径**：业务密钥（开放 API 令牌、Telegram Bot Token、Turnstile 私钥、Buffer 令牌等）**不走 wrangler secrets，而是存后台「设置」**（D1 settings 表）——好处是随时在后台改、不用重新部署，且后台显示时全部打码。wrangler secrets 目前只在 GitHub Actions 部署链路里用到（部署工作流持有一枚有 Workers 部署权限的 API Token；没配密钥的仓库 push 只跑测试）。

若将来要手动创建部署用 API Token：控制台 → 我的个人资料 → **API Tokens** → 用「Edit Cloudflare Workers」模板，**权限给到刚够用为止**；泄露立刻 Roll（作废）重建。

## 10. 常用命令速查

```bash
# —— 账号 ——
npx wrangler login                 # 登录（浏览器授权）
npx wrangler whoami                # 确认当前账号

# —— 本地开发 ——
npm run dev                        # 本地起服务（wrangler dev），D1/R2 走本地模拟库，改代码即生效
npm run dev:demo                   # 演示站本地预览（自动建表+播种）

# —— 部署与回滚 ——
npm run deploy                     # 部署生产 Worker（wrangler deploy）
npm run deploy:demo                # 部署演示站配置
# 回滚走控制台 Deployments → Rollback，或 npx wrangler rollback

# —— 日志 ——
npx wrangler tail                  # 实时滚动线上日志（排查 1101 报错必备）

# —— D1 ——
npx wrangler d1 execute xwblog-db --remote --command "SELECT …"   # 线上查询
npx wrangler d1 execute DB --remote --file schema.sql             # 初始化表结构（幂等）
npx wrangler d1 export xwblog-db --remote --output=backup.sql     # 全库导出
# ⚠️ --local 是本地模拟库，与线上无关；改线上必须 --remote

# —— R2 ——
npx wrangler r2 object get xwblog-images/backups/xwblog-2026-10-12.json --file=out.json
npx wrangler r2 object put xwblog-images/<key> --file=<本地文件>
npx wrangler r2 object delete xwblog-images/<key>

# —— 定时任务调试 ——
npx wrangler dev --test-scheduled  # 本地可手动触发 cron：
curl "http://localhost:8787/__scheduled?cron=30+16+*+*+*"
```

## 11. 免费额度与用量查看

本项目在免费套餐内运行，各产品免费额度（个人博客绰绰有余，具体以官方 Limits 页为准）：

| 产品 | 免费额度 | 超额后果 |
|---|---|---|
| Workers | **10 万次请求/天**（UTC 零点重置），每次调用 10ms CPU 时间；静态资源（assets 直出的部分）不计入 | 当天后续请求被拒，次日恢复 |
| D1 | 5 GB 存储 / 500 万行读/天 / 10 万行写/天 | 读到达上限后查询被限流 |
| R2 | 10 GB 存储/月；写（Class A）100 万次/月；读（Class B）1000 万次/月；出口流量免费 | 需绑卡后按量计费 |
| Turnstile | 无上限，完全免费 | —— |
| Cron | 每账号 5 条（现用 2 条） | —— |

**哪里看用量**：

- Worker 的 **Metrics** 标签：请求数、错误率、CPU 用时
- D1 / R2 各自的控制台页：存储量与读写操作量
- 账号首页概览也有汇总

两点提醒：Workers 免费版超限是「当天拒绝服务」不会扣钱；R2 超出免费额度会**真实计费**（要求绑过卡），建议在账号的 Notification 里配一条用量告警。当前量级（个位数 GB、日均几千请求）离限额很远，无需焦虑。

## 12. 常见运维场景手册

**Q：网站打不开/报错 500，先看什么？**
控制台 → Worker → Metrics 看错误率是否飙高 → `npx wrangler tail` 盯实时日志复现一次 → 多半是 1101（代码异常），按堆栈定位。若刚部署过新版本，Deployments → Rollback 回上一版，先恢复服务再慢慢查。

**Q：改了代码怎么上线？**
向已接入 Workers Builds 的仓库 push 即自动部署（几分钟内生效）；急修也可以本地 `npm run deploy` 直发。

**Q：想手动查一条数据 / 改一条数据？**
`wrangler d1 execute xwblog-db --remote --command "…"`。改数据前先导出备份，UPDATE/DELETE 一定带 WHERE。

**Q：想下载一份昨天的备份？**
控制台 R2 → xwblog-images → `backups/` 目录下载，或命令行 `r2 object get`（见第 10 节）。恢复步骤见 `docs/GUIDE.md`。

**Q：新电脑上怎么把开发环境跑起来？**
装 Node ≥ 18 → `npm install` → `npx wrangler login` → `npm run dev`。本地库是空的模拟库，跑 `npm run db:init:local` 建表即可开始开发，全程碰不到线上数据。

**Q：注册页的人机验证好像没生效？**
后台「设置」检查 Turnstile 两把钥匙是否都填了（只填一把会被拒绝保存）；再确认 Turnstile 站点的 Hostname 包含当前域名。

**Q：cron 到点没执行？**
确认改动是否部署过（cron 改动在 wrangler.jsonc，要重新部署才生效）；控制台 Worker 的 Trigger Events 里能看到计划的 cron；本地复现用 `--test-scheduled`（见第 6 节）。

## 13. 安全注意事项

现状盘点（大部分已默认做到，列出来防止将来改坏）：

- **控制台账号开 2FA**——它管着博客的全部数据，是最值得保护的入口
- **API Token 最小权限**：部署用的 token 只给 Workers 相关权限；泄露立即作废重建
- **workers.dev 平行入口已关**（`workers_dev: false`），站点唯一入口是自定义域
- **R2 桶保持私有**，图片只经 Worker 的 `/images/` 路由输出；不要为了「方便」开公开桶
- **密钥不进代码库**：业务密钥存后台设置（打码），仓库里永远不会出现明文 token；往 wrangler.jsonc 加 vars 时只放非敏感值
- **`--remote` 命令当生产操作对待**：执行前看清目标库、先备份再改数

---

## 官方文档入口

- Workers 教程与概念：<https://developers.cloudflare.com/workers/>
- wrangler 全部命令：<https://developers.cloudflare.com/workers/wrangler/commands/>
- D1：<https://developers.cloudflare.com/d1/>（限额：<https://developers.cloudflare.com/d1/platform/limits/>）
- R2：<https://developers.cloudflare.com/r2/>
- Cron Triggers：<https://developers.cloudflare.com/workers/configuration/cron-triggers/>
- Turnstile：<https://developers.cloudflare.com/turnstile/>
- Workers 平台限额：<https://developers.cloudflare.com/workers/platform/limits/>
