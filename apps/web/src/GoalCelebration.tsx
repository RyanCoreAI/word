import { useEffect, useRef } from 'react';
import confetti from 'canvas-confetti';

export default function GoalCelebration() {
  const canvas = useRef<HTMLCanvasElement>(null);
  useEffect(() => {
    if (!canvas.current || document.hidden || matchMedia('(prefers-reduced-motion: reduce)').matches) return;
    const fire = confetti.create(canvas.current, { resize: true, useWorker: false, disableForReducedMotion: true });
    const options = { particleCount: 38, spread: 60, startVelocity: 34, gravity: 0.85, ticks: 110, scalar: 0.8, colors: ['#3B4FD8', '#8CCBFF', '#F2C458', '#EF8B79'] };
    void fire({ ...options, angle: 60, origin: { x: 0, y: 0.7 } });
    void fire({ ...options, angle: 120, origin: { x: 1, y: 0.7 } });
    const stop = () => { if (document.hidden) fire.reset(); };
    document.addEventListener('visibilitychange', stop);
    const timeout = setTimeout(() => fire.reset(), 2200);
    return () => { clearTimeout(timeout); fire.reset(); document.removeEventListener('visibilitychange', stop); };
  }, []);
  return <canvas className="goal-confetti" aria-hidden="true" ref={canvas} />;
}
