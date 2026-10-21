# 09 · 发布到 iPhone 和安卓、隐私合规

> 应用商店的政策经常变。下面写的是 2026 年的通行做法；每一步执行前，以苹果、谷歌、工信部和云服务商后台的**当时要求**为准。不确定的地方都已标出。

## 1. 分两个阶段

| 阶段 | 目标 | iPhone | 安卓 | 要不要备案 |
|---|---|---|---|---|
| **A：自用 / 小范围** | 你和朋友先用起来 | TestFlight（最多 100 个内部测试员，不用审核；每个版本 90 天后过期，要定期重新打包） | 官网 `yanxai.com/download` 直接下载 APK | 不需要（服务器在香港） |
| **B1：公开上架（海外商店）** | 任何人都能下载 | App Store（**不含中国大陆区**） | Google Play | 不需要 |
| **B2：公开上架（国内）** | 大陆用户从应用商店下载 | App Store 中国大陆区 | 华为、小米、OPPO、vivo、荣耀、应用宝 | **需要**：ICP 备案 + APP 备案，服务器要迁到大陆 |

建议：先做 A，用 2–4 周，确认好用再决定 B1 / B2。

## 2. 构建（EAS）

`apps/mobile/eas.json`：

```json
{
  "cli": { "appVersionSource": "remote" },
  "build": {
    "development": { "developmentClient": true, "distribution": "internal" },
    "preview":     { "distribution": "internal", "android": { "buildType": "apk" }, "channel": "preview" },
    "production":  { "autoIncrement": true, "channel": "production" },
    "apk":         { "extends": "production", "android": { "buildType": "apk" } }
  },
  "submit": { "production": {} }
}
```

- `production`：iOS 上传 App Store Connect，安卓生成 AAB（给 Google Play）。
- `apk`：安卓 APK，放到官网下载。
- 签名证书交给 EAS 管理。**安卓签名密钥必须备份**：`eas credentials` 下载 keystore，和密码一起存在你自己的密码管理器里。密钥丢了，已经安装的用户就再也收不到更新。
- 开发期间：可以先用 Expo Go 扫码在真机上看效果；用到 Expo Go 不支持的原生模块后，改用 `development` 构建。

## 3. iPhone

### 3.1 准备

1. 加入 Apple Developer Program：个人 ¥688/年（用你的 Apple ID，需要开启双重认证）。公司账号需要邓白氏码，审核更久，但商店里显示公司名。
2. App Store Connect → 新建 App：名称（不能和已有的 App 重名）、Bundle ID `com.yanxai.word`、SKU `word-ios`、主要语言简体中文。
3. 生成 App Store Connect API Key，交给 EAS Submit 使用。

### 3.2 阶段 A：TestFlight

1. `eas build -p ios --profile production` → `eas submit -p ios`。
2. App Store Connect → TestFlight → 内部测试：把你和朋友的 Apple ID 邮箱加为用户。手机安装 TestFlight App 后就能装。
3. 每个版本 90 天后过期。设一个提醒，每 80 天打一次包（哪怕代码没改）。

### 3.3 阶段 B：上架 App Store

| 项 | 内容 |
|---|---|
| 分类 | 教育 |
| 年龄分级 | 4+ |
| 截图 | 6.9 英寸 iPhone 截图 3–6 张（首页、看词、看词揭晓、听音、生词本），尺寸以 App Store Connect 当时的要求为准；可以用 Maestro 或模拟器批量截取 |
| 隐私政策网址 | `https://yanxai.com/privacy` |
| 技术支持网址 | `https://yanxai.com/support` |
| App 隐私（数据收集） | **联系信息 → 电子邮件**（可选，用于 App 功能，与身份关联）；**标识符 → 用户 ID**（App 功能，关联）；**使用数据 → 产品交互**（学习记录，App 功能，关联）；**诊断 → 崩溃数据**（仅在接入 Sentry 时勾选，不关联）。**不用于追踪**，所以不需要 ATT 弹窗 |
| 出口合规 | 只用 HTTPS（豁免加密），已在配置里声明 `usesNonExemptEncryption: false` |
| 账号删除 | App 内「账号与数据 → 注销账号」（审核硬性要求，已满足） |
| 通过 Apple 登录 | 不需要（App 没有微信、谷歌等第三方登录） |
| 审核备注 | 「无需登录即可使用全部功能。邮箱绑定为可选功能。主要流程：打开 → 同意 → 选择词库 → 首页点看词记忆。」 |
| 销售范围 | B1 阶段**取消勾选中国大陆**；做完备案后再勾选（苹果要求中国大陆区的 App 填写 ICP 备案号，以 App Store Connect 当时的提示为准） |

## 4. 安卓

### 4.1 阶段 A：官网下载 APK

1. `eas build -p android --profile apk` → 下载 APK → 上传到 R2 `android/` 目录 → 更新官网 `/download` 的版本号和 SHA-256。
2. App 内检查更新（可选，v1 不做）：首页不提示；用户到官网下载新版覆盖安装（签名相同，数据保留）。
3. 国产手机安装第三方 APK 会提示风险，属于正常现象；下载页写清楚各品牌的「允许安装未知应用」步骤。

### 4.2 阶段 B1：Google Play

1. 注册 Google Play 开发者账号（25 美元，一次性，需要身份验证）。
2. **个人账号**的新应用，要先做「封闭测试」：至少 12 名测试者连续参与 14 天，才能申请正式上架（以 Play 管理中心当时的要求为准）。
3. 必填：隐私政策网址；**数据安全表单**（收集：电子邮件（可选）、用户 ID、App 互动；传输加密：是；可以申请删除：是）；**账号删除网址** `https://yanxai.com/delete-account`；内容分级问卷；目标受众选 13–15、16–17、18 岁以上（不选 13 岁以下，避免适用谷歌的家庭应用政策）；目标 API 级别满足当年要求（跟随 Expo SDK 即可）。
4. `eas submit -p android` 需要 Google Play 服务账号的 JSON 密钥。

### 4.3 阶段 B2：国内安卓商店和 App Store 中国大陆区（需要时再做）

| 事项 | 说明 |
|---|---|
| 服务器迁到大陆 | 阿里云或腾讯云大陆地域；按 `08-server-deploy.md` 重新部署，迁移数据库 |
| ICP 备案 | 在云服务商后台为 `yanxai.com` 办理，个人可以办，通常 1–3 周；办完后官网页脚显示备案号并链接 `beian.miit.gov.cn` |
| APP 备案 | 工信部要求在大陆分发的 App 都要备案；一般通过大陆的云服务商（接入商）办理，需要 App 名称、包名、签名公钥、截图等。海外服务器的 App 很难办理（以工信部和云服务商当时的规定为准） |
| 软件著作权 | 多数国内安卓商店要求（或强烈建议）提供软著证书；自己申请约 1–2 个月 |
| 开发者账号 | 华为、小米、OPPO、vivo、荣耀、应用宝分别注册；部分商店对个人开发者有限制 |
| 隐私合规检测 | 商店会自动检测：同意隐私政策之前不能联网、不能读取任何设备标识；权限最少；隐私政策要列出所有第三方 SDK。v1 的设计（P0、只用随机设备 ID、只有网络权限）已经按这个要求来做 |
| 未成年人 | 高考词库的用户可能未满 18 岁；如果面向 14 岁以下儿童，要有单独的儿童个人信息保护规则和监护人同意。v1 的隐私政策写明「不面向 14 岁以下儿童」 |

## 5. 隐私政策与用户协议（Codex 起草，你审阅）

### 5.1 隐私政策提纲（`/privacy`，App 内同一份）

1. 我们是谁：运营者名称（你的姓名或公司）、联系邮箱 `support@yanxai.com`。
2. 收集哪些信息、为什么：
   - App 生成的随机设备 ID（不是 IMEI、MAC 等硬件标识）：区分设备、同步进度；
   - 学习记录（哪些词认识、不认识、时间）：提供学习功能、跨设备同步；
   - 邮箱（只在你主动绑定时）：找回进度、发送验证码；
   - App 版本、系统类型：兼容和排错；
   - 崩溃信息（只在接入 Sentry 时）：修复问题。
3. **不收集**：手机号、通讯录、位置、相册、麦克风、广告标识。
4. 第三方服务清单：Cloudflare（CDN）、Resend（发邮件）、云服务商（服务器托管）、Sentry（如果使用）。逐个写明用途和对方的隐私政策链接。
5. 存储地点和期限：服务器位于香港；账号存续期间保存；注销后 7 天内删除，备份 30 天内过期。
6. 你的权利：查看和导出（App 内导出 CSV）、更正、删除（App 内注销或官网申请）、撤回同意。
7. 未成年人：不面向 14 岁以下儿童。
8. 政策更新：更新后 App 会再次请你确认（`PRIVACY_VERSION`）。
9. 生效日期和版本号。

### 5.2 用户协议提纲（`/terms`）

服务内容、账号、用户行为、知识产权（词典数据来自 ECDICT（MIT），发音为 AI 合成）、免责声明、服务变更和终止、适用法律、联系方式。

> 如果打算收费或大规模推广，建议请律师审阅这两份文件。

## 6. 发布检查清单（每个版本）

- [ ] `version` 已更新；更新说明已写好
- [ ] CI 全绿；`packages/core` 测试 100% 通过
- [ ] 真机（iPhone + 中端安卓）跑完 `07-mobile-app.md` 第 8 节的 7 个端到端流程
- [ ] 性能指标达标（`07` 第 4.6 节）
- [ ] 安卓最终权限只有 INTERNET、ACCESS_NETWORK_STATE、VIBRATE
- [ ] 隐私同意之前没有网络请求（用抓包工具确认，例如 Charles 或 mitmproxy）
- [ ] 断网时完整学完一组；恢复网络后同步成功
- [ ] 换一台手机绑定同一个邮箱，进度恢复
- [ ] 注销账号后，服务器上该用户的数据为 0 行
- [ ] 官网下载页的版本号和 SHA-256 已更新
- [ ] 安卓签名密钥已备份
