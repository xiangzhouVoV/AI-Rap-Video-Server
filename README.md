# AI-Rap-Video-Server

AI-Rap-Video 的独立 Cloudflare Workers 后端，使用 Hono + Better Auth 1.7.14 + 原生 D1。
前端项目位于同级 `../AI-Rap-Video`。提供 Google 登录、D1 用户及会话，以及 24K Magic 模板调试接口。
模板使用 SeeAPI Seedance 2.0 reference-to-video，支持私有素材上传、真实生成、任务恢复和结果保存。
套餐、站内积分扣减和支付尚未实现；模板生成限开发环境或配置的测试账号使用。

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
前端代理 `/api/auth/*`、`/api/me`、`/api/templates/*`、`/api/template-media/*` 和 `/api/template-generations/*`。
打开 `http://localhost:3000/effects/24k-magic`，登录后可调试。新模板不经过旧的样片生成接口。

## SeeAPI 接入准备

生产 Worker 已通过控制台配置 `SEEAPI_API_KEY`（Secret）和 `SEEAPI_API_BASE_URL`（普通变量）。
`wrangler.jsonc` 同步保存 API 地址 `https://api.seeapi.com`，真实 Key 不写入该文件。

本地调试前，在现有 `.dev.vars` 追加以下配置，保留原有 Google 登录配置：

```dotenv
SEEAPI_API_BASE_URL=https://api.seeapi.com
SEEAPI_API_KEY=填写自己的完整Key
```

当前 Wrangler 部署会保留已配置的线上 Secret；本地验证只需填写 `.dev.vars`。
如需从本机统一管理或重新写入生产凭据，可在 `.secrets.production.json` 的现有 JSON 对象中
追加 `SEEAPI_API_KEY` 属性，再使用下方 `deploy --secrets-file` 流程。
不要将真实 Key 写入 `.dev.vars.example` 或提交到 Git。

2026-11-04 已从本地使用 `.dev.vars` 中的 Key 调用 `GET /v1/credits`，返回 HTTP 200，
并成功读取 `total_credit`、`debt_credit`、`display_credit`。该请求不创建视频生成任务。
此结果验证了本地凭据与 SeeAPI 的连接；尚未验证生产 Worker 的出站调用，
该历史检查不代表本次模板已经完成真实视频生成验收。
接口约定见 [SeeAPI 官方接入文档](https://www.seeapi.com/docs/getting-started/)。

## 模板调试

先应用本地迁移 `0002_template_lab.sql`。在 `.dev.vars` 配置 SeeAPI 后，页面可提交真实任务。
24K Magic v4 用两张单人照分别扮演甲板上的舞者和门口观看的搭档。后台参考片为宽屏卡通，成片为 16:9，可选 480p 或 720p。开场与门口反应各提交 11 秒的生成，按原片第 302 帧与第 605 帧（30 fps）拼接成约 20.17 秒，铺入原片的连续音轨。

固定素材保存在私有 R2 的 `templates/24k-magic/v4/` 目录，分别为 `opening.mp4`、`finale.mp4` 和 `reference-audio.m4a`。服务端检查三件素材，签发给供应商的短时视频地址仅对对应版本与片段有效。设置 `CRUISE_PAUSED_CLIP_KEY` 可按完整对象键暂停某段素材的付费生成。

v3 任务按其原有 4:3 参考片、音轨与 26.554 秒时间线处理。v3 开场因真人审核暂停。已经提交的任务仍可查询和保存，已保存的两段仍可拼接。

- `TEMPLATE_DEBUG_EMAILS` 指定获准调试的 Google 邮箱。localhost 允许已登录开发者。
- `MEDIA_PUBLIC_BASE_URL` 应指向提供素材读取服务的同一 Worker 和存储环境。线上同域部署可以省略。本地端到端运行可通过 HTTPS 隧道将该 Worker 提供给供应商，同时在本地 R2 放入同名素材。
- 照片为 JPEG/PNG/WebP，每张最大 10 MiB；Images 解码、缩放为最长边 2048 的静态 WebP，并移除元数据。

接口（除带临时令牌的素材内容读取外，都需要会话和调试权限）：

| 接口 | 用途 |
| --- | --- |
| `GET /api/templates/24k-magic` | 成片规格、当前账号及生成能力 |
| `POST /api/template-media` | multipart `file` + `kind=photo/video/audio` 上传 |
| `GET /api/template-media/:id/preview` | 本人素材预览，支持 HEAD/Range |
| `GET /api/template-media/:id/content?token=…` | 供应商读取素材，单文件令牌 24 小时有效 |
| `POST /api/template-generations` | 保存输入后调用 SeeAPI，需 UUID `requestId` |
| `GET /api/template-generations/:id` | 以任务 ID 或 requestId 查询/恢复同一账号任务 |
| `POST /api/template-generations/:id/retry` | 用户显式重试未完成的部分，携带 UUID `retryId` |
| `GET /api/template-generations/:id/video` | 本人生成结果，支持 HEAD/Range，`?download=1` 下载 |

v4 新建请求包含 `templateId`、`templateVersion: 4`、`requestId` 和可选的 `resolution`（默认 `720p`）。舞者照片使用 `photoId` 或 `photoUrl`，搭档照片使用 `partnerPhotoId` 或 `partnerPhotoUrl`。两张均为必填，并在两次供应商请求中保持舞者、搭档的顺序。
API Key 仅用于服务端调用，不返回浏览器。素材与结果在私有 R2 中；临时令牌到期只停止外部读取，不自动删除存储对象。

费用与恢复规则：

- 相同 `requestId` 只能对应相同输入；服务端固定 SeeAPI `Idempotency-Key` 和原始请求正文。超时用原任务恢复，不能自动创建新任务。
- D1 租约防止并发轮询覆盖结果；同一账号最多两个活动任务。页面刷新后从账号隔离的浏览器记录恢复，记录只含任务 ID。
- 视频成功后分段保存到 R2（最多 100 MiB）。保存失败保留供应商任务，后续查询继续保存，不重新生成。
- 只有供应商明确返回的 `estimated_credits/consumed_credits/refunded_credits` 才入账展示；缺失字段保留未知，失败不等于免费或已退款。
- 页面可查询进度；每两分钟的定时任务也会推进未完成的 v3 和 v4 任务。每段生成使用独立幂等键。明确失败的生成由用户决定是否重试，已成功保存的片段及自动拼接不会再次提交给供应商。
- SeeAPI 积分不是未来出售给用户的站内积分。参考视频输入时长也影响成本，详见 [Seedance 2.0 参数与计费](https://www.seeapi.com/docs/seedance-2/reference-to-video/)。

此调试页保留 canonical/描述/OG，但设置 `noindex, nofollow`；完成样片、参考素材和费用规则验收后再开放搜索收录。

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
npm run db:generate -- 0003_auth.sql
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

以上为历史登录验收。本次模板接口的代码和路由已准备，尚未应用远程 `0002_template_lab.sql` 或发布。
正式发布前需配置 `TEMPLATE_DEBUG_EMAILS`，应用远程迁移并同步前后端；生产 R2 bucket 和 Images binding 也必须可用。
