# @trainer/engine - exercise technique analysis engine

TypeScript engine that turns pose landmarks into repetitions, technique errors, scores and short
coaching cues. The core has no React or DOM dependency; browser and MediaPipe code lives in
adapters. Demo: `apps/web` -> `/lab` (live camera) and `/lab/reference` (recorded video / trainer reference).

## Pipeline

```
camera / video            adapters/browser (openCamera, LivePoseSource, AdaptiveScheduler, extractPoseFromVideo)
  -> pose estimation      adapters/mediapipe (MediaPipePoseEstimator, Web Worker, GPU -> CPU fallback)
  -> PoseFrame            core/types (model-independent landmark set, visibility, timestamps, camera metadata)
  -> normalization        camera/normalize (aspect, mirroring, rotation)
  -> filtering            filtering (confidence gate, outlier rejection, short hold, One Euro smoothing)
  -> view + calibration   camera/view, camera/calibration (NOT_STARTED ... READY / INSUFFICIENT_VISIBILITY / INCORRECT_CAMERA_ANGLE)
  -> features             features (joint angles, inclinations, body-relative heights, velocities, confidence per value)
  -> recognition          recognition (deterministic, expected-exercise check, alternatives, no forced label)
  -> phases + reps        reps/detector (hysteresis state machine, min durations, min range, onset refinement)
  -> rules                evaluation (per-phase rules from the exercise definition, confidence-aware)
  -> scoring              scoring (0-100 per rep, weights re-normalised over measured categories, separate confidence)
  -> feedback             feedback (priority, cooldown, duplicate suppression, TTS adapter)
  -> report               analysis/analyzer (LiveState per frame, TechniqueAnalysis per set)
```

`ExerciseAnalyzer` (analysis/analyzer.ts) wires the stages; every stage is a separate module with its own
types and can be tested alone.

## Pose model choice

MediaPipe Pose Landmarker (BlazePose, 33 points) is used first: it runs in browsers (WASM + WebGL/GPU)
and has native Android/iOS SDKs, gives per-point visibility, includes heels and toes (needed for
deadlift/squat), and has lite/full/heavy variants. MoveNet has only 17 points (no feet) and no
visibility for occlusion handling. A new model only needs an adapter that returns a `PoseFrame`.

## Usage

```ts
import { ExerciseAnalyzer, deadlift } from "@trainer/engine";

const analyzer = new ExerciseAnalyzer({ exercise: deadlift, reference: null, profile: null });
const live = analyzer.processFrame(poseFrame); // LiveState: calibration, phase, reps, cue, errors
const report = analyzer.endSet();             // TechniqueAnalysis
```

Browser (Next.js, client component):

```ts
import { LivePoseSource, openCamera } from "@trainer/engine/browser";
const cam = await openCamera(video, { facing: "user" });
const source = await LivePoseSource.start({
  video, facing: cam.facing,
  estimator: { wasmBaseUrl: "/mediapipe/wasm", modelUrl: "/models/pose_landmarker_full.task", delegate: "auto" },
  createWorker: () => new Worker(new URL("./pose.worker.ts", import.meta.url), { type: "module" }),
  onFrame: (frame) => render(analyzer.processFrame(frame)),
});
```

The worker file is one line: `installPoseWorker(self)` from `@trainer/engine/mediapipe`. Model and WASM
files are served from `apps/web/public`.

React Native / Expo: use a native pose plugin (e.g. MediaPipe Tasks on Android/iOS through a frame
processor), map its 33 landmarks with `fromMediaPipe()` into `PoseFrame`, and call the same
`ExerciseAnalyzer`. Speech goes through the `SpeechOutput` interface (expo-speech instead of
`BrowserSpeech`). Nothing in the core imports DOM APIs.

## Adding an exercise

Create an `ExerciseDefinition` (see exercises/deadlift.ts): camera views, required and occludable
landmarks, repetition signal and thresholds, phases, rules (feature, phase, statistic, threshold,
severity bands, importance, category, messages) and scoring weights. Features are shared through
features/registry.ts; no exercise-specific code is needed in the pipeline.

## Validation and benchmarks

- `npm test` - unit and integration tests. Integration tests use SYNTHETIC landmark sequences
  (validation/synthetic.ts) and only verify code logic.
- `npm run validate` - runs annotated real landmark sequences (validation/annotations.json,
  validation/real) and the synthetic fault suite; writes validation/RESULTS.md.
- `npm run bench` - engine latency per frame; pose latency recorded in landmark files.
- New real data: open `/lab/reference`, analyse a video, download "Punkty ciała (JSON)", put it in
  validation/real and add an annotation entry (format: `DatasetAnnotation` in validation/dataset.ts).

## Known limitations

- Single 2D camera: no true 3D joint angles. Side-view angles are projected and change with camera
  yaw; spine neutrality cannot be measured. The trunk "chord" rule is a proxy and says so.
- The bar is not detected. Wrist/hand position is used as a proxy for bar path.
- Plates hide the shins in side view; knees/ankles are accepted at low visibility and their low
  confidence lowers the confidence of every metric that uses them.
- Real-world accuracy is not established. The real dataset is three clips labelled by a non-expert;
  expert-labelled recordings of many lifters are required before quoting precision/recall.
- If a set ends while the lifter is still standing at lockout, that last movement is not counted
  (it cannot be told apart from standing up without the bar).
- In the SYNTHETIC hip-rise sequences the hand proxy also triggers "bar away from body" (the stick
  figure has no bar; hands hang under the shoulders). On real lifts this rule needs checking first.
- Implemented: conventional deadlift, Romanian deadlift, barbell back squat. RDL and squat are verified only on SYNTHETIC sequences (test/topstart.test.ts); no real labelled video yet. Other exercises need definitions and validation.
- Not a medical device: no injury diagnosis, no guarantee that a movement is safe.
