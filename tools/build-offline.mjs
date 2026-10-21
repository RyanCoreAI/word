import { readdir, readFile, writeFile, stat, mkdir } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import path from 'node:path';

const dist = path.resolve('dist');
await mkdir(path.join(dist, 'licenses'), { recursive: true });
for (const [pkg, filename] of [['@fontsource/inter', 'Inter-OFL.txt'], ['@fontsource/noto-sans-sc', 'Noto-Sans-SC-OFL.txt'], ['@fontsource/source-serif-4', 'Source-Serif-4-OFL.txt'], ['lucide-react', 'Lucide-ISC.txt']]) {
  await writeFile(path.join(dist, 'licenses', filename), await readFile(path.resolve('node_modules', pkg, 'LICENSE')));
}
const files = [];
async function visit(folder, prefix = '') {
  for (const entry of await readdir(folder, { withFileTypes: true })) {
    const relative = prefix + entry.name;
    if (entry.isDirectory()) { if (!['data', 'audio'].includes(entry.name)) await visit(path.join(folder, entry.name), relative + '/'); }
    else if (!['sw.js', 'CNAME', '.nojekyll'].includes(entry.name)) files.push(relative);
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
// Reuse the browser contracts instead of inventing a second audio manifest.
const { createServer } = await import('vite');
const contracts = await createServer({ configFile: false, root: process.cwd(), server: { middlewareMode: true, hmr: false }, appType: 'custom' });
let audioManifest;
let audioIndex;
try {
  const audio = await contracts.ssrLoadModule('/apps/web/src/lib/audio.ts');
  audioManifest = audio.audioManifestSchema.parse(JSON.parse(await readFile(path.join(dist, 'audio/manifest.json'), 'utf8')));
  if (audioManifest.dictionaryVersion !== manifest.version || audioManifest.studySha256 !== manifest.study.sha256 || audioManifest.index.count !== manifest.studyCount) throw new Error('Audio does not match the current study dictionary.');
  const audioRoot = path.resolve(dist, 'audio') + path.sep;
  for (const descriptor of [audioManifest.index, ...audioManifest.packs, ...audioManifest.packs.flatMap(pack => pack.index ? [pack.index] : [])]) {
    const filename = path.resolve(audioRoot, descriptor.file);
    if (!filename.startsWith(audioRoot)) throw new Error('Audio path escapes its directory.');
    const bytes = await readFile(filename);
    if (bytes.length !== descriptor.bytes || createHash('sha256').update(bytes).digest('hex') !== descriptor.sha256) throw new Error(`Audio integrity failure: ${descriptor.file}`);
  }
  audioIndex = audio.parseAudioIndex(JSON.parse(await readFile(path.join(audioRoot, audioManifest.index.file), 'utf8')), audioManifest);
  for (const pack of audioManifest.packs) {
    if (pack.index) {
      const part = audio.parseAudioPackIndex(JSON.parse(await readFile(path.join(audioRoot, pack.index.file), 'utf8')), audioManifest, pack);
      for (const [id, entry] of Object.entries(part.entries)) {
        if (JSON.stringify(entry) !== JSON.stringify(audioIndex.entries[id])) throw new Error(`Audio pack index differs from the complete index: ${id}`);
      }
    }
  }
  const study = JSON.parse(await readFile(path.join(dist, 'data', manifest.study.file), 'utf8'));
  if (study.length !== Object.keys(audioIndex.entries).length || study.some(word => !Object.hasOwn(audioIndex.entries, word.id))) throw new Error('Some study words are missing audio.');
  for (const pack of audioManifest.packs) {
    const bytes = await readFile(path.join(audioRoot, pack.file));
    for (const entry of Object.values(audioIndex.entries).filter(entry => entry.pack === pack.id)) {
      if (createHash('sha256').update(bytes.subarray(entry.offset, entry.offset + entry.length)).digest('hex') !== entry.sha256) throw new Error(`Word clip integrity failure in ${pack.file}`);
    }
  }
  await readFile(path.join(audioRoot, audioManifest.voice.provenance));
} finally { await contracts.close(); }
const hash = createHash('sha256');
for (const file of files.sort()) hash.update(await readFile(path.join(dist, file)));
hash.update(audioManifest.version);
const version = hash.digest('hex').slice(0, 16);
const sw = `const CACHE='word-shell-${version}';
const SHELL=${JSON.stringify(files)};
// Do not compete with the first word's audio by downloading every CJK subset.
// Requested fonts are cached below. The page also reports fonts already loaded
// before first service-worker control, so the visible typography remains offline.
const PRECACHE=SHELL.filter(path=>!(/\\.woff2?$/.test(path)));
self.addEventListener('install', event => event.waitUntil(caches.open(CACHE).then(cache => cache.addAll(PRECACHE.map(path => new URL(path,self.registration.scope).href)))));
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
 if(relative.startsWith('data/')||relative.startsWith('audio/'))return;
 // These responses are public, same-origin build assets only. A static host may
 // vary on Origin, while module/CSS requests and precache requests use different
 // Origin headers. Ignore that header variation within the explicit shell list.
 if(SHELL.includes(relative)){event.respondWith(caches.open(CACHE).then(async cache=>{
  const key=new URL(relative,scope).href,cached=await cache.match(key,{ignoreVary:true});
  if(cached)return cached;
  const response=await fetch(event.request);
  if(response.ok)await cache.put(key,response.clone());
  return response;
 }));return;}
 if(event.request.mode==='navigate')event.respondWith(caches.open(CACHE).then(async cache=>(await cache.match(new URL('index.html',scope).href,{ignoreVary:true}))||fetch(event.request)));
});
`;
await writeFile(path.join(dist, 'sw.js'), sw);
await writeFile(path.join(dist, '.nojekyll'), '');
console.log(`Verified ${manifest.total} dictionary entries; generated offline shell ${version} (${files.length} assets).`);
console.log(`Verified ${Object.keys(audioIndex.entries).length} word clips in ${audioManifest.packs.length} audio packs; audio downloads only on play or explicit full download.`);
console.log(`Service worker: ${(await stat(path.join(dist, 'sw.js'))).size} bytes. Dictionary is downloaded only after user action.`);
