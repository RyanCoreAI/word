import { z } from 'zod';

export const attemptSchema = z.object({ lessonId: z.string().regex(/^[a-z-]+$/), lessonVersion: z.string().min(1).max(100), transcript: z.string().trim().min(1).max(12000), durationMs: z.number().int().min(0).max(180000), completedAt: z.number().int().nonnegative() }).strict();
export type AttemptText = z.infer<typeof attemptSchema>;
export type RetellAttempt = AttemptText & { audioBlob: Blob };
const MAX_AUDIO_BYTES = 20 * 1024 * 1024;

export function parseAttempt(raw: unknown): RetellAttempt {
  if (typeof raw !== 'object' || !raw || !('audioBlob' in raw)) throw new Error('复述记录格式无效，原数据未删除。');
  const { audioBlob, ...text } = raw;
  if (!(audioBlob instanceof Blob) || !audioBlob.size || audioBlob.size > MAX_AUDIO_BYTES || !/^(audio\/(webm|mp4|ogg|wav|mpeg)|video\/webm)(;.*)?$/.test(audioBlob.type)) throw new Error('录音记录格式或大小无效，原数据未删除。');
  return { ...attemptSchema.parse(text), audioBlob };
}

async function open(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open('yanxai-retell-v1', 1);
    request.onupgradeneeded = () => { if (!request.result.objectStoreNames.contains('attempts')) request.result.createObjectStore('attempts', { keyPath: 'lessonId' }); };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(new Error('无法打开本机复述存储。'));
    request.onblocked = () => reject(new Error('复述存储正在被另一窗口使用，请关闭旧窗口后重试。'));
  });
}

export async function readAttempts(): Promise<RetellAttempt[]> {
  const db = await open();
  try { return await new Promise((resolve, reject) => { const tx = db.transaction('attempts'); const request = tx.objectStore('attempts').getAll(); let rows: unknown[] = []; request.onsuccess = () => { rows = request.result as unknown[]; }; tx.oncomplete = () => { try { resolve(rows.map(parseAttempt)); } catch (error) { reject(error); } }; tx.onerror = () => reject(new Error('本机复述记录读取失败，原数据仍保留。')); tx.onabort = () => reject(new Error('本机复述记录读取已中断。')); }); }
  finally { db.close(); }
}

/** One latest attempt per article; replacement is explicit in the recording UI. */
export async function saveAttempt(raw: RetellAttempt): Promise<void> {
  const attempt = parseAttempt(raw); const db = await open();
  try { await new Promise<void>((resolve, reject) => {
    const tx = db.transaction('attempts', 'readwrite'); const store = tx.objectStore('attempts'); const request = store.get(attempt.lessonId); let failure: Error | null = null;
    request.onsuccess = () => { try { if (request.result && parseAttempt(request.result).completedAt > attempt.completedAt) throw new Error('另一窗口已保存更新的复述，本次没有覆盖。'); store.put(attempt); } catch (error) { failure = error instanceof Error ? error : new Error('复述记录校验失败。'); tx.abort(); } };
    tx.oncomplete = () => resolve(); tx.onabort = () => reject(failure ?? new Error('复述尚未保存，请导出文字或录音后重试。')); tx.onerror = () => reject(new Error('本机空间或存储不可用，复述尚未保存。'));
  }); } finally { db.close(); }
}

export function exportAttemptText(attempts: readonly RetellAttempt[]): string {
  return JSON.stringify({ format: 'yanxai-retell-text', version: 1, attempts: attempts.map(attempt => attemptSchema.parse({ lessonId: attempt.lessonId, lessonVersion: attempt.lessonVersion, transcript: attempt.transcript, durationMs: attempt.durationMs, completedAt: attempt.completedAt })) }, null, 2);
}
