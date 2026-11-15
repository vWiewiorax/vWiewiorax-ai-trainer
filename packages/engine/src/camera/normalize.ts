import { LANDMARK_NAMES, MIRROR_PAIRS } from "../core/landmarks";
import type { CameraMetadata, LandmarkSet, NormalizedPose, Point, PoseFrame } from "../core/types";

/**
 * Converts model output (normalized image coords) into an upright, un-mirrored,
 * aspect-corrected camera space where 1 unit = image height. Distances are
 * isotropic, so angles computed here are not distorted by the aspect ratio.
 *
 * These are still camera-space measurements: they are a 2D projection of the
 * body, not anatomical 3D measurements.
 */
export function normalizeLandmarks(frame: PoseFrame): { points: NormalizedPose; aspect: number } {
  const meta = frame.cameraMetadata;
  const rotated = meta.rotation === 90 || meta.rotation === 270;
  const w = rotated ? meta.height : meta.width;
  const h = rotated ? meta.width : meta.height;
  const aspect = h > 0 ? w / h : 1;
  const src = meta.mirrored ? unmirror(frame.landmarks) : frame.landmarks;
  const points: NormalizedPose = {};
  for (const name of LANDMARK_NAMES) {
    const l = src[name];
    if (!l || !Number.isFinite(l.x) || !Number.isFinite(l.y)) continue;
    const [ux, uy] = rotate(l.x, l.y, meta.rotation);
    const presence = l.presence ?? 1;
    const point: Point = { x: ux * aspect, y: uy, z: l.z, confidence: Math.min(l.visibility, presence) };
    points[name] = point;
  }
  return { points, aspect };
}

function rotate(x: number, y: number, rotation: CameraMetadata["rotation"]): [number, number] {
  switch (rotation) {
    case 90:
      return [1 - y, x];
    case 180:
      return [1 - x, 1 - y];
    case 270:
      return [y, 1 - x];
    default:
      return [x, y];
  }
}

/** Flip horizontally and swap left/right labels so labels match the person's anatomy. */
export function unmirror(set: LandmarkSet): LandmarkSet {
  const out: LandmarkSet = {};
  for (const name of LANDMARK_NAMES) {
    const l = set[name];
    if (l) out[name] = { ...l, x: 1 - l.x };
  }
  for (const [a, b] of MIRROR_PAIRS) {
    const la = out[a];
    const lb = out[b];
    if (lb) out[a] = lb;
    else delete out[a];
    if (la) out[b] = la;
    else delete out[b];
  }
  return out;
}

export interface BodyBox {
  minX: number;
  maxX: number;
  minY: number;
  maxY: number;
  height: number;
  width: number;
}

export function bodyBox(points: NormalizedPose, minConfidence = 0.3): BodyBox | null {
  let minX = Infinity;
  let maxX = -Infinity;
  let minY = Infinity;
  let maxY = -Infinity;
  let n = 0;
  for (const p of Object.values(points)) {
    if (!p || p.confidence < minConfidence) continue;
    n++;
    minX = Math.min(minX, p.x);
    maxX = Math.max(maxX, p.x);
    minY = Math.min(minY, p.y);
    maxY = Math.max(maxY, p.y);
  }
  if (n < 4) return null;
  return { minX, maxX, minY, maxY, height: maxY - minY, width: maxX - minX };
}
