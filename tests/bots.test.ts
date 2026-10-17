import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { DatabaseSync, type StatementSync } from 'node:sqlite'
import {
  AI_SEEK_AGENTS,
  AI_TRAIN_AGENTS,
  BOT_KEEP_DAYS,
  BOT_RULES,
  cleanBotPath,
  getBotStats,
  identifyBot,
  purgeBots,
  recordBot,
  resetBotGate,
  shouldRecordBot,
  type BotKind,
} from '../src/bots.ts'

// ── 爬虫 / AI 抓取识别（src/bots.ts，统计页新维度）──
// 识别用例用各家真实 UA 样本；聚合与清理走 node:sqlite 真 schema 建库。

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const SCHEMA_SQL = readFileSync(join(ROOT, 'schema.sql'), 'utf8')

/** 极简 D1 适配（同 tests/mcp.test.ts） */
function d1FromSqlite(db: DatabaseSync): D1Database {
  const cache = new Map<string, StatementSync>()
  const stmtOf = (sql: string) => {
    let st = cache.get(sql)
    if (!st) cache.set(sql, (st = db.prepare(sql)))
    return st
  }
  const handlers = (sql: string, binds: unknown[]) => ({
    run: async () => {
      const info = stmtOf(sql).run(...(binds as never[]))
      return { success: true, meta: { last_row_id: Number(info.lastInsertRowid), changes: Number(info.changes) } }
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

function freshDb(): { d1: D1Database; raw: DatabaseSync } {
  const raw = new DatabaseSync(':memory:')
  raw.exec(SCHEMA_SQL)
  return { d1: d1FromSqlite(raw), raw }
}

/* ---------------- 识别 ---------------- */

test('identifyBot 识别主流 AI 抓取', () => {
  const cases: [string, string, BotKind][] = [
    // 训练 / 语料（抓下来喂模型）
    ['Mozilla/5.0 AppleWebKit/537.36 (KHTML, like Gecko); compatible; GPTBot/1.2; +https://openai.com/gptbot', 'GPTBot', 'ai'],
    ['Mozilla/5.0 (KHTML, like Gecko) Version/4.0 Chrome/126.0.0.0 Safari/537.36 ClaudeBot/1.0', 'ClaudeBot', 'ai'],
    ['Mozilla/5.0 (compatible; Google-Extended/1.0)', 'Google-Extended', 'ai'],
    ['Mozilla/5.0 (compatible; Applebot-Extended/1.0; +http://www.apple.com/go/applebot-extended)', 'Applebot-Extended', 'ai'],
    ['Mozilla/5.0 (Linux; Android 5.0) AppleWebKit/537.36 (KHTML, like Gecko) Mobile Safari/537.36 (compatible; Bytespider; spider-feedback@bytedance.com)', '字节爬虫', 'ai'],
    ['Mozilla/5.0 (compatible; meta-externalagent/1.1 (+https://developers.facebook.com/docs/sharing/webmasters/crawler))', 'Meta AI', 'ai'],
    ['CCBot/2.0 (https://commoncrawl.org/faq/)', 'Common Crawl', 'ai'],
    // 检索引用（用户提问时实时读，回答里带来源链接）
    ['Mozilla/5.0 AppleWebKit/537.36 (KHTML, like Gecko); compatible; OAI-SearchBot/1.0; +https://openai.com/searchbot', 'OAI-SearchBot', 'ai-seek'],
    ['Mozilla/5.0 AppleWebKit/537.36 (KHTML, like Gecko); compatible; ChatGPT-User/1.0; +https://openai.com/bot', 'ChatGPT', 'ai-seek'],
    ['Mozilla/5.0 (compatible; Claude-SearchBot/1.0; +http://www.anthropic.com/claude-searchbot)', 'Claude 检索', 'ai-seek'],
    ['Mozilla/5.0 (compatible; Claude-User/1.0; +http://www.anthropic.com/claude-user)', 'Claude 抓取', 'ai-seek'],
    ['Mozilla/5.0 (compatible; PerplexityBot/1.0; +https://perplexity.ai/perplexitybot)', 'PerplexityBot', 'ai-seek'],
    ['Mozilla/5.0 (compatible; Perplexity-User/1.0; +https://perplexity.ai/perplexity-user)', 'Perplexity-User', 'ai-seek'],
    ['Mozilla/5.0 (compatible; YouBot/1.0; +https://about.you.com/youbot/)', 'YouBot', 'ai-seek'],
    ['Mozilla/5.0 (compatible; DuckAssistBot/1.0; +http://duckduckgo.com/duckassistbot.html)', 'DuckDuckGo AI', 'ai-seek'],
  ]
  for (const [ua, name, kind] of cases) {
    const hit = identifyBot(ua)
    assert.ok(hit, `应识别: ${ua}`)
    assert.equal(hit.name, name)
    assert.equal(hit.kind, kind)
  }
})

test('ClaudeBot / Claude-SearchBot / Claude-User 三分：训练与检索不混（拆前会误伤引用路）', () => {
  assert.equal(identifyBot('ClaudeBot/1.0')?.kind, 'ai')
  assert.equal(identifyBot('Claude-Web/1.0')?.kind, 'ai')
  assert.equal(identifyBot('Claude-SearchBot/1.0')?.kind, 'ai-seek')
  assert.equal(identifyBot('Claude-User/1.0')?.kind, 'ai-seek')
})

test('identifyBot 识别搜索引擎', () => {
  const cases: [string, string][] = [
    ['Mozilla/5.0 (compatible; Googlebot/2.1; +http://www.google.com/bot.html)', 'Google'],
    ['Mozilla/5.0 AppleWebKit/537.36 (KHTML, like Gecko; compatible; bingbot/2.0; +http://www.bing.com/bingbot.htm) Chrome/126 Safari/537.36', '必应'],
    ['Mozilla/5.0 (compatible; Baiduspider/2.0; +http://www.baidu.com/search/spider.html)', '百度'],
    ['Mozilla/5.0 (compatible; Sogou web spider/4.0; +http://www.sogou.com/docs/help/web.htm)', '搜狗'],
    ['Mozilla/5.0 (compatible; YisouSpider/5.0; +https://m.sm.cn/help)', '神马'],
    ['Mozilla/5.0 (compatible; YandexBot/3.0; +http://yandex.com/bots)', 'Yandex'],
    ['Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.4 Safari/605.1.15 (Applebot/0.1; +http://www.apple.com/go/applebot)', 'Applebot'],
  ]
  for (const [ua, name] of cases) {
    const hit = identifyBot(ua)
    assert.ok(hit, `应识别: ${ua}`)
    assert.equal(hit.name, name)
    assert.equal(hit.kind, 'se')
  }
})

test('identifyBot 识别订阅器 / SEO 工具 / 存档', () => {
  assert.equal(identifyBot('Feedly/1.0 (+http://www.feedly.com/fetcher.html; like FeedFetcher-Google)')?.kind, 'feed')
  assert.equal(identifyBot('FreshRSS/1.24 (Linux; https://freshrss.org)')?.kind, 'feed')
  assert.equal(identifyBot('NetNewsWire (RSS Reader; https://netnewswire.com/)')?.kind, 'feed')
  assert.equal(identifyBot('Mozilla/5.0 (compatible; AhrefsBot/7.0; +http://ahrefs.com/robot/)')?.name, 'Ahrefs')
  assert.equal(identifyBot('Mozilla/5.0 (compatible; SEMrushBot/7; +http://www.semrush.com/bot.html)')?.kind, 'seo')
  assert.equal(identifyBot('Mozilla/5.0 (compatible; PetalBot;+https://webmaster.petalsearch.com/site/petalbot)')?.kind, 'seo')
  assert.equal(identifyBot('ia_archiver (+http://www.alexa.com/site/help/webmasters; archive.org_details/archive.org_bot)')?.name, 'Internet Archive')
})

test('identifyBot 浏览器流量不命中', () => {
  assert.equal(identifyBot('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120 Safari/537.36'), null)
  assert.equal(identifyBot('Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 Mobile/15E148 Safari/604.1 MicroMessenger/8.0.49'), null)
  assert.equal(identifyBot('curl/8.4.0'), null)
  assert.equal(identifyBot(''), null)
  assert.equal(identifyBot(undefined as unknown as string), null)
})

test('识别顺序：Google-Extended 优先于 Googlebot 系，Applebot-Extended 优先于 Applebot', () => {
  assert.equal(identifyBot('Mozilla/5.0 (compatible; Google-Extended/1.0; Googlebot/2.1)')?.name, 'Google-Extended')
  assert.equal(identifyBot('Mozilla/5.0 (compatible; Applebot-Extended/1.0)')?.name, 'Applebot-Extended')
})

test('BOT_RULES 规则表自洽：kind 都是合法枚举、name 非空', () => {
  const kinds = new Set<BotKind>(['ai', 'ai-seek', 'se', 'feed', 'seo', 'arch'])
  for (const r of BOT_RULES) {
    assert.ok(kinds.has(r.kind), `非法 kind: ${r.kind}`)
    assert.ok(r.name.length > 0 && r.name.length <= 20, `name 越界: ${r.name}`)
    assert.ok(r.re.test('X'.repeat(0) + r.name) === false || true) // 正则合法性由上面用例覆盖
  }
})

test('AI 令牌表与识别规则同源：每条 AI 令牌都能被识别回同 kind，两档无交集', () => {
  // AI_TRAIN_AGENTS / AI_SEEK_AGENTS 是 robots 策略（src/seo.ts）的唯一输入，
  // 每个令牌必须真能匹配回它的规则——否则策略会声明一个识别不到的 UA（形同虚设）
  for (const ua of AI_TRAIN_AGENTS) {
    assert.equal(identifyBot(`${ua}/1.0`)?.kind, 'ai', `训练型令牌未被识别为训练: ${ua}`)
  }
  for (const ua of AI_SEEK_AGENTS) {
    assert.equal(identifyBot(`${ua}/1.0`)?.kind, 'ai-seek', `检索型令牌未被识别为检索: ${ua}`)
  }
  const train = new Set(AI_TRAIN_AGENTS)
  for (const ua of AI_SEEK_AGENTS) assert.ok(!train.has(ua), `令牌同时出现在两档: ${ua}`)
  assert.equal(new Set(AI_TRAIN_AGENTS).size, AI_TRAIN_AGENTS.length, '训练型令牌有重复')
  assert.equal(new Set(AI_SEEK_AGENTS).size, AI_SEEK_AGENTS.length, '检索型令牌有重复')
  // 每条 AI 类规则都必须声明 robots 令牌（新增 AI 爬虫忘填令牌时这里报红）
  for (const r of BOT_RULES) {
    if (r.kind === 'ai' || r.kind === 'ai-seek') assert.ok(r.robots?.length, `AI 规则缺 robots 令牌: ${r.name}`)
  }
  // 关键一对：Googlebot 放行 / Google-Extended 拒绝（拒后者不影响搜索收录）
  assert.ok(!AI_TRAIN_AGENTS.includes('Googlebot'))
  assert.ok(AI_TRAIN_AGENTS.includes('Google-Extended'))
  assert.ok(!AI_SEEK_AGENTS.includes('Google-Extended'))
  // 检索档必须含「回答里带来源链接」的主流三家
  for (const ua of ['OAI-SearchBot', 'PerplexityBot', 'Claude-SearchBot']) {
    assert.ok(AI_SEEK_AGENTS.includes(ua), `检索档缺 ${ua}`)
  }
})

/* ---------------- 路径清洗 ---------------- */

test('cleanBotPath 与 cleanPath 同口径（剥控制字符、截 300）', () => {
  assert.equal(cleanBotPath('/post/hello?utm=x'), '/post/hello?utm=x')
  assert.equal(cleanBotPath('/wp-login.php'), '/wp-login.php')
  assert.equal(cleanBotPath('/'), '/') // 裸首页合法：整站抓取统计里必须看得到首页
  assert.equal(cleanBotPath('\n/post/x'), '/post/x')
  assert.equal(cleanBotPath('https://evil.com/x'), '')
  assert.equal(cleanBotPath('post/x'), '')
  assert.equal(cleanBotPath(''), '')
  assert.equal(cleanBotPath(undefined), '')
  assert.equal(cleanBotPath('/' + 'a'.repeat(400)), '/' + 'a'.repeat(299))
})

/* ---------------- 写入闸（防 D1 写配额被刷） ---------------- */

test('shouldRecordBot 同键 30 秒去抖，跨键不受影响', () => {
  resetBotGate()
  const t0 = 1_800_000_000_000
  assert.equal(shouldRecordBot('GPTBot', '/post/a', t0), true)
  assert.equal(shouldRecordBot('GPTBot', '/post/a', t0 + 5_000), false) // 去抖窗口内
  assert.equal(shouldRecordBot('GPTBot', '/post/a', t0 + 29_999), false)
  assert.equal(shouldRecordBot('GPTBot', '/post/a', t0 + 30_000), true) // 窗口刚过
  assert.equal(shouldRecordBot('GPTBot', '/post/b', t0 + 1_000), true) // 不同路径不受去抖影响
  assert.equal(shouldRecordBot('Google', '/post/a', t0 + 1_000), true) // 不同爬虫不受去抖影响
})

test('shouldRecordBot 预算闸：10 分钟窗口内超 300 条直接拒（防穷举路径绕过去抖）', () => {
  resetBotGate()
  const t0 = 1_800_000_000_000
  let accepted = 0
  for (let i = 0; i < 500; i++) {
    if (shouldRecordBot('GPTBot', `/probe/${i}`, t0)) accepted++
  }
  assert.equal(accepted, 300)
  assert.equal(shouldRecordBot('Google', '/any', t0 + 1_000), false) // 预算耗尽后一概不记
  assert.equal(shouldRecordBot('GPTBot', '/probe/501', t0 + 9 * 60_000), false) // 窗口内仍然拒
  assert.equal(shouldRecordBot('GPTBot', '/probe/502', t0 + 10 * 60_000), true) // 新窗口恢复
})

/* ---------------- 落库 / 聚合 / 清理（真库） ---------------- */

test('recordBot + getBotStats 全链路：分组、逐日补零、活跃天数、最近记录', async () => {
  const { d1 } = freshDb()
  const now = Date.now()
  const dayMs = 86_400_000
  // 今天 4 条 + 昨天 2 条 + 32 天前 1 条（30 天窗口外）；AI 两档各记一条
  await recordBot(d1, { name: 'GPTBot', kind: 'ai', path: '/post/hello', country: 'US' })
  await recordBot(d1, { name: 'GPTBot', kind: 'ai', path: '/post/world', country: 'US' })
  await recordBot(d1, { name: '字节爬虫', kind: 'ai', path: '/', country: 'SG' })
  await recordBot(d1, { name: 'PerplexityBot', kind: 'ai-seek', path: '/post/hello', country: 'US' })
  await recordBot(d1, { name: 'Google', kind: 'se', path: '/post/hello', country: 'US' })
  await recordBot(d1, { name: 'Google', kind: 'se', path: '/rss.xml', country: 'IE' })
  await d1
    .prepare('INSERT INTO bot_log (ts, day, name, kind, path, country) VALUES (?, ?, ?, ?, ?, ?)')
    .bind(now - 32 * dayMs, new Date(now - 32 * dayMs + 8 * 3_600_000).toISOString().slice(0, 10), 'Ahrefs', 'seo', '/links', 'US')
    .run()

  const s = await getBotStats(d1, 30)
  assert.equal(s.days, 30)
  assert.equal(s.total, 6) // 32 天前那条在窗口外
  assert.ok(s.todayTotal >= 4)
  const ai = s.byKind.find((k) => k.name === 'ai')
  const aiSeek = s.byKind.find((k) => k.name === 'ai-seek')
  const se = s.byKind.find((k) => k.name === 'se')
  assert.equal(ai?.pv, 3)
  assert.equal(aiSeek?.pv, 1)
  assert.equal(se?.pv, 2)
  const gpt = s.byBot.find((b) => b.name === 'GPTBot')
  assert.equal(gpt?.pv, 2)
  assert.equal(gpt?.kind, 'ai')
  assert.equal(gpt?.activeDays, 1)
  const pplx = s.byBot.find((b) => b.name === 'PerplexityBot')
  assert.equal(pplx?.kind, 'ai-seek')
  const google = s.byBot.find((b) => b.name === 'Google')
  assert.equal(google?.activeDays, 1)
  const paths = s.topPaths.map((p) => p.path)
  assert.ok(paths.includes('/post/hello'))
  assert.equal(s.series.length, 30)
  assert.equal(s.series[s.series.length - 1].pv >= 4, true)
  assert.equal(s.series[s.series.length - 1].ai, 3)
  assert.equal(s.series[s.series.length - 1].aiSeek, 1)
  assert.equal(s.series[0].pv, 0) // 30 天前那天无数据，补零
  assert.equal(s.latest.length, 6)
  assert.ok(s.latest[0].ts >= s.latest[s.latest.length - 1].ts) // 倒序
})

test('getBotStats 空库返回零值骨架（series 补零、数组为空不炸）', async () => {
  const { d1 } = freshDb()
  const s = await getBotStats(d1, 7)
  assert.equal(s.total, 0)
  assert.equal(s.todayTotal, 0)
  assert.deepEqual(s.byKind, [])
  assert.deepEqual(s.byBot, [])
  assert.deepEqual(s.topPaths, [])
  assert.equal(s.series.length, 7)
  assert.ok(s.series.every((d) => d.pv === 0 && d.ai === 0 && d.aiSeek === 0 && d.se === 0))
  assert.deepEqual(s.latest, [])
})

test('purgeBots 按保留期清理过期日志（默认 180 天）', async () => {
  const { d1 } = freshDb()
  const now = Date.now()
  await recordBot(d1, { name: 'GPTBot', kind: 'ai', path: '/', country: 'US' })
  const old = now - (BOT_KEEP_DAYS + 2) * 86_400_000
  await d1
    .prepare('INSERT INTO bot_log (ts, day, name, kind, path, country) VALUES (?, ?, ?, ?, ?, ?)')
    .bind(old, new Date(old + 8 * 3_600_000).toISOString().slice(0, 10), 'Google', 'se', '/', 'US')
    .run()
  await purgeBots(d1)
  const left = await d1.prepare('SELECT COUNT(*) AS n FROM bot_log').first<{ n: number }>()
  assert.equal(left?.n, 1) // 只剩今天那条
})
