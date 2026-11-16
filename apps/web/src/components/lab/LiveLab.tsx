"use client";

import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from "react";
import { BrowserSpeech, EXERCISES, ExerciseAnalyzer, deadlift, type FeedbackItem, type LiveState, type ReferenceModel, type TechniqueAnalysis } from "@trainer/engine";
import { LivePoseSource, describeCameraError, listCameras, openCamera, type LivePoseStats, type OpenCamera } from "@trainer/engine/browser";
import { drawOverlay } from "./overlay";
import { IconAlert, IconCamera, IconExpand, IconMute, IconStop, IconVolume } from "./icons";
import Report from "./Report";
import { REFERENCE_STORAGE_KEY } from "./referenceStorage";
import { ExerciseSelect } from "./ExerciseSelect";
import { repIssues, scoreColor, type RepIssue } from "./repIssues";

interface RepEntry {
  index: number;
  score: number | null;
  incomplete: boolean;
  issues: RepIssue[];
}

type Phase = "idle" | "opening" | "preview" | "loading" | "running" | "report" | "error";

const RESOLUTIONS = { "480": [640, 480], "720": [1280, 720], "1080": [1920, 1080] } as const;
type Resolution = keyof typeof RESOLUTIONS;

const STATUS_LABEL: Record<string, string> = {
  NOT_STARTED: "Nie rozpoczęto",
  POSITIONING: "Ustawianie",
  CALIBRATING: "Kalibracja - stój nieruchomo",
  READY: "Gotowe",
  INSUFFICIENT_VISIBILITY: "Za słaba widoczność",
  INCORRECT_CAMERA_ANGLE: "Zły kąt kamery",
};
const VIEW_LABEL: Record<string, string> = { side: "z boku", "front-side": "skos", front: "z przodu", rear: "z tyłu", unknown: "nieznany" };

export default function LiveLab() {
  const videoRef = useRef<HTMLVideoElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const cameraRef = useRef<OpenCamera | null>(null);
  const sourceRef = useRef<LivePoseSource | null>(null);
  const analyzerRef = useRef<ExerciseAnalyzer | null>(null);
  const speechRef = useRef<BrowserSpeech | null>(null);
  const debugRef = useRef(false);
  const latestRef = useRef<LiveState | null>(null);
  const trailRef = useRef<{ x: number; y: number }[][]>([[], [], []]);
  const stageRef = useRef<HTMLDivElement>(null);
  const heldRef = useRef<{ item: FeedbackItem; until: number } | null>(null);

  const [phase, setPhase] = useState<Phase>("idle");
  const [exerciseId, setExerciseId] = useState(deadlift.id);
  const exercise = EXERCISES[exerciseId] ?? deadlift;
  const [error, setError] = useState<string | null>(null);
  const [facing, setFacing] = useState<"user" | "environment">("user");
  const [model, setModel] = useState<"lite" | "full">("full");
  const [voice, setVoice] = useState(true);
  const [live, setLive] = useState<LiveState | null>(null);
  const [stats, setStats] = useState<LivePoseStats | null>(null);
  const [cues, setCues] = useState<FeedbackItem[]>([]);
  const [report, setReport] = useState<TechniqueAnalysis | null>(null);
  const [cameras, setCameras] = useState<MediaDeviceInfo[]>([]);
  const [deviceId, setDeviceId] = useState("");
  const [resolution, setResolution] = useState<Resolution>("720");
  const [mirror, setMirror] = useState(true);
  const [camInfo, setCamInfo] = useState<string | null>(null);
  const [far, setFar] = useState(false);
  const [heldCue, setHeldCue] = useState<FeedbackItem | null>(null);
  const [repLog, setRepLog] = useState<RepEntry[]>([]);
  const newTabUrl = useSyncExternalStore(noopSubscribe, embeddedUrl, () => null);

  const stopAll = useCallback(() => {
    sourceRef.current?.stop();
    sourceRef.current = null;
    cameraRef.current?.stop();
    cameraRef.current = null;
    speechRef.current?.cancel();
  }, []);

  useEffect(() => stopAll, [stopAll]);

  useEffect(() => {
    debugRef.current = new URLSearchParams(window.location.search).has("debug");
    const refresh = () => listCameras().then(setCameras).catch(() => setCameras([]));
    refresh();
    navigator.mediaDevices?.addEventListener?.("devicechange", refresh);
    return () => navigator.mediaDevices?.removeEventListener?.("devicechange", refresh);
  }, []);

  useEffect(() => {
    if (speechRef.current) speechRef.current.enabled = voice;
  }, [voice]);

  // UI refresh at ~10 Hz; drawing happens per processed frame.
  useEffect(() => {
    if (phase !== "running") return;
    const id = setInterval(() => {
      setLive(latestRef.current);
      if (sourceRef.current) setStats(sourceRef.current.currentStats);
      const h = heldRef.current;
      setHeldCue(h && performance.now() < h.until ? h.item : null);
    }, 100);
    return () => clearInterval(id);
  }, [phase]);

  // Keep the screen on while analysing (phones dim after ~30 s without touch).
  useEffect(() => {
    if (phase !== "running" || !("wakeLock" in navigator)) return;
    let lock: WakeLockSentinel | null = null;
    let cancelled = false;
    navigator.wakeLock.request("screen").then((l) => (cancelled ? void l.release() : (lock = l)), () => {});
    return () => {
      cancelled = true;
      void lock?.release();
    };
  }, [phase]);

  useEffect(() => {
    const onChange = () => {
      if (!document.fullscreenElement) setFar(false);
    };
    document.addEventListener("fullscreenchange", onChange);
    return () => document.removeEventListener("fullscreenchange", onChange);
  }, []);

  const toggleFar = () => {
    if (far) {
      if (document.fullscreenElement) void document.exitFullscreen().catch(() => {});
      setFar(false);
      return;
    }
    setFar(true);
    // iOS Safari has no element fullscreen; the fixed full-viewport layout is the fallback.
    void stageRef.current?.requestFullscreen?.().catch(() => {});
  };

  const openPreview = async (opts: { deviceId?: string; resolution?: Resolution; facing?: "user" | "environment" } = {}): Promise<OpenCamera | null> => {
    const dev = opts.deviceId ?? deviceId;
    const [width, height] = RESOLUTIONS[opts.resolution ?? resolution];
    setError(null);
    setPhase("opening");
    cameraRef.current?.stop();
    cameraRef.current = null;
    try {
      const cam = await openCamera(videoRef.current!, { deviceId: dev || undefined, facing: opts.facing ?? facing, width, height, frameRate: 30 });
      cameraRef.current = cam;
      setCamInfo(`${cam.label || "Kamera"}: ${cam.width}x${cam.height}, ${Math.round(cam.frameRate)} kl./s`);
      const list = await listCameras().catch(() => []);
      setCameras(list);
      if (list.some((c) => c.deviceId === cam.deviceId)) setDeviceId(cam.deviceId);
      if (cam.facing === "environment") setMirror(false);
      setPhase("preview");
      return cam;
    } catch (e) {
      setError(describeCameraError(e).message);
      setPhase("error");
      return null;
    }
  };

  const reopenIfPreviewing = (opts: Parameters<typeof openPreview>[0]) => {
    if (phase === "preview" || phase === "error") void openPreview(opts);
  };

  const stopCamera = () => {
    stopAll();
    setCamInfo(null);
    setPhase("idle");
  };

  const start = async () => {
    setReport(null);
    setCues([]);
    setRepLog([]);
    const cam = cameraRef.current ?? (await openPreview());
    if (!cam) return;
    setError(null);
    setPhase("loading");
    try {
      const video = videoRef.current!;
      const canvas = canvasRef.current!;
      canvas.width = video.videoWidth;
      canvas.height = video.videoHeight;
      const ctx = canvas.getContext("2d")!;
      speechRef.current = new BrowserSpeech("pl-PL");
      speechRef.current.enabled = voice;
      let reference: ReferenceModel | null = null;
      try {
        const raw = localStorage.getItem(REFERENCE_STORAGE_KEY);
        if (raw) reference = JSON.parse(raw) as ReferenceModel;
      } catch {
        reference = null;
      }
      analyzerRef.current = new ExerciseAnalyzer({ exercise, reference: reference?.exerciseId === exercise.id ? reference : null });
      trailRef.current = [[], [], []];
      const origin = typeof window !== "undefined" ? window.location.origin : "";
      sourceRef.current = await LivePoseSource.start({
        video,
        facing: cam.facing,
        estimator: { wasmBaseUrl: `${origin}/mediapipe/wasm`, modelUrl: `${origin}/models/pose_landmarker_${model}.task`, delegate: "auto" },
        createWorker: () => new Worker(new URL("../../workers/pose.worker.ts", import.meta.url), { type: "module" }),
        onFrame: (frame) => {
          const analyzer = analyzerRef.current;
          if (!analyzer) return;
          const s = analyzer.processFrame(frame);
          latestRef.current = s;
    if (debugRef.current) (window as unknown as { __trainer?: unknown }).__trainer = { frame, state: s };
          const near = s.nearSide;
          const pts = [s.pose[`${near}Hip`], s.pose[`${near}Shoulder`], s.pose[`${near}Wrist`]];
          pts.forEach((p, i) => {
            const tr = trailRef.current[i]!;
            if (p && p.confidence > 0.5 && s.status === "analysing") tr.push({ x: p.x, y: p.y });
            if (tr.length > 90) tr.shift();
          });
          drawOverlay(ctx, s, trailRef.current);
          const rep = s.newRepetition;
          if (rep) setRepLog((l) => [...l, { index: rep.index, score: rep.techniqueScore, incomplete: rep.incomplete, issues: repIssues(exercise.id, rep) }]);
          if (s.feedback) {
            const item = s.feedback;
            if (item.voice) speechRef.current?.speak(item.voice, { interrupt: item.kind === "safety" || item.kind === "technique" });
            if (item.kind !== "rep") heldRef.current = { item, until: performance.now() + 5000 };
            if (item.kind !== "rep") setCues((c) => (c[0]?.text === item.text ? c : [item, ...c.filter((x) => x.text !== item.text)].slice(0, 6)));
          }
        },
        onError: (m) => setError(m),
      });
      setPhase("running");
    } catch (e) {
      sourceRef.current?.stop();
      sourceRef.current = null;
      setError(`Nie udało się uruchomić modelu pozy: ${e instanceof Error ? e.message : String(e)}`);
      setPhase(cameraRef.current ? "preview" : "error");
    }
  };

  const endSet = () => {
    const analyzer = analyzerRef.current;
    stopAll();
    if (document.fullscreenElement) void document.exitFullscreen().catch(() => {});
    setFar(false);
    if (analyzer) {
      const r = analyzer.endSet();
      if (debugRef.current) (window as unknown as { __trainerReport?: unknown }).__trainerReport = r;
      setReport(r);
    }
    setPhase("report");
  };

  const mirrored = mirror;
  const locked = phase === "running" || phase === "loading" || phase === "opening";
  const cal = live?.calibration;
  const lastRep = live?.lastRepetition;
  const bigCue = live?.visualCues[0] ?? heldCue;
  const t = far
    ? { box: "rounded-2xl bg-black/75 px-[2.5vmin] py-[1.5vmin]", reps: "text-[16vmin] portrait:text-[24vmin] leading-none", small: "text-[2.6vmin]", score: "text-[11vmin] portrait:text-[16vmin] leading-none", cue: "text-[6vmin] portrait:text-[9vmin] leading-tight px-[3vmin] py-[2.5vmin]", title: "text-[5vmin]", body: "text-[3.6vmin]", inset: "inset-x-[2vmin] bottom-[2vmin]" }
    : { box: "rounded-lg bg-black/70 px-3 py-2", reps: "text-4xl", small: "text-xs", score: "text-3xl", cue: "text-lg px-4 py-3", title: "", body: "text-sm", inset: "inset-x-3 bottom-3" };

  return (
    <main className="min-h-screen bg-slate-950 text-slate-100">
      <header className="border-b border-slate-800 px-4 py-3 flex flex-wrap items-center gap-3">
        <h1 className="text-lg font-semibold">Analiza techniki na żywo - {exercise.name.toLowerCase()}</h1>
        <ExerciseSelect value={exerciseId} onChange={setExerciseId} disabled={phase === "running"} />
        <span className="text-xs text-slate-400">Kamera i model działają lokalnie w przeglądarce. Obraz nie jest nigdzie wysyłany.</span>
        <p className="w-full text-xs text-slate-400" data-testid="camera-setup">{exercise.cameraSetup}</p>
      </header>

      <div className="grid gap-4 p-4 lg:grid-cols-[1fr_380px]">
        <section>
          <div ref={stageRef} className={far ? "fixed inset-0 z-50 overflow-hidden bg-black" : "relative w-full overflow-hidden rounded-xl bg-black aspect-video"} data-testid="stage">
            <div className="absolute inset-0" style={{ transform: mirrored ? "scaleX(-1)" : undefined }}>
              <video ref={videoRef} className="h-full w-full object-contain" playsInline muted />
              <canvas ref={canvasRef} className="pointer-events-none absolute inset-0 h-full w-full object-contain" />
            </div>
            {phase === "running" && live && (
              <>
                <div className={`absolute left-3 top-3 ${t.box}`}>
                  <div className={`${t.reps} font-bold tabular-nums`}>{live.repCount}</div>
                  <div className={`${t.small} text-slate-300`}>powtórzenia{live.partialReps ? ` (+${live.partialReps} niepełne)` : ""}</div>
                </div>
                <div className={`absolute right-3 top-3 text-right ${t.box}`}>
                  <div className={`${t.small} text-slate-300`}>Ostatnie powtórzenie</div>
                  <div className={`${t.score} font-bold tabular-nums`}>{lastRep?.techniqueScore ?? "-"}</div>
                  <div className={`${t.small} text-slate-400`}>pewność analizy {lastRep ? Math.round(lastRep.analysisConfidence * 100) + "%" : "-"}</div>
                </div>
                {far && live.phaseLabel && (
                  <div className={`absolute left-1/2 top-3 -translate-x-1/2 whitespace-nowrap portrait:top-[40vmin] ${t.box} ${t.title} font-semibold`}>{live.phaseLabel}</div>
                )}
                {live.status !== "analysing" && cal && (
                  <div className={`absolute ${t.inset} rounded-lg bg-amber-500/90 px-4 py-3 text-slate-950`}>
                    <div className={`font-semibold ${t.title}`}>{STATUS_LABEL[cal.status] ?? cal.status}</div>
                    <div className={t.body}>{cal.guidance[0] ?? "Ustaw się tak, aby była widoczna cała sylwetka."}</div>
                    {cal.status === "CALIBRATING" && (
                      <div className="mt-2 h-1.5 w-full rounded bg-slate-950/20">
                        <div className="h-1.5 rounded bg-slate-950" style={{ width: `${Math.round(cal.progress * 100)}%` }} />
                      </div>
                    )}
                  </div>
                )}
                {live.status === "analysing" && (
                  <div className={`absolute ${t.inset} flex flex-col gap-[1.5vmin]`}>
                    {repLog.length > 0 && (
                      <div className="flex flex-wrap gap-[1vmin]" data-testid="rep-strip">
                        {repLog.slice(-8).map((r) => (
                          <span key={r.index} className={`rounded-md px-2 py-0.5 font-bold tabular-nums ${far ? "text-[4vmin]" : "text-sm"} ${scoreColor(r.score, r.incomplete)}`}>
                            #{r.index} {r.incomplete ? "niepełne" : r.score ?? "?"}
                          </span>
                        ))}
                      </div>
                    )}
                    {bigCue && (
                      <div className={`rounded-lg font-semibold ${t.cue} ${cueColor(bigCue)}`} data-testid="big-cue">{bigCue.text}</div>
                    )}
                  </div>
                )}
                {live.stopSetRecommended && (
                  <div className={`absolute inset-x-3 ${far ? "top-[40vmin] text-[5vmin]" : "top-24"} flex items-center gap-2 rounded-lg bg-red-600 px-4 py-3 font-semibold`}>
                    <IconAlert /> Zatrzymaj serię i odpocznij.
                  </div>
                )}
              </>
            )}
            {far && (
              <div className={`absolute right-[2vmin] z-10 flex gap-2 opacity-70 hover:opacity-100 ${phase === "running" ? "top-[27vmin] portrait:top-[56vmin]" : "bottom-[2vmin]"}`}>
                {phase === "preview" && (
                  <button onClick={start} className="rounded-lg bg-emerald-500 px-4 py-2 font-semibold text-slate-950">Start analizy</button>
                )}
                {phase === "running" && (
                  <button onClick={endSet} className="rounded-lg bg-rose-500 px-4 py-2 font-semibold text-slate-950">Zakończ serię</button>
                )}
                <button onClick={toggleFar} className="rounded-lg bg-slate-800 px-4 py-2 text-sm">Zamknij pełny ekran</button>
              </div>
            )}
            {(phase === "idle" || phase === "opening" || phase === "error") && (
              <div className="absolute inset-0 flex flex-col items-center justify-center gap-3 p-6 text-center">
                <p className="max-w-md text-slate-300">
                  Ustaw telefon lub laptop bokiem do siebie, około 2,5-4 m od miejsca ćwiczenia, na wysokości bioder. Cała sylwetka razem ze stopami musi być w kadrze.
                </p>
                {phase === "opening" && <p className="text-sm text-slate-400">Uruchamiam kamerę. Jeśli przeglądarka zapyta o dostęp, kliknij Zezwól.</p>}
              </div>
            )}
          </div>

          <div className="mt-3 flex flex-wrap items-center gap-2">
            {phase !== "running" ? (
              <>
                <button onClick={start} disabled={phase === "loading" || phase === "opening"} className="flex items-center gap-2 rounded-lg bg-emerald-500 px-4 py-2 font-semibold text-slate-950 disabled:opacity-50">
                  <IconCamera /> {phase === "report" ? "Nowa seria" : phase === "loading" ? "Ładuję model pozy..." : "Start analizy"}
                </button>
                {phase === "preview" ? (
                  <button onClick={stopCamera} className="rounded-lg border border-slate-700 px-3 py-2 text-sm">Wyłącz kamerę</button>
                ) : (
                  phase !== "loading" && (
                    <button onClick={() => void openPreview()} disabled={phase === "opening"} className="rounded-lg border border-slate-700 px-3 py-2 text-sm disabled:opacity-50" data-testid="camera-preview">
                      Tylko podgląd kamery
                    </button>
                  )
                )}
              </>
            ) : (
              <button onClick={endSet} className="flex items-center gap-2 rounded-lg bg-rose-500 px-4 py-2 font-semibold text-slate-950">
                <IconStop /> Zakończ serię i pokaż raport
              </button>
            )}
            {(phase === "preview" || phase === "running" || phase === "loading") && (
              <button onClick={toggleFar} className="flex items-center gap-2 rounded-lg border border-emerald-500/60 px-3 py-2 text-sm text-emerald-300" data-testid="far-mode">
                <IconExpand /> Tryb z daleka (pełny ekran)
              </button>
            )}
            <button onClick={() => setVoice((v) => !v)} className="flex items-center gap-2 rounded-lg border border-slate-700 px-3 py-2 text-sm">
              {voice ? <IconVolume /> : <IconMute />} Głos {voice ? "włączony" : "wyłączony"}
            </button>
            <button
              onClick={() => {
                new BrowserSpeech("pl-PL").speak("Biodra w tył, plecy proste.", { interrupt: true });
              }}
              className="rounded-lg border border-slate-700 px-3 py-2 text-sm"
            >
              Test głosu
            </button>
          </div>
          <div className="mt-2 flex flex-wrap items-center gap-2" data-testid="camera-settings">
            {cameras.length > 0 ? (
              <select
                disabled={locked}
                value={deviceId}
                onChange={(e) => {
                  setDeviceId(e.target.value);
                  reopenIfPreviewing({ deviceId: e.target.value });
                }}
                className="max-w-xs rounded-lg border border-slate-700 bg-slate-900 px-3 py-2 text-sm"
                data-testid="camera-device"
              >
                <option value="">Kamera domyślna</option>
                {cameras.map((c, i) => (
                  <option key={c.deviceId} value={c.deviceId}>
                    {c.label || `Kamera ${i + 1}`}
                  </option>
                ))}
              </select>
            ) : (
              <select
                disabled={locked}
                value={facing}
                onChange={(e) => {
                  const f = e.target.value as "user" | "environment";
                  setFacing(f);
                  setMirror(f === "user");
                  reopenIfPreviewing({ facing: f });
                }}
                className="rounded-lg border border-slate-700 bg-slate-900 px-3 py-2 text-sm"
              >
                <option value="user">Kamera przednia / internetowa</option>
                <option value="environment">Kamera tylna</option>
              </select>
            )}
            <select
              disabled={locked}
              value={resolution}
              onChange={(e) => {
                const r = e.target.value as Resolution;
                setResolution(r);
                reopenIfPreviewing({ resolution: r });
              }}
              className="rounded-lg border border-slate-700 bg-slate-900 px-3 py-2 text-sm"
              data-testid="camera-resolution"
            >
              <option value="480">640x480 (słabszy komputer)</option>
              <option value="720">1280x720 (zalecane)</option>
              <option value="1080">1920x1080</option>
            </select>
            <label className="flex items-center gap-2 rounded-lg border border-slate-700 px-3 py-2 text-sm">
              <input type="checkbox" checked={mirror} onChange={(e) => setMirror(e.target.checked)} /> Lustrzane odbicie
            </label>
            <select disabled={locked} value={model} onChange={(e) => setModel(e.target.value as "lite" | "full")} className="rounded-lg border border-slate-700 bg-slate-900 px-3 py-2 text-sm">
              <option value="full">Model dokładny (full)</option>
              <option value="lite">Model szybki (lite)</option>
            </select>
          </div>
          {newTabUrl && (
            <p className="mt-3 rounded-lg border border-slate-700 bg-slate-900/60 px-3 py-2 text-sm text-slate-300">
              Strona jest otwarta w osadzonym oknie, które może blokować kamerę.{" "}
              <a href={newTabUrl} target="_blank" rel="noreferrer" className="font-semibold text-emerald-400 underline">
                Otwórz w nowej karcie
              </a>
            </p>
          )}
          {error && (
            <div className="mt-3 flex items-start gap-2 rounded-lg border border-red-500/50 bg-red-500/10 px-3 py-2 text-sm text-red-200">
              <IconAlert className="mt-0.5 shrink-0" /> {error}
            </div>
          )}
        </section>

        <aside className="space-y-4">
          {phase === "report" && report ? (
            <Report report={report} />
          ) : (
            <>
              <Panel title="Stan analizy">
                <Row k="Kalibracja" v={cal ? STATUS_LABEL[cal.status] ?? cal.status : "-"} />
                <Row k="Widok kamery" v={live ? `${VIEW_LABEL[live.view]} (${Math.round(live.viewConfidence * 100)}%)` : "-"} />
                <Row k="Faza ruchu" v={live?.phaseLabel ?? "-"} />
                <Row k="Średnia ocena serii" v={live?.setScore != null ? `${live.setScore} / 100` : "-"} />
                <Row k="Pewność analizy serii" v={live && live.setScore != null ? `${Math.round(live.setConfidence * 100)}%` : "-"} />
              </Panel>
              <Panel title="Powtórzenia">
                {repLog.length === 0 ? (
                  <p className="text-sm text-slate-400">Każde powtórzenie pojawi się tu z oceną i tym, co poprawić.</p>
                ) : (
                  <ul className="space-y-1.5" data-testid="rep-log">
                    {[...repLog].reverse().map((r) => (
                      <li key={r.index} className="flex items-start gap-2 text-sm">
                        <span className={`shrink-0 rounded px-1.5 py-0.5 font-bold tabular-nums ${scoreColor(r.score, r.incomplete)}`}>
                          #{r.index} {r.incomplete ? "-" : r.score ?? "?"}
                        </span>
                        <span className={r.issues.length ? "" : "text-emerald-300"}>
                          {r.issues.length ? r.issues.slice(0, 2).map((i) => i.correction).join(" ") : r.score === null ? "Bez oceny: za niska pewność analizy." : "Bez uwag."}
                        </span>
                      </li>
                    ))}
                  </ul>
                )}
              </Panel>
              <Panel title="Podpowiedzi">
                {cues.length === 0 ? (
                  <p className="text-sm text-slate-400">Brak. Podpowiedzi pojawią się podczas ruchu.</p>
                ) : (
                  <ul className="space-y-1.5">
                    {cues.map((c) => (
                      <li key={c.id} className={`rounded px-2 py-1 text-sm ${cueColor(c)}`}>{c.text}</li>
                    ))}
                  </ul>
                )}
              </Panel>
              <Panel title="Pomiary (bieżąca klatka)">
                {live?.keyMetrics.length ? (
                  live.keyMetrics.map((m) => <Row key={m.name} k={m.label} v={`${m.value}${m.unit === "deg" ? "°" : ""} (pewność ${Math.round(m.confidence * 100)}%)`} />)
                ) : (
                  <p className="text-sm text-slate-400">-</p>
                )}
              </Panel>
              <Panel title="Wydajność">
                <Row k="Kamera" v={camInfo ?? "-"} />
                <Row k="Model" v={stats ? `${model}, ${stats.delegate}, ${stats.mode === "worker" ? "Web Worker" : "wątek główny"}` : "-"} />
                <Row k="Analizowane klatki" v={stats ? `${stats.processedFps} / s` : "-"} />
                <Row k="Opóźnienie modelu" v={stats ? `${Math.round(stats.meanLatencyMs)} ms` : "-"} />
                <Row k="Silnik biomechaniki" v={live ? `${live.engineMs.toFixed(2)} ms` : "-"} />
              </Panel>
            </>
          )}
        </aside>
      </div>
    </main>
  );
}

const noopSubscribe = () => () => {};
const embeddedUrl = () => (window.self !== window.top ? window.location.href : null);

function cueColor(c: FeedbackItem): string {
  if (c.kind === "safety" || c.severity === "HIGH") return "bg-red-600 text-white";
  if (c.severity === "MODERATE") return "bg-orange-500 text-slate-950";
  if (c.severity === "LOW") return "bg-yellow-400 text-slate-950";
  if (c.kind === "setup") return "bg-amber-500/90 text-slate-950";
  return "bg-slate-700 text-slate-100";
}

function Panel({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="rounded-xl border border-slate-800 bg-slate-900/60 p-4">
      <h2 className="mb-2 text-sm font-semibold uppercase tracking-wide text-slate-400">{title}</h2>
      {children}
    </div>
  );
}

export function Row({ k, v }: { k: string; v: string }) {
  return (
    <div className="flex justify-between gap-3 py-0.5 text-sm">
      <span className="text-slate-400">{k}</span>
      <span className="text-right font-medium">{v}</span>
    </div>
  );
}
