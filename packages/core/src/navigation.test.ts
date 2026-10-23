import { describe, expect, it } from 'vitest';
import { answer, createInitialState, deferWord, ensureSession, getCurrentToken, nextWord, restartWord, skipWord, undo } from './engine';
import { getStudyHistoryEntry, getStudyTrail, MAX_STUDY_TRAIL, moveStudyHistoryOffset } from './navigation';
import { parseAppState } from './schemas';
import type { AppState, Mode, Word } from './types';

const VERSION = 'navigation-test-v1';
const words: Word[] = ['ability', 'accurate', 'acquire'].map((word, rank) => ({ id: word, word, rank, translation: 'n. 测试释义', phonetic: '', tags: [], basic: false }));
let time = Date.UTC(2026, 9, 23);
function start(state = createInitialState(VERSION, time++), dictionary = words, mode: Mode = 'look') {
  return ensureSession(state, dictionary, mode, time++);
}
function respond(state: AppState, result: 'known' | 'unknown', mode: Mode = 'look') {
  return answer(state, mode, result, getCurrentToken(state, mode), time++);
}
function advance(state: AppState, mode: Mode = 'look') {
  return nextWord(state, mode, getCurrentToken(state, mode), time++);
}
function validate(state: AppState, dictionary = words) {
  return parseAppState(JSON.parse(JSON.stringify(state)), dictionary, VERSION);
}

describe('read-only learning navigation', () => {
  it('records a known answer once as it advances and bounds browsing at the live word', () => {
    const before = start();
    const token = getCurrentToken(before, 'look');
    const state = answer(before, 'look', 'known', token, time++);
    expect(state.studyTrail).toEqual([{
      id: state.revision, mode: 'look', wordId: 'ability', groupNumber: 1, position: 0,
      action: 'known', revealed: true, recordedAt: state.updatedAt,
    }]);
    expect(answer(state, 'look', 'known', token, time++)).toBe(state);
    expect(getStudyHistoryEntry(state, 'look', 0)).toBeUndefined();
    expect(getStudyHistoryEntry(state, 'look', 1)?.wordId).toBe('ability');
    expect(getStudyHistoryEntry(state, 'look', 2)).toBeUndefined();
    expect(moveStudyHistoryOffset(state, 'look', 0, 'previous')).toBe(1);
    expect(moveStudyHistoryOffset(state, 'look', 1, 'previous')).toBe(1);
    expect(moveStudyHistoryOffset(state, 'look', 1, 'next')).toBe(0);
    expect(moveStudyHistoryOffset(state, 'look', 0, 'next')).toBe(0);
    expect(state.modes.look.session?.cursor).toBe(1);
    expect(before.studyTrail).toEqual([]);
    validate(state);
  });

  it('excludes the live revealed unknown until nextWord and does not record navigation twice', () => {
    let state = respond(respond(start(), 'known'), 'unknown');
    expect(state.studyTrail).toHaveLength(2);
    expect(getStudyTrail(state, 'look').map(item => item.wordId)).toEqual(['ability']);
    expect(getStudyHistoryEntry(state, 'look', 1)?.wordId).toBe('ability');
    expect(state.modes.look.session).toMatchObject({ cursor: 1, revealed: true });
    state = advance(validate(state));
    expect(state.studyTrail).toHaveLength(2);
    expect(getStudyHistoryEntry(state, 'look', 1)).toMatchObject({ wordId: 'accurate', action: 'unknown', revealed: true });
    expect(getStudyHistoryEntry(state, 'look', 2)?.wordId).toBe('ability');
    expect(state.modes.look.progress.accurate?.wrongCount).toBe(1);
  });

  it('retains exact encounters across group completion, repeated reviews, refresh and mode switches', () => {
    const dictionary = words.slice(0, 1);
    let state = advance(respond(start(undefined, dictionary), 'unknown'));
    expect(getStudyHistoryEntry(state, 'look', 1)).toMatchObject({ groupNumber: 1, action: 'unknown' });
    state = respond(start(state, dictionary), 'known');
    state = respond(start(state, dictionary, 'listen'), 'known', 'listen');
    const restored = validate(state, dictionary);
    expect(getStudyTrail(restored, 'look').map(item => [item.groupNumber, item.action])).toEqual([[1, 'unknown'], [2, 'known']]);
    expect(getStudyTrail(restored, 'listen').map(item => [item.groupNumber, item.action])).toEqual([[1, 'known']]);
    const serialized = JSON.stringify(restored);
    for (let index = 0, offset = 0; index < 20; index++) {
      offset = moveStudyHistoryOffset(restored, 'look', offset, index % 3 ? 'previous' : 'next');
      getStudyHistoryEntry(restored, 'look', offset);
    }
    expect(JSON.stringify(restored)).toBe(serialized);
    expect(restored.dailyActivity).toEqual(state.dailyActivity);
    expect(restored.history).toEqual(state.history);
  });

  it('records permanent and temporary skips honestly without adding answer or calendar counts', () => {
    let state = start();
    state = skipWord(state, 'look', getCurrentToken(state, 'look'), time++);
    state = deferWord(state, 'look', getCurrentToken(state, 'look'), time++);
    expect(state.studyTrail.map(item => [item.wordId, item.action, item.revealed])).toEqual([
      ['ability', 'skip', false], ['accurate', 'defer', false],
    ]);
    expect(state.dailyActivity).toEqual({});
    expect(state.modes.look.progress).toEqual({});
    expect(validate(state).studyTrail).toEqual(state.studyTrail);
    state = undo(state, time++);
    expect(state.studyTrail.map(item => item.action)).toEqual(['skip']);
    state = undo(state, time++);
    expect(state.studyTrail).toEqual([]);
  });

  it('undo removes the real encounter while preserving earlier encounters and their answer totals', () => {
    const before = respond(start(), 'known');
    const answered = respond(before, 'unknown');
    const restored = undo(advance(validate(answered)), time++);
    expect(restored.studyTrail).toEqual(before.studyTrail);
    expect(restored.modes).toEqual(before.modes);
    expect(restored.dailyActivity).toEqual(before.dailyActivity);
    validate(restored);
  });

  it('does not invent trail entries from old progress or legacy undo snapshots', () => {
    const answered = respond(start(), 'known');
    const legacy = JSON.parse(JSON.stringify(answered)) as Record<string, unknown>;
    delete legacy.studyTrail;
    for (const entry of legacy.history as Record<string, unknown>[]) {
      delete entry.studyTrailId;
      delete entry.evictedStudyTrailEntry;
    }
    let restored = parseAppState(legacy, words, VERSION);
    expect(restored.studyTrail).toEqual([]);
    expect(restored.modes).toEqual(answered.modes);
    restored = respond(restored, 'unknown');
    expect(restored.studyTrail).toHaveLength(1);
    restored = undo(restored, time++);
    expect(restored.studyTrail).toEqual([]);
    restored = undo(restored, time++);
    expect(restored.studyTrail).toEqual([]);
    expect(restored.modes.look.progress).toEqual({});
    validate(restored);
  });

  it('caps retained encounters at 1000 and undo restores the exact evicted oldest entry', () => {
    const dictionary = words.slice(0, 1);
    let state = start(undefined, dictionary);
    for (let index = 0; index < MAX_STUDY_TRAIL; index++) {
      state = deferWord(state, 'look', getCurrentToken(state, 'look'), time++);
      state = start(state, dictionary);
    }
    const before = state.studyTrail;
    expect(before).toHaveLength(MAX_STUDY_TRAIL);
    state = deferWord(state, 'look', getCurrentToken(state, 'look'), time++);
    expect(state.studyTrail).toHaveLength(MAX_STUDY_TRAIL);
    expect(state.studyTrail[0]).toEqual(before[1]);
    expect(state.history.at(-1)?.evictedStudyTrailEntry).toEqual(before[0]);
    const restored = undo(validate(state, dictionary), time++);
    expect(restored.studyTrail).toEqual(before);
    validate(restored, dictionary);
    expect(moveStudyHistoryOffset(restored, 'look', MAX_STUDY_TRAIL + 200, 'previous')).toBe(MAX_STUDY_TRAIL);
  });

  it('keeps earlier read-only history when a completed word is explicitly restarted', () => {
    let state = respond(start(), 'known');
    const before = state.studyTrail;
    state = restartWord(state, 'ability', 'look', time++);
    expect(state.studyTrail).toEqual(before);
    expect(state.history).toEqual([]);
    validate(state);
  });

  it('restores a high-revision backup into a fresh database and keeps new encounter ids unique', async () => {
    const { IDBFactory } = await import('fake-indexeddb');
    const { exportBackup, openWordDatabase, parseBackup } = await import('../../../apps/web/src/lib/storage');
    const source = respond(start(), 'known');
    const backup = parseBackup(exportBackup(source, words, VERSION, time++), words, VERSION);
    const db = await openWordDatabase('isolated-navigation-backup-test', new IDBFactory());
    try {
      const restored = await db.replaceStateFromBackup(backup, null, words, VERSION, time++);
      expect(restored.revision).toBe(0);
      expect(restored.studyTrail).toEqual(source.studyTrail);
      const updated = respond(restored, 'known');
      expect(updated.studyTrail[1]!.id).toBeGreaterThan(updated.studyTrail[0]!.id);
      await db.saveState(updated, 0, words, VERSION);
      expect((await db.readState(words, VERSION))?.studyTrail).toEqual(updated.studyTrail);
      const undone = undo(updated, time++);
      expect(undone.studyTrail).toEqual(source.studyTrail);
      await db.saveState(undone, updated.revision, words, VERSION);
    } finally { db.close(); }
  });

  it('rejects invalid trail references, forged counts, order and undo links', () => {
    const answered = respond(start(), 'known');
    const missing = structuredClone(answered);
    missing.studyTrail[0]!.wordId = 'missing';
    expect(() => validate(missing)).toThrow();
    const duplicate = structuredClone(answered);
    duplicate.studyTrail.push({ ...duplicate.studyTrail[0]! });
    expect(() => validate(duplicate)).toThrow();
    const forgedCount = structuredClone(answered);
    forgedCount.studyTrail[0]!.action = 'unknown';
    expect(() => validate(forgedCount)).toThrow();
    const forgedUndo = structuredClone(answered);
    forgedUndo.history[0]!.studyTrailId! += 1;
    expect(() => validate(forgedUndo)).toThrow();
    const forgedReveal = structuredClone(answered);
    forgedReveal.studyTrail[0]!.revealed = false;
    expect(() => validate(forgedReveal)).toThrow();
  });
});
