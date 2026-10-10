// Helpers shared by adapters: resolution presets, executable discovery,
// generic smoke-test execution and Windows exit-code knowledge.

import { readdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import type { HardwareProfile, PerformancePreset } from '@shared/models';

/**
 * Hardware-aware internal resolution scale. Disc-era consoles render at
 * ~480p, so 2x ≈ 960p, 3x ≈ 1440p, 4x ≈ 1920p, 6x ≈ 2880p.
 */
export function resolutionScaleFor(hw: HardwareProfile | null, preset: PerformancePreset, max: number): number {
  const tier = hw?.tier ?? 'mid';
  const table: Record<HardwareProfile['tier'], Record<PerformancePreset, number>> = {
    low: { performance: 1, balanced: 1, quality: 2, maximum: 2 },
    mid: { performance: 1, balanced: 2, quality: 3, maximum: 3 },
    high: { performance: 2, balanced: 3, quality: 4, maximum: 5 },
    enthusiast: { performance: 2, balanced: 4, quality: 5, maximum: 6 },
  };
  let scale = table[tier][preset];
  // Never exceed what the display can show by much: 4K displays benefit up to ~5x, 1080p up to ~3x.
  const display = hw?.displays.find((d) => d.primary) ?? hw?.displays[0];
  if (display) {
    const cap = display.height >= 2000 ? 6 : display.height >= 1400 ? 4 : 3;
    if (preset !== 'maximum') scale = Math.min(scale, cap);
  }
  return Math.max(1, Math.min(scale, max));
}

/** Preferred renderer by GPU vendor and API availability. */
export function preferredRenderer(hw: HardwareProfile | null, ids: { d3d12: string; d3d11: string; vulkan: string; opengl: string }): string {
  if (!hw || !hw.isWindows) return ids.vulkan;
  const gpu = hw.gpus[0];
  if (hw.graphicsApis.vulkan && gpu && (gpu.vendor === 'nvidia' || gpu.vendor === 'amd')) return ids.vulkan;
  if (hw.graphicsApis.directx12) return ids.d3d12;
  return ids.d3d11;
}

export async function findExeIn(dir: string, patterns: RegExp[]): Promise<string | null> {
  if (!existsSync(dir)) return null;
  const files = await readdir(dir).catch(() => [] as string[]);
  for (const p of patterns) {
    const hit = files.find((f) => p.test(f));
    if (hit) return join(dir, hit);
  }
  return null;
}

/** NTSTATUS codes a crashing Windows process commonly exits with. */
export const WINDOWS_EXIT_CODES: Record<number, { name: string; meaning: string; cause: string }> = {
  [-1073741515]: { name: 'STATUS_DLL_NOT_FOUND (0xC0000135)', meaning: 'A required DLL was not found.', cause: 'Usually the Microsoft Visual C++ runtime is missing, or the emulator folder is incomplete.' },
  [-1073741701]: { name: 'STATUS_INVALID_IMAGE_FORMAT (0xC000007B)', meaning: 'A 32/64-bit mismatch or corrupt DLL.', cause: 'A damaged emulator install or a wrong-architecture runtime DLL.' },
  [-1073741795]: { name: 'STATUS_ILLEGAL_INSTRUCTION (0xC000001D)', meaning: 'The CPU hit an instruction it does not support.', cause: 'An emulator build optimised for newer CPUs (e.g. AVX2) was used on a CPU without that instruction set.' },
  [-1073741819]: { name: 'STATUS_ACCESS_VIOLATION (0xC0000005)', meaning: 'The emulator crashed (invalid memory access).', cause: 'Often a graphics driver/renderer problem, a corrupt cache, or a bad game dump.' },
  [-1073740791]: { name: 'STATUS_STACK_BUFFER_OVERRUN (0xC0000409)', meaning: 'The emulator aborted on a fatal internal error.', cause: 'An emulator bug or incompatible configuration; check the emulator log.' },
  [-1073741502]: { name: 'STATUS_DLL_INIT_FAILED (0xC0000142)', meaning: 'A DLL failed to initialise.', cause: 'Graphics driver or runtime problem, or antivirus blocking the emulator.' },
  [-1073741510]: { name: 'STATUS_CONTROL_C_EXIT (0xC000013A)', meaning: 'The emulator was closed by a console/system shutdown signal.', cause: 'Closed externally; usually not an error.' },
  [-1073740940]: { name: 'STATUS_HEAP_CORRUPTION (0xC0000374)', meaning: 'The emulator corrupted its memory and crashed.', cause: 'Emulator bug, overlay software injecting into the process, or unstable overclock.' },
};

/** Exit codes are reported as unsigned on some paths; normalise to signed 32-bit. */
export function normaliseExitCode(code: number | null): number | null {
  if (code === null) return null;
  return code > 0x7fffffff ? code - 0x100000000 : code;
}
