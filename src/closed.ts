/**
 * 一键闭站（后台「设置 → 站点状态」）：开启后公开面整体 503，白名单放行后台与登录。
 * 独立成模块（而非写在 index.ts）是为了让 tests/site-status.test.ts 能在 Node 里直接单测——
 * index.ts 会级联导入主题 CSS，Worker 的 Text 规则认、Node 测试环境加载不了。
 */
import { getSessionUser } from './auth'
import { getSettings } from './db'
import { renderClosedPage } from './render'

/** 闭站时仍然放行的路径：后台 SPA、后台 API（自带登录校验）、登录/登出、
 *  主题元数据（后台皮肤页用）、健康检查、图床。其余公开页面、RSS、sitemap、
 *  公开 API（评论/点赞/打点/友链申请）一律 503——闭站期间连写入一起关死 */
export function closedBypassPath(path: string): boolean {
  return (
    path === '/admin' ||
    path.startsWith('/admin/') ||
    path === '/api/admin' ||
    path.startsWith('/api/admin/') ||
    path.startsWith('/api/auth/') ||
    path.startsWith('/api/meta/') ||
    path === '/api/health' ||
    path.startsWith('/images/')
  )
}

/** 返回 null 表示放行；否则返回闭站响应（页面 503 HTML / API 503 JSON）。
 *  已登录管理员不拦截——关站后自己仍可全站浏览检查 */
export async function siteClosedResponse(db: D1Database, req: Request, path: string): Promise<Response | null> {
  if (closedBypassPath(path)) return null
  const settings = await getSettings(db)
  if (settings.siteClosed !== '1') return null
  if (await getSessionUser(db, req)) return null
  if (path.startsWith('/api/')) return Response.json({ error: '站点已关闭，暂时无法访问' }, { status: 503 })
  return new Response(renderClosedPage(settings), {
    status: 503,
    headers: {
      'Content-Type': 'text/html; charset=utf-8',
      'Retry-After': '3600',
      'Cache-Control': 'no-store',
      // 闭站页是独立渲染面，同样不给脚本执行面（页内只有内联样式）
      'Content-Security-Policy': "default-src 'none'; style-src 'unsafe-inline'",
      'X-Content-Type-Options': 'nosniff',
    },
  })
}
