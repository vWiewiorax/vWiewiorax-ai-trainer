"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { BrowserSpeech, ExerciseAnalyzer, deadlift, type FeedbackItem, type LiveState, type ReferenceModel, type TechniqueAnalysis } from "@trainer/engine";
import { LivePoseSource, openCamera, type LivePoseStats, type OpenCamera } from "@trainer/engine/browser";
import { drawOverlay } from "./overlay";
import { IconAlert, IconCamera, IconMute, IconStop, IconVolume } from "./icons";
import Report from "./Report";
import { REFERENCE_STORAGE_KEY } from "./referenceStorage";

type Phase = "idle" | "loading" | "running" | "report" | "error";

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

  const [phase, setPhase] = useState<Phase>("idle");
  const [error, setError] = useState<string | null>(null);
  const [facing, setFacing] = useState<"user" | "environment">("user");
  const [model, setModel] = useState<"lite" | "full">("full");
  const [voice, setVoice] = useState(true);
  const [live, setLive] = useState<LiveState | null>(null);
  const [stats, setStats] = useState<LivePoseStats | null>(null);
  const [cues, setCues] = useState<FeedbackItem[]>([]);
  const [report, setReport] = useState<TechniqueAnalysis | null>(null);

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
    }, 100);
    return () => clearInterval(id);
  }, [phase]);

  const start = async () => {
    setError(null);
    setReport(null);
    setCues([]);
    setPhase("loading");
    try {
      const video = videoRef.current!;
      const cam = await openCamera(video, { facing, width: 1280, height: 720, frameRate: 30 });
      cameraRef.current = cam;
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
      analyzerRef.current = new ExerciseAnalyzer({ exercise: deadlift, reference });
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
          if (s.feedback) {
            const item = s.feedback;
            if (item.voice) speechRef.current?.speak(item.voice, { interrupt: item.kind === "safety" });
            if (item.kind !== "rep") setCues((c) => (c[0]?.text === item.text ? c : [item, ...c.filter((x) => x.text !== item.text)].slice(0, 6)));
          }
        },
        onError: (m) => setError(m),
      });
      setPhase("running");
    } catch (e) {
      stopAll();
      setError(e instanceof Error ? e.message : String(e));
      setPhase("error");
    }
  };

  const endSet = () => {
    const analyzer = analyzerRef.current;
    stopAll();
    if (analyzer) {
      const r = analyzer.endSet();
      if (debugRef.current) (window as unknown as { __trainerReport?: unknown }).__trainerReport = r;
      setReport(r);
    }
    setPhase("report");
  };

  const mirrored = facing === "user";
  const cal = live?.calibration;
  const lastRep = live?.lastRepetition;

  return (
    <main className="min-h-screen bg-slate-950 text-slate-100">
      <header className="border-b border-slate-800 px-4 py-3 flex flex-wrap items-center gap-3">
        <h1 className="text-lg font-semibold">Analiza techniki na żywo - martwy ciąg klasyczny</h1>
        <span className="text-xs text-slate-400">Kamera i model działają lokalnie w przeglądarce. Obraz nie jest nigdzie wysyłany.</span>
      </header>

      <div className="grid gap-4 p-4 lg:grid-cols-[1fr_380px]">
        <section>
          <div className="relative w-full overflow-hidden rounded-xl bg-black aspect-video">
            <div className="absolute inset-0" style={{ transform: mirrored ? "scaleX(-1)" : undefined }}>
              <video ref={videoRef} className="h-full w-full object-contain" playsInline muted />
              <canvas ref={canvasRef} className="pointer-events-none absolute inset-0 h-full w-full object-contain" />
            </div>
            {phase === "running" && live && (
              <>
                <div className="absolute left-3 top-3 rounded-lg bg-black/70 px-3 py-2">
                  <div className="text-4xl font-bold tabular-nums">{live.repCount}</div>
                  <div className="text-xs text-slate-300">powtórzenia{live.partialReps ? ` (+${live.partialReps} niepełne)` : ""}</div>
                </div>
                <div className="absolute right-3 top-3 rounded-lg bg-black/70 px-3 py-2 text-right">
                  <div className="text-xs text-slate-300">Ostatnie powtórzenie</div>
                  <div className="text-3xl font-bold tabular-nums">{lastRep?.techniqueScore ?? "-"}</div>
                  <div className="text-xs text-slate-400">pewność analizy {lastRep ? Math.round(lastRep.analysisConfidence * 100) + "%" : "-"}</div>
                </div>
                {live.status !== "analysing" && cal && (
                  <div className="absolute inset-x-3 bottom-3 rounded-lg bg-amber-500/90 px-4 py-3 text-slate-950">
                    <div className="font-semibold">{STATUS_LABEL[cal.status] ?? cal.status}</div>
                    <div className="text-sm">{cal.guidance[0] ?? "Ustaw się tak, aby była widoczna cała sylwetka."}</div>
                    {cal.status === "CALIBRATING" && (
                      <div className="mt-2 h-1.5 w-full rounded bg-slate-950/20">
                        <div className="h-1.5 rounded bg-slate-950" style={{ width: `${Math.round(cal.progress * 100)}%` }} />
                      </div>
                    )}
                  </div>
                )}
                {live.status === "analysing" && live.visualCues[0] && (
                  <div className={`absolute inset-x-3 bottom-3 rounded-lg px-4 py-3 text-lg font-semibold ${cueColor(live.visualCues[0])}`}>{live.visualCues[0].text}</div>
                )}
                {live.stopSetRecommended && (
                  <div className="absolute inset-x-3 top-24 flex items-center gap-2 rounded-lg bg-red-600 px-4 py-3 font-semibold">
                    <IconAlert /> Zatrzymaj serię i odpocznij.
                  </div>
                )}
              </>
            )}
            {phase !== "running" && phase !== "report" && (
              <div className="absolute inset-0 flex flex-col items-center justify-center gap-3 p-6 text-center">
                <p className="max-w-md text-slate-300">
                  Ustaw telefon lub laptop bokiem do siebie, około 2,5-4 m od miejsca ćwiczenia, na wysokości bioder. Cała sylwetka razem ze stopami musi być w kadrze.
                </p>
                {phase === "loading" && <p className="text-sm text-slate-400">Uruchamiam kamerę i model pozy...</p>}
              </div>
            )}
          </div>

          <div className="mt-3 flex flex-wrap items-center gap-2">
            {phase !== "running" ? (
              <button onClick={start} disabled={phase === "loading"} className="flex items-center gap-2 rounded-lg bg-emerald-500 px-4 py-2 font-semibold text-slate-950 disabled:opacity-50">
                <IconCamera /> {phase === "report" ? "Nowa seria" : "Start kamery"}
              </button>
            ) : (
              <button onClick={endSet} className="flex items-center gap-2 rounded-lg bg-rose-500 px-4 py-2 font-semibold text-slate-950">
                <IconStop /> Zakończ serię i pokaż raport
              </button>
            )}
            <button onClick={() => setVoice((v) => !v)} className="flex items-center gap-2 rounded-lg border border-slate-700 px-3 py-2 text-sm">
              {voice ? <IconVolume /> : <IconMute />} Głos {voice ? "włączony" : "wyłączony"}
            </button>
            <select disabled={phase === "running" || phase === "loading"} value={facing} onChange={(e) => setFacing(e.target.value as "user" | "environment")} className="rounded-lg border border-slate-700 bg-slate-900 px-3 py-2 text-sm">
              <option value="user">Kamera przednia</option>
              <option value="environment">Kamera tylna</option>
            </select>
            <select disabled={phase === "running" || phase === "loading"} value={model} onChange={(e) => setModel(e.target.value as "lite" | "full")} className="rounded-lg border border-slate-700 bg-slate-900 px-3 py-2 text-sm">
              <option value="full">Model dokładny (full)</option>
              <option value="lite">Model szybki (lite)</option>
            </select>
          </div>
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
