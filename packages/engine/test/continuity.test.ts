import { describe, expect, it } from "vitest";
import { ExerciseAnalyzer, ContinuityMonitor, deadlift, generateSyntheticDeadlift, type PoseFrame } from "../src";

const shiftFrame = (f: PoseFrame, dx: number, s: number): PoseFrame => ({
  ...f,
  landmarks: Object.fromEntries(
    Object.entries(f.landmarks).map(([k, p]) => [k, p && { ...p, x: 0.5 + (p.x - 0.5) * s + dx, y: 0.5 + (p.y - 0.5) * s }]),
  ),
});

describe("scene continuity (SYNTHETIC)", () => {
  it("flags abrupt torso jumps and long gaps, not normal lifting motion", () => {
    const { frames } = generateSyntheticDeadlift({ reps: 3 });
    const m = new ContinuityMonitor();
    const a = new ExerciseAnalyzer({ exercise: deadlift });
    let flagged = 0;
    for (const f of frames) {
      const pts = a.processFrame(f).pose;
      if (m.update(pts, f.timestamp) !== "none") flagged++;
    }
    expect(flagged).toBe(0);
  });

  it("drops the repetition that is cut in the middle and keeps counting afterwards", () => {
    const { frames, repWindows } = generateSyntheticDeadlift({ reps: 4 });
    const [s, e] = repWindows[1]!;
    const cutAt = (s + e) / 2;
    const edited = frames.map((f) => (f.timestamp >= cutAt ? shiftFrame(f, 0.15, 0.6) : f));
    const a = new ExerciseAnalyzer({ exercise: deadlift });
    for (const f of edited) a.processFrame(f);
    const r = a.endSet();
    const startsBeforeCut = r.repetitions.filter((x) => x.startTimestamp < cutAt && x.endTimestamp > cutAt);
    expect(startsBeforeCut).toHaveLength(0);
    expect(r.repetitionCount).toBeGreaterThanOrEqual(1);
    expect(r.repetitionCount).toBeLessThanOrEqual(3);
  });

  it("drops the open repetition after a long no-person gap", () => {
    const { frames, repWindows } = generateSyntheticDeadlift({ reps: 3 });
    const [s, e] = repWindows[1]!;
    const mid = (s + e) / 2;
    const gapped = frames.map((f) => (f.timestamp >= mid && f.timestamp < mid + 1500 ? { ...f, landmarks: {} } : f));
    const a = new ExerciseAnalyzer({ exercise: deadlift });
    for (const f of gapped) a.processFrame(f);
    const r = a.endSet();
    expect(r.repetitions.some((x) => x.startTimestamp < mid && x.endTimestamp > mid + 1500)).toBe(false);
  });
});
