import { useMemo, useState } from 'react';
import { CalendarDays, ChevronLeft, ChevronRight } from 'lucide-react';
import { getLocalDateKey, type AppState, type Word } from '../../../packages/core/src';
import { brief, wrongCount } from './components';

export function LearningCalendar({ state, onDay }: { state: AppState; onDay: (date: string) => void }) {
  const today = new Date();
  const todayKey = getLocalDateKey(today.getTime(), today.getTimezoneOffset());
  const [month, setMonth] = useState(() => new Date(today.getFullYear(), today.getMonth(), 1));
  const year = month.getFullYear();
  const monthIndex = month.getMonth();
  const leading = (month.getDay() + 6) % 7;
  const days = new Date(year, monthIndex + 1, 0).getDate();
  const monthPrefix = `${year}-${String(monthIndex + 1).padStart(2, '0')}-`;
  const monthCount = Object.keys(state.dailyActivity).filter(key => key.startsWith(monthPrefix)).length;
  return <section className="panel calendar-panel" aria-label="学习日历">
    <div className="calendar-heading"><div><CalendarDays size={18} /><h2>学习日历</h2></div><span>本月学习 {monthCount} 天</span></div>
    <div className="calendar-month"><button className="icon-btn" aria-label="上个月" onClick={() => setMonth(new Date(year, monthIndex - 1, 1))}><ChevronLeft /></button><span aria-live="polite">{year} 年 {monthIndex + 1} 月</span><button className="icon-btn" aria-label="下个月" disabled={year === today.getFullYear() && monthIndex === today.getMonth()} onClick={() => setMonth(new Date(year, monthIndex + 1, 1))}><ChevronRight /></button></div>
    <div className="calendar-grid">{['一','二','三','四','五','六','日'].map(day => <span className="calendar-weekday" key={day}>{day}</span>)}{Array.from({ length: leading }, (_, index) => <span key={`empty-${index}`} />)}{Array.from({ length: days }, (_, index) => {
      const day = index + 1;
      const key = `${monthPrefix}${String(day).padStart(2, '0')}`;
      const count = Object.keys(state.dailyActivity[key] ?? {}).length;
      return <button key={key} className={`calendar-day ${count ? 'has-activity' : ''} ${key === todayKey ? 'today' : ''}`} aria-current={key === todayKey ? 'date' : undefined} aria-label={`${year}年${monthIndex + 1}月${day}日，背词${count}个`} disabled={key > todayKey} onClick={() => onDay(key)}><span>{day}</span><small>{count ? `${count} 词` : '·'}</small></button>;
    })}</div>
    <p className="calendar-note">点击日期查看单词 · 同一天重复学习只计一个词</p>
  </section>;
}

export function DailyWords({ state, words, date, onWord }: { state: AppState; words: Word[]; date: string; onWord: (word: Word) => void }) {
  const entries = state.dailyActivity[date] ?? {};
  const lookup = useMemo(() => new Map(words.map(word => [word.id, word])), [words]);
  const ids = Object.keys(entries).sort((a, b) => {
    const aErrors = entries[a]!.look.unknown + entries[a]!.listen.unknown;
    const bErrors = entries[b]!.look.unknown + entries[b]!.listen.unknown;
    return bErrors - aErrors || (lookup.get(a)?.word ?? a).localeCompare(lookup.get(b)?.word ?? b);
  });
  const errors = ids.reduce((sum, id) => sum + entries[id]!.look.unknown + entries[id]!.listen.unknown, 0);
  return <div className="daily-content"><div className="daily-summary"><strong>{ids.length}<span> 个单词</span></strong><span>当日不认识 <b>{errors}</b> 次</span></div><p className="help-text">记录已作答的单词，包含看词与听音；跳过不计入。</p>{ids.length ? <div className="daily-words">{ids.map(id => {
    const word = lookup.get(id);
    if (!word) return null;
    const counts = entries[id]!;
    const unknown = counts.look.unknown + counts.listen.unknown;
    return <button key={id} className="daily-word" onClick={() => onWord(word)}><span className="w">{word.word}</span><span className="daily-count">当日不认识 <b>{unknown}</b> 次</span><span className="zh">{brief(word)}</span><span className="daily-total">累计不认识 {wrongCount(state, id)} 次 · {counts.look.known + counts.look.unknown ? '看词' : ''}{counts.look.known + counts.look.unknown && counts.listen.known + counts.listen.unknown ? ' / ' : ''}{counts.listen.known + counts.listen.unknown ? '听音' : ''}</span></button>;
  })}</div> : <p className="empty">这一天还没有学习记录。<br />日历从此版本开始记录，旧进度仍然保留。</p>}</div>;
}
