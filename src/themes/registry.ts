import * as bitcoin from './bitcoin'
import * as journal from './journal'
import * as midnight from './midnight'
import * as minimal from './minimal'
import * as paper from './paper'
import * as rednote from './rednote'
import * as wechat from './wechat'
import type {
  ArchiveYearGroup,
  CategoryLink,
  FriendLinkView,
  HomePostView,
  MemberView,
  NavPage,
  OnThisDayItemView,
  RankEntryView,
  TagCount,
  WeiboItemView,
} from '../render'
import type { PostSort } from '../db'
import type { SettingsMap } from '../types'

/**
 * 主题页面参数命名类型：八类页面各一份，主题文件与 pages.ts 共用同一套
 * （此前是 registry 内联一份 + 每个主题文件手写一份，共 6 份同构拷贝）。
 * 新增字段只改这里，所有主题签名同步。
 */

export interface HomeData {
  settings: SettingsMap
  posts: HomePostView[]
  page: number
  totalPages: number
  total: number
  tag?: string
  /** 搜索页当前关键词（刊头搜索框回填用） */
  q?: string
  /** 列表当前排序（首页/分类/搜索共用排序条；随机时翻页需带 seed） */
  sort?: PostSort
  /** 随机排序的种子：服务端生成后回传，翻页链接携带以稳住同一组顺序 */
  seed?: number
  /** 当前分类页的 slug（分类页排序条/翻页回链用） */
  categorySlug?: string
  /** 顶部导航「分类话题」菜单的标签（带使用计数，已按热度排序） */
  tags: TagCount[]
  /** 顶部导航数据与高亮：'home' | 'weibo' | 分类 slug | 'tag:标签名' | 'search' */
  categories: CategoryLink[]
  /** 顶部导航里的自建页面项（独立页面系统，siteNav 渲染用） */
  pages?: NavPage[]
  navActive?: string
  /** 列表上方的通知区（搜索结果/分类说明），由 pages 层构建好的 HTML */
  notice?: string
  /** 空列表文案（搜索/分类页有定制文案） */
  emptyText?: string
  /** 首页微博入口卡数据（仅「博客+微博」模式的首页传入；没有已发布微博时为 null） */
  weibo?: { items: WeiboItemView[]; total: number } | null
  /**
   * 首页微博流（仅「微博+博客」模式的首页传入）：完整微博卡片先行，文章列表跟在后面。
   * 主题侧用 weiboHomeFeed({ settings, ...weiboFeed, avatarHtml }) 渲染；没有已发布微博时为 null
   */
  weiboFeed?: {
    items: WeiboItemView[]
    total: number
    allowComments: boolean
    adminName?: string
    memberName?: string
  } | null
  /**
   * 搜索页微博结果（ROADMAP B4，仅 /search 带关键词时传入）：主题侧用
   * weiboSearchResults({ settings, ...searchWeibo, avatarHtml }) 渲染；没有命中时为 null
   */
  searchWeibo?: { items: WeiboItemView[]; total: number } | null
  /** 历史上的今天（仅首页第一页且未筛选时传入）：往年今日的文章与微博，空数组/缺省不渲染 */
  onThisDay?: OnThisDayItemView[] | null
}

export interface WeiboData {
  settings: SettingsMap
  categories: CategoryLink[]
  /** 顶部导航里的自建页面项（独立页面系统，siteNav 渲染用） */
  pages?: NavPage[]
  /** 顶部导航「分类话题」菜单的标签 */
  tags?: TagCount[]
  items: WeiboItemView[]
  page: number
  totalPages: number
  total: number
  /** 站点「允许评论」开关：关闭时微博卡片只展示评论列表入口，不出表单 */
  allowComments: boolean
  /** 登录管理员昵称：卡片内评论表单免填昵称，以作者身份发言 */
  adminName?: string
  /** 登录会员昵称（管理员未登录时生效）：卡片内评论表单免填昵称，以会员身份发言 */
  memberName?: string
  /** 当前筛选的话题（?topic=），为空为全部 */
  topic?: string
  /** 已发布微博的话题聚合（话题条数据），为空不渲染话题条 */
  topics?: { name: string; count: number }[]
}

export interface LinksData {
  settings: SettingsMap
  categories: CategoryLink[]
  pages?: NavPage[]
  tags?: TagCount[]
  /** 已收录的友链 */
  items: FriendLinkView[]
  total: number
}

export interface PostData {
  settings: SettingsMap
  post: {
    slug: string
    title: string
    contentHtml: string
    summary: string
    cover: string
    tags: string[]
    published_at: number | null
    views: number
    likes: number
    readingMinutes: number
    /** 谁能看档位（编辑器「谁能看」选择，缺省 'all' 全员可见；'member' = 登录会员可见） */
    minTier?: 'all' | 'member' | 'coffee' | 'top'
    /** true = 当前访客不可读全文：contentHtml 已被服务端截断为试读段，主题在正文后渲染付费墙遮挡卡（paywallHtml），不得自行补全内容 */
    locked?: boolean
  }
  category: CategoryLink | null
  categories: CategoryLink[]
  pages?: NavPage[]
  tags?: TagCount[]
  comments: { html: string; count: number }
  related: HomePostView[]
  /** 分享按钮数据：canonical 绝对链接 + 该链接的 QR 矩阵位串（src/qrcode.ts 打包；qr 为空串表示超长未生成） */
  share?: { url: string; qr: string }
}

export interface AboutData {
  settings: SettingsMap
  contentHtml: string
  categories: CategoryLink[]
  pages?: NavPage[]
  tags?: TagCount[]
  /** 导航高亮：关于我页传 'about' */
  navActive?: string
}

/**
 * 独立页面页（/page/:slug）：自建页面（项目页/书单页/隐私政策等）；
 * slug='about' 的页面复用本函数渲染在专属短链 /about。
 * 运行时有兜底：主题未实现时由 pages.ts 渲染通用版（无主题导航 cls，仅正文壳）。
 */
export interface PageData {
  settings: SettingsMap
  title: string
  contentHtml: string
  categories: CategoryLink[]
  pages?: NavPage[]
  tags?: TagCount[]
  /** 导航高亮：独立页面传 'p:<slug>'；关于我在 /about 渲染时传 'about' */
  navActive?: string
}

/** 文章归档页（/archives）：全部已发布文章按年分组，pages 层构建好 groups */
export interface ArchivesData {
  settings: SettingsMap
  categories: CategoryLink[]
  pages?: NavPage[]
  tags?: TagCount[]
  /** 文章总篇数（页头副标题用） */
  total: number
  groups: ArchiveYearGroup[]
}

/** 留言板页（/guestbook）：html 为 commentsHtml({ guestbook: true }) 构建的留言墙 + 表单 */
export interface GuestbookData {
  settings: SettingsMap
  categories: CategoryLink[]
  pages?: NavPage[]
  tags?: TagCount[]
  html: string
  count: number
}

/** 会员中心页（/member）：member 为 null 渲染登录/注册双表单（memberAuthHtml），否则渲染会员卡（memberCardHtml） */
export interface MemberData {
  settings: SettingsMap
  categories: CategoryLink[]
  pages?: NavPage[]
  tags?: TagCount[]
  /** 导航高亮：会员中心页传 'member' */
  navActive?: string
  /** 当前登录会员（服务端会话解析产出）；null = 未登录 */
  member: MemberView | null
}

/** 排行榜页（/rank）：会员积分总榜，entries 已按 points 倒序、rank 已排好名次 */
export interface RankData {
  settings: SettingsMap
  categories: CategoryLink[]
  pages?: NavPage[]
  tags?: TagCount[]
  /** 导航高亮：排行榜页传 'rank' */
  navActive?: string
  entries: RankEntryView[]
  /** 上榜会员总数（页头副标题用） */
  total: number
  /** 当前访客在榜上的自己（未上榜/未登录为 null；本人行同时带 isMe 标记） */
  me?: RankEntryView | null
}

/**
 * 主题注册表 —— 新增主题：
 * 1. 在 src/themes/ 下新建 mytheme.ts + mytheme.css，从本文件 import 上述 *Data 类型
 *    实现八个同名导出函数（page 可省略，运行时兜底通用版；member/rank 同为可选 + 运行时兜底）
 * 2. 在这里注册一行
 * 详见 docs/THEMES.md
 */
export interface ThemeModule {
  id: string
  name: string
  description: string
  css: string
  /** 后台「皮肤」卡片预览色板 [背景, 强调条, 卡面, 卡面2, 卡面3]；缺省时后台用灰色兜底 */
  colors?: string[]
  home(d: HomeData): string
  weibo(d: WeiboData): string
  links(d: LinksData): string
  post(d: PostData): string
  about(d: AboutData): string
  page(d: PageData): string
  archives(d: ArchivesData): string
  guestbook(d: GuestbookData): string
  /** 会员中心页（/member）：可省略，运行时兜底通用版 */
  member?(d: MemberData): string
  /** 排行榜页（/rank）：可省略，运行时兜底通用版 */
  rank?(d: RankData): string
}

export const THEMES: Record<string, ThemeModule> = {
  wechat: {
    ...wechat,
    id: 'wechat',
    name: '微信公众号',
    description: '订阅号卡片流 + 公众号文章页排版，明亮清爽',
    colors: ['#ededed', '#b23a29', '#ffffff', '#e8f7ef', '#f2f2f2'],
  },
  journal: {
    ...journal,
    id: 'journal',
    name: '手账',
    description: '奶油纸面、和纸胶带、拍立得与贴纸，把博客写成一本手账',
    colors: ['#faf5ea', '#e06a3c', '#fffdf6', '#fde7e2', '#e7f0da'],
  },
  paper: {
    ...paper,
    id: 'paper',
    name: '纸墨',
    description: '宋体排印、印章红点缀，安安静静读书的纸面',
    colors: ['#f7f4ee', '#a03c2e', '#fffdf8', '#efe9db', '#f1ede2'],
  },
  minimal: {
    ...minimal,
    id: 'minimal',
    name: '极简',
    description: '黑白灰、大标题、大留白，内容即全部',
    colors: ['#ffffff', '#111111', '#f5f5f5', '#efefef', '#f7f7f7'],
  },
  midnight: {
    ...midnight,
    id: 'midnight',
    name: '夜航',
    description: '深夜星图蓝 + 等宽字体点缀的开发者日志风',
    colors: ['#0f1115', '#58a6ff', '#161a22', '#1d232e', '#181d26'],
  },
  bitcoin: {
    ...bitcoin,
    id: 'bitcoin',
    name: '比特币',
    description: '比特币橙 × 暖白纸面，描边分层、衬线大标题与等宽眉题的品牌 kit 风',
    colors: ['#faf9f6', '#f7931a', '#ffffff', '#fff3e0', '#f2f0ea'],
  },
  rednote: {
    ...rednote,
    id: 'rednote',
    name: '小红书',
    description: '发现页瀑布流笔记卡 + 品牌红点缀，把博客写成一册生活指南',
    colors: ['#f7f8fa', '#ff2442', '#ffffff', '#ffeef0', '#f5f6f7'],
  },
}

export function getTheme(id: string): ThemeModule {
  // hasOwnProperty 防原型链属性（constructor 等）被当成主题 id
  return Object.prototype.hasOwnProperty.call(THEMES, id) ? THEMES[id] : THEMES.wechat
}
