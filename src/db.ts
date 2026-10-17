import type {
  CategoryRow,
  CommentRow,
  FriendLinkRow,
  MemberRow,
  PageRow,
  PostRow,
  SettingsMap,
  WeiboRow,
} from './types'
import { NICKNAME_CHANGE_COOLDOWN_MS } from './utils'

/** 排行榜行（listRankTop）：对外只给昵称口径需要的最小字段 */
export interface RankMemberRow {
  id: number
  username: string
  display_name: string
  avatar: string
  tier: MemberRow['tier']
  points: number
}
import { clampInt, cstDate, excerpt, fmtDate, jsonItemLikePattern, likePattern, WEIBO_MAX_TOPICS } from './utils'

export const DEFAULT_SETTINGS: Record<string, string> = {
  siteName: '博客号 BlogHao',
  siteDescription: '微信有公众号，你有博客号。想写就写，一切都归你。',
  theme: 'wechat',
  // 站点模式：blog-weibo（博客+微博，博客优先，默认）/ weibo-blog（微博+博客，微博优先）/
  // blog（纯博客）/ weibo（纯微博）——前台模块显隐与首页优先级，见 src/render.ts siteMode()
  siteMode: 'blog-weibo',
  // 站点可见窗口（朋友圈式 N 天可见）：'' = 全部可见（默认，老站零打扰）；'3d'/'1m'/'6m'/'1y' =
  // 窗口外内容对游客/会员不可见（列表/直链/搜索/RSS/sitemap 全面收口），后台与备份不受影响。
  // 档位白名单与窗口天数唯一来源 utils.LIST_RANGES，校验在 api.ts 设置 PUT
  contentVisibleRange: '',
  siteUrl: '',
  // 主题外观变量（B9 · 内测）：扁平 JSON（角色键 → 色值 + font/fontSize），渲染期按当前主题
  // 映射回主题自己的 CSS 变量输出覆盖样式，空串 = 未配置，机制见 src/appearance.ts
  appearance: '',
  // 皮肤包自定义 CSS（B8，机制 src/skinpack.ts）：样式安检门净化后进 <style data-custom-css>，
  // 空串 = 未配置；皮肤包应用 = appearance + customCss 两键一起写，无独立存储
  customCss: '',
  // 页脚「站点足迹」统计 JSON（{posts,chars,since}）：每晚 cron 刷新 + 冷启动首次播种
  // （refreshFootStats），前台页脚名片读这里——展示口径滞后一夜可接受，不值得每次渲染都聚合
  siteFoot: '',
  // 页面边缘缓存的代序号（src/pagecache.ts）：saveSettings 自动换新，后台「一键清理缓存」显式写
  pageCacheEpoch: '',
  footerText: '由 博客号 驱动 · 住在 Cloudflare 上',
  allowComments: '1',
  moderateComments: '0',
  // 评论 IP 属地展示开关（src/ipregion.ts）：采集无条件（写库定格 request.cf 快照），
  // 此开关只管前台展示——关闭时连公开出参都不带；开启前的旧评论无属地，不追溯回填
  showCommentRegion: '0',
  postsPerPage: '10',
  about: '<p>在这里写下关于你的故事。</p>',
  faviconUrl: '',
  avatarUrl: '',
  // 分享到社交平台的默认卡图（og:image 兜底；文章未设封面/卡图时使用，空则回退内置 /og-default.png）
  ogImageDefault: '',
  // 站长 SEO（B20，机制 src/seo.ts）：站点验证 meta（结构化 JSON，name 走白名单）/ 统计脚本
  // （https 脚本 URL 或 provider 片段，解析成结构化属性重放，内联脚本体不接受）/ robots.txt 追加段
  verifyMetas: '',
  analyticsScript: '',
  robotsExtra: '',
  // AI 抓取策略（2026-10-17，机制 src/seo.ts + src/bots.ts）：训练型拒绝 / 检索引用型放行的声明，
  // 写进 robots.txt（AI 爬虫独立 User-agent 组 + Content-signal 行）。
  //  'allow' 全部允许（默认，输出与历史逐字节一致，老站无此键行为不变）
  //  'seek'  只许检索引用、不许训练（推荐）
  //  'deny'  所有 AI 爬虫一律拒绝
  aiPolicy: 'allow',
  // 外部发布（见 src/external.ts）：空 Token  则 开放接口关闭
  externalToken: '',
  telegramBotToken: '',
  telegramAllowFrom: '',
  telegramWebhookSecret: '',
  // 有新留言/评论时推送到 Telegram（目标为白名单第一个 Chat ID）
  notifyNewComment: '1',
  // RSS 输出全文（关闭则只输出摘要）
  rssFullText: '1',
  // 每晚凌晨自动备份 D1 到 R2 的 backups/ 目录
  backupEnabled: '1',
  // 访客统计采集开关（后台「统计」页；关闭后前台不打点，见 src/stats.ts）
  statsEnabled: '1',
  // 编辑器插件停用名单（后台「插件」页；逗号分隔的 manifest id，空 = 全部启用）。
  // 书影音卡片（douban-media，个人定制插件）默认停用：豆瓣详情从数据中心 IP 取评分
  // 不稳定，等有更稳的数据路子再默认启用——后台「插件」页一键开启
  pluginsDisabled: 'douban-media',
  // 服务端插件停用名单（后台「插件」页；逗号分隔的插件 id，空 = 全部启用，见 src/hooks.ts）
  serverPluginsDisabled: '',
  // 服务端插件配置（统一通道）：JSON { 插件id: { 字段键: 值 } }，按 hooks.ts 各插件
  // configFields 渲染表单，PUT 过 cleanServerPluginConfig 净化校验——插件要配置不必塞专属键
  serverPluginConfig: '',
  // 服务端插件配置：发布同步 TG 频道的频道 ID / 评论 Webhook 地址 / 页脚自定义 HTML（src/hooks.ts）
  tgChannelChatId: '',
  commentWebhookUrl: '',
  footerHtmlCode: '',
  // 服务端插件「微博同步 Buffer」：Buffer API Key 与目标渠道 ID（X 等，设置页可一键拉取，src/hooks.ts）
  bufferAccessToken: '',
  bufferChannelId: '',
  // 服务端插件「广场同步」：广场 hub 地址（默认官方 https://bloghao.com/plaza）与站点注册 token（src/hooks.ts，docs/PLAZA.md）
  plazaEndpoint: 'https://bloghao.com/plaza',
  plazaToken: '',
  // 一键灰度（哀悼/纪念模式）：所有公开页 CSS 去色，见 src/render.ts page()
  siteGrayscale: '0',
  // 一键闭站：公开页面与公开 API 全部 503，仅后台/登录/图床可用（src/index.ts 闭站中间件）
  siteClosed: '0',
  // 闭站页公告文案，空 = 使用内置默认文案
  siteClosedMessage: '',
  // 全站 noindex（2026-10 SEO 审计）：所有公开页 <meta name="robots" content="noindex"> +
  // robots.txt 整站 Disallow——用于空白模板站 / 演示性镜像 / 临时预览实例不进搜索引擎索引；
  // 与闭站不同：页面照常可访问，只是不让收录。默认关闭（正常收录）
  siteNoindex: '0',
  // 会员体系总开关（契约见 docs/DEVPLAN-2026-10-07.md 附录 A）：关闭时前台无会员入口、/api/member/* 返回 404
  membersEnabled: '0',
  // 排行榜展示条数上限（/rank 页与首页挂件共用，1-50）
  rankTopN: '10',
  // 注册人机验证（Cloudflare Turnstile，A2 根治）：两键成对填写才启用（PUT 校验成对），都留空 = 关闭；
  // Secret 属敏感键（api.ts SECRET_SETTINGS 打码），sitekey 是公开值、随 /member 页下发给 site.js
  turnstileSiteKey: '',
  turnstileSecret: '',
  // 英文测试版（内部代号 English 0.1，见 src/i18n.ts）：edition 是后台可切的语言版本；
  // editionEnStatus 是运行状态（active 正常 / fallback 渲染异常已自动回退中文，重新开启时重置）
  edition: 'zh',
  editionEnStatus: 'active',
  // 英文版最近一次异常的错误摘要与发生时间（后台横幅展示，仅记录，渲染层不读）
  editionEnError: '',
  editionEnAt: '',
  // 新手引导记账位（后台概览页清单卡）：仅 /api/auth/setup 首装成功时播种 '1'（api.ts），
  // 老站没有此键 = 永不显示引导卡；'0' = 已完成/已跳过，永久消失。onboardingManual 是
  // 「打开使用手册」的点击记账。两键都进 BOOL_SETTINGS 归一化，后台设置页保存全部不含它们
  onboarding: '',
  onboardingManual: '',
}

/** 敏感设置键：GET / PUT 响应一律打码（api.ts），整站包导出整体跳过（sitebundle.ts）。
 *  唯一来源就在这里——新增敏感键只改这张表，别在别处再抄一份（曾因清单分叉漏打码）。
 *  明文只在生成时返回一次；打码占位符提交 = 保留原值（同 SECRET_SETTINGS 口径） */
export const SECRET_SETTINGS = [
  'externalToken',
  'telegramBotToken',
  'telegramWebhookSecret',
  'bufferAccessToken',
  'plazaToken',
  'commentWebhookUrl',
  'turnstileSecret',
]

// settings 读取的共享快照层（Cache API）：生产 Workers 上 caches.default 是 colo 级共享——
// 跨 isolate 同读一份快照，热读省掉每次请求的 D1 查询；写路径 invalidateSharedSettings
// 推送式 delete（全 colo 立即失效，写返回后任何 isolate 读必见新值，无 TTL 旧值窗口）。
// Node 测试与 docker-poc 无 caches.default，自动退化为直查（后者单进程天然一致，语义不变）；
// 并发请求按 in-flight 去重（突发流量只打一发 SQL），按 db 实例（WeakMap）隔离防多站点串租户。
// 一切写 settings 的路径写完必须 await invalidateSharedSettings(db)：saveSettings /
// refreshFootStats / ensureSchema 已内置，散落 db.ts 之外的裸写点（setupLock /
// recordEditionFailure / demo 播种）各自负责——见 AGENTS「SQL / 输入」防线。
const SETTINGS_SHARED_URL = 'https://xwblog-internal.invalid/__settings-snapshot'
// 60s（2026-10-15 审计 F1 止血）：快照键无实例维度，跨部署串设置的暴露窗口随 TTL 走——
// 压到 1 分钟热读收益基本不损（一分钟内同 isolate/同 colo 仍免 D1），窗口缩到原来的 1/5。
// 键带实例维度的完整修复需 host 穿过 getSettings/invalidateSharedSettings 调用链，见审计报告
const SETTINGS_SHARED_TTL_S = 60
const settingsInflight = new WeakMap<object, Promise<SettingsMap>>()

function sharedCache(): Cache | null {
  const c = (globalThis as { caches?: { default?: Cache } }).caches
  return c?.default ?? null
}

/** 写 settings 后调用（await）：清共享快照，写返回后全 colo 读必见新值 */
export async function invalidateSharedSettings(db: D1Database): Promise<void> {
  settingsInflight.delete(db)
  const cache = sharedCache()
  if (cache) {
    try {
      await cache.delete(SETTINGS_SHARED_URL)
    } catch {
      /* 共享层删不掉就等 max-age 过期，不挡写路径 */
    }
  }
}

export async function getSettings(db: D1Database): Promise<SettingsMap> {
  const inflight = settingsInflight.get(db)
  if (inflight) return inflight
  const p = (async () => {
    const cache = sharedCache()
    if (cache) {
      try {
        const hit = await cache.match(SETTINGS_SHARED_URL)
        if (hit) {
          const data = (await hit.json()) as Record<string, string> | null
          if (data) return { ...DEFAULT_SETTINGS, ...data }
        }
      } catch {
        /* 快照读不出来按 miss 走 D1 */
      }
    }
    const { results } = await db
      .prepare('SELECT key, value FROM settings')
      .all<{ key: string; value: string }>()
    const s: SettingsMap = { ...DEFAULT_SETTINGS }
    for (const r of results ?? []) s[r.key] = r.value
    if (cache) {
      try {
        await cache.put(
          SETTINGS_SHARED_URL,
          new Response(JSON.stringify(s), { headers: { 'Cache-Control': `public, max-age=${SETTINGS_SHARED_TTL_S}` } })
        )
      } catch {
        /* 回填失败不影响本次读 */
      }
    }
    return s
  })()
  settingsInflight.set(db, p)
  try {
    return await p
  } finally {
    settingsInflight.delete(db)
  }
}

export async function saveSettings(db: D1Database, patch: SettingsMap): Promise<void> {
  // 设置一变全站页面渲染跟着变：顺手换页缓存 epoch（src/pagecache.ts），旧边缘副本整代作废。
  // 调用方显式带了 epoch（purgePageCache）就原样落库；没带则读旧值与 now 取 max(old+1)——
  // 同一毫秒内连续保存也保证严格递增（测试与失效语义都依赖这点）
  let epoch = patch[PAGE_CACHE_EPOCH_KEY]
  if (epoch === undefined) {
    const prev = await db.prepare(`SELECT value FROM settings WHERE key = '${PAGE_CACHE_EPOCH_KEY}'`).first<{ value: string }>()
    epoch = prev?.value ? String(Math.max(Date.now(), Number(prev.value) + 1)) : String(Date.now())
  }
  const entries = Object.entries({ ...patch, [PAGE_CACHE_EPOCH_KEY]: epoch })
  if (!entries.length) return
  const stmts = entries.map(([k, v]) =>
    db
      .prepare(
        'INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value'
      )
      .bind(k, String(v ?? ''))
  )
  await db.batch(stmts)
  await invalidateSharedSettings(db)
}

export function parseTags(row: Pick<PostRow, 'tags'>): string[] {
  try {
    const a = JSON.parse(row.tags || '[]')
    return Array.isArray(a)
      ? a.filter((x: unknown) => typeof x === 'string' && x.trim()).map((x: string) => x.trim()).slice(0, 8)
      : []
  } catch {
    return []
  }
}

/** 文章正文长度上限（UTF-8 字节，非字符数）：api.ts readPostPayload 与 mcp.ts publish_post 同口径 */
export const MAX_CONTENT_BYTES = 1_000_000

/** 页面边缘缓存的代序号（src/pagecache.ts）：进缓存键，换新 = 旧边缘副本整代作废。
 *  saveSettings 每次保存自动换新（改设置全站页面即刻失效），后台「一键清理缓存」也写这键 */
export const PAGE_CACHE_EPOCH_KEY = 'pageCacheEpoch'

export type PostSort = 'latest' | 'views' | 'likes' | 'comments' | 'random'

export interface ListPostsOptions {
  status?: 'published' | 'draft' | 'scheduled' | 'all'
  q?: string
  tag?: string
  categorySlug?: string
  page?: number
  limit?: number
  /** 前台列表排序：latest 置顶优先最新在前；random 需配 seed 保证翻页不重洗 */
  sort?: PostSort
  seed?: number
  /** 后台时间范围筛选：只出 COALESCE(published_at, created_at) >= afterTs 的行（0/缺省 = 不过滤）。
   *  值由 api.ts 用 utils.listRangeCutoff 从白名单语义值算出，客户端不供给时间戳 */
  afterTs?: number
}

export interface ListPostsResult {
  items: PostRow[]
  total: number
  page: number
  totalPages: number
}

export async function listPosts(db: D1Database, opts: ListPostsOptions = {}): Promise<ListPostsResult> {
  const page = clampInt(opts.page, 1, 1000, 1)
  const limit = clampInt(opts.limit, 1, 100, 10)
  const where: string[] = ['deleted_at IS NULL'] // 回收站过滤：公开面与后台列表都不展示已删行（回收站走 src/trash.ts 自己的查询）
  const binds: unknown[] = []

  if (opts.status && opts.status !== 'all') {
    where.push('status = ?')
    binds.push(opts.status)
  }
  if (opts.q) {
    // \% \_ 是字面转义，\ 本身必须先转义成 \\：声明了 ESCAPE '\' 后，搜「a\b」「尾随\」才不跑偏
    where.push("(title LIKE ? ESCAPE '\\' OR summary LIKE ? ESCAPE '\\' OR content LIKE ? ESCAPE '\\')")
    binds.push(likePattern(opts.q), likePattern(opts.q), likePattern(opts.q))
    // 加密文章整体退出关键词搜索：content LIKE 命中本身就会泄露「正文含此词」，可被用来探测加密内容
    where.push("(password_hash IS NULL OR password_hash = '')")
  }
  if (opts.tag) {
    where.push("tags LIKE ? ESCAPE '\\'")
    binds.push(jsonItemLikePattern(opts.tag))
  }
  if (opts.categorySlug) {
    where.push('id IN (SELECT post_id FROM post_categories WHERE category_id IN (SELECT id FROM categories WHERE slug = ?))')
    binds.push(opts.categorySlug)
  }
  // 后台时间范围筛选：谓词落在排序键 COALESCE(published_at, created_at) 上——与 idx_posts_feed 表达式同形，可作索引范围约束
  if (opts.afterTs && opts.afterTs > 0) {
    where.push('COALESCE(published_at, created_at) >= ?')
    binds.push(opts.afterTs)
  }
  const whereSql = where.length ? 'WHERE ' + where.join(' AND ') : ''
  const recency = 'COALESCE(published_at, created_at) DESC'
  // 随机排序用 (id+seed) 乘法散列：同一 seed 下全站顺序固定，翻页不重洗；换 seed 即换一组
  // sort=comments 的相关子查询 INDEXED BY 是防读放大关键：规划器误选 idx_comments_status 时
  // 逐篇全表扫评论，生产实测单次渲染 50 万行读取（tests/feed-index.test.ts 守卫）
  const orderSql =
    opts.status === 'draft'
      ? 'ORDER BY updated_at DESC'
      : opts.sort === 'views'
        ? `ORDER BY views DESC, ${recency}`
        : opts.sort === 'likes'
          ? `ORDER BY likes DESC, ${recency}`
          : opts.sort === 'comments'
            ? `ORDER BY (SELECT COUNT(*) FROM comments cm INDEXED BY idx_comments_post WHERE cm.post_id = posts.id AND cm.status = 'approved') DESC, ${recency}`
            : opts.sort === 'random'
              ? `ORDER BY ((posts.id + ${clampInt(opts.seed, 1, 999999999, 1)}) * 2654435761) % 4294967296 ASC, posts.id ASC`
              : `ORDER BY pinned DESC, ${recency}`

  const [itemsRes, countRes] = await Promise.all([
    db
      .prepare(`SELECT * FROM posts ${whereSql} ${orderSql} LIMIT ? OFFSET ?`)
      .bind(...binds, limit, (page - 1) * limit)
      .all<PostRow>(),
    db
      .prepare(`SELECT COUNT(*) AS n FROM posts ${whereSql}`)
      .bind(...binds)
      .first<{ n: number }>(),
  ])
  const total = countRes?.n ?? 0
  return { items: itemsRes.results ?? [], total, page, totalPages: Math.max(1, Math.ceil(total / limit)) }
}

export async function getPostBySlug(db: D1Database, slug: string): Promise<PostRow | null> {
  // 回收站过滤：文章页与公开评论接口靠 status 兜底判可见性，已删行必须查不到（否则软删后照常渲染）
  return db.prepare('SELECT * FROM posts WHERE slug = ? AND deleted_at IS NULL').bind(slug).first<PostRow>()
}

export async function getPostById(db: D1Database, id: number): Promise<PostRow | null> {
  // 不含 deleted_at 过滤：后台编辑/恢复按 id 直取，回收站行也可见
  return db.prepare('SELECT * FROM posts WHERE id = ?').bind(id).first<PostRow>()
}

/** 后台文章出参：password_hash 永不出接口（明文不可逆，哈希也不该喂给前端），只给 hasPassword 布尔。
 *  放 db.ts 让 api.ts 与 collect.ts（采集草稿响应）共用同一出口，新出参一律过这里 */
export function postAdminView(row: PostRow & { tagList?: string[]; categoryId?: number | null }) {
  return { ...row, password_hash: undefined, hasPassword: !!row.password_hash }
}

/** slug 查重公共件：posts / pages 同一套「占用即加后缀」探测（categories 是重名即拒绝语义，不走这里）。
 *  table 只来自下方两个包装函数的字面量，无注入面。
 *  故意不过滤 deleted_at：回收站行继续占用 slug，恢复时不会撞上后来新建的同名 slug */
async function uniqueSlugIn(db: D1Database, table: 'posts' | 'pages', base: string, excludeId?: number): Promise<string> {
  let slug = base
  for (let i = 2; i < 100; i++) {
    const row = await db.prepare(`SELECT id FROM ${table} WHERE slug = ?`).bind(slug).first<{ id: number }>()
    if (!row || row.id === excludeId) return slug
    slug = `${base}-${i}`
  }
  return `${base}-${Date.now().toString(36)}`
}

export async function uniqueSlug(db: D1Database, base: string, excludeId?: number): Promise<string> {
  return uniqueSlugIn(db, 'posts', base, excludeId)
}

export async function listApprovedComments(db: D1Database, postId: number): Promise<CommentRow[]> {
  // LEFT JOIN members 带会员徽标数据（member_id = 0 的游客行为 NULL），渲染层按契约 DEVPLAN 附录 A 消费；
  // member_avatar 仅供评论头像位展示（QQ 号本体永不出参，头像已站内转存）
  const { results } = await db
    .prepare(
      'SELECT c.*, m.display_name AS member_name, m.tier AS member_tier, m.avatar AS member_avatar FROM comments c LEFT JOIN members m ON m.id = c.member_id WHERE c.post_id = ? AND c.status = ? ORDER BY c.created_at ASC LIMIT 500'
    )
    .bind(postId, 'approved')
    .all<CommentRow>()
  return results ?? []
}

/** 留言板（/guestbook）：post_id 与 weibo_id 都为 0 的评论即留言板留言 */
export async function listGuestbookComments(db: D1Database): Promise<CommentRow[]> {
  const { results } = await db
    .prepare(
      "SELECT c.*, m.display_name AS member_name, m.tier AS member_tier, m.avatar AS member_avatar FROM comments c LEFT JOIN members m ON m.id = c.member_id WHERE c.post_id = 0 AND c.weibo_id = 0 AND c.status = 'approved' ORDER BY c.created_at ASC LIMIT 500"
    )
    .all<CommentRow>()
  return results ?? []
}

/** 文章归档（/archives）：全部已发布文章的标题与时间，按时间倒序（上限 2000 篇） */
export async function listAllPublishedArchives(db: D1Database): Promise<{ slug: string; title: string; ts: number }[]> {
  const { results } = await db
    .prepare(
      "SELECT slug, title, COALESCE(published_at, created_at) AS ts FROM posts WHERE status = 'published' AND deleted_at IS NULL ORDER BY ts DESC LIMIT 2000"
    )
    .all<{ slug: string; title: string; ts: number }>()
  return results ?? []
}

/** 归档页「今年已写」统计：当前北京时间年份的已发布篇数与正文字符量。
 * LENGTH() 对 TEXT 计字符数，含 Markdown 标记——展示口径用「约」；年份聚合按惯例 +28800 取北京墙上年 */
export async function yearArchiveStats(db: D1Database): Promise<{ count: number; chars: number }> {
  const year = String(cstDate(Date.now()).getUTCFullYear())
  const row = await db
    .prepare(
      "SELECT COUNT(*) AS n, COALESCE(SUM(LENGTH(content)), 0) AS c FROM posts WHERE status = 'published' AND deleted_at IS NULL AND strftime('%Y', COALESCE(published_at, created_at) / 1000 + 28800, 'unixepoch') = ?"
    )
    .bind(year)
    .first<{ n: number; c: number }>()
  return { count: row?.n ?? 0, chars: row?.c ?? 0 }
}

/** 归档页创作热力图数据：过去一年（约 366 天）按北京日聚合的已发布篇数。
 * 只返回有文章的日期（空日由渲染端补零），total 为合计；日聚合按惯例 +28800 取北京墙上年月日 */
export async function postHeatmap(db: D1Database): Promise<{ days: { day: string; count: number }[]; total: number }> {
  const since = Date.now() - 366 * 86_400_000
  const { results } = await db
    .prepare(
      "SELECT strftime('%Y-%m-%d', COALESCE(published_at, created_at) / 1000 + 28800, 'unixepoch') AS day, COUNT(*) AS n FROM posts WHERE status = 'published' AND deleted_at IS NULL AND COALESCE(published_at, created_at) >= ? GROUP BY day"
    )
    .bind(since)
    .all<{ day: string; n: number }>()
  const days = (results ?? []).map((r) => ({ day: r.day, count: r.n }))
  return { days, total: days.reduce((sum, d) => sum + d.count, 0) }
}

/** 相邻文章（PostData.prev / next）：prev = 更早一篇、next = 更新一篇，口径与列表一致（published、未删）；
 * 锚点用 COALESCE(published_at, created_at)，与归档分组同口径 */
export async function adjacentPosts(
  db: D1Database,
  ts: number,
  id: number,
  afterTs = 0
): Promise<{ prev: { slug: string; title: string } | null; next: { slug: string; title: string } | null }> {
  // 可见窗口开启时邻居导航不得指向窗口外文章（点了就是 404 的死链）
  const vis = afterTs > 0 ? 'AND COALESCE(published_at, created_at) >= ?' : ''
  const binds = (args: unknown[]) => (afterTs > 0 ? [...args, afterTs] : args)
  const where = "FROM posts WHERE status = 'published' AND deleted_at IS NULL AND id != ? AND COALESCE(published_at, created_at)"
  const [prev, next] = await Promise.all([
    db
      .prepare(`SELECT slug, title ${where} < ? ${vis} ORDER BY COALESCE(published_at, created_at) DESC LIMIT 1`)
      .bind(...binds([id, ts]))
      .first<{ slug: string; title: string }>(),
    db
      .prepare(`SELECT slug, title ${where} > ? ${vis} ORDER BY COALESCE(published_at, created_at) ASC LIMIT 1`)
      .bind(...binds([id, ts]))
      .first<{ slug: string; title: string }>(),
  ])
  return { prev: prev ?? null, next: next ?? null }
}

/** sitemap 用的轻量列表：slug + updated_at（不走 listPosts——它的 limit 被 clamp 到 100） */
export async function listSitemapPosts(db: D1Database, afterTs = 0): Promise<{ slug: string; updated_at: number }[]> {
  // 可见窗口开启时窗口外文章不进 sitemap（前台 404 的页面不提交搜索引擎）
  const vis = afterTs > 0 ? 'AND COALESCE(published_at, created_at) >= ?' : ''
  const stmt = db.prepare(
    `SELECT slug, updated_at FROM posts WHERE status = 'published' AND deleted_at IS NULL ${vis} ORDER BY updated_at DESC LIMIT 2000`
  )
  const { results } = await (afterTs > 0 ? stmt.bind(afterTs) : stmt).all<{ slug: string; updated_at: number }>()
  return results ?? []
}

/** sitemap 用：每个分类下已发布文章的最新更新时间（分类归档页的 lastmod） */
export async function listSitemapCategoryLastmod(db: D1Database): Promise<{ slug: string; lastmod: number }[]> {
  const { results } = await db
    .prepare(
      `SELECT c.slug, MAX(p.updated_at) AS lastmod
       FROM post_categories pc
       JOIN posts p ON p.id = pc.post_id
       JOIN categories c ON c.id = pc.category_id
       WHERE p.status = 'published' AND p.deleted_at IS NULL
       GROUP BY c.slug`
    )
    .all<{ slug: string; lastmod: number }>()
  return results ?? []
}

/** sitemap 用：最新一条已发布微博的时间（/weibo 页的 lastmod） */
export async function listWeiboLastmod(db: D1Database): Promise<number> {
  const row = await db
    .prepare("SELECT MAX(COALESCE(published_at, created_at)) AS ts FROM weibo WHERE status = 'published' AND deleted_at IS NULL")
    .first<{ ts: number | null }>()
  return row?.ts ?? 0
}

/** 已发布文章用到的标签聚合（导航菜单用），按使用次数倒序 */
export async function listPublishedTags(db: D1Database): Promise<{ name: string; count: number }[]> {
  const { results } = await db
    .prepare("SELECT tags FROM posts WHERE status = 'published' AND deleted_at IS NULL LIMIT 1000")
    .all<{ tags: string }>()
  const count = new Map<string, number>()
  for (const r of results ?? []) {
    for (const t of parseTags({ tags: r.tags } as PostRow)) count.set(t, (count.get(t) || 0) + 1)
  }
  return [...count.entries()]
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .slice(0, 100)
    .map(([name, count]) => ({ name, count }))
}

/* ---------------- 历史上的今天（首页时光机卡） ---------------- */

export interface OnThisDayItem {
  kind: 'post' | 'weibo'
  /** 跳转地址：/post/:slug 或 /weibo?wb=:id#wb-:id（?wb= 让 /weibo 定位到所在页） */
  href: string
  /** 展示文本：文章标题 / 微博正文摘要 */
  text: string
  /** 往年今日的整年时间戳 */
  ts: number
  /** 距今几年（1 = 去年） */
  yearsAgo: number
}

export interface OnThisDayRow {
  key: string
  title: string
  content: string
  images: string
  /** 微博视频 JSON 列（B19）：无正文时给「发了一段视频」兜底文案用；posts 侧恒为空串 */
  video: string
  ts: number
}

/** 把毫秒时间戳按北京时间的口径取月-日/年（+8h 与前台展示一致，0-8 点发布不跨天） */
const ON_THIS_DAY_MD = "strftime('%m-%d', COALESCE(published_at, created_at) / 1000 + 28800, 'unixepoch')"
const ON_THIS_DAY_Y = "CAST(strftime('%Y', COALESCE(published_at, created_at) / 1000 + 28800, 'unixepoch') AS INTEGER)"

/** 单侧候选上限：防异常数据（如整包导入的同日内容）拖爆返回集，合并后还会再截 ON_THIS_DAY_MAX */
const ON_THIS_DAY_SOURCE_LIMIT = 200
/** 最终保留条数上限：卡片直出前几条，其余进「展开」折叠区 */
export const ON_THIS_DAY_MAX = 100

/**
 * 纯函数：两路查询结果 → 剔空、合并、按时间倒序、封顶。
 * 与 SQL 拆开以便单测覆盖合并口径；nowTs 传查询时刻（毫秒），用于算 yearsAgo。
 */
export function buildOnThisDayItems(postRows: OnThisDayRow[], weiboRows: OnThisDayRow[], nowTs: number): OnThisDayItem[] {
  // 年份口径与 SQL 侧 +28800 一致，走 cstDate 统一北京时间换算
  const thisYear = cstDate(nowTs).getUTCFullYear()
  const items: OnThisDayItem[] = []
  for (const r of postRows) {
    items.push({ kind: 'post', href: `/post/${r.key}`, text: r.title, ts: r.ts, yearsAgo: thisYear - cstDate(r.ts).getUTCFullYear() })
  }
  for (const r of weiboRows) {
    const imgs = weiboImageList(r)
    // 无正文时给媒体兜底文案：与首页微博入口卡同口径（视频优先，其次配图数；B19）
    const text = r.content.trim() || (weiboVideoView(r) ? '发了一段视频' : imgs.length ? `发了 ${imgs.length} 张图` : '')
    if (!text) continue
    items.push({ kind: 'weibo', href: `/weibo?wb=${r.key}#wb-${r.key}`, text: excerpt(text, 64), ts: r.ts, yearsAgo: thisYear - cstDate(r.ts).getUTCFullYear() })
  }
  return items.sort((a, b) => b.ts - a.ts).slice(0, ON_THIS_DAY_MAX)
}

/**
 * 往年今日已发布的内容：文章 + 微博合并，时间倒序全量返回（封顶 ON_THIS_DAY_MAX）。
 * 只匹配更早的年份（今年的今天不算），没有命中返回空数组；卡片折叠区负责承载多条目。
 * 结果按天做进程内缓存：首页每次渲染不必重复全表扫（数据变了最多延迟 10 分钟）。
 */
export async function listOnThisDay(db: D1Database): Promise<OnThisDayItem[]> {
  // 缓存 key 也按北京时间的日期翻日（fmtDate 即 +8h 口径）
  const dayKey = fmtDate(Date.now())
  if (otdCache && otdCache.day === dayKey && Date.now() - otdCache.at < 10 * 60_000) return otdCache.items
  // 两侧比较基准都要 +28800 对齐北京时间：'now' 是 UTC 墙钟，直接比会让北京 0-8 点匹配到「昨天」的历史
  const [postsRes, weiboRes] = await db.batch([
    db
      .prepare(
        `SELECT slug AS key, title, '' AS content, '' AS images, '' AS video, COALESCE(published_at, created_at) AS ts
         FROM posts
         WHERE status = 'published' AND deleted_at IS NULL AND ${ON_THIS_DAY_MD} = strftime('%m-%d', 'now', '28800 seconds') AND ${ON_THIS_DAY_Y} < CAST(strftime('%Y', 'now', '28800 seconds') AS INTEGER)
         ORDER BY ts DESC LIMIT ${ON_THIS_DAY_SOURCE_LIMIT}`
      ),
    db
      .prepare(
        `SELECT id AS key, '' AS title, content, images, video, COALESCE(published_at, created_at) AS ts
         FROM weibo
         WHERE status = 'published' AND deleted_at IS NULL AND ${ON_THIS_DAY_MD} = strftime('%m-%d', 'now', '28800 seconds') AND ${ON_THIS_DAY_Y} < CAST(strftime('%Y', 'now', '28800 seconds') AS INTEGER)
         ORDER BY ts DESC LIMIT ${ON_THIS_DAY_SOURCE_LIMIT}`
      ),
  ])
  const items = buildOnThisDayItems(
    (postsRes.results ?? []) as unknown as OnThisDayRow[],
    (weiboRes.results ?? []) as unknown as OnThisDayRow[],
    Date.now()
  )
  otdCache = { day: dayKey, at: Date.now(), items }
  return items
}
let otdCache: { day: string; at: number; items: OnThisDayItem[] } | null = null


export async function relatedPosts(db: D1Database, post: PostRow, limit = 3, afterTs = 0): Promise<PostRow[]> {
  // 可见窗口开启时相关文章同样限定在窗口内（链接出去就是 404）
  const vis = afterTs > 0 ? 'AND COALESCE(published_at, created_at) >= ?' : ''
  const tail = (args: unknown[]) => (afterTs > 0 ? [...args, afterTs] : args)
  const tags = parseTags(post)
  if (tags.length) {
    // 与 listPosts 的标签过滤同口径：带 JSON 引号精确匹配 + ESCAPE，防「猫」命中「波斯猫」/通配符注入
    // 注意必须 join(' OR ')：数组直接内插会以逗号连接，(a,b) 构成 row value，D1 直接报 row value misused
    const likeBinds = tags.map(() => "tags LIKE ? ESCAPE '\\'").join(' OR ')
    const { results } = await db
      .prepare(
        `SELECT * FROM posts WHERE id != ? AND status = 'published' AND deleted_at IS NULL AND (${likeBinds}) ${vis} ORDER BY views DESC LIMIT ?`
      )
      .bind(...tail([post.id, ...tags.map((t) => jsonItemLikePattern(t))]), limit)
      .all<PostRow>()
    if ((results?.length ?? 0) > 0) return results ?? []
  }
  const { results } = await db
    .prepare(`SELECT * FROM posts WHERE id != ? AND status = 'published' AND deleted_at IS NULL ${vis} ORDER BY published_at DESC LIMIT ?`)
    .bind(...tail([post.id]), limit)
    .all<PostRow>()
  return results ?? []
}

/* ---------------- 分类 ---------------- */

export async function listCategories(db: D1Database, opts: { withCount?: boolean } = {}): Promise<(CategoryRow & { post_count?: number })[]> {
  if (opts.withCount) {
    // 计数滤掉回收站文章（含草稿是故意的：后台口径=已归类总量）；公开分类页不带计数，不受影响
    const { results } = await db
      .prepare(
        `SELECT c.*, COUNT(pc.post_id) AS post_count
         FROM categories c LEFT JOIN post_categories pc ON pc.category_id = c.id
           AND pc.post_id IN (SELECT id FROM posts WHERE deleted_at IS NULL)
         GROUP BY c.id ORDER BY c.sort ASC, c.id ASC`
      )
      .all<CategoryRow & { post_count: number }>()
    return results ?? []
  }
  const { results } = await db.prepare('SELECT * FROM categories ORDER BY sort ASC, id ASC').all<CategoryRow>()
  return results ?? []
}

export async function getCategoryBySlug(db: D1Database, slug: string): Promise<CategoryRow | null> {
  return db.prepare('SELECT * FROM categories WHERE slug = ?').bind(slug).first<CategoryRow>()
}

export async function getCategoryById(db: D1Database, id: number): Promise<CategoryRow | null> {
  return db.prepare('SELECT * FROM categories WHERE id = ?').bind(id).first<CategoryRow>()
}

export async function createCategory(db: D1Database, name: string, slug: string, sort = 0, description = ''): Promise<CategoryRow> {
  const res = await db
    .prepare('INSERT INTO categories (name, slug, sort, description, created_at) VALUES (?, ?, ?, ?, ?)')
    .bind(name, slug, sort, description, Date.now())
    .run()
  const row = await getCategoryById(db, Number(res.meta.last_row_id))
  if (!row) throw new Error('分类创建失败')
  return row
}

export async function setPostCategory(db: D1Database, postId: number, categoryId: number | null): Promise<void> {
  if (categoryId == null) {
    await db.prepare('DELETE FROM post_categories WHERE post_id = ?').bind(postId).run()
    return
  }
  await db
    .prepare('INSERT INTO post_categories (post_id, category_id) VALUES (?, ?) ON CONFLICT(post_id) DO UPDATE SET category_id = excluded.category_id')
    .bind(postId, categoryId)
    .run()
}

export async function getPostCategoryId(db: D1Database, postId: number): Promise<number | null> {
  const row = await db
    .prepare('SELECT category_id FROM post_categories WHERE post_id = ?')
    .bind(postId)
    .first<{ category_id: number }>()
  return row?.category_id ?? null
}

/* ---------------- 独立页面 ---------------- */

export async function listPages(db: D1Database, opts: { status?: 'published' } = {}): Promise<PageRow[]> {
  // 回收站过滤：导航/sitemap/后台页面列表都不展示已删行
  if (opts.status) {
    const { results } = await db
      .prepare('SELECT * FROM pages WHERE status = ? AND deleted_at IS NULL ORDER BY sort ASC, id ASC')
      .bind(opts.status)
      .all<PageRow>()
    return results ?? []
  }
  const { results } = await db.prepare('SELECT * FROM pages WHERE deleted_at IS NULL ORDER BY sort ASC, id ASC').all<PageRow>()
  return results ?? []
}

export async function getPage(db: D1Database, slug: string): Promise<PageRow | null> {
  // 回收站过滤：/about 与 /page/:slug 已删即 404（about 走 legacy settings 回退分支）
  return db.prepare('SELECT * FROM pages WHERE slug = ? AND deleted_at IS NULL').bind(slug).first<PageRow>()
}

export async function getPageById(db: D1Database, id: number): Promise<PageRow | null> {
  // 不含 deleted_at 过滤：后台编辑/恢复按 id 直取
  return db.prepare('SELECT * FROM pages WHERE id = ?').bind(id).first<PageRow>()
}

/** slug 查重（posts 同款递增后缀），excludeId 供编辑时排除自身 */
export async function uniquePageSlug(db: D1Database, base: string, excludeId?: number): Promise<string> {
  return uniqueSlugIn(db, 'pages', base, excludeId)
}

/** sitemap 用的已发布页面（含更新时间） */
export async function listSitemapPages(db: D1Database): Promise<{ slug: string; updated_at: number }[]> {
  const { results } = await db
    .prepare("SELECT slug, updated_at FROM pages WHERE status = 'published' AND deleted_at IS NULL")
    .all<{ slug: string; updated_at: number }>()
  return results ?? []
}

/** 批量取一组文章的分类名（后台列表展示用）：{postId: name} */
export async function categoryNameMap(db: D1Database, postIds: number[]): Promise<Map<number, string>> {
  if (!postIds.length) return new Map()
  const ph = postIds.map(() => '?').join(',')
  const { results } = await db
    .prepare(
      `SELECT pc.post_id, c.name FROM post_categories pc JOIN categories c ON c.id = pc.category_id WHERE pc.post_id IN (${ph})`
    )
    .bind(...postIds)
    .all<{ post_id: number; name: string }>()
  const m = new Map<number, string>()
  for (const r of results ?? []) m.set(r.post_id, r.name)
  return m
}

/* ---------------- 微博（随手记） ---------------- */

export const WEIBO_MAX_IMAGES = 9

/** 微博正文字数上限（后台发布器与外部发布 / Telegram 同口径） */
export const WEIBO_MAX_CHARS = 5000

/** 校验并规整微博图片数组：只接受站内 /images/ 与 http(s) 外链，最多 9 张 */
export function parseWeiboImages(v: unknown): string[] {
  if (!Array.isArray(v)) return []
  return v
    .filter((x): x is string => typeof x === 'string')
    .map((s) => s.trim())
    .filter((s) => s.startsWith('/images/') || /^https?:\/\//i.test(s))
    .slice(0, WEIBO_MAX_IMAGES)
}

/** 读侧图片列表：写侧 parseWeiboImages 已做 scheme 白名单，这里再过滤一道（幂等纵深防御：
 *  备份恢复 / 手工改库进来的异常 URL 不会流进 <img src>），最多 9 张 */
export function weiboImageList(row: Pick<WeiboRow, 'images'>): string[] {
  try {
    const a = JSON.parse(row.images || '[]')
    return Array.isArray(a)
      ? a.filter((x: unknown) => typeof x === 'string' && x.trim())
          .filter((s: string) => s.startsWith('/images/') || /^https?:\/\//i.test(s))
          .slice(0, WEIBO_MAX_IMAGES)
      : []
  } catch {
    return []
  }
}

/* ---------------- 微博视频（B19） ----------------
 * 一条微博最多 1 个视频，存 weibo.video 单列 JSON：{ url, poster, w, h }，空串 = 无视频。
 * 上传走 /admin/upload（≤25MB，mp4/webm 只认文件魔数，见 store.ts）；poster 是发布端从视频里
 * 抽的第一帧（best-effort，抓不到就留空，渲染退化成无封面卡）。写侧 parseWeiboVideo、
 * 读侧 weiboVideoView 两道 scheme 白名单，与图片 parseWeiboImages / weiboImageList 同口径。
 */
export interface WeiboVideoView {
  /** 站内 /images/ 地址或 http(s) 外链 */
  url: string
  /** 封面帧地址（可空串）：卡片首帧、分享卡与后台缩略图用 */
  poster: string
  /** 原始宽高（未知 = 0）：渲染期换算占位比例，避免视频加载时的布局抖动 */
  w: number
  h: number
}

/** 视频地址白名单：站内图床或 http(s)（同 weiboImageList 的读侧口径） */
function videoUrlOk(s: string): boolean {
  return s.startsWith('/images/') || /^https?:\/\//i.test(s)
}

/** 写侧：校验并规整单个视频对象（POST/PUT /admin/weibo 的 video 字段）。
 *  只认 { url, poster?, w?, h? }，多余键丢弃；url 必填且过白名单，poster 同口径（非法当没填），
 *  w/h 取整并限幅（未知 / 越界 = 0）。任一硬性条件不满足返回 null（= 无视频），不抛错。 */
export function parseWeiboVideo(v: unknown): WeiboVideoView | null {
  if (!v || typeof v !== 'object') return null
  const b = v as Record<string, unknown>
  const url = typeof b.url === 'string' ? b.url.trim().slice(0, 500) : ''
  if (!url || !videoUrlOk(url)) return null
  const rawPoster = typeof b.poster === 'string' ? b.poster.trim().slice(0, 500) : ''
  const poster = rawPoster && videoUrlOk(rawPoster) ? rawPoster : ''
  const dim = (x: unknown) => {
    const n = clampInt(x, 0, 10000, 0)
    return n > 0 ? n : 0
  }
  return { url, poster, w: dim(b.w), h: dim(b.h) }
}

/** 读侧：解析 weibo.video 列 → 视频视图；空串 / 脏 JSON / 非法 scheme 一律 null
 *  （纵深防御，同 weiboImageList：备份恢复、手工改库进来的异常值不会流进 <video src>） */
export function weiboVideoView(row: Pick<WeiboRow, 'video'>): WeiboVideoView | null {
  const raw = (row.video || '').trim()
  if (!raw) return null
  try {
    return parseWeiboVideo(JSON.parse(raw))
  } catch {
    return null
  }
}

export function weiboTopicList(row: Pick<WeiboRow, 'topics'>): string[] {
  try {
    const a = JSON.parse(row.topics || '[]')
    return Array.isArray(a) ? a.filter((x: unknown) => typeof x === 'string' && x.trim()).slice(0, WEIBO_MAX_TOPICS) : []
  } catch {
    return []
  }
}

/** 已发布微博的话题聚合（前台话题条用）：按出现次数倒序，取前 20 个 */
export async function listWeiboTopics(db: D1Database): Promise<{ name: string; count: number }[]> {
  const { results } = await db
    .prepare("SELECT topics FROM weibo WHERE status = 'published' AND deleted_at IS NULL LIMIT 1000")
    .all<{ topics: string }>()
  const count = new Map<string, number>()
  for (const r of results ?? []) {
    for (const t of weiboTopicList({ topics: r.topics })) count.set(t, (count.get(t) || 0) + 1)
  }
  return [...count.entries()]
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .slice(0, 20)
    .map(([name, count]) => ({ name, count }))
}

export interface ListWeiboResult {
  items: WeiboRow[]
  total: number
  page: number
  totalPages: number
}

/** listWeibo / locateWeiboPage 共用的过滤条件（status + 话题 + 时间范围 + 回收站），保证深链定位与列表分页的口径一致 */
function weiboConditions(opts: { status?: 'published' | 'draft' | 'all'; topic?: string; afterTs?: number }): { conds: string[]; binds: unknown[] } {
  const conds: string[] = ['deleted_at IS NULL'] // 回收站过滤：微博页/首页入口卡/后台列表都不展示已删行
  const binds: unknown[] = []
  if (opts.status && opts.status !== 'all') {
    conds.push('status = ?')
    binds.push(opts.status)
  }
  if (opts.topic) {
    conds.push("topics LIKE ? ESCAPE '\\'")
    binds.push(jsonItemLikePattern(opts.topic))
  }
  // 后台时间范围筛选：cutoff 由服务端 listRangeCutoff 算出（客户端只传白名单语义值），
  // 谓词落在排序键 COALESCE(published_at, created_at) 上——与 idx_weibo_feed 表达式同形，可作索引范围约束
  if (opts.afterTs && opts.afterTs > 0) {
    conds.push('COALESCE(published_at, created_at) >= ?')
    binds.push(opts.afterTs)
  }
  return { conds, binds }
}

export async function listWeibo(
  db: D1Database,
  opts: {
    status?: 'published' | 'draft' | 'all'
    page?: number
    limit?: number
    topic?: string
    pinnedFirst?: boolean
    afterTs?: number
  } = {}
): Promise<ListWeiboResult> {
  const page = clampInt(opts.page, 1, 1000, 1)
  const limit = clampInt(opts.limit, 1, 100, 15)
  const { conds, binds } = weiboConditions(opts)
  const whereSql = conds.length ? 'WHERE ' + conds.join(' AND ') : ''
  const order = opts.pinnedFirst
    ? 'ORDER BY pinned DESC, COALESCE(published_at, created_at) DESC, id DESC'
    : 'ORDER BY COALESCE(published_at, created_at) DESC, id DESC'
  const [itemsRes, countRes] = await Promise.all([
    db
      .prepare(`SELECT * FROM weibo ${whereSql} ${order} LIMIT ? OFFSET ?`)
      .bind(...binds, limit, (page - 1) * limit)
      .all<WeiboRow>(),
    db.prepare(`SELECT COUNT(*) AS n FROM weibo ${whereSql}`).bind(...binds).first<{ n: number }>(),
  ])
  const total = countRes?.n ?? 0
  return { items: itemsRes.results ?? [], total, page, totalPages: Math.max(1, Math.ceil(total / limit)) }
}

/**
 * 深链定位：算出某条已发布微博在时间线中的页码（1 起）。
 * /weibo 每页只渲染 15 条，而历史上的今天、首页入口卡、TG 通知等入口都链到 /weibo?wb=<id>#wb-<id>，
 * 目标条目多半不在第 1 页——服务端先定位页码再渲染那一页，浏览器原生锚点滚动才落得到。
 * 排序口径与 listWeibo 的 pinnedFirst（置顶优先 + 时间倒序 + id 兜底）一致，status/topic 过滤同步生效；
 * 目标不存在 / 非已发布 / 不在 topic 筛选范围内时返回 null，调用方回退常规分页。
 */
export async function locateWeiboPage(
  db: D1Database,
  id: number,
  opts: { limit?: number; topic?: string; afterTs?: number } = {}
): Promise<number | null> {
  const limit = clampInt(opts.limit, 1, 100, 15)
  const { conds, binds } = weiboConditions({ status: 'published', topic: opts.topic, afterTs: opts.afterTs })
  const target = conds.length ? `id = ? AND ${conds.join(' AND ')}` : 'id = ?'
  const x = await db
    .prepare(`SELECT id, pinned, COALESCE(published_at, created_at) AS ts FROM weibo WHERE ${target}`)
    .bind(id, ...binds)
    .first<{ id: number; pinned: number; ts: number }>()
  if (!x) return null
  // 统计按同一排序排在它前面的行数：页码 = floor(前数 / limit) + 1
  const front = conds.length ? conds.join(' AND ') + ' AND ' : ''
  const rank = await db
    .prepare(
      `SELECT COUNT(*) AS n FROM weibo WHERE ${front}
       (pinned > ?
        OR (pinned = ? AND COALESCE(published_at, created_at) > ?)
        OR (pinned = ? AND COALESCE(published_at, created_at) = ? AND id > ?))`
    )
    .bind(...binds, x.pinned, x.pinned, x.ts, x.pinned, x.ts, x.id)
    .first<{ n: number }>()
  return Math.floor((rank?.n ?? 0) / limit) + 1
}

export async function getWeiboById(db: D1Database, id: number): Promise<WeiboRow | null> {
  // 回收站过滤：公开微博评论接口靠 status 应用层兜底，已删行必须查不到（后台编辑走列表页入口，不直取已删行）
  return db.prepare('SELECT * FROM weibo WHERE id = ? AND deleted_at IS NULL').bind(id).first<WeiboRow>()
}

/** 批量取一组微博的已审核评论数：{weiboId: count}。
 *  INDEXED BY 是硬约束（生产实测 2026-10-15）：不带它时规划器误选 idx_comments_status，
 *  每次全表扫全部已审评论；强制走 weibo_id 索引后十次精准 seek。索引由 ensureSchema 兜底建 */
export async function weiboCommentCountMap(db: D1Database, weiboIds: number[]): Promise<Map<number, number>> {
  if (!weiboIds.length) return new Map()
  const ph = weiboIds.map(() => '?').join(',')
  const { results } = await db
    .prepare(`SELECT weibo_id, COUNT(*) AS n FROM comments INDEXED BY idx_comments_weibo WHERE weibo_id IN (${ph}) AND status = 'approved' GROUP BY weibo_id`)
    .bind(...weiboIds)
    .all<{ weibo_id: number; n: number }>()
  const m = new Map<number, number>()
  for (const r of results ?? []) m.set(r.weibo_id, r.n)
  return m
}

/** 批量取一组文章的已审核评论数：{postId: count}（列表页一次带全，替代逐篇 COUNT 的 N+1）。
 *  INDEXED BY 同 weiboCommentCountMap：防规划器误选 idx_comments_status 全表扫 */
export async function postCommentCountMap(db: D1Database, postIds: number[]): Promise<Map<number, number>> {
  if (!postIds.length) return new Map()
  const ph = postIds.map(() => '?').join(',')
  const { results } = await db
    .prepare(`SELECT post_id, COUNT(*) AS n FROM comments INDEXED BY idx_comments_post WHERE post_id IN (${ph}) AND status = 'approved' GROUP BY post_id`)
    .bind(...postIds)
    .all<{ post_id: number; n: number }>()
  const m = new Map<number, number>()
  for (const r of results ?? []) m.set(r.post_id, r.n)
  return m
}

/* ---------------- 友情链接 ---------------- */

export interface ListFriendLinksResult {
  items: FriendLinkRow[]
  total: number
  pending: number
}

/** 友链列表：sort 升序、同序号按创建先后；pending 为待审核数（后台角标用） */
export async function listFriendLinks(db: D1Database, opts: { status?: 'approved' | 'pending' | 'all' } = {}): Promise<ListFriendLinksResult> {
  const where = opts.status && opts.status !== 'all' ? 'WHERE status = ?' : ''
  const [listRes, pendingRes] = await Promise.all([
    db
      .prepare(`SELECT * FROM friend_links ${where} ORDER BY sort ASC, id ASC LIMIT 500`)
      .bind(...(where ? [opts.status] : []))
      .all<FriendLinkRow>(),
    db.prepare("SELECT COUNT(*) AS n FROM friend_links WHERE status = 'pending'").first<{ n: number }>(),
  ])
  const items = listRes.results ?? []
  return { items, total: items.length, pending: pendingRes?.n ?? 0 }
}

export async function getFriendLinkById(db: D1Database, id: number): Promise<FriendLinkRow | null> {
  return db.prepare('SELECT * FROM friend_links WHERE id = ?').bind(id).first<FriendLinkRow>()
}

/* ---------------- 轻量迁移 ----------------
 * schema.sql 只对全新库生效（CREATE TABLE IF NOT EXISTS 不会补列），
 * 老库升级靠这里：启动时检查缺列，自动 ALTER TABLE 补齐（每个 isolate 只跑一次）。
 */
const SCHEMA_COLUMNS: { table: string; column: string; ddl: string }[] = [
  { table: 'posts', column: 'publish_at', ddl: 'ALTER TABLE posts ADD COLUMN publish_at INTEGER' },
  { table: 'weibo', column: 'likes', ddl: 'ALTER TABLE weibo ADD COLUMN likes INTEGER NOT NULL DEFAULT 0' },
  { table: 'weibo', column: 'topics', ddl: "ALTER TABLE weibo ADD COLUMN topics TEXT NOT NULL DEFAULT '[]'" },
  { table: 'weibo', column: 'pinned', ddl: 'ALTER TABLE weibo ADD COLUMN pinned INTEGER NOT NULL DEFAULT 0' },
  // 微博视频（B19）：一列存单个视频的 JSON（url + 封面帧 + 宽高），空串 = 无视频；写侧解析 parseWeiboVideo / 读侧过滤 weiboVideoView
  { table: 'weibo', column: 'video', ddl: "ALTER TABLE weibo ADD COLUMN video TEXT NOT NULL DEFAULT ''" },
  { table: 'comments', column: 'weibo_id', ddl: 'ALTER TABLE comments ADD COLUMN weibo_id INTEGER NOT NULL DEFAULT 0' },
  { table: 'comments', column: 'parent_id', ddl: 'ALTER TABLE comments ADD COLUMN parent_id INTEGER NOT NULL DEFAULT 0' },
  { table: 'comments', column: 'is_admin', ddl: 'ALTER TABLE comments ADD COLUMN is_admin INTEGER NOT NULL DEFAULT 0' },
  // 媒体体检查重指纹（src/audit.ts）：新上传在 saveUpload 时写入，存量由 hash-backfill 端点回填
  { table: 'uploads', column: 'hash', ddl: "ALTER TABLE uploads ADD COLUMN hash TEXT NOT NULL DEFAULT ''" },
  // 回收站（src/trash.ts）：三表软删标记，NULL = 存活；所有业务查询必须带 deleted_at IS NULL（例外见 AGENTS.md）
  { table: 'posts', column: 'deleted_at', ddl: 'ALTER TABLE posts ADD COLUMN deleted_at INTEGER' },
  { table: 'weibo', column: 'deleted_at', ddl: 'ALTER TABLE weibo ADD COLUMN deleted_at INTEGER' },
  { table: 'pages', column: 'deleted_at', ddl: 'ALTER TABLE pages ADD COLUMN deleted_at INTEGER' },
  // 会员体系（docs/DEVPLAN-2026-10-07.md）：评论挂会员身份（0 = 游客）+ 文章可见档位（all | member | coffee | top）
  { table: 'comments', column: 'member_id', ddl: 'ALTER TABLE comments ADD COLUMN member_id INTEGER NOT NULL DEFAULT 0' },
  { table: 'posts', column: 'min_tier', ddl: "ALTER TABLE posts ADD COLUMN min_tier TEXT NOT NULL DEFAULT 'all'" },
  // 文章访问密码（src/protect.ts）：salt:hash（PBKDF2），空 = 未加密；解锁 Cookie 的 HMAC key 就用它
  { table: 'posts', column: 'password_hash', ddl: "ALTER TABLE posts ADD COLUMN password_hash TEXT NOT NULL DEFAULT ''" },
  // AI 生成标注（编辑器「更多」自愿申报，<人工智能生成合成内容标识办法> 显式标识口径）：0/1，前台文章页 meta 行显示
  { table: 'posts', column: 'ai_generated', ddl: 'ALTER TABLE posts ADD COLUMN ai_generated INTEGER NOT NULL DEFAULT 0' },
  // 会员昵称 30 天一次修改窗口（src/utils.ts nicknameCooldown）：NULL = 从未改过，首次修改不受限
  { table: 'members', column: 'display_name_changed_at', ddl: 'ALTER TABLE members ADD COLUMN display_name_changed_at INTEGER' },
  // 评论头像（C2）：绑定的 QQ 号，仅头像抓取记账位——任何公开出参不携带（头像走站内转存，见 members.avatar）
  { table: 'members', column: 'qq', ddl: "ALTER TABLE members ADD COLUMN qq TEXT NOT NULL DEFAULT ''" },
  // 游客 QQ 头像（C2 扩展）：游客选填的 qq（仅抓取记账位，公开出参不携带）+ 服务端抓取转存的站内头像地址
  { table: 'comments', column: 'qq', ddl: "ALTER TABLE comments ADD COLUMN qq TEXT NOT NULL DEFAULT ''" },
  { table: 'comments', column: 'avatar', ddl: "ALTER TABLE comments ADD COLUMN avatar TEXT NOT NULL DEFAULT ''" },
  // 评论 IP 属地（src/ipregion.ts）：写库定格 request.cf 快照（CN:Guangdong / US / HK），采集无条件，
  // 展示走 settings.showCommentRegion 门控；开启前的旧评论与无 cf 的自托管形态为空串不展示
  { table: 'comments', column: 'ip_region', ddl: "ALTER TABLE comments ADD COLUMN ip_region TEXT NOT NULL DEFAULT ''" },
  // 分类描述（B23）：归档页页头说明 + meta description；建表列体见 schema.sql
  { table: 'categories', column: 'description', ddl: "ALTER TABLE categories ADD COLUMN description TEXT NOT NULL DEFAULT ''" },
]
const SCHEMA_TABLES = [
  // 会员体系（2026-10-07 起，见 docs/DEVPLAN-2026-10-07.md 附录 A 契约）：
  // members 与 users/sessions 彻底分离（users 只承载管理员，游客注册混入会破坏 /api/auth/setup 首装判断）
  `CREATE TABLE IF NOT EXISTS members (
    id            INTEGER PRIMARY KEY AUTOINCREMENT,
    username      TEXT    NOT NULL UNIQUE,
    password_hash TEXT    NOT NULL,
    salt          TEXT    NOT NULL,
    email         TEXT    NOT NULL DEFAULT '',
    display_name  TEXT    NOT NULL DEFAULT '',
    avatar        TEXT    NOT NULL DEFAULT '',
    qq            TEXT    NOT NULL DEFAULT '',
    tier          TEXT    NOT NULL DEFAULT 'normal',
    points        INTEGER NOT NULL DEFAULT 0,
    status        TEXT    NOT NULL DEFAULT 'active',
    created_at    INTEGER NOT NULL,
    updated_at    INTEGER NOT NULL,
    last_login_at INTEGER,
    display_name_changed_at INTEGER
  )`,
  `CREATE TABLE IF NOT EXISTS member_sessions (
    token      TEXT    PRIMARY KEY,
    member_id  INTEGER NOT NULL,
    expires_at INTEGER NOT NULL,
    created_at INTEGER NOT NULL
  )`,
  `CREATE TABLE IF NOT EXISTS member_points_log (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    member_id  INTEGER NOT NULL,
    delta      INTEGER NOT NULL,
    reason     TEXT    NOT NULL DEFAULT '',
    ref_id     INTEGER NOT NULL DEFAULT 0,
    note       TEXT    NOT NULL DEFAULT '',
    created_at INTEGER NOT NULL
  )`,
  // Telegram 相册缓冲（src/external.ts）：多选拆成的多条消息先落这里，几秒后合并成一条微博
  `CREATE TABLE IF NOT EXISTS tg_buffer (
    media_group_id TEXT PRIMARY KEY,
    content        TEXT NOT NULL DEFAULT '',
    images         TEXT NOT NULL DEFAULT '[]',
    status         TEXT NOT NULL DEFAULT 'published',
    chat_id        TEXT NOT NULL DEFAULT '',
    updated_at     INTEGER NOT NULL
  )`,
  `CREATE TABLE IF NOT EXISTS tags (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    name       TEXT    NOT NULL UNIQUE,
    created_at INTEGER NOT NULL
  )`,
  `CREATE TABLE IF NOT EXISTS friend_links (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    name        TEXT    NOT NULL,
    url         TEXT    NOT NULL,
    description TEXT    NOT NULL DEFAULT '',
    icon        TEXT    NOT NULL DEFAULT '',
    status      TEXT    NOT NULL DEFAULT 'pending',
    sort        INTEGER NOT NULL DEFAULT 0,
    source      TEXT    NOT NULL DEFAULT 'admin',
    ip          TEXT    NOT NULL DEFAULT '',
    created_at  INTEGER NOT NULL,
    updated_at  INTEGER NOT NULL
  )`,
  // 独立页面（src/pages.ts renderPage）：自建页面 + 「关于我」（slug = 'about'，见 ensureSchema 末尾的一次性播种）
  // deleted_at 必须与 schema.sql 同步在列：ensureSchema 先跑 SCHEMA_COLUMNS 的 ALTER 再建表，
  // 全新库上 ALTER 撞「no such table」被吞，CREATE 漏列会让本 isolate 内所有 pages 查询 500
  `CREATE TABLE IF NOT EXISTS pages (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    title       TEXT    NOT NULL,
    slug        TEXT    NOT NULL UNIQUE,
    content     TEXT    NOT NULL DEFAULT '',
    status      TEXT    NOT NULL DEFAULT 'draft',
    show_in_nav INTEGER NOT NULL DEFAULT 0,
    sort        INTEGER NOT NULL DEFAULT 0,
    created_at  INTEGER NOT NULL,
    updated_at  INTEGER NOT NULL,
    deleted_at  INTEGER
  )`,
  // 访客统计日志（src/stats.ts）：只存匿名 vid 与来源域名，不进备份，保留 180 天
  `CREATE TABLE IF NOT EXISTS visit_log (
    id      INTEGER PRIMARY KEY AUTOINCREMENT,
    ts      INTEGER NOT NULL,
    day     TEXT    NOT NULL,
    vid     TEXT    NOT NULL DEFAULT '',
    path    TEXT    NOT NULL DEFAULT '',
    title   TEXT    NOT NULL DEFAULT '',
    ref     TEXT    NOT NULL DEFAULT '',
    dev     TEXT    NOT NULL DEFAULT '',
    br      TEXT    NOT NULL DEFAULT '',
    country TEXT    NOT NULL DEFAULT ''
  )`,
  // 爬虫 / AI 抓取日志（src/bots.ts）：服务端按 UA 识别后旁路落库，不进备份，保留 180 天
  `CREATE TABLE IF NOT EXISTS bot_log (
    id      INTEGER PRIMARY KEY AUTOINCREMENT,
    ts      INTEGER NOT NULL,
    day     TEXT    NOT NULL,
    name    TEXT    NOT NULL DEFAULT '',
    kind    TEXT    NOT NULL DEFAULT '',
    path    TEXT    NOT NULL DEFAULT '',
    country TEXT    NOT NULL DEFAULT ''
  )`,
  // FTS5 全文索引（src/fts.ts，ROADMAP B4）：external content 挂原表省一份正文存储，
  // trigram 分词适配中文。虚表可以进 schema.sql（单条无分号体）；触发器只能在这里挂——
  // demo.ts 的 ensureTables 按分号朴素切分 SQL，切不开 CREATE TRIGGER 的 BEGIN...END 体，
  // 而 ensureSchema 是所有部署形态（生产 / 本地 / 演示）每次冷启动都会跑的通用迁移路径。
  // 虚表是可重建的派生索引：不进 BACKUP_TABLES，恢复备份后靠 ftsSeeded 记账位触发全量重建
  // （ftsSeeded 本身会随 settings 一起被备份带回，ensureSchema 里另有空索引自愈探测兜底）
  `CREATE VIRTUAL TABLE IF NOT EXISTS posts_fts USING fts5(title, summary, content, tokenize='trigram', content='posts', content_rowid='id')`,
  `CREATE VIRTUAL TABLE IF NOT EXISTS weibo_fts USING fts5(content, tokenize='trigram', content='weibo', content_rowid='id')`,
]
// FTS5 增量同步触发器（src/fts.ts）：UPDATE 用 OF 列清单收紧——views/likes 的自增高频写
// 不得触发重建索引行；posts 的 title/summary/content 与 weibo 的 content 是仅有的索引列
const SCHEMA_TRIGGERS = [
  `CREATE TRIGGER IF NOT EXISTS posts_fts_ins AFTER INSERT ON posts BEGIN
    INSERT INTO posts_fts(rowid, title, summary, content) VALUES (new.id, new.title, new.summary, new.content);
  END`,
  `CREATE TRIGGER IF NOT EXISTS posts_fts_del AFTER DELETE ON posts BEGIN
    INSERT INTO posts_fts(posts_fts, rowid, title, summary, content) VALUES ('delete', old.id, old.title, old.summary, old.content);
  END`,
  `CREATE TRIGGER IF NOT EXISTS posts_fts_upd AFTER UPDATE OF title, summary, content ON posts BEGIN
    INSERT INTO posts_fts(posts_fts, rowid, title, summary, content) VALUES ('delete', old.id, old.title, old.summary, old.content);
    INSERT INTO posts_fts(rowid, title, summary, content) VALUES (new.id, new.title, new.summary, new.content);
  END`,
  `CREATE TRIGGER IF NOT EXISTS weibo_fts_ins AFTER INSERT ON weibo BEGIN
    INSERT INTO weibo_fts(rowid, content) VALUES (new.id, new.content);
  END`,
  `CREATE TRIGGER IF NOT EXISTS weibo_fts_del AFTER DELETE ON weibo BEGIN
    INSERT INTO weibo_fts(weibo_fts, rowid, content) VALUES ('delete', old.id, old.content);
  END`,
  `CREATE TRIGGER IF NOT EXISTS weibo_fts_upd AFTER UPDATE OF content ON weibo BEGIN
    INSERT INTO weibo_fts(weibo_fts, rowid, content) VALUES ('delete', old.id, old.content);
    INSERT INTO weibo_fts(rowid, content) VALUES (new.id, new.content);
  END`,
]
// 导出供 tests/feed-index.test.ts 做双份登记镜像守卫
export const SCHEMA_INDEXES = [
  'CREATE INDEX IF NOT EXISTS idx_comments_weibo ON comments (weibo_id, created_at)',
  // idx_comments_post 的 schema.sql 副本自 MoBlog v1.0 就有，但 INDEXED BY 是硬约束（索引不在场语句直接
  // 报错）：这里兜底所有冷启动形态，老库若曾手工删过索引也能自愈（与 schema.sql 双份登记，tests/feed-index.test.ts 守卫）
  'CREATE INDEX IF NOT EXISTS idx_comments_post ON comments (post_id, created_at)',
  // comments.member_id 与 posts.min_tier 是老库运行时补齐的列，索引只能在这里建（schema.sql 不能建，见该文件内说明）
  'CREATE INDEX IF NOT EXISTS idx_comments_member ON comments (member_id, created_at)',
  'CREATE INDEX IF NOT EXISTS idx_members_points ON members (points DESC)',
  'CREATE INDEX IF NOT EXISTS idx_member_sessions_expiry ON member_sessions (expires_at)',
  'CREATE INDEX IF NOT EXISTS idx_points_log_member ON member_points_log (member_id, created_at)',
  // 记分幂等的数据库强制：评论 ref_id=评论 id、每日登录 ref_id=北京日序号，并发重复记账由唯一索引拦下
  // （points.ts awardPoints 捕获 UNIQUE 冲突视为已记过；ref_id=0 的 adminAdjust/老 dailyLogin 行不进索引）
  'CREATE UNIQUE INDEX IF NOT EXISTS idx_points_log_dedup ON member_points_log (member_id, reason, ref_id) WHERE ref_id > 0',
  'CREATE INDEX IF NOT EXISTS idx_uploads_created ON uploads (created_at DESC)',
  'CREATE INDEX IF NOT EXISTS idx_friend_links_status ON friend_links (status, sort, id)',
  'CREATE INDEX IF NOT EXISTS idx_visit_day ON visit_log (day, ts)',
  // 滚动清理 DELETE WHERE ts < ? 走前导索引（visit_log 是量最大的日志表；与 schema.sql 同步登记）
  'CREATE INDEX IF NOT EXISTS idx_visit_ts ON visit_log (ts)',
  // 爬虫日志同口径（src/bots.ts；与 schema.sql 同步登记）
  'CREATE INDEX IF NOT EXISTS idx_bot_day ON bot_log (day, ts)',
  'CREATE INDEX IF NOT EXISTS idx_bot_ts ON bot_log (ts)',
  // 回收站软删行极少：部分索引只收已删行，trash 面查询与 30 天到期清理免全表扫
  'CREATE INDEX IF NOT EXISTS idx_posts_deleted ON posts (deleted_at) WHERE deleted_at IS NOT NULL',
  'CREATE INDEX IF NOT EXISTS idx_weibo_deleted ON weibo (deleted_at) WHERE deleted_at IS NOT NULL',
  'CREATE INDEX IF NOT EXISTS idx_pages_deleted ON pages (deleted_at) WHERE deleted_at IS NOT NULL',
  // 列表时间线排序索引（P0-1，D1 读放大优化）：ORDER BY 的 COALESCE(published_at, created_at) 与裸 published_at
  // 列结构不匹配，翻页曾全表扫描 + 临时排序；表达式与 listPosts/listWeibo 排序片段一字不差，
  // 改排序与 schema.sql / 排序处三同步（tests/feed-index.test.ts 守卫）
  'CREATE INDEX IF NOT EXISTS idx_weibo_feed ON weibo (status, COALESCE(published_at, created_at) DESC, id DESC) WHERE deleted_at IS NULL',
  'CREATE INDEX IF NOT EXISTS idx_weibo_feed_pinned ON weibo (status, pinned DESC, COALESCE(published_at, created_at) DESC, id DESC) WHERE deleted_at IS NULL',
  'CREATE INDEX IF NOT EXISTS idx_posts_feed ON posts (status, pinned DESC, COALESCE(published_at, created_at) DESC, id DESC) WHERE deleted_at IS NULL',
]

/** 表列清单（PRAGMA table_info）：ensureSchema 迁移与整站包版本比对共用。
 *  调用方只传 BUNDLE_TABLES / SCHEMA_COLUMNS 里的固定表名（非用户输入），无注入面 */
export async function tableColumns(db: D1Database, table: string): Promise<Set<string>> {
  const { results } = await db.prepare(`PRAGMA table_info(${table})`).all<{ name: string }>()
  return new Set((results ?? []).map((r) => r.name))
}

export async function ensureSchema(db: D1Database): Promise<void> {
  const cols = new Map<string, Set<string>>()
  for (const { table } of SCHEMA_COLUMNS) {
    if (!cols.has(table)) cols.set(table, await tableColumns(db, table))
  }
  for (const { table, column, ddl } of SCHEMA_COLUMNS) {
    if (cols.get(table)?.has(column)) continue
    try {
      await db.prepare(ddl).run()
    } catch {
      /* 并发 isolate 已加过列，忽略 duplicate column 错误 */
    }
  }
  for (const ddl of SCHEMA_TABLES) {
    try {
      await db.prepare(ddl).run()
    } catch {
      /* 表已存在 */
    }
  }
  for (const ddl of SCHEMA_INDEXES) {
    try {
      await db.prepare(ddl).run()
    } catch {
      /* 索引已存在 */
    }
  }
  for (const ddl of SCHEMA_TRIGGERS) {
    try {
      await db.prepare(ddl).run()
    } catch {
      /* 触发器已存在 */
    }
  }
  // FTS 全量重建记账（src/fts.ts）：external content 虚表建出来时倒排索引是空的，
  // 存量数据必须 rebuild 一次才可搜。settings 记账位保证只跑一回；记账位在场也复核一次
  // 索引非空——备份把 settings 原样带走又整体恢复时 ftsSeeded 会跟着回来，落到空索引的库
  // 会让 ≥3 码点搜索静默无结果，这一探测兜住所有恢复路径（posts_fts_docsize 每个已索引
  // 文档恰好一行，空索引恒为 0；直接查 posts_fts 读的是原表，测不出索引空）。触发器要在场
  // 才能保证增量，所以这步必须排在 SCHEMA_TRIGGERS 之后。
  let needFtsRebuild = !(await db.prepare("SELECT value FROM settings WHERE key = 'ftsSeeded'").first<{ value: string }>())
  if (!needFtsRebuild) {
    const docsize = await db.prepare('SELECT COUNT(*) AS n FROM posts_fts_docsize').first<{ n: number }>().catch(() => ({ n: 0 }))
    needFtsRebuild = !docsize || docsize.n === 0
  }
  if (needFtsRebuild) {
    try {
      await db.prepare("INSERT INTO posts_fts(posts_fts) VALUES('rebuild')").run()
      await db.prepare("INSERT INTO weibo_fts(weibo_fts) VALUES('rebuild')").run()
      await db
        .prepare("INSERT INTO settings (key, value) VALUES ('ftsSeeded', '1') ON CONFLICT(key) DO UPDATE SET value = '1'")
        .bind()
        .run()
    } catch {
      /* 虚表尚未就绪等异常：不记账，下次冷启动重试 */
    }
  }
  // 「关于我」→ 页面系统一次性迁移：settings 记账位防重复播种（页面被删后也不会复活）。
  // 老站升级把 settings.about 播成 slug='about' 的页面；新站首装播种默认文案，两者同一条路径。
  // OR IGNORE + 吞冲突：部署后并发 isolate 会同时读到记账位缺失，输家撞 slug UNIQUE 不能打瘫首个请求（同 ftsSeeded 块口径）。
  const seeded = await db.prepare("SELECT value FROM settings WHERE key = 'pagesSeeded'").first<{ value: string }>()
  if (!seeded) {
    const about = await db.prepare("SELECT value FROM settings WHERE key = 'about'").first<{ value: string }>()
    const now = Date.now()
    try {
      await db.batch([
        db
          .prepare(
            "INSERT OR IGNORE INTO pages (title, slug, content, status, show_in_nav, sort, created_at, updated_at) VALUES ('关于我', 'about', ?, 'published', 1, 90, ?, ?)"
          )
          .bind(about?.value || DEFAULT_SETTINGS.about, now, now),
        db
          .prepare("INSERT INTO settings (key, value) VALUES ('pagesSeeded', '1') ON CONFLICT(key) DO UPDATE SET value = '1'")
          .bind(),
      ])
    } catch {
      /* 并发 isolate 已处理：不记账也无碍，下次冷启动重试 */
    }
  }
  // 页脚「站点足迹」统计冷启动播种：键缺失（新装/老站升级）时算一次，此后交给每晚 cron 刷新。
  // upsert 幂等，并发 isolate 重复算也只是同值覆盖
  const footRow = await db.prepare("SELECT value FROM settings WHERE key = 'siteFoot'").first()
  if (!footRow) await refreshFootStats(db).catch(() => {})
  // 冷启动/cron 期间写过记账位（ftsSeeded / pagesSeeded / siteFoot），清掉共享快照，
  // 保证紧随其后的业务读取看到播种后的口径
  await invalidateSharedSettings(db)
}

/** 页脚「站点足迹」统计：累计已发布篇数 / 正文字符量 / 最早发文时间（北京年口径）。
 * 每晚备份 cron 刷新一次 + 冷启动首次播种（键缺失时），页脚名片读 settings.siteFoot */
export async function refreshFootStats(db: D1Database): Promise<void> {
  const row = await db
    .prepare(
      "SELECT COUNT(*) AS n, COALESCE(SUM(LENGTH(content)), 0) AS c, COALESCE(MIN(COALESCE(published_at, created_at)), 0) AS since FROM posts WHERE status = 'published' AND deleted_at IS NULL"
    )
    .first<{ n: number; c: number; since: number }>()
  await db
    .prepare('INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value')
    .bind('siteFoot', JSON.stringify({ posts: row?.n ?? 0, chars: row?.c ?? 0, since: row?.since ?? 0 }))
    .run()
  await invalidateSharedSettings(db)
}

export async function countUsers(db: D1Database): Promise<number> {
  const r = await db.prepare('SELECT COUNT(*) AS n FROM users').first<{ n: number }>()
  return r?.n ?? 0
}

export async function seedWelcomePost(db: D1Database, authorId: number): Promise<void> {
  const now = Date.now()
  const content = `<p>你好呀，这是你博客号的第一篇文章 👋</p><p>微信有<strong>公众号</strong>，你有<strong>博客号</strong>——不用申请、不用排队，注册账号的那一刻它就归你了，而且完全住在 <strong>Cloudflare</strong> 上：网页由 Workers 渲染，文字存进 D1，图片传到 R2，全世界的访客都很快，每月免费额度足够你写很多年。</p><h2>写作，就要轻松</h2><p>打开 <a href="/admin/">后台</a>，像写公众号一样写：标题、正文、封面、标签都在一屏里；截图直接 <strong>Ctrl/⌘ + V</strong> 粘贴进正文，图片自动传到你的 R2 图床。</p><blockquote>博客号，博客好。写作最好的状态：像发动态一样轻，像写文章一样认真。</blockquote><h3>试试这些</h3><ul><li>粘贴一张截图，体验自动上传</li><li>点右上角「体检」，检查排版是否符合微信排版规范</li><li>在「设置」里换一套主题：微信公众号风 / 纸墨 / 极简 / 夜航 / 手账 / 比特币 / 小红书</li></ul><p>现在，删掉这篇文章，写下属于你的第一篇吧。</p>`
  // OR IGNORE：slug 已存在（例如线上已手动播种过）时静默跳过，保证首次创建管理员永不失败
  await db
    .prepare(
      `INSERT OR IGNORE INTO posts (slug, title, content, summary, cover, tags, status, pinned, author_id, published_at, created_at, updated_at)
       VALUES (?, ?, ?, ?, '', ?, 'published', 0, ?, ?, ?, ?)`
    )
    .bind(
      'hello-bloghao',
      '你好，博客号！这是你的第一篇文章',
      content,
      '欢迎开号：微信有公众号，你有博客号。想写就写，一切都归你。',
      JSON.stringify(['开始使用']),
      authorId,
      now,
      now,
      now
    )
    .run()
}

/* ---------------- 会员（访客注册身份，与 users 管理员彻底分离，契约见 docs/DEVPLAN-2026-10-07.md 附录 A） ---------------- */

export async function getMemberByUsername(db: D1Database, username: string): Promise<MemberRow | null> {
  return db.prepare('SELECT * FROM members WHERE username = ?').bind(username).first<MemberRow>()
}

export async function getMemberById(db: D1Database, id: number): Promise<MemberRow | null> {
  return db.prepare('SELECT * FROM members WHERE id = ?').bind(id).first<MemberRow>()
}

export async function createMember(
  db: D1Database,
  v: { username: string; hash: string; salt: string; email: string; displayName?: string }
): Promise<number> {
  const now = Date.now()
  const res = await db
    .prepare(
      "INSERT INTO members (username, password_hash, salt, email, display_name, avatar, tier, points, status, created_at, updated_at) VALUES (?, ?, ?, ?, ?, '', 'normal', 0, 'active', ?, ?)"
    )
    .bind(v.username, v.hash, v.salt, v.email, v.displayName ?? '', now, now)
    .run()
  return Number(res.meta.last_row_id)
}

/**
 * 改昵称：30 天一次的窗口判定用 SQL 条件更新原子完成（防双开/并发请求同时过检查）。
 * 返回 false = 命中冷却窗口（调用方提示解禁日期）；改前应先 getMemberById 做前置检查给出精确文案。
 */
export async function updateMemberNickname(db: D1Database, id: number, displayName: string, now: number): Promise<boolean> {
  const r = await db
    .prepare(
      'UPDATE members SET display_name = ?, display_name_changed_at = ?, updated_at = ? WHERE id = ? AND (display_name_changed_at IS NULL OR display_name_changed_at <= ?)'
    )
    .bind(displayName, now, now, id, now - NICKNAME_CHANGE_COOLDOWN_MS)
    .run()
  return (r.meta.changes ?? 0) > 0
}

/** 绑定 QQ 号并回写头像（评论头像 C2）：avatar 传 null = 只存 qq 不动头像（qlogo 抓取失败容忍，
 *  会员中心「重试头像」用同一 qq 重跑本函数补抓）；qq/avatar 都是本人提交或站内转存的值，无公开面 */
export async function updateMemberQQ(db: D1Database, id: number, qq: string, avatar: string | null, now: number): Promise<void> {
  await db
    .prepare('UPDATE members SET qq = ?, updated_at = ?, avatar = COALESCE(?, avatar) WHERE id = ?')
    .bind(qq, now, avatar, id)
    .run()
}

/** 后台会员列表：q 模糊匹配用户名/邮箱（likePattern 同口径转义），20 条/页，新会员在前 */
const MEMBER_PAGE_SIZE = 20
/** 后台会员行（剥口令字段——后台出参永不携带 password_hash/salt，同 postAdminView 口径） */
export type MemberAdminRow = Omit<MemberRow, 'password_hash' | 'salt'>
const MEMBER_ADMIN_COLS =
  'id, username, email, display_name, avatar, tier, points, status, created_at, updated_at, last_login_at'
export async function listMembersAdmin(
  db: D1Database,
  q: string,
  page: number
): Promise<{ items: MemberAdminRow[]; total: number; page: number; totalPages: number }> {
  const pattern = q ? likePattern(q) : ''
  const where = q ? "WHERE username LIKE ? ESCAPE '\\' OR email LIKE ? ESCAPE '\\'" : ''
  const binds = q ? [pattern, pattern] : []
  const cnt = await db.prepare(`SELECT COUNT(*) AS n FROM members ${where}`).bind(...binds).first<{ n: number }>()
  const total = cnt?.n ?? 0
  const totalPages = Math.max(1, Math.ceil(total / MEMBER_PAGE_SIZE))
  const p = Math.min(Math.max(1, page), totalPages)
  const { results } = await db
    .prepare(`SELECT ${MEMBER_ADMIN_COLS} FROM members ${where} ORDER BY id DESC LIMIT ${MEMBER_PAGE_SIZE} OFFSET ?`)
    .bind(...binds, (p - 1) * MEMBER_PAGE_SIZE)
    .all<MemberAdminRow>()
  return { items: results ?? [], total, page: p, totalPages }
}

/** 后台改档位/封禁：缺键即保留（同 posts PUT 语义），返回是否命中行 */
export async function updateMemberAdmin(
  db: D1Database,
  id: number,
  patch: { tier?: string; status?: string }
): Promise<boolean> {
  const sets: string[] = []
  const binds: unknown[] = []
  if (patch.tier !== undefined) {
    sets.push('tier = ?')
    binds.push(patch.tier)
  }
  if (patch.status !== undefined) {
    sets.push('status = ?')
    binds.push(patch.status)
  }
  if (!sets.length) return true
  sets.push('updated_at = ?')
  binds.push(Date.now(), id)
  const r = await db.prepare(`UPDATE members SET ${sets.join(', ')} WHERE id = ?`).bind(...binds).run()
  return (r.meta.changes ?? 0) > 0
}

/** 排行榜（/rank 页与首页挂件共用）：只含 active 且积分 > 0（全员 0 分时不做无意义长名单），积分倒序、同分按加入先后 */
export async function listRankTop(db: D1Database, limit: number): Promise<RankMemberRow[]> {
  const { results } = await db
    .prepare(
      "SELECT id, username, display_name, avatar, tier, points FROM members WHERE status = 'active' AND points > 0 ORDER BY points DESC, id ASC LIMIT ?"
    )
    .bind(limit)
    .all<RankMemberRow>()
  return results ?? []
}
