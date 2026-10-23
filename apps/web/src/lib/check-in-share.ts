import QRCode from 'qrcode';
import bookIconUrl from 'lucide-static/icons/book-open.svg?url';
import { isLocalDateKey } from '../../../../packages/core/src/activity';

export const CHECK_IN_URL = 'https://word.yanxai.com/';
export const CHECK_IN_IMAGE_WIDTH = 1080;
export const CHECK_IN_IMAGE_HEIGHT = 1584;
export const CHECK_IN_SCENES = Array.from({ length: 20 }, (_, index) => ({
  id: String(index + 1).padStart(2, '0'), label: `风景 ${String(index + 1).padStart(2, '0')}`,
}));

/** Counts are distinct words; the caller must supply disjoint new/review sets. */
export interface CheckInShareData {
  dateKey: string;
  deckName: string;
  modeLabel: string;
  newCount: number;
  reviewCount: number;
}

export function checkInSummary(data: CheckInShareData) {
  if (!isLocalDateKey(data.dateKey)) throw new Error('打卡日期无效');
  for (const [value, limit] of [[data.deckName, 100], [data.modeLabel, 24]] as const) {
    if (typeof value !== 'string' || !value.trim() || value.length > limit || [...value].some(character => character.charCodeAt(0) < 32 || character.charCodeAt(0) === 127)) throw new Error('打卡名称无效');
  }
  if (![data.newCount, data.reviewCount].every(count => Number.isSafeInteger(count) && count >= 0)
    || data.newCount + data.reviewCount > 1_000_000) throw new Error('打卡词数无效');
  return {
    ...data, deckName: data.deckName.trim(), modeLabel: data.modeLabel.trim(),
    total: data.newCount + data.reviewCount,
    displayDate: data.dateKey.replaceAll('-', '.'),
    fileName: `word-check-in-${data.dateKey}.png`,
  };
}

/** The QR always points to the public home page, never a user's progress. */
export function createCheckInQr() {
  return QRCode.create(CHECK_IN_URL, { errorCorrectionLevel: 'M' });
}

export function checkInScenePath(scene: number): string {
  if (!Number.isInteger(scene) || scene < 0 || scene >= CHECK_IN_SCENES.length) throw new Error('风景选择无效');
  return `images/check-in/${CHECK_IN_SCENES[scene]!.id}.png`;
}

export function defaultCheckInScene(data: Pick<CheckInShareData, 'dateKey' | 'deckName' | 'modeLabel'>): number {
  let hash = 2166136261;
  for (const character of `${data.dateKey}\n${data.deckName}\n${data.modeLabel}`) hash = Math.imul(hash ^ character.codePointAt(0)!, 16777619);
  return (hash >>> 0) % CHECK_IN_SCENES.length;
}

export interface CheckInImageOptions { scene?: number; signal?: AbortSignal }

function loadImage(src: string, signal?: AbortSignal): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    signal?.throwIfAborted();
    const image = new Image();
    const clean = () => { image.onload = null; image.onerror = null; signal?.removeEventListener('abort', abort); };
    const abort = () => { clean(); image.src = ''; reject(new DOMException('Image generation cancelled', 'AbortError')); };
    image.onload = () => { clean(); resolve(image); };
    image.onerror = () => { clean(); reject(new Error('风景图片暂时无法加载，请重试')); };
    signal?.addEventListener('abort', abort, { once: true });
    image.src = src;
  });
}

function fittedText(context: CanvasRenderingContext2D, text: string, x: number, y: number, width: number, size: number, weight = 500) {
  let fontSize = size;
  const font = () => `${weight} ${fontSize}px "Noto Sans SC", sans-serif`;
  context.font = font();
  while (context.measureText(text).width > width && fontSize > 28) { fontSize -= 1; context.font = font(); }
  let visible = text;
  while (context.measureText(visible).width > width && visible.length > 1) visible = `${visible.slice(0, -2)}…`;
  context.fillText(visible, x, y);
}

export async function createCheckInImage(data: CheckInShareData, { signal, scene = defaultCheckInScene(data) }: CheckInImageOptions = {}): Promise<File> {
  const summary = checkInSummary(data);
  signal?.throwIfAborted();
  // Both image paths are bundled/same-origin. No external image, font or QR service is used.
  const photoUrl = new URL(`${import.meta.env.BASE_URL}${checkInScenePath(scene)}`, window.location.href);
  if (photoUrl.origin !== window.location.origin) throw new Error('分享图片必须来自本站');
  const fontsReady = Promise.all([
    document.fonts.load('500 42px "Noto Sans SC"', `${summary.deckName}${summary.modeLabel}今日学习新词复习扫码访问官网一起背单词`),
    document.fonts.load('700 42px "Noto Sans SC"', `${summary.deckName}${summary.modeLabel}`),
    document.fonts.load('800 144px Inter', '0123456789,'),
    document.fonts.load('700 50px Inter', 'Word'),
    document.fonts.load('500 38px Inter', 'word.yanxai.com2026.')]).catch(() => {
    // Cached scenes remain exportable offline even if a new local font subset is unavailable.
    // Canvas then uses the device's local sans-serif fallback; no remote font service is used.
  });
  const [photo, book] = await Promise.all([loadImage(photoUrl.href, signal), loadImage(bookIconUrl, signal), fontsReady]);
  signal?.throwIfAborted();
  const canvas = document.createElement('canvas');
  canvas.width = CHECK_IN_IMAGE_WIDTH; canvas.height = CHECK_IN_IMAGE_HEIGHT;
  const context = canvas.getContext('2d');
  if (!context) throw new Error('此浏览器无法生成打卡图片');
  context.fillStyle = '#fffefd'; context.fillRect(0, 0, canvas.width, canvas.height);
  const imageHeight = 864;
  const scale = Math.max(canvas.width / photo.naturalWidth, imageHeight / photo.naturalHeight);
  context.save(); context.beginPath(); context.rect(0, 0, canvas.width, imageHeight); context.clip();
  context.drawImage(photo, (canvas.width - photo.naturalWidth * scale) / 2, (imageHeight - photo.naturalHeight * scale) / 2, photo.naturalWidth * scale, photo.naturalHeight * scale);
  const shade = context.createLinearGradient(0, 0, 0, 220); shade.addColorStop(0, 'rgba(12,42,68,.24)'); shade.addColorStop(1, 'rgba(12,42,68,0)');
  context.fillStyle = shade; context.fillRect(0, 0, canvas.width, 220); context.restore();
  context.fillStyle = '#fff'; context.font = '700 50px Inter, sans-serif'; context.fillText('Word', 56, 92);
  context.font = '500 38px Inter, sans-serif'; context.textAlign = 'right'; context.fillText(summary.displayDate, 1024, 90); context.textAlign = 'left';
  context.fillStyle = '#e9edff'; context.beginPath(); context.roundRect(60, 902, 108, 108, 30); context.fill();
  const icon = document.createElement('canvas'); icon.width = 64; icon.height = 64;
  const iconContext = icon.getContext('2d');
  if (!iconContext) throw new Error('此浏览器无法生成打卡图片');
  iconContext.drawImage(book, 0, 0, 64, 64); iconContext.globalCompositeOperation = 'source-in'; iconContext.fillStyle = '#3d48e8'; iconContext.fillRect(0, 0, 64, 64);
  context.drawImage(icon, 82, 924);
  context.fillStyle = '#323c53'; fittedText(context, `${summary.deckName} · ${summary.modeLabel}`, 202, 971, 812, 42, 700);
  context.fillStyle = '#161c28'; context.font = '800 144px Inter, sans-serif';
  const totalText = summary.total.toLocaleString('zh-CN'); const numberWidth = context.measureText(totalText).width;
  context.fillText(totalText, 60, 1157);
  context.fillStyle = '#323c53'; context.font = '500 48px "Noto Sans SC", sans-serif'; context.fillText('词', 80 + numberWidth, 1150);
  context.font = '500 44px "Noto Sans SC", sans-serif'; context.fillText('今日学习', 60, 1220);
  context.fillStyle = '#7c8597'; context.font = '500 35px "Noto Sans SC", sans-serif'; context.fillText(`新词 ${summary.newCount.toLocaleString('zh-CN')}  ·  复习 ${summary.reviewCount.toLocaleString('zh-CN')}`, 60, 1290);
  context.strokeStyle = '#e3e1df'; context.lineWidth = 2; context.beginPath(); context.moveTo(60, 1326); context.lineTo(1020, 1326); context.stroke();
  context.fillStyle = '#3a455c'; context.font = '600 38px Inter, sans-serif'; context.fillText('word.yanxai.com', 60, 1456);
  context.fillStyle = '#7c8597'; context.font = '500 31px "Noto Sans SC", sans-serif'; context.fillText('一起背单词', 60, 1505);
  const qr = createCheckInQr(); const quiet = 4; const pixel = 5; const qrSize = (qr.modules.size + quiet * 2) * pixel;
  const qrX = 1020 - qrSize; const qrY = 1342;
  context.fillStyle = '#fff'; context.fillRect(qrX, qrY, qrSize, qrSize);
  context.fillStyle = '#101418';
  for (let row = 0; row < qr.modules.size; row += 1) for (let col = 0; col < qr.modules.size; col += 1) {
    if (qr.modules.get(row, col)) context.fillRect(qrX + (col + quiet) * pixel, qrY + (row + quiet) * pixel, pixel, pixel);
  }
  context.fillStyle = '#7c8597'; context.textAlign = 'center'; context.font = '500 27px "Noto Sans SC", sans-serif'; context.fillText('扫码访问官网', qrX + qrSize / 2, 1560);
  signal?.throwIfAborted();
  const blob = await new Promise<Blob>((resolve, reject) => canvas.toBlob(result => result ? resolve(result) : reject(new Error('图片生成失败，请重试')), 'image/png'));
  signal?.throwIfAborted();
  return new File([blob], summary.fileName, { type: 'image/png' });
}

/** Cancels older renders; even a renderer that completes after abort cannot publish a stale PNG. */
export class CheckInImageRequest {
  private sequence = 0;
  private controller: AbortController | null = null;
  constructor(private readonly render: typeof createCheckInImage = createCheckInImage) {}
  async generate(data: CheckInShareData, scene: number): Promise<File | null> {
    checkInScenePath(scene);
    this.cancel();
    const sequence = this.sequence;
    const controller = new AbortController(); this.controller = controller;
    try {
      const file = await this.render(data, { scene, signal: controller.signal });
      return !controller.signal.aborted && sequence === this.sequence ? file : null;
    } catch (error) {
      if (controller.signal.aborted || sequence !== this.sequence) return null;
      throw error;
    }
  }
  cancel(): void { this.sequence += 1; this.controller?.abort(); this.controller = null; }
}

export interface ShareNavigator {
  canShare?: (data?: ShareData) => boolean;
  share?: (data?: ShareData) => Promise<void>;
}
export type CheckInShareResult = 'shared' | 'cancelled' | 'unsupported' | 'failed';

export function checkInSharePayload(file: File): ShareData {
  if (file.type !== 'image/png' || file.size === 0 || file.size > 10 * 1024 * 1024) throw new Error('打卡图片无效');
  // Receivers may discard accompanying text; the picture itself contains the URL and QR.
  return { files: [file], title: 'Word · 学习打卡', text: CHECK_IN_URL };
}

/** Call directly from a click with an already-generated File, before any awaited work. */
export async function shareCheckInImage(file: File, target: ShareNavigator = typeof navigator === 'undefined' ? {} : navigator): Promise<CheckInShareResult> {
  try {
    const payload = checkInSharePayload(file);
    if (!target.share || !target.canShare || !target.canShare({ files: [file] })) return 'unsupported';
    await target.share(payload);
    return 'shared';
  } catch (error) {
    return error instanceof Error && error.name === 'AbortError' ? 'cancelled' : 'failed';
  }
}

export async function copyCheckInLink(clipboard: Pick<Clipboard, 'writeText'> | null | undefined = typeof navigator === 'undefined' ? null : navigator.clipboard): Promise<boolean> {
  try { if (!clipboard) return false; await clipboard.writeText(CHECK_IN_URL); return true; } catch { return false; }
}
