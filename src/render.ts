import type { CommentRow, PostRow, SettingsMap } from './types'
import type { PostSort } from './db'
import { renderFooterHtml } from './hooks'
import { outHref } from './outlink'
import { cstDate, esc, excerpt, extractWeiboTopics, fmtDate, fmtDateCN, fmtDateTime, isoDate, NICKNAME_CHANGE_COOLDOWN_MS, nicknameCooldown } from './utils'
import { replaceEmoji } from './emoji'
import { enBetaBannerHtml, fmtDateEn, fmtDateEnShort, fmtDateTimeEn, isEn, plural, tr, weiboTimeEn } from './i18n'

// 英文测试版（English 0.1）的词典与日期随共享构建器一起再导出：主题与 pages.ts 只认 render 一个进口
export { enBetaBannerHtml, fmtDateEn, fmtDateEnShort, fmtDateTimeEn, isEn, plural, tr, weiboTimeEn } from './i18n'

export interface ThemePageOptions {
  settings: SettingsMap
  css: string
  title: string
  description?: string
  ogImage?: string
  path: string
  body: string
  preview?: boolean
  /** 请求源（new URL(c.req.url).origin）：canonical / og:url 绝对化的兜底，未配置 siteUrl 时也能产出绝对地址 */
  origin?: string
  /** 工具型页面（搜索、草稿预览）：要求搜索引擎不收录 */
  noindex?: boolean
  /** 演示体验版（DEMO_MODE）：所有公开页顶部公示站点性质横幅，见 demoBannerHtml() */
  demo?: boolean
  /** 结构化数据（JSON-LD）：对象序列化进 <script type="application/ld+json">，文章页传 articleJsonLd() 的产物 */
  jsonLd?: Record<string, unknown>
}

/** og:image 三级兜底：文章专属卡图（编辑器 OG 标记 > 封面）→ 后台设置的默认卡图 → 内置品牌卡图。
 *  og:image 绝不缺位：社交平台抓不到图时会退化为灰色占位小图标 */
export function resolveOgImage(ogImage: string | undefined, settings: SettingsMap): string {
  return ogImage || settings.ogImageDefault || '/og-default.png'
}

/* ---------------- 站点模式（后台「设置 → 站点模式」） ----------------
 * 不爱写长文的人可以只写微博：模式决定微博/博客两大模块在前台的显隐与首页优先级。
 * - blog-weibo（默认）：文章为主，微博随手记作为首页入口卡（现状）
 * - weibo-blog：微博为主，首页先出完整微博卡片流，文章列表跟在后面
 * - blog：纯博客——微博模块全隐藏（导航/首页入口/历史上的今天的微博），/weibo 302 回首页
 * - weibo：纯微博——打开首页就是微博时间线，博客专属模块（归档/分类话题/随机）从导航隐藏；
 *   文章数据不动，直链仍可访问
 */
export type SiteMode = 'blog-weibo' | 'weibo-blog' | 'blog' | 'weibo'

export const SITE_MODE_VALUES: SiteMode[] = ['blog-weibo', 'weibo-blog', 'blog', 'weibo']

/** 设置里的站点模式：脏值/缺省一律回退 blog-weibo（与 DEFAULT_SETTINGS 同口径） */
export function siteMode(settings: SettingsMap): SiteMode {
  return SITE_MODE_VALUES.includes(settings.siteMode as SiteMode) ? (settings.siteMode as SiteMode) : 'blog-weibo'
}

/** 页脚链接组按站点模式收口：纯博客模式剥掉指向 /weibo 的链接（导航已下线微博入口，页脚同步口径）。
 *  只作用于各主题 FOOT_LINKS 的自有静态串（href 恰为 "/weibo"），不是通用 HTML 过滤器 */
export function footLinks(settings: SettingsMap, links: string): string {
  return siteMode(settings) === 'blog' ? links.replace(/<a href="\/weibo">[^<]*<\/a>/g, '') : links
}

/** 站点绝对地址前缀：后台「站点链接」优先，未配置时回退请求 origin；去尾部斜杠 */
export function siteBase(settings: SettingsMap, origin?: string): string {
  return ((settings.siteUrl || origin || '') as string).replace(/\/+$/, '')
}

/** HTML 骨架：meta/OG/JSON-LD/内联主题 CSS/站点脚本，所有主题共用。
 *  英文测试版（settings.edition=en 且未回退）：lang=en、顶部测试版横幅、noindex（测试期不让搜索
 *  引擎把英文界面收进中文站的索引，回退中文版后自动恢复收录），data-edition 供 site.js 切前台文案 */
export function page(o: ThemePageOptions): string {
  const en = isEn(o.settings)
  const siteName = tr(en, o.settings.siteName) || 'BlogHao'
  const desc = tr(en, o.description || o.settings.siteDescription || '').slice(0, 160)
  const base = siteBase(o.settings, o.origin)
  const title = o.title ? `${o.title} - ${siteName}` : siteName
  const ogType = o.path.startsWith('/post/') ? 'article' : 'website'
  const ogImage = resolveOgImage(o.ogImage, o.settings)
  // JSON-LD 里的 < 必须转成 \u003c（仍是合法 JSON）：防正文标题带 </script> 提前闭合脚本标签
  const jsonLdHtml = o.jsonLd
    ? `<script type="application/ld+json">${JSON.stringify(o.jsonLd).replace(/</g, '\\u003c')}</script>`
    : ''
  return `<!DOCTYPE html>
<html lang="${en ? 'en' : 'zh-CN'}"${en ? ' data-edition="en"' : ''}>
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<title>${esc(title)}</title>
<meta name="description" content="${esc(desc)}">
${o.noindex || en ? '<meta name="robots" content="noindex">' : ''}
${o.settings.statsEnabled === '0' ? '<meta name="xw-stats" content="off">' : ''}
${base ? `<link rel="canonical" href="${esc(base + o.path)}">` : ''}
<meta property="og:title" content="${esc(o.title || siteName)}">
<meta property="og:description" content="${esc(desc)}">
<meta property="og:type" content="${ogType}">
<meta property="og:site_name" content="${esc(siteName)}">
${base ? `<meta property="og:url" content="${esc(base + o.path)}">` : ''}
<meta property="og:image" content="${esc(absUrl(base, ogImage))}">
<meta property="og:image:alt" content="${esc(o.title || siteName)}">
<meta name="twitter:card" content="summary_large_image">
${jsonLdHtml}
${o.settings.faviconUrl ? `<link rel="icon" href="${esc(absUrl(base, o.settings.faviconUrl))}">` : `<link rel="icon" href="/favicon.svg" type="image/svg+xml">`}
${base ? `<link rel="alternate" type="application/rss+xml" title="${esc(siteName)}" href="${esc(base)}/rss.xml">` : ''}
<style>${o.css}</style>
${grayscaleStyle(o.settings)}
</head>
<body${o.preview ? ' data-preview="1"' : ''}>
${en ? enBetaBannerHtml() : ''}
${o.demo ? demoBannerHtml() : ''}
${o.body}
<script src="/site.js" defer></script>
${renderFooterHtml(o.settings)}
</body>
</html>`
}

/** 演示体验版横幅（DEMO_MODE 专属，所有公开页顶部公示站点性质）：体验版、非最新正式版、
 *  仅供测试体验、数据定期清空重置。内联样式避免依赖六套主题各自补 CSS。 */
function demoBannerHtml(): string {
  return `<div style="background:#b45309;color:#fff;font-size:13px;line-height:1.6;text-align:center;padding:7px 14px;">🎓 演示体验版（非最新正式版）· 仅供测试体验 · 数据每 2 小时自动清空重置</div>`
}

function absUrl(siteUrl: string, path: string): string {
  if (/^https?:\/\//i.test(path)) return path
  return siteUrl ? siteUrl + path : path
}

/** 一键灰度（哀悼/纪念模式）：settings.siteGrayscale 开启时全站去色。
 *  放在 <html> 上才能覆盖背景色；注：filter 会让 fixed 后代改挂 html 定位基准——
 *  五套主题目前都没有 fixed 元素（sticky 不受影响），新主题引入固定定位时记得复查 */
function grayscaleStyle(settings: SettingsMap): string {
  return settings.siteGrayscale === '1' ? '<style>html{filter:grayscale(100%)}</style>' : ''
}

/** 闭站页（settings.siteClosed 开启时对匿名访客返回）：脱离主题的极简独立页。
 *  状态码必须 503 + Retry-After——搜索引擎据此暂时保留收录，而不是把站点当 404 摘掉 */
export function renderClosedPage(settings: SettingsMap): string {
  const en = isEn(settings)
  const siteName = tr(en, settings.siteName) || 'BlogHao'
  const message = tr(en, settings.siteClosedMessage || '本站暂时关闭，请稍后再来。')
  return `<!DOCTYPE html>
<html lang="${en ? 'en' : 'zh-CN'}">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<meta name="robots" content="noindex">
<title>${en ? `Temporarily closed - ${esc(siteName)}` : `站点暂时关闭 - ${esc(siteName)}`}</title>
<style>
*{margin:0;padding:0;box-sizing:border-box}
:root{color-scheme:light dark}
body{min-height:100vh;display:flex;align-items:center;justify-content:center;padding:24px;
  font-family:-apple-system,BlinkMacSystemFont,'PingFang SC','Segoe UI','Microsoft YaHei',sans-serif;
  background:#f4f4f5;color:#52525b}
.card{max-width:460px;text-align:center}
.badge{width:44px;height:44px;margin:0 auto;border:1.5px solid #a1a1aa;border-radius:50%;
  display:flex;align-items:center;justify-content:center;color:#a1a1aa}
h1{font-size:20px;font-weight:600;margin:20px 0 12px;color:inherit}
.msg{font-size:15px;line-height:1.8;white-space:pre-wrap;word-break:break-word}
.site{margin-top:32px;font-size:13px;color:#a1a1aa}
@media (prefers-color-scheme:dark){body{background:#18181b}.badge{border-color:#3f3f46;color:#3f3f46}.site{color:#52525b}}
</style>
</head>
<body>
<div class="card">
<div class="badge" aria-hidden="true"><svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><line x1="5" y1="9" x2="19" y2="9"/><line x1="5" y1="15" x2="19" y2="15"/></svg></div>
<h1>${en ? 'Temporarily closed' : '站点暂时关闭'}</h1>
<p class="msg">${esc(message)}</p>
<div class="site">${esc(siteName)}</div>
</div>
</body>
</html>`
}

export interface ArticleJsonLdOptions {
  settings: SettingsMap
  /** 文章标题（headline，不带站名后缀） */
  title: string
  description: string
  /** 文章专属卡图或封面（可相对路径）：内部走 resolveOgImage 兜底，与 og:image 恒一致 */
  image?: string
  /** 文章 canonical 地址：与 page() 的 canonical 同源拼接（base + /post/:slug） */
  url: string
  base: string
  /** 发布时间（毫秒），缺失回退 updatedAt */
  publishedAt?: number | null
  /** 最后更新时间（毫秒） */
  updatedAt: number
  tags?: string[]
  commentCount?: number
}

/**
 * 文章页 JSON-LD 结构化数据（schema.org BlogPosting，SEO 基本盘，roadmap A3）。
 * 时间统一北京时间 +08:00（isoDate，与全站时间口径一致）；dateModified 取发布/更新中较晚者——
 * 定时发布场景 updated_at 会早于 published_at，直接用会造成「修改时间早于发布时间」的矛盾数据。
 */
export function articleJsonLd(o: ArticleJsonLdOptions): Record<string, unknown> {
  const en = isEn(o.settings)
  const siteName = tr(en, o.settings.siteName) || 'BlogHao'
  const publishedTs = o.publishedAt || o.updatedAt
  const data: Record<string, unknown> = {
    '@context': 'https://schema.org',
    '@type': 'BlogPosting',
    mainEntityOfPage: { '@type': 'WebPage', '@id': o.url },
    // Google 建议 headline 控制在 110 字符内，超长截断
    headline: o.title.slice(0, 110),
    description: o.description,
    image: absUrl(o.base, resolveOgImage(o.image, o.settings)),
    datePublished: isoDate(publishedTs),
    dateModified: isoDate(Math.max(publishedTs, o.updatedAt)),
    author: { '@type': 'Person', name: siteName },
    publisher: {
      '@type': 'Organization',
      name: siteName,
      logo: { '@type': 'ImageObject', url: absUrl(o.base, o.settings.faviconUrl || '/favicon.svg') },
    },
    inLanguage: en ? 'en' : 'zh-CN',
  }
  if (o.tags?.length) data.keywords = o.tags.join(', ')
  if (o.commentCount != null) data.commentCount = o.commentCount
  return data
}

export interface HomePostView {
  slug: string
  title: string
  summary: string
  cover: string
  tags: string[]
  published_at: number | null
  views: number
  likes: number
  pinned: boolean
  commentCount?: number
  readingMinutes?: number
}

/** 前台导航/文章页用的分类轻量视图 */
export interface CategoryLink {
  name: string
  slug: string
}

export function categoryLink(c: CategoryLink): string {
  return `/category/${encodeURIComponent(c.slug)}`
}

/** 顶部导航「分类话题」菜单用的标签视图（带使用计数） */
export interface TagCount {
  name: string
  count: number
}

/** 顶部导航里的自建页面项（独立页面系统，key 用于高亮匹配：'p:<slug>'） */
export interface NavPage {
  title: string
  href: string
  key: string
}

/**
 * 全站顶部导航：首页 + 微博 + 归档 + 留言板 + 分类话题（details 折叠菜单）+ 友情链接 + 自建页面 + 关于我 + 随机。
 * cls 传主题前缀（如 wx-snav），结构统一、样式交由主题 CSS 塑形。
 * mode 传站点模式（siteMode(settings)）：纯博客隐藏「微博」，纯微博把「微博」提为首位并隐藏
 * 归档/分类话题/随机等博客专属模块（未传按博客+微博处理，兼容第三方主题）。
 * 分类与标签收进同一折叠菜单（标签可能很多，菜单内部滚动），
 * active 传 'home' / 'weibo' / 'archives' / 'guestbook' / 'links' / 'member' / 'rank' / 'about' / 分类 slug / 'tag:标签名' / 'p:页面slug'。
 * memberEnabled 传 settings.membersEnabled === '1'：true 时在「关于我」前渲染会员中心与排行榜入口。
 * en 传 isEn(settings)：英文测试版输出英文导航词（Home / Notes / Archives…）。
 */
export function siteNav(o: {
  cls: string
  mode?: SiteMode
  categories: CategoryLink[]
  tags?: TagCount[]
  pages?: NavPage[]
  active?: string
  memberEnabled?: boolean
  /** compact 布局（主题逐个试点）：主条只留内容区入口 + 会员药丸压轴，留言板/友情链接/排行榜/随机降级到主题页脚 */
  compact?: boolean
  /** 英文测试版：导航词走词典（tr），中文路径不传即原样 */
  en?: boolean
}): string {
  const en = !!o.en
  const m = o.mode || 'blog-weibo'
  // href 一并转义：当前调用方全是内部构造的路径/经 cleanSlug 的 slug，转义是给未来调用方的护栏
  const item = (href: string, label: string, active = false) =>
    `<a class="${o.cls}-link${active ? ' is-active' : ''}" href="${esc(href)}">${esc(label)}</a>`
  const chip = (href: string, label: string, count: number | undefined, active = false) =>
    `<a class="${o.cls}-chip${active ? ' is-active' : ''}" href="${esc(href)}">${esc(label)}${
      count != null ? `<i>${count}</i>` : ''
    }</a>`
  const cats = o.categories.map((c) => chip(categoryLink(c), c.name, undefined, o.active === c.slug))
  const tags = (o.tags || []).map((t) => chip(tagLink(t.name), t.name, t.count, o.active === `tag:${t.name}`))
  const menu =
    cats.length || tags.length
      ? `<div class="${o.cls}-menu">
  ${cats.length ? `<div class="${o.cls}-group"><span class="${o.cls}-label">${tr(en, '分类')}</span><div class="${o.cls}-chips">${cats.join('')}</div></div>` : ''}
  ${tags.length ? `<div class="${o.cls}-group"><span class="${o.cls}-label">${tr(en, '话题')}</span><div class="${o.cls}-chips">${tags.join('')}</div></div>` : ''}
</div>`
      : ''
  const drop = menu
    ? `<details class="${o.cls}-dd snav-dd">
  <summary class="${o.cls}-link">${tr(en, '分类话题')}<svg class="${o.cls}-caret" viewBox="0 0 12 12" aria-hidden="true"><path d="M2.5 4.5 6 8l3.5-3.5" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"/></svg></summary>
  ${menu}
</details>`
      : ''
  // 纯微博：'/' 即微博时间线，导航首位「微博」直达 /weibo（首页 item 退出）；纯博客：去掉「微博」
  const weiboItem = m === 'blog' ? '' : item('/weibo', tr(en, '微博'), o.active === 'weibo' || (m === 'weibo' && o.active === 'home'))
  const homeItem = m === 'weibo' ? '' : item('/', tr(en, '首页'), o.active === 'home')
  if (o.compact) {
    // 会员走 accent 药丸（主题 CSS 塑形），与普通链接拉开视觉层级；is-active 口径与普通链接一致
    const memberPill = o.memberEnabled
      ? `<a class="${o.cls}-member${o.active === 'member' ? ' is-active' : ''}" href="/member">${tr(en, '会员')}</a>`
      : ''
    return `<nav class="${o.cls}" aria-label="${tr(en, '站点导航')}">
  ${homeItem || weiboItem}
  ${m === 'weibo' ? '' : weiboItem}
  ${m === 'weibo' ? '' : item('/archives', tr(en, '归档'), o.active === 'archives')}
  ${m === 'weibo' ? '' : drop}
  ${(o.pages || []).map((p) => item(p.href, p.title, o.active === p.key)).join('')}
  ${item('/about', tr(en, '关于我'), o.active === 'about')}
  ${memberPill}
</nav>`
  }
  return `<nav class="${o.cls}" aria-label="${tr(en, '站点导航')}">
  ${homeItem || weiboItem}
  ${m === 'weibo' ? '' : weiboItem}
  ${m === 'weibo' ? '' : item('/archives', tr(en, '归档'), o.active === 'archives')}
  ${item('/guestbook', tr(en, '留言板'), o.active === 'guestbook')}
  ${m === 'weibo' ? '' : drop}
  ${item('/links', tr(en, '友情链接'), o.active === 'links')}
  ${(o.pages || []).map((p) => item(p.href, p.title, o.active === p.key)).join('')}
  ${o.memberEnabled ? item('/member', tr(en, '会员'), o.active === 'member') : ''}
  ${o.memberEnabled ? item('/rank', tr(en, '排行榜'), o.active === 'rank') : ''}
  ${item('/about', tr(en, '关于我'), o.active === 'about')}
  ${m === 'weibo' ? '' : item('/random', tr(en, '随机'))}
</nav>`
}

/* ---------------- 文章归档（共享构建器） ----------------
 * 年份小节 + 日期外置的细线列表，结构全主题共用（语义化 .ar-* class），视觉由主题 CSS 塑形。
 */
export interface ArchiveItemView {
  slug: string
  title: string
  /** 发文时间（published_at 缺失回退 created_at），用于分组与展示 */
  ts: number
}

export interface ArchiveYearGroup {
  year: number
  count: number
  items: ArchiveItemView[]
}

/** 按年分组：年份倒序，组内按时间倒序 */
export function archiveGroups(posts: ArchiveItemView[]): ArchiveYearGroup[] {
  const map = new Map<number, ArchiveItemView[]>()
  for (const p of posts) {
    // 与 fmtDate 同口径：按北京时间的年份分组，避免 0-8 点发布的文章归错年
    const year = cstDate(p.ts).getUTCFullYear()
    const list = map.get(year) || []
    list.push(p)
    map.set(year, list)
  }
  return [...map.entries()]
    .sort((a, b) => b[0] - a[0])
    .map(([year, items]) => ({
      year,
      count: items.length,
      items: items.sort((a, b) => b.ts - a.ts),
    }))
}

/** 归档列表 HTML：每篇一行的 <time> + 标题链接（纯静态超链接，利于搜索引擎收录）；en 时日期换英文短格式 */
export function archiveListHtml(groups: ArchiveYearGroup[], en = false): string {
  return groups
    .map(
      (g) => `<section class="ar-group">
  <h2 class="ar-year">${g.year}<i>${en ? `${g.count} ${plural(g.count, 'post', 'posts')}` : `${g.count} 篇`}</i></h2>
  <ul class="ar-list">${g.items
    .map(
      (p) => `<li class="ar-item">
  <a class="ar-link" href="/post/${esc(p.slug)}">
    <time class="ar-date" datetime="${fmtDate(p.ts)}">${en ? fmtDateEnShort(p.ts) : fmtDate(p.ts).replace(/-/g, '.')}</time>
    <span class="ar-title">${esc(p.title)}</span>
  </a>
</li>`
    )
    .join('\n')}</ul>
</section>`
    )
    .join('\n')
}

/* ---------------- 友情链接（共享构建器） ----------------
 * 卡片 / 申请收录表单结构全主题共用（语义化 .fl-* class），视觉由主题 CSS 塑形。
 */
export interface FriendLinkView {
  name: string
  url: string
  description: string
  /** 图标地址（站内 /images/ 或外链），空则退回站名首字图标 */
  icon: string
}

/** 机器可读时间戳：<time datetime> 用。无效时间戳（备份恢复/导入的脏数据）兜成空串，
 *  直接 toISOString() 会抛 RangeError 让整页 500 */
function safeIso(ts: number): string {
  const d = new Date(ts)
  return Number.isFinite(d.getTime()) ? d.toISOString() : ''
}

/** 友链卡片：有图标用图标，没有用站名首字。url/icon 渲染前过 scheme 白名单——
 *  写侧已拦 javascript: 等协议，这里兜底防备份恢复/导入路径的脏数据流进 href/src */
export function friendLinkCards(items: FriendLinkView[], en = false): string {
  const safeUrl = (u: string): string => (/^(https?:\/\/|\/)/i.test(u) ? u : '')
  return items
    .map((l) => {
      const url = safeUrl(l.url)
      const icon = safeUrl(l.icon)
      const ico = icon
        ? `<span class="fl-ico"><img src="${esc(icon)}" loading="lazy" alt=""></span>`
        : `<span class="fl-ico fl-ico-letter" aria-hidden="true">${esc((l.name || (en ? 'W' : '链')).trim().charAt(0))}</span>`
      const main = `<span class="fl-main">
    <span class="fl-name">${esc(l.name)}</span>
    ${l.description ? `<span class="fl-desc">${esc(l.description)}</span>` : ''}
  </span>`
      // url 非法时退化为无链接卡片（内容照常展示，不输出可疑 href）
      return url
        ? `<a class="fl-card" href="${esc(url)}" target="_blank" rel="noopener">
  ${ico}
  ${main}
</a>`
        : `<span class="fl-card">
  ${ico}
  ${main}
</span>`
    })
    .join('\n')
}

/** 申请收录表单：提交交给 site.js（POST /api/public/links/apply，进待审核）；en 输出英文表单 */
export function friendLinkApply(en = false): string {
  return `<section class="fl-apply" id="fl-apply">
  <h2 class="fl-apply-title">${tr(en, '申请收录')}</h2>
  <p class="fl-apply-sub">${tr(en, '想和本站交个朋友？留下你的站点，审核通过后就会出现在上面。')}</p>
  <form class="fl-form">
    <div class="fl-form-row">
      <input class="fl-input" name="name" maxlength="40" placeholder="${tr(en, '站点名称')}" required aria-label="${tr(en, '站点名称')}">
      <input class="fl-input" name="url" type="url" inputmode="url" maxlength="500" placeholder="${tr(en, 'https:// 你的网址')}" required aria-label="${en ? 'Site URL' : '站点网址'}">
    </div>
    <textarea class="fl-textarea" name="description" maxlength="120" rows="2" placeholder="${tr(en, '一两句介绍你的网站（可选）')}" aria-label="${tr(en, '站点介绍')}"></textarea>
    <input class="cmt-hp" name="link" tabindex="-1" autocomplete="off" aria-hidden="true">
    <div class="fl-form-foot">
      <span class="fl-tip">${tr(en, '提交后由站长审核')}</span>
      <button class="fl-submit" type="submit">${tr(en, '提交申请')}</button>
    </div>
  </form>
</section>`
}

/**
 * 文章页去重：封面图常取自正文首图，渲染正文时把与封面相同的第一张图删掉
 * （连同因此变空的 <p>），列表页缩略图不受影响。
 */
export function stripCoverDuplicate(contentHtml: string, cover: string): string {
  if (!cover) return contentHtml
  const img = contentHtml.match(/<img\b[^>]*>/i)
  if (!img) return contentHtml
  const src = img[0].match(/\bsrc\s*=\s*"([^"]*)"/i)
  if (!src) return contentHtml
  const norm = (u: string) => u.replace(/&amp;/g, '&').trim()
  if (norm(src[1]) !== norm(cover)) return contentHtml
  const imgRe = img[0].replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  const withoutP = contentHtml.replace(new RegExp(`<p>\\s*${imgRe}\\s*</p>`), '')
  return withoutP !== contentHtml ? withoutP : contentHtml.replace(img[0], '')
}

export function toHomePost(row: PostRow, tags: string[], commentCount?: number, readingMinutes?: number): HomePostView {
  return {
    slug: row.slug,
    title: row.title,
    summary: row.summary,
    cover: row.cover,
    tags,
    published_at: row.published_at,
    views: row.views,
    likes: row.likes,
    pinned: !!row.pinned,
    commentCount,
    readingMinutes,
  }
}

/* ---------------- 微博（随手记）共享构建器 ----------------
 * HTML 结构各主题共用（语义化 .wb-* class），视觉由主题 CSS 塑形。
 */
export interface WeiboItemView {
  id: number
  content: string
  images: string[]
  created_at: number
  likes: number
  commentCount: number
  pinned?: boolean
}

/** 微博时间：今年「10月3日 14:20」，往年带年份（北京时间口径，与 utils 时间函数一致）；en 换 Oct 3, 14:20 */
export function weiboTime(ts: number, en = false): string {
  if (en) return weiboTimeEn(ts)
  const d = cstDate(ts)
  const now = cstDate(Date.now())
  const p = (x: number) => String(x).padStart(2, '0')
  const hm = `${p(d.getUTCHours())}:${p(d.getUTCMinutes())}`
  return d.getUTCFullYear() === now.getUTCFullYear()
    ? `${d.getUTCMonth() + 1}月${d.getUTCDate()}日 ${hm}`
    : `${d.getUTCFullYear()}年${d.getUTCMonth() + 1}月${d.getUTCDate()}日`
}

/** 微博图片网格：1 张大图，2/4 张两列，其余三列（微博式） */
export function weiboImageGrid(images: string[]): string {
  const n = images.length
  if (!n) return ''
  const cls = n === 1 ? 'wb-imgs-1' : n === 2 || n === 4 ? 'wb-imgs-2' : 'wb-imgs-3'
  const imgs = images.map((u) => `<img src="${esc(u)}" loading="lazy" alt="">`).join('')
  return `<div class="wb-imgs ${cls}">${imgs}</div>`
}

/** 微博正文链接尾部标点（句读/引号/右括号）留在链接外，括号配对时保留（维基百科类 URL）。
 *  site.js 的 wbTextHtml 有一份同逻辑镜像，改动两边同步 */
export function trimUrlTail(u: string): string {
  let s = u
  while (s.length > 1) {
    const last = s[s.length - 1]
    if (last === ')') {
      const opens = (s.match(/\(/g) || []).length
      if ((s.match(/\)/g) || []).length > opens) {
        s = s.slice(0, -1)
        continue
      }
      break
    }
    if (".,;:!?>'、。，；：！？）】」』》›»…·".includes(last)) {
      s = s.slice(0, -1)
      continue
    }
    break
  }
  return s
}

/** 微博正文分词：URL 与 #话题# 共用一个正则一次扫描（先转链接再扫话题会把 href 里的
 *  #fragment 误判成话题、把生成的锚点拆坏）。URL 不吞 CJK 字符与全角标点——
 *  「https://x.com的官网」这类中文紧贴的写法，链接应停在汉字前 */
const WEIBO_TEXT_RE =
  /(https?:\/\/[^\s<>"'\u3000-\u303f\uff00-\uffef\u4e00-\u9fff]+)|((?<![\p{L}\p{N}#])#[^\s#&<>"']{1,24}(?:#|(?=\s)|$))/gu

/** 微博正文：URL 转可点击超链（白名单外域过 /go 中间页，src/outlink.ts），
 *  #话题# 渲染成指向 /weibo?topic= 的链接；其余文本转义 */
export function weiboTextHtml(content: string): string {
  let out = ''
  let last = 0
  for (const m of content.matchAll(WEIBO_TEXT_RE)) {
    // 微信表情文本码替换包在每段转义后的纯文本上（属性 href 不包，URL 分段无中文码不会命中）
    out += replaceEmoji(esc(content.slice(last, m.index)))
    last = m.index + m[0].length
    if (m[1]) {
      // URL：尾部标点留在链接外；锚文本与 href 都来自原文分段，经 esc 落进属性/文本上下文
      const url = trimUrlTail(m[1])
      out += `<a class="wb-link" href="${esc(outHref(url))}" target="_blank" rel="noopener noreferrer">${esc(url)}</a>${replaceEmoji(esc(m[0].slice(url.length)))}`
      continue
    }
    const name = extractWeiboTopics(m[0])[0]
    if (!name) out += replaceEmoji(esc(m[0]))
    else out += `<a class="wb-topic" href="/weibo?topic=${encodeURIComponent(name)}">${esc(m[0])}</a>`
  }
  return out + replaceEmoji(esc(content.slice(last)))
}

/** 微博话题条：默认不显示（避免标签堆满页头）；仅从正文 #话题# 链接进入筛选时，显示「全部 + 当前话题」方便退出筛选 */
export function weiboTopicBar(topics: { name: string; count: number }[], active?: string, en = false): string {
  if (!active) return ''
  const hit = topics.find((t) => t.name === active)
  const chip = (name: string, label: string, count?: number) =>
    `<a class="wb-topic-chip${name === (active || '') ? ' is-active' : ''}" href="/weibo${
      name ? `?topic=${encodeURIComponent(name)}` : ''
    }">${esc(label)}${count != null ? `<i>${count}</i>` : ''}</a>`
  return `<nav class="wb-topics" aria-label="${tr(en, '微博话题')}">${chip('', tr(en, '全部'))}${chip(active, '#' + active, hit?.count)}</nav>`
}

/** 卡片底栏右侧管理操作（仅管理员登录时渲染，访客 HTML 里不存在；交互在 site.js） */
function weiboAdminBar(w: WeiboItemView, en: boolean): string {
  return `<div class="wb-admin" data-wb-admin="${w.id}">
  <button class="wb-admin-btn" type="button" data-wb-act="edit">${tr(en, '编辑')}</button>
  <button class="wb-admin-btn" type="button" data-wb-act="pin">${w.pinned ? tr(en, '取消置顶') : tr(en, '置顶')}</button>
  <button class="wb-admin-btn is-danger" type="button" data-wb-act="del">${tr(en, '删除')}</button>
</div>`
}

/** 心形（点赞）图标：微博底栏 16 与文章页 18 两种规格共用同一 path */
function heartSvg(size: number): string {
  return `<svg viewBox="0 0 24 24" width="${size}" height="${size}" aria-hidden="true"><path d="M12 21s-7.5-4.9-10-9.3C.5 8.4 2.3 4.9 5.7 4.5c2-.2 3.9.8 5 2.5a5.7 5.7 0 0 1 5-2.5c3.4.4 5.2 3.9 3.7 7.2C19.5 16.1 12 21 12 21z" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linejoin="round"/></svg>`
}

/** 微博卡片底栏：点赞（同文章 like-btn，data-type=weibo）+ 评论数（点开卡片内折叠评论区）+ 分享卡片 */
export function weiboCardFoot(w: WeiboItemView, isAdmin?: boolean, en = false): string {
  const like = `<button class="wb-action like-btn" type="button" data-type="weibo" data-id="${w.id}" data-likes="${w.likes}" aria-label="${tr(en, '点赞')}">
  ${heartSvg(16)}
  <b class="like-count" data-count>${w.likes}</b>
</button>`
  const cmt = `<button class="wb-action wb-cmt-toggle" type="button" data-wb="${w.id}" aria-label="${tr(en, '留言')}" aria-expanded="false">
  <svg viewBox="0 0 24 24" width="16" height="16" aria-hidden="true"><path d="M21 11.5c0 4.1-4 7.5-9 7.5-1 0-2-.1-2.9-.4L4 20l1.2-3.2C3.8 15.4 3 13.5 3 11.5 3 7.4 7 4 12 4s9 3.4 9 7.5z" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linejoin="round"/></svg>
  <b class="wb-cmt-count" data-count>${w.commentCount}</b>
</button>`
  // 生成分享卡片（存图/转发）：纯前端，交互在 site.js（按需加载 /share-card.js）；管理三键仍 margin-left:auto 靠右
  const share = `<button class="wb-action wb-share" type="button" data-wb-share="${w.id}" aria-label="${en ? 'Share this note' : '生成分享卡片'}">
  <svg viewBox="0 0 24 24" width="16" height="16" aria-hidden="true"><path d="M12 14V3.5m0 0L8.5 7m3.5-3.5L15.5 7" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/><path d="M7.5 10.5H7a3 3 0 0 0-3 3V18a3 3 0 0 0 3 3h10a3 3 0 0 0 3-3v-4.5a3 3 0 0 0-3-3h-.5" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/></svg>
  <b>${tr(en, '分享')}</b>
</button>`
  return `<footer class="wb-foot">${like}${cmt}${share}${isAdmin ? weiboAdminBar(w, en) : ''}</footer>`
}

/** 管理员登录时的发言身份行（文章/微博评论表单共用，免填昵称） */
function adminIdentity(name: string, en: boolean): string {
  return `<p class="cmt-as">${en ? 'Commenting as' : '以作者'} <b>${esc(name)}</b>${en ? '' : ' 的身份发言'}</p><input class="cmt-hp" name="link" tabindex="-1" autocomplete="off" aria-hidden="true">`
}

/** 会员登录时的发言身份行：结构与 adminIdentity 同构（蜜罐字段随行带上），徽标文案区分身份 */
function memberIdentity(name: string, en: boolean): string {
  return `<p class="cmt-as">${en ? 'Commenting as member' : '以会员'} <b>${esc(name)}</b>${en ? '' : ' 的身份发言'}</p><input class="cmt-hp" name="link" tabindex="-1" autocomplete="off" aria-hidden="true">`
}

/** 卡片内折叠评论区骨架：列表与表单内容由 site.js 按需填充；adminName / memberName 传入时表单免填昵称（管理员优先） */
export function weiboCommentPanel(w: WeiboItemView, allowComments: boolean, adminName?: string, memberName?: string, en = false): string {
  return `<div class="wb-cmt" data-wb-cmt="${w.id}" hidden>
  <div class="wb-cmt-list" data-role="list"><p class="wb-cmt-loading">${tr(en, '加载中…')}</p></div>
  ${
    allowComments
      ? `<form class="wb-cmt-form${adminName ? ' is-admin' : ''}" data-role="form">
  ${
    adminName
      ? adminIdentity(adminName, en)
      : memberName
        ? memberIdentity(memberName, en)
        : `<div class="wb-cmt-row">
    <input class="wb-cmt-input" name="nickname" maxlength="24" placeholder="${tr(en, '昵称')}" required>
    <input class="cmt-hp" name="link" tabindex="-1" autocomplete="off" aria-hidden="true">
  </div>
  <div class="wb-cmt-row">
    <input class="wb-cmt-input" name="qq" inputmode="numeric" maxlength="11" placeholder="${tr(en, 'QQ 号（选填，展示头像）')}" autocomplete="off" title="${tr(en, '仅用于抓取头像，不会公开展示')}">
  </div>`
  }
  <textarea class="wb-cmt-textarea" name="content" maxlength="1000" rows="2" placeholder="${tr(en, '说点什么…')}" required></textarea>
  <div class="wb-cmt-foot"><span class="wb-cmt-tip"></span><button class="wb-cmt-submit" type="submit">${tr(en, '发送')}</button></div>
</form>`
      : ''
  }
</div>`
}

export function weiboCards(o: {
  settings: SettingsMap
  items: WeiboItemView[]
  avatarHtml: string
  allowComments?: boolean
  /** 登录管理员昵称：评论表单免填昵称，以作者身份发言；传入即在卡片上渲染管理操作（编辑/置顶/删除） */
  adminName?: string
  /** 登录会员昵称（管理员未登录时生效）：评论表单免填昵称，以会员身份发言 */
  memberName?: string
}): string {
  const en = isEn(o.settings)
  const name = tr(en, o.settings.siteName) || tr(en, '微博')
  const allowComments = o.allowComments !== false
  const isAdmin = !!o.adminName
  return o.items
    .map((w) => {
      const foot = weiboCardFoot(w, isAdmin, en)
      const panel = weiboCommentPanel(w, allowComments, o.adminName, o.memberName, en)
      return `<article class="wb-card${w.pinned ? ' is-pinned' : ''}" id="wb-${w.id}">
  <header class="wb-head">
    <span class="wb-avatar">${o.avatarHtml}</span>
    <div class="wb-who">
      <span class="wb-name">${esc(name)}</span>
      <time class="wb-time" datetime="${safeIso(w.created_at)}">${weiboTime(w.created_at, en)}</time>
    </div>
    ${w.pinned ? `<span class="wb-pin">${tr(en, '置顶')}</span>` : ''}
  </header>
  ${w.content ? `<div class="wb-text">${weiboTextHtml(w.content)}</div>` : ''}
  ${weiboImageGrid(w.images)}
  ${foot}
  ${panel}
</article>`
    })
    .join('\n')
}

/** 微博模块头部（入口卡与首页微博流共用）：整条指向 /weibo；countLabel 换计数文案（搜索结果区用「命中 N 条」） */
function weiboHomeHead(total: number, en: boolean, countLabel?: string): string {
  return `<a class="wb-home-head" href="/weibo">
    <svg class="wb-home-ico" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12 20h9"/><path d="M16.5 3.5a2.12 2.12 0 0 1 3 3L7 19l-4 1 1-4Z"/></svg>
    <span class="wb-home-title">${tr(en, '微博 · 随手记')}</span>
    <span class="wb-home-count">${countLabel || (en ? `${total} ${plural(total, 'note', 'notes')} in total` : `共 ${total} 条`)}</span>
    <span class="wb-home-more">${tr(en, '全部 →')}</span>
  </a>`
}

/** 首页微博入口卡：最新几条随手记摘要 + 总条数，整卡指向 /weibo（无已发布微博时不渲染） */
export function weiboHomeEntry(o: { items: WeiboItemView[]; total: number; en?: boolean }): string {
  if (!o.items.length) return ''
  const en = !!o.en
  const items = o.items
    .map((w) => {
      // 摘要统一走 excerpt（含空白折叠），与历史上的今天等处同口径
      const text = w.content || ''
      const short = text ? excerpt(text, 64) : en ? `Posted ${w.images.length} ${plural(w.images.length, 'photo', 'photos')}` : `发了 ${w.images.length} 张图`
      const thumb = w.images[0]
        ? `<span class="wb-home-thumb"><img src="${esc(w.images[0])}" loading="lazy" alt=""></span>`
        : ''
      return `<a class="wb-home-item" href="/weibo?wb=${w.id}#wb-${w.id}">
  <div class="wb-home-main">
    <p class="wb-home-text">${esc(short)}</p>
    <time class="wb-home-time" datetime="${safeIso(w.created_at)}">${weiboTime(w.created_at, en)}</time>
  </div>
  ${thumb}
</a>`
    })
    .join('\n')
  return `<section class="wb-home" aria-label="${en ? 'Notes' : '微博随手记'}">
  ${weiboHomeHead(o.total, en)}
  ${items}
</section>`
}

/**
 * 首页微博流（微博+博客模式）：完整微博卡片先行（点赞/评论/管理键全可用，交互在 site.js），
 * 更早的顺着头部「全部 →」进 /weibo。卡片容器复用 /weibo 页的 .wb-list 间距。
 */
export function weiboHomeFeed(o: {
  settings: SettingsMap
  items: WeiboItemView[]
  total: number
  avatarHtml: string
  allowComments?: boolean
  adminName?: string
  memberName?: string
}): string {
  if (!o.items.length) return ''
  const en = isEn(o.settings)
  const cards = weiboCards({
    settings: o.settings,
    items: o.items,
    avatarHtml: o.avatarHtml,
    allowComments: o.allowComments,
    adminName: o.adminName,
    memberName: o.memberName,
  })
  return `<section class="wb-home-feed" aria-label="${en ? 'Notes' : '微博随手记'}">
  ${weiboHomeHead(o.total, en)}
  <div class="wb-list">${cards}</div>
</section>`
}

/**
 * 搜索页微博结果（ROADMAP B4，fts.ts 搜出的微博在这里渲染）：结构整体复用首页微博流的
 * wb-home-feed / wb-card 系列样式（六主题已有样式，零新增 CSS），头部计数换成「命中 N 条」。
 * 只读视角：不带管理操作与评论表单（allowComments: false），点赞与评论列表展开照常可用。
 */
export function weiboSearchResults(o: {
  settings: SettingsMap
  items: WeiboItemView[]
  total: number
  avatarHtml: string
}): string {
  if (!o.items.length) return ''
  const en = isEn(o.settings)
  const cards = weiboCards({
    settings: o.settings,
    items: o.items,
    avatarHtml: o.avatarHtml,
    allowComments: false,
  })
  return `<section class="wb-home-feed" aria-label="${en ? 'Note search results' : '微博搜索结果'}">
  ${weiboHomeHead(o.total, en, en ? `${o.total} ${plural(o.total, 'match', 'matches')}` : `命中 ${o.total} 条`)}
  <div class="wb-list">${cards}</div>
</section>`
}

/* ---------------- 会员 / 排行榜（共享构建器） ----------------
 * 结构全主题共用（语义化 .mem-* / .rk-* class），视觉由主题 CSS 塑形。
 * 数据由会员服务端产出（members 表 / points，见 DEVPLAN-2026-10-07 附录 A 契约）；
 * 档位枚举 'all'|'coffee'|'top' / 'normal'|'coffee'|'top'，标签集中在这里，主题不手写文案。
 */

export type MemberTier = 'normal' | 'coffee' | 'top'

export const TIER_LABELS: Record<MemberTier, string> = {
  normal: '普通会员',
  coffee: '咖啡会员',
  top: '顶级会员',
}

/** 档位 → 展示文案：脏值/缺省一律按普通会员兜底（hasOwnProperty 防原型链穿透）；en 换英文档位名 */
export function tierLabel(tier: string | undefined | null, en = false): string {
  const key = tier && Object.prototype.hasOwnProperty.call(TIER_LABELS, tier) ? (tier as MemberTier) : 'normal'
  return en ? { normal: 'Member', coffee: 'Coffee member', top: 'Top member' }[key] : TIER_LABELS[key]
}

/** 会员身份视图（/member 页、评论表单、排行挂件共用）；服务端产出，渲染层只读 */
export interface MemberView {
  nickname: string
  tier: MemberTier
  points: number
  email?: string
  /** P1 预留：会员自定义头像（无则退回昵称首字，与站点头像同款降级） */
  avatarUrl?: string
  /** 绑定的 QQ 号（本人视角才有——评论 / 榜单等公开面一律不携带，红线见 DEVPLAN） */
  qq?: string
  createdAt?: number
  /** 上次改昵称时间（本人视角才有；null/缺省 = 从未改过，首次修改不受 30 天窗口限制） */
  displayNameChangedAt?: number | null
}

/** 排行榜条目：rank 为服务端排好的名次（1 起）；选择隐藏自己的会员不出现在数据里 */
export interface RankEntryView {
  rank: number
  nickname: string
  tier: MemberTier
  points: number
  /** 会员头像（站内 /images/ 转存地址），空 = 首字图标 */
  avatarUrl?: string
  /** 当前访客本人行（榜单页高亮用） */
  isMe?: boolean
}

/** 会员头像位：有 avatarUrl 用图片，否则退回昵称首字；cls 传主题侧样式类（如 mem-avatar） */
export function memberAvatarHtml(m: MemberView, cls: string): string {
  if (m.avatarUrl) return `<img class="${cls} ${cls}-img" src="${esc(m.avatarUrl)}" alt="${esc(m.nickname)}">`
  const ch = (m.nickname || '客').trim().charAt(0) || '客'
  return `<span class="${cls}" aria-hidden="true">${esc(ch)}</span>`
}

/** 评论头像位（文章 / 留言板评论）：会员有站内头像用图；作者（管理员）发言用站点头像
 *  （settings.avatarUrl，与微博卡/后台侧栏同源）；其余退回昵称首字块。
 *  site.js 的微博评论渲染是本函数的 ES5 手工镜像，改任一侧记得同步 */
function commentAvatarHtml(c: CommentRow, adminAvatar?: string): string {
  if (c.member_avatar) return `<img class="cmt-avatar cmt-avatar-img" src="${esc(c.member_avatar)}" alt="">`
  if (c.is_admin && adminAvatar) return `<img class="cmt-avatar cmt-avatar-img" src="${esc(adminAvatar)}" alt="">`
  // 游客自填 QQ 抓取转存的站内头像（C2 扩展）：qq 本体永不出参，这里只会是 /images/ 地址
  if (c.avatar) return `<img class="cmt-avatar cmt-avatar-img" src="${esc(c.avatar)}" alt="">`
  const ch = (c.nickname || '客').trim().charAt(0) || '客'
  return `<span class="cmt-avatar" aria-hidden="true">${esc(ch)}</span>`
}

/** 排行榜单行（/rank 页结构） */
function rankRow(e: RankEntryView, en: boolean): string {
  return `<li class="rk-item${e.rank <= 3 ? ` is-top${e.rank}` : ''}${e.isMe ? ' is-me' : ''}">
  <span class="rk-no">${e.rank}</span>
  ${memberAvatarHtml(e, 'rk-avatar')}
  <span class="rk-name">${esc(e.nickname)}</span>
  <span class="rk-tier">${tierLabel(e.tier, en)}</span>
  <b class="rk-pts">${e.points}</b>
</li>`
}

/** /rank 完整榜单列表（页面壳由主题渲染）；空榜返回空串，由页面出空态文案 */
export function rankListHtml(entries: RankEntryView[], en = false): string {
  if (!entries.length) return ''
  return `<ol class="rk-list rk-list-page">${entries.map((e) => rankRow(e, en)).join('\n')}</ol>`
}

/** 昵称修改窗口的说明文案（30 天一次，天数从常量取防两处漂移）；冷却中附解禁日期 */
function nicknameRuleText(m: MemberView, en: boolean): { allowed: boolean; text: string } {
  const days = Math.round(NICKNAME_CHANGE_COOLDOWN_MS / 86_400_000)
  const cd = nicknameCooldown(m.displayNameChangedAt)
  if (cd.allowed)
    return en
      ? { allowed: true, text: `Display names can be changed once every ${days} days.` }
      : { allowed: true, text: `昵称中英文均可，每 ${days} 天可修改一次` }
  return en
    ? { allowed: false, text: `It can only be changed once every ${days} days — next change available after ${fmtDateEn(cd.nextAt)}.` }
    : { allowed: false, text: `每 ${days} 天只能修改一次，${fmtDateCN(cd.nextAt)}后可再改` }
}

/** 会员中心（已登录态）：身份卡 + 昵称修改卡（30 天一次）+ 密码修改卡（无找回，警示随表单）。
 *  三卡都走 .mem-* 共享结构（与登录/注册表单同套样式），提交交互在 site.js */
export function memberCardHtml(m: MemberView, en = false): string {
  const rule = nicknameRuleText(m, en)
  const dis = rule.allowed ? '' : ' disabled'
  return `<section class="mem-card" data-member-card>
  <div class="mem-who">
    ${memberAvatarHtml(m, 'mem-avatar')}
    <div class="mem-main">
      <b class="mem-name">${esc(m.nickname)}</b>
      <span class="mem-tier" data-tier="${esc(m.tier)}">${tierLabel(m.tier, en)}</span>
    </div>
    <div class="mem-points"><b>${m.points}</b><span>${tr(en, '积分')}</span></div>
  </div>
  ${m.email ? `<p class="mem-email">${esc(m.email)}</p>` : ''}
  ${m.createdAt ? (en ? `<p class="mem-email">Joined ${fmtDateEn(m.createdAt)}</p>` : `<p class="mem-email">${fmtDateCN(m.createdAt)}加入</p>`) : ''}
  <button class="mem-btn mem-btn-ghost" type="button" data-member-logout>${tr(en, '退出登录')}</button>
</section>
<section class="mem-card">
  <h2 class="mem-form-title">${tr(en, '修改昵称')}</h2>
  <form data-member-nickname-form>
    <input class="mem-input" name="nickname" maxlength="24" value="${esc(m.nickname)}" placeholder="${tr(en, '昵称（中英文均可）')}" aria-label="${en ? 'Display name' : '昵称'}"${dis}>
    <p class="mem-swap">${esc(rule.text)}</p>
    <button class="mem-btn" type="submit"${dis}>${tr(en, '保存昵称')}</button>
    <p class="mem-tip" data-member-tip aria-live="polite"></p>
  </form>
</section>
<section class="mem-card">
  <h2 class="mem-form-title">${tr(en, 'QQ 头像')}</h2>
  <form data-member-qq-form>
    <input class="mem-input" name="qq" inputmode="numeric" maxlength="11" value="${esc(m.qq || '')}" placeholder="${tr(en, '输入你的 QQ 号')}" aria-label="${en ? 'QQ ID' : 'QQ 号'}">
    <p class="mem-swap">${
      m.qq
        ? m.avatarUrl
          ? tr(en, '已绑定，头像会显示在评论区与排行榜')
          : tr(en, '已绑定但头像还没抓到，点下方按钮重试')
        : tr(en, '绑定后评论区与排行榜显示 QQ 头像；QQ 号仅用于抓取头像，不会公开展示')
    }</p>
    <button class="mem-btn" type="submit">${m.qq && !m.avatarUrl ? tr(en, '重试头像') : tr(en, '保存')}</button>
    <p class="mem-tip" data-member-tip aria-live="polite"></p>
  </form>
</section>
<section class="mem-card">
  <h2 class="mem-form-title">${tr(en, '修改密码')}</h2>
  <form data-member-password-form>
    <input class="mem-input" type="password" name="current" maxlength="72" placeholder="${tr(en, '当前密码')}" autocomplete="current-password" required aria-label="${tr(en, '当前密码')}">
    <input class="mem-input" type="password" name="next" maxlength="72" placeholder="${tr(en, '新密码（至少 8 位）')}" autocomplete="new-password" required aria-label="${tr(en, '新密码（至少 8 位）')}">
    <p class="mem-swap">${tr(en, '本站不提供密码找回，请务必记好新密码；修改成功后其他设备将退出登录')}</p>
    <button class="mem-btn" type="submit">${tr(en, '确认修改')}</button>
    <p class="mem-tip" data-member-tip aria-live="polite"></p>
  </form>
</section>`
}

/** 会员登录 / 注册双表单（未登录态）：提交与切换交互在 site.js；蜜罐字段照评论表单口径（name=link）。
 *  注册可填昵称（选填，中英文均可，不占用 30 天修改窗口），密码无找回的提醒放在提交键旁 */
export function memberAuthHtml(en = false): string {
  return `<section class="mem-auth">
  <form class="mem-card mem-form" data-member-form="login">
    <h2 class="mem-form-title">${tr(en, '登录')}</h2>
    <input class="mem-input" name="username" maxlength="24" placeholder="${tr(en, '用户名')}" autocomplete="username" required aria-label="${tr(en, '用户名')}">
    <input class="mem-input" type="password" name="password" maxlength="72" placeholder="${tr(en, '密码')}" autocomplete="current-password" required aria-label="${tr(en, '密码')}">
    <input class="cmt-hp" name="link" tabindex="-1" autocomplete="off" aria-hidden="true">
    <button class="mem-btn" type="submit">${tr(en, '登录')}</button>
    <p class="mem-swap">${tr(en, '还没有账号？')}<button type="button" class="mem-swap-btn" data-member-swap="register">${tr(en, '注册一个')}</button></p>
    <p class="mem-tip" data-member-tip aria-live="polite"></p>
  </form>
  <form class="mem-card mem-form" data-member-form="register">
    <h2 class="mem-form-title">${tr(en, '注册会员')}</h2>
    <input class="mem-input" name="username" maxlength="24" placeholder="${tr(en, '用户名（2-24 位字母、数字、_ 或 -）')}" autocomplete="username" required aria-label="${tr(en, '用户名')}">
    <input class="mem-input" name="nickname" maxlength="24" placeholder="${tr(en, '昵称（选填，中英文均可）')}" aria-label="${tr(en, '昵称（选填，中英文均可）')}">
    <input class="mem-input" type="password" name="password" maxlength="72" placeholder="${en ? 'Password (min 8 characters)' : '密码（至少 8 位）'}" autocomplete="new-password" required aria-label="${tr(en, '密码')}">
    <input class="mem-input" type="email" name="email" maxlength="120" placeholder="${tr(en, '邮箱（选填）')}" autocomplete="email" aria-label="${tr(en, '邮箱（选填）')}">
    <input class="cmt-hp" name="link" tabindex="-1" autocomplete="off" aria-hidden="true">
    <button class="mem-btn" type="submit">${tr(en, '注册并登录')}</button>
    <p class="mem-swap">${tr(en, '密码一旦遗失无法找回，请务必记好')}</p>
    <p class="mem-swap">${tr(en, '已有账号？')}<button type="button" class="mem-swap-btn" data-member-swap="login">${tr(en, '去登录')}</button></p>
    <p class="mem-tip" data-member-tip aria-live="polite"></p>
  </form>
</section>`
}

/** 付费墙遮挡卡：locked 文章在试读段之后的升级提示（正文已被服务端截断，浏览器拿不到全文）。
 *  CTA 统一指向 /member；文案随档位：'top' 顶级会员、'member' 会员、其余（coffee/缺省）按咖啡会员 */
export function paywallHtml(minTier: string | undefined | null, en = false): string {
  const tierName = en
    ? minTier === 'top'
      ? 'Top member'
      : minTier === 'member'
        ? 'Member'
        : 'Coffee member'
    : minTier === 'top'
      ? TIER_LABELS.top
      : minTier === 'member'
        ? '会员'
        : TIER_LABELS.coffee
  return `<section class="paywall" aria-label="${en ? 'Members-only content' : '会员专属内容'}">
  <svg class="paywall-ico" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="4" y="11" width="16" height="9" rx="2"/><path d="M8 11V7a4 4 0 0 1 8 0v4"/><circle cx="12" cy="15.5" r="1.3"/></svg>
  <h2 class="paywall-title">${en ? `${esc(tierName)}-only content` : `${esc(tierName)}专属内容`}</h2>
  <p class="paywall-text">${
    en
      ? `The rest of this post is for ${esc(tierName)}s only. Already a member? Log in to continue — not one yet? Join to unlock.`
      : `本文剩余部分仅限${esc(tierName)}阅读。已是会员？登录后继续；还不是会员？加入即可解锁。`
  }</p>
  <a class="paywall-cta" href="/member">${en ? 'Log in / Join' : '登录 / 加入会员'}</a>
</section>`
}

/* ---------------- 历史上的今天（首页时光机卡，共享构建器） ----------------
 * 结构全主题共用（语义化 .otd-* class），视觉由主题 CSS 塑形；没有命中时不渲染。
 */
export interface OnThisDayItemView {
  kind: 'post' | 'weibo'
  href: string
  text: string
  ts: number
  yearsAgo: number
}

/** 年份标签：1 = 去年，2+ = N 年前 */
function otdYearLabel(yearsAgo: number, en: boolean): string {
  if (en) return yearsAgo <= 1 ? 'Last year' : `${yearsAgo} ${plural(yearsAgo, 'year', 'years')} ago`
  return yearsAgo <= 1 ? '去年' : `${yearsAgo} 年前`
}

/** 卡片直出条数，其余进「展开」折叠区——当天历史再多也不挤丢，只多占一行摘要 */
const OTD_VISIBLE = 4

function otdRow(it: OnThisDayItemView, en: boolean): string {
  return `<a class="otd-item" href="${esc(it.href)}">
  <span class="otd-year">${cstDate(it.ts).getUTCFullYear()}<i>${otdYearLabel(it.yearsAgo, en)}</i></span>
  <span class="otd-text">${esc(it.text)}</span>
  <span class="otd-kind">${it.kind === 'post' ? tr(en, '文章') : en ? 'Note' : '微博'}</span>
</a>`
}

export function onThisDayCard(items: OnThisDayItemView[] | null | undefined, en = false): string {
  if (!items?.length) return ''
  const rest = items.slice(OTD_VISIBLE)
  // 原生 <details> 折叠：无 JS 可用（CSP 禁内联脚本），开关文案由 CSS 按 open 态切换
  const more = rest.length
    ? `<details class="otd-more">
  <summary><span class="otd-fold-more">${en ? `Show ${rest.length} more ▾` : `展开其余 ${rest.length} 条 ▾`}</span><span class="otd-fold-less">${en ? 'Collapse ▴' : '收起 ▴'}</span></summary>
  ${rest.map((it) => otdRow(it, en)).join('\n')}
</details>`
    : ''
  return `<section class="otd-card" aria-label="${tr(en, '历史上的今天')}">
  <header class="otd-head">
    <svg class="otd-ico" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 3"/></svg>
    <span class="otd-title">${tr(en, '历史上的今天')}</span>
    <span class="otd-sub">${tr(en, '时间经过的地方，总会留下点什么')}</span>
  </header>
  ${items.slice(0, OTD_VISIBLE).map((it) => otdRow(it, en)).join('\n')}
  ${more}
</section>`
}

/** 前台微博页发布框：管理员登录时由主题渲染在时间线顶部（访客不可见），交互在 site.js，与后台发布器同款能力 */
export function weiboComposer(o: { adminName: string; en?: boolean }): string {
  const en = !!o.en
  return `<form class="wb-composer" data-wb-composer>
  <p class="wb-composer-as">${en ? 'Posting as' : '以作者'} <b>${esc(o.adminName)}</b>${en ? '' : ' 的身份发布'}</p>
  <textarea class="wb-composer-textarea" name="content" maxlength="5000" rows="3" placeholder="${tr(en, '有什么新鲜事？正文里写 #话题# 可归类')}"></textarea>
  <div class="wb-composer-tiles" hidden></div>
  <div class="wb-composer-foot">
    <button class="wb-composer-add" type="button">${tr(en, '加图（0/9）')}</button>
    <span class="wb-composer-count" data-count>0 / 5000</span>
    <span class="wb-composer-tip" data-tip aria-live="polite"></span>
    <span class="wb-composer-actions">
      <button class="wb-composer-draft" type="button">${tr(en, '存草稿')}</button>
      <button class="wb-composer-publish" type="button">${tr(en, '发布')}</button>
    </span>
  </div>
</form>`
}

/** 微博页翻页：上一页 / 下一页（页数少，无需页码跳转）；按话题筛选时翻页要带上 topic */
export function weiboPager(page: number, totalPages: number, topic?: string, en = false): string {
  if (totalPages <= 1) return ''
  const href = (p: number) => `/weibo?page=${p}${topic ? `&topic=${encodeURIComponent(topic)}` : ''}`
  const prevLabel = en ? '← Newer' : '← 新一条'
  const nextLabel = en ? 'Older →' : '更早的 →'
  const prev =
    page > 1
      ? `<a class="wb-pager-btn" href="${href(page - 1)}">${prevLabel}</a>`
      : `<span class="wb-pager-btn is-disabled">${prevLabel}</span>`
  const next =
    page < totalPages
      ? `<a class="wb-pager-btn" href="${href(page + 1)}">${nextLabel}</a>`
      : `<span class="wb-pager-btn is-disabled">${nextLabel}</span>`
  return `<nav class="wb-pager">${prev}<span class="wb-pager-info">${page} / ${totalPages}</span>${next}</nav>`
}

export interface PagerContext {
  page: number
  totalPages: number
  /** 形如 "/" 或 "/?tag=生活&" —— 会拼接 page=N */
  base: string
}

export function pagerHtml(c: PagerContext, en = false): string {
  if (c.totalPages <= 1) return ''
  const link = (p: number, label: string, cls: string, disabled = false) =>
    disabled
      ? `<span class="pager-btn ${cls} is-disabled">${label}</span>`
      : `<a class="pager-btn ${cls}" href="${esc(c.base)}page=${p}">${label}</a>`
  let nums = ''
  const start = Math.max(1, c.page - 2)
  const end = Math.min(c.totalPages, start + 4)
  for (let p = start; p <= end; p++) {
    nums += link(p, String(p), `pager-num${p === c.page ? ' is-current' : ''}`)
  }
  // 页码跳转：纯 HTML GET 表单（CSP 禁内联脚本），base 里的参数（tag/sort/seed…）原样带回
  const baseQs = c.base.replace(/^[^?]*\?/, '').replace(/&+$/, '')
  const hidden = [...new URLSearchParams(baseQs).entries()]
    .map(([k, v]) => `<input type="hidden" name="${esc(k)}" value="${esc(v)}">`)
    .join('')
  const jump = `<form class="pager-jump" action="${esc(c.base.split('?')[0] || '/')}" method="get">${hidden}<span class="pager-jump-text">${
    en ? `Page` : '跳至'
  }</span><input class="pager-input" type="number" name="page" min="1" max="${c.totalPages}" value="${c.page}" aria-label="${tr(en, '页码')}">${
    en
      ? `<span class="pager-jump-text">of ${c.totalPages}</span><button class="pager-go" type="submit">Go</button>`
      : `<span class="pager-jump-text">页</span><span class="pager-jump-text">/ 共 ${c.totalPages} 页</span><button class="pager-go" type="submit">跳转</button>`
  }</form>`
  return `<nav class="pager">${link(c.page - 1, tr(en, '← 上一页'), 'pager-prev', c.page <= 1)}${nums}${link(
    c.page + 1,
    tr(en, '下一页 →'),
    'pager-next',
    c.page >= c.totalPages
  )}</nav>${jump}`
}

/** 留言区（评论列表 + 表单），语义化 class 交给主题 CSS 塑形
 * - 楼中楼：parent_id 指向顶层评论的回复缩进展示，作者发言带「作者」徽标
 * - isAdmin：当前访客为管理员，渲染每条留言的「回复」按钮（site.js 接管交互）
 * - guestbook：留言板页（/guestbook）复用同一套结构，表单提交到 /api/public/guestbook
 */
export function commentsHtml(o: {
  comments: CommentRow[]
  slug: string
  allowComments: boolean
  count: number
  isAdmin?: boolean
  /** 登录管理员昵称：表单免填昵称，以作者身份发言 */
  adminName?: string
  /** 登录会员昵称（管理员未登录时生效）：表单免填昵称，以会员身份发言 */
  memberName?: string
  /** 站点头像（settings.avatarUrl）：作者（管理员）评论的头像位用它，与微博卡同源 */
  adminAvatar?: string
  title?: string
  tip?: string
  /** 留言板模式：区块与表单换成 guestbook 专用 id，提交目标不同 */
  guestbook?: boolean
  /** 英文测试版：文案走词典/英文语序，中文路径不传即原样 */
  en?: boolean
}): string {
  const en = !!o.en
  const tops = o.comments.filter((c) => !c.parent_id)
  const children = new Map<number, CommentRow[]>()
  for (const c of o.comments) {
    if (!c.parent_id) continue
    const list = children.get(c.parent_id) || []
    list.push(c)
    children.set(c.parent_id, list)
  }

  // 孤儿回复（父评论被删）：按顶层展示，避免消失（先建 id 集合，免得逐条平方级扫全量评论）
  const commentIds = new Set(o.comments.map((c) => c.id))
  const orphans = o.comments.filter((c) => c.parent_id && !commentIds.has(c.parent_id))
  for (const c of orphans) tops.push({ ...c, parent_id: 0 })

  const renderItem = (c: CommentRow): string => {
    // 徽标：作者优先；会员评论（member_id > 0 时列表查询带出 member_tier，契约 DEVPLAN 附录 A）带「会员」徽标
    const badge = c.is_admin
      ? `<span class="cmt-badge">${tr(en, '作者')}</span>`
      : c.member_tier
        ? `<span class="cmt-badge">${en ? 'Member' : '会员'}</span>`
        : ''
    const replyBtn = o.isAdmin
      ? `<button class="cmt-reply-btn" type="button" data-reply="${c.id}" data-name="${esc(c.nickname)}">${tr(en, '回复')}</button>`
      : ''
    const kids = children.get(c.id) || []
    return `<li class="cmt-item" id="cmt-${c.id}">
  <div class="cmt-head">
    ${commentAvatarHtml(c, o.adminAvatar)}
    <span class="cmt-name">${esc(c.nickname)}${badge}</span>
    <span class="cmt-time">${en ? fmtDateTimeEn(c.created_at) : fmtDateTime(c.created_at)}</span>
    ${replyBtn}
  </div>
  <div class="cmt-body">${replaceEmoji(esc(c.content))}</div>
  ${kids.length ? `<ul class="cmt-children">${kids.map(renderItem).join('')}</ul>` : ''}
</li>`
  }

  const list = tops.map((c) => renderItem(c)).join('\n')

  const formInner = `
  <input type="hidden" name="parentId" value="">
  ${
    o.adminName
      ? adminIdentity(o.adminName, en)
      : o.memberName
        ? memberIdentity(o.memberName, en)
        : `<div class="cmt-form-row">
    <input class="cmt-input" name="nickname" maxlength="24" placeholder="${tr(en, '昵称')}" required>
    <input class="cmt-input cmt-hp" name="link" tabindex="-1" autocomplete="off" aria-hidden="true">
  </div>
  <div class="cmt-form-row">
    <input class="cmt-input" name="qq" inputmode="numeric" maxlength="11" placeholder="${tr(en, 'QQ 号（选填，展示头像）')}" autocomplete="off" title="${tr(en, '仅用于抓取头像，不会公开展示')}">
  </div>`
  }
  <textarea class="cmt-textarea" name="content" maxlength="1000" rows="3" placeholder="${
    o.guestbook ? tr(en, '想对作者说点什么…') : tr(en, '写下你的想法…')
  }" required></textarea>
  <div class="cmt-form-foot">
    <span class="cmt-tip">${esc(o.tip || tr(en, '留言即刻展示，请友善交流'))}</span>
    <button class="cmt-submit" type="submit">${tr(en, '发送')}</button>
  </div>
`
  const form = o.allowComments
    ? o.guestbook
      ? `<form id="guestbook-form" class="cmt-form${o.adminName ? ' is-admin' : ''}" data-guestbook="1">${formInner}</form>`
      : `<form id="comment-form" class="cmt-form${o.adminName ? ' is-admin' : ''}" data-slug="${esc(o.slug)}">${formInner}</form>`
    : `<p class="cmt-closed">${tr(en, '作者已关闭留言。')}</p>`

  return `<section class="cmt-section${o.guestbook ? ' gb-section' : ''}" id="${o.guestbook ? 'guestbook' : 'comments'}">
  <h2 class="cmt-title">${esc(o.title || tr(en, o.guestbook ? '留言板' : '留言'))} <span class="cmt-count">${o.count}</span></h2>
  ${o.comments.length ? `<ul class="cmt-list">${list}</ul>` : `<p class="cmt-empty">${o.guestbook ? tr(en, '还没有人留言，来坐个沙发，说点什么吧～') : tr(en, '还没有留言，来抢沙发～')}</p>`}
  ${form}
</section>`
}

export function likesBtn(slug: string, likes: number, en = false): string {
  return `<button class="like-btn" data-slug="${esc(slug)}" data-likes="${likes}" type="button">
  ${heartSvg(18)}
  <span class="like-label">${tr(en, '赞')}</span>
  <b class="like-count" data-count>${likes}</b>
</button>`
}

/**
 * 文章分享按钮：data-share-url 是 canonical 绝对链接，data-share-qr 是该链接的
 * QR 矩阵位串（src/qrcode.ts packMatrix 产物，空串表示链接超长未生成码）。
 * 交互在 site.js：点击按需加载 /share-card.js 弹出分享面板（复制链接/系统分享/卡片图）。
 */
export function shareBtn(url: string, qr: string, en = false): string {
  return `<button class="share-btn" type="button" data-share-url="${esc(url)}"${
    qr ? ` data-share-qr="${esc(qr)}"` : ''
  } aria-label="${tr(en, '分享本文')}">
  <svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true"><path d="M12 14V3.5m0 0L8.5 7m3.5-3.5L15.5 7" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/><path d="M7.5 10.5H7a3 3 0 0 0-3 3V18a3 3 0 0 0 3 3h10a3 3 0 0 0 3-3v-4.5a3 3 0 0 0-3-3h-.5" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/></svg>
  <span class="share-label">${tr(en, '分享')}</span>
</button>`
}

export function tagLink(name: string): string {
  return `/tag/${encodeURIComponent(name)}`
}

/* ---------------- 首页列表排序筛选（共享构建器） ----------------
 * 结构全主题共用（语义化 .fs-* class），视觉由主题 CSS 塑形。
 * 随机排序：点「随机」不带 seed，服务端每次生成新 seed 洗一组；
 * 翻页链接带 seed，保证同一组随机顺序不重洗。
 */

/** 列表页排序可选项与文案 */
export const HOME_SORTS: { key: PostSort; label: string }[] = [
  { key: 'latest', label: '最新' },
  { key: 'views', label: '最多阅读' },
  { key: 'likes', label: '最多点赞' },
  { key: 'comments', label: '最多留言' },
  { key: 'random', label: '随机' },
]

export interface ListPageContext {
  sort?: PostSort
  seed?: number
  tag?: string
  categorySlug?: string
  q?: string
}

/** 列表地址共用的查询串：tag/q/sort/seed 四件套 */
function listQuery(o: ListPageContext): string {
  const params = new URLSearchParams()
  if (o.tag) params.set('tag', o.tag)
  if (o.q) params.set('q', o.q)
  if (o.sort && o.sort !== 'latest') params.set('sort', o.sort)
  if (o.sort === 'random' && o.seed) params.set('seed', String(o.seed))
  return params.toString()
}

/** 排序条/翻页共用的列表地址：分类页、搜索页留在原路径，首页/标签页用 /?tag= */
export function listPageUrl(o: ListPageContext): string {
  const qs = listQuery(o)
  if (o.categorySlug) return `/category/${encodeURIComponent(o.categorySlug)}${qs ? `?${qs}` : ''}`
  if (o.q) return `/search${qs ? `?${qs}` : ''}`
  return '/' + (qs ? `?${qs}` : '')
}

/** 排序筛选条：一排 chips，当前排序高亮；点「随机」永远洗新一组 */
export function homeSortBar(o: ListPageContext, en = false): string {
  const chips = HOME_SORTS.map(
    (s) =>
      `<a class="fs-chip${s.key === (o.sort || 'latest') ? ' is-active' : ''}" href="${esc(
        listPageUrl({ ...o, sort: s.key, seed: undefined })
      )}">${tr(en, s.label)}</a>`
  ).join('')
  return `<nav class="fs-bar" aria-label="${tr(en, '文章排序')}"><span class="fs-label">${tr(en, '排序')}</span>${chips}</nav>`
}

/** 翻页链接前缀（形如 "/?tag=x&sort=random&seed=5&"），随机时带 seed 稳住顺序 */
export function homeListBase(o: ListPageContext): string {
  const qs = listQuery(o)
  const head = o.categorySlug
    ? `/category/${encodeURIComponent(o.categorySlug)}?`
    : o.q
      ? '/search?'
      : '/?'
  return head + (qs ? qs + '&' : '')
}

/** 浏览量缩写：中文「1.2w」（万），英文测试版换「12k」口语（1.2 万 → 12k） */
export function fmtViews(n: number, en = false): string {
  if (en) return n >= 1000 ? (n / 1000).toFixed(1).replace(/\.0$/, '') + 'k' : String(n)
  return n >= 10000 ? (n / 10000).toFixed(1).replace(/\.0$/, '') + 'w' : String(n)
}

export { esc, fmtDate, fmtDateCN }
