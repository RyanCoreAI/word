import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import path from 'node:path';

/** Public release metadata is validated before deployment; private signing files are never read. */
export async function verifyAndroidAssets(publicRoot) {
  const metadataBytes = await readFile(path.join(publicRoot, 'downloads/word-android.json'));
  const release = JSON.parse(metadataBytes);
  assert.equal(release.applicationId, 'com.yanxai.word');
  assert.match(release.version, /^\d+\.\d+\.\d+$/);
  assert.ok(Number.isSafeInteger(release.versionCode) && release.versionCode > 0);
  assert.equal(release.minSdk, 24);
  assert.equal(release.browser, 'com.android.chrome');
  assert.equal(release.file, `word-android-${release.version}.apk`);
  assert.equal(release.url, `https://word.yanxai.com/downloads/${release.file}`);
  assert.match(release.sha256, /^[a-f0-9]{64}$/);
  assert.match(release.certificateSha256, /^(?:[A-F0-9]{2}:){31}[A-F0-9]{2}$/);
  const apk = await readFile(path.join(publicRoot, 'downloads', release.file));
  assert.equal(apk.length, release.bytes, 'APK size does not match its release metadata.');
  assert.ok(apk.length > 10_000 && apk.length < 25 * 1024 * 1024);
  assert.equal(apk.readUInt32LE(0), 0x04034b50, 'APK is not a ZIP package.');
  assert.equal(createHash('sha256').update(apk).digest('hex'), release.sha256, 'APK SHA-256 mismatch.');
  const associationBytes = await readFile(path.join(publicRoot, '.well-known/assetlinks.json'));
  assert.deepEqual(JSON.parse(associationBytes), [{
    relation: ['delegate_permission/common.handle_all_urls'],
    target: { namespace: 'android_app', package_name: release.applicationId, sha256_cert_fingerprints: [release.certificateSha256] },
  }], 'The website must associate only the actual Word release certificate.');
  return { release, metadataBytes, associationBytes };
}
