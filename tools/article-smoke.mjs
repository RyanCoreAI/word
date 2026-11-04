import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium, devices } from 'playwright';

const root = fileURLToPath(new URL('../', import.meta.url));
const baseUrl = new URL(process.env.WORD_QA_URL ?? 'http://127.0.0.1:4173/');
const output = path.resolve(process.env.WORD_ARTICLE_OUTPUT ?? path.join(root, '../../outputs/word-articles'));
for (const publicPath of [path.join(root, 'dist'), path.join(root, 'apps/web/public')]) {
  const relative = path.relative(publicPath, output);
  assert.ok(relative.startsWith('..') || path.isAbsolute(relative), 'Article QA artifacts must not enter a deployed/public directory');
}
await mkdir(output, { recursive: true });
const profileParent = path.join(output, 'profiles'); await mkdir(profileParent, { recursive: true });
const report = {
  startedAt: new Date().toISOString(), url: baseUrl.href, passed: false, checks: [], screenshots: [], profiles: [],
  pageErrors: [], requests: [],
  fixture: 'Only original QA article text entered through the actual UI; real downloaded dictionary, no fabricated scores or injected learning records.',
  scope: 'Fresh task-owned Chrome profiles; no personal browser, account, existing learning record, or production write.',
  limitations: ['Android uses Chrome Pixel 7 emulation, not a physical device or installed APK.', 'This test does not establish audible speech quality, OS installation, hardware vibration or cross-device synchronization.'],
};
const contexts = [];
const ownedPages = new WeakSet();
let page;
let initialWordState;
let articleId;
let backup;
let backupPath;
const title = 'The value of regular reading';
const text = 'Regular reading helps people learn new words. Practice makes new words easier to remember. A short article can become a useful daily habit.\n\n  Reading also helps people understand different ideas. When a word appears again, its meaning becomes easier to recall.\n\nLearning takes time. A little practice every day can make real progress.';
const expectedTokens = text.trim().split(/\s+/).length;

async function check(name, run) {
  const started = Date.now();
  try {
    const detail = await run();
    const result = { name, status: 'passed', milliseconds: Date.now() - started, detail };
    report.checks.push(result); console.log(JSON.stringify(result)); return detail;
  } catch (error) {
    const result = { name, status: 'failed', milliseconds: Date.now() - started, error: error.message };
    report.checks.push(result); console.error(JSON.stringify(result)); throw error;
  }
}

async function createPage(kind) {
  const profileDirectory = await mkdtemp(path.join(profileParent, `${kind}-chrome-`));
  const options = kind === 'mobile' ? { ...devices['Pixel 7'], viewport: { width: 390, height: 844 } } : { viewport: { width: 1440, height: 1000 }, deviceScaleFactor: 1 };
  const context = await chromium.launchPersistentContext(profileDirectory, { ...options, channel: 'chrome', headless: true, timezoneId: 'America/Tijuana', serviceWorkers: 'allow', acceptDownloads: true });
  contexts.push(context); report.profiles.push({ kind, profileDirectory, viewport: options.viewport });
  context.on('request', request => {
    const requestUrl = new URL(request.url());
    report.requests.push({ kind, url: request.url(), method: request.method(), hasBody: !!request.postData(), external: ['http:', 'https:'].includes(requestUrl.protocol) && requestUrl.origin !== baseUrl.origin });
  });
  const next = context.pages()[0] ?? await context.newPage(); ownedPages.add(next); next.setDefaultTimeout(30_000);
  next.on('pageerror', error => report.pageErrors.push({ kind, error: error.message }));
  await next.goto(baseUrl.href);
  await next.getByRole('button', { name: '下载词库并开始', exact: true }).click();
  await next.getByRole('navigation', { name: '主导航', exact: true }).waitFor({ timeout: 60_000 });
  return next;
}

async function readStore(target, databaseName, storeName) {
  assert.ok(ownedPages.has(target), 'IndexedDB reads must stay inside task-owned profiles');
  return target.evaluate(({ databaseName, storeName }) => new Promise((resolve, reject) => {
    const request = indexedDB.open(databaseName);
    request.onerror = () => reject(new Error(request.error?.message));
    request.onsuccess = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains(storeName)) { db.close(); reject(new Error(`Missing store ${storeName}`)); return; }
      const tx = db.transaction(storeName); const read = tx.objectStore(storeName).get('current'); let value;
      read.onsuccess = () => { value = read.result; };
      tx.oncomplete = () => { db.close(); resolve(value); };
      tx.onabort = () => { db.close(); reject(new Error(tx.error?.message)); };
    };
  }), { databaseName, storeName });
}
const wordState = target => readStore(target, 'yanxai-word-v1', 'state');
const library = (target = page) => readStore(target, 'yanxai-articles-v1', 'library');
async function waitLibrary(predicate, target = page) {
  const started = Date.now();
  while (Date.now() - started < 30_000) { const value = await library(target); if (value && predicate(value)) return value; await target.waitForTimeout(60); }
  throw new Error('Saved article library did not reach the expected real UI result');
}
async function navReading(target = page) { await target.getByRole('navigation', { name: '主导航' }).getByRole('button', { name: '阅读', exact: true }).click(); await target.locator('.article-library').waitFor(); }
async function backToMaterials(target = page) {
  const back = target.getByRole('button', { name: '返回阅读材料', exact: true });
  if (await back.count()) await back.click();
  const reviewBack = target.getByRole('button', { name: '返回文章生词本', exact: true });
  if (await reviewBack.count()) await reviewBack.click();
  await target.getByRole('button', { name: '我的材料', exact: true }).click();
}
async function reportReady(target = page) { await target.locator('.article-report').waitFor({ timeout: 60_000 }); await target.locator('.article-loading').waitFor({ state: 'detached' }); }
async function readerReady(target = page) { await target.locator('.article-token').first().waitFor({ timeout: 60_000 }); await target.locator('.article-loading').waitFor({ state: 'detached' }); }
async function material(name, target = page) { return target.locator('.article-material').filter({ has: target.getByRole('heading', { name, exact: true }) }); }
async function closeSheet(target = page) { await target.getByRole('dialog', { name: '文章词义', exact: true }).getByRole('button', { name: '关闭弹窗', exact: true }).click(); }
async function backupSettings(target = page) {
  await target.getByRole('navigation', { name: '主导航' }).getByRole('button', { name: '设置', exact: true }).click();
  const expand = target.getByRole('button', { name: '文章库备份', exact: true });
  if (await expand.getAttribute('aria-expanded') !== 'true') await expand.click();
  const actions = target.getByLabel('文章库备份操作', { exact: true }); await actions.waitFor(); return actions;
}
async function screenshot(name, target = page) {
  await target.evaluate(() => document.fonts.ready.then(() => true));
  const filename = `${name}.png`; await target.screenshot({ path: path.join(output, filename), animations: 'disabled' }); report.screenshots.push({ name, file: filename, viewport: target.viewportSize() });
}
async function layout(target, name) {
  await target.evaluate(() => document.fonts.ready.then(() => true));
  const measured = await target.evaluate(() => {
    const visible = [...document.querySelectorAll('.article-library,.article-detail,.article-review,.dialog')].filter(element => element.getBoundingClientRect().width && element.getBoundingClientRect().height);
    return { width: innerWidth, documentWidth: document.documentElement.scrollWidth, panels: visible.map(element => ({ selector: element.className, width: element.clientWidth, contentWidth: element.scrollWidth })), bodyFont: getComputedStyle(document.body).fontFamily,
      serifFont: document.querySelector('.article-english-title,.article-title-input') ? getComputedStyle(document.querySelector('.article-english-title,.article-title-input')).fontFamily : '',
      chineseLoaded: [...document.fonts].some(face => face.family.includes('Noto Sans SC') && face.status === 'loaded'), serifLoaded: [...document.fonts].some(face => face.family.includes('Source Serif 4') && face.status === 'loaded') };
  });
  assert.ok(measured.documentWidth <= measured.width + 1, `${name}: document overflow`);
  for (const panel of measured.panels) assert.ok(panel.contentWidth <= panel.width + 1, `${name}: ${panel.selector} overflow`);
  assert.match(measured.bodyFont, /Noto Sans SC/); assert.match(measured.serifFont, /Source Serif 4/);
  assert.equal(measured.chineseLoaded, true); assert.equal(measured.serifLoaded, true);
  return measured;
}

try {
  await check('fresh isolated Android Chrome downloads the real study dictionary and keeps an empty reading history', async () => {
    page = await createPage('mobile'); initialWordState = await wordState(page);
    assert.deepEqual(initialWordState.modes.look.progress, {}); assert.deepEqual(initialWordState.modes.listen.progress, {});
    await navReading(); await waitLibrary(value => value.articles.length === 0 && value.vocabulary.length === 0);
    assert.equal(await page.locator('.article-menu').count(), 0); assert.equal(await page.getByRole('button', { name: '导出文章备份', exact: true }).count(), 0);
    await screenshot('01-mobile-materials');
    return { actualDictionaryVersion: initialWordState.dictionaryVersion, userRecordsInjected: false, viewport: page.viewportSize() };
  });
  await check('paste import persists the original article before analysis', async () => {
    await page.getByRole('textbox', { name: '文章标题', exact: true }).fill(title);
    await page.getByRole('textbox', { name: '英文文章正文', exact: true }).fill(text);
    await page.getByRole('button', { name: '导入并分析', exact: true }).click();
    const saved = await waitLibrary(value => value.articles.length === 1); articleId = saved.articles[0].id;
    assert.equal(saved.articles[0].text, text); assert.equal(saved.articles[0].sourceFormat, 'paste'); await reportReady();
    return { articleId, paragraphs: 3, expectedTokenOccurrences: expectedTokens };
  });
  await check('report counts real token occurrences and does not call unseen words mastered', async () => {
    const caption = await page.locator('.article-detail > .article-caption').innerText();
    assert.match(caption, new RegExp(`^${expectedTokens} 词`));
    const counts = await page.locator('.article-stat-grid strong').allTextContents();
    assert.equal(Number(counts[0]), 0); assert.equal(Number(counts[1]), 0);
    const extra = await page.locator('.article-extra-stats').innerText(); const unmatched = Number(extra.match(/词典未匹配\s+(\d+)/)?.[1] ?? -1);
    assert.equal(Number(counts[2]) + unmatched, expectedTokens);
    assert.match(await page.locator('.article-report').innerText(), /先确认/); await screenshot('02-mobile-analysis');
    return { caption, familiar: Number(counts[0]), review: Number(counts[1]), unconfirmed: Number(counts[2]), unmatched };
  });
  await check('duplicate content after BOM/CRLF normalization opens the saved article without duplicating it', async () => {
    await backToMaterials();
    await page.getByRole('textbox', { name: '文章标题', exact: true }).fill('Duplicate title must not overwrite the original');
    await page.getByRole('textbox', { name: '英文文章正文', exact: true }).fill(`\uFEFF${text.replaceAll('\n', '\r\n')}  `);
    await page.getByRole('button', { name: '导入并分析', exact: true }).click(); await reportReady();
    const saved = await library(); assert.equal(saved.articles.length, 1); assert.equal(saved.articles[0].title, title); assert.equal(saved.articles[0].id, articleId);
    return { deduplicated: true, titlePreserved: true };
  });
  await check('original-word lookup shows actual Chinese and saves a contextual vocabulary item without changing word-book history', async () => {
    await page.getByRole('button', { name: '开始阅读', exact: true }).click(); await readerReady();
    await page.getByRole('button', { name: '查询 Practice', exact: true }).click();
    const sheet = page.getByRole('dialog', { name: '文章词义', exact: true }); await sheet.locator('.meaning').first().waitFor();
    await sheet.getByText('查看原句', { exact: true }).click();
    assert.match(await sheet.locator('.article-source-sentence').innerText(), /Practice makes new words/);
    assert.match(await sheet.locator('.meaning').first().innerText(), /[\u4e00-\u9fff]/);
    await sheet.getByRole('button', { name: '此处不懂', exact: true }).click();
    await waitLibrary(value => value.articles[0].overrides.practice === 'unknown');
    await page.getByRole('button', { name: '查询 Practice', exact: true }).click();
    await page.getByRole('dialog', { name: '文章词义', exact: true }).getByRole('button', { name: '加入文章生词本', exact: true }).click();
    const saved = await waitLibrary(value => value.vocabulary.length === 1);
    assert.equal(saved.vocabulary[0].word.word, 'practice'); assert.equal(saved.vocabulary[0].occurrences, 2);
    assert.deepEqual(await wordState(page), initialWordState); await screenshot('03-mobile-reader');
    return { word: saved.vocabulary[0].word.word, occurrences: saved.vocabulary[0].occurrences, originalWordBookUntouched: true };
  });
  await check('indented paragraph vocabulary and reading position save successfully', async () => {
    await page.getByRole('button', { name: '下一段', exact: true }).click();
    await waitLibrary(value => value.articles[0].readParagraph === 1);
    await page.getByRole('button', { name: '查询 ideas', exact: true }).click();
    const sheet = page.getByRole('dialog', { name: '文章词义', exact: true });
    if (await sheet.getByRole('combobox', { name: '选择可能词条', exact: true }).count()) await sheet.getByRole('combobox', { name: '选择可能词条', exact: true }).selectOption({ label: 'idea' }).catch(async () => { await sheet.getByRole('combobox').selectOption({ index: 1 }); });
    await sheet.getByRole('button', { name: '加入文章生词本', exact: true }).click();
    const saved = await waitLibrary(value => value.vocabulary.length === 2);
    assert.equal(saved.vocabulary[1].paragraphIndex, 1); assert.ok(saved.vocabulary[1].sentence.startsWith('Reading'));
    return { readParagraph: 1, indentedSourceAccepted: true };
  });
  await check('article vocabulary lists genuine sources independently from the selected word book', async () => {
    await page.getByRole('button', { name: '文章生词本', exact: true }).click();
    assert.equal(await page.locator('.article-vocab-row').count(), 2);
    assert.match(await page.locator('.article-library').innerText(), /不计入当前词书今日目标/); await screenshot('04-mobile-vocabulary');
    return { vocabulary: 2, sourceShown: true };
  });
  await check('unknown reveals immediately and two consecutive known answers complete each article word', async () => {
    await page.getByRole('button', { name: /^开始复习/ }).click();
    await page.getByRole('button', { name: '不认识', exact: true }).click();
    await page.locator('.article-review-card .meaning').first().waitFor();
    await waitLibrary(value => value.vocabulary[0].progress.wrongCount === 1);
    await page.getByRole('button', { name: '继续，稍后再认', exact: true }).click();
    for (let answered = 0; answered < 4; answered++) {
      await page.waitForTimeout(400); await page.getByRole('button', { name: '认识', exact: true }).click();
      await waitLibrary(value => value.vocabulary.reduce((sum, item) => sum + item.progress.rightCount, 0) === answered + 1);
    }
    await page.getByRole('heading', { name: '这一轮已完成', exact: true }).waitFor();
    const saved = await library(); assert.ok(saved.vocabulary.every(item => item.progress.streak === 2));
    assert.equal(saved.vocabulary[0].progress.wrongCount, 1); assert.equal(saved.vocabulary[0].progress.rightCount, 2);
    assert.deepEqual(await wordState(page), initialWordState);
    return { firstWord: saved.vocabulary[0].progress, secondWord: saved.vocabulary[1].progress, wordBookUnchanged: true };
  });
  await check('refresh restores the real saved paragraph and article word counters', async () => {
    await page.reload(); await page.getByRole('navigation', { name: '主导航' }).waitFor(); await navReading();
    await (await material(title)).getByRole('button', { name: '继续阅读', exact: true }).click(); await readerReady();
    assert.equal(await page.getByRole('combobox', { name: '阅读段落', exact: true }).inputValue(), '1');
    assert.match(await page.locator('.article-original').innerText(), /Reading also helps people/);
    assert.ok((await library()).vocabulary.every(item => item.progress.streak === 2));
    return { readParagraph: 1, countersRestored: true };
  });
  await check('UTF-8 TXT file import uses actual file input and rejects invalid encoding without deleting articles', async () => {
    await backToMaterials();
    const input = page.locator('input[type=file][accept^=".txt"]');
    await input.setInputFiles({ name: 'bad-encoding.txt', mimeType: 'text/plain', buffer: Buffer.from([0xff, 0xff]) });
    await page.getByRole('alert').filter({ hasText: 'UTF-8' }).waitFor(); assert.equal((await library()).articles.length, 1);
    const txt = '\uFEFFLearning from real materials helps us remember words.\r\n\r\n  Practice makes language useful.';
    await input.setInputFiles({ name: 'UTF-8 reading.txt', mimeType: 'text/plain', buffer: Buffer.from(txt, 'utf8') });
    const expectedTxt = txt.replace(/^\uFEFF/, '').replaceAll('\r\n', '\n');
    await page.waitForFunction(expected => document.querySelector('textarea[aria-label="英文文章正文"]')?.value === expected, expectedTxt);
    assert.equal(await page.getByRole('textbox', { name: '英文文章正文', exact: true }).inputValue(), expectedTxt);
    await page.getByRole('button', { name: '导入并分析', exact: true }).click(); await reportReady();
    const saved = await library(); assert.equal(saved.articles.length, 2); assert.equal(saved.articles[1].sourceFormat, 'txt');
    return { UTF8Bom: true, CRLFNormalized: true, encodingFailurePreservedExistingArticles: true };
  });
  await check('article backup exports all text, flags, positions and review records', async () => {
    await backToMaterials(); const actions = await backupSettings(); const downloading = page.waitForEvent('download');
    await actions.getByRole('button', { name: '导出文章备份', exact: true }).click(); const download = await downloading;
    backupPath = path.join(output, 'article-library-backup.json');
    try { await download.saveAs(backupPath); report.nativeDownload = { status: 'saved', actualSaveActionInvoked: true }; }
    catch (error) {
      if (!/canceled|cancelled/i.test(error.message) || !download.url().startsWith('blob:')) throw error;
      // Exercise the product's real text-export fallback without fetching a
      // Blob URL, which the production CSP intentionally does not permit.
      await actions.getByRole('button', { name: '复制备份文本', exact: true }).click();
      const textExport = page.getByRole('dialog', { name: '文章库备份文本', exact: true });
      await textExport.waitFor();
      const generatedText = await textExport.getByRole('textbox', { name: '文章备份文本', exact: true }).inputValue();
      await textExport.getByRole('button', { name: '关闭弹窗', exact: true }).click();
      await writeFile(backupPath, generatedText);
      report.nativeDownload = { status: 'environment-canceled', actualSaveActionInvoked: true, error: error.message, fallback: 'Actual text-backup modal JSON saved by the test harness for strict restore checks. Blob fetching and browser/OS saving are not claimed.' };
      report.limitations.push('Chrome canceled the native JSON download. The actual product text-export fallback and restoration were verified; browser/OS file saving remains unverified.');
    }
    backup = JSON.parse(await readFile(backupPath, 'utf8'));
    assert.equal(backup.format, 'yanxai-article-library-backup'); assert.equal(backup.library.articles.length, 2); assert.equal(backup.library.vocabulary.length, 2);
    assert.equal(backup.library.articles[0].readParagraph, 1); assert.equal(backup.library.articles[0].overrides.practice, 'known');
    assert.equal(backup.library.vocabulary[0].progress.wrongCount, 1); assert.equal(backup.state, undefined);
    return { filename: path.basename(backupPath), articles: 2, vocabulary: 2, wordBookExcluded: true, backupOnlyInSettings: true };
  });
  await check('restore rejects altered hashes and only replaces articles after explicit preview confirmation', async () => {
    const altered = structuredClone(backup); altered.library.articles[0].text += ' Altered text.';
    await page.locator('input[type=file][accept^=".json"]').setInputFiles({ name: 'altered.json', mimeType: 'application/json', buffer: Buffer.from(JSON.stringify(altered)) });
    await page.getByRole('alert').filter({ hasText: '备份无效' }).waitFor(); assert.equal((await library()).articles.length, 2);
    await navReading();
    await page.getByRole('button', { name: `删除文章 ${title}`, exact: true }).click();
    await page.getByRole('dialog', { name: '删除这篇文章？', exact: true }).getByRole('button', { name: '确认删除', exact: true }).click();
    await waitLibrary(value => value.articles.length === 1 && value.vocabulary.length === 0);
    await backupSettings();
    await page.locator('input[type=file][accept^=".json"]').setInputFiles(backupPath);
    await page.getByRole('dialog', { name: '确认恢复文章库', exact: true }).waitFor(); assert.equal((await library()).articles.length, 1);
    await page.getByRole('button', { name: '确认替换文章库', exact: true }).click();
    const saved = await waitLibrary(value => value.articles.length === 2 && value.vocabulary.length === 2);
    const content = value => ({ articles: value.articles, vocabulary: value.vocabulary }); assert.deepEqual(content(saved), content(backup.library));
    assert.deepEqual(await wordState(page), initialWordState);
    assert.equal(await page.locator('.article-library').count(), 0); await navReading();
    return { invalidHashRejected: true, previewBeforeWrite: true, fullContentRestored: true, wordBookUnchanged: true };
  });
  await check('imported HTML and script are plain text and cannot execute or load image URLs', async () => {
    const xssText = '<img src=x onerror="window.__articleXss=1"><script>window.__articleXss=2</script>\n\nPlain English remains plain text.';
    await page.getByRole('textbox', { name: '文章标题', exact: true }).fill('Plain text security check');
    await page.getByRole('textbox', { name: '英文文章正文', exact: true }).fill(xssText);
    await page.getByRole('button', { name: '导入并分析', exact: true }).click(); await reportReady();
    await page.getByRole('button', { name: '开始阅读', exact: true }).click(); await readerReady();
    assert.equal(await page.locator('.article-original img,.article-original script').count(), 0);
    assert.match(await page.locator('.article-original').innerText(), /<img src=x/);
    assert.equal(await page.evaluate(() => globalThis.__articleXss ?? null), null);
    assert.equal(report.requests.some(request => new URL(request.url).pathname === '/x'), false);
    return { scriptsExecuted: false, htmlRendered: false, remoteResourceFromArticleRequested: false };
  });
  await check('320px and 390px Android reader and report keep loaded Claude fonts without horizontal overflow', async () => {
    const values = [];
    for (const width of [320, 390]) {
      await page.setViewportSize({ width, height: 844 }); values.push({ view: 'reader', ...await layout(page, `reader-${width}`) });
      await page.getByRole('button', { name: '查看分析', exact: true }).click(); await reportReady(); values.push({ view: 'report', ...await layout(page, `report-${width}`) });
      await screenshot(`mobile-${width}-report`); await page.getByRole('button', { name: '开始阅读', exact: true }).click(); await readerReady();
    }
    return values;
  });
  await check('cached reading data supports reanalysis while the isolated Chrome context is offline', async () => {
    await backToMaterials(); await page.context().setOffline(true);
    try {
      await (await material(title)).getByRole('button', { name: '分析报告', exact: true }).click(); await reportReady();
      assert.match(await page.locator('.article-detail > .article-caption').innerText(), new RegExp(`^${expectedTokens} 词`));
      return { offline: true, actualCachedDictionary: true, articleStillLocal: true };
    } finally { await page.context().setOffline(false); }
  });
  await check('desktop Chrome restores the same real backup through UI and renders without overflow', async () => {
    const desktop = await createPage('desktop'); const before = await wordState(desktop); await navReading(desktop); await waitLibrary(value => value.articles.length === 0, desktop);
    await backupSettings(desktop);
    await desktop.locator('input[type=file][accept^=".json"]').setInputFiles(backupPath);
    await desktop.getByRole('button', { name: '确认替换文章库', exact: true }).click(); await waitLibrary(value => value.articles.length === 2, desktop);
    assert.equal(await desktop.locator('.article-library').count(), 0); await navReading(desktop);
    await (await material(title, desktop)).getByRole('button', { name: '分析报告', exact: true }).click(); await reportReady(desktop);
    const measured = await layout(desktop, 'desktop-report'); await screenshot('05-desktop-analysis', desktop); assert.deepEqual(await wordState(desktop), before);
    return { ...measured, separateProfile: true, backupImportedViaUI: true };
  });
  await check('all article operations leave word-book progress unchanged and send no imported content or external requests', async () => {
    assert.deepEqual(await wordState(page), initialWordState); assert.deepEqual(report.pageErrors, []);
    assert.deepEqual(report.requests.filter(request => request.external), []);
    assert.deepEqual(report.requests.filter(request => request.hasBody || !['GET', 'HEAD'].includes(request.method)), []);
    return { requestsObserved: report.requests.length, externalRequests: 0, requestsWithBody: 0, pageErrors: 0, originalWordBookUnchanged: true };
  });
  report.passed = true;
} catch (error) {
  report.failure = { message: error.message, stack: error.stack }; process.exitCode = 1;
  if (page) await screenshot('failure').catch(() => {}); console.error(error);
} finally {
  report.finishedAt = new Date().toISOString(); await writeFile(path.join(output, 'report.json'), JSON.stringify(report, null, 2));
  for (const context of contexts) await context.close();
  console.log(JSON.stringify({ passed: report.passed, checks: report.checks.length, output }));
}
