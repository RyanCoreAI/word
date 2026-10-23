import { AsrAssetStore, type AsrManifest } from './retell-asr-assets';

export interface AsrState {
  status: 'idle' | 'downloading' | 'ready' | 'loading' | 'recording' | 'paused' | 'transcribing' | 'error';
  modelReady: boolean; downloadedBytes: number; totalBytes: number; durationMs: number; error: string | null; transcript: string;
  result: RetellAsrResult | null;
}
export interface RetellAsrResult { transcript: string; audioBlob: Blob; durationMs: number }
export interface RetellAsrOptions { baseUrl?: string }
export class RetellAsrController {
  private state: AsrState = { status: 'idle', modelReady: false, downloadedBytes: 0, totalBytes: 0, durationMs: 0, error: null, transcript: '', result: null };
  private listeners = new Set<() => void>();
  private readonly store: AsrAssetStore;
  private readonly baseUrl: string;
  private manifest: AsrManifest | null = null;
  private worker: Worker | null = null;
  private workerUrl: string | null = null;
  private workerReady: Promise<void> | null = null;
  private workerEpoch = 0;
  private requestId = 0;
  private pending = new Map<number, { resolve: (value: { transcript?: string }) => void; reject: (error: Error) => void }>();
  private recorder: MediaRecorder | null = null;
  private stream: MediaStream | null = null;
  private chunks: Blob[] = [];
  private startedAt = 0;
  private activeDuration = 0;
  private timer: ReturnType<typeof setInterval> | null = null;
  private lastRecording: { audioBlob: Blob; durationMs: number } | null = null;
  private downloadAbort: AbortController | null = null;
  private disposed = false;
  private operation = 0;
  private captureReject: ((error: Error) => void) | null = null;
  private transcriptionTask: Promise<RetellAsrResult> | null = null;
  constructor(options: RetellAsrOptions = {}) {
    this.baseUrl = options.baseUrl ?? new URL('./asr/', document.baseURI).href;
    this.store = new AsrAssetStore({ baseUrl: this.baseUrl });
    void this.restore(); // Local CacheStorage reads only, never a model request.
  }
  getState = (): AsrState => this.state;
  subscribe = (listener: () => void): (() => void) => { this.listeners.add(listener); return () => { this.listeners.delete(listener); }; };
  getLastRecording(): { audioBlob: Blob; durationMs: number } | null { return this.lastRecording; }
  private update(value: Partial<AsrState>): void { if (this.disposed) return; this.state = { ...this.state, ...value }; for (const listener of this.listeners) listener(); }
  private fail(error: unknown): Error { const failure = error instanceof Error ? error : new Error('本机语音识别失败。'); this.update({ status: 'error', error: failure.message }); return failure; }
  private async restore(): Promise<void> {
    const token = this.operation;
    try {
      const manifest = await this.store.cachedManifest();
      if (manifest && await this.store.isReady(manifest) && !this.disposed && token === this.operation) { this.manifest = manifest; this.update({ status: 'ready', modelReady: true, downloadedBytes: manifest.totalBytes, totalBytes: manifest.totalBytes }); }
    } catch { /* Cache access may be denied; an explicit prepare can report it. */ }
  }
  async prepare(signal?: AbortSignal): Promise<void> {
    if (this.disposed) throw new Error('识别页面已关闭。');
    if (['recording', 'paused', 'transcribing', 'loading', 'downloading'].includes(this.state.status)) throw new Error('请先结束当前识别操作。');
    const token = ++this.operation;
    this.downloadAbort?.abort(); const controller = new AbortController(); this.downloadAbort = controller;
    const abort = () => controller.abort(); signal?.addEventListener('abort', abort, { once: true });
    if (signal?.aborted) abort();
    this.update({ status: 'downloading', error: null });
    try {
      const manifest = await this.store.download(controller.signal, progress => { if (token === this.operation) this.update(progress); });
      if (this.disposed || token !== this.operation) throw new DOMException('识别准备已取消。', 'AbortError');
      if (this.manifest && this.manifest.version !== manifest.version) this.stopWorker();
      this.manifest = manifest;
      this.update({ modelReady: true, status: 'loading' }); await this.ensureWorker(); this.assertCurrent(token); this.update({ status: 'ready' });
    } catch (error) { if (token === this.operation) throw this.fail(error); throw error; } finally { signal?.removeEventListener('abort', abort); }
  }
  private assertCurrent(token: number): void { if (this.disposed || token !== this.operation) throw new DOMException('识别操作已取消，已完成的录音仍保留。', 'AbortError'); }
  private async call(type: 'init' | 'transcribe', payload: Record<string, unknown> = {}, transfer: Transferable[] = []): Promise<{ transcript?: string }> {
    const id = ++this.requestId;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      try { if (!this.worker) throw new Error('识别工作线程已关闭。'); this.worker.postMessage({ id, type, ...payload }, transfer); }
      catch (error) { this.pending.delete(id); reject(error); }
    });
  }
  private async ensureWorker(): Promise<void> {
    if (this.workerReady) return this.workerReady;
    if (!this.manifest) throw new Error('请先点击启用离线识别。');
    const manifest = this.manifest;
    const epoch = this.workerEpoch;
    this.workerReady = (async () => {
      const blob = await (await this.store.read(manifest, 'runtime/retell-worker.mjs')).blob();
      if (this.disposed || epoch !== this.workerEpoch) throw new DOMException('识别工作线程已取消。', 'AbortError');
      this.workerUrl = URL.createObjectURL(blob); this.worker = new Worker(this.workerUrl, { type: 'module', name: 'word-local-retell-asr' });
      this.worker.onmessage = (event: MessageEvent<{ id: number; ok: boolean; transcript?: string; error?: string }>) => {
        const pending = this.pending.get(event.data.id); if (!pending) return; this.pending.delete(event.data.id);
        if (event.data.ok) pending.resolve(event.data); else pending.reject(new Error(event.data.error ?? '本机识别失败。'));
      };
      this.worker.onerror = () => { for (const pending of this.pending.values()) pending.reject(new Error('本机识别工作线程启动失败，录音已保留。')); this.pending.clear(); this.stopWorker(); };
      await this.call('init', { baseUrl: this.baseUrl, manifest });
    })().catch(error => { if (epoch === this.workerEpoch) this.stopWorker(); throw error; });
    return this.workerReady;
  }
  async start(): Promise<void> {
    if (this.disposed || !this.state.modelReady) throw this.fail(new Error('请先点击启用离线识别，下载并校验本机识别包。'));
    if (['recording', 'paused', 'transcribing', 'loading', 'downloading'].includes(this.state.status)) throw new Error('当前录音操作尚未结束。');
    if (!navigator.mediaDevices?.getUserMedia || typeof MediaRecorder === 'undefined') throw this.fail(new Error('当前浏览器不支持麦克风录音，请使用 HTTPS 下的新版 Chrome 或 Safari。'));
    const token = ++this.operation; this.update({ status: 'loading', error: null, transcript: '', result: null });
    try {
      await this.ensureWorker();
      this.assertCurrent(token);
      const stream = await navigator.mediaDevices.getUserMedia({ audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true }, video: false });
      if (this.disposed || token !== this.operation) { stream.getTracks().forEach(track => track.stop()); throw new DOMException('录音已取消。', 'AbortError'); }
      this.stream = stream;
      const mimeType = ['audio/webm;codecs=opus', 'audio/mp4', 'audio/webm'].find(type => MediaRecorder.isTypeSupported(type));
      const recorder = mimeType ? new MediaRecorder(stream, { mimeType }) : new MediaRecorder(stream);
      this.recorder = recorder; this.chunks = []; this.activeDuration = 0; this.startedAt = performance.now(); this.lastRecording = null;
      const chunks = this.chunks;
      recorder.ondataavailable = event => { if (event.data.size) chunks.push(event.data); };
      recorder.onerror = () => { if (this.recorder !== recorder) return; this.activeDuration = Math.max(this.state.durationMs, this.duration()); this.stopTracks(); this.update({ status: 'error', error: '麦克风录音中断，请检查权限后重试。已录下的声音会尽量保留。' }); };
      recorder.onstop = () => {
        if (this.recorder !== recorder) return;
        this.lastRecording = { audioBlob: new Blob(chunks, { type: recorder.mimeType }), durationMs: Math.round(Math.max(this.activeDuration, this.state.durationMs)) };
        this.recorder = null; this.stopTracks(); this.update({ status: 'error', error: '麦克风录音已意外结束，已录下的声音会尽量保留，可回听或重试。' });
      };
      recorder.start(250); this.update({ status: 'recording', durationMs: 0 });
      this.timer = setInterval(() => { const durationMs = this.duration(); this.update({ durationMs }); if (durationMs >= 180_000) void this.stop().catch(() => {}); }, 250);
    } catch (error) { if (token === this.operation) { this.stopTracks(); throw this.fail(error); } throw error; }
  }
  private duration(): number { return Math.min(180_000, this.activeDuration + (this.recorder?.state === 'recording' ? performance.now() - this.startedAt : 0)); }
  pause(): void { if (this.recorder?.state !== 'recording') return; this.activeDuration = this.duration(); this.recorder.pause(); this.update({ status: 'paused', durationMs: this.activeDuration }); }
  resume(): void { if (this.recorder?.state !== 'paused') return; this.startedAt = performance.now(); this.recorder.resume(); this.update({ status: 'recording' }); }
  async stop(): Promise<RetellAsrResult> {
    const recorder = this.recorder;
    if (!recorder || recorder.state === 'inactive') throw new Error('当前没有正在录制的声音。');
    const durationMs = Math.round(this.duration());
    const chunks = this.chunks;
    const token = ++this.operation;
    this.update({ status: 'transcribing', durationMs });
    const audioBlob = await new Promise<Blob>((resolve, reject) => {
      this.captureReject = reject;
      recorder.onstop = () => { if (this.recorder !== recorder) return; this.stopTracks(); const audioBlob = new Blob(chunks, { type: recorder.mimeType }); this.lastRecording = { audioBlob, durationMs }; resolve(audioBlob); };
      recorder.onerror = () => { if (this.recorder !== recorder) return; this.stopTracks(); this.lastRecording = { audioBlob: new Blob(chunks, { type: recorder.mimeType }), durationMs }; reject(new Error('录音保存失败，已录下的声音会尽量保留。')); };
      try { recorder.stop(); } catch (error) { reject(error); }
    }).catch(error => { if (token === this.operation) throw this.fail(error); throw error; }).finally(() => { this.captureReject = null; });
    this.assertCurrent(token);
    this.lastRecording = { audioBlob, durationMs }; this.recorder = null;
    return this.retry();
  }
  async retry(): Promise<RetellAsrResult> {
    if (this.transcriptionTask) return this.transcriptionTask;
    const recording = this.lastRecording;
    if (!recording) throw new Error('没有可重试的录音。');
    if (this.disposed || ['recording', 'paused', 'loading', 'downloading'].includes(this.state.status)) throw new Error('请先结束当前录音操作。');
    const token = ++this.operation;
    this.update({ status: 'transcribing', error: null });
    const task = (async () => { try {
      if (!recording.audioBlob.size || recording.audioBlob.size > 20 * 1024 * 1024) throw new Error('录音为空或过大，原录音已保留。');
      const decode = new AudioContext({ sampleRate: 16000 });
      let buffer: AudioBuffer;
      try { buffer = await decode.decodeAudioData(await recording.audioBlob.arrayBuffer()); } finally { await decode.close(); }
      this.assertCurrent(token);
      const decodedFrames = Math.ceil(buffer.duration * 16000);
      // MediaRecorder emits its final packet after stop(); allow that packet's
      // small timing overrun, but never send more than three minutes to Whisper.
      if (decodedFrames < 1600 || decodedFrames > 16000 * 181) throw new Error('请录制0.1秒到3分钟的英语，原录音已保留。');
      const frames = Math.min(decodedFrames, 16000 * 180);
      const offline = new OfflineAudioContext(1, frames, 16000); const source = offline.createBufferSource(); source.buffer = buffer; source.connect(offline.destination); source.start();
      const audio = (await offline.startRendering()).getChannelData(0);
      this.assertCurrent(token);
      const transcript = (await this.transcribe(audio)).trim();
      this.assertCurrent(token);
      if (!transcript) throw new Error('没有识别到英语内容，原录音已保留，可回听或重试。');
      const result = { ...recording, transcript };
      this.update({ status: 'ready', transcript, result }); return result;
    } catch (error) { if (token === this.operation) throw this.fail(error); throw error; } })();
    this.transcriptionTask = task;
    try { return await task; } finally { if (this.transcriptionTask === task) this.transcriptionTask = null; }
  }
  async transcribe(audio: Float32Array): Promise<string> {
    if (this.disposed || !this.state.modelReady) throw new Error('请先启用离线识别。');
    await this.ensureWorker();
    const copy = new Float32Array(audio);
    const result = await this.call('transcribe', { audio: copy }, [copy.buffer]);
    return result.transcript ?? '';
  }
  private stopTracks(): void { if (this.timer) clearInterval(this.timer); this.timer = null; this.stream?.getTracks().forEach(track => track.stop()); this.stream = null; }
  private stopWorker(): void { this.workerEpoch += 1; this.worker?.terminate(); this.worker = null; this.workerReady = null; if (this.workerUrl) URL.revokeObjectURL(this.workerUrl); this.workerUrl = null; }
  cancel(): void {
    this.operation += 1; this.downloadAbort?.abort();
    this.captureReject?.(new DOMException('录音已取消。', 'AbortError')); this.captureReject = null;
    if (this.recorder) { this.recorder.onstop = null; this.recorder.onerror = null; this.recorder.ondataavailable = null; if (this.recorder.state !== 'inactive') { try { this.recorder.stop(); } catch { /* The device may already have stopped. */ } } }
    this.recorder = null; this.stopTracks();
    for (const pending of this.pending.values()) pending.reject(new DOMException('识别已取消，已完成的录音仍保留。', 'AbortError'));
    this.pending.clear(); this.transcriptionTask = null; this.stopWorker(); this.update({ status: this.state.modelReady ? 'ready' : 'idle', error: null });
  }
  dispose(): void { this.cancel(); this.disposed = true; this.listeners.clear(); }
}
