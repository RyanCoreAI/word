import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
const test = vi.hoisted(() => ({ download: vi.fn(), cached: vi.fn(), ready: vi.fn(), read: vi.fn(), transcript: 'actual-worker-unit-fixture', error: '', hold: false, audioLength: 0, decodedDuration: 1 }));
vi.mock('./retell-asr-assets', () => ({ AsrAssetStore: class {
  download = test.download; cachedManifest = test.cached; isReady = test.ready; read = test.read;
} }));
import { RetellAsrController } from './retell-asr';

class TestWorker {
  static workers: TestWorker[] = [];
  onmessage: ((event: MessageEvent) => void) | null = null;
  onerror: (() => void) | null = null;
  terminate = vi.fn();
  constructor() { TestWorker.workers.push(this); }
  postMessage(message: { id: number; type: string; audio?: Float32Array }): void {
    if (message.audio) test.audioLength = message.audio.length;
    if (message.type === 'transcribe' && test.hold) return;
    queueMicrotask(() => this.onmessage?.({ data: { id: message.id, ok: message.type === 'init' || !test.error, transcript: test.transcript, error: test.error } } as MessageEvent));
  }
}
class TestRecorder {
  static instances: TestRecorder[] = [];
  static isTypeSupported = () => true;
  state = 'inactive'; mimeType = 'audio/webm;codecs=opus';
  ondataavailable: ((event: { data: Blob }) => void) | null = null;
  onstop: (() => void) | null = null; onerror: (() => void) | null = null;
  constructor() { TestRecorder.instances.push(this); }
  start(): void { this.state = 'recording'; }
  pause(): void { this.state = 'paused'; }
  resume(): void { this.state = 'recording'; }
  stop(): void { this.state = 'inactive'; queueMicrotask(() => { this.ondataavailable?.({ data: new Blob(['recorded-test-packets']) }); this.onstop?.(); }); }
}
class TestAudioContext {
  close = vi.fn(async () => {});
  async decodeAudioData(): Promise<AudioBuffer> { return { duration: test.decodedDuration } as AudioBuffer; }
}
class TestOfflineContext {
  destination = {};
  constructor(_channels: number, private frames: number) {}
  createBufferSource() { return { buffer: null, connect() {}, start() {} }; }
  async startRendering(): Promise<AudioBuffer> { return { getChannelData: () => new Float32Array(this.frames) } as unknown as AudioBuffer; }
}
let controller: RetellAsrController;
let stopTrack: ReturnType<typeof vi.fn>;
let getUserMedia: ReturnType<typeof vi.fn>;
beforeEach(() => {
  vi.useFakeTimers(); TestWorker.workers = []; TestRecorder.instances = [];
  test.download.mockReset().mockResolvedValue({ totalBytes: 42 }); test.cached.mockReset().mockResolvedValue(null); test.ready.mockReset().mockResolvedValue(true); test.read.mockReset().mockImplementation(async () => new Response('unit-worker', { headers: { 'Content-Type': 'text/javascript' } }));
  test.transcript = ' actual-worker-unit-fixture '; test.error = ''; test.hold = false; test.audioLength = 0; test.decodedDuration = 1;
  stopTrack = vi.fn(); getUserMedia = vi.fn(async () => ({ getTracks: () => [{ stop: stopTrack }] }));
  vi.stubGlobal('document', { baseURI: 'https://word.example/' }); vi.stubGlobal('navigator', { mediaDevices: { getUserMedia } });
  vi.stubGlobal('Worker', TestWorker); vi.stubGlobal('MediaRecorder', TestRecorder); vi.stubGlobal('AudioContext', TestAudioContext); vi.stubGlobal('OfflineAudioContext', TestOfflineContext);
  controller = new RetellAsrController();
});
afterEach(() => { controller.dispose(); vi.useRealTimers(); vi.unstubAllGlobals(); });
const flush = async () => { for (let i = 0; i < 20; i++) await Promise.resolve(); };
describe('local retell recording lifecycle', () => {
  it('has stable snapshots and requires explicit prepare before microphone or model loading', async () => {
    const state = controller.getState(); expect(controller.getState()).toBe(state); await flush(); expect(test.download).not.toHaveBeenCalled(); expect(getUserMedia).not.toHaveBeenCalled();
    await expect(controller.start()).rejects.toThrow('启用离线识别'); expect(getUserMedia).not.toHaveBeenCalled();
    await controller.prepare(); expect(test.download).toHaveBeenCalledTimes(1); expect(controller.getState().status).toBe('ready');
  });
  it('survives denied cache restoration and can explicitly prepare afterward', async () => {
    controller.dispose(); test.cached.mockRejectedValue(new Error('cache denied')); controller = new RetellAsrController(); await flush(); expect(controller.getState().modelReady).toBe(false);
    await controller.prepare(); expect(controller.getState().modelReady).toBe(true);
  });
  it('blocks microphone requests while an already-ready package is being explicitly prepared again', async () => {
    await controller.prepare();
    let complete!: (value: { totalBytes: number }) => void;
    test.download.mockImplementationOnce(() => new Promise(resolve => { complete = resolve; }));
    const preparing = controller.prepare();
    expect(controller.getState()).toMatchObject({ status: 'downloading', modelReady: true });
    await expect(controller.start()).rejects.toThrow('尚未结束');
    expect(getUserMedia).not.toHaveBeenCalled(); expect(TestRecorder.instances).toHaveLength(0);
    complete({ totalBytes: 42 }); await preparing; expect(controller.getState().status).toBe('ready');
  });
  it('records, pauses, resumes and emits the same completed result available to auto-stop subscribers', async () => {
    await controller.prepare(); await controller.start(); await vi.advanceTimersByTimeAsync(1000); controller.pause(); const duration = controller.getState().durationMs;
    await vi.advanceTimersByTimeAsync(1000); expect(controller.getState().durationMs).toBe(duration); controller.resume(); await vi.advanceTimersByTimeAsync(500);
    const result = await controller.stop(); expect(result.transcript).toBe('actual-worker-unit-fixture'); expect(result.durationMs).toBe(1500); expect(result.audioBlob.size).toBeGreaterThan(0); expect(controller.getState().result).toBe(result); expect(stopTrack).toHaveBeenCalledTimes(1);
  });
  it('keeps the real recorded Blob after a failed transcription and retries it without another microphone request', async () => {
    await controller.prepare(); await controller.start(); await vi.advanceTimersByTimeAsync(1000); test.error = 'worker inference failed';
    await expect(controller.stop()).rejects.toThrow('inference failed'); const recording = controller.getLastRecording(); expect(recording?.audioBlob.size).toBeGreaterThan(0); expect(controller.getState().result).toBeNull();
    test.error = ''; const result = await controller.retry(); expect(result.audioBlob).toBe(recording?.audioBlob); expect(getUserMedia).toHaveBeenCalledTimes(1);
  });
  it('retains recordings when the recognizer produces empty text and never publishes a completed result', async () => {
    await controller.prepare(); await controller.start(); await vi.advanceTimersByTimeAsync(500); test.transcript = '  ';
    await expect(controller.stop()).rejects.toThrow('没有识别到'); expect(controller.getLastRecording()?.audioBlob.size).toBeGreaterThan(0); expect(controller.getState().result).toBeNull();
  });
  it('automatically finalizes three minutes with packet overrun cropped to 180 seconds', async () => {
    await controller.prepare(); await controller.start(); test.decodedDuration = 180.2;
    await vi.advanceTimersByTimeAsync(180_250); await flush();
    expect(controller.getState().status).toBe('ready'); expect(controller.getState().result?.durationMs).toBe(180_000); expect(test.audioLength).toBe(180 * 16000); expect(stopTrack).toHaveBeenCalledTimes(1);
  });
  it('cancels a pending microphone request and stops the late stream without starting a recorder', async () => {
    await controller.prepare(); let resolve!: (value: unknown) => void;
    getUserMedia.mockImplementationOnce(() => new Promise(done => { resolve = done; }));
    const started = controller.start().catch(error => error as Error); await flush(); expect(getUserMedia).toHaveBeenCalledTimes(1); controller.cancel();
    resolve({ getTracks: () => [{ stop: stopTrack }] }); expect(await started).toMatchObject({ name: 'AbortError' }); expect(stopTrack).toHaveBeenCalledTimes(1); expect(TestRecorder.instances).toHaveLength(0); expect(controller.getState().status).toBe('ready');
  });
  it('cancels in-flight ASR, keeps the recording, releases the worker, and ignores late state changes', async () => {
    await controller.prepare(); await controller.start(); await vi.advanceTimersByTimeAsync(1000); test.hold = true;
    const stopped = controller.stop().catch(error => error as Error); await flush(); expect(controller.getLastRecording()).not.toBeNull(); controller.cancel();
    expect(await stopped).toMatchObject({ name: 'AbortError' }); expect(controller.getState().status).toBe('ready'); expect(controller.getLastRecording()?.audioBlob.size).toBeGreaterThan(0); expect(TestWorker.workers[0]!.terminate).toHaveBeenCalledTimes(1);
  });
  it('settles a cancelled stop and detaches late recorder events before a subsequent recording', async () => {
    await controller.prepare(); await controller.start(); await vi.advanceTimersByTimeAsync(500);
    const stopped = controller.stop().catch(error => error as Error); const old = TestRecorder.instances[0]!; controller.cancel();
    expect(await stopped).toMatchObject({ name: 'AbortError' }); expect(old.onstop).toBeNull(); expect(old.ondataavailable).toBeNull();
    await controller.start(); expect(controller.getState().status).toBe('recording'); expect(stopTrack).toHaveBeenCalledTimes(1);
  });
  it('retains packets when the microphone stops unexpectedly and unlocks the recording UI', async () => {
    await controller.prepare(); await controller.start(); await vi.advanceTimersByTimeAsync(750);
    TestRecorder.instances[0]!.stop(); await flush(); expect(controller.getState().status).toBe('error'); expect(controller.getLastRecording()?.durationMs).toBe(750); expect(controller.getLastRecording()?.audioBlob.size).toBeGreaterThan(0); expect(stopTrack).toHaveBeenCalledTimes(1);
    expect((await controller.retry()).transcript).toBe('actual-worker-unit-fixture');
  });
});
