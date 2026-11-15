import type {
  BiomechanicalFrame,
  CameraView,
  ErrorDefinition,
  ExerciseDefinition,
  PhaseSpan,
  RuleCondition,
  Severity,
  TechniqueError,
} from "../core/types";
import { computeStat, samplesFor, selectSpan, type Sample } from "./series";

export interface RuleOverrides {
  /** Threshold overrides (already clamped to the rule's adjustable range). */
  thresholds: Record<string, number>;
  /** Rule types disabled by the trainer (safety-critical rules cannot be disabled). */
  disabled: Set<string>;
  /** Baseline values for "baseline" rules, keyed by rule type. */
  baselines: Record<string, number>;
}

export const NO_OVERRIDES: RuleOverrides = { thresholds: {}, disabled: new Set(), baselines: {} };

export interface RuleOutcome {
  type: string;
  rule: ErrorDefinition;
  /** Rule could be evaluated with sufficient data. */
  measured: boolean;
  /** Not applicable (e.g. no baseline yet); neither error nor penalty. */
  skipped?: boolean;
  reason?: string;
  confidence: number;
  error: TechniqueError | null;
}

export interface RepContext {
  exercise: ExerciseDefinition;
  repIndex: number;
  startTimestamp: number;
  endTimestamp: number;
  phases: PhaseSpan[];
  frames: BiomechanicalFrame[];
  view: CameraView;
  viewConfidence: number;
  overrides: RuleOverrides;
  /** Fraction of the rep with a usable signal. */
  coverage: number;
  /** Phase durations (ms) of previous complete reps in the set, keyed by phase id. */
  history: Record<string, number[]>;
}

const MIN_COVERAGE = 0.6;
const MIN_SAMPLES = 3;

export function severityFromBands(deviation: number, bands: [number, number]): Severity {
  if (deviation >= bands[1]) return "HIGH";
  if (deviation >= bands[0]) return "MODERATE";
  return "LOW";
}

const DOWNGRADE: Record<Severity, Severity> = { HIGH: "MODERATE", MODERATE: "LOW", LOW: "LOW" };

/** Evaluates all post-rep rules (stat/duration/deltaRatio/asymmetry/baseline) of an exercise. */
export function evaluateRepetition(ctx: RepContext): RuleOutcome[] {
  return ctx.exercise.evaluationRules.filter((r) => r.condition.kind !== "live").map((r) => evaluateRule(r, ctx));
}

export function evaluateRule(rule: ErrorDefinition, ctx: RepContext): RuleOutcome {
  const base = { type: rule.type, rule };
  if (ctx.overrides.disabled.has(rule.type) && !rule.safetyCritical) {
    return { ...base, measured: false, skipped: true, reason: "wyłączone przez trenera", confidence: 0, error: null };
  }
  if (!rule.views.includes(ctx.view)) {
    return { ...base, measured: false, reason: `wymaga widoku: ${rule.views.join("/")}`, confidence: 0, error: null };
  }
  const cond = rule.condition as RuleCondition;
  const span = selectSpan(ctx.phases, cond.phase, cond.window, { start: ctx.startTimestamp, end: ctx.endTimestamp });
  if (!span) return { ...base, measured: false, reason: `brak fazy ${cond.phase}`, confidence: 0, error: null };

  const threshold = (t: number) => ctx.overrides.thresholds[rule.type] ?? t;
  const viewFactor = 0.6 + 0.4 * ctx.viewConfidence;
  const finish = (
    value: number,
    thr: number,
    deviation: number,
    bands: [number, number],
    dataConf: number,
    start: number,
    end: number,
    unit: string,
  ): RuleOutcome => {
    const confidence = clamp01(dataConf * rule.reliability * viewFactor * Math.min(1, ctx.coverage / 0.9));
    if (confidence < rule.minConfidence) {
      return { ...base, measured: false, reason: "za niska pewność pomiaru", confidence, error: null };
    }
    if (deviation <= 0) return { ...base, measured: true, confidence, error: null };
    let severity = severityFromBands(deviation, bands);
    if (confidence < 0.6) severity = DOWNGRADE[severity];
    return {
      ...base,
      measured: true,
      confidence,
      error: {
        id: `${ctx.exercise.id}-${ctx.repIndex}-${rule.type}`,
        type: rule.type,
        exercise: ctx.exercise.id,
        phase: cond.phase,
        severity,
        confidence: round(confidence, 2),
        startTimestamp: Math.round(start),
        endTimestamp: Math.round(end),
        description: rule.description,
        correctiveFeedback: rule.correction,
        voiceCue: rule.voice,
        recommendedAction: rule.recommendedAction,
        category: rule.category,
        measured: { value: round(value, 3), threshold: thr, unit },
        repIndex: ctx.repIndex,
      },
    };
  };

  const insufficient = (reason = "za mało wiarygodnych klatek"): RuleOutcome => ({
    ...base,
    measured: false,
    reason,
    confidence: 0,
    error: null,
  });

  const getSamples = (feature: string): Sample[] | null => {
    const { samples, total } = samplesFor(ctx.frames, feature, span);
    const good = samples.filter((s) => s.c >= rule.minConfidence * 0.8);
    if (good.length < MIN_SAMPLES || (total > 0 && good.length / total < MIN_COVERAGE)) return null;
    return good;
  };
  const meanConf = (s: Sample[]) => s.reduce((a, b) => a + b.c, 0) / s.length;

  switch (cond.kind) {
    case "stat": {
      const s = getSamples(cond.feature);
      if (!s) return insufficient();
      const st = computeStat(s, cond.stat);
      if (!st) return insufficient();
      const thr = threshold(cond.threshold);
      const dev = cond.compare === ">" ? st.value - thr : thr - st.value;
      const violating = s.filter((x) => (cond.compare === ">" ? x.v > thr : x.v < thr));
      const isPointStat = cond.stat === "min" || cond.stat === "max" || cond.stat === "mean";
      const start = isPointStat && violating.length ? violating[0]!.t : span.start;
      const end = isPointStat && violating.length ? violating[violating.length - 1]!.t : span.end;
      return finish(st.value, thr, dev, cond.bands, meanConf(s), start, end, unitOf(cond.feature));
    }
    case "duration": {
      const d = span.end - span.start;
      const thr = threshold(cond.thresholdMs);
      const dev = cond.compare === ">" ? d - thr : thr - d;
      const { samples, total } = samplesFor(ctx.frames, ctx.exercise.repetition.signal, span);
      const conf = total > 0 ? Math.min(1, samples.length / total) * (samples.length ? meanConf(samples) : 0) : 0;
      return finish(d, thr, dev, cond.bands, conf, span.start, span.end, "ms");
    }
    case "deltaRatio": {
      const num = getSamples(cond.numerator);
      const den = getSamples(cond.denominator);
      if (!num || !den) return insufficient();
      const dn = computeStat(num, "delta")!.value;
      const dd = computeStat(den, "delta")!.value;
      if (Math.abs(dn) < (cond.minNumerator ?? 0)) {
        return { ...base, measured: true, confidence: clamp01(Math.min(meanConf(num), meanConf(den)) * rule.reliability), error: null };
      }
      const denom = Math.sign(dd || 1) * Math.max(Math.abs(dd), cond.minDenominator);
      const ratio = Math.max(-10, Math.min(10, dn / denom));
      const thr = threshold(cond.threshold);
      const dev = cond.compare === ">" ? ratio - thr : thr - ratio;
      return finish(ratio, thr, dev, cond.bands, Math.min(meanConf(num), meanConf(den)), span.start, span.end, "ratio");
    }
    case "asymmetry": {
      const { samples: ls } = samplesFor(ctx.frames, cond.left, span);
      const { samples: rs } = samplesFor(ctx.frames, cond.right, span);
      const rMap = new Map(rs.map((r) => [r.t, r]));
      const diffs: Sample[] = [];
      for (const l of ls) {
        const r = rMap.get(l.t);
        if (r && l.c >= rule.minConfidence && r.c >= rule.minConfidence) diffs.push({ t: l.t, v: Math.abs(l.v - r.v), c: Math.min(l.c, r.c) });
      }
      const total = ctx.frames.filter((f) => f.timestamp >= span.start && f.timestamp <= span.end).length;
      if (diffs.length < MIN_SAMPLES || (total > 0 && diffs.length / total < MIN_COVERAGE)) return insufficient();
      // Use a high percentile instead of the raw max to suppress single-frame glitches.
      const sorted = diffs.map((d) => d.v).sort((a, b) => a - b);
      const value = cond.stat === "maxAbsDiff" ? sorted[Math.floor((sorted.length - 1) * 0.9)]! : sorted.reduce((a, b) => a + b, 0) / sorted.length;
      const thr = threshold(cond.threshold);
      const violating = diffs.filter((d) => d.v > thr);
      return finish(
        value,
        thr,
        value - thr,
        cond.bands,
        meanConf(diffs),
        violating[0]?.t ?? span.start,
        violating[violating.length - 1]?.t ?? span.end,
        unitOf(cond.left),
      );
    }
    case "tempoConsistency": {
      const prev = ctx.history[cond.phase] ?? [];
      if (prev.length < cond.minPreviousReps) {
        return { ...base, measured: false, skipped: true, reason: "za mało powtórzeń do porównania tempa", confidence: 0, error: null };
      }
      const sorted = [...prev].sort((a, b) => a - b);
      const med = sorted[Math.floor(sorted.length / 2)]!;
      const d = span.end - span.start;
      const rel = med > 0 ? Math.abs(d - med) / med : 0;
      const tol = threshold(cond.tolerance);
      const { samples, total } = samplesFor(ctx.frames, ctx.exercise.repetition.signal, span);
      const conf = total > 0 && samples.length ? (samples.length / total) * meanConf(samples) : 0;
      return finish(rel, tol, rel - tol, cond.bands, conf, span.start, span.end, "ratio");
    }
    case "baseline": {
      const ref = ctx.overrides.baselines[rule.type];
      if (ref === undefined) return { ...base, measured: false, skipped: true, reason: "brak indywidualnego wzorca", confidence: 0, error: null };
      const s = getSamples(cond.feature);
      if (!s) return insufficient();
      const st = computeStat(s, cond.stat)!;
      const tol = threshold(cond.tolerance);
      return finish(st.value, ref, Math.abs(st.value - ref) - tol, cond.bands, meanConf(s), span.start, span.end, unitOf(cond.feature));
    }
  }
}

function unitOf(feature: string): string {
  if (/Angle|Inclination|Tilt|Lean|neckAlignment|bodyLine/i.test(feature)) return feature.endsWith(".velocity") ? "deg/s" : "deg";
  return feature.endsWith(".velocity") ? "body/s" : "body";
}

function clamp01(x: number): number {
  return Math.max(0, Math.min(1, x));
}

function round(x: number, d: number): number {
  const k = 10 ** d;
  return Math.round(x * k) / k;
}
