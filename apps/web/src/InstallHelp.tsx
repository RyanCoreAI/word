import { useState } from 'react';

export function installPlatform(userAgent: string): 'embedded' | 'android' | 'ios' | 'desktop' {
  if (/MicroMessenger|\bQQ\/|Weibo|FBAN|FBAV/i.test(userAgent)) return 'embedded';
  if (/Android/i.test(userAgent)) return 'android';
  if (/iPhone|iPad|iPod/i.test(userAgent)) return 'ios';
  return 'desktop';
}

export function InstallHelp() {
  const platform = installPlatform(navigator.userAgent);
  const [copied, setCopied] = useState(false);
  return <div className="installation-guide"><p className="help-text">安装后从手机桌面图标打开，使用独立应用窗口。无需应用商店账号或付费，也不需要下载 APK。</p>
    {platform === 'embedded' && <p className="install-browser-note">当前可能是应用内置浏览器。请从右上角菜单选择在浏览器打开，或复制下面的网址到 Chrome。</p>}
    <ol className="install-help">
      {platform === 'ios' ? <><li>用 Safari 打开本站。</li><li>点分享按钮，选择「添加到主屏幕」，确认添加。</li><li>从桌面的「背单词」图标打开。</li></> : <><li>在安卓手机上，用 Chrome 打开本站。</li><li>点首页「安装应用」。如果没有弹出安装窗口，点浏览器右上角 ⋮，选择「安装并创建快捷方式 → 安装」；部分版本显示「添加到主屏幕」或「安装应用」。</li><li>按系统提示确认，再从桌面的「背单词」图标打开。若只创建了快捷方式，打开时仍有地址栏，可在 Chrome 菜单再次检查是否提供安装。</li></>}
    </ol>
    <label className="install-address"><span>网址</span><input aria-label="应用安装网址" readOnly value="https://word.yanxai.com/" onFocus={event => event.currentTarget.select()} /></label>
    {navigator.clipboard?.writeText && <button className="btn plain" onClick={() => { void navigator.clipboard.writeText('https://word.yanxai.com/').then(() => setCopied(true)).catch(() => setCopied(false)); }}>{copied ? '已复制网址' : '复制网址'}</button>}
    <p className="help-text">首次离线前先下载词库。学习记录保存在当前浏览器本机，换浏览器或手机前请导出备份；本地英文发音还需要系统已安装对应声音。若已经安装，请从桌面图标打开。</p>
    <a className="install-official" href="https://support.google.com/chrome/answer/9658361?co=GENIE.Platform%3DAndroid&hl=zh-Hans" target="_blank" rel="noreferrer">查看 Chrome 官方安装说明</a>
  </div>;
}
