#!/usr/bin/env node
/**
 * 本地冒烟测试：npm run smoke
 *
 * 流程：初始化本地 D1（幂等）→ 写入夹具（幂等）→ 起 wrangler dev → 逐路由断言 → 收尾退出。
 * 其中「多标签文章页」是回归守卫：relatedPosts 的多标签 OR 拼接曾被误删 join，
 * 导致所有 2 个以上标签的文章 500（线上事故 2026-10，见 8be1c71）。
 *
 * 规矩：改过 SQL 拼接 / 渲染相关代码，提交前先跑这个；部署后再对线上同路由 curl 一遍。
 */
import { spawn } from 'node:child_process'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const PORT = 8799
const READY_TIMEOUT_MS = 180_000
/* 子进程统一 node 直跑底层 js 入口（wrangler 自带 bin/wrangler.js，等效 npx wrangler）：
 * spawn 'npm'/.bin 垫片在 Windows 会 ENOENT（Node 18+ 不再自动补 .cmd），
 * 配 shell:true 又会把带空格/引号的参数（--command 的 SQL）拆碎——node + js 路径两平台行为一致 */
const NODE = process.execPath
const WRANGLER_JS = path.join(ROOT, 'node_modules', 'wrangler', 'bin', 'wrangler.js')

const results = []
let dev = null

function run(cmd, args, label) {
  return new Promise((resolve, reject) => {
    console.log(`\n▸ ${label}`)
    const p = spawn(cmd, args, { cwd: ROOT, stdio: ['ignore', 'pipe', 'pipe'] })
    let out = ''
    p.stdout.on('data', (d) => (out += d))
    p.stderr.on('data', (d) => (out += d))
    p.on('close', (code) => {
      if (code === 0) {
        console.log('  ✓ 完成')
        resolve(out)
      } else {
        console.error(out.trim().split('\n').slice(-15).join('\n'))
        reject(new Error(`${label} 失败（exit ${code}）`))
      }
    })
    p.on('error', reject)
  })
}

async function startDevServer() {
  console.log(`\n▸ 启动 wrangler dev（端口 ${PORT}）`)
  dev = spawn(NODE, [WRANGLER_JS, 'dev', '--port', String(PORT), '--ip', '127.0.0.1'], {
    cwd: ROOT,
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  let out = ''
  dev.stdout.on('data', (d) => (out += d))
  dev.stderr.on('data', (d) => (out += d))

  const started = Date.now()
  while (Date.now() - started < READY_TIMEOUT_MS) {
    if (dev.exitCode !== null) {
      console.error(out.trim().split('\n').slice(-15).join('\n'))
      throw new Error(`wrangler dev 提前退出（exit ${dev.exitCode}）`)
    }
    try {
      const res = await fetch(`http://127.0.0.1:${PORT}/`, { signal: AbortSignal.timeout(3000) })
      console.log(`  ✓ 服务已就绪（耗时 ${((Date.now() - started) / 1000).toFixed(1)}s）`)
      void res
      return
    } catch {
      await new Promise((r) => setTimeout(r, 500))
    }
  }
  console.error(out.trim().split('\n').slice(-30).join('\n'))
  throw new Error('wrangler dev 启动超时')
}

async function check(method, url, expectStatus, expectBody, opts = {}) {
  const label = `${method} ${url}${expectBody ? '（含内容断言）' : ''}${opts.notContains ? '（不含断言）' : ''}`
  try {
    const res = await fetch(`http://127.0.0.1:${PORT}${url}`, {
      method,
      headers: opts.headers,
      body: opts.body,
      signal: AbortSignal.timeout(15_000),
    })
    let bodyOk = true
    const text = expectBody || opts.notContains ? await res.text() : ''
    if (expectBody) {
      bodyOk = text.includes(expectBody)
      if (!bodyOk) console.error(`  ✗ ${label}：响应中未找到「${expectBody}」`)
    }
    if (bodyOk && opts.notContains) {
      bodyOk = !text.includes(opts.notContains)
      if (!bodyOk) console.error(`  ✗ ${label}：响应中不应出现「${opts.notContains}」`)
    }
    if (res.status !== expectStatus) {
      console.error(`  ✗ ${label}：期望 ${expectStatus}，实际 ${res.status}`)
      results.push([label, false])
      return
    }
    if (!bodyOk) {
      results.push([label, false])
      return
    }
    console.log(`  ✓ ${label}`)
    results.push([label, true])
  } catch (e) {
    console.error(`  ✗ ${label}：${e.message}`)
    results.push([label, false])
  }
}

try {
  // 与 npm run db:init:local 同义（wrangler d1 execute DB --local --file schema.sql），直跑免 npm 中转
  await run(NODE, [WRANGLER_JS, 'd1', 'execute', 'DB', '--local', '--file', 'schema.sql'], '初始化本地 D1（幂等）')
  await run(
    NODE,
    [WRANGLER_JS, 'd1', 'execute', 'DB', '--local', '--file', 'scripts/smoke.fixtures.sql'],
    '写入冒烟夹具（幂等）'
  )
  await startDevServer()

  console.log('\n▸ 路由断言')
  await check('GET', '/', 200)
  // 回归守卫：多标签文章（relatedPosts OR 拼接）与无标签文章（兜底查询）都必须 200
  await check('GET', '/post/smoke-multi-tag', 200, '冒烟测试：多标签文章')
  await check('GET', '/post/smoke-no-tag', 200)
  // 上一篇/下一篇：夹具 ≥2 篇已发布文章，文章页必有相邻导航
  await check('GET', '/post/smoke-multi-tag', 200, 'pn-nav')
  // 标题锚点：headingAnchors 给 h2/h3 注入 toc-N id（wechat 主题目录卡与 site.js hover ¶ 同源）
  await check('GET', '/post/smoke-multi-tag', 200, 'id="toc-')
  // 结构化数据（roadmap A3）：文章页必须输出 schema.org JSON-LD
  await check('GET', '/post/smoke-multi-tag', 200, 'application/ld+json')
  await check('GET', `/tag/${encodeURIComponent('冒烟测试')}`, 200, 'smoke-multi-tag')
  await check('GET', '/archives', 200)
  await check('GET', '/weibo', 200)
  // 前台微博卡管理（roadmap：管理员前台管理随手记）：访客 HTML 里不得出现管理按钮
  await check('GET', '/weibo', 200, undefined, { notContains: 'data-wb-admin' })
  await check('GET', '/api/admin/weibo/990101', 401)
  // 回归守卫：?wb= 深链定位——历史上的今天/首页入口卡/TG 通知链到 /weibo?wb=x#wb-x，
  // 服务端必须把目标微博所在页渲染出来（17 条夹具中 990101 最老，落在第 2 页）；无效 id 回退第 1 页
  await check('GET', '/weibo?wb=990101', 200, '微博定位目标')
  await check('GET', '/weibo?wb=999999999', 200)
  await check('GET', '/links', 200)
  await check('GET', '/guestbook', 200)
  await check('GET', '/about', 200)
  await check('GET', '/search?q=smoke', 200)
  // FTS5 全文搜索（roadmap B4）：「多标签」≥3 字走 posts_fts（workerd 的 SQLite 必须真支持
  // FTS5 trigram，这条守着 D1 兼容性）；「定位目标」走 weibo_fts 且渲染微博结果区
  await check('GET', `/search?q=${encodeURIComponent('多标签')}`, 200, 'smoke-multi-tag')
  await check('GET', `/search?q=${encodeURIComponent('定位目标')}`, 200, 'wb-home-feed')
  // 2 字短词退回 LIKE 老路：新旧两条路都必须能搜到
  await check('GET', `/search?q=${encodeURIComponent('冒烟')}`, 200, 'smoke-multi-tag')
  await check('GET', '/rss.xml', 200)
  await check('GET', '/sitemap.xml', 200)
  // 分享卡图：内置默认卡必须能被社交平台抓到，页面必须输出 og:image / twitter:card（og:image 绝不缺位）
  await check('GET', '/og-default.png', 200)
  await check('GET', '/', 200, 'twitter:card')
  await check('GET', '/', 200, 'og:image')
  await check('GET', '/admin/', 200)
  // 皮肤/插件市场：编辑器插件清单与市场目录是后台「插件 / 皮肤」页的数据源，必须可访问且是合法 JSON
  await check('GET', '/plugins/manifest.json', 200, 'hello-sign')
  await check('GET', '/market/catalog.json', 200, 'themes')
  await check('GET', '/post/no-such-post-should-404', 404)
  // 访客统计：公开打点 200、后台聚合接口未登录必须 401（在 /admin/* 鉴权保护之下）
  await check('POST', '/api/public/track', 200, 'ok', {
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ p: '/post/smoke-multi-tag', r: 'https://www.google.com/', v: 'smoke-visitor-1', t: '冒烟测试' }),
  })
  await check('GET', '/api/admin/visits', 401)
  // 数据导出（roadmap A1）：登录中间件保护之下，未登录必须 401
  await check('GET', '/api/admin/export/markdown', 401)
  await check('GET', '/api/admin/export/wxr', 401)
  // 服务端插件（roadmap A5）：列表接口同样在鉴权保护之下
  await check('GET', '/api/admin/server-plugins', 401)
  // 回收站（软删除）：管理接口在鉴权保护之下
  await check('GET', '/api/admin/trash', 401)

  // 回归守卫：打点真的落进了 visit_log（waitUntil 异步写，稍等一拍再用 d1 查）——
  // 防止「接口 200 但 INSERT 静默失败」的假绿
  await new Promise((r) => setTimeout(r, 1500))
  try {
    const out = await run(
      NODE,
      [
        WRANGLER_JS, 'd1', 'execute', 'DB', '--local', '--json', '--command',
        "SELECT COUNT(*) AS n FROM visit_log WHERE vid = 'smoke-visitor-1'",
      ],
      '校验打点已落库（visit_log）'
    )
    if (/"n"\s*:\s*[1-9]/.test(out)) {
      console.log('  ✓ visit_log 已收到打点记录')
      results.push(['visit_log 落库校验', true])
    } else {
      console.error('  ✗ visit_log 未查到 smoke 打点记录')
      results.push(['visit_log 落库校验', false])
    }
  } catch (e) {
    console.error(`  ✗ visit_log 落库校验：${e.message}`)
    results.push(['visit_log 落库校验', false])
  }

  // ── 一键闭站（设置 → 站点状态）：完整链路——登录 → 开关 → 断言 → 恢复 ──
  // 闭站必须拦得住公开页面 / RSS / 公开写入 API，同时放行后台与登录（不然自己被锁在门外）
  console.log('\n▸ 一键闭站链路')
  const BASE = `http://127.0.0.1:${PORT}`
  const raw = (method, path, opts = {}) =>
    fetch(`${BASE}${path}`, { method, signal: AbortSignal.timeout(15_000), ...opts })

  const loginRes = await raw('POST', '/api/auth/login', {
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username: 'smokeadmin', password: 'smoke-pass-12345' }),
  })
  const cookie = (loginRes.headers.get('set-cookie') || '').split(';')[0]
  results.push([
    '闭站链路：登录夹具管理员',
    loginRes.status === 200 && cookie.startsWith('bloghao_session='),
  ])
  console.log(`  ${loginRes.status === 200 && cookie.startsWith('bloghao_session=') ? '✓' : '✗'} 闭站链路：登录夹具管理员（status ${loginRes.status}）`)

  const putSettings = (patch) =>
    raw('PUT', '/api/admin/settings', {
      headers: { 'Content-Type': 'application/json', Cookie: cookie },
      body: JSON.stringify(patch),
    })
  const closeRes = await putSettings({ siteClosed: '1', siteGrayscale: '1' })
  results.push(['闭站链路：开启闭站+灰度', closeRes.status === 200])
  console.log(`  ${closeRes.status === 200 ? '✓' : '✗'} 闭站链路：开启闭站+灰度（status ${closeRes.status}）`)

  // 匿名访客：公开页面 / RSS / sitemap / 公开写入 API 全部 503
  await check('GET', '/', 503, '站点暂时关闭')
  await check('GET', '/post/smoke-multi-tag', 503)
  await check('GET', '/rss.xml', 503)
  await check('GET', '/sitemap.xml', 503)
  await check('POST', '/api/public/track', 503, '站点已关闭', {
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ p: '/x', r: '', v: 'smoke-closed-1', t: '' }),
  })
  // 503 + Retry-After：搜索引擎据此暂时保留收录
  const closedHome = await raw('GET', '/')
  const retryAfterOk = closedHome.status === 503 && closedHome.headers.get('retry-after') === '3600'
  results.push(['闭站链路：503 + Retry-After', retryAfterOk])
  console.log(`  ${retryAfterOk ? '✓' : '✗'} 闭站链路：503 + Retry-After（retry-after: ${closedHome.headers.get('retry-after')}）`)

  // 白名单：后台 SPA、登录、健康检查、主题元数据、图床都活着（不然自己被锁在门外）
  await check('GET', '/admin/', 200)
  await check('GET', '/api/auth/state', 200)
  await check('GET', '/api/health', 200)
  await check('GET', '/api/meta/themes', 200)
  await check('GET', '/images/u/smoke-none.jpg', 404) // 404（R2 查无此图）而非 503 = 图床路由已放行
  await check('GET', '/api/admin/visits', 200, undefined, { headers: { Cookie: cookie } })
  // 已登录管理员：闭站期间仍可全站预览，且灰度样式随页面输出（两个开关一次验到）
  await check('GET', '/', 200, 'html{filter:grayscale(100%)}', { headers: { Cookie: cookie } })

  // 恢复：关站后匿名访客应重新看到正常站点，灰度也撤掉
  const reopenRes = await putSettings({ siteClosed: '0', siteGrayscale: '0' })
  results.push(['闭站链路：恢复访问', reopenRes.status === 200])
  console.log(`  ${reopenRes.status === 200 ? '✓' : '✗'} 闭站链路：恢复访问（status ${reopenRes.status}）`)
  await check('GET', '/', 200)
  const reopenedHome = await raw('GET', '/', { headers: { Cookie: cookie } })
  const reopenedText = await reopenedHome.text()
  const grayscaleOff = reopenedHome.status === 200 && !reopenedText.includes('grayscale')
  results.push(['闭站链路：灰度已随恢复撤下', grayscaleOff])
  console.log(`  ${grayscaleOff ? '✓' : '✗'} 闭站链路：灰度已随恢复撤下`)

  // ── 微博前台管理链路（登录管理员在 /weibo 页直接编辑/置顶/删除随手记）──
  // 全程用临时数据（新建→置顶→编辑→删除），不碰夹具，可重复运行
  console.log('\n▸ 微博前台管理链路')
  const adminWeiboPage = await raw('GET', '/weibo', { headers: { Cookie: cookie } })
  const adminBtnOk = adminWeiboPage.status === 200 && (await adminWeiboPage.text()).includes('data-wb-admin')
  results.push(['微博管理：登录后 /weibo 渲染管理按钮', adminBtnOk])
  console.log(`  ${adminBtnOk ? '✓' : '✗'} 微博管理：登录后 /weibo 渲染管理按钮`)

  const wbCreate = await raw('POST', '/api/admin/weibo', {
    headers: { 'Content-Type': 'application/json', Cookie: cookie },
    body: JSON.stringify({ content: '冒烟管理链路临时微博 #冒烟话题#', status: 'published' }),
  })
  const wbCreated = await wbCreate.json().catch(() => null)
  const wbId = wbCreated && wbCreated.weibo && wbCreated.weibo.id
  results.push(['微博管理：发布临时微博', wbCreate.status === 200 && !!wbId])
  console.log(`  ${wbCreate.status === 200 && !!wbId ? '✓' : '✗'} 微博管理：发布临时微博（id ${wbId}）`)

  if (wbId) {
    const wbCookie = { headers: { Cookie: cookie } }
    // 单条取原稿：前台「编辑」的数据源（正文必须是未转义原文）
    await check('GET', `/api/admin/weibo/${wbId}`, 200, '冒烟管理链路临时微博', wbCookie)
    // 置顶 → 深链页渲染置顶卡 → 取消置顶
    const pinOn = await raw('POST', `/api/admin/weibo/${wbId}/pin`, {
      headers: { 'Content-Type': 'application/json', Cookie: cookie },
      body: JSON.stringify({ pinned: true }),
    })
    results.push(['微博管理：置顶', pinOn.status === 200])
    console.log(`  ${pinOn.status === 200 ? '✓' : '✗'} 微博管理：置顶`)
    await check('GET', `/weibo?wb=${wbId}`, 200, 'is-pinned', wbCookie)
    const pinOff = await raw('POST', `/api/admin/weibo/${wbId}/pin`, {
      headers: { 'Content-Type': 'application/json', Cookie: cookie },
      body: JSON.stringify({ pinned: false }),
    })
    results.push(['微博管理：取消置顶', pinOff.status === 200])
    console.log(`  ${pinOff.status === 200 ? '✓' : '✗'} 微博管理：取消置顶`)
    // 编辑（PUT 全量更新，前台编辑保存同款请求体）→ 单条与前台页都应看到新文本
    const wbEdit = await raw('PUT', `/api/admin/weibo/${wbId}`, {
      headers: { 'Content-Type': 'application/json', Cookie: cookie },
      body: JSON.stringify({ content: '冒烟管理链路已编辑 #冒烟话题#', images: [], status: 'published' }),
    })
    results.push(['微博管理：编辑保存', wbEdit.status === 200])
    console.log(`  ${wbEdit.status === 200 ? '✓' : '✗'} 微博管理：编辑保存`)
    await check('GET', `/api/admin/weibo/${wbId}`, 200, '冒烟管理链路已编辑', wbCookie)
    await check('GET', `/weibo?wb=${wbId}`, 200, '冒烟管理链路已编辑', wbCookie)
    // 删除 → 单条 404、深链定位失效但页面仍 200
    const wbDel = await raw('DELETE', `/api/admin/weibo/${wbId}`, wbCookie)
    results.push(['微博管理：删除', wbDel.status === 200])
    console.log(`  ${wbDel.status === 200 ? '✓' : '✗'} 微博管理：删除`)
    await check('GET', `/api/admin/weibo/${wbId}`, 404, undefined, wbCookie)
    await check('GET', `/weibo?wb=${wbId}`, 200)
  }

  // ── 文章列表「发布/下架」守卫（2026-10 安全复查 P0 回归）：PUT 缺键即保留 ──
  // 列表页状态切换只发 {status}，服务端必须保留正文/标签/分类——曾经整包 {...post}
  // 提交（列表项无 content 键）导致正文标签分类被清空且假成功
  console.log('\n▸ 文章状态切换保留正文')
  const pCreate = await raw('POST', '/api/admin/posts', {
    headers: { 'Content-Type': 'application/json', Cookie: cookie },
    body: JSON.stringify({
      title: '冒烟：状态切换守卫',
      content: '<p>守卫正文不能被清掉</p>',
      tags: ['冒烟守卫'],
      status: 'draft',
    }),
  })
  const pCreated = await pCreate.json().catch(() => null)
  const pId = pCreated && pCreated.post && pCreated.post.id
  results.push(['状态切换：建临时草稿', pCreate.status === 200 && !!pId])
  console.log(`  ${pCreate.status === 200 && !!pId ? '✓' : '✗'} 状态切换：建临时草稿（id ${pId}）`)
  if (pId) {
    const pCookie = { headers: { Cookie: cookie } }
    // 只发 {status}（列表页 toggle 的真实载荷形态），随后逐项核对内容未丢
    const toggle = await raw('PUT', `/api/admin/posts/${pId}`, {
      headers: { 'Content-Type': 'application/json', Cookie: cookie },
      body: JSON.stringify({ status: 'published' }),
    })
    results.push(['状态切换：只发 status 的 PUT', toggle.status === 200])
    console.log(`  ${toggle.status === 200 ? '✓' : '✗'} 状态切换：只发 status 的 PUT`)
    await check('GET', `/api/admin/posts/${pId}`, 200, '守卫正文不能被清掉', pCookie)
    await check('GET', `/api/admin/posts/${pId}`, 200, '冒烟守卫', pCookie)
    // SETTING 回显打码：写入真实 Token 后，保存/读取的回显都必须是打码形态而非明文
    const seedToken = await raw('PUT', '/api/admin/settings', {
      headers: { 'Content-Type': 'application/json', Cookie: cookie },
      body: JSON.stringify({ telegramBotToken: 'smoke-secret-12345' }),
    })
    const seededBody = await seedToken.json().catch(() => null)
    const seedMaskOk =
      seedToken.status === 200 && seededBody?.settings?.telegramBotToken === '••••••••'
    results.push(['状态切换：settings 保存后密钥打码回显', seedMaskOk])
    console.log(`  ${seedMaskOk ? '✓' : '✗'} 状态切换：settings 保存后密钥打码回显`)
    // 打码占位符整表提交 = 保持原值（前端整表提交不会被占位符写坏库）
    const reSave = await raw('PUT', '/api/admin/settings', {
      headers: { 'Content-Type': 'application/json', Cookie: cookie },
      body: JSON.stringify({ telegramBotToken: '••••••••', footerText: '冒烟临时页脚' }),
    })
    const reSaved = await reSave.json().catch(() => null)
    const reMaskOk = reSave.status === 200 && reSaved?.settings?.telegramBotToken === '••••••••'
    results.push(['状态切换：打码占位符提交不覆盖真实值', reMaskOk])
    console.log(`  ${reMaskOk ? '✓' : '✗'} 状态切换：打码占位符提交不覆盖真实值`)
    await raw('PUT', '/api/admin/settings', {
      headers: { 'Content-Type': 'application/json', Cookie: cookie },
      body: JSON.stringify({ telegramBotToken: '', footerText: '由 博客号 驱动 · 住在 Cloudflare 上' }),
    })
    const cleanup = await raw('DELETE', `/api/admin/posts/${pId}`, pCookie)
    results.push(['状态切换：清理临时文章', cleanup.status === 200])
    console.log(`  ${cleanup.status === 200 ? '✓' : '✗'} 状态切换：清理临时文章`)
  }

  // ── 回收站（软删除）链路：删除 → 前台/RSS/sitemap/后台列表全部不可见 → 回收站可见
  // → 恢复复活 → 再删 → 彻底删除。防「软删行从某个公开面泄漏」的核心回归守卫 ──
  console.log('\n▸ 回收站（软删除）链路')
  const tCreate = await raw('POST', '/api/admin/posts', {
    headers: { 'Content-Type': 'application/json', Cookie: cookie },
    body: JSON.stringify({
      title: '冒烟：回收站链路文章',
      content: '<p>回收站链路正文</p>',
      tags: ['冒烟回收站'],
      status: 'published',
    }),
  })
  const tCreated = await tCreate.json().catch(() => null)
  const tPost = tCreated && tCreated.post
  const tId = tPost && tPost.id
  results.push(['回收站：建临时已发布文章', tCreate.status === 200 && !!tId])
  console.log(`  ${tCreate.status === 200 && !!tId ? '✓' : '✗'} 回收站：建临时已发布文章（id ${tId}）`)

  if (tId) {
    const tCookie = { headers: { Cookie: cookie } }
    const tSlug = tPost.slug
    await check('GET', `/post/${tSlug}`, 200, '回收站链路正文')
    // 软删：前台文章页/RSS/sitemap/首页与后台列表全部不可见，回收站可见
    const tDel = await raw('DELETE', `/api/admin/posts/${tId}`, tCookie)
    results.push(['回收站：删除（软删）', tDel.status === 200])
    console.log(`  ${tDel.status === 200 ? '✓' : '✗'} 回收站：删除（软删）`)
    await check('GET', `/post/${tSlug}`, 404)
    await check('GET', '/rss.xml', 200, undefined, { notContains: tSlug })
    await check('GET', '/sitemap.xml', 200, undefined, { notContains: tSlug })
    await check('GET', '/', 200, undefined, { notContains: tSlug })
    await check('GET', '/api/admin/posts?status=all', 200, undefined, { notContains: '回收站链路文章', headers: tCookie.headers })
    await check('GET', '/api/admin/trash', 200, '回收站链路文章', tCookie)
    // 恢复 → 文章复活
    const tRestore = await raw('POST', `/api/admin/trash/post/${tId}/restore`, tCookie)
    results.push(['回收站：恢复', tRestore.status === 200])
    console.log(`  ${tRestore.status === 200 ? '✓' : '✗'} 回收站：恢复`)
    await check('GET', `/post/${tSlug}`, 200, '回收站链路正文')
    // 再删 → 彻底删除（级联评论）→ 回收站也不含，文章 404
    await raw('DELETE', `/api/admin/posts/${tId}`, tCookie)
    const tPurge = await raw('DELETE', `/api/admin/trash/post/${tId}`, tCookie)
    results.push(['回收站：彻底删除', tPurge.status === 200])
    console.log(`  ${tPurge.status === 200 ? '✓' : '✗'} 回收站：彻底删除`)
    await check('GET', `/post/${tSlug}`, 404)
    await check('GET', '/api/admin/trash', 200, undefined, { notContains: '回收站链路文章', headers: tCookie.headers })
  }

  // 误删守卫：对「存活」文章调单条彻底删除必须 404，且级联不得动它的评论。
  // 历史真 bug：级联 DELETE 缺 deleted_at IS NOT NULL 守卫——先删光存活文章的评论再回 404，
  // 接口报错但数据已丢。守卫正确时级联子查询匹配不到存活行，什么都不会发生
  const gCreate = await raw('POST', '/api/admin/posts', {
    headers: { 'Content-Type': 'application/json', Cookie: cookie },
    body: JSON.stringify({ title: '冒烟：彻底删除误删守卫', content: '<p>误删守卫正文</p>', status: 'published' }),
  })
  const gCreated = await gCreate.json().catch(() => null)
  const gId = gCreated && gCreated.post && gCreated.post.id
  if (gId) {
    const gCookie = { headers: { Cookie: cookie } }
    const gSlug = gCreated.post.slug
    const gMark = '误删守卫评论唯一标记'
    const gCmt = await raw('POST', '/api/public/comments', {
      headers: { 'Content-Type': 'application/json', Cookie: cookie },
      body: JSON.stringify({ slug: gSlug, content: gMark, nickname: '作者' }),
    })
    const gPurge = await raw('DELETE', `/api/admin/trash/post/${gId}`, gCookie)
    const gList = await raw('GET', '/api/admin/comments?type=post', gCookie)
    const gListBody = await gList.json().catch(() => null)
    const gCmtAlive = JSON.stringify(gListBody || {}).includes(gMark)
    const gOk = gPurge.status === 404 && gCmt.status === 200 && gCmtAlive
    results.push(['回收站：误删守卫（存活行彻底删除 404 且评论无恙）', gOk])
    console.log(`  ${gOk ? '✓' : '✗'} 回收站：误删守卫（purge 存活行 → ${gPurge.status}，评论${gCmtAlive ? '在' : '丢'}）`)
    await check('GET', `/post/${gSlug}`, 200, '误删守卫正文')
    // 正常链路：软删 → 彻底删除，评论此时才随级联清掉
    await raw('DELETE', `/api/admin/posts/${gId}`, gCookie)
    const gPurge2 = await raw('DELETE', `/api/admin/trash/post/${gId}`, gCookie)
    const gList2 = await raw('GET', '/api/admin/comments?type=post', gCookie)
    const gList2Body = await gList2.json().catch(() => null)
    const gCascade = gPurge2.status === 200 && !JSON.stringify(gList2Body || {}).includes(gMark)
    results.push(['回收站：彻底删除级联清评论', gCascade])
    console.log(`  ${gCascade ? '✓' : '✗'} 回收站：彻底删除级联清评论`)
  }

  // 回收站恢复语义守卫：过期的定时文（到点未被 cron 发出）恢复后必须转草稿，不能恢复即撞发
  const sCreate = await raw('POST', '/api/admin/posts', {
    headers: { 'Content-Type': 'application/json', Cookie: cookie },
    body: JSON.stringify({
      title: '冒烟：过期定时恢复转草稿',
      content: '<p>定时守卫</p>',
      status: 'scheduled',
      publishAt: Date.now() - 3_600_000,
    }),
  })
  const sCreated = await sCreate.json().catch(() => null)
  const sId = sCreated && sCreated.post && sCreated.post.id
  if (sId) {
    const sCookie = { headers: { Cookie: cookie } }
    await raw('DELETE', `/api/admin/posts/${sId}`, sCookie)
    const sRestore = await raw('POST', `/api/admin/trash/post/${sId}/restore`, sCookie)
    const sRow = await raw('GET', `/api/admin/posts/${sId}`, sCookie)
    const sBody = await sRow.json().catch(() => null)
    // 转草稿的同时 publish_at 必须清空：残留旧定时点的话，这条草稿之后被切回 scheduled 会立即撞发
    const staleOk =
      sRestore.status === 200 && sBody?.post?.status === 'draft' && (sBody?.post?.publish_at ?? null) === null
    results.push(['回收站：过期定时文恢复转草稿（publish_at 一并清空）', staleOk])
    console.log(
      `  ${staleOk ? '✓' : '✗'} 回收站：过期定时文恢复转草稿（status ${sBody?.post?.status}，publish_at ${sBody?.post?.publish_at ?? 'null'}）`
    )
    await raw('DELETE', `/api/admin/posts/${sId}`, sCookie)
    await raw('DELETE', `/api/admin/trash/post/${sId}`, sCookie)
  }

  // 微博回收站链路：软删 → 前台微博页/公开评论接口不可见 → 回收站可见 → 恢复 → 彻底删除
  const twCreate = await raw('POST', '/api/admin/weibo', {
    headers: { 'Content-Type': 'application/json', Cookie: cookie },
    body: JSON.stringify({ content: '冒烟回收站临时微博', status: 'published' }),
  })
  const twCreated = await twCreate.json().catch(() => null)
  const twId = twCreated && twCreated.weibo && twCreated.weibo.id
  if (twId) {
    const twCookie = { headers: { Cookie: cookie } }
    const twDel = await raw('DELETE', `/api/admin/weibo/${twId}`, twCookie)
    results.push(['回收站：微博软删', twDel.status === 200])
    console.log(`  ${twDel.status === 200 ? '✓' : '✗'} 回收站：微博软删（id ${twId}）`)
    await check('GET', '/weibo', 200, undefined, { notContains: '冒烟回收站临时微博' })
    await check('GET', `/api/public/weibo/${twId}/comments`, 404)
    await check('GET', '/api/admin/trash?type=weibo', 200, '冒烟回收站临时微博', twCookie)
    const twRestore = await raw('POST', `/api/admin/trash/weibo/${twId}/restore`, twCookie)
    results.push(['回收站：微博恢复', twRestore.status === 200])
    console.log(`  ${twRestore.status === 200 ? '✓' : '✗'} 回收站：微博恢复`)
    await check('GET', '/weibo', 200, '冒烟回收站临时微博')
    // 恢复后评论接口恢复 200：响应体带 adminAvatar 键（作者评论头像位的数据来源，site.js 消费）
    await check('GET', `/api/public/weibo/${twId}/comments`, 200, 'adminAvatar')
    await raw('DELETE', `/api/admin/weibo/${twId}`, twCookie)
    const twPurge = await raw('DELETE', `/api/admin/trash/weibo/${twId}`, twCookie)
    results.push(['回收站：微博彻底删除', twPurge.status === 200])
    console.log(`  ${twPurge.status === 200 ? '✓' : '✗'} 回收站：微博彻底删除`)
    await check('GET', '/api/admin/trash?type=weibo', 200, undefined, { notContains: '冒烟回收站临时微博', headers: twCookie.headers })
  }

  // ── 会员链路（docs/DEVPLAN-2026-10-07.md 契约 v1）：开关门控 → 注册即登录 → 会员身份评论计分
  // → 榜单/首页挂件 → 付费墙防泄漏（游客试读段/会员全文/RSS 无全文）→ 后台会员管理（拉黑即踢）──
  console.log('\n▸ 会员链路')
  const MEMBER_NAME = 'smokemember'
  const MEMBER_PASS = 'smoke-member-12345'
  const MEMBER_NICK = '冒烟昵称'
  const mJson = (res) => res.json().catch(() => null)

  // 上一轮残留的昵称与冷却窗口先夹具化（幂等，行不存在时无操作）：链路内昵称口径断言依赖它
  await run(
    NODE,
    [
      WRANGLER_JS,
      'd1',
      'execute',
      'DB',
      '--local',
      '--command',
      `UPDATE members SET display_name = '${MEMBER_NICK}', display_name_changed_at = NULL WHERE username = '${MEMBER_NAME}'`,
    ],
    '重置冒烟会员昵称与修改窗口（幂等）'
  )

  // 开关默认关：/member /rank 与注册全部 404（契约 A6：关闭 = 全套 404，前台无入口）
  await check('GET', '/member', 404)
  await check('GET', '/rank', 404)
  await check('POST', '/api/member/register', 404, undefined, {
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username: MEMBER_NAME, password: MEMBER_PASS }),
  })

  const mOn = await raw('PUT', '/api/admin/settings', {
    headers: { 'Content-Type': 'application/json', Cookie: cookie },
    body: JSON.stringify({ membersEnabled: '1' }),
  })
  results.push(['会员链路：开启 membersEnabled', mOn.status === 200])
  console.log(`  ${mOn.status === 200 ? '✓' : '✗'} 会员链路：开启 membersEnabled`)

  // 注册即登录（幂等：上一轮冒烟残留同号时改走登录）；昵称选填（中英文均可），注册填写不占用 30 天修改窗口
  let mCookie = ''
  const mReg = await raw('POST', '/api/member/register', {
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username: MEMBER_NAME, password: MEMBER_PASS, nickname: MEMBER_NICK, link: '' }),
  })
  mCookie = (mReg.headers.get('set-cookie') || '').split(';')[0]
  if (mReg.status === 400) {
    const mLogin = await raw('POST', '/api/member/login', {
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username: MEMBER_NAME, password: MEMBER_PASS }),
    })
    mCookie = (mLogin.headers.get('set-cookie') || '').split(';')[0]
    const reOk = mLogin.status === 200 && mCookie.startsWith('xw_member_session=')
    results.push(['会员链路：同号重复冒烟改登录', reOk])
    console.log(`  ${reOk ? '✓' : '✗'} 会员链路：同号重复冒烟改登录`)
  } else {
    const mRegBody = await mJson(mReg)
    const regOk = mReg.status === 200 && mRegBody?.ok === true && mCookie.startsWith('xw_member_session=')
    results.push(['会员链路：注册即登录（签发 xw_member_session）', regOk])
    console.log(`  ${regOk ? '✓' : '✗'} 会员链路：注册即登录（status ${mReg.status}）`)
  }

  // 会员中心：会话态出会员卡（而非登录表单）
  await check('GET', '/member', 200, 'data-member-card', { headers: { Cookie: mCookie } })

  // 会员身份发言（身份来自会话，蜜罐空字段）：即时过审 → 评论积分 +2（注册/登录当日已 +1，合计 ≥3）
  const mCmt = await raw('POST', '/api/public/comments', {
    headers: { 'Content-Type': 'application/json', Cookie: mCookie },
    body: JSON.stringify({ slug: 'smoke-multi-tag', content: '冒烟会员评论：身份来自会话，昵称字段被忽略', link: '' }),
  })
  const mCmtBody = await mJson(mCmt)
  const mCmtOk = mCmt.status === 200 && mCmtBody?.ok === true && mCmtBody?.pending === false
  results.push(['会员链路：会员身份发言即时过审', mCmtOk])
  console.log(`  ${mCmtOk ? '✓' : '✗'} 会员链路：会员身份发言即时过审`)
  await new Promise((r) => setTimeout(r, 800)) // 积分 waitUntil 异步落库，稍等一拍再读
  const mMeAfter = await mJson(await raw('GET', '/api/member/me', { headers: { Cookie: mCookie } }))
  const ptsOk = (mMeAfter?.member?.points ?? 0) >= 3
  results.push(['会员链路：评论计分落账（每日登录+1、评论+2）', ptsOk])
  console.log(`  ${ptsOk ? '✓' : '✗'} 会员链路：评论计分落账（当前 ${mMeAfter?.member?.points ?? '?'} 分）`)

  // 榜单页：上榜会员可见（只出 active 且积分>0；昵称口径 display_name 优先）；首页不再渲染排行挂件（榜单收敛到 /rank）
  await check('GET', '/rank', 200, MEMBER_NICK)
  await check('GET', '/', 200, undefined, { notContains: 'rk-card' })

  // 会员登录态贯通前台评论表单（memberName 接线）：文章页/微博页免填昵称、以会员身份发言；游客仍需填昵称
  await check('GET', '/post/smoke-multi-tag', 200, `以会员 <b>${MEMBER_NICK}</b>`, { headers: { Cookie: mCookie } })
  await check('GET', '/post/smoke-multi-tag', 200, 'name="nickname"')
  await check('GET', '/weibo', 200, `以会员 <b>${MEMBER_NICK}</b>`, { headers: { Cookie: mCookie } })
  await check('GET', '/guestbook', 200, `以会员 <b>${MEMBER_NICK}</b>`, { headers: { Cookie: mCookie } })

  // 微博正文链接自动超链（服务端 weiboTextHtml）：非白名单外链包 /go 中间页，话题不受影响
  const wbLinkRes = await raw('POST', '/api/admin/weibo', {
    headers: { 'Content-Type': 'application/json', Cookie: cookie },
    body: JSON.stringify({ content: '冒烟外链：https://example.com/very-link #随手记#', images: [], status: 'published' }),
  })
  const wbLinkId = (await mJson(wbLinkRes))?.weibo?.id
  if (wbLinkId) {
    await check('GET', '/weibo', 200, 'wb-link')
    await check('GET', '/weibo', 200, `/go?u=${encodeURIComponent('https://example.com/very-link')}`)
    await raw('DELETE', `/api/admin/weibo/${wbLinkId}`, { headers: { Cookie: cookie } })
    await raw('DELETE', `/api/admin/trash/weibo/${wbLinkId}`, { headers: { Cookie: cookie } })
  } else {
    results.push(['微博正文：外链自动超链（建冒烟微博）', false])
    console.log('  ✗ 微博正文：外链自动超链（建冒烟微博失败）')
  }

  // 微信表情链路（src/emoji.ts）：映射表端点 → 微博正文渲染 → 文章正文渲染 → 评论区渲染
  const emojiApi = await mJson(await raw('GET', '/api/public/emoji'))
  const emojiOk = emojiApi?.base === '/emoji/' && (emojiApi?.codes?.['微笑'] ?? '') !== ''
  results.push(['微信表情：映射表端点', emojiOk])
  console.log(`  ${emojiOk ? '✓' : '✗'} 微信表情：映射表端点（${Object.keys(emojiApi?.codes ?? {}).length} 个码点）`)
  const wbEmoji = await raw('POST', '/api/admin/weibo', {
    headers: { 'Content-Type': 'application/json', Cookie: cookie },
    body: JSON.stringify({ content: '冒烟表情：早上好[微笑]，裂开[裂开] #随手记#', images: [], status: 'published' }),
  })
  const wbEmojiId = (await mJson(wbEmoji))?.weibo?.id
  if (wbEmojiId) {
    await check('GET', '/weibo', 200, 'wxq-emoji')
    await check('GET', '/weibo', 200, `src="/emoji/${emojiApi.codes['裂开']}.png"`)
    await check('GET', '/weibo', 200, `alt="[微笑]"`)
    await raw('DELETE', `/api/admin/weibo/${wbEmojiId}`, { headers: { Cookie: cookie } })
    await raw('DELETE', `/api/admin/trash/weibo/${wbEmojiId}`, { headers: { Cookie: cookie } })
  } else {
    results.push(['微信表情：微博正文渲染', false])
    console.log('  ✗ 微信表情：微博正文渲染（建冒烟微博失败）')
  }
  const emojiPost = await raw('POST', '/api/admin/posts', {
    headers: { 'Content-Type': 'application/json', Cookie: cookie },
    body: JSON.stringify({ title: '冒烟：微信表情文章', content: '<p>正文里一个[捂脸]，再来一个[强]。</p>', status: 'published' }),
  })
  const emojiPostBody = await mJson(emojiPost)
  const emojiSlug = emojiPostBody?.post?.slug
  if (emojiSlug) {
    await check('GET', `/post/${emojiSlug}`, 200, `src="/emoji/${emojiApi.codes['捂脸']}.png"`)
    // 评论区渲染：游客评论带表情（SSR 后晒在页面里）
    const emojiCmt = await raw('POST', '/api/public/comments', {
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ slug: emojiSlug, content: '游客评论[爱心]', nickname: '冒烟游客', link: '' }),
    })
    const cmtOk = (await mJson(emojiCmt))?.ok === true
    if (cmtOk) await check('GET', `/post/${emojiSlug}`, 200, `alt="[爱心]"`)
    else {
      results.push(['微信表情：评论渲染（发评论）', false])
      console.log('  ✗ 微信表情：评论渲染（发评论失败）')
    }
    await raw('DELETE', `/api/admin/posts/${emojiPostBody.post.id}`, { headers: { Cookie: cookie } })
    await raw('DELETE', `/api/admin/trash/post/${emojiPostBody.post.id}`, { headers: { Cookie: cookie } })
  } else {
    results.push(['微信表情：文章正文渲染', false])
    console.log('  ✗ 微信表情：文章正文渲染（建冒烟文章失败）')
  }

  // 外链中间页（/go）：白名单域名 302 直跳，非白名单出确认页（免责声明），非法目标回首页
  const goDirect = await fetch(`${BASE}/go?u=${encodeURIComponent('https://www.apple.com/iphone')}`, {
    redirect: 'manual',
    signal: AbortSignal.timeout(15_000),
  })
  const goDirectOk = goDirect.status === 302 && (goDirect.headers.get('location') || '').startsWith('https://www.apple.com/iphone')
  results.push(['外链中间页：白名单域名 302 直跳', goDirectOk])
  console.log(`  ${goDirectOk ? '✓' : '✗'} 外链中间页：白名单域名 302 直跳（${goDirect.status}）`)
  await check('GET', `/go?u=${encodeURIComponent('https://example.com/page')}`, 200, '免责声明')
  const goBad = await fetch(`${BASE}/go?u=javascript:alert(1)`, { redirect: 'manual', signal: AbortSignal.timeout(15_000) })
  const goBadOk = goBad.status === 302 && (goBad.headers.get('location') || '').endsWith('/')
  results.push(['外链中间页：非法目标回首页', goBadOk])
  console.log(`  ${goBadOk ? '✓' : '✗'} 外链中间页：非法目标回首页（${goBad.status}）`)

  // 付费墙（契约 A2）：会员专属文——游客只见试读段与遮挡卡，会员可读全文，RSS 不出全文。
  // 密文必须落在 200 字试读预算之外：开头标记 + 200 字垫充，密文在第二个段落（预算外）
  const PW_SECRET = 'smoke-paywall-secret-tail-99077'
  const pwCreate = await raw('POST', '/api/admin/posts', {
    headers: { 'Content-Type': 'application/json', Cookie: cookie },
    body: JSON.stringify({
      title: '冒烟：会员专属文章',
      content: '<p>smoke-paywall-head' + '试'.repeat(200) + `</p><p>${PW_SECRET}</p>`,
      status: 'published',
      minTier: 'member',
    }),
  })
  const pwCreated = await mJson(pwCreate)
  const pwId = pwCreated?.post?.id
  const pwSlug = pwCreated?.post?.slug
  const pwOk = pwCreate.status === 200 && !!pwSlug
  results.push(['付费墙：建会员专属文（minTier=member 落库）', pwOk])
  console.log(`  ${pwOk ? '✓' : '✗'} 付费墙：建会员专属文（slug ${pwSlug}）`)
  if (pwSlug) {
    await check('GET', `/post/${pwSlug}`, 200, 'smoke-paywall-head')
    await check('GET', `/post/${pwSlug}`, 200, 'paywall')
    await check('GET', `/post/${pwSlug}`, 200, undefined, { notContains: PW_SECRET })
    await check('GET', `/post/${pwSlug}`, 200, PW_SECRET, { headers: { Cookie: mCookie } })
    await check('GET', `/post/${pwSlug}`, 200, PW_SECRET, { headers: { Cookie: cookie } }) // 管理员预览不受限
    await check('GET', '/rss.xml', 200, undefined, { notContains: PW_SECRET })
    // 清理：软删 + 彻底删除（不碰夹具，可重复运行）
    await raw('DELETE', `/api/admin/posts/${pwId}`, { headers: { Cookie: cookie } })
    await raw('DELETE', `/api/admin/trash/post/${pwId}`, { headers: { Cookie: cookie } })
  }

  // 后台会员管理：未登录一律 401（路由必须注册在 /admin/* 鉴权中间件之后）→ 搜索 → 拉黑（会话即刻失效 + 登录 403 banned）→ 恢复 active（下轮可复用）
  await check('GET', '/api/admin/members', 401, '请先登录')
  await check('PUT', '/api/admin/members/1', 401, '请先登录', {
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ status: 'banned' }),
  })
  const mList = await mJson(await raw('GET', `/api/admin/members?q=${MEMBER_NAME}`, { headers: { Cookie: cookie } }))
  const mId = mList?.items?.[0]?.id
  results.push(['会员管理：列表搜索到会员', !!mId])
  console.log(`  ${mId ? '✓' : '✗'} 会员管理：列表搜索到会员（id ${mId}）`)
  if (mId) {
    const mBan = await raw('PUT', `/api/admin/members/${mId}`, {
      headers: { 'Content-Type': 'application/json', Cookie: cookie },
      body: JSON.stringify({ status: 'banned' }),
    })
    const mMeBanned = await mJson(await raw('GET', '/api/member/me', { headers: { Cookie: mCookie } }))
    const bannedOk = mBan.status === 200 && mMeBanned?.member === null
    results.push(['会员管理：拉黑后会话即失效', bannedOk])
    console.log(`  ${bannedOk ? '✓' : '✗'} 会员管理：拉黑后会话即失效`)
    await check('POST', '/api/member/login', 403, 'banned', {
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username: MEMBER_NAME, password: MEMBER_PASS }),
    })
    const mUnban = await raw('PUT', `/api/admin/members/${mId}`, {
      headers: { 'Content-Type': 'application/json', Cookie: cookie },
      body: JSON.stringify({ status: 'active' }),
    })
    results.push(['会员管理：恢复 active', mUnban.status === 200])
    console.log(`  ${mUnban.status === 200 ? '✓' : '✗'} 会员管理：恢复 active`)
  }

  // ── 会员资料链路（/member 页会员卡）：改昵称（30 天一次，窗口判定下沉 SQL 条件更新）+ 改密码（无找回，改后踢其他设备）──
  console.log('\n▸ 会员资料链路')
  // 拉黑测试已踢掉全部会话，重新登录拿新会话（昵称与冷却窗口已在链路开头夹具化）
  const mPf = await raw('POST', '/api/member/login', {
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username: MEMBER_NAME, password: MEMBER_PASS }),
  })
  const mPfCookie = (mPf.headers.get('set-cookie') || '').split(';')[0]

  // 会员中心页出昵称/密码两张修改卡（冷却中输入框与按钮 disabled）
  await check('GET', '/member', 200, 'data-member-nickname-form', { headers: { Cookie: mPfCookie } })
  await check('GET', '/member', 200, 'data-member-password-form', { headers: { Cookie: mPfCookie } })
  await check('GET', '/member', 200, '不提供密码找回', { headers: { Cookie: mPfCookie } })

  // 改昵称：空值拒绝 → 成功落库且 SSR 即显 → 立即再改撞 30 天窗口（403）
  await check('POST', '/api/member/profile', 400, '不能为空', {
    headers: { 'Content-Type': 'application/json', Cookie: mPfCookie },
    body: JSON.stringify({ nickname: '   ' }),
  })
  const mNick = await mJson(
    await raw('POST', '/api/member/profile', {
      headers: { 'Content-Type': 'application/json', Cookie: mPfCookie },
      body: JSON.stringify({ nickname: '冒烟新昵称' }),
    })
  )
  const mNickOk = mNick?.ok === true && mNick?.nickname === '冒烟新昵称'
  results.push(['会员资料：修改昵称成功', mNickOk])
  console.log(`  ${mNickOk ? '✓' : '✗'} 会员资料：修改昵称成功`)
  await check('GET', '/member', 200, '冒烟新昵称', { headers: { Cookie: mPfCookie } })
  await check('POST', '/api/member/profile', 403, '30 天', {
    headers: { 'Content-Type': 'application/json', Cookie: mPfCookie },
    body: JSON.stringify({ nickname: '刚改完又改' }),
  })

  // 改密码：错旧密码拒绝 → 长度校验 → 改密前先登录一个「第二设备」会话 → 成功改密
  const MEMBER_PASS2 = 'smoke-member-67890'
  await check('POST', '/api/member/password', 400, '当前密码不正确', {
    headers: { 'Content-Type': 'application/json', Cookie: mPfCookie },
    body: JSON.stringify({ currentPassword: 'wrong-pass-123', newPassword: MEMBER_PASS2 }),
  })
  await check('POST', '/api/member/password', 400, '8-64 位', {
    headers: { 'Content-Type': 'application/json', Cookie: mPfCookie },
    body: JSON.stringify({ currentPassword: MEMBER_PASS, newPassword: 'short7' }),
  })
  const mOld = await raw('POST', '/api/member/login', {
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username: MEMBER_NAME, password: MEMBER_PASS }),
  })
  const mOldCookie = (mOld.headers.get('set-cookie') || '').split(';')[0]
  const mPwd = await raw('POST', '/api/member/password', {
    headers: { 'Content-Type': 'application/json', Cookie: mPfCookie },
    body: JSON.stringify({ currentPassword: MEMBER_PASS, newPassword: MEMBER_PASS2 }),
  })
  const mPwdOk = mPwd.status === 200
  results.push(['会员资料：修改密码成功', mPwdOk])
  console.log(`  ${mPwdOk ? '✓' : '✗'} 会员资料：修改密码成功（${mPwd.status}）`)
  // 当前会话保留；其他设备（mOldCookie）被踢下线；旧密码 401、新密码可登录
  const mKeep = await mJson(await raw('GET', '/api/member/me', { headers: { Cookie: mPfCookie } }))
  const mKicked = await mJson(await raw('GET', '/api/member/me', { headers: { Cookie: mOldCookie } }))
  const keepOk = mKeep?.member !== null && mKicked?.member === null
  results.push(['会员资料：改密后保留当前会话、踢其他设备', keepOk])
  console.log(`  ${keepOk ? '✓' : '✗'} 会员资料：改密后保留当前会话、踢其他设备`)
  await check('POST', '/api/member/login', 401, '用户名或密码错误', {
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username: MEMBER_NAME, password: MEMBER_PASS }),
  })
  const mRe = await raw('POST', '/api/member/login', {
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username: MEMBER_NAME, password: MEMBER_PASS2 }),
  })
  const mReCookie = (mRe.headers.get('set-cookie') || '').split(';')[0]
  // 改回原密码（下轮冒烟从同一状态开始）；改回动作同样踢掉 mPfCookie，改密者会话 mReCookie 保留
  const mPwdBack = await raw('POST', '/api/member/password', {
    headers: { 'Content-Type': 'application/json', Cookie: mReCookie },
    body: JSON.stringify({ currentPassword: MEMBER_PASS2, newPassword: MEMBER_PASS }),
  })
  const mBackOk = mPwdBack.status === 200 && (await mJson(await raw('GET', '/api/member/me', { headers: { Cookie: mReCookie } })))?.member !== null
  results.push(['会员资料：改回原密码（幂等收尾）', mBackOk])
  console.log(`  ${mBackOk ? '✓' : '✗'} 会员资料：改回原密码（幂等收尾）`)

  // 收尾关回开关（默认关口径），下轮冒烟从同一状态开始
  const mOff = await raw('PUT', '/api/admin/settings', {
    headers: { 'Content-Type': 'application/json', Cookie: cookie },
    body: JSON.stringify({ membersEnabled: '0' }),
  })
  await check('GET', '/member', 404)
  results.push(['会员链路：关闭开关复原', mOff.status === 200])
  console.log(`  ${mOff.status === 200 ? '✓' : '✗'} 会员链路：关闭开关复原`)

  // ── 文章访问密码（src/protect.ts）：密码墙 → 防泄漏 → 解锁 → 解除 全链路 ──
  console.log('\n▸ 文章访问密码链路')
  const PP_SECRET = '加密正文密语 smoke-secret-body-99031'
  const ppCreate = await raw('POST', '/api/admin/posts', {
    headers: { 'Content-Type': 'application/json', Cookie: cookie },
    body: JSON.stringify({
      title: '冒烟：加密文章',
      content: `<p>${PP_SECRET}</p>`,
      summary: '作者导读 smoke-summary-99031',
      status: 'published',
      password: 'smoke-pass-9999',
    }),
  })
  const ppCreated = await ppCreate.json().catch(() => null)
  const ppId = ppCreated && ppCreated.post && ppCreated.post.id
  const ppSlug = ppCreated && ppCreated.post && ppCreated.post.slug
  results.push(['加密码：建加密文章', ppCreate.status === 200 && !!ppId])
  console.log(`  ${ppCreate.status === 200 && !!ppId ? '✓' : '✗'} 加密码：建加密文章（id ${ppId}）`)
  if (ppId) {
    const ppCookie = { headers: { Cookie: cookie } }
    const ppPath = `/post/${encodeURIComponent(ppSlug)}`
    // 后台出参：hasPassword=true，password_hash 绝不出现
    const ppRow = await raw('GET', `/api/admin/posts/${ppId}`, ppCookie)
    const ppRowText = await ppRow.text()
    const ppStripOk = ppRow.status === 200 && ppRowText.includes('"hasPassword":true') && !ppRowText.includes('password_hash')
    results.push(['加密码：后台出参剥哈希', ppStripOk])
    console.log(`  ${ppStripOk ? '✓' : '✗'} 加密码：后台出参剥哈希`)
    // 访客视角：密码墙在，作者摘要照常出 meta，正文一个字都不出
    await check('GET', ppPath, 200, '本文章已加密')
    await check('GET', ppPath, 200, 'smoke-summary-99031')
    await check('GET', ppPath, 200, undefined, { notContains: PP_SECRET })
    // RSS 全文不出；关键词搜索整体不命中（防内容 LIKE 探测）
    await check('GET', '/rss.xml', 200, '冒烟：加密文章')
    await check('GET', '/rss.xml', 200, undefined, { notContains: PP_SECRET })
    await check('GET', `/search?q=${encodeURIComponent('smoke-secret-body')}`, 200, undefined, { notContains: '冒烟：加密文章' })
    // 解锁失败 → 303 带 pwerr；成功 → 303 + 解锁 Cookie
    const unlock = (pwd) =>
      fetch(`${BASE}/post/${encodeURIComponent(ppSlug)}/unlock`, {
        method: 'POST',
        redirect: 'manual',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: `password=${encodeURIComponent(pwd)}`,
        signal: AbortSignal.timeout(15_000),
      })
    const badRes = await unlock('wrong-guess')
    const badLoc = badRes.headers.get('location') || ''
    const badOk = badRes.status === 303 && badLoc.includes('pwerr=1')
    results.push(['加密码：错误密码拒绝', badOk])
    console.log(`  ${badOk ? '✓' : '✗'} 加密码：错误密码拒绝（${badRes.status} → ${badLoc}）`)
    const okRes = await unlock('smoke-pass-9999')
    const ppToken = (okRes.headers.get('set-cookie') || '').split(';')[0]
    const okOk = okRes.status === 303 && !(okRes.headers.get('location') || '').includes('pwerr') && ppToken.startsWith('bloghao_pp=')
    results.push(['加密码：正确密码签发解锁 Cookie', okOk])
    console.log(`  ${okOk ? '✓' : '✗'} 加密码：正确密码签发解锁 Cookie（${okRes.status}）`)
    // 带解锁 Cookie 正文可见；管理员会话直接放行
    await check('GET', ppPath, 200, PP_SECRET, { headers: { Cookie: ppToken } })
    await check('GET', ppPath, 200, PP_SECRET, ppCookie)
    // 解除加密（PUT password 空串）→ 访客无需 Cookie 直接可读
    await raw('PUT', `/api/admin/posts/${ppId}`, {
      headers: { 'Content-Type': 'application/json', Cookie: cookie },
      body: JSON.stringify({ password: '' }),
    })
    await check('GET', ppPath, 200, PP_SECRET)
    // 清理：软删 + 彻底删除
    const ppDel = await raw('DELETE', `/api/admin/posts/${ppId}`, ppCookie)
    await raw('DELETE', `/api/admin/trash/post/${ppId}`, ppCookie)
    results.push(['加密码：清理临时文章', ppDel.status === 200])
    console.log(`  ${ppDel.status === 200 ? '✓' : '✗'} 加密码：清理临时文章`)
  }

} finally {
  if (dev && dev.exitCode === null) dev.kill('SIGTERM')
}

const failed = results.filter(([, ok]) => !ok)
console.log(`\n${failed.length ? '✗' : '✓'} 冒烟结果：${results.length - failed.length}/${results.length} 通过`)
if (failed.length) {
  console.error('失败项：\n' + failed.map(([l]) => `  - ${l}`).join('\n'))
  process.exitCode = 1
}
