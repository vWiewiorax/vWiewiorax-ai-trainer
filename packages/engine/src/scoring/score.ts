import type { CategoryScore, ExerciseDefinition, ScoreBreakdown, ScoreCategory, Severity } from "../core/types";
import type { RuleOutcome } from "../evaluation/rules";

export interface ScoringOptions {
  penalties: Record<Severity, number>;
}

export const DEFAULT_SCORING: ScoringOptions = { penalties: { LOW: 12, MODERATE: 30, HIGH: 55 } };

/**
 * Confidence-aware technique score. Categories without any measurable rule are
 * excluded and their weight redistributed; the missing weight lowers analysis
 * confidence instead of the score. Penalties scale with rule importance and
 * detection confidence.
 */
export function scoreRepetition(
  def: ExerciseDefinition,
  outcomes: RuleOutcome[],
  opts: ScoringOptions = DEFAULT_SCORING,
  extraConfidence = 1,
): ScoreBreakdown {
  const weights = def.scoringConfiguration;
  const totalWeight = Object.values(weights).reduce((a, b) => a + (b ?? 0), 0);
  const categories: CategoryScore[] = [];
  let weighted = 0;
  let measuredWeight = 0;
  let confWeighted = 0;

  for (const [cat, w] of Object.entries(weights) as [ScoreCategory, number][]) {
    if (!w) continue;
    const rules = outcomes.filter((o) => o.rule.category === cat && !o.skipped);
    const measured = rules.filter((o) => o.measured);
    if (measured.length === 0) {
      categories.push({
        category: cat,
        weight: 0,
        score: 0,
        measured: false,
        reason: rules.length ? rules.map((r) => r.reason).filter(Boolean).join("; ") : "brak reguł dla tej kategorii",
      });
      continue;
    }
    let penalty = 0;
    for (const o of measured) {
      if (!o.error) continue;
      const p = opts.penalties[o.error.severity] * (0.5 + 0.5 * o.rule.importance);
      penalty += p * Math.max(0.5, Math.min(1, o.confidence / 0.75));
    }
    const score = Math.max(0, 100 - penalty);
    const coverage = measured.length / rules.length;
    const conf = (measured.reduce((a, b) => a + b.confidence, 0) / measured.length) * (0.5 + 0.5 * coverage);
    categories.push({ category: cat, weight: w, score: Math.round(score), measured: true });
    weighted += score * w;
    measuredWeight += w;
    confWeighted += conf * w;
  }

  for (const c of categories) if (c.measured && measuredWeight > 0) c.weight = round(c.weight / measuredWeight, 3);

  const unmeasured = outcomes
    .filter((o) => !o.measured && !o.skipped)
    .map((o) => ({ rule: o.rule.label, reason: o.reason ?? "niemierzalne" }));

  if (measuredWeight === 0 || totalWeight === 0) {
    return { score: null, scoreUncertainty: null, analysisConfidence: 0, categories, unmeasured };
  }
  const analysisConfidence = round(Math.max(0, Math.min(1, (confWeighted / totalWeight) * extraConfidence)), 2);
  return {
    score: Math.round(weighted / measuredWeight),
    scoreUncertainty: Math.round(4 + (1 - analysisConfidence) * 26),
    analysisConfidence,
    categories,
    unmeasured,
  };
}

function round(x: number, d: number): number {
  const k = 10 ** d;
  return Math.round(x * k) / k;
}
