"use client";

import { useCallback, useRef, useState } from "react";
import {
  ExerciseAnalyzer,
  buildReferenceModel,
  EXERCISES,
  deadlift,
  type PoseFrame,
  type ReferenceModel,
  type TechniqueAnalysis,
} from "@trainer/engine";
import { MediaPipePoseEstimator } from "@trainer/engine/mediapipe";
import { extractPoseFromVideo, loadVideo } from "@trainer/engine/browser";
import { IconCheck, IconDownload, IconRefresh } from "./icons";
import Report from "./Report";
import { REFERENCE_STORAGE_KEY } from "./referenceStorage";
import { ExerciseSelect } from "./ExerciseSelect";


type Phase = "idle" | "processing" | "done" | "error";

function download(name: string, data: unknown) {
  const url = URL.createObjectURL(new Blob([JSON.stringify(data)], { type: "application/json" }));
  const a = document.createElement("a");
  a.href = url;
  a.download = name;
  a.click();
  URL.revokeObjectURL(url);
}

export default function VideoAnalysis() {
  const videoRef = useRef<HTMLVideoElement>(null);
  const framesRef = useRef<PoseFrame[]>([]);
  const [phase, setPhase] = useState<Phase>("idle");
  const [exerciseId, setExerciseId] = useState(deadlift.id);
  const exercise = EXERCISES[exerciseId] ?? deadlift;
  const [fileName, setFileName] = useState("");
  const [progress, setProgress] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const [report, setReport] = useState<TechniqueAnalysis | null>(null);
  const [reference, setReference] = useState<ReferenceModel | null>(null);
  const [saved, setSaved] = useState(false);
  const [model, setModel] = useState<"full" | "lite">("full");

  const onFile = useCallback(
    async (file: File) => {
      const video = videoRef.current;
      if (!video) return;
      setPhase("processing");
      setFileName(file.name);
      setProgress(0);
      setError(null);
      setReport(null);
      setReference(null);
      setSaved(false);
      const url = URL.createObjectURL(file);
      let estimator: MediaPipePoseEstimator | null = null;
      try {
        await loadVideo(video, url);
        const origin = window.location.origin;
        estimator = await MediaPipePoseEstimator.create({
          wasmBaseUrl: `${origin}/mediapipe/wasm`,
          modelUrl: `${origin}/models/pose_landmarker_${model}.task`,
          delegate: "auto",
        });
        const frames = await extractPoseFromVideo(video, estimator, { fps: 30, onProgress: (d, t) => setProgress(t ? d / t : 0) });
        framesRef.current = frames;
        const analyzer = new ExerciseAnalyzer({ exercise });
        for (const f of frames) analyzer.processFrame(f);
        const r = analyzer.endSet();
        const ref = buildReferenceModel(exercise, r.repetitions, file.name);
        setReport(r);
        setReference(ref);
        setPhase("done");
        if (new URLSearchParams(window.location.search).has("debug")) {
          (window as unknown as { __trainerExtract?: unknown }).__trainerExtract = { file: file.name, frames, report: r, reference: ref };
        }
      } catch (e) {
        setError(e instanceof Error ? e.message : String(e));
        setPhase("error");
      } finally {
        estimator?.close();
        URL.revokeObjectURL(url);
      }
    },
    [model, exercise],
  );

  const saveReference = () => {
    if (!reference) return;
    localStorage.setItem(REFERENCE_STORAGE_KEY, JSON.stringify(reference));
    setSaved(true);
  };

  return (
    <main className="min-h-screen bg-slate-950 text-slate-100">
      <header className="border-b border-slate-800 px-4 py-3 flex flex-wrap items-center gap-3">
        <h1 className="text-lg font-semibold">Analiza nagrania - {exercise.name.toLowerCase()}</h1>
        <ExerciseSelect value={exerciseId} onChange={setExerciseId} disabled={phase === "processing"} />
        <span className="text-xs text-slate-400">Ten sam model i silnik co analiza na żywo. Plik jest przetwarzany lokalnie w przeglądarce.</span>
      </header>

      <div className="grid gap-4 p-4 lg:grid-cols-[1fr_380px]">
        <section className="space-y-3">
          <div className="relative w-full overflow-hidden rounded-xl bg-black aspect-video">
            <video ref={videoRef} className="h-full w-full object-contain" playsInline muted />
            {phase === "processing" && (
              <div className="absolute inset-x-3 bottom-3 rounded-lg bg-black/75 px-4 py-3">
                <div className="text-sm">Analiza klatek: {Math.round(progress * 100)}%</div>
                <div className="mt-2 h-1.5 w-full rounded bg-slate-700">
                  <div className="h-1.5 rounded bg-emerald-400" style={{ width: `${Math.round(progress * 100)}%` }} />
                </div>
              </div>
            )}
          </div>
          <div className="flex flex-wrap items-center gap-3">
            <label className="inline-flex cursor-pointer items-center gap-2 rounded-lg bg-emerald-500 px-4 py-2 font-semibold text-slate-950 hover:bg-emerald-400">
              <IconRefresh className="h-4 w-4" />
              Wybierz nagranie
              <input
                type="file"
                accept="video/*"
                className="hidden"
                data-testid="video-file"
                disabled={phase === "processing"}
                onChange={(e) => {
                  const f = e.target.files?.[0];
                  if (f) void onFile(f);
                  e.target.value = "";
                }}
              />
            </label>
            <select
              className="rounded-lg border border-slate-700 bg-slate-900 px-3 py-2 text-sm"
              value={model}
              disabled={phase === "processing"}
              onChange={(e) => setModel(e.target.value as "full" | "lite")}
            >
              <option value="full">Model dokładny (full)</option>
              <option value="lite">Model szybki (lite)</option>
            </select>
            {fileName && <span className="text-sm text-slate-400">{fileName}</span>}
          </div>
          <p className="text-sm text-slate-400">
            Nagranie z boku, cała sylwetka w kadrze. Wzorzec trenera to dodatkowa wskazówka, a nie jedyna poprawna technika: różnice wynikające z budowy ciała
            lub stylu nie są automatycznie traktowane jako błąd.
          </p>
          {error && <p className="rounded-lg bg-red-500/15 px-3 py-2 text-sm text-red-300">{error}</p>}
        </section>

        <aside className="space-y-4">
          {phase === "done" && (
            <div className="rounded-xl border border-slate-800 bg-slate-900/60 p-4 space-y-3">
              <h2 className="text-sm font-semibold uppercase tracking-wide text-slate-400">Wzorzec ruchu</h2>
              {reference ? (
                <p className="text-sm">Wzorzec z {reference.repetitions} powtórzeń. Analiza na żywo porówna z nim każde powtórzenie (tor, zakres ruchu, tempo).</p>
              ) : (
                <p className="text-sm text-amber-300">Za mało wiarygodnych powtórzeń, żeby zbudować wzorzec.</p>
              )}
              <div className="flex flex-wrap gap-2">
                <button
                  type="button"
                  disabled={!reference}
                  onClick={saveReference}
                  className="inline-flex items-center gap-2 rounded-lg bg-slate-800 px-3 py-2 text-sm hover:bg-slate-700 disabled:opacity-40"
                >
                  <IconCheck className="h-4 w-4" />
                  {saved ? "Zapisano jako wzorzec" : "Użyj jako wzorzec"}
                </button>
                <button
                  type="button"
                  disabled={!reference}
                  onClick={() => reference && download("wzorzec-martwy-ciag.json", reference)}
                  className="inline-flex items-center gap-2 rounded-lg bg-slate-800 px-3 py-2 text-sm hover:bg-slate-700 disabled:opacity-40"
                >
                  <IconDownload className="h-4 w-4" />
                  Pobierz wzorzec
                </button>
                <button
                  type="button"
                  onClick={() => download(`${fileName || "nagranie"}.landmarks.json`, { source: fileName, frames: framesRef.current })}
                  className="inline-flex items-center gap-2 rounded-lg bg-slate-800 px-3 py-2 text-sm hover:bg-slate-700"
                >
                  <IconDownload className="h-4 w-4" />
                  Punkty ciała (JSON)
                </button>
              </div>
            </div>
          )}
          {report && <Report report={report} />}
        </aside>
      </div>
    </main>
  );
}
