/* 广场页交互：拉 hub feed 渲染（ES5 同官网 site.js 口径，textContent 防 XSS——feed 内容来自各站，属半可信） */
(function () {
  'use strict'

  var HUB = 'https://plaza.bloghao.com'
  var feedEl = document.getElementById('plaza-feed')
  var sitesEl = document.getElementById('plaza-sites')
  var state = { kind: '' }

  // 认证徽章：朱砂印（纯 SVG，无文字）。信用凭证在中文语境里就是「印」——跟站点名的朱砂红
  // 形成「落款 + 钤印」的搭配，沿用官网主色 var(--accent) #b23a29，融进整套米纸设计语言。
  // 轮廓是数学对称的 8 瓣 scallop（顶点圆 V=8.55 + 内切外凸弧 ρ=4.05，圆心 12），对勾用
  // 描边而非填充块，笔意比几何填充更轻。
  var BADGE_SVG =
    '<svg class="plaza-badge-icon" viewBox="0 0 24 24" role="img" aria-label="已认证" focusable="false">' +
    '<path fill="var(--accent, #b23a29)" d="M19.9 15.27A4.05 4.05 0 0 1 15.27 19.9A4.05 4.05 0 0 1 8.73 19.9A4.05 4.05 0 0 1 4.1 15.27A4.05 4.05 0 0 1 4.1 8.73A4.05 4.05 0 0 1 8.73 4.1A4.05 4.05 0 0 1 15.27 4.1A4.05 4.05 0 0 1 19.9 8.73A4.05 4.05 0 0 1 19.9 15.27Z"/>' +
    '<path fill="none" stroke="#fff" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round" d="M7.5 12.4l3.1 3L16.6 9"/></svg>'

  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, function (ch) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch]
    })
  }

  function fmtDate(ts) {
    var d = new Date(ts - 0)
    // 北京时间口径（+8h 后取 UTC 分量，与博客内核 cstDate 同理）
    var b = new Date(d.getTime() + 8 * 3600 * 1000)
    function p(n) { return (n < 10 ? '0' : '') + n }
    return b.getUTCFullYear() + '-' + p(b.getUTCMonth() + 1) + '-' + p(b.getUTCDate())
  }

  function renderFeed(feed) {
    if (!feed || !feed.length) {
      feedEl.innerHTML =
        '<div class="plaza-empty">广场还空着——第一篇同步上来的文章会出现在这里。<br>你的博客号也可以：<a href="../#start">现在就开一个</a>。</div>'
      return
    }
    var html = ''
    for (var i = 0; i < feed.length; i++) {
      var it = feed[i]
      // 所有动态字段走 esc；hub 出参里的 url 只收 https（hub 端已校验），这里仍只作为 href 输出。
      // 卡片容器用 <article> 而非 <a>——HTML 禁止链接嵌链接：外层 a 会在 meta 的站点链接处被
      // 解析器强行闭合，整卡 DOM 被拆成空壳+散块（线上实测的「空白框、排版散架」就是这个）。
      // 整卡可点改用拉伸链接：标题 <a> 的 ::after 铺满卡片，站点链接 z-index 浮在其上各自可点。
      // media 位兜底站点首字头像（朱砂渐变白字，与官网目录 showcase-avatar 同语汇）：
      // 无封面图时必然有头像可看；有图时 img 铺在上层，加载失败 remove 后头像自然露出。
      var initial = esc((it.siteName || '博').replace(/^\s+/, '').charAt(0).toUpperCase() || '博')
      var favBase = esc(it.siteUrl) + '/'
      html +=
        '<article class="plaza-card' + (it.kind === 'weibo' ? ' is-weibo' : '') + '">' +
        '<div class="plaza-card-media" aria-hidden="true">' +
        '<span class="plaza-media-fallback">' + initial + '</span>' +
        (it.siteAvatar
          ? '<img src="' + esc(it.siteAvatar) + '" alt="" loading="lazy" onerror="this.remove()">'
          : it.image
            ? '<img src="' + esc(it.image) + '" alt="" loading="lazy" onerror="this.remove()">'
            // 站点头像走 favicon 链：bloghao 系站点标配 /favicon.svg（站长可自定义），404 再试 /favicon.ico，全失败露首字
            : '<img src="' + favBase + 'favicon.svg" data-f="' + favBase + 'favicon.ico" alt="" loading="lazy" ' +
              'onerror="if(this.dataset.f){var f=this.dataset.f;this.removeAttribute(\'data-f\');this.src=f}else{this.remove()}">') +
        '</div>' +
        '<div class="plaza-card-main">' +
        '<a class="plaza-card-link" href="' + esc(it.url) + '" target="_blank" rel="noopener">' +
        '<h3 class="plaza-card-title">' + esc(it.title) + '</h3>' +
        '</a>' +
        (it.summary && it.summary !== it.title ? '<p class="plaza-card-summary">' + esc(it.summary) + '</p>' : '') +
        '<div class="plaza-card-meta">' +
        '<a class="plaza-site-link" href="' + esc(it.siteUrl) + '" target="_blank" rel="noopener">' + esc(it.siteName) + '</a>' +
        (it.siteVerified ? '<span class="plaza-badge" title="站点已通过所有权验证">' + BADGE_SVG + '</span>' : '') +
        '<span class="plaza-kind-chip">' + (it.kind === 'post' ? '📝 文章' : '💭 微博') + '</span>' +
        '<span>' + fmtDate(it.publishedAt) + '</span>' +
        '</div></div></article>'
    }
    feedEl.innerHTML = html
  }

  function loadFeed() {
    feedEl.innerHTML = '<div class="plaza-loading">广场内容加载中…</div>'
    // 时间戳抖一抖绕过中间缓存，保证「换一批」真的换
    fetch(HUB + '/api/feed?limit=30&kind=' + state.kind + '&_=' + Date.now())
      .then(function (r) { return r.ok ? r.json() : null })
      .then(function (d) { renderFeed(d && d.feed) })
      .catch(function () {
        feedEl.innerHTML = '<div class="plaza-empty">广场暂时连不上，稍后再来看看。</div>'
      })
  }

  function renderSites(sites) {
    if (!sites || !sites.length) {
      sitesEl.innerHTML = '<li>还没有博客号上榜，第一坐等你来。</li>'
      return
    }
    var html = ''
    for (var i = 0; i < sites.length; i++) {
      var s = sites[i]
      html +=
        '<li>' +
        '<a href="' + esc(s.url) + '" target="_blank" rel="noopener">' + esc(s.name) + '</a>' +
        (s.verified ? '<span class="plaza-badge" title="站点已通过所有权验证">' + BADGE_SVG + '</span>' : '') +
        '<span class="plaza-sites-count">' + (s.items - 0) + ' 条</span>' +
        '</li>'
    }
    sitesEl.innerHTML = html
  }

  function loadSites() {
    fetch(HUB + '/api/sites')
      .then(function (r) { return r.ok ? r.json() : null })
      .then(function (d) { renderSites(d && d.sites) })
      .catch(function () { sitesEl.innerHTML = '<li>名录暂时连不上。</li>' })
  }

  // 类型 tab
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
  document.getElementById('plaza-refresh').addEventListener('click', loadFeed)

  loadFeed()
  loadSites()
})()
