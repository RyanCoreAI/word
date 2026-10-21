# 03 · 词典数据

本文所有数字都已经用锁定版本的真实数据跑过一遍；数据管线（`tools/pipeline`）的测试必须得到**完全相同**的数字。

## 1. 数据来源（锁定版本）

| 来源 | 用途 | 许可 | 锁定版本 | 文件 | SHA-256 |
|---|---|---|---|---|---|
| ECDICT（github.com/skywind3000/ECDICT） | 整本词典：中文释义、标签、词频、变形、英式音标 | MIT | commit `bc015ed2e24a7abef49fc6dbbb7fe32c1dadaf8b` | `ecdict.csv`（65,933,428 字节，770,611 行） | `1a6947e04785db63613a92e14903cdae7954f7e84860b10e68e5c7cbb3f9c3cf` |
| CMUdict（github.com/cmusphinx/cmudict） | 美式音标 | BSD 2-Clause 风格 | commit `74790861f652b15e4ac49015a90074ad62a27690` | `cmudict.dict`（135,166 行） | `81917843c7f44ce2b094ac63873c2c7a4cf802040792c455ba3ca406891c3d22` |

下载地址格式：`https://raw.githubusercontent.com/<owner>/<repo>/<commit>/<file>`。

- `tools/pipeline/src/fetch.ts`：下载到 `data/raw/`（加入 `.gitignore`，**原始数据不进仓库**），校验 SHA-256，不一致就报错退出。
- 许可文本复制到 `apps/mobile/assets/licenses/` 和官网 `/licenses`。

## 2. ECDICT CSV 格式要点

- 列：`word,phonetic,definition,translation,pos,collins,oxford,tag,bnc,frq,exchange,detail,audio`。
- 标准 CSV（字段可能带引号、含逗号）。用成熟的 CSV 解析库（如 `csv-parse`），不要自己按逗号切。
- `translation` 和 `definition` 里的换行是**两个字符 `\` + `n`**（52,999 行有），没有真正的换行符。
- `word` 在忽略大小写后也是唯一的（已验证：0 个重复）。
- `tag`：空格分隔，取值 `zk`（中考）`gk`（高考）`cet4` `cet6` `ky`（考研）`toefl` `ielts` `gre`。
- `frq`：当代语料库词频排名，`bnc`：英国国家语料库词频排名；`0` 或空表示没有排名。
- `exchange`：`/` 分隔的 `类型:词`，其中 `0:` 是原形（lemma），`1:` 是本词相对原形的变形类型（p 过去式、d 过去分词、i 现在分词、3 三单、s 复数、r 比较级、t 最高级）。例：`abandoned` 的 exchange 含 `0:abandon/1:dp`。

## 3. 导入服务器：整本入库

`pnpm pipeline import` 把全部 770,611 行写入 PostgreSQL 的 `dict_entry` 表（表结构见 `05-architecture.md` 第 4.1 节），用 `COPY` 批量写入，预计 1 分钟内完成。每一行都写，同时算好下面第 4–6 节的派生字段。可以重复执行：先写临时表，完成后在一个事务里替换正式表。

## 4. 派生字段与过滤规则

按顺序计算：

| 字段 | 规则 |
|---|---|
| `is_single_word` | `word` 匹配正则 `^[a-z]+(?:-[a-z]+)*$`（全小写字母，允许中间有连字符；排除大写开头的专有名词、空格词组、带撇号或数字的词） |
| `has_translation` | `translation` 去掉空白后非空 |
| `tags` | `tag` 按空格拆成数组，只保留上面 8 个合法值 |
| `lemma` | `exchange` 里 `0:` 后面的词，没有就是 null |
| `is_inflection` | `lemma` 不为空，且 `lemma != word`，且 `lemma` 本身是一个 `is_single_word && has_translation` 的词条 |
| `is_basic` | `'zk' ∈ tags`，**或** `1 ≤ frq ≤ 2000`，**或** `word ∈ BASIC_STOPLIST` |
| `is_hf`（高频补充） | `tags` 不含任何考试标签，且不是变形，且 `2000 < frq ≤ 20000` |
| `in_pack`（进入 App 词包） | `is_single_word && has_translation && !is_inflection && (tags 非空 || is_hf)` |

`BASIC_STOPLIST`（兜底名单，防止个别功能词没有词频或标签）：

```
a an the be is am are was were been being have has had do does did
i you he she it we they me him her us them my your his its our their
this that these those of to in on at for with by from as and or but not no yes
```

### 4.1 校验数字（管线测试必须断言）

| 项 | 数量 |
|---|---|
| 全部词条 | 770,611 |
| 单个小写词且有中文释义 | 364,019 |
| 其中带任一考试标签 | 14,781 |
| 其中是变形（如 abandoned、accidents） | 929 |
| 带考试标签、非变形 | 13,852 |
| 其中属于基础词 | 2,191 |
| 高频补充（hf） | 5,242 |
| **词包总数**（13,852 + 5,242） | **19,094** |
| **默认词库**（cet4 cet6 ky toefl ielts gre，过滤基础词） | **11,481** |
| 默认词库，不过滤基础词 | 13,182 |
| 7 个考试标签全选（含高考），过滤基础词 | 11,661 |

各标签过滤基础词之后的数量（P1 选词库页面显示的数字）：

| 高考 gk | 四级 cet4 | 六级 cet6 | 考研 ky | 托福 toefl | 雅思 ielts | GRE gre | 高频补充 hf |
|---|---|---|---|---|---|---|---|
| 1,567 | 2,469 | 4,176 | 3,472 | 5,928 | 3,542 | 7,042 | 5,242 |

不过滤时：高考 3,484，四级 3,746，六级 5,268，考研 4,712，托福 6,661，雅思 4,549，GRE 7,251。中考（zk）1,534 个词全部属于基础词，所以不作为可选词库。

抽查（管线测试也要断言）：

| 词 | tags | frq | 基础词 | 变形 |
|---|---|---|---|---|
| the | zk gk | 1 | 是 | 否 |
| have | zk gk | 8 | 是 | 否 |
| good | zk gk ielts | 110 | 是 | 否 |
| is | （无） | 0 | 是（名单） | 是（原形 be） |
| abandon | gk cet4 cet6 ky toefl gre | 2182 | 否 | 否 |
| elaborate | cet4 cet6 ky toefl ielts gre | 4630 | 否 | 否 |
| meticulous | toefl ielts gre | 11107 | 否 | 否 |
| abandoned | 有标签 | — | — | 是（原形 abandon） |

## 5. 音标

ECDICT 的 `phonetic` 是旧式写法（`i'læbәreit`：用西里尔字母 `ә`，`i` 不区分长短，`'` 表示重音），不能直接显示。处理成两个字段：`uk`（英式，由 ECDICT 转换）和 `us`（美式，由 CMUdict 生成）。存储时**不带斜杠**，显示时再加 `/…/`。

### 5.1 英式：ECDICT → 现代 IPA

1. 去掉首尾空白；空串就是 null。
2. 从左到右扫描，**先尝试匹配多字符序列**（按下表顺序，命中就替换并跳过对应长度）：

   | 原 | 新 | 原 | 新 | 原 | 新 |
   |---|---|---|---|---|---|
   | `ɒ:` | `ɔː` | `i:` | `iː` | `u:` | `uː` |
   | `ә:` | `ɜː` | `ə:` | `ɜː` | `ɑ:` | `ɑː` |
   | `ɔ:` | `ɔː` | `a:` | `ɑː` | `ei` | `eɪ` |
   | `ai` | `aɪ` | `ɔi` | `ɔɪ` | `au` | `aʊ` |
   | `әu` | `əʊ` | `əu` | `əʊ` | `iә` | `ɪə` |
   | `iə` | `ɪə` | `єә` | `eə` | `εә` | `eə` |
   | `єə` | `eə` | `uә` | `ʊə` | `uə` | `ʊə` |

3. 没有匹配到多字符序列时，单字符替换：`i→ɪ`、`u→ʊ`、`ә→ə`、`є→e`、`ε→e`、`'→ˈ`、`,→ˌ`、`:→ː`、`g→ɡ`；其他字符原样保留。
4. 如果原串以 `i` 结尾、结果以 `ɪ` 结尾，把最后的 `ɪ` 换回 `i`（happy 的末尾元音）。
5. 结果里只要有字符不在允许集合 `abdefhijklmnoprstuvwxzæðŋɑɒɔəɛɜɪʃʊʌʒθˈˌːɡ` 里（比如原数据里偶尔出现的 `^`、`\`、`(`、`;`、`?`、`@`），整个字段设为 null。

### 5.2 美式：CMUdict → IPA

1. 读 `cmudict.dict`：每行 `词 音素…`，`#` 之后是注释要去掉；跳过 `词(2)` 这类变体，只用第一个读音。
2. 音素映射（数字是重音：0 无、1 主、2 次）：

   | 元音 | 重读（1/2） | 非重读（0） | 辅音 | IPA | 辅音 | IPA |
   |---|---|---|---|---|---|---|
   | AA | ɑː | ɑː | B | b | N | n |
   | AE | æ | æ | CH | tʃ | NG | ŋ |
   | AH | ʌ | ə | D | d | P | p |
   | AO | ɔː | ɔː | DH | ð | R | r |
   | AW | aʊ | aʊ | F | f | S | s |
   | AY | aɪ | aɪ | G | ɡ | SH | ʃ |
   | EH | e | e | HH | h | T | t |
   | ER | ɜːr | ər | JH | dʒ | TH | θ |
   | EY | eɪ | eɪ | K | k | V | v |
   | IH | ɪ | ɪ | L | l | W | w |
   | IY | iː | i | M | m | Y | j |
   | OW | oʊ | oʊ | | | Z | z |
   | OY | ɔɪ | ɔɪ | | | ZH | ʒ |
   | UH | ʊ | ʊ | | | | |
   | UW | uː | u | | | | |

3. **只标主重音**（1），不标次重音（2）。主重音符号 `ˈ` 放在该音节的**声母（onset）**前：取主重音元音前面、上一个元音之后的辅音串，从中找出**最长的、属于合法声母表的后缀**，`ˈ` 放在这个后缀前面。合法声母表（ARPAbet 拼接后的小写形式）：
   ```
   p b t d k g f v th dh s z sh zh h ch jh m n l r w y
   pl bl kl gl pr br tr dr kr gr fl fr thr shr sl sm sn sp st sk sw tw dw kw gw thw
   py by ky gy my ny fy vy hy ly sky spy spl spr str skr skw sf
   ```
4. 只有一个元音的单音节词不加重音符号。

### 5.3 测试向量（必须逐个断言）

| 词 | ECDICT 原文 | uk | CMUdict | us |
|---|---|---|---|---|
| happy | `'hæpi` | `ˈhæpi` | HH AE1 P IY0 | `ˈhæpi` |
| city | `'siti` | `ˈsɪti` | S IH1 T IY0 | `ˈsɪti` |
| elaborate | `i'læbәreit` | `ɪˈlæbəreɪt` | IH0 L AE1 B R AH0 T | `ɪˈlæbrət` |
| meticulous | `mә'tikjulәs` | `məˈtɪkjʊləs` | M AH0 T IH1 K Y AH0 L AH0 S | `məˈtɪkjələs` |
| scrutiny | `'skru:tini` | `ˈskruːtɪni` | S K R UW1 T AH0 N IY0 | `ˈskruːtəni` |
| ubiquitous | `ju:'bikwitәs` | `juːˈbɪkwɪtəs` | Y UW0 B IH1 K W IH0 T AH0 S | `juˈbɪkwɪtəs` |
| plausible | `'plɒ:zibl` | `ˈplɔːzɪbl` | P L AO1 Z AH0 B AH0 L | `ˈplɔːzəbəl` |
| contemplate | `'kɒntempleit` | `ˈkɒntempleɪt` | K AA1 N T AH0 M P L EY2 T | `ˈkɑːntəmpleɪt` |
| resilient | `ri'ziliәnt` | `rɪˈzɪlɪənt` | R IH0 Z IH1 L Y AH0 N T | `rɪˈzɪljənt` |
| deteriorate | `di'tiәriәreit` | `dɪˈtɪərɪəreɪt` | D IH0 T IH1 R IY0 ER0 EY2 T | `dɪˈtɪriəreɪt` |
| abandon | `ә'bændәn` | `əˈbændən` | AH0 B AE1 N D AH0 N | `əˈbændən` |
| compel | `kәm'pel` | `kəmˈpel` | K AH0 M P EH1 L | `kəmˈpel` |
| ambiguous | `æm'bigjuәs` | `æmˈbɪɡjʊəs` | AE0 M B IH1 G Y UW0 AH0 S | `æmˈbɪɡjuəs` |
| strength | `streŋθ` | `streŋθ` | S T R EH1 NG K TH | `streŋkθ` |
| explain | `ik'splein` | `ɪkˈspleɪn` | IH0 K S P L EY1 N | `ɪkˈspleɪn` |
| extra | `'ekstrә` | `ˈekstrə` | EH1 K S T R AH0 | `ˈekstrə` |

覆盖率（14,781 个带标签的词）：uk 有效 12,766，us 有效 13,658，两个都没有 255。默认词库 11,481 个词里有 239 个两种音标都没有。

### 5.4 显示规则

- 设置为美音：优先显示 `us`，标签「美」；没有就显示 `uk`，标签改为「英」。
- 设置为英音：优先显示 `uk`，标签「英」；没有就显示 `us`，标签「美」。
- 两个都没有：不显示音标文字，只显示喇叭按钮。
- 标签表示的是**音标**的口音；播放的音频始终跟随设置的口音（`04-audio.md`）。

## 6. 中文释义解析

输入是 `translation` 字段，输出两个 JSON：`meanings`（学习卡片用）和 `extra`（详情页用）。

1. 按两个字符 `\n` 拆成多行，去掉首尾空白，丢弃空行。
2. 逐行判断：
   - 匹配 `^\[([^\]]+)\]\s*(.*)$` → 领域行，进 `extra`：`{ domain: "医", senses: [...] }`。领域名原样保留（网络、医、法、计、化、经、机、电、建、古、生态…）。
   - 匹配 `^([a-z]+)\.\s*(.*)$`，且第一组在词性映射表里 → 词性行，进 `meanings`：`{ pos: "adj.", senses: [...] }`。
   - 其他 → 无词性行，进 `meanings`：`{ pos: null, senses: [...] }`。
3. 词性映射：`n→n.`，`v→v.`，`vt→vt.`，`vi→vi.`，`a→adj.`，`adj→adj.`，`ad→adv.`，`adv→adv.`，`prep→prep.`，`conj→conj.`，`pron→pron.`，`num→num.`，`art→art.`，`int→int.`，`interj→int.`，`aux→aux.`，`abbr→abbr.`，`pl→pl.`，`pref→pref.`，`suf→suf.`，`det→det.`。
4. 拆义项：在**括号外**（括号指 `( ) （ ） [ ]`）的 `,` `;` `，` `；` 处切开；每段去掉空白；半角括号转全角；去掉空段和重复段，保留原顺序。
5. 显示时义项之间用「；」连接。

结果示例（管线测试要断言）：

```json
abandon:    [{"pos":"vt.","senses":["放弃","抛弃","遗弃","使屈从","沉溺","放纵"]},{"pos":"n.","senses":["放任","无拘束","狂热"]}]
elaborate:  [{"pos":"adj.","senses":["精细的","详尽的","精心计划（或制作）的"]},{"pos":"vt.","senses":["详细地说明","用心地制作","发挥"]},{"pos":"vi.","senses":["变复杂","作详细说明"]}]
scrutiny:   [{"pos":"n.","senses":["细看","仔细检查","监视","选票检查"]}]   extra: [{"domain":"经","senses":["复查","评核","仔细检查"]}]
affordable: []   extra: [{"domain":"计","senses":["普及型"]}]
booklist:   [{"pos":null,"senses":["（某个题目或学科的）推荐书目","书单"]}]
```

卡片显示规则见 `01-product.md` 的 P3。默认词库里：47 个词没有任何 `meanings` 行（只能显示领域行），7,878 个词 1 行，2,399 个 2 行，1,025 个 3 行，114 个 4 行，18 个 5 行（卡片最多显示 4 行）。

## 7. 词频排序 `rank`

在词包内统一排名：按 `frq`（0 视为无穷大）升序，再按 `bnc`（0 视为无穷大）升序，再按单词字母序。`rank` 从 1 开始连续编号。默认词库按 rank 的前 12 个词：invest, cable, towards, expose, rural, narrow, cream, unfortunately, legislation, achievement, accuse, reject（管线测试断言）。

## 8. 词包（App 内置）

### 8.1 文件

`tools/pipeline` 的 `pack` 命令从 `dict_entry`（或直接从原始文件）生成 `pack-v{N}.db`（SQLite）：

```sql
CREATE TABLE word (
  word     TEXT PRIMARY KEY,      -- 单词原文
  us       TEXT,                  -- 美式 IPA，不带斜杠，可为 NULL
  uk       TEXT,                  -- 英式 IPA，不带斜杠，可为 NULL
  meanings TEXT NOT NULL,         -- JSON，见第 6 节，可能是 "[]"
  extra    TEXT,                  -- JSON 或 NULL
  tags     INTEGER NOT NULL,      -- 位掩码，见 8.2
  basic    INTEGER NOT NULL,      -- 1 = 基础词
  rank     INTEGER NOT NULL,      -- 第 7 节
  audio    INTEGER NOT NULL DEFAULT 0   -- 位掩码：1 = 有美音文件，2 = 有英音文件（音频生成后回填）
);
CREATE INDEX word_rank ON word(rank);
CREATE TABLE meta (k TEXT PRIMARY KEY, v TEXT NOT NULL);
-- meta: pack_version, built_at, ecdict_commit, cmudict_commit, audio_version, word_count
```

实测大小：约 3.3 MB，gzip 后约 1.4 MB。

### 8.2 标签位掩码

| gk | cet4 | cet6 | ky | toefl | ielts | gre | hf | zk |
|---|---|---|---|---|---|---|---|---|
| 1 | 2 | 4 | 8 | 16 | 32 | 64 | 128 | 256 |

例：abandon = gk+cet4+cet6+ky+toefl+gre = 95；elaborate = 126；scrutiny = 60。默认词库掩码 = 2+4+8+16+32+64 = 126。

### 8.3 分发与更新

- 第一个版本的词包直接打进 App 安装包（`apps/mobile/assets/pack/pack-v1.db`），首次启动导入本地数据库（`07-mobile-app.md` 第 3 节）。
- 后续更新：App 启动时调用 `GET /v1/pack/manifest`，版本更新就从 `https://cdn.yanxai.com/packs/pack-v{N}.db.gz` 下载，校验 SHA-256 后在事务里替换 `word` 表。用户进度以单词原文为键，所以换词包不影响进度；新词包里删掉的词，进度记录保留，但不再出现在学习里。
- 词包、音频、App 三者通过 `meta.audio_version` 对应。
