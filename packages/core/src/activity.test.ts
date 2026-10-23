import { describe, expect, it } from 'vitest';
import { getDailyStudySummary, getLocalDateKey, getStudyCalendar } from './activity';
import { answer, createInitialState, deferWord, ensureSession, getCurrentToken, nextWord, skipWord, undo } from './engine';
import { parseAppState } from './schemas';
import type { AppState, Mode, Word } from './types';

const VERSION = 'calendar-test-v1';
const words: Word[] = ['ability', 'accurate'].map((word, rank) => ({ id: word, word, rank, translation: 'n. 测试释义', phonetic: '', tags: [], basic: false }));
const one = words.slice(0, 1);
const DAY_ONE = '2026-10-21';
const DAY_TWO = '2026-10-22';
let time = Date.UTC(2026, 9, 22);
function start(state = createInitialState(VERSION, time++), mode: Mode = 'look', dictionary = one) {
  return ensureSession(state, dictionary, mode, time++);
}
function respond(state: AppState, result: 'known' | 'unknown', date = DAY_ONE, mode: Mode = 'look') {
  return answer(state, mode, result, getCurrentToken(state, mode), time++, date);
}
function advance(state: AppState, mode: Mode = 'look') {
  return nextWord(state, mode, getCurrentToken(state, mode), time++);
}
function validate(state: AppState, dictionary = one) {
  return parseAppState(JSON.parse(JSON.stringify(state)), dictionary, VERSION);
}

describe('local calendar activity', () => {
  it('uses the explicitly supplied timezone offset at midnight without reading a clock', () => {
    const beforeMidnight = Date.UTC(2026, 9, 22, 6, 59, 59);
    expect(getLocalDateKey(beforeMidnight, 420)).toBe(DAY_ONE);
    expect(getLocalDateKey(beforeMidnight + 1_000, 420)).toBe(DAY_TWO);
    expect(getLocalDateKey(beforeMidnight, -480)).toBe(DAY_TWO);
    expect(getLocalDateKey(Date.UTC(2024, 1, 29), 0)).toBe('2024-02-29');
    expect(() => getLocalDateKey(Number.NaN)).toThrow();
    expect(() => getLocalDateKey(beforeMidnight, 1_441)).toThrow();
  });

  it('counts one word per day across repeated encounters and both independent modes', () => {
    let state = respond(start(), 'unknown');
    state = respond(start(advance(state)), 'known');
    state = respond(start(state, 'listen'), 'known', DAY_ONE, 'listen');
    expect(state.dailyActivity[DAY_ONE]?.ability).toEqual({ look: { known: 1, unknown: 1 }, listen: { known: 1, unknown: 0 } });
    expect(getDailyStudySummary(state, DAY_ONE)).toEqual({
      date: DAY_ONE, wordCount: 1, known: 2, unknown: 1,
      words: [{ wordId: 'ability', known: 2, unknown: 1, modes: ['look', 'listen'] }],
    });
    expect(getStudyCalendar(state)).toEqual([{ date: DAY_ONE, wordCount: 1, known: 2, unknown: 1 }]);
    validate(state);
  });

  it('records the same reviewed word on each actual day and undo removes only its latest day', () => {
    let state = respond(start(), 'unknown');
    state = respond(start(advance(state)), 'known', DAY_TWO);
    expect(getStudyCalendar(state).map(day => [day.date, day.wordCount])).toEqual([[DAY_ONE, 1], [DAY_TWO, 1]]);
    state = undo(validate(state), time++);
    expect(state.dailyActivity[DAY_TWO]).toBeUndefined();
    expect(state.dailyActivity[DAY_ONE]?.ability?.look).toEqual({ known: 0, unknown: 1 });
    expect(state.modes.look.progress.ability).toMatchObject({ wrongCount: 1, rightCount: 0 });
    validate(state);
  });

  it('undo restores another mode and a previous answer on the same day without changing the input', () => {
    const before = respond(start(), 'unknown');
    const switched = start(before, 'listen');
    const serialized = JSON.stringify(switched);
    const answered = respond(switched, 'known', DAY_ONE, 'listen');
    expect(JSON.stringify(switched)).toBe(serialized);
    expect(undo(validate(answered), time++).dailyActivity).toEqual(before.dailyActivity);
    const emptied = undo(undo(answered, time++), time++);
    expect(emptied.dailyActivity).toEqual({});
    validate(emptied);
  });

  it('does not count navigation, permanent skips, temporary audio skips, or stale double taps', () => {
    const original = start(undefined, 'look', words);
    const staleToken = getCurrentToken(original, 'look');
    let state = respond(original, 'unknown');
    expect(answer(state, 'look', 'unknown', staleToken, time++, DAY_ONE)).toBe(state);
    const activity = JSON.stringify(state.dailyActivity);
    state = advance(state);
    state = skipWord(state, 'look', getCurrentToken(state, 'look'), time++);
    state = start(state, 'listen', words);
    state = deferWord(state, 'listen', getCurrentToken(state, 'listen'), time++);
    expect(JSON.stringify(state.dailyActivity)).toBe(activity);
    validate(state, words);
    expect(undo(state, time++).dailyActivity).toEqual(state.dailyActivity);
  });

  it('accepts old schema v1 progress and undo entries without inventing calendar history', () => {
    const answered = advance(respond(start(undefined, 'look', words), 'unknown'));
    const legacy = JSON.parse(JSON.stringify(answered)) as Record<string, unknown>;
    delete legacy.dailyActivity;
    for (const entry of legacy.history as Record<string, unknown>[]) {
      delete entry.activityDate;
      delete entry.previousDailyActivity;
    }
    const restored = parseAppState(legacy, words, VERSION);
    expect(restored.modes).toEqual(answered.modes);
    expect(restored.dailyActivity).toEqual({});
    expect(getStudyCalendar(restored)).toEqual([]);
    const updated = respond(restored, 'known', DAY_TWO);
    expect(getDailyStudySummary(updated, DAY_TWO).words.map(word => word.wordId)).toEqual(['accurate']);
    const undoneNew = undo(validate(updated, words), time++);
    expect(undoneNew.dailyActivity).toEqual({});
    const undoneLegacy = undo(undoneNew, time++);
    expect(undoneLegacy.dailyActivity).toEqual({});
    expect(undoneLegacy.modes.look.progress).toEqual({});
    validate(undoneLegacy, words);
  });

  it('rejects invalid dates, nonexistent words, impossible totals and forged calendar undo deltas', () => {
    const state = respond(start(), 'unknown');
    expect(() => respond(start(), 'known', '2026-02-30')).toThrow(/date/i);
    const invalidDate = structuredClone(state);
    invalidDate.dailyActivity['2026-02-30'] = invalidDate.dailyActivity[DAY_ONE]!;
    delete invalidDate.dailyActivity[DAY_ONE];
    expect(() => validate(invalidDate)).toThrow();
    const missingWord = structuredClone(state);
    missingWord.dailyActivity[DAY_ONE]!.missing = missingWord.dailyActivity[DAY_ONE]!.ability!;
    expect(() => validate(missingWord)).toThrow();
    const forgedTotal = structuredClone(state);
    forgedTotal.dailyActivity[DAY_ONE]!.ability!.look.unknown += 1;
    expect(() => validate(forgedTotal)).toThrow();
    const forgedUndo = structuredClone(state);
    forgedUndo.history[0]!.previousDailyActivity = { look: { known: 0, unknown: 1 }, listen: { known: 0, unknown: 0 } };
    expect(() => validate(forgedUndo)).toThrow();
    const omittedDate = structuredClone(state);
    delete omittedDate.history[0]!.activityDate;
    expect(() => validate(omittedDate)).toThrow();
  });

  it('retains older real day totals when the bounded undo journal expires', () => {
    const dictionary: Word[] = Array.from({ length: 25 }, (_, rank) => ({ ...words[0]!, id: `word-${rank}`, rank }));
    let state = start(undefined, 'look', dictionary);
    for (let index = 0; index < 25; index++) {
      state = start(state, 'look', dictionary);
      state = respond(state, 'known');
    }
    expect(getDailyStudySummary(state, DAY_ONE).wordCount).toBe(25);
    for (let index = 0; index < 20; index++) state = undo(state, time++);
    expect(getDailyStudySummary(state, DAY_ONE).wordCount).toBe(5);
    expect(state.history).toHaveLength(0);
    validate(state, dictionary);
  });
});
