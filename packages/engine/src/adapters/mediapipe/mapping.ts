import type { LandmarkName } from "../../core/landmarks";
import type { CameraMetadata, LandmarkSet, PoseFrame } from "../../core/types";

/** BlazePose (MediaPipe Pose Landmarker, 33 points) index for each canonical landmark. */
export const BLAZEPOSE_INDEX: Record<LandmarkName, number> = {
  nose: 0,
  leftEye: 2,
  rightEye: 5,
  leftEar: 7,
  rightEar: 8,
  leftShoulder: 11,
  rightShoulder: 12,
  leftElbow: 13,
  rightElbow: 14,
  leftWrist: 15,
  rightWrist: 16,
  leftIndex: 19,
  rightIndex: 20,
  leftHip: 23,
  rightHip: 24,
  leftKnee: 25,
  rightKnee: 26,
  leftAnkle: 27,
  rightAnkle: 28,
  leftHeel: 29,
  rightHeel: 30,
  leftFootIndex: 31,
  rightFootIndex: 32,
};

export interface MediaPipeLandmark {
  x: number;
  y: number;
  z: number;
  visibility?: number;
  presence?: number;
}

/** Converts one MediaPipe pose (or none) into the engine's model-independent PoseFrame. */
export function fromMediaPipe(
  pose: readonly MediaPipeLandmark[] | undefined,
  timestamp: number,
  cameraMetadata: CameraMetadata,
  extra: { inferenceMs?: number; source?: string } = {},
): PoseFrame {
  const landmarks: LandmarkSet = {};
  let visSum = 0;
  let n = 0;
  if (pose && pose.length >= 33) {
    for (const [name, idx] of Object.entries(BLAZEPOSE_INDEX) as [LandmarkName, number][]) {
      const l = pose[idx]!;
      const visibility = clamp01(l.visibility ?? 0);
      landmarks[name] = { x: l.x, y: l.y, z: l.z, visibility, presence: l.presence !== undefined ? clamp01(l.presence) : undefined };
      visSum += visibility;
      n++;
    }
  }
  return {
    timestamp,
    landmarks,
    modelConfidence: n ? visSum / n : 0,
    cameraMetadata,
    source: extra.source ?? "mediapipe-pose",
    inferenceMs: extra.inferenceMs,
  };
}

const clamp01 = (v: number) => (Number.isFinite(v) ? Math.min(1, Math.max(0, v)) : 0);
