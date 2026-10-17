import { test } from 'node:test'
import assert from 'node:assert/strict'
import { normalizeCacheQuery } from '../src/pagecache.ts'

// ── 页面缓存 query 键规范化（src/pagecache.ts normalizeCacheQuery）直接单测 ──
// pagecache.test.ts 经 pageCacheKeyFor 间接覆盖了主路径；本文件把「键空间有界」的每个
// 参数语义钉死，防两侧（缓存键 vs 服务端消费）镜像漂移（AGENTS「SQL / 输入」防线 +
// tests/pagecache.test.ts 头注释「镜像错位 = 把错页发给访客」）。
// 注意：tag 参数缓存侧会 trim，而服务端消费点（pages.ts renderList / api.ts /public/posts）
// 目前不 trim（docs/archive/AUDIT-CACHE-2026-10-15.md C1）——此处只钉缓存侧自身语义，不断言
// 「trim 后与干净键同键」（那是待修复的碰撞行为，不能固化成测试）。

const q = (s: string) => normalizeCacheQuery(new URL('https://x.test/' + s).searchParams)

test('无 query 与空值参数同键（服务端按没传处理）', () => {
  assert.equal(q(''), '')
  assert.equal(q('?'), '')
})

test('page：clamp 1..1000；NaN 按没传；0/负数夹回 1 保留键（同渲染结果同键）', () => {
  assert.equal(q('?page=2'), 'page=2')
  assert.equal(q('?page=0'), 'page=1', '夹回 1 与「没传」同义但保留键——与 ?page=1 同键')
  assert.equal(q('?page=1'), 'page=1')
  assert.equal(q('?page=-3'), 'page=1')
  assert.equal(q('?page=abc'), '')
  assert.equal(q('?page=1001'), 'page=1000')
  assert.equal(q('?page=1e2'), 'page=1', 'parseInt 截断语义（1e2→1）与服务端 clampInt 一致')
})

test('limit：clamp 1..50（公开 API 口径），0/负数夹回 1 保留键', () => {
  assert.equal(q('?limit=50'), 'limit=50')
  assert.equal(q('?limit=51'), 'limit=50')
  assert.equal(q('?limit=0'), 'limit=1')
  assert.equal(q('?limit=abc'), '')
})

test('wb：仅 /^\d{1,12}$/ 进键，其余按没传', () => {
  assert.equal(q('?wb=123'), 'wb=123')
  assert.equal(q('?wb=123456789012'), 'wb=123456789012')
  assert.equal(q('?wb=1234567890123'), '', '13 位超长拒')
  assert.equal(q('?wb=12a'), '')
  assert.equal(q('?wb=-1'), '')
})

test('topic / q：trim + 截断（24 / 60）后进键', () => {
  assert.equal(q('?topic=' + encodeURIComponent('  日常  ')), 'topic=' + encodeURIComponent('日常'))
  assert.equal(q('?q=' + encodeURIComponent('  博客  ')), 'q=' + encodeURIComponent('博客'))
  const long = 'x'.repeat(80)
  assert.equal(q('?q=' + long), 'q=' + 'x'.repeat(60))
  assert.equal(q('?topic=' + encodeURIComponent('t'.repeat(30))), 'topic=' + 't'.repeat(24))
})

test('sort：白名单四值进键；未知值按没传（服务端回落 latest）；random 整体回源', () => {
  assert.equal(q('?sort=views'), 'sort=views')
  assert.equal(q('?sort=likes'), 'sort=likes')
  assert.equal(q('?sort=comments'), 'sort=comments')
  assert.equal(q('?sort=latest'), 'sort=latest')
  assert.equal(q('?sort=newest'), '')
  assert.equal(q('?sort=random'), null, '随机排序 seed 现生成，同 URL 两次结果不同')
})

test('tag：两侧同 trim（服务端 pages.ts / api.ts 消费点已对齐，审计 C1 修复）、≤64 进键、超长整体回源', () => {
  assert.equal(q('?tag=' + encodeURIComponent(' 生活 ')), 'tag=' + encodeURIComponent('生活'))
  assert.equal(q('?tag=' + encodeURIComponent('生活')), 'tag=' + encodeURIComponent('生活'))
  assert.equal(q('?tag=' + 'x'.repeat(65)), null)
})

test('多参数键按参数名排序，空白参数从键里省略', () => {
  assert.equal(q('?sort=views&page=3'), 'page=3&sort=views')
  assert.equal(q('?page=2&q=abc'), 'page=2&q=' + encodeURIComponent('abc'))
  assert.equal(q('?page=2&wb='), 'page=2')
})

test('重复参数与未知参数一律回源（宁可少数页面吃不到缓存，不可把错页发给访客）', () => {
  assert.equal(q('?page=1&page=2'), null)
  assert.equal(q('?_r=123'), null, '评论刷新旁路 _r 依赖这条')
  assert.equal(q('?utm_source=x'), null)
  assert.equal(q('?sort=views&foo=1'), null)
})
