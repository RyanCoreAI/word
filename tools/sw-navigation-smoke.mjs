import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';

// Exercise the deployed host's /index.html -> / canonical redirect with a real
// browser and service worker. Vite's preview server does not have this behavior.
const dist = path.resolve(fileURLToPath(new URL('../dist/', import.meta.url)));
const types = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.woff2': 'font/woff2', '.png': 'image/png', '.svg': 'image/svg+xml', '.webmanifest': 'application/manifest+json' };
const server = createServer(async (request, response) => {
  const pathname = new URL(request.url, 'http://localhost').pathname;
  if (pathname === '/index.html' || pathname === '/redirect-probe') {
    response.writeHead(307, { Location: '/' }); response.end(); return;
  }
  const file = path.resolve(dist, `.${pathname === '/' ? '/index.html' : decodeURIComponent(pathname)}`);
  if (!file.startsWith(`${dist}${path.sep}`)) { response.writeHead(403); response.end(); return; }
  try {
    const info = await stat(file);
    if (!info.isFile()) throw new Error('Not a file');
    response.writeHead(200, { 'Content-Type': types[path.extname(file)] ?? 'application/octet-stream', 'Cache-Control': 'no-store' });
    response.end(await readFile(file));
  } catch { response.writeHead(404); response.end(); }
});
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const url = `http://127.0.0.1:${server.address().port}/`;
let browser;
try {
  browser = await chromium.launch({ channel: 'chrome', headless: true });
  const context = await browser.newContext({ serviceWorkers: 'allow', viewport: { width: 390, height: 844 } });
  const page = await context.newPage();
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.goto(url);
  await page.getByRole('button', { name: '下载词库并开始', exact: true }).waitFor();
  await page.evaluate(() => navigator.serviceWorker.ready);
  await page.waitForFunction(() => navigator.serviceWorker.controller !== null);
  const initial = await page.evaluate(async () => {
    const name = (await caches.keys()).find(name => name.startsWith('word-shell-'));
    const cache = await caches.open(name);
    const html = await cache.match(new URL('index.html', location.href).href);
    return { name, redirected: html.redirected, status: html.status };
  });
  assert.equal(initial.redirected, false);
  assert.equal(initial.status, 200);
  await page.reload();
  await page.getByRole('button', { name: '下载词库并开始', exact: true }).waitFor();
  console.log(JSON.stringify({ check: 'canonical redirect host installs and reloads online', ...initial, status: 'passed' }));

  // Retain the actual network redirect flag in the cached HTML to cover data
  // created by the prior worker. No mock Response or app data is used here.
  const legacy = await page.evaluate(async () => {
    const response = await fetch('/redirect-probe');
    const redirected = response.redirected;
    const name = (await caches.keys()).find(name => name.startsWith('word-shell-'));
    const cache = await caches.open(name);
    await cache.put(new URL('index.html', location.href).href, response);
    return { redirected };
  });
  assert.equal(legacy.redirected, true);
  await page.reload();
  await page.getByRole('button', { name: '下载词库并开始', exact: true }).waitFor();
  console.log(JSON.stringify({ check: 'legacy redirected cache reloads online', status: 'passed' }));
  await context.setOffline(true);
  await page.reload();
  await page.getByRole('button', { name: '下载词库并开始', exact: true }).waitFor();
  await page.goto(`${url}offline-route`);
  await page.getByRole('button', { name: '下载词库并开始', exact: true }).waitFor();
  assert.deepEqual(errors, []);
  console.log(JSON.stringify({ check: 'legacy redirected cache reloads and navigates offline', status: 'passed' }));
} finally {
  await browser?.close();
  await new Promise(resolve => server.close(resolve));
}
