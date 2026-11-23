import { useEffect, useState } from 'react';

export type LayoutMode = 'desktop-split' | 'tablet-portrait' | 'phone';

function computeLayoutMode(): LayoutMode {
  if (typeof window === 'undefined') return 'desktop-split';
  const w = window.innerWidth;
  const h = window.innerHeight;
  const isLandscape = w > h;

  // 桌面端（>=1024px）或安卓平板横屏（>=768px 且横屏）均采用与电脑端一致的左右分栏布局
  if (w >= 1024 || (w >= 768 && isLandscape)) {
    return 'desktop-split';
  }
  // 平板竖屏（640px ~ 1023px 竖屏）
  if (w >= 640) {
    return 'tablet-portrait';
  }
  return 'phone';
}

export function useLayoutMode(): {
  layoutMode: LayoutMode;
  isSplitLayout: boolean;
  isTouchDevice: boolean;
} {
  const [layoutMode, setLayoutMode] = useState<LayoutMode>(computeLayoutMode);
  const [isTouchDevice, setIsTouchDevice] = useState<boolean>(() =>
    typeof window !== 'undefined' ? window.matchMedia('(pointer: coarse)').matches : false
  );

  useEffect(() => {
    const update = () => {
      setLayoutMode(computeLayoutMode());
      setIsTouchDevice(window.matchMedia('(pointer: coarse)').matches);
    };
    window.addEventListener('resize', update);
    window.addEventListener('orientationchange', update);
    return () => {
      window.removeEventListener('resize', update);
      window.removeEventListener('orientationchange', update);
    };
  }, []);

  return {
    layoutMode,
    isSplitLayout: layoutMode === 'desktop-split',
    isTouchDevice,
  };
}
