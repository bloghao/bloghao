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
    '视频': 'Video',
    '最大 25MB，MP4 / WebM': 'Up to 25MB, MP4 / WebM',
    '图片 / 视频，一条微博最多 1 个视频': 'Photos / video — one video per note',
    '只支持 MP4 / WebM 视频': 'Only MP4 / WebM videos are supported',
    'HEVC 高效格式：iPhone / Mac 正常，部分 Windows 浏览器放不出来（想更稳就用剪辑 App 导出 MP4）':
      'HEVC video: fine on iPhone / Mac, but some Windows browsers cannot play it (export an MP4 from a video editor for the widest support)',
    'HEVC 高效格式：iPhone / Mac 正常，部分 Windows 浏览器放不出来（想更稳就用剪辑 App 导出 MP4）':
      'HEVC video: fine on iPhone / Mac, but some Windows browsers cannot play it (export an MP4 from a video editor for the widest support)',
    '网络错误，上传失败': 'Network error — upload failed',
    '置顶': 'Pin',
    '取消置顶': 'Unpin',
    '删除': 'Delete',
    '删除中…': 'Deleting…',
    '删除失败': 'Failed to delete',
    '删除这条评论（其下回复一并删除，不可恢复）': 'Delete this comment (its replies go too, and this cannot be undone)',
    '删除这条评论？其下的回复会一并删除，且不可恢复。': 'Delete this comment? Its replies go too, and this cannot be undone.',
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
    '请先完成人机验证': 'Please complete the verification first',
    '人机验证还没就绪，请稍候再试': 'Verification is still loading — please wait a moment and retry',
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
    '移除': 'Remove',
    '返回顶部': 'Back to top',
    '复制代码': 'Copy code',
    '已复制': 'Copied',
    '复制失败': 'Copy failed',
    '复制本节链接': 'Copy link to this section',
    '更多操作': 'More',
    '复制链接': 'Copy link',
    '已复制链接': 'Link copied',
    '复制链接失败': 'Failed to copy the link',
    '字号': 'Text size',
    '小': 'Small',
    '标准': 'Standard',
    '大': 'Large',
    '特大': 'Extra large',
    '保存图片': 'Save image',
    '已保存，若未开始下载请长按图片另存': 'Saved — if nothing downloaded, long-press the image to save it',
    '复制图片地址': 'Copy image address',
    '已复制图片地址': 'Image address copied',
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

  /* ---------------- 页面边缘缓存旁路（服务端 src/pagecache.ts：带 query 的请求不进缓存） ----------------
   * 游客发完评论要立刻看到自己的留言：整页刷新时带 _r 时间戳绕开边缘缓存拿到实时渲染，
   * 落地后马上把参数从地址栏清掉（不污染分享链接） */
  function reloadFresh() {
    location.href = location.pathname + (location.search ? location.search + '&' : '?') + '_r=' + Date.now() + location.hash
  }
  try {
    if (/[?&]_r=\d+/.test(location.search)) history.replaceState(null, '', location.pathname + location.hash)
  } catch (e) {
    /* replaceState 不可用就留着参数，无害 */
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
          '<button type="button" class="wb-composer-tile-del" data-i="' + i + '" title="' + T('移除') + '">×</button></span>'
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

  /* ---------------- 微博视频（B19）：一条微博最多 1 个视频，≤25MB ----------------
   * 体积与类型口径跟 src/store.ts 的 MAX_UPLOAD_BYTES / 上传白名单一致；少数安卓浏览器
   * file.type 为空，按扩展名兜底。上传走 XHR 是为了 upload.onprogress——25MB 不能是一段无声的等待。
   * 元数据与封面帧都是 best-effort：拿不到就退化成无封面卡，绝不阻塞发布。
   */
  var VIDEO_MAX_BYTES = 25 * 1024 * 1024
  // accept 用 video/*：iOS 的「照片图库」选择器按 accept 过滤，只列 video/mp4 会把 iPhone 拍的
  // .mov 视频整批筛掉（图库里一个视频都不显示，2026-10-13 站长手机实测）；格式把关改到上传前做
  var VIDEO_ACCEPT = 'video/*'
  var VIDEO_EXT_RE = /\.(mp4|webm|mov)$/i

  /** 选中的文件按视频处理（真正的格式判定在 prepareVideo：能归一化成 mp4 的才算） */
  function isVideoFile(f) {
    if (!f) return false
    return /^video\//i.test(f.type || '') || (!f.type && VIDEO_EXT_RE.test(f.name || ''))
  }

  /** ISO-BMFF 容器归一化：iPhone 拍的是 .mov（ftyp 主品牌 'qt  '），结构本就是 ISO-BMFF，
   *  但浏览器与「只收 mp4/webm」的上传端点都不认 QuickTime 容器。这里原地把 ftyp 里的
   *  'qt  ' 品牌改写成 'isom'（= 标准 mp4 品牌），H.264 / AAC 的 iPhone 视频改完即全平台可放。
   *  head 是文件头若干字节的 Uint8Array；改了返回 true，没找到 ftyp / 品牌不是 qt 返回 false。 */
  function patchFtypBrand(head) {
    var at = -1
    for (var i = 0; i + 8 <= head.length; i++) {
      if (head[i] === 0x66 && head[i + 1] === 0x74 && head[i + 2] === 0x79 && head[i + 3] === 0x70) {
        at = i // 'ftyp'
        break
      }
    }
    if (at < 4) return false
    var size = (head[at - 4] << 24) | (head[at - 3] << 16) | (head[at - 2] << 8) | head[at - 1]
    var end = size > 16 && size <= head.length ? at - 4 + size : head.length
    var patched = false
    for (var j = at + 4; j + 4 <= end; j += 4) {
      // 品牌位按 4 字节对齐：'qt  ' 与 'qt' 两种写法都认
      if (head[j] === 0x71 && head[j + 1] === 0x74 && (head[j + 2] === 0x20 || head[j + 3] === 0x20)) {
        head[j] = 0x69 // i
        head[j + 1] = 0x73 // s
        head[j + 2] = 0x6f // o
        head[j + 3] = 0x6d // m
        patched = true
      }
    }
    return patched
  }

  /** 粗略探测有没有 HEVC（'hvc1' / 'hev1' 样本描述）：moov 可能在文件头也可能在尾，
   *  前后各扫 1MB 就够（超过 25MB 的视频本来也传不上来）。找不到一律当没有，不打扰用户。 */
  function detectHevc(file) {
    var MAX = 1024 * 1024
    var parts = [file.slice(0, Math.min(MAX, file.size))]
    if (file.size > MAX) parts.push(file.slice(Math.max(0, file.size - MAX)))
    return Promise.all(
      parts.map(function (p) {
        return p.arrayBuffer()
      })
    ).then(function (bufs) {
      for (var i = 0; i < bufs.length; i++) {
        var b = new Uint8Array(bufs[i])
        for (var j = 0; j + 4 <= b.length; j++) {
          if (
            (b[j] === 0x68 && b[j + 1] === 0x76 && b[j + 2] === 0x63 && b[j + 3] === 0x31) ||
            (b[j] === 0x68 && b[j + 1] === 0x65 && b[j + 2] === 0x76 && b[j + 3] === 0x31)
          )
            return true
        }
      }
      return false
    })
  }

  /** 重声明视频类型（扩展名一起对齐）：给了 patchedHead 就用改写过的文件头重组（Blob 拼接零拷贝） */
  function retypeVideo(file, mime, ext, patchedHead) {
    var name = (file.name || 'video').replace(/\.[^.]+$/, '') + '.' + ext
    return patchedHead
      ? new File([patchedHead, file.slice(64)], name, { type: mime })
      : new File([file], name, { type: mime })
  }

  /** 上传前的视频整理：**只认文件头，不信任浏览器声明的 MIME**（与服务端「只认魔数」同口径）——
   *  - ISO-BMFF（有 ftyp）：品牌是 'qt  ' 的（iPhone 拍的 .mov）原地改写成 'isom'，其余品牌字节原样，
   *    统一按 mp4 声明上传（本来就是同族容器），H.264 / AAC 的 iPhone 视频改完即全平台可放；
   *  - WebM（EBML 魔数）：按 webm 声明；
   *  - 其它容器（avi / mkv / flv…）：回 error，前端提示换格式。
   *  只读文件头 64 字节，不把整段视频读进内存。
   *  2026-10-13 回归：此前把「品牌无需改写」当成「不认识的格式」直接拒——macOS 把 .mp4 报成
   *  video/quicktime（内容品牌 isom）时会误拒；现在只要有 ftyp 就照收。 */
  function prepareVideo(file) {
    return file
      .slice(0, 64)
      .arrayBuffer()
      .then(function (buf) {
        var head = new Uint8Array(buf)
        // WebM：EBML 魔数 1A 45 DF A3
        if (head[0] === 0x1a && head[1] === 0x45 && head[2] === 0xdf && head[3] === 0xa3)
          return { file: retypeVideo(file, 'video/webm', 'webm'), hevc: false }
        patchFtypBrand(head) // 有 'qt  ' 品牌就顺手改写，没有就保持字节原样
        var hasFtyp = false
        for (var i = 0; i + 4 <= head.length; i++) {
          if (head[i] === 0x66 && head[i + 1] === 0x74 && head[i + 2] === 0x79 && head[i + 3] === 0x70) {
            hasFtyp = true
            break
          }
        }
        if (!hasFtyp) return { error: true }
        return detectHevc(file).then(function (hevc) {
          return { file: retypeVideo(file, 'video/mp4', 'mp4', head), hevc: hevc }
        })
      })
  }

  function fmtSize(n) {
    if (!n) return ''
    if (n < 1024 * 1024) return Math.max(1, Math.round(n / 1024)) + 'KB'
    return (n / 1024 / 1024).toFixed(1) + 'MB'
  }

  function fmtDuration(sec) {
    var s = Math.round(sec || 0)
    if (!s) return ''
    var m = Math.floor(s / 60)
    var r = s % 60
    return m + ':' + (r < 10 ? '0' + r : r)
  }

  /** 上传视频（带百分比回调）：先做容器归一化（iPhone 的 .mov → mp4，见 prepareVideo），
   *  再走 raw 上传。失败抛 Error，文案与服务端 jsonError 同源；成功时带上 hevc 标记供调用方提示。 */
  function uploadVideo(file, onProgress) {
    return prepareVideo(file).then(function (prep) {
      if (prep.error) throw new Error(T('只支持 MP4 / WebM 视频'))
      return uploadVideoRaw(prep.file, onProgress).then(function (d) {
        d.hevc = prep.hevc
        return d
      })
    })
  }

  /** 真正发往 /admin/upload 的那一步（XHR 取进度） */
  function uploadVideoRaw(file, onProgress) {
    return new Promise(function (resolve, reject) {
      var xhr = new XMLHttpRequest()
      xhr.open('POST', '/api/admin/upload')
      // 不收 json：413 这类响应体是纯文本（「请求体过大」），按 json 读会变成 null，
      // 页面只显示笼统的「上传失败」——2026-10-13 那次 413 就是这么被藏住的
      xhr.upload.onprogress = function (e) {
        if (e.lengthComputable && onProgress) onProgress(Math.round((e.loaded / e.total) * 100))
      }
      xhr.onload = function () {
        var d = {}
        try {
          d = JSON.parse(xhr.responseText || '{}') || {}
        } catch (e) {
          d = {}
        }
        if (xhr.status >= 200 && xhr.status < 300 && d.url) return resolve(d)
        var serverMsg = d.error || (xhr.responseText || '').trim()
        reject(new Error(serverMsg ? serverMsg.slice(0, 80) : T('上传失败') + '（HTTP ' + xhr.status + '）'))
      }
      xhr.onerror = function () {
        reject(new Error(T('网络错误，上传失败')))
      }
      var fd = new FormData()
      fd.append('file', file)
      xhr.send(fd)
    })
  }

  /** 读视频元数据（宽高 + 时长）：只用于提示语与无封面时的占位比例，失败回调 null */
  function readVideoMeta(file, cb) {
    var url = ''
    var settled = false
    function finish(m) {
      if (settled) return
      settled = true
      try {
        URL.revokeObjectURL(url)
      } catch (e) {
        /* 老浏览器没有 revokeObjectURL 也不影响 */
      }
      cb(m)
    }
    try {
      url = URL.createObjectURL(file)
    } catch (e) {
      return cb(null)
    }
    var v = document.createElement('video')
    v.preload = 'metadata'
    v.muted = true
    v.addEventListener('loadedmetadata', function () {
      finish({ w: v.videoWidth || 0, h: v.videoHeight || 0, duration: v.duration || 0 })
    })
    v.addEventListener('error', function () {
      finish(null)
    })
    setTimeout(function () {
      finish(null)
    }, 6000)
    v.src = url
  }

  /** 抽第一帧当封面帧（最长边压到 1280 省体积）：失败 / 超时回调 null，卡片退化成无封面 */
  function grabVideoPoster(file, cb) {
    var url = ''
    var settled = false
    function finish(shot) {
      if (settled) return
      settled = true
      try {
        URL.revokeObjectURL(url)
      } catch (e) {
        /* 同上 */
      }
      cb(shot)
    }
    try {
      url = URL.createObjectURL(file)
    } catch (e) {
      return cb(null)
    }
    var v = document.createElement('video')
    v.preload = 'auto'
    v.muted = true
    v.setAttribute('playsinline', '')
    v.setAttribute('webkit-playsinline', '')
    v.addEventListener('loadeddata', function () {
      try {
        var sw = v.videoWidth || 0
        var sh = v.videoHeight || 0
        if (!sw || !sh) return finish(null)
        var scale = Math.min(1, 1280 / Math.max(sw, sh))
        var cv = document.createElement('canvas')
        cv.width = Math.max(1, Math.round(sw * scale))
        cv.height = Math.max(1, Math.round(sh * scale))
        cv.getContext('2d').drawImage(v, 0, 0, cv.width, cv.height)
        cv.toBlob(function (blob) {
          finish(blob ? { blob: blob, w: sw, h: sh } : null)
        }, 'image/jpeg', 0.82)
      } catch (e) {
        finish(null)
      }
    })
    v.addEventListener('error', function () {
      finish(null)
    })
    setTimeout(function () {
      finish(null)
    }, 10000)
    v.src = url
  }

  /** 视频预览块（发布器与卡片编辑器共用）：复用图片格样式，进度看按钮文字 */
  function videoTileHtml(v, meta) {
    var poster = v.poster ? ' poster="' + esc(v.poster) + '"' : ''
    return (
      '<span class="wb-composer-tile wb-composer-tile--video" title="' + esc(meta || '') + '">' +
      '<video src="' + esc(v.url) + '"' + poster + ' muted playsinline preload="metadata"></video>' +
      '<button type="button" class="wb-composer-tile-del" data-video-del title="' + T('移除') + '">×</button>' +
      '</span>'
    )
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

  /* ---------------- 顶部导航「分类话题」折叠菜单：点外部 / Esc 收起 ----------------
   * 打开时给导航挂 snav-open：横滑形态（overflow-x:auto）下 WebKit 把滚动容器内 fixed 子元素
   * 按容器定位（iOS 实测菜单被剪掉），主题 CSS 据此放开裁剪、菜单转导航锚定的 absolute */
  document.addEventListener('toggle', function (e) {
    var d = e.target
    if (!d || !d.classList || !d.classList.contains('snav-dd')) return
    var nav = d.closest ? d.closest('nav') : null
    if (nav) nav.classList[d.open ? 'add' : 'remove']('snav-open')
  }, true)
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
              reloadFresh()
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
              reloadFresh()
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

  /* ---------------- 管理员在前台删评论（文章 / 留言板 / 微博评论三处共用） ----------------
   * 按钮由服务端（commentsHtml）或这里（微博评论客户端渲染）只对登录管理员渲染，访客 HTML 里不存在；
   * 写操作复用后台 /api/admin/comments/:id（会话鉴权，连带删掉其下楼中楼，不可恢复——评论没有回收站）。
   */
  function cmtResetReplyIfDeleted(form, id) {
    if (!form) return
    var hidden = form.querySelector('[name=parentId]')
    var target = (hidden && hidden.value) || form.dataset.replyId || ''
    if (String(target) !== String(id)) return
    // 复用它自己的「取消」键还原回复态（各表单的状态在各自闭包里，这里不伸手进去）
    var cancel = form.querySelector('.cmt-reply-cancel, .wb-cmt-reply-cancel')
    if (cancel) cancel.click()
  }

  function deleteComment(btn, id) {
    var item = btn.closest ? btn.closest('.cmt-item, .wb-cmt-item') : null
    var form = (btn.closest('.cmt-section') || btn.closest('.wb-cmt') || document).querySelector('.cmt-form, .wb-cmt-form')
    var tipEl = form && form.querySelector('.cmt-tip, .wb-cmt-tip')
    var tipDefault = tipEl ? tipEl.textContent : ''
    btn.disabled = true
    fetch('/api/admin/comments/' + encodeURIComponent(id), { method: 'DELETE' })
      .then(function (r) {
        return r.json().then(function (d) {
          if (!r.ok) throw new Error((d && d.error) || T('删除失败'))
          return d
        })
      })
      .then(function () {
        // 删掉的条目连同其子回复一起摘掉，再按 DOM 实际数量修计数（比按 1 减更稳）
        if (item) item.remove()
        cmtResetReplyIfDeleted(form, id)
        var card = btn.closest('.wb-card')
        if (card) {
          var wbCount = card.querySelector('.wb-cmt-count')
          if (wbCount) {
            var panel = card.querySelector('.wb-cmt')
            var left = panel ? panel.querySelectorAll('.wb-cmt-item').length : 0
            wbCount.textContent = String(left)
          }
        }
        var section = btn.closest('.cmt-section')
        if (section) {
          var c = section.querySelector('.cmt-count')
          if (c) c.textContent = String(section.querySelectorAll('.cmt-item').length)
        }
      })
      .catch(function (err) {
        if (tipEl) {
          tipEl.textContent = (err && err.message) || T('删除失败')
          setTimeout(function () { tipEl.textContent = tipDefault }, 4000)
        }
        btn.disabled = false
      })
  }

  document.addEventListener('click', function (e) {
    var btn = e.target && e.target.closest ? e.target.closest('.cmt-del-btn, .wb-cmt-del-btn') : null
    if (!btn) return
    e.preventDefault()
    var id = btn.getAttribute('data-cmt-del')
    if (!id) return
    if (!confirm(T('删除这条评论？其下的回复会一并删除，且不可恢复。'))) return
    deleteComment(btn, id)
  })

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
        // IP 属地：接口在 showCommentRegion 开启时才带 ip_region（已是服务端格式化好的标签），与楼号同款小灰字
        (c.ip_region ? '<span class="wb-cmt-region" style="font-size:11px;opacity:0.45">' + esc(c.ip_region) + '</span>' : '') +
        (floor ? '<span class="wb-cmt-floor" style="font-size:11px;opacity:0.45;font-variant-numeric:tabular-nums">#' + floor + '</span>' : '') +
        (isAdmin
          ? '<button type="button" class="wb-cmt-reply-btn" data-reply="' + c.id + '" data-name="' + esc(c.nickname) + '">' + T('回复') + '</button>' +
            '<button type="button" class="wb-cmt-del-btn" data-cmt-del="' + c.id + '" title="' + T('删除这条评论（其下回复一并删除，不可恢复）') + '">' + T('删除') + '</button>'
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

  // 给发布器 / 卡片编辑 / 评论表单的按钮行插入表情按钮（插入动作依赖 JS，按钮也由 JS 动态加）。
  // anchor 可选：评论 foot 是「提示语 + 发送」的 space-between 双孩子布局，把按钮插到发送前并给
  // margin-left:auto（吸走自由空间）→ 提示语居左、表情+发送右侧成组；别改回 firstChild——会把提示语挤到中间
  function wxqAttachButton(foot, ta, anchor) {
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
    if (anchor) {
      btn.style.marginLeft = 'auto'
      foot.insertBefore(btn, anchor)
    } else {
      foot.insertBefore(btn, foot.firstChild)
    }
  }

  // 评论表单表情按钮（文章评论 / 留言板 / 微博评论——/weibo 页与首页微博流共用同一套 SSR）：
  // 评论表单全是 SSR 静态 DOM，IIFE 顶层挂一次即可；按钮复用 wb-composer-add 的主题样式
  document.querySelectorAll('.cmt-form-foot').forEach(function (foot) {
    var form = foot.closest('form')
    wxqAttachButton(foot, form && form.querySelector('.cmt-textarea'), foot.querySelector('.cmt-submit'))
  })
  document.querySelectorAll('.wb-cmt-foot').forEach(function (foot) {
    var form = foot.closest('form')
    wxqAttachButton(foot, form && form.querySelector('.wb-cmt-textarea'), foot.querySelector('.wb-cmt-submit'))
  })

  /* 微博视频开播后收起 ▶ 角标（B19）：play 事件不冒泡，只能在 document 上 capture 代理 */
  document.addEventListener(
    'play',
    function (e) {
      var v = e.target
      if (!v || v.tagName !== 'VIDEO') return
      var box = v.closest ? v.closest('.wb-video') : null
      if (box) box.classList.add('is-playing')
    },
    true
  )

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
    var cpVideoBox = composerForm.querySelector('.wb-composer-video')
    var cpButtons = composerForm.querySelectorAll('.wb-composer-add, .wb-composer-draft, .wb-composer-publish')
    var cpImages = []
    var cpVideo = null // 单视频（B19）：{ url, poster, w, h } | null
    var cpVideoMeta = '' // 视频预览的小字（体积 · 时长），只用于提示语与 title
    var cpUploading = 0 // 在途上传计数（图 + 视频）：发布前必须归零，否则发布会把没传完的媒体静默丢掉
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

    /** 视频预览（最多一个）：媒体入口统一走「加图」按钮（图片 / 视频同一个选择器，站长 2026-10-13 拍板），
     *  这里只管预览块；单视频约束在 cpAddVideo 落点提示 */
    function cpRenderVideo() {
      if (cpVideoBox) {
        cpVideoBox.hidden = !cpVideo
        cpVideoBox.innerHTML = cpVideo ? videoTileHtml(cpVideo, cpVideoMeta) : ''
      }
    }

    /** 加视频：单视频约束 + 类型/体积前置校验（省一次 25MB 白传）+ 进度 + 封面帧（best-effort） */
    function cpAddVideo(file) {
      if (cpVideo) return cpMsg(EN ? 'One video per note — remove the current one first' : '一条微博只能带一个视频，先移除当前视频')
      if (!isVideoFile(file)) return cpMsg(T('只支持 MP4 / WebM 视频'))
      if (file.size > VIDEO_MAX_BYTES)
        return cpMsg((EN ? 'Video must be under 25MB — this one is ' : '视频不能超过 25MB，当前 ') + fmtSize(file.size))
      var label = cpAdd ? cpAdd.textContent : ''
      cpUploading++
      if (cpAdd) {
        cpAdd.disabled = true
        cpAdd.textContent = (EN ? 'Uploading ' : '上传视频 ') + '0%'
      }
      // 元数据先到就先显示（时长/尺寸），赶在上传完成之前给回馈
      readVideoMeta(file, function (m) {
        if (!m) return
        cpVideoMeta = fmtSize(file.size) + (fmtDuration(m.duration) ? ' · ' + fmtDuration(m.duration) : '')
        if (cpVideo && !cpVideo.w) {
          cpVideo.w = m.w
          cpVideo.h = m.h
        }
        cpRenderVideo()
        cpMsg((EN ? 'Video added · ' : '已加视频 · ') + cpVideoMeta)
      })
      uploadVideo(file, function (pct) {
        if (cpAdd) cpAdd.textContent = (EN ? 'Uploading ' : '上传视频 ') + pct + '%'
      })
        .then(function (up) {
          cpVideo = { url: up.url, poster: '', w: 0, h: 0 }
          if (!cpVideoMeta) cpVideoMeta = fmtSize(file.size)
          cpRenderVideo()
          // HEVC（iPhone 默认的高效格式）只在部分浏览器能放：如实提示，让站长自己决定要不要换格式
          if (up.hevc) cpMsg(T('HEVC 高效格式：iPhone / Mac 正常，部分 Windows 浏览器放不出来（想更稳就用剪辑 App 导出 MP4）'))
          // 封面帧慢一步补传：拿不到就保持无封面（卡片照常播放），不拖慢发布
          grabVideoPoster(file, function (shot) {
            if (!shot || !cpVideo || cpVideo.url !== up.url) return
            uploadImage(new File([shot.blob], 'poster.jpg', { type: 'image/jpeg' }))
              .then(function (poster) {
                if (!cpVideo || cpVideo.url !== up.url) return
                cpVideo.poster = poster
                if (!cpVideo.w) {
                  cpVideo.w = shot.w
                  cpVideo.h = shot.h
                }
                cpRenderVideo()
              })
              .catch(function () {
                /* 封面帧失败不算错误：卡片退化成无封面，视频照常可播 */
              })
          })
        })
        .catch(function (err) {
          cpMsg((err && err.message) || T('上传失败'))
        })
        .finally(function () {
          cpUploading--
          if (cpAdd) cpAdd.textContent = label
          cpRenderVideo()
        })
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
      // 拖拽 / 粘贴不看 accept，视频文件会直接落到这里：先分流到视频通道（同后台 addMediaFiles 口径）
      var vids = all.filter(isVideoFile)
      if (vids.length) cpAddVideo(vids[0])
      var imgs = all.filter(function (f) { return /^image\//.test(f.type) })
      if (!imgs.length) {
        if (all.length && !vids.length) cpMsg(T('只支持 JPG / PNG / WebP / GIF 图片'))
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
        // 图片与视频共用一个入口：多选时视频只取第一个（一条微博最多 1 个视频），其余按图片走。
        // accept 里写 video/*（不是枚举 mp4/webm）——iOS 图库按 accept 过滤，列窄了 iPhone 拍的 .mov 一个都不显示
        pickFiles({ accept: 'image/jpeg,image/png,image/webp,image/gif,' + VIDEO_ACCEPT, multiple: true }, function (files) {
          cpAddFiles(files)
        })
      })
    }

    if (cpVideoBox) {
      cpVideoBox.addEventListener('click', function (e) {
        var del = e.target && e.target.closest ? e.target.closest('[data-video-del]') : null
        if (!del) return
        cpVideo = null
        cpVideoMeta = ''
        cpRenderVideo()
        cpMsg(EN ? 'Video removed' : '已移除视频')
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
      if (cpUploading > 0) return cpMsg(EN ? 'Media is still uploading — wait a moment' : '还有图片/视频在上传中，等一下再发')
      var content = cpText ? cpText.value.trim() : ''
      if (!content && !cpImages.length && !cpVideo) {
        cpMsg(T('写点什么，或者配张图 / 加段视频吧'))
        return
      }
      cpButtons.forEach(function (b) { b.disabled = true })
      postJSON('/api/admin/weibo', { content: content, images: cpImages, video: cpVideo, status: status })
        .then(function () {
          if (status === 'published') {
            reloadFresh()
            return
          }
          if (cpText) cpText.value = ''
          cpImages = []
          cpVideo = null
          cpVideoMeta = ''
          cpRender()
          cpRenderVideo()
          cpMsg(EN ? 'Draft saved — continue editing in the admin Notes page' : '草稿已保存，到后台「微博」页可继续编辑')
        })
        .catch(function (err) {
          cpMsg((err && err.message) || (EN ? 'Failed to publish — please try again' : '发布失败，请重试'))
        })
        .finally(function () {
          cpButtons.forEach(function (b) { b.disabled = false })
          // 视频按钮的禁用态由「是否已有视频」决定，统一交回 cpRenderVideo 还原
          cpRenderVideo()
        })
    }
    var cpPub = composerForm.querySelector('.wb-composer-publish')
    var cpDraft = composerForm.querySelector('.wb-composer-draft')
    if (cpPub) cpPub.addEventListener('click', function () { cpPublish('published') })
    if (cpDraft) cpDraft.addEventListener('click', function () { cpPublish('draft') })
    cpRender()
    cpRenderVideo()
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

    // 与 src/outlink.ts 的 TRUSTED_OUT_DOMAINS 手工同步：首项是项目自有域 bloghao.com，其余主流大站；
    // 白名单外域包 /go 中间页（外链提醒 + 免责声明），同源与白名单直出
    var TRUSTED_OUT = ['bloghao.com', 'apple.com', 'icloud.com', 'google.com', 'youtube.com', 'android.com', 'microsoft.com', 'live.com', 'office.com', 'bing.com', 'github.com', 'gitlab.com', 'stackoverflow.com', 'npmjs.com', 'wikipedia.org', 'wikimedia.org', 'mozilla.org', 'cloudflare.com', 'amazon.com', 'x.com', 'twitter.com', 'twimg.com', 'facebook.com', 'instagram.com', 'threads.net', 'linkedin.com', 'reddit.com', 'pinterest.com', 'tiktok.com', 'telegram.org', 't.me', 'discord.com', 'medium.com', 'substack.com', 'openai.com', 'anthropic.com', 'huggingface.co', 'weibo.com', 'weibo.cn', 'sina.com.cn', 'baidu.com', 'zhihu.com', 'bilibili.com', 'b23.tv', 'qq.com', 'tencent.com', '163.com', '126.com', 'netease.com', 'jd.com', 'taobao.com', 'tmall.com', 'alipay.com', 'aliyun.com', 'alibaba.com', 'douyin.com', 'kuaishou.com', 'xiaohongshu.com', 'sohu.com', 'csdn.net', 'juejin.cn', 'cnblogs.com', 'segmentfault.com', 'v2ex.com', 'gitee.com', 'oschina.net', 'jianshu.com', 'sspai.com', 'ithome.com', '36kr.com', 'mi.com', 'xiaomi.com', 'huawei.com']

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

    // 视频块与后端 render.ts weiboVideoHtml 同口径（单行输出、占位比例、封面帧、无封面时的 ▶ 角标）；
    // 编辑保存后就地重渲染用它，改动必须与服务端同步（tests/weibo-admin.test.ts 有逐字节镜像守卫）
    function wbVideoHtmlJs(v) {
      if (!v || !v.url) return ''
      var portrait = v.w > 0 && v.h > 0 && v.h > v.w
      var ratio = v.w > 0 && v.h > 0 ? ' style="aspect-ratio:' + v.w + '/' + v.h + '"' : ''
      var poster = v.poster ? ' poster="' + esc(v.poster) + '"' : ''
      var badge = v.poster ? '' : '<span class="wb-video-badge" aria-hidden="true"></span>'
      var mime = /\.webm(\?|#|$)/i.test(v.url) ? 'video/webm' : 'video/mp4'
      var src = esc(v.url)
      return (
        '<div class="wb-video' + (portrait ? ' is-portrait' : '') + (v.poster ? '' : ' is-plain') + '">' +
        '<video controls playsinline preload="metadata"' + poster + ratio + '>' +
        '<source src="' + src + '" type="' + mime + '">' +
        '<a class="wb-video-fallback" href="' + src + '" target="_blank" rel="noopener noreferrer">' + T('视频') + '</a>' +
        '</video>' + badge + '</div>'
      )
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
      var videoEl = card.querySelector('.wb-video')
      var foot = card.querySelector('.wb-foot')
      var admin = card.querySelector('.wb-admin')
      // 用内联 display 而非 hidden 属性：主题 CSS 里 .wb-imgs / .wb-video 常设 display，会盖掉 [hidden]
      if (admin) admin.style.display = 'none'
      if (textEl) textEl.style.display = 'none'
      if (imgsEl) imgsEl.style.display = 'none'
      if (videoEl) videoEl.style.display = 'none'

      var form = document.createElement('form')
      form.className = 'wb-edit'
      form.setAttribute('data-wb-edit', '')
      form.innerHTML =
        '<textarea class="wb-composer-textarea" name="content" maxlength="5000" rows="5" placeholder="' + T('说点什么…') + '"></textarea>' +
        '<div class="wb-composer-tiles" hidden></div>' +
        '<div class="wb-composer-video" hidden></div>' +
        '<div class="wb-composer-foot">' +
        '<button type="button" class="wb-composer-add" title="' + T('图片 / 视频，一条微博最多 1 个视频') + '">' + (EN ? addLabelEn(0, WB_MAX_IMAGES) : '加图（0/' + WB_MAX_IMAGES + '）') + '</button>' +
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
      // 收紧选择器：表情按钮（wxqAttachButton 插的，带 data-wxq-btn）也带 .wb-composer-add 类，
      // 裸 querySelector 会取到它——「加图」标签会被刷到表情按钮上、点它还会弹出选图器（HEAD 上就有的老 bug）
      var addBtn = form.querySelector('.wb-composer-add:not([data-wxq-btn])')
      var countEl = form.querySelector('.wb-composer-count')
      var tipEl = form.querySelector('.wb-composer-tip')
      var saveBtn = form.querySelector('[data-wb-edit-save]')
      var cancelBtn = form.querySelector('[data-wb-edit-cancel]')
      var videoBox = form.querySelector('.wb-composer-video')
      var images = []
      var video = null // 单视频（B19）：{ url, poster, w, h } | null
      var videoMeta = ''
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

      /** 视频预览（最多一个）：媒体入口统一走「加图」按钮（与顶部发布器同口径） */
      function renderVideo() {
        videoBox.hidden = !video
        videoBox.innerHTML = video ? videoTileHtml(video, videoMeta) : ''
      }

      /** 加视频：类型 / 体积前置校验 + 进度 + 封面帧（best-effort）；与顶部发布器同一套流程 */
      function addVideoFile(file) {
        if (video) return tip(EN ? 'One video per note — remove the current one first' : '一条微博只能带一个视频，先移除当前视频')
        if (!isVideoFile(file)) return tip(T('只支持 MP4 / WebM 视频'))
        if (file.size > VIDEO_MAX_BYTES)
          return tip((EN ? 'Video must be under 25MB — this one is ' : '视频不能超过 25MB，当前 ') + fmtSize(file.size))
        var label = addBtn.textContent
        uploading++
        addBtn.disabled = true
        addBtn.textContent = (EN ? 'Uploading ' : '上传视频 ') + '0%'
        readVideoMeta(file, function (m) {
          if (!m) return
          videoMeta = fmtSize(file.size) + (fmtDuration(m.duration) ? ' · ' + fmtDuration(m.duration) : '')
          if (video && !video.w) {
            video.w = m.w
            video.h = m.h
          }
          renderVideo()
          tip((EN ? 'Video added · ' : '已加视频 · ') + videoMeta)
        })
        uploadVideo(file, function (pct) {
          addBtn.textContent = (EN ? 'Uploading ' : '上传视频 ') + pct + '%'
        })
          .then(function (up) {
            video = { url: up.url, poster: '', w: 0, h: 0 }
            if (!videoMeta) videoMeta = fmtSize(file.size)
            renderVideo()
            if (up.hevc) tip(T('HEVC 高效格式：iPhone / Mac 正常，部分 Windows 浏览器放不出来（想更稳就用剪辑 App 导出 MP4）'))
            grabVideoPoster(file, function (shot) {
              if (!shot || !video || video.url !== up.url) return
              uploadImage(new File([shot.blob], 'poster.jpg', { type: 'image/jpeg' }))
                .then(function (poster) {
                  if (!video || video.url !== up.url) return
                  video.poster = poster
                  if (!video.w) {
                    video.w = shot.w
                    video.h = shot.h
                  }
                  renderVideo()
                })
                .catch(function () {
                  /* 封面帧失败不算错误：卡片退化成无封面，视频照常可播 */
                })
            })
          })
          .catch(function (err) {
            tip((err && err.message) || T('上传失败'))
          })
          .finally(function () {
            uploading--
            addBtn.textContent = label
            renderVideo()
          })
      }

      ta.addEventListener('input', renderTiles)
      tiles.addEventListener('click', function (e) {
        var del = e.target && e.target.closest ? e.target.closest('.wb-composer-tile-del') : null
        if (!del) return
        images.splice(Number(del.getAttribute('data-i')), 1)
        renderTiles()
      })
      videoBox.addEventListener('click', function (e) {
        var del = e.target && e.target.closest ? e.target.closest('[data-video-del]') : null
        if (!del) return
        video = null
        videoMeta = ''
        renderVideo()
        tip(EN ? 'Video removed' : '已移除视频')
      })

      function addFiles(fileList) {
        var all = [].slice.call(fileList || [])
        // 拖拽 / 粘贴不看 accept：视频走视频通道（一条微博一个视频），其余按图片处理
        var vids = all.filter(isVideoFile)
        if (vids.length) addVideoFile(vids[0])
        var imgs = all.filter(function (f) { return /^image\//.test(f.type) })
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
        // 图片与视频共用一个入口（与顶部发布器同口径）；addFiles 内部把视频分流到视频通道
        pickFiles({ accept: 'image/jpeg,image/png,image/webp,image/gif,' + VIDEO_ACCEPT, multiple: true }, function (files) {
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
        if (videoEl) videoEl.style.display = ''
        if (admin) admin.style.display = ''
      }
      cancelBtn.addEventListener('click', leaveEdit)

      saveBtn.addEventListener('click', function () {
        if (uploading > 0) return tip(EN ? 'Media is still uploading — wait a moment' : '还有图片/视频在上传中，等一下再保存')
        var content = ta.value.trim()
        if (!content && !images.length && !video) return tip(T('写点什么，或者配张图 / 加段视频吧'))
        saveBtn.textContent = T('保存中…')
        saveBtn.disabled = true
        cancelBtn.disabled = true
        // 全量更新：images 必须回传，video 显式回传（null = 清除），不然配图 / 视频会被清空
        fetch('/api/admin/weibo/' + encodeURIComponent(id), {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ content: content, images: images, video: video, status: 'published' }),
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
              if (video) {
                var vHtml = wbVideoHtmlJs(video)
                if (videoEl) {
                  videoEl.outerHTML = vHtml
                } else {
                  var holder = document.createElement('div')
                  holder.innerHTML = vHtml
                  card.insertBefore(holder.firstChild, imgsEl || form)
                }
                videoEl = card.querySelector('.wb-video')
              } else if (videoEl) {
                videoEl.remove()
                videoEl = null
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
      getJSON('/api/admin/weibo/' + encodeURIComponent(id))
        .then(function (d) {
          ta.value = (d.weibo && d.weibo.content) || ''
          images = ((d.weibo && d.weibo.imageList) || []).slice(0, WB_MAX_IMAGES)
          video = (d.weibo && d.weibo.videoView) || null
          videoMeta = ''
          ta.disabled = false
          saveBtn.disabled = false
          renderTiles()
          renderVideo()
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
        postJSON('/api/admin/weibo/' + encodeURIComponent(id) + '/pin', { pinned: pinned })
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
        fetch('/api/admin/weibo/' + encodeURIComponent(id), { method: 'DELETE' })
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

  /* ---------------- 微信同款读者交互件：底部操作面板 + 轻提示 + 正文缩放 + 右上角「…」 ----------------
   * 全部客户端注入（归宿①，不给七主题加样式负担）；样式一次性注入 <style>（CSP style-src 允许内联）。
   * 三类消费者：正文页右上角「…」聚合菜单、灯箱长按菜单、正文缩放（C11 阅读偏好）。
   * 面板配色中性白/深（微信 action sheet 同款），按主题底色亮度自动选深浅，不引主题变量名。 */
  var XW_UI_CSS = [
    '.xw-toast{position:fixed;left:50%;top:50%;transform:translate(-50%,-50%);z-index:100002;',
    'max-width:74vw;padding:10px 18px;border-radius:8px;background:rgba(0,0,0,.78);color:#fff;',
    'font-size:14px;line-height:1.5;text-align:center;opacity:0;pointer-events:none;transition:opacity .2s ease;',
    'font-family:-apple-system,BlinkMacSystemFont,"PingFang SC","Microsoft YaHei",sans-serif}',
    '.xw-toast.is-on{opacity:1}',
    '.xw-sheet-ov{position:fixed;inset:0;z-index:100000;background:rgba(0,0,0,.45);opacity:0;transition:opacity .2s ease}',
    '.xw-sheet-ov.is-on{opacity:1}',
    '.xw-sheet{position:fixed;left:0;right:0;bottom:0;z-index:100001;padding:0 10px calc(10px + env(safe-area-inset-bottom));',
    'transform:translateY(102%);transition:transform .26s cubic-bezier(.22,.61,.36,1);',
    'font-family:-apple-system,BlinkMacSystemFont,"PingFang SC","Microsoft YaHei",sans-serif}',
    '.xw-sheet.is-open{transform:translateY(0)}',
    '.xw-sheet-card{background:#fff;border-radius:14px;overflow:hidden}',
    '.xw-sheet-cancel{display:flex;align-items:center;justify-content:center;margin-top:8px;padding:15px;',
    'background:#fff;border-radius:14px;font-size:16px;color:#1a1a1a;cursor:pointer;-webkit-tap-highlight-color:transparent}',
    '.xw-sheet-row{display:flex;align-items:center;gap:12px;padding:15px 18px;font-size:16px;color:#1a1a1a;',
    'cursor:pointer;outline:none;-webkit-tap-highlight-color:transparent}',
    '.xw-sheet-row+.xw-sheet-row{border-top:1px solid #ededed}',
    '.xw-sheet-row:active,.xw-sheet-cancel:active{background:#f5f5f5}',
    '.xw-sheet-ic{display:inline-flex;flex:0 0 22px;color:#576b95}',
    '.xw-fs-seg{display:flex;gap:8px;margin-left:auto}',
    '.xw-fs-btn{min-width:48px;padding:6px 10px;margin:0;border:none;border-radius:8px;background:#f2f2f2;color:#333;',
    'font-size:14px;line-height:1.4;cursor:pointer;-webkit-tap-highlight-color:transparent}',
    '.xw-fs-btn.is-on{background:#07c160;color:#fff}',
    '.xw-sheet[data-dark="1"] .xw-sheet-card,.xw-sheet[data-dark="1"] .xw-sheet-cancel{background:#1f1f1f}',
    '.xw-sheet[data-dark="1"] .xw-sheet-row,.xw-sheet[data-dark="1"] .xw-sheet-cancel{color:#e6e6e6}',
    '.xw-sheet[data-dark="1"] .xw-sheet-row+.xw-sheet-row{border-top-color:#2c2c2c}',
    '.xw-sheet[data-dark="1"] .xw-sheet-row:active,.xw-sheet[data-dark="1"] .xw-sheet-cancel:active{background:#2a2a2a}',
    '.xw-sheet[data-dark="1"] .xw-sheet-ic{color:#7d90b8}',
    '.xw-sheet[data-dark="1"] .xw-fs-btn{background:#2c2c2c;color:#ddd}',
    '.xw-sheet[data-dark="1"] .xw-fs-btn.is-on{background:#07c160;color:#fff}',
    '.xw-more-fab{position:fixed;top:calc(10px + env(safe-area-inset-top));right:14px;z-index:70;display:none;',
    'width:38px;height:38px;align-items:center;justify-content:center;margin:0;padding:0;border:none;border-radius:50%;',
    'background:rgba(40,38,34,.72);color:#fff;-webkit-backdrop-filter:blur(4px);backdrop-filter:blur(4px);',
    'cursor:pointer;-webkit-tap-highlight-color:transparent;box-shadow:0 2px 10px rgba(0,0,0,.14)}',
    '.xw-more-fab.is-on{display:flex}',
    '@media (prefers-reduced-motion:reduce){.xw-sheet,.xw-sheet-ov,.xw-toast{transition:none}}',
  ].join('')

  // 面板行图标（currentColor 随面板配色）
  var XW_ICONS = {
    share:
      '<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12 15V4m0 0L8 8m4-4 4 4"/><path d="M7.5 11H7a3 3 0 0 0-3 3v3a3 3 0 0 0 3 3h10a3 3 0 0 0 3-3v-3a3 3 0 0 0-3-3h-.5"/></svg>',
    link:
      '<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M10 13a5 5 0 0 0 7 0l3-3a5 5 0 0 0-7-7l-1 1"/><path d="M14 11a5 5 0 0 0-7 0l-3 3a5 5 0 0 0 7 7l1-1"/></svg>',
    font: '<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M3 19 8 6l5 13"/><path d="M4.8 14.5h6.4"/><path d="M15.5 19h5"/></svg>',
    download:
      '<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12 4v11m0 0 4-4m-4 4-4-4"/><path d="M5 19h14"/></svg>',
  }

  ;(function () {
    if (document.getElementById('xw-ui-css')) return
    var st = document.createElement('style')
    st.id = 'xw-ui-css'
    st.textContent = XW_UI_CSS
    document.head.appendChild(st)
  })()

  /* 轻提示：居中黑底圆角，微信 Toast 同款，自动消失（同一时刻只留一个） */
  var xwToastTimer = null
  function xwToast(msg) {
    var el = document.getElementById('xw-toast')
    if (!el) {
      el = document.createElement('div')
      el.id = 'xw-toast'
      el.className = 'xw-toast'
      el.setAttribute('role', 'status')
      document.body.appendChild(el)
    }
    el.textContent = msg
    el.classList.add('is-on')
    clearTimeout(xwToastTimer)
    xwToastTimer = setTimeout(function () {
      el.classList.remove('is-on')
    }, 1700)
  }

  /* 复制文本：剪贴板 API 优先，不可用回落 execCommand（与代码块复制同兜底语义） */
  function xwLegacyCopy(text) {
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
  function xwCopyText(text, ok, fail) {
    var done = function () {
      if (ok) ok()
    }
    var bad = function () {
      if (fail) fail()
    }
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(text).then(done, function () {
        if (xwLegacyCopy(text)) done()
        else bad()
      })
    } else if (xwLegacyCopy(text)) {
      done()
    } else {
      bad()
    }
  }

  /* 底部操作面板（微信 action sheet 同款）：xwOpenSheet(行元素数组, 是否深色) */
  var xwSheetOnKey = null
  function xwCloseSheet() {
    var ov = document.getElementById('xw-sheet-ov')
    var panel = document.getElementById('xw-sheet')
    if (!ov && !panel) return
    if (xwSheetOnKey) {
      document.removeEventListener('keydown', xwSheetOnKey, true)
      xwSheetOnKey = null
    }
    if (ov) ov.classList.remove('is-on')
    if (panel) panel.classList.remove('is-open')
    // 等过渡结束再摘 DOM；用闭包变量判在场，防期间又开了一个面板
    setTimeout(function () {
      if (ov && ov.parentNode) ov.parentNode.removeChild(ov)
      if (panel && panel.parentNode) panel.parentNode.removeChild(panel)
    }, 280)
  }
  function xwOpenSheet(rows, dark) {
    xwCloseSheet()
    var ov = document.createElement('div')
    ov.id = 'xw-sheet-ov'
    ov.className = 'xw-sheet-ov'
    ov.addEventListener('click', xwCloseSheet)
    var panel = document.createElement('div')
    panel.id = 'xw-sheet'
    panel.className = 'xw-sheet'
    panel.setAttribute('role', 'dialog')
    panel.setAttribute('aria-modal', 'true')
    if (dark) panel.setAttribute('data-dark', '1')
    var card = document.createElement('div')
    card.className = 'xw-sheet-card'
    for (var i = 0; i < rows.length; i++) card.appendChild(rows[i])
    var cancel = document.createElement('div')
    cancel.className = 'xw-sheet-cancel'
    cancel.setAttribute('role', 'button')
    cancel.setAttribute('tabindex', '0')
    cancel.textContent = T('取消')
    cancel.addEventListener('click', xwCloseSheet)
    panel.appendChild(card)
    panel.appendChild(cancel)
    // 不锁 body 滚动：灯箱打开时它已锁，这里再锁会与灯箱互相抵消（关面板时误解锁）
    document.body.appendChild(ov)
    document.body.appendChild(panel)
    xwSheetOnKey = function (e) {
      if (e.key === 'Escape') {
        xwCloseSheet()
        e.preventDefault()
      }
    }
    document.addEventListener('keydown', xwSheetOnKey, true)
    var show = function () {
      ov.classList.add('is-on')
      panel.classList.add('is-open')
    }
    if (window.requestAnimationFrame) requestAnimationFrame(show)
    else setTimeout(show, 16)
  }
  /* 面板行：icon + label（+ 可选的尾部节点，如字号分段控件）；onPick 为 null 则只展示不可点 */
  function xwSheetRow(icon, label, onPick, trailing) {
    var r = document.createElement('div')
    r.className = 'xw-sheet-row'
    if (onPick) {
      r.setAttribute('role', 'button')
      r.setAttribute('tabindex', '0')
    }
    r.innerHTML = '<span class="xw-sheet-ic">' + icon + '</span><span class="xw-sheet-lb">' + esc(label) + '</span>'
    if (trailing) r.appendChild(trailing)
    if (onPick) {
      r.addEventListener('click', onPick)
      r.addEventListener('keydown', function (e) {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault()
          onPick()
        }
      })
    }
    return r
  }

  /* ---------------- 正文缩放（C11）+ 正文页右上角「…」聚合菜单（微信同款） ----------------
   * 字号只作用于正文容器（.rich）；缩放走 zoom——一次覆盖标题/正文/代码/表格，无需七主题逐套字号，
   * 不支持的浏览器降级为只缩放正文字号。记忆走 storeGet/storeSet（禁裸 localStorage）。
   * 「…」只在窄屏 + 导航滚出视野后浮现（顶部右下角不压导航），点开底部面板：分享 / 复制链接 / 字号。 */
  ;(function () {
    var FS_KEY = 'xw:reader:fs:v1'
    var FS_LABELS = ['小', '标准', '大', '特大']
    var FS_MULT = [0.9, 1, 1.15, 1.3]
    var FS_DEFAULT = 1 // 标准

    function fsZoomOk() {
      return !!(window.CSS && window.CSS.supports && window.CSS.supports('zoom', '1.15'))
    }
    function fsApply(i) {
      var mult = FS_MULT[i]
      var nodes = document.querySelectorAll('.rich')
      for (var k = 0; k < nodes.length; k++) {
        var n = nodes[k]
        if (fsZoomOk()) {
          n.style.zoom = mult === 1 ? '' : String(mult)
        } else {
          // 降级：只缩放正文容器字号（首遍读基线，避免二次放大叠加）
          if (n.__xwBaseFs == null) n.__xwBaseFs = parseFloat(window.getComputedStyle(n).fontSize) || 17
          n.style.fontSize = (n.__xwBaseFs * mult).toFixed(2) + 'px'
        }
      }
    }
    function fsGet() {
      var v = parseInt(storeGet(FS_KEY), 10)
      return v >= 0 && v < FS_MULT.length ? v : FS_DEFAULT
    }
    function fsSet(i) {
      storeSet(FS_KEY, String(i))
      fsApply(i)
    }

    if (!document.querySelector('.rich')) return // 列表 / 微博页无正文，不启用
    fsApply(fsGet())

    // 主题底色亮度 → 面板深浅（各主题变量名不同，用计算色判定，不引变量）
    function cssLum(c) {
      var m = /rgba?\(([^)]+)\)/.exec(c || '')
      if (!m) return null
      var p = m[1].split(',')
      if (p.length < 3) return null
      if (p.length > 3 && parseFloat(p[3]) === 0) return null
      var r = parseFloat(p[0])
      var g = parseFloat(p[1])
      var b = parseFloat(p[2])
      if (isNaN(r) || isNaN(g) || isNaN(b)) return null
      return (r * 299 + g * 587 + b * 114) / 1000
    }
    function themeDark() {
      var v = cssLum(window.getComputedStyle(document.body).backgroundColor)
      if (v == null) v = cssLum(window.getComputedStyle(document.documentElement).backgroundColor)
      return v != null && v < 128
    }

    function fsRow() {
      var seg = document.createElement('div')
      seg.className = 'xw-fs-seg'
      var cur = fsGet()
      var btns = []
      for (var i = 0; i < FS_LABELS.length; i++) {
        ;(function (i) {
          var b = document.createElement('button')
          b.type = 'button'
          b.className = 'xw-fs-btn' + (i === cur ? ' is-on' : '')
          b.textContent = T(FS_LABELS[i])
          b.addEventListener('click', function () {
            fsSet(i)
            for (var k = 0; k < btns.length; k++) {
              if (k === i) btns[k].classList.add('is-on')
              else btns[k].classList.remove('is-on')
            }
          })
          seg.appendChild(b)
          btns.push(b)
        })(i)
      }
      return xwSheetRow(XW_ICONS.font, T('字号'), null, seg)
    }

    function copyLink() {
      xwCopyText(
        location.href,
        function () {
          xwToast(T('已复制链接'))
        },
        function () {
          xwToast(T('复制链接失败'))
        }
      )
    }
    function doShare() {
      var sb = document.querySelector('.share-btn')
      if (sb) {
        sb.click() // 复用文章分享面板（复制链接 / 系统分享 / 卡片图 + 二维码）
        return
      }
      if (navigator.share) {
        try {
          var pr = navigator.share({ title: document.title, url: location.href })
          if (pr && pr.catch) pr.catch(function () {})
          return
        } catch (e) {}
      }
      copyLink()
    }

    function openMore() {
      xwOpenSheet(
        [
          xwSheetRow(XW_ICONS.share, T('分享'), function () {
            xwCloseSheet()
            doShare()
          }),
          xwSheetRow(XW_ICONS.link, T('复制链接'), function () {
            xwCloseSheet()
            copyLink()
          }),
          fsRow(),
        ],
        themeDark()
      )
    }

    var mq = window.matchMedia ? window.matchMedia('(max-width: 900px)') : null
    var fab = document.createElement('button')
    fab.type = 'button'
    fab.id = 'xw-more'
    fab.className = 'xw-more-fab'
    fab.setAttribute('aria-label', T('更多操作'))
    fab.title = T('更多操作')
    fab.innerHTML =
      '<svg width="18" height="18" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><circle cx="5" cy="12" r="1.9"/><circle cx="12" cy="12" r="1.9"/><circle cx="19" cy="12" r="1.9"/></svg>'
    fab.addEventListener('click', openMore)
    document.body.appendChild(fab)

    var nav = document.querySelector('[data-xw-nav-sticky]') || document.querySelector('nav')
    var shown = false
    var recheck = null
    function navHidden() {
      if (!nav) return true
      // 吸顶导航收起时带 .xw-nav-hide（且收起有过渡，rect 在过渡中仍是旧值，故同时看类名）
      if (nav.classList && nav.classList.contains('xw-nav-hide')) return true
      return nav.getBoundingClientRect().bottom <= 8
    }
    function update() {
      var on = false
      if (!mq || mq.matches) {
        var y = window.pageYOffset || document.documentElement.scrollTop || 0
        if (y > 120) on = navHidden()
      }
      if (on === shown) return
      shown = on
      if (on) fab.classList.add('is-on')
      else fab.classList.remove('is-on')
    }
    function onScroll() {
      update()
      // 导航收起有过渡，过渡结束后复核一次（否则只在滚动瞬间测到旧 rect，FAB 永远不浮现）
      clearTimeout(recheck)
      recheck = setTimeout(update, 280)
    }
    window.addEventListener('scroll', onScroll, { passive: true })
    window.addEventListener('resize', update)
    update()
  })()

  /* ---------------- 图片灯箱：正文图 + 微博配图，点击全屏查看 ----------------
   * 手势：单指/滚轮缩放（双指捏合）、拖动平移、双击放大复原、左右滑动切换同组图片、
   * 未放大时下拉关闭；长按弹「保存图片 / 复制图片地址」（微信图片查看器同款）。
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
    var dragY = 0 // 未放大时下拉关闭的位移
    var pressTimer = null // 长按计时
    var pressAt = null

    function apply() {
      imgEl.style.transform = 'translate(' + tx + 'px,' + ty + 'px) scale(' + scale + ')'
    }
    function reset() {
      scale = 1
      tx = 0
      ty = 0
      dragY = 0
      apply()
      if (lb) lb.style.background = 'rgba(0,0,0,.92)'
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
      if (pressTimer) {
        clearTimeout(pressTimer)
        pressTimer = null
      }
      pressAt = null
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
      imgEl.setAttribute('style', 'max-width:92vw;max-height:88vh;transition:transform .18s ease;will-change:transform;user-select:none;-webkit-user-drag:none;-webkit-touch-callout:none;')
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
        // 未放大时：纵向拖是下拉关闭（跟手 + 背景渐透），横向拖给切图跟手反馈
        if (startPos) {
          var tdx = e.clientX - startPos.x
          var tdy = e.clientY - startPos.y
          if (Math.abs(tdy) > Math.abs(tdx)) {
            dragY = tdy
            imgEl.style.transform = 'translateY(' + tdy + 'px)'
            lb.style.background = 'rgba(0,0,0,' + Math.max(0.3, 0.92 - Math.abs(tdy) / 520).toFixed(3) + ')'
          } else if (group.length > 1 && Math.abs(tdx) > 0) {
            imgEl.style.transform = 'translateX(' + tdx / 3 + 'px)'
          }
        }
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
          // 下拉关闭（微信图片查看器同款）：够远且纵向为主，抬手即关
          if (dt < 700 && dy > 100 && Math.abs(dy) > Math.abs(dx)) {
            startPos = null
            close()
            return
          }
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

      // 长按（在图上按住 550ms 不动）：弹「保存图片 / 复制图片地址」（微信图片查看器同款长按菜单）
      function pressCancel() {
        if (pressTimer) {
          clearTimeout(pressTimer)
          pressTimer = null
        }
        pressAt = null
      }
      lb.addEventListener('pointerdown', function (e) {
        if (pointers.size !== 1 || e.target !== imgEl) return
        pressAt = { x: e.clientX, y: e.clientY }
        if (pressTimer) clearTimeout(pressTimer)
        pressTimer = setTimeout(function () {
          pressTimer = null
          if (!lb || pointers.size !== 1 || scale > 1) return
          var url = group[idx]
          if (!url) return
          xwOpenSheet(
            [
              xwSheetRow(XW_ICONS.download, T('保存图片'), function () {
                xwCloseSheet()
                var a = document.createElement('a')
                a.href = url
                a.download = ''
                a.rel = 'noopener'
                document.body.appendChild(a)
                a.click()
                document.body.removeChild(a)
                xwToast(T('已保存，若未开始下载请长按图片另存'))
              }),
              xwSheetRow(XW_ICONS.link, T('复制图片地址'), function () {
                xwCloseSheet()
                xwCopyText(url, function () {
                  xwToast(T('已复制图片地址'))
                })
              }),
            ],
            true
          )
        }, 550)
      })
      lb.addEventListener('pointermove', function (e) {
        if (!pressAt) return
        if (Math.abs(e.clientX - pressAt.x) > 10 || Math.abs(e.clientY - pressAt.y) > 10) pressCancel()
      })
      lb.addEventListener('pointerup', pressCancel)
      lb.addEventListener('pointercancel', pressCancel)

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
    /* 注册人机验证（Turnstile，A2 根治）：sitekey 挂 <html data-turnstile>（服务端仅 /member
     * 下发），未配置则整个分支旁路、注册行为与历史完全一致。组件用显式渲染、注册表单首次
     * 可见时才挂（隐藏容器里 Turnstile 渲染不出）；令牌一次性，注册失败后 reset 换新再提交；
     * 脚本加载失败不重试到成功不给出路——无令牌的提交会被服务端拒绝（fail closed） */
    var turnstileSiteKey = document.documentElement.getAttribute('data-turnstile') || ''
    var turnstileReady = false
    var turnstileLoading = false
    var turnstileWidgetId = null
    var turnstileToken = function () {
      return turnstileReady && window.turnstile && window.turnstile.getResponse && turnstileWidgetId !== null
        ? window.turnstile.getResponse(turnstileWidgetId)
        : ''
    }
    var turnstileEnsure = function () {
      if (!turnstileSiteKey || turnstileReady || turnstileLoading) return
      turnstileLoading = true
      window.__xwTurnstileCb = function () {
        turnstileLoading = false
        var form = memAuth.querySelector('[data-member-form="register"]')
        if (!form || !window.turnstile || !window.turnstile.render) return
        var box = document.createElement('div')
        box.className = 'mem-turnstile'
        form.insertBefore(box, form.querySelector('.mem-btn'))
        turnstileWidgetId = window.turnstile.render(box, { sitekey: turnstileSiteKey })
        turnstileReady = true
      }
      var sc = document.createElement('script')
      sc.src = 'https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit&onload=__xwTurnstileCb'
      sc.async = true
      sc.onerror = function () { turnstileLoading = false }
      document.head.appendChild(sc)
    }
    var turnstileReset = function () {
      if (turnstileReady && window.turnstile && window.turnstile.reset && turnstileWidgetId !== null) {
        window.turnstile.reset(turnstileWidgetId)
      }
    }
    if (memForms.length > 1) {
      var memShow = function (name) {
        memForms.forEach(function (f) {
          f.hidden = f.getAttribute('data-member-form') !== name
        })
        if (name === 'register') turnstileEnsure()
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
          // Turnstile 令牌（配置了 sitekey 才校验）：未就绪先在本侧拦下，省一次注定失败的请求
          if (turnstileSiteKey) {
            var tok = turnstileToken()
            if (!tok) {
              if (tip) tip.textContent = T(turnstileReady ? '请先完成人机验证' : '人机验证还没就绪，请稍候再试')
              btn.textContent = label
              btn.disabled = false
              return
            }
            body.turnstileToken = tok
          }
        }
        postJSON('/api/member/' + kind, body)
          .then(function () {
            if (tip) tip.textContent = kind === 'register' ? T('注册成功，正在进入…') : T('登录成功，正在进入…')
            setTimeout(function () {
              reloadFresh()
            }, 500)
          })
          .catch(function (err) {
            if (tip) tip.textContent = err.message || T('操作失败，请重试')
            btn.textContent = label
            btn.disabled = false
            if (kind === 'register') turnstileReset()
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
            reloadFresh()
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
              reloadFresh()
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
          reloadFresh()
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
  // 预渲染 / 预取（Speculation Rules，B24）中先不报：页面真被打开时才计入访客，
  // 否则 hover 一次就给一个没打开过的页面记一笔访客。老浏览器没有 prerendering 属性，
  // 走原路径（可见即上报）。
  var trackSent = false
  function sendTrack() {
    if (trackSent) return
    if (document.prerendering) {
      document.addEventListener('prerenderingchange', sendTrack)
      return
    }
    if (document.visibilityState !== 'visible') return
    if (/bot|crawl|spider|slurp/i.test(navigator.userAgent)) return
    if (document.querySelector('meta[name="xw-stats"][content="off"]')) return
    trackSent = true
    try {
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
    } catch (err) {
      /* 统计永不影响页面 */
    }
  }
  sendTrack()
})()
