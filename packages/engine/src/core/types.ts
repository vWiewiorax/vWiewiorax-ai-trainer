import type { LandmarkName, Side } from "./landmarks";

/* ------------------------------------------------------------------ */
/* Pose input                                                          */
/* ------------------------------------------------------------------ */

/**
 * A single landmark in normalized image coordinates:
 * x, y in [0, 1] relative to the analysed image (y grows downwards),
 * z is model-relative depth (smaller = closer to camera) when the model provides it.
 */
export interface Landmark {
  x: number;
  y: number;
  z?: number;
  /** Likelihood that the landmark is visible (not occluded), 0..1. */
  visibility: number;
  /** Likelihood that the landmark is inside the image, 0..1. */
  presence?: number;
}

export type LandmarkSet = Partial<Record<LandmarkName, Landmark>>;

export type CameraFacing = "user" | "environment" | "unknown";

export interface CameraMetadata {
  width: number;
  height: number;
  /** True when the pixels given to the pose model were horizontally mirrored. */
  mirrored: boolean;
  facing: CameraFacing;
  /** Clockwise rotation (deg) that must be applied to make the image upright. */
  rotation: 0 | 90 | 180 | 270;
  /** Mean image luminance 0..1 when the frame processor measured it. */
  brightness?: number;
  /** Set by the frame processor when the image changed abruptly (edit / cut in recorded video). */
  sceneCut?: boolean;
}

export interface PoseFrame {
  /** Monotonic timestamp in milliseconds. */
  timestamp: number;
  landmarks: LandmarkSet;
  /** Overall pose detection confidence 0..1 (model specific; mean visibility if unavailable). */
  modelConfidence: number;
  cameraMetadata: CameraMetadata;
  /** Model id, e.g. "mediapipe-pose-full". */
  source?: string;
  /** Inference latency of the pose model for this frame, ms. */
  inferenceMs?: number;
}

/* ------------------------------------------------------------------ */
/* Normalized geometry                                                  */
/* ------------------------------------------------------------------ */

/** A point in aspect-corrected camera space (units = image heights). */
export interface Point {
  x: number;
  y: number;
  /** Model-relative depth when available (smaller = closer to camera). */
  z?: number;
  /** Combined reliability 0..1 after filtering. */
  confidence: number;
  /** True when the value was held/predicted because the measurement was rejected. */
  interpolated?: boolean;
}

export type NormalizedPose = Partial<Record<LandmarkName, Point>>;

export interface NormalizedFrame {
  timestamp: number;
  /** Aspect corrected, un-mirrored, upright, smoothed coordinates. */
  points: NormalizedPose;
  /** Image aspect ratio width/height (x range is [0, aspect]). */
  aspect: number;
  modelConfidence: number;
  cameraMetadata: CameraMetadata;
  inferenceMs?: number;
}

/* ------------------------------------------------------------------ */
/* Biomechanics                                                         */
/* ------------------------------------------------------------------ */

export type CameraView = "side" | "front" | "rear" | "front-side" | "unknown";

/** A scalar measurement with its reliability. */
export interface Measurement {
  value: number;
  confidence: number;
}

export type FeatureMap = Partial<Record<string, Measurement>>;

export interface BiomechanicalFrame {
  timestamp: number;
  /** Joint angles in degrees (see docs/conventions.md). */
  jointAngles: FeatureMap;
  /** Alignment, symmetry and position metrics (body-relative units). */
  alignmentMetrics: FeatureMap;
  /** First derivatives of tracked signals per second. */
  movementVelocities: FeatureMap;
  /** Latest positions of tracked points (aspect-corrected camera space). */
  trajectories: Partial<Record<TrackedPoint, Point>>;
  /** Mean confidence of the landmarks used for this frame. */
  confidence: number;
  view: CameraView;
  /** Side of the body closest to the camera (used for sagittal metrics). */
  nearSide: Side;
  /** All features keyed by name (union of the maps above), for rules. */
  features: FeatureMap;
}

export type TrackedPoint = "hipCenter" | "shoulderCenter" | "wristCenter" | "kneeCenter" | "nearWrist" | "nearHip" | "nearShoulder" | "nearKnee";

/* ------------------------------------------------------------------ */
/* Exercise definitions                                                 */
/* ------------------------------------------------------------------ */

export type Severity = "LOW" | "MODERATE" | "HIGH";

export type Comparator = ">" | "<";

export type ScoreCategory =
  | "startingPosition"
  | "coordination"
  | "trunkAlignment"
  | "barTrajectory"
  | "lockout"
  | "loweringControl"
  | "rangeOfMotion"
  | "jointAlignment"
  | "symmetry"
  | "tempo"
  | "stability"
  | "reference";

/** Canonical phase kinds; each exercise labels them with its own names. */
export type PhaseKind = "start" | "concentric" | "end" | "eccentric";

export interface PhaseDefinition {
  id: string;
  kind: PhaseKind;
  label: string;
}

export interface RepetitionConfig {
  /** Feature driving the state machine (degrees or body-relative units). */
  signal: string;
  /** Position of the signal at the start of a repetition. */
  startPosition: "low" | "high";
  /** Signal must exceed this to be in the "high" position. */
  highThreshold: number;
  /** Signal must fall below this to be in the "low" position. */
  lowThreshold: number;
  /** Hysteresis (signal units) used when leaving a position. */
  hysteresis: number;
  /** Minimum time spent in a phase before transitioning (ms). */
  minPhaseMs: number;
  minRepMs: number;
  maxRepMs: number;
  /** Minimum signal range inside a repetition. */
  minRange: number;
  /** Phase ids, mapped from the internal low/rising/high/falling states. */
  phases: {
    low: string;
    rising: string;
    high: string;
    falling: string;
  };
  /** Rep counter increments when this position is reached. */
  countAt: "low" | "high";
  /**
   * A cycle still open when the set ends (no return to the start position) is
   * discarded. For the deadlift this drops the final stand-up after the bar is set down.
   */
  requireReturn?: boolean;
  /**
   * Optional secondary feature whose first rise marks the true movement onset
   * (e.g. hips rising before the shoulders in a deadlift).
   */
  onsetFeature?: string;
  /** Minimum rise of the onset feature that counts as movement. */
  onsetEpsilon?: number;
}

export type Stat = "min" | "max" | "mean" | "range" | "start" | "end" | "delta";

interface ConditionBase {
  /** Phase id, or "rep" for the whole repetition. */
  phase: string;
  /** Optional fraction window inside the phase, e.g. [0, 0.4]. */
  window?: [number, number];
}

export type RuleCondition =
  | (ConditionBase & {
      kind: "stat";
      feature: string;
      stat: Stat;
      compare: Comparator;
      threshold: number;
      /** Deviation beyond threshold (in feature units) at which severity becomes MODERATE / HIGH. */
      bands: [number, number];
    })
  | (ConditionBase & {
      kind: "duration";
      compare: Comparator;
      thresholdMs: number;
      bands: [number, number];
    })
  | (ConditionBase & {
      kind: "deltaRatio";
      numerator: string;
      denominator: string;
      /** |delta denominator| is floored at this value so a stalled denominator yields a large ratio. */
      minDenominator: number;
      /** Rule is skipped when |delta numerator| is below this (no meaningful movement). */
      minNumerator?: number;
      compare: Comparator;
      threshold: number;
      bands: [number, number];
    })
  | (ConditionBase & {
      kind: "asymmetry";
      left: string;
      right: string;
      stat: "maxAbsDiff" | "meanAbsDiff";
      threshold: number;
      bands: [number, number];
    })
  | (ConditionBase & {
      kind: "tempoConsistency";
      /** Relative deviation of the phase duration from the median of previous reps. */
      tolerance: number;
      minPreviousReps: number;
      bands: [number, number];
    })
  | (ConditionBase & {
      kind: "baseline";
      feature: string;
      stat: Stat;
      /** Allowed deviation from the personal / reference baseline. */
      tolerance: number;
      bands: [number, number];
    });

export interface LiveCondition {
  kind: "live";
  feature: string;
  compare: Comparator;
  threshold: number;
  /** Phases in which the check is active. */
  phases: string[];
  /** Condition must hold this long before it is reported (ms). */
  persistMs: number;
  bands: [number, number];
}

/**
 * Instant check of a "stat" rule (min/max with a comparator) on every frame,
 * so a clear deviation is reported while it happens instead of after the rep.
 * Feature, comparator and threshold (incl. trainer overrides) come from the rule.
 */
export interface LiveCheck {
  rule: string;
  /** Phases in which the check is active. */
  phases: string[];
  /** Deviation must hold this long before it is reported (ms). */
  persistMs: number;
}

export interface ErrorDefinition {
  /** Stable error type, e.g. HIP_RISE_TOO_EARLY. */
  type: string;
  category: ScoreCategory;
  /** Base importance 0..1 used for prioritisation and severity. */
  importance: number;
  /** Camera views in which the measurement is meaningful. */
  views: CameraView[];
  /** Intrinsic reliability of the measurement (2D proxies < 1). */
  reliability: number;
  /** Minimum landmark confidence needed to evaluate. */
  minConfidence: number;
  condition: RuleCondition | LiveCondition;
  description: string;
  /** Short coaching cue for text output. */
  correction: string;
  /** Even shorter cue for voice. */
  voice: string;
  recommendedAction?: string;
  /** Safety-critical rules cannot be disabled by personalization. */
  safetyCritical?: boolean;
  /** Allowed range for trainer/personal threshold adjustments. */
  adjustable?: { min: number; max: number };
  /** Label shown to trainers when tuning. */
  label: string;
}

export interface RecognitionPredicate {
  feature: string;
  stat: Stat;
  /** Predicate holds when stat is within [min, max]. */
  min?: number;
  max?: number;
  weight: number;
}

export interface ExerciseDefinition {
  id: string;
  name: string;
  /** Movement family used for recognition alternatives. */
  family: "hinge" | "squat" | "press" | "pull" | "lunge" | "bridge";
  requiredLandmarks: LandmarkName[];
  /** "near": in side views only the near-side counterparts of requiredLandmarks must be visible. */
  requireSides: "near" | "both";
  preferredCameraAngle: CameraView;
  allowedCameraAngles: CameraView[];
  cameraSetup: string;
  calibrationPose: "standing" | "any";
  /**
   * Landmarks that are often hidden by equipment (plates, bar) in the preferred view.
   * They are accepted at a lower visibility; their low confidence still propagates to every metric.
   */
  occludableLandmarks?: LandmarkName[];
  movementPhases: PhaseDefinition[];
  repetition: RepetitionConfig;
  evaluationRules: ErrorDefinition[];
  /** Per-category weights (any positive numbers, renormalized). */
  scoringConfiguration: Partial<Record<ScoreCategory, number>>;
  recognition: RecognitionPredicate[];
  /** Features compared against a trainer reference movement. */
  comparisonFeatures: string[];
  /** Instant in-movement checks surfaced while the repetition is still running. */
  liveChecks?: LiveCheck[];
  keyCheckpoints: string[];
}

/* ------------------------------------------------------------------ */
/* Results                                                              */
/* ------------------------------------------------------------------ */

export interface TechniqueError {
  id: string;
  type: string;
  exercise: string;
  phase: string;
  severity: Severity;
  confidence: number;
  startTimestamp: number;
  endTimestamp: number;
  description: string;
  correctiveFeedback: string;
  voiceCue: string;
  recommendedAction?: string;
  category: ScoreCategory;
  /** Measured value and the threshold it was compared to. */
  measured?: { value: number; threshold: number; unit: string };
  repIndex?: number;
}

export interface PhaseSpan {
  id: string;
  kind: PhaseKind;
  startTimestamp: number;
  endTimestamp: number;
}

export interface CategoryScore {
  category: ScoreCategory;
  weight: number;
  score: number;
  measured: boolean;
  reason?: string;
}

export interface ScoreBreakdown {
  score: number | null;
  /** +- points; grows as analysis confidence drops so uncertain scores are not shown as precise. */
  scoreUncertainty: number | null;
  analysisConfidence: number;
  categories: CategoryScore[];
  unmeasured: { rule: string; reason: string }[];
}

export interface ExerciseRepetition {
  id: string;
  index: number;
  startTimestamp: number;
  endTimestamp: number;
  durationMs: number;
  phases: PhaseSpan[];
  biomechanicalMetrics: Record<string, { min: number; max: number; mean: number }>;
  detectedErrors: TechniqueError[];
  techniqueScore: number | null;
  analysisConfidence: number;
  breakdown: ScoreBreakdown;
  /** Repetition was interrupted by lost landmarks; metrics are partial. */
  incomplete: boolean;
  /** Down-sampled time series used for reference comparison and history. */
  series: RepSeries;
}

export interface RepSeries {
  t: number[];
  features: Record<string, (number | null)[]>;
}

export type CalibrationStatus =
  | "NOT_STARTED"
  | "POSITIONING"
  | "CALIBRATING"
  | "READY"
  | "INSUFFICIENT_VISIBILITY"
  | "INCORRECT_CAMERA_ANGLE";

export interface CameraQuality {
  view: CameraView;
  viewConfidence: number;
  meanVisibility: number;
  usableFrameRatio: number;
  brightness?: number;
  issues: string[];
}

export interface ProcessingMetrics {
  framesReceived: number;
  framesAnalysed: number;
  meanEngineMs: number;
  p95EngineMs: number;
  meanInferenceMs?: number;
  effectiveFps: number;
}

export interface AggregatedError {
  type: string;
  label: string;
  category: ScoreCategory;
  count: number;
  repIndices: number[];
  maxSeverity: Severity;
  meanConfidence: number;
  correction: string;
  description: string;
}

export interface RecognitionResult {
  detectedExercise: string | null;
  confidence: number;
  alternatives: { exercise: string; confidence: number }[];
  matchesExpected: boolean | null;
}

export interface ReferenceComparison {
  similarity: number;
  perFeature: { feature: string; dtwDistance: number; romDifference: number; similarity: number }[];
  tempoRatio: number | null;
  observations: string[];
}

export interface TechniqueAnalysis {
  exerciseId: string;
  repetitionCount: number;
  partialRepetitions: number;
  repetitions: ExerciseRepetition[];
  averageTechniqueScore: number | null;
  analysisConfidence: number;
  detectedErrors: AggregatedError[];
  bestRepetition: number | null;
  worstRepetition: number | null;
  /** 0..100: stability of tempo, range and score between repetitions. */
  consistency: number | null;
  tempo: { meanConcentricMs: number | null; meanEccentricMs: number | null; meanRepMs: number | null };
  recommendations: string[];
  cameraQuality: CameraQuality;
  processingMetrics: ProcessingMetrics;
  recognition: RecognitionResult;
  referenceComparison: ReferenceComparison[] | null;
  safetyNotes: string[];
  engineVersion: string;
}
