import { chromium } from 'playwright';
import assert from 'node:assert/strict';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// Independent ephemeral Chrome profile. All IndexedDB mutations below belong only
// to this automated acceptance context, never to an existing user's browser.
const root = fileURLToPath(new URL('../', import.meta.url));
const url = process.env.WORD_QA_URL ?? 'http://127.0.0.1:4173/';
const output = path.resolve(process.env.WORD_QA_OUTPUT ?? path.join(root, '../../outputs/word-qa'));
await mkdir(output, { recursive: true });
const report = { startedAt: new Date().toISOString(), url, checks: [], errors: [], requests: [], failedRequests: [], consoleErrors: [] };
const browser = await chromium.launch({ channel: 'chrome', headless: true });
const context = await browser.newContext({ viewport: { width: 430, height: 932 }, acceptDownloads: true, serviceWorkers: 'allow' });
await context.addInitScript(() => {
  globalThis.__qaGeneratedBlobs = [];
  const original = URL.createObjectURL.bind(URL);
  URL.createObjectURL = blob => {
    const objectUrl = original(blob);
    if (blob instanceof Blob && blob.type.startsWith('application/json')) void blob.text().then(text => globalThis.__qaGeneratedBlobs.push({ type: blob.type, text }));
    return objectUrl;
  };
});
const page = await context.newPage();
page.setDefaultTimeout(20_000);
context.on('page', candidate => candidate.on('pageerror', error => report.errors.push(error.message)));
page.on('pageerror', error => report.errors.push(error.message));
page.on('requestfailed', request => report.failedRequests.push({ url: request.url(), failure: request.failure() }));
page.on('console', message => { if (message.type() === 'error') report.consoleErrors.push(message.text()); });
page.on('request', request => { if (request.url().includes('/data/')) report.requests.push(request.url()); });
const started = Date.now();
async function check(name, action) {
  const begin = Date.now();
  const detail = await action();
  report.checks.push({ name, status: 'passed', milliseconds: Date.now() - begin, detail });
  console.log(JSON.stringify({ check: name, status: 'passed', detail }));
}
async function databaseRead(candidate, storeName, key) {
  return candidate.evaluate(({ storeName, key }) => new Promise((resolve, reject) => {
    const request = indexedDB.open('yanxai-word-v1');
    request.onerror = () => reject(request.error?.message);
    request.onsuccess = () => {
      const db = request.result; const tx = db.transaction(storeName, 'readonly');
      const read = key === undefined ? tx.objectStore(storeName).getAll() : tx.objectStore(storeName).get(key);
      let value; read.onsuccess = () => { value = read.result; };
      tx.oncomplete = () => { db.close(); resolve(value); };
      tx.onabort = () => { db.close(); reject(tx.error?.message); };
    };
  }), { storeName, key });
}
const state = candidate => databaseRead(candidate ?? page, 'state', 'current');
async function waitState(predicate, candidate = page, timeout = 20_000) {
  const begin = Date.now();
  for (;;) {
    const value = await state(candidate);
    if (predicate(value)) return value;
    if (Date.now() - begin > timeout) throw new Error('Timed out waiting for persisted state');
    await new Promise(resolve => setTimeout(resolve, 50));
  }
}
async function navigate(name, candidate = page) { await candidate.getByRole('navigation', { name: '主导航' }).getByRole('button', { name, exact: true }).click(); }
async function saveGeneratedDownload(button, file) {
  const before = await page.evaluate(() => globalThis.__qaGeneratedBlobs.length);
  const downloaded = page.waitForEvent('download');
  await button.click();
  const download = await downloaded;
  try {
    await download.saveAs(file);
    report.nativeDownloads ??= [];
    report.nativeDownloads.push({ file: path.basename(file), status: 'saved' });
  } catch (error) {
    if (!/canceled|cancelled/i.test(error.message)) throw error;
    await page.waitForFunction(count => globalThis.__qaGeneratedBlobs.length > count, before);
    const generated = await page.evaluate(() => globalThis.__qaGeneratedBlobs.at(-1));
    await writeFile(file, generated.text);
    report.nativeDownloads ??= [];
    report.nativeDownloads.push({ file: path.basename(file), status: 'environment-canceled', fallback: 'Observed actual app-generated JSON Blob; saved by test harness for subsequent import. Native saving is NOT verified.' });
  }
}
async function exportBackup() {
  await navigate('设置');
  const file = path.join(output, 'offline-valid-backup.json');
  await saveGeneratedDownload(page.getByRole('button', { name: '导出完整备份', exact: true }), file);
  return { file, backup: JSON.parse(await readFile(file, 'utf8')) };
}
let manifest;
let currentWord;
let pausedReceipts;
try {
  await check('first download and service worker control', async () => {
    await page.goto(url);
    await page.getByRole('button', { name: '下载词库并开始', exact: true }).waitFor();
    assert.equal(report.requests.length, 0, 'No dictionary fetch before the user starts');
    await page.getByRole('button', { name: '下载词库并开始', exact: true }).click();
    await page.locator('.continue').waitFor();
    manifest = (await databaseRead(page, 'cache', 'study')).manifest;
    const worker = await page.evaluate(async () => {
      const registration = await navigator.serviceWorker.ready;
      return { state: registration.active?.state, scriptURL: registration.active?.scriptURL };
    });
    await page.waitForFunction(() => navigator.serviceWorker.controller !== null);
    report.cacheProbe = await page.evaluate(async () => {
      const result = [];
      for (const name of await globalThis.caches.keys()) {
        const cache = await globalThis.caches.open(name);
        for (const request of await cache.keys()) {
          if (!/\.(js|css)$/.test(request.url)) continue;
          const ordinary = await cache.match(request.url);
          const cors = new Request(request.url, { headers: { Origin: location.origin } });
          result.push({ name, url: request.url, vary: ordinary?.headers.get('vary'), precacheOrigin: request.headers.get('origin'), corsOrigin: cors.headers.get('origin'), ordinaryMatch: !!ordinary, corsMatch: !!await cache.match(cors), ignoreVaryMatch: !!await cache.match(cors, { ignoreVary: true }) });
        }
      }
      return result;
    }).catch(error => ({ error: error.message }));
    console.log(JSON.stringify({ cacheProbe: report.cacheProbe }));
    await navigate('设置');
    await page.getByRole('switch', { name: '自动朗读', exact: true }).click();
    await waitState(value => value.settings.autoSpeak === false);
    await navigate('学习');
    await page.locator('.continue').click();
    currentWord = await page.locator('h2.word').innerText();
    await page.getByRole('button', { name: '不认识', exact: true }).click();
    await page.locator('.meaning').waitFor();
    const saved = await waitState(value => value.modes.look.session?.revealed === true);
    const id = saved.modes.look.session.items[saved.modes.look.session.cursor];
    assert.equal(saved.modes.look.progress[id].wrongCount, 1);
    report.dictionaryVersion = manifest.version;
    return { worker, dictionaryVersion: manifest.version, studyCount: manifest.studyCount, word: currentWord, revision: saved.revision };
  });

  await check('offline reload restores the same revealed word and counts', async () => {
    const before = await state();
    await context.setOffline(true);
    await page.reload();
    await page.locator('.continue').waitFor();
    assert.deepEqual(await state(), before);
    await page.locator('.continue').click();
    await page.locator('.meaning').waitFor();
    assert.equal(await page.locator('h2.word').innerText(), currentWord);
    assert.deepEqual(await state(), before);
    await page.screenshot({ path: path.join(output, 'offline-restored-word.png'), fullPage: true });
    await page.getByRole('button', { name: '返回首页', exact: true }).click();
    return { word: currentWord, revealed: before.modes.look.session.revealed, wrongCount: before.modes.look.progress[currentWord]?.wrongCount };
  });

  await check('stale second tab cannot overwrite the first tab', async () => {
    const second = await context.newPage(); second.setDefaultTimeout(20_000);
    try {
      await second.goto(url); await second.locator('.continue').waitFor();
      await navigate('设置'); await navigate('设置', second);
      const before = await state();
      await page.getByRole('button', { name: '10', exact: true }).click();
      const winner = await waitState(value => value.revision > before.revision && value.settings.groupSize === 10);
      await second.getByRole('button', { name: '30', exact: true }).click();
      await second.getByRole('alert').filter({ hasText: '另一窗口' }).waitFor();
      assert.deepEqual(await state(), winner);
      await second.screenshot({ path: path.join(output, 'offline-tab-conflict.png'), fullPage: true });
      await second.getByRole('button', { name: '重新载入进度', exact: true }).click();
      await second.locator('.continue').waitFor();
      return { revision: winner.revision, groupSize: winner.settings.groupSize };
    } finally { await second.close(); }
  });

  await check('full dictionary pauses after committed shards', async () => {
    await context.setOffline(false);
    // A small network delay makes the user pause reproducible without altering app code.
    await context.route('**/shard-*.json', async route => {
      await new Promise(resolve => setTimeout(resolve, 100));
      try { await route.continue(); } catch { /* The UI intentionally aborts an in-flight fetch. */ }
    });
    await page.getByRole('button', { name: '下载 / 继续下载完整词典', exact: true }).click();
    const begin = Date.now();
    for (;;) {
      if ((await databaseRead(page, 'chunks')).length >= 2) break;
      if (Date.now() - begin > 30_000) throw new Error('No two dictionary shards committed within 30 seconds');
      await new Promise(resolve => setTimeout(resolve, 50));
    }
    await page.getByRole('button', { name: '暂停下载', exact: true }).click();
    await page.getByRole('button', { name: '下载 / 继续下载完整词典', exact: true }).waitFor();
    await context.unroute('**/shard-*.json');
    pausedReceipts = await databaseRead(page, 'chunks');
    assert.ok(pausedReceipts.length >= 2 && pausedReceipts.length < manifest.shards.length);
    await page.screenshot({ path: path.join(output, 'offline-download-paused.png'), fullPage: true });
    return { completed: pausedReceipts.length, total: manifest.shards.length };
  });

  await check('full dictionary resumes to all real database rows', async () => {
    const requestStart = report.requests.length;
    await page.getByRole('button', { name: '下载 / 继续下载完整词典', exact: true }).click();
    await page.getByText('完整词典已保存在本机，可以离线查词', { exact: true }).waitFor({ timeout: 240_000 });
    const receipts = await databaseRead(page, 'chunks');
    assert.equal(receipts.length, manifest.shards.length);
    assert.equal(receipts.reduce((sum, receipt) => sum + receipt.count, 0), manifest.total);
    const actualRows = await page.evaluate(() => new Promise((resolve, reject) => {
      const request = indexedDB.open('yanxai-word-v1');
      request.onsuccess = () => {
        const db = request.result; const tx = db.transaction('dictionary'); const count = tx.objectStore('dictionary').count();
        count.onsuccess = () => resolve(count.result); tx.oncomplete = () => db.close(); tx.onabort = () => reject(tx.error?.message);
      };
    }));
    assert.equal(actualRows, manifest.total);
    const resumedRequests = report.requests.slice(requestStart);
    for (const receipt of pausedReceipts) assert.ok(!resumedRequests.some(request => request.endsWith(receipt.id)), `Completed shard downloaded twice: ${receipt.id}`);
    await page.screenshot({ path: path.join(output, 'offline-download-complete.png'), fullPage: true });
    return { shardCount: receipts.length, actualRows, resumedRequests: resumedRequests.length };
  });

  await check('offline prefix search uses the downloaded full dictionary', async () => {
    await context.setOffline(true); await page.reload(); await page.locator('.continue').waitFor();
    await page.getByRole('searchbox', { name: '搜索词典 · 输入英文单词', exact: true }).fill('bank');
    const results = page.locator('.home-search-results');
    await results.locator('.it .w').filter({ hasText: /^bank(?:\/|$)/ }).first().waitFor();
    const matches = await results.locator('.it .w').evaluateAll(nodes => nodes.map(node =>
      [...node.childNodes].filter(child => child.nodeType === Node.TEXT_NODE).map(child => child.textContent).join('').trim()));
    assert.ok(matches.includes('bank')); assert.ok(matches.every(word => word.toLowerCase().startsWith('bank')));
    const study = JSON.parse((await databaseRead(page, 'cache', 'study')).text);
    const studySpellings = new Set(study.map(word => word.word));
    const fullDictionaryOnly = matches.filter(word => !studySpellings.has(word));
    assert.ok(fullDictionaryOnly.length > 0, 'Search must include real downloaded dictionary entries outside the study pack');
    await page.screenshot({ path: path.join(output, 'offline-prefix-search.png'), fullPage: true });
    return { prefix: 'bank', returned: matches.length, first: matches.slice(0, 5), fullDictionaryOnly: fullDictionaryOnly.slice(0, 5) };
  });

  await check('offline license navigation returns license text rather than the app shell', async () => {
    await navigate('设置');
    const opened = page.waitForEvent('popup');
    await page.getByRole('link', { name: '词典许可', exact: true }).click();
    const licensePage = await opened;
    try {
      await licensePage.waitForLoadState('domcontentloaded');
      const text = await licensePage.locator('body').innerText();
      assert.match(text, /Permission is hereby granted/);
      return { url: licensePage.url(), characters: text.length };
    } finally { await licensePage.close(); }
  });

  await check('damaged state can be exported and restored from a confirmed valid backup', async () => {
    const { file, backup } = await exportBackup();
    const original = backup.state;
    const damaged = { ...original, settings: { intentionallyCorruptedForIsolatedTest: true } };
    await page.evaluate(value => new Promise((resolve, reject) => {
      const request = indexedDB.open('yanxai-word-v1');
      request.onsuccess = () => {
        const db = request.result; const tx = db.transaction('state', 'readwrite'); tx.objectStore('state').put(value, 'current');
        tx.oncomplete = () => { db.close(); resolve(); }; tx.onabort = () => { db.close(); reject(tx.error?.message); };
      };
    }), damaged);
    await page.reload();
    await page.getByRole('button', { name: '导出原始记录留存', exact: true }).waitFor();
    assert.deepEqual(await state(), damaged, 'Failed startup must preserve damaged data');
    const rawFile = path.join(output, 'offline-corrupted-record.json');
    await saveGeneratedDownload(page.getByRole('button', { name: '导出原始记录留存', exact: true }), rawFile);
    assert.deepEqual(JSON.parse(await readFile(rawFile, 'utf8')), damaged);
    await page.getByRole('button', { name: '从完整备份恢复', exact: true }).click();
    await page.getByLabel('选择学习备份文件').setInputFiles(file);
    await page.getByRole('dialog', { name: '恢复学习备份' }).waitFor();
    assert.deepEqual(await state(), damaged, 'Previewing a backup must not change state');
    await page.getByRole('button', { name: '确认恢复备份', exact: true }).click();
    await page.locator('.continue').waitFor();
    const restored = await state();
    assert.deepEqual({ ...restored, revision: original.revision, updatedAt: original.updatedAt }, original);
    assert.ok(restored.revision > original.revision);
    await page.locator('.continue').click(); await page.locator('.meaning').waitFor();
    assert.equal(await page.locator('h2.word').innerText(), currentWord);
    await page.screenshot({ path: path.join(output, 'offline-backup-recovered.png'), fullPage: true });
    return { previousRevision: original.revision, restoredRevision: restored.revision, word: currentWord, queueRestored: true };
  });

  await check('visible text backup can be pasted and restored without native file saving', async () => {
    await page.getByRole('button', { name: '返回首页', exact: true }).click();
    await navigate('设置');
    const before = await state();
    await page.getByRole('button', { name: '文本备份', exact: true }).click();
    const backupText = await page.getByRole('textbox', { name: '完整备份 JSON', exact: true }).inputValue();
    assert.deepEqual(JSON.parse(backupText).state, before);
    await page.screenshot({ path: path.join(output, 'offline-text-backup.png'), fullPage: true });
    await page.getByRole('dialog', { name: '完整备份文本' }).getByRole('button', { name: '关闭弹窗', exact: true }).click();
    await page.getByRole('button', { name: '粘贴备份恢复', exact: true }).click();
    await page.getByRole('textbox', { name: '粘贴完整备份 JSON', exact: true }).fill(backupText);
    await page.getByRole('button', { name: '校验并预览恢复', exact: true }).click();
    await page.getByRole('dialog', { name: '恢复学习备份' }).waitFor();
    assert.deepEqual(await state(), before);
    await page.getByRole('button', { name: '确认恢复备份', exact: true }).click();
    await page.locator('.continue').waitFor();
    const after = await state();
    assert.deepEqual({ ...after, revision: before.revision, updatedAt: before.updatedAt }, before);
    assert.equal(after.revision, before.revision + 1);
    return { characters: backupText.length, nativeFileSavingRequired: false, restoredRevision: after.revision };
  });
  assert.deepEqual(report.errors, [], 'Unexpected browser JavaScript errors');
  report.status = 'passed';
} catch (error) {
  report.status = 'failed'; report.failure = { message: error.message, stack: error.stack };
  console.error(error.stack);
  try {
    report.failure.pageText = (await page.locator('body').innerText()).slice(0, 6000);
    report.failure.html = (await page.content()).slice(0, 10000);
    report.failure.caches = await page.evaluate(async () => {
      const output = [];
      for (const name of await caches.keys()) { const cache = await caches.open(name); output.push({ name, keys: (await cache.keys()).map(request => request.url()) }); }
      return output;
    }).catch(error => ({ error: error.message }));
    await page.screenshot({ path: path.join(output, 'offline-failure.png'), fullPage: true });
  } catch { /* Preserve original failure. */ }
  process.exitCode = 1;
} finally {
  report.finishedAt = new Date().toISOString(); report.milliseconds = Date.now() - started;
  await writeFile(path.join(output, 'offline-report.json'), JSON.stringify(report, null, 2));
  await context.close(); await browser.close();
}
