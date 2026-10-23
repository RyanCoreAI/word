import { isLocalDateKey } from './activity';
import type { AppState, DailyReview, Mode, UndoEntry, YesterdayReviewCounts } from './types';

export function previousLocalDateKey(today: string): string {
  if (!isLocalDateKey(today)) throw new Error('Invalid local date');
  const date = new Date(`${today}T00:00:00.000Z`);
  date.setUTCDate(date.getUTCDate() - 1);
  const previous = date.toISOString().slice(0, 10);
  if (!isLocalDateKey(previous)) throw new Error('Invalid previous local date');
  return previous;
}

export function getYesterdayReviewWordIds(state: AppState, today: string, mode: Mode): string[] {
  const yesterday = previousLocalDateKey(today);
  const skipped = new Set(state.skipped);
  return Object.entries(state.dailyActivity[yesterday] ?? {})
    .filter(([id, activity]) => activity[mode].unknown > 0 && !skipped.has(id))
    .map(([id]) => id);
}

export function getYesterdayReviewSummary(state: AppState, today: string): { date: string; yesterday: string; look: YesterdayReviewCounts; listen: YesterdayReviewCounts } {
  const counts = (mode: Mode): YesterdayReviewCounts => {
    const ids = getYesterdayReviewWordIds(state, today, mode);
    const markers = state.dailyReview[today]?.[mode] ?? {};
    const queued = ids.filter(id => Object.prototype.hasOwnProperty.call(markers, id)).length;
    const completed = ids.filter(id => Object.prototype.hasOwnProperty.call(markers, id) && markers[id]!.completed).length;
    return { total: ids.length, queued, completed, pending: ids.length - completed, available: ids.length - queued };
  };
  return { date: today, yesterday: previousLocalDateKey(today), look: counts('look'), listen: counts('listen') };
}

export function reserveDailyReview(state: AppState, today: string, mode: Mode, groupNumber: number, ids: readonly string[]): DailyReview {
  if (!ids.length) return state.dailyReview;
  const day = state.dailyReview[today] ?? { look: {}, listen: {} };
  const markers = { ...day[mode] };
  for (const id of ids) markers[id] = { groupNumber, completed: false };
  return { ...state.dailyReview, [today]: { ...day, [mode]: markers } };
}

export function completeDailyReview(state: AppState, mode: Mode, wordId: string, groupNumber: number, today: string): {
  dailyReview: DailyReview; change?: UndoEntry['dailyReviewChange'];
} {
  for (const [date, day] of Object.entries(state.dailyReview)) {
    const marker = Object.prototype.hasOwnProperty.call(day[mode], wordId) ? day[mode][wordId] : undefined;
    if (marker?.groupNumber !== groupNumber || marker.completed) continue;
    return {
      dailyReview: { ...state.dailyReview, [date]: { ...day, [mode]: { ...day[mode], [wordId]: { ...marker, completed: true } } } },
      change: { date, previous: { ...marker } },
    };
  }
  // A group opened yesterday can itself supply today's real check, without editing it.
  const day = state.dailyReview[today] ?? { look: {}, listen: {} };
  if (!Object.prototype.hasOwnProperty.call(day[mode], wordId) && getYesterdayReviewWordIds(state, today, mode).includes(wordId)) {
    return {
      dailyReview: { ...state.dailyReview, [today]: { ...day, [mode]: { ...day[mode], [wordId]: { groupNumber, completed: true } } } },
      change: { date: today, previous: null },
    };
  }
  return { dailyReview: state.dailyReview };
}

/** Undo may rewind groups opened since the last answer, including the other mode. */
export function rewindDailyReview(dailyReview: DailyReview, entry: UndoEntry): DailyReview {
  const groups = { [entry.mode]: entry.previousGroupNumber, [entry.mode === 'look' ? 'listen' : 'look']: entry.previousOtherGroupNumber };
  const restored: DailyReview = {};
  for (const [date, day] of Object.entries(dailyReview)) {
    const next = { look: { ...day.look }, listen: { ...day.listen } };
    if (entry.dailyReviewChange?.date === date) {
      if (entry.dailyReviewChange.previous) next[entry.mode][entry.wordId] = { ...entry.dailyReviewChange.previous };
      else delete next[entry.mode][entry.wordId];
    }
    for (const mode of ['look', 'listen'] as const) {
      for (const [id, marker] of Object.entries(next[mode])) if (marker.groupNumber > groups[mode]!) delete next[mode][id];
    }
    if (Object.keys(next.look).length || Object.keys(next.listen).length) restored[date] = next;
  }
  return restored;
}
