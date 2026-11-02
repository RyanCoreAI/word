# Generated dictionary data

Run `python tools/pipeline/pipeline.py build` from the repository root before
building or publishing the web application, then run
`python tools/pipeline/articles.py build` for the on-demand reading dictionary.
This directory contains generated
`manifest.json` and immutable version directories with `study.json` and all
dictionary shards, plus `article-manifest.json` and its content-addressed
reading word/inflection assets. Reading assets are not installation precache.
They are intentionally excluded from Git. Never replace
missing generated files with mock data. See `tools/pipeline/README.md`.
