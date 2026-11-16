import type { BiomechanicalFrame, PhaseSpan, Stat } from "../core/types";

export interface Sample {
  t: number;
  v: number;
  c: number;
}

/** Frames inside a phase (or "rep") and an optional fractional window. */
export function selectSpan(
  phases: PhaseSpan[],
  phase: string,
  window?: [number, number],
  rep?: { start: number; end: number },
): { start: number; end: number } | null {
  let start: number;
  let end: number;
  if (phase === "rep") {
    if (!rep) return null;
    start = rep.start;
    end = rep.end;
  } else if (phase === "return") {
    // Trailing return to the start position (top of a squat / RDL), never the setup span.
    const last = phases[phases.length - 1];
    if (phases.length < 2 || !last || last.id !== phases[0]?.id) return null;
    start = last.startTimestamp;
    end = last.endTimestamp;
  } else {
    // The leading span is the setup; the trailing return to start shares its id but is not the setup.
    const spans = phases[0]?.id === phase ? [phases[0]] : phases.filter((p) => p.id === phase);
    if (spans.length === 0) return null;
    const s = spans.reduce((a, b) => (b.endTimestamp - b.startTimestamp > a.endTimestamp - a.startTimestamp ? b : a));
    if (spans[0] === phases[0] && s.endTimestamp <= s.startTimestamp) return null;
    start = s.startTimestamp;
    end = s.endTimestamp;
  }
  if (window) {
    const d = end - start;
    const s2 = start + d * window[0];
    end = start + d * window[1];
    start = s2;
  }
  return end >= start ? { start, end } : null;
}

export function samplesFor(frames: BiomechanicalFrame[], feature: string, span: { start: number; end: number }): {
  samples: Sample[];
  total: number;
} {
  let total = 0;
  const samples: Sample[] = [];
  for (const f of frames) {
    if (f.timestamp < span.start - 1 || f.timestamp > span.end + 1) continue;
    total++;
    const m = f.features[feature];
    if (m) samples.push({ t: f.timestamp, v: m.value, c: m.confidence });
  }
  return { samples, total };
}

export function computeStat(samples: Sample[], stat: Stat): { value: number; at: number } | null {
  if (samples.length === 0) return null;
  const first = samples[0]!;
  const last = samples[samples.length - 1]!;
  switch (stat) {
    case "min": {
      const s = samples.reduce((a, b) => (b.v < a.v ? b : a));
      return { value: s.v, at: s.t };
    }
    case "max": {
      const s = samples.reduce((a, b) => (b.v > a.v ? b : a));
      return { value: s.v, at: s.t };
    }
    case "mean":
      return { value: samples.reduce((a, b) => a + b.v, 0) / samples.length, at: (first.t + last.t) / 2 };
    case "range": {
      let lo = Infinity;
      let hi = -Infinity;
      for (const s of samples) {
        lo = Math.min(lo, s.v);
        hi = Math.max(hi, s.v);
      }
      return { value: hi - lo, at: (first.t + last.t) / 2 };
    }
    case "start":
      return { value: robustEdge(samples, true), at: first.t };
    case "end":
      return { value: robustEdge(samples, false), at: last.t };
    case "delta":
      return { value: robustEdge(samples, false) - robustEdge(samples, true), at: last.t };
  }
}

/** Mean of the first/last 3 samples to reduce single-frame noise. */
function robustEdge(samples: Sample[], start: boolean): number {
  const n = Math.min(3, samples.length);
  const part = start ? samples.slice(0, n) : samples.slice(samples.length - n);
  return part.reduce((a, b) => a + b.v, 0) / part.length;
}
