import { test } from 'node:test'
import assert from 'node:assert/strict'
import { awardPoints } from '../src/points.ts'

// ── awardPoints 的 adminAdjust 分支（src/points.ts）──
// members.test.ts 覆盖了日上限批内守卫与评论幂等；本文件专钉 AGENTS 积分防线的两条
// adminAdjust 硬约束：① refId 在代码层强制归 0（不进 (member_id, reason, ref_id) 部分
// 唯一索引——「别给 adminAdjust 传非 0 refId」的硬约束版，防调用方误传被索引当成幂等键
// 静默丢账）；② 不受日上限约束、delta 可负。桩形态仿 members.test 的 fakePointsDb：
// 当日累计按桩内全部账本行计算（测试时间窗内都算当天），条件批谓词与 points.ts 同口径。

interface LogRow {
  member_id: number
  delta: number
  reason: string
  ref_id: number
}

/** 最小 D1 桩：账本 INSERT / 余额条件 UPDATE / 超额条件 DELETE / SUM 预查 / 余额回读 */
function fakeDb(opts: { initial?: number; failInsertWith?: string } = {}) {
  const log: LogRow[] = []
  let balance = opts.initial ?? 0
  const daySum = (memberId: unknown, reason: unknown) =>
    log.filter((l) => l.member_id === memberId && l.reason === reason).reduce((x, l) => x + l.delta, 0)
  const self = {
    async run(this: { sql: string; args: unknown[] }) {
      const { sql, args } = this
      if (sql.includes('INSERT INTO member_points_log')) {
        if (opts.failInsertWith) throw new Error(opts.failInsertWith)
        log.push({ member_id: args[0] as number, delta: args[1] as number, reason: args[2] as string, ref_id: args[3] as number })
        return { success: true, meta: { changes: 1 } }
      }
      if (sql.includes('UPDATE members SET points')) {
        // 条件批的②：SUM（含本批 INSERT，桩按顺序执行天然可见）超日上限则 changes=0 不入账
        if (sql.includes(') <= ?')) {
          const sum = daySum(args[3], args[4])
          if (sum > (args[6] as number)) return { success: true, meta: { changes: 0 } }
        }
        balance += args[0] as number
        return { success: true, meta: { changes: 1 } }
      }
      if (sql.includes('DELETE FROM member_points_log')) {
        // 条件批的③：与②谓词互斥，超额时把本批插入的行摘除
        if (sql.includes(') > ?')) {
          const sum = daySum(args[3], args[4])
          if (sum > (args[6] as number)) {
            const before = log.length
            for (let i = log.length - 1; i >= 0; i--) {
              if (log[i].member_id === args[0] && log[i].reason === args[1] && log[i].ref_id === args[2]) log.splice(i, 1)
            }
            return { success: true, meta: { changes: before - log.length } }
          }
        }
        return { success: true, meta: { changes: 0 } }
      }
      throw new Error('桩未实现的 SQL：' + sql)
    },
    async first(this: { sql: string; args: unknown[] }) {
      const { sql, args } = this
      if (sql.includes('COALESCE(SUM(delta)')) return { s: daySum(args[0], args[1]) }
      if (sql.includes('SELECT points FROM members')) return { points: balance }
      return null
    },
  }
  const db = {
    prepare(sql: string) {
      const stmt = {
        sql,
        args: [] as unknown[],
        bind: (...a: unknown[]) => {
          stmt.args = a
          return stmt
        },
        run: self.run,
        first: self.first,
      }
      return stmt
    },
    batch: async (stmts: { run: () => Promise<unknown> }[]) => {
      const out = []
      for (const s of stmts) out.push(await s.run())
      return out
    },
  }
  return { db: db as unknown as D1Database, log, balance: () => balance }
}

test('adminAdjust：调用方误传非 0 refId 也被代码层强制归 0（不进幂等唯一索引）', async () => {
  const f = fakeDb()
  const r = await awardPoints(f.db, 1, 'adminAdjust', { delta: 5, refId: 99 })
  assert.equal(r.ok, true)
  assert.equal(f.log.length, 1)
  assert.equal(f.log[0].ref_id, 0, 'ref_id 必须为 0：部分唯一索引 WHERE ref_id > 0 不收管理员调整')
  assert.equal(f.log[0].delta, 5)
})

test('adminAdjust：不受日上限约束（当日刷满仍入账），delta 可负', async () => {
  const f = fakeDb({ initial: 100 })
  // comment 日上限 = dailyCap 10 × delta 2 = 20 分：记满 10 条后再发第 11 条被拒
  for (let i = 1; i <= 10; i++) await awardPoints(f.db, 1, 'comment', { refId: i })
  assert.equal(f.balance(), 120, '10 条评论 +20 分')
  const over = await awardPoints(f.db, 1, 'comment', { refId: 11 })
  assert.equal(over.ok, false, '第 11 条被日上限拦下')
  const adj = await awardPoints(f.db, 1, 'adminAdjust', { delta: -50 })
  assert.equal(adj.ok, true, '管理员调整不受日上限约束')
  assert.equal(adj.balance, 70, '100 + 20 - 50 = 70')
  assert.equal(f.log.at(-1)?.delta, -50)
})

test('adminAdjust：delta 0 与未知 reason 一律拒绝且不写库', async () => {
  const f = fakeDb()
  assert.equal((await awardPoints(f.db, 1, 'adminAdjust', { delta: 0 })).ok, false)
  assert.equal((await awardPoints(f.db, 1, 'constructor', { delta: 5 })).ok, false, '原型链属性穿透 reason 被 hasOwnProperty 拒绝')
  assert.equal(f.log.length, 0)
})

test('并发重复记账撞部分唯一索引：UNIQUE 错误捕获为「未记账」而非抛错', async () => {
  const f = fakeDb({ failInsertWith: 'UNIQUE constraint failed: member_points_log.member_id, member_points_log.reason, member_points_log.ref_id' })
  const r = await awardPoints(f.db, 1, 'comment', { refId: 7 })
  assert.equal(r.ok, false, '视为已记过，静默不落')
  assert.equal(r.delta, 0)
})
