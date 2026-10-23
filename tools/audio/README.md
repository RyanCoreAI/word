# Reproducible US English audio build

This historical optional pipeline generates real synthetic speech for all 19,106
words in the current checked study list. It does not generate the 770,611-entry
dictionary, contact a speech API, require an account, or run a model in the browser.
The current application uses device-local voices only, preferring Samantha.
It does not request or deploy these MP3 packs, and `npm run build` no longer
requires the model or generated catalog. The pipeline remains for provenance
and reproducibility of the earlier implementation.

## Requirements and setup

Use Python 3.12, FFmpeg on PATH, and the exact versions in `requirements.txt`.
Create the environment inside the ignored repository `work/` directory. The
Windows commands below run from the repository root:

```powershell
python -m venv work/piper-eval/venv
& ./work/piper-eval/venv/Scripts/python.exe -m pip install -r tools/audio/requirements.txt
& ./work/piper-eval/venv/Scripts/python.exe tools/audio/download.py
& ./work/piper-eval/venv/Scripts/python.exe -u tools/audio/build.py
& ./work/piper-eval/venv/Scripts/python.exe tools/audio/build.py --verify
```

Linux / GitHub Actions use the same files:

```sh
python -m venv work/piper-eval/venv
work/piper-eval/venv/bin/python -m pip install -r tools/audio/requirements.txt
work/piper-eval/venv/bin/python tools/audio/download.py
work/piper-eval/venv/bin/python -u tools/audio/build.py
work/piper-eval/venv/bin/python tools/audio/build.py --verify
```

Build the dictionary first (`tools/pipeline/build.py`). A changed study hash gets a
different audio version. `download.py` fetches public model/config files from fixed
Hugging Face commit `5041a7a49ae5b3a0f30e6837769eb03fdbb231bd`, checks SHA-256, and
atomically publishes each file. Valid existing files are reused. It honors normal
Python proxy environment settings; it neither discovers nor writes credentials.

On this Windows host, native eSpeak fails when its data path contains Chinese
characters. `build.py` changes to the model directory and passes an automatically
located **relative** Piper package data path (`venv/Lib/...` on Windows and
`venv/lib/python3.12/...` on Linux). Keep the venv within `work/piper-eval` so this
relative path stays ASCII. No global Python or eSpeak files are changed.

## Resume and verification

Run the same build command after interruption. Each completed 128-word pack has a
receipt under `work/audio-generation/<version>/`. Before skipping it, the builder
rechecks its byte size, SHA-256, exact ordered word IDs, clip hashes and contiguous
offsets. An incomplete pack is regenerated. A damaged completed receipt/pack fails
explicitly; review that single derived artifact before rebuilding it.

Each newly generated pack is decoded fully by FFmpeg before its receipt is saved.
Every generated waveform must have a valid duration and non-silent PCM RMS.
`--verify` requires all packs and rechecks every byte/hash/entry boundary without
re-synthesizing or re-decoding the already checked packs. The public manifest is
written only after all 19,106 entries pass. Partial builds cannot become the site's
active audio catalog. A final application build independently checks its assets.

Audio output is not bit-for-bit deterministic across neural runtime/platforms;
each completed build supplies its own checked hashes. Reuse the generated version
directory and receipts together when resuming. The final application validates
the manifest/index/pack bytes from that same build.
New packs include their content hash in the filename, so a non-deterministic
regeneration does not overwrite an older URL with different bytes. Existing
completed receipts are retained unchanged, including the first local build's
unhashed filenames. Preserve older generated files when publishing an update if
already open tabs may still use that earlier catalog. A clean deployment that
omits old assets may require those tabs to reload; it must never serve different
bytes under a formerly published pack URL.

## Files and browser contract

`apps/web/public/audio/manifest.json` identifies the dictionary version, original
study hash, voice, checked index, and 150 packs. Files are ignored by git and rebuilt
for deployment. The versioned full `index.json` maps each exact word ID to
`{pack, offset, length, sha256, duration}`. Each `.bin` concatenates independently
encoded 64 kbps mono MP3 clips. The browser verifies a pack, slices only the exact
word's bytes into an `audio/mpeg` Blob, and starts an ordinary HTMLAudioElement.
Packs are limited to less than 20 MiB, below Cloudflare's 25 MiB per-asset limit.
Each pack also has a small checked index (about 20 KiB), listed in
`manifest.packs[].index` with its file, byte size, hash and entry count. There are
150 audio packs and 150 small index files, rather than 19,106 individual clips.
The study screen passes the word's real position in the unfiltered study list;
the store locates its pack from the declared counts, checks the small index, and
requires an exact word ID match. Cold playback therefore fetches only the manifest,
that small index, and that audio pack. It does not first download the 3 MiB full
index. Missing position metadata or old catalogs retain the full-index fallback.
The full index remains available for complete build validation.

The frontend `HostedAudioStore` performs no request until playback/download.
`downloadAllAudio` downloads verified small indexes and packs sequentially,
reports only complete cached pairs, and supports pause/resume. `getAudioProgress`
loads only the manifest and reports this browser's cached pair receipts.
A new store checks the current online manifest before using
an older verified catalog; if offline or that update fails it can reuse the cached
catalog. Cached clips work offline. Browser storage removal/eviction still removes
offline audio; it does not affect the separate study backup format.

Default US English with no explicit device voice uses the self-hosted pack.
Explicit device voice choices and British English use real browser voices. Only
the HTMLAudio `playing` event or native speech `start` event unlocks the listening
answer. A resolved `play()` Promise or downloaded file is insufficient. Switching
words, hiding the tab, and disposing the controller cancel current playback and
invalidate old asynchronous callbacks.

## Provenance and pronunciation boundaries

- [Piper](https://github.com/OHF-Voice/piper1-gpl), version 1.8.0, GPL-3.0: build-time
  executable only; no Piper code or model is included in website assets.
- [Official en_US-ljspeech-medium voice](https://huggingface.co/rhasspy/piper-voices/tree/5041a7a49ae5b3a0f30e6837769eb03fdbb231bd/en/en_US/ljspeech/medium):
  the voice repository declares MIT metadata; its model card says LJ Speech,
  trained from scratch, US English, one female speaker.
- [LJ Speech](https://keithito.com/LJ-Speech-Dataset/) is public domain. Recording
  credit: Linda Johnson; dataset credit: Keith Ito.
- [lameenc](https://github.com/chrisstaite/lameenc), version 1.9.0, LGPL-3.0:
  build-time MP3 encoder only.

Model SHA-256:
`6f52a751e2349abe7a76735eb09dc1875298c77ea2342ffd2fef79ff81b87f22`.
Config SHA-256:
`141d612cc0a95ed7efc1ca936b845c2364967f2e9217c5dbfcf69fc4d6c65860`.
These are enforced by both downloader and builder. Each published audio version
also includes `provenance.json` with these sources, credits and limitations.

This is **synthetic US English**, not human dictionary recordings. The original
trained phonemizer configuration is preserved (`espeak.voice=en`); model metadata
identifies US English. There is one default pronunciation per spelling. Heteronyms
such as `record` and `lead` may have other readings for another part of speech or
meaning. This pipeline does not claim sense-specific pronunciation or that every
dictionary IPA matches that one reading. Automated decode checks do not constitute
a human listening quality review.
