import type { LandmarkName, Side } from "../core/landmarks";
import type { NormalizedPose, Point } from "../core/types";
import { distance, midpoint } from "../geometry/vector";

/** Reference segment lengths measured during calibration (camera units). */
export interface BodyBaseline {
  torso: number;
  thigh: number;
  shin: number;
  upperArm: number;
  forearm: number;
  shoulderWidth: number;
  hipWidth: number;
  legLength: number;
  /** Standing height proxy (nose to ankle). */
  height: number;
}

export function pointOk(p: Point | undefined, minConfidence: number): p is Point {
  return !!p && p.confidence >= minConfidence;
}

export function getPoints(pose: NormalizedPose, names: LandmarkName[], minConfidence: number): Point[] | null {
  const out: Point[] = [];
  for (const n of names) {
    const p = pose[n];
    if (!pointOk(p, minConfidence)) return null;
    out.push(p);
  }
  return out;
}

export function mid(pose: NormalizedPose, a: LandmarkName, b: LandmarkName, minConfidence: number): Point | null {
  const pa = pose[a];
  const pb = pose[b];
  const okA = pointOk(pa, minConfidence);
  const okB = pointOk(pb, minConfidence);
  if (okA && okB) return { ...midpoint(pa, pb), confidence: Math.min(pa.confidence, pb.confidence) };
  return null;
}

/** Measures segment lengths of the current pose. Missing segments are omitted. */
export function measureSegments(pose: NormalizedPose, side: Side, minConfidence = 0.5): Partial<BodyBaseline> {
  const s = (n: string) => pose[`${side}${n}` as LandmarkName];
  const seg = (a?: Point, b?: Point) => (pointOk(a, minConfidence) && pointOk(b, minConfidence) ? distance(a, b) : undefined);
  const out: Partial<BodyBaseline> = {};
  const torso = seg(s("Shoulder"), s("Hip"));
  if (torso) out.torso = torso;
  const thigh = seg(s("Hip"), s("Knee"));
  if (thigh) out.thigh = thigh;
  const shin = seg(s("Knee"), s("Ankle"));
  if (shin) out.shin = shin;
  const upperArm = seg(s("Shoulder"), s("Elbow"));
  if (upperArm) out.upperArm = upperArm;
  const forearm = seg(s("Elbow"), s("Wrist"));
  if (forearm) out.forearm = forearm;
  const sw = seg(pose.leftShoulder, pose.rightShoulder);
  if (sw) out.shoulderWidth = sw;
  const hw = seg(pose.leftHip, pose.rightHip);
  if (hw) out.hipWidth = hw;
  if (thigh && shin) out.legLength = thigh + shin;
  const ankle = mid(pose, "leftAnkle", "rightAnkle", minConfidence) ?? (pointOk(s("Ankle"), minConfidence) ? s("Ankle")! : null);
  if (pointOk(pose.nose, minConfidence) && ankle) out.height = Math.abs(ankle.y - pose.nose.y);
  return out;
}
