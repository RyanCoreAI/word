import assert from 'node:assert/strict';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { chromium } from 'playwright';

// Use a fresh browser profile. This never reads or modifies a user's real profile.
const baseUrl = process.env.QA_BASE_URL ?? 'http://127.0.0.1:5173';
const outputDir = resolve(process.env.QA_OUTPUT_DIR ?? 'outputs/browser-qa');
const report = { baseUrl, startedAt: new Date().toISOString(), checks: [], screenshots: [], pageErrors: [], consoleErrors: [], failedRequests: [], limitations: [] };
await mkdir(outputDir, { recursive: true });
const browser = await chromium.launch({ channel: process.env.QA_BROWSER_CHANNEL ?? 'chrome', headless: true });
let page;
let step = 'boot';
const delay = ms => new Promise(done => setTimeout(done, ms));
const check = (name, details = {}) => { report.checks.push({ name, passed: true, ...details }); console.log(`PASS ${name}`); };

function watch(target, label) {
  target.on('pageerror', error => report.pageErrors.push({ label, message: error.message }));
  target.on('console', message => { if (message.type() === 'error') report.consoleErrors.push({ label, text: message.text(), location: message.location() }); });
  target.on('requestfailed', request => report.failedRequests.push({ label, url: request.url(), error: request.failure()?.errorText }));
  target.setDefaultTimeout(20_000);
}

async function state(target = page) {
  return target.evaluate(() => new Promise((done, fail) => {
    const opening = indexedDB.open('yanxai-word-v1');
    opening.onerror = () => fail(opening.error?.message);
    opening.onsuccess = () => {
      const db = opening.result;
      const tx = db.transaction('state', 'readonly');
      const request = tx.objectStore('state').get('current');
      request.onsuccess = () => done(request.result);
      request.onerror = () => fail(request.error?.message);
      tx.oncomplete = () => db.close();
    };
  }));
}

async function waitState(predicate, target = page) {
  const deadline = Date.now() + 15_000;
  while (Date.now() < deadline) {
    const value = await state(target);
    if (predicate(value)) return value;
    await delay(50);
  }
  throw new Error(`State condition timed out during ${step}`);
}

async function click(name, options = {}) {
  // Separate intentional actions from the deliberate rapid-click regression checks.
  await delay(350);
  await page.getByRole('button', { name, exact: true, ...options }).click();
}

async function nav(name) {
  await page.getByRole('navigation', { name: '主导航' }).getByRole('button', { name, exact: true }).click();
}

async function home() {
  if (await page.getByRole('button', { name: '返回首页', exact: true }).count()) await click('返回首页');
  else await nav('学习');
}

async function snapshot(name, target = page) {
  await target.evaluate(() => document.fonts.ready);
  await target.locator('.word-zone,.listen-zone').evaluateAll(nodes => Promise.all(nodes.flatMap(node => node.getAnimations().map(animation => animation.finished.catch(() => undefined)))));
  const layout = await target.evaluate(() => ({
    viewport: innerWidth,
    scrollWidth: document.documentElement.scrollWidth,
    scrollY,
    wordAnchor: (() => {
      const rect = document.querySelector('h2.word')?.getBoundingClientRect();
      return rect ? { x: rect.x, y: rect.y, width: rect.width, height: rect.height } : null;
    })(),
    actionsBox: (() => {
      const rect = document.querySelector('.actions')?.getBoundingClientRect();
      return rect ? { x: rect.x, y: rect.y, width: rect.width, height: rect.height } : null;
    })(),
    offending: [...document.querySelectorAll('body *')].filter(node => {
      const rect = node.getBoundingClientRect();
      return rect.width && (rect.right > innerWidth + 1 || rect.left < -1) && getComputedStyle(node).position !== 'absolute';
    }).slice(0, 8).map(node => ({ tag: node.tagName, class: node.className, text: node.textContent?.slice(0, 100) })),
  }));
  const file = resolve(outputDir, `${name}.png`);
  await target.screenshot({ path: file, fullPage: true, animations: 'disabled' });
  report.screenshots.push({ name, file, layout });
  assert.ok(layout.scrollWidth <= layout.viewport + 1, `${name} has horizontal overflow: ${JSON.stringify(layout)}`);
}

async function boot(target, captureWelcome = false) {
  await target.goto(baseUrl, { waitUntil: 'networkidle' });
  await target.getByRole('button', { name: '下载词库并开始', exact: true }).waitFor();
  if (captureWelcome) await snapshot('00-mobile-welcome', target);
  await target.getByRole('button', { name: '下载词库并开始', exact: true }).click();
  // The welcome screen also has the same h1; navigation proves data boot completed.
  await target.getByRole('navigation', { name: '主导航' }).waitFor({ timeout: 60_000 });
  assert.equal(await target.getByRole('alert').count(), 0);
}

function semantic(value) {
  const { revision: _revision, updatedAt: _updatedAt, ...rest } = value;
  return rest;
}

try {
  const mobile = await browser.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 1, acceptDownloads: true, isMobile: true, hasTouch: true });
  page = await mobile.newPage();
  watch(page, 'mobile');
  await boot(page, true);
  const manifestResponse = await page.request.get(`${baseUrl}/data/manifest.json`);
  assert.equal(manifestResponse.status(), 200);
  const manifest = await manifestResponse.json();
  const initial = await state();
  assert.equal(initial.dictionaryVersion, manifest.version);
  assert.ok(manifest.studyCount > 10_000, 'The learning pack must contain real full study data');
  report.dictionary = { version: manifest.version, total: manifest.total, studyCount: manifest.studyCount, shards: manifest.shards.length };
  check('real dictionary first download and persistent initial state', report.dictionary);
  await snapshot('01-mobile-home');

  step = 'empty wordbook';
  await nav('生词本');
  await page.getByText('还没有生词。开始学习后，点过「不认识」的词会留在这里。', { exact: true }).waitFor();
  await snapshot('02-mobile-wordbook-empty');
  check(step);
  await home();

  step = 'look hidden and unknown rapid double click';
  await page.getByRole('button', { name: /^看词记忆/ }).click();
  await page.locator('.mask').waitFor();
  const beforeUnknown = await state();
  const firstId = beforeUnknown.modes.look.session.items[0];
  assert.equal(await page.locator('h2.word').innerText(), firstId);
  assert.equal(await page.locator('.meaning').count(), 0);
  // Capture both states at the same scroll position used for the actual click.
  await page.getByRole('button', { name: '不认识', exact: true }).scrollIntoViewIfNeeded();
  await snapshot('03-mobile-look-hidden');
  await page.getByRole('button', { name: '不认识', exact: true }).dblclick({ delay: 25 });
  const afterUnknown = await waitState(s => s.modes.look.session.revealed);
  await delay(400);
  assert.equal((await state()).history.length, beforeUnknown.history.length + 1);
  assert.equal(afterUnknown.modes.look.progress[firstId].wrongCount, 1);
  assert.equal(afterUnknown.modes.look.progress[firstId].seenCount, 1);
  await page.locator('.meaning').waitFor();
  await snapshot('04-mobile-look-revealed');
  check(step, { word: firstId, wrongCount: 1 });

  step = 'reload resumes revealed answer';
  await page.reload({ waitUntil: 'networkidle' });
  await page.getByRole('navigation', { name: '主导航' }).waitFor();
  await page.getByRole('button', { name: /^继续上次进度/ }).click();
  await page.locator('.meaning').waitFor();
  assert.equal(await page.locator('h2.word').innerText(), firstId);
  assert.deepEqual((await state()).modes.look, afterUnknown.modes.look);
  check(step);

  step = 'next word and known rapid double click';
  await click('下一个');
  const beforeKnown = await waitState(s => s.modes.look.session.cursor === 1 && !s.modes.look.session.revealed);
  const knownId = beforeKnown.modes.look.session.items[1];
  await delay(350);
  await page.getByRole('button', { name: '认识', exact: true }).dblclick({ delay: 25 });
  const afterKnown = await waitState(s => s.modes.look.session.cursor > 1);
  await delay(400);
  assert.equal((await state()).modes.look.session.cursor, 2);
  assert.equal(afterKnown.history.length, beforeKnown.history.length + 1);
  assert.equal(afterKnown.modes.look.progress[knownId].rightCount, 1);
  assert.equal(Object.keys(afterKnown.modes.look.progress).length, 2);
  check(step, { word: knownId, cursor: 2 });

  step = 'undo restores exact previous learning position';
  await page.getByLabel('学习操作', { exact: true }).click();
  await click('撤销上一操作');
  const undone = await waitState(s => s.modes.look.session.cursor === 1);
  assert.deepEqual(undone.modes, beforeKnown.modes);
  assert.deepEqual(undone.history, beforeKnown.history);
  check(step);

  step = 'permanent skip and restore';
  await page.getByLabel('学习操作', { exact: true }).click();
  await click('太简单，长期跳过');
  const skipped = await waitState(s => s.skipped.includes(knownId));
  assert.deepEqual(skipped.modes.look.progress, undone.modes.look.progress);
  await home();
  await nav('生词本');
  await click('已跳过');
  await page.locator('.wl .it').filter({ hasText: knownId }).click();
  await page.getByRole('dialog', { name: '单词详情' }).waitFor();
  await click('恢复这个词');
  await waitState(s => !s.skipped.includes(knownId));
  await page.getByText('还没有长期跳过的词。', { exact: true }).waitFor();
  check(step, { word: knownId });
  await click('全部生词');
  await page.locator('.wl .it').filter({ hasText: firstId }).waitFor();
  await snapshot('05-mobile-wordbook');

  step = 'settings persistence';
  await nav('设置');
  await click('10');
  await waitState(s => s.settings.groupSize === 10);
  await click('四级');
  await waitState(s => s.settings.deck === 'cet4');
  await page.getByRole('switch', { name: '过滤基础词' }).click();
  await waitState(s => s.settings.skipBasic === false);
  await page.getByLabel('语速', { exact: true }).selectOption('0.65');
  const changedSettings = await waitState(s => s.settings.rate === 0.65);
  const license = page.getByRole('link', { name: '词典许可', exact: true });
  const licenseResponse = await page.request.get(await license.getAttribute('href'));
  assert.equal(licenseResponse.status(), 200);
  assert.match(await licenseResponse.text(), /MIT License/);
  await snapshot('06-mobile-settings');
  await page.reload({ waitUntil: 'networkidle' });
  await page.getByRole('navigation', { name: '主导航' }).waitFor();
  assert.deepEqual((await state()).settings, changedSettings.settings);
  check(step, { settings: changedSettings.settings, licenseStatus: licenseResponse.status() });

  step = 'independent listening mode and actual device audio';
  const lookBeforeListen = (await state()).modes.look;
  await page.getByRole('button', { name: /^听音辨词/ }).click();
  await page.getByText('拼写和释义已隐藏', { exact: true }).waitFor();
  const listening = await state();
  assert.deepEqual(listening.modes.look, lookBeforeListen);
  assert.deepEqual(listening.modes.listen.progress, {});
  assert.equal(await page.locator('h2.word').count(), 0);
  const voices = await page.evaluate(() => 'speechSynthesis' in window ? speechSynthesis.getVoices().map(v => ({ name: v.name, lang: v.lang, localService: v.localService })) : null);
  report.audio = { supported: voices !== null, voices, audibleQualityTested: false };
  await page.waitForFunction(() => !!document.querySelector('.audio-error') || !document.querySelector('button.btn.good')?.disabled, { timeout: 12_000 });
  await snapshot('07-mobile-listening');
  if (await page.locator('.audio-error').count()) {
    assert.equal(await page.getByRole('button', { name: '认识', exact: true }).isDisabled(), true);
    assert.equal(await page.getByRole('button', { name: '不认识', exact: true }).isDisabled(), true);
    const beforeDefer = await state();
    report.audio.failure = await page.locator('.audio-error').innerText();
    await page.locator('.audio-error > summary').click();
    await click('跳过本次');
    const deferred = await waitState(s => s.modes.listen.session.cursor === beforeDefer.modes.listen.session.cursor + 1);
    assert.deepEqual(deferred.modes.listen.progress, beforeDefer.modes.listen.progress);
    assert.deepEqual(deferred.modes.look, beforeDefer.modes.look);
    assert.deepEqual(deferred.skipped, beforeDefer.skipped);
    check('unavailable audio disables answering; temporary skip preserves counts');
  } else {
    report.audio.failurePath = 'Not exercised: the application confirmed actual playback. Audibility and pronunciation quality require human listening; the separate audio smoke test identifies media events and source.';
  }
  check(step);

  step = 'backup export, invalid import, confirmation, atomic restore';
  await home();
  await nav('设置');
  const downloadEvent = page.waitForEvent('download');
  await click('导出完整备份');
  const download = await downloadEvent;
  const backupFile = resolve(outputDir, 'qa-backup.json');
  try {
    await download.saveAs(backupFile);
    report.backupDownload = { savedByBrowser: true };
  } catch (error) {
    // Some managed Chrome environments cancel even a minimal JSON Blob download.
    // Preserve the exact UI-generated Blob for round-trip tests; never fabricate a backup.
    if (!download.url().startsWith('blob:')) throw error;
    const raw = await page.evaluate(async url => (await fetch(url)).text(), download.url());
    await writeFile(backupFile, raw);
    report.backupDownload = { savedByBrowser: false, error: error.message, artifact: 'Exact UI-generated Blob fetched before revocation' };
    report.limitations.push('Native download-to-disk was canceled by this Chrome environment; only actual exported Blob content and import/restore were verified.');
  }
  const backup = JSON.parse(await readFile(backupFile, 'utf8'));
  const exportedState = await state();
  assert.deepEqual(backup.state, exportedState);
  await page.getByLabel('选择学习备份文件', { exact: true }).setInputFiles({ name: 'invalid.json', mimeType: 'application/json', buffer: Buffer.from('{"format":"yanxai-word-backup","version":1,"state":{}}') });
  await page.getByRole('alert').waitFor();
  assert.deepEqual(await state(), exportedState);
  assert.equal(await page.getByRole('dialog').count(), 0);
  await click('30');
  const modified = await waitState(s => s.settings.groupSize === 30);
  await page.getByLabel('选择学习备份文件', { exact: true }).setInputFiles(backupFile);
  await page.getByRole('dialog', { name: '恢复学习备份' }).waitFor();
  assert.deepEqual(await state(), modified, 'Previewing a backup must not mutate state');
  await snapshot('08-mobile-backup-confirmation');
  await click('确认恢复备份');
  const restored = await waitState(s => s.revision > modified.revision && s.settings.groupSize === exportedState.settings.groupSize);
  assert.deepEqual(semantic(restored), semantic(exportedState));
  await page.getByRole('navigation', { name: '主导航' }).waitFor();
  check(step, { exportedRevision: exportedState.revision, modifiedRevision: modified.revision, restoredRevision: restored.revision });
  await snapshot('09-mobile-restored-home');

  if (await page.getByRole('navigation', { name: '主导航' }).count()) {
    await nav('设置');
    if (await page.getByRole('button', { name: '文本备份', exact: true }).count()) {
      step = 'text backup and paste restore fallback';
      await click('文本备份');
      await page.getByRole('dialog', { name: '完整备份文本', exact: true }).waitFor();
      const exportedText = await page.getByLabel('完整备份 JSON', { exact: true }).inputValue();
      const textState = await state();
      assert.deepEqual(JSON.parse(exportedText).state, textState);
      await snapshot('16-mobile-text-backup');
      await click('关闭弹窗');
      await click('30');
      const textModified = await waitState(s => s.settings.groupSize === 30);
      await click('粘贴备份恢复');
      await page.getByLabel('粘贴完整备份 JSON', { exact: true }).fill(exportedText);
      await click('校验并预览恢复');
      await page.getByRole('dialog', { name: '恢复学习备份', exact: true }).waitFor();
      assert.deepEqual(await state(), textModified);
      await click('确认恢复备份');
      const textRestored = await waitState(s => s.revision > textModified.revision && s.settings.groupSize === textState.settings.groupSize);
      assert.deepEqual(semantic(textRestored), semantic(textState));
      check(step, { clipboardUntouched: true });
    }
  }

  step = 'desktop real data and responsive layout';
  const desktop = await browser.newContext({ viewport: { width: 1440, height: 1000 }, deviceScaleFactor: 1, acceptDownloads: true });
  page = await desktop.newPage();
  watch(page, 'desktop');
  await boot(page);
  await snapshot('10-desktop-home');
  await page.getByRole('button', { name: /^看词记忆/ }).click();
  await page.locator('.mask').waitFor();
  await page.getByRole('button', { name: '不认识', exact: true }).scrollIntoViewIfNeeded();
  await snapshot('11-desktop-look-hidden');
  await click('不认识');
  await page.locator('.meaning').waitFor();
  await snapshot('12-desktop-look-revealed');
  await home();
  await nav('设置');
  await snapshot('13-desktop-settings');
  check(step);

  step = 'real ten-word group summary and word details';
  const summaryContext = await browser.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 1, isMobile: true, hasTouch: true });
  page = await summaryContext.newPage();
  watch(page, 'mobile-summary');
  await boot(page);
  await nav('设置');
  await click('10');
  await waitState(s => s.settings.groupSize === 10);
  await home();
  await page.getByRole('button', { name: /^看词记忆/ }).click();
  await page.locator('.mask').waitFor();
  const summaryStart = await state();
  const reviewWord = summaryStart.modes.look.session.items[0];
  assert.equal(summaryStart.modes.look.session.items.length, 10);
  await click('不认识');
  await page.locator('.meaning').waitFor();
  await click('下一个');
  for (let cursor = 1; cursor < 10; cursor += 1) {
    await waitState(s => s.modes.look.session.cursor === cursor);
    await click('认识');
  }
  const summaryState = await waitState(s => s.modes.look.session.status === 'finished');
  assert.equal(summaryState.modes.look.session.known, 9);
  assert.equal(summaryState.modes.look.session.unknown, 1);
  assert.equal(summaryState.modes.look.progress[reviewWord].wrongCount, 1);
  await page.getByRole('heading', { name: '第 1 组完成', exact: true }).waitFor();
  await snapshot('14-mobile-group-summary');
  await page.locator('.wl .it').filter({ hasText: reviewWord }).click();
  await page.getByRole('dialog', { name: '单词详情', exact: true }).waitFor();
  await snapshot('15-mobile-word-details');
  check(step, { known: 9, unknown: 1, reviewWord });
  step = 'reveal matches the original Claude geometry';
  for (const device of ['mobile', 'desktop']) {
    const hidden = report.screenshots.find(s => s.name.endsWith(`${device}-look-hidden`)).layout;
    const revealed = report.screenshots.find(s => s.name.endsWith(`${device}-look-revealed`)).layout;
    // The original board1 normalized at 390x844 has word y=250 -> 252:
    // hidden reading line and revealed after row differ by 4px in total height.
    // Retain that source geometry instead of adding the bulky fixed placeholders
    // rejected by the user. Measure only after the real 180ms entry has finished.
    assert.ok(Math.abs(hidden.wordAnchor.x - revealed.wordAnchor.x) <= 1 && Math.abs((revealed.wordAnchor.y - hidden.wordAnchor.y) - 2) <= 1,
      `${device} word differs from original geometry: ${JSON.stringify({ hidden: hidden.wordAnchor, revealed: revealed.wordAnchor })}`);
    assert.ok(Math.abs(hidden.actionsBox.y - revealed.actionsBox.y) <= 1,
      `${device} answer actions moved: ${JSON.stringify({ hidden: hidden.actionsBox, revealed: revealed.actionsBox })}`);
    check(`${step} (${device})`, { hidden: hidden.wordAnchor, revealed: revealed.wordAnchor, actionsBefore: hidden.actionsBox, actionsAfter: revealed.actionsBox });
  }
  assert.deepEqual(report.pageErrors, []);
  const applicationConsoleErrors = report.consoleErrors.filter(error => !error.location?.url?.endsWith('/favicon.ico'));
  assert.deepEqual(applicationConsoleErrors, []);
  if (report.consoleErrors.length) report.limitations.push('Browser requested a missing /favicon.ico; recorded separately from application JavaScript errors.');
  check('no browser page errors or application console errors', { faviconErrors: report.consoleErrors.length - applicationConsoleErrors.length });
  report.passed = true;
} catch (error) {
  report.passed = false;
  report.failure = { step, message: error.message, stack: error.stack };
  if (page) {
    try { await snapshot('failure'); } catch { /* Keep the first failure. */ }
    try { report.failure.state = await state(); } catch { /* Browser may have closed. */ }
  }
  process.exitCode = 1;
  console.error(`FAIL ${step}: ${error.stack}`);
} finally {
  report.finishedAt = new Date().toISOString();
  await writeFile(resolve(outputDir, 'report.json'), `${JSON.stringify(report, null, 2)}\n`);
  await browser.close();
  console.log(`Report: ${resolve(outputDir, 'report.json')}`);
}
