import { ArrowRight, Plus } from 'lucide-react';
import { useMemo } from 'react';
import { getRetentionSummary, type AppState, type Mode, type Word } from '../../../packages/core/src';

export function RetentionCard({ state, words, mode, today, busy, start, extra }: {
  state: AppState; words: Word[]; mode: Mode; today: string; busy: boolean;
  start: () => void; extra: () => void;
}) {
  const summary = useMemo(() => getRetentionSummary(state, words, mode, today), [state, words, mode, today]);
  if (!state.settings.retentionEnabled) return null;
  const session = state.modes[mode].session;
  const active = session?.status === 'active';
  const queued = active && session.retentionIds?.some(id => session.items.indexOf(id) >= session.cursor && !state.skipped.includes(id));
  if (!summary.totalDue && !summary.completedToday && !queued) return null;
  const canSchedule = summary.available > 0;
  return <section className="panel retention-panel" aria-label="间隔巩固">
    <div className="retention-heading"><strong>间隔巩固</strong><span>今日已检验 {summary.completedToday} / {summary.dailyLimit}</span></div>
    <p>{mode === 'look' ? '看词' : '听音'}待巩固 <b>{summary.due}</b> · 两种模式共 {summary.totalDue} 项</p>
    <small>{active ? '当前组保持原位，到期词从下一组安排。' : canSchedule ? '先复习错词，再检验已学词；巩固不抵扣新词目标。' : summary.due ? '已达到今日自动上限，待巩固词会保留。' : '当前模式暂时没有到期的词。'}</small>
    <div className="retention-actions"><button className="row-action" disabled={busy || (!active && !canSchedule)} onClick={start}>{active ? '继续当前组' : canSchedule ? '开始巩固' : '本模式暂已完成'}<ArrowRight size={16} /></button>{summary.unreservedDue > 0 && !summary.remainingAllowance && summary.dailyLimit < 1000 && <button className="row-action" disabled={busy} onClick={extra}><Plus size={15} />再巩固 5 词</button>}</div>
  </section>;
}
