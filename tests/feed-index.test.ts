import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { SCHEMA_INDEXES } from '../src/db.ts'
// ── 列表时间线表达式排序索引（P0-1，D1 读放大优化）──
// 防线核心：listPosts / listWeibo 的 ORDER BY 用 COALESCE(published_at, created_at)，
// 索引表达式必须与排序片段一字不差（含 DESC 方向），否则 SQLite 结构匹配失败，
// 翻一页也全表扫描 + 临时 B-tree 排序（D1 按「行读取」计费，免费额度 500 万/天）。
// 本文件用 node:sqlite 执行真实 schema.sql 建库造数，逐条 EXPLAIN QUERY PLAN 验证。
// 已知局限（实测登记）：后台 status=all（无 status 等值）的列表规划器仍走全表 + 临时排序——
// SQLite 成本模型对无等值约束的全索引扫描偏保守（ANALYZE 后同样），仅后台低频路径，不在 P0-1 验收范围。

const ROOT = join(import.meta.dirname, '..')
const SCHEMA_SQL = readFileSync(join(ROOT, 'schema.sql'), 'utf8')

/** 三条索引的规范 DDL：schema.sql 与 db.ts SCHEMA_INDEXES 双份登记必须一致（同一 schema 两份表达的老规矩） */
const FEED_INDEXES = [
  'CREATE INDEX IF NOT EXISTS idx_weibo_feed ON weibo (status, COALESCE(published_at, created_at) DESC, id DESC) WHERE deleted_at IS NULL',
  'CREATE INDEX IF NOT EXISTS idx_weibo_feed_pinned ON weibo (status, pinned DESC, COALESCE(published_at, created_at) DESC, id DESC) WHERE deleted_at IS NULL',
  'CREATE INDEX IF NOT EXISTS idx_posts_feed ON posts (status, pinned DESC, COALESCE(published_at, created_at) DESC, id DESC) WHERE deleted_at IS NULL',
]

const norm = (s: string) => s.replace(/\s+/g, ' ').trim()

test('feed 索引：schema.sql 与 SCHEMA_INDEXES 双份登记一致', () => {
  const sql = norm(SCHEMA_SQL)
  for (const ddl of FEED_INDEXES) {
    assert.ok(sql.includes(norm(ddl)), `schema.sql 缺：${ddl}`)
    assert.ok(SCHEMA_INDEXES.includes(ddl), `SCHEMA_INDEXES 缺：${ddl}`)
  }
})

function seedDb(withRuntimeIndexes = false): DatabaseSync {
  const db = new DatabaseSync(':memory:')
  db.exec(SCHEMA_SQL)
  // 生产冷启动形态 = schema.sql + ensureSchema(SCHEMA_INDEXES)：idx_comments_weibo 只在后者
  // （挂在运行时补齐的 weibo_id 列上，schema.sql 建它会撞老库）
  if (withRuntimeIndexes) for (const ddl of SCHEMA_INDEXES) db.exec(ddl)
  const base = 1700000000000
  const wb = db.prepare(
    'INSERT INTO weibo (content, status, pinned, likes, published_at, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)'
  )
  for (let i = 0; i < 930; i++) {
    const t = base + i * 60000
    // 每 5 条一条 published_at 为空：逼 COALESCE 分支参与排序（脏数据在同一条 SQL 里混）
    wb.run(`微博内容 ${i}`, i % 20 === 0 ? 'draft' : 'published', i % 100 === 0 ? 1 : 0, i % 7, i % 5 === 0 ? null : t, t, t)
  }
  const post = db.prepare(
    'INSERT INTO posts (slug, title, content, tags, status, pinned, views, likes, published_at, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)'
  )
  for (let i = 0; i < 215; i++) {
    const t = base + i * 3600000
    post.run(`post-${i}`, `文章 ${i}`, `正文 ${i}`, '["生活","Cloudflare"]', 'published', i % 50 === 0 ? 1 : 0, i, i % 9, i % 7 === 0 ? null : t, t, t)
  }
  // 评论（文章/微博/留言板三路混布，pending 混入逼 status 过滤参与）：计数查询的读放大实测对象
  const cmt = db.prepare(
    'INSERT INTO comments (post_id, weibo_id, nickname, content, status, created_at) VALUES (?, ?, ?, ?, ?, ?)'
  )
  for (let i = 0; i < 420; i++) {
    const postId = i % 3 === 0 ? 0 : (i % 215) + 1
    const weiboId = i % 3 === 1 ? (i % 930) + 1 : 0
    cmt.run(postId, weiboId, `访客${i}`, `评论 ${i}`, i % 10 === 0 ? 'pending' : 'approved', base + i * 30000)
  }
  return db
}

function planOf(db: DatabaseSync, sql: string): string {
  return db
    .prepare(`EXPLAIN QUERY PLAN ${sql}`)
    .all()
    .map((r) => String((r as { detail: unknown }).detail))
    .join(' | ')
}

/** 走没走索引 + 无临时排序（计划里出现 TEMP B-TREE FOR ORDER BY 就是没走） */
function assertUsesIndex(plan: string, index: string): void {
  assert.ok(plan.includes(`USING INDEX ${index}`), `未走 ${index}：${plan}`)
  assert.ok(!plan.includes('TEMP B-TREE'), `出现临时排序：${plan}`)
  assert.ok(!/SCAN (weibo|posts)(?! USING INDEX)/.test(plan), `全表扫描：${plan}`)
}

test('EXPLAIN：weibo recency 排序（公开 API / 首页入口卡）走 idx_weibo_feed', () => {
  const db = seedDb()
  const plan = planOf(
    db,
    "SELECT * FROM weibo WHERE deleted_at IS NULL AND status = 'published' ORDER BY COALESCE(published_at, created_at) DESC, id DESC LIMIT 20 OFFSET 0"
  )
  assertUsesIndex(plan, 'idx_weibo_feed')
})

test('EXPLAIN：weibo pinnedFirst 排序（/weibo 时间线）走 idx_weibo_feed_pinned', () => {
  const db = seedDb()
  const plan = planOf(
    db,
    "SELECT * FROM weibo WHERE deleted_at IS NULL AND status = 'published' ORDER BY pinned DESC, COALESCE(published_at, created_at) DESC, id DESC LIMIT 20 OFFSET 0"
  )
  assertUsesIndex(plan, 'idx_weibo_feed_pinned')
})

test('EXPLAIN：posts 默认列表走 idx_posts_feed', () => {
  const db = seedDb()
  const plan = planOf(
    db,
    "SELECT * FROM posts WHERE deleted_at IS NULL AND status = 'published' ORDER BY pinned DESC, COALESCE(published_at, created_at) DESC LIMIT 10 OFFSET 0"
  )
  assertUsesIndex(plan, 'idx_posts_feed')
})

test('EXPLAIN：posts 标签筛选（前导通配 LIKE）仍走 idx_posts_feed、无临时排序', () => {
  const db = seedDb()
  const plan = planOf(
    db,
    "SELECT * FROM posts WHERE deleted_at IS NULL AND status = 'published' AND tags LIKE ? ESCAPE '\\' ORDER BY pinned DESC, COALESCE(published_at, created_at) DESC LIMIT 10 OFFSET 0"
  )
  assertUsesIndex(plan, 'idx_posts_feed')
})

/* ── 评论计数强制索引（P0-3，D1 读放大优化，2026-10-15 生产实测）──
 * 形如「post_id IN (...) AND status='approved' GROUP BY post_id」的计数聚合与 sort=comments
 * 的相关子查询，规划器会误选 idx_comments_status（status 等值看似更窄）而全表扫全部已审评论：
 * 生产库实测首页计数 2405 行/次、文章页计数 2405 行/次、sort=comments 单次渲染 500,448 行。
 * INDEXED BY 强制走 (post_id|weibo_id) 前导索引后分别降至 12 / 2 / 500 行。它是硬约束：
 * 索引不在场语句直接报错——idx_comments_post 因此补进 SCHEMA_INDEXES 兜底（schema.sql 自
 * MoBlog v1.0 就有，双份登记照旧），idx_comments_weibo 本就只在 SCHEMA_INDEXES。 */

const DB_TS = readFileSync(join(ROOT, 'src/db.ts'), 'utf8')
const PAGES_TS = readFileSync(join(ROOT, 'src/pages.ts'), 'utf8')

test('评论计数索引：idx_comments_post 在 schema.sql 与 SCHEMA_INDEXES 双份登记一致', () => {
  const ddl = 'CREATE INDEX IF NOT EXISTS idx_comments_post ON comments (post_id, created_at)'
  assert.ok(norm(SCHEMA_SQL).includes(norm(ddl)), `schema.sql 缺：${ddl}`)
  assert.ok(SCHEMA_INDEXES.includes(ddl), `SCHEMA_INDEXES 缺：${ddl}`)
})

test('源码守卫：INDEXED BY 不被无声拆掉（db.ts 3 处 / pages.ts 1 处）', () => {
  assert.equal(
    (DB_TS.match(/INDEXED BY idx_comments_post/g) || []).length,
    2,
    'db.ts 的 idx_comments_post 强制索引应是 2 处（sort=comments 子查询 + postCommentCountMap）'
  )
  assert.equal(
    (DB_TS.match(/INDEXED BY idx_comments_weibo/g) || []).length,
    1,
    'db.ts 的 idx_comments_weibo 强制索引应是 1 处（weiboCommentCountMap）'
  )
  assert.ok(PAGES_TS.includes('INDEXED BY idx_comments_post'), 'pages.ts commentCount 缺 INDEXED BY')
})

test('EXPLAIN：文章评论计数 map 走 idx_comments_post、不扫全表', () => {
  const db = seedDb(true)
  const plan = planOf(
    db,
    "SELECT post_id, COUNT(*) AS n FROM comments INDEXED BY idx_comments_post WHERE post_id IN (1,2,3,4,5,6,7,8,9,10) AND status = 'approved' GROUP BY post_id"
  )
  assert.ok(plan.includes('USING INDEX idx_comments_post'), `未走 idx_comments_post：${plan}`)
  assert.ok(!/SCAN comments(?! USING INDEX)/.test(plan), `全表扫描：${plan}`)
})

test('EXPLAIN：微博评论计数 map 走 idx_comments_weibo、不扫全表', () => {
  const db = seedDb(true)
  const plan = planOf(
    db,
    "SELECT weibo_id, COUNT(*) AS n FROM comments INDEXED BY idx_comments_weibo WHERE weibo_id IN (1,2,3,4,5,6,7,8,9,10) AND status = 'approved' GROUP BY weibo_id"
  )
  assert.ok(plan.includes('USING INDEX idx_comments_weibo'), `未走 idx_comments_weibo：${plan}`)
  assert.ok(!/SCAN comments(?! USING INDEX)/.test(plan), `全表扫描：${plan}`)
})

test('EXPLAIN：sort=comments 相关子查询逐篇走 idx_comments_post', () => {
  const db = seedDb(true)
  const plan = planOf(
    db,
    "SELECT id FROM posts WHERE deleted_at IS NULL AND status = 'published' ORDER BY (SELECT COUNT(*) FROM comments cm INDEXED BY idx_comments_post WHERE cm.post_id = posts.id AND cm.status = 'approved') DESC, COALESCE(published_at, created_at) DESC, id DESC LIMIT 10"
  )
  assert.ok(plan.includes('USING INDEX idx_comments_post'), `子查询未走 idx_comments_post：${plan}`)
})

test('INDEXED BY 硬约束语义：索引不在场时语句报错（SCHEMA_INDEXES 兜底不可省的自检）', () => {
  // 只跑 schema.sql：idx_comments_weibo 不在（挂运行时补齐列）→ prepare 必须抛错。
  // 若哪天有人想把 INDEXED BY 改回「信任规划器」，这条用例提醒着硬约束的真实代价与兜底的必要
  const db = seedDb(false)
  assert.throws(() => db.prepare('SELECT COUNT(*) FROM comments INDEXED BY idx_comments_weibo WHERE weibo_id = 1').all())
})
