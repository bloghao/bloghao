# xwblog（基于博客号 BlogHao 二次开发）—— 开发约定

完全跑在 Cloudflare（Workers + D1 + R2）上的轻写作博客系统。后端 30 余个 TS 文件（hono，不含主题），后台为原生 JS SPA，**无构建链**：改完即生效。

## 复杂度预算（产品定位本身，动内核前先读）

「无构建链、后端一个新人一个下午能通读」不是技术债，是**产品定位**——轻到换博客的人敢于自己读源码、自己改。文件数缓慢变多没关系，这个体感不能破；新功能按下面的归宿排序考虑，别默认往内核里塞：

- **归宿三档，按序考虑**：① 客户端能解决的（前台 site.js / 后台原生 JS，无构建链的红利就在这）→ ② 插件形态（服务端走 src/hooks.ts 钩子总线、编辑器插件见 docs/PLUGINS.md）→ ③ 确需进内核才新增文件。一个功能若要把内核撑出成片的新文件 / 新表 / 新抽象层，先停下来设计插件形态；插件做不了（要深度贴着 SQL 与鉴权上下文）才进内核
- **进内核的正确姿势是「一个自洽小文件」**，不是散进大文件——先例：protect.ts / trash.ts / fts.ts / closed.ts / exif.ts 全是同一套三件套：单文件模块 + 可被 Node 测试直接导入（不依赖 Workers 运行时）+ AGENTS.md 挂一条防线。新增 src/ 文件必须在文末「结构速查」登记一行；新增表 / schema 列 / settings 键同理要有明确理由
- **依赖预算**：运行时依赖只有 hono 一个（见 package.json）。新需求先想 Web 标准 / fetch API 能不能手写——exif.ts、zip.ts、qrcode.ts 都是零依赖手写的先例（qrcode 按 ISO 18004 自实现，jsqr 只是测试里的解码回读器）；不为省事引入 npm 包
- **无构建链同样是预算**：前台 site.js 保持 ES5、后台原生 JS，禁止为开发便利引入打包步骤——「改完即生效」是部署体验的一部分

## 线上站点（文档里以此为准）

- 正式地址：**https://blog.xiaowuleyi.com**（已绑定到本仓库的 Worker），后台 `/admin/`
- 官网：**https://bloghao.com**（Cloudflare Pages 项目 `bloghao`，源码在仓库 `website/`——纯静态无构建，与博客系统运行无关；Pages 默认域 bloghao.pages.dev）
- 演示站：**https://demo.bloghao.com**（Worker `xwblog-demo`，wrangler.demo.jsonc 部署并通过 routes 绑定该域名，DEMO_MODE 门控，机制见 docs/DEMO.md；官网导航 / Hero / 快速开始 / 页脚的演示入口都指向这里）
- Cloudflare 资源：Worker `xwblog`、D1 `xwblog-db`、R2 `xwblog-images`（binding 均见 wrangler.jsonc）
- 使用手册 docs/GUIDE.md、部署教程 docs/DEPLOY.md——涉及访问地址、备份命令时写上面的正式域名与资源名

## 常用命令

```bash
npm run dev            # 本地开发（端口被占用时自动 +1）
npm run dev:demo       # 演示站本地预览（自动建表+播种，见 docs/DEMO.md）
npm run typecheck      # TypeScript 类型检查，提交前必须通过
npm test               # 回归测试（tests/，300+ 用例），提交前必须通过；CI（.github/workflows/ci.yml）每次推送强制执行
npm run smoke          # 本地冒烟：起 wrangler dev 逐路由断言 200（含多标签文章页回归守卫），改 SQL 拼接/渲染后必跑
npm run db:init:local  # 初始化本地 D1（.wrangler/state，幂等）
```

## 回归防线（改代码前先读，防已修好的 bug 复发）

2026-10 做过一轮全量安全/健壮性审查并修复了三类共 40+ 问题；`tests/` 里的用例与下面每条规矩一一对应。**改动相关代码时先跑 `npm test`，新增同类功能必须沿用同一模式**：

**XSS / 净化（tests/sanitize.test.ts、tests/markdown.test.ts）**

- URL 白名单校验（sanitize.ts `safeUrl`、markdown.ts `safeUrlMd`）必须**先剥离 `\t\r\n`** 再做前缀判断——URL 解析器会忽略这些字符，`jav\tascript:` 这类混淆靠原始字符串拦不住；放行出的属性值必须再经 `escAttr`（实体二次转义也是防线）
- 净化器**不放行 `id` 属性**（DOM clobbering 会打瘫评论区）；`<meta data-og-image>` 是唯一例外，改 OG 卡图功能时同步 tests/sanitize.test.ts 与 docs/API.md 白名单摘要
- markdown.ts 的 `inline()` 收到的文本已经 `escLine` 转义过，属性上下文只能用 `escQuote` 补引号，**严禁再过 `escAttr`**（会把 `&` 打成 `&amp;amp;`，含参数的链接/图片 URL 全坏）
- 图片转存（collect.ts）**只认文件魔数**（`sniffImageExt`），不信任源站 Content-Type / URL 参数；`/images/` 路由必须保留 `X-Content-Type-Options: nosniff`
- sanitizeHtml 的**透传段统一过 `escapeStrayLt`**：未终结的标签前缀（`<img src=x onerror=…` 无 `>`）与未闭合 `<!--` 曾原样透传，浏览器会把后续页面标记当 img 属性（内联事件复活）或把整页吞进注释——改净化器别拆这个防护
- RSS/WXR 等 XML 输出的 `xmlEsc`/`cdata`/`rfc822` **统一来自 `src/xml.ts`**（rss.ts / sitemap / export.ts 同源），入口**统一剥控制字符**（XML 1.0 禁 U+0000-0008/000B/000C/000E-001F，CDATA 内同样非法）：一条脏数据曾能打挂整份 feed；`<loc>` 对 siteUrl 过 xmlEsc，slug 进 URL 统一 `encodeURIComponent`——别在文件里再写本地副本
- 上传常量与落库**统一走 `src/store.ts`**（`MAX_UPLOAD_BYTES`/`IMAGE_MIMES`/`imageExtOf`/`saveUpload`，api 上传、collect 采集转存、external 外部发布共用）；mime 白名单查表**必须走 `imageExtOf`**（内部 `hasOwnProperty`，`IMAGE_MIMES['constructor']` 是继承属性可穿透校验）——改体积/类型口径只改 store.ts 一处。落库前 **EXIF/GPS 元数据剥离**（`src/exif.ts`，saveUpload 内一处生效，新增上传链路自动获得保护）：纯字节手术，**解析异常一律原样返回**（剥离绝不阻塞上传），**JPEG orientation≠1 整体跳过**（剥了浏览器显示会颠倒）；哈希与登记 size 取剥离后字节，媒体查重口径才一致
- 公开留言三路（文章 /api/public/comments、留言板 /api/public/guestbook、微博评论）共用 api.ts 的 **`publicComment` 公共核心**（限流、蜜罐、作者回复、先审后展、TG 通知与插件广播全在里面）；新增留言形态只写细路由 + opts（文案称呼/归属列/是否收 email/website/通知上下文），别再抄整段流程
- `:id` 路由参数一律 `api.ts parseId()`（非法 404），别 `Number()` 后直传 D1——NaN bind 是 500
- PUT /admin/posts/:id 是**缺键即保留**语义（readPostPayload 的 `has` 标志）：列表页状态切换只发 `{status}`，新增部分更新字段要同步 has 列表与 PUT 赋值——冒烟「文章状态切换保留正文」守着，别改回全量覆盖

**时间口径（tests/utils.test.ts）**

- SSR 端一切日期显示统一北京时间：用 `utils.ts` 的 `cstDate/fmtDate/fmtDateCN/fmtDateTime`（+8h 后取 UTC 分量），**禁止** `new Date(ts).getHours()` 这类依赖 Worker 时区（UTC）的写法——0-8 点发布的内容会显示成前一天；SQL 里按天/年聚合用 `strftime(..., ts/1000 + 28800, 'unixepoch')`；客户端 site.js 同口径（+8h + getUTC*）。中文标题的自动 slug 日期段同理走 `utils.ts` 的 `dateSlug`（cstDate 取墙上日期 + 4 位随机位），改 slug 生成别绕过它回随机串
- 机器可读日期（JSON-LD 等结构化数据）用 `utils.ts` 的 `isoDate`（产出 `2026-10-05T08:30:00+08:00`，同北京时间口径），**禁止**裸 `toISOString()`（产出 UTC，0-8 点发布的 datePublished 会错位到前一天）；JSON-LD 序列化进 page() 前自动把 `<` 转 `\u003c` 防 `</script>` 逃逸，别在别处手拼 `<script type="application/ld+json">`

**SQL / 输入（tests/utils.test.ts）**

- `LIKE` 模式里凡是 `\` 转义了 `%`/`_`，SQL 必须声明 `ESCAPE '\'`，且 `\` 本身要先转义成 `\\`（搜索用 `utils.ts likePattern`，JSON 数组列用 `jsonItemLikePattern`，两函数同口径）
- 正文长度上限按 **UTF-8 字节**（`new TextEncoder().encode(...)`），不是字符数
- 自定义 slug 落库前过 `cleanSlug`；主题等枚举值校验用 `Object.prototype.hasOwnProperty.call(THEMES, v)`（防原型链属性穿透）

**全文搜索 FTS5（tests/fts.test.ts、冒烟 /search FTS 命中断言，机制在 src/fts.ts，2026-10-07）**

- FTS5 MATCH 表达式**唯一构造入口是 `fts.ts ftsMatchExpr`**：用户输入按空白切词、逐词双引号包裹（内部 `"` 翻倍），FTS5 查询语法（AND/OR/NOT/NEAR/列过滤）到不了引擎；任一分词短于 3 个码点整体返回 null → 调用方退回 `listPosts` 的 LIKE 老路（trigram 成不了窗，2 字中文词是最常见查询），两条路结果口径必须一致
- FTS 命中必须回连原表带全业务过滤：`deleted_at IS NULL` + `status='published'` + `password_hash` 为空（加密文整体退出关键词搜索——命中本身会泄露「正文含此词」，与 listPosts q 分支同口径）；新增公开搜索面照此过防泄漏清单
- 索引增量同步触发器**只在 db.ts 的 `SCHEMA_TRIGGERS`**（ensureSchema 挂，所有部署形态冷启动必经）——schema.sql 只放 FTS 虚表（无分号体），因为 demo.ts ensureTables 按分号朴素切分 SQL、切不开 `BEGIN...END`（tests/fts.test.ts 守着「schema.sql 不含 CREATE TRIGGER」）；UPDATE 触发器带 `OF title, summary, content` 列清单，views/likes 高频自增不得触发索引重建，**新加索引列时只准扩这个 OF 清单**，别改成全表 UPDATE 触发
- 虚表是可重建的派生索引：**不进 BACKUP_TABLES**（备份恢复后靠 ensureSchema 的 settings 记账位 `ftsSeeded` 自动 rebuild 一次，demo 清库重灌同理自动补）；DELETE posts/weibo 后 `meta.changes` 会把触发器内的 FTS 删除命令计入（D1 实测单行删除 = 2）——**判「确有删除」用 `< 1` 口径别用 `!== 1`**（api.ts 单条彻底删除守着），恢复 / 置顶等 UPDATE 依赖 `OF` 清单不被触发、changes 仍为 1 不受影响

**回收站 / 软删除（tests/trash.test.ts、冒烟「回收站链路」，机制在 src/trash.ts）**

- posts / weibo / pages 三表统一软删：`deleted_at` 毫秒时间戳，NULL = 存活；**任何新增的涉及三表的业务查询必须带 `deleted_at IS NULL`**（后台概览统计、likeDelta、置顶名额、scheduler 定时发布、/random、export 全部有过滤），改完跑 `grep -n "FROM posts\|FROM weibo\|FROM pages" src/` 逐个核对——漏一处就是把回收站内容泄漏到那个公开面；已知的**故意不过滤**例外：backup.ts（全表备份兜底）、trash 自身查询（listTrash/purgeTrash 只认 deleted_at IS NOT NULL）、db.ts 的 getPostById/getPageById（后台按 id 直取与恢复）、uniqueSlugIn（回收站行继续占用 slug，恢复后链接照旧）、api.ts 标签清理扫描（恢复时标签完整）
- `DELETE /api/admin/posts|weibo|pages/:id` 是**软删进回收站**（保留 30 天），不要改回硬删、不要在这里加级联——评论/分类关联只在「彻底删除」时清掉；彻底删除只走 `/admin/trash/*`，且 SQL 必须带 `AND deleted_at IS NOT NULL`（防误删存活行）。**级联语句（comments / post_categories）同样要带守卫**：用 `xx_id IN (SELECT id FROM <表> WHERE deleted_at IS NOT NULL)` 子查询、且排在主行 DELETE **之前**（主行先删子查询就看不到它了）——历史上级联裸删曾把存活文章的评论删光后回 404，冒烟「回收站：误删守卫」守着
- 恢复文章时过期定时文自动转草稿并**清掉 publish_at**（`trash.ts restorePostStatus` + api.ts 恢复端点，防「恢复即撞发」，也防草稿被切回 scheduled 时按旧定时点撞发，冒烟守着）；purgeTrash 挂在 index.ts scheduled() 的 00:30 备份 cron 分支（与 purgeVisits 并排），保留期常量 `TRASH_RETENTION_DAYS = 30`
- 后台「回收站」页（viewTrash）已登记 MENU 与 navigate；不进 `MOBILE_TAB_IDS`（自动落移动端「更多」抽屉）；前台 site.js 的微博删除确认文案是「移入回收站」口径，与删除端点的软删语义必须一致

**会员体系（tests/members.test.ts、tests/member-schema.test.ts，拍板口径与契约速查见 docs/DEVPLAN-2026-10-07.md）**

- 会员数据只在 members / member_sessions / member_points_log 三表：**严禁写 users / sessions**（users 只承载管理员，`/api/auth/setup` 靠 `countUsers() === 0` 判断首装）；会员会话 Cookie 独立（`xw_member_session`），勿与管理员 `bloghao_session` 混用
- 积分数值与单日上限**只改 `src/points.ts` 常量表一处**（2026-10-07 拍板：评论 +2 每日上限 10 条、每日登录 +1）；记分必须走 `awardPoints`（自带北京时间日上限与 hasOwnProperty reason 校验），评论积分**过审才计**且同一评论只计一次（`awardCommentPoints` 按 ref_id 去重——即时通过在发言当下、先审后展挂到后台「通过」动作，两路共用防重复）。幂等有**数据库强制**：`member_points_log(member_id, reason, ref_id)` 部分唯一索引（`WHERE ref_id > 0`；评论 ref_id=评论 id、每日登录 ref_id=北京日序号，schema.sql 与 SCHEMA_INDEXES 两处同步），并发重复记账由索引拦下、awardPoints 捕获 UNIQUE 静默返回未记——别改回纯应用层去重，别给 adminAdjust（ref_id=0，不进索引）传非 0 refId
- `/api/member/*` 受 settings `membersEnabled` 门控（关 = 404）；封禁（status='banned'）后 `getMemberUser` 查询层即视为未登录，后台拉黑时同时清空该会员全部会话；`rankTopN` 由 `clampInt(1,50)` 兜底
- 会员个人资料（/member 会员卡，改昵称 + 改密码）：昵称清洗与 30 天窗口判定是 `utils.ts` 纯函数（`cleanNickname`/`nicknameCooldown`），SSR 提示文案、API 校验、测试三处共用同一口径别拆；改昵称落库必须走 `db.ts updateMemberNickname`（窗口判定下沉 SQL 条件更新 `display_name_changed_at IS NULL OR <= now-30d` 防并发双开，别改回应用层 check-then-update；注册填昵称不占用首改窗口）；改密码成功后 `auth.ts destroyOtherMemberSessions` 踢其他设备**保留当前会话**（别改成全踢——改密码的人自己不能被登出去）；「本站不提供密码找回」提醒固定在 render.ts 两处表单旁（memberAuthHtml 注册 / memberCardHtml 改密卡），别删；冒烟「会员资料链路」守着
- **后台会员接口必须注册在 `api.use('/admin/*')` 鉴权中间件之后**（hono 按注册顺序执行，路由先命中即终止链条——members 两端点曾注册在前导致未登录可整表读、改档位，出参还带 password_hash/salt）；`listMembersAdmin` 用显式列名（MemberAdminRow），任何新增的会员出参都不准带口令字段；冒烟「会员管理：未登录 401」守着
- 评论三路会员发言走 publicComment 公共核心的 member 分支：身份来自会话，**表单昵称/邮箱/网站字段一律忽略**；会员暂不可回复楼中楼（与游客同口径，放开属契约变更）；评论列表（SSR 文章/留言板 + 微博 JSON）经 LEFT JOIN members 带出 `member_name`/`member_tier`/`member_avatar` 徽标数据；SSR 四处评论表单的 `memberName`（「以会员 xxx 的身份发言」免填昵称）由 pages.ts 统一传（renderPost / renderGuestbook / renderWeibo / 首页 weiboFeed，管理员优先会员次之），会员查询一律 `membersEnabled ? getMemberUser(...) : null` 门控——新增带评论表单的页面要照此接线，别让会员看到游客昵称框
- 评论头像（C2）：`members.qq` 是头像抓取记账位，**qq 号本体任何公开出参不携带**（评论/榜单/会员公开视图一律不出，仅 /api/member/me 本人视角），头像一律走 qlogo 抓取 + saveUpload 站内转存后同源输出（直接拼 qlogo 外链会暴露用户 QQ 号，不取）；绑定入口 `POST /api/member/profile` 带 qq 键（`utils.ts isValidQQ` 校验，site.js 会员卡有 ES5 正则镜像），**抓取失败容忍只存 qq**（db 层 avatar COALESCE 不清已有头像，重发同一请求即重试补抓）；评论头像位优先级：会员 `member_avatar` → 作者评论（`is_admin=1`）用站点头像 `settings.avatarUrl`（SSR 走 commentsHtml 的 adminAvatar 选项，微博评论走接口出参 `adminAvatar`，与微博卡头像同源）→ 游客自填 QQ 的行内 `comments.avatar` → 昵称首字块（`render.ts commentAvatarHtml`，site.js 微博评论渲染是 ES5 手工镜像，两侧同改，themes.test 有切片镜像守卫）。**游客侧（2026-10-07 拍板）**：评论三路 body 可带选填 qq，落 `comments.qq`（内部列）+ `comments.avatar`（站内地址）——**格式不对按没填处理**（不拦评论）；提交时先查同号历史头像复用（`WHERE qq = ? AND avatar != ''`），抓取次数 = 唯一 QQ 数；前端 qq 记忆存 localStorage（storeGet/storeSet 口径），正则与 utils.ts isValidQQ 同款镜像
- 付费墙的**安全边界是服务端截断**（`utils.ts teaserHtml`，200 可见字符预算、闭合未关标签）：locked 文章浏览器拿到的就是残文，改渲染层永远补不回安全。可见判定统一 `points.ts canRead/normalizeMinTier`（脏 min_tier 归 all，宁漏勿锁死）；**新公开面（新增导出/接口/主题字段）必须过防泄漏清单**——已过滤：RSS content:encoded（locked 只出试读段+引导）、/api/public/posts（只出 summary）、搜索/卡片摘要（≤120 字摘要口径）；搜索 LIKE 可命中标题属既定取舍（契约 A2 会签记录）
- schema 三张会员表已登记备份（members / member_points_log 进，member_sessions 与 sessions 同理属临时凭证不进）；排行查询只出 active 且积分 > 0；契约变更纪律见 DEVPLAN——registry 类型 / 端点出参 / settings 键 / schema 列的形状变更先改文档再动代码

**文章访问密码（tests/protect.test.ts、冒烟「文章访问密码链路」，机制在 src/protect.ts，C 序列）**

- `posts.password_hash` 单列存 `salt:hash`（PBKDF2 复用 auth.ts，与登录口令同强度），空 = 未加密；schema.sql 与 db.ts SCHEMA_COLUMNS 两处同步的老规矩照旧
- **password_hash 不出任何后台响应**：后台四个文章出参（列表 / 详情 / 新建 / 更新）统一过 api.ts `postAdminView` 剥哈希、只给 `hasPassword` 布尔；PUT 的 `password` 字段是**缺键即保留**语义（空串 = 解除、非空 = 设置/更换、缺键 = 不动）——编辑器自动保存只在「有话可说」时才带 password 键，别改成全量覆盖
- 解锁 Cookie `bloghao_pp` 的签名 key 就是该文**当前的 password_hash**：无需站点级密钥，改密即全端失效；令牌 `postId.exp.hmac`（HMAC-SHA256），校验必须对当前 password_hash 重算比对（safeEqual），有效期 PP_TTL_MS = 30 天
- **与会员付费墙的组合语义（与 A 序列对齐的契约）**：密码墙优先——未解锁时直接止步于表单，不进 canRead 档位判定；解锁后再按 min_tier 走付费墙；**评论区对密码文照常开放**（与会员锁文同口径）。主题出参里 `locked` 恒指会员付费墙（paywallHtml 由它驱动），密码墙不走 paywallHtml 遮挡卡，避免双墙
- **防泄漏清单**（新增公开面必须过一遍）：文章页密码锁定时正文 / 自动摘要（`excerpt(row.content)`）/ JSON-LD 描述 / OG 从正文提取卡图，全部不出——meta 描述走 `protectedDescription`（作者自填摘要优先，否则固定话术）；RSS 不出该文 `content:encoded`（比会员锁文的试读段更严）；关键词搜索整体不命中加密文章（content LIKE 命中本身即泄露，listPosts 的 q 分支有过滤）；`/random` 不进加密文章；标题、作者自填摘要、封面、标签照常公开（作者主动公开的导读面）
- 解锁端点是**表单 POST `/post/:slug/unlock`（index.ts，303 回跳，无 JS 依赖）**：必须保留同源 Origin 校验、按「IP+文章」限流（PBKDF2 是慢操作，防爆破 10 次/10 分钟）、目标不存在/未加密静默 303 回跳不透露存在性；错误态走 `?pwerr=1` / `?pwerr=slow` 回显在表单里。表单与样式都在 protect.ts（`passwordFormHtml` / `PP_CSS` 随主题 CSS 注入 head），不要往 themes 七主题里各抄一份
- 备份/导出含 password_hash 属预期（备份要可还原，导出是管理员工具）

**出网安全（tests/fetchsafe.test.ts，机制在 src/fetchsafe.ts）**

- 服务端抓「用户/第三方提供的 URL」一律走 `fetchsafe.ts` 的 `fetchPublicResource`（fetchableUrl 起点校验 + redirect:'manual' 逐跳复查 + 流式 readBodyLimited 限长）——已接线：linkmeta 抓页面、store 转存远程图、collect 采抓正文。新增出网点禁止裸 fetch：公网 URL 302 到 169.254.169.254 是经典绕过，重定向必须逐跳复查
- `isPrivateHost` 覆盖点分 IPv4 之外的表示法：整数（http://2130706433/）、0x 十六进制、0 前缀八进制、IPv6 字面量（::1 / IPv4-mapped / NAT64 / ULA / link-local）；解析不动的可疑形态一律按私有拒绝（宁拒勿漏），但真域名不能误杀（cafe.example.com 全是 hex 字母，判定只认「每段都是数字」的形态）。已知局限：DNS rebinding 防不了——Workers 平台私网不可达不构成攻击面，自托管见 docker-poc README
- Node（undici，docker-poc）下 manual 重定向返回 opaqueredirect（拿不到目标），`fetchPublicResource` 直接放弃该次抓取——自托管形态带重定向的转存源会失败，属预期取舍；Workers 下返回真实 3xx 正常跟跳
- 手动上传（/admin/upload、/admin/og-image）只认文件魔数（`store.ts sniffUploadExt`，在 sniffImageExt 基础上补 ico/mp4/webm），与转存链路「魔数优先」同口径；mime 声明与魔数不符时按魔数落库真实 mime

**会话 token（src/auth.ts）**

- sessions / member_sessions 落库的是 **SHA-256(token)**（`tokenHash`），Cookie 里才是原文：库泄露 ≠ 会话可重放。会话相关查询/删除一律先过 tokenHash，别拿 Cookie 里的明文 token 直查直删（2026-10 切换，上线时全部旧登录态失效一次属预期）

**外链中间页（tests/outlink.test.ts、冒烟「外链中间页」，机制在 src/outlink.ts）**

- 第三方链接一律走 `outHref` 判定：白名单（`TRUSTED_OUT_DOMAINS`，主域名 + 子域跟随）与本站同源直出，其余包成 `/go?u=<encodeURIComponent>` 确认页（免责声明、noindex、无 JS 不自动跳转——`/go` 路由只对白名单/同源 302 直跳，非白名单**永不**服务端跳转，不构成开放重定向；目标必须 http(s) 且 ≤2048 字符，非法一律回首页）。新增「想给外链加中间页」的公开面只准调 `outHref` / `wrapAnchorHref`，别手搓白名单判断
- **包装只发生在渲染层**：文章/页面/关于我走 `sanitizeHtml(html, { origin })`（不传 origin 的存库/RSS/导出路径保持原始 URL，`/go?u=` 是相对地址所以重复净化天然幂等），微博文本走 render.ts `weiboTextHtml`；weiboTextHtml 用 URL 与 #话题# **单次扫描**的分词正则（先转链接再扫话题会把 href 的 #fragment 误判成话题），URL 字符集排除 CJK 与全角标点（`https://x.com的官网` 链接停在汉字前）
- **site.js 的 `wbTextHtml` / `TRUSTED_OUT` / `outHrefJs` / `trimUrlTailJs` 是服务端的手工镜像**（白名单表、分词正则、尾标点修剪四处同步），改任一侧必须两边同改并跑 tests/outlink.test.ts（其中的镜像守卫用例把 site.js 源码切片执行、与服务端同输入比对输出）；**改正则先数捕获组**——wbTextHtml 分支曾用错捕获组序号（m[4] 当 URL），前台编辑微博保存后假报错，tests 拦不住客户端代码直到镜像守卫补上；客户端仍守 ES5 与禁 lookbehind 老规矩
- 白名单前四项是站长自有域名（bloghao.com / xiaowuleyi.com / habfut.com / btchao.com），官方版挑洗时按 RELEASING 个人定制台账处理；友链页是站长逐条审核的收录结果，属「把握的域名」，不走中间页

**后台交互（public/admin/，无自动化测试，靠约定）**

- 后台所有请求走 `api()`：401 会话过期已统一拦截回登录页（勿在别处重复处理，也别动 `state.user` 的判断顺序——登录表单的密码错误提示依赖它）；每个写操作按钮必须 try/catch + toast，请求期间 disabled 防连击
- 设置页「保存全部」的 body **不带 theme 键**（主题只在皮肤页管理；服务端 PUT 对 body 里存在的 key 一律写入——历史上带了就曾把皮肤静默重置成 wechat）；分类/媒体页等操作后的列表刷新统一 `navigate()`，别直调 `viewX()` 绕过防串页守卫
- 后台 SPA 经 wrangler assets 直出不经过 Worker，CSP 靠 admin/index.html 的 **meta 兜底**（前台在 pages.ts baseHeaders）：后台模板/弹窗里**禁止新增内联事件属性（onclick 等）与内联 `<script>`**，交互一律 addEventListener
- 操作回调里刷新列表统一 `navigate()`（自带 pendingRoute/navSeq 防串页守卫），别直接 `viewX()`——慢响应会把用户从新页面拽回旧页面
- editor.js 的 `plugins` 数组是模块级：`mountEditor` 开头清空 + `renderPluginButtons` 按停用名单过滤（ES module import 有缓存，只靠「不 import」卸不掉已加载插件）；路由离开编辑器调 `disposeEditor()` 摘除全局监听与挂起定时器
- settings 的三个密钥（externalToken/telegramBotToken/telegramWebhookSecret）**GET 与 PUT 响应都打码**，明文只在生成时返回一次；新增敏感键记得进 `SECRET_SETTINGS`
- 侧边栏菜单由 app.js 顶部 `MENU` 配置数组渲染（分组标签 + 待审徽标），桌面侧栏、移动端底部栏与「更多」抽屉共用同一份数据——**新增后台页面要同时登记 `MENU`、`navigate()` 与 `MOBILE_TAB_IDS`（不放底栏的会自动进抽屉）**，别再往模板里手写 `<a>`
- 插件 manifest（public/plugins/manifest.json）是对象格式 `{ id, file, title, description, version, author }`（editor.js 兼容旧字符串格式）；停用名单存 settings `pluginsDisabled`（`utils.ts cleanDisabledPlugins` 校验，id 只允许 `[A-Za-z0-9_-]`），皮肤/插件市场目录在 `public/market/catalog.json`
- 编辑器 `save()` 是串行队列（勿改回早退模式——会丢发布意图造成假成功）；新弹窗一律用现成的 `modal()`（自带 Esc 关闭与焦点管理）
- 微信表情（文本码体系，机制在 `src/emoji.ts` + `public/admin/emoji.js`）：映射表**单一来源 `src/emoji.ts`**，经 `/api/public/emoji` 下发（客户端拉不到就降级纯文本码）；`scripts/fetch-emoji.mjs` 按表拉取 Twemoji PNG 到 `public/emoji/`（改表后重跑，tests/emoji.test.ts 守「表里每个码点 PNG 存在」）。**存库永远是文本码**：editor.js 富文本里插的是带 `data-emoji` 的 img，save()/自动保存的 serialize 过 `stripEmojiImgs` 反替换、htmlToMd 两处 img 分支认 data-emoji 还原码——新增「把 editor.innerHTML 写进 payload」的路径必须同样过它，别让 img 落库
- 动态创建 `<input type="file">` 必须走 `pickFiles` 助手（editor.js 导出、app.js 导入；site.js 有同款 ES5 版本，改动两端任一侧记得同步语义）：**游离节点在 iOS Safari 上选图器能打开、照片能选，但 change 不回填**——上传从未开始且全程无提示，手机上表现为「选了图发布出来只有文字」（2026-10 修复，headless 浏览器测不出）；先隐藏挂到 body 再 click，读完文件 / 用户取消即摘除；前台发布器还有在途上传计数守卫，发布 / 保存前必须归零
- 输入框回车提交必须判 `e.isComposing || e.keyCode === 229`（中文输入法组词回车）

**前台 site.js 兼容（全文件是一个 IIFE，一处解析错误全站交互瘫痪）**

- 保持 ES5 风格（var/function）：**禁用 lookbehind 正则**（`(?<!…)` Safari ≤ 16.3 解析期抛 SyntaxError）——微博文本分词正则（URL 链接化 + 话题）用捕获组消费前导字符的写法，改正则先跑 tests/outlink.test.ts 对照（与服务端 weiboTextHtml 同口径，见「外链中间页」防线节）
- **禁止裸调 localStorage**：隐私加固浏览器访问该属性即抛 SecurityError，一律走 `storeGet/storeSet`（内部 try/catch）
- **微信表情镜像**（`WXQ_CODES`/`wxqReplace`/`wbTextHtml` 内的表情分支，大 IIFE 顶层）：客户端表由 `/api/public/emoji` 下发、服务端在 `src/emoji.ts`——`wxqReplace` 与服务端 `replaceEmoji` 同口径（token 正则排除属性/实体特征字符、inTag 标签态状态机、hasOwnProperty 查表），改任一侧跑 tests/emoji.test.ts 双端镜像比对（该测试把 site.js 表情段 + wb 段切片拼接执行并注入服务端同一张表）；outlink.test.ts 的镜像工厂给 `wxqReplace` 传恒等 stub（其用例不含表情码）


**演示站（tests/demo.test.ts，docs/DEMO.md）**

- 演示站只在 `DEMO_MODE` 下活（wrangler.demo.jsonc 注入，生产 Worker 不带）：所有 demo 分支必须走 `utils.ts isDemo()`（`'0'`/缺省必须为假，勿写成 truthy 宽判）；`src/demo.ts` 由 index.ts 动态 import，生产 isolate 不执行。**禁外发的口径覆盖到插件总线之外**（fireHook 只是一层）：external.ts 的 `tgApi` / `notifyAdminText`（备份 / 评论 / 定时发布通知）、TG webhook 路由、`/api/admin/external/*`（token 生成与 webhook 设置）、`/api/admin/buffer/channels` 全部 isDemo 短路——新增出网调用点先问「demo 体验者（凭据公示）能不能触达」，能就同样短路
- 种子内容（demo-posts/demo-content/demo-images）是确定性生成：改内容后 tests/demo.test.ts 守不变量——slug 唯一干净、正文无 script/id/内联事件、评论树父子时序合法、正文图片引用必须存在于 demoImages()
- 两个 D1 坑都在 demo 里踩过并修掉：单条 SQL 变量上限 100（多行 INSERT 每条最多 10 行×9 列）；settings 写入必须 `.run()` 收尾，裸 `await db.prepare().bind()` 是空操作不报错
- demo 冷启动靠 `ensureTables()` 执行打进 bundle 的 schema.sql（生产建表靠部署时 d1 execute，演示站必须能从空库自己长出来）——改 schema.sql 两处（表/列定义与 db.ts 迁移清单）同步时，演示站自动跟随，无需额外动作

**部署链路**

- schema.sql 与 db.ts 的 SCHEMA_COLUMNS/SCHEMA_TABLES 是同一 schema 的两份表达：**加列/表必须两处同步**，且 cron（index.ts `scheduled()`）入口已强制先跑 ensureSchema——冷启动 isolate 不经过 fetch 中间件
- 「关于我」→ 页面系统的播种在 ensureSchema 末尾：以 settings 记账位 `pagesSeeded` 防重复（页面删了也不复活），改迁移逻辑别破坏这个幂等性
- 导出 zip 是流式生成（zip.ts 用数据描述符，图片从 R2 边流边算 CRC）——改导出逻辑别把图片改成整包缓冲，Workers 内存扛不住；新表记得手动加进 backup.ts 的 BACKUP_TABLES
- 备份表数超过 `TABLE_ROW_LIMIT` 会在文件与 TG 中告警（backup.ts），改备份逻辑别把告警删了
- 一键闭站（src/closed.ts，index.ts 挂中间件）的白名单是「关站后自己进得去」的底线：`/admin`、`/api/admin`、`/api/auth`、`/api/meta`、`/api/health`、`/images` 必须放行，其余（页面 / RSS / sitemap / 公开 API）一律 503 + Retry-After（保搜索收录），已登录管理员放行预览——tests/site-status.test.ts 与冒烟「一键闭站链路」守着，动入口中间件先跑；灰度开关是 render.ts 往 `<html>` 注入 `filter:grayscale(100%)`，filter 会改 fixed 后代的定位基准，新主题引入 fixed 元素时先复查

## Git 约定

- 本工作区服务**双仓库、两角色**：origin = `github.com/lovexw/bloghao-xwblog`（滚动开发测试仓库，日常提交只推这里），upstream = `github.com/bloghao/bloghao`（官方稳定版仓库，对外开放部署入口，main 永远保持可部署）。不做这两个仓库之外的操作
- 发布流程（2026-10-06 起废止旧「双推、两仓库同一提交」约定；同日收紧为 **upstream 默认冻结**）：日常提交**只推 origin**；**未经用户明确指示，任何改动都不同步到 upstream**——迭代稳定、攒了成批 feat、修了安全 / 数据问题，都不构成自行发布的理由，只有用户明确说「发布」才走流程：`git fetch upstream`，从 `upstream/main` 切发布分支，`git merge --squash` 本地 main（此时按需挑选/清洗，个人实例定制与实验内容不进官方版），确认 diff 后以单个版本提交推 upstream。两仓库历史自此允许分叉，**不要** `git push upstream origin/main:main` 直灌开发历史。**发布操作照 docs/RELEASING.md 清单执行**（版本号规则、挑洗依据「个人定制台账」、CHANGELOG 回填与镜像回开发线）；个人定制**合入 main 当天登记进台账**
- 开发线定位：xwblog 已完成「互动与创收」第一批功能（会员 / 积分 / 排行榜 / 访问密码，用法见 GUIDE §15）；后续方向见 docs/ROADMAP.md。本站专属的运营属性（收费配置、站点人设内容）落地时按规则登记个人定制台账，官方版挑洗时剔除
- README / docs / 官网以「博客号 BlogHao」官方项目口吻书写，对两个仓库都自洽；线上地址 blog.xiaowuleyi.com 在文档中一律表述为「在线示例」
- 同步方向永远 dev→stable 单向：**不要**从 upstream pull 覆盖本地（upstream 只接收发布，永不反向流入开发线）
- 2026-10-05 仓库整理：官方发布仓库由 bloghao-blog **改名**为 `lovexw/bloghao`（旧地址 GitHub 自动重定向）；更早的独立官网仓库已删除、内容并入 `website/`——遇到提这两个旧名字的链接/文档一律以现名为准
- 2026-10-10 官方仓库转移至 `bloghao` 组织：`lovexw/bloghao` → **`bloghao/bloghao`**（组织集中承载全部官方项目；star / Issue / CI 随转移保留，旧地址永久重定向，全仓文档与代码引用已统一切新地址）
- 提交信息沿用 `theme:` / `mobile:` / `docs:` / `brand:` 等前缀的中文风格

## 全站移动端适配（长期约定）

任何 UI 改动——前台页面、后台管理、编辑器——都必须保证手机端可用，**移动端写作（后台编辑器）是硬要求**：

- 新增样式至少验证 390px 宽度；断点沿用现有：前台 560/480px，后台 860/700px
- 输入控件（input/textarea/select）聚焦态字号 ≥16px，否则 iOS Safari 会自动放大页面
- 底部固定栏与底部导航要处理 `env(safe-area-inset-bottom)`
- 视口 meta 保持 `viewport-fit=cover, interactive-widget=resizes-content`
- 宽内容（表格、pre）在小屏用 `overflow-x: auto` 横向滚动，不撑破容器
- 覆盖层（抽屉、弹窗）小屏下要有明确的关闭按钮，且默认不挡内容

## 结构速查

- `src/i18n.ts`：英文测试版（内部代号 **English 0.1**，settings `edition` + `editionEnStatus` 两键）——词典 `tr(en, zh)`（**整串精确匹配，只翻系统内置文案，站长自填内容原样透传**）、英文日期四件套（`fmtDateEn/fmtDateEnShort/fmtDateTimeEn/weiboTimeEn`，与 fmtDate 同北京时间口径）、`enBetaBannerHtml` 公示横幅、`recordEditionFailure` 回退落库（tests/i18n.test.ts 直接导入）。**中文路径必须字节级不变**：`isEn(settings)`（edition=en 且 status≠fallback）为 false 时所有输出与历史版本完全一致，改共享构建器加英文分支时先跑 tests/themes.test.ts + tests/i18n.test.ts；公开页守卫在 index.ts `enGuard`——英文版渲染抛错即落库 status=fallback（全站自动回中文版）并当场用中文重渲染同一请求，后台横幅提醒，重新开启时 api.ts 重置状态；前台 JS 文案由 `<html data-edition="en">` 驱动（site.js / share-card.js 各有一份 T() 小词典，**改服务端文案记得同步客户端镜像**）

- `src/linkmeta.ts`：链接卡片（编辑器「插入链接 → 网址卡片 / 站内文章卡片」）——`fetchLinkMeta` 抓目标页 og 元数据（**SSRF 防线：`fetchableUrl` 只放行 http(s) 公网地址**，私有网段 / 非常规端口拒绝、限长限时、抓不到静默空对象退化占位卡）+ `linkCardHtml` 纯函数组卡（tests/linkmeta.test.ts 直接导入）；卡片是 `a.link-card[data-link-card="link-card"]` 结构化 HTML，存库靠 sanitize 白名单的 `data-link-card` 固定值标记，前台样式在七主题 `.rich .link-card` 段、编辑器内镜像在 admin.css（**改卡片结构两侧同步，标题/摘要截断口径 40/64 字**）；配套端点 `POST /api/admin/tools/linkmeta`（限频 10/分/IP）与 `GET /api/admin/posts/lookup`（轻出参，注册在 `/:id` 之前）

- `src/fetchsafe.ts`：出网安全统一入口（SSRF 防线 + 响应体限长）——`fetchableUrl`（linkmeta.ts re-export 保持历史导入路径）、`fetchPublicResource`（重定向逐跳复查 + readBodyLimited 流式限长），详见「出网安全」防线节
- `src/douban.ts`：书影音卡片（**第三方**编辑器插件 `public/plugins/douban-media.js`——manifest author 是个人、不进市场目录，2026-10 应站长需求做的个人定制）——搜书影音名从豆瓣联想接口（`/j/subject_suggest`）拿封面评分、组卡插正文，豆瓣被风控自动落备用源（书→Google 图书、影→TMDB(可选 key)/iTunes、音→**Deezer**，iTunes 中国区对中国内容常年返回空）；解析/组卡全是纯函数（tests/douban.test.ts 直接导入，净化往返守 id / on* / javascript: 防线，`data-no-dark` 必须带空值——净化器只回传有值属性）；端点 `POST /api/admin/tools/douban` 注册在鉴权中间件之后、限频 10/分/IP、**settings `pluginsDisabled` 含 `douban-media` 即 404**（编辑器停用开关与端点同步）；中转配置（地址/令牌/TMDB key）由插件随请求携带、存插件 localStorage（前缀 `bloghao-plugin-douban-media-`），不进 settings；**只认代码构造的豆瓣地址**（粘贴链接仅提取 subject 数字 id 重组，中转地址必须 https + 公网过 `fetchableUrl`），不构成开放代理；**豆瓣 CDN 有防盗链**（无 Referer 418 / 外站 Referer 403，实测 2026-10）：组卡时封面**先转存站内图床**（`store.ts transferImage` 的可选 referer 参数带豆瓣域 Referer——卡片永久自持，零配置可用），失败才退中转 `/img`、没中转就省略封面（诚实降级无图卡）；编辑器列表缩略图走 `GET /api/admin/tools/douban/img` 白名单代理（doubanio/dzcdn/mzstatic/tmdb/google 五域，登录 + 限频 60/分/IP）；**自建中转 `douban-relay/`**（跑在站长服务器上，零依赖 Node 单文件 server.cjs）是**可选的评分稳定器**而非必需品：`*.douban.com`/`*.doubanio.com` 域名白名单代理 + 磁盘缓存（页面 6h/图 30d）+ 每主机串行节奏（≥1.6s+抖动）+ 被风控指数冷却（5min→1h，冷却期不碰豆瓣）+ cookie 持久化（支持 `DOUBAN_COOKIE` 注入登录态，风控最低一档），部署见其 README；豆瓣已知的死路别再撞：**音乐搜索联想接口已下线**（详情页按 id 直取仍有评分）、www/m 站搜索接口 403/404、加密搜索页别碰（解密方案改版即死）、电影条目页 sec 挑战最紧（中转 + 登录 cookie 是解）；仓库根 package.json 是 `type: module`，relay 必须保持 `.cjs` 后缀

- `src/themes/`：七套主题（wechat 默认 / paper / midnight / minimal / journal / bitcoin / rednote）+ `registry.ts` 注册表（十类页面参数是导出的命名类型 `HomeData`/`PostData`/…，新增主题或字段只改 registry 一处；七主题 × 十页面渲染回归在 tests/themes.test.ts，改主题先跑）；`siteNav` 支持可选 `compact` 布局（主条收窄五项 + 会员药丸右置，仅 wechat 传），页脚链接组走 `footLinksFor(s)` 动态生成（排行榜随 membersEnabled 门控）
- 站点模式（settings `siteMode`：`blog-weibo` / `weibo-blog` / `blog` / `weibo`，解析统一走 `render.ts siteMode()`）决定微博/博客模块的前台显隐与首页优先级：导航在 `siteNav` 的 mode 参数、首页微博流在 `weiboHomeFeed`、页脚链接组在 `footLinks`（纯博客模式剥掉各主题 FOOT_LINKS 里的 /weibo 链接，七主题的 foot() 都要过它）、`/weibo` 与 `/` 的分流在 pages.ts——**新增前台模块或导航项时要四种模式都过一遍**（tests/site-mode.test.ts + tests/themes.test.ts 微博流回归守着）；后台设置页是「三选一 + 双方模式下的顺序」联动控件
- `src/pages.ts` 渲染公开页（含独立页面 `/page/:slug`，pages 表承载，`about` 页渲染在 `/about`）；`src/api.ts` 全部 JSON API；`src/collect.ts` 是公众号采集插件的服务端（编辑器插件在 `public/plugins/`，开发文档 docs/PLUGINS.md）；`src/export.ts` + `src/zip.ts` + `src/html-md.ts` 是数据导出（Markdown 包流式打 zip、WXR）；`src/closed.ts` 是一键闭站 / 灰度（settings `siteClosed` / `siteGrayscale`，独立成模块是为了 Node 测试能导入——index.ts 会级联加载主题 CSS）；`src/trash.ts` 是回收站 / 三表软删除（posts/weibo/pages 的 `deleted_at` 标记、恢复与 30 天到期清理，同样可被 Node 测试导入，详见「回收站 / 软删除」防线节）；`src/fts.ts` 是 FTS5 全文搜索（/search 页文章 + 微博检索、MATCH 构造与 LIKE 兜底，详见「全文搜索 FTS5」防线节）；`src/hooks.ts` 是服务端插件钩子（总线 + 注册表 + 官方示例三合一，发布/微博/评论事件与页脚注入，插件失败必须吞掉不影响主流程，启停存 settings `serverPluginsDisabled`；`onWeiboPublished` 的四条触发路=后台新建/草稿转发布/开放 API/TG 机器人，编辑已发布微博不重推——新增微博发布入口必须同路广播，buffer-sync 插件的 Buffer GraphQL 口径见 docs/PLUGINS.md，settings 键 `bufferAccessToken` 进 SECRET_SETTINGS 打码）；**广场同步插件**（B17）的双端签名镜像——`plazaSign`（hooks.ts）与 `verifyPlazaSignature`（plaza/src/core.ts）同一 `HMAC(token, ts.rawBody)` 口径，改任一侧必须跑 tests/plaza-hub.test.ts 的双端镜像用例；插件广场地址**留空即官方 hub**（`PLAZA_OFFICIAL_HUB`，https://plaza.bloghao.com——唯一官方入口，稳定版/开发版一律由此接入），别改回「空=不同步」；官方 hub 实际部署在甲骨文服务器（plaza-hub 容器 8790，Caddy plaza.bloghao.com 精确块反代，构建走 demo/hub-node），hub 的 `stats` 表按北京日一行记 feed/sites/ingest 调用，`/api/admin/stats` 供 ops 控制面「广场 hub」卡片消费（PLAZA_HUB_URL + PLAZA_ADMIN_TOKEN env 门控），改统计口径两处（schema 与端点）同步；`PostPublishedPayload.locked`（加密/锁文标志）由 api.ts 两处发布点与 scheduler 透传，新增发布入口必须同路透传——广场同步等同步类插件据此跳过锁文，别把锁文捅上公开面）
- `src/demo.ts` + `demo-content.ts` / `demo-posts.ts` / `demo-images.ts`：官方演示站引擎（独立 wrangler.demo.jsonc，DEMO_MODE 门控）——空库自播种、每 2 小时 cron 清库重灌（清空表清单 WIPE_TABLES 含会员三表）、演示守卫（登录页公示 demo 账号、禁改密码、禁闭站、禁外发通知、全站 noindex）；种子内容确定性生成（含演示会员 demo/demo1234 与积分账本、会员付费墙演示文、访问密码演示文），所有公开页经 pages.ts pageOpts 注入「演示体验版」横幅（render.ts demoBannerHtml）；文档 docs/DEMO.md。**独立 Docker 体验站仓库 `bloghao-demo` 从本仓库快照生成**（server 适配层 + Dockerfile 是它自有的，其余 src/public/schema.sql 靠同步脚本从本仓库导出）——改 demo 引擎/种子或公开渲染后，提醒该仓库重新同步
- `public/admin/`：后台（app.js 路由与页面——侧栏菜单看顶部 `MENU` 配置数组，editor.js 写作编辑器，admin.css 样式）；「皮肤 / 插件」是独立页面（`#/appearance`、`#/plugins`），市场目录在 `public/market/catalog.json`
- `plaza/`：广场 hub 独立 Worker（bloghao.com/plaza 的数据面，与主博客部署无关）——`src/core.ts` 纯函数（HMAC 签名校验 / ingest 校验 / 混排评分 / RSS 解析，tests/plaza-hub.test.ts 直接导入）+ `src/index.ts` 路由（push ingest / feed / 管理端点 / pull cron）；协议、部署与管理口径见 docs/PLAZA.md，改动 hub 协议先读它
- `website/`：「博客号」官网静态页（朱砂红新版设计），部署走 Cloudflare Pages 项目 `bloghao`，**勿用 Workers assets 另起部署通道**；「博客号目录」数据在 `website/public/data/showcase.json`，上榜入口指向 bloghao 的 issues；官网 UI 改动同样过 390px 移动端检查
- `docker-poc/`：Docker 自托管——业务代码零改动跑进 Node 单进程多站点（D1→node:sqlite、R2→磁盘目录 `shims/r2disk.ts` 或 R2 S3 接口 `shims/r2s3.ts`，静态直出与 cron 对齐 wrangler 行为，文档在其 README.md / DEPLOY.md；1GB 小机部署清单 DEPLOY-MICRO.md，开台脚本 add-tenant.sh）；**改 Workers 专有 API 面（D1/R2 用法、静态资源、cron、waitUntil）或 schema.sql 时，必须同步 docker-poc 的 shim 并跑 `docker-poc/smoke.sh` 冒烟**；改 add-tenant.sh 记得它跑在 busybox sh 下、变量引用全用 `${HOST}` 花括号（中文文案紧贴 `$HOST` 时 bash 3.2 会把高位字节并进变量名，`set -u` 直接崩），且配置文件只能原地 `cat >` 截断写、不能 mv 换 inode（单文件 bind mount）；访客 IP 信任档位 `TRUST_PROXY`（cf/proxy/off，默认 proxy=本机自控反代取 XFF 最后一跳）必须与真实部署形态一致，否则换假 IP 重置限流桶——档位说明与违后果见 docker-poc README「访客 IP 信任档位」节
- 编辑器内容样式（`.ed-editor`）与文章页（`.rich`）需保持视觉一致——改一处记得镜像另一处
- 前台微博卡管理（编辑 / 置顶 / 删除，site.js 末段）：管理按钮由 `render.ts weiboCards` 仅在 `adminName`（⟺ 管理员登录）时渲染，**访客 HTML 里不存在**；写操作复用 `/api/admin/weibo*`（session 鉴权）——`PUT` 是全量更新，**必须带原 images 否则配图被清**、必须显式传 `status:'published'` 否则会转草稿；编辑保存后的就地渲染（wbTextHtml / imgsClass）与后端 `weiboTextHtml / weiboImageGrid` 同口径，改正则或网格分列规则要两边同步；编辑态切换显隐用内联 `style.display`（主题 CSS 的 display 会盖掉 `[hidden]`）
