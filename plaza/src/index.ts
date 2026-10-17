/**
 * 博客号广场 hub —— 独立 Worker（与博客主仓库部署无关，见 plaza/README.md）。
 *
 * 职责：收各博客号 push 上来的文章/微博（HMAC 签名 ingest），RSS pull 补漏，
 * 混排后给官网 bloghao.com/plaza 输出 feed。收发两端协议见 docs/PLAZA.md。
 *
 * 形态延续内核预算：hono 单文件 + core.ts 纯函数，零额外依赖；注册/认证/权重是
 * hub 站长的管理面，用最简单的 Bearer Token（PLAZA_ADMIN_TOKEN secret），
 * v1 不做自助注册——站长逐站审核发 token，与「博客号目录」人工收录同一信任模型。
 */
import { Hono } from 'hono'
import type { Context } from 'hono'
import { cors } from 'hono/cors'
import {
  cleanVid,
  daySaltedHash,
  generatePlazaToken,
  maskPlazaToken,
  normalizePulledWeibo,
  parseRssItems,
  parseRssSiteTitle,
  pullHostOk,
  rssDateToMs,
  scoreFeed,
  spotlightWeight,
  statsDay,
  validateBeaconEvents,
  validateIngest,
  verifyPlazaSignature,
  type PlazaFeedEntry,
  type PlazaItem,
} from './core'

interface Env {
  DB: D1Database
  PLAZA_ADMIN_TOKEN: string
  /** 点赞/曝光的 IP/vid 天级哈希密钥（可选）：设了走 HMAC（私盐，库泄露不可枚举还原）；
   *  没设退化为 sha256(day:value) 兼容兜底——Workers 用 `wrangler secret put` 注入，
   *  Node 形态 demo/hub-node 会在未设时自动生成一枚并落盘。改它只影响当天去重（可接受） */
  PLAZA_HASH_SECRET?: string
}

/** 站点行（sites 表） */
interface SiteRow {
  id: number
  site_url: string
  site_name: string
  token: string
  verified: number
  weight: number
  disabled: number
  pull_enabled: number
  last_seen_at: number
  created_at: number
}

const app = new Hono<{ Bindings: Env }>()

/** 公开 API 统一 CORS：官网前台 fetch 用（无 Cookie 面开放 CORS 无风险；管理端点与 site-stats 不在此列） */
app.use('/api/feed', cors())
app.use('/api/sites', cors())
// 轻互动（P2）是 POST 但同样无 Cookie 面匿名计数：官网同域直用，开 CORS 兼容自建 hub 跨域页面
app.use('/api/like', cors())
app.use('/api/beacon', cors())

/* ---------------- 入站体积预检（对齐内核 api.ts 的同款闸） ----------------
 * 公开写入口（/api/like、/api/beacon 无需凭据）此前直接 `c.req.text()` 全量读体：
 * 超大 body（chunked 无 Content-Length 时平台闸也不看）会整读进内存放大 DoS——
 * 非 GET/HEAD/OPTIONS 先看 Content-Length，超限 413 短路；缺 CL 的请求再由各端点
 * 用 readTextLimited 流式限长兜底。合法上报远小于此（ingest 自身封顶 256KB）。 */
const MAX_BODY_BYTES = 512 * 1024

app.use('*', async (c, next) => {
  if (!['GET', 'HEAD', 'OPTIONS'].includes(c.req.method)) {
    const cl = Number(c.req.header('content-length') || 0)
    if (Number.isFinite(cl) && cl > MAX_BODY_BYTES) return c.json({ error: 'payload too large' }, 413)
  }
  await next()
})

/* ---------------- 调用统计（每日一行，供 ops 控制面 /api/admin/stats 出全局数据） ---------------- */

const STATS_FIELDS = ['feed_hits', 'sites_hits', 'ingest_hits', 'ingest_items'] as const
type StatsField = (typeof STATS_FIELDS)[number]

/** 计数 +1（n 用于 ingest 的 accepted 批量入账）：统计失败静默，绝不阻塞主流程 */
async function bumpStats(db: Env['DB'], field: StatsField, n = 1): Promise<void> {
  if (!STATS_FIELDS.includes(field)) return // hasOwnProperty 口径：字段只来自本文件白名单
  try {
    await db
      .prepare(`INSERT INTO stats (day, ${field}) VALUES (?, ?) ON CONFLICT(day) DO UPDATE SET ${field} = ${field} + ?`)
      .bind(statsDay(), n, n)
      .run()
  } catch {
    /* 库异常吞掉：少计一次无所谓，别影响 feed/ingest 本身 */
  }
}

/** 站点级互动日聚合 +n（P2）：views/clicks/likes 三个字段白名单收口，失败静默同 bumpStats。
 *  单站单字段单日增量封顶（BEACON_DAY_CAP）：/api/beacon 匿名无凭据、也无天级去重（「重放
 *  价值低」属既定口径），只能靠「限流 + 封顶」把「无限灌」压成有界值——防有人把任意真实站的
 *  数据卡刷成天文数字（真实小站远达不到此量级；该数据只站长自己看得到，不进公开 feed 排序）。
 *  UPDATE 路写 `MAX(旧值, MIN(旧值+n, 封顶))` 保**单调**——存量已超封顶的日子不会被下调 */
type SiteStatsField = 'views' | 'clicks' | 'likes'
const BEACON_DAY_CAP = 50_000
async function bumpSiteStats(db: Env['DB'], siteId: number, field: SiteStatsField, n: number): Promise<void> {
  try {
    await db
      .prepare(
        `INSERT INTO site_stats (day, site_id, ${field}) VALUES (?, ?, MIN(?, ${BEACON_DAY_CAP}))
         ON CONFLICT(day, site_id) DO UPDATE SET ${field} = MAX(${field}, MIN(${field} + ?, ${BEACON_DAY_CAP}))`
      )
      .bind(statsDay(), siteId, n, n)
      .run()
  } catch {
    /* 少计一次无所谓 */
  }
}

/**
 * 访客 IP：优先 cf-connecting-ip，否则 X-Forwarded-For 最后一跳。
 * Workers 形态：cf-connecting-ip 由 Cloudflare 边缘强制写入、客户端伪造不了，直接可信。
 * Node 形态：hub-node 的 applyTrustProxy 会按 TRUST_PROXY 档位**先剥掉客户端自带的
 * cf-connecting-ip / x-real-ip**、再把可信来源（XFF 末跳 / socket 远端）写回 cf-connecting-ip
 * ——所以这里读到的值一定是归一后的（与 docker-poc clientIp 同口径）；防的是「自带
 * cf-connecting-ip 伪造 IP」绕过按 IP 的点赞去重与限流。
 * 拿不到归并 0.0.0.0 共桶——限流宁紧勿松。
 */
function ipOf(c: Context<{ Bindings: Env }>): string {
  const cf = (c.req.header('cf-connecting-ip') || '').trim()
  if (cf) return cf
  const xff = c.req.header('x-forwarded-for') || ''
  const hops = xff.split(',').map((s) => s.trim()).filter(Boolean)
  return hops[hops.length - 1] || '0.0.0.0'
}

/** 管理面鉴权：Bearer PLAZA_ADMIN_TOKEN（hub 站长单管理员，与目录人工审核同一信任模型）。
 *  比较走常量时间（长度不等也扫完，避免逐字符提前退出的时序侧信道） */
function timingSafeEqualStr(a: string, b: string): boolean {
  const len = Math.max(a.length, b.length)
  let r = a.length === b.length ? 0 : 1
  for (let i = 0; i < len; i++) {
    r |= (a.charCodeAt(i) || 0) ^ (b.charCodeAt(i) || 0)
  }
  return r === 0
}

async function adminAuth(c: Context<{ Bindings: Env }>, next: () => Promise<void>) {
  const auth = c.req.header('authorization') || ''
  if (!c.env.PLAZA_ADMIN_TOKEN || !timingSafeEqualStr(auth, `Bearer ${c.env.PLAZA_ADMIN_TOKEN}`)) {
    return c.json({ error: 'unauthorized' }, 401)
  }
  await ensureSchemaExtras(c.env.DB) // admin 写路径（如 PATCH avatar）同样要求列已迁移
  await next()
}
app.use('/api/admin/*', adminAuth)

/* ---------------- ingest 限流（内存固定窗口，per-isolate 尽力而为） ---------------- */

const ingestBuckets = new Map<string, { n: number; reset: number }>()
function ingestRateLimit(key: string, limit: number, windowMs: number): boolean {
  const now = Date.now()
  if (ingestBuckets.size >= 5000) {
    for (const [k, v] of ingestBuckets) if (v.reset < now) ingestBuckets.delete(k)
    while (ingestBuckets.size >= 5000) {
      const oldest = ingestBuckets.keys().next().value
      if (oldest === undefined) break
      ingestBuckets.delete(oldest)
    }
  }
  const e = ingestBuckets.get(key)
  if (!e || e.reset < now) {
    ingestBuckets.set(key, { n: 1, reset: now + windowMs })
    return true
  }
  if (e.n >= limit) return false
  e.n++
  return true
}

/** JSON 解析兜底：坏 JSON 返回 null（ingest/管理端点回 400），不让异常打 500 */
function safeJsonParse(s: string): unknown {
  try {
    return JSON.parse(s || '{}')
  } catch {
    return null
  }
}

/** 响应体流式读入并限长，超限断流返回 null（plaza 目录保持自包含可独立部署，不引主仓库模块）。
 *  入参放宽到任意带 body 的对象（Response / Request 通用）。 */
async function readBodyLimited(src: { body: ReadableStream<Uint8Array> | null }, maxBytes: number): Promise<ArrayBuffer | null> {
  const reader = src.body?.getReader()
  if (!reader) return null
  const chunks: Uint8Array[] = []
  let total = 0
  try {
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      if (value) {
        total += value.byteLength
        if (total > maxBytes) {
          await reader.cancel().catch(() => undefined)
          return null
        }
        chunks.push(value)
      }
    }
  } catch {
    return null
  }
  const out = new Uint8Array(total)
  let off = 0
  for (const c of chunks) {
    out.set(c, off)
    off += c.byteLength
  }
  return out.buffer
}

/** 读请求体并限长（Content-Length 缺失 / chunked 时的兜底）：超限或异常返回 null（调用方回 413） */
async function readTextLimited(req: Request, maxBytes: number): Promise<string | null> {
  const buf = await readBodyLimited(req, maxBytes)
  return buf ? new TextDecoder().decode(buf) : null
}

/** 天级哈希密钥（P2 隐私）：设了走 HMAC 私盐；没设退化为 sha256(day:value)，功能一致、隐私弱一档 */
function hashSecret(env: Env): string {
  return (env.PLAZA_HASH_SECRET || '').trim()
}

/* ---------------- 公开面 ---------------- */

/** feed：混排出参。candidates 取最近 300 条（量纲按社区几百站设计，够用很久）。
 *  P0.1 起支持 ?site=N 站点视图（官网站点页数据面）；聚光期站点（P0.4）weight 临时 +2 档 */
app.get('/api/feed', async (c) => {
  await ensureSchemaExtras(c.env.DB)
  c.header('Cache-Control', 'public, max-age=60')
  const limit = Math.max(1, Math.min(100, Number(c.req.query('limit')) || 30))
  const kind = c.req.query('kind')
  const kindFilter = kind === 'post' || kind === 'weibo' ? kind : null
  // site 参数：正整数才进过滤，其余按没传处理（不 400——与 kind 非法值同口径）
  const siteQ = Number(c.req.query('site'))
  const siteFilter = Number.isInteger(siteQ) && siteQ > 0 ? siteQ : null
  let site: { id: number; name: string; url: string; avatar: string; verified: number; createdAt: number } | null = null
  if (siteFilter) {
    const row = await c.env.DB.prepare(
      'SELECT id, site_name AS name, site_url AS url, avatar, verified, created_at AS createdAt, disabled FROM sites WHERE id = ?'
    )
      .bind(siteFilter)
      .first<{ id: number; name: string; url: string; avatar: string; verified: number; createdAt: number; disabled: number }>()
    // 查无此站 / 已停用一律 404 不透露细节；站点视图需要站名/头像/主址渲染页头
    if (!row || row.disabled) return c.json({ error: 'site not found' }, 404)
    site = { id: row.id, name: row.name, url: row.url, avatar: row.avatar, verified: row.verified, createdAt: row.createdAt }
  }
  const sql = `
    SELECT i.id, i.kind, i.ref, i.title, i.summary, i.url, i.image, i.published_at AS publishedAt, i.likes,
           s.id AS siteId, s.site_name AS siteName, s.site_url AS siteUrl, s.created_at AS siteCreatedAt,
           s.avatar AS siteAvatar, s.verified AS siteVerified, s.weight AS siteWeight
    FROM items i JOIN sites s ON s.id = i.site_id
    WHERE s.disabled = 0 AND i.hidden = 0 ${kindFilter ? 'AND i.kind = ?' : ''} ${siteFilter ? 'AND s.id = ?' : ''}
    ORDER BY i.published_at DESC LIMIT 300`
  const { results } = await c.env.DB.prepare(sql)
    .bind(...[kindFilter, siteFilter].filter((v): v is string | number => v !== null))
    .all<{
      id: number
      kind: PlazaItem['kind']
      ref: string
      title: string
      summary: string
      url: string
      image: string
      publishedAt: number
      likes: number
      siteId: number
      siteName: string
      siteUrl: string
      siteCreatedAt: number
      siteAvatar: string
      siteVerified: number
      siteWeight: number
    }>()
  const now = Date.now()
  const feed: PlazaFeedEntry[] = scoreFeed(
    (results ?? []).map((r) => ({
      // scoreFeed 的入参是 { item, siteId, … } 包裹形状，SQL 扁平行要按契约组装
      item: {
        kind: r.kind,
        ref: r.ref,
        title: r.title,
        summary: r.summary,
        url: r.url,
        image: r.image,
        publishedAt: r.publishedAt,
      },
      id: r.id,
      likes: r.likes,
      siteId: r.siteId,
      siteName: r.siteName,
      siteUrl: r.siteUrl,
      siteAvatar: r.siteAvatar || '',
      siteVerified: r.siteVerified === 1,
      // 新站聚光（P0.4）：7 天内注册的站 weight 临时 +2 档（封顶 10），评分前套用
      siteWeight: spotlightWeight(r.siteWeight, r.siteCreatedAt, now),
    })),
    limit
  )
  await bumpStats(c.env.DB, 'feed_hits')
  return c.json({
    feed,
    ...(site
      ? {
          site: {
            id: site.id,
            name: site.name,
            url: site.url,
            avatar: site.avatar,
            verified: site.verified === 1,
            createdAt: site.createdAt,
          },
        }
      : {}),
  })
})

/** 站点名录：官网「收录了哪些博客号」与广场页侧栏共用。
 *  P1 起带 recentItems（近 7 日条数）——侧栏活跃榜与最新入驻位的数据面 */
app.get('/api/sites', async (c) => {
  await ensureSchemaExtras(c.env.DB)
  c.header('Cache-Control', 'public, max-age=60')
  const weekAgo = Date.now() - 7 * 86_400_000
  const { results } = await c.env.DB.prepare(
    `SELECT s.id, s.site_url AS url, s.site_name AS name, s.avatar, s.verified,
            s.created_at AS createdAt,
            (SELECT COUNT(*) FROM items i WHERE i.site_id = s.id) AS items,
            (SELECT COUNT(*) FROM items i WHERE i.site_id = s.id AND i.published_at >= ?) AS recentItems
     FROM sites s WHERE s.disabled = 0 ORDER BY s.verified DESC, s.created_at ASC LIMIT 200`
  )
    .bind(weekAgo)
    .all()
  await bumpStats(c.env.DB, 'sites_hits')
  return c.json({ sites: results ?? [] })
})

app.get('/', (c) =>
  c.html(
    `<!DOCTYPE html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="robots" content="noindex"><title>博客号广场 hub</title></head>
<body><p>博客号广场数据服务。<a href="https://bloghao.com/plaza/">去官网看广场 →</a>　<a href="https://github.com/bloghao/bloghao/blob/main/docs/PLAZA.md">接入文档</a></p></body></html>`
  )
)

/* ---------------- 轻互动（P2）：匿名点赞 / 曝光点击回传 / 站长数据卡 ----------------
 * 隐私红线（PLAZA-2.0-PLAN）：互动一律匿名聚合计数——不存原始 IP / vid，
 * 只存「北京日 + 当日盐」sha256；无账号无 Cookie 面，防刷靠天级去重 + 双层限流。 */

/** 点赞限流口径（拍板建议采纳）：每 IP 每条 1 次/天（likes 表主键去重）、每会话 60 次/天、
 *  每 IP 全场 200 次/天（NAT 后多人共用宽限）。内存层另加每 IP 30 次/分的提交频率闸 */
const LIKE_VID_DAILY = 60
const LIKE_IP_DAILY = 200

app.post('/api/like', async (c) => {
  await ensureSchemaExtras(c.env.DB)
  const raw = await readTextLimited(c.req.raw, MAX_BODY_BYTES)
  if (raw === null) return c.json({ error: 'payload too large' }, 413)
  const body = safeJsonParse(raw) as { itemId?: unknown; vid?: unknown } | null
  const itemId = Math.round(Number(body?.itemId))
  const vid = cleanVid(body?.vid)
  if (!Number.isInteger(itemId) || itemId <= 0 || !vid) return c.json({ error: 'bad params' }, 400)
  const ip = ipOf(c)
  if (!ingestRateLimit(`like:${ip}`, 30, 60_000)) return c.json({ error: 'too many requests' }, 429)
  const item = await c.env.DB.prepare('SELECT id, site_id FROM items WHERE id = ? AND hidden = 0')
    .bind(itemId)
    .first<{ id: number; site_id: number }>()
  if (!item) return c.json({ error: 'item not found' }, 404)
  const day = statsDay()
  const secret = hashSecret(c.env)
  const ipHash = await daySaltedHash(day, ip, secret)
  const vidHash = await daySaltedHash(day, vid, secret)
  // 会话/全场限额：计的是当日去重日志行数，超限 429（前台按「今天赞得够多了」提示）
  const vidCount = await c.env.DB.prepare('SELECT COUNT(*) AS n FROM likes WHERE day = ? AND vid_hash = ?')
    .bind(day, vidHash)
    .first<{ n: number }>()
  if ((vidCount?.n ?? 0) >= LIKE_VID_DAILY) return c.json({ error: 'daily limit' }, 429)
  const ipCount = await c.env.DB.prepare('SELECT COUNT(*) AS n FROM likes WHERE day = ? AND ip_hash = ?')
    .bind(day, ipHash)
    .first<{ n: number }>()
  if ((ipCount?.n ?? 0) >= LIKE_IP_DAILY) return c.json({ error: 'daily limit' }, 429)
  // 主键 (day, item_id, ip_hash) 即「每 IP 每条 1 次/天」：INSERT OR IGNORE 撞键 = 今天已赞过
  const ins = await c.env.DB.prepare(
    'INSERT OR IGNORE INTO likes (day, item_id, ip_hash, vid_hash, created_at) VALUES (?, ?, ?, ?, ?)'
  )
    .bind(day, itemId, ipHash, vidHash, Date.now())
    .run()
  if ((ins.meta.changes ?? 0) < 1) return c.json({ ok: true, duplicate: true })
  const upd = await c.env.DB.prepare('UPDATE items SET likes = likes + 1 WHERE id = ?').bind(itemId).run()
  if ((upd.meta.changes ?? 0) > 0) await bumpSiteStats(c.env.DB, item.site_id, 'likes', 1)
  const row = await c.env.DB.prepare('SELECT likes FROM items WHERE id = ?').bind(itemId).first<{ likes: number }>()
  return c.json({ ok: true, likes: row?.likes ?? 0 })
})

/** 曝光/点击批量回传（P2.2）：官网页攒批（10 条 / 30 秒 / 离页 sendBeacon）合并上报，
 *  无 IP 无指纹（vid 只进天级哈希限不了重放但重放只多计 ≤20/条，价值低）；写前校验站点存在。
 *  匿名无凭据面：防刷靠「限流（10/分/IP）+ 单站单日封顶（bumpSiteStats 的 BEACON_DAY_CAP）」，
 *  不引额外表/凭据（重放只把数字灌到封顶值，不无限膨胀） */
app.post('/api/beacon', async (c) => {
  await ensureSchemaExtras(c.env.DB)
  const ip = ipOf(c)
  if (!ingestRateLimit(`beacon:${ip}`, 10, 60_000)) return c.json({ error: 'too many requests' }, 429)
  const raw = await readTextLimited(c.req.raw, MAX_BODY_BYTES)
  if (raw === null) return c.json({ error: 'payload too large' }, 413)
  const body = safeJsonParse(raw) as { events?: unknown } | null
  const events = validateBeaconEvents(body?.events)
  if (!events.length) return c.json({ ok: true, accepted: 0 })
  // 只认真实存在的站点：一次 IN 校验，伪造 site_id 的条目整批剔除（防任意行膨胀 site_stats）
  const ids = [...new Set(events.map((e) => e.s))]
  const placeholders = ids.map(() => '?').join(',')
  const { results } = await c.env.DB.prepare(`SELECT id FROM sites WHERE id IN (${placeholders})`)
    .bind(...ids)
    .all<{ id: number }>()
  const known = new Set((results ?? []).map((r) => r.id))
  let accepted = 0
  for (const e of events) {
    if (!known.has(e.s)) continue
    await bumpSiteStats(c.env.DB, e.s, e.k === 'v' ? 'views' : 'clicks', e.n)
    accepted += e.n
  }
  return c.json({ ok: true, accepted })
})

/** 站长数据卡（P2.3）：「广场同步」插件设置卡的数据面。token 即身份（与 ingest 同一枚，
 *  **只认 X-Plaza-Token 头**——长期令牌不进 URL（?token= 会落进代理/访问日志与 Referer）
 *  与 ingest 同口径）；出参只含本站聚合，Cache-Control no-store */
app.get('/api/site-stats', async (c) => {
  await ensureSchemaExtras(c.env.DB)
  const token = (c.req.header('x-plaza-token') || '').trim()
  if (!/^[0-9a-f]{32}$/.test(token)) return c.json({ error: 'bad token' }, 401)
  if (!ingestRateLimit(`sstats:${ipOf(c)}`, 30, 60_000)) return c.json({ error: 'too many requests' }, 429)
  const site = await c.env.DB.prepare(
    'SELECT id, site_name AS name, site_url AS url FROM sites WHERE token = ? AND disabled = 0'
  )
    .bind(token)
    .first<{ id: number; name: string; url: string }>()
  // 查无此站与已停用同一句 401（与 ingest 不透露存在性同口径）
  if (!site) return c.json({ error: 'unauthorized' }, 401)
  const weekAgo = statsDay(Date.now() - 7 * 86_400_000)
  const [totals, days, items] = await Promise.all([
    // 点赞累计以 items.likes 为权威（全生命周期）；曝光/点击从 P2.2 上线日起才有数
    c.env.DB
      .prepare(
        `SELECT
           (SELECT COALESCE(SUM(likes), 0) FROM items WHERE site_id = ?) AS likes,
           (SELECT COALESCE(SUM(views), 0) FROM site_stats WHERE site_id = ?) AS views,
           (SELECT COALESCE(SUM(clicks), 0) FROM site_stats WHERE site_id = ?) AS clicks`
      )
      .bind(site.id, site.id, site.id)
      .first<{ likes: number; views: number; clicks: number }>(),
    c.env.DB
      .prepare(
        'SELECT day, views, clicks, likes FROM site_stats WHERE site_id = ? AND day >= ? ORDER BY day ASC LIMIT 7'
      )
      .bind(site.id, weekAgo)
      .all(),
    c.env.DB.prepare('SELECT COUNT(*) AS n FROM items WHERE site_id = ?').bind(site.id).first<{ n: number }>(),
  ])
  return c.json(
    {
      site: { id: site.id, name: site.name, url: site.url },
      items: items?.n ?? 0,
      totals: { views: totals?.views ?? 0, clicks: totals?.clicks ?? 0, likes: totals?.likes ?? 0 },
      days: days.results ?? [],
    },
    // token 只走请求头（不进 URL/日志）；响应仍明确不可缓存
    { headers: { 'Cache-Control': 'no-store' } }
  )
})

/* ---------------- push ingest（博客端「广场同步」插件上报） ---------------- */

app.post('/api/ingest', async (c) => {
  const token = (c.req.header('X-Plaza-Token') || '').trim()
  const ts = c.req.header('X-Plaza-Timestamp') || ''
  const sig = c.req.header('X-Plaza-Signature') || ''
  if (!/^[0-9a-f]{32}$/.test(token)) return c.json({ error: 'bad token' }, 401)
  // 签名校验前的粗限流：签名校验本身不贵，但别让匿名流量无成本打穿 D1 查询（per-isolate 尽力而为）
  if (!ingestRateLimit(`ing:${token}`, 60, 60_000)) return c.json({ error: 'too many requests' }, 429)
  const site = await c.env.DB.prepare('SELECT id, disabled FROM sites WHERE token = ?')
    .bind(token)
    .first<{ id: number; disabled: number }>()
  // token 即身份：查无此站 / 已停用一律同一句 401，不区分原因不透露存在性
  if (!site || site.disabled) return c.json({ error: 'unauthorized' }, 401)
  const rawBody = await readTextLimited(c.req.raw, MAX_BODY_BYTES)
  if (rawBody === null) return c.json({ error: 'payload too large' }, 413)
  // 防爆库：超 256KB 的签名请求直接拒（合法上报 50 条封顶远用不满）
  if (rawBody.length > 256 * 1024) return c.json({ error: 'payload too large' }, 413)
  if (!(await verifyPlazaSignature(token, ts, sig, rawBody))) {
    return c.json({ error: 'bad signature' }, 401)
  }
  const parsed = validateIngest(safeJsonParse(rawBody))
  if (!parsed) return c.json({ error: 'bad body' }, 400)
  const { items, deleted } = parsed
  if (parsed.avatar) {
    await c.env.DB.prepare('UPDATE sites SET avatar = ? WHERE id = ?').bind(parsed.avatar, site.id).run()
  }
  let accepted = 0
  for (const it of items) {
    // 站内 ref 唯一：重发同一篇 = 更新（编辑标题/摘要后重推即生效），幂等；
    // push 永远盖 pull（source 置回 push），pull 只是存在性兜底。
    // hidden 不进 conflict 更新：管理员下架（UPDATE items SET hidden=1）不能被站长
    // 重推同一 ref 推翻——重推只更新内容字段，隐藏位保留现值
    await c.env.DB.prepare(
      `INSERT INTO items (site_id, kind, ref, title, summary, url, image, published_at, source, hidden, synced_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'push', 0, ?)
       ON CONFLICT(site_id, kind, ref) DO UPDATE SET
         title = excluded.title, summary = excluded.summary, url = excluded.url,
         image = excluded.image, published_at = excluded.published_at,
         source = 'push', synced_at = excluded.synced_at`
    )
      .bind(site.id, it.kind, it.ref, it.title, it.summary, it.url, it.image, it.publishedAt, Date.now())
      .run()
    accepted++
  }
  for (const d of deleted) {
    await c.env.DB.prepare('DELETE FROM items WHERE site_id = ? AND kind = ? AND ref = ?')
      .bind(site.id, d.kind, d.ref)
      .run()
  }
  // 活跃心跳：后台站点列表按它看「谁还在推」；180 天无心跳 cron 自动休眠
  await c.env.DB.prepare('UPDATE sites SET last_seen_at = ? WHERE id = ?').bind(Date.now(), site.id).run()
  await bumpStats(c.env.DB, 'ingest_hits')
  if (accepted > 0) await bumpStats(c.env.DB, 'ingest_items', accepted)
  return c.json({ ok: true, accepted })
})

/* ---------------- 老库迁移 ---------------- */

let schemaExtrasDone = false

/**
 * 老库惰性迁移：新库 schema.sql 已含全部列/表（CREATE IF NOT EXISTS 不补老列），
 * 这里对存量库补齐——列 ALTER 撞「已存在」吞掉即幂等，新表/索引用 IF NOT EXISTS 天然幂等。
 * 两种部署形态（Workers D1 / hub-node node:sqlite）都走这里，升级不再需要手工 execute schema。
 */
async function ensureSchemaExtras(db: Env['DB']): Promise<void> {
  if (schemaExtrasDone) return
  schemaExtrasDone = true
  for (const stmt of [
    "ALTER TABLE sites ADD COLUMN avatar TEXT NOT NULL DEFAULT ''",
    'ALTER TABLE items ADD COLUMN likes INTEGER NOT NULL DEFAULT 0',
    `CREATE TABLE IF NOT EXISTS likes (
      day TEXT NOT NULL,
      item_id INTEGER NOT NULL,
      ip_hash TEXT NOT NULL,
      vid_hash TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      PRIMARY KEY (day, item_id, ip_hash)
    )`,
    'CREATE INDEX IF NOT EXISTS idx_likes_vid ON likes(day, vid_hash)',
    `CREATE TABLE IF NOT EXISTS site_stats (
      day TEXT NOT NULL,
      site_id INTEGER NOT NULL,
      views INTEGER NOT NULL DEFAULT 0,
      clicks INTEGER NOT NULL DEFAULT 0,
      likes INTEGER NOT NULL DEFAULT 0,
      PRIMARY KEY (day, site_id)
    )`,
  ]) {
    try {
      await db.prepare(stmt).run()
    } catch {
      /* 已存在：幂等迁移 */
    }
  }
}

/* ---------------- 管理面 ---------------- */

/** 全局统计（ops 控制面消费）：站点 / 内容 / 今日与累计调用 / 近 14 天趋势。
 *  单位口径：feed_hits ≈ 广场页访问量（页面加载即拉 feed）；ingest = 站点上报次数 */
app.get('/api/admin/stats', async (c) => {
  const num = (v: unknown): number => Number(v) || 0
  const since24h = Date.now() - 86_400_000
  const one = async (sql: string, ...bind: (string | number)[]): Promise<Record<string, unknown>> => {
    try {
      return ((await c.env.DB.prepare(sql).bind(...bind).first()) ?? {}) as Record<string, unknown>
    } catch {
      return {}
    }
  }
  const [sites, items, today, total, daily] = await Promise.all([
    one(
      `SELECT COUNT(*) AS total,
              SUM(CASE WHEN disabled = 0 THEN 1 ELSE 0 END) AS active,
              SUM(CASE WHEN verified = 1 THEN 1 ELSE 0 END) AS verified
       FROM sites`
    ),
    one(
      `SELECT COUNT(*) AS total,
              SUM(CASE WHEN kind = 'post' THEN 1 ELSE 0 END) AS posts,
              SUM(CASE WHEN kind = 'weibo' THEN 1 ELSE 0 END) AS weibo,
              SUM(CASE WHEN synced_at >= ? THEN 1 ELSE 0 END) AS last24h
       FROM items`,
      since24h
    ),
    one(
      `SELECT feed_hits AS feed, sites_hits AS sites, ingest_hits AS ingest, ingest_items AS items
       FROM stats WHERE day = ?`,
      statsDay()
    ),
    one(
      `SELECT SUM(feed_hits) AS feed, SUM(sites_hits) AS sites, SUM(ingest_hits) AS ingest, SUM(ingest_items) AS items
       FROM stats`
    ),
    c.env.DB
      .prepare(`SELECT day, feed_hits AS feed, ingest_hits AS ingest, ingest_items AS items FROM stats ORDER BY day DESC LIMIT 14`)
      .all()
      .then((r) => (r.results ?? []).reverse())
      .catch(() => []),
  ])
  return c.json({
    sites: { total: num(sites.total), active: num(sites.active), verified: num(sites.verified) },
    items: { total: num(items.total), posts: num(items.posts), weibo: num(items.weibo), last24h: num(items.last24h) },
    today: { day: statsDay(), feed: num(today.feed), sites: num(today.sites), ingest: num(today.ingest), items: num(today.items) },
    total: { feed: num(total.feed), sites: num(total.sites), ingest: num(total.ingest), items: num(total.items) },
    daily,
  })
})

/** 注册站点：token 明文只在创建返回这一次（与内核 SECRET_SETTINGS 同口径），丢了就 rotate */
app.post('/api/admin/sites', async (c) => {
  const body = await c.req.json<{ url?: string; name?: string }>().catch(() => null)
  const url = (body?.url || '').trim().replace(/\/+$/, '')
  const name = (body?.name || '').trim().slice(0, 100) || url.replace(/^https?:\/\//, '')
  if (!/^https:\/\/[a-z0-9.-]+\.[a-z]{2,}/i.test(url)) return c.json({ error: '需要 https:// 开头的站点地址' }, 400)
  if (!pullHostOk(url)) return c.json({ error: '不接受该站点地址（内网后缀 / IP 字面量）' }, 400)
  const token = generatePlazaToken()
  try {
    await c.env.DB.prepare(
      'INSERT INTO sites (site_url, site_name, token, verified, weight, disabled, pull_enabled, last_seen_at, created_at) VALUES (?, ?, ?, 0, 1, 0, 1, 0, ?)'
    )
      .bind(url, name, token, Date.now())
      .run()
  } catch {
    return c.json({ error: '该站点已注册（site_url 唯一），可在列表里 rotate token' }, 409)
  }
  const row = await c.env.DB.prepare('SELECT id FROM sites WHERE token = ?').bind(token).first<{ id: number }>()
  return c.json({ ok: true, id: row?.id, token })
})

app.get('/api/admin/sites', async (c) => {
  const { results } = await c.env.DB.prepare(
    `SELECT id, site_url AS url, site_name AS name, avatar, token, verified, weight, disabled, pull_enabled AS pullEnabled,
            last_seen_at AS lastSeenAt, created_at AS createdAt,
            (SELECT COUNT(*) FROM items i WHERE i.site_id = sites.id) AS items
     FROM sites ORDER BY created_at DESC LIMIT 500`
  ).all<{ token: string }>()
  // token 明文只在创建/rotate 返回这一次，列表一律打码
  const sites = (results ?? []).map((r) => ({ ...r, token: maskPlazaToken(r.token) }))
  return c.json({ sites })
})

/** 局部更新：改名 / 认证徽标 / 权重 / 停用 / pull 开关 / 换 token（rotate） */
app.patch('/api/admin/sites/:id', async (c) => {
  const id = Number(c.req.param('id'))
  if (!Number.isInteger(id) || id <= 0) return c.json({ error: 'bad id' }, 400)
  const body = await c.req.json<Record<string, unknown>>().catch(() => null)
  if (!body) return c.json({ error: 'bad body' }, 400)
  const site = await c.env.DB.prepare('SELECT id FROM sites WHERE id = ?').bind(id).first()
  if (!site) return c.json({ error: '站点不存在' }, 404)
  const patch: string[] = []
  const args: (string | number)[] = []
  if ('name' in body) {
    patch.push('site_name = ?')
    args.push(String(body.name ?? '').trim().slice(0, 100))
  }
  if ('avatar' in body) {
    // https 白名单与 ingest 上报同口径；空串 = 清除头像（回落 favicon/首字）
    patch.push('avatar = ?')
    args.push(/^https:\/\//i.test(String(body.avatar ?? '').trim()) ? String(body.avatar).trim().slice(0, 500) : '')
  }
  if ('verified' in body) {
    patch.push('verified = ?')
    args.push(body.verified ? 1 : 0)
  }
  if ('weight' in body) {
    const w = Math.round(Number(body.weight))
    patch.push('weight = ?')
    args.push(Number.isFinite(w) ? Math.min(10, Math.max(0, w)) : 1)
  }
  if ('disabled' in body) {
    patch.push('disabled = ?')
    args.push(body.disabled ? 1 : 0)
  }
  if ('pullEnabled' in body) {
    patch.push('pull_enabled = ?')
    args.push(body.pullEnabled ? 1 : 0)
  }
  if ('rotateToken' in body && body.rotateToken) {
    patch.push('token = ?')
    args.push(generatePlazaToken())
  }
  if (patch.length) {
    await c.env.DB.prepare(`UPDATE sites SET ${patch.join(', ')} WHERE id = ?`)
      .bind(...args, id)
      .run()
  }
  const row = await c.env.DB.prepare(
    'SELECT id, site_url AS url, site_name AS name, avatar, token, verified, weight, disabled, pull_enabled AS pullEnabled FROM sites WHERE id = ?'
  )
    .bind(id)
    .first<{ token: string }>()
  // rotate 时新 token 明文返回一次（发给站长），其余情况打码
  const rotated = 'rotateToken' in body && body.rotateToken
  return c.json({
    ok: true,
    site: row ? { ...row, token: maskPlazaToken(row.token) } : null,
    ...(rotated && row ? { token: row.token } : {}),
  })
})

/** 删站级联清内容（子行先删再删主行，与内核回收站级联同一顺序纪律；内容无回收站——hub 是派生数据，源站永远在自己手里） */
app.delete('/api/admin/sites/:id', async (c) => {
  const id = Number(c.req.param('id'))
  if (!Number.isInteger(id) || id <= 0) return c.json({ error: 'bad id' }, 400)
  await c.env.DB.prepare('DELETE FROM items WHERE site_id = ?').bind(id).run()
  await c.env.DB.prepare('DELETE FROM sites WHERE id = ?').bind(id).run()
  return c.json({ ok: true })
})

/** 单条下架/恢复（违规内容处置，不等站长自己删） */
app.patch('/api/admin/items/:kind/:ref', async (c) => {
  const kind = c.req.param('kind')
  if (kind !== 'post' && kind !== 'weibo') return c.json({ error: 'bad kind' }, 400)
  const ref = (c.req.param('ref') || '').slice(0, 200)
  const siteId = Number(c.req.query('siteId'))
  if (!Number.isInteger(siteId) || siteId <= 0 || !ref) return c.json({ error: 'bad params' }, 400)
  const body = await c.req.json<{ hidden?: boolean }>().catch(() => null)
  await c.env.DB.prepare('UPDATE items SET hidden = ? WHERE site_id = ? AND kind = ? AND ref = ?')
    .bind(body?.hidden ? 1 : 0, siteId, kind, ref)
    .run()
  return c.json({ ok: true })
})

/** 手动触发全站补漏（ops）：不等 6 小时 cron，新接入站点 / 新上线的微博补漏口可立即对齐 */
app.post('/api/admin/pull', async (c) => {
  const pulled = await pullAllSites(c.env)
  return c.json({ ok: true, pulled })
})

/* ---------------- RSS pull 补漏（cron 每 6 小时） ---------------- */

const PULL_UA = 'BlogHaoPlaza/1.0 (+https://bloghao.com/plaza/)'
const PULL_MAX_REDIRECTS = 5
const PULL_TIMEOUT_MS = 15_000

/**
 * pull 抓取（SSRF 防线）：起始地址与每一跳重定向目标都要过 pullHostOk 公网主机判定，
 * 只跟 https 跳（不降级）。被 pull 站点是第三方可控的——`redirect:'follow'` 会让
 * 「已注册站 302 到 http://169.254.169.254/」直通内网，故手动跟跳逐跳复查。
 * Node(undici) 的 manual 重定向返回 opaqueredirect（拿不到目标）→ 直接放弃该次抓取
 * （与内核 fetchsafe 同取舍：Workers 下是真实 3xx 正常跟跳，Node 下不跟跳）。
 * 返回 null = 抓不到（调用方按缺失处理，不阻塞其余补漏）。 */
async function fetchPullTarget(rawUrl: string): Promise<Response | null> {
  let u: URL
  try {
    u = new URL(rawUrl)
  } catch {
    return null
  }
  for (let hop = 0; hop <= PULL_MAX_REDIRECTS; hop++) {
    if (u.protocol !== 'https:' || !pullHostOk(u.href)) return null
    let res: Response
    try {
      res = await fetch(u.href, { headers: { 'user-agent': PULL_UA }, redirect: 'manual', signal: AbortSignal.timeout(PULL_TIMEOUT_MS) })
    } catch {
      return null
    }
    if ((res as { type?: string }).type === 'opaqueredirect') return null
    if (res.status >= 300 && res.status < 400) {
      const loc = res.headers.get('location')
      if (!loc) return null
      try {
        u = new URL(loc, u)
      } catch {
        return null
      }
      continue
    }
    return res.ok ? res : null
  }
  return null
}

/** pull 只做存在性兜底：单站单次 20 条、只灌 30 天内旧文、绝不覆盖 push 数据（source 守卫） */
async function pullSiteRss(env: Env, site: SiteRow): Promise<number> {
  const res = await fetchPullTarget(`${site.site_url}/rss.xml`)
  if (!res) return 0
  // RSS 读体流式限长：被 pull 的站点是第三方，超大响应（gzip 炸弹等）不能整读进内存
  const buf = await readBodyLimited(res, 2 * 1024 * 1024)
  if (!buf) return 0
  const xml = new TextDecoder().decode(buf)
  // 站点名回填（P0.2）：站没起名（空或还是注册时的裸域名默认值）时从 RSS channel title 补；
  // 站长起过的名字绝不覆盖——判定「裸域名默认值」按注册端点同一推导（url 去协议头）
  const rssTitle = parseRssSiteTitle(xml)
  if (rssTitle) {
    const defaultName = site.site_url.replace(/^https?:\/\//, '')
    if (!site.site_name || site.site_name === defaultName) {
      await env.DB.prepare('UPDATE sites SET site_name = ? WHERE id = ?').bind(rssTitle, site.id).run()
    }
  }
  const entries = parseRssItems(xml, 20)
  let n = 0
  for (const e of entries) {
    // 锁文/密码文不进广场（RSS 里的 bloghao:locked 标志，与 push 路 locked 口径一致）；
    // 非 https 链接同样不收（push 路 safeUrl 只收 https，pull 不做例外）
    if (e.locked || !/^https:\/\//i.test(e.link)) continue
    const publishedAt = rssDateToMs(e.pubDate)
    if (Date.now() - publishedAt > 30 * 86_400_000) continue
    const slug = e.link.replace(/^https?:\/\/[^/]+\/post\//, '').replace(/\/+$/, '').slice(0, 200)
    if (!slug) continue
    await env.DB.prepare(
      `INSERT INTO items (site_id, kind, ref, title, summary, url, image, published_at, source, hidden, synced_at)
       VALUES (?, 'post', ?, ?, ?, ?, '', ?, 'pull', 0, ?)
       ON CONFLICT(site_id, kind, ref) DO UPDATE SET
         title = excluded.title, summary = excluded.summary, synced_at = excluded.synced_at
       WHERE items.source = 'pull'`
    )
      .bind(site.id, slug, e.title || slug, e.description.replace(/<[^>]+>/g, '').trim().slice(0, 500), e.link, publishedAt, Date.now())
      .run()
    n++
  }
  return n
}

/** 微博补漏：站点可选提供 GET /api/public/weibo（出参与 ingest 条目同形，见 docs/PLAZA.md）。
 *  RSS 只覆盖文章，微博漏推（发布瞬间推送失败即永久丢失）没有别的自愈路；
 *  没有该接口的站点 404 / 非 JSON 静默跳过，不影响其余补漏。 */
async function pullSiteWeibo(env: Env, site: SiteRow): Promise<number> {
  const res = await fetchPullTarget(`${site.site_url}/api/public/weibo?limit=20`)
  if (!res) return 0
  const buf = await readBodyLimited(res, 2 * 1024 * 1024)
  if (!buf) return 0
  let list: Array<Record<string, unknown>>
  try {
    const data = JSON.parse(new TextDecoder().decode(buf)) as { weibo?: unknown } | null
    list = Array.isArray(data?.weibo) ? (data.weibo as Array<Record<string, unknown>>) : []
  } catch {
    return 0
  }
  let n = 0
  for (const w of list) {
    const item = normalizePulledWeibo(w)
    if (!item) continue
    await env.DB.prepare(
      `INSERT INTO items (site_id, kind, ref, title, summary, url, image, published_at, source, hidden, synced_at)
       VALUES (?, 'weibo', ?, ?, ?, ?, ?, ?, 'pull', 0, ?)
       ON CONFLICT(site_id, kind, ref) DO UPDATE SET
         title = excluded.title, summary = excluded.summary, synced_at = excluded.synced_at
       WHERE items.source = 'pull'`
    )
      .bind(site.id, item.ref, item.title, item.summary, item.url, item.image, item.publishedAt, Date.now())
      .run()
    n++
  }
  return n
}

/** 全站补漏：RSS（文章）+ 微博补漏口（可选），单站失败不影响其余 */
async function pullAllSites(env: Env): Promise<number> {
  let pulled = 0
  const { results } = await env.DB.prepare(
    'SELECT * FROM sites WHERE disabled = 0 AND pull_enabled = 1 LIMIT 500'
  ).all<SiteRow>()
  for (const site of results ?? []) {
    try {
      pulled += await pullSiteRss(env, site)
      pulled += await pullSiteWeibo(env, site)
    } catch {
      /* 单站失败不影响其余 */
    }
  }
  return pulled
}

/** cron：pull 补漏 + 顺手把 180 天无心跳的站点自动休眠（不删站，管理员回来重新启用即可） +
 *  点赞去重日志清理（只服务当天去重，7 天前的行无用——表恒小） */
export async function scheduledCron(env: Env): Promise<{ pulled: number; dormant: number }> {
  let pulled = 0
  let dormant = 0
  try {
    pulled = await pullAllSites(env)
    const r = await env.DB.prepare(
      'UPDATE sites SET disabled = 1 WHERE disabled = 0 AND last_seen_at > 0 AND last_seen_at < ?'
    )
      .bind(Date.now() - 180 * 86_400_000)
      .run()
    dormant = r.meta.changes ?? 0
    await env.DB.prepare('DELETE FROM likes WHERE day < ?').bind(statsDay(Date.now() - 7 * 86_400_000)).run()
  } catch {
    /* 库异常静默：cron 下一轮再来 */
  }
  return { pulled, dormant }
}

export default {
  fetch: app.fetch,
  scheduled: (_event: unknown, env: Env, ctx: { waitUntil: (p: Promise<unknown>) => void }) => {
    ctx.waitUntil(scheduledCron(env))
  },
}
