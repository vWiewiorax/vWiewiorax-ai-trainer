import { describe, expect, it } from "vitest";
import {
  ExerciseAnalyzer,
  backSquat,
  romanianDeadlift,
  generateSyntheticTopStart,
  type ExerciseDefinition,
  type SyntheticTopStartFault,
  type SyntheticTopStartOptions,
  type TechniqueAnalysis,
} from "../src";

function run(exercise: ExerciseDefinition, o: SyntheticTopStartOptions): TechniqueAnalysis {
  const a = new ExerciseAnalyzer({ exercise });
  for (const f of generateSyntheticTopStart(o).frames) a.processFrame(f);
  return a.endSet();
}
const types = (r: TechniqueAnalysis) => r.detectedErrors.map((e) => e.type);

type Case = [SyntheticTopStartOptions["movement"], ExerciseDefinition, [SyntheticTopStartFault, string][]];
const cases: Case[] = [
  ["squat", backSquat, [["shallow", "INSUFFICIENT_DEPTH"], ["fastDown", "UNCONTROLLED_DESCENT"], ["hipsFirst", "HIPS_RISE_FIRST"], ["incompleteTop", "INCOMPLETE_EXTENSION"], ["heelRise", "HEEL_RISE"]]],
  ["romanian-deadlift", romanianDeadlift, [["kneeBend", "KNEE_BEND_EXCESSIVE"], ["fastDown", "UNCONTROLLED_LOWERING"], ["incompleteTop", "INCOMPLETE_LOCKOUT"]]],
];

describe.each(cases)("%s pipeline on SYNTHETIC sequences", (movement, exercise, faults) => {
  it("counts clean reps without technique errors", () => {
    const r = run(exercise, { movement, reps: 4 });
    expect(r.repetitionCount).toBe(4);
    expect(types(r)).toEqual([]);
    expect(r.averageTechniqueScore).toBeGreaterThanOrEqual(90);
    expect(r.cameraQuality.view).toBe("side");
  });

  it.each(faults)("detects %s as %s", (fault, type) => {
    const r = run(exercise, { movement, reps: 3, fault });
    expect(r.repetitionCount).toBe(3);
    expect(types(r)).toContain(type);
    expect(r.averageTechniqueScore!).toBeLessThan(run(exercise, { movement, reps: 3 }).averageTechniqueScore!);
  });

  it("handles mirroring, facing and distance", () => {
    expect(run(exercise, { movement, reps: 3, mirrored: true }).repetitionCount).toBe(3);
    expect(run(exercise, { movement, reps: 3, facing: -1, scale: 0.55, noise: 0.005, seed: 7 }).repetitionCount).toBe(3);
  });
});

describe("Romanian deadlift range (SYNTHETIC)", () => {
  it("does not count a shallow hinge as a repetition", () => {
    const r = run(romanianDeadlift, { movement: "romanian-deadlift", reps: 3, fault: "shallow" });
    expect(r.repetitionCount).toBe(0);
  });
});
