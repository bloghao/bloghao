import { test } from 'node:test'
import assert from 'node:assert/strict'
import { keyOf, zipEntrySlug, exportRoutes } from '../src/export.ts'

// ── 数据导出的 R2 key 白名单与 zip 条目名守卫（src/export.ts）──
// 防线（AGENTS「部署链路」/ 2026-10-12 审计 B2）：导出要打进真实 R2 对象与 zip 条目名，
// key/slug 洗不干净 = docker-poc r2disk 落盘路径穿越或解包端目录逃逸。写库侧 cleanSlug
// 已保证，这里钉的是「旁路写脏库」时的最后一道闸不缺位。

test('keyOf：站内 /images/ 地址 → R2 key（u/ 与 og/ 两个前缀放行）', () => {
  assert.equal(keyOf('/images/u/202610/abc.jpg'), 'u/202610/abc.jpg')
  assert.equal(keyOf('/images/og/card.png'), 'og/card.png')
})

test('keyOf：非 u/og 前缀一律拒绝（backups/ 等其余 R2 目录不进导出包）', () => {
  assert.equal(keyOf('/images/backups/x.json'), null)
  assert.equal(keyOf('/images/etc/x'), null)
  assert.equal(keyOf('/images/u'), null, '裸 u（无斜杠主体）不满足 u/ 前缀')
})

test('keyOf：路径穿越与坏字符守卫（.. \\ NUL，含百分号编码形态）', () => {
  assert.equal(keyOf('/images/../etc/passwd'), null, '明文 .. 直接拒')
  assert.equal(keyOf('/images/u/%2E%2E/x'), null, '百分号编码的 .. 解码后拒（防穿越到租户目录外）')
  assert.equal(keyOf('/images/u/a%2F..%2F..%2Fb'), null, '编码后的斜杠拼出 .. 同样拒')
  assert.equal(keyOf('/images/u/a\\b'), null, '反斜杠拒（Windows 路径分隔）')
  assert.equal(keyOf('/images/u/a%00b'), null, 'NUL 字节拒')
})

test('keyOf：非 /images/ 前缀与坏编码一律 null（外链/非法 URL 不进打包清单）', () => {
  assert.equal(keyOf('https://example.com/images/u/a.png'), null)
  assert.equal(keyOf('/images/u/%zz'), null, 'decodeURIComponent 抛错按不可解析拒绝')
  assert.equal(keyOf(''), null)
})

test('zipEntrySlug：干净 slug 原样用（中文可作条目名）', () => {
  assert.equal(zipEntrySlug('hello-world', 3), 'hello-world')
  assert.equal(zipEntrySlug('你好世界', 3), '你好世界')
})

test('zipEntrySlug：脏 slug 退回 post-<id> 命名（防 zip 条目目录逃逸）', () => {
  assert.equal(zipEntrySlug('a/b', 3), 'post-3')
  assert.equal(zipEntrySlug('a\\b', 3), 'post-3')
  assert.equal(zipEntrySlug('..', 3), 'post-3')
  assert.equal(zipEntrySlug('a..b', 3), 'post-3')
  assert.equal(zipEntrySlug('a\0b', 3), 'post-3')
  assert.equal(zipEntrySlug('', 3), 'post-3')
})

// ── 演示站导出守卫（安全审计 F3 修复的守卫）：demo 下两条导出路由一律 404，不能让
// 凭据公示的体验者整包拖走内容。守卫在 DB 触碰之前，环境里不需要真库 ──

test('演示站 /api/admin/export/* 整体 404（markdown 与 wxr 两路）', async () => {
  const demoEnv = { DEMO_MODE: '1', DB: {}, IMAGES: {} }
  for (const path of ['/markdown', '/wxr']) {
    const res = await exportRoutes.request(path, undefined, demoEnv)
    assert.equal(res.status, 404, `demo 下 ${path} 必须短路`)
    const body = (await res.json()) as { error?: string }
    assert.match(body.error ?? '', /演示站/)
  }
})
