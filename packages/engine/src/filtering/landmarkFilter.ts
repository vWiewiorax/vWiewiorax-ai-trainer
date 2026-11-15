import { LANDMARK_NAMES, type LandmarkName } from "../core/landmarks";
import type { NormalizedPose, Point } from "../core/types";
import { OneEuroFilter, type OneEuroParams, DEFAULT_ONE_EURO } from "./oneEuro";

export interface LandmarkFilterOptions {
  /** Landmarks below this visibility are treated as missing. */
  minVisibility: number;
  /** Max plausible speed in body heights per second; faster jumps are rejected as outliers. */
  maxSpeed: number;
  /** How long (ms) a missing/rejected landmark may be held at its last value. */
  holdMs: number;
  /** Confidence multiplier per held frame. */
  holdDecay: number;
  smoothing: OneEuroParams;
  /** Lower visibility thresholds for landmarks that are routinely occluded (e.g. shins behind plates). */
  perLandmarkMinVisibility?: Partial<Record<LandmarkName, number>>;
}

export const DEFAULT_LANDMARK_FILTER: LandmarkFilterOptions = {
  minVisibility: 0.5,
  maxSpeed: 8,
  holdMs: 250,
  holdDecay: 0.7,
  smoothing: DEFAULT_ONE_EURO,
};

interface TrackState {
  fx: OneEuroFilter;
  fy: OneEuroFilter;
  last: Point | null;
  lastTs: number;
  lastMeasuredTs: number;
}

/**
 * Temporal landmark filtering: visibility gating, outlier rejection (implausible
 * speed relative to body size), short occlusion hold with decaying confidence,
 * and One Euro smoothing.
 */
export class LandmarkFilter {
  private readonly tracks = new Map<LandmarkName, TrackState>();
  private readonly opts: LandmarkFilterOptions;

  constructor(opts: Partial<LandmarkFilterOptions> = {}) {
    this.opts = { ...DEFAULT_LANDMARK_FILTER, ...opts };
  }

  reset(): void {
    this.tracks.clear();
  }

  /**
   * @param raw aspect-corrected points with raw visibility in `confidence`
   * @param bodyScale current body height estimate (same units as points), used for speed limits
   */
  apply(raw: NormalizedPose, timestamp: number, bodyScale: number): NormalizedPose {
    const out: NormalizedPose = {};
    const scaleRef = Math.max(0.05, bodyScale);
    for (const name of LANDMARK_NAMES) {
      let track = this.tracks.get(name);
      if (!track) {
        track = {
          fx: new OneEuroFilter(this.opts.smoothing),
          fy: new OneEuroFilter(this.opts.smoothing),
          last: null,
          lastTs: timestamp,
          lastMeasuredTs: -Infinity,
        };
        this.tracks.set(name, track);
      }
      const p = raw[name];
      const usable = p && p.confidence >= (this.opts.perLandmarkMinVisibility?.[name] ?? this.opts.minVisibility);
      let accepted = false;
      if (usable && track.last && !track.last.interpolated) {
        const dt = Math.max(1, timestamp - track.lastTs) / 1000;
        const speed = Math.hypot(p.x - track.last.x, p.y - track.last.y) / dt / scaleRef;
        accepted = speed <= this.opts.maxSpeed;
      } else if (usable) {
        accepted = true;
        // Re-acquired after a gap: restart the filter to avoid dragging from a stale value.
        if (track.last?.interpolated || timestamp - track.lastMeasuredTs > this.opts.holdMs) {
          track.fx.reset();
          track.fy.reset();
        }
      }

      if (accepted && p) {
        const x = track.fx.filter(p.x, timestamp);
        const y = track.fy.filter(p.y, timestamp);
        const point: Point = { x, y, z: p.z, confidence: p.confidence };
        track.last = point;
        track.lastTs = timestamp;
        track.lastMeasuredTs = timestamp;
        out[name] = point;
      } else if (track.last && timestamp - track.lastMeasuredTs <= this.opts.holdMs) {
        const held: Point = {
          x: track.last.x,
          y: track.last.y,
          z: track.last.z,
          confidence: track.last.confidence * this.opts.holdDecay,
          interpolated: true,
        };
        track.last = held;
        track.lastTs = timestamp;
        out[name] = held;
      } else {
        track.last = null;
        track.lastTs = timestamp;
      }
    }
    return out;
  }
}
