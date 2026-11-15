/**
 * Adaptive inference rate: keeps at most one frame in flight and lowers the
 * target rate when inference is slower than the frame budget.
 */
export class AdaptiveScheduler {
  private ema = 0;
  private lastSent = -Infinity;
  inFlight = false;
  dropped = 0;

  constructor(
    private readonly maxFps = 30,
    private readonly minFps = 8,
  ) {}

  get targetFps(): number {
    if (this.ema <= 0) return this.maxFps;
    return Math.max(this.minFps, Math.min(this.maxFps, 1000 / (this.ema * 1.15)));
  }

  shouldProcess(now: number): boolean {
    if (this.inFlight || now - this.lastSent < 1000 / this.targetFps - 2) {
      this.dropped++;
      return false;
    }
    this.lastSent = now;
    this.inFlight = true;
    return true;
  }

  done(latencyMs: number): void {
    this.inFlight = false;
    this.ema = this.ema === 0 ? latencyMs : this.ema * 0.85 + latencyMs * 0.15;
  }

  get meanLatencyMs(): number {
    return this.ema;
  }
}
