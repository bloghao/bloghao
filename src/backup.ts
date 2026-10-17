/**
 * 每晚自动备份：Cloudflare Cron Trigger 定时把 D1 全表快照存进 R2
 *
 * - 备份文件：IMAGES 桶 backups/xwblog-YYYY-MM-DD.json（北京时间日期，同一天重跑覆盖）
 * - 保留策略：滚动保留最近 KEEP_DAYS 份，更早的自动删除
 * - 开关：后台「设置 → 订阅与备份」；lastBackupAt/lastBackupBytes 记录最近一次结果
 * - 本地验证：wrangler dev --test-scheduled 后 curl "http://localhost:8787/__scheduled?cron=30+16+*+*+*"
 */
import { getSettings, saveSettings } from './db'
import { fireBackupCompleted } from './hooks'
import { notifyAdminText } from './external'
import { purgeExpiredSessions, purgeExpiredMemberSessions } from './auth'
import type { Env } from './types'
import { fmtDate, isoDate } from './utils'

const BACKUP_PREFIX = 'backups/'
const KEEP_FILES = 30
// 会话表是临时凭证（管理员的 sessions 与会员的 member_sessions）、tg_buffer 是相册合并缓冲，都不值得备份
const BACKUP_TABLES = [
  'users',
  'members',
  'member_points_log',
  'posts',
  'pages',
  'comments',
  'categories',
  'post_categories',
  'weibo',
  'tags',
  'uploads',
  'friend_links',
  'settings',
]
const TABLE_ROW_LIMIT = 100_000

export interface BackupResult {
  ok: boolean
  key?: string
  bytes?: number
  tables?: number
  skipped?: boolean
  error?: string
  /** 超过单次导出上限、只含部分数据的表（表名(总行数/已导出)） */
  truncated?: string[]
}

/** 全表导出成一份 JSON 存进 R2，并回写 lastBackup* 设置 */
export async function runBackup(env: Env): Promise<BackupResult> {
  try {
    const settings = await getSettings(env.DB)
    if (settings.backupEnabled === '0') return { ok: false, skipped: true, error: 'disabled' }

    const tables: Record<string, unknown[]> = {}
    const truncated: string[] = []
    for (const table of BACKUP_TABLES) {
      // 先数总行数再导出：超过 LIMIT 的表会在备份文件与 TG 里告警，避免静默截断丢数据
      const cnt = await env.DB.prepare(`SELECT COUNT(*) AS n FROM ${table}`).first<{ n: number }>()
      const { results } = await env.DB.prepare(`SELECT * FROM ${table} LIMIT ?`).bind(TABLE_ROW_LIMIT).all()
      if ((cnt?.n ?? 0) > (results?.length ?? 0)) truncated.push(`${table}(${cnt?.n}/${results?.length})`)
      tables[table] = results ?? []
    }
    // 文件名用北京时间日期（utils.fmtDate，与全站 +8h 口径同源，别再手拼偏移）
    const key = `${BACKUP_PREFIX}xwblog-${fmtDate(Date.now())}.json`
    const payload = JSON.stringify({
      app: 'xwblog',
      version: 1,
      exportedAt: isoDate(Date.now()),
      truncatedTables: truncated,
      tables,
    })
    await env.IMAGES.put(key, payload, {
      httpMetadata: { contentType: 'application/json; charset=utf-8' },
    })
    const bytes = new TextEncoder().encode(payload).length

    // 滚动清理：按文件名（即日期）排序，只留最近 KEEP_FILES 份
    const listed = await env.IMAGES.list({ prefix: BACKUP_PREFIX, limit: 1000 })
    const olds = (listed.objects ?? [])
      .map((o) => o.key)
      .filter((k) => k !== key)
      .sort()
    for (const k of olds.slice(0, Math.max(0, olds.length + 1 - KEEP_FILES))) {
      await env.IMAGES.delete(k)
    }

    await saveSettings(env.DB, {
      lastBackupAt: String(Date.now()),
      lastBackupKey: key,
      lastBackupBytes: String(bytes),
    })
    return { ok: true, key, bytes, tables: BACKUP_TABLES.length, truncated }
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) }
  }
}

/** Cron 入口：备份失败 / 表超限截断时尽量推一条 Telegram 给站长（成功不打扰） */
export async function scheduledBackup(_controller: unknown, env: Env): Promise<void> {
  // 顺带清理过期会话（管理员 + 会员，一天一次足够），失败不影响备份
  try {
    await purgeExpiredSessions(env.DB)
    await purgeExpiredMemberSessions(env.DB)
  } catch {
    /* ignore */
  }
  const r = await runBackup(env)
  if (r.ok && !r.skipped) {
    // 备份完成广播（src/hooks.ts）：异地备份类插件凭 payload.key 从 R2 取件推送；
    // cron 无 waitUntil 可用，直接 await——夜间任务不差这十几秒
    await fireBackupCompleted(env, { key: r.key ?? '', bytes: r.bytes ?? 0, tables: r.tables ?? 0, at: Date.now() }).catch(() => {})
  }
  if (r.truncated?.length) {
    await notifyAdminText(
      env,
      `⚠️ 昨晚的备份里这些表超过单次导出上限（10 万行），只包含了部分数据：\n${r.truncated.join('\n')}\n建议尽快手动分批导出这份完整数据。`
    )
  }
  if (!r.ok && !r.skipped) {
    await notifyAdminText(env, `⚠️ 昨晚的数据库备份失败了\n原因：${r.error || '未知'}\n到后台「订阅与备份」点「立即备份」重试，或检查 R2 / D1 状态。`)
  }
}
