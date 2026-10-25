import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';
import { verifyAndroidAssets } from './android/verify-assets.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));
const base = new URL(process.env.WORD_QA_URL ?? 'http://127.0.0.1:8787/');
assert.ok(['127.0.0.1', 'localhost', '[::1]', 'word.yanxai.com'].includes(base.hostname), 'Only Word or its loopback test server may be targeted.');
assert.ok(['http:', 'https:'].includes(base.protocol));
const output = path.resolve(process.env.WORD_SECURITY_OUTPUT ?? path.join(root, '../../outputs/word-security/browser'));
await mkdir(output, { recursive: true });
const { release, associationBytes } = await verifyAndroidAssets(path.join(root, 'apps/web/public'));
const association = JSON.parse(associationBytes);
const report = {
  startedAt: new Date().toISOString(), url: base.href, checks: [], pageErrors: [], violations: [], forbiddenRequests: [],
  boundaries: ['Isolated Chrome with synthetic empty learning state; no user profile or credentials.', 'CSP tests append real DOM scripts/onclick attributes; DevTools evaluation itself is not used as an eval-blocking proof.', 'HTTP loopback verifies HSTS header configuration, not HTTPS transport enforcement.', 'No microphone recording, native share target, Android/TWA or physical-device acceptance is claimed.'],
};
const esc = value => value.replaceAll('&', '&amp;').replaceAll('"', '&quot;').replaceAll('<', '&lt;');
// This task-owned page contains only the embedding test, never a replacement Word app.
const parent = createServer((request, response) => {
  if (request.url !== '/') { response.writeHead(404); response.end(); return; }
  response.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
  response.end(`<!doctype html><html><head><title>Word frame refusal probe</title><link rel="icon" href="data:,"></head><body><h1>Word embedding refusal probe</h1><iframe title="Word must refuse embedding" src="${esc(base.href)}" width="420" height="620"></iframe></body></html>`);
});
await new Promise((resolve, reject) => { parent.once('error', reject); parent.listen(0, '127.0.0.1', resolve); });
const parentOrigin = `http://127.0.0.1:${parent.address().port}`;
report.parentOrigin = parentOrigin;
const permittedOrigins = new Set([base.origin, parentOrigin]);
let browser;
let context;
let page;
let frameContext;
let networkPhase = 'normal';
const artifactResponses = [];
const allowed = async route => {
  const target = new URL(route.request().url());
  if (target.protocol.startsWith('http') && !permittedOrigins.has(target.origin)) {
    report.forbiddenRequests.push(target.href); await route.abort('blockedbyclient');
  } else await route.continue();
};
const check = async (name, run) => {
  try { const detail = await run(); report.checks.push({ name, status: 'passed', detail }); console.log(JSON.stringify({ name, status: 'passed', detail })); }
  catch (error) { report.checks.push({ name, status: 'failed', message: error.message }); throw error; }
};
function cspDirectives(value) {
  const directives = new Map();
  for (const part of value.split(';')) { const [name, ...tokens] = part.trim().split(/\s+/); if (name) { assert.ok(!directives.has(name), `Duplicate CSP directive ${name}`); directives.set(name, tokens); } }
  return directives;
}
function assertHeaders(headers) {
  const csp = headers['content-security-policy']; assert.ok(csp, 'An enforcing CSP response header is required.');
  const directives = cspDirectives(csp);
  for (const [name, tokens] of [['default-src', ["'none'"]], ['object-src', ["'none'"]], ['base-uri', ["'none'"]], ['form-action', ["'none'"]], ['frame-ancestors', ["'none'"]], ['script-src-attr', ["'none'"]], ['connect-src', ["'self'"]]]) assert.deepEqual(directives.get(name), tokens, `${name} must stay restrictive.`);
  for (const name of ['script-src', 'script-src-elem', 'script-src-attr']) {
    const tokens = directives.get(name) ?? [];
    assert.ok(!tokens.includes("'unsafe-eval'"), `${name} must not allow JavaScript unsafe-eval.`);
    assert.ok(!tokens.includes("'unsafe-inline'"), `${name} must not allow inline scripts.`);
  }
  assert.ok(directives.get('script-src')?.includes("'self'"));
  assert.ok(directives.get('script-src')?.includes("'wasm-unsafe-eval'"), 'Local ASR WASM must be allowed without enabling JavaScript eval.');
  for (const name of ['font-src', 'manifest-src', 'img-src', 'media-src', 'worker-src']) assert.ok(directives.get(name)?.includes("'self'"), `${name} must permit local resources.`);
  assert.equal(headers['x-content-type-options']?.toLowerCase(), 'nosniff');
  assert.equal(headers['x-frame-options']?.toUpperCase(), 'DENY');
  assert.equal(headers['referrer-policy'], 'no-referrer');
  const hsts = headers['strict-transport-security']; const seconds = Number(hsts?.match(/(?:^|;)\s*max-age=(\d+)/i)?.[1]);
  assert.ok(seconds >= 31_536_000, 'HSTS must have at least one year max-age.');
  const policy = headers['permissions-policy']; assert.ok(policy, 'Permissions-Policy is required.');
  for (const feature of ['microphone', 'web-share', 'clipboard-write']) assert.match(policy, new RegExp(`(?:^|,)\\s*${feature}=\\(self\\)`));
  for (const feature of ['camera', 'geolocation', 'display-capture', 'payment', 'usb']) assert.match(policy, new RegExp(`(?:^|,)\\s*${feature}=\\(\\)`));
  return { csp, hsts, nosniff: headers['x-content-type-options'], frame: headers['x-frame-options'], referrer: headers['referrer-policy'], permissions: policy };
}
async function readState() {
  return page.evaluate(() => new Promise((resolve, reject) => {
    const request = indexedDB.open('yanxai-word-v1'); request.onerror = () => reject(request.error?.message);
    request.onsuccess = () => { const db = request.result; const tx = db.transaction('state'); const read = tx.objectStore('state').get('current'); read.onsuccess = () => resolve(read.result); read.onerror = () => reject(read.error?.message); tx.oncomplete = () => db.close(); };
  }));
}
const shot = name => page.screenshot({ path: path.join(output, `${name}.png`), animations: 'disabled' });
async function browserBytes(relative) {
  return page.evaluate(async url => {
    const response = await fetch(url, { cache: 'no-store' }); const bytes = await response.arrayBuffer(); const digest = await crypto.subtle.digest('SHA-256', bytes);
    return { status: response.status, redirected: response.redirected, type: response.headers.get('content-type'), disposition: response.headers.get('content-disposition'), bytes: bytes.byteLength, sha256: [...new Uint8Array(digest)].map(byte => byte.toString(16).padStart(2, '0')).join(''), json: /application\/json/.test(response.headers.get('content-type') ?? '') ? JSON.parse(new TextDecoder().decode(bytes)) : null };
  }, new URL(relative, base).href);
}
try {
  browser = await chromium.launch({ channel: 'chrome', headless: true }); report.browserVersion = browser.version();
  context = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, timezoneId: 'America/Tijuana', serviceWorkers: 'allow' });
  await context.route('**/*', allowed);
  await context.exposeBinding('__recordWordPolicyViolation', (_source, event) => report.violations.push(event));
  await context.addInitScript(() => {
    window.__wordPolicyPhase = 'normal'; window.__wordPolicyEvents = [];
    document.addEventListener('securitypolicyviolation', event => {
      const item = { phase: window.__wordPolicyPhase, directive: event.effectiveDirective, blockedURI: event.blockedURI, disposition: event.disposition, documentURI: event.documentURI, sourceFile: event.sourceFile, line: event.lineNumber };
      window.__wordPolicyEvents.push(item); void window.__recordWordPolicyViolation(item);
    });
  });
  page = await context.newPage(); page.setDefaultTimeout(35_000);
  page.on('pageerror', error => report.pageErrors.push(error.message));
  page.on('response', response => { if (/\/(?:downloads\/|\.well-known\/)/.test(new URL(response.url()).pathname)) artifactResponses.push({ url: response.url(), fromServiceWorker: response.fromServiceWorker(), phase: networkPhase }); });
  const navigation = await page.goto(base.href); assert.ok(navigation); assert.equal(navigation.status(), 200);
  const onlineHeaders = await navigation.allHeaders();
  await check('Cloudflare-served document has enforcing CSP and restrictive browser security headers', async () => assertHeaders(onlineHeaders));
  await check('microphone and browser-supported sharing policy remain available', async () => {
    const policy = await page.evaluate(() => {
      const features = document.featurePolicy ?? document.permissionsPolicy;
      const webShareSupported = features?.features?.().includes('web-share') ?? false;
      return { secure: isSecureContext, api: !!features, microphone: features?.allowsFeature('microphone'), webShareSupported, webShare: webShareSupported ? features.allowsFeature('web-share') : null, camera: features?.allowsFeature('camera'), geolocation: features?.allowsFeature('geolocation'), microphoneApi: typeof navigator.mediaDevices?.getUserMedia, shareApi: typeof navigator.share, canShareImage: navigator.canShare?.({ files: [new File([new Uint8Array([137, 80, 78, 71])], 'capability.png', { type: 'image/png' })] }) ?? false };
    });
    report.browserPolicy = policy;
    assert.equal(policy.secure, true); assert.equal(policy.api, true); assert.equal(policy.microphone, true); if (policy.webShareSupported) assert.equal(policy.webShare, true); assert.equal(policy.camera, false); assert.equal(policy.geolocation, false);
    assert.equal(policy.microphoneApi, 'function'); assert.equal(policy.shareApi, 'function'); return policy;
  });
  await page.getByRole('button', { name: '下载词库并开始', exact: true }).click(); await page.locator('.continue').waitFor();
  await page.evaluate(() => navigator.serviceWorker.ready.then(() => true)); await page.waitForFunction(() => navigator.serviceWorker.controller);
  await check('real dictionary onboarding and local fonts render without mobile or desktop overflow', async () => {
    await page.evaluate(() => document.fonts.ready.then(() => true));
    const layouts = [];
    for (const [name, width, height] of [['mobile', 390, 844], ['small-mobile', 320, 568], ['desktop', 1440, 1000]]) {
      await page.setViewportSize({ width, height });
      const layout = await page.locator('.app-screen').evaluate(element => ({ clientWidth: element.clientWidth, scrollWidth: element.scrollWidth, pageWidth: document.documentElement.scrollWidth, viewportWidth: innerWidth, bodyFont: getComputedStyle(document.body).fontFamily, fontsStatus: document.fonts.status, localFontResources: performance.getEntriesByType('resource').filter(entry => /\.woff2?(?:\?|$)/.test(entry.name)).map(entry => entry.name) }));
      assert.ok(layout.scrollWidth <= layout.clientWidth + 1); assert.ok(layout.pageWidth <= layout.viewportWidth + 1); assert.equal(layout.fontsStatus, 'loaded'); assert.ok(layout.localFontResources.length > 0);
      assert.ok(layout.localFontResources.every(resource => new URL(resource).origin === base.origin));
      await shot(`home-${name}`); layouts.push({ name, width, height, ...layout });
    }
    assert.equal(report.violations.length, 0, 'Normal app startup must not violate CSP.'); assert.equal(report.pageErrors.length, 0);
    assert.equal(artifactResponses.length, 0, 'Installation must not prefetch APK/association files.');
    await page.setViewportSize({ width: 390, height: 844 }); return layouts;
  });
  await check('offline service-worker document retains the same enforcing headers and local progress', async () => {
    const before = await readState(); assert.ok(before?.dictionaryVersion);
    await context.setOffline(true);
    const response = await page.reload(); assert.ok(response); assert.equal(response.fromServiceWorker(), true); assert.equal(response.status(), 200);
    const headers = await response.allHeaders(); const checked = assertHeaders(headers); assert.equal(headers['content-security-policy'], onlineHeaders['content-security-policy']);
    await page.locator('.continue').waitFor(); assert.deepEqual(await readState(), before); await shot('offline-home-mobile');
    await context.setOffline(false); return { fromServiceWorker: true, sameCsp: true, statePreserved: true, ...checked };
  });
  await check('real appended inline script and onclick handler are blocked and emit enforcing CSP violations', async () => {
    await page.evaluate(() => {
      window.__wordPolicyPhase = 'inline-script-probe'; window.__wordInlineMarker = false;
      const script = document.createElement('script'); script.id = 'word-security-script'; script.textContent = 'window.__wordInlineMarker = true;'; document.body.append(script);
    });
    await page.waitForFunction(() => window.__wordPolicyEvents.some(event => event.phase === 'inline-script-probe' && event.directive === 'script-src-elem' && event.blockedURI === 'inline'));
    assert.equal(await page.evaluate(() => window.__wordInlineMarker), false);
    await page.evaluate(() => {
      window.__wordPolicyPhase = 'inline-handler-probe'; window.__wordHandlerMarker = false;
      const button = document.createElement('button'); button.id = 'word-security-handler'; button.type = 'button'; button.textContent = 'Security inline-handler probe'; button.setAttribute('onclick', 'window.__wordHandlerMarker = true;'); document.body.append(button); button.click();
    });
    await page.waitForFunction(() => window.__wordPolicyEvents.some(event => event.phase === 'inline-handler-probe' && event.directive === 'script-src-attr' && event.blockedURI === 'inline'));
    assert.equal(await page.evaluate(() => window.__wordHandlerMarker), false);
    await page.evaluate(() => { document.getElementById('word-security-script')?.remove(); document.getElementById('word-security-handler')?.remove(); window.__wordPolicyPhase = 'normal'; });
    const expected = report.violations.filter(event => event.blockedURI === 'inline' && ((event.phase === 'inline-script-probe' && event.directive === 'script-src-elem') || (event.phase === 'inline-handler-probe' && event.directive === 'script-src-attr')));
    assert.ok(expected.length >= 2); assert.ok(expected.every(event => event.disposition === 'enforce')); return { scriptMarkerExecuted: false, handlerMarkerExecuted: false, violations: expected };
  });
  await check('a separate loopback parent cannot embed Word because frame-ancestors rejects it', async () => {
    frameContext = await browser.newContext({ viewport: { width: 1100, height: 800 }, serviceWorkers: 'block' }); await frameContext.route('**/*', allowed);
    const parentPage = await frameContext.newPage(); const securityLogs = []; const issues = [];
    const cdp = await frameContext.newCDPSession(parentPage); await cdp.send('Log.enable'); await cdp.send('Audits.enable');
    cdp.on('Log.entryAdded', ({ entry }) => { if (/frame-ancestors|x-frame-options/i.test(entry.text)) securityLogs.push(entry.text); });
    cdp.on('Audits.issueAdded', ({ issue }) => { if (issue.code === 'ContentSecurityPolicyIssue') issues.push(issue.details); });
    parentPage.on('console', message => { if (/frame-ancestors|x-frame-options/i.test(message.text())) securityLogs.push(message.text()); });
    await parentPage.goto(`${parentOrigin}/`);
    for (let attempt = 0; attempt < 50 && !securityLogs.length; attempt += 1) await parentPage.waitForTimeout(100);
    assert.ok(securityLogs.some(message => /frame-ancestors/i.test(message)), 'Browser must report frame-ancestors refusal, not merely fail to load.');
    const children = parentPage.frames().filter(frame => frame !== parentPage.mainFrame()); assert.ok(children.length > 0);
    for (const frame of children) { assert.equal(await frame.locator('.app-screen').count(), 0); assert.equal(await frame.getByRole('button', { name: '下载词库并开始', exact: true }).count(), 0); }
    await parentPage.screenshot({ path: path.join(output, 'embedding-refused.png'), animations: 'disabled' });
    return { parentOrigin, frames: children.map(frame => frame.url()), browserRefusal: securityLogs, cspIssues: issues, wordUiVisible: false };
  });
  await check('APK and public association remain direct network assets with verified MIME, bytes and certificate', async () => {
    networkPhase = 'explicit-artifact-check';
    const apk = await browserBytes(`downloads/${release.file}`); assert.equal(apk.status, 200); assert.equal(apk.redirected, false); assert.equal(apk.bytes, release.bytes); assert.equal(apk.sha256, release.sha256);
    assert.match(apk.type, /^application\/vnd\.android\.package-archive(?:;|$)/i); assert.match(apk.disposition, /^attachment(?:;|$)/i);
    const metadata = await browserBytes('downloads/word-android.json'); assert.equal(metadata.status, 200); assert.equal(metadata.redirected, false); assert.match(metadata.type, /^application\/json(?:;|$)/i); assert.deepEqual(metadata.json, release);
    const links = await browserBytes('.well-known/assetlinks.json'); assert.equal(links.status, 200); assert.equal(links.redirected, false); assert.match(links.type, /^application\/json(?:;|$)/i); assert.deepEqual(links.json, association);
    for (const relative of [`downloads/${release.file}`, 'downloads/word-android.json', '.well-known/assetlinks.json']) {
      const responses = artifactResponses.filter(response => response.url === new URL(relative, base).href && response.phase === 'explicit-artifact-check');
      assert.ok(responses.length > 0); assert.ok(responses.every(response => !response.fromServiceWorker), 'APK and DAL must bypass the shell service worker.');
    }
    return { apk, metadata, association: links, directNetworkResponses: artifactResponses.filter(response => response.phase === 'explicit-artifact-check') };
  });
  await check('normal app has no unintended CSP violations, page errors or external requests', async () => {
    const unexpected = report.violations.filter(event => !(event.blockedURI === 'inline' && ((event.phase === 'inline-script-probe' && event.directive === 'script-src-elem') || (event.phase === 'inline-handler-probe' && event.directive === 'script-src-attr'))));
    assert.deepEqual(unexpected, []); assert.deepEqual(report.pageErrors, []); assert.deepEqual(report.forbiddenRequests, []);
    return { expectedInlineViolations: report.violations.length, unintendedViolations: 0, pageErrors: 0, externalRequests: 0 };
  });
  report.status = 'passed';
} catch (error) {
  report.status = 'failed'; report.failure = { message: error.message, stack: error.stack }; process.exitCode = 1;
  await page?.screenshot({ path: path.join(output, 'failure.png') }).catch(() => {});
} finally {
  report.finishedAt = new Date().toISOString(); await writeFile(path.join(output, 'report.json'), JSON.stringify(report, null, 2));
  await frameContext?.close(); await context?.close(); await browser?.close(); await new Promise(resolve => parent.close(resolve));
}
console.log(JSON.stringify({ status: report.status, checks: report.checks.length, output, failure: report.failure?.message }));
