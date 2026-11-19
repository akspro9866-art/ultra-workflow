import { promises as fs } from "node:fs";
import path from "node:path";
import type { ProbeResultT, UltraProjectT } from "../core/schema.js";
import { extractFrameAt } from "../core/probe.js";
import { renderHtmlToPng, getBrowserInfo } from "../core/browser.js";
import { ffmpeg, ffmpegOk } from "../core/ffmpeg.js";
import { discoverFonts } from "../core/env.js";
import { escapeFilterPath } from "../core/stitcher.js";
import { ensureDir, formatTimestamp, rmrf, round } from "../core/util.js";

export interface VisualPair {
  index: number;
  path: string;
  timestampSec: number;
  sceneId: string;
  ssim: number | null;
}

/** Browserless pair composition: FFmpeg hstack + optional drawtext labels. */
async function composePairFfmpeg(
  refFile: string,
  draftFile: string,
  outFile: string,
  timestampSec: number,
  sceneId: string,
): Promise<void> {
  const fonts = await discoverFonts().catch(() => null);
  const fontFile = fonts?.bold ?? fonts?.regular ?? null;
  const fontOpt = fontFile ? `:fontfile='${escapeFilterPath(fontFile)}'` : "";
  const draw = (text: string, x: number, y: number, size: number, color: string) => {
    const escaped = text
      .replace(/\\/g, "\\\\")
      .replace(/'/g, "")
      .replace(/:/g, "\\:")
      .replace(/,/g, "\\,")
      .replace(/\[/g, "\\[")
      .replace(/\]/g, "\\]");
    return `drawtext=text='${escaped}':x=${x}:y=${y}:fontsize=${size}:fontcolor=${color}${fontOpt}`;
  };
  const half = "[0:v]scale=760:420:force_original_aspect_ratio=decrease,pad=760:420:(ow-iw)/2:(oh-ih)/2:color=black,pad=800:470:20:44:color=0x151a21[a]";
  const half2 = "[1:v]scale=760:420:force_original_aspect_ratio=decrease,pad=760:420:(ow-iw)/2:(oh-ih)/2:color=black,pad=800:470:20:44:color=0x151a21[b]";
  const labels = fontFile
    ? [
        draw("ORIGINAL", 24, 14, 20, "0xff8a93"),
        draw("DRAFT", 824, 14, 20, "0x7cc0ff"),
        draw(formatTimestamp(timestampSec), 24, 448, 15, "0xffffff"),
        draw(sceneId.replace(/[^A-Za-z0-9._-]/g, "_"), 1400, 448, 15, "0x8ab4f8"),
      ].join(",")
    : null;
  const graph = `${half};${half2};[a][b]hstack=inputs=2${labels ? `,${labels}` : ""}[out]`;
  await ffmpegOk(["-i", refFile, "-i", draftFile, "-filter_complex", graph, "-map", "[out]", "-frames:v", "1", outFile], {
    timeoutMs: 120_000,
  });
}
async function ssimBetween(a: string, b: string): Promise<number | null> {
  try {
    const run = await ffmpeg(
      [
        "-i",
        a,
        "-i",
        b,
        "-filter_complex",
        "[0:v]scale=480:270,format=yuv420p[r];[1:v]scale=480:270,format=yuv420p[d];[r][d]ssim",
        "-f",
        "null",
        "-",
      ],
      { timeoutMs: 60_000 },
    );
    const match = run.stderr.match(/All:\s*([0-9]+(?:\.[0-9]+)?)/);
    return match ? round(Number(match[1]), 4) : null;
  } catch {
    return null;
  }
}

export function sceneIdAt(project: UltraProjectT, t: number): string {
  const main = project.scenes
    .filter((s) => !s.overlayOfSceneId)
    .sort((a, b) => a.startSec - b.startSec);
  for (const scene of main) {
    if (t >= scene.startSec - 0.001 && t < scene.endSec - 0.001) return scene.id;
  }
  return main[main.length - 1]?.id ?? "unknown";
}

function pairHtml(left: string, right: string, label: string, sub: string): string {
  return `<!doctype html>
<html><head><meta charset="utf-8"/><style>
  html,body{margin:0;padding:0;background:#0b0d10;color:#e8eaed;font-family:"Segoe UI","Inter",Arial,sans-serif;width:1720px;height:660px;overflow:hidden}
  .row{display:flex;height:600px}
  .col{flex:1;display:flex;flex-direction:column;min-width:0}
  .tag{padding:10px 18px;font-size:17px;font-weight:700;letter-spacing:.08em}
  .orig .tag{background:#3b1418;color:#ff8a93}
  .draft .tag{background:#0f2740;color:#7cc0ff}
  .img{flex:1;display:flex;align-items:center;justify-content:center;background:#000;border:1px solid #20242b;min-height:0}
  .img img{max-width:100%;max-height:100%;object-fit:contain;display:block}
  .foot{height:60px;display:flex;align-items:center;justify-content:space-between;padding:0 22px;font-size:16px;color:#c8ccd2;border-top:1px solid #20242b}
  .ts{font-family:"Cascadia Mono","Consolas",monospace;color:#ffd166}
  .sid{color:#8ab4f8}
</style></head>
<body>
  <div class="row">
    <div class="col orig"><div class="tag">ORIGINAL</div><div class="img"><img src="${left}"/></div></div>
    <div class="col draft"><div class="tag">DRAFT</div><div class="img"><img src="${right}"/></div></div>
  </div>
  <div class="foot"><span class="ts">${label}</span><span>${sub}</span><span class="sid">ULTRA · side-by-side audit</span></div>
</body></html>`;
}

export async function buildVisualPairs(opts: {
  reference: string;
  draft: string;
  project: UltraProjectT;
  outDir: string;
  probe?: ProbeResultT | null;
  maxPairs?: number;
}): Promise<VisualPair[]> {
  const { project } = opts;
  const duration = project.meta.durationSec;
  const times = new Set<number>();
  times.add(0);
  times.add(round(Math.max(0, duration - 0.08), 3));
  for (const cut of opts.probe?.cutsSec ?? []) if (cut > 0.05 && cut < duration - 0.05) times.add(round(cut, 3));
  const main = [...project.scenes].filter((s) => !s.overlayOfSceneId).sort((a, b) => a.startSec - b.startSec);
  for (const scene of main) {
    times.add(round((scene.startSec + scene.endSec) / 2, 3));
    if (scene.transitionIn.type !== "none" && scene.transitionIn.durationSec > 0) {
      times.add(round(scene.startSec, 3));
    }
  }
  const ordered = [...times].sort((a, b) => a - b).filter((t, i, arr) => i === 0 || t - (arr[i - 1] as number) > 0.08);
  const capped = ordered.slice(0, opts.maxPairs ?? 14);

  await rmrf(opts.outDir);
  await ensureDir(opts.outDir);
  const scratch = path.join(opts.outDir, "scratch");
  await ensureDir(scratch);
  const browserAvailable = process.env.ULTRA_NO_BROWSER !== "1" && (await getBrowserInfo().catch(() => ({ available: false }))).available;

  const pairs: VisualPair[] = [];
  for (let i = 0; i < capped.length; i += 1) {
    const t = capped[i] as number;
    const refFrame = path.join(scratch, `ref_${String(i + 1).padStart(2, "0")}.png`);
    const draftFrame = path.join(scratch, `draft_${String(i + 1).padStart(2, "0")}.png`);
    await extractFrameAt(opts.reference, t, refFrame, 960);
    await extractFrameAt(opts.draft, Math.min(t, duration - 0.05), draftFrame, 960);
    const sceneId = sceneIdAt(project, t);
    const ssim = await ssimBetween(refFrame, draftFrame);
    const out = path.join(opts.outDir, `pair_${String(i + 1).padStart(2, "0")}.png`);
    if (browserAvailable) {
      const [refBuf, draftBuf] = await Promise.all([fs.readFile(refFrame), fs.readFile(draftFrame)]);
      const html = pairHtml(
        `data:image/png;base64,${refBuf.toString("base64")}`,
        `data:image/png;base64,${draftBuf.toString("base64")}`,
        formatTimestamp(t),
        `${sceneId} · pair ${String(i + 1).padStart(2, "0")}`,
      );
      await renderHtmlToPng(html, 1720, 660, out);
    } else {
      await composePairFfmpeg(refFrame, draftFrame, out, t, sceneId);
    }
    pairs.push({ index: i + 1, path: out, timestampSec: t, sceneId, ssim });
  }
  await rmrf(scratch);
  return pairs;
}
