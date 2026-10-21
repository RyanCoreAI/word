# 07 · App 实现细则

## 1. 工程配置（`apps/mobile/app.config.ts`）

| 项 | 值 |
|---|---|
| 名称 | `APP_NAME`（暂定「背单词」，见 README） |
| `slug` | `word` |
| `scheme` | `yanxaiword` |
| `version` | `1.0.0`（语义化版本）；构建号交给 EAS 自动递增（`eas.json` 里 `appVersionSource: "remote"`，`autoIncrement: true`） |
| 方向 | `portrait` |
| 外观 | `userInterfaceStyle: "light"`（v1 不做深色模式） |
| iOS | `bundleIdentifier: "com.yanxai.word"`，`supportsTablet: false`，`config.usesNonExemptEncryption: false`（只用 HTTPS，属于豁免加密） |
| 安卓 | `package: "com.yanxai.word"`，自适应图标（前景白色「词」+ 绿点，背景 #3B4FD8） |
| 安卓权限 | 最终合并后的 AndroidManifest **只允许**：`INTERNET`、`ACCESS_NETWORK_STATE`、`VIBRATE`。用 `android.blockedPermissions` 屏蔽 `RECORD_AUDIO`、`READ_EXTERNAL_STORAGE`、`WRITE_EXTERNAL_STORAGE`、`SYSTEM_ALERT_WINDOW`、`READ_PHONE_STATE` 等；`expo-audio` 插件配置为不申请麦克风。`npx expo prebuild` 后检查清单，写进 CI |
| iOS 隐私清单 | `ios.privacyManifests`：`NSPrivacyTracking: false`；补齐所用 API 的原因代码（如 UserDefaults `CA92.1`、文件时间戳 `C617.1`、磁盘空间 `E174.1`、开机时间 `35F9.1`，以构建时 Xcode/App Store Connect 的检查为准） |
| OTA 更新 | `expo-updates`，`runtimeVersion: { policy: "appVersion" }`；只用来推送 JS 修复，不改变 App 功能 |
| `extra` | `apiBaseUrl`、`cdnBaseUrl`、`eas.projectId`，按构建配置注入 |
| 启动图 | 背景 #3B4FD8，中间白色「词」图标 |

最低系统版本跟随所用 Expo SDK 的默认值，写进官网下载页。

## 2. 路由（expo-router）

```
app/
├── _layout.tsx            # 字体、数据库、Provider；同意隐私和完成引导的门控
├── consent.tsx            # P0
├── onboarding.tsx         # P1
├── (tabs)/
│   ├── _layout.tsx        # 底部标签栏：学习 / 生词本 / 设置
│   ├── index.tsx          # P2 首页
│   ├── wordbook.tsx       # P6
│   └── settings.tsx       # P8（学习页右上角也以模态方式打开同一个组件）
├── study/[groupId].tsx    # P3 / P4（根据组的 mode 决定）
├── summary/[groupId].tsx  # P5
├── word/[word].tsx        # P7（底部弹层）
├── account/index.tsx      # P9
├── account/bind-email.tsx # P10
└── licenses.tsx           # 开源许可
```

- 学习页、小结页隐藏底部标签栏。
- 学习页禁用 iOS 的边缘右滑返回（防止误触）；安卓的返回键等于点左上角返回。

## 3. 启动流程

1. 显示启动图；加载字体；打开 `app.db`；执行未执行的迁移。
2. **词包导入**：如果 `kv.pack_version` 小于安装包内置词包的版本：
   1. 把 `assets/pack/pack-v1.db` 复制到文档目录；
   2. `ATTACH DATABASE '<路径>' AS pack`；
   3. 一个事务：`DELETE FROM word; INSERT INTO word (...) SELECT ..., ((rank * 2654435761 + :seed) % 4294967296) FROM pack.word;`；
   4. `DETACH`，删除复制的文件，更新 `kv.pack_version`。
   - 目标：19,094 行在 3 秒内导入完（中端安卓）。导入期间保持启动图。
   - 如果当前 `expo-sqlite` 版本不支持 ATTACH：改用第二个数据库连接读词包，每 500 行一条 INSERT 批量写入。
   - `settings.randomSeed` 变化时（只会在账号合并、同步到别的设备的设置时发生），执行 `UPDATE word SET rand_key = ((rank * 2654435761 + :seed) % 4294967296)`。
3. `consent_version < PRIVACY_VERSION` → P0；`onboarding_done` 不存在 → P1；否则进首页。
4. 首页显示后，在后台：注册匿名账号（如还没有）→ 同步 → 每天最多检查一次词包更新。网络失败不影响使用。

## 4. 学习页（最关键，验收重点是「丝滑」）

### 4.1 数据

- 进入学习页时，一次性读出本组全部词的数据（单词、音标、释义、标签、当前 WordState），放在内存里。**学习过程中不读数据库**。
- 每次作答：先更新内存和界面，再把写库任务（一个事务）放进串行队列异步执行。写库失败要重试；连续失败时在顶部显示「保存失败，正在重试」，但不阻塞学习。
- 状态机（`src/study/machine.ts`）：

```
loading → ready(A) ──KNOWN──> transition ──> ready(A, 下一个)
                   └─UNKNOWN─> revealed(B) ──NEXT──> transition ──> ready(A, 下一个)
任一状态 ──UNDO──> 回到上一个词的 ready(A)
最后一个词作答完 → finished → 跳到小结
```

### 4.2 卡片槽位

- 舞台里**一直挂着两个卡片槽位**（Reanimated `Animated.View`，绝对定位）：前台槽显示当前词，后台槽提前渲染好**下一个词**（透明度 0）。
- 切换时只跑动画，不新建组件；动画结束后，旧前台槽变成后台槽，再把「下下个词」的内容填进去。React 重新渲染只发生在动画结束以后，不和动画抢资源。
- 卡片组件用 `React.memo`，属性只传当前词的不可变数据。
- 进度条、计数这些小组件单独订阅状态，作答时只有它们重新渲染。

### 4.3 动画参数

动画都用 Reanimated 在 UI 线程执行。曲线 `Easing.out(Easing.cubic)`。W 为屏幕宽度。

| 动作 | 动画 |
|---|---|
| 认识 / 下一个 | 旧卡：translateX 0 → −1.1W，rotate 0 → −6°，opacity 1 → 0，200 ms。新卡同时开始：translateX 24 → 0，scale 0.97 → 1，opacity 0 → 1，220 ms |
| 不认识（看词） | 遮罩 opacity 1 → 0，120 ms；释义 opacity 0 → 1，150 ms（延迟 30 ms）；`不认识 ×N` 标签 scale 1 → 1.08 → 1（弹簧，约 200 ms）；底部按钮交叉淡入淡出 150 ms。卡片和区域**高度不变** |
| 不认识（听音） | 播放区 opacity 1 → 0，120 ms；单词区和释义淡入 180 ms |
| 撤销 | 上一张卡从左侧回到原位：translateX −1.1W → 0，rotate −6° → 0，opacity 0 → 1，220 ms；当前卡 opacity 1 → 0、translateX 0 → 24 |
| 顶部「✓ 认识 · 撤销」小条 | 进入：translateY −8 → 0 + 淡入，120 ms；停留 1,200 ms；淡出 200 ms |
| 朗读光晕、声波 | 循环动画，只在播放时运行 |
| 系统开启「减弱动态效果」 | 所有滑动改为 120 ms 淡入淡出 |

- **输入锁**：切换动画开始后 150 ms 内忽略新的点按（避免连点跳过词）；150 ms 以后新卡片已经基本到位，可以作答。
- 振动：认识 `Haptics.impactAsync(Light)`，不认识 `Haptics.impactAsync(Medium)`；设置里关了就不振。

### 4.4 音频

见 `04-audio.md` 第 4 节。新卡片进场的同一帧调用播放。

### 4.5 用时统计

学习页在前台且 App 处于 active 时累计 `activeMs`；进入后台、离开页面时暂停并写库。

### 4.6 性能指标（验收标准）

参考机型：iPhone 11（或所用 SDK 支持的最老型号）、一台 2021 年前后的中端安卓机（如红米 Note 10/11 系列）、一台安卓 8/9 的低端机（只做冒烟测试）。

| 指标 | 目标 |
|---|---|
| 点按到动画第一帧 | ≤ 16 ms |
| 切换动画 | 稳定 60 fps；中端安卓不超过 2 帧超过 32 ms |
| 进场到出声（已缓存） | ≤ 120 ms（P95） |
| 出一组（buildGroup + 读数据） | ≤ 100 ms |
| 冷启动到首页可点 | 中端安卓 ≤ 2.0 s；iPhone ≤ 1.2 s（首次启动导入词包除外） |
| 首次启动导入词包 | ≤ 3 s |
| 生词本 2,000 行滚动 | 60 fps |
| 内存 | ≤ 200 MB |
| 安装包 | iOS ≤ 40 MB，安卓 APK ≤ 40 MB |

用 React Native 性能监视器和安卓 Flashlight（或 Android Studio Profiler）测量，结果写进 M10 的 PR。

## 5. 设计规范（来自原型 `design/mockups-src/src/ui.css`）

### 5.1 颜色

| token | 值 | 用途 |
|---|---|---|
| `screen` | #F8F7F4 | 页面背景 |
| `card` | #FFFFFF | 卡片、面板 |
| `ink` | #1B1D22 | 主要文字、深色按钮 |
| `ink2` | #5B5F68 | 次要文字 |
| `ink3` | #9A9EA6 | 辅助文字、占位 |
| `line` | #E6E3DC | 边框、分隔线 |
| `line2` | #F0EEE9 | 浅色底、灰标签 |
| `accent` | #3B4FD8 | 品牌色、主按钮、播放 |
| `accentSoft` | #EBEEFD | 浅蓝底 |
| `accentInk` | #2C3BB0 | 蓝色文字 |
| `good` | #128761 | 认识、已掌握 |
| `goodSoft` | #E0F2EA | |
| `bad` | #D5452E | 不认识、危险操作 |
| `badSoft` | #FCEAE5 | |
| `review` | #B26F12 | 复习、学习中 |
| `reviewSoft` | #FAEFD9 | |

### 5.2 字体与字号

| 用途 | 字体 | 字号 / 粗细 |
|---|---|---|
| 学习卡单词 | Source Serif 4 | 50 / 600（自动缩小，最小 32） |
| 详情单词 | Source Serif 4 | 40 / 600 |
| 列表单词 | Source Serif 4 | 18 / 600 |
| 音标 | Inter（缺字时回退系统字体） | 18 / 400（学习卡），15.5（详情） |
| 释义 | 系统中文字体 | 16.5 / 400，行高 1.5 |
| 词性标签 | Inter 斜体 | 13 / 650 |
| 页面大标题 | 系统字体 | 28 / 750 |
| 顶部栏标题 | 系统字体 | 16 / 650 |
| 主按钮 | 系统字体 | 18 / 650 |
| 正文 | 系统字体 | 15 |
| 说明、提示 | 系统字体 | 12–13 |

中文用系统字体（iOS 苹方，安卓思源黑体或厂商字体），**不要把中文字体打进安装包**。启动后用测试页检查音标字符 `ˈ ː ə ɪ ʊ ʌ æ ɒ ɔ ɜ θ ð ʃ ʒ ŋ ɡ` 在两个平台上都能正常显示。

### 5.3 圆角、间距、阴影

- 圆角：学习卡 28；面板 22；主按钮 20；遮罩和释义框 20；数字块 18；底部弹层顶部 28；标签 999（全圆）；词性标签 7。
- 页面左右边距 18–20；卡片内边距 22–24；同组元素间距 12–14。
- 卡片阴影：`boxShadow: '0 1px 2px rgba(20,20,30,0.04), 0 10px 30px -12px rgba(20,20,30,0.12)'`（新架构支持 `boxShadow` 样式；不支持时 iOS 用 shadow 属性，安卓用 `elevation: 3`）。
- 最小点按区域 44 × 44。

### 5.4 组件清单

`Screen`、`TopBar`、`SegmentProgress`、`Chip`（default / review / bad / good / accent）、`PosTag`、`Meaning`、`Mask`、`SpeakerButton`、`Wave`、`BigPlayButton`、`ActionButton`（bad / good / dark / ghost / primary）、`Toast`、`Panel`、`Ring`、`StatTile`、`WordRow`、`SettingRow`、`Toggle`、`MiniSegment`、`ScopeCard`、`BottomSheet`、`CodeInput`。全部放在 `src/ui/`，做一个只在开发版里出现的组件展示页（`/dev/gallery`），方便对照原型检查。

## 6. 无障碍

- 所有按钮有 `accessibilityLabel`（例如「认识」「不认识」「播放发音」「再听一遍」）。
- 看词模式：卡片朗读顺序为「单词、音标」；听音模式下，屏幕阅读器**不读出单词**（避免剧透），只读「已播放发音，请判断是否认识」。
- 支持系统字号放大，学习卡和按钮 `maxFontSizeMultiplier = 1.3`，其他页面 1.6。
- 颜色之外都有图标或文字区分（✓ / ✕），不只靠红绿色。

## 7. 错误与边界情况

| 情况 | 处理 |
|---|---|
| 没网 | 完全可用；同步状态显示「离线」；需要联网的操作（绑定、注销）给出提示 |
| 词包损坏或缺失 | 从安装包重新导入 |
| 数据库写入失败 | 串行队列重试；仍失败时提示，并上报错误（如已接入 Sentry） |
| 学习中被来电打断、切到后台 | 停止播放；回来后停在同一个词、同一个状态（A 或 B） |
| 学习中被系统杀掉 | 重新打开后首页出现「继续」，进入后停在下一个未作答的词 |
| 两台设备同时进行同一个组 | 不支持也不阻止；同步后以 cursor 更大的为准 |
| 设备时间不准 | 不影响规则（规则只按组序号判断到期）；只影响「今天」统计 |

## 8. 测试

- `packages/core`：100% 覆盖 `02-learning-rules.md` 第 9 节的全部用例。
- App 逻辑：学习状态机、出组查询、撤销、同步合并都写单元测试（jest-expo，SQLite 用内存库或 mock）。
- 组件：首页、学习页 A/B 状态、小结的快照和交互测试。
- 端到端（Maestro，`apps/mobile/e2e/`）：
  1. 首次打开 → 同意 → 选词库 → 首页；
  2. 看词记忆完整做一组（混合认识/不认识/撤销）→ 小结数字正确；
  3. 中途杀掉 App → 重新打开 → 继续在同一个词；
  4. 听音辨词：不认识后显示拼写；
  5. 生词本搜索 → 详情；
  6. 设置改每组 10 个 → 下一组 10 个词；
  7. 重置进度。
- 上面的流程在安卓模拟器上自动跑（CI 可选），在两台真机上手动跑一遍再发布。
