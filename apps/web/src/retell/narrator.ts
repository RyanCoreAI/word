import { SpeechController, type SpeakRequest, type SpeechState } from '../lib/speech';

export function passageChunks(text: string): string[] {
  const chunks: string[] = []; let current = '';
  for (const word of text.trim().split(/\s+/)) {
    if (!word || word.length > 280) throw new Error('朗读文本包含过长词条。');
    if (current.length + word.length + 1 > 260) { chunks.push(current); current = ''; }
    current += (current ? ' ' : '') + word;
    if (/[.!?]$/.test(word) && current.length > 80) { chunks.push(current); current = ''; }
  }
  if (current) chunks.push(current);
  return chunks;
}

export class PassageNarrator {
  private readonly speech: SpeechController;
  private queue: SpeakRequest[] = [];
  private active = false;
  constructor(onState: (state: SpeechState) => void) {
    this.speech = new SpeechController({ onStateChange: state => { onState(state); if (state.status === 'ended' && this.active) this.next(); if (state.status === 'error' || state.status === 'unavailable') { this.queue = []; this.active = false; } } });
  }
  speak(text: string, request: Omit<SpeakRequest, 'word'>): void { this.cancel(); this.queue = passageChunks(text).map(word => ({ ...request, word })); this.active = true; this.next(); }
  cancel(): void { this.active = false; this.queue = []; this.speech.cancel(); }
  dispose(): void { this.cancel(); this.speech.dispose(); }
  private next(): void { const request = this.queue.shift(); if (!request) { this.active = false; return; } this.speech.speak(request); }
}
