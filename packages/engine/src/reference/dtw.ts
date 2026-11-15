/**
 * Dynamic Time Warping with a Sakoe-Chiba band. Returns the mean absolute
 * difference along the optimal warping path (same units as the input).
 */
export function dtw(a: readonly number[], b: readonly number[], bandRatio = 0.2): { distance: number; path: [number, number][] } {
  const n = a.length;
  const m = b.length;
  if (n === 0 || m === 0) return { distance: Infinity, path: [] };
  const band = Math.max(Math.abs(n - m), Math.ceil(Math.max(n, m) * bandRatio));
  const INF = Number.POSITIVE_INFINITY;
  const cost = new Float64Array((n + 1) * (m + 1)).fill(INF);
  const idx = (i: number, j: number) => i * (m + 1) + j;
  cost[idx(0, 0)] = 0;
  for (let i = 1; i <= n; i++) {
    const jStart = Math.max(1, Math.floor((i * m) / n) - band);
    const jEnd = Math.min(m, Math.ceil((i * m) / n) + band);
    for (let j = jStart; j <= jEnd; j++) {
      const d = Math.abs(a[i - 1]! - b[j - 1]!);
      cost[idx(i, j)] = d + Math.min(cost[idx(i - 1, j)]!, cost[idx(i, j - 1)]!, cost[idx(i - 1, j - 1)]!);
    }
  }
  const path: [number, number][] = [];
  let i = n;
  let j = m;
  while (i > 0 && j > 0) {
    path.push([i - 1, j - 1]);
    const diag = cost[idx(i - 1, j - 1)]!;
    const up = cost[idx(i - 1, j)]!;
    const left = cost[idx(i, j - 1)]!;
    if (diag <= up && diag <= left) {
      i--;
      j--;
    } else if (up <= left) i--;
    else j--;
  }
  path.reverse();
  const total = cost[idx(n, m)]!;
  return { distance: path.length ? total / path.length : Infinity, path };
}
