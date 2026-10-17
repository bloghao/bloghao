import type { SettingsMap } from './types'
import { invalidateSharedSettings } from './db'
import { cstDate } from './utils'

/* ---------------- 英文版（内部代号 English 0.1，测试版） ----------------
 * 单文件自洽模块（同 protect.ts / closed.ts 三件套口径）：词典 + 英文日期 + 版本判定 + 回退落库，
 * Node 测试可直接导入（不依赖 Workers 运行时）。
 *
 * 设计口径：
 * - 词典是「整串精确匹配」：只翻译系统内置文案（默认站点名/描述/页脚、主题 UI 词），站长自填的
 *   中文内容（文章正文、自定义摘要、自定义页脚）查不到就原样透传——绝不碰用户内容
 * - 中文路径必须字节级不变：isEn(settings) 为 false 时所有 tr() 原样返回、日期走原中文函数，
 *   既有渲染与 300+ 回归测试零漂移
 * - 带数字/身份的句子（「共 N 篇」「以作者 X 的身份发言」）不做词典拼接，调用方按英文语序内联重组
 * - 版本状态存 settings 两个键：edition（zh/en，后台可切换）+ editionEnStatus（active/fallback）。
 *   英文版渲染抛错时 recordEditionFailure 落库 status=fallback，下一次 getSettings 起 isEn=false，
 *   全站自动回到中文版（index.ts 的公开页守卫负责重试当前请求），后台横幅提醒，需人工重新开启
 */

/** 英文测试版是否生效：edition=en 且未被自动回退（脏值/缺省一律中文，与 DEFAULT_SETTINGS 同口径） */
export function isEn(s: SettingsMap | undefined | null): boolean {
  return !!s && s.edition === 'en' && s.editionEnStatus !== 'fallback'
}

/** 词典：键为系统内置中文原文（整串精确匹配），值为英文测试版文案 */
const ZH_EN: Record<string, string> = {
  // 系统默认站点信息（站长自填的内容查不到原样透传）
  '博客号 BlogHao': 'BlogHao',
 '微信有公众号，你有博客号。想写就写，一切都归你。':
    'WeChat has official accounts. You have a blog. Write whenever you like — it is all yours.',
  '由 博客号 驱动 · 住在 Cloudflare 上': 'Powered by BlogHao · Lives on Cloudflare',
  '<p>在这里写下关于你的故事。</p>': '<p>Write your story here.</p>',
  '本站暂时关闭，请稍后再来。': 'This site is temporarily closed. Please check back later.',
  // 后台概览「系统」卡：一键清理页面缓存按钮与提示（后台界面不走 enGuard，词条暂存备用）
  '清理缓存': 'Purge cache',
  '页面缓存已清理，访客即刻看到最新页面': 'Page cache purged — visitors now see the latest pages',
  // 顶部导航 / 共享构建器
  '首页': 'Home',
  '微博': 'Notes',
  '归档': 'Archives',
  '留言板': 'Guestbook',
  '分类': 'Categories',
  '话题': 'Tags',
  '分类话题': 'Topics',
  '友情链接': 'Links',
  '会员': 'Membership',
  '排行榜': 'Leaderboard',
  '关于我': 'About',
  '随机': 'Random',
  '站点导航': 'Site navigation',
  '微博话题': 'Note topics',
  '文章排序': 'Sort posts',
  // 文章页动作
  '留言': 'Comments',
  '赞': 'Like',
  '分享': 'Share',
  '分享本文': 'Share this post',
  '点赞': 'Like',
  // 桌面端增强（wechat 主题侧栏）
  '目录': 'Contents',
  '文章信息': 'About this post',
  '发布于': 'Published',
  '阅读时长': 'Reading time',
  '阅读量': 'Views',
  // 评论区
  '作者': 'Author',
  '回复': 'Reply',
  '楼主': 'OP',
  '开张大吉，还差三步': 'Welcome aboard — three steps to go',
  '这里还是一张白纸。登录后台，几分钟就能迎来第一位读者：': 'This blog is a blank page. Sign in to the admin and greet your first reader in minutes:',
  '写下第一篇文章': 'Write your first post',
  '挑一套顺眼的皮肤': 'Pick a theme you love',
  '补上站名、头像与简介': 'Add your site name, avatar and bio',
  '这张卡片只在没有内容时出现，发布第一篇后自动消失': 'This card only shows on an empty site and disappears once you publish',
  '上一篇': 'Previous',
  '下一篇': 'Next',
  '昵称': 'Name',
  'QQ 号（选填，展示头像）': 'QQ ID (optional, shows an avatar)',
  '仅用于抓取头像，不会公开展示': 'Only used to fetch the avatar; never shown publicly',
  '说点什么…': 'Say something…',
  '写下你的想法…': 'Share your thoughts…',
  '想对作者说点什么…': 'Leave a message for the author…',
  '发送': 'Post',
  '留言即刻展示，请友善交流': 'Comments appear instantly — please be kind',
  '提交后审核通过即展示': 'Your comment will appear once approved',
  '发布后将显示 IP 属地': 'Your IP region will be shown publicly',
  '还没有留言，来抢沙发～': 'No comments yet — be the first!',
  '还没有人留言，来坐个沙发，说点什么吧～': 'No messages yet — come say hello!',
  '作者已关闭留言。': 'Comments are closed.',
  '全部留言': 'All messages',
  // 微博（随手记）卡片
  '置顶': 'Pinned',
  '取消置顶': 'Unpin',
  '编辑': 'Edit',
  '删除': 'Delete',
  '微博 · 随手记': 'Notes',
  '全部': 'All',
  '全部 →': 'All →',
  '加载中…': 'Loading…',
  // 前台发布框（管理员）
  '有什么新鲜事？写 #话题 即可归类': "What's on your mind? Use #topic in the text to file it",
  '加图（0/9）': 'Add photo (0/9)',
  '存草稿': 'Save draft',
  '发布': 'Publish',
  // 分页
  '← 上一页': '← Previous',
  '下一页 →': 'Next →',
  '页码': 'Page number',
  // 排序条
  '排序': 'Sort',
  '最新': 'Latest',
  '最多阅读': 'Most read',
  '最多点赞': 'Most liked',
  '最多留言': 'Most commented',
  // 友链申请
  '申请收录': 'Submit your site',
 '想和本站交个朋友？留下你的站点，审核通过后就会出现在上面。':
    'Want to trade links? Leave your site below and it will show up here once approved.',
  '站点名称': 'Site name',
  'https:// 你的网址': 'https:// your URL',
  '一两句介绍你的网站（可选）': 'A line or two about your site (optional)',
  '站点介绍': 'Site description',
  '提交后由站长审核': 'Reviewed by the site owner before it goes live',
  '提交申请': 'Submit',
  // 历史上的今天
  '历史上的今天': 'On this day',
  '时间经过的地方，总会留下点什么': 'Where time has passed, something always stays',
  '去年': 'Last year',
  '文章': 'Post',
  // 会员档位与会员中心
  '普通会员': 'Member',
  '咖啡会员': 'Coffee member',
  '顶级会员': 'Top member',
  '积分': 'Points',
  '退出登录': 'Log out',
  '修改昵称': 'Change display name',
  '昵称（中英文均可）': 'Display name',
  '保存昵称': 'Save name',
  'QQ 头像': 'QQ avatar',
  '输入你的 QQ 号': 'Your QQ ID',
  '已绑定，头像会显示在评论区与排行榜': 'Linked. Your avatar shows in comments and the leaderboard',
  '已绑定但头像还没抓到，点下方按钮重试': 'Linked but the avatar has not been fetched yet — retry below',
 '绑定后评论区与排行榜显示 QQ 头像；QQ 号仅用于抓取头像，不会公开展示':
    'Link your QQ ID to show its avatar in comments and the leaderboard; the ID itself is never shown',
  '重试头像': 'Retry avatar',
  '保存': 'Save',
  '修改密码': 'Change password',
  '当前密码': 'Current password',
  '新密码（至少 8 位）': 'New password (min 8 characters)',
  '本站不提供密码找回，请务必记好新密码；修改成功后其他设备将退出登录':
    'There is no password recovery — keep the new one safe. Other devices will be signed out after the change',
  '确认修改': 'Save password',
  '登录': 'Log in',
  '注册会员': 'Create account',
  '用户名': 'Username',
  '密码': 'Password',
  '用户名（2-24 位字母、数字、_ 或 -）': 'Username (2–24 letters, digits, _ or -)',
  '昵称（选填，中英文均可）': 'Display name (optional)',
  '邮箱（选填）': 'Email (optional)',
  '注册并登录': 'Sign up & log in',
  '还没有账号？': 'No account yet?',
  '注册一个': 'Create one',
  '密码一旦遗失无法找回，请务必记好': 'Passwords cannot be recovered — remember yours',
  '已有账号？': 'Already have an account?',
  '去登录': 'Log in',
  // 微博视频（B19）
  '视频': 'Video',
  '最大 25MB，MP4 / WebM': 'Up to 25MB, MP4 / WebM',
  '图片 / 视频，一条微博最多 1 个视频': 'Photos / video — one video per note',
  '删除这条评论（其下回复一并删除，不可恢复）': 'Delete this comment (its replies go too, and this cannot be undone)',
  '只支持 MP4 / WebM 视频': 'Only MP4 / WebM videos are supported',
  '写点什么，或者配张图 / 加段视频吧': 'Write something, or attach a photo / video first',
  // 闭站页
  '站点暂时关闭': 'Temporarily closed',
}

/** 英文测试版查词典；非英文或查不到原样返回（中文路径字节级不变、用户内容零碰） */
export function tr(en: boolean, zh: string): string {
  if (!en) return zh
  return Object.prototype.hasOwnProperty.call(ZH_EN, zh) ? ZH_EN[zh] : zh
}

/** 英文可数名词单复数：one 用于 1，more 用于 0、2+ */
export function plural(n: number, one: string, more: string): string {
  return n === 1 ? one : more
}

/* ---------------- 英文日期（与 fmtDate 同一北京时间口径：cstDate +8h 取 UTC 分量） ---------------- */

const EN_MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']

/** 英文日期：Oct 10, 2026（文章 meta、归档、微博往年等主格式） */
export function fmtDateEn(ts: number | null | undefined): string {
  if (!ts) return ''
  const d = cstDate(ts)
  return `${EN_MONTHS[d.getUTCMonth()]} ${d.getUTCDate()}, ${d.getUTCFullYear()}`
}

/** 英文短日期：Oct 10（归档列表——年份已在分组标题上） */
export function fmtDateEnShort(ts: number | null | undefined): string {
  if (!ts) return ''
  const d = cstDate(ts)
  return `${EN_MONTHS[d.getUTCMonth()]} ${d.getUTCDate()}`
}

/** 英文日期时间：Oct 10, 2026, 14:30（评论区等） */
export function fmtDateTimeEn(ts: number | null | undefined): string {
  if (!ts) return ''
  const d = cstDate(ts)
  const p = (x: number) => String(x).padStart(2, '0')
  return `${fmtDateEn(ts)}, ${p(d.getUTCHours())}:${p(d.getUTCMinutes())}`
}

/** 英文微博时间：今年「Oct 10, 14:30」，往年「Oct 10, 2025」（与服务端 weiboTime 口径一致，site.js 有同款镜像） */
export function weiboTimeEn(ts: number): string {
  const d = cstDate(ts)
  const now = cstDate(Date.now())
  const p = (x: number) => String(x).padStart(2, '0')
  const md = `${EN_MONTHS[d.getUTCMonth()]} ${d.getUTCDate()}`
  return d.getUTCFullYear() === now.getUTCFullYear()
    ? `${md}, ${p(d.getUTCHours())}:${p(d.getUTCMinutes())}`
    : `${md}, ${d.getUTCFullYear()}`
}

/* ---------------- 测试版公示 ---------------- */

/** 英文测试版横幅（所有公开页顶部公示站点性质，同 demoBannerHtml 口径：内联样式不依赖主题 CSS） */
export function enBetaBannerHtml(): string {
  return `<div style="background:#1d4ed8;color:#fff;font-size:13px;line-height:1.6;text-align:center;padding:7px 14px;">🧪 English 0.1 (Beta) — test edition of this blog. The interface is in English; posts remain in their original language.</div>`
}

/* ---------------- 自动回退（英文版渲染异常 → 全站自动切回中文版） ---------------- */

/** 英文版失败后的落库回退：status=fallback 立即生效（下一次 getSettings 起 isEn=false），
 *  同时记录错误摘要与时间供后台横幅展示；自身失败只打日志——回退动作绝不能再抛错打断请求 */
export async function recordEditionFailure(db: D1Database, err: unknown): Promise<void> {
  try {
    const msg = String((err as Error)?.message || err || 'unknown error').slice(0, 300)
    const upsert = (k: string, v: string) =>
      db
        .prepare('INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value')
        .bind(k, v)
    await db.batch([
      upsert('editionEnStatus', 'fallback'),
      upsert('editionEnError', msg),
      upsert('editionEnAt', String(Date.now())),
    ])
    // 立即失效 settings 共享快照：回退必须「下一次 getSettings 起 isEn=false」
    await invalidateSharedSettings(db)
  } catch (e) {
    console.error('[en-edition] record fallback failed:', e)
  }
}
