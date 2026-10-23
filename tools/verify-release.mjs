import assert from 'node:assert/strict';
import { readFile, readdir, writeFile, mkdir } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../', import.meta.url));
const url = new URL(process.env.WORD_QA_URL ?? 'https://word.yanxai.com/');
const output = path.resolve(process.env.WORD_RELEASE_OUTPUT ?? path.join(root, '../../outputs/word-retell/public'));
await mkdir(output, { recursive: true });
const local = file => readFile(path.join(root, 'dist', file));
const phrases = JSON.parse(await local('phrases/manifest.json'));
const asr = JSON.parse(await local('asr/manifest.json'));
const dictionary = JSON.parse(await local('data/manifest.json'));
const html = (await local('index.html')).toString('utf8');
const assets = [...html.matchAll(/(?:src|href)="\.\/([^"?#]+\.(?:js|css))"/g)].map(match => match[1]);
const retellAssets = (await readdir(path.join(root, 'dist/assets'))).filter(file => /^RetellPage-.*\.(js|css)$/.test(file)).map(file => 'assets/' + file);
const filenames = [...new Set([
  'index.html', 'sw.js', 'manifest.webmanifest', ...assets, ...retellAssets,
  'data/manifest.json', `data/${dictionary.study.file}`, `data/${dictionary.shards[0].file}`, `data/${dictionary.shards.at(-1).file}`,
  'phrases/manifest.json', ...Object.values(phrases.shards).map(item => `phrases/${item.file}`), `phrases/${phrases.attribution.file}`,
  ...phrases.licenses.map(item => `phrases/${item.file}`), ...phrases.sources.map(source => `phrases/${source.archive.file}`),
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
const report = { verifiedAt: new Date().toISOString(), url: url.href, commit: execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim(), shell: (await local('sw.js')).toString('utf8').match(/word-shell-([a-f0-9]+)/)[1], phraseVersion: phrases.version, asrVersion: asr.version, coverage: phrases.coverage, files: files.sort((a,b) => a.file.localeCompare(b.file)) };
await writeFile(path.join(output, 'byte-verification.json'), JSON.stringify(report, null, 2));
console.log(JSON.stringify({ commit: report.commit, shell: report.shell, verifiedFiles: files.length, allBytesMatch: true, output }));
