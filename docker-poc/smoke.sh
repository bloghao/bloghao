#!/usr/bin/env bash
# xwblog 自托管 POC 冒烟：起服务 → 演示租户 → 真实租户全链路 → 跨租户隔离
# 用法：cd docker-poc && npm run smoke   （或 bash smoke.sh）
set -euo pipefail
cd "$(dirname "$0")"

# 冒烟走本机回环：绕开继承来的 HTTP(S) 代理（否则 curl 把请求交给代理，
# 代理解析不了 *.localhost 主机名，一律回 502）
export NO_PROXY='*' no_proxy='*'
unset HTTP_PROXY HTTPS_PROXY ALL_PROXY http_proxy https_proxy all_proxy 2>/dev/null || true

PORT="${PORT:-8787}"
BASE="http://127.0.0.1:${PORT}"
PASS=0
FAIL=0

# 本目录没装过依赖时才装（esbuild 一个包，不碰主工程）
[ -x node_modules/.bin/esbuild ] || npm install --no-audit --no-fund

echo "==> 打包"
npm run --silent build

echo "==> SigV4 签名自检（AWS 官方测试向量）"
node dist/server.js --selftest

echo "==> 启动服务（端口 ${PORT}）"
node dist/server.js >server.smoke.log 2>&1 &
SERVER_PID=$!
trap 'kill ${SERVER_PID} ${MOCK_HUB_PID:-} 2>/dev/null || true' EXIT

# 等 /api/health 就绪
for i in $(seq 1 60); do
  if curl -sf -H 'Host: main.localhost' "${BASE}/api/health" >/dev/null 2>&1; then break; fi
  [ "$i" = 60 ] && { echo "服务 60 秒内没起来，server.smoke.log："; tail -50 server.smoke.log; exit 1; }
  sleep 1
done

check() { # check <名称> <期望> <实际>
  if [ "$2" = "$3" ]; then PASS=$((PASS+1)); echo "PASS  $1"
  else FAIL=$((FAIL+1)); echo "FAIL  $1（期望 $2，实际 $3）"; fi
}
code() { curl -s -o /dev/null -w '%{http_code}' --resolve "$1:${PORT}:127.0.0.1" "http://$1:${PORT}$2"; }

echo "==> 基础链路"
check "main 租户 health"          200 "$(code main.localhost /api/health)"
check "demo 租户 health"          200 "$(code demo.localhost /api/health)"
check "t1 租户 health"            200 "$(code t1.localhost /api/health)"
check "未登记域名 404"            404 "$(code nobody.localhost /api/health)"
check "后台 SPA 静态直出"         200 "$(code main.localhost /admin/)"
check "后台无斜杠 301 补斜杠（防相对路径资源 404）" 301 "$(code main.localhost /admin)"
check "demo 租户 RSS"             200 "$(code demo.localhost /rss.xml)"
check "main 租户首页（空库也能渲染）" 200 "$(code main.localhost /)"

echo "==> 演示租户播种"
DEMO_HOME=$(curl -s --resolve "demo.localhost:${PORT}:127.0.0.1" "http://demo.localhost:${PORT}/")
check "demo 首页含种子文章链接" 1 "$(printf '%s' "$DEMO_HOME" | { grep -o '/post/' || true; } | wc -l | awk '{print ($1>0)?1:0}')"

echo "==> 真实租户：注册 → 登录 → 发文 → 传图"
JAR=$(mktemp)
SETUP=$(curl -s -o /dev/null -w '%{http_code}' --resolve "main.localhost:${PORT}:127.0.0.1" -c "$JAR" -H 'Content-Type: application/json' -d '{"username":"owner","password":"password123","displayName":"站长"}' http://main.localhost:${PORT}/api/auth/setup)
check "首次创建管理员（重跑时已存在也算过）" 1 "$([ "$SETUP" = 200 ] || [ "$SETUP" = 403 ] && echo 1 || echo 0)"
check "登录"           200 "$(curl -s -o /dev/null -w '%{http_code}' --resolve "main.localhost:${PORT}:127.0.0.1" -b "$JAR" -c "$JAR" -H 'Content-Type: application/json' -d '{"username":"owner","password":"password123"}' http://main.localhost:${PORT}/api/auth/login)"
check "带同源 Origin 的 POST 放行（模拟 CF 灵活 SSL 后的浏览器）" 200 "$(curl -s -o /dev/null -w '%{http_code}' --resolve "main.localhost:${PORT}:127.0.0.1" -b "$JAR" -H "Origin: http://main.localhost:${PORT}" -H 'Content-Type: application/json' -d '{"username":"owner","password":"password123"}' http://main.localhost:${PORT}/api/auth/login)"
check "跨站 Origin 仍被拒绝（CSRF 防线未被适配层拆掉）" 403 "$(curl -s -o /dev/null -w '%{http_code}' --resolve "main.localhost:${PORT}:127.0.0.1" -b "$JAR" -H 'Origin: https://evil.example' -H 'Content-Type: application/json' -d '{"username":"owner","password":"password123"}' http://main.localhost:${PORT}/api/auth/login)"

# 新手引导记账位（概览页清单卡）：setup 首装播种 onboarding='1'（api.ts）。断言只查键在场——
# 首装播种的强断言由 CI 全新状态覆盖，本地重跑时上次的 '0' 也不误报；PUT 归一化两口都验
ONBOARD=$(curl -s --resolve "main.localhost:${PORT}:127.0.0.1" -b "$JAR" http://main.localhost:${PORT}/api/admin/settings)
check "settings 含 onboarding 引导记账位（首装播种）" 1 "$(printf '%s' "$ONBOARD" | grep -c '"onboarding":"')"
check "onboarding PUT 可关闭（引导记账位归一化）" 200 "$(curl -s -o /dev/null -w '%{http_code}' --resolve "main.localhost:${PORT}:127.0.0.1" -b "$JAR" -X PUT -H 'Content-Type: application/json' -d '{"onboarding":"0"}' http://main.localhost:${PORT}/api/admin/settings)"
check "onboarding 关闭后回读为 0" 1 "$(curl -s --resolve "main.localhost:${PORT}:127.0.0.1" -b "$JAR" http://main.localhost:${PORT}/api/admin/settings | grep -c '"onboarding":"0"')"
curl -s -o /dev/null --resolve "main.localhost:${PORT}:127.0.0.1" -b "$JAR" -X PUT -H 'Content-Type: application/json' -d '{"onboarding":"1"}' http://main.localhost:${PORT}/api/admin/settings

CREATE=$(curl -s --resolve "main.localhost:${PORT}:127.0.0.1" -b "$JAR" -H 'Content-Type: application/json' \
  -d '{"title":"POC 冒烟文章","content":"<p>来自 docker-poc 的文章，正文配图稍后上传。</p>","status":"published","tags":["poc"]}' \
  http://main.localhost:${PORT}/api/admin/posts)
SLUG=$(printf '%s' "$CREATE" | node -e "let s='';process.stdin.on('data',d=>s+=d).on('end',()=>{try{console.log(JSON.parse(s).post?.slug||JSON.parse(s).slug||'')}catch{console.log('')}})")
check "创建文章拿到 slug" 1 "$([ -n "$SLUG" ] && echo 1 || echo 0)"
check "main 租户文章页"   200 "$(code main.localhost "/post/$SLUG")"
check "t1 租户看不到 main 的文章（隔离）" 404 "$(code t1.localhost "/post/$SLUG")"

# 1x1 PNG
PNG=$(mktemp --suffix=.png 2>/dev/null || mktemp).png
printf 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==' | base64 -d > "$PNG"
# Windows 原生 curl（Git Bash 常见发行）读不了 MSYS 的 /tmp 虚拟路径（CURLE_READ_ERROR），
# 转 Windows 路径；Linux/WSL 无 cygpath 回退原路径
PNG_FOR_CURL="${PNG}"
command -v cygpath >/dev/null 2>&1 && PNG_FOR_CURL=$(cygpath -w "$PNG")
UP=$(curl -s --resolve "main.localhost:${PORT}:127.0.0.1" -b "$JAR" -F "file=@${PNG_FOR_CURL};type=image/png" http://main.localhost:${PORT}/api/admin/upload)
KEY=$(printf '%s' "$UP" | node -e "let s='';process.stdin.on('data',d=>s+=d).on('end',()=>{try{console.log(JSON.parse(s).key||'')}catch{console.log('')}})")
check "上传图片拿到 key" 1 "$([ -n "$KEY" ] && echo 1 || echo 0)"
check "图片回读 200 + PNG" 200 "$(curl -s -o /dev/null -w '%{http_code}' --resolve "main.localhost:${PORT}:127.0.0.1" "http://main.localhost:${PORT}/images/$KEY")"
check "t1 租户看不到 main 的图（R2 隔离）" 404 "$(code t1.localhost "/images/$KEY")"

check "main 租户 sitemap" 200 "$(code main.localhost /sitemap.xml)"

kill ${SERVER_PID} 2>/dev/null || true
wait ${SERVER_PID} 2>/dev/null || true

# ── 控制面（多租户管理面板）───────────────────────────────────────────────
# 用临时 tenants.json / 数据目录隔离，不污染仓库配置与 smoke 前半段数据
echo "==> 控制面：登录 → 开站（自动进广场）→ 重置密码 → 停用 → 删除 → 广场收录同步"
SMOKE_DIR=$(mktemp -d)
SMOKE_CFG="${SMOKE_DIR}/tenants.json"
SMOKE_DATA="${SMOKE_DIR}/tenants"
cat > "$SMOKE_CFG" <<EOF
{ "ops.localhost": {}, "main.localhost": {}, "demo.localhost": { "demo": true }, "t1.localhost": { "demo": true } }
EOF

# mock 广场 hub（控制面收录链路对端）：按 URL 去重的注册 409 / stats / pull / 站点增删改
MOCK_HUB_PORT=$((PORT + 1))
MOCK_LOG="${SMOKE_DIR}/hub-reqs.json"
node -e '
const http = require("http");
const fs = require("fs");
const [, logFile, port] = process.argv;
const TOKEN = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const seen = [];
const sites = [];
const bodyUrl = (r) => { try { return String((JSON.parse(r.body || "{}") || {}).url || ""); } catch { return ""; } };
http.createServer((req, res) => {
  let body = "";
  req.on("data", (d) => (body += d));
  req.on("end", () => {
    if ((req.headers.authorization || "") !== "Bearer smoke-admin-token") {
      res.writeHead(401); return res.end(JSON.stringify({ error: "unauthorized" }));
    }
    seen.push({ method: req.method, url: req.url, body });
    try { fs.writeFileSync(logFile, JSON.stringify(seen)); } catch {}
    const m = req.url.match(/^\/api\/admin\/sites\/(\d+)$/);
    if (req.method === "POST" && req.url === "/api/admin/sites") {
      let p = {}; try { p = JSON.parse(body || "{}"); } catch {}
      if (seen.filter((r) => r.method === "POST" && r.url === "/api/admin/sites" && bodyUrl(r) === p.url).length > 1) {
        res.writeHead(409); return res.end(JSON.stringify({ error: "dup" }));
      }
      if (p.url && !sites.includes(p.url)) sites.push(p.url);
      res.writeHead(200); return res.end(JSON.stringify({ ok: true, id: sites.length, token: TOKEN }));
    }
    if (req.method === "GET" && req.url === "/api/admin/sites") {
      res.writeHead(200); return res.end(JSON.stringify({ sites: sites.map((url, i) => ({ id: i + 1, url })) }));
    }
    if (req.method === "PATCH" && m) {
      if (!sites[Number(m[1]) - 1]) { res.writeHead(404); return res.end(JSON.stringify({ error: "no site" })); }
      res.writeHead(200); return res.end(JSON.stringify({ ok: true }));
    }
    if (req.method === "DELETE" && m) {
      const gone = sites.splice(Number(m[1]) - 1, 1);
      res.writeHead(200); return res.end(JSON.stringify({ ok: true, gone: gone.length }));
    }
    if (req.method === "POST" && req.url === "/api/admin/pull") {
      res.writeHead(200); return res.end(JSON.stringify({ ok: true, pulled: 0 }));
    }
    if (req.method === "GET" && req.url === "/api/admin/stats") {
      res.writeHead(200); return res.end(JSON.stringify({ sites: { total: sites.length, active: sites.length, verified: 0 }, items: { total: 0, posts: 0, weibo: 0, last24h: 0 }, today: { day: "smoke", feed: 0, sites: 0, ingest: 0, items: 0 }, total: { feed: 0, sites: 0, ingest: 0, items: 0 }, daily: [] }));
    }
    res.writeHead(200); return res.end(JSON.stringify({ ok: true }));
  });
}).listen(Number(port), "127.0.0.1");
' "$MOCK_LOG" "$MOCK_HUB_PORT" &
MOCK_HUB_PID=$!
for i in $(seq 1 20); do
  curl -sf -H 'Authorization: Bearer smoke-admin-token' "http://127.0.0.1:${MOCK_HUB_PORT}/api/admin/stats" >/dev/null 2>&1 && break
  [ "$i" = 20 ] && { echo "mock hub 没起来"; exit 1; }
  sleep 0.5
done

CONTROL_HOST="ops.localhost" CONTROL_PASSWORD="ctrl-pass-123" \
PLAZA_HUB_URL="http://127.0.0.1:${MOCK_HUB_PORT}" PLAZA_ADMIN_TOKEN="smoke-admin-token" \
TENANTS_CONFIG="$SMOKE_CFG" TENANTS_DIR="$SMOKE_DATA" OPS_LOG_PATH="${SMOKE_DIR}/ops.log" \
  node dist/server.js >server.smoke.log 2>&1 &
SERVER_PID=$!
for i in $(seq 1 60); do
  if curl -sf -H 'Host: main.localhost' "${BASE}/api/health" >/dev/null 2>&1; then break; fi
  [ "$i" = 60 ] && { echo "控制面服务 60 秒内没起来，server.smoke.log："; tail -50 server.smoke.log; exit 1; }
  sleep 1
done

CTRL() { # CTRL <期望> <curl 参数...>
  local want="$1"; shift
  local got
  got=$(curl -s -o /dev/null -w '%{http_code}' --resolve "ops.localhost:${PORT}:127.0.0.1" "$@" || true)
  check "控制面：$1" "$want" "$( [ "${got}" = "${want}" ] && echo "$got" || echo "$got" )"
}
cctrl() { curl -s --resolve "ops.localhost:${PORT}:127.0.0.1" "$@"; }

check "控制面未登录根路径出登录页"  200 "$(code ops.localhost /)"
check "控制面未登录访问仪表盘 303"  303 "$(code ops.localhost /login)"
check "控制面探活豁免（Caddy 签证书前提）" 200 "$(code ops.localhost '/api/health?domain=ops.localhost')"

CJAR=$(mktemp)
check "控制面登录成功 303" 303 "$(curl -s -o /dev/null -w '%{http_code}' --resolve "ops.localhost:${PORT}:127.0.0.1" -c "$CJAR" -d 'username=admin&password=ctrl-pass-123' http://ops.localhost:${PORT}/login)"
check "控制面错账户名 403" 403 "$(curl -s -o /dev/null -w '%{http_code}' --resolve "ops.localhost:${PORT}:127.0.0.1" -d 'username=nobody&password=ctrl-pass-123' http://ops.localhost:${PORT}/login)"
check "控制面错密码 403"   403 "$(curl -s -o /dev/null -w '%{http_code}' --resolve "ops.localhost:${PORT}:127.0.0.1" -d 'username=admin&password=wrong' http://ops.localhost:${PORT}/login)"
check "控制面登录后仪表盘 200" 200 "$(curl -s -o /dev/null -w '%{http_code}' --resolve "ops.localhost:${PORT}:127.0.0.1" -b "$CJAR" http://ops.localhost:${PORT}/)"
check "未配置 SITE_DIR 时仪表盘无官网卡片" 1 "$(cctrl -b "$CJAR" http://ops.localhost:${PORT}/ | { grep -c '同步 GitHub 最新版本' || true; } | awk '{print ($1==0)?1:0}')"
check "未配置 SITE_DIR 时官网同步端点 404" 404 "$(curl -s -o /dev/null -w '%{http_code}' --resolve "ops.localhost:${PORT}:127.0.0.1" -b "$CJAR" -X POST http://ops.localhost:${PORT}/website-sync)"
check "跨站 Origin 提交被拒 403" 403 "$(curl -s -o /dev/null -w '%{http_code}' --resolve "ops.localhost:${PORT}:127.0.0.1" -b "$CJAR" -H 'Origin: https://evil.example' -d 'host=new.localhost' http://ops.localhost:${PORT}/create)"

# 开站 → 热加载立即生效（免重启）；POST 走 PRG（303 回 GET），刷新不再弹「重新提交表单」；广场收录自动进行（非演示租户）
FJAR=$(mktemp)
CREATE_LOC=$(curl -s -o /dev/null -w '%{redirect_url}' --resolve "ops.localhost:${PORT}:127.0.0.1" -b "$CJAR" -c "$FJAR" -d 'host=smoke-new.localhost' http://ops.localhost:${PORT}/create)
check "开站 POST 走 PRG 303 回仪表盘" 1 "$([ "$CREATE_LOC" = "http://ops.localhost:${PORT}/" ] && echo 1 || echo 0)"
check "面板开站后新租户立即可访问（热加载）" 200 "$(code smoke-new.localhost /api/health)"
grep -q '"smoke-new.localhost"' "$SMOKE_CFG" && check "tenants.json 已落盘" 1 1 || check "tenants.json 已落盘" 1 0
CREATE_NEW_FLASH=$(curl -s --resolve "ops.localhost:${PORT}:127.0.0.1" -b "$FJAR" http://ops.localhost:${PORT}/)
check "开站 flash 含前台地址" 1 "$(printf '%s' "$CREATE_NEW_FLASH" | grep -c 'http://smoke-new.localhost/' | awk '{print ($1>0)?1:0}')"
check "开站 flash 提示广场收录" 1 "$(printf '%s' "$CREATE_NEW_FLASH" | grep -c '已自动收录进广场' | awk '{print ($1>0)?1:0}')"
check "开站自动注册进广场（mock hub 收到登记）" 1 "$(grep -q 'https://smoke-new.localhost' "$MOCK_LOG" && echo 1 || echo 0)"
check "站点 token 已写入租户库" 1 "$(node -e 'const{DatabaseSync}=require("node:sqlite");const db=new DatabaseSync(process.argv[1],{readOnly:true});const r=db.prepare("SELECT value FROM settings WHERE key=?").get("plazaToken");console.log(r&&r.value==="aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"?1:0)' "$SMOKE_DATA/smoke-new.localhost/blog.db")"

# 开站 flash 必须带上前台/后台两个完整地址（发给博主的引导话术）——经 PRG 从跳转目标 GET 回来
FJAR=$(mktemp)
curl -s -o /dev/null --resolve "ops.localhost:${PORT}:127.0.0.1" -b "$CJAR" -c "$FJAR" -d "host=flash-check.localhost" http://ops.localhost:${PORT}/create
CREATE_FLASH=$(curl -s --resolve "ops.localhost:${PORT}:127.0.0.1" -b "$FJAR" http://ops.localhost:${PORT}/)
check "开站 flash 经 PRG 送达含前台地址" 1 "$(printf '%s' "$CREATE_FLASH" | grep -c 'http://flash-check.localhost/' | awk '{print ($1>0)?1:0}')"
check "开站 flash 含后台地址" 1 "$(printf '%s' "$CREATE_FLASH" | grep -c 'http://flash-check.localhost/admin/' | awk '{print ($1>0)?1:0}')"
check "开站 flash 提示广场收录（第二个站）" 1 "$(printf '%s' "$CREATE_FLASH" | grep -c '已自动收录进广场' | awk '{print ($1>0)?1:0}')"
# flash 是一次性的：第二次 GET（无 flash cookie）不该再出现「开通成功」横幅
# （租户行本身会一直带 flash-check 域名，只认 flash 文案）
SECOND=$(curl -s --resolve "ops.localhost:${PORT}:127.0.0.1" -b "$CJAR" http://ops.localhost:${PORT}/)
check "flash 一次性（第二次 GET 无开通横幅）" 1 "$(printf '%s' "$SECOND" | grep -c 'class="flash' | awk '{print ($1==0)?1:0}')"
# 删站同步清除广场条目（同样 PRG：flash 落一次性 jar）
DJAR=$(mktemp)
curl -s -o /dev/null --resolve "ops.localhost:${PORT}:127.0.0.1" -b "$CJAR" -c "$DJAR" -d 'host=flash-check.localhost&confirm=flash-check.localhost' http://ops.localhost:${PORT}/delete
DELETE_FLASH=$(curl -s --resolve "ops.localhost:${PORT}:127.0.0.1" -b "$DJAR" http://ops.localhost:${PORT}/)
check "删站同步清除广场条目" 1 "$(printf '%s' "$DELETE_FLASH" | grep -c '广场条目已同步清除' | awk '{print ($1>0)?1:0}')"

# 广场收录同步（仪表盘按钮）：存量站补录 + 触发补漏；演示租户（demo/t1）必须被排除
SJAR=$(mktemp)
curl -s -o /dev/null --resolve "ops.localhost:${PORT}:127.0.0.1" -b "$CJAR" -c "$SJAR" -X POST http://ops.localhost:${PORT}/plaza-sync
SYNC_FLASH=$(curl -s --resolve "ops.localhost:${PORT}:127.0.0.1" -b "$SJAR" http://ops.localhost:${PORT}/)
check "广场收录同步：新收录 ops/main 两站" 1 "$(printf '%s' "$SYNC_FLASH" | grep -c '新收录 2 站' | awk '{print ($1>0)?1:0}')"
check "广场收录同步：已收录站不重复并触发补漏" 1 "$(printf '%s' "$SYNC_FLASH" | grep -c '补漏已触发' | awk '{print ($1>0)?1:0}')"
check "演示租户不进广场" 0 "$(grep -cE 'demo\.localhost|t1\.localhost' "$MOCK_LOG" || true)"
check "仪表盘广场卡含收录按钮" 1 "$(printf '%s' "$SYNC_FLASH" | grep -c '分站收录进广场' | awk '{print ($1>0)?1:0}')"

# 分站数据统计与详情页：仪表盘出数据列；详情页出完整统计与前台/后台入口
cctrl -b "$CJAR" http://ops.localhost:${PORT}/ > /tmp/ctrl-dash.html
check "仪表盘含「数据」列" 1 "$(grep -c '<th>数据</th>' /tmp/ctrl-dash.html | awk '{print ($1>0)?1:0}')"
check "仪表盘每行有前台/后台/详情按钮" 1 "$(grep -c 'admin/" target="_blank" rel="noopener">后台' /tmp/ctrl-dash.html | awk '{print ($1>0)?1:0}')"
check "仪表盘空库租户显示零值口径" 1 "$(grep -c '0 文 · 0 微博' /tmp/ctrl-dash.html | awk '{print ($1>0)?1:0}')"
check "仪表盘零内容租户显示「未发布过」" 1 "$(grep -c '未发布过' /tmp/ctrl-dash.html | awk '{print ($1>0)?1:0}')"
DET=$(cctrl -b "$CJAR" "http://ops.localhost:${PORT}/tenant?host=smoke-new.localhost")
check "分站详情页 200 含前台/后台入口" 1 "$([ "$(cctrl -o /dev/null -w '%{http_code}' -b "$CJAR" "http://ops.localhost:${PORT}/tenant?host=smoke-new.localhost")" = 200 ] && printf '%s' "$DET" | grep -c '打开后台管理' | awk '{print ($1>0)?1:0}')"
check "详情页含统计卡（文章/微博/PV）" 1 "$(printf '%s' "$DET" | grep -c '近 30 日访问' | awk '{print ($1>0)?1:0}')"
check "详情页含管理员状态" 1 "$(printf '%s' "$DET" | grep -c '管理员账号' | awk '{print ($1>0)?1:0}')"
check "详情页未知 host 404" 404 "$(cctrl -o /dev/null -w '%{http_code}' -b "$CJAR" "http://ops.localhost:${PORT}/tenant?host=not-in-config.localhost")"
check "详情页路径穿越形态 404" 404 "$(cctrl -o /dev/null -w '%{http_code}' -b "$CJAR" "http://ops.localhost:${PORT}/tenant?host=..%2F..%2Fetc")"
check "未登录访问详情页 303" 303 "$(curl -s -o /dev/null -w '%{http_code}' --resolve "ops.localhost:${PORT}:127.0.0.1" "http://ops.localhost:${PORT}/tenant?host=smoke-new.localhost")"

# 首访建管理员 → 面板重置密码 → 新密码可登录
# （setup 带 JSON 的 POST 走同源校验，curl 默认不发 Origin，天然同源；无 Origin 即放行）
curl -s -o /dev/null --resolve "smoke-new.localhost:${PORT}:127.0.0.1" -H 'Content-Type: application/json' \
  -d '{"username":"owner","password":"old-pass-123"}' http://smoke-new.localhost:${PORT}/api/auth/setup
# 重置同样走 PRG：跟随 303 从跳转目标取 flash（一次性 cookie 单独 jar）
RJAR=$(mktemp)
curl -s -o /dev/null --resolve "ops.localhost:${PORT}:127.0.0.1" -b "$CJAR" -c "$RJAR" -d 'host=smoke-new.localhost' http://ops.localhost:${PORT}/reset
curl -s --resolve "ops.localhost:${PORT}:127.0.0.1" -b "$RJAR" http://ops.localhost:${PORT}/ > /tmp/ctrl-reset.html
# grep 无匹配 exit 1 会触发 set -e 静默退出（曾在此断言后无声死掉）——必须 || true
NEWPASS=$(grep -o '<code style="font-size:18px">[^<]*' /tmp/ctrl-reset.html | head -1 | sed 's/.*>//' || true)
check "重置密码输出一次性新密码" 1 "$([ -n "$NEWPASS" ] && echo 1 || echo 0)"
# 旧密码已失效（登录失败统一 401「用户名或密码不对」）
check "旧密码登录已失效" 401 "$(curl -s -o /dev/null -w '%{http_code}' --resolve "smoke-new.localhost:${PORT}:127.0.0.1" -H 'Content-Type: application/json' -d '{"username":"owner","password":"old-pass-123"}' http://smoke-new.localhost:${PORT}/api/auth/login)"
# 新密码可登录（payload 先落变量再引用，避免 check 的 $( ) 里双层引号转义吃掉 JSON 花括号）
NEWLOGIN=$(printf '{"username":"owner","password":"%s"}' "$NEWPASS")
check "新密码可登录该站后台" 200 "$(curl -s -o /dev/null -w '%{http_code}' --resolve "smoke-new.localhost:${PORT}:127.0.0.1" -H 'Content-Type: application/json' -d "$NEWLOGIN" http://smoke-new.localhost:${PORT}/api/auth/login)"

# 停用 → 404；启用 → 200；停用同步隐藏广场条目（PRG：flash 落一次性 jar）
DBJAR=$(mktemp)
curl -s -o /dev/null --resolve "ops.localhost:${PORT}:127.0.0.1" -b "$CJAR" -c "$DBJAR" -d 'host=smoke-new.localhost' http://ops.localhost:${PORT}/disable
DISABLE_FLASH=$(curl -s --resolve "ops.localhost:${PORT}:127.0.0.1" -b "$DBJAR" http://ops.localhost:${PORT}/)
check "停用后该站 404" 404 "$(code smoke-new.localhost /api/health)"
check "停用后配置仍保留（disabled 标记）" 1 "$(grep -q '"disabled": true' "$SMOKE_CFG" && echo 1 || echo 0)"
check "停用同步隐藏广场条目" 1 "$(printf '%s' "$DISABLE_FLASH" | grep -c '广场条目已同步隐藏' | awk '{print ($1>0)?1:0}')"
cctrl -b "$CJAR" -d 'host=smoke-new.localhost' http://ops.localhost:${PORT}/enable > /dev/null
check "启用后恢复访问" 200 "$(code smoke-new.localhost /api/health)"

# 删除：确认域名不匹配不动手；匹配才删（配置 + 目录）
cctrl -b "$CJAR" -d 'host=smoke-new.localhost&confirm=wrong.example' http://ops.localhost:${PORT}/delete > /dev/null
check "确认域名不匹配不删除" 1 "$([ -d "$SMOKE_DATA/smoke-new.localhost" ] && echo 1 || echo 0)"
cctrl -b "$CJAR" -d 'host=smoke-new.localhost&confirm=smoke-new.localhost' http://ops.localhost:${PORT}/delete > /dev/null
check "确认匹配后删除数据目录" 1 "$([ ! -d "$SMOKE_DATA/smoke-new.localhost" ] && echo 1 || echo 0)"
check "删除后配置移除" 1 "$(grep -q 'smoke-new.localhost' "$SMOKE_CFG" && echo 0 || echo 1)"
check "删除后路由 404" 404 "$(code smoke-new.localhost /api/health)"
check "操作日志已记录" 1 "$(grep -q '"action":"删除"' "${SMOKE_DIR}/ops.log" && echo 1 || echo 0)"

kill ${SERVER_PID} 2>/dev/null || true
# Windows 上刚被 kill 的进程句柄释放有延迟，临时目录清理失败不算冒烟失败
rm -rf "$SMOKE_DIR" /tmp/ctrl-reset.html 2>/dev/null || true

echo
echo "结果：PASS=${PASS} FAIL=${FAIL}"
[ "$FAIL" = 0 ]
