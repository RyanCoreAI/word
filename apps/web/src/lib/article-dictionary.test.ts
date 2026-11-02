import 'fake-indexeddb/auto';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Word } from '../../../../packages/core/src';
import { loadArticleDictionary, mergeArticleDictionary, readCachedArticleDictionary } from './article-dictionary';
import { sha256 } from './dictionary';
import { openWordDatabase, type WordDatabase } from './storage';

const words: Word[] = ['see', 'saw', 'study', 'the'].map((word, index) => ({ id: word, word, translation: '词典原义', phonetic: '', tags: [], rank: index + 1, basic: word === 'the' }));
const dbs: WordDatabase[] = [];
let counter = 0;
afterEach(() => { for (const db of dbs.splice(0)) db.close(); });

async function fixture() {
  const db = await openWordDatabase(`article-dictionary-test-${counter++}`); dbs.push(db);
  const files = new Map<string, string>();
  async function asset(file: string, data: unknown, count: number) {
    const text = JSON.stringify(data); files.set(`https://example.test/data/${file}`, text);
    const bytes = new TextEncoder().encode(text);
    return { file, count, bytes: bytes.byteLength, sha256: await sha256(bytes) };
  }
  const manifest = {
    schema: 1, version: 'v1',
    source: { name: 'ECDICT', commit: 'a'.repeat(40), url: 'https://example.test/source', sha256: 'a'.repeat(64), bytes: 100 },
    license: { name: 'MIT', file: '/licenses/test.txt', sourceUrl: 'https://example.test/license', sha256: 'a'.repeat(64) },
    policy: { schema: 1, frequencyMax: 50_000, words: 'fixture', lemmas: 'source exchange' },
    words: await asset('v1/words.json', words, words.length),
    lemmas: await asset('v1/lemmas.json', { saw: ['see'], studies: ['study'] }, 2),
  };
  files.set('https://example.test/data/article-manifest.json', JSON.stringify(manifest));
  const fetcher = vi.fn<typeof fetch>(async input => {
    const value = files.get(String(input));
    return new Response(value ?? 'not found', { status: value === undefined ? 404 : 200 });
  });
  return { db, files, manifest, fetcher, options: { baseUrl: 'https://example.test/data/', dictionaryVersion: 'v1', fetcher } };
}

describe('reading dictionary delivery', () => {
  it('downloads only manifest + two verified packs once, then verifies the offline cache without fetching', async () => {
    const { db, options, fetcher } = await fixture();
    expect(await readCachedArticleDictionary(db, 'v1')).toBeNull();
    const pack = await loadArticleDictionary(db, options);
    expect(pack).toEqual({ version: 'v1', words, lemmas: { saw: ['see'], studies: ['study'] } });
    expect(fetcher.mock.calls.map(call => String(call[0])).sort()).toEqual([
      'https://example.test/data/article-manifest.json', 'https://example.test/data/v1/lemmas.json', 'https://example.test/data/v1/words.json',
    ]);
    fetcher.mockClear();
    expect(await loadArticleDictionary(db, options)).toEqual(pack);
    expect(fetcher).not.toHaveBeenCalled();
    expect(await db.getChunkReceipts('v1')).toEqual([]);
    expect(await db.readRawState()).toBeUndefined();
  });

  it('refuses corrupted assets before caching them and preserves a usable cache on failed refresh', async () => {
    const { db, options, files } = await fixture();
    const pack = await loadArticleDictionary(db, options);
    files.set('https://example.test/data/v1/words.json', '[]');
    await expect(loadArticleDictionary(db, { ...options, refresh: true })).rejects.toThrow(/校验/);
    expect(await readCachedArticleDictionary(db, 'v1')).toEqual(pack);
  });

  it('rechecks local cache hashes and can explicitly repair a disposable damaged cache', async () => {
    const { db, options, manifest, files } = await fixture();
    await db.saveArticleDictionaryCache('v1', { manifest, wordsText: '[]', lemmasText: files.get('https://example.test/data/v1/lemmas.json') });
    await expect(readCachedArticleDictionary(db, 'v1')).rejects.toThrow(/校验/);
    await expect(loadArticleDictionary(db, { ...options, refresh: true })).resolves.toHaveProperty('words', words);
  });

  it.each(['../secret.json', '//external.test/data.json', 'https://external.test/data.json', 'v1/%2e%2e/secret.json'])('rejects unsafe manifest paths before requesting assets: %s', async file => {
    const { db, options, manifest, files, fetcher } = await fixture();
    files.set('https://example.test/data/article-manifest.json', JSON.stringify({ ...manifest, words: { ...manifest.words, file } }));
    await expect(loadArticleDictionary(db, options)).rejects.toThrow();
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(await readCachedArticleDictionary(db, 'v1')).toBeNull();
  });

  it('rejects a version mismatch before loading assets and honors cancellation', async () => {
    const { db, options, fetcher } = await fixture();
    await expect(loadArticleDictionary(db, { ...options, dictionaryVersion: 'v2' })).rejects.toThrow(/版本/);
    expect(fetcher).toHaveBeenCalledTimes(1);
    fetcher.mockClear();
    const controller = new AbortController(); controller.abort();
    await expect(loadArticleDictionary(db, { ...options, signal: controller.signal })).rejects.toMatchObject({ name: 'AbortError' });
    expect(fetcher).not.toHaveBeenCalled();
  });

  it('rejects a source-valid hash with malformed lemma links before writing a cache', async () => {
    const { db, options, files, manifest } = await fixture();
    const text = JSON.stringify({ studies: ['absent'] });
    const bytes = new TextEncoder().encode(text);
    files.set('https://example.test/data/v1/lemmas.json', text);
    files.set('https://example.test/data/article-manifest.json', JSON.stringify({ ...manifest, lemmas: { ...manifest.lemmas, count: 1, bytes: bytes.byteLength, sha256: await sha256(bytes) } }));
    await expect(loadArticleDictionary(db, options)).rejects.toThrow(/词形索引/);
    expect(await readCachedArticleDictionary(db, 'v1')).toBeNull();
  });
});

describe('article exact lookups', () => {
  it('deduplicates batched tokens, isolates dictionary versions, and never treats prefix matches as exact', async () => {
    const { db } = await fixture();
    const entries: Word[] = ['abandon', 'abandonment', 'US', 'us'].map((word, index) => ({ ...words[0]!, id: word, word, rank: index + 1 }));
    await db.importDictionaryChunk({ version: 'v1', id: 'chunk', count: entries.length, sha256: 'a'.repeat(64) }, entries);
    await db.importDictionaryChunk({ version: 'v2', id: 'chunk', count: 1, sha256: 'b'.repeat(64) }, [{ ...entries[0]!, id: 'different', word: 'different' }]);
    const result = await db.lookupDictionaryExact('v1', [' abandon ', 'abandon', 'ABANDON', 'us', 'different']);
    expect(result.map(word => word.id).sort()).toEqual(['US', 'abandon', 'us']);
    expect(await db.lookupDictionaryExact('v1', [])).toEqual([]);
    expect(await db.lookupDictionaryExact('v1', ['aban'])).toEqual([]);
  });

  it('merges only exact downloaded additions and does not fetch the full dictionary', async () => {
    const { db, options, fetcher } = await fixture();
    const pack = await loadArticleDictionary(db, options);
    const extra: Word = { ...words[0]!, id: 'specialist', word: 'specialist', rank: 100_000 };
    await db.importDictionaryChunk({ version: 'v1', id: 'chunk', count: 1, sha256: 'a'.repeat(64) }, [extra]);
    fetcher.mockClear();
    const merged = await mergeArticleDictionary(db, 'v1', ['specialist'], pack, words);
    expect(merged).toHaveLength(words.length + 1);
    expect(merged.find(word => word.id === 'specialist')).toEqual(extra);
    expect(fetcher).not.toHaveBeenCalled();
    await expect(mergeArticleDictionary(db, 'v2', [], pack, words)).rejects.toThrow(/版本/);
  });
});
