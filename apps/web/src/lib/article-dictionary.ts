import './validation-policy';
import { z } from 'zod';
import { parseWords, type Word } from '../../../../packages/core/src';
import { dictionaryManifestSchema, sha256 } from './dictionary';
import type { WordDatabase } from './storage';

const MAX_ASSET_BYTES = 16 * 1024 * 1024;
const MAX_MANIFEST_BYTES = 64 * 1024;
const formSchema = z.string().min(1).max(256).regex(/^[a-z]+(?:-[a-z]+)*$/);
const assetSchema = z.object({
  file: z.string().min(1).max(300).regex(/^[A-Za-z0-9_./-]+$/).refine(value => !value.startsWith('/') && !value.split('/').some(part => part === '..' || part === ''), 'Invalid reading dictionary path'),
  count: z.number().int().nonnegative().max(200_000), bytes: z.number().int().positive().max(MAX_ASSET_BYTES),
  sha256: z.string().regex(/^[a-f0-9]{64}$/),
}).strict();
export const articleDictionaryManifestSchema = z.object({
  schema: z.literal(1), version: z.string().min(1).max(200),
  source: dictionaryManifestSchema.shape.source, license: dictionaryManifestSchema.shape.license,
  policy: z.object({ schema: z.literal(1), frequencyMax: z.literal(50_000), words: z.string().min(1).max(500), lemmas: z.string().min(1).max(500) }).strict(),
  words: assetSchema, lemmas: assetSchema,
}).strict().superRefine((manifest, ctx) => {
  if (manifest.words.count > 100_000 || manifest.words.file === manifest.lemmas.file) ctx.addIssue({ code: 'custom', message: 'Invalid reading dictionary assets' });
});
const lemmasSchema = z.record(formSchema, z.array(formSchema).min(1).max(32).refine(values => new Set(values).size === values.length, 'Duplicate lemma candidates'))
  .refine(value => Object.keys(value).length <= 200_000, 'Too many inflected forms');
const cacheSchema = z.object({ manifest: articleDictionaryManifestSchema, wordsText: z.string().max(MAX_ASSET_BYTES), lemmasText: z.string().max(MAX_ASSET_BYTES) }).strict();

export interface ArticleDictionary {
  version: string;
  words: Word[];
  lemmas: Record<string, string[]>;
}
export interface ArticleDictionaryOptions {
  baseUrl: string;
  dictionaryVersion: string;
  signal?: AbortSignal;
  fetcher?: typeof fetch;
  refresh?: boolean;
}

function assertActive(signal?: AbortSignal): void {
  if (signal?.aborted) throw new DOMException('阅读资料下载已取消。', 'AbortError');
}

async function readLimited(response: Response, maximum: number, signal?: AbortSignal): Promise<Uint8Array> {
  if (!response.ok) throw new Error(`阅读资料下载失败（${response.status}），正文没有上传，请稍后重试。`);
  const reader = response.body?.getReader();
  if (!reader) throw new Error('阅读资料下载失败：文件内容为空。');
  const parts: Uint8Array[] = [];
  let length = 0;
  try {
    for (;;) {
      assertActive(signal);
      const item = await reader.read();
      if (item.done) break;
      length += item.value.byteLength;
      if (length > maximum) { await reader.cancel(); throw new Error('阅读资料超过允许大小。'); }
      parts.push(item.value);
    }
  } finally { reader.releaseLock(); }
  assertActive(signal);
  const result = new Uint8Array(length);
  let offset = 0;
  for (const part of parts) { result.set(part, offset); offset += part.byteLength; }
  return result;
}

async function checkedText(text: string, asset: z.infer<typeof assetSchema>): Promise<string> {
  const bytes = new TextEncoder().encode(text);
  if (bytes.byteLength !== asset.bytes || await sha256(bytes) !== asset.sha256) throw new Error('阅读资料校验失败；文章和学习进度已保留，请重新下载阅读资料。');
  return text;
}

async function parseCache(input: unknown, version: string): Promise<ArticleDictionary> {
  const cache = cacheSchema.parse(input);
  if (cache.manifest.version !== version) throw new Error('阅读资料版本与当前词库不一致。');
  const [wordsText, lemmasText] = await Promise.all([
    checkedText(cache.wordsText, cache.manifest.words), checkedText(cache.lemmasText, cache.manifest.lemmas),
  ]);
  const words = parseWords(JSON.parse(wordsText) as unknown);
  const lemmas = lemmasSchema.parse(JSON.parse(lemmasText) as unknown);
  if (words.length !== cache.manifest.words.count || Object.keys(lemmas).length !== cache.manifest.lemmas.count) throw new Error('阅读资料条数不匹配。');
  const included = new Set(words.map(word => word.word));
  let previousRank = -1;
  for (const word of words) {
    if (!formSchema.safeParse(word.word).success || !word.translation.trim() || word.rank <= previousRank) throw new Error('阅读词条格式无效。');
    previousRank = word.rank;
  }
  for (const [form, candidates] of Object.entries(lemmas)) {
    if (candidates.includes(form) || candidates.some(candidate => !included.has(candidate))) throw new Error('阅读词形索引无效。');
  }
  return { version: cache.manifest.version, words, lemmas };
}

/** No network request. A cache is useful only after revalidating its original hashes and schema. */
export async function readCachedArticleDictionary(db: WordDatabase, dictionaryVersion: string): Promise<ArticleDictionary | null> {
  const input = await db.readArticleDictionaryCache(dictionaryVersion);
  return input === undefined ? null : parseCache(input, dictionaryVersion);
}

/** Called only after explicit analysis: never loads the full 770k-entry dictionary or sends article text. */
export async function loadArticleDictionary(db: WordDatabase, options: ArticleDictionaryOptions): Promise<ArticleDictionary> {
  assertActive(options.signal);
  if (!options.refresh) {
    const cached = await readCachedArticleDictionary(db, options.dictionaryVersion);
    if (cached) { assertActive(options.signal); return cached; }
  }
  const base = new URL(options.baseUrl);
  if (typeof location !== 'undefined' && base.origin !== location.origin) throw new Error('阅读资料必须从本站加载。');
  const fetcher = options.fetcher ?? fetch;
  const response = await fetcher(new URL('article-manifest.json', base), { signal: options.signal, cache: 'no-store', credentials: 'same-origin' });
  const manifestBytes = await readLimited(response, MAX_MANIFEST_BYTES, options.signal);
  const manifest = articleDictionaryManifestSchema.parse(JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(manifestBytes)) as unknown);
  if (manifest.version !== options.dictionaryVersion) throw new Error('阅读资料版本与当前词库不一致，请更新页面后重试。');
  const fetchText = async (asset: z.infer<typeof assetSchema>) => {
    const assetResponse = await fetcher(new URL(asset.file, base), { signal: options.signal, cache: 'no-store', credentials: 'same-origin' });
    const bytes = await readLimited(assetResponse, asset.bytes, options.signal);
    if (bytes.byteLength !== asset.bytes || await sha256(bytes) !== asset.sha256) throw new Error('阅读资料校验失败，未替换本机有效缓存。');
    return new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  };
  const [wordsText, lemmasText] = await Promise.all([fetchText(manifest.words), fetchText(manifest.lemmas)]);
  const input = { manifest, wordsText, lemmasText };
  const parsed = await parseCache(input, options.dictionaryVersion);
  assertActive(options.signal);
  await db.saveArticleDictionaryCache(options.dictionaryVersion, input);
  return parsed;
}

/** Keep all reading roots; enrich only this article's exact forms from the optional full dictionary. */
export async function mergeArticleDictionary(
  db: WordDatabase, version: string, forms: readonly string[], pack: ArticleDictionary, studyWords: readonly Word[],
): Promise<Word[]> {
  if (pack.version !== version) throw new Error('阅读资料版本与当前词库不一致。');
  const exact = await db.lookupDictionaryExact(version, forms);
  const byId = new Map<string, Word>();
  for (const word of [...pack.words, ...studyWords, ...exact]) byId.set(word.id, word);
  return [...byId.values()];
}
