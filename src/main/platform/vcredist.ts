// Installs the Microsoft Visual C++ runtime. The installer is downloaded only
// from Microsoft's official aka.ms link, its Authenticode signature must be
// valid and issued to Microsoft Corporation, and Windows' own UAC prompt asks
// for administrator permission (the only OmniDeck operation that elevates).

import { mkdir, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { OmniFailure } from '../core/errors';
import { hostAllowed } from '../downloads/sources';
import { isWindows, powershellJson } from './powershell';

const URL = 'https://aka.ms/vs/17/release/vc_redist.x64.exe';
const HOSTS = ['aka.ms', 'download.visualstudio.microsoft.com', 'download.microsoft.com'];

export async function installVcRedist(downloadDir: string, fetchImpl: typeof fetch = fetch): Promise<{ message: string; details: string[] }> {
  if (!isWindows) throw new OmniFailure({ code: 'WINDOWS_ONLY', whatHappened: 'Installing the Visual C++ runtime is only possible on Windows.' });
  let url = URL;
  let res: Response | null = null;
  for (let hop = 0; hop < 6; hop++) {
    if (!hostAllowed(url, HOSTS)) throw new OmniFailure({ code: 'UNTRUSTED_REDIRECT', whatHappened: 'The Microsoft download link redirected to an unexpected host; installation was stopped.', detected: [url] });
    res = await fetchImpl(url, { redirect: 'manual', headers: { 'User-Agent': 'OmniDeck-PC' } });
    const loc = res.headers.get('location');
    if (res.status >= 300 && res.status < 400 && loc) {
      url = new globalThis.URL(loc, url).toString();
      continue;
    }
    break;
  }
  if (!res || !res.ok) throw new OmniFailure({ code: 'DOWNLOAD_FAILED', whatHappened: 'Could not download the Visual C++ runtime from Microsoft.', detected: [`HTTP ${res?.status ?? '?'}`] });
  await mkdir(downloadDir, { recursive: true });
  const exe = join(downloadDir, `vc_redist.x64-${Date.now()}.exe`);
  await writeFile(exe, Buffer.from(await res.arrayBuffer()));
  try {
    const p = exe.replace(/'/g, "''");
    const sig = await powershellJson<{ Status: number | string; Subject: string }>(`$s = Get-AuthenticodeSignature -LiteralPath '${p}'; [pscustomobject]@{ Status = [string]$s.Status; Subject = $s.SignerCertificate.Subject } | ConvertTo-Json -Compress`);
    if (!sig || String(sig.Status) !== 'Valid' || !/O=Microsoft Corporation/i.test(sig.Subject ?? '')) {
      throw new OmniFailure({ code: 'SIGNATURE_INVALID', whatHappened: 'The downloaded runtime installer is not validly signed by Microsoft, so OmniDeck did not run it.', detected: [`Signature status: ${sig?.Status ?? 'unknown'}`, `Signer: ${sig?.Subject ?? 'none'}`] });
    }
    const run = await powershellJson<{ ExitCode: number }>(`$p = Start-Process -FilePath '${p}' -ArgumentList '/install','/quiet','/norestart' -Verb RunAs -Wait -PassThru; [pscustomobject]@{ ExitCode = $p.ExitCode } | ConvertTo-Json -Compress`, 600000);
    if (!run) throw new OmniFailure({ code: 'ELEVATION_DECLINED', whatHappened: 'The installer did not run. Administrator permission may have been declined.' });
    // 0 = success, 1638 = newer version already installed, 3010 = success, restart required
    if (![0, 1638, 3010].includes(run.ExitCode)) throw new OmniFailure({ code: 'INSTALLER_FAILED', whatHappened: `The Visual C++ installer failed with exit code ${run.ExitCode}.` });
    return { message: run.ExitCode === 3010 ? 'Visual C++ runtime installed (restart Windows to finish)' : 'Visual C++ runtime installed', details: [`Signed by: ${sig.Subject}`, `Installer exit code ${run.ExitCode}`] };
  } finally {
    await rm(exe, { force: true }).catch(() => undefined);
  }
}
