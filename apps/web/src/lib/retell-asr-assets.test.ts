import { describe, expect, it, vi } from 'vitest';
import { ASR_CACHE, AsrAssetStore, asrBase, asrManifestSchema, type AsrManifest } from './retell-asr-assets';
import { sha256 } from './dictionary';

const baseUrl = 'https://word.example/asr/';
const required = ['model/config.json', 'model/tokenizer.json', 'model/tokenizer_config.json', 'model/preprocessor_config.json', 'model/generation_config.json', 'model/onnx/encoder_model_quantized.onnx', 'model/onnx/decoder_model_merged_quantized.onnx', 'runtime/transformers-runtime.mjs', 'runtime/retell-worker.mjs', 'runtime/ort-wasm-simd-threaded.jsep.wasm', 'runtime/ort-wasm-simd-threaded.jsep.mjs', 'licenses/whisper-Apache-2.0.txt', 'licenses/whisper-MIT.txt'];
async function fixture() {
  const version = 'whisper-tiny-en-' + 'a'.repeat(20);
  const files = new Map<string, Uint8Array>();
  const assets = await Promise.all(required.map(async (path, index) => {
    const bytes = new TextEncoder().encode(`test-only-asset-${index}`); const hash = await sha256(bytes);
    const file = `${version}/chunks/${hash}-000.bin`; files.set(new URL(file, baseUrl).href, bytes);
    return { path, bytes: bytes.length, sha256: hash, parts: [{ file, bytes: bytes.length, sha256: hash }] };
  }));
  const manifest: AsrManifest = { schemaVersion: 1, version, modelId: 'onnx-community/whisper-tiny.en', revision: '2575352d61be1bf7225cf8f8b268a4678025fc58', license: 'Apache-2.0', runtimeVersion: '4.3.1', sampleRate: 16000, assets, totalBytes: assets.reduce((sum, asset) => sum + asset.bytes, 0) };
  const publishManifest = () => files.set(baseUrl + 'manifest.json', new TextEncoder().encode(JSON.stringify(manifest)));
  publishManifest();
  const responses = new Map<string, Response>();
  const cache = { match: vi.fn(async (key: string) => responses.get(key)?.clone()), put: vi.fn(async (key: string, value: Response) => { responses.set(key, value.clone()); }) };
  const cacheStorage = { open: vi.fn(async (name: string) => { expect(name).toBe(ASR_CACHE); return cache as unknown as Cache; }) };
  const fetcher = vi.fn<typeof fetch>(async input => { const body = files.get(String(input)); return new Response(body ? new Uint8Array(body) : null, { status: body ? 200 : 404 }); });
  const store = new AsrAssetStore({ baseUrl, cacheStorage, fetcher });
  return { manifest, files, responses, cache, cacheStorage, fetcher, store, publishManifest };
}
describe('strict offline ASR package', () => {
  it('constructs without network/cache activity and downloads only after explicit call', async () => {
    const f = await fixture(); expect(f.fetcher).not.toHaveBeenCalled(); expect(f.cacheStorage.open).not.toHaveBeenCalled();
    const progress = vi.fn(); expect(await f.store.download(undefined, progress)).toEqual(f.manifest);
    expect(f.fetcher).toHaveBeenCalledTimes(required.length + 1); expect(progress).toHaveBeenLastCalledWith({ downloadedBytes: f.manifest.totalBytes, totalBytes: f.manifest.totalBytes });
    expect(await f.store.cachedManifest()).toEqual(f.manifest); expect(await f.store.isReady(f.manifest)).toBe(true);
    for (const call of f.fetcher.mock.calls) expect(String(call[0]).startsWith(baseUrl)).toBe(true);
  });
  it('restores verified complete assets offline and never fetches during read or isReady', async () => {
    const f = await fixture(); await f.store.download(); f.fetcher.mockRejectedValue(new Error('offline')); f.fetcher.mockClear();
    expect(await f.store.isReady(f.manifest)).toBe(true); expect((await f.store.read(f.manifest, required[0]!)).ok).toBe(true); expect(f.fetcher).not.toHaveBeenCalled();
  });
  it('rejects corrupt bytes and does not publish a ready catalog', async () => {
    const f = await fixture(); f.files.set(new URL(f.manifest.assets[0]!.parts[0]!.file, baseUrl).href, new Uint8Array([1]));
    await expect(f.store.download()).rejects.toThrow('校验失败'); expect(await f.store.cachedManifest()).toBeNull();
  });
  it('repairs damaged assembled and chunk caches with validated downloads', async () => {
    const f = await fixture(); await f.store.download(); const asset = f.manifest.assets[0]!;
    f.responses.set(f.store.url(f.manifest, asset.path), new Response('corrupt')); f.responses.set(new URL(asset.parts[0]!.file, baseUrl).href, new Response('bad'));
    expect(await f.store.isReady(f.manifest)).toBe(false); f.fetcher.mockClear(); await f.store.download();
    expect(f.fetcher).toHaveBeenCalledTimes(2); expect(await f.store.isReady(f.manifest)).toBe(true);
  });
  it('rejects traversal, missing required assets, bad totals, oversized chunks and foreign origins', async () => {
    const f = await fixture();
    for (const mutate of [(m: AsrManifest) => { m.assets[0]!.parts[0]!.file = '../escape'; }, (m: AsrManifest) => { m.assets[0]!.path = 'another'; }, (m: AsrManifest) => { m.totalBytes++; }, (m: AsrManifest) => { m.assets[0]!.parts[0]!.bytes = 8 * 1024 * 1024 + 1; }]) { const copy = structuredClone(f.manifest); mutate(copy); expect(asrManifestSchema.safeParse(copy).success).toBe(false); }
    expect(() => asrBase('https://word.example/asr/?x=1')).toThrow();
    vi.stubGlobal('location', { origin: 'https://word.example' }); expect(() => asrBase('https://remote.example/asr/')).toThrow(); vi.unstubAllGlobals();
  });
  it('aborts before any network request and refuses redirected responses', async () => {
    const f = await fixture(); const abort = new AbortController(); abort.abort(); await expect(f.store.download(abort.signal)).rejects.toMatchObject({ name: 'AbortError' }); expect(f.fetcher).not.toHaveBeenCalled();
    const redirected = new Response('{}'); Object.defineProperty(redirected, 'redirected', { value: true }); f.fetcher.mockResolvedValue(redirected);
    await expect(f.store.download()).rejects.toThrow('跨源跳转'); expect(await f.store.cachedManifest()).toBeNull();
  });
});
