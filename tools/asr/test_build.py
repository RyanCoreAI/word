"""Small deterministic integrity tests; these fixtures are not recognition proof."""
import hashlib
import json
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch
import build


class AsrPackageTests(unittest.TestCase):
    def setUp(self):
        self.directory = tempfile.TemporaryDirectory()
        self.root = Path(self.directory.name)
        self.version = 'whisper-tiny-en-' + 'a' * 20
        self.data = b'test-only-static-asset'
        self.file = f'{self.version}/chunks/{build.digest(self.data)}-000.bin'
        target = self.root / self.file
        target.parent.mkdir(parents=True)
        target.write_bytes(self.data)
        self.manifest = {'version': self.version, 'modelId': build.MODEL, 'revision': build.REVISION, 'license': 'Apache-2.0', 'totalBytes': len(self.data), 'assets': [{'path': 'model/config.json', 'bytes': len(self.data), 'sha256': build.digest(self.data), 'parts': [{'file': self.file, 'bytes': len(self.data), 'sha256': build.digest(self.data)}]}]}
        self.public_patch = patch.object(build, 'PUBLIC', self.root)
        self.cache_patch = patch.object(build, 'CACHE', self.root / 'cache')
        self.public_patch.start()
        self.cache_patch.start()

    def tearDown(self):
        self.public_patch.stop()
        self.cache_patch.stop()
        self.directory.cleanup()

    def verify(self):
        (self.root / 'manifest.json').write_text(json.dumps(self.manifest), encoding='utf8')
        return build.verify()

    def test_verifies_parts_and_complete_asset(self):
        result = self.verify()
        self.assertEqual(result['assetsVerified'], 1)
        self.assertLessEqual(result['maximumUploadBytes'], 8 * 1024 * 1024)

    def test_rejects_changed_part(self):
        (self.root / self.file).write_bytes(b'corrupt')
        with self.assertRaisesRegex(ValueError, 'part validation'):
            self.verify()

    def test_rejects_changed_assembled_hash(self):
        self.manifest['assets'][0]['sha256'] = '0' * 64
        with self.assertRaisesRegex(ValueError, 'assembled'):
            self.verify()

    def test_rejects_traversal_and_wrong_version_parts(self):
        for file in ['../escape', '/absolute', 'whisper-tiny-en-' + 'b' * 20 + '/chunks/' + 'a' * 64 + '-000.bin']:
            self.manifest['assets'][0]['parts'][0]['file'] = file
            with self.assertRaisesRegex(ValueError, 'part path'):
                self.verify()

    def test_rejects_total_or_source_changes(self):
        self.manifest['totalBytes'] += 1
        with self.assertRaisesRegex(ValueError, 'totals'):
            self.verify()
        self.manifest['totalBytes'] -= 1
        self.manifest['revision'] = 'b' * 40
        with self.assertRaisesRegex(ValueError, 'source identity'):
            self.verify()

    def test_acquires_and_verifies_pinned_lfs_before_caching(self):
        entry = {'size': len(self.data), 'lfs': {'sha256': build.digest(self.data)}}
        with patch.object(build, 'download', return_value=self.data) as download:
            self.assertEqual(build.acquire('onnx/encoder.onnx', entry), self.data)
            self.assertIn(build.REVISION, download.call_args.args[0])
            self.assertEqual(build.acquire('onnx/encoder.onnx', entry), self.data)
            self.assertEqual(download.call_count, 1)
        with self.assertRaisesRegex(ValueError, 'LFS checksum'):
            build.acquire('onnx/encoder.onnx', {**entry, 'lfs': {'sha256': '0' * 64}})

    def test_verifies_git_blob_sha1_for_non_lfs_files(self):
        blob = hashlib.sha1(f'blob {len(self.data)}\0'.encode() + self.data).hexdigest()
        with patch.object(build, 'download', return_value=self.data):
            self.assertEqual(build.acquire('config.json', {'size': len(self.data), 'blobId': blob}), self.data)
        with self.assertRaisesRegex(ValueError, 'Git blob'):
            build.acquire('config.json', {'size': len(self.data), 'blobId': '0' * 40})


if __name__ == '__main__':
    unittest.main()
