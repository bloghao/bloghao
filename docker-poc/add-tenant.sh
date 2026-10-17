#!/bin/sh
# 开一个新博客租户：tenants.json 登记域名 → 重启容器加载 → 健康检查确认就绪。
#
# 用法（在 docker-poc/ 目录下）：
#   ./add-tenant.sh blog1.example.com            # 真实站：空库，进 /admin/ 走创建管理员
#   ./add-tenant.sh try.example.com --demo       # 演示种子站：公示 demo 账号，每 2 小时清库重灌
#   ./add-tenant.sh blog2.example.com --remove   # 下线：从配置移除并重启（数据目录保留在盘上）
#   ./add-tenant.sh blog1.example.com --build    # 顺带重建镜像（升级代码后用；平时不需要）
#
# 域名须已把 DNS 指到本机（Cloudflare 橙云）。兼容 busybox sh；改 JSON 优先用 jq，
# 没有 jq 时退回 node（宿主机装过任意一个即可）。
#
# 为什么用「cat 覆盖」而不是「写临时文件再 mv」：tenants.json 是 compose 的单文件
# bind mount，容器读到的是同一 inode——mv 会换掉 inode，容器里永远看到旧文件；
# cat > 截断重写保住 inode，重启后新配置立即生效。
#
# 开通末尾会跑一次「收录自检」：确认新域名的 robots.txt 不是整站 Disallow、sitemap.xml 可达
# ——站长口径是「bloghao.com 的每个二级域名都要能被 AI 与搜索引擎抓到」。演示站例外：
# demo 站刻意整站 noindex（公开了 demo 账号、每 2 小时清库重灌），跳过断言。
set -eu

usage() {
  sed -n '2,10p' "$0" | sed 's/^# \{0,1\}//'
  exit 1
}

DEMO=0; REMOVE=0; BUILD=0; HOST=""
for arg in "$@"; do
  case "$arg" in
    --demo)   DEMO=1 ;;
    --remove) REMOVE=1 ;;
    --build)  BUILD=1 ;;
    -h|--help) usage ;;
    -*) echo "未知选项 $arg" >&2; usage ;;
    *) if [ -n "$HOST" ]; then echo "错误：只接受一个域名" >&2; usage; fi; HOST="$arg" ;;
  esac
done
[ -n "$HOST" ] || usage

# 域名形态校验：tenants.json 的键就是路由依据，也防手滑把奇怪字符写进 JSON
echo "$HOST" | grep -Eq '^[A-Za-z0-9]([A-Za-z0-9-]*[A-Za-z0-9])?(\.[A-Za-z0-9]([A-Za-z0-9-]*[A-Za-z0-9])?)+$' \
  || { echo "错误：$HOST 不是合法域名形态" >&2; exit 1; }

cd "$(dirname "$0")"
CONFIG="${TENANTS_CONFIG:-tenants.json}"
COMPOSE_FILE="${COMPOSE_FILE:-docker-compose.yml}"

[ -f "$CONFIG" ]     || { echo "错误：找不到 $CONFIG" >&2; exit 1; }
[ -f "$COMPOSE_FILE" ] || { echo "错误：找不到 $COMPOSE_FILE" >&2; exit 1; }
command -v docker >/dev/null 2>&1 || { echo "错误：没有 docker 命令" >&2; exit 1; }

# ── 改配置（jq 优先，node 兜底；两种格式都兼容）─────────────────────────────
#   新格式 {"r2":{...},"tenants":{...}}，旧平铺格式 {"域名":{"demo":..}}；
#   下线时两处同删，避免历史混用残留。
TMP="$CONFIG.tmp.$$"
if command -v jq >/dev/null 2>&1; then
  if [ "$REMOVE" = 1 ]; then
    jq --arg h "$HOST" 'if .tenants then del(.tenants[$h]) else . end | del(.[$h])' "$CONFIG" > "$TMP"
  else
    jq --arg h "$HOST" --argjson d "$([ "$DEMO" = 1 ] && echo true || echo false)" \
       'if .tenants then .tenants[$h] = {"demo": $d} else .[$h] = {"demo": $d} end' "$CONFIG" > "$TMP"
  fi
elif command -v node >/dev/null 2>&1; then
  MODE=add; [ "$REMOVE" = 1 ] && MODE=remove; [ "$DEMO" = 1 ] && MODE=demo
  node -e '
    const fs = require("fs");
    const [, cfgPath, outPath, mode, host] = process.argv;
    const cfg = JSON.parse(fs.readFileSync(cfgPath, "utf8"));
    if (mode === "remove") {
      if (cfg.tenants) delete cfg.tenants[host];
      delete cfg[host];
    } else {
      const entry = { demo: mode === "demo" };
      if (cfg.tenants) cfg.tenants[host] = entry; else cfg[host] = entry;
    }
    fs.writeFileSync(outPath, JSON.stringify(cfg, null, 2) + "\n");
  ' "$CONFIG" "$TMP" "$MODE" "$HOST"
else
  echo "错误：需要 jq 或 node 之一来改 JSON（宿主机装一个即可）" >&2
  exit 1
fi
# 写成功才原地覆盖（保 inode）；失败不留半截文件
cat "$TMP" > "$CONFIG" && rm -f "$TMP"
# 真实租户配置里没有密钥（R2 密钥启用后另行收紧：宿主用户组读写即可，
# 不能 600——容器内 node(uid 1000) 经 bind mount 直读此文件，600 会崩溃循环
chmod 644 "$CONFIG" 2>/dev/null || true

# ── 数据目录 / 提示 ───────────────────────────────────────────────────────
if [ "$REMOVE" = 1 ]; then
  echo "已从 $CONFIG 移除 ${HOST}（数据目录 data/tenants/${HOST} 保留，确认不要了再手工删）"
else
  # 提前建好并归 node(uid 1000)，首启即可用；非 root 拿不到属主也无妨——
  # entrypoint.sh 会兜底修
  mkdir -p "data/tenants/$HOST" 2>/dev/null || true
  if [ "$(id -u 2>/dev/null || echo 1)" = "0" ]; then
    chown -R 1000:1000 "data/tenants/$HOST" 2>/dev/null || true
  fi
  if [ "$DEMO" = 1 ]; then
    echo "已登记演示租户 ${HOST}（首访自动播种 demo/demo1234，每 2 小时清库重灌）"
  else
    echo "已登记租户 ${HOST}（空库，进 https://${HOST}/admin/ 创建管理员）"
  fi
fi

# ── 重启容器（或首次启动指引）─────────────────────────────────────────────
# 只 restart、不主动 up：compose up 在环境变量与首启不一致时会按新变量重建容器
# （比如首启绑了 127.0.0.1、这里忘带就重建回 0.0.0.0），公开服务器上等于意外裸奔。
# tenants.json 是挂载文件，restart 后进程重读即生效；要重建镜像显式 --build。
RUNNING=$(docker compose -f "$COMPOSE_FILE" ps -q 2>/dev/null || true)
if [ -z "$RUNNING" ] && [ "$BUILD" = 0 ]; then
  echo ""
  echo "容器未在运行。请带上与首次启动一致的端口变量手动起（见 DEPLOY-MICRO.md）："
  echo "  XWLBLOG_BIND=127.0.0.1 XWLBLOG_PORT=8787 docker compose up -d --build"
  exit 1
fi
if [ "$BUILD" = 1 ]; then
  echo "重建镜像并更新容器（约 1 分钟，1GB 机器会吃到 swap，属正常）…"
  docker compose -f "$COMPOSE_FILE" up -d --build || {
    echo "错误：重建失败，看上方报错（内存不足时改在开发机构建后 docker save/load 上传）" >&2; exit 1; }
else
  echo "重启容器加载新租户表…"
  docker compose -f "$COMPOSE_FILE" restart
fi

# ── 健康检查（容器内按 Host 探测，不依赖宿主端口与 DNS）──────────────────
if [ "$REMOVE" = 1 ]; then
  echo ""
  echo "✓ 完成。验证下线生效："
  echo "  curl -s -o /dev/null -w '%{http_code}' -H 'Host: $HOST' http://127.0.0.1:8787/api/health"
  echo "  应返回 404（未登记域名；进程内存的租户表要容器重启才刷新，届时再复测）。" >&2
  echo "  数据确认不要后删除：rm -rf \"\${TENANTS_DIR:-data}/$HOST\"" >&2
  echo "  （TENANTS_DIR 未设默认 data/；compose 把它整个挂到容器 /data/tenants，" >&2
  echo "    宿主路径以 docker inspect 的 Mounts 为准）" >&2
  exit 0
fi

# ── 收录自检（SEO / AI 抓取守卫）────────────────────────────────────────────
# 内核默认就是「可抓取」：siteNoindex 默认关、robots.txt / sitemap.xml 自动生成。
# 这里只兜底确认一次——开通时串了模板、或日后被关了 noindex，当场红字提醒。
crawl_selfcheck() {
  if [ "$DEMO" = 1 ]; then
    echo "  · 演示站：刻意整站 noindex，跳过收录自检（属正常）"
    return 0
  fi
  ROBOTS=$(docker compose -f "$COMPOSE_FILE" exec -T xwblog \
    sh -c "wget -q -O - --header 'Host: $HOST' http://127.0.0.1:8787/robots.txt" 2>/dev/null || true)
  if printf '%s\n' "$ROBOTS" | grep -qx 'Disallow: /'; then
    echo "  ✗ 警告：${HOST} 的 robots.txt 是整站 Disallow —— 搜索引擎与 AI 都抓不到这个域名！" >&2
    echo "    恢复：打开 https://${HOST}/admin/ → 设置 → 站点 → 关掉「禁止搜索引擎收录」/「关闭站点」" >&2
    return 1
  fi
  if docker compose -f "$COMPOSE_FILE" exec -T xwblog \
      sh -c "wget -q -O /dev/null --header 'Host: $HOST' http://127.0.0.1:8787/sitemap.xml" 2>/dev/null; then
    echo "  ✓ 收录自检通过：robots.txt 可抓取、sitemap.xml 可达"
  else
    echo "  ⚠ 提示：${HOST} 的 sitemap.xml 取不到（站点闭站时属正常；否则去后台确认「站点地址」是否已填）" >&2
  fi
  return 0
}

printf '等待 %s 就绪' "$HOST"
i=0
while [ "$i" -lt 30 ]; do
  if docker compose -f "$COMPOSE_FILE" exec -T xwblog \
      sh -c "wget -q -O /dev/null --header 'Host: $HOST' http://127.0.0.1:8787/api/health" 2>/dev/null; then
    echo ""
    echo "✓ ${HOST} 已就绪（/api/health 200）。"
    crawl_selfcheck || true
    echo ""
    echo "浏览器打开 https://${HOST}/ 确认后即可开始写作。"
    exit 0
  fi
  printf '.'
  i=$((i + 1))
  sleep 2
done
echo ""
echo "✗ 60 秒内健康检查未通过。排查：docker compose logs --tail 50" >&2
echo "  常见原因：tenants.json 语法坏了（jq/node 写坏会留 .tmp 文件可回查）、容器崩溃循环、" >&2
echo "  1GB 机器上 --build 撞 swap 起不来（docker compose restart 再试一次）" >&2
exit 1
