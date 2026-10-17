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

/** 页面缓存旁路（src/pagecache.ts）：冒烟大量「写完立即匿名重读同一 URL」的断言，
 *  会撞上 5 分钟边缘缓存的旧副本。对页面与订阅源/公开 API 白名单路由的
 *  GET 自动追加 _smoke 时间戳——SSR 渲染路径与不带参数完全一致，只是绕开边缘层 */
const PAGE_BYPASS_RE = /^(\/|\/tag\/[^\/?]+|\/category\/[^\/?]+|\/post\/[^\/?]+|\/page\/[^\/?]+|\/about|\/archives|\/guestbook|\/weibo|\/links|\/member|\/rank|\/search|\/rss\.xml|\/feed\.json|\/sitemap\.xml|\/api\/public\/weibo|\/api\/public\/posts)$/
function bypassUrl(url) {
  if (url.includes('?')) return url
  const q = url.indexOf('#')
  const path = q >= 0 ? url.slice(0, q) : url
  const tail = q >= 0 ? url.slice(q) : ''
  return PAGE_BYPASS_RE.test(path) ? `${path}?_smoke=${Date.now()}${tail}` : url
}

async function check(method, url, expectStatus, expectBody, opts = {}) {
  const label = `${method} ${url}${expectBody ? '（含内容断言）' : ''}${opts.notContains ? '（不含断言）' : ''}${opts.expectHeaders ? '（响应头断言）' : ''}`
  try {
    const res = await fetch(`http://127.0.0.1:${PORT}${bypassUrl(url)}`, {
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
    if (bodyOk && opts.expectHeaders) {
      // 响应头包含断言（public/_headers 的后台防嵌套头等）：值取 includes 口径，
      // 防 CSP 这类多指令头因追加指令而整体比对失败
      for (const [name, want] of Object.entries(opts.expectHeaders)) {
        const got = res.headers.get(name) || ''
        if (!got.toLowerCase().includes(String(want).toLowerCase())) {
          console.error(`  ✗ ${label}：响应头 ${name} 期望含「${want}」，实际「${got || '(缺失)'}」`)
          bodyOk = false
        }
      }
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

  console.log('\n▸ 页面缓存端到端（src/pagecache.ts）')
  const probeBase = `http://127.0.0.1:${PORT}`
  /** 同 URL 连打两次：第一次回源填充（waitUntil 回填），第二次断言 X-Page-Cache 头。
   *  expectHeader=null 断言「不进缓存键、两次都回源」（未知参数旁路） */
  const cacheProbe = async (path, expectHeader) => {
    const label = `缓存探针 ${path} → 第二次 X-Page-Cache: ${expectHeader ?? '（无，回源旁路）'}`
    try {
      await fetch(`${probeBase}${path}`, { signal: AbortSignal.timeout(15_000) })
      await new Promise((r) => setTimeout(r, 300))
      const res = await fetch(`${probeBase}${path}`, { signal: AbortSignal.timeout(15_000) })
      const got = res.headers.get('x-page-cache') ?? null
      if (got !== expectHeader) {
        console.error(`  ✗ ${label}：实际 ${got}`)
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
  await cacheProbe('/archives', 'hit') // 公开页：第二次命中边缘层
  await cacheProbe('/api/public/weibo?limit=5', 'hit') // 公开只读 API 同口径（广场 hub pull 源）
  await cacheProbe('/rss.xml', 'hit') // 订阅源同口径（爬虫订阅器高频）
  await cacheProbe('/weibo?_smoke=probe', null) // 未知参数不进缓存键：两次都回源

  console.log('\n▸ 路由断言')
  await check('GET', '/', 200)
  // 页脚站点名片：全站页脚渲染（统计由 cron 夜更 + 冷启动播种）
  await check('GET', '/', 200, 'fc-name')
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
  // 创作热力图：归档页渲染年历网格（夹具与运行期创建的文章均落过去一年）
  await check('GET', '/archives', 200, 'hm-grid')
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
  // JSON Feed 1.1（C12）：机器可读订阅格式，与 RSS 同一份防泄漏口径
  await check('GET', '/feed.json', 200, '"version":"https://jsonfeed.org/version/1.1"')
  await check('GET', '/feed.json', 200, '"home_page_url"')
  // RSS 订阅别名（src/index.ts RSS_ALIASES）：常用盲猜路径必须与规范地址同内容，断言代表样本
  await check('GET', '/feed', 200, '<?xml')
  await check('GET', '/feed/', 200, '<?xml')
  await check('GET', '/atom.xml', 200, '<?xml')
  await check('GET', '/index.xml', 200, '<?xml')
  await check('GET', '/feeds/posts/default', 200, '<?xml')
  // WordPress 风格 ?feed=rss2：302 到 /rss.xml（fetch 默认跟随，断言最终拿到订阅内容）
  await check('GET', '/?feed=rss2', 200, '<?xml')
  await check('GET', '/sitemap.xml', 200)
  // 分享卡图：内置默认卡必须能被社交平台抓到，页面必须输出 og:image / twitter:card（og:image 绝不缺位）
  await check('GET', '/og-default.png', 200)
  await check('GET', '/', 200, 'twitter:card')
  await check('GET', '/', 200, 'og:image')
  // 后台防嵌套响应头（public/_headers）：XFO 与 CSP frame-ancestors 双写——meta CSP 装不下
  // frame-ancestors，只能在响应头层；冒烟同时守「_headers 在 wrangler dev 下确实生效」
  await check('GET', '/admin/', 200, undefined, {
    expectHeaders: { 'X-Frame-Options': 'DENY', 'Content-Security-Policy': "frame-ancestors 'none'" },
  })
  await check('GET', '/_headers', 404) // 配置文件本身不对外服务（与 Cloudflare 行为一致）
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

  // ── 上传体积预检链路（2026-10-13 修复回归）──
  // 真 bug：预检的豁免路径写成 '/admin/upload'，而实际路径是 /api/admin/upload（api 挂在 /api 下），
  // 永不匹配 → 上传端点一直按 2MB 普通限额预检：超过 2MB 的视频 / 大图 / 开放接口配图直接 413，
  // 前端只看到「上传失败」。此前没有 >2MB 请求体的用例，所以一路潜伏到线上（站长 20MB 视频失败暴露）。
  console.log('\n▸ 上传体积预检链路')
  {
    const upCookie = { headers: { Cookie: cookie } }
    // 3MB 合成 mp4：服务端只认文件魔数（前 4 字节长度 + 'ftyp' + 'isom' 主品牌 + 兼容品牌）
    const mp4 = new Uint8Array(3 * 1024 * 1024)
    mp4.set([0, 0, 0, 24, 0x66, 0x74, 0x79, 0x70, 0x69, 0x73, 0x6f, 0x6d, 0, 0, 2, 0, 0x69, 0x73, 0x6f, 0x6d, 0, 0, 0, 8])
    const fd = new FormData()
    fd.append('file', new File([mp4], 'smoke-3mb.mp4', { type: 'video/mp4' }))
    const upRes = await raw('POST', '/api/admin/upload', { ...upCookie, body: fd })
    const upBody = await upRes.json().catch(() => null)
    const passOk = upRes.status === 200 && !!(upBody && upBody.url)
    results.push(['上传预检：3MB mp4 放行（>2MB 不再 413）', passOk])
    console.log(`  ${passOk ? '✓' : '✗'} 上传预检：3MB mp4 放行（status ${upRes.status}）`)
    if (upBody && upBody.key) await raw('DELETE', `/api/admin/uploads?key=${encodeURIComponent(upBody.key)}`, upCookie)

    // 超限仍要被拦下（豁免路径修好不能顺手把上限也放宽了）
    const huge = new Uint8Array(31 * 1024 * 1024)
    huge.set([0, 0, 0, 24, 0x66, 0x74, 0x79, 0x70, 0x69, 0x73, 0x6f, 0x6d])
    const fd2 = new FormData()
    fd2.append('file', new File([huge], 'smoke-31mb.mp4', { type: 'video/mp4' }))
    const overRes = await raw('POST', '/api/admin/upload', { ...upCookie, body: fd2 })
    const overOk = overRes.status === 413
    results.push(['上传预检：31MB 仍被拒（413）', overOk])
    console.log(`  ${overOk ? '✓' : '✗'} 上传预检：31MB 仍被拒（status ${overRes.status}）`)
  }

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
  await check('GET', '/feed.json', 503) // JSON Feed 同口径：闭站连订阅面一起关
  await check('GET', '/feed', 503) // 订阅别名路径同样进闭站拦截（与规范地址同中间件链）
  await check('GET', '/sitemap.xml', 503)
  await check('POST', '/api/public/track', 503, '站点已关闭', {
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ p: '/x', r: '', v: 'smoke-closed-1', t: '' }),
  })
  // 503 + Retry-After：搜索引擎据此暂时保留收录
  const closedHome = await raw('GET', bypassUrl('/'))
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
  // 系统状态卡（B12）：/admin/stats 必须带备份状态与各表行数字段
  await check('GET', '/api/admin/stats', 200, '"backup"', { headers: { Cookie: cookie } })
  await check('GET', '/api/admin/stats', 200, '"weibo"', { headers: { Cookie: cookie } })
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

  // ── 新手引导记账位链路（概览页清单卡，db.ts onboarding 两键）──
  // 本地库不经 /api/auth/setup（夹具直灌），「首装播种」断言在 docker-poc/smoke.sh 的真实首装段；
  // 这里验证 Workers 形态下 GET 键在场（DEFAULT_SETTINGS 兜底）与 PUT 布尔归一化两口
  console.log('\n▸ 新手引导记账位链路')
  const obGet = await raw('GET', '/api/admin/settings', { headers: { Cookie: cookie } })
  const obKeyOk = obGet.status === 200 && (await obGet.text()).includes('"onboarding":"')
  results.push(['引导记账位：GET settings 键在场', obKeyOk])
  console.log(`  ${obKeyOk ? '✓' : '✗'} 引导记账位：GET settings 键在场`)
  const obOff = await putSettings({ onboarding: '0' })
  const obOffOk = obOff.status === 200 && (await obOff.text()).includes('"onboarding":"0"')
  results.push(['引导记账位：PUT 置 0 回显（跳过/完成口）', obOffOk])
  console.log(`  ${obOffOk ? '✓' : '✗'} 引导记账位：PUT 置 0 回显（status ${obOff.status}）`)
  const obOn = await putSettings({ onboarding: 'true', onboardingManual: '1' })
  const obOnText = await obOn.text()
  const obOnOk = obOn.status === 200 && obOnText.includes('"onboarding":"1"') && obOnText.includes('"onboardingManual":"1"')
  results.push(['引导记账位：PUT \'true\' 归一化为 1 + 手册键', obOnOk])
  console.log(`  ${obOnOk ? '✓' : '✗'} 引导记账位：PUT 'true' 归一化 + 手册键（status ${obOn.status}）`)
  const obManualOff = await putSettings({ onboardingManual: '0' })
  results.push(['引导记账位：手册键复位', obManualOff.status === 200])
  console.log(`  ${obManualOff.status === 200 ? '✓' : '✗'} 引导记账位：手册键复位`)

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

    // 微博视频（B19）：一条微博最多 1 个视频，url / poster 过 scheme 白名单，缺键即保留
    const vidUrl = '/images/u/smoke/smoke-video.mp4'
    const wbVid = await raw('PUT', `/api/admin/weibo/${wbId}`, {
      headers: { 'Content-Type': 'application/json', Cookie: cookie },
      body: JSON.stringify({
        content: '冒烟视频微博 #冒烟话题#',
        images: [],
        video: { url: vidUrl, poster: '', w: 640, h: 360 },
        status: 'published',
      }),
    })
    const wbVidBody = await wbVid.json().catch(() => null)
    const vidSaved = !!(wbVidBody && wbVidBody.weibo && wbVidBody.weibo.videoView && wbVidBody.weibo.videoView.url === vidUrl)
    results.push(['微博视频：带 video 保存', wbVid.status === 200 && vidSaved])
    console.log(`  ${wbVid.status === 200 && vidSaved ? '✓' : '✗'} 微博视频：带 video 保存`)
    // 前台卡片：播放器 + 按原始宽高写的占位比例（断言数据而不是类名——类名在主题 CSS 里恒在）
    await check('GET', `/weibo?wb=${wbId}`, 200, `src="${vidUrl}"`, wbCookie)
    await check('GET', `/weibo?wb=${wbId}`, 200, 'aspect-ratio:640/360', wbCookie)

    // 缺键即保留：后台列表「发布/下架」与前台老编辑器只发 content+images+status，视频不能被静默清掉
    const wbKeep = await raw('PUT', `/api/admin/weibo/${wbId}`, {
      headers: { 'Content-Type': 'application/json', Cookie: cookie },
      body: JSON.stringify({ content: '冒烟视频微博 · 缺键保留 #冒烟话题#', images: [], status: 'published' }),
    })
    const wbKeepBody = await wbKeep.json().catch(() => null)
    const kept = !!(wbKeepBody && wbKeepBody.weibo && wbKeepBody.weibo.videoView && wbKeepBody.weibo.videoView.url === vidUrl)
    results.push(['微博视频：PUT 缺 video 键 = 保留原视频', wbKeep.status === 200 && kept])
    console.log(`  ${wbKeep.status === 200 && kept ? '✓' : '✗'} 微博视频：PUT 缺 video 键 = 保留原视频`)
    await check('GET', `/weibo?wb=${wbId}`, 200, `src="${vidUrl}"`, wbCookie)

    // 显式 null = 清除
    const wbClear = await raw('PUT', `/api/admin/weibo/${wbId}`, {
      headers: { 'Content-Type': 'application/json', Cookie: cookie },
      body: JSON.stringify({ content: '冒烟视频微博 · 已清除 #冒烟话题#', images: [], video: null, status: 'published' }),
    })
    const wbClearBody = await wbClear.json().catch(() => null)
    const cleared = !!(wbClearBody && wbClearBody.weibo && wbClearBody.weibo.videoView === null)
    results.push(['微博视频：显式 null = 清除', wbClear.status === 200 && cleared])
    console.log(`  ${wbClear.status === 200 && cleared ? '✓' : '✗'} 微博视频：显式 null = 清除`)
    await check('GET', `/weibo?wb=${wbId}`, 200, undefined, { notContains: `src="${vidUrl}"`, headers: { Cookie: cookie } })
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

  // ── 前台删评论链路（2026-10-14）──
  // 管理员在前台（文章 / 留言板 / 微博评论区）直接删评论：SSR 出 data-cmt-del 键，写操作复用
  // /api/admin/comments/:id（会话鉴权、连带楼中楼、不可恢复——评论没有回收站）。
  // 三个断言：管理员页有键 / **访客页不得有键**（越权面）/ 删完前台随即不可见。
  console.log('\n▸ 前台删评论链路')
  {
    const dMark = `冒烟前台待删评论 ${Date.now()}`
    await raw('POST', '/api/public/comments', {
      headers: { 'Content-Type': 'application/json', Cookie: cookie },
      body: JSON.stringify({ slug: 'smoke-multi-tag', content: dMark, nickname: '作者' }),
    })
    const adminPage = await raw('GET', '/post/smoke-multi-tag', { headers: { Cookie: cookie } })
    const adminHtml = await adminPage.text()
    const anonPage = await raw('GET', bypassUrl('/post/smoke-multi-tag'))
    const anonHtml = await anonPage.text()

    const adminHasBtn = adminHtml.includes(dMark) && adminHtml.includes('data-cmt-del')
    results.push(['前台删评论：管理员页带 data-cmt-del 键', adminHasBtn])
    console.log(`  ${adminHasBtn ? '✓' : '✗'} 前台删评论：管理员页带 data-cmt-del 键`)

    const anonLeak = anonHtml.includes('data-cmt-del') || anonHtml.includes('data-reply')
    results.push(['前台删评论：访客页不含管理键（越权面）', !anonLeak])
    console.log(`  ${!anonLeak ? '✓' : '✗'} 前台删评论：访客页不含管理键（越权面）`)

    // 从管理员页里取这条评论的 id：内容是 li#cmt-<id> → head（含按钮）→ body（正文），
    // 所以离标记文本最近的上一个 data-cmt-del 就是它
    const at = adminHtml.indexOf(dMark)
    const near = at > 0 ? adminHtml.slice(Math.max(0, at - 3000), at) : ''
    const ids = [...near.matchAll(/data-cmt-del="(\d+)"/g)]
    const delId = ids.length ? ids[ids.length - 1][1] : ''
    results.push(['前台删评论：能从页面拿到待删 id', !!delId])
    console.log(`  ${delId ? '✓' : '✗'} 前台删评论：能从页面拿到待删 id（${delId || '未取到'}）`)

    if (delId) {
      const delRes = await raw('DELETE', `/api/admin/comments/${delId}`, { headers: { Cookie: cookie } })
      results.push(['前台删评论：DELETE 后台端点', delRes.status === 200])
      console.log(`  ${delRes.status === 200 ? '✓' : '✗'} 前台删评论：DELETE 后台端点（status ${delRes.status}）`)
      const after = await raw('GET', '/post/smoke-multi-tag', { headers: { Cookie: cookie } })
      const afterHtml = await after.text()
      results.push(['前台删评论：删完前台随即不可见', !afterHtml.includes(dMark)])
      console.log(`  ${!afterHtml.includes(dMark) ? '✓' : '✗'} 前台删评论：删完前台随即不可见`)
    }
  }

  // ── 评论 IP 属地链路（settings.showCommentRegion 默认关）──
  // 采集无条件（写库定格 request.cf 快照），展示门控在服务端。wrangler dev 会注入样本 cf
  // （US/Texas），这里守「采集 → 换算 → 门控」全链真实生效：关 = SSR/JSON 连属地名都不出现；
  // 开 = SSR 出披露 + 快照评论渲染属地标签 + JSON 带 ip_region。标签映射在 tests/ipregion.test.ts
  console.log('\n▸ 评论 IP 属地链路')
  {
    const rMark = `冒烟属地评论 ${Date.now()}`
    await raw('POST', '/api/public/comments', {
      headers: { 'Content-Type': 'application/json', Cookie: cookie },
      body: JSON.stringify({ slug: 'smoke-multi-tag', content: rMark, nickname: '作者' }),
    })
    // 默认关：SSR 无属地元素与披露文案；微博评论 JSON 不带 ip_region 键（门控在 SELECT，不只是前端藏）
    const offPage = await raw('GET', bypassUrl('/post/smoke-multi-tag'))
    const offHtml = await offPage.text()
    const offOk = !offHtml.includes('cmt-region') && !offHtml.includes('IP 属地')
    results.push(['评论属地：默认关，SSR 无属地与披露', offOk])
    console.log(`  ${offOk ? '✓' : '✗'} 评论属地：默认关，SSR 无属地与披露`)

    // 开启：SSR 表单出披露 + 属地快照渲染成标签；JSON 出参带换算好的 ip_region
    await raw('PUT', '/api/admin/settings', {
      headers: { 'Content-Type': 'application/json', Cookie: cookie },
      body: JSON.stringify({ showCommentRegion: '1' }),
    })
    const onPage = await raw('GET', bypassUrl('/post/smoke-multi-tag'))
    const onHtml = await onPage.text()
    const onOk = onHtml.includes('IP 属地') && onHtml.includes('cmt-region') && onHtml.includes('>美国<')
    results.push(['评论属地：开启后 SSR 出披露 + 属地标签（dev 样本 cf=美国）', onOk])
    console.log(`  ${onOk ? '✓' : '✗'} 评论属地：开启后 SSR 出披露 + 属地标签（dev 样本 cf=美国）`)

    // 临时微博走一遍 JSON 面（微博 id 时点不定，自建再验），验完软删清理
    const wbCreate = await raw('POST', '/api/admin/weibo', {
      headers: { 'Content-Type': 'application/json', Cookie: cookie },
      body: JSON.stringify({ content: '冒烟属地临时微博', status: 'published' }),
    })
    const wbCreated = await wbCreate.json().catch(() => null)
    const wbId = wbCreated?.weibo?.id
    if (wbId) {
      await raw('POST', `/api/public/weibo/${wbId}/comments`, {
        headers: { 'Content-Type': 'application/json', Cookie: cookie },
        body: JSON.stringify({ content: rMark }),
      })
      const onJson = await (await raw('GET', `/api/public/weibo/${wbId}/comments`)).json()
      const onJsonOk = onJson.comments?.some((x) => x.content === rMark && typeof x.ip_region === 'string' && x.ip_region.length > 0)
      results.push(['评论属地：微博 JSON 出 ip_region（服务端换算标签）', onJsonOk])
      console.log(`  ${onJsonOk ? '✓' : '✗'} 评论属地：微博 JSON 出 ip_region（${onJson?.comments?.find((x) => x.content === rMark)?.ip_region || '空'}）`)
      await raw('DELETE', `/api/admin/weibo/${wbId}`, { headers: { Cookie: cookie } })
    } else {
      results.push(['评论属地：微博 JSON 出 ip_region（服务端换算标签）', false])
      console.log('  ✗ 评论属地：微博 JSON 出 ip_region（临时微博创建失败）')
    }

    // 还原默认关
    const back = await raw('PUT', '/api/admin/settings', {
      headers: { 'Content-Type': 'application/json', Cookie: cookie },
      body: JSON.stringify({ showCommentRegion: '0' }),
    })
    const backSettings = await back.json().catch(() => null)
    const backOk = back.status === 200 && backSettings?.settings?.showCommentRegion === '0'
    results.push(['评论属地：开关还原', backOk])
    console.log(`  ${backOk ? '✓' : '✗'} 评论属地：开关还原`)
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

  // ── MCP 链路（src/mcp.ts，ROADMAP B10）：Token 鉴权 → initialize → tools/list → 发文落库 ──
  // 复用 externalToken（与开放 API 同一枚令牌）；全程临时数据，收尾复位 Token 与清理文章
  console.log('\n▸ MCP 链路')
  const MCP_TOKEN = 'smoke-mcp-token-0123456789abcdef'
  const mcpSeed = await putSettings({ externalToken: MCP_TOKEN })
  results.push(['MCP：写入 externalToken', mcpSeed.status === 200])
  console.log(`  ${mcpSeed.status === 200 ? '✓' : '✗'} MCP：写入 externalToken`)

  const mcpPost = (body, withToken) =>
    raw('POST', '/mcp', {
      headers: { 'Content-Type': 'application/json', ...(withToken ? { Authorization: `Bearer ${MCP_TOKEN}` } : {}) },
      body: JSON.stringify(body),
    })

  const mcpNoAuth = await mcpPost({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18' } }, false)
  results.push(['MCP：无 token 401', mcpNoAuth.status === 401])
  console.log(`  ${mcpNoAuth.status === 401 ? '✓' : '✗'} MCP：无 token 401（status ${mcpNoAuth.status}）`)

  const mcpInit = await mcpPost({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18' } }, true)
  const mcpInitBody = await mcpInit.json().catch(() => null)
  const mcpInitOk = mcpInit.status === 200 && mcpInitBody?.result?.protocolVersion === '2025-06-18' && !!mcpInitBody?.result?.capabilities?.tools
  results.push(['MCP：initialize 握手', mcpInitOk])
  console.log(`  ${mcpInitOk ? '✓' : '✗'} MCP：initialize 握手（protocolVersion ${mcpInitBody?.result?.protocolVersion ?? mcpInit.status}）`)

  const mcpList = await mcpPost({ jsonrpc: '2.0', id: 2, method: 'tools/list' }, true)
  const mcpListBody = await mcpList.json().catch(() => null)
  const toolNames = (mcpListBody?.result?.tools || []).map((t) => t.name)
  const mcpListOk =
    mcpList.status === 200 && ['publish_post', 'list_posts', 'get_post', 'list_comments', 'publish_weibo'].every((n) => toolNames.includes(n))
  results.push(['MCP：tools/list 五工具', mcpListOk])
  console.log(`  ${mcpListOk ? '✓' : '✗'} MCP：tools/list（${toolNames.join(', ')}）`)

  // tools/call 发文（Markdown → 净化 HTML，默认草稿）→ 草稿前台不可见 → 后台删掉
  const mcpPub = await mcpPost(
    {
      jsonrpc: '2.0',
      id: 3,
      method: 'tools/call',
      params: { name: 'publish_post', arguments: { title: '冒烟：MCP 发文', content: '# 冒烟标题\n\nMCP 正文段落', status: 'draft' } },
    },
    true
  )
  const mcpPubBody = await mcpPub.json().catch(() => null)
  const mcpOut = mcpPubBody?.result && !mcpPubBody.result.isError ? JSON.parse(mcpPubBody.result.content[0].text) : null
  results.push(['MCP：publish_post 落库', mcpPub.status === 200 && !!mcpOut?.id])
  console.log(`  ${mcpPub.status === 200 && !!mcpOut?.id ? '✓' : '✗'} MCP：publish_post 落库（id ${mcpOut?.id}，slug ${mcpOut?.slug}）`)
  if (mcpOut?.id) {
    await check('GET', `/post/${mcpOut.slug}`, 404) // 草稿前台不可见
    // 清理走软删 + 彻底删除两步（回收站行继续占用 slug，不彻底删会累积 mcp-N 撞名）
    const mcpDel = await raw('DELETE', `/api/admin/posts/${mcpOut.id}`, { headers: { Cookie: cookie } })
    const mcpPurge = await raw('DELETE', `/api/admin/trash/post/${mcpOut.id}`, { headers: { Cookie: cookie } })
    results.push(['MCP：清理临时文章', mcpDel.status === 200 && mcpPurge.status === 200])
    console.log(`  ${mcpDel.status === 200 && mcpPurge.status === 200 ? '✓' : '✗'} MCP：清理临时文章`)
  }

  const mcpGet = await raw('GET', '/mcp')
  results.push(['MCP：GET 405（无状态不开 SSE）', mcpGet.status === 405])
  console.log(`  ${mcpGet.status === 405 ? '✓' : '✗'} MCP：GET 405（无状态不开 SSE）`)

  // Token 复位（空 = 接口关闭，与 telegramBotToken 清理同款）
  await putSettings({ externalToken: '' })

  // ── 会员链路（docs/archive/DEVPLAN-2026-10-07.md 契约 v1）：开关门控 → 注册即登录 → 会员身份评论计分
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

  // AI 生成标注链路（显式标识口径）：建文带 aiGenerated → 只发 {status} 的 PUT（列表页真实载荷）不得误清
  // → 后台出参带 ai_generated:1 → 文章页 meta 行渲染「AI 生成」标注 → 清理
  const aiCreate = await raw('POST', '/api/admin/posts', {
    headers: { 'Content-Type': 'application/json', Cookie: cookie },
    body: JSON.stringify({
      title: '冒烟：AI 生成标注',
      content: '<p>冒烟 AI 标注正文</p>',
      status: 'draft',
      aiGenerated: 1,
    }),
  })
  const aiCreated = await aiCreate.json().catch(() => null)
  const aiId = aiCreated?.post?.id
  results.push(['AI 标注：建文带 aiGenerated', aiCreate.status === 200 && !!aiId])
  console.log(`  ${aiCreate.status === 200 && !!aiId ? '✓' : '✗'} AI 标注：建文带 aiGenerated（id ${aiId}）`)
  if (aiId) {
    const aiCookie = { headers: { Cookie: cookie } }
    const aiToggle = await raw('PUT', `/api/admin/posts/${aiId}`, {
      headers: { 'Content-Type': 'application/json', Cookie: cookie },
      body: JSON.stringify({ status: 'published' }),
    })
    await check('GET', `/api/admin/posts/${aiId}`, 200, '"ai_generated":1', aiCookie)
    await check('GET', `/post/${aiCreated?.post?.slug}`, 200, 'AI 生成')
    const aiMarkOk = aiToggle.status === 200
    results.push(['AI 标注：缺键 PUT 保留 + 文章页渲染', aiMarkOk])
    console.log(`  ${aiMarkOk ? '✓' : '✗'} AI 标注：缺键 PUT 保留 + 文章页渲染`)
    // 清理：软删 + 彻底删除（不碰夹具，可重复运行）
    await raw('DELETE', `/api/admin/posts/${aiId}`, { headers: { Cookie: cookie } })
    await raw('DELETE', `/api/admin/trash/post/${aiId}`, { headers: { Cookie: cookie } })
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

  // ── 站长 SEO 小件链路（B20 / B23 / B24）：设置 → 公开面验证 → 还原 ──
  // 服务端只认结构化输入（验证 meta 白名单 / 统计脚本白名单属性），断言公开面输出与 CSP 同步放宽
  console.log('\n▸ 站长 SEO 链路（B20 / B23 / B24）')
  await check('GET', '/robots.txt', 200, `Sitemap: ${BASE}/sitemap.xml`)
  const seoOn = await putSettings({
    verifyMetas: '<meta name="google-site-verification" content="smoke-verify-123">',
    analyticsScript: '<script defer src="https://analytics.smoke.example/s.js" data-website-id="smoke"></script>',
    robotsExtra: 'Disallow: /smoke-drafts/',
  })
  results.push(['SEO 链路：保存验证 meta / 统计脚本 / robots 追加段', seoOn.status === 200])
  console.log(`  ${seoOn.status === 200 ? '✓' : '✗'} SEO 链路：保存三项配置（status ${seoOn.status}）`)
  // 非法输入整体 400（不落库）：白名单外验证字段、内联脚本体
  const badVerify = await putSettings({ verifyMetas: '<meta name="description" content="x">' })
  const badScript = await putSettings({ analyticsScript: '<script>alert(1)</script>' })
  const rejectOk = badVerify.status === 400 && badScript.status === 400
  results.push(['SEO 链路：非法输入整体 400', rejectOk])
  console.log(`  ${rejectOk ? '✓' : '✗'} SEO 链路：非法输入整体 400（${badVerify.status}/${badScript.status}）`)
  await check('GET', '/robots.txt', 200, 'Disallow: /smoke-drafts/')
  const seoHome = await raw('GET', bypassUrl('/'))
  const seoHtml = await seoHome.text()
  const seoCsp = seoHome.headers.get('content-security-policy') || ''
  const injectOk =
    seoHtml.includes('<meta name="google-site-verification" content="smoke-verify-123">') &&
    seoHtml.includes('<script type="speculationrules">') &&
    seoHtml.includes('https://analytics.smoke.example/s.js')
  results.push(['SEO 链路：首页 head 注入验证 meta / 统计脚本 / 预取声明', injectOk])
  console.log(`  ${injectOk ? '✓' : '✗'} SEO 链路：首页 head 注入（status ${seoHome.status}）`)
  const cspOk =
    seoCsp.includes("'inline-speculation-rules'") &&
    seoCsp.includes('https://analytics.smoke.example') &&
    seoCsp.includes("script-src 'self'")
  results.push(['SEO 链路：CSP 同步放行统计域与内联预取声明', cspOk])
  console.log(`  ${cspOk ? '✓' : '✗'} SEO 链路：CSP 同步放宽`)
  // 文章页面包屑 JSON-LD（首页 → 分类 → 文章）
  await check('GET', '/post/smoke-multi-tag', 200, 'BreadcrumbList')
  // 分类描述（B23）：建临时分类 → 分类页出描述行 / meta description / 面包屑 → 清理
  const catCreate = await raw('POST', '/api/admin/categories', {
    headers: { 'Content-Type': 'application/json', Cookie: cookie },
    body: JSON.stringify({ name: '冒烟分类描述', slug: 'smoke-cat-desc', description: '冒烟分类描述：这个分类收些什么' }),
  })
  const catCreated = await catCreate.json().catch(() => null)
  const catId = catCreated && catCreated.category && catCreated.category.id
  results.push(['分类描述：建临时分类', catCreate.status === 200 && !!catId])
  console.log(`  ${catCreate.status === 200 && !!catId ? '✓' : '✗'} 分类描述：建临时分类（id ${catId}）`)
  if (catId) {
    const catPage = await raw('GET', '/category/smoke-cat-desc')
    const catHtml = await catPage.text()
    const catOk =
      catPage.status === 200 &&
      catHtml.includes('冒烟分类描述：这个分类收些什么') &&
      catHtml.includes('<meta name="description" content="冒烟分类描述：这个分类收些什么">') &&
      catHtml.includes('BreadcrumbList')
    results.push(['分类描述：分类页出描述行 / meta description / 面包屑', catOk])
    console.log(`  ${catOk ? '✓' : '✗'} 分类描述：分类页输出（status ${catPage.status}）`)
    const catDel = await raw('DELETE', `/api/admin/categories/${catId}`, { headers: { Cookie: cookie } })
    results.push(['分类描述：清理临时分类', catDel.status === 200])
    console.log(`  ${catDel.status === 200 ? '✓' : '✗'} 分类描述：清理临时分类`)
  }
  // AI 抓取策略（src/seo.ts buildRobotsTxt + src/bots.ts AI 令牌表，2026-10-17）：
  // 三档声明写进 /robots.txt——检索引用型显式 Allow、训练型独立 Disallow、Content-signal 行；
  // 脏档位整体 400。默认档（allow）与历史输出逐字节一致，已由 tests/seo.test.ts 守着
  const aiSeek = await putSettings({ aiPolicy: 'seek' })
  const seekTxt = await (await raw('GET', '/robots.txt')).text()
  const seekOk =
    aiSeek.status === 200 &&
    seekTxt.includes('Content-signal: search=yes, ai-input=yes, ai-train=no') &&
    seekTxt.includes('User-agent: OAI-SearchBot') &&
    seekTxt.includes('User-agent: PerplexityBot') &&
    seekTxt.includes('User-agent: GPTBot') &&
    seekTxt.includes('User-agent: CCBot') &&
    seekTxt.includes('Content-signal: search=yes') &&
    seekTxt.includes('Disallow: /admin') &&
    seekTxt.includes('Sitemap:')
  results.push(['AI 抓取策略：seek 档（检索放行 / 训练拒绝 + Content-signal）', seekOk])
  console.log(`  ${seekOk ? '✓' : '✗'} AI 抓取策略：seek 档（status ${aiSeek.status}）`)
  const aiDeny = await putSettings({ aiPolicy: 'deny' })
  const denyTxt = await (await raw('GET', '/robots.txt')).text()
  const denyOk =
    aiDeny.status === 200 &&
    denyTxt.includes('Content-signal: search=yes, ai-input=no, ai-train=no') &&
    denyTxt.includes('User-agent: OAI-SearchBot') &&
    denyTxt.includes('User-agent: GPTBot')
  results.push(['AI 抓取策略：deny 档（训练 + 检索全部拒绝，ai-input=no）', denyOk])
  console.log(`  ${denyOk ? '✓' : '✗'} AI 抓取策略：deny 档（status ${aiDeny.status}）`)
  const aiBad = await putSettings({ aiPolicy: 'yolo' })
  results.push(['AI 抓取策略：非法档位整体 400（不落库）', aiBad.status === 400])
  console.log(`  ${aiBad.status === 400 ? '✓' : '✗'} AI 抓取策略：非法档位 400（status ${aiBad.status}）`)

  const seoOff = await putSettings({ verifyMetas: '', analyticsScript: '', robotsExtra: '', aiPolicy: 'allow' })
  results.push(['SEO 链路：还原配置', seoOff.status === 200])
  console.log(`  ${seoOff.status === 200 ? '✓' : '✗'} SEO 链路：还原配置`)
  await check('GET', '/robots.txt', 200, undefined, { notContains: 'smoke-drafts' })
  const restoredTxt = await (await raw('GET', '/robots.txt')).text()
  const restoredAiOk = !restoredTxt.includes('Content-signal') && !restoredTxt.includes('AI 抓取策略')
  results.push(['AI 抓取策略：还原 allow 档后回到内置段（无 AI 声明）', restoredAiOk])
  console.log(`  ${restoredAiOk ? '✓' : '✗'} AI 抓取策略：还原 allow 档`)

  // ── SEO 收录口径链路（2026-10 SEO 审计）：sitemap 收录面收敛、标签页 noindex + canonical 自指、
  //    全站 noindex 开关（settings.siteNoindex）。与 src/rss.ts buildSitemap / pages.ts renderList /
  //    seo.ts buildRobotsTxt 三处同口径，改任一侧先跑这段 ──
  console.log('\n▸ SEO 收录口径链路')
  {
    const sm = await raw('GET', '/sitemap.xml')
    const smBody = await sm.text()
    const smOk =
      sm.status === 200 &&
      smBody.includes('/post/smoke-multi-tag') &&
      smBody.includes('/about</loc>') &&
      smBody.includes('/weibo</loc>') &&
      smBody.includes('<lastmod>') &&
      // 标签薄页 / 留言板 / 友链不再主动提交；/page/about 是 301 目标，只提交规范地址 /about
      !smBody.includes('/tag/') &&
      !smBody.includes('/guestbook') &&
      !smBody.includes('/links</loc>') &&
      !smBody.includes('/page/about')
    results.push(['sitemap 收录口径：文章/关于/微博在，标签页与薄页/301 页不在', smOk])
    console.log(`  ${smOk ? '✓' : '✗'} sitemap 收录口径（status ${sm.status}）`)

    // 标签页：noindex 退出索引，canonical 用 /tag/短链形态自指（不再指首页）
    const tagEnc = encodeURIComponent('冒烟测试')
    const tagPage = await raw('GET', `/tag/${tagEnc}`)
    const tagHtml = await tagPage.text()
    const tagOk =
      tagPage.status === 200 &&
      tagHtml.includes('<meta name="robots" content="noindex">') &&
      new RegExp(`rel="canonical" href="[^"]*\\/tag\\/${tagEnc}"`).test(tagHtml)
    results.push(['标签页 noindex + canonical 自指 /tag/短链', tagOk])
    console.log(`  ${tagOk ? '✓' : '✗'} 标签页 noindex + canonical 自指（status ${tagPage.status}）`)

    // 收录可见性守卫（2026-10-17）：/admin/stats 的 crawl 三态是后台概览告警条的唯一数据源，
    // 与 buildRobotsTxt 的整站 Disallow 同口径（演示站 demo=true 时前台不告警，故这里只断布尔形状）
    const crawl0 = await (await raw('GET', '/api/admin/stats', { headers: { Cookie: cookie } })).json()
    const crawlShapeOk = !!crawl0.crawl && crawl0.crawl.noindex === false && crawl0.crawl.closed === false
    results.push(['收录守卫：stats 出 crawl 三态（默认全可抓）', crawlShapeOk])
    console.log(`  ${crawlShapeOk ? '✓' : '✗'} 收录守卫：stats 出 crawl 三态`)

    // 全站 noindex 开关：页面出 noindex meta、robots.txt 整站 Disallow；关闭后恢复
    const nxOn = await putSettings({ siteNoindex: '1' })
    const nxHome = await raw('GET', bypassUrl('/'))
    const nxHtml = await nxHome.text()
    const nxRobotsTxt = await (await raw('GET', '/robots.txt')).text()
    const nxStats = await (await raw('GET', '/api/admin/stats', { headers: { Cookie: cookie } })).json()
    const nxOk =
      nxOn.status === 200 &&
      nxHtml.includes('<meta name="robots" content="noindex">') &&
      nxRobotsTxt === 'User-agent: *\nDisallow: /\n' &&
      nxStats.crawl?.noindex === true
    results.push(['全站 noindex：页面 meta + robots.txt 整站 Disallow + 概览告警数据源翻真', nxOk])
    console.log(`  ${nxOk ? '✓' : '✗'} 全站 noindex：页面 meta + robots.txt（status ${nxOn.status}）`)

    const nxOff = await putSettings({ siteNoindex: '0' })
    const backRobotsTxt = await (await raw('GET', '/robots.txt')).text()
    const backHome = await raw('GET', bypassUrl('/'))
    // 恢复后 robots.txt 回到内置段（Allow: / + 仅 Disallow: /admin + Sitemap 行），页面无 noindex
    const backOk =
      nxOff.status === 200 &&
      backRobotsTxt.includes('Allow: /') &&
      backRobotsTxt.includes('Disallow: /admin') &&
      backRobotsTxt.includes('Sitemap:')
    const backNoindex = !(await backHome.text()).includes('<meta name="robots" content="noindex">')
    results.push(['全站 noindex：关闭后恢复正常收录（robots.txt 还原 + 页面无 noindex）', backOk && backNoindex])
    console.log(`  ${backOk && backNoindex ? '✓' : '✗'} 全站 noindex：关闭后恢复`)
  }

  // ── 页面边缘缓存链路（src/pagecache.ts）：miss 回填 → 命中 → 设置换代作废 → 一键清理端点 ──
  // wrangler dev 有 caches.default（workerd 模拟），链路可端到端验证；冒烟其余段落全走
  // bypassUrl（带 query 不进缓存），本段是唯一刻意不带旁路参数的页面请求
  console.log('\n▸ 页面边缘缓存链路')
  {
    const cacheHome1 = await raw('GET', '/')
    const h1 = cacheHome1.headers.get('x-page-cache')
    results.push(['页缓存：首次请求回源（miss 并回填）', cacheHome1.status === 200 && h1 === 'miss'])
    console.log(`  ${h1 === 'miss' ? '✓' : '✗'} 页缓存：首次请求回源（x-page-cache: ${h1}）`)

    const cacheHome2 = await raw('GET', '/')
    const h2 = cacheHome2.headers.get('x-page-cache')
    const sameBody = (await cacheHome2.text()).includes('fc-name')
    results.push(['页缓存：第二次请求命中边缘副本', cacheHome2.status === 200 && h2 === 'hit' && sameBody])
    console.log(`  ${h2 === 'hit' ? '✓' : '✗'} 页缓存：第二次请求命中（x-page-cache: ${h2}）`)

    // 登录视角永远实时（不进缓存键），副本在也不能发给登录者
    const adminHome = await raw('GET', '/', { headers: { Cookie: cookie } })
    const ah = adminHome.headers.get('x-page-cache')
    results.push(['页缓存：管理员会话不进缓存（登录视角实时）', adminHome.status === 200 && ah !== 'hit'])
    console.log(`  ${ah !== 'hit' ? '✓' : '✗'} 页缓存：管理员会话不进缓存（x-page-cache: ${ah}）`)

    const purgeRes = await raw('POST', '/api/admin/cache/purge', { headers: { Cookie: cookie } })
    results.push(['页缓存：一键清理端点 200', purgeRes.status === 200])
    console.log(`  ${purgeRes.status === 200 ? '✓' : '✗'} 页缓存：一键清理端点（status ${purgeRes.status}）`)

    const cacheHome3 = await raw('GET', '/')
    const h3 = cacheHome3.headers.get('x-page-cache')
    results.push(['页缓存：清理后回源（旧副本整代作废）', cacheHome3.status === 200 && h3 === 'miss'])
    console.log(`  ${h3 === 'miss' ? '✓' : '✗'} 页缓存：清理后回源（x-page-cache: ${h3}）`)
  }

  // ── AI 可获取面链路（B28：/llms.txt、/llms-full.txt、/post/:slug.md Markdown 镜像）──
  // 守四件：① .md 镜像 200 且 Content-Type 是 text/markdown、内容与库同源且标签剥净（库存是
  // 净化 HTML，镜像经 htmlToMd 转换）；② llms.txt 索引出条目与订阅清单；③ llms-full.txt 出正文
  // 且不带标签；④ 密码文 .md 404（与关键词搜索「整体退出」同口径）
  console.log('\n▸ AI 可获取面链路（B28）')
  {
    const mdMark = 'smoke-llms-md-body-77881'
    const mdCreate = await raw('POST', '/api/admin/posts', {
      headers: { 'Content-Type': 'application/json', Cookie: cookie },
      body: JSON.stringify({ title: '冒烟：AI 镜像文章', content: '<p>AI 镜像正文 ' + mdMark + '</p>', summary: '镜像摘要 77881', status: 'published' }),
    })
    const mdCreated = await mdCreate.json().catch(() => null)
    const mdId = mdCreated && mdCreated.post && mdCreated.post.id
    const mdSlug = mdCreated && mdCreated.post && mdCreated.post.slug
    results.push(['AI 面建文', mdCreate.status === 200 && !!mdId])
    if (mdId) {
      const mdRes = await raw('GET', `/post/${encodeURIComponent(mdSlug)}.md`)
      const mdType = (mdRes.headers.get('content-type') || '').includes('text/markdown')
      const mdBody = await mdRes.text()
      const mdOk =
        mdRes.status === 200 &&
        mdType &&
        mdBody.includes('AI 镜像正文 ' + mdMark) &&
        !mdBody.includes('<p>') &&
        mdBody.includes('镜像摘要 77881')
      results.push(['AI 面：.md 镜像 200 + text/markdown + 正文同源且标签剥净', mdOk])
      console.log(`  ${mdOk ? '✓' : '✗'} AI 面：.md 镜像 200 + text/markdown + 正文同源且标签剥净`)

      const llmsRes = await raw('GET', '/llms.txt')
      const llmsBody = await llmsRes.text()
      const llmsOk =
        llmsRes.status === 200 &&
        (llmsRes.headers.get('content-type') || '').includes('text/markdown') &&
        llmsBody.includes(`/post/${encodeURIComponent(mdSlug)}`) &&
        llmsBody.includes('/rss.xml')
      results.push(['AI 面：llms.txt 索引出条目与机器可读清单', llmsOk])
      console.log(`  ${llmsOk ? '✓' : '✗'} AI 面：llms.txt 索引出条目与机器可读清单`)

      const fullRes = await raw('GET', '/llms-full.txt')
      const fullBody = await fullRes.text()
      const fullOk =
        fullRes.status === 200 && fullBody.includes('AI 镜像正文 ' + mdMark) && !fullBody.includes('<p>AI 镜像正文')
      results.push(['AI 面：llms-full.txt 出正文且标签剥净', fullOk])
      console.log(`  ${fullOk ? '✓' : '✗'} AI 面：llms-full.txt 出正文且标签剥净`)

      // AI 策略 deny 档：AI 面整体关闭——llms 出桩（文案指向策略）、.md 404；恢复后回正常
      const denyPut = await putSettings({ aiPolicy: 'deny' })
      const denyLlms = await raw('GET', `/llms.txt?_smoke=${Date.now()}`)
      const denyLlmsBody = await denyLlms.text()
      const denyMd = await raw('GET', `/post/${encodeURIComponent(mdSlug)}.md?_smoke=${Date.now()}`)
      const denyOk =
        denyPut.status === 200 &&
        denyLlms.status === 200 &&
        denyLlmsBody.includes('不允许 AI 抓取') &&
        !denyLlmsBody.includes('演示') &&
        denyMd.status === 404
      results.push(['AI 面：aiPolicy=deny 时 llms 出桩 + .md 404', denyOk])
      console.log(`  ${denyOk ? '✓' : '✗'} AI 面：aiPolicy=deny 时 llms 出桩 + .md 404`)
      await putSettings({ aiPolicy: 'allow' })

      // 密码文：.md 一律 404（与不存在同响应，不透露存在性）
      const pwCreate = await raw('POST', '/api/admin/posts', {
        headers: { 'Content-Type': 'application/json', Cookie: cookie },
        body: JSON.stringify({ title: '冒烟：AI 镜像加密文', content: 'smoke-llms-pw-body', status: 'published', password: 'smoke-pass-4321' }),
      })
      const pwCreated = await pwCreate.json().catch(() => null)
      const pwId = pwCreated && pwCreated.post && pwCreated.post.id
      const pwSlug = pwCreated && pwCreated.post && pwCreated.post.slug
      if (pwId) {
        const pwMd = await raw('GET', `/post/${encodeURIComponent(pwSlug)}.md`)
        const pwOk = pwMd.status === 404 && !(await pwMd.text()).includes('smoke-llms-pw-body')
        results.push(['AI 面：密码文 .md 404 不透露存在性', pwOk])
        console.log(`  ${pwOk ? '✓' : '✗'} AI 面：密码文 .md 404 不透露存在性`)
        await raw('DELETE', `/api/admin/posts/${pwId}`, { headers: { Cookie: cookie } })
        await raw('DELETE', `/api/admin/trash/post/${pwId}`, { headers: { Cookie: cookie } })
      }

      // 清理：软删后 llms 索引即不含（listPosts 的 deleted_at 过滤同源）
      await raw('DELETE', `/api/admin/posts/${mdId}`, { headers: { Cookie: cookie } })
      await raw('DELETE', `/api/admin/trash/post/${mdId}`, { headers: { Cookie: cookie } })
      const llmsAfter = await (await raw('GET', '/llms.txt')).text()
      const goneOk = !llmsAfter.includes(encodeURIComponent(mdSlug))
      results.push(['AI 面：软删后索引不再含该文', goneOk])
      console.log(`  ${goneOk ? '✓' : '✗'} AI 面：软删后索引不再含该文`)
    }
  }

  // ── 整站包链路（B26：一键导出整站 / 一键还原到空站，src/sitebundle.ts）──
  // 守三件最容易被改坏的事：① 导出必须回真 zip（PK 魔数）；② /api/admin/bundle/upload 走的是
  // 「整站包档位」（100MB）而不是 2MB 普通档——>2MB 的包必须放行；③ **空站守卫**：冒烟库里
  // 有夹具内容，导入必须被明确拒绝（永不覆盖、永不合并），且没有 start 会话时 step 也不可绕过。
  console.log('\n▸ 整站包链路（B26）')
  {
    const auth = { headers: { Cookie: cookie } }
    const jsonHeaders = { 'Content-Type': 'application/json', Cookie: cookie }

    // 未登录：与 /admin/* 同口径一律 401（导入是重操作，绝不能落在鉴权之外）
    const anonList = await raw('GET', '/api/admin/bundle/list')
    const anonExport = await raw('GET', '/api/admin/bundle/export')
    const anonOk = anonList.status === 401 && anonExport.status === 401
    results.push(['整站包：未登录一律 401', anonOk])
    console.log(`  ${anonOk ? '✓' : '✗'} 整站包：未登录一律 401（list ${anonList.status} / export ${anonExport.status}）`)

    // 导出：流式 zip（PK 魔数 + 体积合理）
    const exRes = await raw('GET', '/api/admin/bundle/export', auth)
    const exBytes = new Uint8Array(await exRes.arrayBuffer())
    const zipOk =
      exRes.status === 200 &&
      exBytes.length > 200 &&
      exBytes[0] === 0x50 &&
      exBytes[1] === 0x4b &&
      exBytes[2] === 0x03 &&
      exBytes[3] === 0x04
    results.push(['整站包：导出返回合法 zip（PK 魔数）', zipOk])
    console.log(`  ${zipOk ? '✓' : '✗'} 整站包：导出返回合法 zip（status ${exRes.status} / ${exBytes.length} 字节）`)

    // 上传（原始 body，服务端流式落 R2）：>2MB 必须放行（证明走的是整站包档位，不是普通 2MB 档）
    const bigBundle = new Uint8Array(3 * 1024 * 1024)
    bigBundle.set([0x50, 0x4b, 0x03, 0x04])
    const bigUp = await raw('POST', '/api/admin/bundle/upload', {
      headers: { 'Content-Type': 'application/zip', Cookie: cookie },
      body: bigBundle,
    })
    const bigUpBody = await bigUp.json().catch(() => null)
    const bigOk = bigUp.status === 200 && !!(bigUpBody && bigUpBody.key)
    results.push(['整站包：上传 3MB 放行（>2MB 不再 413）', bigOk])
    console.log(`  ${bigOk ? '✓' : '✗'} 整站包：上传 3MB 放行（status ${bigUp.status}）`)

    // 真包上传：拿刚导出的字节再传一遍，用来验「空站守卫」（假包会先在 zip 解析处失败）
    const realUp = await raw('POST', '/api/admin/bundle/upload', {
      headers: { 'Content-Type': 'application/zip', Cookie: cookie },
      body: exBytes,
    })
    const realUpBody = await realUp.json().catch(() => null)
    const realKey = realUpBody && realUpBody.key

    // 列表回显（含导入状态记账位）
    const listRes = await raw('GET', '/api/admin/bundle/list', auth)
    const listBody = await listRes.json().catch(() => null)
    const listed =
      listRes.status === 200 && !!(listBody && (listBody.bundles || []).some((b) => b.key === realKey) && listBody.import)
    results.push(['整站包：列表回显已上传的包与导入状态', listed])
    console.log(`  ${listed ? '✓' : '✗'} 整站包：列表回显（status ${listRes.status}）`)

    // 空站守卫：冒烟库有夹具内容 → 必须明确拒绝（且不清空任何东西）
    const startRes = await raw('POST', '/api/admin/bundle/import/start', {
      headers: jsonHeaders,
      body: JSON.stringify({ key: realKey }),
    })
    const startBody = await startRes.json().catch(() => null)
    const guardOk = startRes.status === 400 && !!(startBody && /只允许还原到/.test(startBody.error || ''))
    results.push(['整站包：非空站导入被拒（永不覆盖、永不合并）', guardOk])
    console.log(`  ${guardOk ? '✓' : '✗'} 整站包：非空站导入被拒（status ${startRes.status}）`)

    // 没有 start 会话时直接调 step 也要被拒（否则可绕过空站守卫往有内容的站里灌）
    const stepRes = await raw('POST', '/api/admin/bundle/import/step', {
      headers: jsonHeaders,
      body: JSON.stringify({ key: realKey, unit: 'posts', cursor: 0 }),
    })
    const stepOk = stepRes.status === 400
    results.push(['整站包：无会话直接调 step 被拒（守卫不可绕过）', stepOk])
    console.log(`  ${stepOk ? '✓' : '✗'} 整站包：无会话直接调 step 被拒（status ${stepRes.status}）`)

    // 夹具内容分毫未动（守卫失败的典型表现就是「被清空了」）
    const stillThere = await raw('GET', bypassUrl('/post/smoke-multi-tag'))
    const untouched = stillThere.status === 200
    results.push(['整站包：被拒后站点内容分毫未动', untouched])
    console.log(`  ${untouched ? '✓' : '✗'} 整站包：被拒后站点内容分毫未动（status ${stillThere.status}）`)

    // 「清空本站内容」（空站守卫的配套）两道闸：未登录 401 / 确认语不对 400。
    // 真清空**不在冒烟里跑**——它会毁掉本地开发库的内容（happy path 由 tests/sitebundle.test.ts 覆盖，
    // 那里用内存库跑「清空 → 导入成功」的完整链路）。
    const anonReset = await raw('POST', '/api/admin/site/reset', {
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ confirm: '清空本站' }),
    })
    const badReset = await raw('POST', '/api/admin/site/reset', {
      headers: jsonHeaders,
      body: JSON.stringify({ confirm: '清空' }),
    })
    const resetGuardOk = anonReset.status === 401 && badReset.status === 400
    results.push(['整站包：清空本站 未登录 401 / 确认语错 400', resetGuardOk])
    console.log(
      `  ${resetGuardOk ? '✓' : '✗'} 整站包：清空本站守卫（未登录 ${anonReset.status} / 确认语错 ${badReset.status}）`
    )

    // 确认语不对时绝不能动数据（这类「不可撤销」端点的典型事故就是参数校验放在删除之后）
    const afterBad = await raw('GET', bypassUrl('/post/smoke-multi-tag'))
    const notWiped = afterBad.status === 200
    results.push(['整站包：清空本站确认语错时内容分毫未动', notWiped])
    console.log(`  ${notWiped ? '✓' : '✗'} 整站包：清空本站确认语错时内容分毫未动（status ${afterBad.status}）`)

    // 清理：删掉本次上传的两个包，列表随之消失
    const del = (key) =>
      raw('POST', '/api/admin/bundle/delete', { headers: jsonHeaders, body: JSON.stringify({ key }) })
    if (bigUpBody && bigUpBody.key) await del(bigUpBody.key)
    if (realKey) await del(realKey)
    const afterList = await raw('GET', '/api/admin/bundle/list', auth)
    const afterBody = await afterList.json().catch(() => null)
    const cleaned = !!(
      afterBody &&
      !(afterBody.bundles || []).some((b) => b.key === realKey || b.key === (bigUpBody && bigUpBody.key))
    )
    results.push(['整站包：删除后列表不再回显', cleaned])
    console.log(`  ${cleaned ? '✓' : '✗'} 整站包：删除后列表不再回显`)
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
