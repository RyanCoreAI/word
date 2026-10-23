import { useState } from 'react';
import { ChevronDown, ExternalLink } from 'lucide-react';
import { getCollocations } from './data/collocations';

// Only reviewed headword mappings are shown; missing entries have no placeholder.
export function PhraseSection({ wordId, inline = false }: { wordId: string; inline?: boolean }) {
  const [expanded, setExpanded] = useState(inline);
  const phrases = getCollocations(wordId);
  if (!phrases.length) return null;
  return <section className={'phrase-section' + (inline ? ' phrase-inline' : '')} aria-label="常用搭配">
    {inline ? <div className="phrase-heading"><span>常用搭配</span></div> : <button className="phrase-heading" aria-expanded={expanded} onClick={() => setExpanded(value => !value)}><span>常用搭配</span><ChevronDown size={16} className={expanded ? 'expanded' : ''} /></button>}
    {expanded && <div className="phrase-body"><div className="phrase-list">{phrases.map(phrase => <article className="phrase-item" key={phrase.phrase}><div className="phrase-title"><h3 lang="en">{phrase.phrase}</h3></div><p className="phrase-meaning">{phrase.meaning}</p>{phrase.usage && <p className="phrase-note">{phrase.usage}</p>}<details className="phrase-evidence"><summary>用法来源</summary><a className="phrase-source" href={phrase.sourceUrl} target="_blank" rel="noreferrer">{phrase.sourceLabel}<ExternalLink size={10} /></a></details></article>)}</div></div>}
  </section>;
}
