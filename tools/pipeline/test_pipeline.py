import csv
import json
from pathlib import Path
import sqlite3
import tempfile
import unittest
from unittest.mock import patch

import pipeline


class DictionaryPipelineTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory(prefix="word-dictionary-test-")
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

    def test_csv_quoting_source_fields_and_multiple_pronunciations_survive(self):
        translation = "n. 红色, 蓝色\\nvt. 测试（包含, 逗号）"
        connection = self.database([{"word": "record", "translation": translation,
                                     "phonetic": "'rekɒ:d; ri'kɒ:d", "tag": "cet4", "definition": "quoted, text"}])
        row = connection.execute("SELECT * FROM entry").fetchone()
        self.assertEqual(row["translation"], translation)
        self.assertEqual(row["definition"], "quoted, text")
        word = pipeline.word_record(row)
        self.assertEqual(word["translation"], translation.replace("\\n", "\n"))
        self.assertEqual(word["phonetic"], "'rekɒ:d; ri'kɒ:d")
        pipeline.check_word(word)

    def test_frequent_words_are_not_automatically_basic(self):
        connection = self.database([
            {"word": "important", "translation": "a. 重要的", "frq": "1", "tag": "zk"},
            {"word": "the", "translation": "art. 定冠词", "frq": "2"}])
        values = {row["word"]: (row["basic"], row["study"]) for row in connection.execute("SELECT * FROM entry")}
        self.assertEqual(values["important"], (0, 1))
        self.assertEqual(values["the"], (1, 1))

    def test_explicit_beginner_words_are_skipped_without_removing_useful_exam_words(self):
        basic = ["what", "can", "who", "get", "know", "say", "go", "would"]
        useful = ["invest", "cable", "legislation", "important", "achievement"]
        connection = self.database([
            {"word": word, "translation": "测试释义", "frq": str(index + 1), "tag": "cet4"}
            for index, word in enumerate(basic + useful)
        ])
        flags = {row["word"]: row["basic"] for row in connection.execute("SELECT * FROM entry")}
        self.assertTrue(all(flags[word] == 1 for word in basic))
        self.assertTrue(all(flags[word] == 0 for word in useful))
        self.assertEqual(connection.execute("SELECT count(*) FROM entry").fetchone()[0], len(basic + useful))

    def test_inflections_are_excluded_only_from_study_when_lemma_exists(self):
        connection = self.database([
            {"word": "abandon", "translation": "v. 放弃", "tag": "cet4"},
            {"word": "abandoned", "translation": "a. 被抛弃的", "tag": "cet4", "exchange": "0:abandon/1:dp"},
            {"word": "unlisted", "translation": "a. 未列出的", "tag": "cet4", "exchange": "0:missing"}])
        self.assertEqual(connection.execute("SELECT count(*) FROM entry").fetchone()[0], 3)
        self.assertEqual([row[0] for row in connection.execute("SELECT word FROM entry WHERE study=1 ORDER BY word")], ["abandon", "unlisted"])

    def test_full_dictionary_retains_capitals_phrases_and_missing_translation(self):
        connection = self.database([
            {"word": "London", "translation": "伦敦", "tag": "cet4"},
            {"word": "look up", "translation": "查阅", "frq": "7"},
            {"word": "unknown", "translation": "", "tag": "cet4"}])
        self.assertEqual(connection.execute("SELECT count(*) FROM entry").fetchone()[0], 3)
        self.assertEqual(connection.execute("SELECT count(*) FROM entry WHERE study=1").fetchone()[0], 0)
        self.assertEqual(pipeline.database_stats(connection)["missingTranslation"], 1)

    def test_frequency_ranking_uses_bnc_then_deterministic_word_order(self):
        connection = self.database([
            {"word": "zebra", "translation": "斑马", "frq": "10", "bnc": "2"},
            {"word": "apple", "translation": "苹果", "frq": "10", "bnc": "1"},
            {"word": "abacus", "translation": "算盘", "frq": "0", "bnc": "1"}])
        self.assertEqual([row[0] for row in connection.execute("SELECT word FROM entry ORDER BY rank")], ["apple", "zebra", "abacus"])

    def test_duplicate_id_aborts_instead_of_silently_dropping_source_rows(self):
        with self.assertRaises(sqlite3.IntegrityError):
            self.database([{"word": "apple"}, {"word": "apple"}])

    def test_package_integrity_rejects_tampering_and_directory_escape(self):
        word = {"id": "apple", "word": "apple", "translation": "苹果", "phonetic": "",
                "tags": ["cet4"], "rank": 1, "basic": False}
        version = self.directory / "fixture"
        version.mkdir()
        path = version / "study.json"
        path.write_bytes(pipeline.json_bytes([word]))
        item = pipeline.metadata(path, 1, "fixture")
        self.assertEqual(pipeline.checked_package(self.directory, item), [word])
        path.write_bytes(b"[]")
        with self.assertRaisesRegex(ValueError, "checksum/size"):
            pipeline.checked_package(self.directory, item)
        item["file"] = "../outside.json"
        with self.assertRaisesRegex(ValueError, "escapes"):
            pipeline.checked_package(self.directory, item)

    def test_failed_new_build_preserves_previous_manifest_and_database(self):
        public = self.directory / "public"
        data = self.directory / "data"
        public.mkdir()
        data.mkdir()
        manifest = public / "manifest.json"
        old_manifest = b'{"version":"previous-valid-build"}'
        manifest.write_bytes(old_manifest)
        old_db = data / "ecdict.sqlite"
        with sqlite3.connect(str(old_db)) as connection:
            connection.execute("CREATE TABLE preserved (word TEXT)")
            connection.execute("INSERT INTO preserved VALUES ('apple')")
        connection.close()
        old_hash = pipeline.digest(old_db)
        malformed = data / "malformed.csv"
        malformed.write_text("wrong,header\n", encoding="utf-8")
        license_path = data / "LICENSE"
        license_path.write_text("MIT License", encoding="utf-8")
        with patch.object(pipeline, "PUBLIC", public), patch.object(pipeline, "DATA", data), \
                patch.object(pipeline, "fetch", return_value=(malformed, license_path)):
            with self.assertRaisesRegex(ValueError, "Unexpected CSV schema"):
                pipeline.build()
        self.assertEqual(manifest.read_bytes(), old_manifest)
        self.assertEqual(pipeline.digest(old_db), old_hash)


if __name__ == "__main__":
    unittest.main()
