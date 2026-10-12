import { test } from 'node:test'
import assert from 'node:assert/strict'
import { buildJsonFeed, buildRss, buildSitemap } from '../src/rss.ts'
import type { SettingsMap } from '../src/types.ts'

const settings = {
  siteName: '测试站',
  siteDescription: '描述',
  rssFullText: '1',
} as SettingsMap

// ── sitemap（回归：文章上限曾被 listPosts clamp 到 100；分类/标签页缺失；中文 slug 未编码）──
test('sitemap 包含分类/标签页且中文做百分号编码', () => {
  const out = buildSitemap(
    settings,
    [{ slug: 'hello-world', updated_at: Date.UTC(2026, 0, 2) }],
    'https://blog.example.com',
    [{ slug: 'life-notes', name: '生活' }],
    [{ name: '生活随笔', count: 3 }]
  )
  assert.ok(out.includes('<loc>https://blog.example.com/category/life-notes</loc>'), out)
  assert.ok(out.includes('<loc>https://blog.example.com/tag/' + encodeURIComponent('生活随笔') + '</loc>'), out)
  assert.ok(out.includes('<loc>https://blog.example.com/post/hello-world</loc>'), out)
  assert.ok(out.includes('<lastmod>2026-01-02</lastmod>'), out)
})

test('sitemap 文章 slug 里的特殊字符被编码', () => {
  const out = buildSitemap(settings, [{ slug: 'a b', updated_at: 0 }], 'https://x.com')
  assert.ok(out.includes('/post/a%20b'), out)
  assert.ok(!out.includes('/post/a b'), out)
})

// ── RSS（回归防改坏：CDATA 防 ]]> 逃逸、全文开关、绝对链接）──
test('RSS 全文 CDATA 正确处理 ]]>，摘要关闭全文', () => {
  const posts = [
    { slug: 'a', title: 'T', content: '<p>x ]]> y</p>', summary: '摘要', published_at: Date.UTC(2026, 0, 1), updated_at: 0 } as never,
  ]
  const full = buildRss(settings, posts, 'https://x.com')
  assert.ok(full.includes('<content:encoded>'), '全文输出')
  assert.ok(full.includes(']]]]><![CDATA[>'), ']]> 必须被拆分')
  assert.ok(full.includes('<link>https://x.com/post/a</link>'))

  const summaryOnly = buildRss({ ...settings, rssFullText: '0' }, posts, 'https://x.com')
  assert.ok(!summaryOnly.includes('<content:encoded>'))
})

// ── 广场锁标志（bloghao 命名空间）：hub 的 RSS pull 据此跳过锁文/密码文，与 push 路 locked 同口径 ──
test('RSS 锁标志：密码文/会员锁文条目带 <bloghao:locked>，公开文不带', () => {
  const posts = [
    { slug: 'open', title: '公开文', content: '<p>正文</p>', summary: '摘要', published_at: Date.UTC(2026, 0, 1), updated_at: 0 } as never,
    { slug: 'pw', title: '密码文', content: '<p>正文</p>', summary: '', password_hash: 'salt:hash', published_at: Date.UTC(2026, 0, 1), updated_at: 0 } as never,
    { slug: 'tier', title: '会员文', content: '<p>正文</p>', summary: '试读', min_tier: 'coffee', published_at: Date.UTC(2026, 0, 1), updated_at: 0 } as never,
  ]
  const xml = buildRss(settings, posts, 'https://x.com')
  assert.ok(xml.includes('xmlns:bloghao="https://bloghao.com/plaza-ns"'), xml)
  const itemOf = (title: string) => xml.slice(xml.indexOf(`<title>${title}`), xml.indexOf('</item>', xml.indexOf(`<title>${title}`)))
  const pw = itemOf('密码文')
  const tier = itemOf('会员文')
  const open = itemOf('公开文')
  assert.ok(pw.includes('<bloghao:locked>1</bloghao:locked>'), pw)
  assert.ok(tier.includes('<bloghao:locked>1</bloghao:locked>'), tier)
  assert.ok(!open.includes('bloghao:locked'), open)
  assert.ok(!pw.includes('<content:encoded>'), '密码文不出全文（既有防泄漏口径不回归）')
})

// ── 回归（2026-10 安全复查）：XML 1.0 禁止的控制字符曾原样输出，一条脏数据打挂整份 feed ──
test('RSS / sitemap 剥离 XML 非法控制字符（CDATA 内同样非法）', () => {
  const posts = [
    { slug: 'a', title: '标\x07题', content: '<p>正\x01文</p>', summary: '摘\u000B要', published_at: Date.UTC(2026, 0, 1), updated_at: 0 } as never,
  ]
  const xml = buildRss(settings, posts, 'https://x.com')
  assert.ok(!/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/.test(xml), '控制字符必须被剥掉')
  assert.ok(xml.includes('<title>标题</title>'), xml)

})

test('sitemap 的 <loc> 对 siteUrl 本体做 xmlEsc（含 & 的站点地址不再产出非法 XML）', () => {
  const sm = buildSitemap(settings, [{ slug: 'a', updated_at: 0 }], 'https://x.com/?from=a&b=1')
  assert.ok(sm.includes('<loc>https://x.com/?from=a&amp;b=1/</loc>'), sm)
  assert.ok(!sm.includes('<loc>https://x.com/?from=a&b=1/</loc>'), '裸 & 必须被转义')
})

// ── JSON Feed 1.1（/feed.json，C12）：结构、北京时间口径、防泄漏与 RSS 同一份 ──
test('JSON Feed：1.1 结构、slug 编码、tags 解析、isoDate +08:00、相对封面转绝对', () => {
  const out = JSON.parse(
    buildJsonFeed(
      settings,
      [
        {
          slug: 'a b',
          title: '标题',
          content: '<p>正文</p>',
          summary: '摘要',
          tags: '["生活", "测试"]',
          cover: '/images/cover.jpg',
          published_at: Date.UTC(2026, 0, 1, 0, 30), // 北京时间 08:30
          updated_at: Date.UTC(2026, 0, 2),
        } as never,
      ],
      'https://x.com'
    )
  )
  assert.equal(out.version, 'https://jsonfeed.org/version/1.1')
  assert.equal(out.title, '测试站')
  assert.equal(out.feed_url, 'https://x.com/feed.json')
  assert.equal(out.items[0].id, 'https://x.com/post/a%20b')
  assert.equal(out.items[0].content_html, '<p>正文</p>')
  assert.deepEqual(out.items[0].tags, ['生活', '测试'])
  assert.equal(out.items[0].date_published, '2026-01-01T08:30:00+08:00')
  assert.equal(out.items[0].image, 'https://x.com/images/cover.jpg')
})

test('JSON Feed 防泄漏：密码文不出正文只留摘要；会员锁文只出试读段 + 引导', () => {
  const long = '<p>' + '字'.repeat(300) + '</p>'
  const pw = JSON.parse(
    buildJsonFeed(settings, [{ slug: 'a', title: 'T', content: long, summary: '自填摘要', password_hash: 'salt:hash', published_at: 1, updated_at: 1 } as never], 'https://x.com')
  )
  assert.equal(pw.items[0].content_html, undefined, '密码文连试读段都不出（比 RSS 口径更严）')
  assert.equal(pw.items[0].summary, '自填摘要')

  const locked = JSON.parse(
    buildJsonFeed(settings, [{ slug: 'b', title: 'T', content: long, summary: '', min_tier: 'coffee', published_at: 1, updated_at: 1 } as never], 'https://x.com')
  )
  assert.ok(locked.items[0].content_html.includes('会员专属'), '锁文只出试读段 + 引导')
  assert.ok(locked.items[0].content_html.length < long.length, '正文被服务端截断')
})

test('JSON Feed：全文关闭只出摘要；无封面不出 image 键', () => {
  const out = JSON.parse(
    buildJsonFeed({ ...settings, rssFullText: '0' }, [{ slug: 'a', title: 'T', content: '<p>正文</p>', summary: '摘要', cover: '', published_at: 1, updated_at: 1 } as never], 'https://x.com')
  )
  assert.equal(out.items[0].content_html, undefined)
  assert.ok(!('image' in out.items[0]))
})
