import { test } from 'node:test'
import assert from 'node:assert/strict'
import { classifyBrowser, classifyDevice, cleanPath, cleanRef, cleanTitle, cleanVid } from '../src/stats.ts'

// ── 设备识别：先判 tablet 再判 mobile（Android 平板 UA 含 Android 但不含 Mobile）──
test('classifyDevice 区分手机/平板/电脑', () => {
  assert.equal(classifyDevice('Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 Mobile/15E148 Safari/604.1'), 'mobile')
  assert.equal(classifyDevice('Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120 Mobile Safari/537.36'), 'mobile')
  assert.equal(classifyDevice('Mozilla/5.0 (iPad; CPU OS 17_0 like Mac OS X) AppleWebKit/605.1.15 Safari/604.1'), 'tablet')
  assert.equal(classifyDevice('Mozilla/5.0 (Linux; Android 13; SM-X710) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120 Safari/537.36'), 'tablet')
  assert.equal(classifyDevice('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120 Safari/537.36'), 'desktop')
  assert.equal(classifyDevice('Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Safari/605.1.15'), 'desktop')
  assert.equal(classifyDevice(''), 'desktop')
})

// ── 浏览器识别：微信 UA 内嵌整串 Chrome、Edge 也是 Chromium，判定顺序不能换 ──
test('classifyBrowser 微信优先于 Chrome', () => {
  const wechat =
    'Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120 Mobile Safari/537.36 MicroMessenger/8.0.49'
  assert.equal(classifyBrowser(wechat), 'wechat')
  const wechatIos =
    'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 Mobile/15E148 MicroMessenger/8.0.49'
  assert.equal(classifyBrowser(wechatIos), 'wechat')
})

test('classifyBrowser Edge/Firefox/Chrome/Safari 与兜底', () => {
  assert.equal(classifyBrowser('Mozilla/5.0 (Windows NT 10.0) AppleWebKit/537.36 Chrome/120 Safari/537.36 Edg/120.0'), 'edge')
  assert.equal(classifyBrowser('Mozilla/5.0 (Windows NT 10.0; rv:120.0) Gecko/20100101 Firefox/120.0'), 'firefox')
  assert.equal(classifyBrowser('Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) CriOS/120 Mobile/15E148 Safari/604.1'), 'chrome')
  assert.equal(classifyBrowser('Mozilla/5.0 (Windows NT 10.0) AppleWebKit/537.36 Chrome/120 Safari/537.36'), 'chrome')
  assert.equal(classifyBrowser('Mozilla/5.0 (Macintosh) AppleWebKit/605.1.15 Version/17.0 Safari/605.1.15'), 'safari')
  assert.equal(classifyBrowser('curl/8.4.0'), 'other')
  assert.equal(classifyBrowser(''), 'other')
})

// ── 来源域名：先剥 \t\r\n 再解析（URL 解析器会忽略这些字符，同 sanitize.safeUrl 的规矩）──
test('cleanRef 只留 http(s) 域名，剥控制字符', () => {
  assert.equal(cleanRef('https://www.google.com/search?q=x'), 'www.google.com')
  assert.equal(cleanRef('https://weixin.qq.com/cgi-bin/abc'), 'weixin.qq.com')
  assert.equal(cleanRef('jav\tascript:alert(1)'), '')
  assert.equal(cleanRef('https://evil.example\n.com/'), 'evil.example.com')
  assert.equal(cleanRef('javascript:alert(1)'), '')
  assert.equal(cleanRef('ftp://files.example.com/x'), '')
  assert.equal(cleanRef('/post/hello'), '')
  assert.equal(cleanRef('not a url'), '')
  assert.equal(cleanRef(''), '')
  assert.equal(cleanRef(null), '')
  assert.equal(cleanRef('https://' + 'a'.repeat(120) + '.com/'), 'a'.repeat(100))
})

// ── 上报路径：控制字符剥除、必须 / 开头、截 300 ──
test('cleanPath 清洗非法路径', () => {
  assert.equal(cleanPath('/post/hello?utm=x'), '/post/hello?utm=x')
  assert.equal(cleanPath('/weibo?page=2&topic=日常'), '/weibo?page=2&topic=日常')
  assert.equal(cleanPath('/'), '/') // 裸首页合法：访客打点不许丢首页
  assert.equal(cleanPath('\n/post/x'), '/post/x')
  assert.equal(cleanPath('https://evil.com/x'), '')
  assert.equal(cleanPath('post/x'), '')
  assert.equal(cleanPath(''), '')
  assert.equal(cleanPath(undefined), '')
  assert.equal(cleanPath('/' + 'a'.repeat(400)), '/' + 'a'.repeat(299))
})

// ── 匿名访客 id：只放行 [A-Za-z0-9_-]，截 64 ──
test('cleanVid 限定字符集', () => {
  assert.equal(cleanVid('abc123_-XYZ'), 'abc123_-XYZ')
  assert.equal(cleanVid('abc; drop table x'), 'abcdroptablex')
  assert.equal(cleanVid('a'.repeat(100)), 'a'.repeat(64))
  assert.equal(cleanVid(''), '')
  assert.equal(cleanVid(null), '')
})

test('cleanTitle 剥控制字符并截断', () => {
  assert.equal(cleanTitle('我的文章 - 博客号'), '我的文章 - 博客号')
  assert.equal(cleanTitle('标题\x00<script>'), '标题<script>')
  assert.equal(cleanTitle('好'.repeat(300)), '好'.repeat(200))
  assert.equal(cleanTitle(null), '')
})

// ── 回归（2026-10 安全复查）：协议相对 URL 是跨站链接，访客可借打点把它塞进后台统计页 ──
test('cleanPath 拒绝协议相对 URL（// 开头不进统计）', () => {
  assert.equal(cleanPath('//evil.com/x'), '')
  assert.equal(cleanPath('///evil'), '')
  assert.equal(cleanPath('/正常/path'), '/正常/path')
})
