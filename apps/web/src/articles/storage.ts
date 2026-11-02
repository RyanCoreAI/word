import { z } from 'zod';
import { createArticleLibrary, importedArticleSchema, MAX_ARTICLE_LIBRARY_BYTES, normalizeArticleText, parseArticleLibrary, validateArticleText, type ArticleLibrary, type ImportedArticle } from '../../../../packages/core/src/article-library';

export const ARTICLE_DATABASE_NAME = 'yanxai-articles-v1';
export const MAX_ARTICLE_BACKUP_BYTES = MAX_ARTICLE_LIBRARY_BYTES;
export const MAX_TXT_FILE_BYTES = 2 * 1024 * 1024;
const backupSchema = z.object({ format: z.literal('yanxai-article-library-backup'), version: z.literal(1), exportedAt: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER - 1), library: z.unknown() }).strict();

export class ArticleStorageConflictError extends Error {
  constructor() { super('文章已在另一个页面更新，本次未覆盖。请重新载入文章库后继续。'); this.name = 'ArticleStorageConflictError'; }
}
export class ArticleStorageUnavailableError extends Error {
  constructor(message = '本机文章存储不可用，原数据未删除。请检查浏览器存储权限和剩余空间。') { super(message); this.name = 'ArticleStorageUnavailableError'; }
}

export async function articleTextHash(text: string): Promise<string> {
  const bytes = new TextEncoder().encode(normalizeArticleText(text));
  return Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', bytes)), byte => byte.toString(16).padStart(2, '0')).join('');
}

export interface PrepareArticleInput { title: string; text: string; sourceUrl?: string; sourceFormat: 'paste' | 'txt' }
export async function prepareArticle(input: PrepareArticleInput, now: number): Promise<ImportedArticle> {
  const text = validateArticleText(input.text);
  const contentHash = await articleTextHash(text);
  return importedArticleSchema.parse({ id: `article-${contentHash}`, contentHash, title: input.title.trim() || text.split('\n')[0]!.slice(0, 80), text,
    ...(input.sourceUrl?.trim() ? { sourceUrl: input.sourceUrl.trim() } : {}), sourceFormat: input.sourceFormat, createdAt: now, readParagraph: 0, overrides: {} });
}

export async function readTxtFile(file: Pick<File, 'name' | 'size' | 'arrayBuffer'>): Promise<string> {
  if (!/\.txt$/i.test(file.name)) throw new Error('目前仅支持 .txt 纯文本文件；其他格式请复制正文粘贴。');
  if (!file.size || file.size > MAX_TXT_FILE_BYTES) throw new Error('TXT 文件不能为空，且不能超过 2 MB。');
  const buffer = await file.arrayBuffer();
  if (buffer.byteLength > MAX_TXT_FILE_BYTES) throw new Error('TXT 文件超过 2 MB。');
  let text: string;
  try { text = new TextDecoder('utf-8', { fatal: true }).decode(buffer); }
  catch { throw new Error('TXT 不是有效的 UTF-8 编码，请另存为 UTF-8 后重试。'); }
  return validateArticleText(text);
}

export function exportArticleBackup(raw: ArticleLibrary, now = Date.now()): string {
  const library = parseArticleLibrary(raw);
  const text = JSON.stringify(backupSchema.parse({ format: 'yanxai-article-library-backup', version: 1, exportedAt: now, library }));
  if (new TextEncoder().encode(text).byteLength > MAX_ARTICLE_BACKUP_BYTES) throw new Error('文章备份超过 20 MB。');
  return text;
}

async function verifyContentHashes(library: ArticleLibrary): Promise<void> {
  for (const article of library.articles) {
    if (await articleTextHash(article.text) !== article.contentHash) throw new Error('文章正文与内容校验值不一致，原数据未覆盖。');
  }
}

export async function parseArticleBackup(text: string): Promise<ArticleLibrary> {
  if (text.length > MAX_ARTICLE_BACKUP_BYTES || new TextEncoder().encode(text).byteLength > MAX_ARTICLE_BACKUP_BYTES) throw new Error('文章备份超过 20 MB。');
  const envelope = backupSchema.parse(JSON.parse(text) as unknown);
  const library = parseArticleLibrary(envelope.library);
  await verifyContentHashes(library);
  return library;
}

export async function readArticleBackupFile(file: Pick<Blob, 'size' | 'text'>): Promise<ArticleLibrary> {
  if (!file.size || file.size > MAX_ARTICLE_BACKUP_BYTES) throw new Error('请选择不超过 20 MB 的文章库备份。');
  return parseArticleBackup(await file.text());
}

function transactionResult<T>(transaction: IDBTransaction, begin: (set: (result: T) => void, fail: (error: unknown) => void) => void): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    let result: T; let failure: unknown;
    const fail = (error: unknown) => { failure = error; try { transaction.abort(); } catch { reject(error); } };
    transaction.oncomplete = () => resolve(result);
    transaction.onabort = () => reject(failure ?? new ArticleStorageUnavailableError());
    transaction.onerror = () => { failure ??= new ArticleStorageUnavailableError(); };
    try { begin(value => { result = value; }, fail); } catch (error) { fail(error); }
  });
}

export class ArticleDatabase {
  constructor(private readonly connection: IDBDatabase) {}
  close(): void { this.connection.close(); }

  async readLibrary(): Promise<ArticleLibrary | null> {
    const tx = this.connection.transaction('library');
    const library = await transactionResult<ArticleLibrary | null>(tx, (set, fail) => {
      const request = tx.objectStore('library').get('current');
      request.onsuccess = () => { try { set(request.result === undefined ? null : parseArticleLibrary(request.result as unknown)); } catch (error) { fail(error); } };
    });
    if (library) await verifyContentHashes(library);
    return library;
  }

  async saveLibrary(raw: ArticleLibrary, expectedRevision: number | null): Promise<ArticleLibrary> {
    const next = parseArticleLibrary(raw);
    if (next.revision !== (expectedRevision === null ? 0 : expectedRevision + 1)) throw new Error('文章保存版本无效，请重新载入文章库。');
    await verifyContentHashes(next);
    return this.commit(next, expectedRevision);
  }

  /** The caller previews the imported counts and obtains explicit replacement confirmation. */
  async replaceFromBackup(raw: ArticleLibrary, expectedRevision: number | null, now = Date.now()): Promise<ArticleLibrary> {
    const imported = parseArticleLibrary(raw);
    await verifyContentHashes(imported);
    const next = parseArticleLibrary({ ...imported, revision: expectedRevision === null ? 0 : expectedRevision + 1, updatedAt: Math.max(now, imported.updatedAt) });
    return this.commit(next, expectedRevision);
  }

  private async commit(next: ArticleLibrary, expectedRevision: number | null): Promise<ArticleLibrary> {
    const tx = this.connection.transaction('library', 'readwrite');
    return transactionResult(tx, (set, fail) => {
      const store = tx.objectStore('library'); const request = store.get('current');
      request.onsuccess = () => {
        try {
          const existing = request.result === undefined ? null : parseArticleLibrary(request.result as unknown);
          if ((existing?.revision ?? null) !== expectedRevision) throw new ArticleStorageConflictError();
          if (existing && next.updatedAt < existing.updatedAt) throw new Error('文章保存时间早于现有记录，未覆盖原数据。');
          store.put(next, 'current'); set(next);
        } catch (error) { fail(error); }
      };
    });
  }
}

export function openArticleDatabase(name = ARTICLE_DATABASE_NAME, factory: IDBFactory | undefined = globalThis.indexedDB): Promise<ArticleDatabase> {
  if (!factory) return Promise.reject(new ArticleStorageUnavailableError());
  return new Promise((resolve, reject) => {
    let settled = false; const request = factory.open(name, 1);
    request.onupgradeneeded = () => request.result.createObjectStore('library');
    request.onerror = () => { settled = true; reject(new ArticleStorageUnavailableError()); };
    request.onblocked = () => { settled = true; reject(new ArticleStorageUnavailableError('文章库被旧页面占用，请关闭其他页面后重试。')); };
    request.onsuccess = () => {
      if (settled) { request.result.close(); return; }
      request.result.onversionchange = () => request.result.close(); resolve(new ArticleDatabase(request.result));
    };
  });
}

export { createArticleLibrary };
