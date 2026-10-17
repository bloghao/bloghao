# 文档漂移审查（夜间自动审查）— 2026-10-15

> **夜间自动审查（2026-10-15）· 未经人工复核，结论仅供参考。**
>
> 范围：AGENTS.md、docs/（GUIDE / API / DEPLOY / DEMO / PLUGINS / PLAZA / ROADMAP / RELEASING）、README.md、website/ 文档页机制抽查。方法：每条可机器核验的声明到代码取证（API.md 对照 src/api.ts 与各模块；GUIDE 对照 public/admin/app.js MENU 与各 view；DEPLOY/DEMO 核命令与脚本存在性；AGENTS 防线描述对照代码现状）。审查为只读，未改任何文件。
>
> 排序原则：先「契约性错误」（数字/机制写错，会误导调用方或运维），再「内容过期」，最后「轻微」。每条给 文档位置 → 代码证据 → 可直接采纳的替换文案。

## 一、契约性错误（优先修）

### D1. API.md：track 限流数字是 A4 修复前的旧值
- 文档：docs/API.md:68「同 IP 10 分钟限 120 次」
- 代码：src/api.ts:2432 `rateLimit('track:...', 30, 10 * 60_000)`——2026-10-12 审计 A4 收口 120→30，文档未回写。
- 替换文案：「同 IP 10 分钟限 30 次」

### D2. API.md：settings 可写键清单缺 12 个键、敏感键打码清单过期
- 文档：docs/API.md:311（GET/PUT /api/admin/settings 可写键枚举 + 敏感项说明）
- 代码：src/db.ts DEFAULT_SETTINGS（24-108）与 src/api.ts:1731 `SECRET_SETTINGS`。文档缺失的键：`siteMode`（站点模式）、`appearance`（B9 外观变量）、`siteNoindex`（全站 noindex）、`turnstileSiteKey`/`turnstileSecret`（成对校验）、`serverPluginsDisabled`、`tgChannelChatId`、`commentWebhookUrl`、`footerHtmlCode`、`bufferAccessToken`/`bufferChannelId`、`plazaEndpoint`/`plazaToken`、`edition`（语言版本）；敏感打码清单文档只列 externalToken/telegramBotToken/telegramWebhookSecret 三键，代码实为七键（+commentWebhookUrl/bufferAccessToken/plazaToken/turnstileSecret）。
- 替换文案（在原列表相应位置补）：「`siteMode`（blog-weibo/weibo-blog/blog/weibo 四选一）, appearance（主题外观变量 JSON，非法整体 400）, siteNoindex（全站 noindex 开关）, turnstileSiteKey/turnstileSecret（注册人机验证，成对启用否则整体 400）, serverPluginsDisabled, tgChannelChatId, commentWebhookUrl（公网 http(s) 校验）, footerHtmlCode（≤5000 字，管理员信任级 HTML）, bufferAccessToken/bufferChannelId, plazaEndpoint（公网 https 校验）/plazaToken, edition（zh/en）」；敏感项句改为「`externalToken`/`telegramBotToken`/`telegramWebhookSecret`/`commentWebhookUrl`/`bufferAccessToken`/`plazaToken`/`turnstileSecret` 为敏感项，GET 与 PUT 的响应一律打码」。

### D3. API.md：净化白名单摘要包含代码并不保留的 `wbr`
- 文档：docs/API.md:397（保留标签列表含 `wbr`）
- 代码：src/sanitize.ts:40-48 `ALLOWED_TAGS` **不含 wbr**（wbr 只在 VOID_TAGS:15 里参与丢弃扫描）；`<wbr>` 实际走「不认识的标签：剥壳留字」被剥掉。
- 替换文案（二选一，按站长拍板）：① 改文档——从保留列表删去 `wbr`；② 改代码——ALLOWED_TAGS 补 `wbr`（wbr 无属性无内容，零风险，排版上更有用）。报告建议 ②，但两者必须取其一消除矛盾。

### D4. DEPLOY.md：workers.dev 部署指引与本仓库 `workers_dev:false` 矛盾
- 文档：docs/DEPLOY.md:19、92-97（§3 成功后给出 workers.dev 地址）、226（FAQ）
- 代码：wrangler.jsonc:36 `"workers_dev": false`（2026-10-12 审计 C2 关闭平行入口；docs/RELEASING.md:107 台账登记为个人定制，官方版不受影响）。文档面向官方版自洽，但在本仓库当前配置下部署后没有 workers.dev 地址。
- 替换文案（§3 成功输出示例后补一句）：「> 若你的 wrangler.jsonc 里设了 `"workers_dev": false`（关闭 workers.dev 平行入口），部署后不会生成 workers.dev 地址——删除该行重新部署，或直接按第 6 节绑自定义域。」

## 二、内容过期（数字/清单与代码不符）

### D5. 演示站部署口径（**已知实例，用户提供**）
- 文档：AGENTS.md:235（另 18 行相关表述）「本地跑同步脚本提交推送 → 146 上 git pull + docker compose up --build -d」
- 实际（站长口径，服务器不可 SSH 核实也不需核实）：**线上是 rsync 文件快照**。
- 替换文案（AGENTS.md:235 相应句）：「……改 demo 引擎/种子或公开渲染后：本地跑同步脚本提交推送 → **服务器侧以 rsync 文件快照方式同步部署目录**（线上实际形态；git pull + docker compose up 的提法已过期）」。

### D6. GUIDE.md §3 后台导览整段过期（菜单分组、分类页、设置页签）
- 证据：public/admin/app.js:146-166 MENU 实为四组「数据 / 内容 / **互动** / 系统」；「分类」一级菜单已并入文章页（app.js:3444-3447 重定向 + 746-748 双页签）；设置页是「站点 / 互动 / 进阶 / 数据」四页签（app.js:2729-2735），含 GUIDE 未记载的「语言版本（English 0.1）」（app.js:2812-2817）与「禁止搜索引擎收录」（app.js:2881-2884）；「外部发布」是「进阶」页签内分组（app.js:2869-2921），GUIDE:237/265/362/477 的「设置 → 外部发布」指路不准；「会员功能」开关实名「开启会员体系」（app.js:2846-2849）。
- 替换文案（可直接采纳，代理已核对行号）：
  - GUIDE.md:62-64 → 「左侧导航栏按『数据 / 内容 / 互动 / 系统』分组（顶部是『查看主页』外链和高亮的『写作』按钮），共十五个入口：」
  - GUIDE.md:75 「分类」行删除，并入文章行：「| 内容 | **文章** | 全部文章的管理列表 + 第二页签『分类标签』（分类增删改、全站标签预建与删除）：搜索、按状态筛选、查看 / 编辑 / 置顶 / 下架 / 删除 |」
  - GUIDE.md:82 → 「| 系统 | **设置** | 四个页签——站点（站点信息、头像与图标、站点模式、SEO 与统计、语言版本、改密码）、互动（评论规则、会员、访客统计）、进阶（灰度 / 闭站 / 外部发布 / 服务端插件）、数据（订阅与备份、数据导出） |」
  - GUIDE.md:237/265/362/477 → 「后台『设置 → 进阶 → 外部发布』」（477 行改「进阶 → 服务端插件」）
  - GUIDE.md:427 → 「后台『设置 → 互动 → 会员』的『开启会员体系』开关（默认关）」；473 行设置表项名改「会员（开启会员体系）」
  - GUIDE.md:474/476 → 控件实名「排行榜展示条数」「开启访客统计采集」
  - GUIDE.md:480 → 「| **修改密码** | 『站点』页签底部『账号』区，旧密码 + 新密码（8-64 位） |」
  - §16 表补两行：「语言版本（英文测试版 English 0.1）」「禁止搜索引擎收录（noindex）」（app.js:2812-2817 / 2881-2884）

### D7. 「六套主题」→ 七套（README 四处 + DEPLOY 一处）
- 文档：README.md:23/38/80/162、docs/DEPLOY.md:122
- 代码：src/themes/registry.ts:273-320 THEMES 七套（含 rednote 小红书）；public/market/catalog.json 含 rednote。
- 替换文案：全部改「七套主题」；README:38 特性表列举补「小红书（发现页瀑布流笔记卡）」。

### D8. README/PLUGINS：服务端插件「三个官方示例」→ 五个
- 文档：README.md:39、docs/PLUGINS.md:97/104
- 代码：src/hooks.ts:356 `SERVER_PLUGINS = [tgChannel, commentWebhook, bufferSync, plazaSync, footerHtmlPlugin]`。
- 替换文案：README:39 → 「另有随内核运行的服务端插件钩子（TG 频道同步、微博同步 Buffer、评论 Webhook、页脚注入、广场同步五个官方插件）」；PLUGINS.md:97 → 「（参考评论 Webhook、广场同步等官方插件的实现）」；PLUGINS.md:104 → 「更多服务端钩子：友链申请通过等事件（微博发布钩子 onWeiboPublished 已上线）」。

### D9. DEMO.md：种子评论数
- 文档：docs/DEMO.md:18「85+ 评论」；代码：src/demo-content.ts:100-219 DEMO_COMMENTS 共 82 条（tests/demo.test.ts:100 断言 length 相等）。
- 替换文案：「82 条评论」。

### D10. DEPLOY.md：测试规模与示例版本号
- 文档：docs/DEPLOY.md:159/200「30+ 用例」；代码：tests/ 48 个文件 552 个 test()（README 已写 300+）。docs/DEPLOY.md:95「Published xwblog v1.0.0」；package.json version 2.5.1。
- 替换文案：两处改「300+ 用例」；版本号改 v2.5.1。

### D11. README：插件目录列表缺 douban-media
- 文档：README.md:166；代码：public/plugins/manifest.json 登记 3 个（hello-sign / wechat-collect / douban-media）。
- 替换文案：「├── public/plugins/ # 编辑器插件（hello-plugin / wechat-collect / douban-media）」

### D12. PLAZA.md：混排分项区间轻微不符
- 文档：docs/PLAZA.md:78「三因素都压在 0~1.5 区间」；代码：plaza/src/core.ts:195-208 三项上限分别 1 / 0.5 / 0.3（总分上限 1.8）。
- 替换文案：「`score = recency + weight + jitter`，三项分别压在 1 / 0.5 / 0.3 以内（总分上限 1.8），没有谁能一票定序」。

### D13. API.md：三处出参描述不全（轻微）
- docs/API.md:130 /api/admin/stats 缺 `version` / `db:{weibo,pages,comments,members}` / `backup:{enabled,at,bytes}`（api.ts:482-498）；docs/API.md:338 /api/meta/themes 缺 `appearance` 字段（api.ts:2486）；docs/API.md:341 /api/admin/members items 缺 `display_name` / `avatar` / `updated_at`（db.ts:1314 MEMBER_ADMIN_COLS）。
- 替换文案：在三处分别补上述字段名。

## 三、代码侧过期文案（顺带发现，改代码不改文档）

- public/admin/editor.js:637 分类下拉提示「在后台**『分类』**里维护」——「分类」页已并入文章页，与 GUIDE §4 矛盾。建议改「在后台『文章 → 分类标签』里维护」。
- src/db.ts:1237 内置欢迎文章正文主题列表只有 5 套（「微信公众号风 / 纸墨 / 极简 / 夜航 / 手账」），现 7 套。建议补「比特币 / 小红书」。

## 四、反向漂移（文档正确、实现缺失）

- AGENTS.md 演示站节「`/api/admin/backup`、`/api/admin/export/*` 全部 isDemo 短路」——**export 半边无实现**（src/export.ts 全文无 isDemo；详见 SECURITY-AUDIT-2026-10-15.md F3）。文档不用改，改代码。

## 五、核对一致、无需改动（摘要）

- **API.md**：端点清单、鉴权口径（Origin、Token 双头、打码语义）、文章/微博/友链/分类/页面/回收站/上传/评论/会员/外部/MCP 各表的参数与状态码（含微博 video 契约、MCP 五工具与限流、unlock 限流 10/10min、external base64 传图、422/usage）与代码逐项吻合；HTML 白名单摘要除 wbr 外全对。
- **GUIDE.md**：除 §3 导览与设置指路外，§1-§19 的数字/限制/快捷键/章节锚点几乎全部吻合（限流、字数上限、压缩参数、话题规则、会员积分、回收站 30 天等逐项对上）。
- **DEPLOY.md / RELEASING.md**：命令、binding、cron、路径全部存在且一致（除上列项）。
- **DEMO.md**：DEMO_MODE 门控、WIPE_TABLES、cron、demo 账号、三项禁令、robots/noindex、不备份、CF 配置占位——逐项一致（除 D9/D5 涉及的部署句）。
- **PLUGINS.md / PLAZA.md**：manifest 解析、键名、钩子表、广场协议（ingest/签名/限额/locked/deleted/官方 hub/pull 口径）与代码逐项一致（除 D8/D12）。
- **ROADMAP.md**：B19/B20 状态标记与实际相符；B21 尚无任何实现（grep 仅命中 ROADMAP 自身），状态自洽。
- **website/ 文档页机制**：website/build-docs.mjs:12-14/655-710 证实「sitemap.xml 自动重生成（扫描 website/public 真实 html，lastmod 取 git 提交日期）」「勿手改」「robots.txt 手写」的 AGENTS 声明与实现一致；tests/website-sitemap.test.ts 在位。

## 六、待拍板

1. **D5 的完整改法**：AGENTS.md:18 与 235 两处都要改；是否同时在 AGENTS 登记「线上部署 = rsync 快照」的来源事实（何时起、由哪个通道），避免下次审计再拿旧口径当真相。
2. **AGENTS.md:17 官网同步口径自相矛盾**：17 行说官网「改动上线 = 服务器上 git pull 同步站点目录」，结构速查 website/ 条目又说「ops 面板『官网』卡片从官方仓拉 tarball 同步」——两条路并存还是后者已替代前者，需站长确认后统一。
3. **D3 wbr**：改文档还是补代码（建议补代码，一行）。
4. **D4 workers_dev**：官方版文档要不要提 workers_dev:false 的例外说明（涉及官方版与本仓库的定位差异，属发布挑洗口径）。
