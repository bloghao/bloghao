import { test } from 'node:test'
import assert from 'node:assert/strict'
import { DatabaseSync, type StatementSync } from 'node:sqlite'
import { getSettings, saveSettings } from '../src/db.ts'
import { PAGE_CACHE_EPOCH_KEY } from '../src/db.ts'
import { pageCacheKeyFor, purgePageCache } from '../src/pagecache.ts'

// ── 页面边缘缓存（src/pagecache.ts）：键判定纯函数 + saveSettings 自动换代 ──
// 防线核心：登录 Cookie（管理员/会员/文章解锁）绝不进缓存——键判错就是「把 A 的页面发给 B」
// 级别的越权事故；query 走受控白名单且规范化必须镜像服务端 clamp/trim/slice 语义——镜像错位
// 同样是把错页发给访客；epoch 进键是失效机制的根。

const SESSION = 'bloghao_session'
const MEMBER = 'xw_member_session'
const PP = 'bloghao_pp'

function keyOf(over: Partial<Parameters<typeof pageCacheKeyFor>[0]> = {}) {
  return pageCacheKeyFor({
    method: 'GET',
    url: 'https://x.test/',
    cookie: '',
    demo: false,
    grayscale: false,
    epoch: '100',
    ...over,
  })
}

test('pageCacheKeyFor：可缓存页面返回带 epoch 的键', () => {
  for (const p of ['/', '/post/hello', '/tag/abc', '/category/x', '/page/y', '/about', '/archives', '/guestbook', '/weibo', '/links', '/member', '/rank']) {
    const k = keyOf({ url: `https://x.test${p}` })
    assert.ok(k, `公开页 ${p} 必须可缓存`)
    assert.ok(k!.includes('/100/'), '键必须带 epoch 段')
  }
  assert.equal(keyOf({ url: 'https://x.test/post/hello?_r=123' }), null, '未知参数不缓存（评论刷新旁路依赖这条）')
  assert.equal(keyOf({ url: 'https://x.test/go?u=x' }), null)
  assert.equal(keyOf({ url: 'https://x.test/images/u/a.png' }), null, '图床路由有自己的 immutable 缓存')
  assert.equal(keyOf({ url: 'https://x.test/admin/' }), null)
  assert.equal(keyOf({ url: 'https://x.test/random' }), null, '/random 每次随机不缓存')
  assert.equal(keyOf({ url: 'https://x.test/post/../etc' }), null, '路径穿越形态不匹配白名单')
})

test('pageCacheKeyFor：受控 query 进键——weibo 分页/深链、标签页、搜索页（P0-2）', () => {
  const wbPage = keyOf({ url: 'https://x.test/weibo?page=2' })
  assert.ok(wbPage && wbPage.includes('page=2'), '/weibo?page=2 必须可缓存（TG/朋友圈深链是爬虫放大器）')
  const wbDeep = keyOf({ url: 'https://x.test/weibo?wb=123&topic=%E6%97%A5%E5%B8%B8' })
  assert.ok(wbDeep && wbDeep.includes('wb=123') && wbDeep.includes('topic='), '深链 ?wb= 必须可缓存')
  assert.equal(
    keyOf({ url: 'https://x.test/weibo?wb=123&topic=x' }),
    keyOf({ url: 'https://x.test/weibo?topic=x&wb=123' }),
    '参数序不影响键（规范化排序）'
  )
  assert.ok(keyOf({ url: 'https://x.test/tag/life?page=3' }), '标签页翻页可缓存')
  const s = keyOf({ url: 'https://x.test/search?q=%E5%8D%9A%E5%AE%A2' })
  assert.ok(s && s.includes('q='), '搜索页可缓存且键含 q')
  assert.ok(keyOf({ url: 'https://x.test/search?q=%E5%8D%9A%E5%AE%A2&sort=views' }), '搜索页 + 有效排序可缓存')
})

test('pageCacheKeyFor：键规范化镜像服务端 clamp/trim 语义（同渲染结果同键）', () => {
  assert.equal(keyOf({ url: 'https://x.test/?page=abc' }), keyOf({ url: 'https://x.test/' }), '非法 page 服务端按没传处理')
  assert.equal(keyOf({ url: 'https://x.test/?page=99999' }), keyOf({ url: 'https://x.test/?page=1000' }), '越界 page 服务端夹到 1000')
  assert.equal(keyOf({ url: 'https://x.test/weibo?wb=x' }), keyOf({ url: 'https://x.test/weibo' }), '非法 wb 服务端忽略')
  assert.equal(keyOf({ url: 'https://x.test/search?q=%20%20' }), keyOf({ url: 'https://x.test/search' }), '空白 q 服务端按没传处理')
  assert.equal(keyOf({ url: 'https://x.test/api/public/weibo?limit=abc' }), keyOf({ url: 'https://x.test/api/public/weibo' }), '非法 limit 按没传')
})

test('pageCacheKeyFor：不可缓存形态回源（宁缺勿错）', () => {
  assert.equal(keyOf({ url: 'https://x.test/search?q=x&sort=random' }), null, '随机排序 seed 现生成，同 URL 两次结果不同')
  assert.equal(keyOf({ url: 'https://x.test/?page=1&page=2' }), null, '重复参数语义含糊')
  assert.equal(keyOf({ url: 'https://x.test/api/public/posts?tag=' + encodeURIComponent('x'.repeat(65)) }), null, '超长 tag 回源')
})

test('pageCacheKeyFor：订阅源与公开只读 API 纳入（P0-2）', () => {
  for (const p of ['/rss.xml', '/feed.json', '/sitemap.xml', '/feed/rss.xml', '/atom.xml']) {
    assert.ok(keyOf({ url: `https://x.test${p}` }), `${p} 必须可缓存（爬虫订阅器高频）`)
  }
  assert.ok(keyOf({ url: 'https://x.test/api/public/weibo?limit=50' }), '公开微博 API 可缓存（广场 hub pull 源）')
  assert.ok(keyOf({ url: 'https://x.test/api/public/posts?tag=%E7%94%9F%E6%B4%BB' }), '公开文章 API + tag 可缓存')
  assert.equal(keyOf({ url: 'https://x.test/api/public/weibo?foo=1' }), null, '未知参数回源')
  assert.equal(keyOf({ url: 'https://x.test/api/admin/stats' }), null, '管理 API 永不缓存')
  assert.equal(keyOf({ url: 'https://x.test/api/public/track' }), null, 'visit 统计端点不缓存')
})

test('pageCacheKeyFor：键带 hostname（多域名形态不串副本）', () => {
  assert.notEqual(keyOf({ url: 'https://a.test/' }), keyOf({ url: 'https://b.test/' }))
})

test('pageCacheKeyFor：任一登录/解锁 Cookie 在场绝不缓存（越权面）', () => {
  assert.equal(keyOf({ cookie: `${SESSION}=abc` }), null, '管理员会话在，页面里有管理按钮')
  assert.equal(keyOf({ cookie: `foo=1; ${SESSION}=abc` }), null, '多 Cookie 混合同样拦')
  assert.equal(keyOf({ cookie: `${MEMBER}=xyz` }), null, '会员会话在，页面里有会员表单')
  assert.equal(keyOf({ cookie: `${PP}=tok` }), null, '文章解锁令牌在，正文可能已解锁')
})

test('pageCacheKeyFor：演示站 / 灰度 / 非 GET 一律不缓存', () => {
  assert.equal(keyOf({ demo: true }), null)
  assert.equal(keyOf({ grayscale: true }), null, '灰度是整站去色特殊状态')
  assert.equal(keyOf({ method: 'HEAD' }), null)
  assert.equal(keyOf({ method: 'POST' }), null)
})

test('pageCacheKeyFor：epoch 变化 = 键变化（失效机制的根）', () => {
  const a = keyOf({ epoch: '100' })
  const b = keyOf({ epoch: '200' })
  assert.notEqual(a, b)
  assert.ok(a && b)
})

// ── node:sqlite 实库：saveSettings 自动换代 + purgePageCache ──

function d1FromSqlite(db: DatabaseSync): D1Database {
  const cache = new Map<string, StatementSync>()
  const stmtOf = (sql: string) => {
    let st = cache.get(sql)
    if (!st) cache.set(sql, (st = db.prepare(sql)))
    return st
  }
  const handlers = (sql: string, binds: unknown[]) => ({
    run: async () => {
      stmtOf(sql).run(...(binds as never[]))
      return { success: true }
    },
    all: async <T>() => ({ results: stmtOf(sql).all(...(binds as never[])) as T[] }),
    first: async <T>() => ((stmtOf(sql).get(...(binds as never[])) as T | undefined) ?? null),
  })
  return {
    prepare: (sql: string) => {
      const unbound = handlers(sql, [])
      return { ...unbound, bind: (...binds: unknown[]) => handlers(sql, binds) }
    },
    batch: async (stmts: { run: () => Promise<unknown> }[]) => {
      for (const s of stmts) await s.run()
      return []
    },
  } as unknown as D1Database
}

function sqliteWithSettings(): DatabaseSync {
  const db = new DatabaseSync(':memory:')
  db.exec("CREATE TABLE settings (key TEXT PRIMARY KEY, value TEXT NOT NULL DEFAULT '')")
  return db
}

test('saveSettings：每次保存自动推进 pageCacheEpoch（改设置 = 页面缓存整代作废）', async () => {
  const db = sqliteWithSettings()
  const d1 = d1FromSqlite(db)

  await saveSettings(d1, { siteTitle: 'A' })
  const e1 = (await getSettings(d1))[PAGE_CACHE_EPOCH_KEY]
  assert.ok(e1 && e1 !== '', '首次保存要落一个非空 epoch')

  await saveSettings(d1, { footerText: 'B' })
  const e2 = (await getSettings(d1))[PAGE_CACHE_EPOCH_KEY]
  assert.ok(Number(e2) > Number(e1), '第二次保存必须推进 epoch（单调时间戳）')

  await saveSettings(d1, { [PAGE_CACHE_EPOCH_KEY]: '12345', siteTitle: 'C' })
  const e3 = (await getSettings(d1))[PAGE_CACHE_EPOCH_KEY]
  assert.equal(e3, '12345', '显式带 epoch 的保存（purgePageCache）不覆盖调用方的值')
})

test('purgePageCache：显式换 epoch，其他设置原样保留', async () => {
  const db = sqliteWithSettings()
  const d1 = d1FromSqlite(db)
  await saveSettings(d1, { siteTitle: '我的站' })
  const before = await getSettings(d1)

  await purgePageCache(d1)
  const after = await getSettings(d1)
  assert.equal(after.siteTitle, '我的站', '清理只换代不动内容')
  assert.ok(Number(after[PAGE_CACHE_EPOCH_KEY]) > Number(before[PAGE_CACHE_EPOCH_KEY]), 'epoch 必须推进')
})

// ── 图床边缘缓存（/images/* 专用）：键判定与回填判据 ──
// 防线核心：键内容寻址（saveUpload 同键永不覆盖）所以无 epoch 永久缓存是安全的；404 /
// 异常响应绝不回填（防负缓存把「图不存在」钉死 1 年）；query 不进键（/images 不读 query）。

test('imageCacheKeyFor：host+pathname 进键，query 剥离，非法 URL 返回 null', async () => {
  const { imageCacheKeyFor } = await import('../src/pagecache.ts')
  assert.equal(
    imageCacheKeyFor('https://blog.x.com/images/u/202610/abc.png'),
    'https://xwblog-internal.invalid/__img/blog.x.com/images/u/202610/abc.png',
  )
  assert.equal(
    // query 不进键：/images 路由不读 query，?v= 的破缓存参数拿到的也是同一份字节
    imageCacheKeyFor('https://blog.x.com/images/u/202610/abc.png?v=2'),
    'https://xwblog-internal.invalid/__img/blog.x.com/images/u/202610/abc.png',
  )
  assert.equal(imageCacheKeyFor('not a url'), null)
})

test('isImageStorable：只回填 200 的图片/视频，404 与带 Set-Cookie 的响应拒绝', async () => {
  const { isImageStorable } = await import('../src/pagecache.ts')
  const img = (init: { status?: number; type?: string; setCookie?: boolean } = {}) =>
    new Response('x', {
      status: init.status ?? 200,
      headers: {
        'content-type': init.type ?? 'image/png',
        ...(init.setCookie ? { 'set-cookie': 'a=b' } : {}),
      },
    })
  assert.ok(isImageStorable(img()), '200 图片要回填')
  assert.ok(isImageStorable(img({ type: 'video/mp4' })), '200 视频要回填（封面帧与微博视频都在图床）')
  assert.ok(isImageStorable(img({ type: 'image/x-icon; charset=binary' })), '带参数的 mime 取分号前段')
  assert.ok(!isImageStorable(img({ status: 404 })), '404 不回填（防负缓存）')
  assert.ok(!isImageStorable(img({ setCookie: true })), '带 Set-Cookie 不回填')
  assert.ok(!isImageStorable(img({ type: 'application/octet-stream' })), '无 contentType 兜底不回填')
  assert.ok(!isImageStorable(img({ type: 'text/html' })), 'HTML 不回填')
})
