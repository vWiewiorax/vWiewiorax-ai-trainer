import { SKELETON_CONNECTIONS, type LiveState, type NormalizedPose, type Severity } from "@trainer/engine";

const SEVERITY_COLOR: Record<Severity, string> = { LOW: "#facc15", MODERATE: "#fb923c", HIGH: "#ef4444" };

/** Draws the filtered skeleton and the hip/shoulder/wrist trails. Canvas is in video pixel space, unmirrored. */
export function drawOverlay(ctx: CanvasRenderingContext2D, state: LiveState, trail: { x: number; y: number }[][]): void {
  const { width: w, height: h } = ctx.canvas;
  ctx.clearRect(0, 0, w, h);
  const px = (p: { x: number; y: number }) => [(p.x / state.aspect) * w, p.y * h] as const;
  const pose: NormalizedPose = state.pose;
  const err = state.currentErrors[0];
  const lineColor = state.status === "analysing" ? (err ? SEVERITY_COLOR[err.severity] : "#22c55e") : "#94a3b8";
  const lw = Math.max(2, w / 320);

  const trailColors = ["rgba(56,189,248,0.8)", "rgba(168,85,247,0.8)", "rgba(250,204,21,0.8)"];
  trail.forEach((pts, i) => {
    if (pts.length < 2) return;
    ctx.strokeStyle = trailColors[i] ?? "white";
    ctx.lineWidth = lw * 0.8;
    ctx.beginPath();
    pts.forEach((p, k) => {
      const [x, y] = px(p);
      if (k === 0) ctx.moveTo(x, y);
      else ctx.lineTo(x, y);
    });
    ctx.stroke();
  });

  ctx.lineWidth = lw * 1.5;
  ctx.lineCap = "round";
  for (const [a, b] of SKELETON_CONNECTIONS) {
    const pa = pose[a];
    const pb = pose[b];
    if (!pa || !pb) continue;
    const c = Math.min(pa.confidence, pb.confidence);
    ctx.globalAlpha = c < 0.5 ? 0.3 : 1;
    ctx.strokeStyle = lineColor;
    ctx.beginPath();
    ctx.moveTo(...px(pa));
    ctx.lineTo(...px(pb));
    ctx.stroke();
  }
  for (const p of Object.values(pose)) {
    if (!p) continue;
    ctx.globalAlpha = p.confidence < 0.5 ? 0.35 : 1;
    ctx.fillStyle = p.confidence < 0.5 ? "#94a3b8" : "#ffffff";
    const [x, y] = px(p);
    ctx.beginPath();
    ctx.arc(x, y, lw * 2, 0, Math.PI * 2);
    ctx.fill();
  }
  ctx.globalAlpha = 1;
}
