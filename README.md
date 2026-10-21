# Word · 背单词

Claude 原型风格的免费网页/PWA：看词、听音、分组复习、真实 ECDICT 词库、本机进度及备份恢复。当前方案见 [docs/00-web-plan.md](docs/00-web-plan.md)；旧原生方案仅作历史参考。

## 本地运行

需要 Node.js 22.12+（推荐24）、Python 3.10+，无需额外 Python 库。

```sh
npm ci
python tools/pipeline/build.py
npm run dev
```

数据管线从固定上游提交下载 CSV、校验 SHA-256、完整导入本地 SQLite，生成学习包与全量静态词库分片。原始数据和生成物不进入 Git。网络首次下载较慢时可重试。

默认美音还需按 [音频管线](tools/audio/README.md) 安装独立的 Python 构建环境并生成音频。此步骤只在开发机或 CI 上运行；浏览器只下载静态 MP3 分包。正式构建要求完整音频，缺失会停止发布。

```sh
npm run lint
npm run typecheck
npm test
npm run build
npm run preview
```

## 数据和发音

- IndexedDB 保存学习快照，逐次写入，失败不会静默推进。多标签页通过 revision 防止旧记录覆盖。
- 全量词库分片校验后入库，已完成分片可复用。学习包和全量词库独立。
- 备份是完整 JSON，可导入同词库版本。换设备需要手动恢复；没有云端账号或同步。
- 默认美音使用本站 Piper/LJ Speech 合成音频，覆盖全部学习词，按需缓存或手动完整下载；英音及指定设备声音由浏览器提供。切词会取消旧声音，只有实际播放事件才允许听音作答。多读音词仅提供一种常见读法。
- 音频采用固定模型与校验和，可续跑重建；构建步骤、许可和限制见 [音频管线](tools/audio/README.md)。发布构建会验证全部词条、分包和片段校验和，缺失或损坏即失败。
- 词典音标保留来源原文，不宣称已按英美或所有词性校准。

## 发布

`dist/` 是完整静态产物。GitHub Actions 在当前仓库分支运行检查、真实数据管线和构建并保存产物；线上发布使用 Cloudflare Workers 的纯静态资源托管，无 Worker 业务函数、云数据库、邮件或付费套餐。静态资源请求免费，见 [官方说明](https://developers.cloudflare.com/workers/static-assets/billing-and-limitations/)。

`wrangler.jsonc` 仅配置独立项目 `yanxai-word` 与子域 `word.yanxai.com`。使用现有 Wrangler OAuth 登录运行 `npm run deploy`；Cloudflare Custom Domain 自动管理本子域的 DNS 和证书，不更改根站及其它项目。CLI 版本固定为 4.151.3，不将授权令牌提交到 Git。

用户进度及备份不要提交到仓库。清除网站数据会删除本机进度，请定期导出备份。
