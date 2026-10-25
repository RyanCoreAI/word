import { readdir, readFile, writeFile, stat, mkdir, cp } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { crc32, inflateSync } from 'node:zlib';
import path from 'node:path';
import { verifyAndroidAssets } from './android/verify-assets.mjs';
import { assertPublicReleaseTree } from './security/release-guard.mjs';

const sceneNames = Array.from({ length: 20 }, (_, index) => `${String(index + 1).padStart(2, '0')}.png`);
function verifyScenePng(bytes, filename) {
  const fail = detail => { throw new Error(`Check-in PNG integrity failure (${filename}): ${detail}`); };
  if (bytes.length < 45 || !bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) fail('invalid signature');
  let offset = 8; let width = 0; let height = 0; let channels = 0; let ended = false; let idatEnded = false;
  const imageParts = [];
  while (offset < bytes.length) {
    if (offset + 12 > bytes.length) fail('truncated chunk');
    const length = bytes.readUInt32BE(offset); const end = offset + length + 12;
    if (end > bytes.length) fail('chunk length exceeds file');
    const type = bytes.toString('ascii', offset + 4, offset + 8);
    if (!/^[A-Za-z]{4}$/.test(type)) fail('invalid chunk type');
    if (crc32(bytes.subarray(offset + 4, end - 4)) !== bytes.readUInt32BE(end - 4)) fail(`${type} CRC mismatch`);
    if (offset === 8 && type !== 'IHDR') fail('IHDR must be the first chunk');
    const data = bytes.subarray(offset + 8, end - 4);
    if (type === 'IHDR') {
      if (width || length !== 13) fail('invalid or duplicate IHDR');
      width = data.readUInt32BE(0); height = data.readUInt32BE(4);
      if (width < 1080 || height < 800) fail('scene must be at least 1080 by 800 pixels');
      // These static scene assets deliberately use ordinary RGB/RGBA PNGs.
      if (data[8] !== 8 || ![2, 6].includes(data[9]) || data[10] !== 0 || data[11] !== 0 || data[12] !== 0) fail('expected a non-interlaced 8-bit RGB/RGBA PNG');
      channels = data[9] === 2 ? 3 : 4;
    } else if (type === 'IDAT') {
      if (idatEnded) fail('non-contiguous image data');
      imageParts.push(data);
    } else if (type === 'IEND') {
      if (length || end !== bytes.length) fail('invalid IEND or trailing data');
      ended = true; offset = end; break;
    } else {
      if (imageParts.length) idatEnded = true;
      if (type === 'PLTE' && (length === 0 || length > 768 || length % 3)) fail('invalid palette');
      if (type !== 'PLTE' && type[0] === type[0].toUpperCase()) fail(`unsupported critical chunk ${type}`);
    }
    offset = end;
  }
  if (!ended || !imageParts.length || !width) fail('missing image data or end marker');
  const rowBytes = width * channels + 1; const expected = rowBytes * height;
  if (!Number.isSafeInteger(expected) || expected > 128 * 1024 * 1024) fail('decoded image exceeds the build memory limit');
  let decoded;
  try { decoded = inflateSync(Buffer.concat(imageParts), { maxOutputLength: expected + 1 }); } catch { fail('invalid compressed image data'); }
  if (decoded.length !== expected) fail('decoded pixel data length mismatch');
  for (let row = 0; row < height; row++) if (decoded[row * rowBytes] > 4) fail('invalid scanline filter');
  return { file: filename, width, height, bytes: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex') };
}
async function verifyCheckInScenes(folder) {
  const entries = await readdir(folder, { withFileTypes: true });
  const names = entries.map(entry => entry.name).sort();
  if (entries.some(entry => !entry.isFile()) || names.length !== sceneNames.length || names.some((name, index) => name !== sceneNames[index])) throw new Error('Check-in scenes must contain exactly 01.png through 20.png.');
  const scenes = [];
  for (const name of sceneNames) scenes.push(verifyScenePng(await readFile(path.join(folder, name)), name));
  if (new Set(scenes.map(scene => scene.sha256)).size !== sceneNames.length) throw new Error('Check-in scenes must have 20 distinct file hashes.');
  return scenes;
}

// Read-only source validation does not touch dist while browser QA is running.
if (process.argv.includes('--check-scenes-only')) {
  const scenes = await verifyCheckInScenes(path.resolve('apps/web/public/images/check-in'));
  console.log(JSON.stringify({ scenes: scenes.length, uniqueHashes: scenes.length, minWidth: Math.min(...scenes.map(scene => scene.width)), minHeight: Math.min(...scenes.map(scene => scene.height)), totalBytes: scenes.reduce((sum, scene) => sum + scene.bytes, 0) }));
  process.exit(0);
}

const dist = path.resolve('dist');
// Historical audio and lexical packs stay in the workspace only.
for (const entry of ['data', 'icons', 'images', 'licenses', 'manifest.webmanifest', '_headers', 'asr', 'downloads', '.well-known']) {
  const sourceRoot = path.resolve('apps/web/public', entry);
  await cp(sourceRoot, path.join(dist, entry), { recursive: true, filter: source => {
    if (path.basename(source) === '.gitignore') return false;
    // Interrupted dictionary builds leave private staging siblings; never publish or delete them.
    if (entry === 'data' && path.dirname(source) === sourceRoot && /^\.building-[a-f0-9]{32}$/.test(path.basename(source))) return false;
    return true;
  } });
}
await assertPublicReleaseTree(dist);
if ((await readdir(dist)).some(entry => ['phrases', 'audio'].includes(entry))) throw new Error('Retired lexical/audio packs must not be deployed.');
const checkInScenes = await verifyCheckInScenes(path.join(dist, 'images/check-in'));
const android = await verifyAndroidAssets(dist);
await mkdir(path.join(dist, 'licenses'), { recursive: true });
for (const [pkg, filename, sourceName = 'LICENSE'] of [['@fontsource/inter', 'Inter-OFL.txt'], ['@fontsource/noto-sans-sc', 'Noto-Sans-SC-OFL.txt'], ['@fontsource/source-serif-4', 'Source-Serif-4-OFL.txt'], ['lucide-react', 'Lucide-ISC.txt'], ['canvas-confetti', 'Canvas-Confetti-ISC.txt'], ['qrcode', 'QRCode-MIT.txt', 'license']]) {
  const packageRoot = path.resolve('node_modules', pkg);
  // Enforce Linux casing even when the local filesystem ignores it.
  if (!(await readdir(packageRoot)).includes(sourceName)) throw new Error(`Missing exact-case license: ${pkg}/${sourceName}`);
  await writeFile(path.join(dist, 'licenses', filename), await readFile(path.join(packageRoot, sourceName)));
}
const files = [];
async function visit(folder, prefix = '') {
  for (const entry of await readdir(folder, { withFileTypes: true })) {
    const relative = prefix + entry.name;
    if (entry.isDirectory()) { if (!['data', 'audio', 'asr', 'downloads', '.well-known'].includes(entry.name)) await visit(path.join(folder, entry.name), relative + '/'); }
    else if (!['sw.js', 'CNAME', '.nojekyll', '_headers'].includes(entry.name)) files.push(relative);
  }
}
await visit(dist);
const manifest = JSON.parse(await readFile(path.join(dist, 'data/manifest.json'), 'utf8'));
if (!manifest.version || !manifest.study || !manifest.shards?.length) throw new Error('Build requires a verified dictionary. Run npm run pipeline first.');
for (const entry of [manifest.study, ...manifest.shards]) {
  const file = path.resolve(dist, 'data', entry.file);
  const expectedRoot = path.resolve(dist, 'data') + path.sep;
  if (!file.startsWith(expectedRoot)) throw new Error('Dictionary path escapes data directory.');
  const bytes = await readFile(file);
  if (bytes.length !== entry.bytes || createHash('sha256').update(bytes).digest('hex') !== entry.sha256) throw new Error(`Dictionary integrity failure: ${entry.file}`);
}
// Validate local ASR assets before publishing. Reviewed collocations are part
// of the application bundle; the rejected lexical corpus is not deployed.
const { createServer } = await import('vite');
const contracts = await createServer({ configFile: false, root: process.cwd(), server: { middlewareMode: true, hmr: false, watch: null }, appType: 'custom' });
let asrManifest;
try {
  const asr = await contracts.ssrLoadModule('/apps/web/src/lib/retell-asr-assets.ts');
  const asrRoot = path.resolve(dist, 'asr');
  asrManifest = asr.asrManifestSchema.parse(JSON.parse(await readFile(path.join(asrRoot, 'manifest.json'), 'utf8')));
  for (const asset of asrManifest.assets) {
    const parts = [];
    for (const part of asset.parts) {
      const filename = path.resolve(asrRoot, part.file);
      if (!filename.startsWith(asrRoot + path.sep)) throw new Error('ASR path escapes its root.');
      const bytes = await readFile(filename);
      if (bytes.length !== part.bytes || createHash('sha256').update(bytes).digest('hex') !== part.sha256) throw new Error(`ASR part integrity failure: ${part.file}`);
      parts.push(bytes);
    }
    const bytes = Buffer.concat(parts);
    if (bytes.length !== asset.bytes || createHash('sha256').update(bytes).digest('hex') !== asset.sha256) throw new Error(`ASR asset integrity failure: ${asset.path}`);
  }
} finally { await contracts.close(); }
const hash = createHash('sha256');
for (const file of files.sort()) hash.update(await readFile(path.join(dist, file)));
hash.update(manifest.version);
hash.update(asrManifest.version);
hash.update(android.metadataBytes);
hash.update(android.associationBytes);
hash.update(await readFile(path.join(dist, '_headers')));
// Worker logic changes must get a fresh cache namespace even if UI assets do not.
hash.update(await readFile(new URL(import.meta.url)));
const version = hash.digest('hex').slice(0, 16);
const sw = `const CACHE='word-shell-${version}';
const SHELL=${JSON.stringify(files)};
// Avoid downloading every CJK font subset during installation.
// Requested fonts are cached below. The page also reports fonts already loaded
// before first service-worker control, so the visible typography remains offline.
// Full-resolution scenery is fetched and cached only when selected for sharing.
const PRECACHE=SHELL.filter(path=>!path.startsWith('images/')&&!(/\\.woff2?$/.test(path)));
function navigationResponse(response){
 if(!response?.redirected)return response;
 const headers=new Headers(response.headers);headers.delete('content-encoding');headers.delete('content-length');
 return new Response(response.body,{status:response.status,statusText:response.statusText,headers});
}
self.addEventListener('install', event => event.waitUntil((async()=>{
 const cache=await caches.open(CACHE),scope=new URL(self.registration.scope);
 await cache.addAll(PRECACHE.filter(path=>path!=='index.html').map(path=>new URL(path,scope).href));
 // Workers Assets canonically redirects /index.html to /. Cache the real root
 // under our stable key and strip redirect metadata before navigation uses it.
 const response=await fetch(scope.href,{cache:'reload'});
 if(!response.ok)throw new Error('Offline document could not be cached.');
 await cache.put(new URL('index.html',scope).href,navigationResponse(response));
})()));
self.addEventListener('activate',event => event.waitUntil((async()=>{for(const key of await caches.keys()){if(key.startsWith('word-shell-')&&key!==CACHE)await caches.delete(key);}await self.clients.claim();})()));
self.addEventListener('message',event=>{
 if(event.data?.type==='ACTIVATE_UPDATE')self.skipWaiting();
 if(event.data?.type==='CACHE_USED_FONTS'&&Array.isArray(event.data.urls))event.waitUntil((async()=>{
  const cache=await caches.open(CACHE),scope=new URL(self.registration.scope);
  await Promise.all(event.data.urls.slice(0,200).map(async raw=>{
   try{
    const url=new URL(raw,scope),relative=url.pathname.slice(scope.pathname.length);
    if(url.origin!==scope.origin||!url.pathname.startsWith(scope.pathname)||!SHELL.includes(relative)||!(/\\.woff2?$/.test(relative)))return;
    if(await cache.match(url.href,{ignoreVary:true}))return;
    const response=await fetch(url.href,{cache:'force-cache'});
    if(response.ok)await cache.put(url.href,response);
   }catch{/* A later real font request can retry without affecting study data. */}
  }));
 })());
});
self.addEventListener('fetch',event=>{
 if(event.request.method!=='GET')return;
 const url=new URL(event.request.url), scope=new URL(self.registration.scope);
 if(url.origin!==scope.origin||!url.pathname.startsWith(scope.pathname))return;
 const relative=url.pathname.slice(scope.pathname.length);
 if(relative.startsWith('data/')||relative.startsWith('audio/')||relative.startsWith('phrases/')||relative.startsWith('asr/')||relative.startsWith('downloads/')||relative.startsWith('.well-known/'))return;
 // These responses are public, same-origin build assets only. A static host may
 // vary on Origin, while module/CSS requests and precache requests use different
 // Origin headers. Ignore that header variation within the explicit shell list.
 if(SHELL.includes(relative)){event.respondWith(caches.open(CACHE).then(async cache=>{
  const key=new URL(relative,scope).href,cached=await cache.match(key,{ignoreVary:true});
  if(cached)return event.request.mode==='navigate'?navigationResponse(cached):cached;
  const response=await fetch(event.request);
  if(response.ok)await cache.put(key,response.clone());
  return response;
 }));return;}
 if(event.request.mode==='navigate')event.respondWith(caches.open(CACHE).then(async cache=>navigationResponse(await cache.match(new URL('index.html',scope).href,{ignoreVary:true}))||fetch(event.request)));
});
`;
await writeFile(path.join(dist, 'sw.js'), sw);
await writeFile(path.join(dist, '.nojekyll'), '');
const publicRelease = await assertPublicReleaseTree(dist);
console.log(`Verified public release boundary (${publicRelease.files} regular files; no private/development paths).`);
console.log(`Verified ${manifest.total} dictionary entries; generated offline shell ${version} (${files.length} assets).`);
console.log(`Verified signed APK asset ${android.release.version} (${android.release.bytes} bytes); excluded from offline installation/cache.`);
console.log('Pronunciation uses device-local voices only; no hosted audio is bundled.');
console.log('Reviewed collocations are bundled for offline use; historical lexical packs are excluded.');
console.log(`Verified ${checkInScenes.length} distinct check-in PNGs (minimum 1080x800); requested scenes are cached on demand, never precached.`);
console.log(`Verified local ASR ${asrManifest.version} (${asrManifest.totalBytes} bytes); excluded from shell precache.`);
console.log(`Service worker: ${(await stat(path.join(dist, 'sw.js'))).size} bytes. Dictionary is downloaded only after user action.`);
