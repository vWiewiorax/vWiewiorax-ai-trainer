import type { Measurement, PhaseDefinition, PhaseKind, PhaseSpan, RepetitionConfig } from "../core/types";

type State = "low" | "rising" | "high" | "falling";

export interface RepCycle {
  index: number;
  /** Movement start (leaving the start position). */
  startTimestamp: number;
  endTimestamp: number;
  durationMs: number;
  /** Includes a setup span before startTimestamp. */
  phases: PhaseSpan[];
  /** Reached the opposite position (full range). */
  complete: boolean;
  range: number;
  min: number;
  max: number;
  /** Time without a usable signal inside the cycle. */
  gapMs: number;
  counted: boolean;
}

export interface DetectorUpdate {
  phase: string | null;
  phaseKind: PhaseKind | null;
  repCount: number;
  /** True on the frame the counter increments. */
  countedNow: boolean;
  /** Cycle finalized on this frame (complete or partial). */
  finished: RepCycle | null;
  inRep: boolean;
}

const SETUP_WINDOW_MS = 700;
const SETTLE_MS = 350;
const MAX_GAP_MS = 400;

/**
 * Exercise-agnostic repetition state machine on a single driving signal with
 * hysteresis, minimum phase durations, minimum range and debounced counting.
 * States: low / rising / high / falling. A cycle starts when the signal leaves
 * the configured start position and ends after it returns and settles.
 */
export class RepetitionDetector {
  private state: State | null = null;
  private stateSince = 0;
  private extreme: { t: number; v: number } | null = null;
  private lastT: number | null = null;
  private lastValidT: number | null = null;
  private count = 0;
  private cycle: {
    start: number;
    setupStart: number;
    spans: { state: State; start: number; end: number }[];
    reachedOpposite: boolean;
    min: number;
    max: number;
    gapMs: number;
    counted: boolean;
    closingSince: number | null;
  } | null = null;
  private readonly kinds: Record<State, PhaseKind>;
  private readonly opposite: "low" | "high";

  constructor(private readonly cfg: RepetitionConfig, private readonly phaseDefs: PhaseDefinition[]) {
    this.opposite = cfg.startPosition === "low" ? "high" : "low";
    this.kinds =
      cfg.startPosition === "low"
        ? { low: "start", rising: "concentric", high: "end", falling: "eccentric" }
        : { high: "start", falling: "eccentric", low: "end", rising: "concentric" };
  }

  get repCount(): number {
    return this.count;
  }

  reset(): void {
    this.state = null;
    this.extreme = null;
    this.cycle = null;
    this.count = 0;
    this.lastT = null;
    this.lastValidT = null;
  }

  /** Drops the open cycle (scene cut, person change, long gap); completed repetitions are kept. */
  abort(): void {
    if (this.cycle?.counted) this.count--;
    this.cycle = null;
    this.state = null;
    this.extreme = null;
    this.lastValidT = null;
  }

  update(t: number, m: Measurement | null): DetectorUpdate {
    const dt = this.lastT === null ? 0 : t - this.lastT;
    this.lastT = t;
    let finished: RepCycle | null = null;
    let countedNow = false;

    if (!m || !Number.isFinite(m.value)) {
      if (this.cycle && this.lastValidT !== null && t - this.lastValidT > MAX_GAP_MS) this.cycle.gapMs += dt;
      return this.result(null, false);
    }
    this.lastValidT = t;
    const v = m.value;
    const { lowThreshold: lo, highThreshold: hi, hysteresis: h, minPhaseMs } = this.cfg;

    if (this.state === null) {
      if (v <= lo) this.enter("low", t, v);
      else if (v >= hi) this.enter("high", t, v);
      return this.result(null, false);
    }

    if (this.cycle) {
      this.cycle.min = Math.min(this.cycle.min, v);
      this.cycle.max = Math.max(this.cycle.max, v);
    }

    const elapsed = t - this.stateSince;
    switch (this.state) {
      case "low":
        this.trackExtreme(t, v, "min");
        if (v > lo + h) this.leavePosition("rising", t, v);
        break;
      case "high":
        this.trackExtreme(t, v, "max");
        if (v < hi - h) this.leavePosition("falling", t, v);
        break;
      case "rising":
        if (v >= hi && elapsed >= minPhaseMs) {
          this.transition("high", t, v);
        } else if (v <= lo) {
          this.transition("low", t, v);
        }
        break;
      case "falling":
        if (v <= lo && elapsed >= minPhaseMs) {
          this.transition("low", t, v);
        } else if (v >= hi) {
          this.transition("high", t, v);
        }
        break;
    }

    const c = this.cycle;
    if (c && this.state === this.opposite && !c.reachedOpposite) {
      c.reachedOpposite = true;
      if (this.cfg.countAt === this.opposite && t - c.start >= this.cfg.minRepMs * 0.4) {
        c.counted = true;
        this.count++;
        countedNow = true;
      }
    }

    // Closing: back in the start position; finalize after it settles.
    if (c && this.state === this.cfg.startPosition) {
      if (c.closingSince === null) c.closingSince = t;
      if (t - c.closingSince >= SETTLE_MS) {
        const r = this.finalize(this.extreme?.t ?? t);
        finished = r.cycle;
        countedNow = countedNow || r.countedNow;
      }
    }
    return { ...this.result(finished, countedNow) };
  }

  /** Phases of the currently open cycle up to `t` (for incremental evaluation). */
  snapshot(t: number): { startTimestamp: number; phases: PhaseSpan[] } | null {
    const c = this.cycle;
    if (!c) return null;
    const spans = [...c.spans];
    if (this.state) spans.push({ state: this.state, start: this.stateSince, end: t });
    return {
      startTimestamp: c.start,
      phases: [
        { id: this.phaseId(this.cfg.startPosition), kind: "start", startTimestamp: c.setupStart, endTimestamp: c.start },
        ...spans.filter((s) => s.end > s.start).map((s) => ({ id: this.phaseId(s.state), kind: this.kinds[s.state], startTimestamp: s.start, endTimestamp: s.end })),
      ],
    };
  }

  /** Finalize an open cycle, e.g. when the set ends at lockout. */
  flush(t: number): RepCycle | null {
    if (!this.cycle) return null;
    if (this.cfg.requireReturn && this.state !== this.cfg.startPosition) {
      if (this.cycle.counted) this.count--;
      this.cycle = null;
      return null;
    }
    return this.finalize(t).cycle;
  }

  private enter(state: State, t: number, v: number): void {
    this.state = state;
    this.stateSince = t;
    this.extreme = state === "low" || state === "high" ? { t, v } : null;
  }

  private trackExtreme(t: number, v: number, kind: "min" | "max"): void {
    const eps = this.cfg.hysteresis * 0.3;
    if (!this.extreme) {
      this.extreme = { t, v };
      return;
    }
    const better = kind === "min" ? v < this.extreme.v : v > this.extreme.v;
    const near = Math.abs(v - this.extreme.v) <= eps;
    if (better) this.extreme = { t, v };
    else if (near) this.extreme = { t, v: this.extreme.v };
  }

  /** Leave a position state; the boundary is the last time the signal was at its extreme. */
  private leavePosition(next: State, t: number, v: number): void {
    const boundary = this.extreme?.t ?? t;
    const from = this.state!;
    if (from === this.cfg.startPosition) {
      if (this.cycle) {
        // A new movement starts before the previous cycle settled.
        this.finalize(boundary);
      }
      this.cycle = {
        start: boundary,
        setupStart: Math.max(this.stateSince, boundary - SETUP_WINDOW_MS),
        spans: [],
        reachedOpposite: false,
        min: v,
        max: v,
        gapMs: 0,
        counted: false,
        closingSince: null,
      };
      this.cycle.min = Math.min(v, this.extreme?.v ?? v);
      this.cycle.max = Math.max(v, this.extreme?.v ?? v);
    } else if (this.cycle) {
      this.cycle.spans.push({ state: from, start: this.stateSince, end: boundary });
    }
    this.state = next;
    this.stateSince = boundary;
    this.extreme = null;
  }

  private transition(next: State, t: number, v: number): void {
    if (this.cycle) this.cycle.spans.push({ state: this.state!, start: this.stateSince, end: t });
    this.enter(next, t, v);
  }

  private finalize(end: number): { cycle: RepCycle | null; countedNow: boolean } {
    const c = this.cycle;
    this.cycle = null;
    if (!c) return { cycle: null, countedNow: false };
    if (this.state && this.state !== this.cfg.startPosition) {
      c.spans.push({ state: this.state, start: this.stateSince, end });
    } else if (this.state === this.cfg.startPosition && c.closingSince !== null) {
      // Return-to-start span ends at the settled extreme.
      c.spans.push({ state: this.state, start: this.stateSince, end: Math.max(this.stateSince, end) });
    }
    const range = c.max - c.min;
    const duration = end - c.start;
    if (range < this.cfg.minRange || duration < this.cfg.minRepMs * 0.5) {
      if (c.counted) this.count--;
      return { cycle: null, countedNow: false };
    }
    let countedNow = false;
    const complete = c.reachedOpposite && duration >= this.cfg.minRepMs;
    if (complete && !c.counted) {
      this.count++;
      c.counted = true;
      countedNow = true;
    }
    if (!complete && c.counted) {
      this.count--;
      c.counted = false;
    }
    const phases: PhaseSpan[] = [
      { id: this.phaseId(this.cfg.startPosition), kind: "start", startTimestamp: c.setupStart, endTimestamp: c.start },
      ...c.spans
        .filter((s) => s.end > s.start)
        .map((s, i, arr) => ({
          id: this.phaseId(s.state),
          // The trailing start-position span is the return to start.
          kind: s.state === this.cfg.startPosition && i === arr.length - 1 ? ("start" as const) : this.kinds[s.state],
          startTimestamp: s.start,
          endTimestamp: s.end,
        })),
    ];
    return {
      cycle: {
        index: 0,
        startTimestamp: c.start,
        endTimestamp: end,
        durationMs: duration,
        phases,
        complete,
        range,
        min: c.min,
        max: c.max,
        gapMs: c.gapMs,
        counted: c.counted,
      },
      countedNow,
    };
  }

  private phaseId(state: State): string {
    return this.cfg.phases[state];
  }

  private result(finished: RepCycle | null, countedNow: boolean): DetectorUpdate {
    const phase = this.state && (this.cycle || this.state === this.cfg.startPosition) ? this.cfg.phases[this.state] : null;
    return {
      phase,
      phaseKind: this.state ? this.kinds[this.state] : null,
      repCount: this.count,
      countedNow,
      finished,
      inRep: this.cycle !== null,
    };
  }

  phaseLabel(id: string): string {
    return this.phaseDefs.find((p) => p.id === id)?.label ?? id;
  }
}
