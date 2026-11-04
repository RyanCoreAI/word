import { isLocalDateKey } from './activity';
import type { AppState, Mode, RetentionDay, RetentionProgress, RetentionSummary, StudySession, UndoEntry, Word, WordProgress } from './types';

export const RETENTION_INTERVALS = [2, 7, 21, 60, 60] as const;
export const MAX_RETENTION_DAILY = 1000;
const own = <T>(record: Record<string, T>, id: string): T | undefined => Object.hasOwn(record, id) ? record[id] : undefined;
const emptyDay = (baseLimit: 10 | 20 | 30): RetentionDay => ({ extraAllowance: 0, baseLimit, look: {}, listen: {} });

export function addRetentionDays(date: string, days: number): string {
  if (!isLocalDateKey(date) || !Number.isSafeInteger(days) || days < 0) throw new Error('Invalid retention date');
  const value = new Date(`${date}T00:00:00.000Z`); value.setUTCDate(value.getUTCDate() + days);
  const result = value.toISOString().slice(0, 10);
  if (!isLocalDateKey(result)) throw new Error('Invalid retention date');
  return result;
}

function dueWords(state: AppState, words: readonly Word[], mode: Mode, today: string): Word[] {
  if (!isLocalDateKey(today)) throw new Error('Invalid retention date');
  if (!state.settings.retentionEnabled) return [];
  const skipped = new Set(state.skipped); const current = state.modes[mode];
  return words.filter(word => {
    if (skipped.has(word.id) || state.settings.skipBasic && word.basic || state.settings.deck !== 'all' && !word.tags.includes(state.settings.deck)) return false;
    if (own(current.progress, word.id)?.status !== 'completed') return false;
    const schedule = own(current.retention, word.id);
    if (schedule) return schedule.dueOn !== null && schedule.dueOn <= today && schedule.lastConfirmedOn !== today;
    // Legacy records are pending confirmation, never assigned invented old dates.
    const activity = own(state.dailyActivity[today] ?? {}, word.id)?.[mode];
    return !activity || activity.known + activity.unknown === 0;
  }).sort((a, b) => {
    const left = own(current.retention, a.id); const right = own(current.retention, b.id);
    return (left?.dueOn ?? today).localeCompare(right?.dueOn ?? today) || (right?.lapses ?? 0) - (left?.lapses ?? 0) || a.rank - b.rank || a.id.localeCompare(b.id);
  });
}

export function getRetentionSummary(state: AppState, words: readonly Word[], mode: Mode, today: string): RetentionSummary {
  const candidates = dueWords(state, words, mode, today); const due = candidates.length;
  const totalDue = due + dueWords(state, words, mode === 'look' ? 'listen' : 'look', today).length;
  const day = state.retentionDays[today] ?? emptyDay(state.settings.retentionDailyLimit);
  const consumed = new Set<string>();
  for (const taskMode of ['look', 'listen'] as const) for (const id of Object.keys(day[taskMode])) consumed.add(`${taskMode}:${id}`);
  let completedToday = 0;
  for (const value of Object.values(state.retentionDays)) for (const taskMode of ['look', 'listen'] as const) {
    for (const [id, marker] of Object.entries(value[taskMode])) if (marker.completed && marker.completedOn === today) { completedToday++; consumed.add(`${taskMode}:${id}`); }
  }
  for (const taskMode of ['look', 'listen'] as const) {
    const session = state.modes[taskMode].session;
    if (session?.status !== 'active' || !session.retentionDate || session.retentionDate >= today) continue;
    for (const id of session.retentionIds ?? []) {
      const marker = own(state.retentionDays[session.retentionDate]?.[taskMode] ?? {}, id);
      if (marker && !marker.completed && session.items.indexOf(id) >= session.cursor) consumed.add(`${taskMode}:${id}`);
    }
  }
  const scheduledToday = consumed.size;
  const dailyLimit = Math.min(MAX_RETENTION_DAILY, Math.max(day.baseLimit, state.settings.retentionDailyLimit) + day.extraAllowance);
  const remainingAllowance = Math.max(0, dailyLimit - scheduledToday);
  const unreservedDue = candidates.filter(word => !own(day[mode], word.id)).length;
  const reusable = candidates.filter(word => { const marker = own(day[mode], word.id); return marker && !marker.completed; }).length;
  return { due, totalDue, completedToday, scheduledToday, remainingAllowance, dailyLimit, unreservedDue, available: reusable + Math.min(remainingAllowance, unreservedDue) };
}

/** Explicitly grants five more slots; no answer, completion, or score is created. */
export function grantRetentionExtra(state: AppState, words: readonly Word[], mode: Mode, today: string, now: number): AppState {
  const summary = getRetentionSummary(state, words, mode, today);
  if (!state.settings.retentionEnabled || !summary.unreservedDue || summary.remainingAllowance || summary.dailyLimit >= MAX_RETENTION_DAILY) return state;
  if (!Number.isSafeInteger(now) || now < 0 || state.revision >= Number.MAX_SAFE_INTEGER) throw new Error('Invalid retention revision');
  const day = state.retentionDays[today] ?? emptyDay(state.settings.retentionDailyLimit);
  const extraAllowance = Math.min(MAX_RETENTION_DAILY - Math.max(day.baseLimit, state.settings.retentionDailyLimit), day.extraAllowance + 5);
  return { ...state, retentionDays: { ...state.retentionDays, [today]: { ...day, extraAllowance } }, revision: state.revision + 1, updatedAt: now };
}

export function selectRetentionWords(state: AppState, words: readonly Word[], mode: Mode, today: string, excluded: ReadonlySet<string>): Word[] {
  let remaining = getRetentionSummary(state, words, mode, today).remainingAllowance;
  const markers = state.retentionDays[today]?.[mode] ?? {};
  return dueWords(state, words, mode, today).filter(word => {
    if (excluded.has(word.id)) return false;
    const previous = own(markers, word.id);
    if (previous) return !previous.completed;
    if (!remaining) return false;
    remaining--; return true;
  }).slice(0, 5);
}

export function reserveRetention(state: AppState, mode: Mode, today: string, groupNumber: number, ids: readonly string[]): AppState['retentionDays'] {
  if (!ids.length) return state.retentionDays;
  const day = state.retentionDays[today] ?? emptyDay(state.settings.retentionDailyLimit); const markers = { ...day[mode] };
  for (const id of ids) markers[id] = { groupNumber, firstGroupNumber: own(markers, id)?.firstGroupNumber ?? groupNumber, completed: false, failed: false };
  return { ...state.retentionDays, [today]: { ...day, baseLimit: Math.max(day.baseLimit, state.settings.retentionDailyLimit) as 10 | 20 | 30, [mode]: markers } };
}

export function recordRetentionAnswer(state: AppState, mode: Mode, id: string, result: 'known' | 'unknown', previous: WordProgress | undefined, progress: WordProgress, session: StudySession, today: string): {
  retention: AppState['modes'][Mode]['retention']; retentionDays: AppState['retentionDays']; change?: UndoEntry['retentionChange']; isRetention: boolean;
} {
  const old = own(state.modes[mode].retention, id);
  const date = session.retentionDate;
  const marker = date ? own(state.retentionDays[date]?.[mode] ?? {}, id) : undefined;
  const isRetention = !!date && !!session.retentionIds?.includes(id) && marker?.groupNumber === session.groupNumber && !marker.completed;
  let next: RetentionProgress | undefined = old;
  if (result === 'unknown' && (old || previous?.status === 'completed')) {
    next = { ...old, stage: 0, dueOn: null, lapses: (old?.lapses ?? 0) + Number(previous?.status === 'completed') };
  } else if (result === 'known' && progress.status === 'completed') {
    if (isRetention && previous?.status === 'completed' && old?.lastConfirmedOn !== today) {
      const stage = Math.min(4, (old?.stage ?? 0) + 1) as RetentionProgress['stage'];
      next = { stage, dueOn: addRetentionDays(today, RETENTION_INTERVALS[stage]), lastConfirmedOn: today, lapses: old?.lapses ?? 0 };
    } else if (previous?.status !== 'completed') next = { stage: 0, dueOn: addRetentionDays(today, 2), lastConfirmedOn: today, lapses: old?.lapses ?? 0 };
  }
  let retentionDays = state.retentionDays;
  if (isRetention && marker && date) {
    const day = state.retentionDays[date]!;
    retentionDays = { ...state.retentionDays, [date]: { ...day, [mode]: { ...day[mode], [id]: { ...marker, completed: true, failed: result === 'unknown', completedOn: today } } } };
    if (date !== today && !retentionDays[today]) retentionDays[today] = emptyDay(state.settings.retentionDailyLimit);
  }
  if (next === old && !isRetention) return { retention: state.modes[mode].retention, retentionDays, isRetention };
  return {
    retention: next ? { ...state.modes[mode].retention, [id]: next } : state.modes[mode].retention,
    retentionDays, isRetention,
    change: { previous: old ? { ...old } : null, ...(isRetention && date && marker ? { date, previousMarker: { ...marker } } : {}) },
  };
}

/** Rewind assignments made after the answer, while preserving independent manual allowance. */
export function rewindRetentionDays(days: AppState['retentionDays'], entry: UndoEntry): AppState['retentionDays'] {
  const other = entry.mode === 'look' ? 'listen' : 'look';
  const groups = { [entry.mode]: entry.previousGroupNumber, [other]: entry.previousOtherGroupNumber };
  const sessions = { [entry.mode]: entry.previousSession, [other]: entry.previousOtherSession };
  const result: AppState['retentionDays'] = {};
  for (const [date, day] of Object.entries(days)) {
    const next = { ...day, look: { ...day.look }, listen: { ...day.listen } };
    if (entry.retentionChange?.date === date && entry.retentionChange.previousMarker) next[entry.mode][entry.wordId] = { ...entry.retentionChange.previousMarker };
    for (const mode of ['look', 'listen'] as const) for (const [id, marker] of Object.entries(next[mode])) {
      if (marker.groupNumber <= groups[mode]!) continue;
      if (marker.firstGroupNumber > groups[mode]!) delete next[mode][id];
      else { const session = sessions[mode]; next[mode][id] = { ...marker, groupNumber: session?.retentionDate === date && session.retentionIds?.includes(id) ? session.groupNumber : marker.firstGroupNumber }; }
    }
    if (next.extraAllowance || Object.keys(next.look).length || Object.keys(next.listen).length) result[date] = next;
  }
  return result;
}
