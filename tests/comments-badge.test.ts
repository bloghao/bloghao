import { test } from 'node:test'
import assert from 'node:assert/strict'
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
