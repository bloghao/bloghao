import type { PostRow, SettingsMap } from './types'
import { parseTags } from './db'
import { isEn, tr } from './i18n'
import { siteMode } from './render'
import { sanitizeHtml } from './sanitize'
import { esc, fmtDate, isoDate, teaserHtml } from './utils'
import { cdata, rfc822, xmlEsc } from './xml'

/** 会员锁文在 RSS / JSON Feed 里的尾注（防泄漏契约 A2：locked 只出试读段 + 引导） */
function memberOnlySuffix(en: boolean): string {
  return en
    ? '<p>— The rest of this post is members-only. Log in as a member on the site to keep reading.</p>'
    : '<p>—— 本文为会员专属内容，剩余部分请到站点登录会员后阅读。</p>'
}

export function buildRss(settings: SettingsMap, posts: PostRow[], siteUrl: string): string {
  const en = isEn(settings)
  const fullText = settings.rssFullText !== '0'
  const items = posts
    .map((p) => {
      // 全文走 content:encoded（标准做法：description 保持摘要轻量，订阅器优先读全文）。
      // 会员专属文章（min_tier 非 all）订阅器等同游客视角：只出试读段 + 引导，防付费墙被 RSS 绕过（契约 A2 防泄漏清单）
      // 访问密码文章（password_hash 非空）更严：试读段也不出，description 只用作者自填摘要（src/protect.ts 防泄漏清单）
      const pwProtected = !!p.password_hash
      const memberLocked = !!p.min_tier && p.min_tier !== 'all'
      // 机器可读锁标志（bloghao 命名空间）：广场 hub 的 RSS pull 补漏据此跳过锁文/密码文，
      // 与 push 路 firePostPublished 的 locked 口径同源——「加密文不上广场」两条路都守住
      const locked = pwProtected || memberLocked
      const encoded =
        fullText && p.content && !pwProtected
          ? `\n      <content:encoded>${cdata(
              memberLocked
                ? teaserHtml(sanitizeHtml(p.content)) + memberOnlySuffix(en)
                : sanitizeHtml(p.content)
            )}</content:encoded>`
          : ''
      return `    <item>
      <title>${xmlEsc(p.title)}</title>
      <link>${xmlEsc(siteUrl)}/post/${encodeURIComponent(p.slug)}</link>
      <guid isPermaLink="true">${xmlEsc(siteUrl)}/post/${encodeURIComponent(p.slug)}</guid>
      <pubDate>${rfc822(p.published_at)}</pubDate>
      <description>${xmlEsc(p.summary)}</description>${encoded}${pwProtected || memberLocked ? '\n      <bloghao:locked>1</bloghao:locked>' : ''}
    </item>`
    })
    .join('\n')
  return `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0" xmlns:atom="http://www.w3.org/2005/Atom" xmlns:content="http://purl.org/rss/1.0/modules/content/" xmlns:bloghao="https://bloghao.com/plaza-ns">
  <channel>
    <title>${xmlEsc(tr(en, settings.siteName))}</title>
    <link>${xmlEsc(siteUrl)}</link>
    <description>${xmlEsc(tr(en, settings.siteDescription))}</description>
    <language>${en ? 'en' : 'zh-CN'}</language>
    <atom:link href="${xmlEsc(siteUrl)}/rss.xml" rel="self" type="application/rss+xml"/>
${items}
  </channel>
</rss>`
}

/** JSON Feed 1.1（/feed.json，C12）：机器可读订阅格式，防泄漏口径与 buildRss 同一份——
 *  密码文不出正文（只留作者自填摘要）、会员锁文只出试读段 + 引导、rssFullText 关闭时只出摘要。
 *  日期走 isoDate（北京时间 +08:00 口径，与 JSON-LD 同源）；字段名是 JSON Feed 规范键，
 *  输出经 JSON.stringify 序列化，无需 xmlEsc */
export function buildJsonFeed(settings: SettingsMap, posts: PostRow[], siteUrl: string): string {
  const en = isEn(settings)
  const fullText = settings.rssFullText !== '0'
  const feed = {
    version: 'https://jsonfeed.org/version/1.1',
    title: tr(en, settings.siteName),
    home_page_url: siteUrl,
    feed_url: `${siteUrl}/feed.json`,
    description: tr(en, settings.siteDescription),
    language: en ? 'en' : 'zh-CN',
    authors: [{ name: tr(en, settings.siteName), url: siteUrl }],
    items: posts.map((p) => {
      const pwProtected = !!p.password_hash
      const memberLocked = !!p.min_tier && p.min_tier !== 'all'
      const contentHtml =
        fullText && p.content && !pwProtected
          ? memberLocked
            ? teaserHtml(sanitizeHtml(p.content)) + memberOnlySuffix(en)
            : sanitizeHtml(p.content)
          : ''
      // 封面属作者主动公开的导读面（与标题/摘要同口径），相对路径补成绝对地址
      const cover = p.cover ? (p.cover.startsWith('/') ? siteUrl + p.cover : p.cover) : ''
      return {
        id: `${siteUrl}/post/${encodeURIComponent(p.slug)}`,
        url: `${siteUrl}/post/${encodeURIComponent(p.slug)}`,
        title: p.title,
        summary: p.summary,
        ...(contentHtml ? { content_html: contentHtml } : {}),
        ...(cover ? { image: cover } : {}),
        date_published: isoDate(p.published_at),
        date_modified: isoDate(p.updated_at),
        tags: parseTags(p),
      }
    }),
  }
  return JSON.stringify(feed)
}

export function buildSitemap(
  settings: SettingsMap,
  posts: { slug: string; updated_at: number }[],
  siteUrl: string,
  categories: { slug: string; name: string }[] = [],
  tags: { name: string; count: number }[] = [],
  pages: { slug: string; updated_at: number }[] = []
): string {
  const urls = [
    { loc: `${siteUrl}/`, lastmod: fmtDate(Date.now()) },
    { loc: `${siteUrl}/about`, lastmod: '' },
    { loc: `${siteUrl}/archives`, lastmod: fmtDate(Date.now()) },
    { loc: `${siteUrl}/guestbook`, lastmod: '' },
    // 纯博客模式前台隐藏了微博模块（/weibo 302 回首页），sitemap 不再收录
    ...(siteMode(settings) === 'blog' ? [] : [{ loc: `${siteUrl}/weibo`, lastmod: '' }]),
    { loc: `${siteUrl}/links`, lastmod: '' },
    // 独立页面（/page/:slug）：slug 做百分号编码（中文 slug 是非 ASCII IRI）
    ...pages.map((p) => ({
      loc: `${siteUrl}/page/${encodeURIComponent(p.slug)}`,
      lastmod: fmtDate(p.updated_at),
    })),
    // 分类/标签列表页同样可收录；slug/标签名做百分号编码（中文标签是非 ASCII IRI）
    ...categories.map((cat) => ({
      loc: `${siteUrl}/category/${encodeURIComponent(cat.slug)}`,
      lastmod: '',
    })),
    ...tags.map((t) => ({
      loc: `${siteUrl}/tag/${encodeURIComponent(t.name)}`,
      lastmod: '',
    })),
    ...posts.map((p) => ({
      loc: `${siteUrl}/post/${encodeURIComponent(p.slug)}`,
      lastmod: fmtDate(p.updated_at),
    })),
  ]
  return `<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
${urls
  .map(
    (u) => `  <url>
    <loc>${xmlEsc(u.loc)}</loc>
    ${u.lastmod ? `<lastmod>${u.lastmod}</lastmod>` : ''}
  </url>`
  )
  .join('\n')}
</urlset>`
}
