import { z } from 'zod';
import { isLocalDateKey } from './activity';
import { MAX_STUDY_TRAIL } from './navigation';
import { previousLocalDateKey, rewindDailyReview } from './daily-review';
import { MAX_STUDY_PLAN_DAYS, MAX_STUDY_PLANS, rewindStudyPlans, studyPlanKey } from './study-plan';
import type { AppState, StudySession, Word, WordProgress } from './types';

export const MAX_WORDS = 1_000_000;
export const MAX_BACKUP_BYTES = 16 * 1024 * 1024;
const integer = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
const counter = z.number().int().nonnegative().max(10_000_000);
const idSchema = z.string().min(1).max(256).refine(value => value !== '__proto__', 'Invalid word identifier');
const idsSchema = z.array(idSchema).max(MAX_WORDS).refine(ids => new Set(ids).size === ids.length, 'Duplicate word identifiers');
export const localDateKeySchema = z.string().refine(isLocalDateKey, 'Invalid local calendar date');
const activityCountsSchema = z.object({ known: counter, unknown: counter }).strict();
export const dailyWordActivitySchema = z.object({ look: activityCountsSchema, listen: activityCountsSchema }).strict()
  .refine(value => value.look.known + value.look.unknown + value.listen.known + value.listen.unknown > 0, 'Daily word has no answers');
const dailyActivitySchema = z.record(localDateKeySchema, z.record(idSchema, dailyWordActivitySchema)
  .refine(value => Object.keys(value).length > 0 && Object.keys(value).length <= MAX_WORDS, 'Invalid daily word count'))
  .refine(value => Object.keys(value).length <= 100_000, 'Too many calendar dates');
const dailyReviewEntrySchema = z.object({ groupNumber: integer.positive(), completed: z.boolean() }).strict();
const reviewWordsSchema = z.record(idSchema, dailyReviewEntrySchema).refine(value => Object.keys(value).length <= MAX_WORDS, 'Too many daily review words');
const dailyReviewSchema = z.record(localDateKeySchema, z.object({ look: reviewWordsSchema, listen: reviewWordsSchema }).strict())
  .refine(value => Object.keys(value).length <= 100_000, 'Too many daily review dates');
const planIdsSchema = z.array(idSchema).max(100_000).refine(ids => new Set(ids).size === ids.length, 'Duplicate study plan words');
export const studyPlanDaySchema = z.object({
  newTarget: integer.max(100_000), newWordIds: planIdsSchema, reviewWordIds: planIdsSchema, reviewedWordIds: planIdsSchema,
  checkedInAt: integer.optional(), celebratedAt: integer.optional(),
  checkedInTargets: z.object({ newWords: integer.max(100_000), reviewWordIds: planIdsSchema }).strict().optional(),
}).strict().refine(value => (value.checkedInAt === undefined) === (value.checkedInTargets === undefined), 'Incomplete study plan check-in receipt');
export const studyPlanSchema = z.object({
  deck: z.enum(['all', 'cet4', 'cet6', 'ky', 'toefl', 'ielts', 'gre']), mode: z.enum(['look', 'listen']), skipBasic: z.boolean(),
  createdOn: localDateKeySchema, startedOn: localDateKeySchema, deadline: localDateKeySchema, updatedAt: integer,
  scopeIds: planIdsSchema,
  days: z.record(localDateKeySchema, studyPlanDaySchema).refine(value => Object.keys(value).length <= MAX_STUDY_PLAN_DAYS, 'Too many study plan dates'),
}).strict().refine(value => value.createdOn <= value.startedOn && value.startedOn <= value.deadline, 'Invalid study plan date order')
  .refine(value => (Date.parse(`${value.deadline}T00:00:00.000Z`) - Date.parse(`${value.startedOn}T00:00:00.000Z`)) / 86_400_000 + 1 <= MAX_STUDY_PLAN_DAYS, 'Study plan span is too long');
const studyPlansSchema = z.record(z.string().regex(/^(all|cet4|cet6|ky|toefl|ielts|gre):(look|listen)$/), studyPlanSchema)
  .refine(value => Object.keys(value).length <= MAX_STUDY_PLANS, 'Too many study plans');
const planAnswerChangeSchema = z.object({
  key: z.string().regex(/^(all|cet4|cet6|ky|toefl|ielts|gre):(look|listen)$/), date: localDateKeySchema,
  newAdded: z.boolean(), reviewAdded: z.boolean(),
}).strict().refine(value => value.newAdded || value.reviewAdded, 'Empty study plan undo delta');

export const wordSchema = z.object({
  id: idSchema, word: z.string().min(1).max(500), translation: z.string().max(100_000),
  phonetic: z.string().max(2_000), tags: z.array(z.string().min(1).max(40)).max(40),
  rank: integer, basic: z.boolean(),
}).strict();

export const settingsSchema = z.object({
  groupSize: z.union([z.literal(10), z.literal(20), z.literal(30)]),
  skipBasic: z.boolean(), deck: z.enum(['all', 'cet4', 'cet6', 'ky', 'toefl', 'ielts', 'gre']),
  accent: z.enum(['en-US', 'en-GB']), voiceURI: z.string().max(2_000),
  rate: z.number().min(0.5).max(1.5), autoSpeak: z.boolean(),
  skipHintSeen: z.boolean().default(false),
  haptics: z.boolean().default(true), soundEffects: z.boolean().default(true),
}).strict();

export const wordProgressSchema = z.object({
  status: z.enum(['learning', 'completed']), wrongCount: counter, rightCount: counter,
  seenCount: counter, streak: z.union([z.literal(0), z.literal(1), z.literal(2)]),
  lastAnsweredAt: integer, lastGroup: integer,
}).strict().superRefine((value, ctx) => {
  if (!value.seenCount || value.seenCount !== value.rightCount + value.wrongCount) ctx.addIssue({ code: 'custom', message: 'Answer counters are inconsistent' });
  if (value.status === 'completed' && (value.streak !== 2 || !value.rightCount)) ctx.addIssue({ code: 'custom', message: 'Completed progress requires a successful answer' });
  if (value.status === 'completed' && value.wrongCount > 0 && value.rightCount < 2) ctx.addIssue({ code: 'custom', message: 'Reviewed completion requires two successful answers' });
  if (value.status === 'learning' && (value.streak === 2 || value.streak > value.rightCount)) ctx.addIssue({ code: 'custom', message: 'Learning streak is inconsistent' });
  if (value.lastGroup < 1) ctx.addIssue({ code: 'custom', message: 'Answered words require a group' });
});

export const sessionSchema = z.object({
  groupNumber: integer, items: idsSchema, cursor: integer, revealed: z.boolean(),
  status: z.enum(['active', 'finished']), known: counter, unknown: counter, skipped: counter,
}).strict().superRefine((value, ctx) => {
  if (value.cursor > value.items.length) ctx.addIssue({ code: 'custom', message: 'Cursor exceeds group size' });
  if (value.status === 'active' && (value.cursor >= value.items.length || !value.groupNumber)) ctx.addIssue({ code: 'custom', message: 'Active group has no current word' });
  if (value.status === 'finished' && (value.cursor !== value.items.length || value.revealed)) ctx.addIssue({ code: 'custom', message: 'Finished group has unfinished work' });
  if (value.known + value.unknown + value.skipped !== value.cursor + Number(value.revealed)) ctx.addIssue({ code: 'custom', message: 'Group counters do not match position' });
  if (value.revealed && !value.unknown) ctx.addIssue({ code: 'custom', message: 'Revealed answer has not been counted' });
});

const modeStateSchema = z.object({
  progress: z.record(idSchema, wordProgressSchema).refine(value => Object.keys(value).length <= MAX_WORDS, 'Too many progress records'),
  session: sessionSchema.nullable(), groupNumber: integer,
}).strict();

export const studyTrailEntrySchema = z.object({
  id: integer.positive(), mode: z.enum(['look', 'listen']), wordId: idSchema,
  groupNumber: integer.positive(), position: integer.max(MAX_WORDS),
  action: z.enum(['known', 'unknown', 'skip', 'defer']), revealed: z.boolean(), recordedAt: integer,
}).strict().refine(value => value.revealed === (value.action === 'known' || value.action === 'unknown'), 'Trail reveal state does not match its action');

export const undoEntrySchema = z.object({
  mode: z.enum(['look', 'listen']), wordId: idSchema, action: z.enum(['known', 'unknown', 'skip', 'defer']),
  previousProgress: wordProgressSchema.nullable(), previousSession: sessionSchema,
  previousGroupNumber: integer, previousOtherSession: sessionSchema.nullable(), previousOtherGroupNumber: integer,
  wasSkipped: z.boolean(),
  activityDate: localDateKeySchema.optional(), previousDailyActivity: dailyWordActivitySchema.nullable().optional(),
  studyTrailId: integer.positive().optional(), evictedStudyTrailEntry: studyTrailEntrySchema.optional(),
  dailyReviewChange: z.object({ date: localDateKeySchema, previous: dailyReviewEntrySchema.nullable() }).strict().optional(),
  planChanges: z.array(planAnswerChangeSchema).min(1).max(MAX_STUDY_PLANS)
    .refine(value => new Set(value.map(item => item.key)).size === value.length, 'Duplicate study plan undo delta').optional(),
}).strict().superRefine((value, ctx) => {
  if ((value.activityDate === undefined) !== (value.previousDailyActivity === undefined)) ctx.addIssue({ code: 'custom', message: 'Incomplete calendar undo snapshot' });
  if (value.activityDate !== undefined && value.action !== 'known' && value.action !== 'unknown') ctx.addIssue({ code: 'custom', message: 'Only answers update the calendar' });
  if (value.evictedStudyTrailEntry && (value.studyTrailId === undefined || value.evictedStudyTrailEntry.id >= value.studyTrailId)) ctx.addIssue({ code: 'custom', message: 'Invalid evicted trail snapshot' });
  if (value.dailyReviewChange && (value.action !== 'known' && value.action !== 'unknown' || value.dailyReviewChange.previous && (value.dailyReviewChange.previous.completed || value.dailyReviewChange.previous.groupNumber !== value.previousGroupNumber))) ctx.addIssue({ code: 'custom', message: 'Invalid daily review undo snapshot' });
  if (value.planChanges && (value.action !== 'known' && value.action !== 'unknown' || value.planChanges.some(item => item.date !== value.activityDate || !item.key.endsWith(`:${value.mode}`) || item.newAdded && value.previousProgress !== null))) ctx.addIssue({ code: 'custom', message: 'Invalid study plan undo delta' });
});

export const appStateSchema = z.object({
  schemaVersion: z.literal(1), dictionaryVersion: z.string().min(1).max(200), revision: integer, updatedAt: integer,
  settings: settingsSchema,
  modes: z.object({ look: modeStateSchema, listen: modeStateSchema }).strict(),
  skipped: idsSchema, history: z.array(undoEntrySchema).max(20),
  dailyActivity: dailyActivitySchema.default({}),
  studyTrail: z.array(studyTrailEntrySchema).max(MAX_STUDY_TRAIL).default([]),
  dailyReview: dailyReviewSchema.default({}),
  studyPlans: studyPlansSchema.default({}),
}).strict();

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(`学习数据校验失败：${message}`);
}

function sameProgress(left: WordProgress | undefined, right: WordProgress | null): boolean {
  if (!left || !right) return !left && !right;
  return Object.keys(left).every(key => left[key as keyof WordProgress] === right[key as keyof WordProgress]);
}

/** Validate external state completely before replacing existing browser progress. */
export function parseAppState(input: unknown, words: readonly Word[], dictionaryVersion: string): AppState {
  const state: AppState = appStateSchema.parse(input);
  assert(state.dictionaryVersion === dictionaryVersion, '词典版本不匹配，原进度未替换');
  assert(words.length <= MAX_WORDS, '词典过大');
  const ids = new Set(words.map(word => word.id));
  assert(ids.size === words.length, '词典包含重复标识');
  const reference = (id: string): void => assert(ids.has(id), `找不到词条 ${id}`);
  const checkSession = (session: StudySession | null, groupNumber: number): void => {
    if (!session) return;
    assert(session.groupNumber === groupNumber, '分组序号不一致');
    session.items.forEach(reference);
  };
  for (const mode of ['look', 'listen'] as const) {
    const current = state.modes[mode];
    Object.entries(current.progress).forEach(([id, value]) => {
      reference(id);
      assert(value.lastGroup <= current.groupNumber, '单词记录来自未来分组');
    });
    checkSession(current.session, current.groupNumber);
    if (current.session?.revealed) {
      const progress = current.progress[current.session.items[current.session.cursor]!];
      assert(progress?.status === 'learning' && progress.streak === 0 && progress.wrongCount > 0, '揭晓状态与单词记录不一致');
      assert(progress.lastGroup === current.groupNumber, '揭晓状态来自其他分组');
    }
  }
  state.skipped.forEach(reference);
  // Replay inverse deltas on small mutable maps to reject forged/corrupt undo stacks.
  const progressByMode = { look: { ...state.modes.look.progress }, listen: { ...state.modes.listen.progress } };
  const skipped = new Set(state.skipped);
  const dailyActivity = { ...state.dailyActivity };
  let dailyReview = state.dailyReview;
  let studyPlans = state.studyPlans;
  const wordMap = new Map(words.map(word => [word.id, word]));
  const checkStudyPlans = (): void => {
    for (const [key, plan] of Object.entries(studyPlans)) {
      assert(key === studyPlanKey(plan.deck, plan.mode), '学习计划词书或模式不匹配');
      const bookWord = (id: string): void => {
        reference(id);
        assert(plan.deck === 'all' || wordMap.get(id)!.tags.includes(plan.deck), '学习计划包含其他词书词条');
      };
      for (const id of plan.scopeIds) {
        bookWord(id);
        assert(!plan.skipBasic || !wordMap.get(id)!.basic, '学习计划基础词范围不匹配');
      }
      const firstNewDates = new Map<string, string>();
      for (const [date, day] of Object.entries(plan.days)) {
        assert(date >= plan.createdOn, '学习计划记录早于创建日期');
        const yesterday = previousLocalDateKey(date);
        for (const id of day.newWordIds) {
          bookWord(id);
          assert(!firstNewDates.has(id), '同一新词重复计入学习计划');
          firstNewDates.set(id, date);
          const activity = ownActivity(dailyActivity, date, id, plan.mode);
          assert(activity > 0 && Object.hasOwn(progressByMode[plan.mode], id), '计划新学缺少真实作答');
        }
        for (const id of day.reviewWordIds) {
          bookWord(id);
          assert((dailyActivity[yesterday]?.[id]?.[plan.mode].unknown ?? 0) > 0, '计划复习缺少昨日错词');
        }
        for (const id of day.reviewedWordIds) {
          bookWord(id);
          assert(ownActivity(dailyActivity, date, id, plan.mode) > 0, '计划复习完成缺少真实作答');
        }
        if (day.checkedInTargets) assert(day.newWordIds.length >= day.checkedInTargets.newWords && day.checkedInTargets.reviewWordIds.every(id => day.reviewedWordIds.includes(id)), '学习计划打卡缺少达标作答');
      }
      for (const [date, day] of Object.entries(dailyActivity)) {
        for (const [id, activity] of Object.entries(day)) {
          const first = firstNewDates.get(id);
          if (first && date < first) assert(activity[plan.mode].known + activity[plan.mode].unknown === 0, '已学词被伪装成计划新词');
        }
      }
    }
  };
  checkStudyPlans();
  const checkDailyReview = (): void => {
    const assignments = new Set<string>();
    const completions: Record<string, number> = {};
    for (const [date, day] of Object.entries(dailyReview)) {
      const yesterday = previousLocalDateKey(date);
      for (const mode of ['look', 'listen'] as const) {
        for (const [id, marker] of Object.entries(day[mode])) {
          reference(id);
          assert(dailyActivity[yesterday]?.[id]?.[mode].unknown, '次日复习缺少昨日错误记录');
          assert(marker.groupNumber <= state.modes[mode].groupNumber, '次日复习来自未来分组');
          const assignment = `${mode}:${marker.groupNumber}:${id}`;
          assert(!assignments.has(assignment), '次日复习重复排入同一组');
          assignments.add(assignment);
          if (marker.completed) {
            const key = `${mode}:${id}`;
            completions[key] = (completions[key] ?? 0) + 1;
            const map = progressByMode[mode];
            const progress = Object.prototype.hasOwnProperty.call(map, id) ? map[id] : undefined;
            assert(completions[key]! <= (progress?.seenCount ?? 0), '次日复习完成次数超过真实作答');
          }
        }
      }
    }
  };
  checkDailyReview();
  let studyTrail = [...state.studyTrail];
  const checkStudyTrail = (): void => {
    let previousId = 0;
    const counts: Record<string, { known: number; unknown: number }> = {};
    for (const item of studyTrail) {
      reference(item.wordId);
      assert(item.id > previousId, '浏览记录顺序无效');
      assert(item.groupNumber <= state.modes[item.mode].groupNumber, '浏览记录来自未来分组');
      previousId = item.id;
      if (item.action === 'known' || item.action === 'unknown') {
        const key = `${item.mode}:${item.wordId}`;
        const count = counts[key] ?? { known: 0, unknown: 0 };
        count[item.action] += 1;
        counts[key] = count;
        const map = progressByMode[item.mode];
        const progress = Object.prototype.hasOwnProperty.call(map, item.wordId) ? map[item.wordId] : undefined;
        assert(count.known <= (progress?.rightCount ?? 0) && count.unknown <= (progress?.wrongCount ?? 0), '浏览记录超过真实作答次数');
      }
    }
  };
  checkStudyTrail();
  const checkActivityTotals = (): void => {
    const totals: Record<string, { look: { known: number; unknown: number }; listen: { known: number; unknown: number } }> = {};
    for (const day of Object.values(dailyActivity)) {
      for (const [id, activity] of Object.entries(day)) {
        reference(id);
        const sum = Object.prototype.hasOwnProperty.call(totals, id) ? totals[id]! : { look: { known: 0, unknown: 0 }, listen: { known: 0, unknown: 0 } };
        for (const mode of ['look', 'listen'] as const) {
          sum[mode].known += activity[mode].known;
          sum[mode].unknown += activity[mode].unknown;
        }
        totals[id] = sum;
      }
    }
    for (const [id, sum] of Object.entries(totals)) {
      for (const mode of ['look', 'listen'] as const) {
        const progress = Object.prototype.hasOwnProperty.call(progressByMode[mode], id) ? progressByMode[mode][id] : undefined;
        assert(sum[mode].known <= (progress?.rightCount ?? 0) && sum[mode].unknown <= (progress?.wrongCount ?? 0), '日历次数超过真实作答记录');
      }
    }
  };
  checkActivityTotals();
  for (const entry of [...state.history].reverse()) {
    reference(entry.wordId);
    checkSession(entry.previousSession, entry.previousGroupNumber);
    checkSession(entry.previousOtherSession, entry.previousOtherGroupNumber);
    assert(entry.previousSession.status === 'active' && !entry.previousSession.revealed, '撤销记录不是有效答题状态');
    assert(entry.previousSession.items[entry.previousSession.cursor] === entry.wordId, '撤销词条与位置不一致');
    assert(!entry.wasSkipped, '已排除词不能成为作答');
    if (entry.dailyReviewChange) {
      const marker = dailyReview[entry.dailyReviewChange.date]?.[entry.mode]?.[entry.wordId];
      assert(marker?.completed && marker.groupNumber === entry.previousGroupNumber, '撤销记录缺少次日复习完成标记');
    }
    for (const change of entry.planChanges ?? []) {
      const day = studyPlans[change.key]?.days[change.date];
      assert(day, '撤销记录缺少学习计划日期');
      if (change.newAdded) assert(day.newWordIds.includes(entry.wordId), '撤销记录缺少计划新学');
      if (change.reviewAdded) assert(day.reviewedWordIds.includes(entry.wordId), '撤销记录缺少计划复习');
    }
    dailyReview = rewindDailyReview(dailyReview, entry);
    if (entry.studyTrailId !== undefined) {
      const item = studyTrail.at(-1);
      assert(item?.id === entry.studyTrailId, '撤销浏览记录缺失或顺序错误');
      assert(item.mode === entry.mode && item.wordId === entry.wordId && item.action === entry.action
        && item.groupNumber === entry.previousGroupNumber && item.position === entry.previousSession.cursor, '撤销浏览记录与作答不一致');
      if (entry.evictedStudyTrailEntry) {
        assert(studyTrail.length === MAX_STUDY_TRAIL, '浏览记录不应包含过期快照');
        studyTrail = [{ ...entry.evictedStudyTrailEntry }, ...studyTrail.slice(0, -1)];
      } else studyTrail = studyTrail.slice(0, -1);
    }
    const map = progressByMode[entry.mode];
    const progress = Object.prototype.hasOwnProperty.call(map, entry.wordId) ? map[entry.wordId] : undefined;
    const before = entry.previousProgress;
    if (before) assert(before.lastGroup <= entry.previousGroupNumber, '撤销快照来自未来分组');
    if (entry.action === 'known' || entry.action === 'unknown') {
      assert(progress, '撤销记录缺少作答');
      assert(progress.seenCount === (before?.seenCount ?? 0) + 1, '撤销累计次数不一致');
      assert(progress.wrongCount === (before?.wrongCount ?? 0) + Number(entry.action === 'unknown'), '撤销错误次数不一致');
      assert(progress.rightCount === (before?.rightCount ?? 0) + Number(entry.action === 'known'), '撤销认识次数不一致');
      assert(progress.lastGroup === entry.previousGroupNumber, '撤销组号不一致');
      const expectedStreak = entry.action === 'unknown' ? 0 : before ? Math.min(2, before.streak + 1) : 2;
      assert(progress.streak === expectedStreak, '撤销连续认识次数不一致');
      assert(progress.status === (expectedStreak === 2 ? 'completed' : 'learning'), '撤销完成状态不一致');
    } else {
      assert(sameProgress(progress, before), '跳过不应更改单词次数');
      if (entry.action === 'skip') assert(skipped.has(entry.wordId), '排除记录缺失');
    }
    if (before) progressByMode[entry.mode][entry.wordId] = before;
    else delete progressByMode[entry.mode][entry.wordId];
    if (entry.activityDate !== undefined && entry.previousDailyActivity !== undefined) {
      const day = dailyActivity[entry.activityDate];
      const activity = day && Object.prototype.hasOwnProperty.call(day, entry.wordId) ? day[entry.wordId] : undefined;
      assert(activity, '撤销记录缺少日历作答');
      const previousActivity = entry.previousDailyActivity;
      for (const mode of ['look', 'listen'] as const) {
        assert(activity[mode].known === (previousActivity?.[mode].known ?? 0) + Number(mode === entry.mode && entry.action === 'known'), '撤销日历认识次数不一致');
        assert(activity[mode].unknown === (previousActivity?.[mode].unknown ?? 0) + Number(mode === entry.mode && entry.action === 'unknown'), '撤销日历错误次数不一致');
      }
      const restoredDay = { ...day };
      if (previousActivity) restoredDay[entry.wordId] = previousActivity;
      else delete restoredDay[entry.wordId];
      if (Object.keys(restoredDay).length) dailyActivity[entry.activityDate] = restoredDay;
      else delete dailyActivity[entry.activityDate];
    }
    if (!entry.wasSkipped) skipped.delete(entry.wordId);
    studyPlans = rewindStudyPlans({ ...state, studyPlans, dailyActivity, skipped: [...skipped], modes: {
      look: { ...state.modes.look, progress: progressByMode.look },
      listen: { ...state.modes.listen, progress: progressByMode.listen },
    } }, entry);
  }
  checkActivityTotals();
  checkStudyTrail();
  checkDailyReview();
  checkStudyPlans();
  return state;
}

function ownActivity(activity: AppState['dailyActivity'], date: string, id: string, mode: 'look' | 'listen'): number {
  const day = activity[date];
  const record = day && Object.hasOwn(day, id) ? day[id]?.[mode] : undefined;
  return record ? record.known + record.unknown : 0;
}

export function parseWords(input: unknown): Word[] {
  return z.array(wordSchema).max(MAX_WORDS).refine(words => new Set(words.map(word => word.id)).size === words.length, 'Duplicate word identifiers').parse(input);
}
