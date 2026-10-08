// Minimal line diff (LCS based) for the backup comparison view.

export function diffLines(a: string, b: string): { kind: '+' | '-' | ' '; text: string }[] {
  const x = a === '' ? [] : a.split(/\r?\n/);
  const y = b === '' ? [] : b.split(/\r?\n/);
  // Guard against pathological sizes: fall back to a naive diff.
  if (x.length * y.length > 4_000_000) {
    return [...x.map((t) => ({ kind: '-' as const, text: t })), ...y.map((t) => ({ kind: '+' as const, text: t }))];
  }
  const n = x.length;
  const m = y.length;
  const dp: Uint32Array[] = Array.from({ length: n + 1 }, () => new Uint32Array(m + 1));
  for (let i = n - 1; i >= 0; i--) for (let j = m - 1; j >= 0; j--) dp[i][j] = x[i] === y[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);
  const out: { kind: '+' | '-' | ' '; text: string }[] = [];
  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    if (x[i] === y[j]) { out.push({ kind: ' ', text: x[i] }); i++; j++; }
    else if (dp[i + 1][j] >= dp[i][j + 1]) out.push({ kind: '-', text: x[i++] });
    else out.push({ kind: '+', text: y[j++] });
  }
  while (i < n) out.push({ kind: '-', text: x[i++] });
  while (j < m) out.push({ kind: '+', text: y[j++] });
  // collapse long unchanged runs to keep the UI readable
  const compact: typeof out = [];
  for (let k = 0; k < out.length; k++) {
    const near = out.slice(Math.max(0, k - 3), k + 4).some((l) => l.kind !== ' ');
    if (out[k].kind !== ' ' || near) compact.push(out[k]);
    else if (compact.length && compact[compact.length - 1].text !== '…') compact.push({ kind: ' ', text: '…' });
  }
  return compact;
}
