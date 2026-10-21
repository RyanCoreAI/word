# 02 · 学习规则（精确定义）

本文是学习逻辑的**唯一标准**。实现放在 `packages/core`，手机端和服务器共用同一份代码，结果必须完全一致。
所有函数都是**纯函数**：不读时钟、不读数据库、不产生随机数，需要的东西都从参数传入。

## 1. 用大白话说

1. 每组 20 个词（可设）。先放该复习的词，不够再补新词，顺序打乱。
2. 新词第一次出现就点「认识」→ 直接算**已掌握**，以后不再出现。
3. 点「不认识」→ 变成**学习中**，不认识次数 +1，并且**下一组一定再出现**。
4. 学习中的词，之后每组都会出现一次。要**连续认识 2 次**（可设 1–3）才算掌握；中间只要再点一次不认识，就从 0 重新数。
5. 两种模式（看词、听音）共用同一份进度：在看词模式里没认出来的词，下一组哪怕用听音模式，也会出现。
6. 一组没学完就退出，下次从同一个词接着来；也可以放弃这组，没出现的词不受影响。

## 2. 数据类型

```ts
// packages/core/src/types.ts
export type WordKey = string;               // 单词原文，如 "elaborate"；全局唯一主键
export type Mode = 'look' | 'listen';       // 看词记忆 | 听音辨词
export type GroupKind = 'normal' | 'wordbook';
export enum Status { NEW = 0, LEARNING = 1, MASTERED = 2 }
export enum Result { UNKNOWN = 0, KNOWN = 1 }

export interface WordState {
  word: WordKey;
  status: Status;
  wrongCount: number;          // 累计不认识次数（不含已撤销）
  rightCount: number;          // 累计认识次数（不含已撤销）
  streak: number;              // 学习中时，当前连续认识次数
  seenCount: number;           // 累计出现并作答的次数
  firstSeenAt: number | null;  // 毫秒时间戳
  lastSeenAt: number | null;
  lastWrongAt: number | null;
  masteredAt: number | null;
  masteredVia: 'first_sight' | 'review' | null;
  lastSeenGroupSeq: number | null;   // 最近一次作答所在组的序号
}

export interface Answer {
  id: string;                  // UUID v4，客户端生成
  word: WordKey;
  groupId: string;
  groupSeq: number;
  itemIndex: number;           // 在组内的位置，0 起
  mode: Mode;
  result: Result;
  masteryTarget: 1 | 2 | 3;    // 作答当时的「掌握标准」设置
  clientTs: number;            // 毫秒时间戳
}

export interface Settings {
  scopes: Array<'gk' | 'cet4' | 'cet6' | 'ky' | 'toefl' | 'ielts' | 'gre' | 'hf'>;
  filterBasic: boolean;
  groupSize: 10 | 20 | 30 | 50;
  masteryTarget: 1 | 2 | 3;
  order: 'frequency' | 'random';
  randomSeed: number;          // 首次启动时生成的 32 位无符号整数，之后不变
  accent: 'us' | 'uk';
  autoPlay: boolean;
  playCount: 1 | 2 | 3;
  slow: boolean;
  haptics: boolean;
}

export const DEFAULT_SETTINGS: Omit<Settings, 'randomSeed'> = {
  scopes: ['cet4', 'cet6', 'ky', 'toefl', 'ielts', 'gre'],
  filterBasic: true, groupSize: 20, masteryTarget: 2, order: 'frequency',
  accent: 'us', autoPlay: true, playCount: 1, slow: false, haptics: true,
};
```

## 3. 单次作答：`applyAnswer(prev, answer) → WordState`

```ts
export function applyAnswer(prev: WordState | undefined, a: Answer): WordState {
  const s: WordState = prev ? { ...prev } : newState(a.word);
  const before = s.status;
  s.seenCount += 1;
  s.firstSeenAt ??= a.clientTs;
  s.lastSeenAt = a.clientTs;
  s.lastSeenGroupSeq = a.groupSeq;

  if (a.result === Result.UNKNOWN) {
    s.wrongCount += 1;
    s.lastWrongAt = a.clientTs;
    s.status = Status.LEARNING;
    s.streak = 0;
    s.masteredAt = null;
    s.masteredVia = null;
    return s;
  }

  // KNOWN
  s.rightCount += 1;
  if (before === Status.NEW) {
    s.status = Status.MASTERED;
    s.masteredAt = a.clientTs;
    s.masteredVia = 'first_sight';
  } else if (before === Status.LEARNING) {
    s.streak += 1;
    if (s.streak >= a.masteryTarget) {
      s.status = Status.MASTERED;
      s.streak = 0;
      s.masteredAt = a.clientTs;
      s.masteredVia = 'review';
    }
  }
  // MASTERED + KNOWN（只会在生词本组里发生）：状态不变
  return s;
}
```

`newState(word)`：status NEW，各计数 0，时间字段 null。

### 3.1 重新计算：`replay(events) → WordState | undefined`

```ts
export function replay(word: WordKey, events: Answer[]): WordState | undefined {
  const sorted = [...events].sort((x, y) => x.clientTs - y.clientTs || (x.id < y.id ? -1 : x.id > y.id ? 1 : 0));
  return sorted.reduce<WordState | undefined>((s, e) => applyAnswer(s, e), undefined);
}
```

- 只传入**没被撤销**的作答。
- 服务器每次收到某个词的新作答或撤销，就用这个词的全部有效作答重新计算状态（每个词通常只有几条到二十几条，开销可以忽略）。合并账号时也用这个函数。
- 手机端平时用 `applyAnswer` 增量更新；撤销时恢复快照（见第 6 节）；同步后用服务器返回的状态覆盖（见 `06-api-sync.md`）。

## 4. 出组：`buildGroup(input) → GroupPlan`

```ts
export interface BuildGroupInput {
  newSeq: number;                       // 新组的序号 = 已知最大序号 + 1
  kind: GroupKind;
  size: number;                         // settings.groupSize
  learning: WordState[];                // 所有 status = LEARNING 的词（不受词库范围限制）
  newCandidates: WordKey[];             // 已按出词顺序排好、status = NEW、属于当前词库范围的词，至少取 size 个
  wordbookCandidates?: WordKey[];       // kind = 'wordbook' 时使用，已按生词本当前排序排好
  shuffleSeed: number;                  // 由组 ID 哈希得到，见 4.3
}
export interface GroupPlan { items: Array<{ word: WordKey; review: boolean }>; reviewCount: number; newCount: number }
```

### 4.1 普通组（kind = normal）

1. **到期的复习词** = `learning` 里满足 `lastSeenGroupSeq < newSeq` 的词。
2. 排序：`lastSeenGroupSeq` 升序（越早见过越先出），再按 `wrongCount` 降序，再按 `lastWrongAt` 降序，最后按单词字母序。
3. 取前 `size` 个作为复习词（`review: true`）。
4. 不够 `size` 时，从 `newCandidates` 顺序补新词（`review: false`），补到 `size` 为止。
5. 用 4.3 的洗牌把整组打乱。
6. 复习词和新词都没有时，返回空组；界面显示「词库已全部学完」。

> 说明：正常使用时，所有学习中的词都在上一组里出现过，所以到期的复习词不会超过一组的大小。只有在调小每组词数、放弃组、或在多台设备上交替学习时，才可能超过；超出的部分留到再下一组。

### 4.2 生词本组（kind = wordbook）

- 只用 `wordbookCandidates` 的前 `size` 个，`review` 全部为 true，不补新词。
- 生词本里的三个分段分别对应：学习中 = LEARNING；已掌握 = MASTERED 且 wrongCount > 0；全部 = wrongCount > 0。
- 排序跟随生词本当前的排序方式（按不认识次数降序，或按最近不认识时间降序）。
- 同样洗牌。

### 4.3 洗牌（必须可复现）

- `shuffleSeed = fnv1a32(groupId)`（FNV-1a 32 位，输入为组 UUID 的小写字符串）。
- 伪随机数用 mulberry32(seed)；洗牌用 Fisher–Yates，从后往前。
- 同样的输入必须得到同样的顺序（写进单元测试）。

### 4.4 新词候选顺序

- **按词频**：词包里的 `rank` 升序（`03-dictionary-data.md` 第 6 节）。
- **随机**：`rank` 经过 `settings.randomSeed` 置换后的顺序。实现：`ORDER BY ((rank * 2654435761 + randomSeed) % 4294967296)`（在 JS 里用 `Math.imul` 和 `>>> 0` 计算，手机端 SQL 里先算好存一列 `rand_key`，换种子时重算）。
- 词库范围筛选：`(word.tags & scopeMask) != 0`；开了过滤基础词时再加 `word.basic = 0`。
- 只取 status 为 NEW 的词（在 `user_word` 里没有记录，或记录的 status = 0）。

## 5. 组的生命周期

```
active ──最后一个词作答完成──> finished
active ──在 P11 选择放弃────> abandoned
```

- **只能有一个 active 组**。新建组之前，必须先 finish 或 abandon 现有的 active 组。
- 组记录：`id`（UUID）、`seq`、`kind`、`mode`、`items`、`cursor`（下一个要答的位置，0 起）、`status`、`startedAt`、`finishedAt`、`activeMs`（在学习页前台累计的毫秒数，用于「用时」）。
- 每次作答：`cursor = itemIndex + 1`；`cursor == items.length` 时 status = finished。
- 放弃：没答的词什么都不变（新词还是新词，复习词仍然到期）。
- 组序号：`newSeq = max(本地最大 seq, 服务器返回的 maxGroupSeq) + 1`。多台设备离线时可能出现同号的组，这是允许的，规则只用 `<` 比较，不受影响。
- 模式只决定界面，不影响出组和计分。

## 6. 撤销

- 只能撤销**当前 active 组**里的作答，按相反顺序一个个撤（栈）。
- 每条作答保存 `prevState`（作答前这个词的 WordState，新词为 null）。
- 撤销一条作答：
  1. 生成撤销事件 `{ id: uuid, targetId: answer.id, clientTs }`；
  2. 把作答标记为已撤销（`voidedBy = 撤销事件 id`）；
  3. 这个词的状态恢复为 `prevState`（null 就删除该词的记录）；
  4. 组的 `cursor = answer.itemIndex`；组的 status 变回 active（如果原来是 finished）——但界面上进入小结后不提供撤销，所以实际只会在 active 时发生。
- 服务器收到撤销事件：标记目标作答已撤销，然后对该词重新计算（第 3.1 节）。

## 7. 统计口径

| 指标 | 定义 |
|---|---|
| 当前词库总数 | 词包里满足当前词库范围和过滤开关的词数 |
| 已掌握（首页大数字） | 当前词库内 status = MASTERED 的词数 |
| 学习中（首页） | 所有 status = LEARNING 的词数（包括已经不在当前词库范围内的） |
| 未学 | 当前词库总数 − 当前词库内已掌握 − 当前词库内学习中 |
| 已掌握百分比 | 已掌握 ÷ 当前词库总数，保留 1 位小数，向下取整 |
| 圆环黄色段 | 当前词库内学习中 ÷ 当前词库总数 |
| 今天 a 组 | 今天（本机时区自然日）finished 的组数 |
| 今天认识 b / 不认识 c | 今天的有效作答中 result = 1 / 0 的条数 |
| 连续 N 天 | 从今天（今天没完成组就从昨天）往前数，每天至少完成 1 组的连续天数 |
| 小结·认识 / 不认识 | 本组有效作答中 result = 1 / 0 的条数 |
| 小结·新掌握 | 本组有效作答中，`prevState.status != MASTERED` 且作答后 status = MASTERED 的条数 |
| 小结·用时 | 组的 `activeMs`，四舍五入到秒 |
| 生词本数量 | wrongCount > 0 的词数，按分段过滤 |

## 8. 设置变化的影响

| 设置 | 影响 |
|---|---|
| 词库范围、过滤基础词 | 只影响之后补进来的**新词**；已经在学习中的词照常复习 |
| 每组单词数 | 下一组起生效 |
| 掌握标准 | 之后的作答按新值判断（作答里记录当时的值，重新计算时用记录的值）；已经掌握的词不会因为调高而变回学习中 |
| 出词顺序 | 下一组起生效 |
| 口音、自动朗读、朗读遍数、慢速、振动 | 立即生效，不影响学习数据 |

## 9. 测试用例（必须全部写成单元测试）

记号：N = 掌握标准；S(状态, wrong, right, streak)。

| # | 前状态 | 作答 | 后状态 | 说明 |
|---|---|---|---|---|
| T1 | 无 | KNOWN, N=2 | S(MASTERED, 0, 1, 0), via first_sight | 一眼认识 |
| T2 | 无 | UNKNOWN | S(LEARNING, 1, 0, 0) | |
| T3 | S(LEARNING, 1, 0, 0) | KNOWN, N=2 | S(LEARNING, 1, 1, 1) | |
| T4 | S(LEARNING, 1, 1, 1) | KNOWN, N=2 | S(MASTERED, 1, 2, 0), via review | |
| T5 | S(LEARNING, 1, 1, 1) | UNKNOWN | S(LEARNING, 2, 1, 0) | 清零 |
| T6 | S(LEARNING, 3, 0, 0) | KNOWN, N=1 | S(MASTERED, 3, 1, 0) | 掌握标准 1 |
| T7 | S(LEARNING, 1, 2, 2) | KNOWN, N=3 | S(MASTERED, 1, 3, 0) | 掌握标准 3 |
| T8 | S(MASTERED, 2, 3, 0) | UNKNOWN | S(LEARNING, 3, 3, 0), masteredAt = null | 生词本组里又不认识 |
| T9 | S(MASTERED, 2, 3, 0) | KNOWN | S(MASTERED, 2, 4, 0)，masteredAt 不变 | |
| T10 | — | 第 3 组 UNKNOWN（累计第 3 次）→ 第 4 组 KNOWN → 第 5 组 KNOWN（N=2） | 第 4 组后 LEARNING streak 1；第 5 组后 MASTERED | 原型 1-2、1-3 的 elaborate 例子 |

| # | 出组场景 | 期望 |
|---|---|---|
| G1 | size 20，到期复习词 6 个，新词充足 | 6 复习 + 14 新词 |
| G2 | size 20，到期 25 个（之前调小过组大小） | 20 个复习（按 4.1 排序取前 20），0 新词；剩下 5 个下一组到期 |
| G3 | 某词 lastSeenGroupSeq = 13，newSeq = 13 | 不到期（同号组，多设备场景） |
| G4 | 第 12 组里不认识，第 13 组放弃时还没轮到它 | 第 14 组仍然到期 |
| G5 | 新词只剩 3 个，到期复习 0 个，size 20 | 组大小 3 |
| G6 | 新词 0，复习 0 | 空组 |
| G7 | 同样的输入和 groupId 调用两次 | 顺序完全相同 |
| G8 | 生词本组，候选 214 个，size 20 | 候选的前 20 个，全部 review = true |
| G9 | 词库范围改为只选 GRE，有 5 个四级词在学习中 | 这 5 个仍然到期出现 |

| # | 撤销场景 | 期望 |
|---|---|---|
| U1 | 新词 UNKNOWN 后撤销 | 该词记录被删除（回到 NEW）；cursor 回退 1 |
| U2 | LEARNING streak 1 的词 KNOWN（掌握）后撤销 | 恢复为 LEARNING streak 1 |
| U3 | 连续撤销 3 次 | 依次恢复 3 个词，cursor 回退 3 |
| U4 | 服务器：作答 A1(UNKNOWN)、A2(KNOWN)，撤销 A2 | 重新计算 = 只应用 A1 |

| # | 合并场景 | 期望 |
|---|---|---|
| M1 | 设备 A：词 x 在 t1 UNKNOWN；设备 B：词 x 在 t2 KNOWN（t2 > t1） | 合并后按时间重新计算：LEARNING，wrong 1，right 1，streak 1 |
| M2 | 两边同一个作答 id 重复上传 | 只算一次 |
