-- 博客号广场 hub —— D1 schema（独立于博客主库，plaza/wrangler.jsonc 绑定自己的 plaza-db）
-- 部署：npx wrangler d1 execute DB --remote --file schema.sql

CREATE TABLE IF NOT EXISTS sites (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  site_url TEXT NOT NULL,             -- 站点绝对地址（去尾斜杠，唯一）
  site_name TEXT NOT NULL DEFAULT '', -- 展示名（feed 与名录出参）
  avatar TEXT NOT NULL DEFAULT '',    -- 站点头像 https 地址（ingest 上报 / 管理端设置，广场卡主视觉）
  token TEXT NOT NULL,                -- push ingest 凭据（32 hex，明文只在创建返回一次）
  verified INTEGER NOT NULL DEFAULT 0,-- 认证徽标（B18 雏形：所有权验证通过后管理员打开）
  weight INTEGER NOT NULL DEFAULT 1,  -- 混排权重 0-10（管理员定，默认 1）
  disabled INTEGER NOT NULL DEFAULT 0,-- 停用（违规/180 天无心跳自动休眠）
  pull_enabled INTEGER NOT NULL DEFAULT 1, -- RSS pull 补漏开关（push 为主，pull 只兜底）
  last_seen_at INTEGER NOT NULL DEFAULT 0, -- 最近一次成功 ingest 心跳
  created_at INTEGER NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_sites_token ON sites(token);
CREATE UNIQUE INDEX IF NOT EXISTS idx_sites_url ON sites(site_url);

CREATE TABLE IF NOT EXISTS items (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  site_id INTEGER NOT NULL,
  kind TEXT NOT NULL,                 -- 'post' | 'weibo'
  ref TEXT NOT NULL,                  -- 站内唯一引用：文章 slug / 微博 id
  title TEXT NOT NULL DEFAULT '',
  summary TEXT NOT NULL DEFAULT '',   -- 入库前已截断（push 500 / pull 500 字符）
  url TEXT NOT NULL,                  -- 站内原文绝对地址（校验只收 https）
  image TEXT NOT NULL DEFAULT '',     -- 封面图 https 地址（可空）
  published_at INTEGER NOT NULL,      -- 站内发布时间（毫秒）
  source TEXT NOT NULL DEFAULT 'push',-- 'push' | 'pull'——pull 不得覆盖 push 数据（ON CONFLICT WHERE 守卫）
  hidden INTEGER NOT NULL DEFAULT 0,  -- 管理员下架位
  likes INTEGER NOT NULL DEFAULT 0,   -- 匿名点赞累计数（P2.1；重推同 ref 更新内容字段不动它）
  synced_at INTEGER NOT NULL,
  UNIQUE(site_id, kind, ref)
);
CREATE INDEX IF NOT EXISTS idx_items_site ON items(site_id);
CREATE INDEX IF NOT EXISTS idx_items_pub ON items(published_at);

-- 点赞去重日志（P2.1）：只服务「每 IP 每条 1 次/天 / 每会话 60 次/天」两道限流，
-- 聚合数在 items.likes。隐私口径：不存原始 IP / vid，只存「北京日 + 当日盐」哈希
-- （同 IP 跨日哈希不同，无法跨天串联）；7 天前的行 cron 清掉（去重只需要当天）。
-- 老库列/表由 hub 的 ensureSchemaExtras 惰性补齐（两种部署形态都自动迁移）。
CREATE TABLE IF NOT EXISTS likes (
  day TEXT NOT NULL,                  -- 北京日期 YYYY-MM-DD
  item_id INTEGER NOT NULL,           -- items.id
  ip_hash TEXT NOT NULL,              -- sha256(day:ip)，天级去重键
  vid_hash TEXT NOT NULL,             -- sha256(day:vid)，会话级限流计数用
  created_at INTEGER NOT NULL,
  PRIMARY KEY (day, item_id, ip_hash)
);
CREATE INDEX IF NOT EXISTS idx_likes_vid ON likes(day, vid_hash);

-- 站点级互动/回传日聚合（P2.2/P2.3）：per-site 曝光/点击/点赞按北京日一行，
-- 站长数据卡（/api/site-stats）出近 7 日趋势与累计；几百站量级一年 ~11 万行，无清理压力。
-- views/clicks 来自官网广场页的批量匿名回传（无 IP 无指纹），likes 是点赞成功的冗余镜像。
CREATE TABLE IF NOT EXISTS site_stats (
  day TEXT NOT NULL,
  site_id INTEGER NOT NULL,
  views INTEGER NOT NULL DEFAULT 0,   -- 卡片曝光次数（近似：卡片进入视口计数）
  clicks INTEGER NOT NULL DEFAULT 0,  -- 出站点击次数
  likes INTEGER NOT NULL DEFAULT 0,   -- 点赞成功次数
  PRIMARY KEY (day, site_id)
);

-- 调用统计（每日一行，北京日口径）：公开面拉取与上报计数，供 ops 控制面出全局数据。
-- 按天一行增长（几百站量级一年 365 行），无清理压力；统计失败不阻塞主流程（代码侧吞错）
CREATE TABLE IF NOT EXISTS stats (
  day TEXT PRIMARY KEY,                 -- 北京日期 YYYY-MM-DD（与内核时间口径一致：UTC+8）
  feed_hits INTEGER NOT NULL DEFAULT 0, -- /api/feed 拉取次数 ≈ 广场页访问量（页面加载即拉）
  sites_hits INTEGER NOT NULL DEFAULT 0,-- /api/sites 名录拉取次数
  ingest_hits INTEGER NOT NULL DEFAULT 0,-- /api/ingest 成功上报次数（签名通过后计）
  ingest_items INTEGER NOT NULL DEFAULT 0-- 成功入库条数（accepted 合计）
);
