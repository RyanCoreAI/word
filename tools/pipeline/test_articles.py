import csv
import json
from pathlib import Path
import sqlite3
import tempfile
import unittest

import articles
import pipeline


class ArticleDictionaryTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory(prefix="word-reading-dictionary-")
        self.addCleanup(self.temporary.cleanup)
        self.directory = Path(self.temporary.name)

    def database(self, entries):
        source = self.directory / "fixture.csv"
        with source.open("w", encoding="utf-8", newline="") as output:
            writer = csv.DictWriter(output, fieldnames=pipeline.FIELDS)
            writer.writeheader()
            for entry in entries:
                row = dict.fromkeys(pipeline.FIELDS, "")
                row.update(entry)
                writer.writerow(row)
        path = self.directory / "fixture.sqlite"
        pipeline.make_database(source, path)
        connection = sqlite3.connect(str(path))
        connection.row_factory = sqlite3.Row
        self.addCleanup(connection.close)
        return connection

    def test_reading_policy_keeps_basics_and_frequent_real_inflections(self):
        connection = self.database([
            {"word": "the", "translation": "art. 定冠词"},
            {"word": "study", "translation": "v. 学习", "tag": "cet4"},
            {"word": "studies", "translation": "学习", "exchange": "0:study/1:s3", "bnc": "49999"},
            {"word": "London", "translation": "伦敦", "frq": "1"},
            {"word": "rare", "translation": "罕见", "frq": "50001"},
            {"word": "empty", "translation": "", "frq": "2"},
        ])
        self.assertEqual({row["word"] for row in articles.reading_rows(connection)}, {"the", "study", "studies"})

    def test_lemma_index_uses_both_exchange_directions_and_keeps_ambiguity(self):
        connection = self.database([
            {"word": "see", "translation": "看见", "exchange": "p:saw/d:seen/3:sees"},
            {"word": "saw", "translation": "锯子", "exchange": "0:see/1:p/i:sawing"},
            {"word": "seen", "translation": "看见"},
            {"word": "sees", "translation": "看见"},
            {"word": "sawing", "translation": "锯"},
            {"word": "axe", "translation": "斧头", "exchange": "s:axes"},
            {"word": "axis", "translation": "轴", "exchange": "s:axes"},
            {"word": "axes", "translation": "轴"},
        ])
        index = articles.lemma_index(connection, {"see", "saw", "axe", "axis"})
        self.assertEqual(index["saw"], ["see"])
        self.assertEqual(index["seen"], ["see"])
        self.assertEqual(index["sawing"], ["saw"])
        self.assertEqual(index["axes"], ["axe", "axis"])
        self.assertNotIn("saw", index["saw"])

    def test_no_guessed_forms_nonexistent_roots_or_multiword_morphology(self):
        connection = self.database([
            {"word": "replete", "translation": "充满的", "exchange": "r:more replete"},
            {"word": "unlisted", "translation": "未列出的", "exchange": "0:missing"},
            {"word": "study", "translation": "学习", "exchange": "s:studies"},
            {"word": "university", "translation": "大学"},
        ])
        self.assertEqual(articles.lemma_index(connection, {"replete", "study", "university"}), {})

    def test_reading_manifest_rejects_tampering_bad_roots_and_path_escape(self):
        destination = self.directory / pipeline.VERSION
        destination.mkdir()
        words = [{"id": "study", "word": "study", "translation": "学习", "phonetic": "", "tags": [], "rank": 1, "basic": False}]
        words_path = destination / "words.json"
        lemmas_path = destination / "lemmas.json"
        words_path.write_bytes(pipeline.json_bytes(words))
        lemmas_path.write_bytes(pipeline.json_bytes({"studies": ["study"]}))
        manifest = {"schema": 1, "version": pipeline.VERSION, "policy": articles.POLICY,
                    "source": {"commit": pipeline.COMMIT, "sha256": pipeline.SOURCE_SHA},
                    "words": pipeline.metadata(words_path, 1, pipeline.VERSION),
                    "lemmas": pipeline.metadata(lemmas_path, 1, pipeline.VERSION)}
        self.assertTrue(articles.verify_manifest(manifest, self.directory)["allChecksumsPassed"])
        lemmas_path.write_bytes(pipeline.json_bytes({"studies": ["absent"]}))
        with self.assertRaisesRegex(ValueError, "checksum/size"):
            articles.verify_manifest(manifest, self.directory)
        manifest["lemmas"] = pipeline.metadata(lemmas_path, 1, pipeline.VERSION)
        with self.assertRaisesRegex(ValueError, "lemma candidates"):
            articles.verify_manifest(manifest, self.directory)
        manifest["lemmas"]["file"] = "../outside.json"
        with self.assertRaisesRegex(ValueError, "escapes"):
            articles.verify_manifest(manifest, self.directory)


if __name__ == "__main__":
    unittest.main()
