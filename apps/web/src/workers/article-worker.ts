import { analyzeArticle, type ArticleAnalysisOptions } from '../../../../packages/core/src/articles';

self.onmessage = (event: MessageEvent<{ text: string; options: ArticleAnalysisOptions }>) => {
  try { self.postMessage({ result: analyzeArticle(event.data.text, event.data.options) }); }
  catch (error) { self.postMessage({ error: error instanceof Error ? error.message : '文章分析失败，请重试。' }); }
};
