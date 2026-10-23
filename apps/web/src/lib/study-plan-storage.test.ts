import { IDBFactory } from 'fake-indexeddb';
import { describe, expect, it } from 'vitest';
import { answer, checkInStudyPlan, createInitialState, ensureSession, ensureStudyPlanDay, getCurrentToken, getStudyPlanSummary, markStudyPlanCelebrated, nextWord, saveStudyPlan, undo, type AppState, type Word } from '../../../../packages/core/src';
import { exportBackup, openWordDatabase, parseBackup, StorageConflictError } from './storage';

const VERSION = 'study-plan-storage-test-v1';
const DAY_ONE = '2026-10-22'; const DAY_TWO = '2026-10-23'; const DAY_THREE = '2026-10-24';
const words: Word[] = ['abandon', 'ability', 'accurate'].map((id, rank) => ({ id, word: id, tags: ['ielts'], translation: '测试词义', phonetic: '', rank, basic: false }));
let now = Date.UTC(2026, 9, 22);
const summary = (state: AppState, date = DAY_ONE) => getStudyPlanSummary(state, words, 'ielts', 'look', date)!;
function reached() {
  let state = createInitialState(VERSION, now++);
  state = saveStudyPlan(state, words, { deck: 'ielts', mode: 'look', deadline: DAY_THREE }, now++, DAY_ONE);
  state = ensureSession(state, words, 'look', now++, DAY_ONE);
  return answer(state, 'look', 'known', getCurrentToken(state, 'look'), now++, DAY_ONE);
}

async function putRaw(factory: IDBFactory, name: string, value: unknown) {
  const connection = await new Promise<IDBDatabase>((resolve, reject) => { const request = factory.open(name); request.onsuccess = () => resolve(request.result); request.onerror = () => reject(request.error); });
  try {
    await new Promise<void>((resolve, reject) => {
      const tx = connection.transaction('state', 'readwrite'); tx.objectStore('state').put(value, 'current');
      tx.oncomplete = () => resolve(); tx.onabort = () => reject(tx.error);
    });
  } finally { connection.close(); }
}

describe('durable book plans and achievement receipts', () => {
  it('saves day creation, an answer, celebration claim and check-in as separate revision-plus-one transactions', async () => {
    const factory = new IDBFactory(); const db = await openWordDatabase('plan-transactions', factory);
    let state = createInitialState(VERSION, now++);
    const saveNext = async (next: AppState) => {
      expect(next.revision).toBe(state.revision + 1);
      await db.saveState(next, state.revision, words, VERSION); state = next;
    };
    try {
      await db.saveState(state, null, words, VERSION);
      await saveNext(saveStudyPlan(state, words, { deck: 'ielts', mode: 'look', deadline: DAY_THREE }, now++, DAY_ONE));
      await saveNext(ensureStudyPlanDay(state, words, 'ielts', 'look', now++, DAY_TWO));
      await saveNext(ensureSession(state, words, 'look', now++, DAY_TWO));
      await saveNext(answer(state, 'look', 'unknown', getCurrentToken(state, 'look'), now++, DAY_TWO));
      expect(summary(state, DAY_TWO)).toMatchObject({ newTarget: 2, newCompleted: 1, canCheckIn: false });
      // A new local date does not duplicate a day or save a no-op revision.
      expect(ensureStudyPlanDay(state, words, 'ielts', 'look', now++, DAY_TWO)).toBe(state);
      expect(markStudyPlanCelebrated(state, words, 'ielts', 'look', now++, DAY_TWO)).toBe(state);
      await saveNext(nextWord(state, 'look', getCurrentToken(state, 'look'), now++));
      await saveNext(answer(state, 'look', 'known', getCurrentToken(state, 'look'), now++, DAY_TWO));
      await saveNext(markStudyPlanCelebrated(state, words, 'ielts', 'look', now++, DAY_TWO));
      await saveNext(checkInStudyPlan(state, words, 'ielts', 'look', now++, DAY_TWO));
      expect(summary(state, DAY_TWO)).toMatchObject({ checkedIn: true, newCompleted: 2 });
      expect(Object.keys(state.studyPlans['ielts:look']!.days)).toEqual([DAY_ONE, DAY_TWO]);
      expect(state.studyPlans['ielts:look']!.days[DAY_ONE]?.newWordIds).toEqual([]);
      const expected = state;
      db.close();
      const reopened = await openWordDatabase('plan-transactions', factory);
      try {
        const actual = (await reopened.readState(words, VERSION))!;
        expect(actual).toEqual(expected);
        expect(markStudyPlanCelebrated(actual, words, 'ielts', 'look', now++, DAY_TWO)).toBe(actual);
      } finally { reopened.close(); }
    } finally { db.close(); }
  });

  it('retains plans, actual day records, check-in and celebration through a full backup into another database', async () => {
    let state = reached();
    state = markStudyPlanCelebrated(state, words, 'ielts', 'look', now++, DAY_ONE);
    state = checkInStudyPlan(state, words, 'ielts', 'look', now++, DAY_ONE);
    const factory = new IDBFactory(); const db = await openWordDatabase('plan-full-restore', factory);
    try {
      const backup = parseBackup(exportBackup(state, words, VERSION, now++), words, VERSION);
      const restored = await db.replaceStateFromBackup(backup, null, words, VERSION, now++);
      expect(restored.revision).toBe(0);
      expect(restored.studyPlans).toEqual(state.studyPlans);
      expect(restored.dailyActivity).toEqual(state.dailyActivity);
      expect(restored.history).toEqual(state.history);
      expect(summary(restored)).toMatchObject({ newCompleted: 1, checkedIn: true, celebratedAt: summary(state).celebratedAt });
      expect(markStudyPlanCelebrated(restored, words, 'ielts', 'look', now++, DAY_ONE)).toBe(restored);
    } finally { db.close(); }
  });

  it('defaults legacy database and backup plans to empty without manufacturing new-word dates', async () => {
    const factory = new IDBFactory(); const name = 'plan-legacy'; const db = await openWordDatabase(name, factory);
    let state = ensureSession(createInitialState(VERSION, now++), words, 'look', now++, DAY_ONE);
    state = answer(state, 'look', 'known', getCurrentToken(state, 'look'), now++, DAY_ONE);
    const legacy = JSON.parse(JSON.stringify(state)) as Record<string, unknown>; delete legacy.studyPlans;
    try {
      await putRaw(factory, name, legacy);
      const actual = (await db.readState(words, VERSION))!;
      expect(actual.studyPlans).toEqual({});
      expect(actual.dailyActivity).toEqual(state.dailyActivity);
      const text = JSON.stringify({ format: 'yanxai-word-backup', version: 1, exportedAt: now++, state: legacy });
      expect(parseBackup(text, words, VERSION).studyPlans).toEqual({});
      const planned = saveStudyPlan(actual, words, { deck: 'ielts', mode: 'look', deadline: DAY_THREE }, now++, DAY_ONE);
      await db.saveState(planned, actual.revision, words, VERSION);
      expect(summary(planned)).toMatchObject({ encounteredWords: 1, newCompleted: 0 });
    } finally { db.close(); }
  });

  it('allows one same-day check-in to win concurrent CAS and rejects blind saving of a no-op', async () => {
    const factory = new IDBFactory(); const first = await openWordDatabase('plan-two-tabs', factory); const second = await openWordDatabase('plan-two-tabs', factory);
    try {
      const state = await first.replaceStateFromBackup(reached(), null, words, VERSION, now++);
      const firstCheck = checkInStudyPlan(state, words, 'ielts', 'look', now++, DAY_ONE);
      const secondCheck = checkInStudyPlan(state, words, 'ielts', 'look', now++, DAY_ONE);
      const results = await Promise.allSettled([first.saveState(firstCheck, state.revision, words, VERSION), second.saveState(secondCheck, state.revision, words, VERSION)]);
      expect(results.filter(result => result.status === 'fulfilled')).toHaveLength(1);
      const rejected = results.find(result => result.status === 'rejected');
      expect(rejected?.status === 'rejected' && rejected.reason).toBeInstanceOf(StorageConflictError);
      const actual = (await first.readState(words, VERSION))!;
      expect(actual.revision).toBe(state.revision + 1);
      expect(summary(actual)).toMatchObject({ newCompleted: 1, checkedIn: true });
      expect(actual.dailyActivity).toEqual(state.dailyActivity);
      const noOp = checkInStudyPlan(actual, words, 'ielts', 'look', now++, DAY_ONE);
      expect(noOp).toBe(actual);
      await expect(first.saveState(noOp, actual.revision, words, VERSION)).rejects.toThrow(/invalid revision/);
    } finally { first.close(); second.close(); }
  });

  it('persists undo accurately and preserves it when a stale backup restore loses CAS', async () => {
    const factory = new IDBFactory(); const db = await openWordDatabase('plan-undo-restore', factory);
    let checked = reached();
    checked = markStudyPlanCelebrated(checked, words, 'ielts', 'look', now++, DAY_ONE);
    checked = checkInStudyPlan(checked, words, 'ielts', 'look', now++, DAY_ONE);
    try {
      const state = await db.replaceStateFromBackup(checked, null, words, VERSION, now++);
      const undone = undo(state, now++); await db.saveState(undone, state.revision, words, VERSION);
      expect(summary(undone)).toMatchObject({ newCompleted: 0, checkedIn: false, celebratedAt: summary(checked).celebratedAt });
      await expect(db.replaceStateFromBackup(checked, state.revision, words, VERSION, now++)).rejects.toBeInstanceOf(StorageConflictError);
      expect((await db.readState(words, VERSION))?.studyPlans).toEqual(undone.studyPlans);
      const restored = await db.replaceStateFromBackup(checked, undone.revision, words, VERSION, now++);
      expect(restored.revision).toBe(undone.revision + 1);
      expect(restored.studyPlans).toEqual(checked.studyPlans);
    } finally { db.close(); }
  });

  it('rejects corrupt plan data before replacing an existing saved record', async () => {
    const factory = new IDBFactory(); const db = await openWordDatabase('plan-corrupt', factory);
    try {
      const state = await db.replaceStateFromBackup(reached(), null, words, VERSION, now++);
      const corrupt = structuredClone(state); corrupt.studyPlans['ielts:look']!.scopeIds.push('missing-word');
      await expect(db.replaceStateFromBackup(corrupt, state.revision, words, VERSION, now++)).rejects.toThrow(/找不到词条/);
      expect(await db.readState(words, VERSION)).toEqual(state);
    } finally { db.close(); }
  });
});
