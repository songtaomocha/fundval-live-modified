import { useEffect, useState } from 'react';

export function useElementSize(ref) {
  const [size, setSize] = useState({ width: 0, height: 0 });

  useEffect(() => {
    let rafId = null;
    let observer = null;
    let cleanupWindowResize = null;
    let cancelled = false;

    const attach = () => {
      if (cancelled) return;

      const element = ref.current;
      if (!element) {
        // 首次渲染阶段容器可能尚未挂载，下一帧继续尝试绑定。
        rafId = requestAnimationFrame(attach);
        return;
      }

      const updateSize = () => {
        const rect = element.getBoundingClientRect();
        const next = {
          width: Math.max(0, Math.floor(rect.width)),
          height: Math.max(0, Math.floor(rect.height)),
        };

        setSize((prev) => (
          prev.width === next.width && prev.height === next.height ? prev : next
        ));
      };

      updateSize();

      if (typeof ResizeObserver === 'function') {
        observer = new ResizeObserver(updateSize);
        observer.observe(element);
        return;
      }

      if (typeof window !== 'undefined') {
        window.addEventListener('resize', updateSize);
        cleanupWindowResize = () => window.removeEventListener('resize', updateSize);
      }
    };

    attach();

    return () => {
      cancelled = true;
      if (rafId !== null) cancelAnimationFrame(rafId);
      if (observer) observer.disconnect();
      if (cleanupWindowResize) cleanupWindowResize();
    };
  }, [ref]);

  return size;
}
