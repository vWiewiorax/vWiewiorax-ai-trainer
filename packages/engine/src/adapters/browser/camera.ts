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
  deviceId: string;
  label: string;
  stop(): void;
}

export type CameraErrorCode = "unsupported" | "denied" | "blocked-by-embed" | "not-found" | "busy" | "constraints" | "unknown";

export class CameraError extends Error {
  constructor(
    readonly code: CameraErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "CameraError";
  }
}

function embeddedWithoutCamera(): boolean {
  if (typeof window === "undefined" || window.self === window.top) return false;
  const doc = document as Document & { permissionsPolicy?: { allowsFeature(f: string): boolean }; featurePolicy?: { allowsFeature(f: string): boolean } };
  const policy = doc.permissionsPolicy ?? doc.featurePolicy;
  return policy ? !policy.allowsFeature("camera") : true;
}

/** Maps getUserMedia failures to actionable Polish messages. */
export function describeCameraError(e: unknown): CameraError {
  if (e instanceof CameraError) return e;
  const name = e instanceof DOMException || e instanceof Error ? e.name : "";
  switch (name) {
    case "NotAllowedError":
    case "SecurityError":
      return embeddedWithoutCamera()
        ? new CameraError("blocked-by-embed", "Ta strona jest osadzona w innym oknie, które nie pozwala na użycie kamery. Otwórz ją w nowej karcie przeglądarki.")
        : new CameraError("denied", "Brak zgody na kamerę. Kliknij ikonę kłódki lub kamery obok paska adresu, zezwól na kamerę i odśwież stronę. Sprawdź też ustawienia prywatności systemu (Windows: Ustawienia > Prywatność > Kamera).");
    case "NotFoundError":
    case "DevicesNotFoundError":
      return new CameraError("not-found", "Nie znaleziono kamery. Podłącz kamerę lub sprawdź, czy nie jest wyłączona w systemie.");
    case "NotReadableError":
    case "TrackStartError":
    case "AbortError":
      return new CameraError("busy", "Kamera jest zajęta przez inny program (np. Teams, Zoom, Discord, inna karta przeglądarki). Zamknij go i spróbuj ponownie.");
    case "OverconstrainedError":
      return new CameraError("constraints", "Wybrana kamera nie obsługuje tych ustawień. Wybierz niższą rozdzielczość lub inną kamerę.");
    default:
      return new CameraError("unknown", `Nie udało się uruchomić kamery: ${e instanceof Error ? e.message : String(e)}`);
  }
}

/** Opens a camera stream and attaches it to the given <video>. Falls back to default constraints when the requested ones are not supported. */
export async function openCamera(video: HTMLVideoElement, opts: CameraOptions = {}): Promise<OpenCamera> {
  if (typeof navigator === "undefined" || !navigator.mediaDevices?.getUserMedia) {
    throw new CameraError("unsupported", "Ta przeglądarka nie udostępnia kamery. Wymagane jest HTTPS lub localhost i aktualny Chrome, Edge, Firefox albo Safari.");
  }
  const device = opts.deviceId ? { deviceId: { exact: opts.deviceId } } : { facingMode: { ideal: opts.facing ?? "user" } };
  let stream: MediaStream;
  try {
    stream = await navigator.mediaDevices.getUserMedia({
      audio: false,
      video: {
        ...device,
        width: { ideal: opts.width ?? 1280 },
        height: { ideal: opts.height ?? 720 },
        frameRate: { ideal: opts.frameRate ?? 30, max: 60 },
      },
    });
  } catch (e) {
    const name = e instanceof Error ? e.name : "";
    if (name !== "OverconstrainedError" && name !== "NotReadableError") throw describeCameraError(e);
    try {
      stream = await navigator.mediaDevices.getUserMedia({ audio: false, video: opts.deviceId ? { deviceId: { exact: opts.deviceId } } : true });
    } catch (e2) {
      throw describeCameraError(e2);
    }
  }
  video.srcObject = stream;
  video.muted = true;
  video.playsInline = true;
  await video.play();
  if (!video.videoWidth) {
    await new Promise<void>((resolve) => {
      const done = () => resolve();
      video.addEventListener("loadedmetadata", done, { once: true });
      setTimeout(done, 2000);
    });
  }
  const track = stream.getVideoTracks()[0]!;
  const s = track.getSettings();
  const facing: CameraFacing = s.facingMode === "environment" ? "environment" : s.facingMode === "user" ? "user" : opts.facing ?? "unknown";
  return {
    stream,
    facing,
    width: video.videoWidth || s.width || 0,
    height: video.videoHeight || s.height || 0,
    frameRate: s.frameRate ?? 30,
    deviceId: s.deviceId ?? opts.deviceId ?? "",
    label: track.label,
    stop: () => {
      stream.getTracks().forEach((t) => t.stop());
      video.srcObject = null;
    },
  };
}

/** Video inputs. Labels and ids are only filled in after camera permission was granted. */
export async function listCameras(): Promise<MediaDeviceInfo[]> {
  if (typeof navigator === "undefined" || !navigator.mediaDevices?.enumerateDevices) return [];
  const all = await navigator.mediaDevices.enumerateDevices();
  return all.filter((d) => d.kind === "videoinput" && d.deviceId !== "");
}
