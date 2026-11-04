import assert from 'node:assert/strict';
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium, devices } from 'playwright';

const root = fileURLToPath(new URL('../', import.meta.url));
const referenceOnly = process.env.WORD_SEARCH_REFERENCE_ONLY === '1';
const baseUrl = new URL(referenceOnly ? 'https://word.yanxai.com/' : process.env.WORD_QA_URL ?? 'http://127.0.0.1:4173/');
const output = path.resolve(process.env.WORD_SEARCH_QA_OUTPUT ?? 'D:/Word-article-release/chinese-search');
for (const publicPath of [path.join(root, 'dist'), path.join(root, 'apps/web/public')]) {
  const relative = path.relative(publicPath, output);
  assert.ok(relative.startsWith('..') || path.isAbsolute(relative), 'Search QA artifacts must remain outside deployed files');
}
await mkdir(output, { recursive: true });
const profileParent = path.join(output, 'profiles'); await mkdir(profileParent, { recursive: true });
const report = {
  startedAt: new Date().toISOString(), url: baseUrl.href, referenceOnly, passed: false,
  checks: [], screenshots: [], profiles: [], requests: [], failedRequests: [], pageErrors: [],
  scope: 'Fresh task-owned Chrome profiles; actual UI onboarding and real ECDICT study pack; no injected words or personal browser data.',
  limitations: ['Android is Chrome Pixel 7 emulation, not a physical device or installed APK.', 'Offline requests for previously unused font subsets are recorded separately from application failures.'],
};
const contexts = [];
const ownedPages = new WeakSet();
let page;

async function check(name, run) {
  const started = Date.now();
  try {
    const detail = await run();
    const value = { name, status: 'passed', milliseconds: Date.now() - started, detail };
    report.checks.push(value); console.log(JSON.stringify(value)); return detail;
  } catch (error) {
    const value = { name, status: 'failed', milliseconds: Date.now() - started, error: error.message };
    report.checks.push(value); console.error(JSON.stringify(value)); throw error;
  }
}

async function createPage(kind) {
  const profileDirectory = await mkdtemp(path.join(profileParent, `${referenceOnly ? 'reference-' : ''}${kind}-`));
  const options = kind === 'mobile' ? { ...devices['Pixel 7'], viewport: { width: 390, height: 844 } } : { viewport: { width: 1440, height: 1000 }, deviceScaleFactor: 1 };
  const context = await chromium.launchPersistentContext(profileDirectory, { ...options, channel: 'chrome', headless: true, timezoneId: 'America/Tijuana', serviceWorkers: 'allow' });
  contexts.push(context); report.profiles.push({ kind, profileDirectory, viewport: options.viewport });
  const target = context.pages()[0] ?? await context.newPage(); ownedPages.add(target); target.setDefaultTimeout(30_000);
  context.on('request', request => {
    const url = new URL(request.url());
    report.requests.push({ kind, url: request.url(), method: request.method(), hasBody: !!request.postData(),
      external: ['http:', 'https:'].includes(url.protocol) && url.origin !== baseUrl.origin });
  });
  context.on('requestfailed', request => report.failedRequests.push({ kind, url: request.url(), error: request.failure()?.errorText, fontSubset: /\.woff2?(?:\?|$)/.test(request.url()) }));
  target.on('pageerror', error => report.pageErrors.push({ kind, error: error.message }));
  await target.goto(baseUrl.href);
  await target.getByRole('button', { name: '下载词库并开始', exact: true }).click();
  await target.getByRole('navigation', { name: '主导航', exact: true }).waitFor({ timeout: 60_000 });
  return target;
}

async function readOwnStore(target, store, key) {
  assert.ok(ownedPages.has(target), 'Reads must stay in a fresh task-owned profile');
  return target.evaluate(({ store, key }) => new Promise((resolve, reject) => {
    const request = indexedDB.open('yanxai-word-v1');
    request.onerror = () => reject(new Error(request.error?.message));
    request.onsuccess = () => {
      const connection = request.result;
      const tx = connection.transaction(store, 'readonly'); const read = tx.objectStore(store).get(key); let value;
      read.onsuccess = () => { value = read.result; };
      tx.oncomplete = () => { connection.close(); resolve(value); };
      tx.onabort = () => { connection.close(); reject(new Error(tx.error?.message)); };
    };
  }), { store, key });
}
const wordStateBytes = async target => JSON.stringify(await readOwnStore(target, 'state', 'current'));
const searchInput = target => target.locator('.home-search input[type="search"]');
const results = target => target.locator('.home-search-results');
async function query(value, target = page) {
  await searchInput(target).fill(value);
  await target.locator('.home-search-results .search-caption [role="status"]').filter({ hasText: /最多 60 词/ }).waitFor();
  return target.locator('.home-search-results .it .w').evaluateAll(elements => elements.map(element => [...element.childNodes].filter(node => node.nodeType === Node.TEXT_NODE).map(node => node.textContent).join('').trim()));
}
async function screenshot(name, target = page) {
  await target.evaluate(() => document.fonts.ready.then(() => true));
  const file = `${name}.png`; await target.screenshot({ path: path.join(output, file), animations: 'disabled' });
  report.screenshots.push({ name, file, viewport: target.viewportSize() });
}
async function layout(target) {
  await target.evaluate(() => document.fonts.ready.then(() => true));
  const detail = await target.evaluate(() => ({
    width: innerWidth, documentWidth: document.documentElement.scrollWidth,
    resultWidth: document.querySelector('.home-search-results')?.clientWidth ?? 0,
    resultContentWidth: document.querySelector('.home-search-results')?.scrollWidth ?? 0,
    bodyFont: getComputedStyle(document.body).fontFamily,
    wordFont: document.querySelector('.home-search-results .w') ? getComputedStyle(document.querySelector('.home-search-results .w')).fontFamily : '',
    chineseLoaded: [...document.fonts].some(face => face.family.includes('Noto Sans SC') && face.status === 'loaded'),
    serifLoaded: [...document.fonts].some(face => face.family.includes('Source Serif 4') && face.status === 'loaded'),
  }));
  assert.ok(detail.documentWidth <= detail.width + 1, 'Document has horizontal overflow');
  assert.ok(detail.resultContentWidth <= detail.resultWidth + 1, 'Search results have horizontal overflow');
  assert.match(detail.bodyFont, /Noto Sans SC/); assert.match(detail.wordFont, /Source Serif 4/);
  assert.equal(detail.chineseLoaded, true); assert.equal(detail.serifLoaded, true); return detail;
}

try {
  if (referenceOnly) {
    // Run before deployment to retain the actual previous English-search UI.
    // No screenshots are synthesized and no old application files are modified.
    for (const kind of ['mobile', 'desktop']) {
      await check(`capture existing production English bank search at ${kind} size`, async () => {
        page = await createPage(kind); const before = await wordStateBytes(page);
        const input = searchInput(page); await input.fill('bank');
        await results(page).locator('.it').first().waitFor(); await page.waitForTimeout(800);
        const measured = await layout(page); await screenshot(`reference-${page.viewportSize().width}-english-bank`);
        assert.equal(await wordStateBytes(page), before); return measured;
      });
    }
  } else {
    let before;
    let bankResults;
    await check('actual onboarding loads the real study pack with no learning-record injection', async () => {
      page = await createPage('mobile'); before = await wordStateBytes(page);
      const state = JSON.parse(before); assert.deepEqual(state.modes.look.progress, {}); assert.deepEqual(state.modes.listen.progress, {});
      return { dictionaryVersion: state.dictionaryVersion, viewport: page.viewportSize() };
    });
    await check('most relevant Chinese result comes first for 有益, 放弃 and 银行', async () => {
      const examples = [['有益', 'beneficial'], ['放弃', 'abandon'], ['银行', 'bank']]; const detail = [];
      for (const [chinese, expected] of examples) {
        const actual = await query(chinese); assert.equal(actual[0], expected); assert.ok(actual.length <= 60);
        detail.push({ chinese, first: actual[0], matches: actual.length });
        await screenshot(`mobile-390-${expected}`);
      }
      return detail;
    });
    await check('English prefix bank keeps exact spelling first and alphabetical prefix results', async () => {
      bankResults = await query('bank'); assert.equal(bankResults[0], 'bank');
      assert.ok(bankResults.every(word => word.toLowerCase().startsWith('bank')));
      const alphabetical = [...bankResults].sort((a, b) => a.localeCompare(b)); assert.deepEqual(bankResults, alphabetical);
      await screenshot('actual-390-english-bank'); return { words: bankResults };
    });
    await check('IME composition waits for compositionend before exposing Chinese matches', async () => {
      const input = searchInput(page);
      await input.dispatchEvent('compositionstart', { data: '' }); await input.fill('有益');
      await page.locator('.search-caption [role="status"]').filter({ hasText: '输入中文后开始查询' }).waitFor();
      await page.waitForTimeout(650);
      assert.equal(await results(page).locator('.it').count(), 0);
      await input.dispatchEvent('compositionend', { data: '有益' });
      await page.locator('.search-caption [role="status"]').filter({ hasText: /最多 60 词/ }).waitFor();
      assert.equal(await results(page).locator('.it .w').first().evaluate(element => element.firstChild.textContent.trim()), 'beneficial');
      return { compositionWaited: true, firstAfterCommit: 'beneficial' };
    });
    await check('a real search result opens its original dictionary gloss and closes without changing progress', async () => {
      const cache = await readOwnStore(page, 'cache', 'study');
      const actual = JSON.parse(cache.text).find(word => word.word === 'beneficial'); assert.ok(actual);
      await results(page).locator('.it').first().click();
      const dialog = page.getByRole('dialog', { name: '单词详情', exact: true }); await dialog.waitFor();
      assert.equal(await dialog.locator('.d-word').innerText(), actual.word);
      const meanings = await dialog.locator('.meaning').innerText();
      for (const line of actual.translation.split('\n').filter(Boolean)) {
        const gloss = line.replace(/^[a-z]+\.\s*/, '').trim(); assert.ok(meanings.includes(gloss), `Missing actual source gloss ${gloss}`);
      }
      await screenshot('mobile-390-beneficial-detail');
      await dialog.getByRole('button', { name: '关闭弹窗', exact: true }).click();
      assert.equal(await wordStateBytes(page), before); return { sourceWord: actual.word, actualSourceTranslation: actual.translation };
    });
    await check('clear button empties the field, removes results and retains keyboard focus', async () => {
      await page.getByRole('button', { name: '清空搜索', exact: true }).click();
      assert.equal(await searchInput(page).inputValue(), ''); assert.equal(await results(page).count(), 0);
      assert.equal(await searchInput(page).evaluate(element => element === document.activeElement), true);
      return { empty: true, resultsClosed: true, focused: true };
    });
    await check('unmatched literal input has a useful empty state without fabricated translations', async () => {
      const words = await query('这是用于本项目测试且不应存在的词义xqz'); assert.deepEqual(words, []);
      assert.match(await results(page).innerText(), /没有找到匹配的词条/);
      await screenshot('mobile-390-empty-search'); return { results: 0, explanatoryEmptyState: true };
    });
    await check('390px and 320px search render loaded custom fonts without horizontal overflow', async () => {
      const values = [];
      for (const width of [390, 320]) {
        await page.setViewportSize({ width, height: 844 }); await query('有益'); values.push(await layout(page));
        await screenshot(`actual-${width}-chinese-beneficial`);
        await query('bank'); values.push(await layout(page)); await screenshot(`actual-${width}-english-bank`);
      }
      await page.setViewportSize({ width: 390, height: 844 }); return values;
    });
    await check('settings centrally exposes article backup and honest text-only retelling export', async () => {
      await page.getByRole('navigation', { name: '主导航' }).getByRole('button', { name: '设置', exact: true }).click();
      await page.getByRole('button', { name: '文章库备份', exact: true }).click();
      const articles = page.getByLabel('文章库备份操作', { exact: true }); await articles.waitFor();
      await articles.getByRole('button', { name: '导出文章备份', exact: true }).waitFor();
      assert.equal(await page.getByRole('button', { name: '文章库备份', exact: true }).getAttribute('aria-expanded'), 'true');
      await articles.scrollIntoViewIfNeeded(); await screenshot('mobile-390-settings-article-backup');
      await page.getByRole('button', { name: '复述文字备份', exact: true }).click();
      const retell = page.getByRole('region', { name: '复述文字备份操作', exact: true }); await retell.waitFor();
      assert.match(await retell.innerText(), /不含录音/); assert.match(await retell.innerText(), /不提供恢复/);
      await retell.getByRole('button', { name: '导出文字', exact: true }).waitFor();
      assert.equal(await articles.count(), 0); await retell.scrollIntoViewIfNeeded(); await screenshot('mobile-390-settings-retell-backup');
      assert.equal(await wordStateBytes(page), before);
      await page.getByRole('navigation', { name: '主导航' }).getByRole('button', { name: '学习', exact: true }).click();
      return { backupLocation: 'settings', articleExportRestore: true, retellTextOnly: true, wordProgressUnchanged: true };
    });
    await check('cached study dictionary still supports Chinese and English search after an offline reload', async () => {
      await query('有益');
      await page.evaluate(() => navigator.serviceWorker.ready.then(() => true));
      await page.waitForFunction(() => !!navigator.serviceWorker.controller, undefined, { timeout: 30_000 });
      await page.context().setOffline(true);
      try {
        await page.reload(); await page.getByRole('navigation', { name: '主导航' }).waitFor();
        assert.equal((await query('有益'))[0], 'beneficial'); assert.deepEqual(await query('bank'), bankResults);
        assert.equal(await wordStateBytes(page), before);
        return { offlineReload: true, chineseFirst: 'beneficial', englishResultsPreserved: true };
      } finally { await page.context().setOffline(false); }
    });
    await check('desktop search matches mobile order and keeps the existing 1440px layout', async () => {
      const desktop = await createPage('desktop'); const original = await wordStateBytes(desktop);
      assert.deepEqual(await query('bank', desktop), bankResults); const english = await layout(desktop); await screenshot('actual-1440-english-bank', desktop);
      assert.equal((await query('有益', desktop))[0], 'beneficial'); const chinese = await layout(desktop); await screenshot('actual-1440-chinese-beneficial', desktop);
      assert.equal(await wordStateBytes(desktop), original); return { english, chinese };
    });
    await check('search sends no query/body externally and leaves learning state byte-identical', async () => {
      assert.equal(await wordStateBytes(page), before); assert.deepEqual(report.pageErrors, []);
      assert.deepEqual(report.requests.filter(request => request.external || request.hasBody || !['GET', 'HEAD'].includes(request.method)), []);
      const queryRequests = report.requests.filter(request => ['有益', '放弃', '银行', 'bank', '这是用于本项目测试且不应存在的词义xqz'].some(term => decodeURI(request.url).includes(term)));
      assert.deepEqual(queryRequests, []);
      return { observedRequests: report.requests.length, uploadedQueries: 0, externalRequests: 0, pageErrors: 0, wordStateByteIdentical: true, offlineFontSubsetFailures: report.failedRequests.filter(request => request.fontSubset).length };
    });
  }
  report.passed = true;
} catch (error) {
  report.failure = { message: error.message, stack: error.stack }; process.exitCode = 1;
  if (page) await screenshot(`${referenceOnly ? 'reference-' : ''}failure`).catch(() => {});
  console.error(error);
} finally {
  report.finishedAt = new Date().toISOString();
  await writeFile(path.join(output, referenceOnly ? 'reference-report.json' : 'report.json'), JSON.stringify(report, null, 2));
  for (const context of contexts) await context.close();
  console.log(JSON.stringify({ passed: report.passed, checks: report.checks.length, output, referenceOnly }));
}
