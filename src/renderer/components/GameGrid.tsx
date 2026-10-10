// Virtualized grid: only visible rows are rendered, so libraries with 10,000+
// games stay responsive. Thumbnails load lazily.

import { useEffect, useRef, useState } from 'react';
import { useVirtualizer } from '@tanstack/react-virtual';
import type { GameSummary } from '@shared/models';
import { GameCard } from './GameCard';

const MIN_CARD = 168;
const GAP = 16;

export function GameGrid(props: { games: GameSummary[]; scrollParent: HTMLElement | null; onNearEnd?: () => void }) {
  const ref = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(1000);
  useEffect(() => {
    if (!ref.current) return;
    const ro = new ResizeObserver((e) => setWidth(e[0].contentRect.width));
    ro.observe(ref.current);
    return () => ro.disconnect();
  }, []);
  const cols = Math.max(2, Math.floor((width + GAP) / (MIN_CARD + GAP)));
  const cardW = (width - GAP * (cols - 1)) / cols;
  const rowH = cardW * (4 / 3) + 64 + GAP;
  const rows = Math.ceil(props.games.length / cols);
  const v = useVirtualizer({ count: rows, getScrollElement: () => props.scrollParent, estimateSize: () => rowH, overscan: 3, scrollMargin: ref.current?.offsetTop ?? 0 });
  useEffect(() => v.measure(), [rowH, v]);
  const items = v.getVirtualItems();
  useEffect(() => {
    const last = items[items.length - 1];
    if (last && last.index >= rows - 2) props.onNearEnd?.();
  }, [items, rows, props]);
  return (
    <div ref={ref} style={{ height: v.getTotalSize(), position: 'relative' }}>
      {items.map((row) => (
        <div key={row.key} style={{ position: 'absolute', top: row.start - v.options.scrollMargin, left: 0, right: 0, display: 'grid', gridTemplateColumns: `repeat(${cols}, 1fr)`, gap: GAP }}>
          {props.games.slice(row.index * cols, row.index * cols + cols).map((g) => <GameCard key={g.id} game={g} />)}
        </div>
      ))}
    </div>
  );
}
