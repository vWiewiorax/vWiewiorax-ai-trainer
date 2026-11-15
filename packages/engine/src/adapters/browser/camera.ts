import type { CameraFacing } from "../../core/types";

export interface CameraOptions {
  facing?: Exclude<CameraFacing, "unknown">;
  deviceId?: string;
  width?: number;
  height?: number;
  frameRate?: number;
}

export interface OpenCamera {
  stream: MediaStream;
  facing: CameraFacing;
  width: number;
  height: number;
  frameRate: number;
  stop(): void;
}

/** Opens a camera stream and attaches it to the given <video>. */
export async function openCamera(video: HTMLVideoElement, opts: CameraOptions = {}): Promise<OpenCamera> {
  if (!navigator.mediaDevices?.getUserMedia) throw new Error("Ta przeglądarka nie udostępnia kamery (wymagane HTTPS lub localhost).");
  const stream = await navigator.mediaDevices.getUserMedia({
    audio: false,
    video: {
      deviceId: opts.deviceId ? { exact: opts.deviceId } : undefined,
      facingMode: opts.deviceId ? undefined : { ideal: opts.facing ?? "user" },
      width: { ideal: opts.width ?? 1280 },
      height: { ideal: opts.height ?? 720 },
      frameRate: { ideal: opts.frameRate ?? 30, max: 60 },
    },
  });
  video.srcObject = stream;
  video.muted = true;
  video.playsInline = true;
  await video.play();
  const track = stream.getVideoTracks()[0]!;
  const s = track.getSettings();
  const facing: CameraFacing = s.facingMode === "environment" ? "environment" : s.facingMode === "user" ? "user" : opts.facing ?? "unknown";
  return {
    stream,
    facing,
    width: video.videoWidth || s.width || 0,
    height: video.videoHeight || s.height || 0,
    frameRate: s.frameRate ?? 30,
    stop: () => {
      stream.getTracks().forEach((t) => t.stop());
      video.srcObject = null;
    },
  };
}

export async function listCameras(): Promise<MediaDeviceInfo[]> {
  const all = await navigator.mediaDevices.enumerateDevices();
  return all.filter((d) => d.kind === "videoinput");
}
