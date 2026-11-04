import { describe, expect, it } from 'vitest';
import { answer, createInitialState, deferWord, ensureSession, getCurrentToken, nextWord, restartWord, restoreSkipped, skipWord, undo, updateSettings } from './engine';
import { addRetentionDays, getRetentionSummary, grantRetentionExtra } from './retention';
import { parseAppState } from './schemas';
import { getStudyPlanSummary, saveStudyPlan } from './study-plan';
import type { AppState, Mode, Word } from './types';

const words: Word[] = Array.from({ length: 45 }, (_, i) => ({ id: `word${i.toString().padStart(2, '0')}`, word: `word${i}`, translation: '测试', phonetic: '', tags: i % 2 ? ['cet4', 'ielts'] : ['cet4'], rank: i, basic: i === 44 }));
const now = (date: string) => Date.parse(`${date}T12:00:00Z`);
const checked = (state: AppState) => parseAppState(state, words, 'test');
const respond = (state: AppState, mode: Mode, result: 'known' | 'unknown', date: string) => checked(answer(state, mode, result, getCurrentToken(state, mode), now(date), date));
function completed(mode: Mode = 'look', count = 45): AppState {
  let state = createInitialState('test', now('2026-01-01'));
  state = updateSettings(state, { skipBasic: false }, now('2026-01-01'));
  let remaining = count;
  while (remaining > 0) {
    state = ensureSession(state, words, mode, now('2026-01-01'), '2026-01-01');
    while (state.modes[mode].session?.status === 'active' && remaining > 0) { state = respond(state, mode, 'known', '2026-01-01'); remaining--; }
  }
  // Exact partial groups are retained by product code; this fixture finishes its group first.
  return state;
}
function finish(state: AppState, mode: Mode, date: string, result: 'known' | 'unknown' = 'known'): AppState {
  while (state.modes[mode].session?.status === 'active') {
    if (state.modes[mode].session!.revealed) state = checked(nextWord(state, mode, getCurrentToken(state, mode), now(date)));
    else state = respond(state, mode, result, date);
  }
  return state;
}
function single(): AppState { const state = completed('look', 1); return checked({ ...state, skipped: words.slice(1).map(word => word.id), modes: { ...state.modes, look: { ...state.modes.look, session: null } } }); }

describe('retention scheduling and real answers', () => {
  it('advances 2/7/21/60/60 from the real confirmation date, with one overdue stage per answer', () => {
    let state = single(); const id = words[0]!.id;
    expect(state.modes.look.retention[id]).toEqual({ stage: 0, dueOn: '2026-01-03', lastConfirmedOn: '2026-01-01', lapses: 0 });
    for (const [date, stage, interval] of [['2026-01-08', 1, 7], ['2026-01-15', 2, 21], ['2026-02-05', 3, 60], ['2026-04-06', 4, 60], ['2026-06-05', 4, 60]] as const) {
      state = checked(ensureSession(state, words, 'look', now(date), date)); expect(state.modes.look.session?.retentionIds).toEqual([id]);
      state = respond(state, 'look', 'known', date);
      expect(state.modes.look.retention[id]).toEqual({ stage, dueOn: addRetentionDays(date, interval), lastConfirmedOn: date, lapses: 0 });
      expect(getRetentionSummary(state, words, 'look', date).completedToday).toBe(1);
      state = checked(ensureSession(state, words, 'look', now(date), date)); expect(state.modes.look.session?.items).toEqual([]);
    }
  });

  it('wrong immediately reveals, retains real errors, and requires two later hidden known answers to restart 2 days', () => {
    let state = checked(ensureSession(single(), words, 'look', now('2026-01-03'), '2026-01-03')); const before = state;
    state = respond(state, 'look', 'unknown', '2026-01-03');
    expect(state.modes.look.session?.revealed).toBe(true); expect(state.modes.look.retention.word00?.dueOn).toBeNull(); expect(state.modes.look.retention.word00?.lapses).toBe(1);
    expect(getRetentionSummary(state, words, 'look', '2026-01-03').completedToday).toBe(1);
    expect(answer(state, 'look', 'known', getCurrentToken(state, 'look'), now('2026-01-03'), '2026-01-03')).toBe(state);
    const reverted = checked(undo(state, now('2026-01-03'))); expect(reverted.modes.look).toEqual(before.modes.look); expect(reverted.retentionDays).toEqual(before.retentionDays);
    state = checked(nextWord(state, 'look', getCurrentToken(state, 'look'), now('2026-01-03')));
    for (let i = 0; i < 2; i++) { state = checked(ensureSession(state, words, 'look', now('2026-01-03'), '2026-01-03')); state = respond(state, 'look', 'known', '2026-01-03'); }
    expect(state.modes.look.progress.word00?.status).toBe('completed'); expect(state.modes.look.retention.word00).toEqual({ stage: 0, dueOn: '2026-01-05', lastConfirmedOn: '2026-01-03', lapses: 1 });
    expect(getRetentionSummary(state, words, 'look', '2026-01-03').due).toBe(0);
  });

  it('does not advance early through regular groups and manual restart uses two-known relearning', () => {
    let state = single(); const schedule = state.modes.look.retention.word00;
    state = checked(restartWord(state, 'word00', 'look', now('2026-01-02'))); expect(state.history).toEqual([]); expect(state.modes.look.retention.word00?.dueOn).toBeNull();
    for (let i = 0; i < 2; i++) { state = checked(ensureSession(state, words, 'look', now('2026-01-02'), '2026-01-02')); state = respond(state, 'look', 'known', '2026-01-02'); }
    expect(state.modes.look.retention.word00?.stage).toBe(0); expect(state.modes.look.retention.word00?.dueOn).toBe('2026-01-04'); expect(schedule?.stage).toBe(0);
  });
});

describe('bounded shared retention queues', () => {
  it('keeps exact active groups, adds at most 5 per group/20 per day, retains all due backlog and allows explicit +5', () => {
    let state = checked(ensureSession(completed(), words, 'look', now('2026-01-03'), '2026-01-03')); const same = ensureSession(state, words, 'look', now('2026-01-03'), '2026-01-03'); expect(same).toBe(state);
    for (let i = 0; i < 4; i++) {
      state = checked(ensureSession(state, words, 'look', now('2026-01-03'), '2026-01-03'));
      expect(state.modes.look.session?.retentionIds).toHaveLength(5); state = finish(state, 'look', '2026-01-03');
    }
    const summary = getRetentionSummary(state, words, 'look', '2026-01-03'); expect(summary).toMatchObject({ completedToday: 20, scheduledToday: 20, remainingAllowance: 0, dailyLimit: 20, available: 0, due: 25 });
    const beforeActivity = state.dailyActivity; const revision = state.revision;
    state = checked(grantRetentionExtra(state, words, 'look', '2026-01-03', now('2026-01-03')));
    expect(state.revision).toBe(revision + 1); expect(state.dailyActivity).toEqual(beforeActivity); expect(getRetentionSummary(state, words, 'look', '2026-01-03').dailyLimit).toBe(25);
    state = checked(ensureSession(state, words, 'look', now('2026-01-03'), '2026-01-03')); expect(state.modes.look.session?.retentionIds).toHaveLength(5);
  });

  it('shares automatic budget across both modes without duplicating overlapping deck records', () => {
    let state = completed(); state = finish(state, 'look', '2026-01-01');
    while (Object.keys(state.modes.listen.progress).length < words.length) { state = checked(ensureSession(state, words, 'listen', now('2026-01-01'), '2026-01-01')); state = finish(state, 'listen', '2026-01-01'); }
    for (let i = 0; i < 4; i++) { const mode = i % 2 ? 'listen' : 'look'; state = checked(ensureSession(state, words, mode, now('2026-01-03'), '2026-01-03')); state = finish(state, mode, '2026-01-03'); }
    expect(getRetentionSummary(state, words, 'listen', '2026-01-03').scheduledToday).toBe(20);
    state = updateSettings(state, { deck: 'ielts' }, now('2026-01-03')); expect(getRetentionSummary(state, words, 'listen', '2026-01-03').remainingAllowance).toBe(0);
    expect(Object.keys(state.modes.look.retention)).toHaveLength(45); expect(Object.keys(state.modes.listen.retention)).toHaveLength(45);
  });

  it('reuses deferred reservations, excludes skipped/out-of-book, and undo rewinds newer assignments', () => {
    let state = single(); state = updateSettings(state, { retentionDailyLimit: 10 }, now('2026-01-03'));
    state = checked(ensureSession(state, words, 'look', now('2026-01-03'), '2026-01-03')); const reserved = state;
    state = checked(deferWord(state, 'look', getCurrentToken(state, 'look'), now('2026-01-03')));
    state = checked(ensureSession(state, words, 'look', now('2026-01-03'), '2026-01-03')); expect(state.modes.look.session?.retentionIds).toEqual(['word00']);
    state = checked(undo(state, now('2026-01-03'))); expect(state.modes.look.session).toEqual(reserved.modes.look.session); expect(state.retentionDays).toEqual(reserved.retentionDays);
    state = checked(skipWord(state, 'look', getCurrentToken(state, 'look'), now('2026-01-03'))); expect(getRetentionSummary(state, words, 'look', '2026-01-03').due).toBe(0);
    state = checked(restoreSkipped(state, 'word00', now('2026-01-03'))); expect(getRetentionSummary(state, words, 'look', '2026-01-03').due).toBe(1);
    state = updateSettings(state, { deck: 'ielts' }, now('2026-01-03')); expect(getRetentionSummary(state, words, 'look', '2026-01-03').due).toBe(0);
    state = updateSettings(state, { deck: 'all', retentionEnabled: false }, now('2026-01-03')); expect(getRetentionSummary(state, words, 'look', '2026-01-03').due).toBe(0);
    state = updateSettings(state, { retentionEnabled: true }, now('2026-01-03')); expect(getRetentionSummary(state, words, 'look', '2026-01-03').due).toBe(1);
  });

  it('reuses actual exhausted daily reservations without granting extra for already reserved cards', () => {
    let state = completed();
    for (let i = 0; i < 3; i++) { state = checked(ensureSession(state, words, 'look', now('2026-01-03'), '2026-01-03')); state = finish(state, 'look', '2026-01-03'); }
    state = checked(ensureSession(state, words, 'look', now('2026-01-03'), '2026-01-03'));
    const ids = state.modes.look.session!.retentionIds;
    while (state.modes.look.session?.status === 'active') state = checked(deferWord(state, 'look', getCurrentToken(state, 'look'), now('2026-01-03')));
    expect(getRetentionSummary(state, words, 'look', '2026-01-03')).toMatchObject({ scheduledToday: 20, remainingAllowance: 0, available: 5 });
    state = checked(ensureSession(state, words, 'look', now('2026-01-03'), '2026-01-03')); expect(state.modes.look.session!.retentionIds).toEqual(ids); expect(getRetentionSummary(state, words, 'look', '2026-01-03').scheduledToday).toBe(20);
    // All other backlog is explicitly skipped; pending reservations alone must not consume a '+5' grant.
    state = checked({ ...state, skipped: words.filter(word => !ids!.includes(word.id)).map(word => word.id), history: [] });
    expect(grantRetentionExtra(state, words, 'look', '2026-01-03', now('2026-01-03'))).toBe(state);
  });

  it('undo removes other-mode reservations opened after the last answer and preserves manual allowance', () => {
    let state = completed();
    while (Object.keys(state.modes.listen.progress).length < words.length) { state = checked(ensureSession(state, words, 'listen', now('2026-01-01'), '2026-01-01')); state = finish(state, 'listen', '2026-01-01'); }
    state = checked(ensureSession(state, words, 'look', now('2026-01-03'), '2026-01-03')); const before = state;
    state = respond(state, 'look', 'known', '2026-01-03');
    state = checked(ensureSession(state, words, 'listen', now('2026-01-03'), '2026-01-03')); expect(Object.keys(state.retentionDays['2026-01-03']!.listen)).toHaveLength(5);
    state = checked(undo(state, now('2026-01-03'))); expect(state.retentionDays).toEqual(before.retentionDays); expect(state.modes).toEqual(before.modes);
  });

  it('retention answers leave an existing new-word plan unchanged and cannot manufacture a check-in', () => {
    let state = completed('look', 20); state = checked(saveStudyPlan(state, words, { deck: 'all', mode: 'look', skipBasic: false, deadline: '2026-01-10' }, now('2026-01-03'), '2026-01-03'));
    state = checked(ensureSession(state, words, 'look', now('2026-01-03'), '2026-01-03')); const plans = structuredClone(state.studyPlans);
    state = respond(state, 'look', 'known', '2026-01-03'); expect(state.studyPlans).toEqual(plans);
    state = respond(state, 'look', 'unknown', '2026-01-03'); expect(state.studyPlans).toEqual(plans);
    const summary = getStudyPlanSummary(state, words, 'all', 'look', '2026-01-03'); expect(summary?.newCompleted).toBe(0); expect(summary?.canCheckIn).toBe(false);
  });

  it('day quota downshifts apply next day, explicit grants add actual slots, and manual allowance is capped at 1000', () => {
    let state = completed();
    for (let i = 0; i < 4; i++) { state = checked(ensureSession(state, words, 'look', now('2026-01-03'), '2026-01-03')); state = finish(state, 'look', '2026-01-03'); }
    state = updateSettings(state, { retentionDailyLimit: 10 }, now('2026-01-03')); expect(getRetentionSummary(state, words, 'look', '2026-01-03').dailyLimit).toBe(20);
    state = checked(grantRetentionExtra(state, words, 'look', '2026-01-03', now('2026-01-03'))); expect(getRetentionSummary(state, words, 'look', '2026-01-03')).toMatchObject({ dailyLimit: 25, remainingAllowance: 5 });
    expect(getRetentionSummary(state, words, 'look', '2026-01-04').dailyLimit).toBe(10);
    const bounded = checked({ ...state, retentionDays: { ...state.retentionDays, '2026-01-03': { ...state.retentionDays['2026-01-03']!, extraAllowance: 980 } } });
    expect(getRetentionSummary(bounded, words, 'look', '2026-01-03').dailyLimit).toBe(1000); expect(grantRetentionExtra(bounded, words, 'look', '2026-01-03', now('2026-01-03'))).toBe(bounded);
    const forged = structuredClone(bounded); forged.retentionDays['2026-01-03']!.extraAllowance = 1001; expect(() => checked(forged)).toThrow();
  });

  it('carries exact prior-midnight reservations into today shared budget and schedules from actual answer date', () => {
    let state = completed(); state = finish(state, 'look', '2026-01-01');
    state = checked(ensureSession(state, words, 'look', now('2026-01-03'), '2026-01-03')); const session = state.modes.look.session;
    expect(ensureSession(state, words, 'look', now('2026-01-04'), '2026-01-04')).toBe(state);
    expect(getRetentionSummary(state, words, 'listen', '2026-01-04').remainingAllowance).toBe(15);
    state = respond(state, 'look', 'known', '2026-01-04'); expect(state.modes.look.retention.word00?.dueOn).toBe('2026-01-11');
    expect(state.modes.look.session?.retentionDate).toBe(session?.retentionDate); expect(getRetentionSummary(state, words, 'look', '2026-01-04')).toMatchObject({ completedToday: 1, scheduledToday: 5, remainingAllowance: 15 });
  });

  it('legacy backups become bounded unconfirmed pending without invented dates and strict corruption is rejected', () => {
    const raw = structuredClone(completed()) as unknown as Record<string, unknown>;
    const modes = raw.modes as Record<Mode, Record<string, unknown>>; delete modes.look.retention; delete modes.listen.retention; delete raw.retentionDays;
    const settings = raw.settings as Record<string, unknown>; delete settings.retentionEnabled; delete settings.retentionDailyLimit;
    for (const entry of raw.history as Record<string, unknown>[]) delete entry.retentionChange;
    let state = parseAppState(raw, words, 'test'); expect(state.modes.look.retention).toEqual({}); expect(getRetentionSummary(state, words, 'look', '2026-01-03').due).toBe(45);
    state = finish(state, 'look', '2026-01-01'); state = checked(ensureSession(state, words, 'look', now('2026-01-03'), '2026-01-03')); expect(state.modes.look.session?.retentionIds).toHaveLength(5);
    state = respond(state, 'look', 'known', '2026-01-03'); expect(state.modes.look.retention.word00?.dueOn).toBe('2026-01-10');
    const forged = structuredClone(state); forged.modes.look.retention.word00!.stage = 4; forged.modes.look.retention.word00!.dueOn = '2026-03-04'; expect(() => checked(forged)).toThrow();
    const badMarker = structuredClone(state); badMarker.retentionDays['2026-01-03']!.look.word00!.completedOn = '2026-01-02'; expect(() => checked(badMarker)).toThrow();
    const badUndo = structuredClone(state); badUndo.history.at(-1)!.retentionChange!.previous = { stage: 0, dueOn: null, lapses: 999 }; expect(() => checked(badUndo)).toThrow();
    const future = structuredClone(state); future.modes.look.session!.retentionIds = ['word44']; expect(() => checked(future)).toThrow();
  });

  it('rejects altered retention source IDs in undo snapshots and orphaned current-group reservations', () => {
    let state = completed('look', 20); state = checked(ensureSession(state, words, 'look', now('2026-01-03'), '2026-01-03')); state = respond(state, 'look', 'known', '2026-01-03');
    const altered = structuredClone(state); const entry = altered.history.at(-1)!;
    entry.previousSession.retentionIds = [...entry.previousSession.retentionIds!.slice(0, 4), 'word20'];
    expect(entry.previousSession.items).toContain('word20'); expect(() => checked(altered)).toThrow(/巩固/);
    const missing = structuredClone(state); missing.modes.look.session!.retentionIds!.pop(); expect(() => checked(missing)).toThrow(/巩固/);
    const restored = checked(undo(state, now('2026-01-03'))); expect(restored.modes.look.session?.retentionIds).toEqual(state.history.at(-1)!.previousSession.retentionIds);
  });
});
