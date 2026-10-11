/* 博客号后台 SPA（原生 ES Module，无构建依赖） */
import { flushEditorSave, mountEditor, disposeEditor, pickFiles, compressImage } from './editor.js'
import { loadEmoji, emojiGridHtml, insertToken } from './emoji.js'

const $app = document.getElementById('app')
const $toastSlot = document.getElementById('toast-slot')

const state = {
  user: null,
  needsSetup: false,
  settings: null,
  demo: false, // 演示站模式（/auth/state 返回 demo: true）：登录页公示演示账号、禁用改密码与闭站开关
}

/* 微博编辑态：null = 新建；点「编辑」后暂存，离开微博页时清空 */
let wbEditing = null

/* 文章列表搜索防抖：模块级，路由切换时清掉，防遗留回调把用户「拽回」文章页 */
let postsSearchTimer = null
/* 会员列表搜索防抖：同上 */
let membersSearchTimer = null
/* 搜索框是否处于焦点中：重渲染后据此恢复焦点与光标 */
let searchFocused = false
/* 当前路由名（'editor' 等）：判断「离开编辑器」用 */
let currentRoute = ''

/* ---------------- 工具 ---------------- */
function esc(s) {
  return String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;')
}

function fmtDateTime(ts) {
  if (!ts) return '—'
  const d = new Date(ts)
  const p = (x) => String(x).padStart(2, '0')
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`
}

/** 定时徽章用短格式：当年省略年份 */
function fmtScheduleShort(ts) {
  if (!ts) return '未设时间'
  const d = new Date(ts)
  const now = new Date()
  const p = (x) => String(x).padStart(2, '0')
  const ymd = `${p(d.getMonth() + 1)}-${p(d.getDate())}`
  return `${d.getFullYear() === now.getFullYear() ? '' : d.getFullYear() + '/'}${ymd} ${p(d.getHours())}:${p(d.getMinutes())}`
}

function fmtSize(bytes) {
  if (bytes >= 1024 * 1024) return (bytes / 1024 / 1024).toFixed(1) + ' MB'
  if (bytes >= 1024) return (bytes / 1024).toFixed(0) + ' KB'
  return bytes + ' B'
}

async function api(path, opts = {}) {
  const init = { method: opts.method || 'GET', credentials: 'same-origin', headers: {} }
  if (opts.body !== undefined) {
    init.headers['Content-Type'] = 'application/json'
    init.body = JSON.stringify(opts.body)
  }
  const res = await fetch('/api' + path, init)
  const data = await res.json().catch(() => ({}))
  if (!res.ok) {
    // 会话过期兜底：登录之后发生的 401 一律立即回登录页并提示，
    // 各操作按钮不再出现「点了没反应」的静默失败。
    // 登录/初始化时 state.user 还没值，密码错误的 401 仍走表单内的错误提示。
    const expired = res.status === 401 && !!state.user
    if (expired) {
      state.user = null
      authView('login')
      toast('登录已过期，请重新登录', true)
    }
    const err = new Error(expired ? '登录已过期，请重新登录' : data.error || '请求失败')
    err.status = res.status
    throw err
  }
  return data
}

function toast(msg, isErr = false) {
  const el = document.createElement('div')
  el.className = 'toast' + (isErr ? ' toast-err' : '')
  el.textContent = msg
  $toastSlot.appendChild(el)
  setTimeout(() => el.remove(), 2600)
}

function modal(html) {
  const mask = document.createElement('div')
  mask.className = 'modal-mask'
  mask.innerHTML = `<div class="modal" role="dialog">${html}</div>`
  const close = () => {
    document.removeEventListener('keydown', onKey)
    mask.remove()
  }
  // Esc 关闭；打开时焦点落进弹窗（键盘/读屏可用），关闭时焦点归还触发元素
  const onKey = (e) => {
    if (e.key === 'Escape') close()
  }
  document.addEventListener('keydown', onKey)
  const opener = document.activeElement
  mask.addEventListener('click', (e) => {
    if (e.target === mask) close()
  })
  mask.querySelectorAll('[data-close]').forEach((b) => b.addEventListener('click', close))
  document.body.appendChild(mask)
  const focusable = mask.querySelector('input, textarea, select, button:not([disabled])')
  if (focusable) focusable.focus()
  return { mask, close: () => { close(); if (opener && opener.focus) opener.focus() } }
}

function confirmBox(text) {
  return new Promise((resolve) => {
    const m = modal(`<div class="modal-body" style="padding:24px 20px;">${esc(text)}</div>
      <div class="modal-foot"><button class="btn" data-act="no">取消</button><button class="btn btn-primary" data-act="yes">确定</button></div>`)
    m.mask.querySelector('[data-act=no]').addEventListener('click', () => { m.close(); resolve(false) })
    m.mask.querySelector('[data-act=yes]').addEventListener('click', () => { m.close(); resolve(true) })
  })
}

/* ---------------- 图标 ---------------- */
const I = {
  home: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M3 10.5 12 3l9 7.5"/><path d="M5 9.5V21h14V9.5"/></svg>',
  chart: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M4 4v16h16"/><path d="M8.5 16v-4.5M13 16V7.5M17.5 16v-6"/></svg>',
  post: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"><path d="M6 4h9l4 4v12a1 1 0 0 1-1 1H6a1 1 0 0 1-1-1V5a1 1 0 0 1 1-1z"/><path d="M14 4v5h5M9 13h7M9 17h5"/></svg>',
  folder: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M3 7a1 1 0 0 1 1-1h5l2 2.5h9a1 1 0 0 1 1 1V19a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1V7z"/></svg>',
  weibo: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M21 4H5a2 2 0 0 0-2 2v9a2 2 0 0 0 2 2h3v4l4.5-4H21a2 2 0 0 0 2-2V6a2 2 0 0 0-2-2z"/><path d="M8 9h9M8 13h6"/></svg>',
  link: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M10 13a5 5 0 0 0 7.5.5l3-3a5 5 0 0 0-7.1-7.1l-1.7 1.7"/><path d="M14 11a5 5 0 0 0-7.5-.5l-3 3a5 5 0 0 0 7.1 7.1l1.7-1.7"/></svg>',
  edit: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M4 20h4l11-11-4-4L4 16v4z"/><path d="M13 7l4 4"/></svg>',
  comment: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linejoin="round"><path d="M21 11.5c0 4.1-4 7.5-9 7.5-1 0-2-.1-2.9-.4L4 20l1.2-3.2C3.8 15.4 3 13.5 3 11.5 3 7.4 7 4 12 4s9 3.4 9 7.5z"/></svg>',
  member: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="8" r="4"/><path d="M4.5 20c1.4-3.4 4.3-5 7.5-5s6.1 1.6 7.5 5"/></svg>',
  image: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="4" width="18" height="16" rx="2"/><circle cx="9" cy="10" r="1.6"/><path d="m5 19 5.5-5.5L14 17l3-3 4 4"/></svg>',
  page: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="4" width="18" height="16" rx="2"/><path d="M3 9h18"/><path d="M7 13h10M7 16.5h6"/></svg>',
  trash: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M4 7h16"/><path d="M9 7V5a1 1 0 0 1 1-1h4a1 1 0 0 1 1 1v2"/><path d="M6 7l1 13a1 1 0 0 0 1 1h8a1 1 0 0 0 1-1l1-13"/><path d="M10 11v6M14 11v6"/></svg>',
  gear: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="3.2"/><path d="M19 12a7 7 0 0 0-.1-1.2l2-1.5-2-3.4-2.3 1a7 7 0 0 0-2-1.2L14.2 3h-4l-.4 2.7a7 7 0 0 0-2 1.2l-2.3-1-2 3.4 2 1.5a7 7 0 0 0 0 2.4l-2 1.5 2 3.4 2.3-1a7 7 0 0 0 2 1.2l.4 2.7h4l.4-2.7a7 7 0 0 0 2-1.2l2.3 1 2-3.4-2-1.5c.06-.4.1-.8.1-1.2z"/></svg>',
  palette: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M12 21a9 9 0 1 1 9-9c0 2.2-1.6 3.4-3.5 3.4h-1.7a1.9 1.9 0 0 0-1.4 3.2c.5.6.3 2.4-2.4 2.4z"/><circle cx="7.6" cy="11.8" r="1"/><circle cx="10.4" cy="7.6" r="1"/><circle cx="15.2" cy="7.9" r="1"/></svg>',
  plug: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M9 3v4M15 3v4"/><path d="M6.5 7h11v3.5a5.5 5.5 0 0 1-11 0V7z"/><path d="M12 16v5"/></svg>',
  more: '<svg viewBox="0 0 24 24" fill="currentColor" stroke="none"><circle cx="7.5" cy="7.5" r="1.7"/><circle cx="16.5" cy="7.5" r="1.7"/><circle cx="7.5" cy="16.5" r="1.7"/><circle cx="16.5" cy="16.5" r="1.7"/></svg>',
  fold: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="m14 6-6 6 6 6"/></svg>',
}

/* ---------------- 侧边栏菜单 ----------------
 * 分组标签 + 高亮「写作」CTA；type: ext 外链 / cta 写作按钮 / group 分组标题 / 普通项为菜单叶子。
 * 预留 children 字段：未来「设置」拆子页或市场子页时，给叶子加 children 即可在其下渲染二级菜单。
 * badge 为函数：渲染时实时取待审数（state 由各页面加载时写入）。 */
const MENU = [
  { type: 'ext', href: '/', label: '查看主页', icon: 'home' },
  { type: 'cta', id: 'editor', href: '#/editor/new', label: '写作', icon: 'edit' },
  { type: 'group', label: '数据' },
  { id: 'home', href: '#/', label: '概览', icon: 'home' },
  { id: 'stats', href: '#/stats', label: '统计', icon: 'chart' },
  { type: 'group', label: '内容' },
  { id: 'posts', href: '#/posts', label: '文章', icon: 'post' },
  { id: 'weibo', href: '#/weibo', label: '微博', icon: 'weibo' },
  { id: 'pages', href: '#/pages', label: '页面', icon: 'page' },
  { id: 'media', href: '#/media', label: '媒体', icon: 'image' },
  { type: 'group', label: '互动' },
  { id: 'comments', href: '#/comments', label: '评论', icon: 'comment', badge: () => state.pendingComments || 0 },
  { id: 'members', href: '#/members', label: '会员', icon: 'member' },
  { id: 'links', href: '#/links', label: '友链', icon: 'link', badge: () => state.pendingLinks || 0 },
  { type: 'group', label: '系统' },
  { id: 'trash', href: '#/trash', label: '回收站', icon: 'trash' },
  { id: 'appearance', href: '#/appearance', label: '皮肤', icon: 'palette' },
  { id: 'plugins', href: '#/plugins', label: '插件', icon: 'plug' },
  { id: 'settings', href: '#/settings', label: '设置', icon: 'gear' },
]

/* 移动端底部栏固定项（其余入口收进「更多」抽屉） */
const MOBILE_TAB_IDS = ['home', 'editor', 'posts', 'comments']

/* 导航防串页：并发导航时慢响应不得覆盖新页面。navigate 记录 pendingRoute（当前应渲染的路由），
 * shellView 渲染前比对——数据返回时路由已切走的旧视图直接放弃；navSeq 兜住「离开编辑器
 * 先保存再切页」这类 await 之间的切换 */
let navSeq = 0
let pendingRoute = null

/* ---------------- 登录 / 初始化 ---------------- */
function authView(mode) {
  pendingRoute = null // 登录态下不允许任何迟到的 shell 视图渲染
  const isSetup = mode === 'setup'
  // 演示站：登录页公示账号密码并自动填充（数据每 2 小时重置，随便玩）
  const demoBox = !isSetup && state.demo
    ? `<div class="auth-demo">🎓 这是<b>演示体验版</b>（非最新正式版，仅供测试体验），数据每 2 小时自动清空重置，随便看、随便改。<br>账号 <code>demo</code> · 密码 <code>demo1234</code>（已自动填好）</div>`
    : ''
  $app.innerHTML = `<div class="auth-wrap"><div class="auth-card">
    <div class="auth-logo">
      <img src="/favicon.svg" alt="">
      <h1>${isSetup ? '创建管理员' : '登录博客号后台'}</h1>
      <p>${isSetup ? '第一次使用，设置你的管理员账号' : esc(state.settings?.siteName || '')}</p>
    </div>
    ${demoBox}
    <form id="auth-form">
      <div class="auth-field"><label>用户名</label><input class="input" name="username" autocomplete="username" placeholder="2-24 位字母、数字、_ 或 -" required></div>
      <div class="auth-field"><label>密码</label><input class="input" type="password" name="password" autocomplete="${isSetup ? 'new-password' : 'current-password'}" placeholder="${isSetup ? '至少 8 位' : '输入密码'}" required></div>
      ${isSetup ? '<div class="auth-field"><label>昵称（可选）</label><input class="input" name="displayName" placeholder="显示在文章作者位"></div>' : ''}
      <button class="btn btn-primary auth-btn" type="submit">${isSetup ? '创建并进入' : '登 录'}</button>
      <div class="auth-err" id="auth-err"></div>
    </form>
    <p class="auth-tip">住在 Cloudflare 上的小博客 · D1 存储 · R2 图床</p>
  </div></div>`
  if (demoBox) {
    const form = document.getElementById('auth-form')
    form.username.value = 'demo'
    form.password.value = 'demo1234'
  }
  document.getElementById('auth-form').addEventListener('submit', async (e) => {
    e.preventDefault()
    const f = e.target
    const errEl = document.getElementById('auth-err')
    errEl.textContent = ''
    const btn = f.querySelector('button[type=submit]')
    btn.disabled = true
    try {
      const body = { username: f.username.value.trim(), password: f.password.value }
      if (isSetup) body.displayName = f.displayName.value.trim()
      const d = await api(isSetup ? '/auth/setup' : '/auth/login', { method: 'POST', body })
      state.user = d.user
      // 登录前拿不到设置，这里补拉一次，侧栏头像等依赖设置的 UI 立即生效
      if (!state.settings) {
        try {
          state.settings = (await api('/admin/settings')).settings
        } catch {
          /* ignore */
        }
      }
      toast(isSetup ? '账号创建成功 🎉' : '欢迎回来 👋')
      location.hash = '#/'
      navigate()
    } catch (err) {
      errEl.textContent = err.message
    } finally {
      btn.disabled = false
    }
  })
}

/* ---------------- 布局骨架 ---------------- */
function sideItemHtml(item, active) {
  const badge = item.badge ? item.badge() : 0
  return `<a class="side-item${active === item.id ? ' is-active' : ''}" href="${item.href}" title="${item.label}">${I[item.icon]}<span>${item.label}</span>${badge ? `<span class="side-badge">${badge}</span>` : ''}</a>`
}

/** 桌面侧栏与移动端「更多」抽屉共用同一份 MENU 渲染（分组标签 + 外链 + 写作 CTA） */
function sideNavHtml(active) {
  return MENU.map((m) => {
    if (m.type === 'group') return `<div class="side-group">${m.label}</div>`
    if (m.type === 'ext')
      return `<a class="side-item side-item-home" href="${m.href}" target="_blank" rel="noopener" title="${m.label}">${I[m.icon]}<span>${m.label}</span></a><div class="side-sep"></div>`
    if (m.type === 'cta') return `<a class="side-cta" href="${m.href}" title="${m.label}">${I[m.icon]}<span>${m.label}</span></a>`
    return sideItemHtml(m, active)
  }).join('')
}

async function shellView(active, contentHTML) {
  if (!state.user) return
  // 路由已切走（或已登出）时放弃本次渲染，防慢响应把旧页面盖回来
  if (active !== pendingRoute) return
  // 英文测试版（English 0.1）后台提醒：运行中常驻公示；异常回退时换红色警示条（机制见 src/i18n.ts）
  const s = state.settings || {}
  let editionBanner = ''
  if (s.edition === 'en') {
    editionBanner =
      s.editionEnStatus === 'fallback'
        ? `<div style="background:var(--warn,#b45309);color:#fff;font-size:13px;line-height:1.7;padding:9px 16px;">⚠️ <b>英文测试版出现异常，已自动回退中文版</b>（${s.editionEnAt ? new Date(Number(s.editionEnAt)).toLocaleString() + '：' : ''}${esc(s.editionEnError || '未知错误')}）。可在「设置 → 语言版本」重新开启。</div>`
        : `<div style="background:#1d4ed8;color:#fff;font-size:13px;line-height:1.7;padding:9px 16px;">🧪 <b>英文测试版 English 0.1 正在前台运行（仅供测试）</b>：前台界面为英文并显示测试版横幅，文章与微博正文保持原文；如出现异常会自动回退中文版。可在「设置 → 语言版本」关闭。</div>`
  }
  // 隐私加固浏览器（Safari 锁定模式等）访问 localStorage 即抛 SecurityError：偏好存取吞异常，降级默认值
  const prefGet = (k) => { try { return localStorage.getItem(k) } catch { return null } }
  const sideMini = prefGet('admin-side') === 'mini'
  // 移动端底部栏只放高频项，其余收进「更多」抽屉；不在栏内的待审数聚合成红点
  const barItems = MOBILE_TAB_IDS.map((id) => MENU.find((m) => m.id === id)).filter(Boolean)
  const moreDot = MENU.reduce((sum, m) => (m.badge && !MOBILE_TAB_IDS.includes(m.id) ? sum + m.badge() : sum), 0)
  $app.innerHTML = `<div class="shell${sideMini ? ' side-mini' : ''}">
    <aside class="sidebar">
      <div class="side-logo"><img src="/favicon.svg" alt=""><span>博客号</span>${state.demo ? '<span class="demo-badge" title="演示体验版：非最新正式版，数据每 2 小时重置">演示</span>' : ''}<button class="side-fold" id="btn-side-fold" title="${sideMini ? '展开侧栏' : '收起侧栏'}">${I.fold}</button></div>
      <nav class="side-nav">${sideNavHtml(active)}</nav>
      <nav class="tab-bar">
        ${barItems.map((m) => sideItemHtml(m, active)).join('')}
        <button class="side-item tab-more" id="btn-more" type="button">${I.more}<span>更多</span>${moreDot ? '<span class="tab-dot"></span>' : ''}</button>
      </nav>
      <div class="side-user">
        ${state.settings?.avatarUrl ? `<img class="side-user-avatar" src="${esc(state.settings.avatarUrl)}" alt="">` : `<span class="side-user-avatar">${esc((state.user.display_name || state.user.username).charAt(0).toUpperCase())}</span>`}
        <span class="side-user-name">${esc(state.user.display_name || state.user.username)}</span>
        <button class="side-logout" id="btn-logout">退出</button>
      </div>
    </aside>
    <main class="main">${editionBanner}${contentHTML}</main>
    <div class="sheet-mask" id="sheet-mask">
      <div class="side-sheet" role="dialog" aria-label="全部菜单">
        <div class="side-sheet-head"><span>全部菜单</span><button class="side-sheet-close" id="btn-sheet-close" type="button">✕</button></div>
        <nav class="side-sheet-nav">${sideNavHtml(active)}</nav>
      </div>
    </div>
  </div>`
  document.getElementById('btn-side-fold').addEventListener('click', (e) => {
    const mini = $app.querySelector('.shell').classList.toggle('side-mini')
    try { localStorage.setItem('admin-side', mini ? 'mini' : 'full') } catch { /* 锁定模式下不记住偏好 */ }
    e.currentTarget.title = mini ? '展开侧栏' : '收起侧栏'
  })
  document.getElementById('btn-logout').addEventListener('click', async () => {
    await api('/auth/logout', { method: 'POST' }).catch(() => {})
    state.user = null
    location.hash = '#/'
    boot()
  })
  // 「更多」抽屉：点遮罩/关闭按钮/任意菜单项都收起；打开时锁 body 滚动
  const mask = document.getElementById('sheet-mask')
  const closeSheet = () => {
    mask.classList.remove('is-open')
    document.body.classList.remove('no-scroll')
  }
  document.getElementById('btn-more').addEventListener('click', () => {
    mask.classList.add('is-open')
    document.body.classList.add('no-scroll')
  })
  document.getElementById('btn-sheet-close').addEventListener('click', closeSheet)
  mask.addEventListener('click', (e) => {
    if (e.target === mask) closeSheet()
  })
  mask.querySelectorAll('.side-sheet-nav a').forEach((a) => a.addEventListener('click', closeSheet))
}

/* ---------------- 概览 ---------------- */
async function viewHome() {
  let s
  try {
    s = await api('/admin/stats')
  } catch (e) {
    return handleApiErr(e)
  }
  state.pendingComments = s.pendingComments
  state.pendingLinks = s.pendingLinks
  const recent = s.recent
    .map(
      (r) => `<div class="recent-item">
        <a class="recent-title" href="#/editor/${r.id}">${esc(r.title)}</a>
        <span class="recent-meta">${r.views} 阅读 · ${fmtDateTime(r.published_at)}</span>
      </div>`
    )
    .join('')
  await shellView(
    'home',
    `<div class="page-head">
      <div><div class="page-title">概览</div><div class="page-sub">小院今天的情况</div></div>
      <a class="btn btn-primary" href="#/editor/new">✍️ 写文章</a>
    </div>
    <div class="stat-grid">
      <div class="stat-card"><div class="stat-label">已发布文章</div><div class="stat-value">${s.posts}</div></div>
      <div class="stat-card"><div class="stat-label">总阅读</div><div class="stat-value">${s.views}</div></div>
      <div class="stat-card"><div class="stat-label">收到的赞</div><div class="stat-value">${s.likes}</div></div>
      <div class="stat-card"><div class="stat-label">待审评论</div><div class="stat-value">${s.pendingComments}<small>${s.drafts} 篇草稿</small></div></div>
    </div>
    <div class="panel">
      <div class="panel-head"><span>最近发布</span><a class="btn btn-ghost btn-sm" href="#/posts">全部文章 →</a></div>
      <div class="panel-body">${recent || '<div class="empty-box">还没有发布过文章，点右上角开始写作吧。</div>'}</div>
    </div>
    <div class="panel">
      <div class="panel-head"><span>媒体库</span></div>
      <div class="panel-body" style="display:flex;gap:24px;align-items:center;">
        <div><div class="stat-value" style="font-size:20px;">${s.uploads.count}<small>个文件</small></div></div>
        <div style="color:var(--sub);font-size:13px;">占用 ${fmtSize(s.uploads.bytes)} · 存于 R2 图床，全球加速</div>
      </div>
    </div>`
  )
}

/* ---------------- 访客统计（#/stats，数据来自 /api/admin/visits，见 src/stats.ts） ---------------- */
const DEV_NAME = { mobile: '手机', tablet: '平板', desktop: '电脑' }
const BR_NAME = { wechat: '微信', chrome: 'Chrome', edge: 'Edge', firefox: 'Firefox', safari: 'Safari', other: '其他' }
const CC_NAME = {
  CN: '中国大陆', HK: '中国香港', MO: '中国澳门', TW: '中国台湾', US: '美国', JP: '日本', KR: '韩国',
  SG: '新加坡', MY: '马来西亚', TH: '泰国', VN: '越南', GB: '英国', DE: '德国', FR: '法国', CA: '加拿大',
  AU: '澳大利亚', RU: '俄罗斯', IN: '印度', NL: '荷兰', BR: '巴西',
}
const STATS_DAYS = [7, 30, 90]

/** 横条排行（来源 / 设备 / 浏览器 / 国家） */
function hbarRows(items, nameFn) {
  if (!items.length) return '<div class="empty-box">暂无数据</div>'
  const max = Math.max(...items.map((x) => x.pv), 1)
  return items
    .map(
      (x) => `<div class="hbar-row">
        <span class="hbar-name" title="${esc(nameFn(x))}">${esc(nameFn(x))}</span>
        <span class="hbar-track"><span class="hbar-fill" style="width:${Math.max(2, Math.round((x.pv / max) * 100))}%"></span></span>
        <span class="hbar-num">${x.pv}</span>
      </div>`
    )
    .join('')
}

/** 每日趋势：PV 柱 + UV 折线，自绘 SVG（零依赖），悬停整列出数值 */
function trendChart(series) {
  const W = 720, H = 210, padL = 40, padR = 8, padT = 12, padB = 24
  const n = series.length
  if (!n) return ''
  const iw = W - padL - padR
  const ih = H - padT - padB
  const maxV = Math.max(...series.map((d) => Math.max(d.pv, d.uv)), 5)
  const step = iw / n
  const barW = Math.max(1, Math.min(step * 0.6, 24))
  const tickEvery = Math.ceil(n / 6)
  let marks = ''
  const pts = []
  series.forEach((d, i) => {
    const x = padL + i * step
    if (d.pv > 0) {
      const h = Math.max(1, (d.pv / maxV) * ih)
      marks += `<rect x="${(x + (step - barW) / 2).toFixed(1)}" y="${(padT + ih - h).toFixed(1)}" width="${barW.toFixed(1)}" height="${h.toFixed(1)}" rx="1.5" fill="var(--accent)" opacity="0.85"/>`
    }
    pts.push(`${(x + step / 2).toFixed(1)},${(padT + ih - (d.uv / maxV) * ih).toFixed(1)}`)
    if (i % tickEvery === 0 || i === n - 1) {
      // 最后一个刻度右对齐贴边，放大字号后中锚文字会溢出 viewBox 被裁
      if (i === n - 1) {
        marks += `<text x="${W - padR}" y="${H - 6}" text-anchor="end" class="chart-tick">${esc(d.day.slice(5))}</text>`
      } else {
        marks += `<text x="${(x + step / 2).toFixed(1)}" y="${H - 6}" text-anchor="middle" class="chart-tick">${esc(d.day.slice(5))}</text>`
      }
    }
  })
  let grid = ''
  for (let g = 0; g <= 3; g++) {
    const y = padT + (ih * g) / 3
    grid += `<line x1="${padL}" y1="${y.toFixed(1)}" x2="${W - padR}" y2="${y.toFixed(1)}" stroke="var(--line)" stroke-width="1"/><text x="${padL - 6}" y="${(y + 4).toFixed(1)}" text-anchor="end" class="chart-tick">${Math.round((maxV * (3 - g)) / 3)}</text>`
  }
  const hovers = series
    .map((d, i) => {
      const x = padL + i * step
      return `<rect x="${x.toFixed(1)}" y="${padT}" width="${step.toFixed(1)}" height="${ih}" fill="transparent"><title>${d.day}：浏览 ${d.pv}，访客 ${d.uv}</title></rect>`
    })
    .join('')
  return `<svg class="chart-svg" viewBox="0 0 ${W} ${H}" role="img" aria-label="每日浏览趋势">${grid}${marks}<polyline points="${pts.join(' ')}" fill="none" stroke="var(--sub)" stroke-width="1.5" opacity="0.9"/>${hovers}</svg>`
}

/** 今日 24 小时分布（北京时间） */
function hourChart(hourly) {
  const W = 720, H = 150, padL = 40, padR = 8, padT = 10, padB = 22
  const iw = W - padL - padR
  const ih = H - padT - padB
  const maxV = Math.max(...hourly.map((x) => x.pv), 5)
  const step = iw / 24
  const barW = Math.max(2, step * 0.62)
  let marks = ''
  hourly.forEach((d) => {
    const x = padL + d.h * step
    if (d.pv > 0) {
      const h = Math.max(1, (d.pv / maxV) * ih)
      marks += `<rect x="${(x + (step - barW) / 2).toFixed(1)}" y="${(padT + ih - h).toFixed(1)}" width="${barW.toFixed(1)}" height="${h.toFixed(1)}" rx="1.5" fill="var(--accent)" opacity="0.85"/>`
    }
    marks += `<rect x="${x.toFixed(1)}" y="${padT}" width="${step.toFixed(1)}" height="${ih}" fill="transparent"><title>${d.h}:00–${d.h + 1}:00：${d.pv} 次浏览</title></rect>`
  })
  for (const hh of [0, 6, 12, 18]) {
    marks += `<text x="${(padL + hh * step + step / 2).toFixed(1)}" y="${H - 6}" text-anchor="middle" class="chart-tick">${hh}时</text>`
  }
  let grid = ''
  for (let g = 0; g <= 2; g++) {
    const y = padT + (ih * g) / 2
    grid += `<line x1="${padL}" y1="${y.toFixed(1)}" x2="${W - padR}" y2="${y.toFixed(1)}" stroke="var(--line)" stroke-width="1"/><text x="${padL - 6}" y="${(y + 4).toFixed(1)}" text-anchor="end" class="chart-tick">${Math.round((maxV * (2 - g)) / 2)}</text>`
  }
  return `<svg class="chart-svg" viewBox="0 0 ${W} ${H}" role="img" aria-label="今日小时分布">${grid}${marks}</svg>`
}

async function viewStats() {
  const q = new URLSearchParams((location.hash.split('?')[1] || ''))
  const days = STATS_DAYS.includes(Number(q.get('days'))) ? Number(q.get('days')) : 30
  let s
  try {
    s = await api(`/admin/visits?days=${days}`)
  } catch (e) {
    return handleApiErr(e)
  }
  const tabs = STATS_DAYS.map(
    (d) => `<button class="tab${d === days ? ' is-active' : ''}" data-days="${d}">${d} 天</button>`
  ).join('')
  const hasData = s.pv > 0 || s.uv > 0
  const pages = s.topPages
    .map((p) => {
      // 归一化防协议相对 URL（//evil.com 是跨站链接）：path 是访客打点上报的公开字段，
      // 服务端已拒 // 开头，这里对历史脏数据兜底强制站内路径
      const href = '/' + String(p.path || '').replace(/^\/+/, '')
      return `<a class="stat-row" href="${esc(href)}" target="_blank" rel="noopener">
        <span class="stat-row-main"><span class="stat-row-title">${esc(p.title || p.path)}</span><span class="stat-row-sub">${esc(p.path)}</span></span>
        <span class="stat-row-num">${p.pv}<small>浏览 · ${p.uv} 人</small></span>
      </a>`
    })
    .join('')
  const trendBody = hasData
    ? `<div class="chart-legend"><span><i class="lg-bar"></i>浏览量</span><span><i class="lg-line"></i>访客数</span></div>${trendChart(s.series)}`
    : '<div class="empty-box">还没有访客数据。功能上线后有人访问就会出现，也可以先自己逛一逛。</div>'
  await shellView(
    'stats',
    `<div class="page-head">
      <div><div class="page-title">统计</div><div class="page-sub">访客都在看什么、从哪里来（数据来自前台页面访问，后台自身不计入）</div></div>
    </div>
    <div class="stat-grid">
      <div class="stat-card"><div class="stat-label">浏览量（${days} 天）</div><div class="stat-value">${s.pv}</div></div>
      <div class="stat-card"><div class="stat-label">访客数（${days} 天）</div><div class="stat-value">${s.uv}</div></div>
      <div class="stat-card"><div class="stat-label">今日浏览</div><div class="stat-value">${s.todayPv}</div></div>
      <div class="stat-card"><div class="stat-label">今日访客</div><div class="stat-value">${s.todayUv}</div></div>
    </div>
    <div class="panel">
      <div class="panel-head"><span>访问趋势</span><div class="tabs">${tabs}</div></div>
      <div class="panel-body">${trendBody}</div>
    </div>
    <div class="panel">
      <div class="panel-head"><span>今日小时分布</span><span class="panel-head-sub">北京时间</span></div>
      <div class="panel-body">${s.todayPv ? hourChart(s.hourly) : '<div class="empty-box">今天还没有访问</div>'}</div>
    </div>
    <div class="panel">
      <div class="panel-head"><span>受欢迎的页面</span><span class="panel-head-sub">近 ${days} 天 · 点标题可打开页面</span></div>
      <div class="panel-body">${pages || '<div class="empty-box">暂无数据</div>'}</div>
    </div>
    <div class="stats-duo">
      <div class="panel">
        <div class="panel-head"><span>从哪里来</span><span class="panel-head-sub">站外来源域名</span></div>
        <div class="panel-body">${hbarRows(s.topRefs, (x) => x.ref)}</div>
      </div>
      <div class="panel">
        <div class="panel-head"><span>访客设备</span></div>
        <div class="panel-body">${hbarRows(s.devices, (x) => DEV_NAME[x.name] || x.name || '未知')}</div>
      </div>
    </div>
    <div class="stats-duo">
      <div class="panel">
        <div class="panel-head"><span>浏览器</span></div>
        <div class="panel-body">${hbarRows(s.browsers, (x) => BR_NAME[x.name] || x.name || '未知')}</div>
      </div>
      <div class="panel">
        <div class="panel-head"><span>国家 / 地区</span></div>
        <div class="panel-body">${hbarRows(s.countries, (x) => CC_NAME[x.name] || x.name)}</div>
      </div>
    </div>`
  )
  $app.querySelectorAll('.tab[data-days]').forEach((t) =>
    t.addEventListener('click', () => {
      location.hash = `#/stats?days=${t.dataset.days}`
    })
  )
}

/* ---------------- 文章管理 ---------------- */
async function viewPosts() {
  const hash = location.hash
  const q = new URLSearchParams(hash.split('?')[1] || '')
  // 文章页第二页签：分类与标签（原独立「分类」页并入，见 viewPostTaxonomy）
  if (q.get('view') === 'cats') return viewPostTaxonomy()
  const status = q.get('status') || 'all'
  const page = parseInt(q.get('page') || '1', 10)
  const kw = q.get('q') || ''

  let d
  try {
    d = await api(`/admin/posts?status=${status}&page=${page}&q=${encodeURIComponent(kw)}`)
  } catch (e) {
    return handleApiErr(e)
  }

  const rows = d.items
    .map((p) => {
      const chip =
        p.status === 'published'
          ? '<span class="chip chip-green">已发布</span>'
          : p.status === 'scheduled'
            ? `<span class="chip chip-warn">定时 ${fmtScheduleShort(p.publish_at)}</span>`
            : '<span class="chip chip-gray">草稿</span>'
      return `<div class="post-row" data-id="${p.id}">
      <div class="post-main">
        <div class="post-title"><a href="#/editor/${p.id}">${esc(p.title)}</a>
          ${chip}
          ${p.pinned ? '<span class="chip chip-warn">置顶</span>' : ''}
          ${p.hasPassword ? '<span class="chip chip-gray">🔒 加密</span>' : ''}
        </div>
        <div class="post-meta">
          <span>${p.slug}</span><span>·</span><span>${p.views} 阅读</span><span>·</span><span>${p.likes} 赞</span>
          <span>·</span><span>${fmtDateTime(p.published_at || p.updated_at)}</span>
          ${p.categoryName ? `<span>·</span><span>${esc(p.categoryName)}</span>` : ''}
          ${p.tagList && p.tagList.length ? `<span>·</span><span>${p.tagList.map(esc).join(' / ')}</span>` : ''}
        </div>
      </div>
      <div class="post-ops">
        <a class="btn btn-ghost btn-sm" href="/post/${esc(p.slug)}" target="_blank">查看</a>
        <a class="btn btn-ghost btn-sm" href="#/editor/${p.id}">编辑</a>
        <button class="btn btn-ghost btn-sm" data-act="pin">${p.pinned ? '取消置顶' : '置顶'}</button>
        <button class="btn btn-ghost btn-sm" data-act="toggle">${p.status === 'published' ? '下架' : '发布'}</button>
        <button class="btn btn-ghost btn-sm btn-danger" data-act="del">删除</button>
      </div>
    </div>`
    })
    .join('')

  await shellView(
    'posts',
    `<div class="page-head">
      <div><div class="page-title">文章</div><div class="page-sub">共 ${d.total} 篇</div></div>
      <a class="btn btn-primary" href="#/editor/new">✍️ 写文章</a>
    </div>
    <div class="toolbar">
      <div class="tabs">
        <button class="tab is-active" data-vtab="list" type="button">列表</button>
        <button class="tab" data-vtab="cats" type="button">分类标签</button>
      </div>
      <div class="tabs">
        ${['all', 'published', 'scheduled', 'draft']
          .map(
            (t) =>
              `<button class="tab${t === status ? ' is-active' : ''}" data-tab="${t}">${{ all: '全部', published: '已发布', scheduled: '定时', draft: '草稿' }[t]}</button>`
          )
          .join('')}
      </div>
      <input class="input" id="search-input" placeholder="搜索标题 / 正文…" value="${esc(kw)}">
    </div>
    <div class="panel">${rows || '<div class="empty-box">没有找到文章</div>'}</div>
    ${d.totalPages > 1 ? `<div class="pager-admin"><button class="btn btn-sm" id="pg-prev" ${page <= 1 ? 'disabled' : ''}>上一页</button><span>${d.page} / ${d.totalPages}</span><button class="btn btn-sm" id="pg-next" ${page >= d.totalPages ? 'disabled' : ''}>下一页</button></div>` : ''}`
  )

  const nav = (patch) => {
    const p = new URLSearchParams({ status, page: String(page), ...(kw ? { q: kw } : {}), ...patch })
    location.hash = '#/posts?' + p.toString()
  }
  $app.querySelectorAll('[data-tab]').forEach((b) => b.addEventListener('click', () => nav({ status: b.dataset.tab, page: 1 })))
  $app.querySelectorAll('[data-vtab="cats"]').forEach((b) =>
    b.addEventListener('click', () => (location.hash = '#/posts?view=cats'))
  )
  const searchEl = document.getElementById('search-input')
  searchEl.addEventListener('focus', () => (searchFocused = true))
  searchEl.addEventListener('blur', () => (searchFocused = false))
  searchEl.addEventListener('input', () => {
    if (searchEl.isComposing) return // 中文输入法组词中的 input 不触发搜索（组词结束会有一次 isComposing=false 的 input）
    clearTimeout(postsSearchTimer)
    postsSearchTimer = setTimeout(() => nav({ q: searchEl.value.trim(), page: 1 }), 400)
  })
  // 上一轮渲染时搜索框持有焦点（连续输入触发了重渲染）：恢复焦点并把光标放到末尾
  if (searchFocused && kw) {
    searchEl.focus()
    searchEl.setSelectionRange(kw.length, kw.length)
  }
  const prev = document.getElementById('pg-prev')
  const next = document.getElementById('pg-next')
  if (prev) prev.addEventListener('click', () => nav({ page: page - 1 }))
  if (next) next.addEventListener('click', () => nav({ page: page + 1 }))

  $app.querySelectorAll('.post-row').forEach((row) => {
    const id = row.dataset.id
    const post = d.items.find((p) => String(p.id) === id)
    row.querySelector('[data-act=pin]').addEventListener('click', async () => {
      try {
        await api(`/admin/posts/${id}/pin`, { method: 'POST', body: { pinned: !post.pinned } })
        toast(post.pinned ? '已取消置顶' : '已置顶')
        navigate() // 操作后重渲染当前路由（经 navigate 守卫，用户已切页时不拽回）
      } catch (e) {
        toast(e.message, true)
      }
    })
    row.querySelector('[data-act=toggle]').addEventListener('click', async () => {
      const publish = post.status !== 'published'
      try {
        // 只发语义字段（status）：列表项没有 content/categoryId，整包 {...post} 会被服务端
        // 当成「清空正文/标签/分类」的全量更新（服务端缺键即保留，这里配合只发状态）
        await api(`/admin/posts/${id}`, {
          method: 'PUT',
          body: { status: publish ? 'published' : 'draft' },
        })
        toast(publish ? '已发布 🎉' : '已转为草稿')
        navigate() // 操作后重渲染当前路由（经 navigate 守卫，用户已切页时不拽回）
      } catch (e) {
        toast(e.message, true)
      }
    })
    row.querySelector('[data-act=del]').addEventListener('click', async () => {
      if (!(await confirmBox(`确定删除《${post.title}》？将移入回收站，30 天内可恢复。`))) return
      try {
        await api(`/admin/posts/${id}`, { method: 'DELETE' })
        toast('已移入回收站')
        navigate() // 操作后重渲染当前路由（经 navigate 守卫，用户已切页时不拽回）
      } catch (e) {
        toast(e.message, true)
      }
    })
  })
}

/* ---------------- 微博（随手记） ---------------- */
const WB_MAX_IMAGES = 9
const WB_MAX_CHARS = 5000

async function viewWeibo() {
  const q = new URLSearchParams(location.hash.split('?')[1] || '')
  const page = parseInt(q.get('page') || '1', 10)
  let d
  try {
    d = await api(`/admin/weibo?page=${page}`)
  } catch (e) {
    return handleApiErr(e)
  }

  // 编辑态跨分页残留防护：正在编辑的条目不在本页（说明翻页了），
  // 顶部发布器还停在编辑旧条目的状态，此时点保存会把旧内容写回去——直接清掉
  if (wbEditing && !d.items.some((x) => x.id === wbEditing.id)) {
    wbEditing = null
    toast('所编辑的微博不在本页，已切回新建')
  }
  const images = wbEditing ? [...wbEditing.images] : []
  const rows = d.items
    .map(
      (w) => `<div class="wb-row" data-id="${w.id}">
      <div class="wb-row-main">
        <div class="wb-row-text">${w.content ? esc(w.content) : '<span class="dim">（无文字）</span>'}</div>
        ${w.imageList.length ? `<div class="wb-row-thumbs">${w.imageList.map((u) => `<img src="${esc(u)}" loading="lazy" alt="">`).join('')}</div>` : ''}
        <div class="wb-row-meta">
          ${w.status === 'published' ? '<span class="chip chip-green">已发布</span>' : '<span class="chip chip-gray">草稿</span>'}
          ${w.pinned ? '<span class="chip chip-warn">置顶</span>' : ''}
          ${w.imageList.length ? `<span>${w.imageList.length} 图</span><span>·</span>` : ''}
          ${(w.topicList || []).length
            ? `<span class="wb-row-topics">${w.topicList.map((t) => `<a href="/weibo?topic=${encodeURIComponent(t)}" target="_blank">#${esc(t)}</a>`).join('')}</span><span>·</span>`
            : ''}
          <span>${w.likes || 0} 赞 · ${w.commentCount || 0} 评</span>
          <span>·</span>
          <span>${fmtDateTime(w.published_at || w.updated_at)}</span>
        </div>
      </div>
      <div class="post-ops">
        <a class="btn btn-ghost btn-sm" href="/weibo" target="_blank">查看</a>
        <button class="btn btn-ghost btn-sm" data-act="edit">编辑</button>
        ${w.status === 'published' ? `<button class="btn btn-ghost btn-sm" data-act="pin">${w.pinned ? '取消置顶' : '置顶'}</button>` : ''}
        <button class="btn btn-ghost btn-sm" data-act="toggle">${w.status === 'published' ? '下架' : '发布'}</button>
        <button class="btn btn-ghost btn-sm btn-danger" data-act="del">删除</button>
      </div>
    </div>`
    )
    .join('')

  await shellView(
    'weibo',
    `<div class="page-head"><div><div class="page-title">微博</div><div class="page-sub">随手记：短文字 + 图片，不用起标题</div></div></div>
    <div class="panel wb-composer">
      <textarea class="textarea wb-input" id="wb-content" maxlength="${WB_MAX_CHARS}" placeholder="有什么新鲜事？">${esc(wbEditing?.content || '')}</textarea>
      <div class="wb-hint">支持 ⌘/Ctrl+V 粘贴截图、把图片拖进来，或点下方「加图」；正文里写 #话题 即可归类并高亮，如 #晚餐日记</div>
      <div class="wb-imgs" id="wb-imgs"></div>
      <div class="wb-composer-foot">
        <button class="btn btn-ghost btn-sm" id="wb-add-img" type="button">${I.image} 加图（${images.length}/${WB_MAX_IMAGES}）</button>
        <button class="btn btn-ghost btn-sm" id="wb-emoji" type="button">😊 表情</button>
        <span class="wb-count" id="wb-count">${(wbEditing?.content || '').length} / ${WB_MAX_CHARS}</span>
        <span class="spacer"></span>
        ${wbEditing
          ? '<button class="btn btn-sm" id="wb-cancel" type="button">取消</button><button class="btn btn-primary btn-sm" id="wb-save" type="button">保存修改</button>'
          : '<button class="btn btn-sm" id="wb-draft" type="button">存草稿</button><button class="btn btn-primary btn-sm" id="wb-publish" type="button">发布</button>'}
      </div>
    </div>
    <div class="panel">${rows || '<div class="empty-box">还没发过微博，在上面写一条吧</div>'}</div>
    ${d.totalPages > 1 ? `<div class="pager-admin"><button class="btn btn-sm" id="pg-prev" ${page <= 1 ? 'disabled' : ''}>上一页</button><span>${d.page} / ${d.totalPages}</span><button class="btn btn-sm" id="pg-next" ${page >= d.totalPages ? 'disabled' : ''}>下一页</button></div>` : ''}`
  )

  const contentEl = document.getElementById('wb-content')
  const addImgBtn = document.getElementById('wb-add-img')
  const countEl = document.getElementById('wb-count')
  const composer = $app.querySelector('.wb-composer')

  // 微信表情面板：点击插入文本码（[微笑]）到发布框光标处，可连续选；渲染层才把码转成图
  document.getElementById('wb-emoji')?.addEventListener('click', async () => {
    await loadEmoji()
    const m = modal(
      `<div class="modal-head"><span>微信表情</span><button class="modal-close" data-close>×</button></div>
      <div class="modal-body wxq-modal-body">${emojiGridHtml()}</div>`
    )
    m.mask.addEventListener('click', (e) => {
      const cell = e.target.closest('[data-wxq]')
      if (!cell) return
      insertToken(contentEl, `[${cell.getAttribute('data-wxq')}]`)
    })
  })

  function renderImgs() {
    const box = document.getElementById('wb-imgs')
    box.innerHTML = images
      .map(
        (u, i) => `<span class="wb-tile"><img src="${esc(u)}" alt=""><button class="wb-tile-del" data-i="${i}" type="button" title="移除">×</button></span>`
      )
      .join('')
    box.querySelectorAll('.wb-tile-del').forEach((b) =>
      b.addEventListener('click', () => {
        images.splice(Number(b.dataset.i), 1)
        renderImgs()
      })
    )
    addImgBtn.innerHTML = `${I.image} 加图（${images.length}/${WB_MAX_IMAGES}）`
  }

  /** 加图统一入口：文件选择 / 粘贴 / 拖拽共用，自动过滤非图片并尊重 9 图上限 */
  let wbUploading = 0 // 在途上传计数：发布/存草稿前必须归零（同前台发布器 cpUploading 口径），防半截图发出
  async function addImageFiles(fileList) {
    const all = [...(fileList || [])]
    const imgs = all.filter((f) => /^image\//.test(f.type))
    if (!imgs.length) {
      if (all.length) toast('只支持 JPG / PNG / WebP / GIF 图片', true)
      return
    }
    const room = WB_MAX_IMAGES - images.length
    if (room <= 0) return toast(`最多 ${WB_MAX_IMAGES} 张图`, true)
    if (imgs.length > room) toast(`最多 ${WB_MAX_IMAGES} 张图，多出的 ${imgs.length - room} 张已忽略`, true)
    const label = addImgBtn.textContent
    for (const f of imgs.slice(0, room)) {
      wbUploading++
      try {
        addImgBtn.textContent = `上传中 ${f.name.slice(0, 12)}…`
        const r = await uploadFile(await compressImage(f), null)
        images.push(r.url)
        renderImgs()
      } catch (e) {
        toast(e.message, true)
      } finally {
        wbUploading--
      }
    }
    addImgBtn.textContent = label
    renderImgs()
  }

  function pickImages() {
    pickFiles('image/jpeg,image/png,image/webp,image/gif', true, (files) => addImageFiles(files))
  }

  // 粘贴图片：光标在发布器内 ⌘/Ctrl+V 即上传（纯文本粘贴不受影响）
  composer.addEventListener('paste', async (e) => {
    const files = [...(e.clipboardData?.files || [])]
    if (!files.length) return
    e.preventDefault()
    await addImageFiles(files)
  })

  // 拖拽图片到发布器（拖文本进输入框仍是默认行为）
  composer.addEventListener('dragover', (e) => {
    if (![...(e.dataTransfer?.types || [])].includes('Files')) return
    e.preventDefault()
    composer.classList.add('is-dragover')
  })
  composer.addEventListener('dragleave', () => composer.classList.remove('is-dragover'))
  composer.addEventListener('drop', async (e) => {
    const files = [...(e.dataTransfer?.files || [])]
    if (!files.length) return
    e.preventDefault()
    composer.classList.remove('is-dragover')
    await addImageFiles(files)
  })

  async function saveWeibo(status) {
    const content = contentEl.value.trim()
    if (!content && !images.length) return toast('写点什么，或者配张图吧', true)
    // 二道防线：上传未完就点发布，微博会以缺图状态发出（图片还在闭包里推）
    if (wbUploading > 0) return toast('还有图片在上传中，稍等一下', true)
    // 请求期间禁用全部按钮：连击会重复发微博
    const btns = ['wb-save', 'wb-publish', 'wb-draft'].map((id) => document.getElementById(id)).filter(Boolean)
    btns.forEach((b) => (b.disabled = true))
    try {
      if (wbEditing) {
        await api(`/admin/weibo/${wbEditing.id}`, { method: 'PUT', body: { content, images, status: wbEditing.status } })
        wbEditing = null
        toast('已保存')
      } else {
        await api('/admin/weibo', { method: 'POST', body: { content, images, status } })
        toast(status === 'published' ? '已发布 🎉' : '草稿已保存')
      }
      navigate() // 操作后重渲染当前路由（经 navigate 守卫，用户已切页时不拽回）
    } catch (e) {
      toast(e.message, true)
    } finally {
      // 成功时页面已重渲染（按钮是旧节点）；失败时恢复可点
      btns.forEach((b) => (b.disabled = false))
    }
  }

  renderImgs()
  if (wbEditing) window.scrollTo({ top: 0 })
  contentEl.addEventListener('input', () => (countEl.textContent = `${contentEl.value.length} / ${WB_MAX_CHARS}`))
  addImgBtn.addEventListener('click', pickImages)
  document.getElementById('wb-save')?.addEventListener('click', () => saveWeibo(wbEditing?.status || 'draft'))
  document.getElementById('wb-publish')?.addEventListener('click', () => saveWeibo('published'))
  document.getElementById('wb-draft')?.addEventListener('click', () => saveWeibo('draft'))
  document.getElementById('wb-cancel')?.addEventListener('click', () => {
    wbEditing = null
    navigate() // 操作后重渲染当前路由（经 navigate 守卫，用户已切页时不拽回）
  })

  const prev = document.getElementById('pg-prev')
  const next = document.getElementById('pg-next')
  if (prev) prev.addEventListener('click', () => (location.hash = `#/weibo?page=${page - 1}`))
  if (next) next.addEventListener('click', () => (location.hash = `#/weibo?page=${page + 1}`))

  $app.querySelectorAll('.wb-row').forEach((row) => {
    const id = Number(row.dataset.id)
    const w = d.items.find((x) => String(x.id) === String(id))
    row.querySelector('[data-act=edit]').addEventListener('click', () => {
      wbEditing = { id: w.id, content: w.content, images: [...w.imageList], status: w.status }
      navigate() // 操作后重渲染当前路由（经 navigate 守卫，用户已切页时不拽回）
    })
    row.querySelector('[data-act=pin]')?.addEventListener('click', async () => {
      try {
        await api(`/admin/weibo/${id}/pin`, { method: 'POST', body: { pinned: !w.pinned } })
        toast(w.pinned ? '已取消置顶' : '已置顶，将显示在微博页最前')
        navigate() // 操作后重渲染当前路由（经 navigate 守卫，用户已切页时不拽回）
      } catch (e) {
        toast(e.message, true)
      }
    })
    row.querySelector('[data-act=toggle]').addEventListener('click', async () => {
      const publish = w.status !== 'published'
      try {
        await api(`/admin/weibo/${id}`, { method: 'PUT', body: { content: w.content, images: w.imageList, status: publish ? 'published' : 'draft' } })
        toast(publish ? '已发布 🎉' : '已转为草稿')
        navigate() // 操作后重渲染当前路由（经 navigate 守卫，用户已切页时不拽回）
      } catch (e) {
        toast(e.message, true)
      }
    })
    row.querySelector('[data-act=del]').addEventListener('click', async () => {
      if (!(await confirmBox('确定删除这条微博？将移入回收站，30 天内可恢复。'))) return
      try {
        await api(`/admin/weibo/${id}`, { method: 'DELETE' })
        toast('已移入回收站')
        navigate() // 操作后重渲染当前路由（经 navigate 守卫，用户已切页时不拽回）
      } catch (e) {
        toast(e.message, true)
      }
    })
  })
}

/* ---------------- 友情链接 ---------------- */

/** 友链图标预览：有图标用图，没有用站名首字 */
function flIconHtml(icon, name) {
  if (icon) return `<span class="fl-ico"><img src="${esc(icon)}" alt=""></span>`
  const ch = (name || '链').trim().charAt(0) || '链'
  return `<span class="fl-ico fl-ico-letter" aria-hidden="true">${esc(ch)}</span>`
}

async function viewLinks() {
  const q = new URLSearchParams(location.hash.split('?')[1] || '')
  const status = q.get('status') === 'pending' ? 'pending' : 'approved'
  let d
  try {
    d = await api(`/admin/links?status=${status}`)
  } catch (e) {
    return handleApiErr(e)
  }
  state.pendingLinks = d.pending

  const rows = d.items
    .map(
      (l) => `<div class="fl-row" data-id="${l.id}">
      ${flIconHtml(l.icon, l.name)}
      <div class="fl-main">
        <div class="fl-row-name"><a href="${esc(l.url)}" target="_blank" rel="noopener">${esc(l.name)}</a>
          ${l.source === 'user' ? '<span class="chip chip-gray">访客申请</span>' : ''}
          ${status === 'pending' ? '<span class="chip chip-warn">待审核</span>' : ''}
        </div>
        <div class="fl-row-url">${esc(l.url)}</div>
        ${l.description ? `<div class="fl-row-desc">${esc(l.description)}</div>` : ''}
      </div>
      <div class="post-ops">
        ${status === 'approved'
          ? `<button class="btn btn-ghost btn-sm" data-act="up" title="上移">↑</button>
        <button class="btn btn-ghost btn-sm" data-act="down" title="下移">↓</button>
        <button class="btn btn-ghost btn-sm" data-act="icon" title="自动获取网站图标">图标</button>
        <button class="btn btn-ghost btn-sm" data-act="hide">隐藏</button>`
          : `<button class="btn btn-sm btn-primary" data-act="approve">通过</button>`}
        <button class="btn btn-ghost btn-sm" data-act="edit">编辑</button>
        <button class="btn btn-ghost btn-sm btn-danger" data-act="del">删除</button>
      </div>
    </div>`
    )
    .join('')

  await shellView(
    'links',
    `<div class="page-head">
      <div><div class="page-title">友链</div><div class="page-sub">朋友站点互相推荐，展示在前台「友情链接」页</div></div>
      <a class="btn" href="/links" target="_blank">查看页面</a>
    </div>
    <div class="toolbar">
      <div class="tabs">
        ${['approved', 'pending']
          .map((t) => `<button class="tab${t === status ? ' is-active' : ''}" data-tab="${t}">${{ approved: '已收录', pending: '待审核' }[t]}</button>`)
          .join('')}
      </div>
      <button class="btn btn-primary" id="fl-add" style="margin-left:auto;">添加友链</button>
    </div>
    <div class="panel">${rows || (status === 'pending' ? '<div class="empty-box">没有待审核的申请</div>' : '<div class="empty-box">还没有友链，点右上角「添加友链」</div>')}</div>`
  )

  $app.querySelectorAll('[data-tab]').forEach((b) =>
    b.addEventListener('click', () => (location.hash = `#/links?status=${b.dataset.tab}`))
  )
  document.getElementById('fl-add').addEventListener('click', () => flModal(null))

  let flMoving = false
  async function flMove(id, dir) {
    // reorder 非幂等：请求期间连点会挪两格（全站写操作防连击约定）
    if (flMoving) return
    flMoving = true
    try {
      await api('/admin/links/reorder', { method: 'POST', body: { id, dir } })
      navigate() // 操作后重渲染当前路由（经 navigate 守卫，用户已切页时不拽回）
    } catch (e) {
      toast(e.message, true)
    } finally {
      flMoving = false
    }
  }

  $app.querySelectorAll('.fl-row').forEach((row) => {
    const id = Number(row.dataset.id)
    const link = d.items.find((x) => x.id === id)
    row.querySelector('[data-act=edit]')?.addEventListener('click', () => flModal(link))
    row.querySelector('[data-act=approve]')?.addEventListener('click', async () => {
      try {
        await api(`/admin/links/${id}/approve`, { method: 'POST' })
        toast(link.icon ? '已收录 🎉' : '已收录 🎉 正在后台获取图标')
        navigate() // 操作后重渲染当前路由（经 navigate 守卫，用户已切页时不拽回）
      } catch (e) {
        toast(e.message, true)
      }
    })
    row.querySelector('[data-act=icon]')?.addEventListener('click', async (e) => {
      const btn = e.currentTarget
      btn.textContent = '获取中…'
      try {
        await api(`/admin/links/${id}/refresh-icon`, { method: 'POST' })
        toast('图标已更新')
        navigate() // 操作后重渲染当前路由（经 navigate 守卫，用户已切页时不拽回）
      } catch (err) {
        toast(err.message, true)
        btn.textContent = '图标'
      }
    })
    row.querySelector('[data-act=up]')?.addEventListener('click', () => flMove(id, 'up'))
    row.querySelector('[data-act=down]')?.addEventListener('click', () => flMove(id, 'down'))
    row.querySelector('[data-act=hide]')?.addEventListener('click', async () => {
      try {
        await api(`/admin/links/${id}`, { method: 'PUT', body: { ...link, status: 'pending' } })
        toast('已移回待审核')
        navigate() // 操作后重渲染当前路由（经 navigate 守卫，用户已切页时不拽回）
      } catch (e) {
        toast(e.message, true)
      }
    })
    row.querySelector('[data-act=del]')?.addEventListener('click', async () => {
      if (!(await confirmBox(`确定删除友链「${link.name}」？`))) return
      try {
        await api(`/admin/links/${id}`, { method: 'DELETE' })
        toast('已删除')
        navigate() // 操作后重渲染当前路由（经 navigate 守卫，用户已切页时不拽回）
      } catch (e) {
        toast(e.message, true)
      }
    })
  })
}

/** 添加 / 编辑友链弹窗；link 传 null 是新增 */
function flModal(link) {
  const isEdit = !!link
  const m = modal(`<div class="modal-head"><span>${isEdit ? '编辑友链' : '添加友链'}</span><button class="modal-close" data-close>×</button></div>
      <div class="modal-body">
        <label class="auth-field"><label>站点名称</label><input class="input" id="fl-name" maxlength="40" value="${esc(link?.name || '')}"></label>
        <label class="auth-field"><label>网址</label><input class="input" id="fl-url" inputmode="url" placeholder="https://" value="${esc(link?.url || '')}"></label>
        <label class="auth-field"><label>简介（一两句话，可选）</label><input class="input" id="fl-desc" maxlength="120" value="${esc(link?.description || '')}"></label>
        <div class="auth-field">
          <label>网站图标（可选：自动获取 / 上传图片 / 贴图片地址；留空则显示站名首字图标）</label>
          <div class="fav-row">
            <span id="fl-icon-slot">${flIconHtml(link?.icon || '', link?.name || '')}</span>
            <button class="btn btn-sm" id="fl-icon-fetch" type="button">自动获取</button>
            <button class="btn btn-sm" id="fl-icon-upload" type="button">上传图片</button>
            <button class="btn btn-sm btn-ghost" id="fl-icon-clear" type="button">清除</button>
            <input type="file" id="fl-icon-file" accept="image/png,image/jpeg,image/webp,image/gif,image/x-icon,image/vnd.microsoft.icon" hidden>
          </div>
          <input class="input" id="fl-icon-url" inputmode="url" placeholder="也可直接贴图片地址 https://…，或把复制的图片 Ctrl+V 粘进来" style="margin-top:8px;" value="${esc(link?.icon || '')}">
          <input type="hidden" id="fl-icon" value="${esc(link?.icon || '')}">
        </div>
        ${isEdit ? `<label class="auth-field"><label>排序（数字小的靠前）</label><input class="input" id="fl-sort" type="number" min="0" value="${link.sort ?? 0}"></label>` : ''}
      </div>
      <div class="modal-foot"><button class="btn" data-close>取消</button><button class="btn btn-primary" id="fl-save">保存</button></div>`)

  const q = (sel) => m.mask.querySelector(sel)
  const renderIcon = (icon) => {
    icon = String(icon || '').trim()
    q('#fl-icon').value = icon
    q('#fl-icon-url').value = icon
    q('#fl-icon-slot').innerHTML = flIconHtml(icon, q('#fl-name').value)
  }
  m.mask.querySelector('#fl-icon-fetch').addEventListener('click', async () => {
    const url = m.mask.querySelector('#fl-url').value.trim()
    if (!url) return toast('先填网址，再自动获取图标', true)
    const btn = m.mask.querySelector('#fl-icon-fetch')
    btn.textContent = '获取中…'
    btn.disabled = true
    try {
      const r = await api('/admin/links/fetch-icon', { method: 'POST', body: { url } })
      renderIcon(r.icon)
      toast('图标已获取')
    } catch (e) {
      toast(e.message, true)
    }
    btn.textContent = '自动获取'
    btn.disabled = false
  })
  // 手动贴图片地址：实时同步预览
  q('#fl-icon-url').addEventListener('input', (e) => {
    const icon = e.target.value.trim()
    q('#fl-icon').value = icon
    q('#fl-icon-slot').innerHTML = flIconHtml(icon, q('#fl-name').value)
  })
  // 本地上传图标，走 R2 图床
  const iconFile = q('#fl-icon-file')
  const iconUploadBtn = q('#fl-icon-upload')
  iconUploadBtn.addEventListener('click', () => iconFile.click())
  iconFile.addEventListener('change', async () => {
    const file = iconFile.files[0]
    if (!file) return
    iconUploadBtn.textContent = '上传中…'
    iconUploadBtn.disabled = true
    try {
      const d = await uploadFile(await compressImage(file), null)
      renderIcon(d.url)
      toast('图标已上传')
    } catch (e) {
      toast(e.message, true)
    }
    iconUploadBtn.textContent = '上传图片'
    iconUploadBtn.disabled = false
    iconFile.value = ''
  })
  // 在弹窗里直接粘贴截图 / 复制的图片，自动传图床
  m.mask.addEventListener('paste', async (e) => {
    const file = [...(e.clipboardData?.files || [])].find((f) => f.type.startsWith('image/'))
    if (!file) return
    e.preventDefault()
    iconUploadBtn.textContent = '上传中…'
    iconUploadBtn.disabled = true
    try {
      const d = await uploadFile(await compressImage(file), null)
      renderIcon(d.url)
      toast('图片已上传')
    } catch (err) {
      toast(err.message, true)
    }
    iconUploadBtn.textContent = '上传图片'
    iconUploadBtn.disabled = false
  })
  m.mask.querySelector('#fl-icon-clear').addEventListener('click', () => renderIcon(''))
  m.mask.querySelector('#fl-save').addEventListener('click', async () => {
    const icon = m.mask.querySelector('#fl-icon').value.trim()
    if (icon && !icon.startsWith('/images/') && !/^https?:\/\//i.test(icon)) {
      return toast('图标地址要以 https:// 开头，或直接上传 / 粘贴图片', true)
    }
    const body = {
      name: m.mask.querySelector('#fl-name').value.trim(),
      url: m.mask.querySelector('#fl-url').value.trim(),
      description: m.mask.querySelector('#fl-desc').value.trim(),
      icon,
      status: link ? link.status : 'approved',
      sort: isEdit ? Number(m.mask.querySelector('#fl-sort').value) || 0 : 0,
    }
    if (!body.name || !body.url) return toast('站名和网址不能为空', true)
    const saveBtn = m.mask.querySelector('#fl-save')
    saveBtn.disabled = true
    try {
      if (isEdit) await api(`/admin/links/${link.id}`, { method: 'PUT', body })
      else await api('/admin/links', { method: 'POST', body })
      toast('已保存')
      m.close()
      navigate() // 操作后重渲染当前路由（经 navigate 守卫，用户已切页时不拽回）
    } catch (e) {
      toast(e.message, true)
      saveBtn.disabled = false
    }
  })
}

/* ---------------- 分类与标签（文章页第二页签，原独立「分类」页并入；#/categories 旧路由在 navigate 里重定向） ---------------- */
async function viewPostTaxonomy() {
  let d, t
  try {
    ;[d, t] = await Promise.all([api('/admin/categories'), api('/admin/tags')])
  } catch (e) {
    return handleApiErr(e)
  }
  const rows = d.categories
    .map(
      (c) => `<div class="cat-row" data-id="${c.id}">
      <div class="cat-main">
        <span class="cat-name">${esc(c.name)}</span>
        <span class="cat-slug">/category/${esc(c.slug)} · ${c.post_count ?? 0} 篇</span>
      </div>
      <div class="post-ops">
        <button class="btn btn-ghost btn-sm" data-act="edit">编辑</button>
        <button class="btn btn-ghost btn-sm btn-danger" data-act="del">删除</button>
      </div>
    </div>`
    )
    .join('')
  const tagChips = t.tags
    .map(
      (tg) => `<span class="tag-manage-item" data-name="${esc(tg.name)}">
      <span class="tag-manage-name">${esc(tg.name)}</span><i>${tg.count}</i>
      <button class="tag-manage-del" data-act="del-tag" title="删除标签">×</button>
    </span>`
    )
    .join('')

  await shellView(
    'posts',
    `<div class="page-head"><div><div class="page-title">文章</div><div class="page-sub">分类的大归类与标签，写文章时选用</div></div></div>
    <div class="toolbar">
      <div class="tabs">
        <button class="tab" data-vtab="list" type="button">列表</button>
        <button class="tab is-active" data-vtab="cats" type="button">分类标签</button>
      </div>
    </div>
    <div class="toolbar">
      <input class="input" id="cat-name" placeholder="新分类名称，如：生活随笔" maxlength="20">
      <button class="btn btn-primary" id="cat-add">添加分类</button>
    </div>
    <div class="panel">${rows || '<div class="empty-box">还没有分类，添加一个吧</div>'}</div>
    <div class="panel">
      <div class="panel-head"><span>标签</span><span class="panel-head-sub">共 ${t.tags.length} 个 · 可预建标签，删除会从所有文章移除</span></div>
      <div class="panel-body">
        <div class="toolbar" style="margin-bottom:12px;">
          <input class="input" id="tag-name" placeholder="新标签名称，回车或点添加" maxlength="20">
          <button class="btn btn-primary" id="tag-add">添加标签</button>
        </div>
        <div class="tag-manage-list">${tagChips || '<div class="empty-box" style="padding:20px 0;">还没有标签，在写文章时添加，或在这里预建</div>'}</div>
      </div>
    </div>`
  )

  $app.querySelectorAll('[data-vtab="list"]').forEach((b) =>
    b.addEventListener('click', () => (location.hash = '#/posts'))
  )

  document.getElementById('cat-add').addEventListener('click', async () => {
    const el = document.getElementById('cat-name')
    const name = el.value.trim()
    if (!name) return toast('先填个分类名', true)
    const btn = document.getElementById('cat-add')
    btn.disabled = true
    try {
      await api('/admin/categories', { method: 'POST', body: { name } })
      toast('分类已创建')
      navigate()
    } catch (e) {
      toast(e.message, true)
      btn.disabled = false
    }
  })

  const addTag = async () => {
    const el = document.getElementById('tag-name')
    const name = el.value.trim()
    if (!name) return toast('先填个标签名', true)
    const btn = document.getElementById('tag-add')
    btn.disabled = true
    try {
      await api('/admin/tags', { method: 'POST', body: { name } })
      toast('标签已创建')
      navigate()
    } catch (e) {
      toast(e.message, true)
      btn.disabled = false
    }
  }
  document.getElementById('tag-add').addEventListener('click', addTag)
  document.getElementById('tag-name').addEventListener('keydown', (e) => {
    // 输入法组词回车（确认候选词）不建标签，与编辑器里同一处理
    if (e.isComposing || e.keyCode === 229) return
    if (e.key === 'Enter') addTag()
  })

  $app.querySelectorAll('.tag-manage-del').forEach((btn) => {
    btn.addEventListener('click', async () => {
      const name = btn.closest('.tag-manage-item').dataset.name
      if (!(await confirmBox(`删除标签「${name}」？它会从所有文章中被移除。`))) return
      try {
        await api(`/admin/tags/${encodeURIComponent(name)}`, { method: 'DELETE' })
        toast('标签已删除')
        navigate()
      } catch (e) {
        toast(e.message, true)
      }
    })
  })

  $app.querySelectorAll('.cat-row').forEach((row) => {
    const id = Number(row.dataset.id)
    const cat = d.categories.find((c) => c.id === id)
    row.querySelector('[data-act=edit]').addEventListener('click', () => {
      const m = modal(`<div class="modal-head"><span>编辑分类</span><button class="modal-close" data-close>×</button></div>
        <div class="modal-body">
          <label class="auth-field"><label>名称</label><input class="input" id="cat-edit-name" value="${esc(cat.name)}" maxlength="20"></label>
          <label class="auth-field" style="margin-top:10px;"><label>链接标识（字母 / 数字 / 中文 / 短横线）</label><input class="input" id="cat-edit-slug" value="${esc(cat.slug)}"></label>
        </div>
        <div class="modal-foot"><button class="btn" data-close>取消</button><button class="btn btn-primary" id="cat-edit-save">保存</button></div>`)
      m.mask.querySelector('#cat-edit-save').addEventListener('click', async () => {
        const saveBtn = m.mask.querySelector('#cat-edit-save')
        saveBtn.disabled = true
        try {
          await api(`/admin/categories/${id}`, {
            method: 'PUT',
            body: {
              name: m.mask.querySelector('#cat-edit-name').value.trim(),
              slug: m.mask.querySelector('#cat-edit-slug').value.trim(),
            },
          })
          toast('已保存')
          m.close()
          navigate()
        } catch (e) {
          toast(e.message, true)
        } finally {
          saveBtn.disabled = false // 弹窗已关时改的是游离节点，无副作用
        }
      })
    })
    row.querySelector('[data-act=del]').addEventListener('click', async () => {
      if (!(await confirmBox(`删除分类「${cat.name}」？其下文章会变为未分类，文章本身不受影响。`))) return
      try {
        await api(`/admin/categories/${id}`, { method: 'DELETE' })
        toast('已删除')
        navigate()
      } catch (e) {
        toast(e.message, true)
      }
    })
  })
}

/* ---------------- 页面管理（独立页面系统） ---------------- */
async function viewPages() {
  let d
  try {
    d = await api('/admin/pages')
  } catch (e) {
    return handleApiErr(e)
  }
  const rows = d.pages
    .map(
      (p) => `<div class="cat-row" data-id="${p.id}">
      <div class="cat-main">
        <span class="cat-name">${esc(p.title)}${p.show_in_nav ? '<span class="chip chip-green" style="margin-left:8px;">导航</span>' : ''}</span>
        <span class="cat-slug">${p.slug === 'about' ? '/about（专属短链）' : `/page/${esc(p.slug)}`} · ${p.status === 'published' ? '<span class="chip chip-green">已发布</span>' : '<span class="chip chip-gray">草稿</span>'}</span>
      </div>
      <div class="post-ops">
        <button class="btn btn-ghost btn-sm" data-act="up" title="上移">↑</button>
        <button class="btn btn-ghost btn-sm" data-act="down" title="下移">↓</button>
        <button class="btn btn-ghost btn-sm" data-act="view" title="前台查看">查看</button>
        <button class="btn btn-ghost btn-sm" data-act="edit">编辑</button>
        <button class="btn btn-ghost btn-sm btn-danger" data-act="del">删除</button>
      </div>
    </div>`
    )
    .join('')

  await shellView(
    'pages',
    `<div class="page-head"><div><div class="page-title">页面</div><div class="page-sub">自建的独立页面（项目页 / 书单页 / 隐私政策…），「关于我」也在这里维护</div></div>
      <button class="btn btn-primary" id="page-add">新建页面</button></div>
    <div class="panel">${rows || '<div class="empty-box">还没有页面，点右上角新建一个吧</div>'}</div>`
  )

  document.getElementById('page-add').addEventListener('click', () => pageModal(null))

  let pageMoving = false
  const move = async (id, dir) => {
    // reorder 非幂等：请求期间连点会挪两格（全站写操作防连击约定）
    if (pageMoving) return
    pageMoving = true
    try {
      await api('/admin/pages/reorder', { method: 'POST', body: { id, dir } })
      navigate() // 操作后重渲染当前路由（经 navigate 守卫，用户已切页时不拽回）
    } catch (e) {
      toast(e.message, true)
    } finally {
      pageMoving = false
    }
  }

  $app.querySelectorAll('.cat-row').forEach((row) => {
    const id = Number(row.dataset.id)
    const page = d.pages.find((p) => p.id === id)
    row.querySelector('[data-act=up]').addEventListener('click', () => move(id, 'up'))
    row.querySelector('[data-act=down]').addEventListener('click', () => move(id, 'down'))
    row.querySelector('[data-act=view]').addEventListener('click', () => {
      window.open(page.slug === 'about' ? '/about' : `/page/${encodeURIComponent(page.slug)}`, '_blank', 'noopener')
    })
    row.querySelector('[data-act=edit]').addEventListener('click', () => pageModal(page))
    row.querySelector('[data-act=del]').addEventListener('click', async () => {
      if (!(await confirmBox(`删除页面「${page.title}」？将移入回收站，30 天内可恢复，期间前台无法访问。`))) return
      try {
        await api(`/admin/pages/${id}`, { method: 'DELETE' })
        toast('已移入回收站')
        navigate() // 操作后重渲染当前路由（经 navigate 守卫，用户已切页时不拽回）
      } catch (e) {
        toast(e.message, true)
      }
    })
  })
}

/* ---------------- 回收站（文章 / 微博 / 页面软删统一管理，30 天后自动彻底清除） ---------------- */
const TRASH_TYPE_LABEL = { post: '文章', weibo: '微博', page: '页面' }

async function viewTrash() {
  const q = new URLSearchParams(location.hash.split('?')[1] || '')
  const type = ['post', 'weibo', 'page'].includes(q.get('type')) ? q.get('type') : ''
  const page = parseInt(q.get('page') || '1', 10)

  let d
  try {
    d = await api(`/admin/trash?page=${page}${type ? `&type=${type}` : ''}`)
  } catch (e) {
    return handleApiErr(e)
  }

  const statusChip = (s) =>
    s === 'published'
      ? ''
      : s === 'scheduled'
        ? '<span class="chip chip-warn">定时</span>'
        : '<span class="chip chip-gray">草稿</span>'
  // 保留期与 src/trash.ts 的 TRASH_RETENTION_DAYS 同口径（30 天）；到期后由当晚 00:30 的清理任务彻底删除
  const TRASH_RETENTION_DAYS = 30
  const daysLeft = (deleted_at) =>
    Math.max(0, Math.ceil((deleted_at + TRASH_RETENTION_DAYS * 86400000 - Date.now()) / 86400000))
  const purgeHint = (deleted_at) => {
    const d = daysLeft(deleted_at)
    return d > 0 ? `${d} 天后自动彻底清除` : '今晚自动彻底清除'
  }
  const rows = d.items
    .map(
      (it) => `<div class="post-row" data-type="${it.type}" data-id="${it.id}">
      <div class="post-main">
        <div class="post-title">${esc(it.label || '（无文字内容）')}<span class="chip">${TRASH_TYPE_LABEL[it.type] || it.type}</span>${statusChip(it.status)}</div>
        <div class="post-meta"><span>删除于 ${fmtDateTime(it.deleted_at)}</span><span>·</span><span>${purgeHint(it.deleted_at)}</span></div>
      </div>
      <div class="post-ops">
        <button class="btn btn-ghost btn-sm" data-act="restore">恢复</button>
        <button class="btn btn-ghost btn-sm btn-danger" data-act="purge">彻底删除</button>
      </div>
    </div>`
    )
    .join('')

  await shellView(
    'trash',
    `<div class="page-head">
      <div><div class="page-title">回收站</div><div class="page-sub">删除的文章 / 微博 / 页面在这里保留 30 天，到期自动彻底清除${d.total ? ` · 共 ${d.total} 条` : ''}</div></div>
      ${d.total ? '<button class="btn btn-danger" id="trash-purge-all">清空回收站</button>' : ''}
    </div>
    <div class="toolbar">
      <div class="tabs">
        ${['', 'post', 'weibo', 'page']
          .map((t) => `<button class="tab${t === type ? ' is-active' : ''}" data-tab="${t}">${t === '' ? '全部' : TRASH_TYPE_LABEL[t]}</button>`)
          .join('')}
      </div>
    </div>
    <div class="panel">${rows || '<div class="empty-box">回收站是空的</div>'}</div>
    ${d.totalPages > 1 ? `<div class="pager-admin"><button class="btn btn-sm" id="pg-prev" ${page <= 1 ? 'disabled' : ''}>上一页</button><span>${d.page} / ${d.totalPages}</span><button class="btn btn-sm" id="pg-next" ${page >= d.totalPages ? 'disabled' : ''}>下一页</button></div>` : ''}`
  )

  const nav = (patch) => {
    const p = new URLSearchParams({ page: String(page), ...(type ? { type } : {}), ...patch })
    location.hash = '#/trash?' + p.toString()
  }
  $app.querySelectorAll('[data-tab]').forEach((b) => b.addEventListener('click', () => nav({ type: b.dataset.tab, page: 1 })))
  const prev = document.getElementById('pg-prev')
  const next = document.getElementById('pg-next')
  if (prev) prev.addEventListener('click', () => nav({ page: page - 1 }))
  if (next) next.addEventListener('click', () => nav({ page: page + 1 }))

  const purgeAll = document.getElementById('trash-purge-all')
  if (purgeAll)
    purgeAll.addEventListener('click', async () => {
      const scope = type ? TRASH_TYPE_LABEL[type] || '' : ''
      if (!(await confirmBox(scope ? `清空回收站里的全部${scope}？这些内容将被彻底删除，无法恢复。` : '清空回收站？所有项目将被彻底删除，无法恢复。'))) return
      purgeAll.disabled = true
      try {
        await api('/admin/trash/purge', { method: 'POST', body: type ? { type } : {} })
        toast(scope ? `已清空${scope}` : '回收站已清空')
        navigate() // 操作后重渲染当前路由（经 navigate 守卫，用户已切页时不拽回）
      } catch (e) {
        purgeAll.disabled = false
        toast(e.message, true)
      }
    })

  $app.querySelectorAll('.post-row').forEach((row) => {
    const id = Number(row.dataset.id)
    const t = row.dataset.type
    row.querySelector('[data-act=restore]').addEventListener('click', async (e) => {
      const btn = e.currentTarget
      if (btn.disabled) return
      btn.disabled = true
      try {
        await api(`/admin/trash/${t}/${id}/restore`, { method: 'POST' })
        toast('已恢复，内容回到原处')
        navigate() // 操作后重渲染当前路由（经 navigate 守卫，用户已切页时不拽回）
      } catch (e2) {
        btn.disabled = false
        toast(e2.message, true)
      }
    })
    row.querySelector('[data-act=purge]').addEventListener('click', async (e) => {
      const btn = e.currentTarget
      if (btn.disabled) return
      if (!(await confirmBox(`彻底删除这条${TRASH_TYPE_LABEL[t] || '内容'}？${t !== 'page' ? '其下评论将一并删除，' : ''}该操作不可恢复。`))) return
      btn.disabled = true
      try {
        await api(`/admin/trash/${t}/${id}`, { method: 'DELETE' })
        toast('已彻底删除')
        navigate() // 操作后重渲染当前路由（经 navigate 守卫，用户已切页时不拽回）
      } catch (e2) {
        btn.disabled = false
        toast(e2.message, true)
      }
    })
  })
}

/** 会员管理页：列表 / 搜用户名邮箱 / 改档位 / 封禁解封（API 形状见 DEVPLAN-2026-10-07 附录 A5） */
const MEMBER_TIER_LABEL = { normal: '普通会员', coffee: '咖啡会员', top: '顶级会员' }

async function viewMembers() {
  const q = new URLSearchParams(location.hash.split('?')[1] || '')
  const page = parseInt(q.get('page') || '1', 10)
  const kw = (q.get('q') || '').trim()

  let d
  try {
    d = await api(`/admin/members?page=${page}${kw ? `&q=${encodeURIComponent(kw)}` : ''}`)
  } catch (e) {
    return handleApiErr(e)
  }

  const tierChip = (t) =>
    t === 'top'
      ? '<span class="chip chip-warn">顶级会员</span>'
      : t === 'coffee'
        ? '<span class="chip chip-green">咖啡会员</span>'
        : '<span class="chip chip-gray">普通会员</span>'
  const rows = d.items
    .map(
      (m) => `<div class="post-row" data-id="${m.id}">
      <div class="post-main">
        <div class="post-title">${esc(m.username)}${tierChip(m.tier)}${m.status === 'banned' ? '<span class="chip chip-gray">已封禁</span>' : ''}</div>
        <div class="post-meta"><span>积分 ${m.points}</span>${m.email ? `<span>·</span><span>${esc(m.email)}</span>` : ''}<span>·</span><span>注册于 ${fmtDateTime(m.created_at)}</span></div>
      </div>
      <div class="post-ops">
        <button class="btn btn-ghost btn-sm" data-act="tier">改档位</button>
        <button class="btn btn-ghost btn-sm${m.status === 'banned' ? '' : ' btn-danger'}" data-act="ban">${m.status === 'banned' ? '解除封禁' : '封禁'}</button>
      </div>
    </div>`
    )
    .join('')

  await shellView(
    'members',
    `<div class="page-head">
      <div><div class="page-title">会员</div><div class="page-sub">站内注册的会员 · 评论与每日登录攒积分${d.total ? ` · 共 ${d.total} 位` : ''}</div></div>
    </div>
    <div class="toolbar">
      <input class="input" id="mb-search" placeholder="搜索用户名 / 邮箱…" value="${esc(kw)}">
    </div>
    <div class="panel">${rows || '<div class="empty-box">还没有会员</div>'}</div>
    ${d.totalPages > 1 ? `<div class="pager-admin"><button class="btn btn-sm" id="pg-prev" ${page <= 1 ? 'disabled' : ''}>上一页</button><span>${d.page} / ${d.totalPages}</span><button class="btn btn-sm" id="pg-next" ${page >= d.totalPages ? 'disabled' : ''}>下一页</button></div>` : ''}`
  )

  const nav = (patch) => {
    const p = new URLSearchParams({ page: String(page), ...(kw ? { q: kw } : {}), ...patch })
    location.hash = '#/members?' + p.toString()
  }
  const searchEl = document.getElementById('mb-search')
  searchEl.addEventListener('input', () => {
    if (searchEl.isComposing) return // 同文章搜索：组词中不打断输入
    clearTimeout(membersSearchTimer)
    membersSearchTimer = setTimeout(() => nav({ q: searchEl.value.trim(), page: 1 }), 400)
  })
  const prev = document.getElementById('pg-prev')
  const next = document.getElementById('pg-next')
  if (prev) prev.addEventListener('click', () => nav({ page: page - 1 }))
  if (next) next.addEventListener('click', () => nav({ page: page + 1 }))

  $app.querySelectorAll('.post-row').forEach((row) => {
    const id = Number(row.dataset.id)
    const member = d.items.find((x) => x.id === id)
    row.querySelector('[data-act=tier]').addEventListener('click', () => memberTierModal(member))
    row.querySelector('[data-act=ban]').addEventListener('click', async (e) => {
      const btn = e.currentTarget
      if (btn.disabled) return
      const banned = member.status === 'banned'
      if (!banned && !(await confirmBox(`封禁会员「${member.username}」？封禁后其将无法登录与评论，积分与档案保留，可随时解封。`))) return
      btn.disabled = true
      try {
        await api(`/admin/members/${id}`, { method: 'PUT', body: { status: banned ? 'active' : 'banned' } })
        toast(banned ? '已解除封禁' : '已封禁')
        navigate() // 操作后重渲染当前路由（经 navigate 守卫，用户已切页时不拽回）
      } catch (e2) {
        btn.disabled = false
        toast(e2.message, true)
      }
    })
  })
}

/** 会员档位调整弹窗：PUT /admin/members/:id 缺键即保留，这里只发 tier */
function memberTierModal(member) {
  const m = modal(`<div class="modal-head"><span>调整档位 — ${esc(member.username)}</span><button class="modal-close" data-close>×</button></div>
    <div class="modal-body">
      <label class="auth-field"><label>会员档位</label>
        <select class="input" id="mb-tier">
          ${['normal', 'coffee', 'top'].map((t) => `<option value="${t}"${member.tier === t ? ' selected' : ''}>${MEMBER_TIER_LABEL[t]}</option>`).join('')}
        </select>
      </label>
      <div style="font-size:12px;color:var(--sub);margin-top:8px;">咖啡会员可读「咖啡会员及以上」的专属文章，顶级会员可读全部会员内容；档位不影响积分累计。</div>
    </div>
    <div class="modal-foot"><button class="btn" data-close>取消</button><button class="btn btn-primary" id="mb-tier-save">保存</button></div>`)
  m.mask.querySelector('#mb-tier-save').addEventListener('click', async () => {
    const btn = m.mask.querySelector('#mb-tier-save')
    btn.disabled = true
    try {
      await api(`/admin/members/${member.id}`, { method: 'PUT', body: { tier: m.mask.querySelector('#mb-tier').value } })
      toast('档位已更新')
      m.close()
      navigate() // 操作后重渲染当前路由（经 navigate 守卫，用户已切页时不拽回）
    } catch (e) {
      toast(e.message, true)
      btn.disabled = false
    }
  })
}

/** 页面编辑弹窗：v1 沿用「关于我」的 HTML 源码编辑方式，后续可接入完整编辑器 */
function pageModal(page) {
  const isNew = !page
  const m = modal(`<div class="modal-head"><span>${isNew ? '新建页面' : '编辑页面'}</span><button class="modal-close" data-close>×</button></div>
    <div class="modal-body">
      <label class="auth-field"><label>标题</label><input class="input" id="pg-title" value="${esc(page?.title || '')}" maxlength="60" placeholder="如：我的项目"></label>
      <label class="auth-field" style="margin-top:10px;"><label>链接标识（留空按标题生成，字母 / 数字 / 中文 / 短横线）</label><input class="input" id="pg-slug" value="${esc(page?.slug || '')}" placeholder="如 projects"></label>
      <div class="switch-row" style="margin-top:12px;">
        <div><div class="switch-label">已发布</div><div class="switch-sub">关闭则保存为草稿，前台不可见</div></div>
        <label class="switch"><input type="checkbox" id="pg-status" ${!isNew && page.status === 'published' ? 'checked' : ''}><span class="track"></span></label>
      </div>
      <div class="switch-row">
        <div><div class="switch-label">显示在顶部导航</div><div class="switch-sub">开启后前台导航「友情链接」与「关于我」之间会出现此页面</div></div>
        <label class="switch"><input type="checkbox" id="pg-nav" ${!isNew && page.show_in_nav ? 'checked' : ''}><span class="track"></span></label>
      </div>
      <label class="auth-field" style="margin-top:12px;"><label>正文（HTML，支持粘贴富文本源码）</label><textarea class="textarea" id="pg-content" rows="12" placeholder="<p>在这里写页面内容…</p>">${esc(page?.content || '')}</textarea></label>
    </div>
    <div class="modal-foot"><button class="btn" data-close>取消</button><button class="btn btn-primary" id="pg-save">保存</button></div>`)
  m.mask.querySelector('#pg-save').addEventListener('click', async () => {
    const btn = m.mask.querySelector('#pg-save')
    btn.disabled = true
    try {
      const body = {
        title: m.mask.querySelector('#pg-title').value.trim(),
        slug: m.mask.querySelector('#pg-slug').value.trim(),
        content: m.mask.querySelector('#pg-content').value,
        status: m.mask.querySelector('#pg-status').checked ? 'published' : 'draft',
        show_in_nav: m.mask.querySelector('#pg-nav').checked,
      }
      if (isNew) await api('/admin/pages', { method: 'POST', body })
      else await api(`/admin/pages/${page.id}`, { method: 'PUT', body })
      toast('已保存')
      m.close()
      navigate() // 操作后重渲染当前路由（经 navigate 守卫，用户已切页时不拽回）
    } catch (e) {
      toast(e.message, true)
      btn.disabled = false
    }
  })
}

/* ---------------- 评论管理 ---------------- */
async function viewComments() {
  const q = new URLSearchParams(location.hash.split('?')[1] || '')
  const status = q.get('status') || 'all'
  const type = q.get('type') || 'all'
  const page = parseInt(q.get('page') || '1', 10)
  let d
  try {
    d = await api(`/admin/comments?type=${type}&status=${status}&page=${page}`)
  } catch (e) {
    return handleApiErr(e)
  }
  // 后端返回全局待审数：审核操作后侧栏「评论」角标随之刷新
  state.pendingComments = d.pending ?? 0
  const totalPages = Math.max(1, Math.ceil(d.total / 20))
  const rows = d.items
    .map((cm) => {
      const wbText = String(cm.weibo_content || '').replace(/\s+/g, ' ').trim()
      const wbShort = wbText.length > 16 ? wbText.slice(0, 16) + '…' : wbText
      const typeChip = cm.post_id ? '文章' : cm.weibo_id ? '微博' : '留言板'
      const target = cm.post_id
        ? `<a class="comment-post" href="/post/${esc(cm.post_slug)}#comments" target="_blank">《${esc(cm.post_title)}》</a>`
        : cm.weibo_id
          ? `<a class="comment-post" href="/weibo?wb=${cm.weibo_id}#wb-${cm.weibo_id}" target="_blank">微博${wbShort ? ` · ${esc(wbShort)}` : ''}</a>`
          : `<a class="comment-post" href="/guestbook" target="_blank">留言板</a>`
      return `<div class="comment-row">
      <div class="comment-main">
        <div class="comment-meta">
          <span class="who">${esc(cm.nickname)}</span>
          ${Number(cm.is_admin) ? '<span class="chip chip-green">作者</span>' : ''}
          ${cm.status === 'pending' ? '<span class="chip chip-warn">待审核</span>' : '<span class="chip chip-green">已展示</span>'}
          <span class="chip chip-gray">${typeChip}</span>
          ${target}
          ${cm.parent_nickname ? `<span class="chip chip-gray">回复 @${esc(cm.parent_nickname)}</span>` : ''}
          <span style="color:var(--sub);font-size:12px;">${fmtDateTime(cm.created_at)}</span>
        </div>
        <div class="comment-content">${esc(cm.content)}</div>
        <div class="comment-reply" hidden>
          <textarea class="textarea" rows="2" placeholder="以作者身份回复，前台会带「作者」徽标…"></textarea>
          <div class="comment-reply-ops"><button class="btn btn-sm btn-primary" data-act="send-reply">发送回复</button></div>
        </div>
      </div>
      <div class="comment-ops">
        <button class="btn btn-sm" data-act="reply">回复</button>
        ${cm.status === 'pending' ? `<button class="btn btn-sm btn-primary" data-act="approve">通过</button>` : `<button class="btn btn-sm" data-act="hide">隐藏</button>`}
        <button class="btn btn-sm btn-danger" data-act="del">删除</button>
      </div>
    </div>`
    })
    .join('')

  const nav = (patch) => {
    const p = new URLSearchParams({ type, status, ...patch })
    location.hash = '#/comments?' + p.toString()
  }
  await shellView(
    'comments',
    `<div class="page-head"><div><div class="page-title">评论</div><div class="page-sub">共 ${d.total} 条</div></div></div>
    <div class="toolbar">
      <div class="tabs">
        ${['all', 'post', 'weibo', 'guestbook']
          .map((t) => `<button class="tab${t === type ? ' is-active' : ''}" data-type="${t}">${{ all: '全部', post: '文章评论', weibo: '微博评论', guestbook: '留言板' }[t]}</button>`)
          .join('')}
      </div>
      <div class="tabs">
        ${['all', 'pending', 'approved']
          .map((t) => `<button class="tab${t === status ? ' is-active' : ''}" data-tab="${t}">${{ all: '全部状态', pending: '待审核', approved: '已展示' }[t]}</button>`)
          .join('')}
      </div>
    </div>
    <div class="panel">${rows || '<div class="empty-box">还没有评论</div>'}</div>
    ${totalPages > 1 ? `<div class="pager-admin"><button class="btn btn-sm" id="pg-prev" ${page <= 1 ? 'disabled' : ''}>上一页</button><span>${page} / ${totalPages} 页</span><button class="btn btn-sm" id="pg-next" ${page >= totalPages ? 'disabled' : ''}>下一页</button></div>` : ''}`
  )
  $app.querySelectorAll('[data-type]').forEach((b) =>
    b.addEventListener('click', () => nav({ type: b.dataset.type, page: 1 }))
  )
  $app.querySelectorAll('[data-tab]').forEach((b) =>
    b.addEventListener('click', () => nav({ status: b.dataset.tab, page: 1 }))
  )
  const pgPrev = document.getElementById('pg-prev')
  const pgNext = document.getElementById('pg-next')
  if (pgPrev) pgPrev.addEventListener('click', () => nav({ page: page - 1 }))
  if (pgNext) pgNext.addEventListener('click', () => nav({ page: page + 1 }))
  Array.from($app.querySelectorAll('.comment-row')).forEach((row, i) => {
    const cm = d.items[i]
    row.querySelector('[data-act=reply]')?.addEventListener('click', () => {
      const box = row.querySelector('.comment-reply')
      if (!box) return
      box.hidden = !box.hidden
      if (!box.hidden) box.querySelector('textarea').focus()
    })
    row.querySelector('[data-act=send-reply]')?.addEventListener('click', async () => {
      const box = row.querySelector('.comment-reply')
      const content = box.querySelector('textarea').value.trim()
      if (!content) return toast('先写点回复内容', true)
      const sendBtn = box.querySelector('[data-act=send-reply]')
      sendBtn.disabled = true
      try {
        await api(`/admin/comments/${cm.id}/replies`, { method: 'POST', body: { content } })
        toast('已回复')
        navigate() // 操作后重渲染当前路由（经 navigate 守卫，用户已切页时不拽回）
      } catch (e) {
        toast(e.message, true)
        sendBtn.disabled = false
      }
    })
    row.querySelector('[data-act=approve]')?.addEventListener('click', async () => {
      try {
        await api(`/admin/comments/${cm.id}`, { method: 'PUT', body: { status: 'approved' } })
        toast('已展示')
        navigate() // 操作后重渲染当前路由（经 navigate 守卫，用户已切页时不拽回）
      } catch (e) {
        toast(e.message, true)
      }
    })
    row.querySelector('[data-act=hide]')?.addEventListener('click', async () => {
      try {
        await api(`/admin/comments/${cm.id}`, { method: 'PUT', body: { status: 'pending' } })
        toast('已隐藏')
        navigate() // 操作后重渲染当前路由（经 navigate 守卫，用户已切页时不拽回）
      } catch (e) {
        toast(e.message, true)
      }
    })
    row.querySelector('[data-act=del]')?.addEventListener('click', async () => {
      if (!(await confirmBox('删除这条评论？它的回复也会一并删除。'))) return
      try {
        await api(`/admin/comments/${cm.id}`, { method: 'DELETE' })
        toast('已删除')
        navigate() // 操作后重渲染当前路由（经 navigate 守卫，用户已切页时不拽回）
      } catch (e) {
        toast(e.message, true)
      }
    })
  })
}

/* ---------------- 媒体库 ---------------- */
async function viewMedia() {
  const q = new URLSearchParams(location.hash.split('?')[1] || '')
  const page = parseInt(q.get('page') || '1', 10)
  let d
  try {
    d = await api(`/admin/uploads?page=${page}`)
  } catch (e) {
    return handleApiErr(e)
  }
  const grid = d.items
    .map((u) => {
      const isVideo = u.mime.startsWith('video/')
      return `<div class="media-item" data-key="${esc(u.key)}" data-url="${esc(u.url)}">
      <div class="media-thumb">
        ${isVideo ? `<video src="${esc(u.url)}" muted></video>` : `<div style="background-image:url('${esc(u.url)}');width:100%;height:100%;background-size:cover;background-position:center;"></div>`}
      </div>
      <div class="media-info">
        <div class="media-name" title="${esc(u.name)}">${esc(u.name || u.key)}</div>
        <div class="media-size">${fmtSize(u.size)} · ${fmtDateTime(u.created_at)}</div>
      </div>
    </div>`
    })
    .join('')
  await shellView(
    'media',
    `<div class="page-head">
      <div><div class="page-title">媒体库</div><div class="page-sub">存在 R2 图床 · 共 ${d.total} 个文件</div></div>
      <div style="display:flex;gap:10px;">
        <button class="btn" id="media-audit" title="检查未引用与重复的文件，安全清理或合并">体检</button>
        <button class="btn btn-primary" id="media-upload">上传文件</button>
      </div>
    </div>
    <div class="media-grid">${grid || '<div class="empty-box" style="grid-column:1/-1;">还没有上传过文件</div>'}</div>
    ${
      d.total > 24
        ? (() => {
            const totalPages = Math.ceil(d.total / 24)
            return `<div class="pager-admin"><button class="btn btn-sm" id="pg-prev" ${page <= 1 ? 'disabled' : ''}>上一页</button><span>第 ${page} / ${totalPages} 页</span><button class="btn btn-sm" id="pg-next" ${page >= totalPages ? 'disabled' : ''}>下一页</button></div>`
          })()
        : ''
    }`
  )

  document.getElementById('media-audit').addEventListener('click', openMediaAudit)
  document.getElementById('media-upload').addEventListener('click', () => {
    pickFiles('image/jpeg,image/png,image/webp,image/gif,video/mp4,video/webm', false, async (files) => {
      if (!files[0]) return
      try {
        await uploadFile(await compressImage(files[0]), null)
        toast('上传成功')
        navigate()
      } catch (e) {
        toast(e.message, true)
      }
    })
  })
  $app.querySelectorAll('.media-item').forEach((item) => {
    item.addEventListener('click', async () => {
      const key = item.dataset.key
      const m = modal(`<div class="modal-head"><span>文件详情</span><button class="modal-close" data-close>×</button></div>
        <div class="modal-body">
          <div style="background:#f6f6f6;border-radius:8px;overflow:hidden;margin-bottom:14px;display:flex;align-items:center;justify-content:center;max-height:300px;">
            <img src="${esc(item.dataset.url)}" style="max-width:100%;max-height:300px;">
          </div>
          <label class="auth-field" style="margin-bottom:10px;"><label>访问地址</label><input class="input" id="mi-url" readonly value="${esc(item.dataset.url)}"></label>
        </div>
        <div class="modal-foot">
          <button class="btn btn-danger" id="mi-del">删除</button>
          <button class="btn btn-primary" id="mi-copy">复制地址</button>
        </div>`)
      // 事件绑定，不在属性里拼 JS（CSP 禁内联脚本）
      m.mask.querySelector('#mi-url').addEventListener('click', (e) => e.currentTarget.select())
      // 图片加载失败说明是视频：换成 <video>（事件绑定，不在属性里拼 JS）
      m.mask.querySelector('.modal-body img')?.addEventListener('error', (e) => {
        const v = document.createElement('video')
        v.src = item.dataset.url
        v.controls = true
        v.style.maxWidth = '100%'
        e.currentTarget.replaceWith(v)
      })
      m.mask.querySelector('#mi-copy').addEventListener('click', () => {
        navigator.clipboard
          .writeText(location.origin + item.dataset.url)
          .then(() => toast('已复制'))
          .catch(() => toast('复制失败，请手动长按选择地址', true))
      })
      m.mask.querySelector('#mi-del').addEventListener('click', async () => {
        if (!(await confirmBox('删除后引用它的文章将无法显示图片，确定？'))) return
        try {
          await api(`/admin/uploads?key=${encodeURIComponent(key)}`, { method: 'DELETE' })
          toast('已删除')
          m.close()
          navigate()
        } catch (e) {
          toast(e.message, true)
        }
      })
    })
  })
  const prev = document.getElementById('pg-prev')
  const next = document.getElementById('pg-next')
  if (prev) prev.addEventListener('click', () => (location.hash = `#/media?page=${page - 1}`))
  if (next) next.addEventListener('click', () => (location.hash = `#/media?page=${page + 1}`))
}

/* ---------------- 媒体体检（未引用 / 重复 / 失踪文件） ----------------
 * 三步：算指纹（首次把老文件的 SHA-256 增量回填）→ 报告 → 确认后清理或合并。
 * 服务端在执行清理/合并前会再验一遍引用：体检之后新写的文章若用上了某张图，
 * 那张图会被保留并回告。操作成功后 navigate() 刷新身后的媒体库网格（弹窗挂在 body 上不受影响）。 */
function auditThumb(u) {
  if (u.mime.startsWith('video/')) return '<div class="audit-thumb is-video">▶</div>'
  return `<div class="audit-thumb" style="background-image:url('/images/${esc(u.key)}')"></div>`
}

async function openMediaAudit() {
  const m = modal(`<div class="modal-head"><span>媒体体检</span><button class="modal-close" data-close>×</button></div>
    <div class="modal-body audit-body" id="audit-body"><div class="empty-box">正在体检…</div></div>`)
  m.mask.querySelector('.modal').classList.add('audit-modal')
  const body = m.mask.querySelector('#audit-body')
  try {
    await renderAuditReport(body)
  } catch (e) {
    body.innerHTML = `<div class="empty-box">${esc(e.message)}</div>`
  }
}

/** 拉报告；有文件还没算指纹就先增量回填（循环到算完），再重扫一次 */
async function loadAuditReport(body) {
  let d = await api('/admin/uploads/audit')
  if (d.missingHash > 0) {
    const total = d.missingHash
    let done = 0
    for (;;) {
      body.innerHTML = `<div class="empty-box">首次体检：正在计算文件指纹 ${done}/${total}…</div>`
      const r = await api('/admin/uploads/hash-backfill', { method: 'POST', body: { limit: 25 } })
      done += r.processed + r.missing
      if (!r.remaining) break
    }
    d = await api('/admin/uploads/audit')
  }
  return d
}

async function renderAuditReport(body) {
  const d = await loadAuditReport(body)
  const free = d.unreferenced

  const sum = `<div class="audit-sum">
    <span class="audit-chip">共 <b>${d.scanned}</b> 个文件</span>
    ${free.length ? `<span class="audit-chip is-warn">未引用 <b>${free.length}</b> 个 · ${fmtSize(d.unreferencedBytes)}</span>` : '<span class="audit-chip is-ok">✓ 无未引用文件</span>'}
    ${d.duplicateGroups.length ? `<span class="audit-chip is-warn">重复 <b>${d.duplicateGroups.length}</b> 组 · 冗余 ${fmtSize(d.duplicateBytes)}</span>` : '<span class="audit-chip is-ok">✓ 无重复文件</span>'}
    ${d.ghosts.length ? `<span class="audit-chip is-warn">失踪记录 <b>${d.ghosts.length}</b> 个</span>` : ''}
  </div>`

  const dupHtml = d.duplicateGroups.length
    ? `<div class="audit-sec">
      <div class="audit-sec-head"><span>重复文件<span class="audit-sec-sub">　内容完全相同：点「保留这张」，其余副本的引用会自动改写到它再删除，前台照常显示</span></span></div>
      ${d.duplicateGroups
        .map(
          (g, gi) => `<div class="dup-group">
        <div class="dup-group-head">第 ${gi + 1} 组 · ${g.items.length} 个相同文件 · 冗余 ${fmtSize(g.wasteBytes)}</div>
        <div class="audit-grid">${g.items
          .map(
            (u) => `<div class="audit-item">
          ${auditThumb(u)}
          <div class="audit-item-info"><div class="audit-name" title="${esc(u.name || u.key)}">${esc(u.name || u.key)}</div>
          <div class="audit-meta"><span>${fmtSize(u.size)}</span><span class="audit-badge ${u.referenced ? 'is-ref' : 'is-free'}">${u.referenced ? '已引用' : '未引用'}</span></div></div>
          <button class="btn btn-sm audit-keep" data-keep="${esc(u.key)}">保留这张</button>
        </div>`
          )
          .join('')}</div>
      </div>`
        )
        .join('')}
    </div>`
    : ''

  const freeHtml = free.length
    ? `<div class="audit-sec">
      <div class="audit-sec-head"><span>未引用<span class="audit-sec-sub">　站内没有任何内容用到，删除不影响前台显示</span></span>
        <span class="audit-actions"><button class="btn btn-sm" id="audit-selall">全选</button>
        <button class="btn btn-sm btn-danger" id="audit-clean" disabled>删除所选</button></span></div>
      <div class="audit-grid">${free
        .map(
          (u) => `<div class="audit-item is-pick" data-key="${esc(u.key)}">
        ${auditThumb(u)}<input type="checkbox" class="audit-check" data-key="${esc(u.key)}">
        <div class="audit-item-info"><div class="audit-name" title="${esc(u.name || u.key)}">${esc(u.name || u.key)}</div>
        <div class="audit-meta"><span>${fmtSize(u.size)}</span><span>${fmtDateTime(u.created_at)}</span></div></div>
      </div>`
        )
        .join('')}</div>
      <div class="audit-footnote">注意：若某张图被站外文章当作图床热链，站内检测不到这种引用，删掉后对方页面会挂图。</div>
    </div>`
    : ''

  const ghostHtml = d.ghosts.length
    ? `<div class="audit-sec">
      <div class="audit-sec-head"><span>失踪记录<span class="audit-sec-sub">　图床里的文件已不在（多半是手动清过 R2），只剩这条登记</span></span>
        ${d.ghosts.some((g) => !g.referenced) ? '<button class="btn btn-sm btn-danger" id="audit-ghost-clean">清理无引用的记录</button>' : ''}</div>
      <div class="audit-grid">${d.ghosts
        .map(
          (u) => `<div class="audit-item is-ghost">
        ${auditThumb(u)}
        <div class="audit-item-info"><div class="audit-name" title="${esc(u.name || u.key)}">${esc(u.name || u.key)}</div>
        <div class="audit-meta"><span>${fmtSize(u.size)}</span><span class="audit-badge ${u.referenced ? 'is-ref' : 'is-free'}">${u.referenced ? '仍被引用' : '无引用'}</span></div></div>
      </div>`
        )
        .join('')}</div>
    </div>`
    : ''

  const allClean = !free.length && !d.duplicateGroups.length && !d.ghosts.length
  body.innerHTML =
    sum +
    (allClean ? '<div class="empty-box">🎉 很干净：没有未引用、重复或失踪的文件</div>' : '') +
    dupHtml +
    freeHtml +
    ghostHtml

  /* --- 未引用：点选 + 批量删除 --- */
  const selected = new Set()
  const boxes = [...body.querySelectorAll('.audit-check')]
  const cleanBtn = body.querySelector('#audit-clean')
  const syncCleanBtn = () => {
    cleanBtn.disabled = !selected.size
    cleanBtn.textContent = selected.size ? `删除所选（${selected.size} 个）` : '删除所选'
  }
  boxes.forEach((cb) => {
    cb.addEventListener('change', () => {
      if (cb.checked) selected.add(cb.dataset.key)
      else selected.delete(cb.dataset.key)
      cb.closest('.audit-item').classList.toggle('is-checked', cb.checked)
      syncCleanBtn()
    })
  })
  body.querySelectorAll('.is-pick').forEach((item) => {
    item.addEventListener('click', (e) => {
      if (e.target.closest('.audit-check')) return
      const cb = item.querySelector('.audit-check')
      cb.checked = !cb.checked
      cb.dispatchEvent(new Event('change'))
    })
  })
  const selBtn = body.querySelector('#audit-selall')
  if (selBtn)
    selBtn.addEventListener('click', () => {
      const all = selected.size !== boxes.length
      boxes.forEach((cb) => {
        cb.checked = all
        cb.closest('.audit-item').classList.toggle('is-checked', all)
      })
      selected.clear()
      if (all) boxes.forEach((cb) => selected.add(cb.dataset.key))
      selBtn.textContent = all ? '全不选' : '全选'
      syncCleanBtn()
    })
  if (cleanBtn)
    cleanBtn.addEventListener('click', async () => {
      const keys = [...selected]
      const bytes = free.filter((u) => selected.has(u.key)).reduce((s, u) => s + u.size, 0)
      if (!(await confirmBox(`删除 ${keys.length} 个未引用文件（共 ${fmtSize(bytes)}）？站内没有内容引用它们，删除后不可恢复。`))) return
      cleanBtn.disabled = true
      try {
        // 服务端单次最多收 100 个 key：多批提交并汇总（每批执行前都会重验引用，被新内容引用的会留在 blocked 里）
        let deleted = 0
        let freedBytes = 0
        const blocked = []
        for (let i = 0; i < keys.length; i += 100) {
          const r = await api('/admin/uploads/cleanup', { method: 'POST', body: { keys: keys.slice(i, i + 100) } })
          deleted += r.deleted || 0
          freedBytes += r.freedBytes || 0
          if (r.blocked && r.blocked.length) blocked.push(...r.blocked)
        }
        if (blocked.length) {
          toast(`已删除 ${deleted} 个；${blocked.length} 个刚被内容引用，已保留——重新体检即可看到`, true)
        } else {
          toast(`已删除 ${deleted} 个文件，释放 ${fmtSize(freedBytes)}`)
        }
        navigate()
        renderAuditReport(body)
      } catch (e) {
        // 分批提交时前面几批可能已删掉：如实回告进度，剩下的稍后重试（已删的 key 重复提交会被跳过）
        toast(deleted ? `已删除 ${deleted} 个，剩余的稍后重试：${e.message}` : e.message, true)
        cleanBtn.disabled = false
      }
    })

  /* --- 重复：每组选一张保留，其余合并进去 --- */
  body.querySelectorAll('.audit-keep').forEach((btn) => {
    btn.addEventListener('click', async () => {
      const keep = btn.dataset.keep
      const g = d.duplicateGroups.find((x) => x.items.some((u) => u.key === keep))
      if (!g) return
      const remove = g.items.map((u) => u.key).filter((k) => k !== keep)
      if (!(await confirmBox(`保留这张，把其余 ${remove.length} 个相同副本的引用改到它并删除副本？改写的是站内数据库引用，前台内容照常可用。`))) return
      btn.disabled = true
      try {
        // 服务端单次最多合并 20 个副本：超大重复组分批提交（同一 keep，REPLACE 改写幂等）
        let updated = 0
        let freedBytes = 0
        for (let i = 0; i < remove.length; i += 20) {
          const r = await api('/admin/uploads/merge', { method: 'POST', body: { keep, remove: remove.slice(i, i + 20) } })
          updated += r.updated || 0
          freedBytes += r.freedBytes || 0
        }
        toast(`已合并：改写 ${updated} 处引用，释放 ${fmtSize(freedBytes)}`)
        navigate()
        renderAuditReport(body)
      } catch (e) {
        toast(updated ? `已合并 ${updated} 处引用，剩余的重新体检后再试：${e.message}` : e.message, true)
        btn.disabled = false
      }
    })
  })

  /* --- 失踪记录：只删登记条目 --- */
  const ghostBtn = body.querySelector('#audit-ghost-clean')
  if (ghostBtn)
    ghostBtn.addEventListener('click', async () => {
      const keys = d.ghosts.filter((g) => !g.referenced).map((g) => g.key)
      if (!(await confirmBox(`清理 ${keys.length} 条失踪记录？图床里的文件本来就不在了，只会删除这些登记条目。`))) return
      ghostBtn.disabled = true
      try {
        const r = await api('/admin/uploads/cleanup', { method: 'POST', body: { keys } })
        toast(`已清理 ${r.deleted} 条记录`)
        navigate()
        renderAuditReport(body)
      } catch (e) {
        toast(e.message, true)
        ghostBtn.disabled = false
      }
    })
}

/* ---------------- 皮肤 ---------------- */
const SWATCH_FALLBACK = ['#eeeeee', '#b23a29', '#ffffff', '#eeeeee', '#eeeeee']

function swatchOf(t) {
  return Array.isArray(t.colors) && t.colors.length >= 5 ? t.colors : SWATCH_FALLBACK
}

/** 目录色板颜色：只放行 #RGB/#RRGGBB[AA] 形态，防目录数据（未来若改远程源）借 style 属性注入 CSS */
function cssColor(v) {
  return /^#[0-9a-fA-F]{3,8}$/.test(String(v || '')) ? v : 'transparent'
}

/** 市场条目链接：只放行 http(s) 完整地址，其余退回站内根路径（防 javascript: 等协议混进 href） */
function safeHttpUrl(u) {
  return /^https?:\/\//i.test(String(u || '')) ? u : '/'
}

function swatchHtml(c) {
  return `<div class="theme-preview" style="background:${cssColor(c[0])}">
      <div class="tp-bar" style="background:${cssColor(c[1])}"></div>
      <div class="tp-card" style="background:${cssColor(c[2])}"></div>
      <div class="tp-card2" style="background:${cssColor(c[3])}"></div>
      <div class="tp-card3" style="background:${cssColor(c[4])}"></div>
    </div>`
}

async function fetchCatalog() {
  try {
    const r = await fetch('/market/catalog.json', { credentials: 'same-origin' })
    if (r.ok) return await r.json()
  } catch {
    /* 目录缺失时市场 tab 显示空态 */
  }
  return null
}

async function viewAppearance() {
  const q = new URLSearchParams(location.hash.split('?')[1] || '')
  const tab = q.get('tab') === 'market' ? 'market' : 'mine'
  let themes
  try {
    ;[{ settings: state.settings }, themes] = await Promise.all([api('/admin/settings'), api('/meta/themes')])
  } catch (e) {
    return handleApiErr(e)
  }
  const list = themes.themes || []
  const catalog = tab === 'market' ? await fetchCatalog() : null

  const mine = list
    .map(
      (t) => `<div class="theme-card${state.settings.theme === t.id ? ' is-active' : ''}" data-theme="${esc(t.id)}">
      ${swatchHtml(swatchOf(t))}
      <div class="theme-meta"><div class="theme-name"><span>${esc(t.name)}</span></div><div class="theme-desc">${esc(t.description)}</div></div>
    </div>`
    )
    .join('')
  const market = (catalog?.themes || [])
    .map((t) => {
      const installed = list.some((x) => t.id === x.id)
      return `<a class="theme-card mk-card" href="${esc(safeHttpUrl(t.link))}" target="_blank" rel="noopener">
      ${swatchHtml(swatchOf(t))}
      <div class="theme-meta"><div class="theme-name"><span>${esc(t.name)}</span>${installed ? '<span class="mk-badge">已安装</span>' : ''}</div><div class="theme-desc">${esc(t.description || '查看介绍与安装说明')}</div></div>
    </a>`
    })
    .join('') || '<div class="empty-box">市场目录暂时空着，更多皮肤敬请期待</div>'

  // 外观变量（B9 · 内测）：按当前皮肤的能力出表单——主题不支持的角色（如 minimal 无主色）不出现
  const curTheme = list.find((t) => t.id === state.settings.theme) || null
  const ap = curTheme && curTheme.appearance
  let apPanel = ''
  if (ap) {
    let picks = {}
    try {
      picks = JSON.parse(state.settings.appearance || '{}') || {}
    } catch {
      picks = {}
    }
    if (!picks || typeof picks !== 'object' || Array.isArray(picks)) picks = {}
    const pickColor = (key, def) => {
      const v = picks[key]
      return typeof v === 'string' && /^#[0-9a-fA-F]{3,6}$/.test(v) ? v : def
    }
    const preset = ap.fontPresets.find((p) => p.stack === picks.font) || null
    const customFont = !preset && typeof picks.font === 'string' ? picks.font : ''
    const fontSel = preset ? preset.id : customFont ? 'custom' : ''
    const apRows = ap.roles
      .map(
        (r) => `<div class="ap-item"><label>${esc(r.label)}</label>
        <input type="color" class="ap-color" data-role="${esc(r.key)}" value="${esc(pickColor(r.key, r.default))}" data-default="${esc(r.default)}" title="主题默认 ${esc(r.default)}"></div>`
      )
      .join('')
    apPanel = `
    <div class="panel" style="padding:20px;margin-top:16px;" id="ap-panel">
      <div class="form-section" style="margin-bottom:0;">
        <h3>外观变量 <span class="mk-badge">内测</span></h3>
        <div class="sec-desc">不改代码微调当前皮肤「${esc(curTheme.name)}」的颜色、字体与正文字号，保存后全站即时生效、可随时恢复默认；圆角等更多变量在后续版本开放。只列出当前皮肤支持的项目，换皮肤后请回到这里重调</div>
        <div class="ap-grid">${apRows}</div>
        <div class="form-row">
          <div class="form-item"><label>正文字体</label>
            <select class="input" id="ap-font-select">
              <option value="">跟随主题</option>
              ${ap.fontPresets.map((p) => `<option value="${esc(p.id)}"${fontSel === p.id ? ' selected' : ''}>${esc(p.label)}</option>`).join('')}
              <option value="custom"${fontSel === 'custom' ? ' selected' : ''}>自定义</option>
            </select>
          </div>
          <div class="form-item"><label>自定义字体栈（逗号分隔，选「自定义」时生效）</label><input class="input" id="ap-font-custom" value="${esc(customFont)}" placeholder='"HarmonyOS Sans", sans-serif'></div>
          <div class="form-item"><label>正文字号 px（主题默认 ${ap.richSize}，留空跟随主题）</label><input class="input" type="number" id="ap-size" min="14" max="22" step="0.5" value="${typeof picks.fontSize === 'number' && picks.fontSize ? picks.fontSize : ''}"></div>
        </div>
        <div class="switch-sub" style="margin-bottom:12px;">取色器初始显示主题默认值；与默认相同的项保存后不会产生任何覆盖样式</div>
        <div class="ap-ops">
          <button class="btn" id="btn-ap-save" type="button">保存外观</button>
          <button class="btn btn-ghost" id="btn-ap-reset" type="button">全部恢复默认</button>
          <a class="btn btn-ghost" href="/" target="_blank" rel="noopener">打开首页看效果 ↗</a>
        </div>
      </div>
    </div>`
  }

  await shellView(
    'appearance',
    `<div class="page-head"><div><div class="page-title">皮肤</div><div class="page-sub">给博客换一身好看的衣服，选中即刻生效</div></div>
      <a class="btn" href="/" target="_blank" rel="noopener">预览主页 ↗</a></div>
    <div class="toolbar"><div class="tabs">
      <a class="tab${tab === 'mine' ? ' is-active' : ''}" href="#/appearance">我的皮肤</a>
      <a class="tab${tab === 'market' ? ' is-active' : ''}" href="#/appearance?tab=market">皮肤市场</a>
    </div></div>
    ${tab === 'mine' ? `<div class="panel" style="padding:20px;"><div class="settings-grid" id="theme-grid">${mine}</div></div>${apPanel}` : `<div class="panel" style="padding:20px;"><div class="settings-grid">${market}</div></div>`}`
  )

  if (tab !== 'mine') return
  // 点击卡片立即启用：乐观高亮，保存失败回退并提示
  let applying = false
  $app.querySelectorAll('.theme-card').forEach((card) =>
    card.addEventListener('click', async () => {
      if (applying || card.classList.contains('is-active')) return
      applying = true
      const prev = $app.querySelector('.theme-card.is-active')
      card.classList.add('is-active')
      try {
        const d = await api('/admin/settings', { method: 'PUT', body: { theme: card.dataset.theme } })
        state.settings = d.settings
        prev?.classList.remove('is-active')
        toast(`已启用皮肤「${card.dataset.name || card.dataset.theme}」`)
        if (ap) navigate() // 换肤后面板要按新皮肤的能力重画
      } catch (e) {
        card.classList.remove('is-active')
        prev?.classList.add('is-active')
        handleApiErr(e)
      } finally {
        applying = false
      }
    })
  )

  if (!ap) return
  const saveAppearance = async (payload, okMsg) => {
    const saveBtn = document.getElementById('btn-ap-save')
    const resetBtn = document.getElementById('btn-ap-reset')
    if (saveBtn) saveBtn.disabled = true
    if (resetBtn) resetBtn.disabled = true
    try {
      const d = await api('/admin/settings', { method: 'PUT', body: { appearance: payload } })
      state.settings = d.settings
      toast(okMsg)
      navigate() // 重画面板，反映已保存的口径
    } catch (e) {
      handleApiErr(e)
      if (saveBtn) saveBtn.disabled = false
      if (resetBtn) resetBtn.disabled = false
    }
  }
  const btnSave = document.getElementById('btn-ap-save')
  if (btnSave)
    btnSave.addEventListener('click', () => {
      // 颜色全量上报（含等于默认值的项——换皮肤后同值即无覆盖）；font/fontSize 用空值/0 表示清除
      const obj = {}
      document.querySelectorAll('#ap-panel .ap-color').forEach((inp) => {
        obj[inp.getAttribute('data-role')] = (inp.value || '').toLowerCase()
      })
      const sel = document.getElementById('ap-font-select')
      const custom = (document.getElementById('ap-font-custom').value || '').trim()
      obj.font = sel.value === 'custom' ? custom : sel.value
      const size = parseFloat(document.getElementById('ap-size').value)
      obj.fontSize = Number.isFinite(size) ? size : 0
      saveAppearance(JSON.stringify(obj), '外观已保存，全站即时生效')
    })
  const btnReset = document.getElementById('btn-ap-reset')
  if (btnReset) btnReset.addEventListener('click', () => saveAppearance('', '已恢复主题默认外观'))
}

/* ---------------- 插件 ---------------- */
async function viewPlugins() {
  const q = new URLSearchParams(location.hash.split('?')[1] || '')
  const tab = q.get('tab') === 'market' ? 'market' : 'installed'
  try {
    state.settings = (await api('/admin/settings')).settings
  } catch (e) {
    return handleApiErr(e)
  }
  const off = new Set((state.settings.pluginsDisabled || '').split(',').filter(Boolean))
  let manifest = []
  try {
    const r = await fetch('/plugins/manifest.json', { credentials: 'same-origin' })
    if (r.ok) {
      const l = await r.json()
      if (Array.isArray(l)) manifest = l
    }
  } catch {
    /* 清单缺失按空处理，不影响页面 */
  }
  // 清单兼容旧版纯文件名与新对象两种形态
  const installed = manifest
    .map((e) => (typeof e === 'string' ? { id: e.replace(/\.js$/, ''), file: e } : e))
    .filter((p) => p && p.id)
  // 服务端插件（随内核编译，见 src/hooks.ts）：启停存 settings.serverPluginsDisabled
  const srvOff = new Set((state.settings.serverPluginsDisabled || '').split(',').filter(Boolean))
  let serverPlugins = []
  try {
    const r = await api('/admin/server-plugins')
    if (Array.isArray(r.plugins)) serverPlugins = r.plugins
  } catch {
    /* 拉取失败不影响页面 */
  }
  const catalog = tab === 'market' ? await fetchCatalog() : null

  const rows = installed
    .map(
      (p) => `<div class="pl-row">
      <span class="pl-ico">${esc((p.title || p.id).charAt(0).toUpperCase())}</span>
      <div class="pl-main">
        <div class="pl-name">${esc(p.title || p.id)}${p.version ? `<span class="pl-ver">v${esc(p.version)}</span>` : ''}</div>
        <div class="pl-desc">${esc(p.description || '暂无介绍')}${p.author ? ` · ${esc(p.author)}` : ''}</div>
      </div>
      <label class="switch"><input type="checkbox" data-id="${esc(p.id)}" ${off.has(p.id) ? '' : 'checked'}><span class="track"></span></label>
    </div>`
    )
    .join('') || '<div class="empty-box">还没有安装插件，去插件市场看看</div>'
  const market = (catalog?.plugins || [])
    .map((p) => {
      const has = installed.some((x) => x.id === p.id)
      return `<a class="pl-row mk-row" href="${esc(safeHttpUrl(p.link))}" target="_blank" rel="noopener">
      <span class="pl-ico">${esc((p.name || p.id).charAt(0).toUpperCase())}</span>
      <div class="pl-main">
        <div class="pl-name">${esc(p.name || p.id)}${has ? '<span class="mk-badge">已安装</span>' : ''}</div>
        <div class="pl-desc">${esc(p.description || '查看介绍与安装说明')}</div>
      </div>
      <span class="pl-go">查看 ↗</span>
    </a>`
    })
    .join('') || '<div class="empty-box">市场目录暂时空着，更多插件敬请期待</div>'

  const serverRows = serverPlugins
    .map(
      (p) => `<div class="pl-row">
      <span class="pl-ico">${esc((p.title || p.id).charAt(0).toUpperCase())}</span>
      <div class="pl-main">
        <div class="pl-name">${esc(p.title || p.id)}${p.version ? `<span class="pl-ver">v${esc(p.version)}</span>` : ''}</div>
        <div class="pl-desc">${esc(p.description || '暂无介绍')}${p.author ? ` · ${esc(p.author)}` : ''}</div>
      </div>
      <label class="switch"><input type="checkbox" data-srv-id="${esc(p.id)}" ${srvOff.has(p.id) ? '' : 'checked'}><span class="track"></span></label>
    </div>`
    )
    .join('')

  await shellView(
    'plugins',
    `<div class="page-head"><div><div class="page-title">插件</div><div class="page-sub">写作编辑器里的小工具</div></div></div>
    <div class="toolbar"><div class="tabs">
      <a class="tab${tab === 'installed' ? ' is-active' : ''}" href="#/plugins">已安装</a>
      <a class="tab${tab === 'market' ? ' is-active' : ''}" href="#/plugins?tab=market">插件市场</a>
    </div></div>
    ${
      tab === 'installed'
        ? `<div class="panel">
      <div class="panel-head">编辑器插件<span class="panel-head-sub">停用后下次打开编辑器生效 · 开发新插件见 docs/PLUGINS.md</span></div>
      <div class="panel-body" id="pl-list">${rows}</div>
    </div>
    <div class="panel">
      <div class="panel-head">服务端插件<span class="panel-head-sub">随内核运行 · 配置在「设置 → 服务端插件」· 开发见 docs/PLUGINS.md</span></div>
      <div class="panel-body" id="srv-pl-list">${serverRows}</div>
    </div>`
        : `<div class="panel">
      <div class="panel-head">插件市场<span class="panel-head-sub">持续收录中 · 自己动手见 docs/PLUGINS.md</span></div>
      <div class="panel-body">${market}</div>
    </div>`
    }`
  )

  if (tab !== 'installed') return
  $app.querySelectorAll('#pl-list input[type=checkbox]').forEach((cb) =>
    cb.addEventListener('change', async () => {
      const id = cb.dataset.id
      const next = new Set(off)
      if (cb.checked) next.delete(id)
      else next.add(id)
      cb.disabled = true
      try {
        const d = await api('/admin/settings', { method: 'PUT', body: { pluginsDisabled: [...next].join(',') } })
        state.settings = d.settings
        off.clear()
        for (const v of next) off.add(v)
        toast(cb.checked ? '插件已启用' : '插件已停用，下次打开编辑器生效')
      } catch (e) {
        cb.checked = !cb.checked
        handleApiErr(e)
      } finally {
        cb.disabled = false
      }
    })
  )
  $app.querySelectorAll('#srv-pl-list input[type=checkbox]').forEach((cb) =>
    cb.addEventListener('change', async () => {
      const id = cb.dataset.srvId
      const next = new Set(srvOff)
      if (cb.checked) next.delete(id)
      else next.add(id)
      cb.disabled = true
      try {
        const d = await api('/admin/settings', { method: 'PUT', body: { serverPluginsDisabled: [...next].join(',') } })
        state.settings = d.settings
        srvOff.clear()
        for (const v of next) srvOff.add(v)
        toast(cb.checked ? '插件已启用' : '插件已停用，立即生效')
      } catch (e) {
        cb.checked = !cb.checked
        handleApiErr(e)
      } finally {
        cb.disabled = false
      }
    })
  )
}

/* ---------------- 设置 ---------------- */
/* 设置页当前页签：页内记忆（不进 hash——hashchange 会触发 navigate 重挂视图，丢未保存输入） */
let settingsTab = 'site'

async function viewSettings() {
  try {
    state.settings = (await api('/admin/settings')).settings
  } catch (e) {
    return handleApiErr(e)
  }
  const s = state.settings

  await shellView(
    'settings',
    `<div class="page-head"><div><div class="page-title">设置</div><div class="page-sub">站点的门面和规矩</div></div>
      <button class="btn btn-primary" id="btn-save">保存全部</button></div>

    <div class="settings-tabs-row">
      <div class="tabs settings-tabs" id="settings-tabs">
        <button class="tab" data-stab="site" type="button">站点</button>
        <button class="tab" data-stab="social" type="button">互动</button>
        <button class="tab" data-stab="advance" type="button">进阶</button>
        <button class="tab" data-stab="data" type="button">数据</button>
      </div>
      <div class="settings-hint" id="settings-hint"></div>
    </div>

    <div class="stab-pane" data-pane="site">
    <div class="panel" style="padding:20px;">
      <div class="form-section">
        <h3>站点信息</h3>
        <div class="sec-desc">名字会出现在浏览器标题、RSS 和文章作者位</div>
        <div class="form-row">
          <div class="form-item"><label>站点名称</label><input class="input" id="st-siteName" value="${esc(s.siteName)}" maxlength="40"></div>
          <div class="form-item"><label>站点链接（用于 RSS / sitemap，如 https://blog.example.com）</label><input class="input" id="st-siteUrl" value="${esc(s.siteUrl)}" placeholder="https://"></div>
        </div>
        <div class="form-item"><label>站点描述</label><input class="input" id="st-siteDescription" value="${esc(s.siteDescription)}" maxlength="120"></div>
        <div class="form-item"><label>页脚文字</label><input class="input" id="st-footerText" value="${esc(s.footerText)}" maxlength="120"></div>
        <div class="form-item">
          <label>站点头像（显示在首页刊头、微博与后台，圆形/方角由主题决定）</label>
          <div class="fav-row">
            <span id="avatar-preview-slot">${s.avatarUrl ? `<img class="avatar-preview" src="${esc(s.avatarUrl)}" alt="站点头像">` : '<span class="fav-empty">未设置，显示站名首字</span>'}</span>
            <button class="btn btn-sm" id="btn-avatar-upload" type="button">上传头像</button>
            <button class="btn btn-sm btn-ghost" id="btn-avatar-clear" type="button">恢复默认</button>
          </div>
          <input type="hidden" id="st-avatarUrl" value="${esc(s.avatarUrl || '')}">
        </div>
        <div class="form-item">
          <label>网站图标（浏览器标签页小图，PNG / ICO / WebP，存 R2 图床）</label>
          <div class="fav-row">
            <span id="fav-preview-slot">${s.faviconUrl ? `<img class="fav-preview" src="${esc(s.faviconUrl)}" alt="站点图标">` : '<span class="fav-empty">未设置，使用默认图标</span>'}</span>
            <button class="btn btn-sm" id="btn-fav-upload" type="button">上传图标</button>
            <button class="btn btn-sm btn-ghost" id="btn-fav-clear" type="button">恢复默认</button>
          </div>
          <input type="hidden" id="st-faviconUrl" value="${esc(s.faviconUrl || '')}">
        </div>
        <div class="form-item">
          <label>分享卡图（分享到社交平台的卡片大图，建议 1200×630 的 PNG / JPG，存 R2 图床）</label>
          <div class="sec-desc">未上传时使用内置卡图；文章设了封面会优先用封面</div>
          <div class="fav-row">
            <span id="og-preview-slot">${s.ogImageDefault ? `<img class="og-preview" src="${esc(s.ogImageDefault)}" alt="默认分享卡图">` : '<span class="fav-empty">未设置，使用内置卡图</span>'}</span>
            <button class="btn btn-sm" id="btn-og-upload" type="button">上传卡图</button>
            <button class="btn btn-sm btn-ghost" id="btn-og-clear" type="button">恢复内置</button>
          </div>
          <input type="hidden" id="st-ogImageDefault" value="${esc(s.ogImageDefault || '')}">
        </div>
      </div>
    </div>

    <div class="panel" style="padding:20px;">
      <div class="form-section"><h3>站点模式</h3><div class="sec-desc">不爱写长文？可以只写微博，或让微博当主角。只影响前台展示，文章与微博数据都不会动</div>
        <label class="mode-row"><input type="radio" name="st-siteModeGroup" value="both"><span class="mode-text"><b>博客 + 微博</b><i>文章和随手记都展示，打开首页先看谁，由下面的顺序决定</i></span></label>
        <div class="mode-sub" id="mode-order-row" hidden>
          <span class="mode-sub-label">打开首页先看</span>
          <label class="mode-seg"><input type="radio" name="st-siteModeOrder" value="blog-weibo"><span>博客在前</span></label>
          <label class="mode-seg"><input type="radio" name="st-siteModeOrder" value="weibo-blog"><span>微博在前</span></label>
        </div>
        <label class="mode-row"><input type="radio" name="st-siteModeGroup" value="blog"><span class="mode-text"><b>纯博客</b><i>隐藏微博模块：导航去掉「微博」，首页不出随手记，/weibo 跳回首页</i></span></label>
        <label class="mode-row"><input type="radio" name="st-siteModeGroup" value="weibo"><span class="mode-text"><b>纯微博</b><i>打开首页就是微博时间线，导航隐藏归档/分类话题/随机等博客模块；文章数据保留，旧链接仍可访问</i></span></label>
      </div>
    </div>

    <div class="panel" style="padding:20px;">
      <div class="form-section"><h3>语言版本（英文测试版 English 0.1）</h3><div class="sec-desc">前台界面语言：文章与微博正文保持原文，仅界面文案切换。英文版渲染出现异常时会自动回退中文版，并在后台顶部提醒；重新开启即重置异常状态</div>
        <label class="mode-row"><input type="radio" name="st-edition" value="zh"><span class="mode-text"><b>中文（默认）</b><i>前台保持中文界面</i></span></label>
        <label class="mode-row"><input type="radio" name="st-edition" value="en"><span class="mode-text"><b>English 0.1（英文测试版）</b><i>前台界面切换为英文并在页面顶部公示测试版横幅；测试期间搜索引擎不收录（noindex），出问题自动回退中文版</i></span></label>
        ${s.edition === 'en' && s.editionEnStatus === 'fallback' ? `<div class="switch-sub" style="color:var(--warn);">⚠️ 上次英文版出现异常已自动回退中文版${s.editionEnAt ? '（' + new Date(Number(s.editionEnAt)).toLocaleString() + '）' : ''}：${esc(s.editionEnError || '未知错误')}。重新选择英文版并保存即可重试。</div>` : ''}
      </div>
    </div>

    <div class="panel" style="padding:20px;">
      <div class="form-section"><h3>账号</h3><div class="sec-desc">${state.demo ? '演示站不支持修改密码（演示账号公示在登录页，每 2 小时随数据一起重置）' : '修改登录密码'}</div>
        <div class="form-row">
          <div class="form-item"><label>旧密码</label><input class="input" type="password" id="pw-old" autocomplete="current-password" ${state.demo ? 'disabled' : ''}></div>
          <div class="form-item"><label>新密码（至少 8 位）</label><input class="input" type="password" id="pw-new" autocomplete="new-password" ${state.demo ? 'disabled' : ''}></div>
          <div class="form-item" style="flex:0 0 auto;align-self:flex-end;"><button class="btn" id="btn-pw" ${state.demo ? 'disabled' : ''}>修改密码</button></div>
        </div>
      </div>
    </div>
    </div>

    <div class="stab-pane" data-pane="social" hidden>
    <div class="panel" style="padding:20px;">
      <div class="form-section"><h3>评论</h3><div class="sec-desc">访客留言的规则（文章、微博与留言板通用）</div>
        <div class="switch-row">
          <div><div class="switch-label">开启留言</div><div class="switch-sub">关闭后文章页与留言板隐藏留言区</div></div>
          <label class="switch"><input type="checkbox" id="st-allowComments" ${s.allowComments === '1' ? 'checked' : ''}><span class="track"></span></label>
        </div>
        <div class="switch-row">
          <div><div class="switch-label">留言先审后展</div><div class="switch-sub">开启后新留言需在「评论」里手动通过</div></div>
          <label class="switch"><input type="checkbox" id="st-moderateComments" ${s.moderateComments === '1' ? 'checked' : ''}><span class="track"></span></label>
        </div>
        <div class="form-item" style="max-width:180px;"><label>每页文章数</label><input class="input" id="st-postsPerPage" type="number" min="1" max="50" value="${esc(s.postsPerPage)}"></div>
      </div>
    </div>

    <div class="panel" style="padding:20px;">
      <div class="form-section"><h3>会员</h3><div class="sec-desc">游客注册成站内会员：登录评论带身份、攒积分上排行榜；文章可按档位控制「谁能看」</div>
        <div class="switch-row">
          <div><div class="switch-label">开启会员体系</div><div class="switch-sub">开启后前台出现「会员」「排行榜」导航入口与 /member /rank 页；编辑器可设文章档位。关闭时这两个页面 404，已设档位的文章仍按档位生效</div></div>
          <label class="switch"><input type="checkbox" id="st-membersEnabled" ${s.membersEnabled === '1' ? 'checked' : ''}><span class="track"></span></label>
        </div>
        <div class="form-item" style="max-width:180px;"><label>排行榜展示条数</label><input class="input" id="st-rankTopN" type="number" min="1" max="50" value="${esc(s.rankTopN || '10')}"></div>
      </div>
    </div>

    <div class="panel" style="padding:20px;">
      <div class="form-section"><h3>访客统计</h3><div class="sec-desc">在后台「统计」页展示浏览量、访客数、来源与设备分布；只记匿名访客号与来源域名，不存 IP 和原始 UA，日志保留 180 天</div>
        <div class="switch-row">
          <div><div class="switch-label">开启访客统计采集</div><div class="switch-sub">关闭后前台页面不再上报访问数据（已有数据保留不再新增，统计页仍可看历史）</div></div>
          <label class="switch"><input type="checkbox" id="st-statsEnabled" ${s.statsEnabled === '1' ? 'checked' : ''}><span class="track"></span></label>
        </div>
      </div>
    </div>
    </div>

    <div class="stab-pane" data-pane="advance" hidden>
    <div class="panel" style="padding:20px;">
      <div class="form-section"><h3>站点状态</h3><div class="sec-desc">特殊时刻的全站开关：两个都是可逆的，随时保存随时恢复</div>
        <div class="switch-row">
          <div><div class="switch-label">灰度模式</div><div class="switch-sub">全站去色显示（黑白），用于哀悼、纪念等特殊时刻；后台不受影响</div></div>
          <label class="switch"><input type="checkbox" id="st-siteGrayscale" ${s.siteGrayscale === '1' ? 'checked' : ''}><span class="track"></span></label>
        </div>
        <div class="switch-row">
          <div><div class="switch-label">关闭站点</div><div class="switch-sub">开启后访客只能看到闭站页，RSS、评论等一并停用；后台与已登录的你不受影响</div>${state.demo ? '<div class="switch-sub" style="color:var(--warn);">🎓 演示站已停用此开关（防止有人把体验站关掉，其他体验者会看不了）</div>' : ''}</div>
          <label class="switch"><input type="checkbox" id="st-siteClosed" ${s.siteClosed === '1' ? 'checked' : ''} ${state.demo ? 'disabled' : ''}><span class="track"></span></label>
        </div>
        <div class="form-item"><label>闭站公告（展示在闭站页，支持换行；留空使用默认文案）</label><textarea class="textarea" id="st-siteClosedMessage" rows="3" maxlength="1000" placeholder="本站暂时关闭，请稍后再来。" ${state.demo ? 'disabled' : ''}>${esc(s.siteClosedMessage || '')}</textarea></div>
      </div>
    </div>

    <div class="panel" style="padding:20px;">
      <div class="form-section"><h3>外部发布</h3><div class="sec-desc">用 Telegram 机器人或开放 API 远程发微博（文字 / 图片 / 相册都可以）</div>
        <div class="form-item">
          <label>API Token（开放接口密钥，重新生成后旧 Token 立即失效）</label>
          <div class="fav-row">
            <input class="input" id="st-externalToken" readonly style="flex:1;min-width:200px;font-family:ui-monospace,monospace;" value="${esc(s.externalToken || '')}" placeholder="未生成，点右侧按钮">
            <button class="btn btn-sm" id="btn-token-gen" type="button">${s.externalToken ? '重新生成' : '生成 Token'}</button>
            <button class="btn btn-sm btn-ghost" id="btn-token-copy" type="button" ${s.externalToken ? '' : 'disabled'}>复制</button>
          </div>
          <div class="sec-desc" style="margin-top:6px;">接口：<code>POST ${esc(location.origin)}/api/external/weibo</code>，用法见 docs/GUIDE.md 第 8 节</div>
        </div>
        <div class="form-item">
          <label>Telegram Bot Token（找 @BotFather 发 /newbot 创建机器人后获得）</label>
          <input class="input" id="st-telegramBotToken" placeholder="123456789:AA…" autocomplete="off" value="${esc(s.telegramBotToken || '')}">
        </div>
        <div class="form-item">
          <label>允许发布的 Chat ID（逗号分隔；给机器人发 /start 可查看自己的 ID）</label>
          <input class="input" id="st-telegramAllowFrom" placeholder="如 123456789" value="${esc(s.telegramAllowFrom || '')}">
        </div>
        <div class="switch-row">
          <div><div class="switch-label">新留言推送到 Telegram</div><div class="switch-sub">文章 / 微博 / 留言板有新留言时推送到白名单第一个 Chat ID（需先填 Bot Token 并设置 Webhook）</div></div>
          <label class="switch"><input type="checkbox" id="st-notifyNewComment" ${s.notifyNewComment === '1' ? 'checked' : ''}><span class="track"></span></label>
        </div>
        <div class="form-item">
          <label>同步频道 / 群 ID（服务端插件「发布同步 Telegram 频道」用，如 @mychannel 或 -100 开头的群 ID）</label>
          <input class="input" id="st-tgChannelChatId" placeholder="@mychannel" value="${esc(s.tgChannelChatId || '')}">
        </div>
        <div class="fav-row">
          <button class="btn" id="btn-tg-webhook" type="button">保存并一键设置 Webhook</button>
          <span class="sec-desc" id="tg-webhook-status"></span>
        </div>
        <div class="sec-desc" style="margin-top:6px;">设置好后在 Telegram 给机器人发文字 / 图片即可发微博；相册多图自动合并成一条；消息开头写 /draft 存草稿</div>
      </div>
    </div>

    <div class="panel" style="padding:20px;">
      <div class="form-section"><h3>服务端插件</h3><div class="sec-desc">随内核运行的官方插件（启停在「插件」页），这里是它们的配置项</div>
        <div class="form-item">
          <label>评论 Webhook 地址（评论 Webhook 推送插件：访客留言时 POST 一段 JSON 到这个地址，飞书 / 企微 / Bark 均可）</label>
          <input class="input" id="st-commentWebhookUrl" placeholder="https://…" value="${esc(s.commentWebhookUrl || '')}">
        </div>
        <div class="form-item">
          <label>页脚自定义代码（页脚自定义代码插件：注入每一页页脚的 HTML，挂件 / 徽章 / 备案图标；受 CSP 保护，外部脚本不会执行）</label>
          <textarea class="textarea" id="st-footerHtmlCode" rows="3" maxlength="5000" placeholder="<div style=&quot;text-align:center&quot;>🌙 已运行 <b>365</b> 天</div>">${esc(s.footerHtmlCode || '')}</textarea>
        </div>
        <div class="form-item">
          <label>Buffer API Key（微博同步 Buffer 插件：buffer.com 注册并连上 X 等社交账号后，在 publish.buffer.com/settings/api 生成；免费档 3 渠道够用）</label>
          <input class="input" id="st-bufferAccessToken" placeholder="pli…" autocomplete="off" value="${esc(s.bufferAccessToken || '')}">
        </div>
        <div class="form-item">
          <label>Buffer 渠道 ID（同步目标；先填 API Key 再点右侧「拉取渠道」选择即可）</label>
          <div class="fav-row">
            <input class="input" id="st-bufferChannelId" style="flex:1;min-width:200px;font-family:ui-monospace,monospace;" placeholder="如 6ac89…" value="${esc(s.bufferChannelId || '')}">
            <button class="btn btn-sm" id="btn-buffer-channels" type="button">拉取渠道</button>
          </div>
          <div class="sec-desc" id="buffer-channels-status" style="margin-top:6px;">同步时机：微博「发布」时自动推一条到所选渠道（X 免费档 280 字符，超出自动截断；#话题 会转成 X 的话题格式）</div>
        </div>
        <div class="form-item">
          <label>广场地址（广场同步插件：文章与微博发布时同步到官网广场 bloghao.com/plaza；留空 = 官方 hub，自建 hub 才填自己的地址）</label>
          <input class="input" id="st-plazaEndpoint" placeholder="留空 = 官方 hub（https://bloghao.com/plaza）" value="${esc(s.plazaEndpoint || '')}">
        </div>
        <div class="form-item">
          <label>广场站点 Token（在广场 hub 注册站点后发放，见 docs/PLAZA.md；未填 = 不同步）</label>
          <input class="input" id="st-plazaToken" placeholder="32 位注册 Token" autocomplete="off" value="${esc(s.plazaToken || '')}">
          <div class="sec-desc" style="margin-top:6px;">同步时机：文章 / 微博「发布」时自动推一条（编辑重发不重推）；加密文与会员专属文不会上广场。启停在「插件」页</div>
        </div>
      </div>
    </div>
    </div>

    <div class="stab-pane" data-pane="data" hidden>
    <div class="panel" style="padding:20px;">
      <div class="form-section"><h3>订阅与备份</h3><div class="sec-desc">把内容完整地交给订阅者，把数据完整地交回自己</div>
        <div class="switch-row">
          <div><div class="switch-label">RSS 输出全文</div><div class="switch-sub">开启后订阅器（Follow / NetNewsWire 等）不点开就能读完；关闭则只输出摘要</div></div>
          <label class="switch"><input type="checkbox" id="st-rssFullText" ${s.rssFullText === '1' ? 'checked' : ''}><span class="track"></span></label>
        </div>
        <div class="switch-row">
          <div><div class="switch-label">每晚自动备份</div><div class="switch-sub">每天北京时间 00:30 把数据库全量快照存进 R2 图床的 backups/ 目录，滚动保留最近 30 份</div></div>
          <label class="switch"><input type="checkbox" id="st-backupEnabled" ${s.backupEnabled === '1' ? 'checked' : ''}><span class="track"></span></label>
        </div>
        <div class="fav-row">
          <button class="btn" id="btn-backup-now" type="button">立即备份</button>
          <span class="sec-desc" id="backup-status">${s.lastBackupAt ? `上次备份：${esc(fmtDateTime(Number(s.lastBackupAt)))}${s.lastBackupBytes ? ' · ' + fmtSize(Number(s.lastBackupBytes)) : ''}` : '从未备份过，点右侧按钮试一次'}</span>
        </div>
      </div>
    </div>

    <div class="panel" style="padding:20px;">
      <div class="form-section"><h3>数据导出</h3><div class="sec-desc">把全部文章（含草稿）、微博、独立页面与被引用的图片打包带走——数据主权；未被引用的图床文件不打包，可在「媒体」里查看。Markdown 包可直接阅读归档，WXR 供 WordPress 等系统导入</div>
        <div class="fav-row">
          <a class="btn" href="/api/admin/export/markdown" download>导出 Markdown 包</a>
          <a class="btn" href="/api/admin/export/wxr" download>导出 WordPress WXR</a>
        </div>
      </div>
    </div>
    </div>`
  )

  // 页签只在页内切换（不动 hash，避免触发 navigate 重挂视图丢未保存输入）；
  // 各页签的输入控件始终留在 DOM，「保存全部」跨页签照常收齐，PUT 缺键保留语义不受影响
  const STAB_HINTS = {
    site: '站名、头像、首页形态这些门面事，以及登录密码',
    social: '留言规则、会员体系与访客统计',
    advance: '闭站等特殊开关与外部服务对接——不确定的先别动',
    data: '备份与导出：把数据完整地交回自己手里',
  }
  const stabBtns = Array.prototype.slice.call(document.querySelectorAll('#settings-tabs .tab'))
  const applyStab = () => {
    stabBtns.forEach((b) => b.classList.toggle('is-active', b.dataset.stab === settingsTab))
    document.querySelectorAll('.stab-pane').forEach((p) => {
      p.hidden = p.dataset.pane !== settingsTab
    })
    const hint = document.getElementById('settings-hint')
    if (hint) hint.textContent = STAB_HINTS[settingsTab] || ''
  }
  stabBtns.forEach((b) =>
    b.addEventListener('click', () => {
      settingsTab = b.dataset.stab
      applyStab()
    })
  )
  applyStab()

  function renderFavSlot(url) {
    document.getElementById('fav-preview-slot').innerHTML = url
      ? `<img class="fav-preview" src="${esc(url)}" alt="站点图标">`
      : '<span class="fav-empty">未设置，使用默认图标</span>'
  }

  function renderAvatarSlot(url) {
    document.getElementById('avatar-preview-slot').innerHTML = url
      ? `<img class="avatar-preview" src="${esc(url)}" alt="站点头像">`
      : '<span class="fav-empty">未设置，显示站名首字</span>'
  }

  document.getElementById('btn-avatar-upload').addEventListener('click', () => {
    pickFiles('image/jpeg,image/png,image/webp,image/gif', false, async (files) => {
      if (!files[0]) return
      try {
        const d = await uploadFile(await compressImage(files[0]))
        document.getElementById('st-avatarUrl').value = d.url
        renderAvatarSlot(d.url)
        toast('头像已上传，记得点「保存全部」生效')
      } catch (e) {
        toast(e.message, true)
      }
    })
  })
  document.getElementById('btn-avatar-clear').addEventListener('click', () => {
    document.getElementById('st-avatarUrl').value = ''
    renderAvatarSlot('')
    toast('已恢复默认，记得点「保存全部」生效')
  })

  document.getElementById('btn-fav-upload').addEventListener('click', () => {
    pickFiles('image/png,image/jpeg,image/webp,image/x-icon,image/vnd.microsoft.icon,.ico,.png', false, async (files) => {
      if (!files[0]) return
      try {
        const d = await uploadFile(await compressImage(files[0]))
        document.getElementById('st-faviconUrl').value = d.url
        renderFavSlot(d.url)
        toast('图标已上传，记得点「保存全部」生效')
      } catch (e) {
        toast(e.message, true)
      }
    })
  })
  document.getElementById('btn-fav-clear').addEventListener('click', () => {
    document.getElementById('st-faviconUrl').value = ''
    renderFavSlot('')
    toast('已恢复默认，记得点「保存全部」生效')
  })

  function renderOgSlot(url) {
    document.getElementById('og-preview-slot').innerHTML = url
      ? `<img class="og-preview" src="${esc(url)}" alt="默认分享卡图">`
      : '<span class="fav-empty">未设置，使用内置卡图</span>'
  }
  document.getElementById('btn-og-upload').addEventListener('click', () => {
    pickFiles('image/png,image/jpeg,image/webp', false, async (files) => {
      if (!files[0]) return
      try {
        const d = await uploadFile(await compressImage(files[0]))
        document.getElementById('st-ogImageDefault').value = d.url
        renderOgSlot(d.url)
        toast('卡图已上传，记得点「保存全部」生效')
      } catch (e) {
        toast(e.message, true)
      }
    })
  })
  document.getElementById('btn-og-clear').addEventListener('click', () => {
    document.getElementById('st-ogImageDefault').value = ''
    renderOgSlot('')
    toast('已恢复内置卡图，记得点「保存全部」生效')
  })

  // 站点模式：三选一 + 双方模式下的首页顺序（落库为 blog-weibo / weibo-blog / blog / weibo 四值）
  const modeGroup = () => document.querySelector('input[name="st-siteModeGroup"]:checked').value
  const modeOrder = () => document.querySelector('input[name="st-siteModeOrder"]:checked').value
  const orderRow = document.getElementById('mode-order-row')
  const syncOrderRow = () => {
    orderRow.hidden = modeGroup() !== 'both'
  }
  document.querySelectorAll('input[name="st-siteModeGroup"]').forEach((r) => r.addEventListener('change', syncOrderRow))
  const savedMode = s.siteMode || 'blog-weibo'
  const modeVal = savedMode === 'blog' || savedMode === 'weibo' ? savedMode : 'both'
  const orderVal = savedMode === 'weibo-blog' ? 'weibo-blog' : 'blog-weibo'
  document.querySelector(`input[name="st-siteModeGroup"][value="${modeVal}"]`).checked = true
  document.querySelector(`input[name="st-siteModeOrder"][value="${orderVal}"]`).checked = true
  syncOrderRow()

  // 语言版本单选回填（英文测试版 English 0.1，键见 src/db.ts DEFAULT_SETTINGS）
  const savedEdition = s.edition === 'en' ? 'en' : 'zh'
  document.querySelector(`input[name="st-edition"][value="${savedEdition}"]`).checked = true

  document.getElementById('btn-save').addEventListener('click', async (e) => {
    const g = (id) => document.getElementById(id)
    const btn = e.currentTarget
    const wasClosed = state.settings.siteClosed === '1'
    const body = {
      siteName: g('st-siteName').value.trim() || '博客号',
      siteDescription: g('st-siteDescription').value.trim(),
      siteUrl: g('st-siteUrl').value.trim(),
      footerText: g('st-footerText').value.trim(),
      faviconUrl: g('st-faviconUrl').value.trim(),
      avatarUrl: g('st-avatarUrl').value.trim(),
      ogImageDefault: g('st-ogImageDefault').value.trim(),
      // 主题不在这里改（皮肤页专职）；body 里不带 theme 键，服务端对缺键即保留
      siteMode: modeGroup() === 'both' ? modeOrder() : modeGroup(),
      edition: (document.querySelector('input[name="st-edition"]:checked') || { value: 'zh' }).value,
      allowComments: g('st-allowComments').checked ? '1' : '0',
      moderateComments: g('st-moderateComments').checked ? '1' : '0',
      postsPerPage: g('st-postsPerPage').value || '10',
      membersEnabled: g('st-membersEnabled').checked ? '1' : '0',
      rankTopN: g('st-rankTopN').value || '10',
      siteGrayscale: g('st-siteGrayscale').checked ? '1' : '0',
      siteClosed: g('st-siteClosed').checked ? '1' : '0',
      siteClosedMessage: g('st-siteClosedMessage').value.trim(),
      telegramBotToken: g('st-telegramBotToken').value.trim(),
      telegramAllowFrom: g('st-telegramAllowFrom').value.trim(),
      tgChannelChatId: g('st-tgChannelChatId').value.trim(),
      commentWebhookUrl: g('st-commentWebhookUrl').value.trim(),
      footerHtmlCode: g('st-footerHtmlCode').value,
      bufferAccessToken: g('st-bufferAccessToken').value.trim(),
      plazaEndpoint: g('st-plazaEndpoint').value.trim(),
      plazaToken: g('st-plazaToken').value.trim(),
      bufferChannelId: g('st-bufferChannelId').value.trim(),
      notifyNewComment: g('st-notifyNewComment').checked ? '1' : '0',
      rssFullText: g('st-rssFullText').checked ? '1' : '0',
      backupEnabled: g('st-backupEnabled').checked ? '1' : '0',
      statsEnabled: g('st-statsEnabled').checked ? '1' : '0',
    }
    // 关站是全站 503 的大动作：开启瞬间必须明确确认（取消时不动按钮状态）
    if (body.siteClosed === '1' && !wasClosed) {
      if (!(await confirmBox('确定关闭站点吗？保存后所有访客和搜索引擎都只能看到闭站页，只有登录后台的你才能恢复访问。'))) return
    }
    btn.disabled = true
    try {
      const d = await api('/admin/settings', { method: 'PUT', body })
      state.settings = d.settings
      toast(!wasClosed && body.siteClosed === '1' ? '站点已关闭：访客现在只能看到闭站页' : '设置已保存 ✅')
    } catch (e) {
      toast(e.message, true)
    } finally {
      btn.disabled = false
    }
  })

  document.getElementById('btn-pw').addEventListener('click', async () => {
    const oldP = document.getElementById('pw-old').value
    const newP = document.getElementById('pw-new').value
    if (!oldP || newP.length < 8) return toast('新密码至少 8 位', true)
    const btn = document.getElementById('btn-pw')
    btn.disabled = true // 连击会发两次 PUT，第二次旧密码已错报「修改失败」盖住成功提示
    try {
      await api('/admin/password', { method: 'PUT', body: { oldPassword: oldP, newPassword: newP } })
      toast('密码已修改')
      document.getElementById('pw-old').value = ''
      document.getElementById('pw-new').value = ''
    } catch (e) {
      toast(e.message, true)
    } finally {
      btn.disabled = false
    }
  })

  const tokenInput = document.getElementById('st-externalToken')
  tokenInput.addEventListener('click', () => tokenInput.select()) // 事件绑定（CSP 禁内联脚本）
  document.getElementById('btn-token-gen').addEventListener('click', async () => {
    if (tokenInput.value && !(await confirmBox('重新生成后旧 Token 立即失效，已配置的外部工具需要更换新 Token。确定？'))) return
    const btn = document.getElementById('btn-token-gen')
    btn.disabled = true // 连击会生成两个 Token，后者使前者失效
    try {
      const d = await api('/admin/external/token', { method: 'POST' })
      tokenInput.value = d.token
      document.getElementById('btn-token-copy').disabled = false
      toast('Token 已生成并保存，同步给外部工具即可使用')
    } catch (e) {
      toast(e.message, true)
    } finally {
      btn.disabled = false
    }
  })
  document.getElementById('btn-token-copy').addEventListener('click', () => {
    if (!tokenInput.value) return
    navigator.clipboard
      .writeText(tokenInput.value)
      .then(() => toast('已复制'))
      .catch(() => toast('复制失败，请手动选择复制', true))
  })

  document.getElementById('btn-tg-webhook').addEventListener('click', async () => {
    const btn = document.getElementById('btn-tg-webhook')
    const statusEl = document.getElementById('tg-webhook-status')
    const botToken = document.getElementById('st-telegramBotToken').value.trim()
    if (!botToken) return toast('先填写 Telegram Bot Token', true)
    btn.disabled = true
    btn.textContent = '设置中…'
    try {
      // 先落库两项 Telegram 配置，再让服务端校验 Token 并调 setWebhook
      await api('/admin/settings', { method: 'PUT', body: { telegramBotToken: botToken, telegramAllowFrom: document.getElementById('st-telegramAllowFrom').value.trim() } })
      state.settings.telegramBotToken = botToken
      const d = await api('/admin/external/telegram/webhook', { method: 'POST' })
      statusEl.textContent = `✅ 已绑定 ${d.bot}`
      toast('Webhook 设置成功，去 Telegram 给机器人发 /start 试试')
    } catch (e) {
      toast(e.message, true)
    }
    btn.disabled = false
    btn.textContent = '保存并一键设置 Webhook'
  })

  document.getElementById('btn-buffer-channels').addEventListener('click', async () => {
    const btn = document.getElementById('btn-buffer-channels')
    const statusEl = document.getElementById('buffer-channels-status')
    const token = document.getElementById('st-bufferAccessToken').value.trim()
    if (!token) return toast('先填写 Buffer API Key', true)
    btn.disabled = true
    btn.textContent = '拉取中…'
    try {
      // 先落库 API Key（渠道端点用它兜底），再拉渠道列表
      await api('/admin/settings', { method: 'PUT', body: { bufferAccessToken: token } })
      state.settings.bufferAccessToken = '••••••••'
      const d = await api('/admin/buffer/channels', { method: 'POST', body: {} })
      statusEl.textContent = '拉到 ' + d.channels.length + ' 个渠道：' + d.channels.map(function (ch) { return ch.displayName + '（' + ch.service + '）' }).join('、')
      const pick = d.channels.find(function (ch) { return ch.service === 'twitter' }) || d.channels[0]
      if (pick) {
        document.getElementById('st-bufferChannelId').value = pick.id
        toast('已填入「' + pick.displayName + '」的渠道 ID，记得点上方保存')
      }
    } catch (e) {
      toast(e.message, true)
    }
    btn.disabled = false
    btn.textContent = '拉取渠道'
  })

  document.getElementById('btn-backup-now').addEventListener('click', async () => {
    const btn = document.getElementById('btn-backup-now')
    const statusEl = document.getElementById('backup-status')
    btn.disabled = true
    btn.textContent = '备份中…'
    try {
      const d = await api('/admin/backup', { method: 'POST' })
      if (d.skipped) {
        statusEl.textContent = '自动备份开关已关闭，先打开再备份'
        toast('自动备份开关已关闭', true)
      } else {
        statusEl.textContent = `上次备份：${fmtDateTime(Date.now())} · ${fmtSize(d.bytes || 0)}`
        toast('备份完成，已存进 R2 的 backups/ 目录 ✅')
      }
    } catch (e) {
      toast(e.message, true)
    }
    btn.disabled = false
    btn.textContent = '立即备份'
  })
}

/* ---------------- 上传（带进度） ----------------
 * 上传前压缩统一走 editor.js 导出的 compressImage（曾在本文件各抄一份，只压 JPEG/PNG 不转 WebP，
 * 已与编辑器策略漂移——现共用一份实现）：JPEG/PNG/WebP 超 150KB 或最长边超 2000px 时先降尺寸再编码，
 * 优先转 WebP（质量 0.75，透明不丢），旧浏览器回退 JPEG/PNG（0.82）；GIF 动图会压丢帧，原样直传；
 * 产物不比原图小用原图；失败回退原文件。 */

function uploadFile(file, onProgress) {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest()
    xhr.open('POST', '/api/admin/upload')
    xhr.responseType = 'json'
    xhr.upload.onprogress = (e) => {
      if (e.lengthComputable && onProgress) onProgress(Math.round((e.loaded / e.total) * 100))
    }
    xhr.onload = () => {
      const d = xhr.response || {}
      if (xhr.status >= 200 && xhr.status < 300) {
        resolve(d)
        return
      }
      // 与 api() 的会话过期兜底同口径：上传期间会话过期也回登录页，别让用户对着「未登录」toast 反复重试
      if (xhr.status === 401 && state.user) {
        state.user = null
        authView('login')
        toast('登录已过期，请重新登录', true)
      }
      reject(new Error(d.error || '上传失败'))
    }
    xhr.onerror = () => reject(new Error('网络错误，上传失败'))
    const fd = new FormData()
    fd.append('file', file)
    xhr.send(fd)
  })
}

/* ---------------- 路由 ---------------- */
function handleApiErr(e) {
  if (e.status === 401) {
    state.user = null
    authView('login')
    return
  }
  toast(e.message || '出错了', true)
}

async function navigate() {
  const seq = ++navSeq
  const h = location.hash.replace(/^#\/?/, '')
  const [path] = h.split('?')
  const parts = path.split('/')
  const name = parts[0] || 'home'
  // 旧路由兼容：分类已并入文章页第二页签（replace 不留历史记录）
  if (name === 'categories') {
    location.replace('#/posts?view=cats')
    return
  }
  clearTimeout(postsSearchTimer)
  clearTimeout(membersSearchTimer)
  // 离开编辑器：有未保存修改先自动保存再切页（此时编辑器 DOM 还在，能取到最新内容）；
  // 保存失败只提示不阻塞导航，避免把用户困在编辑器里。随后摘除编辑器的全局监听与挂起定时器
  if (currentRoute === 'editor' && name !== 'editor') {
    await flushEditorSave().catch(() => toast('离开时自动保存失败，内容可能没存上，请回去检查', true))
    disposeEditor()
    // 保存期间用户又切了页：本次导航过期，放弃
    if (seq !== navSeq) return
  }
  if (name !== 'weibo') wbEditing = null

  if (!state.user) {
    authView(state.needsSetup ? 'setup' : 'login')
    return
  }
  pendingRoute = name
  try {
    if (name === 'home') await viewHome()
    else if (name === 'stats') await viewStats()
    else if (name === 'posts') await viewPosts()
    else if (name === 'weibo') await viewWeibo()
    else if (name === 'links') await viewLinks()
    else if (name === 'pages') await viewPages()
    else if (name === 'trash') await viewTrash()
    else if (name === 'members') await viewMembers()
    else if (name === 'comments') await viewComments()
    else if (name === 'media') await viewMedia()
    else if (name === 'appearance') await viewAppearance()
    else if (name === 'plugins') await viewPlugins()
    else if (name === 'settings') await viewSettings()
    else if (name === 'editor') await viewEditor(parts[1] || 'new')
    else await viewHome()
  } catch (e) {
    currentRoute = name
    handleApiErr(e)
    return
  }
  // 渲染期间路由又变了：currentRoute 保持与新路由一致，由新导航负责更新
  if (seq !== navSeq) return
  currentRoute = name
}

async function viewEditor(id) {
  // 编辑器是独立的全屏页面，不套 shell
  $app.innerHTML = '<div class="editor-page" id="editor-root"><div style="margin:auto;color:var(--sub);">加载编辑器…</div></div>'
  try {
    const disabledPlugins = String(state.settings?.pluginsDisabled || '')
      .split(',')
      .map((x) => x.trim())
      .filter(Boolean)
    await mountEditor(document.getElementById('editor-root'), id === 'new' ? null : Number(id), { disabledPlugins })
  } catch (e) {
    // 401 交给统一拦截回登录页；其余失败渲染明确的错误态，别把用户晾在「加载编辑器…」
    if (e?.status === 401) throw e
    console.error('编辑器加载失败', e)
    $app.innerHTML = `<div class="editor-page"><div style="margin:auto;text-align:center;color:var(--sub);">
      <div style="font-size:15px;margin-bottom:12px;">编辑器加载失败：${esc(e?.message || '未知错误')}</div>
      <a class="btn btn-primary" href="#/posts">返回文章列表</a>
    </div></div>`
  }
}

async function boot() {
  try {
    const st = await api('/auth/state')
    state.user = st.user
    state.needsSetup = st.needsSetup
    state.demo = !!st.demo
  } catch {
    state.user = null
  }
  if (state.user) {
    try {
      const s = await api('/admin/settings')
      state.settings = s.settings
      document.title = `后台 - ${state.settings.siteName}`
    } catch {
      /* ignore */
    }
  }
  navigate()
}

window.addEventListener('hashchange', navigate)
boot()
