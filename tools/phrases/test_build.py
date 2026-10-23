import copy
import gzip
import json
from pathlib import Path
import sqlite3
import tempfile
import unittest
from unittest.mock import patch

import build


def entry(word="take a break", meaning="休息一下", synonyms=None, **fields):
    result = {"word": word, "lang_code": "en", "pos": "verb",
              "senses": [{"id": "zh-test-en-verb-123", "glosses": [meaning]}]}
    if synonyms is not None:
        result["synonyms"] = synonyms
    result.update(fields)
    return result


class PhraseSelectionTests(unittest.TestCase):
    def test_single_sense_relation_keeps_shared_meaning_and_real_provenance(self):
        value = entry(synonyms=[{"word": "have a break", "tags": ["UK"]}])
        value["senses"][0]["tags"] = ["informal"]
        phrase = build.phrase_entry(value, "snapshot-1")
        sense = phrase["senses"][0]
        synonym = sense["substitutes"][0]
        self.assertEqual(synonym["text"], "have a break")
        self.assertEqual(synonym["meaning"], sense["meaning"])
        self.assertEqual(synonym["meaningBasis"], "shared-sense")
        self.assertEqual(synonym["relationBasis"], "single-source-sense")
        self.assertEqual(synonym["sourceUrl"], "https://zh.wiktionary.org/wiki/take_a_break")
        self.assertEqual(synonym["sourceId"], "snapshot-1")
        self.assertEqual(synonym["tags"], ["UK", "informal"])

    def test_qualified_synonym_matches_one_actual_chinese_sense(self):
        value = entry("test out", synonyms=[{"word": "try out", "sense": "進行，測試。"}])
        value["senses"] = [{"id": "sense-1", "glosses": ["進行測試"]},
                           {"id": "sense-2", "glosses": ["另一義項"]}]
        phrase = build.phrase_entry(value, "source")
        matched = next(s for s in phrase["senses"] if s["id"] == "sense-1")
        self.assertEqual(matched["substitutes"][0]["relationBasis"], "exact-source-sense")
        self.assertFalse(next(s for s in phrase["senses"] if s["id"] == "sense-2")["substitutes"])

    def test_multisense_unqualified_or_similar_translation_never_creates_relation(self):
        value = entry(synonyms=[{"word": "rest"}, {"word": "have a break", "sense": "稍微休息一下"}])
        value["senses"].append({"id": "different", "glosses": ["停止工作"]})
        self.assertTrue(all(not s["substitutes"] for s in build.phrase_entry(value, "s")["senses"]))

    def test_rejected_other_sense_does_not_make_source_single_sense(self):
        value = entry(synonyms=[{"word": "rest"}])
        value["senses"].append({"id": "old", "glosses": ["古義"], "tags": ["obsolete"]})
        self.assertFalse(build.phrase_entry(value, "s")["senses"][0]["substitutes"])

    def test_duplicate_sense_text_is_ambiguous(self):
        value = entry(synonyms=[{"word": "rest", "sense": "休息一下"}])
        value["senses"].append({"id": "duplicate", "glosses": ["休息一下"]})
        self.assertTrue(all(not s["substitutes"] for s in build.phrase_entry(value, "s")["senses"]))

    def test_inflections_old_vulgar_and_derogatory_material_is_excluded(self):
        for tag in ["form-of", "alt-of", "obsolete", "archaic", "rare", "vulgar", "derogatory", "offensive"]:
            with self.subTest(tag=tag):
                value = entry()
                value["senses"][0]["tags"] = [tag]
                self.assertIsNone(build.phrase_entry(value, "s"))
        for tag in ["古舊或過時", "英國棄用詞", "粗俗", "种族歧视", "旧"]:
            with self.subTest(raw_tag=tag):
                self.assertIsNone(build.phrase_entry(entry(raw_tags=[tag]), "s"))
        self.assertIsNone(build.phrase_entry(entry(pos="name"), "s"))
        self.assertIsNone(build.phrase_entry(entry("New York"), "s"))
        self.assertIsNone(build.phrase_entry(entry("testing out", senses=[{"id": "form", "glosses": ["測試的分詞"], "form_of": [{"word": "test out"}]}]), "s"))

    def test_invalid_or_unbounded_text_is_rejected_not_truncated(self):
        for word in ["one", "one two three four five six seven", "take-a-break", " take a break", "take  a break"]:
            self.assertIsNone(build.phrase_entry(entry(word), "s"))
        for meaning in ["Only English", "中" * 181, "中文\x00"]:
            self.assertIsNone(build.phrase_entry(entry(meaning=meaning), "s"))
        self.assertIsNone(build.phrase_entry(entry(senses=[{"glosses": ["沒有可追溯義項ID"]}]), "s"))

    def test_explicit_coarse_tokens_and_derivatives_are_excluded_without_substring_guesses(self):
        for phrase in ["eat shit", "fuck it", "for fuck's sake", "pissed off", "bullshit bingo", "pissing contest", "shit happens", "motherfucking test"]:
            with self.subTest(phrase=phrase):
                self.assertIsNone(build.phrase_entry(entry(phrase), "s"))
        for replacement in ["take a shit", "shoot the shit", "up shit creek", "fuck up", "piss off", "shittier", "fuckers"]:
            with self.subTest(replacement=replacement):
                phrase = build.phrase_entry(entry(synonyms=[{"word": replacement}, {"word": "rest"}]), "s")
                self.assertEqual([s["text"] for s in phrase["senses"][0]["substitutes"]], ["rest"])
        for ordinary in ["shiitake mushrooms", "pistachio shells", "fuchsia flowers"]:
            self.assertIsNotNone(build.phrase_entry(entry(ordinary), "s"))

    def test_source_internet_usage_is_excluded_at_entry_sense_and_synonym_levels(self):
        self.assertIsNone(build.phrase_entry(entry("because reasons", tags=["Internet"]), "s"))
        self.assertIsNone(build.phrase_entry(entry(raw_tags=["网络用语"]), "s"))
        self.assertIsNone(build.phrase_entry(entry(raw_tags=["網路俚語"]), "s"))
        source = entry()
        source["senses"][0]["tags"] = ["Internet"]
        self.assertIsNone(build.phrase_entry(source, "s"))
        mixed = entry(synonyms=[{"word": "have a break", "sense": "休息一下"}])
        mixed["senses"].append({"id": "internet-only", "glosses": ["僅網路義項"], "tags": ["Internet"]})
        kept = build.phrase_entry(mixed, "s")
        self.assertEqual(len(kept["senses"]), 1)
        self.assertEqual(kept["senses"][0]["meaning"], "休息一下")
        self.assertEqual(kept["senses"][0]["substitutes"][0]["text"], "have a break")
        phrase = build.phrase_entry(entry(synonyms=[{"word": "rest", "tags": ["Internet"]}, {"word": "have a break"}]), "s")
        self.assertEqual([s["text"] for s in phrase["senses"][0]["substitutes"]], ["have a break"])

    def test_reviewed_nonstandard_expression_is_removed_without_rewriting_source(self):
        self.assertIsNone(build.phrase_entry(entry("for sake of"), "s"))
        phrase = build.phrase_entry(entry("because of", "由於", synonyms=[{"word": "for sake of"}, {"word": "for the sake of"}, {"word": "due to"}]), "s")
        self.assertEqual([s["text"] for s in phrase["senses"][0]["substitutes"]], ["due to", "for the sake of"])
        self.assertIsNotNone(build.phrase_entry(entry("for the sake of"), "s"))

    def test_exact_token_association_has_no_substring_stemming_or_possessive_guess(self):
        rows = [entry("carry out"), entry("taking part"), entry("one's way")]
        index, _ = build.build_index([("s", rows)], {"carry", "car", "take", "taking", "one", "one's", "way"})
        self.assertEqual(set(index), {"carry", "taking", "one's", "way"})
        self.assertEqual(index["carry"]["phrases"][0]["text"], "carry out")

    def test_limits_and_supported_relation_priority_are_deterministic(self):
        rows = [entry(f"take {w}") for w in ["alpha", "beta", "gamma", "delta", "epsilon", "zeta", "eta"]]
        rows += [entry("take a break", synonyms=[{"word": w} for w in ["relax", "rest", "stop", "pause", "breathe", "repose"]])]
        index, _ = build.build_index([("s", rows)], {"take"})
        chosen = index["take"]["phrases"]
        self.assertEqual(len(chosen), 6)
        self.assertEqual(chosen[0]["text"], "take a break")
        self.assertEqual(len(chosen[0]["senses"][0]["substitutes"]), 4)
        reverse, _ = build.build_index([("s", list(reversed(rows)))], {"take"})
        self.assertEqual(index, reverse)

    def test_duplicate_phrase_prefers_evidence_without_duplicate_display(self):
        basic = entry()
        supported = entry(synonyms=[{"word": "have a break"}])
        index, _ = build.build_index([("s1", [basic]), ("s2", [supported, supported])], {"take"})
        self.assertEqual(len(index["take"]["phrases"]), 1)
        self.assertEqual(index["take"]["phrases"][0]["sourceId"], "s2")


class PhraseArtifactTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory(prefix="word-phrase-test-")
        self.addCleanup(self.temporary.cleanup)
        self.root = Path(self.temporary.name)

    def fixture(self):
        local = self.root / "input"
        local.mkdir()
        rows = [entry("take a break", synonyms=[{"word": "have a break"}]), entry("carry out", meaning="執行")]
        raw = b"\n".join(build.encoded(row) for row in rows) + b"\n"
        archive = build.stable_gzip(raw)
        raw_info = build.metadata("unused", raw)
        raw_info.pop("file")
        source = raw_info | {"id": "test-source", "name": "Test-only fixture",
                             "localFile": "source.jsonl", "url": "https://example.invalid/source.jsonl",
                             "pageUrl": "https://example.invalid/", "archive": build.metadata("sources/test.jsonl.gz", archive) |
                             {"mirrorUrl": "https://example.invalid/test.jsonl.gz"}}
        (local / "source.jsonl").write_bytes(raw)
        (local / "test.jsonl.gz").write_bytes(archive)
        license_data = b"Test-only license fixture; production configuration pins the complete license."
        (local / "license.txt").write_bytes(license_data)
        license_info = build.metadata("licenses/license.txt", license_data) | {
            "name": "CC-BY-SA-4.0", "url": "https://creativecommons.org/licenses/by-sa/4.0/",
            "localFile": "license.txt", "mirrorUrl": "https://example.invalid/license.txt",
            "textUrl": "https://example.invalid/license.txt"}
        config = {"schemaVersion": 1, "dumpDate": "2026-10-01", "extractedAt": "2026-10-20",
                  "extractorCommits": ["fixture"], "sources": [source], "license": license_info}
        dictionary = self.root / "dictionary"
        dictionary.mkdir()
        study = build.encoded([{"id": "take", "basic": True}, {"id": "carry", "basic": False}, {"id": "none", "basic": False}])
        (dictionary / "study.json").write_bytes(study)
        manifest = {"version": "test-dictionary", "study": build.metadata("study.json", study)}
        (dictionary / "manifest.json").write_bytes(build.encoded(manifest))
        database = dictionary / "ecdict.sqlite"
        connection = sqlite3.connect(database)
        connection.execute("CREATE TABLE entry(word TEXT PRIMARY KEY)")
        connection.executemany("INSERT INTO entry VALUES (?)", [(w,) for w in ["take", "carry", "none", "car", "other"]])
        connection.execute("CREATE TABLE build_meta(key TEXT PRIMARY KEY, value TEXT)")
        connection.execute("INSERT INTO build_meta VALUES ('version','test-dictionary')")
        connection.commit()
        connection.close()
        return config, dictionary / "manifest.json", database, self.root / "output", self.root / "cache", local

    def test_build_is_reproducible_read_only_and_coverage_is_real(self):
        args = self.fixture()
        before = build.digest(args[2].read_bytes())
        with patch.object(build, "urlopen", side_effect=AssertionError("offline build contacted network")):
            first = build.build(*args, allow_download=False)
            second = build.build(*args, allow_download=False)
        self.assertEqual(first, second)
        self.assertEqual(before, build.digest(args[2].read_bytes()))
        self.assertEqual(first["coverage"]["studyWordsWithPhrases"], 2)
        self.assertEqual(first["coverage"]["defaultStudyWordsWithPhrases"], 1)
        self.assertEqual(first["coverage"]["studyWordsWithSubstitutes"], 1)
        self.assertEqual(len(first["shards"]), 26)
        self.assertEqual(build.verify_output(args[3])["dictionaryWords"], 2)

    def test_corrupted_raw_or_gzip_never_silently_reuses_or_downloads(self):
        config, _, _, _, cache, local = self.fixture()
        source = config["sources"][0]
        (local / source["localFile"]).write_text("tampered", encoding="utf-8")
        with patch.object(build, "urlopen", side_effect=AssertionError("network forbidden")):
            with self.assertRaisesRegex(ValueError, "SHA-256"):
                build.acquire_source(source, cache, local, allow_download=False)

    def test_verification_rejects_tampering_or_changed_dictionary(self):
        args = self.fixture()
        manifest = build.build(*args, allow_download=False)
        with self.assertRaisesRegex(ValueError, "version mismatch"):
            build.verify_output(args[3], "different-dictionary")
        path = args[3] / manifest["shards"]["t"]["file"]
        path.write_bytes(path.read_bytes() + b" ")
        with self.assertRaisesRegex(ValueError, "SHA-256"):
            build.verify_output(args[3])

    def test_verification_rejects_claimed_independent_translation_even_with_updated_hash(self):
        args = self.fixture()
        manifest = build.build(*args, allow_download=False)
        descriptor = manifest["shards"]["t"]
        path = args[3] / descriptor["file"]
        rows = json.loads(path.read_bytes())
        rows["take"]["phrases"][0]["senses"][0]["substitutes"][0]["meaning"] = "編造中文"
        data = build.encoded(rows)
        path.write_bytes(data)
        manifest["shards"]["t"] = build.metadata(descriptor["file"], data, descriptor["count"])
        (args[3] / "manifest.json").write_bytes(build.encoded(manifest))
        with self.assertRaisesRegex(ValueError, "shared source sense"):
            build.verify_output(args[3])

    def test_archive_has_fixed_timestamp_and_no_host_filename(self):
        data = b"source bytes\n" * 10
        archive = build.stable_gzip(data)
        self.assertEqual(archive[4:8], b"\x00" * 4)
        self.assertEqual(archive[3] & 8, 0)
        self.assertEqual(gzip.decompress(archive), data)
        self.assertEqual(archive, build.stable_gzip(data))

    def test_malformed_jsonl_is_an_explicit_failure(self):
        with self.assertRaisesRegex(ValueError, "line 2"):
            list(build.jsonl_rows(b'{}\n{"bad":\n'))


if __name__ == "__main__":
    unittest.main()
