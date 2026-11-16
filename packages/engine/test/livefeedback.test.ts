import { describe, expect, it } from "vitest";
import { EXERCISES, ExerciseAnalyzer, deadlift, generateSyntheticDeadlift, type DeadliftFault, type FeedbackItem } from "../src";

function run(fault: DeadliftFault) {
  const { frames } = generateSyntheticDeadlift({ reps: 3, fault });
  const a = new ExerciseAnalyzer({ exercise: deadlift });
  const cues: FeedbackItem[] = [];
  const repEnds: number[] = [];
  for (const f of frames) {
    const s = a.processFrame(f);
    if (s.feedback) cues.push(s.feedback);
    if (s.newRepetition) repEnds.push(s.timestamp);
  }
  return { cues, repEnds, report: a.endSet() };
}

describe("live feedback (SYNTHETIC)", () => {
  it("every live check reuses an instantaneous stat rule", () => {
    for (const ex of Object.values(EXERCISES)) {
      for (const chk of ex.liveChecks ?? []) {
        const rule = ex.evaluationRules.find((r) => r.type === chk.rule);
        expect(rule, `${ex.id}: ${chk.rule}`).toBeDefined();
        const c = rule!.condition;
        expect(c.kind).toBe("stat");
        if (c.kind === "stat") expect(["min", "max"]).toContain(c.stat);
        for (const p of chk.phases) expect(ex.movementPhases.map((x) => x.id)).toContain(p);
      }
    }
  });

  it("reports backward lean while it happens, before the rep is finished", () => {
    const { cues, repEnds } = run("backwardLean");
    const lean = cues.find((c) => c.errorType === "EXCESSIVE_BACKWARD_LEAN");
    expect(lean).toBeDefined();
    expect(repEnds.length).toBe(3);
    expect(lean!.timestamp).toBeLessThan(repEnds[0]!);
    expect(lean!.voice).toBeTruthy();
  });

  it("says the main issue right after the first faulty rep", () => {
    const { cues, repEnds } = run("hipRiseEarly");
    const hit = cues.find((c) => c.errorType === "HIP_RISE_TOO_EARLY");
    expect(hit).toBeDefined();
    expect(hit!.timestamp).toBeLessThanOrEqual(repEnds[0]! + 3000);
  });

  it("stays quiet about technique on clean reps", () => {
    const { cues } = run("none");
    expect(cues.filter((c) => c.kind === "technique")).toEqual([]);
  });
});
