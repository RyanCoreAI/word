# AGENTS.md — 给 Codex（以及任何写代码的 AI）的工作守则

## 当前生效方案（2026-10-21）

用户在审查六张原型和原方案后，要求仅用 `word.yanxai.com`、不购买开发者账号，并授权按免费网页方案开始实现。当前实施以 `docs/00-web-plan.md` 为准；下文原生 App、服务器、付费语音和商店里程碑为历史方案，不再作为当前选型或验收要求。原图继续作为视觉参考，按已说明的交互修正适配网页。

- 不创建分支或 worktree，不提交、推送或部署，除非用户明确要求相应动作。保留现有工作。
- 当前目录：`apps/web`（React 网页）、`packages/core`（纯学习规则与输入校验）、`tools/pipeline`（真实词典管线）。
- 当前检查：`npm run lint`、`npm run typecheck`、`npm test`、`npm run build`；UI 还需在桌面和手机尺寸检查。
- 数据生成物、原始词库、SQLite、用户备份不提交；静态词库由固定版本管线重建，保留来源和许可。
- 不添加收费服务或新云账号。用户随后授权一直推进到上线且不要再提问，本次仅允许本项目必要的提交、推送、发布和 `word.yanxai.com` 子域接入；不修改根域、其它仓库或其它站点。浏览器本地保存不得称为云同步；设备合成语音不得称为统一真人发音。
- 当前需求允许必要的新依赖：React、Vite、TypeScript、Zod、图标库，以及测试/检查工具。依赖锁定，不引入无关框架。
- 全量词库独立于学习队列；统计必须来自真实导入；任何失败不得伪装成功或静默清除学习进度。
- 界面以 Claude 原始 HTML/CSS 为高保真依据，直接复用原字体、tokens、比例与留白；不得以系统中文字体、加深灰阶、固定大占位或新增常驻工具栏替代原稿。
- 宣布视觉完成前，必须在相同词条与视口下生成原稿和真实页面的并排图，检查实际字体加载，并目视手机及桌面；功能测试或单个坐标不移动不能代替视觉核验。真实词典内容、本机数据和实际播放状态差异应明确记录。
- 最新用户补充：蓝色圆环及看词/听音进度切换、打开时旋转一次、首页词典搜索、首次认识短暂释义、按本地日期的日历记录、安卓可安装 PWA。发音严格优先本机 Samantha/同口音本地英文声音，不恢复 Piper 或远程音频回退；缺失声音须明确提示。日历不补造旧日期，撤销与备份必须包含真实记录。
- 修改 LF 文件时使用 apply_patch 或明确写入 UTF-8/LF 字节，避免 Windows 默认换行整文件重写；提交前执行 git diff --check。
- 浏览器验收先检查本项目 preview 端口；未运行时只启动当前仓库的服务，不假定旧 session 仍然存活。
- 短语补充使用固定中文维基词典、ECDICT 原词组与小规模编辑 WordNet 义项；分别保留 CC BY-SA 4.0、MIT、WordNet 许可。中文和近义关系须可追溯，不按相似中文猜测，不称全覆盖或已有词频排名。揭晓/展开按需校验缓存，不能更改学习进度。
- 新增复述使用已认可第三张原型的引导布局及四篇原创教学材料；只麦克风复述，编辑参考自查，不做键盘听写或假分数。必要新依赖仅固定 Transformers.js 4.3.1 及其锁定运行时；模型经同源分片校验，明确点击才下载，录音不上传。源码/许可须可重建，模型不提交；单词进度与复述记录的备份范围必须说清。

---

以下是历史原生方案的工作约定，仅未被上述当前方案覆盖的通用代码质量要求继续适用。

## 项目

背单词 App：一套 React Native（Expo）代码同时出 iPhone 和安卓 App，配套 Fastify + PostgreSQL 服务器和 yanxai.com 官网。
完整方案在 `docs/`，**开工前先读 `docs/README.md`**，再读当前里程碑指定的文档。

## 事实来源的优先级

1. `docs/02-learning-rules.md`（学习规则）、`docs/03-dictionary-data.md`（数据规则和校验数字）、`docs/06-api-sync.md`（接口和同步协议）：**必须逐字遵守**。
2. `docs/` 下的其他文档。
3. `design/mockups/*.png` 原型图和 `design/mockups-src/src/ui.css`：视觉以原型为准；原型和文档冲突时以文档为准。
4. 你的判断：只用在文档没有写到的细节上，并在 PR 描述里说明。

**不要自行修改产品规则、校验数字或已定的技术选型**（`docs/README.md` 的「已定的关键决定」）。如果发现文档有错误或矛盾，在 PR 里提出，不要擅自改。

## 工作方式

- 一次只做一个里程碑（`docs/10-milestones.md`），一个分支，一个 PR。分支名 `m{编号}-{简称}`。
- PR 描述必须**逐条对照**该里程碑的验收标准，写明结果和证据（测试输出、截图、录屏、命令输出）。
- 没做完或做不到的，明确写「未完成」及原因，不要写成已完成。
- 需要用户提供的东西（密钥、账号、真机测试、试听），在 PR 里列出来。

## 命令

```
pnpm install            # 安装
pnpm lint               # ESLint
pnpm typecheck          # tsc --noEmit（全部包）
pnpm test               # 全部单元测试和集成测试
pnpm format             # Prettier
pnpm pipeline <命令>    # 数据管线：fetch | import | pack | verify
pnpm tts <命令>         # 发音：voices | generate | post | review | upload
pnpm --filter api dev   # 本地 API（先 docker compose -f infra/docker-compose.dev.yml up -d）
pnpm --filter mobile start
```

提交前 `pnpm lint && pnpm typecheck && pnpm test` 必须全部通过。

## 代码规范

- TypeScript strict，开启 `noUncheckedIndexedAccess`；不用 `any`（确实需要时写 `// eslint-disable-next-line` 并注明原因）。
- 外部输入（接口请求和响应、CSV、JSON 文件、本地存储读出的 JSON）一律用 zod 校验，schema 放在 `packages/core`。
- 学习规则只能在 `packages/core` 里实现；App 和服务器都调用它，不得各自重写。
- `packages/core` 不能依赖 React Native、Expo 或 Node 专有 API；不能读时钟或产生随机数（从参数传入）。
- App 界面文字全部放在 `apps/mobile/src/i18n/zh-CN.ts`。
- 代码、标识符、注释用英文；面向用户的文字用简体中文。
- 时间：服务器和接口用 ISO 8601（timestamptz），手机本地数据库用毫秒时间戳。
- 不新增文档没有提到的大型依赖；确实需要时在 PR 里说明理由。

## 测试

- `packages/core`：`docs/02-learning-rules.md` 第 9 节每个用例一个测试，测试名带用例编号。
- `tools/pipeline`：`docs/03-dictionary-data.md` 的音标向量、释义示例、抽查表；`verify` 命令断言全部校验数字。
- `apps/api`：集成测试用真实 PostgreSQL，不用 mock 数据库。
- `apps/mobile`：状态机、出组、同步合并写单元测试；端到端流程用 Maestro。

## 禁止事项

- 不要提交机密（`.env`、密钥、证书、keystore）和原始数据（`data/`）。唯一进仓库的数据文件是 `apps/mobile/assets/pack/pack-v1.db`。
- 不要使用有道、百度、谷歌翻译等第三方词典或发音的非公开接口。
- 在用户同意隐私政策之前，App 不得发出任何网络请求，不得生成或读取任何设备标识。
- 安卓最终权限只能有 `INTERNET`、`ACCESS_NETWORK_STATE`、`VIBRATE`。
- 不要为了让测试通过而修改校验数字或测试用例；数字对不上就在 PR 里说明。
- 不要跳过、禁用测试来让 CI 变绿。
