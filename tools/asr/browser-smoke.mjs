import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { build } from 'rolldown';
import { chromium } from 'playwright';

const root = fileURLToPath(new URL('../../', import.meta.url));
const output = path.resolve(process.env.WORD_ASR_OUTPUT ?? path.join(root, '../../outputs/word-retell/asr-browser'));
await mkdir(output, { recursive: true });
await build({ input: path.join(root, 'apps/web/src/lib/retell-asr.ts'), platform: 'browser', output: { file: path.join(root, 'work/asr/controller.mjs'), format: 'esm', codeSplitting: false } });
const fixture = path.join(root, 'work/asr/jfk.wav');
const report = { startedAt: new Date().toISOString(), browser: 'Real Chrome, isolated browser context; desktop and file audio input, not Android hardware', fixtureSha256: createHash('sha256').update(await readFile(fixture)).digest('hex'), checks: [], requests: [], errors: [] };
const server = createServer(async (request, response) => {
  try {
    const pathname = new URL(request.url, 'http://localhost').pathname;
    if (pathname === '/favicon.ico') { response.writeHead(204); response.end(); return; }
    if (pathname === '/') { response.setHeader('Content-Type', 'text/html'); response.end('<!doctype html><button id="prepare">Prepare</button><button id="record">Record</button><script type="module">import {RetellAsrController} from "/controller.mjs"; window.controller=new RetellAsrController(); document.querySelector("#prepare").onclick=()=>{window.preparing=controller.prepare()}; document.querySelector("#record").onclick=()=>{window.starting=controller.start()};</script>'); return; }
    let file;
    if (pathname === '/controller.mjs') file = path.join(root, 'work/asr/controller.mjs');
    else if (pathname === '/jfk.wav') file = fixture;
    else if (/^\/asr\/[a-zA-Z0-9_./-]+$/.test(pathname) && !pathname.includes('..')) file = path.join(root, 'apps/web/public', pathname);
    else { response.writeHead(404); response.end(); return; }
    response.setHeader('Content-Type', pathname.endsWith('.mjs') ? 'text/javascript' : pathname.endsWith('.json') ? 'application/json' : 'application/octet-stream');
    response.end(await readFile(file));
  } catch (error) { response.writeHead(500); response.end(String(error)); }
});
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const origin = `http://127.0.0.1:${server.address().port}`;
const browser = await chromium.launch({ channel: 'chrome', headless: true, args: ['--use-fake-device-for-media-stream', `--use-file-for-fake-audio-capture=${fixture}`, '--autoplay-policy=no-user-gesture-required'] });
const context = await browser.newContext({ permissions: ['microphone'], serviceWorkers: 'block' });
const page = await context.newPage();
page.on('request', request => report.requests.push({ url: request.url(), method: request.method() }));
page.on('pageerror', error => report.errors.push(error.message));
page.on('console', message => { if (message.type() === 'error') report.errors.push(message.text()); });
const check = (name, detail) => { report.checks.push({ name, status: 'passed', detail }); console.log(JSON.stringify({ name, detail })); };
try {
  await page.goto(origin);
  await page.waitForFunction(() => window.controller);
  await page.waitForTimeout(500);
  assert.equal(report.requests.filter(item => item.url.includes('/asr/')).length, 0);
  check('construction and cache restore make zero ASR network requests', await page.evaluate(() => controller.getState()));
  await page.click('#prepare');
  await page.evaluate(() => window.preparing);
  assert.equal(await page.evaluate(() => controller.getState().modelReady), true);
  const asrRequests = report.requests.filter(item => item.url.includes('/asr/'));
  assert.ok(asrRequests.length > 10);
  assert.ok(asrRequests.every(item => item.url.startsWith(origin + '/asr/')));
  check('explicit prepare downloads verified same-origin chunks and initializes actual WASM model', { requests: asrRequests.length, state: await page.evaluate(() => controller.getState()) });
  const transcript = await page.evaluate(async () => {
    const audio = new AudioContext({ sampleRate: 16000 });
    try { const buffer = await audio.decodeAudioData(await (await fetch('/jfk.wav')).arrayBuffer()); return await controller.transcribe(buffer.getChannelData(0)); } finally { await audio.close(); }
  });
  assert.match(transcript.toLowerCase(), /ask not what your country can do for you/);
  check('actual Whisper recognizes official JFK fixture', { transcript });
  await page.click('#record'); await page.evaluate(() => window.starting);
  assert.equal(await page.evaluate(() => controller.getState().status), 'recording');
  await page.waitForTimeout(1400); await page.evaluate(() => controller.pause());
  const paused = await page.evaluate(() => controller.getState()); assert.equal(paused.status, 'paused');
  await page.waitForTimeout(500); assert.equal(await page.evaluate(() => controller.getState().durationMs), paused.durationMs);
  await page.evaluate(() => controller.resume()); await page.waitForTimeout(10_000);
  const result = await page.evaluate(async () => { const value = await controller.stop(); return { transcript: value.transcript, durationMs: value.durationMs, bytes: value.audioBlob.size, mime: value.audioBlob.type, retained: controller.getLastRecording()?.audioBlob.size }; });
  assert.ok(result.bytes > 1000); assert.equal(result.retained, result.bytes); assert.ok(result.transcript.trim()); assert.ok(result.durationMs < 12_000 && result.durationMs > 10_000);
  check('real getUserMedia and MediaRecorder pause/resume/stop produce retained recording and real ASR', result);
  await page.evaluate(() => controller.dispose());
  const requestCount = report.requests.filter(item => item.url.includes('/asr/')).length;
  await context.setOffline(true);
  await page.evaluate(async () => { const {RetellAsrController} = await import('/controller.mjs'); window.controller = new RetellAsrController(); });
  await page.waitForFunction(() => controller.getState().modelReady);
  const offline = await page.evaluate(async () => { await controller.start(); await new Promise(resolve => setTimeout(resolve, 2000)); const value = await controller.stop(); return { transcript: value.transcript, bytes: value.audioBlob.size, durationMs: value.durationMs }; });
  assert.ok(offline.bytes > 1000); assert.equal(report.requests.filter(item => item.url.includes('/asr/')).length, requestCount);
  check('fresh controller restores validated cache, warms worker and records/transcribes offline without ASR network', offline);
  await page.evaluate(() => controller.dispose());
  assert.ok(report.requests.every(item => item.method === 'GET' && (item.url.startsWith(origin + '/') || item.url.startsWith('blob:' + origin + '/'))));
  assert.deepEqual(report.errors, []);
} catch (error) { report.failure = error.stack ?? String(error); console.error(report.failure); process.exitCode = 1; }
finally { report.completedAt = new Date().toISOString(); await writeFile(path.join(output, 'report.json'), JSON.stringify(report, null, 2)); await browser.close(); await new Promise(resolve => server.close(resolve)); }
