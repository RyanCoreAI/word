"""Build separately licensed phrase supplements from verified public snapshots.

This module uses Python's standard library, never edits the ECDICT database, and
never infers synonyms from similar translations or similar spellings.
"""
from __future__ import annotations

import argparse
from collections import Counter, defaultdict
import gzip
import hashlib
import io
import json
from pathlib import Path
import re
import sqlite3
import string
import sys
import unicodedata
from urllib.parse import quote
from urllib.request import Request, urlopen


ROOT = Path(__file__).resolve().parents[2]
CONFIG = Path(__file__).with_name("sources.json")
SCHEMA_VERSION = 1
MAX_PHRASES = 6
MAX_SENSES = 3
MAX_SUBSTITUTES = 4
MAX_TEXT = 96
MAX_MEANING = 180
MAX_TAG = 48
MAX_TAGS = 16
MAX_DOWNLOAD_BYTES = 250 * 1024 * 1024
WORD = re.compile(r"[a-z]+(?:'[a-z]+)?")
PHRASE = re.compile(r"[a-z]+(?:'[a-z]+)?(?: [a-z]+(?:'[a-z]+)?){1,5}")
CHINESE = re.compile(r"[\u3400-\u9fff]")
ALLOWED_POS = frozenset({"noun", "verb", "adj", "adv", "phrase", "prep", "prep_phrase", "conj", "intj", "pron", "det", "num"})
REJECT_TAGS = frozenset({"form-of", "alt-of", "no-gloss", "obsolete", "archaic", "dated", "historical", "rare", "nonstandard", "vulgar", "derogatory", "offensive", "ethnic-slur", "slur", "profanity", "Internet"})
REJECT_RAW = re.compile(r"古[舊旧語语]|[過过][時时]|[棄弃]用|[舊旧][稱称]|粗[俗鄙]|[貶贬][義义]|[冒侮]犯|歧[視视]|蔑[稱称]|[種种]族|罕[用見见]|不常用|[非不][標标][準准]|^旧$|(?:网络|網絡|網路)(?:用语|用語|俚语|俚語)")
# Editorial exclusions are finite and auditable. They do not modify source
# snapshots or claim to be a complete classifier of offensive language.
REJECT_ENGLISH_TOKENS = frozenset({
    "fuck", "fucks", "fucked", "fucking", "fuckin", "fucken", "fucker", "fuckers",
    "fuckhead", "fuckheads", "fuckface", "fuckfaces", "fuckwit", "fuckwits",
    "fuckery", "fuckeries", "fuckable", "motherfuck", "motherfucks", "motherfucked",
    "motherfucking", "motherfucker", "motherfuckers", "clusterfuck", "clusterfucks",
    "shit", "shits", "shitted", "shitting", "shitter", "shitters", "shitty",
    "shittier", "shittiest", "shithead", "shitheads", "shitfaced", "shitshow",
    "shitshows", "shitstorm", "shitstorms", "shitload", "shitloads", "shitton",
    "shittons", "shite", "shites", "shitey", "bullshit", "bullshits", "bullshitted",
    "bullshitting", "bullshitter", "bullshitters", "horseshit", "dogshit",
    "chickenshit", "apeshit", "batshit", "piss", "pisses", "pissed", "pissing",
    "pisser", "pissers", "pissy", "pisshead", "pissheads", "pissant", "pissants",
    "pisspoor",
})
REJECT_EXACT_EXPRESSIONS = frozenset({"for sake of"})
POLICY = {
    "schemaVersion": SCHEMA_VERSION,
    "maxPhrasesPerWord": MAX_PHRASES,
    "maxSensesPerPhrase": MAX_SENSES,
    "maxSubstitutesPerSense": MAX_SUBSTITUTES,
    "maxPhraseCharacters": MAX_TEXT,
    "maxMeaningCharacters": MAX_MEANING,
    "association": "exact lowercase whole-token dictionary ID only; no stemming or fuzzy replacement",
    "ordering": "source-supported substitutes first, then fewer tokens, then ASCII phrase and POS",
    "frequency": "No corpus frequency or claim that every retained phrase is common",
    "substitutes": "unique exact normalized source-sense text, or one source sense with an unqualified link",
    "meaning": "Chinese source gloss unchanged apart from whitespace; synonym meaning is explicitly shared-sense",
    "allowedPOS": sorted(ALLOWED_POS),
    "rejectedTags": sorted(REJECT_TAGS),
    "rejectedEnglishTokens": sorted(REJECT_ENGLISH_TOKENS),
    "rejectedExactExpressions": sorted(REJECT_EXACT_EXPRESSIONS),
    "editorialTokenMatching": "exact token after removing an optional possessive 's; never substring matching",
    "rawTagRejection": REJECT_RAW.pattern,
    "phrasePattern": PHRASE.pattern,
}


def encoded(value):
    return json.dumps(value, ensure_ascii=False, sort_keys=True, separators=(",", ":")).encode("utf-8")


def digest(data):
    return hashlib.sha256(data).hexdigest()


def verify_bytes(data, descriptor, label):
    if len(data) != descriptor["bytes"] or digest(data) != descriptor["sha256"]:
        raise ValueError(f"{label}: byte size or SHA-256 differs from the pinned snapshot")
    return data


def atomic_write(path, data):
    path = Path(path)
    path.parent.mkdir(parents=True, exist_ok=True)
    temporary = path.with_name(path.name + ".partial")
    temporary.write_bytes(data)
    temporary.replace(path)


def download(url, descriptor):
    if not url.startswith("https://") or descriptor["bytes"] > MAX_DOWNLOAD_BYTES:
        raise ValueError("Only bounded public HTTPS source downloads are supported")
    request = Request(url, headers={"User-Agent": "YanxaiWordPhraseBuilder/1.0 (public licensed snapshot verification)"})
    with urlopen(request, timeout=90) as response:
        data = response.read(descriptor["bytes"] + 1)
    return verify_bytes(data, descriptor, url)


def stable_gzip(data):
    buffer = io.BytesIO()
    with gzip.GzipFile(filename="", mode="wb", fileobj=buffer, mtime=0, compresslevel=9) as output:
        output.write(data)
    return buffer.getvalue()


def inflate(archive, descriptor):
    with gzip.GzipFile(fileobj=io.BytesIO(archive)) as source:
        data = source.read(descriptor["bytes"] + 1)
    return verify_bytes(data, descriptor, "decompressed source")


def acquire_source(source, cache, local=None, allow_download=True):
    """Return exact raw bytes plus the separately verified frozen gzip archive."""
    raw_paths = [cache / (source["sha256"] + ".jsonl")]
    archive_paths = [cache / Path(source["archive"]["file"]).name]
    if local:
        raw_paths += [local / source["localFile"], local / (source["sha256"] + ".jsonl")]
        archive_paths += [local / Path(source["archive"]["file"]).name,
                          local / source["archive"]["file"]]
    raw = archive = None
    for path in raw_paths:
        if path.exists():
            raw = verify_bytes(path.read_bytes(), source, str(path))
            break
    for path in archive_paths:
        if path.exists():
            archive = verify_bytes(path.read_bytes(), source["archive"], str(path))
            archived_raw = inflate(archive, source)
            if raw is not None and raw != archived_raw:
                raise ValueError("Frozen archive and raw source disagree")
            raw = archived_raw
            break
    failures = []
    if archive is None and allow_download:
        try:
            archive = download(source["archive"]["mirrorUrl"], source["archive"])
            archived_raw = inflate(archive, source)
            if raw is not None and raw != archived_raw:
                raise ValueError("Mirror archive and raw source disagree")
            raw = archived_raw
        except Exception as error:
            failures.append(f"frozen mirror: {error}")
    if raw is None and allow_download:
        try:
            raw = download(source["url"], source)
        except Exception as error:
            failures.append(f"original source: {error}")
    if raw is None:
        raise ValueError(f"Missing pinned source {source['id']}. " + "; ".join(failures))
    if archive is None:
        archive = verify_bytes(stable_gzip(raw), source["archive"], "recreated frozen archive (use the pinned mirror if zlib differs)")
    atomic_write(raw_paths[0], raw)
    atomic_write(archive_paths[0], archive)
    return raw, archive


def acquire_license(license_info, cache, local=None, allow_download=True):
    paths = [cache / license_info["localFile"]]
    if local:
        paths += [local / license_info["localFile"], local / license_info["file"]]
    for path in paths:
        if path.exists():
            data = verify_bytes(path.read_bytes(), license_info, str(path))
            atomic_write(paths[0], data)
            return data
    failures = []
    if allow_download:
        for url in [license_info["mirrorUrl"], license_info["textUrl"]]:
            try:
                data = download(url, license_info)
                atomic_write(paths[0], data)
                return data
            except Exception as error:
                failures.append(str(error))
    raise ValueError("Missing complete pinned CC BY-SA 4.0 license. " + "; ".join(failures))


def text(value, maximum):
    if not isinstance(value, str) or any(unicodedata.category(c) == "Cc" and not c.isspace() for c in value):
        return None
    cleaned = " ".join(value.split())
    return cleaned if 0 < len(cleaned) <= maximum else None


def tags_of(*objects):
    values = []
    for value in objects:
        for field in ("tags", "raw_tags"):
            for item in value.get(field, []):
                tag = text(item, MAX_TAG)
                if tag and tag not in values:
                    values.append(tag)
    return sorted(values)[:MAX_TAGS]


def rejected(*objects):
    for value in objects:
        if value.get("form_of") or value.get("alt_of"):
            return True
        if REJECT_TAGS.intersection(value.get("tags", [])):
            return True
        if any(isinstance(item, str) and REJECT_RAW.search(item) for item in value.get("raw_tags", [])):
            return True
    return False


def normalized_sense(value):
    return "".join(c for c in value if not c.isspace() and not unicodedata.category(c).startswith("P"))


def editorially_excluded(value):
    return value in REJECT_EXACT_EXPRESSIONS or any(token.removesuffix("'s") in REJECT_ENGLISH_TOKENS for token in value.split(" "))


def source_url(word):
    return "https://zh.wiktionary.org/wiki/" + quote(word.replace(" ", "_"), safe="")


def phrase_entry(entry, source_id, stats=None):
    """Keep only source-backed Chinese senses; ambiguous synonym links stay out."""
    stats = stats if stats is not None else Counter()
    word = entry.get("word")
    pos = entry.get("pos")
    if entry.get("lang_code") != "en" or not isinstance(word, str) or len(word) > MAX_TEXT or not PHRASE.fullmatch(word) or editorially_excluded(word) or pos not in ALLOWED_POS or rejected(entry):
        stats["excludedEntries"] += 1
        return None
    senses = []
    original_senses = entry.get("senses", [])
    if not isinstance(original_senses, list):
        raise ValueError("Source senses must be an array")
    for raw in original_senses:
        if not isinstance(raw, dict):
            raise ValueError("Source sense must be an object")
        if rejected(raw):
            stats["excludedSenses"] += 1
            continue
        glosses = raw.get("glosses", [])
        if not isinstance(glosses, list) or not glosses:
            continue
        cleaned = [text(g, MAX_MEANING) for g in glosses]
        if any(g is None for g in cleaned):
            stats["excludedSenses"] += 1
            continue
        meaning = "；".join(dict.fromkeys(cleaned))
        if len(meaning) > MAX_MEANING or not CHINESE.search(meaning):
            stats["excludedSenses"] += 1
            continue
        sense_id = text(raw.get("id"), 200)
        if not sense_id:
            stats["excludedSensesWithoutSourceId"] += 1
            continue
        senses.append({"id": sense_id, "meaning": meaning,
                       "sourceUrl": source_url(word), "sourceId": source_id,
                       "tags": tags_of(entry, raw), "substitutes": [],
                       "_glosses": [normalized_sense(g) for g in cleaned]})
    if not senses:
        return None
    for synonym in entry.get("synonyms", []):
        if not isinstance(synonym, dict):
            raise ValueError("Source synonym must be an object")
        replacement = synonym.get("word", "")
        if not isinstance(replacement, str) or len(replacement) > MAX_TEXT or not (WORD.fullmatch(replacement) or PHRASE.fullmatch(replacement)) or editorially_excluded(replacement) or replacement == word or rejected(entry, synonym):
            stats["excludedSubstitutes"] += 1
            continue
        specified = text(synonym.get("sense"), MAX_MEANING)
        matched = [s for s in senses if specified and normalized_sense(specified) in s["_glosses"]]
        basis = "exact-source-sense"
        if not synonym.get("sense") and len(original_senses) == 1 and len(senses) == 1:
            matched = senses
            basis = "single-source-sense"
        if len(matched) != 1:
            stats["ambiguousSubstitutesRejected"] += 1
            continue
        sense = matched[0]
        substitute = {"text": replacement, "meaning": sense["meaning"],
                      "meaningBasis": "shared-sense", "relationBasis": basis,
                      "sourceUrl": source_url(word), "sourceId": source_id,
                      "tags": tags_of({"tags": sense["tags"]}, entry, synonym)}
        if substitute not in sense["substitutes"]:
            sense["substitutes"].append(substitute)
    for sense in senses:
        del sense["_glosses"]
        sense["substitutes"] = sorted(sense["substitutes"], key=lambda s: (s["text"], s["relationBasis"]))[:MAX_SUBSTITUTES]
    # Prefer useful supported relations without interpreting the source order as frequency.
    senses.sort(key=lambda s: (not bool(s["substitutes"]), s["id"]))
    return {"text": word, "pos": pos, "sourceUrl": source_url(word),
            "sourceId": source_id, "tags": tags_of(entry), "senses": senses[:MAX_SENSES]}


def build_index(source_rows, dictionary_ids):
    stats = Counter()
    unique = {}
    for source_id, rows in source_rows:
        for entry in rows:
            stats["sourceEntries"] += 1
            if not isinstance(entry, dict):
                raise ValueError("Each JSONL record must be an object")
            phrase = phrase_entry(entry, source_id, stats)
            if phrase:
                # Distinct source/POS records remain distinguishable for provenance.
                key = (phrase["text"], phrase["pos"])
                previous = unique.get(key)
                preference = lambda p: (-sum(bool(s["substitutes"]) for s in p["senses"]), p["sourceId"])
                if previous is None or preference(phrase) < preference(previous):
                    unique[key] = phrase
    candidates = defaultdict(list)
    for phrase in unique.values():
        for token in set(phrase["text"].split(" ")):
            if token in dictionary_ids:
                candidates[token].append(phrase)
    index = {}
    for word in sorted(candidates):
        phrases = sorted(candidates[word], key=lambda p: (not any(s["substitutes"] for s in p["senses"]), len(p["text"].split(" ")), p["text"], p["pos"]))
        # A spelling appears once per word; multiple POS records are not duplicates in the source.
        chosen = []
        seen = set()
        for phrase in phrases:
            if phrase["text"] not in seen:
                chosen.append(phrase)
                seen.add(phrase["text"])
            if len(chosen) == MAX_PHRASES:
                break
        index[word] = {"phrases": chosen}
    stats["eligiblePhraseEntries"] = len(unique)
    stats["eligiblePhraseForms"] = len({p["text"] for p in unique.values()})
    stats["eligiblePhraseFormsWithSubstitutes"] = len({p["text"] for p in unique.values() if any(s["substitutes"] for s in p["senses"])})
    stats["eligibleSourceSubstituteLinks"] = sum(len(s["substitutes"]) for p in unique.values() for s in p["senses"])
    stats["dictionaryWordsWithPhrases"] = len(index)
    stats["dictionaryWordsWithSubstitutes"] = sum(any(s["substitutes"] for p in v["phrases"] for s in p["senses"]) for v in index.values())
    return index, dict(sorted(stats.items()))


def jsonl_rows(data):
    for line_number, line in enumerate(data.decode("utf-8").splitlines(), 1):
        if not line.strip():
            continue
        try:
            yield json.loads(line)
        except json.JSONDecodeError as error:
            raise ValueError(f"Malformed JSONL line {line_number}") from error


def dictionary_context(manifest_path, database):
    manifest = json.loads(manifest_path.read_text("utf-8"))
    study_info = manifest["study"]
    study_path = manifest_path.parent / study_info["file"]
    study = json.loads(verify_bytes(study_path.read_bytes(), study_info, "dictionary study list"))
    connection = sqlite3.connect(database.resolve().as_uri() + "?mode=ro", uri=True)
    try:
        version = connection.execute("SELECT value FROM build_meta WHERE key='version'").fetchone()
        if not version or version[0] != manifest["version"]:
            raise ValueError("Dictionary database and manifest versions disagree")
        dictionary_ids = {word for (word,) in connection.execute("SELECT word FROM entry") if WORD.fullmatch(word)}
    finally:
        connection.close()
    return manifest, dictionary_ids, {w["id"] for w in study}, {w["id"] for w in study if not w["basic"]}


def metadata(file, data, count=None):
    result = {"file": file, "bytes": len(data), "sha256": digest(data)}
    if count is not None:
        result["count"] = count
    return result


def attribution_text(config):
    lines = ["# Phrase supplement attribution and modifications", "",
             "Source authors: the contributors to Chinese Wiktionary (https://zh.wiktionary.org/).",
             "Structured extraction and distribution: Kaikki.org / Wiktextract, Tatu Ylonen and contributors.",
             "License selected for redistribution and this adapted data: Creative Commons Attribution-ShareAlike 4.0 International.",
             "https://creativecommons.org/licenses/by-sa/4.0/", "",
             f"Wiktionary dump: {config['dumpDate']}; extraction: {config['extractedAt']}.",
             "Wiktextract commits: " + ", ".join(config["extractorCommits"]) + ".", "",
             "Unmodified source JSONL snapshots are included in sources/ as deterministic gzip archives.",
             "Every retained meaning and synonym relation links to its original Wiktionary entry.", "",
             "Modifications: selected English lowercase phrases of 2 to 6 whole tokens; excluded unsupported POS,",
             "word forms, obsolete/archaic/rare/nonstandard and offensive/vulgar/derogatory marked material;",
             "excluded source-marked Internet expressions, a published finite list of explicit coarse English tokens",
             "and their common derivatives, and the reviewed nonstandard expression 'for sake of';",
             "bounded text and lists; normalized whitespace; deduplicated and grouped by exact dictionary tokens;",
             "retained only uniquely matched source-sense synonym links or unqualified links in single-sense entries;",
             "synonym Chinese meanings are explicitly inherited from that shared source sense, not independently translated;",
             "ranked supported synonym content first, then phrase length and alphabet, capped at six phrases per word.",
             "This is not a frequency-ranked common-phrases dictionary and does not cover every word.",
             "No machine-generated translations, ECDICT translation matching, or fuzzy synonyms were added.",
             "Source text may use traditional or simplified Chinese; it has not been silently converted.", "",
             "This data license is separate from the application's source-code and ECDICT licenses.", ""]
    for source in config["sources"]:
        lines += [source["name"], source["pageUrl"], source["url"],
                  f"Original bytes: {source['bytes']}; SHA-256: {source['sha256']}",
                  source["archive"]["mirrorUrl"], ""]
    return "\n".join(lines).encode("utf-8")


def published_sources(config):
    return [{key: value for key, value in source.items() if key != "localFile"} |
            {"extractedAt": config["extractedAt"], "dumpDate": config["dumpDate"], "license": "CC-BY-SA-4.0"}
            for source in config["sources"]]


def version_for(dictionary_version, config):
    material = encoded({"dictionaryVersion": dictionary_version, "sources": config,
                        "policy": POLICY, "implementationSha256": digest(Path(__file__).read_bytes())})
    return "wiktionary-zh-" + digest(material)[:20]


def build(config, manifest_path, database, output, cache, local=None, allow_download=True):
    dictionary, ids, study, default = dictionary_context(manifest_path, database)
    datasets, archives = [], []
    for source in config["sources"]:
        raw, archive = acquire_source(source, cache, local, allow_download)
        datasets.append((source["id"], jsonl_rows(raw)))
        archives.append((source, archive))
    license_data = acquire_license(config["license"], cache, local, allow_download)
    index, coverage = build_index(datasets, ids)
    coverage.update({"dictionaryWordIds": len(ids), "studyWords": len(study),
                     "defaultStudyWords": len(default),
                     "studyWordsWithPhrases": len(study.intersection(index)),
                     "defaultStudyWordsWithPhrases": len(default.intersection(index)),
                     "studyWordsWithSubstitutes": sum(any(s["substitutes"] for p in index[w]["phrases"] for s in p["senses"]) for w in study.intersection(index)),
                     "defaultStudyWordsWithSubstitutes": sum(any(s["substitutes"] for p in index[w]["phrases"] for s in p["senses"]) for w in default.intersection(index)),
                     "frequencyRanked": False, "completeDictionaryCoverage": False})
    version = version_for(dictionary["version"], config)
    shards = {}
    for initial in string.ascii_lowercase:
        records = {w: value for w, value in index.items() if w.startswith(initial)}
        data = encoded(records)
        file = f"{version}/{initial}.json"
        atomic_write(output / file, data)
        shards[initial] = metadata(file, data, len(records))
    for source, archive in archives:
        atomic_write(output / source["archive"]["file"], archive)
    license_info = config["license"]
    atomic_write(output / license_info["file"], license_data)
    attribution = attribution_text(config)
    attribution_file = f"{version}/ATTRIBUTION.md"
    atomic_write(output / attribution_file, attribution)
    manifest = {"schemaVersion": SCHEMA_VERSION, "version": version,
                "dictionaryVersion": dictionary["version"], "sources": published_sources(config),
                "license": metadata(license_info["file"], license_data) |
                           {"name": license_info["name"], "url": license_info["url"]},
                "attribution": metadata(attribution_file, attribution), "policy": POLICY,
                "shards": shards, "coverage": coverage}
    atomic_write(output / "manifest.json", encoded(manifest))
    verify_output(output, dictionary["version"], config)
    return manifest


def check_tags(tags):
    if not isinstance(tags, list) or len(tags) > MAX_TAGS or tags != sorted(set(tags)) or any(text(t, MAX_TAG) != t for t in tags):
        raise ValueError("Invalid or unbounded phrase tags")


def verify_output(output, dictionary_version=None, config=None):
    manifest = json.loads((output / "manifest.json").read_text("utf-8"))
    if manifest["schemaVersion"] != SCHEMA_VERSION or (dictionary_version and manifest["dictionaryVersion"] != dictionary_version):
        raise ValueError("Phrase schema or dictionary version mismatch")
    if config and (manifest["sources"] != published_sources(config) or manifest["policy"] != POLICY or manifest["version"] != version_for(manifest["dictionaryVersion"], config)):
        raise ValueError("Phrase source pins, policy, or builder version mismatch")
    if config:
        for key in ["name", "url", "file", "bytes", "sha256"]:
            if manifest["license"][key] != config["license"][key]:
                raise ValueError("Phrase license differs from its pinned complete text")
    if set(manifest["shards"]) != set(string.ascii_lowercase):
        raise ValueError("Expected exactly 26 phrase shards")
    source_ids = {source["id"] for source in manifest["sources"]}
    words, phrase_links = 0, 0
    for initial, descriptor in manifest["shards"].items():
        data = verify_bytes((output / descriptor["file"]).read_bytes(), descriptor, "phrase shard")
        records = json.loads(data)
        if len(records) != descriptor["count"]:
            raise ValueError("Phrase shard record count mismatch")
        for word, record in records.items():
            if not WORD.fullmatch(word) or word[0] != initial or not 1 <= len(record["phrases"]) <= MAX_PHRASES:
                raise ValueError("Invalid phrase-to-word association")
            seen = set()
            for phrase in record["phrases"]:
                if not PHRASE.fullmatch(phrase["text"]) or editorially_excluded(phrase["text"]) or len(phrase["text"]) > MAX_TEXT or phrase["pos"] not in ALLOWED_POS or word not in phrase["text"].split(" ") or phrase["text"] in seen or phrase["sourceId"] not in source_ids or phrase["sourceUrl"] != source_url(phrase["text"]):
                    raise ValueError("Invalid or duplicate phrase record")
                check_tags(phrase["tags"])
                seen.add(phrase["text"])
                if not 1 <= len(phrase["senses"]) <= MAX_SENSES:
                    raise ValueError("Invalid phrase sense count")
                for sense in phrase["senses"]:
                    if not CHINESE.search(sense["meaning"]) or text(sense["meaning"], MAX_MEANING) != sense["meaning"] or text(sense["id"], 200) != sense["id"] or sense["sourceId"] != phrase["sourceId"] or sense["sourceUrl"] != phrase["sourceUrl"] or len(sense["substitutes"]) > MAX_SUBSTITUTES:
                        raise ValueError("Invalid Chinese source sense")
                    check_tags(sense["tags"])
                    for substitute in sense["substitutes"]:
                        if not (WORD.fullmatch(substitute["text"]) or PHRASE.fullmatch(substitute["text"])) or editorially_excluded(substitute["text"]) or len(substitute["text"]) > MAX_TEXT or substitute["meaning"] != sense["meaning"] or substitute["meaningBasis"] != "shared-sense" or substitute["relationBasis"] not in {"exact-source-sense", "single-source-sense"} or substitute["sourceId"] != sense["sourceId"] or substitute["sourceUrl"] != sense["sourceUrl"]:
                            raise ValueError("Substitute meaning or provenance differs from its shared source sense")
                        check_tags(substitute["tags"])
                phrase_links += 1
            words += 1
    for descriptor in [manifest["license"], manifest["attribution"]]:
        verify_bytes((output / descriptor["file"]).read_bytes(), descriptor, "license or attribution")
    for source in manifest["sources"]:
        archive = verify_bytes((output / source["archive"]["file"]).read_bytes(), source["archive"], "frozen source archive")
        inflate(archive, source)
    if words != manifest["coverage"]["dictionaryWordsWithPhrases"]:
        raise ValueError("Phrase coverage does not match actual shard records")
    return {"version": manifest["version"], "dictionaryWords": words, "publishedPhraseLinks": phrase_links,
            "shardBytes": sum(s["bytes"] for s in manifest["shards"].values()),
            "coverage": manifest["coverage"]}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--source-dir", type=Path, help="Directory containing already verified raw snapshots/archives and license")
    parser.add_argument("--cache-dir", type=Path, default=ROOT / "work/phrase-sources")
    parser.add_argument("--output", type=Path, default=ROOT / "apps/web/public/phrases")
    parser.add_argument("--dictionary-manifest", type=Path, default=ROOT / "apps/web/public/data/manifest.json")
    parser.add_argument("--dictionary-db", type=Path, default=ROOT / "data/ecdict.sqlite")
    parser.add_argument("--no-download", action="store_true")
    parser.add_argument("--verify", action="store_true", help="Verify generated shards, source archives, license and coverage without downloading")
    args = parser.parse_args()
    config = json.loads(CONFIG.read_text("utf-8"))
    if args.verify:
        dictionary_version = json.loads(args.dictionary_manifest.read_text("utf-8"))["version"]
        result = verify_output(args.output, dictionary_version, config)
    else:
        build(config, args.dictionary_manifest, args.dictionary_db, args.output,
              args.cache_dir, args.source_dir, not args.no_download)
        result = verify_output(args.output)
    print(json.dumps(result, ensure_ascii=True, sort_keys=True))


if __name__ == "__main__":
    try:
        main()
    except Exception as error:
        print("ERROR: " + str(error), file=sys.stderr)
        sys.exit(1)
