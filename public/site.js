/* 博客号前台交互：点赞 + 留言（含作者回复）+ 微博折叠评论（所有主题共用，保持极小体积） */
(function () {
  'use strict'

  /* 英文测试版（English 0.1）：SSR 在 <html data-edition="en"> 上标记，前台 JS 文案随语言切换 */
  var EN = document.documentElement.getAttribute('data-edition') === 'en'
  var EN_STR = {
    '请求失败': 'Request failed',
    '上传失败': 'Upload failed',
    'QQ 号格式不对（5-11 位数字，不以 0 开头），可留空或修改后再发':
      'Invalid QQ ID (5–11 digits, no leading 0) — leave it empty or fix it before posting',
    '发送中…': 'Posting…',
    '已提交，审核通过后展示': 'Submitted — it will appear once approved',
    '留言成功，感谢参与 🙂': 'Comment posted — thanks for joining in 🙂',
    '发送失败，请重试': 'Failed to post — please try again',
    '还没有评论，来抢沙发～': 'No comments yet — be the first!',
    '评论加载失败，稍后再试': 'Failed to load comments — try again later',
    '回复': 'Reply',
    '取消': 'Cancel',
    '作者': 'Author',
    '失败': 'Failed',
    '分享': 'Share',
    '加图': 'Add photo',
    '上传中': 'Uploading',
    '只支持 JPG / PNG / WebP / GIF 图片': 'Only JPG / PNG / WebP / GIF images are supported',
    '置顶': 'Pin',
    '取消置顶': 'Unpin',
    '删除': 'Delete',
    '删除中…': 'Deleting…',
    '删除失败': 'Failed to delete',
    '保存': 'Save',
    '保存中…': 'Saving…',
    '保存失败': 'Failed to save',
    '保存失败，请重试': 'Failed to save — please try again',
    '加载失败，请取消后重新进编辑': 'Failed to load — cancel and reopen the editor',
    '操作失败': 'Action failed',
    '提交中…': 'Submitting…',
    '提交失败，请重试': 'Failed to submit — please try again',
    '已提交，站长审核通过后就会展示在这里 🎉': 'Submitted — it will show up here once the site owner approves it 🎉',
    '注册中…': 'Signing up…',
    '登录中…': 'Logging in…',
    '注册成功，正在进入…': 'Account created — signing you in…',
    '登录成功，正在进入…': 'Logged in — redirecting…',
    '操作失败，请重试': 'Something went wrong — please try again',
    '昵称不能为空': 'Display name cannot be empty',
    '保存中': 'Saving',
    '昵称已更新，正在刷新…': 'Name updated — refreshing…',
    'QQ 号格式不对（5-11 位数字，不以 0 开头）': 'Invalid QQ ID (5–11 digits, no leading 0)',
    'QQ 已绑定，但头像没抓到，稍后再点一次重试': 'QQ linked but the avatar has not been fetched yet — retry later',
    '已保存，正在刷新…': 'Saved — refreshing…',
    '请填写当前密码与新密码': 'Enter both the current and the new password',
    '新密码至少 8 位': 'The new password must be at least 8 characters',
    '密码已修改，其他设备已退出登录。请务必记好新密码':
      'Password changed and other devices signed out. Keep the new one safe',
    '修改失败，请重试': 'Failed to change — please try again',
    '退出失败，请重试': 'Failed to log out — please try again',
    '说点什么…': 'Say something…',
    '😊 表情': '😊 Emoji',
    '返回顶部': 'Back to top',
    '复制代码': 'Copy code',
    '已复制': 'Copied',
    '复制失败': 'Copy failed',
    '复制本节链接': 'Copy link to this section',
  }
  function T(zh) {
    return EN ? EN_STR[zh] || zh : zh
  }
  /* 带数字的句子按英文语序重组：与服务端 weiboTime 口径一致（+8h 取 UTC 分量） */
  function addImagesEn(n) {
    return 'Posted ' + n + (n === 1 ? ' photo' : ' photos')
  }
  function addLabelEn(n, max) {
    return 'Add photo (' + n + '/' + max + ')'
  }

  /* 旧式裸锚点深链兜底（/weibo#wb-<id>，历史遗留的 TG 通知等）：目标微博不在当前页时改用
   * ?wb= 让服务端定位所在页再滚动；新链接都带 ?wb=，锚点必在 DOM 里，不会走到这里 */
  var wbHash = /^wb-(\d+)$/.exec(location.hash.slice(1))
  if (wbHash && location.pathname === '/weibo' && !document.getElementById('wb-' + wbHash[1])) {
    location.replace('/weibo?wb=' + wbHash[1] + '#wb-' + wbHash[1])
  }

  function postJSON(url, data) {
    return fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(data || {}),
    }).then(function (r) {
      return r.json().then(function (d) {
        if (!r.ok) throw new Error((d && d.error) || T('请求失败'))
        return d
      })
    })
  }

  function getJSON(url) {
    return fetch(url).then(function (r) {
      return r.json().then(function (d) {
        if (!r.ok) throw new Error((d && d.error) || T('请求失败'))
        return d
      })
    })
  }

  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, function (ch) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch]
    })
  }

  /* localStorage 安全读写：隐私加固浏览器/扩展下访问 localStorage 属性本身会抛 SecurityError，
   * 裸调用会把顶层 IIFE 打断（全站交互瘫痪），这里统一吞掉降级为「记不住但能用」 */
  function storeGet(k) {
    try {
      return localStorage.getItem(k)
    } catch (e) {
      return null
    }
  }
  function storeSet(k, v) {
    try {
      localStorage.setItem(k, v)
    } catch (e) {
      /* 隐私模式等存不进去就忽略 */
    }
  }

  /* ---------------- 上传前图片压缩与 WebP 转换（前台发布器；后台 editor.js 是同参数同逻辑的 ES Module 原版，改任一侧记得同步另一侧） ----------------
   * JPEG/PNG/WebP 且「超阈值或最长边超 2000px」：先降尺寸再编码，优先转 WebP（质量 0.75——
   * WebP 压缩率高，0.75 已是业内通行的视觉无损甜点，比同画质 JPEG 约再省三成，透明不丢）；
   * 旧浏览器编码不了 WebP 时回退 JPEG/PNG 口径（质量 0.82，透明 PNG 只缩尺寸不转格式）；
   * GIF 动图会压丢帧原样直传；小且尺寸合规的图直通；产物不比原图小则用原图；失败回退原文件。 */
  var IMG_COMPRESS = { MAX_DIM: 2000, MIN_BYTES: 150 * 1024, WEBP_QUALITY: 0.75, FALLBACK_QUALITY: 0.82 }

  function hasAlphaSampled(bmp) {
    var cv = document.createElement('canvas')
    cv.width = cv.height = 1
    var ctx = cv.getContext('2d')
    ctx.drawImage(bmp, 0, 0, 1, 1)
    var d = ctx.getImageData(0, 0, 1, 1).data
    return d[3] < 250
  }

  function compressImage(file) {
    return new Promise(function (resolve) {
      if (!/^image\/(jpeg|png|webp)$/.test(file.type)) return resolve(file)
      createImageBitmap(file)
        .then(function (bmp) {
          var scale = Math.min(1, IMG_COMPRESS.MAX_DIM / Math.max(bmp.width, bmp.height))
          // 体积与尺寸都合规的直通：重编码不会更小，白耗 CPU 还平白叠一代有损
          if (file.size <= IMG_COMPRESS.MIN_BYTES && scale >= 1) {
            bmp.close && bmp.close()
            return resolve(file)
          }
          var w = Math.max(1, Math.round(bmp.width * scale))
          var h = Math.max(1, Math.round(bmp.height * scale))
          var cv = document.createElement('canvas')
          cv.width = w
          cv.height = h
          cv.getContext('2d').drawImage(bmp, 0, 0, w, h)
          cv.toBlob(function (webp) {
            if (webp && webp.type === 'image/webp') {
              bmp.close && bmp.close()
              if (webp.size >= file.size) return resolve(file)
              var wname = (file.name || 'image').replace(/\.[^.]+$/, '') + '.webp'
              return resolve(new File([webp], wname, { type: 'image/webp' }))
            }
            var toJpeg = file.type !== 'image/png' || !hasAlphaSampled(bmp)
            bmp.close && bmp.close()
            if (scale >= 1 && !toJpeg) return resolve(file)
            cv.toBlob(function (blob) {
              if (!blob || blob.size >= file.size) return resolve(file)
              var name = (file.name || 'image').replace(/\.[^.]+$/, '') + (toJpeg ? '.jpg' : '.png')
              resolve(new File([blob], name, { type: toJpeg ? 'image/jpeg' : 'image/png' }))
            }, toJpeg ? 'image/jpeg' : 'image/png', IMG_COMPRESS.FALLBACK_QUALITY)
          }, 'image/webp', IMG_COMPRESS.WEBP_QUALITY)
        })
        .catch(function () {
          resolve(file)
        })
    })
  }

  // 与后端 weiboTime 保持一致：今年「10月3日 14:20」，往年带年份
  // 统一按北京时间（UTC+8）口径：+8h 后用 getUTC* 取墙上时间，
  // 与服务端 SSR 渲染同源，避免 0-8 点内容跨天、同屏两套时区
  // 英文测试版：Oct 3, 14:20 / Oct 3, 2025（与 i18n.ts weiboTimeEn 同口径）
  var EN_MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']
  function fmtTime(ts) {
    var d = new Date(Number(ts) + 8 * 3600e3)
    if (isNaN(d.getTime())) return ''
    function p(x) {
      return ('0' + x).slice(-2)
    }
    var hm = p(d.getUTCHours()) + ':' + p(d.getUTCMinutes())
    var now = new Date(Date.now() + 8 * 3600e3)
    if (EN) {
      var md = EN_MONTHS[d.getUTCMonth()] + ' ' + d.getUTCDate()
      return d.getUTCFullYear() === now.getUTCFullYear() ? md + ', ' + hm : md + ', ' + d.getUTCFullYear()
    }
    if (d.getUTCFullYear() === now.getUTCFullYear()) return d.getUTCMonth() + 1 + '月' + d.getUTCDate() + '日 ' + hm
    return d.getUTCFullYear() + '年' + (d.getUTCMonth() + 1) + '月' + d.getUTCDate() + '日'
  }

  /* ---------------- 发布器 / 卡片编辑共用的小工具 ---------------- */
  // 配图缩略图串（× 删除按钮由各自容器事件委托处理）
  function tileHtml(images) {
    return images
      .map(function (u, i) {
        return (
          '<span class="wb-composer-tile"><img src="' + esc(u) + '" alt="">' +
          '<button type="button" class="wb-composer-tile-del" data-i="' + i + '" title="移除">×</button></span>'
        )
      })
      .join('')
  }

  function uploadImage(file) {
    var fd = new FormData()
    fd.append('file', file)
    return fetch('/api/admin/upload', { method: 'POST', body: fd }).then(function (r) {
      return r.json().then(function (d) {
        if (!r.ok) throw new Error((d && d.error) || T('上传失败'))
        return d.url
      })
    })
  }

  // 上传前压缩（compressImage 定义在上方）
  function uploadCompressed(file) {
    return compressImage(file).then(uploadImage)
  }

  // 动态 file input 必须先挂到 DOM 再 click：iOS Safari 对游离节点的选图器能打开、
  // 能选照片，但 change 不回填（文件永远回不到页面），上传静默失败且无任何提示——
  // 手机上「选了图却没动静」即此。挂 body 隐藏，读完文件 / 用户取消即摘除。
  function pickFiles(opts, onFiles) {
    var input = document.createElement('input')
    input.type = 'file'
    if (opts.accept) input.accept = opts.accept
    if (opts.multiple) input.multiple = true
    input.hidden = true
    input.addEventListener('cancel', function () {
      input.remove()
    })
    input.addEventListener('change', function () {
      var files = input.files
      input.remove()
      onFiles(files)
    })
    document.body.appendChild(input)
    input.click()
  }

  /* ---------------- 顶部导航「分类话题」折叠菜单：点外部 / Esc 收起 ---------------- */
  function closeNavMenus(except) {
    var open = document.querySelectorAll('details.snav-dd[open]')
    for (var i = 0; i < open.length; i++) {
      if (!except || !open[i].contains(except)) open[i].removeAttribute('open')
    }
  }
  document.addEventListener('click', function (e) {
    closeNavMenus(e.target)
  })
  document.addEventListener('keydown', function (e) {
    if (e.key === 'Escape') closeNavMenus(null)
  })

  /* ---------------- 点赞（文章 + 微博，localStorage 防重复，可再点取消） ---------------- */
  // 刷新/回访时按 localStorage 回填已赞样式：否则按钮看着没赞过，再点一次反而变成取消赞
  document.querySelectorAll('.like-btn').forEach(function (btn) {
    var isWeibo = btn.getAttribute('data-type') === 'weibo'
    var targetId = isWeibo ? btn.getAttribute('data-id') : btn.getAttribute('data-slug')
    if (targetId && storeGet('bloghao-liked-' + (isWeibo ? 'wb-' + targetId : targetId)) === '1') {
      btn.classList.add('liked')
    }
  })
  document.addEventListener('click', function (e) {
    var btn = e.target && e.target.closest ? e.target.closest('.like-btn') : null
    if (!btn) return
    e.preventDefault()
    var isWeibo = btn.getAttribute('data-type') === 'weibo'
    var targetId = isWeibo ? btn.getAttribute('data-id') : btn.getAttribute('data-slug')
    if (!targetId || btn.dataset.busy) return
    var key = 'bloghao-liked-' + (isWeibo ? 'wb-' + targetId : targetId)
    var url = isWeibo
      ? '/api/public/like/weibo/' + encodeURIComponent(targetId)
      : '/api/public/like/' + encodeURIComponent(targetId)
    var liked = storeGet(key) === '1'
    btn.dataset.busy = '1'
    postJSON(url, { delta: liked ? -1 : 1 })
      .then(function (d) {
        storeSet(key, liked ? '0' : '1')
        btn.classList.toggle('liked', !liked)
        var count = btn.querySelector('[data-count]')
        if (count && typeof d.likes === 'number') count.textContent = String(d.likes)
        // 点赞成功心跳一下（取消赞不弹）：Web Animations API 不可用就安静跳过
        if (!liked && btn.animate) {
          btn.animate(
            [
              { transform: 'scale(1)' },
              { transform: 'scale(1.25)', offset: 0.35 },
              { transform: 'scale(0.92)', offset: 0.65 },
              { transform: 'scale(1)' },
            ],
            { duration: 420, easing: 'ease-out' }
          )
        }
      })
      .catch(function () {})
      .finally(function () {
        delete btn.dataset.busy
      })
  })

  /* ---------------- 游客 QQ 头像（评论头像 C2 扩展，三处评论表单共用） ----------------
   * 选填：填了才抓头像；正则与 utils.ts isValidQQ 同款镜像（改任一侧记得同步）；
   * 填错给提示但不静默丢弃——游客自己决定改还是清空；上次填过的 QQ 存本机自动回填 */
  function guestQQ(form, tipEl) {
    var input = form.querySelector('[name=qq]')
    var qq = input ? input.value.trim() : ''
    if (!qq) return ''
    if (!/^[1-9][0-9]{4,10}$/.test(qq)) {
      if (tipEl) tipEl.textContent = T('QQ 号格式不对（5-11 位数字，不以 0 开头），可留空或修改后再发')
      if (input) input.focus()
      return null
    }
    return qq
  }
  var savedQQ = storeGet('cmt-qq') || ''
  if (savedQQ) {
    var qqInputs = document.querySelectorAll('input[name=qq]')
    for (var qi = 0; qi < qqInputs.length; qi++) if (!qqInputs[qi].value) qqInputs[qi].value = savedQQ
  }

  /* ---------------- 文章留言（管理员可回复：楼中楼） ---------------- */
  var form = document.getElementById('comment-form')
  if (form) {
    var tipEl = form.querySelector('.cmt-tip')
    var tipDefault = tipEl ? tipEl.textContent : ''
    var parentIdInput = form.querySelector('[name=parentId]')
    var nicknameInput = form.querySelector('[name=nickname]')
    var replyId = 0

    function setReply(id, name) {
      replyId = id || 0
      if (parentIdInput) parentIdInput.value = replyId ? String(replyId) : ''
      if (nicknameInput) nicknameInput.required = !replyId
      if (!tipEl) return
      if (!replyId) {
        tipEl.textContent = tipDefault
        return
      }
      tipEl.innerHTML =
        T('回复') + ' @' + esc(name) + ' <button type="button" class="cmt-reply-cancel">' + T('取消') + '</button>'
      var cancel = tipEl.querySelector('.cmt-reply-cancel')
      if (cancel)
        cancel.addEventListener('click', function () {
          setReply(0, '')
        })
      form.scrollIntoView({ behavior: 'smooth', block: 'center' })
      var ta = form.querySelector('[name=content]')
      if (ta) ta.focus()
    }

    document.addEventListener('click', function (e) {
      var btn = e.target && e.target.closest ? e.target.closest('.cmt-reply-btn') : null
      if (!btn) return
      e.preventDefault()
      setReply(Number(btn.getAttribute('data-reply')), btn.getAttribute('data-name') || '')
    })

    form.addEventListener('submit', function (e) {
      e.preventDefault()
      var btn = form.querySelector('.cmt-submit')
      var content = form.querySelector('[name=content]')
      var link = form.querySelector('[name=link]')
      if (!content.value.trim()) return
      // 管理员表单没有昵称输入（服务端直接取作者身份），访客留言必须填昵称
      if (nicknameInput && !replyId && !nicknameInput.value.trim()) return
      var qq = guestQQ(form, tipEl)
      if (qq === null) return
      var label = btn.textContent
      btn.textContent = T('发送中…')
      btn.disabled = true
      postJSON('/api/public/comments', {
        slug: form.getAttribute('data-slug'),
        nickname: nicknameInput ? nicknameInput.value.trim() : '',
        content: content.value.trim(),
        link: link ? link.value : '',
        qq: qq || undefined,
        parentId: replyId || undefined,
      })
        .then(function (d) {
          if (qq) storeSet('cmt-qq', qq)
          if (d && d.pending) {
            if (tipEl) tipEl.textContent = T('已提交，审核通过后展示')
            content.value = ''
            setReply(0, '')
            btn.textContent = label
            btn.disabled = false
          } else {
            if (tipEl) tipEl.textContent = T('留言成功，感谢参与 🙂')
            setTimeout(function () {
              location.reload()
            }, 600)
          }
        })
        .catch(function (err) {
          if (tipEl) tipEl.textContent = err.message || T('发送失败，请重试')
          btn.textContent = label
          btn.disabled = false
        })
    })
  }

  /* ---------------- 留言板（/guestbook：访客留言 + 作者回复，结构与文章留言一致） ---------------- */
  var gbForm = document.getElementById('guestbook-form')
  if (gbForm) {
    var gbTip = gbForm.querySelector('.cmt-tip')
    var gbTipDefault = gbTip ? gbTip.textContent : ''
    var gbParentInput = gbForm.querySelector('[name=parentId]')
    var gbNickname = gbForm.querySelector('[name=nickname]')

    function gbSetReply(id, name) {
      gbForm.dataset.replyId = id ? String(id) : ''
      if (gbParentInput) gbParentInput.value = id ? String(id) : ''
      if (gbNickname) gbNickname.required = !id
      if (!gbTip) return
      if (!id) {
        gbTip.textContent = gbTipDefault
        return
      }
      gbTip.innerHTML = T('回复') + ' @' + esc(name) + ' <button type="button" class="cmt-reply-cancel">' + T('取消') + '</button>'
      var cancel = gbTip.querySelector('.cmt-reply-cancel')
      if (cancel)
        cancel.addEventListener('click', function () {
          gbSetReply(0, '')
        })
      gbForm.scrollIntoView({ behavior: 'smooth', block: 'center' })
      var ta = gbForm.querySelector('[name=content]')
      if (ta) ta.focus()
    }

    document.addEventListener('click', function (e) {
      var btn = e.target && e.target.closest ? e.target.closest('.cmt-reply-btn') : null
      // 本监听是 document 级（文章页也注册），文章页没有 guestbook 容器——必须先判空
      var gb = document.getElementById('guestbook')
      if (!btn || !gb || !gb.contains(btn)) return
      e.preventDefault()
      gbSetReply(Number(btn.getAttribute('data-reply')), btn.getAttribute('data-name') || '')
    })

    gbForm.addEventListener('submit', function (e) {
      e.preventDefault()
      var btn = gbForm.querySelector('.cmt-submit')
      var content = gbForm.querySelector('[name=content]')
      var link = gbForm.querySelector('[name=link]')
      if (!content.value.trim()) return
      // 管理员表单没有昵称输入（服务端直接取作者身份），访客留言必须填昵称
      if (gbNickname && !gbForm.dataset.replyId && !gbNickname.value.trim()) return
      var qq = guestQQ(gbForm, gbTip)
      if (qq === null) return
      var label = btn.textContent
      btn.textContent = T('发送中…')
      btn.disabled = true
      postJSON('/api/public/guestbook', {
        nickname: gbNickname ? gbNickname.value.trim() : '',
        content: content.value.trim(),
        link: link ? link.value : '',
        qq: qq || undefined,
        parentId: gbForm.dataset.replyId ? Number(gbForm.dataset.replyId) : undefined,
      })
        .then(function (d) {
          if (qq) storeSet('cmt-qq', qq)
          if (d && d.pending) {
            if (gbTip) gbTip.textContent = T('已提交，审核通过后展示')
            content.value = ''
            gbSetReply(0, '')
            btn.textContent = label
            btn.disabled = false
          } else {
            if (gbTip) gbTip.textContent = T('留言成功，感谢参与 🙂')
            setTimeout(function () {
              location.reload()
            }, 600)
          }
        })
        .catch(function (err) {
          if (gbTip) gbTip.textContent = err.message || T('发送失败，请重试')
          btn.textContent = label
          btn.disabled = false
        })
    })
  }

  /* ---------------- 微信表情（[微笑] → 站内小图，表与 src/emoji.ts 同源经 /api/public/emoji 下发） ----------------
   * 声明在大 IIFE 顶层：wbTextHtml（下方嵌套块）与微博评论渲染（本层）共用；文章/微博/评论的 SSR
   * 直出由服务端 replaceEmoji 完成，这里只负责客户端就地重渲染。表未拉到时降级为纯文本码。
   * 镜像测试（tests/emoji.test.ts）把本段与 wbTextHtml 段切片拼接执行，双端同输入比对输出 */
  var WXQ_CODES
  var WXQ_BASE = '/emoji/'
  // 文本码 token：[名称]，名称里排除属性/实体特征字符（= ; & < > " ' / \）——与服务端同口径
  var WXQ_TOKEN_RE = /\[([^\[\]=;&<>"'/\\\n]{1,12})\]/g
  function wxqTokenHtml(token) {
    if (!WXQ_CODES) return token
    var name = token.slice(1, -1)
    if (!Object.prototype.hasOwnProperty.call(WXQ_CODES, name)) return token
    return (
      '<img class="wxq-emoji" style="width:1.4em;height:1.4em;vertical-align:-0.2em;" src="' +
      WXQ_BASE +
      WXQ_CODES[name] +
      '.png" alt="' +
      token +
      '" loading="lazy">'
    )
  }
  // 与 src/emoji.ts replaceEmoji 同口径：只替换 <> 标签外的 token（esc 后文本里的 < 已是 &lt;，
  // 不会误入标签态），hasOwnProperty 防原型链属性，查不到原样保留
  function wxqReplace(escaped) {
    if (!WXQ_CODES) return escaped
    var out = ''
    var last = 0
    var inTag = false
    WXQ_TOKEN_RE.lastIndex = 0
    var m
    while ((m = WXQ_TOKEN_RE.exec(escaped))) {
      var between = escaped.slice(last, m.index)
      for (var i = 0; i < between.length; i++) {
        var ch = between.charAt(i)
        if (ch === '<') inTag = true
        else if (ch === '>') inTag = false
      }
      out += between + (inTag ? m[0] : wxqTokenHtml(m[0]))
      last = m.index + m[0].length
    }
    return out + escaped.slice(last)
  }
  // 拉取映射表（镜像测试切片到本行之前，Node 里不会真的发请求；失败保持降级）
  fetch('/api/public/emoji')
    .then(function (r) {
      return r.ok ? r.json() : null
    })
    .then(function (d) {
      if (d && d.codes && d.base) {
        WXQ_CODES = d.codes
        WXQ_BASE = d.base
      }
    })
    .catch(function () {})

  /* ---------------- 微博卡片：折叠评论区 ---------------- */
  var authPromise = null
  function authState() {
    if (!authPromise) authPromise = getJSON('/api/auth/state').catch(function () { return { user: null } })
    return authPromise
  }

  // 平铺评论 → 楼中楼（父评论被删的回复按顶层展示）
  function renderWeiboComments(panel, comments, isAdmin, adminAvatar) {
    var listEl = panel.querySelector('[data-role=list]')
    if (!listEl) return
    var byParent = {}
    var ids = {}
    comments.forEach(function (c) {
      ids[c.id] = true
    })
    var tops = []
    comments.forEach(function (c) {
      if (!c.parent_id || !ids[c.parent_id]) tops.push(c)
      else (byParent[c.parent_id] = byParent[c.parent_id] || []).push(c)
    })
    if (!comments.length) {
      listEl.innerHTML = '<p class="wb-cmt-empty">' + T('还没有评论，来抢沙发～') + '</p>'
      return
    }
    // 评论头像位（服务端 commentAvatarHtml 的 ES5 手工镜像，改任一侧记得同步）：
    // 会员有站内头像用图；作者（管理员）发言用站点头像（adminAvatar，接口随列表下发）；
    // 游客自填 QQ 抓取转存的站内头像（接口只出 /images/ 地址，qq 本体永不下发）；其余退回昵称首字块
    function avatarHtml(c) {
      if (c.member_avatar) return '<img class="wb-cmt-avatar wb-cmt-avatar-img" src="' + esc(c.member_avatar) + '" alt="">'
      if (Number(c.is_admin) && adminAvatar) return '<img class="wb-cmt-avatar wb-cmt-avatar-img" src="' + esc(adminAvatar) + '" alt="">'
      if (c.avatar) return '<img class="wb-cmt-avatar wb-cmt-avatar-img" src="' + esc(c.avatar) + '" alt="">'
      var ch = (c.nickname || (EN ? 'G' : '客')).charAt(0) || (EN ? 'G' : '客')
      return '<span class="wb-cmt-avatar" aria-hidden="true">' + esc(ch) + '</span>'
    }
    function item(c, nested, floor) {
      var html =
        '<li class="wb-cmt-item' + (nested ? ' wb-cmt-nested' : '') + '" id="wbc-' + c.id + '">' +
        '<div class="wb-cmt-head">' + avatarHtml(c) + '<span class="wb-cmt-name">' + esc(c.nickname) +
        (Number(c.is_admin) ? '<span class="wb-cmt-badge">' + T('楼主') + '</span>' : c.member_name ? '<span class="wb-cmt-badge">' + (EN ? 'Member' : '会员') + '</span>' : '') +
        '</span><span class="wb-cmt-time">' + fmtTime(c.created_at) + '</span>' +
        (floor ? '<span class="wb-cmt-floor" style="font-size:11px;opacity:0.45;font-variant-numeric:tabular-nums">#' + floor + '</span>' : '') +
        (isAdmin
          ? '<button type="button" class="wb-cmt-reply-btn" data-reply="' + c.id + '" data-name="' + esc(c.nickname) + '">' + T('回复') + '</button>'
          : '') +
        '</div><div class="wb-cmt-body">' + wxqReplace(esc(c.content)) + '</div>'
      var kids = byParent[c.id] || []
      if (kids.length) html += '<ul class="wb-cmt-children">' + kids.map(function (k) { return item(k, true) }).join('') + '</ul>'
      return html + '</li>'
    }
    listEl.innerHTML = '<ul class="wb-cmt-list">' + tops.map(function (c, i) { return item(c, false, i + 1) }).join('') + '</ul>'
  }

  function loadWeiboComments(panel) {
    var listEl = panel.querySelector('[data-role=list]')
    var wbId = panel.getAttribute('data-wb-cmt')
    if (!listEl || !wbId) return
    listEl.innerHTML = '<p class="wb-cmt-loading">' + T('加载中…') + '</p>'
    Promise.all([getJSON('/api/public/weibo/' + encodeURIComponent(wbId) + '/comments'), authState()])
      .then(function (rs) {
        renderWeiboComments(panel, (rs[0] && rs[0].comments) || [], !!(rs[1] && rs[1].user), (rs[0] && rs[0].adminAvatar) || '')
      })
      .catch(function () {
        listEl.innerHTML = '<p class="wb-cmt-empty">' + T('评论加载失败，稍后再试') + '</p>'
      })
  }

  // 展开 / 收起（首次展开时拉取评论）
  document.addEventListener('click', function (e) {
    var toggle = e.target && e.target.closest ? e.target.closest('.wb-cmt-toggle') : null
    if (!toggle) return
    e.preventDefault()
    var card = toggle.closest('.wb-card')
    var panel = card && card.querySelector('.wb-cmt')
    if (!panel) return
    var willShow = panel.hidden
    panel.hidden = !willShow
    toggle.setAttribute('aria-expanded', willShow ? 'true' : 'false')
    if (willShow && !panel.dataset.loaded) {
      panel.dataset.loaded = '1'
      loadWeiboComments(panel)
    }
  })

  // 卡片内评论的「回复」（仅管理员可见的按钮由 JS 渲染）
  document.addEventListener('click', function (e) {
    var btn = e.target && e.target.closest ? e.target.closest('.wb-cmt-reply-btn') : null
    if (!btn) return
    e.preventDefault()
    var panel = btn.closest('.wb-cmt')
    var form = panel && panel.querySelector('[data-role=form]')
    if (!form) return
    form.dataset.replyId = btn.getAttribute('data-reply') || ''
    var nickname = form.querySelector('[name=nickname]')
    if (nickname) nickname.required = false
    var tip = form.querySelector('.wb-cmt-tip')
    if (tip) {
      tip.innerHTML =
        T('回复') + ' @' + esc(btn.getAttribute('data-name')) + ' <button type="button" class="wb-cmt-reply-cancel">' + T('取消') + '</button>'
      var cancel = tip.querySelector('.wb-cmt-reply-cancel')
      if (cancel)
        cancel.addEventListener('click', function () {
          form.dataset.replyId = ''
          if (nickname) nickname.required = true
          tip.textContent = ''
        })
    }
    var ta = form.querySelector('[name=content]')
    if (ta) ta.focus()
  })

  // 卡片内评论提交（访客留言 / 管理员回复共用一个表单）
  document.addEventListener('submit', function (e) {
    var form = e.target
    if (!form || !form.classList || !form.classList.contains('wb-cmt-form')) return
    e.preventDefault()
    var panel = form.closest('.wb-cmt')
    var card = form.closest('.wb-card')
    var toggle = card && card.querySelector('.wb-cmt-toggle')
    var wbId = panel && panel.getAttribute('data-wb-cmt')
    if (!wbId) return
    var content = form.querySelector('[name=content]')
    var nickname = form.querySelector('[name=nickname]')
    var link = form.querySelector('[name=link]')
    var tip = form.querySelector('.wb-cmt-tip')
    var btn = form.querySelector('.wb-cmt-submit')
    if (!content || !content.value.trim()) return
    // 管理员表单没有昵称输入（服务端直接取作者身份），访客必须填
    if (nickname && !form.dataset.replyId && !nickname.value.trim()) return
    var qq = guestQQ(form, tip)
    if (qq === null) return
    var label = btn ? btn.textContent : ''
    if (btn) {
      btn.textContent = T('发送中…')
      btn.disabled = true
    }
    postJSON('/api/public/weibo/' + encodeURIComponent(wbId) + '/comments', {
      nickname: nickname ? nickname.value.trim() : '',
      content: content.value.trim(),
      link: link ? link.value : '',
      qq: qq || undefined,
      parentId: form.dataset.replyId ? Number(form.dataset.replyId) : undefined,
    })
      .then(function (d) {
        if (qq) storeSet('cmt-qq', qq)
        if (d && d.pending) {
          if (tip) tip.textContent = T('已提交，审核通过后展示')
          content.value = ''
        } else {
          content.value = ''
          form.dataset.replyId = ''
          if (tip) tip.textContent = ''
          if (nickname) nickname.required = true
          loadWeiboComments(panel)
          var count = toggle && toggle.querySelector('[data-count]')
          if (count) count.textContent = String((parseInt(count.textContent, 10) || 0) + 1)
        }
      })
      .catch(function (err) {
        if (tip) tip.textContent = (err && err.message) || T('发送失败，请重试')
      })
      .finally(function () {
        if (btn) {
          btn.textContent = label
          btn.disabled = false
        }
      })
  })

  /* ---------------- 微博分享卡片：点击按需加载 /share-card.js（保持本文件极小体积） ---------------- */
  document.addEventListener('click', function (e) {
    var btn = e.target && e.target.closest ? e.target.closest('.wb-share') : null
    if (!btn) return
    e.preventDefault()
    var card = btn.closest('.wb-card')
    if (!card || btn.dataset.busy) return
    btn.dataset.busy = '1'
    import('/share-card.js')
      .then(function (m) {
        return m.openShareCard(card)
      })
      .catch(function () {
        var b = btn.querySelector('b')
        if (b) {
          b.textContent = T('失败')
          setTimeout(function () {
            b.textContent = T('分享')
          }, 2000)
        }
      })
      .finally(function () {
        delete btn.dataset.busy
      })
  })

  /* ---------------- 文章分享（复制链接/系统分享/卡片图+二维码）：同款按需加载 ---------------- */
  document.addEventListener('click', function (e) {
    var btn = e.target && e.target.closest ? e.target.closest('.share-btn') : null
    if (!btn) return
    e.preventDefault()
    if (btn.dataset.busy) return
    btn.dataset.busy = '1'
    import('/share-card.js')
      .then(function (m) {
        return m.openArticleShare(btn)
      })
      .catch(function () {
        var b = btn.querySelector('.share-label')
        if (b) {
          b.textContent = T('失败')
          setTimeout(function () {
            b.textContent = T('分享')
          }, 2000)
        }
      })
      .finally(function () {
        delete btn.dataset.busy
      })
  })

  /* ---------------- 微信表情面板（前台发布器 / 卡片编辑共用，ES5；表在上方 WXQ_CODES） ---------------- */
  function wxqInsertToken(ta, token) {
    if (!ta) return
    var s = ta.selectionStart == null ? ta.value.length : ta.selectionStart
    var e = ta.selectionEnd == null ? s : ta.selectionEnd
    ta.value = ta.value.slice(0, s) + token + ta.value.slice(e)
    var pos = s + token.length
    ta.focus()
    try {
      ta.setSelectionRange(pos, pos)
    } catch (err) {}
  }

  function wxqTogglePanel(btn, ta) {
    var old = document.querySelector('[data-wxq-panel]')
    if (old) {
      old.remove()
      return
    }
    if (!WXQ_CODES) return
    var names = []
    for (var k in WXQ_CODES) {
      if (Object.prototype.hasOwnProperty.call(WXQ_CODES, k)) names.push(k)
    }
    var panel = document.createElement('div')
    panel.setAttribute('data-wxq-panel', '')
    panel.setAttribute(
      'style',
      'position:absolute;z-index:80;background:#fff;border:1px solid rgba(0,0,0,.12);border-radius:12px;box-shadow:0 10px 28px rgba(0,0,0,.14);padding:8px;display:grid;grid-template-columns:repeat(8,32px);gap:2px;width:296px;max-height:216px;overflow-y:auto;'
    )
    for (var i = 0; i < names.length; i++) {
      ;(function (name) {
        var cell = document.createElement('button')
        cell.type = 'button'
        cell.title = '[' + name + ']'
        cell.setAttribute(
          'style',
          'border:none;background:none;padding:0;width:32px;height:32px;cursor:pointer;display:flex;align-items:center;justify-content:center;border-radius:6px;'
        )
        var img = document.createElement('img')
        img.src = WXQ_BASE + WXQ_CODES[name] + '.png'
        img.alt = ''
        img.loading = 'lazy'
        img.setAttribute('style', 'width:24px;height:24px;display:block;')
        cell.appendChild(img)
        cell.addEventListener('click', function (ev) {
          ev.preventDefault()
          wxqInsertToken(ta, '[' + name + ']')
        })
        panel.appendChild(cell)
      })(names[i])
    }
    var r = btn.getBoundingClientRect()
    var docW = document.documentElement.clientWidth
    panel.style.top = r.bottom + window.pageYOffset + 6 + 'px'
    panel.style.left = Math.max(8, Math.min(r.left + window.pageXOffset, docW - 306)) + 'px'
    document.body.appendChild(panel)
  }

  // 点外关闭（全局委托，一次注册）
  document.addEventListener('click', function (e) {
    var panel = document.querySelector('[data-wxq-panel]')
    if (!panel) return
    if (e.target.closest && (e.target.closest('[data-wxq-panel]') || e.target.closest('[data-wxq-btn]'))) return
    panel.remove()
  })

  // 给发布器 / 卡片编辑的按钮行插入表情按钮（插入动作依赖 JS，按钮也由 JS 动态加）
  function wxqAttachButton(foot, ta) {
    if (!foot || foot.querySelector('[data-wxq-btn]')) return
    var btn = document.createElement('button')
    btn.type = 'button'
    btn.className = 'wb-composer-add'
    btn.textContent = T('😊 表情')
    btn.setAttribute('data-wxq-btn', '')
    btn.addEventListener('click', function (e) {
      e.preventDefault()
      wxqTogglePanel(btn, ta)
    })
    foot.insertBefore(btn, foot.firstChild)
  }

  /* ---------------- 前台发微博（管理员登录时微博页顶部的发布框，能力与后台发布器一致） ---------------- */
  var composerForm = document.querySelector('[data-wb-composer]')
  if (composerForm) {
    var WB_MAX_IMAGES = 9
    var WB_MAX_CHARS = 5000
    var cpText = composerForm.querySelector('.wb-composer-textarea')
    var cpTiles = composerForm.querySelector('.wb-composer-tiles')
    var cpAdd = composerForm.querySelector('.wb-composer-add')
    var cpCount = composerForm.querySelector('.wb-composer-count')
    var cpTip = composerForm.querySelector('.wb-composer-tip')
    var cpButtons = composerForm.querySelectorAll('.wb-composer-add, .wb-composer-draft, .wb-composer-publish')
    var cpImages = []
    var cpUploading = 0 // 在途上传计数：发布前必须归零，否则发布会把没传完的图静默丢掉
    var cpTipTimer = null

    function cpMsg(msg) {
      if (!cpTip) return
      cpTip.textContent = msg || ''
      if (cpTipTimer) clearTimeout(cpTipTimer)
      if (msg) cpTipTimer = setTimeout(function () { cpTip.textContent = '' }, 4000)
    }

    function cpRender() {
      if (cpTiles) {
        cpTiles.hidden = !cpImages.length
        cpTiles.innerHTML = tileHtml(cpImages)
      }
      if (cpAdd) cpAdd.textContent = EN ? addLabelEn(cpImages.length, WB_MAX_IMAGES) : '加图（' + cpImages.length + '/' + WB_MAX_IMAGES + '）'
      if (cpCount && cpText) cpCount.textContent = cpText.value.length + ' / ' + WB_MAX_CHARS
    }

    if (cpTiles) {
      cpTiles.addEventListener('click', function (e) {
        var del = e.target && e.target.closest ? e.target.closest('.wb-composer-tile-del') : null
        if (!del) return
        cpImages.splice(Number(del.getAttribute('data-i')), 1)
        cpRender()
      })
    }
    if (cpText) cpText.addEventListener('input', cpRender)

    function cpAddFiles(fileList) {
      var all = Array.prototype.slice.call(fileList || [])
      var imgs = all.filter(function (f) { return /^image\//.test(f.type) })
      if (!imgs.length) {
        if (all.length) cpMsg(T('只支持 JPG / PNG / WebP / GIF 图片'))
        return
      }
      var room = WB_MAX_IMAGES - cpImages.length
      if (room <= 0) {
        cpMsg(EN ? 'At most ' + WB_MAX_IMAGES + ' photos' : '最多 ' + WB_MAX_IMAGES + ' 张图')
        return
      }
      if (imgs.length > room) cpMsg(EN ? 'At most ' + WB_MAX_IMAGES + ' photos — extras ignored' : '最多 ' + WB_MAX_IMAGES + ' 张图，多出的已忽略')
      var label = cpAdd ? cpAdd.textContent : ''
      if (cpAdd) cpAdd.disabled = true
      var chain = Promise.resolve()
      imgs.slice(0, room).forEach(function (f) {
        chain = chain.then(function () {
          cpUploading++
          if (cpAdd) cpAdd.textContent = (EN ? 'Uploading ' : '上传中 ') + f.name.slice(0, 12) + '…'
          return uploadCompressed(f)
            .then(function (url) {
              cpImages.push(url)
              cpRender()
            })
            .finally(function () {
              cpUploading--
            })
        })
      })
      chain
        .catch(function (err) {
          cpMsg((err && err.message) || T('上传失败'))
        })
        .finally(function () {
          if (cpAdd) {
            cpAdd.disabled = false
            cpAdd.textContent = label
          }
          cpRender()
        })
    }

    if (cpAdd) {
      cpAdd.addEventListener('click', function () {
        pickFiles({ accept: 'image/jpeg,image/png,image/webp,image/gif', multiple: true }, function (files) {
          cpAddFiles(files)
        })
      })
    }

    wxqAttachButton(composerForm.querySelector('.wb-composer-foot'), cpText)

    // 粘贴图片：光标在发布框内 ⌘/Ctrl+V 即上传（纯文本粘贴不受影响）
    composerForm.addEventListener('paste', function (e) {
      var files = Array.prototype.slice.call((e.clipboardData && e.clipboardData.files) || [])
      if (!files.length) return
      e.preventDefault()
      cpAddFiles(files)
    })
    // 拖拽图片到发布框（拖文本进输入框仍是默认行为）
    composerForm.addEventListener('dragover', function (e) {
      var types = e.dataTransfer && e.dataTransfer.types
      if (!types || !Array.prototype.includes.call(types, 'Files')) return
      e.preventDefault()
      composerForm.classList.add('is-dragover')
    })
    composerForm.addEventListener('dragleave', function () {
      composerForm.classList.remove('is-dragover')
    })
    composerForm.addEventListener('drop', function (e) {
      var files = Array.prototype.slice.call((e.dataTransfer && e.dataTransfer.files) || [])
      if (!files.length) return
      e.preventDefault()
      composerForm.classList.remove('is-dragover')
      cpAddFiles(files)
    })

    function cpPublish(status) {
      if (cpUploading > 0) return cpMsg(EN ? 'Images are still uploading — wait a moment' : '还有图片在上传中，等一下再发')
      var content = cpText ? cpText.value.trim() : ''
      if (!content && !cpImages.length) {
        cpMsg(EN ? 'Write something or attach a photo first' : '写点什么，或者配张图吧')
        return
      }
      cpButtons.forEach(function (b) { b.disabled = true })
      postJSON('/api/admin/weibo', { content: content, images: cpImages, status: status })
        .then(function () {
          if (status === 'published') {
            location.reload()
            return
          }
          if (cpText) cpText.value = ''
          cpImages = []
          cpRender()
          cpMsg(EN ? 'Draft saved — continue editing in the admin Notes page' : '草稿已保存，到后台「微博」页可继续编辑')
        })
        .catch(function (err) {
          cpMsg((err && err.message) || (EN ? 'Failed to publish — please try again' : '发布失败，请重试'))
        })
        .finally(function () {
          cpButtons.forEach(function (b) { b.disabled = false })
        })
    }
    var cpPub = composerForm.querySelector('.wb-composer-publish')
    var cpDraft = composerForm.querySelector('.wb-composer-draft')
    if (cpPub) cpPub.addEventListener('click', function () { cpPublish('published') })
    if (cpDraft) cpDraft.addEventListener('click', function () { cpPublish('draft') })
    cpRender()
  }

  /* ---------------- 微博卡管理（管理员登录时卡片上的 编辑 / 置顶 / 删除） ----------------
   * 按钮由服务端只对登录管理员渲染（weiboCards 的 adminName 参数），这里只负责交互；
   * 写操作直接复用后台 /api/admin/weibo* 端点（session 鉴权），访客无按钮也无入口。
   */
  ;(function () {
    var WB_MAX_IMAGES = 9
    var WB_MAX_CHARS = 5000
    // 与后端 weiboTextHtml（src/render.ts）/ utils.ts WEIBO_TOPIC_RE 三处同口径：URL 与 #话题
    // 单次扫描二选一（先转链接再扫话题会把 href 里的 #fragment 误判成话题），URL 不吞 CJK 与
    // 全角标点；话题名汉字后可跟、ASCII 字母数字防误判（C#）、句读（，。！？等）即停。
    // 用捕获组消费「# 前的字符」代替 lookbehind——Safari ≤ 16.3 不支持 lookbehind，
    // 正则字面量在解析期就抛 SyntaxError，会让整个 site.js 瘫掉（匹配语义与服务端一致）
    var WB_TEXT_RE = /(https?:\/\/[^\s<>"'\u3000-\u303f\uff00-\uffef\u4e00-\u9fff]+)|((^|[^A-Za-z0-9#])(#[^\s#&<>"'，。！？；：、…~～,.!?;:]{1,24}(?:#|(?=[\s，。！？；：、…~～,.!?;:])|$)))/gu

    // 与 src/outlink.ts 的 TRUSTED_OUT_DOMAINS 手工同步：前四项是站长自有域名，其余主流大站；
    // 白名单外域包 /go 中间页（外链提醒 + 免责声明），同源与白名单直出
    var TRUSTED_OUT = ['bloghao.com', 'xiaowuleyi.com', 'habfut.com', 'btchao.com', 'apple.com', 'icloud.com', 'google.com', 'youtube.com', 'android.com', 'microsoft.com', 'live.com', 'office.com', 'bing.com', 'github.com', 'gitlab.com', 'stackoverflow.com', 'npmjs.com', 'wikipedia.org', 'wikimedia.org', 'mozilla.org', 'cloudflare.com', 'amazon.com', 'x.com', 'twitter.com', 'twimg.com', 'facebook.com', 'instagram.com', 'threads.net', 'linkedin.com', 'reddit.com', 'pinterest.com', 'tiktok.com', 'telegram.org', 't.me', 'discord.com', 'medium.com', 'substack.com', 'openai.com', 'anthropic.com', 'huggingface.co', 'weibo.com', 'weibo.cn', 'sina.com.cn', 'baidu.com', 'zhihu.com', 'bilibili.com', 'b23.tv', 'qq.com', 'tencent.com', '163.com', '126.com', 'netease.com', 'jd.com', 'taobao.com', 'tmall.com', 'alipay.com', 'aliyun.com', 'alibaba.com', 'douyin.com', 'kuaishou.com', 'xiaohongshu.com', 'sohu.com', 'csdn.net', 'juejin.cn', 'cnblogs.com', 'segmentfault.com', 'v2ex.com', 'gitee.com', 'oschina.net', 'jianshu.com', 'sspai.com', 'ithome.com', '36kr.com', 'mi.com', 'xiaomi.com', 'huawei.com']

    function trustedOutHost(host) {
      var h = String(host || '').toLowerCase().replace(/\.+$/, '')
      if (!h) return false
      for (var i = 0; i < TRUSTED_OUT.length; i++) {
        var d = TRUSTED_OUT[i]
        if (h === d || h.slice(-(d.length + 1)) === '.' + d) return true
      }
      return false
    }

    // 与后端 outHref 同口径（超长 URL 不包，防撑爆请求行）
    function outHrefJs(url) {
      try {
        var u = new URL(url)
        if (u.protocol !== 'http:' && u.protocol !== 'https:') return url
        if (u.origin === location.origin) return url
        if (trustedOutHost(u.hostname)) return url
        if (url.length > 1000) return url
        return '/go?u=' + encodeURIComponent(u.href)
      } catch (e) {
        return url
      }
    }

    // 与后端 trimUrlTail 同口径：链接尾部标点留在链接外，括号配对时保留
    function trimUrlTailJs(u) {
      var s = u
      while (s.length > 1) {
        var last = s.charAt(s.length - 1)
        if (last === ')') {
          var opens = (s.match(/\(/g) || []).length
          if ((s.match(/\)/g) || []).length > opens) {
            s = s.slice(0, -1)
            continue
          }
          break
        }
        if (".,;:!?>'、。，；：！？）】」』》›»…·".indexOf(last) !== -1) {
          s = s.slice(0, -1)
          continue
        }
        break
      }
      return s
    }

    function wbTextHtml(content) {
      var out = ''
      var last = 0
      var text = String(content == null ? '' : content)
      var m
      WB_TEXT_RE.lastIndex = 0
      while ((m = WB_TEXT_RE.exec(text))) {
        out += wxqReplace(esc(text.slice(last, m.index)))
        last = m.index + m[0].length
        if (m[1]) {
          var url = trimUrlTailJs(m[1])
          out +=
            '<a class="wb-link" href="' + esc(outHrefJs(url)) + '" target="_blank" rel="noopener noreferrer">' +
            esc(url) + '</a>' + wxqReplace(esc(m[0].slice(url.length)))
        } else {
          var lead = m[3] || ''
          var tag = m[4]
          var name = tag.replace(/^#/, '').replace(/#$/, '')
          out += esc(lead)
          if (!name) out += wxqReplace(esc(tag))
          else out += '<a class="wb-topic" href="/weibo?topic=' + encodeURIComponent(name) + '">' + esc(tag) + '</a>'
        }
      }
      out += wxqReplace(esc(text.slice(last)))
      return out
    }

    // 图片网格 class 与后端 weiboImageGrid 同口径：1 张大图，2/4 张两列，其余三列
    function imgsClass(n) {
      return 'wb-imgs ' + (n === 1 ? 'wb-imgs-1' : n === 2 || n === 4 ? 'wb-imgs-2' : 'wb-imgs-3')
    }

    // 失败反馈：按钮文字短暂变成错误信息再还原（前台无全局 toast，评论/发布器同样是行内提示）
    function flashBtn(btn, msg) {
      if (!btn) return
      var old = btn.textContent
      btn.textContent = msg
      btn.disabled = true
      setTimeout(function () {
        btn.textContent = old
        btn.disabled = false
      }, 3000)
    }

    // 同步置顶状态到卡片：is-pinned 类、头部「置顶」标签、按钮文案；成功后恢复按钮可点
    function setPinned(card, pinned) {
      card.classList.toggle('is-pinned', pinned)
      var head = card.querySelector('.wb-head')
      var pin = head && head.querySelector('.wb-pin')
      if (pinned && !pin && head) {
        pin = document.createElement('span')
        pin.className = 'wb-pin'
        pin.textContent = T('置顶')
        head.appendChild(pin)
      }
      if (!pinned && pin) pin.remove()
      var btn = card.querySelector('[data-wb-act="pin"]')
      if (btn) {
        btn.textContent = pinned ? T('取消置顶') : T('置顶')
        btn.disabled = false
      }
    }

    function enterEdit(card, id) {
      if (card.querySelector('[data-wb-edit]')) return
      var textEl = card.querySelector('.wb-text')
      var imgsEl = card.querySelector('.wb-imgs')
      var foot = card.querySelector('.wb-foot')
      var admin = card.querySelector('.wb-admin')
      // 用内联 display 而非 hidden 属性：主题 CSS 里 .wb-imgs 等常设 display，会盖掉 [hidden]
      if (admin) admin.style.display = 'none'
      if (textEl) textEl.style.display = 'none'
      if (imgsEl) imgsEl.style.display = 'none'

      var form = document.createElement('form')
      form.className = 'wb-edit'
      form.setAttribute('data-wb-edit', '')
      form.innerHTML =
        '<textarea class="wb-composer-textarea" name="content" maxlength="5000" rows="5" placeholder="' + T('说点什么…') + '"></textarea>' +
        '<div class="wb-composer-tiles" hidden></div>' +
        '<div class="wb-composer-foot">' +
        '<button type="button" class="wb-composer-add">' + (EN ? addLabelEn(0, WB_MAX_IMAGES) : '加图（0/' + WB_MAX_IMAGES + '）') + '</button>' +
        '<span class="wb-composer-count">0 / ' + WB_MAX_CHARS + '</span>' +
        '<span class="wb-composer-tip" aria-live="polite"></span>' +
        '<button type="button" class="wb-composer-draft" data-wb-edit-cancel>' + T('取消') + '</button>' +
        '<button type="button" class="wb-composer-publish" data-wb-edit-save>' + T('保存') + '</button>' +
        '</div>'
      form.addEventListener('submit', function (e) { e.preventDefault() })
      if (foot) card.insertBefore(form, foot)
      else card.appendChild(form)

      wxqAttachButton(form.querySelector('.wb-composer-foot'), form.querySelector('textarea'))
      var ta = form.querySelector('textarea')
      var tiles = form.querySelector('.wb-composer-tiles')
      var addBtn = form.querySelector('.wb-composer-add')
      var countEl = form.querySelector('.wb-composer-count')
      var tipEl = form.querySelector('.wb-composer-tip')
      var saveBtn = form.querySelector('[data-wb-edit-save]')
      var cancelBtn = form.querySelector('[data-wb-edit-cancel]')
      var images = []
      var uploading = 0 // 与顶部发布框同口径：保存前必须等在途上传归零
      var tipTimer = null

      function tip(msg) {
        if (!tipEl) return
        tipEl.textContent = msg || ''
        if (tipTimer) clearTimeout(tipTimer)
        if (msg) tipTimer = setTimeout(function () { tipEl.textContent = '' }, 4000)
      }
      function renderTiles() {
        tiles.hidden = !images.length
        tiles.innerHTML = tileHtml(images)
        addBtn.textContent = EN ? addLabelEn(images.length, WB_MAX_IMAGES) : '加图（' + images.length + '/' + WB_MAX_IMAGES + '）'
        countEl.textContent = ta.value.length + ' / ' + WB_MAX_CHARS
      }

      ta.addEventListener('input', renderTiles)
      tiles.addEventListener('click', function (e) {
        var del = e.target && e.target.closest ? e.target.closest('.wb-composer-tile-del') : null
        if (!del) return
        images.splice(Number(del.getAttribute('data-i')), 1)
        renderTiles()
      })

      function addFiles(fileList) {
        var imgs = [].slice.call(fileList || []).filter(function (f) { return /^image\//.test(f.type) })
        if (!imgs.length) return
        var room = WB_MAX_IMAGES - images.length
        if (room <= 0) return tip(EN ? 'At most ' + WB_MAX_IMAGES + ' photos' : '最多 ' + WB_MAX_IMAGES + ' 张图')
        var label = addBtn.textContent
        addBtn.disabled = true
        var chain = Promise.resolve()
        imgs.slice(0, room).forEach(function (f) {
          chain = chain.then(function () {
            uploading++
            addBtn.textContent = (EN ? 'Uploading ' : '上传中 ') + f.name.slice(0, 12) + '…'
            return uploadCompressed(f)
              .then(function (url) {
                images.push(url)
                renderTiles()
              })
              .finally(function () {
                uploading--
              })
          })
        })
        chain
          .catch(function (err) { tip((err && err.message) || T('上传失败')) })
          .finally(function () {
            addBtn.disabled = false
            addBtn.textContent = label
            renderTiles()
          })
      }
      addBtn.addEventListener('click', function () {
        pickFiles({ accept: 'image/jpeg,image/png,image/webp,image/gif', multiple: true }, function (files) {
          addFiles(files)
        })
      })
      // 粘贴 / 拖拽加图，与顶部发布框同款
      form.addEventListener('paste', function (e) {
        var files = [].slice.call((e.clipboardData && e.clipboardData.files) || [])
        if (!files.length) return
        e.preventDefault()
        addFiles(files)
      })
      form.addEventListener('dragover', function (e) {
        var types = e.dataTransfer && e.dataTransfer.types
        if (!types || !Array.prototype.includes.call(types, 'Files')) return
        e.preventDefault()
      })
      form.addEventListener('drop', function (e) {
        var files = [].slice.call((e.dataTransfer && e.dataTransfer.files) || [])
        if (!files.length) return
        e.preventDefault()
        addFiles(files)
      })

      function leaveEdit() {
        form.remove()
        if (textEl) textEl.style.display = ''
        if (imgsEl) imgsEl.style.display = ''
        if (admin) admin.style.display = ''
      }
      cancelBtn.addEventListener('click', leaveEdit)

      saveBtn.addEventListener('click', function () {
        if (uploading > 0) return tip(EN ? 'Images are still uploading — wait a moment' : '还有图片在上传中，等一下再保存')
        var content = ta.value.trim()
        if (!content && !images.length) return tip(EN ? 'Write something or attach a photo first' : '写点什么，或者配张图吧')
        saveBtn.textContent = T('保存中…')
        saveBtn.disabled = true
        cancelBtn.disabled = true
        // PUT 是全量更新：必须带上现有 images，不然配图会被清空（与后台编辑同约束）
        fetch('/api/admin/weibo/' + id, {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ content: content, images: images, status: 'published' }),
        })
          .then(function (r) {
            return r.json().then(function (d) {
              if (!r.ok) throw new Error((d && d.error) || T('保存失败'))
              // 就地更新正文与配图（渲染与后端 weiboTextHtml / weiboImageGrid 同口径）
              if (content) {
                if (!textEl) {
                  textEl = document.createElement('div')
                  textEl.className = 'wb-text'
                  card.insertBefore(textEl, form)
                }
                textEl.innerHTML = wbTextHtml(content)
                textEl.style.display = ''
              } else if (textEl) {
                textEl.remove()
                textEl = null
              }
              if (images.length) {
                if (!imgsEl) {
                  imgsEl = document.createElement('div')
                  card.insertBefore(imgsEl, form)
                }
                imgsEl.className = imgsClass(images.length)
                imgsEl.innerHTML = images
                  .map(function (u) { return '<img src="' + esc(u) + '" loading="lazy" alt="">' })
                  .join('')
                imgsEl.style.display = ''
              } else if (imgsEl) {
                imgsEl.remove()
                imgsEl = null
              }
              leaveEdit()
            })
          })
          .catch(function (err) {
            tip((err && err.message) || T('保存失败，请重试'))
            saveBtn.textContent = T('保存')
            saveBtn.disabled = false
            cancelBtn.disabled = false
          })
      })

      // 取原稿（正文要未转义原文，DOM 里的渲染文本反解不可靠）；失败留在编辑态提示，可取消重进。
      // 原稿加载完成前禁用保存：PUT 是全量更新，加载失败时保存会用空正文/空配图覆盖原稿
      saveBtn.disabled = true
      ta.disabled = true
      renderTiles()
      getJSON('/api/admin/weibo/' + id)
        .then(function (d) {
          ta.value = (d.weibo && d.weibo.content) || ''
          images = ((d.weibo && d.weibo.imageList) || []).slice(0, WB_MAX_IMAGES)
          ta.disabled = false
          saveBtn.disabled = false
          renderTiles()
          ta.focus()
        })
        .catch(function (err) {
          ta.disabled = false
          tip((err && err.message) || T('加载失败，请取消后重新进编辑'))
        })
    }

    document.addEventListener('click', function (e) {
      var btn = e.target && e.target.closest ? e.target.closest('.wb-admin-btn') : null
      if (!btn) return
      var admin = btn.closest('.wb-admin')
      var card = btn.closest('.wb-card')
      if (!admin || !card) return
      var id = admin.getAttribute('data-wb-admin')
      var act = btn.getAttribute('data-wb-act')
      if (act === 'edit') {
        enterEdit(card, id)
      } else if (act === 'pin') {
        var pinned = !card.classList.contains('is-pinned')
        btn.disabled = true
        postJSON('/api/admin/weibo/' + id + '/pin', { pinned: pinned })
          .then(function () {
            setPinned(card, pinned)
            // 置顶后挪到列表最前（服务端 pinnedFirst 排序，与刷新后的顺序一致）
            if (pinned && card.parentNode && card.parentNode.firstElementChild !== card) {
              card.parentNode.insertBefore(card, card.parentNode.firstElementChild)
            }
          })
          .catch(function (err) {
            flashBtn(btn, (err && err.message) || T('操作失败'))
          })
      } else if (act === 'del') {
        // 软删进回收站（后台可恢复，30 天后自动彻底清除）；前台无恢复入口，去后台「回收站」页操作
        if (!confirm(EN ? 'Delete this note? It moves to the admin trash and can be restored within 30 days.' : '确定删除这条微博？将移入后台回收站，30 天内可恢复。')) return
        btn.textContent = T('删除中…')
        btn.disabled = true
        fetch('/api/admin/weibo/' + id, { method: 'DELETE' })
          .then(function (r) {
            return r.json().then(function (d) {
              if (!r.ok) throw new Error((d && d.error) || T('删除失败'))
              card.style.transition = 'opacity .25s ease'
              card.style.opacity = '0'
              setTimeout(function () { card.remove() }, 260)
            })
          })
          .catch(function (err) {
            flashBtn(btn, (err && err.message) || T('删除失败'))
          })
      }
    })
  })()

  /* ---------------- 友链申请收录（/links 页表单） ---------------- */
  document.addEventListener('submit', function (e) {
    var form = e.target
    if (!form || !form.classList || !form.classList.contains('fl-form')) return
    e.preventDefault()
    var name = form.querySelector('[name=name]')
    var url = form.querySelector('[name=url]')
    var desc = form.querySelector('[name=description]')
    var link = form.querySelector('[name=link]')
    var tip = form.querySelector('.fl-tip')
    var btn = form.querySelector('.fl-submit')
    if (!name.value.trim() || !url.value.trim()) return
    var label = btn.textContent
    btn.textContent = T('提交中…')
    btn.disabled = true
    postJSON('/api/public/links/apply', {
      name: name.value.trim(),
      url: url.value.trim(),
      description: desc ? desc.value.trim() : '',
      link: link ? link.value : '',
    })
      .then(function () {
        name.value = ''
        url.value = ''
        if (desc) desc.value = ''
        if (tip) tip.textContent = T('已提交，站长审核通过后就会展示在这里 🎉')
      })
      .catch(function (err) {
        if (tip) tip.textContent = (err && err.message) || T('提交失败，请重试')
      })
      .finally(function () {
        btn.textContent = label
        btn.disabled = false
      })
  })

  /* ---------------- 图片灯箱：正文图 + 微博配图，点击全屏查看 ----------------
   * 手势：单指/滚轮缩放（双指捏合）、拖动平移、双击放大复原、左右滑动切换同组图片。
   * 纯 JS + 内联 style（CSP style-src 允许内联），无外部依赖。 */
  ;(function () {
    var lb = null
    var imgEl = null
    var counterEl = null
    var group = [] // 同组图片 URL
    var idx = 0
    var scale = 1
    var tx = 0
    var ty = 0
    var pinchDist = 0
    var pointers = new Map()
    var lastTap = 0

    function apply() {
      imgEl.style.transform = 'translate(' + tx + 'px,' + ty + 'px) scale(' + scale + ')'
    }
    function reset() {
      scale = 1
      tx = 0
      ty = 0
      apply()
    }
    function show(i) {
      idx = (i + group.length) % group.length
      imgEl.src = group[idx]
      reset()
      // 计数器统一在这里更新：键盘翻页（onKey）与触摸滑动都走 show，不会再漏
      if (counterEl) counterEl.textContent = group.length > 1 ? idx + 1 + ' / ' + group.length : ''
    }
    function close() {
      if (!lb) return
      document.removeEventListener('keydown', onKey, true)
      lb.remove()
      lb = null
      imgEl = null
      counterEl = null
      group = []
      // 残留触点会污染下次 open 后的捏合/滑动判定（如捏合中途直接关闭）
      pointers.clear()
      pinchDist = 0
      document.body.style.overflow = ''
    }
    function onKey(e) {
      if (!lb) return
      if (e.key === 'Escape') close()
      else if (e.key === 'ArrowRight' && group.length > 1) show(idx + 1)
      else if (e.key === 'ArrowLeft' && group.length > 1) show(idx - 1)
      else return
      e.preventDefault()
    }
    function open(target) {
      // 同组：同一容器里的所有内容图（文章正文 / 微博九图），按 DOM 顺序
      var holder = target.closest('.rich, .wb-imgs, .wb-card') || document.body
      var imgs = [].slice.call(holder.querySelectorAll('img')).filter(function (im) {
        // 同入口委托口径排除小图（<100px，头像/图标/表情）：键盘翻页不翻进 22px 表情再被拉伸成模糊大图
        var w = im.getBoundingClientRect().width
        return (im.currentSrc || im.src) && !im.closest('a') && !(w && w < 100)
      })
      group = imgs.map(function (im) {
        return im.currentSrc || im.src
      })
      idx = Math.max(0, imgs.indexOf(target))
      if (!group.length) return

      lb = document.createElement('div')
      lb.setAttribute(
        'style',
        'position:fixed;inset:0;z-index:99999;background:rgba(0,0,0,.92);display:flex;align-items:center;justify-content:center;touch-action:none;cursor:zoom-out;'
      )
      var counter = document.createElement('div')
      counter.setAttribute(
        'style',
        'position:absolute;top:calc(12px + env(safe-area-inset-top));left:0;right:0;text-align:center;color:#fff;font-size:13px;opacity:.7;pointer-events:none;font-family:-apple-system,sans-serif;'
      )
      var btnClose = document.createElement('div')
      btnClose.setAttribute(
        'style',
        'position:absolute;top:calc(6px + env(safe-area-inset-top));right:10px;width:40px;height:40px;line-height:38px;text-align:center;color:#fff;font-size:26px;cursor:pointer;font-family:-apple-system,sans-serif;'
      )
      btnClose.textContent = '×'
      btnClose.addEventListener('click', close)
      imgEl = document.createElement('img')
      imgEl.setAttribute('style', 'max-width:92vw;max-height:88vh;transition:transform .18s ease;will-change:transform;user-select:none;-webkit-user-drag:none;')
      lb.appendChild(imgEl)
      lb.appendChild(counter)
      lb.appendChild(btnClose)
      document.body.appendChild(lb)
      document.body.style.overflow = 'hidden'
      counterEl = counter
      counter.textContent = group.length > 1 ? (idx + 1) + ' / ' + group.length : ''
      document.addEventListener('keydown', onKey, true)

      // 指针事件统一处理鼠标拖动 / 触摸 / 双指捏合
      lb.addEventListener('pointerdown', function (e) {
        pointers.set(e.pointerId, { x: e.clientX, y: e.clientY })
        if (pointers.size === 2) {
          var ps = [].slice.call(pointers.values())
          pinchDist = Math.hypot(ps[0].x - ps[1].x, ps[0].y - ps[1].y)
        }
        // 双击（300ms 内两次 tap）放大 1↔2.5
        var now = Date.now()
        if (now - lastTap < 300 && pointers.size === 1) {
          scale = scale > 1.4 ? 1 : 2.5
          if (scale === 1) {
            tx = 0
            ty = 0
          }
          apply()
        }
        lastTap = now
        imgEl.style.transition = 'none'
      })
      lb.addEventListener('pointermove', function (e) {
        if (!pointers.has(e.pointerId)) return
        var prev = pointers.get(e.pointerId)
        pointers.set(e.pointerId, { x: e.clientX, y: e.clientY })
        if (pointers.size === 2) {
          var ps = [].slice.call(pointers.values())
          var d = Math.hypot(ps[0].x - ps[1].x, ps[0].y - ps[1].y)
          if (pinchDist > 0) {
            scale = Math.min(6, Math.max(1, scale * (d / pinchDist)))
            apply()
          }
          pinchDist = d
          return
        }
        if (scale > 1) {
          tx += e.clientX - prev.x
          ty += e.clientY - prev.y
          apply()
          return
        }
        // 未放大时横向拖超过 60px 即切图（touch 上跟手，抬手判定）
        var dx = e.clientX - prev.x
        if (group.length > 1 && Math.abs(dx) > 0) imgEl.style.transform = 'translateX(' + dx / 3 + 'px)'
      })
      var startPos = null
      lb.addEventListener('pointerdown', function (e) {
        if (pointers.size === 1) startPos = { x: e.clientX, y: e.clientY, t: Date.now() }
      })
      lb.addEventListener('pointerup', function (e) {
        var wasPinch = pointers.size >= 2
        pointers.delete(e.pointerId)
        pinchDist = 0
        imgEl.style.transition = 'transform .18s ease'
        if (wasPinch) return
        if (startPos && scale === 1) {
          var dx = e.clientX - startPos.x
          var dy = e.clientY - startPos.y
          var dt = Date.now() - startPos.t
          if (group.length > 1 && Math.abs(dx) > 60 && Math.abs(dx) > Math.abs(dy) && dt < 600) {
            show(idx + (dx < 0 ? 1 : -1))
            startPos = null
            return
          }
          if (Math.abs(dx) < 8 && Math.abs(dy) < 8 && e.target === lb) {
            close()
            startPos = null
            return
          }
        }
        startPos = null
        reset()
      })
      lb.addEventListener('pointercancel', function (e) {
        pointers.delete(e.pointerId)
        pinchDist = 0
        reset()
      })
      // 桌面滚轮缩放
      lb.addEventListener(
        'wheel',
        function (e) {
          e.preventDefault()
          scale = Math.min(6, Math.max(1, scale * (e.deltaY < 0 ? 1.15 : 0.87)))
          if (scale === 1) {
            tx = 0
            ty = 0
          }
          apply()
        },
        { passive: false }
      )

      show(idx)
    }

    // 委托点击：正文图与微博配图进入灯箱（编辑器里 data-og-image 的 meta 不含 img，不受影响）
    document.addEventListener('click', function (e) {
      var t = e.target
      if (!t || t.tagName !== 'IMG') return
      // 排除头像、图标等小图（<100px）与已带链接的图
      var r = t.getBoundingClientRect()
      if (r.width && r.width < 100) return
      if (t.closest('a')) return
      if (!t.closest('.rich, .wb-imgs')) return
      e.preventDefault()
      open(t)
    })
  })()

  /* ---------------- 返回顶部：长文滚动过一屏后右下角浮现 ----------------
   * 纯 JS + 内联 style（灯箱同路），样式自含不给七主题加负担；底部贴 safe-area */
  ;(function () {
    var btn = document.createElement('button')
    btn.type = 'button'
    btn.setAttribute('aria-label', T('返回顶部'))
    btn.title = T('返回顶部')
    btn.innerHTML = '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12 19V5M5 12l7-7 7 7"/></svg>'
    btn.style.cssText =
      'display:none;position:fixed;right:18px;bottom:calc(18px + env(safe-area-inset-bottom));z-index:50;' +
      'width:40px;height:40px;border:none;border-radius:50%;cursor:pointer;' +
      'background:rgba(40,38,34,0.78);color:#fff;box-shadow:0 2px 10px rgba(0,0,0,0.18);' +
      '-webkit-tap-highlight-color:transparent;align-items:center;justify-content:center;'
    var visible = false
    function update() {
      var y = window.pageYOffset || document.documentElement.scrollTop || 0
      var show = y > 480
      if (show === visible) return
      visible = show
      btn.style.display = show ? 'flex' : 'none'
    }
    window.addEventListener('scroll', update, { passive: true })
    btn.addEventListener('click', function () {
      var smooth = 'scrollBehavior' in document.documentElement.style &&
        !(window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches)
      if (smooth) window.scrollTo({ top: 0, behavior: 'smooth' })
      else window.scrollTo(0, 0)
    })
    document.body.appendChild(btn)
    update()
  })()

  /* ---------------- 代码块一键复制：.rich pre 右上角常驻小按钮 ----------------
   * 包一层定位容器（七主题无 .rich > pre 子选择器，安全），剪贴板 API 不可用时回落 execCommand */
  ;(function () {
    function flash(btn, text) {
      btn.textContent = text
      clearTimeout(btn.__xwTimer)
      btn.__xwTimer = setTimeout(function () {
        btn.textContent = T('复制代码')
      }, 1400)
    }
    function legacyCopy(text) {
      var ta = document.createElement('textarea')
      ta.value = text
      ta.style.cssText = 'position:fixed;left:-9999px;top:0;'
      document.body.appendChild(ta)
      ta.focus()
      ta.select()
      var ok = false
      try {
        ok = document.execCommand('copy')
      } catch (e) {}
      document.body.removeChild(ta)
      return ok
    }
    var pres = document.querySelectorAll('.rich pre')
    for (var i = 0; i < pres.length; i++) {
      ;(function (pre) {
        var wrap = document.createElement('div')
        wrap.style.cssText = 'position:relative;'
        pre.parentNode.insertBefore(wrap, pre)
        wrap.appendChild(pre)
        var btn = document.createElement('button')
        btn.type = 'button'
        btn.textContent = T('复制代码')
        btn.setAttribute('aria-label', T('复制代码'))
        btn.style.cssText =
          'position:absolute;top:8px;right:8px;z-index:1;padding:4px 10px;font-size:12px;line-height:1.4;' +
          'border:1px solid rgba(0,0,0,0.1);border-radius:8px;cursor:pointer;' +
          'background:rgba(255,255,255,0.85);color:#555;backdrop-filter:blur(2px);' +
          '-webkit-tap-highlight-color:transparent;'
        btn.addEventListener('click', function (e) {
          e.stopPropagation()
          var text = pre.innerText || pre.textContent || ''
          var done = function () {
            flash(btn, T('已复制'))
          }
          var fail = function () {
            flash(btn, T('复制失败'))
          }
          if (navigator.clipboard && navigator.clipboard.writeText) {
            navigator.clipboard.writeText(text).then(done, function () {
              ;(legacyCopy(text) ? done : fail)()
            })
          } else {
            ;(legacyCopy(text) ? done : fail)()
          }
        })
        wrap.appendChild(btn)
      })(pres[i])
    }
  })()

  /* ---------------- 标题锚点 ¶：桌面 hover h2/h3 浮现，点击复制带锚点的链接 ----------------
   * id 由服务端 pages.ts headingAnchors 注入（toc-N）；触屏无 hover 不出，防误触 */
  ;(function () {
    if (!window.matchMedia || !window.matchMedia('(hover: hover)').matches) return
    var rich = document.querySelector('.rich')
    if (!rich) return
    var heads = rich.querySelectorAll('h2[id], h3[id]')
    var pinned = null
    function copyUrl(url, ok) {
      if (navigator.clipboard && navigator.clipboard.writeText) {
        navigator.clipboard.writeText(url).then(ok, function () {})
      } else {
        var ta = document.createElement('textarea')
        ta.value = url
        ta.style.cssText = 'position:fixed;left:-9999px;top:0;'
        document.body.appendChild(ta)
        ta.select()
        try {
          document.execCommand('copy')
          ok()
        } catch (e) {}
        document.body.removeChild(ta)
      }
    }
    for (var i = 0; i < heads.length; i++) {
      ;(function (h) {
        h.addEventListener('mouseenter', function () {
          if (h.querySelector('.xw-hanchor')) return
          var a = document.createElement('a')
          a.className = 'xw-hanchor'
          a.href = '#' + h.id
          a.textContent = '¶'
          a.title = T('复制本节链接')
          a.setAttribute('aria-label', T('复制本节链接'))
          a.style.cssText = 'margin-left:8px;font-weight:400;text-decoration:none;opacity:0.55;color:inherit;'
          a.addEventListener('click', function (e) {
            e.preventDefault()
            copyUrl(location.href.split('#')[0] + '#' + h.id, function () {
              a.textContent = '✓'
              pinned = a
              setTimeout(function () {
                pinned = null
                if (a.parentNode) a.parentNode.removeChild(a)
              }, 1100)
            })
          })
          h.appendChild(a)
        })
        h.addEventListener('mouseleave', function () {
          if (pinned && pinned.parentNode === h) return
          var a = h.querySelector('.xw-hanchor')
          if (a) a.parentNode.removeChild(a)
        })
      })(heads[i])
    }
  })()

  /* ---------------- 创作热力图：窄屏横向溢出时默认滚到最右（最新的周），一眼看到最近更新 ----------------
   * 不溢出（桌面端整年放得下）时赋值无效，天然不滚动 */
  ;(function () {
    var scrollers = document.querySelectorAll('.hm-scroll')
    for (var i = 0; i < scrollers.length; i++) scrollers[i].scrollLeft = scrollers[i].scrollWidth
  })()

  /* ---------------- 阅读工具条：文章页顶部进度条 + 章节胶囊 + 吸顶导航收放 + 目录 scrollspy ----------------
   * 进度条与章节胶囊内联样式自含（填充色走各主题一行 CSS 钩子 .xw-readbar-fill）；
   * 带 data-xw-nav-sticky 的导航（wechat 先行）下滚收起、上滑浮现，收起后章节胶囊接力报方位；
   * wechat 桌面目录卡（.wx-toc）随滚动高亮当前小节。rAF 节流，无标题/无滚动的短页全部空转 */
  ;(function () {
    var rich = document.querySelector('.rich')
    if (!rich) return
    var heads = rich.querySelectorAll('h2[id], h3[id]')
    var headList = []
    for (var i = 0; i < heads.length; i++) {
      headList.push({ el: heads[i], text: (heads[i].textContent || '').trim(), id: heads[i].id })
    }
    var tocLinks = {}
    var toc = document.querySelector('.wx-toc')
    if (toc) {
      var links = toc.querySelectorAll('a[href^="#"]')
      for (var j = 0; j < links.length; j++) tocLinks[links[j].getAttribute('href').slice(1)] = links[j]
    }
    var bar = document.createElement('div')
    bar.setAttribute('aria-hidden', 'true')
    bar.style.cssText = 'position:fixed;top:0;left:0;right:0;height:3px;z-index:80;pointer-events:none;'
    var fill = document.createElement('i')
    fill.className = 'xw-readbar-fill'
    fill.style.cssText = 'display:block;height:100%;width:0;'
    bar.appendChild(fill)
    var chip = document.createElement('span')
    chip.className = 'xw-readbar-chip'
    chip.setAttribute('aria-hidden', 'true')
    chip.style.cssText =
      'position:fixed;top:10px;left:16px;z-index:81;max-width:60%;padding:4px 12px;border-radius:999px;' +
      'font-size:12px;line-height:1.4;color:#fff;background:rgba(40,38,34,0.72);-webkit-backdrop-filter:blur(4px);backdrop-filter:blur(4px);' +
      'white-space:nowrap;overflow:hidden;text-overflow:ellipsis;pointer-events:none;opacity:0;transition:opacity 0.2s ease;'
    document.body.appendChild(bar)
    document.body.appendChild(chip)
    var nav = document.querySelector('[data-xw-nav-sticky]')
    var lastY = window.pageYOffset || 0

    function currentHeading() {
      var cur = null
      for (var k = 0; k < headList.length; k++) {
        if (headList[k].el.getBoundingClientRect().top <= 72) cur = headList[k]
        else break
      }
      return cur
    }

    function onScroll() {
      // 先集中读、后集中写（避免读写交错引发布局抖动）；不走 rAF——标签页失焦时 rAF
      // 停摆会让节流阀卡死在 true、处理器永久失灵（实机抓过），处理器本身足够便宜
      var y = window.pageYOffset || document.documentElement.scrollTop || 0
      var doc = document.documentElement
      var max = doc.scrollHeight - window.innerHeight
      var pct = (max > 0 ? Math.min(1, Math.max(0, y / max)) : 0) * 100
      var deep = y > 320
      var cur = deep ? currentHeading() : null
      var navWasHidden = nav ? nav.classList.contains('xw-nav-hide') : false
      if (nav) {
        if (y > lastY + 4 && y > 240) nav.classList.add('xw-nav-hide')
        else if (y < lastY - 4) nav.classList.remove('xw-nav-hide')
      }
      lastY = y
      var show = !!cur && (!nav || nav.classList.contains('xw-nav-hide'))
      fill.style.width = pct.toFixed(2) + '%'
      if (show) {
        chip.textContent = cur.text
        chip.style.opacity = '1'
      } else if (navWasHidden || chip.style.opacity === '1') {
        chip.style.opacity = '0'
      }
      if (toc) {
        for (var id in tocLinks) {
          if (tocLinks[id].classList.contains('is-current')) tocLinks[id].classList.remove('is-current')
        }
        if (cur && tocLinks[cur.id]) tocLinks[cur.id].classList.add('is-current')
      }
    }
    window.addEventListener('scroll', onScroll, { passive: true })
    onScroll()
  })()

  /* ---------------- 会员（/member：登录 / 注册 / 退出，API 见 DEVPLAN 附录 A5） ----------------
   * 表单为服务端渲染（memberAuthHtml），这里只接管提交与双表单切换；
   * 无 JS 时两个表单都可见可直接提交，有 JS 时只显当前一个 */
  var memAuth = document.querySelector('.mem-auth')
  if (memAuth) {
    var memForms = memAuth.querySelectorAll('[data-member-form]')
    if (memForms.length > 1) {
      var memShow = function (name) {
        memForms.forEach(function (f) {
          f.hidden = f.getAttribute('data-member-form') !== name
        })
      }
      memAuth.addEventListener('click', function (e) {
        var btn = e.target && e.target.closest ? e.target.closest('[data-member-swap]') : null
        if (btn) memShow(btn.getAttribute('data-member-swap') || 'login')
      })
      memShow('login')
    }
    memForms.forEach(function (form) {
      var kind = form.getAttribute('data-member-form')
      var tip = form.querySelector('[data-member-tip]')
      form.addEventListener('submit', function (e) {
        e.preventDefault()
        var btn = form.querySelector('.mem-btn')
        if (!btn || btn.disabled) return
        var username = form.querySelector('[name=username]')
        var password = form.querySelector('[name=password]')
        var email = form.querySelector('[name=email]')
        var link = form.querySelector('[name=link]')
        if (!username || !username.value.trim() || !password || !password.value) return
        var label = btn.textContent
        btn.textContent = kind === 'register' ? T('注册中…') : T('登录中…')
        btn.disabled = true
        var body = { username: username.value.trim(), password: password.value, link: link ? link.value : '' }
        if (kind === 'register') {
          var nick = form.querySelector('[name=nickname]')
          if (nick && nick.value.trim()) body.nickname = nick.value.trim()
          if (email && email.value.trim()) body.email = email.value.trim()
        }
        postJSON('/api/member/' + kind, body)
          .then(function () {
            if (tip) tip.textContent = kind === 'register' ? T('注册成功，正在进入…') : T('登录成功，正在进入…')
            setTimeout(function () {
              location.reload()
            }, 500)
          })
          .catch(function (err) {
            if (tip) tip.textContent = err.message || T('操作失败，请重试')
            btn.textContent = label
            btn.disabled = false
          })
      })
    })
  }

  // 会员中心卡（memberCardHtml）：昵称 30 天一次、密码无找回；提交走 /api/member/profile|password
  var memNickForm = document.querySelector('[data-member-nickname-form]')
  if (memNickForm) {
    memNickForm.addEventListener('submit', function (e) {
      e.preventDefault()
      var btn = memNickForm.querySelector('.mem-btn')
      var tip = memNickForm.querySelector('[data-member-tip]')
      var input = memNickForm.querySelector('[name=nickname]')
      if (!btn || btn.disabled) return
      if (!input || !input.value.trim()) {
        if (tip) tip.textContent = T('昵称不能为空')
        return
      }
      var label = btn.textContent
      btn.disabled = true
      btn.textContent = T('保存中…')
      postJSON('/api/member/profile', { nickname: input.value.trim() })
        .then(function () {
          if (tip) tip.textContent = T('昵称已更新，正在刷新…')
          setTimeout(function () {
            location.reload()
          }, 500)
        })
        .catch(function (err) {
          if (tip) tip.textContent = err.message || T('保存失败，请重试')
          btn.textContent = label
          btn.disabled = false
        })
    })
  }

  // 会员中心卡（memberCardHtml）：QQ 头像绑定（评论头像 C2）——绑过再存即幂等重试头像；
  // QQ 号正则与 utils.ts isValidQQ 同款镜像，改任一侧记得同步
  var memQQForm = document.querySelector('[data-member-qq-form]')
  if (memQQForm) {
    memQQForm.addEventListener('submit', function (e) {
      e.preventDefault()
      var btn = memQQForm.querySelector('.mem-btn')
      var tip = memQQForm.querySelector('[data-member-tip]')
      var input = memQQForm.querySelector('[name=qq]')
      if (!btn || btn.disabled) return
      var qq = input ? input.value.trim() : ''
      if (!/^[1-9][0-9]{4,10}$/.test(qq)) {
        if (tip) tip.textContent = T('QQ 号格式不对（5-11 位数字，不以 0 开头）')
        return
      }
      var label = btn.textContent
      btn.disabled = true
      btn.textContent = T('保存中…')
      postJSON('/api/member/profile', { qq: qq })
        .then(function (d) {
          if (d && d.avatarFailed) {
            // 头像抓取失败但 qq 已记上：提示重试（服务端容忍失败是设计口径）
            if (tip) tip.textContent = T('QQ 已绑定，但头像没抓到，稍后再点一次重试')
            btn.textContent = T('重试头像')
            btn.disabled = false
          } else {
            if (tip) tip.textContent = T('已保存，正在刷新…')
            setTimeout(function () {
              location.reload()
            }, 500)
          }
        })
        .catch(function (err) {
          if (tip) tip.textContent = err.message || T('保存失败，请重试')
          btn.textContent = label
          btn.disabled = false
        })
    })
  }

  var memPwdForm = document.querySelector('[data-member-password-form]')
  if (memPwdForm) {
    memPwdForm.addEventListener('submit', function (e) {
      e.preventDefault()
      var btn = memPwdForm.querySelector('.mem-btn')
      var tip = memPwdForm.querySelector('[data-member-tip]')
      var cur = memPwdForm.querySelector('[name=current]')
      var next = memPwdForm.querySelector('[name=next]')
      if (!btn || btn.disabled) return
      if (!cur || !cur.value || !next || !next.value) {
        if (tip) tip.textContent = T('请填写当前密码与新密码')
        return
      }
      if (next.value.length < 8) {
        if (tip) tip.textContent = T('新密码至少 8 位')
        return
      }
      var label = btn.textContent
      btn.disabled = true
      btn.textContent = T('提交中…')
      postJSON('/api/member/password', { currentPassword: cur.value, newPassword: next.value })
        .then(function () {
          if (tip) tip.textContent = T('密码已修改，其他设备已退出登录。请务必记好新密码')
          if (cur) cur.value = ''
          if (next) next.value = ''
          btn.textContent = label
          btn.disabled = false
        })
        .catch(function (err) {
          if (tip) tip.textContent = err.message || T('修改失败，请重试')
          btn.textContent = label
          btn.disabled = false
        })
    })
  }

  var memLogout = document.querySelector('[data-member-logout]')
  if (memLogout)
    memLogout.addEventListener('click', function () {
      if (memLogout.disabled) return
      var label = memLogout.textContent
      memLogout.disabled = true
      postJSON('/api/member/logout', {})
        .then(function () {
          location.reload()
        })
        .catch(function (err) {
          memLogout.disabled = false
          memLogout.textContent = err.message || T('退出失败，请重试')
          setTimeout(function () {
            memLogout.textContent = label
          }, 2000)
        })
    })

  /* ---------------- 访客统计打点（后台「统计」页，服务端见 src/stats.ts） ----------------
   * 只上报匿名访客 id / 路径 / 标题 / 来源域名，不碰 Cookie 不存 IP；
   * 页面带 <meta name="xw-stats" content="off">（后台关闭采集）时完全不发请求 */
  try {
    if (
      document.visibilityState === 'visible' &&
      !/bot|crawl|spider|slurp/i.test(navigator.userAgent) &&
      !document.querySelector('meta[name="xw-stats"][content="off"]')
    ) {
      var vid = storeGet('xw-vid')
      if (!vid) {
        vid = Date.now().toString(36) + Math.random().toString(36).slice(2, 10)
        // 隐私加固浏览器存不进去：storeSet 内部吞掉，本次用一次性 id，仅影响去重不影响上报
        storeSet('xw-vid', vid)
      }
      postJSON('/api/public/track', {
        p: (location.pathname + location.search).slice(0, 300),
        r: document.referrer,
        v: vid,
        t: document.title,
      }).catch(function () {})
    }
  } catch (err) {
    /* 统计永不影响页面 */
  }
})()
