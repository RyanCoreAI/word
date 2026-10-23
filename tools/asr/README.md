# Browser-local retelling recognition

The app uses `onnx-community/whisper-tiny.en` at immutable revision
`2575352d61be1bf7225cf8f8b268a4678025fc58`, q8 encoder and merged decoder.
Recognition runs inside a dedicated browser Worker using WebAssembly. No speech,
transcript, or recording is sent to a recognition service. Device-local speech
playback is a separate existing feature.

```sh
ONNXRUNTIME_NODE_INSTALL=skip npm ci
python -m unittest discover -s tools/asr -p 'test_*.py'
python tools/asr/build.py
python tools/asr/build.py --verify
```

`ONNXRUNTIME_NODE_INSTALL=skip` is the upstream installer's supported switch for
the unused Node native backend. Browser WASM assets are still installed and
verified. The browser does not require a developer account or a paid API.

The Python builder uses only the standard library. It verifies original model
bytes against pinned Hugging Face LFS SHA-256 or Git blob SHA-1 metadata, bundles
the installed pinned JS runtime and Worker, preserves complete license notices,
then creates `apps/web/public/asr/manifest.json` and versioned chunks. Every
chunk is at most 8 MiB, including the decoder and ONNX WASM that individually
exceed Cloudflare's free static asset file limit. The generated package is about
73 MB; it is excluded from the app shell precache. Build output is regenerated,
not committed. `tools/build-offline.mjs` independently validates and copies it.

`RetellAsrController` construction only checks local CacheStorage. An explicit
`prepare()` downloads and SHA-256 validates each part and assembled asset, and
stores complete virtual files in the isolated `word-retell-asr-v1` cache.
At most three same-origin parts download concurrently. Verified cached parts
are reused; the first failure cancels peers and stops late progress updates.
Assembly reads one asset at a time from that cache instead of keeping every
model buffer in memory. Integrity and cancellation checks remain mandatory.
Chunk and assembled copies require about twice the download size in browser
storage. Cache eviction by the browser means the user must explicitly prepare
again; it does not erase vocabulary progress or saved recordings.
The Worker imports only verified Blob modules. Transformers.js remote model loading
is disabled, custom cache reads are allowlisted by the manifest, and its network
fetch fallback throws. Inference uses one WASM thread, without requiring
cross-origin isolation. Existing vocabulary/progress storage is never accessed.

Controller API: `getState`, `subscribe`, `prepare`, `start`, `pause`, `resume`,
`stop`, `retry`, `getLastRecording`, `cancel`, and `dispose`. Stable state snapshots
include `modelReady`, download progress, status, duration, error, and `result`.
Both manual and three-minute automatic stop publish `result` only after a
nonempty real transcription; the UI subscribes to that one completion path.
Failed recognition retains the original Blob for playback and retry. Cancel and
dispose release microphone tracks and terminate inference. Preparing does not
grant microphone access; `start` requests it separately. Cache quota failures,
permission denial, invalid audio, unsupported browsers, and model errors are
reported rather than replaced with pretend transcripts.

## Browser verification

Download the [official Transformers.js JFK example](https://huggingface.co/datasets/Xenova/transformers.js-docs/resolve/main/jfk.wav)
to `work/asr/jfk.wav`, then run:

```sh
node tools/asr/browser-smoke.mjs
```

This script starts an ephemeral loopback server, opens an isolated real Chrome
context, verifies zero initial ASR requests, prepares the real package, recognizes
JFK with the actual Worker, exercises actual MediaRecorder pause/resume/stop using
Chrome's file microphone input, and repeats recognition after cache restoration
with networking offline. Reports default to `outputs/word-retell/asr-browser` in
the chat workspace, or use `WORD_ASR_OUTPUT`. File input is a browser integration
test, not proof of microphone acoustics, mobile speed, or physical Android
compatibility. JS unit test fixtures are deliberately small and are not evidence
of model accuracy. Device performance, accent accuracy, and real microphone
quality still need physical-device acceptance.

## Sources and notices

- [Pinned community model](https://huggingface.co/onnx-community/whisper-tiny.en/tree/2575352d61be1bf7225cf8f8b268a4678025fc58)
  derives from [OpenAI whisper-tiny.en](https://huggingface.co/openai/whisper-tiny.en/tree/87c7102498dcde7456f24cfd30239ca606ed9063), whose model card declares Apache-2.0. The package retains that full notice and both source metadata snapshots.
- [OpenAI Whisper](https://github.com/openai/whisper) separately distributes code
  and weights under its MIT notice; that complete notice is also retained. The
  HF model package is not described as MIT-only.
- Transformers.js and Tokenizers include their installed Apache-2.0 notices;
  Jinja includes its installed MIT notice. ONNX Runtime includes MIT plus its full third-party notices fetched
  from the exact `__commit.txt` in the pinned npm runtime package.
- [Transformers.js environment controls](https://huggingface.co/docs/transformers.js/api/env)
  and [MediaRecorder](https://developer.mozilla.org/en-US/docs/Web/API/MediaRecorder)
  document the local model and recording APIs. Implementation also verifies the
  exact installed runtime's custom WASM cache and installer behavior.
