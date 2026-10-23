import { Suspense, lazy, useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { ArrowRight, Check, Download, HardDrive, Pause, RotateCcw, ShieldCheck, Upload, Volume2 } from 'lucide-react';
import { answer, createInitialState, deferWord, ensureSession, getCurrentToken, getCurrentWord, getLocalDateKey, getYesterdayReviewSummary, getStudyHistoryEntry, getStudyTrail, moveStudyHistoryOffset, nextWord, restartWord, restoreSkipped, skipWord, undo, updateSettings } from '../../../packages/core/src';
import type { AppState, Deck, Mode, Settings, Word } from '../../../packages/core/src';
import { openWordDatabase, exportBackup, readBackupFile, type WordDatabase } from './lib/storage';
import { readCachedStudy, loadStudyDictionary, downloadAll, getDownloadProgress, searchDictionary, type DictionaryManifest, type DownloadProgress } from './lib/dictionary';
import { SpeechController, type SpeechState } from './lib/speech';
import { FeedbackController } from './lib/feedback';
import { HomePage, Meanings, Navigation, SearchBox, StudyPage, WordList, deckNames, modeNames, wordTags, wrongCount } from './components';
import { DailyWords, LearningCalendar } from './LearningCalendar';
import { InstallButton } from './InstallButton';
import { PhraseSection } from './PhraseSection';
import { FittedWord } from './FittedWord';
import { InstallHelp } from './InstallHelp';
import { Modal } from './Modal';

const RetellPage = lazy(() => import('./RetellPage'));
type Page = 'home' | 'study' | 'retell' | 'words' | 'settings';
type Dictionary = { manifest: DictionaryManifest; words: Word[] };
type Dialog = { title: string; content: ReactNode; action?: () => Promise<void>; actionText?: string };
const initialAudio: SpeechState = { status: 'idle', wordId: null, played: false, error: null, voice: null };
const dataUrl = new URL('./data/', document.baseURI).href;

function downloadText(name: string, contents: string) {
  const url = URL.createObjectURL(new Blob([contents], { type: 'application/json;charset=utf-8' }));
  const link = document.createElement('a'); link.href = url; link.download = name; link.click();
  setTimeout(() => URL.revokeObjectURL(url), 5000);
}

function friendlyError(error: unknown) {
  const message = error instanceof Error ? error.message : String(error);
  if (/quota|space/i.test(message)) return '设备空间不足。已保存的进度和下载分片仍保留，请释放空间后重试。';
  if (/revision|conflict|stale/i.test(message)) return '另一窗口更新了进度。请重新载入最新进度后继续，避免互相覆盖。';
  if (/version|dictionary/i.test(message)) return '词库版本或数据不匹配。现有进度已保留，请先导出备份，不要清除浏览器数据。';
  if (/fetch|network|offline/i.test(message)) return '下载未完成，请检查网络后重试。已完成的数据会保留。';
  if (/indexed|storage|database/i.test(message)) return '浏览器无法保存数据。请允许网站存储，或在普通浏览窗口打开；本次操作没有继续。';
  if (/valid|schema|parse|json|checksum|hash/i.test(message)) return '数据校验未通过，原有进度没有被覆盖。请使用本应用导出的完整备份，或重新下载词库。';
  return '操作未完成，已有进度未清除。请重试。' + (import.meta.env.DEV ? `（${message}）` : '');
}

function TextBackup({ text, restore, close }: { text: string | null; restore: (value: string) => void; close: () => void }) {
  const [value, setValue] = useState(text ?? '');
  const [message, setMessage] = useState('');
  const field = useRef<HTMLTextAreaElement>(null);
  return <Modal title={text === null ? '粘贴备份恢复' : '完整备份文本'} close={close}><p className="help-text">{text === null ? '粘贴本应用导出的完整 JSON 备份，校验后会显示恢复确认。' : '将完整文本复制到自己的文本文件中。请保留所有内容，恢复时可以直接粘贴。'}</p><textarea className="backup-text" ref={field} aria-label={text === null ? '粘贴完整备份 JSON' : '完整备份 JSON'} value={value} readOnly={text !== null} maxLength={16 * 1024 * 1024} onChange={e => setValue(e.target.value)} spellCheck={false} /><div className="dialog-actions">{text === null ? <button className="btn primary" disabled={!value.trim()} onClick={() => restore(value)}>校验并预览恢复</button> : <><button className="btn primary" onClick={() => { field.current?.focus(); field.current?.select(); if (navigator.clipboard?.writeText) void navigator.clipboard.writeText(value).then(() => setMessage('已复制完整备份文本')).catch(() => setMessage('文本已全选，请使用系统复制功能保存')); else setMessage('文本已全选，请使用系统复制功能保存'); }}>复制完整文本</button><button className="btn plain" onClick={() => downloadText(`word-backup-${new Date().toISOString().slice(0,10)}.json`, value)}>下载 JSON 文件</button></>}{message && <p className="help-text" role="status">{message}</p>}</div></Modal>;
}

function YesterdayReview({ state, mode, start }: { state: AppState; mode: Mode; start: (mode: Mode) => void }) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => { const tick = () => setNow(Date.now()); const timer = setInterval(tick, 60_000); window.addEventListener('focus', tick); return () => { clearInterval(timer); window.removeEventListener('focus', tick); }; }, []);
  const summary = getYesterdayReviewSummary(state, getLocalDateKey(now, new Date(now).getTimezoneOffset()));
  if (!summary.look.total && !summary.listen.total) return null;
  const counts = summary[mode]; const active = state.modes[mode].session?.status === 'active';
  return <section className="panel yesterday-panel" aria-label="昨日错词复习"><div><strong>昨日错词，今天再过一遍</strong><p>看词待检验 {summary.look.pending} · 听音待检验 {summary.listen.pending}</p><small>{counts.pending ? active ? '当前组保持原位，下一组优先加入昨日错词。' : '先复习昨天不认识的词，再补新词。' : '本模式昨日错词已检验，答错的词继续复习。'}</small></div><button className="icon-btn" aria-label="开始昨日错词复习" onClick={() => start(mode)}><ArrowRight /></button></section>;
}

export default function App() {
  const [phase, setPhase] = useState<'boot' | 'welcome' | 'loading' | 'ready' | 'failed'>('boot');
  const [dictionary, setDictionary] = useState<Dictionary | null>(null);
  const [state, setState] = useState<AppState | null>(null);
  const [page, setPage] = useState<Page>('home');
  const [mode, setMode] = useState<Mode>('look');
  const [progressMode, setProgressMode] = useState<Mode>('look');
  const [ringIntro, setRingIntro] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [toast, setToast] = useState('');
  const [skipNotice, setSkipNotice] = useState<{ word: string; first: boolean } | null>(null);
  const [detail, setDetail] = useState<Word | null>(null);
  const [dialog, setDialog] = useState<Dialog | null>(null);
  const [query, setQuery] = useState('');
  const [wordFilter, setWordFilter] = useState<'learning' | 'all' | 'skipped'>('learning');
  const [visibleCount, setVisibleCount] = useState(60);
  const [searchResult, setSearchResult] = useState<Word[]>([]);
  const [homeQuery, setHomeQuery] = useState('');
  const [searching, setSearching] = useState(false);
  const [searchError, setSearchError] = useState('');
  const [calendarDay, setCalendarDay] = useState<string | null>(null);
  const [knownPreview, setKnownPreview] = useState<{ state: AppState; word: Word; mode: Mode; saved: boolean } | null>(null);
  const [historyOffset, setHistoryOffset] = useState(0);
  const [retellBusy, setRetellBusy] = useState(false);
  const [audio, setAudio] = useState<SpeechState>(initialAudio);
  const [voices, setVoices] = useState<SpeechSynthesisVoice[]>([]);
  const [offline, setOffline] = useState(!navigator.onLine);
  const [downloadProgress, setDownloadProgress] = useState<DownloadProgress | null>(null);
  const [downloading, setDownloading] = useState(false);
  const [swWaiting, setSwWaiting] = useState<ServiceWorker | null>(null);
  const [recoveryRaw, setRecoveryRaw] = useState<string | null>(null);
  const [textBackup, setTextBackup] = useState<{ text: string | null } | null>(null);
  const dbRef = useRef<WordDatabase | null>(null);
  const stateRef = useRef<AppState | null>(null);
  const speechRef = useRef<SpeechController | null>(null);
  const feedbackRef = useRef<FeedbackController | null>(null);
  const mutex = useRef(false);
  const nextClickAt = useRef(0);
  const fileRef = useRef<HTMLInputElement>(null);
  const abortRef = useRef<AbortController | null>(null);
  const mounted = useRef(true);
  const closeDialog = useCallback(() => setDialog(null), []);
  const closeDetail = useCallback(() => { setDetail(null); speechRef.current?.cancel(); }, []);
  const closeTextBackup = useCallback(() => setTextBackup(null), []);
  const closeCalendar = useCallback(() => setCalendarDay(null), []);
  const acceptState = useCallback((next: AppState) => { stateRef.current = next; setState(next); setHistoryOffset(0); }, []);

  useEffect(() => {
    mounted.current = true;
    let live = true;
    void (async () => {
      try {
        const db = await openWordDatabase(); if (!live) { db.close(); return; }
        dbRef.current = db;
        const cached = await readCachedStudy(db);
        if (!live) return;
        if (!cached) { setPhase('welcome'); return; }
        setDictionary(cached);
        const saved = await db.readState(cached.words, cached.manifest.version);
        if (!live) return;
        setDictionary(cached);
        if (saved) acceptState(saved);
        else { const initial = createInitialState(cached.manifest.version, Date.now()); await db.saveState(initial, null, cached.words, cached.manifest.version); acceptState(initial); }
        setPhase('ready');
      } catch (e) {
        if (live) {
          setError(friendlyError(e)); setPhase('failed');
          try { const raw = await dbRef.current?.readRawState(); if (live && raw !== undefined) setRecoveryRaw(JSON.stringify(raw)); } catch { /* Preserve the original failure; never clear data. */ }
        }
      }
    })();
    return () => { live = false; mounted.current = false; abortRef.current?.abort(); };
  }, [acceptState]);

  useEffect(() => {
    const controller = new SpeechController({ onStateChange: setAudio, onVoicesChange: setVoices });
    speechRef.current = controller;
    return () => { controller.dispose(); };
  }, []);
  useEffect(() => {
    const feedback = new FeedbackController();
    feedbackRef.current = feedback;
    return () => { feedback.dispose(); };
  }, []);

  useEffect(() => {
    const online = () => setOffline(!navigator.onLine);
    const offlineError = () => setToast('离线页面缓存未完成，请联网后重新打开。学习进度仍保存在本机。');
    window.addEventListener('online', online); window.addEventListener('offline', online); window.addEventListener('word-offline-error', offlineError);
    let active = true;
    if ('serviceWorker' in navigator && import.meta.env.PROD) void navigator.serviceWorker.ready.then(registration => {
      if (!active) return;
      if (registration.waiting) setSwWaiting(registration.waiting);
      registration.addEventListener('updatefound', () => {
        const installing = registration.installing;
        installing?.addEventListener('statechange', () => { if (active && installing.state === 'installed' && navigator.serviceWorker.controller) setSwWaiting(registration.waiting); });
      });
    });
    return () => { active = false; window.removeEventListener('online', online); window.removeEventListener('offline', online); window.removeEventListener('word-offline-error', offlineError); };
  }, []);

  useEffect(() => { if (!toast) return; const timer = setTimeout(() => setToast(''), 4500); return () => clearTimeout(timer); }, [toast]);
  useEffect(() => {
    if (!skipNotice) return;
    const timer = setTimeout(() => setSkipNotice(null), skipNotice.first ? 12_000 : 6500);
    return () => clearTimeout(timer);
  }, [skipNotice]);
  useEffect(() => {
    if (phase !== 'ready') return;
    const timer = setTimeout(() => setRingIntro(false), 1000);
    return () => clearTimeout(timer);
  }, [phase]);

  const current = useMemo(() => state && dictionary ? getCurrentWord(state, mode, dictionary.words) : undefined, [state, dictionary, mode]);
  const historyEntry = state ? getStudyHistoryEntry(state, mode, historyOffset) : undefined;
  const historyWord = useMemo(() => historyEntry ? dictionary?.words.find(word => word.id === historyEntry.wordId) : undefined, [dictionary, historyEntry]);
  const historyCount = state ? getStudyTrail(state, mode).length : 0;
  const session = state?.modes[mode].session;
  const token = state ? getCurrentToken(state, mode) : null;
  const settings = state?.settings;
  const speak = useCallback((slow = false) => {
    const word = detail ?? historyWord ?? current; if (!word || !settings) return;
    speechRef.current?.speak({ word: word.word, wordId: word.id, studyWordIndex: dictionary?.words.findIndex(entry => entry.id === word.id), dictionaryVersion: dictionary?.manifest.version, accent: settings.accent, voiceURI: settings.voiceURI, rate: slow ? 0.65 : settings.rate });
  }, [current, historyWord, detail, settings, dictionary?.manifest.version, dictionary?.words]);

  useEffect(() => {
    if (page === 'study' && current && historyOffset === 0 && settings?.autoSpeak && !stateRef.current?.modes[mode].session?.revealed && !detail && !dialog && !knownPreview) {
      speechRef.current?.speak({ word: current.word, wordId: current.id, studyWordIndex: dictionary?.words.findIndex(entry => entry.id === current.id), dictionaryVersion: dictionary?.manifest.version, accent: settings.accent, voiceURI: settings.voiceURI, rate: settings.rate });
    } else if (page !== 'study') speechRef.current?.cancel();
    return () => speechRef.current?.cancel();
  }, [page, mode, current, historyOffset, session?.groupNumber, session?.cursor, settings?.accent, settings?.voiceURI, settings?.rate, settings?.autoSpeak, detail, dialog, knownPreview, dictionary?.manifest.version, dictionary?.words]);

  useEffect(() => {
    if (!knownPreview?.saved) return;
    const timer = setTimeout(() => setKnownPreview(null), 1100);
    return () => clearTimeout(timer);
  }, [knownPreview]);

  useEffect(() => {
    if (!dictionary || !dbRef.current) return;
    let active = true;
    void getDownloadProgress(dbRef.current, dictionary.manifest).then(value => { if (active) setDownloadProgress(value); }).catch(e => { if (active) setError(friendlyError(e)); });
    return () => { active = false; };
  }, [dictionary]);

  const commit = useCallback(async (transform: (s: AppState) => AppState, debounce = false) => {
    if (mutex.current || !dbRef.current || !dictionary || !stateRef.current || (debounce && performance.now() < nextClickAt.current)) return false;
    mutex.current = true; setBusy(true); setError(''); setSkipNotice(null);
    if (debounce) nextClickAt.current = performance.now() + 300;
    try {
      const previous = stateRef.current;
      const next = transform(previous);
      if (next !== previous) { await dbRef.current.saveState(next, previous.revision, dictionary.words, dictionary.manifest.version); acceptState(next); }
      return true;
    } catch (e) { setError(friendlyError(e)); speechRef.current?.cancel(); return false; }
    finally { mutex.current = false; if (mounted.current) setBusy(false); }
  }, [dictionary, acceptState]);

  const start = useCallback(async (newMode: Mode) => {
    if (!dictionary) return;
    if (await commit(s => { const now = Date.now(); return ensureSession(s, dictionary.words, newMode, now, getLocalDateKey(now, new Date(now).getTimezoneOffset())); })) { if (stateRef.current?.settings.haptics) feedbackRef.current?.vibrateStart(); setKnownPreview(null); setHistoryOffset(0); setMode(newMode); setProgressMode(newMode); setPage('study'); }
  }, [commit, dictionary]);
  const doUndo = useCallback(async () => {
    const last = stateRef.current?.history.at(-1);
    if (!last) return;
    if (await commit(s => undo(s, Date.now()), last.action !== 'skip')) { setKnownPreview(null); setMode(last.mode); setPage('study'); setToast(last.action === 'skip' ? '已撤销斩，单词已回到学习位置' : '已撤销，计数和学习位置已恢复'); }
  }, [commit]);
  const doSkip = useCallback(() => {
    const before = stateRef.current;
    if (!before || !current || historyOffset > 0 || knownPreview || mutex.current || performance.now() < nextClickAt.current || token !== getCurrentToken(before, mode)) return;
    const first = !before.settings.skipHintSeen;
    setToast('');
    if (before.settings.soundEffects) void feedbackRef.current?.prepareSlash();
    void commit(s => skipWord(s, mode, token, Date.now()), true).then(ok => {
      if (ok && stateRef.current?.skipped.includes(current.id)) { if (before.settings.soundEffects) void feedbackRef.current?.playSlash(); setSkipNotice({ word: current.word, first }); }
    });
  }, [current, historyOffset, knownPreview, commit, mode, token]);
  const canAnswer = mode === 'look' || (audio.wordId === current?.id && audio.played && audio.status !== 'error');
  const doAnswer = useCallback((result: 'known' | 'unknown') => {
    const before = stateRef.current;
    if (!canAnswer || historyOffset > 0 || knownPreview || mutex.current || performance.now() < nextClickAt.current || !before || !current || token !== getCurrentToken(before, mode)) return;
    const firstKnown = result === 'known' && !(before.modes.look.progress[current.id]?.seenCount || before.modes.listen.progress[current.id]?.seenCount);
    if (firstKnown) setKnownPreview({ state: before, word: current, mode, saved: false });
    const now = Date.now();
    void commit(s => answer(s, mode, result, token, now, getLocalDateKey(now, new Date(now).getTimezoneOffset())), true).then(ok => {
      if (firstKnown) setKnownPreview(value => ok && value ? { ...value, saved: true } : null);
    });
  }, [canAnswer, historyOffset, commit, mode, token, current, knownPreview]);
  const doNext = useCallback(() => { if (!knownPreview && historyOffset === 0) void commit(s => nextWord(s, mode, token, Date.now()), true); }, [commit, mode, token, knownPreview, historyOffset]);
  const navigateHistory = useCallback((direction: 'previous' | 'next') => {
    if (!stateRef.current || mutex.current || knownPreview || detail || dialog) return;
    speechRef.current?.cancel();
    const next = moveStudyHistoryOffset(stateRef.current, mode, historyOffset, direction);
    setHistoryOffset(next);
  }, [mode, historyOffset, knownPreview, detail, dialog]);

  useEffect(() => {
    const handler = (event: KeyboardEvent) => {
      if (page !== 'study' || detail || dialog || knownPreview || event.repeat || event.ctrlKey || event.metaKey || event.altKey || (event.target instanceof HTMLElement && (/INPUT|SELECT|TEXTAREA|SUMMARY/.test(event.target.tagName) || event.target.closest('.study-menu[open],.audio-error[open]')))) return;
      if (historyOffset > 0) {
        if (event.key === 'ArrowLeft' || event.key === 'ArrowRight') { event.preventDefault(); navigateHistory(event.key === 'ArrowLeft' ? 'previous' : 'next'); }
        else if (event.code === 'Space') { event.preventDefault(); speak(); }
        return;
      }
      if (event.code === 'Space') { event.preventDefault(); speak(); }
      else if (event.key === 'ArrowLeft') { event.preventDefault(); doAnswer('unknown'); }
      else if (event.key === 'ArrowRight') { event.preventDefault(); doAnswer('known'); }
      else if (event.key === 'Enter' && session?.revealed && !(event.target instanceof HTMLButtonElement)) { event.preventDefault(); doNext(); }
    };
    window.addEventListener('keydown', handler); return () => window.removeEventListener('keydown', handler);
  }, [page, detail, dialog, knownPreview, historyOffset, navigateHistory, speak, doAnswer, doNext, session?.revealed]);

  const load = async () => {
    if (!dbRef.current || phase === 'loading') return;
    setPhase('loading'); setError('');
    try {
      const loaded = await loadStudyDictionary(dbRef.current, { baseUrl: dataUrl });
      const saved = await dbRef.current.readState(loaded.words, loaded.manifest.version);
      const initial = saved ?? createInitialState(loaded.manifest.version, Date.now());
      if (!saved) await dbRef.current.saveState(initial, null, loaded.words, loaded.manifest.version);
      setDictionary(loaded); acceptState(initial); setPhase('ready');
    } catch (e) { setError(friendlyError(e)); setPhase('welcome'); }
  };

  const openInstallHelp = () => setDialog({ title: '安装到手机桌面', content: <InstallHelp /> });
  const changeSetting = (patch: Partial<Settings>) => { void commit(s => updateSettings(s, patch, Date.now())); };
  const backup = () => {
    if (!dictionary || !stateRef.current) return;
    try { downloadText(`word-backup-${new Date().toISOString().slice(0, 10)}.json`, exportBackup(stateRef.current, dictionary.words, dictionary.manifest.version)); setToast('已请求下载，请确认浏览器已保存备份；也可以使用文本备份'); }
    catch (e) { setError(friendlyError(e)); }
  };
  const importFile = async (file?: File) => {
    if (!file || !dictionary) return;
    try {
      const imported = await readBackupFile(file, dictionary.words, dictionary.manifest.version);
      setDialog({ title: '恢复学习备份', content: <p className="help-text">备份包含看词 {Object.keys(imported.modes.look.progress).length} 个、听音 {Object.keys(imported.modes.listen.progress).length} 个词的学习记录。恢复后将替换本机当前进度。建议先导出当前备份。</p>, actionText: '确认恢复备份', action: async () => {
        if (!dbRef.current || (!stateRef.current && recoveryRaw === null) || mutex.current) return;
        mutex.current = true; setBusy(true);
        try {
          const restored = recoveryRaw !== null && !stateRef.current
            ? await dbRef.current.recoverCorruptState(imported, recoveryRaw, dictionary.words, dictionary.manifest.version)
            : await dbRef.current.replaceStateFromBackup(imported, stateRef.current!.revision, dictionary.words, dictionary.manifest.version);
          acceptState(restored); setRecoveryRaw(null); setError(''); setPhase('ready'); setDialog(null); setPage('home'); setToast('备份已恢复');
        }
        catch (e) { setError(friendlyError(e)); }
        finally { mutex.current = false; setBusy(false); }
      } });
    } catch (e) { setError(friendlyError(e)); }
    finally { if (fileRef.current) fileRef.current.value = ''; }
  };

  const downloadDictionary = async () => {
    if (!dbRef.current || !dictionary || downloading) return;
    const abort = new AbortController(); abortRef.current = abort;
    setDownloading(true); setError('');
    try { await downloadAll(dbRef.current, dictionary.manifest, { baseUrl: dataUrl, signal: abort.signal, onProgress: setDownloadProgress }); setToast('完整词典已保存在本机，可以离线查词'); }
    catch (e) { if (!abort.signal.aborted) setError(friendlyError(e)); else setToast('下载已暂停，稍后可继续'); }
    finally { setDownloading(false); abortRef.current = null; }
  };

  useEffect(() => {
    if (page !== 'home' || !homeQuery.trim() || !dictionary || !dbRef.current) return;
    let active = true;
    const timer = setTimeout(() => {
      const prefix = homeQuery.trim().toLowerCase();
      void searchDictionary(dbRef.current!, dictionary.manifest.version, prefix, 60).then(result => {
        if (!active) return;
        const combined = new Map(result.map(word => [word.id, word]));
        for (const word of dictionary.words) if (word.word.toLowerCase().startsWith(prefix)) combined.set(word.id, word);
        setSearchResult([...combined.values()].sort((a, b) => Number(b.word.toLowerCase() === prefix) - Number(a.word.toLowerCase() === prefix) || a.word.localeCompare(b.word)).slice(0, 60));
        setSearching(false);
      }).catch(e => { if (active) { setSearchError(friendlyError(e)); setSearching(false); } });
    }, 160);
    return () => { active = false; clearTimeout(timer); };
  }, [homeQuery, page, dictionary, downloadProgress]);

  const filtered = useMemo(() => {
    if (!dictionary || !state) return [];
    const q = query.trim().toLowerCase();
    return dictionary.words.filter(word => {
      if (wordFilter === 'skipped') { if (!state.skipped.includes(word.id)) return false; }
      else { if (!wrongCount(state, word.id)) return false; if (wordFilter === 'learning' && (state.skipped.includes(word.id) || (state.modes.look.progress[word.id]?.status !== 'learning' && state.modes.listen.progress[word.id]?.status !== 'learning'))) return false; }
      return !q || word.word.toLowerCase().includes(q) || word.translation.includes(q);
    }).sort((a, b) => wrongCount(state, b.id) - wrongCount(state, a.id) || a.rank - b.rank);
  }, [dictionary, state, wordFilter, query]);

  const reload = async () => {
    if (!dbRef.current || !dictionary) { location.reload(); return; }
    try { const latest = await dbRef.current.readState(dictionary.words, dictionary.manifest.version); if (latest) { acceptState(latest); setError(''); setPage('home'); } }
    catch (e) { setError(friendlyError(e)); }
  };
  const audioMessage = audio.status === 'speaking' ? '正在朗读' : audio.status === 'starting' ? '正在准备发音…' : audio.status === 'ended' ? '已播放 · 点击喇叭重听' : '点击喇叭播放';
  const fileInput = <input className="sr-only" ref={fileRef} type="file" accept="application/json,.json" aria-label="选择学习备份文件" onChange={e => void importFile(e.target.files?.[0])} />;
  const dialogView = dialog && <Modal title={dialog.title} close={closeDialog}>{dialog.content}<div className="dialog-actions">{dialog.action && <button className="btn dark" disabled={busy} onClick={() => void dialog.action?.()}>{dialog.actionText}</button>}<button className="btn plain" onClick={closeDialog}>取消</button></div></Modal>;
  const textBackupView = textBackup && <TextBackup text={textBackup.text} close={closeTextBackup} restore={value => { setTextBackup(null); void importFile(new File([value], 'word-backup.json', { type: 'application/json' })); }} />;

  if (phase !== 'ready' || !state || !dictionary) return <main className="app-screen welcome-screen">
    <div className="welcome up"><div className="app-mark" aria-label="词">词</div><h1 className="wt">背单词</h1><div className="ws">每天几组，把单词真正记住</div></div>
    <div className="scrim" aria-hidden="true" />
    <section className="modal bottom" aria-label="欢迎使用"><h2>欢迎使用</h2><div className="lead">开始之前，了解一下单词与学习进度会保存在哪里</div>
      <ul className="blist"><li><ShieldCheck className="ic" /><span>不认识的词，<b>下一组再见</b>；连续认识两次完成本轮。</span></li><li><HardDrive className="ic" /><span>进度只保存在<b>当前设备</b>，支持完整备份与恢复。</span></li><li><ShieldCheck className="ic" /><span>无需注册账号。词库下载后可离线学习；发音只使用设备本地英文声音。</span></li></ul>
      {error && <div className="notice error" role="alert">{error}</div>}
      <p className="links">开始后将从本站下载 ECDICT 学习词库。<br />没有云同步，清理浏览器前请导出备份。</p>
      <div className="btn-col"><button className="btn primary" disabled={phase === 'boot' || phase === 'loading'} onClick={phase === 'failed' ? () => location.reload() : () => void load()}>{phase === 'boot' ? '正在读取本机数据…' : phase === 'loading' ? '正在下载并校验词库…' : phase === 'failed' ? '重新尝试' : '下载词库并开始'}<ArrowRight className="ic" /></button><button className="btn plain" onClick={() => setDialog({ title: '数据存储说明', content: <p className="help-text">词库从本站下载并保存在浏览器 IndexedDB。学习进度逐次保存到本机，不上传到服务器。换设备前请导出完整备份；浏览器清理网站数据会删除本机记录。网站托管服务会处理正常网络请求；发音优先使用本机 Samantha，仅选择浏览器提供的本地英文声音。</p> })}>了解数据存储</button></div>
      {phase === 'failed' && recoveryRaw !== null && <div className="btn-col"><button className="btn plain" onClick={() => downloadText('word-recovery-raw.json', recoveryRaw)}>导出原始记录留存</button>{dictionary && <button className="btn primary" onClick={() => fileRef.current?.click()}>从完整备份恢复</button>}</div>}
    </section>{fileInput}{dialogView}{textBackupView}
  </main>;

  return <main className={`app-screen ${page === 'study' ? 'study-screen' : ''}`}>
    {offline && <div className="notice">当前离线，进度仍会保存在本机。发音使用本机已安装的英文声音。</div>}
    {swWaiting && <div className="notice">新版本已准备好。<button disabled={busy || retellBusy} onClick={() => { navigator.serviceWorker.addEventListener('controllerchange', () => location.reload(), { once: true }); swWaiting.postMessage({ type: 'ACTIVATE_UPDATE' }); }}>保存后更新</button></div>}
    {error && <div className="notice error" role="alert">{error}<button onClick={() => void reload()}>重新载入进度</button></div>}
    {page === 'home' && <HomePage state={state} words={dictionary.words} mode={progressMode} onProgressMode={setProgressMode} ringIntro={ringIntro} start={m => void start(m)} onWord={setDetail} goWords={() => setPage('words')}
      install={<InstallButton className="install-button" onHelp={openInstallHelp} />}
      search={<div className="home-search"><SearchBox value={homeQuery} onChange={value => { setHomeQuery(value); setSearchResult([]); setSearchError(''); setSearching(!!value.trim()); }} placeholder="搜索词典 · 输入英文单词" />{homeQuery.trim() && <div className="panel home-search-results"><div className="search-caption"><span>{searching ? '正在查找…' : '本机词典 · 最多显示 60 词'}</span><button onClick={() => { setHomeQuery(''); setSearching(false); }}>收起</button></div>{searchError ? <p className="empty" role="alert">{searchError}</p> : !searching && <WordList state={state} mode={mode} words={searchResult} onWord={setDetail} empty={downloadProgress?.completed === downloadProgress?.total ? '没有找到匹配的词条。请检查英文拼写。' : '没有找到匹配的词条。可到设置下载完整词典，扩大搜索范围。'} />}</div>}</div>}
      calendar={<><YesterdayReview state={state} mode={progressMode} start={m => void start(m)} /><LearningCalendar state={state} onDay={setCalendarDay} /></>} />}
    {page === 'study' && <StudyPage state={knownPreview?.state ?? state} mode={knownPreview?.mode ?? mode} words={dictionary.words} word={knownPreview?.word ?? historyWord ?? current} historyEntry={historyEntry} historyOffset={historyOffset} historyCount={historyCount} onHistory={navigateHistory} onReturnCurrent={() => setHistoryOffset(0)} onSettingsChange={changeSetting} knownPreview={!!knownPreview} busy={busy || !!knownPreview} canAnswer={canAnswer} audioStatus={audioMessage} audioError={audio.status === 'error' || audio.status === 'unavailable' ? audio.error ?? '当前发音不可用，请重试或选择其他声音。' : ''} speaking={audio.status === 'speaking'} goHome={() => { setKnownPreview(null); setHistoryOffset(0); setPage('home'); }} goSettings={() => { setKnownPreview(null); setPage('settings'); }} speak={speak} onAnswer={doAnswer} onNext={doNext} onUndo={() => void doUndo()} onSkip={doSkip} onPauseWord={() => { void commit(s => deferWord(s, mode, token, Date.now()), true); }} nextGroup={() => void start(mode)} onWord={setDetail} />}
    {page === 'retell' && <Suspense fallback={<p className="empty" role="status">正在打开复述练习…</p>}><RetellPage settings={state.settings} onBusyChange={setRetellBusy} /></Suspense>}
    {page === 'words' && <div className="page"><div className="page-head"><div><div className="d">每一次不认识，都有记录</div><h1>生词本</h1></div></div><SearchBox value={query} onChange={value => { setQuery(value); setVisibleCount(60); }} placeholder="搜索单词或中文" /><div className="seg">{([['learning','学习中'],['all','全部生词'],['skipped','已跳过']] as const).map(([key,title]) => <button className={wordFilter === key ? 'on' : ''} key={key} onClick={() => { setWordFilter(key); setQuery(''); setVisibleCount(60); }}>{title}</button>)}</div><div className="sortline"><span>{`共 ${filtered.length} 词 · 不认识次数 ↓ · 圆点：${mode === 'look' ? '看词' : '听音'}`}</span>{wordFilter === 'learning' && <button onClick={() => void start(mode)}>继续复习 <ArrowRight size={13} /></button>}</div><WordList state={state} mode={mode} words={filtered.slice(0, visibleCount)} onWord={setDetail} empty={query ? '没有找到匹配的单词。' : wordFilter === 'skipped' ? '还没有长期跳过的词。' : undefined} />{visibleCount < filtered.length && <button className="btn plain" onClick={() => setVisibleCount(n => n + 60)}>显示更多</button>}</div>}
    {page === 'settings' && <div className="page settings-page"><div className="page-head"><h1>设置</h1></div><div className="set-label">安装与离线</div><div className="set-group"><div className="set-row vertical"><span className="sl">像 App 一样从桌面打开</span><p className="sd">安卓 Chrome 支持安装，词库下载后可离线使用。</p><InstallButton className="install-button" label="安装到手机桌面" onHelp={openInstallHelp} /><button className="row-action" onClick={openInstallHelp}><Download size={16} />查看安装方法</button></div></div><div className="set-label">词库范围</div><div className="set-group"><div className="pick">{(['all','cet4','cet6','ky','toefl','ielts','gre'] as Deck[]).map(deck => <button key={deck} className={settings?.deck === deck ? 'on' : ''} onClick={() => changeSetting({ deck })}>{settings?.deck === deck && <Check size={14} />}{deckNames[deck]}</button>)}</div><div className="set-row"><div><div className="sl">过滤基础词</div><div className="sd">仅跳过 a、the 等极基础词<br />词库设置从下一组生效，旧生词保留</div></div><button className="toggle" role="switch" aria-label="过滤基础词" aria-checked={state.settings.skipBasic} onClick={() => changeSetting({ skipBasic: !state.settings.skipBasic })} /></div></div>
    <div className="set-label">学习</div><div className="set-group"><div className="set-row"><span className="sl">每组单词数</span><div className="mini-seg">{([10,20,30] as const).map(groupSize => <button key={groupSize} className={state.settings.groupSize === groupSize ? 'on' : ''} onClick={() => changeSetting({ groupSize })}>{groupSize}</button>)}</div></div><div className="set-row"><div><div className="sl">本轮完成标准</div><div className="sd">不认识后，连续认识两次</div></div><span className="chip good">2 次</span></div><div className="set-row"><span className="sl">出词顺序</span><span className="chip">复习优先 · 按词频补充</span></div></div>
    <div className="set-label">触感与音效</div><div className="set-group"><div className="set-row"><div><div className="sl">开始学习震动</div><div className="sd">轻震一下 · 需要安卓浏览器支持</div></div><button className="toggle" role="switch" aria-label="开始学习震动" aria-checked={state.settings.haptics} onClick={() => changeSetting({ haptics: !state.settings.haptics })} /></div><div className="set-row"><div><div className="sl">斩词音效</div><div className="sd">斩词成功时播放短促刀切声</div></div><button className="toggle" role="switch" aria-label="斩词音效" aria-checked={state.settings.soundEffects} onClick={() => changeSetting({ soundEffects: !state.settings.soundEffects })} /></div></div>
    <div className="set-label">发音</div><div className="set-group"><div className="set-row"><span className="sl">口音</span><div className="mini-seg">{(['en-US','en-GB'] as const).map(accent => <button className={state.settings.accent === accent ? 'on' : ''} key={accent} onClick={() => changeSetting({ accent, voiceURI: '' })}>{accent === 'en-US' ? '美音' : '英音'}</button>)}</div></div><div className="set-row"><span className="sl">自动朗读</span><button className="toggle" role="switch" aria-label="自动朗读" aria-checked={state.settings.autoSpeak} onClick={() => changeSetting({ autoSpeak: !state.settings.autoSpeak })} /></div><div className="set-row vertical"><label className="sl" htmlFor="voice">发音来源</label><select id="voice" value={state.settings.voiceURI} onChange={e => changeSetting({ voiceURI: e.target.value })}><option value="">{state.settings.accent === 'en-US' ? '自动 · 优先本机 Samantha' : '自动 · 本机英国英语'}</option>{state.settings.voiceURI && !voices.some(v => v.localService && v.voiceURI === state.settings.voiceURI) && <option value={state.settings.voiceURI}>原声音当前不可用，请重新选择</option>}{voices.filter(v => v.localService && v.lang.replace('_','-').toLowerCase() === state.settings.accent.toLowerCase()).map(v => <option value={v.voiceURI} key={v.voiceURI}>{v.name} · 本机</option>)}</select><p className="sd">仅使用本机声音。优先 Samantha，没有时选择同口音的本地英语声音；安卓请在系统文字转语音设置中安装英文语音数据。当前浏览器没有暴露本地英文声音时会提示不可用，不改用在线音频。</p></div><div className="set-row"><label htmlFor="rate" className="sl">语速</label><select id="rate" value={state.settings.rate} onChange={e => changeSetting({ rate: Number(e.target.value) })}><option value={0.65}>慢速</option><option value={0.9}>适中</option><option value={1}>正常</option></select></div><div className="set-row"><button className="row-action" onClick={() => speechRef.current?.speak({ word: 'way', wordId: 'way', studyWordIndex: dictionary.words.findIndex(entry => entry.id === 'way'), dictionaryVersion: dictionary.manifest.version, accent: state.settings.accent, voiceURI: state.settings.voiceURI, rate: state.settings.rate })}><Volume2 size={18} />试听当前声音</button><span className="sd">{audio.status === 'speaking' ? '播放中' : audio.status === 'unavailable' || audio.status === 'error' ? '暂无可用发音' : ''}</span></div></div>
    <div className="set-label">数据与备份</div><div className="set-group"><div className="set-row"><div><div className="sl">本机进度</div><div className="sd">没有云同步，建议定期导出备份</div></div><span className="chip good">已保存</span></div><div className="set-row"><button className="row-action" onClick={backup}><Download size={18} />导出完整备份</button><button className="row-action" onClick={() => fileRef.current?.click()}><Upload size={18} />恢复备份</button></div><div className="set-row"><button className="row-action" onClick={() => { try { setTextBackup({ text: exportBackup(state, dictionary.words, dictionary.manifest.version) }); } catch (e) { setError(friendlyError(e)); } }}>文本备份</button><button className="row-action" onClick={() => setTextBackup({ text: null })}>粘贴备份恢复</button></div><div className="set-row"><button className="row-action" onClick={() => { if (!navigator.storage?.persist) { setToast('当前浏览器不支持持久存储保护，请定期导出备份'); return; } void navigator.storage.persist().then(granted => setToast(granted ? '已获得持久存储保护，仍建议定期备份' : '浏览器未授予持久存储，请定期导出备份')).catch(e => setError(friendlyError(e))); }}><ShieldCheck size={18} />申请持久存储保护</button></div><div className="set-row"><button className="row-action danger" onClick={() => setDialog({ title: '重置学习进度', content: <p className="help-text">这会清除本机的两种学习进度、跳过记录和设置，已下载的词库会保留。请先导出备份。</p>, actionText: '确认重置进度', action: async () => { if (await commit(s => ({ ...createInitialState(s.dictionaryVersion, Date.now()), revision: s.revision + 1 }))) { setDialog(null); setPage('home'); setToast('学习进度已重置'); } } })}><RotateCcw size={18} />重置进度</button></div></div>
    <div className="set-label">完整离线词典</div><div className="set-group"><div className="set-row vertical"><div className="sl">{dictionary.manifest.total.toLocaleString()} 个词条</div><p className="sd">学习包已就绪，共 {dictionary.words.length.toLocaleString()} 词。完整词典按分片下载，基础词仍保留，可查阅。中断后可以继续。</p>{downloadProgress && <><progress className="progress-download" max={downloadProgress.total} value={downloadProgress.completed} /><p className="sd">已下载 {downloadProgress.completed} / {downloadProgress.total} 个分片</p></>}<button className="row-action" onClick={downloading ? () => abortRef.current?.abort() : () => void downloadDictionary()}>{downloading ? <Pause size={18} /> : <Download size={18} />}{downloading ? '暂停下载' : '下载 / 继续下载完整词典'}</button></div></div>
    <div className="set-label">使用说明</div><div className="set-group"><div className="set-row vertical"><p className="help-text">手机浏览器菜单中选择“添加到主屏幕”，以后可从桌面打开。首次离线使用前，请联网完成词库下载。</p><p className="help-text">词典来源：ECDICT。中文与词性保留原文；缺失释义不会进入学习包。本机朗读的多读音词，可能与部分释义不同。日历从此版本开始记录，备份包含日历记录。</p><div className="source-links"><a href="https://github.com/skywind3000/ECDICT" target="_blank" rel="noreferrer">词典来源</a><a href={new URL(dictionary.manifest.license.file.replace(/^\/+/, ''), document.baseURI).href} target="_blank" rel="noreferrer">词典许可</a></div></div></div><p className="local-note">Word · 言习 / 0.1.0<br />清理浏览器数据会删除本机进度。</p></div>}
    {page !== 'study' && !(page === 'retell' && retellBusy) && <Navigation page={page} go={p => { setPage(p); setError(''); }} />}
    {calendarDay && <Modal title={`${calendarDay} · 学习记录`} close={closeCalendar}><DailyWords state={state} words={dictionary.words} date={calendarDay} onWord={word => { setCalendarDay(null); setDetail(word); }} /></Modal>}
    {fileInput}
    {toast && <div className="toast-message" role="status">{toast}</div>}
    {skipNotice && <div className="skip-notice" role="status"><div><strong>{skipNotice.first ? '斩：这个词太简单，今后跳过' : `已斩 · ${skipNotice.word}`}</strong><p>{skipNotice.first ? `「${skipNotice.word}」已加入已跳过，不计入不认识。可随时在生词本恢复。` : '已加入已跳过，不计入不认识。'}</p></div><button disabled={busy} onClick={() => void doUndo()} aria-label="撤销斩">撤销</button></div>}
    {dialogView}
    {textBackupView}
    {detail && <Modal title="单词详情" close={closeDetail} sheet><div className="detail-content"><div><div className="chips">{wordTags(detail).map(tag => <span className="chip" key={tag}>{deckNames[tag]}</span>)}</div><FittedWord className="d-word" word={detail.word} maxSize={42} /><div className="d-ph"><span className="p">{detail.phonetic && <><span className="acc-tag">词典</span>/{detail.phonetic}/</>}<button className="spk" aria-label="朗读这个词" onClick={() => speak()}><Volume2 className="ic" /></button></span></div></div><Meanings word={detail} /><PhraseSection key={detail.id} wordId={detail.id} dictionaryVersion={state.dictionaryVersion} /><div className="kv"><div><div className="k">不认识次数</div><div className="v r">{wrongCount(state,detail.id)}</div></div><div><div className="k">看词连续认识</div><div className="v">{state.modes.look.progress[detail.id]?.streak ?? 0}/2</div></div><div><div className="k">听音连续认识</div><div className="v">{state.modes.listen.progress[detail.id]?.streak ?? 0}/2</div></div></div><div className="timeline">看词与听音的进度<b>分别保存</b>。<br />不认识的词在后续组中再次出现，连续认识 <b>2 次</b>完成本轮。</div>{(state.skipped.includes(detail.id) || state.modes[mode].progress[detail.id]?.status === 'completed') && <div className="dialog-actions">{state.skipped.includes(detail.id) ? <button className="btn primary" onClick={() => { void commit(s => restoreSkipped(s,detail.id,Date.now())).then(ok => { if(ok) { setDetail(null); setToast('已恢复到学习范围'); } }); }}>恢复这个词</button> : <button className="btn primary" onClick={() => { void commit(s => restartWord(s,detail.id,mode,Date.now())).then(ok => { if(ok) { setDetail(null); setToast('已重新加入复习，下一组出现'); } }); }}>重新练习 · {modeNames[mode]}</button>}</div>}</div></Modal>}
  </main>;
}
