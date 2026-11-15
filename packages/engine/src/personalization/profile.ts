import type { ErrorDefinition, ExerciseDefinition, ExerciseRepetition, RuleCondition, TechniqueAnalysis } from "../core/types";
import type { BodyBaseline } from "../features/body";
import type { RuleOverrides } from "../evaluation/rules";

/**
 * Explicit, trainer-controlled personalization for one athlete and exercise.
 * Nothing here is changed automatically: the engine only *suggests* adjustments.
 */
export interface PersonalProfile {
  exerciseId: string;
  /** Calibrated segment lengths from a previous session (optional). */
  bodyBaseline?: BodyBaseline;
  /** Stance / variation notes, e.g. "sumo", "trap bar". Informational. */
  variation?: string;
  /** Threshold overrides per rule type, set by a trainer. Clamped to the rule's adjustable range. */
  thresholdOverrides: Record<string, number>;
  /** Rule types the trainer disabled. Safety-critical rules cannot be disabled. */
  disabledRules: string[];
  /** Approved individual values for "baseline" rules, keyed by rule type. */
  approvedBaselines: Record<string, number>;
  /** Running averages of key movement statistics (EWMA), used for suggestions and trends. */
  movementStats: Record<string, { mean: number; n: number }>;
  /** Historical per-set results. */
  history: { date: string; averageScore: number | null; analysisConfidence: number; repetitions: number }[];
  updatedBy?: string;
}

export function emptyProfile(exerciseId: string): PersonalProfile {
  return { exerciseId, thresholdOverrides: {}, disabledRules: [], approvedBaselines: {}, movementStats: {}, history: [] };
}

export interface OverrideIssue {
  rule: string;
  issue: string;
}

/** Converts a profile into rule overrides, enforcing adjustable ranges and safety constraints. */
export function resolveOverrides(def: ExerciseDefinition, profile?: PersonalProfile | null): { overrides: RuleOverrides; issues: OverrideIssue[] } {
  const issues: OverrideIssue[] = [];
  const thresholds: Record<string, number> = {};
  const disabled = new Set<string>();
  if (!profile) return { overrides: { thresholds, disabled, baselines: {} }, issues };
  for (const [type, value] of Object.entries(profile.thresholdOverrides)) {
    const rule = def.evaluationRules.find((r) => r.type === type);
    if (!rule) {
      issues.push({ rule: type, issue: "nieznana reguła" });
      continue;
    }
    if (!rule.adjustable) {
      issues.push({ rule: type, issue: "reguła nie pozwala na zmianę progu" });
      continue;
    }
    const clamped = Math.max(rule.adjustable.min, Math.min(rule.adjustable.max, value));
    if (clamped !== value) issues.push({ rule: type, issue: `próg ograniczony do zakresu ${rule.adjustable.min}..${rule.adjustable.max}` });
    thresholds[type] = clamped;
  }
  for (const type of profile.disabledRules) {
    const rule = def.evaluationRules.find((r) => r.type === type);
    if (rule?.safetyCritical) {
      issues.push({ rule: type, issue: "reguła bezpieczeństwa nie może być wyłączona" });
      continue;
    }
    disabled.add(type);
  }
  return { overrides: { thresholds, disabled, baselines: { ...profile.approvedBaselines } }, issues };
}

/** Updates running movement statistics after a set. Returns a new profile object. */
export function recordSet(profile: PersonalProfile, analysis: TechniqueAnalysis, alpha = 0.3): PersonalProfile {
  const stats = { ...profile.movementStats };
  for (const rep of analysis.repetitions.filter((r) => !r.incomplete)) {
    for (const [f, m] of Object.entries(rep.biomechanicalMetrics)) {
      for (const k of ["min", "max", "mean"] as const) {
        const key = `${f}.${k}`;
        const prev = stats[key];
        stats[key] = prev ? { mean: prev.mean * (1 - alpha) + m[k] * alpha, n: prev.n + 1 } : { mean: m[k], n: 1 };
      }
    }
  }
  return {
    ...profile,
    movementStats: stats,
    history: [
      ...profile.history,
      {
        date: new Date().toISOString(),
        averageScore: analysis.averageTechniqueScore,
        analysisConfidence: analysis.analysisConfidence,
        repetitions: analysis.repetitionCount,
      },
    ].slice(-200),
  };
}

export interface AdjustmentSuggestion {
  rule: string;
  label: string;
  currentThreshold: number;
  suggestedThreshold: number;
  flaggedRatio: number;
  note: string;
}

/**
 * Suggests threshold adjustments for rules that flag most repetitions with
 * LOW/MODERATE severity (likely an individual pattern). Requires explicit
 * trainer approval; safety-critical rules and HIGH severity findings are never suggested.
 */
export function suggestAdjustments(def: ExerciseDefinition, reps: ExerciseRepetition[], minReps = 5): AdjustmentSuggestion[] {
  const complete = reps.filter((r) => !r.incomplete);
  if (complete.length < minReps) return [];
  const out: AdjustmentSuggestion[] = [];
  for (const rule of def.evaluationRules) {
    if (rule.safetyCritical || !rule.adjustable) continue;
    const flagged = complete.flatMap((r) => r.detectedErrors.filter((e) => e.type === rule.type));
    if (flagged.length / complete.length < 0.7 || flagged.some((e) => e.severity === "HIGH")) continue;
    const values = flagged.map((e) => e.measured?.value).filter((v): v is number => typeof v === "number");
    const current = thresholdOf(rule);
    if (current === null || values.length === 0) continue;
    const cmp = compareOf(rule.condition as RuleCondition);
    const observed = cmp === ">" ? Math.max(...values) : Math.min(...values);
    const margin = Math.abs(observed - current) * 0.1;
    const suggested = Math.max(rule.adjustable.min, Math.min(rule.adjustable.max, cmp === ">" ? observed + margin : observed - margin));
    if (suggested === current) continue;
    out.push({
      rule: rule.type,
      label: rule.label,
      currentThreshold: current,
      suggestedThreshold: Math.round(suggested * 1000) / 1000,
      flaggedRatio: Math.round((flagged.length / complete.length) * 100) / 100,
      note: "Wzorzec powtarza się w większości powtórzeń. Zmień próg tylko, jeśli trener zaakceptował ten styl ruchu.",
    });
  }
  return out;
}

function thresholdOf(rule: ErrorDefinition): number | null {
  const c = rule.condition;
  if ("threshold" in c) return c.threshold;
  if (c.kind === "duration") return c.thresholdMs;
  return null;
}

function compareOf(c: RuleCondition): ">" | "<" {
  return "compare" in c ? c.compare : ">";
}
