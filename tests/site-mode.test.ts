import { test } from 'node:test'
import assert from 'node:assert/strict'
import { DEFAULT_SETTINGS } from '../src/db.ts'
import { buildSitemap } from '../src/rss.ts'
import { footLinks, siteMode, siteNav, weiboHomeFeed, type SiteMode } from '../src/render.ts'
import type { WeiboItemView } from '../src/render.ts'

// ── 站点模式（后台「设置 → 站点模式」）：四值决定微博/博客模块的显隐与首页优先级 ──

test('siteMode：缺省与脏值一律回退 blog-weibo', () => {
  assert.equal(siteMode({ ...DEFAULT_SETTINGS }), 'blog-weibo')
  assert.equal(siteMode({}), 'blog-weibo')
  assert.equal(siteMode({ siteMode: 'hack' }), 'blog-weibo')
})

test('siteMode：四个合法值原样通过', () => {
  for (const m of ['blog-weibo', 'weibo-blog', 'blog', 'weibo'] as SiteMode[]) {
    assert.equal(siteMode({ siteMode: m }), m)
  }
})

const navData = { categories: [{ name: '分类', slug: 'cat' }], tags: [{ name: '生活', count: 2 }], pages: [] }

test('siteNav：默认（博客+微博）导航齐全', () => {
  const html = siteNav({ cls: 't', ...navData, active: 'home' })
  assert.match(html, /href="\/">首页</)
  assert.match(html, /href="\/weibo">微博</)
  assert.match(html, /href="\/archives">归档</)
  assert.match(html, /分类话题/)
  assert.match(html, /href="\/random">随机</)
})

test('siteNav：纯博客去掉「微博」入口，其余不动', () => {
  const html = siteNav({ cls: 't', ...navData, mode: 'blog' })
  assert.doesNotMatch(html, /href="\/weibo"/)
  assert.match(html, /href="\/">首页</)
  assert.match(html, /href="\/archives">归档</)
  assert.match(html, /分类话题/)
})

test('siteNav：纯微博「微博」提为首位，博客专属模块（归档/分类话题/随机）隐藏', () => {
  const html = siteNav({ cls: 't', ...navData, mode: 'weibo', active: 'weibo' })
  assert.doesNotMatch(html, /href="\/">首页</)
  assert.match(html, /class="t-link is-active" href="\/weibo">微博</)
  assert.doesNotMatch(html, /href="\/archives"/)
  assert.doesNotMatch(html, /href="\/random"/)
  assert.doesNotMatch(html, /分类话题/)
  // 非博客模块保留
  assert.match(html, /href="\/guestbook">留言板</)
  assert.match(html, /href="\/links">友情链接</)
  assert.match(html, /href="\/about">关于我</)
  // 「微博」是导航第一个链接
  const first = html.slice(html.indexOf('t-link'))
  assert.ok(first.includes('/weibo'))
})

// ── compact 布局（主题试点）：主条去微博（首页微博流自带「全部 →」入口），留言板/友情链接进顶栏，会员变药丸压轴，排行榜/随机降级页脚 ──

test('siteNav：compact 收窄主条并渲染会员药丸，微博/排行榜/随机不进顶栏', () => {
  const html = siteNav({ cls: 't', ...navData, memberEnabled: true, active: 'home', compact: true })
  assert.match(html, /href="\/">首页</)
  assert.match(html, /href="\/archives">归档</)
  assert.match(html, /分类话题/)
  assert.match(html, /href="\/about">关于我</)
  assert.match(html, /href="\/guestbook">留言板</)
  assert.match(html, /href="\/links">友情链接</)
  assert.match(html, /class="t-member" href="\/member">会员</)
  // 微博入口收敛进首页微博流；排行榜/随机仍降级页脚
  assert.doesNotMatch(html, /href="\/weibo"/)
  assert.doesNotMatch(html, /href="\/rank"/)
  assert.doesNotMatch(html, /href="\/random"/)
})

test('siteNav：compact 会员开关关闭时药丸不渲染，普通布局不受 compact 影响', () => {
  const off = siteNav({ cls: 't', ...navData, compact: true })
  assert.doesNotMatch(off, /t-member/)
  assert.doesNotMatch(off, /href="\/member"/)
  // 未开 compact 的默认布局原样（回归守卫：其余主题仍走全量导航，含微博入口）
  const plain = siteNav({ cls: 't', ...navData, memberEnabled: true })
  assert.match(plain, /href="\/weibo">微博</)
  assert.match(plain, /href="\/guestbook">留言板</)
  assert.match(plain, /class="t-link" href="\/member">会员</)
  assert.match(plain, /href="\/rank">排行榜</)
  assert.match(plain, /href="\/random">随机</)
})

test('siteNav：compact 纯微博模式药丸压轴、博客模块仍隐藏', () => {
  const html = siteNav({ cls: 't', ...navData, memberEnabled: true, mode: 'weibo', active: 'weibo', compact: true })
  assert.match(html, /class="t-link is-active" href="\/weibo">微博</)
  assert.doesNotMatch(html, /href="\/archives"/)
  assert.doesNotMatch(html, /分类话题/)
  assert.match(html, /href="\/guestbook">留言板</)
  assert.match(html, /class="t-member" href="\/member">会员</)
  // 「会员」药丸是导航最后一个链接
  const tail = html.slice(html.lastIndexOf('t-member'))
  assert.ok(tail.includes('/member'))
})

test('weiboHomeFeed：完整卡片流 + 头部计数，空列表不渲染', () => {
  const TS = 1_700_000_000_000
  const items: WeiboItemView[] = [
    { id: 1, content: '第一条 #话题#', images: [], created_at: TS, likes: 1, commentCount: 2, pinned: false },
    { id: 2, content: '第二条', images: ['/images/u/a.png'], created_at: TS, likes: 0, commentCount: 0 },
  ]
  const html = weiboHomeFeed({ settings: { ...DEFAULT_SETTINGS, siteName: '测试站' }, items, total: 9, avatarHtml: '<span class="a"></span>' })
  assert.match(html, /class="wb-home-feed"/)
  assert.match(html, /共 9 条/)
  assert.match(html, /href="\/weibo"/)
  assert.match(html, /class="wb-list"/)
  assert.match(html, /id="wb-1"/)
  assert.match(html, /id="wb-2"/)
  assert.equal(weiboHomeFeed({ settings: DEFAULT_SETTINGS, items: [], total: 0, avatarHtml: '' }), '')
})

// ── sitemap：纯博客模式不再收录 /weibo ──

test('buildSitemap：默认与纯微博模式收录 /weibo，纯博客剔除', () => {
  const posts = [{ slug: 'a', updated_at: 1 }]
  assert.match(buildSitemap(DEFAULT_SETTINGS, posts, 'https://x.com'), /<loc>https:\/\/x\.com\/weibo<\/loc>/)
  assert.match(
    buildSitemap({ ...DEFAULT_SETTINGS, siteMode: 'weibo' }, posts, 'https://x.com'),
    /<loc>https:\/\/x\.com\/weibo<\/loc>/
  )
  assert.doesNotMatch(
    buildSitemap({ ...DEFAULT_SETTINGS, siteMode: 'blog' }, posts, 'https://x.com'),
    /\/weibo</
  )
})

// ── 页脚链接组：导航下线微博入口时页脚同步口径（各主题 FOOT_LINKS 经 footLinks 收口）──

test('footLinks：纯博客剥掉 /weibo 链接，其余模式原样保留', () => {
  const links = '<a href="/weibo">微博</a><a href="/rss.xml">RSS</a><a href="/admin">管理</a>'
  assert.equal(footLinks({ siteMode: 'blog' }, links), '<a href="/rss.xml">RSS</a><a href="/admin">管理</a>')
  // journal 主题的「随手记」同样按 href 剥
  assert.equal(footLinks({ siteMode: 'blog' }, '<a href="/weibo">随手记</a><a href="/links">友链</a>'), '<a href="/links">友链</a>')
  for (const m of ['blog-weibo', 'weibo-blog', 'weibo'] as SiteMode[]) {
    assert.equal(footLinks({ siteMode: m }, links), links, m)
  }
  // 脏值回退 blog-weibo → 不剥
  assert.equal(footLinks({}, links), links)
})
