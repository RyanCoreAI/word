export type Accent = 'en-US' | 'en-GB';
export interface SpeechState {
  status: 'idle' | 'starting' | 'speaking' | 'ended' | 'unavailable' | 'error';
  wordId: string | null;
  played: boolean;
  error: string | null;
  voice: SpeechSynthesisVoice | null;
  source?: 'hosted' | 'device';
  sourceLabel?: string;
}
export interface SpeakRequest { word: string; wordId: string; accent: Accent; voiceURI?: string; rate?: number; dictionaryVersion?: string }
export interface SpeechOptions {
  onStateChange?: (state: SpeechState) => void;
  onVoicesChange?: (voices: SpeechSynthesisVoice[]) => void;
  synthesis?: Pick<SpeechSynthesis, 'getVoices' | 'speak' | 'cancel' | 'addEventListener' | 'removeEventListener'> | null;
  createUtterance?: (text: string) => SpeechSynthesisUtterance;
  visibility?: Pick<Document, 'hidden' | 'addEventListener' | 'removeEventListener'> | null;
  startTimeoutMs?: number;
  voiceLoadTimeoutMs?: number;
  audioBaseUrl?: string;
  audioStore?: Pick<HostedAudioStore, 'getClip'>;
  createAudio?: () => HTMLAudioElement;
}

export function normalizeAccent(lang: string): string { return lang.replace(/_/g, '-').toLowerCase(); }
export function selectVoice(voices: readonly SpeechSynthesisVoice[], accent: Accent, uri = ''): SpeechSynthesisVoice | null {
  const matching = voices.filter(voice => normalizeAccent(voice.lang) === normalizeAccent(accent));
  if (uri) return matching.find(voice => voice.voiceURI === uri) ?? null;
  return matching.find(voice => voice.localService && voice.default) ?? matching.find(voice => voice.localService) ?? matching.find(voice => voice.default) ?? matching[0] ?? null;
}

/** Playback events gate answers. Available files/voices alone never imply playback. */
export class SpeechController {
  private readonly synthesis: SpeechOptions['synthesis'];
  private readonly createUtterance: (text: string) => SpeechSynthesisUtterance;
  private readonly visibility: SpeechOptions['visibility'];
  private generation = 0;
  private disposed = false;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private utterance: SpeechSynthesisUtterance | null = null;
  private pendingVoice: { request: SpeakRequest; token: number } | null = null;
  private readonly audioStore: Pick<HostedAudioStore, 'getClip'> | null;
  private audio: HTMLAudioElement | null = null;
  private audioUrl: string | null = null;
  private audioAbort: AbortController | null = null;
  private state: SpeechState = { status: 'idle', wordId: null, played: false, error: null, voice: null };
  private readonly voicesChanged = () => {
    if (this.disposed) return;
    this.options.onVoicesChange?.(this.getVoices());
    if (this.pendingVoice && this.allVoices().length) this.finishVoiceLoading(this.pendingVoice.token);
  };
  private readonly visibilityChanged = () => { if (this.visibility?.hidden) this.cancel(); };

  constructor(private readonly options: SpeechOptions = {}) {
    this.synthesis = options.synthesis !== undefined ? options.synthesis : typeof window !== 'undefined' && 'speechSynthesis' in window ? window.speechSynthesis : null;
    this.visibility = options.visibility !== undefined ? options.visibility : typeof document !== 'undefined' ? document : null;
    this.createUtterance = options.createUtterance ?? (text => new SpeechSynthesisUtterance(text));
    this.audioStore = options.audioStore ?? (options.audioBaseUrl ? new HostedAudioStore({ baseUrl: options.audioBaseUrl }) : null);
    this.synthesis?.addEventListener('voiceschanged', this.voicesChanged);
    this.visibility?.addEventListener('visibilitychange', this.visibilityChanged);
    queueMicrotask(this.voicesChanged);
  }

  getState(): SpeechState { return { ...this.state }; }
  getVoices(accent?: Accent): SpeechSynthesisVoice[] {
    return this.allVoices().filter(voice => accent
      ? normalizeAccent(voice.lang) === normalizeAccent(accent)
      : ['en-us', 'en-gb'].includes(normalizeAccent(voice.lang)));
  }
  private allVoices(): SpeechSynthesisVoice[] {
    try {
      return this.synthesis?.getVoices() ?? [];
    } catch { return []; }
  }

  speak(request: SpeakRequest): void {
    if (this.disposed) return;
    this.cancel();
    const token = this.generation;
    if (!request.word.trim() || request.word.length > 300 || !request.wordId || this.visibility?.hidden) {
      this.setState({ status: 'error', wordId: request.wordId, played: false, error: '当前单词无法朗读，请回到学习页面后重试。', voice: null });
      return;
    }
    if (this.audioStore && request.accent === 'en-US' && !request.voiceURI && request.dictionaryVersion) {
      this.audioAbort = new AbortController();
      const signal = this.audioAbort.signal;
      this.setState({ status: 'starting', wordId: request.wordId, played: false, error: null, voice: null, source: 'hosted', sourceLabel: '美式合成 · Piper / LJ Speech' });
      void this.speakHosted(request, token, signal);
      return;
    }
    this.speakDevice(request, token);
  }

  private speakDevice(request: SpeakRequest, token: number): void {
    const voices = this.allVoices();
    // Chrome can initially expose an empty list before voiceschanged. Keep the
    // current word pending briefly; never invent a voice or unlock an answer.
    if (this.synthesis && voices.length === 0) {
      this.pendingVoice = { request: { ...request }, token };
      this.setState({ status: 'starting', wordId: request.wordId, played: false, error: null, voice: null });
      this.timer = setTimeout(() => this.finishVoiceLoading(token), this.options.voiceLoadTimeoutMs ?? 1200);
      return;
    }
    this.speakWithVoice(request, token, selectVoice(voices, request.accent, request.voiceURI));
  }

  private async speakHosted(request: SpeakRequest, token: number, signal: AbortSignal): Promise<void> {
    const active = () => !this.disposed && token === this.generation && !signal.aborted;
    const fail = (message: string) => {
      if (!active()) return;
      this.clearTimer();
      this.detachAudio();
      this.audioAbort?.abort(); this.audioAbort = null;
      const native = selectVoice(this.getVoices(), request.accent);
      if (native) { this.speakWithVoice(request, token, native); return; }
      this.generation += 1;
      this.setState({ status: 'error', wordId: request.wordId, played: false, error: message, voice: null, source: 'hosted', sourceLabel: '美式合成 · Piper / LJ Speech' });
    };
    this.timer = setTimeout(() => fail('发音加载超时，请检查网络后点击重听。'), 15_000);
    try {
      const clip = await this.audioStore!.getClip(request.wordId, request.dictionaryVersion!, signal);
      if (!active()) return;
      const audio = this.options.createAudio?.() ?? new Audio();
      this.audio = audio;
      this.audioUrl = URL.createObjectURL(clip.blob);
      audio.preload = 'auto';
      audio.playbackRate = Math.max(0.5, Math.min(1.5, Number.isFinite(request.rate) ? request.rate ?? 1 : 1));
      audio.onplaying = () => {
        if (!active()) return;
        this.clearTimer();
        this.setState({ status: 'speaking', wordId: request.wordId, played: true, error: null, voice: null, source: 'hosted', sourceLabel: clip.label });
        this.timer = setTimeout(() => fail('发音播放未正常结束，请点击重听。'), Math.min(60_000, 10_000 + clip.duration / audio.playbackRate * 1000));
      };
      audio.onended = () => {
        if (!active()) return;
        if (!this.state.played) { fail('尚未确认发音已播放，请点击重听。'); return; }
        this.clearTimer(); this.generation += 1; this.detachAudio(); this.audioAbort = null;
        this.setState({ status: 'ended', wordId: request.wordId, played: true, error: null, voice: null, source: 'hosted', sourceLabel: clip.label });
      };
      audio.onerror = () => fail('发音文件未能播放，请点击重听。');
      audio.src = this.audioUrl;
      await audio.play();
      // play() resolving is not the answer gate; only the playing event is.
    } catch (error) {
      if (!active()) return;
      fail(error instanceof DOMException && error.name === 'NotAllowedError' ? '请点击重听，允许浏览器播放发音。' : error instanceof Error ? error.message : '发音暂时不可用，请点击重听。');
    }
  }

  private finishVoiceLoading(token: number): void {
    const pending = this.pendingVoice;
    if (!pending || pending.token !== token || token !== this.generation || this.disposed) return;
    this.pendingVoice = null;
    this.clearTimer();
    this.speakWithVoice(pending.request, token, selectVoice(this.allVoices(), pending.request.accent, pending.request.voiceURI));
  }

  private speakWithVoice(request: SpeakRequest, token: number, voice: SpeechSynthesisVoice | null): void {
    if (!this.synthesis || !voice) {
      this.setState({ status: 'unavailable', wordId: request.wordId, played: false, error: this.synthesis
        ? request.voiceURI ? '所选声音当前不可用，请在设置中重新选择声音。' : `当前浏览器没有可用的${request.accent === 'en-US' ? '美式' : '英式'}英语声音。可更换口音，或启用系统英语语音后重试。`
        : '此浏览器不支持设备朗读，请更换浏览器后重试。', voice: null });
      return;
    }
    const active = () => !this.disposed && token === this.generation;
    const fail = (message: string) => {
      if (!active()) return;
      this.generation += 1;
      this.clearTimer();
      this.detachUtterance();
      try { this.synthesis?.cancel(); } catch { /* The explicit error below remains visible. */ }
      this.setState({ status: 'error', wordId: request.wordId, played: false, error: message, voice });
    };
    try {
      const utterance = this.createUtterance(request.word);
      this.utterance = utterance;
      utterance.voice = voice;
      utterance.lang = request.accent;
      utterance.rate = Math.max(0.5, Math.min(1.5, Number.isFinite(request.rate) ? request.rate ?? 1 : 1));
      utterance.onstart = () => {
        if (!active()) return;
        this.clearTimer();
        this.setState({ status: 'speaking', wordId: request.wordId, played: true, error: null, voice });
        this.timer = setTimeout(() => fail('朗读未正常结束，请点击重听。'), Math.min(60_000, 20_000 + request.word.length * 100));
      };
      utterance.onend = () => {
        if (!active()) return;
        this.clearTimer();
        if (!this.state.played) { fail('尚未确认发音已播放，请点击重听。'); return; }
        this.generation += 1;
        this.detachUtterance();
        this.setState({ status: 'ended', wordId: request.wordId, played: true, error: null, voice });
      };
      utterance.onerror = () => fail('发音未能播放。请点击重听，或在设置中更换可用声音。');
      this.setState({ status: 'starting', wordId: request.wordId, played: false, error: null, voice });
      this.timer = setTimeout(() => fail('发音启动超时，请点击重听。部分设备声音需要联网。'), this.options.startTimeoutMs ?? 8000);
      this.synthesis.speak(utterance);
    } catch { fail('设备朗读无法启动，请点击重听或更换声音。'); }
  }

  cancel(): void {
    this.generation += 1;
    this.pendingVoice = null;
    this.audioAbort?.abort(); this.audioAbort = null;
    this.detachAudio();
    this.clearTimer();
    this.detachUtterance();
    try { this.synthesis?.cancel(); } catch { /* Cancellation must still invalidate callbacks. */ }
    this.setState({ status: 'idle', wordId: null, played: false, error: null, voice: null });
  }

  dispose(): void {
    this.disposed = true;
    this.cancel();
    this.synthesis?.removeEventListener('voiceschanged', this.voicesChanged);
    this.visibility?.removeEventListener('visibilitychange', this.visibilityChanged);
  }

  private clearTimer(): void { if (this.timer !== null) clearTimeout(this.timer); this.timer = null; }
  private detachAudio(): void {
    if (this.audio) {
      this.audio.onplaying = null; this.audio.onended = null; this.audio.onerror = null;
      this.audio.pause(); this.audio.removeAttribute('src'); this.audio.load();
    }
    this.audio = null;
    if (this.audioUrl) URL.revokeObjectURL(this.audioUrl);
    this.audioUrl = null;
  }
  private detachUtterance(): void {
    if (this.utterance) { this.utterance.onstart = null; this.utterance.onend = null; this.utterance.onerror = null; }
    this.utterance = null;
  }
  private setState(state: SpeechState): void {
    this.state = state.voice ? { ...state, source: 'device', sourceLabel: state.voice.name } : state;
    if (!this.disposed) this.options.onStateChange?.(this.getState());
  }
}
import { HostedAudioStore } from './audio';
