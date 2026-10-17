# 开发方向备忘

记录**已调研、尚未启动**的功能方向。每项保留调研结论与待决策点，启动开发时不必重新摸底；一旦定案实现，具体用法移入 GUIDE / API / THEMES 等功能文档，本文件只留条目与状态；拍板「不做」的进文末不做清单，编号永久空缺不回收。

2026-10 对标 WordPress / emlog 等系统做过一轮全量能力盘点，方向按三档优先级管理：**A = 一定要做**（下一步就做，多数成本低、确定性强）；**B = 未来一定要做**（重要，但有前置依赖或需先拍板）；**C = 加分项**（可有可无，有富余再做）。

**建议执行顺序（2026-10-13 更新，2026-10-16 增补 B25）**：~~A 区~~（已收官，A8 随本日落进 AGENTS.md）。B 区已落地 **B9 主题外观变量（2026-10-16 v2 全量转正：圆角旋钮 + 实时预览 + 皮肤包）**、**B10 MCP 服务器（2026-10-11）**、**B19 微博视频（2026-10-13）** 与 **B8 皮肤 / 插件可安装化（2026-10-16 拍板落地：CSS 皮肤包 + 编辑器插件远程安装 + 服务端插件配置通道，市场分发仓库另起待立项）**；下一批：**B21 IndexNow**（提案就绪待批准）与 **B22 旧 slug 301**（实现路待拍板）；~~**B20 站长 SEO 自定义两小件**~~ 与同批立项的 **B23 分类描述 + 面包屑 / B24 链接预取** 已于 2026-10-13 一并落地；随后 B3 通知渠道抽象（国内触达）；再往后 B6 备份异地化 / B13 管理员安全包；**B5 WXR 导入是下个战略大件候选**（获客价值大于一切 SEO 微优化，2026-10-13 调研结论已入档，启动时机与 B3 的先后由站长拍板）。**B25 广场 2.0**（2026-10-16 立项）的 P0+P1 属小件先行档（纯 website/ 前端 + hub 小扩，1–2 天 + 1 周见效最快），可与上面任一批并行插队；P2 起需拍板。B8 主题 / 插件市场 2026-10-08 立项、2026-10-16 拍板并落地第一批（可安装形态决议见条目），剩市场分发仓库另起待立项。C 区按富余随缘挑。

## 优先级总览（2026-10-07 更新）

### A 区 · 一定要做

| # | 事项 | 说明 |
| --- | --- | --- |
| A1 | ✅ 数据导出（2026-10 完成） | Markdown + 图片打包 / WordPress WXR；后台「设置 → 数据导出」，用法见 GUIDE / API |
| A2 | ✅ 独立页面系统 + 导航自定义（2026-10 完成） | 自建页面渲染在 /page/:slug、导航跟随页面、「关于我」迁入（/about 短链不变）；用法见 GUIDE / THEMES / API |
| A3 | ✅ JSON-LD 文章结构化数据（2026-10 完成） | 文章页自动输出 schema.org BlogPosting（北京时间口径、image 三级兜底、tags→keywords）；零配置，render.ts `articleJsonLd()` |
| A4 | ✅ WebP 自动转换（2026-10 完成） | 上传超 150KB 或最长边超 2000px 优先转 WebP（质量 0.75），旧浏览器回退 JPEG/PNG，产物更大则保留原图 |
| A5 | ✅ 服务端插件钩子 + 官方示例（2026-10 完成） | src/hooks.ts 总线 + 三个官方示例（TG 发布同步 / 评论 Webhook / 页脚自定义）；后台启停，详见 PLUGINS.md |
| A6 | ✅ 编辑器 Markdown 快捷输入（2026-10 完成） | 富文本行首标记 + 空格自动转块级格式（引用 / 标题 / 列表 / 代码块 / 分割线） |
| A7 | ✅ 一键部署（2026-10 完成） | Deploy to Cloudflare 按钮：fork 副本 → 自动开通 D1/R2 → Workers Builds 接管，命令行部署降为方式二 |
| A8 | ✅ 复杂度预算原则写入 AGENTS.md（2026-10-07 完成） | AGENTS.md 开头新增「复杂度预算」一节：新功能归宿三档排序（客户端 → 插件 → 内核自洽小文件）、进内核走「单文件模块 + Node 可测 + 防线登记」三件套、运行时依赖只有 hono 的依赖预算、无构建链同属预算；顺手把开头「约 20 个 TS 文件」修正为实际口径 30 余个 |
| A9 | ✅ 站点状态开关：一键灰度 + 一键闭站（2026-10 完成） | 灰度 = `<html>` filter 去色；闭站 = 中间件全站 503 + Retry-After（保收录），逻辑在 src/closed.ts；用法见 GUIDE |

### B 区 · 未来一定要做

| # | 事项 | 说明 |
| --- | --- | --- |
| B2 | ✅ 会员体系 P1（2026-10-07 完成） | 注册登录 / 评论带会员身份 / 积分（含后台手动调整）/ /rank 榜单 / 付费墙 / 后台会员管理全量落地；拍板口径与契约见 DEVPLAN，用法见 GUIDE §15。后续 P2 / P3 见 B15 / B16 |
| B3 | 通知渠道抽象 | TG 之外加飞书 / 企业微信 / Bark / Server酱——国内用户装 TG 本身就是门槛；新留言 / 定时发布 / 备份告警复用同一渠道配置 |
| B4 | ✅ FTS5 中文搜索（2026-10 完成） | /search 换 D1 原生 FTS5（trigram 适配中文），bm25 相关度排序，微博正文纳入搜索；机制见 src/fts.ts，防线见 AGENTS.md |
| B5 | WordPress / emlog / Typecho 导入工具（**2026-10-13 调研更新**） | 数据导出（A1）的另一面，换博客用户的主要入口——对获客的价值大于一切 SEO 微优化。**拼装件复核几乎全有**：WXR 解析（src/xml.ts 的 XML 处理基础 + 正则/流式解析器）、正文 HTML→Markdown（html-md.ts `htmlToMd` 现成）、文内外链图片转存（collect.ts + store.ts `transferImage` 魔数识别转存整套现成）、分类标签落库 / `cleanSlug` / cstDate 时区口径全有；**真正工程量在 wp: 元数据映射**——attachment 附件（wp:attachment_url → 转存站内并重写正文引用）、草稿态 / 密码文（wp:post_password → protect.ts 口径）、wp:post_type 页面与文章分流、定时与状态语义。scripts/ 已有 emlog 迁移脚本留档可复活 |
| B6 | 备份异地化（**插件化路子已就绪，2026-10-16**） | D1 与备份 R2 同在一个 Cloudflare 账号，账号被盗一锅端；每晚备份额外推一份到 GitHub 私库或另一账号。**实施建议**：`onBackupCompleted` 钩子（payload.key 凭 R2 取件）写官方服务端插件，或先用通用出站 Webhook 的 backup_completed 事件通知，不必进内核 |
| B7 | 友链健康巡检 | 每周 cron 探活（HEAD 请求），失效标灰并后台提醒——友链在线申请开放后失效只会更多 |
| B8 | ✅ 主题 / 插件市场（2026-10-08 立项，未开工） | **已拍板**：市场独立于主仓库，另起分发仓库（市场目录站 + 主题 / 插件包托管 + 预览，形态可仿官网 bloghao.com 的纯静态路子），主仓库 catalog.json 改为指向远程源或由市场仓库同步；**未拍板**：主题可安装形态——Workers 运行时不能加载 bundle 外代码，七套主题是编译期 SSR 模块，「一键安装」只有两条路：① 降级 CSS 皮肤包（真·运行时安装，只解决换色换字体，解决不了布局差异）② 每用户触发重部署（否定「无构建链、部署即生效」体验，且与 docker-poc 的 Node 动态 import 分叉出两套安装语义）；编辑器插件无此限制（public/plugins/ 本就运行时加载），市场安装通道 = 远程获取落 R2 + 路由下发，服务端 hooks 插件则与主题同受编译期限制；启动前还需定主题包版本字段（catalog 条目 minVersion）与主题作者安全规范（净化防线 esc/escAttr/外链包装是内核责任边界，第三方主题脱离类型体系手写难以保证），UX 参考 Halo 应用中心。**已拍板并落地（2026-10-16）**：主题可安装形态取 **CSS 皮肤包路**——外观变量体系为引擎，皮肤包 = 一份 appearance 预设 + 可选自定义 CSS（src/skinpack.ts 样式安检门），市场目录内联 pack 一键应用（官方四款：苔原 / 蜜柑 / 方直 / 墨夜）；**完整主题（布局级）的运行时安装不做**（Workers 不能加载 bundle 外代码，重部署与 docker 动态 import 双双违背产品定位），布局差异走官方主题随版本演进 + 主题内布局开关；服务端插件的运行时安装 / 热加载同样不做（官方注册表 PR 模式）。已落地：皮肤包（市场内联 + 粘贴导入）、编辑器插件远程安装（src/pluginpkg.ts，https 抓取落 R2 + /plugin-files 下发）、服务端插件配置通道（settings.serverPluginConfig + configFields/configValidate + 通用出站 Webhook 官方插件）；**未立项**：市场分发仓库（另起仓库托管皮肤包与插件包，启动待排期） |
| B9 | ✅ 主题外观变量（2026-10-16 v2 全量转正） | 后台「皮肤 → 外观变量」（内测标）：颜色 7 语义角色（主色/正文/次要/背景/卡片/分隔线/链接）+ 正文字体（衬线/黑体预设 + 自定义栈）+ 正文字号，映射到各主题自己的 CSS 变量输出覆盖样式；机制在 src/appearance.ts（含 bitcoin/rednote 主色 color-mix 深浅衍生），防线见 AGENTS.md。**v2 已落地（2026-10-16）**：七主题圆角 token 化（`--p-radius` 基准 + `--p-radius-lg` calc 派生，217 处 border-radius 收编，镜像守卫核对默认值与系数）、外观面板圆角旋钮（0-24px，0 = 直角风格）与假文章卡实时预览（meta 出参带变量名清单与 lgFactor）；主题作者契约见 docs/THEMES.md「外观变量契约」 |
| B10 | ✅ MCP 服务器（2026-10 完成） | `POST /mcp` Streamable HTTP 无状态模式（JSON-RPC 2.0 手写零依赖，不开 SSE），复用 externalToken 鉴权；五工具：publish_post（Markdown 净化入库）/ list_posts / get_post / list_comments / publish_weibo，机制在 src/mcp.ts，防线见 AGENTS.md，用法见 GUIDE §8.3 |
| B11 | 🔶 官网增长两件套（演示站半边已落地） | 演示站引擎已建成（DEMO_MODE 种子 + 每 2 小时重置 + 独立体验站仓库，见 docs/DEMO.md）；剩**博客号目录深化**：每站截图 + SEO 落地页，对标 WordPress showcase |
| B12 | ✅ 后台系统状态卡（2026-10 完成） | 概览页「系统」面板：微博/评论/会员行数 + 最近备份时间与体积（backup.ts 每晚回写的 settings 记账位，只读不查）；/admin/stats 扩 db/backup 字段。「成本可见」呼应零成本卖点 |
| B13 | 管理员安全包 | TOTP 两步验证 + 登录失败 TG 告警 + 活跃会话管理。安全是招牌卖点，招牌要焊牢 |
| B14 | 多作者协作 | 与「个人博客」定位有张力，启动前先拍板要不要 |
| B15 | 会员 P2：支付 / 收款闭环 | 从会员体系拆出的后续：收款方式待拍板（个人站长轻方案优先——卡密 / 爱发电类，避免重对账），打通后会员档位可自助购买 |
| B16 | 会员 P3：升级机制与兑换码 | 依赖 B15；档位升级补差价、兑换码批量发放 |
| B17 | ✅ 广场系统（2026-10-10 立项并当日落地 V1） | 官网上聚合展示各博客号的微博 + 文章，信息流按「权重 + 新文推荐 + 随机展示」混排。**关键前置：官网（website/）是纯静态、无后端，广场必须有一个 hub**——候选：官网侧另起独立服务做聚合与排序（与官网同域反代即可）。数据流两条路待拍板：① pull——hub 定时抓各站公开 RSS / 开放 API（零改动，但触达慢、无发布时机的互动数据）；② push——用户站走 src/hooks.ts 钩子总线的官方「广场同步」插件，发布时上报，是否同步由后台插件启停天然承载 opt-in（站长第 2 点即此路，A5 钩子体系正是留的口子），两路可并存（push 为主、pull 补漏）。排序要点：权重（互动量 / 更新活跃度）+ 新文时间加权 + 随机位混排，hub 侧需防刷（各站上报带签名 token）。防泄漏口径照搬 AGENTS.md 清单：加密文 / 会员锁文不进广场（push 路插件端按 hasPassword / locked 跳过，pull 路只取 RSS 试读段口径）。**已落地（V1）**：hub 独立 Worker 在 `plaza/`（hono + core.ts 纯函数，push HMAC ingest + RSS pull 补漏 + 混排评分 feed），博客端官方「广场同步」插件入 `src/hooks.ts` 注册表（加密/锁文 locked 跳过），官网广场页 bloghao.com/plaza；协议与部署见 docs/PLAZA.md。与 B11 博客号目录的关系：目录是站点级收录、广场是内容级流，v1 共用同一人工审核信任模型；B18 认证已预留 sites.verified 徽标位 |
| B18 | 博客号作者专属认证（蓝V式，**立项待研究，2026-10-10 站长提出**；B17 落地时已预留 `sites.verified` 徽标位与 feed 出参，官网展示「✔︎ 认证」，v1 手工开关） | 所有基于 bloghao.com 部署的博客作者可申请专属认证标识。**前置依赖：身份锚点**——B17 广场 hub 是最自然的发证方：站点所有权验证（用户站按指引在设置页填入 hub 下发的校验 token，或 hub 探测站点上的验证文件）通过后，hub 签发「站名 + 作者」认证凭据。展示两端：广场信息流作者徽标（B17 内直接渲染）+ 用户站前台可选挂认证标（如关于我 / 评论作者旁）。凭据必须走签名 token 而非人工标注（站点可自行验证），要支持吊销与换主；冒用官方名义的站点要能在 hub 侧标记未认证。启动前先拍板：认证分级（个人 / 组织？）与收费与否 |
| B19 | ✅ 微博视频（2026-10-13 落地） | **站长拍板**：一条微博只能 1 个视频、≤ 25MB（复用 store.ts `MAX_UPLOAD_BYTES` 与既有上传白名单）。**实现**：`weibo.video` 单列 JSON `{url, poster, w, h}`（schema.sql + db.ts `SCHEMA_COLUMNS` 两处同步；解析/读侧过滤 `parseWeiboVideo` / `weiboVideoView`）；渲染 `render.ts weiboVideoHtml`（单行输出，媒体区顺序正文 → 视频 → 配图，竖屏居中限高，无封面帧时 ▶ 角标）；发布端三入口（前台发布器 / 前台卡片编辑 / 后台「微博」页）都有视频按钮、XHR 上传进度、类型/体积前置校验、在途守卫，并**自动抽第一帧当封面帧**（best-effort，失败退化成无封面卡）；PUT 的 `video` 键**缺键即保留**（后台列表上下架、老调用点不会静默清视频）；周边：媒体体检引用源加 `weibo.video`、分享卡用封面帧、广场/开放接口用封面帧当缩略图（视频文件不出站）、site.js `wbVideoHtmlJs` 与后台 app.js 各一份手工镜像（tests/weibo-admin.test.ts 逐字节守住）。机制见 AGENTS.md「微博视频」防线节，API 契约见 docs/API.md，用法见 GUIDE §5 |
| B20 | ✅ 站长 SEO 自定义：head 注入 + robots.txt 追加（2026-10-13 立项并落地） | WP 时代 Yoast 类插件最刚需的两件，合计一个下午的量。① 自定义 head 注入——站点验证 meta（Google / Bing / 百度 Search Console）+ 统计脚本（GA / Umami / 51la）。**拆两个专用键，不开裸 HTML 注入口**（管理员账号被盗时裸口是现成存储型 XSS）：`verifyMetas` 只收验证 meta / link 标签（解析成结构化值重放，name 白名单），`analyticsSrc` 单脚本 URL（后台 CSP 同步放行脚本域，settings 页改用打码回显口径视实现定）。② robots.txt 自定义追加段——现在硬编码（index.ts /robots.txt），追加段附在内置段后（内置 Allow/Disallow/Sitemap 顺序保持），演示站整站 Disallow 不受影响。**已落地（2026-10-13）**：settings 三键 `verifyMetas`（验证 meta 白名单）/ `analyticsScript`（脚本地址或 provider 片段，结构化属性重放；立项时拟名的 `analyticsSrc` 一并由它承载）/ `robotsExtra`（追加段）＋ src/seo.ts 解析重放 ＋ `buildCsp()` 按设置放宽 CSP（统计域与 `'inline-speculation-rules'`），后台「设置 → 站点 → SEO 与统计」；机制见 AGENTS.md「站长 SEO」节，用法 GUIDE §16 |
| B21 | IndexNow 即时推送（**2026-10-13 立项，插件形态归宿②**） | Bing / Yandex / Seznam 等共用的即时推送协议（Google 不参与——其 ping 接口 2023 已弃用，sitemap 是唯一通道，见不做清单）；归宿插件：src/hooks.ts `onPostPublished` 钩子里 POST `api.indexnow.org`（url + key 参数，key 是站长自生成随机串、无申请门槛），插件市场好选题；**key 文件托管需内核几行**（GET `/{key}.txt` 返回纯文本，读 settings 键，放 index.ts /robots.txt 旁），删除 / 转草稿时 optionalDeletes 端点顺手带上 |
| B22 | 旧 slug 301 重定向（**2026-10-13 立项**，Redirection 模式） | WP 生态装机量巨大的 Redirection 插件解决的问题：文章改 slug 后旧链接 404、搜索引擎权重断链（个人小站改 slug 频率低，但断链伤害不可逆）。两条实现路待拍板：① posts 表加 `old_slugs` JSON 列（schema.sql 与 SCHEMA_COLUMNS 两处同步；保存时 slug 变更把旧值追加、去重、排除当前值）② 独立 redirects 小表（额外支持手工规则，BACKUP_TABLES 要登记）；命中即 301 到新地址，配合 uniqueSlugIn「回收站行占用 slug」机制防冲突 |
| B23 | ✅ 分类描述 + 面包屑 JSON-LD（2026-10-13 立项并落地） | categories 表加 `description` 列（schema 两处同步老规矩）+ 后台分类编辑加输入框——WP 分类描述被 SEO 插件当 /category/:slug 归档页 meta description 用，现在归档页无专属文案；前台渲染进分类页页头（主题参数加字段，registry 类型动一处）；顺带补 BreadcrumbList JSON-LD（首页→分类→文章），render.ts page() 的 jsonLd 通道现成。**已落地（2026-10-13）**：`categories.description` 列（schema.sql + SCHEMA_COLUMNS 两处同步）＋ 后台分类编辑描述框 ＋ 分类页页头描述行与该页 meta description（缺省回退站点描述）＋ 文章页 / 分类页 `BreadcrumbList`（jsonLd 通道扩为支持数组，与 BlogPosting 并列输出） |
| B24 | ✅ Speculation Rules 链接预取（2026-10-13 立项并落地） | WP 6.8 官方内置的创意：render.ts page() 注入一段 `<script type="speculationrules">`（conservative 档起步，hover 触发同源文章链接 prefetch/prerender），Chrome 109+ / Safari 18.2+ 生效、老浏览器静默忽略零风险；Core Web Vitals LCP 加分，一行声明零维护。**已落地（2026-10-13）**：`render.ts page()` 注入 `<script type="speculationrules">`（prerender + conservative，排除 /admin、/api、/go、XML/JSON 订阅端点、新窗口与 nofollow），配套统计诚实性两处——预取请求不计阅读量（`isSpeculativeRequest`）、site.js 打点跳过 `document.prerendering` 并在激活后补报 |
| B25 | 广场 2.0：从「一条河」到逛得下去的广场（**2026-10-16 立项，站长提出**；完整方案与推进步骤见 **docs/PLAZA-2.0-PLAN.md**，本条目只留状态。**P0 地基 + P1 排版 + P2 轻互动已于 2026-10-16 当日落地**：feed?site= / RSS 站名回填 / 图片降级 / 新站聚光、双视图卡片墙+卡片三型+站点视图+侧栏活跃榜、匿名点赞+曝光点击回传+站长数据卡+utm_source；P3 留存 / P4 话题搜索 / P5 治理按里程碑触发） | 目标：让博主除了在自己站上写，也愿意偶尔到广场转转、能有效互动、带动互相回访。**三个循环**：看→逛（P1 排版升级：双视图卡片墙 + 站点视图 + 侧栏活跃榜）、逛→动（P2 轻互动：匿名点赞 + 曝光/点击回传 + 站长广场数据卡 + utm_source 回访观测）、动→回（P3 留存：本地关注 + 广场 RSS + 周刊精选）。配套 P0 地基（feed 站点过滤 / pull 路站点名回填 / 图片降级 / 新站聚光）先行，P4 话题与搜索（tags 进协议 + 话题页 + LIKE 搜索）、P5 信任治理（并轨 B18 认证 / 举报 / pull-only 下架自愈研究）随后。跨站评论互通（Webmention 式）**立项待研究不进排期**。红线不动：不建用户体系、不收正文/评论/访客身份、互动一律匿名聚合计数、不伪造数据、官网 ES5 无构建、hub 零依赖双形态。归宿：website/ + plaza/ + 站端插件，不动内核 src/。**首个可开工件：P0+P1**（1–2 天 + 1 周，纯前端见效最快） |
| B26 | ✅ 整站包：一键打包整站 + 一键还原（**2026-10-16 立项并落地**，提案 docs/PROPOSAL-B26-SITE-BUNDLE.md） | 「换服务器 / 换域名 / 重新部署」的搬家件——与 Markdown 包 / WXR（带走文章去别家系统）、备份（全表 JSON 只导出不导入）分工不混。**三条契约（站长拍板）**：① **只还原到「没有内容的站」**（posts/weibo/pages 三表**未删除**行数为 0——软删进回收站的不算；刚装好的新站先删掉自带的示例文章与「关于我」页面即可导入，否则 400 并报出挡路的内容；永不覆盖、永不合并）② **只装内容不装实例身份**（12 张业务表去掉 users，settings 排除密钥 + 实例态键）③ **版本不匹配一律拒绝不猜**（包里多出当前没有的表/列 = 降版拒绝并报差异；缺当前新增列 = 升版按默认值补）。实现：`src/sitebundle.ts`（流式导出：表按字节切片 + 图片逐张从 R2 流入；分步导入：一表一分片 / 一批 50 张图）+ `src/zip.ts` 读取器（Range 读 + DecompressionStream，内存有界）+ 后台「设置 → 整站搬家」；包落 R2 `bundles/`（不进公开白名单），三条来源归一（后台上传 ≤100MB / `wrangler r2 object put` / Docker 丢 uploads）。机制与防线见 AGENTS.md「整站包」节，用法见 GUIDE §19。**配套（2026-10-16 同日追加，站长拍板）**：`POST /api/admin/site/reset`「清空本站内容」——把任何站（新站 / 装满内容的老站）一键变回「没有内容的站」（清 `BUNDLE_CLEAR_TABLES` 11 张业务表，与 `start` 共用同一份常量；图片按整站包同一份收集口径一并清；保留设置 / 管理员账号 / 密钥 / 已上传的整站包），省掉「手动把内容一条条删进回收站」；**硬删不可撤销**，服务端硬校验确认语「清空本站」（后台弹窗要求原样输入），演示站 404 |

| B27 | ✅ AI 抓取策略（训练型拒绝 / 检索引用型放行）+ AI 抓取识别分档（**2026-10-17 立项并落地**） | 站长立场一句话：**只许 AI 检索引用，不许 AI 训练**——两者商业含义相反（训练=无偿拿走内容喂模型；检索=用户提问时实时读、回答里带来源链接替引流），必须能分开表态，而不是「要么全放要么全挡」。**① robots 声明**：settings 三档 `aiPolicy`（`allow` 默认 / `seek` 只许检索引用 / `deny` 全部拒绝），`src/seo.ts aiRobotsBlock` 按档位把 AI 爬虫名单写成独立 `User-agent` 组（检索档显式 `Allow: /`、训练档独立 `Disallow: /`、拒绝档合并），并把 `Content-signal: search=yes, ai-input=…, ai-train=no` 行插进既有 `User-agent: *` 组内（Cloudflare / contentsignals.org 口径，托管平台据此执行 AI 爬虫管控）；**默认档输出与历史 robots.txt 逐字节一致**，老站无此键行为不变。**② 名单单一事实源**：AI 爬虫令牌由 src/bots.ts `BOT_RULES` 的 `robots` 字段派生（`AI_TRAIN_AGENTS` / `AI_SEEK_AGENTS`），新增 AI 爬虫只加一条规则。**③ 识别分两档**：`BotKind` 拆出 `ai-seek`（检索引用）与原有 `ai`（训练），后台统计页分栏展示，`ClaudeBot` 拆三条（ClaudeBot/Claude-Web 训练、Claude-SearchBot/Claude-User 检索，此前三者挤一条、`Claude-User` 完全没被匹配）。**声明 ≠ 拦截**：robots 与 Content-Signal 都是君子协定，真拦截靠托管平台（Cloudflare AI Crawl Control），自托管只落声明层。机制与防线见 AGENTS.md「站长 SEO」节，用法 GUIDE §16，API 见 docs/API.md |
| B28 | ✅ AI 可获取面：llms.txt 导读 + Markdown 镜像 + max-snippet（**2026-10-17 立项并落地**） | 让 AI **低成本读到干净正文**——依据来自站长提供的 Cloudflare AI Crawl Control 实测数据（AI 爬虫周请求 7k、其中 4.7k 打在 404 上）。**① `/llms.txt` + `/llms-full.txt`**（llmstxt.org 约定，Cloudflare 阻止响应的内置放行路径）：H1 站名 + 描述 + 最新文章（100 篇）条目清单 / 最新 50 篇全文，机制在 `src/llms.ts` 纯函数组 + index.ts 两条路由，进 pagecache 数据白名单；**② `/post/:slug.md` Markdown 镜像**：库存是净化 HTML，镜像 = sanitizeHtml → htmlToMd 转换（src/html-md.ts，与导出 Markdown 包同款转换器；自建实现，对冲 Cloudflare「面向代理的 Markdown」的 Pro 付费能力），分流在 renderPost 顶部（cleanSlug 不含点号无歧义），恒为游客视角、自动吃页面边缘缓存，文章页 head 带 `<link rel=alternate type=text/markdown>` 声明；**③ `max-snippet:-1, max-image-preview:large, max-video-preview:-1`** meta（非 noindex 页），放开 AI 摘要引用长度限制。**防泄漏与 RSS 同一份口径**：会员锁文索引照常出条目、全文只出摘要+引导（服务端截断是安全边界）；访问密码文索引出作者摘要（同 RSS description），但 `.md` 与全文正文整体退出（404 不透露存在性，同关键词搜索口径）；回收站 / 站点可见窗口外不出现；演示站 / siteNoindex / AI 策略 deny 档出桩（与 robots 整站 Disallow 同口径）。机制与防线见 AGENTS.md「站长 SEO」节，用法 GUIDE §16 |

### C 区 · 加分项（可有可无）

| # | 事项 | 说明 |
| --- | --- | --- |
| C1 | 博客圈文化件 | 随机友链跳转（/random 旁加一个）、页脚运行天数 / 本站信息卡、开往 / 十年之约入口 |
| C2 | 🔶 部分完成（2026-10-07） | **QQ 评论头像**已全量落地（会员中心绑定 + 游客评论选填 qq、评论四处展示 + /rank 榜单、隐私红线与同号头像复用，见 AGENTS.md 会员防线）；剩：表情回应（emoji reactions，微信表情文本码已进站可复用）、WP 评论导入 |
| C3 | 创作增强（2026-10-13 补调研） | 代码块语法高亮、KaTeX 公式、mermaid 图表（按需加载，注意 CSP 与体积）、文章 TOC 目录——目前均不存在，按需再上；高亮倾向**手写小型 tokenizer**（exif.ts / qrcode.ts 零依赖先例）或编辑器 / 渲染插件形态，不引 highlight.js 全家桶 |
| C4 | 🔶 主体完成（2026-10-07） | 图片增强三件套之**hash 去重**（uploads 表 SHA-256 指纹）与 **EXIF / GPS 隐私抹除**（src/exif.ts 落库前统一剥离）已落地；**可选水印**未做待定：Workers 无服务端图像解码，客户端做需三端 canvas 叠字与样式 / 范围决策 |
| C5 | ✅ 单篇访问密码（2026-10-07 完成） | 编辑器按篇加密（PBKDF2），输对后 30 天免重复输入；与会员付费墙可叠加（密码墙优先），机制见 src/protect.ts |
| C6 | 文章版本历史 | 编辑覆盖即丢，保存时留最近 N 版即可 |
| C7 | Turnstile 人机验证 | 现有蜜罐 + 限流 + 先审后展够用，垃圾评论变多再上 |
| C8 | HTML 边缘缓存 | Cache API + 发布即 purge；SSR 已够快，收益 / 风险比一般 |
| C9 | AVIF / 多尺寸缩略图 | 依赖 CF Images 付费能力 |
| C10 | PWA / 离线阅读 | manifest + 轻量 service worker |
| C11 | 阅读偏好 | 字号调节、手动夜间开关（当前仅跟随系统）、记忆 |
| C12 | ✅ JSON Feed（2026-10 完成） | `/feed.json`（JSON Feed 1.1，机器可读格式），buildJsonFeed 与 RSS 同一份防泄漏口径（密码文不出正文、锁文只出试读段、rssFullText 开关同效），机制在 src/rss.ts |
| C13 | 新站演示内容包 | 示例文章 + 微博 + 友链一键填充（部署者自己的新站，与官方演示站两码事） |
| C14 | 每篇文章浏览 / 来源轻统计页 | 参考 Bear Blog |
| C16 | 零碎打磨 | 404 自定义、无障碍（a11y）、CLI 发布、评论敏感词合规包（默认关闭，面向有需要的部署者） |
| C17 | 内容揭示卡（点开可见 / 会员分层可见，**立项待研究，2026-10-09 站长提出**） | 正文里的一段文字 / 一张图 / 一大块内容按两种条件揭示：① 点击展开（剧透折叠，默认遮住），② 不同会员档位可见（与现有付费墙 min_tier 机制的关系要先理清——付费墙是整篇级，这是块级，安全边界必须同样做到服务端截断，渲染层遮挡不算数）。形态候选：块级容器标记（类似 `<meta data-og-image>` 的 data-* 白名单路子）或编辑器插件。**先研究再动手**，见本条不动代码 |
| C18 | 图片灯箱 lightbox（**2026-10-13 立项，客户端归宿①**） | WP 图片查看类插件的广泛形态：文章 .rich 图片与微博九宫格点击放大浏览（左右切换 / ESC 关闭）。site.js ES5 手写百行内（零依赖预算），注意与微博九宫格 / 文章 .rich 现有点击行为的衔接、ES5 与禁 lookbehind 老规矩 |

## 不做清单（拍板记录，编号不回收）

- **邮件相关（原 B1 邮件服务、原 C15 邮件订阅），2026-10-07 拍板不做**：第三方发信服务对接与发信域名 DNS（SPF/DKIM/DMARC）配置门槛高，免费档额度受限且说砍就砍（MailChannels 砍 Workers 免费集成是先例）；下游的评论邮件通知、邮箱找回密码、注册验证、newsletter 一并冻结——会员密码找回已按「本站不提供密码找回」口径落地（render.ts 两处固定提醒，不再视作欠账）。当年调研结论已随之作废，若未来重启，从 git 历史本日期之前的本文件找回（Resend / 阿里云邮件推送免费档、provider 可切换抽象等）。
- **SEO 不做项（AMP / hreflang / Google ping），2026-10-13 拍板**：AMP 已边缘化（Google 搜索结果不再要求 AMP、官方组件停止发展，不值得引）；hreflang 与英文版形态不匹配（edition=en 是单语回退模式而非并行多语站，无 alternate 页面可标）；Google ping 已被官方弃用（2023-06，sitemap.xml 是唯一通道），搜索引擎侧的补位是 IndexNow（B21，覆盖 Bing / Yandex 系）。另：WP 生态的「评论回复邮件订阅」（Subscribe to Comments）同属邮件下游，被本条邮件冻结口径覆盖，不另立条目。
- **AI 代理生态接入不做项（API Catalog / Auth.md / OAuth Discovery / OAuth Protected Resource / A2A Agent Card / Skills Index / MCP Server Card / Web Bot Auth / WebMCP / DNS-AID / ACP / AP2 / MPP / UCP / x402），2026-10-17 拍板**：Cloudflare 后台「AI 优化 → 诊断（Beta）」的级别 2「技术基础」、级别 3「高级集成」与「商务」区列出的这批协议，面向的是**电商 / SaaS / AI 平台**——让 AI 代理发现你的产品目录、走 OAuth 登录、下单支付、调用你的 API 产品。博客号没有商品也没有 API 产品，逐项接入纯属自加维护负担（每项都要求公开服务目录 / 授权流程 / 结算协议，且协议本身多在草案期）。**别把同页的 Content Signals 混进来**：它解决的是「AI 看不见你的 robots 策略」，已由 B27 落地（内核在 robots.txt 输出 `Content-signal` 行），属于另一回事。
- **Markdown Negotiation（「面向代理的 Markdown」，Cloudflare Pro 套餐能力）不做，2026-10-17**：按 `Accept: text/markdown` 返回 Markdown 版本。全站 RSS 已输出全文（`rssFullText`），AI 取全文的路已经通；且该能力在托管侧压 Pro 套餐。若未来要做，归宿是服务端插件 / 客户端方案，不进内核。**协商本身仍不做**：B28 已用 `/post/:slug.md` 静态镜像达到同一目的（镜像=库存净化 HTML 经 htmlToMd 转换、不依赖 `Accept` 协商、不吃 Pro 套餐），再做内容协商属重复建设。
- **`llms.txt`（原判不做，2026-10-17 同日改判）**：原判据是「不提升 AI 引用率（2026 年多项实测结论），价值仅在于给 coding agent 当站点索引」；同日 B28 立项落地——站长要求「让 AI 低成本、无损地读到内容」，且托管平台的 AI 爬虫管控把 `llms.txt` 当内置放行路径。内核现有 `/llms.txt` + `/llms-full.txt`（`src/llms.ts`，防泄漏口径与 RSS 同一份），原判据留此备查。官网 `website/public/llms.txt` 仍属官网工程范围。
