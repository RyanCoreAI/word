import { describe, expect, it, vi } from 'vitest';
import { PhraseStore, parsePhraseManifest, parsePhraseShard, type PhraseManifest, type PhraseShard } from './phrases';
import { sha256 } from './dictionary';

const baseUrl = 'https://word.example/phrases/';
const encode = (input: unknown) => new TextEncoder().encode(JSON.stringify(input));
async function fixture() {
  const responses = new Map<string, Response>();
  const files = new Map<string, Uint8Array>();
  const cache = {
    match: vi.fn(async (key: string) => responses.get(key)?.clone()),
    put: vi.fn(async (key: string, response: Response) => { responses.set(key, response.clone()); }),
  };
  const cacheStorage = { open: vi.fn(async (name: string) => { if (name !== 'word-phrases-v1') throw new Error('Unexpected cache namespace'); return cache as unknown as Cache; }) };
  const phrase = {
    text: 'make up', pos: 'verb', sourceId: 'source-traditional', sourceUrl: 'https://zh.wiktionary.org/wiki/make_up', tags: ['transitive'],
    senses: [{ id: 'zh-verb-1', meaning: '構成；組成', sourceId: 'source-traditional', sourceUrl: 'https://zh.wiktionary.org/wiki/make_up', tags: [],
      substitutes: [{ text: 'constitute', meaning: '構成；組成', meaningBasis: 'shared-sense', relationBasis: 'exact-source-sense', sourceId: 'source-traditional', sourceUrl: 'https://zh.wiktionary.org/wiki/make_up', tags: [] }] }],
  };
  const data = { make: { phrases: [phrase] } };
  const bytes = encode(data);
  const manifest: PhraseManifest = parsePhraseManifest({
    schemaVersion: 1, version: 'wiktionary-zh-test', dictionaryVersion: 'dict-v1',
    sources: [{ id: 'source-traditional', name: 'Traditional Chinese Wiktionary via Kaikki', url: 'https://kaikki.org/source.jsonl', pageUrl: 'https://kaikki.org/index.html', sha256: 'a'.repeat(64), bytes: 1000, extractedAt: '2026-10-20', dumpDate: '2026-10-01', archive: { file: 'sources/source.jsonl.gz', bytes: 100, sha256: 'b'.repeat(64), mirrorUrl: `${baseUrl}sources/source.jsonl.gz` }, license: 'CC-BY-SA-4.0' }],
    shards: { m: { file: 'wiktionary-zh-test/m.json', bytes: bytes.length, sha256: await sha256(bytes), count: 1 }, c: { file: 'wiktionary-zh-test/c.json', bytes: 2, sha256: await sha256(encode({})), count: 0 } },
    coverage: { dictionaryWordsWithPhrases: 1 }, policy: { maxPhrasesPerWord: 6 },
    license: { name: 'CC-BY-SA-4.0', url: 'https://creativecommons.org/licenses/by-sa/4.0/', file: 'licenses/CC-BY-SA-4.0.txt', bytes: 100, sha256: 'c'.repeat(64) },
    attribution: { file: 'wiktionary-zh-test/ATTRIBUTION.md', bytes: 100, sha256: 'd'.repeat(64) },
  });
  files.set('/phrases/manifest.json', encode(manifest)); files.set('/phrases/wiktionary-zh-test/m.json', bytes); files.set('/phrases/wiktionary-zh-test/c.json', encode({}));
  const fetcher = vi.fn<typeof fetch>(async input => {
    const url = new URL(String(input)); const body = files.get(url.pathname);
    return new Response(body ? new Uint8Array(body) : 'missing', { status: body ? 200 : 404 });
  });
  const options = { baseUrl, fetcher, cacheStorage };
  const replace = async (update: (input: typeof data) => void) => {
    const input = structuredClone(data); update(input); const body = encode(input);
    manifest.shards.m!.bytes = body.length; manifest.shards.m!.sha256 = await sha256(body);
    files.set('/phrases/wiktionary-zh-test/m.json', body); files.set('/phrases/manifest.json', encode(manifest));
  };
  return { options, cache, cacheStorage, responses, files, fetcher, manifest, data, replace };
}

describe('lazy verified phrase supplements', () => {
  it('does no work on construction and fetches only the manifest and selected letter', async () => {
    const f = await fixture(); const store = new PhraseStore(f.options);
    expect(f.fetcher).not.toHaveBeenCalled(); expect(f.cacheStorage.open).not.toHaveBeenCalled();
    const result = await store.load('make', 'dict-v1');
    expect(result.phrases[0]!.senses[0]!.meaning).toBe('構成；組成');
    expect(result.phrases[0]!.senses[0]!.substitutes[0]!.meaningBasis).toBe('shared-sense');
    expect(f.fetcher.mock.calls.map(call => new URL(String(call[0])).pathname)).toEqual(['/phrases/manifest.json', '/phrases/wiktionary-zh-test/m.json']);
    expect(f.cacheStorage.open).toHaveBeenCalledWith('word-phrases-v1');
    expect(await store.load('make', 'dict-v1')).toEqual(result);
    expect(f.fetcher).toHaveBeenCalledTimes(2);
  });

  it('serves previously read phrases offline from a new store and returns empty for missing words', async () => {
    const f = await fixture(); const first = await new PhraseStore(f.options).load('make', 'dict-v1');
    const offline = vi.fn<typeof fetch>(async () => { throw new Error('offline'); });
    const restored = new PhraseStore({ ...f.options, fetcher: offline });
    expect(await restored.load('make', 'dict-v1')).toEqual(first);
    expect(offline).toHaveBeenCalledTimes(1); // A fresh catalog is attempted, then validated offline metadata is used.
    expect((await new PhraseStore(f.options).load('constructor', 'dict-v1')).phrases).toEqual([]);
    expect((await restored.load('UPPER', 'dict-v1')).phrases).toEqual([]);
  });

  it('repairs damaged cached bytes by fetching only reproducible phrase assets', async () => {
    const f = await fixture(); await new PhraseStore(f.options).load('make', 'dict-v1');
    const shardKey = [...f.responses.keys()].find(key => key.includes('/m.json'))!;
    f.responses.set(shardKey, new Response('corrupted and much too long'));
    const catalogKey = [...f.responses.keys()].find(key => key.includes('/catalog-'))!;
    f.responses.set(catalogKey, new Response('{broken'));
    f.fetcher.mockClear();
    expect((await new PhraseStore(f.options).load('make', 'dict-v1')).phrases).toHaveLength(1);
    expect(f.fetcher).toHaveBeenCalledTimes(2);
    expect(await f.responses.get(shardKey)!.clone().json()).toEqual(f.data);
    expect([...f.responses.keys()].every(key => key.startsWith(baseUrl))).toBe(true);
  });

  it('rejects byte, checksum and record-count mismatches before caching a shard', async () => {
    for (const kind of ['bytes', 'hash', 'count'] as const) {
      const f = await fixture();
      if (kind === 'bytes') f.manifest.shards.m!.bytes -= 1;
      if (kind === 'hash') f.manifest.shards.m!.sha256 = 'f'.repeat(64);
      if (kind === 'count') f.manifest.shards.m!.count = 2;
      f.files.set('/phrases/manifest.json', encode(f.manifest));
      await expect(new PhraseStore(f.options).load('make', 'dict-v1')).rejects.toThrow();
      expect([...f.responses.keys()].some(key => key.includes('/m.json'))).toBe(false);
    }
  });

  it('rejects mismatched dictionaries, unknown source IDs and altered sense provenance', async () => {
    const wrongVersion = await fixture();
    await expect(new PhraseStore(wrongVersion.options).load('make', 'dict-v2')).rejects.toThrow('版本不匹配');
    const invalid: ((input: Awaited<ReturnType<typeof fixture>>['data']) => void)[] = [
      data => { data.make.phrases[0]!.sourceId = 'unlisted'; },
      data => { data.make.phrases[0]!.senses[0]!.sourceId = 'another'; },
      data => { data.make.phrases[0]!.senses[0]!.substitutes[0]!.meaning = '另一個意思'; },
      data => { data.make.phrases[0]!.sourceUrl = 'https://zh.wiktionary.org.evil.test/wiki/make_up'; },
    ];
    for (const mutate of invalid) { const f = await fixture(); await f.replace(mutate); await expect(new PhraseStore(f.options).load('make', 'dict-v1')).rejects.toThrow(); }
  });

  it('validates limits, Chinese meanings, exact associations and strict object shapes', async () => {
    const f = await fixture();
    const wrongToken = structuredClone(f.data) as PhraseShard;
    wrongToken.make!.phrases[0]!.text = 'take up';
    expect(() => parsePhraseShard(wrongToken, f.manifest, 'm')).toThrow();
    const tooMany = structuredClone(f.data); tooMany.make.phrases = Array(7).fill(f.data.make.phrases[0]);
    expect(() => parsePhraseShard(tooMany, f.manifest, 'm')).toThrow();
    const noChinese = structuredClone(f.data); noChinese.make.phrases[0]!.senses[0]!.meaning = 'made up meaning';
    expect(() => parsePhraseShard(noChinese, f.manifest, 'm')).toThrow();
    expect(() => parsePhraseManifest({ ...f.manifest, unexpected: true })).toThrow();
    expect(() => parsePhraseShard({ make: { ...f.data.make, unexpected: true } }, f.manifest, 'm')).toThrow();
    expect(() => parsePhraseManifest({ ...f.manifest, sources: [f.manifest.sources[0], f.manifest.sources[0]] })).toThrow();
  });

  it('rejects traversal, encoded paths, credentials, unsafe metadata URLs and redirected fetches', async () => {
    const f = await fixture();
    for (const file of ['../outside.json', '/outside.json', 'v1/../outside.json', 'v1/%2e%2e/outside.json', 'https://evil.test/data.json']) {
      expect(() => parsePhraseManifest({ ...f.manifest, shards: { m: { ...f.manifest.shards.m, file } } })).toThrow();
    }
    const badSource = { ...f.manifest.sources[0], url: 'javascript:alert(1)' };
    expect(() => parsePhraseManifest({ ...f.manifest, sources: [badSource] })).toThrow();
    await expect(new PhraseStore({ ...f.options, baseUrl: 'https://user:pass@word.example/phrases/' }).load('make', 'dict-v1')).rejects.toThrow('同源');
    const redirected = new Response(encode(f.manifest)); Object.defineProperty(redirected, 'redirected', { value: true });
    await expect(new PhraseStore({ ...f.options, fetcher: vi.fn<typeof fetch>(async () => redirected) }).load('make', 'dict-v1')).rejects.toThrow('重定向');
    expect(f.fetcher).not.toHaveBeenCalled();
  });

  it('aborts before fetch and during a streaming read without committing partial data', async () => {
    const f = await fixture(); const before = new AbortController(); before.abort();
    await expect(new PhraseStore(f.options).load('make', 'dict-v1', before.signal)).rejects.toMatchObject({ name: 'AbortError' });
    expect(f.fetcher).not.toHaveBeenCalled(); expect(f.cacheStorage.open).not.toHaveBeenCalled();
    const abort = new AbortController(); let streamStarted!: () => void;
    const started = new Promise<void>(resolve => { streamStarted = resolve; });
    const fetcher = vi.fn<typeof fetch>(async () => new Response(new ReadableStream({ start(controller) { controller.enqueue(new TextEncoder().encode('{')); streamStarted(); } })));
    const loading = new PhraseStore({ ...f.options, fetcher }).load('make', 'dict-v1', abort.signal);
    await started; abort.abort();
    await expect(loading).rejects.toMatchObject({ name: 'AbortError' });
    expect(f.responses.size).toBe(0);
  });

  it('reports quota failures without writing into learning progress or other caches', async () => {
    const f = await fixture();
    f.cache.put.mockRejectedValueOnce(new DOMException('Full', 'QuotaExceededError'));
    await expect(new PhraseStore(f.options).load('make', 'dict-v1')).rejects.toThrow('存储空间');
    expect(f.responses.size).toBe(0);
    expect(f.cacheStorage.open.mock.calls.map(call => call[0])).toEqual(['word-phrases-v1']);
  });

  it('bounds manifest downloads before JSON parsing and preserves existing cached responses', async () => {
    const f = await fixture();
    const fetcher = vi.fn<typeof fetch>(async () => new Response(new Uint8Array(512 * 1024 + 1)));
    await expect(new PhraseStore({ ...f.options, fetcher }).load('make', 'dict-v1')).rejects.toThrow('超过允许大小');
    expect(f.responses.size).toBe(0);
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it('refreshes a replaced phrase version on retry while retaining verified offline cache entries', async () => {
    const f = await fixture(); const store = new PhraseStore(f.options);
    await store.load('constructor', 'dict-v1'); // Load the catalog without reading the old m shard.
    const updated = structuredClone(f.manifest);
    updated.version = 'wiktionary-zh-updated';
    for (const asset of Object.values(updated.shards)) asset.file = asset.file.replace(f.manifest.version, updated.version);
    updated.attribution.file = updated.attribution.file.replace(f.manifest.version, updated.version);
    f.files.set('/phrases/manifest.json', encode(updated));
    f.files.set('/phrases/wiktionary-zh-updated/m.json', encode(f.data));
    f.files.delete('/phrases/wiktionary-zh-test/m.json');
    f.fetcher.mockClear();
    await expect(store.load('make', 'dict-v1')).rejects.toThrow('404');
    const before = [...f.responses.keys()]; const fetchCount = f.fetcher.mock.calls.length;
    store.invalidate();
    expect([...f.responses.keys()]).toEqual(before);
    expect(f.fetcher).toHaveBeenCalledTimes(fetchCount);
    const result = await store.load('make', 'dict-v1');
    expect(result.manifest.version).toBe(updated.version);
    expect(result.phrases[0]!.text).toBe('make up');
    expect(f.fetcher.mock.calls.map(call => new URL(String(call[0])).pathname)).toEqual([
      '/phrases/wiktionary-zh-test/m.json', '/phrases/manifest.json', '/phrases/wiktionary-zh-updated/m.json',
    ]);
    const offline = vi.fn<typeof fetch>(async () => { throw new Error('offline'); });
    expect((await new PhraseStore({ ...f.options, fetcher: offline }).load('make', 'dict-v1')).manifest.version).toBe(updated.version);
    expect(before.every(key => f.responses.has(key))).toBe(true);
  });
});
