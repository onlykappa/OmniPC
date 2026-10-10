// Computer scan used by onboarding, hardware-based configuration and OmniDoctor.
// All values come from the OS. Fields that cannot be determined are null rather
// than guessed.

import os from 'node:os';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { DisplayInfo, GpuInfo, HardwareProfile, PerformancePreset } from '@shared/models';
import { asArray, isWindows, powershellJson } from './powershell';
import { listDrives } from './drives';
import { checkDependencies } from './dependencies';

interface WinHardware {
  os?: { Caption?: string; Version?: string; BuildNumber?: string };
  cpu?: { Name?: string; NumberOfCores?: number; NumberOfLogicalProcessors?: number; MaxClockSpeed?: number };
  gpus?: { Name?: string; AdapterRAM?: number; DriverVersion?: string; PNPDeviceID?: string }[] | { Name?: string; AdapterRAM?: number; DriverVersion?: string };
  vram?: { DriverDesc?: string; QwMemorySize?: number }[] | { DriverDesc?: string; QwMemorySize?: number };
  features?: Record<string, boolean>;
}

const WIN_HARDWARE_SCRIPT = `
$os = Get-CimInstance Win32_OperatingSystem | Select-Object Caption, Version, BuildNumber
$cpu = Get-CimInstance Win32_Processor | Select-Object -First 1 Name, NumberOfCores, NumberOfLogicalProcessors, MaxClockSpeed
$gpus = @(Get-CimInstance Win32_VideoController | Select-Object Name, AdapterRAM, DriverVersion, PNPDeviceID)
# AdapterRAM is a 32-bit field (caps at 4 GB); the 64-bit value lives in the display class registry key.
$vram = @(Get-ItemProperty -Path 'HKLM:\\SYSTEM\\ControlSet001\\Control\\Class\\{4d36e968-e325-11ce-bfc1-08002be10318}\\0*' -ErrorAction SilentlyContinue |
  Where-Object { $_.'HardwareInformation.qwMemorySize' } |
  ForEach-Object { [pscustomobject]@{ DriverDesc = $_.DriverDesc; QwMemorySize = [int64]$_.'HardwareInformation.qwMemorySize' } })
Add-Type -Namespace OmniPC -Name Cpu -MemberDefinition '[DllImport("kernel32.dll")] public static extern bool IsProcessorFeaturePresent(uint f);'
$features = [ordered]@{
  sse3 = [OmniPC.Cpu]::IsProcessorFeaturePresent(13)
  ssse3 = [OmniPC.Cpu]::IsProcessorFeaturePresent(36)
  sse41 = [OmniPC.Cpu]::IsProcessorFeaturePresent(37)
  sse42 = [OmniPC.Cpu]::IsProcessorFeaturePresent(38)
  avx = [OmniPC.Cpu]::IsProcessorFeaturePresent(39)
  avx2 = [OmniPC.Cpu]::IsProcessorFeaturePresent(40)
  avx512f = [OmniPC.Cpu]::IsProcessorFeaturePresent(41)
}
[pscustomobject]@{ os = $os; cpu = $cpu; gpus = $gpus; vram = $vram; features = $features } | ConvertTo-Json -Depth 4 -Compress
`;

export function gpuVendor(name: string): GpuInfo['vendor'] {
  const n = name.toLowerCase();
  if (/nvidia|geforce|quadro|rtx|gtx/.test(n)) return 'nvidia';
  if (/amd|radeon|ati /.test(n)) return 'amd';
  if (/intel|arc |iris|uhd graphics/.test(n)) return 'intel';
  return 'other';
}

function linuxCpuFeatures(): string[] {
  try {
    const info = readFileSync('/proc/cpuinfo', 'utf8');
    const flags = /^flags\s*:\s*(.*)$/m.exec(info)?.[1].split(/\s+/) ?? [];
    const map: Record<string, string> = { pni: 'sse3', ssse3: 'ssse3', sse4_1: 'sse41', sse4_2: 'sse42', avx: 'avx', avx2: 'avx2', avx512f: 'avx512f' };
    return Object.entries(map).filter(([f]) => flags.includes(f)).map(([, n]) => n);
  } catch {
    return [];
  }
}

/**
 * Classifies hardware into a tier. Pure function so it is unit-tested.
 * Heuristics are intentionally conservative: when VRAM is unknown we do not
 * assume a high tier.
 */
export function classifyTier(input: { threads: number; ramMB: number; gpus: GpuInfo[]; avx2: boolean }): { tier: HardwareProfile['tier']; reason: string; preset: PerformancePreset } {
  const discrete = input.gpus.filter((g) => g.vendor === 'nvidia' || g.vendor === 'amd' || (g.vendor === 'intel' && /arc/i.test(g.name)));
  const bestVram = Math.max(0, ...input.gpus.map((g) => g.vramMB ?? 0));
  const reasons: string[] = [];
  let score = 0;
  if (input.threads >= 16) { score += 2; reasons.push(`${input.threads} CPU threads`); } else if (input.threads >= 8) { score += 1; reasons.push(`${input.threads} CPU threads`); } else reasons.push(`only ${input.threads} CPU threads`);
  if (input.ramMB >= 30000) score += 1;
  if (input.ramMB < 7000) { score -= 1; reasons.push(`${Math.round(input.ramMB / 1024)} GB RAM`); }
  if (discrete.length) {
    if (bestVram >= 10000) { score += 3; reasons.push(`${Math.round(bestVram / 1024)} GB VRAM`); } else if (bestVram >= 6000) { score += 2; reasons.push(`${Math.round(bestVram / 1024)} GB VRAM`); } else if (bestVram >= 3500) { score += 1; reasons.push(`${Math.round(bestVram / 1024)} GB VRAM`); } else reasons.push('discrete GPU with unknown or low VRAM');
  } else {
    reasons.push('integrated graphics');
  }
  if (!input.avx2) { score -= 1; reasons.push('no AVX2'); }
  const tier: HardwareProfile['tier'] = score >= 5 ? 'enthusiast' : score >= 3 ? 'high' : score >= 1 ? 'mid' : 'low';
  const preset: PerformancePreset = tier === 'enthusiast' ? 'quality' : tier === 'high' ? 'quality' : tier === 'mid' ? 'balanced' : 'performance';
  return { tier, reason: reasons.join(', '), preset };
}

export async function scanHardware(displays: DisplayInfo[]): Promise<HardwareProfile> {
  const cpus = os.cpus();
  let osName = `${os.type()} ${os.release()}`;
  let osVersion = os.release();
  let osBuild: string | null = null;
  let cpuModel = cpus[0]?.model?.trim() ?? 'Unknown CPU';
  let cores = cpus.length;
  const threads = cpus.length;
  let speed = cpus[0]?.speed ?? 0;
  let features: string[] = [];
  let gpus: GpuInfo[] = [];

  if (isWindows) {
    const hw = await powershellJson<WinHardware>(WIN_HARDWARE_SCRIPT, 30000);
    if (hw?.os) {
      osName = hw.os.Caption ?? osName;
      osVersion = hw.os.Version ?? osVersion;
      osBuild = hw.os.BuildNumber ?? null;
    }
    if (hw?.cpu) {
      cpuModel = hw.cpu.Name?.trim() ?? cpuModel;
      cores = hw.cpu.NumberOfCores ?? cores;
      speed = hw.cpu.MaxClockSpeed ?? speed;
    }
    features = Object.entries(hw?.features ?? {}).filter(([, v]) => v).map(([k]) => k);
    const vramList = asArray(hw?.vram);
    gpus = asArray(hw?.gpus)
      .filter((g) => g.Name && !/microsoft basic|remote display|virtual/i.test(g.Name))
      .map((g) => {
        const reg = vramList.find((v) => v.DriverDesc === g.Name);
        const vram = reg?.QwMemorySize ? Math.round(reg.QwMemorySize / 1048576) : g.AdapterRAM && g.AdapterRAM > 0 ? Math.round(g.AdapterRAM / 1048576) : null;
        return { name: g.Name!, vendor: gpuVendor(g.Name!), vramMB: vram, driverVersion: g.DriverVersion ?? null };
      });
  } else {
    features = linuxCpuFeatures();
  }

  const ramMB = Math.round(os.totalmem() / 1048576);
  const [drives, dependencies] = await Promise.all([listDrives(), checkDependencies()]);
  const sys32 = join(process.env.SystemRoot ?? 'C:\\Windows', 'System32');
  const graphicsApis = isWindows
    ? {
        directx12: existsSync(join(sys32, 'd3d12.dll')),
        vulkan: existsSync(join(sys32, 'vulkan-1.dll')),
        opengl: existsSync(join(sys32, 'opengl32.dll')),
        notes: [] as string[],
      }
    : { directx12: null, vulkan: null, opengl: null, notes: ['Graphics API detection is only implemented on Windows.'] };
  if (isWindows && !graphicsApis.vulkan) graphicsApis.notes.push('vulkan-1.dll was not found in System32. Vulkan renderers will not work until a GPU driver with Vulkan support is installed.');

  const t = classifyTier({ threads, ramMB, gpus, avx2: features.includes('avx2') });
  return {
    scannedAt: new Date().toISOString(),
    platform: process.platform,
    osName,
    osVersion,
    osBuild,
    isWindows,
    cpu: { model: cpuModel, cores, threads, speedMHz: speed, features },
    ramMB,
    gpus,
    displays,
    drives,
    graphicsApis,
    dependencies,
    tier: t.tier,
    tierReason: t.reason,
    recommendedPreset: t.preset,
  };
}
