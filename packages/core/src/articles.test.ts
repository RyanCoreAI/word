import { describe, expect, it } from 'vitest';
import {
  analyzeArticle, ARTICLE_MAX_CHARACTERS, ARTICLE_MAX_TOKENS, ARTICLE_MAX_TOKEN_CHARACTERS, ArticleLimitError, articleLemmaIndexSchema,
  articleOverridesSchema, articleTextSchema, tokenizeArticle,
} from './articles';
import type { Word, WordProgress } from './types';

function word(name: string, basic = false): Word {
  return { id: `id:${name}`, word: name, translation: '测试释义', phonetic: '', tags: [], rank: 1, basic };
}

function progress(status: 'learning' | 'completed', wrongCount = 0): WordProgress {
  return { status, wrongCount, rightCount: status === 'completed' ? 2 : 0, seenCount: wrongCount + (status === 'completed' ? 2 : 0), streak: status === 'completed' ? 2 : 0, lastAnsweredAt: 100, lastGroup: 1 };
}

describe('article tokenization and boundaries', () => {
  it('retains original offsets through emoji, CRLF, curly apostrophes and paragraph separators', () => {
    const text = '🌿  Read, don’t re-read.\r\nA line.\r\n \r\n  Next!  ';
    const result = tokenizeArticle(text);
    expect(result.tokens.map(token => token.text)).toEqual(['Read', 'don’t', 're-read', 'A', 'line', 'Next']);
    expect(result.paragraphs).toHaveLength(2);
    expect(result.paragraphs[0]?.tokenCount).toBe(5);
    expect(result.paragraphs[1]?.tokenCount).toBe(1);
    for (const token of result.tokens) expect(text.slice(token.start, token.end)).toBe(token.text);
    for (const paragraph of result.paragraphs) expect(text.slice(paragraph.start, paragraph.end)).toBe(paragraph.text);
    expect(result.tokens.at(-1)?.paragraphIndex).toBe(1);
  });

  it('uses the same paragraph indices as the reader and ignores empty outer chunks', () => {
    const text = '\n\nOne\nline\n\n  \nTwo\n\n';
    const result = tokenizeArticle(text);
    expect(result.paragraphs.map(paragraph => paragraph.text)).toEqual(text.split(/\n\s*\n/).filter(value => value.trim()));
    expect(result.tokens.map(token => token.paragraphIndex)).toEqual([0, 0, 1]);
  });

  it('does not create familiar substring hits from numbers, identifiers or accented words', () => {
    expect(tokenizeArticle('read123 456 read_code café Read.').tokens.map(token => token.text)).toEqual(['Read']);
  });

  it('accepts the exact English-word bound and rejects the next occurrence', () => {
    expect(tokenizeArticle('a '.repeat(ARTICLE_MAX_TOKENS)).tokens).toHaveLength(ARTICLE_MAX_TOKENS);
    expect(() => tokenizeArticle('a '.repeat(ARTICLE_MAX_TOKENS + 1))).toThrow('文章超过 2 万英文词');
  });

  it('rejects oversized or non-English input with a useful error', () => {
    expect(() => tokenizeArticle('a'.repeat(ARTICLE_MAX_CHARACTERS + 1))).toThrow('文章超过 20 万字符');
    expect(() => tokenizeArticle('中文 123\n\n')).toThrow('请导入包含英文单词');
  });

  it('accepts a 512-character token and a persistent key of exactly the same length', () => {
    const text = 'x'.repeat(ARTICLE_MAX_TOKEN_CHARACTERS);
    const result = analyzeArticle(text, { words: [] });
    expect(result.tokens[0]?.key).toBe(text);
    expect(articleTextSchema.safeParse(text).success).toBe(true);
    expect(articleOverridesSchema.safeParse({ [text]: 'known' }).success).toBe(true);
  });

  it('rejects an oversized English token before analysis or persistence can disagree', () => {
    const text = `A normal sentence. ${'x'.repeat(ARTICLE_MAX_TOKEN_CHARACTERS + 1)}`;
    try { tokenizeArticle(text); expect.fail('Expected a token-length error'); }
    catch (error) {
      expect(error).toBeInstanceOf(ArticleLimitError);
      expect((error as ArticleLimitError).code).toBe('word-too-long');
    }
    expect(() => analyzeArticle(text, { words: [] })).toThrow('超过 512 个字符');
    expect(articleTextSchema.safeParse(text).success).toBe(false);
    expect(articleOverridesSchema.safeParse({ ['x'.repeat(ARTICLE_MAX_TOKEN_CHARACTERS + 1)]: 'known' }).success).toBe(false);
  });
});

describe('article vocabulary evidence', () => {
  const words = ['read', 'study', 'studies', 'go', 'saw', 'see', 'us', 'may', 'a', 'new'].map(name => word(name, name === 'a'));

  it('uses reading completion as familiarity and preserves active learning as review', () => {
    const result = analyzeArticle('Read study new missing', { words, progress: { 'id:read': progress('completed'), 'id:study': progress('learning', 2) } });
    expect(result.tokens.map(token => token.status)).toEqual(['familiar', 'review', 'unconfirmed', 'unmatched']);
    expect(result.candidates.find(candidate => candidate.key === 'study')?.wrongCount).toBe(2);
  });

  it('does not infer familiarity from a skipped word or a basic-word flag', () => {
    const result = analyzeArticle('read a', { words, progress: { 'id:read': progress('completed') }, skipped: ['id:read'] });
    expect(result.tokens.map(token => token.status)).toEqual(['unconfirmed', 'unconfirmed']);
  });

  it('merges only supplied unambiguous inflections and keeps the exact dictionary entry for display', () => {
    const result = analyzeArticle('study studies went', { words, lemmas: { studies: ['study'], went: ['go'] }, progress: { 'id:study': progress('completed'), 'id:go': progress('completed') } });
    expect(result.tokens.map(token => token.key)).toEqual(['study', 'study', 'go']);
    expect(result.tokens.map(token => token.status)).toEqual(['familiar', 'familiar', 'familiar']);
    expect(result.tokens[1]?.word?.word).toBe('studies');
    expect(result.stats.uniqueWords).toBe(2);
    expect(result.tokens[2]?.text).toBe('went');
  });

  it('does not invent a stem when there is no verified morphology mapping', () => {
    const result = analyzeArticle('studied university beneficial', { words: [...words, word('universe'), word('benefit')], progress: { 'id:study': progress('completed'), 'id:universe': progress('completed'), 'id:benefit': progress('completed') } });
    expect(result.tokens.every(token => token.status === 'unmatched')).toBe(true);
  });

  it('leaves saw and multi-root morphology unconfirmed even if a candidate is familiar', () => {
    const result = analyzeArticle('saw axes', { words: [...words, word('axis'), word('axe')], lemmas: { saw: ['see'], axes: ['axis', 'axe'] }, progress: { 'id:see': progress('completed'), 'id:saw': progress('completed'), 'id:axis': progress('completed'), 'id:axe': progress('completed') } });
    expect(result.tokens.map(token => [token.key, token.status, token.ambiguous])).toEqual([['saw', 'unconfirmed', true], ['axes', 'unconfirmed', true]]);
    expect(result.tokens[0]?.word?.word).toBe('saw');
    expect(result.tokens[0]?.candidates.map(candidate => candidate.word)).toEqual(['saw', 'see']);
  });

  it('keeps US and May separate from familiar us and may', () => {
    const result = analyzeArticle('US us May may', { words, progress: { 'id:us': progress('completed'), 'id:may': progress('completed') } });
    expect(result.tokens.map(token => [token.key, token.status])).toEqual([['US', 'unconfirmed'], ['us', 'familiar'], ['case:May', 'unconfirmed'], ['may', 'familiar']]);
  });

  it('does not let lowercase words inherit knowledge of uppercase dictionary entries', () => {
    const result = analyzeArticle('us may', { words: [word('us'), word('US'), word('may'), word('May')], progress: { 'id:US': progress('completed'), 'id:May': progress('completed') } });
    expect(result.tokens.map(token => token.status)).toEqual(['unconfirmed', 'unconfirmed']);
    expect(result.tokens.map(token => token.candidates.map(candidate => candidate.word))).toEqual([['us'], ['may']]);
  });

  it('applies article-specific overrides before dictionary, progress and ambiguity', () => {
    const result = analyzeArticle('read studies US unknown', { words, lemmas: { studies: ['study'] }, progress: { 'id:read': progress('completed') }, overrides: { read: 'unknown', study: 'known', US: 'known', unknown: 'ignored' } });
    expect(result.tokens.map(token => token.status)).toEqual(['unknown', 'familiar', 'familiar', 'ignored']);
    expect(result.stats).toMatchObject({ assessedTokens: 3, familiarCoverage: 2 / 3, unknown: 1, ignored: 1 });
  });

  it('does not inherit override or progress properties from object prototypes', () => {
    const inherited = Object.create({ read: 'known' }) as Record<string, 'known'>;
    const inheritedProgress = Object.create({ 'id:read': progress('completed') }) as Record<string, WordProgress>;
    expect(analyzeArticle('read', { words, overrides: inherited, progress: inheritedProgress }).tokens[0]?.status).toBe('unconfirmed');
  });

  it('analyzes constructor and toString without reading native prototype functions as data', () => {
    const reservedWords = [{ ...word('constructor'), id: 'constructor' }, { ...word('toString'), id: 'toString' }];
    const missing = analyzeArticle('constructor toString __proto__', { words: [], lemmas: {}, progress: {}, overrides: {} });
    expect(missing.tokens.map(token => [token.text, token.key, token.status])).toEqual([
      ['constructor', 'constructor', 'unmatched'], ['toString', 'tostring', 'unmatched'],
    ]);
    const found = analyzeArticle('constructor toString __proto__', { words: reservedWords, lemmas: {}, progress: {}, overrides: {} });
    expect(found.tokens.map(token => token.status)).toEqual(['unconfirmed', 'unconfirmed']);
    expect(found.stats).toMatchObject({ totalTokens: 2, uniqueWords: 2, unconfirmed: 2 });
  });

  it('ignores inherited constructor and toString records across all article inputs', () => {
    const reservedWords = [{ ...word('constructor'), id: 'constructor' }, { ...word('toString'), id: 'toString' }, word('study')];
    const lemmas = Object.create({ constructor: ['study'], tostring: ['study'] }) as Record<string, string[]>;
    const overrides = Object.create({ constructor: 'known', tostring: 'known' }) as Record<string, 'known'>;
    const records = Object.create({ constructor: progress('completed'), toString: progress('completed'), 'id:study': progress('completed') }) as Record<string, WordProgress>;
    const result = analyzeArticle('constructor toString', { words: reservedWords, lemmas, overrides, progress: records });
    expect(result.tokens.map(token => [token.key, token.status])).toEqual([['constructor', 'unconfirmed'], ['tostring', 'unconfirmed']]);
    expect(result.candidates.every(candidate => candidate.wrongCount === 0)).toBe(true);
  });

  it('allows legitimate JSON-owned constructor and toString learning data and overrides', () => {
    const reservedWords = [{ ...word('constructor'), id: 'constructor' }, { ...word('toString'), id: 'toString' }];
    const records = JSON.parse(JSON.stringify({ constructor: progress('completed'), toString: progress('learning', 3) })) as Record<string, WordProgress>;
    const fromProgress = analyzeArticle('constructor toString', { words: reservedWords, progress: records });
    expect(fromProgress.tokens.map(token => token.status)).toEqual(['familiar', 'review']);
    expect(fromProgress.candidates[0]?.wrongCount).toBe(3);
    const overrides = articleOverridesSchema.parse(JSON.parse('{"constructor":"unknown","tostring":"known"}'));
    const fromOverrides = analyzeArticle('constructor toString', { words: reservedWords, progress: records, overrides });
    expect(fromOverrides.tokens.map(token => token.status)).toEqual(['unknown', 'familiar']);
  });

  it('uses a legitimate JSON-owned constructor morphology value without touching prototypes', () => {
    const prototypeKeys = Reflect.ownKeys(Object.prototype);
    const lemmas = articleLemmaIndexSchema.parse(JSON.parse('{"constructor":["study"]}'));
    const result = analyzeArticle('constructor __proto__', { words: [word('study')], lemmas, progress: { 'id:study': progress('completed') } });
    expect(result.tokens.map(token => [token.key, token.status])).toEqual([['study', 'familiar']]);
    expect(Reflect.ownKeys(Object.prototype)).toEqual(prototypeKeys);
    expect(Object.hasOwn(Object.prototype, 'study')).toBe(false);
  });

  it('counts running occurrences separately from canonical unique words', () => {
    const result = analyzeArticle('read new new.\n\nnew read', { words, progress: { 'id:read': progress('completed') } });
    expect(result.stats).toMatchObject({ totalTokens: 5, uniqueWords: 2, familiar: 2, unconfirmed: 3, familiarCoverage: 2 / 5 });
    expect(result.candidates).toHaveLength(1);
    expect(result.candidates[0]).toMatchObject({ key: 'new', count: 3, paragraphCount: 2, firstOffset: 5 });
    expect(result.paragraphs.map(paragraph => paragraph.burdenCount)).toEqual([2, 1]);
  });

  it('retains a review candidate when another occurrence sharing its lemma is familiar', () => {
    const result = analyzeArticle('study studies', { words, lemmas: { studies: ['study'] }, progress: { 'id:study': progress('completed'), 'id:studies': progress('learning', 2) } });
    expect(result.tokens.map(token => token.status)).toEqual(['familiar', 'review']);
    expect(result.candidates[0]).toMatchObject({ key: 'study', status: 'review', count: 2, wrongCount: 2 });
  });

  it('does not report a coverage score when every token is explicitly ignored', () => {
    expect(analyzeArticle('Mira Mira', { words, overrides: { mira: 'ignored' } }).stats).toMatchObject({ totalTokens: 2, ignored: 2, assessedTokens: 0, familiarCoverage: null });
  });

  it('labels only the sentence-length heuristic without inventing a comprehension score', () => {
    const result = analyzeArticle(`${'read '.repeat(31)}.\n\n${'read '.repeat(30)}.`, { words });
    expect(result.stats.longSentences).toBe(1);
    expect(result.paragraphs.map(paragraph => paragraph.longSentenceCount)).toEqual([1, 0]);
    expect(result.stats).not.toHaveProperty('comprehension');
    expect(result.stats).not.toHaveProperty('cefr');
  });

  it('keeps all input study records and article overrides unchanged', () => {
    const options = { words, lemmas: { studies: ['study'] }, progress: { 'id:study': progress('learning', 2) }, overrides: { new: 'unknown' as const }, skipped: ['id:read'] };
    const before = JSON.stringify(options);
    analyzeArticle('studies read new', options);
    expect(JSON.stringify(options)).toBe(before);
  });
});

describe('article input schemas', () => {
  it('validates the same text limits as analysis', () => {
    expect(articleTextSchema.safeParse('A useful article.').success).toBe(true);
    expect(articleTextSchema.safeParse('中文').success).toBe(false);
    expect(articleTextSchema.safeParse('__proto__ read123').success).toBe(false);
    expect(articleTextSchema.safeParse('a '.repeat(ARTICLE_MAX_TOKENS + 1)).success).toBe(false);
    expect(articleTextSchema.safeParse('a'.repeat(ARTICLE_MAX_CHARACTERS + 1)).success).toBe(false);
  });

  it('rejects unknown overrides and invalid external morphology entries', () => {
    expect(articleOverridesSchema.safeParse({ saw: 'known', 'case:May': 'ignored' }).success).toBe(true);
    expect(articleOverridesSchema.safeParse({ saw: 'completed' }).success).toBe(false);
    expect(articleLemmaIndexSchema.safeParse({ went: ['go'], saw: ['see'] }).success).toBe(true);
    expect(articleLemmaIndexSchema.safeParse({ went: [] }).success).toBe(false);
    expect(articleLemmaIndexSchema.safeParse({ went: 'go' }).success).toBe(false);
    expect(articleOverridesSchema.safeParse(JSON.parse('{"__proto__":"known"}')).success).toBe(false);
    expect(articleLemmaIndexSchema.safeParse(JSON.parse('{"__proto__":["study"]}')).success).toBe(false);
  });
});
