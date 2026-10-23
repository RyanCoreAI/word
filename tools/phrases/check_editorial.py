"""Verify the small editorial checkpoint without publishing or changing the app.

Graph/definition checks prove provenance and scope, not linguistic perfection.
Chinese notes are original editorial explanations, never COW bulk translations.
"""
from __future__ import annotations

import argparse
import hashlib
import json
from pathlib import Path
import re
import sqlite3
import sys
import tarfile
from urllib.request import Request, urlopen
import xml.etree.ElementTree as ET


DIRECTORY = Path(__file__).resolve().parent
ROOT = DIRECTORY.parents[1]
SOURCE_BASE = "https://github.com/omwn/omw-data/blob/406bf83b3c507a3d1f26e88252d5d66893fd36bf/wns/eng/wn-data-eng.tab#L"
PARTS = {"n": "noun", "v": "verb", "a": "adj", "r": "adv"}
WORD = re.compile(r"[a-z]+(?:'[a-z]+)?")
SYNSET = re.compile(r"\d{8}-[nvar]")
SENSE_KEYS = {"id", "pos", "meaning", "meaningBasis", "definition", "usage", "sourceId", "sourceUrl", "editorialSourceId", "tags", "substitutes"}
SUBSTITUTE_KEYS = {"text", "meaning", "meaningBasis", "relationBasis", "sourceId", "sourceUrl", "tags"}


def sha(data):
    return hashlib.sha256(data).hexdigest()


def checked_bytes(path, descriptor):
    data = path.read_bytes()
    if len(data) != descriptor["bytes"] or sha(data) != descriptor["sha256"]:
        raise ValueError("Pinned source or editorial hash mismatch: " + str(path))
    return data


def acquire(descriptor, source_directory, fetch=False):
    path = source_directory / descriptor["file"]
    if not path.exists() and fetch:
        if not descriptor["url"].startswith("https://") or descriptor["bytes"] > 250 * 1024 * 1024:
            raise ValueError("Only bounded public HTTPS downloads are supported")
        request = Request(descriptor["url"], headers={"User-Agent": "YanxaiWordEditorialCheckpoint/1.0"})
        with urlopen(request, timeout=90) as response:
            data = response.read(descriptor["bytes"] + 1)
        if len(data) != descriptor["bytes"] or sha(data) != descriptor["sha256"]:
            raise ValueError("Downloaded source differs from the pinned bytes")
        path.parent.mkdir(parents=True, exist_ok=True)
        partial = path.with_name(path.name + ".partial")
        partial.write_bytes(data)
        partial.replace(path)
    checked_bytes(path, descriptor)
    return path


def read_members(path):
    members, lines = {}, {}
    for number, line in enumerate(path.read_text("utf-8").splitlines(), 1):
        if not line or line.startswith("#"):
            continue
        fields = line.split("\t", 2)
        if len(fields) != 3 or not SYNSET.fullmatch(fields[0]):
            raise ValueError("Malformed fixed-version WordNet lemma source")
        synset, kind, lemma = fields
        if kind == "lemma":
            members.setdefault(synset, set()).add(lemma)
            lines[(synset, lemma)] = number
    return members, lines


def read_definitions(archive, wanted):
    definitions = {}
    with tarfile.open(archive, "r:xz") as source:
        member = source.getmember("omw-en/omw-en.xml")
        if not member.isfile() or member.size > 128 * 1024 * 1024:
            raise ValueError("Unexpected WordNet XML member or size")
        stream = source.extractfile(member)
        if stream is None:
            raise ValueError("Missing pinned English XML")
        with stream:
            for _, node in ET.iterparse(stream, events=["end"]):
                if node.tag == "Synset":
                    synset = node.attrib["id"].removeprefix("omw-en-")
                    if synset.endswith("-s"):
                        synset = synset[:-1] + "a"
                    if synset in wanted:
                        definitions[synset] = " ".join((node.findtext("Definition") or "").split())
                    node.clear()
                elif node.tag == "LexicalEntry":
                    node.clear()
    if set(definitions) != set(wanted):
        raise ValueError("An editorial sense has no same-ID English source definition")
    return definitions


def bounded(value, maximum, chinese=False):
    if not isinstance(value, str) or not 0 < len(value) <= maximum or value != " ".join(value.split()):
        raise ValueError("Invalid or unbounded editorial text")
    if chinese and not re.search(r"[\u3400-\u9fff]", value):
        raise ValueError("Expected an explicit Chinese editorial explanation")


def validate_records(records, members, lines, definitions):
    seen, synsets = set(), set()
    for record in records:
        if set(record) != {"word", "sense"}:
            raise ValueError("Unexpected editorial record fields")
        word, sense = record["word"], record["sense"]
        if not isinstance(word, str) or not WORD.fullmatch(word) or word in seen:
            raise ValueError("Invalid or duplicate editorial word")
        seen.add(word)
        if set(sense) != SENSE_KEYS or not sense["id"].startswith("pwn30-"):
            raise ValueError("Unexpected editorial sense contract")
        synset = sense["id"].removeprefix("pwn30-")
        if not SYNSET.fullmatch(synset) or word not in members.get(synset, set()):
            raise ValueError("The exact source synset does not contain this word")
        synsets.add(synset)
        if sense["pos"] != PARTS[synset[-1]] or sense["definition"] != definitions.get(synset):
            raise ValueError("WordNet POS or English definition mismatch")
        bounded(sense["definition"], 400)
        bounded(sense["meaning"], 180, chinese=True)
        bounded(sense["usage"], 240, chinese=True)
        if sense["meaningBasis"] != "editorial" or sense["editorialSourceId"] != "yanxai-editorial-pwn30-20261022":
            raise ValueError("Original Chinese notes must be marked as editorial")
        expected_url = SOURCE_BASE + str(lines[(synset, word)])
        if sense["sourceId"] != "omw-pwn30-2.0" or sense["sourceUrl"] != expected_url:
            raise ValueError("WordNet source line or source identity mismatch")
        if sense["tags"] != ["编辑核验", "雅思备考"] or not 1 <= len(sense["substitutes"]) <= 4:
            raise ValueError("Unexpected editorial tags or substitute count")
        replacements = set()
        for substitute in sense["substitutes"]:
            if set(substitute) != SUBSTITUTE_KEYS:
                raise ValueError("Unexpected editorial substitute fields")
            target = substitute["text"]
            if not isinstance(target, str) or not WORD.fullmatch(target) or target == word or target in replacements or target not in members[synset]:
                raise ValueError("A replacement is not a distinct exact-synset source member")
            replacements.add(target)
            if substitute["meaning"] != sense["meaning"] or substitute["meaningBasis"] != "shared-sense" or substitute["relationBasis"] != "exact-synset" or substitute["sourceId"] != sense["sourceId"] or substitute["sourceUrl"] != sense["sourceUrl"] or substitute["tags"] != []:
                raise ValueError("Shared-sense meaning or source evidence mismatch")
    return {"editorialWords": len(seen), "selectedSynsets": len(synsets),
            "directedWordSubstitutions": sum(len(r["sense"]["substitutes"]) for r in records),
            "words": sorted(seen)}


def verify(source_directory, fetch=False):
    config = json.loads((DIRECTORY / "editorial_sources.json").read_text("utf-8"))
    raw = checked_bytes(DIRECTORY / config["editorial"]["file"], config["editorial"])
    records = [json.loads(line) for line in raw.decode("utf-8").splitlines() if line]
    files = {descriptor["file"]: acquire(descriptor, source_directory, fetch) for descriptor in config["sources"]}
    members, lines = read_members(files["wn-data-eng.tab"])
    wanted = {r["sense"]["id"].removeprefix("pwn30-") for r in records}
    definitions = read_definitions(files["omw-en-2.0.tar.xz"], wanted)
    result = validate_records(records, members, lines, definitions)
    if result["editorialWords"] != config["expectedWords"]:
        raise ValueError("Editorial checkpoint count changed without updating its explicit pin")
    database = ROOT / "data/ecdict.sqlite"
    if database.exists():
        connection = sqlite3.connect(database.resolve().as_uri() + "?mode=ro", uri=True)
        try:
            rows = {word: (study, basic) for word, study, basic in connection.execute("SELECT word,study,basic FROM entry") if word in result["words"]}
        finally:
            connection.close()
        if set(rows) != set(result["words"]):
            raise ValueError("An editorial word is absent from the existing dictionary")
        result["existingStudyWords"] = sum(bool(flags[0]) for flags in rows.values())
        result["existingDefaultStudyWords"] = sum(bool(flags[0]) and not flags[1] for flags in rows.values())
    result.update({"status": config["status"], "editorialSha256": sha(raw),
                   "meaningOrigin": config["editorial"]["meaningOrigin"],
                   "examplesGenerated": 0})
    production_manifest = ROOT / "apps/web/public/phrases/manifest.json"
    if production_manifest.exists():
        production_bytes = production_manifest.read_bytes()
        result["productionManifestVersion"] = json.loads(production_bytes)["version"]
        result["productionManifestMatchesCheckpointBaseline"] = sha(production_bytes) == config["productionBaseline"]["manifestSha256"]
    return result


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--source-dir", type=Path, default=ROOT / "work/phrase-expansion-research")
    parser.add_argument("--fetch", action="store_true", help="Fetch missing pinned public sources into the selected directory")
    args = parser.parse_args()
    try:
        print(json.dumps(verify(args.source_dir, args.fetch), ensure_ascii=True, sort_keys=True))
    except Exception as error:
        print("ERROR: " + str(error), file=sys.stderr)
        sys.exit(1)
