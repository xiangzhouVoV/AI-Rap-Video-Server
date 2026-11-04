# Cloudflare 后端技术方案

更新日期：2026-11-04（Asia/Shanghai）

项目：`/Users/zhouxiang/code/GTS/AI-Rap/AI-Rap-Video-Server`  
前端：`/Users/zhouxiang/code/GTS/AI-Rap/AI-Rap-Video`  
当前状态：独立认证后端已部署到 Cloudflare，D1 远程迁移、生产 Secrets、Google OAuth 回调和同域路由已配置；用户已确认正式域名的真实 Google 登录、刷新保持登录和退出界面正常。

## 1. 需求理解

### 用户已确认的范围

- 创建独立后端项目，与现有前端项目同级；项目名称由用户确定为 `AI-Rap-Video-Server`。
- 目标部署在 Cloudflare，免维护传统服务器。
- 首版完成真实生成闭环：照片上传 → 提交视频生成任务 → 查询任务状态 → 预览与下载结果；覆盖失败反馈和重试。
- 首版不接入支付和积分，这两项在后续阶段接入。
- 视频生成平台已选定 SeeAPI，具体模型及生成链路后续实现。

确认依据：用户于 2026-10-28 回复“新创建一个项目 和api-rap-video 同级”，选择“先完成真实生成闭环，支付与积分后续接入”，并回复供应商“未定”。父目录检查只有 `AI-Rap-Video` 与本任务对应，因此按该项目的同级目录创建。随后用户要求移动到已有的 `AI-Rap-Video-Server` 仓库，并新开会话继续。

### 前端既有需求基线

来源：前端仓库 `docs/requirements-v2.1.md`。以下是已有需求记录，不代表本次已经选定了供应商实现方式。

- 支持单张照片模板和双张照片热梗模板；照片上传、模板预览和模板切换不发起生成，用户点击 Generate 后才提交任务。
- 保留生成中、成功、失败与重试状态；支持 iPhone HEIC 图片。
- 原需求包含“第一条免费”、免费档单条生成成本 $0.30–0.50、付费档成本上限 $1.50；付费相关内容在本次首版范围外。
- 保持现有页面内容与搜索引擎可读 HTML 要求。

### 仍需明确的业务信息

以下暂不设定默认业务规则，也不阻止继续讨论方案：

- “第一条免费”的身份识别、额度和失败重试口径。
- 视频供应商能否满足所需模板、双图输入、时长、比例、清晰度、水印与成本要求。
- 用户照片与成片保留时长；是否需要生成完成的邮件通知。

## 2. 当前实施范围

用户已明确本场景不采用 new-business-technical-design 的阶段审批流程，后续以对话确认的范围推进。
2026-11-01 用户要求先实现 Google 登录，由独立后端建立自己的会话。随后将本阶段收敛为让正式域名登录可用，并于 2026-11-04 完成登录、刷新保持登录和退出的浏览器基本验收。

- 后端：Hono + Cloudflare Workers + Better Auth 1.7.14 + D1 原生 binding。
- 前端：新增登录、当前用户展示、退出以及失败重试入口；本地仅将 `/api/auth/*` 和 `/api/me` 代理到独立后端。
- Better Auth 管理 user/session/account/verification；数据库限流额外使用 rateLimit 表。
- 本地浏览器固定 `http://localhost:3000`；后端监听 8787；正式环境使用同源路径路由。
- 用户身份来自服务端会话，`GET /api/me` 未登录返回 401；Google 回调不受业务登录拦截。
- 保留 Origin/CSRF/state 检查，Cookie 为 HttpOnly/SameSite=Lax，HTTPS 使用 Secure，认证响应不缓存。
- 迁移由官方 SQL 生成器产生；`0001_auth.sql` 已应用到生产 D1 `ai-rap-video-auth`。
- 生产 `BETTER_AUTH_URL` 为 `https://airaptovideo.app`，后端 Worker `ai-rap-video-server` 接管 `https://airaptovideo.app/api/auth/*` 与 `https://airaptovideo.app/api/me*`。
- 生产凭据通过忽略 Git 的 `.secrets.production.json` 和 Wrangler `deploy --secrets-file` 写入 Workers Secrets。

## 3. 后续链路（方案草案）

已讨论：私有 R2 保存图片和成片，Workflows 调用 SeeAPI，完成回调与查询兜底，前端查询后端任务状态。
本次不实现上传、视频生成、支付积分，也不把前端既有匿名演示接口视为已经接入 Google 会话。
具体模型、额度限制、照片和成片保留时间仍待后续设计。

## 4. 平台事实核实

本节是截至 2026-10-28 的平台事实与候选能力，不表示已选定全部组件或已验证项目兼容性。

### 部署边界

- 独立后端可使用 Cloudflare Workers 承载 API；R2 提供对象存储，D1 提供关系数据存储，Queues 提供异步消息能力。具体组合待设计阶段确定。
- 完整 Next.js 前端的部署由前端项目单独处理。Cloudflare 当前推荐 vinext on Workers，vinext 仍为 beta，需要兼容性验证；Pages 文档对应 Next.js 静态导出。独立后端本身不需要先迁移 Next.js。
- 视频生成建议由外部视频 API 执行，Worker 处理任务调度。HTTP 响应结束后 `waitUntil()` 最多延长 30 秒，不适合充当可靠的长时间后台任务执行机制；具体采用供应商回调还是分次查询，需要看供应商接口能力。
- Cloudflare Images 官方支持 HEIC 输入，是图片处理的候选能力。现有 `sharp`、`heic-convert` 是否能够沿用，尚未做 Workers 兼容性验证。

来源：

- [Cloudflare Workers：Next.js](https://developers.cloudflare.com/workers/framework-guides/web-apps/nextjs/)
- [Cloudflare Pages：Next.js](https://developers.cloudflare.com/pages/framework-guides/nextjs/)
- [Workers 运行限制](https://developers.cloudflare.com/workers/platform/limits/)
- [Cloudflare Images 格式支持](https://developers.cloudflare.com/images/get-started/limits/)

### 免费额度与费用边界

| 服务 | 官方免费额度 | 说明 |
| --- | --- | --- |
| Workers | 每日 10 万请求；每次 10ms CPU | Paid 从 $5/月起；应根据实际 CPU 与请求量决定套餐 |
| R2 Standard | 每月 10 GB-month 存储、100 万 A 类操作、1000 万 B 类操作 | 公网流出免费；免费额度不适用于 Infrequent Access |
| D1 | 每日读取 500 万行、写入 10 万行；总存储 5GB | 行读取按扫描行数计算，不等于 API 请求数 |
| Queues | 每日 1 万次操作；消息保留 24 小时 | 通常一条消息需要写、读、删除三次操作；重试另计 |

不能仅凭“第一周”判断是否免费：需要估算访问量、状态查询频率、图片与视频大小、保留时长和 CPU 用量。外部视频 API、图片处理及邮件服务费用另计，不能视作包含在 Workers/R2 免费额度中。

来源：

- [Workers 定价](https://developers.cloudflare.com/workers/platform/pricing/)
- [R2 定价](https://developers.cloudflare.com/r2/pricing/)
- [D1 定价](https://developers.cloudflare.com/d1/platform/pricing/)
- [Queues 定价](https://developers.cloudflare.com/queues/platform/pricing/)

## 5. 当前验证与下一步

启动与部署操作见 [后端 README](../README.md)。
本地开发仍需单独配置 `.dev.vars` 和 localhost OAuth 回调；生产环境已使用正式域名凭据。
2026-11-01 验证结果：

- 后端 TypeScript 检查、13 项隔离 D1 集成测试、Worker dry-run 构建通过。
- 集成测试覆盖模拟 Google 授权码/PKCE/state 流程、首次与重复登录、Cookie 鉴权、过期与退出撤销、Origin 和回跳白名单。
- 前端 TypeScript、27 项测试和 Next.js 生产构建通过；代理 Cookie/Origin/多条 Set-Cookie/重定向验证通过。
- Chrome 手机与桌面界面已通过模拟登录、用户展示、退出、失败重试检查。
- 本地 workerd 已启动验证：health 返回 200；未配置 Google 凭据时 auth 和 me 返回 503，并禁止缓存。
- 当时 `.dev.vars` 已生成随机会话密钥且不入库；Google 凭据尚未配置，因此当时未验证真实 Google 账号授权。
- 本机默认 Node 20 不满足新 Wrangler 要求，本轮用已有 Node 24.19.0 验证；项目要求 Node >=22.12，提供 `.nvmrc`。

2026-11-04 正式环境验证结果：

- D1 `ai-rap-video-auth` 已创建，ID 为 `d8aeecdc-1bb7-47c5-b508-2d33e5533079`；用户执行远程迁移成功。
- Google Web 客户端的来源为 `https://airaptovideo.app`，回调为 `https://airaptovideo.app/api/auth/callback/google`。
- 后端已发布，截图确认两条同域认证路由生效；发布前 TypeScript 检查和带生产配置的 Worker dry-run 构建通过。
- 未携带会话的线上 `/api/me` 返回 401 JSON，`/api/auth/get-session` 返回 200 JSON `null`，均为 `Cache-Control: no-store`；`/login` 返回 200。
- 用户完成真实 Google 登录，页面显示 Sean；刷新后仍显示 Sean；点击 Sign out 后恢复 Sign in。
- 生产凭据文件仅本机用户可读写，已忽略 Git；文档不记录密钥值。

本阶段正式域名登录目标已完成。生产数据库内首次/重复登录记录和退出后旧会话被拒绝未额外逐项核验，相关行为已有隔离 D1 集成测试覆盖。
下一阶段范围仍是上传与真实视频生成链路，具体实施按用户后续指令推进。
