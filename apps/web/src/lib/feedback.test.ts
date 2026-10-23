import { describe, expect, it, vi } from 'vitest';
import { FeedbackController } from './feedback';

class Parameter {
  setValueAtTime = vi.fn();
  linearRampToValueAtTime = vi.fn();
}
class Gain {
  gain = new Parameter();
  connect = vi.fn(); disconnect = vi.fn();
}
class Source {
  buffer: AudioBuffer | null = null;
  onended: (() => void) | null = null;
  connect = vi.fn(); disconnect = vi.fn(); start = vi.fn(); stop = vi.fn();
}
class Context {
  state: AudioContextState = 'suspended';
  currentTime = 12;
  sampleRate = 48_000;
  destination = {};
  sources: Source[] = [];
  gains: Gain[] = [];
  samples: Float32Array[] = [];
  resume = vi.fn(async () => { this.state = 'running'; });
  close = vi.fn(async () => { this.state = 'closed'; });
  createBuffer = vi.fn((_channels: number, length: number, sampleRate: number) => {
    const samples = new Float32Array(length); this.samples.push(samples);
    return { sampleRate, getChannelData: () => samples } as unknown as AudioBuffer;
  });
  createBufferSource = vi.fn(() => { const source = new Source(); this.sources.push(source); return source; });
  createGain = vi.fn(() => { const gain = new Gain(); this.gains.push(gain); return gain; });
}
function setup() {
  const context = new Context();
  const createContext = vi.fn(() => context as unknown as AudioContext);
  const vibrate = vi.fn(() => true);
  return { context, createContext, vibrate, feedback: new FeedbackController({ createContext, vibrate }) };
}

describe('optional local learning feedback', () => {
  it('does no audio or vibration work on construction, and play alone cannot create or resume audio', async () => {
    const { feedback, createContext, context, vibrate } = setup();
    expect(createContext).not.toHaveBeenCalled(); expect(vibrate).not.toHaveBeenCalled();
    expect(await feedback.playSlash()).toBe(false);
    expect(createContext).not.toHaveBeenCalled(); expect(context.resume).not.toHaveBeenCalled();
    feedback.dispose(); expect(context.close).not.toHaveBeenCalled();
  });

  it('creates and resumes only in prepare, then reuses the running context without overlapping sounds', async () => {
    const { feedback, createContext, context } = setup();
    const preparing = feedback.prepareSlash();
    expect(createContext).toHaveBeenCalledTimes(1); expect(context.resume).toHaveBeenCalledTimes(1);
    expect(context.sources).toHaveLength(0);
    expect(await preparing).toBe(true);
    expect(await feedback.playSlash()).toBe(true);
    expect(await feedback.playSlash()).toBe(false);
    context.sources[0]!.onended?.();
    expect(await feedback.prepareSlash()).toBe(true);
    expect(await feedback.playSlash()).toBe(true);
    expect(createContext).toHaveBeenCalledTimes(1); expect(context.resume).toHaveBeenCalledTimes(1);
    expect(context.createBuffer).toHaveBeenCalledTimes(1);
    feedback.dispose();
  });

  it('schedules a short quiet noise transient with silence at both edges and attack/release ramps', async () => {
    const { feedback, context } = setup();
    await feedback.prepareSlash(); await feedback.playSlash();
    const samples = context.samples[0]!;
    const seconds = samples.length / context.sampleRate;
    expect(seconds).toBeGreaterThanOrEqual(0.14); expect(seconds).toBeLessThanOrEqual(0.18);
    expect(samples[0]).toBe(0); expect(samples.at(-1)).toBe(0);
    const peak = Math.max(...samples.map(Math.abs));
    const rms = Math.sqrt(samples.reduce((sum, value) => sum + value * value, 0) / samples.length);
    expect(peak).toBeGreaterThan(0.05); expect(peak * 0.32).toBeLessThan(0.1);
    expect(rms).toBeGreaterThan(0.01); expect(rms * 0.32).toBeLessThan(0.05);
    expect(context.gains[0]!.gain.setValueAtTime).toHaveBeenCalledWith(0, 12);
    expect(context.gains[0]!.gain.linearRampToValueAtTime).toHaveBeenLastCalledWith(0, 12 + seconds);
    expect(context.sources[0]!.start).toHaveBeenCalledWith(12);
    expect(context.sources[0]!.stop).toHaveBeenCalledWith(12 + seconds);
    feedback.dispose();
  });

  it('waits for the existing gesture preparation and never calls resume from play', async () => {
    const { feedback, context } = setup();
    let resume!: () => void;
    context.resume.mockImplementationOnce(() => new Promise<void>(resolve => { resume = () => { context.state = 'running'; resolve(); }; }));
    const preparation = feedback.prepareSlash(); const playing = feedback.playSlash();
    expect(context.sources).toHaveLength(0); expect(context.resume).toHaveBeenCalledTimes(1);
    resume(); expect(await preparation).toBe(true); expect(await playing).toBe(true);
    expect(context.resume).toHaveBeenCalledTimes(1);
    feedback.dispose();
  });

  it('does not create or resume audio after disposal, including a late pending preparation', async () => {
    const { feedback, context, createContext } = setup();
    let resume!: () => void;
    context.resume.mockImplementationOnce(() => new Promise<void>(resolve => { resume = resolve; }));
    const preparation = feedback.prepareSlash(); const playing = feedback.playSlash();
    feedback.dispose(); resume();
    expect(await preparation).toBe(false); expect(await playing).toBe(false);
    expect(await feedback.prepareSlash()).toBe(false); expect(await feedback.playSlash()).toBe(false);
    expect(feedback.vibrateStart()).toBe(false);
    expect(createContext).toHaveBeenCalledTimes(1); expect(context.close).toHaveBeenCalledTimes(1);
    expect(context.sources).toHaveLength(0);
  });

  it('silently handles unsupported, denied, suspended and failing audio', async () => {
    const missing = new FeedbackController({ createContext: null, vibrate: null });
    expect(await missing.prepareSlash()).toBe(false); expect(await missing.playSlash()).toBe(false); expect(missing.vibrateStart()).toBe(false);
    const f = setup(); f.context.resume.mockRejectedValueOnce(new Error('denied'));
    expect(await f.feedback.prepareSlash()).toBe(false); expect(await f.feedback.playSlash()).toBe(false);
    expect(await f.feedback.prepareSlash()).toBe(true);
    f.context.state = 'suspended';
    expect(await f.feedback.playSlash()).toBe(false); expect(f.context.resume).toHaveBeenCalledTimes(2);
    await f.feedback.prepareSlash(); f.context.createBufferSource.mockImplementationOnce(() => { throw new Error('device unavailable'); });
    expect(await f.feedback.playSlash()).toBe(false);
    f.context.close.mockRejectedValueOnce(new Error('already gone'));
    expect(() => f.feedback.dispose()).not.toThrow();
    const broken = new FeedbackController({ createContext: () => { throw new Error('unsupported'); } });
    expect(await broken.prepareSlash()).toBe(false); expect(await broken.playSlash()).toBe(false);
  });

  it('requests only a 12ms start vibration, preserving unsupported or rejected results', () => {
    const { feedback, vibrate, createContext } = setup();
    expect(feedback.vibrateStart()).toBe(true); expect(vibrate).toHaveBeenCalledWith(12);
    expect(createContext).not.toHaveBeenCalled();
    feedback.dispose(); expect(vibrate).toHaveBeenLastCalledWith(0);
    expect(new FeedbackController({ vibrate: () => false }).vibrateStart()).toBe(false);
    expect(new FeedbackController({ vibrate: () => { throw new Error('blocked'); } }).vibrateStart()).toBe(false);
  });

  it('stops and disconnects active nodes and closes its context exactly once', async () => {
    const { feedback, context } = setup();
    await feedback.prepareSlash(); await feedback.playSlash();
    const source = context.sources[0]!;
    feedback.dispose(); feedback.dispose();
    expect(source.onended).toBeNull(); expect(source.stop).toHaveBeenCalledTimes(2);
    expect(source.disconnect).toHaveBeenCalledTimes(1); expect(context.gains[0]!.disconnect).toHaveBeenCalledTimes(1);
    expect(context.close).toHaveBeenCalledTimes(1);
  });
});
