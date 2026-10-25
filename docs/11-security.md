# Word 安全防护与验证边界

更新：2026-10-25。范围仅为 `word.yanxai.com` 及 Word 仓库，不操作其它站点、根域设置、账号凭据或签名私钥。

## 架构与实际暴露面

Word 使用 Cloudflare Workers Static Assets 托管公开静态资源，没有业务 Worker、登录接口、服务器上传接口或在线学习数据库。词典在浏览器读取，学习记录、备份恢复和复述录音在本机处理。因此当前没有可供 SQL 注入、后台登录爆破、服务器上传执行的业务入口；这不等于浏览器、依赖、发布账号或未来增加的后端不会出现漏洞。

不为“防扫描”给每个静态请求增加 Worker 执行层。静态资产本身不计 Worker 脚本请求；`run_worker_first` 会消耗脚本调用额度，免费额度耗尽可能影响可用性。本站继续保持原来的纯静态部署及关闭 `workers.dev`/预览地址，不增加数据库、收费服务或全域机器人挑战。

## 已实施的应用与发布防护

| 层面 | 措施 | 范围与限制 |
| --- | --- | --- |
| 脚本与外联 | 强制 CSP，脚本仅本站及本机 Blob 模块，连接仅本站；禁内联脚本、内联事件、普通 JS eval、插件对象、表单提交及 base URL 改写 | ASR 必须允许 Blob 模块与 `wasm-unsafe-eval`，它不等于放行 JS `unsafe-eval`；现有布局保留内联样式能力。CSP 不能代替输入校验 |
| 页面嵌入 | `frame-ancestors 'none'` 与 `X-Frame-Options: DENY` | 阻止其它网页套 iframe，不妨碍顶层 Chrome/TWA 页面 |
| 传输与资源类型 | Word 响应 HSTS 一年、`nosniff`、`no-referrer` | 不使用影响其它域的 `includeSubDomains` 或 preload；HTTP→HTTPS 另行核验。保留 APK/JSON 正确 MIME 与下载附件头 |
| 设备权限 | 麦克风、分享、剪贴板写入与音频仅本站；禁相机、定位、屏幕捕获、支付、USB 等无关能力 | 允许权限不等于自动获取权限，仍由真实用户操作和浏览器授权；不添加 COEP/跨域隔离要求 |
| 外部输入 | React 文本渲染；备份读取前限制 16 MiB、严格结构/引用校验、原子恢复；词典许可文件只允许安全本站路径 | 许可路径兼容现有 `/licenses/...`，拒绝脚本协议、外域、双斜杠与穿越，不重置缓存或学习记录 |
| 资源完整性 | 词典、ASR 分片校验，APK 哈希及真实签名/证书关联核验 | 哈希可以发现损坏或清单不一致，不能防止有发布权限的人同时替换程序和清单 |
| 离线缓存 | SW 只缓存公开资源，不缓存 APK/DAL，不上传进度或录音；缓存的首页保留安全头 | `_headers` 纳入版本哈希；已打开旧版本的页面须正常完成更新激活后才获得新策略 |
| 发布目录 | 构建拒绝隐藏目录、密钥/数据库/备份/源码映射等明确私有文件，以及符号链接；CI 运行针对性测试 | 检查文件名和目录类型，不读取密钥内容，也不是能识别任何秘密的通用扫描器。仅排除 `.gitignore` 与已知词典 `.building-<32hex>` 暂存目录，不删除原文件或旧词包 |
| 依赖 | 锁定依赖并运行 npm audit | 当前检查为已知公告的时间快照，不能证明没有未知漏洞；不为此批量升级依赖 |

Zod 在应用 schema 初始化之前启用官方 `jitless` 配置，避免它探测 `new Function` 即使捕获错误仍产生 CSP 违规；不为消除警告放行 JS eval。`web-share` 权限指令尚非所有浏览器支持：本机 Chrome 能检测并分享 PNG，但不识别这条策略指令，因此只记录实际能力，不虚报此浏览器已执行分享权限限制。页面防嵌入与用户手势要求仍有效。

安卓 APK 沿用现有 Word 专用签名及浏览器数据，安装包字节不因本轮网页安全头变化而重新签名。Word 签名材料仍在忽略目录，不进入发布目录或 Git。语音、麦克风、分享等实际手机行为不能由桌面浏览器检查代替。

## Cloudflare 边缘防护：已观察到与尚未确认的部分

本轮上线前公网小规模检查中，`/.env`、`/.git/config`、`/wp-login.php`、`/wp-admin/` 均返回 403；随机不存在路径返回 404，HTTP 首页 301 跳转 HTTPS。正常首页、APK 和安卓关联 JSON 可访问。403 是这些测试请求被拒绝的证据，不足以确定具体命中的规则名称，也不表示所有扫描均已覆盖或曾发生入侵。

Cloudflare 为接入其代理的站点提供平台级 DDoS 防护，但本轮不进行压力攻击或宣称已经扛住某个流量规模。管理浏览器连接不可用，独立 `cf` CLI 没有现成授权；保留现有 Wrangler 发布授权，不读取其凭据、不创建新授权、不冒充已查看 WAF 后台、Security Events 或账号 MFA 状态。本轮没有更改现有 WAF 规则。

后续后台复核应按以下顺序做，不能用全域开关替代 Word 范围：

1. 检查现有自定义规则、已使用配额与事件，确认上述 403 命中规则。危险配置路径、`.git`/`.svn`、WordPress/PHP 等不存在的后台探测可 Block；规则须以 `http.host eq "word.yanxai.com"` 限定，不重复覆盖已有规则。
2. 静态站无写接口，可核对是否需要对 Word 阻止 GET/HEAD/OPTIONS 之外的方法；正常资源、`/.well-known/assetlinks.json`、APK、模型和字体下载都应做放行回归。
3. 免费套餐限流规则的表达式字段不足以按 Host 独立限制 Word；不能为本任务误限整个 zone。字体有多分片、模型有大文件重试，过低阈值会拦正常初次下载。确认当前套餐与合法访问分布后才设置有范围的 CC 规则。
4. 不启用全域 Bot Fight Mode：它影响整个域，不能用普通 WAF Skip 对单一路径排除，可能误伤移动端或程序化关联请求。不按国家、VPN、User-Agent 或空 Referer 简单封禁正常使用者。
5. 管理员在 Cloudflare 与 GitHub 使用 MFA/passkey、最小发布权限和安全的恢复方式，单独保管 Word 签名；这是账号层工作，本轮没有修改账号或声称这些项目已启用。

## 验证与运维

常规发布运行 `npm run lint`、`npm test`、`npm run test:security`、`npm run build`。安全浏览器检查使用真正执行 `_headers` 的 Cloudflare 本地服务，而不是不读取该文件的 Vite preview：

```powershell
npm exec --yes --package=wrangler@4.151.3 -- wrangler dev --local --ip 127.0.0.1 --port 8787
node tools/security-smoke.mjs
```

`security-smoke` 核验 HTTP 头、浏览器权限、真实 DOM 内联脚本/事件被拒绝、跨源 iframe 被拒绝、离线响应策略保留和 APK/DAL 字节。正常页面违规与故意注入测试产生的违规分开记录。真实录音识别由 `tools/retell-smoke.mjs` 检查；分享 PNG/二维码由 `tools/check-in-share-smoke.mjs` 检查，原生磁盘保存和系统分享限制必须另报。输出位于任务的 `outputs/word-security/`，不提交用户历史或录音。

生产复验还包括公开文件字节、响应头、HTTP 跳转与无害扫描样例。浏览器只能通过本机已配置代理访问公网时必须记录该网络条件，不能宣称无条件直连或所有手机已通过。不要因为扫描数量上升就断言被攻破；需要将 Cloudflare 动作/规则与真正的应用或发布异常联系起来。

官方依据：[静态资源响应头](https://developers.cloudflare.com/workers/static-assets/headers/)、[静态资产计费与 Worker 限制](https://developers.cloudflare.com/workers/static-assets/billing-and-limitations/)、[DDoS 保护](https://developers.cloudflare.com/ddos-protection/)、[WAF 自定义规则](https://developers.cloudflare.com/waf/custom-rules/)、[限流能力](https://developers.cloudflare.com/waf/rate-limiting-rules/)、[Bot Fight Mode 限制](https://developers.cloudflare.com/bots/get-started/bot-fight-mode/)、[cf 与 Wrangler 独立授权](https://developers.cloudflare.com/cf/get-started/)、[CSP 脚本/WASM](https://developer.mozilla.org/en-US/docs/Web/HTTP/Reference/Headers/Content-Security-Policy/script-src)。

兼容性依据：[Zod jitless](https://github.com/colinhacks/zod/blob/main/packages/docs/content/compile.mdx)、[Web Share 权限指令的浏览器限制](https://developer.mozilla.org/en-US/docs/Web/HTTP/Reference/Headers/Permissions-Policy/web-share)。
