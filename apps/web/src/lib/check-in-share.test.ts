import { describe, expect, it, vi } from 'vitest';
import { CHECK_IN_SCENES, CHECK_IN_URL, CheckInImageRequest, checkInScenePath, checkInSharePayload, checkInSummary, copyCheckInLink, createCheckInQr, defaultCheckInScene, shareCheckInImage, type CheckInImageOptions, type CheckInShareData } from './check-in-share';

const data: CheckInShareData = { dateKey: '2026-10-23', deckName: '雅思词汇', modeLabel: '看词', newCount: 40, reviewCount: 12 };
const file = () => new File([new Uint8Array([137, 80, 78, 71])], 'word-check-in-2026-10-23.png', { type: 'image/png' });

describe('check-in image data and private public-link contract', () => {
  it('uses distinct supplied word counts and a calendar date without converting timezones', () => {
    expect(checkInSummary(data)).toMatchObject({ total: 52, displayDate: '2026.10.23', fileName: 'word-check-in-2026-10-23.png' });
    expect(checkInSummary({ ...data, dateKey: '2024-02-29', newCount: 0, reviewCount: 0 })).toMatchObject({ total: 0, displayDate: '2024.02.29' });
    expect(data.newCount).toBe(40);
  });

  it.each(['2026-02-29', '2026-10-23T23:00:00Z', '2026-13-01', '../2026-10-23'])('rejects an invalid or non-calendar date %s', dateKey => {
    expect(() => checkInSummary({ ...data, dateKey })).toThrow('日期');
  });

  it('rejects count overflows, negative/fractional values and unusable labels', () => {
    for (const count of [-1, 0.5, NaN, Infinity, Number.MAX_SAFE_INTEGER]) expect(() => checkInSummary({ ...data, newCount: count })).toThrow('词数');
    expect(() => checkInSummary({ ...data, newCount: 600_000, reviewCount: 600_000 })).toThrow('词数');
    for (const deckName of ['', '  ', '书\n名', '书'.repeat(101)]) expect(() => checkInSummary({ ...data, deckName })).toThrow('名称');
    expect(checkInSummary({ ...data, deckName: ' 雅思词汇 ' }).deckName).toBe('雅思词汇');
  });

  it('encodes the fixed HTTPS home address as QR data and creates a real symbol matrix', () => {
    const qr = createCheckInQr();
    const content = qr.segments.map(segment => typeof segment.data === 'string' ? segment.data : new TextDecoder().decode(segment.data)).join('');
    expect(content).toBe('https://word.yanxai.com/');
    expect(qr.modules.data).toHaveLength(qr.modules.size ** 2);
    expect(qr.modules.size).toBe(17 + 4 * qr.version);
    // Standard top-left finder: dark perimeter, clear ring, dark 3x3 centre.
    expect(qr.modules.get(0, 0)).toBe(1); expect(qr.modules.get(1, 1)).toBe(0); expect(qr.modules.get(3, 3)).toBe(1);
    expect(new URL(content).search).toBe(''); expect(new URL(content).hash).toBe('');
  });

  it('exports only the PNG and fixed public link, without serializing personal progress into a URL', () => {
    const image = file(); const payload = checkInSharePayload(image);
    expect(payload.files).toEqual([image]); expect(payload.text).toBe(CHECK_IN_URL);
    expect(payload.url).toBeUndefined(); expect(JSON.stringify(payload)).not.toContain('52');
    expect(() => checkInSharePayload(new File([], 'empty.png', { type: 'image/png' }))).toThrow();
    expect(() => checkInSharePayload(new File(['html'], 'unsafe.html', { type: 'text/html' }))).toThrow();
    expect(() => checkInSharePayload(new File([new Uint8Array(10 * 1024 * 1024 + 1)], 'large.png', { type: 'image/png' }))).toThrow();
  });

  it('restricts all 20 scenes to fixed local paths, rejecting arbitrary URLs and out-of-range indexes', () => {
    expect(CHECK_IN_SCENES).toHaveLength(20);
    const paths = CHECK_IN_SCENES.map((_, index) => checkInScenePath(index));
    expect(new Set(paths).size).toBe(20);
    expect(paths[0]).toBe('images/check-in/01.png'); expect(paths[19]).toBe('images/check-in/20.png');
    for (const index of [-1, 20, 1.5, NaN, Infinity, 'https://example.com/photo.png' as unknown as number]) expect(() => checkInScenePath(index)).toThrow('风景');
  });

  it('chooses the daily scene deterministically from date, deck and mode, independent of later counts', () => {
    const scene = defaultCheckInScene(data);
    expect(defaultCheckInScene({ ...data })).toBe(scene);
    expect(defaultCheckInScene({ ...data, newCount: 300 } as CheckInShareData)).toBe(scene);
    const samples = new Set(Array.from({ length: 28 }, (_, index) => defaultCheckInScene({ ...data, dateKey: `2026-02-${String(index + 1).padStart(2, '0')}` })));
    expect(scene).toBeGreaterThanOrEqual(0); expect(scene).toBeLessThan(20); expect(samples.size).toBeGreaterThan(5);
  });
});

describe('landscape generation cancellation', () => {
  function pendingRenderer() {
    const requests: { options: CheckInImageOptions; resolve: (file: File) => void; reject: (reason: Error) => void }[] = [];
    const render = vi.fn((_data: CheckInShareData, options: CheckInImageOptions = {}) => new Promise<File>((resolve, reject) => { requests.push({ options, resolve, reject }); }));
    return { requests, render, generator: new CheckInImageRequest(render) };
  }

  it('publishes only the last selected scene, even if an aborted older renderer resolves later', async () => {
    const { requests, generator, render } = pendingRenderer();
    expect(render).not.toHaveBeenCalled();
    const first = generator.generate(data, 0); const second = generator.generate(data, 1);
    expect(requests[0]!.options.signal?.aborted).toBe(true);
    expect(requests[1]!.options.scene).toBe(1);
    const current = file(); requests[1]!.resolve(current); expect(await second).toBe(current);
    requests[0]!.resolve(file()); expect(await first).toBeNull();
    generator.cancel();
  });

  it('suppresses late results/errors on close and allows a new request after effect cleanup', async () => {
    const { requests, generator } = pendingRenderer();
    const first = generator.generate(data, 3); generator.cancel();
    requests[0]!.reject(new Error('late network failure')); expect(await first).toBeNull();
    const second = generator.generate(data, 4); generator.cancel();
    requests[1]!.resolve(file()); expect(await second).toBeNull();
    const third = generator.generate(data, 5); const current = file(); requests[2]!.resolve(current); expect(await third).toBe(current);
    generator.cancel();
  });

  it('reports the current image failure rather than silently publishing an incorrect scene', async () => {
    const { requests, generator, render } = pendingRenderer();
    const result = generator.generate(data, 2);
    const failed = expect(result).rejects.toThrow('offline');
    requests[0]!.reject(new Error('offline')); await failed;
    await expect(generator.generate(data, 99)).rejects.toThrow('风景');
    expect(render).toHaveBeenCalledTimes(1);
    generator.cancel();
  });
});

describe('user-initiated native sharing and clipboard fallback', () => {
  it('calls share in the original synchronous click turn with an already prepared File', async () => {
    let finish!: () => void;
    const image = file(); const share = vi.fn(() => new Promise<void>(resolve => { finish = resolve; }));
    const canShare = vi.fn(() => true);
    const result = shareCheckInImage(image, { canShare, share });
    // No await or image generation occurs before the browser receives the activation.
    expect(share).toHaveBeenCalledTimes(1); expect(canShare).toHaveBeenCalledWith({ files: [image] });
    expect(share).toHaveBeenCalledWith(checkInSharePayload(image));
    finish(); expect(await result).toBe('shared');
  });

  it('never opens share when file sharing is missing or unsupported', async () => {
    const share = vi.fn(async () => {});
    expect(await shareCheckInImage(file(), {})).toBe('unsupported');
    expect(await shareCheckInImage(file(), { share })).toBe('unsupported');
    expect(await shareCheckInImage(file(), { share, canShare: () => false })).toBe('unsupported');
    expect(share).not.toHaveBeenCalled();
  });

  it('preserves cancellation instead of reporting completion or an application delivery', async () => {
    const share = vi.fn(async () => { throw new DOMException('cancelled', 'AbortError'); });
    expect(await shareCheckInImage(file(), { canShare: () => true, share })).toBe('cancelled');
  });

  it('handles permission, synchronous API and payload failures without an unhandled rejection', async () => {
    const denied = vi.fn(async () => { throw new DOMException('No activation', 'NotAllowedError'); });
    expect(await shareCheckInImage(file(), { canShare: () => true, share: denied })).toBe('failed');
    expect(await shareCheckInImage(file(), { canShare: () => { throw new Error('blocked'); }, share: denied })).toBe('failed');
    expect(await shareCheckInImage(new File([], 'empty'), { canShare: () => true, share: denied })).toBe('failed');
    expect(denied).toHaveBeenCalledTimes(1);
  });

  it('copies only the public home URL and truthfully returns false for fallback selection', async () => {
    const writeText = vi.fn(async () => {});
    expect(await copyCheckInLink({ writeText })).toBe(true);
    expect(writeText).toHaveBeenCalledWith('https://word.yanxai.com/');
    expect(await copyCheckInLink(null)).toBe(false);
    expect(await copyCheckInLink({ writeText: async () => { throw new Error('clipboard denied'); } })).toBe(false);
  });
});
