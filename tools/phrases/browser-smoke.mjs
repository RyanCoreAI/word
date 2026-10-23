import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';

const root = fileURLToPath(new URL('../../', import.meta.url));
const url = process.env.WORD_QA_URL ?? 'http://127.0.0.1:4173/';
const output = path.resolve(process.env.WORD_PHRASES_OUTPUT ?? path.join(root, '../../outputs/word-corrections/browser'));
await mkdir(output, { recursive: true });
const report = { startedAt: new Date().toISOString(), url, checks: [], requests: [], pageErrors: [], limitations: ['Chrome touch viewport does not establish physical Android acceptance. No natural article-voice quality is claimed.'] };
const browser = await chromium.launch({ channel: 'chrome', headless: true });
const context = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, serviceWorkers: 'allow' });
const page = await context.newPage(); page.setDefaultTimeout(30_000);
page.on('pageerror', error => report.pageErrors.push(error.message));
page.on('request', request => { if (new URL(request.url()).pathname.startsWith('/phrases/')) report.requests.push(request.url()); });
const state = () => page.evaluate(() => new Promise((resolve, reject) => {
  const opening = indexedDB.open('yanxai-word-v1'); opening.onerror = () => reject(opening.error?.message);
  opening.onsuccess = () => { const db = opening.result; const tx = db.transaction('state'); const read = tx.objectStore('state').get('current'); read.onsuccess = () => resolve(read.result); tx.oncomplete = () => db.close(); };
}));
async function check(name, action) { const detail = await action(); report.checks.push({ name, status: 'passed', detail }); console.log(JSON.stringify({ name, detail })); }
async function shot(name) { await page.evaluate(() => document.fonts.ready.then(() => true)); await page.screenshot({ path: path.join(output, name + '.png'), animations: 'disabled' }); }
const nav = label => page.getByRole('navigation', { name: '主导航' }).getByRole('button', { name: label, exact: true }).click();
const search = () => page.getByRole('searchbox', { name: '搜索词典 · 输入英文单词', exact: true });
async function openWord(word, hasCollocations = true) {
  await search().fill(word);
  await page.locator('.home-search-results .it').filter({ hasText: new RegExp('^' + word + '\\b') }).first().click();
  await page.getByRole('dialog', { name: '单词详情', exact: true }).waitFor();
  if (hasCollocations) await page.getByRole('button', { name: '常用搭配', exact: true }).click();
}
const close = () => page.getByRole('button', { name: '关闭弹窗', exact: true }).click();
try {
  await page.goto(url); await page.getByRole('button', { name: '下载词库并开始', exact: true }).click(); await page.locator('.continue').waitFor();
  await check('mobile X clears query and pending results, restores focus and has a 44px target', async () => {
    const before = await state();
    assert.equal(await page.getByRole('button', { name: '清空搜索', exact: true }).count(), 0);
    await search().fill('beneficial');
    const clear = page.getByRole('button', { name: '清空搜索', exact: true }); const box = await clear.boundingBox();
    assert.ok(box.width >= 44 && box.height >= 44); await shot('01-mobile-search'); await clear.click();
    assert.equal(await search().inputValue(), ''); assert.ok(await search().evaluate(element => element === document.activeElement));
    await page.waitForTimeout(400); assert.equal(await page.locator('.home-search-results').count(), 0); assert.equal(await clear.count(), 0);
    assert.deepEqual(await state(), before); return { touchTarget: box, query: '', focusKept: true, noStaleResults: true, progressUnchanged: true };
  });
  await check('beneficial has useful for/to collocations with Chinese meanings and sources', async () => {
    const before = await state(); await openWord('beneficial');
    await page.getByRole('heading', { name: 'be beneficial for', exact: true }).waitFor();
    assert.match(await page.locator('.phrase-body').innerText(), /be beneficial to/); assert.match(await page.locator('.phrase-body').innerText(), /有益/);
    assert.equal(await page.locator('.word-sense, .phrase-substitutes').count(), 0);
    for (const href of await page.locator('.phrase-source').evaluateAll(elements => elements.map(element => element.href))) assert.ok(/^https:\/\/(dictionary.cambridge.org|www.oxfordlearnersdictionaries.com)\//.test(href));
    await shot('02-beneficial-mobile'); await page.setViewportSize({ width: 1440, height: 1000 }); await shot('02-beneficial-desktop'); await page.setViewportSize({ width: 390, height: 844 });
    assert.deepEqual(await state(), before); await close(); return { headword: 'beneficial', exactPatterns: ['be beneficial for', 'be beneficial to'], oldSynonyms: 0, progressUnchanged: true };
  });
  await check('figure shows figure out rather than incidental compounds', async () => {
    await openWord('figure'); await page.getByRole('heading', { name: 'figure out', exact: true }).waitFor();
    assert.match(await page.locator('.phrase-body').innerText(), /弄清|理解|解决/); assert.doesNotMatch(await page.locator('.phrase-body').innerText(), /skating|figurehead/);
    await shot('03-figure-out'); await close(); return { headword: 'figure', exactPattern: 'figure out', incidentalCompounds: 0 };
  });
  await check('unreviewed words expose no phrase filler or empty supplement panel', async () => {
    await openWord('abandon', false); assert.equal(await page.locator('.phrase-section').count(), 0);
    assert.equal(await page.locator('.word-sense, .phrase-substitutes').count(), 0); await close(); return { headword: 'abandon', supplementPanels: 0 };
  });
  await check('desktop dictionary and vocabulary searches both clear using mouse or keyboard', async () => {
    await page.setViewportSize({ width: 1440, height: 1000 }); await search().fill('figure'); await page.locator('.home-search-results .it').first().waitFor();
    const clear = page.getByRole('button', { name: '清空搜索', exact: true }); await clear.focus(); await page.keyboard.press('Enter');
    assert.equal(await search().inputValue(), ''); assert.ok(await search().evaluate(element => element === document.activeElement)); await shot('04-desktop-cleared-search');
    await nav('生词本'); const field = page.getByRole('searchbox', { name: '搜索单词或中文', exact: true }); await field.fill('hello'); await clear.click(); assert.equal(await field.inputValue(), ''); assert.ok(await field.evaluate(element => element === document.activeElement));
    await nav('学习'); await page.setViewportSize({ width: 390, height: 844 }); return { homeKeyboardClear: true, vocabularyMouseClear: true, focusKept: true };
  });
  await check('article flow offers reading and spoken retelling without rejected synthetic narration', async () => {
    const before = await state(); await nav('复述'); assert.equal(await page.getByRole('button', { name: '听短文', exact: true }).count(), 0);
    await page.getByRole('button', { name: '开始这篇', exact: false }).click(); await page.locator('.retell-passage').waitFor();
    assert.equal(await page.getByRole('button', { name: /播放全文|听音频|停止朗读全文/ }).count(), 0); assert.equal(await page.locator('.retell-passage p').count(), 3);
    await shot('05-reader-mobile'); await page.setViewportSize({ width: 1440, height: 1000 }); await shot('05-reader-desktop'); await page.setViewportSize({ width: 390, height: 844 });
    await page.getByRole('button', { name: '隐藏原文，开始复述', exact: false }).click(); await page.locator('.retell-speaking').waitFor(); assert.equal(await page.locator('.retell-passage').count(), 0);
    assert.equal(await page.getByRole('button', { name: '开始语音复述', exact: true }).count(), 1); assert.equal(await page.locator('textarea').count(), 0);
    assert.deepEqual(await state(), before); await nav('学习'); return { articleTtsEntries: 0, originalParagraphs: 3, spokenRetellAvailable: true, vocabularyProgressUnchanged: true };
  });
  await check('reviewed but never opened collocations work after offline reload', async () => {
    await page.evaluate(() => navigator.serviceWorker.ready.then(() => true)); await page.waitForFunction(() => navigator.serviceWorker.controller !== null);
    const before = await state(); await context.setOffline(true); await page.reload(); await page.locator('.continue').waitFor();
    await openWord('important'); assert.match(await page.locator('.phrase-body').innerText(), /be important/); assert.match(await page.locator('.phrase-body').innerText(), /重要/);
    assert.deepEqual(await state(), before); await shot('06-offline-new-headword'); await close(); await context.setOffline(false);
    assert.deepEqual(report.requests, []); return { previouslyUnopenedHeadword: 'important', offlineAvailable: true, oldLexicalRequests: 0, progressUnchanged: true };
  });
  assert.deepEqual(report.pageErrors, []); report.passed = true;
} catch (error) { report.passed = false; report.failure = { message: error.message, stack: error.stack }; process.exitCode = 1; await page.screenshot({ path: path.join(output, 'failure.png') }).catch(() => {}); console.error(error); }
finally { report.finishedAt = new Date().toISOString(); await writeFile(path.join(output, 'report.json'), JSON.stringify(report, null, 2)); await browser.close(); console.log(JSON.stringify({ passed: report.passed, output })); }
