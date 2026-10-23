export interface Collocation {
  readonly phrase: string;
  readonly meaning: string;
  readonly usage?: string;
  readonly sourceUrl: string;
  readonly sourceLabel: 'Cambridge Dictionary' | 'Oxford Learner’s Dictionaries';
}

export const COLLOCATIONS_VERSION = 'word-collocations-20261023-v1';
export const COLLOCATIONS_REVIEWED_AT = '2026-10-23';

// Editorial selection, not a full dictionary or a frequency-ranked corpus.
// Sources were checked for the particular construction and sense. Chinese
// explanations are our own; source definitions and examples are not reproduced.
// Associations are explicit headword IDs, never matches against arbitrary tokens.
export const collocations: Readonly<Record<string, readonly Collocation[]>> = {
  account: [{ phrase: 'take something into account', meaning: '把某事纳入考虑', sourceUrl: 'https://dictionary.cambridge.org/us/dictionary/english/take-into-account?topic=thinking-and-contemplating', sourceLabel: 'Cambridge Dictionary' }],
  access: [{ phrase: 'have access to', meaning: '有机会或有权使用、获取……', usage: '这里的 access 是名词；to 后接可使用或获取的事物。', sourceUrl: 'https://dictionary.cambridge.org/dictionary/english/access', sourceLabel: 'Cambridge Dictionary' }],
  advantage: [{ phrase: 'take advantage of', meaning: '利用……的有利条件或机会', usage: '接人或人的弱点时，常指占便宜、利用对方，带贬义。', sourceUrl: 'https://dictionary.cambridge.org/dictionary/english/take-advantage-of', sourceLabel: 'Cambridge Dictionary' }],
  approach: [{ phrase: 'an approach to', meaning: '处理……的方法；研究……的思路', usage: '这里的 approach 是名词，to 是介词。', sourceUrl: 'https://dictionary.cambridge.org/us/dictionary/english/approach', sourceLabel: 'Cambridge Dictionary' }],
  attention: [
    { phrase: 'pay attention to', meaning: '注意……；认真关注……', sourceUrl: 'https://dictionary.cambridge.org/dictionary/english/pay-attention-to?q=pay+attention', sourceLabel: 'Cambridge Dictionary' },
    { phrase: 'draw attention to', meaning: '使人注意到……；引起对……的关注', sourceUrl: 'https://dictionary.cambridge.org/dictionary/english/attention?q=attention_1', sourceLabel: 'Cambridge Dictionary' },
  ],
  aware: [{ phrase: 'be aware of', meaning: '意识到……；知道……的存在', usage: 'of 后接名词或动名词；接完整句子时用 be aware that。', sourceUrl: 'https://dictionary.cambridge.org/us/dictionary/english/aware', sourceLabel: 'Cambridge Dictionary' }],
  because: [{ phrase: 'because of', meaning: '因为……；由于……', usage: '后接名词、名词短语或动名词；because 后才接完整分句。', sourceUrl: 'https://www.oxfordlearnersdictionaries.com/definition/english/because-of', sourceLabel: 'Oxford Learner’s Dictionaries' }],
  beneficial: [
    { phrase: 'be beneficial for', meaning: '对……有益；有利于……', usage: 'for 后接受益的人或事物。', sourceUrl: 'https://dictionary.cambridge.org/dictionary/english/beneficial', sourceLabel: 'Cambridge Dictionary' },
    { phrase: 'be beneficial to', meaning: '对……有好处', usage: 'to 后接受益的人或事物；这里的 to 是介词。', sourceUrl: 'https://dictionary.cambridge.org/dictionary/english/beneficial', sourceLabel: 'Cambridge Dictionary' },
  ],
  benefit: [{ phrase: 'benefit from', meaning: '从……中受益', usage: '主语是受益者，from 后接带来好处的事物。', sourceUrl: 'https://dictionary.cambridge.org/dictionary/english/benefit', sourceLabel: 'Cambridge Dictionary' }],
  concern: [{ phrase: 'express concern about', meaning: '对……表示担忧', usage: '这里的 concern 是名词，表示担心，而非动词“涉及”。', sourceUrl: 'https://dictionary.cambridge.org/us/dictionary/english/concern', sourceLabel: 'Cambridge Dictionary' }],
  consider: [{ phrase: 'consider doing something', meaning: '考虑做某事', usage: 'consider 后接动词时用 -ing 形式，不用 consider to do。', sourceUrl: 'https://dictionary.cambridge.org/grammar/british-grammar/word-patterns-consider-doing-something', sourceLabel: 'Cambridge Dictionary' }],
  contribute: [{ phrase: 'contribute to', meaning: '促成……；成为……的原因之一', usage: '可以促成好事，也可以导致坏事；不一定是唯一原因。', sourceUrl: 'https://dictionary.cambridge.org/dictionary/english/contribute-to?q=contribute-to-something', sourceLabel: 'Cambridge Dictionary' }],
  decision: [{ phrase: 'make a decision', meaning: '作出决定', sourceUrl: 'https://dictionary.cambridge.org/dictionary/english/decision', sourceLabel: 'Cambridge Dictionary' }],
  depend: [{ phrase: 'depend on', meaning: '取决于……', usage: '此处表示受某个条件决定；表示“依赖”时也可用 depend on。', sourceUrl: 'https://dictionary.cambridge.org/dictionary/english/depend', sourceLabel: 'Cambridge Dictionary' }],
  effect: [{ phrase: 'have an effect on', meaning: '对……产生影响', usage: 'effect 在此是名词；常见错误是误写成 affect。', sourceUrl: 'https://dictionary.cambridge.org/grammar/british-grammar/part-of-speech-affect-or-effect', sourceLabel: 'Cambridge Dictionary' }],
  effort: [{ phrase: 'make an effort to do something', meaning: '努力做某事', sourceUrl: 'https://dictionary.cambridge.org/dictionary/english/make-an-effort', sourceLabel: 'Cambridge Dictionary' }],
  figure: [{ phrase: 'figure out', meaning: '想明白；弄懂；想出解决办法', usage: '偏口语；代词作宾语时放在中间，如 figure it out。', sourceUrl: 'https://dictionary.cambridge.org/us/dictionary/english/figure-out', sourceLabel: 'Cambridge Dictionary' }],
  focus: [{ phrase: 'focus on', meaning: '把注意力集中在……；重点讨论……', sourceUrl: 'https://dictionary.cambridge.org/dictionary/english/focus-on', sourceLabel: 'Cambridge Dictionary' }],
  impact: [{ phrase: 'have an impact on', meaning: '对……产生较大的影响', sourceUrl: 'https://dictionary.cambridge.org/us/dictionary/english/have-an-impact', sourceLabel: 'Cambridge Dictionary' }],
  important: [
    { phrase: 'be important to', meaning: '对……很重要', usage: '常用于说明某人重视什么，也可说明某事物的重要性。', sourceUrl: 'https://www.oxfordlearnersdictionaries.com/definition/english/important', sourceLabel: 'Oxford Learner’s Dictionaries' },
    { phrase: 'it is important to do something', meaning: '做某事很重要', sourceUrl: 'https://www.oxfordlearnersdictionaries.com/definition/english/important', sourceLabel: 'Oxford Learner’s Dictionaries' },
  ],
  lead: [{ phrase: 'lead to', meaning: '导致……；带来……的结果', usage: 'to 是介词，后接结果的名词或动名词；lead 的过去式是 led。', sourceUrl: 'https://dictionary.cambridge.org/us/dictionary/english/lead-to?topic=causing-things-to-happen', sourceLabel: 'Cambridge Dictionary' }],
  measure: [{ phrase: 'take measures to do something', meaning: '采取措施做某事', usage: '这里的 measure 是名词“措施”，通常用复数 measures。', sourceUrl: 'https://dictionary.cambridge.org/dictionary/english/take-measures', sourceLabel: 'Cambridge Dictionary' }],
  opportunity: [{ phrase: 'have an opportunity to do something', meaning: '有机会做某事', sourceUrl: 'https://dictionary.cambridge.org/dictionary/english/opportunity?topic=opportunity', sourceLabel: 'Cambridge Dictionary' }],
  participate: [{ phrase: 'participate in', meaning: '参加……；参与……', sourceUrl: 'https://dictionary.cambridge.org/dictionary/english/participate-in', sourceLabel: 'Cambridge Dictionary' }],
  prevent: [{ phrase: 'prevent someone from doing something', meaning: '阻止某人做某事', usage: 'from 后用 -ing 形式，不用 prevent someone to do。', sourceUrl: 'https://dictionary.cambridge.org/grammar/british-grammar/word-patterns-prevent', sourceLabel: 'Cambridge Dictionary' }],
  provide: [{ phrase: 'provide someone with something', meaning: '向某人提供某物', sourceUrl: 'https://dictionary.cambridge.org/grammar/british-grammar/word-patterns-provide', sourceLabel: 'Cambridge Dictionary' }],
  responsible: [{ phrase: 'be responsible for', meaning: '负责……；对……承担责任', usage: '也可以表示是某种结果、尤其是坏结果的原因。', sourceUrl: 'https://dictionary.cambridge.org/dictionary/english/responsible', sourceLabel: 'Cambridge Dictionary' }],
  result: [
    { phrase: 'result in', meaning: '导致……；造成……的结果', usage: '原因作主语，in 后接结果。', sourceUrl: 'https://dictionary.cambridge.org/dictionary/english/result-in', sourceLabel: 'Cambridge Dictionary' },
    { phrase: 'result from', meaning: '由……引起；是……造成的', usage: '结果作主语，from 后接原因；与 result in 的方向相反。', sourceUrl: 'https://dictionary.cambridge.org/dictionary/english/result-from', sourceLabel: 'Cambridge Dictionary' },
    { phrase: 'as a result of', meaning: '由于……；作为……的结果', sourceUrl: 'https://dictionary.cambridge.org/us/dictionary/english/result', sourceLabel: 'Cambridge Dictionary' },
  ],
  risk: [{ phrase: 'at risk of', meaning: '有……的危险；面临……的风险', usage: 'of 后接不利后果的名词或动名词。', sourceUrl: 'https://dictionary.cambridge.org/dictionary/english/risk?topic=unsafe-and-insecure', sourceLabel: 'Cambridge Dictionary' }],
  role: [{ phrase: 'play a role in', meaning: '在……中起作用；参与促成……', sourceUrl: 'https://dictionary.cambridge.org/us/dictionary/english/role', sourceLabel: 'Cambridge Dictionary' }],
  significant: [
    { phrase: 'a significant increase in', meaning: '……的明显增长', usage: '用于描述数量或程度的变化；研究中的统计显著性需看具体语境。', sourceUrl: 'https://dictionary.cambridge.org/dictionary/english/significant', sourceLabel: 'Cambridge Dictionary' },
    { phrase: 'a significant difference', meaning: '明显的差异；重要的差别', usage: '在统计研究中也可指达到统计显著性的差异，不等于差异一定很大。', sourceUrl: 'https://dictionary.cambridge.org/us/example/english/significant-difference', sourceLabel: 'Cambridge Dictionary' },
  ],
  solution: [{ phrase: 'a solution to', meaning: '……的解决办法', usage: 'to 后接需要解决的问题。', sourceUrl: 'https://dictionary.cambridge.org/dictionary/english/solution', sourceLabel: 'Cambridge Dictionary' }],
  term: [{ phrase: 'in terms of', meaning: '从……方面来说；就……而言', usage: '此表达固定使用复数 terms。', sourceUrl: 'https://dictionary.cambridge.org/dictionary/english/in-terms-of', sourceLabel: 'Cambridge Dictionary' }],
};

const EMPTY: readonly Collocation[] = Object.freeze([]);

export function getCollocations(wordId: string): readonly Collocation[] {
  return Object.hasOwn(collocations, wordId) ? collocations[wordId] ?? EMPTY : EMPTY;
}
