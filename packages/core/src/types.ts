export type Mode = 'look' | 'listen';
export type Deck = 'all' | 'cet4' | 'cet6' | 'ky' | 'toefl' | 'ielts' | 'gre';
export type AnswerResult = 'known' | 'unknown';

export interface Word {
  id: string;
  word: string;
  translation: string;
  phonetic: string;
  tags: string[];
  rank: number;
  basic: boolean;
}

export interface Settings {
  groupSize: 10 | 20 | 30;
  skipBasic: boolean;
  deck: Deck;
  accent: 'en-US' | 'en-GB';
  voiceURI: string;
  rate: number;
  autoSpeak: boolean;
  skipHintSeen: boolean;
  haptics: boolean;
  soundEffects: boolean;
  retentionEnabled: boolean;
  retentionDailyLimit: 10 | 20 | 30;
}

export interface WordProgress {
  status: 'learning' | 'completed';
  wrongCount: number;
  rightCount: number;
  seenCount: number;
  streak: 0 | 1 | 2;
  lastAnsweredAt: number;
  lastGroup: number;
}

export interface StudySession {
  groupNumber: number;
  items: string[];
  cursor: number;
  revealed: boolean;
  status: 'active' | 'finished';
  known: number;
  unknown: number;
  skipped: number;
  retentionIds?: string[];
  retentionDate?: string;
}

export interface RetentionProgress {
  stage: 0 | 1 | 2 | 3 | 4;
  dueOn: string | null;
  lastConfirmedOn?: string;
  lapses: number;
}

export interface RetentionMarker {
  groupNumber: number;
  firstGroupNumber: number;
  completed: boolean;
  failed: boolean;
  completedOn?: string;
}

export interface RetentionDay {
  extraAllowance: number;
  baseLimit: 10 | 20 | 30;
  look: Record<string, RetentionMarker>;
  listen: Record<string, RetentionMarker>;
}

export interface RetentionSummary {
  due: number;
  totalDue: number;
  completedToday: number;
  scheduledToday: number;
  remainingAllowance: number;
  dailyLimit: number;
  available: number;
  unreservedDue: number;
}

export interface ModeState {
  progress: Record<string, WordProgress>;
  session: StudySession | null;
  groupNumber: number;
  retention: Record<string, RetentionProgress>;
}

export interface ActivityCounts {
  known: number;
  unknown: number;
}

/** Real answers grouped by the local date supplied at answer time. */
export type DailyWordActivity = Record<Mode, ActivityCounts>;
export type DailyActivity = Record<string, Record<string, DailyWordActivity>>;

export interface StudyDay {
  date: string;
  wordCount: number;
  known: number;
  unknown: number;
}

export interface DailyStudyWord extends ActivityCounts {
  wordId: string;
  modes: Mode[];
}

export interface DailyStudySummary extends StudyDay {
  words: DailyStudyWord[];
}

/** A real encounter retained for read-only browsing, separate from the undo journal. */
export interface StudyTrailEntry {
  id: number;
  mode: Mode;
  wordId: string;
  groupNumber: number;
  position: number;
  action: AnswerResult | 'skip' | 'defer';
  revealed: boolean;
  recordedAt: number;
}

export interface DailyReviewEntry {
  groupNumber: number;
  completed: boolean;
}

export type DailyReview = Record<string, Record<Mode, Record<string, DailyReviewEntry>>>;

export interface YesterdayReviewCounts {
  total: number;
  queued: number;
  completed: number;
  pending: number;
  available: number;
}

export interface StudyPlanDay {
  newTarget: number;
  newWordIds: string[];
  reviewWordIds: string[];
  reviewedWordIds: string[];
  checkedInAt?: number;
  checkedInTargets?: { newWords: number; reviewWordIds: string[] };
  celebratedAt?: number;
}

export interface StudyPlan {
  deck: Deck;
  mode: Mode;
  skipBasic: boolean;
  createdOn: string;
  startedOn: string;
  deadline: string;
  updatedAt: number;
  scopeIds: string[];
  days: Record<string, StudyPlanDay>;
}

export interface StudyPlanAnswerChange {
  key: string;
  date: string;
  newAdded: boolean;
  reviewAdded: boolean;
}

export interface StudyPlanSummary {
  plan: StudyPlan;
  day: StudyPlanDay;
  dayRecorded: boolean;
  totalDays: number;
  remainingDays: number;
  overdue: boolean;
  totalWords: number;
  encounteredWords: number;
  remainingNewWords: number;
  newTarget: number;
  newCompleted: number;
  reviewTarget: number;
  reviewCompleted: number;
  pendingNew: number;
  pendingReview: number;
  remainingToday: number;
  canCheckIn: boolean;
  checkedIn: boolean;
  hasActivity: boolean;
  celebratedAt?: number;
}

// A bounded journal of deltas, never recursive copies of AppState.
export interface UndoEntry {
  mode: Mode;
  wordId: string;
  action: AnswerResult | 'skip' | 'defer';
  previousProgress: WordProgress | null;
  previousSession: StudySession;
  previousGroupNumber: number;
  previousOtherSession: StudySession | null;
  previousOtherGroupNumber: number;
  wasSkipped: boolean;
  // Absent on entries from backups created before calendar tracking existed.
  activityDate?: string;
  previousDailyActivity?: DailyWordActivity | null;
  studyTrailId?: number;
  evictedStudyTrailEntry?: StudyTrailEntry;
  dailyReviewChange?: { date: string; previous: DailyReviewEntry | null };
  planChanges?: StudyPlanAnswerChange[];
  retentionChange?: {
    previous: RetentionProgress | null;
    date?: string;
    previousMarker?: RetentionMarker;
  };
}

export interface AppState {
  schemaVersion: 1;
  dictionaryVersion: string;
  revision: number;
  updatedAt: number;
  settings: Settings;
  modes: Record<Mode, ModeState>;
  skipped: string[];
  history: UndoEntry[];
  dailyActivity: DailyActivity;
  studyTrail: StudyTrailEntry[];
  dailyReview: DailyReview;
  studyPlans: Record<string, StudyPlan>;
  retentionDays: Record<string, RetentionDay>;
}

export const DEFAULT_SETTINGS: Settings = {
  groupSize: 20,
  skipBasic: true,
  deck: 'all',
  accent: 'en-US',
  voiceURI: '',
  rate: 0.9,
  autoSpeak: true,
  skipHintSeen: false,
  haptics: true,
  soundEffects: true,
  retentionEnabled: true,
  retentionDailyLimit: 20,
};

export const MODES: readonly Mode[] = ['look', 'listen'];
