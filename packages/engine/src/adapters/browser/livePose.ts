import type { CameraMetadata, PoseFrame } from "../../core/types";
import { MediaPipePoseEstimator, type PoseEstimatorOptions } from "../mediapipe/estimator";
import { fromMediaPipe } from "../mediapipe/mapping";
import { meanLuma, type WorkerRequest, type WorkerResponse } from "../mediapipe/worker";
import { AdaptiveScheduler } from "./scheduler";

export interface LivePoseOptions {
  video: HTMLVideoElement;
  estimator: PoseEstimatorOptions;
  /** Factory for the pose worker; when omitted or failing, inference runs on the main thread. */
  createWorker?: () => Worker;
  facing: CameraMetadata["facing"];
  maxFps?: number;
  onFrame: (frame: PoseFrame) => void;
  onError?: (message: string) => void;
}

export interface LivePoseStats {
  mode: "worker" | "main-thread";
  delegate: "GPU" | "CPU";
  targetFps: number;
  meanLatencyMs: number;
  processedFps: number;
  dropped: number;
}

/**
 * Camera frame loop: grabs video frames, runs pose estimation (Web Worker when
 * available), converts results to PoseFrames. The engine itself stays DOM-free.
 */
export class LivePoseSource {
  private worker: Worker | null = null;
  private main: MediaPipePoseEstimator | null = null;
  private running = false;
  private scheduler: AdaptiveScheduler;
  private id = 0;
  private pending = new Map<number, number>();
  private processed: number[] = [];
  private lumaCanvas: HTMLCanvasElement | null = null;
  private lastLuma = -Infinity;
  private lastBrightness: number | undefined;
  private rafHandle = 0;
  private stats: LivePoseStats = { mode: "main-thread", delegate: "CPU", targetFps: 0, meanLatencyMs: 0, processedFps: 0, dropped: 0 };

  private constructor(private readonly opts: LivePoseOptions) {
    this.scheduler = new AdaptiveScheduler(opts.maxFps ?? 30);
  }

  static async start(opts: LivePoseOptions): Promise<LivePoseSource> {
    const s = new LivePoseSource(opts);
    await s.init();
    s.running = true;
    s.loop();
    return s;
  }

  get currentStats(): LivePoseStats {
    return { ...this.stats, targetFps: this.scheduler.targetFps, meanLatencyMs: this.scheduler.meanLatencyMs, dropped: this.scheduler.dropped };
  }

  stop(): void {
    this.running = false;
    cancelAnimationFrame(this.rafHandle);
    if (this.worker) {
      this.worker.postMessage({ type: "close" } satisfies WorkerRequest);
      this.worker.terminate();
    }
    this.main?.close();
    this.worker = null;
    this.main = null;
  }

  private async init(): Promise<void> {
    if (this.opts.createWorker && typeof createImageBitmap === "function") {
      try {
        const w = this.opts.createWorker();
        const delegate = await new Promise<"GPU" | "CPU">((resolve, reject) => {
          const timer = setTimeout(() => reject(new Error("timeout")), 30000);
          w.onmessage = (ev: MessageEvent<WorkerResponse>) => {
            if (ev.data.type === "ready") {
              clearTimeout(timer);
              resolve(ev.data.delegate);
            } else if (ev.data.type === "error") {
              clearTimeout(timer);
              reject(new Error(ev.data.message));
            }
          };
          w.onerror = (e) => {
            clearTimeout(timer);
            reject(new Error(e.message || "worker error"));
          };
          w.postMessage({ type: "init", options: this.opts.estimator } satisfies WorkerRequest);
        });
        w.onmessage = (ev: MessageEvent<WorkerResponse>) => this.onWorkerMessage(ev.data);
        this.worker = w;
        this.stats.mode = "worker";
        this.stats.delegate = delegate;
        return;
      } catch {
        // fall through to main-thread inference
      }
    }
    this.main = await MediaPipePoseEstimator.create(this.opts.estimator);
    this.stats.mode = "main-thread";
    this.stats.delegate = this.main.delegate;
  }

  private meta(): CameraMetadata {
    const v = this.opts.video;
    // Pixels are passed to the model un-mirrored; any selfie mirroring is CSS-only.
    return { width: v.videoWidth, height: v.videoHeight, mirrored: false, facing: this.opts.facing, rotation: 0, brightness: this.lastBrightness };
  }

  private loop = (): void => {
    if (!this.running) return;
    this.rafHandle = requestAnimationFrame(this.loop);
    const v = this.opts.video;
    if (v.readyState < 2 || v.videoWidth === 0) return;
    const now = performance.now();
    if (!this.scheduler.shouldProcess(now)) return;
    const wantLuma = now - this.lastLuma > 500;
    if (wantLuma) this.lastLuma = now;
    if (this.worker) {
      const id = ++this.id;
      this.pending.set(id, now);
      createImageBitmap(v)
        .then((bitmap) => {
          this.worker?.postMessage({ type: "frame", id, timestamp: now, bitmap, brightness: wantLuma } satisfies WorkerRequest, [bitmap]);
        })
        .catch(() => {
          this.pending.delete(id);
          this.scheduler.done(0);
        });
    } else if (this.main) {
      try {
        if (wantLuma) {
          this.lumaCanvas ??= Object.assign(document.createElement("canvas"), { width: 32, height: 18 });
          this.lastBrightness = meanLuma(this.lumaCanvas, v);
        }
        const r = this.main.detect(v, now);
        this.scheduler.done(performance.now() - now);
        this.emit(now, r.landmarks, r.inferenceMs);
      } catch (e) {
        this.scheduler.done(0);
        this.opts.onError?.(e instanceof Error ? e.message : String(e));
      }
    }
  };

  private onWorkerMessage(msg: WorkerResponse): void {
    if (msg.type === "error") {
      this.scheduler.done(0);
      this.opts.onError?.(msg.message);
      return;
    }
    if (msg.type !== "result") return;
    const sent = this.pending.get(msg.id);
    this.pending.delete(msg.id);
    this.scheduler.done(sent !== undefined ? performance.now() - sent : msg.inferenceMs);
    if (msg.brightness !== undefined) this.lastBrightness = msg.brightness;
    this.emit(msg.timestamp, msg.landmarks, msg.inferenceMs);
  }

  private emit(ts: number, landmarks: Parameters<typeof fromMediaPipe>[0], inferenceMs: number): void {
    const now = performance.now();
    this.processed.push(now);
    while (this.processed.length && this.processed[0]! < now - 1000) this.processed.shift();
    this.stats.processedFps = this.processed.length;
    this.opts.onFrame(fromMediaPipe(landmarks, ts, this.meta(), { inferenceMs, source: "mediapipe-pose" }));
  }
}
