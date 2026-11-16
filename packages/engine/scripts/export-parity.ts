/**
 * Writes parity fixtures for the Dart engine (packages/trainer_engine/test/fixtures):
 * input pose frames plus the TypeScript engine's results. The Dart tests replay the
 * frames and must reproduce the same repetitions, errors and cues.
 * Usage: npx tsx scripts/export-parity.ts
 */
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { EXERCISES, ExerciseAnalyzer, generateSyntheticDeadlift, generateSyntheticTopStart } from "../src";
import type { PoseFrame } from "../src/core/types";

const out = resolve(import.meta.dirname, "../../trainer_engine/test/fixtures");
mkdirSync(out, { recursive: true });
const r4 = (x: number) => Math.round(x * 10000) / 10000;

function quantize(frames: PoseFrame[]): PoseFrame[] {
  return frames.map((f) => ({
    ...f,
    timestamp: Math.round(f.timestamp),
    landmarks: Object.fromEntries(
      Object.entries(f.landmarks).map(([k, l]) => [k, { x: r4(l!.x), y: r4(l!.y), z: l!.z === undefined ? undefined : r4(l!.z), visibility: r4(l!.visibility), presence: l!.presence }]),
    ),
  })) as PoseFrame[];
}

function run(name: string, exerciseId: string, frames: PoseFrame[], embed: boolean, file?: string) {
  const a = new ExerciseAnalyzer({ exercise: EXERCISES[exerciseId]!, candidates: Object.values(EXERCISES) });
  const cues: { t: number; kind: string; key: string; voice: string | null }[] = [];
  for (const f of frames) {
    const s = a.processFrame(f);
    if (s.feedback) cues.push({ t: s.timestamp, kind: s.feedback.kind, key: s.feedback.errorType ?? s.feedback.text, voice: s.feedback.voice ?? null });
  }
  const rep = a.endSet();
  const expected = {
    repetitionCount: rep.repetitionCount,
    partialRepetitions: rep.partialRepetitions,
    averageTechniqueScore: rep.averageTechniqueScore,
    analysisConfidence: rep.analysisConfidence,
    detectedExercise: rep.recognition.detectedExercise,
    repetitions: rep.repetitions.map((r) => ({
      index: r.index,
      startTimestamp: r.startTimestamp,
      endTimestamp: r.endTimestamp,
      score: r.techniqueScore,
      confidence: r.analysisConfidence,
      incomplete: r.incomplete,
      errors: r.detectedErrors.map((e) => `${e.type}:${e.severity}`).sort(),
    })),
    cues,
  };
  writeFileSync(resolve(out, `${name}.json`), JSON.stringify({ name, exerciseId, file: file ?? null, frames: embed ? frames : null, expected }));
  console.log(name, rep.repetitionCount, rep.averageTechniqueScore, cues.length);
}

for (const fault of ["none", "hipRiseEarly", "backwardLean", "incompleteLockout", "fastLowering", "trunkChordLoss"] as const) {
  run(`deadlift_${fault}`, "conventional-deadlift", quantize(generateSyntheticDeadlift({ reps: 3, fault, seed: 7 }).frames), true);
}
run("deadlift_mirrored", "conventional-deadlift", quantize(generateSyntheticDeadlift({ reps: 2, mirrored: true, facing: -1, seed: 3 }).frames), true);
for (const [movement, id, fault] of [["squat", "back-squat", "none"], ["squat", "back-squat", "shallow"], ["romanian-deadlift", "romanian-deadlift", "none"], ["romanian-deadlift", "romanian-deadlift", "kneeBend"]] as const) {
  run(`${id}_${fault}`, id, quantize(generateSyntheticTopStart({ reps: 3, movement, fault, seed: 5 }).frames), true);
}
for (const f of ["deadlift_demo", "peso_muerto"]) {
  const path = `../engine/validation/real/${f}.landmarks.json`;
  const data = JSON.parse(readFileSync(resolve(import.meta.dirname, "../validation/real", `${f}.landmarks.json`), "utf8"));
  run(`real_${f}`, "conventional-deadlift", data.frames, false, path);
}
