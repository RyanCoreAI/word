import { chromium } from 'playwright';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const url = process.env.WORD_QA_URL ?? 'http://127.0.0.1:4173/';
const outputDirectory = process.env.WORD_LOCAL_VOICE_OUTPUT ?? fileURLToPath(new URL('../../../../outputs/word-local-voice/current-browser/', import.meta.url));
const profileParent = fileURLToPath(new URL('../../work/', import.meta.url));
await mkdir(outputDirectory, { recursive: true });
await mkdir(profileParent, { recursive: true });
const profileDirectory = await mkdtemp(path.join(profileParent, 'local-voice-chrome-'));
const report = { startedAt: new Date().toISOString(), url, profileDirectory, strategy: 'local device speech only; no hosted audio fallback', checks: [], errors: [], limitations: [] };
// This new, task-owned profile never reads personal browser data.
const context = await chromium.launchPersistentContext(profileDirectory, { channel: 'chrome', headless: true, viewport: { width: 390, height: 844 }, serviceWorkers: 'allow' });
const audioRequests = [];
context.on('request', request => { if (new URL(request.url()).pathname.includes('/audio/')) audioRequests.push(request.url()); });
// Only observe native utterances. The constructor delegates to the real browser;
// getVoices(), speak(), onstart and all playback results remain unmodified.
await context.addInitScript(() => {
  window.__localVoiceRequests = [];
  window.__localVoiceEvents = [];
  const NativeUtterance = window.SpeechSynthesisUtterance;
  if (!NativeUtterance) return;
  window.SpeechSynthesisUtterance = new Proxy(NativeUtterance, {
    construct(target, args, newTarget) {
      const utterance = Reflect.construct(target, args, newTarget);
      const id = window.__localVoiceRequests.length + 1;
      window.__localVoiceRequests.push({ id, text: utterance.text, time: performance.now() });
      for (const type of ['start', 'end', 'error']) utterance.addEventListener(type, event => {
        window.__localVoiceEvents.push({ id, type, isTrusted: event.isTrusted, time: performance.now(), text: utterance.text,
          voice: utterance.voice ? { name: utterance.voice.name, voiceURI: utterance.voice.voiceURI, lang: utterance.voice.lang, localService: utterance.voice.localService } : null,
          error: event.error ?? null,
          answersBeforeAppCallback: [...document.querySelectorAll('.actions button')].map(button => ({ text: button.textContent.trim(), disabled: button.disabled })) });
      });
      return utterance;
    },
  });
});
const page = context.pages()[0] ?? await context.newPage();
page.setDefaultTimeout(30_000);
page.on('pageerror', error => report.errors.push(error.message));
const check = async (name, action) => {
  const start = Date.now(); const detail = await action();
  const result = { name, status: 'passed', milliseconds: Date.now() - start, detail };
  report.checks.push(result); console.log(JSON.stringify(result));
};
const navigate = name => page.getByRole('navigation', { name: '主导航' }).getByRole('button', { name, exact: true }).click();
const localUsVoices = () => (report.deviceVoices ?? []).filter(voice => voice.localService && voice.lang.replaceAll('_', '-').toLowerCase() === 'en-us');
const events = () => page.evaluate(() => [...window.__localVoiceEvents]);
const starts = () => page.evaluate(() => window.__localVoiceEvents.filter(event => event.type === 'start'));
const answerStats = () => page.evaluate(() => new Promise((resolve, reject) => {
  const request = indexedDB.open('yanxai-word-v1');
  request.onerror = () => reject(request.error);
  request.onsuccess = () => {
    const db = request.result; const tx = db.transaction('state', 'readonly');
    const read = tx.objectStore('state').get('current');
    read.onerror = () => reject(read.error);
    read.onsuccess = () => {
      const state = read.result;
      resolve({ progress: state.modes.listen.progress, dailyActivity: state.dailyActivity, known: state.modes.listen.session?.known ?? 0, unknown: state.modes.listen.session?.unknown ?? 0 });
    };
    tx.oncomplete = () => db.close();
  };
}));
async function assertUnavailable() {
  const error = page.locator('.audio-error');
  await error.locator('summary').waitFor();
  assert.equal(await page.getByRole('button', { name: '认识', exact: true }).isDisabled(), true);
  assert.equal(await page.getByRole('button', { name: '不认识', exact: true }).isDisabled(), true);
  if (await error.getAttribute('open') === null) await error.locator('summary').click();
  const message = await error.locator('[role="status"]').innerText();
  assert.match(message, /本机|设备朗读|不支持/);
  return message;
}
async function assertNativeStart(previousCount) {
  await page.waitForFunction(count => window.__localVoiceEvents.filter(event => event.type === 'start').length > count, previousCount);
  const result = (await starts()).at(-1);
  assert.equal(result.isTrusted, true, 'An observed browser-native start event is required');
  assert.equal(result.voice?.localService, true);
  assert.equal(result.voice?.lang.replaceAll('_', '-').toLowerCase(), 'en-us');
  return result;
}
try {
  await check('constructing and onboarding never requests hosted audio; enumerate actual device voices', async () => {
    await page.goto(url);
    await page.getByRole('button', { name: '下载词库并开始', exact: true }).waitFor();
    assert.equal(audioRequests.length, 0);
    await page.getByRole('button', { name: '下载词库并开始', exact: true }).click();
    await page.locator('.continue').waitFor();
    report.deviceVoices = await page.evaluate(async () => {
      if (!window.speechSynthesis) return [];
      if (!speechSynthesis.getVoices().length) await new Promise(resolve => {
        const finish = () => { clearTimeout(timer); speechSynthesis.removeEventListener('voiceschanged', finish); resolve(); };
        const timer = setTimeout(finish, 1500); speechSynthesis.addEventListener('voiceschanged', finish);
      });
      return speechSynthesis.getVoices().map(voice => ({ name: voice.name, voiceURI: voice.voiceURI, lang: voice.lang, localService: voice.localService, default: voice.default }));
    });
    const samantha = localUsVoices().find(voice => /\bsamantha\b/i.test(voice.name));
    if (!samantha) report.limitations.push('This Chrome profile does not expose local Samantha. This run cannot verify Samantha sound quality or real Apple-device playback.');
    if (!localUsVoices().length) report.limitations.push('This host exposes no local en-US voice. Native English onstart/playback is not claimed; the real unavailable path is tested instead.');
    assert.equal(audioRequests.length, 0);
    return { voices: report.deviceVoices, localUsCount: localUsVoices().length, localSamanthaAvailable: Boolean(samantha), audioRequests: 0 };
  });

  await check('listening gates answers on real native start, or keeps them disabled without a local voice', async () => {
    await page.getByRole('button', { name: /听音辨词.*只听读音/ }).click();
    await page.getByRole('button', { name: '认识', exact: true }).waitFor();
    const baseline = await answerStats();
    let detail;
    if (localUsVoices().length) {
      const event = await assertNativeStart(0);
      assert.ok(event.answersBeforeAppCallback.filter(button => /^(不认识|认识)$/.test(button.text)).every(button => button.disabled), 'Answers must be disabled before the app handles native onstart');
      await page.waitForFunction(() => !document.querySelector('.actions .btn.good')?.disabled);
      const samantha = localUsVoices().find(voice => /\bsamantha\b/i.test(voice.name));
      if (samantha) assert.equal(event.voice.voiceURI, samantha.voiceURI);
      detail = { branch: 'real local native playback', event };
    } else {
      const message = await assertUnavailable();
      await page.locator('.audio-error summary').click();
      await page.locator('.listen-zone').click({ position: { x: 5, y: 5 } });
      await page.keyboard.press('ArrowRight'); await page.keyboard.press('ArrowLeft');
      await page.waitForTimeout(250);
      assert.deepEqual(await answerStats(), baseline, 'Unavailable audio must not increment learning, errors or calendar counts');
      assert.equal((await starts()).length, 0);
      detail = { branch: 'real unavailable local voice', message, answerStatsUnchanged: true };
    }
    assert.equal(audioRequests.length, 0);
    await page.screenshot({ path: path.join(outputDirectory, 'listen-local-state.png'), fullPage: true });
    return detail;
  });

  await check('settings lists local choices and preview never downloads online audio', async () => {
    await page.getByRole('button', { name: '返回首页', exact: true }).click();
    await navigate('设置');
    const options = await page.locator('#voice option').evaluateAll(items => items.map(item => ({ value: item.value, label: item.textContent })));
    assert.match(options[0].label, /本机 Samantha/);
    for (const option of options.filter(option => option.value)) assert.ok(localUsVoices().some(voice => voice.voiceURI === option.value));
    assert.equal(await page.getByRole('button', { name: '下载 / 继续下载全部美音', exact: true }).count(), 0);
    const before = (await starts()).length;
    await page.getByRole('button', { name: '试听当前声音', exact: true }).click();
    if (localUsVoices().length) await assertNativeStart(before);
    else { await page.getByText('暂无可用发音', { exact: true }).waitFor(); assert.equal((await starts()).length, 0); }
    assert.equal(audioRequests.length, 0);
    await page.screenshot({ path: path.join(outputDirectory, 'settings-local-voice.png'), fullPage: true });
    return { options, audioRequests: 0, nativeStartCount: (await starts()).length };
  });

  await check('automatic look-mode speech uses local availability and never hosted audio', async () => {
    await navigate('学习');
    const before = (await starts()).length;
    await page.getByRole('button', { name: /看词记忆.*显示单词/ }).click();
    await page.locator('.word').waitFor();
    if (localUsVoices().length) await assertNativeStart(before);
    else {
      await page.locator('.audio-error summary').waitFor();
      assert.equal((await starts()).length, 0);
      assert.equal(await page.getByRole('button', { name: '认识', exact: true }).isDisabled(), false, 'Look-mode learning remains usable without a voice');
    }
    assert.equal(audioRequests.length, 0);
    return { audioRequests: 0, nativeStartCount: (await starts()).length, lookModeUsableWithoutAudio: !localUsVoices().length };
  });

  await check('offline shell reload preserves the same local-only listening policy', async () => {
    await page.getByRole('button', { name: '返回首页', exact: true }).click();
    await page.evaluate(() => navigator.serviceWorker.ready);
    if (!await page.evaluate(() => Boolean(navigator.serviceWorker.controller))) await page.reload();
    assert.equal(await page.evaluate(() => Boolean(navigator.serviceWorker.controller)), true);
    await context.setOffline(true); await page.reload();
    await page.locator('.continue').waitFor();
    await page.getByRole('button', { name: /听音辨词.*只听读音/ }).click();
    if (localUsVoices().length) await assertNativeStart(0);
    else { await assertUnavailable(); assert.equal((await starts()).length, 0); }
    assert.equal(audioRequests.length, 0);
    return { online: await page.evaluate(() => navigator.onLine), audioRequests: 0, nativeStartCount: (await starts()).length };
  });
  assert.equal(report.errors.length, 0);
} catch (error) {
  report.failure = { message: error.message, stack: error.stack };
  console.error(error);
  process.exitCode = 1;
} finally {
  report.finishedAt = new Date().toISOString();
  report.audioRequests = audioRequests;
  report.observedNativeEvents = await events().catch(() => []);
  report.observedNativeUtterances = await page.evaluate(() => window.__localVoiceRequests).catch(() => []);
  report.audioRequestCount = audioRequests.length;
  await writeFile(path.join(outputDirectory, 'report.json'), JSON.stringify(report, null, 2));
  await context.close();
}
