import { useEffect, useId, useLayoutEffect, useMemo, useRef, useState, type KeyboardEvent } from 'react';
import { ArrowRight, BookOpen, Check, ChevronDown, Pencil } from 'lucide-react';
import type { Deck, Mode, StudyPlanSummary } from '../../../packages/core/src';
import { isLocalDateKey } from '../../../packages/core/src/activity';
import { deckNames } from './components';
import { Modal } from './Modal';
import './study-plan.css';

const decks: Deck[] = ['all', 'cet4', 'cet6', 'ky', 'toefl', 'ielts', 'gre'];
export const studyPlanBookName = (deck: Deck) => deck === 'all' ? deckNames[deck]! : `${deckNames[deck]}词汇`;
const dayNumber = (date: string) => Date.parse(`${date}T00:00:00Z`) / 86_400_000;
export const defaultPlanDeadline = (today: string) => new Date((dayNumber(today) + 29) * 86_400_000).toISOString().slice(0, 10);

export function StudyPlanCard({ deck, mode, summary, remainingNewWords, scopeChanged, onDeckChange, onEdit, onCheckIn, busy }: {
  deck: Deck; mode: Mode; summary: StudyPlanSummary | null; remainingNewWords: number;
  scopeChanged: boolean; onDeckChange: (deck: Deck) => void; onEdit: () => void; onCheckIn: () => void; busy: boolean;
}) {
  const total = summary ? summary.newTarget + summary.reviewTarget : 0;
  const completed = summary ? summary.newCompleted + summary.reviewCompleted : 0;
  return <section className={'panel study-plan-card' + (summary?.canCheckIn ? ' plan-complete' : '') + (summary?.checkedIn ? ' plan-checked-in' : '')} aria-label="本书学习计划">
    <div className="study-plan-heading"><span className="plan-book-icon"><BookOpen size={19} /></span><div className="plan-book-choice"><select aria-label="选择计划词书" value={deck} disabled={busy} onChange={event => onDeckChange(event.target.value as Deck)}>{decks.map(value => <option key={value} value={value}>{studyPlanBookName(value)}</option>)}</select><ChevronDown size={11} /><span>· {mode === 'look' ? '看词' : '听音'}</span></div><button className="plan-edit" onClick={onEdit} disabled={busy} aria-label="编辑本书学习计划"><Pencil size={14} />计划</button></div>
    {summary ? <>
      {summary.canCheckIn && <div className="plan-success" role="status"><div className="plan-success-title"><span className="plan-success-mark"><Check size={20} /></span><strong>{summary.checkedIn ? '今日已打卡' : '今日目标完成'}</strong></div><small>{summary.checkedIn && summary.day.checkedInAt ? `${new Date(summary.day.checkedInAt).toLocaleDateString('zh-CN').replaceAll('/', '.')} | 今日 ${completed} 词` : summary.hasActivity ? `${completed} 词，今天的计划完成了` : '本书今日没有待学任务'}</small></div>}
      <div className="plan-numbers"><div><span>今日待学</span><output aria-label="今日待学">{summary.remainingToday.toLocaleString()}</output></div><div><span>剩余 / 总天数</span><output aria-label="计划剩余天数与总天数">{summary.remainingDays} <i>/</i> {summary.totalDays}</output></div></div>
      <p className="plan-breakdown">新词 {summary.canCheckIn ? summary.newCompleted : summary.pendingNew} · 复习 {summary.canCheckIn ? summary.reviewCompleted : summary.pendingReview}{summary.overdue && <span>已到期，仍可继续学习</span>}</p>
      {scopeChanged && <p className="plan-scope-note">基础词范围已更改，保存计划后更新。</p>}
      <progress className="plan-progress" aria-label="今日计划完成进度" max={Math.max(1, total)} value={total ? Math.min(total, completed) : 1} />
      <div className="plan-progress-label"><span>今日已完成</span><span>{completed} / {total}</span></div>
      {summary.canCheckIn && <button className="btn primary plan-check-in" disabled={busy} onClick={onCheckIn}>{summary.checkedIn ? '分享打卡卡片' : '打卡并分享'}<ArrowRight size={16} /></button>}
    </> : <div className="plan-empty"><strong>给这本书定个计划</strong><p>{remainingNewWords.toLocaleString()} 个新词，按截止日期分到每天</p><button onClick={onEdit} disabled={busy}>制定本书计划<ArrowRight size={14} /></button></div>}
  </section>;
}

function WheelColumn({ label, values, value, suffix, onChange }: { label: string; values: number[]; value: number; suffix: string; onChange: (value: number) => void }) {
  const list = useRef<HTMLDivElement>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const id = useId();
  useLayoutEffect(() => { const element = list.current; const index = values.indexOf(value); if (element && index >= 0 && Math.abs(element.scrollTop - index * 44) > 1) element.scrollTop = index * 44; }, [value, values]);
  useEffect(() => () => { if (timer.current) clearTimeout(timer.current); }, []);
  const select = (index: number) => { const selected = values[Math.max(0, Math.min(values.length - 1, index))]; if (selected !== undefined) onChange(selected); };
  const key = (event: KeyboardEvent<HTMLDivElement>) => {
    const index = values.indexOf(value);
    if (event.key === 'ArrowUp' || event.key === 'ArrowDown') { event.preventDefault(); select(index + (event.key === 'ArrowUp' ? -1 : 1)); }
    else if (event.key === 'Home' || event.key === 'End') { event.preventDefault(); select(event.key === 'Home' ? 0 : values.length - 1); }
  };
  return <div className="plan-wheel" ref={list} role="listbox" aria-label={label} aria-activedescendant={`${id}-${value}`} tabIndex={0} onKeyDown={key} onScroll={() => { if (timer.current) clearTimeout(timer.current); timer.current = setTimeout(() => { if (list.current) select(Math.round(list.current.scrollTop / 44)); }, 100); }}>
    {values.map(number => <button key={number} id={`${id}-${number}`} type="button" role="option" aria-selected={number === value} tabIndex={-1} onClick={() => onChange(number)}>{number}<small>{suffix}</small></button>)}
  </div>;
}

export function StudyPlanEditor({ deck, mode, summary, totalWords, remainingNewWords, completedNewToday, today, busy, error, close, onSave }: {
  deck: Deck; mode: Mode; summary: StudyPlanSummary | null; totalWords: number; remainingNewWords: number; completedNewToday: number; today: string; busy: boolean; error: string; close: () => void; onSave: (deadline: string) => Promise<boolean>;
}) {
  const [deadline, setDeadline] = useState(() => summary && summary.plan.deadline >= today ? summary.plan.deadline : defaultPlanDeadline(today));
  const [saving, setSaving] = useState(false);
  const [year, month, day] = deadline.split('-').map(Number) as [number, number, number];
  const currentYear = Number(today.slice(0, 4));
  const years = useMemo(() => Array.from({ length: 13 }, (_, index) => currentYear - 2 + index), [currentYear]);
  const months = useMemo(() => Array.from({ length: 12 }, (_, index) => index + 1), []);
  const days = useMemo(() => Array.from({ length: new Date(Date.UTC(year, month, 0)).getUTCDate() }, (_, index) => index + 1), [year, month]);
  const startedOn = summary?.plan.startedOn ?? today;
  const totalDays = Math.max(1, Math.round(dayNumber(deadline) - dayNumber(startedOn)) + 1);
  const valid = isLocalDateKey(deadline) && deadline >= today && dayNumber(deadline) - dayNumber(today) < 3660 && totalDays <= 3660;
  const remainingDays = Math.max(1, Math.round(dayNumber(deadline) - dayNumber(today)) + 1);
  const dailyNew = Math.ceil((remainingNewWords + completedNewToday) / remainingDays);
  const changeDate = (nextYear: number, nextMonth: number, nextDay: number) => {
    const last = new Date(Date.UTC(nextYear, nextMonth, 0)).getUTCDate();
    setDeadline(`${nextYear}-${String(nextMonth).padStart(2, '0')}-${String(Math.min(last, nextDay)).padStart(2, '0')}`);
  };
  const save = async () => { if (!valid || saving || busy) return; setSaving(true); try { if (await onSave(deadline)) close(); } finally { setSaving(false); } };
  return <Modal fullScreen title="学习计划" close={close} headerAction={<button className="plan-reset" disabled={saving || busy} onClick={() => setDeadline(defaultPlanDeadline(today))}>重置</button>}>
    <div className="study-plan-editor"><div className="plan-editor-scroll"><div className="plan-editor-book"><span className="plan-book-icon"><BookOpen size={26} /></span><div><h3>{studyPlanBookName(deck)}</h3><p>{mode === 'look' ? '看词' : '听音'}计划 · {totalWords.toLocaleString()} 词</p></div></div>
      <div className="plan-editor-fields"><div className="plan-date-row"><span>开始日期</span><time dateTime={startedOn}>{startedOn.replaceAll('-', '/')}</time></div><div className="plan-deadline-label">截止日期</div><div className="plan-date-wheels" role="group" aria-label="截止日期"><WheelColumn label="截止年份" value={year} values={years} suffix="年" onChange={value => changeDate(value, month, day)} /><WheelColumn label="截止月份" value={month} values={months} suffix="月" onChange={value => changeDate(year, value, day)} /><WheelColumn label="截止日" value={day} values={days} suffix="日" onChange={value => changeDate(year, month, value)} /></div><div className="plan-day-total">共计 <b>{totalDays}</b> 天</div><div className="plan-target-preview"><div><strong>{remainingNewWords.toLocaleString()}</strong><span>待学新词</span></div><div><strong>{dailyNew.toLocaleString()}</strong><span>每日新词</span></div></div><p className="plan-editor-note">复习单独安排，不占新词目标</p></div>
      {!valid && <p className="plan-form-error" role="alert">请选择今天至未来十年内的截止日期。</p>}{error && <p className="plan-form-error" role="alert">{error}</p>}{dailyNew > 200 && <p className="plan-editor-note">每天新词较多，可以延长计划，给复习留些时间。</p>}
    </div><div className="plan-editor-actions"><p>只调整这本书，已有进度保留</p><button className="btn primary" disabled={saving || busy || !valid} onClick={() => void save()}>{saving || busy ? '正在保存…' : '保存计划'}</button></div></div>
  </Modal>;
}
