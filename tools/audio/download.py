"""Download the pinned public Piper model into this repository's ignored work dir."""
import argparse
import hashlib
import os
from pathlib import Path
import urllib.request

from build import CONFIG_SHA, MODEL_COMMIT, MODEL_SHA, ROOT


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--model-dir", type=Path, default=ROOT / "work/piper-eval")
    args = parser.parse_args()
    destination = args.model_dir.resolve()
    destination.mkdir(parents=True, exist_ok=True)
    base = f"https://huggingface.co/rhasspy/piper-voices/resolve/{MODEL_COMMIT}/en/en_US/ljspeech/medium/"
    for name, expected in [("en_US-ljspeech-medium.onnx", MODEL_SHA), ("en_US-ljspeech-medium.onnx.json", CONFIG_SHA)]:
        target = destination / name
        if target.exists() and hashlib.sha256(target.read_bytes()).hexdigest() == expected:
            print(f"Verified existing {name}", flush=True)
            continue
        partial = target.with_name(target.name + ".partial")
        digest = hashlib.sha256()
        size = 0
        with urllib.request.urlopen(base + name, timeout=180) as response, partial.open("wb") as output:
            while chunk := response.read(1024 * 1024):
                size += len(chunk)
                if size > 70 * 1024 * 1024:
                    raise ValueError("Model download exceeds expected maximum size")
                output.write(chunk)
                digest.update(chunk)
        if digest.hexdigest() != expected:
            raise ValueError(f"SHA-256 mismatch for {name}; partial file was not published")
        os.replace(partial, target)
        print(f"Downloaded and verified {name}: {size} bytes", flush=True)


if __name__ == "__main__":
    main()
