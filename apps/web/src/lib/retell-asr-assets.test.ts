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
  it('downloads at most three parts concurrently and assembles assets only after every part is cached', async () => {
    const f = await fixture(); const original = f.fetcher.getMockImplementation()!;
    const pending: (() => void)[] = []; let inFlight = 0; let maximum = 0; let completed = 0;
    f.fetcher.mockImplementation(async (input, init) => {
      if (String(input).endsWith('/manifest.json')) return original(input, init);
      inFlight++; maximum = Math.max(maximum, inFlight);
      await new Promise<void>(resolve => pending.push(() => { inFlight--; completed++; resolve(); }));
      return original(input, init);
    });
    const saved = f.cache.put.getMockImplementation()!;
    f.cache.put.mockImplementation(async (key, response) => {
      if (!key.includes('/chunks/') && !key.endsWith('/catalog.json')) expect(completed).toBe(required.length);
      await saved(key, response);
    });
    const progress = vi.fn(); const downloading = f.store.download(undefined, progress);
    await vi.waitFor(() => expect(pending).toHaveLength(3)); expect(inFlight).toBe(3);
    while (completed < required.length) {
      await vi.waitFor(() => expect(pending.length).toBeGreaterThan(0)); pending.splice(0).forEach(release => release());
    }
    await downloading; expect(maximum).toBe(3); expect(await f.store.isReady(f.manifest)).toBe(true);
    const values = progress.mock.calls.map(([value]) => value.downloadedBytes);
    expect(values).toEqual([...values].sort((a, b) => a - b)); expect(values.at(-1)).toBe(f.manifest.totalBytes);
  });
  it('aborts all in-flight requests on cancellation, stops the queue and emits no late progress', async () => {
    const f = await fixture(); const original = f.fetcher.getMockImplementation()!;
    const requests: { signal: AbortSignal; complete: () => void }[] = [];
    f.fetcher.mockImplementation(async (input, init) => {
      if (String(input).endsWith('/manifest.json')) return original(input, init);
      const signal = init!.signal!;
      await new Promise<void>((resolve, reject) => { requests.push({ signal, complete: resolve }); signal.addEventListener('abort', () => reject(new DOMException('cancelled', 'AbortError')), { once: true }); });
      return original(input, init);
    });
    const abort = new AbortController(); const progress = vi.fn();
    const downloading = f.store.download(abort.signal, progress); const failed = expect(downloading).rejects.toMatchObject({ name: 'AbortError' });
    await vi.waitFor(() => expect(requests).toHaveLength(3)); abort.abort(); await failed;
    expect(requests.every(request => request.signal.aborted)).toBe(true); const updates = progress.mock.calls.length;
    requests.forEach(request => request.complete()); await Promise.resolve();
    expect(progress).toHaveBeenCalledTimes(updates); expect(f.fetcher).toHaveBeenCalledTimes(4); expect(f.cache.put).not.toHaveBeenCalled(); expect(await f.store.cachedManifest()).toBeNull();
  });
  it('aborts peers when one part fails and resumes only verified cached parts after a retry', async () => {
    const f = await fixture(); const original = f.fetcher.getMockImplementation()!;
    const requests: { input: RequestInfo | URL; signal: AbortSignal; complete: () => void; fail: (error: Error) => void }[] = [];
    f.fetcher.mockImplementation(async (input, init) => {
      if (String(input).endsWith('/manifest.json')) return original(input, init);
      const signal = init!.signal!;
      await new Promise<void>((resolve, reject) => { requests.push({ input, signal, complete: resolve, fail: reject }); signal.addEventListener('abort', () => reject(new DOMException('peer aborted', 'AbortError')), { once: true }); });
      return original(input, init);
    });
    const progress = vi.fn(); const downloading = f.store.download(undefined, progress); const failed = expect(downloading).rejects.toThrow('network failed');
    await vi.waitFor(() => expect(requests).toHaveLength(3));
    requests[0]!.complete(); await vi.waitFor(() => expect(requests).toHaveLength(4));
    const cachedKey = String(requests[0]!.input); expect(f.responses.has(cachedKey)).toBe(true);
    requests[1]!.fail(new Error('network failed')); await failed; const updates = progress.mock.calls.length;
    expect(requests[2]!.signal.aborted).toBe(true); expect(requests[3]!.signal.aborted).toBe(true);
    requests.forEach(request => request.complete()); await Promise.resolve(); expect(progress).toHaveBeenCalledTimes(updates);
    expect(f.fetcher).toHaveBeenCalledTimes(5); expect(await f.store.cachedManifest()).toBeNull();
    f.fetcher.mockImplementation(original).mockClear(); await f.store.download();
    expect(f.fetcher.mock.calls.some(([input]) => String(input) === cachedKey)).toBe(false);
    expect(f.fetcher).toHaveBeenCalledTimes(required.length); expect(await f.store.isReady(f.manifest)).toBe(true);
  });
  it('downloads a shared verified part once while retaining complete logical progress', async () => {
    const f = await fixture(); const first = f.manifest.assets[0]!; const second = f.manifest.assets[1]!;
    second.bytes = first.bytes; second.sha256 = first.sha256; second.parts = structuredClone(first.parts);
    f.manifest.totalBytes = f.manifest.assets.reduce((sum, asset) => sum + asset.bytes, 0); f.publishManifest();
    const progress = vi.fn(); await f.store.download(undefined, progress);
    expect(f.fetcher).toHaveBeenCalledTimes(required.length); expect(progress).toHaveBeenLastCalledWith({ downloadedBytes: f.manifest.totalBytes, totalBytes: f.manifest.totalBytes }); expect(await f.store.isReady(f.manifest)).toBe(true);
  });
});
