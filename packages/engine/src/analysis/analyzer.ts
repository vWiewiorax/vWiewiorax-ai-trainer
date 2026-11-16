import type { Side } from "../core/landmarks";
import { MESSAGES } from "../core/messages";
import type {
  AggregatedError,
  BiomechanicalFrame,
  CameraQuality,
  CameraView,
  ExerciseDefinition,
  ExerciseRepetition,
  NormalizedFrame,
  NormalizedPose,
  PoseFrame,
  ProcessingMetrics,
  ReferenceComparison,
  RuleCondition,
  Severity,
  TechniqueAnalysis,
  TechniqueError,
} from "../core/types";
import { ENGINE_VERSION } from "../core/version";
import { CalibrationMonitor, requiredFor, type CalibrationOptions, type CalibrationState } from "../camera/calibration";
import { bodyBox, normalizeLandmarks } from "../camera/normalize";
import { ContinuityMonitor } from "../camera/continuity";
import { ViewTracker } from "../camera/view";
import { evaluateRepetition, evaluateRule, severityFromBands, type RepContext, type RuleOutcome, type RuleOverrides } from "../evaluation/rules";
import { FeatureExtractor } from "../features/extractor";
import { FEATURES } from "../features/registry";
import { FeedbackEngine, type FeedbackItem, type FeedbackOptions } from "../feedback/engine";
import { LandmarkFilter, type LandmarkFilterOptions } from "../filtering/landmarkFilter";
import { coefficientOfVariation, mean, percentile, resample, std } from "../geometry/stats";
import { resolveOverrides, type PersonalProfile } from "../personalization/profile";
import { RuleBasedRecognizer } from "../recognition/recognizer";
import { compareToReference, SERIES_POINTS, type ReferenceModel } from "../reference/model";
import { RepetitionDetector, type RepCycle } from "../reps/detector";
import { scoreRepetition } from "../scoring/score";

export interface AnalyzerConfig {
  exercise: ExerciseDefinition;
  /** Candidate exercises for recognition / verification (defaults to [exercise]). */
  candidates?: ExerciseDefinition[];
  profile?: PersonalProfile | null;
  reference?: ReferenceModel | null;
  filter?: Partial<LandmarkFilterOptions>;
  calibration?: Partial<CalibrationOptions>;
  feedback?: Partial<FeedbackOptions>;
  /** History kept for evaluation (ms). */
  bufferMs?: number;
  /** Below this analysis confidence a repetition gets no score. */
  minScoreConfidence?: number;
}

export type AnalyzerStatus = "no-person" | "calibrating" | "analysing" | "paused";

export interface KeyMetric {
  name: string;
  label: string;
  value: number;
  unit: string;
  confidence: number;
}

export interface LiveState {
  timestamp: number;
  status: AnalyzerStatus;
  calibration: CalibrationState;
  view: CameraView;
  viewConfidence: number;
  nearSide: Side;
  /** Filtered, aspect-corrected landmarks for overlays (x in [0, aspect], y in [0, 1]). */
  pose: NormalizedPose;
  aspect: number;
  phase: string | null;
  phaseLabel: string | null;
  inRepetition: boolean;
  repCount: number;
  partialReps: number;
  /** Set on the frame a repetition is finalized. */
  newRepetition: ExerciseRepetition | null;
  lastRepetition: ExerciseRepetition | null;
  /** Mean score of scored repetitions so far. */
  setScore: number | null;
  setConfidence: number;
  keyMetrics: KeyMetric[];
  /** Cue to deliver now (text + optional voice). */
  feedback: FeedbackItem | null;
  /** Cues currently on screen. */
  visualCues: FeedbackItem[];
  /** Provisional errors of the repetition in progress. */
  currentErrors: TechniqueError[];
  stopSetRecommended: boolean;
  engineMs: number;
}

const now = () => (typeof performance !== "undefined" ? performance.now() : Date.now());
const SEVERITY_RANK: Record<Severity, number> = { LOW: 1, MODERATE: 2, HIGH: 3 };

/**
 * Orchestrates the full pipeline for one exercise set:
 * pose frame -> normalization -> filtering -> view/calibration -> features ->
 * repetition state machine -> rule evaluation -> scoring -> feedback.
 * Pure TypeScript, no DOM/React dependencies.
 */
export class ExerciseAnalyzer {
  readonly exercise: ExerciseDefinition;
  private readonly filter: LandmarkFilter;
  private readonly view = new ViewTracker();
  private readonly calibration: CalibrationMonitor;
  private readonly extractor: FeatureExtractor;
  private readonly detector: RepetitionDetector;
  private readonly continuity = new ContinuityMonitor();
  private readonly feedback: FeedbackEngine;
  private readonly recognizer: RuleBasedRecognizer;
  private readonly overrides: RuleOverrides;
  private readonly reference: ReferenceModel | null;
  private readonly bufferMs: number;
  private readonly minScoreConfidence: number;

  private frames: BiomechanicalFrame[] = [];
  private repFrames: BiomechanicalFrame[][] = [];
  private repetitions: ExerciseRepetition[] = [];
  private comparisons: ReferenceComparison[] = [];
  private provisional = new Map<string, TechniqueError>();
  private offered = new Set<string>();
  private liveSince = new Map<string, number>();
  private lastPhase: string | null = null;
  private lastStatus: AnalyzerStatus = "no-person";
  private lastGuidance: string | null = null;
  private wasReady = false;
  private history: Record<string, number[]> = {};
  private safetyHits = new Map<string, number>();
  private stopSet = false;

  private framesReceived = 0;
  private framesAnalysed = 0;
  private engineTimes: number[] = [];
  private inferenceTimes: number[] = [];
  private firstTs: number | null = null;
  private lastTs = 0;
  private visibilitySum = 0;
  private visibilityN = 0;
  private brightness: number[] = [];
  private viewVotes = new Map<CameraView, number>();
  private issues = new Map<string, number>();
  private lastState: LiveState | null = null;

  constructor(cfg: AnalyzerConfig) {
    this.exercise = cfg.exercise;
    const def = cfg.exercise;
    const candidates = cfg.candidates?.length ? cfg.candidates : [def];
    const perLandmark: Partial<Record<string, number>> = {};
    for (const n of def.occludableLandmarks ?? []) perLandmark[n] = cfg.calibration?.occludedMinVisibility ?? 0.2;
    this.filter = new LandmarkFilter({ perLandmarkMinVisibility: perLandmark, ...cfg.filter });
    this.calibration = new CalibrationMonitor(def, cfg.calibration);
    if (cfg.profile?.bodyBaseline) this.calibration.restore(cfg.profile.bodyBaseline);
    this.recognizer = new RuleBasedRecognizer(candidates);
    this.extractor = new FeatureExtractor({
      features: [...new Set([...featuresOf(def), ...this.recognizer.requiredFeatures])],
    });
    this.detector = new RepetitionDetector(def.repetition, def.movementPhases);
    this.feedback = new FeedbackEngine(cfg.feedback);
    this.overrides = resolveOverrides(def, cfg.profile).overrides;
    this.reference = cfg.reference && cfg.reference.exerciseId === def.id ? cfg.reference : null;
    this.bufferMs = cfg.bufferMs ?? 30000;
    this.minScoreConfidence = cfg.minScoreConfidence ?? 0.3;
  }

  /** Processes one pose-estimation result. Pass a frame with empty landmarks when no person was detected. */
  processFrame(frame: PoseFrame): LiveState {
    const t0 = now();
    const ts = frame.timestamp;
    this.framesReceived++;
    if (this.firstTs === null) this.firstTs = ts;
    this.lastTs = ts;
    if (frame.inferenceMs !== undefined) pushCapped(this.inferenceTimes, frame.inferenceMs);
    if (frame.cameraMetadata.brightness !== undefined) pushCapped(this.brightness, frame.cameraMetadata.brightness);

    const norm = normalizeLandmarks(frame);
    const moved = this.continuity.update(norm.points, ts);
    const cut = frame.cameraMetadata.sceneCut ? "jump" : moved;
    if (cut !== "none") this.handleDiscontinuity(cut, ts);
    const box = bodyBox(norm.points, 0.5);
    const filtered = this.filter.apply(norm.points, ts, box?.height ?? 0.6);
    const nframe: NormalizedFrame = {
      timestamp: ts,
      points: filtered,
      aspect: norm.aspect,
      modelConfidence: frame.modelConfidence,
      cameraMetadata: frame.cameraMetadata,
      inferenceMs: frame.inferenceMs,
    };
    const { view, nearSide } = this.view.update(filtered, ts);
    const cal = this.calibration.update(nframe, view, nearSide);

    const required = requiredFor(this.exercise, view.view, nearSide);
    const vis = required.map((n) => filtered[n]?.confidence ?? 0);
    this.visibilitySum += mean(vis);
    this.visibilityN++;

    let status: AnalyzerStatus;
    let newRep: ExerciseRepetition | null = null;
    let phase: string | null = this.lastPhase;
    let inRep = false;

    if (!cal.analysisAllowed) {
      status = Object.keys(filtered).length === 0 ? "no-person" : this.wasReady ? "paused" : "calibrating";
      const update = this.detector.update(ts, null);
      inRep = update.inRep;
      const top = cal.guidance[0];
      if (top && top !== this.lastGuidance) {
        this.feedback.offerSystem("setup", top, ts, { voice: top, key: `setup:${top}` });
        this.issues.set(top, (this.issues.get(top) ?? 0) + 1);
      }
      this.lastGuidance = top ?? null;
    } else {
      status = "analysing";
      this.framesAnalysed++;
      this.viewVotes.set(view.view, (this.viewVotes.get(view.view) ?? 0) + 1);
      if (!this.wasReady) {
        this.wasReady = true;
        this.feedback.offerSystem("info", MESSAGES.calibration.ready, ts, { voice: "Gotowe", priority: 5, key: "ready" });
      }
      this.lastGuidance = null;
      const bf = this.extractor.extract(nframe, view.view, nearSide, cal.baseline);
      this.frames.push(bf);
      const cutoff = ts - this.bufferMs;
      while (this.frames.length && this.frames[0]!.timestamp < cutoff) this.frames.shift();

      const update = this.detector.update(ts, bf.features[this.exercise.repetition.signal] ?? null);
      phase = update.phase;
      inRep = update.inRep;
      this.checkLive(bf, phase, ts, view.view, view.confidence);
      if (phase !== this.lastPhase && this.lastPhase !== null && update.inRep) {
        this.evaluateEndedPhase(this.lastPhase, ts, view.view, view.confidence);
      }
      if (update.countedNow) {
        this.feedback.offerSystem("rep", `${update.repCount}`, ts, { voice: `${update.repCount}`, key: `rep:${update.repCount}` });
      }
      if (update.finished) newRep = this.finishRepetition(update.finished, view.view, view.confidence);
    }
    this.lastPhase = phase;
    this.lastStatus = status;

    const fb = this.feedback.tick(ts);
    const engineMs = now() - t0;
    pushCapped(this.engineTimes, engineMs);
    const scored = this.repetitions.filter((r) => r.techniqueScore !== null);
    const state: LiveState = {
      timestamp: ts,
      status,
      calibration: cal,
      view: view.view,
      viewConfidence: view.confidence,
      nearSide,
      pose: filtered,
      aspect: norm.aspect,
      phase: status === "analysing" ? phase : null,
      phaseLabel: status === "analysing" && phase ? this.detector.phaseLabel(phase) : null,
      inRepetition: inRep,
      repCount: this.repetitions.filter((r) => !r.incomplete).length + (inRep && this.detector.repCount > this.completeCount() ? 1 : 0),
      partialReps: this.repetitions.filter((r) => r.incomplete).length,
      newRepetition: newRep,
      lastRepetition: this.repetitions[this.repetitions.length - 1] ?? null,
      setScore: scored.length ? Math.round(mean(scored.map((r) => r.techniqueScore!))) : null,
      setConfidence: scored.length ? round(mean(scored.map((r) => r.analysisConfidence)), 2) : 0,
      keyMetrics: this.keyMetrics(),
      feedback: fb.emit,
      visualCues: fb.visual,
      currentErrors: [...this.provisional.values()],
      stopSetRecommended: this.stopSet,
      engineMs,
    };
    this.lastState = state;
    return state;
  }

  get state(): LiveState | null {
    return this.lastState;
  }

  /** Ends the set and returns the post-set report. */
  endSet(): TechniqueAnalysis {
    const open = this.detector.flush(this.lastTs);
    if (open) this.finishRepetition(open, this.dominantView(), 0.8);
    return this.buildReport();
  }

  private handleDiscontinuity(kind: "gap" | "jump", ts: number): void {
    const hadCycle = this.detector.snapshot(ts) !== null;
    this.detector.abort();
    this.lastPhase = null;
    if (kind === "jump") {
      this.filter.reset();
      this.view.reset();
      this.calibration.start();
      this.wasReady = false;
    }
    const msg = kind === "jump" ? MESSAGES.calibration.sceneChange : hadCycle ? MESSAGES.calibration.repInterrupted : null;
    if (msg) {
      this.feedback.offerSystem("setup", msg, ts, { voice: msg, key: `cut:${kind}`, priority: 4 });
      this.issues.set(msg, (this.issues.get(msg) ?? 0) + 1);
    }
  }

  private completeCount(): number {
    return this.repetitions.filter((r) => !r.incomplete).length;
  }

  private ctxFor(start: number, end: number, phases: RepContext["phases"], view: CameraView, viewConfidence: number, coverage: number): RepContext {
    return {
      exercise: this.exercise,
      repIndex: this.repetitions.length + 1,
      startTimestamp: start,
      endTimestamp: end,
      phases,
      frames: this.frames.filter((f) => f.timestamp >= (phases[0]?.startTimestamp ?? start) - 1 && f.timestamp <= end + 1),
      view,
      viewConfidence,
      overrides: this.overrides,
      coverage,
      history: this.history,
    };
  }

  /** Incremental evaluation: rules bound to a phase are checked as soon as it ends. */
  private evaluateEndedPhase(phaseId: string, ts: number, view: CameraView, viewConfidence: number): void {
    const snap = this.detector.snapshot(ts);
    if (!snap) return;
    const rules = this.exercise.evaluationRules.filter(
      (r) => r.condition.kind !== "live" && (r.condition as RuleCondition).phase === phaseId && r.condition.kind !== "tempoConsistency",
    );
    if (!rules.length) return;
    const phases = refineOnset(this.exercise, snap.phases, this.frames);
    const ctx = this.ctxFor(phases[1]?.startTimestamp ?? snap.startTimestamp, ts, phases, view, viewConfidence, 1);
    for (const rule of rules) {
      const out = evaluateRule(rule, ctx);
      if (out.error) {
        this.provisional.set(out.error.type, out.error);
        this.offerError(out, ts);
      }
    }
  }

  private checkLive(bf: BiomechanicalFrame, phase: string | null, ts: number, view: CameraView, viewConfidence: number): void {
    const def = this.exercise;
    for (const chk of def.liveChecks ?? []) {
      const rule = def.evaluationRules.find((r) => r.type === chk.rule);
      const c = rule?.condition;
      if (!rule || !c || c.kind !== "stat" || !rule.views.includes(view)) continue;
      if (this.overrides.disabled.has(rule.type) && !rule.safetyCritical) continue;
      const f = bf.features[c.feature];
      const thr = this.overrides.thresholds[rule.type] ?? c.threshold;
      const confidence = f ? f.confidence * rule.reliability * (0.6 + 0.4 * viewConfidence) : 0;
      const deviation = f ? (c.compare === ">" ? f.value - thr : thr - f.value) : 0;
      const bad = !!f && phase !== null && chk.phases.includes(phase) && confidence >= rule.minConfidence && deviation > 0;
      if (!bad) {
        this.liveSince.delete(rule.type);
        continue;
      }
      const since = this.liveSince.get(rule.type) ?? ts;
      this.liveSince.set(rule.type, since);
      if (ts - since < chk.persistMs) continue;
      const repIndex = this.repetitions.length + 1;
      const id = `${def.id}-${repIndex}-${rule.type}`;
      if (this.offered.has(id)) continue;
      this.offered.add(id);
      const err: TechniqueError = {
        id,
        type: rule.type,
        exercise: def.id,
        phase: phase!,
        severity: severityFromBands(deviation, c.bands),
        confidence: round(confidence, 2),
        startTimestamp: Math.round(since),
        endTimestamp: Math.round(ts),
        description: rule.description,
        correctiveFeedback: rule.correction,
        voiceCue: rule.voice,
        recommendedAction: rule.recommendedAction,
        category: rule.category,
        measured: { value: round(f!.value, 3), threshold: thr, unit: FEATURES[c.feature]?.unit ?? "" },
        repIndex,
      };
      this.provisional.set(err.type, err);
      this.feedback.offerError(err, rule.importance, ts, true);
    }
  }

  private offerError(out: RuleOutcome, ts: number): void {
    const err = out.error;
    if (!err || this.offered.has(err.id)) return;
    this.offered.add(err.id);
    this.feedback.offerError(err, out.rule.importance, ts);
  }

  private finishRepetition(raw: RepCycle, view: CameraView, viewConfidence: number): ExerciseRepetition {
    const def = this.exercise;
    const refined = refineOnset(def, raw.phases, this.frames);
    const onset = refined[1]?.startTimestamp ?? raw.startTimestamp;
    const cycle: RepCycle = { ...raw, phases: refined, startTimestamp: onset, durationMs: raw.endTimestamp - onset };
    const index = this.repetitions.length + 1;
    const setupStart = cycle.phases[0]?.startTimestamp ?? cycle.startTimestamp;
    const frames = this.frames.filter((f) => f.timestamp >= setupStart - 1 && f.timestamp <= cycle.endTimestamp + 1);
    const moving = frames.filter((f) => f.timestamp >= cycle.startTimestamp);
    const signalCoverage = moving.length ? moving.filter((f) => f.features[def.repetition.signal]).length / moving.length : 0;
    const coverage = Math.max(0, Math.min(signalCoverage, 1 - cycle.gapMs / Math.max(1, cycle.durationMs)));
    const ctx = this.ctxFor(cycle.startTimestamp, cycle.endTimestamp, cycle.phases, view, viewConfidence, coverage);
    ctx.repIndex = index;
    const outcomes = evaluateRepetition(ctx);
    const errors = outcomes.map((o) => o.error).filter((e): e is TechniqueError => !!e);

    if (!cycle.complete) {
      errors.push({
        id: `${def.id}-${index}-INCOMPLETE_RANGE_OF_MOTION`,
        type: "INCOMPLETE_RANGE_OF_MOTION",
        exercise: def.id,
        phase: "rep",
        severity: "MODERATE",
        confidence: round(Math.min(1, coverage), 2),
        startTimestamp: Math.round(cycle.startTimestamp),
        endTimestamp: Math.round(cycle.endTimestamp),
        description: "Ruch nie osiągnął pełnego zakresu wymaganego do zaliczenia powtórzenia.",
        correctiveFeedback: MESSAGES.feedback.incompleteRep,
        voiceCue: "Pełny zakres",
        category: "rangeOfMotion",
        repIndex: index,
      });
    }
    if (cycle.gapMs > 300) {
      // Analysis incomplete: critical landmarks were lost inside the repetition.
      errors.forEach((e) => (e.confidence = round(e.confidence * coverage, 2)));
    }

    let breakdown = scoreRepetition(def, outcomes, undefined, coverage);
    if (!cycle.complete || breakdown.analysisConfidence < this.minScoreConfidence) {
      breakdown = { ...breakdown, score: null, scoreUncertainty: null };
    }

    const metrics: ExerciseRepetition["biomechanicalMetrics"] = {};
    const names = new Set<string>();
    for (const f of moving) for (const k of Object.keys(f.features)) names.add(k);
    for (const name of names) {
      const vals = moving.map((f) => f.features[name]?.value).filter((v): v is number => v !== undefined);
      if (vals.length) metrics[name] = { min: round(Math.min(...vals), 3), max: round(Math.max(...vals), 3), mean: round(mean(vals), 3) };
    }
    const seriesFeatures: Record<string, (number | null)[]> = {};
    for (const f of new Set([def.repetition.signal, ...def.comparisonFeatures])) {
      const r = resample(moving.map((fr) => fr.features[f]?.value ?? null), SERIES_POINTS);
      seriesFeatures[f] = r ? r.map((v) => round(v, 4)) : new Array(SERIES_POINTS).fill(null);
    }
    const rep: ExerciseRepetition = {
      id: `${def.id}-rep-${index}`,
      index,
      startTimestamp: Math.round(cycle.startTimestamp),
      endTimestamp: Math.round(cycle.endTimestamp),
      durationMs: Math.round(cycle.durationMs),
      phases: cycle.phases.map((p) => ({ ...p, startTimestamp: Math.round(p.startTimestamp), endTimestamp: Math.round(p.endTimestamp) })),
      biomechanicalMetrics: metrics,
      detectedErrors: errors,
      techniqueScore: breakdown.score,
      analysisConfidence: breakdown.analysisConfidence,
      breakdown,
      incomplete: !cycle.complete,
      series: {
        t: Array.from({ length: SERIES_POINTS }, (_, i) => Math.round(cycle.startTimestamp + (cycle.durationMs * i) / (SERIES_POINTS - 1))),
        features: seriesFeatures,
      },
    };
    this.repetitions.push(rep);
    this.repFrames.push(frames);

    if (cycle.complete) {
      for (const p of rep.phases) {
        if (p.kind === "start") continue;
        (this.history[p.id] ??= []).push(p.endTimestamp - p.startTimestamp);
      }
    }
    if (this.reference && cycle.complete) {
      this.comparisons.push(compareToReference(rep, this.reference, featureLabels()));
    }

    const ts = this.lastTs;
    for (const o of outcomes) this.offerError(o, ts);
    // The main issue of this rep is always said right away, so the athlete knows what to fix in the next one.
    const ranked = errors
      .filter((e) => e.type !== "INCOMPLETE_RANGE_OF_MOTION")
      .sort((a, b) => SEVERITY_RANK[b.severity] * b.confidence - SEVERITY_RANK[a.severity] * a.confidence);
    for (const e of ranked) {
      const rule = def.evaluationRules.find((r) => r.type === e.type);
      if (this.feedback.offerError(e, rule?.importance ?? 0.5, ts, true)) break;
    }
    if (!cycle.complete) {
      const e = errors[errors.length - 1]!;
      this.feedback.offerError(e, 0.7, ts);
    }
    for (const e of errors) {
      const rule = def.evaluationRules.find((r) => r.type === e.type);
      if (rule?.safetyCritical && e.severity === "HIGH" && e.confidence >= 0.6) {
        const n = (this.safetyHits.get(e.type) ?? 0) + 1;
        this.safetyHits.set(e.type, n);
        if (n >= 2 && !this.stopSet) {
          this.stopSet = true;
          this.feedback.offerSystem("safety", MESSAGES.safety.stopSet, ts, { voice: "Zatrzymaj serię", key: "stop-set" });
        }
      }
    }
    this.provisional.clear();
    return rep;
  }

  private keyMetrics(): KeyMetric[] {
    const last = this.frames[this.frames.length - 1];
    if (!last) return [];
    const names = [...new Set([this.exercise.repetition.signal, ...this.exercise.comparisonFeatures])];
    const out: KeyMetric[] = [];
    for (const n of names) {
      const m = last.features[n];
      if (!m) continue;
      out.push({ name: n, label: featureLabels()[n] ?? n, value: round(m.value, 2), unit: FEATURES[n]?.unit ?? "", confidence: round(m.confidence, 2) });
    }
    return out;
  }

  private dominantView(): CameraView {
    let best: CameraView = "unknown";
    let n = -1;
    for (const [v, c] of this.viewVotes) if (c > n) [best, n] = [v, c];
    return best;
  }

  private buildReport(): TechniqueAnalysis {
    const def = this.exercise;
    const reps = this.repetitions;
    const complete = reps.filter((r) => !r.incomplete);
    const scored = complete.filter((r) => r.techniqueScore !== null);
    const scores = scored.map((r) => r.techniqueScore!);

    const agg = new Map<string, AggregatedError>();
    for (const r of reps) {
      for (const e of r.detectedErrors) {
        const rule = def.evaluationRules.find((x) => x.type === e.type);
        const a = agg.get(e.type) ?? {
          type: e.type,
          label: rule?.label ?? "Niepełny zakres ruchu",
          category: e.category,
          count: 0,
          repIndices: [],
          maxSeverity: e.severity,
          meanConfidence: 0,
          correction: e.correctiveFeedback,
          description: e.description,
        };
        a.meanConfidence = (a.meanConfidence * a.count + e.confidence) / (a.count + 1);
        a.count++;
        a.repIndices.push(r.index);
        if (SEVERITY_RANK[e.severity] > SEVERITY_RANK[a.maxSeverity]) a.maxSeverity = e.severity;
        agg.set(e.type, a);
      }
    }
    const detectedErrors = [...agg.values()]
      .map((a) => ({ ...a, meanConfidence: round(a.meanConfidence, 2) }))
      .sort((a, b) => SEVERITY_RANK[b.maxSeverity] * b.count * b.meanConfidence - SEVERITY_RANK[a.maxSeverity] * a.count * a.meanConfidence);

    const best = scored.length ? scored.reduce((a, b) => (b.techniqueScore! > a.techniqueScore! ? b : a)).index : null;
    const worst = scored.length ? scored.reduce((a, b) => (b.techniqueScore! < a.techniqueScore! ? b : a)).index : null;

    const phaseMeans = (kind: "concentric" | "eccentric") => {
      const d = complete.flatMap((r) => r.phases.filter((p) => p.kind === kind).map((p) => p.endTimestamp - p.startTimestamp));
      return d.length ? Math.round(mean(d)) : null;
    };
    let consistency: number | null = null;
    if (complete.length >= 2) {
      const durCv = coefficientOfVariation(complete.map((r) => r.durationMs));
      const sig = def.repetition.signal;
      const roms = complete.map((r) => (r.biomechanicalMetrics[sig] ? r.biomechanicalMetrics[sig]!.max - r.biomechanicalMetrics[sig]!.min : 0));
      const romCv = coefficientOfVariation(roms);
      const scoreStd = scores.length >= 2 ? std(scores) : 0;
      consistency = Math.round(Math.max(0, Math.min(100, 100 - durCv * 60 - romCv * 120 - scoreStd * 0.8)));
    }

    const recommendations: string[] = [];
    for (const e of detectedErrors.slice(0, 3)) {
      const rule = def.evaluationRules.find((r) => r.type === e.type);
      recommendations.push(e.correction + (rule?.recommendedAction ? ` ${rule.recommendedAction}` : ""));
    }
    const unmeasured = new Map<string, string>();
    for (const r of complete) for (const u of r.breakdown.unmeasured) unmeasured.set(u.rule, u.reason);
    if (unmeasured.size) {
      recommendations.push(MESSAGES.feedback.unmeasurable([...unmeasured.keys()].slice(0, 4).join(", ").toLowerCase()));
    }
    if (reps.length === 0) recommendations.push("Nie wykryto żadnego powtórzenia. Sprawdź ustawienie kamery i wykonaj pełny ruch.");

    const viewTotal = [...this.viewVotes.values()].reduce((a, b) => a + b, 0);
    const dominant = this.dominantView();
    const cameraQuality: CameraQuality = {
      view: dominant,
      viewConfidence: viewTotal ? round((this.viewVotes.get(dominant) ?? 0) / viewTotal, 2) : 0,
      meanVisibility: this.visibilityN ? round(this.visibilitySum / this.visibilityN, 2) : 0,
      usableFrameRatio: this.framesReceived ? round(this.framesAnalysed / this.framesReceived, 2) : 0,
      brightness: this.brightness.length ? round(mean(this.brightness), 2) : undefined,
      issues: [...this.issues.entries()].sort((a, b) => b[1] - a[1]).slice(0, 5).map(([k]) => k),
    };
    const elapsed = this.firstTs !== null ? (this.lastTs - this.firstTs) / 1000 : 0;
    const processingMetrics: ProcessingMetrics = {
      framesReceived: this.framesReceived,
      framesAnalysed: this.framesAnalysed,
      meanEngineMs: round(mean(this.engineTimes), 2),
      p95EngineMs: round(this.engineTimes.length ? percentile(this.engineTimes, 95) : 0, 2),
      meanInferenceMs: this.inferenceTimes.length ? round(mean(this.inferenceTimes), 1) : undefined,
      effectiveFps: elapsed > 0 ? round(this.framesReceived / elapsed, 1) : 0,
    };

    const recFrames = this.repFrames.filter((_, i) => !reps[i]!.incomplete).flat();
    const recognition = this.recognizer.classify(recFrames, def.id);

    const safetyNotes: string[] = [MESSAGES.safety.disclaimer];
    if (this.stopSet) safetyNotes.unshift(MESSAGES.safety.stopSet);
    if (def.evaluationRules.some((r) => r.reliability < 0.7)) {
      safetyNotes.push("Część ocen (np. pozycja pleców, tor sztangi) opiera się na pośrednich wskaźnikach z obrazu 2D i ma ograniczoną dokładność.");
    }

    const confs = complete.map((r) => r.analysisConfidence);
    return {
      exerciseId: def.id,
      repetitionCount: complete.length,
      partialRepetitions: reps.length - complete.length,
      repetitions: reps,
      averageTechniqueScore: scores.length ? Math.round(mean(scores)) : null,
      analysisConfidence: confs.length ? round(mean(confs) * Math.min(1, 0.5 + cameraQuality.usableFrameRatio), 2) : 0,
      detectedErrors,
      bestRepetition: best,
      worstRepetition: worst,
      consistency,
      tempo: { meanConcentricMs: phaseMeans("concentric"), meanEccentricMs: phaseMeans("eccentric"), meanRepMs: complete.length ? Math.round(mean(complete.map((r) => r.durationMs))) : null },
      recommendations,
      cameraQuality,
      processingMetrics,
      recognition,
      referenceComparison: this.reference ? this.comparisons : null,
      safetyNotes,
      engineVersion: ENGINE_VERSION,
    };
  }
}

/**
 * Moves the start-phase / first-movement boundary back to where the onset
 * feature first rose from its setup minimum (searching only inside the setup span).
 */
export function refineOnset(def: ExerciseDefinition, phases: RepContext["phases"], frames: BiomechanicalFrame[]): RepContext["phases"] {
  const f = def.repetition.onsetFeature;
  const setup = phases[0];
  const first = phases[1];
  if (!f || !setup || !first) return phases;
  const eps = def.repetition.onsetEpsilon ?? 0.01;
  const win = frames.filter((fr) => fr.timestamp >= setup.startTimestamp && fr.timestamp <= first.startTimestamp && fr.features[f]);
  if (win.length < 3) return phases;
  let minV = Infinity;
  for (const fr of win) minV = Math.min(minV, fr.features[f]!.value);
  let onset = first.startTimestamp;
  for (let i = win.length - 1; i >= 0; i--) {
    if (win[i]!.features[f]!.value <= minV + eps) {
      onset = win[i]!.timestamp;
      break;
    }
  }
  if (onset >= first.startTimestamp) return phases;
  return [{ ...setup, endTimestamp: onset }, { ...first, startTimestamp: onset }, ...phases.slice(2)];
}

/** All features an exercise definition needs. */
export function featuresOf(def: ExerciseDefinition): string[] {
  const out = new Set<string>([def.repetition.signal, ...def.comparisonFeatures]);
  if (def.repetition.onsetFeature) out.add(def.repetition.onsetFeature);
  for (const r of def.evaluationRules) {
    const c = r.condition as RuleCondition | { kind: "live"; feature: string };
    if ("feature" in c) out.add(c.feature);
    if (c.kind === "deltaRatio") {
      out.add(c.numerator);
      out.add(c.denominator);
    }
    if (c.kind === "asymmetry") {
      out.add(c.left);
      out.add(c.right);
    }
  }
  return [...out];
}

let labelsCache: Record<string, string> | null = null;
function featureLabels(): Record<string, string> {
  if (labelsCache) return labelsCache;
  labelsCache = {
    hipAngle: "Kąt biodra",
    kneeAngle: "Kąt kolana",
    elbowAngle: "Kąt łokcia",
    shoulderAngle: "Kąt barku",
    trunkInclination: "Pochylenie tułowia",
    trunkLeanSigned: "Pochylenie tułowia",
    hipHeight: "Wysokość bioder",
    shoulderHeight: "Wysokość barków",
    shoulderHeightRel: "Wysokość barków",
    wristHeight: "Wysokość dłoni",
    minElbowAngle: "Kąt łokcia",
    minKneeAngle: "Kąt kolana",
    hipBelowKnee: "Głębokość",
    wristAboveShoulder: "Dłonie nad barkami",
    bodyLineAngle: "Linia ciała",
    chinAboveHands: "Broda nad drążkiem",
  };
  return labelsCache;
}

function pushCapped(arr: number[], v: number, cap = 3000): void {
  arr.push(v);
  if (arr.length > cap) arr.shift();
}

function round(x: number, d: number): number {
  const k = 10 ** d;
  return Math.round(x * k) / k;
}
