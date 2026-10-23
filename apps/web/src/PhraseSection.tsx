import { useEffect, useState } from 'react';
import { ArrowRight, ChevronDown, ExternalLink } from 'lucide-react';
import { PhraseStore, type Phrase, type PhraseManifest } from './lib/phrases';

const phraseBase = new URL('./phrases/', document.baseURI).href;
const store = new PhraseStore({ baseUrl: phraseBase });
const posNames: Record<string, string> = { noun: '名词短语', verb: '动词短语', adj: '形容词短语', adv: '副词短语', prep: '介词短语', prep_phrase: '介词短语', phrase: '短语', conj: '连接表达', intj: '感叹表达', pron: '代词表达', det: '限定表达', num: '数词表达' };
const tagNames: Record<string, string> = { Internet: '网络用语', internet: '网络用语', idiomatic: '习语', colloquial: '口语', informal: '非正式', formal: '正式', slang: '俚语', euphemistic: '委婉语', figurative: '比喻', literal: '字面义', UK: '英式', US: '美式' };
const displayTags = (tags: string[]) => tags.map(tag => tagNames[tag] ?? tag).join(' · ');

export function PhraseSection({ wordId, dictionaryVersion }: { wordId: string; dictionaryVersion: string }) {
  const [expanded, setExpanded] = useState(false);
  const [result, setResult] = useState<{ phrases: Phrase[]; manifest: PhraseManifest } | null>(null);
  const [failed, setFailed] = useState(false);
  const [attempt, setAttempt] = useState(0);
  useEffect(() => {
    if (!expanded || result) return;
    const abort = new AbortController();
    void store.load(wordId, dictionaryVersion, abort.signal).then(data => { if (!abort.signal.aborted) setResult(data); }).catch(() => { if (!abort.signal.aborted) setFailed(true); });
    return () => abort.abort();
  }, [expanded, result, wordId, dictionaryVersion, attempt]);
  return <section className="phrase-section" aria-label="短语与近义表达"><button className="phrase-heading" aria-expanded={expanded} onClick={() => { if (!expanded) setFailed(false); setExpanded(value => !value); }}><span>短语与近义表达</span><ChevronDown size={16} className={expanded ? 'expanded' : ''} /></button>{expanded && <div className="phrase-body">
    {!result && !failed && <p className="phrase-note" role="status">正在读取词典短语…</p>}
    {failed && !result && <div className="phrase-note" role="status">短语暂时无法读取。联网打开过的内容可供离线查看。<button onClick={() => { store.invalidate(); setFailed(false); setAttempt(value => value + 1); }}>重试</button></div>}
    {result && (result.phrases.length ? <><p className="phrase-note">按词典义项展示，未按使用频率排序。近义表达需结合语境，并非所有句子都能直接互换。</p><div className="phrase-list">{result.phrases.map(phrase => <article className="phrase-item" key={`${phrase.text}:${phrase.pos}`}><div className="phrase-title"><h3>{phrase.text}</h3><span>{posNames[phrase.pos] ?? '词典短语'}</span></div>{phrase.tags.length > 0 && <p className="phrase-tags">{displayTags(phrase.tags)}</p>}{phrase.senses.map(sense => <div className="phrase-sense" key={sense.id}><p className="phrase-meaning">{sense.meaning}</p>{sense.tags.length > 0 && <p className="phrase-tags">{displayTags(sense.tags)}</p>}{sense.substitutes.length > 0 && <div className="phrase-substitutes"><div className="phrase-subtitle">此义项的近义表达</div>{sense.substitutes.map(substitute => <div className="phrase-substitute" key={`${substitute.text}:${substitute.relationBasis}`}><ArrowRight size={13} /><div><span>{substitute.text}</span><small>{substitute.meaning}{substitute.tags.length ? ` · ${displayTags(substitute.tags)}` : ''}</small></div></div>)}</div>}</div>)}<a className="phrase-source" href={phrase.sourceUrl} target="_blank" rel="noreferrer">维基词典来源<ExternalLink size={10} /></a></article>)}</div></> : <p className="phrase-note">这个词暂无经过筛选的短语资料。不会自动拼凑搭配或近义词。</p>)}
    {result && <div className="phrase-attribution"><a href={new URL(result.manifest.attribution.file, phraseBase).href} target="_blank" rel="noreferrer">数据来源与整理说明</a><a href={new URL(result.manifest.license.file, phraseBase).href} target="_blank" rel="noreferrer">CC BY-SA 4.0</a></div>}
  </div>}</section>;
}
