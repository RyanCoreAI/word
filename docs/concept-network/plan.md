# 概念网络训练器 · 软件方案 v1

> 2026-10-23。这是一个独立新产品的方案，暂存在本仓库 `docs/concept-network/`，和背单词网页（`docs/00-web-plan.md`）无关，不改变它的范围和规则。正式开发时建议新建仓库，沿用本仓库的工具链和代码约定。

## 0. 一句话

一个本地优先的网页应用（手机和电脑都能装成 App）：你把学到的东西写成「概念 —关系→ 概念」的命题，软件负责三件事：

1. **训练**：用闭卷重建和间隔复习，把关系真正记住、用熟；
2. **诊断**：根据图的结构和你每次复习的表现，算出哪些知识是孤岛、哪些是空中楼阁、哪块地基最该补；
3. **转化**：把诊断变成每天 15 分钟、每周 3 个的具体练习。

数据只存在你的设备上，可以导出成纯文本，十年后也能读。

## 1. 先想清楚：为什么「画知识图谱」常常没用

| 常见做法 | 问题 |
|---|---|
| Obsidian / Logseq 双链 + 图谱视图 | 链接没有类型，只表示「有关」；几百个节点后变成毛线团，看着壮观，却回答不了「哪里缺基础」 |
| Anki 卡片 | 训练的正是一个个孤立的知识点，恰好是概念网络想消除的东西 |
| 思维导图 | 只有上下级树结构，没有跨枝连接；而跨枝连接正是理解的标志 |
| 对着书画概念图 | 有用，但不如合上书回忆：开卷画图的效果输给提取练习（Karpicke & Blunt, 2011） |

研究给出的方向很明确：

- 自己构建概念图比看现成的图更有效（元分析：构建 g = 0.72，学习现成图 g = 0.43；Schroeder 等, 2018）。
- 合上书、凭记忆画图，就同时获得了提取练习的效果（Blunt & Karpicke, 2014）。
- 间隔练习和自我测试是证据最强的两种学习方法；自我解释、追问为什么、交错练习次之（Dunlosky 等, 2013）。

由此得出 7 条设计原则：

1. **你来造，软件来查。** 软件和 AI 永远不替你生成图；生成本身就是学习。
2. **先闭卷，再对照。** 每次建图先凭记忆写，再开书补漏；补上的部分单独标记、更早复习。
3. **知识的单位是命题（边），不是名词（点）。** 每条边都能读成一句话（「价格上限导致短缺，因为……」），复习的就是这句话。
4. **边有类型，类型决定算法。** 「前置」用来找地基漏洞，「导致 / 解释」衡量理解，「例子 / 应用」衡量能不能用，「对比」生成辨析题，「类比」促成跨领域迁移。
5. **诊断必须能行动。** 每周最多 3 个任务，每条都说明依据；不展示 200 条警告。
6. **复习失败是修图的线索。** 一条关系反复记不住，多半不是记性问题，而是缺前置、表述不清或和别的概念混淆。
7. **图是体检仪表，不是装饰。** 全局大图只在体检时用；日常看的是以某个概念为中心的局部图。

## 2. 训练方法

### 2.1 核心循环

```
学习材料（书 / 课 / 文章）
   │
   ▼
① 闭卷倾倒 3–5 分钟：凭记忆写下概念和命题
   │
   ▼
② 对照补漏：打开原文，补上漏掉的（标「补」），改正错的（标「纠」）
   │
   ▼
③ 间隔复习：到期的关系卡、邻域重建、费曼解释（FSRS 调度）
   │
   ▼
④ 整合练习：辨析、桥接、因果链推演
   │
   ▼
⑤ 每周体检：孤岛、惰性知识、空中楼阁、地基漏洞 → 本周 3 个修补任务
   └──────────────── 修补任务回到 ③ ④ ────────────────┘
```

捕获本身就是第一次复习：闭卷写出的命题记一次「良好」（Good），对照后才补上或改正的记一次「重来」（Again）。前者几天后再出现，后者第二天就出现。

### 2.2 练习类型

| # | 练习 | 怎么做 | 练的是什么 | 依据 |
|---|---|---|---|---|
| 1 | 闭卷倾倒 | 学完一节，合上书，计时 3–5 分钟，用文本语法写概念和命题 | 提取、生成 | 提取式概念图（Blunt & Karpicke, 2014） |
| 2 | 对照补漏 | 开书核对：漏的加上并标「补」，错的改正并标「纠」 | 及时反馈 | 测试后反馈 |
| 3 | 关系回忆 | 题面三种轮换：「A —导致→ ?」「? —导致→ B」「A 和 B 是什么关系？为什么？」；先打字作答、选信心，再揭晓 | 关系和机制 | 提取练习、追问为什么 |
| 4 | 邻域重建 | 给一个中心概念，3 分钟内写出所有与它相连的概念和关系类型；软件比对：想起的、漏掉的、新冒出来的 | 整合、结构 | 闭卷构图 |
| 5 | 费曼解释 | 用不超过 150 字向外行解释 X，用 `[[ ]]` 标出用到的概念；软件高亮其中薄弱或未定义的概念 | 暴露理解缺口 | 自我解释效应（Chi 等, 1989） |
| 6 | 辨析 | 对两个「易混」概念说出关键区别，各举一例；相关的两题相邻出现 | 区分 | 交错与对比（Kang & Pashler, 2012） |
| 7 | 桥接 | 软件挑两个分属不同领域的概念（其中一个是孤岛或封闭领域里的）：写出有实质机制的关系，或回答「没有实质关系」 | 跨领域整合 | Novak 的交叉连接；类比迁移（Gick & Holyoak, 1983） |
| 8 | 因果链推演 | 沿带正负号的因果链提问：「A 增加时 C 会怎样？经过哪些环节？」软件按符号相乘出题并核对 | 推理而不是背诵 | 由「导致」边的方向和正负号自动生成 |
| 9 | 地基修补 | 针对体检选出的地基漏洞：先解释它，再回原文重学，然后重测依赖它的概念 | 先补基础再往上走 | 知识空间理论（Doignon & Falmagne, 1985） |
| 10 | 迁移测试（每月） | 找一个新问题、新闻或现象，只用图里的概念解释它；记录用到了哪些概念、新建了哪些边 | 迁移 | 检验图是否真的能用 |

「没有实质关系」是合法答案。桥接新建的边默认标为「推测」，连续两次复习站得住才升为「相信」，避免为了连而连。

### 2.3 作答与打分

1. **必须先作答再揭晓。** 默认打字（可以用系统语音输入）；赶时间时可以选「只在脑中答」，但每周至少有一次全部打字。
2. **揭晓前选信心（1–4）。** 一是画校准曲线，和估算训练是同一个思路；二是抓「高信心错误」——自信却答错的内容，纠正后反而记得最牢（hypercorrection，Butterfield & Metcalfe, 2001）。每次训练结束时，高信心错误单独列出，要求写一句更正。
3. **打分标准**（对照自己当初写的命题）：
   - 重来（Again）：没想起或答错；
   - 困难（Hard）：对象对了，但机制或理由缺失，或想了很久；
   - 良好（Good）：对象和机制都对；
   - 简单（Easy）：脱口而出且完整。
4. **钉子户处理。** 一条关系累计遗忘 4 次后，不再机械重复，而是问「为什么记不住？」：
   - 缺前置 → 新建一条「前置」关系和一个待定义概念；
   - 表述不清 → 改写命题；
   - 和 X 混淆 → 新建「对比」关系，进入辨析题；
   - 不重要 → 停止复习（仍保留在图里）。

### 2.4 节奏

| 频率 | 时长 | 内容 |
|---|---|---|
| 学新东西时 | 计入学习时间 | 闭卷倾倒 + 对照补漏 |
| 每天 | 默认 15 分钟（可调） | 到期的邻域重建 → 到期关系卡（按领域交错，易混的相邻）→ 1 道辨析或桥接 → 1 个本周修补任务 |
| 每周 | 约 30 分钟 | 看体检报告；完成 3 个修补任务；合并重复概念；把「相关」升级为具体关系 |
| 每月 | 约 20 分钟 | 迁移测试；看效果指标 |

每天新进入复习的关系默认最多 20 条，防止复习量滚雪球；积压超过 3 天的量时进入「清欠模式」，按「越可能忘 ×（1 + 依赖它的概念数）」排序，先保地基。

### 2.5 怎么知道有效

| 指标 | 含义 | 好的趋势 |
|---|---|---|
| 邻域重建召回率（30 天滚动） | 只给中心概念，能想起多少相连的关系 | 上升 |
| 首测遗漏率 | 新主题倾倒后，「补」和「纠」占全部命题的比例 | 下降，说明读的时候就在建构 |
| 实际保持率 | 到期复习答对的比例，对比目标 90% | 接近目标 |
| 校准误差 | 信心和正确率的差距 | 缩小 |
| 跨领域连接占比 | 连接不同领域的边占全部边的比例 | 上升 |
| 孤岛数、地基漏洞数 | 体检结果 | 下降 |
| 迁移测试自评 | 能否用图解释新问题 | 上升 |

概念数和连续打卡天数可以显示，但不作为目标——它们奖励的是收集，不是理解。

### 2.6 落地起步

1. **只选一个正在学的领域。** 一本书或一门课。不导入旧笔记——那会直接复刻收集癖。
2. **概念的粒度**：能用一句话定义、并且会出现在多个命题里的名词或现象。一整段原文不是概念，「第三章」也不是。
3. **选关系类型的判断题**：「不懂 B，能真正懂 A 吗？」不能 → A 前置 B；「B 是因为 A 才发生的吗？」是 → A 导致 B。拿不准就先用「相关」，体检会提醒你升级。
4. **第 1–2 周**：每读完一节做倾倒和对照，图里不超过 50 个概念；开始每日复习。
5. **第 3 周起**：开启每周体检和桥接。
6. **第 2 个月起**：引入第二个领域，桥接开始真正有用。

### 2.7 一个具体例子（经济学入门）

倾倒时写：

```
# 来源：《经济学原理》第 6 章
价格上限 -导致-> 短缺 // 价格被压在均衡以下，需求量大于供给量
价格上限 -需要-> 供需均衡
短缺 -导致-> 排队与黑市
```

对照原文，发现漏了「价格上限只有低于均衡价格时才有约束力」，补上一条，标「补」。

两周后的体检：你能流利复述「价格上限导致短缺」（掌握度 0.92），但它的前置「供需均衡」掌握度只有 0.45，而依赖「供需均衡」的概念有 6 个。体检给出：

- 空中楼阁：价格上限、价格下限、税收归宿……都建在不牢的「供需均衡」上；
- 本周任务：「供需均衡」地基修补 → 费曼解释 → 回原文重学 → 重测这 6 个下游概念。

## 3. 「孤立」和「缺基础」的可计算定义

### 3.1 掌握度

- 一条关系的掌握度 r：FSRS 算出的当前回忆概率（0–1）。
- 一个概念的掌握度 m：与它相连、已复习过的关系卡和解释卡的 r 加权平均（前置、解释、导致的权重高；解释卡权重 2）。
- 从未复习过的概念标「未验证」，单独显示，不和「薄弱」混在一起；计算地基时按 0.5 处理并注明。

### 3.2 诊断项

| 编号 | 名称 | 定义 | 默认阈值 | 给出的行动 |
|---|---|---|---|---|
| D1 | 孤点、孤岛 | 忽略方向求连通分量：度为 0 的是孤点；不属于最大分量的小分量是孤岛 | 任何 | 桥接题：与主体里最核心（PageRank 高）且掌握牢固的概念配对 |
| D2 | 封闭领域 | Louvain 社区划分（固定随机种子）；一个领域对外连接的边占比过低。节点层面用参与系数找只在圈内连接的枢纽 | 规模 ≥ 8 且外连 < 5% | 该领域和其他领域之间的桥接题 |
| D3 | 惰性知识 | 有 ≥ 2 条边，但全是「是一种 / 组成 / 相关」，没有导致、解释、应用、例子、对比、类比——只知道是什么，不知道为什么、怎么用 | — | 补一个例子或机制 |
| D4 | 空中楼阁 | 地基分 f(c) = min(m(c), 所有前置的 f)。m 高而 f 低：你会说 c，但它依赖的某个基础不牢；沿取最小值的路径回溯，指出根因概念 | m ≥ 0.85 且 f ≤ 0.6 | 修补根因概念 |
| D5 | 地基漏洞排序 | 优先级 = (1 − m(u)) × (1 + 下游数(u))；下游数 = 直接或间接需要 u 的概念数 | 前 3 名 | 地基修补 |
| D6 | 缺失前置 | ① 解释里 `[[引用]]` 了但还没定义的概念；② 钉子户报告「缺前置」；③ 遗忘率高却没有任何前置边的概念 | — | 提问「学它之前需要先懂什么？」 |
| D7 | 循环依赖 | 前置图里大于 1 的强连通分量（Tarjan） | 任何 | 检查方向是否标反 |
| D8 | 枢纽薄弱 | 介数中心性前 10% 的概念掌握度低 | m < 0.8 | 优先复习 |
| D9 | 弱链接 | 一个概念超过一半的边是「相关」 | > 50% | 升级为具体关系 |
| D10 | 褪色区 | 某个领域的平均 r 低 | < 0.7 | 全局图上标淡，安排邻域重建 |

**每周 3 个任务**：所有发现按影响打分，选前 3 个，同一诊断类型最多 1 个。每条都显示「为什么提示你」和用到的数据。你可以选「忽略这条」，它会被记成事件，之后不再提示。阈值都可以在设置里调。

### 3.3 关键算法

```
地基分（D4、D5、D7）
输入：概念集合；前置边 v → u 表示「懂 v 需要先懂 u」；掌握度 m
1. Tarjan 求强连通分量；大于 1 的分量报告 D7，并缩成一个点再算
2. 按拓扑序从最底层的前置开始：
     f(c) = min( m(c), min{ f(u) : u 是 c 的前置 } )
   同时记下取到最小值的那个前置，用于回溯根因
3. 下游数(u) = 反向前置图里从 u 出发能到达的概念数
```

规模估算：个人图谱几年内一般在 1,000–10,000 个概念、5 万条边以内。连通分量、拓扑序和 Tarjan 都是线性的；Louvain 接近 O(E log V)；介数中心性用固定种子抽样 200 个源点的 Brandes 算法。全部放在 Web Worker 里，每次训练结束后重算；目标是 1 万个概念时 1 秒以内，在 M5 实测验收。

## 4. 软件方案

### 4.1 形态与选型

**推荐：本地优先的 PWA 网页应用，和背单词网页用同一套技术栈。**

- React + TypeScript + Vite + Zod，可以安装到安卓主屏幕和电脑上，离线可用。
- 所有数据只存在本机浏览器（IndexedDB），不需要账号和服务器。程序可以放在 `concept.yanxai.com` 这类免费静态托管上，也可以只在本机 `npm run preview` 运行——托管的只是程序，不是你的数据。
- 手机负责：今日训练、捕获。电脑负责：地图、体检、整理。

不选其他方案的原因：

- Obsidian 插件：编辑器形态很难承载计时的闭卷重建、信心评分和比对界面。改为提供 Obsidian 兼容的 Markdown 导出，想用 Obsidian 阅读也可以。
- 纯桌面应用（Tauri / Electron）：每日训练主要在手机上发生；PWA 一份代码覆盖两端，也不需要开发者账号。

新增依赖（均为 MIT 许可，锁定版本）：

| 依赖 | 用途 | 引入时机 |
|---|---|---|
| `ts-fsrs` | FSRS 间隔复习调度（5.x 稳定版已实现 FSRS-6） | M2 |
| `@xyflow/react` | 局部概念图、邻域重建比对画布 | M3 |
| `graphology`、`graphology-communities-louvain`、`graphology-metrics` | 图算法 | M4 |
| `sigma` | 全局大图（WebGL） | M5 |

### 4.2 数据：事件日志是唯一事实来源

所有修改都写成只追加的事件，当前状态由事件重放得到。这样做有四个好处：

1. **多设备合并不冲突**：手机和电脑各自离线修改，合并就是两份事件取并集，再按混合逻辑时钟（HLC）排序重放，任何设备都得到同样的结果。导入备份是「合并」，不是「覆盖」。
2. **复习状态可以重算**：FSRS 卡片状态从复习日志重放得出；将来用自己的数据优化参数，只需重放一遍。
3. **撤销** = 追加一条反向事件。
4. **备份**就是一个 JSONL 文本文件。

```ts
type EventEnvelope = {
  id: string; // `${deviceId}:${seq}`, globally unique
  device: string; // random per-device id, only used for merging
  hlc: string; // hybrid logical clock for cross-device ordering
  at: number; // wall clock ms, display and per-day stats only
  type: EventType;
  payload: unknown; // validated with zod per type
};

type EventType =
  | 'concept.create' | 'concept.patch' | 'concept.merge' | 'concept.archive'
  | 'relation.create' | 'relation.patch' | 'relation.delete'
  | 'source.create'
  | 'capture.session' // brain dump / check: duration, recalled items, added/corrected items
  | 'review.log' // one answer: card, prompt variant, rating, confidence, answer text, duration
  | 'reconstruct.attempt' // center concept, recalled / missed / new
  | 'finding.dismiss'
  | 'bridge.dismiss' // answered "no substantive relation"
  | 'settings.patch';
```

合并规则：

- 按 `id` 去重取并集，按 `hlc` 排序（相同时比较 `device`）。
- 字段级「后写为准」；删除是墓碑，排在删除之后的修改无效。
- `concept.merge` 记录重定向：被合并概念的边全部改指向目标概念。
- `review.log` 只追加，永不冲突。

重放后的状态：

```ts
type Concept = {
  id: string;
  title: string;
  aliases: string[];
  definition: string; // one sentence, own words
  explanation: string; // Feynman explanation, Markdown, versioned
  examples: string[];
  sourceRefs: SourceRef[];
  status: 'stub' | 'active' | 'archived'; // stub = referenced but not yet defined
  tags: string[];
};

type Relation = {
  id: string;
  from: string;
  to: string;
  type: RelationType;
  label: string; // original linking phrase
  polarity?: '+' | '-'; // causes only
  why: string; // mechanism / justification
  certainty: 'established' | 'believed' | 'speculative';
  review: boolean;
  origin: 'recalled' | 'added_after_check' | 'corrected' | 'bridge' | 'edited';
  sourceRefs: SourceRef[];
};
```

### 4.3 关系类型（受控词表）

| 类型 | 中文 | 方向 | 句子模板 | 输入关键词 | 默认复习 | 用于 |
|---|---|---|---|---|---|---|
| `requires` | 前置 | A → B | 懂 A 需要先懂 B | 需要、依赖、前提、基于 | 是 | 地基分析 D4–D7 |
| `is_a` | 是一种 | A → B | A 是一种 B | 是一种、属于 | 是 | 层级、惰性 D3 |
| `part_of` | 组成 | A → B | A 是 B 的组成部分 | 组成、部分；「包含」反向 | 否 | 结构 |
| `causes` | 导致 | A → B | A 导致（促进 + / 抑制 −）B | 导致、引起、影响；促进、增加；抑制、降低 | 是 | 理解、因果链推演 |
| `explains` | 解释 | A → B | A 解释了 B | 解释、原理是 | 是 | 理解 |
| `example_of` | 例子 | A → B | A 是 B 的例子 | 例如、比如、实例 | 是 | 能不能用 |
| `applies_to` | 应用 | A → B | A 用于 B | 用于、应用于 | 是 | 能不能用 |
| `contrasts` | 对比 | 对称 | A 和 B 易混，区别是…… | 对比、区别于、不同于 | 是 | 辨析题 |
| `analogous` | 类比 | 对称 | A 类似 B，相似在…… | 类似、好比、像 | 是 | 迁移、桥接 |
| `conflicts` | 冲突 | 对称 | A 与 B 矛盾或有张力 | 矛盾、冲突、反驳 | 是 | 和反方练习衔接 |
| `related` | 相关 | 对称 | A 与 B 有关（待明确） | 相关 | 否 | 弱链接 D9 |

类型可以改，改动也是事件，复习历史保留。

### 4.4 捕获：文本优先，画布不用于输入

拖拽画图太慢，会把注意力从「回忆」转到「排版」。输入一律用一行一句的文本：

```
# 来源：《经济学原理》第 6 章
供需均衡：供给量等于需求量时的价格和数量
价格上限 -导致-> 短缺 // 价格低于均衡，需求量大于供给量
价格上限 -需要-> 供需均衡
沉没成本 -对比-> 机会成本 // 前者已经发生、收不回，不应影响决策
```

语法：

- `# 来源：…` 设置之后各行的来源；
- `概念：定义` 新建或更新概念（该行没有箭头）；
- `A -关系词-> B // 理由` 新建命题；关系词按上表映射到类型，原话保留为 `label`；不认识的关系词先记为「相关」并请你确认；
- 兼容全角和常见箭头写法：`—导致→`、`－导致－＞`、`／／`、`:`；
- 新出现的概念名先做规范化（NFKC、去空格和标点、小写），和已有概念及别名比较；很接近的提示「是不是已有的 X？」，避免重复；
- 命题里出现、但还没有定义的概念自动建为 `stub`。

手机上：同一个文本框，上方一排关系快捷键（前置、导致、是一种、例子、对比……），点一下插入 `-导致->`，不用切换输入法打符号。下方实时显示解析结果，每条渲染成完整的中文句子。

捕获分两个阶段：

1. **倾倒**：计时，界面提示「合上书」。这时写的行记为 `recalled`，并记一次 Good。
2. **对照**：新增的行自动记为 `added_after_check`，修改倾倒时写的行记为 `corrected`，都记一次 Again。
3. 结束时记录首测遗漏率 =（补 + 纠）/ 全部命题。

### 4.5 复习调度

- **卡片**：每条 `review = true` 的关系一张卡；写了解释的概念一张解释卡。关系卡的三种题面（正向、反向、问关系）按复习次数轮换，共用一个 FSRS 状态——它衡量的是这句命题本身，也避免卡片数量翻三倍。
- **FSRS**：用 `ts-fsrs`，默认目标保持率 0.9，最长间隔 365 天；先用默认参数，复习记录足够多以后再用自己的日志优化（后续里程碑）。
- **邻域重建合批**：组装每日训练时，如果一个概念有 ≥ 3 张到期的关系卡，就改出一道邻域重建。重建里每条边都记一次复习：对象和类型都对 → Good；对象对、类型错或说不出理由 → Hard；漏掉 → Again。提交前可以逐条改分。没到期但被想起的边也记录（FSRS 能处理提前复习）。
- **每日组装**（按时间预算填充；估计用时：关系卡 25 秒、解释 60 秒、重建 120 秒、桥接 90 秒）：
  1. 到期的邻域重建，最多 2 道；
  2. 到期关系卡，按「逾期程度 ×（1 + 下游数）」排序；
  3. 1 道辨析或桥接；
  4. 1 个本周修补任务；
  5. 让相邻两题来自不同领域，易混的一对放在一起；排序用以日期为种子的确定性洗牌。
- **新卡上限**：每天默认最多 20 条新关系进入复习，多出来的排队。
- **清欠模式**：积压超过 3 天的量时，按「越可能忘 ×（1 + 下游数）」处理。

### 4.6 邻域重建的比对

1. 你写出的每个邻居名先做规范化，和标题、别名精确匹配；匹配不上时，长度 ≥ 4 且编辑距离 ≤ 1 的提示「可能是 X」，由你确认；仍然匹配不上的列为「新想到的」，可以一键加入图里。
2. 匹配到的概念再比较关系类型和方向（对称类型不比较方向）。
3. 结果画布：想起（绿）、漏掉（红）、新增（蓝）、类型不对（黄）。

### 4.7 界面

| 页面 | 手机 | 电脑 | 内容 |
|---|---|---|---|
| 今日 | ✓ | ✓ | 开始训练（预计 N 分钟、到期 X 条）、本周 3 个任务、学习日历、快速捕获入口 |
| 捕获 | ✓ | ✓ | 倾倒 / 对照两阶段文本编辑、关系快捷键、实时句子预览 |
| 训练 | ✓ | ✓ | 作答 → 信心 → 揭晓（自己的命题、理由、来源）→ 评分；邻域重建画布 |
| 概念页 | ✓ | ✓ | 定义、我的解释（带版本）、「先要懂」、「它支撑了」、按类型分组的命题句子、例子、来源、掌握度曲线、诊断标签 |
| 地图 | 简版 | ✓ | 局部图：以概念为中心 1–2 跳，分层布局，前置在下、依赖它的在上；全局图：按领域着色，叠加地基漏洞（红）、孤岛（灰）、褪色（变淡） |
| 体检与统计 | ✓ | ✓ | 诊断报告和依据；第 2.5 节的指标趋势、校准曲线 |
| 数据 | ✓ | ✓ | 备份、导入合并、Markdown 导出、绑定文件夹、存储状态 |

### 4.8 代码结构

```
apps/concept/                     React PWA
  src/screens/                    today, capture, train, concept, map, checkup, data
  src/storage/                    IndexedDB event store, snapshot, folder backup
  src/workers/analysis.worker.ts  diagnostics off the main thread
packages/concept-core/            pure functions; no DOM or Node APIs; clock and seeds passed in
  events.ts                       event schemas (zod), replay, merge
  hlc.ts                          hybrid logical clock
  dsl.ts                          capture syntax parser
  relations.ts                    relation table, keyword mapping, sentence templates
  scheduler.ts                    wraps ts-fsrs: replay cards from logs, build daily session
  reconstruct.ts                  neighborhood reconstruction matching and grading
  diagnostics/                    components, communities, inert, foundations, centrality, ranking
  metrics.ts                      effectiveness metrics
  export/                         JSONL backup, Markdown export
```

沿用本仓库约定：TypeScript strict + `noUncheckedIndexedAccess`；外部输入一律用 zod 校验；`lint`、`typecheck`、`test`、`build` 全部通过；界面在手机和桌面尺寸实际检查。

### 4.9 存储、备份和多设备

- **IndexedDB**：`events`（只追加）+ `snapshot`（重放结果和最后的 HLC，用于快速启动）。启动时调用 `navigator.storage.persist()` 申请持久存储，并显示是否获批。
- **每次写入**都在 IndexedDB 事务确认后才推进界面；写入失败明确提示，不静默丢数据。
- **本机滚动快照**：保留最近 7 份。
- **绑定文件夹（桌面 Chrome / Edge）**：通过 File System Access API 选一个文件夹，每次训练后自动写入 `concept-net.jsonl` 和 Markdown 导出。这个文件夹可以放在你已经在用的同步盘里，从而实现跨设备，不需要新账号。
- **手机**：通过系统分享导出备份；导入时合并，先显示「将新增 N 条事件，涉及 M 个概念」，确认后再写。
- 超过 7 天没有外部备份时提醒。
- 容量估算：每天约 50 条复习记录，十年约 18 万条事件、几十 MB，在浏览器存储能力之内；启动时读快照，不全量重放。

Markdown 导出（每个概念一个文件，Obsidian 可以直接打开）：

```markdown
---
id: c_7f3a…
aliases: [OC]
status: active
---
# 机会成本

> 为了得到某样东西而放弃的最好替代选择的价值。

## 我的解释
……

## 关系
- 是一种:: [[成本]]
- 前置:: [[稀缺性]] — 资源有限才需要取舍
- 对比:: [[沉没成本]] — 沉没成本已经发生、收不回，不应影响决策
```

### 4.10 隐私

- 除了加载程序本身，不发任何网络请求；没有统计和分析脚本；数据不上传。
- 设备 ID 在本机随机生成，只用于合并事件，除非你自己导出备份，否则不离开设备。

### 4.11 可选：本地 AI 考官（默认关闭）

原则：**AI 只当考官和质检员，不当作者。**

- 只在电脑上，通过本机 Ollama 调用本地模型（需要设置 `OLLAMA_ORIGINS` 允许本应用的来源），数据不出本机。
- 可以做：对照你存的命题给作答提供打分建议（最终由你决定）；追问「这条因果的机制是什么？有没有反例？」；提示可能重复的概念。
- 不做：替你生成概念或关系，替你写解释。

### 4.12 以后可以扩展到另外三项思维技能

同一个内核可以承载：

- **论证地图**：节点类型换成主张、理由、证据、反驳，关系换成支持、反驳、前提；
- **反方练习**：给「相信」的命题挂一张「最强反驳」卡，和 `conflicts` 关系衔接；
- **估算训练**：信心与结果的校准模块已经在核心里，再加一个估算日志，跟踪数量级误差。

这些等概念网络稳定使用一段时间后再做。

## 5. 里程碑与验收

每个里程碑都要求 `lint`、`typecheck`、`test`、`build` 通过，并在手机和桌面尺寸实际检查界面。

| 里程碑 | 内容 | 验收标准 |
|---|---|---|
| M1 数据与捕获 | 事件 schema、HLC、重放、合并；文本语法；概念页；IndexedDB；JSONL 备份与导入合并 | 同一批事件以任意顺序、分多次合并，结果完全一致（随机顺序属性测试）；语法用例表全过（含全角、错误行、重复概念提示）；写入失败不推进界面；非法备份被拒绝且不改动现有数据 |
| M2 训练 | FSRS 关系卡和解释卡；作答、信心、评分；每日组装、交错、新卡上限、清欠；钉子户流程；撤销；学习日历 | 从日志一次重放和逐次增量计算得到相同的卡片状态；捕获时 recalled 记 Good、补 / 纠记 Again；时间预算和新卡上限生效；撤销恢复卡片状态 |
| M3 邻域重建 | 重建界面、匹配、比对画布、批量记复习 | 别名、全半角、空格差异能匹配；想起 / 漏掉 / 新增 / 类型不对分类正确；提交前可以改分 |
| M4 体检 | D1–D10、每周 3 个任务、依据说明、忽略 | 每项诊断都有构造图测试（例如「A 前置 B、B 前置 C、C 薄弱」时，A、B 判为空中楼阁并回溯到 C）；固定种子下 Louvain 结果稳定；选出的任务同类型不超过 1 个 |
| M5 地图与多设备 | 局部图、全局图和叠加层；Markdown 导出；绑定文件夹 | 1 万个概念、5 万条边时，体检在后台线程 1 秒内完成，局部图操作流畅；Markdown 在 Obsidian 中链接正确；两台设备的备份互相合并后状态一致 |
| M6 可选 | 本地 AI 考官；论证地图模式 | AI 关闭时零网络请求；AI 只给建议，评分以你为准 |

## 6. 风险和对策

| 风险 | 对策 |
|---|---|
| 维护太累，坚持不下去 | 文本输入；每天默认 15 分钟；每周只 3 个任务；允许「停止复习」 |
| 自己打分太宽松 | 必须先作答；记录信心；高信心错误单列；每月迁移测试；可选 AI 第二意见 |
| 关系类型选错 | 判断题提示；可以随时改；「相关」作为缓冲，体检提醒升级 |
| 桥接题硬凑出伪连接 | 允许「没有实质关系」；新桥接先标「推测」 |
| 诊断只是启发式 | 每条显示依据和数据；可以忽略；阈值可调 |
| 浏览器清除数据 | 申请持久存储；绑定文件夹自动备份；超过 7 天未备份时提醒 |

## 参考文献

- Karpicke, J. D., & Blunt, J. R. (2011). Retrieval practice produces more learning than elaborative studying with concept mapping. *Science*, 331(6018), 772–775.
- Blunt, J. R., & Karpicke, J. D. (2014). Learning with retrieval-based concept mapping. *Journal of Educational Psychology*, 106(3), 849–858.
- Schroeder, N. L., Nesbit, J. C., Anguiano, C. J., & Adesope, O. O. (2018). Studying and constructing concept maps: A meta-analysis. *Educational Psychology Review*, 30(2), 431–455.
- Nesbit, J. C., & Adesope, O. O. (2006). Learning with concept and knowledge maps: A meta-analysis. *Review of Educational Research*, 76(3), 413–448.
- Dunlosky, J., Rawson, K. A., Marsh, E. J., Nathan, M. J., & Willingham, D. T. (2013). Improving students' learning with effective learning techniques. *Psychological Science in the Public Interest*, 14(1), 4–58.
- Novak, J. D., & Cañas, A. J. (2008). The theory underlying concept maps and how to construct and use them. IHMC CmapTools Technical Report 2006-01 Rev 01-2008.
- Butterfield, B., & Metcalfe, J. (2001). Errors committed with high confidence are hypercorrected. *Journal of Experimental Psychology: Learning, Memory, and Cognition*, 27(6), 1491–1494.
- Chi, M. T. H., Bassok, M., Lewis, M. W., Reimann, P., & Glaser, R. (1989). Self-explanations: How students study and use examples in learning to solve problems. *Cognitive Science*, 13(2), 145–182.
- Kang, S. H. K., & Pashler, H. (2012). Learning painting styles: Spacing is advantageous when it promotes discriminative contrast. *Applied Cognitive Psychology*, 26(1), 97–103.
- Gick, M. L., & Holyoak, K. J. (1983). Schema induction and analogical transfer. *Cognitive Psychology*, 15(1), 1–38.
- Doignon, J.-P., & Falmagne, J.-C. (1985). Spaces for the assessment of knowledge. *International Journal of Man-Machine Studies*, 23(2), 175–196.
- Guimerà, R., & Amaral, L. A. N. (2005). Functional cartography of complex metabolic networks. *Nature*, 433, 895–900.（参与系数）
- Brandes, U. (2001). A faster algorithm for betweenness centrality. *Journal of Mathematical Sociology*, 25(2), 163–177.
- Blondel, V. D., Guillaume, J.-L., Lambiotte, R., & Lefebvre, E. (2008). Fast unfolding of communities in large networks. *Journal of Statistical Mechanics*, P10008.
