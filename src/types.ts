export interface Env {
  DB: D1Database
  IMAGES: R2Bucket
  ASSETS: Fetcher
  /** 演示站模式（wrangler.demo.jsonc 注入 "1"）：生产 Worker 不设置，见 src/demo.ts */
  DEMO_MODE?: string
}

export interface SessionUser {
  id: number
  username: string
  display_name: string
  avatar: string
}

/* ---------------- 会员体系（访客注册身份，与 users 管理员彻底分离，契约见 docs/DEVPLAN-2026-10-07.md 附录 A） ---------------- */

export type MemberTier = 'normal' | 'coffee' | 'top'

/** members 表整行（含口令字段，仅服务端登录/管理口径使用；对外一律过 memberView 裁剪） */
export interface MemberRow {
  id: number
  username: string
  password_hash: string
  salt: string
  email: string
  display_name: string
  avatar: string
  /** 绑定的 QQ 号（仅头像抓取记账位）；任何公开出参不携带，头像走站内转存 */
  qq: string
  tier: MemberTier
  points: number
  status: 'active' | 'banned'
  created_at: number
  updated_at: number
  last_login_at: number | null
  /** 上次改昵称时间；null = 从未改过，首次修改不受 30 天窗口限制 */
  display_name_changed_at: number | null
}

/** 会员会话身份（Cookie xw_member_session；banned 在查询层即视为未登录） */
export interface MemberSessionUser {
  id: number
  username: string
  display_name: string
  avatar: string
  tier: MemberTier
  points: number
}

export type PostStatus = 'draft' | 'published' | 'scheduled'

export interface PostRow {
  id: number
  slug: string
  title: string
  content: string
  summary: string
  cover: string
  tags: string
  status: PostStatus
  pinned: number
  views: number
  likes: number
  author_id: number | null
  published_at: number | null
  /** 定时发布目标时间（毫秒）；仅 scheduled 状态有值 */
  publish_at: number | null
  /** 可见档位（契约 DEVPLAN 附录 A）：all | member | coffee | top，缺省 all；老库 ALTER 补列前可能缺省 */
  min_tier?: string
  /** 访问密码（src/protect.ts）：salt:hash（PBKDF2），空 = 未加密；不进任何后台响应 */
  password_hash?: string
  /** AI 生成标注（编辑器「更多」自愿申报，0/1）：1 = 文章页 meta 行显示 AI 生成标识；老库 ALTER 补列前可能缺省 */
  ai_generated?: number
  created_at: number
  updated_at: number
  /** 回收站：非 NULL = 已移入回收站（毫秒），NULL = 存活（src/trash.ts） */
  deleted_at: number | null
}

export interface WeiboRow {
  id: number
  content: string
  images: string
  /** 单条视频（B19，解析/读侧过滤见 src/db.ts parseWeiboVideo / weiboVideoView）：JSON 串，空串 = 无视频 */
  video: string
  topics: string
  status: PostStatus
  pinned: number
  likes: number
  published_at: number | null
  created_at: number
  updated_at: number
  /** 回收站：非 NULL = 已移入回收站（毫秒），NULL = 存活（src/trash.ts） */
  deleted_at: number | null
}

export interface CommentRow {
  id: number
  post_id: number
  weibo_id: number
  parent_id: number
  is_admin: number
  nickname: string
  email: string
  website: string
  content: string
  status: 'approved' | 'pending'
  ip: string
  /** 评论 IP 属地快照（src/ipregion.ts）：写库定格 cf（CN:Guangdong / US / HK），空 = 无数据不展示；公开出参走 showCommentRegion 门控，标签由 ipRegionLabel 单点格式化 */
  ip_region?: string
  created_at: number
  /** 会员徽标冗余字段：评论列表 LEFT JOIN members 带出（member_id > 0 时非空，契约 DEVPLAN 附录 A） */
  member_name?: string
  member_tier?: MemberTier
  /** 会员头像（站内 /images/ 转存地址）：评论头像位展示用；QQ 号本体永不出参 */
  member_avatar?: string
  /** 游客选填的 QQ 号（评论头像 C2）：仅头像抓取记账位，任何公开出参不携带 */
  qq?: string
  /** 游客头像（服务端 qlogo 抓取后站内转存地址）：评论头像位展示用；空 = 首字块 */
  avatar?: string
}

export interface CategoryRow {
  id: number
  name: string
  slug: string
  sort: number
  /** 分类描述（B23）：归档页页头说明 + meta description；纯文本，后台分类编辑维护 */
  description: string
  created_at: number
}

/** 独立页面（pages 表）：自建页面与「关于我」（slug = 'about'） */
export interface PageRow {
  id: number
  title: string
  slug: string
  content: string
  status: 'draft' | 'published'
  show_in_nav: number
  sort: number
  created_at: number
  updated_at: number
  /** 回收站：非 NULL = 已移入回收站（毫秒），NULL = 存活（src/trash.ts） */
  deleted_at: number | null
}

export interface FriendLinkRow {
  id: number
  name: string
  url: string
  description: string
  icon: string
  status: 'approved' | 'pending'
  sort: number
  source: 'admin' | 'user'
  ip: string
  created_at: number
  updated_at: number
}

export type SettingsMap = Record<string, string>
