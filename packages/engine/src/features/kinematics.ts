import type { Measurement } from "../core/types";

interface Sample {
  t: number;
  v: number;
  c: number;
}

/**
 * Finite-difference velocity and acceleration over a short time window,
 * computed on already smoothed signals (units per second, per second²).
 */
export class KinematicsTracker {
  private readonly buffers = new Map<string, Sample[]>();

  constructor(private readonly windowMs = 160) {}

  reset(): void {
    this.buffers.clear();
  }

  update(name: string, t: number, m: Measurement | null): { velocity: Measurement | null; accel: Measurement | null } {
    let buf = this.buffers.get(name);
    if (!buf) {
      buf = [];
      this.buffers.set(name, buf);
    }
    if (!m) {
      buf.length = 0;
      return { velocity: null, accel: null };
    }
    buf.push({ t, v: m.value, c: m.confidence });
    while (buf.length > 2 && t - buf[0]!.t > this.windowMs * 2) buf.shift();
    const velocity = slope(buf, t, this.windowMs);
    if (!velocity) return { velocity: null, accel: null };
    const half = buf.filter((s) => s.t <= t - this.windowMs / 2);
    const prev = half.length >= 2 ? slope(half, half[half.length - 1]!.t, this.windowMs) : null;
    const dt = prev ? (this.windowMs / 2) / 1000 : 0;
    const accel = prev && dt > 0 ? { value: (velocity.value - prev.value) / dt, confidence: Math.min(velocity.confidence, prev.confidence) } : null;
    return { velocity, accel };
  }
}

function slope(buf: Sample[], t: number, windowMs: number): Measurement | null {
  const pts = buf.filter((s) => t - s.t <= windowMs);
  if (pts.length < 2) return null;
  const first = pts[0]!;
  const last = pts[pts.length - 1]!;
  const dt = (last.t - first.t) / 1000;
  if (dt <= 0) return null;
  return { value: (last.v - first.v) / dt, confidence: Math.min(first.c, last.c) };
}
