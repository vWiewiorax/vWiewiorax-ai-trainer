import type { LandmarkName, Side } from "../core/landmarks";
import type { CameraView, Measurement, NormalizedPose, Point } from "../core/types";
import { angleBetween, distance, inclinationFromVertical, jointAngle, signedAngleFromHorizontal, sub, toDegrees } from "../geometry/vector";
import { type BodyBaseline, measureSegments, mid, pointOk } from "./body";

export interface FeatureContext {
  pose: NormalizedPose;
  nearSide: Side;
  view: CameraView;
  baseline: BodyBaseline | null;
  /** +1 when the athlete faces +x in the image, -1 when facing -x (side views). */
  facing: 1 | -1;
  minConfidence: number;
}

export type FeatureGroup = "joint" | "alignment";

export interface FeatureSpec {
  group: FeatureGroup;
  unit: "deg" | "ratio" | "body";
  description: string;
  compute: (ctx: FeatureContext) => Measurement | null;
}

const MIN_SEG = 1e-4;

function pts(ctx: FeatureContext, names: LandmarkName[]): Point[] | null {
  const out: Point[] = [];
  for (const n of names) {
    const p = ctx.pose[n];
    if (!pointOk(p, ctx.minConfidence)) return null;
    out.push(p);
  }
  return out;
}

const conf = (ps: (Point | null | undefined)[]) =>
  Math.min(...ps.map((p) => (p ? p.confidence * (p.interpolated ? 0.8 : 1) : 0)));

function angle3(ctx: FeatureContext, a: LandmarkName, b: LandmarkName, c: LandmarkName): Measurement | null {
  const p = pts(ctx, [a, b, c]);
  if (!p) return null;
  const v = jointAngle(p[0]!, p[1]!, p[2]!);
  return v === null ? null : { value: v, confidence: conf(p) };
}

const L = (side: Side, base: string) => `${side}${base}` as LandmarkName;

function centers(ctx: FeatureContext) {
  const near = ctx.nearSide;
  // In side views the far side is partially occluded: use the near-side landmark directly.
  const sideView = ctx.view === "side" || ctx.view === "front-side";
  const nearPoint = (n: LandmarkName) => (pointOk(ctx.pose[n], ctx.minConfidence) ? ctx.pose[n]! : null);
  const pick = (a: LandmarkName, b: LandmarkName, nearName: LandmarkName): Point | null =>
    sideView
      ? nearPoint(nearName) ?? mid(ctx.pose, a, b, ctx.minConfidence)
      : mid(ctx.pose, a, b, ctx.minConfidence) ?? nearPoint(nearName);
  return {
    shoulder: pick("leftShoulder", "rightShoulder", L(near, "Shoulder")),
    hip: pick("leftHip", "rightHip", L(near, "Hip")),
    knee: pick("leftKnee", "rightKnee", L(near, "Knee")),
    ankle: pick("leftAnkle", "rightAnkle", L(near, "Ankle")),
    wrist: pick("leftWrist", "rightWrist", L(near, "Wrist")),
  };
}

/** Segment lengths: calibrated baseline when available, otherwise measured live. */
function lengths(ctx: FeatureContext): { torso: number; legLength: number; shin: number; shoulderWidth: number } | null {
  if (ctx.baseline) return ctx.baseline;
  const m = measureSegments(ctx.pose, ctx.nearSide, ctx.minConfidence);
  if (!m.torso || !m.legLength || !m.shin) return null;
  return { torso: m.torso, legLength: m.legLength, shin: m.shin, shoulderWidth: m.shoulderWidth ?? m.torso * 0.8 };
}

/** Midfoot = midpoint between heel and toe of the near foot (base-of-support proxy). */
function midfoot(ctx: FeatureContext): Point | null {
  const heel = ctx.pose[L(ctx.nearSide, "Heel")];
  const toe = ctx.pose[L(ctx.nearSide, "FootIndex")];
  if (pointOk(heel, ctx.minConfidence) && pointOk(toe, ctx.minConfidence)) {
    return { x: (heel.x + toe.x) / 2, y: (heel.y + toe.y) / 2, confidence: Math.min(heel.confidence, toe.confidence) };
  }
  const ankle = ctx.pose[L(ctx.nearSide, "Ankle")];
  return pointOk(ankle, ctx.minConfidence) ? { ...ankle, confidence: ankle.confidence * 0.7 } : null;
}

function heightAboveAnkles(ctx: FeatureContext, p: Point | null): Measurement | null {
  const c = centers(ctx);
  const len = lengths(ctx);
  if (!p || !c.ankle || !len || len.legLength < MIN_SEG) return null;
  return { value: (c.ankle.y - p.y) / len.legLength, confidence: conf([p, c.ankle]) };
}

const sidedAngles: Record<string, FeatureSpec> = {};
const angleDefs: [string, string, string, string, string][] = [
  ["KneeAngle", "Hip", "Knee", "Ankle", "Kąt w stawie kolanowym (180° = wyprost)"],
  ["HipAngle", "Shoulder", "Hip", "Knee", "Kąt tułów-udo w stawie biodrowym (180° = wyprost)"],
  ["ElbowAngle", "Shoulder", "Elbow", "Wrist", "Kąt w stawie łokciowym (180° = wyprost)"],
  ["ShoulderAngle", "Hip", "Shoulder", "Elbow", "Kąt ramię-tułów (0° = ramię przy tułowiu, 180° = nad głową)"],
  ["AnkleAngle", "Knee", "Ankle", "FootIndex", "Kąt goleń-stopa"],
];
for (const [name, a, b, c, description] of angleDefs) {
  for (const side of ["left", "right"] as const) {
    sidedAngles[`${side}${name}`] = {
      group: "joint",
      unit: "deg",
      description,
      compute: (ctx) => angle3(ctx, L(side, a), L(side, b), L(side, c)),
    };
  }
  const near = name.charAt(0).toLowerCase() + name.slice(1);
  sidedAngles[near] = {
    group: "joint",
    unit: "deg",
    description: `${description}, strona bliżej kamery`,
    compute: (ctx) => angle3(ctx, L(ctx.nearSide, a), L(ctx.nearSide, b), L(ctx.nearSide, c)),
  };
}

function minOfSides(name: string): FeatureSpec {
  return {
    group: "joint",
    unit: "deg",
    description: `Mniejszy (bardziej zgięty) z lewego i prawego: ${name}`,
    compute: (ctx) => {
      const l = sidedAngles[`left${name}`]!.compute(ctx);
      const r = sidedAngles[`right${name}`]!.compute(ctx);
      if (l && r) return l.value <= r.value ? l : r;
      const one = l ?? r;
      return one ? { value: one.value, confidence: one.confidence * 0.6 } : null;
    },
  };
}

function sideDiff(name: string): FeatureSpec {
  return {
    group: "alignment",
    unit: "deg",
    description: `Różnica lewa-prawa: ${name}`,
    compute: (ctx) => {
      const l = sidedAngles[`left${name}`]!.compute(ctx);
      const r = sidedAngles[`right${name}`]!.compute(ctx);
      return l && r ? { value: Math.abs(l.value - r.value), confidence: Math.min(l.confidence, r.confidence) } : null;
    },
  };
}

export const FEATURES: Record<string, FeatureSpec> = {
  ...sidedAngles,
  minElbowAngle: minOfSides("ElbowAngle"),
  minKneeAngle: minOfSides("KneeAngle"),
  elbowAngleDiff: sideDiff("ElbowAngle"),
  kneeAngleDiff: sideDiff("KneeAngle"),
  hipAngleDiff: sideDiff("HipAngle"),
  trunkInclination: {
    group: "joint",
    unit: "deg",
    description: "Pochylenie tułowia od pionu w płaszczyźnie obrazu (0° = pion, 90° = poziom)",
    compute: (ctx) => {
      const c = centers(ctx);
      if (!c.hip || !c.shoulder) return null;
      const v = inclinationFromVertical(c.hip, c.shoulder);
      return v === null ? null : { value: v, confidence: conf([c.hip, c.shoulder]) };
    },
  },
  trunkLeanSigned: {
    group: "joint",
    unit: "deg",
    description: "Pochylenie tułowia ze znakiem (widok z boku): + = do przodu, - = odchylenie do tyłu",
    compute: (ctx) => {
      const c = centers(ctx);
      if (!c.hip || !c.shoulder) return null;
      const dx = ctx.facing * (c.shoulder.x - c.hip.x);
      const dy = c.hip.y - c.shoulder.y;
      if (Math.hypot(dx, dy) < MIN_SEG) return null;
      return { value: toDegrees(Math.atan2(dx, dy)), confidence: conf([c.hip, c.shoulder]) };
    },
  },
  neckAlignment: {
    group: "joint",
    unit: "deg",
    description: "Kąt ucho-bark-biodro (180° = głowa w linii tułowia)",
    compute: (ctx) => angle3(ctx, L(ctx.nearSide, "Ear"), L(ctx.nearSide, "Shoulder"), L(ctx.nearSide, "Hip")),
  },
  bodyLineAngle: {
    group: "joint",
    unit: "deg",
    description: "Kąt bark-biodro-kostka (180° = ciało w jednej linii)",
    compute: (ctx) => angle3(ctx, L(ctx.nearSide, "Shoulder"), L(ctx.nearSide, "Hip"), L(ctx.nearSide, "Ankle")),
  },
  forearmInclination: {
    group: "joint",
    unit: "deg",
    description: "Odchylenie przedramienia od pionu",
    compute: (ctx) => {
      const p = pts(ctx, [L(ctx.nearSide, "Elbow"), L(ctx.nearSide, "Wrist")]);
      if (!p) return null;
      const v = angleBetween(sub(p[1]!, p[0]!), { x: 0, y: -1 });
      if (v === null) return null;
      return { value: Math.min(v, 180 - v), confidence: conf(p) };
    },
  },
  trunkChordRatio: {
    group: "alignment",
    unit: "ratio",
    description:
      "Długość odcinka bark-biodro względem pozycji stojącej (proxy zaokrąglenia pleców w widoku z boku; nie mierzy bezpośrednio kręgosłupa)",
    compute: (ctx) => {
      if (!ctx.baseline || ctx.baseline.torso < MIN_SEG) return null;
      const p = pts(ctx, [L(ctx.nearSide, "Shoulder"), L(ctx.nearSide, "Hip")]);
      if (!p) return null;
      return { value: distance(p[0]!, p[1]!) / ctx.baseline.torso, confidence: conf(p) };
    },
  },
  shoulderTilt: {
    group: "alignment",
    unit: "deg",
    description: "Przechylenie linii barków od poziomu (widok z przodu/tyłu)",
    compute: (ctx) => tilt(ctx, "leftShoulder", "rightShoulder"),
  },
  hipTilt: {
    group: "alignment",
    unit: "deg",
    description: "Przechylenie linii bioder od poziomu (proxy ustawienia miednicy)",
    compute: (ctx) => tilt(ctx, "leftHip", "rightHip"),
  },
  trunkLateralLean: {
    group: "alignment",
    unit: "deg",
    description: "Boczne odchylenie tułowia od pionu (widok z przodu/tyłu, wartość bezwzględna)",
    compute: (ctx) => {
      const c = centers(ctx);
      const sh = mid(ctx.pose, "leftShoulder", "rightShoulder", ctx.minConfidence);
      const hp = mid(ctx.pose, "leftHip", "rightHip", ctx.minConfidence);
      if (!sh || !hp || !c) return null;
      const d = sub(sh, hp);
      return { value: Math.abs(toDegrees(Math.atan2(d.x, -d.y))), confidence: conf([sh, hp]) };
    },
  },
  hipShift: {
    group: "alignment",
    unit: "body",
    description: "Przesunięcie środka bioder w bok względem środka stóp / długość nogi (widok z przodu/tyłu)",
    compute: (ctx) => {
      const hp = mid(ctx.pose, "leftHip", "rightHip", ctx.minConfidence);
      const an = mid(ctx.pose, "leftAnkle", "rightAnkle", ctx.minConfidence);
      const len = lengths(ctx);
      if (!hp || !an || !len) return null;
      return { value: Math.abs(hp.x - an.x) / len.legLength, confidence: conf([hp, an]) };
    },
  },
  kneeValgusRatio: {
    group: "alignment",
    unit: "ratio",
    description: "Rozstaw kolan / rozstaw kostek (widok z przodu; < 1 = kolana schodzą do środka)",
    compute: (ctx) => {
      const p = pts(ctx, ["leftKnee", "rightKnee", "leftAnkle", "rightAnkle"]);
      if (!p) return null;
      const ankles = Math.abs(p[2]!.x - p[3]!.x);
      if (ankles < 0.02) return null;
      return { value: Math.abs(p[0]!.x - p[1]!.x) / ankles, confidence: conf(p) };
    },
  },
  hipHeight: {
    group: "alignment",
    unit: "body",
    description: "Wysokość bioder nad kostkami / długość nogi",
    compute: (ctx) => heightAboveAnkles(ctx, centers(ctx).hip),
  },
  shoulderHeight: {
    group: "alignment",
    unit: "body",
    description: "Wysokość barków nad kostkami / długość nogi",
    compute: (ctx) => heightAboveAnkles(ctx, centers(ctx).shoulder),
  },
  shoulderHeightRel: {
    group: "alignment",
    unit: "body",
    description: "Wysokość barków nad kostkami względem wysokości w pozycji stojącej (1 = pełny wyprost tułowia i nóg)",
    compute: (ctx) => {
      const c = centers(ctx);
      const len = lengths(ctx);
      if (!c.shoulder || !c.ankle || !len) return null;
      const standing = len.legLength + len.torso;
      if (standing < MIN_SEG) return null;
      return { value: (c.ankle.y - c.shoulder.y) / standing, confidence: conf([c.shoulder, c.ankle]) };
    },
  },
  wristHeight: {
    group: "alignment",
    unit: "body",
    description: "Wysokość nadgarstków (proxy sztangi) nad kostkami / długość nogi",
    compute: (ctx) => heightAboveAnkles(ctx, centers(ctx).wrist),
  },
  wristToMidfootX: {
    group: "alignment",
    unit: "body",
    description: "Odległość pozioma nadgarstka (proxy sztangi) od śródstopia / długość tułowia (widok z boku, + = przed śródstopiem)",
    compute: (ctx) => {
      const w = ctx.pose[L(ctx.nearSide, "Wrist")];
      const mf = midfoot(ctx);
      const len = lengths(ctx);
      if (!pointOk(w, ctx.minConfidence) || !mf || !len) return null;
      return { value: (ctx.facing * (w.x - mf.x)) / len.torso, confidence: conf([w, mf]) };
    },
  },
  shoulderToWristX: {
    group: "alignment",
    unit: "body",
    description: "Pozioma pozycja barku względem nadgarstka / długość tułowia (+ = bark przed sztangą)",
    compute: (ctx) => {
      const p = pts(ctx, [L(ctx.nearSide, "Shoulder"), L(ctx.nearSide, "Wrist")]);
      const len = lengths(ctx);
      if (!p || !len) return null;
      return { value: (ctx.facing * (p[0]!.x - p[1]!.x)) / len.torso, confidence: conf(p) };
    },
  },
  kneeForward: {
    group: "alignment",
    unit: "body",
    description: "Wysunięcie kolana przed palce / długość goleni (widok z boku)",
    compute: (ctx) => {
      const p = pts(ctx, [L(ctx.nearSide, "Knee"), L(ctx.nearSide, "FootIndex")]);
      const len = lengths(ctx);
      if (!p || !len) return null;
      return { value: (ctx.facing * (p[0]!.x - p[1]!.x)) / len.shin, confidence: conf(p) };
    },
  },
  heelLift: {
    group: "alignment",
    unit: "body",
    description: "Wysokość pięty względem palców stopy / długość goleni (widok z boku, rośnie gdy pięta się odrywa)",
    compute: (ctx) => {
      const p = pts(ctx, [L(ctx.nearSide, "Heel"), L(ctx.nearSide, "FootIndex")]);
      const len = lengths(ctx);
      if (!p || !len) return null;
      return { value: (p[1]!.y - p[0]!.y) / len.shin, confidence: conf(p) };
    },
  },
  hipBelowKnee: {
    group: "alignment",
    unit: "body",
    description: "Pionowa pozycja biodra względem kolana / długość tułowia (+ = biodro poniżej kolana)",
    compute: (ctx) => {
      const p = pts(ctx, [L(ctx.nearSide, "Hip"), L(ctx.nearSide, "Knee")]);
      const len = lengths(ctx);
      if (!p || !len) return null;
      return { value: (p[0]!.y - p[1]!.y) / len.torso, confidence: conf(p) };
    },
  },
  wristAboveShoulder: {
    group: "alignment",
    unit: "body",
    description: "Wysokość nadgarstków nad barkami / długość tułowia",
    compute: (ctx) => {
      const c = centers(ctx);
      const len = lengths(ctx);
      if (!c.wrist || !c.shoulder || !len) return null;
      return { value: (c.shoulder.y - c.wrist.y) / len.torso, confidence: conf([c.wrist, c.shoulder]) };
    },
  },
  wristToShoulderDistance: {
    group: "alignment",
    unit: "body",
    description: "Odległość nadgarstek-bark / długość tułowia (ramiona zwisające ≈ 1.1-1.3)",
    compute: (ctx) => {
      const p = pts(ctx, [L(ctx.nearSide, "Shoulder"), L(ctx.nearSide, "Wrist")]);
      const len = lengths(ctx);
      if (!p || !len) return null;
      return { value: distance(p[0]!, p[1]!) / len.torso, confidence: conf(p) };
    },
  },
  wristHeightDiff: {
    group: "alignment",
    unit: "body",
    description: "Różnica wysokości lewego i prawego nadgarstka / długość tułowia (przechylenie sztangi)",
    compute: (ctx) => {
      const p = pts(ctx, ["leftWrist", "rightWrist"]);
      const len = lengths(ctx);
      if (!p || !len) return null;
      return { value: Math.abs(p[0]!.y - p[1]!.y) / len.torso, confidence: conf(p) };
    },
  },
  splitStance: {
    group: "alignment",
    unit: "body",
    description: "Rozstaw stóp w osi przód-tył / długość nogi (widok z boku)",
    compute: (ctx) => {
      const p = pts(ctx, ["leftAnkle", "rightAnkle"]);
      const len = lengths(ctx);
      if (!p || !len) return null;
      return { value: Math.abs(p[0]!.x - p[1]!.x) / len.legLength, confidence: conf(p) };
    },
  },
  comOffset: {
    group: "alignment",
    unit: "body",
    description: "Pozioma odległość przybliżonego środka ciężkości (barki+biodra) od śródstopia / długość nogi (proxy równowagi)",
    compute: (ctx) => {
      const c = centers(ctx);
      const mf = midfoot(ctx);
      const len = lengths(ctx);
      if (!c.hip || !c.shoulder || !mf || !len) return null;
      const com = (c.hip.x * 0.6 + c.shoulder.x * 0.4);
      return { value: (ctx.facing * (com - mf.x)) / len.legLength, confidence: conf([c.hip, c.shoulder, mf]) };
    },
  },
  chinAboveHands: {
    group: "alignment",
    unit: "body",
    description: "Wysokość nosa względem nadgarstków / długość tułowia (+ = broda nad dłońmi)",
    compute: (ctx) => {
      const c = centers(ctx);
      const len = lengths(ctx);
      const nose = ctx.pose.nose;
      if (!c.wrist || !pointOk(nose, ctx.minConfidence) || !len) return null;
      return { value: (c.wrist.y - nose.y) / len.torso, confidence: conf([c.wrist, nose]) };
    },
  },
};

function tilt(ctx: FeatureContext, a: LandmarkName, b: LandmarkName): Measurement | null {
  const p = pts(ctx, [a, b]);
  if (!p) return null;
  if (distance(p[0]!, p[1]!) < 0.02) return null;
  const v = signedAngleFromHorizontal(p[0]!, p[1]!);
  if (v === null) return null;
  const abs = Math.abs(v);
  return { value: Math.min(abs, 180 - abs), confidence: conf(p) };
}

export function isKnownFeature(name: string): boolean {
  return name in FEATURES || (name.endsWith(".velocity") && name.slice(0, -9) in FEATURES) || (name.endsWith(".accel") && name.slice(0, -6) in FEATURES);
}

export function baseFeatureName(name: string): string {
  if (name.endsWith(".velocity")) return name.slice(0, -9);
  if (name.endsWith(".accel")) return name.slice(0, -6);
  return name;
}
