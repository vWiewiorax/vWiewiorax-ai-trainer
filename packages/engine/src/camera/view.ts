import type { Side } from "../core/landmarks";
import type { CameraView, NormalizedPose } from "../core/types";
import { distance, inclinationFromVertical } from "../geometry/vector";
import { mid, pointOk } from "../features/body";

export interface ViewEstimate {
  view: CameraView;
  confidence: number;
  /** Shoulder/hip width relative to torso length; ~0 in side view, ~0.7+ frontal. */
  widthRatio: number | null;
}

/**
 * Estimates camera orientation relative to the athlete from the projected
 * shoulder/hip width compared to torso length. Only reliable while the trunk is
 * roughly upright; otherwise the previous estimate is kept.
 */
export function estimateViewInstant(pose: NormalizedPose, minConfidence = 0.4): ViewEstimate | null {
  const sh = mid(pose, "leftShoulder", "rightShoulder", minConfidence);
  const hp = mid(pose, "leftHip", "rightHip", minConfidence);
  if (!sh || !hp) return null;
  const torso = distance(sh, hp);
  if (torso < 0.05) return null;
  const incl = inclinationFromVertical(hp, sh);
  if (incl === null || incl > 35) return null;
  const sw = distance(pose.leftShoulder!, pose.rightShoulder!);
  const hw = distance(pose.leftHip!, pose.rightHip!);
  const ratio = (sw + hw * 1.3) / 2 / torso;
  let view: CameraView;
  let confidence: number;
  if (ratio < 0.25) {
    view = "side";
    confidence = 1 - ratio / 0.25 * 0.4;
  } else if (ratio < 0.5) {
    view = "front-side";
    confidence = 0.6;
  } else {
    view = facesCamera(pose) ? "front" : "rear";
    confidence = Math.min(1, 0.6 + (ratio - 0.5));
  }
  return { view, confidence: Math.max(0.3, Math.min(1, confidence)) * Math.min(sh.confidence, hp.confidence), widthRatio: ratio };
}

function facesCamera(pose: NormalizedPose): boolean {
  const nose = pose.nose;
  const sh = mid(pose, "leftShoulder", "rightShoulder", 0.3);
  if (nose?.z !== undefined && sh && pose.leftShoulder?.z !== undefined && pose.rightShoulder?.z !== undefined) {
    const shZ = (pose.leftShoulder.z + pose.rightShoulder.z) / 2;
    return nose.z < shZ;
  }
  const eyes = (pose.leftEye?.confidence ?? 0) + (pose.rightEye?.confidence ?? 0);
  // In a non-mirrored frontal image the person's left shoulder appears on the image right.
  const leftOnRight = pose.leftShoulder && pose.rightShoulder ? pose.leftShoulder.x > pose.rightShoulder.x : true;
  return (nose?.confidence ?? 0) > 0.5 && eyes > 1 && leftOnRight;
}

/** Side closest to the camera, by landmark visibility then depth. */
export function nearSideInstant(pose: NormalizedPose): { side: Side; margin: number } {
  const names = ["Shoulder", "Elbow", "Wrist", "Hip", "Knee", "Ankle"] as const;
  let l = 0;
  let r = 0;
  let lz = 0;
  let rz = 0;
  let nz = 0;
  for (const n of names) {
    const pl = pose[`left${n}`];
    const pr = pose[`right${n}`];
    l += pl?.confidence ?? 0;
    r += pr?.confidence ?? 0;
    if (pl?.z !== undefined && pr?.z !== undefined && pointOk(pl, 0.2) && pointOk(pr, 0.2)) {
      lz += pl.z;
      rz += pr.z;
      nz++;
    }
  }
  const visMargin = (l - r) / names.length;
  if (Math.abs(visMargin) > 0.08 || nz === 0) return { side: visMargin >= 0 ? "left" : "right", margin: Math.abs(visMargin) };
  return { side: lz <= rz ? "left" : "right", margin: Math.abs(lz - rz) / nz };
}

/** Temporal smoothing of view and near-side estimates. */
export class ViewTracker {
  private votes: { t: number; view: CameraView; c: number }[] = [];
  private current: ViewEstimate = { view: "unknown", confidence: 0, widthRatio: null };
  private side: Side = "left";
  private sideCandidate: { side: Side; since: number } | null = null;

  constructor(private readonly windowMs = 1200, private readonly sideSwitchMs = 600) {}

  reset(): void {
    this.votes = [];
    this.current = { view: "unknown", confidence: 0, widthRatio: null };
    this.sideCandidate = null;
  }

  update(pose: NormalizedPose, t: number): { view: ViewEstimate; nearSide: Side } {
    const inst = estimateViewInstant(pose);
    if (inst) this.votes.push({ t, view: inst.view, c: inst.confidence });
    this.votes = this.votes.filter((v) => t - v.t <= this.windowMs);
    if (this.votes.length > 0) {
      const tally = new Map<CameraView, number>();
      let total = 0;
      for (const v of this.votes) {
        tally.set(v.view, (tally.get(v.view) ?? 0) + v.c);
        total += v.c;
      }
      let best: CameraView = "unknown";
      let bestScore = -1;
      for (const [view, score] of tally) {
        if (score > bestScore) {
          best = view;
          bestScore = score;
        }
      }
      this.current = { view: best, confidence: total > 0 ? bestScore / total * Math.min(1, total / this.votes.length) : 0, widthRatio: inst?.widthRatio ?? this.current.widthRatio };
    }

    const ns = nearSideInstant(pose);
    if (ns.side !== this.side && ns.margin > 0.05) {
      if (!this.sideCandidate || this.sideCandidate.side !== ns.side) this.sideCandidate = { side: ns.side, since: t };
      else if (t - this.sideCandidate.since >= this.sideSwitchMs) {
        this.side = ns.side;
        this.sideCandidate = null;
      }
    } else if (ns.side === this.side) {
      this.sideCandidate = null;
    }
    return { view: this.current, nearSide: this.side };
  }
}
