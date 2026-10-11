/**
 * D1 → node:sqlite 适配层（自托管 POC，docker-poc/ 独立目录，不影响仓库主代码）。
 *
 * 只覆盖业务代码实际用到的 API 面（对 src/ 全量 grep 过）：
 *   db.prepare(sql).bind(...).first() / .all() / .run()
 *   db.batch([stmt, ...])
 *   res.meta.changes / res.meta.last_row_id
 * 未用到 exec / raw / withSession，这里给保底实现，将来误用时报错可读。
 *
 * 两个方言差异的处理：
 * - node:sqlite 查出来的行是 null 原型对象，统一展开成普通对象
 *   （业务代码大量解构 / JSON 序列化 / hasOwnProperty 判断，普通对象最安全）
 * - D1 不接受 undefined / boolean 绑定，这里 undefined→null、boolean→1/0
 */
import { DatabaseSync } from 'node:sqlite'

function normValue(v: unknown): null | number | string {
  if (v === undefined || v === null) return null
  if (typeof v === 'boolean') return v ? 1 : 0
  if (typeof v === 'number' || typeof v === 'string') return v
  throw new Error(`[d1-shim] 不支持的绑定类型: ${typeof v}（SQL 绑定值只允许 null/number/string）`)
}

type Row = Record<string, unknown>

function plainRow(row: Row | undefined | null): Row | null {
  return row ? { ...row } : null
}

class ShimStatement {
  sql: string
  args: (null | number | string)[] = []
  private db: DatabaseSync

  constructor(db: DatabaseSync, sql: string) {
    this.db = db
    this.sql = sql
  }

  bind(...args: unknown[]): ShimStatement {
    this.args = args.map(normValue)
    return this
  }

  /** run 的同步版：batch 在同一事务里逐条执行时用 */
  _runSync(): { success: true; meta: { changes: number; last_row_id: number; duration: number } } {
    const info = this.db.prepare(this.sql).run(...(this.args as never[]))
    return {
      success: true,
      meta: {
        changes: Number(info.changes ?? 0),
        last_row_id: Number(info.lastInsertRowid ?? 0),
        duration: 0,
      },
    }
  }

  async run() {
    return this._runSync()
  }

  async first<T = Row>(): Promise<T | null> {
    const row = this.db.prepare(this.sql).get(...(this.args as never[])) as Row | undefined
    return plainRow(row) as T | null
  }

  async all<T = Row>(): Promise<{ results: T[]; meta: Record<string, never> }> {
    const rows = this.db.prepare(this.sql).all(...(this.args as never[])) as Row[]
    return { results: rows.map((r) => ({ ...r })) as T[], meta: {} }
  }

  async raw<T = Row>(): Promise<unknown[][]> {
    const rows = this.db.prepare(this.sql).all(...(this.args as never[])) as Row[]
    return rows.map((r) => Object.values(r))
  }
}

export type D1Shim = ReturnType<typeof createD1>

export function createD1(file: string) {
  const db = new DatabaseSync(file)
  // WAL：读不阻塞写；busy_timeout 防多进程（未来分实例）偶发锁冲突
  db.exec('PRAGMA journal_mode = WAL; PRAGMA busy_timeout = 5000; PRAGMA synchronous = NORMAL; PRAGMA foreign_keys = ON;')

  async function batch(stmts: ShimStatement[]) {
    const out: ReturnType<ShimStatement['_runSync']>[] = []
    db.exec('BEGIN IMMEDIATE')
    try {
      for (const s of stmts) out.push(s._runSync())
      db.exec('COMMIT')
    } catch (e) {
      db.exec('ROLLBACK')
      throw e
    }
    return out
  }

  return {
    prepare: (sql: string) => new ShimStatement(db, sql),
    batch,
    // D1.exec 用于多语句脚本；node:sqlite 原生支持
    exec: async (sql: string) => {
      db.exec(sql)
      return []
    },
    withSession: () => {
      throw new Error('[d1-shim] withSession 未实现（业务代码未用到）')
    },
    close: () => db.close(),
  }
}
