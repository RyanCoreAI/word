import { MODES } from './types';
import type { AppState, DailyStudySummary, DailyWordActivity, StudyDay } from './types';

export function isLocalDateKey(value: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const parsed = new Date(`${value}T00:00:00.000Z`);
  return Number.isFinite(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value;
}

/** Offset uses Date.getTimezoneOffset() semantics; no clock or host timezone is read. */
export function getLocalDateKey(now: number, timezoneOffsetMinutes = 0): string {
  if (!Number.isSafeInteger(now) || now < 0 || !Number.isInteger(timezoneOffsetMinutes) || Math.abs(timezoneOffsetMinutes) > 1_440) throw new Error('Invalid local date input');
  const local = new Date(now - timezoneOffsetMinutes * 60_000);
  if (!Number.isFinite(local.getTime())) throw new Error('Invalid local date input');
  const key = local.toISOString().slice(0, 10);
  if (!isLocalDateKey(key)) throw new Error('Invalid local date input');
  return key;
}

export function cloneDailyWordActivity(value: DailyWordActivity): DailyWordActivity {
  return { look: { ...value.look }, listen: { ...value.listen } };
}

/** Same spelling/identifier in both modes contributes one word to a day's total. */
export function getDailyStudySummary(state: AppState, date: string): DailyStudySummary {
  if (!isLocalDateKey(date)) throw new Error('Invalid local date');
  const entries = state.dailyActivity[date] ?? {};
  const words = Object.entries(entries).map(([wordId, activity]) => ({
    wordId,
    known: activity.look.known + activity.listen.known,
    unknown: activity.look.unknown + activity.listen.unknown,
    modes: MODES.filter(mode => activity[mode].known + activity[mode].unknown > 0),
  })).sort((left, right) => right.unknown - left.unknown || left.wordId.localeCompare(right.wordId));
  return {
    date, wordCount: words.length,
    known: words.reduce((sum, word) => sum + word.known, 0),
    unknown: words.reduce((sum, word) => sum + word.unknown, 0),
    words,
  };
}

/** Only recorded dates are returned; legacy lastAnsweredAt values never invent history. */
export function getStudyCalendar(state: AppState): StudyDay[] {
  return Object.keys(state.dailyActivity).sort().map(date => {
    const { wordCount, known, unknown } = getDailyStudySummary(state, date);
    return { date, wordCount, known, unknown };
  });
}
