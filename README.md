# AI-Rap-Video-Server

AI-Rap-Video 的独立 Cloudflare Workers 后端，使用 Hono + Better Auth 1.7.14 + 原生 D1。
前端项目位于同级 `../AI-Rap-Video`。本次实现 Google 登录、D1 用户及会话、获取当前用户和退出登录。
视频平台已选择 SeeAPI；视频生成、上传、支付和积分不属于本次代码范围。

## 本地启动

需要 Node.js >= 22.12（推荐 Node 24，已提供 `.nvmrc`）。系统 Node 20 不能运行本项目 Wrangler。

```sh
npm ci
cp .dev.vars.example .dev.vars # 已存在时跳过，不要覆盖现有密钥
openssl rand -base64 32       # 把生成值填入 BETTER_AUTH_SECRET
npm run db:migrate:local
npm run dev
```

本地开发使用忽略 Git 的 `.dev.vars`，与生产环境的 `.secrets.production.json` 分开配置。
在 `.dev.vars` 填写 `GOOGLE_CLIENT_ID`、`GOOGLE_CLIENT_SECRET`；不要提交或在聊天中发送密钥。
`BETTER_AUTH_URL` 保持 `http://localhost:3000`，即浏览器公开地址，而不是后端内部端口。

Google Cloud Console 创建 **Web application** OAuth 客户端，登记：

- Authorized JavaScript origin：`http://localhost:3000`。
- Authorized redirect URI：`http://localhost:3000/api/auth/callback/google`。

前端 `.env.local` 配置 `AUTH_BACKEND_URL=http://127.0.0.1:8787`，重启前端 `npm run dev` 后从
`http://localhost:3000` 访问。使用 localhost 这一固定地址，不要混用 127.0.0.1 或临时切换端口。
前端只代理 `/api/auth/*` 和 `/api/me`，现有上传/生成 API 本次保持原逻辑。

## 认证接口与数据

- `POST /api/auth/sign-in/social`：Better Auth Google 登录入口（前端使用官方客户端）。
- `GET /api/auth/callback/google`：Google OAuth 回调，由 Better Auth 校验 state 和授权码。
- `GET /api/auth/get-session`：官方客户端读取当前会话；未登录返回 null。
- `POST /api/auth/sign-out`：注销数据库会话并清除 Cookie。
- `GET /api/me`：受保护业务接口，未登录返回 401，登录后返回公开用户信息和会话 ID/到期时间，不返回会话 token。
- `GET /api/health`：进程健康检查，不代表 OAuth 配置或 D1 已可用。

D1 迁移包含 `user`、`session`、`account`、`verification` 以及数据库限流使用的 `rateLimit`。
会话 Cookie 为 HttpOnly、SameSite=Lax，HTTPS 环境启用 Secure；未开启 Cookie 会话缓存，退出以 D1 状态为准。
仅启用 Google 登录；保留 Better Auth 默认 Origin、CSRF 和 OAuth state 校验，不启用密码注册。
认证和用户响应使用 `Cache-Control: no-store`。未填写凭据时认证接口返回明确的 503。

## 迁移与检查

```sh
npm run cf:types
npm run verify
# 修改认证配置后，先使本地库处于已应用的历史迁移状态，再生成新迁移：
npm run db:generate -- 0002_auth.sql
npm run db:migrate:local
```

`scripts/generate-auth-schema.ts` 调用 Better Auth 官方 `getMigrations`（与 CLI 使用相同生成器），
经 Wrangler 连接本地 D1，生成 SQL 而不执行迁移，并拒绝覆盖旧迁移文件。
这样避开当前 CLI 配置加载器与 Wrangler/Miniflare 的导入兼容问题。空库首次生成时库检查会提示缺表，随后生成迁移。
生成配置中的占位凭据仅用于 schema 生成，不会被 Worker 导入或用于实际登录。

测试使用独立临时 D1，验证 OAuth 起始状态、会话鉴权、退出、过期和来源/回跳限制。
自动化测试不能替代真实 Google 授权。正式域名的登录、刷新保持登录和退出界面已由用户验证；首次登录的数据库记录、重复登录复用用户及退出后旧会话被拒绝目前由集成测试覆盖，本轮未在生产环境逐项核验。

## Cloudflare 正式环境

截至 2026-11-04（Asia/Shanghai），正式域名的 Google 登录已部署并完成浏览器基本验收。

| 配置 | 正式环境值 |
| --- | --- |
| 站点 / `BETTER_AUTH_URL` | `https://airaptovideo.app` |
| 后端 Worker | `ai-rap-video-server` |
| D1 数据库 | `ai-rap-video-auth` |
| D1 ID | `d8aeecdc-1bb7-47c5-b508-2d33e5533079` |
| 已应用远程迁移 | `0001_auth.sql` |
| Google JavaScript origin | `https://airaptovideo.app` |
| Google OAuth 回调 | `https://airaptovideo.app/api/auth/callback/google` |
| Worker Routes | `https://airaptovideo.app/api/auth/*`、`https://airaptovideo.app/api/me*` |

前端 Worker 继续承载页面；上述路由将认证请求交给独立后端，无需跨域 Cookie。
`workers_dev` 已关闭，`/api/health` 未配置正式域名路由。

生产凭据位于本机 `.secrets.production.json`，包含 `GOOGLE_CLIENT_ID`、`GOOGLE_CLIENT_SECRET`、`BETTER_AUTH_SECRET`，文件权限为 `0600`，已加入 `.gitignore`。
部署时通过 `--secrets-file` 写入 Workers Secrets，不把凭据写进 `wrangler.jsonc` 或提交到 Git。
日常发布复用已有 `BETTER_AUTH_SECRET`，不要重新生成。

在后端项目目录执行以下命令发布；Node 24 包用于兼容本机默认 Node 20：

```sh
npx --yes --package=node@24 node ./node_modules/wrangler/bin/wrangler.js deploy --secrets-file .secrets.production.json
```

`0001_auth.sql` 已成功应用到远程库。后续有新增迁移时，先检查 SQL，再在发布前应用：

```sh
npx --yes --package=node@24 node ./node_modules/wrangler/bin/wrangler.js d1 migrations apply DB --remote
```

本轮正式环境验证结果：

- 未携带会话请求 `/api/me`：401 JSON `UNAUTHORIZED`，响应不缓存。
- 未携带会话请求 `/api/auth/get-session`：200 JSON `null`，响应不缓存。
- `/login` 页面返回 200。
- 用户完成真实 Google 登录，页面显示 Sean；刷新后仍显示 Sean。
- 用户点击 Sign out 后，页面恢复 Sign in。

以上完成本阶段登录验收。上传、视频生成、支付和积分仍按后续阶段推进。
