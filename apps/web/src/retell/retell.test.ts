import 'fake-indexeddb/auto';
import { describe, expect, it } from 'vitest';
import { lessons, lessonWordCount } from './lessons';
import { passageChunks } from './narrator';
import { exportAttemptText, parseAttempt, readAttempts, saveAttempt, type RetellAttempt } from './storage';

const attempt = (time: number): RetellAttempt => ({ lessonId: 'shorter-week', lessonVersion: 'test-v1', transcript: 'A shorter week can work, but it needs careful planning.', durationMs: 12000, completedAt: time, audioBlob: new Blob([new Uint8Array([1,2,3])], { type: 'audio/webm' }) });
describe('real retelling content and local records', () => {
  it('ships complete distinct lessons with two references and checkable sources', () => {
    expect(new Set(lessons.map(lesson => lesson.id)).size).toBe(lessons.length);
    for (const lesson of lessons) {
      expect(lessonWordCount(lesson)).toBeGreaterThanOrEqual(120); expect(lessonWordCount(lesson)).toBeLessThanOrEqual(190);
      expect(lesson.references[0]).not.toBe(lesson.references[1]); expect(lesson.sources.every(source => new URL(source.url).protocol === 'https:')).toBe(true);
    }
  });
  it('keeps all source words in bounded local-voice chunks', () => {
    for (const lesson of lessons) { const text = lesson.paragraphs.join(' '); const chunks = passageChunks(text); expect(chunks.every(chunk => chunk.length > 0 && chunk.length <= 280)).toBe(true); expect(chunks.join(' ')).toBe(text); }
  });
  it('stores real blobs separately from vocabulary progress and prevents stale overwrites', async () => {
    await saveAttempt(attempt(20)); expect((await readAttempts())[0]?.transcript).toBe(attempt(20).transcript);
    await expect(saveAttempt(attempt(10))).rejects.toThrow('另一窗口'); expect((await readAttempts())[0]?.completedAt).toBe(20);
    await saveAttempt(attempt(30)); const rows = await readAttempts(); expect(rows).toHaveLength(1); expect(rows[0]?.completedAt).toBe(30);
    const exported = JSON.parse(exportAttemptText(rows)); expect(exported.attempts[0].audioBlob).toBeUndefined(); expect(exported.attempts[0].transcript).toBe(attempt(30).transcript);
  });
  it('rejects damaged or implausible recordings without deleting prior records', async () => {
    expect(() => parseAttempt({ ...attempt(40), transcript: '' })).toThrow(); expect(() => parseAttempt({ ...attempt(40), audioBlob: new Blob([], { type: 'audio/webm' }) })).toThrow();
    expect(() => parseAttempt({ ...attempt(40), durationMs: 180001 })).toThrow(); expect((await readAttempts())[0]?.completedAt).toBe(30);
  });
});
