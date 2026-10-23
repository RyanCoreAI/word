export interface FeedbackOptions {
  /** The controller owns and closes the returned context. Called only by prepareSlash(). */
  createContext?: (() => AudioContext | null) | null;
  vibrate?: ((duration: number) => boolean) | null;
}

const duration = 0.16;

/** A quiet band-limited swish with brief inharmonic metal, never a sustained tone. */
function slashBuffer(context: AudioContext): AudioBuffer {
  const buffer = context.createBuffer(1, Math.ceil(context.sampleRate * duration), context.sampleRate);
  const samples = buffer.getChannelData(0);
  let random = 0x57a15e;
  let upper = 0; let lower = 0;
  for (let index = 0; index < samples.length; index += 1) {
    const time = index / context.sampleRate;
    const progress = index / (samples.length - 1);
    random ^= random << 13; random ^= random >>> 17; random ^= random << 5;
    const noise = (random >>> 0) / 0x80000000 - 1;
    // A downward sweep makes a blade-like air movement; removing low frequencies
    // avoids a heavy impact and keeps this much quieter than spoken words.
    upper += (noise - upper) * (1 - Math.exp(-2 * Math.PI * (6_800 - 4_300 * progress) / context.sampleRate));
    lower += (noise - lower) * (1 - Math.exp(-2 * Math.PI * 850 / context.sampleRate));
    const metal = (Math.sin(2 * Math.PI * 4_310 * time) + 0.57 * Math.sin(2 * Math.PI * 6_730 * time) + 0.23 * Math.sin(2 * Math.PI * 9_170 * time)) * Math.exp(-65 * time);
    const swell = Math.pow(Math.sin(Math.PI * progress), 0.7);
    const edge = Math.min(1, time / 0.004, (duration - time) / 0.012);
    samples[index] = Math.max(-0.28, Math.min(0.28, ((upper - lower) * 0.3 + metal * 0.025) * swell * Math.max(0, edge)));
  }
  samples[0] = 0; samples[samples.length - 1] = 0;
  return buffer;
}

/** Optional local feedback must never change learning results or throw into the UI. */
export class FeedbackController {
  private readonly createContext: (() => AudioContext | null) | null;
  private readonly vibrate: ((duration: number) => boolean) | null;
  private context: AudioContext | null = null;
  private buffer: AudioBuffer | null = null;
  private preparation: Promise<boolean> | null = null;
  private active: { source: AudioBufferSourceNode; gain: GainNode } | null = null;
  private vibrationRequested = false;
  private disposed = false;

  constructor(options: FeedbackOptions = {}) {
    this.createContext = options.createContext !== undefined ? options.createContext : () => typeof window !== 'undefined' && window.AudioContext ? new window.AudioContext({ latencyHint: 'interactive' }) : null;
    this.vibrate = options.vibrate !== undefined ? options.vibrate : typeof navigator !== 'undefined' && typeof navigator.vibrate === 'function' ? navigator.vibrate.bind(navigator) : null;
  }

  /** Call in the original click handler, before awaiting the save operation. */
  prepareSlash(): Promise<boolean> {
    if (this.disposed) return Promise.resolve(false);
    if (this.preparation) return this.preparation;
    try {
      if (!this.context || this.context.state === 'closed') {
        this.context = this.createContext?.() ?? null;
        this.buffer = null;
      }
      const context = this.context;
      if (!context || context.state === 'closed') return Promise.resolve(false);
      if (context.state === 'running') return Promise.resolve(true);
      // resume() is invoked synchronously while the click's user activation is live.
      const resumed = context.resume();
      const preparation = Promise.resolve(resumed).then(() => !this.disposed && this.context === context && context.state === 'running').catch(() => false).finally(() => {
        if (this.preparation === preparation) this.preparation = null;
      });
      this.preparation = preparation;
      return preparation;
    } catch { return Promise.resolve(false); }
  }

  /** Call only after a successful slash save. This never constructs or resumes audio. */
  async playSlash(): Promise<boolean> {
    if (this.preparation && !await this.preparation) return false;
    const context = this.context;
    if (this.disposed || !context || context.state !== 'running' || this.active) return false;
    let source: AudioBufferSourceNode | null = null;
    let gain: GainNode | null = null;
    try {
      this.buffer ??= slashBuffer(context);
      source = context.createBufferSource(); gain = context.createGain();
      source.buffer = this.buffer;
      const now = context.currentTime;
      gain.gain.setValueAtTime(0, now);
      gain.gain.linearRampToValueAtTime(0.32, now + 0.004);
      gain.gain.setValueAtTime(0.32, now + 0.13);
      gain.gain.linearRampToValueAtTime(0, now + duration);
      source.connect(gain); gain.connect(context.destination);
      const active = { source, gain };
      this.active = active;
      source.onended = () => {
        try { source?.disconnect(); gain?.disconnect(); } catch { /* Optional feedback only. */ }
        if (this.active === active) this.active = null;
      };
      source.start(now); source.stop(now + duration);
      return true;
    } catch {
      try { source?.stop(); } catch { /* The source may not have started. */ }
      try { source?.disconnect(); gain?.disconnect(); } catch { /* Optional feedback only. */ }
      this.active = null;
      return false;
    }
  }

  /** true means the browser accepted the request, not proof of physical vibration. */
  vibrateStart(): boolean {
    if (this.disposed || !this.vibrate) return false;
    try { const accepted = this.vibrate(12); this.vibrationRequested ||= accepted; return accepted; } catch { return false; }
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    if (this.active) {
      this.active.source.onended = null;
      try { this.active.source.stop(); } catch { /* Already ended is harmless. */ }
      try { this.active.source.disconnect(); this.active.gain.disconnect(); } catch { /* Optional feedback only. */ }
      this.active = null;
    }
    const context = this.context;
    this.context = null; this.buffer = null;
    if (context && context.state !== 'closed') { try { void context.close().catch(() => {}); } catch { /* Closing can also fail synchronously. */ } }
    if (this.vibrationRequested) { try { this.vibrate?.(0); } catch { /* Unsupported hardware is silent. */ } }
  }
}
