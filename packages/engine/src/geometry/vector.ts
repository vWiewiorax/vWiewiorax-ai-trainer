export interface Vec2 {
  x: number;
  y: number;
}

const EPS = 1e-9;

export const sub = (a: Vec2, b: Vec2): Vec2 => ({ x: a.x - b.x, y: a.y - b.y });
export const add = (a: Vec2, b: Vec2): Vec2 => ({ x: a.x + b.x, y: a.y + b.y });
export const scale = (a: Vec2, s: number): Vec2 => ({ x: a.x * s, y: a.y * s });
export const dot = (a: Vec2, b: Vec2): number => a.x * b.x + a.y * b.y;
export const cross = (a: Vec2, b: Vec2): number => a.x * b.y - a.y * b.x;
export const norm = (a: Vec2): number => Math.hypot(a.x, a.y);
export const distance = (a: Vec2, b: Vec2): number => Math.hypot(a.x - b.x, a.y - b.y);
export const midpoint = (a: Vec2, b: Vec2): Vec2 => ({ x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 });

export const toDegrees = (rad: number): number => (rad * 180) / Math.PI;

/** Unsigned angle between two vectors in degrees [0, 180], or null for zero-length vectors. */
export function angleBetween(u: Vec2, v: Vec2): number | null {
  const nu = norm(u);
  const nv = norm(v);
  if (nu < EPS || nv < EPS) return null;
  const c = Math.min(1, Math.max(-1, dot(u, v) / (nu * nv)));
  return toDegrees(Math.acos(c));
}

/**
 * Interior angle at vertex b formed by a-b-c, in degrees.
 * 180 = segments are collinear (joint fully straight), smaller = more flexed.
 */
export function jointAngle(a: Vec2, b: Vec2, c: Vec2): number | null {
  return angleBetween(sub(a, b), sub(c, b));
}

/**
 * Angle of the segment from -> to relative to vertical "up" in image space, degrees [0, 180].
 * 0 = pointing straight up, 90 = horizontal, 180 = pointing down.
 */
export function inclinationFromVertical(from: Vec2, to: Vec2): number | null {
  return angleBetween(sub(to, from), { x: 0, y: -1 });
}

/**
 * Signed angle of the segment from -> to relative to horizontal in image space, degrees (-180, 180].
 * Positive when `to` is higher in the image than `from` (y axis points down).
 */
export function signedAngleFromHorizontal(from: Vec2, to: Vec2): number | null {
  const d = sub(to, from);
  if (norm(d) < EPS) return null;
  return toDegrees(Math.atan2(-d.y, d.x));
}

/** Smallest absolute difference between two angles in degrees. */
export function angleDifference(a: number, b: number): number {
  let d = (a - b) % 360;
  if (d > 180) d -= 360;
  if (d < -180) d += 360;
  return Math.abs(d);
}
