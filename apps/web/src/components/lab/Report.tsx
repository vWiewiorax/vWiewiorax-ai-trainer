"use client";

import type { Severity, TechniqueAnalysis } from "@trainer/engine";
import { IconAlert, IconCheck, IconDownload } from "./icons";
import { Row } from "./LiveLab";

const SEV: Record<Severity, { label: string; cls: string }> = {
  LOW: { label: "niski", cls: "bg-yellow-400 text-slate-950" },
  MODERATE: { label: "umiarkowany", cls: "bg-orange-500 text-slate-950" },
  HIGH: { label: "wysoki", cls: "bg-red-600 text-white" },
};

export default function Report({ report: r }: { report: TechniqueAnalysis }) {
  const download = () => {
    const blob = new Blob([JSON.stringify(r, null, 2)], { type: "application/json" });
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = `raport-${r.exerciseId}-${new Date().toISOString().slice(0, 19).replace(/[:T]/g, "-")}.json`;
    a.click();
    URL.revokeObjectURL(a.href);
  };
  const sec = (ms: number | null) => (ms == null ? "-" : `${(ms / 1000).toFixed(1)} s`);

  return (
    <div className="space-y-4">
      <div className="rounded-xl border border-slate-800 bg-slate-900/60 p-4">
        <h2 className="mb-3 text-sm font-semibold uppercase tracking-wide text-slate-400">Raport po serii</h2>
        <div className="grid grid-cols-3 gap-2 text-center">
          <Stat label="Powtórzenia" value={`${r.repetitionCount}`} sub={r.partialRepetitions ? `+${r.partialRepetitions} niepełne` : undefined} />
          <Stat label="Ocena techniki" value={r.averageTechniqueScore != null ? `${r.averageTechniqueScore}` : "-"} sub="na 100" />
          <Stat label="Pewność analizy" value={`${Math.round(r.analysisConfidence * 100)}%`} />
        </div>
        <div className="mt-3">
          <Row k="Powtarzalność" v={r.consistency != null ? `${r.consistency} / 100` : "-"} />
          <Row k="Najlepsze / najsłabsze" v={r.bestRepetition ? `#${r.bestRepetition} / #${r.worstRepetition}` : "-"} />
          <Row k="Średnie tempo: podnoszenie" v={sec(r.tempo.meanConcentricMs)} />
          <Row k="Średnie tempo: opuszczanie" v={sec(r.tempo.meanEccentricMs)} />
        </div>
      </div>

      <div className="rounded-xl border border-slate-800 bg-slate-900/60 p-4">
        <h3 className="mb-2 text-sm font-semibold uppercase tracking-wide text-slate-400">Wykryte problemy</h3>
        {r.detectedErrors.length === 0 ? (
          <p className="flex items-center gap-2 text-sm text-emerald-300">
            <IconCheck /> Nie wykryto błędów w ocenianych elementach.
          </p>
        ) : (
          <ul className="space-y-2">
            {r.detectedErrors.map((e) => (
              <li key={e.type} className="rounded-lg border border-slate-800 p-2 text-sm">
                <div className="flex items-center justify-between gap-2">
                  <span className="font-semibold">{e.label}</span>
                  <span className={`rounded px-1.5 py-0.5 text-xs ${SEV[e.maxSeverity].cls}`}>{SEV[e.maxSeverity].label}</span>
                </div>
                <div className="text-xs text-slate-400">
                  powtórzenia: {e.repIndices.map((i) => `#${i}`).join(", ")} - pewność {Math.round(e.meanConfidence * 100)}%
                </div>
                <div className="mt-1">{e.correction}</div>
              </li>
            ))}
          </ul>
        )}
      </div>

      <div className="rounded-xl border border-slate-800 bg-slate-900/60 p-4">
        <h3 className="mb-2 text-sm font-semibold uppercase tracking-wide text-slate-400">Powtórzenia</h3>
        <table className="w-full text-sm">
          <thead className="text-xs text-slate-400">
            <tr>
              <th className="text-left">#</th>
              <th className="text-right">Ocena</th>
              <th className="text-right">Pewność</th>
              <th className="text-right">Czas</th>
              <th className="text-right">Błędy</th>
            </tr>
          </thead>
          <tbody>
            {r.repetitions.map((rep) => (
              <tr key={rep.id} className="border-t border-slate-800">
                <td>{rep.index}{rep.incomplete ? " (niepełne)" : ""}</td>
                <td className="text-right tabular-nums">{rep.techniqueScore ?? "-"}{rep.breakdown.scoreUncertainty ? ` ±${rep.breakdown.scoreUncertainty}` : ""}</td>
                <td className="text-right tabular-nums">{Math.round(rep.analysisConfidence * 100)}%</td>
                <td className="text-right tabular-nums">{sec(rep.durationMs)}</td>
                <td className="text-right tabular-nums">{rep.detectedErrors.length}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <div className="rounded-xl border border-slate-800 bg-slate-900/60 p-4">
        <h3 className="mb-2 text-sm font-semibold uppercase tracking-wide text-slate-400">Zalecenia</h3>
        <ul className="list-disc space-y-1 pl-5 text-sm">
          {r.recommendations.map((t, i) => (
            <li key={i}>{t}</li>
          ))}
        </ul>
      </div>

      <div className="rounded-xl border border-slate-800 bg-slate-900/60 p-4 text-sm">
        <h3 className="mb-2 text-sm font-semibold uppercase tracking-wide text-slate-400">Jakość obrazu i wydajność</h3>
        <Row k="Dominujący widok" v={`${r.cameraQuality.view} (${Math.round(r.cameraQuality.viewConfidence * 100)}%)`} />
        <Row k="Średnia widoczność punktów" v={`${Math.round(r.cameraQuality.meanVisibility * 100)}%`} />
        <Row k="Klatki użyte do analizy" v={`${Math.round(r.cameraQuality.usableFrameRatio * 100)}%`} />
        <Row k="Analizowane klatki / s" v={`${r.processingMetrics.effectiveFps}`} />
        <Row k="Model pozy (średnio)" v={r.processingMetrics.meanInferenceMs != null ? `${r.processingMetrics.meanInferenceMs} ms` : "-"} />
        <Row k="Silnik (średnio / p95)" v={`${r.processingMetrics.meanEngineMs} / ${r.processingMetrics.p95EngineMs} ms`} />
      </div>

      <div className="space-y-1 rounded-xl border border-amber-500/40 bg-amber-500/10 p-4 text-xs text-amber-100">
        {r.safetyNotes.map((n, i) => (
          <p key={i} className="flex gap-2">
            <IconAlert className="mt-0.5 shrink-0" width={14} height={14} /> {n}
          </p>
        ))}
      </div>

      <button onClick={download} className="flex items-center gap-2 rounded-lg border border-slate-700 px-3 py-2 text-sm">
        <IconDownload /> Pobierz pełny raport (JSON)
      </button>
    </div>
  );
}

function Stat({ label, value, sub }: { label: string; value: string; sub?: string }) {
  return (
    <div className="rounded-lg bg-slate-800/60 p-2">
      <div className="text-2xl font-bold tabular-nums">{value}</div>
      <div className="text-xs text-slate-400">{label}</div>
      {sub && <div className="text-[10px] text-slate-500">{sub}</div>}
    </div>
  );
}
