import { chromium } from 'playwright';
import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const url = process.env.WORD_QA_URL ?? 'http://127.0.0.1:4173/';
const output = fileURLToPath(new URL('../../../../outputs/word-qa/audio-browser-report.json', import.meta.url));
const report = { startedAt: new Date().toISOString(), url, checks: [], errors: [] };
const browser = await chromium.launch({ channel: 'chrome', headless: true });
const context = await browser.newContext({ viewport: { width: 430, height: 932 }, serviceWorkers: 'allow' });
// Observe genuine media events. No audio method, speech voice, or playback result
// is fabricated. Every element below is a normal browser HTMLAudioElement.
await context.addInitScript(() => {
  const NativeAudio = window.Audio;
  window.__audioEvents = [];
  window.__audios = [];
  let id = 0;
  window.Audio = function (...args) {
    const element = new NativeAudio(...args); const audioId = ++id;
    window.__audios.push(element);
    for (const type of ['playing', 'ended', 'pause', 'error']) element.addEventListener(type, () => {
      window.__audioEvents.push({ id: audioId, type, time: performance.now(), currentTime: element.currentTime, duration: Number.isFinite(element.duration) ? element.duration : null, src: element.currentSrc, error: element.error?.code });
    });
    return element;
  };
});
const page = await context.newPage();
page.setDefaultTimeout(30_000);
page.on('pageerror', error => report.errors.push(error.message));
const audioRequests = [];
page.on('request', request => { if (request.url().includes('/audio/')) audioRequests.push(request.url()); });
const check = async (name, action) => {
  const start = Date.now(); const detail = await action();
  report.checks.push({ name, status: 'passed', milliseconds: Date.now() - start, detail });
  console.log(JSON.stringify(report.checks.at(-1)));
};
const navigate = name => page.getByRole('navigation', { name: '主导航' }).getByRole('button', { name, exact: true }).click();
const played = async previous => {
  await page.waitForFunction(count => window.__audioEvents.filter(event => event.type === 'playing').length > count, previous);
  return page.evaluate(() => window.__audioEvents.filter(event => event.type === 'playing'));
};
let releaseFirst; let firstHeld = false;
await page.route('**/audio/**/*.bin*', async route => {
  if (!firstHeld) { firstHeld = true; await new Promise(resolve => { releaseFirst = resolve; }); }
  await route.continue();
});
try {
  await check('real playback without an English device voice; event gates listening answers', async () => {
    await page.goto(url);
    await page.getByRole('button', { name: '下载词库并开始', exact: true }).waitFor();
    assert.equal(audioRequests.length, 0, 'No audio request before onboarding consent');
    await page.getByRole('button', { name: '下载词库并开始', exact: true }).click();
    await page.locator('.continue').waitFor();
    report.deviceVoices = await page.evaluate(() => speechSynthesis.getVoices().map(voice => ({ name: voice.name, lang: voice.lang })));
    await page.getByRole('button', { name: /听音辨词.*只听读音/ }).click();
    const began = Date.now();
    while (!releaseFirst && Date.now() - began < 20_000) await new Promise(resolve => setTimeout(resolve, 50));
    assert.ok(releaseFirst, 'A real pack request is pending');
    assert.equal(await page.getByRole('button', { name: '认识', exact: true }).isDisabled(), true);
    assert.equal(await page.evaluate(() => window.__audioEvents.length), 0);
    releaseFirst();
    const events = await played(0);
    await page.waitForFunction(() => ![...document.querySelectorAll('button')].find(button => button.textContent.trim() === '认识').disabled);
    assert.ok(events[0].src.startsWith('blob:'));
    assert.ok(events[0].duration > 0);
    return { event: events[0], deviceEnglishVoices: report.deviceVoices.filter(voice => /^en[-_](us|gb)$/i.test(voice.lang)).length };
  });

  await check('switching words cancels previous media and plays the next exact clip', async () => {
    const before = await page.evaluate(() => window.__audioEvents.filter(event => event.type === 'playing').length);
    await page.getByRole('button', { name: '认识', exact: true }).click();
    const events = await played(before);
    assert.notEqual(events.at(-1).src, events.at(-2).src);
    assert.notEqual(events.at(-1).id, events.at(-2).id);
    const previousMedia = await page.evaluate(() => ({ paused: window.__audios[0].paused, sourceAttribute: window.__audios[0].getAttribute('src') }));
    assert.deepEqual(previousMedia, { paused: true, sourceAttribute: null });
    return { previousAudioId: events.at(-2).id, nextAudioId: events.at(-1).id, previousMedia, observedEvents: await page.evaluate(() => window.__audioEvents) };
  });

  await check('full offline audio download can pause and resume to all packs', async () => {
    await page.getByRole('button', { name: '返回首页', exact: true }).click();
    await navigate('设置');
    await page.getByRole('button', { name: '下载 / 继续下载全部美音', exact: true }).click();
    await page.waitForFunction(() => [...document.querySelectorAll('p')].some(p => /已缓存 (\d+) \/ (\d+) 包/.test(p.textContent) && Number(p.textContent.match(/已缓存 (\d+)/)[1]) >= 3));
    await page.getByRole('button', { name: '暂停发音下载', exact: true }).click();
    await page.getByRole('button', { name: '下载 / 继续下载全部美音', exact: true }).waitFor();
    const paused = await page.getByText(/已缓存 \d+ \/ \d+ 包/).innerText();
    await page.getByRole('button', { name: '下载 / 继续下载全部美音', exact: true }).click();
    await page.waitForFunction(() => [...document.querySelectorAll('p')].some(p => { const match = p.textContent.match(/已缓存 (\d+) \/ (\d+) 包/); return match && match[1] === match[2]; }), null, { timeout: 180_000 });
    await page.getByRole('button', { name: '下载 / 继续下载全部美音', exact: true }).waitFor();
    const finished = await page.getByText(/已缓存 \d+ \/ \d+ 包/).innerText();
    const cached = await page.evaluate(async () => { const cache = await caches.open('word-audio-v1'); return (await cache.keys()).filter(request => request.url.includes('.bin')).length; });
    return { paused, finished, cachedPackCount: cached };
  });

  await check('controlled production shell reloads and listening plays real cached MP3 offline', async () => {
    await page.evaluate(() => navigator.serviceWorker.ready);
    if (!await page.evaluate(() => Boolean(navigator.serviceWorker.controller))) await page.reload();
    assert.equal(await page.evaluate(() => Boolean(navigator.serviceWorker.controller)), true);
    await context.setOffline(true);
    await page.reload();
    await page.locator('.continue').waitFor();
    await page.getByRole('button', { name: /听音辨词.*只听读音/ }).click();
    const events = await played(0);
    assert.ok(events[0].duration > 0);
    assert.equal(await page.getByRole('button', { name: '认识', exact: true }).isDisabled(), false);
    return { online: await page.evaluate(() => navigator.onLine), event: events[0] };
  });
  assert.equal(report.errors.length, 0);
} catch (error) {
  report.failure = { message: error.message, stack: error.stack };
  console.error(error);
  process.exitCode = 1;
} finally {
  releaseFirst?.();
  report.finishedAt = new Date().toISOString();
  report.audioRequestCount = audioRequests.length;
  await mkdir(path.dirname(output), { recursive: true });
  await writeFile(output, JSON.stringify(report, null, 2));
  await browser.close();
}
