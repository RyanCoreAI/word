import { z } from 'zod';
import { sha256 } from './dictionary';

export const ASR_CACHE = 'word-retell-asr-v1';
const hash = z.string().regex(/^[a-f0-9]{64}$/);
const path = z.string().min(1).max(300).regex(/^[A-Za-z0-9_./-]+$/).refine(value => !value.startsWith('/') && value.split('/').every(part => part && part !== '.' && part !== '..'));
const part = z.object({ file: path, bytes: z.number().int().positive().max(8 * 1024 * 1024), sha256: hash }).strict();
export const asrManifestSchema = z.object({
  schemaVersion: z.literal(1), version: z.string().regex(/^whisper-tiny-en-[a-f0-9]{20}$/),
  modelId: z.literal('onnx-community/whisper-tiny.en'), revision: z.literal('2575352d61be1bf7225cf8f8b268a4678025fc58'),
  license: z.literal('Apache-2.0'), runtimeVersion: z.literal('4.3.1'), sampleRate: z.literal(16000),
  assets: z.array(z.object({ path, bytes: z.number().int().positive().max(64 * 1024 * 1024), sha256: hash, parts: z.array(part).min(1).max(16) }).strict()).min(10).max(64),
  totalBytes: z.number().int().positive().max(160 * 1024 * 1024),
}).strict().superRefine((value, ctx) => {
  if (new Set(value.assets.map(asset => asset.path)).size !== value.assets.length || value.assets.reduce((sum, asset) => sum + asset.bytes, 0) !== value.totalBytes) ctx.addIssue({ code: 'custom', message: 'Invalid ASR asset totals' });
  for (const asset of value.assets) if (asset.parts.reduce((sum, part) => sum + part.bytes, 0) !== asset.bytes || asset.parts.some(part => !part.file.startsWith(`${value.version}/chunks/`))) ctx.addIssue({ code: 'custom', message: 'Invalid ASR chunks' });
  for (const required of ['model/config.json', 'model/tokenizer.json', 'model/tokenizer_config.json', 'model/preprocessor_config.json', 'model/generation_config.json', 'model/onnx/encoder_model_quantized.onnx', 'model/onnx/decoder_model_merged_quantized.onnx', 'runtime/transformers-runtime.mjs', 'runtime/retell-worker.mjs', 'runtime/ort-wasm-simd-threaded.jsep.wasm', 'runtime/ort-wasm-simd-threaded.jsep.mjs', 'licenses/whisper-Apache-2.0.txt', 'licenses/whisper-MIT.txt']) if (!value.assets.some(asset => asset.path === required)) ctx.addIssue({ code: 'custom', message: `Missing ASR asset ${required}` });
});
export type AsrManifest = z.infer<typeof asrManifestSchema>;
export interface AsrProgress { downloadedBytes: number; totalBytes: number }
export interface AsrAssetOptions { baseUrl: string; fetcher?: typeof fetch; cacheStorage?: Pick<CacheStorage, 'open'> }
export function active(signal?: AbortSignal): void { if (signal?.aborted) throw new DOMException('识别包下载已取消。', 'AbortError'); }
export function asrBase(input: string): URL {
  const url = new URL(input);
  if (!['http:', 'https:'].includes(url.protocol) || !url.pathname.endsWith('/') || url.username || url.password || url.search || url.hash || (typeof location !== 'undefined' && location.origin !== url.origin)) throw new Error('识别包必须从本站下载。');
  return url;
}
async function limited(response: Response, maximum: number, signal?: AbortSignal): Promise<Uint8Array> {
  active(signal);
  if (!response.ok || !response.body) throw new Error(`识别包读取失败（${response.status}）。`);
  const reader = response.body.getReader(); const chunks: Uint8Array[] = []; let length = 0;
  const abort = () => { void reader.cancel().catch(() => {}); };
  signal?.addEventListener('abort', abort, { once: true });
  try {
    for (;;) { active(signal); const item = await reader.read(); if (item.done) break; length += item.value.byteLength; if (length > maximum) { await reader.cancel(); throw new Error('识别包文件超出允许大小。'); } chunks.push(item.value); }
    active(signal);
  } finally { signal?.removeEventListener('abort', abort); reader.releaseLock(); }
  const bytes = new Uint8Array(length); let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
  return bytes;
}
async function verify(bytes: Uint8Array, asset: { bytes: number; sha256: string }, signal?: AbortSignal): Promise<Uint8Array> {
  active(signal);
  if (bytes.byteLength !== asset.bytes || await sha256(bytes) !== asset.sha256) throw new Error('识别包校验失败，请重新下载。');
  active(signal); return bytes;
}
export class AsrAssetStore {
  constructor(private readonly options: AsrAssetOptions) {}
  url(manifest: AsrManifest, assetPath: string): string { return new URL(`${manifest.version}/${assetPath}`, asrBase(this.options.baseUrl)).href; }
  private async cache(): Promise<Cache> { const storage = this.options.cacheStorage ?? globalThis.caches; if (!storage) throw new Error('当前浏览器不支持离线识别缓存。'); return storage.open(ASR_CACHE); }
  private catalogKey(): string { return new URL('catalog.json', asrBase(this.options.baseUrl)).href; }
  async cachedManifest(): Promise<AsrManifest | null> {
    try { const response = await (await this.cache()).match(this.catalogKey()); if (!response) return null; return asrManifestSchema.parse(JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(await limited(response, 256 * 1024))) as unknown); }
    catch { return null; }
  }
  async read(manifest: AsrManifest, assetPath: string): Promise<Response> {
    const asset = manifest.assets.find(asset => asset.path === assetPath);
    if (!asset) throw new Error('识别所需文件不在校验清单中。');
    const response = await (await this.cache()).match(this.url(manifest, asset.path));
    if (!response) throw new Error('离线识别包尚未下载完整，请点击启用离线识别。');
    const bytes = await verify(await limited(response, asset.bytes), asset);
    return new Response(new Uint8Array(bytes), { headers: { 'Content-Type': asset.path.endsWith('.mjs') ? 'text/javascript' : 'application/octet-stream' } });
  }
  async isReady(manifest: AsrManifest): Promise<boolean> { try { for (const asset of manifest.assets) await this.read(manifest, asset.path); return true; } catch { return false; } }
  async download(signal?: AbortSignal, progress?: (value: AsrProgress) => void): Promise<AsrManifest> {
    active(signal); const base = asrBase(this.options.baseUrl); const cache = await this.cache();
    const transfer = new AbortController();
    const abort = () => transfer.abort();
    signal?.addEventListener('abort', abort, { once: true });
    if (signal?.aborted) abort();
    const downloadSignal = transfer.signal;
    const fetcher = this.options.fetcher ?? fetch;
    const request = async (file: string, maximum: number) => {
      active(downloadSignal); const url = new URL(file, base);
      if (url.origin !== base.origin || !url.pathname.startsWith(base.pathname)) throw new Error('识别包路径无效。');
      const response = await fetcher(url, { signal: downloadSignal, credentials: 'same-origin', cache: 'no-store', redirect: 'error' });
      if (response.redirected || (response.url && new URL(response.url).origin !== base.origin)) throw new Error('识别包禁止跨源跳转。');
      return limited(response, maximum, downloadSignal);
    };
    try {
      const raw = await request('manifest.json', 256 * 1024);
      const manifest = asrManifestSchema.parse(JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(raw)) as unknown);
      active(downloadSignal); let downloadedBytes = 0; progress?.({ downloadedBytes, totalBytes: manifest.totalBytes });
      // Identical notice files can share chunks. Queue descriptors, never full
      // model buffers, and count their logical bytes once per referencing asset.
      const parts = new Map<string, AsrManifest['assets'][number]['parts'][number] & { logicalBytes: number }>();
      for (const asset of manifest.assets) for (const part of asset.parts) {
        const previous = parts.get(part.file);
        if (previous && (previous.bytes !== part.bytes || previous.sha256 !== part.sha256)) throw new Error('识别包分片描述冲突。');
        if (previous) previous.logicalBytes += part.bytes;
        else parts.set(part.file, { ...part, logicalBytes: part.bytes });
      }
      const queue = [...parts.values()]; let cursor = 0; let failed = false; let failure: unknown;
      const downloadParts = async () => {
        try {
          for (;;) {
            active(downloadSignal); const part = queue[cursor++]; if (!part) return;
            const key = new URL(part.file, base).href; let bytes: Uint8Array | null = null;
            try { const cached = await cache.match(key); if (cached) bytes = await verify(await limited(cached, part.bytes, downloadSignal), part, downloadSignal); } catch { active(downloadSignal); }
            if (!bytes) {
              bytes = await verify(await request(part.file, part.bytes), part, downloadSignal);
              active(downloadSignal); await cache.put(key, new Response(new Uint8Array(bytes)));
            }
            active(downloadSignal); downloadedBytes += part.logicalBytes;
            progress?.({ downloadedBytes, totalBytes: manifest.totalBytes });
          }
        } catch (error) {
          // Abort peers immediately, but await their settlement before returning
          // so none can publish a late progress callback or start another request.
          if (!failed) { failed = true; failure = error; transfer.abort(); }
        }
      };
      await Promise.all(Array.from({ length: Math.min(3, queue.length) }, downloadParts));
      if (failed) throw failure;
      // All parts are now validated in CacheStorage. Assemble only one asset at a
      // time; retaining all 73 MB alongside three network buffers is unnecessary.
      for (const asset of manifest.assets) {
        active(downloadSignal); const all = new Uint8Array(asset.bytes); let offset = 0;
        for (const part of asset.parts) {
          active(downloadSignal); const cached = await cache.match(new URL(part.file, base).href);
          if (!cached) throw new Error('识别包分片缓存缺失，请重新启用。');
          const bytes = await verify(await limited(cached, part.bytes, downloadSignal), part, downloadSignal);
          all.set(bytes, offset); offset += bytes.byteLength;
        }
        await verify(all, asset, downloadSignal); active(downloadSignal);
        await cache.put(this.url(manifest, asset.path), new Response(all, { headers: { 'Content-Type': asset.path.endsWith('.mjs') ? 'text/javascript' : 'application/octet-stream' } }));
      }
      active(downloadSignal); await cache.put(this.catalogKey(), new Response(new Uint8Array(raw), { headers: { 'Content-Type': 'application/json' } })); active(downloadSignal); return manifest;
    } finally { transfer.abort(); signal?.removeEventListener('abort', abort); }
  }
}
