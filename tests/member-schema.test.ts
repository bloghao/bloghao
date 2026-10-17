import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { ensureSchema } from '../src/db.ts'

// ── 会员体系 Step 0 地基（docs/archive/DEVPLAN-2026-10-07.md 附录 A）──
// schema.sql 与 db.ts 的 SCHEMA_TABLES / SCHEMA_COLUMNS / SCHEMA_INDEXES 是同一 schema 的两份
// 表达（AGENTS.md 铁律），此前只靠人工核对；本文件把不变量固化成自动守卫。

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const schemaSql = readFileSync(join(ROOT, 'schema.sql'), 'utf8')
const dbTs = readFileSync(join(ROOT, 'src/db.ts'), 'utf8')

/** 建表列体 → 列名集合（先剥 -- 注释再按逗号拆，注释里的逗号不能干扰拆分） */
function parseCols(body: string): Set<string> {
  const clean = body
    // Windows 检出（core.autocrlf=true）会把 schema.sql 变 CRLF：`.` 不匹配 \r、$ 只认串尾，
    // 注释剥离会整体失效（列名被解析成 "--"），先归一再按行剥注释
    .replace(/\r\n/g, '\n')
    .split('\n')
    .map((l) => l.replace(/--.*$/, ''))
    .join('\n')
  return new Set(
    clean
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean)
      .map((s) => s.split(/\s+/)[0])
      .filter((n) => !/^(PRIMARY|UNIQUE|FOREIGN|CONSTRAINT|CHECK)$/i.test(n))
  )
}

function parseSchemaSqlTables(sql: string): Map<string, Set<string>> {
  const tables = new Map<string, Set<string>>()
  for (const m of sql.matchAll(/CREATE TABLE IF NOT EXISTS (\w+) \(([\s\S]*?)\);/g)) {
    tables.set(m[1], parseCols(m[2]))
  }
  return tables
}

function parseDbTsTables(src: string): Map<string, Set<string>> {
  const tables = new Map<string, Set<string>>()
  for (const m of src.matchAll(/CREATE TABLE IF NOT EXISTS (\w+) \(([\s\S]*?)\)`/g)) {
    tables.set(m[1], parseCols(m[2]))
  }
  return tables
}

function parseSchemaColumns(src: string): { table: string; column: string }[] {
  return [...src.matchAll(/\{ table: '(\w+)', column: '(\w+)'/g)].map((m) => ({ table: m[1], column: m[2] }))
}

function parseSchemaIndexes(src: string): { name: string; table: string; columns: string[]; ddl: string }[] {
  return [...src.matchAll(/'(CREATE INDEX IF NOT EXISTS (\w+) ON (\w+) \(([^)]*)\))'/g)].map((m) => ({
    ddl: m[1],
    name: m[2],
    table: m[3],
    columns: m[4].split(',').map((c) => c.trim().replace(/\s+DESC$/i, '')),
  }))
}

const sqlTables = parseSchemaSqlTables(schemaSql)
const dbTables = parseDbTsTables(dbTs)
const alterColumns = parseSchemaColumns(dbTs)

test('SCHEMA_TABLES 每张表与 schema.sql 列一致（差集必须由 SCHEMA_COLUMNS 补齐）', () => {
  assert.ok(dbTables.size > 0, 'db.ts SCHEMA_TABLES 解析为空，解析器可能失效')
  for (const [table, dbCols] of dbTables) {
    const sqlCols = sqlTables.get(table)
    assert.ok(sqlCols, `SCHEMA_TABLES 里的 ${table} 在 schema.sql 中不存在`)
    const expected = new Set([...dbCols, ...alterColumns.filter((c) => c.table === table).map((c) => c.column)])
    assert.deepEqual(
      [...sqlCols].sort(),
      [...expected].sort(),
      `${table} 的 schema.sql 与 db.ts SCHEMA_TABLES+SCHEMA_COLUMNS 列不一致（AGENTS 铁律：两处同步）`
    )
  }
})

test('SCHEMA_COLUMNS 每条 ALTER 的列都必须已存在于 schema.sql（新库一次建齐，ALTER 只为老库）', () => {
  for (const { table, column } of alterColumns) {
    assert.ok(sqlTables.get(table)?.has(column), `${table}.${column} 在 schema.sql 建表语句中缺失`)
  }
})

test('SCHEMA_TABLES 的建表语句必须自带本表 SCHEMA_COLUMNS 的全部列（回归：pages 曾漏 deleted_at）', () => {
  // ensureSchema 先跑 SCHEMA_COLUMNS 的 ALTER 再 CREATE（db.ts 顺序即此）：全新库上表还不存在，
  // ALTER 撞 no such table 被吞，CREATE 是这些列的唯一来源——上面那条「并集」测试测不出这种漏
  for (const { table, column } of alterColumns) {
    const dbCols = dbTables.get(table)
    if (!dbCols) continue // 原始表（posts/comments/…）只活在 schema.sql，ALTER 纯为老库，上一条测试守着
    assert.ok(
      dbCols.has(column),
      `SCHEMA_TABLES 的 ${table} 建表缺 ${column}：全新库冷启动该列永久缺失，本 isolate 内所有涉及它的查询 500`
    )
  }
})

test('索引归位：挂在运行时补列上的索引只进 SCHEMA_INDEXES，其余必须同步进 schema.sql', () => {
  const sqlIndexes = new Set([...schemaSql.matchAll(/CREATE INDEX IF NOT EXISTS (\w+)/g)].map((m) => m[1]))
  for (const idx of parseSchemaIndexes(dbTs)) {
    const needsRuntime = idx.columns.some((c) => alterColumns.some((a) => a.table === idx.table && a.column === c))
    if (needsRuntime) {
      assert.ok(!sqlIndexes.has(idx.name), `${idx.name} 建在老库尚不存在的列上，schema.sql 不能出现（老库部署时建索引会报错）`)
    } else {
      assert.ok(sqlIndexes.has(idx.name), `${idx.name} 只在 db.ts SCHEMA_INDEXES 有、schema.sql 缺失（两处同步）`)
    }
    assert.ok(sqlTables.has(idx.table), `${idx.name} 引用的表 ${idx.table} 在 schema.sql 中不存在`)
  }
})

test('会员地基表与列齐备：members / member_sessions / member_points_log + comments.member_id + posts.min_tier', () => {
  for (const t of ['members', 'member_sessions', 'member_points_log']) {
    assert.ok(sqlTables.has(t) && dbTables.has(t), `${t} 表未在 schema.sql 与 db.ts 两处同步登记`)
  }
  assert.ok(sqlTables.get('members')?.has('points'), 'members.points 缺失（排行榜数据源）')
  assert.ok(sqlTables.get('members')?.has('tier'), 'members.tier 缺失')
  assert.ok(alterColumns.some((c) => c.table === 'comments' && c.column === 'member_id'), 'comments.member_id 缺老库 ALTER')
  assert.ok(alterColumns.some((c) => c.table === 'posts' && c.column === 'min_tier'), 'posts.min_tier 缺老库 ALTER')
})

test('备份登记：members 与积分账本进备份，member_sessions 属临时凭证不进', () => {
  const backupSrc = readFileSync(join(ROOT, 'src/backup.ts'), 'utf8')
  const m = backupSrc.match(/const BACKUP_TABLES = \[([^\]]*)\]/)
  assert.ok(m, 'backup.ts BACKUP_TABLES 解析失败')
  const tables = [...m[1].matchAll(/'(\w+)'/g)].map((x) => x[1])
  assert.ok(tables.includes('members'), 'members 必须进每晚备份')
  assert.ok(tables.includes('member_points_log'), '积分账本是审计数据必须进备份')
  assert.ok(!tables.includes('member_sessions'), 'member_sessions 与 sessions 同理是临时凭证，不进备份')
})

// ── ensureSchema 老库升级流程：缺列自动 ALTER、新表自动建、二次执行幂等 ──

function makeFakeOldDb(): { db: D1Database; emitted: string[]; tables: Map<string, Set<string>> } {
  // 老库形态：SCHEMA_COLUMNS 涉及的六表都在，但缺所有待补列（publish_at/deleted_at/member_id/min_tier/description…）
  const tables = new Map<string, Set<string>>(
    Object.entries({
      posts: ['id', 'slug', 'title', 'content', 'summary', 'cover', 'tags', 'status', 'pinned', 'views', 'likes', 'author_id', 'published_at', 'created_at', 'updated_at'],
      weibo: ['id', 'content', 'images', 'status', 'likes', 'published_at', 'created_at', 'updated_at'],
      pages: ['id', 'title', 'slug', 'content', 'status', 'show_in_nav', 'sort', 'created_at', 'updated_at'],
      comments: ['id', 'post_id', 'nickname', 'email', 'website', 'content', 'status', 'ip', 'created_at'],
      uploads: ['id', 'key', 'name', 'mime', 'size', 'created_at'],
      // categories 是 v0.1 起的原始表：老库必然有它，缺的只是 B23 的 description 列
      categories: ['id', 'name', 'slug', 'sort', 'created_at'],
    }).map(([t, cols]) => [t, new Set(cols)])
  )
  const emitted: string[] = []

  function apply(sql: string) {
    const alter = sql.match(/ALTER TABLE (\w+) ADD COLUMN (\w+)/)
    if (alter) {
      tables.get(alter[1])?.add(alter[2])
      return
    }
    const create = sql.match(/CREATE TABLE IF NOT EXISTS (\w+) \(([\s\S]*)\)\s*$/)
    if (create && !tables.has(create[1])) tables.set(create[1], parseCols(create[2]))
  }

  const db = {
    prepare(sql: string) {
      const stmt = {
        bind: () => stmt,
        run: async () => {
          emitted.push(sql)
          apply(sql)
          return { success: true }
        },
        all: async () => {
          const pragma = sql.match(/PRAGMA table_info\((\w+)\)/)
          if (pragma) {
            const cols = tables.get(pragma[1])
            return { results: cols ? [...cols].map((name) => ({ name })) : [] }
          }
          return { results: [] }
        },
        first: async () => (sql.includes('pagesSeeded') ? { value: '1' } : null),
      }
      return stmt
    },
    batch: async (stmts: { run(): Promise<unknown> }[]) => {
      for (const s of stmts) await s.run()
      return []
    },
  }
  return { db: db as unknown as D1Database, emitted, tables }
}

test('ensureSchema：老库补齐 member_id / min_tier 两列并新建会员三表', async () => {
  const { db, emitted, tables } = makeFakeOldDb()
  await ensureSchema(db)
  assert.ok(emitted.some((s) => s.includes('ALTER TABLE comments ADD COLUMN member_id')), '老库未补 comments.member_id')
  assert.ok(emitted.some((s) => s.includes('ALTER TABLE posts ADD COLUMN min_tier')), '老库未补 posts.min_tier')
  for (const t of ['members', 'member_sessions', 'member_points_log']) {
    assert.ok(tables.has(t), `老库未新建 ${t}`)
    assert.ok(emitted.some((s) => s.startsWith(`CREATE TABLE IF NOT EXISTS ${t}`)), `${t} 未出现在执行语句中`)
  }
  assert.ok(tables.get('members')?.has('points'), 'members 建表缺 points 列')
  assert.ok(tables.get('comments')?.has('member_id'), 'ALTER 后 comments 仍缺 member_id')
  assert.ok(tables.get('posts')?.has('min_tier'), 'ALTER 后 posts 仍缺 min_tier')
})

test('ensureSchema：二次执行幂等，不再发任何 ALTER', async () => {
  const { db, emitted, tables } = makeFakeOldDb()
  await ensureSchema(db)
  emitted.length = 0
  await ensureSchema(db)
  assert.ok(emitted.every((s) => !s.includes('ALTER TABLE')), '二次执行仍发 ALTER，迁移不幂等')
  assert.ok(tables.has('members'))
})
