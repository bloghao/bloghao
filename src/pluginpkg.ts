/* ===== 编辑器插件远程安装（B8 插件半边）=====
 * 编辑器插件本就是运行时加载（public/plugins/ 静态 manifest），这里补上「远程装包」的
 * 纯函数核心：安装 = 抓取 https 插件文件 → 安检 → 落 R2 → 登记进 settings.pluginsInstalled，
 * 下发走 /plugins/installed.json（清单）与 /plugin-files/:id（文件），编辑器照常 import。
 * 服务端 hooks 插件不在此列（编译期注册表，Workers 运行时不能加载 bundle 外代码）。
 *
 * 安全面：id 白名单字符（防路径穿越/原型链，R2 键由 id 拼接）；来源必须 https 公网且过
 * fetchableUrl（api.ts 接线处）；内容安检只收「含 registerPlugin 的文本 JS」（拦 HTML/JSON
 * 误装）；下发带 nosniff。JS 本体不做语义审查——安装是管理员显式动作、来源可见，
 * 与「提交进 SERVER_PLUGINS 注册表」同信任级。
 * 本模块全部纯函数，Node 测试直接导入（tests/pluginpkg.test.ts）。
 */

export const PLUGIN_SRC_MAX_BYTES = 256 * 1024

export interface InstalledPlugin {
  id: string
  /** 安装来源（审计口径：管理员装了什么、从哪装的） */
  url: string
  at: number
  bytes: number
}

/** 插件 id 白名单：字母数字_-，1-64 位（与停用名单 cleanDisabledPlugins 同字符集） */
export function cleanPluginId(raw: string): string | null {
  const s = String(raw ?? '').trim()
  if (!s || s.length > 64 || !/^[A-Za-z0-9_-]+$/.test(s)) return null
  return s
}

/** R2 对象键（id 已过白名单，无穿越面） */
export function pluginFileKey(id: string): string {
  return `plugins/${id}.js`
}

/** 内容安检：非空文本、限长、必须含 registerPlugin（拦 HTML 错误页 / JSON / 二进制误装） */
export function sanityCheckPluginSource(src: string): boolean {
  const s = String(src ?? '')
  if (!s.trim() || s.length > PLUGIN_SRC_MAX_BYTES) return false
  if (/\u0000/.test(s)) return false
  return s.includes('registerPlugin')
}

/** settings.pluginsInstalled 解析：脏 JSON / 形态不对一律回空数组（宁丢记录不崩） */
export function readInstalled(raw: string | undefined | null): InstalledPlugin[] {
  let v: unknown
  try {
    v = JSON.parse(String(raw ?? ''))
  } catch {
    return []
  }
  if (!Array.isArray(v)) return []
  const out: InstalledPlugin[] = []
  for (const e of v) {
    if (!e || typeof e !== 'object' || Array.isArray(e)) continue
    const rec = e as Record<string, unknown>
    const id = cleanPluginId(String(rec.id ?? ''))
    if (!id) continue
    out.push({
      id,
      url: typeof rec.url === 'string' ? String(rec.url).slice(0, 2048) : '',
      at: typeof rec.at === 'number' ? rec.at : 0,
      bytes: typeof rec.bytes === 'number' ? rec.bytes : 0,
    })
  }
  return out
}

/** 登记/更新（同 id 覆盖，保持先装在前的展示顺序） */
export function upsertInstalled(list: InstalledPlugin[], item: InstalledPlugin): InstalledPlugin[] {
  const idx = list.findIndex((x) => x.id === item.id)
  if (idx === -1) return [...list, item]
  const next = list.slice()
  next[idx] = item
  return next
}

/** 卸载登记 */
export function removeInstalled(list: InstalledPlugin[], id: string): InstalledPlugin[] {
  return list.filter((x) => x.id !== id)
}

/** /plugins/installed.json 出参：只给 id 与安装时间（url/bytes 是管理面信息，编辑器不需要） */
export function installedManifest(list: InstalledPlugin[]): { id: string; at: number }[] {
  return list.map(({ id, at }) => ({ id, at }))
}
