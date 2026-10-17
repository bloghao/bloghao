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
import { fetchableUrl, fetchPublicResource } from './fetchsafe'
import { purgePageCache } from './pagecache'
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
  /** 触发来源：后台手动发布 / 定时到点 / MCP（AI 助手，src/mcp.ts） */
  via: 'admin' | 'scheduler' | 'mcp'
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
  /** 单条视频（B19）：只给封面帧等元数据，视频文件本身不出站（广场用封面帧当缩略图）；无视频 = undefined */
  video?: { url: string; poster: string }
  /** 触发来源：后台（含前台卡片编辑器）/ 开放 API / Telegram 机器人 / 草稿转发布 */
  via: 'admin' | 'external' | 'telegram' | 'draft'
}

/** 编辑已发布文章（编辑后仍处于发布态才触发；状态跃迁分别走发布 / 下架广播，不在此列） */
export interface PostUpdatedPayload {
  slug: string
  title: string
  via: 'admin'
}

/** 文章软删进回收站（彻底删除不触发——回收站恢复是唯一生路，删了就该安静） */
export interface PostDeletedPayload {
  slug: string
  title: string
  via: 'admin'
}

/** 微博软删进回收站 */
export interface WeiboDeletedPayload {
  id: number
  via: 'admin'
}

/** 备份成功写盘（每晚 cron 与手动备份都触发；skipped / 失败不触发）。
 *  插件凭 ctx.env.IMAGES.get(key) 取回备份内容做异地推送（路线图 B6 的插件化路子） */
export interface BackupCompletedPayload {
  key: string
  bytes: number
  tables: number
  /** 备份完成时刻（毫秒） */
  at: number
}

/** 插件配置表单字段（后台「插件」页「配置」弹窗按此渲染，值存 settings.serverPluginConfig） */
export interface PluginConfigField {
  key: string
  label: string
  type: 'text' | 'textarea'
  placeholder?: string
  /** 输入框下的帮助文案 */
  help?: string
}

export interface ServerPlugin {
  id: string
  title: string
  description: string
  version: string
  author: string
  /** 文章发布（草稿/定时 → 已发布的跃迁，重复保存已发布文章不触发） */
  onPostPublished?: (p: PostPublishedPayload, ctx: HookContext) => Promise<void> | void
  /** 编辑已发布文章（编辑后仍处于发布态；状态跃迁不触发） */
  onPostUpdated?: (p: PostUpdatedPayload, ctx: HookContext) => Promise<void> | void
  /** 文章软删进回收站 */
  onPostDeleted?: (p: PostDeletedPayload, ctx: HookContext) => Promise<void> | void
  /** 微博发布（新建即发 / 草稿转发布，编辑已发布微博不触发） */
  onWeiboPublished?: (p: WeiboPublishedPayload, ctx: HookContext) => Promise<void> | void
  /** 微博软删进回收站 */
  onWeiboDeleted?: (p: WeiboDeletedPayload, ctx: HookContext) => Promise<void> | void
  /** 访客发表评论 / 留言（作者自己的回复不触发，避免同步场景里自我刷屏） */
  onCommentCreated?: (p: CommentCreatedPayload, ctx: HookContext) => Promise<void> | void
  /** 备份成功写盘（定时 + 手动） */
  onBackupCompleted?: (p: BackupCompletedPayload, ctx: HookContext) => Promise<void> | void
  /** 页脚注入：返回的 HTML 拼在每页 </body> 前（同步，不能访问 env） */
  footerHtml?: (ctx: HookContext) => string
  /** 插件配置表单（后台「插件」页渲染）；不定义 = 该插件无配置界面 */
  configFields?: PluginConfigField[]
  /** 配置保存时的语义校验（返回错误文案 = 整体拒绝保存） */
  configValidate?: (cfg: Record<string, string>) => string | null
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
    // 统一出网入口：起点 + 每一跳都过 fetchableUrl（配置时已校验，这里防「公网地址 302 到内网」）
    await fetchPublicResource(url, {
      maxBytes: 64 * 1024,
      timeoutMs: 10_000,
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ event: 'comment.created', site: ctx.settings.siteName, ...p }),
      expectBody: false,
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

/** 微博文本 → Buffer/X 帖文：站内成对 #xx# 转 X 的 #xx（X 话题语法；单 # 写法本就是 X 格式，
 *  原样通过），长度口径与站内话题提取同限 1-24 字，超 270 码点截断（emoji 截半个也不破头） */
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
    // 只有视频、没有正文也没有配图的微博，Buffer 收到的是空帖：跳过（视频不随 Buffer 出站，B19）
    if (!p.content && !p.images.length) return
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
 * 广场地址（默认官方 hub）+ 注册 token（hub 站长审核发放）。加密文 / 会员锁文不上广场。
 * pull 补漏路（hub 定时抓 /rss.xml 文章）在 hub 侧，见 plaza/。
 */

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

/** 官方广场 hub（唯一官方入口）：plazaEndpoint 留空时回落到这里。页面与数据面同域，API 挂在 /plaza 路径下。
 *  导出给 api.ts 的广场数据卡代理端点（/admin/plaza-stats）复用同一回落口径 */
export const PLAZA_OFFICIAL_HUB = 'https://bloghao.com/plaza'

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
      // 站点头像随上报更新（hub 端 https 校验，空/非法忽略）：后台「站点头像」改了，下一条发布即同步
      avatar: (ctx.settings.avatarUrl || '').trim(),
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
    // 既无正文也无任何图（含视频封面帧）的微博在广场上是一张空卡：跳过（B19）
    if (!p.content && !p.images.length && !p.video?.poster) return
    await plazaIngest(endpoint, token, {
      // 站点头像随上报更新（hub 端 https 校验，空/非法忽略）：后台「站点头像」改了，下一条发布即同步
      avatar: (ctx.settings.avatarUrl || '').trim(),
      items: [
        {
          kind: 'weibo',
          ref: String(p.id),
          title: excerpt(p.content, 80),
          summary: excerpt(p.content, 500),
          url: ctx.base ? `${ctx.base}/weibo#wb-${p.id}` : '',
          // hub 只收 https 绝对地址：站内 /images/ 补 base 前缀，外链原样，其余置空。
          // 视频不出站，但封面帧可当缩略图（与开放接口 /api/public/weibo 同口径）
          image: plazaHttpsImage(p.images[0] || p.video?.poster || '', ctx.base),
          publishedAt: Date.now(),
        },
      ],
    })
  },
}

/** 广场缩略图口径：站内 /images/ 补 base 前缀、https 绝对地址原样、其余置空（hub 只收 https） */
function plazaHttpsImage(u: string, base?: string): string {
  if (!u) return ''
  if (u.startsWith('/images/') && base) return base + u
  return /^https:\/\//i.test(u) ? u : ''
}

/** 签名上报（fireHook 已吞错，这里失败抛出也只丢这一条同步，不影响发布主流程） */
async function plazaIngest(endpoint: string, token: string, body: Record<string, unknown>): Promise<void> {
  const ts = String(Date.now())
  const raw = JSON.stringify(body)
  // 统一出网入口：公网地址起点 + 每一跳复查（防「302 到内网」）；失败一律 null（不透状态码）
  const r = await fetchPublicResource(`${endpoint}/api/ingest`, {
    maxBytes: 64 * 1024,
    timeoutMs: 15_000,
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-plaza-token': token,
      'x-plaza-timestamp': ts,
      'x-plaza-signature': await plazaSign(token, ts, raw),
    },
    body: raw,
    expectBody: false,
  })
  if (!r) console.error('[plaza-sync] ingest 上报失败')
}

/* ---------------- 通用出站 Webhook ----------------
 * 把「事件 → POST 外部地址」做成一个官方插件：站长自选事件清单与目标 URL，
 * n8n / IFTTT / 自建系统等自动化集成一个地址全接走，不再为每个平台单写同步插件。
 * body: { event, site, at, data }；配置了签名密钥时带 X-Bloghao-Timestamp /
 * X-Bloghao-Signature（HMAC-SHA256(密钥, ts + '.' + rawBody)，与广场同步 plazaSign 同口径）。
 * URL 落配置即过公网校验（fetchableUrl，与 commentWebhookUrl 同标准），触发时再复核一遍；
 * 演示站由 fireHook 总线整层短路，体验者配的地址打不出去。 */

const OUTBOUND_EVENTS = [
  'post_published',
  'post_updated',
  'post_deleted',
  'weibo_published',
  'weibo_deleted',
  'comment_created',
  'backup_completed',
] as const

/** 事件清单解析（三态）：留空 → 'all'（全部放行）；合法清单 → 白名单数组；
 *  非空但含坏项 → 'invalid'（**拒发**）。三态必须区分——历史上坏清单与留空都返回 null，
 *  发送路把 null 当「不过滤」，一次配置写脏就把「只推某事件」放大成「全事件外推」（失败开放）。
 *  校验路（configValidate）只在非空时判 'invalid' */
function outboundEventList(raw: string): 'all' | 'invalid' | string[] {
  const list = String(raw ?? '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean)
  if (!list.length) return 'all'
  const out: string[] = []
  for (const e of list) {
    if (!(OUTBOUND_EVENTS as readonly string[]).includes(e)) return 'invalid'
    if (!out.includes(e)) out.push(e)
  }
  return out
}

/** 出站发送：读插件配置 → 事件过滤 →（可选）签名 → POST。配置失效（被旁路写脏）时静默放弃 */
async function outboundSend(ctx: HookContext, event: string, data: unknown): Promise<void> {
  const cfg = pluginConfig(ctx.settings, 'outbound-webhook')
  const url = (cfg.url || '').trim()
  if (!/^https:\/\//i.test(url) || !fetchableUrl(url)) return
  const allowed = outboundEventList(cfg.events || '')
  if (allowed === 'invalid') return // 坏清单拒发（失败关闭，别放大成全事件外推）
  if (allowed !== 'all' && !allowed.includes(event)) return
  const raw = JSON.stringify({ event, site: ctx.settings.siteName, at: Date.now(), data })
  const headers: Record<string, string> = { 'content-type': 'application/json' }
  const secret = (cfg.secret || '').trim()
  if (secret) {
    const ts = String(Date.now())
    headers['x-bloghao-timestamp'] = ts
    headers['x-bloghao-signature'] = await plazaSign(secret, ts, raw)
  }
  // 统一出网入口：公网 https 起点 + 每一跳复查（防「302 到内网」）；失败一律 null（不透状态码）
  await fetchPublicResource(url, {
    maxBytes: 64 * 1024,
    timeoutMs: 10_000,
    method: 'POST',
    headers,
    body: raw,
    expectBody: false,
  })
}

const outboundWebhook: ServerPlugin = {
  id: 'outbound-webhook',
  title: '通用出站 Webhook',
  description:
    '站点事件（文章发布/更新/删除、微博发布/删除、新评论、备份完成）以 JSON POST 推送到你指定的地址——n8n、飞书、企业微信、自建系统，一个地址全接走。事件清单与地址在本页「配置」里维护。',
  version: '1.0.0',
  author: '官方',
  configFields: [
    {
      key: 'url',
      label: 'Webhook 地址',
      type: 'text',
      placeholder: 'https://example.com/hook',
      help: '只接受公网 https 地址；每个事件一条 POST，超时 10 秒，失败只记日志不影响主流程',
    },
    {
      key: 'secret',
      label: '签名密钥（可选）',
      type: 'text',
      help: '填写后请求带 X-Bloghao-Timestamp 与 X-Bloghao-Signature = HMAC-SHA256(密钥, 时间戳 + "." + 请求体)，接收端可验伪造',
    },
    {
      key: 'events',
      label: '推送事件（逗号分隔，留空 = 全部）',
      type: 'text',
      placeholder: 'post_published,comment_created',
      help: `可选：${OUTBOUND_EVENTS.join(' / ')}`,
    },
  ],
  configValidate(cfg) {
    const url = (cfg.url || '').trim()
    if (!url || !/^https:\/\//i.test(url) || !fetchableUrl(url)) return 'Webhook 地址无效（需公网 https 地址）'
    const events = (cfg.events || '').trim()
    if (events && outboundEventList(events) === 'invalid') return `事件列表不正确（可选：${OUTBOUND_EVENTS.join(' / ')}）`
    if ((cfg.secret || '').length > 200) return '签名密钥过长（≤ 200 字符）'
    return null
  },
  async onPostPublished(p, ctx) {
    await outboundSend(ctx, 'post_published', p)
  },
  async onPostUpdated(p, ctx) {
    await outboundSend(ctx, 'post_updated', p)
  },
  async onPostDeleted(p, ctx) {
    await outboundSend(ctx, 'post_deleted', p)
  },
  async onWeiboPublished(p, ctx) {
    await outboundSend(ctx, 'weibo_published', p)
  },
  async onWeiboDeleted(p, ctx) {
    await outboundSend(ctx, 'weibo_deleted', p)
  },
  async onCommentCreated(p, ctx) {
    await outboundSend(ctx, 'comment_created', p)
  },
  async onBackupCompleted(p, ctx) {
    await outboundSend(ctx, 'backup_completed', { key: p.key, bytes: p.bytes, tables: p.tables, at: p.at })
  },
}

/** 注册表：第三方服务端插件在此登记（顺序即后台展示顺序） */
export const SERVER_PLUGINS: ServerPlugin[] = [tgChannel, commentWebhook, bufferSync, plazaSync, outboundWebhook, footerHtmlPlugin]

/** 后台「插件」页列表用：只出元数据与配置表单描述，不带处理函数 */
export function listServerPlugins(): {
  id: string
  title: string
  description: string
  version: string
  author: string
  configFields: PluginConfigField[]
}[] {
  return SERVER_PLUGINS.map(({ id, title, description, version, author, configFields }) => ({
    id,
    title,
    description,
    version,
    author,
    configFields: configFields || [],
  }))
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

/** 发布事件广播：后台发布与定时到点两条路都会调；任何失败都不影响发布本身。
 *  发布动作附带清页面边缘缓存（pagecache.ts）：本函数是所有发布入口的单点漏斗
 *  （后台 / 开放 API / TG / MCP / 定时发布），这里清一次比在各端点散挂稳；演示站整层
 *  不缓存，跳过省两次 D1 往返 */
export async function firePostPublished(env: Env, p: PostPublishedPayload): Promise<void> {
  if (!isDemo(env)) await purgePageCache(env.DB).catch(() => {})
  return fireHook(env, (plugin) => plugin.onPostPublished, p)
}

/** 微博发布事件广播：后台、开放 API、TG 机器人与草稿转发布四条路都会调；任何失败都不影响发布本身 */
export async function fireWeiboPublished(env: Env, p: WeiboPublishedPayload): Promise<void> {
  if (!isDemo(env)) await purgePageCache(env.DB).catch(() => {})
  return fireHook(env, (plugin) => plugin.onWeiboPublished, p)
}

/** 评论事件广播：访客评论/留言三条路（文章、微博、留言板）都会调；任何失败都不影响留言本身。
 *  评论出现在公开页面上，落库即清页面边缘缓存（待审的不在页面上，清了也无害） */
export async function fireCommentCreated(env: Env, p: CommentCreatedPayload): Promise<void> {
  if (!isDemo(env)) await purgePageCache(env.DB).catch(() => {})
  return fireHook(env, (plugin) => plugin.onCommentCreated, p)
}

/** 广场下架广播（条目生命周期闭环）：已发布文章补设密码/升档锁文、转出发布态或软删时，
 *  把对应条目从广场 hub 摘除（hub 的 deleted 协议字段，docs/PLAZA.md）——防「已加密/已删」
 *  的标题与摘要永久滞留公开广场。锁文的 RSS 条目同时带 bloghao:locked 标志（src/rss.ts），
 *  pull 补漏不会再捞回；解锁/恢复后 6h 内 pull 自愈补回。失败只丢一条下架，不影响主流程。
 *  下架同样改变公开可见面 → 先清页面边缘缓存再走广场同步（plaza-sync 停用也不能跳过清理） */
export async function firePlazaRetract(env: Env, entries: { kind: 'post' | 'weibo'; ref: string }[]): Promise<void> {
  if (isDemo(env) || !entries.length) return
  await purgePageCache(env.DB).catch(() => {})
  try {
    const settings = await getSettings(env.DB)
    if (!enabledPlugins(settings).some((p) => p.id === 'plaza-sync')) return
    const endpoint = (settings.plazaEndpoint || PLAZA_OFFICIAL_HUB).trim().replace(/\/+$/, '')
    const token = (settings.plazaToken || '').trim()
    if (!/^https:\/\//i.test(endpoint) || !token) return
    await plazaIngest(endpoint, token, { deleted: entries })
  } catch {
    /* 读不到设置 / 上报失败都放弃（与 fireHook 同口径吞错） */
  }
}

/** 编辑已发布文章广播（编辑后仍处于发布态才触发；状态跃迁分别走 firePostPublished /
 *  firePlazaRetract，不在此列）。页面边缘缓存由 PUT 端点自己清（编辑必变公开面），
 *  这里只广播——IndexNow 类「编辑也让搜索引擎重抓」的需求接这个槽 */
export async function firePostUpdated(env: Env, p: PostUpdatedPayload): Promise<void> {
  return fireHook(env, (plugin) => plugin.onPostUpdated, p)
}

/** 文章软删广播：与 firePlazaRetract 同点触发（软删端点两条都会挂）。
 *  这里也清一次页面边缘缓存——幂等兜底，防未来某个删除入口只挂事件漏挂下架 */
export async function firePostDeleted(env: Env, p: PostDeletedPayload): Promise<void> {
  if (!isDemo(env)) await purgePageCache(env.DB).catch(() => {})
  return fireHook(env, (plugin) => plugin.onPostDeleted, p)
}

/** 微博软删广播（同 firePostDeleted 口径） */
export async function fireWeiboDeleted(env: Env, p: WeiboDeletedPayload): Promise<void> {
  if (!isDemo(env)) await purgePageCache(env.DB).catch(() => {})
  return fireHook(env, (plugin) => plugin.onWeiboDeleted, p)
}

/** 备份完成广播：只报「写盘成功」（skipped / 失败不触发）。备份不改变公开面，无需清缓存；
 *  异地备份类插件凭 ctx.env.IMAGES.get(p.key) 取件推送 */
export async function fireBackupCompleted(env: Env, p: BackupCompletedPayload): Promise<void> {
  return fireHook(env, (plugin) => plugin.onBackupCompleted, p)
}

/* ---------------- 插件配置通道 ----------------
 * settings.serverPluginConfig 是一个 JSON：{ 插件id: { 字段键: 值 } }——服务端插件要配置
 * 不必再往 DEFAULT_SETTINGS 塞专属键。插件侧用 pluginConfig(settings, 自身id) 读，
 * 后台「插件」页按 configFields 渲染表单，保存走 cleanServerPluginConfig 净化 + 校验。 */

/** 插件读取自己的配置：脏 JSON / 非对象 / 值非字符串一律当没配，绝不让配置形态打进处理器 */
export function pluginConfig(settings: SettingsMap, id: string): Record<string, string> {
  let all: unknown
  try {
    all = JSON.parse(settings.serverPluginConfig || '{}')
  } catch {
    return {}
  }
  if (!all || typeof all !== 'object' || Array.isArray(all)) return {}
  const mine = (all as Record<string, unknown>)[id]
  if (!mine || typeof mine !== 'object' || Array.isArray(mine)) return {}
  const out: Record<string, string> = {}
  for (const [k, v] of Object.entries(mine as Record<string, unknown>)) {
    if (typeof v === 'string') out[k] = v
  }
  return out
}

/** settings.serverPluginConfig 净化（api.ts PUT 调用）：顶层键必须是注册插件 id
 *  （防任意命名空间），字段键必须在该插件 configFields 里登记，值是非空字符串 ≤ 500；
 *  涉及的插件再过 configValidate 语义校验。空配置返回 ''，非法返回 { ok: false, error } */
export function cleanServerPluginConfig(raw: string): { ok: true; value: string } | { ok: false; error: string } {
  const s = String(raw ?? '').trim()
  if (!s) return { ok: true, value: '' }
  if (s.length > 20_000) return { ok: false, error: '插件配置过长（≤ 20000 字符）' }
  let obj: unknown
  try {
    obj = JSON.parse(s)
  } catch {
    return { ok: false, error: '插件配置不是合法的 JSON' }
  }
  if (!obj || typeof obj !== 'object' || Array.isArray(obj)) return { ok: false, error: '插件配置必须是 JSON 对象' }
  const out: Record<string, Record<string, string>> = {}
  for (const [id, cfg] of Object.entries(obj as Record<string, unknown>)) {
    const plugin = SERVER_PLUGINS.find((p) => p.id === id)
    if (!plugin) return { ok: false, error: `未注册的服务端插件：${id}` }
    // 空对象 = 清除该插件配置
    if (cfg == null || (typeof cfg === 'object' && !Array.isArray(cfg) && !Object.keys(cfg as object).length)) continue
    if (!cfg || typeof cfg !== 'object' || Array.isArray(cfg)) return { ok: false, error: `插件 ${id} 的配置必须是键值对象` }
    const fields: Record<string, string> = {}
    for (const [k, v] of Object.entries(cfg as Record<string, unknown>)) {
      if (plugin.configFields && !plugin.configFields.some((f) => f.key === k)) {
        return { ok: false, error: `插件 ${id} 不认识配置字段：${k}` }
      }
      if (typeof v !== 'string') return { ok: false, error: `插件 ${id} 的配置值必须是字符串` }
      if (v.length > 500) return { ok: false, error: `插件 ${id} 的配置值过长（≤ 500 字符）` }
      if (v !== '') fields[k] = v
    }
    if (plugin.configValidate) {
      const err = plugin.configValidate(fields)
      if (err) return { ok: false, error: `${plugin.title}：${err}` }
    }
    out[id] = fields
  }
  return { ok: true, value: Object.keys(out).length ? JSON.stringify(out) : '' }
}
