/* 博客号文档页交互：导航阴影 + 代码块复制 + 本页目录滚动高亮 */
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
