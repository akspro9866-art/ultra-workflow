import { promises as fs } from "node:fs";
import path from "node:path";
import type { SceneSpecT, UltraProjectT } from "../core/schema.js";
import { auditDraft, type QuantitativeMetrics } from "./metrics.js";
import { lintProject } from "../core/orchestrator.js";
import { loadStylePack } from "../core/raw-probe.js";
import { extractFrameAt } from "../core/probe.js";
import { runBinary } from "../core/ffmpeg.js";
import { renderHtmlToPng } from "../core/browser.js";
import { ensureDir, formatTimestamp, rmrf, round } from "../core/util.js";
import type { StylePackT } from "../core/style-schema.js";

/** Average nearest-colour distance (0–441 RGB) allowed before the palette fails. */
export const STYLE_PALETTE_MAX_DISTANCE = 110;
const LOUDNESS_TOLERANCE = 1.5;

export interface StyleCompliance {
  aslOk: boolean;
  staticHoldOk: boolean;
  transitionsOk: boolean;
  paletteOk: boolean;
  loudnessOk: boolean;
  paletteDistanceAvg: number;
  details: string[];
  pass: boolean;
}

export interface StyleVerifyResult {
  style: StylePackT;
  slug: string;
  metrics: QuantitativeMetrics;
  lint: Awaited<ReturnType<typeof lintProject>>;
  compliance: StyleCompliance;
  matchSheet: string | null;
  pass: boolean;
}

function hexToRgb(hex: string): [number, number, number] {
  let h = hex.replace("#", "").trim().toLowerCase();
  if (h.length === 3) h = h.split("").map((c) => c + c).join("");
  if (h.length === 8) h = h.slice(0, 6);
  return [parseInt(h.slice(0, 2), 16), parseInt(h.slice(2, 4), 16), parseInt(h.slice(4, 6), 16)];
}

function colourDistance(a: string, b: string): number {
  const [r1, g1, b1] = hexToRgb(a);
  const [r2, g2, b2] = hexToRgb(b);
  return Math.sqrt((r1 - r2) ** 2 + (g1 - g2) ** 2 + (b1 - b2) ** 2);
}

async function sampleDraftPalette(draftFile: string): Promise<{ hex: string; share: number }[]> {
  const width = 96;
  const height = 54;
  let buffer: Buffer<ArrayBufferLike> = Buffer.alloc(0);
  try {
    const result = await runBinary("ffmpeg", [
      "-v",
      "error",
      "-i",
      draftFile,
      "-vf",
      `fps=3,scale=${width}:${height}:flags=area`,
      "-f",
      "rawvideo",
      "-pix_fmt",
      "rgb24",
      "-",
    ]);
    if (result.code === 0) buffer = result.stdout;
  } catch {
    // fall through
  }
  const frameBytes = width * height * 3;
  const frames = Math.floor(buffer.length / frameBytes);
  const buckets = new Map<string, number>();
  let total = 0;
  const bucket = (v: number) => Math.max(0, Math.min(255, Math.round(v / 24) * 24));
  for (let f = 0; f < frames; f += 1) {
    const base = f * frameBytes;
    for (let p = 0; p < width * height; p += 1) {
      const o = base + p * 3;
      const key = `#${[bucket(buffer[o] as number), bucket(buffer[o + 1] as number), bucket(buffer[o + 2] as number)]
        .map((v) => v.toString(16).padStart(2, "0"))
        .join("")}`;
      buckets.set(key, (buckets.get(key) ?? 0) + 1);
      total += 1;
    }
  }
  return [...buckets.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, 24)
    .map(([hex, count]) => ({ hex, share: total > 0 ? round(count / total, 4) : 0 }));
}

function classifyScenes(project: UltraProjectT, style: StylePackT): {
  hook: SceneSpecT[];
  body: SceneSpecT[];
  outro: SceneSpecT[];
} {
  const duration = project.meta.durationSec;
  const outroStart = duration * 0.8;
  const hook: SceneSpecT[] = [];
  const body: SceneSpecT[] = [];
  const outro: SceneSpecT[] = [];
  const scenes = project.scenes.filter((s) => !s.overlayOfSceneId).sort((a, b) => a.startSec - b.startSec);
  for (const scene of scenes) {
    const midpoint = (scene.startSec + scene.endSec) / 2;
    if (midpoint < style.pacing.hookWindowSec) hook.push(scene);
    else if (midpoint >= outroStart) outro.push(scene);
    else body.push(scene);
  }
  return { hook, body, outro };
}

function checkAslGroup(
  group: SceneSpecT[],
  range: [number, number],
  label: string,
  details: string[],
): boolean {
  let ok = true;
  for (const scene of group) {
    const duration = round(scene.endSec - scene.startSec, 3);
    if (duration < range[0] - 0.15 || duration > range[1] + 0.15) {
      ok = false;
      details.push(`${label} scene "${scene.id}" is ${duration}s — style allows ${range[0]}–${range[1]}s`);
    }
  }
  return ok;
}

async function buildStyleMatchSheet(opts: {
  draftFile: string;
  durationSec: number;
  styleDir: string;
  outFile: string;
}): Promise<string | null> {
  const exemplarDir = path.join(opts.styleDir, "exemplars");
  let exemplarFiles: string[] = [];
  try {
    exemplarFiles = (await fs.readdir(exemplarDir))
      .filter((f) => /\.(png|jpe?g|webp)$/i.test(f))
      .sort()
      .map((f) => path.join(exemplarDir, f))
      .slice(0, 4);
  } catch {
    return null;
  }
  if (exemplarFiles.length === 0) return null;

  const scratch = path.join(path.dirname(opts.outFile), "style-match-scratch");
  await rmrf(scratch);
  await ensureDir(scratch);
  const frameCount = 6;
  const draftFrames: { dataUri: string; label: string }[] = [];
  for (let i = 0; i < frameCount; i += 1) {
    const at = round(((i + 0.5) / frameCount) * Math.max(0.05, opts.durationSec - 0.1), 3);
    const file = path.join(scratch, `draft_${String(i + 1).padStart(2, "0")}.png`);
    await extractFrameAt(opts.draftFile, at, file, 900);
    const buf = await fs.readFile(file);
    draftFrames.push({ dataUri: `data:image/png;base64,${buf.toString("base64")}`, label: formatTimestamp(at) });
  }
  const exemplarData: { dataUri: string; label: string }[] = [];
  for (let i = 0; i < exemplarFiles.length; i += 1) {
    const buf = await fs.readFile(exemplarFiles[i] as string);
    exemplarData.push({ dataUri: `data:image/png;base64,${buf.toString("base64")}`, label: path.basename(exemplarFiles[i] as string) });
  }

  const rows = draftFrames.length;
  const rowHeight = 236;
  const height = 96 + rows * rowHeight;
  const cells = draftFrames
    .map((draft, i) => {
      const exemplar = exemplarData[i % exemplarData.length] as { dataUri: string; label: string };
      return `
      <div class="row">
        <div class="col exemplar"><div class="tag">STYLE EXEMPLAR · ${exemplar.label}</div><div class="img"><img src="${exemplar.dataUri}"/></div></div>
        <div class="col draft"><div class="tag">YOUR EDIT · ${draft.label}</div><div class="img"><img src="${draft.dataUri}"/></div></div>
      </div>`;
    })
    .join("\n");

  const html = `<!doctype html>
<html><head><meta charset="utf-8"/><style>
  html,body{margin:0;padding:0;background:#0b0d10;color:#e8eaed;font-family:"Segoe UI",Arial,sans-serif;width:1600px;height:${height}px;overflow:hidden}
  .head{display:flex;justify-content:space-between;align-items:baseline;padding:20px 26px 12px}
  .title{font-size:21px;font-weight:600;letter-spacing:.06em;text-transform:uppercase}
  .sub{font-size:13px;color:#9aa0a6;letter-spacing:.08em}
  .row{display:flex;height:${rowHeight}px;border-top:1px solid #20242b}
  .col{flex:1;display:flex;flex-direction:column;min-width:0}
  .tag{padding:6px 14px;font-size:13px;font-weight:700;letter-spacing:.07em}
  .exemplar .tag{background:#0f2740;color:#7cc0ff}
  .draft .tag{background:#123021;color:#7ef0b0}
  .img{flex:1;display:flex;align-items:center;justify-content:center;background:#000;min-height:0;border-left:1px solid #14171c}
  .img img{max-width:100%;max-height:100%;object-fit:contain;display:block}
</style></head>
<body>
  <div class="head"><div class="title">STYLE MATCH — draft vs exemplars</div><div class="sub">score visually 0–100 · patch weak scenes before render</div></div>
  ${cells}
</body></html>`;
  await ensureDir(path.dirname(opts.outFile));
  await renderHtmlToPng(html, 1600, height, opts.outFile);
  await rmrf(scratch);
  return opts.outFile;
}

/** Process 2B · Rule 5 — quantitative style compliance + visual match sheet. */
export async function runStyleVerify(opts: {
  project: UltraProjectT;
  slug: string;
  draftFile: string;
  workspace: string;
  buildDir: string;
}): Promise<StyleVerifyResult> {
  const { style, dir: styleDir } = await loadStylePack(opts.slug);
  const metrics = await auditDraft({
    draftFile: opts.draftFile,
    referenceFile: opts.draftFile,
    expectedDurationSec: opts.project.meta.durationSec,
    expectedFps: opts.project.meta.fps,
    targetLufs: style.soundDesign.targetLufs,
  });
  const lint = await lintProject({ project: opts.project, workspace: opts.workspace, buildDir: opts.buildDir });

  const details: string[] = [];
  const groups = classifyScenes(opts.project, style);
  const hookOk = checkAslGroup(groups.hook, style.pacing.hookAslSec as [number, number], "hook", details);
  const bodyOk = checkAslGroup(groups.body, style.pacing.bodyAslSec as [number, number], "body", details);
  const outroOk = checkAslGroup(groups.outro, style.pacing.outroAslSec as [number, number], "outro", details);
  const aslOk = hookOk && bodyOk && outroOk;
  if (groups.hook.length === 0) details.push("note: no hook-window scenes (first 5s shorter than hookWindowSec?)");
  if (groups.body.length === 0) details.push("note: no body scenes classified (all scenes inside hook window or outro)");

  const staticHoldOk = metrics.maxStaticHoldSec <= style.pacing.maxStaticHoldSec + 0.02;
  if (!staticHoldOk) {
    details.push(
      `longest static hold ${metrics.maxStaticHoldSec}s exceeds style maxStaticHoldSec ${style.pacing.maxStaticHoldSec}s`,
    );
  }

  const banned = new Set(style.transitions.bannedTypes);
  const usedBanned = opts.project.scenes
    .filter((s) => s.transitionIn.type !== "none" && banned.has(s.transitionIn.type))
    .map((s) => `${s.id}:${s.transitionIn.type}`);
  const transitionsOk = usedBanned.length === 0;
  if (!transitionsOk) details.push(`banned transition types used: ${usedBanned.join(", ")}`);

  const draftPalette = await sampleDraftPalette(opts.draftFile);
  const styleColors = Object.values(style.colorAndTexture.palette);
  let distanceSum = 0;
  for (const colour of styleColors) {
    const nearest = draftPalette.length > 0 ? Math.min(...draftPalette.map((d) => colourDistance(colour, d.hex))) : 441;
    distanceSum += nearest;
  }
  const paletteDistanceAvg = round(distanceSum / styleColors.length, 2);
  const paletteOk = draftPalette.length > 0 && paletteDistanceAvg <= STYLE_PALETTE_MAX_DISTANCE;
  if (!paletteOk) {
    details.push(
      `palette distance ${paletteDistanceAvg} exceeds ${STYLE_PALETTE_MAX_DISTANCE} (draft: ${draftPalette
        .slice(0, 4)
        .map((c) => c.hex)
        .join(", ") || "n/a"})`,
    );
  }

  const loudnessOk =
    metrics.loudness !== null &&
    metrics.loudness.inputI !== null &&
    Math.abs(metrics.loudness.inputI - style.soundDesign.targetLufs) <= LOUDNESS_TOLERANCE;
  if (!loudnessOk) {
    details.push(
      `loudness ${metrics.loudness?.inputI ?? "n/a"} LUFS is not within ±${LOUDNESS_TOLERANCE} of style target ${style.soundDesign.targetLufs} LUFS`,
    );
  }

  const compliance: StyleCompliance = {
    aslOk,
    staticHoldOk,
    transitionsOk,
    paletteOk,
    loudnessOk,
    paletteDistanceAvg,
    details,
    pass: aslOk && staticHoldOk && transitionsOk && paletteOk && loudnessOk,
  };

  const matchSheet = await buildStyleMatchSheet({
    draftFile: opts.draftFile,
    durationSec: opts.project.meta.durationSec,
    styleDir,
    outFile: path.join(opts.buildDir, "audit-frames", "style-match.png"),
  });

  return {
    style,
    slug: opts.slug,
    metrics,
    lint,
    compliance,
    matchSheet,
    pass: metrics.pass && lint.pass && compliance.pass,
  };
}
