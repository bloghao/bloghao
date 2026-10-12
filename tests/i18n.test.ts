import { test } from 'node:test'
import assert from 'node:assert/strict'
import { register } from 'node:module'
import { pathToFileURL } from 'node:url'
import type { SettingsMap } from '../src/types.ts'
import {
  enBetaBannerHtml,
  fmtDateEn,
  fmtDateEnShort,
  fmtDateTimeEn,
  isEn,
  plural,
  tr,
  weiboTimeEn,
} from '../src/i18n.ts'
import { archiveListHtml, page, siteNav, tierLabel } from '../src/render.ts'
import { buildJsonFeed, buildRss } from '../src/rss.ts'
import { DEFAULT_SETTINGS } from '../src/db.ts'

// ── 英文测试版（English 0.1）回归：isEn 判定、词典、英文日期、双语渲染两态 ──
// 铁律：中文路径字节级不变（isEn=false 时一切输出与历史版本一致），英文版渲染抛错自动回退中文

const ZH: SettingsMap = { ...DEFAULT_SETTINGS }
const EN: SettingsMap = { ...DEFAULT_SETTINGS, edition: 'en' }
const FALLEN: SettingsMap = { ...DEFAULT_SETTINGS, edition: 'en', editionEnStatus: 'fallback' }

const TS = Date.UTC(2026, 9, 10, 4, 30) // 北京时间 2026-10-10 12:30（+8h 口径）

/* ---------------- isEn：脏值/缺省/回退态一律中文 ---------------- */

test('isEn：edition=en 且未回退才生效，其余一律中文', () => {
  assert.equal(isEn(ZH), false)
  assert.equal(isEn(EN), true)
  assert.equal(isEn(FALLEN), false) // 已自动回退
  assert.equal(isEn(undefined), false)
  assert.equal(isEn(null), false)
  assert.equal(isEn({ edition: 'en' } as SettingsMap), true) // 无状态键视为正常
  assert.equal(isEn({ edition: 'EN' } as SettingsMap), false) // 大小写敏感，脏值回中文
})

/* ---------------- 词典：精确匹配，用户内容透传 ---------------- */

test('tr：中文路径原样返回（字节级不变），英文命中词典', () => {
  assert.equal(tr(false, '首页'), '首页')
  assert.equal(tr(true, '首页'), 'Home')
  assert.equal(tr(true, '留言板'), 'Guestbook')
  assert.equal(tr(true, '排行榜'), 'Leaderboard')
  assert.equal(tr(true, '博客号 BlogHao'), 'BlogHao') // 系统默认站名
  assert.equal(tr(true, '由 博客号 驱动 · 住在 Cloudflare 上'), 'Powered by BlogHao · Lives on Cloudflare')
  // 查不到（用户自填内容/未知串）原样透传
  assert.equal(tr(true, '我自己的自定义页脚'), '我自己的自定义页脚')
  assert.equal(tr(true, ''), '')
})

test('plural：英文可数单复数', () => {
  assert.equal(plural(1, 'post', 'posts'), 'post')
  assert.equal(plural(0, 'post', 'posts'), 'posts')
  assert.equal(plural(2, 'post', 'posts'), 'posts')
})

/* ---------------- 英文日期：与 fmtDate 同北京时间口径 ---------------- */

test('fmtDateEn 系列：Oct 10, 2026 口径，空值返回空串', () => {
  assert.equal(fmtDateEn(TS), 'Oct 10, 2026')
  assert.equal(fmtDateEnShort(TS), 'Oct 10')
  assert.equal(fmtDateTimeEn(TS), 'Oct 10, 2026, 12:30')
  assert.equal(fmtDateEn(0), '')
  assert.equal(fmtDateEn(null), '')
  // 0-8 点不错位：UTC 2026-10-09 20:00 = 北京 2026-10-10 04:00
  const early = Date.UTC(2026, 9, 9, 20, 0)
  assert.equal(fmtDateEn(early), 'Oct 10, 2026')
})

test('weiboTimeEn：今年带时间，往年只带年份', () => {
  const now = Date.now()
  assert.match(weiboTimeEn(now), /^\w{3} \d{1,2}, \d{2}:\d{2}$/)
  const lastYear = now - 366 * 86_400_000
  assert.match(weiboTimeEn(lastYear), /^\w{3} \d{1,2}, \d{4}$/)
})

/* ---------------- 渲染两态：中文不变 + 英文生效 ---------------- */

test('siteNav：中文输出不变，英文输出 Home/Notes/Archives', () => {
  const cats = [{ name: '分类', slug: 'cat' }]
  const zh = siteNav({ cls: 't', categories: cats, tags: [{ name: '生活', count: 1 }] })
  const en = siteNav({ cls: 't', categories: cats, tags: [{ name: '生活', count: 1 }], en: true })
  assert.match(zh, /首页/)
  assert.match(zh, /微博/)
  assert.match(zh, /站点导航/)
  assert.doesNotMatch(zh, /Home/)
  assert.match(en, />Home</)
  assert.match(en, /Notes/)
  assert.match(en, /Archives/)
  assert.match(en, /Guestbook/)
  assert.match(en, /Leaderboard|Membership|About|Random/)
  assert.match(en, /aria-label="Site navigation"/)
  assert.match(en, /Categories/)
  assert.match(en, /Tags/)
})

test('archiveListHtml：中文「N 篇 + 2026.10.10」，英文「N posts + Oct 10」', () => {
  const groups = [{ year: 2026, count: 1, items: [{ slug: 'a', title: 'A', ts: TS }] }]
  const zh = archiveListHtml(groups)
  const en = archiveListHtml(groups, true)
  assert.match(zh, /1 篇/)
  assert.match(zh, /2026\.10\.10/)
  assert.match(en, /1 post</)
  assert.match(en, />Oct 10</)
})

test('tierLabel：中文档位不变，英文档位随 isEn 切换', () => {
  assert.equal(tierLabel('normal'), '普通会员')
  assert.equal(tierLabel('normal', true), 'Member')
  assert.equal(tierLabel('coffee', true), 'Coffee member')
  assert.equal(tierLabel('top', true), 'Top member')
  assert.equal(tierLabel('bogus', true), 'Member') // 脏值兜普通会员
})

test('page()：英文版 lang=en、测试版横幅、noindex、data-edition；中文版无痕', () => {
  const base = { css: 'body{}', title: '', path: '/', body: '<main>x</main>' }
  const zh = page({ ...base, settings: ZH })
  const en = page({ ...base, settings: EN })
  assert.match(zh, /<html lang="zh-CN">/)
  assert.doesNotMatch(zh, /data-edition="en"/)
  assert.doesNotMatch(zh, /English 0\.1 \(Beta\)/)
  assert.doesNotMatch(zh, /name="robots" content="noindex"/)
  assert.match(en, /<html lang="en" data-edition="en">/)
  assert.match(en, /English 0\.1 \(Beta\)/)
  assert.match(en, /name="robots" content="noindex"/) // 测试期不进搜索引擎索引
  // 显式 noindex 的页面中文路径照旧
  const zhNoindex = page({ ...base, settings: ZH, noindex: true })
  assert.match(zhNoindex, /name="robots" content="noindex"/)
})

test('buildRss / buildJsonFeed：中文 zh-CN 频道，英文 en 频道 + 频道标题走词典', () => {
  const posts = [{ slug: 'a', title: 'T', summary: 'S', content: 'C', published_at: TS, updated_at: TS, tags: '[]' }]
  assert.match(buildRss(ZH, posts as never, 'https://x.com'), /<language>zh-CN<\/language>/)
  assert.match(buildRss(EN, posts as never, 'https://x.com'), /<language>en<\/language>/)
  // 默认站名/描述是系统内置文案：英文态走词典（博客号 BlogHao → BlogHao），中文态原样
  assert.match(buildRss(EN, posts as never, 'https://x.com'), /<title>BlogHao<\/title>/)
  assert.match(buildRss(ZH, posts as never, 'https://x.com'), /<title>博客号 BlogHao<\/title>/)
  const jsonFeed = JSON.parse(buildJsonFeed(EN, posts as never, 'https://x.com'))
  assert.equal(jsonFeed.language, 'en')
  assert.equal(jsonFeed.title, 'BlogHao')
  assert.equal(JSON.parse(buildJsonFeed(ZH, posts as never, 'https://x.com')).language, 'zh-CN')
})

test('enBetaBannerHtml：公示测试版身份', () => {
  assert.match(enBetaBannerHtml(), /English 0\.1 \(Beta\)/)
})

/* ---------------- DEFAULT_SETTINGS：新键就位（后台保存白名单来源） ---------------- */

test('edition 相关键进 DEFAULT_SETTINGS（api.ts SETTINGS_KEYS 自动放行）', () => {
  assert.equal(DEFAULT_SETTINGS.edition, 'zh')
  assert.equal(DEFAULT_SETTINGS.editionEnStatus, 'active')
  assert.equal(DEFAULT_SETTINGS.editionEnError, '')
  assert.equal(DEFAULT_SETTINGS.editionEnAt, '')
})
