# API 参考

所有接口前缀 `/api`，JSON 交互。管理接口需要会话 Cookie（浏览器登录后台后自动携带）。

写爬虫/客户端时注意：非 GET 请求必须**同源**携带 `Origin` 头或直接不携带，跨源一律 403。

## 公开接口

### GET /api/health
`{"ok":true,"time":...}`

### GET /api/public/emoji
微信默认表情映射表（文本码 → 站内小图码点），单一来源 `src/emoji.ts`：`{ base: "/emoji/", codes: { "微笑": "1f60a", ... } }`。静态数据，浏览器缓存一天（`Cache-Control: public, max-age=86400`）；闭站时随公开 API 一律 503（编辑器表情面板降级为空，文本码插入与渲染不受影响）。正文 / 微博 / 评论区渲染层把 `[微笑]` 替换成 `<img class="wxq-emoji" src="/emoji/1f60a.png" alt="[微笑]">`（查表不到原样保留），存库永远是文本码。图源 Twemoji（CC-BY 4.0，归属见 public/emoji/README.md）。

### GET /api/public/posts?page=1&limit=10&tag=生活
已发布文章分页（摘要视图），返回 `{items, total, page, totalPages}`，`items` 元素含 `slug/title/summary/cover/tags/published_at/views/likes/pinned`。

> 列表排序（最新/最多阅读/最多点赞/最多留言/随机）目前只由 SSR 页面（首页 / 分类 / 搜索）使用，本接口固定按最新（置顶优先）返回。

### POST /api/public/comments
文章留言。Body：

```json
{ "slug": "hello-bloghao", "nickname": "路人甲", "content": "写得真好", "link": "" }
```

- `link` 是蜜罐字段，正常客户端永远传空字符串/不传
- 受限流（同 IP 10 分钟 5 条）与站点「开启留言 / 先审后展」设置约束
- `nickname` ≤ 24 字，`content` ≤ 1000 字，均为纯文本存储
- **作者回复（楼中楼）**：登录管理员携带 `parentId`（被回复的评论 id）即以作者身份回复，免昵称、免限流、绕过「关闭留言」开关、直接展示并带「作者」徽标；未登录携带 `parentId` 一律 403
- 响应 `{ok:true}` 或 `{ok:true, pending:true}`（先审后展开启时，前端据此刻意不刷新）

### POST /api/public/like/:slug
Body `{"delta": 1}` 或 `{"delta": -1}`，返回 `{"ok":true,"likes":7}`。计数不会为负。

### POST /api/public/like/weibo/:id
微博点赞，同上。

### POST /api/public/guestbook
留言板留言（`/guestbook` 页）。Body 与规则同 `POST /api/public/comments`（`nickname` / `content` / 蜜罐 `link` / 限流 / 审核），无 `slug`；管理员带 `parentId` 即以作者身份回复（楼中楼）。存储上留言板留言是 `post_id = 0 AND weibo_id = 0` 的评论。响应 `{ok, pending?}`。

### GET /api/public/weibo/:id/comments
微博的已展示评论（平铺 ASC，最多 200 条），元素含 `id/parent_id/is_admin/nickname/content/created_at`；前端按 `parent_id` 组装楼中楼。响应 `{comments, allowComments, adminAvatar}`——`adminAvatar` 是站点头像（settings.avatarUrl，可为空串），前端给 `is_admin` 评论的作者头像位用，与会员 `member_avatar` 同一展示位。

### POST /api/public/weibo/:id/comments
微博评论。规则同 `POST /api/public/comments`（蜜罐 / 限流 / 审核 / 管理员 `parentId` 回复），`nickname`/`content` 约束一致。

### POST /api/public/links/apply
友链申请（访客提交，进入待审核）。Body：

```json
{ "name": "朋友的博客", "url": "blog.example.com", "description": "一句话介绍", "link": "" }
```

- `link` 为蜜罐字段；同 IP 10 分钟限 3 次
- `url` 自动补全 `https://` 前缀并做 URL 规整，非法返回错误；同名网址去重
- `name` ≤ 40 字，`description` ≤ 120 字；成功入库 `status='pending'`、`source='user'`

### POST /api/public/track
访客统计打点（`site.js` 在所有公开页面自动上报，一般无需手动调用）。Body：

```json
{ "p": "/post/hello?utm=x", "r": "https://www.google.com/", "v": "匿名访客id", "t": "页面标题" }
```

- 服务端清洗：`p` 必须以 `/` 开头（剥控制字符，截 300），`r` 只留域名，`v` 只放行 `[A-Za-z0-9_-]`，`t` 截 200；路径不合法直接静默丢弃
- 设备 / 浏览器族由服务端按 User-Agent 解析，国家取 `CF-IPCountry`；不存 IP 与原始 UA
- 同 IP 10 分钟限 120 次；设置 `statsEnabled=0` 时接口返回 `{ok:true}` 但不入库
- 始终返回 `{"ok":true}`（失败静默，不打扰页面）

### POST /api/member/register
会员注册（站点「会员功能」关闭时整组 `/api/member/*` 返回 404）。Body：

```json
{ "username": "xiaoke", "password": "至少8位", "nickname": "选填昵称", "email": "可选", "link": "" }
```

- `link` 是蜜罐字段，正常客户端永远传空字符串/不传；限流同 IP 10 分钟 5 次
- 用户名 2-24 位字母/数字/`_`/`-`，密码 8-64 位；用户名占用或校验失败 400
- `nickname` 选填（中英文均可，剥控制字符后 ≤24 字符，仅展示不做唯一约束）；注册填写**不占用** 30 天修改窗口
- 成功即登录：`{ok:true, member:{nickname,tier,points,...}}` 并签发 `xw_member_session` Cookie（HttpOnly，30 天，与管理员会话完全独立）

### POST /api/member/login
`{username, password}` → `{ok:true, member:{...}}`；口令错误 401（响应耗时恒定防用户名枚举），账号被封禁 403 `{"error":"banned"}`。

### POST /api/member/logout
清除会员会话 → `{ok:true}`。

### GET /api/member/me
`{member: {...} | null}`，恒 200（未登录为 `null`，前端据此渲染登录表单或会员卡）；本人视角额外含 `username` / `email` / `createdAt` / `displayNameChangedAt`（上次改昵称时间戳，null = 从未改过）。会员发言走上方评论三路接口即可：带会员 Cookie 时服务端自动挂身份，`nickname`/`email`/`website` 字段被忽略。

### POST /api/member/profile
修改昵称 / 绑定 QQ 头像（需登录；会员功能关闭时 404）。Body：`{ "nickname"?: "新昵称", "qq"?: "12345" }`，两键至少一个；`qq` 不带键 = 不碰。

- **昵称**：清洗口径与注册一致（剥控制字符、trim、≤24 字符），空值 400「昵称不能为空」；**30 天一次**——冷却中 403（消息含解禁日期，如「昵称每 30 天只能修改一次，2026年11月6日后可再改」）；窗口判定下沉为 SQL 条件更新（`display_name_changed_at IS NULL OR <= now-30d`），并发双开同时过前置检查时只有一动能落库；成功 `{ok:true, nickname, displayNameChangedAt}`
- **QQ 头像**（评论头像 C2）：`qq` 校验 `^[1-9][0-9]{4,10}$`（`utils.ts isValidQQ`，每会员 10 次/分钟限流）；服务端抓 `q1/q2.qlogo.cn`（s=140）→ 魔数识别 → 站内 R2 转存（EXIF 剥离同款兜底）→ 回写 `members.avatar`。**抓取失败容忍**：只记 qq 号，出参 `avatarFailed:true`，重发同一请求即重试头像；成功出参含 `avatarUrl`（站内 `/images/` 地址）。**`qq` 号本体只进本人视角出参**（`/api/member/me` 的 self 视图），评论 / 排行榜等公开面一律不携带
- **游客也可选填** `qq`（评论头像 C2 扩展）：三路评论接口的 body 都收 `qq` 字段——校验 `^[1-9][0-9]{4,10}$`，**格式不对按没填处理**（不拦评论）；合法则服务端抓取腾讯头像转存 R2（同号历史头像直接复用，不重复抓取）。qq 号本体任何接口都不返回，评论行只带 `avatar`（站内 `/images/` 地址）
- 微博评论 JSON（`GET /api/public/weibo/:id/comments`）与文章 / 留言板评论渲染新增 `member_avatar`（会员头像）与 `avatar`（游客自填 QQ 抓取的站内头像）字段，前端按 会员 → 作者站点头像 → 游客 → 昵称首字块 取值
- 评论头像位优先级：会员 `member_avatar` → 作者评论（`is_admin=1`）用 `adminAvatar`（站点头像，与微博卡同源）→ 昵称首字块

### POST /api/member/password
修改密码（需登录；会员功能关闭时 404）。Body：`{ "currentPassword": "当前密码", "newPassword": "新密码" }`。

- 新密码 8-64 位；当前密码错误 400（PBKDF2 验证，按 IP 10 分钟 10 次限流防滥用）
- 成功后**其他设备的会员会话全部失效**（当前会话保留）；本站不提供密码找回，表单旁有固定提醒

### GET /go?u=<url>（SSR 页面）
外链中间页（机制见 `src/outlink.ts`）：白名单域名（`TRUSTED_OUT_DOMAINS`，子域名自动跟随）与本站同源地址 302 直跳；其余第三方 http(s) 地址渲染「即将离开本站」确认页（展示目标域名与完整链接、附免责声明，`noindex`，无 JS、不自动跳转，故不构成开放重定向）。目标缺失 / 非 http(s) / 超 2048 字符一律 302 回首页。正文外链在渲染层包装进来：文章 / 页面 / 关于我走 `sanitizeHtml(html, { origin })`，微博文本走 `weiboTextHtml`（客户端镜像在 site.js）——存库与 RSS / 导出保持原始 URL。

## 认证

### GET /api/auth/state
`{"needsSetup": true, "user": null}` —— `needsSetup=true` 表示尚无任何用户，可调用 setup。

### POST /api/auth/setup （仅首次）
```json
{ "username": "demo", "password": "至少8位", "displayName": "小吴" }
```
创建管理员 + 欢迎文章，响应 Set-Cookie 会话（30 天）。

### POST /api/auth/login
`{ "username", "password" }`。同 IP 10 分钟内最多尝试 10 次。

### POST /api/auth/logout
销毁会话。

## 管理接口（需登录）

### GET /api/admin/stats
概览统计：`{posts, views, likes, drafts, pendingComments, pendingLinks, uploads:{count,bytes}, recent:[…]}`

### GET /api/admin/visits?days=30
访客统计聚合（后台「统计」页），`days` 1-365 默认 30（含今天共 N 天，北京时间）。响应：

```json
{
  "days": 30, "pv": 0, "uv": 0, "todayPv": 0, "todayUv": 0,
  "series":   [{ "day": "2026-10-01", "pv": 0, "uv": 0 }],
  "topPages": [{ "path": "/post/hello", "title": "…", "pv": 0, "uv": 0 }],
  "topRefs":  [{ "ref": "www.google.com", "pv": 0, "uv": 0 }],
  "devices":  [{ "name": "mobile", "pv": 0 }],
  "browsers": [{ "name": "wechat", "pv": 0 }],
  "countries":[{ "name": "CN", "pv": 0 }],
  "hourly":   [{ "h": 0, "pv": 0 }]
}
```

`series` 按天补零；UV 为去重匿名访客号（`COUNT(DISTINCT vid)`）；数据表 `visit_log` 保留 180 天、不进备份。

### 文章
| 方法 | 路径 | 说明 |
| --- | --- | --- |
| GET | `/api/admin/posts?status=all\|published\|scheduled\|draft&q=关键词&page=1&limit=20` | 列表（不含 content；元素附 `tagList`、`categoryName`） |
| POST | `/api/admin/posts` | 新建 |
| GET | `/api/admin/posts/lookup?q=关键词&page=1` | 站内文章选择器（编辑器「插入链接 → 站内文章」）：仅已发布，轻出参 `{items:[{id, slug, title, summary, cover, published_at, hasPassword, minTier}], total, page, totalPages}`，无正文无口令；**注册在 `/:id` 之前**（否则 lookup 被 id 参数吞掉） |
| GET | `/api/admin/posts/:id` | 详情（含 content、categoryId） |
| PUT | `/api/admin/posts/:id` | 更新（autosave 用；已发布时间不会被草稿保存抹掉）。**缺键即保留**：Body 里没出现的字段（content/tags/categoryId/title 等）一律沿用旧值——列表页状态切换只发 `{status}` 不会误清正文；显式传空串/空数组/`null` 才是清空 |
| POST | `/api/admin/posts/:id/pin` | Body `{pinned:true/false}` |
| DELETE | `/api/admin/posts/:id` | 删除：**移入回收站**（软删，30 天后由 cron 自动彻底清除；评论与分类关联保留，恢复时一并跟回；彻底删除见下方「回收站」） |
| GET | `/api/admin/tags` | 全站标签聚合（编辑器补全用，见下方「标签」） |

文章 Body 字段：

```json
{
  "title": "标题",
  "content": "<p>富文本 HTML，服务端会白名单净化</p>",
  "summary": "摘要，可空",
  "cover": "/images/u/202610/xxx.jpg",
  "tags": ["生活", "Cloudflare"],
  "categoryId": 1,
  "status": "draft | published | scheduled",
  "publishAt": 1791121500000,
  "pinned": false,
  "slug": "留空自动生成，可自定义",
  "password": "访问密码，可空"
}
```

约束：title ≤ 150 字；content ≤ 1MB；tags ≤ 8 个、每个 ≤ 20 字；cover 必须以 `/` 或 `http(s)://` 开头；`categoryId` 为 null/空表示未分类，不存在分类 id 时被忽略；`password` ≤ 64 位。`status:"scheduled"` 时 `publishAt` 为毫秒时间戳（到点由每分钟 Cron 翻成 published 并把 `published_at` 设为该时刻，同时推 Telegram；转 published/draft 时 `publishAt` 自动清空）。

**访问密码（文章加密码）**：`password` 缺键 = 保持现状（自动保存安全），非空 = 设置 / 更换（服务端 PBKDF2 单向哈希落库，明文与哈希都不回显），空串 = 解除加密。响应里只有 `hasPassword` 布尔，`password_hash` 永不出现。加密文章的前台行为（机制见 `src/protect.ts`）：文章页在密码验证通过前只渲染密码表单（正文、评论区、自动摘要、JSON-LD 描述一概不出，管理员登录除外）；解锁走表单 `POST /post/:slug/unlock`（`application/x-www-form-urlencoded`，Body `password=…`，非 JSON API）——成功 303 回文章页并签发 HttpOnly 解锁 Cookie `bloghao_pp`（HMAC key 即该文 password_hash，30 天有效、改密即失效），失败 303 回 `?pwerr=1`，限流触发 303 回 `?pwerr=slow`（每 IP 每文 10 次 / 10 分钟）。防泄漏口径：RSS 不出该文 `content:encoded` 全文；关键词搜索不命中加密文章；`/random` 不进加密文章。

### 微博（随手记）
| 方法 | 路径 | 说明 |
| --- | --- | --- |
| GET | `/api/admin/weibo?status=all\|published\|draft&page=1&limit=20` | 列表（置顶优先；元素附 `imageList`、`topicList`、`commentCount`） |
| GET | `/api/admin/weibo/:id` | 单条原稿（前台卡片「编辑」的数据源，附 `imageList`、`topicList`） |
| POST | `/api/admin/weibo` | 新建（发布或存草稿） |
| PUT | `/api/admin/weibo/:id` | 更新（转回草稿会自动取消置顶） |
| POST | `/api/admin/weibo/:id/pin` | Body `{pinned:true/false}` |
| DELETE | `/api/admin/weibo/:id` | 删除：**移入回收站**（软删，30 天后自动彻底清除；其下评论保留，恢复时一并跟回；彻底删除见下方「回收站」） |

微博 Body 字段：

```json
{
  "content": "文字内容，可含 #话题",
  "images": ["/images/u/202610/xxx.jpg"],
  "status": "published | draft"
}
```

约束：`content` ≤ 5000 字；`images` ≤ 9 张、只接受站内 `/images/` 与 `http(s)` 外链；`content` 与 `images` 不能同时为空；**话题不接受直传**——服务端从正文 `#话题`（兼容成对 `#话题#` 与 `#层级/标签`）自动提取；置顶最多 3 条，草稿不能置顶。

### 友情链接
| 方法 | 路径 | 说明 |
| --- | --- | --- |
| GET | `/api/admin/links?status=all\|approved\|pending` | 列表（不回传提交者 ip；附 `pending` 计数、`source: admin\|user`） |
| POST | `/api/admin/links` | 手动添加（默认 `status:'approved'`） |
| POST | `/api/admin/links/fetch-icon` | Body `{url}`，抓取目标站 favicon 存 R2 → `{icon:"/images/u/fav/…"}` |
| POST | `/api/admin/links/:id/approve` | 收录（pending → approved）；无图标时后台异步补抓，不卡响应 |
| POST | `/api/admin/links/:id/refresh-icon` | 重新抓取图标 |
| POST | `/api/admin/links/reorder` | Body `{id, dir:"up"\|"down"}`，按当前顺序交换后整体回写 sort |
| PUT | `/api/admin/links/:id` | 编辑（含改状态：传 `status:'pending'` 即「隐藏」） |
| DELETE | `/api/admin/links/:id` | 删除 |

链接 Body 字段与约束：

```json
{ "name": "站名", "url": "https://…", "description": "简介", "icon": "/images/u/fav/… 或 https://…", "status": "approved | pending", "sort": 0 }
```

`name` ≤ 40 字；`url` 自动补全 `https://` 并规整；`description` ≤ 120 字；`icon` 只接受站内 `/images/` 与 `http(s)` 外链（防 `javascript:` 注入），留空前台用站名首字图标；服务端抓取图标时仅收 ICO/PNG/JPG/WebP/GIF、单文件 ≤ 300KB、超时 6 秒。

### 分类
| 方法 | 路径 | 说明 |
| --- | --- | --- |
| GET | `/api/admin/categories` | 列表（附 `post_count` 文章计数） |
| POST | `/api/admin/categories` | Body `{name, slug?, sort?}`；slug 留空用名称，支持字母/数字/中文/短横线 |
| PUT | `/api/admin/categories/:id` | 编辑（名称与 slug 均不可重复） |
| DELETE | `/api/admin/categories/:id` | 删除（关联文章变为未分类，文章不受影响） |

`name` ≤ 20 字。单分类模型：一篇文章最多属于一个分类（`post_categories.post_id` 为主键）。

### 独立页面
| 方法 | 路径 | 说明 |
| --- | --- | --- |
| GET | `/api/admin/pages` | 列表（全部状态，按 sort 排序） |
| POST | `/api/admin/pages` | Body `{title, slug?, content?, status?: "draft"\|"published", show_in_nav?}`；slug 留空按标题生成（字母/数字/中文/短横线），重名自动加 `-2` 后缀 |
| PUT | `/api/admin/pages/:id` | 编辑；`status` / `show_in_nav` 未提供时沿用旧值 |
| DELETE | `/api/admin/pages/:id` | 删除：**移入回收站**（软删，期间前台立即 404，30 天后自动彻底清除；彻底删除见下方「回收站」） |
| POST | `/api/admin/pages/reorder` | Body `{id, dir: "up"\|"down"}`，上移 / 下移导航排序 |

`title` ≤ 60 字，`content` 为 HTML、白名单净化后 ≤ 100KB。前台渲染在 `/page/:slug`（导航高亮 `p:<slug>`）；`slug='about'` 的页面（迁移自「关于我」）固定渲染在 `/about`，`/page/about` 301 回专属短链。

### 标签
| 方法 | 路径 | 说明 |
| --- | --- | --- |
| GET | `/api/admin/tags` | 文章实际用到的标签 + 分类页预建标签（count 0），按使用次数排序，最多 200 个 |
| POST | `/api/admin/tags` | Body `{name}`，预建标签（≤ 20 字，不可重名） |
| DELETE | `/api/admin/tags/:name` | 删除标签，并从所有文章的 tags 中移除 |

### 回收站（软删除）
文章 / 微博 / 独立页面删除时统一打 `deleted_at` 毫秒时间戳标记（不真删），前台与后台各列表立即不可见；**保留 30 天**，每晚备份 cron 顺带把到期项彻底删除并级联清掉其下评论（到期前数据仍在每日备份里）。恢复 = 清除标记，内容原样回到删除前的状态（文章恢复后若定时时间已过则自动转为草稿，不会恢复即发布）。

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| GET | `/api/admin/trash?type=post\|weibo\|page&page=1` | 列表（type 缺省 = 三类合并，按删除时间倒序，每页 20；元素 `{type, id, label, status, deleted_at}`，weibo 的 label 为正文前 120 字） |
| POST | `/api/admin/trash/post\|weibo\|page/:id/restore` | 恢复（内容回到原列表；仅对已在回收站的行生效） |
| DELETE | `/api/admin/trash/post\|weibo\|page/:id` | 彻底删除（**不可恢复**；文章/微博连带其下评论、文章连带分类关联一并删除；仅对已在回收站的行生效，误传存活 id 返回 404） |
| POST | `/api/admin/trash/purge` | 清空回收站，Body 可选 `{type}` 定向清空一类（缺省全清） |

### 上传 / 媒体
| 方法 | 路径 | 说明 |
| --- | --- | --- |
| POST | `/api/admin/upload` | multipart，字段名 `file`；图片 JPG/PNG/WebP/GIF（favicon 另允许 ICO）、视频 MP4/WebM；≤ 25MB；限频 60 次/分钟/IP；返回 `{url:"/images/u/...", key, mime, size}`（前端上传前自动压缩大图，API 直传不压缩） |
| POST | `/api/admin/og-image` | multipart，字段名 `file`；仅 PNG（编辑器 canvas 生成的 1200×630 分享卡图），存 R2 `og/` 目录；返回 `{url:"/images/og/...", key}` |
| GET | `/api/admin/uploads?page=1` | 媒体列表（每页 24） |
| DELETE | `/api/admin/uploads?key=u/202610/xxx.png` | 从 R2 与索引中删除 |
| GET | `/api/admin/uploads/audit` | 媒体体检：`{scanned, missingHash, unreferenced:[…], unreferencedBytes, duplicateGroups:[{hash,items:[{key,name,size,referenced}],wasteBytes}], duplicateBytes, ghosts:[…]}`（逻辑见 src/audit.ts；限频 10 次/分钟/IP） |
| POST | `/api/admin/uploads/hash-backfill` | Body `{limit?:25}`（≤50），为本轮 ≤limit 个无指纹文件从 R2 读内容算 SHA-256；R2 里已丢失的写哨兵 `missing`；返回 `{processed, missing, remaining}`，remaining>0 就继续调（限频 60 次/分钟/IP，独立于体检的 10 次桶——前端回填是循环连发） |
| POST | `/api/admin/uploads/merge` | Body `{keep, remove:[key…]}`（≤20 个），把重复文件的引用改写到保留项（posts/pages/weibo/users/friend_links/settings/tg_buffer）再删文件；要求所有 key 内容指纹一致，否则 400 |
| POST | `/api/admin/uploads/cleanup` | Body `{keys:[key…]}`（≤100 个），删除未引用媒体；执行前会重新校验引用，期间被内容引用的保留并回告 `blocked:[…]`；返回 `{deleted, freedBytes, blocked}` |

### 评论
| 方法 | 路径 | 说明 |
| --- | --- | --- |
| GET | `/api/admin/comments?status=all\|pending\|approved&type=all\|post\|weibo&page=1` | 列表（`type` 拆分文章评论 / 微博评论 / 留言板（`guestbook`）；附文章标题/slug、微博内容、父评论昵称） |
| PUT | `/api/admin/comments/:id` | Body `{status:"approved"\|"pending"}`（通过 / 隐藏） |
| POST | `/api/admin/comments/:id/replies` | Body `{content}`，以作者身份回复该评论（文章/微博/留言板通用），挂在同一顶层评论下，直接展示并带「作者」徽标 |
| DELETE | `/api/admin/comments/:id` | 删除（连带其下的回复） |

### 设置 / 账号 / 工具
| 方法 | 路径 | 说明 |
| --- | --- | --- |
| GET / PUT | `/api/admin/settings` | 可写键：`siteName, siteDescription, siteUrl, footerText, avatarUrl, faviconUrl, ogImageDefault, theme, allowComments, moderateComments, notifyNewComment, rssFullText, backupEnabled, postsPerPage, about（legacy，已由「页面」承载）, pluginsDisabled, siteGrayscale, siteClosed, siteClosedMessage, membersEnabled（会员体系总开关）, rankTopN（/rank 展示条数 1-50）, externalToken, telegramBotToken, telegramAllowFrom, telegramWebhookSecret`；`theme` 必须是已注册主题 id；`avatarUrl`/`faviconUrl`/`ogImageDefault` 只接受站内 `/images/` 与 `http(s)` 外链；`pluginsDisabled` 为逗号分隔的插件 manifest id（仅字母/数字/`_`/`-`）；`siteGrayscale`/`siteClosed` 为 `1`/`0` 开关（闭站时公开页面与公开 API 一律 503，白名单见 src/closed.ts，已登录管理员不受影响）；`siteClosedMessage` ≤1000 字；`externalToken`/`telegramBotToken`/`telegramWebhookSecret` 为敏感项，GET 与 PUT 的响应一律打码（`••••••••`），明文只在生成时返回一次，PUT 收到打码占位符视为保持原值 |
| PUT | `/api/admin/password` | Body `{oldPassword, newPassword}`（8-64 位） |
| POST | `/api/admin/tools/md` | Body `{md}` → `{html}`，Markdown 渲染 |
| POST | `/api/admin/tools/linkmeta` | Body `{url}` → `{meta:{title, description, image, siteName}}`，编辑器「网址卡片」抓取目标页 og 元数据；只抓 http(s) 公网地址（私有网段/非常规端口拒绝，限长限时），抓不到时字段为空（前端用域名占位组卡）。限频 10 次/分钟/IP |
| POST | `/api/admin/tools/sanitize` | Body `{html}` → `{html}`，白名单净化（粘贴用） |

### 采集（公众号文章）
| 方法 | 路径 | 说明 |
| --- | --- | --- |
| POST | `/api/admin/collect/wechat` | Body `{url}`，仅接受 `https://mp.weixin.qq.com/s/...`；服务端抓取正文，配图与封面转存 R2（与封面同媒体的正文首图自动去重），生成**保留原文发布时间**的草稿；返回 `{ok, post, account, images}`。限频 10 次/分钟/IP；单篇最多转存 30 张图、单图 ≤ 25MB、正文 ≤ ~900KB。编辑器插件「采集公众号文章」调用（见 docs/PLUGINS.md） |

### 外部发布（管理）
| 方法 | 路径 | 说明 |
| --- | --- | --- |
| POST | `/api/admin/external/token` | 生成并保存新的开放 API Token（旧的立即失效），返回 `{ok, token}` |
| POST | `/api/admin/external/telegram/webhook` | 校验 Bot Token（getMe）→ 首次自动生成 Webhook 密钥 → 调 Telegram setWebhook；返回 `{ok, bot:"@name", webhookUrl}`。需先通过设置接口保存 `telegramBotToken` |

外部发布相关设置键（可经 `PUT /api/admin/settings` 写入）：`externalToken`（开放 API 密钥，空 = 接口关闭，建议用上面的专用端点生成）、`telegramBotToken`、`telegramAllowFrom`（逗号分隔的 Chat ID 白名单）、`telegramWebhookSecret`（Webhook 密钥，建议由专用端点自动生成）、`notifyNewComment`（`1`/`0`，新留言推送到 Telegram，目标为白名单第一个 Chat ID）。

### 备份 / 数据导出
| 方法 | 路径 | 说明 |
| --- | --- | --- |
| POST | `/api/admin/backup` | 手动触发一次全量备份（与每晚 Cron 同一逻辑）：全部业务表导成 JSON 存进 R2 `backups/` 目录，返回 `{ok, key, bytes}`（开关关闭时 `skipped:true`）。结果同时写入设置 `lastBackupAt` / `lastBackupKey` / `lastBackupBytes`。Cron 由 wrangler.jsonc `triggers.crons` 配置（北京时间 00:30），失败时经 Telegram 提醒站长 |
| GET | `/api/admin/export/markdown` | 下载 Markdown 包 zip：`posts/*.md`（YAML front-matter 含 title/slug/date/status/tags/category/cover/summary，正文 HTML→MD）、`weibo.md`、`pages/*.md`、`images/…`（正文/封面/微博引用的站内图，从 R2 流式打包）、`manifest.json`（含 missingImages 清单）。未被引用的图床文件不打包 |
| GET | `/api/admin/export/wxr` | 下载 WordPress WXR 1.2 单文件：文章（HTML 正文、publish/draft 状态、分类与标签），供 WordPress / emlog 导入器使用；微博不进 WXR |

### GET /api/meta/themes
已注册主题列表 `{themes:[{id,name,description,colors}]}`，`colors` 为后台皮肤卡预览色板（`[背景, 强调条, 卡面, 卡面2, 卡面3]`，未设置时为 `null`）。

### GET /api/admin/members?page=1&q=
会员列表（后台「会员」页数据源）：`{items:[{id, username, email, tier, points, status, created_at, last_login_at}], total, page, totalPages}`；`q` 模糊匹配用户名 / 邮箱，20 条/页。

### PUT /api/admin/members/:id
改档位 / 封禁，**缺键即保留**（只传要改的键）：`{ "tier": "normal|coffee|top" }` 或 `{ "status": "active|banned" }` → `{ok:true}`；`status:"banned"` 同时清空该会员全部会话（即刻踢下线），历史评论保留。会员不存在 404。

## 外部接口（Token 鉴权，供 Telegram 机器人 / 第三方工具调用）

鉴权方式二选一（只认请求头，避免 Token 进访问日志）：`Authorization: Bearer <token>` 或 `X-Auth-Token: <token>`。Token 在后台「设置 → 外部发布」生成，空 Token = 接口关闭。

### GET /api/external/weibo
连通性测试，返回 `{ok, site, usage}`。

### POST /api/external/weibo
发布一条微博。`Content-Type: application/json` 与 `multipart/form-data` 均可：

```json
{ "content": "文字，可含 #话题", "images": ["https://外链 或 /images/站内 或 data:image/…;base64,…"], "status": "published | draft" }
```

multipart 字段：`content`、`status`、`images`（文件，可重复；也接受图片地址字符串）。`status` 缺省为 `published`。

- 约束与后台一致：`content` ≤ 5000 字、图片 ≤ 9 张（JPG/PNG/WebP/GIF，上传文件 ≤ 25MB，存 R2）、文字与图片不能同时为空
- 返回 `{ok, id, url, status, images}`，`url` 形如 `https://站点/weibo?wb=<id>#wb-<id>`（`?wb=` 让 /weibo 服务端定位到该条所在页，锚点才能落到具体那条微博）
- 错误：401 无效 Token；422 内容为空 / 图片超限 / 格式不支持；429 限频（30 次/分钟/Token）
- 话题不接受直传，服务端从正文提取（同微博管理接口）

### POST /api/telegram/webhook
Telegram Bot API 的 Webhook 接收端，由 Telegram 服务器调用（校验 `X-Telegram-Bot-Api-Secret-Token` 请求头，密钥由后台一键设置生成并经 setWebhook 的 `secret_token` 下发；旧的 `?secret=` 绑定方式仍兼容，重新点一次「一键设置 Webhook」即切换为纯 header）。行为：

- 白名单外会话：回复其 Chat ID 与授权提示，不落库；`/start`、`/help` 回复使用说明
- 文字 / 图片 / 图片+caption（白名单会话）→ 发布为微博，图片经 Bot API 下载后转存 R2；成功后回复微博链接
- 相册（同 `media_group_id`）缓冲合并为一条微博（缓冲表 `tg_buffer`，几秒无新图即发布）
- `/draft 文字` 存草稿；其余指令回复可用指令说明
- 限频 20 次/分钟/Chat

## HTML 白名单（净化器摘要）

- 保留：`p br hr h1-h6 blockquote pre code ul ol li a img video source strong b em i u s del ins mark sup sub small span section div figure figcaption table thead tbody tfoot tr th td caption details summary abbr cite q kbd samp wbr`
- 丢弃（连同内容）：`script style iframe svg math form input button select textarea template link meta base object embed …`；`id` 属性一律剥除（防 DOM clobbering）
- 唯一例外：`<meta data-og-image="/images/…">` 原样保留（编辑器生成的 OG 分享卡图标记，仅限站内路径）
- 链接仅允许 `http(s) / mailto / 站内相对 / #锚点`（校验前剥离 tab/换行，`jav&#9;ascript:` 之类混淆无法绕过）；`data:`/`javascript:` 一律拒绝
- 内联样式仅保留排版属性（颜色/字号/行高/间距/边框/对齐等）；`url()` 只接受站内 `/` 开头路径；`!important` 被剥除
- 规范属性 `data-w / data-ignore-width / data-no-dark / data-ignore-dm` 原样保留；`data-link-card="link-card"` 为编辑器「链接卡片」结构标记（src/linkmeta.ts），只认该固定值，其余值剥除
