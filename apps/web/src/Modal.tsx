import { useEffect, useRef, type ReactNode } from 'react';
import { X } from 'lucide-react';

export function Modal({ title, children, close, sheet = false }: { title: string; children: ReactNode; close: () => void; sheet?: boolean }) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const previous = document.activeElement;
    const focusables = () => ref.current?.querySelectorAll<HTMLElement>('button:not(:disabled),a[href],input,select,textarea,[tabindex="0"]');
    focusables()?.[0]?.focus();
    const handler = (event: KeyboardEvent) => {
      if (event.key === 'Escape') { event.preventDefault(); close(); }
      if (event.key !== 'Tab') return;
      const elements = focusables(); if (!elements?.length) return;
      const first = elements[0]; const last = elements[elements.length - 1];
      if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last?.focus(); }
      if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first?.focus(); }
    };
    document.addEventListener('keydown', handler);
    return () => { document.removeEventListener('keydown', handler); if (previous instanceof HTMLElement) previous.focus(); };
  }, [close]);
  return <div className={`dialog-backdrop ${sheet ? 'sheet-backdrop' : ''}`} onPointerDown={event => { if (sheet && event.target === event.currentTarget) close(); }}><div className={`dialog ${sheet ? 'dialog-sheet' : ''}`} ref={ref} role="dialog" aria-modal="true" aria-label={title}>{sheet && <div className="grab" aria-hidden="true" />}<div className="dialog-head"><h2 className={sheet ? 'sr-only' : undefined}>{title}</h2><button className="icon-btn" aria-label="关闭弹窗" onClick={close}><X /></button></div>{children}</div></div>;
}
