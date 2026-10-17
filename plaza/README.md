# 博客号广场 hub

独立 Worker：聚合各博客号的公开文章与微博，供官网 **bloghao.com/plaza** 展示。

- 协议、部署步骤、管理端点用法：**docs/PLAZA.md**（仓库根）
- `src/core.ts` 是纯函数模块（签名校验 / 混排评分 / RSS 解析 / 入参校验），`tests/plaza-hub.test.ts` 直接导入测试
- `wrangler.jsonc` 里的 `database_id` 要换成你自己的 plaza-db，`routes` 按需改域名

快速部署：

```bash
npx wrangler d1 create plaza-db
# 把返回的 database_id 填进 wrangler.jsonc
npx wrangler d1 execute DB --remote --file schema.sql
npx wrangler secret put PLAZA_ADMIN_TOKEN
npx wrangler secret put PLAZA_HASH_SECRET   # 可选但建议：点赞/曝光天级哈希私盐
npx wrangler deploy
```
