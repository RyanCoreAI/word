import type { AppState, Mode, StudySession, StudyTrailEntry, UndoEntry } from './types';

/** Shared across modes; oldest encounters expire without changing learning progress. */
export const MAX_STUDY_TRAIL = 1_000;

/** Only called in the same state transaction as an accepted answer/skip/defer. */
export function recordStudyTrail(state: AppState, mode: Mode, action: StudyTrailEntry['action'], wordId: string, session: StudySession, now: number): {
  studyTrail: StudyTrailEntry[];
  undo: Pick<UndoEntry, 'studyTrailId' | 'evictedStudyTrailEntry'>;
} {
  // Backup restoration rebases CAS revisions; retained encounter ids must stay unique.
  const id = Math.max(state.revision + 1, (state.studyTrail.at(-1)?.id ?? 0) + 1);
  if (!Number.isSafeInteger(id)) throw new Error('Study trail identifiers exhausted');
  const entry: StudyTrailEntry = {
    id, mode, wordId, groupNumber: session.groupNumber,
    position: session.cursor, action, revealed: action === 'known' || action === 'unknown', recordedAt: now,
  };
  const evicted = state.studyTrail.length === MAX_STUDY_TRAIL ? state.studyTrail[0] : undefined;
  return {
    studyTrail: [...state.studyTrail, entry].slice(-MAX_STUDY_TRAIL),
    undo: { studyTrailId: entry.id, ...(evicted ? { evictedStudyTrailEntry: { ...evicted } } : {}) },
  };
}

export function undoStudyTrail(state: AppState, undo: UndoEntry): StudyTrailEntry[] {
  if (undo.studyTrailId === undefined) return state.studyTrail;
  const retained = state.studyTrail.filter(entry => entry.id !== undo.studyTrailId);
  return undo.evictedStudyTrailEntry ? [{ ...undo.evictedStudyTrailEntry }, ...retained] : retained;
}

/** The live revealed unknown is already on screen, so do not offer it twice. */
export function getStudyTrail(state: AppState, mode: Mode): readonly StudyTrailEntry[] {
  const session = state.modes[mode].session;
  return state.studyTrail.filter(entry => entry.mode === mode && !(
    session?.status === 'active' && session.revealed && entry.action === 'unknown'
    && entry.groupNumber === session.groupNumber && entry.position === session.cursor
    && entry.wordId === session.items[session.cursor]
  ));
}

/** Offset zero is the live position; positive offsets browse older encounters. */
export function getStudyHistoryEntry(state: AppState, mode: Mode, offset: number): Readonly<StudyTrailEntry> | undefined {
  if (!Number.isSafeInteger(offset) || offset < 1) return undefined;
  return getStudyTrail(state, mode).at(-offset);
}

/** Never permits a swipe past the live learning position or the retained history. */
export function moveStudyHistoryOffset(state: AppState, mode: Mode, offset: number, direction: 'previous' | 'next'): number {
  const length = getStudyTrail(state, mode).length;
  const current = Number.isSafeInteger(offset) ? Math.max(0, Math.min(length, offset)) : 0;
  return Math.max(0, Math.min(length, current + (direction === 'previous' ? 1 : -1)));
}
