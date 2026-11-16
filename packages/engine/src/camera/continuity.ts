import type { NormalizedPose } from "../core/types";
import { distance, midpoint, type Vec2 } from "../geometry/vector";

export type Discontinuity = "none" | "gap" | "jump";

export interface ContinuityOptions {
  /** Consecutive detections closer than this are compared for jumps. */
  maxStepMs: number;
  /** Torso-midpoint shift between two consecutive detections, in torso lengths. */
  maxShift: number;
  /** Allowed torso-length ratio between consecutive detections (and across a gap). */
  maxScaleRatio: number;
  /** No person for longer than this breaks the current repetition. */
  maxGapMs: number;
  minConfidence: number;
}

export const DEFAULT_CONTINUITY: ContinuityOptions = {
  maxStepMs: 300,
  maxShift: 0.6,
  maxScaleRatio: 1.35,
  maxGapMs: 1000,
  minConfidence: 0.5,
};

/**
 * Detects edits, camera moves and a different person entering the frame from the torso anchor,
 * which stays rigid during a lift. "gap": the person was missing too long (the open repetition
 * cannot be evaluated). "jump": position or size changed faster than a body can move, so the
 * body baseline no longer applies.
 */
export class ContinuityMonitor {
  private readonly opts: ContinuityOptions;
  private prev: { t: number; c: Vec2; len: number } | null = null;

  constructor(opts: Partial<ContinuityOptions> = {}) {
    this.opts = { ...DEFAULT_CONTINUITY, ...opts };
  }

  reset(): void {
    this.prev = null;
  }

  update(points: NormalizedPose, t: number): Discontinuity {
    const ok = (n: keyof NormalizedPose) => {
      const p = points[n];
      return p && p.confidence >= this.opts.minConfidence ? p : null;
    };
    const avg = (a: Vec2 | null, b: Vec2 | null) => (a && b ? midpoint(a, b) : a ?? b);
    const sh = avg(ok("leftShoulder"), ok("rightShoulder"));
    const hip = avg(ok("leftHip"), ok("rightHip"));
    if (!sh || !hip) return "none";
    const len = distance(sh, hip);
    if (len < 1e-3) return "none";
    const c = midpoint(sh, hip);
    const prev = this.prev;
    this.prev = { t, c, len };
    if (!prev) return "none";
    const dt = t - prev.t;
    const ratio = Math.max(len / prev.len, prev.len / len);
    if (dt > this.opts.maxGapMs) return ratio > this.opts.maxScaleRatio ? "jump" : "gap";
    if (dt <= this.opts.maxStepMs && (ratio > this.opts.maxScaleRatio || distance(c, prev.c) > this.opts.maxShift * prev.len)) return "jump";
    return "none";
  }
}
