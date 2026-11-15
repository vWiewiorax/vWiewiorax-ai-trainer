/**
 * Canonical, model-independent landmark set. Pose models are mapped onto these
 * names by adapters (see adapters/), so the rest of the engine never depends on
 * a specific model topology.
 */
export const LANDMARK_NAMES = [
  "nose",
  "leftEye",
  "rightEye",
  "leftEar",
  "rightEar",
  "leftShoulder",
  "rightShoulder",
  "leftElbow",
  "rightElbow",
  "leftWrist",
  "rightWrist",
  "leftIndex",
  "rightIndex",
  "leftHip",
  "rightHip",
  "leftKnee",
  "rightKnee",
  "leftAnkle",
  "rightAnkle",
  "leftHeel",
  "rightHeel",
  "leftFootIndex",
  "rightFootIndex",
] as const;

export type LandmarkName = (typeof LANDMARK_NAMES)[number];

export type Side = "left" | "right";

/** Pairs used when an image is mirrored: left and right labels must be swapped. */
export const MIRROR_PAIRS: ReadonlyArray<readonly [LandmarkName, LandmarkName]> = [
  ["leftEye", "rightEye"],
  ["leftEar", "rightEar"],
  ["leftShoulder", "rightShoulder"],
  ["leftElbow", "rightElbow"],
  ["leftWrist", "rightWrist"],
  ["leftIndex", "rightIndex"],
  ["leftHip", "rightHip"],
  ["leftKnee", "rightKnee"],
  ["leftAnkle", "rightAnkle"],
  ["leftHeel", "rightHeel"],
  ["leftFootIndex", "rightFootIndex"],
];

/** Bones drawn by skeleton overlays. */
export const SKELETON_CONNECTIONS: ReadonlyArray<readonly [LandmarkName, LandmarkName]> = [
  ["leftShoulder", "rightShoulder"],
  ["leftShoulder", "leftElbow"],
  ["leftElbow", "leftWrist"],
  ["rightShoulder", "rightElbow"],
  ["rightElbow", "rightWrist"],
  ["leftShoulder", "leftHip"],
  ["rightShoulder", "rightHip"],
  ["leftHip", "rightHip"],
  ["leftHip", "leftKnee"],
  ["leftKnee", "leftAnkle"],
  ["rightHip", "rightKnee"],
  ["rightKnee", "rightAnkle"],
  ["leftAnkle", "leftHeel"],
  ["leftHeel", "leftFootIndex"],
  ["leftAnkle", "leftFootIndex"],
  ["rightAnkle", "rightHeel"],
  ["rightHeel", "rightFootIndex"],
  ["rightAnkle", "rightFootIndex"],
  ["leftEar", "leftShoulder"],
  ["rightEar", "rightShoulder"],
];

export function sided(side: Side, base: "Shoulder" | "Elbow" | "Wrist" | "Index" | "Hip" | "Knee" | "Ankle" | "Heel" | "FootIndex" | "Ear" | "Eye"): LandmarkName {
  return `${side}${base}` as LandmarkName;
}

export function otherSide(side: Side): Side {
  return side === "left" ? "right" : "left";
}
