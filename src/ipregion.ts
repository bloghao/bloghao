/**
 * 评论 IP 属地（默认关，settings.showCommentRegion 门控展示）。
 *
 * 数据来自 Cloudflare 请求自带的 request.cf（MaxMind 地理库，免费、零外部调用）——
 * 写库瞬间定格成一个快照码（`CN:Guangdong` / `US` / `HK`），展示期由 ipRegionLabel
 * 出标签。**渲染端永远不做 IP 反查**（Workers 没有按 IP 查库的能力，也不引第三方 IP 库）。
 *
 * 口径（对齐国内平台「IP 属地」惯例）：国内到省（cf.region 的 MaxMind 英文地名映射中文省名）、
 * 国外到国家（ISO 码映射中文国名）、港澳台按 country 码（CF 视作独立国家）；T1（Tor 出口）与
 * XX（未知）不采集；未收录国家回「海外」（非中国即海外，永远为真）。英文版国外显示英文国名，
 * 未收录回退 cf.region 原文 / ISO 码。
 *
 * 预期与限制（诚实的口径）：① 开启前已存的评论无属地，不追溯回填（对存量 ip 反查要引外部库，
 * 且拿今天的库查过去的 IP 也不准）；② 自托管 docker（无 request.cf）与演示种子恒空串不显示，
 * 宁缺毋假；③ 属地是出口 IP 的属地，代理 / VPN 可绕——与所有平台同款原理性限制。
 */

/** Workers request.cf 中本模块关心的两个字段（Node / docker 无 cf，恒 undefined） */
export interface CfGeo {
  country?: string
  region?: string
}

/** cf.region 是 MaxMind 英文地名：收录全部省级行政区的常见写法（自治区带别名），查不到回退「中国」 */
const CN_REGIONS: Record<string, string> = {
  Beijing: '北京',
  Shanghai: '上海',
  Tianjin: '天津',
  Chongqing: '重庆',
  Hebei: '河北',
  Shanxi: '山西',
  Liaoning: '辽宁',
  Jilin: '吉林',
  Heilongjiang: '黑龙江',
  Jiangsu: '江苏',
  Zhejiang: '浙江',
  Anhui: '安徽',
  Fujian: '福建',
  Jiangxi: '江西',
  Shandong: '山东',
  Henan: '河南',
  Hubei: '湖北',
  Hunan: '湖南',
  Guangdong: '广东',
  Guangxi: '广西',
  'Guangxi Zhuangzu': '广西',
  'Guangxi Zhuangzu Zizhiqu': '广西',
  Hainan: '海南',
  Sichuan: '四川',
  Guizhou: '贵州',
  Yunnan: '云南',
  Shaanxi: '陕西',
  Gansu: '甘肃',
  Qinghai: '青海',
  Ningxia: '宁夏',
  'Ningxia Huizu': '宁夏',
  'Ningxia Huizu Zizhiqu': '宁夏',
  Xinjiang: '新疆',
  'Xinjiang Uygur': '新疆',
  'Xinjiang Uygur Zizhiqu': '新疆',
  Xizang: '西藏',
  Tibet: '西藏',
  'Nei Mongol': '内蒙古',
  'Inner Mongolia': '内蒙古',
  'Hong Kong': '香港',
  Macau: '澳门',
  Macao: '澳门',
  Taiwan: '台湾',
}

/** ISO 3166-1 alpha-2 → 中文国名（港澳台在内；CN 走省级行程不进本表） */
const COUNTRY_ZH: Record<string, string> = {
  AE: '阿联酋',
  AF: '阿富汗',
  AL: '阿尔巴尼亚',
  AM: '亚美尼亚',
  AO: '安哥拉',
  AR: '阿根廷',
  AT: '奥地利',
  AU: '澳大利亚',
  AZ: '阿塞拜疆',
  BA: '波黑',
  BD: '孟加拉国',
  BE: '比利时',
  BF: '布基纳法索',
  BG: '保加利亚',
  BH: '巴林',
  BI: '布隆迪',
  BN: '文莱',
  BO: '玻利维亚',
  BR: '巴西',
  BS: '巴哈马',
  BT: '不丹',
  BW: '博茨瓦纳',
  BY: '白俄罗斯',
  BZ: '伯利兹',
  CA: '加拿大',
  CD: '刚果（金）',
  CF: '中非',
  CG: '刚果（布）',
  CH: '瑞士',
  CI: '科特迪瓦',
  CL: '智利',
  CM: '喀麦隆',
  CO: '哥伦比亚',
  CR: '哥斯达黎加',
  CU: '古巴',
  CY: '塞浦路斯',
  CZ: '捷克',
  DE: '德国',
  DJ: '吉布提',
  DK: '丹麦',
  DO: '多米尼加',
  DZ: '阿尔及利亚',
  EC: '厄瓜多尔',
  EE: '爱沙尼亚',
  EG: '埃及',
  ER: '厄立特里亚',
  ES: '西班牙',
  ET: '埃塞俄比亚',
  FI: '芬兰',
  FJ: '斐济',
  FM: '密克罗尼西亚',
  FO: '法罗群岛',
  FR: '法国',
  GA: '加蓬',
  GB: '英国',
  GD: '格林纳达',
  GE: '格鲁吉亚',
  GH: '加纳',
  GI: '直布罗陀',
  GL: '格陵兰',
  GM: '冈比亚',
  GN: '几内亚',
  GQ: '赤道几内亚',
  GR: '希腊',
  GT: '危地马拉',
  GU: '关岛',
  GY: '圭亚那',
  HK: '香港',
  HN: '洪都拉斯',
  HR: '克罗地亚',
  HT: '海地',
  HU: '匈牙利',
  ID: '印度尼西亚',
  IE: '爱尔兰',
  IL: '以色列',
  IM: '马恩岛',
  IN: '印度',
  IQ: '伊拉克',
  IR: '伊朗',
  IS: '冰岛',
  IT: '意大利',
  JE: '泽西岛',
  JM: '牙买加',
  JO: '约旦',
  JP: '日本',
  KE: '肯尼亚',
  KG: '吉尔吉斯斯坦',
  KH: '柬埔寨',
  KP: '朝鲜',
  KR: '韩国',
  KW: '科威特',
  KZ: '哈萨克斯坦',
  LA: '老挝',
  LB: '黎巴嫩',
  LI: '列支敦士登',
  LK: '斯里兰卡',
  LR: '利比里亚',
  LT: '立陶宛',
  LU: '卢森堡',
  LV: '拉脱维亚',
  LY: '利比亚',
  MA: '摩洛哥',
  MC: '摩纳哥',
  MD: '摩尔多瓦',
  ME: '黑山',
  MG: '马达加斯加',
  MK: '北马其顿',
  ML: '马里',
  MM: '缅甸',
  MN: '蒙古',
  MO: '澳门',
  MR: '毛里塔尼亚',
  MT: '马耳他',
  MU: '毛里求斯',
  MV: '马尔代夫',
  MW: '马拉维',
  MX: '墨西哥',
  MY: '马来西亚',
  MZ: '莫桑比克',
  NA: '纳米比亚',
  NE: '尼日尔',
  NG: '尼日利亚',
  NI: '尼加拉瓜',
  NL: '荷兰',
  NO: '挪威',
  NP: '尼泊尔',
  NZ: '新西兰',
  OM: '阿曼',
  PA: '巴拿马',
  PE: '秘鲁',
  PG: '巴布亚新几内亚',
  PH: '菲律宾',
  PK: '巴基斯坦',
  PL: '波兰',
  PR: '波多黎各',
  PS: '巴勒斯坦',
  PT: '葡萄牙',
  PY: '巴拉圭',
  QA: '卡塔尔',
  RO: '罗马尼亚',
  RS: '塞尔维亚',
  RU: '俄罗斯',
  RW: '卢旺达',
  SA: '沙特阿拉伯',
  SC: '塞舌尔',
  SD: '苏丹',
  SE: '瑞典',
  SG: '新加坡',
  SI: '斯洛文尼亚',
  SK: '斯洛伐克',
  SL: '塞拉利昂',
  SM: '圣马力诺',
  SN: '塞内加尔',
  SO: '索马里',
  SR: '苏里南',
  SV: '萨尔瓦多',
  SY: '叙利亚',
  TD: '乍得',
  TG: '多哥',
  TH: '泰国',
  TJ: '塔吉克斯坦',
  TL: '东帝汶',
  TM: '土库曼斯坦',
  TN: '突尼斯',
  TO: '汤加',
  TR: '土耳其',
  TT: '特立尼达和多巴哥',
  TW: '台湾',
  TZ: '坦桑尼亚',
  UA: '乌克兰',
  UG: '乌干达',
  US: '美国',
  UY: '乌拉圭',
  UZ: '乌兹别克斯坦',
  VA: '梵蒂冈',
  VE: '委内瑞拉',
  VG: '英属维尔京群岛',
  VI: '美属维尔京群岛',
  VN: '越南',
  VU: '瓦努阿图',
  WS: '萨摩亚',
  YE: '也门',
  ZA: '南非',
  ZM: '赞比亚',
  ZW: '津巴布韦',
}

/** 英文版常用国名（内部测试版够用即可）：未收录回退 cf.region 原文，再退 ISO 码 */
const COUNTRY_EN: Record<string, string> = {
  AR: 'Argentina',
  AT: 'Austria',
  AU: 'Australia',
  BE: 'Belgium',
  BR: 'Brazil',
  CA: 'Canada',
  CH: 'Switzerland',
  CL: 'Chile',
  CO: 'Colombia',
  CZ: 'Czechia',
  DE: 'Germany',
  DK: 'Denmark',
  EG: 'Egypt',
  ES: 'Spain',
  FI: 'Finland',
  FR: 'France',
  GB: 'United Kingdom',
  GR: 'Greece',
  HK: 'Hong Kong',
  ID: 'Indonesia',
  IE: 'Ireland',
  IL: 'Israel',
  IN: 'India',
  IT: 'Italy',
  JP: 'Japan',
  KE: 'Kenya',
  KR: 'South Korea',
  MO: 'Macao',
  MX: 'Mexico',
  MY: 'Malaysia',
  NG: 'Nigeria',
  NL: 'Netherlands',
  NO: 'Norway',
  NZ: 'New Zealand',
  PE: 'Peru',
  PH: 'Philippines',
  PL: 'Poland',
  PT: 'Portugal',
  RO: 'Romania',
  RU: 'Russia',
  SA: 'Saudi Arabia',
  SE: 'Sweden',
  SG: 'Singapore',
  TH: 'Thailand',
  TR: 'Turkey',
  TW: 'Taiwan',
  UA: 'Ukraine',
  US: 'United States',
  VN: 'Vietnam',
  ZA: 'South Africa',
}

const hasOwn = (o: Record<string, string>, k: string) => Object.prototype.hasOwnProperty.call(o, k)

/** cf.region 只可能是 ASCII 地名（异常值当没采集到），展示前还有 esc 兜底 */
const REGION_BAD_CHARS = /[^A-Za-z .()'-]+/g

/**
 * 写库快照码（唯一采集入口）：`CN:Guangdong` / `US:California` / `HK`，拿不到一律空串。
 * country 只认两位大写 ISO 码；T1（Tor 出口）/ XX（未知）不采集——属地展示对这两类人
 * 是纯噪音，宁缺毋假。region 收敛为 ASCII 地名形态并限 60 字符。
 */
export function regionCodeOfCf(cf: CfGeo | null | undefined): string {
  const country = typeof cf?.country === 'string' ? cf.country.trim().toUpperCase() : ''
  if (!/^[A-Z]{2}$/.test(country) || country === 'XX' || country === 'T1') return ''
  const region =
    typeof cf?.region === 'string'
      ? cf.region.replace(REGION_BAD_CHARS, ' ').replace(/\s+/g, ' ').trim().slice(0, 60)
      : ''
  return region ? `${country}:${region}` : country
}

/** 从请求读 cf 快照（api.ts 唯一调用形态；Node / docker 无 cf 自动得空串） */
export function regionSnapshot(req: Request): string {
  return regionCodeOfCf((req as Request & { cf?: CfGeo | undefined }).cf)
}

/**
 * 展示标签（唯一格式化出口）：空码回空串（调用方据此不渲染）。
 * 国内到省、国外到国家（中英同口径）；CN 的未收录地名回「中国/ China」，未收录国家回「海外」。
 */
export function ipRegionLabel(code: string, en = false): string {
  if (!code) return ''
  const sep = code.indexOf(':')
  const country = sep === -1 ? code : code.slice(0, sep)
  const region = sep === -1 ? '' : code.slice(sep + 1)
  if (country === 'CN') {
    if (region) {
      if (en) return region
      return hasOwn(CN_REGIONS, region) ? CN_REGIONS[region] : '中国'
    }
    return en ? 'China' : '中国'
  }
  if (en) return hasOwn(COUNTRY_EN, country) ? COUNTRY_EN[country] : region || country
  if (hasOwn(COUNTRY_ZH, country)) return COUNTRY_ZH[country]
  return '海外'
}
