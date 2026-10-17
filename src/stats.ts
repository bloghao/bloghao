/**
 * 访客统计：前台 site.js 打点 → POST /api/public/track 落 visit_log 表，
 * 后台「统计」页 GET /api/admin/visits 聚合展示（见 tests/stats.test.ts）。
 *
 * 隐私边界：只存匿名 vid（localStorage 随机 id）、来源域名、国家码（CF-IPCountry），
 * 不存 IP、不存原始 UA；日志保留 180 天，由每晚备份 cron 顺带清理（purgeVisits）。
 * 文章页「阅读量」仍是 posts.views（pages.ts SSR 自增），与本表互不相干。
 */
import { fmtDate } from './utils'

/** 访客日志保留天数 */
export const VISIT_KEEP_DAYS = 180

/** UA → 设备类型。先判 tablet 再判 mobile：Android 平板 UA 同样含 Android 但不含 Mobile */
export function classifyDevice(ua: string): 'mobile' | 'tablet' | 'desktop' {
  const s = ua || ''
  if (/iPad|Tablet|PlayBook|Silk/.test(s) || (/Android/.test(s) && !/Mobile/.test(s))) return 'tablet'
  if (/Mobi|iPhone|Android|Windows Phone|Phone/.test(s)) return 'mobile'
  return 'desktop'
}

/** UA → 浏览器族。微信内置浏览器（MicroMessenger）的 UA 里嵌着整串 Chrome 串、
 *  Edge（Edg/）也是 Chromium——判断顺序不能换：微信 → Edge → Firefox → Chrome → Safari */
export function classifyBrowser(ua: string): string {
  const s = ua || ''
  if (/MicroMessenger/i.test(s)) return 'wechat'
  if (/Edg\//.test(s)) return 'edge'
  if (/Firefox|FxiOS/.test(s)) return 'firefox'
  if (/Chrome|CriOS/.test(s)) return 'chrome'
  if (/Safari/.test(s)) return 'safari'
  return 'other'
}

/** 来源页 → 只留域名。先剥 \t\r\n 再 new URL 解析（URL 解析器会忽略这些字符，
 *  原始串判断不可靠）；解析失败 / 非 http(s) 一律空串。 */
export function cleanRef(raw: unknown): string {
  const s = String(raw ?? '')
    .replace(/[\t\r\n]/g, '')
    .trim()
  if (!s) return ''
  try {
    const u = new URL(s)
    if (u.protocol !== 'http:' && u.protocol !== 'https:') return ''
    return u.host.slice(0, 100)
  } catch {
    return ''
  }
}

/** 上报路径：剥控制字符、必须以 / 开头且第二字符不是 /（拒协议相对 URL //evil.com，
 *  防伪打点把跨站链接塞进后台统计页的「受欢迎的页面」）、截 300（含 query）。
 *  裸 `/`（首页）合法：第二字符「不是 /」的拒绝对它按「不存在第二字符」放行。 */
export function cleanPath(raw: unknown): string {
  const s = String(raw ?? '').replace(/[\u0000-\u001f\u007f]/g, '')
  return /^\/(?:$|[^/])/.test(s) ? s.slice(0, 300) : ''
}

/** 匿名访客 id：只放行 [A-Za-z0-9_-]，截 64 */
export function cleanVid(raw: unknown): string {
  return String(raw ?? '')
    .replace(/[^A-Za-z0-9_-]/g, '')
    .slice(0, 64)
}

/** 页面标题：剥控制字符，截 200（展示时在后台再过 esc） */
export function cleanTitle(raw: unknown): string {
  return String(raw ?? '')
    .replace(/[\u0000-\u001f\u007f]/g, '')
    .slice(0, 200)
}

/** 写入一条访客日志（day 按北京时间落好，聚合不再算时区） */
export async function recordVisit(
  db: D1Database,
  input: { vid: string; path: string; title: string; ref: string; dev: string; br: string; country: string }
): Promise<void> {
  const ts = Date.now()
  await db
    .prepare(
      'INSERT INTO visit_log (ts, day, vid, path, title, ref, dev, br, country) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)'
    )
    .bind(ts, fmtDate(ts), input.vid, input.path, input.title, input.ref, input.dev, input.br, input.country)
    .run()
}

/** 清理过期访客日志（每晚备份 cron 调用） */
export async function purgeVisits(db: D1Database, keepDays = VISIT_KEEP_DAYS): Promise<void> {
  const cutoff = Date.now() - keepDays * 86_400_000
  await db.prepare('DELETE FROM visit_log WHERE ts < ?').bind(cutoff).run()
}

export interface VisitStats {
  days: number
  pv: number
  uv: number
  todayPv: number
  todayUv: number
  series: { day: string; pv: number; uv: number }[]
  topPages: { path: string; title: string; pv: number; uv: number }[]
  topRefs: { ref: string; pv: number; uv: number }[]
  devices: { name: string; pv: number }[]
  browsers: { name: string; pv: number }[]
  countries: { name: string; pv: number }[]
  hourly: { h: number; pv: number }[]
}

/** 后台「统计」页聚合：区间为含今天共 days 天（北京时间），缺数据的天补零 */
export async function getVisitStats(db: D1Database, days: number): Promise<VisitStats> {
  const now = Date.now()
  const today = fmtDate(now)
  const startDay = fmtDate(now - (days - 1) * 86_400_000)
  const inRange = 'day >= ? AND day <= ?'
  const [sum, seriesRows, pageRows, refRows, devRows, brRows, countryRows, hourRows] = await Promise.all([
    db
      .prepare(`SELECT COUNT(*) AS pv, COUNT(DISTINCT vid) AS uv FROM visit_log WHERE ${inRange}`)
      .bind(startDay, today)
      .first<{ pv: number; uv: number }>(),
    db
      .prepare(
        `SELECT day, COUNT(*) AS pv, COUNT(DISTINCT vid) AS uv FROM visit_log WHERE ${inRange} GROUP BY day ORDER BY day`
      )
      .bind(startDay, today)
      .all<{ day: string; pv: number; uv: number }>(),
    db
      .prepare(
        `SELECT path, MAX(title) AS title, COUNT(*) AS pv, COUNT(DISTINCT vid) AS uv
         FROM visit_log WHERE ${inRange} GROUP BY path ORDER BY pv DESC, path LIMIT 10`
      )
      .bind(startDay, today)
      .all<{ path: string; title: string; pv: number; uv: number }>(),
    db
      .prepare(
        `SELECT ref, COUNT(*) AS pv, COUNT(DISTINCT vid) AS uv
         FROM visit_log WHERE ${inRange} AND ref != '' GROUP BY ref ORDER BY pv DESC, ref LIMIT 10`
      )
      .bind(startDay, today)
      .all<{ ref: string; pv: number; uv: number }>(),
    db
      .prepare(`SELECT dev AS name, COUNT(*) AS pv FROM visit_log WHERE ${inRange} AND dev != '' GROUP BY dev ORDER BY pv DESC`)
      .bind(startDay, today)
      .all<{ name: string; pv: number }>(),
    db
      .prepare(
        `SELECT br AS name, COUNT(*) AS pv FROM visit_log WHERE ${inRange} AND br != '' GROUP BY br ORDER BY pv DESC, name LIMIT 8`
      )
      .bind(startDay, today)
      .all<{ name: string; pv: number }>(),
    db
      .prepare(
        `SELECT country AS name, COUNT(*) AS pv FROM visit_log WHERE ${inRange} AND country != '' GROUP BY country ORDER BY pv DESC, name LIMIT 10`
      )
      .bind(startDay, today)
      .all<{ name: string; pv: number }>(),
    db
      .prepare(
        `SELECT CAST(strftime('%H', ts / 1000 + 28800, 'unixepoch') AS INTEGER) AS h, COUNT(*) AS pv
         FROM visit_log WHERE day = ? GROUP BY h`
      )
      .bind(today)
      .all<{ h: number; pv: number }>(),
  ])

  const seriesMap = new Map((seriesRows.results ?? []).map((r) => [r.day, r]))
  // 今天的数据直接取自 series（同表同区间 GROUP BY day 的结果里就有），不再单发一条查询
  const todayRow = seriesMap.get(today)
  const series: VisitStats['series'] = []
  for (let i = days - 1; i >= 0; i--) {
    const day = fmtDate(now - i * 86_400_000)
    const r = seriesMap.get(day)
    series.push({ day, pv: r?.pv ?? 0, uv: r?.uv ?? 0 })
  }
  const hourMap = new Map((hourRows.results ?? []).map((r) => [r.h, r.pv]))
  const hourly: VisitStats['hourly'] = []
  for (let h = 0; h < 24; h++) hourly.push({ h, pv: hourMap.get(h) ?? 0 })

  return {
    days,
    pv: sum?.pv ?? 0,
    uv: sum?.uv ?? 0,
    todayPv: todayRow?.pv ?? 0,
    todayUv: todayRow?.uv ?? 0,
    series,
    topPages: pageRows.results ?? [],
    topRefs: refRows.results ?? [],
    devices: devRows.results ?? [],
    browsers: brRows.results ?? [],
    countries: countryRows.results ?? [],
    hourly,
  }
}
