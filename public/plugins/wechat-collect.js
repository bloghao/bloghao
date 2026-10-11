/**
 * 公众号采集插件
 * 编辑器工具栏新增「采集公众号文章」按钮：粘贴 mp.weixin.qq.com 的文章链接，
 * 服务端抓取正文、把配图转存进图床并生成草稿（保留原发布时间），
 * 然后自动跳转到该草稿——核对、修改后点「发布」即可。
 *
 * 服务端：src/collect.ts（POST /api/admin/collect/wechat）
 * 开发文档见 docs/PLUGINS.md
 */
window.BlogHao &&
  window.BlogHao.registerPlugin({
    name: 'wechat-collect',
    title: '采集公众号文章',
    icon:
      '<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round">' +
      '<path d="M9.5 4.3C5.5 4.3 2.2 6.9 2.2 10.1c0 1.8 1 3.4 2.7 4.5L4.3 17l2.8-1.4c.8.2 1.6.3 2.4.3 4 0 7.3-2.6 7.3-5.8S13.5 4.3 9.5 4.3Z"/>' +
      '<path d="M16.2 10.7c-2.9 0-5.2 1.9-5.2 4.3 0 1.5.9 2.8 2.3 3.6l-.5 2.1 2.3-1.2c.4.1.7.1 1.1.1 2.9 0 5.2-1.9 5.2-4.3s-2.3-4.6-5.2-4.6Z"/>' +
      '<circle cx="7.1" cy="9.2" r="0.9" fill="currentColor" stroke="none"/>' +
      '<circle cx="11.9" cy="9.2" r="0.9" fill="currentColor" stroke="none"/>' +
      '<circle cx="14.7" cy="14.3" r="0.7" fill="currentColor" stroke="none"/>' +
      '<circle cx="17.9" cy="14.3" r="0.7" fill="currentColor" stroke="none"/>' +
      '</svg>',
    onClick: function (ctx) {
      try {
        openCollectDialog(ctx)
      } catch (e) {
        // 控制台报错可能被环境吞掉，把错误落到 DOM 上便于排查
        document.body.setAttribute('data-wc-error', String((e && e.stack) || e))
      }
    },
  })

function openCollectDialog(ctx) {
  // 编辑器里已有未保存内容时先提醒，避免跳转丢稿
  const hasContent = String(ctx.getHTML() || '')
    .replace(/<[^>]+>/g, '')
    .trim()
  if (hasContent && !window.confirm('当前编辑器里已有内容，采集会跳转到新建的草稿，未保存的内容会丢失。继续吗？')) {
    return
  }

  const mask = document.createElement('div')
  mask.className = 'modal-mask'
  mask.innerHTML =
    '<div class="modal" role="dialog">' +
    '<div class="modal-head"><span>采集公众号文章</span><button class="modal-close" data-close>×</button></div>' +
    '<div class="modal-body">' +
    '<div class="auth-field"><label>文章链接</label>' +
    '<input class="input" id="wc-url" placeholder="https://mp.weixin.qq.com/s/…" autocapitalize="off" autocorrect="off" spellcheck="false"></div>' +
    '<div style="font-size:12px;color:var(--sub);margin-top:10px;line-height:1.8;">' +
    '支持图文与贴图（图片消息），正文与配图会自动转存并生成草稿（保留原文发布时间），公众号内嵌视频暂不支持。<br>' +
    '采集完成后请在编辑器里核对，确认无误再发布。</div>' +
    '<div id="wc-status" style="display:none;margin-top:12px;font-size:13px;line-height:1.7;"></div>' +
    '</div>' +
    '<div class="modal-foot"><button class="btn" data-close>取消</button>' +
    '<button class="btn btn-primary" id="wc-go">开始采集</button></div>' +
    '</div>'
  document.body.appendChild(mask)

    const close = () => mask.remove()
    mask.addEventListener('click', (e) => e.target === mask && close())
    mask.querySelectorAll('[data-close]').forEach((b) => b.addEventListener('click', close))

    const input = mask.querySelector('#wc-url')
    const go = mask.querySelector('#wc-go')
    const status = mask.querySelector('#wc-status')

    function showStatus(text, isErr) {
      status.textContent = text
      status.style.display = 'block'
      status.style.color = isErr ? '#c0392b' : 'var(--sub)'
    }

    async function collect() {
      if (go.disabled) return // 采集中：Enter 键不走按钮 disabled，需自行拦防双发产生重复草稿
      const url = input.value.trim()
      if (!url) {
        input.focus()
        return showStatus('请先粘贴文章链接', true)
      }
      go.disabled = true
      showStatus('正在抓取文章并转存图片，约需十几秒…', false)
      try {
        const res = await fetch('/api/admin/collect/wechat', {
          method: 'POST',
          credentials: 'same-origin',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ url }),
          // 多图文章服务端要逐张转存，放宽到 2 分钟；旧浏览器没有 AbortSignal.timeout 就不设超时
          ...(typeof AbortSignal !== 'undefined' && typeof AbortSignal.timeout === 'function'
            ? { signal: AbortSignal.timeout(120000) }
            : {}),
        })
        const d = await res.json().catch(() => ({}))
        if (!res.ok || !d.ok || !d.post || !d.post.id) {
          go.disabled = false
          return showStatus(d.error || '采集失败，请稍后再试', true)
        }
        close()
        ctx.notify('采集完成，已生成草稿 ✅')
        location.hash = '#/editor/' + d.post.id
      } catch (e) {
        go.disabled = false
        showStatus(e && e.name === 'TimeoutError' ? '采集超时，请重试或稍后再试' : '网络错误，采集失败', true)
      }
    }

    go.addEventListener('click', collect)
    mask.addEventListener('keydown', (e) => {
      // 中文输入法组词回车不提交（e.isComposing 判定，全站约定）
      if (e.key !== 'Enter' || e.isComposing || e.keyCode === 229) return
      collect()
    })
    input.focus()
}
