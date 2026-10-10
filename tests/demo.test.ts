import { test } from 'node:test'
import assert from 'node:assert/strict'
import { buildDemoPlan, DEMO_COMMENTS, DEMO_RESET_CRON, DEMO_WEIBO, mulberry32 } from '../src/demo-content.ts'
import { DEMO_POSTS } from '../src/demo-posts.ts'
import { demoImages } from '../src/demo-images.ts'
import { fireCommentCreated, firePostPublished } from '../src/hooks.ts'
import { notifyAdminComment, notifyAdminText } from '../src/external.ts'
import { isDemo } from '../src/utils.ts'
import { DEFAULT_SETTINGS } from '../src/db.ts'
import type { Env, SettingsMap } from '../src/types.ts'

// ── 演示站（体验站）：种子数据不变量 + DEMO_MODE 守卫 ──
// 生产 Worker 不带 DEMO_MODE，所有 demo 行为必须惰性；种子数据每 2 小时重灌一次，
// 这里用不变量保证「重置前后访客看到的站点始终完整、真实、安全」。

const DAY = 86_400_000
const NOW = Date.now()

test('isDemo：仅显式 "1"/"true" 开启，生产缺省关闭', () => {
  assert.equal(isDemo({ DEMO_MODE: '1' }), true)
  assert.equal(isDemo({ DEMO_MODE: 'true' }), true)
  assert.equal(isDemo({}), false)
  assert.equal(isDemo({ DEMO_MODE: '0' }), false)
  assert.equal(isDemo(undefined), false)
})

test('reset cron 常量：合法的五段 cron，不是每分钟粒度', () => {
  assert.match(DEMO_RESET_CRON, /^\S+ \S+ \S+ \S+ \S+$/)
  // 两次重置之间要有喘息：分钟位与小时位都是固定值或步进，不是 "* *"
  assert.ok(!DEMO_RESET_CRON.startsWith('* *'))
})

test('种子计划：确定性——同一时刻两次生成完全一致', () => {
  const a = JSON.stringify(buildDemoPlan(NOW))
  const b = JSON.stringify(buildDemoPlan(NOW))
  assert.equal(a, b)
})

test('种子计划：一年跨度、状态分布合理', () => {
  const plan = buildDemoPlan(NOW)
  assert.equal(plan.posts.length, DEMO_POSTS.length)
  const published = plan.posts.filter((p) => p.status === 'published')
  const drafts = plan.posts.filter((p) => p.status === 'draft')
  const scheduled = plan.posts.filter((p) => p.status === 'scheduled')
  assert.ok(published.length >= 40, `已发布应 ≥ 40，实际 ${published.length}`)
  assert.equal(drafts.length, 3, '草稿 3 篇（后台草稿箱有内容）')
  assert.equal(scheduled.length, 2, '定时 2 篇（后台定时徽标有内容）')
  // 一年跨度：最早一年内，最近 24 小时内
  const oldest = Math.min(...published.map((p) => p.publishedAt!))
  const newest = Math.max(...published.map((p) => p.publishedAt!))
  assert.ok(oldest > NOW - 370 * DAY, '最早的发布不超过 370 天前')
  assert.ok(oldest < NOW - 330 * DAY, '最早的发布确实在一年前附近')
  assert.ok(newest > NOW - 3 * DAY, '最近几天内有发布（站点看起来有人在更新）')
  assert.ok(newest < NOW, '发布时间都在过去')
  // 定时文章目标在未来
  for (const p of scheduled) assert.ok(p.publishAt! > NOW && p.publishedAt === null)
  // 草稿不可见
  for (const p of drafts) assert.equal(p.publishedAt, null)
})

test('种子计划：slug 唯一且干净（cleanSlug 口径：小写字母数字连字符）', () => {
  const plan = buildDemoPlan(NOW)
  const slugs = plan.posts.map((p) => p.slug)
  assert.equal(new Set(slugs).size, slugs.length, 'slug 不得重复')
  for (const s of slugs) assert.match(s, /^[a-z0-9]+(?:-[a-z0-9]+)*$/, `slug 不干净: ${s}`)
})

test('种子计划：正文是净化器同口径的安全 HTML（无 script / 无 id / 无内联事件）', () => {
  const plan = buildDemoPlan(NOW)
  for (const p of [...plan.posts, ...plan.pages]) {
    const html = p.content
    assert.ok(!/<script/i.test(html), `script 标签混入: ${'slug' in p ? p.slug : p.title}`)
    assert.ok(!/\son\w+\s*=/i.test(html), `内联事件混入: ${'slug' in p ? p.slug : p.title}`)
    // 净化器不放行 id（DOM clobbering 约定），种子内容也不该有
    assert.ok(!/\sid\s*=/i.test(html), `id 属性混入: ${'slug' in p ? p.slug : p.title}`)
    assert.ok(!/javascript:/i.test(html), 'javascript: URL 混入')
  }
})

test('种子计划：标签 JSON 合法，封面/正文图片全部来自种子图床', () => {
  const plan = buildDemoPlan(NOW)
  const keys = new Set(demoImages().map((i) => i.key))
  for (const p of plan.posts) {
    const tags = JSON.parse(p.tags)
    assert.ok(Array.isArray(tags) && tags.length > 0)
    for (const t of tags) assert.equal(typeof t, 'string')
    if (p.cover) assert.ok(keys.has(p.cover.replace('/images/', '')), `封面缺图: ${p.cover}`)
  }
  // 正文内引用的种子图必须存在于 R2 计划里，否则文章页图全裂
  const referenced = new Set<string>()
  for (const p of plan.posts) {
    for (const m of p.content.matchAll(/\/images\/(u\/demo\/[\w-]+\.svg)/g)) referenced.add(m[1])
  }
  for (const w of plan.weibo) for (const u of JSON.parse(w.images)) referenced.add(String(u).replace('/images/', ''))
  for (const key of referenced) assert.ok(keys.has(key), `正文引用了不存在的种子图: ${key}`)
})

test('种子计划：评论树合法——父评论在前、时间不早于目标、待审与作者回复都有', () => {
  const plan = buildDemoPlan(NOW)
  assert.equal(plan.comments.length, DEMO_COMMENTS.length, '每一条评论定义都成功落进计划')
  const postById = new Map(plan.posts.map((p, i) => [i + 1, p]))
  const weiboById = new Map(plan.weibo.map((w, i) => [i + 1, w]))
  const byId = new Map(plan.comments.map((c, i) => [i + 1, c]))
  let pending = 0
  let adminReplies = 0
  plan.comments.forEach((c, i) => {
    const id = i + 1
    assert.ok(c.createdAt <= NOW - 5 * 60_000, `评论 ${id} 落在未来`)
    if (c.parentId > 0) {
      const parent = byId.get(c.parentId)
      assert.ok(parent && c.parentId < id, `评论 ${id} 的父评论不存在或顺序错误`)
      assert.ok(parent.createdAt <= c.createdAt, `评论 ${id} 早于被回复者`)
      if (c.isAdmin) adminReplies++
    }
    if (c.postId > 0) {
      const post = postById.get(c.postId)!
      assert.ok(post, `评论指向不存在的文章 ${c.postId}`)
      assert.equal(post.status, 'published', `评论指向了非发布文章 ${post.slug}`)
      assert.ok(c.createdAt >= post.publishedAt!, `评论 ${id} 早于文章发布`)
    } else if (c.weiboId > 0) {
      const w = weiboById.get(c.weiboId)!
      assert.ok(w && w.status === 'published', `微博评论指向草稿或不存在`)
      assert.ok(c.createdAt >= w.publishedAt!)
    }
    if (c.status === 'pending') pending++
  })
  assert.ok(pending >= 2, '待审评论要有几条（先审后发模式的待审队列要有内容）')
  assert.ok(adminReplies >= 5, '作者楼中楼回复要有几条')
  // 留言板三路齐全：文章评论 / 微博评论 / 留言板
  assert.ok(plan.comments.some((c) => c.postId > 0))
  assert.ok(plan.comments.some((c) => c.weiboId > 0))
  assert.ok(plan.comments.some((c) => c.postId === 0 && c.weiboId === 0))
  // 会员评论：引用的会员必须存在，昵称与会员展示名一致（前台徽标演示）
  assert.ok(plan.comments.some((c) => c.memberId > 0), '要有会员身份的评论（评论徽标演示）')
  plan.comments.forEach((c, i) => {
    if (c.memberId > 0) {
      const m = plan.members[c.memberId - 1]
      assert.ok(m, `评论 ${i + 1} 引用了不存在的会员 ${c.memberId}`)
      assert.equal(c.nickname, m.displayName, `评论 ${i + 1} 昵称应与会员展示名一致`)
    }
  })
})

test('种子计划：友链有 approved 也有 pending（待审列表有内容），页面含 about', () => {
  const plan = buildDemoPlan(NOW)
  assert.ok(plan.links.filter((l) => l.status === 'approved').length >= 5)
  assert.ok(plan.links.filter((l) => l.status === 'pending').length >= 1)
  for (const l of plan.links) assert.match(l.url, /^https:\/\//)
  assert.ok(plan.pages.some((p) => p.slug === 'about'))
  assert.ok(plan.pages.some((p) => p.showInNav === 1 && p.slug !== 'about'), '导航里有自建页面')
})

test('种子计划：settings 含 pagesSeeded 记账位（防 ensureSchema 重复播种关于页）', () => {
  const plan = buildDemoPlan(NOW)
  assert.equal(plan.settings.pagesSeeded, '1')
  assert.ok(plan.settings.siteName && plan.settings.siteName !== DEFAULT_SETTINGS.siteName, '演示站有自己的人设')
  assert.equal(plan.settings.siteClosed, undefined, '演示站种子不预置闭站状态')
  assert.equal(plan.settings.membersEnabled, '1', '会员体系开启：会员卡/积分/排行榜/付费墙都在体验范围内')
})

test('种子计划：会员专享与访问密码文各至少一篇且已发布（最新功能体验）', () => {
  const plan = buildDemoPlan(NOW)
  const locked = plan.posts.filter((p) => p.minTier === 'member' || p.minTier === 'coffee' || p.minTier === 'top')
  assert.ok(locked.length >= 1, '要有会员付费墙演示文')
  for (const p of locked) assert.equal(p.status, 'published', `付费墙演示文必须是已发布: ${p.slug}`)
  const pw = plan.posts.filter((p) => p.password)
  assert.ok(pw.length >= 1, '要有访问密码演示文')
  for (const p of pw) {
    assert.equal(p.status, 'published', `密码演示文必须是已发布: ${p.slug}`)
    assert.ok(p.password!.length >= 8, '密码至少 8 位（与真实校验口径一致）')
  }
})

test('种子计划：演示会员——账本合计 = 余额、档位合法、公示账号在列', () => {
  const plan = buildDemoPlan(NOW)
  assert.ok(plan.members.length >= 2, '公示账号之外还要有背景板会员（排行榜/徽标演示）')
  assert.equal(new Set(plan.members.map((m) => m.username)).size, plan.members.length, '会员用户名不重复')
  const demo = plan.members.find((m) => m.username === 'demo')
  assert.ok(demo, '公示演示会员账号 demo 必须在列')
  assert.equal(demo!.password, 'demo1234', '演示会员账号与密码必须公示口径一致')
  assert.ok(plan.members.some((m) => m.tier !== 'normal'), '有非普通档位会员（档位徽标演示）')
  for (const m of plan.members) {
    assert.ok(['normal', 'coffee', 'top'].includes(m.tier), `档位非法: ${m.tier}`)
    assert.ok(m.points > 0, `${m.username} 积分应大于 0（排行榜页要有内容）`)
    const sum = m.log.reduce((s, r) => s + r.delta, 0)
    assert.equal(sum, m.points, `${m.username} 积分账本合计必须等于余额`)
    for (const r of m.log) {
      assert.ok(['comment', 'dailyLogin', 'adminAdjust'].includes(r.reason), `积分 reason 非法: ${r.reason}`)
      assert.ok(r.createdAt <= NOW, '积分账本不能落在未来')
    }
  }
})

test('种子计划：访客统计 60 天有脉搏——今天有数据、天数齐、规模合理', () => {
  const plan = buildDemoPlan(NOW)
  assert.ok(plan.visits.length >= 1200 && plan.visits.length <= 6000, `访客日志 ${plan.visits.length} 条`)
  const days = new Set(plan.visits.map((v) => v.day))
  assert.equal(days.size, 60, '最近 60 天每天都该有数据')
  for (const v of plan.visits) {
    assert.match(v.day, /^\d{4}-\d{2}-\d{2}$/)
    assert.ok(v.ts <= NOW && v.ts > NOW - 61 * DAY)
  }
  const today = new Date(NOW + 8 * 3_600_000).toISOString().slice(0, 10)
  assert.ok(plan.visits.some((v) => v.day === today), '今天要有访问（后台统计页今日 PV > 0）')
  // 文章页打点占比可观，热门页排行有内容
  assert.ok(plan.visits.filter((v) => v.path.startsWith('/post/')).length > plan.visits.length * 0.3)
})
test('种子计划：北京零点后第一分钟，今天的访问不落前一天（clamp 跨天守卫）', () => {
  // 北京 2026-10-11 00:00:30 = UTC 2026-10-10T16:00:30Z：now-60s 仍在前一天
  const midnightish = Date.parse('2026-10-10T16:00:30Z')
  const plan = buildDemoPlan(midnightish)
  const days = new Set(plan.visits.map((v) => v.day))
  assert.equal(days.size, 60, '60 天一天不少')
  const today = new Date(midnightish + 8 * 3_600_000).toISOString().slice(0, 10)
  assert.ok(plan.visits.some((v) => v.day === today), '今天要有访问（今日 PV 不开天窗）')
  for (const v of plan.visits) assert.ok(v.ts <= midnightish, '访问不能落在未来')
})

test('种子图：SVG 合法、确定性、体积克制、无脚本', () => {
  const imgs = demoImages()
  assert.equal(imgs.length, demoImages().length, '确定性：重复调用结果数量一致')
  assert.deepEqual(imgs.map((i) => i.key), demoImages().map((i) => i.key))
  const keys = new Set<string>()
  for (const img of imgs) {
    assert.ok(!keys.has(img.key), `key 重复: ${img.key}`)
    keys.add(img.key)
    assert.match(img.key, /^u\/demo\/[\w-]+\.svg$/)
    assert.equal(img.mime, 'image/svg+xml')
    assert.ok(img.svg.startsWith('<svg xmlns="http://www.w3.org/2000/svg"'), '必须是带命名空间的 SVG')
    assert.ok(img.svg.endsWith('</svg>'))
    assert.ok(!/<script/i.test(img.svg))
    assert.ok(img.svg.length < 6_000, `图太大（${img.key}: ${img.svg.length} 字节），bundle 会被撑爆`)
  }
  assert.ok(imgs.filter((i) => i.key.startsWith('u/demo/cover-')).length >= 6, '封面图够列表页用')
})

test('DEMO_MODE 守卫：发布/评论钩子整段短路，体验者配了 TG/webhook 也不会外发', async () => {
  const settings = (over: Partial<SettingsMap>): SettingsMap => ({ ...DEFAULT_SETTINGS, ...over })
  const calls: string[] = []
  const orig = globalThis.fetch
  globalThis.fetch = (async (url: unknown) => {
    calls.push(String(url))
    return new Response('{}', { status: 200 })
  }) as typeof fetch
  try {
    const demoEnv = {
      DEMO_MODE: '1',
      DB: {
        prepare: () => ({ all: async () => ({ results: [{ key: 'telegramBotToken', value: 'tok' }, { key: 'tgChannelChatId', value: '@ch' }, { key: 'commentWebhookUrl', value: 'https://hook.example.com/x' }] }) }),
      },
    } as unknown as Env
    await firePostPublished(demoEnv, { slug: 'x', title: 't', summary: '', via: 'admin' })
    await fireCommentCreated(demoEnv, { kind: 'post', nickname: 'n', content: 'c', url: '', pending: false })
    assert.equal(calls.length, 0, '演示站不得有外发请求')

    // 对照组：无 DEMO_MODE 时钩子照常工作（证明短路是 demo 守卫带来的，不是钩子坏了）
    const prodEnv = {
      DB: {
        prepare: () => ({ all: async () => ({ results: [{ key: 'telegramBotToken', value: 'tok' }, { key: 'tgChannelChatId', value: '@ch' }] }) }),
      },
    } as unknown as Env
    await firePostPublished(prodEnv, { slug: 'x', title: 't', summary: '', via: 'admin' })
    assert.equal(calls.length, 1)
    assert.match(calls[0], /api\.telegram\.org/)
  } finally {
    globalThis.fetch = orig
  }
})

test('DEMO_MODE 守卫：notifyAdminText / TG webhook 等插件总线之外的出网路同样短路', async () => {
  const calls: string[] = []
  const orig = globalThis.fetch
  globalThis.fetch = (async (url: unknown) => {
    calls.push(String(url))
    return new Response('{"ok":true}', { status: 200 })
  }) as typeof fetch
  try {
    const settingsRow = [{ key: 'telegramBotToken', value: 'tok' }, { key: 'telegramAllowFrom', value: '123' }]
    const demoEnv = {
      DEMO_MODE: '1',
      DB: {
        prepare: () => ({ all: async () => ({ results: settingsRow }), first: async () => null }),
      },
    } as unknown as Env
    // 备份失败 / 定时发布 / 评论通知都经 notifyAdminText 直发 TG——demo 下不得出网
    await notifyAdminText(demoEnv, '备份失败')
    await notifyAdminComment(demoEnv, { kind: 'post', nickname: 'n', content: 'c', pending: false, siteBase: '', path: '' })
    assert.equal(calls.length, 0, '演示站不得有外发请求（notifyAdminText 也必须短路）')

    // 对照组：无 DEMO_MODE 时通知照常发（证明短路是 demo 守卫带来的）
    const prodEnv = {
      DB: {
        prepare: () => ({ all: async () => ({ results: settingsRow }), first: async () => null }),
      },
    } as unknown as Env
    await notifyAdminText(prodEnv, '备份失败')
    assert.equal(calls.length, 1)
    assert.match(calls[0], /api\.telegram\.org/)
  } finally {
    globalThis.fetch = orig
  }
})

test('种子微博：话题可提取、点赞计数非负、草稿不进时间线', () => {
  assert.ok(DEMO_WEIBO.length >= 24, '微博足够铺满几页时间线')
  assert.ok(DEMO_WEIBO.some((w) => w.pinned), '有置顶微博')
  assert.ok(DEMO_WEIBO.some((w) => w.draft), '有微博草稿（后台列表有内容）')
  for (const w of DEMO_WEIBO) {
    assert.ok(w.likes >= 0)
    assert.ok(w.content.length >= 6, '微博内容不至于空转')
  }
})

test('随机数：mulberry32 确定性且分布合理', () => {
  const a = mulberry32(42)
  const b = mulberry32(42)
  const seq = [a(), a(), a()]
  assert.deepEqual(seq, [b(), b(), b()])
  const r = mulberry32(7)
  for (let i = 0; i < 100; i++) {
    const v = r()
    assert.ok(v >= 0 && v < 1)
  }
})
