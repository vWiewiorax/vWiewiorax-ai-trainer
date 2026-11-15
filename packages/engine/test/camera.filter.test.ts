import { describe, expect, it } from "vitest";
import { LandmarkFilter, normalizeLandmarks, unmirror, type PoseFrame, type NormalizedPose } from "../src";

const meta = { width: 1280, height: 720, mirrored: false, facing: "environment" as const, rotation: 0 as const };

describe("landmark normalization", () => {
  it("maps image coords to an aspect-corrected space", () => {
    const frame: PoseFrame = { timestamp: 0, modelConfidence: 1, cameraMetadata: meta, landmarks: { nose: { x: 1, y: 0.5, visibility: 1, presence: 1 } as never } };
    const { points, aspect } = normalizeLandmarks(frame);
    expect(aspect).toBeCloseTo(1280 / 720, 6);
    expect(points.nose?.x).toBeCloseTo(aspect, 6);
    expect(points.nose?.y).toBeCloseTo(0.5, 6);
  });

  it("swaps left/right labels for mirrored input", () => {
    const set = unmirror({ leftWrist: { x: 0.2, y: 0.5, visibility: 1 } as never });
    expect(set.leftWrist).toBeUndefined();
    expect(set.rightWrist).toBeDefined();
  });
});

describe("landmark filter", () => {
  const pose = (x: number, conf = 0.9): NormalizedPose => ({ leftHip: { x, y: 0.5, confidence: conf } });

  it("drops landmarks below the visibility threshold after the hold window", () => {
    const f = new LandmarkFilter();
    f.apply(pose(0.5), 0, 0.5);
    const held = f.apply(pose(0.5, 0.1), 33, 0.5);
    expect(held.leftHip?.interpolated).toBe(true);
    expect(held.leftHip!.confidence).toBeLessThan(0.9);
    const gone = f.apply(pose(0.5, 0.1), 600, 0.5);
    expect(gone.leftHip).toBeUndefined();
  });

  it("rejects implausible jumps as outliers", () => {
    const f = new LandmarkFilter();
    for (let i = 0; i < 5; i++) f.apply(pose(0.5), i * 33, 0.5);
    const out = f.apply(pose(1.5), 5 * 33, 0.5);
    expect(out.leftHip!.x).toBeLessThan(0.6);
  });

  it("accepts low-visibility landmarks listed as occludable", () => {
    const f = new LandmarkFilter({ perLandmarkMinVisibility: { leftHip: 0.2 } });
    const out = f.apply(pose(0.5, 0.3), 0, 0.5);
    expect(out.leftHip).toBeDefined();
    expect(out.leftHip!.confidence).toBeLessThanOrEqual(0.3);
  });
});
