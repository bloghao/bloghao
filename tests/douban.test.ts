import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  buildCardHtml,
  coverProxyHostOk,
  coverReferer,
  doubanDetailUrl,
  fetchDoubanDetail,
  normalizeCoverUrl,
  parseDoubanSuggest,
  parseDeezer,
  parseNetEase,
  parseGoogleBooks,
  parseItunes,
  parseSubjectHtml,
  parseTmdb,
  probeRelay,
  resolveCardCover,
  sanitizeMediaItem,
  searchMedia,
  subjectIdFromUrl,
  validateRelay,
  type MediaItem,
} from '../src/douban.ts'
import { sanitizeHtml } from '../src/sanitize.ts'

/* ── 豆瓣链接与地址构造 ── */

test('subjectIdFromUrl 只认豆瓣 subject 数字 id', () => {
  assert.equal(subjectIdFromUrl('https://book.douban.com/subject/2567698/'), '2567698')
  assert.equal(subjectIdFromUrl('https://movie.douban.com/subject/26266893/?suggest=x'), '26266893')
  assert.equal(subjectIdFromUrl('https://music.douban.com/subject/1394645/'), '1394645')
  assert.equal(subjectIdFromUrl('https://www.douban.com/people/abc/status/123'), null)
  assert.equal(subjectIdFromUrl('https://evil.com/subject/2567698/'), null)
  assert.equal(subjectIdFromUrl(''), null)
  // 混淆字符先剥离再匹配
  assert.equal(subjectIdFromUrl('https://book.douban.com/subject/2567698\n/'), '2567698')
})

test('doubanDetailUrl 三类条目域与代码重组（不接受外部传入 URL）', () => {
  assert.equal(doubanDetailUrl('book', '2567698'), 'https://book.douban.com/subject/2567698/')
  assert.equal(doubanDetailUrl('movie', '26266893'), 'https://movie.douban.com/subject/26266893/')
  assert.equal(doubanDetailUrl('music', '1394645'), 'https://music.douban.com/subject/1394645/')
})

/* ── 中转配置校验（SSRF 防线） ── */

test('validateRelay 只收 https 公网地址 + 非空令牌', () => {
  const ok = validateRelay('https://relay.example.com:8443/api', ' tok ')
  assert.ok(ok)
  assert.equal(ok.base, 'https://relay.example.com:8443/api')
  assert.equal(ok.token, 'tok')
  assert.equal(validateRelay('http://relay.example.com', 'tok'), null) // 明文 http 拒绝（token 不能裸奔）
  assert.equal(validateRelay('https://127.0.0.1', 'tok'), null) // 私网拒绝
  assert.equal(validateRelay('https://10.0.0.5', 'tok'), null)
  assert.equal(validateRelay('https://relay.example.com', ''), null) // 空令牌拒绝
  assert.equal(validateRelay('https://relay.example.com', 'tok\r\nset-cookie: x'), null) // 头注入拒绝
})

/* ── 豆瓣搜索联想解析（两种返回形状） ── */

test('parseDoubanSuggest 电影形状：img/url/type=movie', () => {
  const items = parseDoubanSuggest(
    'movie',
    JSON.stringify([
      {
        episode: '',
        img: 'https://img3.doubanio.com/view/photo/s_ratio_poster/public/p2545472803.jpg',
        title: '流浪地球',
        url: 'https://movie.douban.com/subject/26266893/?suggest=%E6%B5%81%E6%B5%AA%E5%9C%B0%E7%90%83',
        type: 'movie',
        year: '2019',
        sub_title: '流浪地球',
        id: '26266893',
      },
    ])
  )
  assert.equal(items.length, 1)
  assert.equal(items[0].source, 'douban')
  assert.equal(items[0].id, '26266893')
  assert.equal(items[0].title, '流浪地球')
  assert.equal(items[0].year, '2019')
  assert.equal(items[0].cover, 'https://img3.doubanio.com/view/photo/l_ratio_poster/public/p2545472803.jpg') // s→l 尺寸升级
  assert.equal(items[0].link, 'https://movie.douban.com/subject/26266893/') // 建议 URL 的 query 被剥掉
})

test('parseDoubanSuggest 图书形状：pic/author_name/type=b', () => {
  const items = parseDoubanSuggest(
    'book',
    JSON.stringify([
      { title: '三体', url: 'https://book.douban.com/subject/2567698/', pic: 'https://img3.doubanio.com/view/subject/s/public/s2768378.jpg', author_name: '刘慈欣', year: '2008', type: 'b', id: '2567698' },
    ])
  )
  assert.equal(items.length, 1)
  assert.equal(items[0].meta, '刘慈欣')
  assert.equal(items[0].cover, 'https://img3.doubanio.com/view/subject/l/public/s2768378.jpg')
})

test('parseDoubanSuggest 脏数据全弃（非数字 id / 缺标题 / 坏 JSON）', () => {
  assert.equal(parseDoubanSuggest('book', 'not json').length, 0)
  assert.equal(parseDoubanSuggest('book', '{"a":1}').length, 0)
  assert.equal(
    parseDoubanSuggest(
      'book',
      JSON.stringify([
        { title: 'x', id: 'not-a-number' },
        { title: '', id: '123' },
        null,
      ])
    ).length,
    0
  )
})

/* ── 条目详情页解析（结构化锚点） ── */

const MOVIE_HTML = `<html><head><title>流浪地球 (豆瓣)</title>
<meta property="og:image" content="https://img3.doubanio.com/view/photo/l_ratio_poster/public/p2545472803.jpg" /></head>
<body><div id="content"><h1><span property="v:itemreviewed">流浪地球 The Wandering Earth</span></h1>
<strong class="ll rating_num" property="v:average">7.9</strong>
<span property="v:votes">1234567</span>人评价
<div id="info">
    <span >导演</span>: <span class="attrs"><a>郭帆</a></span><br/>
    <span >编剧</span>: <a>龚格尔</a> / <a>严东旭</a><br/>
    <span >主演</span>: <a>屈楚萧</a> / <a>吴京</a> / <a>李光洁</a><br/>
    <span >类型</span>: 科幻 / 灾难<br/>
    <span >制片国家/地区</span>: 中国大陆<br/>
    <span >上映日期</span>: 2019-02-05(中国大陆)<br/>
</div></div>
<div class="related-info"><div class="intro"><p>太阳即将毁灭，人类在地球表面建造出巨大的推进器，寻找新家园。</p><p>宇宙之路危机四伏。</p></div></div>
</body></html>`

test('parseSubjectHtml 电影：评分/人数/导演主演/年份/简介', () => {
  const item = parseSubjectHtml('movie', MOVIE_HTML, '26266893')
  assert.ok(item)
  assert.equal(item.id, '26266893')
  assert.equal(item.title, '流浪地球 The Wandering Earth')
  assert.equal(item.rating, 7.9)
  assert.equal(item.ratingCount, 1234567)
  assert.equal(item.year, '2019')
  assert.ok((item.meta || '').includes('郭帆'))
  assert.ok((item.meta || '').includes('吴京'))
  assert.ok((item.intro || '').includes('太阳即将毁灭'))
  assert.equal(item.link, 'https://movie.douban.com/subject/26266893/')
})

const BOOK_HTML = `<html><title>三体 (豆瓣)</title><body>
<h1><span property="v:itemreviewed">三体</span></h1>
<strong class="ll rating_num" property="v:average"> 8.9 </strong>
<span property="v:votes">518621</span>
<div id="info">
    <span>
      <span class="pl"> 作者</span>:
        <a href="/author/4561353">刘慈欣</a>
    </span><br/>
    <span class="pl">出版社</span>: <a>重庆出版社</a><br/>
    <span class="pl">出版年</span>: 2008-1<br/>
    <span class="pl">页数</span>: 302<br/>
</div>
<div id="link-report"><div class="intro"><p>文化大革命如火如荼进行的同时，军方探寻外星文明的绝秘计划“红岸工程”取得了突破性进展。</p></div></div>
</body></html>`

test('parseSubjectHtml 图书：og:image 大图、出版年取年份', () => {
  const item = parseSubjectHtml('book', BOOK_HTML, '2567698')
  assert.ok(item)
  assert.equal(item.rating, 8.9)
  assert.equal(item.ratingCount, 518621)
  assert.equal(item.year, '2008')
  assert.ok((item.meta || '').includes('刘慈欣')) // 值在标签名的下一行（真实页面结构）也能抓到
  assert.ok((item.meta || '').includes('重庆出版社'))
  assert.ok((item.meta || '').includes('2008-1'))
  assert.ok(!item.intro!.startsWith('>')) // 开标签必须整体吃掉，不留垃圾前缀
})

test('parseSubjectHtml 评分缺失不炸（未评分条目），无 v:itemreviewed 走 title 兜底', () => {
  const noRating = parseSubjectHtml('book', '<html><title>某书 (豆瓣)</title><body><div id="info"><span>出版社</span>: X<br/></div></body></html>', '1')
  assert.ok(noRating)
  assert.equal(noRating.title, '某书')
  assert.equal(noRating.rating, undefined)
  assert.equal(parseSubjectHtml('book', '<html><body>空白页</body></html>'), null)
})

/* ── 备用源解析 ── */

test('parseGoogleBooks：评分统一到 10 分量纲、http 封面升 https', () => {
  const items = parseGoogleBooks(
    JSON.stringify({
      items: [
        {
          id: 'abc123',
          volumeInfo: {
            title: '三体',
            authors: ['刘慈欣'],
            publisher: '重庆出版社',
            publishedDate: '2008-01-01',
            imageLinks: { thumbnail: 'http://books.google.com/books/content?id=abc&zoom=1' },
            averageRating: 4.5,
            ratingsCount: 120,
            description: '文化大革命如火如荼进行的同时……',
            infoLink: 'https://books.google.com/books?id=abc',
          },
        },
      ],
    })
  )
  assert.equal(items[0].source, 'google')
  assert.equal(items[0].type, 'book')
  assert.equal(items[0].rating, 9)
  assert.equal(items[0].cover?.startsWith('https://'), true)
  assert.equal(items[0].meta, '刘慈欣 / 重庆出版社')
})

test('parseItunes 音乐（专辑）与电影（曲目名/长简介）', () => {
  const music = parseItunes(
    JSON.stringify({
      results: [
        {
          collectionName: '叶惠美',
          artistName: '周杰伦',
          primaryGenreName: 'Mandopop',
          artworkUrl100: 'https://is1-ssl.mzstatic.com/image/thumb/Music/100x100bb.jpg',
          releaseDate: '2003-07-31',
          collectionViewUrl: 'https://music.apple.com/cn/album/x/1',
          collectionId: 1,
        },
      ],
    }),
    'music'
  )
  assert.equal(music[0].title, '叶惠美')
  assert.equal(music[0].meta, '周杰伦 · Mandopop')
  assert.ok(music[0].cover?.includes('600x600bb'))
  const movie = parseItunes(
    JSON.stringify({
      results: [
        { trackName: '流浪地球', artistName: 'Various Artists', longDescription: '简介', artworkUrl100: 'https://is1-ssl.mzstatic.com/a/100x100bb.jpg', releaseDate: '2019-02-05', trackViewUrl: 'https://tv.apple.com/x/2', trackId: 2 },
      ],
    }),
    'movie'
  )
  assert.equal(movie[0].title, '流浪地球')
  assert.equal(movie[0].link, 'https://tv.apple.com/x/2')
})

test('parseTmdb：0-10 评分直读、poster 拼域、original_title 出 meta', () => {
  const items = parseTmdb(
    JSON.stringify({
      results: [{ id: 123, title: '流浪地球', original_title: 'The Wandering Earth', release_date: '2019-02-05', poster_path: '/abc.jpg', vote_average: 7.9, vote_count: 1000, overview: '太阳即将毁灭' }],
    })
  )
  assert.equal(items[0].source, 'tmdb')
  assert.equal(items[0].rating, 7.9)
  assert.equal(items[0].cover, 'https://image.tmdb.org/t/p/w342/abc.jpg')
  assert.equal(items[0].meta, 'The Wandering Earth')
})

/* ── 封面尺寸升级 ── */

test('normalizeCoverUrl 只动 doubanio 域、认得两种小图路径', () => {
  assert.equal(normalizeCoverUrl('https://img3.doubanio.com/view/photo/s_ratio_poster/public/p1.jpg'), 'https://img3.doubanio.com/view/photo/l_ratio_poster/public/p1.jpg')
  assert.equal(normalizeCoverUrl('https://img9.doubanio.com/view/subject/s/public/s2.jpg'), 'https://img9.doubanio.com/view/subject/l/public/s2.jpg')
  assert.equal(normalizeCoverUrl('https://example.com/view/subject/s/public/s2.jpg'), 'https://example.com/view/subject/s/public/s2.jpg') // 外域不动
})

/* ── 搜索编排与回退链（注入 fetch stub） ── */

function okFetch(payload: string | ((url: string) => string | Response)): typeof fetch {
  return (async (input: RequestInfo | URL) => {
    const url = String(input)
    const body = typeof payload === 'function' ? payload(url) : payload
    return body instanceof Response ? body : new Response(body, { status: 200, headers: { 'content-type': 'application/json' } })
  }) as unknown as typeof fetch
}

test('searchMedia 豆瓣命中直接返回（不走备用源）', async () => {
  const seen: string[] = []
  const r = await searchMedia({
    type: 'book',
    q: '三体',
    fetchImpl: (async (input: RequestInfo | URL) => {
      seen.push(String(input))
      return new Response(JSON.stringify([{ title: '三体', id: '2567698', pic: '', url: '', year: '2008' }]), { status: 200 })
    }) as unknown as typeof fetch,
  })
  assert.equal(r.items.length, 1)
  assert.equal(r.doubanBlocked, false)
  assert.equal(seen.length, 1) // 只有豆瓣一次请求
})

test('searchMedia 豆瓣被风控自动落 Google 图书，并如实标记 doubanBlocked', async () => {
  const r = await searchMedia({
    type: 'book',
    q: '三体',
    fetchImpl: okFetch((url) => (url.includes('douban.com') ? new Response('forbidden', { status: 403 }) : JSON.stringify({ items: [{ id: 'x1', volumeInfo: { title: 'The Three-Body Problem' } }] }))) as typeof fetch,
  })
  assert.equal(r.items[0].source, 'google')
  assert.equal(r.doubanBlocked, true)
})

test('parseNetEase：中文曲库相关性（海阔天空第一条即 Beyond）、年份取自发行时间', () => {
  const items = parseNetEase(
    JSON.stringify({
      result: {
        albums: [
          { id: 34209, name: '海阔天空', artist: { name: 'Beyond' }, picUrl: 'https://p1.music.126.net/abc/10995.jpg', publishTime: 747504000000 },
          { id: 38408, name: '海阔天空', artist: { name: '信乐团' }, picUrl: 'https://p2.music.126.net/def/10996.jpg', publishTime: 1077811200000 },
          { id: 999, name: '', artist: { name: 'x' } }, // 缺标题弃
        ],
      },
    })
  )
  assert.equal(items.length, 2)
  assert.equal(items[0].source, 'netease')
  assert.equal(items[0].title, '海阔天空')
  assert.equal(items[0].meta, 'Beyond')
  assert.equal(items[0].year, '1993') // 747504000000 = 1993-09-23 北京时间
  assert.equal(items[0].link, 'https://music.163.com/album?id=34209')
  assert.equal(parseNetEase('not json').length, 0)
})

test('searchMedia 音乐不走豆瓣（接口已下线），网易云优先、Deezer 兜底', async () => {
  const seen: string[] = []
  const r = await searchMedia({
    type: 'music',
    q: '海阔天空',
    fetchImpl: (async (input: RequestInfo | URL) => {
      seen.push(String(input))
      if (String(input).includes('music.163.com')) {
        return new Response(JSON.stringify({ result: { albums: [{ id: 34209, name: '海阔天空', artist: { name: 'Beyond' }, picUrl: 'https://p1.music.126.net/a.jpg', publishTime: 747504000000 }] } }), { status: 200 })
      }
      return new Response(JSON.stringify({ data: [{ id: 9, title: ' Deezer 结果不该出现', artist: { name: 'x' } }] }), { status: 200 })
    }) as unknown as typeof fetch,
  })
  assert.equal(r.items[0].source, 'netease')
  assert.equal(r.items[0].meta, 'Beyond')
  assert.equal(seen.filter((u) => u.includes('douban.com')).length, 0)
})

test('parseDeezer：专辑名 / 歌手 / 大图 / 链接', () => {
  const items = parseDeezer(
    JSON.stringify({
      data: [{ id: 966922721, title: '叶惠美', artist: { name: '周杰伦' }, cover_big: 'https://cdn-images.dzcdn.net/images/cover/x/500x500.jpg', cover_medium: 'https://cdn-images.dzcdn.net/images/cover/x/250x250.jpg', release_date: '2003-07-31', link: 'https://www.deezer.com/album/966922721' }],
    })
  )
  assert.equal(items.length, 1)
  assert.equal(items[0].source, 'deezer')
  assert.equal(items[0].title, '叶惠美')
  assert.equal(items[0].year, '2003')
  assert.equal(items[0].meta, '周杰伦')
  assert.ok(items[0].cover?.includes('500x500'))
  assert.equal(items[0].link, 'https://www.deezer.com/album/966922721')
  assert.equal(parseDeezer('not json').length, 0)
})

test('searchMedia 配了 TMDB key 的电影先 TMDB 后 iTunes', async () => {
  const r = await searchMedia({
    type: 'movie',
    q: '流浪地球',
    tmdbKey: 'a'.repeat(32),
    fetchImpl: okFetch((url) =>
      url.includes('douban.com')
        ? new Response('forbidden', { status: 403 })
        : url.includes('themoviedb.org')
          ? JSON.stringify({ results: [{ id: 1, title: '流浪地球' }] })
          : JSON.stringify({ results: [{ collectionName: ' iTunes 结果不该出现', collectionId: 9 }] })
    ) as typeof fetch,
  })
  assert.equal(r.items[0].source, 'tmdb')
})

test('searchMedia 脏 TMDB key（非 32 位 hex）跳过 TMDB 直接 iTunes', async () => {
  const seen: string[] = []
  await searchMedia({
    type: 'movie',
    q: 'x',
    tmdbKey: "'; drop table --",
    fetchImpl: (async (input: RequestInfo | URL) => {
      seen.push(String(input))
      return new Response(JSON.stringify({ results: [] }), { status: 200 })
    }) as unknown as typeof fetch,
  })
  assert.equal(seen.filter((u) => u.includes('themoviedb')).length, 0)
})

/* ── 详情抓取（含中转路径） ── */

test('fetchDoubanDetail 经中转：200 解析、blocked 透传、404 不算风控', async () => {
  const relay = 'https://relay.example.com'
  const okRes = await fetchDoubanDetail({
    type: 'book',
    id: '2567698',
    relay,
    relayToken: 'tok',
    fetchImpl: okFetch((url) => {
      assert.match(url, /^https:\/\/relay\.example\.com\/api\/fetch\?u=/)
      return JSON.stringify({ status: 200, body: BOOK_HTML, finalUrl: 'https://book.douban.com/subject/2567698/' })
    }) as typeof fetch,
  })
  assert.equal(okRes.item?.title, '三体')
  assert.equal(okRes.blocked, false)

  const blocked = await fetchDoubanDetail({
    type: 'book',
    id: '2567698',
    relay,
    relayToken: 'tok',
    fetchImpl: okFetch(JSON.stringify({ blocked: true })) as typeof fetch,
  })
  assert.equal(blocked.blocked, true)

  const missing = await fetchDoubanDetail({
    type: 'book',
    id: '99999999',
    relay,
    relayToken: 'tok',
    fetchImpl: okFetch(JSON.stringify({ status: 404, body: '' })) as typeof fetch,
  })
  assert.equal(missing.item, null)
  assert.equal(missing.blocked, false) // 条目不存在 ≠ 被风控，插件据此走补卡
})

test('fetchDoubanDetail 条目 id 只认数字', async () => {
  const r = await fetchDoubanDetail({ type: 'book', id: '../../etc/passwd', fetchImpl: okFetch('{"status":200,"body":"x"}') as typeof fetch })
  assert.equal(r.item, null)
  assert.equal(r.blocked, false)
})

test('probeRelay 校验失败 / 健康检查', async () => {
  assert.equal((await probeRelay('http://relay.example.com', 'tok', okFetch('{"ok":true}') as typeof fetch)).ok, false)
  const okProbe = await probeRelay('https://relay.example.com', 'tok', okFetch(JSON.stringify({ ok: true })) as typeof fetch)
  assert.equal(okProbe.ok, true)
})

/* ── 组卡与净化往返（存库路径的生死线） ── */

const CARD_ITEM: MediaItem = {
  source: 'douban',
  type: 'book',
  id: '2567698',
  title: '三体',
  year: '2008',
  cover: 'https://img3.doubanio.com/view/subject/l/public/s2768378.jpg',
  rating: 8.9,
  ratingCount: 518621,
  meta: '刘慈欣 / 重庆出版社',
  intro: '文化大革命如火如荼进行的同时……',
  link: 'https://book.douban.com/subject/2567698/',
}

test('buildCardHtml：结构、评分格式、来源行、尾随空段（封面为站内转存地址）', () => {
  const html = buildCardHtml({ ...CARD_ITEM, cover: '/images/u/cover.jpg' })
  assert.match(html, /^<a class="media-card" data-no-dark="" /)
  assert.match(html, /src="\/images\/u\/cover\.jpg"/)
  assert.match(html, /href="https:\/\/book\.douban\.com\/subject\/2567698\/"/)
  assert.match(html, /rel="noopener noreferrer"/)
  assert.match(html, /★ 8\.9/)
  assert.match(html, /52万人评/)
  assert.match(html, /数据 · 豆瓣读书/)
  assert.ok(html.endsWith('<p><br></p>'))
})

test('buildCardHtml 封面兜底：裸 doubanio 地址必挂防盗链，绝不烘进文章', () => {
  // 豆瓣图床有防盗链：未经 resolveCardCover 归一的裸 doubanio 地址直接省略
  const raw = buildCardHtml(CARD_ITEM)
  assert.ok(!raw.includes('<img'))
  // 站内转存地址与非豆瓣源 CDN（无防盗链）保留
  assert.match(buildCardHtml({ ...CARD_ITEM, cover: '/images/u/c.jpg' }), /<img src="\/images\/u\/c\.jpg"/)
  assert.match(buildCardHtml({ ...CARD_ITEM, cover: 'https://cdn-images.dzcdn.net/images/cover/x/500x500.jpg' }), /<img src="https:\/\/cdn-images\.dzcdn\.net\//)
  assert.match(buildCardHtml({ ...CARD_ITEM, cover: '/images/u/c.jpg', link: undefined }), /^<div class="media-card"/)
})

/* ── 封面解析（转存优先，中转兜底，防盗链死图绝不落库） ── */

test('resolveCardCover：转存成功优先站内地址', () => {
  assert.deepEqual(resolveCardCover('https://img3.doubanio.com/a.jpg', '/images/u/x.jpg', null), { cover: '/images/u/x.jpg', local: true })
  // 已是站内地址原样保留（不再转存）
  assert.deepEqual(resolveCardCover('/images/u/y.jpg', null, null), { cover: '/images/u/y.jpg', local: true })
})

test('resolveCardCover：转存失败时豆瓣退中转或省略，非豆瓣源保留直连', () => {
  // 豆瓣 + 没中转：省略（绝不烘必挂的防盗链死图）
  assert.deepEqual(resolveCardCover('https://img3.doubanio.com/a.jpg', null, null), { cover: '', local: false })
  // 豆瓣 + 中转：退中转 /img 兜底
  const viaRelay = resolveCardCover('https://img3.doubanio.com/a.jpg', null, 'https://relay.example.com')
  assert.equal(viaRelay.cover, 'https://relay.example.com/img?u=https%3A%2F%2Fimg3.doubanio.com%2Fa.jpg')
  assert.equal(viaRelay.local, false)
  // 非豆瓣源 CDN 无防盗链：转存失败保留原直连
  assert.deepEqual(resolveCardCover('https://cdn-images.dzcdn.net/x.jpg', null, null), { cover: 'https://cdn-images.dzcdn.net/x.jpg', local: false })
  assert.deepEqual(resolveCardCover('', null, null), { cover: '', local: true })
})

/* ── 封面 Referer 与缩略图代理白名单 ── */

test('coverReferer：豆瓣图床要豆瓣域 Referer（防盗链），其他源不需要', () => {
  assert.equal(coverReferer('https://img3.doubanio.com/view/subject/l/public/s1.jpg'), 'https://img3.doubanio.com/')
  assert.equal(coverReferer('https://cdn-images.dzcdn.net/x.jpg'), null)
  assert.equal(coverReferer(''), null)
})

test('coverProxyHostOk：缩略图代理只放行常用封面 CDN', () => {
  assert.ok(coverProxyHostOk('img3.doubanio.com'))
  assert.ok(coverProxyHostOk('cdn-images.dzcdn.net'))
  assert.ok(coverProxyHostOk('is1-ssl.mzstatic.com'))
  assert.ok(coverProxyHostOk('image.tmdb.org'))
  assert.ok(coverProxyHostOk('books.google.com'))
  assert.ok(!coverProxyHostOk('evil.com'))
  assert.ok(!coverProxyHostOk('doubanio.com.evil.com'))
  assert.ok(!coverProxyHostOk(''))
})

test('卡片过 sanitizeHtml 白名单：class/style/外链图存活，无 id、无内联事件', () => {
  const dirty: MediaItem = {
    ...CARD_ITEM,
    title: '三体<script>alert(1)</script><img src=x onerror=alert(2)>',
    meta: '作者"><svg onload=alert(3)>',
    intro: '简介 <!-- 注释 --> <a href="javascript:alert(4)">x</a>',
  }
  const cleaned = sanitizeHtml(buildCardHtml({ ...dirty, cover: '/images/u/c.jpg' }))
  // 断言只针对「真实标签 / 真实属性」——转义后的文本里出现 script/onerror 字样是预期形态；
  // 先屏蔽引号属性值再扫标签（alt 里合法地躺着转义后的脏文本，不能算进真实属性）
  const noAttrVals = cleaned.replace(/=("[^"]*"|'[^']*')/g, '=""')
  assert.ok(!/<script/i.test(noAttrVals))
  assert.ok(!/<[a-z]+[^>]*\sonerror/i.test(noAttrVals))
  assert.ok(!/href="javascript:/i.test(noAttrVals))
  assert.ok(!cleaned.includes('<!--'))
  assert.match(cleaned, /class="media-card"/) // class 钩子存活（前台样式可用）
  assert.match(cleaned, /data-no-dark/)
  assert.match(cleaned, /<img src="\/images\/u\/c\.jpg"/) // 站内转存封面存活
  assert.match(cleaned, /三体&lt;script/) // 文本里的标签被实体化而非吞掉
  assert.ok(!cleaned.match(/\sid=/)) // id 恒不放行（DOM clobbering 防线）
  // 转义值的二次复核：escAttr 后 & 均为实体形态
  assert.ok(!cleaned.match(/&(?!(amp|lt|gt|quot|#39);)/))
})

test('sanitizeMediaItem：白名单字段重建，结构外的进不来', () => {
  const good = sanitizeMediaItem(JSON.parse(JSON.stringify(CARD_ITEM)))
  assert.ok(good)
  assert.equal(good.rating, 8.9)
  assert.equal(sanitizeMediaItem({ ...CARD_ITEM, source: 'evil' }), null)
  assert.equal(sanitizeMediaItem({ ...CARD_ITEM, type: 'book"><x>' }), null)
  assert.equal(sanitizeMediaItem({ ...CARD_ITEM, id: 'a b' }), null)
  assert.equal(sanitizeMediaItem({ ...CARD_ITEM, rating: 99 })?.rating, undefined) // 越界评分剥掉
  assert.equal(sanitizeMediaItem({ ...CARD_ITEM, title: '' }), null)
  const clamped = sanitizeMediaItem({ ...CARD_ITEM, cover: 'https://x/'.padEnd(3000, 'a'), intro: '长'.repeat(1000) })
  assert.ok(clamped && clamped.cover && clamped.cover.length <= 2048)
  assert.ok(clamped && clamped.intro && clamped.intro.length <= 600)
})

/* ── clampText 码点安全（不劈 emoji 代理对） ── */

test('卡片文案截断不劈开代理对', () => {
  const item: MediaItem = { ...CARD_ITEM, title: '📚'.repeat(80) }
  const html = buildCardHtml(item)
  assert.ok(html.includes('📚📚📚'))
  assert.ok(!/\uD83C$/.test(html)) // 尾部不应是孤立高位代理
})
