import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  generatePlazaToken,
  hmacHex,
  parseRssItems,
  rssDateToMs,
  scoreFeed,
  scorePlazaItem,
  validateIngest,
  verifyPlazaSignature,
  SIGNATURE_TTL_MS,
  INGEST_MAX_ITEMS,
  type PlazaItem,
} from '../plaza/src/core.ts'
import { plazaSign } from '../src/hooks.ts'

// ── 广场 hub（roadmap B17）：签名双端镜像 / ingest 校验 / 混排评分 / RSS 解析 ──

test('签名双端镜像：博客端 plazaSign 与 hub 校验端同一算法', async () => {
  const token = 'a'.repeat(32)
  const ts = String(Date.now())
  const raw = JSON.stringify({ items: [{ kind: 'post', ref: 'hello' }] })
  const fromPlugin = await plazaSign(token, ts, raw)
  const fromHub = await hmacHex(token, `${ts}.${raw}`)
  assert.equal(fromPlugin, fromHub)
  assert.match(fromPlugin, /^[0-9a-f]{64}$/)
  // hub 校验端：真签名过，篡改 body / 错 token / 超窗都拒
  assert.equal(await verifyPlazaSignature(token, ts, fromPlugin, raw), true)
  assert.equal(await verifyPlazaSignature(token, ts, fromPlugin, raw + ' '), false)
  assert.equal(await verifyPlazaSignature('b'.repeat(32), ts, fromPlugin, raw), false)
  assert.equal(
    await verifyPlazaSignature(token, ts, fromPlugin, raw, Date.now() + SIGNATURE_TTL_MS + 1000),
    false
  )
  // 时钟偏差在窗口内放行
  assert.equal(
    await verifyPlazaSignature(token, ts, fromPlugin, raw, Date.now() - SIGNATURE_TTL_MS + 1000),
    true
  )
  // 畸形签名直接拒（长度/字符集不过关不进 HMAC 比较）
  assert.equal(await verifyPlazaSignature(token, ts, 'deadbeef', raw), false)
  assert.equal(await verifyPlazaSignature(token, 'not-a-number', fromPlugin, raw), false)
})

test('generatePlazaToken：32 hex 字符', () => {
  const t = generatePlazaToken()
  assert.match(t, /^[0-9a-f]{32}$/)
  assert.notEqual(t, generatePlazaToken())
})

test('validateIngest：形状不对按没传处理，上限截断，url 只收 https', () => {
  const good: PlazaItem = {
    kind: 'post',
    ref: 'hello-world',
    title: '你好',
    summary: '摘要',
    url: 'https://blog.example.com/post/hello-world',
    image: '',
    publishedAt: 1700000000000,
  }
  const r = validateIngest({ items: [good], deleted: [{ kind: 'weibo', ref: '12' }] })
  assert.deepEqual(r.items, [good])
  assert.deepEqual(r.deleted, [{ kind: 'weibo', ref: '12' }])

  // 非法混入：http 拒收、缺 ref/kind 丢条、时间缺失兜底为 now、脏类型整体忽略
  const dirty = validateIngest({
    items: [
      { kind: 'post', ref: 'a', url: 'http://insecure.com/a', title: 'x' },
      { kind: 'post', ref: '', url: 'https://x.com/post/a' },
      { kind: 'page', ref: 'b', url: 'https://x.com/page/b' },
      { kind: 'weibo', ref: 'c', url: 'https://x.com/weibo#c' },
      'not-an-object',
      null,
    ],
    deleted: [{ kind: 'post' }, 'junk'],
  })
  assert.equal(dirty.items.length, 1)
  assert.equal(dirty.items[0].kind, 'weibo')
  assert.ok(dirty.items[0].publishedAt > 0)
  assert.deepEqual(dirty.deleted, [])

  // 完全不是对象 / 空 body：不抛错，返回空
  assert.deepEqual(validateIngest(null).items, [])
  assert.deepEqual(validateIngest('junk').items, [])
  assert.deepEqual(validateIngest({}).items, [])

  // 上限截断
  const many = Array.from({ length: INGEST_MAX_ITEMS + 10 }, (_, i) => ({
    kind: 'post',
    ref: `p${i}`,
    url: `https://x.com/post/p${i}`,
  }))
  assert.equal(validateIngest({ items: many }).items.length, INGEST_MAX_ITEMS)

  // title 缺省回退 summary 截断，超长字段截断
  const long = validateIngest({
    items: [{ kind: 'post', ref: 'r', url: 'https://x.com/post/r', summary: '标'.repeat(600) }],
  })
  assert.equal(long.items[0].title, '标'.repeat(200))
  assert.equal(long.items[0].summary.length, 500)
})

test('混排评分：新文衰减 + 权重加成 + 随机抖动，无单一因素一票定序', () => {
  const now = 1_800_000_000_000
  const rand = () => 0 // 固定随机：分离确定性成分
  // 刚发布：recency≈1；0 档权重无加成，10 档封顶 +0.5
  const fresh = scorePlazaItem({ publishedAt: now }, 0, { now, rand })
  const freshW1 = scorePlazaItem({ publishedAt: now }, 1, { now, rand })
  const freshW10 = scorePlazaItem({ publishedAt: now }, 10, { now, rand })
  assert.ok(fresh > 0.99 && fresh < 1.01)
  assert.ok(freshW1 > fresh) // 每档 +0.05 线性加成
  assert.ok(freshW10 > freshW1)
  // 一月龄衰减但不归零：recency = 1/(1+15) ≈ 0.0625，权重 0 档无加成
  const old = scorePlazaItem({ publishedAt: now - 30 * 86_400_000 }, 0, { now, rand })
  assert.ok(old > 0.06 && old < 0.065)
  // 随机抖动量纲 0~0.3：同输入两次调用允许换序
  const a = scorePlazaItem({ publishedAt: now }, 1, { now })
  const b = scorePlazaItem({ publishedAt: now }, 1, { now })
  assert.ok(Math.max(a, b) - Math.min(a, b) <= 0.3)
  // 权重脏值：负数与超 10 都收口，0 档无加成
  assert.equal(scorePlazaItem({ publishedAt: now }, 99, { now, rand }), freshW10)
  assert.equal(scorePlazaItem({ publishedAt: now }, -5, { now, rand }), fresh)
})

test('scoreFeed：按分排序、limit 收口、出参带站点信息', () => {
  const now = 1_800_000_000_000
  const mk = (ref: string, ageDays: number) => ({
    item: {
      kind: 'post' as const,
      ref,
      title: ref,
      summary: '',
      url: `https://x.com/post/${ref}`,
      image: '',
      publishedAt: now - ageDays * 86_400_000,
    },
    siteId: 1,
    siteName: '示例站',
    siteUrl: 'https://x.com',
    siteVerified: true,
    siteWeight: 1,
  })
  const feed = scoreFeed([mk('old', 30), mk('new', 0), mk('mid', 3)], 2, { now, rand: () => 0 })
  assert.equal(feed.length, 2)
  assert.equal(feed[0].ref, 'new')
  assert.equal(feed[0].siteName, '示例站')
  assert.equal(feed[0].siteVerified, true)
  assert.ok(feed[0].score >= feed[1].score)
  // limit 收口 1-100
  assert.equal(scoreFeed([mk('x', 0)], 999, { now, rand: () => 0 }).length, 1)
  assert.equal(scoreFeed([], 10).length, 0)
})

test('feed 路由接线：SQL 扁平行必须按 { item, … } 契约包一层再进 scoreFeed（路由曾直接展开喂入必 500）', async () => {
  // 守法与 index.ts /api/feed 同款：SQL 行 → 组装 → scoreFeed；直接 {...r, siteVerified} 会在
  // scoreFeed 内 c.item.kind 处抛 TypeError（tests 只能测 core 纯函数，此处镜像接线口径）
  const { scoreFeed: fn } = await import('../plaza/src/core.ts')
  const row = {
    kind: 'post' as const,
    ref: 'wired',
    title: '接线正确',
    summary: '',
    url: 'https://x.com/post/wired',
    image: '',
    publishedAt: 1_800_000_000_000,
    siteId: 1,
    siteName: '示例站',
    siteUrl: 'https://x.com',
    siteVerified: 1,
    siteWeight: 2,
  }
  const feed = fn(
    [row].map((r) => ({
      item: { kind: r.kind, ref: r.ref, title: r.title, summary: r.summary, url: r.url, image: r.image, publishedAt: r.publishedAt },
      siteId: r.siteId,
      siteName: r.siteName,
      siteUrl: r.siteUrl,
      siteVerified: r.siteVerified === 1,
      siteWeight: r.siteWeight,
    })),
    30,
    { now: 1_800_000_000_000, rand: () => 0 }
  )
  assert.equal(feed.length, 1)
  assert.equal(feed[0].kind, 'post')
  assert.equal(feed[0].siteVerified, true)
  assert.ok(feed[0].score > 0)
})

test('parseRssItems：RSS2 CDATA / Atom href 兜底 / 非 http link 丢弃', () => {
  const xml = `<?xml version="1.0"?>
<rss version="2.0"><channel>
  <item>
    <title>第一篇 &lt;带转义&gt;</title>
    <link>https://a.com/post/first</link>
    <pubDate>Wed, 08 Oct 2026 02:00:00 GMT</pubDate>
    <description><![CDATA[<p>HTML 摘要</p>]]></description>
  </item>
  <item>
    <title>第二篇</title>
    <link>https://a.com/post/second</link>
    <description>纯文本</description>
  </item>
  <item><link>javascript:alert(1)</link></item>
</channel></rss>`
  const items = parseRssItems(xml)
  assert.equal(items.length, 2)
  assert.equal(items[0].link, 'https://a.com/post/first')
  // 实体按原样返回（渲染端 esc/textContent 处理，hub 不做净化）——CDATA 则剥壳
  assert.equal(items[0].title, '第一篇 &lt;带转义&gt;')
  assert.equal(items[0].description, '<p>HTML 摘要</p>')
  assert.match(items[0].pubDate, /GMT/)

  const atom = `<feed xmlns="http://www.w3.org/2005/Atom">
    <entry><title>Atom 文</title><link rel="alternate" href="https://b.com/post/atom"/><updated>2026-10-09T10:00:00Z</updated></entry>
  </feed>`
  const a = parseRssItems(atom)
  assert.equal(a.length, 1)
  assert.equal(a[0].link, 'https://b.com/post/atom')
  assert.equal(a[0].pubDate, '2026-10-09T10:00:00Z')
  // 锁标志解析（src/rss.ts 的 bloghao:locked）：pull 路据此跳过锁文/密码文
  const lockedXml = `<?xml version="1.0"?>
<rss version="2.0" xmlns:bloghao="https://bloghao.com/plaza-ns"><channel>
  <item><title>锁文</title><link>https://a.com/post/locked</link><bloghao:locked>1</bloghao:locked><description>x</description></item>
  <item><title>公开文</title><link>https://a.com/post/open</link><description>y</description></item>
</channel></rss>`
  const li = parseRssItems(lockedXml)
  assert.equal(li.length, 2)
  assert.equal(li[0].locked, true)
  assert.equal(li[1].locked, false)
  assert.equal(parseRssItems('not xml at all').length, 0)
})

test('rssDateToMs：RFC822 与 ISO8601 都能吃，垃圾回退 now', () => {
  const now = 1_800_000_000_000
  assert.equal(rssDateToMs('Wed, 08 Oct 2026 02:00:00 GMT'), Date.parse('Wed, 08 Oct 2026 02:00:00 GMT'))
  assert.equal(rssDateToMs('2026-10-09T10:00:00Z'), Date.parse('2026-10-09T10:00:00Z'))
  assert.equal(rssDateToMs('昨天', now), now)
  assert.equal(rssDateToMs('', now), now)
})

test('statsDay：北京日口径（+8h 取 UTC 分量，0-8 点不算前一天）', async () => {
  const { statsDay } = await import('../plaza/src/core.ts')
  // 2026-10-11 02:00 +08:00 = 前一日 18:00 UTC —— 北京日应为 10-11 而非 10-10
  assert.equal(statsDay(Date.UTC(2026, 9, 10, 18, 0, 0)), '2026-10-11')
  assert.equal(statsDay(Date.UTC(2026, 9, 10, 15, 59, 0)), '2026-10-10')
  assert.equal(statsDay(Date.UTC(2026, 9, 10, 16, 0, 0)), '2026-10-11')
  assert.match(statsDay(), /^\d{4}-\d{2}-\d{2}$/)
})

test('validateIngest：顶层 avatar 白名单（https 才收、超长截断、非字符串忽略）', async () => {
  const { validateIngest } = await import('../plaza/src/core.ts')
  const base = { items: [{ kind: 'post', ref: 'a', url: 'https://x.test/p' }] }
  assert.equal(validateIngest({ ...base, avatar: 'https://x.test/a.png' }).avatar, 'https://x.test/a.png')
  assert.equal(validateIngest({ ...base, avatar: 'http://x.test/a.png' }).avatar, '')
  assert.equal(validateIngest({ ...base, avatar: 'javascript:alert(1)' }).avatar, '')
  assert.equal(validateIngest({ ...base, avatar: 123 }).avatar, '')
  assert.equal(validateIngest(base).avatar, '')
  assert.equal(validateIngest({ ...base, avatar: 'https://' + 'a'.repeat(600) + '.png' }).avatar.length, 500)
})

test('normalizePulledWeibo：微博补漏条目规整——https 校验、30 天窗口、字段截断、垃圾丢弃', async () => {
  const { normalizePulledWeibo } = await import('../plaza/src/core.ts')
  const now = 1_800_000_000_000
  const ok = normalizePulledWeibo(
    { ref: '7001', title: '真微博', summary: '<b>正文</b>', url: 'https://x.test/weibo#wb-7001', publishedAt: now - 1000, image: 'https://x.test/images/a.jpg' },
    now
  )
  assert.deepEqual(ok, {
    kind: 'weibo',
    ref: '7001',
    title: '真微博',
    summary: '正文',
    url: 'https://x.test/weibo#wb-7001',
    image: 'https://x.test/images/a.jpg',
    publishedAt: now - 1000,
  })
  // http url 拒收（防 pull 变成任意 URL 注入面）；缺 ref / 缺 title 丢弃
  assert.equal(normalizePulledWeibo({ ref: '1', title: 't', url: 'http://x.test/w' }, now), null)
  assert.equal(normalizePulledWeibo({ title: 't', url: 'https://x.test/w' }, now), null)
  assert.equal(normalizePulledWeibo({ ref: '1', url: 'https://x.test/w' }, now), null)
  // 超 30 天丢弃（与 RSS 补漏窗口同口径）；publishedAt 缺失/畸形回退 now
  assert.equal(normalizePulledWeibo({ ref: '1', title: 't', url: 'https://x.test/w', publishedAt: now - 31 * 86_400_000 }, now), null)
  assert.equal(normalizePulledWeibo({ ref: '1', title: 't', url: 'https://x.test/w' }, now)?.publishedAt, now)
  assert.equal(normalizePulledWeibo({ ref: '1', title: 't', url: 'https://x.test/w', publishedAt: '垃圾' }, now)?.publishedAt, now)
  // image 非 https 丢弃；各字段超长截断（200/200/500）
  assert.equal(normalizePulledWeibo({ ref: '1', title: 't', url: 'https://x.test/w', image: 'javascript:alert(1)' }, now)?.image, '')
  const long = normalizePulledWeibo({ ref: 'x'.repeat(300), title: 't'.repeat(300), summary: 's'.repeat(900), url: 'https://x.test/w' }, now)
  assert.equal(long?.ref.length, 200)
  assert.equal(long?.title.length, 200)
  assert.equal(long?.summary.length, 500)
})
