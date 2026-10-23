import { describe, expect, it } from 'vitest';
import { answer, createInitialState, deferWord, ensureSession, getCurrentToken, getCurrentWord, nextWord, restartWord, restoreSkipped, skipWord, undo, updateSettings } from './engine';
import { parseAppState, parseWords } from './schemas';
import type { AppState, Mode, Word } from './types';

const VERSION = 'test-dictionary-v1';
const words: Word[] = Array.from({ length: 45 }, (_, index) => ({
  id: `word-${index}`, word: `term${index}`, translation: 'n. 测试词条', phonetic: '',
  tags: [index < 25 ? 'cet4' : 'gre'], rank: index, basic: index === 44,
}));
let time = 100;
function initial(items: readonly Word[] = words, mode: Mode = 'look'): AppState {
  return ensureSession(createInitialState(VERSION, time++), items, mode, time++);
}
function respond(state: AppState, result: 'known' | 'unknown', mode: Mode = 'look'): AppState {
  return answer(state, mode, result, getCurrentToken(state, mode), time++);
}
function next(state: AppState, mode: Mode = 'look'): AppState {
  return nextWord(state, mode, getCurrentToken(state, mode), time++);
}
function completeRemaining(state: AppState, mode: Mode = 'look'): AppState {
  let value = state;
  while (value.modes[mode].session?.status === 'active') {
    value = value.modes[mode].session?.revealed ? next(value, mode) : respond(value, 'known', mode);
  }
  return value;
}
function validated(state: AppState, items: readonly Word[] = words): AppState {
  return parseAppState(JSON.parse(JSON.stringify(state)), items, VERSION);
}

describe('learning flow', () => {
  it('a first-sight known word completes this round and advances immediately', () => {
    const state = respond(initial(), 'known');
    expect(state.modes.look.progress['word-0']).toMatchObject({ status: 'completed', wrongCount: 0, rightCount: 1, seenCount: 1 });
    expect(getCurrentWord(state, 'look', words)?.id).toBe('word-1');
    expect(state.modes.listen.progress).toEqual({});
    validated(state);
  });

  it('unknown reveals in place; persistence restores the exact revealed word', () => {
    const state = respond(initial(), 'unknown');
    expect(state.modes.look.session).toMatchObject({ cursor: 0, revealed: true, unknown: 1 });
    const restored = validated(state);
    expect(getCurrentWord(restored, 'look', words)?.id).toBe('word-0');
    expect(restored.modes.look.progress['word-0']?.wrongCount).toBe(1);
    expect(next(restored).modes.look.session).toMatchObject({ cursor: 1, revealed: false });
  });

  it('counts unknown once and rejects stale or repeated answer/next tokens', () => {
    const before = initial();
    const token = getCurrentToken(before, 'look');
    const after = answer(before, 'look', 'unknown', token, time++);
    expect(answer(after, 'look', 'unknown', token, time++)).toBe(after);
    expect(respond(after, 'known')).toBe(after);
    const nextToken = getCurrentToken(after, 'look');
    const advanced = nextWord(after, 'look', nextToken, time++);
    expect(nextWord(advanced, 'look', nextToken, time++)).toBe(advanced);
    expect(advanced.modes.look.progress['word-0']?.wrongCount).toBe(1);
  });

  it('requires two known answers in subsequent groups and resets streak on another unknown', () => {
    const one = words.slice(0, 1);
    let state = next(respond(initial(one), 'unknown'));
    state = ensureSession(state, one, 'look', time++);
    state = respond(state, 'known');
    expect(state.modes.look.progress['word-0']).toMatchObject({ status: 'learning', streak: 1 });
    state = ensureSession(state, one, 'look', time++);
    state = next(respond(state, 'unknown'));
    expect(state.modes.look.progress['word-0']).toMatchObject({ status: 'learning', wrongCount: 2, streak: 0 });
    state = respond(ensureSession(state, one, 'look', time++), 'known');
    expect(state.modes.look.progress['word-0']?.streak).toBe(1);
    state = respond(ensureSession(state, one, 'look', time++), 'known');
    expect(state.modes.look.progress['word-0']).toMatchObject({ status: 'completed', streak: 2, wrongCount: 2 });
    validated(state, one);
    expect(ensureSession(state, one, 'look', time++).modes.look.session?.items).toEqual([]);
  });

  it('keeps the last unknown revealed until explicit next, then finishes the group', () => {
    let state = respond(initial(words.slice(0, 1)), 'unknown');
    expect(state.modes.look.session?.status).toBe('active');
    state = next(state);
    expect(state.modes.look.session).toMatchObject({ status: 'finished', cursor: 1, unknown: 1 });
  });

  it('keeps mode progress and active sessions independent', () => {
    let state = respond(initial(), 'unknown');
    state = ensureSession(state, words, 'listen', time++);
    state = respond(state, 'known', 'listen');
    expect(state.modes.look.progress['word-0']).toMatchObject({ status: 'learning', wrongCount: 1 });
    expect(state.modes.listen.progress['word-0']).toMatchObject({ status: 'completed', wrongCount: 0 });
    expect(ensureSession(state, words, 'look', time++)).toBe(state);
    expect(state.modes.look.session).toMatchObject({ cursor: 0, revealed: true });
    validated(state);
  });

  it('preserves current group on filtering changes and retains out-of-scope reviews next group', () => {
    let state = respond(initial(), 'unknown');
    const originalItems = state.modes.look.session!.items;
    state = updateSettings(state, { deck: 'gre', skipBasic: false, groupSize: 10 }, time++);
    expect(state.modes.look.session!.items).toEqual(originalItems);
    state = completeRemaining(state);
    state = ensureSession(state, words, 'look', time++);
    expect(state.modes.look.session!.items[0]).toBe('word-0');
    expect(state.modes.look.session!.items.slice(1).every(id => Number(id.split('-')[1]) >= 25)).toBe(true);
    validated(state);
  });

  it('includes every outstanding review even when reducing 30-word groups to 10', () => {
    let state = updateSettings(createInitialState(VERSION, time++), { groupSize: 30 }, time++);
    state = ensureSession(state, words, 'look', time++);
    for (let n = 0; n < 30; n++) state = next(respond(state, 'unknown'));
    state = updateSettings(state, { groupSize: 10 }, time++);
    state = ensureSession(state, words, 'look', time++);
    expect(state.modes.look.session!.items).toHaveLength(30);
    expect(new Set(state.modes.look.session!.items).size).toBe(30);
    validated(state);
  });

  it('filters only basic-marked words, never all short or common words', () => {
    const fixtures = [
      { ...words[0]!, id: 'a', word: 'a', basic: true },
      { ...words[1]!, id: 'owe', word: 'owe', basic: false },
    ];
    expect(initial(fixtures).modes.look.session?.items).toEqual(['owe']);
  });

  it('ends cleanly when no eligible words remain', () => {
    const empty = initial([]);
    expect(empty.modes.look.session).toMatchObject({ items: [], cursor: 0, status: 'finished' });
    expect(getCurrentToken(empty, 'look')).toBeNull();
    expect(ensureSession(empty, [], 'look', time++)).toBe(empty);
    validated(empty, []);
  });
});

describe('undo and skipping', () => {
  it('marks permanent-skip guidance as seen atomically and keeps it seen after undo', () => {
    const before = initial();
    expect(before.settings.skipHintSeen).toBe(false);
    const skipped = skipWord(before, 'look', getCurrentToken(before, 'look'), time++);
    expect(skipped.settings.skipHintSeen).toBe(true);
    expect(skipped.skipped).toEqual(['word-0']);
    const undone = undo(validated(skipped), time++);
    expect(undone.settings.skipHintSeen).toBe(true);
    expect(undone.skipped).toEqual([]);
    expect(undone.modes).toEqual(before.modes);
    validated(undone);
  });

  it('undo unknown restores hidden state and removes the newly created counters', () => {
    const before = initial();
    const after = undo(next(respond(before, 'unknown')), time++);
    expect(after.modes.look).toEqual(before.modes.look);
    expect(after.history).toHaveLength(0);
    expect(after.revision).toBeGreaterThan(before.revision);
    validated(after);
  });

  it('undo restores a review streak and the previous group after another group was opened', () => {
    const one = words.slice(0, 1);
    let state = next(respond(initial(one), 'unknown'));
    state = respond(ensureSession(state, one, 'look', time++), 'known');
    state = ensureSession(state, one, 'look', time++);
    const previous = state;
    state = respond(state, 'known');
    state = ensureSession(state, one, 'look', time++);
    state = undo(state, time++);
    expect(state.modes.look).toEqual(previous.modes.look);
    expect(state.modes.look.progress['word-0']?.streak).toBe(1);
    validated(state, one);
  });

  it('caps the non-recursive undo journal to the last 20 answers', () => {
    let state = initial();
    state = completeRemaining(state);
    state = ensureSession(state, words, 'look', time++);
    for (let i = 0; i < 5; i++) state = respond(state, 'known');
    expect(state.history).toHaveLength(20);
    expect(JSON.stringify(state.history)).not.toContain('"history"');
    for (let i = 0; i < 20; i++) state = undo(state, time++);
    expect(Object.keys(state.modes.look.progress)).toHaveLength(5);
    expect(undo(state, time++)).toBe(state);
    validated(state);
  });

  it('permanent skip is shared, does not count wrong, can be undone or restored', () => {
    let state = initial();
    state = ensureSession(state, words, 'listen', time++);
    const before = state;
    state = skipWord(state, 'look', getCurrentToken(state, 'look'), time++);
    expect(state.skipped).toEqual(['word-0']);
    expect(state.modes.look.progress).toEqual({});
    state = ensureSession(state, words, 'listen', time++);
    expect(getCurrentWord(state, 'listen', words)?.id).toBe('word-1');
    const undone = undo(state, time++);
    expect(undone.modes).toEqual(before.modes);
    expect(undone.skipped).toEqual([]);
    const restored = restoreSkipped(state, 'word-0', time++);
    expect(restored.skipped).toEqual([]);
    expect(restored.history).toHaveLength(0);
    validated(restored);
  });

  it('temporary audio skip advances only this group and returns in the next without adding counts', () => {
    const one = words.slice(0, 1);
    const before = initial(one, 'listen');
    let state = deferWord(before, 'listen', getCurrentToken(before, 'listen'), time++);
    expect(state.skipped).toEqual([]);
    expect(state.modes.listen.progress).toEqual({});
    expect(state.modes.listen.session).toMatchObject({ status: 'finished', skipped: 1, unknown: 0 });
    expect(undo(state, time++).modes.listen).toEqual(before.modes.listen);
    state = ensureSession(state, one, 'listen', time++);
    expect(getCurrentWord(state, 'listen', one)?.id).toBe('word-0');
    validated(state, one);
  });

  it('restart preserves past counts and requires two new recognitions', () => {
    const one = words.slice(0, 1);
    let state = respond(initial(one), 'known');
    state = restartWord(state, 'word-0', 'look', time++);
    expect(state.modes.look.progress['word-0']).toMatchObject({ rightCount: 1, status: 'learning', streak: 0 });
    state = respond(ensureSession(state, one, 'look', time++), 'known');
    expect(state.modes.look.progress['word-0']?.status).toBe('learning');
    state = respond(ensureSession(state, one, 'look', time++), 'known');
    expect(state.modes.look.progress['word-0']).toMatchObject({ rightCount: 3, status: 'completed' });
    validated(state, one);
  });
});

describe('external state validation', () => {
  it('defaults missing legacy schema v1 skip guidance to unseen without changing progress', () => {
    const state = respond(initial(), 'unknown');
    const legacy = JSON.parse(JSON.stringify(state)) as { settings: Record<string, unknown> };
    delete legacy.settings.skipHintSeen;
    const restored = parseAppState(legacy, words, VERSION);
    expect(restored.settings.skipHintSeen).toBe(false);
    expect(restored.modes).toEqual(state.modes);
    expect(restored.history).toEqual(state.history);
  });

  it('accepts real words whose identifiers match object prototype property names', () => {
    const fixtures = [{ ...words[0]!, id: 'constructor', word: 'constructor' }];
    let state = initial(fixtures);
    state = deferWord(state, 'look', getCurrentToken(state, 'look'), time++);
    validated(state, fixtures);
    state = undo(state, time++);
    state = respond(state, 'known');
    expect(state.modes.look.progress.constructor).toMatchObject({ rightCount: 1, status: 'completed' });
    validated(state, fixtures);
  });

  it('rejects version mismatches, invalid references, duplicate queue ids and inconsistent counters', () => {
    const state = respond(initial(), 'unknown');
    const badVersion = { ...state, dictionaryVersion: 'old-version' };
    expect(() => validated(badVersion)).toThrow();
    const bad = structuredClone(state);
    bad.modes.look.session!.items[0] = 'missing';
    expect(() => validated(bad)).toThrow();
    const repeated = structuredClone(state);
    repeated.modes.look.session!.items[1] = 'word-0';
    expect(() => validated(repeated)).toThrow();
    const count = structuredClone(state);
    count.modes.look.progress['word-0']!.wrongCount = 99;
    expect(() => validated(count)).toThrow();
    expect(() => parseWords([words[0], words[0]])).toThrow();
  });

  it('rejects corrupt undo snapshots instead of clearing the current state', () => {
    const state = respond(initial(), 'unknown');
    const original = JSON.stringify(state);
    const corrupt = structuredClone(state);
    corrupt.history[0]!.wordId = 'word-1';
    expect(() => validated(corrupt)).toThrow();
    expect(JSON.stringify(state)).toBe(original);
  });

  it('accepts deterministic mixed answer, skip, mode switch and undo sequences without mutating inputs', () => {
    let state = createInitialState(VERSION, time++);
    let seed = 41;
    for (let index = 0; index < 220; index++) {
      seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
      const mode = seed % 2 ? 'look' : 'listen';
      state = ensureSession(state, words, mode, time++);
      const before = JSON.stringify(state);
      const source = state;
      const token = getCurrentToken(state, mode);
      if (index % 13 === 0) state = undo(state, time++);
      else if (state.modes[mode].session?.revealed) state = next(state, mode);
      else if (index % 11 === 0) state = skipWord(state, mode, token, time++);
      else if (index % 7 === 0) state = deferWord(state, mode, token, time++);
      else state = respond(state, seed % 3 ? 'known' : 'unknown', mode);
      expect(JSON.stringify(source)).toBe(before);
      validated(state);
    }
  });
});
