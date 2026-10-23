import { describe, expect, it } from 'vitest';
import { getYesterdayReviewSummary, previousLocalDateKey } from './daily-review';
import { answer, createInitialState, deferWord, ensureSession, getCurrentToken, nextWord, skipWord, undo, updateSettings } from './engine';
import { parseAppState } from './schemas';
import type { AppState, Mode, Word } from './types';

const VERSION = 'daily-review-test-v1';
const DAY_ONE = '2026-10-21';
const DAY_TWO = '2026-10-22';
const DAY_THREE = '2026-10-23';
const words: Word[] = ['ability', 'accurate'].map((word, rank) => ({ id: word, word, rank, translation: 'n. 测试释义', phonetic: '', tags: ['cet4'], basic: false }));
const one = words.slice(0, 1);
let time = Date.UTC(2026, 9, 21);
function start(state = createInitialState(VERSION, time++), date = DAY_ONE, dictionary = one, mode: Mode = 'look') {
  return ensureSession(state, dictionary, mode, time++, date);
}
function respond(state: AppState, result: 'known' | 'unknown', date = DAY_ONE, mode: Mode = 'look') {
  return answer(state, mode, result, getCurrentToken(state, mode), time++, date);
}
function advance(state: AppState, mode: Mode = 'look') { return nextWord(state, mode, getCurrentToken(state, mode), time++); }
function validate(state: AppState, dictionary = one) { return parseAppState(JSON.parse(JSON.stringify(state)), dictionary, VERSION); }
function yesterdayCompleted() {
  let state = advance(respond(start(), 'unknown'));
  state = respond(start(state), 'known');
  return respond(start(state), 'known');
}

describe('yesterday mistakes checked again today', () => {
  it('uses calendar dates across month, leap-day and year boundaries', () => {
    expect(previousLocalDateKey('2026-01-01')).toBe('2025-12-31');
    expect(previousLocalDateKey('2024-03-01')).toBe('2024-02-29');
    expect(previousLocalDateKey('2026-03-01')).toBe('2026-02-28');
    expect(() => previousLocalDateKey('2026-02-30')).toThrow();
  });

  it('checks a word completed after yesterday mistake once today without resetting its progress', () => {
    const before = yesterdayCompleted();
    expect(before.modes.look.progress.ability).toMatchObject({ status: 'completed', rightCount: 2 });
    expect(getYesterdayReviewSummary(before, DAY_TWO).look).toEqual({ total: 1, queued: 0, completed: 0, pending: 1, available: 1 });
    const queued = start(before, DAY_TWO);
    expect(queued.modes.look.session?.items).toEqual(['ability']);
    expect(queued.modes.look.progress).toEqual(before.modes.look.progress);
    expect(queued.dailyReview[DAY_TWO]?.look.ability).toMatchObject({ completed: false });
    expect(start(queued, DAY_TWO)).toBe(queued);
    const checked = respond(validate(queued), 'known', DAY_TWO);
    expect(checked.dailyReview[DAY_TWO]?.look.ability?.completed).toBe(true);
    expect(checked.modes.look.progress.ability).toMatchObject({ status: 'completed', rightCount: 3, wrongCount: 1 });
    expect(start(checked, DAY_TWO).modes.look.session?.items).toEqual([]);
    expect(getYesterdayReviewSummary(checked, DAY_TWO).look).toEqual({ total: 1, queued: 1, completed: 1, pending: 0, available: 0 });
    validate(checked);
  });

  it('deduplicates repeated mistakes per mode and excludes permanently skipped words', () => {
    let state = advance(respond(start(), 'unknown'));
    state = advance(respond(start(state), 'unknown'));
    state = start(state, DAY_ONE, one, 'listen');
    state = advance(respond(state, 'unknown', DAY_ONE, 'listen'), 'listen');
    expect(getYesterdayReviewSummary(state, DAY_TWO).look.total).toBe(1);
    expect(getYesterdayReviewSummary(state, DAY_TWO).listen.total).toBe(1);
    state = start(state, DAY_TWO);
    state = skipWord(state, 'look', getCurrentToken(state, 'look'), time++);
    expect(getYesterdayReviewSummary(state, DAY_TWO).look.total).toBe(0);
    expect(getYesterdayReviewSummary(state, DAY_TWO).listen.total).toBe(0);
    validate(state);
  });

  it('leaves an active group unchanged and applies the due priority only to the next group', () => {
    let state = advance(respond(start(undefined, DAY_ONE, words), 'unknown'));
    const active = state;
    expect(start(state, DAY_TWO, words)).toBe(active);
    expect(state.dailyReview).toEqual({});
    expect(getYesterdayReviewSummary(state, DAY_TWO).look.available).toBe(1);
    state = respond(state, 'known', DAY_TWO);
    state = start(state, DAY_TWO, words);
    expect(state.modes.look.session?.items).toEqual(['ability']);
    expect(state.dailyReview[DAY_TWO]?.look.ability?.completed).toBe(false);
    validate(state, words);
  });

  it('retains the two-known learning rule after a failed check and makes today mistakes due tomorrow', () => {
    let state = start(yesterdayCompleted(), DAY_TWO);
    state = advance(respond(state, 'unknown', DAY_TWO));
    expect(state.modes.look.progress.ability).toMatchObject({ status: 'learning', streak: 0, wrongCount: 2 });
    state = respond(start(state, DAY_TWO), 'known', DAY_TWO);
    expect(state.modes.look.progress.ability).toMatchObject({ status: 'learning', streak: 1 });
    state = respond(start(state, DAY_TWO), 'known', DAY_TWO);
    expect(state.modes.look.progress.ability).toMatchObject({ status: 'completed', streak: 2 });
    expect(getYesterdayReviewSummary(state, DAY_TWO).look.queued).toBe(1);
    const tomorrow = start(state, DAY_THREE);
    expect(tomorrow.modes.look.session?.items).toEqual(['ability']);
    expect(tomorrow.dailyReview[DAY_THREE]?.look.ability?.completed).toBe(false);
    validate(tomorrow);
  });

  it('counts a real answer in a carried-over active group as today check without reinserting it', () => {
    let state = advance(respond(start(), 'unknown'));
    state = respond(start(state), 'known');
    const yesterdayActive = start(state);
    expect(start(yesterdayActive, DAY_TWO)).toBe(yesterdayActive);
    const checked = respond(yesterdayActive, 'known', DAY_TWO);
    expect(checked.dailyReview[DAY_TWO]?.look.ability).toEqual({ groupNumber: yesterdayActive.modes.look.groupNumber, completed: true });
    expect(start(checked, DAY_TWO).modes.look.session?.items).toEqual([]);
    const restored = undo(validate(checked), time++);
    expect(restored.dailyReview).toEqual({});
    expect(restored.modes).toEqual(yesterdayActive.modes);
    validate(restored);
  });

  it('completes an original queue after midnight and undo restores its precise completion flag', () => {
    const queued = start(yesterdayCompleted(), DAY_TWO);
    const checked = respond(queued, 'known', DAY_THREE);
    expect(checked.dailyReview[DAY_TWO]?.look.ability?.completed).toBe(true);
    expect(checked.dailyReview[DAY_THREE]).toBeUndefined();
    const restored = undo(validate(checked), time++);
    expect(restored.dailyReview).toEqual(queued.dailyReview);
    expect(restored.dailyActivity).toEqual(queued.dailyActivity);
    expect(restored.modes).toEqual(queued.modes);
    validate(restored);
  });

  it('undo removes reservations in groups rewound after yesterday final answer', () => {
    const yesterday = advance(respond(start(), 'unknown'));
    const today = start(yesterday, DAY_TWO);
    expect(today.dailyReview[DAY_TWO]).toBeDefined();
    const restored = undo(validate(today), time++);
    expect(restored.dailyReview).toEqual({});
    expect(restored.dailyActivity).toEqual({});
    validate(restored);
  });

  it('does not turn a temporary audio skip into a completed check or reinsert it automatically', () => {
    const queued = start(yesterdayCompleted(), DAY_TWO);
    const deferred = deferWord(queued, 'look', getCurrentToken(queued, 'look'), time++);
    expect(deferred.dailyReview[DAY_TWO]?.look.ability?.completed).toBe(false);
    expect(deferred.modes.look.progress).toEqual(queued.modes.look.progress);
    expect(deferred.dailyActivity).toEqual(queued.dailyActivity);
    expect(start(deferred, DAY_TWO).modes.look.session?.items).toEqual([]);
    expect(getYesterdayReviewSummary(deferred, DAY_TWO).look).toMatchObject({ pending: 1, available: 0 });
    validate(deferred);
  });

  it('prioritizes due words, preserves fresh-word capacity and does not consume unselected fresh words', () => {
    const dictionary: Word[] = Array.from({ length: 13 }, (_, rank) => ({ ...words[0]!, id: rank ? `fresh-${rank}` : 'ability', rank }));
    const seeded = updateSettings(yesterdayCompleted(), { groupSize: 10 }, time++);
    let state = start(seeded, DAY_TWO, dictionary);
    expect(state.modes.look.session?.items).toHaveLength(10);
    expect(state.modes.look.session?.items[0]).toBe('ability');
    expect(state.modes.look.progress['fresh-10']).toBeUndefined();
    for (let index = 0; index < 10; index++) state = respond(state, 'known', DAY_TWO);
    state = start(state, DAY_TWO, dictionary);
    expect(state.modes.look.session?.items).toEqual(['fresh-10', 'fresh-11', 'fresh-12']);
    validate(state, dictionary);
  });

  it('accepts old schema v1 backups without inventing queued or completed review markers', () => {
    const original = yesterdayCompleted();
    const legacy = JSON.parse(JSON.stringify(original)) as Record<string, unknown>;
    delete legacy.dailyReview;
    const restored = parseAppState(legacy, one, VERSION);
    expect(restored.dailyReview).toEqual({});
    expect(restored.modes).toEqual(original.modes);
    expect(getYesterdayReviewSummary(restored, DAY_TWO).look.available).toBe(1);
  });

  it('preserves queues and completion flags through IndexedDB CAS and backup restore', async () => {
    const { IDBFactory } = await import('fake-indexeddb');
    const { exportBackup, openWordDatabase, parseBackup, StorageConflictError } = await import('../../../apps/web/src/lib/storage');
    const queued = start(yesterdayCompleted(), DAY_TWO);
    const db = await openWordDatabase('isolated-daily-review-test', new IDBFactory());
    try {
      const restored = await db.replaceStateFromBackup(parseBackup(exportBackup(queued, one, VERSION, time++), one, VERSION), null, one, VERSION, time++);
      expect(restored.dailyReview).toEqual(queued.dailyReview);
      const checked = respond(restored, 'unknown', DAY_TWO);
      await db.saveState(checked, 0, one, VERSION);
      await expect(db.saveState(checked, 0, one, VERSION)).rejects.toBeInstanceOf(StorageConflictError);
      expect((await db.readState(one, VERSION))?.dailyReview).toEqual(checked.dailyReview);
    } finally { db.close(); }
  });

  it('rejects forged review sources, future groups and inconsistent undo completion flags', () => {
    const checked = respond(start(yesterdayCompleted(), DAY_TWO), 'known', DAY_TWO);
    const source = structuredClone(checked);
    source.dailyReview[DAY_ONE] = source.dailyReview[DAY_TWO]!;
    expect(() => validate(source)).toThrow();
    const future = structuredClone(checked);
    future.dailyReview[DAY_TWO]!.look.ability!.groupNumber += 5;
    expect(() => validate(future)).toThrow();
    const completion = structuredClone(checked);
    completion.dailyReview[DAY_TWO]!.look.ability!.completed = false;
    expect(() => validate(completion)).toThrow();
  });
});
