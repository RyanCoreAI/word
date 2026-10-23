import assert from 'node:assert/strict';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';

const root = fileURLToPath(new URL('../', import.meta.url));
const url = process.env.WORD_QA_URL ?? 'https://word.yanxai.com/';
const origin = new URL(url).origin;
const output = path.resolve(process.env.WORD_PRIVACY_OUTPUT ?? path.join(root, '../../outputs/word-retell/hosting-privacy'));
await mkdir(output, { recursive: true });
const report = { startedAt: new Date().toISOString(), url, requests: [], external: [], errors: [] };
const browser = await chromium.launch({ channel: 'chrome', headless: true });
const context = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, serviceWorkers: 'allow' });
const page = await context.newPage();
page.on('pageerror', error => report.errors.push(error.message));
page.on('request', request => { report.requests.push(request.url()); const resource = new URL(request.url()); if (resource.protocol.startsWith('http') && resource.origin !== origin) report.external.push(request.url()); });
try {
  const response = await page.goto(url, { waitUntil: 'networkidle' });
  assert.equal(response.status(), 200); report.cacheControl = response.headers()['cache-control'];
  assert.match(report.cacheControl, /\bno-transform\b/);
  const html = await response.text(); assert.equal(html, await readFile(path.join(root, 'dist/index.html'), 'utf8'), 'Actual browser navigation HTML must match the build, including no injected beacon');
  await page.getByRole('button', { name: '下载词库并开始', exact: true }).waitFor();
  await page.getByRole('button', { name: '下载词库并开始', exact: true }).click(); await page.locator('.continue').waitFor();
  await page.evaluate(() => navigator.serviceWorker.ready.then(() => true)); await page.waitForFunction(() => navigator.serviceWorker.controller);
  await page.waitForTimeout(1500);
  assert.deepEqual(report.external, []); assert.ok(report.requests.every(raw => !/cloudflareinsights|\/cdn-cgi\/rum/.test(raw)));
  await page.reload({ waitUntil: 'networkidle' }); await page.locator('.continue').waitFor();
  assert.deepEqual(report.external, []); assert.deepEqual(report.errors, []); report.passed = true;
} catch (error) { report.passed = false; report.failure = { message: error.message, stack: error.stack }; process.exitCode = 1; await page.screenshot({ path: path.join(output, 'failure.png') }).catch(() => {}); console.error(error); }
finally { report.finishedAt = new Date().toISOString(); await writeFile(path.join(output, 'report.json'), JSON.stringify(report, null, 2)); await browser.close(); console.log(JSON.stringify({ passed: report.passed, cacheControl: report.cacheControl, externalRequests: report.external.length, output })); }
