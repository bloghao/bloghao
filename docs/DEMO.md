# 官方演示站（体验站）指南

> 给项目跑一个「随便看、随便玩」的在线体验站：预置一年跨度的仿真数据，任何人的操作都落在
> 独立资源上，每 2 小时自动重置——与生产站完全隔离，互不影响。
> 站点性质全站公示（顶部横幅 / 登录页 / 关于页）：**演示体验版 · 非最新正式版 · 仅供测试体验 ·
> 数据每 2 小时自动清空重置**。
>
> 官方演示站地址：**https://demo.bloghao.com**（官网 bloghao.com 的演示入口都指向这里）

## 它是什么

演示站 = **同一份代码、第二套 Cloudflare 资源、定时自动重置**：

| | 生产站 | 演示站 |
|---|---|---|
| Worker | `xwblog`（wrangler.jsonc） | `xwblog-demo`（wrangler.demo.jsonc） |
| D1 / R2 | 生产库与图床 | 独立的 demo 库与图床 |
| 数据 | 真实内容 | 种子数据（54 篇文章、31 条微博、82 条评论、演示会员、60 天访客统计），每 2 小时清库重灌 |
| DEMO_MODE | 未设置（所有演示逻辑惰性） | `"1"`（播种 / 重置 / 演示守卫生效） |

体验者的一切操作——发文章、传图、换主题、改设置——都只落在 demo 资源上；重置后自动恢复
「刚出厂」状态，下一位体验者看到的永远是一样的完整站点。

## 演示站专属行为（DEMO_MODE 门控）

- **自动播种**：首次请求发现空库，自动建表（执行 schema.sql）并灌入种子数据（`src/demo.ts`）
- **自动重置**：cron `23 */2 * * *`（每 2 小时的第 23 分钟）清空全部业务表 + R2，重新播种
- **登录页公示账号**：账号 `demo` / 密码 `demo1234`，自动填充，无需向站长索取
- **全站体验版横幅**：所有公开页顶部公示「演示体验版（非最新正式版）· 仅供测试体验 · 数据每 2 小时自动清空重置」
- **会员体系开着**（`membersEnabled=1`）：演示会员账号同款公示——`demo` / `demo1234`（普通会员），
  可体验会员卡、每日登录 +1 积分、评论积分、排行榜与**会员专享文付费墙**（文章《会员专享：博客
  第二年的完整运营数据》，登录会员解锁）；另有一名 coffee 档背景板会员撑排行榜与评论徽标
- **访问密码演示文**：文章《加密演练：这篇文章带访问密码》，密码 `demo1234` 在摘要里公示，
  体验密码解锁流程（密码墙与付费墙是两套独立的门）
- **禁改密码**：`PUT /api/admin/password` 返回 403（改掉会让整个重置周期内其他体验者进不了后台）
- **禁闭站**：设置里的 `siteClosed` 被服务端强制回 `0`，开关在后台 UI 禁用（防止有人把体验站关掉）
- **禁外发通知**：发布/评论钩子（TG 频道、评论 Webhook）整段短路，demo Worker 不对外发任何请求
- **不进搜索引擎**：robots.txt 返回全站 `Disallow: /`，所有公开页带 `noindex`
- **不备份**：demo 配置没有备份 cron，settings 里备份默认关闭
- 侧栏显示橙色「演示」徽标；灰度模式、主题切换、编辑器、插件等其余功能照常可玩

## 部署自己的演示站

前提：本机已 `wrangler login`（与生产同一账号即可，demo 资源同样在免费额度内）。

```bash
# 1. 创建 demo 专属资源（名字可自定，与 wrangler.demo.jsonc 保持一致）
npx wrangler d1 create xwblog-demo-db
npx wrangler r2 bucket create xwblog-demo-images

# 2. 把上一步输出的 database_id 填进 wrangler.demo.jsonc（替换占位符）

# 3. 部署
npm run deploy:demo
```

部署完成后命令行会给出 `https://xwblog-demo.<你的子域>.workers.dev` 地址，**打开即自动播种**，
无需任何初始化命令。`wrangler.demo.jsonc` 里已声明 `routes`（官方站绑 `demo.bloghao.com`），
部署时自动完成 Custom Domain 绑定与证书签发；自建演示站不需要这个域名的话，删掉 `routes`
一条再部署即可，或在 Cloudflare 后台该 Worker 的 Settings → Domains & Routes 手动管理。

> 配额说明：演示站与生产站共享账号的免费额度（Workers 10 万请求/天、D1 5M 行读取/天），
> 演示站流量很小可忽略；若想完全隔离配额，用另一个免费 Cloudflare 账号 `wrangler login` 后
> 执行同样的三步即可。

## 本地预览

```bash
npm run dev:demo
```

无需创建任何资源（本地模拟库），首次打开页面自动建表 + 播种，直接预览演示站全貌。

## 独立 Docker 体验站仓库

演示站也可以脱离 Cloudflare 自托管：仓库 **`bloghao-demo`**（与官方仓库分开维护）把演示站
抽成独立仓库，用 Docker 在任意服务器上跑同一套 DEMO_MODE 逻辑（自动播种 + 定时重置 +
演示守卫），适合给服务器侧的体验环境用。本仓库与它只保持「代码快照」关系——体验站的功能
以这里为准，改种子内容后按该仓库内的同步脚本重新导出即可。

> **官方演示站现行形态（2026-10-11 起）**：https://demo.bloghao.com 就是这个 Docker 自托管
> 版——跑在甲骨文服务器（`/home/ubuntu/apps/bloghao-demo`，容器 127.0.0.1:8786，Caddy
> demo 站点块反代），租户 `tenants.json` 配 `demo.bloghao.com`；此前跑在另一台小服务器
> （nginx 反代）的旧部署已停。上面的 Worker 形态保留作备用：`wrangler.demo.jsonc` 里的
> D1/R2 资源尚未创建（database_id 是占位符）、routes 已注释，要切回 Worker 形态需先建
> 资源再 `npm run deploy:demo`。同步流程：主仓库改动后，在 bloghao-demo 仓库本地跑它的
> `scripts/sync-from-bloghao.sh`（从本仓库导出快照）提交推送，服务器侧以 rsync 文件快照
> 方式同步部署目录（线上现行形态；`git pull && docker compose up --build -d` 为该仓库最初的提法）。

## 改种子内容

种子数据全部在代码里（重置时可从代码原样重建，不依赖外部服务）：

- `src/demo-posts.ts` —— 文章（标题/正文/标签/发布时间/浏览点赞数，含草稿与定时）
- `src/demo-content.ts` —— 微博、评论（含楼中楼与待审）、友链、独立页面、settings、访客统计
- `src/demo-images.ts` —— 程序化生成的 SVG 配图（打进 bundle，重置时写入 R2）

改完后 `npm run deploy:demo` 重新部署生效；本地 `npm run dev:demo` 刷新即可看到新版种子。
`tests/demo.test.ts` 守着种子数据的不变量（slug 唯一、正文安全、评论树合法、图片引用存在等），
改内容后跑一遍 `npm test`。

## 常见问题

- **演示站会被仓库更新自动刷新吗？** 不会。演示站代码只在你手动 `npm run deploy:demo` 时更新；
  生产站的自动部署链路（Workers Builds / deploy.yml）只认 `wrangler.jsonc`，不碰 demo 配置。
- **两次重置之间有人把站改乱了怎么办？** 等下一个整点周期自动恢复；最恶劣的行为
  （改密码、闭站、外发通知）已被 DEMO_MODE 直接禁止。
- **体验者上传的图片会撑爆 R2 吗？** 每次重置会清空 R2 只保留种子图；上传另有大小与类型限制。
- **重置时正在写文章的体验者会丢稿吗？** 会——草稿箱内容随重置清空，登录页与站点描述里已注明
  「数据每 2 小时自动重置」。想更保守可把 cron 改成 `23 */6 * * *`（每 6 小时）。
