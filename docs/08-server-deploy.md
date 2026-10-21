# 08 · 服务器、域名与部署

## 1. 资源清单

| 资源 | 规格 | 用途 |
|---|---|---|
| 云服务器 ×1 | 香港，2 vCPU / 4 GB / 60 GB SSD，Ubuntu 24.04 LTS，固定公网 IP | API、PostgreSQL、官网 |
| Cloudflare（免费） | DNS 托管 `yanxai.com`；R2 存储桶 `yanxai-cdn`（音频、词包、APK）和 `yanxai-backups`（数据库备份）；Email Routing（`support@` 转发到你的邮箱） | |
| Resend（免费档） | 发件域名 `mail.yanxai.com`，发件人 `no-reply@mail.yanxai.com` | 验证码邮件 |
| Azure Speech（S0） | 一次性生成发音 | `04-audio.md` |
| 外部监控（免费） | UptimeRobot 或 Better Stack，每 5 分钟检查一次 `https://api.yanxai.com/healthz` 和 `https://yanxai.com` | 宕机发邮件给你 |

> 为什么选香港：大陆访问延迟低，又不需要 ICP 备案。以后如果要上国内应用商店，需要迁到大陆服务器并备案（`09-release.md` 第 4 节），本文的部署方式不用改，只换机器和 DNS。

## 2. DNS 记录（Cloudflare）

| 类型 | 名称 | 值 | 代理 | 说明 |
|---|---|---|---|---|
| A | `yanxai.com` | 服务器 IP | 关（仅 DNS） | 官网，Caddy 自动申请证书 |
| CNAME | `www` | `yanxai.com` | 关 | Caddy 跳转到不带 www 的域名 |
| A | `api` | 服务器 IP | 关 | API |
| R2 自定义域名 | `cdn` | 存储桶 `yanxai-cdn` | 开（R2 要求） | 音频、词包、APK |
| MX / TXT | `@` | 按 Cloudflare Email Routing 向导添加 | — | `support@yanxai.com` 转发 |
| TXT / MX / CNAME | `mail` | 按 Resend 向导添加（SPF、DKIM） | — | 发件 |
| TXT | `_dmarc` | `v=DMARC1; p=quarantine; rua=mailto:support@yanxai.com` | — | |
| CAA | `yanxai.com` | `0 issue "letsencrypt.org"` | — | 只允许 Let's Encrypt 签发证书 |

API 和官网不走 Cloudflare 代理，是因为 Cloudflare 免费版在大陆访问不稳定；CDN 只放静态大文件，且 App 会缓存，影响不大。

## 3. 服务器初始化（写成 `infra/bootstrap.sh`，你或 Codex 在服务器上执行一次）

1. 创建非 root 用户 `deploy`，只允许 SSH 密钥登录，禁用密码登录和 root 登录。
2. `ufw` 只开放 22、80、443。
3. 开启 `unattended-upgrades`，安装 `fail2ban`。
4. 安装 Docker Engine 和 Compose 插件。
5. 建目录 `/opt/word/`，放 `docker-compose.yml`、`Caddyfile`、`.env`（权限 600）。
6. 设置 Docker 日志轮转：`json-file`，`max-size 10m`，`max-file 5`。

## 4. Docker Compose（`infra/docker-compose.yml`）

| 服务 | 镜像 | 说明 |
|---|---|---|
| `caddy` | `caddy:2` | 80/443；托管官网静态文件（挂载 `/opt/word/site`）；反向代理 `api.yanxai.com` 到 `api:3000`；自动 HTTPS |
| `api` | `ghcr.io/ryancoreai/word-api:<git sha>` | Fastify；启动前先跑数据库迁移；健康检查 `/healthz` |
| `db` | `postgres:17` | 数据卷 `pgdata`；**不暴露端口**，只在内部网络 |
| `backup` | 自建小镜像（`postgres:17` + `rclone` + cron） | 每天 03:30（香港时间）`pg_dump -Fc` → 上传到 R2 `yanxai-backups/daily/`；保留 30 天每日 + 12 个每月 |

`Caddyfile`：

```
yanxai.com {
  root * /srv/site
  encode zstd gzip
  file_server
  try_files {path} {path}/ {path}.html
  header /_astro/* Cache-Control "public, max-age=31536000, immutable"
  handle_errors {
    rewrite * /404.html
    file_server
  }
}
www.yanxai.com {
  redir https://yanxai.com{uri} permanent
}
api.yanxai.com {
  encode zstd gzip
  reverse_proxy api:3000
}
```

## 5. 环境变量（`infra/.env.example`，真实值只放服务器）

```
NODE_ENV=production
PORT=3000
DATABASE_URL=postgres://word:<密码>@db:5432/word
POSTGRES_PASSWORD=<密码>
JWT_SECRET=<64 字节随机>
CODE_PEPPER=<32 字节随机>
RESEND_API_KEY=<Resend 后台生成>
MAIL_FROM="<APP_NAME> <no-reply@mail.yanxai.com>"
CDN_BASE_URL=https://cdn.yanxai.com
PACK_VERSION=1
PACK_SHA256=<生成词包时得到>
PACK_BYTES=<生成词包时得到>
CORS_ORIGIN=https://yanxai.com
R2_ACCOUNT_ID=  R2_ACCESS_KEY_ID=  R2_SECRET_ACCESS_KEY=     # 备份用，只给 yanxai-backups 的写权限
SENTRY_DSN=                                                # 可选
GIT_SHA=<部署时注入>
```

## 6. 持续集成与部署（GitHub Actions）

| 工作流 | 触发 | 内容 |
|---|---|---|
| `ci.yml` | 每个 PR 和推到 main | 安装 → lint → 类型检查 → 单元测试（core、pipeline 用小样本、api 用 Postgres service 容器）→ 官网构建 → App 的 `expo-doctor` 和安卓权限检查 |
| `deploy-api.yml` | main 上 `apps/api` 或 `packages/core` 有改动 | 构建 Docker 镜像 → 推送到 GHCR → SSH 到服务器 `docker compose pull api && docker compose up -d api` → 轮询 `/healthz` 直到正常，失败自动回滚到上一个镜像 |
| `deploy-site.yml` | main 上 `apps/site` 有改动 | 构建 Astro → rsync 到服务器 `/opt/word/site` |
| `eas-build.yml` | 手动触发或打 `v*` 标签 | `eas build --platform all --profile production --non-interactive`（需要 `EXPO_TOKEN` 机密） |

GitHub 仓库机密：`DEPLOY_HOST`、`DEPLOY_USER`、`DEPLOY_SSH_KEY`、`EXPO_TOKEN`。

## 7. 一次性数据操作（M9 时执行）

1. 在服务器上（或在本地连服务器数据库）：`pnpm pipeline fetch && pnpm pipeline import`：整本词典入库，并断言 770,611 行。
2. `pnpm pipeline pack`：生成 `pack-v1.db` 和 `.gz`，上传到 `cdn.yanxai.com/packs/`，把 SHA-256 和字节数写进 `.env`。
3. `pnpm tts upload`：上传音频（M4 已经生成），回填词包的 `audio` 位掩码，重新生成词包。
4. 同一份 `pack-v1.db` 复制到 `apps/mobile/assets/pack/`，提交到仓库（约 3.3 MB，这是唯一进仓库的数据文件）。

## 8. 监控与运维

- 外部监控：API `/healthz` 和官网首页，每 5 分钟检查，连续 2 次失败发邮件。
- 磁盘使用超过 80% 时由 cron 脚本发邮件（通过 Resend）。
- 恢复演练：每季度一次，把最新备份恢复到一个临时 Postgres 容器里，执行 `SELECT count(*) FROM dict_entry`（应为 770,611）和用户数检查。步骤写进 `infra/RESTORE.md`。
- 云服务商的整机快照：每周一次，保留 4 份。

## 9. 官网（`apps/site`）

- Astro 纯静态，页面见 `01-product.md` 第 5 节，样式沿用原型的颜色和字体（官网可以用 Google Fonts 之外的自托管字体，避免大陆访问 Google 慢：把 Inter 和 Source Serif 4 的 woff2 文件放在站内）。
- `/delete-account` 页的表单调用 API 的 `delete-request` 和 `delete-confirm`（跨域已允许 `https://yanxai.com`）。
- `/download` 页的 APK 链接指向 `https://cdn.yanxai.com/android/<APP_NAME 拼音>-<版本>.apk`，同时显示 SHA-256。
- 页面 `<head>` 带基本的 SEO 和分享信息（title、description、og:image）。
- Lighthouse 移动端性能 ≥ 90，无障碍 ≥ 95。

## 10. 费用和容量

- 这套配置可以支撑几千名活跃用户：每次同步只有几 KB；音频走 CDN，不经过服务器。
- 用户量大了以后的扩容顺序：先升级服务器配置 → 再把 PostgreSQL 换成云数据库 → 最后 API 多实例。v1 不需要。
