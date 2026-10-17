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
  /** hub 侧条目 id（点赞动作的目标主键；客户端按它记「已赞」） */
  id: number
  /** 匿名点赞累计数（≥1 才值得前台渲染，零赞不显示避免冷清感） */
  likes: number
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

/** 新站聚光期（P0.4）：注册 7 天内 weight 临时 +2 档，冷启动扶持；到期自动回落，管理员定的档不受影响 */
export const SPOTLIGHT_DAYS = 7
export const SPOTLIGHT_BOOST = 2

/**
 * 聚光加成（纯函数）：站点注册在 SPOTLIGHT_DAYS 天内 → weight + SPOTLIGHT_BOOST（封顶 10）。
 * created_at 缺失（0）/未来值一律不加成——脏数据宁可不扶持，不让脏值变成常驻加权。
 */
export function spotlightWeight(weight: number, siteCreatedAt: number, now = Date.now()): number {
  const w = Math.min(10, Math.max(0, weight)) || 0
  if (!Number.isFinite(siteCreatedAt) || siteCreatedAt <= 0 || siteCreatedAt > now) return w
  if (now - siteCreatedAt > SPOTLIGHT_DAYS * 86_400_000) return w
  return Math.min(10, w + SPOTLIGHT_BOOST)
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

/** 候选 → 排序后的 feed（desc），limit 收口；纯函数，D1 读数在 index.ts。
 *  siteWeight 由调用方先过 spotlightWeight（聚光加成是站点级前置，评分函数保持单一职责） */
export function scoreFeed(
  candidates: { item: PlazaItem; id?: number; likes?: number; siteId: number; siteName: string; siteUrl: string; siteAvatar?: string; siteVerified: boolean; siteWeight: number }[],
  limit: number,
  opts: ScoreOptions = {}
): PlazaFeedEntry[] {
  const rand = opts.rand ?? Math.random
  return candidates
    .map((c) => ({
      id: c.id ?? 0,
      likes: c.likes ?? 0,
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
export function parseRssItems(
  xml: string,
  max = 50
): { link: string; title: string; pubDate: string; description: string; locked: boolean }[] {
  const out: { link: string; title: string; pubDate: string; description: string; locked: boolean }[] = []
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
      // 主博客的机器可读锁标志（bloghao 命名空间，src/rss.ts 输出）：锁文/密码文 pull 不入库，
      // 与 push 路「locked 不同步」同口径
      locked: !!pick('bloghao:locked'),
    })
  }
  return out
}

/** RSS pubDate → 毫秒；解析失败按现在（与 push 路publishedAt 兜底同口径） */
export function rssDateToMs(s: string, now = Date.now()): number {
  const t = Date.parse(s)
  return Number.isFinite(t) && t > 0 ? t : now
}

/**
 * RSS channel <title> → 站点名（P0.2 pull 路回填 site_name 用）。
 * 只在第一个 <item>/<entry> 之前找——channel 头部的 title 才是站名，文章标题一律不认；
 * CDATA 与纯文本节点都收，截 100 字（与管理端改名同限）。
 */
export function parseRssSiteTitle(xml: string): string {
  const channel = xml.match(/<(?:channel|feed)[\s>][\s\S]*?<\/(?:channel|feed)>/i)?.[0] ?? xml
  const head = channel.split(/<(?:item|entry)[\s>]/i)[0]
  const m = head.match(/<title(?:\s[^>]*)?>\s*(?:<!\[CDATA\[([\s\S]*?)\]\]>|([\s\S]*?))<\/title>/i)
  return ((m?.[1] ?? m?.[2] ?? '')).trim().slice(0, 100)
}

/* ---------------- pull 出网防线（SSRF） ----------------
 * 补漏要抓注册站点的 /rss.xml 与 /api/public/weibo，站点地址是第三方可控的——出网前必须
 * 判「公网主机」，且重定向要逐跳复查（公网地址 302 到 169.254.169.254 是经典绕过），
 * 见 index.ts 的 fetchPullTarget。判定与内核 fetchsafe.isPrivateHost 同口径，本模块保持
 * 自包含（plaza 可独立部署，不引主仓库模块）：内网/保留后缀、含 ':' 的主机（IPv6 字面量）
 * 一律拒；纯数字主机名（含 0x 十六进制、0 前缀八进制写法）解析成 4 字节按私有段判，
 * 解析不动的可疑形态按私有拒（宁拒勿漏）。已知局限：DNS rebinding 防不了——Workers 形态
 * 出口公网私网不可达；自托管（Node）形态不要把 hub 端口暴露给不可信调用方。 */

/** WHATWG IPv4 number 解析：0x 前缀十六进制、0 前缀八进制、其余十进制；非法返回 null */
function parseIpv4Number(s: string): number | null {
  if (/^0[xX]/.test(s)) {
    if (s.length <= 2) return null
    const n = parseInt(s.slice(2), 16)
    return Number.isFinite(n) ? n : null
  }
  if (s.length > 1 && s[0] === '0') {
    const n = parseInt(s.slice(1), 8)
    return Number.isFinite(n) ? n : null
  }
  const n = Number(s)
  return Number.isFinite(n) ? n : null
}

/** 数字形态主机名 → 4 字节（WHATWG 规则：末段是聚数段，吃掉剩余全部字节）；非法返回 null */
function ipv4BytesFromHost(h: string): number[] | null {
  const parts = h.split('.')
  if (parts.length > 4 || parts[parts.length - 1] === '') return null
  const nums: number[] = []
  for (const p of parts) {
    if (p === '') return null
    const n = parseIpv4Number(p)
    if (n === null || n < 0) return null
    nums.push(n)
  }
  for (let i = 0; i < nums.length - 1; i++) if (nums[i] > 255) return null
  if (nums[nums.length - 1] >= Math.pow(256, 5 - nums.length)) return null
  const bytes: number[] = []
  for (let i = 0; i < nums.length - 1; i++) bytes.push(nums[i])
  const rest = 4 - bytes.length
  for (let i = rest - 1; i >= 0; i--) bytes.push(Math.floor(nums[nums.length - 1] / Math.pow(256, i)) % 256)
  return bytes
}

function isPrivateIpv4Bytes(b: number[]): boolean {
  const [a, c] = b
  if (a === 0 || a === 10 || a === 127) return true
  if (a === 100 && c >= 64 && c <= 127) return true // 100.64/10 CGNAT
  if (a === 169 && c === 254) return true // 含 169.254.169.254 云 metadata
  if (a === 172 && c >= 16 && c <= 31) return true
  if (a === 192 && c === 168) return true
  if (a >= 224) return true // 组播 / 保留
  return false
}

/** pull 可抓主机判定：公网主机 true，内网后缀 / IPv6 字面量 / 私有段 IPv4 一律 false。
 *  接受绝对 URL（与站点注册校验、重定向目标复查两处共用） */
export function pullHostOk(siteUrl: string): boolean {
  let h: string
  try {
    h = new URL(siteUrl).hostname.toLowerCase().replace(/\.$/, '')
  } catch {
    return false
  }
  if (!h || h === 'localhost' || h.endsWith('.localhost') || h.endsWith('.local') || h.endsWith('.internal')) return false
  // URL.hostname 不会带端口；出现 ':' 即是 IPv6 字面量（含 IPv4-mapped / ULA / link-local）——一律拒
  if (h.includes(':')) return false
  // 全部段都是数字（含 0x / 0 前缀写法）才是 IPv4 数字形态，避免误杀 cafe.example.com 这类真域名
  if (h.split('.').every((p) => /^(?:0[xX][0-9a-fA-F]+|0+[0-7]*|[1-9][0-9]*)$/.test(p))) {
    const bytes = ipv4BytesFromHost(h)
    return bytes ? !isPrivateIpv4Bytes(bytes) : false
  }
  return true
}

/** 统计日 key：北京时间日期 YYYY-MM-DD（与内核时间纪律同口径：+8h 后取 UTC 分量；
 *  plaza 是独立模块不 import src/utils，这里按同一算法本地实现，tests 有镜像用例守着） */
export function statsDay(now = Date.now()): string {
  return new Date(now + 8 * 3600_000).toISOString().slice(0, 10)
}

/* ---------------- 轻互动（P2：匿名点赞 + 曝光/点击回传） ----------------
 * 隐私红线：互动数据是匿名聚合计数，不是行为档案——不存原始 IP / vid，
 * 只存「北京日 + 当日盐」的 sha256（同 IP 跨日哈希不同，无法跨天串联）。 */

/** 客户端 vid 口径：32 hex（crypto.randomUUID 去横线，与站点 token 同形），防重放的关键字段 */
export function cleanVid(v: unknown): string {
  return typeof v === 'string' && /^[0-9a-f]{32}$/.test(v) ? v : ''
}

/** 站点 token 打码（管理列表/详情回显用）：**只露后 4 位**。token 是长期 Bearer，回显前 8 位
 *  等于白送 48 bit（管理面看一眼就拿到一半熵）；丢了就 rotate，与内核 SECRET_SETTINGS 同口径
 *  （明文只在生成时返回一次）。短 token 一律 '…' */
export function maskPlazaToken(t: string): string {
  return t.length > 12 ? `…${t.slice(-4)}` : '…'
}

/** sha256 → hex（日盐哈希用；Workers 与 Node 18+ 都有 WebCrypto） */
export async function sha256Hex(s: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(s))
  return toHex(digest)
}

/**
 * 天级哈希：同一天内稳定可去重，跨天不可串联。
 *  secret 非空时走 HMAC-SHA256(secret, day:value)——**这是生产口径**：私盐（服务端持有、
 *  只进哈希不进库）让「库泄露 = 枚举还原 IP/vid」不成立（旧实现用公开日期当盐，IPv4
 *  空间可枚举反推）。secret 为空时退化为 sha256(day:value)（自建 hub 未配密钥的兼容兜底，
 *  功能一致、隐私弱一档）。改 secret 只会让「当天」去重失效（重投一天内可能重复计 1 次），
 *  属可接受代价；天级键天然跨日轮换，无需额外轮换逻辑。
 */
export async function daySaltedHash(day: string, value: string, secret = ''): Promise<string> {
  const msg = `${day}:${value}`
  return secret ? hmacHex(secret, msg) : sha256Hex(msg)
}

/** 曝光/点击事件类型：v = 卡片曝光，c = 出站点击 */
export type BeaconKind = 'v' | 'c'

export interface BeaconEvent {
  /** 站点 id（hub 侧 sites.id，feed 出参 siteId） */
  s: number
  k: BeaconKind
  /** 聚合计数（客户端同站同类合并后的次数） */
  n: number
}

/** 回传单条事件硬上限（条数与单条计数都封顶：客户端攒批 ≤50 条，单条 ≤20 次全够用） */
export const BEACON_MAX_EVENTS = 50
export const BEACON_MAX_N = 20

/**
 * 回传入参校验（纯函数）：形状不对的条目按没传处理（宽松收下合法部分，与 ingest 同口径），
 * 同 (s,k) 条目合并计数（客户端可能分头发同站事件，hub 侧再合并一次省 upsert 次数）。
 * 返回按 s 升序的合并清单——去重后能一次 SELECT 校验站点存在性。
 */
export function validateBeaconEvents(raw: unknown): BeaconEvent[] {
  const list = Array.isArray(raw) ? raw.slice(0, BEACON_MAX_EVENTS) : []
  const merged = new Map<string, BeaconEvent>()
  for (const raw2 of list) {
    if (!raw2 || typeof raw2 !== 'object') continue
    const e = raw2 as Record<string, unknown>
    const s = Math.round(Number(e.s))
    if (!Number.isFinite(s) || s <= 0 || s > 2_147_483_647) continue
    if (e.k !== 'v' && e.k !== 'c') continue
    const n = Math.round(Number(e.n))
    if (!Number.isFinite(n) || n <= 0) continue
    const key = `${s}|${e.k}`
    const prev = merged.get(key)
    if (prev) prev.n = Math.min(BEACON_MAX_EVENTS * BEACON_MAX_N, prev.n + Math.min(BEACON_MAX_N, n))
    else merged.set(key, { s, k: e.k, n: Math.min(BEACON_MAX_N, n) })
  }
  return [...merged.values()].sort((a, b) => a.s - b.s)
}
