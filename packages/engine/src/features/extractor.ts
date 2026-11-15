import type { Side } from "../core/landmarks";
import type { BiomechanicalFrame, CameraView, FeatureMap, NormalizedFrame, Point, TrackedPoint } from "../core/types";
import type { BodyBaseline } from "./body";
import { mid, pointOk } from "./body";
import { KinematicsTracker } from "./kinematics";
import { FEATURES, baseFeatureName, type FeatureContext } from "./registry";

export interface ExtractorOptions {
  /** Features to compute; derived names like "hipHeight.velocity" enable kinematics. */
  features: string[];
  minConfidence?: number;
}

/**
 * Turns a filtered pose into a BiomechanicalFrame. Only the requested features
 * (plus their dependencies for kinematics) are computed each frame.
 */
export class FeatureExtractor {
  private readonly base: string[];
  private readonly kinematic: string[];
  private readonly kin = new KinematicsTracker();
  private readonly minConfidence: number;

  constructor(opts: ExtractorOptions) {
    const all = new Set(opts.features);
    this.kinematic = [...new Set(opts.features.filter((f) => f !== baseFeatureName(f)).map(baseFeatureName))];
    for (const k of this.kinematic) all.add(k);
    this.base = [...all].filter((f) => f in FEATURES);
    this.minConfidence = opts.minConfidence ?? 0.3;
  }

  reset(): void {
    this.kin.reset();
  }

  get featureNames(): string[] {
    return this.base;
  }

  extract(frame: NormalizedFrame, view: CameraView, nearSide: Side, baseline: BodyBaseline | null): BiomechanicalFrame {
    const pose = frame.points;
    const facing = estimateFacing(frame, nearSide);
    const ctx: FeatureContext = { pose, nearSide, view, baseline, facing, minConfidence: this.minConfidence };
    const jointAngles: FeatureMap = {};
    const alignmentMetrics: FeatureMap = {};
    const features: FeatureMap = {};
    for (const name of this.base) {
      const spec = FEATURES[name]!;
      const m = spec.compute(ctx);
      if (!m || !Number.isFinite(m.value)) continue;
      features[name] = m;
      (spec.group === "joint" ? jointAngles : alignmentMetrics)[name] = m;
    }
    const movementVelocities: FeatureMap = {};
    for (const name of this.kinematic) {
      const { velocity, accel } = this.kin.update(name, frame.timestamp, features[name] ?? null);
      if (velocity) {
        movementVelocities[`${name}.velocity`] = velocity;
        features[`${name}.velocity`] = velocity;
      }
      if (accel) features[`${name}.accel`] = accel;
    }
    const used = Object.values(features).map((m) => m!.confidence);
    return {
      timestamp: frame.timestamp,
      jointAngles,
      alignmentMetrics,
      movementVelocities,
      trajectories: trackedPoints(frame, nearSide),
      confidence: used.length ? used.reduce((a, b) => a + b, 0) / used.length : 0,
      view,
      nearSide,
      features,
    };
  }
}

function estimateFacing(frame: NormalizedFrame, side: Side): 1 | -1 {
  const p = frame.points;
  const heel = p[`${side}Heel`];
  const toe = p[`${side}FootIndex`];
  if (pointOk(heel, 0.4) && pointOk(toe, 0.4) && Math.abs(toe.x - heel.x) > 0.01) return toe.x > heel.x ? 1 : -1;
  const nose = p.nose;
  const ear = p[`${side}Ear`];
  if (pointOk(nose, 0.4) && pointOk(ear, 0.4)) return nose.x > ear.x ? 1 : -1;
  return 1;
}

function trackedPoints(frame: NormalizedFrame, side: Side): Partial<Record<TrackedPoint, Point>> {
  const p = frame.points;
  const out: Partial<Record<TrackedPoint, Point>> = {};
  const set = (k: TrackedPoint, v: Point | null | undefined) => {
    if (v && v.confidence >= 0.3) out[k] = v;
  };
  set("hipCenter", mid(p, "leftHip", "rightHip", 0.3));
  set("shoulderCenter", mid(p, "leftShoulder", "rightShoulder", 0.3));
  set("wristCenter", mid(p, "leftWrist", "rightWrist", 0.3));
  set("kneeCenter", mid(p, "leftKnee", "rightKnee", 0.3));
  set("nearWrist", p[`${side}Wrist`]);
  set("nearHip", p[`${side}Hip`]);
  set("nearShoulder", p[`${side}Shoulder`]);
  set("nearKnee", p[`${side}Knee`]);
  return out;
}
