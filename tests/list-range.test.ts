import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { DatabaseSync, type StatementSync } from 'node:sqlite'
import type { D1Database } from '@cloudflare/workers-types'
import {
  adjacentPosts,
  ensureSchema,
  listPosts,
  listSitemapPosts,
  listWeibo,
  locateWeiboPage,
  relatedPosts,
} from '../src/db.ts'
import { searchPosts, searchWeibo } from '../src/fts.ts'
import { listRangeCutoff, siteVisibleCutoff, LIST_RANGES } from '../src/utils.ts'

// ── 后台列表时间范围筛选（文章 / 微博共用）──
// 防线核心：客户端只传白名单语义值（3d/1m/6m/1y），真实 cutoff 由服务端
// listRangeCutoff 计算后参数化进 SQL——时间戳不可由客户端注入，未知值降级为
// 「全部」（与列表 status 参数的白名单降级口径一致），不存在白名单之外的口径。

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const SCHEMA_SQL = readFileSync(join(ROOT, 'schema.sql'), 'utf8')

// 与 tests/fts.test.ts 同款：node:sqlite → D1 形状适配（prepare/bind/all/first/batch）
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

test('listRangeCutoff：白名单四档换算成滚动窗口 cutoff', () => {
  const now = 1_750_000_000_000
  assert.equal(listRangeCutoff('3d', now), now - 3 * 86_400_000)
  assert.equal(listRangeCutoff('1m', now), now - 30 * 86_400_000)
  assert.equal(listRangeCutoff('6m', now), now - 182 * 86_400_000)
  assert.equal(listRangeCutoff('1y', now), now - 365 * 86_400_000)
  // 表值与常量一致：改窗口天数只改 LIST_RANGES 一处
  for (const [k, days] of Object.entries(LIST_RANGES)) {
    assert.equal(listRangeCutoff(k, now), now - days)
  }
})

test('listRangeCutoff：未传 / 未知值 / 原型链属性一律回 0（不过滤）', () => {
  const now = 1_750_000_000_000
  assert.equal(listRangeCutoff(undefined, now), 0)
  assert.equal(listRangeCutoff(null, now), 0)
  assert.equal(listRangeCutoff('', now), 0)
  // 手搓参数拿不到白名单之外的口径：任意串都降级为「全部」
  assert.equal(listRangeCutoff('10y', now), 0)
  assert.equal(listRangeCutoff('1970-01-01', now), 0)
  assert.equal(listRangeCutoff('0', now), 0)
  // hasOwnProperty 查表：原型链属性不得穿透成有效档位
  assert.equal(listRangeCutoff('constructor', now), 0)
  assert.equal(listRangeCutoff('toString', now), 0)
})

function seedRangeDb(): { db: D1Database; raw: DatabaseSync; now: number } {
  const raw = new DatabaseSync(':memory:')
  raw.exec(SCHEMA_SQL)
  const now = 1_750_000_000_000
  const DAY = 86_400_000
  const post = raw.prepare(
    'INSERT INTO posts (slug, title, content, status, pinned, published_at, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)'
  )
  // 4 篇文章覆盖四象限：新/旧 × 已发布/草稿（草稿无 published_at，走 COALESCE 的 created_at 分支）
  post.run('new-pub', '新发布', 'x', 'published', 0, now - 1 * DAY, now - 1 * DAY, now - 1 * DAY)
  post.run('old-pub', '旧发布', 'x', 'published', 0, now - 400 * DAY, now - 400 * DAY, now - 400 * DAY)
  post.run('new-draft', '新草稿', 'x', 'draft', 0, null, now - 2 * 3600_000, now - 2 * 3600_000)
  post.run('old-draft', '旧草稿', 'x', 'draft', 0, null, now - 200 * DAY, now - 200 * DAY)
  const wb = raw.prepare(
    'INSERT INTO weibo (content, status, pinned, published_at, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)'
  )
  // 微博：新（2 小时前，窗口内最新）/ 旧（400 天）/ 旧但置顶（范围筛选按时间说话，置顶不豁免）/ 半年内（100 天）/ 新草稿（1 天前）
  wb.run('新微博', 'published', 0, now - 2 * 3600_000, now - 2 * 3600_000, now - 2 * 3600_000)
  wb.run('旧微博', 'published', 0, now - 400 * DAY, now - 400 * DAY, now - 400 * DAY)
  wb.run('旧置顶微博', 'published', 1, now - 400 * DAY, now - 400 * DAY, now - 400 * DAY)
  wb.run('百日微博', 'published', 0, now - 100 * DAY, now - 100 * DAY, now - 100 * DAY)
  wb.run('新草稿微博', 'draft', 0, null, now - 1 * DAY, now - 1 * DAY)
  return { db: d1FromSqlite(raw), raw, now }
}

test('listPosts：afterTs 只留窗口内行，草稿按 created_at 参与 COALESCE，计数同步', async () => {
  const { db, now } = seedRangeDb()
  const DAY = 86_400_000

  const r3d = await listPosts(db, { status: 'all', afterTs: now - 3 * DAY })
  assert.deepEqual(r3d.items.map((p) => p.slug).sort(), ['new-draft', 'new-pub'])
  assert.equal(r3d.total, 2)
  assert.equal(r3d.totalPages, 1)

  // 1 年窗口：400 天前的两篇出窗，200 天前的旧草稿在窗内
  const r1y = await listPosts(db, { status: 'all', afterTs: now - 365 * DAY })
  assert.deepEqual(r1y.items.map((p) => p.slug).sort(), ['new-draft', 'new-pub', 'old-draft'])
  assert.equal(r1y.total, 3)

  // 范围 × 状态筛选叠加
  const rDraft = await listPosts(db, { status: 'draft', afterTs: now - 3 * DAY })
  assert.deepEqual(rDraft.items.map((p) => p.slug), ['new-draft'])

  // 范围 × 关键词搜索叠加：搜索只在天窗内找
  const rQ = await listPosts(db, { status: 'all', q: '发布', afterTs: now - 3 * DAY })
  assert.deepEqual(rQ.items.map((p) => p.slug), ['new-pub'])

  // afterTs 缺省 / 0 = 不过滤（全部）
  const rAll = await listPosts(db, { status: 'all' })
  assert.equal(rAll.total, 4)
})

test('listWeibo：afterTs 按时间说话，置顶不豁免范围，pinnedFirst 排序在窗口内保持', async () => {
  const { db, now } = seedRangeDb()
  const DAY = 86_400_000

  const r3d = await listWeibo(db, { pinnedFirst: true, afterTs: now - 3 * DAY })
  // 旧置顶微博被范围筛掉：只显示最近 N 天不因置顶开例外
  assert.deepEqual(r3d.items.map((w) => w.content), ['新微博', '新草稿微博'])
  assert.equal(r3d.total, 2)

  const r1y = await listWeibo(db, { pinnedFirst: true, afterTs: now - 365 * DAY })
  // 全量（不过滤）时置顶最旧的排最前；1 年窗口内置顶旧微博同样出窗，100 天前的正常在窗内
  assert.equal(r1y.total, 3)
  assert.deepEqual(r1y.items.map((w) => w.content), ['新微博', '新草稿微博', '百日微博'])
  const rNoFilter = await listWeibo(db, { pinnedFirst: true })
  assert.equal(rNoFilter.total, 5)
  assert.equal(rNoFilter.items[0].content, '旧置顶微博')
})

test('listWeibo：范围 × 状态筛选叠加（后台「草稿」页签 + 3 天窗口）', async () => {
  const { db, now } = seedRangeDb()
  const r = await listWeibo(db, { status: 'draft', afterTs: now - 3 * 86_400_000 })
  assert.deepEqual(r.items.map((w) => w.content), ['新草稿微博'])
})
