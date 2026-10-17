/**
 * 站长 SEO 自定义与结构化数据辅助（ROADMAP B20 / B23 / B24，2026-10-13）。
 *
 * 纯函数模块，Node 测试直接导入（tests/seo.test.ts），不依赖 Workers 运行时。四块能力：
 *  ① 站点验证 meta 与统计脚本：后台只收「结构化输入」，这里解析成规范化值存库，渲染时按结构化值
 *     重新拼装输出——绝不做原始 HTML 透传（后台账号被盗时不存在现成的存储型 XSS 注入口）；
 *  ② robots.txt 组装：内置段 + settings.robotsExtra 追加段 + AI 抓取策略声明段（含 Content-Signal）；
 *  ③ AI 抓取策略（settings.aiPolicy）：按「训练型拒绝 / 检索引用型放行」把 src/bots.ts 的
 *     AI 令牌名单写成 robots 声明，默认档与历史输出逐字节一致；
 *  ④ Speculation Rules 预取声明、面包屑 JSON-LD 构造、预取请求识别。
 *
 * 防线（AGENTS.md「结构速查」/ 回归防线）：
 *  - 验证 meta 只认白名单 name（VERIFY_META_NAMES）且属性值形态受限，输出一律过 esc；
 *  - 统计脚本只放行 https + src/async/defer/id/crossorigin/referrerpolicy/data-* 属性，
 *    内联脚本体整体拒绝（CSP 不放行内联，也不做代码透传）；
 *  - 预取声明只声明同源链接且排除后台 / 开放 API / 外链中间页 / XML 订阅端点；
 *    预取与预渲染请求（Sec-Purpose 头）不计阅读量、不打点（统计诚实性）。
 */
import { esc } from './utils'
import { AI_SEEK_AGENTS, AI_TRAIN_AGENTS } from './bots'
import type { SettingsMap } from './types'

/* ---------------- 一、站点验证 meta（settings.verifyMetas） ---------------- */

/** 可重放的验证 meta name 白名单：各搜索引擎 / 平台站长工具的站点验证字段（小写比对） */
export const VERIFY_META_NAMES = [
  'google-site-verification',
  'msvalidate.01',
  'baidu-site-verification',
  'sogou_site_verification',
  '360-site-verification',
  'yandex-verification',
  'naver-site-verification',
  'facebook-domain-verification',
  'p:domain_verify',
]
const VERIFY_META_SET = new Set(VERIFY_META_NAMES)

/** 验证码取值形态：各平台的验证串都是 base64/hex/slug 一类（不含引号、尖括号、空白），形态不符直接拒绝 */
const VERIFY_VALUE_RE = /^[A-Za-z0-9._:/+=%~-]{1,200}$/

/** 单次最多重放的验证标签数（正常 1-3 条，10 条足够，防批量灌库） */
const VERIFY_META_MAX = 10

export interface VerifyMeta {
  name: string
  content: string
}

/**
 * 解析标签属性串 → 小写属性名映射（`a="v"` / `a='v'` / `a=v` 都认，无值属性记空串）。
 * 形态不合规（夹带识别不了的内容、重复属性）返回 null——宁拒不猜。
 */
function parseAttrs(src: string): Record<string, string> | null {
  const out: Record<string, string> = {}
  const re = /([a-zA-Z_:][-a-zA-Z0-9_:.]*)\s*(?:=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'=<>`]+)))?/g
  let last = 0
  let m: RegExpExecArray | null
  while ((m = re.exec(src))) {
    if (src.slice(last, m.index).trim() !== '') return null
    last = m.index + m[0].length
    const name = m[1].toLowerCase()
    if (Object.prototype.hasOwnProperty.call(out, name)) return null
    out[name] = m[2] ?? m[3] ?? m[4] ?? ''
  }
  if (src.slice(last).trim() !== '') return null
  return out
}

/**
 * 解析站长粘贴的验证标签（每行一条 `<meta name="…" content="…">`）。
 * 任一行不合法（非 meta 标签、name 不在白名单、content 形态不符、夹带别的属性）整体返回 null，
 * 后台按「格式不正确」整体 400——静默丢弃会让站长以为配好了，实际没生效。
 */
export function parseVerifyMetas(raw: string): VerifyMeta[] | null {
  const lines = String(raw ?? '')
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean)
  if (lines.length > VERIFY_META_MAX) return null
  const out = new Map<string, string>()
  for (const line of lines) {
    const m = line.match(/^<meta\b([^>]*?)\/?>$/i)
    if (!m) return null
    const attrs = parseAttrs(m[1])
    if (!attrs) return null
    const name = (attrs.name || '').toLowerCase()
    const content = attrs.content || ''
    if (!VERIFY_META_SET.has(name)) return null
    if (!VERIFY_VALUE_RE.test(content)) return null
    // 只认 name / content 两个属性；charset、http-equiv 等一概拒绝
    if (Object.keys(attrs).some((k) => k !== 'name' && k !== 'content')) return null
    out.set(name, content) // 同名后者覆盖：站长换验证码时直接替换
  }
  return [...out].map(([name, content]) => ({ name, content }))
}

/** 落库形态（规范化 JSON）：空输入 = 清除，非法输入返回 null（调用方 400） */
export function cleanVerifyMetas(raw: string): string | null {
  const input = String(raw ?? '').trim()
  if (!input) return ''
  const list = parseVerifyMetas(input)
  return list ? (list.length ? JSON.stringify(list) : '') : null
}

/** 读库形态 → 结构化数组（脏值 / 手工改库一律当没配，渲染层不抛错） */
function readVerifyMetas(json: string | undefined): VerifyMeta[] {
  if (!json) return []
  try {
    const arr: unknown = JSON.parse(json)
    if (!Array.isArray(arr)) return []
    return arr
      .filter(
        (v): v is VerifyMeta =>
          !!v &&
          typeof (v as VerifyMeta).name === 'string' &&
          typeof (v as VerifyMeta).content === 'string' &&
          VERIFY_META_SET.has((v as VerifyMeta).name) &&
          VERIFY_VALUE_RE.test((v as VerifyMeta).content)
      )
      .slice(0, VERIFY_META_MAX)
  } catch {
    return []
  }
}

/** 验证 meta 的渲染 HTML（结构化值重放 + esc 转义）；未配置 / 解析不出时返回空串 */
export function verifyMetaTagsHtml(json: string | undefined): string {
  return readVerifyMetas(json)
    .map((v) => `<meta name="${esc(v.name)}" content="${esc(v.content)}">`)
    .join('\n')
}

/* ---------------- 二、统计脚本（settings.analyticsScript） ---------------- */

/** 允许重放的属性（data-* 另有独立正则）：provider 片段里的常见配置位 */
const ANALYTICS_ATTRS = new Set(['src', 'async', 'defer', 'id', 'crossorigin', 'referrerpolicy'])
const ANALYTICS_DATA_RE = /^data-[a-z0-9-]{1,30}$/

export interface AnalyticsScript {
  src: string
  attrs: Record<string, string>
}

function isHttpsUrl(u: string): boolean {
  try {
    const url = new URL(u)
    return url.protocol === 'https:' && !!url.hostname && !url.username && !url.password
  } catch {
    return false
  }
}

/**
 * 解析统计脚本：接受**裸 URL**（`https://…/script.js`）或**整段脚本标签**
 * （provider 后台复制的 `<script async src=… data-website-id=…></script>`，如 Umami / Plausible /
 * CF Web Analytics / 51la）。标签体必须为空——内联配置代码一律拒绝（CSP 禁内联，也不做代码透传），
 * 白名单外的属性（on* 等）同样整体拒绝。需要内联 gtag('config') 的 GA4 / GTM 走不到这条设置。
 */
export function parseAnalyticsScript(raw: string): AnalyticsScript | null {
  const input = String(raw ?? '').trim()
  if (!input) return null
  let attrs: Record<string, string> | null = null
  if (!input.includes('<') && !/\s/.test(input)) {
    attrs = { src: input }
  } else {
    const m = input.match(/^<script\b([^>]*)>([\s\S]*?)<\/script>$/i)
    if (!m) return null
    if (m[2].trim() !== '') return null
    attrs = parseAttrs(m[1])
  }
  if (!attrs) return null
  const src = attrs.src || ''
  if (!src || src.length > 500 || /\s/.test(src) || !isHttpsUrl(src)) return null
  const kept: Record<string, string> = {}
  for (const [k, v] of Object.entries(attrs)) {
    if (k === 'src') continue
    if (!ANALYTICS_ATTRS.has(k) && !ANALYTICS_DATA_RE.test(k)) return null
    if (v.length > 300) return null
    kept[k] = v
  }
  return { src, attrs: kept }
}

/** 落库形态（规范化 JSON，属性按名排序保证同输入同输出）：空输入 = 清除，非法输入返回 null */
export function cleanAnalyticsScript(raw: string): string | null {
  const input = String(raw ?? '').trim()
  if (!input) return ''
  const parsed = parseAnalyticsScript(input)
  if (!parsed) return null
  const attrs: Record<string, string> = {}
  for (const k of Object.keys(parsed.attrs).sort()) attrs[k] = parsed.attrs[k]
  return JSON.stringify({ src: parsed.src, attrs })
}

function readAnalyticsScript(json: string | undefined): AnalyticsScript | null {
  if (!json) return null
  try {
    const v: unknown = JSON.parse(json)
    const obj = v as AnalyticsScript
    if (!obj || typeof obj.src !== 'string' || !isHttpsUrl(obj.src) || obj.src.length > 500) return null
    const kept: Record<string, string> = {}
    for (const [k, val] of Object.entries(obj.attrs || {})) {
      if (typeof val !== 'string' || val.length > 300) return null
      if (!ANALYTICS_ATTRS.has(k) && !ANALYTICS_DATA_RE.test(k)) return null
      kept[k] = val
    }
    return { src: obj.src, attrs: kept }
  } catch {
    return null
  }
}

/** 统计脚本渲染 HTML（属性按名排序，布尔属性不带值）；未配置 / 非法时返回空串 */
export function analyticsScriptHtml(json: string | undefined): string {
  const p = readAnalyticsScript(json)
  if (!p) return ''
  const names = [...Object.keys(p.attrs), 'src'].sort()
  const parts = names.map((k) => (k === 'src' ? `src="${esc(p.src)}"` : p.attrs[k] ? `${k}="${esc(p.attrs[k])}"` : k))
  return `<script ${parts.join(' ')}></script>`
}

/** 统计脚本的域（CSP script-src / connect-src 放行用）；未配置 / 非法返回 null */
export function analyticsOrigin(json: string | undefined): string | null {
  const p = readAnalyticsScript(json)
  if (!p) return null
  try {
    return new URL(p.src).origin
  } catch {
    return null
  }
}

/* ---------------- 三、robots.txt 追加段（settings.robotsExtra） ---------------- */

/** 追加段长度上限（robots.txt 是公开纯文本，正常几十行足够） */
const ROBOTS_EXTRA_MAX = 2000

/**
 * robots.txt 追加段规范化：去 BOM、CRLF 归一、剥控制字符（XML/文本协议里的老问题）、
 * 行尾空白修剪、连续空行折叠、限长（超限按整行截断，不产出半行指令）。
 */
export function cleanRobotsExtra(raw: string): string {
  const normalized = String(raw ?? '')
    .replace(/^\uFEFF/, '')
    .replace(/\r\n?/g, '\n')
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, '')
    .split('\n')
    .map((l) => l.replace(/[ \t]+$/, ''))
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
  if (normalized.length <= ROBOTS_EXTRA_MAX) return normalized
  const cut = normalized.slice(0, ROBOTS_EXTRA_MAX)
  const nl = cut.lastIndexOf('\n')
  return (nl > 0 ? cut.slice(0, nl) : cut).trim()
}

/* ---------------- 四、AI 抓取策略（robots 声明 + Content-Signal，2026-10-17） ----------------
 * 站长立场可声明的一句话：训练型 AI 拒绝、检索引用型 AI 放行——两者商业含义相反
 * （训练=无偿拿走内容；检索=回答里带来源链接、替引流），必须能分开表态。
 * AI 爬虫名单唯一事实源是 src/bots.ts 的 BOT_RULES（AI_TRAIN_AGENTS / AI_SEEK_AGENTS 派生），
 * 本模块只负责「按策略把名单写成 robots 声明」。
 *
 * 声明性质：robots.txt 与 Content-Signal 同为「表达偏好」，不构成技术拦截（real-world 拦截
 * 交给 Cloudflare 侧 AI Crawl Control）。托管在 Cloudflare 的站会由平台读取 Content-Signal
 * 执行；自托管（docker-poc）只落到声明层，属既定取舍。
 * 参考：contentsignals.org / Cloudflare「robots.txt setting」文档（Content-signal 字段写在
 * User-Agent: * 组内）；Google Search Console 可能对 Content-signal 报「Syntax not understood」，
 * 官方实测对抓取与收录无影响。 */

/** AI 抓取策略三档（与 settings.aiPolicy 对应），写路径白名单（api.ts）与读路径都以此为准 */
export type AiPolicy = 'allow' | 'seek' | 'deny'

/** 策略取值白名单（写路径校验用；唯一来源，别在 api.ts 再抄一份） */
export const AI_POLICY_VALUES: readonly AiPolicy[] = ['allow', 'seek', 'deny']

/** settings.aiPolicy → 策略。脏值 / 缺省一律当 'allow'（渲染端容错口径：宁放行不误伤，
 *  且默认档 robots.txt 输出与历史版本逐字节一致——老站无此键行为不变） */
export function readAiPolicy(v: unknown): AiPolicy {
  return v === 'seek' || v === 'deny' ? v : 'allow'
}

/** Content-Signal 声明行（写在既有 User-agent: * 组内，不另起组）。
 *  search 恒 yes——搜索收录归 settings.siteNoindex 管，AI 策略不越界；
 *  ai-input = RAG / 实时生成式回答取用，ai-train = 模型训练。默认档返回空串（逐字节兼容） */
function contentSignalLine(policy: AiPolicy): string {
  if (policy === 'allow') return ''
  const aiInput = policy === 'seek' ? 'yes' : 'no'
  return `Content-signal: search=yes, ai-input=${aiInput}, ai-train=no\n`
}

/** AI 策略的 robots 声明块（默认档返回空串）。令牌去重 + 排序保证「同输入同输出」 */
function aiRobotsBlock(policy: AiPolicy): string {
  if (policy === 'allow') return ''
  const uniq = (a: string[]) => [...new Set(a)].sort()
  const header = '# 站长的 AI 抓取策略（博客号 BlogHao「设置 → 站点 → AI 抓取策略」）'
  if (policy === 'deny') {
    return [
      header,
      '# 所有 AI 爬虫（训练 + 检索）一律不允许抓取',
      ...uniq([...AI_TRAIN_AGENTS, ...AI_SEEK_AGENTS]).map((u) => `User-agent: ${u}`),
      'Disallow: /',
    ].join('\n')
  }
  return [
    header,
    '# 检索引用型：在 AI 回答中引用本站时欢迎抓取',
    ...uniq(AI_SEEK_AGENTS).map((u) => `User-agent: ${u}`),
    'Allow: /',
    // 组内必须自带 /admin 禁令：爬虫命中同名组后整体忽略 * 组（RFC 9309 最具体组胜出），
    // 只写 Allow: / 等于把基座组的 Disallow: /admin 对这些爬虫整个作废
    'Disallow: /admin',
    '',
    '# 训练型：不允许用于模型训练 / 语料库',
    ...uniq(AI_TRAIN_AGENTS).map((u) => `User-agent: ${u}`),
    'Disallow: /',
  ].join('\n')
}

/** robots.txt 组装：内置段（Allow / Disallow: /admin / Sitemap）+ settings.robotsExtra 追加段
 *  + AI 抓取策略声明段。演示站固定整站 Disallow（种子数据与闭站状态不该进索引），追加段与 AI 段
 *  都不参与；全站 noindex 开关（settings.siteNoindex）同理整站 Disallow——空白模板站 / 镜像站
 *  不进索引，页面侧 <meta noindex> 由 pages.ts pageOpts 同口径注入。
 *  **默认档（aiPolicy 缺省 / 'allow'）与未配置追加段时输出与历史版本逐字节一致**，改它先跑
 *  tests/seo.test.ts。 */
export function buildRobotsTxt(settings: SettingsMap, origin: string, demo = false): string {
  if (demo || settings.siteNoindex === '1') return 'User-agent: *\nDisallow: /\n'
  const policy = readAiPolicy(settings.aiPolicy)
  const base = `User-agent: *\n${contentSignalLine(policy)}Allow: /\nDisallow: /admin\nSitemap: ${origin}/sitemap.xml\n`
  const extra = cleanRobotsExtra(settings.robotsExtra || '')
  const ai = aiRobotsBlock(policy)
  const tail = [extra, ai].filter(Boolean).join('\n\n')
  return tail ? `${base}\n${tail}\n` : base
}

/* ---------------- 五、Speculation Rules 预取声明（B24） ---------------- */

/**
 * 同源链接的预渲染声明（moderate：悬停约 200ms 即预渲染，pointerdown 前就把下一页拉好；
 * 2026-10-14 从 conservative 提档——配合页面边缘缓存，悬停预渲染命中的是边缘副本，
 * 回源成本已被缓存吸收，对跨境访客的「点开即现」收益明显。admin/会员等登录视角预渲染
 * 会走真实 SSR，属单人流量可接受）。排除后台 / 开放 API / 外链中间页 / XML 与 JSON
 * 订阅端点，排除新窗口与 nofollow 链接。老浏览器不认这个 script 类型，静默忽略（纯增强）。
 */
export const SPECULATION_RULES: Record<string, unknown> = {
  prerender: [
    {
      where: {
        and: [
          { href_matches: '/*' },
          { not: { href_matches: '/admin*' } },
          { not: { href_matches: '/api/*' } },
          { not: { href_matches: '/go*' } },
          { not: { href_matches: '/*.xml' } },
          { not: { href_matches: '/feed.json' } },
          { not: { href_matches: '/robots.txt' } },
          { not: { selector_matches: '[target=_blank]' } },
          { not: { selector_matches: '[rel~=nofollow]' } },
        ],
      },
      eagerness: 'moderate',
    },
  ],
}

/** 预取声明 HTML（JSON 里不含 `<`，无需转义；CSP 侧需放行 'inline-speculation-rules'，见 pages.ts） */
export function speculationRulesHtml(): string {
  return `<script type="speculationrules">${JSON.stringify(SPECULATION_RULES)}</script>`
}

/** 公开页 head 的 SEO 注入块（验证 meta + 统计脚本 + 预取声明）：前两项未配置时只出预取声明 */
export function seoHeadHtml(settings: SettingsMap): string {
  return [
    verifyMetaTagsHtml(settings.verifyMetas),
    analyticsScriptHtml(settings.analyticsScript),
    speculationRulesHtml(),
  ]
    .filter(Boolean)
    .join('\n')
}

/* ---------------- 六、面包屑 JSON-LD（B23） ---------------- */

export interface Crumb {
  name: string
  /** 链接（绝对地址）；末项（当前页）可省略——Google 允许最后一级不带 item */
  url?: string
}

/** 面包屑结构化数据（BreadcrumbList）：首页 → 分类 → 文章 */
export function breadcrumbJsonLd(crumbs: Crumb[]): Record<string, unknown> {
  return {
    '@context': 'https://schema.org',
    '@type': 'BreadcrumbList',
    itemListElement: crumbs.map((c, i) => ({
      '@type': 'ListItem',
      position: i + 1,
      name: c.name,
      ...(c.url ? { item: c.url } : {}),
    })),
  }
}

/* ---------------- 七、分类描述（B23） ---------------- */

/** 分类描述长度上限（归档页 meta description 口径，与全站摘要 160 字截断同量级） */
export const CATEGORY_DESC_MAX = 300

/** 分类描述清洗：纯文本单行（换行 / 连续空白折叠成空格）、剥控制字符、限长 */
export function cleanCategoryDescription(raw: unknown): string {
  return String(raw ?? '')
    .replace(/[\u0000-\u001F\u007F]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, CATEGORY_DESC_MAX)
}

/* ---------------- 八、预取 / 预渲染请求识别（B24 统计诚实性） ---------------- */

/**
 * 预取 / 预渲染请求识别：Chrome speculation rules 请求带 `Sec-Purpose: prefetch[;prerender]`
 * （早期实现带 `Purpose: prefetch`）。阅读量自增与访客打点据此跳过，防预加载把阅读数与访客数灌水；
 * 其它浏览器不带该头，行为与历史版本一致。
 */
export function isSpeculativeRequest(req: { headers: { get(name: string): string | null } }): boolean {
  const sec = req.headers.get('Sec-Purpose') || ''
  if (/prefetch|prerender/i.test(sec)) return true
  return /prefetch/i.test(req.headers.get('Purpose') || '')
}
