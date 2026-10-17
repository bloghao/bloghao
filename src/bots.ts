/**
 * 爬虫与 AI 抓取识别（后台「统计」页新维度，见 tests/bots.test.ts）。
 *
 * 背景：前台统计（site.js 打点 → visit_log）依赖浏览器执行 JS，爬虫不执行——
 * 现有访客数据里根本看不到爬虫。这里在服务端按 User-Agent 识别后旁路落 bot_log，
 * waitUntil 异步写不阻塞响应；只存识别名/类别 + 路径 + 国家码，不存 IP、不存 UA 原文，
 * 隐私口径与 visit_log 一致（见 stats.ts 头注释）。日志保留 180 天，由每晚备份 cron
 * 顺带清理（purgeBots），不进备份（日志类数据）。
 *
 * 写入闸（公开路径任何人可携任意 UA 触发，防 D1 写配额被刷爆，状态在 isolate 内存）：
 *  1. 去抖——同一（爬虫名+路径）30 秒内只记一次，风暴型爬虫按次采样；
 *  2. 预算——每个 isolate 每 10 分钟最多 300 条，防止穷举路径绕过去抖（换路径即新键）。
 * 两者都只在内存层，被闸掉的抓取不落库——页面展示的数字是「采样下界」，口径如此。
 */
import { fmtDate } from './utils'

/** 爬虫日志保留天数（与 VISIT_KEEP_DAYS 同口径） */
export const BOT_KEEP_DAYS = 180

/* ---------------- 识别规则（单表驱动，顺序即优先级） ----------------
 * re 匹配 UA 片段；kind 决定分组：
 *   ai      —— AI **训练 / 语料**抓取（GPTBot/CCBot/字节/Meta…：抓下来喂模型，来源常不署名）
 *   ai-seek —— AI **检索引用**抓取（OAI-SearchBot/PerplexityBot/Claude 检索…：用户提问时实时读，
 *              回答里带来源链接——站长要的正是这条；与训练型商业含义相反，故分两档）
 *   se   —— 搜索引擎（参与收录排名，站长关心）
 *   feed —— RSS/订阅器（读的是 feed，不是页面）
 *   seo  —— SEO/营销爬虫（第三方分析服务，通常站长没主动请过）
 *   arch —— 网页存档（Internet Archive 等，存快照不参与排名）
 * 未命中的 UA 一律不落库——bot_log 只收识别出的爬虫，浏览器流量永远进 visit_log，
 * 两条数据流天然互斥；伪装 UA 的人工访问会被归进爬虫（拿它没办法，UA 本来就可伪造）。
 *
 * 历史口径：'ai-seek' 是 2026-10-17 从 'ai' 里拆出来的（此前 OAI-SearchBot/PerplexityBot 等
 * 也记成 'ai'）。bot_log 是采样下界 + 180 天轮换的日志，旧行不重分类，一律按训练型展示。 */

export type BotKind = 'ai' | 'ai-seek' | 'se' | 'feed' | 'seo' | 'arch'

export interface BotRule {
  re: RegExp
  name: string
  kind: BotKind
  /** 该规则在 robots.txt 里声明的 UA 令牌（仅 AI 两类需要填）。显示名与令牌常不同
   *  （如「字节爬虫」→ Bytespider、「Meta AI」→ meta-externalagent），且一条规则可覆盖
   *  多个令牌（Meta AI = meta-externalagent + FacebookBot）。
   *  AI_TRAIN_AGENTS / AI_SEEK_AGENTS 由本字段派生——新增 AI 爬虫只加一条规则并填上令牌，
   *  robots 策略（src/seo.ts）自动跟进，别再手抄第二份名单。 */
  robots?: string[]
}

export const BOT_RULES: BotRule[] = [
  /* ---- AI 检索引用（用户提问时实时抓取，回答里带来源链接）---- */
  { re: /OAI-SearchBot/i, name: 'OAI-SearchBot', kind: 'ai-seek', robots: ['OAI-SearchBot'] }, // OpenAI 联网搜索索引
  { re: /ChatGPT-User/i, name: 'ChatGPT', kind: 'ai-seek', robots: ['ChatGPT-User'] }, // 用户实时联网引用
  { re: /Claude-SearchBot/i, name: 'Claude 检索', kind: 'ai-seek', robots: ['Claude-SearchBot'] }, // Claude 搜索索引
  { re: /Claude-User/i, name: 'Claude 抓取', kind: 'ai-seek', robots: ['Claude-User'] }, // Claude 用户触发实时抓取
  { re: /Perplexity-User/i, name: 'Perplexity-User', kind: 'ai-seek', robots: ['Perplexity-User'] },
  { re: /PerplexityBot/i, name: 'PerplexityBot', kind: 'ai-seek', robots: ['PerplexityBot'] },
  { re: /YouBot/i, name: 'YouBot', kind: 'ai-seek', robots: ['YouBot'] }, // You.com（AI 答案引擎，回答署名来源）
  { re: /DuckAssistBot/i, name: 'DuckDuckGo AI', kind: 'ai-seek', robots: ['DuckAssistBot'] }, // DDG 的 AI 摘要（搜索产品功能）
  /* ---- AI 训练 / 语料（抓下来喂模型；Google-Extended / Applebot-Extended 不影响搜索收录）---- */
  { re: /GPTBot/i, name: 'GPTBot', kind: 'ai', robots: ['GPTBot'] }, // OpenAI 训练抓取
  { re: /ClaudeBot|Claude-Web/i, name: 'ClaudeBot', kind: 'ai', robots: ['ClaudeBot', 'Claude-Web'] }, // Anthropic 训练（Claude-Web 是旧名）
  { re: /Google-Extended/i, name: 'Google-Extended', kind: 'ai', robots: ['Google-Extended'] }, // Gemini 训练
  { re: /Applebot-Extended/i, name: 'Applebot-Extended', kind: 'ai', robots: ['Applebot-Extended'] }, // Apple Intelligence
  { re: /Bytespider/i, name: '字节爬虫', kind: 'ai', robots: ['Bytespider'] }, // 字节（豆包/训练），以量大激进著称
  { re: /Amazonbot/i, name: 'Amazonbot', kind: 'ai', robots: ['Amazonbot'] }, // Alexa/训练
  { re: /meta-externalagent|FacebookBot/i, name: 'Meta AI', kind: 'ai', robots: ['meta-externalagent', 'FacebookBot'] }, // Facebook AI 训练
  { re: /CCBot/i, name: 'Common Crawl', kind: 'ai', robots: ['CCBot'] }, // 语料库源头，多数 AI 训练集都含它
  { re: /omgili|Webz\.io/i, name: 'Webz.io', kind: 'ai', robots: ['omgili', 'Webz.io'] }, // 数据经纪商
  { re: /Diffbot/i, name: 'Diffbot', kind: 'ai', robots: ['Diffbot'] }, // 数据提取商
  { re: /cohere-ai/i, name: 'Cohere', kind: 'ai', robots: ['cohere-ai'] },
  { re: /MistralAI/i, name: 'Mistral AI', kind: 'ai', robots: ['MistralAI'] },
  { re: /TikTokSpider/i, name: 'TikTok', kind: 'ai', robots: ['TikTokSpider'] },
  { re: /ImagesiftBot/i, name: 'ImageSift', kind: 'ai', robots: ['ImagesiftBot'] }, // Hive 图像数据
  /* ---- 搜索引擎 ---- */
  { re: /Googlebot(?!-Image)/i, name: 'Google', kind: 'se' },
  { re: /bingbot|adidxbot/i, name: '必应', kind: 'se' },
  { re: /Baiduspider/i, name: '百度', kind: 'se' },
  { re: /Sogou.*spider/i, name: '搜狗', kind: 'se' },
  { re: /360Spider|HaosouSpider/i, name: '360 搜索', kind: 'se' },
  { re: /YisouSpider/i, name: '神马', kind: 'se' },
  { re: /YandexBot/i, name: 'Yandex', kind: 'se' },
  { re: /DuckDuckBot/i, name: 'DuckDuckGo', kind: 'se' },
  { re: /Applebot(?!-Extended)/i, name: 'Applebot', kind: 'se' }, // Safari 建议/Siri，独立于 AI 抓取
  { re: /SeznamBot/i, name: 'Seznam', kind: 'se' },
  { re: /NaverBot|Yeti\//i, name: 'Naver', kind: 'se' },
  /* ---- RSS/订阅器 ---- */
  { re: /Feedly/i, name: 'Feedly', kind: 'feed' },
  { re: /Inoreader/i, name: 'Inoreader', kind: 'feed' },
  { re: /NewsBlur/i, name: 'NewsBlur', kind: 'feed' },
  { re: /FeedFetcher-Google/i, name: 'Google 订阅', kind: 'feed' }, // Google Reader 系产品（Follow 等）
  { re: /FreshRSS|Miniflux|Tiny\s?Tiny\s?RSS|tt-rss|Selfoss|Liferea|Akregator|QuiteRSS|Newsboat|Reeder|NetNewsWire/i, name: '自托管订阅', kind: 'feed' },
  { re: /Bloglines|Netvibes|Podcast|iTunes/i, name: '订阅器', kind: 'feed' },
  { re: /(rss|atom|feed)(?!back)/i, name: '其他订阅', kind: 'feed' }, // 兜底：UA 自称 RSS/Atom/Feed 的，放最后
  /* ---- SEO 工具 ---- */
  { re: /AhrefsBot/i, name: 'Ahrefs', kind: 'seo' },
  { re: /SEMrushBot/i, name: 'SEMrush', kind: 'seo' },
  { re: /MJ12bot|Majestic/i, name: 'Majestic', kind: 'seo' },
  { re: /dotbot/i, name: 'DotBot', kind: 'seo' },
  { re: /rogerbot|Screaming Frog/i, name: 'SEO 工具', kind: 'seo' },
  { re: /PetalBot/i, name: 'PetalBot', kind: 'seo' }, // 华为 Petal 搜索
  { re: /dataforseo/i, name: 'DataForSEO', kind: 'seo' },
  { re: /serpstatbot/i, name: 'SerpStat', kind: 'seo' },
  /* ---- 网页存档 ---- */
  { re: /ia_archiver|archive\.org_bot|ArchiveBot/i, name: 'Internet Archive', kind: 'arch' },
  { re: /Special:Archive|Save Page Now/i, name: '存档服务', kind: 'arch' },
]

export const BOT_KIND_NAME: Record<BotKind, string> = {
  ai: 'AI 训练抓取',
  'ai-seek': 'AI 检索引用',
  se: '搜索引擎',
  feed: '订阅器',
  seo: 'SEO 工具',
  arch: '网页存档',
}

/** AI 两类爬虫的 robots.txt UA 令牌（由 BOT_RULES.robots 派生，单一事实源）。
 *  训练型 → robots 里独立 Disallow 组；检索引用型 → 显式 Allow（声明「欢迎引用」）。
 *  新增 AI 爬虫只改 BOT_RULES 一处；tests/bots.test.ts 守「每个令牌都能被识别回同 kind」。 */
export const AI_TRAIN_AGENTS: string[] = BOT_RULES.filter((r) => r.kind === 'ai').flatMap((r) => r.robots ?? [])
export const AI_SEEK_AGENTS: string[] = BOT_RULES.filter((r) => r.kind === 'ai-seek').flatMap((r) => r.robots ?? [])

/** UA → 爬虫识别。未命中返回 null（浏览器流量/未知脚本，调用方不落库）。 */
export function identifyBot(ua: string): { name: string; kind: BotKind } | null {
  const s = String(ua ?? '')
  if (!s) return null
  for (const r of BOT_RULES) {
    if (r.re.test(s)) return { name: r.name, kind: r.kind }
  }
  return null
}

/* ---------------- 写入闸（isolate 内存态，防配额刷爆，见文件头注释） ---------------- */

const BOT_DEDUP_MS = 30_000 // 同一（爬虫名+路径）最小记录间隔
const BOT_BUDGET = 300 // 每 isolate 滚动窗口写入预算
const BOT_BUDGET_WINDOW_MS = 10 * 60_000

interface BotGateState {
  seen: Map<string, number> // 「name|path」→ 上次记录时间
  windowStart: number
  used: number
}

const gate: BotGateState = { seen: new Map(), windowStart: Date.now(), used: 0 }

/** 本条抓取要不要落库（返回 true 才写 D1）。nowMs 注入便于测试。 */
export function shouldRecordBot(name: string, path: string, nowMs = Date.now()): boolean {
  if (nowMs - gate.windowStart >= BOT_BUDGET_WINDOW_MS) {
    gate.windowStart = nowMs
    gate.used = 0
    gate.seen.clear()
  }
  if (gate.used >= BOT_BUDGET) return false
  const key = name + '|' + path
  const last = gate.seen.get(key)
  if (last !== undefined && nowMs - last < BOT_DEDUP_MS) return false
  if (gate.seen.size > 400) gate.seen.clear() // 穷举路径撑大去重表：整表清空重新记账（预算闸仍在）
  gate.seen.set(key, nowMs)
  gate.used++
  return true
}

/** 仅测试用：重置写入闸状态 */
export function resetBotGate(): void {
  gate.seen.clear()
  gate.windowStart = Date.now()
  gate.used = 0
}

/* ---------------- 落库 ---------------- */

/** 请求路径：剥控制字符、截 300（服务端 c.req.path 本就合法，这里兜底防御）。
 *  裸 `/`（首页）合法：第二字符「不是 /」的拒绝对它按「不存在第二字符」放行，
 *  否则整站抓取统计里永远看不到首页。 */
export function cleanBotPath(raw: unknown): string {
  const s = String(raw ?? '').replace(/[\u0000-\u001f\u007f]/g, '')
  return /^\/(?:$|[^/])/.test(s) ? s.slice(0, 300) : ''
}

/** 写入一条爬虫抓取日志（day 按北京时间落好，聚合不再算时区） */
export async function recordBot(
  db: D1Database,
  input: { name: string; kind: BotKind; path: string; country: string }
): Promise<void> {
  const ts = Date.now()
  await db
    .prepare('INSERT INTO bot_log (ts, day, name, kind, path, country) VALUES (?, ?, ?, ?, ?, ?)')
    .bind(ts, fmtDate(ts), input.name, input.kind, input.path, input.country)
    .run()
}

/** 清理过期爬虫日志（每晚备份 cron 调用，与 purgeVisits 并排） */
export async function purgeBots(db: D1Database, keepDays = BOT_KEEP_DAYS): Promise<void> {
  const cutoff = Date.now() - keepDays * 86_400_000
  await db.prepare('DELETE FROM bot_log WHERE ts < ?').bind(cutoff).run()
}

/* ---------------- 聚合（后台「统计」页） ---------------- */

export interface BotStats {
  days: number
  total: number
  todayTotal: number
  byKind: { name: string; pv: number }[] // kind 分组（kind 原值，前端映射中文名）
  byBot: { name: string; kind: string; pv: number; activeDays: number }[] // 按爬虫名，activeDays = 有抓取的天数
  topPaths: { path: string; pv: number }[]
  series: { day: string; pv: number; ai: number; aiSeek: number; se: number }[] // 逐日，缺天补零
  latest: { ts: number; name: string; kind: string; path: string }[] // 最近 8 条
}

/** 后台「统计」页爬虫聚合：区间与 getVisitStats 同口径（含今天共 days 天，北京时间） */
export async function getBotStats(db: D1Database, days: number): Promise<BotStats> {
  const now = Date.now()
  const today = fmtDate(now)
  const startDay = fmtDate(now - (days - 1) * 86_400_000)
  const inRange = 'day >= ? AND day <= ?'
  const [sumRow, kindRows, botRows, pathRows, seriesRows, latestRows] = await Promise.all([
    db
      .prepare(`SELECT COUNT(*) AS pv FROM bot_log WHERE ${inRange}`)
      .bind(startDay, today)
      .first<{ pv: number }>(),
    db
      .prepare(`SELECT kind AS name, COUNT(*) AS pv FROM bot_log WHERE ${inRange} GROUP BY kind ORDER BY pv DESC`)
      .bind(startDay, today)
      .all<{ name: string; pv: number }>(),
    db
      .prepare(
        `SELECT name, kind, COUNT(*) AS pv, COUNT(DISTINCT day) AS activeDays
         FROM bot_log WHERE ${inRange} GROUP BY name ORDER BY pv DESC, name LIMIT 12`
      )
      .bind(startDay, today)
      .all<{ name: string; kind: string; pv: number; activeDays: number }>(),
    db
      .prepare(
        `SELECT path, COUNT(*) AS pv FROM bot_log WHERE ${inRange} GROUP BY path ORDER BY pv DESC, path LIMIT 10`
      )
      .bind(startDay, today)
      .all<{ path: string; pv: number }>(),
    db
      .prepare(
        `SELECT day,
           COUNT(*) AS pv,
           SUM(CASE WHEN kind = 'ai' THEN 1 ELSE 0 END) AS ai,
           SUM(CASE WHEN kind = 'ai-seek' THEN 1 ELSE 0 END) AS aiSeek,
           SUM(CASE WHEN kind = 'se' THEN 1 ELSE 0 END) AS se
         FROM bot_log WHERE ${inRange} GROUP BY day ORDER BY day`
      )
      .bind(startDay, today)
      .all<{ day: string; pv: number; ai: number; aiSeek: number; se: number }>(),
    db
      .prepare(`SELECT ts, name, kind, path FROM bot_log WHERE ${inRange} ORDER BY ts DESC LIMIT 8`)
      .bind(startDay, today)
      .all<{ ts: number; name: string; kind: string; path: string }>(),
  ])
  const seriesMap = new Map((seriesRows.results ?? []).map((r) => [r.day, r]))
  const todayRow = seriesMap.get(today)
  const series: BotStats['series'] = []
  for (let i = days - 1; i >= 0; i--) {
    const day = fmtDate(now - i * 86_400_000)
    const r = seriesMap.get(day)
    series.push({ day, pv: r?.pv ?? 0, ai: r?.ai ?? 0, aiSeek: r?.aiSeek ?? 0, se: r?.se ?? 0 })
  }
  return {
    days,
    total: sumRow?.pv ?? 0,
    todayTotal: todayRow?.pv ?? 0,
    byKind: kindRows.results ?? [],
    byBot: botRows.results ?? [],
    topPaths: pathRows.results ?? [],
    series,
    latest: latestRows.results ?? [],
  }
}
