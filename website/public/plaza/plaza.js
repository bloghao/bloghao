/* 广场页 2.0 交互（ES5 同官网 site.js 口径，textContent/esc 防 XSS——feed 内容来自各站，属半可信）。
 * P1：双视图（河流 / 卡片墙 CSS columns 瀑布流）+ 卡片三型（图卡/微博卡/文字卡）+ 站点视图 + 侧栏活跃榜。
 * P2：匿名点赞（vid 记已赞 + hub 双层限流）+ 曝光/点击攒批匿名回传 + 出站链接统一 utm_source。
 * hub 数据面见 docs/PLAZA.md；纯函数段（切片标记之间）被 tests/plaza-page.test.ts 切走做镜像守卫。 */
(function () {
  'use strict'

  var HUB = '/plaza'

  // ── 纯函数段开始（tests/plaza-page.test.ts 从此切片，改动同步测试）──

  var UTM_QS = 'utm_source=bloghao-plaza'

  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, function (ch) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch]
    })
  }

  function fmtDate(ts) {
    var d = new Date(ts - 0)
    // 北京时间口径（+8h 后取 UTC 分量，与博客内核 cstDate 同理）
    var b = new Date(d.getTime() + 8 * 3600 * 1000)
    function p(n) { return (n < 10 ? '0' + n : '' + n) }
    return b.getUTCFullYear() + '-' + p(b.getUTCMonth() + 1) + '-' + p(b.getUTCDate())
  }

  // 站点名首字兜底（朱砂渐变白字，与官网目录 showcase-avatar 同语汇）
  function initialOf(name) {
    return esc((name || '博').replace(/^\s+/, '').charAt(0).toUpperCase() || '博')
  }

  // 摘要截断：n 字封顶 + 省略号（先截原始文本再 esc，别把转义实体截成半截）
  function truncate(s, n) {
    s = String(s == null ? '' : s)
    return s.length > n ? s.slice(0, Math.max(1, n - 1)) + '…' : s
  }

  // 摘要与标题同文截断时（微博 title=前80字+…、summary=前500字）不再重复渲染；
  // excerpt 截断会补省略号，前缀比对前先把尾巴剥掉（与 1.x 河流视图同一抑制口径）
  function summaryOf(it, maxLen) {
    var t = String(it && it.title || '').replace(/…\s*$/, '')
    var s = String(it && it.summary || '')
    if (!s || s.replace(/…\s*$/, '').indexOf(t) === 0) return ''
    return truncate(s, maxLen)
  }

  // 出站链接统一追加 utm_source（P2.4）：各站 visit_log 记来源域名，站长在自己后台直接看到广场回访量。
  // 已带 utm 幂等不重复；有 #fragment 时插在 fragment 前；已有 query 用 & 接
  function appendUtm(url) {
    var u = String(url || '')
    if (!u || u.indexOf(UTM_QS) !== -1) return u
    var joiner = u.indexOf('?') !== -1 ? '&' : '?'
    var hash = u.indexOf('#')
    if (hash !== -1) return u.slice(0, hash) + joiner + UTM_QS + u.slice(hash)
    return u + joiner + UTM_QS
  }

  // 隐私加固浏览器的裸 localStorage 访问会抛 SecurityError：一律走这两个包装（site.js 同款口径）
  function storeGet(k, d) {
    try {
      var v = localStorage.getItem(k)
      return v === null ? d : v
    } catch (e) { return d }
  }
  function storeSet(k, v) {
    try { localStorage.setItem(k, String(v)) } catch (e) { /* 隐私模式写入失败静默 */ }
  }

  // ── 纯函数段结束 ──

  // 认证徽章：朱砂印（纯 SVG，无文字）。信用凭证在中文语境里就是「印」——跟站点名的朱砂红
  // 形成「落款 + 钤印」的搭配，沿用官网主色 var(--accent) #b23a29，融进整套米纸设计语言。
  // 轮廓是数学对称的 8 瓣 scallop（顶点圆 V=8.55 + 内切外凸弧 ρ=4.05，圆心 12），对勾用
  // 描边而非填充块，笔意比几何填充更轻。
  var BADGE_SVG =
    '<svg class="plaza-badge-icon" viewBox="0 0 24 24" role="img" aria-label="已认证" focusable="false">' +
    '<path fill="var(--accent, #b23a29)" d="M19.9 15.27A4.05 4.05 0 0 1 15.27 19.9A4.05 4.05 0 0 1 8.73 19.9A4.05 4.05 0 0 1 4.1 15.27A4.05 4.05 0 0 1 4.1 8.73A4.05 4.05 0 0 1 8.73 4.1A4.05 4.05 0 0 1 15.27 4.1A4.05 4.05 0 0 1 19.9 8.73A4.05 4.05 0 0 1 19.9 15.27Z"/>' +
    '<path fill="none" stroke="#fff" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round" d="M7.5 12.4l3.1 3L16.6 9"/></svg>'

  function badgeHtml() {
    return '<span class="plaza-badge" title="站点已通过所有权验证">' + BADGE_SVG + '</span>'
  }

  var feedEl = document.getElementById('plaza-feed')
  var sitesEl = document.getElementById('plaza-sites')
  var state = { kind: '', view: 'river', site: 0, feed: null }

  // 头像/封面链：站点头像 > 条目封面 > favicon 链 > 首字兜底。
  // bloghao 系站点标配 /favicon.svg（站长可自定义），404 自动改试 /favicon.ico，
  // 全失败 remove 掉 img 露出底层首字块——绝不开天窗（空圈/空白框都是天窗）。
  function avatarImg(siteUrl, siteAvatar, cover) {
    if (siteAvatar || cover) {
      return '<img src="' + esc(siteAvatar || cover) + '" alt="" loading="lazy" onerror="this.remove()">'
    }
    var favBase = esc(siteUrl) + '/'
    return '<img src="' + favBase + 'favicon.svg" data-f="' + favBase + 'favicon.ico" alt="" loading="lazy" ' +
      'onerror="if(this.dataset.f){var f=this.dataset.f;this.removeAttribute(\'data-f\');this.src=f}else{this.remove()}">'
  }

  /* ---------------- 视图与身份 ---------------- */

  // 视图偏好记 localStorage；没选过时桌面默认卡片墙、≤720px 默认河流（拍板口径）
  function defaultView() {
    return window.matchMedia && window.matchMedia('(max-width: 720px)').matches ? 'river' : 'wall'
  }

  // 匿名访客标识（P2.1 防重点赞的客户端侧）：32 hex 随机串，不掺任何设备信息。
  // crypto.randomUUID 不可用时退 Math.random 兜底——只是去重凭据，不承担安全职责
  function makeVid() {
    var s = ''
    try {
      while (s.length < 32) s += crypto.randomUUID().replace(/-/g, '')
    } catch (e) { /* 退随机数 */ }
    while (s.length < 32) s += Math.floor(Math.random() * 16).toString(16)
    return s.slice(0, 32)
  }
  var VID = storeGet('plaza-vid', '')
  if (!/^[0-9a-f]{32}$/.test(VID)) {
    VID = makeVid()
    storeSet('plaza-vid', VID)
  }
  var likedMap = {}
  try {
    var parsed = JSON.parse(storeGet('plaza-liked', '{}'))
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) likedMap = parsed
  } catch (e) { likedMap = {} }

  /* ---------------- 轻互动：曝光/点击攒批回传（P2.2） ----------------
   * 事件进内存缓冲，10 个条目或 30 秒或离页时合并一 POST（sendBeacon 优先，fetch keepalive 兜底）；
   * 无 IP 无指纹，比站内 visit_log 更轻。失败静默——回传绝不影响逛。 */
  var beaconBuf = {}
  var beaconTimer = null

  function trackEvent(siteId, k) {
    if (!siteId) return
    var key = siteId + '|' + k
    beaconBuf[key] = (beaconBuf[key] || 0) + 1
    var n = 0
    for (var kk in beaconBuf) n++
    if (n >= 10) flushBeacon()
    else if (!beaconTimer) beaconTimer = setTimeout(flushBeacon, 30000)
  }

  function flushBeacon() {
    if (beaconTimer) { clearTimeout(beaconTimer); beaconTimer = null }
    var keys = Object.keys(beaconBuf)
    if (!keys.length) return
    var events = []
    for (var i = 0; i < keys.length; i++) {
      var p = keys[i].split('|')
      events.push({ s: Number(p[0]), k: p[1], n: beaconBuf[keys[i]] })
    }
    beaconBuf = {}
    var body = JSON.stringify({ events: events })
    var sent = false
    try {
      if (navigator.sendBeacon) sent = navigator.sendBeacon(HUB + '/api/beacon', body)
    } catch (e) { sent = false }
    if (!sent) {
      try { fetch(HUB + '/api/beacon', { method: 'POST', body: body, keepalive: true }) } catch (e) { /* 静默 */ }
    }
  }
  window.addEventListener('pagehide', flushBeacon)
  document.addEventListener('visibilitychange', function () {
    if (document.visibilityState === 'hidden') flushBeacon()
  })

  // 卡片曝光：IntersectionObserver 半数可见才计（预渲染/没滚到的卡不计，口径与站内
  // 「预取不计阅读量」同精神）；不支持 IO 的老浏览器退化为渲染即计
  var seenIo = null
  if ('IntersectionObserver' in window) {
    seenIo = new IntersectionObserver(function (entries) {
      for (var i = 0; i < entries.length; i++) {
        var el = entries[i].target
        seenIo.unobserve(el)
        if (!entries[i].isIntersecting || el.getAttribute('data-seen')) continue
        el.setAttribute('data-seen', '1')
        trackEvent(Number(el.getAttribute('data-site')), 'v')
      }
    }, { threshold: 0.5 })
  }

  /* ---------------- 点赞（P2.1） ---------------- */

  function likeBtnHtml(it) {
    var id = String(it.id)
    var isLiked = !!likedMap[id]
    var n = it.likes - 0
    return '<button type="button" class="plaza-like' + (isLiked ? ' is-liked' : '') + '" data-like="' + esc(id) + '"' +
      (isLiked ? ' disabled' : '') +
      ' title="' + (isLiked ? '已赞' : '给这条点个赞（匿名）') + '">' +
      '<span class="plaza-like-heart" aria-hidden="true">' + (isLiked ? '♥' : '♡') + '</span>' +
      (n >= 1 ? '<span class="plaza-like-n">' + n + '</span>' : '') +
      '</button>'
  }

  function setLiked(btn, n) {
    btn.classList.add('is-liked')
    btn.setAttribute('disabled', '')
    btn.setAttribute('title', '已赞')
    var heart = btn.querySelector('.plaza-like-heart')
    if (heart) heart.textContent = '♥'
    var num = btn.querySelector('.plaza-like-n')
    if (n >= 1) {
      if (num) num.textContent = String(n)
      else {
        num = document.createElement('span')
        num.className = 'plaza-like-n'
        num.textContent = String(n)
        btn.appendChild(num)
      }
    }
  }

  function handleLike(btn) {
    var id = btn.getAttribute('data-like')
    if (!id || likedMap[id] || btn.getAttribute('data-pending') === '1') return
    btn.setAttribute('data-pending', '1')
    fetch(HUB + '/api/like', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ itemId: Number(id), vid: VID })
    })
      .then(function (r) {
        return r.json().catch(function () { return {} }).then(function (d) { return { ok: r.ok, d: d } })
      })
      .then(function (res) {
        btn.removeAttribute('data-pending')
        if (res.ok && res.d && res.d.ok) {
          likedMap[id] = 1
          storeSet('plaza-liked', JSON.stringify(likedMap))
          setLiked(btn, Number(res.d.likes) || 0)
        } else if (res.d && res.d.error === 'daily limit') {
          btn.setAttribute('title', '今天赞得够多啦，明天再来')
        }
      })
      .catch(function () { btn.removeAttribute('data-pending') })
  }

  // feed 容器单点事件委托（capture）：点赞按钮优先，出站 <a> 点击计数（同站多卡同批合并）
  feedEl.addEventListener('click', function (ev) {
    var node = ev.target
    while (node && node !== feedEl && !(node.getAttribute && node.getAttribute('data-like'))) {
      node = node.parentNode
    }
    if (node && node !== feedEl) {
      ev.preventDefault()
      handleLike(node)
      return
    }
    // 出站点击：从点击处向上找卡片根（带 data-site），路径上出现 http(s) 链接即计一次
    node = ev.target
    while (node && node !== feedEl && !(node.getAttribute && node.getAttribute('data-site'))) {
      node = node.parentNode
    }
    if (!node || node === feedEl) return
    var a = ev.target
    while (a && a !== node) {
      if (a.tagName === 'A' && /^https:\/\//.test(a.getAttribute('href') || '')) {
        trackEvent(Number(node.getAttribute('data-site')), 'c')
        return
      }
      a = a.parentNode
    }
  }, true)

  /* ---------------- 卡片渲染 ---------------- */

  function siteViewHref(siteId) {
    return './?site=' + (siteId - 0)
  }

  // 河流视图卡片（1.x 三段式的延续）：左站点身份位 / 中标题摘要 / 右缩略图；身份与站点名进站点视图
  function riverCardHtml(it) {
    var href = esc(appendUtm(it.url))
    var sum = summaryOf(it, 200)
    return '<article class="plaza-card' + (it.kind === 'weibo' ? ' is-weibo' : '') + '" data-id="' + (it.id - 0) + '" data-site="' + (it.siteId - 0) + '">' +
      '<a class="plaza-card-avatar" href="' + siteViewHref(it.siteId) + '" aria-hidden="true" tabindex="-1">' +
      '<span class="plaza-media-fallback">' + initialOf(it.siteName) + '</span>' +
      avatarImg(it.siteUrl, it.siteAvatar, '') +
      '</a>' +
      '<div class="plaza-card-main">' +
      '<a class="plaza-card-link" href="' + href + '" target="_blank" rel="noopener">' +
      '<h3 class="plaza-card-title">' + esc(it.title) + '</h3>' +
      '</a>' +
      (sum ? '<p class="plaza-card-summary">' + esc(sum) + '</p>' : '') +
      '<div class="plaza-card-meta">' +
      '<a class="plaza-site-link" href="' + siteViewHref(it.siteId) + '">' + esc(it.siteName) + '</a>' +
      (it.siteVerified ? badgeHtml() : '') +
      '<span class="plaza-kind-chip">' + (it.kind === 'post' ? '📝 文章' : '💭 微博') + '</span>' +
      '<span>' + fmtDate(it.publishedAt) + '</span>' +
      likeBtnHtml(it) +
      '</div></div>' +
      (it.image
        ? '<a class="plaza-card-thumb" href="' + href + '" target="_blank" rel="noopener" tabindex="-1">' +
          '<img src="' + esc(it.image) + '" alt="" loading="lazy" onerror="this.parentNode.remove()"></a>'
        : '') +
      '</article>'
  }

  // 卡片墙三型（P1）：图卡 = 文章带封面（16:9 裁切 + 60 字摘要）；微博卡 = 正文优先 + 配图；
  // 文字卡 = 无图兜底（摘要 120 字补版面）。封面挂了 onerror 移除整块 → 自然退化成文字卡
  function wallCardHtml(it) {
    var isWeibo = it.kind === 'weibo'
    var img = it.image || ''
    var isImgCard = !isWeibo && !!img
    var sum = summaryOf(it, isImgCard ? 60 : 120)
    var href = esc(appendUtm(it.url))
    var cover = ''
    if (isImgCard) {
      cover = '<a class="plaza-wcard-cover" href="' + href + '" target="_blank" rel="noopener" tabindex="-1">' +
        '<img src="' + esc(img) + '" alt="" loading="lazy" onerror="this.parentNode.remove()"></a>'
    } else if (isWeibo && img) {
      cover = '<a class="plaza-wcard-media" href="' + href + '" target="_blank" rel="noopener" tabindex="-1">' +
        '<img src="' + esc(img) + '" alt="" loading="lazy" onerror="this.parentNode.remove()"></a>'
    }
    return '<article class="plaza-wcard' + (isWeibo ? ' is-weibo' : '') + (isImgCard ? ' has-img' : ' is-text') +
      '" data-id="' + (it.id - 0) + '" data-site="' + (it.siteId - 0) + '">' +
      cover +
      '<div class="plaza-wcard-body">' +
      '<a class="plaza-wcard-link" href="' + href + '" target="_blank" rel="noopener">' +
      '<h3 class="plaza-wcard-title">' + esc(isWeibo ? truncate(String(it.title || ''), 80) : it.title) + '</h3></a>' +
      (sum ? '<p class="plaza-wcard-summary">' + esc(sum) + '</p>' : '') +
      '</div>' +
      '<div class="plaza-wcard-foot">' +
      '<a class="plaza-wcard-site" href="' + siteViewHref(it.siteId) + '">' +
      '<span class="plaza-site-avatar" aria-hidden="true">' +
      '<span class="plaza-media-fallback">' + initialOf(it.siteName) + '</span>' +
      avatarImg(it.siteUrl, it.siteAvatar, '') +
      '</span>' +
      '<span class="plaza-site-name">' + esc(it.siteName) + '</span>' +
      '</a>' +
      (it.siteVerified ? badgeHtml() : '') +
      '<span class="plaza-wcard-date">' + fmtDate(it.publishedAt) + '</span>' +
      likeBtnHtml(it) +
      '</div>' +
      '</article>'
  }

  function renderView() {
    var wall = state.view === 'wall'
    feedEl.className = wall ? 'plaza-feed is-wall' : 'plaza-feed'
    if (!state.feed || !state.feed.length) {
      feedEl.innerHTML = state.site
        ? '<div class="plaza-empty">这个站点最近没有同步内容。<br><a href="./">← 返回广场</a></div>'
        : '<div class="plaza-empty">广场还空着——第一篇同步上来的文章会出现在这里。<br>你的博客号也可以：<a href="../#start">现在就开一个</a>。</div>'
      return
    }
    var html = ''
    for (var i = 0; i < state.feed.length; i++) {
      html += wall ? wallCardHtml(state.feed[i]) : riverCardHtml(state.feed[i])
    }
    feedEl.innerHTML = html
    // 曝光计数挂到新卡片上（换一批/切视图重新渲染即重新计，一批次一次曝光口径）
    var cards = feedEl.querySelectorAll('[data-site]')
    for (var j = 0; j < cards.length; j++) {
      if (seenIo) seenIo.observe(cards[j])
      else trackEvent(Number(cards[j].getAttribute('data-site')), 'v')
    }
  }

  /* ---------------- 数据加载 ---------------- */

  function loadFeed() {
    feedEl.innerHTML = '<div class="plaza-loading">广场内容加载中…</div>'
    // 时间戳抖一抖绕过中间缓存，保证「换一批」真的换
    var q = HUB + '/api/feed?limit=30' +
      (state.kind ? '&kind=' + encodeURIComponent(state.kind) : '') +
      (state.site ? '&site=' + state.site : '') +
      '&_=' + Date.now()
    fetch(q)
      .then(function (r) {
        return r.json().catch(function () { return null }).then(function (d) { return { ok: r.ok, d: d } })
      })
      .then(function (res) {
        if (!res.ok) {
          feedEl.innerHTML = state.site
            ? '<div class="plaza-empty">该站点不在广场，或已被停用。<br><a href="./">← 返回广场</a></div>'
            : '<div class="plaza-empty">广场暂时连不上，稍后再来看看。</div>'
          return
        }
        state.feed = (res.d && res.d.feed) || []
        if (res.d && res.d.site) showSiteHero(res.d.site)
        renderView()
      })
      .catch(function () {
        feedEl.innerHTML = '<div class="plaza-empty">广场暂时连不上，稍后再来看看。</div>'
      })
  }

  // 站点视图页头（P1）：站名/头像/认证印 + 「去逛逛 ↗」大按钮——回访主入口，出站统一带 utm
  function showSiteHero(site) {
    var def = document.getElementById('plaza-hero-default')
    var hero = document.getElementById('plaza-site-hero')
    if (!hero) return
    if (def) def.hidden = true
    hero.hidden = false
    var av = document.getElementById('plaza-site-hero-avatar')
    if (av) av.innerHTML = '<span class="plaza-media-fallback">' + initialOf(site.name) + '</span>' + avatarImg(site.url, site.avatar, '')
    var nameEl = document.getElementById('plaza-site-hero-name')
    if (nameEl) nameEl.innerHTML = esc(site.name || site.url) + (site.verified ? badgeHtml() : '')
    var sub = document.getElementById('plaza-site-hero-sub')
    if (sub) sub.textContent = '在广场上的最新文章与微博 · 点「去逛逛」看 TA 的博客号'
    var visit = document.getElementById('plaza-site-hero-visit')
    if (visit && site.url) {
      visit.hidden = false
      visit.href = appendUtm(site.url)
      visit.addEventListener('click', function () { trackEvent(site.id, 'c') })
    }
    document.title = (site.name || '站点') + ' —— 广场 · 博客号 BlogHao'
  }

  /* ---------------- 侧栏：活跃榜 + 最新入驻（P1） ---------------- */

  // 名录行：头像 + 站点名 → 站点视图；新站聚光期（7 天内）带「新」标；计数优先展示近 7 日
  function siteRowHtml(s, now) {
    var isNew = s.createdAt && now - s.createdAt <= 7 * 86400000
    var count = (s.recentItems - 0) >= 1 ? '7日 ' + (s.recentItems - 0) : (s.items - 0) + ' 条'
    return '<li>' +
      '<a class="plaza-site-row" href="' + siteViewHref(s.id) + '">' +
      '<span class="plaza-site-avatar" aria-hidden="true">' +
      '<span class="plaza-media-fallback">' + initialOf(s.name) + '</span>' +
      avatarImg(s.url, s.avatar, '') +
      '</span>' +
      '<span class="plaza-site-name">' + esc(s.name) + '</span>' +
      '</a>' +
      (s.verified ? badgeHtml() : '') +
      (isNew ? '<span class="plaza-new-chip" title="新站聚光期（入驻 7 天内）">新</span>' : '') +
      '<span class="plaza-sites-count">' + count + '</span>' +
      '</li>'
  }

  function renderSites(sites) {
    var list = sites || []
    if (!list.length) {
      sitesEl.innerHTML = '<li>还没有博客号上榜，第一坐等你来。</li>'
      return
    }
    var now = Date.now()
    // 活跃榜：近 7 日条数 desc → 总条数 desc → 老站优先；300 秒内的混排口径之外这是「逛」的主索引
    var active = list.slice().sort(function (a, b) {
      return ((b.recentItems || 0) - (a.recentItems || 0)) ||
        ((b.items || 0) - (a.items || 0)) ||
        ((a.createdAt || 0) - (b.createdAt || 0))
    })
    var html = ''
    for (var i = 0; i < active.length; i++) html += siteRowHtml(active[i], now)
    sitesEl.innerHTML = html
    // 最新入驻位：最新站 30 天内有过入驻才亮（避免常驻一块「陈年最新」）
    var newest = list.slice().sort(function (a, b) { return (b.createdAt || 0) - (a.createdAt || 0) }).slice(0, 5)
    var card = document.getElementById('plaza-newest-card')
    var ul = document.getElementById('plaza-newest')
    if (card && ul) {
      var fresh = newest.length && newest[0].createdAt && now - newest[0].createdAt < 30 * 86400000
      card.hidden = !fresh
      if (fresh) {
        var nh = ''
        for (var j = 0; j < newest.length; j++) nh += siteRowHtml(newest[j], now)
        ul.innerHTML = nh
      }
    }
  }

  function loadSites() {
    fetch(HUB + '/api/sites')
      .then(function (r) { return r.ok ? r.json() : null })
      .then(function (d) { renderSites(d && d.sites) })
      .catch(function () { sitesEl.innerHTML = '<li>名录暂时连不上。</li>' })
  }

  /* ---------------- 交互接线 ---------------- */

  // 类型 tab（站点视图内同样可用）
  var tabs = document.querySelectorAll('.plaza-tab[data-kind]')
  for (var i = 0; i < tabs.length; i++) {
    tabs[i].addEventListener('click', function () {
      state.kind = this.getAttribute('data-kind') || ''
      for (var j = 0; j < tabs.length; j++) {
        tabs[j].classList.toggle('is-active', tabs[j] === this)
        tabs[j].setAttribute('aria-selected', tabs[j] === this ? 'true' : 'false')
      }
      loadFeed()
    })
  }

  // 视图切换：只重渲染不发请求（同批数据两种排版），偏好记 localStorage
  function setView(v, persist) {
    state.view = v === 'wall' ? 'wall' : 'river'
    if (persist) storeSet('plaza-view', state.view)
    var vbtns = document.querySelectorAll('.plaza-tab[data-view]')
    for (var k = 0; k < vbtns.length; k++) {
      vbtns[k].classList.toggle('is-active', vbtns[k].getAttribute('data-view') === state.view)
    }
    renderView()
  }
  var vtabs = document.querySelectorAll('.plaza-tab[data-view]')
  for (var v = 0; v < vtabs.length; v++) {
    vtabs[v].addEventListener('click', function () {
      setView(this.getAttribute('data-view') === 'wall' ? 'wall' : 'river', true)
    })
  }

  document.getElementById('plaza-refresh').addEventListener('click', loadFeed)

  // 入口：?site=N 进站点视图（纯静态页面 + hub 数据面，query 形态可分享可回退）
  var siteMatch = location.search.match(/[?&]site=(\d+)/)
  state.site = siteMatch ? Number(siteMatch[1]) : 0
  setView(storeGet('plaza-view', '') === 'wall' ? 'wall' : storeGet('plaza-view', '') === 'river' ? 'river' : defaultView(), false)

  loadFeed()
  loadSites()
})()
