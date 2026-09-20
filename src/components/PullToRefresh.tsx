import { useEffect, useRef, useState } from 'react';

const THRESHOLD = 72;
const MAX = 110;

/**
 * 下拉重新整理：捲動到頂端後繼續下拉即可刷新（iOS 風格的圓形指示器）。
 * 掛在會捲動的容器上（main），只處理觸控手勢。
 */
export function usePullToRefresh(ref: React.RefObject<HTMLElement | null>) {
  const [pull, setPull] = useState(0);
  const [refreshing, setRefreshing] = useState(false);
  const state = useRef({ startY: 0, active: false });

  useEffect(() => {
    const el = ref.current;
    if (!el) return;

    const onStart = (e: TouchEvent) => {
      if (refreshing || e.touches.length !== 1) return;
      state.current = { startY: e.touches[0].clientY, active: el.scrollTop <= 0 };
    };
    const onMove = (e: TouchEvent) => {
      if (!state.current.active || refreshing) return;
      const dy = e.touches[0].clientY - state.current.startY;
      // 往上滑或已經捲離頂端就交還給一般捲動
      if (dy <= 0 || el.scrollTop > 0) {
        state.current.active = false;
        setPull(0);
        return;
      }
      e.preventDefault();
      // 阻尼：越拉越沉
      setPull(Math.min(MAX, dy * 0.5));
    };
    const onEnd = () => {
      if (!state.current.active) return;
      state.current.active = false;
      setPull((p) => {
        if (p >= THRESHOLD) {
          setRefreshing(true);
          setTimeout(() => location.reload(), 150);
          return THRESHOLD;
        }
        return 0;
      });
    };

    el.addEventListener('touchstart', onStart, { passive: true });
    el.addEventListener('touchmove', onMove, { passive: false });
    el.addEventListener('touchend', onEnd, { passive: true });
    el.addEventListener('touchcancel', onEnd, { passive: true });
    return () => {
      el.removeEventListener('touchstart', onStart);
      el.removeEventListener('touchmove', onMove);
      el.removeEventListener('touchend', onEnd);
      el.removeEventListener('touchcancel', onEnd);
    };
  }, [ref, refreshing]);

  return { pull, refreshing, ready: pull >= THRESHOLD };
}

export function PullIndicator({ pull, refreshing, ready }: { pull: number; refreshing: boolean; ready: boolean }) {
  const shown = pull > 0 || refreshing;
  return (
    <div
      className="pull-indicator"
      style={{
        transform: `translateY(${pull}px)`,
        opacity: shown ? 1 : 0,
        transition: pull ? 'opacity 0.2s ease' : 'transform 0.3s cubic-bezier(0.22, 0.61, 0.36, 1), opacity 0.2s ease',
      }}
      aria-hidden={!shown}
    >
      <div className={`pull-spinner ${refreshing ? 'spin' : ''}`} style={{ transform: `rotate(${pull * 3}deg)` }}>
        <svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round">
          <circle cx="12" cy="12" r="9" opacity={refreshing ? 0.25 : ready ? 1 : 0.4} />
          {!refreshing && <path d="M12 7v6l4 2" opacity={ready ? 1 : 0.5} />}
          {refreshing && <path d="M21 12a9 9 0 0 0-9-9" />}
        </svg>
      </div>
    </div>
  );
}
