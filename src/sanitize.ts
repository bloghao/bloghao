/**
 * HTML 白名单净化器
 *
 * 文章正文是管理员/作者书写的富文本（可能来自公众号等外部编辑器的粘贴），
 * 因此存储前统一走这里：只保留安全标签与安全属性，其余一律剥掉（保留其内部文字）。
 *
 * 同时遵循《微信公众平台编辑器插件开发规范》中的排版友好原则：
 * - 保留 data-w / data-ignore-width / data-no-dark / data-ignore-dm 等规范属性
 * - 内联样式仅保留排版类属性，且 url() 只允许站内相对路径
 */

import { wrapAnchorHref } from './outlink'


const VOID_TAGS = new Set(['br', 'hr', 'img', 'source', 'wbr'])

/** 连同内容一起丢弃的标签（安全风险或与排版无关） */
const DROP_WITH_CONTENT = new Set([
  'script', 'style', 'iframe', 'object', 'embed', 'noscript', 'svg', 'math',
  'form', 'input', 'button', 'select', 'textarea', 'option', 'link', 'meta',
  'base', 'frame', 'frameset', 'applet', 'template', 'dialog', 'audio',
])

/** 上面名单里的 void 元素：HTML 规范没有结束标签，「丢弃到结束标签」的扫描永远
 *  找不到 `</meta>`，会把其后全部内容吞掉——微信剪贴板以 `<meta charset='utf-8'>`
 *  开头，整段粘贴内容曾因此消失（编辑器表现为「粘贴没反应」） */
const DROP_VOID = new Set(['meta', 'link', 'base', 'input', 'embed'])

/** meta 例外：编辑器生成的 OG 分享卡图标记（<meta data-og-image="/images/...">），存进正文供前台输出 og:image */
const OG_META_RE = /^\s*<meta[^>]*\bdata-og-image=(?:"[^"]+"|'[^']+'|[^\s>]+)[^>]*\/?>\s*$/i

/** 从 OG meta 里取卡图 URL；必须是站内相对路径，拒绝任何外链/协议。
 *  属性值同样先做一轮实体解码（编辑器序列化产物是 &amp; 形态） */
function ogImageUrl(raw: string): string | null {
  const m = /data-og-image=(?:"([^"]*)"|'([^']*)'|([^\s>]+))/i.exec(raw)
  const v = decodeAttrEntities(m?.[1] ?? m?.[2] ?? m?.[3] ?? '').trim()
  return v.startsWith('/images/') && !v.includes('"') && !/[\s<>]/.test(v) ? v : null
}

const ALLOWED_TAGS = new Set([
  'p', 'br', 'hr', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6',
  'blockquote', 'pre', 'code', 'kbd', 'samp',
  'ul', 'ol', 'li', 'a', 'img', 'video', 'source',
  'strong', 'b', 'em', 'i', 'u', 's', 'del', 'ins', 'mark', 'sup', 'sub', 'small', 'abbr', 'cite', 'q', 'span',
  'section', 'div', 'figure', 'figcaption',
  'table', 'thead', 'tbody', 'tfoot', 'tr', 'th', 'td', 'caption',
  'details', 'summary',
])

/** 所有标签都可用的属性。
 *  不放行 id：正文在评论区之前，<img id="comment-form"> 之类的 DOM clobbering
 *  会让 site.js 的 getElementById 命中正文元素，评论区功能瘫痪（锚点锚 id 同理不可靠）
 *  data-link-card 是编辑器「链接卡片」的结构标记（src/linkmeta.ts），纯样式钩子 */
const GLOBAL_ATTRS = new Set(['class', 'data-w', 'data-ignore-width', 'data-no-dark', 'data-ignore-dm', 'data-link-card'])

const TAG_ATTRS: Record<string, Set<string>> = {
  a: new Set(['href', 'target', 'title']),
  img: new Set(['src', 'alt', 'title', 'width', 'height']),
  video: new Set(['src', 'poster', 'controls', 'width', 'height', 'preload', 'playsinline']),
  source: new Set(['src', 'type']),
  ol: new Set(['start', 'type']),
  li: new Set(['value']),
  th: new Set(['colspan', 'rowspan']),
  td: new Set(['colspan', 'rowspan']),
  details: new Set(['open']),
}

const BOOL_ATTRS = new Set(['controls', 'playsinline', 'open'])

/** 内联样式允许的属性（排版用途白名单） */
const CSS_PROP =
  /^(?:color|background-color|background|font-size|font-weight|font-style|font-family|letter-spacing|line-height|text-align|text-decoration|text-decoration\+\w+|text-indent|text-transform|white-space|word-break|word-spacing|vertical-align|display|margin|margin-(?:top|right|bottom|left)|padding|padding-(?:top|right|bottom|left)|border(?:-(?:top|right|bottom|left))?(?:-\w+)?|border-radius(?:-\w+)?|width|max-width|min-width|height|max-height|float|clear|opacity|overflow(?:-(?:x|y))?|box-shadow|list-style(?:-\w+)?|flex(?:-\w+)?|align-\w+|justify-\w+)$/

function escAttr(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;')
}
export { escAttr }

/** 属性值实体解码（一轮）：contenteditable 序列化出的 href/src 恒是 &amp; 形态，
 *  不解码就 escAttr 会存成 &amp;amp; —— 含 & 的链接存库即坏，且每「编辑→保存」
 *  一轮多加一层 amp;。只认 HTML 序列化器会产出的实体，未知实体原样保留。
 *  安全不变式：解码后立刻过 safeUrl 校验，输出前 escAttr 重新转义——消费端（浏览器）
 *  只解码一轮，正好回到这里检验过的字符串；`java&#9;script:` 解码成真 tab 反而更早暴露 */
function decodeAttrEntities(s: string): string {
  return s.replace(/&(amp|lt|gt|quot|apos|#x?[0-9a-fA-F]+);/g, (whole, code: string) => {
    if (code === 'amp') return '&'
    if (code === 'lt') return '<'
    if (code === 'gt') return '>'
    if (code === 'quot') return '"'
    if (code === 'apos') return "'"
    const n = code.startsWith('#x') || code.startsWith('#X') ? parseInt(code.slice(2), 16) : parseInt(code.slice(1), 10)
    return Number.isFinite(n) && n > 0 && n < 0x110000 ? String.fromCodePoint(n) : whole
  })
}

/** 危险协议一律拒绝；相对路径、https(s)、mailto、页内锚点放行。
 *  先剥掉 tab/换行：URL 解析器会忽略它们，`jav\tascript:` 这类混淆不能靠前缀正则漏过去 */
function safeUrl(v: string): boolean {
  const t = v.replace(/[\t\r\n]/g, '').trim().toLowerCase()
  if (/^(javascript|vbscript|data|file|blob|about):/.test(t)) return false
  if (/^[a-z][a-z0-9+.-]*:/.test(t)) return /^https?:/.test(t) || t.startsWith('mailto:')
  return true
}

function sanitizeStyle(v: string): string {
  const keep: string[] = []
  for (const decl0 of v.split(';')) {
    const decl = decl0.trim()
    if (!decl) continue
    const i = decl.indexOf(':')
    if (i < 1) continue
    const prop = decl.slice(0, i).trim().toLowerCase()
    let val = decl
      .slice(i + 1)
      .replace(/!important/gi, '')
      .trim()
    if (!CSS_PROP.test(prop) || !val) continue
    if (/expression\s*\(|behavior\s*:|javascript:/i.test(val)) continue
    // url() 只允许站内相对路径，外链背景图换成 none（防追踪/防外域依赖）
    val = val.replace(/url\(\s*(['"]?)([^'")]+)\1\s*\)/gi, (_m, _q, u: string) => {
      const url = String(u).trim()
      return url.startsWith('/') ? `url("${url}")` : 'none'
    })
    keep.push(`${prop}: ${val}`)
  }
  return keep.join('; ')
}

function sanitizeAttrs(tag: string, raw: string, origin?: string): string {
  const allowed = TAG_ATTRS[tag] ?? new Set<string>()
  const are = /([a-zA-Z_:][-a-zA-Z0-9_:.]*)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'=<>`]+)))?/g
  const seen = new Set<string>()
  let out = ''
  let m: RegExpExecArray | null
  while ((m = are.exec(raw))) {
    const name = m[1].toLowerCase()
    if (seen.has(name)) continue
    seen.add(name)
    if (name.startsWith('on')) continue
    const rawVal = m[2] ?? m[3] ?? m[4]

    if (name === 'style') {
      if (rawVal !== undefined) {
        const s = sanitizeStyle(rawVal)
        if (s) out += ` style="${escAttr(s)}"`
      }
      continue
    }
    const isGlobal = GLOBAL_ATTRS.has(name)
    if (!isGlobal && !allowed.has(name)) continue

    if (rawVal === undefined) {
      if (BOOL_ATTRS.has(name)) out += ` ${name}`
      continue
    }
    // 一轮实体解码还原浏览器 DOM 值（编辑器序列化产物是 &amp; 形态），输出前 escAttr 再转义回去
    let v = decodeAttrEntities(rawVal).trim()

    if (name === 'href' || name === 'src' || name === 'poster') {
      if (!safeUrl(v)) continue
      if (name === 'href') {
        // 外链中间页（src/outlink.ts）：仅在渲染路径传 origin 时包装非白名单外链——
        // 存库 / RSS / 导出不传 origin，落盘内容保持原始 URL；/go?u= 是相对地址，重复净化不会二次包装
        const wrapped = origin ? wrapAnchorHref(v, origin) : null
        if (wrapped) {
          out += ` href="${escAttr(wrapped)}" target="_blank" rel="nofollow noopener noreferrer"`
          continue
        }
        out += ` href="${escAttr(v)}"`
        if (/^https?:\/\//i.test(v)) out += ' rel="noopener noreferrer"'
        continue
      }
      out += ` ${name}="${escAttr(v)}"`
      continue
    }
    if (name === 'target') {
      if (!/^(?:_blank|_self)$/i.test(v)) continue
      out += ` target="${escAttr(v)}"`
      continue
    }
    if (name === 'class') {
      v = v.replace(/[^\w\- ]/g, '').replace(/\s+/g, ' ').trim()
      if (!v) continue
    }
    if (name === 'data-w') {
      if (!/^\d{1,5}$/.test(v)) continue
    }
    if (name === 'data-link-card') {
      if (v !== '' && v !== 'link-card') continue // 固定值标记，别的值一律剥
    }
    out += ` ${name}="${escAttr(v)}"`
  }
  return out
}

/** 透传段的裸 `<` 防护：未终结的标签前缀（`<img src=x onerror=…`，无 `>`）与未闭合注释
 *  `<!--` 不会被标签正则匹配、会原样进输出——浏览器会把后续页面标记当成该 img 的属性
 *  （内联事件处理器借此复活）或把后面整页吞进注释。把「< 后紧跟字母 / </ / <! / <?」
 *  的孤立 < 转义为 &lt;（`3<5`、`<3` 这类正常文本不受影响） */
function escapeStrayLt(segment: string): string {
  return segment.replace(/<(?=[a-zA-Z/!?])/g, '&lt;')
}

export function sanitizeHtml(input: string, opts?: { origin?: string }): string {
  if (!input) return ''
  const origin = opts?.origin
  const re = /<!--[\s\S]*?-->|<(\/?)([a-zA-Z][a-zA-Z0-9-]*)((?:"[^"]*"|'[^']*'|[^"'>])*?)(\/?)>/g
  let out = ''
  let last = 0
  let m: RegExpExecArray | null
  while ((m = re.exec(input))) {
    out += escapeStrayLt(input.slice(last, m.index))
    last = re.lastIndex
    if (m[0].startsWith('<!--')) continue

    const isClose = m[1] === '/'
    const name = m[2].toLowerCase()
    const attrsRaw = m[3] ?? ''
    const selfClosed = m[4] === '/'

    if (DROP_WITH_CONTENT.has(name)) {
      // 例外：OG 卡图 meta（必须整段只有一个 meta 且 URL 是站内 /images/ 路径）原样放行
      if (name === 'meta' && !isClose && OG_META_RE.test(m[0])) {
        const url = ogImageUrl(attrsRaw)
        if (url) {
          out += `<meta data-og-image="${escAttr(url)}" content="${escAttr(url)}">`
          continue
        }
      }
      if (!isClose && !selfClosed && !DROP_VOID.has(name)) {
        // 丢弃到对应结束标签为止；未闭合则丢弃其后全部内容（对 script/style 是正确行为）
        const rest = input.slice(last)
        const cm = new RegExp(`</${name}[\\s>]`, 'i').exec(rest)
        last = cm ? last + cm.index : input.length
        re.lastIndex = last
      }
      continue
    }
    if (!ALLOWED_TAGS.has(name)) continue // 不认识的标签：剥壳留字

    if (isClose) {
      out += `</${name}>`
      continue
    }
    const attrs = sanitizeAttrs(name, attrsRaw, origin)
    out += `<${name}${attrs}>`
  }
  out += escapeStrayLt(input.slice(last))
  return out
}

/** 取正文里的 OG 分享卡图 URL（sanitize 后的 content 只会有合法的站内 /images/ 路径） */
export function extractOgImage(contentHtml: string): string | null {
  const m = /<meta[^>]+data-og-image="([^"]+)"/i.exec(contentHtml)
  return m?.[1] ?? null
}
