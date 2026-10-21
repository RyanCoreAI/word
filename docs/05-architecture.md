# 05 · 架构、技术栈与数据库

## 1. 总览

```
 ┌─────────────────────────────┐          ┌──────────────────────────────┐
 │ iPhone / 安卓 App (Expo RN)  │  HTTPS   │ api.yanxai.com                │
 │  · 本地 SQLite：词包 + 进度   │ ───────> │  Fastify (Node 24, TS)        │
 │  · 学习逻辑 packages/core     │  同步/账号 │  · 学习逻辑 packages/core      │
 │  · 音频缓存                   │          │  · PostgreSQL 17：整本词典 +    │
 └──────────┬──────────────────┘          │    用户数据                   │
            │ HTTPS（音频、词包）            └──────────────────────────────┘
            v
 ┌─────────────────────────────┐          ┌──────────────────────────────┐
 │ cdn.yanxai.com               │          │ yanxai.com                    │
 │  Cloudflare R2：音频、词包、APK │          │  静态官网（Astro），Caddy 托管   │
 └─────────────────────────────┘          └──────────────────────────────┘
```

原则：

1. **手机本地是交互的来源**。点按只写本地数据库，界面不等网络。
2. **服务器是数据的权威来源**。同步时以服务器重新计算的结果为准（`06-api-sync.md`）。
3. **规则只写一份**。`packages/core` 是纯 TypeScript，不依赖 React Native 或 Node 的 API，App 和服务器都引用它。

## 2. 技术栈

开工时取各库**当前稳定版**，并在 lockfile 里锁定精确版本。不要用 beta 或 canary 版本。

| 层 | 选型 | 说明 |
|---|---|---|
| 语言 | TypeScript（strict） | 全仓库统一 |
| 包管理 | pnpm workspaces | 根目录 `.npmrc` 设 `node-linker=hoisted`（React Native 在 monorepo 里需要） |
| App 框架 | Expo（最新 SDK）+ React Native 新架构 | `expo-router` 文件路由 |
| 本地数据库 | `expo-sqlite` | 手写 SQL + 小型数据访问层，迁移用版本号数组 |
| 动画与手势 | `react-native-reanimated`、`react-native-gesture-handler` | 动画跑在 UI 线程 |
| 弹层 | `@gorhom/bottom-sheet` | P7、P11 |
| 列表 | `@shopify/flash-list` | 生词本 |
| 音频 | `expo-audio`、`expo-speech`、`expo-file-system` | `04-audio.md` |
| 其他 Expo 模块 | `expo-haptics` `expo-secure-store` `expo-crypto` `expo-localization` `expo-application` `expo-sharing` `expo-web-browser` `expo-updates` `expo-splash-screen` `expo-font` `expo-network` | |
| 状态管理 | `zustand`（界面状态）、`@tanstack/react-query`（网络请求） | |
| 数据校验 | `zod`，schema 放在 `packages/core`，前后端共用 | |
| 字体 | Source Serif 4 SemiBold（单词）、Inter（界面英文和音标）；中文用系统字体 | 都是 OFL 许可，打进安装包 |
| 服务器 | Node.js 24 LTS、Fastify、`fastify-type-provider-zod`、`@fastify/rate-limit`、`@fastify/helmet`、`@fastify/cors` | |
| 数据库 | PostgreSQL 17（Docker 官方镜像） | |
| ORM 和迁移 | Drizzle ORM + drizzle-kit（驱动 `postgres`） | 迁移文件提交到仓库 |
| 认证 | `jose`（JWT） | |
| 邮件 | Resend（官方 SDK） | |
| 日志 | pino（Fastify 自带） | |
| 官网 | Astro（纯静态输出） | |
| 测试 | Vitest（core、pipeline、api）、jest-expo + Testing Library（App 组件）、Maestro（App 端到端） | |
| 代码规范 | ESLint + Prettier；`tsc --noEmit` 类型检查 | |
| CI | GitHub Actions | |
| 构建发布 | EAS Build、EAS Submit、EAS Update | |
| 错误上报（可选） | Sentry（App 在用户同意隐私政策之后才初始化） | |

## 3. 仓库结构

```
word/
├── AGENTS.md                    # 给 Codex 的工作守则
├── docs/                        # 本方案
├── design/                      # 原型图和原型源码
├── package.json  pnpm-workspace.yaml  .npmrc  tsconfig.base.json  .editorconfig
├── apps/
│   ├── mobile/                  # Expo App
│   │   ├── app/                 # expo-router 路由（见 07 第 2 节）
│   │   ├── src/
│   │   │   ├── db/              # SQLite 打开、迁移、数据访问
│   │   │   ├── study/           # 学习页状态机、卡片组件、动画
│   │   │   ├── audio/           # 音频引擎、缓存、兜底
│   │   │   ├── sync/            # 同步引擎
│   │   │   ├── api/             # 接口客户端
│   │   │   ├── ui/              # 通用组件、设计 tokens
│   │   │   ├── i18n/zh-CN.ts    # 全部界面文字
│   │   │   └── config.ts        # APP_NAME、API 地址、CDN 地址、版本常量
│   │   ├── assets/              # 字体、图标、词包 pack-v1.db、许可文本
│   │   ├── app.config.ts  eas.json
│   │   └── e2e/                 # Maestro 流程
│   ├── api/                     # Fastify 服务
│   │   ├── src/{routes,services,db,auth,mail}/
│   │   ├── drizzle/             # 迁移文件
│   │   └── Dockerfile
│   └── site/                    # Astro 官网
├── packages/
│   └── core/                    # 学习规则、出组、类型、zod schema、共享常量（纯 TS）
├── tools/
│   ├── pipeline/                # 下载、校验、解析、导入、生成词包
│   └── tts/                     # 生成发音、后期处理、上传、试听页
├── infra/
│   ├── docker-compose.yml  Caddyfile  .env.example
│   └── backup/                  # 备份脚本
├── data/                        # 原始数据和中间产物（.gitignore，不进仓库）
└── .github/workflows/           # CI
```

## 4. 服务器数据库（PostgreSQL）

用 Drizzle 定义；下面是等价的 SQL，Codex 以此为准。所有时间用 `timestamptz`。

### 4.1 整本词典

```sql
CREATE TABLE dict_entry (
  word            text PRIMARY KEY,          -- ECDICT 原文（区分大小写）
  word_lc         text NOT NULL UNIQUE,      -- 小写，用于查询
  phonetic_raw    text,
  uk              text,                      -- 03 第 5.1 节
  us              text,                      -- 03 第 5.2 节
  definition_en   text,
  translation_raw text,
  meanings        jsonb NOT NULL DEFAULT '[]',
  extra           jsonb,
  pos_dist        text,                      -- ECDICT pos 字段，如 "n:46/v:54"
  collins         smallint,
  oxford          boolean NOT NULL DEFAULT false,
  tags            text[] NOT NULL DEFAULT '{}',
  bnc             integer,
  frq             integer,
  exchange_raw    text,
  lemma           text,
  detail          text,
  is_single_word  boolean NOT NULL,
  has_translation boolean NOT NULL,
  is_inflection   boolean NOT NULL,
  is_basic        boolean NOT NULL,
  is_hf           boolean NOT NULL,
  in_pack         boolean NOT NULL,
  pack_rank       integer,
  source_commit   text NOT NULL
);
CREATE INDEX dict_entry_word_lc_prefix ON dict_entry (word_lc text_pattern_ops);
CREATE INDEX dict_entry_tags ON dict_entry USING gin (tags);
CREATE INDEX dict_entry_pack ON dict_entry (pack_rank) WHERE in_pack;
```

### 4.2 用户与认证

```sql
CREATE EXTENSION IF NOT EXISTS citext;

CREATE TABLE app_user (
  id          uuid PRIMARY KEY,
  email       citext UNIQUE,                  -- 绑定后才有
  created_at  timestamptz NOT NULL DEFAULT now(),
  merged_into uuid                            -- 被合并时指向目标账号（留痕 30 天后由清理任务删除）
);

CREATE TABLE device (
  id           uuid PRIMARY KEY,              -- App 生成的随机 UUID，不是硬件标识
  user_id      uuid NOT NULL REFERENCES app_user(id) ON DELETE CASCADE,
  platform     text NOT NULL CHECK (platform IN ('ios','android')),
  app_version  text,
  created_at   timestamptz NOT NULL DEFAULT now(),
  last_seen_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE refresh_token (
  id          uuid PRIMARY KEY,
  user_id     uuid NOT NULL REFERENCES app_user(id) ON DELETE CASCADE,
  device_id   uuid NOT NULL REFERENCES device(id) ON DELETE CASCADE,
  token_hash  bytea NOT NULL UNIQUE,          -- sha256(token)
  created_at  timestamptz NOT NULL DEFAULT now(),
  expires_at  timestamptz NOT NULL,
  revoked_at  timestamptz,
  replaced_by uuid
);

CREATE TABLE email_code (
  id          bigserial PRIMARY KEY,
  email       citext NOT NULL,
  purpose     text NOT NULL CHECK (purpose IN ('bind','delete')),
  code_hash   bytea NOT NULL,                 -- sha256(code || CODE_PEPPER)
  attempts    smallint NOT NULL DEFAULT 0,
  ip          inet,
  created_at  timestamptz NOT NULL DEFAULT now(),
  expires_at  timestamptz NOT NULL,
  consumed_at timestamptz
);
CREATE INDEX email_code_lookup ON email_code (email, purpose, created_at DESC);
```

### 4.3 学习数据

```sql
CREATE SEQUENCE change_seq;                   -- 全局递增，用于增量同步

CREATE TABLE user_settings (
  user_id           uuid PRIMARY KEY REFERENCES app_user(id) ON DELETE CASCADE,
  settings          jsonb NOT NULL,           -- 02 第 2 节 Settings
  client_updated_at timestamptz NOT NULL,     -- 以客户端修改时间判断新旧
  change_seq        bigint NOT NULL DEFAULT nextval('change_seq')
);

CREATE TABLE study_group (
  id          uuid PRIMARY KEY,
  user_id     uuid NOT NULL REFERENCES app_user(id) ON DELETE CASCADE,
  device_id   uuid NOT NULL,
  seq         integer NOT NULL,
  kind        text NOT NULL CHECK (kind IN ('normal','wordbook')),
  mode        text NOT NULL CHECK (mode IN ('look','listen')),
  items       jsonb NOT NULL,                 -- [{"w":"elaborate","r":true}, ...]
  cursor      smallint NOT NULL,
  status      text NOT NULL CHECK (status IN ('active','finished','abandoned')),
  started_at  timestamptz NOT NULL,
  finished_at timestamptz,
  active_ms   integer NOT NULL DEFAULT 0,
  change_seq  bigint NOT NULL DEFAULT nextval('change_seq')
);
CREATE INDEX study_group_user ON study_group (user_id, change_seq);

CREATE TABLE answer_event (
  id             uuid PRIMARY KEY,            -- 客户端生成，保证幂等
  user_id        uuid NOT NULL REFERENCES app_user(id) ON DELETE CASCADE,
  device_id      uuid NOT NULL,
  group_id       uuid NOT NULL,
  group_seq      integer NOT NULL,
  item_index     smallint NOT NULL,
  word           text NOT NULL,
  mode           text NOT NULL CHECK (mode IN ('look','listen')),
  result         smallint NOT NULL CHECK (result IN (0,1)),
  mastery_target smallint NOT NULL CHECK (mastery_target BETWEEN 1 AND 3),
  client_ts      timestamptz NOT NULL,
  server_ts      timestamptz NOT NULL DEFAULT now(),
  voided_by      uuid                         -- 撤销事件 id
);
CREATE INDEX answer_event_word ON answer_event (user_id, word, client_ts);

CREATE TABLE undo_event (
  id        uuid PRIMARY KEY,
  user_id   uuid NOT NULL REFERENCES app_user(id) ON DELETE CASCADE,
  target_id uuid NOT NULL,                    -- answer_event.id
  client_ts timestamptz NOT NULL,
  server_ts timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE user_word (
  user_id             uuid NOT NULL REFERENCES app_user(id) ON DELETE CASCADE,
  word                text NOT NULL,
  status              smallint NOT NULL,
  wrong_count         integer NOT NULL,
  right_count         integer NOT NULL,
  streak              smallint NOT NULL,
  seen_count          integer NOT NULL,
  first_seen_at       timestamptz,
  last_seen_at        timestamptz,
  last_wrong_at       timestamptz,
  mastered_at         timestamptz,
  mastered_via        text,
  last_seen_group_seq integer,
  change_seq          bigint NOT NULL DEFAULT nextval('change_seq'),
  PRIMARY KEY (user_id, word)
);
CREATE INDEX user_word_sync ON user_word (user_id, change_seq);
```

- `user_word` 是 `answer_event` 重新计算出来的结果，可以随时从事件全部重建（提供管理命令 `pnpm api rebuild-user-word --user <id>`）。
- 某个词重新计算后变成「没有任何有效作答」（比如唯一一次作答被撤销）时，删除这行，并写一条**删除记录**，让客户端也删掉：

```sql
CREATE TABLE user_word_tombstone (
  user_id    uuid NOT NULL REFERENCES app_user(id) ON DELETE CASCADE,
  word       text NOT NULL,
  change_seq bigint NOT NULL DEFAULT nextval('change_seq'),
  PRIMARY KEY (user_id, word)
);
```

## 5. 手机本地数据库（SQLite，`app.db`）

一个数据库文件。时间都存毫秒时间戳（INTEGER）。

```sql
-- 词包（整表可替换）
CREATE TABLE word (
  word TEXT PRIMARY KEY, us TEXT, uk TEXT, meanings TEXT NOT NULL, extra TEXT,
  tags INTEGER NOT NULL, basic INTEGER NOT NULL, rank INTEGER NOT NULL,
  audio INTEGER NOT NULL DEFAULT 0, rand_key INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX word_rank ON word(rank);
CREATE INDEX word_rand ON word(rand_key);

-- 进度
CREATE TABLE user_word (
  word TEXT PRIMARY KEY, status INTEGER NOT NULL,
  wrong_count INTEGER NOT NULL DEFAULT 0, right_count INTEGER NOT NULL DEFAULT 0,
  streak INTEGER NOT NULL DEFAULT 0, seen_count INTEGER NOT NULL DEFAULT 0,
  first_seen_at INTEGER, last_seen_at INTEGER, last_wrong_at INTEGER,
  mastered_at INTEGER, mastered_via TEXT, last_seen_group_seq INTEGER
);
CREATE INDEX user_word_status ON user_word(status, last_seen_group_seq);
CREATE INDEX user_word_wrong ON user_word(wrong_count DESC, last_wrong_at DESC);

CREATE TABLE study_group (
  id TEXT PRIMARY KEY, seq INTEGER NOT NULL, kind TEXT NOT NULL, mode TEXT NOT NULL,
  items TEXT NOT NULL, cursor INTEGER NOT NULL DEFAULT 0, status TEXT NOT NULL,
  started_at INTEGER NOT NULL, finished_at INTEGER, active_ms INTEGER NOT NULL DEFAULT 0,
  dirty INTEGER NOT NULL DEFAULT 1           -- 1 = 有改动未上传
);
CREATE INDEX study_group_status ON study_group(status);

CREATE TABLE answer_event (
  id TEXT PRIMARY KEY, group_id TEXT NOT NULL, group_seq INTEGER NOT NULL, item_index INTEGER NOT NULL,
  word TEXT NOT NULL, mode TEXT NOT NULL, result INTEGER NOT NULL, mastery_target INTEGER NOT NULL,
  client_ts INTEGER NOT NULL,
  prev_state TEXT,                            -- 作答前 WordState 的 JSON；新词为 NULL
  voided_by TEXT,
  synced INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX answer_event_group ON answer_event(group_id, item_index);
CREATE INDEX answer_event_unsynced ON answer_event(synced) WHERE synced = 0;
CREATE INDEX answer_event_day ON answer_event(client_ts);

CREATE TABLE undo_event (
  id TEXT PRIMARY KEY, target_id TEXT NOT NULL, client_ts INTEGER NOT NULL, synced INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE kv (k TEXT PRIMARY KEY, v TEXT NOT NULL);
-- kv 键：schema_version, pack_version, settings(JSON), settings_updated_at, device_id, user_id,
--        consent_version, consent_at, sync_cursor, max_group_seq, last_sync_at, onboarding_done
```

- 访问令牌和刷新令牌放在 `expo-secure-store`，**不放** SQLite。
- 每次作答在**一个事务**里完成：插入 `answer_event`、更新 `user_word`、更新 `study_group.cursor/status`。
- 迁移：`kv.schema_version` 记录版本，启动时按顺序执行未执行的迁移。

## 6. 环境与配置

| 环境 | API | 数据库 | 说明 |
|---|---|---|---|
| 本地开发 | `http://localhost:3000` | Docker 里的 Postgres | `infra/docker-compose.dev.yml` |
| 生产 | `https://api.yanxai.com` | VPS 上的 Postgres | v1 不单独搭预发环境；发布前在本地用生产数据库的备份演练 |

App 的 API 地址、CDN 地址通过 `app.config.ts` 的 `extra` 按 EAS 构建配置注入，不写死在代码里。
