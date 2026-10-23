import type { HostedAudioStore } from './audio';

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
export interface SpeakRequest { word: string; wordId: string; accent: Accent; voiceURI?: string; rate?: number; dictionaryVersion?: string; studyWordIndex?: number }
export interface SpeechOptions {
  onStateChange?: (state: SpeechState) => void;
  onVoicesChange?: (voices: SpeechSynthesisVoice[]) => void;
  synthesis?: Pick<SpeechSynthesis, 'getVoices' | 'speak' | 'cancel' | 'addEventListener' | 'removeEventListener'> | null;
  createUtterance?: (text: string) => SpeechSynthesisUtterance;
  visibility?: Pick<Document, 'hidden' | 'addEventListener' | 'removeEventListener'> | null;
  startTimeoutMs?: number;
  voiceLoadTimeoutMs?: number;
  // Accepted during the settings migration; device playback never reads them.
  audioBaseUrl?: string;
  audioStore?: Pick<HostedAudioStore, 'getClip'>;
  createAudio?: () => HTMLAudioElement;
}

export function normalizeAccent(lang: string): string { return lang.replace(/_/g, '-').toLowerCase(); }
export function selectVoice(voices: readonly SpeechSynthesisVoice[], accent: Accent, uri = ''): SpeechSynthesisVoice | null {
  const matching = voices.filter(voice => voice.localService && normalizeAccent(voice.lang) === normalizeAccent(accent));
  if (uri) return matching.find(voice => voice.voiceURI === uri) ?? null;
  return (accent === 'en-US' ? matching.find(voice => /\bsamantha\b/i.test(voice.name)) : undefined)
    ?? matching.find(voice => voice.default) ?? matching[0] ?? null;
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
    this.synthesis?.addEventListener('voiceschanged', this.voicesChanged);
    this.visibility?.addEventListener('visibilitychange', this.visibilityChanged);
    queueMicrotask(this.voicesChanged);
  }

  getState(): SpeechState { return { ...this.state }; }
  getVoices(accent?: Accent): SpeechSynthesisVoice[] {
    return this.allVoices().filter(voice => voice.localService && (accent
      ? normalizeAccent(voice.lang) === normalizeAccent(accent)
      : ['en-us', 'en-gb'].includes(normalizeAccent(voice.lang))));
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
        ? request.voiceURI ? '所选本机声音当前不可用，请在设置中重新选择声音。' : `当前浏览器未提供本机${request.accent === 'en-US' ? '美式英语声音（优先 Samantha）' : '英式英语声音'}。请在系统中启用英语语音后重试。`
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
      this.timer = setTimeout(() => fail('本机发音启动超时，请点击重听，或在设置中更换本机声音。'), this.options.startTimeoutMs ?? 8000);
      this.synthesis.speak(utterance);
    } catch { fail('设备朗读无法启动，请点击重听或更换声音。'); }
  }

  cancel(): void {
    this.generation += 1;
    this.pendingVoice = null;
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
  private detachUtterance(): void {
    if (this.utterance) { this.utterance.onstart = null; this.utterance.onend = null; this.utterance.onerror = null; }
    this.utterance = null;
  }
  private setState(state: SpeechState): void {
    this.state = state.voice ? { ...state, source: 'device', sourceLabel: state.voice.name } : state;
    if (!this.disposed) this.options.onStateChange?.(this.getState());
  }
}
