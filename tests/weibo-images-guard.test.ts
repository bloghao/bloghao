import { test } from 'node:test'
import assert from 'node:assert/strict'
import { parseWeiboImages, weiboImageList } from '../src/db.ts'

// ── 微博图片两道 scheme 白名单（src/db.ts）──
// 防线（AGENTS「微博视频」节同族口径）：写侧 parseWeiboImages 只收站内 /images/ 与
// http(s) 外链（javascript:/data:/相对路径一律拒）；读侧 weiboImageList 是第二道
// （备份恢复/手工改库进来的脏值不流进 <img src>）。读侧在 themes.test 有渲染面覆盖，
// 这里把两侧的纯函数语义钉死。

test('parseWeiboImages（写侧）：只收站内 /images/ 与 http(s)，其余过滤', () => {
  const kept = parseWeiboImages([
    '/images/u/202610/a.jpg',
    'https://example.com/b.png',
    'http://example.com/c.webp',
    'javascript:alert(1)',
    'data:image/png;base64,AAAA',
    'ftp://example.com/d.gif',
    '//example.com/e.png',
    'relative/f.png',
    '/imagesX/not-a-prefix.png',
  ])
  assert.deepEqual(kept, ['/images/u/202610/a.jpg', 'https://example.com/b.png', 'http://example.com/c.webp'])
})

test('parseWeiboImages：逐项 trim、非字符串剔除、上限 9 张、非数组回空', () => {
  assert.deepEqual(parseWeiboImages(['  /images/u/a.jpg  ', 'https://x/b.png']), ['/images/u/a.jpg', 'https://x/b.png'])
  assert.deepEqual(parseWeiboImages([1, null, '/images/u/a.jpg'] as unknown[]), ['/images/u/a.jpg'])
  const eleven = Array.from({ length: 11 }, (_, i) => `/images/u/${i}.jpg`)
  assert.equal(parseWeiboImages(eleven).length, 9)
  assert.deepEqual(parseWeiboImages('not-an-array'), [])
  assert.deepEqual(parseWeiboImages(null), [])
})

test('weiboImageList（读侧）：脏 JSON / 非法 scheme / 上限同口径（幂等纵深）', () => {
  assert.deepEqual(weiboImageList({ images: '["/images/u/a.jpg","javascript:x"]' }), ['/images/u/a.jpg'])
  assert.deepEqual(weiboImageList({ images: 'not-json' }), [])
  assert.deepEqual(weiboImageList({ images: '' }), [])
  assert.deepEqual(weiboImageList({ images: '[]' }), [])
  const eleven = JSON.stringify(Array.from({ length: 11 }, (_, i) => `/images/u/${i}.jpg`))
  assert.equal(weiboImageList({ images: eleven }).length, 9)
})
