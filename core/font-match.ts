import { promises as fs } from "node:fs";
import path from "node:path";
import { ffmpeg, ffmpegOk, runBinary } from "./ffmpeg.js";
import { discoverFonts, listBundledFonts, ultraTmpDir } from "./env.js";
import { escapeFilterPath } from "./stitcher.js";
import { ensureDir, round } from "./util.js";

/**
 * [14] ultra font-match: rank candidate fonts offline (bundled + workspace +
 * --candidates) against an image. Renders each candidate with ffmpeg drawtext
 * at the image's measured ink height and compares the width profile (and SSIM
 * when --text is given). No browser, no network.
 */

export interface FontCandidate {
  family: string;
  file: string;
}

export interface FontMatchResult {
  family: string;
  file: string;
  widthErrorPercent: number;
  ssim: number | null;
  /** Normalized ink width at the input's cap height (extra diagnostic). */
  inkWidthPx: number;
}

interface InkBox {
  x: number;
  y: number;
  w: number;
  h: number;
}

async function decodeGray(file: string, maxWidth = 900): Promise<{ gray: number[]; w: number; h: number } | null> {
  try {
    const probeRun = await runBinary("ffmpeg", ["-v", "error", "-i", file, "-frames:v", "1", "-vf", `scale=${maxWidth}:-2:flags=area,format=gray`, "-f", "rawvideo", "-pix_fmt", "gray", "-"]);
    if (probeRun.code !== 0 || probeRun.stdout.length === 0) return null;
    const w = maxWidth;
    const h = Math.floor(probeRun.stdout.length / w);
    if (h < 2) return null;
    const gray = Array.from(probeRun.stdout.subarray(0, w * h));
    return { gray, w, h };
  } catch {
    return null;
  }
}

function inkBox(gray: number[], w: number, h: number): { box: InkBox | null; bg: number } {
  const at = (x: number, y: number) => gray[y * w + x] as number;
  const corners = [at(0, 0), at(w - 1, 0), at(0, h - 1), at(w - 1, h - 1)];
  const bg = corners.reduce((a, b) => a + b, 0) / 4;
  let minX = w, minY = h, maxX = -1, maxY = -1;
  for (let y = 0; y < h; y += 1) {
    for (let x = 0; x < w; x += 1) {
      if (Math.abs(at(x, y) - bg) > 40) {
        minX = Math.min(minX, x);
        minY = Math.min(minY, y);
        maxX = Math.max(maxX, x);
        maxY = Math.max(maxY, y);
      }
    }
  }
  if (maxX < minX || maxY < minY) return { box: null, bg };
  return { box: { x: minX, y: minY, w: maxX - minX + 1, h: maxY - minY + 1 }, bg };
}

async function candidateFonts(candidatesDir?: string, workspace = path.resolve(process.cwd(), "workspace")): Promise<FontCandidate[]> {
  const out: FontCandidate[] = [];
  const add = (file: string) => {
    const family = path.basename(file).replace(/\.(ttf|otf)$/i, "");
    if (!out.some((candidate) => candidate.file === file)) out.push({ family, file });
  };
  for (const bundled of await listBundledFonts()) add(bundled.path);
  const discovered = await discoverFonts(workspace).catch(() => null);
  for (const file of [discovered?.regular, discovered?.bold, discovered?.mono]) if (file) add(file);
  const extraDirs = [path.join(workspace, "assets", "fonts"), ...(candidatesDir ? [path.resolve(candidatesDir)] : [])];
  const walk = async (dir: string, depth: number) => {
    if (depth < 0) return;
    let entries: string[];
    try {
      entries = await fs.readdir(dir);
    } catch {
      return;
    }
    for (const entry of entries) {
      const full = path.join(dir, entry);
      const stat = await fs.stat(full).catch(() => null);
      if (!stat) continue;
      if (stat.isDirectory()) await walk(full, depth - 1);
      else if (/\.(ttf|otf)$/i.test(entry)) add(full);
    }
  };
  for (const dir of extraDirs) await walk(dir, 2);
  return out.sort((a, b) => a.family.localeCompare(b.family));
}

async function renderText(font: string, text: string, outFile: string, fontSize = 120): Promise<void> {
  const escapedText = text.replace(/\\/g, "\\\\").replace(/'/g, "").replace(/:/g, "\\:").replace(/,/g, "\\,").replace(/\[/g, "\\[").replace(/\]/g, "\\]");
  await ffmpegOk(
    [
      "-f",
      "lavfi",
      "-i",
      "color=c=white:s=2400x400:d=1",
      "-vf",
      `drawtext=fontfile='${escapeFilterPath(font)}':text='${escapedText}':fontsize=${fontSize}:fontcolor=black:x=40:y=80`,
      "-frames:v",
      "1",
      "-y",
      outFile,
    ],
    { timeoutMs: 60_000 },
  );
}

async function ssimBetween(a: string, b: string): Promise<number | null> {
  try {
    const run = await ffmpeg([
      "-i",
      a,
      "-i",
      b,
      "-filter_complex",
      "[0:v]format=gray[r];[1:v]format=gray[d];[r][d]ssim",
      "-f",
      "null",
      "-",
    ], { timeoutMs: 60_000 });
    const match = run.stderr.match(/All:\s*([0-9]+(?:\.[0-9]+)?)/);
    return match ? round(Number(match[1]), 4) : null;
  } catch {
    return null;
  }
}

/**
 * Rank candidates. widthErrorPercent compares the candidate's ink width scaled
 * to the input's ink height against the input's ink width (condensed fonts win).
 */
export async function fontMatch(
  image: string,
  options: { candidatesDir?: string; text?: string; workspace?: string } = {},
): Promise<FontMatchResult[]> {
  const workspace = options.workspace ?? path.resolve(process.cwd(), "workspace");
  const source = await decodeGray(image);
  if (!source) throw new Error(`font-match: cannot read image ${image}`);
  const { box } = inkBox(source.gray, source.w, source.h);
  if (!box) throw new Error("font-match: no ink found in the image (blank?)");
  const capHeight = box.h;
  const inputWidth = box.w;
  const scratch = path.join(ultraTmpDir(), `ultra-font-match-${process.pid}-${Date.now()}`);
  await ensureDir(scratch);
  const inputCrop = path.join(scratch, "input.png");
  await ffmpegOk(["-i", image, "-vf", `crop=${box.w}:${box.h}:${box.x}:${box.y}`, "-frames:v", "1", "-y", inputCrop]);
  const text = options.text ?? "ABCDEFGHIJKLMNOPQRSTUVWXYZ";
  const withText = Boolean(options.text);
  const results: FontMatchResult[] = [];
  try {
    const candidates = await candidateFonts(options.candidatesDir, workspace);
    for (let i = 0; i < candidates.length; i += 1) {
      const candidate = candidates[i] as FontCandidate;
      const render = path.join(scratch, `cand-${i}.png`);
      try {
        await renderText(candidate.file, text, render);
      } catch {
        continue;
      }
      const decoded = await decodeGray(render, 2200);
      if (!decoded) continue;
      const rendered = inkBox(decoded.gray, decoded.w, decoded.h);
      if (!rendered.box) continue;
      const renderBox = rendered.box;
      // Normalize both renders to the input's cap height (px).
      const normalizedWidth = (renderBox.w / renderBox.h) * capHeight;
      const widthErrorPercent = round((Math.abs(normalizedWidth - inputWidth) / Math.max(1, inputWidth)) * 100, 2);
      let ssim: number | null = null;
      if (withText) {
        const crop = path.join(scratch, `crop-${i}.png`);
        await ffmpegOk(["-i", render, "-vf", `crop=${renderBox.w}:${renderBox.h}:${renderBox.x}:${renderBox.y},scale=${Math.max(2, box.w)}:${Math.max(2, box.h)}`, "-frames:v", "1", "-y", crop]);
        ssim = await ssimBetween(inputCrop, crop);
        await fs.rm(crop, { force: true });
      }
      await fs.rm(render, { force: true });
      results.push({
        family: candidate.family,
        file: candidate.file,
        widthErrorPercent,
        ssim,
        inkWidthPx: round(normalizedWidth, 1),
      });
    }
  } finally {
    await fs.rm(scratch, { recursive: true, force: true }).catch(() => undefined);
  }
  return results.sort((a, b) => {
    if (a.widthErrorPercent !== b.widthErrorPercent) return a.widthErrorPercent - b.widthErrorPercent;
    return (b.ssim ?? 0) - (a.ssim ?? 0);
  });
}
