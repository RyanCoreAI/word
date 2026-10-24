import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';
import { verifyAndroidAssets } from './verify-assets.mjs';

const root = fileURLToPath(new URL('../../', import.meta.url));
const base = new URL(process.env.WORD_QA_URL ?? 'http://127.0.0.1:4173/');
const localPreview = ['127.0.0.1', 'localhost', '[::1]'].includes(base.hostname);
const output = path.resolve(process.env.WORD_ANDROID_OUTPUT ?? path.join(root, '../../outputs/word-android/browser'));
await mkdir(output, { recursive: true });
const { release } = await verifyAndroidAssets(path.join(root, 'apps/web/public'));
const apkUrl = new URL(`downloads/${release.file}`, base).href;
const report = { url: base.href, release, checks: [], errors: [], external: [], device: 'Isolated desktop Chrome, mobile layout emulation; not physical Android or actual TWA Chrome.' };
const browser = await chromium.launch({ channel: 'chrome', headless: true });
const context = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, serviceWorkers: 'allow', acceptDownloads: true });
const page = await context.newPage(); page.setDefaultTimeout(30000);
const apkRequests = [];
page.on('pageerror', error => report.errors.push(error.message));
page.on('request', request => { const url = new URL(request.url()); if (url.pathname.endsWith('.apk')) apkRequests.push(url.href); if (url.protocol.startsWith('http') && url.origin !== base.origin) report.external.push(url.href); });
async function check(name, run) { const detail = await run(); report.checks.push({ name, detail, status: 'passed' }); console.log(JSON.stringify({ name, detail })); }
async function bytesInBrowser(url) {
  return page.evaluate(async url => {
    const response = await fetch(url, { cache: 'no-store' });
    const bytes = await response.arrayBuffer();
    const hash = await crypto.subtle.digest('SHA-256', bytes);
    return { status: response.status, redirected: response.redirected, type: response.headers.get('content-type'), disposition: response.headers.get('content-disposition'), bytes: bytes.byteLength, sha256: [...new Uint8Array(hash)].map(byte => byte.toString(16).padStart(2,'0')).join('') };
  }, url);
}
try {
  await page.goto(base.href); await page.getByRole('button', { name: '下载词库并开始', exact: true }).click(); await page.locator('.continue').waitFor();
  await page.evaluate(() => navigator.serviceWorker.ready.then(() => true)); await page.waitForFunction(() => navigator.serviceWorker.controller);
  await check('normal app usage and offline shell never prefetch the APK', async () => { assert.deepEqual(apkRequests, []); return { automaticApkRequests: 0 }; });
  await check('actual mobile and desktop install guide offers the signed APK alongside PWA', async () => {
    await page.getByRole('navigation', { name: '主导航' }).getByRole('button', { name: '设置', exact: true }).click();
    await page.getByRole('button', { name: '查看安装方法', exact: true }).click();
    const link = page.getByRole('link', { name: '下载安卓安装包 · 1.0.0', exact: true });
    assert.equal(await link.getAttribute('href'), apkUrl); assert.equal(await link.getAttribute('download'), release.file);
    await link.scrollIntoViewIfNeeded(); assert.equal(await link.isVisible(), true);
    await page.screenshot({ path: path.join(output, 'guide-mobile.png') });
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
    await page.setViewportSize({ width: 1440, height: 1000 }); await page.screenshot({ path: path.join(output, 'guide-desktop.png') });
    await page.setViewportSize({ width: 390, height: 844 }); assert.match(await page.locator('.installation-guide').innerText(), /稳定版 Chrome/); return { correctApkLink: true, chromeRequirementVisible: true, pageOverflow: false };
  });
  await check('service-worker-controlled browser receives the actual APK bytes rather than SPA HTML', async () => {
    const result = await bytesInBrowser(apkUrl); assert.equal(result.status, 200); assert.equal(result.redirected, false); assert.equal(result.bytes, release.bytes); assert.equal(result.sha256, release.sha256);
    // Vite preview does not apply the hosting platform's _headers file. The public deployment must.
    if (!localPreview) { assert.match(result.type, /application\/vnd\.android\.package-archive/); assert.match(result.disposition, /attachment/); }
    assert.equal(await page.evaluate(url => caches.match(url).then(result => !!result), apkUrl), false); return { ...result, cachedByServiceWorker: false, hostingHeaders: localPreview ? 'deferred to production: Vite preview ignores _headers' : 'verified' };
  });
  await check('public digital asset links expose only this Word certificate with no redirect', async () => {
    const result = await page.evaluate(async url => { const response = await fetch(url, { cache: 'no-store' }); return { status: response.status, redirected: response.redirected, type: response.headers.get('content-type'), links: await response.json() }; }, new URL('.well-known/assetlinks.json', base).href);
    assert.equal(result.status, 200); assert.equal(result.redirected, false); assert.match(result.type, /application\/json/); assert.deepEqual(result.links, [{ relation: ['delegate_permission/common.handle_all_urls'], target: { namespace: 'android_app', package_name: release.applicationId, sha256_cert_fingerprints: [release.certificateSha256] } }]); return result;
  });
  await check('offline APK and association requests fail honestly instead of becoming an HTML download', async () => {
    await context.setOffline(true);
    for (const relative of [`downloads/${release.file}`, '.well-known/assetlinks.json']) {
      const failed = await page.evaluate(async url => { try { await fetch(url); return false; } catch { return true; } }, new URL(relative, base).href); assert.equal(failed, true, relative);
    }
    await context.setOffline(false); return { offlineDownloadFails: true, noOfflineHtmlSubstitution: true };
  });
  assert.deepEqual(report.errors, []); assert.deepEqual(report.external, []); report.passed = true;
} catch (error) { report.passed = false; report.failure = { message: error.message, stack: error.stack }; process.exitCode = 1; console.error(error); await page.screenshot({ path: path.join(output, 'failure.png') }).catch(() => {}); }
finally { report.finishedAt = new Date().toISOString(); await writeFile(path.join(output, 'report.json'), JSON.stringify(report, null, 2)); await browser.close(); console.log(JSON.stringify({ passed: report.passed, output })); }
