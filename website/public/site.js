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
  // 站点投稿：表单直投 ops 控制面（ops.bloghao.com，站长审核后上榜）
  var submitForm = document.getElementById('showcase-submit')
  if (submitForm) {
    var toggle = document.getElementById('showcase-submit-link')
    var msgEl = document.getElementById('sc-msg')
    var btn = document.getElementById('sc-btn')
    function showMsg(text, ok) {
      msgEl.hidden = false
      msgEl.textContent = text
      msgEl.className = 'showcase-submit-msg ' + (ok ? 'is-ok' : 'is-err')
    }
    if (toggle) {
      toggle.addEventListener('click', function (e) {
        e.preventDefault()
        submitForm.hidden = !submitForm.hidden
        if (!submitForm.hidden) document.getElementById('sc-url').focus()
      })
    }
    submitForm.addEventListener('submit', function (e) {
      e.preventDefault()
      var url = document.getElementById('sc-url').value.trim()
      var name = document.getElementById('sc-name').value.trim()
      if (!/^https:\/\/[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+/i.test(url)) {
        showMsg('请填写 https:// 开头的完整博客号地址。', false)
        return
      }
      btn.disabled = true
      showMsg('提交中…', true)
      fetch('https://ops.bloghao.com/showcase-submit', {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: 'url=' + encodeURIComponent(url) + '&name=' + encodeURIComponent(name),
      })
        .then(function (r) { return r.json() })
        .then(function (d) {
          if (d && d.ok) {
            showMsg('✓ 已收到，站长审核通过后就会出现在上面。', true)
          } else {
            showMsg((d && d.error) || '提交没成功，稍后再试或去 GitHub 提 issue。', false)
          }
        })
        .catch(function () {
          showMsg('提交通道暂时连不上，去 GitHub 提 issue 也一样能上榜。', false)
        })
        .then(function () { btn.disabled = false })
    })
  }
  // 广场实况：接入站点数（hub 公开名录，与广场页同源）
  var plazaStat = document.getElementById('plaza-stat')
  if (plazaStat) {
    fetch('/plaza/api/sites', { cache: 'no-cache' })
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
