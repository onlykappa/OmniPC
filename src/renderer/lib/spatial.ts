// Spatial navigation: moves focus to the nearest focusable element in a
// direction. Used for D-pad / stick / arrow-key navigation so the whole app
// works without a mouse.

export type Direction = 'up' | 'down' | 'left' | 'right';

const FOCUSABLE = 'button:not([disabled]), a[href], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

function visible(el: HTMLElement): boolean {
  const r = el.getBoundingClientRect();
  if (r.width === 0 || r.height === 0) return false;
  const style = getComputedStyle(el);
  return style.visibility !== 'hidden' && style.display !== 'none';
}

/** Elements inside the top-most open modal, or the whole document. */
function scopeRoot(): ParentNode {
  const modals = document.querySelectorAll<HTMLElement>('[data-modal]');
  return modals.length ? modals[modals.length - 1] : document;
}

export function focusables(): HTMLElement[] {
  return [...scopeRoot().querySelectorAll<HTMLElement>(FOCUSABLE)].filter(visible);
}

export function moveFocus(dir: Direction): void {
  const all = focusables();
  if (!all.length) return;
  const current = document.activeElement as HTMLElement | null;
  if (!current || !all.includes(current)) {
    (all.find((e) => e.dataset.autofocus !== undefined) ?? all[0]).focus();
    return;
  }
  const a = current.getBoundingClientRect();
  const ax = a.left + a.width / 2;
  const ay = a.top + a.height / 2;
  let best: HTMLElement | null = null;
  let bestScore = Infinity;
  for (const el of all) {
    if (el === current) continue;
    const b = el.getBoundingClientRect();
    const bx = b.left + b.width / 2;
    const by = b.top + b.height / 2;
    const dx = bx - ax;
    const dy = by - ay;
    let primary: number;
    let secondary: number;
    switch (dir) {
      case 'up': if (b.bottom > a.top + 4) continue; primary = -dy; secondary = Math.abs(dx); break;
      case 'down': if (b.top < a.bottom - 4) continue; primary = dy; secondary = Math.abs(dx); break;
      case 'left': if (b.right > a.left + 4) continue; primary = -dx; secondary = Math.abs(dy); break;
      case 'right': if (b.left < a.right - 4) continue; primary = dx; secondary = Math.abs(dy); break;
    }
    const score = primary + secondary * 2.2;
    if (score < bestScore) { bestScore = score; best = el; }
  }
  if (best) {
    best.focus();
    best.scrollIntoView({ block: 'nearest', inline: 'nearest', behavior: 'smooth' });
  }
}
