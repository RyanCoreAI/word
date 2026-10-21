#!/usr/bin/env python3
"""Build a reproducible ECDICT SQLite database and browser dictionary packages.

Only Python's standard library is required. Raw input and generated packages
are build artifacts, not checked-in application source.
"""
import argparse
from contextlib import closing
import csv
import hashlib
import json
import os
from pathlib import Path
import re
import sqlite3
import sys
import time
import urllib.request
import uuid

ROOT = Path(__file__).resolve().parents[2]
DATA = ROOT / "data"
PUBLIC = ROOT / "apps/web/public/data"
LICENSES = ROOT / "apps/web/public/licenses"
COMMIT = "bc015ed2e24a7abef49fc6dbbb7fe32c1dadaf8b"
SOURCE_SHA = "1a6947e04785db63613a92e14903cdae7954f7e84860b10e68e5c7cbb3f9c3cf"
SOURCE_BYTES = 65933428
LICENSE_SHA = "f8552dd246f61a4e064569eae6194a01c6b3d63b03bf27c6ca863593c549ed0f"
BASE_URL = "https://raw.githubusercontent.com/skywind3000/ECDICT/" + COMMIT
FIELDS = "word phonetic definition translation pos collins oxford tag bnc frq exchange detail audio".split()
TAGS = {"zk", "gk", "cet4", "cet6", "ky", "toefl", "ielts", "gre"}
# This is deliberately a small, explicit list, not a frequency cutoff.
BASIC = frozenset("""a an the be is am are was were been being have has had do does did
i you he she it we they me him her us them my your his its our their mine yours ours theirs
myself yourself himself herself itself ourselves yourselves themselves
this that these those of to in on at for with by from as and or but not no yes
who whom whose what which when where why how can could will would shall should may might must
if so than then too very also just only still already again almost even else ever never always often
all any some both each every either neither other another such same own more most much many few less least
here there now today yesterday tomorrow away back up down out off over under into onto inside outside
before after between among about around during until since through without against across near next
one two three four five six seven eight nine ten eleven twelve thirteen fourteen fifteen sixteen
seventeen eighteen nineteen twenty thirty forty fifty sixty seventy eighty ninety hundred thousand
first second third last new old good bad big small large long short high low hot cold happy sorry
hello goodbye thanks thank please okay ok welcome bye
go come get make take give say tell ask know think see look hear listen speak read write
eat drink sleep walk run sit stand like love want need use work play help start stop open close
try put keep let call leave live move feel find bring turn show mean buy sell wait watch learn
man woman boy girl child children mother father mum mom dad sister brother son daughter family friend
people person name home house room door window school teacher student book pen paper desk chair
day week month year morning afternoon evening night hour minute time water food milk bread rice
dog cat bird fish red blue green black white yellow colour color sun moon rain snow
""".split())
POLICY = {"schema": 1, "frequencyMax": 20000, "basic": sorted(BASIC),
          "study": "lowercase single word; translation; exam tag or frq 1..20000; exclude valid-lemma inflections",
          "phonetic": "source text unchanged", "translation": "source text; literal backslash-n decoded"}
VERSION = "ecdict-" + SOURCE_SHA[:12] + "-" + hashlib.sha256(
    json.dumps(POLICY, sort_keys=True, separators=(",", ":")).encode()).hexdigest()[:12]
SINGLE = re.compile(r"^[a-z]+(?:-[a-z]+)*$")
WORD_KEYS = {"id", "word", "translation", "phonetic", "tags", "rank", "basic"}
SHARD_COUNT = 8000
SHARD_BYTES = 8 * 1024 * 1024


def digest(path):
    hasher = hashlib.sha256()
    with Path(path).open("rb") as source:
        for block in iter(lambda: source.read(1024 * 1024), b""):
            hasher.update(block)
    return hasher.hexdigest()


def json_bytes(value):
    return json.dumps(value, ensure_ascii=False, separators=(",", ":"), allow_nan=False).encode("utf-8")


def atomic_write(path, content):
    path = Path(path)
    path.parent.mkdir(parents=True, exist_ok=True)
    temporary = path.with_name(path.name + ".tmp-" + uuid.uuid4().hex)
    with temporary.open("wb") as target:
        target.write(content)
        target.flush()
        os.fsync(target.fileno())
    os.replace(str(temporary), str(path))


def download(url, target, expected_sha=None, expected_bytes=None):
    target = Path(target)
    if target.exists() and (expected_sha is None or digest(target) == expected_sha):
        if expected_bytes is None or target.stat().st_size == expected_bytes:
            print("Using verified cached input: " + target.name, flush=True)
            return target
    target.parent.mkdir(parents=True, exist_ok=True)
    for attempt in range(1, 5):
        temporary = target.with_name(target.name + ".part-" + uuid.uuid4().hex)
        try:
            request = urllib.request.Request(url, headers={"User-Agent": "Word-PWA-dictionary-build/1.0"})
            print("Downloading {} (attempt {}/4)".format(target.name, attempt), flush=True)
            total = 0
            with urllib.request.urlopen(request, timeout=60) as response, temporary.open("wb") as output:
                while True:
                    block = response.read(1024 * 1024)
                    if not block:
                        break
                    output.write(block)
                    total += len(block)
                    if total % (10 * 1024 * 1024) < len(block):
                        print("  downloaded {:.1f} MiB".format(total / 1024 / 1024), flush=True)
            if expected_bytes is not None and total != expected_bytes:
                raise ValueError("Unexpected source byte count: {}".format(total))
            if expected_sha is not None and digest(temporary) != expected_sha:
                raise ValueError("SHA-256 mismatch; refusing to publish unverified input")
            os.replace(str(temporary), str(target))
            return target
        except Exception as error:
            print("Download failed: {}".format(error), file=sys.stderr, flush=True)
            # A failed attempt is retained under the ignored data directory.
            if attempt == 4:
                raise
            time.sleep(min(2 ** attempt, 8))


def fetch():
    raw = download(BASE_URL + "/ecdict.csv", DATA / "raw/ecdict.csv", SOURCE_SHA, SOURCE_BYTES)
    license_path = download(BASE_URL + "/LICENSE", DATA / "raw/ECDICT-LICENSE.txt", LICENSE_SHA, 1063)
    license_text = license_path.read_text(encoding="utf-8")
    if not license_text.startswith("MIT License") or "Permission is hereby granted" not in license_text:
        raise ValueError("Unexpected upstream license; refusing to publish")
    return raw, license_path


def positive_int(value):
    try:
        number = int(value)
        return number if number > 0 else 0
    except (TypeError, ValueError):
        return 0


def lemma_from(exchange):
    for item in exchange.split("/"):
        if item.startswith("0:"):
            return item[2:]
    return None


def make_database(source, database):
    database.parent.mkdir(parents=True, exist_ok=True)
    with closing(sqlite3.connect(str(database))) as connection:
        return import_database(source, connection)


def import_database(source, connection):
    connection.execute("PRAGMA journal_mode=DELETE")
    connection.execute("PRAGMA synchronous=FULL")
    connection.execute("CREATE TABLE entry (" + ",".join(
        name + " TEXT NOT NULL" + (" PRIMARY KEY" if name == "word" else "") for name in FIELDS
    ) + ", single INTEGER NOT NULL, basic INTEGER NOT NULL, frq_num INTEGER NOT NULL, "
        "bnc_num INTEGER NOT NULL, lemma TEXT, inflection INTEGER NOT NULL DEFAULT 0, "
        "study INTEGER NOT NULL DEFAULT 0, rank INTEGER NOT NULL DEFAULT 0)")
    connection.execute("CREATE TABLE build_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL)")
    insert = "INSERT INTO entry (" + ",".join(FIELDS) + ",single,basic,frq_num,bnc_num,lemma) VALUES (" + ",".join("?" * 18) + ")"
    folded = set()
    case_duplicates = 0
    rows = 0
    with source.open("r", encoding="utf-8-sig", newline="") as stream:
        reader = csv.DictReader(stream)
        if reader.fieldnames != FIELDS:
            raise ValueError("Unexpected CSV schema: {}".format(reader.fieldnames))
        batch = []
        for row in reader:
            if None in row or any(row[field] is None for field in FIELDS):
                raise ValueError("Malformed CSV row {}".format(rows + 2))
            word = row["word"]
            if not word:
                raise ValueError("An empty word cannot provide a stable ID")
            folded_word = word.casefold()
            if folded_word in folded:
                case_duplicates += 1
            folded.add(folded_word)
            single = bool(SINGLE.fullmatch(word)) and bool(row["translation"].strip())
            batch.append(tuple(row[field] for field in FIELDS) + (
                int(single), int(folded_word in BASIC), positive_int(row["frq"]),
                positive_int(row["bnc"]), lemma_from(row["exchange"])))
            rows += 1
            if len(batch) == 5000:
                connection.executemany(insert, batch)
                batch = []
            if rows % 100000 == 0:
                print("Imported {} source rows".format(rows), flush=True)
        if batch:
            connection.executemany(insert, batch)
    connection.execute("UPDATE entry SET inflection=1 WHERE lemma IS NOT NULL AND lemma != word "
                       "AND EXISTS (SELECT 1 FROM entry AS base WHERE base.word=entry.lemma AND base.single=1)")
    valid_tag_sql = " OR ".join("(' ' || tag || ' ') LIKE '% " + tag + " %'" for tag in sorted(TAGS))
    connection.execute("UPDATE entry SET study=1 WHERE single=1 AND inflection=0 AND ((" + valid_tag_sql + ") OR frq_num BETWEEN 1 AND 20000)")
    ordered = connection.execute("SELECT word FROM entry ORDER BY CASE WHEN frq_num=0 THEN 2147483647 ELSE frq_num END, "
                                 "CASE WHEN bnc_num=0 THEN 2147483647 ELSE bnc_num END, word COLLATE BINARY").fetchall()
    connection.executemany("UPDATE entry SET rank=? WHERE word=?", ((index, row[0]) for index, row in enumerate(ordered, 1)))
    connection.execute("CREATE UNIQUE INDEX entry_rank ON entry(rank)")
    connection.execute("CREATE INDEX entry_study_rank ON entry(study,rank)")
    connection.executemany("INSERT INTO build_meta VALUES (?,?)", [
        ("version", VERSION), ("source_sha256", SOURCE_SHA), ("source_rows", str(rows)),
        ("case_insensitive_duplicates", str(case_duplicates)), ("policy", json.dumps(POLICY, sort_keys=True))])
    connection.commit()
    if connection.execute("PRAGMA integrity_check").fetchone()[0] != "ok":
        raise ValueError("SQLite integrity check failed")
    return rows


def word_record(row):
    source_tags = [tag for tag in row["tag"].split() if tag in TAGS]
    if not source_tags and row["study"]:
        source_tags.append("hf")
    return {"id": row["word"], "word": row["word"],
            "translation": row["translation"].replace("\\n", "\n"),
            "phonetic": row["phonetic"], "tags": source_tags,
            "rank": row["rank"], "basic": bool(row["basic"])}


def metadata(path, count, version):
    return {"file": version + "/" + path.name, "count": count,
            "bytes": path.stat().st_size, "sha256": digest(path)}


def write_shards(connection, destination):
    chunks = []
    records = []
    length = 2
    for row in connection.execute("SELECT * FROM entry ORDER BY rank"):
        encoded = json_bytes(word_record(row))
        if len(encoded) + 2 > SHARD_BYTES:
            raise ValueError("One dictionary record exceeds the shard size limit")
        if records and (len(records) >= SHARD_COUNT or length + len(encoded) + 1 > SHARD_BYTES):
            path = destination / "shard-{:04d}.json".format(len(chunks))
            path.write_bytes(b"[" + b",".join(records) + b"]")
            chunks.append(metadata(path, len(records), VERSION))
            records, length = [], 2
        records.append(encoded)
        length += len(encoded) + 1
    if records:
        path = destination / "shard-{:04d}.json".format(len(chunks))
        path.write_bytes(b"[" + b",".join(records) + b"]")
        chunks.append(metadata(path, len(records), VERSION))
    return chunks


def database_stats(connection):
    scalar = lambda sql: connection.execute(sql).fetchone()[0]
    return {"total": scalar("SELECT count(*) FROM entry"),
            "missingTranslation": scalar("SELECT count(*) FROM entry WHERE trim(translation)=''"),
            "missingPhonetic": scalar("SELECT count(*) FROM entry WHERE trim(phonetic)=''"),
            "caseInsensitiveDuplicates": int(scalar("SELECT value FROM build_meta WHERE key='case_insensitive_duplicates'")),
            "exactDuplicates": 0, "basicTotal": scalar("SELECT count(*) FROM entry WHERE basic=1"),
            "inflections": scalar("SELECT count(*) FROM entry WHERE inflection=1"),
            "studyCount": scalar("SELECT count(*) FROM entry WHERE study=1"),
            "studyBasic": scalar("SELECT count(*) FROM entry WHERE study=1 AND basic=1"),
            "studyMissingPhonetic": scalar("SELECT count(*) FROM entry WHERE study=1 AND trim(phonetic)=''"),
            "defaultStudyCount": scalar("SELECT count(*) FROM entry WHERE study=1 AND basic=0")}


def check_word(word):
    if not isinstance(word, dict) or set(word) != WORD_KEYS:
        raise ValueError("Invalid Word object keys")
    for name in ("id", "word", "translation", "phonetic"):
        if not isinstance(word[name], str):
            raise ValueError("Invalid Word string field: " + name)
    if not word["id"] or word["id"] != word["word"]:
        raise ValueError("Unstable Word ID")
    if not isinstance(word["tags"], list) or any(tag not in TAGS | {"hf"} for tag in word["tags"]):
        raise ValueError("Invalid tags")
    if type(word["basic"]) is not bool or type(word["rank"]) is not int or word["rank"] < 1:
        raise ValueError("Invalid Word rank or basic flag")


def checked_package(base, item):
    path = (base / item["file"]).resolve()
    if base.resolve() not in path.parents:
        raise ValueError("Manifest path escapes data directory")
    if path.stat().st_size != item["bytes"] or digest(path) != item["sha256"]:
        raise ValueError("Package checksum/size mismatch: " + item["file"])
    rows = json.loads(path.read_text(encoding="utf-8"))
    if not isinstance(rows, list) or len(rows) != item["count"]:
        raise ValueError("Package count mismatch: " + item["file"])
    for word in rows:
        check_word(word)
    return rows


def verify_packages(manifest, base):
    seen = set()
    rank = 0
    for item in manifest["shards"]:
        if item["bytes"] >= 10 * 1024 * 1024:
            raise ValueError("Shard exceeds 10 MiB")
        for word in checked_package(base, item):
            if word["id"] in seen or word["rank"] != rank + 1:
                raise ValueError("Duplicate ID or broken rank sequence")
            seen.add(word["id"])
            rank = word["rank"]
    if len(seen) != manifest["total"]:
        raise ValueError("Full dictionary total mismatch")
    study = checked_package(base, manifest["study"])
    if len(study) != manifest["studyCount"]:
        raise ValueError("Study total mismatch")
    study_ids = set()
    previous = 0
    for word in study:
        if word["id"] not in seen or word["id"] in study_ids or not word["translation"].strip():
            raise ValueError("Invalid study membership or missing translation")
        if word["rank"] <= previous:
            raise ValueError("Study is not frequency ordered")
        study_ids.add(word["id"])
        previous = word["rank"]
    return {"fullRecordsVerified": len(seen), "studyRecordsVerified": len(study),
            "shardsVerified": len(manifest["shards"]), "allChecksumsPassed": True}


def report(manifest, database):
    stats = manifest["stats"]
    lines = ["# 12 · 真实词典构建与验证报告", "", "此报告由 `tools/pipeline/pipeline.py` 成功构建后生成。数字来自本次实际导入，不沿用旧方案的预期词数。", "",
             "- 构建版本：`{}`".format(manifest["version"]),
             "- 固定来源：[ECDICT {}]({})".format(COMMIT, manifest["source"]["url"]),
             "- 原文件：{} 字节；SHA-256 `{}`，已验证。".format(SOURCE_BYTES, SOURCE_SHA),
             "- SQLite：`data/ecdict.sqlite`，{} 字节；保留全部 13 个原始字段，并附派生字段。".format(database.stat().st_size), "",
             "| 实际检查 | 结果 |", "| --- | --- |"]
    labels = {"total": "源 CSV / SQLite / 全分片词条", "exactDuplicates": "完全重复 ID", "caseInsensitiveDuplicates": "忽略大小写后重复",
              "missingTranslation": "全词库中文释义为空", "missingPhonetic": "全词库音标为空", "basicTotal": "全词库显式基础词", "inflections": "有有效原形的变形词",
              "studyCount": "完整学习包词条", "studyBasic": "学习包显式基础词", "defaultStudyCount": "学习包过滤基础词后", "studyMissingPhonetic": "学习包缺失音标"}
    lines += ["| {} | {:,} |".format(labels[key], stats[key]) for key in labels]
    lines += ["", "- 学习包：{} 字节，SHA-256 `{}`。".format(manifest["study"]["bytes"], manifest["study"]["sha256"]),
              "- 全量分片：{} 片，合计 {} 字节；最大分片 {} 字节。".format(len(manifest["shards"]), sum(item["bytes"] for item in manifest["shards"]), max(item["bytes"] for item in manifest["shards"])),
              "- 已逐片重新解析 JSON、核验 SHA-256 / 字节数 / 条目数、稳定 ID 唯一性、完整排名及学习包归属。", "",
              "## 当前规则", "", "学习包保留有中文释义的小写单词（允许连字符），选择任一源考试标签或 `frq` 1–20,000 的词；仅从学习包排除具有有效原形的变形词。完整词典没有按这些规则删词。",
              "", "基础词只使用源码中的明确名单，不把中考标签或词频前 2,000 全部判为基础词。用户额外跳过单词属于学习状态，不改词典源数据。", "",
              "`translation` 保留原中文和词性，仅把源数据字面的 `\\n` 转为显示换行；`phonetic` 保留原文和多读音，展示时应标为“词典音标”，不能声称已校准为英音或美音。缺失释义和音标在全库中保留为空字符串，不造内容。", "",
              "排序为 `frq`（无排名置后）、`bnc`（无排名置后）、原始词条字典序，rank 是全库稳定的连续序号。", "",
              "## 重复构建与验证", "", "```sh", "python tools/pipeline/pipeline.py build", "python tools/pipeline/pipeline.py verify", "python -m unittest discover -s tools/pipeline -p 'test_*.py'", "```", "",
              "`build` 下载固定版本并核验源 SHA，写入新 SQLite，构建到暂存目录，全部核验成功后才发布版本目录并原子替换 manifest。网络失败、解析失败或校验失败不会替换现有有效 manifest。旧版本文件保留，供旧缓存恢复。", "",
              "原始 CSV、完整 SQLite 与大 JSON 分片是被忽略的构建产物，发布前必须运行 build；仓库保留管线、测试、来源许可和本报告。", "",
              "## 限制", "", "这些校验证明导入完整性和可复现性，不代表逐条人工审校过释义、音标、考试大纲或词频时效性。ECDICT 仓库提供 MIT 许可，原许可文本随应用提供。没有使用 CMUdict 生成另一套口音，也没有生成或附带音频。", ""]
    atomic_write(ROOT / "docs/12-dictionary-report.md", "\n".join(lines).encode("utf-8"))


def build():
    raw, license_path = fetch()
    PUBLIC.mkdir(parents=True, exist_ok=True)
    manifest_path = PUBLIC / "manifest.json"
    database = DATA / "ecdict.sqlite"
    if manifest_path.exists() and database.exists():
        existing = json.loads(manifest_path.read_text(encoding="utf-8"))
        if existing.get("version") == VERSION:
            verify()
            report(existing, database)
            print("Existing build verified; no files replaced", flush=True)
            return
    stage = PUBLIC / (".building-" + uuid.uuid4().hex)
    stage.mkdir()
    version_directory = stage / VERSION
    version_directory.mkdir()
    staged_db = DATA / ("ecdict.building-" + uuid.uuid4().hex + ".sqlite")
    make_database(raw, staged_db)
    connection = sqlite3.connect(str(staged_db))
    connection.row_factory = sqlite3.Row
    stats = database_stats(connection)
    print("Exporting {} complete records and {} study records".format(stats["total"], stats["studyCount"]), flush=True)
    shards = write_shards(connection, version_directory)
    study = [word_record(row) for row in connection.execute("SELECT * FROM entry WHERE study=1 ORDER BY rank")]
    study_path = version_directory / "study.json"
    study_path.write_bytes(json_bytes(study))
    connection.close()
    license_name = "ECDICT-" + COMMIT[:12] + "-LICENSE.txt"
    manifest = {"version": VERSION, "source": {"name": "ECDICT", "commit": COMMIT,
                "url": BASE_URL + "/ecdict.csv", "sha256": SOURCE_SHA, "bytes": SOURCE_BYTES},
                "total": stats["total"], "studyCount": stats["studyCount"],
                "study": metadata(study_path, len(study), VERSION), "shards": shards,
                "license": {"name": "MIT", "file": "/licenses/" + license_name,
                            "sourceUrl": BASE_URL + "/LICENSE", "sha256": digest(license_path)},
                "stats": stats, "policy": POLICY}
    print(json.dumps(verify_packages(manifest, stage)), flush=True)
    final_directory = PUBLIC / VERSION
    if final_directory.exists():
        # Verify an orphaned build from an interrupted publication before reusing it.
        verify_packages(manifest, PUBLIC)
    else:
        if PUBLIC.resolve() not in version_directory.resolve().parents or final_directory.parent.resolve() != PUBLIC.resolve():
            raise ValueError("Publication path escapes the generated data directory")
        os.replace(str(version_directory), str(final_directory))
    atomic_write(LICENSES / license_name, license_path.read_bytes())
    os.replace(str(staged_db), str(database))
    atomic_write(manifest_path, json_bytes(manifest))
    report(manifest, database)
    print(json.dumps(stats, ensure_ascii=False, indent=2), flush=True)
    print("Published " + VERSION, flush=True)


def verify():
    manifest = json.loads((PUBLIC / "manifest.json").read_text(encoding="utf-8"))
    if manifest["version"] != VERSION or manifest["source"]["sha256"] != SOURCE_SHA:
        raise ValueError("Artifacts do not match the current pinned source and policy; rebuild")
    if digest(DATA / "raw/ecdict.csv") != SOURCE_SHA:
        raise ValueError("Cached source checksum mismatch")
    verification = verify_packages(manifest, PUBLIC)
    connection = sqlite3.connect(str(DATA / "ecdict.sqlite"))
    if connection.execute("PRAGMA integrity_check").fetchone()[0] != "ok":
        raise ValueError("SQLite integrity check failed")
    if database_stats(connection) != manifest["stats"]:
        raise ValueError("SQLite statistics differ from generated packages")
    if int(connection.execute("SELECT value FROM build_meta WHERE key='source_rows'").fetchone()[0]) != manifest["total"]:
        raise ValueError("Imported source row count differs from published dictionary total")
    if connection.execute("SELECT value FROM build_meta WHERE key='version'").fetchone()[0] != VERSION:
        raise ValueError("SQLite version mismatch")
    connection.close()
    if digest(LICENSES / Path(manifest["license"]["file"]).name) != manifest["license"]["sha256"]:
        raise ValueError("License checksum mismatch")
    print(json.dumps(verification, indent=2), flush=True)
    return verification


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("command", choices=("fetch", "build", "verify"))
    arguments = parser.parse_args()
    {"fetch": fetch, "build": build, "verify": verify}[arguments.command]()


if __name__ == "__main__":
    try:
        main()
    except Exception as error:
        print("ERROR: " + str(error), file=sys.stderr, flush=True)
        sys.exit(1)
