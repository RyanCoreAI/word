import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium, devices } from 'playwright';

const root = fileURLToPath(new URL('../', import.meta.url));
const url = process.env.WORD_QA_URL ?? 'http://127.0.0.1:4173/';
const output = path.resolve(process.env.WORD_QA_OUTPUT ?? path.join(root, '../../outputs/word-experience'));
await mkdir(output, { recursive: true });
const report = { startedAt: new Date().toISOString(), url, device: 'Pixel 7 Chrome emulation; not a physical Android device', checks: [], pageErrors: [], audioRequests: [] };
const browser = await chromium.launch({ channel: 'chrome', headless: true });
const context = await browser.newContext({ ...devices['Pixel 7'], timezoneId: 'America/Tijuana', serviceWorkers: 'allow' });
const page = await context.newPage();
page.setDefaultTimeout(25_000);
page.on('pageerror', error => report.pageErrors.push(error.message));
page.on('request', request => { if (new URL(request.url()).pathname.startsWith('/audio/')) report.audioRequests.push(request.url()); });
const state = () => page.evaluate(() => new Promise((resolve, reject) => {
  const request = indexedDB.open('yanxai-word-v1');
  request.onerror = () => reject(request.error?.message);
  request.onsuccess = () => {
    const db = request.result; const tx = db.transaction('state'); const read = tx.objectStore('state').get('current');
    read.onsuccess = () => resolve(read.result); tx.oncomplete = () => db.close();
  };
}));
async function waitState(predicate) {
  const start = Date.now();
  while (Date.now() - start < 15_000) { const saved = await state(); if (predicate(saved)) return saved; await page.waitForTimeout(40); }
  throw new Error('Persisted state did not reach expected result');
}
async function check(name, run) { const detail = await run(); report.checks.push({ name, status: 'passed', detail }); console.log(JSON.stringify({ name, status: 'passed', detail })); }
async function shot(name) { await documentFonts(); await page.screenshot({ path: path.join(output, `${name}.png`), animations: 'disabled' }); }
async function documentFonts() { await page.evaluate(() => document.fonts.ready.then(() => true)); }
async function nav(name) { await page.getByRole('navigation', { name: '主导航' }).getByRole('button', { name, exact: true }).click(); }
async function home() { await page.getByRole('button', { name: '返回首页', exact: true }).click(); }
let today;
let first;
try {
  await page.goto(url);
  await page.getByRole('button', { name: '下载词库并开始', exact: true }).click();
  await page.locator('.continue').waitFor();
  await check('opening blue ring animates once and respects independent mode controls', async () => {
    const startup = await page.locator('.ring').evaluate(element => ({ className: element.className, color: getComputedStyle(element.querySelector('circle:nth-child(2)')).stroke, animation: getComputedStyle(element.querySelector('svg')).animationName }));
    assert.equal(startup.color, 'rgb(59, 79, 216)');
    assert.equal(startup.animation, 'ring-turn');
    await page.waitForTimeout(1150);
    assert.equal(await page.locator('.ring').evaluate(element => element.classList.contains('ring-intro')), false);
    assert.equal(await page.getByRole('button', { name: '查看看词进度', exact: true }).getAttribute('aria-pressed'), 'true');
    return startup;
  });
  await shot('01-android-home');
  await check('dictionary search works from home without requiring full dictionary', async () => {
    await page.getByRole('searchbox', { name: '搜索词典 · 输入英文单词', exact: true }).fill('elaborate');
    const result = page.locator('.home-search-results .it').filter({ hasText: 'elaborate' }).first();
    await result.click();
    await page.getByRole('dialog', { name: '单词详情' }).waitFor();
    await page.locator('.dialog .meaning').waitFor();
    await shot('02-android-search-details');
    await page.getByRole('button', { name: '关闭弹窗', exact: true }).click();
    await page.getByRole('button', { name: '收起', exact: true }).click();
    return { word: 'elaborate', realStudyDictionary: true };
  });
  await nav('设置');
  await page.getByRole('button', { name: '10', exact: true }).click();
  await page.getByRole('switch', { name: '自动朗读', exact: true }).click();
  await waitState(value => value.settings.groupSize === 10 && !value.settings.autoSpeak);
  await nav('学习');
  await page.getByRole('button', { name: /^看词记忆/ }).click();
  first = (await state()).modes.look.session.items[0];
  await check('unknown reveals immediately and first known previews meaning once before advancing', async () => {
    await page.getByRole('button', { name: '不认识', exact: true }).click();
    await page.locator('.meaning').waitFor();
    const revealed = await waitState(value => value.modes.look.session.revealed);
    assert.equal(revealed.modes.look.progress[first].wrongCount, 1);
    await page.waitForTimeout(350);
    await page.getByRole('button', { name: '下一个', exact: true }).click();
    await waitState(value => value.modes.look.session.cursor === 1);
    const before = await page.locator('h2.word').innerText();
    await page.waitForTimeout(350);
    const button = page.getByRole('button', { name: '认识', exact: true });
    const box = await button.boundingBox();
    const scale = await page.evaluate(() => visualViewport.scale);
    await page.touchscreen.tap(box.x + box.width / 2, box.y + box.height / 2);
    await page.touchscreen.tap(box.x + box.width / 2, box.y + box.height / 2);
    await page.locator('.known-confirmation').waitFor();
    await page.locator('.meaning').waitFor();
    assert.equal(await page.locator('h2.word').innerText(), before);
    const saved = await waitState(value => value.modes.look.session.cursor === 2);
    assert.equal(saved.modes.look.session.known, 1, 'Rapid second tap cannot answer the following word');
    assert.equal(await page.evaluate(() => visualViewport.scale), scale);
    await shot('03-android-first-known-meaning');
    await page.locator('.known-confirmation').waitFor({ state: 'detached' });
    assert.notEqual(await page.locator('h2.word').innerText(), before);
    return { previewMilliseconds: 1100, persistedKnown: 1, repeatedTouchDoesNotZoomOrDoubleAnswer: true };
  });
  for (let cursor = 2; cursor < 10; cursor++) {
    await page.getByRole('button', { name: '认识', exact: true }).click();
    await waitState(value => value.modes.look.session.cursor === cursor + 1);
    await page.locator('.known-confirmation').waitFor({ state: 'detached' });
  }
  await check('previously seen review known advances without meaning preview', async () => {
    await page.getByRole('button', { name: '开始下一组', exact: true }).click();
    await waitState(value => value.modes.look.groupNumber === 2);
    assert.equal((await state()).modes.look.session.items[0], first);
    await page.getByRole('button', { name: '认识', exact: true }).click();
    const saved = await waitState(value => value.modes.look.session.cursor === 1);
    assert.equal(await page.locator('.known-confirmation').count(), 0);
    assert.equal(saved.modes.look.progress[first].streak, 1);
    today = Object.keys(saved.dailyActivity)[0];
    return { reviewStreak: 1, preview: false, date: today };
  });
  await check('calendar deduplicates and undo restores day counts', async () => {
    await page.waitForTimeout(350);
    await page.getByLabel('学习操作', { exact: true }).click();
    await page.getByRole('button', { name: '撤销上一操作', exact: true }).click();
    await waitState(value => value.modes.look.session.cursor === 0);
    await home();
    await page.locator('.calendar-day.today').click();
    await page.getByRole('dialog', { name: `${today} · 学习记录`, exact: true }).waitFor();
    assert.equal(await page.locator('.daily-word').count(), 10);
    assert.equal(await page.locator('.daily-summary strong').innerText(), '10 个单词');
    assert.match(await page.locator('.daily-summary').innerText(), /当日不认识\s*1\s*次/);
    const saved = await state();
    assert.equal(saved.dailyActivity[today][first].look.known, 0);
    assert.equal(saved.dailyActivity[today][first].look.unknown, 1);
    assert.ok(await page.locator('.daily-word .zh').first().innerText());
    await shot('04-android-calendar-words');
    await page.getByRole('button', { name: '关闭弹窗', exact: true }).click();
    return { uniqueWords: 10, unknown: 1, undo: true, realMeanings: true };
  });
  await check('circle switches between actual independent look and listen progress', async () => {
    assert.match(await page.locator('.big-num').innerText(), /^9\s*\//);
    await page.getByRole('button', { name: '查看听音进度', exact: true }).click();
    assert.match(await page.locator('.big-num').innerText(), /^0\s*\//);
    await page.getByRole('button', { name: '查看看词进度', exact: true }).click();
    assert.match(await page.locator('.big-num').innerText(), /^9\s*\//);
    assert.equal(await page.locator('.ring-intro').count(), 0);
    await shot('05-android-home-calendar');
    return { lookCompleted: 9, listenCompleted: 0, noRepeatedIntro: true };
  });
  await check('small slash skips with one-time explanation and immediate undo', async () => {
    await page.getByRole('button', { name: /^看词记忆/ }).click();
    const before = await state();
    const id = before.modes.look.session.items[before.modes.look.session.cursor];
    const slash = page.getByRole('button', { name: '斩，长期跳过当前单词', exact: true });
    const geometry = await slash.evaluate(element => {
      const known = element.previousElementSibling;
      return { independent: element.parentElement.classList.contains('actions') && known.classList.contains('good'), gap: element.getBoundingClientRect().left - known.getBoundingClientRect().right, height: element.getBoundingClientRect().height };
    });
    assert.equal(geometry.independent, true);
    assert.ok(geometry.gap >= 8);
    assert.equal(geometry.height, 48);
    await shot('06-android-independent-slash');
    await page.locator('.actions').screenshot({ path: path.join(output, 'independent-slash-actions.png') });
    await slash.click();
    const skipped = await waitState(value => value.skipped.includes(id));
    assert.deepEqual(skipped.dailyActivity, before.dailyActivity);
    assert.deepEqual(skipped.modes.look.progress, before.modes.look.progress);
    assert.equal(skipped.settings.skipHintSeen, true);
    await page.getByText('斩：这个词太简单，今后跳过', { exact: true }).waitFor();
    await shot('06-android-first-slash');
    await page.getByRole('button', { name: '撤销斩', exact: true }).click();
    const restored = await waitState(value => !value.skipped.includes(id));
    assert.deepEqual(restored.modes, before.modes);
    assert.deepEqual(restored.dailyActivity, before.dailyActivity);
    assert.equal(restored.settings.skipHintSeen, true);
    await page.waitForTimeout(350);
    await slash.click();
    await waitState(value => value.skipped.includes(id));
    assert.equal(await page.getByText('斩：这个词太简单，今后跳过', { exact: true }).count(), 0);
    await page.getByRole('button', { name: '撤销斩', exact: true }).click();
    await waitState(value => !value.skipped.includes(id));
    await home();
    return { firstHelp: true, subsequentHelp: false, instantUndo: true, noAnswerOrCalendarCount: true, geometry };
  });
  await check('Android viewport fills screen and resized keyboard layout stays usable', async () => {
    assert.equal(await page.locator('.app-screen').evaluate(element => element.getBoundingClientRect().width), devices['Pixel 7'].viewport.width);
    await page.setViewportSize({ width: 360, height: 440 });
    const search = page.getByRole('searchbox', { name: '搜索词典 · 输入英文单词', exact: true });
    await search.fill('bank');
    const geometry = await page.evaluate(() => ({ width: innerWidth, scrollWidth: document.documentElement.scrollWidth, scale: visualViewport.scale, touch: getComputedStyle(document.documentElement).touchAction, meta: document.querySelector('meta[name="viewport"]').content }));
    assert.equal(geometry.scrollWidth, geometry.width);
    assert.equal(geometry.touch, 'manipulation');
    assert.match(geometry.meta, /interactive-widget=resizes-content/);
    assert.ok((await search.boundingBox()).y < 200);
    await shot('06-android-resized-viewport');
    await search.fill('');
    await page.setViewportSize({ width: 393, height: 851 });
    return { ...geometry, note: 'Layout resize emulation, not a physical keyboard or OS installation test' };
  });
  await check('offline reload retains calendar and learning progress', async () => {
    await page.evaluate(() => navigator.serviceWorker.ready.then(() => true));
    await page.waitForFunction(() => navigator.serviceWorker.controller !== null);
    const before = await state();
    await context.setOffline(true);
    await page.reload();
    await page.locator('.continue').waitFor();
    assert.deepEqual(await state(), before);
    await page.locator('.calendar-day.today').click();
    assert.equal(await page.locator('.daily-word').count(), 10);
    await shot('07-android-offline-calendar');
    await page.getByRole('button', { name: '关闭弹窗', exact: true }).click();
    await context.setOffline(false);
    return { exactStatePreserved: true, uniqueWords: 10 };
  });
  await page.setViewportSize({ width: 1440, height: 1000 });
  assert.equal(await page.locator('.app-screen').evaluate(element => element.getBoundingClientRect().width), 390);
  await shot('08-desktop-home');
  assert.deepEqual(report.pageErrors, []);
  assert.deepEqual(report.audioRequests, []);
  report.passed = true;
} catch (error) {
  report.passed = false; report.failure = { message: error.message, stack: error.stack }; process.exitCode = 1;
  await page.screenshot({ path: path.join(output, 'failure.png') }).catch(() => {});
  console.error(error);
} finally {
  report.finishedAt = new Date().toISOString();
  await writeFile(path.join(output, 'experience-report.json'), JSON.stringify(report, null, 2));
  await browser.close();
  console.log(JSON.stringify({ passed: report.passed, output }));
}
