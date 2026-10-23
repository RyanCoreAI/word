import { AsrAssetStore, asrManifestSchema, type AsrManifest } from '../lib/retell-asr-assets';
import type { AutomaticSpeechRecognitionPipeline } from '@huggingface/transformers';

const worker = globalThis as unknown as { onmessage: ((event: MessageEvent) => void) | null; postMessage: (message: unknown) => void };
let recognizer: AutomaticSpeechRecognitionPipeline | null = null;
let manifest: AsrManifest | null = null;
const urls: string[] = [];
worker.onmessage = async (event: MessageEvent<{ id: number; type: 'init' | 'transcribe'; baseUrl?: string; manifest?: unknown; audio?: Float32Array }>) => {
  const { id, type } = event.data;
  try {
    if (type === 'init') {
      manifest = asrManifestSchema.parse(event.data.manifest);
      const baseUrl = event.data.baseUrl!;
      const store = new AsrAssetStore({ baseUrl });
      const script = await (await store.read(manifest, 'runtime/transformers-runtime.mjs')).blob();
      const runtimeUrl = URL.createObjectURL(script); urls.push(runtimeUrl);
      const runtime = await import(/* @vite-ignore */ runtimeUrl) as typeof import('@huggingface/transformers');
      runtime.env.allowRemoteModels = false; runtime.env.allowLocalModels = true;
      runtime.env.localModelPath = new URL(`${manifest.version}/`, baseUrl).href;
      runtime.env.useBrowserCache = false; runtime.env.useFS = false; runtime.env.useFSCache = false;
      runtime.env.useCustomCache = true; runtime.env.useWasmCache = true;
      const selected = manifest;
      runtime.env.customCache = {
        match: async (request: string) => {
          const prefix = new URL(`${selected.version}/`, baseUrl).href;
          const url = new URL(request, prefix);
          if (!url.href.startsWith(prefix)) return new Response(null, { status: 404 });
          const path = url.href.slice(prefix.length);
          if (!selected.assets.some(asset => asset.path === path)) return new Response(null, { status: 404 });
          return store.read(selected, path);
        },
        put: async () => { throw new Error('推理不能写入未校验的识别文件。'); },
      };
      runtime.env.fetch = async () => { throw new Error('识别文件未离线缓存，已阻止所有网络回退。'); };
      const wasm = runtime.env.backends.onnx.wasm;
      if (!wasm) throw new Error('此浏览器缺少 WebAssembly 推理后端。');
      wasm.numThreads = 1; wasm.proxy = false;
      wasm.wasmPaths = { wasm: store.url(selected, 'runtime/ort-wasm-simd-threaded.jsep.wasm'), mjs: store.url(selected, 'runtime/ort-wasm-simd-threaded.jsep.mjs') };
      recognizer = await runtime.pipeline('automatic-speech-recognition', 'model', { device: 'wasm', dtype: 'q8', local_files_only: true });
      worker.postMessage({ id, ok: true });
    } else if (type === 'transcribe') {
      if (!recognizer || !manifest) throw new Error('请先启用本机离线识别。');
      const audio = event.data.audio;
      if (!(audio instanceof Float32Array) || audio.length < 1600 || audio.length > 16000 * 180 || audio.some(value => !Number.isFinite(value))) throw new Error('录音长度或格式无效。');
      const result = await recognizer(audio, { chunk_length_s: 30, stride_length_s: 5, return_timestamps: false });
      const text = (Array.isArray(result) ? result.map(item => item.text).join(' ') : result.text).trim();
      worker.postMessage({ id, ok: true, transcript: text });
    } else throw new Error('未知识别指令。');
  } catch (error) { worker.postMessage({ id, ok: false, error: error instanceof Error ? error.message : '本机识别失败，请保留录音后重试。' }); }
};
