// Gamepad polling via the browser Gamepad API (XInput / HID devices on Windows).
// - drives UI navigation (D-pad/stick move, A select, B back, Y search, Start menu)
// - reports connected controllers to the main process (Controller Manager, OmniDoctor)

import type { ControllerKind, DetectedController, UniversalButton } from '@shared/models';
import { moveFocus, type Direction } from './spatial';

/** W3C "standard" mapping button indices -> universal buttons. */
export const STANDARD_BUTTONS: UniversalButton[] = ['A', 'B', 'X', 'Y', 'LB', 'RB', 'LT', 'RT', 'Select', 'Start', 'L3', 'R3', 'DPadUp', 'DPadDown', 'DPadLeft', 'DPadRight', 'Guide'];

export function controllerKind(id: string): ControllerKind {
  const s = id.toLowerCase();
  if (/054c/.test(s) && /0ce6|0df2/.test(s)) return 'dualsense';
  if (/dualsense/.test(s)) return 'dualsense';
  if (/054c/.test(s) && /05c4|09cc|0ba0/.test(s)) return 'dualshock4';
  if (/wireless controller|dualshock/.test(s)) return 'dualshock4';
  if (/057e/.test(s) && /2009/.test(s)) return 'switch_pro';
  if (/pro controller/.test(s)) return 'switch_pro';
  if (/xinput|xbox|045e/.test(s)) return 'xbox';
  return 'generic';
}

export function describePad(p: Gamepad): DetectedController {
  const kind = controllerKind(p.id);
  const name = p.id.replace(/\s*\((STANDARD GAMEPAD|XInput STANDARD GAMEPAD)?[^)]*\)\s*$/i, '').trim() || p.id;
  return {
    key: `${kind}:${p.id}`,
    name: kind === 'xbox' && /xinput/i.test(p.id) ? 'Xbox Controller (XInput)' : name,
    kind,
    api: /xinput/i.test(p.id) ? 'XInput' : 'DirectInput',
    connection: 'Unknown',
    battery: null,
    source: 'gamepad-api',
    index: p.index,
  };
}

export function pads(): Gamepad[] {
  return [...(navigator.getGamepads?.() ?? [])].filter((p): p is Gamepad => !!p && p.connected);
}

export interface PadActions {
  back(): void;
  search(): void;
  menu(): void;
  tab(delta: number): void;
  report(list: DetectedController[]): void;
}

export function startGamepadLoop(actions: PadActions): () => void {
  let raf = 0;
  const prev = new Map<number, boolean[]>();
  let repeatAt = 0;
  let lastDir: Direction | null = null;
  let lastReport = '';
  const tick = () => {
    const list = pads();
    const sig = list.map((p) => p.id + p.index).join('|');
    if (sig !== lastReport) {
      lastReport = sig;
      actions.report(list.map(describePad));
    }
    const now = performance.now();
    let dir: Direction | null = null;
    for (const p of list) {
      const was = prev.get(p.index) ?? [];
      const pressed = p.buttons.map((b) => b.pressed);
      const down = (i: number) => pressed[i] && !was[i];
      // Only react when OmniPC has focus (the emulator gets input while a game runs).
      if (document.hasFocus()) {
        if (down(0)) (document.activeElement as HTMLElement | null)?.click();
        if (down(1)) actions.back();
        if (down(3)) actions.search();
        if (down(9)) actions.menu();
        if (down(4)) actions.tab(-1);
        if (down(5)) actions.tab(1);
      }
      if (pressed[12]) dir = 'up';
      else if (pressed[13]) dir = 'down';
      else if (pressed[14]) dir = 'left';
      else if (pressed[15]) dir = 'right';
      else {
        const [x, y] = [p.axes[0] ?? 0, p.axes[1] ?? 0];
        if (Math.abs(x) > 0.6 || Math.abs(y) > 0.6) dir = Math.abs(x) > Math.abs(y) ? (x > 0 ? 'right' : 'left') : y > 0 ? 'down' : 'up';
      }
      prev.set(p.index, pressed);
    }
    if (dir && document.hasFocus()) {
      if (dir !== lastDir || now >= repeatAt) {
        moveFocus(dir);
        repeatAt = now + (dir === lastDir ? 120 : 380);
      }
    }
    lastDir = dir;
    raf = requestAnimationFrame(tick);
  };
  raf = requestAnimationFrame(tick);
  const onConnect = () => (lastReport = '');
  window.addEventListener('gamepadconnected', onConnect);
  window.addEventListener('gamepaddisconnected', onConnect);
  return () => {
    cancelAnimationFrame(raf);
    window.removeEventListener('gamepadconnected', onConnect);
    window.removeEventListener('gamepaddisconnected', onConnect);
  };
}
