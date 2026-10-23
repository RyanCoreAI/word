import { z } from 'zod';
import { sha256 } from './dictionary';

const CACHE = 'word-phrases-v1';
const MAX_MANIFEST_BYTES = 512 * 1024;
const MAX_SHARD_BYTES = 16 * 1024 * 1024;
const hash = z.string().regex(/^[a-f0-9]{64}$/);
const version = z.string().min(1).max(200);
const localPath = z.string().min(1).max(300).regex(/^[A-Za-z0-9_./-]+$/).refine(value => !value.startsWith('/') && value.split('/').every(part => part !== '.' && part !== '..' && part !== ''), 'Invalid phrase asset path');
const httpsUrl = z.string().url().max(2000).refine(value => { const url = new URL(value); return url.protocol === 'https:' && !url.username && !url.password; }, 'Expected public HTTPS URL');
const wikiUrl = httpsUrl.refine(value => value.startsWith('https://zh.wiktionary.org/wiki/') && new URL(value).pathname.length > '/wiki/'.length, 'Expected Chinese Wiktionary page');
const ecdictPage = /^https:\/\/github\.com\/skywind3000\/ECDICT\/blob\/bc015ed2e24a7abef49fc6dbbb7fe32c1dadaf8b\/ecdict\.csv#L[1-9]\d*$/;
const wordnetPage = /^https:\/\/github\.com\/omwn\/omw-data\/blob\/406bf83b3c507a3d1f26e88252d5d66893fd36bf\/wns\/eng\/wn-data-eng\.tab#L[1-9]\d*$/;
const ecdictUrl = httpsUrl.refine(value => ecdictPage.test(value), 'Expected pinned ECDICT source line');
const wordnetUrl = httpsUrl.refine(value => wordnetPage.test(value), 'Expected pinned WordNet source line');
const contentUrl = z.union([wikiUrl, ecdictUrl, wordnetUrl]);
const identifier = z.string().min(1).max(200);
const day = z.string().regex(/^\d{4}-\d{2}-\d{2}$/).refine(value => { const date = new Date(`${value}T00:00:00Z`); return Number.isFinite(date.getTime()) && date.toISOString().slice(0, 10) === value; }, 'Invalid source date');
const descriptor = z.object({ file: localPath, bytes: z.number().int().positive().max(Number.MAX_SAFE_INTEGER), sha256: hash }).strict();
const tags = z.array(z.string().min(1).max(48)).max(16);
const wordPattern = /^[a-z]+(?:'[a-z]+)?$/;
const phrasePattern = /^[a-z]+(?:'[a-z]+)?(?: [a-z]+(?:'[a-z]+)?){1,5}$/;
const meaning = z.string().min(1).max(180).regex(/[\u3400-\u9fff]/, 'Expected unchanged Chinese source meaning');
const substituteSchema = z.object({
  text: z.string().min(1).max(96).refine(value => wordPattern.test(value) || phrasePattern.test(value)), meaning,
  meaningBasis: z.literal('shared-sense'), relationBasis: z.enum(['exact-source-sense', 'single-source-sense', 'exact-synset']),
  sourceUrl: contentUrl, sourceId: identifier, tags,
}).strict();
const senseSchema = z.object({ id: identifier, meaning, sourceUrl: contentUrl, sourceId: identifier, tags, substitutes: z.array(substituteSchema).max(4) }).strict();
const phraseSchema = z.object({
  text: z.string().min(1).max(96).regex(phrasePattern),
  pos: z.enum(['noun', 'verb', 'adj', 'adv', 'phrase', 'prep', 'prep_phrase', 'conj', 'intj', 'pron', 'det', 'num']),
  sourceUrl: contentUrl, sourceId: identifier, tags, senses: z.array(senseSchema).min(1).max(3),
}).strict();
const wordSenseSchema = z.object({
  id: z.string().regex(/^pwn30-\d{8}-[nvar]$/), pos: z.enum(['noun', 'verb', 'adj', 'adv']),
  meaning, meaningBasis: z.literal('editorial'), definition: z.string().min(1).max(400).regex(/[A-Za-z]/), usage: z.string().max(240),
  sourceId: identifier, sourceUrl: wordnetUrl, editorialSourceId: identifier, tags,
  substitutes: z.array(substituteSchema.extend({ relationBasis: z.literal('exact-synset'), sourceUrl: wordnetUrl }).strict()).max(4),
}).strict();
const wordKey = z.string().max(256).regex(wordPattern);
const legacyShardSchema = z.record(wordKey, z.object({ phrases: z.array(phraseSchema).min(1).max(6) }).strict());
const shardSchema = z.record(wordKey, z.object({ phrases: z.array(phraseSchema).max(6), wordSenses: z.array(wordSenseSchema).max(3) }).strict().refine(value => value.phrases.length + value.wordSenses.length > 0, 'Empty lexical record'));
const licenseName = z.enum(['CC-BY-SA-4.0', 'MIT', 'WordNet-3.0']);
const licenseSchema = descriptor.extend({ name: licenseName, url: httpsUrl }).strict();
export const phraseManifestSchema = z.object({
  schemaVersion: z.union([z.literal(1), z.literal(2)]), version, dictionaryVersion: version,
  sources: z.array(z.object({
    id: identifier, name: z.string().min(1).max(300), url: httpsUrl, pageUrl: httpsUrl, sha256: hash,
    bytes: z.number().int().positive().max(Number.MAX_SAFE_INTEGER), extractedAt: day, dumpDate: day,
    archive: descriptor.extend({ mirrorUrl: httpsUrl.optional() }).strict(), license: licenseName,
  }).strict()).min(1).max(64),
  shards: z.record(z.string().regex(/^[a-z]$/), descriptor.extend({ count: z.number().int().nonnegative().max(100_000), bytes: z.number().int().positive().max(MAX_SHARD_BYTES) }).strict()),
  coverage: z.unknown(), policy: z.unknown().optional(),
  license: descriptor.extend({ name: z.literal('CC-BY-SA-4.0'), url: httpsUrl }).strict(),
  licenses: z.array(licenseSchema).min(1).max(8).optional(),
  attribution: descriptor,
}).strict().superRefine((manifest, ctx) => {
  const shards = Object.values(manifest.shards);
  if (!shards.length || shards.length > 26 || new Set(shards.map(shard => shard.file)).size !== shards.length) ctx.addIssue({ code: 'custom', message: 'Invalid phrase shard list' });
  if (new Set(manifest.sources.map(source => source.id)).size !== manifest.sources.length) ctx.addIssue({ code: 'custom', message: 'Duplicate phrase sources' });
  if (![...shards, manifest.attribution].every(asset => asset.file.startsWith(`${manifest.version}/`))) ctx.addIssue({ code: 'custom', message: 'Phrase shards and attribution must be versioned' });
  const licenses = manifest.licenses ?? [manifest.license];
  if (manifest.schemaVersion === 2 && !manifest.licenses) ctx.addIssue({ code: 'custom', message: 'Schema 2 requires per-source licenses' });
  if (manifest.schemaVersion === 1 && (manifest.sources.some(source => source.license !== 'CC-BY-SA-4.0') || licenses.some(license => license.name !== 'CC-BY-SA-4.0'))) ctx.addIssue({ code: 'custom', message: 'Legacy catalog cannot contain new source types' });
  if (new Set(licenses.map(license => license.name)).size !== licenses.length || new Set(licenses.map(license => license.file)).size !== licenses.length) ctx.addIssue({ code: 'custom', message: 'Duplicate lexical licenses' });
  if (manifest.sources.some(source => !licenses.some(license => license.name === source.license))) ctx.addIssue({ code: 'custom', message: 'Missing source license' });
  const primary = licenses.find(license => license.name === manifest.license.name);
  if (!primary || ['url', 'file', 'bytes', 'sha256'].some(key => primary[key as keyof typeof primary] !== manifest.license[key as keyof typeof manifest.license])) ctx.addIssue({ code: 'custom', message: 'Primary license differs from its descriptor' });
}).transform(manifest => ({ ...manifest, licenses: manifest.licenses ?? [manifest.license] }));
export type Phrase = z.infer<typeof phraseSchema>;
export type WordSense = z.infer<typeof wordSenseSchema>;
export type PhraseManifest = z.infer<typeof phraseManifestSchema>;
export type PhraseShard = z.infer<typeof shardSchema>;
export interface PhraseResult { phrases: Phrase[]; wordSenses: WordSense[]; manifest: PhraseManifest }
export interface PhraseOptions { baseUrl: string; fetcher?: typeof fetch; cacheStorage?: Pick<CacheStorage, 'open'> }

export function parsePhraseManifest(input: unknown): PhraseManifest { return phraseManifestSchema.parse(input); }

function phrasePage(text: string): string { return `https://zh.wiktionary.org/wiki/${encodeURIComponent(text.replaceAll(' ', '_')).replaceAll("'", '%27')}`; }

/** Source sense identity is preserved; a substitute never invents its own translation. */
export function parsePhraseShard(input: unknown, manifest: PhraseManifest, letter: string): PhraseShard {
  // Normalize in memory only. Legacy cached bytes keep their original checksums.
  const shard: PhraseShard = manifest.schemaVersion === 1
    ? Object.fromEntries(Object.entries(legacyShardSchema.parse(input)).map(([word, record]) => [word, { ...record, wordSenses: [] }]))
    : shardSchema.parse(input);
  const asset = Object.hasOwn(manifest.shards, letter) ? manifest.shards[letter] : undefined;
  if (!asset || Object.keys(shard).length !== asset.count) throw new Error('短语分片数量不匹配。');
  const sources = new Map(manifest.sources.map(source => [source.id, source]));
  for (const [wordId, record] of Object.entries(shard)) {
    if (wordId[0] !== letter || new Set(record.phrases.map(phrase => phrase.text)).size !== record.phrases.length) throw new Error('短语关联或重复词条无效。');
    for (const phrase of record.phrases) {
      const source = sources.get(phrase.sourceId);
      const correctPage = source?.license === 'CC-BY-SA-4.0' ? phrase.sourceUrl === phrasePage(phrase.text) : source?.license === 'MIT' && ecdictPage.test(phrase.sourceUrl) && phrase.pos === 'phrase';
      if (!phrase.text.split(' ').includes(wordId) || !correctPage) throw new Error('短语来源或单词关联无效。');
      for (const sense of phrase.senses) {
        if (sense.sourceId !== phrase.sourceId || sense.sourceUrl !== phrase.sourceUrl) throw new Error('短语词义来源不一致。');
        for (const substitute of sense.substitutes) {
          if (substitute.relationBasis === 'exact-synset' || substitute.sourceId !== sense.sourceId || substitute.sourceUrl !== sense.sourceUrl || substitute.meaning !== sense.meaning || substitute.text === phrase.text) throw new Error('替代表达与原词义来源不一致。');
        }
      }
    }
    if (new Set(record.wordSenses.map(sense => sense.id)).size !== record.wordSenses.length) throw new Error('重复的单词义项。');
    for (const sense of record.wordSenses) {
      const source = sources.get(sense.sourceId); const editorial = sources.get(sense.editorialSourceId);
      const partOfSpeech = { noun: 'n', verb: 'v', adj: 'a', adv: 'r' }[sense.pos];
      if (source?.license !== 'WordNet-3.0' || editorial?.license !== 'WordNet-3.0' || sense.editorialSourceId === sense.sourceId || !sense.id.endsWith(`-${partOfSpeech}`)) throw new Error('单词义项来源、编辑来源或词性无效。');
      if (new Set(sense.substitutes.map(substitute => substitute.text)).size !== sense.substitutes.length) throw new Error('重复的同义表达。');
      for (const substitute of sense.substitutes) {
        if (substitute.sourceId !== sense.sourceId || substitute.sourceUrl !== sense.sourceUrl || substitute.meaning !== sense.meaning || substitute.text === wordId) throw new Error('同义表达与源义项不一致。');
      }
    }
  }
  return shard;
}

function active(signal?: AbortSignal): void { if (signal?.aborted) throw new DOMException('短语加载已取消。', 'AbortError'); }
function json(bytes: Uint8Array): unknown { return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)) as unknown; }

async function limited(response: Response, maximum: number, signal?: AbortSignal): Promise<Uint8Array> {
  active(signal);
  if (!response.ok || !response.body) throw new Error(`短语文件暂时无法下载（${response.status}）。`);
  const reader = response.body.getReader(); const parts: Uint8Array[] = []; let size = 0;
  let abort: (() => void) | undefined;
  const aborted = new Promise<never>((_, reject) => { abort = () => { reject(new DOMException('短语加载已取消。', 'AbortError')); void reader.cancel().catch(() => {}); }; });
  signal?.addEventListener('abort', abort!, { once: true });
  try {
    for (;;) {
      active(signal);
      const part = await Promise.race([reader.read(), aborted]);
      if (part.done) break;
      size += part.value.byteLength;
      if (size > maximum) { await reader.cancel(); throw new Error('短语文件超过允许大小。'); }
      parts.push(part.value);
    }
    active(signal);
  } finally { signal?.removeEventListener('abort', abort!); reader.releaseLock(); }
  const bytes = new Uint8Array(size); let offset = 0;
  for (const part of parts) { bytes.set(part, offset); offset += part.byteLength; }
  return bytes;
}

/** No requests, CacheStorage operations or progress changes occur on construction. */
export class PhraseStore {
  private manifest: PhraseManifest | null = null;
  private readonly shards = new Map<string, PhraseShard>();
  constructor(private readonly options: PhraseOptions) {}

  /** Retry may discover a newer supplement for the same dictionary. Keep verified offline files. */
  invalidate(): void { this.manifest = null; this.shards.clear(); }

  private base(): URL {
    const url = new URL(this.options.baseUrl, typeof document === 'undefined' ? undefined : document.baseURI);
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash || !url.pathname.endsWith('/') || (typeof location !== 'undefined' && url.origin !== location.origin)) throw new Error('短语地址必须与本站同源。');
    return url;
  }
  private assetUrl(file: string, digest?: string): URL {
    const base = this.base(); const url = new URL(file, base);
    if (url.origin !== base.origin || !url.pathname.startsWith(base.pathname)) throw new Error('短语文件地址无效。');
    if (digest) url.searchParams.set('sha256', digest);
    return url;
  }
  private async cache(): Promise<Cache> {
    const storage = this.options.cacheStorage ?? globalThis.caches;
    if (!storage) throw new Error('当前浏览器无法缓存短语，请使用 HTTPS 浏览器。');
    return storage.open(CACHE);
  }
  private async request(url: URL, maximum: number, signal?: AbortSignal): Promise<Uint8Array> {
    active(signal);
    const response = await (this.options.fetcher ?? fetch)(url, { signal, cache: 'no-store', credentials: 'same-origin', redirect: 'error' });
    if (response.redirected || (response.url && new URL(response.url).origin !== url.origin)) throw new Error('短语文件禁止跨源或重定向。');
    return limited(response, maximum, signal);
  }
  private async put(cache: Cache, key: string, bytes: Uint8Array, signal?: AbortSignal): Promise<void> {
    active(signal);
    try { await cache.put(key, new Response(new Uint8Array(bytes), { headers: { 'Content-Type': 'application/json', 'Content-Length': String(bytes.byteLength) } })); }
    catch { throw new Error('短语离线缓存保存失败，请检查本机存储空间。'); }
    active(signal);
  }
  private async catalog(dictionaryVersion: string, cache: Cache, signal?: AbortSignal): Promise<PhraseManifest> {
    const key = this.assetUrl(`catalog-${encodeURIComponent(dictionaryVersion)}.json`).href;
    let cached: PhraseManifest | null = null;
    const validate = (input: unknown) => { const result = parsePhraseManifest(input); if (result.dictionaryVersion !== dictionaryVersion) throw new Error('短语与当前词库版本不匹配。'); return result; };
    try { const response = await cache.match(key); if (response) cached = validate(json(await limited(response, MAX_MANIFEST_BYTES, signal))); }
    catch { active(signal); /* Damaged reproducible metadata may be fetched again. */ }
    try {
      const bytes = await this.request(this.assetUrl('manifest.json'), MAX_MANIFEST_BYTES, signal);
      const manifest = validate(json(bytes));
      await this.put(cache, key, bytes, signal);
      return manifest;
    } catch (error) { active(signal); if (cached) return cached; throw error; }
  }
  async load(wordId: string, dictionaryVersion: string, signal?: AbortSignal): Promise<PhraseResult> {
    active(signal);
    if (!wordId || wordId.length > 256 || !dictionaryVersion || dictionaryVersion.length > 200) throw new Error('短语查询参数无效。');
    this.base();
    const cache = await this.cache(); active(signal);
    if (!this.manifest || this.manifest.dictionaryVersion !== dictionaryVersion) { this.manifest = await this.catalog(dictionaryVersion, cache, signal); this.shards.clear(); }
    const manifest = this.manifest;
    const letter = wordId[0]!;
    const asset = wordPattern.test(wordId) && Object.hasOwn(manifest.shards, letter) ? manifest.shards[letter] : undefined;
    if (!asset) return { phrases: [], wordSenses: [], manifest };
    const key = this.assetUrl(asset.file, asset.sha256).href;
    let shard = this.shards.get(key);
    const validate = async (bytes: Uint8Array): Promise<PhraseShard> => {
      active(signal);
      if (bytes.byteLength !== asset.bytes || await sha256(bytes) !== asset.sha256) throw new Error('短语文件校验失败，请重试。');
      active(signal); return parsePhraseShard(json(bytes), manifest, letter);
    };
    if (!shard) {
      try { const response = await cache.match(key); if (response) shard = await validate(await limited(response, asset.bytes, signal)); }
      catch { active(signal); /* Repair only this phrase cache; learning data is untouched. */ }
      if (!shard) { const bytes = await this.request(this.assetUrl(asset.file), asset.bytes, signal); shard = await validate(bytes); await this.put(cache, key, bytes, signal); }
      this.shards.set(key, shard);
    }
    active(signal);
    const record = Object.hasOwn(shard, wordId) ? shard[wordId] : undefined;
    return { phrases: record?.phrases ?? [], wordSenses: record?.wordSenses ?? [], manifest };
  }
}
