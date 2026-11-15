/**
 * One Euro filter (Casiez et al., CHI 2012): adaptive low-pass filter that
 * smooths jitter at low speeds while keeping latency low for fast movements.
 */
export interface OneEuroParams {
  /** Minimum cutoff frequency (Hz). Lower = smoother at rest. */
  minCutoff: number;
  /** Speed coefficient. Higher = less lag during fast motion. */
  beta: number;
  /** Cutoff for the derivative (Hz). */
  dCutoff: number;
}

export const DEFAULT_ONE_EURO: OneEuroParams = { minCutoff: 1.7, beta: 0.4, dCutoff: 1.0 };

function smoothingFactor(dtSec: number, cutoff: number): number {
  const r = 2 * Math.PI * cutoff * dtSec;
  return r / (r + 1);
}

export class OneEuroFilter {
  private xPrev: number | null = null;
  private dxPrev = 0;
  private tPrev: number | null = null;

  constructor(private readonly params: OneEuroParams = DEFAULT_ONE_EURO) {}

  reset(): void {
    this.xPrev = null;
    this.dxPrev = 0;
    this.tPrev = null;
  }

  /** @param timestampMs monotonic time in ms */
  filter(x: number, timestampMs: number): number {
    if (this.xPrev === null || this.tPrev === null) {
      this.xPrev = x;
      this.tPrev = timestampMs;
      return x;
    }
    const dt = Math.max(1e-3, (timestampMs - this.tPrev) / 1000);
    const dx = (x - this.xPrev) / dt;
    const aD = smoothingFactor(dt, this.params.dCutoff);
    const dxHat = aD * dx + (1 - aD) * this.dxPrev;
    const cutoff = this.params.minCutoff + this.params.beta * Math.abs(dxHat);
    const a = smoothingFactor(dt, cutoff);
    const xHat = a * x + (1 - a) * this.xPrev;
    this.xPrev = xHat;
    this.dxPrev = dxHat;
    this.tPrev = timestampMs;
    return xHat;
  }

  get value(): number | null {
    return this.xPrev;
  }
}
