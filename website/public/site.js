/* 博客号官网交互：滚动入场 + 导航阴影 + 年份 */
(function () {
  'use strict'

  // 导航滚动态
  var nav = document.getElementById('nav')
  var onScroll = function () {
    nav.classList.toggle('is-scrolled', window.scrollY > 8)
  }
  window.addEventListener('scroll', onScroll, { passive: true })
  onScroll()

  // 滚动入场
  var els = document.querySelectorAll('.reveal')
  if ('IntersectionObserver' in window) {
    var io = new IntersectionObserver(
      function (entries) {
        entries.forEach(function (e) {
          if (e.isIntersecting) {
            e.target.classList.add('is-in')
            io.unobserve(e.target)
          }
        })
      },
      { threshold: 0.12, rootMargin: '0px 0px -6% 0px' }
    )
    els.forEach(function (el) {
      io.observe(el)
    })
  } else {
    els.forEach(function (el) {
      el.classList.add('is-in')
    })
  }

  // 年份
  var y = document.getElementById('year')
  if (y) y.textContent = String(new Date().getFullYear())

  // 博客号目录：数据来自 data/showcase.json（去仓库提 issue 即可上榜）
  var grid = document.getElementById('showcase-grid')
  if (grid) {
    fetch('./data/showcase.json', { cache: 'no-cache' })
      .then(function (r) {
        return r.json()
      })
      .then(function (sites) {
        if (!Array.isArray(sites) || !sites.length) {
          grid.innerHTML = '<div class="showcase-empty">第一个博客号还没有出现，等你来开。</div>'
          return
        }
        grid.innerHTML = sites
          .map(function (s) {
            var name = String(s.name || '博客号').slice(0, 30)
            var url = String(s.url || '#')
            var desc = String(s.desc || '').slice(0, 60)
            var ch = name.trim().charAt(0).toUpperCase() || '博'
            return (
              '<a class="showcase-card reveal is-in" href="' + url.replace(/"/g, '%22') + '" target="_blank" rel="noopener">' +
              '<span class="showcase-avatar">' + ch + '</span>' +
              '<span class="showcase-main"><span class="showcase-name">' + name.replace(/</g, '&lt;') + '</span>' +
              '<span class="showcase-desc">' + desc.replace(/</g, '&lt;') + '</span></span>' +
              '</a>'
            )
          })
          .join('')
      })
      .catch(function () {
        grid.innerHTML = '<div class="showcase-empty">目录暂时加载失败，刷新再试试。</div>'
      })
  }
  // 广场实况：接入站点数（hub 公开名录，与广场页同源）
  var plazaStat = document.getElementById('plaza-stat')
  if (plazaStat) {
    fetch('https://plaza.bloghao.com/api/sites', { cache: 'no-cache' })
      .then(function (r) {
        return r.json()
      })
      .then(function (d) {
        var n = d && d.sites ? d.sites.length : 0
        plazaStat.textContent = n > 0
          ? '已有 ' + n + ' 个博客号在广场相聚，随时欢迎新的。'
          : '广场虚位以待，第一个上榜的就是你。'
      })
      .catch(function () {
        plazaStat.textContent = '广场内容实时聚合中。'
      })
  }
})()
