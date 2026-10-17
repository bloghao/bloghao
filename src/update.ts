/**
 * 更新中心（自选更新）——版本清单解析、语义化版本比对与更新状态计算。
 *
 * 定位：给「分站 / 自托管用户」一个能自己决定「更新到最新版」还是「保持当前版本」的地方。
 * 本模块只做**纯计算**（tests/update.test.ts 直接导入，不依赖 Workers 运行时）：解析官网发布的
 * 机器可读版本清单 → 严格校验 → 与当前版本比对 → 给出「更新了什么 / 优化了什么」的条目。
 * 出网抓取（固定可信端点 https://bloghao.com/version.json，同 api.telegram.org 口径）在 api.ts，
 * 控制面在 docker-poc/control.ts 复用本模块。
 *
 * 安全边界：清单来自官网静态文件，仍按**不可信输入**处理——只保留白名单结构（版本号必须是
 * x.y.z、说明剥控制字符 + 限长），脏值一律丢弃；校验不过整体当作「拿不到最新版本信息」，
 * 绝不让清单里的字符串直接进 HTML（渲染端另有一层 esc）。
 */

/** 机器可读版本清单（官网静态文件，由 scripts/build-release.mjs 从 CHANGELOG.md 生成） */
export const UPDATE_MANIFEST_URL = 'https://bloghao.com/version.json'
/** 升级指引文档（更新中心「如何更新」指向它；自托管 / Cloudflare 两种部署的更新动作） */
export const UPDATE_GUIDE_URL = 'https://bloghao.com/docs/updating.html'

/** 单个版本的更新说明（一条 = 一个版本，notes 是「更新了什么 / 优化了什么」要点） */
export interface UpdateRelease {
  version: string
  date: string
  notes: string[]
}

/** 规范化后的版本清单 */
export interface UpdateManifest {
  app: string
  generatedAt: string
  /** 最新版本号（清单声明值；非法或缺失时取 releases 里最高版本兜底） */
  latest: string
  date: string
  /** 全部版本，未排序（更新中心只取比当前版本新的条目展示） */
  releases: UpdateRelease[]
}

/** 更新中心一次性算出的状态（api.ts / 控制面直接透传给前端） */
export interface UpdateStatus {
  /** 当前运行版本（src/version.ts APP_VERSION） */
  current: string
  /** 最新可用版本 */
  latest: string
  /** 是否存在比当前更新的版本 */
  hasUpdate: boolean
  /** 用户选择「保持当前版本」时记录的版本号（'' = 未选择） */
  ignored: string
  /** 最新版恰好是用户选择保持的那一版（hasUpdate 仍为 true，但界面提示「已选择保持」） */
  kept: boolean
  /** 比当前版本更新的条目，新 → 旧（用于展示「更新了什么」） */
  releases: UpdateRelease[]
  /** 最新版本的发布日期 */
  date: string
}

const SEMVER_RE = /^v?(\d{1,6})\.(\d{1,6})\.(\d{1,6})$/
const MAX_RELEASES = 60
const MAX_NOTES_PER_RELEASE = 40
const MAX_NOTE_LEN = 400

/** 解析语义化版本 x.y.z（可带前导 v）；非法返回 null。只认三段纯数字，预发布后缀不支持 */
export function parseSemver(v: unknown): [number, number, number] | null {
  if (typeof v !== 'string') return null
  const m = SEMVER_RE.exec(v.trim())
  if (!m) return null
  return [Number(m[1]), Number(m[2]), Number(m[3])]
}

/** 版本比较：a < b → -1 / 相等 → 0 / a > b → 1；任一非法返回 null */
export function compareSemver(a: unknown, b: unknown): number | null {
  const x = parseSemver(a)
  const y = parseSemver(b)
  if (!x || !y) return null
  for (let i = 0; i < 3; i++) {
    if (x[i] !== y[i]) return x[i] < y[i] ? -1 : 1
  }
  return 0
}

/** 文本净化：剥控制字符、折叠空白、限长（清单字符串不可信，宁可截断） */
export function cleanManifestText(v: unknown, max: number): string {
  if (typeof v !== 'string') return ''
  return v
    .replace(/[\u0000-\u001f\u007f]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, max)
}

/**
 * 严格校验并规范化版本清单。任何结构不符 / 无有效版本条目 → null（调用方按「拿不到」处理）。
 * 单条脏数据只丢弃该条，不连坐整份清单；notes 里非字符串项直接过滤。
 */
export function validateUpdateManifest(raw: unknown): UpdateManifest | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null
  const o = raw as Record<string, unknown>
  // app 字段若存在必须是本项目，防止误配到别的 JSON 端点上
  if (o.app !== undefined && o.app !== 'bloghao') return null
  if (!Array.isArray(o.releases)) return null
  const releases: UpdateRelease[] = []
  const seen = new Set<string>()
  for (const item of o.releases) {
    if (releases.length >= MAX_RELEASES) break
    if (!item || typeof item !== 'object' || Array.isArray(item)) continue
    const r = item as Record<string, unknown>
    const version = cleanManifestText(r.version, 40).replace(/^v/, '')
    if (!parseSemver(version) || seen.has(version)) continue
    const notes = Array.isArray(r.notes)
      ? r.notes.map((n) => cleanManifestText(n, MAX_NOTE_LEN)).filter(Boolean).slice(0, MAX_NOTES_PER_RELEASE)
      : []
    seen.add(version)
    releases.push({ version, date: cleanManifestText(r.date, 20), notes })
  }
  if (!releases.length) return null
  const declared = cleanManifestText(o.latest, 40).replace(/^v/, '')
  const latest = parseSemver(declared)
    ? declared
    : releases.map((r) => r.version).sort((a, b) => (compareSemver(b, a) ?? 0))[0]
  const date = cleanManifestText(o.date, 20) || releases.find((r) => r.version === latest)?.date || ''
  return { app: 'bloghao', generatedAt: cleanManifestText(o.generatedAt, 40), latest, date, releases }
}

/**
 * 计算更新状态：把「当前版本 / 清单 / 用户已选择的保持版本」收敛成一次可渲染的结果。
 * - hasUpdate：清单最新版本高于当前版本（版本号非法一律当无更新，宁可不打扰）
 * - releases：只保留比当前版本新的条目（新 → 旧）——即「从你的版本到现在更新了什么」
 * - kept：用户此前点过「保持当前版本」，且选择的正是当前最新版（出现更新版本后自动失效）
 */
export function updateStatus(current: string, manifest: UpdateManifest, ignored = ''): UpdateStatus {
  const latest = manifest.latest
  const cmpLatest = compareSemver(latest, current)
  const hasUpdate = cmpLatest !== null && cmpLatest > 0
  const releases = manifest.releases
    .filter((r) => {
      const c = compareSemver(r.version, current)
      return c !== null && c > 0
    })
    .sort((a, b) => (compareSemver(b.version, a.version) ?? 0))
  const ignoredClean = cleanManifestText(ignored, 40).replace(/^v/, '')
  const kept = hasUpdate && compareSemver(ignoredClean, latest) === 0
  return {
    current,
    latest,
    hasUpdate,
    ignored: kept ? ignoredClean : '',
    kept,
    releases,
    date: manifest.date,
  }
}
