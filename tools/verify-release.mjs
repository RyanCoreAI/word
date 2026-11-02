import assert from 'node:assert/strict';
import { readFile, readdir, writeFile, mkdir } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { verifyAndroidAssets } from './android/verify-assets.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));
const url = new URL(process.env.WORD_QA_URL ?? 'https://word.yanxai.com/');
const output = path.resolve(process.env.WORD_RELEASE_OUTPUT ?? path.join(root, '../../outputs/word-retell/public'));
await mkdir(output, { recursive: true });
const local = file => readFile(path.join(root, 'dist', file));
const asr = JSON.parse(await local('asr/manifest.json'));
const dictionary = JSON.parse(await local('data/manifest.json'));
const articleDictionary = JSON.parse(await local('data/article-manifest.json'));
assert.equal(articleDictionary.schema, 1, 'Unsupported reading dictionary schema.');
assert.equal(articleDictionary.version, dictionary.version, 'Reading dictionary must match the learning dictionary version.');
assert.deepEqual(articleDictionary.source, dictionary.source, 'Reading dictionary source must match the pinned ECDICT source.');
assert.deepEqual(articleDictionary.license, dictionary.license, 'Reading dictionary license must match the pinned ECDICT license.');
for (const asset of [articleDictionary.words, articleDictionary.lemmas]) {
  assert.equal(typeof asset?.file, 'string', 'Missing reading dictionary asset path.');
  assert.ok(/^[A-Za-z0-9_./-]+$/.test(asset.file) && !asset.file.startsWith('/') && !asset.file.split('/').some(part => part === '..' || part === ''), 'Reading dictionary asset must be a safe same-origin path.');
  const bytes = await local('data/' + asset.file);
  assert.equal(bytes.length, asset.bytes, `Reading dictionary size mismatch: ${asset.file}`);
  assert.equal(createHash('sha256').update(bytes).digest('hex'), asset.sha256, `Reading dictionary checksum mismatch: ${asset.file}`);
}
const { release: android } = await verifyAndroidAssets(path.join(root, 'dist'));
const html = (await local('index.html')).toString('utf8');
const assets = [...html.matchAll(/(?:src|href)="\.\/([^"?#]+\.(?:js|css))"/g)].map(match => match[1]);
async function listFiles(folder, prefix = '') {
  const files = [];
  for (const entry of await readdir(folder, { withFileTypes: true })) {
    const relative = prefix + entry.name;
    if (entry.isDirectory()) files.push(...await listFiles(path.join(folder, entry.name), relative + '/'));
    else if (entry.isFile()) files.push(relative);
  }
  return files;
}
const localFiles = await listFiles(path.join(root, 'dist'));
// Lazy plan/share/celebration/retell chunks and workers are not all in index.html.
const codeAssets = localFiles.filter(file => /\.(?:m?js|css)$/.test(file));
const expectedSceneNames = Array.from({ length: 20 }, (_, index) => `${String(index + 1).padStart(2, '0')}.png`);
const sceneEntries = await readdir(path.join(root, 'dist/images/check-in'), { withFileTypes: true });
assert.ok(sceneEntries.every(entry => entry.isFile()), 'Check-in scenery directory contains non-files.');
assert.deepEqual(sceneEntries.map(entry => entry.name).sort(), expectedSceneNames, 'Expected exactly 20 numbered check-in scenes.');
const sceneAssets = expectedSceneNames.map(file => 'images/check-in/' + file);
const licenseAssets = localFiles.filter(file => file.startsWith('licenses/'));
for (const license of ['licenses/Canvas-Confetti-ISC.txt', 'licenses/QRCode-MIT.txt']) {
  assert.ok(licenseAssets.includes(license), `Missing release license: ${license}`);
  assert.ok((await local(license)).length > 0, `Empty release license: ${license}`);
}
const filenames = [...new Set([
  'index.html', 'sw.js', 'manifest.webmanifest', '.well-known/assetlinks.json', 'downloads/word-android.json', `downloads/${android.file}`, ...assets, ...codeAssets, ...sceneAssets, ...licenseAssets,
  'data/manifest.json', `data/${dictionary.study.file}`, `data/${dictionary.shards[0].file}`, `data/${dictionary.shards.at(-1).file}`,
  'data/article-manifest.json', `data/${articleDictionary.words.file}`, `data/${articleDictionary.lemmas.file}`,
  'asr/manifest.json', ...asr.assets.flatMap(asset => asset.parts.map(part => 'asr/' + part.file)),
])];
const files = []; let cursor = 0;
async function worker() {
  while (cursor < filenames.length) {
    const file = filenames[cursor++]; let bytes; let failure;
    for (let attempt = 0; attempt < 3; attempt++) {
      try { const response = await fetch(new URL(file === 'index.html' ? './' : file, url), { cache: 'no-store', signal: AbortSignal.timeout(60_000) }); assert.equal(response.status, 200, file); bytes = Buffer.from(await response.arrayBuffer()); assert.ok(bytes.equals(await local(file)), `Public bytes differ: ${file}`); break; }
      catch (error) { failure = error; }
    }
    if (!bytes) throw failure;
    // A failed byte comparison must not be mistaken for a successful download.
    assert.ok(bytes.equals(await local(file)), `Public bytes differ: ${file}`);
    files.push({ file, bytes: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex'), matchesLocal: true });
  }
}
await Promise.all(Array.from({ length: 4 }, worker));
const report = { verifiedAt: new Date().toISOString(), url: url.href, commit: execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim(), shell: (await local('sw.js')).toString('utf8').match(/word-shell-([a-f0-9]+)/)[1], asrVersion: asr.version, readingDictionary: { version: articleDictionary.version, words: articleDictionary.words.count, inflectedForms: articleDictionary.lemmas.count, bytes: articleDictionary.words.bytes + articleDictionary.lemmas.bytes }, codeAssets: codeAssets.length, checkInScenes: sceneAssets.length, licenses: licenseAssets.length, files: files.sort((a,b) => a.file.localeCompare(b.file)) };
await writeFile(path.join(output, 'byte-verification.json'), JSON.stringify(report, null, 2));
console.log(JSON.stringify({ commit: report.commit, shell: report.shell, verifiedFiles: files.length, allBytesMatch: true, output }));
