/**
 * 广场 hub 核心纯函数：签名校验 / 入参校验 / 信息流评分 / RSS 解析。
 * 不依赖 Workers 运行时（除 Web Crypto 全局，Node 18+ 同样具备），tests/plaza-hub.test.ts 直接导入。
 * 与博客内核的复杂度预算同口径：零 npm 依赖，一个自洽小文件。
 */

export const PLAZA_KINDS = ['post', 'weibo'] as const
export type PlazaKind = (typeof PLAZA_KINDS)[number]

/** 单条广场内容的公开出参（feed API 与评分函数共用同一形状） */
export interface PlazaItem {
  kind: PlazaKind
  /** 文章 slug / 微博 id（站内唯一引用），deleted 同步也按它对账 */
  ref: string
  /** 文章标题；微博为内容摘录（feed 出参直接可显示） */
  title: string
  /** 摘要 / 微博全文（入库前已截断） */
  summary: string
  /** 站内原文绝对地址 */
  url: string
  /** 封面图（文章封面 / 微博首图，可空） */
  image: string
  /** 站内发布时间（毫秒） */
  publishedAt: number
}

/** feed 出参：内容 + 来源站点 */
export interface PlazaFeedEntry extends PlazaItem {
  siteId: number
  siteName: string
  siteUrl: string
  /** 站点头像（sites.avatar，ingest 上报 / 管理端设置；空 = 前端走 favicon/首字兜底） */
  siteAvatar?: string
  /** hub 侧认证徽标（站点所有权验证通过后由管理员打开） */
  siteVerified: boolean
  score: number
}

/** 签名有效窗口：±10 分钟，超窗拒绝（防重放） */
export const SIGNATURE_TTL_MS = 10 * 60_000

/** hex 编码（HMAC 输出与 token 生成共用） */
export function toHex(buf: ArrayBuffer): string {
  const v = new Uint8Array(buf)
  let s = ''
  for (let i = 0; i < v.length; i++) s += v[i].toString(16).padStart(2, '0')
  return s
}

/** HMAC-SHA256 → hex。博客侧插件与 hub 校验共用同一算法与消息格式：`ts + '.' + rawBody` */
export async function hmacHex(secret: string, message: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign']
  )
  const sig = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(message))
  return toHex(sig)
}

/** hub 侧校验：签名对得上且时间戳在窗口内（时钟偏差容忍同窗）。任何一步失败都返回 false */
export async function verifyPlazaSignature(
  secret: string,
  ts: string,
  signature: string,
  rawBody: string,
  now = Date.now()
): Promise<boolean> {
  const t = Number(ts)
  if (!Number.isFinite(t) || Math.abs(now - t) > SIGNATURE_TTL_MS) return false
  if (!/^[0-9a-f]{64}$/.test(signature || '')) return false
  const expect = await hmacHex(secret, `${ts}.${rawBody}`)
  // 常量时间比较防时序侧信道（与内核 auth.ts safeEqual 同口径）
  if (expect.length !== signature.length) return false
  let diff = 0
  for (let i = 0; i < expect.length; i++) diff |= expect.charCodeAt(i) ^ signature.charCodeAt(i)
  return diff === 0
}

/** token 生成：32 hex 字符（crypto.randomUUID 去横线 ×2，Workers/Node 通用） */
export function generatePlazaToken(): string {
  const a = crypto.randomUUID().replace(/-/g, '')
  const b = crypto.randomUUID().replace(/-/g, '')
  return (a + b).slice(0, 32)
}

/* ---------------- ingest 入参校验 ---------------- */

export interface ValidatedIngest {
  items: PlazaItem[]
  deleted: { kind: PlazaKind; ref: string }[]
  /** 站点头像（可选，站点级）：合法 https 地址才收，随 ingest 更新 sites.avatar */
  avatar: string
}

/** 单次上报的硬上限：防一个签名请求塞爆库 */
export const INGEST_MAX_ITEMS = 50

function cleanStr(v: unknown, max: number): string {
  return typeof v === 'string' ? v.trim().slice(0, max) : ''
}

function safeUrl(v: unknown): string {
  const u = cleanStr(v, 500)
  // 只收 http(s) 绝对地址——hub 的全部出参都要能被官网直接点出去
  return /^https:\/\//i.test(u) ? u : ''
}

/**
 * ingest body 校验：形状不对的字段一律按没传处理（宽松收下合法部分，与评论 qq 同口径），
 * 一个都不合法则 items 为空数组照常 ok——站点侧不因一次脏数据被卡住。
 */
export function validateIngest(body: unknown): ValidatedIngest {
  const out: ValidatedIngest = { items: [], deleted: [], avatar: '' }
  if (!body || typeof body !== 'object') return out
  const b = body as Record<string, unknown>
  out.avatar = safeUrl(b.avatar)
  const rawItems = Array.isArray(b.items) ? b.items.slice(0, INGEST_MAX_ITEMS) : []
  for (const raw of rawItems) {
    if (!raw || typeof raw !== 'object') continue
    const it = raw as Record<string, unknown>
    const kind = PLAZA_KINDS.includes(it.kind as PlazaKind) ? (it.kind as PlazaKind) : null
    const ref = cleanStr(it.ref, 200)
    const url = safeUrl(it.url)
    if (!kind || !ref || !url) continue
    const publishedAt = Number(it.publishedAt)
    out.items.push({
      kind,
      ref,
      title: cleanStr(it.title, 200) || cleanStr(it.summary, 200),
      summary: cleanStr(it.summary, 500),
      url,
      image: safeUrl(it.image),
      // 缺失/畸形时间按现在处理（不拒绝整条），超出合理范围同样兜底
      publishedAt: Number.isFinite(publishedAt) && publishedAt > 0 && publishedAt < 4102444800000 ? publishedAt : Date.now(),
    })
  }
  const rawDeleted = Array.isArray(b.deleted) ? b.deleted.slice(0, INGEST_MAX_ITEMS) : []
  for (const raw of rawDeleted) {
    if (!raw || typeof raw !== 'object') continue
    const it = raw as Record<string, unknown>
    const kind = PLAZA_KINDS.includes(it.kind as PlazaKind) ? (it.kind as PlazaKind) : null
    const ref = cleanStr(it.ref, 200)
    if (!kind || !ref) continue
    out.deleted.push({ kind, ref })
  }
  return out
}

/**
 * 微博补漏条目规整（pull 用，docs/PLAZA.md「微博补漏」）：站点补漏端点（GET /api/public/weibo）
 * 给出的每条数据按 ingest 同款字段标准规整，ref/title 缺失、url 非 https、超 30 天的条目返回
 * null 由调用方跳过——pull 只做存在性兜底，绝不 fabricate。publishedAt 缺失/畸形回退 now。
 */
export function normalizePulledWeibo(
  w: Record<string, unknown>,
  now = Date.now()
): { kind: PlazaKind; ref: string; title: string; summary: string; url: string; image: string; publishedAt: number } | null {
  const ref = cleanStr(w.ref, 200)
  const title = cleanStr(w.title, 200)
  const url = safeUrl(w.url)
  if (!ref || !title || !url) return null
  const publishedAt = Number(w.publishedAt)
  const ts = Number.isFinite(publishedAt) && publishedAt > 0 && publishedAt < 4102444800000 ? publishedAt : now
  if (now - ts > 30 * 86_400_000) return null
  return {
    kind: 'weibo',
    ref,
    title,
    // pull 来源是未签名的公开端点：summary 剥 HTML 标签（与 pullSiteRss 的 RSS 描述同口径）
    summary: cleanStr(String(w.summary ?? '').replace(/<[^>]+>/g, ''), 500),
    url,
    image: safeUrl(w.image),
    publishedAt: ts,
  }
}

/* ---------------- 信息流评分 ---------------- */

export interface ScoreOptions {
  now?: number
  /** 随机源可注入（测试确定性），默认 Math.random */
  rand?: () => number
}

/**
 * 混排评分（拍板口径：权重 + 新文推荐 + 随机展示三因素相加）：
 * - 新文推荐：recency = 1 / (1 + 龄期天数/2)——今天的≈1，一周后≈0.22，一月后≈0.06，衰减平缓不至于老文永沉
 * - 权重：站点 weight（0-10，管理员定）线性加成 0.05/档，默认 1 档 = +0.05，10 档满 +0.5
 * - 随机：0~0.3 抖动——同分内容每次刷新换序，「广场要有点逛的感觉」
 * 量纲刻意都压在 0~1.5 区间，没有哪个因素能一票定序。
 */
export function scorePlazaItem(
  item: Pick<PlazaItem, 'publishedAt'>,
  siteWeight = 1,
  opts: ScoreOptions = {}
): number {
  const now = opts.now ?? Date.now()
  const rand = opts.rand ?? Math.random
  const ageDays = Math.max(0, (now - item.publishedAt) / 86_400_000)
  const recency = 1 / (1 + ageDays / 2)
  const weight = (Math.min(10, Math.max(0, siteWeight)) || 0) * 0.05
  const jitter = rand() * 0.3
  return recency + weight + jitter
}

/** 候选 → 排序后的 feed（desc），limit 收口；纯函数，D1 读数在 index.ts */
export function scoreFeed(
  candidates: { item: PlazaItem; siteId: number; siteName: string; siteUrl: string; siteAvatar?: string; siteVerified: boolean; siteWeight: number }[],
  limit: number,
  opts: ScoreOptions = {}
): PlazaFeedEntry[] {
  const rand = opts.rand ?? Math.random
  return candidates
    .map((c) => ({
      kind: c.item.kind,
      ref: c.item.ref,
      title: c.item.title,
      summary: c.item.summary,
      url: c.item.url,
      image: c.item.image,
      publishedAt: c.item.publishedAt,
      siteId: c.siteId,
      siteName: c.siteName,
      siteUrl: c.siteUrl,
      siteAvatar: c.siteAvatar || '',
      siteVerified: c.siteVerified,
      score: scorePlazaItem(c.item, c.siteWeight, { ...opts, rand }),
    }))
    .sort((a, b) => b.score - a.score || b.publishedAt - a.publishedAt)
    .slice(0, Math.max(1, Math.min(100, limit)))
}

/* ---------------- RSS pull（补漏路：只抓 /rss.xml 的文章，微博无公开 RSS 不在 pull 范围） ---------------- */

/**
 * 最小 RSS2/Atom 解析：只取 link / title / pubDate / description 四样，正则而非 XML 解析器
 * （零依赖预算）。CDATA 与实体按原样返回，hub 入库前另有截断——feed 内容本身来自站长 RSS，属半可信，
 * 官网渲染时一律 textContent / esc 处理，hub 不负责净化 HTML。
 */
export function parseRssItems(xml: string, max = 50): { link: string; title: string; pubDate: string; description: string }[] {
  const out: { link: string; title: string; pubDate: string; description: string }[] = []
  // <item>…</item>（RSS2）为主，<entry>（Atom）兜底
  const blocks = xml.match(/<(?:item|entry)[\s>][\s\S]*?<\/(?:item|entry)>/g) ?? []
  for (const block of blocks.slice(0, max)) {
    const pick = (tag: string): string => {
      // CDATA 优先，其次普通文本节点；属性带命名空间的 <atom:link> 不误取（只在 tag 精确匹配内取）
      const re = new RegExp(`<${tag}(?:\\s[^>]*)?>\\s*(?:<!\\[CDATA\\[([\\s\\S]*?)\\]\\]>|([\\s\\S]*?))<\\/${tag}>`, 'i')
      const m = block.match(re)
      if (!m) return ''
      return (m[1] ?? m[2] ?? '').trim()
    }
    const link = pick('link') || block.match(/<link[^>]*href="([^"]+)"/i)?.[1]?.trim() || ''
    if (!/^https?:\/\//i.test(link)) continue
    out.push({
      link: link.slice(0, 500),
      title: pick('title').slice(0, 200),
      pubDate: pick('pubDate') || pick('updated') || pick('published'),
      description: pick('description').slice(0, 500),
    })
  }
  return out
}

/** RSS pubDate → 毫秒；解析失败按现在（与 push 路publishedAt 兜底同口径） */
export function rssDateToMs(s: string, now = Date.now()): number {
  const t = Date.parse(s)
  return Number.isFinite(t) && t > 0 ? t : now
}

/** 统计日 key：北京时间日期 YYYY-MM-DD（与内核时间纪律同口径：+8h 后取 UTC 分量；
 *  plaza 是独立模块不 import src/utils，这里按同一算法本地实现，tests 有镜像用例守着） */
export function statsDay(now = Date.now()): string {
  return new Date(now + 8 * 3600_000).toISOString().slice(0, 10)
}
