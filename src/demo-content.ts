/**
 * 演示站种子数据编排（src/demo.ts 播种用）：把 src/demo-posts.ts 的文章与其他内容
 * 解析成可直接落库的计划。所有随机数走固定种子（mulberry32），重置前后内容完全一致；
 * 时间戳基于播种时刻的 now 生成，保证任何时候重置都呈现「过去一年、最近几小时前刚更新」。
 * 纯函数无 IO，tests/demo.test.ts 直接对计划做不变量校验。
 * 本文件保持零依赖（不 import schema.sql / auth 等 Workers 侧模块），Node 测试可直接加载。
 */
import { DEMO_POSTS } from './demo-posts'
import { fmtDate } from './utils'

/** 演示站重置 cron：每 2 小时的第 23 分钟（避开整点高峰）；demo Worker 独有（见 wrangler.demo.jsonc） */
export const DEMO_RESET_CRON = '23 */2 * * *'

/* ---------------- 确定性随机 ---------------- */

export function mulberry32(seed: number): () => number {
  let a = seed >>> 0
  return () => {
    a |= 0
    a = (a + 0x6d2b79f5) | 0
    let t = Math.imul(a ^ (a >>> 15), 1 | a)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

/** 距今 daysAgo 天的「北京时间 hour:minute」对应的毫秒时间戳 */
function daysAgoAt(now: number, daysAgo: number, hour: number, minute: number): number {
  const bj = new Date(now - daysAgo * 86_400_000 + 8 * 3_600_000)
  bj.setUTCHours(hour % 24, minute % 60, 0, 0)
  return bj.getTime() - 8 * 3_600_000
}

/* ---------------- 各类内容 ---------------- */

export interface DemoWeibo {
  content: string
  daysAgo: number
  hour: number
  images: string[]
  likes: number
  pinned?: 1
  draft?: boolean
}

export const DEMO_WEIBO: DemoWeibo[] = [
  { content: '本博客一岁啦 🎂 一年发了 52 篇文章、180 多条微博，谢谢每一位订阅器里的朋友。年度复盘正在写，先占个楼。', daysAgo: 10, hour: 10, images: [], likes: 45, pinned: 1 },
  { content: '今天把评论通知接进了 Bark，读者留言三十秒就在手机上响。科技改变话痨。', daysAgo: 341, hour: 22, images: [], likes: 6 },
  { content: 'D1 的 batch 里塞了 80 条语句一次过，这就是 serverless 数据库的爽点：不用管连接池。', daysAgo: 302, hour: 15, images: [], likes: 11 },
  { content: '梅雨季第二十天，阳台的薄荷是唯一还在生长的东西。向强者学习。', daysAgo: 312, hour: 8, images: [], likes: 9 },
  { content: '#夜跑# 今晚 5 公里配速 5\'40"。秋天的凉意是跑步者的赎罪券。', daysAgo: 34, hour: 21, images: [], likes: 7 },
  { content: '写了篇关于定时发布的教程，然后这篇文章本身就是定时发布的。套娃的快乐。', daysAgo: 120, hour: 0, images: [], likes: 14 },
  { content: 'RSS 阅读器未读数清零的瞬间，比清空购物车治愈多了。', daysAgo: 284, hour: 23, images: [], likes: 5 },
  { content: '博客换了纸墨主题，米色底看着眼睛舒服多了。选择困难症终结。', daysAgo: 299, hour: 19, images: ['wb-01'], likes: 12 },
  { content: '楼下面馆的老板娘记住了我的浇头。比大多数 SaaS 的个性化推荐都准。', daysAgo: 266, hour: 12, images: [], likes: 16 },
  { content: '#读书# 《翦商》读到人祭那一章，饭吃到一半停了。好的历史书是让人食不下咽的。', daysAgo: 251, hour: 19, images: [], likes: 10 },
  { content: '今天服务器零告警零报错。记录一下这种反常的幸福。', daysAgo: 241, hour: 21, images: [], likes: 4 },
  { content: '秋天的第一次爬山回来，腿是酸的，心是轻的。', daysAgo: 13, hour: 12, images: ['wb-02'], likes: 9 },
  { content: '搬运公众号旧文第 35 篇。看着自己的 R2 图床一点点充实，像看着搬家纸箱被填满。', daysAgo: 238, hour: 10, images: [], likes: 6 },
  { content: '同事问我博客有什么用。我想了想说：相当于给自己发了一个永不过期的朋友圈。', daysAgo: 226, hour: 18, images: [], likes: 22 },
  { content: '雨夜面馆 + 雪菜肉丝面 + 评弹 = 城市深夜三件套。', daysAgo: 36, hour: 23, images: ['wb-03'], likes: 8 },
  { content: '写了一个周末的草稿，删掉的比留下的多。写作就是这样的。', daysAgo: 211, hour: 22, images: [], likes: 13 },
  { content: '凌晨部署新版本成功，发一条微博庆祝，然后睡觉。这就是独立开发的蹦迪。', daysAgo: 198, hour: 0, images: [], likes: 11 },
  { content: '阳台的小葱收割第二茬。农业自信 +1，虽然它真的不用我管。', daysAgo: 186, hour: 9, images: [], likes: 7 },
  { content: '评论区来了位读者指出教程里的错误，已修正并回复。这种互动感是写博客的隐藏福利。', daysAgo: 171, hour: 14, images: [], likes: 10 },
  { content: '桂花开了。嗅觉先于日历宣布秋天。', daysAgo: 19, hour: 18, images: [], likes: 6 },
  { content: '朋友问我要不要做小红书。我指了指自己的博客：我的流量入口在搜索引擎，不焦虑的地方就是好地方。', daysAgo: 156, hour: 16, images: [], likes: 15 },
  { content: '今日份快乐：给独立页面加了书单，把今年读过的书一张表摆出来，成就感莫名。', daysAgo: 141, hour: 20, images: [], likes: 5 },
  { content: '微博页上线啦，以后碎片想法都来这里。这个功能本来的定位是「不够成文的」，但我怀疑它会变成我的主力输出。', daysAgo: 129, hour: 13, images: [], likes: 12 },
  { content: '打印机修好了，代价是两个小时和一个几乎摔键盘的瞬间。数字化生活里最难的还是硬件。', daysAgo: 116, hour: 17, images: [], likes: 6 },
  { content: '半夜收到备份告警：某表行数为 0。吓出一身汗，查完发现是自己下午清了测试数据。告警系统无罪。', daysAgo: 101, hour: 1, images: [], likes: 9 },
  { content: '周末把博客速度优化到了 400ms，快乐持续了整整一天。性能优化者的多巴胺很便宜。', daysAgo: 143, hour: 11, images: [], likes: 14 },
  { content: '今天一个读者发邮件说「你的教程帮到了我」。这一条顶一个月统计页。', daysAgo: 86, hour: 9, images: [], likes: 18 },
  { content: '台风天，全家囤电囤水，我囤了三本书。各人有各人的安全感。', daysAgo: 71, hour: 15, images: [], likes: 5 },
  { content: '写作马拉松第 7 天，微博页热闹起来了。50 字真是个天才门槛。', daysAgo: 48, hour: 8, images: [], likes: 4 },
  { content: '立冬。把「秋天爬山」的目标续费成了「冬天看雪」，同一个山头，新的 flag。', daysAgo: 3, hour: 20, images: [], likes: 3 },
  { content: '草稿：明年想把「关于我」页改成时间线形式，先记着，别忘。', daysAgo: 61, hour: 23, images: [], likes: 0, draft: true },
]

export interface DemoComment {
  /** 文章 slug（微博评论与留言板留空） */
  post?: string
  /** 微博序号（从 1 起，对应 DEMO_WEIBO 下标+1；文章与留言板评论为 0） */
  weibo?: number
  /** 留言板评论（post_id=0, weibo_id=0） */
  guestbook?: boolean
  /** 回复的目标评论序号（从 1 起，对应本数组中更早的评论；顶层评论为 0） */
  replyTo?: number
  admin?: boolean
  /** 以会员身份发言（DEMO_MEMBERS 的 username）：评论挂 member_id，前台带会员徽标 */
  member?: string
  nick: string
  site?: string
  content: string
  pending?: boolean
  /** 距目标（文章/微博发布时间）多少小时后发出 */
  hoursAfter: number
}

export const DEMO_COMMENTS: DemoComment[] = [
  // —— cloudflare-free-tier-one-year ——
  { post: 'cloudflare-free-tier-one-year', nick: '山下的人', content: '这个表太直观了，之前一直担心免费额度，看完彻底放心。请问读者上传图片也存 R2 吗？', hoursAfter: 74, site: 'https://shanxia.example.com' },
  { post: 'cloudflare-free-tier-one-year', replyTo: 1, admin: true, nick: '阿拾', content: '对，评论头像和图床都在 R2，成本可以忽略。放心用！', hoursAfter: 80 },
  { post: 'cloudflare-free-tier-one-year', nick: 'Momo', member: 'momo', content: '想问下备份的 30 份滚动是怎么算的？每天一份那不就一个月了吗', hoursAfter: 120 },
  { post: 'cloudflare-free-tier-one-year', replyTo: 3, admin: true, nick: '阿拾', content: '对，就是保留最近 30 天每天一份，第 31 天自动删最旧的。', hoursAfter: 127 },
  { post: 'cloudflare-free-tier-one-year', nick: '背包客小鹿', content: '同行，我的博客也满一年了，账单几乎一样，+1。真的不用升级付费计划。', hoursAfter: 200, site: 'https://lulu.example.com' },
  // —— start-bloghao-in-ten-minutes ——
  { post: 'start-bloghao-in-ten-minutes', nick: '代码与诗', content: '跟着做完了，十分钟零三十秒 😂 第一步 wrangler login 卡在浏览器授权，重试就好了。', hoursAfter: 5, site: 'https://codepoem.example.com' },
  { post: 'start-bloghao-in-ten-minutes', replyTo: 6, admin: true, nick: '阿拾', content: '哈哈欢迎入住！授权偶尔抽风，重试一般就好。有问题随时来。', hoursAfter: 9 },
  { post: 'start-bloghao-in-ten-minutes', nick: '夜航西飞', content: '写得很细，收藏了。域名那步能不能展开讲讲托管 DNS 的过程？', hoursAfter: 52 },
  { post: 'start-bloghao-in-ten-minutes', nick: '老张的后端笔记', content: '推荐补充一句：d1 execute 记得加 --remote，我第一次没加，本地库建了半天发现线上是空的……', hoursAfter: 96, site: 'https://laozhang.example.com' },
  { post: 'start-bloghao-in-ten-minutes', replyTo: 9, admin: true, nick: '阿拾', content: '好提醒！已补进文章里，谢谢老张。', hoursAfter: 110 },
  // —— editor-guide ——
  { post: 'editor-guide', nick: '一只北方的猫', content: '截图直接粘贴这个功能我用了两周才看到这篇文章，白手动上传了半个月 😭', hoursAfter: 30, site: 'https://cat.example.com' },
  { post: 'editor-guide', nick: '效率控', content: '快捷输入表格建议置顶！另外问下富文本模式下能切 Markdown 源码编辑吗？', hoursAfter: 76 },
  { post: 'editor-guide', replyTo: 12, admin: true, nick: '阿拾', content: '编辑器左上角有模式切换，Markdown 和富文本内容互通，来回切都行。', hoursAfter: 84 },
  // —— theme-choice ——
  { post: 'theme-choice', nick: '山茶', content: '被纸墨主题击中了，已经切过去了，太好看。', hoursAfter: 20 },
  { post: 'theme-choice', nick: 'Momo', member: 'momo', content: '夜航+1，深色党表示终于有不刺眼的博客了。', hoursAfter: 45 },
  { post: 'theme-choice', nick: '骑行与胶片', content: '手账主题配我的旅行手记正合适，感谢逐套点评！', hoursAfter: 88, site: 'https://ridefilm.example.com' },
  // —— plugin-market ——
  { post: 'plugin-market', nick: '效率控', content: '格式助手治好了我多年的中英文空格强迫症，作者辛苦！', hoursAfter: 26 },
  { post: 'plugin-market', nick: '云间手记', content: '想写一个「引用格式一键生成」的插件，PLUGINS.md 看了一半，钩子设计挺清晰的。', hoursAfter: 62, site: 'https://yunjian.example.com' },
  { post: 'plugin-market', replyTo: 18, admin: true, nick: '阿拾', content: '期待！做完记得提进市场目录，我第一个装。', hoursAfter: 70 },
  // —— wechat-collect ——
  { post: 'wechat-collect', nick: '老张的后端笔记', content: '「我的文字终于都在自己家里」这句戳我了。周末就开搬。', hoursAfter: 34, site: 'https://laozhang.example.com' },
  { post: 'wechat-collect', nick: '数字游民日志', content: '图片转存 R2 这个细节太重要了，之前用别的工具搬过一次，对方删文图全裂。', hoursAfter: 90, site: 'https://nomad.example.com' },
  // —— auto-backup ——
  { post: 'auto-backup', nick: '山下的人', content: '「敢不敢现在就删库」这个检验标准太狠了，我马上配了自动备份。', hoursAfter: 48, site: 'https://shanxia.example.com' },
  { post: 'auto-backup', nick: '一罐可乐', content: '表数告警真的救过我一次，某次插件把一张表清了，TG 半夜弹出通知。', hoursAfter: 130 },
  // —— custom-pages ——
  { post: 'custom-pages', nick: '山茶', content: '书单页学到了，用 details 折叠分类这个细节妙。', hoursAfter: 28 },
  // —— comments-friend-links ——
  { post: 'comments-friend-links', nick: '一只北方的猫', content: '已通过留言板申请友链，等审～先审后发确实清净多了。', hoursAfter: 40, site: 'https://cat.example.com' },
  { post: 'comments-friend-links', replyTo: 25, admin: true, nick: '阿拾', content: '看到了，已经挂上，常来！', hoursAfter: 46 },
  // —— content-pipeline ——
  { post: 'content-pipeline', nick: '夜航西飞', content: '「把意志力从流程里赶出去」——这句话我要抄在便签上。', hoursAfter: 18 },
  { post: 'content-pipeline', nick: '效率控', content: '周日集中写的方案试了两周，确实比日更舒服，感谢分享。', hoursAfter: 72 },
  // —— visitor-stats ——
  { post: 'visitor-stats', nick: '茶水间周刊', content: '不存 IP 这点好评， privacy 这块博客圈确实该向你看齐。', hoursAfter: 55, site: 'https://tearoom.example.com' },
  { post: 'visitor-stats', nick: 'Momo', member: 'momo', content: '「时段分布」好奇，我的是晚上十点半到十二点，原来大家都是夜猫子。', hoursAfter: 90 },
  // —— server-plugins ——
  { post: 'server-plugins', nick: '老张的后端笔记', content: 'webhook 那段 JSON 直接抄走接飞书了，五分钟搞定，感谢！', hoursAfter: 8, site: 'https://laozhang.example.com' },
  { post: 'server-plugins', replyTo: 31, admin: true, nick: '阿拾', content: '好用的话欢迎回来留个言哈哈。', hoursAfter: 12 },
  // —— weibo-page ——
  { post: 'weibo-page', nick: '一罐可乐', content: '从 Telegram 发微博这个太方便了，通勤路上已经在用。', hoursAfter: 15 },
  // —— cloudflare-free-tier ——
  { post: 'd1-one-year', nick: '云间手记', content: '时区那段救了我，凌晨定时发布的文章在归档里真的提前了一天，原来根在这。', hoursAfter: 66, site: 'https://yunjian.example.com' },
  { post: 'd1-one-year', nick: '山下的人', content: 'batch 那个省额度的技巧学到了，我之前真的是一条条 run 的。', hoursAfter: 140, site: 'https://shanxia.example.com' },
  // —— r2-image-hosting ——
  { post: 'r2-image-hosting', nick: '骑行与胶片', content: '透明 PNG 保 alpha 这条真的重要，我之前压过一批图标全变白底。', hoursAfter: 52, site: 'https://ridefilm.example.com' },
  // —— speed-notes ——
  { post: 'speed-notes', nick: '代码与诗', content: 'CSS 内联那刀收益最大吧？我也准备把主题样式打进 Worker。', hoursAfter: 24, site: 'https://codepoem.example.com' },
  { post: 'speed-notes', replyTo: 37, admin: true, nick: '阿拾', content: '是的，少一个关键请求比什么都实在。你的站如果 CSS 不大，直接内联没毛病。', hoursAfter: 30 },
  { post: 'speed-notes', nick: '老张的后端笔记', content: '「每多一个优化手段就多一份复杂度」这句适合裱起来。', hoursAfter: 100, site: 'https://laozhang.example.com' },
  // —— ci-auto-deploy ——
  { post: 'ci-auto-deploy', nick: '数字游民日志', content: '「每个修过的 bug 都该留下一枚地雷」，这个比喻记住了。', hoursAfter: 44, site: 'https://nomad.example.com' },
  // —— seo-rss ——
  { post: 'seo-rss', nick: '茶水间周刊', content: '全文 RSS 党狂喜。已经订阅，就用你的站验证「全文输出不影响订阅」。', hoursAfter: 36, site: 'https://tearoom.example.com' },
  // —— why-blogging-2025 ——
  { post: 'why-blogging-2025', nick: '夜航西飞', content: '「博客不需要复兴，只需要为愿意慢下来的人保留一块自留地」——写得真好。', hoursAfter: 60 },
  { post: 'why-blogging-2025', nick: '一只北方的猫', content: '第三点深有同感，我到现在还会搜到五年前博主的教程，这次轮到我写了。', hoursAfter: 130, site: 'https://cat.example.com' },
  { post: 'why-blogging-2025', nick: '云间手记', content: '从友链点过来，这篇看完直接置顶了我的建站清单。', hoursAfter: 200, site: 'https://yunjian.example.com', pending: true },
  // —— writing-workflow ——
  { post: 'writing-workflow', nick: '效率控', content: '三级火箭设计得很清晰，问下草稿箱平均滞留时长多久？', hoursAfter: 30 },
  { post: 'writing-workflow', replyTo: 45, admin: true, nick: '阿拾', content: '快的两天，慢的半年（有几篇有生之年系列）。别有心理负担，苗圃本来就是多样性的。', hoursAfter: 38 },
  // —— zettelkasten-half-year ——
  { post: 'zettelkasten-half-year', nick: '一罐可乐', content: '「读得更慢」这个反直觉发现太对了，为了写卡片我把阅读速度主动降下来了。', hoursAfter: 70 },
  { post: 'zettelkasten-half-year', nick: '山茶', content: '编号系统那部分笑死，我曾经也给卡片编过 21/3a7，三个月后自己都看不懂。', hoursAfter: 120 },
  // —— daily-30-then-stop ——
  { post: 'daily-30-then-stop', nick: '背包客小鹿', content: '第 18 天写凑数文那段太真实了，日更的本质是选题库存测试。', hoursAfter: 50, site: 'https://lulu.example.com' },
  { post: 'daily-30-then-stop', nick: '山下的人', content: '谢谢你的诚实复盘，劝退了我即将开始的日更计划（好事）。', hoursAfter: 110, site: 'https://shanxia.example.com' },
  // —— writing-as-debugging ——
  { post: 'writing-as-debugging', nick: '代码与诗', content: '「滑过去 = 没写清 = 没想清」，这句已经写进我的自查清单。', hoursAfter: 42, site: 'https://codepoem.example.com' },
  // —— toolbox-2025 ——
  { post: 'toolbox-2025', nick: '效率控', content: '「200 天门槛」这个入选标准严格，我盘了盘自己的工具箱，能上榜的不到一半。', hoursAfter: 80 },
  // —— digital-minimalism ——
  { post: 'digital-minimalism', nick: '夜航西飞', content: '「无聊回来了」这段共鸣了，我的好多想法也是排队时冒出来的。', hoursAfter: 65 },
  { post: 'digital-minimalism', nick: 'Momo', member: 'momo', content: '短视频每天 20 分钟的诚实，比很多极简博主都真实。', hoursAfter: 140 },
  // —— rss-200-feeds ——
  { post: 'rss-200-feeds', nick: '茶水间周刊', content: '三层结构清晰，信号层用 RSSHub 做关键词监控这个用法学到了。', hoursAfter: 48, site: 'https://tearoom.example.com' },
  // —— book-in-place ——
  { post: 'book-in-place', nick: '老张的后端笔记', content: '「生产型政府」那个视角确实解释力很强，同款书单求再推几本。', hoursAfter: 90, site: 'https://laozhang.example.com' },
  { post: 'book-in-place', replyTo: 55, admin: true, nick: '阿拾', content: '延伸阅读里作者自己列了清单，按图索骥即可。下一本打算读《小镇喧嚣》。', hoursAfter: 96 },
  // —— movie-dune2 ——
  { post: 'movie-dune2', nick: '骑行与胶片', content: '「沉默比咆哮更贵」——维伦纽瓦的呼吸感确实是流媒体给不了的。', hoursAfter: 30, site: 'https://ridefilm.example.com' },
  // —— midnight-store ——
  { post: 'midnight-store', nick: '一罐可乐', content: '深夜加班归途看到这篇，鼻子一酸。便利店真的是城市的温柔。', hoursAfter: 6 },
  { post: 'midnight-store', nick: '山茶', content: '「锚不需要你每天靠岸，知道它在水底就好」，这句收藏了。', hoursAfter: 80 },
  // —— metro-observations ——
  { post: 'metro-observations', nick: '一只北方的猫', content: '空鸟笼的老爷爷是这篇的灵魂，后续有他的故事记得更新！', hoursAfter: 55, site: 'https://cat.example.com' },
  // —— balcony-garden ——
  { post: 'balcony-garden', nick: '背包客小鹿', content: '存活率 11% 还敢写总结，这份诚实值得一个赞 😂', hoursAfter: 35, site: 'https://lulu.example.com' },
  { post: 'balcony-garden', replyTo: 61, admin: true, nick: '阿拾', content: '失败史也是数据嘛，明年目标存活率 20%。', hoursAfter: 40 },
  // —— rainy-noodles ——
  { post: 'rainy-noodles', nick: '云间手记', content: '看完立刻出门觅食了。深夜面馆是城市的心跳。', hoursAfter: 20, site: 'https://yunjian.example.com' },
  // —— one-year-review ——
  { post: 'one-year-review', nick: '茶水间周刊', content: '一岁快乐！「0 元托管」这个数字本身就是最好的安利。', hoursAfter: 10, site: 'https://tearoom.example.com' },
  { post: 'one-year-review', replyTo: 64, admin: true, nick: '阿拾', content: '谢谢！第二年目标：写几篇更长的。', hoursAfter: 14 },
  { post: 'one-year-review', nick: '夜航西飞', content: '已友链，一起写满第五年。', hoursAfter: 26 },
  // —— 留言板（post_id=0, weibo_id=0）——
  { guestbook: true, nick: '一只北方的猫', content: '路过，友链已加，期待回访 🤝', hoursAfter: 2, site: 'https://cat.example.com' },
  { guestbook: true, replyTo: 68, admin: true, nick: '阿拾', content: '已回访挂上，常来玩！', hoursAfter: 8 },
  { guestbook: true, nick: 'Eric', content: 'Hello from Taipei! 你文章里的时区讲解帮到我不少，感谢分享。', hoursAfter: 960 },
  { guestbook: true, nick: '山茶', content: '连续看了三篇教程，写得真好，已加入每周必读。', hoursAfter: 1500 },
  { guestbook: true, nick: '骑行与胶片', content: '请问能交换友链吗？我的博客是关于骑行和摄影的，已经先挂上你了。', hoursAfter: 1150, site: 'https://ridefilm.example.com', pending: true },
  { guestbook: true, nick: '数字游民日志', content: '纸墨主题太太太舒服了，站在巨人的肩膀上抄了点配色思路，勿怪 😄', hoursAfter: 2700, site: 'https://nomad.example.com' },
  { guestbook: true, nick: 'XX营销', content: '你好，想谈一下广告位合作，请加微信详聊。', hoursAfter: 3400, pending: true },
  { guestbook: true, nick: '一罐可乐', content: '第一次见把「一键闭站」都做好的博客系统，细节控狂喜。', hoursAfter: 4200 },
  // —— 微博评论（weibo 序号对应 DEMO_WEIBO 下标+1） ——
  { weibo: 1, nick: '夜航西飞', content: '一岁快乐🎂 年度复盘蹲一个！', hoursAfter: 2 },
  { weibo: 1, replyTo: 76, admin: true, nick: '阿拾', content: '在写了在写了，别催哈哈哈。', hoursAfter: 3 },
  { weibo: 6, nick: '效率控', content: '套娃实锤了，定时发的教程讲定时发布。', hoursAfter: 8 },
  { weibo: 17, nick: '老张的后端笔记', content: '独立开发的蹦迪哈哈哈，精辟。', hoursAfter: 10, site: 'https://laozhang.example.com' },
  { weibo: 22, nick: '一只北方的猫', content: '深夜部署俱乐部成员前来报到。', hoursAfter: 6, site: 'https://cat.example.com' },
  { weibo: 27, nick: '云间手记', content: '读者来信是最强的正反馈，恭喜！', hoursAfter: 5, site: 'https://yunjian.example.com' },
  // —— 演示会员发言（member 字段挂 member_id，前台渲染会员徽标；放数组末尾不影响 replyTo 序号）——
  { guestbook: true, member: 'demo', nick: '体验访客', content: '用公示的演示会员账号（demo / demo1234）登录后来留言：会员卡、积分、排行榜都能玩，会员专享文章也能解锁，体验很完整 👍', hoursAfter: 5000 },
]

export interface DemoLink {
  name: string
  url: string
  description: string
  icon: string
  status: 'approved' | 'pending'
  sort: number
  source: 'admin' | 'user'
  ip: string
  daysAgo: number
}

export const DEMO_LINKS: DemoLink[] = [
  { name: '云间手记', url: 'https://yunjian.example.com', description: '写代码，也写城市观察', icon: '', status: 'approved', sort: 0, source: 'admin', ip: '', daysAgo: 330 },
  { name: '深夜书房', url: 'https://nightbook.example.com', description: '读书、做书、聊出版', icon: '', status: 'approved', sort: 0, source: 'admin', ip: '', daysAgo: 300 },
  { name: '代码与诗', url: 'https://codepoem.example.com', description: '程序员的文艺复兴', icon: '', status: 'approved', sort: 0, source: 'admin', ip: '', daysAgo: 268 },
  { name: '一只北方的猫', url: 'https://cat.example.com', description: '吸猫、做饭、写随笔', icon: '', status: 'approved', sort: 0, source: 'admin', ip: '', daysAgo: 210 },
  { name: '老张的后端笔记', url: 'https://laozhang.example.com', description: '后端技术与踩坑实录', icon: '', status: 'approved', sort: 0, source: 'admin', ip: '', daysAgo: 188 },
  { name: '数字游民日志', url: 'https://nomad.example.com', description: '边走边写的工作方式', icon: '', status: 'approved', sort: 0, source: 'admin', ip: '', daysAgo: 150 },
  { name: '茶水间周刊', url: 'https://tearoom.example.com', description: '每周一封的科技圈简报', icon: '', status: 'approved', sort: 0, source: 'admin', ip: '', daysAgo: 96 },
  { name: '骑行与胶片', url: 'https://ridefilm.example.com', description: '骑行摄影双修，常年在外', icon: '', status: 'approved', sort: 0, source: 'admin', ip: '', daysAgo: 44 },
  { name: '山下的人', url: 'https://shanxia.example.com', description: '常来常往，申请交换友链', icon: '', status: 'pending', sort: 0, source: 'user', ip: '', daysAgo: 5 },
  { name: 'XX营销', url: 'https://promo.example.com', description: '专业推广合作，量大优惠', icon: '', status: 'pending', sort: 0, source: 'user', ip: '', daysAgo: 2 },
]

export interface DemoPage {
  title: string
  slug: string
  content: string
  status: 'published'
  showInNav: number
  sort: number
  daysAgo: number
}

const ABOUT_HTML = `<p>你好，我是<strong>阿拾</strong>——一个白天写代码、晚上写字的普通人。这里是我在 Cloudflare 上的小书房，住着 50 多篇文章、180 多条随手记，和一只不出镜的猫。</p><h2>这个站</h2><ul><li>它由开源博客系统<strong>博客号 BlogHao</strong> 驱动，整套架构跑在 Cloudflare 免费额度上：Workers 渲染、D1 存文字、R2 存图片</li><li>内容主要是<strong>建站折腾、写作心得、数字生活</strong>，偶尔写写读书观影和深夜的面馆</li><li>站内微博页是碎片想法的收容所，欢迎在留言板找我玩</li></ul><blockquote>注：你正在看的是博客号的<strong>演示体验版</strong>（非最新正式版，仅供测试体验）——后台账号公示在登录页，会员演示账号 <code>demo</code> / <code>demo1234</code>，数据每 2 小时自动清空重置。随便看，随便玩。</blockquote><h2>联系我</h2><p>评论区和留言板回复最快；也可以通过友链页去串门我朋友们的书房。</p><p>—— 阿拾</p>`

export const DEMO_PAGES: DemoPage[] = [
  {
    title: '书单',
    slug: 'books',
    status: 'published',
    showInNav: 1,
    sort: 10,
    daysAgo: 140,
    content: `<p>今年在读与读完的书。打勾的是读完的，划线的是弃了的（弃书也是阅读决策）。</p><table><thead><tr><th>书名</th><th>状态</th><th>一句话短评</th></tr></thead><tbody><tr><td>《置身事内》</td><td>✅ 读完</td><td>理解中国经济的入门地图</td></tr><tr><td>《翦商》</td><td>✅ 读完</td><td>后背发凉但停不下来</td></tr><tr><td>《卡拉马佐夫兄弟》</td><td>⏳ 在读</td><td>读到 40%，需要缓一缓再继续</td></tr><tr><td>《卡片笔记写作法》</td><td>✅ 读完</td><td>方法论一半，仪式感劝退一半</td></tr><tr><td>《纳瓦尔宝典》</td><td>❌ 弃</td><td>金句密度过高，像朋友圈合集</td></tr><tr><td>《数字极简》</td><td>✅ 读完</td><td>促成我一场持续一年的大扫除</td></tr><tr><td>《沙丘》</td><td>⏳ 在读</td><td>电影看完回来补原著</td></tr></tbody></table><details open><summary>计划中</summary><ul><li>《小镇喧嚣》（《置身事内》延伸阅读）</li><li>《翦商》作者另一本《mbH 西周的灭亡》——先记着书名，去查准确版本</li></ul></details>`,
  },
  {
    title: '装备清单',
    slug: 'gear',
    status: 'published',
    showInNav: 1,
    sort: 20,
    daysAgo: 133,
    content: `<p>常被问「你用什么」，统一记录在此。原则：<strong>只列用了超过 200 天的</strong>。</p><h2>写码与写作</h2><ul><li>键盘：HHKB Professional 2（静电容，五年老伙伴）</li><li>显示器：27 寸 4K 一台，够了</li><li>椅子：某国产人体工学，腰托是本体</li><li>写作：Obsidian（素材）+ 博客号编辑器（发布）</li></ul><h2>随身</h2><ul><li>手机：用了两年的主力机，相机是它最常用的功能</li><li> Kindle：吃灰半年后重新启用了，通勤神器</li><li>背包：22L 两仓，装下「电脑 + 一本书 + 一把伞」的哲学容量</li></ul><h2>网络与托管</h2><ul><li>博客：Cloudflare Workers + D1 + R2（全免费档）</li><li>域名：一家老牌注册商，续费不涨价的那种</li><li>监控：GitHub Actions 上的一个小定时任务</li></ul>`,
  },
  {
    title: '关于我',
    slug: 'about',
    status: 'published',
    showInNav: 1,
    sort: 90,
    daysAgo: 360,
    content: ABOUT_HTML,
  },
]

/** settings 全量种子：DEFAULT_SETTINGS 之上叠演示站人设（demo.ts 落库） */
export const DEMO_SETTINGS: Record<string, string> = {
  siteName: '拾光小筑',
  siteDescription: '博客号 BlogHao 演示体验版（非最新正式版，仅供测试体验）· 数据每 2 小时自动清空重置，随便看随便玩',
  theme: 'paper',
  siteUrl: '',
  postsPerPage: '8',
  moderateComments: '1',
  allowComments: '1',
  backupEnabled: '0',
  statsEnabled: '1',
  rssFullText: '1',
  notifyNewComment: '1',
  about: ABOUT_HTML,
  pagesSeeded: '1',
  // 会员体系开到「开」：会员卡 / 积分 / 排行榜 / 会员专享文都在体验范围内（demo.ts 播种演示会员）
  membersEnabled: '1',
}

export const DEMO_CATEGORIES: { name: string; slug: string; sort: number }[] = [
  { name: '建站折腾', slug: 'tech', sort: 10 },
  { name: '写作心得', slug: 'writing', sort: 20 },
  { name: '数字生活', slug: 'digital', sort: 30 },
  { name: '读书观影', slug: 'culture', sort: 40 },
  { name: '随笔', slug: 'essay', sort: 50 },
]

export const DEMO_ADMIN = { username: 'demo', password: 'demo1234', displayName: '阿拾' }

/* ---------------- 演示会员（会员体系演示：会员卡 / 积分 / 排行榜 / 徽标） ----------------
 * username 'demo' 是公示账号（会员登录页/关于页注明 demo / demo1234），其余会员是背景板；
 * 积分账本不手写明细，由 buildDemoPlan 按 dailyLogins/comments/adminAdjust 确定性展开，
 * 余额 = 明细合计（tests/demo.test.ts 守着，不会漂移）。 */

export interface DemoMember {
  username: string
  password: string
  displayName: string
  tier: 'normal' | 'coffee' | 'top'
  createdDaysAgo: number
  dailyLogins: number
  comments: number
  adminAdjust?: number
}

export const DEMO_MEMBERS: DemoMember[] = [
  { username: 'demo', password: 'demo1234', displayName: '体验访客', tier: 'normal', createdDaysAgo: 30, dailyLogins: 4, comments: 6 },
  { username: 'momo', password: 'momo-demo-2026', displayName: 'Momo', tier: 'coffee', createdDaysAgo: 150, dailyLogins: 7, comments: 9, adminAdjust: 5 },
]

/* ---------------- 计划组装 ---------------- */

export interface PlannedPost {
  slug: string
  title: string
  summary: string
  content: string
  cover: string
  tags: string
  status: 'published' | 'draft' | 'scheduled'
  pinned: number
  views: number
  likes: number
  cat: string
  /** 可见档位（posts.min_tier）：'all' = 所有人，'member'/'coffee'/'top' = 付费墙演示 */
  minTier: string
  /** 访问密码明文（demo.ts 落库前 hash 成 salt:hash，种子里可读是为了公示演示密码） */
  password?: string
  createdAt: number
  updatedAt: number
  publishedAt: number | null
  publishAt: number | null
}

export interface PlannedWeibo {
  content: string
  images: string
  topics: string
  status: 'published' | 'draft'
  pinned: number
  likes: number
  createdAt: number
  updatedAt: number
  publishedAt: number | null
}

export interface PlannedComment {
  postId: number
  weiboId: number
  parentId: number
  isAdmin: number
  /** 会员身份（members.id，0 = 游客）：前台评论列表 LEFT JOIN members 带徽标 */
  memberId: number
  nickname: string
  website: string
  content: string
  status: 'approved' | 'pending'
  createdAt: number
}

export interface PlannedMemberLog {
  delta: number
  reason: 'comment' | 'dailyLogin' | 'adminAdjust'
  note: string
  createdAt: number
}

export interface PlannedMember {
  username: string
  password: string
  displayName: string
  tier: 'normal' | 'coffee' | 'top'
  /** 积分余额 = log 明细合计（确定性展开，tests 守着不漂移） */
  points: number
  createdAt: number
  log: PlannedMemberLog[]
}

export interface PlannedVisit {
  ts: number
  day: string
  vid: string
  path: string
  title: string
  ref: string
  dev: string
  br: string
  country: string
}

export interface DemoPlan {
  posts: PlannedPost[]
  weibo: PlannedWeibo[]
  comments: PlannedComment[]
  links: (Omit<DemoLink, 'daysAgo'> & { createdAt: number; updatedAt: number })[]
  pages: (Omit<DemoPage, 'daysAgo'> & { createdAt: number; updatedAt: number })[]
  categories: { name: string; slug: string; sort: number }[]
  tags: string[]
  settings: Record<string, string>
  visits: PlannedVisit[]
  members: PlannedMember[]
  admin: typeof DEMO_ADMIN
}

function extractTopics(content: string): string[] {
  return [...content.matchAll(/#([^#\s]{1,20})#/g)].map((m) => m[1]).slice(0, 3)
}

function pickWeighted<T>(rng: () => number, items: [T, number][]): T {
  const total = items.reduce((s, [, w]) => s + w, 0)
  let r = rng() * total
  for (const [item, w] of items) {
    r -= w
    if (r <= 0) return item
  }
  return items[items.length - 1][0]
}

const hex = (rng: () => number, n: number) =>
  Array.from({ length: n }, () => '0123456789abcdef'[Math.floor(rng() * 16)]).join('')

/** 组装完整种子计划（纯函数，确定性输出） */
export function buildDemoPlan(now: number): DemoPlan {
  const rng = mulberry32(20261005)
  const minute = () => Math.floor(rng() * 60)

  const posts: PlannedPost[] = DEMO_POSTS.map((p) => {
    const ts = daysAgoAt(now, p.daysAgo ?? 0, p.hour ?? 20, minute())
    const status: PlannedPost['status'] = p.draft ? 'draft' : p.scheduledInHours ? 'scheduled' : 'published'
    return {
      slug: p.slug,
      title: p.title,
      summary: p.summary,
      content: p.content,
      cover: p.cover ? `/images/u/demo/${p.cover}.svg` : '',
      tags: JSON.stringify(p.tags),
      status,
      pinned: p.pinned ?? 0,
      views: p.views,
      likes: p.likes,
      cat: p.cat,
      minTier: p.minTier ?? 'all',
      password: p.password,
      createdAt: ts,
      updatedAt: ts,
      publishedAt: status === 'published' ? ts : null,
      publishAt: status === 'scheduled' ? now + (p.scheduledInHours ?? 24) * 3_600_000 : null,
    }
  })

  const weibo: PlannedWeibo[] = DEMO_WEIBO.map((w) => {
    const ts = daysAgoAt(now, w.daysAgo, w.hour, minute())
    return {
      content: w.content,
      images: JSON.stringify(w.images.map((n) => `/images/u/demo/${n}.svg`)),
      topics: JSON.stringify(extractTopics(w.content)),
      status: w.draft ? 'draft' : 'published',
      pinned: w.pinned ?? 0,
      likes: w.likes,
      createdAt: ts,
      updatedAt: ts,
      publishedAt: w.draft ? null : ts,
    }
  })

  // 评论的目标时间：文章 publishedAt / 微博 publishedAt / 留言板以固定锚点为基准
  const guestbookAnchor = daysAgoAt(now, 240, 12, 0)
  const postTs = new Map(posts.map((p) => [p.slug, p.publishedAt ?? p.createdAt]))
  const weiboTs = new Map(weibo.map((w, i) => [i + 1, w.publishedAt ?? w.createdAt]))
  const comments: PlannedComment[] = []
  // tsByIndex 与 DEMO_COMMENTS 严格同序（缺 anchor 的条目也占位），保证 replyTo 索引稳定
  const tsByIndex: number[] = []
  DEMO_COMMENTS.forEach((c, i) => {
    const anchor = c.post ? postTs.get(c.post) : c.weibo ? weiboTs.get(c.weibo) : guestbookAnchor
    const parentTs = c.replyTo ? tsByIndex[c.replyTo - 1] : undefined
    if (anchor === undefined) {
      tsByIndex[i] = now
      return
    }
    // 回复的落点不得早于被回复者
    const base = Math.max(anchor, parentTs ?? 0)
    let ts = base + c.hoursAfter * 3_600_000 + Math.floor(rng() * 55) * 60_000
    if (ts > now - 10 * 60_000) ts = now - 10 * 60_000 - Math.floor(rng() * 40) * 60_000
    tsByIndex[i] = ts
    comments.push({
      postId: c.post ? posts.findIndex((p) => p.slug === c.post) + 1 : 0,
      weiboId: c.weibo ?? 0,
      parentId: c.replyTo ?? 0,
      isAdmin: c.admin ? 1 : 0,
      memberId: c.member ? DEMO_MEMBERS.findIndex((m) => m.username === c.member) + 1 : 0,
      nickname: c.nick,
      website: c.site ?? '',
      content: c.content,
      status: c.pending ? 'pending' : 'approved',
      createdAt: ts,
    })
  })

  const links = DEMO_LINKS.map((l) => {
    const ts = daysAgoAt(now, l.daysAgo, 14, minute())
    return { name: l.name, url: l.url, description: l.description, status: l.status, source: l.source, icon: '', sort: 0, ip: '', createdAt: ts, updatedAt: ts }
  })

  const pages = DEMO_PAGES.map((p) => {
    const ts = daysAgoAt(now, p.daysAgo, 16, minute())
    return { title: p.title, slug: p.slug, content: p.content, status: 'published' as const, showInNav: p.showInNav, sort: p.sort, createdAt: ts, updatedAt: ts }
  })

  const tagSet: string[] = []
  for (const p of DEMO_POSTS) for (const t of p.tags) if (!tagSet.includes(t)) tagSet.push(t)

  // 会员与积分账本（确定性展开）：登录每日 +1、评论 +2、可选一次管理员调整；
  // 落库序 = 数组序（demo.ts 播种前重置自增，members.id = 下标 + 1，评论按此引用）
  const members: PlannedMember[] = DEMO_MEMBERS.map((m, mi) => {
    const log: PlannedMemberLog[] = []
    for (let i = 0; i < m.dailyLogins; i++) {
      log.push({ delta: 1, reason: 'dailyLogin', note: '', createdAt: daysAgoAt(now, i + 1, 9, (mi * 13 + i * 7) % 60) })
    }
    for (let i = 0; i < m.comments; i++) {
      log.push({ delta: 2, reason: 'comment', note: '', createdAt: daysAgoAt(now, i * 2 + 1, 20, (mi * 29 + i * 11) % 60) })
    }
    if (m.adminAdjust) {
      log.push({ delta: m.adminAdjust, reason: 'adminAdjust', note: '后台调整（演示数据）', createdAt: daysAgoAt(now, Math.min(m.createdDaysAgo - 1, 12), 15, (mi * 17) % 60) })
    }
    log.sort((a, b) => a.createdAt - b.createdAt)
    return {
      username: m.username,
      password: m.password,
      displayName: m.displayName,
      tier: m.tier,
      points: log.reduce((s, r) => s + r.delta, 0),
      createdAt: daysAgoAt(now, m.createdDaysAgo, 10, (mi * 23) % 60),
      log,
    }
  })

  const visits = buildVisitRows(now, rng)

  return {
    posts,
    weibo,
    comments,
    links,
    pages,
    categories: DEMO_CATEGORIES,
    tags: tagSet,
    settings: DEMO_SETTINGS,
    visits,
    members,
    admin: DEMO_ADMIN,
  }
}

/* ---------------- 访客统计种子 ---------------- */

const VISIT_PATHS: [string, number][] = [
  ['/', 26],
  ['__post__', 48],
  ['/weibo', 8],
  ['/archives', 6],
  ['/guestbook', 5],
  ['/links', 4],
  ['/page/books', 3],
]

const VISIT_REFS: [string, number][] = [
  ['', 44],
  ['www.baidu.com', 18],
  ['bing.com', 12],
  ['www.google.com', 9],
  ['github.com', 8],
  ['sspai.com', 4],
  ['v2ex.com', 5],
]

const VISIT_DEV: [string, number][] = [
  ['mobile', 52],
  ['desktop', 43],
  ['tablet', 5],
]

const VISIT_BR: [string, number][] = [
  ['chrome', 38],
  ['wechat', 26],
  ['edge', 13],
  ['safari', 13],
  ['firefox', 6],
  ['other', 4],
]

const VISIT_COUNTRY: [string, number][] = [
  ['CN', 93],
  ['HK', 2],
  ['US', 2],
  ['SG', 1],
  ['JP', 1],
  ['OTHER', 1],
]

/** 最近 60 天的访客日志：工作日高周末低、缓慢增长、偶发小高峰，让后台统计页有真实脉搏 */
export function buildVisitRows(now: number, rng: () => number, slugs?: { slug: string; title: string }[]): PlannedVisit[] {
  const published = slugs ?? DEMO_POSTS.filter((p) => !p.draft && !p.scheduledInHours).map((p) => ({ slug: p.slug, title: p.title }))
  const siteName = DEMO_SETTINGS.siteName
  const rows: PlannedVisit[] = []
  const days = 60
  for (let d = days - 1; d >= 0; d--) {
    const dayStart = now - d * 86_400_000
    const bj = new Date(dayStart + 8 * 3_600_000)
    const weekday = bj.getUTCDay()
    const weekdayFactor = weekday === 0 || weekday === 6 ? 0.72 : weekday === 1 ? 1.0 : 1.14
    const growth = 0.62 + 0.38 * ((days - 1 - d) / (days - 1))
    // 两个小高峰：某篇教程被转发的日子 + 年度复盘发布日
    const spike = d === 30 ? 1.45 : d === 3 ? 1.3 : 1
    const isToday = d === 0
    const elapsed = isToday ? Math.min(0.95, ((now + 8 * 3_600_000) % 86_400_000) / 86_400_000) : 1
    // 今天的 PV 有下限：北京时间零点后 elapsed≈0，纯乘法会四舍五入成 0，后台「今日 PV」开天窗
    const pv = Math.max(isToday ? 3 : 0, Math.round((26 + 34 * rng()) * weekdayFactor * growth * spike * elapsed))
    for (let i = 0; i < pv; i++) {
      // 访问时间偏向白天与晚间（北京时间 8-24 点），今天的不能越过 now
      const hourBias = pickWeighted(rng, [
        [8, 6], [10, 10], [12, 12], [14, 11], [16, 10], [19, 13], [21, 18], [23, 14],
      ])
      let ts = daysAgoAt(now, d, hourBias, Math.floor(rng() * 60))
      if (isToday && ts > now - 60_000) ts = now - 60_000 - Math.floor(rng() * 3_600_000 * elapsed)
      if (isToday) {
        // 北京零点后第一分钟里 now-60_000 仍在前一天：今天的访问必须钳回今日零点后，
        // 否则这 3 条全落昨天——60 天少一天、后台「今日 PV」开天窗
        const bjDayStart = now - ((now + 8 * 3_600_000) % 86_400_000)
        if (ts < bjDayStart) ts = bjDayStart + Math.floor(rng() * Math.max(1, now - bjDayStart))
      }
      const target = pickWeighted(rng, VISIT_PATHS)
      const isPost = target === '__post__'
      const post = published[Math.floor(rng() * published.length)]
      const path = isPost ? `/post/${post.slug}` : (target as string)
      const title = isPost ? `${post.title} - ${siteName}` : `${siteName}`
      rows.push({
        ts,
        day: fmtDate(ts),
        vid: hex(rng, 10),
        path,
        title,
        ref: pickWeighted(rng, VISIT_REFS),
        dev: pickWeighted(rng, VISIT_DEV),
        br: pickWeighted(rng, VISIT_BR),
        country: pickWeighted(rng, VISIT_COUNTRY),
      })
    }
  }
  return rows
}
