/** 系统版本号——后台概览「系统」卡展示（/admin/stats 出参 version 字段），管理面唯一出口。
 * 事实源是 package.json 的 version（docs/RELEASING.md）：发版改版本号时**两处同步**，
 * tests/version.test.ts 守着这份镜像，漏改即红。不进 RSS / 公开接口，避免自托管装机指纹 */
export const APP_VERSION = '2.6.0'
