import { useEffect, useRef, type PointerEvent } from 'react';

/** Horizontal navigation stays separate from vertical meaning/phrase scrolling. */
export function useStudySwipe(enabled: boolean, navigate: (direction: 'previous' | 'next') => void) {
  const gesture = useRef<{ id: number; x: number; y: number; at: number; stage: HTMLElement } | null>(null);
  const clear = () => {
    const stage = gesture.current?.stage;
    stage?.classList.remove('swiping'); stage?.style.removeProperty('--swipe-x');
    gesture.current = null;
  };
  useEffect(() => { if (!enabled) { const stage = gesture.current?.stage; stage?.classList.remove('swiping'); stage?.style.removeProperty('--swipe-x'); gesture.current = null; } }, [enabled]);
  return {
    onPointerDown(event: PointerEvent<HTMLElement>) {
      clear();
      if (!enabled || !event.isPrimary || event.pointerType === 'mouse' || (event.target instanceof Element && event.target.closest('button,a,input,select,textarea,summary')) || event.clientX < 20 || event.clientX > innerWidth - 20) return;
      gesture.current = { id: event.pointerId, x: event.clientX, y: event.clientY, at: performance.now(), stage: event.currentTarget };
      event.currentTarget.setPointerCapture(event.pointerId);
    },
    onPointerMove(event: PointerEvent<HTMLElement>) {
      const start = gesture.current; if (!start || start.id !== event.pointerId) return;
      const dx = event.clientX - start.x; const dy = event.clientY - start.y;
      if (Math.abs(dy) > 12 && Math.abs(dy) > Math.abs(dx)) { clear(); return; }
      if (Math.abs(dx) > 12 && Math.abs(dx) > Math.abs(dy) * 1.5) {
        start.stage.classList.add('swiping'); start.stage.style.setProperty('--swipe-x', `${Math.max(-75, Math.min(75, dx * .3))}px`);
      }
    },
    onPointerUp(event: PointerEvent<HTMLElement>) {
      const start = gesture.current;
      if (!start || start.id !== event.pointerId) return;
      const dx = event.clientX - start.x; const dy = event.clientY - start.y;
      const moved = enabled && performance.now() - start.at < 1800 && Math.abs(dx) >= Math.max(48, start.stage.clientWidth * .16) && Math.abs(dx) > Math.abs(dy) * 1.5;
      clear();
      if (moved) { event.preventDefault(); navigate(dx > 0 ? 'previous' : 'next'); }
    },
    onPointerCancel: clear,
    onLostPointerCapture: clear,
  };
}
