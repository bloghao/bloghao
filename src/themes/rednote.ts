import type { SettingsMap } from '../types'
import type { AboutData, ArchivesData, GuestbookData, HomeData, LinksData, MemberData, PageData, PostData, RankData, WeiboData } from './registry'
import {
  archiveListHtml,
  categoryLink,
  esc,
  fmtDate,
  fmtDateEn,
  fmtViews,
  footLinks,
  friendLinkApply,
  friendLinkCards,
  homeListBase,
  homeSortBar,
  isEn,
  likesBtn,
  memberAuthHtml,
  memberCardHtml,
  onThisDayCard,
  pagerHtml,
  paywallHtml,
  plural,
  rankListHtml,
  shareBtn,
  siteMode,
  siteNav,
  tagLink,
  tr,
  weiboCards,
  weiboComposer,
  weiboHomeEntry,
  weiboHomeFeed,
  weiboSearchResults,
  weiboPager,
  weiboTopicBar,
} from '../render'
import css from './rednote.css'

const id = 'rednote'

/**
 * 站点标志（没设 avatarUrl 时的默认门面）：品牌红圆角方块 + 白色「记」，
 * 致敬小红书红底白字标志的版式；单字用系统中文粗体渲染（PingFang / 雅黑覆盖面足够）。
 * 尺寸由主题 CSS 按场景塑形（刊头 64 / 页头 26 / 作者栏 40 / 微博头像 36）。
 */
const RN_LOGO =
  '<svg class="rn-mark" viewBox="0 0 64 64" aria-hidden="true"><rect width="64" height="64" rx="15" fill="#ff2442"/><text x="32" y="45" text-anchor="middle" font-size="34" font-weight="700" fill="#fff" font-family="\'PingFang SC\',\'Hiragino Sans GB\',\'Microsoft YaHei\',sans-serif">记</text></svg>'

/** 实心小红心（列表卡片赞数 / 页脚签名句用；按钮里的描边心由 render.ts likesBtn 自带） */
const HEART =
  '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 21s-7.5-4.9-10-9.3C.5 8.4 2.3 4.9 5.7 4.5c2-.2 3.9.8 5 2.5a5.7 5.7 0 0 1 5-2.5c3.4.4 5.2 3.9 3.7 7.2C19.5 16.1 12 21 12 21z" fill="currentColor"/></svg>'

/** 放大镜（搜索框左侧小图标） */
const MAGNIFIER =
  '<svg class="rn-search-ico" viewBox="0 0 24 24" aria-hidden="true"><circle cx="11" cy="11" r="6.5" fill="none" stroke="currentColor" stroke-width="1.8"/><path d="m16 16 4.5 4.5" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/></svg>'

/** 页脚公共件：八个页面只差链接组，结构统一在这里；末行红心签名句是主题注脚 */
function foot(s: SettingsMap, links: string): string {
  const en = isEn(s)
  return `<footer class="rn-footer">
  <div class="rn-footer-row"><span>${esc(tr(en, s.footerText || ''))}</span><span class="rn-footer-links">${footLinks(s, links)}</span></div>
  <p class="rn-footer-motto">${HEART}${en ? 'Mark my life.' : '标记我的生活'}</p>
</footer>`
}
const FOOT_LINKS = {
  home: '<a href="/weibo">微博</a><a href="/rss.xml">RSS</a><a href="/admin">管理</a>',
  article: '<a href="/weibo">微博</a><a href="/admin">管理</a><a href="/rss.xml">RSS</a>',
  about: '<a href="/">Home</a><a href="/weibo">微博</a><a href="/admin">管理</a>',
}

/** 页脚链接组的英文测试版镜像（结构同 FOOT_LINKS，只换标签词） */
const FOOT_LINKS_EN = {
  home: '<a href="/weibo">Notes</a><a href="/rss.xml">RSS</a><a href="/admin">Admin</a>',
  article: '<a href="/weibo">Notes</a><a href="/admin">Admin</a><a href="/rss.xml">RSS</a>',
  about: '<a href="/">Home</a><a href="/weibo">Notes</a><a href="/admin">Admin</a>',
}

/** 站点标志：设置过 avatarUrl 用头像，否则用品牌红方块（小红书主题的默认门面） */
function mark(s: SettingsMap): string {
  return s.avatarUrl ? `<img class="rn-avatar" src="${esc(s.avatarUrl)}" alt="${esc(s.siteName)}">` : RN_LOGO
}

/** 关注胶囊：博客语境的「关注」= 订阅 RSS；次级胶囊是去留言板打个招呼 */
function followPill(en: boolean): string {
  return `<div class="rn-hero-actions"><a class="rn-follow" href="/rss.xml">${en ? 'Follow' : '关注'}</a><a class="rn-follow rn-follow-ghost" href="/guestbook">${en ? 'Say hi' : '打个招呼'}</a></div>`
}

/** 搜索框：小红书灰胶囊（放大镜 + 红色搜索按钮） */
function searchForm(q: string | undefined, en: boolean): string {
  return `<form class="rn-search" action="/search" method="get" role="search">
  ${MAGNIFIER}
  <input class="rn-search-input" type="search" name="q" value="${esc(q || '')}" placeholder="${en ? 'Search' : '搜索你感兴趣的'}" maxlength="60" aria-label="${en ? 'Search posts' : '搜索文章'}">
  <button class="rn-search-btn" type="submit">${en ? 'Search' : '搜索'}</button>
</form>`
}

export function home(d: HomeData): string {
  const s = d.settings
  const en = isEn(s)
  const items = d.posts
    .map((p) => {
      const foot = `<div class="rn-card-foot"><span class="rn-card-likes">${HEART}<b>${fmtViews(p.likes, en)}</b></span><span class="rn-card-time">${en ? fmtDateEn(p.published_at) : fmtDate(p.published_at)}</span></div>`
      if (p.cover) {
        return `<a class="rn-card" href="/post/${esc(p.slug)}">
  <div class="rn-card-cover"><img src="${esc(p.cover)}" loading="lazy" alt=""></div>
  <div class="rn-card-body"><h2 class="rn-card-title">${esc(p.title)}${p.pinned ? `<span class="rn-pin">${tr(en, '置顶')}</span>` : ''}</h2>${foot}</div>
</a>`
      }
      return `<a class="rn-card" href="/post/${esc(p.slug)}">
  <div class="rn-card-body is-textonly"><h2 class="rn-card-title">${esc(p.title)}${p.pinned ? `<span class="rn-pin">${tr(en, '置顶')}</span>` : ''}</h2><p class="rn-card-abs">${esc(p.summary)}</p>${foot}</div>
</a>`
    })
    .join('\n')
  return `<div class="rn-wrap">
  ${siteNav({ mode: siteMode(d.settings), memberEnabled: d.settings.membersEnabled === '1', cls: 'rn-snav', categories: d.categories, tags: d.tags, pages: d.pages, active: d.navActive, en })}
  <header class="rn-hero">
    <div class="rn-hero-mark">${mark(s)}</div>
    <h1 class="rn-hero-title">${esc(tr(en, s.siteName))}</h1>
    <p class="rn-hero-lead">${esc(tr(en, s.siteDescription))}</p>
    ${followPill(en)}
    ${d.total > 0 ? `<p class="rn-hero-count">${en ? `${d.total} ${plural(d.total, 'post', 'posts')}` : `共 ${d.total} 篇 · 持续更新`}</p>` : ''}
  </header>
  ${d.notice ? `<div class="rn-notice">${d.notice}</div>` : ''}
  ${d.weiboFeed ? weiboHomeFeed({ settings: s, items: d.weiboFeed.items, total: d.weiboFeed.total, avatarHtml: mark(s), allowComments: d.weiboFeed.allowComments, adminName: d.weiboFeed.adminName, memberName: d.weiboFeed.memberName }) : ''}
  ${d.weibo ? weiboHomeEntry({ ...d.weibo, en }) : ''}
  ${onThisDayCard(d.onThisDay, en)}
  ${searchForm(d.q, en)}
  ${homeSortBar({ sort: d.sort, seed: d.seed, tag: d.tag, categorySlug: d.categorySlug, q: d.q }, en)}
  <main class="rn-list">
    ${items || `<p class="rn-empty">${d.emptyText || 'Nothing here yet. Start writing.'}</p>`}
  </main>
  ${pagerHtml({
    page: d.page,
    totalPages: d.totalPages,
    base: homeListBase({ sort: d.sort, seed: d.seed, tag: d.tag, categorySlug: d.categorySlug, q: d.q }),
  }, en)}
  ${d.searchWeibo ? weiboSearchResults({ settings: s, items: d.searchWeibo.items, total: d.searchWeibo.total, avatarHtml: mark(s) }) : ''}
  ${foot(s, en ? FOOT_LINKS_EN.home : FOOT_LINKS.home)}
</div>`
}

export function post(d: PostData): string {
  const en = isEn(d.settings)
  const s = d.settings
  const p = d.post
  const related = d.related.length
    ? `<aside class="rn-related"><h2 class="rn-related-title">${en ? 'Related notes' : '相关笔记'}</h2>${d.related
        .map((r) => `<a href="/post/${esc(r.slug)}">${esc(r.title)}</a>`)
        .join('')}</aside>`
    : ''
  return `<div class="rn-wrap">
  ${siteNav({ mode: siteMode(s), memberEnabled: s.membersEnabled === '1', cls: 'rn-snav', categories: d.categories, tags: d.tags, pages: d.pages, en })}
  <header class="rn-header">
    <a class="rn-logo" href="/">← ${esc(tr(en, s.siteName))}</a>
  </header>
  <article class="rn-article">
    <div class="rn-author">
      <span class="rn-author-main">${mark(s)}<span class="rn-author-name">${esc(tr(en, s.siteName))}</span></span>
      <a class="rn-follow" href="/rss.xml">${en ? 'Follow' : '关注'}</a>
    </div>
    <h1 class="rn-title">${esc(p.title)}</h1>
    <div class="rn-meta"><time>${en ? fmtDateEn(p.published_at) : fmtDate(p.published_at)}</time><i>·</i><span>${p.readingMinutes} min</span><i>·</i><span>${en ? `${fmtViews(p.views, true)} views` : `${fmtViews(p.views)} 阅读`}</span></div>
    ${p.cover ? `<div class="rn-cover"><img src="${esc(p.cover)}" alt=""></div>` : ''}
    <div class="rich">${p.contentHtml}</div>
    ${p.locked ? paywallHtml(p.minTier, en) : ''}
    <div class="rn-foot">
      ${likesBtn(p.slug, p.likes, en)}
      ${d.share ? shareBtn(d.share.url, d.share.qr, en) : ''}
      <div class="rn-tags">${d.category ? `<a href="${categoryLink(d.category)}">${esc(d.category.name)}</a>` : ''}${p.tags.map((t) => `<a href="${tagLink(t)}">${esc(t)}</a>`).join('')}</div>
    </div>
    ${related}
    ${d.comments.html}
  </article>
  ${foot(s, en ? FOOT_LINKS_EN.article : FOOT_LINKS.article)}
</div>`
}

export function about(d: AboutData): string {
  return page({ ...d, title: isEn(d.settings) ? 'About' : '关于我' })
}

/** 独立页面页（/page/:slug，slug='about' 时渲染 /about）：结构同关于我，标题由页面数据决定 */
export function page(d: PageData): string {
  const en = isEn(d.settings)
  return `<div class="rn-wrap">
  ${siteNav({ mode: siteMode(d.settings), memberEnabled: d.settings.membersEnabled === '1', cls: 'rn-snav', categories: d.categories, tags: d.tags, pages: d.pages, active: d.navActive, en })}
  <header class="rn-header"><a class="rn-logo" href="/">← ${esc(tr(en, d.settings.siteName))}</a></header>
  <article class="rn-article">
    <h1 class="rn-title rn-page-title">${esc(d.title)}</h1>
    <div class="rich">${d.contentHtml}</div>
  </article>
  ${foot(d.settings, en ? FOOT_LINKS_EN.about : FOOT_LINKS.about)}
</div>`
}

/** 文章归档页：全部文章按年份分组，品牌红年份 + 圆点时间线（白卡面板承载） */
export function archives(d: ArchivesData): string {
  const s = d.settings
  const en = isEn(s)
  return `<div class="rn-wrap">
  ${siteNav({ mode: siteMode(s), memberEnabled: s.membersEnabled === '1', cls: 'rn-snav', categories: d.categories, tags: d.tags, pages: d.pages, active: 'archives', en })}
  <header class="rn-header">
    <a class="rn-logo" href="/">${mark(s)}${esc(tr(en, s.siteName))}</a>
    <nav class="rn-nav"><a class="rn-nav-link is-active" href="/archives">${tr(en, '归档')}</a><a class="rn-nav-link" href="/guestbook">${tr(en, '留言板')}</a><a class="rn-nav-link" href="/about">${tr(en, '关于我')}</a></nav>
  </header>
  <h1 class="rn-title rn-page-title">${tr(en, '归档')}</h1>
  <p class="rn-page-sub">${d.total > 0 ? (en ? `${d.total} ${plural(d.total, 'post', 'posts')} · newest year first` : `共 ${d.total} 篇 · 按年份倒序`) : en ? 'Every post lands here.' : '写下的每一篇都会收进这里'}</p>
  <main class="rn-archives">${archiveListHtml(d.groups, en) || `<p class="rn-empty">${en ? 'Nothing here yet. Start writing.' : '还没有内容，去写第一篇吧。'}</p>`}</main>
  ${foot(s, en ? FOOT_LINKS_EN.home : FOOT_LINKS.home)}
</div>`
}

/** 留言板页：独立留言墙（复用 .cmt-* 结构与样式，白卡面板承载） */
export function guestbook(d: GuestbookData): string {
  const s = d.settings
  const en = isEn(s)
  return `<div class="rn-wrap">
  ${siteNav({ mode: siteMode(s), memberEnabled: s.membersEnabled === '1', cls: 'rn-snav', categories: d.categories, tags: d.tags, pages: d.pages, active: 'guestbook', en })}
  <header class="rn-header">
    <a class="rn-logo" href="/">${mark(s)}${esc(tr(en, s.siteName))}</a>
    <nav class="rn-nav"><a class="rn-nav-link" href="/archives">${tr(en, '归档')}</a><a class="rn-nav-link is-active" href="/guestbook">${tr(en, '留言板')}</a><a class="rn-nav-link" href="/about">${tr(en, '关于我')}</a></nav>
  </header>
  <h1 class="rn-title rn-page-title">${tr(en, '留言板')}</h1>
  <p class="rn-page-sub">${d.count > 0 ? (en ? `${d.count} ${plural(d.count, 'message', 'messages')} so far · say anything` : `已有 ${d.count} 条留言 · 随便聊聊`) : en ? 'Write whatever you would like to say' : '想说点什么，就在这里写下来'}</p>
  <main class="rn-panel">${d.html}</main>
  ${foot(s, en ? FOOT_LINKS_EN.home : FOOT_LINKS.home)}
</div>`
}

/** 微博页：随手记笔记流 */
export function weibo(d: WeiboData): string {
  const s = d.settings
  const en = isEn(s)
  const topicBar = weiboTopicBar(d.topics || [], d.topic, en)
  const composer = d.adminName ? weiboComposer({ adminName: d.adminName, en }) : ''
  const cards = weiboCards({
    settings: s,
    items: d.items,
    avatarHtml: mark(s),
    allowComments: d.allowComments,
    adminName: d.adminName,
    memberName: d.memberName,
  })
  return `<div class="rn-wrap">
  ${siteNav({ mode: siteMode(s), memberEnabled: s.membersEnabled === '1', cls: 'rn-snav', categories: d.categories, tags: d.tags, pages: d.pages, active: 'weibo', en })}
  <header class="rn-header">
    <a class="rn-logo" href="/">${mark(s)}${esc(tr(en, s.siteName))}</a>
    <nav class="rn-nav"><a class="rn-nav-link is-active" href="/weibo">${tr(en, '微博')}</a><a class="rn-nav-link" href="/about">${tr(en, '关于我')}</a></nav>
  </header>
  ${topicBar}
  ${composer}
  <main class="wb-list">
    ${cards || `<p class="rn-empty">${d.adminName ? 'Nothing here yet — post the first one above.' : 'Nothing here yet.'}</p>`}
  </main>
  ${weiboPager(d.page, d.totalPages, d.topic, en)}
  ${foot(s, en ? FOOT_LINKS_EN.home : FOOT_LINKS.home)}
</div>`
}

/** 友情链接页：名片式白卡 + 申请收录 */
export function links(d: LinksData): string {
  const s = d.settings
  const en = isEn(s)
  return `<div class="rn-wrap">
  ${siteNav({ mode: siteMode(s), memberEnabled: s.membersEnabled === '1', cls: 'rn-snav', categories: d.categories, tags: d.tags, pages: d.pages, active: 'links', en })}
  <header class="rn-header">
    <a class="rn-logo" href="/">${mark(s)}${esc(tr(en, s.siteName))}</a>
    <nav class="rn-nav"><a class="rn-nav-link is-active" href="/links">${en ? 'Links' : '友链'}</a><a class="rn-nav-link" href="/about">${tr(en, '关于我')}</a></nav>
  </header>
  <h1 class="rn-title rn-page-title">${tr(en, '友情链接')}</h1>
  <p class="rn-page-sub">${en ? 'Blogs worth a slow read' : '值得慢慢读的博客们'}</p>
  <main class="fl-grid">
    ${friendLinkCards(d.items, en) || `<p class="rn-empty">${en ? 'No links yet.' : '还没有友链。'}</p>`}
  </main>
  ${friendLinkApply(en)}
  ${foot(s, en ? FOOT_LINKS_EN.home : FOOT_LINKS.home)}
</div>`
}

/** 排行榜页（/rank）：会员积分总榜，榜单行结构共用 .rk-* */
export function rank(d: RankData): string {
  const s = d.settings
  const en = isEn(s)
  return `<div class="rn-wrap">
  ${siteNav({ mode: siteMode(s), memberEnabled: s.membersEnabled === '1', cls: 'rn-snav', categories: d.categories, tags: d.tags, pages: d.pages, active: 'rank', en })}
  <header class="rn-header">
    <a class="rn-logo" href="/">${mark(s)}${esc(tr(en, s.siteName))}</a>
    <nav class="rn-nav"><a class="rn-nav-link is-active" href="/rank">${tr(en, '排行榜')}</a><a class="rn-nav-link" href="/about">${tr(en, '关于我')}</a></nav>
  </header>
  <h1 class="rn-title rn-page-title">${tr(en, '排行榜')}</h1>
  <p class="rn-page-sub">${d.total > 0 ? (en ? `${d.total} ${plural(d.total, 'member', 'members')} · sorted by points` : `共 ${d.total} 位会员 · 按积分倒序`) : en ? 'The top spot is up for grabs' : '榜首虚位以待'}</p>
  <main class="rn-rank">${rankListHtml(d.entries, en) || (en ? `<p class="rn-empty">No members on the board yet.</p>` : `<p class="rn-empty">还没有会员上榜。</p>`)}</main>
  ${foot(s, en ? FOOT_LINKS_EN.home : FOOT_LINKS.home)}
</div>`
}

/** 会员中心页（/member）：未登录出登录/注册表单，已登录出会员卡（结构共用 .mem-*） */
export function member(d: MemberData): string {
  const s = d.settings
  const en = isEn(s)
  return `<div class="rn-wrap">
  ${siteNav({ mode: siteMode(s), memberEnabled: s.membersEnabled === '1', cls: 'rn-snav', categories: d.categories, tags: d.tags, pages: d.pages, active: 'member', en })}
  <header class="rn-header">
    <a class="rn-logo" href="/">${mark(s)}${esc(tr(en, s.siteName))}</a>
    <nav class="rn-nav"><a class="rn-nav-link" href="/rank">${tr(en, '排行榜')}</a><a class="rn-nav-link" href="/about">${tr(en, '关于我')}</a></nav>
  </header>
  <h1 class="rn-title rn-page-title">${en ? 'Membership' : '会员中心'}</h1>
  <p class="rn-page-sub">${d.member ? (en ? 'Points, comments and members-only posts live here' : '留言、常回来，积分与专属内容都在这里') : en ? 'Log in or create an account to join' : '登录或注册，加入本站会员'}</p>
  <main class="rn-member">${d.member ? memberCardHtml(d.member, en) : memberAuthHtml(en)}</main>
  ${foot(s, en ? FOOT_LINKS_EN.home : FOOT_LINKS.home)}
</div>`
}

export { id, css }
