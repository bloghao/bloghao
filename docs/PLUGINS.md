# 插件开发指南

博客号编辑器内置一个极简插件系统：一个插件 = 一个 JS 文件 + manifest 里的一行。无需构建、无需重新部署后台。

## 快速上手：写一个「每日一句」按钮

1. 新建 `public/plugins/quote-of-day.js`：

```js
window.BlogHao &&
  window.BlogHao.registerPlugin({
    name: 'quote-of-day',            // 全局唯一
    title: '插入每日一句',            // 悬停提示
    icon: '<svg viewBox="0 0 24 24" width="18" height="18"><path d="M6 14c0-4 2-7 6-9l1 2c-2 1-3 3-3 5h3v6H6zm9 0c0-4 2-7 6-9l1 2c-2 1-3 3-3 5h3v6h-7z" fill="currentColor"/></svg>',
    onClick(ctx) {
      ctx.insertHTML(
        '<blockquote style="border-left:3px solid #07c160;padding:8px 14px;color:#666;">' +
          '今天也是适合写作的一天 ✍️' +
        '</blockquote><p><br></p>'
      )
      ctx.notify('已插入每日一句 ✅')
    },
  })
```

2. 在 `public/plugins/manifest.json` 中登记（对象格式，带元数据；`id` 建议与 `registerPlugin` 的 `name` 一致）：

```json
[
  { "id": "quote-of-day", "file": "quote-of-day.js", "title": "插入每日一句", "description": "正文里插入一枚鼓励签", "version": "1.0.0", "author": "你" }
]
```

> 兼容旧格式：纯文件名字符串数组 `["quote-of-day.js"]` 依然有效，只是后台「插件」页会缺少标题/描述/版本展示。`id` 只能包含字母、数字、`_`、`-`。

3. 刷新编辑器页面，工具栏末尾出现新按钮。

## 插件 API（`window.BlogHao`）

| 成员 | 说明 |
| --- | --- |
| `registerPlugin(def)` | 注册插件；`def = { name, title?, icon?, onClick(ctx), onMount?(ctx) }`，`icon` 是 SVG 字符串；`onMount` 在编辑器挂载后触发一次（重挂载补注册时同样触发），适合做初始化（拉数据、注样式） |
| `insertHTML(html)` | 在当前光标处插入 HTML（自动恢复选区、触发自动保存） |
| `getHTML()` / `setHTML(html)` | 读取 / 替换正文 HTML |
| `getSelectionText()` / `getSelectionHTML()` | 读取当前选区的纯文本 / HTML（编辑器外的选区一律返回空串） |
| `replaceSelection(html)` | 用给定 HTML 替换当前选区；无有效选区时退化为光标处插入 |
| `registerShortcut(combo, handler)` | 注册编辑器快捷键，如 `registerShortcut('mod+shift+k', (ctx) => …)`。组合键**必须带修饰键**（`mod`/`ctrl`/`cmd`/`meta`——`mod` 在 Mac 映射 Cmd、其他平台 Ctrl，可叠加 `shift`/`alt`），纯字母键会抢正文输入、注册时直接忽略；中文输入法组词回车不触发 |
| `exec(cmd, value?)` | 执行 `document.execCommand`（如 `bold`、`formatBlock`） |
| `notify(msg)` | 弹出 toast 提示 |
| `version` | 插件 API 版本，当前 `'1.1'`（1.1 起有选区读写 / 快捷键 / onMount） |

`onClick(ctx)` 的 `ctx` 与 `window.BlogHao` 上的方法相同，直接用 `ctx.insertHTML(...)` 即可。

## 加载机制

编辑器初始化时读取 `/plugins/manifest.json`（数组，按序加载），逐个 `import('/plugins/<file>')`。单个插件加载失败只会在控制台告警，不影响编辑器与其他插件。

**启停**：后台「插件」页可以随时停用某个插件（写入 settings 的 `pluginsDisabled` 名单），编辑器加载时跳过名单内的 id，下次打开编辑器生效——不再需要手改 manifest 重新部署。

**远程安装（B8 插件半边）**：后台「插件 → 插件市场」底部「远程插件」面板，粘贴插件文件的 **https 直链**（或点市场条目的「安装」按钮——条目带 `src` 字段即出现）即可装进站内：服务端抓取文件（走统一出网防线、≤ 256KB、须调用 `registerPlugin`）、落 R2、登记进 settings 的 `pluginsInstalled`。编辑器加载时除静态 manifest 外还会拉 `/plugins/installed.json` 清单、逐个 `import('/plugin-files/<id>')`（管理员会话门槛），与 manifest 插件同一套加载 / 停用 / 补注册机制。卸载删文件并撤登记，已打开的编辑器刷新后不再加载。演示站不开放安装。机制核心（id 白名单 / 内容安检 / 登记表纯函数）在 `src/pluginpkg.ts`。

**市场**：`public/market/catalog.json` 是后台「皮肤 / 插件」页「市场」标签页的数据源（内置精选目录，`{ themes: [...], skins: [...], plugins: [...] }`）。`plugins` 条目 `{ id, name, description, link }`，带 `src`（插件文件 https 直链）即出现「安装」按钮；`skins` 条目内联 `pack`（`{ name, appearance, css }`），在皮肤页一键应用为皮肤包。收录新作品 = 往里加一条；未来切换成远程目录时前端只需换数据来源。

**建议**：插件自己的状态（如设置项）存 `localStorage`（加前缀 `bloghao-plugin-<name>-`），不要请求外部服务——CSP 与规范都鼓励完全本地化。

## 注意事项

- 插入的 HTML 会**在保存时经过服务端白名单净化**（防 XSS）：脚本、事件属性、`javascript:` 链接等会被剥除；排版类内联样式、`data-w`、`data-ignore-width`、`data-no-dark` 等规范属性会保留。
- 遵循[微信排版规范](wechat-typography-spec.md)：别插入固定宽度节点、别用 `!important`。
- 插件只影响编辑器；想改公开页展示逻辑请走[主题](THEMES.md)。

## 内置插件：公众号采集（wechat-collect）

编辑器工具栏末尾的「采集公众号文章」按钮（微信双气泡图标）：粘贴 `mp.weixin.qq.com` 的文章链接，服务端抓取正文、把配图与封面转存进 R2 图床，并生成一篇**保留原发布时间**的草稿，随后自动跳转到编辑器——核对无误后点「发布」即可。支持两种内容类型：

- **普通图文**：解析 `js_content` DOM，保留段内加粗/斜体；
- **贴图（图片消息）**：页面没有 `js_content`，数据埋在内嵌 JS 里（`parseImagePost`）——图片列表取 `picture_page_info_list` 各条目顶层的 `cdn_url`（排除 `share_cover`/`watermark_info` 等嵌套图），全文取 `window.desc`/`content_noencode`（`\x0a` 反转义后按空行分段），草稿沿用原页面版式：图片在前、文字分段在后。

公众号封面（`msg_cdn_url`）常是正文首图的**衍生裁切**（同一媒体 ID、不同尺寸/格式段，字符串比对不出来）。普通图文采集时会按媒体 ID（`mmbizAssetId`）识别这种情况，正文里去掉那张图——封面只放封面位，文章页不再一图两现；贴图不适用（其封面本就取自首图，图即内容）。

服务端实现见 `src/collect.ts`（`POST /api/admin/collect/wechat`，需登录）。限制：每分钟 10 篇 / IP，单篇最多转存 30 张图，单次抓取（页面/图片）超时 15 秒，正文 ≤ 约 900KB；公众号**内嵌视频暂不支持**。

面向使用者的完整说明见 [GUIDE.md](GUIDE.md) 第 6 节。

## 服务端插件（随内核运行）

编辑器插件跑在浏览器，服务端插件跑在 Worker 里：内核在关键动作处广播事件（钩子），插件订阅处理。当前钩子八个——

| 钩子 | 触发时机 | 典型用途 |
| --- | --- | --- |
| `onPostPublished` | 文章从草稿/定时**跃迁**为已发布（后台发布与定时到点两条路都触发；重复编辑已发布文章不重推） | 同步到 TG 频道、广场同步 |
| `onPostUpdated` | **编辑已发布文章**且编辑后仍处于发布态（转草稿/定时与锁文跃迁走下架同步，不在此列） | IndexNow 类「编辑也让搜索引擎重抓」 |
| `onPostDeleted` | 文章**软删进回收站**（彻底删除不触发——回收站恢复是唯一生路） | 同步类插件的删除下架 |
| `onWeiboPublished` | 微博**发布**（后台新建即发 / 草稿转发布 / 开放 API / TG 机器人四条路都触发；编辑已发布微博不重推） | 同步到 X 等社交平台、广场同步 |
| `onWeiboDeleted` | 微博**软删进回收站** | 同步类插件的删除下架 |
| `onCommentCreated` | 访客在文章 / 微博 / 留言板发表留言（作者自己的回复不触发） | Webhook 通知（飞书 / 企微 / Bark）、同步到审核流 |
| `onBackupCompleted` | 备份成功写盘（每晚 cron 与手动「立即备份」；skipped / 失败不触发） | **异地备份推送**——插件凭 `ctx.env.IMAGES.get(payload.key)` 取件转推 GitHub / 另一账号 |
| `footerHtml` | 每个公开页渲染时（同步） | 页脚注入挂件、徽章、自定义代码 |

内置六个官方插件（源码与注册表都在 `src/hooks.ts`）：**发布同步 Telegram 频道**（复用「外部发布」的 Bot Token，频道 ID 在「设置 → 外部发布」）、**微博同步 Buffer（X 等）**（Buffer 是社交排程平台，免费档 3 渠道并含 API 访问，替用户承担 X API 按量计费；API Key 与渠道 ID 在「设置 → 服务端插件」，渠道 ID 可一键拉取，X 免费档 280 字符超出自动截断，站内话题（`#话题` 或成对 `#话题#`）转 X 话题格式，站内配图走公链直传）、**评论 Webhook 推送**（地址在「设置 → 服务端插件」）、**通用出站 Webhook**（见下节）、**页脚自定义代码**（同在「设置 → 服务端插件」，受 CSP 保护外部脚本不执行）、**广场同步**（发布时把公开文章/微博推给官网广场 bloghao.com/plaza，Token 与地址在「设置 → 服务端插件」，加密文与会员锁文自动跳过，机制见 [PLAZA.md](PLAZA.md)）。后台「插件」页的「服务端插件」区可随时启停（存 settings 的 `serverPluginsDisabled`，立即生效）。

`onPostPublished` 的 payload 带可选 `locked` 布尔（发布的是加密访问文或会员专属文）——同步类插件必须据此跳过，别把锁文标题捅到公开面。

## 插件配置通道（不必再为配置改内核）

服务端插件要配置项，在插件定义上声明 `configFields`（`{ key, label, type: 'text'|'textarea', placeholder?, help? }[]`），后台「插件」页该插件行会出现「配置」按钮，弹窗按声明渲染表单，值存进 settings 的 `serverPluginConfig`（JSON：`{ 插件id: { 字段键: 值 } }`，单值 ≤ 500 字符）。处理器里用 `pluginConfig(ctx.settings, 自身id)` 读；保存时自动过两道校验——顶层键必须是注册插件 id、字段键必须在 `configFields` 里，插件可再实现 `configValidate(cfg)` 做语义校验（返回错误文案 = 拒绝保存，如公网地址校验）。**通用出站 Webhook** 就是第一个吃这套通道的官方插件：自选事件清单（`post_published / post_updated / post_deleted / weibo_published / weibo_deleted / comment_created / backup_completed`）+ 目标 URL（落配置即过公网 https 校验）+ 可选 HMAC 签名（`X-Bloghao-Timestamp` + `X-Bloghao-Signature` = HMAC-SHA256(密钥, `时间戳.请求体`)，与广场同步同口径可复用校验代码），n8n / 飞书 / 自建系统一个地址全接走。事件清单是**三态**：留空 = 全部放行；合法清单 = 只发这些；**非空但含坏项 = 拒发**（失败关闭，别让一次配置写脏把「只发某事件」放大成「全事件外推」）。发送走内核统一出网入口 `fetchPublicResource`（起点 + 每一跳重过 `fetchableUrl`，`expectBody:false` 只发不收）。

**铁律**：插件抛错绝不影响主流程——fire 函数统一吞错，发文 / 评论 / 渲染照常。

**写一个自己的**：在 `src/hooks.ts` 的 `SERVER_PLUGINS` 注册表加一个对象即可（`id/title/description/version/author` + 一个或多个钩子函数 + 可选 `configFields/configValidate`），随部署生效。第三方服务端插件目前以「提交 PR 进注册表」的方式分发（与主题注册表同模式，Workers 无法运行时安装服务端代码；编辑器插件的远程安装见上文，两条线能力边界不同）。历史上「插件要配置就得加 settings 专属键 + 设置页输入框」的老路（评论 Webhook、广场同步等官方插件的实现）仍然有效，新插件优先用配置通道。

## 路线图

后续计划（欢迎 PR）：

- 远程市场目录（catalog 换远程源，前端只换数据来源）与市场仓库独立立项（皮肤包 + 编辑器插件两类可安装资产已就绪）
- 更多服务端钩子：友链申请通过等事件（编辑/删除/备份钩子已上线）
