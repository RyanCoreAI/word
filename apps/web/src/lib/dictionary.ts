import { z } from 'zod';
import { parseWords, type Word } from '../../../../packages/core/src';
import { dictionaryEntrySchema, type WordDatabase } from './storage';

const MAX_MANIFEST_BYTES = 512 * 1024;
const MAX_DATA_BYTES = 16 * 1024 * 1024;
const digestSchema = z.string().regex(/^[a-f0-9]{64}$/);
const relativePath = z.string().min(1).max(300).regex(/^[A-Za-z0-9_./-]+$/).refine(value => !value.startsWith('/') && !value.split('/').some(part => part === '..' || part === ''), 'Invalid dictionary path');
const assetSchema = z.object({ file: relativePath, count: z.number().int().positive().max(1_000_000), bytes: z.number().int().positive().max(MAX_DATA_BYTES), sha256: digestSchema }).strict();
export const dictionaryManifestSchema = z.object({
  version: z.string().min(1).max(200),
  source: z.object({ name: z.literal('ECDICT'), commit: z.string().regex(/^[a-f0-9]{40}$/), url: z.string().url(), sha256: digestSchema, bytes: z.number().int().positive() }).strict(),
  total: z.number().int().positive().max(1_000_000),
  studyCount: z.number().int().positive().max(100_000),
  study: assetSchema,
  shards: z.array(assetSchema).min(1).max(2000),
  license: z.object({ name: z.literal('MIT'), file: z.string().min(1).max(300), sourceUrl: z.string().url(), sha256: digestSchema }).strict(),
  stats: z.unknown(), policy: z.unknown(),
}).strict().superRefine((manifest, ctx) => {
  if (manifest.study.count !== manifest.studyCount || manifest.studyCount > manifest.total) ctx.addIssue({ code: 'custom', message: 'Dictionary study count mismatch' });
  if (manifest.shards.reduce((sum, shard) => sum + shard.count, 0) !== manifest.total) ctx.addIssue({ code: 'custom', message: 'Dictionary shard count mismatch' });
  if (new Set(manifest.shards.map(shard => shard.file)).size !== manifest.shards.length) ctx.addIssue({ code: 'custom', message: 'Duplicate dictionary shards' });
});

export type DictionaryManifest = z.infer<typeof dictionaryManifestSchema>;
export interface StudyDictionary { manifest: DictionaryManifest; words: Word[] }
export interface DownloadProgress { completed: number; total: number; entries: number; totalEntries: number; bytes: number; totalBytes: number }
interface DownloadOptions { baseUrl: string; signal?: AbortSignal; onProgress?: (progress: DownloadProgress) => void; fetcher?: typeof fetch }

export async function sha256(bytes: Uint8Array): Promise<string> {
  if (!globalThis.crypto?.subtle) throw new Error('dictionary checksum: 此浏览器无法校验词库，请使用 HTTPS 安全页面。');
  const digest = await crypto.subtle.digest('SHA-256', new Uint8Array(bytes));
  return Array.from(new Uint8Array(digest), value => value.toString(16).padStart(2, '0')).join('');
}

function assertActive(signal?: AbortSignal): void {
  if (signal?.aborted) throw new DOMException('下载已暂停。', 'AbortError');
}

async function readLimited(response: Response, maxBytes: number): Promise<Uint8Array> {
  if (!response.ok) throw new Error(`dictionary fetch failed (${response.status})`);
  const reader = response.body?.getReader();
  if (!reader) throw new Error('dictionary fetch failed: response has no body');
  const parts: Uint8Array[] = [];
  let length = 0;
  try {
    for (;;) {
      const item = await reader.read();
      if (item.done) break;
      length += item.value.byteLength;
      if (length > maxBytes) { await reader.cancel(); throw new Error('dictionary validation: 文件超过允许大小。'); }
      parts.push(item.value);
    }
  } finally { reader.releaseLock(); }
  const result = new Uint8Array(length);
  let offset = 0;
  for (const part of parts) { result.set(part, offset); offset += part.byteLength; }
  return result;
}

async function fetchAsset(asset: z.infer<typeof assetSchema>, options: DownloadOptions): Promise<string> {
  assertActive(options.signal);
  const response = await (options.fetcher ?? fetch)(new URL(asset.file, options.baseUrl), { signal: options.signal, cache: 'no-store', credentials: 'same-origin' });
  const bytes = await readLimited(response, asset.bytes);
  assertActive(options.signal);
  if (bytes.byteLength !== asset.bytes || await sha256(bytes) !== asset.sha256) throw new Error('dictionary checksum mismatch: 词库分片校验失败，请重新下载。');
  return new TextDecoder('utf-8', { fatal: true }).decode(bytes);
}

function parseStudy(text: string, manifest: DictionaryManifest): Word[] {
  const words = parseWords(JSON.parse(text) as unknown);
  if (words.length !== manifest.studyCount) throw new Error('dictionary validation: 学习词库条数不匹配。');
  return words;
}

/** Offline startup: cached raw text is verified against its original manifest before use. */
export async function readCachedStudy(db: WordDatabase): Promise<StudyDictionary | null> {
  const input = await db.readStudyCache();
  if (input === undefined) return null;
  const cache = z.object({ manifest: dictionaryManifestSchema, text: z.string().max(MAX_DATA_BYTES) }).strict().parse(input);
  const bytes = new TextEncoder().encode(cache.text);
  if (bytes.byteLength !== cache.manifest.study.bytes || await sha256(bytes) !== cache.manifest.study.sha256) throw new Error('dictionary checksum mismatch: 本机词库损坏，进度已保留。');
  return { manifest: cache.manifest, words: parseStudy(cache.text, cache.manifest) };
}

export async function loadStudyDictionary(db: WordDatabase, options: DownloadOptions): Promise<StudyDictionary> {
  assertActive(options.signal);
  const response = await (options.fetcher ?? fetch)(new URL('manifest.json', options.baseUrl), { signal: options.signal, cache: 'no-store', credentials: 'same-origin' });
  const manifestBytes = await readLimited(response, MAX_MANIFEST_BYTES);
  const manifest = dictionaryManifestSchema.parse(JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(manifestBytes)) as unknown);
  const text = await fetchAsset(manifest.study, options);
  const words = parseStudy(text, manifest);
  assertActive(options.signal);
  await db.saveStudyCache({ manifest, text }, manifest.version);
  options.onProgress?.({ completed: 1, total: 1, entries: words.length, totalEntries: words.length, bytes: manifest.study.bytes, totalBytes: manifest.study.bytes });
  return { manifest, words };
}

export async function getDownloadProgress(db: WordDatabase, input: DictionaryManifest): Promise<DownloadProgress> {
  const manifest = dictionaryManifestSchema.parse(input);
  const receipts = await db.getChunkReceipts(manifest.version);
  const byFile = new Map(manifest.shards.map(shard => [shard.file, shard]));
  let bytes = 0;
  for (const receipt of receipts) {
    const shard = byFile.get(receipt.id);
    if (!shard || shard.sha256 !== receipt.sha256 || shard.count !== receipt.count) throw new Error('dictionary version mismatch: 已下载词库与当前分片清单不一致。');
    bytes += shard.bytes;
  }
  return { completed: receipts.length, total: manifest.shards.length, entries: receipts.reduce((sum, receipt) => sum + receipt.count, 0), totalEntries: manifest.total, bytes, totalBytes: manifest.shards.reduce((sum, shard) => sum + shard.bytes, 0) };
}

/** Pause interrupts network/validation; an in-flight DB transaction finishes atomically. */
export async function downloadAll(db: WordDatabase, input: DictionaryManifest, options: DownloadOptions): Promise<DownloadProgress> {
  const manifest = dictionaryManifestSchema.parse(input);
  const cached = await readCachedStudy(db);
  if (!cached || cached.manifest.version !== manifest.version || cached.manifest.study.sha256 !== manifest.study.sha256) throw new Error('dictionary version mismatch: 请先加载相同版本的学习词库。');
  let progress = await getDownloadProgress(db, manifest);
  options.onProgress?.(progress);
  const completed = new Set((await db.getChunkReceipts(manifest.version)).map(receipt => receipt.id));
  for (const shard of manifest.shards) {
    assertActive(options.signal);
    if (completed.has(shard.file)) continue;
    const text = await fetchAsset(shard, options);
    const entries = z.array(dictionaryEntrySchema).max(100_000).parse(JSON.parse(text) as unknown);
    if (entries.length !== shard.count) throw new Error('dictionary validation: 词典分片条数不匹配。');
    assertActive(options.signal);
    await db.importDictionaryChunk({ version: manifest.version, id: shard.file, sha256: shard.sha256, count: shard.count }, entries);
    progress = await getDownloadProgress(db, manifest);
    options.onProgress?.(progress);
  }
  if (progress.completed !== progress.total || progress.entries !== progress.totalEntries) throw new Error('dictionary validation: 完整词典尚未下载完成。');
  return progress;
}

export function searchDictionary(db: WordDatabase, version: string, query: string, limit = 30): Promise<Word[]> {
  return db.searchDictionary(version, query, limit);
}
