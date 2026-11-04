import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium, devices } from 'playwright';
import { createServer } from 'vite';

const root = fileURLToPath(new URL('../', import.meta.url));
const baseUrl = new URL(process.env.WORD_QA_URL ?? 'http://127.0.0.1:4173/');
const output = path.resolve(process.env.WORD_RETENTION_QA_OUTPUT ?? 'D:/Word-article-release/retention');
for (const directory of [path.join(root, 'dist'), path.join(root, 'apps/web/public')]) {
  const relative = path.relative(directory, output);
  assert.ok(relative.startsWith('..') || path.isAbsolute(relative), 'QA history and backups must stay outside deployed assets');
}
await mkdir(output, { recursive: true });
const profileParent = path.join(output, 'profiles'); await mkdir(profileParent, { recursive: true });
const report = {
  startedAt: new Date().toISOString(), url: baseUrl.href, passed: false, checks: [], screenshots: [], requests: [], pageErrors: [], profiles: [],
  fixture: {
    label: 'SYNTHETIC QA HISTORY ONLY, not real user learning or proof of memory retention.',
    source: 'Unchanged Word objects from the actual SHA256-verified study pack.',
    construction: 'Core createInitialState/ensureSession/answer/deferWord with real Word objects; every injected state passes core.parseAppState.',
    exclusion: 'Other real dictionary IDs are skipped only in these fresh isolated QA profiles to keep the test queue small.',
  },
  limitations: ['Android uses Chrome touch emulation, not a physical phone or installed APK.', 'Listen records are synthetic core-generated fixtures; no successful voice playback is simulated or claimed.', 'Only a freshly created task-owned IndexedDB is seeded; no personal browser or server learning data is changed.'],
};
const contexts = [];
const ownedPages = new WeakSet();
let page;
let core;
let manifest;
let words;
let today;
let now;

async function check(name, run) {
  const start = Date.now();
  try {
    const detail = await run(); const result = { name, status: 'passed', milliseconds: Date.now() - start, detail };
    report.checks.push(result); console.log(JSON.stringify(result)); return detail;
  } catch (error) {
    const result = { name, status: 'failed', milliseconds: Date.now() - start, error: error.message };
    report.checks.push(result); console.error(JSON.stringify(result)); throw error;
  }
}
async function screenshot(name, target = page) {
  await target.evaluate(() => document.fonts.ready.then(() => true));
  const file = `${name}.png`; await target.screenshot({ path: path.join(output, file), animations: 'disabled' });
  report.screenshots.push({ name, file, viewport: target.viewportSize() });
}
async function showRetentionCard(target = page) {
  const card = target.locator('.retention-panel');
  await card.scrollIntoViewIfNeeded();
  await card.evaluate(element => element.scrollIntoView({ block: 'center', inline: 'nearest' }));
  await target.evaluate(() => document.fonts.ready.then(() => true));
  const value = await card.evaluate(element => {
    const box = element.getBoundingClientRect();
    const app = element.closest('.app-screen')?.getBoundingClientRect();
    const navigation = document.querySelector('.tabbar')?.getBoundingClientRect();
    return {
      card: { top: box.top, bottom: box.bottom, left: box.left, right: box.right, width: box.width, contentWidth: element.scrollWidth },
      visibleTop: Math.max(0, app?.top ?? 0), visibleBottom: Math.min(innerHeight, app?.bottom ?? innerHeight, navigation?.top ?? innerHeight),
      labels: [...element.querySelectorAll('.retention-heading,p,small,.retention-actions,.row-action')].map(label => {
        const rect = label.getBoundingClientRect();
        return { text: label.textContent.trim(), left: rect.left, right: rect.right, width: label.clientWidth, contentWidth: label.scrollWidth };
      }),
    };
  });
  assert.ok(value.card.top >= value.visibleTop - 1, 'Retention card is clipped above the app viewport');
  assert.ok(value.card.bottom <= value.visibleBottom + 1, 'Retention card is clipped or obscured by bottom navigation');
  assert.ok(value.card.contentWidth <= value.card.width + 1, 'Retention card content overflows horizontally');
  for (const label of value.labels) {
    assert.ok(label.contentWidth <= label.width + 1, `Retention label overflows: ${label.text}`);
    assert.ok(label.left >= value.card.left - 1 && label.right <= value.card.right + 1, `Retention label extends outside the card: ${label.text}`);
  }
  return value;
}
async function createPage(kind) {
  const profileDirectory = await mkdtemp(path.join(profileParent, `${kind}-`));
  const options = kind === 'mobile' ? { ...devices['Pixel 7'], viewport: { width: 390, height: 844 } } : { viewport: { width: 1440, height: 1000 }, deviceScaleFactor: 1 };
  const context = await chromium.launchPersistentContext(profileDirectory, { ...options, channel: 'chrome', headless: true, timezoneId: 'America/Tijuana', serviceWorkers: 'allow' });
  contexts.push(context); report.profiles.push({ kind, profileDirectory, viewport: options.viewport });
  context.on('request', request => { const url = new URL(request.url()); report.requests.push({ kind, url: request.url(), method: request.method(), hasBody: !!request.postData(), external: ['http:', 'https:'].includes(url.protocol) && url.origin !== baseUrl.origin }); });
  const target = context.pages()[0] ?? await context.newPage(); target.setDefaultTimeout(30_000); ownedPages.add(target);
  target.on('pageerror', error => report.pageErrors.push({ kind, error: error.message }));
  await target.goto(baseUrl.href); await target.getByRole('button', { name: '下载词库并开始', exact: true }).click();
  await target.getByRole('navigation', { name: '主导航', exact: true }).waitFor({ timeout: 60_000 }); return target;
}
async function readState(target = page) {
  assert.ok(ownedPages.has(target));
  return target.evaluate(() => new Promise((resolve, reject) => {
    const opening = indexedDB.open('yanxai-word-v1'); opening.onerror = () => reject(new Error(opening.error?.message));
    opening.onsuccess = () => {
      const db = opening.result; const tx = db.transaction('state', 'readonly'); const read = tx.objectStore('state').get('current'); let value;
      read.onsuccess = () => { value = read.result; }; tx.oncomplete = () => { db.close(); resolve(value); }; tx.onabort = () => { db.close(); reject(new Error(tx.error?.message)); };
    };
  }));
}
async function waitState(predicate, target = page) {
  const deadline = Date.now() + 25_000;
  while (Date.now() < deadline) {
    const value = await readState(target); if (predicate(value)) return core.parseAppState(value, words, manifest.version);
    await target.waitForTimeout(50);
  }
  throw new Error('The actual UI did not persist the expected retention state');
}
async function inject(value, target = page) {
  assert.ok(ownedPages.has(target), 'Synthetic fixtures cannot be written outside task-owned contexts');
  const checked = core.parseAppState(value, words, manifest.version);
  await target.evaluate(data => new Promise((resolve, reject) => {
    const opening = indexedDB.open('yanxai-word-v1'); opening.onerror = () => reject(new Error(opening.error?.message));
    opening.onsuccess = () => {
      const db = opening.result; const tx = db.transaction('state', 'readwrite'); tx.objectStore('state').put(data, 'current');
      tx.oncomplete = () => { db.close(); resolve(); }; tx.onabort = () => { db.close(); reject(new Error(tx.error?.message)); };
    };
  }), checked);
  await target.reload(); await target.getByRole('navigation', { name: '主导航', exact: true }).waitFor();
  assert.deepEqual(await readState(target), checked); return checked;
}
const nav = (name, target = page) => target.getByRole('navigation', { name: '主导航', exact: true }).getByRole('button', { name, exact: true }).click();
const retentionCard = (target = page) => target.getByRole('region', { name: '间隔巩固', exact: true });
const currentWord = (target = page) => target.locator('h2.word');
const day = (date, amount) => core.addRetentionDays(date, amount);
async function answerKnown(target = page) { await target.waitForTimeout(350); await target.getByRole('button', { name: '认识', exact: true }).click(); }
async function startRetention(target = page) { await retentionCard(target).getByRole('button', { name: '开始巩固', exact: true }).click(); await currentWord(target).waitFor(); }
async function goHome(target = page) { await target.getByRole('button', { name: '返回首页', exact: true }).click(); await target.getByRole('navigation', { name: '主导航', exact: true }).waitFor(); }

function fixture(count = 1, listenCount = 0, legacy = false) {
  const selected = words.filter(word => !word.basic).sort((a, b) => a.rank - b.rank || a.id.localeCompare(b.id)).slice(0, Math.max(count, listenCount));
  assert.equal(selected.length, Math.max(count, listenCount));
  const selectedIds = new Set(selected.map(word => word.id));
  const oldDate = day(today, 0); const trainingDate = new Date(Date.parse(`${oldDate}T00:00:00Z`) - 3 * 86_400_000).toISOString().slice(0, 10);
  let timestamp = Date.parse(`${trainingDate}T12:00:00Z`);
  let value = core.createInitialState(manifest.version, timestamp++);
  value = core.updateSettings(value, { deck: 'all', skipBasic: false, groupSize: 10, autoSpeak: false, haptics: false, soundEffects: false }, timestamp++);
  value = { ...value, skipped: words.filter(word => !selectedIds.has(word.id)).map(word => word.id) };
  for (const [mode, amount] of [['look', count], ['listen', listenCount]]) {
    for (let index = 0; index < amount; index++) {
      value = core.ensureSession(value, words, mode, timestamp++, trainingDate);
      value = core.answer(value, mode, 'known', core.getCurrentToken(value, mode), timestamp++, trainingDate);
    }
    while (value.modes[mode].session?.status === 'active') value = core.deferWord(value, mode, core.getCurrentToken(value, mode), timestamp++);
  }
  if (legacy) {
    // Explicitly model the previous backup shape, with no invented prior checks.
    const raw = structuredClone(value); delete raw.modes.look.retention; delete raw.modes.listen.retention; delete raw.retentionDays;
    delete raw.settings.retentionEnabled; delete raw.settings.retentionDailyLimit;
    for (const entry of raw.history) delete entry.retentionChange;
    value = core.parseAppState(raw, words, manifest.version);
  }
  return { state: core.parseAppState(value, words, manifest.version), ids: selected.slice(0, count).map(word => word.id), selected };
}

try {
  const contracts = await createServer({ configFile: false, root, server: { middlewareMode: true, hmr: false, watch: null }, appType: 'custom' });
  try { core = await contracts.ssrLoadModule('/packages/core/src/index.ts'); } finally { await contracts.close(); }
  const manifestResponse = await fetch(new URL('data/manifest.json', baseUrl)); assert.equal(manifestResponse.ok, true); manifest = await manifestResponse.json();
  const response = await fetch(new URL(`data/${manifest.study.file}`, baseUrl)); assert.equal(response.ok, true); const bytes = Buffer.from(await response.arrayBuffer());
  assert.equal(bytes.byteLength, manifest.study.bytes); assert.equal(createHash('sha256').update(bytes).digest('hex'), manifest.study.sha256);
  words = core.parseWords(JSON.parse(bytes));
  await check('a new installation shows no invented due cards or completed reviews', async () => {
    page = await createPage('mobile');
    ({ now, today } = await page.evaluate(() => { const value = new Date(); return { now: value.getTime(), today: `${value.getFullYear()}-${String(value.getMonth() + 1).padStart(2, '0')}-${String(value.getDate()).padStart(2, '0')}` }; }));
    const saved = await readState(); const summary = core.getRetentionSummary(saved, words, 'look', today);
    assert.equal(summary.due, 0); assert.equal(summary.completedToday, 0); assert.equal(await retentionCard().count(), 0);
    await screenshot('01-fresh-home'); return { summary, noFabricatedHistory: true };
  });
  let legacy;
  await check('old completed progress enters pending confirmation without fabricated dates', async () => {
    legacy = fixture(1, 0, true); await inject(legacy.state);
    const summary = core.getRetentionSummary(await readState(), words, 'look', today); assert.equal(summary.due, 1);
    assert.deepEqual((await readState()).modes.look.retention, {}); await retentionCard().waitFor();
    assert.match(await retentionCard().innerText(), /今日已检验 0 \/ 20/); const visibility = await showRetentionCard(); await screenshot('02-legacy-pending-home');
    return { syntheticLegacyWord: legacy.ids[0], pending: 1, noBackfilledSuccessfulReview: true, visibility };
  });
  await check('unknown reveals immediately and undo restores the reservation, schedule and counters', async () => {
    await startRetention(); const before = await readState(); const id = legacy.ids[0];
    assert.equal(await currentWord().innerText(), id); assert.match(await page.locator('.tb-title .t2').innerText(), /间隔巩固/);
    assert.equal(await page.locator('.study-answer').count(), 0); await page.getByRole('button', { name: '不认识', exact: true }).click();
    await page.locator('.study-answer .meaning').waitFor();
    const failed = await waitState(value => value.modes.look.progress[id].wrongCount === before.modes.look.progress[id].wrongCount + 1);
    assert.equal(failed.modes.look.progress[id].status, 'learning'); assert.equal(failed.modes.look.progress[id].streak, 0);
    assert.equal(failed.modes.look.retention[id].dueOn, null); assert.equal(failed.modes.look.retention[id].lapses, 1);
    assert.equal(failed.retentionDays[today].look[id].failed, true); await screenshot('03-unknown-revealed');
    await page.waitForTimeout(350); await page.getByRole('button', { name: '撤销', exact: true }).click();
    const restored = await waitState(value => value.modes.look.progress[id].wrongCount === before.modes.look.progress[id].wrongCount);
    for (const key of ['modes', 'retentionDays', 'dailyActivity', 'history', 'studyTrail']) assert.deepEqual(restored[key], before[key], key);
    return { immediateReveal: true, unknownRecorded: true, undoFullyRestoresLearning: true };
  });
  await check('known at a due check schedules seven days from the actual answer and history browsing is read-only', async () => {
    const id = legacy.ids[0]; await answerKnown();
    const saved = await waitState(value => value.modes.look.retention[id]?.stage === 1);
    assert.equal(saved.modes.look.retention[id].dueOn, day(today, 7)); assert.equal(saved.modes.look.retention[id].lastConfirmedOn, today);
    assert.equal(saved.retentionDays[today].look[id].completed, true); assert.equal(saved.retentionDays[today].look[id].failed, false);
    const bytes = JSON.stringify(saved);
    await page.getByRole('button', { name: /右滑或点击回看上一词/ }).click(); await page.locator('.history-card').waitFor();
    assert.equal(await page.getByRole('button', { name: '认识', exact: true }).count(), 0); assert.equal(JSON.stringify(await readState()), bytes);
    await page.getByRole('button', { name: '回到当前待学词', exact: true }).click(); await goHome();
    assert.match(await retentionCard().innerText(), /今日已检验 1 \/ 20/); await showRetentionCard(); await screenshot('04-known-check-completed');
    return { nextDue: day(today, 7), actualChecksToday: 1, readOnlyHistory: true };
  });
  await check('forgotten words reflow through two known answers before starting the two-day interval again', async () => {
    const value = fixture(); await inject(value.state); await startRetention(); const id = value.ids[0];
    await page.getByRole('button', { name: '不认识', exact: true }).click(); await page.locator('.study-answer .meaning').waitFor();
    await page.waitForTimeout(350);
    await page.getByRole('button', { name: '下一个', exact: true }).click();
    await page.getByRole('button', { name: '开始下一组', exact: true }).click(); await currentWord().waitFor(); assert.equal(await currentWord().innerText(), id);
    await answerKnown(); await waitState(state => state.modes.look.progress[id].streak === 1);
    await page.getByRole('button', { name: '开始下一组', exact: true }).click(); await currentWord().waitFor(); await answerKnown();
    const saved = await waitState(state => state.modes.look.progress[id].status === 'completed');
    assert.equal(saved.modes.look.progress[id].streak, 2); assert.equal(saved.modes.look.retention[id].stage, 0); assert.equal(saved.modes.look.retention[id].dueOn, day(today, 2));
    assert.equal(saved.modes.look.retention[id].lapses, 1); assert.equal(core.getRetentionSummary(saved, words, 'look', today).completedToday, 1);
    await goHome(); return { originalTwoKnownRulePreserved: true, nextDue: day(today, 2), sameDayRelearningDoesNotAdvanceMultipleStages: true };
  });
  await check('reload keeps an in-progress retention group at the next unanswered real word', async () => {
    const value = fixture(2); await inject(value.state); await startRetention(); await answerKnown();
    const active = await waitState(state => state.modes.look.session?.cursor === 1); const expected = active.modes.look.session.items[1];
    await page.reload(); await page.getByRole('navigation', { name: '主导航' }).waitFor();
    assert.deepEqual(await readState(), active); await retentionCard().getByRole('button', { name: '继续当前组', exact: true }).click();
    await currentWord().waitFor(); assert.equal(await currentWord().innerText(), expected); assert.equal(await page.locator('.study-answer').count(), 0);
    await screenshot('05-resumed-retention-word'); await goHome(); return { cursor: 1, wordId: expected, scheduleAndQueuePreserved: true };
  });
  await check('settings enablement and limits persist, and actual text backup restores retention state after a preview', async () => {
    await nav('设置'); const enabled = page.getByRole('switch', { name: '间隔巩固', exact: true });
    assert.equal(await enabled.getAttribute('aria-checked'), 'true');
    await page.getByRole('group', { name: '每日巩固上限', exact: true }).getByRole('button', { name: '10 词', exact: true }).click();
    await waitState(value => value.settings.retentionDailyLimit === 10);
    await enabled.click(); await waitState(value => value.settings.retentionEnabled === false); await nav('学习'); assert.equal(await retentionCard().count(), 0);
    await nav('设置'); await enabled.click(); await waitState(value => value.settings.retentionEnabled === true);
    await page.getByRole('button', { name: '文本备份', exact: true }).click(); const exportedText = await page.getByRole('textbox', { name: '完整备份 JSON', exact: true }).inputValue();
    const exported = JSON.parse(exportedText); core.parseAppState(exported.state, words, manifest.version);
    assert.equal(exported.state.settings.retentionDailyLimit, 10); assert.ok(exported.state.retentionDays[today]);
    await writeFile(path.join(output, 'synthetic-qa-word-backup.json'), exportedText); await page.getByRole('button', { name: '关闭弹窗', exact: true }).click();
    await page.getByRole('group', { name: '每日巩固上限', exact: true }).getByRole('button', { name: '30 词', exact: true }).click();
    const changed = await waitState(value => value.settings.retentionDailyLimit === 30);
    await page.getByRole('button', { name: '粘贴备份恢复', exact: true }).click(); await page.getByRole('textbox', { name: '粘贴完整备份 JSON', exact: true }).fill(exportedText);
    await page.getByRole('button', { name: '校验并预览恢复', exact: true }).click(); await page.getByRole('dialog', { name: '恢复学习备份', exact: true }).waitFor();
    assert.deepEqual(await readState(), changed); await page.getByRole('button', { name: '确认恢复备份', exact: true }).click();
    const restored = await waitState(value => value.settings.retentionDailyLimit === 10);
    for (const key of ['settings', 'modes', 'dailyActivity', 'retentionDays']) assert.deepEqual(restored[key], exported.state[key], key);
    assert.equal(restored.revision, changed.revision + 1); return { limitPersists: true, disabledCardHidden: true, realTextBackupRoundtrip: true, previewDoesNotWrite: true, CASRevisionPreserved: true };
  });
  let capState;
  await check('twenty completed checks exhaust the shared automatic budget and manual five-card extra is explicit', async () => {
    const value = fixture(25, 5); await inject(value.state); await startRetention();
    for (let index = 0; index < 20; index++) {
      const before = await readState(); const expectedCount = core.getRetentionSummary(before, words, 'look', today).completedToday + 1;
      await answerKnown(); await waitState(state => core.getRetentionSummary(state, words, 'look', today).completedToday === expectedCount);
      if (index < 19 && (await readState()).modes.look.session.status === 'finished') await page.getByRole('button', { name: '开始下一组', exact: true }).click();
    }
    await goHome(); capState = await readState(); const summary = core.getRetentionSummary(capState, words, 'look', today);
    assert.equal(summary.completedToday, 20); assert.equal(summary.scheduledToday, 20); assert.equal(summary.remainingAllowance, 0); assert.equal(summary.dailyLimit, 20); assert.equal(summary.due, 5);
    const capVisibility = await showRetentionCard(); await screenshot('06-daily-cap-mobile'); await page.getByRole('button', { name: '查看听音进度', exact: true }).click();
    assert.match(await retentionCard().innerText(), /听音待巩固 5/); assert.equal(await retentionCard().getByRole('button', { name: '本模式暂已完成', exact: true }).isDisabled(), true);
    await retentionCard().getByRole('button', { name: '再巩固 5 词', exact: true }).click();
    const extra = await waitState(state => state.retentionDays[today]?.extraAllowance === 5 && state.modes.listen.session?.retentionIds?.length === 5);
    const after = core.getRetentionSummary(extra, words, 'listen', today); assert.equal(after.dailyLimit, 25); assert.equal(after.scheduledToday, 25); assert.equal(after.completedToday, 20);
    assert.equal(extra.settings.retentionDailyLimit, 20); await goHome();
    return { sharedAutomaticLimit: 20, actualCompletedChecks: 20, manualAllowance: 5, listenReservedWithoutClaimingPlaybackOrAnswers: 5, capVisibility };
  });
  await check('mobile and desktop retention cards use loaded custom fonts and no horizontal overflow', async () => {
    const measured = [];
    async function measure(target, label) {
      const visibility = await showRetentionCard(target);
      const value = await target.evaluate(() => ({ width: innerWidth, contentWidth: document.documentElement.scrollWidth, chineseLoaded: [...document.fonts].some(face => face.family.includes('Noto Sans SC') && face.status === 'loaded') }));
      assert.ok(value.contentWidth <= value.width + 1); assert.equal(value.chineseLoaded, true); measured.push({ label, ...value, visibility }); await screenshot(label, target);
    }
    await inject(capState); await measure(page, '07-mobile-retention-card');
    await page.setViewportSize({ width: 320, height: 844 }); await measure(page, '07-small-retention-card'); await page.setViewportSize({ width: 390, height: 844 });
    const desktop = await createPage('desktop'); await inject(capState, desktop); await measure(desktop, '07-desktop-retention-card');
    return measured;
  });
  await check('the due date comes from actual passed checks and becomes eligible on a later calendar day', async () => {
    const value = fixture(); await inject(value.state); await startRetention(); await answerKnown(); const id = value.ids[0];
    const saved = await waitState(state => state.modes.look.retention[id]?.stage === 1); const due = saved.modes.look.retention[id].dueOn; assert.equal(due, day(today, 7));
    await goHome(); assert.equal(core.getRetentionSummary(await readState(), words, 'look', today).due, 0);
    await page.clock.setFixedTime(new Date(`${due}T12:00:00-08:00`)); await page.evaluate(() => window.dispatchEvent(new Event('focus')));
    await retentionCard().getByRole('button', { name: '开始巩固', exact: true }).waitFor();
    const later = await readState(); assert.equal(core.getRetentionSummary(later, words, 'look', due).due, 1); assert.deepEqual(later.modes, saved.modes);
    return { actualEarlierAnswerScheduled: due, futureEligibilityConfirmed: true, clockChangeDoesNotCreateAnswers: true };
  });
  await check('synthetic local QA records never leave the browser and no browser exception occurred', async () => {
    assert.deepEqual(report.pageErrors, []); assert.deepEqual(report.requests.filter(value => value.external || value.hasBody || !['GET', 'HEAD'].includes(value.method)), []);
    return { observedRequests: report.requests.length, externalRequests: 0, uploadedRecords: 0, pageErrors: 0 };
  });
  report.passed = true;
} catch (error) {
  report.failure = { message: error.message, stack: error.stack }; process.exitCode = 1;
  if (page) await screenshot('failure').catch(() => {}); console.error(error);
} finally {
  report.finishedAt = new Date().toISOString(); await writeFile(path.join(output, 'report.json'), JSON.stringify(report, null, 2));
  for (const context of contexts) await context.close(); console.log(JSON.stringify({ passed: report.passed, checks: report.checks.length, output }));
}
