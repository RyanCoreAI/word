# Word Android APK

用户在 2026-10-23 明确要求直接下载 APK；本工程是现有 Word 网页的 Trusted Web Activity 发行壳，不更换网页或学习规则。

- 应用：`com.yanxai.word`，首版 `1.0.0 / 1`，Android 7.0（API 24）及以上。
- 固定稳定版 Chrome `com.android.chrome`，没有 Chrome 时显示官方提示，不改用 WebView 或另一套浏览器数据。
- 唯一入口及可信来源为 `https://word.yanxai.com/`；外来 Intent 的 URL 只允许本站 HTTPS、默认端口或 443、无用户信息。系统 App Links 仅匹配官网根路径，避免已安装应用接管 `/downloads/` 的安装包下载。
- 同一个 Chrome 配置中的本站 IndexedDB、缓存和权限继续由 Chrome 管理。其它浏览器或设备的记录需手动备份导入；APK 没有云同步，也不会给安卓安装 Samantha。
- 首次需要联网打开并下载词库。网页功能随官网更新；APK 升级使用相同包名和 Word 专用签名覆盖安装，不要求先卸载。

## 构建

固定 Gradle 9.1.0（wrapper 分发 SHA-256 已锁定）、AGP 9.0.1、Android Browser Helper 2.7.4；JDK 21 运行，Java 17 编译，SDK/build-tools 36。使用现有本机工具，不购买开发者账号或上传商店。

```powershell
./tools/android/build.ps1 -SdkPath 'D:/dev/Android/Sdk' -JdkPath 'C:/Program Files/Java/jdk-21' -GradleUserHome 'D:/dev/gradle-cache' -BuildRoot 'D:/dev/word-android-build'
```

中文 Windows 路径会被 Android Gradle 阻止。脚本在指定 ASCII 构建目录中按源文件哈希创建独立副本，只复制列明的配置与源码，不移动仓库、不删除已有文件、不复制签名材料。`local.properties` 只写入构建副本；所有环境设置仅对当前子进程生效并在结束时还原。

脚本首次生成仅供 Word 使用的 RSA 3072 release 密钥，保存在忽略目录 `android/.signing/`；密码使用当前 Windows 用户 DPAPI 加密，不打印、不进入 Git、命令行或 APK。密钥或密码文件缺失、证书与已发布关联不同会停止，绝不悄悄轮换或改用 debug 签名。保留该目录；DPAPI 密文依赖原 Windows 用户配置，跨设备迁移需另行安全备份签名材料，不能只复制密文。

运行 URL 来源策略单测、release lint、签名 release 构建，并通过 `apksigner verify` 后，生成 `apps/web/public/downloads/word-android-1.0.0.apk`、公开哈希/版本元数据和 `.well-known/assetlinks.json`。APK、公钥指纹可公开，私钥和口令不可公开。发布静态站点后验证官网 JSON、MIME、证书指纹和 APK 完整字节；浏览器中的 App Links 状态不单独当作 TWA 无地址栏的证据。

APK 及关联文件不进入 Service Worker 缓存或安装预下载；下载路由也不能被 SPA/离线首页替换。`tools/android/verify-assets.mjs` 在站点构建时验证包名、版本、大小、SHA-256 与关联证书；安装包的实际签名另由 Android SDK 检查。

## 验证边界

安装、覆盖升级、启动与缺少 Chrome 的提示可以在本任务的独立 AOSP 模拟器检查。没有 Chrome 的 AOSP 镜像不能证明 TWA 的实际域名验证、全屏页面、语音、麦克风或分享；不禁用验证来补造结果。真机的系统安装限制、当地分发政策与浏览器能力仍以设备实际结果为准。

官方依据：[TWA 运行机制](https://developer.android.com/develop/ui/views/layout/webapps/trusted-web-activities)、[站点双向关联](https://developer.android.com/training/app-links/configure-assetlinks)、[Android Browser Helper](https://github.com/GoogleChrome/android-browser-helper)、[AGP 9.0 工具兼容表](https://developer.android.com/build/releases/agp-9-0-0-release-notes)。
