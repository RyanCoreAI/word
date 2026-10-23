import { useEffect, useRef, useState } from 'react';
import { Check, ChevronLeft, ChevronRight, Download, Link, LoaderCircle, Share2 } from 'lucide-react';
import { Modal } from './Modal';
import { CHECK_IN_SCENES, CHECK_IN_URL, CheckInImageRequest, checkInScenePath, checkInSummary, copyCheckInLink, defaultCheckInScene, shareCheckInImage, type CheckInShareData } from './lib/check-in-share';
import './check-in-share.css';

export type { CheckInShareData } from './lib/check-in-share';

interface ReadyImage { file: File; url: string; key: string; dataKey: string; scene: number }

export default function CheckInShare({ data, close, initialScene }: { data: CheckInShareData; close: () => void; initialScene?: number }) {
  const [imageState, setImage] = useState<ReadyImage | null>(null);
  const [errorState, setError] = useState<{ message: string; dataKey: string } | null>(null);
  const [message, setMessage] = useState('');
  const [sharing, setSharing] = useState(false);
  const [manualCopy, setManualCopy] = useState(false);
  const [attempt, setAttempt] = useState(0);
  const [scene, setScene] = useState(() => {
    if (initialScene !== undefined) { checkInScenePath(initialScene); return initialScene; }
    return defaultCheckInScene(data);
  });
  const [generator] = useState(() => new CheckInImageRequest());
  const link = useRef<HTMLInputElement>(null);
  const activeShare = useRef(false);
  const mounted = useRef(false);
  const lastImage = useRef<ReadyImage | null>(null);
  const { dateKey, deckName, modeLabel, newCount, reviewCount } = data;
  const dataKey = JSON.stringify([dateKey, deckName, modeLabel, newCount, reviewCount]);
  const imageKey = JSON.stringify([dataKey, scene, attempt]);
  const image = imageState?.dataKey === dataKey ? imageState : null;
  const ready = image?.key === imageKey;
  const error = errorState?.dataKey === dataKey ? errorState.message : '';

  useEffect(() => {
    mounted.current = true;
    return () => { mounted.current = false; };
  }, []);

  useEffect(() => {
    if (lastImage.current?.key === imageKey) return;
    void generator.generate({ dateKey, deckName, modeLabel, newCount, reviewCount }, scene).then(file => {
      if (!file) return;
      const result = { file, url: URL.createObjectURL(file), key: imageKey, dataKey, scene };
      lastImage.current = result; setImage(result);
    }).catch(reason => {
      const previous = lastImage.current;
      const detail = reason instanceof Error ? reason.message : '图片生成失败，请重试';
      if (previous?.dataKey === dataKey) {
        setScene(previous.scene);
        setError({ message: `${CHECK_IN_SCENES[scene]!.label}暂时无法加载，已保留${CHECK_IN_SCENES[previous.scene]!.label}。联网后可再试。`, dataKey });
      } else setError({ message: detail, dataKey });
    });
    return () => generator.cancel();
  }, [dateKey, deckName, modeLabel, newCount, reviewCount, imageKey, dataKey, scene, generator]);

  useEffect(() => () => { if (imageState) URL.revokeObjectURL(imageState.url); }, [imageState]);

  async function share() {
    if (!image || !ready || activeShare.current) return;
    activeShare.current = true; setSharing(true);
    const result = await shareCheckInImage(image.file);
    if (mounted.current) {
      setSharing(false);
      setMessage({ shared: '已交给系统分享，请在所选应用中确认。', cancelled: '已取消分享，图片仍可保存。', unsupported: '当前浏览器不支持图片分享，可保存后发送到微信或 QQ。', failed: '系统分享未完成，可以保存图片后发送。' }[result]);
    }
    activeShare.current = false;
  }

  function save() {
    if (!image || !ready) return;
    const anchor = document.createElement('a'); anchor.href = image.url; anchor.download = image.file.name;
    document.body.append(anchor); anchor.click(); anchor.remove();
    setMessage('已请求保存图片；若浏览器打开图片，可长按保存。');
  }

  async function copy() {
    const copied = await copyCheckInLink();
    if (!mounted.current) return;
    setManualCopy(!copied); setMessage(copied ? '官网链接已复制。' : '请选中下方官网地址，长按或使用系统复制。');
  }

  function retry() { setError(null); setImage(null); setMessage(''); setAttempt(value => value + 1); }
  function changeScene(direction: number) { setError(null); setMessage(''); setScene(value => (value + direction + CHECK_IN_SCENES.length) % CHECK_IN_SCENES.length); }

  let summaryText = '学习打卡图';
  try { const summary = checkInSummary(data); summaryText = `${summary.displayDate}，${summary.deckName}，${summary.modeLabel}，学习 ${summary.total} 词，新词 ${newCount}，复习 ${reviewCount}。图片右下角为官网二维码。`; } catch { /* Generation reports the validation error. */ }

  return <Modal title="今日打卡" close={close} fullScreen headerAction={<span className="check-in-share-done" aria-hidden="true"><Check size={21}/></span>}>
    <section className="check-in-share" aria-label="打卡图片与分享">
      <div className="check-in-share-badge"><Check size={14} aria-hidden="true"/>学习已打卡</div>
      <div className="check-in-share-scenes" aria-label="选择打卡风景">
        <button className="icon-btn" onClick={() => changeScene(-1)} aria-label="上一张风景" disabled={sharing}><ChevronLeft size={20}/></button>
        <span>{CHECK_IN_SCENES[scene]!.label}<small>{scene + 1} / {CHECK_IN_SCENES.length}</small></span>
        <button className="icon-btn" onClick={() => changeScene(1)} aria-label="下一张风景" disabled={sharing}><ChevronRight size={20}/></button>
      </div>
      <div className="check-in-share-preview" aria-busy={!ready && !error}>
        {image ? <img src={image.url} alt={summaryText} width={1080} height={1584}/> : error ? <div className="check-in-share-placeholder" role="alert"><p>{error}</p><button className="btn" onClick={retry}>重新生成</button></div> : <div className="check-in-share-placeholder" role="status"><LoaderCircle className="check-in-share-spinner" aria-hidden="true"/><p>正在生成打卡图…</p></div>}
        {image && !ready && !error && <div className="check-in-share-changing" role="status"><LoaderCircle className="check-in-share-spinner" size={18} aria-hidden="true"/>正在准备{CHECK_IN_SCENES[scene]!.label}…</div>}
      </div>
      <div className="check-in-share-actions">
        <button className="btn primary check-in-share-primary" onClick={share} disabled={!ready || sharing}><Share2 size={21} aria-hidden="true"/>{sharing ? '正在打开分享…' : '分享打卡图'}</button>
        <div className="check-in-share-secondary">
          <button className="btn" onClick={save} disabled={!ready}><Download size={19} aria-hidden="true"/>保存图片</button>
          <button className="btn" onClick={copy}><Link size={19} aria-hidden="true"/>复制官网链接</button>
        </div>
      </div>
      <p className="check-in-share-help">在系统分享中选择微信或 QQ；不可用时保存后发送</p>
      {image && error && <p className="check-in-share-status" role="alert">{error}</p>}
      {message && <p className="check-in-share-status" role="status">{message}</p>}
      {manualCopy && <div className="check-in-share-copy"><label htmlFor="check-in-share-link">官网地址</label><input id="check-in-share-link" ref={link} value={CHECK_IN_URL} readOnly onFocus={event => event.currentTarget.select()}/><button className="btn" onClick={() => { link.current?.focus(); link.current?.select(); }}>选中链接</button></div>}
    </section>
  </Modal>;
}
