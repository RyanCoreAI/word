"""Build same-origin, size-bounded Whisper assets; Python standard library only."""
from __future__ import annotations
import argparse
import hashlib
import json
from pathlib import Path
import re
import subprocess
import time
from urllib.request import Request, urlopen

ROOT = Path(__file__).resolve().parents[2]
PUBLIC = ROOT / 'apps/web/public/asr'
CACHE = ROOT / 'work/asr/source'
MODEL = 'onnx-community/whisper-tiny.en'
REVISION = '2575352d61be1bf7225cf8f8b268a4678025fc58'
UPSTREAM_REVISION = '87c7102498dcde7456f24cfd30239ca606ed9063'
CHUNK = 8 * 1024 * 1024
FILES = ['config.json', 'tokenizer.json', 'tokenizer_config.json', 'preprocessor_config.json', 'generation_config.json', 'onnx/encoder_model_quantized.onnx', 'onnx/decoder_model_merged_quantized.onnx']

def digest(data):
    return hashlib.sha256(data).hexdigest()

def encoded(value):
    return json.dumps(value, ensure_ascii=False, sort_keys=True, separators=(',', ':')).encode()

def download(url, maximum=64 * 1024 * 1024):
    error = None
    for attempt in range(3):
        try:
            with urlopen(Request(url, headers={'User-Agent': 'YanxaiWordLocalASR/1.0'}), timeout=60) as response:
                value = response.read(maximum + 1)
                if len(value) > maximum:
                    raise ValueError('Source exceeds allowed bytes')
                return value
        except Exception as current:
            error = current
            if attempt < 2:
                time.sleep(2)
    raise error

def acquire(file, entry):
    target = CACHE / file
    target.parent.mkdir(parents=True, exist_ok=True)
    data = target.read_bytes() if target.exists() else download(f'https://huggingface.co/{MODEL}/resolve/{REVISION}/{file}')
    if len(data) != entry['size']:
        raise ValueError(f'Pinned model size mismatch: {file}')
    if entry.get('lfs'):
        if digest(data) != entry['lfs']['sha256']:
            raise ValueError(f'Pinned LFS checksum mismatch: {file}')
    elif hashlib.sha1(f'blob {len(data)}\0'.encode() + data).hexdigest() != entry['blobId']:
        raise ValueError(f'Pinned Git blob mismatch: {file}')
    target.write_bytes(data)
    return data

def verify():
    manifest = json.loads((PUBLIC / 'manifest.json').read_text('utf8'))
    if manifest['modelId'] != MODEL or manifest['revision'] != REVISION or manifest['license'] != 'Apache-2.0':
        raise ValueError('ASR source identity changed')
    if not re.fullmatch(r'whisper-tiny-en-[0-9a-f]{20}', manifest['version']):
        raise ValueError('Invalid ASR package version')
    if len({a['path'] for a in manifest['assets']}) != len(manifest['assets']) or sum(a['bytes'] for a in manifest['assets']) != manifest['totalBytes']:
        raise ValueError('ASR asset totals mismatch')
    for asset in manifest['assets']:
        combined = bytearray()
        for part in asset['parts']:
            if not re.fullmatch(re.escape(manifest['version']) + r'/chunks/[0-9a-f]{64}-[0-9]{3}\.bin', part['file']):
                raise ValueError('Invalid ASR part path')
            data = (PUBLIC / part['file']).read_bytes()
            if len(data) != part['bytes'] or digest(data) != part['sha256'] or len(data) > CHUNK:
                raise ValueError('ASR part validation failed')
            combined.extend(data)
        if len(combined) != asset['bytes'] or digest(combined) != asset['sha256']:
            raise ValueError('ASR assembled asset validation failed')
    return {'version': manifest['version'], 'assetsVerified': len(manifest['assets']), 'bytes': manifest['totalBytes'], 'maximumUploadBytes': max(p['bytes'] for a in manifest['assets'] for p in a['parts'])}

def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--verify', action='store_true')
    args = parser.parse_args()
    if args.verify:
        print(json.dumps(verify()))
        return
    CACHE.mkdir(parents=True, exist_ok=True)
    PUBLIC.mkdir(parents=True, exist_ok=True)
    info_path = CACHE / 'model-info.json'
    if not info_path.exists():
        info_path.write_bytes(download(f'https://huggingface.co/api/models/{MODEL}/revision/{REVISION}?blobs=true', 1024 * 1024))
    info = json.loads(info_path.read_text('utf8'))
    if info['sha'] != REVISION:
        raise ValueError('Pinned model revision mismatch')
    upstream_path = CACHE / 'upstream-model-info.json'
    if not upstream_path.exists():
        upstream_path.write_bytes(download(f'https://huggingface.co/api/models/openai/whisper-tiny.en/revision/{UPSTREAM_REVISION}', 1024 * 1024))
    upstream = json.loads(upstream_path.read_text('utf8'))
    if upstream.get('sha') != UPSTREAM_REVISION or info.get('cardData', {}).get('base_model') != 'openai/whisper-tiny.en' or upstream.get('cardData', {}).get('license') != 'apache-2.0':
        raise ValueError('Official upstream lineage/license changed; review before rebuilding')
    siblings = {entry['rfilename']: entry for entry in info['siblings']}
    assets = [('model/' + file, acquire(file, siblings[file])) for file in FILES]
    subprocess.run(['node', 'tools/asr/build-runtime.mjs'], cwd=ROOT, check=True)
    assets.append(('runtime/transformers-runtime.mjs', (ROOT / 'work/asr/transformers-runtime.mjs').read_bytes()))
    assets.append(('runtime/retell-worker.mjs', (ROOT / 'work/asr/retell-worker.mjs').read_bytes()))
    ort = ROOT / 'node_modules/onnxruntime-web/dist'
    for name in ['ort-wasm-simd-threaded.jsep.wasm', 'ort-wasm-simd-threaded.jsep.mjs']:
        assets.append(('runtime/' + name, (ort / name).read_bytes()))
    license_path = CACHE / 'whisper-MIT.txt'
    if not license_path.exists():
        license_path.write_bytes(download('https://raw.githubusercontent.com/openai/whisper/main/LICENSE', 64 * 1024))
    license_data = license_path.read_bytes()
    if b'MIT License' not in license_data or b'OpenAI' not in license_data:
        raise ValueError('Expected complete OpenAI MIT license')
    assets.append(('licenses/whisper-MIT.txt', license_data))
    assets.append(('licenses/whisper-Apache-2.0.txt', (ROOT / 'node_modules/@huggingface/transformers/LICENSE').read_bytes()))
    assets.append(('sources/model-card.json', info_path.read_bytes()))
    assets.append(('sources/upstream-model-card.json', upstream_path.read_bytes()))
    ort_commit = (ROOT / 'node_modules/onnxruntime-web/__commit.txt').read_text('utf8').strip()
    if len(ort_commit) != 40 or any(c not in '0123456789abcdef' for c in ort_commit):
        raise ValueError('ONNX Runtime package is missing its source commit')
    for source, filename in [('LICENSE', 'onnxruntime-MIT.txt'), ('ThirdPartyNotices.txt', 'onnxruntime-ThirdPartyNotices.txt')]:
        target = CACHE / ('onnxruntime-' + source)
        if not target.exists():
            target.write_bytes(download(f'https://raw.githubusercontent.com/microsoft/onnxruntime/{ort_commit}/{source}', 2 * 1024 * 1024))
        assets.append(('licenses/' + filename, target.read_bytes()))
    for package, filename in [('@huggingface/transformers', 'transformers-Apache-2.0.txt'), ('@huggingface/tokenizers', 'tokenizers-Apache-2.0.txt'), ('@huggingface/jinja', 'jinja-MIT.txt')]:
        assets.append(('licenses/' + filename, (ROOT / 'node_modules' / package / 'LICENSE').read_bytes()))
    material = encoded({'model': MODEL, 'revision': REVISION, 'assets': [(name, digest(data)) for name, data in assets]})
    version = 'whisper-tiny-en-' + digest(material)[:20]
    manifest = {'schemaVersion': 1, 'version': version, 'modelId': MODEL, 'revision': REVISION, 'license': 'Apache-2.0', 'runtimeVersion': '4.3.1', 'sampleRate': 16000, 'assets': [], 'totalBytes': sum(len(data) for _, data in assets)}
    for virtual, data in assets:
        entry = {'path': virtual, 'bytes': len(data), 'sha256': digest(data), 'parts': []}
        for index, start in enumerate(range(0, len(data), CHUNK)):
            part = data[start:start + CHUNK]
            file = f'{version}/chunks/{digest(data)}-{index:03d}.bin'
            target = PUBLIC / file
            target.parent.mkdir(parents=True, exist_ok=True)
            target.write_bytes(part)
            entry['parts'].append({'file': file, 'bytes': len(part), 'sha256': digest(part)})
        manifest['assets'].append(entry)
    (PUBLIC / 'manifest.json').write_bytes(encoded(manifest))
    print(json.dumps(verify()))

if __name__ == '__main__':
    main()
