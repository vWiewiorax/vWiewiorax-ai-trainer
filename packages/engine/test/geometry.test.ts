import { describe, expect, it } from "vitest";
import { angleBetween, angleDifference, inclinationFromVertical, jointAngle, OneEuroFilter, dtw } from "../src";

describe("vector math and joint angles", () => {
  it("computes interior joint angles in degrees", () => {
    expect(jointAngle({ x: 0, y: 0 }, { x: 0, y: 1 }, { x: 1, y: 1 })).toBeCloseTo(90, 6);
    expect(jointAngle({ x: 0, y: 0 }, { x: 0, y: 1 }, { x: 0, y: 2 })).toBeCloseTo(180, 6);
    expect(jointAngle({ x: 1, y: 0 }, { x: 0, y: 0 }, { x: 1, y: 1 })).toBeCloseTo(45, 6);
  });

  it("returns null for zero-length vectors instead of NaN", () => {
    expect(jointAngle({ x: 1, y: 1 }, { x: 1, y: 1 }, { x: 2, y: 2 })).toBeNull();
    expect(angleBetween({ x: 0, y: 0 }, { x: 1, y: 0 })).toBeNull();
  });

  it("measures inclination from vertical independent of direction", () => {
    expect(inclinationFromVertical({ x: 0, y: 1 }, { x: 0, y: 0 })).toBeCloseTo(0, 6);
    expect(inclinationFromVertical({ x: 0, y: 1 }, { x: 1, y: 0 })).toBeCloseTo(45, 6);
    expect(inclinationFromVertical({ x: 0, y: 1 }, { x: -1, y: 1 })).toBeCloseTo(90, 6);
  });

  it("wraps angle differences", () => {
    expect(Math.abs(angleDifference(350, 10))).toBeCloseTo(20, 6);
  });
});

describe("One Euro smoothing", () => {
  it("reduces jitter on a static signal and follows a step", () => {
    const f = new OneEuroFilter();
    let out = 0;
    const noisy: number[] = [];
    for (let i = 0; i < 60; i++) {
      const x = 0.5 + (i % 2 ? 0.01 : -0.01);
      noisy.push(x);
      out = f.filter(x, i * 33);
    }
    expect(Math.abs(out - 0.5)).toBeLessThan(0.01);
    for (let i = 60; i < 120; i++) out = f.filter(0.8, i * 33);
    expect(out).toBeCloseTo(0.8, 2);
  });
});

describe("DTW", () => {
  it("aligns a time-stretched copy with near-zero distance", () => {
    const a = Array.from({ length: 40 }, (_, i) => Math.sin((i / 39) * Math.PI));
    const b = Array.from({ length: 60 }, (_, i) => Math.sin((i / 59) * Math.PI));
    const c = Array.from({ length: 60 }, (_, i) => Math.sin((i / 59) * Math.PI) * 0.5);
    const same = dtw(a, b);
    const diff = dtw(a, c);
    expect(same.distance).toBeLessThan(diff.distance);
    expect(same.path[0]).toEqual([0, 0]);
    expect(same.path[same.path.length - 1]).toEqual([39, 59]);
  });
});
