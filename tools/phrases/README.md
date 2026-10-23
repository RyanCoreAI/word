# Source-backed phrase supplement

This standard-library-only pipeline builds an optional, separately licensed
phrase supplement. It does not change ECDICT, the study queue, pronunciation,
learning counters, or saved progress. Missing coverage remains missing; it never
generates phrases, translations, synonym relations, or frequency scores.

## Frozen public sources and license

`sources.json` pins the exact bytes and SHA-256 of two Chinese Wiktionary English
subsets extracted by Kaikki/Wiktextract on 2026-10-20 from the 2026-10-01 dump:

- [Traditional language heading](https://kaikki.org/zhwiktionary/%E8%8B%B1%E8%AA%9E/index.html):
  63,127,080 original JSONL bytes; 9,011,506 frozen gzip bytes.
- [Simplified language heading](https://kaikki.org/zhwiktionary/%E8%8B%B1%E8%AF%AD/index.html):
  21,928,316 original JSONL bytes; 3,506,469 frozen gzip bytes.

Both headings contain English entries (`lang_code=en`); they are not alternative
Chinese script conversions of one identical dataset. Original Chinese spelling
is retained. There is no inference from similar Chinese translations.

The upstream postprocessed download URLs are deprecated and may change. The
first release publishes unchanged JSONL snapshots compressed with no filename,
mtime=0, level=9 under `/phrases/sources/<original-jsonl-sha256>.jsonl.gz`.
`sources.json` pins the compressed bytes separately. Later builds prefer these
frozen public mirrors; original URLs are accepted only if their bytes still
match. If a host's zlib produces different compressed bytes, use the frozen
archive rather than changing the pin. No credentials or account are required.

[Kaikki's source notice](https://kaikki.org/zhwiktionary/) retains Wiktionary's
CC BY-SA / GFDL terms. This supplement selects **CC BY-SA 4.0** for redistribution
and the adapted data. The entire pinned CC BY-SA 4.0 legal text is published in
`/phrases/licenses/CC-BY-SA-4.0.txt`, alongside a versioned `ATTRIBUTION.md` that
names Chinese Wiktionary contributors, Kaikki/Wiktextract, extraction versions,
source pages, hashes, archives and every transformation. Each retained meaning
and relation also links back to its original Wiktionary page. Source quotations,
audio and images are not incorporated into the UI supplement; source archives
remain unchanged. The supplement must not be described as MIT; its data license
is separate from application code and ECDICT.

## Build and verify

Build the existing dictionary first. Use Python 3.12+; no pip packages are needed:

```sh
python tools/pipeline/build.py
python -m unittest discover -s tools/phrases -p 'test_*.py' -v
python tools/phrases/build.py
python tools/phrases/build.py --verify
```

Cache files live under ignored `work/phrase-sources/`. Generated web assets live
under ignored `apps/web/public/phrases/`. No raw corpus, gzip archive, user data
or generated shard is committed. A first offline build can use a local directory
containing the original filenames from `sources.json`, pinned gzip filenames,
and `CC-BY-SA-4.0.txt`:

```sh
python tools/phrases/build.py --source-dir /path/to/verified-snapshots --no-download
```

`--source-dir` and `--cache-dir` do not relax hashes. Corrupt local files fail
explicitly; they are not silently overwritten with unrelated upstream content.
Verification checks all 26 shards, exact counts/bytes/SHA-256, source archives
including decompressed bytes, the complete license, attribution, schema,
bounded strings/lists, source IDs/URLs, token associations and shared meanings.
The version includes the dictionary version, source pins, selection policy and
builder SHA-256. A policy or implementation change requires rebuilding.
Writes use a sibling partial file and atomic replacement; existing immutable
version directories are retained.

## Selection and honest limits

Phrases must be lowercase ASCII English with 2–6 space-separated whole tokens,
at most 96 characters, an allowed real part of speech, a traceable source sense
ID and a Chinese gloss of at most 180 characters. Contractions/possessives count
as one token. Capitalized names, unsupported/unknown POS, word/alternate forms,
and source-marked old/obsolete/rare/nonstandard/vulgar/offensive/derogatory senses
are excluded. Internet-usage tags are excluded per sense or synonym relation;
other untagged senses in the same entry remain eligible. The builder also
publishes a finite editorial exclusion list for explicit `shit`, `fuck`, `piss`
tokens and common derivatives, matching whole tokens (including an optional
possessive `'s`) in both phrase and substitute text. This is not substring
filtering: ordinary words such as `shiitake` remain eligible. The reviewed
nonstandard expression `for sake of` is excluded exactly; `for the sake of` is
not rewritten into the source or excluded when genuinely present. Raw snapshots
are unchanged. These are conservative source-tag and finite editorial filters,
not a claim that all remaining source material has been manually reviewed or
that a general offensive-language classifier is present.

A source-provided synonym is included only when its `sense` uniquely equals an
actual gloss after removing whitespace/punctuation, or the original entry has
exactly one sense and its synonym is unqualified. A filtered second sense does
not turn a multi-sense source into a single-sense source. Ambiguous relations
are dropped. The replacement's Chinese meaning comes from the **shared source
sense**, explicitly labelled `meaningBasis: "shared-sense"`; it is not an
independently verified translation of every sense of the replacement. Style and
region tags remain visible data. Related expressions are not guaranteed to be
interchangeable in every sentence or grammatical construction.

Association uses exact whole tokens that already exist as lowercase ECDICT IDs.
It performs no stemming, substring matching or fuzzy replacement. Per word,
supported synonym content is ordered first, then shorter token count, then
ASCII spelling/POS, with at most 6 unique phrase spellings, 3 source senses per
phrase and 4 substitutes per sense. When duplicate source/POS entries exist,
the record with more supported sense relations wins, then source ID order.
This deliberately selects a bounded subset of meanings.

No available source supplies a reliable common-use rank here. Dictionary order
is not frequency. UI wording should be **“短语与近义表达”**, not a claim that all
entries are common or that every learning word is covered. Function words and
specialist compound nouns may occur. An empty state is required.

## Browser contract (schema 1)

`/phrases/manifest.json` contains:

- `schemaVersion`, content-derived `version`, exact `dictionaryVersion`.
- `sources[]`: source ID/name, original/page URLs, raw bytes/SHA-256, extraction
  and dump dates, selected license, and `archive` file/bytes/SHA-256/mirror URL.
- `license` and `attribution`: file/bytes/SHA-256; license additionally name/URL.
- `shards`: exactly keys `a` through `z`, each file/bytes/SHA-256/count. Count is
  the number of word IDs in the map; an empty letter is `{}` with count 0.
- `coverage`: measured source, retained phrase and actual dictionary/study counts,
  plus explicit `frequencyRanked=false` and `completeDictionaryCoverage=false`.
- `policy`: the published selection rules and limits.

Each shard maps an exact `wordId` to:

```json
{
  "phrases": [{
    "text": "take a break",
    "pos": "verb",
    "sourceUrl": "https://zh.wiktionary.org/wiki/take_a_break",
    "sourceId": "kaikki-zh-en-traditional-20261020",
    "tags": [],
    "senses": [{
      "id": "zh-take_a_break-en-verb-rfCSu08Q",
      "meaning": "休息一下",
      "sourceUrl": "https://zh.wiktionary.org/wiki/take_a_break",
      "sourceId": "kaikki-zh-en-traditional-20261020",
      "tags": [],
      "substitutes": [{
        "text": "have a break",
        "meaning": "休息一下",
        "meaningBasis": "shared-sense",
        "relationBasis": "single-source-sense",
        "sourceUrl": "https://zh.wiktionary.org/wiki/take_a_break",
        "sourceId": "kaikki-zh-en-traditional-20261020",
        "tags": []
      }]
    }]
  }]
}
```

`relationBasis` is `single-source-sense` or `exact-source-sense`. All provenance
fields are required; tags/substitutes may be empty arrays, while published words
have 1–6 phrases and each phrase has 1–3 senses. Tags contain at most 16 sorted
unique strings of 1–48 characters. Source sense IDs contain 1–200 characters.
Fetch only the requested first-letter shard; never download source snapshots
or all phrases during normal word switching. Keep failure/empty states distinct
and never block the existing study workflow on supplemental data.

## Verified first-build coverage

For `ecdict-1a6947e04785-220cd506c15f`, the pinned snapshots actually yielded:

| Measurement | Count |
| --- | ---: |
| Raw English source entries | 96,975 |
| Eligible unique phrase spellings before association / per-word limits | 9,142 |
| Eligible phrases with retained substitute links | 1,250 |
| Retained source substitute links after per-sense limits | 2,303 |
| Published unique phrase spellings after association / per-word limits | 8,398 |
| Published unique source-sense / substitute relations | 2,291 |
| Word IDs with published phrases | 5,955 |
| Learning words with phrases / total | 3,762 / 19,106 |
| Default learning words with phrases / total | 3,527 / 18,787 |
| Learning words with substitutes | 1,325 |
| Default learning words with substitutes | 1,170 |
| Ambiguous substitute links rejected | 449 |

All 26 shards total 6,850,003 bytes; the largest is below 900 KB. These figures
describe this pipeline and frozen inputs, not an external claim of linguistic
completeness. `--verify` reports the current actual counts. Real examples include
`because of → due to` (由於), `take a break → have a break` (休息一下),
`by the way → incidentally` (順便問一句，順便說一句), and
`way of life → lifestyle` (生活方式). Some common items, including `carry out`
and `elaborate on`, are missing from these snapshots and are not fabricated.
