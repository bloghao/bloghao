<div align="center">

<img src="public/favicon.svg" width="76" alt="博客号 BlogHao">

# 博客号 BlogHao

**微信有公众号，你有博客号。** 写文章、发随手记、交朋友 · 全套跑在 Cloudflare 上 · 免费额度即可长期运行

**在线示例：[https://blog.xiaowuleyi.com](https://blog.xiaowuleyi.com)**（作者小吴乐意自己的博客，由本系统驱动）

**演示体验站：[https://demo.bloghao.com](https://demo.bloghao.com)** —— 动手部署前可以先去转一圈：预置全年仿真数据、会员 / 付费墙 / 加密文章全开着，随便折腾，每 2 小时自动重置；后台账号 `demo` / `demo1234`，打开登录页就已自动填好（机制见 [docs/DEMO.md](docs/DEMO.md)）。

[![Version](https://img.shields.io/github/package-json/v/bloghao/bloghao?color=1a73e8)](https://github.com/bloghao/bloghao/blob/main/CHANGELOG.md) [![License](https://img.shields.io/badge/License-MIT-07c160) ![Cloudflare](https://img.shields.io/badge/Cloudflare-Workers%20%C2%B7%20D1%20%C2%B7%20R2-F38020) ![No Framework](https://img.shields.io/badge/%E5%89%8D%E5%90%8E%E7%AB%AF-%E6%97%A0%E6%A1%86%E6%9E%B6%E4%BE%9D%E8%B5%96-1a1a1a)](https://github.com/bloghao/bloghao)

<a href="https://deploy.workers.cloudflare.com/?url=https://github.com/bloghao/bloghao"><img src="https://deploy.workers.cloudflare.com/button" alt="Deploy to Cloudflare" height="36"></a>

</div>

---

博客号（BlogHao）是一款完全运行在 Cloudflare 上的开源博客引擎：网页由 Workers 边缘渲染，文字存进 D1，图片传进 R2——服务器、运维、账单，统统不存在。写作后台对标微信公众号编辑器，截图 `⌘V` 粘贴即自动上云。

2.0 在「写文章」的基础上，整合了作者博客沉淀的一整套**日常记录与互动**能力：短内容的「微博 / 随手记」、楼中楼评论、友情链接、首页搜索与排序、公众号文章一键采集等，六套主题全部适配，手机端同样完整可用。

## ✨ 特性一览

| | |
| --- | --- |
| ✍️ **公众号风写作后台** | 富文本工具栏 / 行首快捷排版（`> `+空格转引用等 Markdown 快捷输入）/ Markdown 模式互转 / 粘贴与拖拽自动上传（大图自动压缩）/ 自动保存 / 分类·标签·封面·摘要·置顶 / 一键预览 |
| ⏰ **定时发布** | 写完定个时，到点自动发布并推送 Telegram；后台「定时」标签一目了然 |
| 🏪 **微博（随手记）** | 不用起标题的图文时间线：最多 9 图、`#话题` 自动归类并高亮、置顶（最多 3 条）、点赞、评论，支持粘贴/拖拽发图；管理员登录后微博页顶部可直接发布，不用进后台 |
| 💬 **评论互动** | 文章与微博评论楼中楼、作者回复带徽标（登录后前台发言免填昵称）、站点级开关、先审后展 |
| 🤝 **友情链接** | 前台 `/links` 展示 + 访客在线申请收录；后台审核 / 排序 / 隐藏，图标可自动抓取、本地上传或直接粘贴 |
| 📄 **独立页面** | 自建页面渲染在 `/page/:slug`（项目页 / 书单页 / 隐私政策…），可上顶部导航、可排序；「关于我」由页面系统承载，`/about` 专属短链不变 |
| 🔍 **站内搜索与排序** | 首页搜索文章；列表按最新 / 最多阅读 / 最多点赞 / 最多留言 / 随机排序（随机洗牌翻页不重洗） |
| 🩺 **排版体检** | 按微信官方规范静态检查 13 条规则（固定宽度、行高叠字、`!important`、嵌套层级、`data-w`…），支持一键修复 |
| 📰 **公众号采集** | 编辑器插件：粘贴公众号文章链接，抓正文、配图转存图床，生成保留原发布时间的草稿 |
| 🎨 **六套主题** | 微信公众号（明亮）/ 纸墨 / 极简 / 夜航 / 手账（奶油纸面手账风）/ 比特币（品牌素材库风），后台「皮肤」页即点即换，附皮肤市场精选目录；主题即模块，开放注册 |
| 🧩 **编辑器插件** | 后台「插件」页一键启停（无需重新部署），附插件市场精选目录；一个插件 = 一个 JS 文件，开放注册；另有随内核运行的服务端插件钩子（发布同步 TG 频道、评论 Webhook、页脚注入三个官方示例） |
| 🖼️ **R2 图床** | 图片视频私有存储，Worker 鉴权输出 + 长缓存 + ETag 304，媒体库可视化管理；上传前自动压缩并转 WebP（>150KB 或 >2000px，同画质比 JPEG 约再省三成、透明不丢，旧浏览器自动回退 JPEG/PNG）；EXIF / GPS 元数据自动抹除，手机照片的拍摄位置不随图公开 |
| 🔒 **安全默认开启** | PBKDF2 / HttpOnly 会话 / CSRF 同源校验 / HTML 白名单净化 / 评论与友链蜜罐限流 / CSP |
| ⚡ **快** | SSR 直出、主题 CSS 内联零额外请求、边缘节点全球分发 |
| 📡 **自带生态件** | 全文 RSS、sitemap、robots.txt、OG 分享标签（可一键生成 1200×630 专属分享卡图）、JSON-LD 结构化数据、图片灯箱、每晚自动备份到 R2、GitHub Actions 自动部署 |
| 🚚 **数据导出** | 一键打包 Markdown（文章含草稿 + 微博 + 页面 + 引用的图片，front-matter 齐全）与 WordPress WXR——数据主权随时兑现，搬家不留钳制 |
| 🐳 **Docker 自托管** | 同一套代码零改动跑进普通 Node 容器：文章存内置 SQLite，图片落本地磁盘或继续用 Cloudflare R2；单进程按域名托管多个独立博客站，定时发布 / 每晚备份照常（见「部署」方式三） |

<details>
<summary><b>📖 查看全部特性细节</b></summary>

- **文章**：草稿 / 定时发布（到点自动上线 + TG 通知）/ 发布 / 置顶 / 自定义 slug / 分类（单分类）/ 标签（多标签）/ 摘要 / 封面 / 阅读量与点赞 / 阅读时长 / 相关文章
- **微博**：5000 字以内 + 9 图，话题从正文 `#话题` 自动提取并高亮（兼容 Memos 式 `#层级/标签`），草稿与置顶，微博页 `?topic=` 按话题筛选
- **外部发布**：Telegram 机器人发文字 / 图片 / 相册即发微博（相册自动合并，图片转存 R2，Chat ID 白名单）；另有 Token 鉴权开放 API（JSON / multipart / base64，教程见 docs/GUIDE.md 8.1–8.2）
- **评论**：文章评论 / 微博评论在后台分开管理；楼中楼回复；防垃圾三件套（蜜罐、同 IP 限流、长度限制）；新留言即时推送到 Telegram（复用发布机器人，后台可关）
- **订阅与备份**：RSS 全文输出（订阅器不点开就能读完，可切回摘要）；每天北京时间 00:30 自动把数据库全量快照存进 R2，滚动保留 30 份，后台可查看 / 手动备份
- **独立页面**：后台「页面」新建 / 编辑 / 排序，勾选后出现在前台顶部导航；「关于我」为 `about` 页面（升级自动迁移，`/about` 不变）
- **数据导出**：设置 → 数据导出，Markdown 包（图片流式打包不过内存）与 WXR 单文件
- **时光机**：首页「历史上的今天」卡片，往年今日的文章与微博自动浮上来（六主题适配，无命中不渲染）
- **分类与标签**：分类页 `/category/:slug`；分类页可直接预建 / 删除全站标签
- **站点外观**：站点名称 / 描述 / 页脚 / 头像 / 浏览器 favicon（均可上传到图床）/ 每页文章数 / 关于我（页面系统承载）
- **站点状态**：一键灰度（哀悼 / 纪念时刻全站去色）与一键闭站（访客只见闭站页，RSS / 评论一并停用，503 + Retry-After 保住搜索收录；后台与已登录的管理员不受影响）
- **规范属性透传**：`data-w`、`data-ignore-width`、`data-no-dark`、`data-ignore-dm` 原样保留
- **账号**：首次进入后台即创建管理员，后台可改密码

</details>

## 🗺 页面速查

| 地址 | 内容 |
| --- | --- |
| [`/`](https://blog.xiaowuleyi.com/) | 首页：微博入口卡 + 历史上的今天 + 搜索框 + 排序条 + 文章列表 |
| [`/weibo`](https://blog.xiaowuleyi.com/weibo) | 微博时间线（随手记），从正文 `#话题` 高亮标签可进入话题筛选；管理员登录时顶部有发布框 |
| [`/archives`](https://blog.xiaowuleyi.com/archives) | 文章归档：全部文章按年份分组 |
| [`/guestbook`](https://blog.xiaowuleyi.com/guestbook) | 留言板：独立留言墙（楼中楼、作者回复） |
| [`/links`](https://blog.xiaowuleyi.com/links) | 友情链接 + 访客申请收录 |
| [`/post/:slug`](https://blog.xiaowuleyi.com) | 文章页（评论楼中楼、点赞、相关文章） |
| [`/category/:slug`](https://blog.xiaowuleyi.com) · `/tag/:tag` · `/search?q=` | 分类 / 标签 / 搜索归档 |
| [`/about`](https://blog.xiaowuleyi.com/about) · [`/random`](https://blog.xiaowuleyi.com/random) · [`/rss.xml`](https://blog.xiaowuleyi.com/rss.xml) | 关于我 · 随机一篇 · RSS 订阅 |
| [`/admin/`](https://blog.xiaowuleyi.com/admin/) | 管理后台（写作、微博、友链、评论、媒体、皮肤、插件、设置） |

顶部导航（六套主题一致）：**首页 · 微博 · 归档 · 留言板 · 分类话题（折叠菜单）· 友情链接 · 自建页面 · 关于我 · 随机**（自建页面在后台「页面」创建并选择是否上导航）。

## 🚀 部署自己的博客号

**方式一：一键部署（推荐）**——点上面（或下面）的按钮，授权 GitHub 后给 Worker / 数据库 / 图床起好名字，Cloudflare 自动完成剩下的：复制一份仓库到你的账号 → 开通 D1 数据库与 R2 图床并回填配置 → 构建部署上线 → 接管 push 自动部署。全程不碰命令行。

<a href="https://deploy.workers.cloudflare.com/?url=https://github.com/bloghao/bloghao"><img src="https://deploy.workers.cloudflare.com/button" alt="Deploy to Cloudflare" height="36"></a>

> 若账号还没用过 R2，会被要求先添加支付方式——免费额度内不扣费，只是验证。

**方式二：命令行部署**（想自己掌控每一步）

> 前置：Node.js 18+、一个 Cloudflare 账号。完整版教程（含自定义域名、备份、FAQ）见 [docs/DEPLOY.md](docs/DEPLOY.md)。

```bash
# 1. 克隆并安装
git clone https://github.com/bloghao/bloghao.git
cd bloghao && npm install
npx wrangler login

# 2. 创建资源（名称可自定，与 wrangler.jsonc 保持一致）
npx wrangler d1 create xwblog-db        # 把返回的 database_id 填进 wrangler.jsonc
npx wrangler r2 bucket create xwblog-images

# 3. 初始化数据库（幂等，可重复执行）
npx wrangler d1 execute DB --remote --file schema.sql

# 4. 部署
npm run deploy
```

打开 `https://<worker名>.<你的子域>.workers.dev/admin/`，**首次进入即创建管理员**，欢迎文章已就位，删掉它开始写你自己的第一篇吧。绑定自定义域名（如示例站的 `blog.xiaowuleyi.com`）后，记得把「设置 → 站点链接」改成新域名——RSS / sitemap 里的绝对链接都用它。

<details>
<summary><b>开启 push 自动部署</b></summary>

一键部署的副本在部署时已由 Cloudflare Workers Builds 自动接管 push 部署，**无需任何配置**（仓库里内置的 GitHub Actions 部署工作流没配密钥会自动跳过，不影响）。

命令行部署的想开启自动部署，两种任选：

- **Workers Builds**（推荐）：Cloudflare 面板 → 你的 Worker → Settings → Git 支持，连接 GitHub 仓库即可
- **GitHub Actions**：推上 GitHub 后，在仓库 Settings → Secrets → Actions 添加 `CLOUDFLARE_API_TOKEN`（Workers Scripts + D1 + R2 编辑权限）与 `CLOUDFLARE_ACCOUNT_ID`，仓库内置的 `.github/workflows/deploy.yml` 会在每次 push 到 `main` 时自动执行：类型检查 → 同步 schema → 部署。另有 `.github/workflows/ci.yml` 与部署并行，跑类型检查 + 回归测试（`tests/` 300+ 用例），防止已修复的 bug 悄悄复发

</details>

**方式三：Docker 自托管**（不想把代码跑在 Cloudflare 上、手头有 VPS 时选这条）

业务代码零改动地跑进一个 Node 容器：文章存内置 SQLite（单文件 WAL），图片存本地磁盘目录，也可以继续用 Cloudflare R2 桶（零出口流量费）。单进程按域名同时托管多个完全独立的博客站，Cloudflare 退回只做 DNS + CDN。

```bash
git clone https://github.com/bloghao/bloghao.git
cd bloghao/docker-poc
docker compose up --build -d     # 镜像约 70MB（node:26-alpine），数据落在 ./data/<域名>/
```

把真实域名写进 `docker-poc/tenants.json` 后重启容器，访问 `/admin/` 创建管理员（与 Workers 版完全一致）；定时发布、每晚备份、回收站清理等定时任务随容器自动运行。端口 / 反代 / HTTPS / 图片存储二选一等完整步骤见 [docker-poc/DEPLOY.md](docker-poc/DEPLOY.md)，架构与适配层说明见 [docker-poc/README.md](docker-poc/README.md)。

## 🧑‍💻 本地开发

```bash
npm install
npm run db:init:local   # 初始化本地 D1（.wrangler/state，与线上互不影响）
npm run dev             # http://127.0.0.1:8787
npm run dev:demo        # 演示站本地预览（自动建表 + 播种一年仿真数据，见 docs/DEMO.md）
npm run typecheck       # TypeScript 类型检查，提交前必须通过
npm test                # 回归测试（tests/，300+ 用例），提交前必须通过
npm run smoke           # 本地冒烟：起 wrangler dev 逐路由断言，改 SQL 拼接/渲染后必跑
```

## 📦 目录结构

```
bloghao/
├── src/                # Cloudflare Worker（后端 + SSR + 主题）
│   ├── index.ts        # 入口与路由（页面、图床、RSS、随机阅读、Cron 调度）
│   ├── api.ts          # 全部 JSON API（文章/微博/友链/分类/评论/设置…）
│   ├── external.ts     # 外部发布：开放 API + Telegram 机器人 + 管理端点
│   ├── pages.ts        # 公开页 SSR（首页/微博/友链/文章/搜索…）
│   ├── collect.ts      # 公众号采集插件服务端
│   ├── scheduler.ts    # 每分钟 Cron：定时发布到点自动上线
│   ├── backup.ts       # 每晚 00:30 全量备份 D1 → R2（滚动保留 30 份）
│   ├── auth.ts / sanitize.ts / markdown.ts / db.ts / render.ts / rss.ts / utils.ts
│   └── themes/         # 六套主题 + 注册表（新主题加在这里）
├── public/
│   ├── admin/          # 管理后台 SPA（原生 JS，无构建）
│   ├── site.js         # 前台交互（点赞/评论/楼中楼/灯箱/微博发布/折叠菜单）
│   └── plugins/        # 编辑器插件（hello-plugin / wechat-collect）
├── tests/              # 回归测试（npm test，CI 强制执行）
├── scripts/            # smoke.mjs 本地冒烟；emlog-migrate 一次性迁移工具（留档）
├── migration-memos/    # Memos 旧站 → 微博 的一次性迁移工具（已完成，留档）
├── docker-poc/         # Docker 自托管：Node 单进程多站点（SQLite + 磁盘 / R2 图床）
├── website/            # 「博客号」官网（bloghao.com，Cloudflare Pages 部署，与本站运行无关）
├── docs/               # 全部文档
└── schema.sql          # D1 表结构（幂等）
```

## 📚 文档

| 文档 | 内容 |
| --- | --- |
| [docs/GUIDE.md](docs/GUIDE.md) | **使用手册**：后台导览、写文章 / 发微博全流程、评论与友链管理、采集插件、设置逐项说明 |
| [docs/DEPLOY.md](docs/DEPLOY.md) | **部署教程**：资源创建、首次上线、自定义域名、GitHub 自动部署、备份恢复、FAQ |
| [docs/API.md](docs/API.md) | API 参考：全部公开 / 管理接口 |
| [docs/THEMES.md](docs/THEMES.md) | 主题开发指南：一套主题 = 七类页面（首页 / 文章 / 微博 / 友链 / 关于我 / 归档 / 留言板） |
| [docs/PLUGINS.md](docs/PLUGINS.md) | 插件开发指南：编辑器插件 API 与内置「公众号采集」 |
| [docs/DEMO.md](docs/DEMO.md) | **演示站指南**：跑一个预置一年数据、每 2 小时自动重置的在线体验站（与生产完全隔离） |
| [docker-poc/README.md](docker-poc/README.md) | **Docker 自托管**：架构与适配层、本地直跑、图片存储二选一（本地盘 / R2）、加站点 |
| [docker-poc/DEPLOY.md](docker-poc/DEPLOY.md) | 自托管服务器部署清单：选机、端口与反代、HTTPS 与缓存、验收与升级 |
| [docs/wechat-typography-spec.md](docs/wechat-typography-spec.md) | 微信排版规范落地对照 + 体检规则表 |
| [docs/ROADMAP.md](docs/ROADMAP.md) | 开发方向备忘：已调研未启动的功能方向（会员体系等）与待拍板决策 |

## ❓ FAQ

<details>
<summary><b>workers.dev 域名访问慢或不通？</b></summary>

绑定自己的域名：Cloudflare 面板 → Workers & Pages → 你的 Worker → Domains & Routes → Add Custom domain（示例站即 `blog.xiaowuleyi.com`）。绑定后把「设置 → 站点链接」改成新域名（影响 RSS / sitemap 绝对链接）。
</details>

<details>
<summary><b>忘记管理员密码？</b></summary>

```bash
npx wrangler d1 execute DB --remote --command "DELETE FROM users; DELETE FROM sessions;"
```

然后重新访问 `/admin/` 创建账号，文章 / 评论 / 图片全部保留。
</details>

<details>
<summary><b>会一直免费吗？</b></summary>

Cloudflare 免费套餐：Workers 每天十万次请求、D1 五百万行读、R2 10GB 存储——对个人博客是几个月到几年的量。用超了再考虑 $5/月的付费计划，代码无需任何改动。
</details>

<details>
<summary><b>如何升级？</b></summary>

```bash
git pull
npm install
npm run deploy    # schema 有更新时再执行一次 npx wrangler d1 execute DB --remote --file schema.sql（幂等）
```
</details>

## 🛣 路线图

- [x] 会员体系：游客注册 + 分级会员 + 积分 + 排行榜 + 专属文章付费墙（已上线，默认关闭，后台开启；用法见 [docs/GUIDE.md](docs/GUIDE.md) §15）
- [ ] 多作者协作
- [x] 编辑器 Markdown 快捷输入（`> ` 自动转引用等，已上线）
- [x] 服务端插件钩子（发布 / 评论事件回调 + 页脚注入，已上线，见 [docs/PLUGINS.md](docs/PLUGINS.md)）
- [ ] 市场远程化：皮肤 / 插件目录改为远程数据源 + 更顺畅的安装体验（后台「皮肤 / 插件」页的精选目录与启停管理已就绪）
- [x] WebP 自动转换（上传前压缩已上线）

## 🤝 相关仓库

- **官方仓库**：[bloghao/bloghao](https://github.com/bloghao/bloghao)（本仓库）——2.0 起整合作者实例线的全部增强，欢迎提 Issue / PR；官网源码在仓库内 `website/` 目录（**[bloghao.com](https://bloghao.com)**，Cloudflare Pages 部署，官网「博客号目录」上榜请提 Issue）
- **作者实例**：[lovexw/bloghao-xwblog](https://github.com/lovexw/bloghao-xwblog)——[blog.xiaowuleyi.com](https://blog.xiaowuleyi.com) 的源仓库，官方仓库的滚动开发线（迭代先行于此，稳定后清洗发布至官方仓库），提交信息沿用 `theme:` / `mobile:` / `feat:` / `docs:` 前缀的中文风格

## 📄 License

[MIT](LICENSE) —— 拿去用，拿去改，拿去让更多人爱上写博客。
