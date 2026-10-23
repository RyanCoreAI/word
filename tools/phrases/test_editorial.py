import copy
import unittest

import check_editorial


class EditorialCheckpointTests(unittest.TestCase):
    def setUp(self):
        self.synset = "02161432-a"
        self.definition = "important in effect or meaning"
        self.members = {self.synset: {"important", "significant"}}
        self.lines = {(self.synset, "important"): 20636, (self.synset, "significant"): 20635}
        source = check_editorial.SOURCE_BASE + "20636"
        self.records = [{"word": "important", "sense": {
            "id": "pwn30-" + self.synset, "pos": "adj", "meaning": "意义重大的",
            "meaningBasis": "editorial", "definition": self.definition,
            "usage": "不包括其他义项。", "sourceId": "omw-pwn30-2.0", "sourceUrl": source,
            "editorialSourceId": "yanxai-editorial-pwn30-20261022", "tags": ["编辑核验", "雅思备考"],
            "substitutes": [{"text": "significant", "meaning": "意义重大的",
                             "meaningBasis": "shared-sense", "relationBasis": "exact-synset",
                             "sourceId": "omw-pwn30-2.0", "sourceUrl": source, "tags": []}]}}]

    def validate(self, records=None):
        return check_editorial.validate_records(records or self.records, self.members, self.lines,
                                                {self.synset: self.definition})

    def test_exact_source_relation_has_original_editorial_meaning_and_limited_scope(self):
        result = self.validate()
        self.assertEqual(result["editorialWords"], 1)
        self.assertEqual(result["directedWordSubstitutions"], 1)

    def test_related_or_antonymous_words_are_not_accepted_as_exact_synonyms(self):
        records = copy.deepcopy(self.records)
        records[0]["sense"]["substitutes"][0]["text"] = "unimportant"
        with self.assertRaisesRegex(ValueError, "exact-synset"):
            self.validate(records)

    def test_definition_pos_and_source_line_must_match_selected_synset(self):
        for key, value in [("definition", "a different meaning"), ("pos", "noun"),
                           ("sourceUrl", check_editorial.SOURCE_BASE + "1")]:
            with self.subTest(key=key):
                records = copy.deepcopy(self.records)
                records[0]["sense"][key] = value
                with self.assertRaises(ValueError):
                    self.validate(records)

    def test_editorial_chinese_is_never_claimed_to_be_a_source_translation(self):
        records = copy.deepcopy(self.records)
        records[0]["sense"]["meaningBasis"] = "source-translation"
        with self.assertRaisesRegex(ValueError, "editorial"):
            self.validate(records)

    def test_duplicate_words_and_extra_generated_examples_are_rejected(self):
        with self.assertRaisesRegex(ValueError, "duplicate"):
            self.validate(self.records + copy.deepcopy(self.records))
        records = copy.deepcopy(self.records)
        records[0]["sense"]["examples"] = ["invented example"]
        with self.assertRaisesRegex(ValueError, "contract"):
            self.validate(records)


if __name__ == "__main__":
    unittest.main()
