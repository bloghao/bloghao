/* ===== AI 索引导读（llms.txt / llms-full.txt，B28，2026-10-17）=====
 * llms.txt 是新兴的 AI 抓取导读约定（llmstxt.org，Cloudflare 阻止响应的内置放行路径）：
 * H1 站名 + blockquote 描述 + 分节链接清单；llms-full.txt 在同一结构下附全文。
 * 本模块是纯函数组（tests/llms.test.ts 直接导入，不依赖 Workers 运行时），路由在 index.ts。
 *
 * 防泄漏（与 RSS 同一份口径，AGENTS「回收站 / 软删除」「会员体系」防泄漏清单）：
 *  - 传入的文章清单已由调用方过滤（listPosts status=published + 站点可见窗口 + deleted_at IS NULL）；
 *  - 会员锁文（min_tier ≠ all）：索引照常出现（标题/摘要属作者主动公开的导读面，与 RSS 出条目同口径），
 *    llms-full 只出摘要 + 引导——服务端截断是付费墙的安全边界；
 *  - 访问密码文（password_hash 非空）：索引照常出作者摘要（与 RSS description 同口径），
 *    llms-full 只出摘要 + 加密说明；其 /post/:slug.md 直接 404（比 RSS 更严，与关键词搜索
 *    「整体退出」同口径——pages.ts renderPostMarkdown）；
 *  - 演示站 / 全站 noindex（settings.siteNoindex）/ AI 策略 deny 档（readAiPolicy）：index.ts 出桩
 *    （只有站名与说明，不列内容），与 robots.txt 整站 Disallow 同口径；deny 档时 .md 镜像同样
 *    404、文章页 head 不再声明 alternate——AI 面随策略整体关闭，别只关 llms 留 .md。
 */
import type { PostRow, SettingsMap } from './types'
import { isEn, tr } from './i18n'
import { fmtDate } from './utils'
import { htmlToMd } from './html-md'
import { sanitizeHtml } from './sanitize'

/** 独立页面（llms.txt「独立页面」节）：slug/title 由调用方从 listPages 已发布行映射 */
export interface LlmsPage {
  slug: string
  title: string
}

/** 标题/摘要单行化：llms.txt 的条目是行语义，内容里内嵌换行会断掉链接结构 */
function oneLine(s: string): string {
  return String(s ?? '').replace(/\s*\n+\s*/g, ' ').trim()
}

function postUrl(siteUrl: string, p: { slug: string }): string {
  return `${siteUrl}/post/${encodeURIComponent(p.slug)}`
}

/** 分节拼装：空节整节省略（无页面的站不出「独立页面」空标题） */
function sections(parts: [string, string][]): string {
  return parts
    .filter(([, body]) => body.trim())
    .map(([head, body]) => `\n${head}\n\n${body.trim()}\n`)
    .join('')
}

/** 共同的头（H1 + blockquote 描述）与机器可读清单尾节 */
function frame(settings: SettingsMap, siteUrl: string, middle: string): string {
  const en = isEn(settings)
  const head = `# ${oneLine(tr(en, settings.siteName))}\n\n> ${oneLine(tr(en, settings.siteDescription))}\n`
  const tools = sections([
    [
      en ? '## Subscriptions & machine-readable surfaces' : '## 订阅与机器可读面',
      [
        `- [RSS](${siteUrl}/rss.xml)`,
        `- [JSON Feed](${siteUrl}/feed.json)`,
        `- [Sitemap](${siteUrl}/sitemap.xml)`,
        `- [Posts API](${siteUrl}/api/public/posts)`,
        `- [llms-full](${siteUrl}/llms-full.txt)`,
      ].join('\n'),
    ],
  ])
  const mdNote = en
    ? 'Every post is also available as Markdown: append `.md` to its URL (e.g. `' + siteUrl + '/post/example.md`).'
    : '每篇文章另有 Markdown 镜像：在文章地址后加 `.md`（例如 `' + siteUrl + '/post/example.md`）。'
  return `${head}\n${middle}${tools}\n${mdNote}\n`
}

/** /llms.txt —— 导读索引：最新文章（标题 + 链接 + 一句话摘要）与独立页面 */
export function buildLlmsTxt(settings: SettingsMap, posts: PostRow[], pages: LlmsPage[], siteUrl: string): string {
  const en = isEn(settings)
  const postLines = posts.map((p) => {
    const s = oneLine(p.summary)
    return `- [${oneLine(p.title)}](${postUrl(siteUrl, p)})${s ? `: ${s}` : ''}`
  })
  const pageLines = pages.map((pg) => {
    const url = pg.slug === 'about' ? `${siteUrl}/about` : `${siteUrl}/page/${encodeURIComponent(pg.slug)}`
    return `- [${oneLine(pg.title)}](${url})`
  })
  const middle = sections([
    [en ? '## Latest posts' : '## 最新文章', postLines.join('\n')],
    [en ? '## Pages' : '## 独立页面', pageLines.join('\n')],
  ])
  return frame(settings, siteUrl, middle)
}

/** /llms-full.txt —— 同一结构附全文：普通文出正文（库存净化 HTML 经 sanitizeHtml → htmlToMd 转
 * Markdown，与导出 Markdown 包同款转换器——别按「库存即 Markdown」原样输出，标签会直接透出）；
 * 锁文/密码文只出摘要 + 引导（防泄漏） */
export function buildLlmsFullTxt(settings: SettingsMap, posts: PostRow[], siteUrl: string): string {
  const en = isEn(settings)
  const items = posts.map((p) => {
    const pwProtected = !!p.password_hash
    const memberLocked = !!p.min_tier && p.min_tier !== 'all'
    let body: string
    if (pwProtected) {
      body =
        (p.summary ? oneLine(p.summary) + '\n\n' : '') +
        (en ? '> This post is password-protected; its full text is not publicly available.' : '> 本文设有访问密码，正文不对外提供。')
    } else if (memberLocked) {
      body =
        (p.summary ? oneLine(p.summary) + '\n\n' : '') +
        (en
          ? `> The rest of this post is members-only. Read it on the site after member login: ${postUrl(siteUrl, p)}`
          : `> 本文为会员专属内容，此处仅为摘录，登录会员后可阅读全文：${postUrl(siteUrl, p)}`)
    } else {
      body = htmlToMd(sanitizeHtml(String(p.content ?? ''))).trim()
    }
    const date = p.published_at || p.updated_at
    return `## [${oneLine(p.title)}](${postUrl(siteUrl, p)})\n\n${date ? (en ? 'Published: ' : '发布：') + fmtDate(date) + '\n\n' : ''}${body}\n\n---`
  })
  const middle = sections([[en ? '## Posts (full text)' : '## 文章全文', items.join('\n\n')]])
  return frame(settings, siteUrl, middle)
}

/** 演示站 / 全站 noindex / AI 策略 deny 档的桩输出：与 robots.txt 整站 Disallow 同口径，不列任何内容。
 * aiDenied=true 时文案指向「不允许 AI 抓取」而非演示（对真实站点诚实） */
export function buildLlmsStub(settings: SettingsMap, siteUrl: string, aiDenied = false): string {
  const en = isEn(settings)
  const reason = aiDenied
    ? en
      ? 'This site does not permit AI crawlers (see robots.txt).'
      : '本站已声明不允许 AI 抓取（见 robots.txt），此处不提供内容。'
    : en
      ? 'This site is a demo / preview instance and does not expose content to AI crawlers.'
      : '本站为演示 / 预览实例，不向 AI 爬虫暴露内容。'
  return `# ${oneLine(tr(en, settings.siteName))}\n\n> ${reason}\n`
}
