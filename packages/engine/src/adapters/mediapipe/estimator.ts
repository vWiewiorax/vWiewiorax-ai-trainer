import type { MediaPipeLandmark } from "./mapping";

export type PoseModelVariant = "lite" | "full" | "heavy";
export type DelegatePreference = "auto" | "GPU" | "CPU";

export interface PoseEstimatorOptions {
  /** URL of the directory with vision_wasm_internal.{js,wasm}. */
  wasmBaseUrl: string;
  /** URL of the .task model file. */
  modelUrl: string;
  delegate?: DelegatePreference;
  minPoseDetectionConfidence?: number;
  minPosePresenceConfidence?: number;
  minTrackingConfidence?: number;
}

export interface PoseEstimate {
  landmarks: MediaPipeLandmark[] | undefined;
  inferenceMs: number;
}

type Source = Parameters<import("@mediapipe/tasks-vision").PoseLandmarker["detectForVideo"]>[0];

/**
 * Thin wrapper around MediaPipe Pose Landmarker (VIDEO mode, single person).
 * Tries the GPU delegate first and falls back to CPU (WASM/XNNPACK).
 * Works on the main thread and inside a Web Worker.
 */
export class MediaPipePoseEstimator {
  private lastTs = -1;
  private constructor(
    private readonly landmarker: import("@mediapipe/tasks-vision").PoseLandmarker,
    readonly delegate: "GPU" | "CPU",
  ) {}

  static async create(opts: PoseEstimatorOptions): Promise<MediaPipePoseEstimator> {
    const { FilesetResolver, PoseLandmarker } = await import("@mediapipe/tasks-vision");
    const fileset = await FilesetResolver.forVisionTasks(opts.wasmBaseUrl);
    const order: ("GPU" | "CPU")[] = opts.delegate === "CPU" ? ["CPU"] : opts.delegate === "GPU" ? ["GPU"] : ["GPU", "CPU"];
    let lastErr: unknown;
    for (const delegate of order) {
      try {
        const lm = await PoseLandmarker.createFromOptions(fileset, {
          baseOptions: { modelAssetPath: opts.modelUrl, delegate },
          runningMode: "VIDEO",
          numPoses: 1,
          minPoseDetectionConfidence: opts.minPoseDetectionConfidence ?? 0.5,
          minPosePresenceConfidence: opts.minPosePresenceConfidence ?? 0.5,
          minTrackingConfidence: opts.minTrackingConfidence ?? 0.5,
        });
        return new MediaPipePoseEstimator(lm, delegate);
      } catch (e) {
        lastErr = e;
      }
    }
    throw lastErr instanceof Error ? lastErr : new Error("Nie udało się uruchomić modelu pozy");
  }

  /** Timestamps must increase strictly; equal or older timestamps are bumped. */
  detect(source: Source, timestamp: number): PoseEstimate {
    const ts = timestamp <= this.lastTs ? this.lastTs + 1 : timestamp;
    this.lastTs = ts;
    const t0 = performance.now();
    const res = this.landmarker.detectForVideo(source, ts);
    const inferenceMs = performance.now() - t0;
    const pose = res.landmarks[0];
    return { landmarks: pose ? pose.map((l) => ({ x: l.x, y: l.y, z: l.z, visibility: l.visibility, presence: l.presence })) : undefined, inferenceMs };
  }

  close(): void {
    this.landmarker.close();
  }
}
