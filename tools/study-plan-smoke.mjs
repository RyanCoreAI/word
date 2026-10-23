import assert from 'node:assert/strict';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';
import { createServer } from 'vite';

const root = fileURLToPath(new URL('../', import.meta.url));
const url = process.env.WORD_QA_URL ?? 'http://127.0.0.1:4173/';
const output = path.resolve(process.env.WORD_PLAN_OUTPUT ?? path.join(root, '../../outputs/word-study-plan/browser'));
await mkdir(output, { recursive: true });
const report = { startedAt: new Date().toISOString(), url, checks: [], errors: [], external: [], fixture: 'Synthetic QA progress only, built from real dictionary Word objects and validated core state in an isolated Chrome context.', limitations: ['Chrome touch viewport does not establish physical Android system installation, voice, OS sharing or file download acceptance.'] };
const browser = await chromium.launch({ channel: 'chrome', headless: true });
const context = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, timezoneId: 'America/Tijuana', serviceWorkers: 'allow', reducedMotion: 'no-preference' });
const page = await context.newPage(); page.setDefaultTimeout(25_000);
page.on('pageerror', error => report.errors.push(error.message));
page.on('request', request => { const resource = new URL(request.url()); if (resource.protocol.startsWith('http') && resource.origin !== new URL(url).origin) report.external.push(request.url()); });
const contracts = await createServer({ configFile: false, root, server: { middlewareMode: true, hmr: false, watch: null }, appType: 'custom' });
let core;
try { core = await contracts.ssrLoadModule('/packages/core/src/index.ts'); } finally { await contracts.close(); }
const manifest = await (await fetch(new URL('data/manifest.json', url))).json();
const study = Buffer.from(await (await fetch(new URL('data/' + manifest.study.file, url))).arrayBuffer());
assert.equal(createHash('sha256').update(study).digest('hex'), manifest.study.sha256);
const words = core.parseWords(JSON.parse(study));
const book = words.filter(word => !word.basic && word.tags.includes('ielts')); assert.equal(book.length, 4485);
const nav = title => page.getByRole('navigation', { name: '主导航' }).getByRole('button', { name: title, exact: true }).click();
const state = () => page.evaluate(() => new Promise((resolve, reject) => { const opening = indexedDB.open('yanxai-word-v1'); opening.onerror = () => reject(opening.error); opening.onsuccess = () => { const db = opening.result; const tx = db.transaction('state'); const read = tx.objectStore('state').get('current'); read.onsuccess = () => resolve(read.result); tx.oncomplete = () => db.close(); }; }));
async function inject(value) {
  const checked = core.parseAppState(value, words, manifest.version);
  await page.evaluate(data => new Promise((resolve, reject) => { const opening = indexedDB.open('yanxai-word-v1'); opening.onerror = () => reject(opening.error); opening.onsuccess = () => { const db = opening.result; const tx = db.transaction('state','readwrite'); tx.objectStore('state').put(data,'current'); tx.oncomplete = () => { db.close(); resolve(); }; tx.onerror = () => reject(tx.error); }; }), checked);
  await page.reload(); await page.locator('.continue').waitFor(); return checked;
}
async function waitState(predicate) { const limit = Date.now() + 20_000; while (Date.now() < limit) { const value = await state(); if (predicate(value)) return value; await page.waitForTimeout(40); } throw new Error('Saved plan state did not reach expected result'); }
async function shot(name) { await page.evaluate(() => document.fonts.ready.then(() => true)); await page.screenshot({ path: path.join(output, name + '.png'), animations: 'disabled' }); }
async function check(name, run) { const detail = await run(); report.checks.push({ name, status: 'passed', detail }); console.log(JSON.stringify({ name, detail })); }
const dateFromBrowser = () => page.evaluate(() => { const now = new Date(); return { now: now.getTime(), today: `${now.getFullYear()}-${String(now.getMonth()+1).padStart(2,'0')}-${String(now.getDate()).padStart(2,'0')}` }; });
let now, today, completedFixture;
function smallFixture() {
  const fresh = book.slice(-2).map(word => word.id); const due = book[0].id;
  let value = core.createInitialState(manifest.version, now);
  value.settings = { ...value.settings, deck: 'ielts', groupSize: 10, autoSpeak: false, haptics: false, soundEffects: false };
  value.modes.look.groupNumber = 1;
  for (const word of book) if (!fresh.includes(word.id)) value.modes.look.progress[word.id] = { status: 'completed', wrongCount: 0, rightCount: 1, seenCount: 1, streak: 2, lastAnsweredAt: now - 86400000, lastGroup: 1 };
  value.modes.look.progress[due] = { status: 'completed', wrongCount: 1, rightCount: 2, seenCount: 3, streak: 2, lastAnsweredAt: now - 86400000, lastGroup: 1 };
  const yesterday = core.previousLocalDateKey(today);
  value.dailyActivity[yesterday] = { [due]: { look: { known: 2, unknown: 1 }, listen: { known: 0, unknown: 0 } } };
  return { value: core.parseAppState(value, words, manifest.version), fresh, due };
}
function visualFixture() {
  const unseen = book.slice(-1200).map(word => word.id); const old = book.slice(0,-1200);
  const due = old.slice(-12).map(word => word.id);
  let value = core.createInitialState(manifest.version, now++);
  value.settings = { ...value.settings, deck: 'ielts', groupSize: 20, autoSpeak: false, haptics: false, soundEffects: false };
  value.modes.look.groupNumber = 1;
  for (const [index, word] of old.entries()) value.modes.look.progress[word.id] = index < 2671 ? { status: 'completed', wrongCount: 0, rightCount: 1, seenCount: 1, streak: 2, lastAnsweredAt: now - 86400000, lastGroup: 1 } : { status: 'learning', wrongCount: 1, rightCount: 0, seenCount: 1, streak: 0, lastAnsweredAt: now - 86400000, lastGroup: 1 };
  value.dailyActivity[core.previousLocalDateKey(today)] = Object.fromEntries(due.map(id => [id,{look:{known:0,unknown:1},listen:{known:0,unknown:0}}]));
  const deadline = new Date(Date.parse(today + 'T00:00:00Z') + 29*86400000).toISOString().slice(0,10);
  value = core.saveStudyPlan(value, words, { deck:'ielts',mode:'look',deadline }, now++,today);
  for (const id of unseen.slice(0,20)) {
    const group = ++value.modes.look.groupNumber; value.modes.look.session = { groupNumber:group,items:[id],cursor:0,revealed:false,status:'active',known:0,unknown:0,skipped:0 };
    value = core.answer(value,'look','known',core.getCurrentToken(value,'look'),now++,today);
  }
  for (const id of due.slice(0,8)) {
    const group = ++value.modes.look.groupNumber; value.modes.look.session = { groupNumber:group,items:[id],cursor:0,revealed:false,status:'active',known:0,unknown:0,skipped:0 };
    value = core.answer(value,'look','unknown',core.getCurrentToken(value,'look'),now++,today);
    value = core.nextWord(value,'look',core.getCurrentToken(value,'look'),now++);
  }
  return core.parseAppState(value,words,manifest.version);
}
try {
  await page.goto(url); await page.getByRole('button',{name:'下载词库并开始',exact:true}).click(); await page.locator('.continue').waitFor();
  ({now,today}=await dateFromBrowser());
  const fixture = smallFixture(); await inject(fixture.value);
  await check('approved card order and book scoped empty state',async()=>{
    const ring=await page.locator('.prog-panel').boundingBox(), plan=await page.getByRole('region',{name:'本书学习计划'}).boundingBox(); assert.ok(ring.y<plan.y);
    assert.match(await page.locator('.plan-empty').innerText(),/2 个新词/); assert.equal(await page.getByLabel('选择计划词书').inputValue(),'ielts');
    await shot('01-unconfigured-mobile'); return {ringAbovePlan:true,book:'ielts',realBookCount:book.length,unseen:2};
  });
  await check('real wheel controls edit/reset dates and persist only this book plan',async()=>{
    await page.getByRole('button',{name:'编辑本书学习计划',exact:true}).click();
    const dialog=page.getByRole('dialog',{name:'学习计划',exact:true}); await dialog.waitFor();
    const app=await page.locator('.app-screen').boundingBox(), box=await dialog.boundingBox(); for(const key of ['x','y','width','height'])assert.ok(Math.abs(app[key]-box[key])<=1,key);
    assert.match(await page.locator('.plan-day-total').innerText(),/30/);
    await page.getByRole('listbox',{name:'截止日',exact:true}).focus(); await page.keyboard.press('ArrowDown'); assert.match(await page.locator('.plan-day-total').innerText(),/31/);
    await page.getByRole('button',{name:'重置',exact:true}).click(); assert.match(await page.locator('.plan-day-total').innerText(),/30/);
    await shot('02-editor-mobile'); await page.setViewportSize({width:1440,height:1000}); await shot('02-editor-desktop'); await page.setViewportSize({width:390,height:844});
    await page.getByRole('button',{name:'保存计划',exact:true}).click(); await dialog.waitFor({state:'detached'});
    const saved=await waitState(value=>!!value.studyPlans['ielts:look']); const summary=core.getStudyPlanSummary(saved,words,'ielts','look',today);
    assert.equal(summary.newTarget,1);assert.equal(summary.reviewTarget,1);assert.equal(summary.remainingToday,2);assert.equal(summary.remainingDays,30);assert.equal(summary.totalDays,30);assert.deepEqual(saved.modes,fixture.value.modes);
    return {persisted:true,newTarget:1,reviewTarget:1,remainingDays:30,totalDays:30,wordProgressUnchanged:true,fullscreen:box};
  });
  let celebrationReceipt;
  await check('real answers reach goal, celebration renders without blocking, undo rolls counts back',async()=>{
    await page.getByRole('button',{name:/^看词记忆/}).click(); await page.locator('h2.word').waitFor(); assert.equal(await page.locator('h2.word').innerText(),fixture.due);
    await page.getByRole('button',{name:'认识',exact:true}).click(); await page.waitForFunction(id=>document.querySelector('h2.word')?.textContent===id,fixture.fresh[0]);
    await page.waitForTimeout(350); // Respect the app's intentional 300 ms double-tap guard.
    await page.getByRole('button',{name:'不认识',exact:true}).click();
    const saved=await waitState(value=>!!value.studyPlans['ielts:look'].days[today]?.celebratedAt); celebrationReceipt=saved.studyPlans['ielts:look'].days[today].celebratedAt;
    await page.locator('.goal-confetti').waitFor(); await page.waitForTimeout(180); const painted=await page.locator('.goal-confetti').evaluate(element=>{const data=element.getContext('2d').getImageData(0,0,element.width,element.height).data;for(let i=3;i<data.length;i+=4)if(data[i])return true;return false;});assert.equal(painted,true);await shot('03-real-confetti-mobile');
    assert.equal(await page.getByRole('button',{name:'下一个',exact:true}).isEnabled(),true);
    await page.waitForTimeout(350);
    await page.getByRole('button',{name:'撤销',exact:true}).click(); const undone=await waitState(value=>newWordAnswerWasUndone(value));
    function newWordAnswerWasUndone(value){return value.studyPlans['ielts:look'].days[today].newWordIds.length===0;}
    assert.equal(core.getStudyPlanSummary(undone,words,'ielts','look',today).remainingToday,1);assert.equal(await page.locator('.goal-confetti').count(),0);
    return {actualCanvasParticles:painted,answerActionsNotBlocked:true,undoRestoredPending:1,playedReceiptPreserved:undone.studyPlans['ielts:look'].days[today].celebratedAt===celebrationReceipt};
  });
  await check('reaching goal again does not replay, check-in persists and real share preview opens',async()=>{
    await page.waitForTimeout(350);
    await page.getByRole('button',{name:'认识',exact:true}).click(); await page.locator('.known-confirmation').waitFor(); await page.waitForTimeout(1200);
    assert.equal(await page.locator('.goal-confetti').count(),0);assert.equal((await state()).studyPlans['ielts:look'].days[today].celebratedAt,celebrationReceipt);
    await page.getByRole('button',{name:'返回首页',exact:true}).click(); await page.getByRole('button',{name:'打卡并分享',exact:true}).click();
    await page.getByRole('dialog',{name:'今日打卡',exact:true}).waitFor(); await page.getByRole('button',{name:'保存图片',exact:true}).waitFor(); await page.waitForFunction(()=>!document.querySelector('.check-in-share-secondary button').disabled);
    assert.ok((await state()).studyPlans['ielts:look'].days[today].checkedInAt); await shot('04-real-check-in-share');await page.getByRole('button',{name:'关闭弹窗',exact:true}).click();
    assert.match(await page.locator('.plan-success').innerText(),/今日已打卡/); return {receiptUnchanged:true,checkedInPersisted:true,actualPngPreview:true};
  });
  await check('check-in does not cap learning or duplicate day counts',async()=>{
    const before=await state(); await page.getByRole('button',{name:/^看词记忆/}).click(); assert.equal(await page.locator('h2.word').innerText(),fixture.fresh[1]);
    await page.getByRole('button',{name:'认识',exact:true}).click(); await page.waitForTimeout(1200); const after=await state(); const summary=core.getStudyPlanSummary(after,words,'ielts','look',today);
    assert.equal(summary.newTarget,1);assert.equal(summary.newCompleted,2);assert.equal(summary.reviewCompleted,1);assert.equal(summary.checkedIn,true);assert.equal(summary.remainingToday,0);assert.equal(summary.day.checkedInAt,before.studyPlans['ielts:look'].days[today].checkedInAt);
    completedFixture = structuredClone(after);
    await page.getByRole('button',{name:'返回首页',exact:true}).click(); await shot('05-after-goal-can-continue'); return {extraWordLearned:true,actualCompleted:3,goal:2,checkInPreserved:true};
  });
  await check('book/mode switch, full text backup and offline reload preserve independent plans',async()=>{
    await page.getByRole('button',{name:'查看听音进度',exact:true}).click();assert.equal(await page.locator('.plan-empty').count(),1);
    await page.getByRole('button',{name:'查看看词进度',exact:true}).click();assert.match(await page.locator('.plan-success').innerText(),/已打卡/);
    await page.getByLabel('选择计划词书').selectOption('cet4');await page.locator('.plan-empty').waitFor();await page.getByLabel('选择计划词书').selectOption('ielts');await page.locator('.plan-success').waitFor();
    await nav('设置');await page.getByRole('button',{name:'文本备份',exact:true}).click();const exported=JSON.parse(await page.getByRole('textbox',{name:'完整备份 JSON',exact:true}).inputValue());assert.ok(exported.state.studyPlans['ielts:look'].days[today].checkedInAt);await page.getByRole('button',{name:'关闭弹窗',exact:true}).click();await nav('学习');
    const before=await state();await page.evaluate(()=>navigator.serviceWorker.ready.then(()=>true));await page.waitForFunction(()=>navigator.serviceWorker.controller);await context.setOffline(true);await page.reload();await page.locator('.continue').waitFor();assert.deepEqual(await state(),before);assert.match(await page.locator('.plan-success').innerText(),/已打卡/);await context.setOffline(false);
    return {separateModes:true,separateBooks:true,fullBackupIncludesPlans:true,offlineStateExactlyPreserved:true};
  });
  await check('approved demonstration layout uses real rules and loads actual fonts',async()=>{
    await inject(visualFixture());await page.getByLabel('今日待学',{exact:true}).waitFor(); assert.equal(await page.getByLabel('今日待学',{exact:true}).innerText(),'24');assert.match(await page.getByLabel('计划剩余天数与总天数').innerText(),/30.*30/);
    await shot('06-approved-home-mobile');await page.setViewportSize({width:1440,height:1000});await shot('06-approved-home-desktop');await page.setViewportSize({width:390,height:844});
    await page.getByRole('button',{name:'编辑本书学习计划',exact:true}).click();await shot('07-approved-editor-mobile');
    const client=await context.newCDPSession(page);await client.send('DOM.enable');await client.send('CSS.enable');const {root:documentNode}=await client.send('DOM.getDocument');const {nodeId}=await client.send('DOM.querySelector',{nodeId:documentNode.nodeId,selector:'.plan-editor-book h3'});const {fonts}=await client.send('CSS.getPlatformFontsForNode',{nodeId});assert.ok(fonts.some(font=>font.isCustomFont&&/Noto Sans SC/i.test(font.familyName)),JSON.stringify(fonts));await client.detach();
    await page.setViewportSize({width:320,height:568});await shot('08-small-editor');const saveBox=await page.getByRole('button',{name:'保存计划',exact:true}).boundingBox();assert.ok(saveBox.y+saveBox.height<=568);await page.getByRole('button',{name:'关闭弹窗',exact:true}).click();await shot('08-small-home');await page.setViewportSize({width:390,height:844});
    assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),true);return {syntheticFixture:true,remainingToday:24,newPending:20,reviewPending:4,bookCompleted:2691,bookTotal:4485,cardOrder:'circle then plan',actualFonts:fonts,smallScreenSaveVisible:true};
  });
  await check('reduced motion suppresses confetti and local midnight creates a separate day without changing progress',async()=>{
    await page.emulateMedia({reducedMotion:'reduce'});delete completedFixture.studyPlans['ielts:look'].days[today].celebratedAt;await inject(completedFixture);
    const saved=await waitState(value=>!!value.studyPlans['ielts:look'].days[today].celebratedAt);await page.waitForTimeout(300);assert.equal(await page.locator('.goal-confetti').count(),0);
    const tomorrow=new Date(Date.parse(today+'T00:00:00Z')+86400000).toISOString().slice(0,10);await page.clock.setFixedTime(new Date(tomorrow+'T12:00:00-07:00'));await page.evaluate(()=>window.dispatchEvent(new Event('focus')));
    const next=await waitState(value=>!!value.studyPlans['ielts:look'].days[tomorrow]);assert.deepEqual(next.modes,saved.modes);assert.deepEqual(next.studyPlans['ielts:look'].days[today],saved.studyPlans['ielts:look'].days[today]);const summary=core.getStudyPlanSummary(next,words,'ielts','look',tomorrow);assert.equal(summary.remainingDays,29);assert.equal(summary.newCompleted,0);assert.equal(summary.reviewCompleted,0);assert.equal(summary.hasActivity,false);assert.equal(await page.locator('.goal-confetti').count(),0);
    return {reducedMotionRespected:true,newLocalDay:tomorrow,remainingDays:29,oldDayUnchanged:true,wordProgressUnchanged:true,noEmptyDayCelebration:true};
  });
  assert.deepEqual(report.errors,[]);assert.deepEqual(report.external,[]);report.passed=true;
}catch(error){report.passed=false;report.failure={message:error.message,stack:error.stack};process.exitCode=1;await page.screenshot({path:path.join(output,'failure.png')}).catch(()=>{});console.error(error);}
finally{report.finishedAt=new Date().toISOString();await writeFile(path.join(output,'report.json'),JSON.stringify(report,null,2));await browser.close();console.log(JSON.stringify({passed:report.passed,output}));}
