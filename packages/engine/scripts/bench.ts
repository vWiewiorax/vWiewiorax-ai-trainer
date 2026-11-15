/**
 * Engine latency benchmark (pose inference excluded unless recorded in a landmark file).
 *   npm run bench -w @trainer/engine
 * Pose-model latencies read from validation/real/*.landmarks.json were measured on the machine
 * that extracted them; they say nothing about other devices.
 */
import { readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { performance } from "node:perf_hooks";
import { ExerciseAnalyzer, deadlift, generateSyntheticDeadlift, type PoseFrame } from "../src";

function stats(xs: number[]) {
  const s = [...xs].sort((a, b) => a - b);
  const q = (p: number) => s[Math.min(s.length - 1, Math.floor(p * (s.length - 1)))] ?? NaN;
  return { n: s.length, mean: s.reduce((a, b) => a + b, 0) / Math.max(1, s.length), p50: q(0.5), p95: q(0.95), max: s[s.length - 1] ?? NaN };
}
const fmt = (o: ReturnType<typeof stats>) => `n=${o.n} mean=${o.mean.toFixed(3)}ms p50=${o.p50.toFixed(3)}ms p95=${o.p95.toFixed(3)}ms max=${o.max.toFixed(3)}ms`;

function bench(name: string, frames: PoseFrame[], rounds = 5) {
  const per: number[] = [];
  let endSet = 0;
  for (let r = 0; r < rounds; r++) {
    const a = new ExerciseAnalyzer({ exercise: deadlift });
    for (const f of frames) {
      const t0 = performance.now();
      a.processFrame(f);
      per.push(performance.now() - t0);
    }
    const t0 = performance.now();
    a.endSet();
    endSet += performance.now() - t0;
  }
  console.log(`${name}: processFrame ${fmt(stats(per.slice(frames.length)))} | endSet mean=${(endSet / rounds).toFixed(2)}ms`);
}

bench("SYNTHETIC 10 reps @30fps", generateSyntheticDeadlift({ reps: 10 }).frames);
bench("SYNTHETIC 10 reps @60fps", generateSyntheticDeadlift({ reps: 10, fps: 60 }).frames);

const dir = join(dirname(fileURLToPath(import.meta.url)), "..", "validation", "real");
for (const file of readdirSync(dir).filter((f) => f.endsWith(".landmarks.json"))) {
  const { frames } = JSON.parse(readFileSync(join(dir, file), "utf8")) as { frames: PoseFrame[] };
  bench(`real ${file}`, frames, 3);
  const inf = frames.map((f) => f.inferenceMs).filter((x): x is number => typeof x === "number");
  if (inf.length) console.log(`  recorded pose inference (extraction machine): ${fmt(stats(inf))}`);
}
