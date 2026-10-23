import { describe, expect, it } from 'vitest';
import { answer, createInitialState, ensureSession, getCurrentToken, nextWord, skipWord, undo, updateSettings } from './engine';
import { checkInStudyPlan, ensureStudyPlanDay, getStudyPlanSummary, markStudyPlanCelebrated, saveStudyPlan, studyPlanKey } from './study-plan';
import { parseAppState } from './schemas';
import type { AppState, Deck, Mode, Word } from './types';

const VERSION = 'plan-test-v1';
const DAY_ONE = '2026-10-22'; const DAY_TWO = '2026-10-23'; const DAY_THREE = '2026-10-24';
const words: Word[] = [
  ['ielts-one', ['ielts']], ['cet-four', ['cet4']], ['ielts-two', ['ielts']],
  ['shared', ['ielts', 'cet4']], ['basic', ['ielts']],
].map(([id, tags], rank) => ({ id: id as string, word: id as string, translation: '测试词义', phonetic: '', tags: tags as string[], rank, basic: id === 'basic' }));
let time = Date.UTC(2026, 9, 22);
const initial = () => createInitialState(VERSION, time++);
const start = (state: AppState, today = DAY_ONE, mode: Mode = 'look', dictionary = words) => ensureSession(state, dictionary, mode, time++, today);
const respond = (state: AppState, result: 'known' | 'unknown' = 'known', today = DAY_ONE, mode: Mode = 'look') => answer(state, mode, result, getCurrentToken(state, mode), time++, today);
const advance = (state: AppState, mode: Mode = 'look') => nextWord(state, mode, getCurrentToken(state, mode), time++);
const save = (state: AppState, today = DAY_ONE, deadline = DAY_THREE, deck: Deck = 'ielts', mode: Mode = 'look', dictionary = words) => saveStudyPlan(state, dictionary, { deck, mode, deadline }, time++, today);
const summary = (state: AppState, today = DAY_ONE, deck: Deck = 'ielts', mode: Mode = 'look') => getStudyPlanSummary(state, words, deck, mode, today)!;
const validate = (state: AppState, dictionary = words) => parseAppState(JSON.parse(JSON.stringify(state)), dictionary, VERSION);
function finishGroup(state: AppState, today = DAY_ONE, mode: Mode = 'look') {
  while (state.modes[mode].session?.status === 'active') state = state.modes[mode].session?.revealed ? advance(state, mode) : respond(state, 'known', today, mode);
  return state;
}

describe('real book learning plans', () => {
  it('uses inclusive dates, a real book/basic snapshot, and a fixed daily quota', () => {
    let state = save(initial());
    expect(summary(state)).toMatchObject({ totalWords: 3, remainingNewWords: 3, totalDays: 3, remainingDays: 3, newTarget: 1, newCompleted: 0, remainingToday: 1 });
    state = respond(start(state));
    expect(summary(state)).toMatchObject({ newTarget: 1, newCompleted: 1, remainingNewWords: 2, canCheckIn: true });
    expect(ensureStudyPlanDay(state, words, 'ielts', 'look', time++, DAY_ONE)).toBe(state);
    validate(state);
  });

  it('counts a new unknown once and never counts repeated recognition as more new words', () => {
    const one = words.slice(0, 1);
    let state = save(initial(), DAY_ONE, DAY_ONE, 'ielts', 'look', one);
    state = advance(respond(start(state, DAY_ONE, 'look', one), 'unknown'));
    state = respond(start(state, DAY_ONE, 'look', one));
    state = respond(start(state, DAY_ONE, 'look', one));
    expect(summary(state)).toMatchObject({ newCompleted: 1, newTarget: 1, canCheckIn: true });
    expect(state.modes.look.progress['ielts-one']).toMatchObject({ rightCount: 2, wrongCount: 1, status: 'completed' });
    validate(state, one);
  });

  it('keeps independent modes and excludes other books even when the old queue crosses books', () => {
    let state = save(save(initial()), DAY_ONE, DAY_THREE, 'ielts', 'listen');
    state = respond(start(state));
    expect(summary(state).newCompleted).toBe(1);
    expect(summary(state, DAY_ONE, 'ielts', 'listen').newCompleted).toBe(0);
    state = respond(state); // cet-four is in the existing all-words queue.
    expect(summary(state).newCompleted).toBe(1);
    state = respond(start(state, DAY_ONE, 'listen'), 'known', DAY_ONE, 'listen');
    expect(summary(state, DAY_ONE, 'ielts', 'listen').newCompleted).toBe(1);
    validate(state);
  });

  it('reviews only this book yesterday mistakes once, independently of new-word targets', () => {
    let state = advance(respond(start(initial()), 'unknown'));
    state = advance(respond(state, 'unknown')); // another book's mistake
    state = finishGroup(state);
    state = save(state, DAY_TWO, DAY_THREE);
    expect(summary(state, DAY_TWO)).toMatchObject({ newTarget: 0, reviewTarget: 1, reviewCompleted: 0, pendingReview: 1, canCheckIn: false });
    state = start(state, DAY_TWO);
    expect(state.modes.look.session?.items.slice(0, 2)).toEqual(['ielts-one', 'cet-four']);
    state = respond(state, 'unknown', DAY_TWO);
    expect(summary(state, DAY_TWO)).toMatchObject({ newCompleted: 0, reviewCompleted: 1, canCheckIn: true });
    state = advance(state); state = respond(state, 'known', DAY_TWO);
    expect(summary(state, DAY_TWO).reviewCompleted).toBe(1);
    validate(state);
  });

  it('claims celebration once after real activity, checks in, and still permits extra learning', () => {
    let state = save(initial());
    expect(markStudyPlanCelebrated(state, words, 'ielts', 'look', time++, DAY_ONE)).toBe(state);
    expect(checkInStudyPlan(state, words, 'ielts', 'look', time++, DAY_ONE)).toBe(state);
    state = respond(start(state));
    state = markStudyPlanCelebrated(state, words, 'ielts', 'look', time++, DAY_ONE);
    const receipt = summary(state).celebratedAt;
    expect(receipt).toBeTypeOf('number');
    expect(markStudyPlanCelebrated(validate(state), words, 'ielts', 'look', time++, DAY_ONE)).toEqual(state);
    state = checkInStudyPlan(state, words, 'ielts', 'look', time++, DAY_ONE);
    expect(summary(state).checkedIn).toBe(true);
    state = respond(state); state = respond(state);
    expect(summary(state)).toMatchObject({ newCompleted: 2, checkedIn: true, celebratedAt: receipt });
    validate(state);
  });

  it('undo rewinds new/review counts and check-in but preserves an already claimed effect', () => {
    let state = respond(start(save(initial())));
    state = markStudyPlanCelebrated(state, words, 'ielts', 'look', time++, DAY_ONE);
    state = checkInStudyPlan(state, words, 'ielts', 'look', time++, DAY_ONE);
    const receipt = summary(state).celebratedAt;
    state = undo(validate(state), time++);
    expect(summary(state)).toMatchObject({ newCompleted: 0, canCheckIn: false, checkedIn: false, celebratedAt: receipt });
    expect(summary(state).day.checkedInAt).toBeUndefined();
    state = respond(state);
    expect(summary(state).canCheckIn).toBe(true);
    expect(markStudyPlanCelebrated(state, words, 'ielts', 'look', time++, DAY_ONE)).toBe(state);
    validate(state);
  });

  it('allows a genuine zero-work day to check in without inventing an achievement celebration', () => {
    let state = finishGroup(start(initial()));
    state = save(state);
    expect(summary(state)).toMatchObject({ newTarget: 0, newCompleted: 0, reviewTarget: 0, canCheckIn: true, hasActivity: false });
    state = checkInStudyPlan(state, words, 'ielts', 'look', time++, DAY_ONE);
    expect(summary(state).checkedIn).toBe(true);
    expect(markStudyPlanCelebrated(state, words, 'ielts', 'look', time++, DAY_ONE)).toBe(state);
    validate(state);
  });

  it('excludes slashes without fake new counts, and undo makes the target available again', () => {
    const one = words.slice(0, 1);
    let state = save(initial(), DAY_ONE, DAY_ONE, 'ielts', 'look', one);
    state = start(state, DAY_ONE, 'look', one);
    state = skipWord(state, 'look', getCurrentToken(state, 'look'), time++);
    expect(summary(state)).toMatchObject({ totalWords: 0, newTarget: 0, newCompleted: 0, hasActivity: false });
    state = checkInStudyPlan(state, one, 'ielts', 'look', time++, DAY_ONE);
    expect(markStudyPlanCelebrated(state, one, 'ielts', 'look', time++, DAY_ONE)).toBe(state);
    state = undo(validate(state, one), time++);
    expect(summary(state)).toMatchObject({ totalWords: 1, newTarget: 1, checkedIn: false, remainingToday: 1 });
    validate(state, one);
  });

  it('does not invent first-seen dates for old progress or rewrite completed historical days', () => {
    let state = respond(start(initial()));
    state = save(state);
    expect(summary(state)).toMatchObject({ encounteredWords: 1, newCompleted: 0, remainingNewWords: 2 });
    state = respond(state); state = respond(state);
    state = checkInStudyPlan(state, words, 'ielts', 'look', time++, DAY_ONE);
    const priorDay = JSON.stringify(summary(state).day);
    state = saveStudyPlan(state, words, { deck: 'ielts', mode: 'look', deadline: '2026-11-20', restart: true }, time++, DAY_TWO);
    expect(summary(state, DAY_TWO).plan.startedOn).toBe(DAY_TWO);
    expect(JSON.stringify(state.studyPlans[studyPlanKey('ielts', 'look')]?.days[DAY_ONE])).toBe(priorDay);
    expect(state.modes.look.progress['ielts-one']?.seenCount).toBe(1);
    validate(state);
  });

  it('starts a new local day without interrupting a group and keeps expired plans usable', () => {
    let state = save(initial(), DAY_ONE, DAY_ONE);
    state = start(state);
    const group = JSON.stringify(state.modes.look.session);
    state = ensureStudyPlanDay(state, words, 'ielts', 'look', time++, DAY_TWO);
    expect(JSON.stringify(state.modes.look.session)).toBe(group);
    expect(summary(state, DAY_TWO)).toMatchObject({ overdue: true, remainingDays: 0, newTarget: 3 });
    state = respond(state, 'known', DAY_TWO);
    expect(summary(state, DAY_TWO).newCompleted).toBe(1);
    expect(summary(state).newCompleted).toBe(0);
    validate(state);
  });

  it('uses the pre-answer balance when the first post-midnight answer opens the day', () => {
    let state = start(save(initial(), DAY_ONE, DAY_TWO));
    state = respond(state, 'known', DAY_TWO);
    expect(summary(state, DAY_TWO)).toMatchObject({ newTarget: 3, newCompleted: 1, pendingNew: 2 });
    validate(state);
  });

  it('preserves original start and today counts when editing the deadline or saved filter', () => {
    let state = respond(start(save(initial())));
    const progress = JSON.stringify(state.modes);
    state = saveStudyPlan(state, words, { deck: 'ielts', mode: 'look', deadline: '2026-11-20', skipBasic: false }, time++, DAY_ONE);
    expect(summary(state)).toMatchObject({ totalWords: 4, newCompleted: 1 });
    expect(summary(state).plan.startedOn).toBe(DAY_ONE);
    expect(JSON.stringify(state.modes)).toBe(progress);
    state = updateSettings(state, { skipBasic: true, deck: 'cet4' }, time++);
    expect(summary(state).plan.skipBasic).toBe(false);
    expect(summary(state).totalWords).toBe(4);
    validate(state);
  });

  it('handles leap dates and rejects invalid/past/overlong deadlines without changing state', () => {
    const state = initial(); const before = JSON.stringify(state);
    const leap = saveStudyPlan(state, words, { deck: 'ielts', mode: 'look', deadline: '2024-03-01' }, time++, '2024-02-28');
    expect(summary(leap, '2024-02-28').totalDays).toBe(3);
    for (const deadline of ['2026-02-30', '2026-10-21', '2040-01-01']) expect(() => saveStudyPlan(state, words, { deck: 'ielts', mode: 'look', deadline }, time++, DAY_ONE)).toThrow();
    expect(JSON.stringify(state)).toBe(before);
  });

  it('accepts old backups without plans and rejects forged scope, sources, receipts and undo deltas', () => {
    const old = JSON.parse(JSON.stringify(respond(start(initial())))); delete old.studyPlans;
    expect(parseAppState(old, words, VERSION).studyPlans).toEqual({});
    const state = respond(start(save(initial())));
    const badScope = structuredClone(state); badScope.studyPlans['ielts:look']!.scopeIds.push('cet-four');
    expect(() => validate(badScope)).toThrow(/其他词书/);
    const badNew = structuredClone(state); badNew.studyPlans['ielts:look']!.days[DAY_TWO] = { newTarget: 0, newWordIds: ['ielts-one'], reviewWordIds: [], reviewedWordIds: [] };
    expect(() => validate(badNew)).toThrow();
    const badReview = structuredClone(state); badReview.studyPlans['ielts:look']!.days[DAY_ONE]!.reviewWordIds = ['ielts-two'];
    expect(() => validate(badReview)).toThrow(/昨日错词/);
    const badReceipt = structuredClone(state); Object.assign(badReceipt.studyPlans['ielts:look']!.days[DAY_ONE]!, { checkedInAt: time++, checkedInTargets: { newWords: 3, reviewWordIds: [] } });
    expect(() => validate(badReceipt)).toThrow(/达标作答/);
    const badDelta = structuredClone(state); badDelta.history.at(-1)!.planChanges![0]!.key = 'ielts:listen';
    expect(() => validate(badDelta)).toThrow();
    validate(state);
  });

  it('undo removes a real review completion and its check-in without erasing yesterday mistakes', () => {
    const one = words.slice(0, 1);
    let state = advance(respond(start(initial(), DAY_ONE, 'look', one), 'unknown'));
    state = save(state, DAY_TWO, DAY_TWO, 'ielts', 'look', one);
    state = respond(start(state, DAY_TWO, 'look', one), 'known', DAY_TWO);
    state = checkInStudyPlan(state, one, 'ielts', 'look', time++, DAY_TWO);
    expect(summary(state, DAY_TWO)).toMatchObject({ reviewCompleted: 1, checkedIn: true });
    state = undo(validate(state, one), time++);
    expect(summary(state, DAY_TWO)).toMatchObject({ reviewTarget: 1, reviewCompleted: 0, checkedIn: false });
    expect(state.dailyActivity[DAY_ONE]?.['ielts-one']?.look.unknown).toBe(1);
    validate(state, one);
  });

  it('keeps new-word totals after bounded undo history expires and rewinds only the last twenty answers', () => {
    const dictionary: Word[] = Array.from({ length: 25 }, (_, rank) => ({ ...words[0]!, id: `plan-word-${rank}`, rank }));
    let state = save(initial(), DAY_ONE, DAY_THREE, 'ielts', 'look', dictionary);
    for (let index = 0; index < 25; index++) state = respond(start(state, DAY_ONE, 'look', dictionary));
    expect(summary(state).newCompleted).toBe(25);
    state = markStudyPlanCelebrated(state, dictionary, 'ielts', 'look', time++, DAY_ONE);
    state = checkInStudyPlan(state, dictionary, 'ielts', 'look', time++, DAY_ONE);
    for (let index = 0; index < 20; index++) state = undo(state, time++);
    expect(summary(state)).toMatchObject({ newCompleted: 5, newTarget: 9, checkedIn: false });
    expect(summary(state).celebratedAt).toBeTypeOf('number');
    expect(state.history).toHaveLength(0);
    validate(state, dictionary);
  });

});
