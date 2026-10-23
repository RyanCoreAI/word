import { useEffect, useState } from 'react';
import { ArrowRight, ChevronDown, ExternalLink } from 'lucide-react';
import { PhraseStore, type Phrase, type PhraseResult, type WordSense } from './lib/phrases';

const phraseBase = new URL('./phrases/', document.baseURI).href;
const store = new PhraseStore({ baseUrl: phraseBase });
const posNames: Record<string, string> = { noun: '名词', verb: '动词', adj: '形容词', adv: '副词', prep: '介词短语', prep_phrase: '介词短语', phrase: '短语', conj: '连接表达', intj: '感叹表达', pron: '代词表达', det: '限定表达', num: '数词表达' };
const tagNames: Record<string, string> = { idiomatic: '习语', colloquial: '口语', informal: '非正式', formal: '正式', slang: '俚语', euphemistic: '委婉语', figurative: '比喻', literal: '字面义', UK: '英式', US: '美式' };
const displayTags = (tags: string[]) => tags.map(tag => tagNames[tag] ?? tag).join(' · ');

function Substitutes({ substitutes }: { substitutes: Phrase['senses'][number]['substitutes'] }) {
  return substitutes.length > 0 ? <div className="phrase-substitutes"><div className="phrase-subtitle">此义项的近义表达</div>{substitutes.map(substitute => <div className="phrase-substitute" key={substitute.text}><ArrowRight size={13} /><div><span>{substitute.text}</span><small>{substitute.meaning}{substitute.tags.length ? ' · ' + displayTags(substitute.tags) : ''}</small></div></div>)}</div> : <p className="phrase-note phrase-missing">此义项暂无已核对的近义替换</p>;
}

function WordSenseItem({ sense }: { sense: WordSense }) {
  return <article className="phrase-item word-sense"><div className="phrase-title"><h3>{sense.meaning}</h3><span>{posNames[sense.pos]}</span></div><Substitutes substitutes={sense.substitutes} /><details className="sense-usage"><summary>义项与替换限制</summary><p>{sense.definition}</p>{sense.usage && <p>{sense.usage}</p>}<a className="phrase-source" href={sense.sourceUrl} target="_blank" rel="noreferrer">WordNet 原始义项<ExternalLink size={10} /></a><small>中文为核验后的编辑释义</small></details></article>;
}

export function PhraseSection({ wordId, dictionaryVersion, inline = false, onMore }: { wordId: string; dictionaryVersion: string; inline?: boolean; onMore?: () => void }) {
  const [expanded, setExpanded] = useState(inline);
  const [result, setResult] = useState<PhraseResult | null>(null);
  const [failed, setFailed] = useState(false);
  const [attempt, setAttempt] = useState(0);
  useEffect(() => {
    if (!expanded || result) return;
    const abort = new AbortController();
    void store.load(wordId, dictionaryVersion, abort.signal).then(data => { if (!abort.signal.aborted) setResult(data); }).catch(() => { if (!abort.signal.aborted) setFailed(true); });
    return () => abort.abort();
  }, [expanded, result, wordId, dictionaryVersion, attempt]);
  const phrases = result?.phrases.slice(0, inline ? 2 : undefined) ?? [];
  const senses = result?.wordSenses.slice(0, inline ? 1 : undefined) ?? [];
  return <section className={'phrase-section' + (inline ? ' phrase-inline' : '')} aria-label="短语与近义表达">
    {inline ? <div className="phrase-heading"><span>短语与近义表达</span>{onMore && <button onClick={onMore}>全部<ArrowRight size={12} /></button>}</div> : <button className="phrase-heading" aria-expanded={expanded} onClick={() => { if (!expanded) setFailed(false); setExpanded(value => !value); }}><span>短语与近义表达</span><ChevronDown size={16} className={expanded ? 'expanded' : ''} /></button>}
    {expanded && <div className="phrase-body">
      {!result && !failed && <p className="phrase-note" role="status">正在读取词典短语…</p>}
      {failed && !result && <div className="phrase-note" role="status">短语暂时无法读取。联网打开过的内容可供离线查看。<button onClick={() => { store.invalidate(); setFailed(false); setAttempt(value => value + 1); }}>重试</button></div>}
      {result && <>
        {!inline && (phrases.length > 0 || senses.length > 0) && <p className="phrase-note">按词典义项展示，未按使用频率排序。近义表达需结合语境，并非所有句子都能直接互换。</p>}
        {senses.length > 0 && <div className="word-senses"><div className="lexical-group-title">单词近义 · 按义项</div>{senses.map(sense => <WordSenseItem key={sense.id} sense={sense} />)}</div>}
        {phrases.length > 0 && <div className="phrase-list">{senses.length > 0 && <div className="lexical-group-title">单词短语</div>}{phrases.map(phrase => <article className="phrase-item" key={phrase.text}><div className="phrase-title"><h3>{phrase.text}</h3><span>{posNames[phrase.pos] ?? '词典短语'}</span></div>{phrase.tags.length > 0 && <p className="phrase-tags">{displayTags(phrase.tags)}</p>}{phrase.senses.slice(0, inline ? 1 : undefined).map(sense => <div className="phrase-sense" key={sense.id}><p className="phrase-meaning">{sense.meaning}</p>{sense.tags.length > 0 && <p className="phrase-tags">{displayTags(sense.tags)}</p>}<Substitutes substitutes={sense.substitutes} /></div>)}{!inline && <a className="phrase-source" href={phrase.sourceUrl} target="_blank" rel="noreferrer">{phrase.sourceUrl.startsWith('https://zh.wiktionary.org') ? '维基词典来源' : 'ECDICT 来源'}<ExternalLink size={10} /></a>}</article>)}</div>}
        {!phrases.length && !senses.length && <p className="phrase-note">这个词暂无经过筛选的短语资料。不会自动拼凑搭配或近义词。</p>}
        {inline ? (phrases.length > 0 || senses.length > 0) && <p className="phrase-note">近义表达需结合义项和语境。{onMore && <button onClick={onMore}>查看完整资料</button>}</p> : <div className="phrase-attribution"><a href={new URL(result.manifest.attribution.file, phraseBase).href} target="_blank" rel="noreferrer">数据来源与整理说明</a>{result.manifest.licenses.map(license => <a key={license.name} href={new URL(license.file, phraseBase).href} target="_blank" rel="noreferrer">{license.name === 'CC-BY-SA-4.0' ? 'CC BY-SA 4.0' : license.name}</a>)}</div>}
      </>}
    </div>}
  </section>;
}
