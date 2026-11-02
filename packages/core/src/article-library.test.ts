import { describe, expect, it } from 'vitest';
import { addArticle, addArticleVocabulary, answerArticleVocabulary, articleParagraphs, createArticleLibrary, deleteArticle, MAX_ARTICLE_CHARACTERS, MAX_ARTICLE_WORDS, parseArticleLibrary, removeArticleVocabulary, updateArticleOverride, updateArticlePosition, validateArticleText, type ImportedArticle } from './article-library';
import type { Word } from './types';
import { analyzeArticle } from './articles';

const hash = 'a'.repeat(64);
const article: ImportedArticle = { id: `article-${hash}`, contentHash: hash, title: 'A useful article', text: 'Learning a language takes time.\n\nReading helps us learn.', sourceFormat: 'paste', createdAt: 2, readParagraph: 0, overrides: {} };
const word: Word = { id: 'learn', word: 'learn', translation: 'v. 学习', phonetic: '', tags: [], rank: 1, basic: true };
const base = () => addArticle(createArticleLibrary(1), article, 2);
const withVocabulary = () => addArticleVocabulary(base(), { articleId: article.id, tokenKey: 'learn', word, sentence: 'Reading helps us learn.', paragraphIndex: 1, occurrences: 2 }, 3);

describe('article library isolation and constraints', () => {
  it('normalizes CRLF and UTF-8 BOM, keeps paragraphs and rejects non-English or oversized material', () => {
    expect(validateArticleText('\uFEFF  First paragraph.\r\n\r\nSecond paragraph.  ')).toBe('First paragraph.\n\nSecond paragraph.');
    expect(articleParagraphs(article.text)).toEqual(['Learning a language takes time.', 'Reading helps us learn.']);
    expect(() => validateArticleText('中文材料')).toThrow(/英文/);
    expect(() => validateArticleText('__proto__')).toThrow(/英文/);
    expect(() => validateArticleText('read123')).toThrow(/英文/);
    expect(validateArticleText('a'.repeat(512))).toHaveLength(512);
    expect(() => validateArticleText('a'.repeat(513))).toThrow(/512/);
    expect(() => validateArticleText('x'.repeat(MAX_ARTICLE_CHARACTERS + 1))).toThrow(/字符/);
    expect(() => validateArticleText('a '.repeat(MAX_ARTICLE_WORDS + 1))).toThrow(/英文词/);
    expect(() => validateArticleText('bad\u0000file')).toThrow(/乱码/);
    expect(() => validateArticleText('bad\uFFFDfile')).toThrow(/乱码/);
  });

  it('deduplicates normalized-content identities and avoids revisions on unchanged operations', () => {
    const state = base();
    expect(state.revision).toBe(1);
    expect(addArticle(state, { ...article, title: 'Another title' }, 3)).toBe(state);
    expect(updateArticlePosition(state, article.id, 0, 3)).toBe(state);
    expect(deleteArticle(state, 'missing', 3)).toBe(state);
    expect(() => addArticle(state, { ...article, text: 'A different text.' }, 3)).toThrow(/不一致/);
  });

  it('persists contextual overrides without forcing uppercase names into lowercase', () => {
    let state = updateArticleOverride(base(), article.id, 'case:May', 'ignored', 3);
    state = updateArticleOverride(state, article.id, 'US', 'known', 4);
    expect(state.articles[0]!.overrides).toEqual({ 'case:May': 'ignored', US: 'known' });
    expect(updateArticleOverride(state, article.id, 'US', 'known', 5)).toBe(state);
    state = updateArticleOverride(state, article.id, 'US', null, 5);
    expect(state.articles[0]!.overrides).toEqual({ 'case:May': 'ignored' });
    expect(() => updateArticleOverride(state, article.id, '__proto__', 'known', 6)).toThrow();
  });

  it('supports ordinary constructor/prototype words while rejecting an own __proto__ before record parsing', () => {
    let state = updateArticleOverride(base(), article.id, 'constructor', 'known', 3);
    state = updateArticleOverride(state, article.id, 'prototype', 'unknown', 4);
    state = updateArticleOverride(state, article.id, 'toString', 'ignored', 5);
    expect(state.articles[0]!.overrides).toEqual({ constructor: 'known', prototype: 'unknown', toString: 'ignored' });
    state = updateArticleOverride(state, article.id, 'constructor', null, 6);
    expect(Object.hasOwn(state.articles[0]!.overrides, 'constructor')).toBe(false);
    const unsafe = JSON.parse('{"__proto__":"known"}') as unknown;
    expect(() => parseArticleLibrary({ ...state, articles: [{ ...state.articles[0], overrides: unsafe }] })).toThrow();
  });

  it('does not mistake inherited properties for an existing answer', () => {
    const state = base();
    const inherited = Object.create({ constructor: 'known', prototype: 'unknown' }) as Record<string, 'known' | 'unknown'>;
    const raw = { ...state, articles: [{ ...state.articles[0]!, overrides: inherited }] };
    const updated = updateArticleOverride(raw, article.id, 'constructor', 'known', 3);
    expect(updated).not.toBe(raw);
    expect(Object.hasOwn(updated.articles[0]!.overrides, 'constructor')).toBe(true);
    expect(updated.articles[0]!.overrides.constructor).toBe('known');
    expect(Object.hasOwn(updated.articles[0]!.overrides, 'prototype')).toBe(false);
  });

  it('bounds reading positions and rejects dangling vocabulary or altered source sentences', () => {
    const state = withVocabulary();
    expect(updateArticlePosition(state, article.id, 1, 4).articles[0]!.readParagraph).toBe(1);
    expect(() => updateArticlePosition(state, article.id, 2, 4)).toThrow();
    expect(() => parseArticleLibrary({ ...state, articles: [] })).toThrow();
    expect(() => parseArticleLibrary({ ...state, vocabulary: [{ ...state.vocabulary[0], sentence: 'Invented source.' }] })).toThrow();
    expect(() => parseArticleLibrary({ ...state, vocabulary: [{ ...state.vocabulary[0], paragraphIndex: 0 }] })).toThrow();
    expect(() => parseArticleLibrary({ ...state, unexpected: true })).toThrow();
    expect(() => parseArticleLibrary({ ...state, articles: [article, article] })).toThrow();
  });

  it('removes only the selected article and its vocabulary', () => {
    const first = withVocabulary();
    const secondHash = 'b'.repeat(64);
    const second = addArticle(first, { ...article, id: `article-${secondHash}`, contentHash: secondHash, text: 'Another English paragraph.', createdAt: 4 }, 4);
    const result = deleteArticle(second, article.id, 5);
    expect(result.articles).toHaveLength(1);
    expect(result.articles[0]!.contentHash).toBe(secondHash);
    expect(result.vocabulary).toEqual([]);
    expect(first.vocabulary).toHaveLength(1);
  });

  it('enforces the article count bound without changing the existing library', () => {
    let state = createArticleLibrary(1);
    for (let index = 1; index <= 50; index++) {
      const contentHash = index.toString(16).padStart(64, '0');
      state = addArticle(state, { ...article, id: `article-${contentHash}`, contentHash }, 2);
    }
    expect(state.articles).toHaveLength(50);
    expect(() => addArticle(state, article, 3)).toThrow();
    expect(state.articles).toHaveLength(50);
  });
});

describe('independent article vocabulary review', () => {
  it('requires two consecutive known answers and resets the streak after unknown', () => {
    let state = withVocabulary(); const id = state.vocabulary[0]!.id;
    state = answerArticleVocabulary(state, id, 'known', 4);
    expect(state.vocabulary[0]!.progress).toEqual({ wrongCount: 0, rightCount: 1, streak: 1, lastAnsweredAt: 4 });
    state = answerArticleVocabulary(state, id, 'unknown', 5);
    expect(state.vocabulary[0]!.progress.streak).toBe(0);
    state = answerArticleVocabulary(state, id, 'known', 6);
    state = answerArticleVocabulary(state, id, 'known', 7);
    expect(state.vocabulary[0]!.progress).toEqual({ wrongCount: 1, rightCount: 3, streak: 2, lastAnsweredAt: 7 });
    expect(state.articles[0]!.overrides).toEqual({ learn: 'known' });
    expect(Object.keys(state).sort()).toEqual(['articles', 'revision', 'schemaVersion', 'updatedAt', 'vocabulary']);
  });

  it('does not duplicate a saved word or lose its counters, and supports explicit removal', () => {
    const original = withVocabulary();
    const input = { articleId: article.id, tokenKey: 'learn', word, sentence: 'Learning a language takes time.', paragraphIndex: 0, occurrences: 1 };
    expect(addArticleVocabulary(original, input, 4)).toBe(original);
    const removed = removeArticleVocabulary(original, original.vocabulary[0]!.id, 4);
    expect(removed.vocabulary).toEqual([]);
    expect(removed.articles).toEqual(original.articles);
    expect(() => answerArticleVocabulary(removed, 'missing', 'known', 5)).toThrow();
  });

  it('rejects forged counters and decreasing mutation times', () => {
    const state = withVocabulary();
    expect(() => parseArticleLibrary({ ...state, vocabulary: [{ ...state.vocabulary[0], progress: { wrongCount: 0, rightCount: 0, streak: 2, lastAnsweredAt: 3 } }] })).toThrow();
    expect(() => updateArticlePosition(state, article.id, 1, 1)).toThrow(/时间/);
  });

  it('feeds review outcomes back into the source token with one revision per answer', () => {
    const added = withVocabulary(); const id = added.vocabulary[0]!.id;
    const unknown = answerArticleVocabulary(added, id, 'unknown', 4);
    expect(unknown.revision).toBe(added.revision + 1);
    expect(unknown.articles[0]!.overrides.learn).toBe('unknown');
    expect(analyzeArticle(article.text, { words: [word], overrides: unknown.articles[0]!.overrides }).stats.unknown).toBe(1);
    const firstKnown = answerArticleVocabulary(unknown, id, 'known', 5);
    expect(firstKnown.articles[0]!.overrides.learn).toBe('unknown');
    expect(firstKnown.revision).toBe(unknown.revision + 1);
    const secondKnown = answerArticleVocabulary(firstKnown, id, 'known', 6);
    expect(secondKnown.revision).toBe(firstKnown.revision + 1);
    expect(secondKnown.articles[0]!.overrides.learn).toBe('known');
    expect(analyzeArticle(article.text, { words: [word], overrides: secondKnown.articles[0]!.overrides }).stats.familiar).toBe(1);
  });

  it('stores the original ambiguous token key rather than the selected dictionary lemma', () => {
    const raw = { ...article, text: 'I saw it yesterday.' };
    const initial = addArticle(createArticleLibrary(1), raw, 2);
    const see = { ...word, id: 'see', word: 'see' };
    let state = addArticleVocabulary(initial, { articleId: raw.id, tokenKey: 'saw', word: see, sentence: raw.text, paragraphIndex: 0, occurrences: 1 }, 3);
    state = answerArticleVocabulary(state, state.vocabulary[0]!.id, 'known', 4);
    state = answerArticleVocabulary(state, state.vocabulary[0]!.id, 'known', 5);
    expect(state.articles[0]!.overrides).toEqual({ saw: 'known' });
    expect(() => parseArticleLibrary({ ...state, vocabulary: [{ ...state.vocabulary[0], tokenKey: '__proto__' }] })).toThrow();
    const longKey = 'a'.repeat(512);
    expect(updateArticleOverride(state, raw.id, longKey, 'known', 6).articles[0]!.overrides[longKey]).toBe('known');
    expect(() => updateArticleOverride(state, raw.id, `${longKey}a`, 'known', 6)).toThrow();
  });
});
