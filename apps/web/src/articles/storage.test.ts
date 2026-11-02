import 'fake-indexeddb/auto';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { addArticle, addArticleVocabulary, answerArticleVocabulary, createArticleLibrary, updateArticleOverride, updateArticlePosition, type ArticleLibrary } from '../../../../packages/core/src/article-library';
import { ArticleStorageConflictError, exportArticleBackup, MAX_ARTICLE_BACKUP_BYTES, MAX_TXT_FILE_BYTES, openArticleDatabase, parseArticleBackup, prepareArticle, readArticleBackupFile, readTxtFile, type ArticleDatabase } from './storage';

const databases: ArticleDatabase[] = []; let counter = 0;
async function open(name = `article-test-${counter++}`) { const db = await openArticleDatabase(name); databases.push(db); return db; }
afterEach(() => { databases.splice(0).forEach(db => db.close()); vi.restoreAllMocks(); });

async function sample(): Promise<ArticleLibrary> {
  const article = await prepareArticle({ title: 'Reading', text: 'Good reading takes practice.\n\nPractice helps us learn.', sourceFormat: 'txt', sourceUrl: 'https://example.com/reading' }, 2);
  let library = addArticle(createArticleLibrary(1), article, 2);
  library = updateArticlePosition(library, article.id, 1, 3);
  library = updateArticleOverride(library, article.id, 'reading', 'unknown', 4);
  library = addArticleVocabulary(library, { articleId: article.id, tokenKey: 'practice', word: { id: 'practice', word: 'practice', translation: 'n. 练习', phonetic: '', tags: [], rank: 3, basic: false }, sentence: 'Good reading takes practice.', paragraphIndex: 0, occurrences: 2 }, 5);
  return answerArticleVocabulary(library, library.vocabulary[0]!.id, 'unknown', 6);
}

describe('article file and backup input', () => {
  it('accepts valid UTF-8 text with BOM and rejects wrong extensions, oversized data, invalid UTF-8 or binary content', async () => {
    const bytes = new TextEncoder().encode('\uFEFFEnglish text.\r\n\r\nAnother paragraph.');
    const file = { name: 'article.TXT', size: bytes.byteLength, arrayBuffer: async () => bytes.buffer };
    expect(await readTxtFile(file)).toBe('English text.\n\nAnother paragraph.');
    await expect(readTxtFile({ ...file, name: 'article.pdf' })).rejects.toThrow(/txt/);
    const arrayBuffer = vi.fn();
    await expect(readTxtFile({ ...file, size: MAX_TXT_FILE_BYTES + 1, arrayBuffer })).rejects.toThrow(/MB/);
    expect(arrayBuffer).not.toHaveBeenCalled();
    await expect(readTxtFile({ ...file, size: 2, arrayBuffer: async () => new Uint8Array([0xff, 0xff]).buffer })).rejects.toThrow(/UTF-8/);
    await expect(readTxtFile({ ...file, arrayBuffer: async () => new TextEncoder().encode('English\u0000text').buffer })).rejects.toThrow(/乱码/);
  });

  it('normalizes before hashing, deduplicates and rejects unsafe source URLs', async () => {
    const first = await prepareArticle({ title: '', text: '\uFEFFEnglish article.\r\n\r\nRead it. ', sourceFormat: 'paste' }, 1);
    const second = await prepareArticle({ title: 'Changed title', text: 'English article.\n\nRead it.', sourceFormat: 'txt' }, 2);
    expect(first.contentHash).toBe(second.contentHash);
    expect(first.title).toBe('English article.');
    await expect(prepareArticle({ title: 'Bad', text: 'English article.', sourceFormat: 'paste', sourceUrl: 'javascript:alert(1)' }, 1)).rejects.toThrow();
    await expect(prepareArticle({ title: 'Bad', text: 'English article.', sourceFormat: 'paste', sourceUrl: 'https://name:secret@example.com/' }, 1)).rejects.toThrow();
  });

  it('round-trips the complete article library and rejects forged text hashes, book backups and invalid references', async () => {
    const library = await sample();
    const backup = exportArticleBackup(library, 7);
    expect(await parseArticleBackup(backup)).toEqual(library);
    const altered = JSON.parse(backup) as { library: ArticleLibrary };
    altered.library.articles[0]!.text += ' Secret alteration.';
    await expect(parseArticleBackup(JSON.stringify(altered))).rejects.toThrow(/校验值/);
    await expect(parseArticleBackup(JSON.stringify({ format: 'yanxai-word-backup', version: 1, exportedAt: 7, state: library }))).rejects.toThrow();
    await expect(parseArticleBackup(JSON.stringify({ format: 'yanxai-article-library-backup', version: 1, exportedAt: 7, library: { ...library, articles: [] } }))).rejects.toThrow();
    const text = vi.fn();
    await expect(readArticleBackupFile({ size: MAX_ARTICLE_BACKUP_BYTES + 1, text })).rejects.toThrow(/MB/);
    expect(text).not.toHaveBeenCalled();
  });
});

describe('atomic independent article database', () => {
  it('restores article text, contextual flags, reading position, vocabulary and review counters after reopen', async () => {
    const name = `article-reopen-${counter++}`; const db = await open(name);
    const empty = createArticleLibrary(1); await db.saveLibrary(empty, null);
    const sampleLibrary = await sample();
    const next = await db.replaceFromBackup(sampleLibrary, 0, 10);
    db.close();
    const reopened = await open(name);
    expect(await reopened.readLibrary()).toEqual(next);
    expect(next.revision).toBe(1);
    expect(next.articles[0]!.readParagraph).toBe(1);
    expect(next.vocabulary[0]!.progress.wrongCount).toBe(1);
  });

  it('serializes simultaneous tab mutations and stale restores instead of silently losing data', async () => {
    const name = `article-cas-${counter++}`; const first = await open(name); const second = await open(name);
    const empty = createArticleLibrary(1); await first.saveLibrary(empty, null);
    const article = await prepareArticle({ title: 'One', text: 'One English article.', sourceFormat: 'paste' }, 2);
    const other = await prepareArticle({ title: 'Two', text: 'Another English article.', sourceFormat: 'paste' }, 2);
    const results = await Promise.allSettled([first.saveLibrary(addArticle(empty, article, 2), 0), second.saveLibrary(addArticle(empty, other, 2), 0)]);
    expect(results.filter(result => result.status === 'fulfilled')).toHaveLength(1);
    const failed = results.find(result => result.status === 'rejected');
    expect(failed?.status === 'rejected' && failed.reason).toBeInstanceOf(ArticleStorageConflictError);
    await expect(first.replaceFromBackup(empty, 0, 3)).rejects.toBeInstanceOf(ArticleStorageConflictError);
    expect((await first.readLibrary())?.articles).toHaveLength(1);
    const restored = await first.replaceFromBackup(empty, 1, 4);
    expect(restored.revision).toBe(2);
    expect(restored.articles).toEqual([]);
  });

  it('keeps malformed stored data untouched and refuses unavailable storage', async () => {
    const name = `article-corrupt-${counter++}`; const db = await open(name);
    const connection = await new Promise<IDBDatabase>(resolve => { const request = indexedDB.open(name); request.onsuccess = () => resolve(request.result); });
    await new Promise<void>(resolve => { const tx = connection.transaction('library', 'readwrite'); tx.objectStore('library').put({ corrupt: true }, 'current'); tx.oncomplete = () => resolve(); });
    await expect(db.readLibrary()).rejects.toThrow();
    await expect(db.saveLibrary(createArticleLibrary(1), null)).rejects.toThrow();
    const raw = await new Promise<unknown>(resolve => { const request = connection.transaction('library').objectStore('library').get('current'); request.onsuccess = () => resolve(request.result as unknown); });
    expect(raw).toEqual({ corrupt: true });
    connection.close();
    await expect(openArticleDatabase('unavailable', null as unknown as IDBFactory)).rejects.toThrow(/存储/);
  });

  it('rolls back a failed write and preserves the last saved library', async () => {
    const db = await open(); const empty = createArticleLibrary(1);
    await db.saveLibrary(empty, null);
    const article = await prepareArticle({ title: 'Reading', text: 'One English article.', sourceFormat: 'paste' }, 2);
    vi.spyOn(IDBObjectStore.prototype, 'put').mockImplementationOnce(() => { throw new DOMException('Storage quota exceeded', 'QuotaExceededError'); });
    await expect(db.saveLibrary(addArticle(empty, article, 2), 0)).rejects.toThrow();
    expect(await db.readLibrary()).toEqual(empty);
  });
});
