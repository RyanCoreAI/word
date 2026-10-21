import { z } from 'zod';
import { sha256 } from './dictionary';

const CACHE = 'word-audio-v1';
const MAX_PACK_BYTES = 20 * 1024 * 1024;
const MAX_INDEX_BYTES = 8 * 1024 * 1024;
const hash = z.string().regex(/^[a-f0-9]{64}$/);
const path = z.string().max(240).regex(/^[a-zA-Z0-9_./-]+$/).refine(value => !value.startsWith('/') && value.split('/').every(part => part !== '..' && part !== ''), 'Invalid audio path');
const asset = z.object({ file: path, bytes: z.number().int().positive().max(MAX_PACK_BYTES), sha256: hash });
export const audioManifestSchema = z.object({
  schema: z.literal(1), version: z.string().min(1).max(200), dictionaryVersion: z.string().min(1).max(200), studySha256: hash,
  voice: z.object({ id: z.string().min(1).max(100), accent: z.literal('en-US'), label: z.string().min(1).max(100), modelSha256: hash, provenance: path }).strict(),
  index: asset.extend({ count: z.number().int().positive().max(100_000), bytes: z.number().int().positive().max(MAX_INDEX_BYTES) }).strict(),
  packs: z.array(asset.extend({ id: z.string().regex(/^pack-\d{4}$/), count: z.number().int().positive().max(1000) }).strict()).min(1).max(2000),
}).strict().superRefine((value, ctx) => {
  if (new Set(value.packs.map(pack => pack.id)).size !== value.packs.length || new Set(value.packs.map(pack => pack.file)).size !== value.packs.length || value.packs.reduce((sum, pack) => sum + pack.count, 0) !== value.index.count) ctx.addIssue({ code: 'custom', message: 'Invalid audio pack counts' });
  if (![value.index.file, value.voice.provenance, ...value.packs.map(pack => pack.file)].every(file => file.startsWith(`${value.version}/`))) ctx.addIssue({ code: 'custom', message: 'Audio assets must be versioned' });
});
const entrySchema = z.object({ pack: z.string().regex(/^pack-\d{4}$/), offset: z.number().int().nonnegative(), length: z.number().int().positive().max(512 * 1024), sha256: hash, duration: z.number().positive().max(20) }).strict();
const indexSchema = z.object({ schema: z.literal(1), version: z.string(), entries: z.record(z.string().min(1).max(300), entrySchema) }).strict();
export type AudioManifest = z.infer<typeof audioManifestSchema>;
export type AudioIndex = z.infer<typeof indexSchema>;
interface AudioCatalog { manifest: AudioManifest; index: AudioIndex }
export interface AudioDownloadProgress { completed: number; total: number; bytes: number; totalBytes: number }
export interface AudioOptions {
  baseUrl: string;
  dictionaryVersion: string;
  signal?: AbortSignal;
  onProgress?: (progress: AudioDownloadProgress) => void;
  fetcher?: typeof fetch;
  cacheStorage?: Pick<CacheStorage, 'open'>;
  isOnline?: () => boolean;
}
export interface AudioClip { blob: Blob; duration: number; label: string }

function active(signal?: AbortSignal): void { if (signal?.aborted) throw new DOMException('发音下载已取消。', 'AbortError'); }
function json(bytes: Uint8Array): unknown { return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)) as unknown; }
function base(options: AudioOptions): URL {
  const url = new URL(options.baseUrl);
  if (!['http:', 'https:'].includes(url.protocol) || !url.pathname.endsWith('/') || url.username || url.password) throw new Error('发音地址无效。');
  return url;
}
async function cacheFor(options: AudioOptions): Promise<Cache> {
  const storage = options.cacheStorage ?? globalThis.caches;
  if (!storage) throw new Error('此浏览器不支持本机发音缓存，请使用 HTTPS 浏览器。');
  return storage.open(CACHE);
}
async function limited(response: Response, maximum: number): Promise<Uint8Array> {
  if (!response.ok || !response.body) throw new Error(`发音文件暂时无法下载（${response.status}），请重试。`);
  const reader = response.body.getReader(); const parts: Uint8Array[] = []; let size = 0;
  try {
    for (;;) {
      const part = await reader.read(); if (part.done) break;
      size += part.value.byteLength;
      if (size > maximum) { await reader.cancel(); throw new Error('发音文件大小异常，已停止下载。'); }
      parts.push(part.value);
    }
  } finally { reader.releaseLock(); }
  const bytes = new Uint8Array(size); let offset = 0;
  for (const part of parts) { bytes.set(part, offset); offset += part.byteLength; }
  return bytes;
}
async function request(url: URL, options: AudioOptions): Promise<Response> {
  active(options.signal);
  return (options.fetcher ?? fetch)(url, { signal: options.signal, cache: 'no-store', credentials: 'same-origin' });
}
function assetUrl(file: string, digest: string, options: AudioOptions): URL {
  const url = new URL(file, base(options)); url.searchParams.set('sha256', digest); return url;
}
async function verified(descriptor: z.infer<typeof asset>, options: AudioOptions, cache: Cache): Promise<Uint8Array> {
  const asset = descriptor;
  const url = assetUrl(asset.file, asset.sha256, options);
  const cached = await cache.match(url.href);
  if (cached) {
    const bytes = await limited(cached, asset.bytes);
    active(options.signal);
    if (bytes.byteLength === asset.bytes && await sha256(bytes) === asset.sha256) return bytes;
    // Audio is reproducible derived data. A damaged pack may be fetched again;
    // learning progress is never touched by this cache repair.
  }
  const bytes = await limited(await request(url, options), asset.bytes);
  active(options.signal);
  if (bytes.byteLength !== asset.bytes || await sha256(bytes) !== asset.sha256) throw new Error('发音校验失败，请重试下载。');
  try {
    await cache.put(url.href, new Response(new Uint8Array(bytes), { headers: { 'Content-Type': 'application/octet-stream', 'Content-Length': String(bytes.byteLength), 'X-Word-Audio-SHA256': asset.sha256 } }));
  } catch { throw new Error('无法保存本机发音缓存；请检查浏览器存储空间后重试。'); }
  active(options.signal);
  return bytes;
}

export function parseAudioIndex(input: unknown, manifest: AudioManifest): AudioIndex {
  const index = indexSchema.parse(input);
  if (index.version !== manifest.version || Object.keys(index.entries).length !== manifest.index.count) throw new Error('发音索引版本或数量不一致。');
  const grouped = new Map<string, z.infer<typeof entrySchema>[]>();
  for (const entry of Object.values(index.entries)) {
    const group = grouped.get(entry.pack) ?? []; group.push(entry); grouped.set(entry.pack, group);
  }
  if (grouped.size !== manifest.packs.length) throw new Error('发音分包数量不一致。');
  for (const pack of manifest.packs) {
    const entries = grouped.get(pack.id)?.sort((a, b) => a.offset - b.offset) ?? [];
    let offset = 0;
    for (const entry of entries) { if (entry.offset !== offset) throw new Error('发音索引存在重叠或缺口。'); offset += entry.length; }
    if (entries.length !== pack.count || offset !== pack.bytes) throw new Error('发音索引范围异常。');
  }
  return index;
}

async function catalog(options: AudioOptions): Promise<AudioCatalog> {
  if (!options.dictionaryVersion || options.dictionaryVersion.length > 200) throw new Error('请先加载学习词库，再播放发音。');
  active(options.signal);
  const cache = await cacheFor(options);
  const key = new URL(`catalog-${encodeURIComponent(options.dictionaryVersion)}.json`, base(options));
  let cachedManifest: AudioManifest | undefined;
  const cached = await cache.match(key.href);
  if (cached) {
    try { cachedManifest = audioManifestSchema.parse(json(await limited(cached, 512 * 1024))); }
    catch { /* Fetch a fresh public manifest without changing any study state. */ }
  }
  const validate = async (manifest: AudioManifest): Promise<AudioCatalog> => {
    if (manifest.dictionaryVersion !== options.dictionaryVersion) throw new Error('本站发音包与当前词库版本不匹配，请更新页面后重试。');
    const index = parseAudioIndex(json(await verified(manifest.index, options, cache)), manifest);
    active(options.signal);
    return { manifest, index };
  };
  const online = options.isOnline?.() ?? (typeof navigator === 'undefined' || navigator.onLine !== false);
  if (online || !cachedManifest) {
    try {
      const fresh = await limited(await request(new URL('manifest.json', base(options)), options), 512 * 1024);
      const result = await validate(audioManifestSchema.parse(json(fresh)));
      await cache.put(key.href, new Response(new Uint8Array(fresh), { headers: { 'Content-Type': 'application/json' } }));
      return result;
    } catch (error) {
      active(options.signal);
      if (!cachedManifest) throw error;
      // An unavailable update must not remove a previously verified offline voice.
    }
  }
  return validate(cachedManifest!);
}

/** Lazy: constructing a store performs no requests. A play/download action loads it. */
export class HostedAudioStore {
  private loaded: AudioCatalog | null = null;
  constructor(private readonly defaults: Omit<AudioOptions, 'dictionaryVersion' | 'signal' | 'onProgress'>) {}
  async getClip(wordId: string, dictionaryVersion: string, signal: AbortSignal): Promise<AudioClip> {
    const options = { ...this.defaults, dictionaryVersion, signal };
    if (!this.loaded || this.loaded.manifest.dictionaryVersion !== dictionaryVersion) this.loaded = await catalog(options);
    active(signal);
    const { manifest, index } = this.loaded;
    const entry = Object.hasOwn(index.entries, wordId) ? index.entries[wordId] : undefined;
    if (!entry) throw new Error('这个词暂不在本站发音学习包中，可选择设备英语声音。');
    const pack = manifest.packs.find(candidate => candidate.id === entry.pack);
    if (!pack) throw new Error('发音分包不存在。');
    const bytes = await verified(pack, options, await cacheFor(options));
    const clip = bytes.slice(entry.offset, entry.offset + entry.length);
    if (await sha256(clip) !== entry.sha256) throw new Error('单词发音校验失败，请重试。');
    active(signal);
    return { blob: new Blob([clip], { type: 'audio/mpeg' }), duration: entry.duration, label: manifest.voice.label };
  }
}

async function progress(manifest: AudioManifest, options: AudioOptions, cache: Cache): Promise<AudioDownloadProgress> {
  let completed = 0; let bytes = 0;
  for (const pack of manifest.packs) {
    active(options.signal);
    const cached = await cache.match(assetUrl(pack.file, pack.sha256, options).href);
    if (cached?.headers.get('X-Word-Audio-SHA256') === pack.sha256 && cached.headers.get('Content-Length') === String(pack.bytes)) { completed += 1; bytes += pack.bytes; }
  }
  return { completed, total: manifest.packs.length, bytes, totalBytes: manifest.packs.reduce((sum, pack) => sum + pack.bytes, 0) };
}
export async function getAudioProgress(options: AudioOptions): Promise<AudioDownloadProgress> {
  const { manifest } = await catalog(options);
  return progress(manifest, options, await cacheFor(options));
}
export async function downloadAllAudio(options: AudioOptions): Promise<AudioDownloadProgress> {
  const { manifest } = await catalog(options); const cache = await cacheFor(options);
  let current = await progress(manifest, options, cache); options.onProgress?.(current);
  for (const pack of manifest.packs) {
    active(options.signal);
    await verified(pack, options, cache);
    current = await progress(manifest, options, cache); options.onProgress?.(current);
  }
  return current;
}
