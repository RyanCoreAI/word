# AGENTS.md — 给 Codex（以及任何写代码的 AI）的工作守则

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
