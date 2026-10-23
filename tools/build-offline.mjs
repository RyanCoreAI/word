import { readdir, readFile, writeFile, stat, mkdir, cp } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import path from 'node:path';

const dist = path.resolve('dist');
// Historical audio and lexical packs stay in the workspace only.
for (const entry of ['data', 'icons', 'licenses', 'manifest.webmanifest', '_headers', 'asr']) {
  await cp(path.resolve('apps/web/public', entry), path.join(dist, entry), { recursive: true });
}
if ((await readdir(dist)).some(entry => ['phrases', 'audio'].includes(entry))) throw new Error('Retired lexical/audio packs must not be deployed.');
await mkdir(path.join(dist, 'licenses'), { recursive: true });
for (const [pkg, filename] of [['@fontsource/inter', 'Inter-OFL.txt'], ['@fontsource/noto-sans-sc', 'Noto-Sans-SC-OFL.txt'], ['@fontsource/source-serif-4', 'Source-Serif-4-OFL.txt'], ['lucide-react', 'Lucide-ISC.txt']]) {
  await writeFile(path.join(dist, 'licenses', filename), await readFile(path.resolve('node_modules', pkg, 'LICENSE')));
}
const files = [];
async function visit(folder, prefix = '') {
  for (const entry of await readdir(folder, { withFileTypes: true })) {
    const relative = prefix + entry.name;
    if (entry.isDirectory()) { if (!['data', 'audio', 'asr'].includes(entry.name)) await visit(path.join(folder, entry.name), relative + '/'); }
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
hash.update(await readFile(path.join(dist, '_headers')));
// Worker logic changes must get a fresh cache namespace even if UI assets do not.
hash.update(await readFile(new URL(import.meta.url)));
const version = hash.digest('hex').slice(0, 16);
const sw = `const CACHE='word-shell-${version}';
const SHELL=${JSON.stringify(files)};
// Avoid downloading every CJK font subset during installation.
// Requested fonts are cached below. The page also reports fonts already loaded
// before first service-worker control, so the visible typography remains offline.
const PRECACHE=SHELL.filter(path=>!(/\\.woff2?$/.test(path)));
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
 if(relative.startsWith('data/')||relative.startsWith('audio/')||relative.startsWith('phrases/')||relative.startsWith('asr/'))return;
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
console.log(`Verified ${manifest.total} dictionary entries; generated offline shell ${version} (${files.length} assets).`);
console.log('Pronunciation uses device-local voices only; no hosted audio is bundled.');
console.log('Reviewed collocations are bundled for offline use; historical lexical packs are excluded.');
console.log(`Verified local ASR ${asrManifest.version} (${asrManifest.totalBytes} bytes); excluded from shell precache.`);
console.log(`Service worker: ${(await stat(path.join(dist, 'sw.js'))).size} bytes. Dictionary is downloaded only after user action.`);
