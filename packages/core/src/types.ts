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
}

export interface ModeState {
  progress: Record<string, WordProgress>;
  session: StudySession | null;
  groupNumber: number;
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
};

export const MODES: readonly Mode[] = ['look', 'listen'];
