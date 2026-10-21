import React from 'react';
import ReactDOM from 'react-dom/client';
import App from './App';
import './styles.css';

ReactDOM.createRoot(document.getElementById('root')!).render(<React.StrictMode><App /></React.StrictMode>);

if (import.meta.env.PROD && 'serviceWorker' in navigator) {
  window.addEventListener('load', () => {
    void navigator.serviceWorker.register('./sw.js').then(async () => {
      const registration = await navigator.serviceWorker.ready;
      await document.fonts.ready;
      const fonts = performance.getEntriesByType('resource').map(entry => entry.name).filter(name => /\.woff2?(?:\?|$)/.test(name));
      registration.active?.postMessage({ type: 'CACHE_USED_FONTS', urls: fonts });
    }).catch(() => {
      window.dispatchEvent(new CustomEvent('word-offline-error'));
    });
  });
}
