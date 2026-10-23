import assert from 'node:assert/strict';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';

const root = fileURLToPath(new URL('../', import.meta.url));
const url = process.env.WORD_QA_URL ?? 'http://127.0.0.1:4173/';
const output = path.resolve(process.env.WORD_RETELL_OUTPUT ?? path.join(root, '../../outputs/word-retell/ui-browser'));
await mkdir(output, { recursive: true });
// Actual Chrome MediaRecorder receives a public speech fixture as its microphone
// input. Neither the recognizer nor the transcript/result is mocked. This does
// not establish physical Android microphone or speaker quality.
const fixture = path.join(root, 'work/asr/jfk.wav');
await readFile(fixture);
const report = { startedAt: new Date().toISOString(), url, device: 'Chrome; 390x844 touch viewport and 1440x1000 desktop; file microphone, not physical Android', checks: [], errors: [], asrRequests: [], thirdParty: [] };
const browser = await chromium.launch({ channel: 'chrome', headless: true, args: ['--use-fake-device-for-media-stream', `--use-file-for-fake-audio-capture=${fixture}`, '--autoplay-policy=no-user-gesture-required'] });
const context = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, permissions: ['microphone'], serviceWorkers: 'allow' });
const page = await context.newPage(); page.setDefaultTimeout(30_000);
page.on('pageerror', error => report.errors.push(error.message));
page.on('request', request => { const resource = new URL(request.url()); if (resource.pathname.startsWith('/asr/')) report.asrRequests.push(request.url()); if (resource.protocol.startsWith('http') && resource.origin !== new URL(url).origin) report.thirdParty.push(request.url()); });
const check = async (name, run) => { const detail = await run(); report.checks.push({ name, status: 'passed', detail }); console.log(JSON.stringify({ name, detail })); };
async function shot(name) { await page.evaluate(() => document.fonts.ready.then(() => true)); await page.screenshot({ path: path.join(output, name + '.png'), animations: 'disabled' }); }
async function navigate() { await page.getByRole('navigation', { name: '主导航', exact: true }).getByRole('button', { name: '复述', exact: true }).click(); await page.locator('.retell-library').waitFor(); }
async function readAttempts() { return page.evaluate(() => new Promise((resolve, reject) => { const request = indexedDB.open('yanxai-retell-v1'); request.onerror = () => reject(request.error?.message); request.onsuccess = () => { const db = request.result; const tx = db.transaction('attempts'); const read = tx.objectStore('attempts').getAll(); read.onsuccess = () => resolve(read.result.map(row => ({ ...row, audioBlob: { size: row.audioBlob.size, type: row.audioBlob.type } }))); tx.oncomplete = () => db.close(); }; })); }
async function recordAndFinish(offline = false) {
  await page.getByRole('button', { name: '开始语音复述', exact: true }).click();
  await page.getByText('正在录音', { exact: true }).waitFor({ timeout: 120_000 });
  assert.equal(await page.getByRole('navigation', { name: '主导航' }).count(), 0);
  if (!offline) {
    await page.waitForTimeout(1300); await page.getByRole('button', { name: '暂停', exact: true }).click();
    await page.getByText('已暂停录音', { exact: true }).waitFor();
    const value = await page.locator('.retell-timer').innerText(); await page.waitForTimeout(600); assert.equal(await page.locator('.retell-timer').innerText(), value);
    await page.getByRole('button', { name: '继续录音', exact: true }).click();
    await page.waitForTimeout(3500); await shot('04-recording-mobile');
    await page.setViewportSize({ width: 1440, height: 1000 }); await shot('04-recording-desktop'); await page.setViewportSize({ width: 390, height: 844 });
    await page.waitForTimeout(6500);
  } else await page.waitForTimeout(11_500);
  await page.getByRole('button', { name: '结束，查看对照', exact: true }).click();
  await page.locator('.retell-comparison').waitFor({ timeout: 180_000 });
  await page.getByText('已保存在本机', { exact: false }).waitFor();
  const rows = await readAttempts(); assert.equal(rows.length, 1); assert.ok(rows[0].audioBlob.size > 1000); assert.match(rows[0].transcript.toLowerCase(), /country/);
  return rows[0];
}
try {
  await page.goto(url); await page.getByRole('button', { name: '下载词库并开始', exact: true }).click(); await page.locator('.continue').waitFor();
  await navigate();
  await check('approved retell navigation and real editorial library load without ASR download', async () => {
    assert.equal(report.asrRequests.length, 0); assert.equal(await page.locator('.retell-article').count(), 4); assert.equal(await page.locator('textarea').count(), 0);
    const startBox = await page.getByRole('button', { name: '开始这篇', exact: false }).boundingBox(); assert.ok(startBox.y + startBox.height <= 844, 'Primary start action is visible without scrolling');
    await shot('01-library-mobile'); await page.setViewportSize({ width: 1440, height: 1000 }); await shot('01-library-desktop'); await page.setViewportSize({ width: 390, height: 844 });
    return { articles: 4, passiveAsrRequests: 0, keyboardRetell: false };
  });
  await page.getByRole('button', { name: '开始这篇', exact: false }).click();
  await check('read/listen/hide flow uses real passage and explicit resource preparation', async () => {
    assert.equal(await page.locator('.retell-passage p').count(), 3); assert.equal(await page.locator('.retell-reference').count(), 0); await shot('02-reader-mobile');
    const cdp = await context.newCDPSession(page); await cdp.send('DOM.enable'); await cdp.send('CSS.enable'); const document = await cdp.send('DOM.getDocument'); const used = {};
    for (const [label, selector] of [['english', '.retell-passage p'], ['chinese', '.retell-reader h2']]) { const { nodeId } = await cdp.send('DOM.querySelector', { nodeId: document.root.nodeId, selector }); used[label] = (await cdp.send('CSS.getPlatformFontsForNode', { nodeId })).fonts; }
    assert.ok(used.english.some(font => font.isCustomFont && /Source Serif/.test(font.familyName))); assert.ok(used.chinese.some(font => font.isCustomFont && /Noto Sans SC/.test(font.familyName))); report.fonts = { ...used, englishWeight: await page.locator('.retell-passage p').first().evaluate(element => getComputedStyle(element).fontWeight) }; assert.equal(report.fonts.englishWeight, '400'); await cdp.detach();
    await page.getByRole('button', { name: '听音频', exact: true }).click(); assert.equal(await page.locator('.retell-passage').count(), 0);
    await page.getByRole('button', { name: '需要时查看原文', exact: true }).click();
    await page.locator('.retell-sources summary').click(); assert.equal(await page.locator('.retell-sources a').count(), 2);
    await page.getByRole('button', { name: '隐藏原文，开始复述', exact: false }).click();
    assert.equal(await page.locator('.retell-passage').count(), 0); assert.equal(await page.locator('textarea').count(), 0);
    await shot('03-first-resource-setup'); assert.equal(report.asrRequests.length, 0);
    await page.getByRole('button', { name: '下载并启用', exact: true }).click();
    await page.waitForFunction(() => !document.querySelector('.retell-microphone').disabled, null, { timeout: 180_000 });
    assert.ok(report.asrRequests.length > 10); await shot('03-speak-ready');
    return { originalHidden: true, sameOriginResources: report.asrRequests.length, manualInput: false };
  });
  let completed;
  await check('real recording pauses, resumes, transcribes and saves actual audio/text', async () => { completed = await recordAndFinish(); return completed; });
  await check('comparison contains two prepared answers, key points, original recording and export', async () => {
    assert.equal(await page.locator('.retell-keypoints li').count(), 3); const first = await page.locator('.retell-reference').innerText();
    await page.getByRole('button', { name: '完整表达', exact: true }).click(); const second = await page.locator('.retell-reference').innerText(); assert.notEqual(first, second);
    await page.getByRole('button', { name: '简洁口语', exact: true }).click();
    await page.locator('.retell-own summary').click(); assert.equal(await page.locator('.retell-own > p').innerText(), completed.transcript);
    const recording = page.locator('.retell-own audio'); await recording.evaluate(element => { element.load(); }); await recording.evaluate(element => new Promise((resolve, reject) => { if (element.readyState >= 1) return resolve(true); element.onloadedmetadata = () => resolve(true); element.onerror = () => reject(new Error('Stored audio is not playable')); }));
    assert.equal(await page.locator('textarea').count(), 0); assert.match(await page.locator('.retell-own small').innerText(), /不等于发音或语法评分/);
    await page.locator('.retell-own summary').click(); await page.locator('.retell-comparison').evaluate(element => { element.scrollTop = 0; });
    await shot('05-comparison-mobile'); await page.setViewportSize({ width: 1440, height: 1000 }); await shot('05-comparison-desktop'); await page.setViewportSize({ width: 390, height: 844 });
    await page.getByRole('button', { name: '导出文字', exact: true }).click(); const field = page.getByRole('textbox', { name: '复述文字 JSON', exact: true }); const value = JSON.parse(await field.inputValue()); assert.equal(value.attempts[0].transcript, completed.transcript); assert.equal(await field.getAttribute('readonly'), '');
    await page.getByRole('button', { name: '复制完整文本', exact: true }).click(); assert.ok(await field.evaluate(element => element.selectionEnd > element.selectionStart)); await page.getByRole('button', { name: '关闭弹窗', exact: true }).click();
    return { references: 2, keyPoints: 3, playableActualRecording: true, exportMatchesAsr: true, automaticGrade: false };
  });
  await check('offline reload keeps completed result and performs another entirely local recording/ASR', async () => {
    await page.evaluate(() => navigator.serviceWorker.ready.then(() => true)); await page.waitForFunction(() => navigator.serviceWorker.controller);
    const requests = report.asrRequests.length; await context.setOffline(true); await page.reload(); await page.locator('.continue').waitFor(); await navigate();
    await page.getByRole('button', { name: '查看本机上次复述', exact: true }).click(); assert.equal((await readAttempts())[0].transcript, completed.transcript);
    await page.getByRole('button', { name: '再说一遍', exact: true }).click();
    await page.waitForFunction(() => !document.querySelector('.retell-microphone').disabled, null, { timeout: 120_000 });
    const again = await recordAndFinish(true); assert.equal(report.asrRequests.length, requests); await shot('06-offline-comparison'); await context.setOffline(false);
    return { previousResultPreserved: true, newResult: again, extraAsrNetworkRequests: report.asrRequests.length - requests };
  });
  await check('an earlier recording cannot be retried against another article', async () => {
    const before = await readAttempts(); await page.getByRole('button', { name: '返回复述选文', exact: true }).click();
    await page.locator('.retell-article').nth(1).click(); await page.getByRole('button', { name: '开始这篇', exact: false }).click(); await page.getByRole('button', { name: '隐藏原文，开始复述', exact: false }).click();
    assert.equal(await page.getByRole('button', { name: '重试识别这段录音', exact: true }).count(), 0); assert.deepEqual(await readAttempts(), before);
    await page.getByRole('button', { name: '返回复述选文', exact: true }).click(); await page.locator('.retell-article').first().click(); await page.getByRole('button', { name: '开始这篇', exact: false }).click(); await page.getByRole('button', { name: '隐藏原文，开始复述', exact: false }).click();
    return { oldRecordingHiddenOnDifferentArticle: true, existingAttemptUnchanged: true };
  });
  await check('cancel releases an unfinished recording without changing completed attempts', async () => {
    const before = await readAttempts(); await page.getByRole('button', { name: '开始语音复述', exact: true }).click(); await page.getByText('正在录音', { exact: true }).waitFor(); await page.waitForTimeout(500);
    await page.getByRole('button', { name: '取消本次未完成录音', exact: true }).click(); await page.getByRole('navigation', { name: '主导航', exact: true }).waitFor(); assert.deepEqual(await readAttempts(), before); await shot('07-cancelled-recording');
    return { navigationAvailable: true, oldAttemptUnchanged: true };
  });
  await check('removed local model bytes expose a real repair action and restore verified readiness', async () => {
    const removed = await page.evaluate(async () => { const cache = await caches.open('word-retell-asr-v1'); const keys = await cache.keys(); const entry = keys.find(key => key.url.endsWith('/model/config.json')); if (!entry) throw new Error('Verified model configuration not found'); return cache.delete(entry); }); assert.equal(removed, true);
    await page.getByRole('button', { name: '开始语音复述', exact: true }).click(); await page.getByRole('button', { name: '重新校验识别包', exact: true }).waitFor({ timeout: 120_000 });
    await page.getByRole('button', { name: '重新校验识别包', exact: true }).click(); await page.waitForFunction(() => !document.querySelector('.retell-microphone').disabled, null, { timeout: 120_000 });
    await page.locator('.retell-error').waitFor({ state: 'detached' }); return { damagedCacheRejected: true, explicitRepairCompleted: true, originalProgressPreserved: true };
  });
  await check('denied microphone shows actionable error and leaves the saved attempt intact', async () => {
    const before = await readAttempts(); await context.clearPermissions(); await context.grantPermissions(['camera']);
    await page.getByRole('button', { name: '开始语音复述', exact: true }).click();
    await page.locator('.notice.error, .retell-error[role="alert"]').first().waitFor();
    assert.deepEqual(await readAttempts(), before); assert.equal(await page.locator('.retell-comparison').count(), 0); assert.match(await page.locator('.notice.error, .retell-error[role="alert"]').first().innerText(), /麦克风权限/); await shot('08-microphone-denied');
    return { error: await page.locator('.notice.error, .retell-error[role="alert"]').first().innerText(), storedAttemptUnchanged: true };
  });
  assert.deepEqual(report.errors, []); assert.deepEqual(report.thirdParty, []); report.passed = true;
} catch (error) { report.passed = false; report.failure = { message: error.message, stack: error.stack }; process.exitCode = 1; await page.screenshot({ path: path.join(output, 'failure.png') }).catch(() => {}); console.error(error); }
finally { report.finishedAt = new Date().toISOString(); await writeFile(path.join(output, 'report.json'), JSON.stringify(report, null, 2)); await browser.close(); }
