/* 博客号文档页交互：站内搜索 + 导航阴影 + 代码块复制 + 本页目录滚动高亮
   搜索索引由构建脚本内联为 window.__DOCS_SEARCH__（website/build-docs.mjs），
   客户端零请求、离线可用；本文件保持 ES5 风格（var / function），与官网其余脚本一致。 */
(function () {
  'use strict'

  // 导航滚动态（与官网 site.js 一致）
  var nav = document.getElementById('nav')
  if (nav) {
    var onScroll = function () {
      nav.classList.toggle('is-scrolled', window.scrollY > 8)
    }
    window.addEventListener('scroll', onScroll, { passive: true })
    onScroll()
  }

  // 年份
  var y = document.getElementById('year')
  if (y) y.textContent = String(new Date().getFullYear())

  // ---------- 站内搜索 ----------
  var SEARCH_KEY = 'docsSearchQuery'
  var RESULT_MAX = 12

  function storeGet(k) {
    try { return window.localStorage.getItem(k) || '' } catch (e) { return '' }
  }
  function storeSet(k, v) {
    try { window.localStorage.setItem(k, v) } catch (e) { /* 隐私模式忽略 */ }
  }

  function norm(s) {
    return String(s || '').toLowerCase().replace(/\s+/g, '')
  }

  function esc(s) {
    return String(s || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')
  }

  function searchIndex() {
    if (window.__DOCS_SEARCH__ && window.__DOCS_SEARCH__.entries) return window.__DOCS_SEARCH__
    return { v: 1, pages: [], entries: [] }
  }

  // 打分：页面级命中 > 小节标题命中（层级越深越次级）> 正文摘要命中。
  // 多词（空格分隔）必须全部命中同一条记录；整词查不到时退化为折叠空白的模糊匹配。
  function searchEntries(entries, query) {
    var q = String(query || '').trim()
    if (q.length < 1) return []
    var words = q.toLowerCase().split(/\s+/).filter(function (w) { return w.length > 0 })
    var nq = norm(q)
    if (!nq) return []
    var out = []
    for (var i = 0; i < entries.length; i++) {
      var e = entries[i]
      var title = String(e.title || '').toLowerCase()
      var text = String(e.text || '').toLowerCase()
      var hay = title + ' ' + text
      var nhay = norm(hay)
      var exact = hay.indexOf(q.toLowerCase()) !== -1
      var allExact = true
      var allFuzzy = true
      for (var w = 0; w < words.length; w++) {
        var word = words[w]
        if (hay.indexOf(word) === -1) allExact = false
        if (nhay.indexOf(norm(word)) === -1) allFuzzy = false
        if (!allExact && !allFuzzy) break
      }
      if (!allExact && !allFuzzy) continue
      var score = exact ? 12 : (allExact ? 8 : 3)
      // 标题命中权重：页面级记录凭「页面加分」曾把真正命中的小节（如搜「备份」时的
      // 「备份 / 数据导出」）压下去；标题里带查询词（尤其开头）应当优先。
      for (var t = 0; t < words.length; t++) {
        var at = title.indexOf(words[t])
        if (at === 0) { score += 40; break }
        if (at > 0) { score += 20; break }
      }
      if (e.level === 0) score += 34
      else if (e.level === 2) score += 10
      else if (e.level === 3) score += 5
      score -= i / 1000
      out.push({ e: e, score: score })
    }
    out.sort(function (a, b) { return b.score - a.score })
    return out
  }

  // 从命中的正文里截取窗口；返回纯文本字段与偏移，交给高亮函数切分（不拼 HTML）
  function makeSnippet(text, query) {
    var raw = String(text || '').replace(/\s+/g, ' ').trim()
    if (!raw) return null
    var q = String(query || '').trim()
    var lower = raw.toLowerCase()
    var at = q ? lower.indexOf(q.toLowerCase()) : -1
    if (at < 0 && q) {
      var first = q.toLowerCase().split(/\s+/)[0]
      at = first ? lower.indexOf(first) : -1
    }
    if (at < 0) return { lead: '', hit: '', tail: raw.slice(0, 120) + (raw.length > 120 ? '…' : '') }
    var start = Math.max(0, at - 32)
    var end = Math.min(raw.length, at + q.length + 56)
    return {
      lead: (start > 0 ? '…' : '') + raw.slice(start, at),
      hit: raw.slice(at, at + q.length),
      tail: raw.slice(at + q.length, end) + (end < raw.length ? '…' : ''),
    }
  }

  // 高亮：命中的查询词（或首个分词）只包 <mark>，其余文本走 esc()，不做 innerHTML 拼接用户输入
  function markHtml(text, query) {
    var raw = String(text || '')
    var q = String(query || '').trim()
    if (!raw) return ''
    var lower = raw.toLowerCase()
    var spans = []
    var push = q ? [q] : []
    var first = q ? q.toLowerCase().split(/\s+/)[0] : ''
    if (first && first !== q.toLowerCase()) push.push(first)
    for (var i = 0; i < push.length; i++) {
      var needle = push[i].toLowerCase()
      if (!needle) continue
      var idx = lower.indexOf(needle)
      while (idx !== -1) {
        spans.push({ at: idx, len: needle.length })
        idx = lower.indexOf(needle, idx + needle.length)
        if (spans.length > 40) break
      }
      if (spans.length) break
    }
    if (!spans.length) return esc(raw)
    spans.sort(function (a, b) { return a.at - b.at })
    var html = ''
    var cursor = 0
    for (var s = 0; s < spans.length; s++) {
      var sp = spans[s]
      if (sp.at < cursor) continue
      html += esc(raw.slice(cursor, sp.at)) + '<mark>' + esc(raw.slice(sp.at, sp.at + sp.len)) + '</mark>'
      cursor = sp.at + sp.len
    }
    html += esc(raw.slice(cursor))
    return html
  }

  function linkOf(e) {
    return e.anchor ? e.pageLink + '#' + e.anchor : e.pageLink
  }

  function itemHtml(item) {
    return '<li class="docs-search-item" role="option" aria-selected="false">' +
      '<a class="docs-search-link" href="' + esc(linkOf(item.e)) + '">' +
      '<span class="docs-search-top">' + esc(item.e.icon || '📄') + ' ' + esc(item.e.page) +
      (item.e.level === 0 ? '<span class="docs-search-tag">整篇</span>' : '') +
      '</span>' +
      '<span class="docs-search-sec">' + markHtml(item.e.sec, item.e.query) + '</span>' +
      (item.snippet ? '<span class="docs-search-snip">' + item.snippet + '</span>' : '') +
      '</a></li>'
  }

  // ---------- 搜索 UI 接线（文档页侧栏 / 文档中心 / 安全审计页顶栏共用） ----------
  var input = document.querySelector('[data-docs-search-input]')
  var list = document.querySelector('[data-docs-search-list]')
  if (input && list) {
    var index = searchIndex()
    var mode = list.className.indexOf('docs-search-list-compact') !== -1 ? 'compact' : 'list'
    var active = -1
    var hits = []

    var closeList = function () {
      list.hidden = true
      list.innerHTML = ''
      input.setAttribute('aria-expanded', 'false')
      active = -1
      hits = []
    }

    var setActive = function (n) {
      var items = list.querySelectorAll('.docs-search-item')
      active = n
      for (var i = 0; i < items.length; i++) {
        var on = i === n
        items[i].classList.toggle('is-active', on)
        items[i].setAttribute('aria-selected', on ? 'true' : 'false')
      }
      if (n >= 0 && items[n] && items[n].scrollIntoView) items[n].scrollIntoView({ block: 'nearest' })
    }

    var renderList = function (query) {
      hits = searchEntries(index.entries, query)
      if (!hits.length) {
        list.innerHTML = '<li class="docs-search-more">没找到匹配的文档，换个词试试</li>'
      } else {
        hits = hits.slice(0, RESULT_MAX)
        var parts = []
        for (var i = 0; i < hits.length; i++) {
          hits[i].e.query = query
          hits[i].snippet = null
          var snip = makeSnippet(hits[i].e.text, query)
          if (snip && (snip.hit || snip.tail)) {
            hits[i].snippet = esc(snip.lead) + (snip.hit ? '<mark>' + esc(snip.hit) + '</mark>' : '') + esc(snip.tail)
          }
          parts.push(itemHtml(hits[i]))
        }
        list.innerHTML = parts.join('')
      }
      list.hidden = false
      input.setAttribute('aria-expanded', 'true')
      setActive(-1)

      // 文档中心：同时过滤卡片（数据来自索引里的 pages）
      var cards = document.querySelectorAll('[data-search-card]')
      if (cards.length) {
        var nq = norm(query)
        var shown = 0
        for (var c = 0; c < cards.length; c++) {
          var card = cards[c]
          var text = norm(card.getAttribute('data-search-text') || card.textContent)
          var ok = !nq || (nq.indexOf(norm(text)) !== -1 || text.indexOf(nq) !== -1)
          card.hidden = !ok
          if (ok) shown++
        }
        var emptyNote = document.querySelector('[data-search-empty]')
        if (emptyNote) emptyNote.hidden = shown > 0
      }
    }

    var gotoHit = function (n) {
      if (n < 0 || !hits[n]) return
      var e = hits[n].e
      var a = list.querySelectorAll('.docs-search-link')[n]
      try { storeSet(SEARCH_KEY, input.value) } catch (err) { /* 忽略 */ }
      if (a && a.href) {
        window.location.href = a.href
        return
      }
      window.location.href = linkOf(e)
    }

    var timer = null
    input.addEventListener('input', function () {
      if (timer) window.clearTimeout(timer)
      timer = window.setTimeout(function () { renderList(input.value) }, 90)
    })
    input.addEventListener('focus', function () { if (input.value) renderList(input.value) })
    input.addEventListener('keydown', function (ev) {
      var key = ev.key
      if (key === 'ArrowDown') {
        ev.preventDefault()
        if (list.hidden) { renderList(input.value); return }
        setActive(Math.min(active + 1, list.querySelectorAll('.docs-search-item').length - 1))
      } else if (key === 'ArrowUp') {
        ev.preventDefault()
        setActive(Math.max(active - 1, -1))
      } else if (key === 'Enter') {
        if (!list.hidden && active >= 0) { ev.preventDefault(); gotoHit(active) }
        else if (!list.hidden && hits.length) { ev.preventDefault(); gotoHit(0) }
        else { ev.preventDefault(); renderList(input.value) }
      } else if (key === 'Escape') {
        closeList()
      }
    })
    document.addEventListener('click', function (ev) {
      if (ev.target === input) return
      var node = ev.target
      while (node && node !== document.body) {
        if (node === list) return
        node = node.parentNode
      }
      closeList()
    })
    // 记住上次搜索词（storeGet 包装过 try/catch，隐私模式不炸）
    var remembered = storeGet(SEARCH_KEY)
    if (remembered && !input.value) input.value = remembered
    // 带 ?q= 进入（文档中心搜索框跳转过来）时自动展开结果
    var qMatch = /[?&]q=([^&#]*)/.exec(window.location.search)
    if (qMatch) {
      var q = decodeURIComponent(qMatch[1].replace(/\+/g, ' '))
      if (q) {
        input.value = q
        storeSet(SEARCH_KEY, q)
        renderList(q)
        input.focus()
      }
    }
  }

  // 代码块复制按钮
  var boxes = document.querySelectorAll('.codeblock')
  Array.prototype.forEach.call(boxes, function (box) {
    var btn = document.createElement('button')
    btn.className = 'code-copy'
    btn.type = 'button'
    btn.textContent = '复制'
    btn.addEventListener('click', function () {
      var code = box.querySelector('code')
      var text = code ? code.innerText : ''
      var done = function () {
        btn.textContent = '已复制 ✓'
        setTimeout(function () { btn.textContent = '复制' }, 1600)
      }
      var fallback = function () {
        var ta = document.createElement('textarea')
        ta.value = text
        ta.style.position = 'fixed'
        ta.style.opacity = '0'
        document.body.appendChild(ta)
        ta.select()
        try { document.execCommand('copy'); done() } catch (e) { /* 忽略 */ }
        document.body.removeChild(ta)
      }
      if (navigator.clipboard && window.isSecureContext) {
        navigator.clipboard.writeText(text).then(done, fallback)
      } else {
        fallback()
      }
    })
    box.appendChild(btn)
  })

  // 本页目录滚动高亮
  var tocLinks = document.querySelectorAll('.docs-toc-list a[data-toc]')
  if (tocLinks.length && 'IntersectionObserver' in window) {
    var byId = {}
    Array.prototype.forEach.call(tocLinks, function (a) {
      byId[a.getAttribute('data-toc')] = a
    })
    var current = null
    var io = new IntersectionObserver(
      function (entries) {
        entries.forEach(function (e) {
          if (!e.isIntersecting) return
          if (current) current.classList.remove('is-active')
          current = byId[e.target.id]
          if (current) current.classList.add('is-active')
        })
      },
      { rootMargin: '-80px 0px -68% 0px' }
    )
    var heads = document.querySelectorAll('.doc-md h2[id], .doc-md h3[id]')
    Array.prototype.forEach.call(heads, function (h) { io.observe(h) })
  }
})()
