import { test } from 'node:test'
import assert from 'node:assert/strict'
import { bufferPostText, fireCommentCreated, firePlazaRetract, firePostPublished, fireWeiboPublished, listServerPlugins, plazaSign, renderFooterHtml } from '../src/hooks.ts'
import { verifyPlazaSignature } from '../plaza/src/core.ts'
import { DEFAULT_SETTINGS } from '../src/db.ts'
import type { Env, SettingsMap } from '../src/types.ts'

// ── 服务端插件钩子（roadmap A5）：总线过滤 + 官方示例插件行为 + 失败吞掉 ──

const settings = (over: Partial<SettingsMap>): SettingsMap => ({ ...DEFAULT_SETTINGS, ...over })

/** getSettings 只用 prepare().all()，桩掉整个 D1（注意包一层 Env：fire 函数取 env.DB） */
function fakeEnv(rows: { key: string; value: string }[] = []): Env {
  return {
    DB: { prepare: () => ({ all: async () => ({ results: rows }) }) } as unknown as D1Database,
  } as unknown as Env
}

/** 抓 fetch 调用（示例插件全部走 fetch 外发） */
function captureFetch() {
  const calls: { url: string; init?: RequestInit }[] = []
  const orig = globalThis.fetch
  globalThis.fetch = (async (url: unknown, init?: RequestInit) => {
    calls.push({ url: String(url), init })
    return new Response('{}', { status: 200 })
  }) as typeof fetch
  return {
    calls,
    restore() {
      globalThis.fetch = orig
    },
  }
}

test('页脚注入：footerHtmlCode 进页脚，停用名单可关掉', () => {
  const s = settings({ footerHtmlCode: '<div class="badge">🌙 365 天</div>' })
  assert.equal(renderFooterHtml(s), '<div class="badge">🌙 365 天</div>')
  const off = settings({ footerHtmlCode: '<div>x</div>', serverPluginsDisabled: 'footer-html' })
  assert.equal(renderFooterHtml(off), '')
  // 其他插件被停用不影响 footer-html
  const otherOff = settings({ footerHtmlCode: '<i>hi</i>', serverPluginsDisabled: 'tg-channel,comment-webhook' })
  assert.equal(renderFooterHtml(otherOff), '<i>hi</i>')
  assert.equal(renderFooterHtml(settings({})), '')
})

test('发布同步 TG 频道：token+频道ID 齐才发，消息带标题与链接，可被停用', async () => {
  const cap = captureFetch()
  try {
    const env = fakeEnv([
      { key: 'telegramBotToken', value: 'tok123' },
      { key: 'tgChannelChatId', value: '@mychannel' },
      { key: 'siteUrl', value: 'https://blog.example.com/' },
    ])
    await firePostPublished(env, { slug: 'hello', title: '新文章', summary: '摘要', via: 'scheduler' })
    assert.equal(cap.calls.length, 1)
    assert.match(cap.calls[0].url, /api\.telegram\.org\/bottok123\/sendMessage/)
    const body = JSON.parse(String(cap.calls[0].init?.body))
    assert.equal(body.chat_id, '@mychannel')
    assert.match(body.text, /新文章/)
    assert.match(body.text, /https:\/\/blog\.example\.com\/post\/hello/)
    // 频道 ID 未填：静默不发
    await firePostPublished(fakeEnv([{ key: 'telegramBotToken', value: 'tok123' }]), {
      slug: 'x', title: 't', summary: '', via: 'admin',
    })
    // 插件被停用：不发
    await firePostPublished(
      fakeEnv([
        { key: 'telegramBotToken', value: 'tok123' },
        { key: 'tgChannelChatId', value: '@mychannel' },
        { key: 'serverPluginsDisabled', value: 'tg-channel' },
      ]),
      { slug: 'x', title: 't', summary: '', via: 'admin' }
    )
    assert.equal(cap.calls.length, 1)
  } finally {
    cap.restore()
  }
})

test('微博同步 Buffer：key+渠道齐才发，mode=shareNow，站内图拼 siteUrl，可被停用', async () => {
  const cap = captureFetch()
  try {
    const env = fakeEnv([
      { key: 'bufferAccessToken', value: 'bf-tok' },
      { key: 'bufferChannelId', value: 'chan1' },
      { key: 'siteUrl', value: 'https://blog.example.com/' },
    ])
    await fireWeiboPublished(env, { id: 7, content: '随手记 #随拍#', images: ['/images/a.jpg', 'https://cdn.example.com/b.png'], via: 'admin' })
    assert.equal(cap.calls.length, 1)
    assert.equal(cap.calls[0].url, 'https://api.buffer.com')
    assert.equal(cap.calls[0].init?.headers && (cap.calls[0].init.headers as Record<string, string>)['authorization'], 'Bearer bf-tok')
    const body = JSON.parse(String(cap.calls[0].init?.body))
    const input = body.variables.input
    assert.equal(input.channelId, 'chan1')
    assert.equal(input.mode, 'shareNow')
    assert.equal(input.schedulingType, 'automatic')
    assert.equal(input.text, '随手记 #随拍')
    assert.deepEqual(input.assets, [
      { image: { url: 'https://blog.example.com/images/a.jpg' } },
      { image: { url: 'https://cdn.example.com/b.png' } },
    ])
    // key 或渠道未填：静默不发
    await fireWeiboPublished(fakeEnv([{ key: 'bufferAccessToken', value: 'bf-tok' }]), { id: 1, content: 'x', images: [], via: 'admin' })
    // 插件被停用：不发
    await fireWeiboPublished(
      fakeEnv([
        { key: 'bufferAccessToken', value: 'bf-tok' },
        { key: 'bufferChannelId', value: 'chan1' },
        { key: 'serverPluginsDisabled', value: 'buffer-sync' },
      ]),
      { id: 1, content: 'x', images: [], via: 'admin' }
    )
    assert.equal(cap.calls.length, 1)
  } finally {
    cap.restore()
  }
})

test('微博同步 Buffer：MutationError 不抛出（fire 正常 resolve），无图不带 assets', async () => {
  const orig = globalThis.fetch
  globalThis.fetch = (async () =>
    new Response(JSON.stringify({ data: { createPost: { message: 'LinkedIn posts cannot exceed 3000 characters.' } } }), {
      status: 200,
    })) as typeof fetch
  try {
    const env = fakeEnv([
      { key: 'bufferAccessToken', value: 'bf-tok' },
      { key: 'bufferChannelId', value: 'chan1' },
    ])
    await fireWeiboPublished(env, { id: 2, content: '纯文字', images: [], via: 'draft' })
  } finally {
    globalThis.fetch = orig
  }
})

test('bufferPostText：话题 #xx# 转 #xx，超 270 码点截断（emoji 不破代理对）', () => {
  assert.equal(bufferPostText('今天天气不错 #随拍#'), '今天天气不错 #随拍')
  // 与站内 extractWeiboTopics 同上限：≤24 字的话题转换，>24 字的 #xx# 原样保留
  assert.equal(bufferPostText(`#${'长'.repeat(24)}#正文`), `#${'长'.repeat(24)}正文`)
  assert.equal(bufferPostText(`#${'长'.repeat(25)}#`), `#${'长'.repeat(25)}#`)
  const long = '好'.repeat(300)
  const cut = bufferPostText(long)
  assert.equal([...cut].length, 270)
  // 270 码点边界不截断；emoji 逐码点数（😀 记 1 个码点）
  assert.equal(bufferPostText('好'.repeat(270)), '好'.repeat(270))
  assert.equal([...bufferPostText('😀'.repeat(280))].length, 270)
})

test('评论 webhook：合法地址才 POST JSON（含事件名与留言内容）', async () => {
  const cap = captureFetch()
  try {
    const env = fakeEnv([{ key: 'commentWebhookUrl', value: 'https://hook.example.com/feed' }])
    await fireCommentCreated(env, {
      kind: 'post', nickname: '小吴', content: '写得真好', context: '某文章', url: 'https://blog.example.com/post/a#comments', pending: false,
    })
    assert.equal(cap.calls.length, 1)
    assert.equal(cap.calls[0].url, 'https://hook.example.com/feed')
    const body = JSON.parse(String(cap.calls[0].init?.body))
    assert.equal(body.event, 'comment.created')
    assert.equal(body.nickname, '小吴')
    assert.equal(body.content, '写得真好')
    // 地址不合法 / 插件停用：不发
    await fireCommentCreated(fakeEnv([{ key: 'commentWebhookUrl', value: 'javascript:alert(1)' }]), {
      kind: 'guestbook', nickname: 'a', content: 'b', url: '', pending: true,
    })
    await fireCommentCreated(
      fakeEnv([
        { key: 'commentWebhookUrl', value: 'https://hook.example.com/feed' },
        { key: 'serverPluginsDisabled', value: 'comment-webhook' },
      ]),
      { kind: 'guestbook', nickname: 'a', content: 'b', url: '', pending: true }
    )
    assert.equal(cap.calls.length, 1)
  } finally {
    cap.restore()
  }
})

test('插件失败被吞掉：fetch 抛错时 fire 正常 resolve，不影响主流程', async () => {
  const orig = globalThis.fetch
  globalThis.fetch = (async () => {
    throw new Error('network down')
  }) as typeof fetch
  try {
    const env = fakeEnv([
      { key: 'commentWebhookUrl', value: 'https://hook.example.com/feed' },
      { key: 'telegramBotToken', value: 'tok' },
      { key: 'tgChannelChatId', value: '@ch' },
    ])
    await fireCommentCreated(env, { kind: 'weibo', nickname: 'a', content: 'b', url: '', pending: false })
    await firePostPublished(env, { slug: 'a', title: 'b', summary: '', via: 'admin' })
  } finally {
    globalThis.fetch = orig
  }
})

test('注册表元数据：id/标题/版本齐全，不带处理函数，id 全部合法（可进停用名单）', () => {
  const list = listServerPlugins()
  assert.ok(list.length >= 3)
  for (const p of list) {
    assert.ok(p.id && p.title && p.version && p.author)
    assert.match(p.id, /^[A-Za-z0-9_-]+$/)
    assert.equal('onPostPublished' in p, false)
    assert.equal('onCommentCreated' in p, false)
    assert.equal('footerHtml' in p, false)
  }
})

// ── 广场同步插件（roadmap B17）：配置齐才发 / 签名头齐全 / locked 跳过 / 可停用 ──

test('广场同步：endpoint+token 齐才发，签名三头齐全，文章与微博各推一条', async () => {
  const cap = captureFetch()
  try {
    const env = fakeEnv([
      { key: 'plazaEndpoint', value: 'https://plaza.example.com/' },
      { key: 'plazaToken', value: 'a'.repeat(32) },
      { key: 'siteUrl', value: 'https://blog.example.com/' },
    ])
    await firePostPublished(env, { slug: 'hello', title: '新文章', summary: '摘要', via: 'admin' })
    assert.equal(cap.calls.length, 1)
    const post = cap.calls[0]
    assert.equal(post.url, 'https://plaza.example.com/api/ingest')
    const h = post.init?.headers as Record<string, string>
    assert.equal(h['x-plaza-token'], 'a'.repeat(32))
    assert.match(h['x-plaza-timestamp'], /^\d+$/)
    assert.match(h['x-plaza-signature'], /^[0-9a-f]{64}$/)
    // 签名可被 hub 校验端复算通过（双端镜像）
    const body = JSON.parse(String(post.init?.body))
    assert.equal(await verifyPlazaSignature('a'.repeat(32), h['x-plaza-timestamp'], h['x-plaza-signature'], String(post.init?.body)), true)
    assert.equal(body.items[0].kind, 'post')
    assert.equal(body.items[0].ref, 'hello')
    assert.equal(body.items[0].url, 'https://blog.example.com/post/hello')

    // 微博：深链 /weibo#wb-{id}，站内 /images/ 补 base，外链原样
    await fireWeiboPublished(env, { id: 12, content: '随手记', images: ['/images/x.webp'], via: 'admin' })
    const wb = JSON.parse(String(cap.calls[1].init?.body))
    assert.equal(wb.items[0].kind, 'weibo')
    assert.equal(wb.items[0].ref, '12')
    assert.equal(wb.items[0].url, 'https://blog.example.com/weibo#wb-12')
    assert.equal(wb.items[0].image, 'https://blog.example.com/images/x.webp')
  } finally {
    cap.restore()
  }
})

test('广场同步：locked（加密/会员锁文）不上广场，微博外链图原样、http 图置空', async () => {
  const cap = captureFetch()
  try {
    const env = fakeEnv([
      { key: 'plazaEndpoint', value: 'https://plaza.example.com' },
      { key: 'plazaToken', value: 'a'.repeat(32) },
      { key: 'siteUrl', value: 'https://blog.example.com' },
    ])
    await firePostPublished(env, { slug: 'locked', title: '锁文', summary: 's', via: 'admin', locked: true })
    assert.equal(cap.calls.length, 0)
    await fireWeiboPublished(env, { id: 3, content: '带外链图', images: ['https://cdn.example.com/a.png'], via: 'external' })
    assert.equal(JSON.parse(String(cap.calls[0].init?.body)).items[0].image, 'https://cdn.example.com/a.png')
    await fireWeiboPublished(env, { id: 4, content: '纯文字', images: [], via: 'telegram' })
    assert.equal(JSON.parse(String(cap.calls[1].init?.body)).items[0].image, '')
  } finally {
    cap.restore()
  }
})

test('广场同步：只填 token 即默认同步官方 hub，未填 token 静默不发；停用名单可关；站点链接未配置时 url 为空', async () => {
  const cap = captureFetch()
  try {
    // plazaEndpoint 默认就是官方 hub：填 token 即同步，无需另配地址（docs/PLAZA.md 口径）
    const env = fakeEnv([{ key: 'plazaToken', value: 'a'.repeat(32) }])
    await firePostPublished(env, { slug: 'a', title: 'b', summary: '', via: 'admin' })
    assert.equal(cap.calls.length, 1)
    assert.equal(cap.calls[0].url, 'https://bloghao.com/plaza/api/ingest')
    // 未填 token（未在 hub 注册）：静默不发
    const env0 = fakeEnv([{ key: 'plazaEndpoint', value: 'https://plaza.example.com' }])
    await firePostPublished(env0, { slug: 'a', title: 'b', summary: '', via: 'admin' })
    assert.equal(cap.calls.length, 1)
    // 停用名单可关
    const env2 = fakeEnv([
      { key: 'plazaEndpoint', value: 'https://plaza.example.com' },
      { key: 'plazaToken', value: 'a'.repeat(32) },
      { key: 'serverPluginsDisabled', value: 'plaza-sync' },
    ])
    await firePostPublished(env2, { slug: 'a', title: 'b', summary: '', via: 'admin' })
    assert.equal(cap.calls.length, 1)
    // siteUrl 未配置：条目照推，url 留空由 hub 侧拒收（validateIngest 只收 https）
    const env3 = fakeEnv([
      { key: 'plazaEndpoint', value: 'https://plaza.example.com' },
      { key: 'plazaToken', value: 'a'.repeat(32) },
    ])
    await firePostPublished(env3, { slug: 'a', title: 'b', summary: '', via: 'admin' })
    assert.equal(cap.calls.length, 2)
    assert.equal(JSON.parse(String(cap.calls[1].init?.body)).items[0].url, '')
  } finally {
    cap.restore()
  }
})

test('firePlazaRetract：下架广播带 deleted 载荷；未配置 / 停用插件不外发', async () => {
  const cap = captureFetch()
  try {
    // 配置齐全：deleted 进 ingest body，不携带 items（下架与上架是两种载荷）
    const env = fakeEnv([
      { key: 'plazaToken', value: 'a'.repeat(32) },
      { key: 'plazaEndpoint', value: 'https://hub.example.com/plaza' },
    ])
    await firePlazaRetract(env, [{ kind: 'post', ref: 'hello-world' }])
    assert.equal(cap.calls.length, 1)
    assert.ok(cap.calls[0].url.startsWith('https://hub.example.com/plaza/api/ingest'), cap.calls[0].url)
    const body = JSON.parse(String(cap.calls[0].init?.body))
    assert.deepEqual(body.deleted, [{ kind: 'post', ref: 'hello-world' }])
    assert.ok(!('items' in body), '下架广播不携带 items')

    // 未配置 token：静默不外发
    await firePlazaRetract(fakeEnv([]), [{ kind: 'weibo', ref: '9' }])
    assert.equal(cap.calls.length, 1)

    // plaza-sync 被停用：同口径不外发（下架跟随插件开关）
    await firePlazaRetract(
      fakeEnv([
        { key: 'plazaToken', value: 'a'.repeat(32) },
        { key: 'serverPluginsDisabled', value: 'plaza-sync' },
      ]),
      [{ kind: 'post', ref: 'x' }]
    )
    assert.equal(cap.calls.length, 1)
  } finally {
    cap.restore()
  }
})
