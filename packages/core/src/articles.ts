import './validation-policy';
import { z } from 'zod';
import type { Word, WordProgress } from './types';

export const ARTICLE_MAX_CHARACTERS = 200_000;
export const ARTICLE_MAX_TOKENS = 20_000;
export const ARTICLE_MAX_TOKEN_CHARACTERS = 512;
export const ARTICLE_LONG_SENTENCE_TOKENS = 30;

export type ArticleOverride = 'known' | 'unknown' | 'ignored';
export type ArticleTokenStatus = 'familiar' | 'review' | 'unconfirmed' | 'unmatched' | 'unknown' | 'ignored';
export type ArticleLemmaIndex = Readonly<Record<string, readonly string[]>>;

const recordKeySchema = z.string().min(1).max(ARTICLE_MAX_TOKEN_CHARACTERS).refine(key => key !== '__proto__', 'Invalid article key');
// Zod records skip __proto__ during parsing; check the raw object first so invalid backup keys are not silently discarded.
const noPrototypeKeySchema = z.unknown().refine(value => value === null || typeof value !== 'object' || !Object.hasOwn(value, '__proto__'), 'Invalid article prototype key');
export const articleOverrideSchema = z.enum(['known', 'unknown', 'ignored']);
export const articleOverridesSchema = noPrototypeKeySchema.pipe(z.record(recordKeySchema, articleOverrideSchema))
  .refine(value => Object.keys(value).length <= ARTICLE_MAX_TOKENS, 'Too many article overrides');
export const articleLemmaIndexSchema = noPrototypeKeySchema.pipe(z.record(z.string().min(1).max(500).refine(key => key !== '__proto__', 'Invalid article word form'), z.array(z.string().min(1).max(500)).min(1).max(20)))
  .refine(value => Object.keys(value).length <= 1_000_000, 'Too many article word forms');
export const articleTextSchema = z.string().max(ARTICLE_MAX_CHARACTERS).superRefine((text, ctx) => {
  try { tokenizeArticle(text); }
  catch (error) { ctx.addIssue({ code: 'custom', message: error instanceof Error ? error.message : 'Invalid article text' }); }
});

export class ArticleLimitError extends Error {
  constructor(readonly code: 'text-too-long' | 'too-many-words' | 'word-too-long' | 'no-english') {
    super(code === 'text-too-long' ? '文章超过 20 万字符，请分成章节导入。'
      : code === 'too-many-words' ? '文章超过 2 万英文词，请分成章节导入。'
        : code === 'word-too-long' ? '正文中有超过 512 个字符的连续英文词，请检查乱码或粘贴内容。'
        : '请导入包含英文单词的正文。');
    this.name = 'ArticleLimitError';
  }
}

export interface ArticleRawToken {
  start: number;
  end: number;
  text: string;
  paragraphIndex: number;
}

export interface ArticleToken extends ArticleRawToken {
  /** A canonical lemma only when the supplied index is unambiguous. */
  key: string;
  word?: Word;
  candidates: Word[];
  status: ArticleTokenStatus;
  ambiguous: boolean;
}

export interface ArticleParagraph {
  index: number;
  start: number;
  end: number;
  text: string;
  tokenCount: number;
  /** Review, explicitly unknown, unconfirmed and unmatched occurrences. */
  burdenCount: number;
  /** A length hint, not a syntactic or comprehension assessment. */
  longSentenceCount: number;
}

export interface ArticleStats {
  totalTokens: number;
  uniqueWords: number;
  familiar: number;
  review: number;
  unconfirmed: number;
  unmatched: number;
  unknown: number;
  ignored: number;
  assessedTokens: number;
  /** Familiar occurrences / all non-ignored occurrences; never an understanding score. */
  familiarCoverage: number | null;
  longSentences: number;
}

export interface ArticleCandidate {
  key: string;
  text: string;
  word?: Word;
  candidates: Word[];
  status: ArticleTokenStatus;
  count: number;
  paragraphCount: number;
  firstOffset: number;
  wrongCount: number;
  ambiguous: boolean;
}

export interface ArticleAnalysis {
  tokens: ArticleToken[];
  paragraphs: ArticleParagraph[];
  stats: ArticleStats;
  /** Non-familiar, non-ignored groups, ordered by answer history and actual recurrence. */
  candidates: ArticleCandidate[];
}

export interface ArticleAnalysisOptions {
  words: readonly Word[];
  lemmas?: ArticleLemmaIndex;
  /** Reading uses look-mode records. Listening progress must not be substituted here. */
  progress?: Readonly<Record<string, WordProgress>>;
  overrides?: Readonly<Record<string, ArticleOverride>>;
  skipped?: readonly string[];
}

function tokenPattern(): RegExp {
  // Keep apostrophes and hyphens intact: do not turn "isn't" into two false dictionary hits.
  // Do not report a familiar substring of a code such as "read123" or an accented foreign word.
  return /(?<![\p{L}\p{N}_])[A-Za-z]+(?:['’][A-Za-z]+)*(?:-[A-Za-z]+(?:['’][A-Za-z]+)*)*(?![\p{L}\p{N}_])/gu;
}

function countEnglishTokens(text: string): number {
  let count = 0;
  const pattern = tokenPattern();
  while (pattern.exec(text)) {
    count += 1;
    if (count > ARTICLE_MAX_TOKENS) break;
  }
  return count;
}

function normalized(text: string): string {
  return text.replaceAll('’', "'");
}

function own<T>(record: Readonly<Record<string, T>> | undefined, key: string): T | undefined {
  return record && Object.hasOwn(record, key) ? record[key] : undefined;
}

/** Original UTF-16 offsets are retained, including punctuation, CRLF and emoji before a word. */
export function tokenizeArticle(text: string): { tokens: ArticleRawToken[]; paragraphs: ArticleParagraph[] } {
  if (text.length > ARTICLE_MAX_CHARACTERS) throw new ArticleLimitError('text-too-long');
  const paragraphs: ArticleParagraph[] = [];
  const appendParagraph = (start: number, end: number) => {
    const value = text.slice(start, end);
    if (!value.trim()) return;
    paragraphs.push({ index: paragraphs.length, start, end, text: value, tokenCount: 0, burdenCount: 0, longSentenceCount: 0 });
  };
  let start = 0;
  // Match the reader's text.split(/\n\s*\n/).filter(trim) contract; a single line break is not a paragraph.
  for (const separator of text.matchAll(/\n\s*\n/g)) {
    appendParagraph(start, separator.index);
    start = separator.index + separator[0].length;
  }
  appendParagraph(start, text.length);
  const tokens: ArticleRawToken[] = [];
  let paragraphIndex = 0;
  for (const match of text.matchAll(tokenPattern())) {
    if (tokens.length >= ARTICLE_MAX_TOKENS) throw new ArticleLimitError('too-many-words');
    if (match[0].length > ARTICLE_MAX_TOKEN_CHARACTERS) throw new ArticleLimitError('word-too-long');
    while (paragraphIndex < paragraphs.length - 1 && match.index >= paragraphs[paragraphIndex]!.end) paragraphIndex += 1;
    const paragraph = paragraphs[paragraphIndex];
    if (!paragraph) continue;
    tokens.push({ start: match.index, end: match.index + match[0].length, text: match[0], paragraphIndex });
    paragraph.tokenCount += 1;
  }
  if (!tokens.length) throw new ArticleLimitError('no-english');
  for (const paragraph of paragraphs) {
    for (const sentence of paragraph.text.matchAll(/[^.!?]+(?:[.!?]+|$)/g)) {
      if (countEnglishTokens(sentence[0]) > ARTICLE_LONG_SENTENCE_TOKENS) paragraph.longSentenceCount += 1;
    }
  }
  return { tokens, paragraphs };
}

// These surface forms have independent common meanings as well as inflected readings.
// Never infer that knowing a mapped root establishes the meaning used in a new sentence.
const AMBIGUOUS_SURFACES = new Set(['saw', 'left', 'right', 'found', 'bound', 'rose', 'lie', 'lying', 'better', 'best', 'wound', 'lay', 'fell', 'leaves', 'meeting', 'means']);
const STATUS_PRIORITY: Record<ArticleTokenStatus, number> = { unknown: 4, review: 3, unconfirmed: 2, unmatched: 1, familiar: 0, ignored: 0 };

interface Resolution {
  key: string;
  word?: Word;
  candidates: Word[];
  ambiguous: boolean;
  progressIds: string[];
}

function indexWords(words: readonly Word[]): { exact: Map<string, Word[]>; folded: Map<string, Word[]> } {
  const exact = new Map<string, Word[]>();
  const folded = new Map<string, Word[]>();
  for (const word of words) {
    const name = normalized(word.word);
    const lower = name.toLowerCase();
    const sameCase = exact.get(name);
    if (sameCase) sameCase.push(word); else exact.set(name, [word]);
    const sameLower = folded.get(lower);
    if (sameLower) sameLower.push(word); else folded.set(lower, [word]);
  }
  return { exact, folded };
}

function resolveToken(text: string, index: ReturnType<typeof indexWords>, lemmas: ArticleLemmaIndex | undefined): Resolution {
  const surface = normalized(text);
  const lower = surface.toLowerCase();
  const acronym = surface.length > 1 && /^[A-Z]+$/.test(surface);
  const calendarMay = surface === 'May';
  const caseAmbiguous = acronym || calendarMay;
  const exact = index.exact.get(surface) ?? [];
  // A lowercase pronoun must not inherit progress from an uppercase abbreviation in the reverse direction either.
  const folded = (index.folded.get(lower) ?? []).filter(word => normalized(word.word) === lower);
  const lemmaNames = caseAmbiguous ? [] : [...new Set((own(lemmas, lower) ?? []).map(value => normalized(value).toLowerCase()))];
  const roots = lemmaNames.flatMap(lemma => (index.folded.get(lemma) ?? []).filter(word => normalized(word.word) === lemma));
  const candidates = [...new Map([...exact, ...folded, ...roots].map(word => [word.id, word])).values()];
  const caseCollision = surface !== lower && exact.length > 0 && folded.some(word => !exact.some(match => match.id === word.id));
  const ambiguous = caseAmbiguous || caseCollision || lemmaNames.length > 1 || (AMBIGUOUS_SURFACES.has(lower) && lemmaNames.some(lemma => lemma !== lower));
  const canonical = !ambiguous && lemmaNames.length === 1 ? lemmaNames[0]! : lower;
  const key = calendarMay ? 'case:May' : acronym ? surface : canonical;
  // Exact entries are preferred for the popup. A lemma provides progress only when the mapping is unambiguous.
  const primary = exact[0] ?? folded[0] ?? roots[0];
  const progressWords = !ambiguous ? [...exact, ...folded, ...roots] : exact;
  return { key, word: primary, candidates, ambiguous, progressIds: [...new Set(progressWords.map(word => word.id))] };
}

function statusFor(resolution: Resolution, options: ArticleAnalysisOptions, skipped: ReadonlySet<string>): ArticleTokenStatus {
  const override = own(options.overrides, resolution.key);
  if (override) return override === 'known' ? 'familiar' : override;
  if (!resolution.candidates.length) return 'unmatched';
  if (resolution.ambiguous || resolution.progressIds.some(id => skipped.has(id))) return 'unconfirmed';
  const records = resolution.progressIds.map(id => own(options.progress, id)).filter((value): value is WordProgress => !!value);
  // A current learning record takes priority over a completed morphological candidate.
  if (records.some(record => record.status === 'learning')) return 'review';
  return records.some(record => record.status === 'completed') ? 'familiar' : 'unconfirmed';
}

export function analyzeArticle(text: string, options: ArticleAnalysisOptions): ArticleAnalysis {
  const raw = tokenizeArticle(text);
  const index = indexWords(options.words);
  const skipped = new Set(options.skipped ?? []);
  const resolutions = new Map<string, Resolution>();
  const groups = new Map<string, ArticleCandidate & { paragraphs: Set<number> }>();
  const stats: ArticleStats = {
    totalTokens: raw.tokens.length, uniqueWords: 0, familiar: 0, review: 0, unconfirmed: 0, unmatched: 0,
    unknown: 0, ignored: 0, assessedTokens: 0, familiarCoverage: null,
    longSentences: raw.paragraphs.reduce((sum, paragraph) => sum + paragraph.longSentenceCount, 0),
  };
  const tokens = raw.tokens.map(token => {
    let resolution = resolutions.get(token.text);
    if (!resolution) {
      resolution = resolveToken(token.text, index, options.lemmas);
      resolutions.set(token.text, resolution);
    }
    const status = statusFor(resolution, options, skipped);
    stats[status] += 1;
    const result: ArticleToken = { ...token, key: resolution.key, word: resolution.word, candidates: resolution.candidates, status, ambiguous: resolution.ambiguous };
    if (status !== 'familiar' && status !== 'ignored') raw.paragraphs[token.paragraphIndex]!.burdenCount += 1;
    const group = groups.get(result.key);
    if (group) {
      group.count += 1;
      group.paragraphs.add(token.paragraphIndex);
      group.paragraphCount = group.paragraphs.size;
      if (STATUS_PRIORITY[status] > STATUS_PRIORITY[group.status]) group.status = status;
      group.wrongCount = Math.max(group.wrongCount, ...resolution.candidates.map(word => own(options.progress, word.id)?.wrongCount ?? 0));
    } else {
      groups.set(result.key, {
        key: result.key, text: result.text, word: result.word, candidates: result.candidates, status: result.status,
        count: 1, paragraphCount: 1, firstOffset: result.start,
        wrongCount: Math.max(0, ...resolution.candidates.map(word => own(options.progress, word.id)?.wrongCount ?? 0)),
        ambiguous: result.ambiguous, paragraphs: new Set([token.paragraphIndex]),
      });
    }
    return result;
  });
  stats.uniqueWords = groups.size;
  stats.assessedTokens = stats.familiar + stats.review + stats.unknown;
  const eligible = stats.totalTokens - stats.ignored;
  stats.familiarCoverage = eligible ? stats.familiar / eligible : null;
  const candidates = [...groups.values()].filter(group => group.status !== 'familiar' && group.status !== 'ignored')
    .sort((a, b) => STATUS_PRIORITY[b.status] - STATUS_PRIORITY[a.status] || b.count - a.count || b.paragraphCount - a.paragraphCount || b.wrongCount - a.wrongCount || a.firstOffset - b.firstOffset)
    .map(group => {
      const { paragraphs, ...candidate } = group;
      void paragraphs;
      return candidate;
    });
  return { tokens, paragraphs: raw.paragraphs, stats, candidates };
}
