// Runtime dependency detection (Visual C++ runtime, .NET, graphics drivers).

import type { DependencyStatus } from '@shared/models';
import { isWindows, powershellJson } from './powershell';

const VC_SCRIPT = `
$k = Get-ItemProperty -Path 'HKLM:\\SOFTWARE\\Microsoft\\VisualStudio\\14.0\\VC\\Runtimes\\x64' -ErrorAction SilentlyContinue
if (-not $k) { $k = Get-ItemProperty -Path 'HKLM:\\SOFTWARE\\WOW6432Node\\Microsoft\\VisualStudio\\14.0\\VC\\Runtimes\\x64' -ErrorAction SilentlyContinue }
$dotnet = @()
foreach ($p in @('C:\\Program Files\\dotnet\\shared\\Microsoft.WindowsDesktop.App')) { if (Test-Path $p) { $dotnet += (Get-ChildItem $p -Directory | Select-Object -ExpandProperty Name) } }
[pscustomobject]@{ vcInstalled = [bool]($k -and $k.Installed -eq 1); vcVersion = $k.Version; dotnetDesktop = $dotnet } | ConvertTo-Json -Compress
`;

/** Minimum VC++ 2015-2022 x64 runtime known to satisfy current PCSX2/Dolphin builds. */
export const MIN_VC_RUNTIME = [14, 40];

export function compareVcVersion(v: string | null | undefined, min = MIN_VC_RUNTIME): boolean | null {
  if (!v) return null;
  const m = /v?(\d+)\.(\d+)/.exec(v);
  if (!m) return null;
  const major = Number(m[1]);
  const minor = Number(m[2]);
  return major > min[0] || (major === min[0] && minor >= min[1]);
}

export async function checkDependencies(): Promise<DependencyStatus[]> {
  if (!isWindows) {
    return [{ id: 'vcredist-x64', name: 'Microsoft Visual C++ Runtime (x64)', installed: null, version: null, detail: 'Only checked on Windows.', fixUrl: null }];
  }
  const r = await powershellJson<{ vcInstalled: boolean; vcVersion?: string; dotnetDesktop?: string[] | string }>(VC_SCRIPT);
  const vcOk = r?.vcInstalled ? compareVcVersion(r.vcVersion) : false;
  const dotnet = r?.dotnetDesktop ? (Array.isArray(r.dotnetDesktop) ? r.dotnetDesktop : [r.dotnetDesktop]) : [];
  return [
    {
      id: 'vcredist-x64',
      name: 'Microsoft Visual C++ 2015-2022 Runtime (x64)',
      installed: r ? !!r.vcInstalled && vcOk !== false : null,
      version: r?.vcVersion ?? null,
      detail: !r
        ? 'Could not query the registry.'
        : !r.vcInstalled
          ? 'Not installed. PCSX2, Dolphin and most emulators will not start without it.'
          : vcOk === false
            ? `Installed version ${r.vcVersion} is older than ${MIN_VC_RUNTIME.join('.')}; newer emulator builds may fail to start.`
            : `Installed (${r.vcVersion}).`,
      fixUrl: 'https://aka.ms/vs/17/release/vc_redist.x64.exe',
    },
    {
      id: 'dotnet-desktop',
      name: '.NET Desktop Runtime',
      installed: dotnet.length > 0,
      version: dotnet.length ? dotnet[dotnet.length - 1] : null,
      detail: dotnet.length ? `Installed versions: ${dotnet.join(', ')}` : 'Not installed. Only needed by some optional tools; OmniPC and the PCSX2/Dolphin integrations do not require it.',
      fixUrl: 'https://dotnet.microsoft.com/download/dotnet',
    },
  ];
}
