import { test } from 'node:test'
import assert from 'node:assert/strict'
import { DatabaseSync, type StatementSync } from 'node:sqlite'
import { getSettings, invalidateSharedSettings, saveSettings } from '../src/db.ts'

// ── settings 读取的共享快照层（src/db.ts getSettings，Cache API + in-flight 去重）──
// 防线：一切写 settings 的路径写完必须 await invalidateSharedSettings(db)——生产 Workers 上
// caches.default 是 colo 级共享，写路径 delete 是推送式失效，写返回后任何 isolate 读必见新值；
// 忘了失效 = 改完设置最多 300s 读旧值。Node 测试与 docker-poc 无 caches.default，退化直查
// （docker-poc 单进程天然一致）；并发按 in-flight 去重，按 db 实例 WeakMap 隔离防串租户。

const SETTINGS_SQL = 'SELECT key, value FROM settings'

/** 极简 D1 适配（同 fts.test.ts 口径）：prepare().bind().run/all/first + batch */
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

/** 计数代理：统计 getSettings 那发 SELECT 的次数（其余 SQL 透传真实适配器） */
function countingD1(db: DatabaseSync) {
  let selects = 0
  const inner = d1FromSqlite(db)
  const d1 = {
    prepare: (sql: string) => {
      if (sql === SETTINGS_SQL) {
        const bound = inner.prepare(sql)
        return { bind: bound.bind, all: async <T>() => ((selects++), bound.all<T>()) }
      }
      return inner.prepare(sql)
    },
    batch: (stmts: { run: () => Promise<unknown> }[]) => inner.batch(stmts),
  } as unknown as D1Database
  return { d1, count: () => selects }
}

function sqliteWithSettings(): DatabaseSync {
  const db = new DatabaseSync(':memory:')
  db.exec("CREATE TABLE settings (key TEXT PRIMARY KEY, value TEXT NOT NULL DEFAULT '')")
  return db
}

/** 伪造 caches.default（Map 内存实现，模拟 workerd colo 级共享快照层），测完摘除 */
function fakeSharedCache() {
  const store = new Map<string, Response>()
  ;(globalThis as unknown as { caches?: unknown }).caches = {
    default: {
      match: async (key: unknown) => {
        const hit = store.get(String(key))
        // 真实 Cache API 每次 match 给出独立 body（同 clone），stub 必须复刻，
        // 否则第二个读者消费掉同一 Response 的 body 会误判 miss
        return hit ? hit.clone() : undefined
      },
      put: async (key: unknown, res: Response) => {
        store.set(String(key), res)
      },
      delete: async (key: unknown) => {
        store.delete(String(key))
        return true
      },
    },
  }
  return () => {
    delete (globalThis as unknown as { caches?: unknown }).caches
  }
}

test('共享快照层：同数据两个 db 包装（模拟两 isolate）连读只打一发 SQL', async () => {
  const restore = fakeSharedCache()
  try {
    const db = sqliteWithSettings()
    db.exec("INSERT INTO settings (key, value) VALUES ('siteTitle', '共享站')")
    const a = countingD1(db)
    const b = countingD1(db)

    const a1 = await getSettings(a.d1)
    assert.equal(a1.siteTitle, '共享站')
    assert.equal(a.count(), 1, '冷启动首发直查 D1 并回填共享快照')

    // 此刻共享快照已在场：另一 isolate（b）与 a 的后续读都命中，不再打 D1
    const [b1, a2] = await Promise.all([getSettings(b.d1), getSettings(a.d1)])
    assert.equal(b1.siteTitle, '共享站')
    assert.equal(a2.siteTitle, '共享站')
    assert.equal(a.count() + b.count(), 1, '共享快照回填后，另一 isolate 的读必须命中，不再打 D1')
  } finally {
    restore()
  }
})

test('共享快照层：任一实例写完，另一实例立即读到新值（delete 推送失效，无 TTL 旧值窗口）', async () => {
  const restore = fakeSharedCache()
  try {
    const db = sqliteWithSettings()
    await saveSettings(d1FromSqlite(db), { siteTitle: '旧名' })
    const a = countingD1(db)
    const b = countingD1(db)

    const before = await getSettings(a.d1)
    assert.equal(before.siteTitle, '旧名')
    assert.equal(a.count(), 1)

    // 另一 isolate 的写：写库 + 推送失效共享快照
    await saveSettings(b.d1, { siteTitle: '新名' })

    const after = await getSettings(a.d1)
    assert.equal(after.siteTitle, '新名', 'A 的读必须 miss 共享层后重查库，绝不能拿到 30s/300s 旧值')
    assert.ok(a.count() > 1, '失效后必须真的重查了 D1')
  } finally {
    restore()
  }
})

test('无 caches 环境（Node 测试 / docker-poc）：getSettings 退化为直查，写后天然一致', async () => {
  const { d1, count } = countingD1(sqliteWithSettings())
  await saveSettings(d1, { siteTitle: '旧名' })
  const before = await getSettings(d1)
  assert.equal(before.siteTitle, '旧名')
  await saveSettings(d1, { siteTitle: '新名' })
  const after = await getSettings(d1)
  assert.equal(after.siteTitle, '新名')
  assert.equal(count(), 2, '无共享层时每读直查（=缓存功能上线前的行为）')
})

test('getSettings：并发请求按 in-flight 去重，只打一发 SQL', async () => {
  let selects = 0
  const rows = [{ key: 'siteTitle', value: '并发站' }]
  const slowD1 = {
    prepare: (sql: string) =>
      sql === SETTINGS_SQL
        ? {
            all: async <T>() => {
              selects++
              await new Promise((r) => setTimeout(r, 5))
              return { results: rows as T[] }
            },
          }
        : { all: async () => ({ results: [] }) },
  } as unknown as D1Database

  const all = await Promise.all(Array.from({ length: 5 }, () => getSettings(slowD1)))
  assert.equal(selects, 1, '5 个并发只打一发 SQL')
  for (const s of all) assert.equal(s.siteTitle, '并发站')
})

test('invalidateSharedSettings：无 caches 环境调用是安全 no-op', async () => {
  const db = sqliteWithSettings()
  await invalidateSharedSettings(d1FromSqlite(db))
})

test('getSettings：查询失败不滞留 in-flight 槽位，恢复后可重查', async () => {
  let fail = true
  let selects = 0
  const d1 = {
    prepare: (sql: string) =>
      sql === SETTINGS_SQL
        ? {
            all: async <T>() => {
              selects++
              if (fail) throw new Error('boom')
              return { results: [{ key: 'siteTitle', value: '恢复' }] as T[] }
            },
          }
        : { all: async () => ({ results: [] }) },
  } as unknown as D1Database

  await assert.rejects(() => getSettings(d1), /boom/)
  fail = false
  const s = await getSettings(d1)
  assert.equal(s.siteTitle, '恢复', '失败后 in-flight 必须被清掉，不能永久滞留 rejected promise')
})
