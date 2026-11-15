import { describe, expect, it } from "vitest";
import { ExerciseAnalyzer, deadlift, generateSyntheticDeadlift, type DeadliftFault, type TechniqueAnalysis } from "../src";

function run(fault: DeadliftFault, reps = 3, extra: Parameters<typeof generateSyntheticDeadlift>[0] = { reps }): TechniqueAnalysis {
  const { frames } = generateSyntheticDeadlift({ ...extra, reps, fault });
  const a = new ExerciseAnalyzer({ exercise: deadlift });
  for (const f of frames) a.processFrame(f);
  return a.endSet();
}

const types = (r: TechniqueAnalysis) => r.detectedErrors.map((e) => e.type);

describe("deadlift pipeline on SYNTHETIC sequences", () => {
  it("counts clean reps without technique errors", () => {
    const r = run("none", 4);
    expect(r.repetitionCount).toBe(4);
    expect(r.partialRepetitions).toBe(0);
    expect(types(r)).toEqual([]);
    expect(r.averageTechniqueScore).toBeGreaterThanOrEqual(90);
    expect(r.analysisConfidence).toBeGreaterThan(0.4);
    expect(r.cameraQuality.view).toBe("side");
  });

  it.each([
    ["hipRiseEarly", "HIP_RISE_TOO_EARLY"],
    ["incompleteLockout", "INCOMPLETE_LOCKOUT"],
    ["backwardLean", "EXCESSIVE_BACKWARD_LEAN"],
    ["fastLowering", "UNCONTROLLED_LOWERING"],
    ["trunkChordLoss", "EXCESSIVE_TRUNK_FLEXION"],
  ] as const)("detects %s as %s", (fault, type) => {
    const r = run(fault, 3);
    expect(r.repetitionCount).toBe(3);
    expect(types(r)).toContain(type);
    const clean = run("none", 3);
    expect(r.averageTechniqueScore!).toBeLessThan(clean.averageTechniqueScore!);
  });

  it("does not count partial range reps", () => {
    const r = run("partialRange", 3);
    expect(r.repetitionCount).toBe(0);
    expect(r.partialRepetitions).toBe(3);
    expect(types(r)).toContain("INCOMPLETE_RANGE_OF_MOTION");
  });

  it("handles a mirrored front camera and a lifter facing the other way", () => {
    expect(run("none", 3, { reps: 3, mirrored: true }).repetitionCount).toBe(3);
    const r = run("backwardLean", 3, { reps: 3, facing: -1 });
    expect(r.repetitionCount).toBe(3);
    expect(types(r)).toContain("EXCESSIVE_BACKWARD_LEAN");
  });

  it("is scale invariant (camera distance)", () => {
    expect(run("none", 3, { reps: 3, scale: 0.55 }).repetitionCount).toBe(3);
    expect(types(run("hipRiseEarly", 3, { reps: 3, scale: 0.55 }))).toContain("HIP_RISE_TOO_EARLY");
  });
});

describe("calibration without a standing pause (SYNTHETIC)", () => {
  it("calibrates from movement when the set starts at the bar", () => {
    const { frames, repWindows } = generateSyntheticDeadlift({ reps: 5, liftMs: 900, lowerMs: 1100 });
    const startAtBar = frames.filter((f) => f.timestamp >= (repWindows[0]?.[0] ?? 0));
    const a = new ExerciseAnalyzer({ exercise: deadlift });
    let readyAt: number | null = null;
    let source: string | null = null;
    for (const f of startAtBar) {
      const s = a.processFrame(f);
      if (readyAt === null && s.calibration.status === "READY") {
        readyAt = f.timestamp;
        source = s.calibration.baselineSource;
      }
    }
    const r = a.endSet();
    expect(readyAt).not.toBeNull();
    expect(source === "motion" || source === "standing").toBe(true);
    expect(r.repetitionCount).toBeGreaterThanOrEqual(3);
    expect(r.repetitionCount).toBeLessThanOrEqual(5);
  });
});
