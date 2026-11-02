"""Reproducible, bounded reading dictionary and source-attested inflection index."""
import argparse
from contextlib import closing
import hashlib
import json
import sqlite3

import pipeline

POLICY = {"schema": 1, "frequencyMax": 50000,
          "words": "translated lowercase single words; study or explicit basic or frq/bnc 1..50000",
          "lemmas": "ECDICT exchange 0 and reverse p/d/i/3/r/t/s; existing lowercase single forms only; no stemming"}
MANIFEST_NAME = "article-manifest.json"
INFLECTION_CODES = frozenset(("p", "d", "i", "3", "r", "t", "s"))


def reading_rows(connection):
    return list(connection.execute(
        "SELECT * FROM entry WHERE single=1 AND trim(translation)<>'' "
        "AND (study=1 OR basic=1 OR frq_num BETWEEN 1 AND ? OR bnc_num BETWEEN 1 AND ?) ORDER BY rank",
        (POLICY["frequencyMax"], POLICY["frequencyMax"])))


def lemma_index(connection, included):
    rows = list(connection.execute("SELECT word,exchange FROM entry WHERE single=1 ORDER BY word"))
    existing = {row["word"] for row in rows}
    candidates = {}

    def add(form, lemma):
        # Both sides must really occur in the pinned lexicon; roots must have a readable definition.
        if form != lemma and form in existing and lemma in included:
            candidates.setdefault(form, set()).add(lemma)

    for row in rows:
        word = row["word"]
        for item in row["exchange"].split("/"):
            if ":" not in item:
                continue
            code, value = item.split(":", 1)
            if code == "0":
                add(word, value)
            elif code in INFLECTION_CODES:
                add(value, word)
    return {form: sorted(candidates[form]) for form in sorted(candidates)}


def reading_metadata(path, count):
    return pipeline.metadata(path, count, pipeline.VERSION)


def verified_database():
    path = pipeline.DATA / "ecdict.sqlite"
    connection = sqlite3.connect(str(path))
    connection.row_factory = sqlite3.Row
    metadata = dict(connection.execute("SELECT key,value FROM build_meta"))
    if metadata.get("version") != pipeline.VERSION or metadata.get("source_sha256") != pipeline.SOURCE_SHA:
        connection.close()
        raise ValueError("Reading database does not match the pinned dictionary build")
    if connection.execute("PRAGMA integrity_check").fetchone()[0] != "ok":
        connection.close()
        raise ValueError("Reading database integrity check failed")
    return connection


def build():
    source_manifest = json.loads((pipeline.PUBLIC / "manifest.json").read_text(encoding="utf-8"))
    if source_manifest["version"] != pipeline.VERSION:
        raise ValueError("Build the pinned main dictionary before the reading dictionary")
    with closing(verified_database()) as connection:
        words = [pipeline.word_record(row) for row in reading_rows(connection)]
        lemmas = lemma_index(connection, {word["word"] for word in words})
    destination = pipeline.PUBLIC / pipeline.VERSION
    destination.mkdir(parents=True, exist_ok=True)
    words_bytes, lemmas_bytes = pipeline.json_bytes(words), pipeline.json_bytes(lemmas)
    words_path = destination / ("article-v1-words-" + hashlib.sha256(words_bytes).hexdigest()[:12] + ".json")
    lemmas_path = destination / ("article-v1-lemmas-" + hashlib.sha256(lemmas_bytes).hexdigest()[:12] + ".json")
    pipeline.atomic_write(words_path, words_bytes)
    pipeline.atomic_write(lemmas_path, lemmas_bytes)
    manifest = {"schema": 1, "version": pipeline.VERSION, "source": source_manifest["source"],
                "license": source_manifest["license"], "policy": POLICY,
                "words": reading_metadata(words_path, len(words)),
                "lemmas": reading_metadata(lemmas_path, len(lemmas))}
    verify_manifest(manifest, pipeline.PUBLIC)
    pipeline.atomic_write(pipeline.PUBLIC / MANIFEST_NAME, pipeline.json_bytes(manifest))
    print(json.dumps({"readingWords": len(words), "inflectedForms": len(lemmas),
                      "bytes": manifest["words"]["bytes"] + manifest["lemmas"]["bytes"]}), flush=True)
    return manifest


def read_checked(base, asset):
    path = (base / asset["file"]).resolve()
    if base.resolve() not in path.parents:
        raise ValueError("Reading asset path escapes data directory")
    if path.stat().st_size != asset["bytes"] or pipeline.digest(path) != asset["sha256"]:
        raise ValueError("Reading asset checksum/size mismatch")
    return json.loads(path.read_text(encoding="utf-8"))


def verify_manifest(manifest, base):
    if manifest["schema"] != 1 or manifest["version"] != pipeline.VERSION or manifest["policy"] != POLICY:
        raise ValueError("Reading manifest policy/version mismatch")
    if manifest["source"]["sha256"] != pipeline.SOURCE_SHA or manifest["source"]["commit"] != pipeline.COMMIT:
        raise ValueError("Reading source does not match the pinned ECDICT source")
    words = read_checked(base, manifest["words"])
    if not isinstance(words, list) or len(words) != manifest["words"]["count"]:
        raise ValueError("Reading word count mismatch")
    previous = 0
    included = set()
    for word in words:
        pipeline.check_word(word)
        if (word["word"] in included or word["rank"] <= previous or not word["translation"].strip()
                or not pipeline.SINGLE.fullmatch(word["word"])):
            raise ValueError("Invalid reading word membership/order")
        previous = word["rank"]
        included.add(word["word"])
    lemmas = read_checked(base, manifest["lemmas"])
    if not isinstance(lemmas, dict) or len(lemmas) != manifest["lemmas"]["count"]:
        raise ValueError("Reading lemma count mismatch")
    for form, candidates in lemmas.items():
        if (not pipeline.SINGLE.fullmatch(form) or not isinstance(candidates, list) or not candidates
                or candidates != sorted(set(candidates)) or form in candidates
                or any(candidate not in included for candidate in candidates)):
            raise ValueError("Invalid reading lemma candidates")
    return {"readingWords": len(words), "inflectedForms": len(lemmas), "allChecksumsPassed": True}


def verify():
    manifest = json.loads((pipeline.PUBLIC / MANIFEST_NAME).read_text(encoding="utf-8"))
    result = verify_manifest(manifest, pipeline.PUBLIC)
    # Compare rebuilt bytes, not merely a self-consistent edited manifest.
    with closing(verified_database()) as connection:
        words = [pipeline.word_record(row) for row in reading_rows(connection)]
        lemmas = lemma_index(connection, {word["word"] for word in words})
    if words != read_checked(pipeline.PUBLIC, manifest["words"]) or lemmas != read_checked(pipeline.PUBLIC, manifest["lemmas"]):
        raise ValueError("Reading package differs from the fixed source and policy")
    print(json.dumps(result), flush=True)
    return result


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("command", choices=("build", "verify"))
    arguments = parser.parse_args()
    {"build": build, "verify": verify}[arguments.command]()
