import './validation-policy';
import { z } from 'zod';
import { wordSchema } from './schemas';
import { ARTICLE_MAX_CHARACTERS, ARTICLE_MAX_TOKEN_CHARACTERS, ARTICLE_MAX_TOKENS, tokenizeArticle } from './articles';

export const MAX_ARTICLE_CHARACTERS = ARTICLE_MAX_CHARACTERS;
export const MAX_ARTICLE_WORDS = ARTICLE_MAX_TOKENS;
export const MAX_ARTICLES = 50;
export const MAX_ARTICLE_VOCABULARY = 2_000;
export const MAX_ARTICLE_LIBRARY_BYTES = 20 * 1024 * 1024;
const integer = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER - 1);
const counter = integer.max(10_000_000);
const contentHashSchema = z.string().regex(/^[a-f0-9]{64}$/);
const articleIdSchema = z.string().regex(/^article-[a-f0-9]{64}$/);
const vocabularyIdSchema = z.string().min(1).max(400);
const overrideKeySchema = z.string().min(1).max(ARTICLE_MAX_TOKEN_CHARACTERS).regex(/^[\p{L}][\p{L}\p{N}:'’.-]*$/u)
  .refine(value => value !== '__proto__', 'Invalid article word key');
export const articleOverrideSchema = z.enum(['known', 'unknown', 'ignored']);
export type ArticleOverride = z.infer<typeof articleOverrideSchema>;
// Reject an own __proto__ before Zod record parsing, which otherwise skips it.
const overridesSchema = z.unknown().refine(value => value === null || typeof value !== 'object' || !Object.hasOwn(value, '__proto__'), 'Invalid article prototype key')
  .pipe(z.record(overrideKeySchema, articleOverrideSchema))
  .refine(value => Object.keys(value).length <= MAX_ARTICLE_WORDS, 'Too many article overrides');

export function normalizeArticleText(text: string): string {
  return text.replace(/^\uFEFF/, '').replace(/\r\n?/g, '\n').trim();
}

export function articleParagraphs(text: string): string[] {
  return text.split(/\n\s*\n/).map(paragraph => paragraph.trim()).filter(Boolean);
}

export function validateArticleText(text: string): string {
  const normalized = normalizeArticleText(text);
  if (!normalized || normalized.length > MAX_ARTICLE_CHARACTERS) throw new Error('文章正文不能为空，且不能超过 20 万字符。');
  for (const character of normalized) {
    const code = character.codePointAt(0)!;
    if ((code < 32 && code !== 9 && code !== 10) || code === 127 || code === 0xfffd) throw new Error('正文包含乱码或不支持的控制字符，请使用 UTF-8 纯文本。');
  }
  tokenizeArticle(normalized);
  return normalized;
}

const textSchema = z.string().max(MAX_ARTICLE_CHARACTERS).superRefine((value, ctx) => {
  try { if (validateArticleText(value) !== value) ctx.addIssue({ code: 'custom', message: 'Article text is not normalized' }); }
  catch (error) { ctx.addIssue({ code: 'custom', message: error instanceof Error ? error.message : 'Invalid article text' }); }
});
const sourceUrlSchema = z.string().max(2_000).refine(value => {
  try { const url = new URL(value); return ['https:', 'http:'].includes(url.protocol) && !url.username && !url.password; }
  catch { return false; }
}, '文章来源必须是有效的 http/https 链接，且不能包含账号密码。');

export const importedArticleSchema = z.object({
  id: articleIdSchema, contentHash: contentHashSchema,
  title: z.string().trim().min(1).max(160), text: textSchema,
  sourceUrl: sourceUrlSchema.optional(), sourceFormat: z.enum(['paste', 'txt']),
  createdAt: integer, readParagraph: integer,
  overrides: overridesSchema,
}).strict().superRefine((value, ctx) => {
  if (value.id !== `article-${value.contentHash}`) ctx.addIssue({ code: 'custom', message: 'Article identity does not match content hash' });
  if (value.readParagraph >= articleParagraphs(value.text).length) ctx.addIssue({ code: 'custom', message: 'Article reading position is outside the text' });
});
export type ImportedArticle = z.infer<typeof importedArticleSchema>;

export const articleReviewProgressSchema = z.object({
  wrongCount: counter, rightCount: counter, streak: z.union([z.literal(0), z.literal(1), z.literal(2)]),
  lastAnsweredAt: integer.nullable(),
}).strict().superRefine((value, ctx) => {
  if (value.streak > value.rightCount || (value.wrongCount + value.rightCount === 0) !== (value.lastAnsweredAt === null)) ctx.addIssue({ code: 'custom', message: 'Article vocabulary review counters are inconsistent' });
});
export const articleVocabularyItemSchema = z.object({
  id: vocabularyIdSchema, articleId: articleIdSchema, tokenKey: overrideKeySchema, word: wordSchema,
  sentence: z.string().min(1).max(MAX_ARTICLE_CHARACTERS), paragraphIndex: integer,
  occurrences: integer.positive().max(MAX_ARTICLE_WORDS), addedAt: integer,
  progress: articleReviewProgressSchema,
}).strict();
export type ArticleVocabularyItem = z.infer<typeof articleVocabularyItemSchema>;

export const articleLibrarySchema = z.object({
  schemaVersion: z.literal(1), revision: integer, updatedAt: integer,
  articles: z.array(importedArticleSchema).max(MAX_ARTICLES),
  vocabulary: z.array(articleVocabularyItemSchema).max(MAX_ARTICLE_VOCABULARY),
}).strict().superRefine((value, ctx) => {
  const articles = new Map(value.articles.map(article => [article.id, article]));
  const paragraphs = new Map(value.articles.map(article => [article.id, articleParagraphs(article.text)]));
  if (articles.size !== value.articles.length) ctx.addIssue({ code: 'custom', message: 'Duplicate articles' });
  if (new Set(value.vocabulary.map(item => item.id)).size !== value.vocabulary.length) ctx.addIssue({ code: 'custom', message: 'Duplicate article vocabulary' });
  for (const item of value.vocabulary) {
    const article = articles.get(item.articleId);
    if (!article || item.id !== articleVocabularyId(item.articleId, item.word.id)) { ctx.addIssue({ code: 'custom', message: 'Article vocabulary has an invalid article reference' }); continue; }
    const paragraph = paragraphs.get(item.articleId)?.[item.paragraphIndex];
    if (!paragraph || !paragraph.includes(item.sentence)) ctx.addIssue({ code: 'custom', message: 'Article vocabulary source sentence is outside its paragraph' });
    if (item.addedAt < article.createdAt || (item.progress.lastAnsweredAt !== null && item.progress.lastAnsweredAt < item.addedAt)) ctx.addIssue({ code: 'custom', message: 'Article vocabulary dates are inconsistent' });
  }
  if (value.articles.some(article => article.createdAt > value.updatedAt) || value.vocabulary.some(item => item.addedAt > value.updatedAt || (item.progress.lastAnsweredAt ?? 0) > value.updatedAt)) ctx.addIssue({ code: 'custom', message: 'Article library update time is inconsistent' });
});
export type ArticleLibrary = z.infer<typeof articleLibrarySchema>;

export function parseArticleLibrary(raw: unknown): ArticleLibrary {
  const library = articleLibrarySchema.parse(raw);
  // Reserve the backup envelope so every valid saved library remains exportable.
  if (new TextEncoder().encode(JSON.stringify(library)).byteLength > MAX_ARTICLE_LIBRARY_BYTES - 1_024) throw new Error('文章库超过 20 MB，请导出备份后删除部分文章。');
  return library;
}

export function createArticleLibrary(now: number): ArticleLibrary {
  return parseArticleLibrary({ schemaVersion: 1, revision: 0, updatedAt: now, articles: [], vocabulary: [] });
}

function changed(state: ArticleLibrary, patch: Partial<Pick<ArticleLibrary, 'articles' | 'vocabulary'>>, now: number): ArticleLibrary {
  if (!Number.isSafeInteger(now) || now < state.updatedAt) throw new Error('文章保存时间无效，请重新载入后重试。');
  return parseArticleLibrary({ ...state, ...patch, revision: state.revision + 1, updatedAt: now });
}

export function addArticle(state: ArticleLibrary, raw: ImportedArticle, now: number): ArticleLibrary {
  const article = importedArticleSchema.parse(raw);
  const existing = state.articles.find(item => item.contentHash === article.contentHash);
  if (existing) {
    if (existing.text !== article.text) throw new Error('文章散列与已存正文不一致，未覆盖原文。');
    return state;
  }
  return changed(state, { articles: [...state.articles, article] }, now);
}

export function deleteArticle(state: ArticleLibrary, articleId: string, now: number): ArticleLibrary {
  if (!state.articles.some(article => article.id === articleId)) return state;
  return changed(state, { articles: state.articles.filter(article => article.id !== articleId), vocabulary: state.vocabulary.filter(item => item.articleId !== articleId) }, now);
}

export function updateArticlePosition(state: ArticleLibrary, articleId: string, readParagraph: number, now: number): ArticleLibrary {
  const article = state.articles.find(item => item.id === articleId);
  if (!article) throw new Error('文章不存在，请重新载入。');
  if (article.readParagraph === readParagraph) return state;
  return changed(state, { articles: state.articles.map(item => item.id === articleId ? { ...item, readParagraph } : item) }, now);
}

export function updateArticleOverride(state: ArticleLibrary, articleId: string, key: string, override: ArticleOverride | null, now: number): ArticleLibrary {
  overrideKeySchema.parse(key);
  const article = state.articles.find(item => item.id === articleId);
  if (!article) throw new Error('文章不存在，请重新载入。');
  const previous = Object.hasOwn(article.overrides, key) ? article.overrides[key] ?? null : null;
  if (previous === override) return state;
  const overrides = { ...article.overrides };
  if (override === null) delete overrides[key]; else overrides[key] = articleOverrideSchema.parse(override);
  return changed(state, { articles: state.articles.map(item => item.id === articleId ? { ...item, overrides } : item) }, now);
}

export function articleVocabularyId(articleId: string, wordId: string): string { return `${articleId}:${wordId}`; }

export type AddArticleVocabularyInput = Pick<ArticleVocabularyItem, 'articleId' | 'tokenKey' | 'word' | 'sentence' | 'paragraphIndex' | 'occurrences'>;
export function addArticleVocabulary(state: ArticleLibrary, input: AddArticleVocabularyInput, now: number): ArticleLibrary {
  const id = articleVocabularyId(input.articleId, input.word.id);
  if (state.vocabulary.some(item => item.id === id)) return state;
  const item = articleVocabularyItemSchema.parse({ ...input, id, addedAt: now, progress: { wrongCount: 0, rightCount: 0, streak: 0, lastAnsweredAt: null } });
  return changed(state, { vocabulary: [...state.vocabulary, item] }, now);
}

export function removeArticleVocabulary(state: ArticleLibrary, id: string, now: number): ArticleLibrary {
  if (!state.vocabulary.some(item => item.id === id)) return state;
  return changed(state, { vocabulary: state.vocabulary.filter(item => item.id !== id) }, now);
}

/** The UI records one answer, reveals unknown, then advances explicitly. */
export function answerArticleVocabulary(state: ArticleLibrary, id: string, answer: 'known' | 'unknown', now: number): ArticleLibrary {
  const current = state.vocabulary.find(item => item.id === id);
  if (!current) throw new Error('文章生词不存在，请重新载入。');
  if (answer !== 'known' && answer !== 'unknown') throw new Error('文章复习答案无效。');
  const progress = { wrongCount: current.progress.wrongCount + Number(answer === 'unknown'), rightCount: current.progress.rightCount + Number(answer === 'known'), streak: (answer === 'unknown' ? 0 : Math.min(2, current.progress.streak + 1)) as 0 | 1 | 2, lastAnsweredAt: now };
  const override: ArticleOverride | null = answer === 'unknown' ? 'unknown' : progress.streak === 2 ? 'known' : null;
  const articles = override === null ? state.articles : state.articles.map(article => article.id === current.articleId ? { ...article, overrides: { ...article.overrides, [current.tokenKey]: override } } : article);
  return changed(state, { articles, vocabulary: state.vocabulary.map(item => item.id === id ? { ...item, progress } : item) }, now);
}
