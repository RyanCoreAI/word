import { describe, expect, it, vi } from 'vitest';
import { PhraseStore, parsePhraseManifest, parsePhraseShard, type PhraseManifest, type WordSense } from './phrases';
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

async function schemaTwoFixture(primeLegacy = false) {
  const f = await fixture();
  if (primeLegacy) await new PhraseStore(f.options).load('make', 'dict-v1');
  const legacyKeys = [...f.responses.keys()];
  const manifest = structuredClone(f.manifest);
  manifest.schemaVersion = 2; manifest.version = 'lexical-zh-test';
  for (const asset of Object.values(manifest.shards)) asset.file = asset.file.replace(f.manifest.version, manifest.version);
  manifest.attribution.file = manifest.attribution.file.replace(f.manifest.version, manifest.version);
  manifest.licenses.push(
    { name: 'MIT', url: 'https://opensource.org/license/mit', file: 'licenses/ECDICT.txt', bytes: 100, sha256: 'e'.repeat(64) },
    { name: 'WordNet-3.0', url: 'https://wordnet.princeton.edu/license-and-commercial-use', file: 'licenses/WordNet-3.0.txt', bytes: 100, sha256: 'f'.repeat(64) },
  );
  const source = manifest.sources[0]!;
  manifest.sources.push(
    { ...source, id: 'ecdict-bc015ed2e24a', name: 'ECDICT', license: 'MIT', url: 'https://raw.githubusercontent.com/skywind3000/ECDICT/bc015ed2e24a7abef49fc6dbbb7fe32c1dadaf8b/ecdict.csv', archive: { ...source.archive, file: 'sources/ecdict.csv.gz' } },
    { ...source, id: 'omw-pwn30-2.0', name: 'Princeton WordNet 3.0', license: 'WordNet-3.0', url: 'https://github.com/omwn/omw-data/releases/tag/v2.0', archive: { ...source.archive, file: 'sources/wordnet.tar.xz' } },
    { ...source, id: 'yanxai-editorial-pwn30-20261022', name: 'Editorial Chinese sense notes', license: 'WordNet-3.0', url: 'https://github.com/RyanCoreAI/word', archive: { ...source.archive, file: 'sources/editorial.jsonl.gz' } },
  );
  const sourceUrl = 'https://github.com/omwn/omw-data/blob/406bf83b3c507a3d1f26e88252d5d66893fd36bf/wns/eng/wn-data-eng.tab#L123';
  const wordSense: WordSense = {
    id: 'pwn30-01617192-v', pos: 'verb', meaning: '製作；創造', meaningBasis: 'editorial', definition: 'make or cause to be or to become', usage: '用於製作或創造事物的義項。',
    sourceId: 'omw-pwn30-2.0', sourceUrl, editorialSourceId: 'yanxai-editorial-pwn30-20261022', tags: [],
    substitutes: [{ text: 'create', meaning: '製作；創造', meaningBasis: 'shared-sense', relationBasis: 'exact-synset', sourceId: 'omw-pwn30-2.0', sourceUrl, tags: [] }],
  };
  const ecdictSourceUrl = 'https://github.com/skywind3000/ECDICT/blob/bc015ed2e24a7abef49fc6dbbb7fe32c1dadaf8b/ecdict.csv#L456';
  const data = { make: { phrases: [
    ...f.data.make.phrases,
    { text: 'make a living', pos: 'phrase', sourceId: 'ecdict-bc015ed2e24a', sourceUrl: ecdictSourceUrl, tags: [], senses: [{ id: 'ecdict-line-456', meaning: '謀生', sourceId: 'ecdict-bc015ed2e24a', sourceUrl: ecdictSourceUrl, tags: [], substitutes: [] }] },
  ], wordSenses: [wordSense] } };
  const bytes = encode(data);
  manifest.shards.m = { ...manifest.shards.m!, bytes: bytes.length, sha256: await sha256(bytes) };
  f.files.set('/phrases/manifest.json', encode(manifest));
  f.files.set('/phrases/lexical-zh-test/m.json', bytes); f.files.set('/phrases/lexical-zh-test/c.json', encode({}));
  return { ...f, manifest: parsePhraseManifest(manifest), data, legacyKeys };
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
    const wrongToken = structuredClone(f.data);
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

describe('schema 2 lexical sources and legacy cache compatibility', () => {
  it('loads exact-synset word senses and mixed-license phrases without changing source meanings', async () => {
    const f = await schemaTwoFixture();
    const result = await new PhraseStore(f.options).load('make', 'dict-v1');
    expect(result.phrases.map(phrase => phrase.text)).toEqual(['make up', 'make a living']);
    expect(result.wordSenses[0]!.meaningBasis).toBe('editorial');
    expect(result.wordSenses[0]!.definition).toBe('make or cause to be or to become');
    expect(result.wordSenses[0]!.substitutes[0]).toMatchObject({ text: 'create', meaning: '製作；創造', meaningBasis: 'shared-sense', relationBasis: 'exact-synset' });
    expect(result.manifest.licenses.map(license => license.name)).toEqual(['CC-BY-SA-4.0', 'MIT', 'WordNet-3.0']);
    expect(f.fetcher).toHaveBeenCalledTimes(2);
  });

  it('reads the original schema 1 catalog bytes offline and adds only in-memory defaults', async () => {
    const f = await fixture();
    const original: Record<string, unknown> = structuredClone(f.manifest); delete original.licenses;
    f.files.set('/phrases/manifest.json', encode(original));
    const first = await new PhraseStore(f.options).load('make', 'dict-v1');
    expect(first.wordSenses).toEqual([]); expect(first.manifest.licenses).toEqual([first.manifest.license]);
    const catalog = [...f.responses.entries()].find(([key]) => key.includes('/catalog-'))![1];
    expect(await catalog.clone().json()).not.toHaveProperty('licenses');
    const offline = vi.fn<typeof fetch>(async () => { throw new Error('offline'); });
    expect(await new PhraseStore({ ...f.options, fetcher: offline }).load('make', 'dict-v1')).toEqual(first);
    expect(await f.responses.get([...f.responses.keys()].find(key => key.includes('/m.json'))!)!.clone().json()).toEqual(f.data);
  });

  it('updates a legacy catalog to schema 2 while preserving all existing verified cache entries', async () => {
    const f = await schemaTwoFixture(true);
    const result = await new PhraseStore(f.options).load('make', 'dict-v1');
    expect(result.manifest.schemaVersion).toBe(2); expect(result.wordSenses).toHaveLength(1);
    expect(f.legacyKeys.every(key => f.responses.has(key))).toBe(true);
    const offline = vi.fn<typeof fetch>(async () => { throw new Error('offline'); });
    expect(await new PhraseStore({ ...f.options, fetcher: offline }).load('make', 'dict-v1')).toEqual(result);
  });

  it('rejects missing or conflicting per-source licenses and new sources in a legacy catalog', async () => {
    const f = await schemaTwoFixture();
    const missing: Record<string, unknown> = structuredClone(f.manifest); delete missing.licenses;
    expect(() => parsePhraseManifest(missing)).toThrow();
    expect(() => parsePhraseManifest({ ...f.manifest, licenses: f.manifest.licenses.filter(license => license.name !== 'WordNet-3.0') })).toThrow();
    expect(() => parsePhraseManifest({ ...f.manifest, schemaVersion: 1 })).toThrow();
    expect(() => parsePhraseManifest({ ...f.manifest, licenses: f.manifest.licenses.map(license => license.name === 'CC-BY-SA-4.0' ? { ...license, sha256: '0'.repeat(64) } : license) })).toThrow();
    expect(() => parsePhraseManifest({ ...f.manifest, sources: [{ ...f.manifest.sources[0], license: 'unknown-license' }] })).toThrow();
  });

  it('pins content URLs to exact source repositories, commits and positive source lines', async () => {
    const f = await schemaTwoFixture();
    for (const sourceUrl of [
      'https://github.com/omwn/omw-data/blob/main/wns/eng/wn-data-eng.tab#L123',
      'https://github.com.evil.test/omwn/omw-data/blob/406bf83b3c507a3d1f26e88252d5d66893fd36bf/wns/eng/wn-data-eng.tab#L123',
      f.data.make.wordSenses[0]!.sourceUrl.replace('#L123', '#L0'),
    ]) {
      const bad = structuredClone(f.data); bad.make.wordSenses[0]!.sourceUrl = sourceUrl;
      expect(() => parsePhraseShard(bad, f.manifest, 'm')).toThrow();
    }
    const bad = structuredClone(f.data); bad.make.phrases[1]!.sourceUrl = bad.make.phrases[1]!.sourceUrl.replace('bc015ed2e24a7abef49fc6dbbb7fe32c1dadaf8b', 'main');
    expect(() => parsePhraseShard(bad, f.manifest, 'm')).toThrow();
  });

  it('rejects false editorial provenance, cross-sense substitutions and incorrect synset parts of speech', async () => {
    const f = await schemaTwoFixture();
    const mutations = [
      { editorialSourceId: 'missing-editorial-source' }, { editorialSourceId: 'omw-pwn30-2.0' },
      { sourceId: 'ecdict-bc015ed2e24a' }, { meaningBasis: 'shared-sense' }, { id: 'pwn30-01617192-n' },
    ];
    for (const mutation of mutations) { const bad = structuredClone(f.data); Object.assign(bad.make.wordSenses[0]!, mutation); expect(() => parsePhraseShard(bad, f.manifest, 'm')).toThrow(); }
    const wrongMeaning = structuredClone(f.data); wrongMeaning.make.wordSenses[0]!.substitutes[0]!.meaning = '不相符的意思';
    expect(() => parsePhraseShard(wrongMeaning, f.manifest, 'm')).toThrow();
    const wrongRelation = structuredClone(f.data); Object.assign(wrongRelation.make.wordSenses[0]!.substitutes[0]!, { relationBasis: 'single-source-sense' });
    expect(() => parsePhraseShard(wrongRelation, f.manifest, 'm')).toThrow();
  });

  it('bounds expanded sense arrays and rejects empty or duplicate lexical records', async () => {
    const f = await schemaTwoFixture();
    const oversized = structuredClone(f.data); oversized.make.wordSenses = Array(4).fill(f.data.make.wordSenses[0]);
    expect(() => parsePhraseShard(oversized, f.manifest, 'm')).toThrow();
    const substitutes = structuredClone(f.data); substitutes.make.wordSenses[0]!.substitutes = Array(5).fill(f.data.make.wordSenses[0]!.substitutes[0]);
    expect(() => parsePhraseShard(substitutes, f.manifest, 'm')).toThrow();
    expect(() => parsePhraseShard({ make: { phrases: [], wordSenses: [] } }, f.manifest, 'm')).toThrow();
    const duplicated = structuredClone(f.data); duplicated.make.wordSenses.push(duplicated.make.wordSenses[0]!);
    expect(() => parsePhraseShard(duplicated, f.manifest, 'm')).toThrow();
  });
});
