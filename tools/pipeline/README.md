# ECDICT browser data pipeline

Requires Python 3.7+ with the standard-library `ssl`, `sqlite3`, `csv`, and
`urllib` modules. There are no pip dependencies. Run from the repository root:

```sh
python tools/pipeline/pipeline.py fetch
python tools/pipeline/pipeline.py build
python tools/pipeline/pipeline.py verify
python tools/pipeline/articles.py build
python tools/pipeline/articles.py verify
python -m unittest discover -s tools/pipeline -p 'test_*.py'
```

`build` includes `fetch`. It verifies the pinned ECDICT commit's CSV bytes and
SHA-256 before importing **every source record and all 13 original fields** into
`data/ecdict.sqlite`. The SQLite file is a local build/audit artifact; the PWA
imports the exported JSON into IndexedDB. No live database or API is required.

On Windows, if `python` points at an incomplete Python bundled with another
application, use a complete Python interpreter's absolute path. Do not disable
TLS certificate checking to work around network errors.

## Generated outputs

- `data/raw/ecdict.csv`: pinned raw input, verified before use.
- `data/raw/ECDICT-LICENSE.txt`: upstream license from the same commit.
- `data/ecdict.sqlite`: complete local dictionary and derived columns.
- `apps/web/public/data/manifest.json`: published only after full verification.
- `apps/web/public/data/<version>/study.json`: the complete study set.
- `apps/web/public/data/<version>/shard-0000.json`, etc.: **all** source records.
- `apps/web/public/data/article-manifest.json`: reading dictionary manifest, pinned source/license and per-asset integrity metadata.
- `apps/web/public/data/<version>/article-v1-{words,lemmas}-<content-sha-prefix>.json`: bounded reading entries and attested inflection candidates.
- `apps/web/public/licenses/ECDICT-<commit-prefix>-LICENSE.txt`: upstream license.
- `docs/12-dictionary-report.md`: measured counts, sizes, and integrity results.

Raw inputs, SQLite, and generated JSON must be ignored by Git. The web build
must generate them before bundling `public/`; a missing package is a build
failure, never an invitation to substitute sample words. Static hosting must
allow the total generated deployment size. Each shard is at most 8 MiB and
normally contains 8,000 entries; the study file is fetched first, other shards
only on demand or when the user chooses a complete offline download.

## Browser contract

Every entry in `study.json` and each shard has exactly this shape:

```ts
type Word = {
  id: string;            // Exact source word; stable and case-preserving.
  word: string;
  translation: string;   // Original Chinese/part-of-speech text; \n decoded.
  phonetic: string;      // Unmodified source phonetic text, including variants.
  tags: string[];        // zk/gk/cet4/cet6/ky/toefl/ielts/gre; derived hf where applicable.
  rank: number;          // Full dictionary rank; study ranks need not be consecutive.
  basic: boolean;        // Only the explicit BASIC list, not all frequent words.
};
```

`manifest.json` contains `version`, `source`, `total`, `studyCount`, `study`,
`shards`, `license`, `stats`, and `policy`. `study` and each element of `shards`
have `{file, count, bytes, sha256}`. Their `file` paths are relative to `/data/`.
`source` is `{name, commit, url, sha256, bytes}`. `license` is
`{name, file, sourceUrl, sha256}` with a root-relative `/licenses/` file path.

Missing translations and phonetics are empty strings in the full dictionary.
Study words must have a translation. No generated definitions, fake meanings,
or invented pronunciation labels are added. Label phonetic text as dictionary
phonetics, not separately validated British/American IPA. Audio is independent.

## Selection and durability

The study set comprises lowercase words (hyphens allowed) with translations
and either an exam tag or source `frq` rank 1–20,000. Inflected entries are
excluded only when their explicit lemma exists and is a valid translated
single word. Complete dictionary shards retain inflections, phrases, proper
names, and untranslated entries. User skip lists belong in learning state.

Builds use temporary files, a fresh SQLite database, and a staged version
directory. Generated output is re-read and checked before the final manifest
is atomically replaced. Existing version directories are never overwritten;
old packages remain valid for cached manifests. Interrupted staging files are
ignored and retained for diagnosis. Repeating an unchanged build verifies and
reuses the current output. Changing source or selection policy changes the
version; conversion code changes must also increment `POLICY.schema`.

The downloaded content is community dictionary data. SHA verification checks
reproducibility, not linguistic accuracy or currency of exam labels.

## Reading dictionary

After the main build, `articles.py build` reads its fixed-version SQLite source
and selects translated lowercase single words (hyphens allowed) that are in
the study set, the explicit basic list, or source `frq`/`bnc` ranks 1–50,000.
This keeps common inflected entries and basics such as `a` and `the` available
without a complete-dictionary download. It does not change the study queue.
The current pinned source yields 48,819 records and 37,671 inflected forms,
8,836,679 bytes total. These are measured build figures, not completeness or
translation-quality guarantees.

Lemma candidates come only from the source `exchange` field: explicit `0`
roots and inverse `p/d/i/3/r/t/s` forms. Both spellings must occur in the pinned
dictionary; roots must be in the reading pack. Multiple candidates survive,
and exact lexical entries remain separate (for example `saw` and `see`). No
stemmer, invented form, word-family inference, or generated definition is used.

`articles.py verify` checks hashes, counts and manifest policy, then rebuilds
the expected words and candidates from SQLite for an exact comparison.
Content-addressed assets are published before the manifest is atomically
replaced. The web build checks source/version/license against the main pack
and incorporates the reading manifest bytes into the shell version, while
excluding both reading assets from service-worker installation and caching.
Only an explicit article analysis loads them; verified IndexedDB cache is
available offline thereafter. Imported article text is never a request body.

Read-only local artifact check (does not touch `dist`):

```sh
node tools/build-offline.mjs --check-articles-only
```
