import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  analyticsOrigin,
  analyticsScriptHtml,
  breadcrumbJsonLd,
  buildRobotsTxt,
  cleanAnalyticsScript,
  cleanCategoryDescription,
  cleanRobotsExtra,
  cleanVerifyMetas,
  isSpeculativeRequest,
  parseAnalyticsScript,
  parseVerifyMetas,
  readAiPolicy,
  speculationRulesHtml,
  SPECULATION_RULES,
  verifyMetaTagsHtml,
  AI_POLICY_VALUES,
  type AiPolicy,
} from '../src/seo.ts'
import { AI_SEEK_AGENTS, AI_TRAIN_AGENTS } from '../src/bots.ts'
import { page } from '../src/render.ts'
import { DEFAULT_SETTINGS } from '../src/db.ts'

// ── 站长 SEO 小件（ROADMAP B20 / B23 / B24，2026-10-13）──
// 后台只收结构化输入、渲染端按结构化值重放：本文件把「解析白名单 / 拒绝面 / 输出形态 /
// robots 组装 / 预取声明 / 面包屑 / 分类描述」的口径固化，防以后放开成裸 HTML 注入口。

const S = { ...DEFAULT_SETTINGS, siteName: '示例站', siteUrl: 'https://blog.example.com' }

/* ---------------- 一、站点验证 meta ---------------- */

test('验证 meta：解析白名单字段、name 大小写归一、同名后者覆盖', () => {
  const list = parseVerifyMetas(
    [
      '<meta name="google-site-verification" content="AbC-123_xyz">',
      "<meta name='msvalidate.01' content='9F8E7D6C'>",
      '<meta name="google-site-verification" content="replaced">',
    ].join('\n')
  )
  assert.deepEqual(list, [
    { name: 'google-site-verification', content: 'replaced' },
    { name: 'msvalidate.01', content: '9F8E7D6C' },
  ])
  // 单引号 / 无引号 / 自闭合写法都认（粘贴来源五花八门），输出恒为规范化值
  assert.deepEqual(parseVerifyMetas('<meta name=baidu-site-verification content=codeva-xYz />'), [
    { name: 'baidu-site-verification', content: 'codeva-xYz' },
  ])
})

test('验证 meta：非白名单字段、夹带属性、脏取值一律整体拒绝（宁拒不猜）', () => {
  const bad = [
    '<meta name="description" content="站点描述">', // 非验证字段：不许当通用 head 注入用
    '<meta name="google-site-verification" content="a" charset="utf-8">', // 夹带别的属性
    '<meta name="google-site-verification" content="a b">', // 取值含空格
    '<meta name="google-site-verification" content="a&quot;b">',
    '<meta name="google-site-verification" content="<script>">',
    '<meta name="google-site-verification">', // 缺 content
    '<div>hello</div>',
    '<script src="https://evil.example/x.js"></script>',
  ]
  for (const line of bad) assert.equal(parseVerifyMetas(line), null, `应拒绝：${line}`)
  // 超过 10 条整体拒绝（防批量灌库）
  const many = Array.from({ length: 11 }, () => '<meta name="msvalidate.01" content="x">').join('\n')
  assert.equal(parseVerifyMetas(many), null)
})

test('验证 meta：落库形态空串=清除、非法=null，渲染端脏值静默忽略且属性转义', () => {
  assert.equal(cleanVerifyMetas(''), '')
  assert.equal(cleanVerifyMetas('   \n  '), '')
  assert.equal(cleanVerifyMetas('<div>x</div>'), null)
  const json = cleanVerifyMetas('<meta name="google-site-verification" content="abc.DEF-123">')
  assert.equal(json, '[{"name":"google-site-verification","content":"abc.DEF-123"}]')
  assert.equal(
    verifyMetaTagsHtml(json!),
    '<meta name="google-site-verification" content="abc.DEF-123">'
  )
  // 手工改库塞脏值（白名单外 name / 非法取值 / 非数组）：渲染端只当没配，不抛错
  assert.equal(verifyMetaTagsHtml('{"name":"x"}'), '')
  assert.equal(verifyMetaTagsHtml('[{"name":"description","content":"x"}]'), '')
  assert.equal(verifyMetaTagsHtml('[{"name":"msvalidate.01","content":"a b"}]'), '')
  assert.equal(verifyMetaTagsHtml('not json'), '')
  assert.equal(verifyMetaTagsHtml(''), '')
})

/* ---------------- 二、统计脚本 ---------------- */

test('统计脚本：裸网址与 provider 片段都收，输出属性排序稳定、布尔属性不带值', () => {
  const bare = parseAnalyticsScript('https://umami.example.com/script.js')
  assert.deepEqual(bare, { src: 'https://umami.example.com/script.js', attrs: {} })
  assert.equal(analyticsScriptHtml(cleanAnalyticsScript('https://umami.example.com/script.js')!), '<script src="https://umami.example.com/script.js"></script>')

  const snippet = '<script defer data-website-id="abc-123" src="https://cloud.umami.is/script.js" async></script>'
  const parsed = parseAnalyticsScript(snippet)!
  assert.equal(parsed.src, 'https://cloud.umami.is/script.js')
  assert.deepEqual(Object.keys(parsed.attrs).sort(), ['async', 'data-website-id', 'defer'])
  const json = cleanAnalyticsScript(snippet)!
  // 同输入同输出：属性按名排序存库，后台回显与渲染都稳定
  assert.equal(json, '{"src":"https://cloud.umami.is/script.js","attrs":{"async":"","data-website-id":"abc-123","defer":""}}')
  assert.equal(
    analyticsScriptHtml(json),
    '<script async data-website-id="abc-123" defer src="https://cloud.umami.is/script.js"></script>'
  )
  assert.equal(analyticsOrigin(json), 'https://cloud.umami.is')
  // 后台回显 → 再存：渲染形态原样回填后重解析，落库 JSON 逐字节不变（seoDisplaySettings 的往返契约）
  assert.equal(cleanAnalyticsScript(analyticsScriptHtml(json)), json)
  const metaJson = cleanVerifyMetas('<meta name="google-site-verification" content="abc.DEF-123">')!
  assert.equal(cleanVerifyMetas(verifyMetaTagsHtml(metaJson)), metaJson)
})

test('统计脚本：内联脚本体、白名单外属性、非 https 一律拒绝', () => {
  const bad = [
    '<script>window.dataLayer=[]</script>', // 内联代码：CSP 不放行内联，也不做代码透传
    '<script src="https://a.example/s.js">alert(1)</script>',
    '<script src="https://a.example/s.js" onload="x()"></script>',
    '<script src="https://a.example/s.js" nomodule></script>',
    '<script src="http://a.example/s.js"></script>', // 非 https
    '<script src="javascript:alert(1)"></script>',
    '<script src="https://user:pass@a.example/s.js"></script>',
    '<script src="https://a.example/s.js"></script><script src="https://b.example/s.js"></script>',
    'https://a.example/s.js https://b.example/s.js',
    'javascript:alert(1)',
  ]
  for (const line of bad) assert.equal(parseAnalyticsScript(line), null, `应拒绝：${line}`)
  assert.equal(cleanAnalyticsScript(''), '')
  assert.equal(cleanAnalyticsScript('<script>x</script>'), null)
  // 手工改库塞脏值：渲染与 CSP 取域都当没配
  assert.equal(analyticsScriptHtml('{"src":"http://a.example/s.js"}'), '')
  assert.equal(analyticsScriptHtml('{"src":"https://a.example/s.js","attrs":{"onload":"x"}}'), '')
  assert.equal(analyticsOrigin('{"src":"javascript:alert(1)"}'), null)
  assert.equal(analyticsOrigin(''), null)
})

/* ---------------- 三、robots.txt 追加段 ---------------- */

test('robots 追加段：CRLF 归一、控制字符剥除、行尾空白修剪、连续空行折叠', () => {
  const raw = 'Disallow: /drafts/  \r\n\r\n\r\n\r\nSitemap: https://x.example/s.xml\u0000\u0007\r\n'
  assert.equal(cleanRobotsExtra(raw), 'Disallow: /drafts/\n\nSitemap: https://x.example/s.xml')
  assert.equal(cleanRobotsExtra(''), '')
  assert.equal(cleanRobotsExtra('   '), '')
})

test('robots 追加段：超长按整行截断，不产出半行指令', () => {
  const line = 'Disallow: /' + 'a'.repeat(80)
  const raw = Array.from({ length: 60 }, () => line).join('\n')
  const out = cleanRobotsExtra(raw)
  assert.ok(out.length <= 2000)
  for (const l of out.split('\n')) assert.ok(l === '' || l.startsWith('Disallow: /'), `半行残留：${l}`)
})

test('robots.txt 组装：未配置与历史版本逐字节一致，配置后追加段附在内置段后，演示站固定 Disallow', () => {
  const builtin = 'User-agent: *\nAllow: /\nDisallow: /admin\nSitemap: https://blog.example.com/sitemap.xml\n'
  assert.equal(buildRobotsTxt(S, 'https://blog.example.com'), builtin)
  assert.equal(buildRobotsTxt({ ...S, robotsExtra: '   ' }, 'https://blog.example.com'), builtin)
  assert.equal(
    buildRobotsTxt({ ...S, robotsExtra: 'Disallow: /drafts/\n' }, 'https://blog.example.com'),
    builtin + '\nDisallow: /drafts/\n'
  )
  // 演示站：整站 Disallow，追加段不参与（种子数据与闭站状态不该进索引）
  assert.equal(buildRobotsTxt({ ...S, robotsExtra: 'Allow: /x' }, 'https://demo.example.com', true), 'User-agent: *\nDisallow: /\n')
  // 全站 noindex 开关（settings.siteNoindex）：同演示站整站 Disallow，追加段不参与；
  // 关闭（默认 '0'/缺省）时与历史输出逐字节一致
  assert.equal(
    buildRobotsTxt({ ...S, siteNoindex: '1', robotsExtra: 'Allow: /x' }, 'https://blog.example.com'),
    'User-agent: *\nDisallow: /\n'
  )
  assert.equal(buildRobotsTxt({ ...S, siteNoindex: '0' }, 'https://blog.example.com'), builtin)
})

/* ---------------- 三之二、AI 抓取策略（robots 声明 + Content-Signal，2026-10-17） ---------------- */

test('AI 抓取策略：默认档 / 脏值 / 缺省一律 allow，输出与历史逐字节一致且不出 Content-signal', () => {
  const builtin = 'User-agent: *\nAllow: /\nDisallow: /admin\nSitemap: https://blog.example.com/sitemap.xml\n'
  for (const v of ['allow', '', undefined, 'yolo', null]) {
    assert.equal(readAiPolicy(v), 'allow')
    assert.equal(buildRobotsTxt({ ...S, aiPolicy: v as string }, 'https://blog.example.com'), builtin)
  }
  assert.equal(readAiPolicy('seek'), 'seek')
  assert.equal(readAiPolicy('deny'), 'deny')
  assert.deepEqual([...AI_POLICY_VALUES], ['allow', 'seek', 'deny'])
})

test('AI 抓取策略 seek：检索型显式 Allow、训练型独立 Disallow，Content-signal 声明 ai-train=no', () => {
  const out = buildRobotsTxt({ ...S, aiPolicy: 'seek' }, 'https://blog.example.com')
  // Content-signal 写进既有的 User-agent: * 组内（不另起组），内置段其余部分照旧
  assert.ok(
    out.startsWith(
      'User-agent: *\nContent-signal: search=yes, ai-input=yes, ai-train=no\nAllow: /\nDisallow: /admin\nSitemap: https://blog.example.com/sitemap.xml\n'
    )
  )
  assert.equal((out.match(/User-agent: \*/g) || []).length, 1, '不得出现第二个 User-agent: * 组')
  const headIdx = out.indexOf('# 站长的 AI 抓取策略')
  const allowIdx = out.indexOf('Allow: /', headIdx)
  const seekBlock = out.slice(headIdx, allowIdx)
  const trainBlock = out.slice(out.indexOf('# 训练型', allowIdx))
  for (const ua of AI_SEEK_AGENTS) assert.ok(seekBlock.includes(`User-agent: ${ua}`), `检索档缺 ${ua}`)
  // seek 组是这些爬虫的最具体组——组内规则整体取代 * 组（RFC 9309），/admin 禁令必须组内自带
  assert.ok(
    out.slice(headIdx, out.indexOf('# 训练型')).includes('Disallow: /admin'),
    '检索组缺 Disallow: /admin（只写 Allow: / 会把基座组的后台禁令对 AI 检索爬虫整个作废）'
  )
  for (const ua of AI_TRAIN_AGENTS) assert.ok(trainBlock.includes(`User-agent: ${ua}`), `训练档缺 ${ua}`)
  assert.ok(trainBlock.trimEnd().endsWith('Disallow: /'), '训练段以 Disallow: / 收尾')
  assert.ok(!out.includes('User-agent: Googlebot\n'), 'Googlebot 不进 AI 组（拒 Google-Extended 不影响搜索收录）')
})

test('AI 抓取策略 deny：训练 + 检索合并成一个 Disallow 组，声明 ai-input=no', () => {
  const out = buildRobotsTxt({ ...S, aiPolicy: 'deny' }, 'https://blog.example.com')
  assert.ok(out.includes('Content-signal: search=yes, ai-input=no, ai-train=no'))
  for (const ua of [...AI_TRAIN_AGENTS, ...AI_SEEK_AGENTS]) assert.ok(out.includes(`User-agent: ${ua}`), `拒绝档缺 ${ua}`)
  const headIdx = out.indexOf('# 站长的 AI 抓取策略')
  assert.ok(!out.slice(headIdx).includes('Allow: /'), '拒绝档不得在 AI 段放行任何 UA')
  // 演示站 / 全站 noindex：整站 Disallow，AI 段不参与（守卫不因策略档位松动）
  assert.equal(buildRobotsTxt({ ...S, aiPolicy: 'seek' }, 'https://demo.example.com', true), 'User-agent: *\nDisallow: /\n')
  assert.equal(
    buildRobotsTxt({ ...S, aiPolicy: 'seek', siteNoindex: '1' }, 'https://blog.example.com'),
    'User-agent: *\nDisallow: /\n'
  )
})

test('AI 抓取策略：robotsExtra 追加段仍排在 AI 段之前（追加段语义不变）', () => {
  const out = buildRobotsTxt({ ...S, aiPolicy: 'seek', robotsExtra: 'Disallow: /drafts/' }, 'https://blog.example.com')
  assert.ok(out.indexOf('Disallow: /drafts/') < out.indexOf('# 站长的 AI 抓取策略'))
  // 同输入同输出（令牌排序稳定）
  assert.equal(
    buildRobotsTxt({ ...S, aiPolicy: 'seek' }, 'https://blog.example.com'),
    buildRobotsTxt({ ...S, aiPolicy: 'seek' }, 'https://blog.example.com')
  )
})

/* ---------------- 四、Speculation Rules ---------------- */

test('预取声明：JSON 合法、moderate 档、排除后台/API/中间页/订阅端点，且不含 <', () => {
  const html = speculationRulesHtml()
  assert.match(html, /^<script type="speculationrules">/)
  assert.match(html, /<\/script>$/)
  const body = html.replace(/^<script type="speculationrules">/, '').replace(/<\/script>$/, '')
  assert.ok(!body.includes('<'), '声明体内不得出现 <（防脚本标签逃逸）')
  const rules = JSON.parse(body) as typeof SPECULATION_RULES
  const rule = (rules as any).prerender[0]
  assert.equal(rule.eagerness, 'moderate', '悬停即预渲染（页面边缘缓存已吸收回源成本）')
  const patterns = rule.where.and.map((c: any) => c.href_matches ?? c.not?.href_matches).filter(Boolean)
  for (const p of ['/*', '/admin*', '/api/*', '/go*', '/*.xml', '/feed.json', '/robots.txt']) {
    assert.ok(patterns.includes(p), `缺少排除/包含模式：${p}`)
  }
  assert.equal(rule.where.and.filter((c: any) => c.not?.selector_matches).length, 2)
})

test('预取 / 预渲染请求识别：Sec-Purpose 与旧版 Purpose 头，普通请求不受影响', () => {
  const req = (headers: Record<string, string>) => new Request('https://blog.example.com/post/a', { headers })
  assert.equal(isSpeculativeRequest(req({ 'Sec-Purpose': 'prefetch' })), true)
  assert.equal(isSpeculativeRequest(req({ 'Sec-Purpose': 'prefetch;prerender' })), true)
  assert.equal(isSpeculativeRequest(req({ Purpose: 'prefetch' })), true)
  assert.equal(isSpeculativeRequest(req({})), false)
  assert.equal(isSpeculativeRequest(req({ 'Sec-Purpose': 'x' })), false)
})

/* ---------------- 五、面包屑与分类描述 ---------------- */

test('面包屑 JSON-LD：position 顺序、末项（当前页）不带 item', () => {
  const ld = breadcrumbJsonLd([
    { name: '首页', url: 'https://blog.example.com/' },
    { name: '技术', url: 'https://blog.example.com/category/tech' },
    { name: '一篇文章' },
  ]) as any
  assert.equal(ld['@context'], 'https://schema.org')
  assert.equal(ld['@type'], 'BreadcrumbList')
  assert.deepEqual(
    ld.itemListElement.map((i: any) => [i.position, i.name, i.item]),
    [
      [1, '首页', 'https://blog.example.com/'],
      [2, '技术', 'https://blog.example.com/category/tech'],
      [3, '一篇文章', undefined],
    ]
  )
  assert.equal('item' in ld.itemListElement[2], false)
})

test('分类描述清洗：单行化、剥控制字符、限 300 字符', () => {
  assert.equal(cleanCategoryDescription('  技术\n随笔\t  '), '技术 随笔')
  assert.equal(cleanCategoryDescription('a\u0000b\u001Fc'), 'a b c')
  assert.equal(cleanCategoryDescription('字'.repeat(400)).length, 300)
  assert.equal(cleanCategoryDescription(undefined), '')
  assert.equal(cleanCategoryDescription(null), '')
})

/* ---------------- 六、page() 集成 ---------------- */

const pageBase = { settings: S, css: '', title: '文', path: '/post/hello', body: '' }

test('page()：未配置时出预取声明、不出验证 meta 与统计脚本（与历史输出只差声明一行）', () => {
  const html = page(pageBase)
  assert.match(html, /<script type="speculationrules">/)
  assert.ok(!html.includes('google-site-verification'))
  assert.ok(!html.includes('/script.js'))
  assert.equal((html.match(/<script type="speculationrules">/g) || []).length, 1)
})

test('page()：配置后 head 出验证 meta 与统计脚本（结构化重放，不进原始 HTML）', () => {
  const settings = {
    ...S,
    verifyMetas: cleanVerifyMetas('<meta name="google-site-verification" content="abc-123">')!,
    analyticsScript: cleanAnalyticsScript('<script defer src="https://plausible.io/js/script.js" data-domain="blog.example.com"></script>')!,
  }
  const html = page({ ...pageBase, settings })
  assert.ok(html.includes('<meta name="google-site-verification" content="abc-123">'))
  assert.ok(html.includes('<script data-domain="blog.example.com" defer src="https://plausible.io/js/script.js"></script>'))
  // 统计脚本在 head 内（结构化重放的 script 标签，不掺进正文）
  assert.ok(html.indexOf('plausible.io') < html.indexOf('</head>'))
})

test('page()：jsonLd 传数组时逐块输出（文章页 = BlogPosting + 面包屑）', () => {
  const breadcrumb = breadcrumbJsonLd([{ name: '首页', url: 'https://blog.example.com/' }, { name: '文' }])
  const html = page({ ...pageBase, jsonLd: [{ '@type': 'BlogPosting', headline: '文' }, breadcrumb] })
  const blocks = html.match(/<script type="application\/ld\+json">([\s\S]*?)<\/script>/g) || []
  assert.equal(blocks.length, 2)
  const second = JSON.parse(blocks[1].replace(/^<script type="application\/ld\+json">/, '').replace(/<\/script>$/, '')) as any
  assert.equal(second['@type'], 'BreadcrumbList')
})
