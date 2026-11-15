// Copies the MediaPipe WASM runtime matching the installed @mediapipe/tasks-vision version and
// downloads the pose models into public/ (both are git-ignored). Runs before dev and build.
import { copyFileSync, existsSync, mkdirSync, readdirSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const pub = join(here, "..", "public");
const require = createRequire(import.meta.url);
const wasmSrc = join(dirname(require.resolve("@mediapipe/tasks-vision")), "wasm");
const wasmDst = join(pub, "mediapipe", "wasm");
mkdirSync(wasmDst, { recursive: true });
for (const f of readdirSync(wasmSrc)) copyFileSync(join(wasmSrc, f), join(wasmDst, f));

const models = join(pub, "models");
mkdirSync(models, { recursive: true });
for (const v of ["lite", "full"]) {
  const file = join(models, `pose_landmarker_${v}.task`);
  if (existsSync(file)) continue;
  const url = `https://storage.googleapis.com/mediapipe-models/pose_landmarker/pose_landmarker_${v}/float16/latest/pose_landmarker_${v}.task`;
  console.log(`downloading ${url}`);
  const res = await fetch(url);
  if (!res.ok) throw new Error(`model download failed: ${res.status} ${url}`);
  writeFileSync(file, Buffer.from(await res.arrayBuffer()));
}
