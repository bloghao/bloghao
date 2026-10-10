/**
 * 服务端插件钩子（roadmap A5）：内核在关键动作处广播事件，插件按需订阅处理。
 *
 * 设计约束（AGENTS.md 复杂度预算）：总线、注册表与官方示例插件全部收在本文件——
 * 第三方服务端插件以「提交进 SERVER_PLUGINS 注册表」的方式分发（与主题注册表同模式，
 * 随部署生效、无热加载）；前台编辑器插件（public/plugins/，免部署启停）是另一条线，互不相干。
 *
 * 铁律：任何插件抛错都不影响主流程（发文/评论/渲染照常）——fire 函数统一 try/catch 吞掉，
 * 页脚注入是同步渲染路径，插件 HTML 原样拼接不做转义（内容来自站长自己，与主题 CSS 同信任级）。
 */
import { getSettings } from './db'
import type { Env, SettingsMap } from './types'
import { excerpt, isDemo } from './utils'

export interface HookContext {
  /** 异步事件的运行环境（页脚注入是同步渲染路径，没有 env） */
  env?: Env
  settings: SettingsMap
  /** 站点绝对地址前缀（siteUrl 去尾斜杠，未配置为空串） */
  base: string
}

export interface PostPublishedPayload {
  slug: string
  title: string
  summary: string
  /** 触发来源：后台手动发布 / 定时到点 */
  via: 'admin' | 'scheduler'
  /**
   * 加密文 / 会员锁文（password_hash 非空或 min_tier ≠ all）。广场同步插件据此跳过——
   * 加密文标题摘要都不该出现在公开广场（防泄漏清单同口径）。老调用点不传视为 false
   */
  locked?: boolean
}

export interface CommentCreatedPayload {
  kind: 'post' | 'weibo' | 'guestbook'
  nickname: string
  content: string
  /** 所在文章标题 / 微博摘要，留言板为空 */
  context?: string
  /** 访客可点的直达地址（含锚点），未配置站点链接时为空串 */
  url: string
  /** 是否待审核（先审后展模式下访客留言的初始状态） */
  pending: boolean
}

export interface WeiboPublishedPayload {
  id: number
  content: string
  /** 站内图片地址数组（/images/… 或外链），原样入库的 images 列 */
  images: string[]
  /** 触发来源：后台（含前台卡片编辑器）/ 开放 API / Telegram 机器人 / 草稿转发布 */
  via: 'admin' | 'external' | 'telegram' | 'draft'
}

export interface ServerPlugin {
  id: string
  title: string
  description: string
  version: string
  author: string
  /** 文章发布（草稿/定时 → 已发布的跃迁，重复保存已发布文章不触发） */
  onPostPublished?: (p: PostPublishedPayload, ctx: HookContext) => Promise<void> | void
  /** 微博发布（新建即发 / 草稿转发布，编辑已发布微博不触发） */
  onWeiboPublished?: (p: WeiboPublishedPayload, ctx: HookContext) => Promise<void> | void
  /** 访客发表评论 / 留言（作者自己的回复不触发，避免同步场景里自我刷屏） */
  onCommentCreated?: (p: CommentCreatedPayload, ctx: HookContext) => Promise<void> | void
  /** 页脚注入：返回的 HTML 拼在每页 </body> 前（同步，不能访问 env） */
  footerHtml?: (ctx: HookContext) => string
}

/* ---------------- 官方示例插件 ---------------- */

/** 示例 1：发布同步 TG 频道 —— 复用「外部发布」的 Bot Token，频道 ID 在「设置 → 外部发布」填写 */
const tgChannel: ServerPlugin = {
  id: 'tg-channel',
  title: '发布同步 Telegram 频道',
  description:
    '文章发布时自动推送到指定 Telegram 频道 / 群。复用「外部发布」的 Bot Token，另填频道 ID（如 @mychannel 或 -100 开头的群 ID）；Bot 需先加入频道并有发帖权限。',
  version: '1.0.0',
  author: '官方',
  async onPostPublished(p, ctx) {
    const chatId = (ctx.settings.tgChannelChatId || '').trim()
    const token = (ctx.settings.telegramBotToken || '').trim()
    if (!chatId || !token) return
    const link = ctx.base ? `${ctx.base}/post/${p.slug}` : ''
    const text = [`📢 ${p.title}`, excerpt(p.summary, 120), link]
      .filter(Boolean)
      .join('\n\n')
    await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ chat_id: chatId, text }),
      signal: AbortSignal.timeout(10_000),
    })
  },
}

/** 示例 2：评论 webhook —— 访客留言时 POST 一段 JSON 到自配地址（飞书 / 企微 / Bark 等都能接） */
const commentWebhook: ServerPlugin = {
  id: 'comment-webhook',
  title: '评论 Webhook 推送',
  description:
    '访客发表评论 / 留言时，向自配 URL POST 一段 JSON（event/nickname/content/url 等）——飞书群机器人、企业微信、Bark、Server酱 等通知渠道都能接。地址在「设置 → 服务端插件」填写。',
  version: '1.0.0',
  author: '官方',
  async onCommentCreated(p, ctx) {
    const url = (ctx.settings.commentWebhookUrl || '').trim()
    if (!/^https?:\/\//i.test(url)) return
    await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ event: 'comment.created', site: ctx.settings.siteName, ...p }),
      signal: AbortSignal.timeout(10_000),
    })
  },
}

/** 示例 3：页脚注入 —— 「设置 → 服务端插件」里的自定义 HTML 注入每页页脚（挂件 / 徽章等） */
const footerHtmlPlugin: ServerPlugin = {
  id: 'footer-html',
  title: '页脚自定义代码',
  description:
    '把自定义 HTML（挂件、徽章、运行天数、备案图标等）注入每一页页脚，内容在「设置 → 服务端插件」维护。受全站 CSP 保护：内联样式可用，外部 <script> 不会执行。',
  version: '1.0.0',
  author: '官方',
  footerHtml(ctx) {
    return (ctx.settings.footerHtmlCode || '').trim()
  },
}

/* ---------------- 微博同步 Buffer（X 等） ----------------
 * Buffer 是第三方社交排程平台：免费档 3 渠道 + 每渠道 10 条队列并含 API 访问，
 * 它替用户承担了 X API 的按量计费（2025 起 X API 无免费档，纯文字 $0.015/条、带链接 $0.200/条），
 * 博主侧零成本拿到「发微博 → 自动同步 X」的链路。注册 https://buffer.com 连上 X 账号后，
 * 在 publish.buffer.com/settings/api 生成 API Key。
 *
 * 接口为 GraphQL（https://api.buffer.com，Bearer 鉴权）：createPost 的 mode=shareNow 立即发布，
 * assets 走 {image:{url}} 公链直传（站内 /images/ 配上 siteUrl 即可，无需 X 的媒体上传接口）。
 * X 免费账号单帖 280 字符（URL 记 23、emoji 记 2），超出 Buffer 会报错——这里按 270 硬截断保发布。
 */

const BUFFER_API = 'https://api.buffer.com'

/** X 免费档 280 字符（URL 计 23、emoji 计 2 的加权口径），留 10 字符余量 */
const BUFFER_X_CHARS = 270

/** Buffer createPost（variables 传参防拼接转义）；返回 MutationError 的 message 或 null=成功/无响应 */
async function bufferCreatePost(
  token: string,
  input: Record<string, unknown>
): Promise<string | null> {
  try {
    const res = await fetch(BUFFER_API, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
      body: JSON.stringify({
        query:
          'mutation CreatePost($input: CreatePostInput!) { createPost(input: $input) { ... on PostActionSuccess { post { id } } ... on MutationError { message } } }',
        variables: { input },
      }),
      signal: AbortSignal.timeout(15_000),
    })
    const d = (await res.json().catch(() => null)) as { data?: { createPost?: { message?: string } } } | null
    // GraphQL 恒 200，失败在 payload 里（如字符数超限）；网络/JSON 异常按成功处理不重试
    return d?.data?.createPost?.message ?? null
  } catch {
    return null
  }
}

/** 微博文本 → Buffer/X 帖文：话题 #xx# 改 #xx（X 话题语法，长度口径与站内话题提取同限 1-24 字），
 *  超 270 码点截断（emoji 截半个也不破头） */
export function bufferPostText(content: string): string {
  const t = content.replace(/#([^#\n]{1,24})#/g, '#$1').trim()
  if ([...t].length <= BUFFER_X_CHARS) return t
  return [...t].slice(0, BUFFER_X_CHARS).join('')
}

const bufferSync: ServerPlugin = {
  id: 'buffer-sync',
  title: '微博同步 Buffer（X 等）',
  description:
    '微博发布时自动同步到 Buffer 排程的社交渠道（X / Bluesky / Threads 等），免费档 3 渠道够用。API Key 在 buffer.com 的 publish.buffer.com/settings/api 生成，渠道 ID 在「设置 → 服务端插件」一键拉取；X 免费档 280 字符，超出自动截断。',
  version: '1.0.0',
  author: '官方',
  async onWeiboPublished(p, ctx) {
    const token = (ctx.settings.bufferAccessToken || '').trim()
    const channelId = (ctx.settings.bufferChannelId || '').trim()
    if (!token || !channelId) return
    const assets = p.images
      .filter((s) => /^https?:\/\//i.test(s) || (ctx.base && s.startsWith('/images/')))
      .slice(0, 4)
      .map((s) => ({ image: { url: s.startsWith('/images/') ? ctx.base + s : s } }))
    const err = await bufferCreatePost(token, {
      channelId,
      text: bufferPostText(p.content),
      schedulingType: 'automatic',
      mode: 'shareNow',
      ...(assets.length ? { assets } : {}),
    })
    if (err) console.error(`[buffer-sync] createPost: ${err}`)
  },
}

/** 后台「拉取渠道」用：channels 查询需 organizationId，先经 account 查询取第一个组织 */
export async function listBufferChannels(
  token: string
): Promise<{ ok: true; channels: { id: string; service: string; displayName: string }[] } | { ok: false; error: string }> {
  try {
    const headers = { 'content-type': 'application/json', authorization: `Bearer ${token}` }
    const q = JSON.stringify({
      query: 'query GetChannels($org: OrganizationId!) { channels(input: { organizationId: $org }) { id service displayName } }',
    })
    const acc = await fetch(BUFFER_API, {
      method: 'POST',
      headers,
      body: JSON.stringify({ query: 'query GetOrg { account { organizations { id name } } }' }),
      signal: AbortSignal.timeout(15_000),
    })
    const ad = (await acc.json().catch(() => null)) as {
      data?: { account?: { organizations?: { id: string; name: string }[] } }
      errors?: { message: string }[]
    } | null
    const org = ad?.data?.account?.organizations?.[0]
    if (!org) return { ok: false, error: ad?.errors?.[0]?.message || 'API Key 无效或账号下没有组织' }
    const res = await fetch(BUFFER_API, {
      method: 'POST',
      headers,
      body: JSON.stringify({ ...JSON.parse(q), variables: { org: org.id } }),
      signal: AbortSignal.timeout(15_000),
    })
    const cd = (await res.json().catch(() => null)) as {
      data?: { channels?: { id: string; service: string; displayName: string }[] }
      errors?: { message: string }[]
    } | null
    if (!cd?.data?.channels) return { ok: false, error: cd?.errors?.[0]?.message || '拉取渠道失败' }
    return { ok: true, channels: cd.data.channels }
  } catch {
    return { ok: false, error: 'Buffer 无响应，稍后再试' }
  }
}

/* ---------------- 广场同步（roadmap B17：官网 bloghao.com/plaza 内容聚合流） ----------------
 * push 主路：文章/微博发布时把公开条目推给广场 hub（独立 Worker，协议见 docs/PLAZA.md）。
 * 「是否同步到广场」的开关就是后台「插件」页启停本插件（opt-in），配置在「设置 → 服务端插件」：
 * 广场地址留空 = 官方 hub（唯一官方入口，稳定版 / 开发版一律由此接入），填自建 hub 才改；
 * 注册 token 由 hub 站长审核发放。加密文 / 会员锁文不上广场。
 * pull 补漏路（hub 定时抓 /rss.xml 文章）在 hub 侧，见 plaza/。
 */

/** 官方广场 hub（唯一官方入口）：plazaEndpoint 留空时回落到这里 */
const PLAZA_OFFICIAL_HUB = 'https://plaza.bloghao.com'

/** 广场 ingest 签名：HMAC-SHA256(token, `ts.rawBody`) → hex。与 hub 校验端同一算法（tests 双端镜像） */
export async function plazaSign(token: string, ts: string, rawBody: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(token),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign']
  )
  const sig = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(`${ts}.${rawBody}`))
  const v = new Uint8Array(sig)
  let s = ''
  for (let i = 0; i < v.length; i++) s += v[i].toString(16).padStart(2, '0')
  return s
}

const plazaSync: ServerPlugin = {
  id: 'plaza-sync',
  title: '广场同步（bloghao.com）',
  description:
    '文章与微博发布时自动同步到官网广场（bloghao.com/plaza），让更多博主看到你的更新。需要在广场 hub 注册站点拿到 token（见 docs/PLAZA.md），填进「设置 → 服务端插件」；加密文与会员专属文不会同步。',
  version: '1.0.0',
  author: '官方',
  async onPostPublished(p, ctx) {
    if (p.locked) return
    const endpoint = (ctx.settings.plazaEndpoint || PLAZA_OFFICIAL_HUB).trim().replace(/\/+$/, '')
    const token = (ctx.settings.plazaToken || '').trim()
    if (!/^https:\/\//i.test(endpoint) || !token) return
    await plazaIngest(endpoint, token, {
      items: [
        {
          kind: 'post',
          ref: p.slug,
          title: p.title,
          summary: excerpt(p.summary, 500),
          url: ctx.base ? `${ctx.base}/post/${p.slug}` : '',
          image: '',
          publishedAt: Date.now(),
        },
      ],
    })
  },
  async onWeiboPublished(p, ctx) {
    const endpoint = (ctx.settings.plazaEndpoint || PLAZA_OFFICIAL_HUB).trim().replace(/\/+$/, '')
    const token = (ctx.settings.plazaToken || '').trim()
    if (!/^https:\/\//i.test(endpoint) || !token) return
    await plazaIngest(endpoint, token, {
      items: [
        {
          kind: 'weibo',
          ref: String(p.id),
          title: excerpt(p.content, 80),
          summary: excerpt(p.content, 500),
          url: ctx.base ? `${ctx.base}/weibo#wb-${p.id}` : '',
          // hub 只收 https 绝对地址：站内 /images/ 补 base 前缀，外链原样，其余置空
          image: p.images[0]
            ? p.images[0].startsWith('/images/') && ctx.base
              ? ctx.base + p.images[0]
              : /^https:\/\//i.test(p.images[0])
                ? p.images[0]
                : ''
            : '',
          publishedAt: Date.now(),
        },
      ],
    })
  },
}

/** 签名上报（fireHook 已吞错，这里失败抛出也只丢这一条同步，不影响发布主流程） */
async function plazaIngest(endpoint: string, token: string, body: Record<string, unknown>): Promise<void> {
  const ts = String(Date.now())
  const raw = JSON.stringify(body)
  const res = await fetch(`${endpoint}/api/ingest`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-plaza-token': token,
      'x-plaza-timestamp': ts,
      'x-plaza-signature': await plazaSign(token, ts, raw),
    },
    body: raw,
    signal: AbortSignal.timeout(15_000),
  })
  if (!res.ok) console.error(`[plaza-sync] ingest ${res.status}`)
}

/** 注册表：第三方服务端插件在此登记（顺序即后台展示顺序） */
export const SERVER_PLUGINS: ServerPlugin[] = [tgChannel, commentWebhook, bufferSync, plazaSync, footerHtmlPlugin]

/** 后台「插件」页列表用：只出元数据，不带处理函数 */
export function listServerPlugins(): { id: string; title: string; description: string; version: string; author: string }[] {
  return SERVER_PLUGINS.map(({ id, title, description, version, author }) => ({ id, title, description, version, author }))
}

/* ---------------- 总线 ---------------- */

function enabledPlugins(settings: SettingsMap): ServerPlugin[] {
  const off = new Set((settings.serverPluginsDisabled || '').split(',').filter(Boolean))
  return SERVER_PLUGINS.filter((p) => !off.has(p.id))
}

/** 页脚注入汇总（render.ts page() 每页调用：同步、无 DB 访问、出错跳过该插件） */
export function renderFooterHtml(settings: SettingsMap): string {
  const ctx: HookContext = { settings, base: (settings.siteUrl || '').replace(/\/+$/, '') }
  let html = ''
  for (const p of enabledPlugins(settings)) {
    if (!p.footerHtml) continue
    try {
      html += p.footerHtml(ctx)
    } catch {
      /* 插件出错不影响页面渲染 */
    }
  }
  return html
}

/** 事件广播公共件：遍历启用的插件逐个调 handler，任何失败都不影响调用方主流程；
 *  演示站不外发：体验者随手配置的 TG/webhook 不应让 demo Worker 对外发请求 */
async function fireHook<P>(
  env: Env,
  pick: (plugin: ServerPlugin) => ((p: P, ctx: HookContext) => void | Promise<void>) | undefined,
  p: P
): Promise<void> {
  if (isDemo(env)) return
  try {
    const settings = await getSettings(env.DB)
    const ctx: HookContext = { env, settings, base: (settings.siteUrl || '').replace(/\/+$/, '') }
    for (const plugin of enabledPlugins(settings)) {
      const handler = pick(plugin)
      if (!handler) continue
      try {
        await handler(p, ctx)
      } catch {
        /* 单个插件失败不影响其余插件 */
      }
    }
  } catch {
    /* 读不到设置（库异常等）就放弃，不影响主流程 */
  }
}

/** 发布事件广播：后台发布与定时到点两条路都会调；任何失败都不影响发布本身 */
export function firePostPublished(env: Env, p: PostPublishedPayload): Promise<void> {
  return fireHook(env, (plugin) => plugin.onPostPublished, p)
}

/** 微博发布事件广播：后台、开放 API、TG 机器人与草稿转发布四条路都会调；任何失败都不影响发布本身 */
export function fireWeiboPublished(env: Env, p: WeiboPublishedPayload): Promise<void> {
  return fireHook(env, (plugin) => plugin.onWeiboPublished, p)
}

/** 评论事件广播：访客评论/留言三条路（文章、微博、留言板）都会调；任何失败都不影响留言本身 */
export function fireCommentCreated(env: Env, p: CommentCreatedPayload): Promise<void> {
  return fireHook(env, (plugin) => plugin.onCommentCreated, p)
}
