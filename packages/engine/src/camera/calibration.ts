import { MESSAGES } from "../core/messages";
import type { LandmarkName, Side } from "../core/landmarks";
import type { CalibrationStatus, CameraView, ExerciseDefinition, NormalizedFrame } from "../core/types";
import { type BodyBaseline, measureSegments, pointOk } from "../features/body";
import { inclinationFromVertical, jointAngle } from "../geometry/vector";
import { median } from "../geometry/stats";
import { bodyBox } from "./normalize";
import type { ViewEstimate } from "./view";

export interface CalibrationState {
  status: CalibrationStatus;
  /** Ordered list of user-facing instructions, most important first. */
  guidance: string[];
  /** 0..1 progress of the stillness/baseline capture. */
  progress: number;
  missingLandmarks: LandmarkName[];
  baseline: BodyBaseline | null;
  view: CameraView;
  /** Analysis should only run in READY. */
  analysisAllowed: boolean;
  /** How the body baseline was obtained: a still standing pose, segments observed during movement, or a stored profile. */
  baselineSource: "standing" | "motion" | "stored" | null;
}

export interface CalibrationOptions {
  minVisibility: number;
  /** Visibility threshold for the exercise's occludableLandmarks. */
  occludedMinVisibility: number;
  edgeMargin: number;
  minBodyHeight: number;
  maxBodyHeight: number;
  stillnessMs: number;
  stillnessTolerance: number;
  lostAfterMs: number;
  wrongViewAfterMs: number;
  minBrightness: number;
  /**
   * If the user never holds a still standing pose (e.g. starts at the bar), segment lengths are
   * collected while moving for this long and a high percentile is used to limit 2D foreshortening.
   */
  motionCalibrationMs: number;
}

export const DEFAULT_CALIBRATION: CalibrationOptions = {
  minVisibility: 0.5,
  occludedMinVisibility: 0.2,
  edgeMargin: 0.015,
  minBodyHeight: 0.35,
  maxBodyHeight: 0.97,
  stillnessMs: 800,
  stillnessTolerance: 0.035,
  lostAfterMs: 700,
  wrongViewAfterMs: 1500,
  minBrightness: 0.16,
  motionCalibrationMs: 2500,
};

/**
 * Camera positioning and calibration state machine:
 * NOT_STARTED -> POSITIONING -> CALIBRATING -> READY, with
 * INSUFFICIENT_VISIBILITY / INCORRECT_CAMERA_ANGLE whenever checks fail.
 */
export class CalibrationMonitor {
  private status: CalibrationStatus = "NOT_STARTED";
  private baseline: BodyBaseline | null = null;
  private stillSince: number | null = null;
  private anchor: { x: number; y: number } | null = null;
  private samples: Partial<BodyBaseline>[] = [];
  private lastGood = -Infinity;
  private wrongViewSince: number | null = null;
  private motionSince: number | null = null;
  private motionSamples: Partial<BodyBaseline>[] = [];
  private baselineSource: CalibrationState["baselineSource"] = null;
  private readonly opts: CalibrationOptions;

  constructor(private readonly def: ExerciseDefinition, opts: Partial<CalibrationOptions> = {}) {
    this.opts = { ...DEFAULT_CALIBRATION, ...opts };
  }

  start(): void {
    this.status = "POSITIONING";
    this.baseline = null;
    this.samples = [];
    this.stillSince = null;
    this.motionSince = null;
    this.motionSamples = [];
    this.baselineSource = null;
  }

  /** Use a stored baseline (e.g. from a previous set) and skip the stillness capture. */
  restore(baseline: BodyBaseline): void {
    this.baseline = baseline;
    this.baselineSource = "stored";
    this.status = "READY";
  }

  get current(): CalibrationStatus {
    return this.status;
  }

  update(frame: NormalizedFrame, view: ViewEstimate, nearSide: Side): CalibrationState {
    if (this.status === "NOT_STARTED") this.start();
    const t = frame.timestamp;
    const guidance: string[] = [];
    const required = requiredFor(this.def, view.view, nearSide);
    const occludable = new Set(this.def.occludableLandmarks ?? []);
    const missing = required.filter((n) => !pointOk(frame.points[n], occludable.has(n) ? this.opts.occludedMinVisibility : this.opts.minVisibility));
    const visibleCount = required.length - missing.length;
    const box = bodyBox(frame.points, 0.4);
    const wasReady = this.baseline !== null && (this.status === "READY" || this.status === "INSUFFICIENT_VISIBILITY" || this.status === "INCORRECT_CAMERA_ANGLE");

    let visibilityOk = true;
    if (!box || visibleCount < required.length * 0.4) {
      guidance.push(MESSAGES.calibration.noPerson);
      visibilityOk = false;
    } else if (missing.length > 0) {
      const parts = [...new Set(missing.map((m) => MESSAGES.bodyPart[m]))].join(", ");
      guidance.push(MESSAGES.calibration.missing(parts));
      visibilityOk = false;
    }
    if (box) {
      if (box.minY < this.opts.edgeMargin) guidance.push(MESSAGES.calibration.headCut);
      if (box.maxY > 1 - this.opts.edgeMargin) guidance.push(MESSAGES.calibration.feetCut);
      if (box.minX < this.opts.edgeMargin || box.maxX > frame.aspect - this.opts.edgeMargin) guidance.push(MESSAGES.calibration.sideCut);
      if (box.height > this.opts.maxBodyHeight) guidance.push(MESSAGES.calibration.tooClose);
      else if (box.height < this.opts.minBodyHeight && this.def.calibrationPose === "standing") guidance.push(MESSAGES.calibration.tooFar);
    }
    const brightness = frame.cameraMetadata.brightness;
    if (brightness !== undefined && brightness < this.opts.minBrightness) guidance.push(MESSAGES.calibration.tooDark);

    if (visibilityOk) this.lastGood = t;

    // View check: only meaningful when the estimate is confident.
    const viewKnown = view.view !== "unknown" && view.confidence > 0.35;
    const viewOk = !viewKnown || this.def.allowedCameraAngles.includes(view.view);
    if (!viewOk) {
      if (this.wrongViewSince === null) this.wrongViewSince = t;
    } else {
      this.wrongViewSince = null;
    }
    const viewMsg = MESSAGES.calibration.wrongView(MESSAGES.view[this.def.preferredCameraAngle]);

    if (wasReady) {
      // Already calibrated: only pause on sustained loss of visibility / wrong view.
      if (!visibilityOk && t - this.lastGood > this.opts.lostAfterMs) {
        this.status = "INSUFFICIENT_VISIBILITY";
        guidance.unshift(MESSAGES.calibration.lost);
      } else if (this.wrongViewSince !== null && t - this.wrongViewSince > this.opts.wrongViewAfterMs) {
        this.status = "INCORRECT_CAMERA_ANGLE";
        guidance.unshift(viewMsg);
      } else if (visibilityOk || t - this.lastGood <= this.opts.lostAfterMs) {
        this.status = "READY";
      }
      return this.state(guidance, missing, view.view, 1);
    }

    if (!visibilityOk) {
      this.status = "INSUFFICIENT_VISIBILITY";
      this.resetStillness();
      this.resetMotion();
      return this.state(guidance, missing, view.view, 0);
    }
    if (!viewOk) {
      this.status = "INCORRECT_CAMERA_ANGLE";
      guidance.unshift(viewMsg);
      this.resetStillness();
      this.resetMotion();
      return this.state(guidance, missing, view.view, 0);
    }
    if (this.motionSince === null) this.motionSince = t;
    this.motionSamples.push(measureSegments(frame.points, nearSide, this.opts.minVisibility));
    if (this.def.calibrationPose === "standing" && !isStanding(frame, nearSide)) {
      this.resetStillness();
      const motionProgress = Math.min(1, (t - this.motionSince) / this.opts.motionCalibrationMs);
      if (motionProgress >= 1) {
        const baseline = aggregateBaseline(this.motionSamples, 0.85);
        if (baseline) {
          this.baseline = baseline;
          this.baselineSource = "motion";
          this.status = "READY";
          return this.state([MESSAGES.calibration.ready, ...guidance], missing, view.view, 1);
        }
      }
      this.status = "POSITIONING";
      guidance.unshift(MESSAGES.calibration.standStill);
      return this.state(guidance, missing, view.view, motionProgress * 0.95);
    }

    const center = box ? { x: (box.minX + box.maxX) / 2, y: (box.minY + box.maxY) / 2 } : null;
    const tol = this.opts.stillnessTolerance * Math.max(0.3, box?.height ?? 1);
    if (!center || !this.anchor || Math.hypot(center.x - this.anchor.x, center.y - this.anchor.y) > tol) {
      this.anchor = center;
      this.stillSince = t;
      this.samples = [];
    }
    this.samples.push(measureSegments(frame.points, nearSide, this.opts.minVisibility));
    const progress = Math.min(1, (t - (this.stillSince ?? t)) / this.opts.stillnessMs);
    if (progress >= 1) {
      this.baseline = aggregateBaseline(this.samples);
      if (this.baseline) {
        this.baselineSource = "standing";
        this.status = "READY";
        return this.state([MESSAGES.calibration.ready, ...guidance], missing, view.view, 1);
      }
    }
    this.status = "CALIBRATING";
    return this.state([MESSAGES.calibration.calibrating, ...guidance], missing, view.view, progress);
  }

  private resetMotion(): void {
    this.motionSince = null;
    this.motionSamples = [];
  }

  private resetStillness(): void {
    this.stillSince = null;
    this.anchor = null;
    this.samples = [];
  }

  private state(guidance: string[], missing: LandmarkName[], view: CameraView, progress: number): CalibrationState {
    return {
      status: this.status,
      guidance: [...new Set(guidance)],
      progress,
      missingLandmarks: missing,
      baseline: this.baseline,
      view,
      analysisAllowed: this.status === "READY",
      baselineSource: this.baselineSource,
    };
  }
}

function isStanding(frame: NormalizedFrame, side: Side): boolean {
  const p = frame.points;
  const sh = p[`${side}Shoulder`];
  const hip = p[`${side}Hip`];
  const knee = p[`${side}Knee`];
  const ankle = p[`${side}Ankle`];
  if (!pointOk(sh, 0.4) || !pointOk(hip, 0.4) || !pointOk(knee, 0.4) || !pointOk(ankle, 0.4)) return false;
  const incl = inclinationFromVertical(hip, sh);
  const kneeAngle = jointAngle(hip, knee, ankle);
  return incl !== null && kneeAngle !== null && incl < 25 && kneeAngle > 150;
}

/** Aggregates per-frame segment lengths; `q` (0..1) selects a quantile instead of the median. */
export function aggregateBaseline(samples: Partial<BodyBaseline>[], q?: number): BodyBaseline | null {
  const pick = (k: keyof BodyBaseline) => {
    const v = samples.map((s) => s[k]).filter((x): x is number => typeof x === "number");
    if (!v.length) return undefined;
    if (q === undefined) return median(v);
    const sorted = [...v].sort((a, b) => a - b);
    return sorted[Math.min(sorted.length - 1, Math.floor(q * (sorted.length - 1)))];
  };
  const torso = pick("torso");
  const thigh = pick("thigh");
  const shin = pick("shin");
  if (!torso || !thigh || !shin) return null;
  return {
    torso,
    thigh,
    shin,
    upperArm: pick("upperArm") ?? torso * 0.6,
    forearm: pick("forearm") ?? torso * 0.5,
    shoulderWidth: pick("shoulderWidth") ?? torso * 0.8,
    hipWidth: pick("hipWidth") ?? torso * 0.5,
    legLength: thigh + shin,
    height: pick("height") ?? torso + thigh + shin + torso * 0.35,
  };
}

/** Landmarks that must be visible for the current view. */
export function requiredFor(def: ExerciseDefinition, view: CameraView, nearSide: Side): LandmarkName[] {
  if (def.requireSides === "both" || (view !== "side" && view !== "front-side")) return def.requiredLandmarks;
  const far = nearSide === "left" ? "right" : "left";
  return def.requiredLandmarks.filter((n) => !n.startsWith(far));
}
