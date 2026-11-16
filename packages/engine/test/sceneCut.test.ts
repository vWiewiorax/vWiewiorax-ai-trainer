import { describe, expect, it } from "vitest";
import { SceneCutDetector, lumaHistogram } from "../src/camera/sceneCut";
import { selectSpan } from "../src/evaluation/series";
import type { PhaseSpan } from "../src/core/types";

const solid = (v: number, n = 64) => Array.from({ length: n * 4 }, (_, i) => (i % 4 === 3 ? 255 : v));

describe("scene cut detection (synthetic pixels)", () => {
  it("normalizes the luminance histogram", () => {
    const h = lumaHistogram(solid(128), 16);
    expect(h.reduce((a, b) => a + b, 0)).toBeCloseTo(1);
  });

  it("ignores small brightness changes and flags an abrupt image change", () => {
    const d = new SceneCutDetector();
    expect(d.update(solid(100))).toBe(false);
    expect(d.update(solid(104))).toBe(false);
    expect(d.update(solid(230))).toBe(true);
    expect(d.update(solid(230))).toBe(false);
  });
});

describe("setup span selection", () => {
  const phases: PhaseSpan[] = [
    { id: "SETUP", kind: "start" as const, startTimestamp: 1000, endTimestamp: 1000 },
    { id: "LIFTING", kind: "concentric" as const, startTimestamp: 1000, endTimestamp: 2000 },
    { id: "SETUP", kind: "start" as const, startTimestamp: 4000, endTimestamp: 5000 },
  ];

  it("never uses the trailing return to start as the setup", () => {
    expect(selectSpan(phases, "SETUP")).toBeNull();
    const withSetup: PhaseSpan[] = [{ ...phases[0]!, startTimestamp: 200 }, ...phases.slice(1)];
    expect(selectSpan(withSetup, "SETUP")).toEqual({ start: 200, end: 1000 });
  });
});
