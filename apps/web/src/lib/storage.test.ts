import 'fake-indexeddb/auto';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { answer, createInitialState, ensureSession, getCurrentToken, updateSettings, type Word } from '../../../../packages/core/src';
import { MAX_BACKUP_BYTES, exportBackup, openWordDatabase, parseBackup, readBackupFile, StorageConflictError, type WordDatabase } from './storage';

const words: Word[] = ['abandon', 'ability', 'accurate'].map((word, rank) => ({ id: word, word, translation: 'n. 测试词义', phonetic: '', tags: ['cet4'], rank, basic: false }));
const databases: WordDatabase[] = [];
let databaseCounter = 0;
async function open(name = `storage-test-${databaseCounter++}`) { const db = await openWordDatabase(name); databases.push(db); return db; }
async function putRaw(name: string, value: unknown) {
  const connection = await new Promise<IDBDatabase>((resolve, reject) => { const request = indexedDB.open(name); request.onsuccess = () => resolve(request.result); request.onerror = () => reject(request.error); });
  await new Promise<void>((resolve, reject) => {
    const tx = connection.transaction('state', 'readwrite'); tx.objectStore('state').put(value, 'current');
    tx.oncomplete = () => resolve(); tx.onabort = () => reject(tx.error);
  });
  connection.close();
}
afterEach(() => { for (const db of databases.splice(0)) db.close(); vi.restoreAllMocks(); });

describe('durable learning state', () => {
  it('restores the revealed current word, queue, counters, settings and undo history', async () => {
    const name = `state-${databaseCounter++}`;
    const db = await open(name);
    const initial = createInitialState('v1', 1);
    await db.saveState(initial, null, words, 'v1');
    const active = ensureSession(initial, words, 'look', 2);
    await db.saveState(active, 0, words, 'v1');
    const revealed = answer(active, 'look', 'unknown', getCurrentToken(active, 'look'), 3);
    await db.saveState(revealed, 1, words, 'v1');
    db.close();
    const reopened = await open(name);
    expect(await reopened.readState(words, 'v1')).toEqual(revealed);
    expect(parseBackup(exportBackup(revealed, words, 'v1', 4), words, 'v1')).toEqual(revealed);
  });

  it('serializes concurrent tabs with revision CAS instead of losing an answer', async () => {
    const name = `cas-${databaseCounter++}`;
    const first = await open(name); const second = await open(name);
    const initial = createInitialState('v1', 1);
    await first.saveState(initial, null, words, 'v1');
    const changes = [ensureSession(initial, words, 'look', 2), updateSettings(initial, { rate: 1.2 }, 3)];
    const results = await Promise.allSettled([first.saveState(changes[0]!, 0, words, 'v1'), second.saveState(changes[1]!, 0, words, 'v1')]);
    expect(results.filter(result => result.status === 'fulfilled')).toHaveLength(1);
    const failed = results.find(result => result.status === 'rejected');
    expect(failed?.status === 'rejected' && failed.reason).toBeInstanceOf(StorageConflictError);
    expect((await first.readState(words, 'v1'))?.revision).toBe(1);
  });

  it('rejects incompatible backups and stale restores without replacing progress', async () => {
    const db = await open();
    const initial = createInitialState('v1', 1);
    await db.saveState(initial, null, words, 'v1');
    const next = ensureSession(initial, words, 'look', 2);
    await db.saveState(next, 0, words, 'v1');
    await expect(db.replaceStateFromBackup(initial, 0, words, 'v1')).rejects.toBeInstanceOf(StorageConflictError);
    await expect(db.replaceStateFromBackup({ ...initial, dictionaryVersion: 'v2' }, 1, words, 'v1')).rejects.toThrow();
    await expect(db.readState(words, 'v2')).rejects.toThrow();
    expect(await db.readState(words, 'v1')).toEqual(next);
    const restored = await db.replaceStateFromBackup(initial, 1, words, 'v1', 5);
    expect(restored.revision).toBe(2);
    expect(restored.modes.look.session).toBeNull();
  });

  it('validates backup size before reading an upload and rejects malformed shape', async () => {
    const text = vi.fn();
    await expect(readBackupFile({ size: MAX_BACKUP_BYTES + 1, text }, words, 'v1')).rejects.toThrow();
    expect(text).not.toHaveBeenCalled();
    expect(() => parseBackup('{"format":"yanxai-word-backup","version":1,"exportedAt":1,"state":{}}', words, 'v1')).toThrow();
  });

  it('does not change cached dictionary version beneath existing progress', async () => {
    const db = await open();
    await db.saveStudyCache({ marker: 'v1' }, 'v1');
    await db.saveState(createInitialState('v1', 1), null, words, 'v1');
    await expect(db.saveStudyCache({ marker: 'v2' }, 'v2')).rejects.toThrow(/version/);
    expect(await db.readStudyCache()).toEqual({ marker: 'v1' });
  });

  it('requires an exact raw snapshot and a valid backup to recover corrupted state', async () => {
    const name = `recovery-${databaseCounter++}`; const db = await open(name);
    const valid = createInitialState('v1', 1);
    const damaged = { ...valid, settings: { invalid: true } };
    await putRaw(name, damaged);
    await expect(db.readState(words, 'v1')).rejects.toThrow();
    const snapshot = JSON.stringify(await db.readRawState());
    await expect(db.recoverCorruptState(valid, '{}', words, 'v1', 10)).rejects.toBeInstanceOf(StorageConflictError);
    expect(await db.readRawState()).toEqual(damaged);
    const restored = await db.recoverCorruptState(valid, snapshot, words, 'v1', 10);
    expect(restored.revision).toBe(11);
    expect(await db.readState(words, 'v1')).toEqual(restored);
    await expect(db.recoverCorruptState(valid, JSON.stringify(restored), words, 'v1', 12)).rejects.toThrow(/recovery/);
    expect(await db.readState(words, 'v1')).toEqual(restored);
  });

  it('does not use corruption recovery to overwrite another dictionary version', async () => {
    const name = `recovery-version-${databaseCounter++}`; const db = await open(name);
    const raw = createInitialState('v0', 1); await putRaw(name, raw);
    await expect(db.recoverCorruptState(createInitialState('v1', 1), JSON.stringify(raw), words, 'v1', 10)).rejects.toThrow(/version/);
    expect(await db.readRawState()).toEqual(raw);
  });
});

describe('atomic full dictionary shards', () => {
  const receipt = { version: 'v1', id: 'shard-0', sha256: 'a'.repeat(64), count: 2 };
  it('commits once, searches by prefix and separates dictionary versions', async () => {
    const db = await open();
    await db.importDictionaryChunk(receipt, words.slice(0, 2));
    await db.importDictionaryChunk(receipt, words.slice(0, 2));
    expect(await db.getChunkReceipts('v1')).toEqual([receipt]);
    expect((await db.searchDictionary('v1', 'AB')).map(word => word.id)).toEqual(['abandon', 'ability']);
    expect(await db.searchDictionary('v2', 'ab')).toEqual([]);
  });

  it('rolls back the whole shard and completion marker on a duplicate key', async () => {
    const db = await open();
    await db.importDictionaryChunk({ ...receipt, count: 1 }, [words[0]!]);
    await expect(db.importDictionaryChunk({ ...receipt, id: 'shard-1' }, [words[1]!, words[0]!])).rejects.toThrow();
    expect(await db.searchDictionary('v1', 'abi')).toEqual([]);
    expect(await db.getChunkReceipts('v1')).toHaveLength(1);
  });

  it('preserves completed shards when a later shard runs out of space', async () => {
    const db = await open();
    await db.importDictionaryChunk({ ...receipt, count: 1 }, [words[0]!]);
    const original = IDBObjectStore.prototype.add;
    vi.spyOn(IDBObjectStore.prototype, 'add').mockImplementation(function (this: IDBObjectStore, value: unknown, key?: IDBValidKey) {
      if (this.name === 'dictionary') throw new DOMException('Quota exceeded', 'QuotaExceededError');
      return original.call(this, value, key);
    });
    await expect(db.importDictionaryChunk({ ...receipt, id: 'shard-1', count: 1 }, [words[1]!])).rejects.toMatchObject({ name: 'QuotaExceededError' });
    expect(await db.getChunkReceipts('v1')).toHaveLength(1);
    expect(await db.searchDictionary('v1', 'abi')).toEqual([]);
    expect(await db.searchDictionary('v1', 'aba')).toHaveLength(1);
  });
});
