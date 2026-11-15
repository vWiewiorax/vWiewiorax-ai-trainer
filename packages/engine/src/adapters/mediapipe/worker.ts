import { MediaPipePoseEstimator, type PoseEstimatorOptions } from "./estimator";
import type { MediaPipeLandmark } from "./mapping";

export type WorkerRequest =
  | { type: "init"; options: PoseEstimatorOptions }
  | { type: "frame"; id: number; timestamp: number; bitmap: ImageBitmap; brightness?: boolean }
  | { type: "close" };

export type WorkerResponse =
  | { type: "ready"; delegate: "GPU" | "CPU" }
  | { type: "error"; message: string }
  | { type: "result"; id: number; timestamp: number; landmarks: MediaPipeLandmark[] | undefined; inferenceMs: number; brightness?: number };

interface WorkerScope {
  onmessage: ((ev: MessageEvent<WorkerRequest>) => void) | null;
  postMessage(msg: WorkerResponse): void;
}

/**
 * Installs the pose-estimation message handler in a dedicated Web Worker.
 * Usage (worker entry file): `import { installPoseWorker } from "@trainer/engine/mediapipe"; installPoseWorker(self);`
 */
export function installPoseWorker(scope: WorkerScope): void {
  let estimator: MediaPipePoseEstimator | null = null;
  let lumaCanvas: OffscreenCanvas | null = null;
  scope.onmessage = async (ev) => {
    const msg = ev.data;
    try {
      if (msg.type === "init") {
        estimator = await MediaPipePoseEstimator.create(msg.options);
        scope.postMessage({ type: "ready", delegate: estimator.delegate });
      } else if (msg.type === "frame") {
        if (!estimator) {
          msg.bitmap.close();
          return;
        }
        let brightness: number | undefined;
        if (msg.brightness && typeof OffscreenCanvas !== "undefined") {
          lumaCanvas ??= new OffscreenCanvas(32, 18);
          brightness = meanLuma(lumaCanvas, msg.bitmap);
        }
        const r = estimator.detect(msg.bitmap, msg.timestamp);
        msg.bitmap.close();
        scope.postMessage({ type: "result", id: msg.id, timestamp: msg.timestamp, landmarks: r.landmarks, inferenceMs: r.inferenceMs, brightness });
      } else if (msg.type === "close") {
        estimator?.close();
        estimator = null;
      }
    } catch (e) {
      if (msg.type === "frame") msg.bitmap.close();
      scope.postMessage({ type: "error", message: e instanceof Error ? e.message : String(e) });
    }
  };
}

export function meanLuma(canvas: OffscreenCanvas | HTMLCanvasElement, src: CanvasImageSource): number | undefined {
  const ctx = canvas.getContext("2d", { willReadFrequently: true }) as OffscreenCanvasRenderingContext2D | CanvasRenderingContext2D | null;
  if (!ctx) return undefined;
  ctx.drawImage(src, 0, 0, canvas.width, canvas.height);
  const d = ctx.getImageData(0, 0, canvas.width, canvas.height).data;
  let s = 0;
  for (let i = 0; i < d.length; i += 4) s += 0.2126 * d[i]! + 0.7152 * d[i + 1]! + 0.0722 * d[i + 2]!;
  return s / (d.length / 4) / 255;
}
