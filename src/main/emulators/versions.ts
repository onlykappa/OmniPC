/** Compares dotted versions ("2.8.2" vs "2.9.0"); non-numeric parts compare as strings. */
export function compareVersions(a: string, b: string): number {
  const pa = a.replace(/^v/i, '').split(/[.\-+]/);
  const pb = b.replace(/^v/i, '').split(/[.\-+]/);
  const n = Math.max(pa.length, pb.length);
  for (let i = 0; i < n; i++) {
    const x = pa[i] ?? '0';
    const y = pb[i] ?? '0';
    const nx = Number(x);
    const ny = Number(y);
    if (!Number.isNaN(nx) && !Number.isNaN(ny)) {
      if (nx !== ny) return nx < ny ? -1 : 1;
    } else if (x !== y) return x < y ? -1 : 1;
  }
  return 0;
}

export function isNewer(candidate: string | null, current: string | null): boolean {
  if (!candidate) return false;
  if (!current) return true;
  return compareVersions(candidate, current) > 0;
}
