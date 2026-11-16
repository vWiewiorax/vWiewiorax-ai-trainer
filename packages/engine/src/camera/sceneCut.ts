/**
 * Detects abrupt image changes (edits, cuts) from downscaled RGBA pixels using a luminance
 * histogram distance. Used on recorded video, where a montage cut must not be read as movement.
 */
export interface SceneCutOptions {
  bins: number;
  /** Half L1 distance between consecutive normalized histograms, 0..1. */
  threshold: number;
}

export const DEFAULT_SCENE_CUT: SceneCutOptions = { bins: 16, threshold: 0.4 };

export function lumaHistogram(rgba: ArrayLike<number>, bins: number): number[] {
  const h = new Array<number>(bins).fill(0);
  const n = Math.floor(rgba.length / 4);
  if (n === 0) return h;
  for (let i = 0; i < n; i++) {
    const y = 0.2126 * (rgba[i * 4] ?? 0) + 0.7152 * (rgba[i * 4 + 1] ?? 0) + 0.0722 * (rgba[i * 4 + 2] ?? 0);
    const b = Math.min(bins - 1, Math.floor((y / 256) * bins));
    h[b] = (h[b] ?? 0) + 1;
  }
  return h.map((v) => v / n);
}

export class SceneCutDetector {
  private readonly opts: SceneCutOptions;
  private prev: number[] | null = null;

  constructor(opts: Partial<SceneCutOptions> = {}) {
    this.opts = { ...DEFAULT_SCENE_CUT, ...opts };
  }

  reset(): void {
    this.prev = null;
  }

  /** Returns true when this frame differs abruptly from the previous one. */
  update(rgba: ArrayLike<number>): boolean {
    const h = lumaHistogram(rgba, this.opts.bins);
    const prev = this.prev;
    this.prev = h;
    if (!prev) return false;
    let d = 0;
    for (let i = 0; i < h.length; i++) d += Math.abs((h[i] ?? 0) - (prev[i] ?? 0));
    return d / 2 > this.opts.threshold;
  }
}
