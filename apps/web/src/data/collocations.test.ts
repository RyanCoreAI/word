import { describe, expect, it } from 'vitest';
import { collocations, getCollocations } from './collocations';

describe('explicitly curated word collocations', () => {
  it('provides the requested constructions and distinguishes their registers', () => {
    expect(getCollocations('beneficial').map(item => item.phrase)).toContain('be beneficial for');
    expect(getCollocations('beneficial').map(item => item.phrase)).toContain('be beneficial to');
    expect(getCollocations('figure')).toEqual([expect.objectContaining({ phrase: 'figure out', meaning: expect.stringContaining('弄懂'), usage: expect.stringContaining('偏口语') })]);
  });

  it('never guesses associations from tokens, substrings, inflections, or object properties', () => {
    for (const wordId of ['for', 'to', 'out', 'beneficially', 'figures', 'figure skating', 'constructor', '__proto__', 'toString', 'unknown-word', '']) {
      expect(getCollocations(wordId), wordId).toEqual([]);
    }
    expect(getCollocations('figure').some(item => /skating|speech/.test(item.phrase))).toBe(false);
    expect(getCollocations('important').some(item => item.phrase.includes('significant'))).toBe(false);
  });

  it('keeps unique concise headword-specific records with Chinese meanings and direct official sources', () => {
    const allowedHosts = new Set(['dictionary.cambridge.org', 'www.oxfordlearnersdictionaries.com']);
    for (const [headword, entries] of Object.entries(collocations)) {
      expect(headword).toMatch(/^[a-z]+$/);
      expect(entries.length).toBeGreaterThan(0);
      expect(entries.length).toBeLessThanOrEqual(3);
      expect(new Set(entries.map(item => item.phrase)).size, headword).toBe(entries.length);
      for (const item of entries) {
        expect(item.phrase).toBe(item.phrase.trim());
        expect(item.phrase.split(/\s+/).length).toBeGreaterThan(1);
        expect(item.phrase.length).toBeLessThan(70);
        expect(item.phrase.toLowerCase().split(/\s+/)).toContain(headword === 'measure' || headword === 'term' ? `${headword}s` : headword);
        expect(item.meaning).toMatch(/[\u4e00-\u9fff]/);
        const url = new URL(item.sourceUrl);
        expect(url.protocol).toBe('https:');
        expect(allowedHosts.has(url.hostname)).toBe(true);
        expect(url.pathname).toMatch(/\/(dictionary|definition|grammar|example)\//);
        expect(url.pathname).not.toMatch(/\/(search|thesaurus)\//);
        expect(item.sourceLabel.length).toBeGreaterThan(0);
        expect(Object.keys(item)).not.toContain('synonyms');
      }
    }
  });

  it('keeps causal direction and grammar restrictions rather than offering interchangeable strings', () => {
    const result = getCollocations('result');
    expect(result.find(item => item.phrase === 'result in')?.usage).toContain('in 后接结果');
    expect(result.find(item => item.phrase === 'result from')?.usage).toContain('from 后接原因');
    expect(getCollocations('because')[0]?.usage).toContain('because 后才接完整分句');
    expect(getCollocations('consider')[0]?.usage).toContain('不用 consider to do');
    expect(getCollocations('advantage')[0]?.usage).toContain('带贬义');
    expect(getCollocations('significant').find(item => item.phrase === 'a significant difference')?.usage).toContain('不等于差异一定很大');
  });
});
