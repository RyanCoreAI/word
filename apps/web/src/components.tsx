import { useEffect, useRef, type ReactNode } from 'react';
import { ArrowRight, BookOpen, Check, ChevronLeft, EyeOff, Headphones, Home, NotebookPen, Repeat, RotateCcw, Search, Settings, Mic, Snail, Volume2, X } from 'lucide-react';
import type { AppState, Mode, Settings as StudySettings, StudyTrailEntry, Word } from '../../../packages/core/src';

import { FittedWord } from './FittedWord';
import { PhraseSection } from './PhraseSection';
import { useStudySwipe } from './useStudySwipe';

export const deckNames: Record<string, string> = { all: '全部学习词', cet4: '四级', cet6: '六级', ky: '考研', toefl: '托福', ielts: '雅思', gre: 'GRE', gk: '高考', zk: '基础', hf: '高频' };
export const modeNames: Record<Mode, string> = { look: '看词记忆', listen: '听音辨词' };
export const wordTags = (word: Word) => ['cet4', 'cet6', 'ky', 'toefl', 'ielts', 'gre', 'gk', 'hf'].filter(tag => word.tags.includes(tag)).slice(0, 4);
export const brief = (word: Word) => word.translation.split('\n').filter(Boolean).slice(0, 2).join('；');
export const wrongCount = (state: AppState, id: string) => (state.modes.look.progress[id]?.wrongCount ?? 0) + (state.modes.listen.progress[id]?.wrongCount ?? 0);

export function Meanings({ word }: { word: Word }) {
  return <div className="meaning">{word.translation.split('\n').filter(Boolean).map((line, index) => {
    const match = line.match(/^((?:[a-z]+\.)+(?:\s*&\s*[a-z]+\.)?)\s*(.*)$/i);
    return <div className="mrow" key={index}>{match ? <><span className="pos">{match[1]}</span><span>{match[2]}</span></> : <span>{line}</span>}</div>;
  })}</div>;
}

export function WordList({ words, state, onWord, mode = 'look', variant = 'full', empty = '还没有生词。开始学习后，点过「不认识」的词会留在这里。' }: { words: Word[]; state: AppState; onWord: (word: Word) => void; mode?: Mode; variant?: 'full' | 'home' | 'summary'; empty?: string }) {
  return <div className={`panel wl ${variant === 'summary' ? 'compact' : ''}`}>{words.length ? words.map(word => {
    const progress = state.modes[mode].progress[word.id];
    const streak = progress?.streak ?? 0;
    return <button className="it" key={word.id} onClick={() => onWord(word)}>{variant === 'summary' ? <><span className="w">{word.word}</span><span className="zh">{brief(word)}</span></> : <span className="word-info"><span className="w">{word.word}{variant === 'full' && word.phonetic && <span className="ph">/{word.phonetic}/</span>}</span><span className="zh">{brief(word)}</span></span>}<span className="rt">{wrongCount(state, word.id) > 0 && <span className={`cnt ${wrongCount(state, word.id) <= 2 ? 'lo' : ''}`}>×{wrongCount(state, word.id)}</span>}{variant === 'full' && <span className="state" aria-label={`${modeNames[mode]}，连续认识 ${streak} 次，共需 2 次`}><span className="dots"><i className={streak >= 1 ? 'f' : ''} /><i className={streak >= 2 ? 'f' : ''} /></span></span>}</span></button>;
  }) : <p className="empty">{empty}</p>}</div>;
}

export function Navigation({ page, go }: { page: string; go: (page: 'home' | 'retell' | 'words' | 'settings') => void }) {
  return <nav className="tabbar" aria-label="主导航">{([
    ['home', '学习', Home], ['retell', '复述', Mic], ['words', '生词本', NotebookPen], ['settings', '设置', Settings],
  ] as const).map(([id, title, Icon]) => <button key={id} className={`tab ${page === id ? 'on' : ''}`} aria-current={page === id ? 'page' : undefined} onClick={() => go(id)}><Icon className="ic" />{title}</button>)}</nav>;
}

export function HomePage({ state, words, start, onWord, goWords, mode, onProgressMode, ringIntro, search, calendar, install }: { state: AppState; words: Word[]; start: (mode: Mode) => void; onWord: (word: Word) => void; goWords: () => void; mode: Mode; onProgressMode?: (mode: Mode) => void; ringIntro?: boolean; search?: ReactNode; calendar?: ReactNode; install?: ReactNode }) {
  const selected = words.filter(word => !state.skipped.includes(word.id) && (!state.settings.skipBasic || !word.basic) && (state.settings.deck === 'all' || word.tags.includes(state.settings.deck)));
  const progress = state.modes[mode].progress;
  const completed = selected.filter(word => progress[word.id]?.status === 'completed').length;
  const learning = selected.filter(word => progress[word.id]?.status === 'learning').length;
  const percentage = selected.length ? completed / selected.length : 0;
  const session = state.modes[mode].session;
  const top = words.filter(word => wrongCount(state, word.id) > 0).sort((a, b) => wrongCount(state, b.id) - wrongCount(state, a.id)).slice(0, 2);
  const date = new Intl.DateTimeFormat('zh-CN', { month: 'long', day: 'numeric', weekday: 'long' }).format(new Date());
  return <div className="page home-page">
    <div className="page-head"><div><div className="d">{date}</div><h1>背单词</h1></div>{install ?? <span className="streak"><Check size={14} />本机已保存</span>}</div>
    {search}
    <div className="panel prog-panel">
      <div className={`ring ${ringIntro ? 'ring-intro' : ''}`}><svg viewBox="0 0 92 92" aria-hidden="true"><circle cx="46" cy="46" r="39" fill="none" stroke="#EEECE7" strokeWidth="10" /><circle cx="46" cy="46" r="39" fill="none" stroke="var(--accent)" strokeWidth="10" strokeLinecap="round" strokeDasharray={`${percentage * 245} 245`} />{learning > 0 && <circle cx="46" cy="46" r="39" fill="none" stroke="#B26F12" strokeWidth="10" strokeDasharray={`${learning / selected.length * 245} 245`} strokeDashoffset={-percentage * 245} />}{ringIntro && <circle className="ring-intro-trace" cx="46" cy="46" r="39" fill="none" stroke="var(--accent)" strokeWidth="10" strokeLinecap="round" strokeDasharray="36 245" />}</svg><div className="pct"><div>{(percentage * 100).toFixed(1)}%<small>本轮完成</small></div></div></div>
      <div className="progress-copy"><div className="big-num">{completed.toLocaleString()}<span>/ {selected.length.toLocaleString()} 词</span></div><div className="sub">学习中 <b>{learning}</b> · 未学 <b>{selected.length - completed - learning}</b></div><div className="progress-mode"><span>{mode === 'look' ? '看词' : '听音'}进度</span><div className="progress-switch" role="group" aria-label="切换进度圆环">{(['look','listen'] as const).map(value => <button key={value} aria-label={`查看${value === 'look' ? '看词' : '听音'}进度`} aria-pressed={mode === value} className={mode === value ? 'on' : ''} onClick={() => onProgressMode?.(value)}>{value === 'look' ? <BookOpen size={12} /> : <Headphones size={12} />}{value === 'look' ? '看词' : '听音'}</button>)}</div></div></div>
    </div>
    <button className="continue" onClick={() => start(mode)}><span><span className="c1">{session?.status === 'active' ? '继续上次进度' : '按自己的节奏，每次一组'}</span><span className="c2">{session?.status === 'active' ? `第 ${session.groupNumber} 组 · ${modeNames[mode]} ${session.cursor + 1} / ${session.items.length}` : `开始${modeNames[mode]}`}</span></span><span className="go"><ArrowRight /></span></button>
    <div className="modes"><button className="mode" onClick={() => start('look')}><span className="mi"><BookOpen /></span><span className="mt">看词记忆</span><span className="md">显示单词<br />遮住词性和中文</span></button><button className="mode" onClick={() => start('listen')}><span className="mi g"><Headphones /></span><span className="mt">听音辨词</span><span className="md">只听读音<br />判断认不认识</span></button></div>
    {calendar}
    <div className="sec-head">不认识最多<button onClick={goWords}>生词本 <ArrowRight size={14} /></button></div>
    <WordList words={top} state={state} mode={mode} variant="home" onWord={onWord} />
    <p className="local-note">进度保存在当前设备。换设备前，请到设置导出备份。</p>
  </div>;
}

export interface StudyProps {
  state: AppState; mode: Mode; word?: Word; words: Word[]; busy: boolean; canAnswer: boolean;
  audioStatus: string; audioError: string; speaking: boolean;
  goHome: () => void; goSettings: () => void; speak: (slow?: boolean) => void;
  onAnswer: (result: 'known' | 'unknown') => void; onNext: () => void; onUndo: () => void;
  onSkip: () => void; onPauseWord: () => void; nextGroup: () => void; onWord: (word: Word) => void;
  knownPreview?: boolean;
  historyEntry?: Readonly<StudyTrailEntry>; historyOffset: number; historyCount: number;
  onHistory: (direction: 'previous' | 'next') => void; onReturnCurrent: () => void;
  onSettingsChange: (patch: Partial<StudySettings>) => void;
}

export function StudyPage(p: StudyProps) {
  const s = p.state.modes[p.mode].session;
  const nextButton = useRef<HTMLButtonElement>(null);
  const menu = useRef<HTMLDetailsElement>(null);
  const browsing = !!p.historyEntry;
  const swipe = useStudySwipe(!p.busy && !p.knownPreview, p.onHistory);
  useEffect(() => { if (s?.revealed && !browsing) nextButton.current?.focus({ preventScroll: true }); }, [s?.revealed, browsing]);
  useEffect(() => {
    const closeOutside = (event: PointerEvent) => { if (event.target instanceof Node && !menu.current?.contains(event.target) && menu.current) menu.current.open = false; };
    const closeEscape = (event: KeyboardEvent) => { if (event.key === 'Escape' && menu.current?.open) { menu.current.open = false; menu.current.querySelector('summary')?.focus(); } };
    document.addEventListener('pointerdown', closeOutside); document.addEventListener('keydown', closeEscape);
    return () => { document.removeEventListener('pointerdown', closeOutside); document.removeEventListener('keydown', closeEscape); };
  }, []);
  const progress = p.word ? p.state.modes[p.mode].progress[p.word.id] : undefined;
  const revealed = !!s?.revealed || !!p.knownPreview || browsing;
  const listening = p.mode === 'listen' && !revealed;
  const history = p.state.history.filter(h => h.mode === p.mode && h.previousSession.groupNumber === s?.groupNumber);
  const previous = s?.revealed ? history.findLast(h => h.wordId === p.word?.id)?.previousProgress : progress;
  const review = !!previous?.wrongCount;
  const tags = p.word ? wordTags(p.word) : [];
  const action = (run: () => void) => { if (menu.current) menu.current.open = false; run(); };
  const audioFeedback = p.audioError ? <details className="audio-error"><summary>发音暂不可用 · 查看</summary><div className="audio-error-panel" role="status">{p.audioError}<div><button onClick={() => p.speak()}>重试播放</button><button onClick={p.goSettings}>发音设置</button>{!s?.revealed && !browsing && <button disabled={p.busy} onClick={p.onPauseWord}>跳过本次</button>}</div></div></details> : <span role="status">{p.audioStatus}</span>;
  const phrases = p.word ? <PhraseSection key={p.word.id} wordId={p.word.id} dictionaryVersion={p.state.dictionaryVersion} inline onMore={() => p.word && p.onWord(p.word)} /> : null;
  return <>
    <div className="topbar"><button className="icon-btn" aria-label="返回首页" onClick={p.goHome}>{s?.status === 'finished' ? <X /> : <ChevronLeft />}</button><div className="tb-title"><h1 className="t1">{modeNames[p.mode]}</h1><div className="t2">{browsing ? '已学回看 · 不重复计数' : s?.status === 'finished' ? '本组已保存' : '第 ' + (s?.groupNumber ?? 1) + ' 组 · ' + (p.state.settings.accent === 'en-US' ? '美音' : '英音')}</div></div><details className="study-menu" ref={menu}><summary className="icon-btn" aria-label="学习操作"><Settings size={22} /></summary><div className="study-menu-panel">
      <div className="quick-heading">快捷设置</div>
      <label className="quick-field"><span>词库 <small>下一组生效</small></span><select aria-label="快捷词库范围" disabled={p.busy} value={p.state.settings.deck} onChange={event => p.onSettingsChange({ deck: event.target.value as StudySettings['deck'] })}>{(['all','cet4','cet6','ky','toefl','ielts','gre'] as const).map(deck => <option key={deck} value={deck}>{deckNames[deck]}</option>)}</select></label>
      <label className="quick-field"><span>每组词数</span><select aria-label="快捷每组单词数" disabled={p.busy} value={p.state.settings.groupSize} onChange={event => p.onSettingsChange({ groupSize: Number(event.target.value) as StudySettings['groupSize'] })}>{[10,20,30].map(size => <option key={size} value={size}>{size}</option>)}</select></label>
      <div className="quick-field"><span>自动朗读</span><button className="toggle" role="switch" aria-label="快捷自动朗读" disabled={p.busy} aria-checked={p.state.settings.autoSpeak} onClick={() => p.onSettingsChange({ autoSpeak: !p.state.settings.autoSpeak })} /></div>
      <label className="quick-field"><span>语速</span><select aria-label="快捷语速" value={p.state.settings.rate} disabled={p.busy} onChange={event => p.onSettingsChange({ rate: Number(event.target.value) })}><option value={0.65}>慢速</option><option value={0.9}>适中</option><option value={1}>正常</option></select></label>
      <button disabled={p.busy || !!p.knownPreview || p.historyOffset >= p.historyCount} onClick={() => action(() => p.onHistory('previous'))}><ChevronLeft />回看上一词</button>
      <button disabled={p.busy || browsing || !p.state.history.length} onClick={() => action(p.onUndo)}><RotateCcw />撤销上一操作</button>
      <button onClick={() => action(p.goSettings)}><Settings />全部学习设置</button>
    </div></details></div>
    {browsing && p.word && p.historyEntry ? <>
      <div className="prog history-meta"><span>第 {p.historyEntry.groupNumber} 组 · 第 {p.historyEntry.position + 1} 词</span><button onClick={p.onReturnCurrent}>回到当前待学词<ArrowRight size={13} /></button></div>
      <div className="stage swipe-stage" {...swipe}><div className="card history-card"><div className="chips"><span className="chip acc">已学回看</span><span className="chip">当时：{({ known: '认识', unknown: '不认识', skip: '已斩', defer: '本次跳过' })[p.historyEntry.action]}</span></div><div className="word-zone" data-revealed="true"><FittedWord word={p.word.word} /><div className="phon">{p.word.phonetic && <><span className="acc-tag">词典</span><span className="phonetic-text">/{p.word.phonetic}/</span></>}<button className="spk" aria-label="重听单词" onClick={() => p.speak()}><Volume2 size={19} /></button></div></div><div className="study-answer"><Meanings word={p.word} />{phrases}</div></div></div>
      <div className="actions"><button className="btn ghost" disabled={p.busy || p.historyOffset >= p.historyCount} onClick={() => p.onHistory('previous')}><ChevronLeft />更早一词</button><button className="btn primary" disabled={p.busy} onClick={() => p.onHistory('next')}>{p.historyOffset === 1 ? '回到当前' : '往后一词'}<ArrowRight /></button></div><div className="hint">右滑回看 · 左滑往后 · 回看不改变进度</div>
    </> : s?.status === 'finished' ? <>
      <div className="page summary-page swipe-stage" {...swipe}><div className="hero"><div className="badge"><Check size={34} /></div><h2>{s.items.length ? '第 ' + s.groupNumber + ' 组完成' : '当前词库已学完'}</h2><p>{s.items.length ? s.items.length + ' 个词 · 已保存进度' : '可以更换词库，或到生词本重新练习'}</p></div>
      <div className="tiles"><div className="tile g"><div className="tv">{s.known}</div><div className="tl">认识</div></div><div className="tile r"><div className="tv">{s.unknown}</div><div className="tl">不认识</div></div><div className="tile a"><div className="tv">{s.skipped}</div><div className="tl">跳过</div></div></div><div className="sec-head">这些词将在下一组继续复习</div><WordList mode={p.mode} variant="summary" words={p.words.filter(w => s.items.includes(w.id) && p.state.modes[p.mode].progress[w.id]?.status === 'learning' && !p.state.skipped.includes(w.id))} state={p.state} onWord={p.onWord} empty="本组没有待复习的词，继续学习新词吧。" /></div>
      <div className="actions"><button className="btn primary" disabled={p.busy || !s.items.length} onClick={p.nextGroup}>开始下一组<ArrowRight /></button></div><div className="hint">{p.historyCount > 0 && <button className="hint-link" onClick={() => p.onHistory('previous')}>右滑或点击回看上一词 · </button>}复习词优先，不够一组再补新词</div>
    </> : p.word && s ? <>
      <div className="prog"><div className="prog-meta"><span><b>{s.cursor + 1}</b> / {s.items.length}</span><span><em className="g">认识 {s.known}</em><em className="r">不认识 {s.unknown}</em></span></div><div className="segs" aria-label={'第 ' + (s.cursor + 1) + ' 个，共 ' + s.items.length + ' 个'}>{s.items.map((id, index) => { const result = history.findLast(h => h.previousSession.cursor === index)?.action; return <i key={id + ':' + index} className={result === 'unknown' ? 'r' : result === 'known' ? 'g' : index === s.cursor ? 'cur' : index < s.cursor ? 'done' : ''} />; })}</div></div>
      <div className="stage swipe-stage" {...swipe}><div className="card">
        <div className="chips">{p.knownPreview ? <><span className="chip good"><Check size={12} />认识 · 首次确认</span>{tags.map(tag => <span className="chip" key={tag}>{deckNames[tag]}</span>)}</> : listening ? <span className="chip acc"><Headphones className="ic" />听音</span> : review ? <><span className="chip review"><Repeat className="ic" />复习</span><span className="chip bad">不认识 ×{progress?.wrongCount}</span><span className="chip good">已认识 {progress?.streak ?? 0}/2</span></> : <>{s.revealed && <span className="chip bad">不认识 ×{progress?.wrongCount}</span>}{tags.map(tag => <span className="chip" key={tag}>{deckNames[tag]}</span>)}</>}</div>
        {listening ? <div className="listen-zone" key={p.word.id}><button className={'big-play ' + (p.speaking ? 'playing' : '')} aria-label="播放单词" onClick={() => p.speak()}><Volume2 className="ic" /></button><div className={'big-wave ' + (p.speaking ? 'speaking' : 'idle')} aria-hidden="true">{[8,14,22,30,18,26,34,20,12,24,30,16,10,20,14,8,5].map((height, index) => <i key={index} style={{ height: p.speaking ? height : 4 }} />)}</div><div className="listen-cap">{audioFeedback}</div><div className="hidden-word"><EyeOff className="ic" />拼写和释义已隐藏</div></div> : <div className="word-zone" key={p.word.id} data-revealed={revealed}><FittedWord word={p.word.word} /><div className="phon">{p.word.phonetic && <><span className="acc-tag">词典</span><span className="phonetic-text">/{p.word.phonetic}/</span></>}<button className={'spk ' + (p.speaking ? 'on' : '')} aria-label="重听单词" aria-description={p.audioError || undefined} onClick={() => p.speak()}><Volume2 className="ic" /></button></div>{(!revealed || p.mode === 'listen') && <div className="reading">{p.speaking && <span className="wave" aria-hidden="true">{[6,12,16,9,13,5].map((height, index) => <i key={index} style={{ height }} />)}</span>}{audioFeedback}</div>}</div>}
        {p.knownPreview ? <><div className="study-answer"><Meanings word={p.word} />{phrases}</div><div className="known-confirmation" role="status"><span>首次出现，确认一下词义</span><span>即将自动继续</span></div></> : s.revealed ? <><div className="study-answer"><Meanings word={p.word} />{phrases}</div><div className="after"><span>已加入第 {s.groupNumber + 1} 组</span><span className="dots">再认识 <i /><i /> 次才算掌握</span></div></> : listening ? <div className="ctrls"><button className="ctrl" onClick={() => p.speak()}><RotateCcw className="ic" />再听一遍</button><button className="ctrl" onClick={() => p.speak(true)}><Snail className="ic" />慢速</button><button className="ctrl sel" aria-label="选择发音" onClick={p.goSettings}>{p.state.settings.accent === 'en-US' ? '美音' : '英音'}</button></div> : <div className="mask"><EyeOff className="ic" /><div className="m1">词性和中文已遮住</div><div className="m2">点「不认识」立即显示</div></div>}
      </div></div>
      <div className="actions">{p.knownPreview ? <button className="btn primary" disabled><Check />认识 · 即将继续</button> : s.revealed ? <><button className="btn ghost" disabled={p.busy} onClick={p.onUndo}><RotateCcw />撤销</button><button ref={nextButton} className="btn dark" disabled={p.busy} onClick={p.onNext}>下一个<ArrowRight /></button></> : <><button className="btn bad" disabled={p.busy || !p.canAnswer} onClick={() => p.onAnswer('unknown')}><X />不认识</button><button className="btn good" disabled={p.busy || !p.canAnswer} onClick={() => p.onAnswer('known')}><Check />认识</button><button className="slash-button" disabled={p.busy} aria-label="斩，长期跳过当前单词" title="斩：太简单，长期跳过" onClick={p.onSkip}>斩</button></>}</div>
      <div className="hint">{p.knownPreview ? <>已保存本次认识，词义展示后继续</> : <>{p.historyCount > 0 && <button className="hint-link" aria-label="回看上一词" disabled={p.busy} onClick={() => p.onHistory('previous')}>右滑回看 · </button>}{s.revealed ? <><kbd>Enter</kbd> 下一词 · <button className="hint-link" aria-label="查看当前单词的短语与近义表达" onClick={() => { if (p.word) p.onWord(p.word); }}>全部短语 / 近义</button></> : <>键盘 <kbd>←</kbd> 不认识 · <kbd>→</kbd> 认识</>}</>}</div>
    </> : <p className="empty">正在恢复学习位置…</p>}
  </>;
}

export function SearchBox({ value, onChange, placeholder = '搜索单词或中文' }: { value: string; onChange: (s: string) => void; placeholder?: string }) {
  return <label className="search"><Search size={18} /><input aria-label={placeholder} value={value} onChange={e => onChange(e.target.value)} placeholder={placeholder} type="search" maxLength={300} autoCapitalize="none" autoCorrect="off" spellCheck={false} /></label>;
}
