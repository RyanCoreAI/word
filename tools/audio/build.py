"""Build resumable, verified local English speech packs from the real study list.

Run with the isolated Python environment described in README.md. No model/runtime
is shipped to the browser. Only completed packs are checkpointed, and the public
manifest is published after every study word has a checked MP3 entry.
"""
import argparse
import hashlib
import importlib.metadata
import io
import json
import os
from pathlib import Path
import subprocess
import time
import wave

MODEL_SHA = "6f52a751e2349abe7a76735eb09dc1875298c77ea2342ffd2fef79ff81b87f22"
CONFIG_SHA = "141d612cc0a95ed7efc1ca936b845c2364967f2e9217c5dbfcf69fc4d6c65860"
MODEL_COMMIT = "5041a7a49ae5b3a0f30e6837769eb03fdbb231bd"
PACK_WORDS = 128
MAX_PACK_BYTES = 20 * 1024 * 1024
ROOT = Path(__file__).resolve().parents[2]


def digest(data):
    return hashlib.sha256(data).hexdigest()


def atomic_bytes(path, data):
    path.parent.mkdir(parents=True, exist_ok=True)
    temporary = path.with_name(path.name + ".partial")
    temporary.write_bytes(data)
    os.replace(temporary, path)


def atomic_json(path, data):
    atomic_bytes(path, json.dumps(data, ensure_ascii=False, separators=(",", ":")).encode("utf-8"))


def verify_pack(folder, receipt, expected_words):
    data = (folder / receipt["pack"]["file"].split("/")[-1]).read_bytes()
    assert len(data) == receipt["pack"]["bytes"] < MAX_PACK_BYTES
    assert digest(data) == receipt["pack"]["sha256"]
    assert list(receipt["entries"]) == [word["id"] for word in expected_words]
    offset = 0
    for entry in receipt["entries"].values():
        assert entry["offset"] == offset and entry["length"] > 0
        clip = data[offset:offset + entry["length"]]
        assert digest(clip) == entry["sha256"]
        offset += entry["length"]
    assert offset == len(data)


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--model-dir", type=Path, default=ROOT / "work/piper-eval")
    parser.add_argument("--output", type=Path, default=ROOT / "apps/web/public/audio")
    parser.add_argument("--verify", action="store_true")
    args = parser.parse_args()
    import lameenc
    import numpy as np
    from piper import PiperVoice, SynthesisConfig
    from piper.voice import ESPEAK_DATA_DIR

    for package, version in {"piper-tts": "1.8.0", "lameenc": "1.9.0", "onnxruntime": "1.31.0"}.items():
        assert importlib.metadata.version(package) == version, f"Expected {package}=={version}"
    model_dir = args.model_dir.resolve()
    model = model_dir / "en_US-ljspeech-medium.onnx"
    assert digest(model.read_bytes()) == MODEL_SHA
    assert digest(Path(str(model) + ".json").read_bytes()) == CONFIG_SHA
    dictionary = json.loads((ROOT / "apps/web/public/data/manifest.json").read_text("utf-8"))
    study_bytes = (ROOT / "apps/web/public/data" / dictionary["study"]["file"]).read_bytes()
    assert digest(study_bytes) == dictionary["study"]["sha256"]
    words = json.loads(study_bytes)
    assert len(words) == dictionary["studyCount"] == 19106
    assert len({word["id"] for word in words}) == len(words)
    version = f"piper-ljspeech-{MODEL_SHA[:12]}-{dictionary['study']['sha256'][:12]}-v1"
    output = args.output.resolve()
    folder = output / version
    checkpoint = ROOT / "work/audio-generation" / version
    checkpoint.mkdir(parents=True, exist_ok=True)
    folder.mkdir(parents=True, exist_ok=True)
    packs = []
    entries = {}
    voice = None
    started = time.perf_counter()
    generated = 0
    for start in range(0, len(words), PACK_WORDS):
        group = words[start:start + PACK_WORDS]
        number = start // PACK_WORDS
        pack_id = f"pack-{number:04d}"
        receipt_file = checkpoint / f"{pack_id}.json"
        if receipt_file.exists():
            receipt = json.loads(receipt_file.read_text("utf-8"))
            verify_pack(folder, receipt, group)
        else:
            assert not args.verify, f"Missing completed pack: {pack_id}"
            if voice is None:
                # Native eSpeak requires an ASCII relative path on this Windows
                # installation; all model/dependency files stay under repo/work.
                os.chdir(model_dir)
                espeak_relative = Path(os.path.relpath(ESPEAK_DATA_DIR, model_dir))
                voice = PiperVoice.load(str(model), use_cuda=False, espeak_data_dir=espeak_relative)
            data = bytearray()
            group_entries = {}
            phonemes = {}
            for word in group:
                stream = io.BytesIO()
                with wave.open(stream, "wb") as wav:
                    voice.synthesize_wav(word["word"], wav, syn_config=SynthesisConfig(volume=0.9))
                with wave.open(io.BytesIO(stream.getvalue()), "rb") as wav:
                    assert wav.getnchannels() == 1 and wav.getsampwidth() == 2
                    sample_rate = wav.getframerate()
                    pcm = wav.readframes(wav.getnframes())
                    duration = wav.getnframes() / sample_rate
                values = np.frombuffer(pcm, dtype=np.int16).astype(np.float64)
                assert 0.08 < duration < 15 and np.sqrt(np.mean(values ** 2)) > 20, f"Invalid audio for {word['id']}"
                # Preserve consonant edges and make playback a little less abrupt.
                padded = bytes(round(sample_rate * 0.08) * 2) + pcm + bytes(round(sample_rate * 0.12) * 2)
                encoder = lameenc.Encoder()
                encoder.set_bit_rate(64)
                encoder.set_in_sample_rate(sample_rate)
                encoder.set_channels(1)
                encoder.set_quality(2)
                encoder.silence()
                mp3 = bytes(encoder.encode(padded) + encoder.flush())
                assert len(mp3) > 100
                group_entries[word["id"]] = {"pack": pack_id, "offset": len(data), "length": len(mp3), "sha256": digest(mp3), "duration": round(duration + 0.2, 6)}
                phonemes[word["id"]] = ["".join(part) for part in voice.phonemize(word["word"])]
                data.extend(mp3)
                generated += 1
            assert len(data) < MAX_PACK_BYTES
            pack_hash = digest(data)
            filename = f"{pack_id}-{pack_hash[:16]}.bin"
            pack = {"id": pack_id, "file": f"{version}/{filename}", "bytes": len(data), "sha256": pack_hash, "count": len(group)}
            destination = folder / filename
            atomic_bytes(destination, data)
            # All MP3 frames in this pack are decoded, not just the first clip.
            subprocess.run(["ffmpeg", "-nostdin", "-hide_banner", "-loglevel", "error", "-xerror", "-f", "mp3", "-i", str(destination), "-f", "null", "-"], check=True)
            receipt = {"pack": pack, "entries": group_entries, "phonemes": phonemes}
            verify_pack(folder, receipt, group)
            atomic_json(receipt_file, receipt)
        small_index = {"schema": 1, "version": version, "entries": receipt["entries"]}
        small_bytes = json.dumps(small_index, ensure_ascii=False, separators=(",", ":")).encode("utf-8")
        small_hash = digest(small_bytes)
        small_file = f"{pack_id}-index-{small_hash[:16]}.json"
        assert len(small_bytes) <= 256 * 1024
        if args.verify:
            assert (folder / small_file).read_bytes() == small_bytes, "Published pack index differs from completed receipt"
        else:
            atomic_bytes(folder / small_file, small_bytes)
        packs.append({**receipt["pack"], "index": {"file": f"{version}/{small_file}", "bytes": len(small_bytes), "sha256": small_hash, "count": len(group)}})
        entries.update(receipt["entries"])
        print(json.dumps({"completedWords": len(entries), "totalWords": len(words), "completedPacks": len(packs), "generatedThisRun": generated, "elapsedSeconds": round(time.perf_counter() - started, 1)}), flush=True)
    assert len(entries) == len(words)
    index = {"schema": 1, "version": version, "entries": entries}
    index_path = folder / "index.json"
    if args.verify:
        assert json.loads(index_path.read_text("utf-8")) == index, "Published index differs from completed receipts"
    else:
        atomic_json(index_path, index)
    index_bytes = index_path.read_bytes()
    licensing = {"runtime": {"name": "Piper 1.8.0", "license": "GPL-3.0", "url": "https://github.com/OHF-Voice/piper1-gpl/tree/v1.8.0", "distribution": "build-time only; no runtime code or model is shipped to the browser"}, "model": {"name": "en_US-ljspeech-medium", "license": "MIT (voice repository metadata)", "url": f"https://huggingface.co/rhasspy/piper-voices/tree/{MODEL_COMMIT}/en/en_US/ljspeech/medium", "sha256": MODEL_SHA, "configSha256": CONFIG_SHA}, "dataset": {"name": "LJ Speech", "license": "Public domain", "url": "https://keithito.com/LJ-Speech-Dataset/", "credits": "Linda Johnson (recordings), Keith Ito (dataset)"}, "encoder": {"name": "lameenc 1.9.0 / LAME", "license": "LGPL-3.0", "url": "https://github.com/chrisstaite/lameenc", "distribution": "build-time only"}, "notice": "Synthetic speech generated locally. One default pronunciation per spelling; it may not match every part of speech or meaning. The model's original phonemizer configuration is preserved."}
    if args.verify:
        assert json.loads((folder / "provenance.json").read_text("utf-8")) == licensing, "Published provenance differs"
    else:
        atomic_json(folder / "provenance.json", licensing)
    manifest = {"schema": 1, "version": version, "dictionaryVersion": dictionary["version"], "studySha256": dictionary["study"]["sha256"], "voice": {"id": "piper-en_US-ljspeech-medium", "accent": "en-US", "label": "美式合成 · Piper / LJ Speech", "modelSha256": MODEL_SHA, "provenance": f"{version}/provenance.json"}, "index": {"file": f"{version}/index.json", "bytes": len(index_bytes), "sha256": digest(index_bytes), "count": len(entries)}, "packs": packs}
    # Publication is the final atomic step: readers never see a partial voice pack.
    if args.verify:
        assert json.loads((output / "manifest.json").read_text("utf-8")) == manifest, "Published manifest differs from completed assets"
    else:
        atomic_json(output / "manifest.json", manifest)
    summary = {"version": version, "words": len(entries), "packs": len(packs), "audioBytes": sum(pack["bytes"] for pack in packs), "indexBytes": len(index_bytes), "maxPackBytes": max(pack["bytes"] for pack in packs), "elapsedSeconds": time.perf_counter() - started, "generatedThisRun": generated}
    summary_name = "verification.json" if args.verify else "resume-summary.json" if generated == 0 and (checkpoint / "summary.json").exists() else "summary.json"
    atomic_json(checkpoint / summary_name, summary)
    print(json.dumps(summary), flush=True)


if __name__ == "__main__":
    main()
