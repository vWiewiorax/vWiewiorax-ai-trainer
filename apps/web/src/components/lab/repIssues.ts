import { EXERCISES, type ExerciseRepetition, type Severity } from "@trainer/engine";

export interface RepIssue {
  type: string;
  label: string;
  correction: string;
  severity: Severity;
}

const RANK: Record<Severity, number> = { LOW: 1, MODERATE: 2, HIGH: 3 };

/** Errors of one repetition, most important first, with labels from the exercise rules. */
export function repIssues(exerciseId: string, rep: ExerciseRepetition): RepIssue[] {
  const rules = EXERCISES[exerciseId]?.evaluationRules ?? [];
  return [...rep.detectedErrors]
    .sort((a, b) => RANK[b.severity] * b.confidence - RANK[a.severity] * a.confidence)
    .map((e) => ({
      type: e.type,
      label: rules.find((r) => r.type === e.type)?.label ?? (e.type === "INCOMPLETE_RANGE_OF_MOTION" ? "Niepełny zakres ruchu" : e.type),
      correction: e.correctiveFeedback,
      severity: e.severity,
    }));
}

export function scoreColor(score: number | null, incomplete = false): string {
  if (incomplete || score === null) return "bg-slate-600 text-slate-100";
  if (score >= 80) return "bg-emerald-500 text-slate-950";
  if (score >= 60) return "bg-orange-500 text-slate-950";
  return "bg-red-600 text-white";
}
