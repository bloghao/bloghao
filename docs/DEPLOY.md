# 博客号 BlogHao 完整部署教程

从零开始，把这套博客部署到 Cloudflare（全程可使用免费套餐）。不想把代码跑在 Cloudflare 上、想用自己的服务器？见下方「方式三：Docker 自托管」。

> 在线示例：**https://blog.xiaowuleyi.com**（作者实例；Worker 名 `xwblog`，数据库 `xwblog-db`，图床桶 `xwblog-images`，与仓库内 wrangler.jsonc 一致）。给自己部署一套时，资源名可以原样沿用，也可以自行替换——与你的 wrangler.jsonc 保持一致即可。

## 方式一：一键部署（推荐，全程不碰命令行）

[![Deploy to Cloudflare](https://deploy.workers.cloudflare.com/button)](https://deploy.workers.cloudflare.com/?url=https://github.com/bloghao/bloghao)

点按钮 → 用 GitHub 账号授权 → 在设置页给 Worker、D1 数据库、R2 图床起好名字 → 点 **Create and deploy**。Cloudflare 会自动完成：

1. 把仓库复制一份到你的 GitHub 账号（以后改代码、提 Issue 都在这份副本上）
2. 按仓库内 `wrangler.jsonc` 开通 D1 数据库与 R2 存储桶，并把新资源的 id 回填进副本的配置
3. 构建并部署到 Workers，随后接管 **push 自动部署**（你往副本推代码，Cloudflare 自动重新部署，无需 GitHub Actions 密钥）

> 若账号还没用过 R2，会被要求先添加支付方式——免费额度内不扣费，只是验证。

部署完成后（约 1-2 分钟）打开 Workers 面板给出的 `https://<你的 Worker 名>.<你的子域>.workers.dev`：

- 访问 `/admin/` **创建管理员**（同第 4 节，首次进入即建号，欢迎文章已就位）
- 进后台「设置」**填站点链接**（同第 5 节，绑自定义域名前可先空着，用默认 workers.dev 域）
- 想绑自定义域名 → 第 6 节；想本地开发 → 第 9 节

> 副本仓库里的 GitHub Actions 部署工作流（`deploy.yml`）没有配置密钥，push 时会黄字警告并自动跳过——这是正常的，部署已由 Cloudflare 侧接管；想改用 Actions 部署见第 7 节。

以下第 0–7 节是**方式二：命令行部署**的完整步骤（想自己掌控每一步、或要写进自动化脚本时用）。

## 0. 准备工作

- 一个 Cloudflare 账号（免费版即可）：[dash.cloudflare.com](https://dash.cloudflare.com) 注册
- 本机安装 Node.js 18 或更高版本
- 本项目代码（clone 或 fork 后下载）

```bash
cd bloghao
npm install
npx wrangler login   # 会打开浏览器授权，登录你的 Cloudflare 账号
npx wrangler whoami  # 确认登录成功
```

## 1. 创建 D1 数据库

```bash
npx wrangler d1 create xwblog-db
```

输出大致如下：

```toml
[[d1_databases]]
binding = "DB"
database_name = "xwblog-db"
database_id = "xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx"
```

**把 `database_id` 复制**，打开 `wrangler.jsonc`，替换（仓库里已填的是本站自己的 id，部署你自己的副本时换成你的）：

```jsonc
"d1_databases": [
  {
    "binding": "DB",
    "database_name": "xwblog-db",
    "database_id": "粘贴你的 database_id"
  }
]
```

然后初始化表结构（幂等，可重复执行）：

```bash
npx wrangler d1 execute DB --remote --file schema.sql
```

## 2. 创建 R2 存储桶（图床）

```bash
npx wrangler r2 bucket create xwblog-images
```

> R2 免费额度：10GB 存储 / 每月 100 万次读、1000 万次写，个人博客绰绰有余。
> 不需要给桶开公开访问——图片统一通过你的 Worker 的 `/images/xxx` 路径带缓存头输出，桶保持私有更安全。

`wrangler.jsonc` 里的 `"bucket_name": "xwblog-images"` 若改名请同步修改。

## 3. 首次部署

```bash
npm run deploy
```

成功后 wrangler 会输出你的访问地址，例如：

```
Published xwblog v2.6.0
https://xwblog.<你的子域>.workers.dev
```

> 若你的 `wrangler.jsonc` 里设了 `"workers_dev": false`（关闭 workers.dev 平行入口），部署后不会生成 workers.dev 地址——删除该行重新部署，或直接按第 6 节绑自定义域。

## 4. 初始化管理员

浏览器打开：

```
https://你的域名/admin/
```

首次访问会显示「创建管理员」页面：

1. 填用户名（2-24 位字母、数字、_ 或 -）、密码（≥ 8 位）、昵称
2. 点击「创建并进入」
3. 系统自动生成一篇欢迎文章，你可以在后台删掉它，开始写自己的第一篇

> 该入口只在数据库没有任何用户时开放，之后重复访问就是普通登录页。

## 5. 基本设置

后台 →「设置」：

- **站点名称 / 描述 / 页脚**：出现在首页刊头、浏览器标题、RSS
- **站点链接**：填写最终访问域名（本站即 `https://blog.xiaowuleyi.com`），用于 RSS 和 sitemap 里的绝对链接。绑定了自定义域名就**务必填上**
- **站点头像 / 网站图标**：都从后台上传、存进 R2 图床，改即时生效
- **外观**：七套主题即点即换
- **评论**：可开关留言、可开启「先审后展」

## 6. 绑定自定义域名

workers.dev 域名在国内部分地区不稳定，正式使用建议绑一个自己的域名（本站绑的就是 `blog.xiaowuleyi.com`）。**前提**：这个域名已托管在同一个 Cloudflare 账号下（即域名的 DNS 由 Cloudflare 管理）。

方法一（面板操作，推荐）：Cloudflare Dashboard → Workers & Pages → `xwblog` → Settings → Domains & Routes → **Add → Custom domain**，填入 `blog.你的域名.com`，证书自动签发，几分钟内生效。

方法二（命令行）：在 `wrangler.jsonc` 增加后重新 `npm run deploy`：

```jsonc
"routes": [{ "pattern": "blog.xiaowuleyi.com", "custom_domain": true }]
```

绑定完成后还有一步别漏：后台「设置 → 站点链接」改成新域名（如 `https://blog.xiaowuleyi.com`）——RSS、sitemap、OG 分享卡里的绝对链接都取这个值。

## 7. 推上 GitHub + push 自动部署（命令行部署适用）

> 一键部署的副本**已经**由 Cloudflare Workers Builds 接管 push 自动部署，这节可以跳过。

```bash
git init
git add .
git commit -m "feat: bloghao 初始化"
# GitHub 上新建空仓库后：
git remote add origin git@github.com:<你>/bloghao.git
git branch -M main
git push -u origin main
```

仓库已内置 `.github/workflows/deploy.yml`。要启用它：

1. Cloudflare 面板 → My Profile → API Tokens → Create Token → 使用「Edit Cloudflare Workers」模板，并**额外勾选 D1 Edit 与 R2 Edit 权限**
2. GitHub 仓库 → Settings → Secrets and variables → Actions，添加两个 secret：
   - `CLOUDFLARE_API_TOKEN`：上一步的令牌
   - `CLOUDFLARE_ACCOUNT_ID`：面板首页右侧可以看到
3. 之后每次 push 到 `main`，GitHub Actions 会自动：类型检查 → 安装依赖 → 执行 schema.sql（幂等）→ `wrangler deploy`。另有内置的 `ci.yml` 与部署并行，跑类型检查 + 回归测试（`tests/` 700+ 用例），防止已修复的 bug 悄悄复发

> 更省事的替代：不配任何密钥，在 Cloudflare 面板 → 你的 Worker → Settings → Git 支持（Builds）连接 GitHub 仓库，push 即自动部署（一键部署的副本默认就是这条路）。

## 方式三：Docker 自托管（自有服务器）

不想把代码跑在 Cloudflare 上、手头有 VPS 时，仓库内的 `docker-poc/` 提供零改动的自托管方案：业务代码原样跑进一个 Node 容器，文章存进内置 SQLite（单文件、WAL 模式），图片存本地磁盘目录，也可以继续用 Cloudflare R2 桶（零出口流量费，备份自动异地）。单进程按域名同时托管多个完全独立的博客站，Cloudflare 退回只做 DNS + CDN。

```bash
git clone https://github.com/bloghao/bloghao.git
cd bloghao/docker-poc
docker compose up --build -d     # 镜像约 70MB（node:26-alpine），数据落在 ./data/<域名>/
```

要点：

- **站点配置**：把真实域名写进 `docker-poc/tenants.json`（`*.localhost` 只在本地有意义），重启容器生效；首次访问 `/admin/` 创建管理员，与 Workers 版完全一致
- **端口与反代**：默认监听 `8787`；`XWLBLOG_PORT=80` 可直接挂 80，`XWLBLOG_BIND=127.0.0.1` 只绑回环、交给 nginx / Caddy / 1Panel 反代分流——多站点靠 Host 头识别，反代必须透传 Host
- **HTTPS**：域名套 Cloudflare 橙云代理时，先用「灵活 SSL」回源源站 80 最快跑通；正式期建议前置 Caddy 终结 TLS，SSL 模式改「完全（严格）」
- **图片存储二选一**：默认本地磁盘；tenants.json 里 `storage: "r2"` 切换到共享 R2 桶（按域名前缀隔离），启动日志出现「[r2] 自检通过」即配置正确，`--copy-local-to-r2` 幂等迁移存量图片
- **定时任务**：定时发布（每分钟扫描）与北京时间 00:30 的备份 / 回收站清理随容器自动运行；图床桶在 R2 上时，备份快照同步变成异地备份

容量参考：4核8G / 200G NVMe 舒适跑 100 个站点（实测 3 租户单进程内存约 64MB，天花板在磁盘图片量而非 CPU / 内存）。完整部署清单（含国内镜像加速、验收明细）见 [docker-poc/DEPLOY.md](../docker-poc/DEPLOY.md)，架构与适配层说明见 [docker-poc/README.md](../docker-poc/README.md)。

## 8. 日常运维备忘

| 事项 | 命令 / 操作 |
| --- | --- |
| 看实时日志 | `npx wrangler tail` |
| 手动备份 D1（导出 SQL） | `npx wrangler d1 export xwblog-db --remote --output=backup.sql` |
| 恢复备份 | `npx wrangler d1 execute xwblog-db --remote --file=backup.sql` |
| 浏览数据 | Dashboard → Storage & Databases → D1 → xwblog-db → Console |
| 重置管理员（清空用户重新创建） | `npx wrangler d1 execute DB --remote --command "DELETE FROM users; DELETE FROM sessions;"`，再访问 `/admin/` |
| 查看图片占用量 | Dashboard → R2 → xwblog-images，或后台「媒体」页 / 概览页 |
| **整站搬家**（换服务器 / 换域名 / 重新部署） | 后台「设置 → 整站搬家」：旧站**导出整站包**（含全部内容与图床图片）→ 新站登录后**上传并一键还原**。**只允许还原到「没有内容的站」**（没有未删除的文章 / 微博 / 页面；刚装好的新站请先把自带的「示例文章」与「关于我」页面删进回收站），不覆盖不合并；包里不含管理员账号与各类密钥。大站可直接把包传进 R2 再还原：`npx wrangler r2 object put xwblog-images/bundles/xwblog-site-2026-10-16.zip --file=./xwblog-site-2026-10-16.zip`。详见 [GUIDE.md](GUIDE.md) §19 |

## 9. 本地开发

```bash
npm run db:init:local   # 初始化 .wrangler/state 下的本地 D1
npm run dev             # http://127.0.0.1:8787（本地 D1/R2 全模拟，不花钱）
npm run typecheck       # TypeScript 类型检查，提交前必须通过
npm test                # 回归测试（tests/，700+ 用例），提交前必须通过
npm run smoke           # 本地冒烟：起 wrangler dev 逐路由断言 200，改 SQL 拼接/渲染后必跑
```

本地与线上行为一致（同一套 Workers runtime）。上传的测试图片存放在本地模拟的 R2 里，不会占用线上额度。

## 10. 常见问题

**Q：一键部署时要求添加支付方式？**
A：R2 图床开通的前提——免费额度（10GB 存储）内不扣费，只是账号验证，放心添加。

**Q：一键部署后往副本 push，GitHub Actions 出现黄字警告「缺少 secrets」？**
A：正常现象。部署已由 Cloudflare Workers Builds 接管，`deploy.yml` 检测到没配密钥会自动跳过，不影响任何功能；想改用 Actions 部署再按第 7 节配置。

**Q：一键部署按钮点了没反应 / 授权失败？**
A：Deploy to Cloudflare 只支持公开仓库（本仓库即是）；确认浏览器没有拦截弹窗，GitHub 授权页里勾选仓库访问权限后重试。

**Q：部署时报 `database_id` 无效？**
A：确认你填的是 `wrangler d1 create` 返回的 UUID，且 `database_name` 与实际一致（本仓库为 `xwblog-db`）。

**Q：访问首页 500？**
A：多半是没执行 `d1 execute DB --remote --file schema.sql`，或 `wrangler.jsonc` 里 D1 的 binding 名被改了（必须叫 `DB`）。

**Q：图片上传失败？**
A：确认 R2 桶名与 `wrangler.jsonc` 一致（`xwblog-images`）；确认文件类型是 JPG/PNG/WebP/GIF 或 MP4/WebM，且 ≤ 25MB。

**Q：workers.dev 域名在国内访问慢/被墙？**
A：绑定一个自己的域名（第 6 步）通常即可解决，本站的 `blog.xiaowuleyi.com` 就是这么来的。

**Q：绑定自定义域名后 RSS / 分享卡片里还是旧的 workers.dev 链接？**
A：把后台「设置 → 站点链接」改成新域名并保存。

**Q：想改端口/项目名？**
A：项目名改 `wrangler.jsonc` 的 `name`；本地端口 `npm run dev -- --port 9000`。

## 11. 附：官网（bloghao.com）是怎么部署的（维护者备忘）

博客号官网是与博客系统互相独立的纯静态站点，源码在仓库 `website/` 目录（无构建链，改了即生效），部署在维护者自有服务器（甲骨文）上由 Caddy 静态直出（`bloghao.com`），与 Cloudflare 上的博客 Worker 完全无关：

- **改动发布**：修改 `website/public/` 后提交、推送，线上按静态文件方式同步部署目录即刻生效（官网纯静态、无构建步骤）
- **文档中心**：`website/public/docs/` 下的 HTML 由 `npm run build:docs` 从 `docs/*.md` 与根目录 `CHANGELOG.md` 预渲染生成（生成结果直接提交，仍是零构建静态页）；改了 Markdown 文档后重跑一次 `npm run build:docs`。该命令同时会按扫描 `website/public` 的真实页面重生成 `sitemap.xml`（**勿手改**），`robots.txt` 为手写的源站版
- **「博客号目录」**：数据在 `website/public/data/showcase.json`，访客走官网表单投稿（落盘待审），审核通过后把站点加进 JSON 即可；GitHub Issue 为兜底入口
- **在线示例**：官网指向的演示站 https://demo.bloghao.com 是引擎的另一套独立部署（`bloghao-demo` 仓库的 Docker 形态，DEMO_MODE 体验环境，机制见 [DEMO.md](DEMO.md)），专供访客体验；作者实例 blog.xiaowuleyi.com 不作演示用
- 官网与本博客 Worker 互不影响，改动官网不涉及任何 Cloudflare 资源
