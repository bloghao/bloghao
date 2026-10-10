/**
 * 公众号采集插件（服务端）
 *
 * POST /api/admin/collect/wechat { url }
 * 抓取 mp.weixin.qq.com 单篇内容 → 解析正文/标题/发布时间 →
 * 配图与封面转存 R2 图床 → 生成一篇保留原发布时间的草稿。
 * 支持两种内容：普通图文（js_content）与贴图/图片消息（item_show_type=8，
 * 数据埋在内嵌 JS 里，见 parseImagePost）。
 * 编辑器里的「采集公众号文章」插件（public/plugins/wechat-collect.js）调用，
 * 草稿建好后由用户在编辑器中核对、修改，再手动发布。
 */
import { Hono } from 'hono'
import { clientIp, rateLimit } from './auth'
import { getPostById, uniqueSlug } from './db'
import { readBodyLimited } from './fetchsafe'
import { sanitizeHtml } from './sanitize'
import { transferImage } from './store'
import type { Env, SessionUser } from './types'
import { esc, excerpt, slugify } from './utils'

type CollectEnv = { Bindings: Env; Variables: { user: SessionUser } }

export const collectRoutes = new Hono<CollectEnv>()

const MAX_IMAGES = 30 // Workers 免费档单请求 50 个子请求，预留余量
const MAX_PAGE_BYTES = 5 * 1024 * 1024 // 抓取页面上限：贴图页（图片消息）内嵌 JS 数据可达 2-3MB
const MAX_HTML_BYTES = 900_000 // 生成的草稿正文上限，与文章接口 1MB 上限留余量
const FETCH_TIMEOUT_MS = 15_000 // 单次抓取（页面/图片）超时
const UA =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36'

const NAMED_ENTITIES: Record<string, string> = {
  nbsp: '\u00a0',
  lt: '<',
  gt: '>',
  quot: '"',
  apos: "'",
  ldquo: '\u201c',
  rdquo: '\u201d',
  lsquo: '\u2018',
  rsquo: '\u2019',
  hellip: '\u2026',
  mdash: '\u2014',
  ndash: '\u2013',
  amp: '&', // 必须最后处理，避免二次解码
}

function decodeEntities(s: string): string {
  let out = s.replace(/&#x([0-9a-f]+);/gi, (_, h) => {
    const code = parseInt(h, 16)
    return code > 0 && code < 0x110000 ? String.fromCodePoint(code) : ''
  })
  out = out.replace(/&#(\d+);/g, (_, d) => {
    const code = parseInt(d, 10)
    return code > 0 && code < 0x110000 ? String.fromCodePoint(code) : ''
  })
  return out.replace(/&([a-z]+);/gi, (m, name: string) => {
    const v = NAMED_ENTITIES[name.toLowerCase()]
    return v === undefined ? m : v
  })
}

function match1(html: string, re: RegExp): string {
  const m = re.exec(html)
  return m && m[1] ? m[1] : ''
}

/** 去标签取纯文本 */
function tagText(html: string): string {
  return decodeEntities(html.replace(/<[^>]+>/g, ''))
    .replace(/[ \t\u00a0]+/g, ' ')
    .trim()
}

/** 从 startIdx 处的 <div 开始，返回其内部 HTML（配对闭合） */
function innerHtmlOfDiv(html: string, divStart: number): string | null {
  const openEnd = html.indexOf('>', divStart)
  if (openEnd === -1) return null
  const re = /<div\b|<\/div>/g
  re.lastIndex = openEnd + 1
  let depth = 1
  let m: RegExpExecArray | null
  while ((m = re.exec(html))) {
    depth += m[0] === '</div>' ? -1 : 1
    if (depth === 0) return html.slice(openEnd + 1, m.index)
  }
  return null
}

/**
 * 定位正文容器 js_content。
 * 页面里同一内容可能出现多份（DOM + 内嵌 JS 数据），逐个候选，
 * 取「去标签后长度 > 60」的第一份。
 */
function findArticleBody(html: string): string | null {
  let from = 0
  for (let i = 0; i < 5; i++) {
    const idx = html.indexOf('id="js_content"', from)
    if (idx === -1) return null
    const divStart = html.lastIndexOf('<div', idx)
    if (divStart === -1) return null
    const body = innerHtmlOfDiv(html, divStart)
    if (body && tagText(body).length > 60) return body
    from = idx + 1
  }
  return null
}

interface ArticleMeta {
  title: string
  account: string
  cover: string
  publishedAt: number | null
}

/** var nickname = htmlDecode("…") / var x = '…' / var x = "…" 三种写法都兼容。
 *  捕获的是 JS 字符串字面量原文，统一走 unescapeJsString 全量解转义（\uXXXX 是其子集） */
function jsVar(html: string, name: string): string {
  return unescapeJsString(
    match1(html, new RegExp(`var ${name}\\s*=\\s*htmlDecode\\("([^"]*)"\\)`)) ||
      match1(html, new RegExp(`var ${name}\\s*=\\s*'([^']*)'`)) ||
      match1(html, new RegExp(`var ${name}\\s*=\\s*"([^"]*)"`, 'i'))
  )
}

/** 导出仅为回归测试 */
export function parseMeta(html: string): ArticleMeta {
  const title =
    tagText(match1(html, /<h1[^>]*id="activity-name"[^>]*>([\s\S]*?)<\/h1>/i)) ||
    tagText(match1(html, /<meta[^>]*property="og:title"[^>]*content="([^"]*)"/i)) ||
    tagText(jsVar(html, 'msg_title'))
  const account =
    tagText(match1(html, /<strong[^>]*id="js_name"[^>]*>([\s\S]*?)<\/strong>/i)) ||
    tagText(jsVar(html, 'nickname'))
  const cover = decodeEntities(
    match1(html, /var msg_cdn_url\s*=\s*'([^']+)'/) ||
      match1(html, /var msg_cdn_url\s*=\s*"([^"]+)"/) ||
      match1(html, /<meta[^>]*property="og:image"[^>]*content="([^"]*)"/i)
  )
  let publishedAt: number | null = null
  const ct = match1(html, /\bct\s*=\s*['"](\d{9,13})['"]/) // 贴图页是 window.ct = '秒'，普通图文是 var ct = "…"
  if (ct) {
    publishedAt = ct.length > 10 ? Number(ct) : Number(ct) * 1000
  } else {
    const t = match1(html, /var createTime\s*=\s*'(\d{4}-\d{2}-\d{2} \d{2}:\d{2})'/)
    if (t) publishedAt = Date.parse(t + ':00 +08:00')
  }
  return {
    title,
    account,
    cover,
    publishedAt: publishedAt !== null && Number.isFinite(publishedAt) ? publishedAt : null,
  }
}

/* ---------------- 贴图（图片消息，item_show_type=8） ---------------- */

export interface ImagePostData {
  title: string
  account: string
  images: string[]
  text: string
}

/** JS 字符串字面量反转义：\xHH、\uHHHH、\n\r\t 等与 \'\"\\；未知转义保留原字符 */
function unescapeJsString(s: string): string {
  return s.replace(/\\(x[0-9a-fA-F]{2}|u[0-9a-fA-F]{4}|n|r|t|b|f|v|0|['"\\])/g, (_, esc: string) => {
    if (esc[0] === 'x' || esc[0] === 'u') {
      const code = parseInt(esc.slice(1), 16)
      return code > 0 && code < 0x110000 ? String.fromCodePoint(code) : ''
    }
    const map: Record<string, string> = { n: '\n', r: '\r', t: '\t', b: '\b', f: '\f', v: '\v', '0': '\0' }
    return Object.prototype.hasOwnProperty.call(map, esc) ? map[esc] : esc
  })
}

/**
 * 解析贴图类（图片消息）页面。这类页面 DOM 里没有 js_content，图片列表
 * picture_page_info_list 和全文（window.desc / content_noencode）都埋在内嵌
 * JS 数据里，由前端脚本填充。不是贴图页返回 null（视频号/语音等保持原报错）。
 * 导出仅为回归测试。
 */
export function parseImagePost(html: string): ImagePostData | null {
  const isImagePost =
    /window\.item_show_type\s*=\s*['"]8['"]/.test(html) || /picture_page_info_list\s*:\s*\[/.test(html)
  if (!isImagePost) return null

  // 图片：扫第一份 picture_page_info_list 数组。跳过字符串字面量后按 {} 深度定位，
  // 只收条目对象顶层（深度为 1）的 cdn_url——share_cover / watermark_info 等
  // 嵌套对象里的分享图、水印图不是正文图，必须排除
  const images: string[] = []
  const listStart = html.search(/picture_page_info_list\s*:\s*\[/)
  if (listStart !== -1) {
    let i = html.indexOf('[', listStart) + 1 // 从开括号之后起扫，arrDepth 初值 1 对应它
    let arrDepth = 1
    let objDepth = 0
    while (i !== -1 && i < html.length && arrDepth > 0) {
      const ch = html[i]
      if (ch === "'") {
        const end = html.indexOf("'", i + 1)
        // 跳过字符串值（防 URL / crop_info 片段里的括号干扰深度计数），恢复点在闭引号之后
        i = end === -1 ? html.length : end + 1
        continue
      }
      if (ch === '[') arrDepth++
      else if (ch === ']') arrDepth--
      else if (ch === '{') objDepth++
      else if (ch === '}') objDepth--
      else if (objDepth === 1 && ch === 'c' && html.startsWith('cdn_url', i)) {
        const m = /^cdn_url\s*:\s*'([^']+)'/.exec(html.slice(i, i + 700))
        if (m) images.push(decodeEntities(m[1]))
      }
      i++
    }
  }

  const title =
    tagText(match1(html, /window\.msg_title\s*=\s*(?:window\.title\s*=\s*)?['"]([^'"\n]*)['"]/)) ||
    tagText(match1(html, /<meta[^>]*property="og:title"[^>]*content="([^"]*)"/i))
  const account =
    tagText(match1(html, /nick_name:\s*['"]([^'"\n]*)['"]/)) ||
    tagText(match1(html, /<meta[^>]*name="author"[^>]*content="([^"]*)"/i)) ||
    tagText(match1(html, /window\.name\s*=\s*"([^"\n]*)"/))

  // 全文：window.desc / content_noencode 是 JS 字符串（换行是 \x0a 转义），
  // 同一数据可能内嵌多份，取解码后最长的一份；meta description 带同样的 \x0a
  // 字面量，实体解码后按 JS 字符串反转义兜底
  const candidates: string[] = []
  for (const m of html.matchAll(/window\.desc\s*=\s*"((?:[^"\\\n]|\\.)*)"/g)) candidates.push(unescapeJsString(m[1]))
  for (const m of html.matchAll(/content_noencode:\s*(['"])((?:[^\\\n]|\\.)*)\1/g)) candidates.push(unescapeJsString(m[2]))
  candidates.push(
    unescapeJsString(decodeEntities(match1(html, /<meta[^>]*name="description"[^>]*content="([^"]*)"/i))),
    unescapeJsString(decodeEntities(match1(html, /<meta[^>]*property="og:description"[^>]*content="([^"]*)"/i)))
  )
  const text = candidates.reduce((a, b) => (b.length > a.length ? b : a), '').trim()

  if (!images.length && !text) return null
  return { title, account, images, text }
}

/** 贴图 → 有序块：沿用原页面版式，图片在前，文字按空行分段在后（段内单换行由 renderHtml 转 <br>） */
export function imagePostBlocks(post: ImagePostData): Block[] {
  return [
    ...post.images.map((src) => ({ type: 'img' as const, src })),
    ...post.text
      .split(/\n\s*\n+/)
      .map((p) => p.trim())
      .filter(Boolean)
      .map((text) => ({ type: 'text' as const, text })),
  ]
}

/* ---------------- 正文分块 ---------------- */

interface Block {
  type: 'text' | 'img'
  text?: string
  src?: string
}

/**
 * 微信图媒体 ID：mmbiz 图 URL 的身份段（…/mmbiz_jpg/<ID>/…）。
 * 公众号封面（msg_cdn_url）常是正文首图的衍生裁切——同一 ID、不同尺寸/格式段
 * （mmbiz_jpg/ID/640 vs mmbiz_png/ID/0），字符串比对永远不等，只有 ID 能认出是同一张。
 */
export function mmbizAssetId(url: string): string {
  const m = /mmbiz(?:_[a-z]+)?\/([A-Za-z0-9_-]+)\//i.exec(url)
  return m ? m[1] : ''
}

/** 正文里去掉与封面同媒体的图块（只去第一张）；贴图不适用（其封面本就取自首图） */
export function dropCoverDupBlock(blocks: Block[], cover: string): Block[] {
  const id = mmbizAssetId(cover)
  if (!id) return blocks
  const idx = blocks.findIndex((b) => b.type === 'img' && b.src && mmbizAssetId(b.src) === id)
  if (idx === -1) return blocks
  return blocks.slice(0, idx).concat(blocks.slice(idx + 1))
}

/**
 * 把正文 HTML 拆成有序的段落/图片块。
 * 公众号正文是大量嵌套 <section>，按 </section>/<p> 切块；
 * 段内保留加粗/斜体（哨兵标记，最后还原），其余样式丢弃。
 */
function parseBlocks(body: string): Block[] {
  const blocks: Block[] = []
  for (const token of body.split(/(<img\b[^>]*>)/i)) {
    if (!token) continue
    if (/^<img\b/i.test(token)) {
      blocks.push({
        type: 'img',
        src: decodeEntities(match1(token, /data-src="([^"]+)"/) || match1(token, /\ssrc="([^"]+)"/)),
      })
      continue
    }
    for (const raw of token.split(/<\/(?:section|p)>/i)) {
      const text = decodeEntities(
        raw
          .replace(/<br\s*\/?>/gi, '\n')
          .replace(/<(?:strong|b)\b[^>]*>/gi, '\u0001s')
          .replace(/<\/(?:strong|b)\b[^>]*>/gi, '\u0001/s')
          .replace(/<(?:em|i)\b[^>]*>/gi, '\u0001e')
          .replace(/<\/(?:em|i)\b[^>]*>/gi, '\u0001/e')
          .replace(/<[^>]+>/g, '')
      )
        // 清掉控制字符：防止 &#1; 之类数字实体还原出 \u0001 与加粗/斜体哨兵冲突
        .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, '')
        .replace(/[ \t\u00a0]+/g, ' ')
        .replace(/\n\s*\n+/g, '\n')
        .trim()
      if (text) blocks.push({ type: 'text', text })
    }
  }
  return blocks
}

/** 组装文章 HTML；转存失败的图片整块丢弃 */
function renderHtml(blocks: Block[], srcMap: Map<string, string>): string {
  const out: string[] = []
  for (const b of blocks) {
    if (b.type === 'img') {
      const local = srcMap.get(b.src || '')
      if (!local) continue
      out.push(`<p style="text-align: center"><img src="${local}" alt=""></p>`)
    } else {
      const html = esc(b.text || '')
        .replace(/\u0001s/g, '<strong>')
        .replace(/\u0001\/s/g, '</strong>')
        .replace(/\u0001e/g, '<em>')
        .replace(/\u0001\/e/g, '</em>')
        .replace(/\n/g, '<br>')
      if (html) out.push(`<p>${html}</p>`)
    }
  }
  return out.join('')
}

/* ---------------- 图片转存 ---------------- */
/* 抓取 → 魔数识别 → R2 落库的共用实现在 src/store.ts transferImage（粘贴净化同用） */

/* ---------------- 路由 ---------------- */

collectRoutes.post('/wechat', async (c) => {
  const body = (await c.req.json().catch(() => null)) as { url?: unknown } | null
  const url = String(body?.url ?? '').trim()
  if (!/^https:\/\/mp\.weixin\.qq\.com\/s/i.test(url)) {
    return c.json({ error: '请输入 mp.weixin.qq.com 的公众号文章链接' }, 400)
  }
  if (!rateLimit(`collect:${clientIp(c.req.raw)}`, 10, 60_000)) {
    return c.json({ error: '采集太频繁，请稍后再试' }, 429)
  }

  let html: string
  try {
    const res = await fetch(url, {
      headers: { 'User-Agent': UA, Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8' },
      redirect: 'follow',
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    })
    if (!res.ok) return c.json({ error: `抓取失败（HTTP ${res.status}）` }, 502)
    // 声明长度超限直接放弃；读体走流式限长（gzip 解压后可能远超 content-length，防整读进内存）
    if (Number(res.headers.get('content-length') || 0) > MAX_PAGE_BYTES) {
      return c.json({ error: '页面过大，抓取失败' }, 502)
    }
    const buf = await readBodyLimited(res, MAX_PAGE_BYTES)
    if (!buf) {
      return c.json({ error: '页面过大，抓取失败' }, 502)
    }
    html = new TextDecoder().decode(buf)
  } catch {
    return c.json({ error: '网络错误，抓取失败' }, 502)
  }

  const articleBody = findArticleBody(html)
  const imagePost = articleBody ? null : parseImagePost(html)
  if (!articleBody && !imagePost) {
    if (/环境异常|操作频繁|完成验证|安全验证/.test(html)) {
      return c.json({ error: '微信要求安全验证，请稍后再试，或换一个网络环境' }, 502)
    }
    if (/此内容因违规|已被发布者删除|已删除/.test(html)) {
      return c.json({ error: '文章已被删除或因违规无法查看' }, 404)
    }
    return c.json({ error: '没有抓到文章正文，请确认这是公众号图文链接' }, 422)
  }

  const meta = parseMeta(html)
  if (imagePost) {
    if (imagePost.title) meta.title = imagePost.title
    if (imagePost.account) meta.account = imagePost.account
    if (!meta.cover && imagePost.images[0]) meta.cover = imagePost.images[0]
  }
  // imagePost 为空时 articleBody 必非空（!articleBody && !imagePost 已提前返回）
  // 封面只留封面位：正文里与封面同媒体的图不再重收（贴图除外——其封面本就取自首图，图即内容）
  const blocks: Block[] = imagePost ? imagePostBlocks(imagePost) : dropCoverDupBlock(parseBlocks(articleBody!), meta.cover)

  // 配图转存（按出现顺序，去重，限量）
  const imgUrls = [
    ...new Set(
      blocks
        .filter((b) => b.type === 'img' && b.src && /^https?:\/\//i.test(b.src))
        .map((b) => b.src as string)
    ),
  ].slice(0, MAX_IMAGES)
  const srcMap = new Map<string, string>()
  let saved = 0
  for (const src of imgUrls) {
    const local = await transferImage(c.env, src, `公众号配图-${saved + 1}`)
    if (local) {
      srcMap.set(src, local)
      saved++
    }
  }

  // 封面转存
  let cover = ''
  if (meta.cover && /^https?:\/\//i.test(meta.cover)) {
    cover = (await transferImage(c.env, meta.cover, '公众号封面')) || ''
  }

  const content = sanitizeHtml(renderHtml(blocks, srcMap))
  // 有转存成功的配图就算非空（贴图可能只有图没有文字）
  if (!/<img\b/i.test(content) && !content.replace(/<[^>]+>/g, '').trim()) {
    return c.json({ error: '正文为空，无法采集' }, 422)
  }
  if (new TextEncoder().encode(content).length > MAX_HTML_BYTES) {
    return c.json({ error: '文章过长，无法采集' }, 422)
  }

  const title = (meta.title || '无标题').slice(0, 150)
  const now = Date.now()
  const slug = await uniqueSlug(c.env.DB, slugify(title) || `c-${now.toString(36)}`)
  const res = await c.env.DB.prepare(
    `INSERT INTO posts (slug, title, content, summary, cover, tags, status, pinned, author_id, published_at, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, '[]', 'draft', 0, ?, ?, ?, ?)`
  )
    .bind(slug, title, content, excerpt(content, 80), cover, c.get('user').id, meta.publishedAt, now, now)
    .run()
  const post = await getPostById(c.env.DB, Number(res.meta.last_row_id))
  return c.json({ ok: true, post, account: meta.account, images: saved })
})
