import { afterEach, describe, expect, it, vi } from 'vitest';
import { SpeechController, selectVoice } from './speech';

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

function configured(synthesis: Synth | null = null) {
  const getClip = vi.fn(); const createAudio = vi.fn();
  const controller = new SpeechController({ synthesis, visibility: null, createUtterance,
    audioBaseUrl: 'https://word.example/audio/', audioStore: { getClip }, createAudio });
  controllers.push(controller);
  return { controller, getClip, createAudio };
}

describe('local Samantha preference without network audio', () => {
  const samantha = { ...voice('com.apple.voice.compact.en-US.Samantha', 'en-US'), name: 'Samantha' };
  const remote = { ...voice('remote-samantha', 'en-US', false), name: 'Samantha' };
  const hostedRequest = { ...request, dictionaryVersion: 'dict-v1', studyWordIndex: 42 };

  it('prefers the actual local Samantha over another system default and normalizes voice languages', () => {
    const localDefault = { ...us, default: true };
    const underscored = { ...samantha, lang: 'en_US' };
    expect(selectVoice([remote, localDefault, underscored], 'en-US')).toBe(underscored);
    expect(selectVoice([localDefault, { ...samantha, name: 'Samantha (Enhanced)' }], 'en-US')?.name).toBe('Samantha (Enhanced)');
    expect(selectVoice([localDefault, gb], 'en-GB')).toBe(gb);
    expect(selectVoice([localDefault, samantha], 'en-US', us.voiceURI)).toBe(localDefault);
  });

  it('falls back only to an installed local voice of the selected accent when Samantha is absent', () => {
    expect(selectVoice([remote, us, gb], 'en-US')).toBe(us);
    expect(selectVoice([remote, gb], 'en-US')).toBeNull();
    expect(selectVoice([remote, us], 'en-US', remote.voiceURI)).toBeNull();
    const synthesis = new Synth(); synthesis.voices = [remote, us, gb];
    const { controller, getClip, createAudio } = configured(synthesis);
    expect(controller.getVoices()).toEqual([us, gb]);
    expect(controller.getVoices('en-US')).toEqual([us]);
    controller.speak(hostedRequest);
    expect(synthesis.spoken[0]!.voice).toBe(us);
    expect(getClip).not.toHaveBeenCalled(); expect(createAudio).not.toHaveBeenCalled();
  });

  it('uses local Samantha for existing dictionary requests without downloading an audio pack', () => {
    const synthesis = new Synth(); synthesis.voices = [us, samantha];
    const { controller, getClip, createAudio } = configured(synthesis);
    controller.speak({ ...hostedRequest, rate: 0.65 });
    expect(synthesis.spoken).toHaveLength(1);
    expect(synthesis.spoken[0]!.voice).toBe(samantha);
    expect(synthesis.spoken[0]!.rate).toBe(0.65);
    expect(controller.getState()).toMatchObject({ status: 'starting', played: false, source: 'device', sourceLabel: 'Samantha' });
    start(synthesis.spoken[0]!);
    expect(controller.getState()).toMatchObject({ status: 'speaking', played: true, sourceLabel: 'Samantha' });
    end(synthesis.spoken[0]!);
    expect(controller.getState()).toMatchObject({ status: 'ended', played: true });
    expect(getClip).not.toHaveBeenCalled(); expect(createAudio).not.toHaveBeenCalled();
  });

  it('does not substitute Piper or a remote voice when local speech is unavailable', () => {
    const synthesis = new Synth(); synthesis.voices = [remote, voice('Chinese', 'zh-CN')];
    const { controller, getClip, createAudio } = configured(synthesis);
    controller.speak(hostedRequest);
    expect(controller.getState()).toMatchObject({ status: 'unavailable', played: false, voice: null });
    expect(controller.getState().error).toContain('Samantha');
    expect(synthesis.spoken).toHaveLength(0);
    expect(getClip).not.toHaveBeenCalled(); expect(createAudio).not.toHaveBeenCalled();
  });

  it('rejects a missing or remote explicitly selected voice instead of silently replacing it', () => {
    const synthesis = new Synth(); synthesis.voices = [samantha, remote];
    const { controller, getClip } = configured(synthesis);
    for (const voiceURI of ['missing', remote.voiceURI]) {
      controller.speak({ ...hostedRequest, voiceURI });
      expect(controller.getState()).toMatchObject({ status: 'unavailable', played: false });
      expect(controller.getState().error).toContain('所选本机声音');
    }
    expect(synthesis.spoken).toHaveLength(0); expect(getClip).not.toHaveBeenCalled();
  });

  it('never fetches hosted audio when the browser has no speech synthesis API', () => {
    const { controller, getClip, createAudio } = configured();
    controller.speak(hostedRequest);
    expect(controller.getState()).toMatchObject({ status: 'unavailable', played: false });
    expect(controller.getState().error).toContain('不支持');
    expect(getClip).not.toHaveBeenCalled(); expect(createAudio).not.toHaveBeenCalled();
  });
});
