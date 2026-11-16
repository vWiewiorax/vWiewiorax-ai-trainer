import { ExerciseAnalyzer, type AnalyzerConfig } from "../analysis/analyzer";
import type { CameraView, PoseFrame, Severity, TechniqueAnalysis } from "../core/types";

/**
 * Annotation format for the validation dataset (one entry per recording or landmark sequence).
 * Timestamps are milliseconds of media time. `kind: "synthetic"` entries must never be reported
 * as real-world accuracy.
 */
export interface DatasetAnnotation {
  id: string;
  kind: "real" | "synthetic";
  /** Original media or generator description; landmark files live next to the annotation file. */
  source: string;
  landmarksFile?: string;
  exercise: string;
  /** Equipment / variation actually shown (e.g. "barbell", "trap bar"). */
  variation?: string;
  cameraView: CameraView | "mixed";
  conditions?: string[];
  /** Number of complete repetitions (lift and return) an annotator counted. */
  expectedRepCount: number;
  repetitions?: { start: number; end: number; complete: boolean; phases?: { phase: string; start: number; end: number }[] }[];
  visibleLandmarks?: string;
  errors: { type: string; rep?: number; severity?: Severity; annotatorConfidence: number }[];
  /** Whether the engine is expected to refuse scoring (wrong view, multiple people, cuts, ...). */
  expectUnscorable?: boolean;
  /** False when nobody labeled technique errors; detected errors are then listed but not scored as FP/FN. */
  errorsAnnotated?: boolean;
  /** Edit points (ms) in the source media, measured offline (ffmpeg scene filter) for stored landmark files. */
  sceneCutsMs?: number[];
  annotator: string;
  /** 0..1, how much the label itself can be trusted (non-expert / low frame rate labels are low). */
  annotationConfidence: number;
  notes?: string;
}

export interface SequenceResult {
  id: string;
  kind: DatasetAnnotation["kind"];
  expectedReps: number;
  detectedReps: number;
  repCountError: number;
  expectedErrors: string[];
  detectedErrors: string[];
  truePositives: string[];
  falsePositives: string[];
  falseNegatives: string[];
  averageScore: number | null;
  analysisConfidence: number;
  usableFrameRatio: number;
  dominantView: CameraView;
  scoredWhenUnscorable: boolean;
}

/** Marks the first frame at or after each known edit point, as the video frame processor would. */
export function applySceneCuts(frames: readonly PoseFrame[], cutsMs: readonly number[] = []): PoseFrame[] {
  const marked = new Set<number>();
  for (const c of cutsMs) {
    const i = frames.findIndex((f) => f.timestamp >= c);
    if (i >= 0) marked.add(i);
  }
  return frames.map((f, i) => (marked.has(i) ? { ...f, cameraMetadata: { ...f.cameraMetadata, sceneCut: true } } : f));
}

export function runSequence(frames: readonly PoseFrame[], cfg: AnalyzerConfig): TechniqueAnalysis {
  const analyzer = new ExerciseAnalyzer(cfg);
  for (const f of frames) analyzer.processFrame(f);
  return analyzer.endSet();
}

/** Set-level comparison: error types are matched per recording, not per frame. */
export function compareToAnnotation(report: TechniqueAnalysis, ann: DatasetAnnotation): SequenceResult {
  const expected = [...new Set(ann.errors.filter((e) => e.annotatorConfidence >= 0.5).map((e) => e.type))];
  const detected = [...new Set(report.detectedErrors.map((e) => e.type))];
  const labeled = ann.errorsAnnotated !== false;
  return {
    id: ann.id,
    kind: ann.kind,
    expectedReps: ann.expectedRepCount,
    detectedReps: report.repetitionCount,
    repCountError: report.repetitionCount - ann.expectedRepCount,
    expectedErrors: expected,
    detectedErrors: detected,
    truePositives: labeled ? detected.filter((d) => expected.includes(d)) : [],
    falsePositives: labeled ? detected.filter((d) => !expected.includes(d)) : [],
    falseNegatives: labeled ? expected.filter((e) => !detected.includes(e)) : [],
    averageScore: report.averageTechniqueScore,
    analysisConfidence: report.analysisConfidence,
    usableFrameRatio: report.cameraQuality.usableFrameRatio,
    dominantView: report.cameraQuality.view,
    scoredWhenUnscorable: !!ann.expectUnscorable && report.averageTechniqueScore !== null,
  };
}

export interface DatasetMetrics {
  sequences: number;
  repCountExact: number;
  repCountMeanAbsError: number;
  errorPrecision: number | null;
  errorRecall: number | null;
  falsePositives: number;
  falseNegatives: number;
  scoredWhenUnscorable: number;
}

export function aggregateMetrics(results: readonly SequenceResult[]): DatasetMetrics {
  const tp = results.reduce((a, r) => a + r.truePositives.length, 0);
  const fp = results.reduce((a, r) => a + r.falsePositives.length, 0);
  const fn = results.reduce((a, r) => a + r.falseNegatives.length, 0);
  return {
    sequences: results.length,
    repCountExact: results.filter((r) => r.repCountError === 0).length,
    repCountMeanAbsError: results.length ? results.reduce((a, r) => a + Math.abs(r.repCountError), 0) / results.length : 0,
    errorPrecision: tp + fp ? tp / (tp + fp) : null,
    errorRecall: tp + fn ? tp / (tp + fn) : null,
    falsePositives: fp,
    falseNegatives: fn,
    scoredWhenUnscorable: results.filter((r) => r.scoredWhenUnscorable).length,
  };
}
