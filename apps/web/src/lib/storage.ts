import { z } from 'zod';
import { MAX_BACKUP_BYTES, parseAppState, wordSchema, type AppState, type Word } from '../../../../packages/core/src';

export { MAX_BACKUP_BYTES };
export const DATABASE_NAME = 'yanxai-word-v1';

export class StorageConflictError extends Error {
  constructor() { super('revision conflict: 进度已在另一个页面更新，请重新载入后继续。'); this.name = 'StorageConflictError'; }
}

export class StorageUnavailableError extends Error {
  constructor(message = 'storage unavailable: 无法保存到本机数据库，请检查浏览器存储权限。') { super(message); this.name = 'StorageUnavailableError'; }
}

export interface ChunkReceipt { version: string; id: string; sha256: string; count: number }
export type DictionaryEntry = Word;
const receiptSchema = z.object({
  version: z.string().min(1).max(200), id: z.string().min(1).max(200),
  sha256: z.string().regex(/^[a-f0-9]{64}$/), count: z.number().int().positive().max(100_000),
}).strict();
export const dictionaryEntrySchema = wordSchema;
const storedEntrySchema = dictionaryEntrySchema.extend({ version: z.string().min(1).max(200), normalized: z.string().min(1).max(500) }).strict();
const backupSchema = z.object({ format: z.literal('yanxai-word-backup'), version: z.literal(1), exportedAt: z.number().int().nonnegative(), state: z.unknown() }).strict();

export function exportBackup(state: AppState, words: readonly Word[], dictionaryVersion: string, now = Date.now()): string {
  const checked = parseAppState(state, words, dictionaryVersion);
  const text = JSON.stringify({ format: 'yanxai-word-backup', version: 1, exportedAt: now, state: checked });
  if (new TextEncoder().encode(text).byteLength > MAX_BACKUP_BYTES) throw new Error('backup validation: 备份文件超过 16 MB 上限。');
  return text;
}

export function parseBackup(text: string, words: readonly Word[], dictionaryVersion: string): AppState {
  if (text.length > MAX_BACKUP_BYTES || new TextEncoder().encode(text).byteLength > MAX_BACKUP_BYTES) throw new Error('backup validation: 备份文件超过 16 MB 上限。');
  const envelope = backupSchema.parse(JSON.parse(text) as unknown);
  return parseAppState(envelope.state, words, dictionaryVersion);
}

export async function readBackupFile(file: Pick<Blob, 'size' | 'text'>, words: readonly Word[], dictionaryVersion: string): Promise<AppState> {
  if (file.size > MAX_BACKUP_BYTES) throw new Error('backup validation: 备份文件超过 16 MB 上限。');
  return parseBackup(await file.text(), words, dictionaryVersion);
}

function transactionResult<T>(transaction: IDBTransaction, begin: (set: (result: T) => void, fail: (error: unknown) => void) => void): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    let result: T;
    let failure: unknown;
    const fail = (error: unknown) => { failure = error; try { transaction.abort(); } catch { reject(error); } };
    transaction.oncomplete = () => resolve(result);
    transaction.onabort = () => reject(failure ?? transaction.error ?? new StorageUnavailableError());
    transaction.onerror = () => { failure ??= transaction.error; };
    try { begin(value => { result = value; }, fail); } catch (error) { fail(error); }
  });
}

export class WordDatabase {
  constructor(private readonly connection: IDBDatabase) {}
  close(): void { this.connection.close(); }

  async readRawState(): Promise<unknown> {
    const tx = this.connection.transaction('state', 'readonly');
    return transactionResult(tx, set => {
      const request = tx.objectStore('state').get('current');
      request.onsuccess = () => set(request.result as unknown);
    });
  }

  async readState(words: readonly Word[], dictionaryVersion: string): Promise<AppState | null> {
    const tx = this.connection.transaction('state', 'readonly');
    return transactionResult(tx, (set, fail) => {
      const request = tx.objectStore('state').get('current');
      request.onsuccess = () => {
        try { set(request.result === undefined ? null : parseAppState(request.result as unknown, words, dictionaryVersion)); } catch (error) { fail(error); }
      };
    });
  }

  async saveState(next: AppState, expectedRevision: number | null, words: readonly Word[], dictionaryVersion: string): Promise<AppState> {
    const checked = parseAppState(next, words, dictionaryVersion);
    if (checked.revision !== (expectedRevision === null ? 0 : expectedRevision + 1)) throw new Error('invalid revision: 保存版本无效，请重新载入进度。');
    return this.commitState(checked, expectedRevision, words, dictionaryVersion);
  }

  /** The UI must obtain confirmation before this atomic replacement. */
  async replaceStateFromBackup(imported: AppState, expectedRevision: number | null, words: readonly Word[], dictionaryVersion: string, now = Date.now()): Promise<AppState> {
    const checked = parseAppState(imported, words, dictionaryVersion);
    const next = parseAppState({ ...checked, revision: expectedRevision === null ? 0 : expectedRevision + 1, updatedAt: now }, words, dictionaryVersion);
    return this.commitState(next, expectedRevision, words, dictionaryVersion);
  }

  /** Explicit recovery only: caller exports the raw snapshot and confirms replacement first. */
  async recoverCorruptState(imported: AppState, expectedRawSnapshot: string, words: readonly Word[], dictionaryVersion: string, now = Date.now()): Promise<AppState> {
    const checked = parseAppState(imported, words, dictionaryVersion);
    if (!expectedRawSnapshot || !Number.isSafeInteger(now) || now < 0) throw new Error('Invalid recovery snapshot');
    const tx = this.connection.transaction(['state', 'cache'], 'readwrite');
    return transactionResult(tx, (set, fail) => {
      const store = tx.objectStore('state');
      const request = store.get('current');
      request.onsuccess = () => {
        try {
          const raw: unknown = request.result;
          if (raw === undefined || JSON.stringify(raw) !== expectedRawSnapshot) throw new StorageConflictError();
          const rawVersion = z.object({ dictionaryVersion: z.string() }).safeParse(raw);
          if (rawVersion.success && rawVersion.data.dictionaryVersion !== dictionaryVersion) throw new Error('dictionary version mismatch: 恢复不能覆盖另一版本的学习记录。');
          let corrupt = false;
          try { parseAppState(raw, words, dictionaryVersion); } catch { corrupt = true; }
          if (!corrupt) throw new Error('Invalid recovery: 当前进度可正常读取，请使用普通备份恢复。');
          const rawRevision = z.object({ revision: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER - 1) }).safeParse(raw);
          const revision = Math.max(now, checked.revision, rawRevision.success ? rawRevision.data.revision : 0) + 1;
          const restored = parseAppState({ ...checked, revision, updatedAt: now }, words, dictionaryVersion);
          tx.objectStore('cache').put(raw, `recovery:${revision}`);
          store.put(restored, 'current');
          set(restored);
        } catch (error) { fail(error); }
      };
    });
  }

  private commitState(next: AppState, expectedRevision: number | null, words: readonly Word[], dictionaryVersion: string): Promise<AppState> {
    const tx = this.connection.transaction('state', 'readwrite');
    return transactionResult(tx, (set, fail) => {
      const store = tx.objectStore('state');
      const current = store.get('current');
      current.onsuccess = () => {
        try {
          const existing = current.result === undefined ? null : parseAppState(current.result as unknown, words, dictionaryVersion);
          if ((existing?.revision ?? null) !== expectedRevision) throw new StorageConflictError();
          store.put(next, 'current'); set(next);
        } catch (error) { fail(error); }
      };
    });
  }

  async readStudyCache(): Promise<unknown> {
    const tx = this.connection.transaction('cache', 'readonly');
    return transactionResult(tx, set => {
      const request = tx.objectStore('cache').get('study');
      request.onsuccess = () => set(request.result as unknown);
    });
  }

  /** Cache updates may not silently strand an existing learning state on another dictionary version. */
  async saveStudyCache(value: unknown, version: string): Promise<void> {
    const tx = this.connection.transaction(['cache', 'state'], 'readwrite');
    return transactionResult(tx, (set, fail) => {
      const request = tx.objectStore('state').get('current');
      request.onsuccess = () => {
        try {
          if (request.result !== undefined) {
            const storedVersion = z.object({ dictionaryVersion: z.string() }).parse(request.result as unknown).dictionaryVersion;
            if (storedVersion !== version) throw new Error('dictionary version mismatch: 已有学习进度属于另一词库版本。');
          }
          tx.objectStore('cache').put(value, 'study'); set(undefined);
        } catch (error) { fail(error); }
      };
    });
  }

  async getChunkReceipts(version: string): Promise<ChunkReceipt[]> {
    const tx = this.connection.transaction('chunks', 'readonly');
    return transactionResult(tx, (set, fail) => {
      const request = tx.objectStore('chunks').index('version').getAll(version);
      request.onsuccess = () => { try { set(z.array(receiptSchema).parse(request.result as unknown)); } catch (error) { fail(error); } };
    });
  }

  async importDictionaryChunk(receipt: ChunkReceipt, entries: readonly DictionaryEntry[]): Promise<void> {
    const checked = receiptSchema.parse(receipt);
    if (entries.length !== checked.count || new Set(entries.map(entry => entry.id)).size !== entries.length) throw new Error('dictionary validation: 分片条数不匹配或存在重复词条。');
    const rows = z.array(dictionaryEntrySchema).max(100_000).parse(entries);
    const tx = this.connection.transaction(['dictionary', 'chunks'], 'readwrite');
    return transactionResult(tx, (set, fail) => {
      const chunks = tx.objectStore('chunks');
      const request = chunks.get([checked.version, checked.id]);
      request.onsuccess = () => {
        try {
          if (request.result !== undefined) {
            const previous = receiptSchema.parse(request.result as unknown);
            if (previous.sha256 !== checked.sha256 || previous.count !== checked.count) throw new Error('dictionary version mismatch: 同版本分片内容已变化。');
            set(undefined); return;
          }
          const store = tx.objectStore('dictionary');
          for (const row of rows) store.add({ ...row, version: checked.version, normalized: row.word.toLowerCase() });
          chunks.add(checked); set(undefined);
        } catch (error) { fail(error); }
      };
    });
  }

  async searchDictionary(version: string, prefix: string, limit = 30): Promise<DictionaryEntry[]> {
    const normalized = prefix.trim().toLowerCase();
    if (!normalized || normalized.length > 300) return [];
    const boundedLimit = Math.max(1, Math.min(100, Math.trunc(limit) || 30));
    const tx = this.connection.transaction('dictionary', 'readonly');
    return transactionResult(tx, (set, fail) => {
      const request = tx.objectStore('dictionary').index('prefix').getAll(IDBKeyRange.bound([version, normalized], [version, `${normalized}\uffff`]), boundedLimit);
      request.onsuccess = () => {
        try {
          const rows = z.array(storedEntrySchema).parse(request.result as unknown);
          set(rows.map(row => ({ id: row.id, word: row.word, translation: row.translation, phonetic: row.phonetic, tags: row.tags, rank: row.rank, basic: row.basic })));
        } catch (error) { fail(error); }
      };
    });
  }
}

export function openWordDatabase(name = DATABASE_NAME, factory: IDBFactory | undefined = globalThis.indexedDB): Promise<WordDatabase> {
  if (!factory) return Promise.reject(new StorageUnavailableError('indexedDB unavailable: 此浏览器不支持本机数据库，学习记录无法保存。'));
  return new Promise((resolve, reject) => {
    let settled = false;
    const request = factory.open(name, 1);
    request.onupgradeneeded = () => {
      const db = request.result;
      db.createObjectStore('state'); db.createObjectStore('cache');
      const dictionary = db.createObjectStore('dictionary', { keyPath: ['version', 'id'] });
      dictionary.createIndex('prefix', ['version', 'normalized']);
      const chunks = db.createObjectStore('chunks', { keyPath: ['version', 'id'] }); chunks.createIndex('version', 'version');
    };
    request.onerror = () => { settled = true; reject(request.error ?? new StorageUnavailableError()); };
    request.onblocked = () => { settled = true; reject(new StorageUnavailableError('storage blocked: 请关闭其他学习页面后重试。')); };
    request.onsuccess = () => {
      if (settled) { request.result.close(); return; }
      request.result.onversionchange = () => request.result.close(); resolve(new WordDatabase(request.result));
    };
  });
}
