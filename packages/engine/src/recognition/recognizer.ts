import type { BiomechanicalFrame, ExerciseDefinition, RecognitionResult } from "../core/types";
import { computeStat, samplesFor } from "../evaluation/series";

export interface RecognitionOptions {
  /** Minimum score for a positive classification. */
  minConfidence: number;
  /** Required margin between the best and second-best candidate. */
  minMargin: number;
}

export const DEFAULT_RECOGNITION: RecognitionOptions = { minConfidence: 0.6, minMargin: 0.1 };

/** Pluggable classifier interface; a trained model can implement the same contract. */
export interface ExerciseClassifier {
  classify(frames: BiomechanicalFrame[], expected?: string): RecognitionResult;
}

/**
 * Deterministic recognizer: each exercise defines feature predicates over a
 * movement window (one repetition). Soft scoring: a predicate that misses its
 * range by a small margin still earns partial credit.
 */
export class RuleBasedRecognizer implements ExerciseClassifier {
  private readonly opts: RecognitionOptions;

  constructor(private readonly candidates: ExerciseDefinition[], opts: Partial<RecognitionOptions> = {}) {
    this.opts = { ...DEFAULT_RECOGNITION, ...opts };
  }

  get requiredFeatures(): string[] {
    return [...new Set(this.candidates.flatMap((c) => c.recognition.map((p) => p.feature)))];
  }

  classify(frames: BiomechanicalFrame[], expected?: string): RecognitionResult {
    if (frames.length < 5) return { detectedExercise: null, confidence: 0, alternatives: [], matchesExpected: null };
    const span = { start: frames[0]!.timestamp, end: frames[frames.length - 1]!.timestamp };
    const scored = this.candidates.map((def) => ({ exercise: def.id, confidence: scoreDefinition(def, frames, span) }));
    scored.sort((a, b) => b.confidence - a.confidence);
    const best = scored[0];
    const second = scored[1];
    const decisive =
      !!best && best.confidence >= this.opts.minConfidence && (!second || best.confidence - second.confidence >= this.opts.minMargin);
    const expectedScore = expected ? scored.find((s) => s.exercise === expected)?.confidence ?? 0 : null;
    return {
      detectedExercise: decisive ? best!.exercise : null,
      confidence: round(best?.confidence ?? 0),
      alternatives: scored.slice(decisive ? 1 : 0, 4).map((s) => ({ exercise: s.exercise, confidence: round(s.confidence) })),
      matchesExpected: expected ? expectedScore !== null && expectedScore >= this.opts.minConfidence : null,
    };
  }
}

function scoreDefinition(def: ExerciseDefinition, frames: BiomechanicalFrame[], span: { start: number; end: number }): number {
  let total = 0;
  let got = 0;
  for (const p of def.recognition) {
    total += p.weight;
    const { samples } = samplesFor(frames, p.feature, span);
    const good = samples.filter((s) => s.c >= 0.4);
    if (good.length < 3) continue;
    const st = computeStat(good, p.stat);
    if (!st) continue;
    const width = Math.max(Math.abs(p.max ?? 0), Math.abs(p.min ?? 0), 1e-3) * 0.15;
    let miss = 0;
    if (p.min !== undefined && st.value < p.min) miss = p.min - st.value;
    if (p.max !== undefined && st.value > p.max) miss = Math.max(miss, st.value - p.max);
    const credit = miss === 0 ? 1 : Math.max(0, 1 - miss / width);
    got += credit * p.weight;
  }
  return total > 0 ? got / total : 0;
}

function round(x: number): number {
  return Math.round(x * 100) / 100;
}
