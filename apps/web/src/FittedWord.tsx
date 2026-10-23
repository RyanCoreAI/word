import { useLayoutEffect, useRef } from 'react';

/** Measure the actual font after it loads, rather than guessing from letter count. */
export function FittedWord({ word, className = 'word', maxSize = 50 }: { word: string; className?: string; maxSize?: number }) {
  const ref = useRef<HTMLHeadingElement>(null);
  useLayoutEffect(() => {
    const element = ref.current;
    if (!element) return;
    let live = true;
    let width = -1;
    const fit = () => {
      if (!live || !element.clientWidth) return;
      width = element.clientWidth;
      element.style.whiteSpace = 'nowrap';
      element.style.fontSize = `${maxSize}px`;
      if (element.scrollWidth > width) element.style.fontSize = `${Math.max(18, Math.floor(maxSize * width / element.scrollWidth * .98))}px`;
      // An exceptionally long dictionary entry may wrap rather than become illegible.
      if (element.scrollWidth > width + 1) element.style.whiteSpace = 'normal';
    };
    const observer = typeof ResizeObserver !== 'undefined' ? new ResizeObserver(() => { if (element.clientWidth !== width) fit(); }) : null;
    observer?.observe(element);
    fit();
    void document.fonts.ready.then(fit);
    document.fonts.addEventListener('loadingdone', fit);
    window.addEventListener('resize', fit);
    return () => { live = false; observer?.disconnect(); document.fonts.removeEventListener('loadingdone', fit); window.removeEventListener('resize', fit); };
  }, [word, maxSize]);
  return <h2 ref={ref} className={`${className} fitted-word`} style={{ fontSize: maxSize }}>{word}</h2>;
}
