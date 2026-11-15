import type { ExerciseDefinition, ExerciseRepetition, ReferenceComparison } from "../core/types";
import { mean } from "../geometry/stats";
import { dtw } from "./dtw";

export const SERIES_POINTS = 60;

/** Pose-pattern reference built from a trainer's demonstration video. */
export interface ReferenceModel {
  exerciseId: string;
  createdAt: string;
  source: string;
  repetitions: number;
  /** Mean time-normalized curve per feature (SERIES_POINTS samples). */
  template: Record<string, number[]>;
  rom: Record<string, number>;
  tempo: { meanRepMs: number; phaseMs: Record<string, number> };
  /** Per-feature tolerance for "similar" (trainer adjustable). */
  tolerances: Record<string, number>;
  notes?: string;
}

const DEFAULT_TOLERANCE = { deg: 12, body: 0.06 };

export function defaultTolerance(feature: string): number {
  return /Angle|Inclination|Lean|Tilt/i.test(feature) ? DEFAULT_TOLERANCE.deg : DEFAULT_TOLERANCE.body;
}

/** Builds a reference model from repetitions extracted with the same pipeline. */
export function buildReferenceModel(def: ExerciseDefinition, reps: ExerciseRepetition[], source: string): ReferenceModel | null {
  const good = reps.filter((r) => !r.incomplete && r.analysisConfidence >= 0.4);
  if (good.length === 0) return null;
  const template: Record<string, number[]> = {};
  const rom: Record<string, number> = {};
  const tolerances: Record<string, number> = {};
  for (const f of def.comparisonFeatures) {
    const curves = good.map((r) => r.series.features[f]).filter((c): c is (number | null)[] => !!c && c.every((v) => v !== null)) as number[][];
    if (curves.length === 0) continue;
    template[f] = Array.from({ length: SERIES_POINTS }, (_, i) => mean(curves.map((c) => c[i] ?? c[c.length - 1]!)));
    rom[f] = mean(curves.map((c) => Math.max(...c) - Math.min(...c)));
    tolerances[f] = defaultTolerance(f);
  }
  const phaseMs: Record<string, number> = {};
  for (const p of def.movementPhases) {
    const d = good.flatMap((r) => r.phases.filter((ph) => ph.id === p.id && ph.kind !== "start").map((ph) => ph.endTimestamp - ph.startTimestamp));
    if (d.length) phaseMs[p.id] = mean(d);
  }
  return {
    exerciseId: def.id,
    createdAt: new Date().toISOString(),
    source,
    repetitions: good.length,
    template,
    rom,
    tempo: { meanRepMs: mean(good.map((r) => r.durationMs)), phaseMs },
    tolerances,
  };
}

/**
 * Compares a repetition with the reference at movement-pattern level. Differences
 * are observations for the trainer, not technique errors.
 */
export function compareToReference(rep: ExerciseRepetition, model: ReferenceModel, labels: Record<string, string> = {}): ReferenceComparison {
  const perFeature: ReferenceComparison["perFeature"] = [];
  const observations: string[] = [];
  for (const [f, tpl] of Object.entries(model.template)) {
    const raw = rep.series.features[f];
    if (!raw || raw.some((v) => v === null)) continue;
    const curve = raw as number[];
    const { distance } = dtw(curve, tpl, 0.2);
    const tol = model.tolerances[f] ?? defaultTolerance(f);
    const romClient = Math.max(...curve) - Math.min(...curve);
    const romDifference = romClient - (model.rom[f] ?? romClient);
    const similarity = Math.exp(-distance / tol);
    perFeature.push({ feature: f, dtwDistance: round(distance, 3), romDifference: round(romDifference, 3), similarity: round(similarity, 2) });
    const name = labels[f] ?? f;
    if (Math.abs(romDifference) > tol) {
      observations.push(`${name}: zakres ruchu ${romDifference < 0 ? "mniejszy" : "większy"} niż we wzorcu trenera.`);
    } else if (similarity < 0.5) {
      observations.push(`${name}: przebieg ruchu różni się od wzorca trenera.`);
    }
  }
  const tempoRatio = model.tempo.meanRepMs > 0 ? round(rep.durationMs / model.tempo.meanRepMs, 2) : null;
  if (tempoRatio !== null && (tempoRatio > 1.5 || tempoRatio < 0.67)) {
    observations.push(tempoRatio > 1 ? "Powtórzenie wolniejsze niż we wzorcu." : "Powtórzenie szybsze niż we wzorcu.");
  }
  return {
    similarity: perFeature.length ? round(mean(perFeature.map((p) => p.similarity)), 2) : 0,
    perFeature,
    tempoRatio,
    observations,
  };
}

function round(x: number, d: number): number {
  const k = 10 ** d;
  return Math.round(x * k) / k;
}
