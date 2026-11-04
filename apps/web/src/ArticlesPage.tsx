import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { ArrowLeft, ArrowRight, BookOpen, Check, ChevronLeft, ChevronRight, Download, FileText, Info, LockKeyhole, Plus, Trash2, Upload, Volume2, X } from 'lucide-react';
import type { AppState, Word } from '../../../packages/core/src/types';
import type { ArticleAnalysis, ArticleCandidate, ArticleToken, ArticleTokenStatus } from '../../../packages/core/src/articles';
import { tokenizeArticle } from '../../../packages/core/src/articles';
import { addArticle, addArticleVocabulary, answerArticleVocabulary, articleParagraphs, articleVocabularyId, createArticleLibrary, deleteArticle, MAX_ARTICLE_CHARACTERS, removeArticleVocabulary, updateArticleOverride, updateArticlePosition, type ArticleLibrary, type ArticleOverride, type ArticleVocabularyItem } from '../../../packages/core/src/article-library';
import { loadArticleDictionary, mergeArticleDictionary, type ArticleDictionary } from './lib/article-dictionary';
import type { WordDatabase } from './lib/storage';
import type { SpeechState } from './lib/speech';
import { analyzeInWorker } from './articles/analyze';
import { exportArticleBackup, openArticleDatabase, parseArticleBackup, prepareArticle, readArticleBackupFile, readTxtFile, type ArticleDatabase } from './articles/storage';
import { Meanings } from './components';
import { Modal } from './Modal';
import './articles/articles.css';

interface Props { state: AppState; words: Word[]; database: WordDatabase; baseUrl: string; onSpeak: (word: Word) => void; onStop: () => void; audio: SpeechState; onBusyChange: (busy: boolean) => void; backupOnly?: boolean }
type View = 'library' | 'report' | 'reader' | 'review';
type Selection = { token: ArticleToken; word?: Word; fromVocabulary?: boolean };
const statusNames: Record<ArticleTokenStatus, string> = { familiar: '有熟悉记录', review: '需要复核', unconfirmed: '待确认', unmatched: '词典未匹配', unknown: '明确生词', ignored: '已忽略' };
const errorText = (error: unknown) => error instanceof Error && !/\[\s*\{|Zod|Invalid|validation|checksum/i.test(error.message) ? error.message : '数据校验未通过，原有文章和进度没有被覆盖。请检查文件或重新下载阅读资料。';
const nowFor = (library: ArticleLibrary) => Math.max(Date.now(), library.updatedAt);
const briefMeaning = (word?: Word) => word?.translation.split('\n').filter(Boolean).slice(0, 2).join('；') ?? '尚未找到可靠词条';

function saveJson(text: string) {
  const href = URL.createObjectURL(new Blob([text], { type: 'application/json;charset=utf-8' }));
  const link = document.createElement('a'); link.href = href; link.download = `word-articles-${new Date().toISOString().slice(0, 10)}.json`; link.click();
  setTimeout(() => URL.revokeObjectURL(href), 5000);
}

export default function ArticlesPage({ state, words, database, baseUrl, onSpeak, onStop, audio, onBusyChange, backupOnly = false }: Props) {
  const [library, setLibrary] = useState<ArticleLibrary | null>(null);
  const [view, setView] = useState<View>('library');
  const [tab, setTab] = useState<'materials' | 'vocabulary'>('materials');
  const [activeId, setActiveId] = useState('');
  const [title, setTitle] = useState('');
  const [text, setText] = useState('');
  const [sourceUrl, setSourceUrl] = useState('');
  const [format, setFormat] = useState<'paste' | 'txt'>('paste');
  const [fileName, setFileName] = useState('');
  const [busy, setBusy] = useState(false);
  const [loading, setLoading] = useState(false);
  const [analysis, setAnalysis] = useState<ArticleAnalysis | null>(null);
  const [pack, setPack] = useState<ArticleDictionary | null>(null);
  const [analysisWords, setAnalysisWords] = useState<Word[] | null>(null);
  const [error, setError] = useState('');
  const [toast, setToast] = useState('');
  const [selection, setSelection] = useState<Selection | null>(null);
  const [hints, setHints] = useState(true);
  const [fontSize, setFontSize] = useState(18);
  const [showCandidates, setShowCandidates] = useState(false);
  const [candidateLimit, setCandidateLimit] = useState(40);
  const [bookId, setBookId] = useState('');
  const [onlyPending, setOnlyPending] = useState(true);
  const [bookLimit, setBookLimit] = useState(40);
  const [confirmDelete, setConfirmDelete] = useState<string | null>(null);
  const [restorePreview, setRestorePreview] = useState<ArticleLibrary | null>(null);
  const [backupText, setBackupText] = useState<string | null | undefined>();
  const [backupInput, setBackupInput] = useState('');
  const [review, setReview] = useState<{ queue: string[]; initial: number; revealed: boolean } | null>(null);
  const dbRef = useRef<ArticleDatabase | null>(null);
  const libraryRef = useRef<ArticleLibrary | null>(null);
  const lock = useRef(false);
  const live = useRef(true);
  const analysisAbort = useRef<AbortController | null>(null);
  const txtInput = useRef<HTMLInputElement>(null);
  const backupFile = useRef<HTMLInputElement>(null);
  const nextAnswerAt = useRef(0);
  const operationEpoch = useRef(0);
  const backupEpoch = useRef(0);
  const active = library?.articles.find(item => item.id === activeId);
  const articleText = active?.text;
  const overridesJson = JSON.stringify(active?.overrides ?? {});
  const selectedClose = useCallback(() => { setSelection(null); onStop(); }, [onStop]);
  const backupClose = useCallback(() => { backupEpoch.current++; setBackupText(undefined); }, []);
  const restoreClose = useCallback(() => setRestorePreview(null), []);
  const deleteClose = useCallback(() => setConfirmDelete(null), []);
  const candidatesClose = useCallback(() => setShowCandidates(false), []);

  const accept = useCallback((next: ArticleLibrary) => {
    if (libraryRef.current && next.revision < libraryRef.current.revision) return;
    libraryRef.current = next; if (live.current) setLibrary(next);
  }, []);
  const initialize = useCallback(async () => {
    if (lock.current) return;
    lock.current = true; setBusy(true); setError('');
    try {
      const db = dbRef.current ?? await openArticleDatabase();
      if (!live.current) { db.close(); return; }
      dbRef.current = db;
      let saved = await db.readLibrary();
      if (!saved) saved = await db.saveLibrary(createArticleLibrary(Date.now()), null);
      accept(saved);
    } catch (reason) { if (live.current) setError(errorText(reason)); }
    finally { lock.current = false; if (live.current) setBusy(false); }
  }, [accept]);

  useEffect(() => {
    live.current = true; void initialize();
    return () => { live.current = false; analysisAbort.current?.abort(); dbRef.current?.close(); dbRef.current = null; };
  }, [initialize]);
  useEffect(() => { onBusyChange(busy || loading); return () => onBusyChange(false); }, [busy, loading, onBusyChange]);
  useEffect(() => { if (!toast) return; const timer = setTimeout(() => setToast(''), 4500); return () => clearTimeout(timer); }, [toast]);
  useEffect(() => {
    const refresh = () => { if (!lock.current && dbRef.current) void dbRef.current.readLibrary().then(saved => { if (saved && live.current && !lock.current) {
      const external = saved.revision > (libraryRef.current?.revision ?? -1);
      accept(saved);
      if (external) { setReview(null); setView('library'); setSelection(null); setToast('文章库已在其他页面更新，请重新打开材料或开始复习。'); }
    } }).catch(reason => { if (live.current) setError(errorText(reason)); }); };
    window.addEventListener('focus', refresh); return () => window.removeEventListener('focus', refresh);
  }, [accept]);

  const mutate = useCallback(async (change: (current: ArticleLibrary) => ArticleLibrary): Promise<ArticleLibrary | null> => {
    if (lock.current || !libraryRef.current || !dbRef.current) return null;
    lock.current = true; setBusy(true); setError('');
    try {
      const current = libraryRef.current; const next = change(current);
      if (next === current) return current;
      const saved = await dbRef.current.saveLibrary(next, current.revision); accept(saved); return saved;
    } catch (reason) { if (live.current) setError(errorText(reason)); return null; }
    finally { lock.current = false; if (live.current) setBusy(false); }
  }, [accept]);

  // Loading is intentional and happens only after the user opens/analyzes a material.
  const openArticle = async (id: string, target: 'report' | 'reader' = 'report') => {
    if (lock.current) return;
    const article = libraryRef.current?.articles.find(item => item.id === id); if (!article) return;
    analysisAbort.current?.abort(); setAnalysis(null); setAnalysisWords(null); setActiveId(id); setView(target); setLoading(true); setError('');
    const controller = new AbortController(); analysisAbort.current = controller;
    try {
      const nextPack = pack ?? await loadArticleDictionary(database, { baseUrl, dictionaryVersion: state.dictionaryVersion, signal: controller.signal });
      const forms = tokenizeArticle(article.text).tokens.map(token => token.text).filter(form => form.length <= 500);
      const merged = await mergeArticleDictionary(database, state.dictionaryVersion, forms, nextPack, words);
      if (!controller.signal.aborted && live.current) { setPack(nextPack); setAnalysisWords(merged); }
    } catch (reason) { if (!controller.signal.aborted && live.current) { setError(errorText(reason)); setLoading(false); } }
  };

  useEffect(() => {
    if (!articleText || !pack || !analysisWords || (view !== 'report' && view !== 'reader')) return;
    const controller = new AbortController(); analysisAbort.current?.abort(); analysisAbort.current = controller;
    const overrides = JSON.parse(overridesJson) as Record<string, ArticleOverride>;
    void analyzeInWorker(articleText, { words: analysisWords, lemmas: pack.lemmas, progress: state.modes.look.progress, skipped: state.skipped, overrides }, controller.signal)
      .then(result => { if (live.current && !controller.signal.aborted) { setAnalysis(result); setLoading(false); } })
      .catch(reason => { if (live.current && !controller.signal.aborted) { setLoading(false); setError(errorText(reason)); } });
    return () => controller.abort();
  }, [articleText, overridesJson, analysisWords, pack, state.modes.look.progress, state.skipped, view]);

  const importArticle = async () => {
    if (lock.current || !libraryRef.current) return;
    setError(''); setBusy(true); lock.current = true;
    let prepared;
    try { prepared = await prepareArticle({ title, text, sourceUrl, sourceFormat: format }, nowFor(libraryRef.current)); }
    catch (reason) { setError(errorText(reason)); }
    finally { lock.current = false; setBusy(false); }
    if (!prepared) return;
    const duplicate = libraryRef.current.articles.some(item => item.id === prepared.id);
    const saved = await mutate(current => addArticle(current, prepared, nowFor(current)));
    if (saved) { setTitle(''); setText(''); setFileName(''); setSourceUrl(''); if (duplicate) setToast('这篇文章已在材料库中，已打开原记录。'); void openArticle(prepared.id); }
  };
  const chooseTxt = async (file?: File) => {
    if (!file || lock.current) return;
    setBusy(true); lock.current = true; setError('');
    try { const contents = await readTxtFile(file); setText(contents); setFileName(file.name); setTitle(file.name.replace(/\.txt$/i, '').slice(0, 160)); setFormat('txt'); setToast('正文已在本机解析，请检查后点击导入并分析。'); }
    catch (reason) { setError(errorText(reason)); }
    finally { lock.current = false; setBusy(false); if (txtInput.current) txtInput.current.value = ''; }
  };
  const toLibrary = () => { operationEpoch.current++; analysisAbort.current?.abort(); setLoading(false); setView('library'); setSelection(null); onStop(); };
  const openSelection = (token: ArticleToken) => { onStop(); setSelection({ token, word: token.ambiguous ? undefined : token.word }); };
  const openCandidate = (candidate: ArticleCandidate) => { const token = analysis?.tokens.find(item => item.start === candidate.firstOffset); if (token) { setShowCandidates(false); openSelection(token); } };
  const mark = async (value: ArticleOverride | null) => {
    if (!selection || !active || selection.fromVocabulary) return;
    const saved = await mutate(current => updateArticleOverride(current, active.id, selection.token.key, value, nowFor(current)));
    if (saved) { setSelection(null); setToast(value === 'known' ? '已在本篇确认认识，可随时撤销。' : value === 'unknown' ? '已标记为本篇生词，未改写词书错词次数。' : value === 'ignored' ? '已忽略此词，可从标记列表恢复。' : '已撤销本篇标记，重新参考学习记录。'); }
  };
  const addSelected = async () => {
    if (!active || !selection?.word || !analysis) return;
    const paragraph = analysis.paragraphs[selection.token.paragraphIndex]; if (!paragraph) return;
    const occurrences = analysis.tokens.filter(token => token.key === selection.token.key).length;
    const saved = await mutate(current => addArticleVocabulary(current, { articleId: active.id, tokenKey: selection.token.key, word: selection.word!, sentence: paragraph.text.trim(), paragraphIndex: paragraph.index, occurrences }, nowFor(current)));
    if (saved) { setSelection(null); setToast('已加入文章生词本，词书今日目标保持原计数。'); }
  };
  const moveParagraph = async (position: number) => {
    if (!active) return false;
    const saved = await mutate(current => updateArticlePosition(current, active.id, position, nowFor(current)));
    if (!saved) return false;
    document.querySelector('.article-reader')?.scrollTo({ top: 0 });
    return true;
  };
  const openParagraph = async (position: number) => {
    const epoch = operationEpoch.current;
    if (await moveParagraph(position) && epoch === operationEpoch.current && live.current) setView('reader');
  };
  const validatePastedBackup = async () => {
    if (lock.current || !backupInput.trim()) return;
    const epoch = ++backupEpoch.current;
    lock.current = true; setBusy(true);
    try {
      const parsed = await parseArticleBackup(backupInput);
      if (live.current && epoch === backupEpoch.current) { setBackupText(undefined); setRestorePreview(parsed); }
    } catch { if (live.current && epoch === backupEpoch.current) setError('文章备份无效，现有数据未被覆盖。'); }
    finally { lock.current = false; if (live.current) setBusy(false); }
  };
  const refreshReadingData = async () => {
    if (loading || lock.current) return;
    const controller = new AbortController(); analysisAbort.current?.abort(); analysisAbort.current = controller;
    setLoading(true); setError('');
    try {
      const next = await loadArticleDictionary(database, { baseUrl, dictionaryVersion: state.dictionaryVersion, refresh: true, signal: controller.signal });
      const article = libraryRef.current?.articles.find(item => item.id === activeId);
      if (article) {
        const forms = tokenizeArticle(article.text).tokens.map(token => token.text).filter(form => form.length <= 500);
        const merged = await mergeArticleDictionary(database, state.dictionaryVersion, forms, next, words);
        if (live.current && !controller.signal.aborted) { setPack(next); setAnalysisWords(merged); }
      } else if (live.current && !controller.signal.aborted) setLoading(false);
    } catch (reason) { if (live.current && !controller.signal.aborted) { setError(errorText(reason)); setLoading(false); } }
  };

  const inspectBackup = async (file?: File) => {
    if (!file || lock.current) return;
    setBusy(true); lock.current = true; setError('');
    try { setRestorePreview(await readArticleBackupFile(file)); }
    catch { setError('文章备份无效或过大，现有文章没有被覆盖。请使用本功能导出的 JSON 备份。'); }
    finally { setBusy(false); lock.current = false; if (backupFile.current) backupFile.current.value = ''; }
  };
  const restore = async () => {
    if (!restorePreview || !dbRef.current || !libraryRef.current || lock.current) return;
    lock.current = true; setBusy(true);
    try { const saved = await dbRef.current.replaceFromBackup(restorePreview, libraryRef.current.revision, nowFor(libraryRef.current)); accept(saved); setRestorePreview(null); setActiveId(''); setBookId(''); setReview(null); setView('library'); setToast('文章库已恢复；原词书与复述数据未改动。'); }
    catch (reason) { setError(errorText(reason)); }
    finally { lock.current = false; setBusy(false); }
  };

  const validBookId = library?.articles.some(article => article.id === bookId) ? bookId : '';
  const vocabulary = useMemo(() => (library?.vocabulary ?? []).filter(item => !validBookId || item.articleId === validBookId), [library?.vocabulary, validBookId]);
  const pending = vocabulary.filter(item => item.progress.streak < 2);
  const visibleVocabulary = (onlyPending ? pending : vocabulary).slice(0, bookLimit);
  const reviewItem = library?.vocabulary.find(item => item.id === review?.queue[0]);
  const reviewWord = reviewItem?.word;
  useEffect(() => {
    if (view === 'review' && reviewWord && !review?.revealed && state.settings.autoSpeak) onSpeak(reviewWord);
    return onStop;
  }, [view, reviewWord, review?.revealed, state.settings.autoSpeak, onSpeak, onStop]);
  const startReview = () => { const ids = pending.slice(0, 20).map(item => item.id); if (!ids.length) return; setReview({ queue: ids, initial: ids.length, revealed: false }); setView('review'); onStop(); };
  const answerReview = async (answer: 'known' | 'unknown') => {
    if (!reviewItem || !review || review.revealed || Date.now() < nextAnswerAt.current) return;
    nextAnswerAt.current = Date.now() + 350;
    const saved = await mutate(current => answerArticleVocabulary(current, reviewItem.id, answer, nowFor(current)));
    if (!saved) return;
    onStop();
    if (answer === 'unknown') setReview({ ...review, revealed: true });
    else { const completed = saved.vocabulary.find(item => item.id === reviewItem.id)?.progress.streak === 2; const rest = review.queue.slice(1); setReview({ ...review, queue: completed ? rest : [...rest, reviewItem.id], revealed: false }); }
  };
  const reviewVocabulary = (item: ArticleVocabularyItem) => {
    const article = library?.articles.find(entry => entry.id === item.articleId); if (!article) return;
    setActiveId(article.id); setAnalysis(null); setAnalysisWords(null);
    const index = Math.max(0, article.text.indexOf(item.sentence));
    setSelection({ token: { start: index, end: index + item.word.word.length, text: item.word.word, key: item.word.id, paragraphIndex: item.paragraphIndex, word: item.word, candidates: [item.word], status: 'unconfirmed', ambiguous: false }, word: item.word, fromVocabulary: true });
  };

  const overview = analysis?.stats;
  const assessedRatio = overview ? overview.assessedTokens / Math.max(1, overview.totalTokens - overview.ignored) : 0;
  const coverage = overview?.familiarCoverage ?? 0;
  const recommendation = assessedRatio < .5 ? '先确认词汇，再判断难度' : coverage >= .98 ? '适合直接阅读' : coverage >= .9 ? '建议辅助阅读' : '建议分段精读';
  const backupControls = <div aria-label="文章库备份操作"><p className="sd">包含正文、文章生词、复习记录和阅读位置，不包含词书与复述数据。</p>{!library && !error && <p className="sd" role="status">正在读取本机文章库…</p>}<div className="dialog-actions"><button className="row-action" disabled={!library || busy} onClick={() => { if (library) { saveJson(exportArticleBackup(library)); setToast('已请求下载文章备份，请确认系统已保存。'); } }}><Download size={18} />导出文章备份</button><button className="row-action" disabled={!library || busy} onClick={() => backupFile.current?.click()}><Upload size={18} />恢复文章备份</button><button className="row-action" disabled={!library || busy} onClick={() => { if (library) setBackupText(exportArticleBackup(library)); }}>复制备份文本</button><button className="row-action" disabled={!library || busy} onClick={() => { setBackupInput(''); setBackupText(null); }}>粘贴备份恢复</button></div></div>;

  let content: ReactNode;
  if (backupOnly) content = backupControls;
  else if (view === 'library') content = <div className="page article-library">
    <div className="page-head article-page-head"><div><div className="d">{tab === 'materials' ? '把真实材料，变成自己的阅读课' : '从原文里积累，带着语境复习'}</div><h1>{tab === 'materials' ? '阅读材料' : '文章生词本'}</h1></div></div>
    <div className="article-tabs"><button className={tab === 'materials' ? 'on' : ''} onClick={() => setTab('materials')}>我的材料</button><button className={tab === 'vocabulary' ? 'on' : ''} onClick={() => setTab('vocabulary')}>文章生词</button></div>
    {tab === 'materials' ? <><section className="panel article-import"><fieldset disabled={busy}><h2>导入一篇英文文章</h2><div className="seg"><button className={format === 'paste' ? 'on' : ''} onClick={() => setFormat('paste')}>粘贴文本</button><button className={format === 'txt' ? 'on' : ''} disabled={busy} onClick={() => { setFormat('txt'); txtInput.current?.click(); }}>选择 TXT</button></div>
      <input className="article-field article-title-input" aria-label="文章标题" maxLength={160} value={title} onChange={event => setTitle(event.target.value)} placeholder="文章标题（可选）" />
      <div className="article-text-field"><textarea aria-label="英文文章正文" placeholder="粘贴英文正文，空行用于分段…" value={text} maxLength={MAX_ARTICLE_CHARACTERS} onChange={event => { setText(event.target.value); setFormat('paste'); setFileName(''); }} spellCheck={false} />{text && <button className="icon-btn" aria-label="清空文章正文" onClick={() => { setText(''); setFileName(''); }}><X /></button>}</div>
      {fileName && <p className="article-caption">已读取 {fileName} · 请检查正文后导入</p>}
      <details className="article-source"><summary>添加来源链接（可选）</summary><input className="article-field" aria-label="文章来源链接" type="url" placeholder="https://…（仅保存来源，不抓取网页）" maxLength={2000} value={sourceUrl} onChange={event => setSourceUrl(event.target.value)} /></details>
      <p className="article-caption article-lock"><LockKeyhole size={15} />只在本机处理，不上传正文</p><button className="btn primary article-primary" disabled={busy || !library || !text.trim()} onClick={() => void importArticle()}>导入并分析<ArrowRight /></button><p className="article-footnote">首次分析下载约 8.8 MB 阅读资料，之后可离线使用。<br />支持 UTF-8 TXT（2 MB 内），每篇最多 2 万英文词。</p></fieldset></section>
      <div className="sec-head"><h2>最近阅读</h2><span>{library?.articles.length ?? 0} / 50 篇</span></div>{library?.articles.length ? [...library.articles].reverse().map(article => <section className="panel article-material" key={article.id}><div className="article-material-main"><span className="article-book-icon"><BookOpen /></span><div><h3>{article.title}</h3><p>读到第 {article.readParagraph + 1} / {articleParagraphs(article.text).length} 段</p><progress value={article.readParagraph + 1} max={articleParagraphs(article.text).length} aria-label="阅读段落位置" /></div><button className="icon-btn" aria-label={`删除文章 ${article.title}`} disabled={busy} onClick={() => setConfirmDelete(article.id)}><Trash2 size={16} /></button></div><div className="article-material-actions"><button onClick={() => void openArticle(article.id, 'reader')}>继续阅读<ArrowRight size={16} /></button><button onClick={() => void openArticle(article.id)}>分析报告</button></div></section>) : <div className="article-empty"><BookOpen size={28} /><p>{library ? '还没有材料。粘贴一篇你想读的英文，从这里开始。' : '正在打开本机文章库…'}</p></div>}</> : <>
      <label className="article-book-select"><FileText size={22} /><select aria-label="按文章来源筛选生词" value={validBookId} onChange={event => { setBookId(event.target.value); setBookLimit(40); }}><option value="">全部文章</option>{library?.articles.map(article => <option value={article.id} key={article.id}>{article.title}</option>)}</select></label><div className="article-book-summary"><strong>已收集 {vocabulary.length} 词</strong><div className="mini-seg"><button className={onlyPending ? 'on' : ''} onClick={() => setOnlyPending(true)}>待复习 {pending.length}</button><button className={!onlyPending ? 'on' : ''} onClick={() => setOnlyPending(false)}>全部</button></div></div><p className="article-caption article-lock"><Info size={15} />不计入当前词书今日目标</p>
      <div className="panel article-vocabulary">{visibleVocabulary.length ? visibleVocabulary.map(item => <div className="article-vocab-row" key={item.id}><button className="article-vocab-main" onClick={() => reviewVocabulary(item)}><strong>{item.word.word}</strong><span>{briefMeaning(item.word)}</span><small>本篇出现 {item.occurrences} 次 · 第 {item.paragraphIndex + 1} 段{item.progress.wrongCount ? ` · 文章复习不认识 ${item.progress.wrongCount} 次` : ''}</small>{!validBookId && <small className="article-vocab-source">{library?.articles.find(article => article.id === item.articleId)?.title}</small>}</button><button className="icon-btn" aria-label={`朗读 ${item.word.word}`} onClick={() => onSpeak(item.word)}><Volume2 size={19} /></button><button className="icon-btn" aria-label={`查看 ${item.word.word}`} onClick={() => reviewVocabulary(item)}><ChevronRight size={18} /></button></div>) : <p className="empty">{onlyPending && vocabulary.length ? '本轮生词都已连续认识两次，可以回到原文再读。' : '阅读时点击单词，加入自己的文章生词本。'}</p>}</div>
      {(onlyPending ? pending : vocabulary).length > bookLimit && <button className="btn plain" onClick={() => setBookLimit(value => value + 40)}>显示更多</button>}</>}
  </div>;
  else if (view === 'review') content = <div className="page article-review"><div className="topbar"><button className="icon-btn" aria-label="返回文章生词本" onClick={() => { toLibrary(); setTab('vocabulary'); }}><ChevronLeft /></button><div className="tb-title"><h1 className="t1">文章生词复习</h1><div className="t2">独立保存 · 不计入词书目标</div></div><span className="article-caption">{review?.initial ?? 0} 词</span></div>{reviewItem ? <><div className="panel article-review-card"><span className="chip acc">待完成 {review?.queue.length} 词 · 连续认识 {reviewItem.progress.streak}/2</span><div className="article-review-word"><h2>{reviewItem.word.word}</h2><button className="spk" aria-label="朗读当前文章生词" onClick={() => onSpeak(reviewItem.word)}><Volume2 /></button></div>{review?.revealed ? <><Meanings word={reviewItem.word} /><blockquote>{reviewItem.sentence}</blockquote></> : <p className="article-review-mask">回想这个词的意思</p>}</div><div className="article-review-actions">{review?.revealed ? <button className="btn primary" disabled={busy} onClick={() => { if (review) setReview({ ...review, queue: [...review.queue.slice(1), reviewItem.id], revealed: false }); }}>继续，稍后再认<ArrowRight /></button> : <><button className="btn bad" disabled={busy} onClick={() => void answerReview('unknown')}>不认识</button><button className="btn good" disabled={busy} onClick={() => void answerReview('known')}>认识<Check /></button></>}</div></> : <div className="article-empty"><Check size={40} /><h2>这一轮已完成</h2><p>本轮词汇已连续认识两次，回到原文看看它们。</p><button className="btn primary" onClick={() => { toLibrary(); setTab('vocabulary'); }}>返回文章生词本<ArrowRight /></button></div>}</div>;
  else content = <div className={`page article-detail ${view === 'reader' ? 'article-reader' : ''}`}><div className="topbar"><button className="icon-btn" aria-label="返回阅读材料" onClick={toLibrary}><ChevronLeft /></button><h1 className="t1">{view === 'reader' ? '原文阅读' : '材料分析'}</h1>{view === 'reader' ? <button className="article-font-button" aria-label="调整阅读字号" onClick={() => setFontSize(size => size >= 22 ? 16 : size + 2)}>Aa</button> : <button className="icon-btn" aria-label="打开文章生词本" onClick={() => { toLibrary(); setTab('vocabulary'); setBookId(activeId); }}><BookOpen /></button>}</div>
    <h2 className="article-english-title">{active?.title}</h2><p className="article-caption">{view === 'reader' ? `第 ${(active?.readParagraph ?? 0) + 1} / ${active ? articleParagraphs(active.text).length : 0} 段` : overview ? `${overview.totalTokens} 词 · ${overview.uniqueWords} 个不同词形/原形` : '正文已保存在本机'}</p>
    {loading && <div className="article-loading" role="status"><span className="article-spinner" />正在本机分析…<button onClick={() => { analysisAbort.current?.abort(); setLoading(false); }}>取消</button></div>}
    {view === 'report' && analysis && <><section className="panel article-report"><span className="chip review">{recommendation}</span><h3>{assessedRatio < .5 ? '先确认反复出现的词，再读原文' : '带着重点词，回到原文阅读'}</h3><div className="article-distribution" aria-label="词汇记录分布">{(['familiar', 'review', 'unknown', 'unconfirmed', 'unmatched', 'ignored'] as const).map(key => overview![key] > 0 && <span className={`article-distribution-${key}`} key={key} style={{ flex: overview![key] }} title={`${statusNames[key]} ${overview![key]} 次`}>{overview![key] / overview!.totalTokens >= .08 ? `${Math.round(overview![key] / overview!.totalTokens * 100)}%` : ''}</span>)}</div><div className="article-stat-grid">{(['familiar', 'review', 'unconfirmed'] as const).map(key => <div key={key}><strong>{overview![key]}</strong><span>{statusNames[key]}</span></div>)}</div><div className="article-extra-stats">明确生词 {overview!.unknown} · 词典未匹配 {overview!.unmatched} · 已忽略 {overview!.ignored}</div><details className="article-stat-note"><summary>按出现次数统计 · 查看口径</summary><p>参考看词记录和本篇确认，不代表理解率；未学过、已斩或过滤的词不自动视为认识。</p></details></section><div className="sec-head"><h3>优先确认</h3><button onClick={() => { setCandidateLimit(40); setShowCandidates(true); }}>查看全部<ChevronRight size={14} /></button></div><div className="panel article-candidates">{analysis.candidates.length ? [...analysis.candidates].sort((a, b) => Number(a.word?.basic ?? false) - Number(b.word?.basic ?? false)).slice(0, 3).map(candidate => <button className="article-candidate" key={candidate.key} onClick={() => openCandidate(candidate)}><span><strong>{candidate.word?.word ?? candidate.text}</strong><small>{briefMeaning(candidate.word)}</small></span><span><small>出现 {candidate.count} 次</small><small>{statusNames[candidate.status]}</small></span></button>) : <p className="empty">暂时没有待确认词。可以阅读原文，按语境补充自己的标记。</p>}</div><h3 className="article-section-title">阅读提示</h3><div className="panel article-reading-hints">{[...analysis.paragraphs].filter(paragraph => paragraph.burdenCount || paragraph.longSentenceCount).sort((a, b) => b.burdenCount - a.burdenCount).slice(0, 2).map(paragraph => <button key={paragraph.index} onClick={() => { void openParagraph(paragraph.index); }}>第 {paragraph.index + 1} 段 · {paragraph.burdenCount} 处需查阅或确认{paragraph.longSentenceCount ? ' · 有较长句子' : ''}<ChevronRight size={14} /></button>)}<p className="article-footnote">长句仅按长度提示；熟词僻义、短语和句意仍需结合原文判断。</p></div></>}
    {view === 'report' && !analysis && !loading && <div className="article-empty"><p>分析尚未完成，正文已保留。首次使用需要联网下载阅读资料。</p><button className="btn primary" onClick={() => void openArticle(activeId)}>重试分析</button><button className="btn plain" onClick={() => setView('reader')}>仅阅读原文</button></div>}
    {view === 'reader' && active && <><div className="article-reader-controls"><label><span>显示词汇提示</span><button className="toggle" role="switch" aria-label="显示词汇提示" aria-checked={hints} onClick={() => setHints(value => !value)} /></label><span>橙线：需复核 · 虚线：待确认</span></div>{!analysis && !loading && <button className="article-link" onClick={() => void openArticle(active.id, 'reader')}>尚未分析 · 点击加载词汇提示</button>}<div className="article-original" style={{ fontSize }}>
      {(() => { const paragraph = analysis?.paragraphs[active.readParagraph]; if (!paragraph) return <p>{articleParagraphs(active.text)[active.readParagraph]}</p>; const tokens = analysis.tokens.filter(token => token.paragraphIndex === paragraph.index); const parts: ReactNode[] = []; let offset = paragraph.start; for (const token of tokens) { parts.push(active.text.slice(offset, token.start)); parts.push(<button key={token.start} className={`article-token ${hints ? `article-token-${token.status}` : ''}`} aria-label={`查询 ${token.text}`} onClick={() => openSelection(token)}>{token.text}</button>); offset = token.end; } parts.push(active.text.slice(offset, paragraph.end)); return <p>{parts}</p>; })()}
      </div><div className="article-paragraph-nav"><button disabled={busy || !active.readParagraph} onClick={() => void moveParagraph(active.readParagraph - 1)}><ArrowLeft size={16} />上一段</button><select aria-label="阅读段落" disabled={busy} value={active.readParagraph} onChange={event => void moveParagraph(Number(event.target.value))}>{articleParagraphs(active.text).map((_, index) => <option value={index} key={index}>第 {index + 1} 段</option>)}</select><button disabled={busy || active.readParagraph >= articleParagraphs(active.text).length - 1} onClick={() => void moveParagraph(active.readParagraph + 1)}>下一段<ArrowRight size={16} /></button></div><p className="article-footnote">按段阅读，切换后自动保存位置。点击单词查义，不计为答错。</p><div className="article-reader-bottom"><button onClick={() => setView('report')}>查看分析</button><button onClick={() => { toLibrary(); setTab('vocabulary'); setBookId(active.id); }}>文章生词本<ChevronRight size={14} /></button>{active.sourceUrl && <a href={active.sourceUrl} target="_blank" rel="noopener noreferrer">查看原始来源</a>}</div></>}
  </div>;

  return <><div className="article-notices">{error && <div className="notice error" role="alert">{error}<button disabled={busy} onClick={() => void initialize()}>重新载入文章库</button>{!backupOnly && view !== 'library' && <button disabled={busy} onClick={() => void refreshReadingData()}>重下载阅读资料</button>}</div>}{toast && <div className="article-toast" role="status">{toast}</div>}</div>{content}{!backupOnly && view === 'report' && analysis && <div className="article-anchored-actions"><button className="btn primary article-primary" onClick={() => setView('reader')}>开始阅读<ArrowRight /></button><button className="article-link" onClick={() => { setCandidateLimit(40); setShowCandidates(true); }}>先快速确认待确认词</button></div>}{!backupOnly && view === 'library' && tab === 'vocabulary' && <div className="article-anchored-actions"><button className="btn primary article-primary" disabled={!pending.length || busy} onClick={startReview}>开始复习 · {Math.min(20, pending.length)} 词<ArrowRight /></button><p className="article-footnote">不认识立即揭晓，之后连续认识两次完成本轮。</p></div>}
    <input type="file" ref={txtInput} accept=".txt,text/plain" hidden onChange={event => void chooseTxt(event.target.files?.[0])} /><input type="file" ref={backupFile} accept=".json,application/json" hidden onChange={event => void inspectBackup(event.target.files?.[0])} />
    {selection && <Modal title="文章词义" close={selectedClose} sheet><div className="article-word-sheet"><div className="article-sheet-word"><button className="spk" aria-label="朗读所选单词" disabled={!selection.word} onClick={() => { if (selection.word) onSpeak(selection.word); }}><Volume2 /></button><div><h2>{selection.word?.word ?? selection.token.text}</h2>{selection.word?.phonetic && <p>/{selection.word.phonetic}/</p>}</div></div>{selection.token.ambiguous && <><p className="article-caption">这个词有多种可能，请结合原句选择词条。</p><select className="article-field" aria-label="选择可能词条" value={selection.word?.id ?? ''} onChange={event => setSelection({ ...selection, word: selection.token.candidates.find(word => word.id === event.target.value) })}><option value="">请选择词条</option>{selection.token.candidates.map(word => <option key={word.id} value={word.id}>{word.word} · {briefMeaning(word)}</option>)}</select></>}{selection.word ? <Meanings word={selection.word} /> : <p className="article-caption">{selection.token.ambiguous ? '选定后显示词典义项；本文义项需要你结合语境确认。' : '当前词典尚未匹配可靠词条，不编造中文释义。你仍可标记或忽略此词。'}</p>}<details className="article-source-context"><summary>查看原句</summary><blockquote className="article-source-sentence">{active && articleParagraphs(active.text)[selection.token.paragraphIndex]}</blockquote></details><p className="article-caption">{analysis ? `本篇出现 ${analysis.tokens.filter(token => token.key === selection.token.key).length} 次 · ` : ''}第 {selection.token.paragraphIndex + 1} 段</p>{!selection.fromVocabulary && <div className="article-meaning-actions"><button disabled={busy} onClick={() => void mark('known')}>认识</button><button disabled={busy} onClick={() => void mark('unknown')}>此处不懂</button></div>}<button className="btn primary article-primary" disabled={busy || !selection.word || !analysis || !!library?.vocabulary.some(item => item.id === articleVocabularyId(activeId, selection.word?.id ?? ''))} onClick={() => void addSelected()}><Plus />{selection.word && library?.vocabulary.some(item => item.id === articleVocabularyId(activeId, selection.word!.id)) ? '已在文章生词本' : '加入文章生词本'}</button><div className="article-sheet-secondary">{!selection.fromVocabulary && <><button disabled={busy} onClick={() => void mark('ignored')}>专名 / 忽略</button><button disabled={busy || !active || !Object.hasOwn(active.overrides, selection.token.key)} onClick={() => void mark(null)}>撤销本篇标记</button></>}{view === 'library' && selection.word && <button disabled={busy} onClick={() => { void mutate(current => removeArticleVocabulary(current, articleVocabularyId(activeId, selection.word!.id), nowFor(current))).then(saved => { if (saved) setSelection(null); }); }}>移出生词本</button>}</div>{(audio.status === 'error' || audio.status === 'unavailable') && <p className="article-caption" role="status">{audio.error}</p>}<p className="article-footnote">词典提供义项，当前语境请结合原文判断。查词不会计为答错。</p></div></Modal>}
    {showCandidates && analysis && <Modal title="确认本篇词汇" close={candidatesClose}><p className="article-caption">未学过不等于不会。确认仅影响本篇，原词书记录保留。</p><div className="article-confirm-list">{analysis.candidates.slice(0, candidateLimit).map(candidate => <div key={candidate.key}><button className="article-confirm-word" onClick={() => openCandidate(candidate)}><strong>{candidate.word?.word ?? candidate.text}</strong><small>{statusNames[candidate.status]} · 出现 {candidate.count} 次</small></button><button className="chip acc" disabled={busy} onClick={() => void mutate(current => updateArticleOverride(current, activeId, candidate.key, 'known', nowFor(current)))}>认识</button><button className="chip review" disabled={busy} onClick={() => void mutate(current => updateArticleOverride(current, activeId, candidate.key, 'unknown', nowFor(current)))}>不认识</button></div>)}</div>{analysis.candidates.length > candidateLimit && <button className="btn plain" onClick={() => setCandidateLimit(value => value + 40)}>显示更多</button>}<details className="article-overrides"><summary>已作的本篇标记（可撤销）</summary>{Object.entries(active?.overrides ?? {}).map(([key, value]) => <div key={key}><span>{key.replace(/^case:/, '')} · {value === 'known' ? '认识' : value === 'unknown' ? '不认识' : '忽略'}</span><button disabled={busy} onClick={() => void mutate(current => updateArticleOverride(current, activeId, key, null, nowFor(current)))}>撤销</button></div>)}</details></Modal>}
    {confirmDelete && <Modal title="删除这篇文章？" close={deleteClose}><p className="help-text">会一并删除此文章的生词和阅读记录。词书和其他文章不受影响，建议先导出文章备份。</p><div className="dialog-actions"><button className="btn bad" disabled={busy} onClick={() => { void mutate(current => deleteArticle(current, confirmDelete, nowFor(current))).then(saved => { if (saved) setConfirmDelete(null); }); }}>确认删除</button><button className="btn plain" onClick={deleteClose}>保留文章</button></div></Modal>}
    {restorePreview && <Modal title="确认恢复文章库" close={restoreClose}><p className="help-text">备份包含 {restorePreview.articles.length} 篇文章、{restorePreview.vocabulary.length} 条文章生词。恢复将替换当前文章库（{library?.articles.length ?? 0} 篇），不会合并；原词书和复述数据不变。</p><div className="dialog-actions"><button className="btn primary" disabled={busy} onClick={() => void restore()}>确认替换文章库</button><button className="btn plain" onClick={restoreClose}>取消</button></div></Modal>}
    {backupText !== undefined && <Modal title={backupText === null ? '粘贴文章备份' : '文章库备份文本'} close={backupClose}><p className="article-caption">仅包含文章、生词和阅读位置。请完整保留 JSON 文本。</p><textarea className="backup-text" aria-label="文章备份文本" readOnly={backupText !== null} disabled={busy} value={backupText ?? backupInput} maxLength={20 * 1024 * 1024} onChange={event => setBackupInput(event.target.value)} /><div className="dialog-actions">{backupText === null ? <button className="btn primary" disabled={busy || !backupInput.trim()} onClick={() => void validatePastedBackup()}>校验并预览恢复</button> : <><button className="btn primary" onClick={() => { void navigator.clipboard?.writeText(backupText).then(() => setToast('文章备份文本已复制，请保存到自己的文件。')).catch(() => setToast('请长按文本框，全选并复制完整备份。')); }}>复制完整文本</button><button className="btn plain" onClick={() => saveJson(backupText)}>下载 JSON</button></>}</div></Modal>}
  </>;
}
