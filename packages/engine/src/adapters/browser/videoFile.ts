import type { CameraMetadata, PoseFrame } from "../../core/types";
import type { MediaPipePoseEstimator } from "../mediapipe/estimator";
import { fromMediaPipe } from "../mediapipe/mapping";
import { SceneCutDetector } from "../../camera/sceneCut";

export interface VideoExtractOptions {
  /** Sampling rate in frames per second of video time (not wall-clock). */
  fps?: number;
  startSec?: number;
  endSec?: number;
  onProgress?: (done: number, total: number) => void;
  signal?: AbortSignal;
}

/** Loads a video source and resolves once metadata and the first frame are available. */
export function loadVideo(video: HTMLVideoElement, src: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const cleanup = () => {
      video.removeEventListener("loadeddata", ok);
      video.removeEventListener("error", fail);
    };
    const ok = () => {
      cleanup();
      resolve();
    };
    const fail = () => {
      cleanup();
      reject(new Error("Nie udało się wczytać pliku wideo."));
    };
    video.addEventListener("loadeddata", ok);
    video.addEventListener("error", fail);
    video.muted = true;
    video.playsInline = true;
    video.preload = "auto";
    video.src = src;
    video.load();
  });
}

function seek(video: HTMLVideoElement, t: number): Promise<void> {
  return new Promise((resolve) => {
    if (Math.abs(video.currentTime - t) < 1e-4 && video.readyState >= 2) return resolve();
    video.addEventListener("seeked", () => resolve(), { once: true });
    video.currentTime = t;
  });
}

/**
 * Runs pose estimation over a recorded video at a fixed sampling rate (frame-accurate seeking,
 * independent of playback speed). Used for trainer reference videos and the validation dataset;
 * it is the same estimator and landmark mapping as the live camera path.
 */
export async function extractPoseFromVideo(
  video: HTMLVideoElement,
  estimator: MediaPipePoseEstimator,
  opts: VideoExtractOptions = {},
): Promise<PoseFrame[]> {
  const fps = opts.fps ?? 30;
  const start = Math.max(0, opts.startSec ?? 0);
  const end = Math.min(video.duration, opts.endSec ?? video.duration);
  const total = Math.max(0, Math.floor((end - start) * fps));
  const meta: CameraMetadata = { width: video.videoWidth, height: video.videoHeight, mirrored: false, facing: "unknown", rotation: 0 };
  video.pause();
  const cuts = new SceneCutDetector();
  const probe = document.createElement("canvas");
  probe.width = 32;
  probe.height = 18;
  const ctx2d = probe.getContext("2d", { willReadFrequently: true });
  const frames: PoseFrame[] = [];
  for (let i = 0; i < total; i++) {
    if (opts.signal?.aborted) throw new DOMException("Aborted", "AbortError");
    const t = start + i / fps;
    await seek(video, t);
    const ts = Math.round(t * 1000);
    let sceneCut = false;
    if (ctx2d) {
      ctx2d.drawImage(video, 0, 0, probe.width, probe.height);
      sceneCut = cuts.update(ctx2d.getImageData(0, 0, probe.width, probe.height).data);
    }
    const est = estimator.detect(video, ts);
    frames.push(fromMediaPipe(est.landmarks, ts, sceneCut ? { ...meta, sceneCut } : meta, { inferenceMs: est.inferenceMs, source: "mediapipe-pose:file" }));
    if (i % 5 === 0 || i === total - 1) opts.onProgress?.(i + 1, total);
  }
  return frames;
}
