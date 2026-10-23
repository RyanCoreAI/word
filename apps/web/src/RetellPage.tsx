import { useCallback, useEffect, useRef, useState } from 'react';
import { ArrowRight, AudioLines, BookOpen, Check, ChevronLeft, ChevronRight, Download, EyeOff, Headphones, Mic, Pause, Play, RotateCcw, Square, X } from 'lucide-react';
import type { Settings } from '../../../packages/core/src';
import { RetellAsrController, type AsrState } from './lib/retell-asr';
import type { SpeechState } from './lib/speech';
import { lessons, lessonVersion, lessonWordCount, type RetellLesson } from './retell/lessons';
import { PassageNarrator } from './retell/narrator';
import { exportAttemptText, readAttempts, saveAttempt, type RetellAttempt } from './retell/storage';
import { Modal } from './Modal';
import '@fontsource/source-serif-4/400.css';
import './retell/retell.css';

type Stage = 'list' | 'read' | 'speak' | 'compare';
const timer = (milliseconds: number) => `${Math.floor(milliseconds / 60000).toString().padStart(2,'0')}:${Math.floor(milliseconds / 1000 % 60).toString().padStart(2,'0')}`;
const isBlocking = (state: AsrState | null) => !!state && ['loading','recording','paused','transcribing'].includes(state.status);
function retellFailure(failure: unknown, fallback: string): string {
  if (failure instanceof DOMException) {
    if (['NotAllowedError','SecurityError'].includes(failure.name)) return '麦克风权限未开启。请在浏览器的网站设置中允许麦克风后重试。';
    if (failure.name === 'NotFoundError') return '没有找到可用麦克风，请连接或开启麦克风后重试。';
    if (failure.name === 'NotReadableError') return '麦克风被占用或无法读取，请结束其他录音后重试。';
    if (failure.name === 'QuotaExceededError') return '设备空间不足。识别包缓存约需 146 MB，请释放空间后重新校验；已有学习进度和录音仍保留。';
    if (failure.name === 'AbortError') return '当前操作已取消，已完成的录音仍保留。';
  }
  return failure instanceof Error ? failure.message : fallback;
}

function Steps({ stage }: { stage: Stage }) {
  const active = stage === 'read' ? 0 : stage === 'speak' ? 1 : 2;
  return <ol className="retell-steps" aria-label="复述步骤">{['阅读','复述','对照'].map((label, index) => <li key={label} className={index <= active ? 'active' : ''} aria-current={index === active ? 'step' : undefined}><span>{index < active ? <Check size={11} /> : null}</span>{label}</li>)}</ol>;
}

export default function RetellPage({ settings, onBusyChange }: { settings: Settings; onBusyChange: (busy: boolean) => void }) {
  const [stage, setStage] = useState<Stage>('list');
  const [selected, setSelected] = useState(lessons[0]!.id);
  const [readMode, setReadMode] = useState<'read' | 'listen'>('read');
  const [asr, setAsr] = useState<AsrState | null>(null);
  const [speech, setSpeech] = useState<SpeechState | null>(null);
  const [attempts, setAttempts] = useState<RetellAttempt[]>([]);
  const [currentAttempt, setCurrentAttempt] = useState<RetellAttempt | null>(null);
  const [audioUrl, setAudioUrl] = useState('');
  const [recordingAudioUrl, setRecordingAudioUrl] = useState('');
  const [reference, setReference] = useState<0 | 1>(0);
  const [error, setError] = useState('');
  const [saved, setSaved] = useState(true);
  const [working, setWorking] = useState(false);
  const [exportedText, setExportedText] = useState('');
  const [exportMessage, setExportMessage] = useState('');
  const exportField = useRef<HTMLTextAreaElement>(null);
  const [lastRecording, setLastRecording] = useState<{ audioBlob: Blob; durationMs: number } | null>(null);
  const [recordingLessonId, setRecordingLessonId] = useState('');
  const recordingLesson = useRef('');
  const asrRef = useRef<RetellAsrController | null>(null);
  const narrator = useRef<PassageNarrator | null>(null);
  const download = useRef<AbortController | null>(null);
  const mounted = useRef(false);
  const processedResult = useRef<AsrState['result']>(null);
  const lesson = lessons.find(item => item.id === selected)!;
  const blocking = isBlocking(asr) || working;
  useEffect(() => {
    mounted.current = true;
    const controller = new RetellAsrController(); asrRef.current = controller;
    const update = () => { if (mounted.current && asrRef.current === controller) { setAsr(controller.getState()); setLastRecording(controller.getLastRecording()); } };
    const unsubscribe = controller.subscribe(update); queueMicrotask(update);
    const speaker = new PassageNarrator(state => { if (mounted.current) setSpeech(state); }); narrator.current = speaker;
    void readAttempts().then(rows => { if (mounted.current) setAttempts(rows); }).catch(() => { if (mounted.current) setError('本机复述记录暂时无法读取，原数据仍保留。请导出可见记录后检查浏览器存储。'); });
    return () => { mounted.current = false; unsubscribe(); download.current?.abort(); controller.dispose(); speaker.dispose(); if (asrRef.current === controller) asrRef.current = null; };
  }, []);
  useEffect(() => { onBusyChange(blocking); return () => onBusyChange(false); }, [blocking, onBusyChange]);
  useEffect(() => {
    if (!blocking) return;
    const prevent = (event: BeforeUnloadEvent) => { event.preventDefault(); event.returnValue = ''; };
    window.addEventListener('beforeunload', prevent); return () => window.removeEventListener('beforeunload', prevent);
  }, [blocking]);
  useEffect(() => { if (!currentAttempt) return; const url = URL.createObjectURL(currentAttempt.audioBlob); queueMicrotask(() => { if (mounted.current) setAudioUrl(url); }); return () => URL.revokeObjectURL(url); }, [currentAttempt]);
  useEffect(() => { if (!lastRecording) return; const url = URL.createObjectURL(lastRecording.audioBlob); queueMicrotask(() => { if (mounted.current) setRecordingAudioUrl(url); }); return () => URL.revokeObjectURL(url); }, [lastRecording]);
  useEffect(() => {
    const result = asr?.result;
    if (!result || result === processedResult.current || !recordingLesson.current) return;
    processedResult.current = result;
    const resultLesson = recordingLesson.current;
    // Both a user stop and the three-minute limit emit the same real result.
    // The object identity prevents duplicate writes as status/timer updates arrive.
    queueMicrotask(async () => {
      if (!mounted.current) return;
      setWorking(true); setError('');
      const record: RetellAttempt = { lessonId: resultLesson, lessonVersion, transcript: result.transcript, audioBlob: result.audioBlob, durationMs: Math.min(180000, Math.round(result.durationMs)), completedAt: Date.now() };
      setSelected(resultLesson); setCurrentAttempt(record); setSaved(false); setStage('compare');
      try { await saveAttempt(record); if (mounted.current) { setSaved(true); setAttempts(rows => [...rows.filter(row => row.lessonId !== record.lessonId), record]); } }
      catch (failure) { if (mounted.current) setError(failure instanceof Error ? failure.message : '本次结果尚未保存，请下载文字或录音。'); }
      finally { if (mounted.current) setWorking(false); }
    });
  }, [asr?.result]);
  const openLesson = (item: RetellLesson) => { narrator.current?.cancel(); setSelected(item.id); setCurrentAttempt(null); setError(''); setReference(0); setStage('read'); };
  const speak = () => { setError(''); narrator.current?.speak(lesson.paragraphs.join(' '), { wordId: `retell:${lesson.id}`, accent: settings.accent, voiceURI: settings.voiceURI, rate: settings.rate }); };
  const begin = async () => { if (working || blocking || asr?.status === 'downloading') return; setError(''); narrator.current?.cancel(); try { const controller = asrRef.current; if (!controller) return; await controller.start(); recordingLesson.current = lesson.id; setRecordingLessonId(lesson.id); } catch (failure) { if (mounted.current) setError(retellFailure(failure, '录音未开始，请检查麦克风权限。')); } };
  const prepare = async () => { if (asr?.status === 'downloading') return; setError(''); const abort = new AbortController(); download.current = abort; try { await asrRef.current?.prepare(abort.signal); } catch (failure) { if (mounted.current && !abort.signal.aborted) setError(retellFailure(failure, '识别资源下载失败，可重试。')); } };
  const finish = useCallback(async (retry = false) => {
    if (!asrRef.current || working) return;
    if (retry && recordingLesson.current !== lesson.id) { setError('这段录音属于另一篇文章，请先录制本篇复述。'); return; }
    setWorking(true); setError('');
    try {
      if (retry) await asrRef.current.retry(); else await asrRef.current.stop();
    } catch (failure) { if (mounted.current) { setError(retellFailure(failure, '识别未完成，请重试。')); setWorking(false); } }
  }, [working, lesson.id]);
  const exportText = () => {
    const rows = currentAttempt ? [...attempts.filter(row => row.lessonId !== currentAttempt.lessonId), currentAttempt] : attempts;
    setExportedText(exportAttemptText(rows)); setExportMessage('');
  };
  const previous = attempts.find(attempt => attempt.lessonId === selected && attempt.lessonVersion === lessonVersion);
  return <section className="retell-root" aria-label="短文复述">
    {stage === 'list' ? <div className="retell-library"><div className="page retell-library-content"><div className="page-head"><div><h1>复述</h1><p>每天一篇，把读懂变成会说</p></div><Mic size={22} /></div><div className="seg retell-mode">{(['read','listen'] as const).map(mode => <button key={mode} className={readMode === mode ? 'on' : ''} onClick={() => setReadMode(mode)}>{mode === 'read' ? <BookOpen size={17} /> : <Headphones size={17} />}{mode === 'read' ? '阅读短文' : '听短文'}</button>)}</div><div className="retell-articles">{lessons.map(item => { const attempt = attempts.find(row => row.lessonId === item.id && row.lessonVersion === lessonVersion); return <button className={'retell-article ' + (selected === item.id ? 'selected' : '')} key={item.id} onClick={() => setSelected(item.id)} aria-pressed={selected === item.id}><div className="retell-article-title"><span>{item.title}</span><ChevronRight size={18} /></div><div className="retell-article-zh">{item.chineseTitle}</div><p>{item.topic} · {lessonWordCount(item)} 词{attempt ? ' · 已练习' : ''}</p>{selected === item.id && <small>{item.introduction}</small>}</button>; })}</div><p className="retell-library-note">教学短文依据研究与官方资料编辑，附来源和两份参考复述。不是官方雅思试题。</p></div><div className="retell-library-actions"><button className="btn primary" onClick={() => openLesson(lesson)}>开始这篇<ArrowRight /></button>{previous && <button className="retell-text-button" onClick={() => { setCurrentAttempt(previous); setStage('compare'); setSaved(true); }}>查看本机上次复述</button>}</div></div> : <>
      <div className="topbar"><button className="icon-btn" aria-label="返回复述选文" disabled={blocking || asr?.status === 'downloading'} onClick={() => { narrator.current?.cancel(); setStage('list'); }}><ChevronLeft /></button><span className="retell-top-title">{lesson.title}</span></div>
      <Steps stage={stage} />
      {error && <div className="notice error" role="alert">{error}</div>}
      {stage === 'read' && <><div className="retell-scroll retell-reader"><div className="retell-label">原创教学改写 · {lesson.topic}</div><h1>{lesson.title}</h1><h2>{lesson.chineseTitle}</h2><p className="retell-meta">{lessonWordCount(lesson)} 词 · 阅读与复述</p><div className="seg retell-mode">{(['read','listen'] as const).map(mode => <button key={mode} className={readMode === mode ? 'on' : ''} onClick={() => { setReadMode(mode); if (mode === 'read') narrator.current?.cancel(); }}>{mode === 'read' ? <BookOpen size={16} /> : <Headphones size={16} />}{mode === 'read' ? '阅读原文' : '听音频'}</button>)}</div><div className="retell-playback"><button className="icon-btn" aria-label={speech?.status === 'speaking' ? '停止朗读全文' : '播放全文'} onClick={() => speech?.status === 'speaking' ? narrator.current?.cancel() : speak()}>{speech?.status === 'speaking' ? <Square size={18} /> : <Play size={19} />}</button><div><strong>{speech?.status === 'speaking' ? '正在朗读' : '播放全文'}</strong><small>本机英文声音 · {settings.rate === .65 ? '慢速' : settings.rate === 1 ? '正常' : '适中'}</small></div></div>{(speech?.status === 'error' || speech?.status === 'unavailable') && <p className="retell-error" role="status">{speech.error}</p>}{readMode === 'read' ? <article className="retell-passage" lang="en">{lesson.paragraphs.map(paragraph => <p key={paragraph}>{paragraph}</p>)}</article> : <div className="retell-listen-only"><Headphones size={42} /><p>先听一遍，再用自己的话复述</p><button className="retell-text-button" onClick={() => setReadMode('read')}>需要时查看原文</button></div>}<details className="retell-sources"><summary>内容来源与编辑说明</summary><p>本文与参考复述为本项目编辑的教学表达，依据下列资料核对事实，不是来源机构原文或官方试题。难度未作官方分级。</p>{lesson.sources.map(source => <a key={source.url} href={source.url} target="_blank" rel="noreferrer">{source.publisher} · {source.title}</a>)}</details></div><div className="retell-bottom"><button className="btn primary" onClick={() => { narrator.current?.cancel(); setError(''); setStage('speak'); }}>隐藏原文，开始复述<ArrowRight /></button></div></>}
      {stage === 'speak' && <><div className="retell-scroll retell-speaking"><div className="retell-hidden"><EyeOff size={17} />原文已隐藏</div><p className="retell-speaking-note">根据理解，用英语说出主要内容。<br />最长录制 3 分钟。</p>{(!asr?.modelReady || asr.status === 'downloading') && <div className="retell-setup"><strong>启用离线语音识别</strong><p>首次约 73 MB，以下载进度显示为准。资源从本站下载，校验缓存后可离线识别；录音不上传。</p>{asr?.status === 'downloading' ? <><progress max={Math.max(1,asr.totalBytes)} value={asr.downloadedBytes} /><p role="status">正在下载并校验 · {asr.totalBytes ? Math.round(asr.downloadedBytes / asr.totalBytes * 100) : 0}%</p><button className="retell-text-button" onClick={() => download.current?.abort()}>暂停下载</button></> : <button className="btn primary" onClick={() => void prepare()} disabled={!asr}>下载并启用</button>}</div>}<div className={'retell-microphone-zone ' + (asr?.status === 'recording' ? 'active' : '')}><AudioLines size={45} /><button className="retell-microphone" aria-label="开始语音复述" disabled={!asr?.modelReady || blocking || asr.status === 'downloading'} onClick={() => void begin()}><Mic size={44} /></button><AudioLines size={45} /></div><div className="retell-timer">{timer(asr?.durationMs ?? 0)}</div><div className="retell-record-status" role="status">{working || asr?.status === 'transcribing' ? '正在本机识别，请稍候…' : asr?.status === 'loading' ? '正在准备识别…' : asr?.status === 'downloading' ? '正在校验识别包…' : asr?.status === 'recording' ? '正在录音' : asr?.status === 'paused' ? '已暂停录音' : '点击麦克风开始'}</div>{(asr?.status === 'recording' || asr?.status === 'paused') && <button className="retell-pause" onClick={() => asr.status === 'paused' ? asrRef.current?.resume() : asrRef.current?.pause()}>{asr.status === 'paused' ? <Play size={18} /> : <Pause size={18} />}{asr.status === 'paused' ? '继续录音' : '暂停'}</button>}{asr?.error && !error && <p className="retell-error" role="alert">{asr.error}</p>}{asr?.status === 'error' && !blocking && <button className="retell-text-button" onClick={() => void prepare()}>重新校验识别包</button>}{lastRecording && recordingLessonId === lesson.id && !blocking && <div className="retell-retry"><p>录音已保留，可回听后重新识别。</p>{recordingAudioUrl && <audio controls src={recordingAudioUrl} aria-label="回听保留的录音" />}<button className="retell-text-button" onClick={() => void finish(true)}>重试识别这段录音</button></div>}{blocking && <button className="retell-text-button" onClick={() => { const recording = asr?.status === 'recording' || asr?.status === 'paused'; asrRef.current?.cancel(); setWorking(false); setError(recording ? '本次未完成录音已取消。' : '已取消等待，已完成的录音仍保留，可重新识别。'); }}>{asr?.status === 'recording' || asr?.status === 'paused' ? '取消本次未完成录音' : '取消等待'}</button>}<p className="retell-local-note">每篇仅保存最近一次完成的复述与录音。<br />转写可能有误，完成后可回听核对。</p></div><div className="retell-bottom"><button className="btn primary" disabled={working || !['recording','paused'].includes(asr?.status ?? '')} onClick={() => void finish()}>结束，查看对照<ArrowRight /></button></div></>}
      {stage === 'compare' && currentAttempt && <><div className="retell-scroll retell-comparison"><div className="retell-comparison-head"><h1>对照复述</h1><span>参考表达，不是唯一答案</span></div><div className="seg retell-reference-tabs">{(['简洁口语','完整表达'] as const).map((label,index) => <button className={reference === index ? 'on' : ''} onClick={() => setReference(index as 0 | 1)} key={label}>{label}</button>)}</div><div className="retell-reference" lang="en">{lesson.references[reference]}</div><h2>原文要点 · 对照自查</h2><ol className="retell-keypoints">{lesson.points.map((point,index) => <li key={point}><span>{index + 1}</span>{point}</li>)}</ol><details className="retell-own"><summary>查看我的识别文字<ChevronRight size={16} /></summary><p lang="en">{currentAttempt.transcript}</p><small>识别结果不等于发音或语法评分，请结合录音核对。</small>{audioUrl && <audio controls src={audioUrl} aria-label="回听我的复述录音" preload="metadata" />}</details><details className="retell-pitfalls"><summary>本篇容易说错的地方</summary><ul>{lesson.pitfalls.map(point => <li key={point}>{point}</li>)}</ul></details><details className="retell-pitfalls"><summary>可以借用的短语</summary>{lesson.phrases.map(phrase => <p key={phrase.text}><b lang="en">{phrase.text}</b><br />{phrase.meaning}</p>)}</details><div className="retell-record-tools"><span>{saved ? '已保存在本机' : '尚未保存到本机'} · {timer(currentAttempt.durationMs)}</span><button onClick={exportText}><Download size={13} />导出文字</button>{audioUrl && <a href={audioUrl} download={lesson.id + '-retell.' + (currentAttempt.audioBlob.type.includes('mp4') ? 'm4a' : 'webm')}>下载录音</a>}</div></div><div className="retell-bottom"><button className="btn primary" onClick={() => { setError(''); setStage('speak'); }}><RotateCcw size={19} />再说一遍</button></div></>}
    </>}
    {stage === 'list' && error && <div className="notice error" role="alert">{error}<button onClick={() => setError('')} aria-label="关闭提示"><X size={13} /></button></div>}
    {exportedText && <Modal title="复述文字备份" close={() => setExportedText('')}><p className="help-text">包含每篇最近一次的识别文字与时间，不含录音。可以复制保存；录音在对照页单独下载。单词进度仍使用设置里的完整备份。</p><textarea className="backup-text" aria-label="复述文字 JSON" ref={exportField} value={exportedText} readOnly spellCheck={false} /><div className="dialog-actions"><button className="btn primary" onClick={() => { exportField.current?.focus(); exportField.current?.select(); if (navigator.clipboard?.writeText) void navigator.clipboard.writeText(exportedText).then(() => setExportMessage('已复制复述文字')).catch(() => setExportMessage('文本已全选，请使用系统复制')); else setExportMessage('文本已全选，请使用系统复制'); }}>复制完整文本</button><button className="btn plain" onClick={() => { const url = URL.createObjectURL(new Blob([exportedText], { type: 'application/json;charset=utf-8' })); const link = document.createElement('a'); link.href = url; link.download = 'word-retell-text.json'; link.click(); setTimeout(() => URL.revokeObjectURL(url), 5000); setExportMessage('已请求下载，请确认浏览器已保存；也可以复制完整文本。'); }}>下载 JSON 文件</button></div>{exportMessage && <p className="help-text" role="status">{exportMessage}</p>}</Modal>}
  </section>;
}
