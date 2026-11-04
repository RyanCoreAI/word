import { describe, expect, it } from 'vitest';
import type { Word } from '../../../../packages/core/src';
import { createDictionarySearch, isChineseQuery, normalizeDictionaryQuery, searchStudyWords } from './dictionary-search';

function entry(word: string, translation: string, rank = 1): Word {
  return { id: word, word, translation, phonetic: '', tags: [], rank, basic: false };
}

describe('literal bilingual dictionary search', () => {
  it('puts a complete Chinese sense before a sense prefix and an internal substring', () => {
    const words = [
      entry('wellbeing', 'n. 身心健康', 1),
      entry('healthy', 'adj. 健康强壮', 2),
      entry('health', 'n. [医] 身体状况；健康', 900),
    ];
    expect(searchStudyWords(words, '健康').map(word => word.id)).toEqual(['health', 'healthy', 'wellbeing']);
  });

  it('uses dictionary frequency rank to order Chinese matches with the same sense quality', () => {
    const words = [entry('health', 'n. 健康', 900), entry('fitness', 'n. 健康', 100)];
    expect(searchStudyWords(words, '健康').map(word => word.id)).toEqual(['fitness', 'health']);
  });

  it('puts primary Chinese meanings before incidental senses of more frequent words', () => {
    const words = [
      entry('go', 'vi. 去, 走, 达到, 运转, 查阅, 消失, 结束, 放弃', 33),
      entry('break', 'vt. 打破, 弄破, 弄坏, 破坏, 违反, 打断, 削弱, 放弃', 455),
      entry('abandon', 'vt. 放弃, 抛弃, 遗弃', 1950),
      entry('profit', 'n. 利润, 赢利, 利益\nvi. 有益, 获利', 1535),
      entry('good', 'a. 好的, 优良的, 上等的, 愉快的, 有益的', 104),
      entry('beneficial', 'a. 有益的, 受益的', 4385),
    ];
    expect(searchStudyWords(words, '放弃')[0]?.id).toBe('abandon');
    expect(searchStudyWords(words, '有益')[0]?.id).toBe('beneficial');
    expect(searchStudyWords(words, '有益的')[0]?.id).toBe('beneficial');
  });

  it('keeps English exact matches first and prefix matches alphabetical regardless of rank or length', () => {
    const words = [
      entry('apple', 'n. 苹果', 1), entry('abnormal', 'adj. 反常的', 2),
      entry('able', 'adj. 能够的', 5000), entry('a', 'art. 一', 9000),
      entry('stable', 'adj. 稳定的', 3),
    ];
    expect(searchStudyWords(words, 'A').map(word => word.id)).toEqual(['a', 'able', 'abnormal', 'apple']);
  });

  it('only returns literal source gloss matches instead of inventing translations or synonyms', () => {
    const words = [entry('beneficial', 'adj. 有益的；有利的'), entry('helpful', 'adj. 有帮助的')];
    expect(searchStudyWords(words, '有益').map(word => word.id)).toEqual(['beneficial']);
    expect(searchStudyWords(words, '获益良多')).toEqual([]);
  });

  it('does not strip the Chinese word 的 as if it were a part-of-speech label', () => {
    const words = [entry('good', 'adj. 好的', 1), entry('indeed', 'adv. 的确', 2), entry('of', 'prep. 的', 100)];
    expect(searchStudyWords(words, '的').map(word => word.id)).toEqual(['of', 'indeed', 'good']);
  });

  it('normalizes full-width input, whitespace and English case before matching', () => {
    const word = entry('Health', 'n. 健康');
    expect(normalizeDictionaryQuery('　ＨＥＡＬＴＨ　')).toBe('health');
    expect(searchStudyWords([word], '　ＨＥＡＬＴＨ　')).toEqual([word]);
    expect(searchStudyWords([word], '　健康　')).toEqual([word]);
    expect(isChineseQuery('中文English')).toBe(true);
    expect(isChineseQuery('health')).toBe(false);
  });

  it('treats regex punctuation and mixed Chinese-English input as literal text', () => {
    const words = [
      entry('course', 'n. C++课程'), entry('pattern', 'n. 健康.*'),
      entry('health', 'n. 健康'), entry('share', 'n. A股'),
    ];
    expect(searchStudyWords(words, 'C++课程').map(word => word.id)).toEqual(['course']);
    expect(searchStudyWords(words, '健康.*').map(word => word.id)).toEqual(['pattern']);
    expect(searchStudyWords(words, 'Ａ股').map(word => word.id)).toEqual(['share']);
    expect(searchStudyWords(words, '健康[')).toEqual([]);
    expect(searchStudyWords(words, '[')).toEqual([]);
  });

  it('retains only the best 60 distinct matches while accepting a late exact sense', () => {
    const prefixes = Array.from({ length: 200 }, (_, rank) => entry(`prefix-${String(rank).padStart(3, '0')}`, 'adj. 健康的', rank));
    const exact = entry('zz-late-exact', 'n. 健康', 100_000);
    const search = createDictionarySearch('健康');
    search.add(prefixes.slice(0, 100));
    expect(search.results()).toHaveLength(60);
    search.add(prefixes.slice(100));
    search.add(prefixes.slice(0, 20));
    search.add([exact, exact]);
    const result = search.results();
    expect(result).toHaveLength(60);
    expect(new Set(result.map(word => word.id)).size).toBe(60);
    expect(result.map(word => word.id)).toEqual([exact.id, ...prefixes.slice(0, 59).map(word => word.id)]);
  });

  it('does not match an empty or overlong query and bounds caller-provided limits', () => {
    const words = Array.from({ length: 120 }, (_, rank) => entry(`word-${rank}`, 'n. 目标', rank));
    expect(searchStudyWords(words, ' ')).toEqual([]);
    expect(searchStudyWords(words, '字'.repeat(301))).toEqual([]);
    expect(searchStudyWords(words, '目标', 1000)).toHaveLength(100);
  });
});
