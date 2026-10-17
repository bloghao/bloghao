import { test } from 'node:test'
import assert from 'node:assert/strict'
import { ipRegionLabel, regionCodeOfCf, regionSnapshot } from '../src/ipregion.ts'
import { commentsHtml } from '../src/render.ts'
import { DEFAULT_SETTINGS } from '../src/db.ts'

// 评论 IP 属地（src/ipregion.ts，settings.showCommentRegion 默认关）：
// 采集端 regionCodeOfCf 只在写库瞬间跑一次（定格快照码），展示端 ipRegionLabel 是唯一
// 格式化出口——三处消费：SSR commentsHtml / 微博评论 JSON（api.ts 服务端换算）/ 后台列表。

const TS = 1_700_000_000_000
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
  created_at: TS,
  ip_region: 'CN:Guangdong',
  ...over,
})

test('regionCodeOfCf：国内省级行程 / 国外裸码 / 未知与 Tor 不采集', () => {
  assert.equal(regionCodeOfCf({ country: 'CN', region: 'Guangdong' }), 'CN:Guangdong')
  assert.equal(regionCodeOfCf({ country: 'cn', region: 'Beijing' }), 'CN:Beijing', 'country 大小写归一')
  assert.equal(regionCodeOfCf({ country: 'cn' }), 'CN', '无 region 的国内只存国家码')
  assert.equal(regionCodeOfCf({ country: 'US', region: 'California' }), 'US:California')
  assert.equal(regionCodeOfCf({ country: 'HK' }), 'HK')
  assert.equal(regionCodeOfCf({ country: 'XX' }), '', 'XX = CF 未知，不采集')
  assert.equal(regionCodeOfCf({ country: 'T1' }), '', 'T1 = Tor 出口，不采集')
  assert.equal(regionCodeOfCf({ country: 'USA' }), '', '非 ISO 两码不采集')
  assert.equal(regionCodeOfCf(undefined), '')
  assert.equal(regionCodeOfCf({}), '')
  assert.equal(regionCodeOfCf({ country: 'US', region: undefined }), 'US')
  // region 脏字符收敛：MaxMind 只出 ASCII 地名，防脏值原样落库（<>/ 等替换成空格，<> 打不出标签）
  assert.equal(regionCodeOfCf({ country: 'CN', region: 'Guang<script>xi' }), 'CN:Guang script xi')
  assert.equal(regionCodeOfCf({ country: 'CN', region: 'A'.repeat(80) }).length, 'CN:'.length + 60, '超长地名截到 60')
})

test('ipRegionLabel：国内到省 / 国外到国家 / 港澳台按国家码 / 未收录回退', () => {
  assert.equal(ipRegionLabel('CN:Guangdong'), '广东')
  assert.equal(ipRegionLabel('CN:Nei Mongol'), '内蒙古')
  assert.equal(ipRegionLabel('CN:Xizang'), '西藏')
  assert.equal(ipRegionLabel('CN:Someplace New'), '中国', 'CN 未收录地名回中国')
  assert.equal(ipRegionLabel('CN'), '中国')
  assert.equal(ipRegionLabel('US:California'), '美国')
  assert.equal(ipRegionLabel('HK'), '香港')
  assert.equal(ipRegionLabel('TW:Taiwan'), '台湾')
  assert.equal(ipRegionLabel('MO'), '澳门')
  assert.equal(ipRegionLabel('JP:Tokyo'), '日本')
  assert.equal(ipRegionLabel('KZ'), '哈萨克斯坦')
  assert.equal(ipRegionLabel('QQ'), '海外', '未收录非中国回海外（永远为真）')
  assert.equal(ipRegionLabel(''), '')
  // 脏码不透传：未知形态一律收敛成既定标签，不会被当成文本拼进 HTML
  assert.equal(ipRegionLabel('<img src=x>'), '海外')
  // 英文版：国内出 cf 原文地名、国外出英文国名、未收录回退链 地名 → ISO 码
  assert.equal(ipRegionLabel('CN:Guangdong', true), 'Guangdong')
  assert.equal(ipRegionLabel('CN', true), 'China')
  assert.equal(ipRegionLabel('US:California', true), 'United States')
  assert.equal(ipRegionLabel('KZ:Almaty', true), 'Almaty', 'EN 未收录国回地名')
  assert.equal(ipRegionLabel('KZ', true), 'KZ', 'EN 无地名再退 ISO 码')
})

test('regionSnapshot：Node 请求无 cf 得空串（自托管 / 测试形态不展示，宁缺毋假）', () => {
  assert.equal(regionSnapshot(new Request('https://x.test/')), '')
})

test('commentsHtml：showRegion 门控属地小灰字与表单披露，关 = 字节级不出现', () => {
  const base = { slug: 'hello', allowComments: true, count: 1 }
  const on = commentsHtml({ ...base, comments: [row()], showRegion: true })
  assert.match(on, /cmt-region"[^>]*>广东</, '开启时渲染属地小灰字')
  assert.ok(on.includes('发布后将显示 IP 属地'), '开启时表单披露属地展示')
  const off = commentsHtml({ ...base, comments: [row()] })
  assert.ok(!off.includes('cmt-region'), '默认关：不渲染属地')
  assert.ok(!off.includes('IP 属地'), '默认关：表单不披露')
  // 开启但评论无快照（开关开启前的旧评论 / 自托管）不渲染，不占位
  const legacy = commentsHtml({ ...base, comments: [row({ ip_region: '' })], showRegion: true })
  assert.ok(!legacy.includes('cmt-region'))
  // 披露拼在审核提示之后（两态共存时的完整提示行）
  const pending = commentsHtml({ slug: 's', allowComments: true, count: 0, comments: [], showRegion: true, tip: '提交后审核通过即展示' })
  assert.ok(pending.includes('提交后审核通过即展示 · 发布后将显示 IP 属地'))
})

test('默认关：DEFAULT_SETTINGS.showCommentRegion = 0（中文路径上线字节级不变）', () => {
  assert.equal(DEFAULT_SETTINGS.showCommentRegion, '0')
})
