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

发音只使用浏览器提供的本地英文声音，默认优先本机 Samantha。构建无需生成音频或安装语音服务；旧 [音频管线](tools/audio/README.md) 保留作历史资料，其生成物不进入当前发布。

```sh
npm run lint
npm run typecheck
npm test
npm run build
npm run preview
```

本机安装 Chrome 后，可运行 `node tools/sw-navigation-smoke.mjs`。它用真实浏览器及 Service Worker 验证静态托管的 HTML 规范地址跳转、旧跳转缓存和离线刷新；无需启动 preview。

preview 启动后，`node tools/experience-smoke.mjs` 检查安卓 Chrome 仿真中的搜索、圆环切换、首见释义、日历与离线恢复；`node tools/audio/browser-smoke.mjs` 检查真实浏览器本机声音及零在线音频请求。仿真不代替手机系统安装、键盘或 Samantha 真机试听。

## 数据和发音

- IndexedDB 保存学习快照，逐次写入，失败不会静默推进。多标签页通过 revision 防止旧记录覆盖。
- 全量词库分片校验后入库，已完成分片可复用。学习包和全量词库独立。
- 备份是完整 JSON，可导入同词库版本。换设备需要手动恢复；没有云端账号或同步。
- 默认优先本机 Samantha，其次同口音本地英文声音；不使用远程声音或本站 Piper。安卓需在系统中安装英文语音数据，浏览器没有暴露可用本地声音时会提示不可用。切词取消旧声音，只有真实 `onstart` 才允许听音作答。
- 首次出现的词点认识，保存后显示词义约 1.1 秒再自动继续；两模式中已经答过的词再次认识时立即继续。
- 认识按钮右侧的「斩」长期跳过当前词，首次解释含义并支持立即撤销；跳过不计入错误或当天背词数，也可在生词本恢复。
- 首页可切换看词/听音进度，圆环首次打开旋转一次；日历按本机日期记录当天去重词数、词义和错误次数，撤销同步回退。旧备份兼容，无法恢复的旧日期不补造。
- 安卓可从安装入口或 Chrome 菜单安装为 PWA，独立窗口、主屏图标和离线学习，无需商店开发者账号。双击不缩放，保留双指缩放。
- 词典音标保留来源原文，不宣称已按英美或所有词性校准。

## 发布

`dist/` 是完整静态产物。GitHub Actions 在当前仓库分支运行检查、真实数据管线和构建并保存产物；线上发布使用 Cloudflare Workers 的纯静态资源托管，无 Worker 业务函数、云数据库、邮件或付费套餐。静态资源请求免费，见 [官方说明](https://developers.cloudflare.com/workers/static-assets/billing-and-limitations/)。

`wrangler.jsonc` 仅配置独立项目 `yanxai-word` 与子域 `word.yanxai.com`。使用现有 Wrangler OAuth 登录运行 `npm run deploy`；Cloudflare Custom Domain 自动管理本子域的 DNS 和证书，不更改根站及其它项目。CLI 版本固定为 4.151.3，不将授权令牌提交到 Git。

用户进度及备份不要提交到仓库。清除网站数据会删除本机进度，请定期导出备份。
