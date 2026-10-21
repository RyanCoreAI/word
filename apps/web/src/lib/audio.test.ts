import { describe, expect, it, vi } from 'vitest';
import { HostedAudioStore, audioManifestSchema, downloadAllAudio, getAudioProgress, parseAudioIndex, type AudioOptions } from './audio';
import { sha256 } from './dictionary';

async function fixture() {
  const baseUrl = 'https://word.example/audio/';
  const cache = new Map<string, Response>();
  const cacheStorage = { open: async () => ({
    match: async (key: string) => cache.get(key)?.clone(),
    put: async (key: string, value: Response) => { cache.set(key, value.clone()); },
  }) as Cache };
  const text = new TextEncoder();
  const clips = [text.encode('first clip'), text.encode('second clip')];
  const packs = await Promise.all(clips.map(async (clip, i) => ({ id: `pack-000${i}`, file: `v1/pack-000${i}.bin`, bytes: clip.byteLength, sha256: await sha256(clip), count: 1 })));
  const index = { schema: 1, version: 'v1', entries: Object.fromEntries(await Promise.all(['way', 'bank'].map(async (word, i) => [word, { pack: packs[i]!.id, offset: 0, length: clips[i]!.byteLength, sha256: await sha256(clips[i]!), duration: 0.5 }]))) };
  const indexBytes = text.encode(JSON.stringify(index));
  const manifest = audioManifestSchema.parse({ schema: 1, version: 'v1', dictionaryVersion: 'dict-v1', studySha256: 'a'.repeat(64), voice: { id: 'piper', accent: 'en-US', label: 'Test voice', modelSha256: 'b'.repeat(64), provenance: 'v1/provenance.json' }, index: { file: 'v1/index.json', bytes: indexBytes.length, sha256: await sha256(indexBytes), count: 2 }, packs });
  const files = new Map<string, Uint8Array>([['/audio/manifest.json', text.encode(JSON.stringify(manifest))], ['/audio/v1/index.json', indexBytes], ...packs.map((pack, i) => [`/audio/${pack.file}`, clips[i]!] as [string, Uint8Array])]);
  const fetcher = vi.fn(async (input: string | URL | Request) => {
    const url = new URL(String(input)); const file = files.get(url.pathname);
    return file ? new Response(new Uint8Array(file)) : new Response(null, { status: 404 });
  }) as unknown as typeof fetch;
  const options: AudioOptions = { baseUrl, dictionaryVersion: 'dict-v1', cacheStorage, fetcher };
  return { cache, clips, packs, index, manifest, files, fetcher, options };
}

describe('verified self-hosted audio packs', () => {
  it('does not fetch on construction, slices the exact word, and replays cached audio offline', async () => {
    const f = await fixture(); const store = new HostedAudioStore(f.options);
    expect(f.fetcher).not.toHaveBeenCalled();
    const first = await store.getClip('way', 'dict-v1', new AbortController().signal);
    expect(await first.blob.text()).toBe('first clip');
    expect(first.label).toBe('Test voice');
    const offline = vi.fn(async () => { throw new Error('offline'); }) as unknown as typeof fetch;
    const restored = new HostedAudioStore({ ...f.options, fetcher: offline, isOnline: () => false });
    expect(await (await restored.getClip('way', 'dict-v1', new AbortController().signal)).blob.text()).toBe('first clip');
    expect(offline).not.toHaveBeenCalled();
    await expect(restored.getClip('constructor', 'dict-v1', new AbortController().signal)).rejects.toThrow('不在');
  });

  it('rejects mismatched dictionaries and tampered audio before caching or playback', async () => {
    const f = await fixture();
    await expect(new HostedAudioStore(f.options).getClip('way', 'other-version', new AbortController().signal)).rejects.toThrow('版本不匹配');
    f.files.set('/audio/v1/pack-0000.bin', new TextEncoder().encode('wrong clip'));
    await expect(new HostedAudioStore(f.options).getClip('way', 'dict-v1', new AbortController().signal)).rejects.toThrow('校验失败');
    expect([...f.cache.keys()].some(key => key.includes('pack-0000'))).toBe(false);
  });

  it('rejects index gaps, overflow, duplicate pack metadata and traversal paths', async () => {
    const f = await fixture(); const broken = structuredClone(f.index);
    broken.entries.way!.offset = 2;
    expect(() => parseAudioIndex(broken, f.manifest)).toThrow('缺口');
    expect(() => audioManifestSchema.parse({ ...f.manifest, packs: [f.packs[0], f.packs[0]] })).toThrow();
    expect(() => audioManifestSchema.parse({ ...f.manifest, index: { ...f.manifest.index, file: '../index.json' } })).toThrow();
  });

  it('pauses after a committed pack and resumes without fetching it again', async () => {
    const f = await fixture(); const controller = new AbortController();
    await expect(downloadAllAudio({ ...f.options, signal: controller.signal, onProgress: progress => { if (progress.completed === 1) controller.abort(); } })).rejects.toMatchObject({ name: 'AbortError' });
    expect(await getAudioProgress(f.options)).toMatchObject({ completed: 1, total: 2 });
    vi.mocked(f.fetcher).mockClear();
    expect(await downloadAllAudio(f.options)).toMatchObject({ completed: 2, total: 2 });
    const packRequests = vi.mocked(f.fetcher).mock.calls.map(call => String(call[0])).filter(url => url.includes('.bin'));
    expect(packRequests).toHaveLength(1);
    expect(packRequests[0]).toContain('pack-0001');
  });

  it('reports quota failures while preserving completed packs', async () => {
    const f = await fixture(); const originalOpen = f.options.cacheStorage!.open;
    f.options.cacheStorage = { open: async name => {
      const cache = await originalOpen(name); const put = cache.put.bind(cache);
      cache.put = async (key, response) => {
        if (String(key).includes('pack-0001')) throw new DOMException('Full', 'QuotaExceededError');
        await put(key, response);
      };
      return cache;
    } };
    await expect(downloadAllAudio(f.options)).rejects.toThrow('存储空间');
    expect(await getAudioProgress(f.options)).toMatchObject({ completed: 1, total: 2 });
  });

  it('refreshes a changed voice for the same dictionary and keeps verified audio when update fails', async () => {
    const f = await fixture();
    await new HostedAudioStore(f.options).getClip('way', 'dict-v1', new AbortController().signal);
    const updated = { ...f.manifest, voice: { ...f.manifest.voice, label: 'Updated voice' } };
    f.files.set('/audio/manifest.json', new TextEncoder().encode(JSON.stringify(updated)));
    expect((await new HostedAudioStore(f.options).getClip('way', 'dict-v1', new AbortController().signal)).label).toBe('Updated voice');
    f.files.set('/audio/manifest.json', new TextEncoder().encode('broken update'));
    expect((await new HostedAudioStore(f.options).getClip('way', 'dict-v1', new AbortController().signal)).label).toBe('Updated voice');
  });
});
