[CmdletBinding()]
param(
    [string]$SdkPath = $env:ANDROID_SDK_ROOT,
    [string]$JdkPath = $env:JAVA_HOME,
    [string]$GradlePath,
    [string]$GradleUserHome = $env:GRADLE_USER_HOME,
    [string]$BuildRoot
)
$ErrorActionPreference = 'Stop'
$repoRoot = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '../..'))
$sourceAndroidRoot = Join-Path $repoRoot 'android'
$androidRoot = $sourceAndroidRoot
$utf8 = [Text.UTF8Encoding]::new($false)
if (!$SdkPath -or !(Test-Path -LiteralPath (Join-Path $SdkPath 'platforms/android-36/android.jar'))) { throw 'Pass -SdkPath for an SDK with platform 36 and build-tools 36.0.0.' }
if (!$JdkPath -or !(Test-Path -LiteralPath (Join-Path $JdkPath 'bin/java.exe'))) { throw 'Pass -JdkPath for JDK 21.' }
if ($BuildRoot) {
    $BuildRoot = [IO.Path]::GetFullPath($BuildRoot)
    if ($BuildRoot -match '[^\x00-\x7F]') { throw '-BuildRoot must be an ASCII path for Windows Android tools.' }
    $inputs = @('settings.gradle','build.gradle','gradle.properties','gradlew','gradlew.bat','gradle/wrapper/gradle-wrapper.jar','gradle/wrapper/gradle-wrapper.properties','app/build.gradle','app/proguard-rules.pro')
    $inputs += @(Get-ChildItem -LiteralPath (Join-Path $sourceAndroidRoot 'app/src') -Recurse -File | ForEach-Object { $_.FullName.Substring($sourceAndroidRoot.Length + 1).Replace('\','/') })
    $hashInput = ($inputs | Sort-Object | ForEach-Object { $_ + ':' + (Get-FileHash -LiteralPath (Join-Path $sourceAndroidRoot $_) -Algorithm SHA256).Hash }) -join "`n"
    $hasher = [Security.Cryptography.SHA256]::Create()
    try { $sourceHash = ([BitConverter]::ToString($hasher.ComputeHash($utf8.GetBytes($hashInput)))).Replace('-','').ToLowerInvariant() } finally { $hasher.Dispose() }
    $androidRoot = Join-Path $BuildRoot $sourceHash.Substring(0, 16)
    $marker = Join-Path $androidRoot '.word-source'
    if ((Test-Path -LiteralPath $androidRoot) -and (!(Test-Path -LiteralPath $marker) -or [IO.File]::ReadAllText($marker) -ne $repoRoot)) { throw 'Build directory is not owned by this Word source tree.' }
    [IO.Directory]::CreateDirectory($androidRoot) | Out-Null
    [IO.File]::WriteAllText($marker, $repoRoot, $utf8)
    foreach ($inputFile in $inputs) {
        $destination = Join-Path $androidRoot $inputFile
        [IO.Directory]::CreateDirectory((Split-Path $destination)) | Out-Null
        Copy-Item -LiteralPath (Join-Path $sourceAndroidRoot $inputFile) -Destination $destination -Force
    }
} elseif ($androidRoot -match '[^\x00-\x7F]') { throw 'Pass -BuildRoot for a dedicated ASCII build directory. The source checkout is never moved.' }
if (!$GradlePath) { $GradlePath = Join-Path $androidRoot 'gradlew.bat' }
if (!(Test-Path -LiteralPath $GradlePath)) { throw 'Gradle launcher missing. Use the checked-in wrapper or pass -GradlePath for Gradle 9.1.0.' }
$oldEnvironment = @{}
$environmentNames = @('JAVA_HOME','ANDROID_HOME','ANDROID_SDK_ROOT','GRADLE_USER_HOME','WORD_ANDROID_STORE_FILE','WORD_ANDROID_STORE_PASSWORD','WORD_ANDROID_KEY_ALIAS','WORD_ANDROID_KEY_PASSWORD','WORD_KEYTOOL_PASSWORD')
foreach ($name in $environmentNames) { $oldEnvironment[$name] = [Environment]::GetEnvironmentVariable($name, 'Process') }
try {
    $env:JAVA_HOME = [IO.Path]::GetFullPath($JdkPath)
    $env:ANDROID_HOME = [IO.Path]::GetFullPath($SdkPath)
    $env:ANDROID_SDK_ROOT = $env:ANDROID_HOME
    if ($GradleUserHome) { $env:GRADLE_USER_HOME = [IO.Path]::GetFullPath($GradleUserHome) }
    $sdkProperty = $env:ANDROID_HOME.Replace('\','/').Replace(':','\:')
    [IO.File]::WriteAllText((Join-Path $androidRoot 'local.properties'), "sdk.dir=$sdkProperty`n", $utf8)
    $signingRoot = Join-Path $sourceAndroidRoot '.signing'
    $keyStore = Join-Path $signingRoot 'word-release.p12'
    $passwordPath = Join-Path $signingRoot 'password.dpapi'
    $assetLinksPath = Join-Path $repoRoot 'apps/web/public/.well-known/assetlinks.json'
    if (!(Test-Path -LiteralPath $keyStore)) {
        if ((Test-Path -LiteralPath $assetLinksPath) -or (Test-Path -LiteralPath $passwordPath)) { throw 'Existing Word signing metadata detected. Restore the original signing files; never silently rotate a release key.' }
        [IO.Directory]::CreateDirectory($signingRoot) | Out-Null
        $randomBytes = New-Object byte[] 32
        $rng = [Security.Cryptography.RandomNumberGenerator]::Create()
        try { $rng.GetBytes($randomBytes) } finally { $rng.Dispose() }
        $password = [Convert]::ToBase64String($randomBytes)
        [Array]::Clear($randomBytes, 0, $randomBytes.Length)
        $securePassword = ConvertTo-SecureString $password -AsPlainText -Force
        [IO.File]::WriteAllText($passwordPath, (ConvertFrom-SecureString $securePassword), $utf8)
        $env:WORD_KEYTOOL_PASSWORD = $password
        & (Join-Path $JdkPath 'bin/keytool.exe') -genkeypair -keystore $keyStore -storetype PKCS12 -alias word-release -keyalg RSA -keysize 3072 -validity 10000 -dname 'CN=Word, O=Yanxai, C=CN' -storepass:env WORD_KEYTOOL_PASSWORD -keypass:env WORD_KEYTOOL_PASSWORD
        if ($LASTEXITCODE -ne 0) { throw 'Dedicated Word signing key creation failed; do not replace existing signing files.' }
    } else {
        if (!(Test-Path -LiteralPath $passwordPath)) { throw 'Word key exists but its DPAPI password is missing. Restore the original signing material.' }
        $securePassword = ConvertTo-SecureString ([IO.File]::ReadAllText($passwordPath))
        $pointer = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($securePassword)
        try { $password = [Runtime.InteropServices.Marshal]::PtrToStringBSTR($pointer) } finally { [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($pointer) }
    }
    $env:WORD_ANDROID_STORE_FILE = $keyStore
    $env:WORD_ANDROID_STORE_PASSWORD = $password
    $env:WORD_ANDROID_KEY_ALIAS = 'word-release'
    $env:WORD_ANDROID_KEY_PASSWORD = $password
    $env:WORD_KEYTOOL_PASSWORD = $password
    $certificatePath = Join-Path $signingRoot 'word-release.cer'
    & (Join-Path $JdkPath 'bin/keytool.exe') -exportcert -keystore $keyStore -alias word-release -storepass:env WORD_KEYTOOL_PASSWORD -file $certificatePath
    if ($LASTEXITCODE -ne 0) { throw 'Could not export the public Word signing certificate.' }
    $fingerprint = ((Get-FileHash -LiteralPath $certificatePath -Algorithm SHA256).Hash -replace '(..)(?=.)', '$1:')
    if (Test-Path -LiteralPath $assetLinksPath) {
        $existingLinks = [IO.File]::ReadAllText($assetLinksPath) | ConvertFrom-Json
        $matching = @($existingLinks | Where-Object { $_.target.package_name -eq 'com.yanxai.word' -and $_.target.sha256_cert_fingerprints -contains $fingerprint })
        if ($matching.Count -ne 1) { throw 'The signing certificate does not match published Word asset links.' }
    }
    $proxyArguments = @()
    if ($env:HTTPS_PROXY) {
        $proxy = [Uri]$env:HTTPS_PROXY
        if ($proxy.UserInfo) { throw 'Authenticated build proxies must be configured privately in Gradle; passwords are never passed on the command line.' }
        $proxyArguments = @("-Dhttps.proxyHost=$($proxy.DnsSafeHost)", "-Dhttps.proxyPort=$($proxy.Port)", "-Dhttp.proxyHost=$($proxy.DnsSafeHost)", "-Dhttp.proxyPort=$($proxy.Port)")
    }
    & $GradlePath @proxyArguments --project-dir $androidRoot --no-daemon --console=plain testDebugUnitTest lintRelease assembleRelease
    if ($LASTEXITCODE -ne 0) { throw 'Android tests, lint or signed release build failed.' }
    $apk = Join-Path $androidRoot 'app/build/outputs/apk/release/app-release.apk'
    $metadata = [IO.File]::ReadAllText((Join-Path $androidRoot 'app/build/outputs/apk/release/output-metadata.json')) | ConvertFrom-Json
    if ($metadata.applicationId -ne 'com.yanxai.word' -or $metadata.elements.Count -ne 1) { throw 'Unexpected Android package or split output.' }
    $version = $metadata.elements[0].versionName
    if ($version -notmatch '^\d+\.\d+\.\d+$') { throw 'Invalid release version.' }
    & (Join-Path $SdkPath 'build-tools/36.0.0/apksigner.bat') verify --verbose --print-certs $apk
    if ($LASTEXITCODE -ne 0) { throw 'Release APK signature verification failed.' }
    $downloadRoot = Join-Path $repoRoot 'apps/web/public/downloads'
    [IO.Directory]::CreateDirectory($downloadRoot) | Out-Null
    [IO.Directory]::CreateDirectory((Split-Path $assetLinksPath)) | Out-Null
    $filename = "word-android-$version.apk"
    Copy-Item -LiteralPath $apk -Destination (Join-Path $downloadRoot $filename) -Force
    $release = [ordered]@{
        applicationId = $metadata.applicationId
        version = $version
        versionCode = $metadata.elements[0].versionCode
        minSdk = 24
        browser = 'com.android.chrome'
        url = "https://word.yanxai.com/downloads/$filename"
        file = $filename
        bytes = (Get-Item -LiteralPath $apk).Length
        sha256 = (Get-FileHash -LiteralPath $apk -Algorithm SHA256).Hash.ToLowerInvariant()
        certificateSha256 = $fingerprint
    }
    $links = @(@{ relation = @('delegate_permission/common.handle_all_urls'); target = @{ namespace = 'android_app'; package_name = 'com.yanxai.word'; sha256_cert_fingerprints = @($fingerprint) } })
    [IO.File]::WriteAllText($assetLinksPath, (ConvertTo-Json -InputObject $links -Depth 8).Replace("`r`n", "`n") + "`n", $utf8)
    [IO.File]::WriteAllText((Join-Path $downloadRoot 'word-android.json'), (ConvertTo-Json $release -Depth 5).Replace("`r`n", "`n") + "`n", $utf8)
    Write-Host "Verified signed Word $version APK: $filename ($($release.bytes) bytes)."
    Write-Host "SHA-256: $($release.sha256)"
} finally {
    $password = $null
    $securePassword = $null
    foreach ($name in $environmentNames) { [Environment]::SetEnvironmentVariable($name, $oldEnvironment[$name], 'Process') }
}
