import { describe, expect, it } from "vitest";
import { aggregateMetrics, compareToAnnotation, deadlift, generateSyntheticDeadlift, runSequence, type DatasetAnnotation } from "../src";

const ann = (over: Partial<DatasetAnnotation>): DatasetAnnotation => ({
  id: "t",
  kind: "synthetic",
  source: "SYNTHETIC",
  exercise: deadlift.id,
  cameraView: "side",
  expectedRepCount: 3,
  errors: [],
  annotator: "generator",
  annotationConfidence: 1,
  ...over,
});

describe("validation dataset metrics (SYNTHETIC)", () => {
  it("matches error types and rep counts against annotations", () => {
    const { frames } = generateSyntheticDeadlift({ reps: 3, fault: "hipRiseEarly" });
    const report = runSequence(frames, { exercise: deadlift });
    const ok = compareToAnnotation(report, ann({ errors: [{ type: "HIP_RISE_TOO_EARLY", annotatorConfidence: 1 }] }));
    expect(ok.repCountError).toBe(0);
    expect(ok.truePositives).toContain("HIP_RISE_TOO_EARLY");
    const wrong = compareToAnnotation(report, ann({ expectedRepCount: 4, errors: [{ type: "INCOMPLETE_LOCKOUT", annotatorConfidence: 1 }] }));
    expect(wrong.repCountError).toBe(-1);
    expect(wrong.falseNegatives).toEqual(["INCOMPLETE_LOCKOUT"]);
    const m = aggregateMetrics([ok, wrong]);
    expect(m.repCountExact).toBe(1);
    expect(m.errorRecall).toBeLessThan(1);
  });

  it("ignores low-confidence annotator labels", () => {
    const { frames } = generateSyntheticDeadlift({ reps: 2 });
    const r = compareToAnnotation(runSequence(frames, { exercise: deadlift }), ann({ expectedRepCount: 2, errors: [{ type: "X", annotatorConfidence: 0.3 }] }));
    expect(r.falseNegatives).toEqual([]);
  });
});
