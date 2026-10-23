# Historical lexical supplement (retired from the product)

On 2026-10-23 the user rejected the quality of token-associated phrases and
word-sense substitutions. This generator and its source contracts are retained
only as history; neither its packs nor source archives are deployed or rebuilt
in the current CI. The product uses explicitly reviewed headword collocations
in `apps/web/src/data/collocations.ts`; `browser-smoke.mjs` tests that replacement.

## Previous implementation: source-backed phrases and selected word senses

This standard-library-only pipeline builds an optional lexical supplement. It
reads the existing ECDICT database without modifying the dictionary, study
queue, pronunciation, learning counters or saved progress. Missing coverage
stays missing. It does not generate a phrase corpus, example sentences,
frequency scores or synonym relations from similar Chinese translations.

## Frozen inputs and separate licenses

`sources.json` pins six source files and their separately hashed public archives:

| Source | Original bytes | Published archive bytes | Data license |
| --- | ---: | ---: | --- |
| Chinese Wiktionary, traditional English heading | 63,127,080 | 9,011,506 | CC BY-SA 4.0 |
| Chinese Wiktionary, simplified English heading | 21,928,316 | 3,506,469 | CC BY-SA 4.0 |
| ECDICT exact original CSV | 65,933,428 | 22,483,297 | MIT |
| OMW pinned WordNet 3.0 English lemma table | 5,843,130 | 1,480,125 | WordNet 3.0 |
| Official OMW English 2.0 archive | 11,288,332 | 11,288,332 | WordNet 3.0 |
| Original Chinese editorial sense selections | 41,390 | 4,823 | WordNet-derived editorial material |

The Wiktionary English subsets were extracted by Kaikki/Wiktextract on
2026-10-20 from the 2026-10-01 Chinese Wiktionary dump. Both language headings
contain English entries, not two Chinese script conversions of one identical
dataset. Original Chinese spelling remains. Source pages are the
[traditional heading](https://kaikki.org/zhwiktionary/%E8%8B%B1%E8%AA%9E/index.html)
and [simplified heading](https://kaikki.org/zhwiktionary/%E8%8B%B1%E8%AF%AD/index.html).
Their deprecated upstream URLs may change; builds prefer the frozen public
archives and reject changed bytes rather than silently accepting a new dump.

ECDICT is pinned to commit `bc015ed2e24a7abef49fc6dbbb7fe32c1dadaf8b`.
English lemma membership and exact physical source lines come from OMW commit
`406bf83b3c507a3d1f26e88252d5d66893fd36bf`. Selected English definitions are
checked against the official, hash-pinned `omw-en-2.0.tar.xz`, using the same
WordNet 3.0 synset IDs. No COW Chinese translations were accepted.

Archives are published under `/phrases/sources/<raw-sha256>.<format>`.
Gzip archives use no filename, mtime=0 and level=9; the official `.tar.xz` is
published unchanged. Every asset is below 25 MiB. Recreating a gzip with a
different zlib version must still match the pinned compressed hash; otherwise
use the frozen mirror. Each raw input and archive is checked independently.
The tracked small editorial input can also be recovered directly from this
repository; its mutable branch URL is accepted only with its exact pinned hash.
No credentials, paid service or new account is needed.

Complete CC BY-SA 4.0, ECDICT MIT and WordNet notices are published separately
under `/phrases/licenses/`. A versioned `ATTRIBUTION.md` records contributors,
source pages, pins and transformations. CC BY-SA covers the Wiktionary portion;
it does not relicense ECDICT or WordNet. The short Chinese word-sense meanings
and usage restrictions are original editorial notes offered under WordNet's
use/copy/modify/distribute permission, with the original and modification
notices retained. They are not Princeton's Chinese text or COW translations.
Application-code licensing remains separate. Source archives remain unchanged;
source examples, audio and images are not incorporated into displayed content.

## Build, verify and recover

Build the dictionary first. Use Python 3.12+; no pip packages are needed:

```sh
python tools/pipeline/build.py
python -m unittest discover -s tools/phrases -p 'test_*.py' -v
python tools/phrases/build.py
python tools/phrases/build.py --verify
```

Cache files live in ignored `work/phrase-sources/`; generated web assets live in
ignored `apps/web/public/phrases/`. Raw corpora, compressed source archives,
database files and generated shards are not committed. The small original
editorial selections, their source pins and the review audit are tracked code
inputs. An offline build may use a directory containing the original filenames
from `sources.json`, the pinned archive filenames and the three license texts:

```sh
python tools/phrases/build.py --source-dir /path/to/verified-inputs --no-download
```

`--source-dir` and `--cache-dir` never relax a hash. Corrupt local files fail
explicitly. A new machine normally downloads the public frozen mirrors; fixed
public original sources are a fallback. Publish the frozen source and license
assets before enabling CI for a new source pin. The standalone editorial checker
can also verify exact English membership/definitions from its bounded sources:

```sh
python tools/phrases/check_editorial.py --fetch
```

The XML verifier streams only `omw-en/omw-en.xml` from the 11.3 MB archive,
without extracting arbitrary files. It checks exact same-ID membership, source
line, POS and English definition for all selected word senses. These checks
prove provenance and declared scope, not linguistic perfection. The checker's
`productionBaseline` comparison records the historical schema 1 baseline; it
is not an assertion that schema 2 is deployed.

The main verifier checks all 26 shards, counts/bytes/SHA-256, all six archives
and their raw bytes, all license texts, attribution, bounded fields, exact source
URLs/IDs and source-derived records. ECDICT records must equal the corresponding
pinned CSV entry; editorial records must equal the pinned original selections.
A candidate manifest is fully verified before atomically replacing the active
manifest. Immutable version directories are retained. The version hashes the
dictionary version, source pins, policy, builder, English verifier, editorial
source profile and ECDICT audit; policy or code changes require a rebuild.

## Selection and teaching limitations

All phrases must have 2–6 lowercase ASCII whole tokens, at most 96 characters,
a traceable source record and Chinese meaning of at most 180 characters.
Association uses exact whole tokens already present as lowercase dictionary IDs,
without stemming, substring matches or fuzzy replacement. A word has at most
6 different phrase spellings, 3 senses per phrase, 4 substitutes per sense and
3 editorial word senses. Ordering prioritizes explicit reviewed phrase choices,
then supported source synonyms, retained dictionary quality flags, shorter token
count and ASCII spelling/POS. Duplicate entries do not create duplicate cards.
For a duplicated spelling, source-supported synonym records take precedence
over ordinary ECDICT quality flags; an explicit reviewed addition still wins.
The complete selected source record is retained. Chinese meanings and relations
from separate sources are never joined to make a more complete-looking card.

For Wiktionary, an allowed real POS and source Chinese gloss are required.
Word/alternate forms, capitalized names and source-marked old, rare,
nonstandard, vulgar, offensive or derogatory senses are excluded. Internet
usage is rejected at the entry, sense or relation where tagged; unrelated normal
senses in the same entry remain eligible. A finite exact-token filter also
excludes `shit`, `fuck`, `piss` and listed derivatives, including optional
possessive `'s`, in phrases and substitutes. It does not use substring guesses.
The reviewed nonstandard `for sake of` is excluded exactly. These are finite
filters, not a claim that every remaining source entry has had human review.

Wiktionary synonyms are retained only when the relation uniquely names one real
Chinese source sense after punctuation/whitespace normalization, or an original
single-sense entry supplies an unqualified synonym. Dropping another sense does
not make a multi-sense original single-sense. The substitute inherits that
limited source meaning as `meaningBasis: "shared-sense"`; an independent Chinese
translation of every sense is not claimed. Source register/region tags remain.

ECDICT candidates need a retained Collins star, Oxford flag, IELTS tag, or one
of four explicitly reviewed exact additions: `carry out`, `bring forward`,
`take into account`, `economic growth`. The flags are historical fields in
ECDICT, not a live Oxford/Collins API, corpus frequency or official IELTS list.
The full exact source translation is preserved, with literal backslash-newline
markers decoded; it is not silently narrowed to a WordNet sense. The generic
POS is `phrase`, and **ECDICT phrases have no inferred synonym substitutions**.
Certain specialist/network labels and explicit doubtful translations are omitted.
`ecdict_audit.json` records 29 spot checks, including all four additions and
evenly spaced candidates. Five doubtful results were excluded; `bring about`
was independently excluded earlier. This is an audit sample, not a claim that
all 735 accepted ECDICT entries were manually checked.

The word-sense set deliberately contains only **48 selected words / 24 exact
WordNet 3.0 synsets / 48 directed substitutions**. Every Chinese explanation
is explicitly `meaningBasis: "editorial"`, with the exact English definition
and a Chinese usage restriction retained. Substitutes share that limited meaning
with `relationBasis: "exact-synset"`. For example, important/significant excludes
blanket statistical-significance substitution, and accurate/precise notes the
measurement distinction. Same-synset membership does not imply identical grammar,
register or suitability in every sentence. The IELTS preparation tag is editorial
selection, not official exam frequency, a scoring promise or a complete list.
No example sentences or bulk machine-generated Chinese mappings were added.

No source here establishes common-use ranking for the complete dataset.
Dictionary order and star flags must not be described as corpus frequency.
UI wording should be “短语与近义表达” and distinguish source meanings, shared
meanings and editorial notes. Function words and specialist compounds can occur;
failure and honest empty states must remain available.

## Browser contract (schema 2)

`/phrases/manifest.json` records the content `version`, exact `dictionaryVersion`,
six licensed `sources[]` with raw and archive descriptors, 26 letter `shards`,
measured `coverage`, `policy`, `licenses[]` and versioned `attribution`. The legacy
`license` descriptor is retained for the CC BY-SA component only. Every source's
license is represented in `licenses[]`; there is no mixed-data blanket license.
Each shard descriptor carries file, bytes, SHA-256 and count of word IDs.

A shard maps exact word IDs to `{ "phrases": [...], "wordSenses": [...] }`.
Either array may be empty, but not both. Phrase records carry `text`, `pos`,
`sourceUrl`, `sourceId`, `tags` and `senses`. Each sense carries `id`, Chinese
`meaning`, source fields, tags and `substitutes`. A phrase substitute includes
`text`, shared `meaning`, `meaningBasis: "shared-sense"`, relation basis
`single-source-sense` or `exact-source-sense`, source fields and tags.
Wiktionary URLs are exact entry pages; ECDICT URLs point to the fixed commit's
exact CSV physical line. All provenance fields are required.

Each word-sense record has the following form (one real selected entry):

```json
{
  "id": "pwn30-02161432-a",
  "pos": "adj",
  "meaning": "重要的；意义重大的",
  "meaningBasis": "editorial",
  "definition": "important in effect or meaning",
  "usage": "仅指意义或影响重大。significant表示统计学上的显著时，不能一概替换为important。",
  "sourceId": "omw-pwn30-2.0",
  "sourceUrl": "https://github.com/omwn/omw-data/blob/406bf83b3c507a3d1f26e88252d5d66893fd36bf/wns/eng/wn-data-eng.tab#L20636",
  "editorialSourceId": "yanxai-editorial-pwn30-20261022",
  "tags": ["编辑核验", "雅思备考"],
  "substitutes": [{
    "text": "significant",
    "meaning": "重要的；意义重大的",
    "meaningBasis": "shared-sense",
    "relationBasis": "exact-synset",
    "sourceId": "omw-pwn30-2.0",
    "sourceUrl": "https://github.com/omwn/omw-data/blob/406bf83b3c507a3d1f26e88252d5d66893fd36bf/wns/eng/wn-data-eng.tab#L20636",
    "tags": []
  }]
}
```

Meanings are at most 180 characters, English definitions 400 and usage notes
240. Tags contain at most 16 sorted unique strings of 1–48 characters. WordNet
IDs use `pwn30-<8 digits>-<n|v|a|r>`. Fetch only the needed first-letter shard;
normal study must not download source corpora or block on optional supplement
failure. The frontend retains schema 1 cached data without rewriting its bytes,
normalizing missing `wordSenses` to an empty array when read.

## Verified schema 2 coverage

For dictionary `ecdict-1a6947e04785-220cd506c15f`, current local verified build
`lexical-zh-690ef2bf155346881a4b` has:

| Measurement | Count |
| --- | ---: |
| Raw Wiktionary English entries | 96,975 |
| ECDICT raw entries / marked multiword candidates | 770,611 / 886 |
| Accepted exact ECDICT phrase spellings, including 4 explicit additions | 735 |
| Eligible combined unique phrase spellings before association / word limits | 9,682 |
| Eligible phrase spellings with supported substitutions | 1,250 |
| Eligible source substitute links after per-sense limits | 2,303 |
| Published distinct phrase spellings | 8,834 |
| Published distinct source-sense / phrase-substitute relations | 2,291 |
| Published phrase links across word IDs | 14,076 |
| Editorial words / exact synsets / directed substitutions | 48 / 24 / 48 |
| Dictionary word IDs with any content / with phrases / with word senses | 6,163 / 6,124 / 48 |
| Learning words with any content / with phrases / total | 3,913 / 3,875 / 19,106 |
| Default learning words with any content / with phrases / total | 3,671 / 3,633 / 18,787 |
| Learning words with any substitutes / with editorial word senses | 1,370 / 47 |
| Default learning words with any substitutes / with editorial word senses | 1,213 / 45 |
| Ambiguous source substitute links rejected | 449 |

All 26 shards total 7,294,646 bytes; the largest is 942,289 bytes. Counts above
are actual distinct published content, not 735 phrases all guaranteed to be new:
duplicates and per-word limits intentionally reduce the displayed subset.
Compared with the schema 1 baseline, 151 additional learning words and 144
additional default learning words have some content. Neither whole-dictionary
coverage nor frequency ranking is claimed. This records a local build and does
not by itself assert production deployment. The release process must verify its
own manifest and deployed bytes.
