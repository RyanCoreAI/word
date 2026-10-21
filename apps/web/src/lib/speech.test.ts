import { afterEach, describe, expect, it, vi } from 'vitest';
import { SpeechController, selectVoice } from './speech';
import type { AudioClip } from './audio';

function voice(uri: string, lang: string, localService = true): SpeechSynthesisVoice {
  return { voiceURI: uri, name: uri, lang, localService, default: false };
}
const us = voice('us-local', 'en-US'); const gb = voice('uk-local', 'en-GB');
class Synth extends EventTarget {
  voices = [us, gb, voice('au', 'en-AU')];
  spoken: SpeechSynthesisUtterance[] = [];
  cancel = vi.fn();
  getVoices() { return this.voices; }
  speak(utterance: SpeechSynthesisUtterance) { this.spoken.push(utterance); }
}
class Visibility extends EventTarget { hidden = false; }
function createUtterance(text: string): SpeechSynthesisUtterance {
  return { text, lang: '', rate: 1, voice: null, onstart: null, onend: null, onerror: null } as SpeechSynthesisUtterance;
}
const controllers: SpeechController[] = [];
function setup() {
  const synthesis = new Synth(); const visibility = new Visibility();
  const onVoicesChange = vi.fn();
  const controller = new SpeechController({ synthesis, visibility, createUtterance, startTimeoutMs: 100, voiceLoadTimeoutMs: 200, onVoicesChange });
  controllers.push(controller);
  return { controller, synthesis, visibility, onVoicesChange };
}
function start(utterance: SpeechSynthesisUtterance) { utterance.onstart?.call(utterance, new Event('start') as SpeechSynthesisEvent); }
function end(utterance: SpeechSynthesisUtterance) { utterance.onend?.call(utterance, new Event('end') as SpeechSynthesisEvent); }
const request = { word: 'abandon', wordId: 'abandon', accent: 'en-US' as const };
afterEach(() => { for (const controller of controllers.splice(0)) controller.dispose(); vi.useRealTimers(); });

describe('device speech lifecycle', () => {
  it('publishes preloaded voices asynchronously and suppresses the notification after disposal', async () => {
    const first = setup(); const second = setup();
    expect(first.onVoicesChange).not.toHaveBeenCalled();
    second.controller.dispose();
    await new Promise<void>(resolve => queueMicrotask(resolve));
    expect(first.onVoicesChange).toHaveBeenCalledWith([us, gb]);
    expect(second.onVoicesChange).not.toHaveBeenCalled();
  });

  it('uses only an available voice of the selected accent, never another accent', () => {
    expect(selectVoice([gb], 'en-US')).toBeNull();
    expect(selectVoice([us, gb], 'en-US', gb.voiceURI)).toBeNull();
    expect(selectVoice([voice('us-remote', 'en-US', false), us], 'en-US')).toBe(us);
    const { controller, synthesis } = setup();
    expect(controller.getVoices()).toEqual([us, gb]);
    controller.speak({ ...request, voiceURI: 'missing' });
    expect(controller.getState()).toMatchObject({ status: 'unavailable', played: false });
    expect(synthesis.spoken).toHaveLength(0);
  });

  it('does not unlock listening answers until onstart and reports the real voice', () => {
    const { controller, synthesis } = setup();
    controller.speak({ ...request, rate: 0.65 });
    expect(controller.getState()).toMatchObject({ status: 'starting', played: false });
    const utterance = synthesis.spoken[0]!;
    expect(utterance.voice).toBe(us); expect(utterance.rate).toBe(0.65);
    start(utterance);
    expect(controller.getState()).toMatchObject({ status: 'speaking', played: true, voice: us });
    end(utterance);
    expect(controller.getState()).toMatchObject({ status: 'ended', played: true });
  });

  it('ignores delayed callbacks from a cancelled word after switching', () => {
    const { controller, synthesis } = setup();
    controller.speak(request);
    const previous = synthesis.spoken[0]!; const oldStart = previous.onstart; const oldError = previous.onerror;
    controller.speak({ ...request, word: 'ability', wordId: 'ability' });
    oldStart?.call(previous, new Event('start') as SpeechSynthesisEvent);
    oldError?.call(previous, new Event('error') as SpeechSynthesisErrorEvent);
    expect(controller.getState()).toMatchObject({ wordId: 'ability', status: 'starting', played: false });
    start(synthesis.spoken[1]!);
    expect(controller.getState()).toMatchObject({ wordId: 'ability', status: 'speaking', played: true });
  });

  it('reports start timeouts and end-without-start as failures, then permits retry', () => {
    vi.useFakeTimers();
    const { controller, synthesis } = setup();
    controller.speak(request); vi.advanceTimersByTime(101);
    expect(controller.getState()).toMatchObject({ status: 'error', played: false });
    controller.speak(request); end(synthesis.spoken[1]!);
    expect(controller.getState()).toMatchObject({ status: 'error', played: false });
    controller.speak(request); start(synthesis.spoken[2]!);
    expect(controller.getState()).toMatchObject({ status: 'speaking', played: true });
  });

  it('updates asynchronously loaded voices and cancels when the page is hidden', () => {
    const { controller, synthesis, visibility, onVoicesChange } = setup();
    synthesis.voices = []; controller.speak(request);
    expect(controller.getState()).toMatchObject({ status: 'starting', played: false, voice: null });
    synthesis.voices = [us]; synthesis.dispatchEvent(new Event('voiceschanged'));
    expect(onVoicesChange).toHaveBeenCalledWith([us]);
    expect(synthesis.spoken).toHaveLength(1);
    expect(controller.getState().played).toBe(false);
    start(synthesis.spoken[0]!);
    visibility.hidden = true; visibility.dispatchEvent(new Event('visibilitychange'));
    expect(controller.getState()).toMatchObject({ status: 'idle', wordId: null, played: false });
    expect(synthesis.cancel).toHaveBeenCalled();
  });

  it('bounds voice loading and never substitutes a non-English or wrong-accent voice', () => {
    vi.useFakeTimers();
    const { controller, synthesis } = setup();
    synthesis.voices = []; controller.speak(request);
    vi.advanceTimersByTime(199);
    expect(controller.getState()).toMatchObject({ status: 'starting', played: false });
    vi.advanceTimersByTime(1);
    expect(controller.getState()).toMatchObject({ status: 'unavailable', played: false });
    synthesis.voices = [voice('Chinese', 'zh-CN'), gb];
    synthesis.dispatchEvent(new Event('voiceschanged'));
    expect(synthesis.spoken).toHaveLength(0);
    controller.speak(request);
    expect(controller.getState()).toMatchObject({ status: 'unavailable', played: false });
  });

  it('cancels pending voice discovery when switching words, hiding, or disposing', () => {
    vi.useFakeTimers();
    const { controller, synthesis, visibility } = setup();
    synthesis.voices = []; controller.speak(request);
    controller.speak({ ...request, word: 'bank', wordId: 'bank' });
    synthesis.voices = [us]; synthesis.dispatchEvent(new Event('voiceschanged'));
    expect(synthesis.spoken.map(utterance => utterance.text)).toEqual(['bank']);
    synthesis.voices = []; controller.speak(request);
    visibility.hidden = true; visibility.dispatchEvent(new Event('visibilitychange'));
    synthesis.voices = [us]; synthesis.dispatchEvent(new Event('voiceschanged'));
    vi.advanceTimersByTime(250);
    expect(synthesis.spoken).toHaveLength(1);
    expect(controller.getState()).toMatchObject({ status: 'idle', played: false });
    visibility.hidden = false; synthesis.voices = []; controller.speak(request);
    controller.dispose(); synthesis.voices = [us]; synthesis.dispatchEvent(new Event('voiceschanged'));
    vi.advanceTimersByTime(250);
    expect(synthesis.spoken).toHaveLength(1);
    expect(controller.getState()).toMatchObject({ status: 'idle', played: false });
  });

  it('returns a useful unavailable state in browsers without speech synthesis', () => {
    const controller = new SpeechController({ synthesis: null, visibility: null }); controllers.push(controller);
    expect(() => controller.speak(request)).not.toThrow();
    expect(controller.getState()).toMatchObject({ status: 'unavailable', played: false });
    expect(controller.getState().error).toContain('不支持');
  });
});

class Media {
  src = ''; preload = ''; playbackRate = 1;
  onplaying: HTMLAudioElement['onplaying'] = null;
  onended: HTMLAudioElement['onended'] = null;
  onerror: HTMLAudioElement['onerror'] = null;
  play = vi.fn(async () => {}); pause = vi.fn(); load = vi.fn(); removeAttribute = vi.fn();
  event(type: 'playing' | 'ended') { this[`on${type}`]?.call(this as unknown as HTMLAudioElement, new Event(type)); }
}
const clip: AudioClip = { blob: new Blob(['verified test transport bytes'], { type: 'audio/mpeg' }), duration: 0.5, label: 'Piper sample' };
const hostedRequest = { ...request, dictionaryVersion: 'dict-v1' };
function hosted(synthesis: Synth | null = null, getClip = vi.fn(async () => clip)) {
  const media: Media[] = []; const visibility = new Visibility();
  const controller = new SpeechController({ synthesis, visibility, createUtterance, audioStore: { getClip }, createAudio: () => { const item = new Media(); media.push(item); return item as unknown as HTMLAudioElement; } });
  controllers.push(controller);
  return { controller, getClip, media, visibility };
}

describe('self-hosted playback lifecycle', () => {
  it('uses hosted audio by default even without device voices, and gates on playing only', async () => {
    const f = hosted();
    f.controller.speak({ ...hostedRequest, rate: 0.65 });
    await Promise.resolve(); await Promise.resolve();
    expect(f.media).toHaveLength(1);
    expect(f.media[0]!.playbackRate).toBe(0.65);
    expect(f.controller.getState()).toMatchObject({ status: 'starting', played: false, source: 'hosted' });
    f.media[0]!.event('playing');
    expect(f.controller.getState()).toMatchObject({ status: 'speaking', played: true, sourceLabel: 'Piper sample' });
    f.media[0]!.event('ended');
    expect(f.controller.getState()).toMatchObject({ status: 'ended', played: true });
    expect(f.media[0]!.pause).toHaveBeenCalled();
  });

  it('respects explicit native voice and UK accent without requesting hosted audio', () => {
    const synthesis = new Synth(); const f = hosted(synthesis);
    f.controller.speak({ ...hostedRequest, voiceURI: us.voiceURI });
    expect(synthesis.spoken[0]!.voice).toBe(us);
    f.controller.speak({ ...hostedRequest, accent: 'en-GB' });
    expect(synthesis.spoken[1]!.voice).toBe(gb);
    expect(f.getClip).not.toHaveBeenCalled();
  });

  it('falls back to a real same-accent device voice after file failure, without unlocking early', async () => {
    const synthesis = new Synth(); const f = hosted(synthesis, vi.fn(async () => { throw new Error('offline pack missing'); }));
    f.controller.speak(hostedRequest); await Promise.resolve(); await Promise.resolve();
    expect(synthesis.spoken).toHaveLength(1);
    expect(f.controller.getState()).toMatchObject({ played: false, source: 'device' });
    start(synthesis.spoken[0]!);
    expect(f.controller.getState()).toMatchObject({ played: true, voice: us });
  });

  it('invalidates pending fetches and stale media callbacks when switching words', async () => {
    let resolveFirst: (value: AudioClip) => void = () => {};
    const pending = new Promise<AudioClip>(resolve => { resolveFirst = resolve; });
    const getClip = vi.fn().mockReturnValueOnce(pending).mockResolvedValue(clip);
    const f = hosted(null, getClip);
    f.controller.speak(hostedRequest);
    const firstSignal = getClip.mock.calls[0]![2] as AbortSignal;
    f.controller.speak({ ...hostedRequest, wordId: 'bank', word: 'bank' });
    resolveFirst(clip); await Promise.resolve(); await Promise.resolve();
    expect(firstSignal.aborted).toBe(true); expect(f.media).toHaveLength(1);
    const oldPlaying = f.media[0]!.onplaying;
    f.controller.speak({ ...hostedRequest, wordId: 'way', word: 'way' });
    oldPlaying?.call(f.media[0] as unknown as HTMLAudioElement, new Event('playing'));
    expect(f.controller.getState()).toMatchObject({ wordId: 'way', played: false });
    await Promise.resolve(); await Promise.resolve();
    f.media[1]!.event('playing');
    f.visibility.hidden = true; f.visibility.dispatchEvent(new Event('visibilitychange'));
    expect(f.media[1]!.pause).toHaveBeenCalled();
    expect(f.controller.getState()).toMatchObject({ status: 'idle', played: false });
  });

  it('treats rejected play and ended-without-playing as failures', async () => {
    const f = hosted();
    f.controller.speak(hostedRequest); await Promise.resolve(); await Promise.resolve();
    f.media[0]!.event('ended');
    expect(f.controller.getState()).toMatchObject({ status: 'error', played: false });
    const controller = new SpeechController({ synthesis: null, visibility: null, audioStore: { getClip: async () => clip }, createAudio: () => {
      const media = new Media(); media.play.mockRejectedValue(new DOMException('Blocked', 'NotAllowedError')); return media as unknown as HTMLAudioElement;
    } });
    controllers.push(controller); controller.speak(hostedRequest);
    await Promise.resolve(); await Promise.resolve(); await Promise.resolve();
    expect(controller.getState()).toMatchObject({ status: 'error', played: false });
    expect(controller.getState().error).toContain('点击重听');
  });

  it('bounds an unresponsive fetch and never plays its late result', async () => {
    vi.useFakeTimers(); let resolve: (value: AudioClip) => void = () => {};
    const f = hosted(null, vi.fn(() => new Promise<AudioClip>(done => { resolve = done; })));
    f.controller.speak(hostedRequest); vi.advanceTimersByTime(15_001);
    expect(f.controller.getState()).toMatchObject({ status: 'error', played: false });
    resolve(clip); await Promise.resolve(); await Promise.resolve();
    expect(f.media).toHaveLength(0);
  });
});
