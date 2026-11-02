import type { ArticleAnalysis, ArticleAnalysisOptions } from '../../../../packages/core/src/articles';

/** A separate worker keeps the article parser off the phone's interaction thread. */
export function analyzeInWorker(text: string, options: ArticleAnalysisOptions, signal: AbortSignal): Promise<ArticleAnalysis> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) { reject(new DOMException('已取消分析', 'AbortError')); return; }
    const worker = new Worker(new URL('../workers/article-worker.ts', import.meta.url), { type: 'module' });
    const finish = () => { clearTimeout(timer); signal.removeEventListener('abort', abort); worker.terminate(); };
    const abort = () => { finish(); reject(new DOMException('已取消分析', 'AbortError')); };
    const timer = setTimeout(() => { finish(); reject(new Error('文章分析超时，请缩短文章后重试。')); }, 30_000);
    signal.addEventListener('abort', abort, { once: true });
    worker.onmessage = (event: MessageEvent<{ result?: ArticleAnalysis; error?: string }>) => {
      finish();
      if (event.data.result) resolve(event.data.result);
      else reject(new Error(event.data.error ?? '文章分析未完成。'));
    };
    worker.onerror = () => { finish(); reject(new Error('无法启动本机分析，请重新打开页面后重试。')); };
    worker.postMessage({ text, options });
  });
}
