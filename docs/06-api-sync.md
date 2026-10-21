# 06 · 接口、账号与同步

## 1. 通用约定

- 地址：`https://api.yanxai.com/v1`，只用 HTTPS。
- 请求和响应都是 JSON（UTF-8），时间用 ISO 8601（带时区），字段名用 camelCase。
- 认证：`Authorization: Bearer <accessToken>`。
- 请求体上限 1 MB。所有请求体用 `packages/core` 里的 zod schema 校验，不合法返回 400。
- 错误格式：`{ "error": { "code": "EMAIL_CODE_INVALID", "message": "验证码不对" } }`。

| HTTP | code | 场景 |
|---|---|---|
| 400 | `BAD_REQUEST` | 参数不合法 |
| 401 | `UNAUTHORIZED` | 没带令牌或令牌过期 |
| 401 | `REFRESH_INVALID` | 刷新令牌无效、过期或被撤销 |
| 404 | `NOT_FOUND` | |
| 409 | `CONFLICT` | 例如设备 ID 已被别的账号使用 |
| 422 | `EMAIL_CODE_INVALID` / `EMAIL_CODE_EXPIRED` / `EMAIL_CODE_LOCKED` | 验证码错误 / 过期 / 错误次数超限 |
| 429 | `RATE_LIMITED` | 带 `Retry-After` 头 |
| 500 | `INTERNAL` | 不返回内部细节 |

## 2. 令牌

- 访问令牌：JWT（HS256，密钥 `JWT_SECRET`，至少 32 字节随机），有效期 15 分钟，载荷 `{ sub: userId, did: deviceId }`。
- 刷新令牌：32 字节随机数的 base64url，服务器只存 sha256；有效期 180 天；**每次刷新都换新**（旧的标记 `replaced_by`）。如果有人用了已经被换掉的旧令牌，说明可能泄露，撤销这台设备的全部令牌。
- App 端：令牌存 `expo-secure-store`；收到 401 自动刷新一次再重试；刷新失败就重新注册匿名账号（如果绑定过邮箱，提示重新验证邮箱）。
- iOS 卸载重装后，钥匙串（SecureStore）里的旧令牌还在，但本地数据库是新的。所以本地数据库新建时（`kv` 里没有 `device_id`），先清空 SecureStore 里的令牌，再走匿名注册。

## 3. 接口列表

### 3.1 账号

| 方法 路径 | 认证 | 请求 | 响应 | 说明 |
|---|---|---|---|---|
| `POST /auth/anonymous` | 无 | `{ deviceId, platform, appVersion }` | `{ userId, accessToken, refreshToken, expiresIn }` | 新建匿名账号和设备。deviceId 已存在则 409（App 应该走刷新）。每 IP 每小时 20 次 |
| `POST /auth/refresh` | 无 | `{ refreshToken }` | `{ accessToken, refreshToken, expiresIn }` | |
| `POST /auth/email/send` | 需要 | `{ email }` | 204 | 发绑定验证码。同一邮箱 60 秒 1 次、每天 10 次；同一 IP 每天 30 次 |
| `POST /auth/email/verify` | 需要 | `{ email, code }` | `{ userId, accessToken, refreshToken, merged: boolean, restoredWords: number }` | 见第 5 节 |
| `DELETE /account` | 需要 | — | 204 | 删除当前账号全部数据 |
| `POST /account/delete-request` | 无 | `{ email }` | 204 | 官网注销页：发送 purpose=delete 的验证码。限流同上。邮箱不存在也返回 204（不泄露是否注册） |
| `POST /account/delete-confirm` | 无 | `{ email, code }` | 204 | 验证通过后删除该邮箱账号的全部数据 |

验证码：6 位数字，`crypto.randomInt`；10 分钟有效；最多试 5 次，超过作废；只有最新一条有效。邮件标题「{APP_NAME} 验证码：381927」，正文只有验证码和「10 分钟内有效，如果不是你本人操作请忽略」。

**删除账号**：在一个事务里删除 `app_user`（外键级联删除设备、令牌、设置、组、作答、单词状态），再删除该邮箱的 `email_code` 记录。服务器日志里不记录邮箱原文（只记 sha256 前 8 位）。数据库备份按 30 天滚动过期，隐私政策里写明。

### 3.2 词包

| 方法 路径 | 认证 | 响应 |
|---|---|---|
| `GET /pack/manifest` | 无 | `{ version: 1, url: "https://cdn.yanxai.com/packs/pack-v1.db.gz", sha256, bytes, wordCount: 19094, audioVersion: "v1", minAppVersion: "1.0.0" }` |

### 3.3 词典查询（整本词典）

| 方法 路径 | 认证 | 说明 |
|---|---|---|
| `GET /dict/search?q=ela&limit=20` | 无，每 IP 每分钟 60 次 | 按 `word_lc` 前缀查整本 770,611 条，返回 `[{ word, us, uk, brief }]`，`brief` 为第一行释义的前 3 个义项 |
| `GET /dict/entry/:word` | 无 | 返回单个词条的完整信息（meanings、extra、tags、frq、collins、oxford、exchange、definition_en） |

v1 的 App 界面暂不调用这两个接口（整本查词页面在以后的版本里做，需先出图验收），但接口要实现并测试，用于验证整本入库，也供以后使用。

### 3.4 同步

`POST /sync`（需要认证），见第 4 节。

### 3.5 健康检查

`GET /healthz` → `{ ok: true, db: true, version: "<git sha>" }`；数据库不通时返回 503。

## 4. 同步协议

### 4.1 什么时候同步

- 一组结束（进入小结时）。
- App 回到前台；App 进入后台前（尽力而为）。
- 有未上传的数据时，每 60 秒一次（只在 App 前台时）。
- 网络从断开恢复时。
- 在 P9 点同步状态时；绑定邮箱、注销、重置之前。
- 同一时间只允许一个同步请求；失败按 5 秒、15 秒、60 秒、5 分钟退避重试。

### 4.2 请求

```json
{
  "deviceId": "5b0e…",
  "cursor": 1834,
  "answers": [
    { "id": "…", "groupId": "…", "groupSeq": 13, "itemIndex": 7, "word": "elaborate",
      "mode": "look", "result": 0, "masteryTarget": 2, "clientTs": "2026-10-21T08:15:03.120+08:00" }
  ],
  "undos": [ { "id": "…", "targetId": "…", "clientTs": "…" } ],
  "groups": [ { "id": "…", "seq": 13, "kind": "normal", "mode": "look", "items": [{"w":"elaborate","r":true}],
                "cursor": 8, "status": "active", "startedAt": "…", "finishedAt": null, "activeMs": 182000 } ],
  "settings": { "value": { … }, "clientUpdatedAt": "…" }
}
```

- `answers`、`undos`：本地 `synced = 0` 的记录，每次最多 500 条（按 client_ts 升序），多了分批。
- `groups`：本地 `dirty = 1` 的组。
- `settings`：本地设置有改动时才带。
- `cursor`：上次同步拿到的服务器游标；第一次是 0。

### 4.3 服务器处理（一个事务）

1. 写入 `answers`：`INSERT … ON CONFLICT (id) DO NOTHING`；`user_id` 一律用令牌里的，不信任客户端。拒绝 `word` 不在 `dict_entry` 里的作答（记入 `rejected`）。
2. 处理 `undos`：写入 `undo_event`（幂等）；把目标作答的 `voided_by` 设为撤销 id（目标必须属于同一用户，否则拒绝）。
3. 收集这次受影响的词，对每个词取全部 `voided_by IS NULL` 的作答，用 `core.replay` 重新计算：
   - 有结果 → upsert `user_word`（`change_seq = nextval`），删除对应的 tombstone；
   - 没有结果 → 删除 `user_word` 行，写入 tombstone。
4. upsert `groups`：按 id；只有当传入的 `cursor` 更大，或状态从 active 变为 finished/abandoned 时才更新（防止旧数据覆盖新数据）；更新 `change_seq`。
5. 设置：`clientUpdatedAt` 比服务器存的新才覆盖。
6. 查出 `change_seq > cursor` 的 `user_word`、`user_word_tombstone`、`study_group`、`user_settings`，按 `change_seq` 升序，最多 2,000 条。

### 4.4 响应

```json
{
  "acceptedAnswers": ["…"], "acceptedUndos": ["…"], "acceptedGroups": ["…"],
  "rejected": [{ "id": "…", "code": "UNKNOWN_WORD" }],
  "words": [ { "word": "elaborate", "status": 1, "wrongCount": 3, "rightCount": 0, "streak": 0, "seenCount": 3,
               "firstSeenAt": "…", "lastSeenAt": "…", "lastWrongAt": "…", "masteredAt": null,
               "masteredVia": null, "lastSeenGroupSeq": 13 } ],
  "deletedWords": ["…"],
  "groups": [ … ],
  "settings": { "value": { … }, "clientUpdatedAt": "…" },
  "maxGroupSeq": 13,
  "cursor": 1901,
  "hasMore": false
}
```

### 4.5 客户端处理（一个事务）

1. 把 accepted 的记录标记 `synced = 1` / `dirty = 0`；rejected 的也标记已同步（记日志，不重试）。
2. 用 `words` 覆盖本地 `user_word`，删除 `deletedWords`。
3. **补上请求发出之后才产生的本地作答**：对受影响的词，找出本地 `synced = 0` 且未撤销的作答，在服务器状态的基础上用 `applyAnswer` 按时间顺序再应用一遍。
4. 合并 `groups`：本地没有的写入（状态非 active 的直接写；服务器上 active 而本地已有别的 active 组时，把服务器那组当作 abandoned 存下，避免同时有两个进行中的组）。
5. 设置：服务器的 `clientUpdatedAt` 更新时，覆盖本地设置。
6. 保存 `cursor`、`maxGroupSeq`、`last_sync_at`。`hasMore` 为 true 时立刻再请求一次（不带新数据）。

### 4.6 正确性要求

- 同一批数据重复上传（比如网络超时后重试），结果不变（幂等）。
- 两台设备交替离线学习后都同步，最终两边的 `user_word` 完全一致，并且等于用全部有效作答重新计算的结果。
- 写成集成测试（真实 Postgres）：两个模拟客户端、乱序上传、重复上传、撤销跨批次到达。

## 5. 绑定邮箱与账号合并

`POST /auth/email/verify` 的逻辑（一个事务）：

1. 校验验证码（最新一条，未过期，未使用，次数 < 5；错误时 attempts + 1）。
2. 查邮箱对应的账号 E：
   - **没有** → 给当前账号 U 设置邮箱。`merged = false`。
   - **E == U** → 什么都不做。
   - **E != U**（典型场景：新手机上的匿名账号绑定旧邮箱）→ **把 U 合并进 E**：
     1. U 的 `device`、`answer_event`、`undo_event`、`study_group` 全部改到 E 名下（`user_id = E`）。
     2. 对所有涉及的词（U 和 E 的作答涉及的词），用 E 名下的全部有效作答重新计算 `user_word`。
     3. 设置：取 `clientUpdatedAt` 更新的那份。
     4. 撤销 U 的全部刷新令牌，U 标记 `merged_into = E`（清理任务 30 天后删除）。
     5. 给当前设备签发 E 的新令牌。`merged = true`，`restoredWords` = 合并后 E 的 user_word 行数。
3. App 收到 `merged = true`：保存新令牌，把 `sync_cursor` 设为 0，做一次完整同步（本地 `user_word` 以服务器为准重建）；如果本地有进行中的组，保留它。

## 6. 安全清单

- 所有接口限流（全局每 IP 每分钟 300 次，敏感接口见上）。
- `@fastify/helmet` 默认安全头；CORS 只允许 `https://yanxai.com`（官网注销页用），App 请求不受 CORS 影响。
- 验证码和令牌比较用常数时间比较。
- SQL 全部参数化（Drizzle 默认如此）。
- 日志不记录令牌、验证码、邮箱原文。
- 机密只放在服务器的 `.env`（权限 600），不进仓库；仓库只有 `.env.example`。
