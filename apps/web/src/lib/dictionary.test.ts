import 'fake-indexeddb/auto';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Word } from '../../../../packages/core/src';
import { dictionaryManifestSchema, downloadAll, getDownloadProgress, loadStudyDictionary, readCachedStudy, sha256, type DictionaryManifest } from './dictionary';
import { openWordDatabase, type WordDatabase } from './storage';

const words: Word[] = ['abandon', 'ability'].map((word, rank) => ({ id: word, word, translation: 'n. 测试词义', phonetic: '', tags: ['cet4'], rank, basic: false }));
const dbs: WordDatabase[] = [];
let counter = 0;
afterEach(() => { for (const db of dbs.splice(0)) db.close(); });

async function fixture() {
  const db = await openWordDatabase(`dictionary-test-${counter++}`); dbs.push(db);
  const files = new Map<string, string>();
  async function asset(file: string, data: Word[]) {
    const text = JSON.stringify(data); files.set(`https://example.test/data/${file}`, text);
    const bytes = new TextEncoder().encode(text);
    return { file, count: data.length, bytes: bytes.byteLength, sha256: await sha256(bytes) };
  }
  const manifest: DictionaryManifest = {
    version: 'v1', source: { name: 'ECDICT', commit: 'a'.repeat(40), url: 'https://example.test/source', sha256: 'a'.repeat(64), bytes: 100 },
    total: 2, studyCount: 2, study: await asset('v1/study.json', words),
    shards: [await asset('v1/shard-0000.json', [words[0]!]), await asset('v1/shard-0001.json', [words[1]!])],
    license: { name: 'MIT', file: '/licenses/test.txt', sourceUrl: 'https://example.test/license', sha256: 'a'.repeat(64) }, stats: {}, policy: {},
  };
  files.set('https://example.test/data/manifest.json', JSON.stringify(manifest));
  const fetcher = vi.fn<typeof fetch>(async input => {
    const value = files.get(String(input));
    return new Response(value ?? 'not found', { status: value === undefined ? 404 : 200 });
  });
  return { db, files, manifest, fetcher, options: { baseUrl: 'https://example.test/data/', fetcher } };
}

describe('verified dictionary loading', () => {
  it.each(['licenses/ECDICT-LICENSE.txt', '/licenses/ECDICT-LICENSE.txt'])('keeps a normal same-origin license path unchanged: %s', async file => {
    const { manifest } = await fixture();
    const checked = dictionaryManifestSchema.parse({ ...manifest, license: { ...manifest.license, file } });
    expect(checked.license.file).toBe(file);
    expect(new URL(checked.license.file.replace(/^\/+/, ''), 'https://word.yanxai.com/').href).toBe('https://word.yanxai.com/licenses/ECDICT-LICENSE.txt');
  });

  it.each([
    'javascript:alert(document.domain)', 'data:text/html,<script>alert(1)</script>',
    'https://foreign.example/license.txt', '//foreign.example/license.txt',
    '../license.txt', '/licenses/../../license.txt', 'licenses/%2e%2e/license.txt',
    'licenses/%252e%252e/license.txt', '/\\foreign.example/license.txt', 'licenses//license.txt', '',
  ])('rejects an unsafe license path before downloading or replacing the usable cache: %s', async file => {
    const { db, options, files, manifest, fetcher } = await fixture();
    await loadStudyDictionary(db, options);
    files.set('https://example.test/data/manifest.json', JSON.stringify({ ...manifest, license: { ...manifest.license, file } }));
    fetcher.mockClear();
    await expect(loadStudyDictionary(db, options)).rejects.toThrow(/license path/);
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(await readCachedStudy(db)).toEqual({ manifest, words });
  });

  it('saves a verified study package and reads it without fetching', async () => {
    const { db, options, fetcher, manifest } = await fixture();
    expect(await readCachedStudy(db)).toBeNull();
    expect(await loadStudyDictionary(db, options)).toEqual({ manifest, words });
    fetcher.mockClear();
    expect(await readCachedStudy(db)).toEqual({ manifest, words });
    expect(fetcher).not.toHaveBeenCalled();
  });

  it('rejects corrupted downloads before replacing a usable cache', async () => {
    const { db, options, files, manifest } = await fixture();
    await loadStudyDictionary(db, options);
    files.set('https://example.test/data/v1/study.json', JSON.stringify(words).replace('abandon', 'Abandon'));
    await expect(loadStudyDictionary(db, options)).rejects.toThrow(/checksum/);
    expect(await readCachedStudy(db)).toEqual({ manifest, words });
  });

  it('pauses after an atomic shard and resumes without downloading completed shards', async () => {
    const { db, options, fetcher, manifest } = await fixture();
    await loadStudyDictionary(db, options);
    const abort = new AbortController();
    await expect(downloadAll(db, manifest, { ...options, signal: abort.signal, onProgress: progress => { if (progress.completed === 1) abort.abort(); } })).rejects.toMatchObject({ name: 'AbortError' });
    expect((await getDownloadProgress(db, manifest)).completed).toBe(1);
    fetcher.mockClear();
    const completed = await downloadAll(db, manifest, options);
    expect(completed).toMatchObject({ completed: 2, total: 2, entries: 2 });
    expect(fetcher.mock.calls.map(call => String(call[0]))).toEqual(['https://example.test/data/v1/shard-0001.json']);
    expect(await db.searchDictionary('v1', 'ab')).toHaveLength(2);
  });

  it('rejects a bad shard hash without marking it complete and can retry later', async () => {
    const { db, options, files, manifest } = await fixture();
    await loadStudyDictionary(db, options);
    const valid = files.get('https://example.test/data/v1/shard-0000.json')!;
    files.set('https://example.test/data/v1/shard-0000.json', valid.replace('abandon', 'Abandon'));
    await expect(downloadAll(db, manifest, options)).rejects.toThrow(/checksum/);
    expect((await getDownloadProgress(db, manifest)).completed).toBe(0);
    files.set('https://example.test/data/v1/shard-0000.json', valid);
    expect((await downloadAll(db, manifest, options)).completed).toBe(2);
  });

  it('rejects path traversal and inconsistent manifests before downloading a word package', async () => {
    const { db, options, files, manifest, fetcher } = await fixture();
    files.set('https://example.test/data/manifest.json', JSON.stringify({ ...manifest, study: { ...manifest.study, file: '../secret.json' } }));
    await expect(loadStudyDictionary(db, options)).rejects.toThrow();
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(await readCachedStudy(db)).toBeNull();
  });
});
