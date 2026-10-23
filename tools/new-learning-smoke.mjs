import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium, devices } from 'playwright';
import { createServer } from 'vite';

const root = fileURLToPath(new URL('../', import.meta.url));
const baseUrl = new URL(process.env.WORD_QA_URL ?? 'http://127.0.0.1:4173/');
const output = path.resolve(process.env.WORD_NEW_LEARNING_OUTPUT ?? path.join(root, '../../outputs/word-retell/new-learning'));
const profileParent = path.join(root, 'work');
await mkdir(output, { recursive: true });
await mkdir(profileParent, { recursive: true });
const report = {
  startedAt: new Date().toISOString(), url: baseUrl.href,
  fixture: {
    label: 'SYNTHETIC QA FIXTURES ONLY: not real user history or actual dated learning',
    scope: 'Only new task-owned Chrome profiles and their isolated IndexedDB; no personal profile or production server writes',
    source: 'Unchanged Word objects from the actual hash-verified study dictionary',
    validation: 'Every injected state is constructed with core learning rules and validated by core.parseAppState',
    speechSuccessSimulated: false,
    listenTest: 'The listen fixture is already revealed after a core unknown answer; no claim of hearing or passing a pronunciation gate',
  },
  profiles: [], checks: [], screenshots: [], pageErrors: [], phraseRequests: [], gestures: [], navigations: [],
  limitations: [
    'Android is Pixel 7 Chrome emulation, not a physical phone or installed PWA.',
    'Screenshots contain explicitly synthetic QA progress, not real user records.',
    'This suite does not validate Samantha availability, audible quality, hardware vibration, OS installation, or ASR.',
  ],
};
const contexts = [];
const ownedPages = new WeakSet();
const fixtureStates = {};
let mobile;
let core;
let manifest;
let words;
let now;
let today;
let yesterday;
let longWord;
const sha = value => createHash('sha256').update(value).digest('hex');

async function check(name, run) {
  const started = Date.now();
  try {
    const detail = await run();
    const result = { name, status: 'passed', milliseconds: Date.now() - started, detail };
    report.checks.push(result); console.log(JSON.stringify(result));
  } catch (error) {
    const result = { name, status: 'failed', milliseconds: Date.now() - started, error: error.message, stack: error.stack };
    report.checks.push(result); console.error(JSON.stringify(result));
    if (mobile) await mobile.screenshot({ path: path.join(output, `failed-${report.checks.length}.png`) }).catch(() => {});
  }
}

async function createPage(kind) {
  const profileDirectory = await mkdtemp(path.join(profileParent, `new-learning-${kind}-chrome-`));
  const options = kind === 'mobile'
    ? { ...devices['Pixel 7'], viewport: { width: 390, height: 844 } }
    : { viewport: { width: 1440, height: 1000 }, deviceScaleFactor: 1 };
  const context = await chromium.launchPersistentContext(profileDirectory, {
    ...options, channel: 'chrome', headless: true, timezoneId: 'America/Tijuana', serviceWorkers: 'allow',
  });
  contexts.push(context); report.profiles.push({ kind, profileDirectory, viewport: options.viewport });
  await context.addInitScript(() => {
    globalThis.__newLearningPointers = [];
    for (const type of ['pointerdown','pointermove','pointerup','pointercancel','lostpointercapture']) {
      document.addEventListener(type, event => {
        const target = event.target instanceof Element ? event.target : null;
        globalThis.__newLearningPointers.push({ type, pointerType: event.pointerType, isPrimary: event.isPrimary, x: event.clientX, y: event.clientY, target: target?.className, onStage: !!target?.closest('.swipe-stage') });
        if (globalThis.__newLearningPointers.length > 100) globalThis.__newLearningPointers.shift();
      }, true);
    }
  });
  context.on('request', request => {
    if (new URL(request.url()).pathname.startsWith('/phrases/')) report.phraseRequests.push({ kind, url: request.url() });
  });
  const page = context.pages()[0] ?? await context.newPage();
  ownedPages.add(page); page.setDefaultTimeout(30_000);
  page.on('pageerror', error => report.pageErrors.push({ kind, message: error.message }));
  page.on('framenavigated', frame => { if (frame === page.mainFrame()) report.navigations.push({ kind, url: frame.url() }); });
  await page.goto(baseUrl.href);
  await page.getByRole('button', { name: '下载词库并开始', exact: true }).click();
  await page.getByRole('navigation', { name: '主导航', exact: true }).waitFor({ timeout: 60_000 });
  await page.getByRole('navigation', { name: '主导航', exact: true }).getByRole('button', { name: '复述', exact: true }).waitFor();
  return page;
}

async function savedState(page) {
  assert.ok(ownedPages.has(page), 'Storage reads must stay inside a task-owned Chrome profile');
  return page.evaluate(() => new Promise((resolve, reject) => {
    const opening = indexedDB.open('yanxai-word-v1');
    opening.onerror = () => reject(new Error(opening.error?.message));
    opening.onsuccess = () => {
      const db = opening.result; const tx = db.transaction('state'); const read = tx.objectStore('state').get('current');
      read.onsuccess = () => resolve(read.result); read.onerror = () => reject(new Error(read.error?.message));
      tx.oncomplete = () => db.close(); tx.onabort = () => { db.close(); reject(new Error(tx.error?.message)); };
    };
  }));
}

async function waitState(page, predicate) {
  const start = Date.now();
  while (Date.now() - start < 20_000) {
    const state = await savedState(page);
    if (predicate(state)) return state;
    await page.waitForTimeout(40);
  }
  throw new Error('Isolated persisted state did not reach the expected result');
}

async function injectFixture(page, label, value) {
  assert.ok(ownedPages.has(page), 'Fixture injection must stay inside a task-owned Chrome profile');
  if (page.url() !== baseUrl.href) {
    await page.goto(baseUrl.href);
    await page.getByRole('navigation', { name: '主导航', exact: true }).waitFor();
  }
  const checked = core.parseAppState(value, words, manifest.version);
  fixtureStates[label] = checked;
  await page.evaluate(data => new Promise((resolve, reject) => {
    const opening = indexedDB.open('yanxai-word-v1');
    opening.onerror = () => reject(new Error(opening.error?.message));
    opening.onsuccess = () => {
      const db = opening.result; const tx = db.transaction('state', 'readwrite');
      tx.objectStore('state').put(data, 'current');
      tx.oncomplete = () => { db.close(); resolve(); };
      tx.onabort = tx.onerror = () => { db.close(); reject(new Error(tx.error?.message)); };
    };
  }), checked);
  await page.reload();
  await page.getByRole('navigation', { name: '主导航', exact: true }).waitFor();
  assert.deepEqual(await savedState(page), checked, 'Reload must preserve the validated fixture');
  return checked;
}

function activeFixture(ids, mode = 'look', prefix = [], revealed = false) {
  let value = core.createInitialState(manifest.version, now++);
  value.settings = { ...value.settings, skipBasic: false, autoSpeak: false, haptics: false, soundEffects: false, groupSize: 10 };
  value.modes[mode] = { groupNumber: 1, progress: {}, session: { groupNumber: 1, items: ids, cursor: 0, revealed: false, status: 'active', known: 0, unknown: 0, skipped: 0 } };
  value = core.parseAppState(value, words, manifest.version);
  for (const result of prefix) {
    value = core.answer(value, mode, result, core.getCurrentToken(value, mode), now++, today);
    if (result === 'unknown') value = core.nextWord(value, mode, core.getCurrentToken(value, mode), now++);
  }
  if (revealed) value = core.answer(value, mode, 'unknown', core.getCurrentToken(value, mode), now++, today);
  return core.parseAppState(value, words, manifest.version);
}

function yesterdayCompletedFixture() {
  const target = words.find(word => word.id === 'important'); assert.ok(target);
  let time = Date.parse(`${yesterday}T12:00:00.000Z`);
  let value = core.createInitialState(manifest.version, time++);
  value.settings = { ...value.settings, autoSpeak: false, haptics: false, soundEffects: false, groupSize: 10 };
  for (const result of ['unknown', 'known', 'known']) {
    value = core.ensureSession(value, [target], 'look', time++, yesterday);
    value = core.answer(value, 'look', result, core.getCurrentToken(value, 'look'), time++, yesterday);
    if (result === 'unknown') value = core.nextWord(value, 'look', core.getCurrentToken(value, 'look'), time++);
  }
  assert.equal(value.modes.look.progress.important.status, 'completed');
  return core.parseAppState(value, words, manifest.version);
}

async function start(page, mode = 'look') {
  await page.getByRole('button', { name: mode === 'look' ? /^看词记忆/ : /^听音辨词/ }).click();
  await page.locator('.swipe-stage').waitFor();
}

async function wordIs(page, text) {
  await page.waitForFunction(value => document.querySelector('h2.word')?.textContent === value, text);
}

async function screenshot(page, name) {
  await page.evaluate(() => document.fonts.ready.then(() => true));
  const file = path.join(output, `qa-fixture-${name}.png`);
  await page.screenshot({ path: file, animations: 'disabled' });
  report.screenshots.push({ file, viewport: page.viewportSize(), fixture: 'Synthetic validated QA progress, not actual user history' });
}

async function touchSwipe(page, direction) {
  const stage = await page.locator('.swipe-stage').boundingBox(); assert.ok(stage);
  const view = page.viewportSize();
  const fromX = stage.x + stage.width * (direction === 'previous' ? .23 : .77);
  const toX = stage.x + stage.width * (direction === 'previous' ? .77 : .23);
  const y = Math.min(view.height - 190, Math.max(120, stage.y + Math.min(stage.height * .32, 160)));
  await page.evaluate(() => { globalThis.__newLearningPointers = []; });
  const cdp = await page.context().newCDPSession(page);
  const observation = { direction, fromX, toX, y, startUrl: page.url(), styles: await page.locator('.swipe-stage').evaluate(element => ({
    stageTouchAction: getComputedStyle(element).touchAction,
    htmlOverscroll: getComputedStyle(document.documentElement).overscrollBehavior,
    bodyOverscroll: getComputedStyle(document.body).overscrollBehavior,
    scrollingElement: document.scrollingElement?.tagName,
  })) };
  report.gestures.push(observation);
  try {
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x: fromX, y }] });
    for (let index = 1; index <= 8; index++) {
      await cdp.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [{ x: fromX + (toX - fromX) * index / 8, y }] });
      await page.waitForTimeout(15);
    }
    observation.eventsBeforeEnd = await page.evaluate(() => globalThis.__newLearningPointers);
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
  } finally { await cdp.detach(); }
  await page.waitForTimeout(100);
  Object.assign(observation, await page.evaluate(() => ({ events: globalThis.__newLearningPointers, currentWord: document.querySelector('h2.word')?.textContent ?? null, endUrl: location.href, bodyText: document.body.innerText.slice(0,100) })));
}

async function inlineReady(page) {
  await page.locator('.study-answer .phrase-inline .phrase-item').first().waitFor();
  assert.equal(await page.getByRole('dialog').count(), 0, 'Supplement must render directly in the study card');
}

async function touchScrollAnswer(page) {
  const answer = page.locator('.study-answer'); const box = await answer.boundingBox(); assert.ok(box);
  const start = await answer.evaluate(element => ({ top: element.scrollTop, height: element.clientHeight, scrollHeight: element.scrollHeight }));
  assert.ok(start.scrollHeight > start.height + 20, 'Opened source sense must really need scrolling');
  const x = box.x + box.width * .82;
  const fromY = Math.min(page.viewportSize().height - 200, box.y + box.height * .8);
  const toY = Math.max(box.y + 18, fromY - 150);
  assert.ok(fromY - toY > 35, 'The actual answer area needs a usable touch distance');
  const cdp = await page.context().newCDPSession(page);
  try {
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x, y: fromY }] });
    for (let index = 1; index <= 10; index++) {
      await cdp.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [{ x, y: fromY + (toY - fromY) * index / 10 }] });
      await page.waitForTimeout(20);
    }
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
  } finally { await cdp.detach(); }
  await page.waitForFunction(before => (document.querySelector('.study-answer')?.scrollTop ?? 0) > before + 10, start.top);
  return { before: start, afterScrollTop: await answer.evaluate(element => element.scrollTop), nativeCDPTouch: true };
}

async function assertSingleLine(page) {
  await page.evaluate(() => document.fonts.ready.then(() => true));
  const geometry = await page.locator('h2.word').evaluate(element => {
    const style = getComputedStyle(element); const range = document.createRange(); range.selectNodeContents(element);
    const rects = [...range.getClientRects()].filter(rect => rect.width > 0);
    return { text: element.textContent, whiteSpace: style.whiteSpace, fontSize: Number.parseFloat(style.fontSize), width: element.clientWidth, scrollWidth: element.scrollWidth, lineTops: [...new Set(rects.map(rect => Math.round(rect.top)))], pageWidth: document.documentElement.scrollWidth, viewportWidth: innerWidth };
  });
  assert.equal(geometry.text, longWord.word); assert.equal(geometry.whiteSpace, 'nowrap');
  assert.equal(geometry.lineTops.length, 1); assert.ok(geometry.fontSize >= 18);
  assert.ok(geometry.scrollWidth <= geometry.width + 1); assert.ok(geometry.pageWidth <= geometry.viewportWidth);
  return geometry;
}

try {
  const contracts = await createServer({ configFile: false, root, server: { middlewareMode: true, hmr: false }, appType: 'custom' });
  try { core = await contracts.ssrLoadModule('/packages/core/src/index.ts'); } finally { await contracts.close(); }
  const manifestResponse = await fetch(new URL('data/manifest.json', baseUrl)); assert.equal(manifestResponse.status, 200);
  manifest = await manifestResponse.json();
  const studyResponse = await fetch(new URL(`data/${manifest.study.file}`, baseUrl)); assert.equal(studyResponse.status, 200);
  const studyBytes = Buffer.from(await studyResponse.arrayBuffer());
  assert.equal(studyBytes.length, manifest.study.bytes); assert.equal(sha(studyBytes), manifest.study.sha256);
  words = core.parseWords(JSON.parse(studyBytes.toString('utf8'))); assert.equal(words.length, manifest.study.count);
  report.lexicalVersion = 'reviewed-headword-collocations';
  assert.ok(words.some(word => word.id === 'important')); assert.ok(words.some(word => word.id === 'because'));
  longWord = [...words.filter(word => !word.basic && /^[a-z]+$/.test(word.word))].sort((a, b) => b.word.length - a.word.length || a.rank - b.rank)[0]; assert.ok(longWord);
  report.fixture.dictionaryVersion = manifest.version; report.fixture.wordsUsedUnchanged = ['important', 'because', longWord.id]; report.fixture.dictionarySourceSha256 = sha(studyBytes);
  mobile = await createPage('mobile');
  ({ now, today } = await mobile.evaluate(() => { const date = new Date(); return { now: date.getTime(), today: `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2,'0')}-${String(date.getDate()).padStart(2,'0')}` }; }));
  yesterday = core.previousLocalDateKey(today); report.fixture.today = today; report.fixture.yesterday = yesterday;
  const shell = await (await fetch(new URL('sw.js', baseUrl))).text(); report.shell = shell.match(/word-shell-([a-f0-9]+)/)?.[1] ?? null;

  await check('real updated preview exposes the retell navigation', async () => {
    await mobile.getByRole('navigation', { name: '主导航' }).getByRole('button', { name: '复述', exact: true }).click();
    await mobile.getByRole('heading', { name: '复述', exact: true }).waitFor();
    await mobile.getByRole('navigation', { name: '主导航' }).getByRole('button', { name: '学习', exact: true }).click();
    return { chrome: await mobile.context().browser()?.version(), studyWords: words.length, lexicalVersion: report.lexicalVersion, newNavigation: true };
  });

  await check('longest real study word fits a single mobile line', async () => {
    await injectFixture(mobile, 'mobile-history-before-current', activeFixture(['because','important',longWord.id], 'look', ['known','known']));
    await start(mobile); await wordIs(mobile, longWord.word);
    const geometry = await assertSingleLine(mobile); await screenshot(mobile, '01-mobile-long-word'); return geometry;
  });

  await check('native touch history browsing cannot answer or move past the live word', async () => {
    const before = await savedState(mobile);
    await touchSwipe(mobile, 'previous'); await wordIs(mobile, 'important'); await inlineReady(mobile);
    assert.match(await mobile.locator('.history-card .phrase-inline').innerText(), /be important/);
    await screenshot(mobile, '02-mobile-history-important');
    await touchSwipe(mobile, 'previous'); await wordIs(mobile, 'because'); await inlineReady(mobile);
    assert.match(await mobile.locator('.history-card .phrase-inline').innerText(), /because of/);
    await touchSwipe(mobile, 'next'); await wordIs(mobile, 'important');
    await touchSwipe(mobile, 'next'); await wordIs(mobile, longWord.word);
    assert.equal(await mobile.locator('.history-card').count(), 0);
    await touchSwipe(mobile, 'next'); await mobile.waitForTimeout(150); await wordIs(mobile, longWord.word);
    assert.deepEqual(await savedState(mobile), before, 'Browsing must not change revision, counters, calendar, journal or current cursor');
    return { nativeCDPTouch: true, browsed: ['important','because','important',longWord.id], extraForwardSwipeStopsAtLiveWord: true, exactSavedStateUnchanged: true, revision: before.revision };
  });

  await check('quick settings persist choices without a duplicate permanent skip action', async () => {
    await injectFixture(mobile, 'mobile-quick-settings-current', activeFixture(['because','important',longWord.id], 'look', ['known','known']));
    await start(mobile); await wordIs(mobile, longWord.word);
    const before = await savedState(mobile);
    await mobile.getByLabel('学习操作', { exact: true }).click();
    const menu = mobile.locator('.study-menu-panel'); await menu.waitFor();
    assert.equal(await menu.getByRole('button', { name: /长期跳过|斩/ }).count(), 0);
    assert.equal(await mobile.getByRole('button', { name: '斩，长期跳过当前单词', exact: true }).count(), 1);
    await menu.getByLabel('快捷词库范围', { exact: true }).selectOption('ielts');
    await waitState(mobile, value => value.settings.deck === 'ielts');
    await menu.getByLabel('快捷每组单词数', { exact: true }).selectOption('30');
    await waitState(mobile, value => value.settings.groupSize === 30);
    await menu.getByLabel('快捷语速', { exact: true }).selectOption('1');
    const after = await waitState(mobile, value => value.settings.rate === 1);
    assert.deepEqual(after.modes, before.modes); assert.deepEqual(after.dailyActivity, before.dailyActivity); assert.deepEqual(after.studyTrail, before.studyTrail); assert.deepEqual(after.skipped, before.skipped);
    assert.equal(after.revision, before.revision + 3); assert.equal(await menu.getByRole('switch', { name: '快捷自动朗读', exact: true }).getAttribute('aria-checked'), 'false');
    await screenshot(mobile, '03-mobile-quick-settings');
    await mobile.keyboard.press('Escape');
    return { permanentSkipActionsInMenu: 0, independentSlashButtons: 1, persisted: { deck: after.settings.deck, groupSize: after.settings.groupSize, rate: after.settings.rate }, currentSessionAndLearningCountsUnchanged: true };
  });

  await check('revealed look card renders reviewed writing collocations without old synonyms', async () => {
    await injectFixture(mobile, 'mobile-look-revealed-important', activeFixture(['important','because',longWord.id], 'look', [], true));
    await start(mobile); await wordIs(mobile, 'important'); const before = await savedState(mobile);
    await inlineReady(mobile);
    const inline = mobile.locator('.study-answer .phrase-inline');
    assert.match(await inline.innerText(), /be important/); assert.match(await inline.innerText(), /重要/);
    assert.equal(await inline.locator('.word-sense, .phrase-substitutes').count(), 0);
    await screenshot(mobile, '04-mobile-look-inline'); assert.deepEqual(await savedState(mobile), before);
    return { word: 'important', collocation: true, oldWordNetBlocks: 0, noSupplementProgressMutation: true };
  });

  await check('revealed look card renders a reviewed causal phrase and grammatical restriction', async () => {
    await injectFixture(mobile, 'mobile-look-revealed-because', activeFixture(['because','important',longWord.id], 'look', [], true));
    await start(mobile); await wordIs(mobile, 'because'); const before = await savedState(mobile);
    await inlineReady(mobile);
    const inline = mobile.locator('.study-answer .phrase-inline');
    assert.match(await inline.innerText(), /because of/); assert.match(await inline.innerText(), /因为|由于/);
    assert.match(await inline.innerText(), /名词/);
    assert.equal(await inline.locator('.phrase-substitutes').count(), 0);
    await screenshot(mobile, '04b-mobile-look-because-inline'); assert.deepEqual(await savedState(mobile), before);
    return { word: 'because', phrase: 'because of', ChineseMeaning: true, noAutomaticSynonyms: true, noSupplementProgressMutation: true };
  });

  await check('native vertical reading scrolls collocations on a small phone without answering', async () => {
    await mobile.setViewportSize({ width: 320, height: 568 });
    await injectFixture(mobile, 'mobile-scrollable-collocations', activeFixture(['important','because',longWord.id], 'look', [], true));
    await start(mobile); await wordIs(mobile, 'important'); await inlineReady(mobile);
    const before = await savedState(mobile);
    await mobile.locator('.phrase-evidence summary').first().click();
    const detail = await touchScrollAnswer(mobile);
    await wordIs(mobile, 'important'); assert.equal(await mobile.locator('.history-card').count(), 0);
    assert.deepEqual(await savedState(mobile), before);
    await screenshot(mobile, '04c-mobile-scrollable-collocations');
    await mobile.setViewportSize({ width: 390, height: 844 });
    return { ...detail, currentWordUnchanged: true, exactSavedStateUnchanged: true };
  });

  await check('already-revealed listen fixture shows the same reviewed collocations without faking speech', async () => {
    await injectFixture(mobile, 'mobile-listen-already-revealed-because', activeFixture(['because','important',longWord.id], 'listen', [], true));
    await start(mobile, 'listen'); await wordIs(mobile, 'because'); const before = await savedState(mobile);
    await inlineReady(mobile);
    const inline = mobile.locator('.study-answer .phrase-inline');
    assert.match(await inline.innerText(), /because of/); assert.match(await inline.innerText(), /因为|由于/);
    await screenshot(mobile, '05-mobile-listen-inline'); assert.deepEqual(await savedState(mobile), before);
    await injectFixture(mobile, 'mobile-listen-already-revealed-important', activeFixture(['important','because',longWord.id], 'listen', [], true));
    await start(mobile, 'listen'); await wordIs(mobile, 'important'); const wordBefore = await savedState(mobile); await inlineReady(mobile);
    assert.match(await mobile.locator('.study-answer .phrase-inline').innerText(), /be important/);
    await screenshot(mobile, '05b-mobile-listen-important-inline'); assert.deepEqual(await savedState(mobile), wordBefore);
    return { words: ['because','important'], reviewedCollocations: true, ChineseMeaning: true, preRevealedValidatedFixtures: true, speechAPIsReplaced: false, audiblePlaybackClaimed: false };
  });

  await check('yesterday wrong word completed yesterday is prioritized and checked again today', async () => {
    const seed = await injectFixture(mobile, 'mobile-yesterday-synthetic-completed-important', yesterdayCompletedFixture());
    const panel = mobile.getByRole('region', { name: '昨日错词复习', exact: true }); await panel.waitFor();
    assert.match(await panel.innerText(), /看词待检验 1/); await screenshot(mobile, '06-mobile-yesterday-review');
    await mobile.getByRole('button', { name: '开始昨日错词复习', exact: true }).click(); await wordIs(mobile, 'important');
    const queued = await savedState(mobile);
    assert.equal(queued.modes.look.session.items[0], 'important'); assert.equal(queued.modes.look.session.items.length, 10);
    assert.deepEqual(queued.modes.look.progress.important, seed.modes.look.progress.important);
    assert.equal(queued.dailyReview[today].look.important.completed, false); assert.deepEqual(queued.dailyActivity[yesterday], seed.dailyActivity[yesterday]);
    await mobile.getByRole('button', { name: '认识', exact: true }).click();
    const checked = await waitState(mobile, value => value.modes.look.session.cursor === 1);
    core.parseAppState(checked, words, manifest.version);
    assert.equal(checked.modes.look.progress.important.status, 'completed'); assert.equal(checked.modes.look.progress.important.rightCount, 3); assert.equal(checked.modes.look.progress.important.wrongCount, 1);
    assert.equal(checked.dailyReview[today].look.important.completed, true); assert.equal(checked.dailyActivity[today].important.look.known, 1);
    assert.deepEqual(checked.dailyActivity[yesterday], seed.dailyActivity[yesterday]);
    await mobile.getByRole('button', { name: '返回首页', exact: true }).click();
    assert.match(await panel.innerText(), /看词待检验 0/);
    return { syntheticYesterday: yesterday, actualBrowserToday: today, completedWordWasQueuedFirst: true, progressWasNotReset: true, known: 3, wrong: 1, yesterdayUntouched: true, todayCheckCompleted: true };
  });

  await check('Android installation guide gives truthful Chrome instructions and exact site address', async () => {
    await mobile.getByRole('navigation', { name: '主导航' }).getByRole('button', { name: '设置', exact: true }).click();
    await mobile.getByRole('button', { name: '查看安装方法', exact: true }).click();
    const guide = mobile.locator('.installation-guide'); await guide.waitFor();
    assert.match(await guide.innerText(), /Chrome/); assert.match(await guide.innerText(), /添加到主屏幕/); assert.match(await guide.innerText(), /不需要下载 APK/);
    assert.equal(await guide.getByRole('textbox', { name: '应用安装网址', exact: true }).inputValue(), 'https://word.yanxai.com/');
    assert.equal(new URL(await guide.getByRole('link', { name: '查看 Chrome 官方安装说明', exact: true }).getAttribute('href')).hostname, 'support.google.com');
    await screenshot(mobile, '07-mobile-android-install-guide');
    return { userAgentIncludesAndroid: (await mobile.evaluate(() => navigator.userAgent)).includes('Android'), officialGuide: true, truthfulNoApkOrPaidAccount: true, operatingSystemInstallationNotClaimed: true };
  });

  await check('separate desktop Chrome renders the same real inline content without page overflow', async () => {
    const desktop = await createPage('desktop');
    await injectFixture(desktop, 'desktop-look-revealed-important', activeFixture(['important','because',longWord.id], 'look', [], true));
    await start(desktop); await wordIs(desktop, 'important'); await inlineReady(desktop);
    assert.match(await desktop.locator('.phrase-inline').innerText(), /be important/);
    assert.equal(await desktop.locator('.word-sense, .phrase-substitutes').count(), 0);
    assert.equal(await desktop.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
    await screenshot(desktop, '08-desktop-look-inline');
    await desktop.getByLabel('学习操作', { exact: true }).click(); await screenshot(desktop, '09-desktop-quick-settings');
    return { viewport: desktop.viewportSize(), mobileUserAgent: (await desktop.evaluate(() => navigator.userAgent)).includes('Android'), separateTemporaryProfile: true, pageHorizontalOverflow: false };
  });

  assert.deepEqual(report.pageErrors, []);
  assert.equal(report.phraseRequests.length, 0, 'The rejected lexical packs must never be requested');
  report.passed = report.checks.every(result => result.status === 'passed');
  if (!report.passed) process.exitCode = 1;
} catch (error) {
  report.passed = false; report.failure = { message: error.message, stack: error.stack }; process.exitCode = 1;
  if (mobile) await mobile.screenshot({ path: path.join(output, 'failure.png') }).catch(() => {});
  console.error(error);
} finally {
  report.finishedAt = new Date().toISOString();
  await writeFile(path.join(output, 'fixtures.json'), JSON.stringify({ label: report.fixture.label, states: fixtureStates }, null, 2));
  await writeFile(path.join(output, 'report.json'), JSON.stringify(report, null, 2));
  for (const context of contexts) await context.close();
  console.log(JSON.stringify({ passed: report.passed, output, checks: report.checks.length }));
}
