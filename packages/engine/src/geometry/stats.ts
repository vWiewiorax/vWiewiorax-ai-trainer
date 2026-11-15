export function mean(values: readonly number[]): number {
  if (values.length === 0) return NaN;
  let s = 0;
  for (const v of values) s += v;
  return s / values.length;
}

export function std(values: readonly number[]): number {
  if (values.length < 2) return 0;
  const m = mean(values);
  let s = 0;
  for (const v of values) s += (v - m) ** 2;
  return Math.sqrt(s / (values.length - 1));
}

export function percentile(values: readonly number[], p: number): number {
  if (values.length === 0) return NaN;
  const sorted = [...values].sort((a, b) => a - b);
  const idx = Math.min(sorted.length - 1, Math.max(0, Math.ceil((p / 100) * sorted.length) - 1));
  return sorted[idx]!;
}

export function median(values: readonly number[]): number {
  if (values.length === 0) return NaN;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid]! : (sorted[mid - 1]! + sorted[mid]!) / 2;
}

/** Coefficient of variation (std / |mean|); 0 for empty or zero-mean input. */
export function coefficientOfVariation(values: readonly number[]): number {
  const m = mean(values);
  if (!Number.isFinite(m) || Math.abs(m) < 1e-9) return 0;
  return std(values) / Math.abs(m);
}

export const clamp = (v: number, lo: number, hi: number): number => Math.min(hi, Math.max(lo, v));

/** Linear resampling of a series to n evenly spaced samples. Null gaps are interpolated. */
export function resample(values: readonly (number | null)[], n: number): number[] | null {
  const known: [number, number][] = [];
  values.forEach((v, i) => {
    if (v !== null && Number.isFinite(v)) known.push([i, v]);
  });
  if (known.length < 2 || n < 2) return null;
  const out: number[] = [];
  const last = values.length - 1;
  let k = 0;
  for (let j = 0; j < n; j++) {
    const pos = (j / (n - 1)) * last;
    while (k < known.length - 2 && known[k + 1]![0] < pos) k++;
    const [i0, v0] = known[k]!;
    const [i1, v1] = known[k + 1]!;
    if (pos <= i0) out.push(v0);
    else if (pos >= i1) out.push(v1);
    else out.push(v0 + ((v1 - v0) * (pos - i0)) / (i1 - i0));
  }
  return out;
}
