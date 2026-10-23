import { DEFAULT_SETTINGS, MODES } from './types';
import { settingsSchema } from './schemas';
import { cloneDailyWordActivity, getLocalDateKey, isLocalDateKey } from './activity';
import { recordStudyTrail, undoStudyTrail } from './navigation';
import { completeDailyReview, getYesterdayReviewWordIds, reserveDailyReview, rewindDailyReview } from './daily-review';
import type { AppState, AnswerResult, Mode, Settings, StudySession, UndoEntry, Word, WordProgress } from './types';

const own = <T>(record: Record<string, T>, key: string): T | undefined =>
  Object.prototype.hasOwnProperty.call(record, key) ? record[key] : undefined;
const otherMode = (mode: Mode): Mode => mode === 'look' ? 'listen' : 'look';
const cloneSession = (session: StudySession | null): StudySession | null => session ? { ...session, items: [...session.items] } : null;

function touch(state: AppState, now: number): AppState {
  if (!Number.isSafeInteger(now) || now < 0) throw new Error('Invalid timestamp');
  if (state.revision >= Number.MAX_SAFE_INTEGER) throw new Error('Revision exhausted');
  return { ...state, revision: state.revision + 1, updatedAt: now };
}

export function createInitialState(dictionaryVersion: string, now: number): AppState {
  if (!dictionaryVersion || dictionaryVersion.length > 200) throw new Error('Invalid dictionary version');
  if (!Number.isSafeInteger(now) || now < 0) throw new Error('Invalid timestamp');
  return {
    schemaVersion: 1, dictionaryVersion, revision: 0, updatedAt: now,
    settings: { ...DEFAULT_SETTINGS },
    modes: {
      look: { progress: {}, session: null, groupNumber: 0 },
      listen: { progress: {}, session: null, groupNumber: 0 },
    },
    skipped: [], history: [], dailyActivity: {}, studyTrail: [], dailyReview: {},
  };
}

export function getCurrentToken(state: AppState, mode: Mode): string | null {
  const session = state.modes[mode].session;
  if (!session || session.status !== 'active') return null;
  return `${state.revision}:${mode}:${session.groupNumber}:${session.cursor}:${session.revealed ? 'revealed' : 'hidden'}`;
}

export function getCurrentWord(state: AppState, mode: Mode, words: readonly Word[]): Word | undefined {
  const session = state.modes[mode].session;
  if (!session || session.status !== 'active') return undefined;
  const id = session.items[session.cursor];
  return words.find(word => word.id === id);
}

export function matchesSettings(word: Word, settings: Settings): boolean {
  return (!settings.skipBasic || !word.basic) && (settings.deck === 'all' || word.tags.includes(settings.deck));
}

function advancePastSkipped(session: StudySession, skipped: ReadonlySet<string>): StudySession {
  const next = { ...session };
  while (next.cursor < next.items.length && skipped.has(next.items[next.cursor]!)) {
    next.cursor += 1;
    next.skipped += 1;
    next.revealed = false;
  }
  next.status = next.cursor >= next.items.length ? 'finished' : 'active';
  return next;
}

/** Resume the exact session, or start the next group after its summary. */
export function ensureSession(state: AppState, words: readonly Word[], mode: Mode, now: number, localDateKey?: string): AppState {
  const modeState = state.modes[mode];
  const skipped = new Set(state.skipped);
  if (modeState.session?.status === 'active') {
    if (modeState.session.revealed) return state;
    const resumed = advancePastSkipped(modeState.session, skipped);
    if (resumed.cursor === modeState.session.cursor) return state;
    return touch({ ...state, modes: { ...state.modes, [mode]: { ...modeState, session: resumed } } }, now);
  }
  const today = localDateKey ?? getLocalDateKey(now);
  if (!isLocalDateKey(today)) throw new Error('Invalid local date');
  const available = words.filter(word => !skipped.has(word.id));
  const markers = state.dailyReview[today]?.[mode] ?? {};
  const dueIds = new Set(getYesterdayReviewWordIds(state, today, mode).filter(id => !Object.prototype.hasOwnProperty.call(markers, id)));
  const due = available.filter(word => dueIds.has(word.id)).sort((a, b) => a.rank - b.rank || (a.id < b.id ? -1 : 1));
  const review = available.filter(word => own(modeState.progress, word.id)?.status === 'learning')
    .sort((a, b) => {
      const pa = own(modeState.progress, a.id)!;
      const pb = own(modeState.progress, b.id)!;
      return pa.lastGroup - pb.lastGroup || pb.wrongCount - pa.wrongCount || a.rank - b.rank || (a.id < b.id ? -1 : 1);
    });
  const fresh = available.filter(word => !own(modeState.progress, word.id) && matchesSettings(word, state.settings))
    .sort((a, b) => a.rank - b.rank || (a.id < b.id ? -1 : 1));
  // Every outstanding review is retained even after the requested size shrinks.
  const remainingReview = review.filter(word => !dueIds.has(word.id));
  const selected = [...due, ...remainingReview];
  const ids = [...selected, ...fresh.slice(0, Math.max(0, state.settings.groupSize - selected.length))].map(word => word.id);
  if (!ids.length && modeState.session?.status === 'finished' && !modeState.session.items.length) return state;
  const groupNumber = modeState.groupNumber + (ids.length ? 1 : 0);
  const session: StudySession = {
    groupNumber, items: ids, cursor: 0, revealed: false,
    status: ids.length ? 'active' : 'finished', known: 0, unknown: 0, skipped: 0,
  };
  return touch({ ...state, dailyReview: reserveDailyReview(state, today, mode, groupNumber, due.map(word => word.id)), modes: { ...state.modes, [mode]: { ...modeState, groupNumber, session } } }, now);
}

function journal(state: AppState, mode: Mode, action: UndoEntry['action'], id: string): UndoEntry {
  const modeState = state.modes[mode];
  const other = state.modes[otherMode(mode)];
  return {
    mode, wordId: id, action,
    previousProgress: own(modeState.progress, id) ? { ...own(modeState.progress, id)! } : null,
    previousSession: cloneSession(modeState.session)!, previousGroupNumber: modeState.groupNumber,
    previousOtherSession: cloneSession(other.session), previousOtherGroupNumber: other.groupNumber,
    wasSkipped: state.skipped.includes(id),
  };
}

function activeItem(state: AppState, mode: Mode, expectedToken: string | null): { session: StudySession; id: string } | null {
  if (!expectedToken || expectedToken !== getCurrentToken(state, mode)) return null;
  const session = state.modes[mode].session!;
  const id = session.items[session.cursor];
  return id ? { session, id } : null;
}

export function answer(state: AppState, mode: Mode, result: AnswerResult, expectedToken: string | null, now: number, localDateKey?: string): AppState {
  const active = activeItem(state, mode, expectedToken);
  if (!active || active.session.revealed || state.skipped.includes(active.id)) return state;
  const activityDate = localDateKey ?? getLocalDateKey(now);
  if (!isLocalDateKey(activityDate)) throw new Error('Invalid local date');
  const { session, id } = active;
  const modeState = state.modes[mode];
  const previous = own(modeState.progress, id);
  const progress: WordProgress = previous ? { ...previous } : {
    status: 'learning', wrongCount: 0, rightCount: 0, seenCount: 0,
    streak: 0, lastAnsweredAt: now, lastGroup: session.groupNumber,
  };
  progress.seenCount += 1;
  progress.lastAnsweredAt = now;
  progress.lastGroup = session.groupNumber;
  let nextSession: StudySession = { ...session };
  if (result === 'unknown') {
    progress.wrongCount += 1;
    progress.streak = 0;
    progress.status = 'learning';
    nextSession.unknown += 1;
    nextSession.revealed = true;
  } else {
    progress.rightCount += 1;
    if (!previous) {
      progress.status = 'completed';
      progress.streak = 2;
    } else {
      progress.streak = Math.min(2, progress.streak + 1) as 1 | 2;
      progress.status = progress.streak === 2 ? 'completed' : 'learning';
    }
    nextSession.known += 1;
    nextSession.cursor += 1;
    nextSession = advancePastSkipped(nextSession, new Set(state.skipped));
  }
  const day = state.dailyActivity[activityDate] ?? {};
  const previousDailyActivity = own(day, id);
  const activity = previousDailyActivity ? cloneDailyWordActivity(previousDailyActivity) : { look: { known: 0, unknown: 0 }, listen: { known: 0, unknown: 0 } };
  activity[mode][result] += 1;
  const trail = recordStudyTrail(state, mode, result, id, session, now);
  const dailyReview = completeDailyReview(state, mode, id, session.groupNumber, activityDate);
  return touch({
    ...state,
    modes: { ...state.modes, [mode]: { ...modeState, progress: { ...modeState.progress, [id]: progress }, session: nextSession } },
    dailyActivity: { ...state.dailyActivity, [activityDate]: { ...day, [id]: activity } },
    studyTrail: trail.studyTrail,
    dailyReview: dailyReview.dailyReview,
    history: [...state.history, {
      ...journal(state, mode, result, id), ...trail.undo, activityDate,
      previousDailyActivity: previousDailyActivity ? cloneDailyWordActivity(previousDailyActivity) : null,
      ...(dailyReview.change ? { dailyReviewChange: dailyReview.change } : {}),
    }].slice(-20),
  }, now);
}

/** Leaving a revealed answer is navigation, not another learning event. */
export function nextWord(state: AppState, mode: Mode, expectedToken: string | null, now: number): AppState {
  const active = activeItem(state, mode, expectedToken);
  if (!active?.session.revealed) return state;
  const modeState = state.modes[mode];
  const session = advancePastSkipped({ ...active.session, cursor: active.session.cursor + 1, revealed: false }, new Set(state.skipped));
  return touch({ ...state, modes: { ...state.modes, [mode]: { ...modeState, session } } }, now);
}

/** Excluding a word never counts as an incorrect answer. */
export function skipWord(state: AppState, mode: Mode, expectedToken: string | null, now: number): AppState {
  const active = activeItem(state, mode, expectedToken);
  if (!active || active.session.revealed || state.skipped.includes(active.id)) return state;
  const trail = recordStudyTrail(state, mode, 'skip', active.id, active.session, now);
  const entry = { ...journal(state, mode, 'skip', active.id), ...trail.undo };
  const skipped = [...state.skipped, active.id];
  const modeState = state.modes[mode];
  const session = advancePastSkipped(active.session, new Set(skipped));
  return touch({ ...state, settings: { ...state.settings, skipHintSeen: true }, skipped, studyTrail: trail.studyTrail, modes: { ...state.modes, [mode]: { ...modeState, session } }, history: [...state.history, entry].slice(-20) }, now);
}

/** Audio failure or a temporary pause: skip this encounter, preserve all learning counts. */
export function deferWord(state: AppState, mode: Mode, expectedToken: string | null, now: number): AppState {
  const active = activeItem(state, mode, expectedToken);
  if (!active || active.session.revealed) return state;
  const modeState = state.modes[mode];
  const session = advancePastSkipped({ ...active.session, cursor: active.session.cursor + 1, skipped: active.session.skipped + 1 }, new Set(state.skipped));
  const trail = recordStudyTrail(state, mode, 'defer', active.id, active.session, now);
  return touch({
    ...state, modes: { ...state.modes, [mode]: { ...modeState, session } },
    studyTrail: trail.studyTrail,
    history: [...state.history, { ...journal(state, mode, 'defer', active.id), ...trail.undo }].slice(-20),
  }, now);
}

export function getUndoMode(state: AppState): Mode | undefined { return state.history.at(-1)?.mode; }

export function undo(state: AppState, now: number): AppState {
  const entry = state.history.at(-1);
  if (!entry) return state;
  const modeState = state.modes[entry.mode];
  const progress = { ...modeState.progress };
  if (entry.previousProgress) progress[entry.wordId] = { ...entry.previousProgress };
  else delete progress[entry.wordId];
  const other = otherMode(entry.mode);
  const dailyActivity = { ...state.dailyActivity };
  if (entry.activityDate !== undefined && entry.previousDailyActivity !== undefined) {
    const day = { ...dailyActivity[entry.activityDate] };
    if (entry.previousDailyActivity) day[entry.wordId] = cloneDailyWordActivity(entry.previousDailyActivity);
    else delete day[entry.wordId];
    if (Object.keys(day).length) dailyActivity[entry.activityDate] = day;
    else delete dailyActivity[entry.activityDate];
  }
  return touch({
    ...state,
    dailyActivity,
    dailyReview: rewindDailyReview(state.dailyReview, entry),
    studyTrail: undoStudyTrail(state, entry),
    modes: {
      ...state.modes,
      [entry.mode]: { ...modeState, progress, session: cloneSession(entry.previousSession), groupNumber: entry.previousGroupNumber },
      [other]: { ...state.modes[other], session: cloneSession(entry.previousOtherSession), groupNumber: entry.previousOtherGroupNumber },
    },
    skipped: entry.wasSkipped ? [...new Set([...state.skipped, entry.wordId])] : state.skipped.filter(id => id !== entry.wordId),
    history: state.history.slice(0, -1),
  }, now);
}

export function restoreSkipped(state: AppState, id: string, now: number): AppState {
  if (!state.skipped.includes(id)) return state;
  // Manual queue edits form an undo boundary; old snapshots must not revive exclusions.
  return touch({ ...state, skipped: state.skipped.filter(value => value !== id), history: [] }, now);
}

export function updateSettings(state: AppState, patch: Partial<Settings>, now: number): AppState {
  const settings = settingsSchema.parse({ ...state.settings, ...patch });
  if (Object.keys(settings).every(key => settings[key as keyof Settings] === state.settings[key as keyof Settings])) return state;
  return touch({ ...state, settings }, now);
}

/** Re-open a completed word while preserving all historical answer counts. */
export function restartWord(state: AppState, id: string, mode: Mode, now: number): AppState {
  const modeState = state.modes[mode];
  const progress = own(modeState.progress, id);
  if (!progress || progress.status !== 'completed') return state;
  return touch({
    ...state, history: [], skipped: state.skipped.filter(value => value !== id),
    modes: { ...state.modes, [mode]: { ...modeState, progress: { ...modeState.progress, [id]: { ...progress, status: 'learning', streak: 0 } } } },
  }, now);
}

export function countProgress(state: AppState, mode: Mode): { completed: number; learning: number; wrong: number } {
  return Object.values(state.modes[mode].progress).reduce((counts, progress) => ({
    completed: counts.completed + Number(progress.status === 'completed'),
    learning: counts.learning + Number(progress.status === 'learning'),
    wrong: counts.wrong + progress.wrongCount,
  }), { completed: 0, learning: 0, wrong: 0 });
}

export { MODES };
