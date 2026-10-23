import { isLocalDateKey } from './activity';
import { getYesterdayReviewWordIds, previousLocalDateKey } from './daily-review';
import type { AppState, Deck, Mode, StudyPlan, StudyPlanAnswerChange, StudyPlanDay, StudyPlanSummary, UndoEntry, Word } from './types';

export const STUDY_PLAN_DECKS: readonly Deck[] = ['all', 'cet4', 'cet6', 'ky', 'toefl', 'ielts', 'gre'];
export const MAX_STUDY_PLAN_DAYS = 3660;
export const MAX_STUDY_PLANS = STUDY_PLAN_DECKS.length * 2;
const own = <T>(record: Record<string, T>, key: string): T | undefined => Object.hasOwn(record, key) ? record[key] : undefined;

function assertDate(date: string): void { if (!isLocalDateKey(date)) throw new Error('Invalid study plan date'); }
function dayDistance(from: string, to: string): number {
  assertDate(from); assertDate(to);
  return Math.round((Date.parse(`${to}T00:00:00.000Z`) - Date.parse(`${from}T00:00:00.000Z`)) / 86_400_000);
}
function revise(state: AppState, studyPlans: AppState['studyPlans'], now: number): AppState {
  if (!Number.isSafeInteger(now) || now < 0) throw new Error('Invalid study plan timestamp');
  if (state.revision >= Number.MAX_SAFE_INTEGER) throw new Error('Revision exhausted');
  return { ...state, studyPlans, revision: state.revision + 1, updatedAt: now };
}

export function studyPlanKey(deck: Deck, mode: Mode): string {
  if (!STUDY_PLAN_DECKS.includes(deck) || mode !== 'look' && mode !== 'listen') throw new Error('Invalid study plan scope');
  return `${deck}:${mode}`;
}

function eligibleIds(state: AppState, plan: StudyPlan): string[] {
  const skipped = new Set(state.skipped);
  return plan.scopeIds.filter(id => !skipped.has(id));
}
function hasAnswer(state: AppState, date: string, mode: Mode, id: string): boolean {
  const activity = own(state.dailyActivity[date] ?? {}, id)?.[mode];
  return !!activity && activity.known + activity.unknown > 0;
}

function createDay(state: AppState, plan: StudyPlan, today: string, previous?: StudyPlanDay): StudyPlanDay {
  const ids = eligibleIds(state, plan);
  const scope = new Set(ids);
  const newCompleted = (previous?.newWordIds ?? []).filter(id => scope.has(id)).length;
  const remaining = ids.filter(id => !own(state.modes[plan.mode].progress, id)).length;
  const days = Math.max(1, dayDistance(today, plan.deadline) + 1);
  const reviewWordIds = getYesterdayReviewWordIds(state, today, plan.mode).filter(id => scope.has(id));
  const reviewed = new Set(previous?.reviewedWordIds ?? []);
  for (const id of reviewWordIds) if (hasAnswer(state, today, plan.mode, id)) reviewed.add(id);
  const day: StudyPlanDay = {
    newTarget: Math.ceil((remaining + newCompleted) / days),
    newWordIds: [...previous?.newWordIds ?? []], reviewWordIds, reviewedWordIds: [...reviewed],
    ...(previous?.celebratedAt !== undefined ? { celebratedAt: previous.celebratedAt } : {}),
  };
  if (previous?.checkedInAt !== undefined) day.checkedInAt = previous.checkedInAt;
  if (previous?.checkedInTargets) day.checkedInTargets = { newWords: previous.checkedInTargets.newWords, reviewWordIds: [...previous.checkedInTargets.reviewWordIds] };
  if (day.checkedInAt !== undefined && counts(state, plan, day).remainingToday > 0) {
    delete day.checkedInAt; delete day.checkedInTargets;
  }
  return invalidateCheckIn(day);
}

function counts(state: AppState, plan: StudyPlan, day: StudyPlanDay) {
  const ids = eligibleIds(state, plan);
  const scope = new Set(ids);
  const encounteredWords = ids.filter(id => !!own(state.modes[plan.mode].progress, id)).length;
  const remainingNewWords = ids.length - encounteredWords;
  const newCompleted = day.newWordIds.filter(id => scope.has(id)).length;
  // A later slash must not leave a fixed target impossible to finish.
  const newTarget = Math.min(day.newTarget, remainingNewWords + newCompleted);
  const reviews = day.reviewWordIds.filter(id => scope.has(id));
  const reviewed = new Set(day.reviewedWordIds);
  const reviewCompleted = reviews.filter(id => reviewed.has(id)).length;
  const pendingNew = Math.max(0, newTarget - newCompleted);
  const pendingReview = reviews.length - reviewCompleted;
  return { totalWords: ids.length, encounteredWords, remainingNewWords, newTarget, newCompleted, reviewTarget: reviews.length, reviewCompleted, pendingNew, pendingReview, remainingToday: pendingNew + pendingReview, hasActivity: newCompleted + reviewCompleted > 0 };
}

function invalidateCheckIn(day: StudyPlanDay): StudyPlanDay {
  const targets = day.checkedInTargets;
  if (day.checkedInAt === undefined || targets && day.newWordIds.length >= targets.newWords && targets.reviewWordIds.every(id => day.reviewedWordIds.includes(id))) return day;
  const next = { ...day };
  delete next.checkedInAt; delete next.checkedInTargets;
  return next;
}

export interface SaveStudyPlanInput { deck: Deck; mode: Mode; deadline: string; skipBasic?: boolean; restart?: boolean }

/** Save a concrete book/filter snapshot. Editing it never clears word progress. */
export function saveStudyPlan(state: AppState, words: readonly Word[], input: SaveStudyPlanInput, now: number, today: string): AppState {
  assertDate(today); assertDate(input.deadline);
  const remainingDays = dayDistance(today, input.deadline) + 1;
  if (remainingDays < 1 || remainingDays > MAX_STUDY_PLAN_DAYS) throw new Error('请选择今天起十年内的截止日期。');
  const key = studyPlanKey(input.deck, input.mode);
  const previous = own(state.studyPlans, key);
  if (previous && today < previous.createdOn) throw new Error('当前日期早于计划创建日期，请检查设备时间。');
  const skipBasic = input.skipBasic ?? state.settings.skipBasic;
  if (typeof skipBasic !== 'boolean') throw new Error('Invalid study plan basic filter');
  const skipped = new Set(state.skipped);
  const scopeIds = words.filter(word => !skipped.has(word.id) && (!skipBasic || !word.basic) && (input.deck === 'all' || word.tags.includes(input.deck))).map(word => word.id);
  if (scopeIds.length > 100_000 || new Set(scopeIds).size !== scopeIds.length) throw new Error('Invalid study plan word scope');
  const plan: StudyPlan = {
    deck: input.deck, mode: input.mode, skipBasic,
    createdOn: previous?.createdOn ?? today,
    startedOn: !previous || input.restart ? today : previous.startedOn,
    deadline: input.deadline, updatedAt: now, scopeIds, days: { ...previous?.days },
  };
  if (dayDistance(plan.startedOn, plan.deadline) + 1 > MAX_STUDY_PLAN_DAYS) throw new Error('学习计划跨度不得超过十年。');
  plan.days[today] = createDay(state, plan, today, previous?.days[today]);
  if (Object.keys(plan.days).length > MAX_STUDY_PLAN_DAYS) throw new Error('学习计划记录已达上限，请先导出备份。');
  return revise(state, { ...state.studyPlans, [key]: plan }, now);
}

/** Persist today's quota once; later answers cannot keep lowering the target. */
export function ensureStudyPlanDay(state: AppState, _words: readonly Word[], deck: Deck, mode: Mode, now: number, today: string): AppState {
  assertDate(today);
  const key = studyPlanKey(deck, mode);
  const plan = own(state.studyPlans, key);
  if (!plan || own(plan.days, today) || today < plan.startedOn) return state;
  if (Object.keys(plan.days).length >= MAX_STUDY_PLAN_DAYS) throw new Error('学习计划记录已达上限，请先导出备份。');
  return revise(state, { ...state.studyPlans, [key]: { ...plan, updatedAt: now, days: { ...plan.days, [today]: createDay(state, plan, today) } } }, now);
}

export function getStudyPlanSummary(state: AppState, _words: readonly Word[], deck: Deck, mode: Mode, today: string): StudyPlanSummary | null {
  assertDate(today);
  const plan = own(state.studyPlans, studyPlanKey(deck, mode));
  if (!plan) return null;
  const savedDay = own(plan.days, today);
  const day = savedDay ?? createDay(state, plan, today);
  const result = counts(state, plan, day);
  const canCheckIn = today >= plan.startedOn && result.remainingToday === 0;
  return {
    plan, day, dayRecorded: !!savedDay,
    totalDays: Math.max(1, dayDistance(plan.startedOn, plan.deadline) + 1),
    remainingDays: Math.max(0, dayDistance(today, plan.deadline) + 1), overdue: today > plan.deadline,
    ...result, canCheckIn, checkedIn: canCheckIn && day.checkedInAt !== undefined,
    ...(day.celebratedAt !== undefined ? { celebratedAt: day.celebratedAt } : {}),
  };
}

export function checkInStudyPlan(state: AppState, words: readonly Word[], deck: Deck, mode: Mode, now: number, today: string): AppState {
  const summary = getStudyPlanSummary(state, words, deck, mode, today);
  if (!summary?.canCheckIn || summary.checkedIn) return state;
  const key = studyPlanKey(deck, mode);
  const scope = new Set(eligibleIds(state, summary.plan));
  const plan = { ...summary.plan, updatedAt: now, days: { ...summary.plan.days, [today]: { ...summary.day, checkedInAt: now, checkedInTargets: { newWords: summary.newTarget, reviewWordIds: summary.day.reviewWordIds.filter(id => scope.has(id)) } } } };
  return revise(state, { ...state.studyPlans, [key]: plan }, now);
}

/** Claim before a UI effect, and play it only after this state is durably saved. */
export function markStudyPlanCelebrated(state: AppState, words: readonly Word[], deck: Deck, mode: Mode, now: number, today: string): AppState {
  const summary = getStudyPlanSummary(state, words, deck, mode, today);
  if (!summary?.canCheckIn || !summary.hasActivity || summary.celebratedAt !== undefined) return state;
  const key = studyPlanKey(deck, mode);
  const plan = { ...summary.plan, updatedAt: now, days: { ...summary.plan.days, [today]: { ...summary.day, celebratedAt: now } } };
  return revise(state, { ...state.studyPlans, [key]: plan }, now);
}

/** Called with pre-answer state so a new-day quota uses its real starting balance. */
export function recordStudyPlanAnswer(state: AppState, mode: Mode, wordId: string, today: string, firstAnswer: boolean): { studyPlans: AppState['studyPlans']; changes: StudyPlanAnswerChange[] } {
  let studyPlans = state.studyPlans;
  const changes: StudyPlanAnswerChange[] = [];
  for (const [key, plan] of Object.entries(state.studyPlans)) {
    if (plan.mode !== mode || today < plan.startedOn || !plan.scopeIds.includes(wordId) || state.skipped.includes(wordId)) continue;
    const day = own(plan.days, today) ?? createDay(state, plan, today);
    const newAdded = firstAnswer && !day.newWordIds.includes(wordId);
    const reviewAdded = day.reviewWordIds.includes(wordId) && !day.reviewedWordIds.includes(wordId);
    if (!newAdded && !reviewAdded && own(plan.days, today)) continue;
    if (!own(plan.days, today) && Object.keys(plan.days).length >= MAX_STUDY_PLAN_DAYS) throw new Error('学习计划记录已达上限，请先导出备份。');
    const nextDay: StudyPlanDay = { ...day, newWordIds: newAdded ? [...day.newWordIds, wordId] : day.newWordIds, reviewedWordIds: reviewAdded ? [...day.reviewedWordIds, wordId] : day.reviewedWordIds };
    studyPlans = { ...studyPlans, [key]: { ...plan, days: { ...plan.days, [today]: nextDay } } };
    if (newAdded || reviewAdded) changes.push({ key, date: today, newAdded, reviewAdded });
  }
  return { studyPlans, changes };
}

/** Rewind counts and check-in, preserving the receipt for an already shown effect. */
export function rewindStudyPlans(state: AppState, entry: UndoEntry): AppState['studyPlans'] {
  const plans: AppState['studyPlans'] = {};
  for (const [key, plan] of Object.entries(state.studyPlans)) {
    const days: StudyPlan['days'] = {};
    const latestDate = Object.keys(plan.days).sort().at(-1);
    for (const [date, original] of Object.entries(plan.days)) {
      const change = entry.planChanges?.find(item => item.key === key && item.date === date);
      const yesterday = previousLocalDateKey(date);
      let day: StudyPlanDay = {
        ...original,
        newWordIds: change?.newAdded ? original.newWordIds.filter(id => id !== entry.wordId) : original.newWordIds,
        reviewWordIds: original.reviewWordIds.filter(id => (own(state.dailyActivity[yesterday] ?? {}, id)?.[plan.mode].unknown ?? 0) > 0),
        reviewedWordIds: original.reviewedWordIds.filter(id => !(change?.reviewAdded && id === entry.wordId) && hasAnswer(state, date, plan.mode, id)),
      };
      day = invalidateCheckIn(day);
      if (day.checkedInAt !== undefined && (date === entry.activityDate || date === latestDate) && counts(state, plan, day).remainingToday > 0) {
        delete day.checkedInAt; delete day.checkedInTargets;
      }
      days[date] = day;
    }
    plans[key] = { ...plan, days };
  }
  return plans;
}

export function reconcileStudyPlanCheckIns(state: AppState): AppState['studyPlans'] {
  return Object.fromEntries(Object.entries(state.studyPlans).map(([key, plan]) => {
    const latestDate = Object.keys(plan.days).sort().at(-1);
    return [key, { ...plan, days: Object.fromEntries(Object.entries(plan.days).map(([date, original]) => {
      const day = { ...invalidateCheckIn(original) };
      if (day.checkedInAt !== undefined && date === latestDate && counts(state, plan, day).remainingToday > 0) { delete day.checkedInAt; delete day.checkedInTargets; }
      return [date, day];
    })) }];
  }));
}
