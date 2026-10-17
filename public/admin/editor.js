/**
 * 博客号编辑器 —— 微信公众号风格写作区
 *
 * 能力：
 * - 富文本工具栏（标题/加粗斜体/引用/代码/列表/分割线/链接/图片/视频）
 * - 截图粘贴 & 拖拽自动上传到 R2，插入时补 data-w（微信排版规范 1.4.3）
 * - 自动保存草稿 + 发布 / 转草稿 / 预览
 * - Markdown 模式互转
 * - 排版体检：静态检查《微信公众平台编辑器插件开发规范》要点
 * - 插件系统：window.BlogHao.registerPlugin（见 docs/PLUGINS.md）
 */

import { loadEmoji, emojiGridHtml, emojiEditorImg, stripEmojiImgs, insertToken } from './emoji.js'

function esc(s) {
  return String(s ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;')
}

async function api(path, opts = {}) {
  const init = { method: opts.method || 'GET', credentials: 'same-origin', headers: {} }
  if (opts.body !== undefined) {
    init.headers['Content-Type'] = 'application/json'
    init.body = JSON.stringify(opts.body)
  }
  const res = await fetch('/api' + path, init)
  const data = await res.json().catch(() => ({}))
  if (!res.ok) throw Object.assign(new Error(data.error || '请求失败'), { status: res.status })
  return data
}

/* 动态 file input 必须先挂到 DOM 再 click：iOS Safari 对游离节点的选图器能打开、
 * 能选照片，但 change 不回填（文件永远回不到页面），上传静默失败且无任何提示——
 * 手机上「选了图却没动静」即此。挂 body 隐藏，读完文件 / 用户取消即摘除。
 * app.js 的媒体库 / 头像 /favicon / OG 卡图与编辑器图片、视频、封面共用此入口。 */
export function pickFiles(accept, multiple, onFiles) {
  const input = document.createElement('input')
  input.type = 'file'
  if (accept) input.accept = accept
  if (multiple) input.multiple = true
  input.hidden = true
  input.addEventListener('cancel', () => input.remove())
  input.addEventListener('change', () => {
    const files = input.files
    input.remove()
    onFiles(files)
  })
  document.body.appendChild(input)
  input.click()
}

/* ---------- 上传前图片压缩与 WebP 转换（编辑器/封面/OG/后台发布器共用，app.js 直接 import；
 * 前台 site.js 是同参数同行为的 ES5 手工镜像，改任一侧记得同步另一侧） ----------
 * JPEG/PNG/WebP 且「超阈值或最长边超 MAX_DIM」时：先降尺寸再编码，优先转 WebP（质量 0.75——
 * WebP 压缩率高，0.75 已是业内通行的视觉无损甜点，比同画质 JPEG 约再省三成，透明也不丢——
 * 透明 PNG / 带 alpha 的 WebP 都能转）；旧浏览器 canvas 编码不了 WebP（toBlob 静默回退
 * 成 PNG），按产物 type 识别后走 JPEG/PNG 口径（质量 0.82）：非 PNG 一律 JPEG，透明 PNG 只缩尺寸不转格式。
 * GIF（动图会压丢帧）与小且尺寸合规的图原样返回；产物不比原图小也用原图。失败时返回原文件，不阻塞上传。 */
const IMG_COMPRESS = { MAX_DIM: 2000, MIN_BYTES: 150 * 1024, WEBP_QUALITY: 0.75, FALLBACK_QUALITY: 0.82 }

export async function compressImage(file) {
  try {
    if (!/^image\/(jpeg|png|webp)$/.test(file.type)) return file
    const bmp = await createImageBitmap(file)
    const scale = Math.min(1, IMG_COMPRESS.MAX_DIM / Math.max(bmp.width, bmp.height))
    // 体积与尺寸都合规的直通：重编码不会更小，白耗 CPU 还平白叠一代有损
    if (file.size <= IMG_COMPRESS.MIN_BYTES && scale >= 1) {
      bmp.close?.()
      return file
    }
    const w = Math.max(1, Math.round(bmp.width * scale))
    const h = Math.max(1, Math.round(bmp.height * scale))
    const cv = document.createElement('canvas')
    cv.width = w
    cv.height = h
    cv.getContext('2d').drawImage(bmp, 0, 0, w, h)
    const webp = await new Promise((r) => cv.toBlob(r, 'image/webp', IMG_COMPRESS.WEBP_QUALITY))
    if (webp?.type === 'image/webp') {
      bmp.close?.()
      if (webp.size >= file.size) return file
      const name = (file.name || 'image').replace(/\.[^.]+$/, '') + '.webp'
      return new File([webp], name, { type: 'image/webp' })
    }
    const toJpeg = file.type !== 'image/png' || !hasAlpha(bmp)
    bmp.close?.()
    if (scale >= 1 && !toJpeg) return file
    const blob = await new Promise((r) => cv.toBlob(r, toJpeg ? 'image/jpeg' : 'image/png', IMG_COMPRESS.FALLBACK_QUALITY))
    if (!blob || blob.size >= file.size) return file
    const name = (file.name || 'image').replace(/\.[^.]+$/, '') + (toJpeg ? '.jpg' : '.png')
    return new File([blob], name, { type: toJpeg ? 'image/jpeg' : 'image/png' })
  } catch {
    return file
  }
}

function hasAlpha(bmp) {
  // 抽样画到 1x1 看平均透明度：不透明 PNG 转 JPEG 更划算
  const cv = document.createElement('canvas')
  cv.width = cv.height = 1
  const ctx = cv.getContext('2d')
  ctx.drawImage(bmp, 0, 0, 1, 1)
  const d = ctx.getImageData(0, 0, 1, 1).data
  return d[3] < 250
}

/* ---------- OG 分享卡图：标题 + 底图绘成 1200x630 PNG ----------
 * 底图取封面/正文首图，没有则用主题色渐变兜底；标题自动换行居中。 */
const OG_W = 1200
const OG_H = 630

function drawOgCard(title, imgUrl) {
  return new Promise((resolve) => {
    const cv = document.createElement('canvas')
    cv.width = OG_W
    cv.height = OG_H
    const ctx = cv.getContext('2d')
    const finish = () => {
      // 文字阴影 + 三行截断
      const lines = wrapOgTitle(ctx, title, OG_W - 160, 3)
      ctx.textAlign = 'center'
      ctx.textBaseline = 'middle'
      ctx.shadowColor = 'rgba(0,0,0,.55)'
      ctx.shadowBlur = 18
      ctx.fillStyle = '#fff'
      ctx.font = '700 64px -apple-system, "PingFang SC", "Microsoft YaHei", sans-serif'
      const lh = 84
      const startY = OG_H / 2 - ((lines.length - 1) * lh) / 2
      lines.forEach((t, i) => ctx.fillText(t, OG_W / 2, startY + i * lh))
      cv.toBlob((b) => resolve(b ? new File([b], 'og-card.png', { type: 'image/png' }) : null), 'image/png')
    }
    if (!imgUrl) {
      const g = ctx.createLinearGradient(0, 0, OG_W, OG_H)
      g.addColorStop(0, '#2f3a4f')
      g.addColorStop(1, '#12151c')
      ctx.fillStyle = g
      ctx.fillRect(0, 0, OG_W, OG_H)
      finish()
      return
    }
    const img = new Image()
    img.crossOrigin = 'anonymous'
    img.onload = () => {
      // cover 式铺满：按比例裁剪
      const s = Math.max(OG_W / img.naturalWidth, OG_H / img.naturalHeight)
      const w = img.naturalWidth * s
      const h = img.naturalHeight * s
      ctx.drawImage(img, (OG_W - w) / 2, (OG_H - h) / 2, w, h)
      ctx.fillStyle = 'rgba(0,0,0,.38)'
      ctx.fillRect(0, 0, OG_W, OG_H)
      finish()
    }
    img.onerror = () => {
      const g = ctx.createLinearGradient(0, 0, OG_W, OG_H)
      g.addColorStop(0, '#2f3a4f')
      g.addColorStop(1, '#12151c')
      ctx.fillStyle = g
      ctx.fillRect(0, 0, OG_W, OG_H)
      finish()
    }
    img.src = imgUrl
  })
}

function wrapOgTitle(ctx, text, maxWidth, maxLines) {
  const chars = String(text || '').split('')
  const lines = []
  let line = ''
  ctx.font = '700 64px -apple-system, "PingFang SC", "Microsoft YaHei", sans-serif'
  for (const ch of chars) {
    if (ch === '\n') {
      lines.push(line)
      line = ''
      if (lines.length === maxLines) break
      continue
    }
    if (ctx.measureText(line + ch).width > maxWidth && line) {
      lines.push(line)
      line = ch
      if (lines.length === maxLines) break
    } else {
      line += ch
    }
  }
  if (lines.length < maxLines && line) lines.push(line)
  if (lines.length === maxLines && (line || chars.length > lines.join('').length)) {
    lines[maxLines - 1] = lines[maxLines - 1].replace(/.{1}$/, '') + '…'
  }
  return lines.filter(Boolean)
}

async function uploadOgCard(file) {
  const fd = new FormData()
  fd.append('file', file)
  const res = await fetch('/api/admin/og-image', { method: 'POST', body: fd })
  const d = await res.json().catch(() => ({}))
  if (!res.ok) throw new Error(d.error || 'OG 卡图上传失败')
  return d.url
}

function toast(msg, isErr = false) {
  const slot = document.getElementById('toast-slot')
  const el = document.createElement('div')
  el.className = 'toast' + (isErr ? ' toast-err' : '')
  el.textContent = msg
  slot.appendChild(el)
  setTimeout(() => el.remove(), 2600)
}

/* ---------------- 图标 ---------------- */
const IC = {
  undo: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M8 5 4 9l4 4"/><path d="M4 9h10a6 6 0 0 1 0 12h-3"/></svg>',
  redo: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="m16 5 4 4-4 4"/><path d="M20 9H10a6 6 0 0 0 0 12h3"/></svg>',
  bold: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M7 4h6.5a4 4 0 0 1 0 8H7z"/><path d="M7 12h7.5a4 4 0 0 1 0 8H7z"/></svg>',
  italic: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M15 4h-6M15 20H9M14 4 10 20"/></svg>',
  underline: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M7 4v7a5 5 0 0 0 10 0V4M5 20h14"/></svg>',
  strike: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M4 12h16M8 7a4 3 0 1 1 8 0M16 17a4 3 0 1 1-8 0"/></svg>',
  quote: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M5 16V9a4 4 0 0 1 4-4M13 16V9a4 4 0 0 1 4-4"/><path d="M5 16h4M13 16h4"/></svg>',
  code: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="m8 8-4 4 4 4M16 8l4 4-4 4"/></svg>',
  ul: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><circle cx="5" cy="6" r="1" fill="currentColor"/><circle cx="5" cy="12" r="1" fill="currentColor"/><circle cx="5" cy="18" r="1" fill="currentColor"/><path d="M10 6h10M10 12h10M10 18h10"/></svg>',
  ol: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"><text x="3" y="8" font-size="7" fill="currentColor" stroke="none">1.</text><text x="3" y="18" font-size="7" fill="currentColor" stroke="none">2.</text><path d="M11 6h9M11 16h9"/></svg>',
  hr: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M4 12h16M8 6h8M8 18h8" opacity="0.5"/></svg>',
  table: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linejoin="round"><rect x="3" y="4" width="18" height="16" rx="2"/><path d="M3 10h18M9 10v10M15 10v10"/></svg>',
  link: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M10 14a5 5 0 0 0 7.5.5l2-2a5 5 0 0 0-7-7l-1.2 1.1"/><path d="M14 10a5 5 0 0 0-7.5-.5l-2 2a5 5 0 0 0 7 7l1.2-1.1"/></svg>',
  image: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="4" width="18" height="16" rx="2"/><circle cx="9" cy="10" r="1.6"/><path d="m5 19 5.5-5.5L14 17l3-3 4 4"/></svg>',
  video: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linejoin="round"><rect x="3" y="5" width="18" height="14" rx="2.5"/><path d="m10 9.5 5 2.5-5 2.5z" fill="currentColor" stroke="none"/></svg>',
  eraser: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="m5 15 6-6 8 8-3 3H10z"/><path d="M11 9 15 5l6 6-4 4"/></svg>',
  check: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M3 12h4l2.5-6 4 12 2.5-6h5"/></svg>',
  eye: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M2.5 12S6 5.5 12 5.5 21.5 12 21.5 12 18 18.5 12 18.5 2.5 12 2.5 12z"/><circle cx="12" cy="12" r="3"/></svg>',
  cloud: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M7 18a4.5 4.5 0 0 1-.4-9A6 6 0 0 1 18 8.5 4 4 0 0 1 17.5 18z"/></svg>',
  find: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><circle cx="11" cy="11" r="7"/><path d="m20 20-3.5-3.5M8 11h6M11 8v6"/></svg>',
}

/* ---------------- 插件系统 ---------------- */
const plugins = []
const pluginDefs = new Map() // name -> 插件定义。ES module import 有缓存，模块顶层（registerPlugin 调用）只在首次挂载执行一次，重挂载时从这里补注册
let pluginSlotEl = null
let pluginDisabledIds = [] // 本次挂载的停用名单（renderPluginButtons 过滤用）
let saveSelectionHook = null // mountEditor 注入；renderPluginButtons 在模块作用域，拿不到内部的 saveSelection

function renderPluginButtons(ctx) {
  if (!pluginSlotEl) return
  pluginSlotEl.innerHTML = ''
  const off = new Set(pluginDisabledIds)
  for (const p of plugins) {
    // 停用过滤放渲染层：ES module import 有缓存，首次挂载加载过的插件无法靠「不 import」卸载，
    // 只清空重载 + 这里过滤才能让「停用立即生效」；插件定义没有 id 字段，名单是 manifest id，按 name 过滤（文档约定 id 与 name 一致）
    if (off.has(p.name)) continue
    const b = document.createElement('button')
    b.className = 'ed-btn'
    b.type = 'button'
    b.title = p.title || p.name
    b.innerHTML = p.icon || '插件'
    b.addEventListener('click', (e) => {
      e.preventDefault()
      if (saveSelectionHook) saveSelectionHook()
      try {
        p.onClick(ctx)
      } catch (err) {
        console.warn('插件执行出错', err)
      }
    })
    pluginSlotEl.appendChild(b)
  }
}

async function loadPlugins(ctx, disabledIds) {
  let activeIds = null // 本次 manifest 里未停用的插件 id；manifest 拉取失败时保持 null（不补注册也不清场）
  try {
    const res = await fetch('/plugins/manifest.json', { credentials: 'same-origin' })
    if (!res.ok) return
    const list = await res.json()
    if (!Array.isArray(list)) return
    const off = new Set(disabledIds || [])
    activeIds = new Set()
    for (const entry of list) {
      // 清单兼容两种形态：旧版纯文件名字符串，新版对象 { id, file, ... }（后台「插件」页按 id 启停）
      const file = typeof entry === 'string' ? entry : entry && entry.file
      const id = typeof entry === 'string' ? entry.replace(/\.js$/, '') : entry && entry.id
      if (!file || (id && off.has(id))) continue
      if (id) activeIds.add(id)
      try {
        await import('/plugins/' + file)
      } catch (e) {
        console.warn('插件加载失败：', file, e)
      }
    }
  } catch {
    /* 没有插件清单也完全不影响使用 */
  }
  // 远程安装的插件（后台「插件」页从市场/URL 安装，落 R2 下发）：与 manifest 插件同一套
  // 加载 / 停用 / 补注册机制。404（未登录或一台也没装）静默跳过
  try {
    const ir = await fetch('/plugins/installed.json', { credentials: 'same-origin' })
    if (ir.ok) {
      const il = await ir.json()
      if (Array.isArray(il)) {
        for (const entry of il) {
          const rid = entry && typeof entry === 'object' ? entry.id : entry
          if (typeof rid !== 'string' || !rid || off.has(rid) || (activeIds && activeIds.has(rid))) continue
          if (activeIds) activeIds.add(rid)
          try {
            await import('/plugin-files/' + encodeURIComponent(rid))
          } catch (e) {
            console.warn('远程插件加载失败：', rid, e)
          }
        }
      }
    }
  } catch {
    /* 没有远程插件也完全不影响使用 */
  }
  // 首次挂载后 import 恒命中缓存，模块不会再执行 registerPlugin——已加载过的定义从 pluginDefs 补回。
  // 只补 manifest 仍在列且未停用的（activeIds），下线/停用的插件按钮才不会跨挂载残留；
  // 补注册视为一次新的挂载，onMount 一并触发（与 registerPluginDef 同语义）
  if (activeIds) {
    for (const [name, def] of pluginDefs) {
      if (!activeIds.has(name) || plugins.includes(def)) continue
      plugins.push(def)
      if (typeof def.onMount === 'function') {
        try {
          Promise.resolve(def.onMount(ctx)).catch((err) => console.warn('插件 onMount 出错', err))
        } catch (err) {
          console.warn('插件 onMount 出错', err)
        }
      }
    }
  }
  renderPluginButtons(ctx)
}

/* ---------------- 排版体检（依据微信编辑器插件开发规范） ---------------- */
function parseStyle(styleText) {
  const map = {}
  for (const decl of String(styleText || '').split(';')) {
    const i = decl.indexOf(':')
    if (i < 1) continue
    map[decl.slice(0, i).trim().toLowerCase()] = decl.slice(i + 1).trim()
  }
  return map
}

function px(v) {
  const m = /^(-?[\d.]+)px/.exec(String(v || '').trim())
  return m ? parseFloat(m[1]) : null
}

function hasText(el) {
  return (el.textContent || '').trim().length > 0
}

function runChecks(html) {
  const doc = new DOMParser().parseFromString(String(html || ''), 'text/html')
  const issues = []
  const add = (level, rule, msg) => {
    if (!issues.some((x) => x.rule === rule && x.msg === msg)) issues.push({ level, rule, msg })
  }

  doc.body.querySelectorAll('*').forEach((el) => {
    const style = parseStyle(el.getAttribute && el.getAttribute('style'))

    // 1.4 固定宽度
    const w = px(style['width'])
    if (w !== null && w > 120) {
      const exempt = el.closest && el.closest('[data-ignore-width]')
      add(
        'warn',
        '1.4 固定宽度',
        exempt
          ? '存在固定宽度节点（已用 data-ignore-width 豁免，请确认是有意为之）'
          : `检测到固定宽度 ${w}px，窄屏会溢出、宽屏会偏移；建议用百分比宽度，或确认后加 data-ignore-width 豁免`
      )
    }

    // 1.3 行高过小
    const fs = px(style['font-size'])
    const lh = px(style['line-height'])
    const lhUnitless = /^([\d.]+)\s*;?$/.test(String(style['line-height'] || '').trim())
    if (fs && lh && lh < fs) add('warn', '1.3 行高过小', `行高 ${lh}px 小于字号 ${fs}px，多行文字会重叠`)
    if (lhUnitless && parseFloat(style['line-height']) < 1 && hasText(el))
      add('warn', '1.3 行高过小', `行高倍数 ${style['line-height']} 小于 1，多行文字会重叠（若仅为图片拼接可忽略）`)

    // 1.5 height:0 隐藏文字
    const h = px(style['height'])
    if (h !== null && h <= 2 && hasText(el)) add('warn', '1.5 高度为 0', '容器高度接近 0 且含有文字，手机上会被隐藏')

    // 1.6 text-align start/end
    const ta = (style['text-align'] || '').trim().toLowerCase()
    if (ta === 'start' || ta === 'end') add('warn', '1.6 text-align', 'text-align 使用 start/end 在不同设备表现不一致，请改为 left/right/center')

    // 1.8 pre 包正文
    if (el.tagName === 'PRE' && !el.querySelector('code') && hasText(el))
      add('warn', '1.8 pre 标签', 'pre 包裹普通段落不会自动换行，手机上会被截断；正文请用普通段落')

    // 3 字体族
    if (style['font-family']) add('info', '3 字体使用', '不建议自设 font-family，公众号默认字体栈在各端体验最优')

    // 1.2 光标透明（粘贴内容可能带）
    if (/transparent|rgba\(0,\s*0,\s*0,\s*0\)/i.test(style['caret-color'] || ''))
      add('warn', '1.2 caret-color', '光标颜色透明会导致看不到输入位置')

    // 1.1 透明图片
    if (el.tagName === 'IMG' && parseFloat(style.opacity) === 0)
      add('warn', '1.1 opacity', '图片 opacity 为 0：真图被隐藏，发布后无法在编辑器中修改图片')

    // 4.5.2 !important
    if (/!important/i.test(el.getAttribute && el.getAttribute('style') || ''))
      add('warn', '4.5.2 !important', '!important 会破坏平台公共样式与 Dark Mode 转换')

    // 4.1.2 渐变背景上的文字
    if (/gradient/i.test(style['background-image'] || style['background'] || '') && hasText(el))
      add('info', '4.1.2 渐变背景', '文字下方的渐变背景在 Dark Mode 下会被转为纯色，请确认效果')

    // 无障碍：img alt
    if (el.tagName === 'IMG' && !el.getAttribute('alt')) add('info', '无障碍', '图片缺少 alt 描述')
  })

  // 2.1 同标签嵌套 ≥ 10 层
  doc.body.querySelectorAll('section,div,p,span').forEach((el) => {
    let depth = 1
    let cur = el.parentElement
    while (cur && cur !== doc.body) {
      if (cur.tagName === el.tagName) depth++
      cur = cur.parentElement
    }
    if (depth >= 10) {
      add('warn', '2.1 嵌套层级', '同一标签连续嵌套超过 10 层，编辑器会自动精简，建议清理结构')
    }
  })

  // 1.4.3 图片 data-w
  doc.body.querySelectorAll('img').forEach((img) => {
    if (!img.getAttribute('data-w'))
      add('info', '1.4.3 data-w', '图片缺少 data-w（原始像素宽度），加载超时时缺少可靠的宽度兜底；博客号上传的图会自动补上')
  })

  return issues
}

function applyAutoFixes() {
  const editor = document.getElementById('ed-editor')
  // 只改写元素的 style 属性：整段字符串替换会把代码块里讲解的 !important / text-align 示例一并删掉
  editor.querySelectorAll('[style]').forEach((el) => {
    const s = el.getAttribute('style') || ''
    const fixed = s.replace(/\s*!important/gi, '').replace(/text-align\s*:\s*(start|end)/gi, 'text-align: left')
    if (fixed !== s) el.setAttribute('style', fixed)
  })
  markDirty()
}

/* ---------------- HTML → Markdown ---------------- */
function htmlToMd(html) {
  const doc = new DOMParser().parseFromString(html, 'text/html')

  function inline(node) {
    let out = ''
    node.childNodes.forEach((n) => {
      if (n.nodeType === Node.TEXT_NODE) {
        out += n.textContent.replace(/\s+/g, ' ')
        return
      }
      if (n.nodeType !== Node.ELEMENT_NODE) return
      const t = n.tagName.toLowerCase()
      const inner = inline(n)
      if (t === 'br') out += '\n'
      else if (t === 'strong' || t === 'b') out += `**${inner.trim()}**`
      else if (t === 'em' || t === 'i') out += `*${inner.trim()}*`
      else if (t === 'del' || t === 's') out += `~~${inner.trim()}~~`
      else if (t === 'code') out += '`' + n.textContent + '`'
      else if (t === 'a') out += `[${inner.trim()}](${n.getAttribute('href') || ''})`
      else if (t === 'img') {
        // 编辑器插入的表情图还原成文本码（不转 markdown 图片语法）；data-emoji 值就是 [微笑] 这类码
        const emojiCode = n.getAttribute('data-emoji')
        out += emojiCode || `![${n.getAttribute('alt') || ''}](${n.getAttribute('src') || ''})`
      }
      else out += inner
    })
    return out
  }

  const lines = []
  doc.body.childNodes.forEach((n) => {
    if (n.nodeType === Node.TEXT_NODE) {
      if (n.textContent.trim()) lines.push(n.textContent.trim())
      return
    }
    if (n.nodeType !== Node.ELEMENT_NODE) return
    const t = n.tagName.toLowerCase()
    if (/^h[1-4]$/.test(t)) lines.push('#'.repeat(Number(t[1])) + ' ' + inline(n).trim())
    else if (t === 'p' || t === 'section' || t === 'div') {
      const text = inline(n).trim()
      if (text) lines.push(text)
    } else if (t === 'blockquote') lines.push('> ' + inline(n).trim().replace(/\n/g, '\n> '))
    else if (t === 'pre') lines.push('```\n' + n.textContent.replace(/\n$/, '') + '\n```')
    else if (t === 'ul' || t === 'ol') {
      let i = 1
      n.querySelectorAll(':scope > li').forEach((li) => {
        lines.push((t === 'ul' ? '- ' : `${i++}. `) + inline(li).trim())
      })
    } else if (t === 'hr') lines.push('---')
    else if (t === 'table') {
      // GFM 管道表格：首行当表头；单元格内的竖线与换行转义掉防破表。
      // 整表合并成一个元素（行间单 \n）——lines 是用空行 join 的，表格行若逐行 push 会散成段落
      const trs = [...n.querySelectorAll('tr')]
      if (!trs.length) return
      const cells = (tr) =>
        [...tr.querySelectorAll(':scope > th, :scope > td')].map((c) => {
          const text = inline(c).trim().replace(/\|/g, '\\|').replace(/\n/g, ' ')
          return text || ' '
        })
      const head = cells(trs[0])
      const colCount = head.length
      if (!colCount) return
      const rows = ['| ' + head.join(' | ') + ' |', '| ' + Array.from({ length: colCount }, () => '---').join(' | ') + ' |']
      for (const tr of trs.slice(1)) {
        const row = cells(tr)
        rows.push('| ' + Array.from({ length: colCount }, (_, i) => row[i] || ' ').join(' | ') + ' |')
      }
      lines.push(rows.join('\n'))
    }
    else if (t === 'img') lines.push(n.getAttribute('data-emoji') || `![](${n.getAttribute('src') || ''})`)
    else {
      const text = inline(n).trim()
      if (text) lines.push(text)
    }
  })
  return lines.join('\n\n')
}

/* ---------------- 主挂载 ---------------- */
// 编辑器可反复挂载：全局监听器/定时器在每次挂载前先拆掉上一次的，避免累积
let cleanupEditor = null
// 离开编辑器前的自动保存钩子（app.js 在路由切换时调用）
let flushSave = null
export function flushEditorSave() {
  return flushSave ? flushSave() : Promise.resolve()
}

/** 路由离开编辑器时由 app.js 调用：摘除全局监听与挂起的自动保存。
 *  此前清理只在「下一次挂载」时才发生，期间 beforeunload 残留会让任意页面关标签都弹离开确认 */
export function disposeEditor() {
  if (cleanupEditor) cleanupEditor()
}

export async function mountEditor(root, postId, opts = {}) {
  cleanupEditor?.()
  flushSave = null
  // 每次挂载清空插件运行表：残留的按钮以「本次 manifest 有效名单」为准重建；
  // 已加载插件的定义留在 pluginDefs，由 loadPlugins 补注册（import 缓存导致模块不会重新执行）
  plugins.length = 0
  pluginDisabledIds = Array.isArray(opts.disabledPlugins) ? opts.disabledPlugins.map(String) : []
  const post = {
    id: null,
    slug: '',
    title: '',
    content: '',
    summary: '',
    cover: '',
    tags: [],
    categoryId: null,
    status: 'draft',
    pinned: false,
    published_at: null,
    publish_at: null,
    og_image: '',
    minTier: 'all',
    hasPassword: false,
    ai_generated: 0,
  }
  if (postId) {
    const d = await api(`/admin/posts/${postId}`)
    Object.assign(post, d.post, { tags: d.post.tagList || [], categoryId: d.post.categoryId ?? null })
    // og_image 不入库：编辑器里以上传后写进正文的 meta 为准，此处从 cover 派生展示
    post.og_image = post.og_image || ''
  }

  let mdMode = false
  let dirty = false
  let saveTimer = null
  let savedRange = null
  // 插件快捷键的 keydown 监听（插件 ctx 区赋值；cleanupEditor 摘除）
  let onPluginKeys = null
  // markDirty 每次自增：保存完成时若期间又有新输入（seq 变了），不能把 dirty 清掉，
  // 否则飞行中的保存会「吞掉」新输入的已保存状态
  let dirtySeq = 0
  // 保存串行队列：自动保存进行中点「发布」会排队执行，不再静默丢请求造成假成功
  let saveChain = Promise.resolve()

  root.innerHTML = `<div class="editor-page">
  <div class="ed-topbar">
    <a class="ed-back" href="#/posts">← 文章</a>
    <span class="ed-status-pill chip ${post.status === 'published' ? 'chip-green' : 'chip-gray'}" id="ed-pill">${post.status === 'published' ? '已发布' : '草稿'}</span>
    <span class="ed-save-state" id="ed-save-state">—</span>
    <div class="ed-top-ops">
      <button class="btn btn-sm" id="ed-find" title="查找替换 ⌘F">${IC.find} 查找</button>
      <button class="btn btn-sm" id="ed-check" title="按微信排版规范检查正文">${IC.check} 体检</button>
      <button class="btn btn-sm" id="ed-preview">${IC.eye} 预览</button>
      <button class="btn btn-sm" id="ed-save">${IC.cloud} 存草稿</button>
      <button class="btn btn-primary btn-sm" id="ed-publish">${post.status === 'published' ? '更新' : '发布'}</button>
      <button class="btn btn-ghost btn-sm" id="ed-drawer-toggle" title="文章信息">信息</button>
    </div>
  </div>

  <div class="ed-toolbar" id="ed-toolbar">
    <button class="ed-btn" data-cmd="undo" title="撤销 ⌘Z">${IC.undo}</button>
    <button class="ed-btn" data-cmd="redo" title="重做 ⇧⌘Z">${IC.redo}</button>
    <span class="ed-sep"></span>
    <button class="ed-btn ed-btn-md" data-block="h2" title="标题 H2">H2</button>
    <button class="ed-btn ed-btn-md" data-block="h3" title="标题 H3">H3</button>
    <button class="ed-btn ed-btn-md" data-block="h4" title="标题 H4">H4</button>
    <span class="ed-sep"></span>
    <button class="ed-btn" data-cmd="bold" title="加粗 ⌘B">${IC.bold}</button>
    <button class="ed-btn" data-cmd="italic" title="斜体 ⌘I">${IC.italic}</button>
    <button class="ed-btn" data-cmd="underline" title="下划线 ⌘U">${IC.underline}</button>
    <button class="ed-btn" data-cmd="strikeThrough" title="删除线">${IC.strike}</button>
    <span class="ed-sep"></span>
    <button class="ed-btn" data-block="blockquote" title="引用">${IC.quote}</button>
    <button class="ed-btn" data-act="codeblock" title="代码块">${IC.code}</button>
    <button class="ed-btn" data-act="inlinecode" title="行内代码">&lt;/&gt;</button>
    <span class="ed-sep"></span>
    <button class="ed-btn" data-cmd="insertUnorderedList" title="无序列表">${IC.ul}</button>
    <button class="ed-btn" data-cmd="insertOrderedList" title="有序列表">${IC.ol}</button>
    <button class="ed-btn" data-act="hr" title="分割线">${IC.hr}</button>
    <span class="ed-sep"></span>
    <button class="ed-btn" data-act="link" title="链接">${IC.link}</button>
    <button class="ed-btn" data-act="image" title="图片（可粘贴 / 拖拽）">${IC.image}</button>
    <button class="ed-btn" data-act="table" title="表格">${IC.table}</button>
    <button class="ed-btn" data-act="video" title="视频">${IC.video}</button>
    <button class="ed-btn" data-act="clear" title="清除格式">${IC.eraser}</button>
    <button class="ed-btn" data-act="emoji" title="微信表情">😊</button>
    <span class="ed-sep"></span>
    <span id="ed-plugin-slot" style="display:flex;gap:2px;"></span>
  </div>

  <div class="ed-main">
    <div class="ed-center">
      <div class="ed-paper" id="ed-paper">
        <input class="ed-title" id="ed-title" placeholder="输入文章标题…" maxlength="150" value="${esc(post.title)}">
        <div class="ed-rich-wrap">
          <div class="ed-editor" id="ed-editor" contenteditable="true" spellcheck="false" data-placeholder="从这里开始写——支持直接粘贴截图、拖拽上传图片；⌘S 随时保存"></div>
        </div>
        <div class="ed-md-wrap">
          <textarea class="ed-md" id="ed-md" placeholder="Markdown 模式：# 标题 / **加粗** / *斜体* / \`行内代码\` / > 引用 / - 列表 / [链接](url) / ![图](url) / \`\`\`代码块\`\`\` / ---"></textarea>
        </div>
      </div>
    </div>
    <aside class="ed-drawer" id="ed-drawer">
      <button class="ed-drawer-close" id="ed-drawer-close" title="收起">×</button>
      <div class="drawer-title">摘要</div>
      <textarea class="textarea" id="ed-summary" rows="3" maxlength="500" placeholder="不填则自动截取正文前 80 字">${esc(post.summary)}</textarea>

      <div class="drawer-title">封面图</div>
      <div class="cover-box" id="ed-cover-box" title="点击上传封面图">
        ${post.cover ? `<img src="${esc(post.cover)}" id="ed-cover-img"><button class="cover-remove" id="ed-cover-remove" title="移除封面">×</button>` : '＋ 上传封面图'}
      </div>

      <div class="drawer-title">标签</div>
      <div class="tag-box" id="ed-tag-box">
        <input class="tag-input" id="ed-tag-input" placeholder="回车添加，最多 8 个" list="tag-suggestions">
        <datalist id="tag-suggestions"></datalist>
      </div>

      <div class="drawer-title">分类</div>
      <select class="input" id="ed-category">
        <option value="">未分类</option>
      </select>
      <div style="font-size:12px;color:var(--sub);margin-top:6px;">在后台「文章 → 分类标签」里维护</div>

      <div class="drawer-title">谁能看</div>
      <select class="input" id="ed-min-tier">
        <option value="all"${post.minTier === 'member' || post.minTier === 'coffee' || post.minTier === 'top' ? '' : ' selected'}>所有人可见</option>
        <option value="member"${post.minTier === 'member' ? ' selected' : ''}>仅登录会员</option>
        <option value="coffee"${post.minTier === 'coffee' ? ' selected' : ''}>咖啡会员及以上</option>
        <option value="top"${post.minTier === 'top' ? ' selected' : ''}>仅顶级会员</option>
      </select>
      <div style="font-size:12px;color:var(--sub);margin-top:6px;">设为会员可见后，游客与低档位会员只能读到试读部分（正文在服务端截断，不整篇下发）</div>

      <div class="drawer-title">访问密码</div>
      <div class="switch-row">
        <div><div class="switch-label">加密访问</div><div class="switch-sub">访客需输入密码才能阅读全文</div></div>
        <label class="switch"><input type="checkbox" id="ed-locked" ${post.hasPassword ? 'checked' : ''}><span class="track"></span></label>
      </div>
      <div id="ed-lock-picker" style="display:none;">
        <input class="input" type="password" id="ed-password" maxlength="64" autocomplete="new-password"
          placeholder="${post.hasPassword ? '已设置密码：留空保持不变' : '输入这篇文章的访问密码'}">
        <div style="font-size:12px;color:var(--sub);margin-top:6px;">${post.hasPassword ? '直接输入新密码即更换；取消勾选并保存即解除加密' : '取消勾选并保存即解除加密；密码只在服务端做单向哈希，不回显'}。与「谁能看」并用时密码墙优先，解锁后再按档位判定</div>
      </div>

      <div class="drawer-title">链接 Slug</div>
      <input class="input" id="ed-slug" value="${esc(post.slug)}" placeholder="留空则根据标题自动生成">

      <div class="drawer-title">更多</div>
      <div class="switch-row">
        <div><div class="switch-label">置顶文章</div><div class="switch-sub">在首页列表置顶展示</div></div>
        <label class="switch"><input type="checkbox" id="ed-pinned" ${post.pinned ? 'checked' : ''}><span class="track"></span></label>
      </div>
      <div class="switch-row" id="ed-schedule-row">
        <div><div class="switch-label">定时发布</div><div class="switch-sub">到点自动发布并推送 Telegram</div></div>
        <label class="switch"><input type="checkbox" id="ed-scheduled" ${post.status === 'scheduled' ? 'checked' : ''}><span class="track"></span></label>
      </div>
      <div id="ed-schedule-picker" style="display:none;">
        <input class="input" type="datetime-local" id="ed-publish-at" step="60">
        <div style="font-size:12px;color:var(--sub);margin-top:6px;">北京时间，精确到分钟；到点后 1 分钟内自动发布</div>
      </div>
      <div class="switch-row">
        <div><div class="switch-label">AI 生成</div><div class="switch-sub">自愿申报：本文由 AI 生成或 AI 深度参与创作，勾选后文章页显示标注</div></div>
        <label class="switch"><input type="checkbox" id="ed-ai" ${post.ai_generated ? 'checked' : ''}><span class="track"></span></label>
      </div>

      <div class="drawer-title">分享卡图</div>
      <div id="ed-og-box">
        ${post.cover && !post.og_image ? `<div style="font-size:12px;color:var(--sub);line-height:1.7;">分享到微信/TG 时默认用封面图，可生成带标题的专属卡图</div>` : post.og_image ? `<img src="${esc(post.og_image)}" style="width:100%;border-radius:8px;border:1px solid var(--line);" id="ed-og-img"><button class="btn btn-ghost btn-sm" id="ed-og-remove" style="margin-top:6px;">移除卡图</button>` : `<button class="btn btn-sm" id="ed-og-gen" style="width:100%;">生成分享卡图</button>`}
      </div>

      <div style="font-size:12px;color:var(--sub);margin-top:16px;line-height:1.8;">
        发布时间：${post.published_at ? new Date(post.published_at).toLocaleString('zh-CN') : '未发布'}<br>
        图片粘贴后自动上传 R2，外链图片不受影响。
      </div>
    </aside>
  </div>

  <div class="ed-bottombar">
    <span id="ed-count">0 字</span>
    <span id="ed-read">约 1 分钟</span>
    <span class="spacer"></span>
    <button class="ed-link" id="ed-focus-toggle" title="专注模式：隐藏界面只留写作区，Esc 退出">专注</button>
    <button class="ed-link" id="ed-md-toggle" title="Markdown 与富文本互转">Markdown</button>
  </div>
</div>`

  const editor = document.getElementById('ed-editor')
  const mdArea = document.getElementById('ed-md')
  const titleEl = document.getElementById('ed-title')
  const saveState = document.getElementById('ed-save-state')
  const pill = document.getElementById('ed-pill')
  pluginSlotEl = document.getElementById('ed-plugin-slot')
  saveSelectionHook = saveSelection

  /* ---------- 本地草稿兜底（localStorage） ----------
   * 服务端自动保存（1.5s）是主线，这里是最后防线：保存成功前内容只活在内存里，
   * 弱网断线 / 崩溃 / 误关页面就全丢。键按文章 id（新文章 ed-draft-new），
   * 写入节流 2s + 卸载前同步补写；保存成功即清。隐私加固浏览器访问 localStorage
   * 即抛 SecurityError：存取全部吞异常，兜底失效不影响写作。 */
  const draftKey = () => 'ed-draft-' + (post.id || 'new')
  let draftTimer = null
  function writeLocalDraft() {
    clearTimeout(draftTimer)
    try {
      const content = mdMode ? mdArea.value : editor.innerHTML
      if (content.length > 2 * 1024 * 1024) return // 超配额口径，静默跳过（服务端自动保存仍在）
      localStorage.setItem(
        draftKey(),
        JSON.stringify({ t: titleEl.value, c: content, m: mdMode ? 'md' : 'rich', at: Date.now() })
      )
    } catch { /* 配额满 / 隐私模式等，备份失败不阻塞写作 */ }
  }
  function clearLocalDraft() {
    try { localStorage.removeItem(draftKey()) } catch { /* ignore */ }
    // 新文章落库后换了键，旧 'new' 键一起清掉（此刻服务端草稿已接住内容）
    if (post.id) { try { localStorage.removeItem('ed-draft-new') } catch { /* ignore */ } }
  }
  // 写入节流：连续输入不刷屏 localStorage（写入是同步的，会卡输入）
  function scheduleLocalDraft() {
    clearTimeout(draftTimer)
    draftTimer = setTimeout(writeLocalDraft, 2000)
  }


  editor.innerHTML = post.content || ''

  /* ---------- 本地备份恢复检查：备份比服务端内容新且不同 → 弹窗让用户二选一 ----------
   * 只在有差异时问（老文章正常重进不该被打扰）；恢复支持 md 备份（先进 Markdown 模式再回填） */
  checkLocalDraft()
  function checkLocalDraft() {
    let bak = null
    try { bak = JSON.parse(localStorage.getItem(draftKey()) || 'null') } catch { /* 脏数据当不存在 */ }
    if (!bak || typeof bak.c !== 'string') return
    const serverHtml = post.content || ''
    const same = bak.m === 'md' ? false : bak.c === serverHtml
    if (same || !bak.c.trim()) return
    const when = bak.at ? new Date(bak.at).toLocaleString('zh-CN') : '未知时间'
    const m = modal(
      `<div class="modal-head"><span>发现未同步的本地备份</span><button class="modal-close" data-close>×</button></div>
      <div class="modal-body"><div style="font-size:14px;line-height:1.8;">
        上次编辑（${esc(when)}）的内容可能没保存到服务器——停在本页时断网、崩溃或误关都会造成这种情况。
        ${bak.m === 'md' ? '备份是 Markdown 模式的纯文本。' : ''}要恢复吗？</div></div>
      <div class="modal-foot"><button class="btn" id="ld-drop">丢弃备份</button><button class="btn btn-primary" id="ld-restore">恢复备份</button></div>`
    )
    m.mask.querySelector('#ld-restore').addEventListener('click', async () => {
      m.close()
      if (bak.m === 'md') {
        await enterMdMode()
        mdArea.value = bak.c
      } else {
        editor.innerHTML = bak.c
      }
      markDirty() // 立即触发自动保存，把恢复的内容推上服务端
      updateCount()
      toast('本地备份已恢复，正在自动保存…')
    })
    m.mask.querySelector('#ld-drop').addEventListener('click', () => {
      m.close()
      clearLocalDraft()
      toast('已丢弃本地备份')
    })
  }

  /* ---------- 选择保存 / 恢复 ---------- */
  function saveSelection() {
    const sel = window.getSelection()
    if (sel && sel.rangeCount && editor.contains(sel.anchorNode)) savedRange = sel.getRangeAt(0).cloneRange()
  }
  function restoreSelection() {
    const sel = window.getSelection()
    if (!sel) return
    if (savedRange && editor.contains(savedRange.commonAncestorContainer)) {
      sel.removeAllRanges()
      sel.addRange(savedRange)
    } else {
      const r = document.createRange()
      r.selectNodeContents(editor)
      r.collapse(false)
      sel.removeAllRanges()
      sel.addRange(r)
    }
  }

  /* ---------- 插入 ---------- */
  function insertHTML(html) {
    editor.focus()
    restoreSelection()
    let ok = false
    try {
      ok = document.execCommand('insertHTML', false, html)
    } catch {
      ok = false
    }
    if (!ok) {
      const sel = window.getSelection()
      const r = sel && sel.rangeCount ? sel.getRangeAt(0) : document.createRange()
      r.deleteContents()
      const tpl = document.createElement('template')
      tpl.innerHTML = html
      r.insertNode(tpl.content)
      r.collapse(false)
    }
    markDirty()
    updateCount()
  }

  /* ---------- 图片探测 data-w ---------- */
  function probeWidth(url) {
    return new Promise((resolve) => {
      const img = new Image()
      const timer = setTimeout(() => resolve(null), 4000)
      img.onload = () => {
        clearTimeout(timer)
        resolve(img.naturalWidth || null)
      }
      img.onerror = () => {
        clearTimeout(timer)
        resolve(null)
      }
      img.src = url
    })
  }

  async function uploadAndInsert(file) {
    saveState.textContent = `上传中 ${file.name}…`
    try {
      const out = await compressImage(file)
      const d = await uploadFile(out, (p) => (saveState.textContent = `上传中 ${p}%`))
      const w = await probeWidth(d.url)
      const name = (file.name || '').replace(/\.[^.]+$/, '')
      if (file.type.startsWith('video/')) {
        insertHTML(`<video src="${esc(d.url)}" controls playsinline style="width:100%;"></video><p><br></p>`)
      } else {
        insertHTML(`<img src="${esc(d.url)}"${w ? ` data-w="${w}"` : ''} alt="${esc(name)}"><p><br></p>`)
      }
      saveState.textContent = '图片已插入 ✅'
      markDirty()
    } catch (e) {
      saveState.textContent = '上传失败'
      toast(e.message, true)
    }
  }

  function uploadFile(file, onProgress) {
    return new Promise((resolve, reject) => {
      const xhr = new XMLHttpRequest()
      xhr.open('POST', '/api/admin/upload')
      xhr.responseType = 'json'
      xhr.upload.onprogress = (e) => e.lengthComputable && onProgress && onProgress(Math.round((e.loaded / e.total) * 100))
      xhr.onload = () => {
        const d = xhr.response || {}
        if (xhr.status >= 200 && xhr.status < 300) {
          resolve(d)
          return
        }
        // 会话过期：本模块不持后台路由状态，回 /admin/ 让 SPA 重新校验会话（无会话即落登录页）
        if (xhr.status === 401) {
          location.href = '/admin/'
          reject(new Error('登录已过期，请重新登录'))
          return
        }
        reject(new Error(d.error || '上传失败'))
      }
      xhr.onerror = () => reject(new Error('网络错误，上传失败'))
      const fd = new FormData()
      fd.append('file', file)
      xhr.send(fd)
    })
  }

  /* ---------- 状态 & 保存 ---------- */
  function updateCount() {
    const n = (editor.innerText || '').replace(/\s/g, '').length
    document.getElementById('ed-count').textContent = `${n} 字`
    document.getElementById('ed-read').textContent = `约 ${Math.max(1, Math.ceil(n / 400))} 分钟`
  }

  function markDirty() {
    dirty = true
    dirtySeq++
    saveState.textContent = '有未保存更改'
    scheduleLocalDraft()
    clearTimeout(saveTimer)
    // catch 兜底：md 模式转换失败等异常不能变成 unhandled rejection
    saveTimer = setTimeout(() => save(false).catch(() => {}), 1500)
  }

  function collect(extra = {}) {
    const catVal = document.getElementById('ed-category').value
    // 查找高亮不进存库内容：序列化前剥掉 mark——只剥 DOM 不清 findHits，
    // 自动保存（collect 的主调用方）不能毁掉用户正在进行的查找/替换状态
    if (!mdMode) stripFindMarks()
    // 访问密码只在「有话可说」时才带上 password 键（服务端缺键即保留）：
    // 勾选且填了 = 设置/更换；取消勾选且原来加密 = 空串解除；
    // 勾选但没填 = 保持现状（新建文另由 publish() 拦下要求必填），自动保存永远不会误清密码
    let passwordPatch = {}
    if (!lockSwitch.checked) {
      if (post.hasPassword) passwordPatch = { password: '' }
    } else if (passwordInput.value) {
      passwordPatch = { password: passwordInput.value }
    }
    return {
      title: titleEl.value.trim(),
      content: stripEmojiImgs(editor.innerHTML),
      summary: document.getElementById('ed-summary').value.trim(),
      cover: post.cover,
      tags: post.tags,
      categoryId: catVal ? Number(catVal) : null,
      pinned: document.getElementById('ed-pinned').checked,
      minTier: document.getElementById('ed-min-tier').value,
      aiGenerated: document.getElementById('ed-ai').checked ? 1 : 0,
      slug: document.getElementById('ed-slug').value.trim(),
      status: post.status,
      publishAt: post.publish_at,
      ...passwordPatch,
      ...extra,
    }
  }

  function save(publishIntent) {
    // 排队执行：前一次保存（无论成败）结束后才跑下一次，保证点「发布」时
    // 一定把当前内容与状态真正发出去，而不是被飞行中的自动保存顶掉
    const run = async () => {
      if (mdMode) {
        const d = await api('/admin/tools/md', { method: 'POST', body: { md: mdArea.value } })
        editor.innerHTML = d.html
      }
      const payload = collect(publishIntent && publishIntent.status ? publishIntent : {})
      if (!payload.title && !payload.content.replace(/<[^>]+>/g, '').trim()) return
      saveState.textContent = '保存中…'
      const seqAtSave = dirtySeq
      try {
        if (post.id) {
          const d = await api(`/admin/posts/${post.id}`, { method: 'PUT', body: payload })
          Object.assign(post, d.post, { tags: d.post.tagList || post.tags })
          post.cover = payload.cover
          post.tags = payload.tags
        } else {
          const d = await api('/admin/posts', { method: 'POST', body: payload })
          post.id = d.post.id
          post.slug = d.post.slug
          post.cover = payload.cover
          post.tags = payload.tags
          // 无 hashchange 的地址替换，避免重挂载丢失光标
          history.replaceState(null, '', `#/editor/${post.id}`)
        }
        document.getElementById('ed-slug').value = post.slug
        if (dirtySeq === seqAtSave) {
          dirty = false
          clearTimeout(saveTimer)
          clearLocalDraft()
          const t = new Date()
          saveState.textContent = `已保存 ${String(t.getHours()).padStart(2, '0')}:${String(t.getMinutes()).padStart(2, '0')}`
        } else {
          saveState.textContent = '有未保存更改'
        }
        // 成功即摘掉失败时挂的「点击重试」，避免之后点「已保存 HH:MM」误触发保存
        saveState.onclick = null
        saveState.style.cursor = ''
        const pillText = post.status === 'published' ? '已发布' : post.status === 'scheduled' ? `定时 ${fmtSchedule(post.publish_at)}` : '草稿'
        pill.textContent = pillText
        pill.className = `ed-status-pill chip ${post.status === 'published' ? 'chip-green' : post.status === 'scheduled' ? 'chip-warn' : 'chip-gray'}`
        document.getElementById('ed-publish').textContent = post.status === 'published' ? '更新' : '发布'
        return post
      } catch (e) {
        saveState.textContent = '保存失败，点击重试'
        saveState.style.cursor = 'pointer'
        saveState.onclick = () => save(false)
        throw e
      }
    }
    const p = saveChain.then(run, run)
    // 链子吞掉失败继续排下一次；真正的失败由返回的 p 抛给调用方
    saveChain = p.then(
      () => {},
      () => {}
    )
    return p
  }

  async function ensureSaved() {
    if (dirty || !post.id) {
      const saved = await save(false).catch(() => null)
      // 保存失败返回 null：调用方必须中止（预览旧版本会造成「已保存」的错觉）
      if (!saved) return null
    }
    return post
  }

  /** 定时时间展示：缺年（当年）只显示 月-日 时:分 */
  function fmtSchedule(ts) {
    if (!ts) return '未设时间'
    const d = new Date(ts)
    const now = new Date()
    const sameYear = d.getFullYear() === now.getFullYear()
    const p = (n) => String(n).padStart(2, '0')
    return `${sameYear ? '' : d.getFullYear() + '/'}${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`
  }

  async function publish() {
    if (!titleEl.value.trim()) {
      titleEl.focus()
      return toast('发布前先取个标题吧', true)
    }
    // 新文章开了加密但还没填密码：拦下来要求必填（老文章留空 = 保持原密码，不拦）
    if (lockSwitch.checked && !passwordInput.value && !post.hasPassword) {
      lockPicker.scrollIntoView({ block: 'center', behavior: 'smooth' })
      passwordInput.focus()
      return toast('开了加密访问就要填一个访问密码', true)
    }
    if (mdMode) {
      // Markdown → HTML 转换失败要明确告知（弱网/接口 500 时不能「点了没反应」）
      try {
        await exitMdMode()
      } catch (e) {
        return toast(e?.message || '正文转换失败，请重试', true)
      }
    }
    // 记下发布前的真实状态：保存失败时精确回滚（不能猜，也不能写反）
    const prevStatus = post.status
    const prevPublishAt = post.publish_at
    // 勾了定时：保存为 scheduled，到点由 cron 自动发布
    const wantScheduled = document.getElementById('ed-scheduled')?.checked
    const atInput = document.getElementById('ed-publish-at')
    if (wantScheduled) {
      if (!atInput || !atInput.value) {
        document.getElementById('ed-schedule-row')?.scrollIntoView({ block: 'center', behavior: 'smooth' })
        atInput?.focus()
        return toast('定了时要选一个发布时间', true)
      }
      const ts = new Date(atInput.value).getTime()
      if (!Number.isFinite(ts)) return toast('发布时间格式不对', true)
      if (ts < Date.now() - 60_000) return toast('发布时间已经过去了，选个未来的时间吧', true)
      post.status = 'scheduled'
      post.publish_at = ts
    } else {
      post.status = 'published'
      post.publish_at = null
    }
    try {
      await save()
      document.getElementById('ed-publish').textContent = '更新'
      toast(
        post.status === 'scheduled'
          ? `已定时：${fmtSchedule(post.publish_at)} 自动发布并推送 Telegram ⏰`
          : '发布成功 🎉 点击「预览」查看文章'
      )
    } catch (e) {
      post.status = prevStatus
      post.publish_at = prevPublishAt
      toast(e.message, true)
    }
  }

  /* ---------- 工具栏行为 ---------- */
  function currentBlock() {
    const sel = window.getSelection()
    if (!sel || !sel.anchorNode) return null
    let n = sel.anchorNode.nodeType === Node.ELEMENT_NODE ? sel.anchorNode : sel.anchorNode.parentElement
    while (n && n !== editor) {
      if (/^(H1|H2|H3|H4|BLOCKQUOTE|P|PRE)$/.test(n.tagName)) return n
      n = n.parentElement
    }
    return null
  }

  function toggleBlock(tag) {
    editor.focus()
    const cur = currentBlock()
    if (cur && cur.tagName.toLowerCase() === tag) document.execCommand('formatBlock', false, 'p')
    else document.execCommand('formatBlock', false, tag)
    markDirty()
    refreshToolbarState()
  }

  function refreshToolbarState() {
    if (mdMode) return
    const cmds = ['bold', 'italic', 'underline', 'strikeThrough', 'insertUnorderedList', 'insertOrderedList']
    root.querySelectorAll('[data-cmd]').forEach((b) => {
      const cmd = b.dataset.cmd
      if (cmds.includes(cmd)) {
        let on = false
        try {
          on = document.queryCommandState(cmd)
        } catch {
          on = false
        }
        b.classList.toggle('is-active', on)
      }
    })
    const cur = currentBlock()
    root.querySelectorAll('[data-block]').forEach((b) => {
      const tag = b.dataset.block
      b.classList.toggle('is-active', !!cur && cur.tagName.toLowerCase() === tag)
    })
  }

  root.querySelector('.ed-toolbar').addEventListener('mousedown', (e) => {
    // 防止工具栏抢焦点导致选区丢失
    if (e.target.closest('.ed-btn')) e.preventDefault()
  })

  root.querySelector('.ed-toolbar').addEventListener('click', async (e) => {
    const btn = e.target.closest('.ed-btn')
    if (!btn) return
    const { cmd, block, act } = btn.dataset
    if (cmd) {
      editor.focus()
      document.execCommand(cmd, false, null)
      markDirty()
      refreshToolbarState()
      return
    }
    if (block) return toggleBlock(block)
    if (act === 'codeblock') {
      const text = window.getSelection().toString() || '// 在这里写代码'
      insertHTML(`<pre><code>${esc(text)}</code></pre><p><br></p>`)
    } else if (act === 'inlinecode') {
      const text = window.getSelection().toString() || '代码'
      insertHTML(`<code>${esc(text)}</code>&nbsp;`)
    } else if (act === 'hr') {
      insertHTML('<hr><p><br></p>')
    } else if (act === 'link') {
      await linkDialog()
    } else if (act === 'image') {
      await imageDialog()
    } else if (act === 'table') {
      insertTable()
    } else if (act === 'video') {
      pickVideoFile()
    } else if (act === 'clear') {
      editor.focus()
      document.execCommand('removeFormat')
      document.execCommand('formatBlock', false, 'p')
      markDirty()
    } else if (act === 'emoji') {
      await emojiDialog()
    }
    refreshToolbarState()
  })

  // 编辑器获得焦点期间同步工具栏高亮（document 级，挂载/卸载要成对）
  const onSelectionChange = () => {
    if (document.activeElement === editor) refreshToolbarState()
  }
  document.addEventListener('selectionchange', onSelectionChange)

  /* ---------- 对话框们 ---------- */
  /* ---------- 微信表情（文本码体系，渲染层 [微笑]→站内小图；存库永远是文本码） ---------- */
  async function emojiDialog() {
    await loadEmoji()
    const m = modal(
      `<div class="modal-head"><span>微信表情</span><button class="modal-close" data-close>×</button></div>
      <div class="modal-body wxq-modal-body">${emojiGridHtml()}</div>`
    )
    // 点击插入不关面板（连续选表情）；富文本插 img（保存时反替换为文本码），Markdown 模式直接插码
    m.mask.addEventListener('click', (e) => {
      const cell = e.target.closest('[data-wxq]')
      if (!cell) return
      const name = cell.getAttribute('data-wxq')
      if (mdMode) {
        insertToken(mdArea, `[${name}]`)
      } else {
        insertHTML(emojiEditorImg(name))
      }
      markDirty()
    })
  }

  /* ---------- 卡片 HTML 组装（服务端 src/linkmeta.ts linkCardHtml 的手工镜像，
     两侧同改；esc 为编辑器内的属性转义） ---------- */
  function clampCardText(s, n) {
    const t = String(s || '').replace(/\s+/g, ' ').trim()
    const chars = Array.from(t)
    return chars.length > n ? chars.slice(0, n).join('') + '…' : t
  }
  function hostOfUrl(u) {
    try { return new URL(u).hostname } catch { return '' }
  }
  function linkCardHtmlClient(input) {
    const host = clampCardText(input.siteName, 30) || hostOfUrl(input.url)
    const title = clampCardText(input.title, 40) || host || '打开链接'
    const desc = clampCardText(input.description, 64)
    const img = String(input.image || '').trim()
    // 站内相对地址（/post/…）解析不出 host，host 位可能为空——空则不出该行
    const hostPart = host ? `<span class="lc-host">${esc(host)}</span>` : ''
    // 内部全用 span（块级 div 会在 <p> 内插入时把段落截断、卡片散架，与服务端同口径）
    const textPart =
      `<span class="lc-title">${esc(title)}</span>` +
      (desc ? `<span class="lc-desc">${esc(desc)}</span>` : '') +
      hostPart
    const body = img
      ? `<span class="lc-body"><span class="lc-text">${textPart}</span><img class="lc-img" src="${esc(img)}" alt="" loading="lazy"></span>`
      : `<span class="lc-body"><span class="lc-text">${textPart}</span></span>`
    return `<a class="link-card" data-link-card="link-card" href="${esc(input.url)}" target="_blank" rel="noopener noreferrer">${body}</a><p><br></p>`
  }

  async function linkDialog() {
    saveSelection()
    const selText = window.getSelection().toString()
    // Markdown 模式：插入目标只有 textarea，弹窗退化成「普通链接」单页签（卡片/文章选择是富文本能力）
    if (mdMode) {
      const m = modal(`<div class="modal-head"><span>插入链接</span><button class="modal-close" data-close>×</button></div>
      <div class="modal-body">
        <div class="auth-field"><label>链接地址</label><input class="input" id="lk-url2" placeholder="https://…"></div>
        <div class="auth-field"><label>文字（留空则显示地址）</label><input class="input" id="lk-text" value="${esc(selText)}"></div>
      </div>
      <div class="modal-foot"><button class="btn" data-close>取消</button><button class="btn btn-primary" id="lk-ok">插入</button></div>`)
      m.mask.querySelector('#lk-url2').focus()
      const doMd = () => {
        let url = m.mask.querySelector('#lk-url2').value.trim()
        const text = m.mask.querySelector('#lk-text').value.trim()
        if (!url) return
        if (!/^(https?:\/\/|mailto:|#|\/)/i.test(url)) url = 'https://' + url
        m.close()
        insertToken(mdArea, `[${text || url}](${url})`)
        markDirty()
      }
      m.mask.querySelector('#lk-ok').addEventListener('click', doMd)
      m.mask.addEventListener('keydown', (e) => {
        if (e.isComposing || e.keyCode === 229) return
        if (e.key === 'Enter') doMd()
      })
      return
    }
    const m = modal(`<div class="modal-head"><span>插入链接</span><button class="modal-close" data-close>×</button></div>
      <div class="modal-body upload-dialog">
        <div class="tab-line"><button class="is-active" data-tab="card">网址卡片</button><button data-tab="plain">普通链接</button><button data-tab="post">站内文章</button></div>
        <div data-pane="card">
          <div class="auth-field"><label>链接地址</label><input class="input" id="lk-url" placeholder="https://…"></div>
          <div id="lk-meta" style="display:none;">
            <div class="lk-meta-row">
              ${'' /* 预览由抓取结果回填 */}
            </div>
          </div>
          <div style="font-size:12px;color:var(--sub);margin-top:6px;">自动抓取标题、摘要与配图生成卡片；抓不到时用域名占位。想用普通的蓝色超链接请切「普通链接」。</div>
        </div>
        <div data-pane="plain" style="display:none;">
          <div class="auth-field"><label>链接地址</label><input class="input" id="lk-url2" placeholder="https://…"></div>
          <div class="auth-field"><label>文字（留空则显示地址）</label><input class="input" id="lk-text" value="${esc(selText)}"></div>
        </div>
        <div data-pane="post" style="display:none;">
          <input class="input" id="lk-q" placeholder="搜索文章标题，留空看最新发布">
          <div class="lk-post-list" id="lk-posts"><div style="color:var(--sub);font-size:13px;padding:20px;text-align:center;">加载中…</div></div>
          <div style="display:flex;align-items:center;justify-content:space-between;margin-top:10px;">
            <span id="lk-page" style="font-size:12px;color:var(--sub);"></span>
            <span style="display:flex;gap:8px;">
              <button class="btn btn-sm" id="lk-prev" disabled>上一页</button>
              <button class="btn btn-sm" id="lk-next" disabled>下一页</button>
            </span>
          </div>
          <div style="font-size:12px;color:var(--sub);margin-top:8px;">选择文章后可选插入样式；仅列已发布文章，加密文会带锁标记。</div>
        </div>
      </div>
      <div class="modal-foot">
        <label id="lk-style" style="display:none;align-items:center;gap:6px;font-size:13px;color:var(--sub);cursor:pointer;margin-right:auto;">
          <input type="radio" name="lk-style" value="card" checked>卡片
          <input type="radio" name="lk-style" value="link" style="margin-left:8px;">超链接
        </label>
        <button class="btn" data-close>取消</button><button class="btn btn-primary" id="lk-ok">插入</button>
      </div>`)
    m.mask.querySelector('#lk-url').focus()

    /* ---- 页签 1：网址卡片 ---- */
    const metaState = { fetched: '', meta: null, loading: false } // 抓取结果缓存：预览与插入共用，不重复打接口
    const metaBox = m.mask.querySelector('#lk-meta')
    let metaTimer = null
    async function fetchCardMeta(url) {
      metaState.loading = true
      metaBox.style.display = ''
      metaBox.innerHTML = '<div style="font-size:12px;color:var(--sub);padding:8px 0;">正在抓取页面信息…</div>'
      try {
        const d = await api('/admin/tools/linkmeta', { method: 'POST', body: { url } })
        if (metaState.fetched !== url) return // 用户又改了地址，过期结果不回填
        metaState.meta = d.meta || {}
        const meta = metaState.meta
        const img = meta.image ? `<img class="lk-meta-img" src="${esc(meta.image)}" alt="">` : ''
        const title = meta.title || hostOfUrl(url) || url
        const desc = meta.description ? `<div class="lk-meta-desc">${esc(clampCardText(meta.description, 64))}</div>` : ''
        metaBox.innerHTML =
          `<div style="font-size:12px;color:var(--sub);margin-bottom:6px;">将生成以下卡片：</div>` +
          `<div class="lk-meta-card"><div class="lk-meta-text"><div class="lk-meta-title">${esc(clampCardText(title, 40))}</div>${desc}</div>${img}</div>`
      } catch (e) {
        if (metaState.fetched === url) {
          metaState.meta = null
          metaBox.innerHTML = `<div style="font-size:12px;color:var(--sub);padding:8px 0;">抓取失败（${esc(e.message || '网络错误')}），将用域名占位生成卡片。</div>`
        }
      } finally {
        metaState.loading = false
      }
    }
    m.mask.querySelector('#lk-url').addEventListener('input', (e) => {
      const url = e.target.value.trim()
      metaState.fetched = url
      metaState.meta = null
      clearTimeout(metaTimer)
      if (!url) { metaBox.style.display = 'none'; metaBox.innerHTML = ''; return }
      metaTimer = setTimeout(() => fetchCardMeta(url), 500)
    })

    /* ---- 页签 3：站内文章 ---- */
    let postPage = 1
    let postTotalPages = 1
    let postQ = ''
    let selectedPost = null
    const postList = m.mask.querySelector('#lk-posts')
    async function loadPosts() {
      postList.innerHTML = '<div style="color:var(--sub);font-size:13px;padding:20px;text-align:center;">加载中…</div>'
      try {
        const d = await api(`/admin/posts/lookup?page=${postPage}${postQ ? `&q=${encodeURIComponent(postQ)}` : ''}`)
        postTotalPages = d.totalPages || 1
        if (!d.items.length) {
          postList.innerHTML = '<div style="color:var(--sub);font-size:13px;padding:20px;text-align:center;">没有匹配的文章</div>'
        } else {
          postList.innerHTML = d.items
            .map(
              (p) => `<div class="lk-post-item${selectedPost && selectedPost.id === p.id ? ' is-active' : ''}" data-id="${p.id}" data-slug="${esc(p.slug)}" data-title="${esc(p.title)}" data-cover="${esc(p.cover)}" data-summary="${esc(p.summary)}" data-pw="${p.hasPassword ? 1 : 0}" data-tier="${esc(p.minTier)}">
              <div class="lk-post-title">${esc(p.title)}${p.hasPassword ? ' 🔒' : ''}${p.minTier && p.minTier !== 'all' ? ' · 会员' : ''}</div>
              ${p.cover ? `<img class="lk-post-cover" src="${esc(p.cover)}" alt="" loading="lazy">` : ''}
            </div>`
            )
            .join('')
        }
        m.mask.querySelector('#lk-page').textContent = d.total ? `共 ${d.total} 篇 · ${d.page}/${postTotalPages} 页` : ''
        m.mask.querySelector('#lk-prev').disabled = postPage <= 1
        m.mask.querySelector('#lk-next').disabled = postPage >= postTotalPages
      } catch (e) {
        postList.innerHTML = `<div style="color:var(--sub);font-size:13px;padding:20px;text-align:center;">${esc(e.message || '加载失败')}</div>`
      }
    }
    let qTimer = null
    m.mask.querySelector('#lk-q').addEventListener('input', (e) => {
      clearTimeout(qTimer)
      qTimer = setTimeout(() => {
        postQ = e.target.value.trim()
        postPage = 1
        loadPosts()
      }, 300)
    })
    m.mask.querySelector('#lk-prev').addEventListener('click', () => { if (postPage > 1) { postPage--; loadPosts() } })
    m.mask.querySelector('#lk-next').addEventListener('click', () => { if (postPage < postTotalPages) { postPage++; loadPosts() } })
    postList.addEventListener('click', (e) => {
      const item = e.target.closest('.lk-post-item')
      if (!item) return
      selectedPost = {
        slug: item.dataset.slug,
        title: item.dataset.title,
        cover: item.dataset.cover,
        summary: item.dataset.summary,
        pw: item.dataset.pw === '1',
        tier: item.dataset.tier,
      }
      postList.querySelectorAll('.lk-post-item').forEach((el) => el.classList.remove('is-active'))
      item.classList.add('is-active')
      // 站内文打开样式选择（默认卡片）
      m.mask.querySelector('#lk-style').style.display = 'flex'
    })
    loadPosts()

    /* ---- 页签切换 ---- */
    m.mask.querySelectorAll('.tab-line button').forEach((btn) => {
      btn.addEventListener('click', () => {
        m.mask.querySelectorAll('.tab-line button').forEach((b) => b.classList.remove('is-active'))
        btn.classList.add('is-active')
        const tab = btn.dataset.tab
        m.mask.querySelectorAll('[data-pane]').forEach((p) => { p.style.display = p.dataset.pane === tab ? '' : 'none' })
        // 站内文章页签显示样式选择，其余隐藏
        m.mask.querySelector('#lk-style').style.display = tab === 'post' && selectedPost ? 'flex' : 'none'
        if (tab === 'card') m.mask.querySelector('#lk-url').focus()
        else if (tab === 'plain') m.mask.querySelector('#lk-url2').focus()
        else m.mask.querySelector('#lk-q').focus()
      })
    })

    /* ---- 插入 ---- */
    const ok = m.mask.querySelector('#lk-ok')
    const doInsert = async () => {
      const activeTab = m.mask.querySelector('.tab-line .is-active').dataset.tab
      if (activeTab === 'card') {
        let url = m.mask.querySelector('#lk-url').value.trim()
        if (!url) return
        if (!/^(https?:\/\/|mailto:|#|\/)/i.test(url)) url = 'https://' + url
        // 预览抓成功过的结果直接用（metaState 缓存）；没等到就插入则用域名占位
        let meta = metaState.fetched === url ? metaState.meta || null : null
        if (metaState.loading && metaState.fetched === url) {
          toast('正在抓取页面信息，稍等片刻再插入可得完整卡片；已先用占位插入', true)
        }
        const title = (meta && meta.title) || hostOfUrl(url) || url
        m.close()
        restoreSelection()
        insertHTML(
          linkCardHtmlClient({
            url,
            title,
            description: meta ? meta.description : '',
            image: meta ? meta.image : '',
            siteName: meta ? meta.siteName : '',
          })
        )
        return
      }
      if (activeTab === 'plain') {
        let url = m.mask.querySelector('#lk-url2').value.trim()
        const text = m.mask.querySelector('#lk-text').value.trim()
        if (!url) return
        if (!/^(https?:\/\/|mailto:|#|\/)/i.test(url)) url = 'https://' + url
        m.close()
        restoreSelection()
        insertHTML(`<a href="${esc(url)}" target="_blank" rel="noopener noreferrer">${esc(text || url)}</a>&nbsp;`)
        return
      }
      // 站内文章
      if (!selectedPost) { toast('请先选择一篇文章', true); return }
      const style = m.mask.querySelector('input[name="lk-style"]:checked').value
      const p = selectedPost
      m.close()
      restoreSelection()
      if (style === 'link') {
        insertHTML(`<a href="/post/${esc(p.slug)}" target="_blank" rel="noopener noreferrer">${esc(p.title)}</a>&nbsp;`)
      } else {
        const desc = p.summary || (p.pw ? '加密文章，输入密码后阅读' : '来自本站的往期文章')
        insertHTML(linkCardHtmlClient({ url: `/post/${p.slug}`, title: p.title, description: desc, image: p.cover }))
      }
    }
    ok.addEventListener('click', doInsert)
    m.mask.addEventListener('keydown', (e) => {
      // 输入法组词回车（确认候选词）不触发插入
      if (e.isComposing || e.keyCode === 229) return
      if (e.key === 'Enter') {
        const t = e.target
        // 站内文章列表里的回车不劫持（radio/翻页按钮焦点）
        if (t.id === 'lk-url' || t.id === 'lk-url2' || t.id === 'lk-text') {
          e.preventDefault()
          doInsert()
        }
      }
    })
  }

  function imageDialog() {
    saveSelection()
    const m = modal(
      `<div class="modal-head"><span>插入图片</span><button class="modal-close" data-close>×</button></div>
      <div class="modal-body upload-dialog">
        <div class="tab-line"><button class="is-active" data-tab="up">上传到图床</button><button data-tab="url">图片地址</button><button data-tab="lib">媒体库</button></div>
        <div data-pane="up">
          <div class="upload-drop" id="up-drop">点击选择图片，或拖拽到此处<br><span style="font-size:12px;">支持 JPG / PNG / WebP / GIF，≤ 25MB</span></div>
          <div class="upload-progress" id="up-progress"><i></i></div>
        </div>
        <div data-pane="url" style="display:none;">
          <div class="auth-field"><label>图片 URL</label><input class="input" id="img-url" placeholder="https://… 或 /images/…"></div>
        </div>
        <div data-pane="lib" style="display:none;">
          <div class="media-picker" id="lib-grid"><div style="color:var(--sub);font-size:13px;padding:20px;text-align:center;">加载中…</div></div>
          <div style="display:flex;align-items:center;justify-content:space-between;margin-top:10px;">
            <span id="lib-page" style="font-size:12px;color:var(--sub);"></span>
            <span style="display:flex;gap:8px;">
              <button class="btn btn-sm" id="lib-prev" disabled>上一页</button>
              <button class="btn btn-sm" id="lib-next" disabled>下一页</button>
            </span>
          </div>
        </div>
      </div>
      <div class="modal-foot"><button class="btn" data-close>取消</button><button class="btn btn-primary" id="img-ok">插入</button></div>`
    )
    const bar = m.mask.querySelector('#up-progress i')
    const progress = m.mask.querySelector('#up-progress')
    const drop = m.mask.querySelector('#up-drop')
    const handleFiles = async (files) => {
      const list = [...files].filter((f) => /^image\//.test(f.type))
      if (!list.length) return toast('请选择图片文件', true)
      progress.classList.add('on')
      const uploaded = []
      for (const f of list) {
        try {
          const out = await compressImage(f)
          const d = await uploadFile(out, (p) => (bar.style.width = p + '%'))
          const w = await probeWidth(d.url)
          uploaded.push({ url: d.url, w, name: f.name })
        } catch (e) {
          toast(e.message, true)
        }
      }
      // 全部传完一次性回填并关弹窗：逐张 close 会让进度条首张后消失，
      // 逐张 restoreSelection 还会把多图倒序插回同一位置
      if (uploaded.length) {
        m.close()
        restoreSelection()
        insertHTML(
          uploaded
            .map(
              (u) =>
                `<img src="${esc(u.url)}"${u.w ? ` data-w="${u.w}"` : ''} alt="${esc((u.name || '').replace(/\.[^.]+$/, ''))}"><p><br></p>`
            )
            .join('')
        )
      }
      progress.classList.remove('on')
      bar.style.width = '0%'
    }
    drop.addEventListener('click', () =>
      pickFiles('image/jpeg,image/png,image/webp,image/gif', true, (files) => handleFiles(files))
    )
    drop.addEventListener('dragover', (e) => {
      e.preventDefault()
      drop.classList.add('is-over')
    })
    drop.addEventListener('dragleave', () => drop.classList.remove('is-over'))
    drop.addEventListener('drop', (e) => {
      e.preventDefault()
      drop.classList.remove('is-over')
      handleFiles(e.dataTransfer.files)
    })
    m.mask.querySelectorAll('[data-tab]').forEach((t) =>
      t.addEventListener('click', () => {
        m.mask.querySelectorAll('[data-tab]').forEach((x) => x.classList.toggle('is-active', x === t))
        m.mask.querySelectorAll('[data-pane]').forEach((p) => (p.style.display = p.dataset.pane === t.dataset.tab ? '' : 'none'))
      })
    )
    m.mask.querySelector('#img-ok').addEventListener('click', () => {
      // 媒体库 tab 有选中项时优先插入选中项；否则看 URL 输入框
      const picked = m.mask.querySelector('.media-item.is-picked')
      if (picked) {
        const url = picked.dataset.url
        m.close()
        restoreSelection()
        probeWidth(url).then((w) => {
          insertHTML(`<img src="${esc(url)}"${w ? ` data-w="${w}"` : ''} alt="${esc(picked.dataset.name || '')}"><p><br></p>`)
        })
        return
      }
      const url = m.mask.querySelector('#img-url').value.trim()
      if (!url) return
      m.close()
      restoreSelection()
      insertHTML(`<img src="${esc(url)}" alt=""><p><br></p>`)
    })

    /* 媒体库 picker：复用 /admin/uploads 分页接口；单选高亮，再点一次取消；
     * 插入时 probeWidth 探测原始宽度补 data-w，与上传插入同口径 */
    const grid = m.mask.querySelector('#lib-grid')
    const pageEl = m.mask.querySelector('#lib-page')
    const prevBtn = m.mask.querySelector('#lib-prev')
    const nextBtn = m.mask.querySelector('#lib-next')
    let libPage = 1
    const loadLib = async () => {
      grid.innerHTML = '<div style="color:var(--sub);font-size:13px;padding:20px;text-align:center;">加载中…</div>'
      try {
        const d = await api(`/admin/uploads?page=${libPage}`)
        const totalPages = Math.max(1, Math.ceil(d.total / 24))
        pageEl.textContent = d.total ? `第 ${d.page} / ${totalPages} 页 · 共 ${d.total} 个文件` : ''
        prevBtn.disabled = d.page <= 1
        nextBtn.disabled = d.page >= totalPages
        if (!d.items.length) {
          grid.innerHTML = '<div style="color:var(--sub);font-size:13px;padding:20px;text-align:center;">媒体库还是空的，先「上传到图床」</div>'
          return
        }
        grid.innerHTML = d.items
          .map(
            (u) => `<div class="media-item" data-url="${esc(u.url)}" data-name="${esc(u.name || '')}" data-mime="${esc(u.mime)}">
            <div class="media-thumb">${String(u.mime).startsWith('video/') ? `<video src="${esc(u.url)}" muted></video>` : `<div style="background-image:url('${esc(u.url)}');"></div>`}</div>
            <div class="media-name" title="${esc(u.name || '')}">${esc(u.name || u.key || '')}</div>
          </div>`
          )
          .join('')
      } catch (e) {
        grid.innerHTML = `<div style="color:var(--sub);font-size:13px;padding:20px;text-align:center;">${esc(e.message)}</div>`
      }
    }
    grid.addEventListener('click', (e) => {
      const item = e.target.closest('.media-item')
      if (!item) return
      // 单选语义：再点同一项取消选中（回到「用 URL 输入框」的路径）
      const was = item.classList.contains('is-picked')
      grid.querySelectorAll('.media-item.is-picked').forEach((x) => x.classList.remove('is-picked'))
      if (!was) item.classList.add('is-picked')
    })
    prevBtn.addEventListener('click', () => {
      if (libPage > 1) {
        libPage--
        loadLib()
      }
    })
    nextBtn.addEventListener('click', () => {
      libPage++
      loadLib()
    })
    loadLib()
  }

  function pickVideoFile() {
    saveSelection()
    pickFiles('video/mp4,video/webm', false, (files) => {
      if (files[0]) uploadAndInsert(files[0])
    })
  }

  function modal(html) {
    const mask = document.createElement('div')
    mask.className = 'modal-mask'
    mask.innerHTML = `<div class="modal" role="dialog">${html}</div>`
    const close = () => {
      document.removeEventListener('keydown', onKey)
      mask.remove()
      if (opener && opener.focus) opener.focus()
    }
    // Esc 关闭；打开时焦点落进弹窗，关闭后归还触发元素
    const onKey = (e) => {
      if (e.key === 'Escape') close()
    }
    document.addEventListener('keydown', onKey)
    const opener = document.activeElement
    mask.addEventListener('click', (e) => e.target === mask && close())
    mask.querySelectorAll('[data-close]').forEach((b) => b.addEventListener('click', close))
    document.body.appendChild(mask)
    const focusable = mask.querySelector('input, textarea, select, button:not([disabled])')
    if (focusable) focusable.focus()
    return { mask, close }
  }

  /* ---------- 点击图片：改 alt 描述与显示宽度 ----------
   * alt 是无障碍/SEO 的关键字段，上传时自动填文件名，之后只有这里有入口改；
   * 宽度走 data-w（微信排版规范 1.4.3 的原始像素宽度口径），不写 style 防体检报固定宽度 */
  editor.addEventListener('click', (e) => {
    const img = e.target.closest('img')
    // 表情小图与拖拽选区（用户在拉选文本路过图片）不弹
    if (!img || img.classList.contains('wxq-emoji') || window.getSelection()?.toString()) return
    e.preventDefault()
    imagePropsDialog(img)
  })

  function imagePropsDialog(img) {
    const curW = img.getAttribute('data-w') || ''
    // data-w（原始像素）→ 档位命中率：±3px 内算命中，回显选中态
    const percentHit = (dataW, pct) => {
      const nat = img.naturalWidth
      if (!nat) return ''
      return Math.abs(Number(dataW) - (nat * pct) / 100) <= 3 ? ' selected' : ''
    }
    const m = modal(
      `<div class="modal-head"><span>图片设置</span><button class="modal-close" data-close>×</button></div>
      <div class="modal-body">
        <div style="background:#f6f6f6;border-radius:8px;overflow:hidden;margin-bottom:14px;display:flex;align-items:center;justify-content:center;max-height:180px;">
          <img src="${esc(img.getAttribute('src') || '')}" style="max-width:100%;max-height:180px;">
        </div>
        <div class="auth-field"><label>描述 alt（无障碍与 SEO，读屏软件会朗读）</label>
          <input class="input" id="ip-alt" maxlength="200" value="${esc(img.getAttribute('alt') || '')}" placeholder="这张图讲了什么"></div>
        <div class="auth-field"><label>显示宽度（微信排版规范：按原始像素宽度百分比）</label>
          <select class="input" id="ip-w">
            <option value="">100%（默认，撑满版心）</option>
            <option value="75"${curW ? percentHit(curW, 75) : ''}>75%</option>
            <option value="50"${curW ? percentHit(curW, 50) : ''}>50%</option>
            <option value="35"${curW ? percentHit(curW, 35) : ''}>35%</option>
          </select>
          <div style="font-size:12px;color:var(--sub);margin-top:6px;">按原始宽度的百分比写入 data-w；改成 100% 即恢复撑满</div>
        </div>
      </div>
      <div class="modal-foot"><button class="btn btn-danger" id="ip-del">删除图片</button><button class="btn btn-primary" id="ip-ok">应用</button></div>`
    )
    m.mask.querySelector('#ip-ok').addEventListener('click', () => {
      const alt = m.mask.querySelector('#ip-alt').value.trim()
      const w = m.mask.querySelector('#ip-w').value
      if (alt) img.setAttribute('alt', alt)
      else img.removeAttribute('alt')
      if (w && img.naturalWidth) img.setAttribute('data-w', String(Math.round((img.naturalWidth * Number(w)) / 100)))
      else img.removeAttribute('data-w')
      m.close()
      markDirty()
    })
    m.mask.querySelector('#ip-del').addEventListener('click', () => {
      m.close()
      img.remove()
      markDirty()
      updateCount()
    })
  }

  /* ---------- 表格：插入 3x3 骨架 + 光标进表格时浮现行列操作条 ----------
   * 前台 .rich table 与编辑器 .ed-editor table 样式均已就位，这里只管编辑体验。
   * 操作条挂在 .ed-rich-wrap 上随滚动容器定位，点外部/离开表格即收起。 */
  function insertTable() {
    const head = '<thead><tr>' + Array.from({ length: 3 }, (_, c) => `<th>标题${c + 1}</th>`).join('') + '</tr></thead>'
    const body = '<tbody>' + Array.from({ length: 2 }, () => '<tr>' + '<td><br></td>'.repeat(3) + '</tr>').join('') + '</tbody>'
    insertHTML(`<table>${head}${body}</table><p><br></p>`)
    // 光标放进表头第一个单元格，直接开写
    const th = editor.querySelector('table th')
    if (th) {
      const sel = window.getSelection()
      const r = document.createRange()
      r.selectNodeContents(th)
      r.collapse(true)
      sel.removeAllRanges()
      sel.addRange(r)
    }
  }

  function currentCell() {
    const sel = window.getSelection()
    if (!sel || !sel.anchorNode) return null
    let n = sel.anchorNode.nodeType === Node.ELEMENT_NODE ? sel.anchorNode : sel.anchorNode.parentElement
    while (n && n !== editor) {
      if (n.tagName === 'TD' || n.tagName === 'TH') return n
      n = n.parentElement
    }
    return null
  }

  function cloneRow(tr, refCell, after) {
    const copy = tr.cloneNode(true)
    copy.querySelectorAll('td,th').forEach((c) => (c.innerHTML = '<br>'))
    if (after) tr.after(copy)
    else tr.before(copy)
    placeCaretIn(copy.querySelector('td,th'))
    markDirty()
  }

  function placeCaretIn(cell) {
    if (!cell) return
    const sel = window.getSelection()
    const r = document.createRange()
    r.selectNodeContents(cell)
    r.collapse(true)
    sel.removeAllRanges()
    sel.addRange(r)
  }

  function removeRow(tr) {
    const table = tr.closest('table')
    tr.remove()
    // 表格空了连壳一起删，留个空段落接住光标
    if (table && !table.querySelector('td,th')) {
      table.replaceWith(document.createElement('p'))
    }
    markDirty()
    updateCount()
  }

  function addCol(refCell, after) {
    const table = refCell.closest('table')
    const idx = refCell.cellIndex
    table.querySelectorAll('tr').forEach((tr) => {
      // 与该行既有单元格类型保持一致（表头行加 th，正文行加 td）
      const type = tr.children[idx] && tr.children[idx].tagName === 'TH' ? 'th' : 'td'
      const nc = document.createElement(type)
      nc.innerHTML = '<br>'
      const ref = tr.children[idx]
      if (after) ref.after(nc)
      else ref.before(nc)
    })
    markDirty()
  }

  function removeCol(refCell) {
    const table = refCell.closest('table')
    const idx = refCell.cellIndex
    table.querySelectorAll('tr').forEach((tr) => {
      if (tr.children[idx]) tr.children[idx].remove()
    })
    if (!table.querySelector('td,th')) {
      table.replaceWith(document.createElement('p'))
    }
    markDirty()
    updateCount()
  }

  let cellBar = null
  function showCellBar(cell) {
    if (!cellBar) {
      cellBar = document.createElement('div')
      cellBar.className = 'ed-cellbar'
      cellBar.innerHTML = `
        <button type="button" data-op="row-before" title="在上方插入行">↑行</button>
        <button type="button" data-op="row-after" title="在下方插入行">↓行</button>
        <button type="button" data-op="row-del" title="删除本行">删行</button>
        <span class="ed-cellbar-sep"></span>
        <button type="button" data-op="col-before" title="在左侧插入列">←列</button>
        <button type="button" data-op="col-after" title="在右侧插入列">→列</button>
        <button type="button" data-op="col-del" title="删除本列">删列</button>
        <span class="ed-cellbar-sep"></span>
        <button type="button" data-op="head" title="切换首行为表头/正文">表头</button>
        <button type="button" data-op="table-del" title="删除整个表格">删表</button>`
      cellBar.addEventListener('mousedown', (e) => e.preventDefault()) // 不抢光标
      cellBar.addEventListener('click', (e) => {
        const op = e.target.closest('[data-op]')?.dataset.op
        const cell = currentCell()
        if (!op || !cell) return
        const tr = cell.closest('tr')
        if (op === 'row-before') cloneRow(tr, cell, false)
        else if (op === 'row-after') cloneRow(tr, cell, true)
        else if (op === 'row-del') removeRow(tr)
        else if (op === 'col-before') addCol(cell, false)
        else if (op === 'col-after') addCol(cell, true)
        else if (op === 'col-del') removeCol(cell)
        else if (op === 'head') {
          // 首行 th ↔ td 互换
          const first = cell.closest('table').querySelector('tr')
          first.querySelectorAll('th,td').forEach((c) => {
            const nc = document.createElement(c.tagName === 'TH' ? 'TD' : 'TH')
            while (c.firstChild) nc.appendChild(c.firstChild)
            for (const attr of [...c.attributes]) nc.setAttribute(attr.name, attr.value)
            c.replaceWith(nc)
          })
          markDirty()
        } else if (op === 'table-del') {
          cell.closest('table').replaceWith(document.createElement('p'))
          hideCellBar()
          markDirty()
          updateCount()
        }
        refreshToolbarState()
      })
      root.querySelector('.ed-rich-wrap').appendChild(cellBar)
    }
    // 定位到当前单元格上方（相对滚动容器）
    const wrap = root.querySelector('.ed-rich-wrap')
    const cr = cell.getBoundingClientRect()
    const wr = wrap.getBoundingClientRect()
    cellBar.style.top = cr.top - wr.top + wrap.scrollTop - 40 + 'px'
    cellBar.style.left = Math.max(0, cr.left - wr.left) + 'px'
    cellBar.style.display = 'flex'
  }

  function hideCellBar() {
    if (cellBar) cellBar.style.display = 'none'
  }

  // 光标进表格显示操作条，出表格收起；点击单元格也刷新定位
  editor.addEventListener('keyup', () => {
    const cell = currentCell()
    if (cell && !mdMode) showCellBar(cell)
    else hideCellBar()
  })
  editor.addEventListener('mouseup', () => {
    const cell = currentCell()
    if (cell && !mdMode) showCellBar(cell)
    else hideCellBar()
  })

  /* ---------- 编辑区事件 ---------- */
  editor.addEventListener('input', () => {
    markDirty()
    updateCount()
  })
  titleEl.addEventListener('input', markDirty)
  titleEl.addEventListener('keydown', (e) => {
    if (e.isComposing || e.keyCode === 229) return
    if (e.key === 'Enter') {
      e.preventDefault()
      editor.focus()
    }
  })
  ;['ed-summary', 'ed-slug'].forEach((id) => document.getElementById(id).addEventListener('input', markDirty))
  document.getElementById('ed-min-tier').addEventListener('change', markDirty)
  document.getElementById('ed-pinned').addEventListener('change', markDirty)

  /* ---------- 访问密码（src/protect.ts） ---------- */
  const lockSwitch = document.getElementById('ed-locked')
  const lockPicker = document.getElementById('ed-lock-picker')
  const passwordInput = document.getElementById('ed-password')
  const syncLockPicker = () => { lockPicker.style.display = lockSwitch.checked ? '' : 'none' }
  lockSwitch.addEventListener('change', () => {
    syncLockPicker()
    if (lockSwitch.checked) passwordInput.focus()
    markDirty()
  })
  passwordInput.addEventListener('input', markDirty)
  syncLockPicker()

  /* ---------- 定时发布 ---------- */
  const scheduleSwitch = document.getElementById('ed-scheduled')
  const schedulePicker = document.getElementById('ed-schedule-picker')
  const publishAtInput = document.getElementById('ed-publish-at')
  // datetime-local 值 ↔ 毫秒：按本地时区（即北京时间）换算
  const toLocalInput = (ts) => {
    if (!ts) return ''
    const d = new Date(ts)
    const p = (n) => String(n).padStart(2, '0')
    return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}`
  }
  if (post.status === 'scheduled' && post.publish_at) publishAtInput.value = toLocalInput(post.publish_at)
  scheduleSwitch.addEventListener('change', () => {
    schedulePicker.style.display = scheduleSwitch.checked ? '' : 'none'
    if (scheduleSwitch.checked && !publishAtInput.value) {
      const d = new Date(Date.now() + 3600_000)
      d.setSeconds(0, 0)
      publishAtInput.value = toLocalInput(d.getTime())
    }
    // 取消定时：scheduled 文章回到草稿，保存后不会再被 cron 自动发出（与使用手册一致）；
    // 重新定时 = 再勾上开关并点「发布」
    if (!scheduleSwitch.checked && post.status === 'scheduled') {
      post.status = 'draft'
      pill.textContent = '草稿'
      pill.className = 'ed-status-pill chip chip-gray'
    }
    markDirty()
  })
  publishAtInput.addEventListener('input', () => {
    const ts = publishAtInput.value ? new Date(publishAtInput.value).getTime() : null
    post.publish_at = Number.isFinite(ts) ? ts : null
    markDirty()
  })
  schedulePicker.style.display = scheduleSwitch.checked ? '' : 'none'

  /* ---------- OG 分享卡图：标题+封面绘成 1200x630 PNG 上传，URL 写进正文 <meta og-image> ---------- */
  const ogBox = document.getElementById('ed-og-box')
  async function renderOgBox(url) {
    if (!url) {
      ogBox.innerHTML = `<button class="btn btn-sm" id="ed-og-gen" style="width:100%;">生成分享卡图</button>`
      bindOgGen()
      return
    }
    ogBox.innerHTML = `<img src="${esc(url)}" style="width:100%;border-radius:8px;border:1px solid var(--line);" id="ed-og-img"><button class="btn btn-ghost btn-sm" id="ed-og-remove" style="margin-top:6px;">移除卡图</button>`
    ogBox.querySelector('#ed-og-remove').addEventListener('click', async () => {
      // 从正文里摘掉 meta 标记，保存后前台回退到封面图
      editor.innerHTML = editor.innerHTML.replace(/<meta[^>]+data-og-image[^>]*>/gi, '')
      await save(false).catch(() => null)
      await renderOgBox('')
      toast('已移除，分享时回退到封面图')
    })
  }
  function bindOgGen() {
    const gen = ogBox.querySelector('#ed-og-gen')
    if (!gen) return
    gen.addEventListener('click', async () => {
      if (dirty || !post.id) await save(false).catch(() => null)
      const title = titleEl.value.trim() || '无标题'
      const firstImg = (() => {
        const m = editor.innerHTML.match(/<img[^>]+src="([^"]+)"/i)
        return m ? m[1] : ''
      })()
      gen.disabled = true
      gen.textContent = '生成中…'
      try {
        const file = await drawOgCard(title, post.cover || firstImg)
        if (!file) throw new Error('画卡图失败，换张封面试试')
        const url = await uploadOgCard(file)
        // 正文头部插 <meta data-og-image>：sanitize 会放行带 data-* 的 meta，前台读它输出 og:image
        editor.innerHTML = editor.innerHTML.replace(/<meta[^>]+data-og-image[^>]*>/gi, '')
        editor.insertAdjacentHTML(
          'afterbegin',
          `<meta data-og-image="${esc(url)}" content="${esc(url)}">`
        )
        post.og_image = url
        await save(false)
        await renderOgBox(url)
        toast('卡图已生成并保存 ✅')
      } catch (e) {
        toast(e.message, true)
      } finally {
        gen.disabled = false
        gen.textContent = '生成分享卡图'
      }
    })
  }
  // 已有卡图时（重进编辑器）从正文 meta 恢复展示
  if (!post.og_image) {
    const m = editor.innerHTML.match(/<meta[^>]+data-og-image="([^"]+)"/i)
    if (m) {
      post.og_image = m[1]
      renderOgBox(post.og_image)
    }
  }
  bindOgGen()

  editor.addEventListener('paste', async (e) => {
    const cd = e.clipboardData
    if (!cd) return
    const files = [...(cd.files || [])]
    if (files.length) {
      // 只拦截图片/视频：剪贴板是 PDF 等其它文件时走浏览器默认粘贴，别吞掉
      const media = files.filter((f) => /^(image|video)\//.test(f.type))
      if (!media.length) return
      e.preventDefault()
      // 粘贴点即插入点：上传是异步的，先锁定当前光标，避免插到上次操作残留的位置
      saveSelection()
      for (const f of media) {
        await uploadAndInsert(f)
        saveSelection() // 光标停在上一个文件后面，作为下一个文件的插入点（保持先后顺序）
      }
      return
    }
    const html = cd.getData('text/html')
    if (html) {
      e.preventDefault()
      saveSelection()
      saveState.textContent = '正在净化粘贴内容…'
      try {
        const d = await api('/admin/tools/sanitize', { method: 'POST', body: { html } })
        insertHTML(d.html || '')
        saveState.textContent = '粘贴完成'
        // 外链图（公众号等）已自动转存站内图床，提示数量让等待有感知
        if (d.transferred > 0) toast(`已转存 ${d.transferred} 张外链图片到站内图床`)
      } catch {
        insertHTML(esc(cd.getData('text/plain') || ''))
      }
    }
  })

  editor.addEventListener('dragover', (e) => {
    e.preventDefault()
    editor.dataset.drag = '1'
  })
  editor.addEventListener('dragleave', () => delete editor.dataset.drag)
  editor.addEventListener('drop', async (e) => {
    e.preventDefault()
    delete editor.dataset.drag
    saveSelection()
    const files = [...(e.dataTransfer?.files || [])]
    for (const f of files) {
      if (/^(image|video)\//.test(f.type)) {
        await uploadAndInsert(f)
        saveSelection() // 光标停在上一个文件后面，多文件按顺序追加
      }
    }
  })

  // 快捷键
  root.addEventListener('keydown', (e) => {
    const mod = e.metaKey || e.ctrlKey
    if (mod && e.key.toLowerCase() === 's') {
      e.preventDefault()
      save(false).catch(() => toast('保存失败，请重试', true))
    }
  })

  /* ---------- Markdown 快捷输入（富文本模式）：行首标记 + 空格 自动转块级格式 ----------
   * `> `→引用，`# `/`## `→H2（本系统正文最高层级），`### `→H3，`#### `→H4，
   * `- `/`* `→无序列表，`1. `→有序列表；只有 ``` / --- / *** 的段落回车 → 代码块 / 分割线。
   * 仅对普通段落生效（标题/引用/代码块/列表内不触发），输入法组词的空格回车不触发；
   * 删除标记与转格式都走 execCommand，⌘Z 可逐步撤销。 */
  const MD_BLOCK_TRIGGERS = [
    [/^#{1,2}$/, 'h2'],
    [/^#{3}$/, 'h3'],
    [/^#{4}$/, 'h4'],
    [/^>$/, 'blockquote'],
    [/^[-*]$/, 'ul'],
    [/^\d{1,3}\.$/, 'ol'],
  ]
  editor.addEventListener('keydown', (e) => {
    if (mdMode) return
    if (e.metaKey || e.ctrlKey || e.altKey) return
    // 输入法组词的空格/回车（确认候选词）不触发
    if (e.isComposing || e.keyCode === 229) return
    const sel = window.getSelection()
    if (!sel || !sel.rangeCount || !sel.isCollapsed) return
    const block = currentBlock()
    // 只在普通段落里触发：标题/引用/代码块/列表里继续输入原字符
    if (!block || block.tagName !== 'P') return

    if (e.key === ' ') {
      const caret = sel.getRangeAt(0)
      const pre = document.createRange()
      pre.selectNodeContents(block)
      pre.setEnd(caret.startContainer, caret.startOffset)
      const prefix = pre.toString()
      const hit = MD_BLOCK_TRIGGERS.find(([re]) => re.test(prefix))
      if (!hit) return
      e.preventDefault()
      if (hit[1] === 'ul' || hit[1] === 'ol') {
        // 列表直接建 DOM：execCommand 转列表各浏览器行为不一（WebKit 把 <ul> 嵌进 <p>，
        // 删除标记时还会带出样式 span），纯 DOM 构造两端一致
        const r = document.createRange()
        r.setStart(block, 0)
        r.setEnd(caret.startContainer, caret.startOffset)
        r.deleteContents() // 删掉行首标记
        const list = document.createElement(hit[1])
        const li = document.createElement('li')
        if (block.textContent.trim()) {
          // 标记后面还有内容：一并挪进列表项
          while (block.firstChild) li.appendChild(block.firstChild)
        } else {
          li.appendChild(document.createElement('br'))
        }
        list.appendChild(li)
        block.replaceWith(list)
        const selNow = window.getSelection()
        const r2 = document.createRange()
        r2.setStart(li, 0)
        r2.collapse(true)
        selNow.removeAllRanges()
        selNow.addRange(r2)
      } else {
        // 引用/标题：先删行首标记再 formatBlock（空段落也能整块替换）
        const r = document.createRange()
        r.setStart(block, 0)
        r.setEnd(caret.startContainer, caret.startOffset)
        sel.removeAllRanges()
        sel.addRange(r)
        document.execCommand('delete')
        document.execCommand('formatBlock', false, hit[1])
      }
      markDirty()
      refreshToolbarState()
      return
    }

    if (e.key === 'Enter') {
      const text = block.textContent.trim()
      if (text !== '```' && text !== '---' && text !== '***') return
      e.preventDefault()
      // 不走 insertHTML 助手——它会 restoreSelection 恢复旧选区，这里要用刚设好的选区整段替换
      const r = document.createRange()
      r.selectNodeContents(block)
      sel.removeAllRanges()
      sel.addRange(r)
      document.execCommand('insertHTML', false, text === '```' ? '<pre><code>// 在这里写代码</code></pre><p><br></p>' : '<hr><p><br></p>')
      markDirty()
      updateCount()
      refreshToolbarState()
    }
  })

  // 离开提醒（关闭标签页/刷新时浏览器兜底确认；SPA 内部路由由 flushEditorSave 兜底）
  const beforeUnload = (e) => {
    if (dirty) {
      // 同步补写最后一份本地备份：beforeunload 里异步操作不可靠，setItem 是同步 API
      clearTimeout(draftTimer)
      writeLocalDraft()
      e.preventDefault()
      e.returnValue = ''
    }
  }
  window.addEventListener('beforeunload', beforeUnload)

  // 注册全局监听器的清理函数：下次挂载前先拆掉上一次的，防止随挂载次数累积
  flushSave = async () => {
    if (dirty) {
      await save(false)
      return
    }
    // 干净退出（无未保存内容）：只清「内容与当前正文一致」的备份——
    // 一致 = 已同步，留着只会下次弹窗打扰；不一致 = 可能是用户没确认过的孤儿备份，留给下次恢复弹窗
    try {
      const bak = JSON.parse(localStorage.getItem(draftKey()) || 'null')
      const cur = mdMode ? mdArea.value : editor.innerHTML
      if (!bak || typeof bak.c !== 'string' || bak.c === cur) clearLocalDraft()
    } catch {
      clearLocalDraft() // 脏数据读不出来，直接清
    }
  }
  cleanupEditor = () => {
    document.removeEventListener('selectionchange', onSelectionChange)
    document.removeEventListener('keydown', onFocusKeydown)
    window.removeEventListener('beforeunload', beforeUnload)
    if (onPluginKeys) editor.removeEventListener('keydown', onPluginKeys)
    // 挂起的自动保存与本地备份定时器一并取消：路由已切走，定时器再触发只会打在已卸载的 DOM 上
    clearTimeout(saveTimer)
    clearTimeout(draftTimer)
    findBar = null // 查找条挂在顶栏 DOM 上，随 root 一起销毁，只清状态引用
    flushSave = null
  }

  /* ---------- Markdown 模式 ---------- */
  async function enterMdMode() {
    hideCellBar() // 表格操作条随富文本消失（表格已变纯文本）
    mdArea.value = htmlToMd(editor.innerHTML)
    root.querySelector('.editor-page').classList.add('ed-mode-md')
    document.getElementById('ed-md-toggle').classList.add('is-active')
    mdMode = true
  }
  async function exitMdMode() {
    const d = await api('/admin/tools/md', { method: 'POST', body: { md: mdArea.value } })
    editor.innerHTML = d.html
    root.querySelector('.editor-page').classList.remove('ed-mode-md')
    document.getElementById('ed-md-toggle').classList.remove('is-active')
    mdMode = false
    markDirty()
    updateCount()
  }
  document.getElementById('ed-md-toggle').addEventListener('click', async () => {
    try {
      if (!mdMode) await enterMdMode()
      else await exitMdMode()
    } catch (e) {
      toast(e.message, true)
    }
  })
  mdArea.addEventListener('input', markDirty)

  /* ---------- 专注模式：隐藏顶栏/工具栏/抽屉/底栏，只留写作纸面 ----------
   * 开关记住用户偏好；Esc 退出（弹窗的 Esc 关闭在 modal 层已 stopPropagation 不了——
   * modal 先注册在 document 上，这里 keydown 也挂 document 但要避开弹窗打开时误退） */
  const focusToggle = document.getElementById('ed-focus-toggle')
  const applyFocus = (on, remember) => {
    root.querySelector('.editor-page').classList.toggle('ed-focus', on)
    focusToggle.classList.toggle('is-active', on)
    focusToggle.textContent = on ? '退出专注' : '专注'
    if (remember) { try { localStorage.setItem('ed-focus', on ? 'on' : 'off') } catch { /* 不记住偏好 */ } }
  }
  // 有弹窗打开时不响应 Esc（弹窗自己会关闭并 stopPropagation）
  const onFocusKeydown = (e) => {
    if (e.key !== 'Escape' || !root.querySelector('.editor-page.ed-focus')) return
    if (document.querySelector('.modal-mask')) return
    applyFocus(false, true)
  }
  focusToggle.addEventListener('click', () => applyFocus(!root.querySelector('.editor-page.ed-focus'), true))
  document.addEventListener('keydown', onFocusKeydown)
  applyFocus(window.matchMedia('(min-width: 701px)').matches && (() => { try { return localStorage.getItem('ed-focus') === 'on' } catch { return false } })(), false)

  /* ---------- 顶栏按钮 ---------- */
  document.getElementById('ed-save').addEventListener('click', () => save(false).catch(() => {}))
  document.getElementById('ed-publish').addEventListener('click', publish)
  document.getElementById('ed-preview').addEventListener('click', async () => {
    const p = await ensureSaved()
    if (!p) return toast('保存失败，无法预览最新内容', true)
    if (!p.slug) return toast('先写点内容再预览', true)
    window.open(`/post/${p.slug}?preview=1`, '_blank', 'noopener')
  })
  /* ---------- 查找替换（富文本高亮 <mark data-find>，保存前剥除；Markdown 模式操作纯文本） ---------- */
  let findBar = null
  let findHits = [] // 富文本模式：命中所在的文本节点列表（顺序与高亮一致）
  let findIdx = -1

  function clearFindMarks() {
    stripFindMarks()
    findHits = []
    findIdx = -1
  }

  /** 只剥 DOM 上的 mark、不动 findHits/findIdx——highlightHit 重画高亮前用它，
   *  不能调 clearFindMarks（会清空命中数组让高亮直接 return，画不出任何标记） */
  function stripFindMarks() {
    editor.querySelectorAll('mark[data-find]').forEach((mk) => {
      const parent = mk.parentNode
      while (mk.firstChild) parent.insertBefore(mk.firstChild, mk)
      parent.removeChild(mk)
      parent.normalize() // 合并回相邻文本节点，恢复原始 DOM 结构
    })
  }

  /** 收集命中：按文本节点扫描（跳过 code/pre 内部——代码内容改字面量容易改坏语义，用户可进 Markdown 模式改） */
  function collectFindHits(term, caseSensitive) {
    findHits = []
    findIdx = -1
    if (!term) return
    const needle = caseSensitive ? term : term.toLowerCase()
    const walker = document.createTreeWalker(editor, NodeFilter.SHOW_TEXT, {
      acceptNode: (n) =>
        n.parentElement.closest('pre, code, mark[data-find]')
          ? NodeFilter.FILTER_REJECT
          : n.nodeValue.toLowerCase().includes(needle)
            ? NodeFilter.FILTER_ACCEPT
            : NodeFilter.FILTER_SKIP,
    })
    const nodes = []
    while (walker.nextNode()) nodes.push(walker.currentNode)
    for (const node of nodes) {
      const hay = caseSensitive ? node.nodeValue : node.nodeValue.toLowerCase()
      let i = 0
      while ((i = hay.indexOf(needle, i)) !== -1) {
        findHits.push({ node, start: i, end: i + term.length })
        i += term.length
      }
    }
  }

  /** 把第 idx 个命中包进 <mark data-find> 并滚到可见；其余命中暂不高亮（避免反复切分文本节点）。
   *  splitText 方案：节点切成 [前段][mark 内文本][后段]，三段引用全部显式掌握，
   *  不用 surroundContents——它在前段为空文本节点等场景下节点归属不可控，替换会打错位置 */
  function highlightHit(idx) {
    stripFindMarks() // 只剥旧 mark，findHits 保留
    if (idx < 0 || idx >= findHits.length) return
    const hit = findHits[idx]
    const textNode = hit.node
    if (!textNode || textNode.nodeType !== Node.TEXT_NODE) return
    // splitText 两次：先切尾部（tail=后段），再在原节点上切头部（markText=命中段，textNode 剩前段）
    const tail = hit.end < textNode.nodeValue.length ? textNode.splitText(hit.end) : null
    const markText = hit.start > 0 ? textNode.splitText(hit.start) : textNode
    const mk = document.createElement('mark')
    mk.setAttribute('data-find', '')
    markText.parentNode.insertBefore(mk, markText)
    mk.appendChild(markText)
    // 重定位所有引用原节点的命中：以坐标区间判归属（splitText 不改原引用，
    // textNode 此刻即前段；markText/tail 是切出来的新节点，必须显式改写 h.node）
    for (const h of findHits) {
      if (h.node !== textNode) continue
      if (h.start >= hit.end) {
        h.node = tail || textNode // 后段（无 tail 说明命中到文末，后段不存在）
        h.start -= hit.end
        h.end -= hit.end
      } else if (h.start >= hit.start) {
        h.node = markText // mark 内（含 hit 自己）
        h.start -= hit.start
        h.end -= hit.start
      }
      // else：完全落在前段（命中互不重叠时不存在，防御保留）
    }
    mk.scrollIntoView({ block: 'center', behavior: 'smooth' })
  }

  function findStatus() {
    const el = findBar?.querySelector('#fd-status')
    if (el) el.textContent = findHits.length ? `${findIdx + 1} / ${findHits.length}` : '无结果'
  }

  function findNext() {
    if (!findHits.length) return
    findIdx = (findIdx + 1) % findHits.length
    highlightHit(findIdx)
    findStatus()
  }

  function findPrev() {
    if (!findHits.length) return
    findIdx = (findIdx - 1 + findHits.length) % findHits.length
    highlightHit(findIdx)
    findStatus()
  }

  function runFind() {
    clearFindMarks()
    const term = findBar.querySelector('#fd-find').value
    const cs = findBar.querySelector('#fd-case').checked
    if (!term) {
      findHits = []
      findStatus()
      return
    }
    if (mdMode) {
      // Markdown 模式：在 textarea 里定位选中即可
      const hay = cs ? mdArea.value : mdArea.value.toLowerCase()
      const needle = cs ? term : term.toLowerCase()
      findHits = [{ node: null, start: 0, end: 0 }]
      findIdx = -1
      let i = 0
      let count = 0
      while ((i = hay.indexOf(needle, i)) !== -1) {
        count++
        i += term.length
      }
      findHits.length = count
      findIdx = -1
      findStatus()
      return
    }
    collectFindHits(term, cs)
    if (findHits.length) {
      findIdx = 0
      highlightHit(0)
    }
    findStatus()
  }

  function replaceOne() {
    const term = findBar.querySelector('#fd-find').value
    const rep = findBar.querySelector('#fd-replace').value
    const cs = findBar.querySelector('#fd-case').checked
    if (!term || !findHits.length) return
    if (mdMode) {
      const v = mdArea.value
      const hay = cs ? v : v.toLowerCase()
      const needle = cs ? term : term.toLowerCase()
      const at = hay.indexOf(needle)
      if (at === -1) return
      mdArea.value = v.slice(0, at) + rep + v.slice(at + term.length)
      mdArea.dispatchEvent(new Event('input')) // 走 markDirty 链
      runFind()
      return
    }
    if (findIdx < 0) findNext()
    const h = findHits[findIdx]
    if (!h) return
    const node = h.node
    node.nodeValue = node.nodeValue.slice(0, h.start) + rep + node.nodeValue.slice(h.end)
    clearFindMarks()
    markDirty()
    updateCount()
    runFind() // 重新扫描：内容变了，旧坐标作废；停在原序号继续替换下一个
  }

  function replaceAll() {
    const term = findBar.querySelector('#fd-find').value
    const rep = findBar.querySelector('#fd-replace').value
    const cs = findBar.querySelector('#fd-case').checked
    if (!term) return
    if (mdMode) {
      const hay = cs ? mdArea.value : mdArea.value.toLowerCase()
      const needle = cs ? term : term.toLowerCase()
      let n = 0
      let i = hay.indexOf(needle)
      let v = mdArea.value
      while (i !== -1) {
        n++
        v = v.slice(0, i) + rep + v.slice(i + term.length)
        const next = (cs ? v : v.toLowerCase()).indexOf(needle, i + rep.length)
        i = next
      }
      if (!n) return
      mdArea.value = v
      mdArea.dispatchEvent(new Event('input'))
      toast(`已替换 ${n} 处`)
      runFind()
      return
    }
    if (!findHits.length) return
    const n = findHits.length
    // 从后往前按坐标改写文本节点，坐标不失效；同节点多命中时倒序天然正确
    const byNode = new Map()
    for (const h of findHits) {
      if (!byNode.has(h.node)) byNode.set(h.node, [])
      byNode.get(h.node).push(h)
    }
    for (const [node, list] of byNode) {
      let v = node.nodeValue
      for (const h of list.sort((a, b) => b.start - a.start)) {
        v = v.slice(0, h.start) + rep + v.slice(h.end)
      }
      node.nodeValue = v
    }
    clearFindMarks()
    markDirty()
    updateCount()
    toast(`已替换 ${n} 处`)
    runFind()
  }

  function openFindBar() {
    if (findBar) {
      findBar.querySelector('#fd-find').focus()
      findBar.querySelector('#fd-find').select()
      return
    }
    findBar = document.createElement('div')
    findBar.className = 'ed-findbar'
    findBar.innerHTML = `
      <input class="input" id="fd-find" placeholder="查找" style="width:150px;">
      <input class="input" id="fd-replace" placeholder="替换为" style="width:150px;">
      <label style="display:flex;align-items:center;gap:4px;font-size:12px;color:var(--sub);white-space:nowrap;">
        <input type="checkbox" id="fd-case">区分大小写</label>
      <span id="fd-status" style="font-size:12px;color:var(--sub);white-space:nowrap;">—</span>
      <button class="btn btn-sm" id="fd-prev" title="上一个">↑</button>
      <button class="btn btn-sm" id="fd-next" title="下一个">↓</button>
      <button class="btn btn-sm" id="fd-one">替换</button>
      <button class="btn btn-sm" id="fd-all">全部</button>
      <button class="btn btn-ghost btn-sm" id="fd-close" title="关闭">✕</button>`
    document.querySelector('.ed-topbar').appendChild(findBar)
    const input = findBar.querySelector('#fd-find')
    input.addEventListener('input', runFind)
    input.addEventListener('keydown', (e) => {
      if (e.isComposing || e.keyCode === 229) return
      if (e.key === 'Enter') {
        e.preventDefault()
        e.shiftKey ? findPrev() : findNext()
      }
    })
    findBar.querySelector('#fd-next').addEventListener('click', findNext)
    findBar.querySelector('#fd-prev').addEventListener('click', findPrev)
    findBar.querySelector('#fd-one').addEventListener('click', replaceOne)
    findBar.querySelector('#fd-all').addEventListener('click', replaceAll)
    findBar.querySelector('#fd-case').addEventListener('change', runFind)
    findBar.querySelector('#fd-close').addEventListener('click', closeFindBar)
    input.focus()
  }

  function closeFindBar() {
    clearFindMarks()
    findBar?.remove()
    findBar = null
  }

  document.getElementById('ed-find').addEventListener('click', openFindBar)
  const onFindKeydown = (e) => {
    if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'f') {
      e.preventDefault()
      openFindBar()
    } else if (e.key === 'Escape' && findBar && !document.querySelector('.modal-mask')) {
      closeFindBar()
    }
  }
  root.addEventListener('keydown', onFindKeydown)

  document.getElementById('ed-check').addEventListener('click', () => {
    if (mdMode) return toast('请先退出 Markdown 模式', true)
    const issues = runChecks(editor.innerHTML)
    const warns = issues.filter((i) => i.level === 'warn').length
    const body = issues.length
      ? issues
          .map(
            (i) => `<div class="check-item">
          <span class="check-icon">${i.level === 'warn' ? '⚠️' : '💡'}</span>
          <div><div>${esc(i.msg)}</div><div class="check-rule">规范 ${esc(i.rule)}</div></div>
        </div>`
          )
          .join('')
      : '<div class="check-pass">🎉 全部通过，排版很规范！</div>'
    const m = modal(
      `<div class="modal-head"><span>排版体检报告 ${warns ? `· ${warns} 项建议修复` : ''}</span><button class="modal-close" data-close>×</button></div>
      <div class="modal-body" style="max-height:50vh;overflow:auto;">${body}
        <p style="font-size:12px;color:var(--sub);margin-top:14px;">依据《微信公众平台编辑器插件开发规范》静态检查：固定宽度、行高、height、text-align、pre、字体族、!important、嵌套层级、data-w 等。完整规范见 docs/wechat-typography-spec.md</p>
      </div>
      ${issues.some((i) => i.rule.includes('!important') || i.rule.includes('text-align')) ? '<div class="modal-foot"><button class="btn btn-primary" id="ck-fix">一键修复可自动处理项</button></div>' : ''}`,
      { large: true }
    )
    m.mask.querySelector('#ck-fix')?.addEventListener('click', () => {
      applyAutoFixes()
      m.close()
      toast('已修复，可再次体检确认')
    })
  })
  // 元信息抽屉：默认收起给写作让位，开关状态记住用户的选择；小屏是覆盖层，始终默认收起
  // 隐私加固浏览器访问 localStorage 即抛 SecurityError：偏好存取吞异常，降级默认收起
  const drawer = document.getElementById('ed-drawer')
  const drawerBtn = document.getElementById('ed-drawer-toggle')
  const drawerPref = () => { try { return localStorage.getItem('ed-drawer') } catch { return null } }
  const applyDrawer = (hidden, remember) => {
    drawer.classList.toggle('is-hidden', hidden)
    drawerBtn.classList.toggle('is-active', !hidden)
    if (remember) { try { localStorage.setItem('ed-drawer', hidden ? 'hidden' : 'open') } catch { /* 不记住偏好 */ } }
  }
  applyDrawer(window.matchMedia('(max-width: 860px)').matches || drawerPref() !== 'open', false)
  drawerBtn.addEventListener('click', () => applyDrawer(!drawer.classList.contains('is-hidden'), true))
  document.getElementById('ed-drawer-close').addEventListener('click', () => applyDrawer(true, true))

  /* ---------- 封面 ---------- */
  const coverBox = document.getElementById('ed-cover-box')
  coverBox.addEventListener('click', (e) => {
    if (e.target.id === 'ed-cover-remove') {
      post.cover = ''
      coverBox.innerHTML = '＋ 上传封面图'
      markDirty()
      return
    }
    pickFiles('image/jpeg,image/png,image/webp,image/gif', false, async (files) => {
      if (!files[0]) return
      try {
        const out = await compressImage(files[0])
        const d = await uploadFile(out, null)
        post.cover = d.url
        coverBox.innerHTML = `<img src="${esc(post.cover)}"><button class="cover-remove" id="ed-cover-remove" title="移除封面">×</button>`
        coverBox.querySelector('#ed-cover-remove').addEventListener('click', (ev) => {
          ev.stopPropagation()
          post.cover = ''
          coverBox.innerHTML = '＋ 上传封面图'
          markDirty()
        })
        markDirty()
      } catch (err) {
        toast(err.message, true)
      }
    })
  })

  /* ---------- 标签 ---------- */
  const tagBox = document.getElementById('ed-tag-box')
  const tagInput = document.getElementById('ed-tag-input')
  function renderTags() {
    tagBox.querySelectorAll('.tag-chip').forEach((c) => c.remove())
    post.tags.forEach((t, i) => {
      const chip = document.createElement('span')
      chip.className = 'tag-chip'
      chip.innerHTML = `${esc(t)}<button type="button" title="移除">×</button>`
      chip.querySelector('button').addEventListener('click', () => {
        post.tags.splice(i, 1)
        renderTags()
        markDirty()
      })
      tagBox.insertBefore(chip, tagInput)
    })
  }
  function addTag(name) {
    name = name.trim().replace(/[,，]$/, '')
    if (!name || post.tags.includes(name) || post.tags.length >= 8) return
    post.tags.push(name)
    renderTags()
    markDirty()
  }
  tagInput.addEventListener('keydown', (e) => {
    // 输入法组词中的回车/逗号是确认拼音，不是确认标签；忽略，否则标签被提前加入，
    // 输入法提交后文本又落回输入框，看起来「重复出现」
    if (e.isComposing || e.keyCode === 229) return
    if (e.key === 'Enter' || e.key === ',') {
      e.preventDefault()
      addTag(tagInput.value)
      tagInput.value = ''
    } else if (e.key === 'Backspace' && !tagInput.value && post.tags.length) {
      post.tags.pop()
      renderTags()
    }
  })
  tagInput.addEventListener('blur', () => {
    if (tagInput.value.trim()) {
      addTag(tagInput.value)
      tagInput.value = ''
    }
  })
  renderTags()
  api('/admin/tags')
    .then((d) => {
      document.getElementById('tag-suggestions').innerHTML = d.tags.map((t) => `<option value="${esc(t.name)}">`).join('')
    })
    .catch(() => {})

  /* ---------- 分类下拉 ---------- */
  const catSelect = document.getElementById('ed-category')
  api('/admin/categories')
    .then((d) => {
      catSelect.innerHTML =
        '<option value="">未分类</option>' +
        d.categories.map((c) => `<option value="${c.id}"${c.id === post.categoryId ? ' selected' : ''}>${esc(c.name)}</option>`).join('')
    })
    .catch(() => {})
  catSelect.addEventListener('change', markDirty)

  /* ---------- 插件 ctx & 加载 ---------- */
  // 插件快捷键（API 1.1）：统一注册到 editor 的一个 keydown 监听上分发。
  // 组合键必须带修饰键（mod/ctrl/cmd/meta——纯字母键在写作编辑器里会抢输入），
  // mod 在 Mac 映射 Cmd、其他平台 Ctrl；IME 组词回车不触发
  const pluginShortcuts = []
  const registerShortcut = (combo, handler) => {
    const keys = String(combo || '')
      .toLowerCase()
      .split('+')
      .map((s) => s.trim())
      .filter(Boolean)
    if (typeof handler !== 'function') return
    const mod = keys.some((k) => ['mod', 'ctrl', 'cmd', 'meta'].includes(k))
    if (!mod) return
    const key = keys
      .filter((k) => !['mod', 'ctrl', 'cmd', 'meta', 'shift', 'alt', 'option'].includes(k))
      .pop()
    if (!key || key.length > 16) return
    if (pluginShortcuts.some((s) => s.key === key && s.shift === keys.includes('shift') && s.alt === keys.includes('alt'))) return
    pluginShortcuts.push({ key, shift: keys.includes('shift'), alt: keys.includes('alt') || keys.includes('option'), handler })
  }
  onPluginKeys = (e) => {
    if (!pluginShortcuts.length || e.isComposing || e.keyCode === 229) return
    const mac = /mac/i.test(navigator.platform || '')
    const modPressed = mac ? e.metaKey || e.ctrlKey : e.ctrlKey
    if (!modPressed) return
    for (const sc of pluginShortcuts) {
      if (sc.shift !== e.shiftKey || sc.alt !== e.altKey) continue
      if (String(e.key || '').toLowerCase() !== sc.key) continue
      e.preventDefault()
      e.stopPropagation()
      saveSelection()
      try {
        sc.handler(pluginCtx)
      } catch (err) {
        console.warn('插件快捷键执行出错', err)
      }
      return
    }
  }
  editor.addEventListener('keydown', onPluginKeys)

  const pluginCtx = {
    insertHTML,
    getHTML: () => editor.innerHTML,
    setHTML: (h) => {
      editor.innerHTML = String(h || '')
      markDirty()
      updateCount()
    },
    exec: (cmd, val) => {
      editor.focus()
      document.execCommand(cmd, false, val || null)
      markDirty()
    },
    notify: (m) => toast(String(m || '')),
    // 选区读写（API 1.1）：只认编辑器内的选区，编辑器外选中文本一律返回空
    getSelectionText: () => {
      const sel = window.getSelection()
      return sel && sel.rangeCount && editor.contains(sel.anchorNode) ? sel.toString() : ''
    },
    getSelectionHTML: () => {
      const sel = window.getSelection()
      if (!sel || !sel.rangeCount || !editor.contains(sel.anchorNode)) return ''
      const wrap = document.createElement('div')
      wrap.appendChild(sel.getRangeAt(0).cloneContents())
      return wrap.innerHTML
    },
    replaceSelection: (html) => {
      editor.focus()
      restoreSelection()
      const sel = window.getSelection()
      if (!sel || !sel.rangeCount || !editor.contains(sel.anchorNode)) {
        insertHTML(html) // 无有效选区 = 退化为光标处插入
        return
      }
      const r = sel.getRangeAt(0)
      r.deleteContents()
      const tpl = document.createElement('template')
      tpl.innerHTML = String(html || '')
      r.insertNode(tpl.content)
      r.collapse(false)
      sel.removeAllRanges()
      sel.addRange(r)
      markDirty()
      updateCount()
    },
    registerShortcut,
  }
  // 注册与重挂载补注册共用：新增定义时触发一次 onMount（插件用它做初始化，如拉数据、注样式）
  const registerPluginDef = (p) => {
    if (!(p && p.name && typeof p.onClick === 'function')) return
    const isNew = !plugins.includes(p)
    pluginDefs.set(p.name, p)
    if (isNew) plugins.push(p)
    if (isNew && typeof p.onMount === 'function') {
      try {
        Promise.resolve(p.onMount(pluginCtx)).catch((err) => console.warn('插件 onMount 出错', err))
      } catch (err) {
        console.warn('插件 onMount 出错', err)
      }
    }
    renderPluginButtons(pluginCtx)
  }
  window.BlogHao = {
    version: '1.1',
    registerPlugin: registerPluginDef,
    ...pluginCtx,
  }
  // opts.disabledPlugins：后台「插件」页停用的 manifest id 列表（app.js 从 settings 解析传入）
  loadPlugins(pluginCtx, opts.disabledPlugins)

  updateCount()
  refreshToolbarState()
  saveState.textContent = post.id ? '已加载' : '新文章，首次修改后自动保存'
  editor.focus()
}
