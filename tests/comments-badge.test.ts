import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { commentsHtml } from '../src/render.ts'

// 会员评论徽标（契约 DEVPLAN-2026-10-07 附录 A）：评论列表查询 LEFT JOIN members 带出
// member_name / member_tier，作者徽标优先，游客无徽标；微博评论列表的徽标在 site.js 同口径渲染

const row = (over: Partial<Parameters<typeof commentsHtml>[0]['comments'][number]> = {}) => ({
  id: 1,
  post_id: 1,
  weibo_id: 0,
  parent_id: 0,
  is_admin: 0,
  nickname: '小张',
  email: '',
  website: '',
  content: '好文',
  status: 'approved' as const,
  ip: '',
  created_at: 1_700_000_000_000,
  ...over,
})

test('commentsHtml：会员评论带「会员」徽标，作者优先，游客无徽标', () => {
  const base = { slug: 'hello', allowComments: true, count: 2 }
  const html = commentsHtml({
    ...base,
    comments: [
      row({ id: 1, member_name: '小张', member_tier: 'coffee' }),
      row({ id: 2, is_admin: 1, nickname: '作者', content: '谢谢' }),
    ],
  })
  assert.ok(html.includes('cmt-badge">会员</span>'), 'member_tier 非空应带会员徽标')
  assert.ok(html.includes('cmt-badge">楼主</span>'), '作者评论在文章语境带楼主徽标')
  const gb = commentsHtml({
    ...base,
    guestbook: true,
    comments: [row({ id: 2, is_admin: 1, nickname: '作者', content: '谢谢' })],
  })
  assert.ok(gb.includes('cmt-badge">作者</span>'), '留言板语境沿用作者徽标')

  const guest = commentsHtml({ ...base, comments: [row({ nickname: '游客', content: '顶' })], count: 1 })
  assert.ok(!guest.includes('cmt-badge'), '游客评论无徽标')

  // 作者身份不依赖 is_admin 单打独斗：member 徽标只在非作者时渲染（三元已保证，这里防回归）
  const adminMember = commentsHtml({
    ...base,
    comments: [row({ is_admin: 1, member_name: '作者本人', member_tier: 'top' })],
    count: 1,
  })
  assert.ok(!adminMember.includes('cmt-badge">会员</span>'), 'is_admin 与 member 同存时只出作者徽标')
})

// 管理员在前台直接管理评论（2026-10-14 站长提：能发能回，就该能删）
// 按钮只对登录管理员渲染（访客 HTML 里不存在），写操作复用后台 /api/admin/comments/:id（会话鉴权）
test('commentsHtml：登录管理员时每条评论带「回复 + 删除」两键，访客一则没有', () => {
  const base = { slug: 'hello', allowComments: true, count: 2 }
  const comments = [row({ id: 7 }), row({ id: 8, parent_id: 7, nickname: '回复者', content: '楼中楼' })]

  const anon = commentsHtml({ ...base, comments })
  assert.ok(!anon.includes('data-cmt-del'), '访客 HTML 不得出现删除键')
  assert.ok(!anon.includes('data-reply'), '访客 HTML 不得出现回复键')

  const admin = commentsHtml({ ...base, comments, isAdmin: true })
  assert.match(admin, /data-cmt-del="7"/)
  assert.match(admin, /data-cmt-del="8"/, '楼中楼也要能单独删')
  assert.match(admin, /class="cmt-del-btn"/)
  assert.match(admin, /data-reply="7"/, '回复键照旧保留')
  // 删除是危险动作：title 里要写清「连带回复、不可恢复」
  assert.ok(admin.includes('其下回复一并删除，不可恢复'), '删除键需要明确后果的 title')
})

// 客户端接线守卫：site.js 要认得出两个前缀的删除键并复用后台端点（微博评论那份是它客户端渲染的）
test('site.js 删除键接线：双前缀选择器 + 后台评论端点 + 微博评论渲染也带该键 + 七主题样式', () => {
  const site = readFileSync(new URL('../public/site.js', import.meta.url), 'utf8')
  assert.ok(site.includes("closest('.cmt-del-btn, .wb-cmt-del-btn')"), '点击代理要同时认 .cmt-del-btn 与 .wb-cmt-del-btn')
  assert.ok(site.includes("'/api/admin/comments/' + encodeURIComponent(id)"), '删除请求应复用后台评论端点（会话鉴权）')
  assert.ok(site.includes('class="wb-cmt-del-btn"'), '微博评论（客户端渲染）也要出删除键')
  assert.ok(site.includes('删除这条评论？'), '删除前应有二次确认')
  for (const theme of ['wechat', 'paper', 'midnight', 'minimal', 'journal', 'bitcoin', 'rednote']) {
    const css = readFileSync(new URL(`../src/themes/${theme}.css`, import.meta.url), 'utf8')
    assert.ok(css.includes('.cmt-del-btn, .wb-cmt-del-btn'), theme + '.css 缺删除键样式')
  }
})
