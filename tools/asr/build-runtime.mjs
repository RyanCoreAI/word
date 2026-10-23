import { build } from 'rolldown';
import { mkdir } from 'node:fs/promises';
await mkdir('work/asr', { recursive: true });
await build({ input: 'node_modules/@huggingface/transformers/dist/transformers.web.js', platform: 'browser', output: { file: 'work/asr/transformers-runtime.mjs', format: 'esm', minify: true, codeSplitting: false } });
await build({ input: 'apps/web/src/workers/retell-asr-worker.ts', platform: 'browser', output: { file: 'work/asr/retell-worker.mjs', format: 'esm', minify: true, codeSplitting: false } });
