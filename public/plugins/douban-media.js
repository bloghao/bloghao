/**
 * 书影音卡片（第三方插件）
 * 编辑器工具栏新增「书影音」按钮：搜书名 / 影名 / 曲名，从豆瓣（可配自建中转，
 * 见 douban-relay/README）或备用源（Google 图书 / TMDB / iTunes）取封面与评分，
 * 组成卡片插进正文。卡片 HTML 由服务端组好返回（与净化白名单同源，客户端不拼卡）。
 *
 * 服务端：src/douban.ts（POST /api/admin/tools/douban，需登录，随插件开关）
 * 设置存 localStorage（前缀 bloghao-plugin-douban-media-），不经博客 settings。
 */
window.BlogHao &&
  window.BlogHao.registerPlugin({
    name: 'douban-media',
    title: '插入书影音卡片',
    icon:
      '<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round">' +
      '<path d="M4 5.5A1.5 1.5 0 0 1 5.5 4H9a2 2 0 0 1 2 2v13a1.6 1.6 0 0 0-1.6-1.6H5.5A1.5 1.5 0 0 1 4 15.9Z"/>' +
      '<path d="M20 5.5A1.5 1.5 0 0 0 18.5 4H15a2 2 0 0 0-2 2v13a1.6 1.6 0 0 1 1.6-1.6h3.9A1.5 1.5 0 0 0 20 15.9Z"/>' +
      '<path d="M12 8.5c1.2-.8 2.6-.8 3.8 0M12 8.5v10.9"/>' +
      '</svg>',
    onClick: function (ctx) {
      openMediaDialog(ctx)
    },
  })

function openMediaDialog(ctx) {
  const LS_PREFIX = 'bloghao-plugin-douban-media-'
  const store = {
    get(k) {
      try {
        return localStorage.getItem(LS_PREFIX + k) || ''
      } catch (e) {
        return ''
      }
    },
    set(k, v) {
      try {
        localStorage.setItem(LS_PREFIX + k, v)
      } catch (e) {
        /* 隐私模式下静默：本次会话仍可用，只是不记忆 */
      }
    },
  }

  const TYPES = [
    { id: 'book', label: '书籍' },
    { id: 'movie', label: '影视' },
    { id: 'music', label: '音乐' },
  ]

  const mask = document.createElement('div')
  mask.className = 'modal-mask'
  mask.innerHTML =
    '<div class="modal" role="dialog" style="max-width: 540px;">' +
    '<div class="modal-head"><span>插入书影音卡片</span><button class="modal-close" data-close>×</button></div>' +
    '<div class="modal-body">' +
    '<div id="dm-tabs" style="display: flex;gap: 8px;margin-bottom: 12px;"></div>' +
    '<div class="auth-field"><label>搜索</label>' +
    '<div style="display: flex;gap: 8px;">' +
    '<input class="input" id="dm-q" placeholder="书名 / 影名 / 曲目或专辑名" autocapitalize="off" autocorrect="off" spellcheck="false" style="flex: 1;">' +
    '<button class="btn btn-primary" id="dm-go">搜索</button></div></div>' +
    '<div id="dm-hint" style="display: none;font-size: 12px;color: var(--sub);margin-top: 8px;line-height: 1.7;"></div>' +
    '<div class="auth-field" style="margin-top: 10px;"><label>或粘贴豆瓣条目链接（直取评分与简介）</label>' +
    '<div style="display: flex;gap: 8px;">' +
    '<input class="input" id="dm-url" placeholder="https://book.douban.com/subject/…" autocapitalize="off" spellcheck="false" style="flex: 1;">' +
    '<button class="btn" id="dm-byurl">取卡片</button></div></div>' +
    '<div id="dm-status" style="display: none;margin-top: 10px;font-size: 13px;line-height: 1.7;"></div>' +
    '<div id="dm-results" style="margin-top: 6px;"></div>' +
    '<details id="dm-settings" style="margin-top: 14px;border-top: 1px solid var(--line, #eee);padding-top: 10px;">' +
    '<summary style="font-size: 13px;color: var(--sub);cursor: pointer;">设置 · 豆瓣中转与备用源</summary>' +
    '<div class="auth-field" style="margin-top: 10px;"><label>中转地址（自建，https）</label>' +
    '<input class="input" id="dm-relay" placeholder="https://douban.example.com" autocapitalize="off" spellcheck="false"></div>' +
    '<div class="auth-field"><label>中转令牌</label>' +
    '<input class="input" id="dm-token" type="password" placeholder="与中转服务 DOUBAN_RELAY_TOKEN 一致" autocapitalize="off" spellcheck="false"></div>' +
    '<div class="auth-field"><label>TMDB API Key（可选，电影备用源要评分就填，免费注册）</label>' +
    '<input class="input" id="dm-tmdb" placeholder="32 位 hex" autocapitalize="off" spellcheck="false"></div>' +
    '<div style="display: flex;align-items: center;gap: 10px;margin-top: 4px;">' +
    '<button class="btn" id="dm-test">测试中转</button>' +
    '<span style="font-size: 12px;color: var(--sub);line-height: 1.6;">不配中转也能用：封面自动转存进图床、书影音信息照常。中转可选——豆瓣详情页（尤其电影）被风控时，自建中转（仓库 douban-relay/，配合豆瓣登录 Cookie）能明显提高评分与简介的成功率。</span></div>' +
    '</details>' +
    '</div>' +
    '<div class="modal-foot"><button class="btn" data-close>关闭</button></div>' +
    '</div>'
  document.body.appendChild(mask)

  const close = () => mask.remove()
  mask.addEventListener('click', (e) => e.target === mask && close())
  mask.querySelectorAll('[data-close]').forEach((b) => b.addEventListener('click', close))

  const $ = (sel) => mask.querySelector(sel)
  const tabsEl = $('#dm-tabs')
  const q = $('#dm-q')
  const go = $('#dm-go')
  const urlInput = $('#dm-url')
  const byUrl = $('#dm-byurl')
  const hint = $('#dm-hint')
  const status = $('#dm-status')
  const results = $('#dm-results')
  const relayInput = $('#dm-relay')
  const tokenInput = $('#dm-token')
  const tmdbInput = $('#dm-tmdb')
  const testBtn = $('#dm-test')

  relayInput.value = store.get('relay')
  tokenInput.value = store.get('token')
  tmdbInput.value = store.get('tmdb')
  for (const el of [
    [relayInput, 'relay'],
    [tokenInput, 'token'],
    [tmdbInput, 'tmdb'],
  ]) {
    el[0].addEventListener('change', () => store.set(el[1], el[0].value.trim()))
  }

  let type = 'book'
  let lastItems = [] // 最近一次搜索结果：详情被风控时用于补卡
  let busy = false

  function showStatus(text, isErr) {
    status.textContent = text
    status.style.display = text ? 'block' : 'none'
    status.style.color = isErr ? '#c0392b' : 'var(--sub)'
  }

  function renderTabs() {
    tabsEl.innerHTML = ''
    for (const t of TYPES) {
      const b = document.createElement('button')
      b.className = 'btn' + (t.id === type ? ' btn-primary' : '')
      b.textContent = t.label
      b.addEventListener('click', () => {
        if (busy || t.id === type) return
        type = t.id
        lastItems = []
        results.innerHTML = ''
        showStatus('')
        renderTabs()
        renderHint()
        q.focus()
      })
      tabsEl.appendChild(b)
    }
  }

  function renderHint() {
    if (type === 'music') {
      hint.textContent = '豆瓣音乐搜索已下线：音乐结果来自 iTunes（封面 / 歌手 / 年份）；要豆瓣评分，请粘贴豆瓣音乐条目链接直取。'
      hint.style.display = 'block'
    } else {
      hint.style.display = 'none'
    }
  }

  function ratingBadge(item) {
    if (typeof item.rating !== 'number' || !(item.rating > 0)) return ''
    const count = item.ratingCount ? ' · ' + (item.ratingCount >= 10000 ? Math.round(item.ratingCount / 10000) + '万人' : item.ratingCount + '人') : ''
    return '<span style="color: #b26b00;font-weight: 600;">★ ' + item.rating.toFixed(1) + '</span>' + count
  }

  function sourceTag(item) {
    const names = { douban: '豆瓣', google: 'Google 图书', tmdb: 'TMDB', deezer: 'Deezer', itunes: 'iTunes' }
    return names[item.source] || item.source
  }

  function renderResults(items, blockedNote) {
    results.innerHTML = ''
    lastItems = items
    if (blockedNote) {
      const n = document.createElement('div')
      n.style.cssText = 'font-size: 12px;color: #b26b00;margin-bottom: 8px;line-height: 1.6;'
      n.textContent = blockedNote
      results.appendChild(n)
    }
    if (!items.length) {
      showStatus('没有找到条目，换个关键词试试', false)
      return
    }
    showStatus('')
    for (const item of items) {
      const row = document.createElement('div')
      row.style.cssText =
        'display: flex;align-items: center;gap: 10px;padding: 8px;border: 1px solid var(--line, #eee);border-radius: 8px;margin-bottom: 8px;cursor: pointer;'
      row.innerHTML =
        (item.cover
          ? '<img src="/api/admin/tools/douban/img?u=' +
            encodeURIComponent(String(item.cover)) +
            '" alt="" style="width: 40px;height: 54px;object-fit: cover;border-radius: 4px;background: #f0ede8;flex-shrink: 0;">'
          : '<div style="width: 40px;height: 54px;border-radius: 4px;background: #f0ede8;flex-shrink: 0;"></div>') +
        '<div style="flex: 1;min-width: 0;">' +
        '<div style="font-size: 14px;font-weight: 600;color: var(--fg, #333);overflow: hidden;text-overflow: ellipsis;white-space: nowrap;">' +
        escapeText(item.title) +
        (item.year ? ' <span style="font-weight: 400;color: var(--sub);font-size: 12px;">(' + escapeText(item.year) + ')</span>' : '') +
        '</div>' +
        '<div style="font-size: 12px;color: var(--sub);margin-top: 2px;overflow: hidden;text-overflow: ellipsis;white-space: nowrap;">' +
        escapeText(item.meta || '') +
        '</div>' +
        '<div style="font-size: 12px;margin-top: 2px;">' +
        (ratingBadge(item) || '<span style="color: var(--sub);">暂无评分</span>') +
        ' <span style="color: var(--sub);">· ' + sourceTag(item) + '</span></div>' +
        '</div>'
      row.addEventListener('click', () => insertFromItem(item))
      results.appendChild(row)
    }
  }

  function escapeText(s) {
    return String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')
  }

  async function api(body) {
    const res = await fetch('/api/admin/tools/douban', {
      method: 'POST',
      credentials: 'same-origin',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(
        Object.assign(
          {
            relay: relayInput.value.trim(),
            relayToken: tokenInput.value.trim(),
            tmdbKey: tmdbInput.value.trim(),
          },
          body
        )
      ),
      signal: typeof AbortSignal !== 'undefined' && AbortSignal.timeout ? AbortSignal.timeout(30000) : undefined,
    })
    const d = await res.json().catch(() => ({}))
    if (!res.ok) throw new Error(d.error || '请求失败')
    return d
  }

  async function doSearch() {
    if (busy) return
    const kw = q.value.trim()
    if (!kw) {
      q.focus()
      return showStatus('先输入要搜的名字', true)
    }
    busy = true
    go.disabled = true
    results.innerHTML = ''
    showStatus('搜索中…', false)
    try {
      const d = await api({ action: 'search', type: type, q: kw })
      const note = d.doubanBlocked
        ? '豆瓣暂时拒绝了请求（可稍后再试，或在下方设置里配好中转）——以下为备用源结果。'
        : ''
      renderResults(d.items || [], note)
    } catch (e) {
      showStatus(e.message || '搜索失败', true)
    }
    busy = false
    go.disabled = false
  }

  async function insertFromItem(item) {
    if (busy) return
    busy = true
    showStatus('获取评分与简介…', false)
    try {
      // 详情只此豆瓣一家：拿不到（被风控 / 备用源条目）就用搜索结果补卡
      let card = null
      if (item.source === 'douban') {
        const d = await api({ action: 'detail', type: item.type, id: item.id })
        card = d.card
      }
      if (!card) {
        const d = await api({ action: 'card', type: item.type, item: item })
        card = d.card
      }
      ctx.insertHTML(card)
      close()
      ctx.notify('已插入书影音卡片 ✅')
    } catch (e) {
      showStatus(e.message || '插入失败', true)
      busy = false
    }
  }

  async function insertFromUrl() {
    if (busy) return
    const url = urlInput.value.trim()
    if (!url) {
      urlInput.focus()
      return showStatus('先粘贴豆瓣条目链接', true)
    }
    busy = true
    byUrl.disabled = true
    showStatus('抓取豆瓣条目…', false)
    try {
      const d = await api({ action: 'detail', type: type, url: url })
      if (d.card) {
        ctx.insertHTML(d.card)
        close()
        ctx.notify('已插入书影音卡片 ✅')
        return
      }
      showStatus(d.blocked ? '豆瓣暂时拒绝了请求（风控），稍后再试或配好中转' : '没解析出条目，确认是 book/movie/music.douban.com 的 subject 链接', true)
    } catch (e) {
      showStatus(e.message || '抓取失败', true)
    }
    busy = false
    byUrl.disabled = false
  }

  async function testRelay() {
    testBtn.disabled = true
    showStatus('测试中转…', false)
    try {
      const d = await api({ action: 'test' })
      if (!d.ok) showStatus('中转不可用：' + (d.error || '未知原因'), true)
      else if (d.blocked) showStatus('中转已连通，但豆瓣正在冷却期（此前被风控），等几分钟再试', false)
      else showStatus('中转连通 ✅', false)
    } catch (e) {
      showStatus(e.message || '测试失败', true)
    }
    testBtn.disabled = false
  }

  go.addEventListener('click', doSearch)
  byUrl.addEventListener('click', insertFromUrl)
  testBtn.addEventListener('click', testRelay)
  mask.addEventListener('keydown', (e) => {
    // 中文输入法组词回车不提交（e.isComposing 判定，全站约定）
    if (e.key !== 'Enter' || e.isComposing || e.keyCode === 229) return
    if (document.activeElement === q) doSearch()
    else if (document.activeElement === urlInput) insertFromUrl()
  })
  q.focus()

  renderTabs()
  renderHint()
}
