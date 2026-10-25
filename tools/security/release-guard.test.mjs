import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm, symlink } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { assertPublicReleaseTree } from './release-guard.mjs';

async function fixture(t) {
  const tempRoot = path.resolve(os.tmpdir());
  const root = await mkdtemp(path.join(tempRoot, 'word-security-release-'));
  t.after(async () => {
    if (path.dirname(root) !== tempRoot || !path.basename(root).startsWith('word-security-release-')) throw new Error('Refusing to remove an unrelated test path.');
    await rm(root, { recursive: true, force: true });
  });
  return root;
}

test('allows the actual public asset categories, Android association and signed APK', async t => {
  const root = await fixture(t);
  for (const file of ['index.html', '_headers', '.nojekyll', '.well-known/assetlinks.json', 'downloads/word-android-1.0.0.apk', 'data/pack/words.json', 'asr/runtime/engine.mjs', 'asr/runtime/engine.wasm', 'images/check-in/01.png']) {
    await mkdir(path.dirname(path.join(root, file)), { recursive: true });
    await writeFile(path.join(root, file), 'PUBLIC QA FIXTURE');
  }
  assert.equal((await assertPublicReleaseTree(root)).files, 9);
});

for (const file of ['.env', 'data/.env.production', '.git/config', 'images/.signing/password.dpapi', 'downloads/word-release.p12', 'data/learning.sqlite', 'assets/app.js.map', 'data/word-backup-2026.json']) {
  test(`refuses publication of ${file} without reading its contents`, async t => {
    const root = await fixture(t);
    await mkdir(path.dirname(path.join(root, file)), { recursive: true });
    await writeFile(path.join(root, file), 'NOT A REAL SECRET OR USER RECORD');
    await assert.rejects(assertPublicReleaseTree(root), /Public release contains/);
  });
}

test('refuses directory links that could include files outside the public release', async t => {
  const parent = await fixture(t);
  const root = path.join(parent, 'public'); const privateDirectory = path.join(parent, 'outside');
  await mkdir(root); await mkdir(privateDirectory);
  await writeFile(path.join(privateDirectory, 'test-only.txt'), 'NOT USER DATA');
  await symlink(privateDirectory, path.join(root, 'images'), process.platform === 'win32' ? 'junction' : 'dir');
  await assert.rejects(assertPublicReleaseTree(root), /non-regular entry/);
});
