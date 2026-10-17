import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { friendLinkCards, weiboCards, weiboComposer, weiboHomeEntry, weiboVideoHtml, type WeiboItemView } from '../src/render.ts'
import { DEFAULT_SETTINGS, parseWeiboVideo, weiboImageList, weiboVideoView } from '../src/db.ts'
import { MAX_UPLOAD_BYTES } from '../src/store.ts'
import { esc } from '../src/utils.ts'

// ── 前台微博卡管理（编辑/置顶/删除）：按钮只在管理员登录时渲染（weiboCards 的 adminName 参数）──
const item: WeiboItemView = {
  id: 42,
  content: '随手记一条',
  images: [],
  created_at: 1759651200000,
  likes: 3,
  commentCount: 1,
}
const base = { settings: DEFAULT_SETTINGS, items: [item], avatarHtml: '<i class="ava"></i>' }

test('访客（不传 adminName）不渲染任何管理按钮', () => {
  const html = weiboCards(base)
  assert.ok(!html.includes('wb-admin'))
  assert.ok(!html.includes('data-wb-act'))
  assert.ok(!html.includes('>编辑<'))
  assert.ok(!html.includes('>删除<'))
})

test('管理员（传 adminName）渲染管理操作：data-wb-admin 带微博 id，编辑/置顶/删除三键', () => {
  const html = weiboCards({ ...base, adminName: '站长' })
  assert.match(html, /data-wb-admin="42"/)
  assert.match(html, /data-wb-act="edit"[\s\S]*?>编辑</)
  assert.match(html, /data-wb-act="pin"[\s\S]*?>置顶</)
  assert.match(html, /data-wb-act="del"[\s\S]*?>删除</)
  // 管理操作仍保留点赞与评论（同一底栏）
  assert.match(html, /like-btn/)
  assert.match(html, /wb-cmt-toggle/)
})

test('已置顶卡片：is-pinned 类 + 「置顶」标签 + 按钮文案为「取消置顶」', () => {
  const html = weiboCards({ ...base, items: [{ ...item, pinned: true }], adminName: '站长' })
  assert.match(html, /wb-card is-pinned/)
  assert.match(html, /<span class="wb-pin">置顶<\/span>/)
  assert.match(html, /data-wb-act="pin"[\s\S]*?>取消置顶</)
})

test('管理按钮的删除键带 is-danger 标记（主题 CSS 据此上危险色）', () => {
  const html = weiboCards({ ...base, adminName: '站长' })
  assert.match(html, /wb-admin-btn is-danger/)
})

test('卡片正文与 id 均经转义：正文 HTML 不逃逸、不破坏 data-wb-admin 属性', () => {
  const html = weiboCards({
    ...base,
    items: [{ ...item, id: 7, content: '<script>alert(1)</script> #" onclick="#' }],
    adminName: '站长',
  })
  assert.ok(!html.includes('<script>'))
  assert.match(html, /data-wb-admin="7"/)
})

// ── 回归（2026-10 安全复查）：读侧 scheme 白名单（备份恢复/手工改库进来的脏 URL 不流进 img/a）──
test('weiboImageList 读侧过滤：只留站内 /images/ 与 http(s) 外链', () => {
  assert.deepEqual(
    weiboImageList({ images: JSON.stringify(['/images/u/a.jpg', 'javascript:alert(1)', 'https://x.com/b.png', 'data:text/html,x', 42]) }),
    ['/images/u/a.jpg', 'https://x.com/b.png']
  )
  assert.deepEqual(weiboImageList({ images: '不是 JSON' }), [])
})

test('friendLinkCards url/icon 过 scheme 白名单，非法时退化为无链接卡片', () => {
  const good = friendLinkCards([{ name: '好站', url: 'https://a.com', description: '', icon: '' }])
  assert.ok(good.includes('href="https://a.com"'))
  const bad = friendLinkCards([{ name: '坏链', url: 'javascript:alert(1)', description: '', icon: 'javascript:alert(2)' }])
  assert.ok(!bad.includes('javascript:'), 'javascript: 不得出现在输出里')
  assert.ok(bad.includes('fl-card'), '内容照常展示')
  assert.ok(bad.includes('fl-ico-letter'), '图标非法时退回字母图标')
})

/* ── 微博视频（B19）：写侧解析 / 读侧过滤 / 渲染 / site.js 镜像守卫 ──
 * 契约：一条微博最多 1 个视频，存 weibo.video 单列 JSON（src/db.ts parseWeiboVideo / weiboVideoView）；
 * 渲染在 render.ts weiboVideoHtml（单行输出），site.js wbVideoHtmlJs 是它的手工 ES5 镜像。 */

test('parseWeiboVideo：站内 /images/ 与 http(s) 放行，非法一律 null，宽高纠偏', () => {
  assert.deepEqual(parseWeiboVideo({ url: '/images/u/202610/a.mp4', poster: '/images/u/202610/a.jpg', w: 1280, h: 720 }), {
    url: '/images/u/202610/a.mp4',
    poster: '/images/u/202610/a.jpg',
    w: 1280,
    h: 720,
  })
  assert.deepEqual(parseWeiboVideo({ url: 'https://cdn.example.com/v.webm' }), {
    url: 'https://cdn.example.com/v.webm',
    poster: '',
    w: 0,
    h: 0,
  })
  // 多余键丢弃；宽高越界 / 非数字一律归 0
  assert.deepEqual(parseWeiboVideo({ url: '/images/u/a.mp4', extra: 'x', w: 'abc', h: -3 }), {
    url: '/images/u/a.mp4',
    poster: '',
    w: 0,
    h: 0,
  })
  assert.deepEqual(parseWeiboVideo({ url: '/images/u/a.mp4', w: 99999, h: 1.9 }), { url: '/images/u/a.mp4', poster: '', w: 10000, h: 1 })
  // poster 非法当没填，不影响视频本身
  assert.deepEqual(parseWeiboVideo({ url: '/images/u/a.mp4', poster: 'javascript:alert(1)' }), {
    url: '/images/u/a.mp4',
    poster: '',
    w: 0,
    h: 0,
  })
  for (const bad of [{ url: 'javascript:alert(1)' }, { url: 'data:video/mp4;base64,AA' }, { url: '  ' }, {}, null, 'x', 42, []])
    assert.equal(parseWeiboVideo(bad), null)
})

test('weiboVideoView 读侧：空串 / 脏 JSON / 非法 scheme 一律 null（不流进 <video src>）', () => {
  assert.equal(weiboVideoView({ video: '' }), null)
  assert.equal(weiboVideoView({ video: '不是 JSON' }), null)
  assert.equal(weiboVideoView({ video: JSON.stringify({ url: 'javascript:alert(1)' }) }), null)
  assert.deepEqual(weiboVideoView({ video: JSON.stringify({ url: '/images/u/a.mp4', poster: '/images/u/a.jpg', w: 720, h: 1280 }) }), {
    url: '/images/u/a.mp4',
    poster: '/images/u/a.jpg',
    w: 720,
    h: 1280,
  })
})

test('weiboVideoHtml：控件 / 占位比例 / 封面帧到位，属性过转义，单行输出', () => {
  const html = weiboVideoHtml({ url: '/images/u/a.mp4', poster: '/images/u/a.jpg', w: 1280, h: 720 })
  assert.match(html, /<video controls playsinline preload="metadata" poster="\/images\/u\/a\.jpg" style="aspect-ratio:1280\/720">/)
  assert.match(html, /<source src="\/images\/u\/a\.mp4" type="video\/mp4">/)
  assert.ok(!html.includes('wb-video-badge'), '有封面帧就不出 ▶ 角标')
  assert.ok(!html.includes('\n'), '必须单行——site.js 镜像靠逐字节比对')
  const portrait = weiboVideoHtml({ url: '/images/u/v.webm', poster: '', w: 720, h: 1280 })
  assert.match(portrait, /wb-video is-portrait is-plain/)
  assert.match(portrait, /type="video\/webm"/)
  assert.match(portrait, /wb-video-badge/)
  assert.ok(!weiboVideoHtml({ url: '/images/u/a.mp4', poster: '', w: 0, h: 0 }).includes('aspect-ratio'), '未知宽高不写占位比例')
  assert.ok(weiboVideoHtml({ url: '/images/u/a".mp4', poster: '', w: 0, h: 0 }).includes('src="/images/u/a&quot;.mp4"'), '属性上下文必须转义')
})

test('微博卡片：媒体区顺序为 正文 → 视频 → 配图', () => {
  const html = weiboCards({
    ...base,
    items: [{ ...item, images: ['/images/u/b.jpg'], video: { url: '/images/u/a.mp4', poster: '/images/u/a.jpg', w: 1280, h: 720 } }],
  })
  const iText = html.indexOf('wb-text')
  const iVideo = html.indexOf('wb-video')
  const iImgs = html.indexOf('wb-imgs')
  assert.ok(iText >= 0 && iVideo > iText && iImgs > iVideo, '顺序应为 正文 → 视频 → 配图')
})

test('首页微博入口卡：视频卡无正文时兜底文案为「发了一段视频」，封面帧充当初图', () => {
  const html = weiboHomeEntry({
    items: [{ ...item, content: '', images: [], video: { url: '/images/u/a.mp4', poster: '/images/u/a.jpg', w: 1280, h: 720 } }],
    total: 1,
  })
  assert.match(html, /发了一段视频/)
  assert.match(html, /wb-home-thumb"><img src="\/images\/u\/a\.jpg"/)
})

// 镜像守卫（与 tests/outlink.test.ts 同款切片手法）：site.js 无构建链，把镜像段包成工厂在 Node 里跑，
// 跟服务端同输入逐字节比对——历史上捕获组错位就是这东西没盯住才漏到线上的
test('site.js wbVideoHtmlJs 镜像：与服务端 weiboVideoHtml 逐字节一致', () => {
  const src = readFileSync(new URL('../public/site.js', import.meta.url), 'utf8')
  const seg = src.slice(src.indexOf('// 视频块与后端 render.ts weiboVideoHtml 同口径'), src.indexOf('// 失败反馈'))
  assert.ok(seg.includes('function wbVideoHtmlJs'), 'site.js 切片失败：镜像段不在预期位置')
  const factory = new Function('esc', 'T', seg + '\n;return { wbVideoHtmlJs: wbVideoHtmlJs }')
  const client = factory(esc, (zh: string) => zh) as { wbVideoHtmlJs: (v: unknown) => string }
  const samples = [
    { url: '/images/u/a.mp4', poster: '/images/u/a.jpg', w: 1280, h: 720 },
    { url: '/images/u/v.webm', poster: '', w: 720, h: 1280 },
    { url: 'https://cdn.example.com/x.mp4', poster: 'https://cdn.example.com/x.jpg', w: 0, h: 0 },
    { url: '/images/u/a.mp4', poster: '', w: 0, h: 0 },
  ]
  for (const s of samples) assert.equal(client.wbVideoHtmlJs(s), weiboVideoHtml(s, false), '双端输出必须一致：' + s.url)
})

test('25MB 口径两处同源：site.js / 后台 app.js 的 VIDEO_MAX_BYTES 等于 store.ts MAX_UPLOAD_BYTES', () => {
  for (const file of ['../public/site.js', '../public/admin/app.js']) {
    const src = readFileSync(new URL(file, import.meta.url), 'utf8')
    const m = src.match(/VIDEO_MAX_BYTES = (\d+) \* 1024 \* 1024/)
    assert.ok(m, file + ' 未声明 VIDEO_MAX_BYTES')
    assert.equal(Number(m[1]) * 1024 * 1024, MAX_UPLOAD_BYTES, file + ' 的体积上限与服务端漂移了')
  }
})

// ── iPhone 上传（2026-10-13 站长手机实测）：选择器 accept 与 .mov 容器归一化 ──
// accept 只列 mp4/webm 时，iOS 的「照片图库」会把 iPhone 拍的 .mov 视频整批筛掉（一个都不显示）；
// 选进来之后还要把 ftyp 里的 'qt  ' 品牌改写成 mp4，浏览器与上传端点才认。

test('site.js patchFtypBrand：iPhone 的 qt 品牌就地改写成 isom，其它文件一律不动', () => {
  const src = readFileSync(new URL('../public/site.js', import.meta.url), 'utf8')
  const seg = src.slice(src.indexOf('/** ISO-BMFF 容器归一化'), src.indexOf('/** 粗略探测有没有 HEVC'))
  assert.ok(seg.includes('function patchFtypBrand'), 'site.js 切片失败：patchFtypBrand 不在预期位置')
  const patch = new Function(seg + '\n;return patchFtypBrand')() as (head: Uint8Array) => boolean

  // iPhone 录制：box size 24、主品牌 'qt  '、兼容品牌列表里还有一个 'qt  '，后面跟着 mdat 长度
  const mov = new Uint8Array([
    0, 0, 0, 24, 0x66, 0x74, 0x79, 0x70, 0x71, 0x74, 0x20, 0x20, 0, 0, 2, 0, 0x71, 0x74, 0x20, 0x20, 0, 0, 0, 8,
  ])
  const rest = [...mov.slice(20)]
  assert.equal(patch(mov), true)
  assert.equal(String.fromCharCode(...mov.slice(8, 12)), 'isom', '主品牌应改成 isom')
  assert.equal(String.fromCharCode(...mov.slice(16, 20)), 'isom', '兼容品牌里的 qt 也要改')
  assert.deepEqual([...mov.slice(20)], rest, 'ftyp 之外的字节不得改动')

  // 已经是 mp4（isom）/ 不是 ISO-BMFF / 文件头太短，都不动
  assert.equal(patch(new Uint8Array([0, 0, 0, 16, 0x66, 0x74, 0x79, 0x70, 0x69, 0x73, 0x6f, 0x6d, 0, 0, 2, 0])), false)
  assert.equal(
    patch(new Uint8Array([0, 0, 0, 24, 0x77, 0x69, 0x64, 0x65, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16])),
    false
  )
  assert.equal(patch(new Uint8Array([0, 0, 0, 16, 0x66])), false)
})

test('site.js detectHevc：认出 hvc1 / hev1，纯 H.264 不误报', async () => {
  const src = readFileSync(new URL('../public/site.js', import.meta.url), 'utf8')
  const seg = src.slice(src.indexOf('/** 粗略探测有没有 HEVC'), src.indexOf('/** 上传前的视频整理'))
  assert.ok(seg.includes('function detectHevc'), 'site.js 切片失败：detectHevc 不在预期位置')
  const detect = new Function(seg + '\n;return detectHevc')() as (f: File) => Promise<boolean>

  assert.equal(await detect(new File([new Uint8Array([0, 0, 0, 8, 0x68, 0x76, 0x63, 0x31, 0, 0, 0, 8])], 'a.mov')), true)
  assert.equal(await detect(new File([new Uint8Array([0, 0, 0, 8, 0x61, 0x76, 0x63, 0x31, 0, 0, 0, 8])], 'b.mov')), false)
})

test('两个客户端的选择器都写 video/*，且都带 ftyp 归一化（accept 列窄了 iOS 图库就看不出视频）', () => {
  for (const file of ['../public/site.js', '../public/admin/app.js']) {
    const src = readFileSync(new URL(file, import.meta.url), 'utf8')
    assert.match(src, /VIDEO_ACCEPT = 'video\/\*'/, file + ' 的 VIDEO_ACCEPT 必须是 video/*')
    assert.ok(src.includes('function patchFtypBrand'), file + ' 缺少 ftyp 容器归一化')
  }
})

// 回归（2026-10-13 站长实测）：B19 落地时三处入口只接了两处——前台 /weibo 的发布框
// （render.ts weiboComposer）漏了媒体入口，于是「想传视频只能点加图」：iOS 图库里看不到视频、
// 桌面端也选不出 mp4。站长随后拍板：不要独立的视频按钮，图片与视频共用一个选择器，
// 只留「一条微博最多 1 个视频」的约束。这里把「唯一媒体按钮 + 视频容器 + accept 含 video/*」钉死。
test('前台发布框：媒体按钮只有一个（图片/视频共用），视频预览容器到位', () => {
  const html = weiboComposer({ adminName: '站长' })
  assert.ok(html.includes('class="wb-composer-video"'), '前台发布框缺视频预览容器')
  assert.equal((html.match(/class="wb-composer-add"/g) || []).length, 1, '媒体按钮应恰好一个')
  assert.ok(!html.includes('wb-composer-add-video'), '独立视频按钮已按站长意见去掉')
  // site.js 查的容器类名 / accept 两边对齐（accept 必须含 video/*，否则 iOS 图库筛掉 .mov）
  const site = readFileSync(new URL('../public/site.js', import.meta.url), 'utf8')
  assert.ok(site.includes('.wb-composer-video'), 'site.js 未接线 .wb-composer-video')
  assert.match(site, /image\/jpeg,image\/png,image\/webp,image\/gif,' \+ VIDEO_ACCEPT/, '前台媒体入口的 accept 应拼上 VIDEO_ACCEPT')
  const app = readFileSync(new URL('../public/admin/app.js', import.meta.url), 'utf8')
  assert.ok(app.includes('${VIDEO_ACCEPT}'), '后台媒体入口的 accept 应拼上 VIDEO_ACCEPT')
})

// 回归（2026-10-13 站长上传失败）：prepareVideo 曾把「品牌无需改写」当成「不认识的格式」——
// macOS 常把 .mp4 报成 video/quicktime（内容品牌是 isom），于是被直接拒掉。现在只认文件头。
test('site.js prepareVideo：只认文件头——声明成 quicktime 的 isom 文件不再被误拒', async () => {
  const src = readFileSync(new URL('../public/site.js', import.meta.url), 'utf8')
  const seg = src.slice(src.indexOf('/** ISO-BMFF 容器归一化'), src.indexOf('/** 上传视频（带百分比回调）'))
  assert.ok(seg.includes('function prepareVideo') && seg.includes('function patchFtypBrand'), 'site.js 切片失败：视频工具段不在预期位置')
  const api = new Function('T', 'File', seg + '\n;return { prepareVideo }')((zh: string) => zh, File) as {
    prepareVideo: (f: File) => Promise<{ file?: File; hevc?: boolean; error?: boolean }>
  }
  const iso = (brand: string) =>
    new Uint8Array([
      0, 0, 0, 24, 0x66, 0x74, 0x79, 0x70,
      ...brand.split('').map((c) => c.charCodeAt(0)),
      0, 0, 2, 0,
      ...brand.split('').map((c) => c.charCodeAt(0)),
      0, 0, 0, 8, 1, 2, 3, 4,
    ])

  const r1 = await api.prepareVideo(new File([iso('isom')], 'a.mp4', { type: 'video/quicktime' }))
  assert.ok(!r1.error, 'isom 品牌声明成 quicktime 时不该被拒')
  assert.equal(r1.file!.type, 'video/mp4')
  assert.equal(r1.file!.name, 'a.mp4')

  const r2 = await api.prepareVideo(new File([iso('qt  ')], 'b.mov', { type: 'video/quicktime' }))
  assert.ok(!r2.error)
  assert.equal(r2.file!.type, 'video/mp4')
  assert.equal(r2.file!.name, 'b.mp4', 'qt 视频归一化后扩展名对齐 mp4')
  const head = new Uint8Array(await r2.file!.slice(0, 16).arrayBuffer())
  assert.equal(String.fromCharCode(...head.slice(8, 12)), 'isom', 'qt 品牌应被就地改写成 isom')

  const r3 = await api.prepareVideo(
    new File([new Uint8Array([0x52, 0x49, 0x46, 0x46, 0, 0, 0, 0, 0x41, 0x56, 0x49, 0x20])], 'c.avi', { type: 'video/x-msvideo' })
  )
  assert.equal(r3.error, true, '非 ISO-BMFF 容器应回 error')

  const r4 = await api.prepareVideo(new File([new Uint8Array([0x1a, 0x45, 0xdf, 0xa3, 0, 0, 0, 0])], 'd.webm', { type: '' }))
  assert.ok(!r4.error)
  assert.equal(r4.file!.type, 'video/webm')
})
