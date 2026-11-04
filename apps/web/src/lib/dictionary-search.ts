import type { Word } from '../../../../packages/core/src';

export const normalizeDictionaryQuery = (query: string): string => query.normalize('NFKC').trim().toLowerCase();
export const isChineseQuery = (query: string): boolean => /\p{Script=Han}/u.test(query);

type Relevance = { score: number; sense: number; form: number };
type Match = Relevance & { word: Word };
const compareRelevance = (a: Relevance, b: Relevance): number => a.score - b.score || a.sense - b.sense || a.form - b.form;
const compare = (a: Match, b: Match): number => compareRelevance(a, b) || a.word.rank - b.word.rank || a.word.word.length - b.word.word.length || a.word.word.localeCompare(b.word.word);

/** Literal dictionary-gloss lookup, never generated translations or guessed synonyms. */
function matchScore(word: Word, query: string, chinese: boolean): Relevance | null {
  if (!chinese) {
    const spelling = normalizeDictionaryQuery(word.word);
    return spelling.startsWith(query) ? { score: spelling === query ? 0 : 1, sense: 0, form: 0 } : null;
  }
  const translation = normalizeDictionaryQuery(word.translation);
  if (!translation.includes(query)) return null;
  let best: Relevance = { score: 2, sense: Number.MAX_SAFE_INTEGER, form: 0 };
  for (const [index, part] of translation.split(/[\n,，;；、]/u).entries()) {
    // Remove leading source POS/domain labels, not Chinese words such as 的.
    const sense = part.replace(/^(?:(?:[a-z]+\.)|[/&]|\[[^\]]*\]|【[^】]*】|\s)+/gu, '').trim();
    if (!sense.includes(query)) continue;
    // 有益 / 有益的 are close lookup forms; this only ranks an existing literal match.
    // It never strips 的 from the actual query or invents new gloss matches.
    const adjective = query.length >= 2 && !query.endsWith('的') && sense === `${query}的`;
    const score = sense === query || adjective ? 0 : sense.startsWith(query) ? 1 : 2;
    const candidate = { score, sense: index, form: adjective ? 1 : 0 };
    if (compareRelevance(candidate, best) < 0) best = candidate;
  }
  return best;
}

/** Bounded top matches: even a full local dictionary never accumulates every row. */
export function createDictionarySearch(input: string, limit = 60) {
  const query = normalizeDictionaryQuery(input);
  const chinese = isChineseQuery(query);
  const compareMatches = chinese ? compare : (a: Match, b: Match) => a.score - b.score || a.word.word.localeCompare(b.word.word);
  const size = Math.max(1, Math.min(100, Math.trunc(limit) || 30));
  const matches: Match[] = [];
  return {
    add(words: readonly Word[]): void {
      if (!query || query.length > 300) return;
      for (const word of words) {
        const relevance = matchScore(word, query, chinese);
        if (relevance === null) continue;
        const candidate = { word, ...relevance };
        const duplicate = matches.findIndex(match => match.word.id === word.id);
        if (duplicate !== -1) matches.splice(duplicate, 1);
        if (matches.length === size && compareMatches(candidate, matches[matches.length - 1]!) >= 0) continue;
        let low = 0; let high = matches.length;
        while (low < high) { const middle = (low + high) >>> 1; if (compareMatches(candidate, matches[middle]!) < 0) high = middle; else low = middle + 1; }
        matches.splice(low, 0, candidate);
        if (matches.length > size) matches.pop();
      }
    },
    results: (): Word[] => matches.map(match => match.word),
  };
}

export function searchStudyWords(words: readonly Word[], query: string, limit = 60): Word[] {
  const search = createDictionarySearch(query, limit); search.add(words); return search.results();
}
