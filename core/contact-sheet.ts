import { promises as fs } from "node:fs";
import path from "node:path";
import { renderHtmlToPng, getBrowserInfo } from "./browser.js";
import { ffmpegOk } from "./ffmpeg.js";
import { discoverFonts } from "./env.js";
import { escapeFilterPath } from "./stitcher.js";
import { ensureDir, formatTimestamp } from "./util.js";

/**
 * [22] Shared contact-sheet renderer. Probe uses it for 3x3 reference sheets;
 * every build (full, --scene, preview ranges) regenerates build/contact-sheet.png
 * from the current draft — the "always-on contact sheet instead of a GUI".
 */

export interface ContactSheetFrame {
  dataUri: string;
  label: string;
  index: number;
  cutIndex: number | null;
  sceneIndex: number;
  swatches: string[];
}

export function contactSheetHtml(frames: ContactSheetFrame[], sheetIndex: number, title: string): string {
  const cells = frames
    .map(
      (f) => `
      <div class="cell">
        <div class="frame-wrap"><img src="${f.dataUri}" alt="frame ${f.index}" /></div>
        <div class="label">
          <div class="left"><span class="idx">#${String(f.index).padStart(3, "0")}</span>${
            f.cutIndex !== null ? `<span class="cut">CUT #${f.cutIndex}</span>` : ""
          }<span class="scene">S${f.sceneIndex + 1}</span><span class="sw">${f.swatches
            .map((hex) => `<i style="background:${hex}"></i>`)
            .join("")}</span></div>
          <span class="ts">${f.label}</span>
        </div>
      </div>`,
    )
    .join("\n");
  return `<!doctype html>
<html><head><meta charset="utf-8"/>
<style>
  html,body { margin:0; padding:0; background:#0b0d10; color:#e8eaed;
    font-family:"Segoe UI","Inter","Helvetica Neue",Arial,sans-serif; width:1600px; height:1100px; overflow:hidden; }
  .head { display:flex; justify-content:space-between; align-items:baseline; padding:22px 28px 12px; }
  .title { font-size:22px; font-weight:600; letter-spacing:0.06em; text-transform:uppercase; }
  .sub { font-size:13px; color:#9aa0a6; letter-spacing:0.08em; }
  .grid { display:grid; grid-template-columns:repeat(3, 1fr); grid-template-rows:repeat(3, 1fr);
    gap:14px; padding:0 28px 24px; box-sizing:border-box; height:1010px; }
  .cell { background:#14171c; border:1px solid #23272e; border-radius:8px; display:flex; flex-direction:column; overflow:hidden; }
  .frame-wrap { flex:1; display:flex; align-items:center; justify-content:center; background:#000; min-height:0; }
  .frame-wrap img { max-width:100%; max-height:100%; object-fit:contain; display:block; }
  .label { display:flex; justify-content:space-between; align-items:center; padding:8px 12px; font-size:15px; border-top:1px solid #23272e; background:#101318; gap:10px; }
  .left { display:flex; align-items:center; gap:8px; min-width:0; }
  .idx { color:#8ab4f8; font-weight:600; }
  .cut { color:#ffd166; font-size:12px; font-weight:700; letter-spacing:0.06em; border:1px solid #4b3c16; border-radius:4px; padding:1px 5px; }
  .scene { color:#9aa0a6; font-size:12px; letter-spacing:0.06em; }
  .sw { display:inline-flex; gap:3px; }
  .sw i { width:12px; height:12px; border-radius:3px; display:inline-block; border:1px solid rgba(255,255,255,0.2); }
  .ts { font-family:"Cascadia Mono","Consolas",monospace; color:#e8eaed; white-space:nowrap; }
</style></head>
<body>
  <div class="head">
    <div class="title">${title}</div>
    <div class="sub">CONTACT SHEET ${String(sheetIndex).padStart(2, "0")}</div>
  </div>
  <div class="grid">${cells}</div>
</body></html>`;
}

export async function renderContactSheetHtml(html: string, outFile: string): Promise<void> {
  await renderHtmlToPng(html, 1600, 1100, outFile);
}

/**
 * Extract up to 9 evenly spaced frames from a video into a single 3x3 sheet.
 * Browser path = labeled HTML sheet; browserless path = FFmpeg fps+tile+drawtext.
 */
export async function renderDraftContactSheet(opts: {
  video: string;
  outFile: string;
  title: string;
  durationSec: number;
}): Promise<void> {
  await ensureDir(path.dirname(opts.outFile));
  const browserAvailable =
    process.env.ULTRA_NO_BROWSER !== "1" && (await getBrowserInfo().catch(() => ({ available: false }))).available;
  const count = 9;
  const step = Math.max(0.05, opts.durationSec / count);

  if (!browserAvailable) {
    const fonts = await discoverFonts().catch(() => null);
    const font = fonts?.bold ?? fonts?.regular ?? null;
    const fontOpt = font ? `:fontfile='${escapeFilterPath(font)}'` : "";
    const fpsExpr = count / Math.max(0.2, opts.durationSec);
    const draw = (text: string, x: number, y: number, size: number, color: string) =>
      `drawtext=text='${text}':x=${x}:y=${y}:fontsize=${size}:fontcolor=${color}${fontOpt}`;
    const filters = [
      `fps=${fpsExpr.toFixed(6)}`,
      "scale=480:270:force_original_aspect_ratio=decrease",
      "pad=480:270:(ow-iw)/2:(oh-ih)/2:color=0x101820",
      draw("%{pts\\:hms}", 8, 8, 16, "0xffffff"),
      "tile=3x3",
    ].join(",");
    await ffmpegOk(["-i", opts.video, "-vf", filters, "-frames:v", "1", "-y", opts.outFile], { timeoutMs: 120_000 });
    return;
  }

  const frames: ContactSheetFrame[] = [];
  for (let i = 0; i < count; i += 1) {
    const at = Math.min(Math.max(0, opts.durationSec - 0.05), i * step);
    const tmp = path.join(path.dirname(opts.outFile), `.cs-${i}.png`);
    await ffmpegOk(["-ss", at.toFixed(3), "-i", opts.video, "-frames:v", "1", "-vf", "scale=480:-2", "-y", tmp], {
      timeoutMs: 60_000,
    });
    const buffer = await fs.readFile(tmp);
    await fs.rm(tmp, { force: true });
    frames.push({
      dataUri: `data:image/png;base64,${buffer.toString("base64")}`,
      label: formatTimestamp(at),
      index: i + 1,
      cutIndex: null,
      sceneIndex: 0,
      swatches: [],
    });
  }
  await renderContactSheetHtml(contactSheetHtml(frames, 1, opts.title), opts.outFile);
}
