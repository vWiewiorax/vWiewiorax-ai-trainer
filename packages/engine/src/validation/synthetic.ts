/**
 * SYNTHETIC TEST DATA. Generates side-view deadlift landmark sequences from a
 * planar stick-figure model with controllable faults. Used to test the
 * pipeline logic deterministically. It is NOT evidence of real-world accuracy.
 */
import type { LandmarkName } from "../core/landmarks";
import type { CameraMetadata, LandmarkSet, PoseFrame } from "../core/types";

export type DeadliftFault =
  | "none"
  | "hipRiseEarly"
  | "incompleteLockout"
  | "backwardLean"
  | "fastLowering"
  | "trunkChordLoss"
  | "partialRange";

export interface SyntheticDeadliftOptions {
  reps: number;
  fault?: DeadliftFault;
  /** Apply the fault only to these 1-based reps (default: all). */
  faultReps?: number[];
  fps?: number;
  noise?: number;
  seed?: number;
  /** Body scale (fraction of frame height). */
  scale?: number;
  facing?: 1 | -1;
  mirrored?: boolean;
  liftMs?: number;
  lowerMs?: number;
  /** Hide near-side wrist between these timestamps (occlusion test). */
  occlude?: [number, number];
}

interface Angles {
  shin: number;
  thigh: number;
  torso: number;
  torsoLen: number;
  /** Heel lift as a fraction of body scale (squat heel-rise fault). */
  heelLift?: number;
}

const STAND: Angles = { shin: 0, thigh: 2, torso: 1, torsoLen: 1 };
const SETUP: Angles = { shin: 15, thigh: 70, torso: 55, torsoLen: 1 };

export const SYNTHETIC_LABEL = "SYNTHETIC - not real-world validation data";

export function generateSyntheticDeadlift(opts: SyntheticDeadliftOptions): { frames: PoseFrame[]; label: string; repWindows: [number, number][] } {
  const fps = opts.fps ?? 30;
  const dt = 1000 / fps;
  const rnd = mulberry32(opts.seed ?? 1);
  const noise = opts.noise ?? 0.002;
  const frames: PoseFrame[] = [];
  const repWindows: [number, number][] = [];
  let t = 0;
  const meta: CameraMetadata = { width: 1280, height: 720, mirrored: !!opts.mirrored, facing: "environment", rotation: 0 };

  const emit = (a: Angles) => {
    frames.push({
      timestamp: Math.round(t),
      landmarks: render(a, opts, rnd, noise, meta, t),
      modelConfidence: 0.95,
      cameraMetadata: meta,
      source: "synthetic",
    });
    t += dt;
  };
  const hold = (a: Angles, ms: number) => {
    for (let k = 0; k < ms / dt; k++) emit(a);
  };
  const move = (from: Angles, to: Angles, ms: number, shape?: (p: number) => Angles) => {
    const n = Math.max(2, Math.round(ms / dt));
    for (let k = 1; k <= n; k++) {
      const p = smooth(k / n);
      emit(shape ? shape(k / n) : lerpA(from, to, p));
    }
  };

  hold(STAND, 1600);
  move(STAND, SETUP, 900);
  for (let r = 1; r <= opts.reps; r++) {
    const faulty = opts.fault && opts.fault !== "none" && (!opts.faultReps || opts.faultReps.includes(r));
    const f = faulty ? opts.fault! : "none";
    hold(SETUP, 600);
    const start = t;
    let top: Angles = STAND;
    if (f === "incompleteLockout") top = { shin: 3, thigh: 18, torso: 22, torsoLen: 1 };
    if (f === "backwardLean") top = { shin: 0, thigh: -6, torso: -18, torsoLen: 1 };
    if (f === "partialRange") top = { shin: 10, thigh: 45, torso: 35, torsoLen: 1 };
    const liftMs = opts.liftMs ?? 1100;
    if (f === "hipRiseEarly") {
      move(SETUP, top, liftMs, (p) => {
        const legs = smooth(Math.min(1, p * 2.2));
        const trunkP = smooth(Math.max(0, (p - 0.4) / 0.6));
        const trunk = p < 0.4 ? SETUP.torso + 20 * smooth(p / 0.4) : SETUP.torso + 20 - (SETUP.torso + 20 - top.torso) * trunkP;
        return { shin: lerp(SETUP.shin, top.shin, legs), thigh: lerp(SETUP.thigh, top.thigh, legs), torso: trunk, torsoLen: 1 };
      });
    } else if (f === "trunkChordLoss") {
      move(SETUP, top, liftMs, (p) => ({ ...lerpA(SETUP, top, smooth(p)), torsoLen: 1 - 0.18 * Math.sin(Math.PI * Math.min(1, p * 1.4)) }));
    } else {
      move(SETUP, top, liftMs);
    }
    hold(top, 500);
    const lowerMs = f === "fastLowering" ? 220 : opts.lowerMs ?? 1200;
    move(top, SETUP, lowerMs);
    repWindows.push([start, t]);
  }
  hold(SETUP, 600);
  move(SETUP, STAND, 900);
  hold(STAND, 800);
  return { frames, label: SYNTHETIC_LABEL, repWindows };
}

export type SyntheticTopStartFault = "none" | "shallow" | "fastDown" | "kneeBend" | "hipsFirst" | "incompleteTop" | "heelRise";

export interface SyntheticTopStartOptions extends Omit<SyntheticDeadliftOptions, "fault" | "liftMs" | "lowerMs"> {
  movement: "squat" | "romanian-deadlift";
  fault?: SyntheticTopStartFault;
  downMs?: number;
  upMs?: number;
}

const BOTTOM: Record<SyntheticTopStartOptions["movement"], Angles> = {
  squat: { shin: 32, thigh: 95, torso: 42, torsoLen: 1 },
  "romanian-deadlift": { shin: 8, thigh: 18, torso: 80, torsoLen: 1 },
};

/**
 * SYNTHETIC TEST DATA. Movements that start and end standing (squat, Romanian deadlift),
 * rendered with the same stick figure as the deadlift generator. Not real-world evidence.
 */
export function generateSyntheticTopStart(opts: SyntheticTopStartOptions): { frames: PoseFrame[]; label: string; repWindows: [number, number][] } {
  const fps = opts.fps ?? 30;
  const dt = 1000 / fps;
  const rnd = mulberry32(opts.seed ?? 1);
  const noise = opts.noise ?? 0.002;
  const frames: PoseFrame[] = [];
  const repWindows: [number, number][] = [];
  let t = 0;
  const meta: CameraMetadata = { width: 1280, height: 720, mirrored: !!opts.mirrored, facing: "environment", rotation: 0 };
  const ro = opts as SyntheticDeadliftOptions;
  const emit = (a: Angles) => {
    frames.push({ timestamp: Math.round(t), landmarks: render(a, ro, rnd, noise, meta, t), modelConfidence: 0.95, cameraMetadata: meta, source: "synthetic" });
    t += dt;
  };
  const hold = (a: Angles, ms: number) => {
    for (let k = 0; k < ms / dt; k++) emit(a);
  };
  const move = (from: Angles, to: Angles, ms: number, shape?: (p: number) => Angles) => {
    const n = Math.max(2, Math.round(ms / dt));
    for (let k = 1; k <= n; k++) emit(shape ? shape(k / n) : lerpA(from, to, smooth(k / n)));
  };
  const squat = opts.movement === "squat";
  hold(STAND, 1600);
  let top: Angles = STAND;
  for (let r = 1; r <= opts.reps; r++) {
    const faulty = opts.fault && opts.fault !== "none" && (!opts.faultReps || opts.faultReps.includes(r));
    const f = faulty ? opts.fault! : "none";
    let bottom = BOTTOM[opts.movement];
    if (f === "shallow") bottom = squat ? { shin: 25, thigh: 60, torso: 28, torsoLen: 1 } : { shin: 5, thigh: 10, torso: 45, torsoLen: 1 };
    if (f === "kneeBend") bottom = { shin: 22, thigh: 60, torso: 70, torsoLen: 1 };
    if (f === "heelRise") bottom = { ...bottom, heelLift: 0.06 };
    const nextTop = f === "incompleteTop" ? { shin: 6, thigh: 22, torso: 20, torsoLen: 1 } : STAND;
    hold(top, 600);
    const start = t;
    move(top, bottom, f === "fastDown" ? 250 : opts.downMs ?? 1200);
    hold(bottom, 300);
    const upMs = opts.upMs ?? 1000;
    if (f === "hipsFirst") {
      const b = bottom;
      move(b, nextTop, upMs, (p) => {
        const legs = smooth(Math.min(1, p * 2.2));
        const trunkP = smooth(Math.max(0, (p - 0.4) / 0.6));
        const trunk = p < 0.4 ? b.torso + 20 * smooth(p / 0.4) : b.torso + 20 - (b.torso + 20 - nextTop.torso) * trunkP;
        return { shin: lerp(b.shin, nextTop.shin, legs), thigh: lerp(b.thigh, nextTop.thigh, legs), torso: trunk, torsoLen: 1 };
      });
    } else {
      move(bottom, nextTop, upMs);
    }
    repWindows.push([start, t]);
    top = nextTop;
  }
  hold(top, 600);
  move(top, STAND, 600);
  hold(STAND, 800);
  return { frames, label: SYNTHETIC_LABEL, repWindows };
}

function render(a: Angles, o: SyntheticDeadliftOptions, rnd: () => number, noise: number, meta: CameraMetadata, t: number): LandmarkSet {
  const s = o.scale ?? 0.8;
  const f = o.facing ?? 1;
  const L = { shin: 0.27 * s, thigh: 0.27 * s, torso: 0.32 * s, arm: 0.36 * s, head: 0.12 * s, foot: 0.17 * s };
  const aspect = meta.width / meta.height;
  const ankle = { x: aspect * 0.5, y: 0.93 };
  const rad = Math.PI / 180;
  const knee = { x: ankle.x + f * L.shin * Math.sin(a.shin * rad), y: ankle.y - L.shin * Math.cos(a.shin * rad) };
  const hip = { x: knee.x - f * L.thigh * Math.sin(a.thigh * rad), y: knee.y - L.thigh * Math.cos(a.thigh * rad) };
  const tl = L.torso * a.torsoLen;
  const sh = { x: hip.x + f * tl * Math.sin(a.torso * rad), y: hip.y - tl * Math.cos(a.torso * rad) };
  const wrist = { x: sh.x, y: sh.y + L.arm };
  const elbow = { x: sh.x, y: sh.y + L.arm * 0.52 };
  const ear = { x: sh.x + f * 0.2 * L.head * Math.sin(a.torso * rad), y: sh.y - L.head * Math.cos(a.torso * rad) * 0.8 };
  const nose = { x: ear.x + f * 0.07 * s, y: ear.y + 0.01 };
  const heel = { x: ankle.x - f * 0.05 * s, y: ankle.y + 0.02 * s - (a.heelLift ?? 0) * s };
  const toe = { x: ankle.x + f * (L.foot - 0.05 * s), y: ankle.y + 0.03 * s };
  // Near side = left when facing +x; the far side is offset slightly with lower visibility.
  const near = f === 1 ? "left" : "right";
  const far = near === "left" ? "right" : "left";
  const out: LandmarkSet = {};
  const put = (name: LandmarkName, p: { x: number; y: number }, vis: number, z: number) => {
    let x = (p.x + gauss(rnd) * noise) / aspect;
    if (meta.mirrored) x = 1 - x;
    out[name] = { x, y: p.y + gauss(rnd) * noise, z, visibility: vis };
  };
  const parts: [string, { x: number; y: number }][] = [
    ["Shoulder", sh], ["Elbow", elbow], ["Wrist", wrist], ["Hip", hip], ["Knee", knee], ["Ankle", ankle],
    ["Heel", heel], ["FootIndex", toe], ["Ear", ear], ["Eye", { x: nose.x - f * 0.02 * s, y: nose.y - 0.015 }], ["Index", { x: wrist.x, y: wrist.y + 0.03 }],
  ];
  for (const [base, p] of parts) {
    const occluded = base === "Wrist" && o.occlude && t >= o.occlude[0] && t <= o.occlude[1];
    put(`${near}${base}` as LandmarkName, p, occluded ? 0.1 : 0.97, -0.1);
    put(`${far}${base}` as LandmarkName, { x: p.x - f * 0.008, y: p.y - 0.004 }, 0.62, 0.1);
  }
  put("nose", nose, 0.95, -0.15);
  if (meta.mirrored) {
    // A mirrored camera also swaps the anatomical labels as they appear to the model.
    const swapped: LandmarkSet = {};
    for (const [k, v] of Object.entries(out)) {
      const n = k.startsWith("left") ? k.replace("left", "right") : k.startsWith("right") ? k.replace("right", "left") : k;
      swapped[n as LandmarkName] = v;
    }
    return swapped;
  }
  return out;
}

const lerp = (a: number, b: number, p: number) => a + (b - a) * p;
const lerpA = (a: Angles, b: Angles, p: number): Angles => ({
  shin: lerp(a.shin, b.shin, p),
  thigh: lerp(a.thigh, b.thigh, p),
  torso: lerp(a.torso, b.torso, p),
  torsoLen: lerp(a.torsoLen, b.torsoLen, p),
  heelLift: lerp(a.heelLift ?? 0, b.heelLift ?? 0, p),
});
const smooth = (p: number) => p * p * (3 - 2 * p);

function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function gauss(rnd: () => number): number {
  const u = Math.max(1e-9, rnd());
  const v = rnd();
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
}
