# 04 · 发音音频

## 1. 方案

- 用 **Azure AI Speech 神经网络语音**，为词包里的 19,094 个词各生成**美音**和**英音**各 1 个 MP3，共约 38,200 个文件。只生成一次，之后词包新增词时增量生成。
- 文件放到 Cloudflare R2，域名 `cdn.yanxai.com`，永久缓存。
- App 在每组开始时把这一组 20 个词的音频下载到手机缓存；播放时读本地文件，几乎没有延迟。
- 没网又没缓存时，用手机系统自带的英文朗读（iOS AVSpeechSynthesizer / 安卓 TextToSpeech，通过 `expo-speech`）。

**为什么不用有道等词典网站的发音接口**：那些是非公开接口，不允许商用，随时可能失效或限流。自己生成的音频版权清楚、音色统一、速度可控。

## 2. 生成（`tools/tts`）

### 2.1 选发音人

1. 用 Azure 的语音列表接口列出 `en-US` 和 `en-GB` 的全部神经语音。
2. 每种口音挑 4–6 个候选（例如 en-US-AvaNeural、en-US-AndrewNeural、en-US-JennyNeural、en-GB-SoniaNeural、en-GB-RyanNeural、en-GB-LibbyNeural；以接口实际返回的为准）。
3. 用 30 个测试词（含 `elaborate` `record` `present` `meticulous` `ubiquitous` `colonel` `subtle` `rhythm` `schedule` `tomato` `either` `data` 等）给每个候选生成样音，输出一个本地试听网页 `tools/tts/out/voices.html`。
4. **由你试听后选定**美音、英音各一个，写入 `tools/tts/voices.json`。

### 2.2 合成参数

- 输出格式：`audio-24khz-48kbitrate-mono-mp3`。
- SSML：
  ```xml
  <speak version="1.0" xmlns="http://www.w3.org/2001/10/synthesis" xml:lang="en-US">
    <voice name="{voice}"><prosody rate="-8%">{word}</prosody></voice>
  </speak>
  ```
  `{word}` 要做 XML 转义。英音把 `xml:lang` 换成 `en-GB`。
- 发音覆盖：`tools/tts/overrides.json` 里可以给某个词指定 IPA（`<phoneme alphabet="ipa" ph="…">word</phoneme>`），用来修正抽查发现的错误发音。
- 并发 8，失败重试 3 次（指数退避）；结果写入 `tools/tts/out/manifest.json`（每个文件的字节数和 SHA-256），可以断点续跑。

### 2.3 后期处理（ffmpeg）

1. 去掉首尾静音：`silenceremove=start_periods=1:start_threshold=-50dB:stop_periods=1:stop_threshold=-50dB`（尾部用 `areverse` 处理两次）。
2. 首尾各补 40 ms 静音，避免截掉爆破音。
3. 响度统一到 −16 LUFS（`loudnorm=I=-16:TP=-1.5:LRA=11`）。
4. 重新编码为 MP3 单声道 24 kHz 48 kbps。单个文件约 4–8 KB，全部约 250 MB。

### 2.4 质检

- `tools/tts/out/review.html`：随机 200 个 + 词频最高的 100 个 + 多音词名单，每个词一行，可以播放美音和英音，并有「有问题」勾选框，导出问题清单。
- 你抽查后，Codex 把问题词加进 `overrides.json` 重新生成。

### 2.5 成本

19,094 词 × 平均 7.8 个字母 × 2 种口音 ≈ 30 万字符。按 Azure 神经语音标准价（约 15 美元/百万字符，以当时价格为准）计算约 5 美元。免费档 F0 每月有 50 万字符额度，但限速较严，生成 3.8 万个请求会很慢，建议直接用 S0。

## 3. 存储与 CDN

- R2 存储桶：`yanxai-cdn`，自定义域名 `cdn.yanxai.com`（需要域名托管在 Cloudflare）。
- 路径：`audio/v1/{us|uk}/{word}.mp3`。路径里的单词做 `encodeURIComponent`（只有小写字母和连字符，实际不会被编码）。
- 响应头：`Content-Type: audio/mpeg`，`Cache-Control: public, max-age=31536000, immutable`。
- 版本：重新生成整批音频时用新目录 `audio/v2/…`，并更新词包 `meta.audio_version`。单个词修正发音时**也要换文件名**（`{word}.{短哈希}.mp3`），或者整批升版本，不能覆盖同名文件，否则手机缓存不会更新。v1 先用整批升版本的办法。
- 上传完成后，管线根据实际上传结果回填词包的 `audio` 位掩码（1 = 有美音，2 = 有英音）。

## 4. App 端播放

库：`expo-audio`（播放）、`expo-file-system`（下载和缓存）、`expo-speech`（兜底）。具体 API 以所用 Expo SDK 的文档为准。

### 4.1 缓存

- 目录：`Paths.cache/audio/v1/{accent}/{word}.mp3`（iOS 的 Library/Caches；系统空间不够时可能清掉，丢了就重新下载）。**不要放在 Documents**，苹果要求可以重新下载的数据不进 iCloud 备份。
- 开始一组时：后台并发 4 个，下载本组所有词当前口音的音频（已缓存的跳过）。第 1 个词优先下载。
- 播放某个词时如果文件还没下载完：等最多 600 ms；还没好就改用系统朗读。
- 下载用临时文件名，完成后再改名，避免播放到下载了一半的文件。

### 4.2 播放器

- 维护两个播放器实例 A/B 交替使用：当前词用 A 播放时，提前把下一个词的文件加载进 B（不播放）。切到下一个词时直接调用 B 的播放，这样从进场到出声 ≤ 120 ms。
- 自动朗读：卡片开始进场时调用播放，不等动画结束。
- 朗读遍数 n > 1：每遍之间间隔 400 ms。
- 慢速：播放速率 0.7，开启音高校正（`expo-audio` 的 playbackRate / pitch correction 设置）。
- 任何作答、撤销、离开页面、App 退到后台时，立即停止当前播放和后续的重复播放。
- 音频会话（iOS）：静音开关打开时**也要出声**（学习类 App 用户期望有声音）；有其他 App 在放音乐时**压低**对方音量（duck），而不是打断。对应 `setAudioModeAsync({ playsInSilentMode: true, interruptionMode: 'duckOthers', shouldPlayInBackground: false })`，名称以 SDK 文档为准。
- 安卓：只申请网络权限。`expo-audio` 的配置插件默认可能加麦克风权限，必须关掉（见 `07-mobile-app.md` 第 1 节）。

### 4.3 兜底

| 情况 | 处理 |
|---|---|
| 词包里 `audio` 位掩码显示没有该口音的文件 | 直接用系统朗读，不发请求 |
| 下载失败、没网 | 系统朗读：`Speech.speak(word, { language: 'en-US' 或 'en-GB', rate: 慢速 ? 0.6 : 0.9 })` |
| 系统没有英文语音包（部分国产安卓） | 静默失败；喇叭按钮显示一个小提示点，点击后提示「这台手机没有英文朗读引擎，联网后可以播放真人发音」 |

### 4.4 指标

- 已缓存时：卡片进场到出声 ≤ 120 ms（P95，中端安卓机）。
- 每组开始后 3 秒内（4G 网络）本组音频全部缓存完。
- 播放时不允许出现卡顿、爆音、重复两遍（连点按钮时以最后一次为准）。
