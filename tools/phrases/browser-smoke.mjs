import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';

const root = fileURLToPath(new URL('../../', import.meta.url));
const url = process.env.WORD_QA_URL ?? 'http://127.0.0.1:4173/';
const output = path.resolve(process.env.WORD_PHRASES_OUTPUT ?? path.join(root, '../../outputs/word-phrases/browser'));
await mkdir(output, { recursive: true });
const report = { startedAt: new Date().toISOString(), url, checks: [], requests: [], pageErrors: [] };
const browser = await chromium.launch({ channel: 'chrome', headless: true });
const context = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, serviceWorkers: 'allow' });
const page = await context.newPage(); page.setDefaultTimeout(30_000);
page.on('pageerror', error => report.pageErrors.push(error.message));
page.on('request', request => { if (new URL(request.url()).pathname.startsWith('/phrases/')) report.requests.push(request.url()); });
const state = () => page.evaluate(() => new Promise((resolve, reject) => {
  const request = indexedDB.open('yanxai-word-v1'); request.onerror = () => reject(request.error?.message);
  request.onsuccess = () => { const db = request.result; const tx = db.transaction('state'); const read = tx.objectStore('state').get('current'); read.onsuccess = () => resolve(read.result); tx.oncomplete = () => db.close(); };
}));
async function check(name, action) { const detail = await action(); report.checks.push({ name, status: 'passed', detail }); console.log(JSON.stringify({ name, status: 'passed', detail })); }
async function shot(name) { await page.evaluate(() => document.fonts.ready.then(() => true)); await page.screenshot({ path: path.join(output, `${name}.png`), animations: 'disabled' }); }
async function openWord(word) {
  await page.getByRole('searchbox', { name: '搜索词典 · 输入英文单词', exact: true }).fill(word);
  await page.locator('.home-search-results .it').filter({ hasText: word }).first().click();
  await page.getByRole('dialog', { name: '单词详情', exact: true }).waitFor();
  await page.getByRole('button', { name: '短语与近义表达', exact: true }).click();
}
const close = () => page.getByRole('button', { name: '关闭弹窗', exact: true }).click();
try {
  await page.goto(url);
  await page.getByRole('button', { name: '下载词库并开始', exact: true }).click();
  await page.locator('.continue').waitFor();
  await check('phrase data remains lazy until explicit expansion', async () => {
    assert.equal(report.requests.length, 0);
    return { phraseRequestsBeforeExpansion: 0 };
  });
  await check('real because of meaning and source-backed due to relation render', async () => {
    const before = await state();
    await openWord('because');
    const phrase = page.locator('.phrase-item').filter({ has: page.getByRole('heading', { name: 'because of', exact: true }) });
    await phrase.waitFor();
    assert.match(await phrase.locator('.phrase-meaning').innerText(), /由[於于]/);
    assert.match(await phrase.locator('.phrase-substitutes').innerText(), /due to/);
    assert.equal(new URL(await phrase.locator('.phrase-source').getAttribute('href')).origin, 'https://zh.wiktionary.org');
    assert.deepEqual(await state(), before);
    await shot('01-because-of');
    const popup = page.waitForEvent('popup');
    await page.getByRole('link', { name: 'CC BY-SA 4.0', exact: true }).click();
    const license = await popup;
    await license.waitForLoadState('domcontentloaded');
    assert.match(await license.locator('body').innerText(), /Attribution-ShareAlike/);
    await license.close();
    await close();
    return { phrase: 'because of', meaning: '由於', substitute: 'due to', sourcePage: true, licenseNavigation: true, progressUnchanged: true };
  });
  await check('way expressions preserve meanings and shared-sense substitutes', async () => {
    await openWord('way');
    const phrase = page.locator('.phrase-item').filter({ has: page.getByRole('heading', { name: 'by the way', exact: true }) });
    await phrase.waitFor();
    assert.match(await phrase.innerText(), /順便|顺便/);
    assert.match(await phrase.locator('.phrase-substitutes').innerText(), /incidentally/);
    await shot('02-way-expressions');
    await close();
    return { phrase: 'by the way', substitute: 'incidentally', realChineseSense: true };
  });
  await check('missing source record shows a truthful empty state', async () => {
    await openWord('elaborate');
    await page.getByText('这个词暂无经过筛选的短语资料。不会自动拼凑搭配或近义词。', { exact: true }).waitFor();
    assert.equal(await page.locator('.phrase-item').count(), 0);
    await shot('03-empty-phrase-data');
    await close();
    return { word: 'elaborate', inventedPhrases: 0 };
  });
  await check('corrupt download is rejected and UI retry restores verified data', async () => {
    const before = await state();
    await context.route('**/phrases/**/m.json*', route => route.fulfill({ status: 200, contentType: 'application/json', body: '{}' }));
    await openWord('make');
    await page.getByRole('button', { name: '重试', exact: true }).waitFor();
    assert.equal(await page.locator('.phrase-item').count(), 0);
    assert.deepEqual(await state(), before);
    await context.unroute('**/phrases/**/m.json*');
    await page.getByRole('button', { name: '重试', exact: true }).click();
    await page.locator('.phrase-item').first().waitFor();
    assert.deepEqual(await state(), before);
    await shot('04-make-after-retry');
    await close();
    return { badBytesRejected: true, retryVerifiedRealSource: true, progressUnchanged: true };
  });
  await check('revealed study word has a phrase entry without changing answers', async () => {
    await page.getByRole('button', { name: '收起', exact: true }).click();
    await page.getByRole('button', { name: /^看词记忆/ }).click();
    await page.getByRole('button', { name: '不认识', exact: true }).click();
    await page.locator('.meaning').waitFor();
    const before = await state();
    const word = await page.locator('h2.word').innerText();
    await page.getByRole('button', { name: '查看当前单词的短语与近义表达', exact: true }).click();
    await page.getByRole('button', { name: '短语与近义表达', exact: true }).click();
    await page.locator('.phrase-item').first().waitFor();
    assert.deepEqual(await state(), before);
    await shot('05-study-word-phrases');
    await close();
    await page.getByRole('button', { name: '返回首页', exact: true }).click();
    return { word, progressUnchanged: true };
  });
  await check('offline reload restores previously opened phrase meanings', async () => {
    await page.evaluate(() => navigator.serviceWorker.ready.then(() => true));
    await page.waitForFunction(() => navigator.serviceWorker.controller !== null);
    const before = await state();
    await context.setOffline(true);
    await page.reload();
    await page.locator('.continue').waitFor();
    await openWord('because');
    await page.getByRole('heading', { name: 'because of', exact: true }).waitFor();
    assert.match(await page.locator('.phrase-body').innerText(), /due to/);
    assert.deepEqual(await state(), before);
    await shot('06-offline-because');
    await close();
    await context.setOffline(false);
    return { networkDisabled: true, cachedChineseAndSubstitutes: true, progressUnchanged: true };
  });
  await page.setViewportSize({ width: 1440, height: 1000 });
  await openWord('way'); await page.locator('.phrase-item').first().waitFor(); await shot('07-desktop-phrases');
  assert.equal(report.requests.filter(raw => /\/sources\//.test(raw)).length, 0);
  const chunks = new Set(report.requests.map(raw => new URL(raw).pathname).filter(file => /\/[a-z]\.json$/.test(file)));
  assert.ok(chunks.size <= 4);
  assert.deepEqual(report.pageErrors, []);
  report.passed = true;
} catch (error) {
  report.passed = false; report.failure = { message: error.message, stack: error.stack }; process.exitCode = 1;
  await page.screenshot({ path: path.join(output, 'failure.png') }).catch(() => {});
  console.error(error);
} finally {
  report.finishedAt = new Date().toISOString();
  await writeFile(path.join(output, 'report.json'), JSON.stringify(report, null, 2));
  await browser.close(); console.log(JSON.stringify({ passed: report.passed, output }));
}
