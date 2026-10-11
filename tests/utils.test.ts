import { test } from 'node:test'
import assert from 'node:assert/strict'
import { cleanDisabledPlugins, cleanSlug, clampInt, dateSlug, extractWeiboTopics, fmtDate, fmtDateCN, fmtDateTime, isoDate, jsonItemLikePattern, likePattern, plainText, slugify } from '../src/utils.ts'

// ── SSR 时间统一北京时间（回归：0-8 点发布的内容曾显示成前一天）──
test('fmtDate 按 UTC+8 取墙上日期：UTC 16:30 = 北京次日 00:30', () => {
  const ts = Date.UTC(2026, 9, 4, 16, 30) // 北京 2026-10-05 00:30
  assert.equal(fmtDate(ts), '2026-10-05')
  assert.equal(fmtDateTime(ts), '2026-10-05 00:30')
  assert.equal(fmtDateCN(ts), '2026年10月5日')
})

test('fmtDate 正常日期与时区无关地稳定', () => {
  const ts = Date.UTC(2026, 4, 1, 4, 0) // 北京 12:00，任何口径都是同一天
  assert.equal(fmtDate(ts), '2026-05-01')
  assert.equal(fmtDateTime(ts), '2026-05-01 12:00')
})

test('fmtDate/fmtDateCN/fmtDateTime 空值返回空串', () => {
  assert.equal(fmtDate(null), '')
  assert.equal(fmtDateCN(undefined), '')
  assert.equal(fmtDateTime(0), '')
})

test('isoDate 输出北京时间 +08:00 的 ISO 8601（JSON-LD 机器日期）', () => {
  const ts = Date.UTC(2026, 9, 5, 0, 30) // 北京 08:30
  assert.equal(isoDate(ts), '2026-10-05T08:30:00+08:00')
  // 0-8 点口径回归：UTC 10-05 18:00 = 北京 10-06 02:00，不能错位到前一天
  const lateNight = Date.UTC(2026, 9, 5, 18, 0)
  assert.equal(isoDate(lateNight), '2026-10-06T02:00:00+08:00')
  assert.equal(isoDate(null), '')
  assert.equal(isoDate(0), '')
})

// ── plainText 实体解码顺序（回归：&amp;lt; 曾被二次解码成裸 <）──
test('plainText 不做二次实体解码', () => {
  assert.equal(plainText('<p>展示 &amp;lt;b&amp;gt; 字样</p>'), '展示 &lt;b&gt; 字样')
  assert.equal(plainText('&amp;amp;'), '&amp;')
})

test('plainText 正常解码与去标签', () => {
  assert.equal(plainText('<p>A &lt;script&gt; 好的</p>'), 'A <script> 好的')
  assert.equal(plainText('<script>alert(1)</script>正文'), '正文')
  assert.equal(plainText('a&nbsp;b'), 'a b')
})

// ── cleanSlug（回归：自定义 slug 曾未清洗，空格/特殊字符产生坏链）──
test('cleanSlug 清洗空白与非法字符', () => {
  assert.equal(cleanSlug('My Post!! v2.test'), 'My-Post-v2test')
  assert.equal(cleanSlug('中文 标题!'), '中文-标题')
  assert.equal(cleanSlug('  --a--b--  '), 'a-b')
  assert.equal(cleanSlug('   '), '')
  assert.equal(cleanSlug('hello-world_1'), 'hello-world_1')
})

// ── slugify / dateSlug（回归：中文标题曾回退 p-时间戳+随机串，链接无标准）──
test('slugify 纯 ASCII 标题转 kebab-case', () => {
  assert.equal(slugify('My First Post!'), 'my-first-post')
  assert.equal(slugify('  Hello   World  '), 'hello-world')
  assert.equal(slugify('A -- B?? C'), 'a-b-c')
})

test('dateSlug 用北京日期：UTC 深夜归次日，0-8 点口径不错位', () => {
  // 北京 2026-10-05 00:30（UTC 10-04 16:30）——按 UTC 取日期会错成 20261004
  assert.match(dateSlug(Date.UTC(2026, 9, 4, 16, 30)), /^20261005-[0-9a-z]{4}$/)
  // 北京 2026-10-08 01:00
  assert.match(dateSlug(Date.UTC(2026, 9, 7, 17, 0)), /^20261008-[0-9a-z]{4}$/)
})

test('slugify 中文标题走 dateSlug，两次生成不重样（随机位 + uniqueSlug 兜底防重复）', () => {
  const a = slugify('我的写作笔记')
  assert.match(a, /^\d{8}-[0-9a-z]{4}$/)
  assert.notEqual(slugify('我的写作笔记'), slugify('我的写作笔记'))
})

// ── 插件停用列表清洗（后台「插件」页启停写 settings.pluginsDisabled）──
test('cleanDisabledPlugins 去空白去重并保序', () => {
  assert.equal(cleanDisabledPlugins('a, b,,c ,a'), 'a,b,c')
  assert.equal(cleanDisabledPlugins(' hello-plugin , wechat-collect '), 'hello-plugin,wechat-collect')
  assert.equal(cleanDisabledPlugins(''), '')
  assert.equal(cleanDisabledPlugins(',,,'), '')
  assert.equal(cleanDisabledPlugins('A_1-b'), 'A_1-b')
})

test('cleanDisabledPlugins 非法字符与超长 ID 拒绝/截断', () => {
  // 含非法字符整体拒绝，由 API 层返回 400，避免静默丢弃造成「看似保存成功」
  assert.equal(cleanDisabledPlugins('a;rm -rf'), null)
  assert.equal(cleanDisabledPlugins('中文插件'), null)
  assert.equal(cleanDisabledPlugins('a,b;,'), null)
  // 单个 ID 超过 64 位截断，超量不设限（插件数量本身有限）
  assert.equal(cleanDisabledPlugins(`${'x'.repeat(70)}`), 'x'.repeat(64))
})

// ── LIKE 通配符转义（回归：% _ 未声明 ESCAPE 时搜索恒为空）──
test('jsonItemLikePattern 转义通配符并带 JSON 引号', () => {
  const p = jsonItemLikePattern('100%')
  assert.ok(p.startsWith('%') && p.endsWith('%'))
  assert.ok(p.includes('\\%'), '百分号必须被反斜杠转义')
  assert.ok(p.includes('"100'), '带 JSON 引号，防「猫」命中「波斯猫」')
  const u = jsonItemLikePattern('a_b')
  assert.ok(u.includes('\\_'))
})

// ── 其他基础工具（防手滑改坏）──
test('clampInt 边界与非数字回退', () => {
  assert.equal(clampInt('5', 1, 10, 3), 5)
  assert.equal(clampInt('99', 1, 10, 3), 10)
  assert.equal(clampInt('0', 1, 10, 3), 1)
  assert.equal(clampInt('abc', 1, 10, 3), 3)
})

test('extractWeiboTopics 防误判：ASCII 字母/数字紧贴的 # 不算话题开头', () => {
  // 「写C#的日常」「F#」「12#月」的 # 前是 ASCII 字母/数字，按设计不提取（防 C# 被当话题）
  assert.deepEqual(extractWeiboTopics('写 C# 的日常 #随笔#'), ['随笔'])
  assert.deepEqual(extractWeiboTopics('写C#的日常'), [])
  assert.deepEqual(extractWeiboTopics('F#很棒 #daily'), ['daily'])
  assert.deepEqual(extractWeiboTopics('12#月总结'), [])
  // 汉字后可直接跟话题（中文不打空格）：成对与单井号都成立
  assert.deepEqual(extractWeiboTopics('#生活#与#代码#'), ['生活', '代码'])
  assert.deepEqual(extractWeiboTopics('今天心情不错#打卡'), ['打卡'])
})

test('extractWeiboTopics 单井号主推写法：句读即停，句中后文不算话题名', () => {
  // 中文不打空格的句子：话题名到中文标点为止，不吞整句（旧版会把「日常，今天很开心」整段当话题名）
  assert.deepEqual(extractWeiboTopics('#日常，今天很开心'), ['日常'])
  assert.deepEqual(extractWeiboTopics('#日常。睡了'), ['日常'])
  assert.deepEqual(extractWeiboTopics('#打卡！下班了'), ['打卡'])
  assert.deepEqual(extractWeiboTopics('#开心~ #todo. 买牛奶'), ['开心', 'todo'])
  // 单井号 + 空白/结尾：与旧版一致
  assert.deepEqual(extractWeiboTopics('#日常 今天真好'), ['日常'])
  assert.deepEqual(extractWeiboTopics('#日常'), ['日常'])
  // Memos 式层级标签：`/` 不在停顿集，整个词算一个话题
  assert.deepEqual(extractWeiboTopics('#软件/apple/mac 收藏'), ['软件/apple/mac'])
  // 成对写法兼容旧内容
  assert.deepEqual(extractWeiboTopics('#晚餐日记#'), ['晚餐日记'])
})

// ── 回归（2026-10 安全复查）：ESCAPE '\' 声明下 \ 本身不转义会让搜索模式语义跑偏 ──
test('likePattern 转义 \\ % _ 三个字符', () => {
  assert.equal(likePattern('a\\b'), '%a\\\\b%')
  assert.equal(likePattern('100%'), '%100\\%%')
  assert.equal(likePattern('猫_dog'), '%猫\\_dog%')
  assert.equal(likePattern('普通词'), '%普通词%')
})
