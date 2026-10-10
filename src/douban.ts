/**
 * 书影音卡片（第三方编辑器插件 douban-media 的数据面，端点 /api/admin/tools/douban）
 *
 * 输入书 / 影 / 音的名字，从豆瓣拿封面与评分，备用源（Google 图书 / TMDB / iTunes）
 * 兜底，最终由编辑器插件把 buildCardHtml() 产出的卡片插进正文。卡片结构与
 * linkmeta 的链接卡同理：span + display:flex 的 <a>，存库后过 sanitizeHtml 白名单。
 *
 * 豆瓣没有公开 API，走的是搜索框联想接口（/j/subject_suggest）与条目页 HTML
 * （v:average / v:votes / og:image 等结构化锚点）。豆瓣对数据中心 IP 风控很紧，
 * 所以抓取可经「自建中转」（douban-relay/，跑在自己的服务器上）——中转只做
 * 白名单代理 + 磁盘缓存 + 低频节奏 + cookie 维持，解析始终在本模块。
 *
 * SSRF 约束：中转地址必须 https 且过 fetchableUrl（复用 linkmeta 的公网校验）；
 * 本模块对豆瓣的抓取地址全部由代码构造，不接受外部传入的抓取 URL（正文里
 * 粘贴的豆瓣链接只提取条目数字 id 再重组）。
 */

import { escAttr } from './sanitize'
import { fetchableUrl } from './linkmeta'

export type MediaType = 'book' | 'movie' | 'music'

export interface MediaItem {
  source: 'douban' | 'google' | 'tmdb' | 'deezer' | 'itunes'
  type: MediaType
  id: string
  title: string
  year?: string
  cover?: string
  rating?: number // 统一 0-10 量纲；无评分缺省
  ratingCount?: number
  meta?: string // 作者 / 导演 / 表演者等一行元信息
  intro?: string
  link?: string
}

const FETCH_TIMEOUT_MS = 10_000
const RELAY_TIMEOUT_MS = 15_000
const MAX_BODY_BYTES = 2 * 1024 * 1024
/** 与 linkmeta 同款浏览器 UA（豆瓣按 UA 粗筛，缺 UA 直接触发风控） */
export const BROWSER_UA =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36'
const UA = BROWSER_UA

const DOUBAN_HOST: Record<Exclude<MediaType, 'music'>, string> = {
  book: 'book.douban.com',
  movie: 'movie.douban.com',
}
/** 豆瓣音乐搜索联想接口已下线（实测恒返回空数组），音乐搜索走 iTunes 兜底，
 *  但条目详情页（含评分）不设防，粘贴链接仍可直取 */
const SEARCH_AVAILABLE: Record<MediaType, boolean> = { book: true, movie: true, music: false }

export function doubanDetailUrl(type: MediaType, id: string): string {
  return `https://${type === 'music' ? 'music.douban.com' : DOUBAN_HOST[type]}/subject/${id}/`
}

/** 从粘贴的豆瓣链接提取条目 id（只认 subject 数字 id，其余一律拒绝——抓取地址必须代码重组） */
export function subjectIdFromUrl(raw: string): string | null {
  const m = /douban\.com\/subject\/(\d{1,14})/.exec(String(raw || '').replace(/[\t\r\n]/g, '').trim())
  return m ? m[1] : null
}

/* ---------------- 封面策略 ---------------- */

/** 豆瓣 CDN 有防盗链：无 Referer 418、外站 Referer 403（实测 2026-10），
 *  转存/代理时必须带图床自己的域作 Referer；其他源（Deezer/TMDB/Google/iTunes）
 *  无防盗链，不需要特殊 Referer */
export function coverReferer(u: string): string | null {
  if (!/doubanio\.com\//.test(u || '')) return null
  try {
    return new URL(u).origin + '/'
  } catch {
    return null
  }
}

/** 编辑器结果列表缩略图代理的域名白名单（端点本就要求登录 + 限频，这里再限源） */
const COVER_PROXY_HOSTS = ['doubanio.com', 'dzcdn.net', 'mzstatic.com', 'image.tmdb.org', 'books.google.com']
export function coverProxyHostOk(host: string): boolean {
  const h = String(host || '').toLowerCase()
  return COVER_PROXY_HOSTS.some((suffix) => h === suffix || h.endsWith('.' + suffix))
}

export interface ResolvedCover {
  cover: string
  /** 转存是否成功（false 时豆瓣封面已省略或走了中转兜底，供日志/提示） */
  local: boolean
}

/** 组卡前的封面归一：转存进站内图床优先（卡片永久自持，不依赖任何外域与中转）；
 *  转存失败时豆瓣图退中转 /img（没配中转就省略——绝不烘必挂的防盗链死图），
 *  非豆瓣源 CDN 无防盗链，保留原直连。transferred 为 null 表示转存失败 */
export function resolveCardCover(cover: string, transferred: string | null, relayBase: string | null): ResolvedCover {
  const c = String(cover || '').trim()
  if (!c) return { cover: '', local: true }
  if (c.startsWith('/images/')) return { cover: c, local: true }
  if (transferred) return { cover: transferred, local: true }
  if (/doubanio\.com\//.test(c)) {
    if (relayBase) return { cover: `${relayBase.replace(/\/+$/, '')}/img?u=${encodeURIComponent(c)}`, local: false }
    return { cover: '', local: false }
  }
  return { cover: c, local: false }
}

/* ---------------- 中转地址校验 ---------------- */

export interface RelayConf {
  base: string // 归一化后的中转基地址（无尾斜杠）
  token: string
}

/** 中转配置校验：必须 https、公网地址（fetchableUrl）、token 非空且无控制字符。
 *  返回 null 表示配置不可用（调用方退化直连或报错） */
export function validateRelay(rawUrl: string, rawToken: string): RelayConf | null {
  const u = fetchableUrl(String(rawUrl || ''))
  if (!u || u.protocol !== 'https:') return null
  const token = String(rawToken || '').trim()
  if (!token || token.length > 256 || /[\r\n\0]/.test(token)) return null
  return { base: `${u.protocol}//${u.host}${u.pathname.replace(/\/+$/, '')}`, token }
}

/* ---------------- 抓取（经中转或直连） ---------------- */

interface DoubanResult {
  status: number
  text: string
  blocked: boolean
}

/** 豆瓣风控判定：403/429、重定向落点在 sec.douban.com（安全挑战页）、
 *  或响应体里出现挑战页特征。blocked 时调用方应停止重试并走兜底 */
function looksBlocked(status: number, finalUrl: string, body: string): boolean {
  if (status === 403 || status === 429) return true
  if (/sec\.douban\.com\/c\?/.test(finalUrl)) return true
  return /sec\.douban\.com\/c\?|有异常请求|进行验证/.test(body.slice(0, 4000))
}

async function fetchDouban(
  url: string,
  referer: string,
  relay: RelayConf | null,
  fetchImpl: typeof fetch
): Promise<DoubanResult | null> {
  try {
    let status: number
    let text: string
    let finalUrl = url
    if (relay) {
      const res = await fetchImpl(`${relay.base}/api/fetch?u=${encodeURIComponent(url)}`, {
        headers: { Authorization: `Bearer ${relay.token}` },
        redirect: 'error',
        signal: AbortSignal.timeout(RELAY_TIMEOUT_MS),
      })
      if (!res.ok) return null
      // 中转响应体 ≤2MB（豆瓣条目页 ~500KB），超限视为脏数据丢弃
      const len = Number(res.headers.get('content-length') || 0)
      if (len > MAX_BODY_BYTES) return null
      const data = (await res.json().catch(() => null)) as { status?: number; body?: string; blocked?: boolean; finalUrl?: string } | null
      if (!data) return null
      if (data.blocked) return { status: 403, text: '', blocked: true } // 中转的风控信号（无 body 字段）
      if (typeof data.body !== 'string') return null
      status = Number(data.status) || 200
      text = data.body
      if (text.length > MAX_BODY_BYTES) return null
      finalUrl = String(data.finalUrl || url)
    } else {
      const res = await fetchImpl(url, {
        headers: {
          'User-Agent': UA,
          Accept: 'text/html,application/xhtml+xml,application/json;q=0.9,*/*;q=0.8',
          'Accept-Language': 'zh-CN,zh;q=0.9',
          Referer: referer,
        },
        redirect: 'follow',
        signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
      })
      status = res.status
      finalUrl = res.url || url
      const len = Number(res.headers.get('content-length') || 0)
      if (len > MAX_BODY_BYTES) return null
      text = await res.text()
      if (text.length > MAX_BODY_BYTES) return null
    }
    // 只有 403/429 与 sec 挑战算「被风控」（触发备用源与提示）；
    // 404 等按普通失败处理——条目不存在时应让插件拿搜索结果补卡，不该吓唬用户
    return {
      status,
      text,
      blocked: status === 403 || status === 429 || looksBlocked(status, finalUrl, text),
    }
  } catch {
    return null
  }
}

/* ---------------- 豆瓣解析（纯函数，Node 测试直接导入） ---------------- */

/** 与 collect.ts / linkmeta.ts 同口径的轻量实体解码（未知实体与裸 & 原样保留，
 *  后续组卡统一过 escAttr，不在这里预转义） */
function decodeEntities(s: string): string {
  return s.replace(/&(nbsp|#x?[0-9a-fA-F]+|amp|lt|gt|quot|apos);/g, (whole, code: string) => {
    if (code === 'amp') return '&'
    if (code === 'lt') return '<'
    if (code === 'gt') return '>'
    if (code === 'quot') return '"'
    if (code === 'apos') return "'"
    if (code === 'nbsp') return ' '
    const n = code.startsWith('#x') || code.startsWith('#X') ? parseInt(code.slice(2), 16) : parseInt(code.slice(1), 10)
    return Number.isFinite(n) && n > 0 ? String.fromCodePoint(n) : whole
  })
}

function stripTags(s: string): string {
  return s.replace(/<[^>]+>/g, '')
}

function toText(html: string): string {
  return decodeEntities(stripTags(html)).replace(/\s+/g, ' ').trim()
}

/** 文案截断（按码点，不劈代理对），与 linkmeta clampText 同规则 */
function clampText(s: string, n: number): string {
  const t = s.replace(/\s+/g, ' ').trim()
  const chars = Array.from(t)
  return chars.length > n ? chars.slice(0, n).join('') + '…' : t
}

function metaContent(html: string, key: string): string {
  const re = new RegExp(
    `<meta[^>]+(?:property|name)\\s*=\\s*["']${key.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}["'][^>]*>`,
    'i'
  )
  const tag = re.exec(html)?.[0] || ''
  const m = /content\s*=\s*(?:"([^"]*)"|'([^']*)')/i.exec(tag)
  return (m?.[1] ?? m?.[2] ?? '').trim()
}

/** 豆瓣封面尺寸升级：联想接口给的是小图（s 尺寸 / s_ratio_poster），
 *  同文件名在 l 尺寸路径下必然存在（og:image 即 l 尺寸，豆瓣自家页面同款） */
export function normalizeCoverUrl(u: string): string {
  if (!/doubanio\.com\//.test(u || '')) return u
  return u.replace('/view/photo/s_ratio_poster/', '/view/photo/l_ratio_poster/').replace('/view/subject/s/public/', '/view/subject/l/public/')
}

/** 搜索联想接口两种返回形状：电影 {img,title,sub_title,year,id} / 书音 {pic,title,author_name,year,id} */
export function parseDoubanSuggest(type: MediaType, text: string): MediaItem[] {
  let arr: unknown
  try {
    arr = JSON.parse(text)
  } catch {
    return []
  }
  if (!Array.isArray(arr)) return []
  const out: MediaItem[] = []
  for (const raw of arr.slice(0, 10)) {
    if (!raw || typeof raw !== 'object') continue
    const r = raw as Record<string, unknown>
    const id = String(r.id ?? '').trim()
    const title = String(r.title ?? '').trim()
    if (!/^\d{1,14}$/.test(id) || !title) continue
    const cover = normalizeCoverUrl(String(r.img ?? r.pic ?? ''))
    const author = String((r as Record<string, unknown>).author_name ?? '').trim()
    const year = String(r.year ?? '').replace(/\D/g, '').slice(0, 4)
    out.push({
      source: 'douban',
      type,
      id,
      title: clampText(title, 60),
      year: /^\d{4}$/.test(year) ? year : undefined,
      cover: /^https:\/\//.test(cover) ? cover : undefined,
      meta: author ? clampText(author, 60) : undefined,
      link: doubanDetailUrl(type, id),
    })
  }
  return out
}

/** 条目详情页解析：评分 v:average / 人数 v:votes / 标题 v:itemreviewed / 封面 og:image，
 *  简介 v:description 或 .intro 块，元信息从 #info 按已知标签边界抓取（值常在标签名下一行）。
 *  id 优先取页面 canonical（og:url），取不到时用调用方已知的条目 id（抓取地址本就由代码重组） */
export function parseSubjectHtml(type: MediaType, html: string, knownId?: string): MediaItem | null {
  const id = /\/subject\/(\d+)/.exec(html.slice(0, 4000))?.[1] || String(knownId || '')
  let title = /property="v:itemreviewed">([^<]+)/.exec(html)?.[1] ?? ''
  if (!title) {
    const t = /<title>([^<]+)<\/title>/.exec(html)?.[1] ?? ''
    title = t.replace(/\s*\(豆瓣[^)]*\)\s*/, '')
  }
  if (!id || !title.trim()) return null

  const ratingRaw = /property="v:average">\s*([\d.]+)/.exec(html)?.[1]
  const votesRaw = /property="v:votes">(\d+)/.exec(html)?.[1]
  const cover = metaContent(html, 'og:image')

  // #info 块：整标签匹配（含闭合 >，否则留下「>」垃圾前缀），块内转纯文本后按已知标签边界抓字段
  const infoStart = /<div[^>]+id="info"[^>]*>/i.exec(html)
  let infoText = ''
  if (infoStart) {
    const rest = html.slice(infoStart.index + infoStart[0].length)
    const end = /<\/div>/i.exec(rest)?.index ?? rest.length
    infoText = decodeEntities(stripTags(rest.slice(0, end).replace(/<br\s*\/?>/gi, '\n')))
  }

  // 豆瓣 info 块的值常落在标签名的下一行（作者:\n 多行 \n刘慈欣），按行匹配抓不住——
  // 压平成一行后按「已知标签:」边界截值；STOP_LABELS 是豆瓣三域 info 块的字段名全表
  const STOP_LABELS =
    '作者|译者|编者|出版社|出品方|出版年|页数|定价|装帧|丛书|ISBN|条形码|表演者|流派|专辑类型|介质|发行时间|出版者|唱片数|歌手|导演|编剧|主演|类型|制片国家|语言|上映日期|首播|集数|单集片长|又名|官方网站|IMDb'
  const infoField = (labels: string[]): string => {
    const flat = infoText.replace(/\s+/g, ' ')
    for (const label of labels) {
      const m = new RegExp(`${label}\\s*[:：]\\s*([\\s\\S]*?)(?=$|\\s(?:${STOP_LABELS})\\s*[:：])`).exec(flat)
      if (m && m[1].replace(/\s+/g, ' ').trim()) return m[1].replace(/\s+/g, ' ').trim()
    }
    return ''
  }

  const metaParts: string[] = []
  let year = ''
  if (type === 'movie') {
    for (const v of [infoField(['导演']), infoField(['主演']), infoField(['上映日期', '首播'])]) if (v) metaParts.push(v)
    year = (infoField(['上映日期', '首播']).match(/\d{4}/) || [''])[0]
  } else if (type === 'book') {
    for (const v of [infoField(['作者']), infoField(['译者']), infoField(['出版社']), infoField(['出版年'])]) if (v) metaParts.push(v)
    year = (infoField(['出版年', '出版时间']).match(/\d{4}/) || [''])[0]
  } else {
    for (const v of [infoField(['表演者', '歌手']), infoField(['流派']), infoField(['发行时间'])]) if (v) metaParts.push(v)
    year = (infoField(['发行时间', '出版年']).match(/\d{4}/) || [''])[0]
  }

  let intro = ''
  const descSpan = /property="v:description"[^>]*>([\s\S]{0,8000}?)<\/span>/i.exec(html)?.[1]
  if (descSpan) {
    intro = toText(descSpan)
  } else {
    const introStart = /<div[^>]+class="[^"]*intro[^"]*"[^>]*>/i.exec(html)
    if (introStart) {
      const rest = html.slice(introStart.index + introStart[0].length)
      const end = /<\/div>/i.exec(rest)?.index ?? rest.length
      intro = toText(rest.slice(0, end))
    }
  }

  return {
    source: 'douban',
    type,
    id,
    title: clampText(title, 60),
    year: year || undefined,
    cover: /^https:\/\//.test(cover) ? normalizeCoverUrl(cover) : undefined,
    rating: ratingRaw ? Math.min(10, parseFloat(ratingRaw)) : undefined,
    ratingCount: votesRaw ? parseInt(votesRaw, 10) : undefined,
    meta: metaParts.length ? clampText(metaParts.join(' / '), 80) : undefined,
    intro: intro ? clampText(intro, 150) : undefined,
    link: doubanDetailUrl(type, id),
  }
}

/* ---------------- 备用源解析（免 key / 可选 key 的稳定公开接口） ---------------- */

export function parseGoogleBooks(text: string): MediaItem[] {
  let data: { items?: Array<Record<string, unknown>> }
  try {
    data = JSON.parse(text)
  } catch {
    return []
  }
  const out: MediaItem[] = []
  for (const raw of (data.items || []).slice(0, 8)) {
    const v = (raw.volumeInfo ?? {}) as Record<string, unknown>
    const id = String(raw.id ?? '')
    const title = String(v.title ?? '').trim()
    if (!id || !title) continue
    const img = String((v.imageLinks as Record<string, unknown> | undefined)?.thumbnail ?? '').replace(/^http:\/\//, 'https://')
    const rating = typeof v.averageRating === 'number' ? v.averageRating * 2 : undefined
    const authors = Array.isArray(v.authors) ? (v.authors as unknown[]).map(String).join(', ') : ''
    const publisher = String(v.publisher ?? '')
    const meta = [authors, publisher].filter(Boolean).join(' / ')
    out.push({
      source: 'google',
      type: 'book',
      id,
      title: clampText(title, 60),
      year: String(v.publishedDate ?? '').slice(0, 4) || undefined,
      cover: /^https:\/\//.test(img) ? img.replace(/^http:/, 'https:') : undefined,
      rating: rating != null && rating > 0 ? Math.min(10, rating) : undefined,
      ratingCount: typeof v.ratingsCount === 'number' ? v.ratingsCount : undefined,
      meta: meta ? clampText(meta, 80) : undefined,
      intro: v.description ? clampText(String(v.description), 150) : undefined,
      link: String(v.infoLink ?? '') || `https://books.google.com/books?id=${encodeURIComponent(id)}`,
    })
  }
  return out
}

interface ItunesResult {
  trackName?: string
  collectionName?: string
  artistName?: string
  primaryGenreName?: string
  longDescription?: string
  description?: string
  artworkUrl100?: string
  releaseDate?: string
  collectionViewUrl?: string
  trackViewUrl?: string
  collectionId?: number
  trackId?: number
}

export function parseItunes(text: string, type: MediaType): MediaItem[] {
  let data: { results?: ItunesResult[] }
  try {
    data = JSON.parse(text)
  } catch {
    return []
  }
  const out: MediaItem[] = []
  for (const r of (data.results || []).slice(0, 8)) {
    const title = String((type === 'music' ? r.collectionName : r.trackName) ?? '').trim()
    const id = String(r.collectionId ?? r.trackId ?? '')
    if (!id || !title) continue
    const cover = String(r.artworkUrl100 ?? '').replace('100x100bb', '600x600bb')
    const meta = [r.artistName, r.primaryGenreName].filter(Boolean).join(' · ')
    out.push({
      source: 'itunes',
      type,
      id,
      title: clampText(title, 60),
      year: String(r.releaseDate ?? '').slice(0, 4) || undefined,
      cover: /^https:\/\//.test(cover) ? cover : undefined,
      meta: meta ? clampText(meta, 80) : undefined,
      intro: r.longDescription || r.description ? clampText(String(r.longDescription || r.description), 150) : undefined,
      link: String((type === 'music' ? r.collectionViewUrl : r.trackViewUrl) ?? ''),
    })
  }
  return out
}

export function parseTmdb(text: string): MediaItem[] {
  let data: { results?: Array<Record<string, unknown>> }
  try {
    data = JSON.parse(text)
  } catch {
    return []
  }
  const out: MediaItem[] = []
  for (const r of (data.results || []).slice(0, 8)) {
    const id = String(r.id ?? '')
    const title = String(r.title ?? '').trim()
    if (!id || !title) continue
    const poster = String(r.poster_path ?? '')
    const original = String(r.original_title ?? '').trim()
    out.push({
      source: 'tmdb',
      type: 'movie',
      id,
      title: clampText(title, 60),
      year: String(r.release_date ?? '').slice(0, 4) || undefined,
      cover: poster ? `https://image.tmdb.org/t/p/w342${poster}` : undefined,
      rating: typeof r.vote_average === 'number' && r.vote_average > 0 ? Math.min(10, r.vote_average) : undefined,
      ratingCount: typeof r.vote_count === 'number' ? r.vote_count : undefined,
      meta: original && original !== title ? clampText(original, 80) : undefined,
      intro: r.overview ? clampText(String(r.overview), 150) : undefined,
      link: `https://www.themoviedb.org/movie/${encodeURIComponent(id)}`,
    })
  }
  return out
}

/** Deezer 音乐专辑（免 key、全球曲库；iTunes 中国区搜索对中国内容常年返回空） */
export function parseDeezer(text: string): MediaItem[] {
  let data: { data?: Array<Record<string, unknown>> }
  try {
    data = JSON.parse(text)
  } catch {
    return []
  }
  const out: MediaItem[] = []
  for (const r of (data.data || []).slice(0, 8)) {
    const id = String(r.id ?? '')
    const title = String(r.title ?? '').trim()
    if (!id || !title) continue
    const artist = (r.artist as Record<string, unknown> | undefined)?.name
    out.push({
      source: 'deezer',
      type: 'music',
      id,
      title: clampText(title, 60),
      year: String(r.release_date ?? '').slice(0, 4) || undefined,
      cover: String(r.cover_big ?? r.cover_medium ?? '') || undefined,
      meta: artist ? clampText(String(artist), 80) : undefined,
      link: String(r.link ?? ''),
    })
  }
  return out
}

/* ---------------- 搜索 / 详情编排 ---------------- */

async function fetchText(url: string, headers: Record<string, string>, fetchImpl: typeof fetch): Promise<string | null> {
  try {
    const res = await fetchImpl(url, { headers, redirect: 'follow', signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) })
    if (!res.ok) return null
    const text = await res.text()
    return text.length > MAX_BODY_BYTES ? null : text
  } catch {
    return null
  }
}

async function doubanSuggest(
  type: MediaType,
  q: string,
  relay: RelayConf | null,
  fetchImpl: typeof fetch
): Promise<{ items: MediaItem[]; blocked: boolean }> {
  const host = DOUBAN_HOST[type as Exclude<MediaType, 'music'>]
  const r = await fetchDouban(`https://${host}/j/subject_suggest?q=${encodeURIComponent(q)}`, `https://${host}/`, relay, fetchImpl)
  if (!r) return { items: [], blocked: false } // 网络/中转故障与风控区分开：这里只是拿不到
  if (r.blocked) return { items: [], blocked: true }
  return { items: parseDoubanSuggest(type, r.text), blocked: false }
}

/** 备用源：书 → Google 图书；影 → TMDB（配了免费 key）→ iTunes；音 → iTunes（免 key） */
async function fallbackSearch(opts: { type: MediaType; q: string; tmdbKey?: string; fetchImpl: typeof fetch }): Promise<MediaItem[]> {
  const { type, q, tmdbKey, fetchImpl } = opts
  const eq = encodeURIComponent(q)
  if (type === 'book') {
    const text = await fetchText(`https://www.googleapis.com/books/v1/volumes?q=${eq}&maxResults=8`, { 'User-Agent': UA }, fetchImpl)
    return parseGoogleBooks(text || '')
  }
  if (type === 'movie' && tmdbKey && /^[a-f0-9]{32}$/i.test(tmdbKey)) {
    const text = await fetchText(
      `https://api.themoviedb.org/3/search/movie?api_key=${encodeURIComponent(tmdbKey)}&query=${eq}&language=zh-CN`,
      { 'User-Agent': UA },
      fetchImpl
    )
    const items = parseTmdb(text || '')
    if (items.length) return items
  }
  if (type === 'music') {
    const text = await fetchText(`https://api.deezer.com/search/album?q=${eq}&limit=8`, { 'User-Agent': UA }, fetchImpl)
    const items = parseDeezer(text || '')
    if (items.length) return items
  }
  const entity = type === 'music' ? 'album' : 'movie'
  const text = await fetchText(
    `https://itunes.apple.com/search?term=${eq}&media=${type === 'music' ? 'music' : 'movie'}&entity=${entity}&country=cn&limit=8`,
    { 'User-Agent': UA },
    fetchImpl
  )
  return parseItunes(text || '', type)
}

export interface SearchOpts {
  type: MediaType
  q: string
  relay?: string
  relayToken?: string
  tmdbKey?: string
  fetchImpl?: typeof fetch
}

export interface SearchOutcome {
  items: MediaItem[]
  doubanBlocked: boolean
}

/** 搜索：豆瓣联想优先（音乐除外，接口已下线），空结果 / 被风控时自动落备用源 */
export async function searchMedia(opts: SearchOpts): Promise<SearchOutcome> {
  const q = opts.q.trim().slice(0, 80)
  if (!q) return { items: [], doubanBlocked: false }
  const fetchImpl = opts.fetchImpl ?? fetch
  const relay = validateRelay(String(opts.relay ?? ''), String(opts.relayToken ?? ''))
  let items: MediaItem[] = []
  let doubanBlocked = false
  if (SEARCH_AVAILABLE[opts.type]) {
    const r = await doubanSuggest(opts.type, q, relay, fetchImpl)
    if (r.blocked) doubanBlocked = true
    items = r.items
  }
  if (!items.length) items = await fallbackSearch({ type: opts.type, q, tmdbKey: opts.tmdbKey, fetchImpl })
  return { items: items.slice(0, 8), doubanBlocked }
}

export interface DetailOpts {
  type: MediaType
  id: string
  relay?: string
  relayToken?: string
  fetchImpl?: typeof fetch
}

/** 豆瓣条目详情（评分与简介只此一家）；blocked 时插件可用搜索结果里的已有字段退化插卡 */
export async function fetchDoubanDetail(opts: DetailOpts): Promise<{ item: MediaItem | null; blocked: boolean }> {
  const id = String(opts.id || '').trim()
  if (!/^\d{1,14}$/.test(id)) return { item: null, blocked: false }
  const fetchImpl = opts.fetchImpl ?? fetch
  const relay = validateRelay(String(opts.relay ?? ''), String(opts.relayToken ?? ''))
  const url = doubanDetailUrl(opts.type, id)
  const r = await fetchDouban(url, url, relay, fetchImpl)
  if (!r) return { item: null, blocked: false }
  if (r.blocked) return { item: null, blocked: true }
  return { item: parseSubjectHtml(opts.type, r.text, id), blocked: false }
}

/** 中转连通性探测（插件设置里的「测试」按钮） */
export async function probeRelay(
  relayUrl: string,
  relayToken: string,
  fetchImpl?: typeof fetch
): Promise<{ ok: boolean; blocked?: boolean; error?: string }> {
  const relay = validateRelay(relayUrl, relayToken)
  if (!relay) return { ok: false, error: '中转地址需为 https 公网地址，且令牌非空' }
  try {
    const res = await (fetchImpl ?? fetch)(`${relay.base}/api/health`, {
      headers: { Authorization: `Bearer ${relay.token}` },
      redirect: 'error',
      signal: AbortSignal.timeout(RELAY_TIMEOUT_MS),
    })
    if (!res.ok) return { ok: false, error: `中转响应 ${res.status}` }
    const data = (await res.json().catch(() => null)) as { ok?: boolean; cooldownUntil?: number } | null
    if (!data?.ok) return { ok: false, error: '中转响应格式异常' }
    if (data.cooldownUntil && data.cooldownUntil > Date.now()) return { ok: true, blocked: true }
    return { ok: true }
  } catch {
    return { ok: false, error: '连不上中转，请检查地址与令牌' }
  }
}

/** 详情被风控时插件拿搜索结果「补卡」用：只认白名单字段逐项校验重建，
 *  所有出参经 buildCardHtml 的 escAttr 转义，回显数据无法夹带结构 */
export function sanitizeMediaItem(raw: unknown): MediaItem | null {
  if (!raw || typeof raw !== 'object') return null
  const r = raw as Record<string, unknown>
  const type = String(r.type ?? '')
  const source = String(r.source ?? '')
  const id = String(r.id ?? '').trim()
  const title = String(r.title ?? '').trim()
  if (!(['book', 'movie', 'music'] as string[]).includes(type)) return null
  if (!(['douban', 'google', 'tmdb', 'deezer', 'itunes'] as string[]).includes(source)) return null
  if (!/^[\w-]{1,64}$/.test(id) || !title) return null
  const str = (v: unknown, n: number): string | undefined => {
    const s = String(v ?? '').replace(/[\r\n\t]/g, ' ').trim()
    return s ? s.slice(0, n) : undefined
  }
  const year = String(r.year ?? '').replace(/\D/g, '').slice(0, 4)
  return {
    source: source as MediaItem['source'],
    type: type as MediaType,
    id,
    title,
    year: /^\d{4}$/.test(year) ? year : undefined,
    cover: str(r.cover, 2048),
    rating: typeof r.rating === 'number' && r.rating > 0 && r.rating <= 10 ? r.rating : undefined,
    ratingCount:
      typeof r.ratingCount === 'number' && Number.isInteger(r.ratingCount) && r.ratingCount > 0 ? r.ratingCount : undefined,
    meta: str(r.meta, 200),
    intro: str(r.intro, 600),
    link: str(r.link, 2048),
  }
}

/* ---------------- 组卡（纯函数；结构与 linkmeta 同理，span + display:flex，段落内插入不破结构） ---------------- */

const SOURCE_LABEL: Record<MediaItem['source'], (type: MediaType) => string> = {
  douban: (t) => `豆瓣${t === 'book' ? '读书' : t === 'movie' ? '电影' : '音乐'}`,
  google: () => 'Google 图书',
  tmdb: () => 'TMDB',
  deezer: () => 'Deezer',
  itunes: () => 'iTunes',
}

function fmtCount(n: number): string {
  if (n >= 10000) return `${Math.round(n / 10000)}万人评`
  return `${n}人评`
}

/** 书影音卡片：内联样式（六主题零改动），配色取中性浅灰与豆瓣星色；
 *  data-no-dark 随净化白名单放行，防主题反色时卡片被反转。
 *  结构与 linkmeta 同理——span + display:flex 的整体 <a>，段落内插入不破结构。
 *  封面由端点侧 resolveCardCover 归一（站内 /images/ 优先）；这里只兜一道底：
 *  裸 doubanio 地址（防盗链必挂）不烘进文章，其余照用 */
export function buildCardHtml(item: MediaItem): string {
  const title = clampText(item.title, 60) || '未知条目'
  let cover = (item.cover || '').trim()
  if (/doubanio\.com\//.test(cover) && !cover.startsWith('/images/')) cover = ''
  const year = item.year ? `<span style="font-weight: 400;font-size: 12px;color: #999;"> (${escAttr(item.year)})</span>` : ''
  const meta = clampText(item.meta || '', 80)
  const intro = clampText(item.intro || '', 150)
  const rating =
    typeof item.rating === 'number' && item.rating > 0
      ? `<span style="display: block;margin-top: 6px;font-size: 13px;font-weight: 600;color: #b26b00;">★ ${escAttr(item.rating.toFixed(1))}${
          item.ratingCount ? `<span style="font-weight: 400;font-size: 12px;color: #999;"> ${escAttr(fmtCount(item.ratingCount))}</span>` : ''
        }</span>`
      : ''
  const src = SOURCE_LABEL[item.source]?.(item.type) || ''
  const link = (item.link || '').trim()

  const style =
    'display: flex;margin: 14px 0;padding: 12px 14px;background-color: #fafafa;border: 1px solid #ececec;border-radius: 10px;text-decoration: none;'
  const coverImg = cover ? `<img src="${escAttr(cover)}" alt="${escAttr(title)}" style="width: 84px;border-radius: 6px;flex-shrink: 0;">` : ''
  const innerSpan =
    `<span style="flex: 1;min-width: 0;${cover ? 'margin-left: 12px;' : ''}overflow: hidden;">` +
    `<span style="display: block;font-size: 15px;font-weight: 600;color: #333;line-height: 1.45;">${escAttr(title)}${year}</span>` +
    (meta ? `<span style="display: block;margin-top: 4px;font-size: 12px;color: #999;line-height: 1.5;">${escAttr(meta)}</span>` : '') +
    rating +
    (intro ? `<span style="display: block;margin-top: 6px;font-size: 12.5px;color: #666;line-height: 1.6;">${escAttr(intro)}</span>` : '') +
    (src ? `<span style="display: block;margin-top: 6px;font-size: 11px;color: #bbb;">数据 · ${escAttr(src)}</span>` : '') +
    `</span>`

  // 外层 <a>；无 link 时退化为 div（纯展示卡）。
  // data-no-dark 必须带空值：净化器只回传有值属性，裸写法会被整句剥掉
  const card = link
    ? `<a class="media-card" data-no-dark="" style="${style}" href="${escAttr(link)}" target="_blank" rel="noopener noreferrer">${coverImg}${innerSpan}</a>`
    : `<div class="media-card" data-no-dark="" style="${style}">${coverImg}${innerSpan}</div>`
  return card + '<p><br></p>'
}
