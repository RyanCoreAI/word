# 10 · 开发里程碑与 Codex 指令

## 怎么用这份文档

1. 按 M0 → M10 的顺序，一次交给 Codex 一个里程碑。
2. 每个里程碑一个分支、一个 PR（分支名 `m{编号}-{简称}`，例如 `m1-core`）。
3. Codex 完成后，你按「你要验收的」检查；通过就合并到 main，再开始下一个。
4. 每个里程碑末尾的「给 Codex 的指令」可以**原样复制粘贴**。

通用要求（每个指令都隐含，写在 `AGENTS.md` 里）：先读 `AGENTS.md` 和相关文档；不改已定的产品规则；所有检查通过才提交；PR 描述逐条对照验收标准。

---

## M0 · 仓库脚手架

**交付**
- pnpm workspace：`apps/*`、`packages/*`、`tools/*`；根目录 `package.json` 脚本：`lint`、`typecheck`、`test`、`format`。
- `tsconfig.base.json`（strict、`noUncheckedIndexedAccess`）、ESLint、Prettier、`.editorconfig`、`.nvmrc`（24）、`.npmrc`（`node-linker=hoisted`）。
- `.gitignore`：`node_modules`、`data/`、`.env*`（保留 `.env.example`）、`dist`、`.expo`、`ios/`、`android/`、`*.log`、`tools/tts/out/`。
- 空的 `packages/core`（带一个示例测试）。
- `.github/workflows/ci.yml`：安装、lint、类型检查、测试。
- 根目录 `README.md`：一段介绍 + 指向 `docs/README.md`。

**验收标准**
- 全新克隆后 `pnpm install && pnpm lint && pnpm typecheck && pnpm test` 全部通过。
- CI 在 PR 上运行并通过。

**你要验收的**：CI 是绿色的。

**给 Codex 的指令**
```
阅读 AGENTS.md、docs/README.md、docs/05-architecture.md 第 2、3 节，完成 docs/10-milestones.md 的 M0（仓库脚手架）。
只搭脚手架，不写业务代码。完成后开 PR，PR 描述逐条对照 M0 的验收标准。
```

---

## M1 · 学习规则核心库（`packages/core`）

**交付**
- `types.ts`、`rules.ts`（`applyAnswer`、`replay`、`newState`）、`group.ts`（`buildGroup`、`fnv1a32`、`mulberry32`、`shuffle`）、`order.ts`（`randKey`）、`stats.ts`（连续天数、新掌握等统计函数）、`phonetic.ts`（显示哪种音标的 `pickPhonetic`）、`meaning.ts`（义项拼接、简短释义 `brief`）、`schemas.ts`（zod：Settings、同步请求和响应、各接口请求体）、`constants.ts`（标签位掩码、默认设置、`PRIVACY_VERSION`、组大小选项等）。
- 纯 TypeScript，不依赖 React Native 和 Node 专有 API。

**验收标准**
- `docs/02-learning-rules.md` 第 9 节的**每一个**用例都有对应测试，全部通过。
- `rules.ts`、`group.ts` 的行覆盖率 100%。
- 同一输入调用 `buildGroup` 两次，结果完全相同。

**你要验收的**：PR 里的测试用例对照表。

**给 Codex 的指令**
```
阅读 AGENTS.md 和 docs/02-learning-rules.md（必须逐字遵守），以及 docs/03-dictionary-data.md 第 5.4、6、8.2 节，完成 docs/10-milestones.md 的 M1。
02 文档第 9 节的每个测试用例都要写成测试，测试名里带上用例编号（如 "T5 ..."）。
完成后开 PR，PR 描述附上测试用例编号和结果的对照表。
```

---

## M2 · 词典数据管线（`tools/pipeline`）

**交付**
- 命令：`fetch`（下载并校验 SHA-256）、`import`（整本入库）、`pack`（生成词包）、`verify`（打印并断言所有校验数字）。
- 解析 CSV、派生字段、英式和美式音标转换、释义解析，全部按 `03-dictionary-data.md` 实现。
- 词包用 `better-sqlite3` 生成。
- `import` 需要的 `dict_entry` 表结构先在 `tools/pipeline` 里用 SQL 建；M3 时改为由 API 的 Drizzle 迁移统一管理（同一份结构）。

**验收标准**
- 单元测试：`03` 第 5.3 节的 16 个音标向量、第 6 节的 5 个释义示例、第 4.1 节的抽查表，全部通过（使用仓库里的小样本 fixture，不依赖下载）。
- `pnpm pipeline verify` 用完整数据运行，打印的数字和 `03` 第 4.1 节**完全一致**，默认词库按 rank 的前 12 个词和第 7 节一致。
- 词包约 3.3 MB，19,094 行。
- 导入本地 Postgres 后，`dict_entry` 共 770,611 行。

**你要验收的**：PR 里贴出 `verify` 的完整输出。

**给 Codex 的指令**
```
阅读 AGENTS.md 和 docs/03-dictionary-data.md（必须逐字遵守），完成 docs/10-milestones.md 的 M2。
原始数据下载到 data/raw/（不要提交到仓库）。测试用小样本 fixture，另外用完整数据跑 verify 命令，把完整输出贴进 PR 描述。
如果某个数字和文档对不上，不要改规则去凑数字，在 PR 里写明差异和原因。
```

---

## M3 · 服务器 API（`apps/api`）

**交付**
- Fastify 应用；Drizzle 表结构和迁移（`05-architecture.md` 第 4 节全部表，包括把 M2 的 `dict_entry` 纳入迁移）。
- `06-api-sync.md` 的全部接口：匿名注册、刷新、邮箱验证码发送和验证（含账号合并）、注销、官网注销申请和确认、词包清单、词典查询、同步、健康检查。
- 邮件发送做成可替换的驱动：开发和测试环境 `MAIL_DRIVER=console`（验证码打印到日志），生产用 Resend。
- 限流、安全头、跨域、错误格式。
- `Dockerfile`（多阶段构建，非 root 用户运行）；`infra/docker-compose.dev.yml`（本地 Postgres）。
- 管理命令：`rebuild-user-word --user <id>`。

**验收标准**
- 集成测试使用真实 Postgres（CI 用 service 容器），覆盖：
  - 同步幂等（同一批数据上传两次）；
  - 两个客户端乱序上传，最终 `user_word` 等于全部有效作答重新计算的结果；
  - 撤销与目标作答分在不同批次到达；
  - `02` 第 9 节的 M1、M2 合并用例；邮箱绑定的三种情况（新邮箱、同一账号、合并）；
  - 验证码过期、错误 5 次锁定、限流；
  - 注销后该用户在所有表里都是 0 行。
- `GET /dict/search?q=ela` 返回结果，`GET /dict/entry/elaborate` 返回完整词条。

**你要验收的**：CI 绿色；PR 里的测试清单。

**给 Codex 的指令**
```
阅读 AGENTS.md、docs/05-architecture.md 第 4 节、docs/06-api-sync.md（必须逐字遵守）、docs/02-learning-rules.md，完成 docs/10-milestones.md 的 M3。
学习规则必须调用 packages/core，不要在服务器里重新实现。测试用真实 Postgres。
完成后开 PR，PR 描述逐条对照 M3 的验收标准。
```

---

## M4 · 发音音频（`tools/tts`）

> 需要你提供 Azure Speech 密钥和区域、R2 的访问密钥（写在本地 `tools/tts/.env`，不提交）。如果 Codex 的运行环境不能访问 Azure，就由你在自己电脑上执行生成命令（需要 Node 24 和 ffmpeg），Codex 负责把脚本写好、测好。

**交付**
- `voices`：列出可用语音，生成 30 个测试词的试听页 `out/voices.html`。
- `generate`：按 `04-audio.md` 第 2 节批量合成，支持断点续跑、并发、重试，并处理 `overrides.json`。
- `post`：ffmpeg 去静音、补静音、响度统一、重新编码。
- `review`：生成抽查网页。
- `upload`：上传到 R2，设置响应头；根据实际结果回填词包的 `audio` 位掩码。
- 用假的语音服务（mock）测试整个流程。

**验收标准**
- 用 mock 跑通全流程的测试。
- 真实运行后：美音、英音各约 19,094 个文件；失败列表为空，或者在 PR 里列出。
- 随机抽 5 个文件：首尾无明显静音，响度接近 −16 LUFS，单声道 24 kHz。

**你要验收的**：① 听试听页，选定美音、英音各一个发音人；② 抽查约 300 个词，把有问题的勾出来交给 Codex 修。

**给 Codex 的指令**
```
阅读 AGENTS.md 和 docs/04-audio.md 第 1–3 节，完成 docs/10-milestones.md 的 M4。
先只做 voices 命令和试听页，让我选发音人；我选好后再跑完整生成。密钥从 tools/tts/.env 读取，不要提交。
```

---

## M5 · App 骨架（`apps/mobile`）

**交付**
- 用最新稳定版 Expo SDK 创建项目，配置按 `07-mobile-app.md` 第 1 节。
- 字体、设计 tokens、`src/ui/` 全部基础组件和开发版组件展示页。
- 本地数据库：迁移、词包导入（`07` 第 3 节）、数据访问层。
- 页面：P0 隐私同意、P1 选词库、底部标签栏、P2 首页（接真实本地数据；还没有学习数据时显示 0）、P8 设置（本地保存）、开源许可页。
- `i18n/zh-CN.ts`。
- 安卓权限检查脚本（在 CI 里运行 `expo prebuild` 后检查 AndroidManifest）。

**验收标准**
- 用开发构建或 Expo Go 在真机上运行。
- P0、P1、P2、P8 与原型对照截图（iOS 和安卓各一套）贴进 PR，差异逐条说明。
- 首次启动导入词包 ≤ 3 秒（贴出日志计时）；P1 各词库数字和 `03` 第 4.1 节一致。
- 同意隐私政策之前没有任何网络请求（贴出验证方法和结果）。

**你要验收的**：在自己手机上装开发版，对照原型图 3、4 看首页、选词库、设置。

**给 Codex 的指令**
```
阅读 AGENTS.md、docs/01-product.md（P0、P1、P2、P8）、docs/07-mobile-app.md、docs/05-architecture.md 第 5 节，并对照 design/mockups/ 里的图 3、4 和 design/mockups-src/src/ui.css，完成 docs/10-milestones.md 的 M5。
视觉必须和原型一致；PR 里附上 iOS 和安卓截图与原型的对照。
```

---

## M6 · 学习页（看词记忆 + 听音辨词）

**交付**
- 学习状态机、两个卡片槽位、全部动画（`07` 第 4.3 节）、输入锁、振动。
- 音频引擎：组开始时预下载、两个播放器交替、自动朗读、遍数、慢速、口音切换、系统朗读兜底（`04` 第 4 节）。
- P3 看词记忆、P4 听音辨词的全部状态和交互（`01` 第 4 节）。
- 撤销（栈）和顶部「✓ 认识 · 撤销」小条。
- 组的生命周期：新建、继续、放弃（P11）、结束；用时统计。
- P5 小结。

**验收标准**
- `07` 第 8 节端到端流程 2、3、4 通过。
- 中端安卓真机录屏：连续快速作答 20 个词，没有掉帧和音频错乱（录屏附在 PR 里）。
- 学习过程中断网，行为完全正常。
- 杀掉 App 后重新打开，停在同一个词。

**你要验收的**：在两台手机上各背 3 组，重点感受「丝滑」和发音；撤销、放弃、继续都试一遍。

**给 Codex 的指令**
```
阅读 AGENTS.md、docs/01-product.md（P3、P4、P5、P11）、docs/02-learning-rules.md、docs/04-audio.md 第 4 节、docs/07-mobile-app.md 第 4 节，对照 design/mockups/ 图 1、图 2、图 3 的小结、图 4 的未完成提示，完成 docs/10-milestones.md 的 M6。
最重要的验收标准是切换流畅：严格按 07 第 4.2、4.3 节的槽位和动画方案实现，并在 PR 里附中端安卓真机录屏。
```

---

## M7 · 生词本、详情、账号与同步

**交付**
- P6 生词本（搜索、分段、两种排序、「刷这些词」）、P7 单词详情、P9 账号与数据、P10 绑定邮箱。
- 导出 CSV、重置进度、注销账号。
- 接口客户端（令牌存储、自动刷新）；同步引擎（`06` 第 4 节，触发时机、重试、补上请求发出后才产生的本地作答）；账号合并后的完整同步。
- 词包更新检查。

**验收标准**
- 两台设备的场景测试（可以用两台真机，或一台真机 + 一个模拟器）：A 离线学 2 组，B 离线学 1 组（有重叠的词），两边先后联网 → 两边生词本和首页数字完全一致。
- 新设备绑定同一个邮箱 → 进度恢复，`restoredWords` 正确。
- 重置、注销后服务器上数据正确（重置后作答记录为 0；注销后用户不存在）。
- `07` 第 8 节端到端流程 5、6、7 通过。

**你要验收的**：用两台手机实际测试一次换机恢复。

**给 Codex 的指令**
```
阅读 AGENTS.md、docs/01-product.md（P6、P7、P9、P10）、docs/06-api-sync.md、docs/07-mobile-app.md，对照 design/mockups/ 图 3 的生词本和图 5，完成 docs/10-milestones.md 的 M7。
同步正确性是重点：在 PR 里写清楚两设备测试的步骤和结果。
```

---

## M8 · 官网（`apps/site`）

**交付**
- Astro 静态站：`/`、`/download`、`/privacy`、`/terms`、`/delete-account`、`/support`、`/licenses`、404（`01` 第 5 节、`08` 第 9 节）。
- 隐私政策和用户协议初稿（按 `09` 第 5 节的提纲）。
- 注销页表单接入 API。

**验收标准**
- 首页与原型图 6 一致；手机和电脑两种宽度都正常。
- Lighthouse 移动端：性能 ≥ 90，无障碍 ≥ 95。
- 注销页在本地联调通过。

**你要验收的**：通读隐私政策和用户协议，填上运营者名称。

**给 Codex 的指令**
```
阅读 AGENTS.md、docs/01-product.md 第 5 节、docs/08-server-deploy.md 第 9 节、docs/09-release.md 第 5 节，对照 design/mockups/ 图 6，完成 docs/10-milestones.md 的 M8。
运营者名称用占位符「【运营者名称】」，我来填写。
```

---

## M9 · 部署上线

> 需要你：买好服务器、把 DNS 托管到 Cloudflare、建好 R2 存储桶、在 Resend 验证域名、在 GitHub 仓库设置机密。Codex 写好全部脚本和文档，你按文档执行（或者把服务器 SSH 权限交给能执行命令的人）。

**交付**
- `infra/`：`bootstrap.sh`、`docker-compose.yml`、`Caddyfile`、`.env.example`、备份镜像和脚本、`RESTORE.md`、`DEPLOY.md`（从零开始部署的逐步说明，写给非程序员）。
- GitHub Actions：`deploy-api.yml`、`deploy-site.yml`、`eas-build.yml`。
- 生产数据初始化步骤（`08` 第 7 节）。

**验收标准**
- `https://api.yanxai.com/healthz` 返回正常；`https://yanxai.com` 可以访问，证书有效。
- 生产库 `dict_entry` 为 770,611 行。
- R2 里有第一份数据库备份；按 `RESTORE.md` 恢复演练成功。
- 推到 main 后自动部署成功；人为让健康检查失败，会自动回滚。

**你要验收的**：在浏览器打开官网和健康检查地址；在 R2 后台看到备份文件。

**给 Codex 的指令**
```
阅读 AGENTS.md 和 docs/08-server-deploy.md（必须逐字遵守），完成 docs/10-milestones.md 的 M9。
DEPLOY.md 要写成不懂编程的人也能照着做的步骤，每一步写清楚在哪个网站点什么、在服务器上执行什么命令、怎么确认成功。
```

---

## M10 · 测试与发布

**交付**
- Maestro 端到端流程全部 7 个（`07` 第 8 节）。
- 性能测量报告（`07` 第 4.6 节的每一项，iPhone 和中端安卓）。
- App Store 和 Google Play 的文案（名称、副标题、描述、关键词、更新说明）放在 `apps/mobile/store/`；截图脚本和截图。
- `preview`、`production`、`apk` 三种构建成功；TestFlight 可安装；APK 已上传，官网下载页已更新。

**验收标准**
- `09` 第 6 节的发布检查清单全部勾选，并在 PR 里附上证据。

**你要验收的**：用 TestFlight 在 iPhone 上安装，从官网下载 APK 在安卓手机上安装，各完整背一天。

**给 Codex 的指令**
```
阅读 AGENTS.md、docs/07-mobile-app.md 第 4.6、8 节和 docs/09-release.md，完成 docs/10-milestones.md 的 M10。
按 09 第 6 节的检查清单逐项提供证据。
```

---

## 进度表（你可以在这里打勾）

- [ ] M0 仓库脚手架
- [ ] M1 学习规则核心库
- [ ] M2 词典数据管线
- [ ] M3 服务器 API
- [ ] M4 发音音频
- [ ] M5 App 骨架
- [ ] M6 学习页
- [ ] M7 生词本、详情、账号与同步
- [ ] M8 官网
- [ ] M9 部署上线
- [ ] M10 测试与发布
