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
  siteUrl: '',
  footerText: '由 博客号 驱动 · 住在 Cloudflare 上',
  allowComments: '1',
  moderateComments: '0',
  postsPerPage: '10',
  about: '<p>在这里写下关于你的故事。</p>',
  faviconUrl: '',
  avatarUrl: '',
  // 分享到社交平台的默认卡图（og:image 兜底；文章未设封面/卡图时使用，空则回退内置 /og-default.png）
  ogImageDefault: '',
  // 外部发布（见 src/external.ts）：空 Token = 开放接口关闭
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
  // 编辑器插件停用名单（后台「插件」页；逗号分隔的 manifest id，空 = 全部启用）
  pluginsDisabled: '',
  // 服务端插件停用名单（后台「插件」页；逗号分隔的插件 id，空 = 全部启用，见 src/hooks.ts）
  serverPluginsDisabled: '',
  // 服务端插件配置：发布同步 TG 频道的频道 ID / 评论 Webhook 地址 / 页脚自定义 HTML（src/hooks.ts）
  tgChannelChatId: '',
  commentWebhookUrl: '',
  footerHtmlCode: '',
  // 服务端插件「微博同步 Buffer」：Buffer API Key 与目标渠道 ID（X 等，设置页可一键拉取，src/hooks.ts）
  bufferAccessToken: '',
  bufferChannelId: '',
  // 服务端插件「广场同步」：广场 hub 地址（默认官方 https://plaza.bloghao.com）与站点注册 token（src/hooks.ts，docs/PLAZA.md）
  plazaEndpoint: 'https://plaza.bloghao.com',
  plazaToken: '',
  // 一键灰度（哀悼/纪念模式）：所有公开页 CSS 去色，见 src/render.ts page()
  siteGrayscale: '0',
  // 一键闭站：公开页面与公开 API 全部 503，仅后台/登录/图床可用（src/index.ts 闭站中间件）
  siteClosed: '0',
  // 闭站页公告文案，空 = 使用内置默认文案
  siteClosedMessage: '',
  // 会员体系总开关（契约见 docs/DEVPLAN-2026-10-07.md 附录 A）：关闭时前台无会员入口、/api/member/* 返回 404
  membersEnabled: '0',
  // 排行榜展示条数上限（/rank 页与首页挂件共用，1-50）
  rankTopN: '10',
  // 英文测试版（内部代号 English 0.1，见 src/i18n.ts）：edition 是后台可切的语言版本；
  // editionEnStatus 是运行状态（active 正常 / fallback 渲染异常已自动回退中文，重新开启时重置）
  edition: 'zh',
  editionEnStatus: 'active',
  // 英文版最近一次异常的错误摘要与发生时间（后台横幅展示，仅记录，渲染层不读）
  editionEnError: '',
  editionEnAt: '',
}

export async function getSettings(db: D1Database): Promise<SettingsMap> {
  const { results } = await db
    .prepare('SELECT key, value FROM settings')
    .all<{ key: string; value: string }>()
  const s: SettingsMap = { ...DEFAULT_SETTINGS }
  for (const r of results ?? []) s[r.key] = r.value
  return s
}

export async function saveSettings(db: D1Database, patch: SettingsMap): Promise<void> {
  const entries = Object.entries(patch)
  if (!entries.length) return
  const stmts = entries.map(([k, v]) =>
    db
      .prepare(
        'INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value'
      )
      .bind(k, String(v ?? ''))
  )
  await db.batch(stmts)
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
  const whereSql = where.length ? 'WHERE ' + where.join(' AND ') : ''
  const recency = 'COALESCE(published_at, created_at) DESC'
  // 随机排序用 (id+seed) 乘法散列：同一 seed 下全站顺序固定，翻页不重洗；换 seed 即换一组
  const orderSql =
    opts.status === 'draft'
      ? 'ORDER BY updated_at DESC'
      : opts.sort === 'views'
        ? `ORDER BY views DESC, ${recency}`
        : opts.sort === 'likes'
          ? `ORDER BY likes DESC, ${recency}`
          : opts.sort === 'comments'
            ? `ORDER BY (SELECT COUNT(*) FROM comments cm WHERE cm.post_id = posts.id AND cm.status = 'approved') DESC, ${recency}`
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

/** sitemap 用的轻量列表：slug + updated_at（不走 listPosts——它的 limit 被 clamp 到 100） */
export async function listSitemapPosts(db: D1Database): Promise<{ slug: string; updated_at: number }[]> {
  const { results } = await db
    .prepare("SELECT slug, updated_at FROM posts WHERE status = 'published' AND deleted_at IS NULL ORDER BY updated_at DESC LIMIT 2000")
    .all<{ slug: string; updated_at: number }>()
  return results ?? []
}

/** 已发布文章用到的标签聚合（导航菜单/sitemap 用），按使用次数倒序 */
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
    const text = r.content.trim() || (imgs.length ? `发了 ${imgs.length} 张图` : '')
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
        `SELECT slug AS key, title, '' AS content, '' AS images, COALESCE(published_at, created_at) AS ts
         FROM posts
         WHERE status = 'published' AND deleted_at IS NULL AND ${ON_THIS_DAY_MD} = strftime('%m-%d', 'now', '28800 seconds') AND ${ON_THIS_DAY_Y} < CAST(strftime('%Y', 'now', '28800 seconds') AS INTEGER)
         ORDER BY ts DESC LIMIT ${ON_THIS_DAY_SOURCE_LIMIT}`
      ),
    db
      .prepare(
        `SELECT id AS key, '' AS title, content, images, COALESCE(published_at, created_at) AS ts
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


export async function relatedPosts(db: D1Database, post: PostRow, limit = 3): Promise<PostRow[]> {
  const tags = parseTags(post)
  if (tags.length) {
    // 与 listPosts 的标签过滤同口径：带 JSON 引号精确匹配 + ESCAPE，防「猫」命中「波斯猫」/通配符注入
    // 注意必须 join(' OR ')：数组直接内插会以逗号连接，(a,b) 构成 row value，D1 直接报 row value misused
    const likeBinds = tags.map(() => "tags LIKE ? ESCAPE '\\'").join(' OR ')
    const { results } = await db
      .prepare(
        `SELECT * FROM posts WHERE id != ? AND status = 'published' AND deleted_at IS NULL AND (${likeBinds}) ORDER BY views DESC LIMIT ?`
      )
      .bind(post.id, ...tags.map((t) => jsonItemLikePattern(t)), limit)
      .all<PostRow>()
    if ((results?.length ?? 0) > 0) return results ?? []
  }
  const { results } = await db
    .prepare("SELECT * FROM posts WHERE id != ? AND status = 'published' AND deleted_at IS NULL ORDER BY published_at DESC LIMIT ?")
    .bind(post.id, limit)
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

export async function createCategory(db: D1Database, name: string, slug: string, sort = 0): Promise<CategoryRow> {
  const res = await db
    .prepare('INSERT INTO categories (name, slug, sort, created_at) VALUES (?, ?, ?, ?)')
    .bind(name, slug, sort, Date.now())
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

/** listWeibo / locateWeiboPage 共用的过滤条件（status + 话题 + 回收站），保证深链定位与列表分页的口径一致 */
function weiboConditions(opts: { status?: 'published' | 'draft' | 'all'; topic?: string }): { conds: string[]; binds: unknown[] } {
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
export async function locateWeiboPage(db: D1Database, id: number, opts: { limit?: number; topic?: string } = {}): Promise<number | null> {
  const limit = clampInt(opts.limit, 1, 100, 15)
  const { conds, binds } = weiboConditions({ status: 'published', topic: opts.topic })
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

/** 批量取一组微博的已审核评论数：{weiboId: count} */
export async function weiboCommentCountMap(db: D1Database, weiboIds: number[]): Promise<Map<number, number>> {
  if (!weiboIds.length) return new Map()
  const ph = weiboIds.map(() => '?').join(',')
  const { results } = await db
    .prepare(`SELECT weibo_id, COUNT(*) AS n FROM comments WHERE weibo_id IN (${ph}) AND status = 'approved' GROUP BY weibo_id`)
    .bind(...weiboIds)
    .all<{ weibo_id: number; n: number }>()
  const m = new Map<number, number>()
  for (const r of results ?? []) m.set(r.weibo_id, r.n)
  return m
}

/** 批量取一组文章的已审核评论数：{postId: count}（列表页一次带全，替代逐篇 COUNT 的 N+1） */
export async function postCommentCountMap(db: D1Database, postIds: number[]): Promise<Map<number, number>> {
  if (!postIds.length) return new Map()
  const ph = postIds.map(() => '?').join(',')
  const { results } = await db
    .prepare(`SELECT post_id, COUNT(*) AS n FROM comments WHERE post_id IN (${ph}) AND status = 'approved' GROUP BY post_id`)
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
  // 会员昵称 30 天一次修改窗口（src/utils.ts nicknameCooldown）：NULL = 从未改过，首次修改不受限
  { table: 'members', column: 'display_name_changed_at', ddl: 'ALTER TABLE members ADD COLUMN display_name_changed_at INTEGER' },
  // 评论头像（C2）：绑定的 QQ 号，仅头像抓取记账位——任何公开出参不携带（头像走站内转存，见 members.avatar）
  { table: 'members', column: 'qq', ddl: "ALTER TABLE members ADD COLUMN qq TEXT NOT NULL DEFAULT ''" },
  // 游客 QQ 头像（C2 扩展）：游客选填的 qq（仅抓取记账位，公开出参不携带）+ 服务端抓取转存的站内头像地址
  { table: 'comments', column: 'qq', ddl: "ALTER TABLE comments ADD COLUMN qq TEXT NOT NULL DEFAULT ''" },
  { table: 'comments', column: 'avatar', ddl: "ALTER TABLE comments ADD COLUMN avatar TEXT NOT NULL DEFAULT ''" },
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
  `CREATE TABLE IF NOT EXISTS pages (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    title       TEXT    NOT NULL,
    slug        TEXT    NOT NULL UNIQUE,
    content     TEXT    NOT NULL DEFAULT '',
    status      TEXT    NOT NULL DEFAULT 'draft',
    show_in_nav INTEGER NOT NULL DEFAULT 0,
    sort        INTEGER NOT NULL DEFAULT 0,
    created_at  INTEGER NOT NULL,
    updated_at  INTEGER NOT NULL
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
  // FTS5 全文索引（src/fts.ts，ROADMAP B4）：external content 挂原表省一份正文存储，
  // trigram 分词适配中文。虚表可以进 schema.sql（单条无分号体）；触发器只能在这里挂——
  // demo.ts 的 ensureTables 按分号朴素切分 SQL，切不开 CREATE TRIGGER 的 BEGIN...END 体，
  // 而 ensureSchema 是所有部署形态（生产 / 本地 / 演示）每次冷启动都会跑的通用迁移路径。
  // 虚表是可重建的派生索引：不进 BACKUP_TABLES，恢复备份后靠 ftsSeeded 记账位触发全量重建。
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
const SCHEMA_INDEXES = [
  'CREATE INDEX IF NOT EXISTS idx_comments_weibo ON comments (weibo_id, created_at)',
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
  // 回收站软删行极少：部分索引只收已删行，trash 面查询与 30 天到期清理免全表扫
  'CREATE INDEX IF NOT EXISTS idx_posts_deleted ON posts (deleted_at) WHERE deleted_at IS NOT NULL',
  'CREATE INDEX IF NOT EXISTS idx_weibo_deleted ON weibo (deleted_at) WHERE deleted_at IS NOT NULL',
  'CREATE INDEX IF NOT EXISTS idx_pages_deleted ON pages (deleted_at) WHERE deleted_at IS NOT NULL',
]

async function tableColumns(db: D1Database, table: string): Promise<Set<string>> {
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
  // 存量数据必须 rebuild 一次才可搜。settings 记账位保证只跑一回（幂等：备份恢复、
  // demo 清库重灌后 key 随 settings 消失，下一次冷启动会自动补重建）。触发器要在场才能
  // 保证增量，所以这步必须排在 SCHEMA_TRIGGERS 之后。
  const ftsSeeded = await db.prepare("SELECT value FROM settings WHERE key = 'ftsSeeded'").first<{ value: string }>()
  if (!ftsSeeded) {
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
}

export async function countUsers(db: D1Database): Promise<number> {
  const r = await db.prepare('SELECT COUNT(*) AS n FROM users').first<{ n: number }>()
  return r?.n ?? 0
}

export async function seedWelcomePost(db: D1Database, authorId: number): Promise<void> {
  const now = Date.now()
  const content = `<p>你好呀，这是你博客号的第一篇文章 👋</p><p>微信有<strong>公众号</strong>，你有<strong>博客号</strong>——不用申请、不用排队，注册账号的那一刻它就归你了，而且完全住在 <strong>Cloudflare</strong> 上：网页由 Workers 渲染，文字存进 D1，图片传到 R2，全世界的访客都很快，每月免费额度足够你写很多年。</p><h2>写作，就要轻松</h2><p>打开 <a href="/admin/">后台</a>，像写公众号一样写：标题、正文、封面、标签都在一屏里；截图直接 <strong>Ctrl/⌘ + V</strong> 粘贴进正文，图片自动传到你的 R2 图床。</p><blockquote>博客号，博客好。写作最好的状态：像发动态一样轻，像写文章一样认真。</blockquote><h3>试试这些</h3><ul><li>粘贴一张截图，体验自动上传</li><li>点右上角「体检」，检查排版是否符合微信排版规范</li><li>在「设置」里换一套主题：微信公众号风 / 纸墨 / 极简 / 夜航 / 手账</li></ul><p>现在，删掉这篇文章，写下属于你的第一篇吧。</p>`
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
