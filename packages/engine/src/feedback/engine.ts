import type { Severity, TechniqueError } from "../core/types";

export type FeedbackKind = "technique" | "setup" | "safety" | "rep" | "info";

export interface FeedbackItem {
  id: string;
  kind: FeedbackKind;
  /** Short on-screen text. */
  text: string;
  /** Even shorter phrase for text-to-speech; absent = do not speak. */
  voice?: string;
  severity?: Severity;
  errorType?: string;
  priority: number;
  timestamp: number;
}

export interface FeedbackOptions {
  /** Minimum gap between two spoken/primary cues. */
  globalCooldownMs: number;
  /** Minimum gap before the same cue is repeated. */
  repeatCooldownMs: number;
  /** Errors below this confidence are never surfaced live. */
  minConfidence: number;
  /** Max times one error type is voiced per set; afterwards it stays visual only. */
  maxVoicePerType: number;
  /** Visual cues stay on screen this long. */
  visualTtlMs: number;
  /** Pending cues older than this are dropped (no stale corrections). */
  maxAgeMs: number;
}

export const DEFAULT_FEEDBACK: FeedbackOptions = {
  globalCooldownMs: 2500,
  repeatCooldownMs: 9000,
  minConfidence: 0.4,
  maxVoicePerType: 3,
  visualTtlMs: 3500,
  maxAgeMs: 2500,
};

const SEVERITY_WEIGHT: Record<Severity, number> = { LOW: 1, MODERATE: 2, HIGH: 3.5 };

/**
 * Real-time feedback prioritisation: persistence checks, minimum confidence,
 * cooldowns and duplicate suppression. Produces at most one primary cue at a time.
 */
export class FeedbackEngine {
  private readonly opts: FeedbackOptions;
  private pending: FeedbackItem[] = [];
  private visual: FeedbackItem[] = [];
  private lastEmit = -Infinity;
  private lastByKey = new Map<string, number>();
  private voicedCount = new Map<string, number>();
  private occurrences = new Map<string, Set<number>>();
  private seq = 0;

  constructor(opts: Partial<FeedbackOptions> = {}) {
    this.opts = { ...DEFAULT_FEEDBACK, ...opts };
  }

  reset(): void {
    this.pending = [];
    this.visual = [];
    this.lastEmit = -Infinity;
    this.lastByKey.clear();
    this.voicedCount.clear();
    this.occurrences.clear();
  }

  /**
   * Offer a detected technique error. Returns true when it was queued.
   * `immediate` skips the persistence check: used for live checks and for the
   * main issue of a just-finished repetition, which the athlete must hear now.
   */
  offerError(err: TechniqueError, importance: number, t: number, immediate = false): boolean {
    if (err.confidence < this.opts.minConfidence) return false;
    const reps = this.occurrences.get(err.type) ?? new Set<number>();
    reps.add(err.repIndex ?? -1);
    this.occurrences.set(err.type, reps);
    // Persistence: minor issues must repeat across reps, moderate ones need either repetition or high confidence.
    const persistent =
      immediate || err.severity === "HIGH" || reps.size >= 2 || (err.severity === "MODERATE" && err.confidence >= 0.7);
    if (!persistent) return false;
    const repeatBoost = 1 + 0.25 * Math.min(4, reps.size - 1);
    this.queue({
      kind: "technique",
      text: err.correctiveFeedback,
      voice: err.voiceCue,
      severity: err.severity,
      errorType: err.type,
      priority: SEVERITY_WEIGHT[err.severity] * err.confidence * (0.5 + importance) * repeatBoost,
      timestamp: t,
    });
    return true;
  }

  /** Offer a system message (camera setup, rep counted, safety). */
  offerSystem(kind: FeedbackKind, text: string, t: number, opts: { voice?: string; priority?: number; key?: string } = {}): void {
    const base = kind === "safety" ? 20 : kind === "setup" ? 4 : kind === "rep" ? 0.5 : 1;
    this.queue({ kind, text, voice: opts.voice, priority: opts.priority ?? base, timestamp: t, errorType: opts.key ?? text });
  }

  /** Returns the cue to deliver now (if any) and the cues currently shown on screen. */
  tick(t: number): { emit: FeedbackItem | null; visual: FeedbackItem[] } {
    this.visual = this.visual.filter((v) => t - v.timestamp <= this.opts.visualTtlMs);
    this.pending = this.pending.filter((p) => t - p.timestamp <= this.opts.maxAgeMs);
    let emit: FeedbackItem | null = null;
    const safety = this.pending.find((p) => p.kind === "safety");
    if (this.pending.length && (safety || t - this.lastEmit >= this.opts.globalCooldownMs)) {
      this.pending.sort((a, b) => b.priority - a.priority);
      const next = safety ?? this.pending[0]!;
      this.pending = this.pending.filter((p) => p !== next);
      const key = next.errorType ?? next.text;
      const voiced = this.voicedCount.get(key) ?? 0;
      const item: FeedbackItem = { ...next, timestamp: t, voice: voiced < this.opts.maxVoicePerType ? next.voice : undefined };
      if (item.voice) this.voicedCount.set(key, voiced + 1);
      this.lastEmit = t;
      this.lastByKey.set(key, t);
      this.visual = [item, ...this.visual.filter((v) => (v.errorType ?? v.text) !== key)].slice(0, 3);
      emit = item;
    }
    return { emit, visual: this.visual };
  }

  private queue(item: Omit<FeedbackItem, "id">): void {
    const key = item.errorType ?? item.text;
    const last = this.lastByKey.get(key);
    if (item.kind !== "safety" && last !== undefined && item.timestamp - last < this.opts.repeatCooldownMs) return;
    const existing = this.pending.find((p) => (p.errorType ?? p.text) === key);
    if (existing) {
      existing.priority = Math.max(existing.priority, item.priority);
      existing.timestamp = item.timestamp;
      return;
    }
    this.pending.push({ ...item, id: `fb-${++this.seq}` });
  }
}
