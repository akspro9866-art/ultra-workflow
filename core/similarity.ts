import { promises as fs } from "node:fs";
import path from "node:path";
import { ffmpeg, ffmpegOk, runBinary } from "./ffmpeg.js";
import { extractFrameAt } from "./probe.js";
import { ultraTmpDir } from "./env.js";
import { ensureDir, round } from "./util.js";

/**
 * [18] Asset ↔ reference-segment similarity. Existence/dimension/alpha/SHA-1
 * checks answer "is this a usable file"; these scores answer "is this the
 * right PICTURE" — the 4/10 cause when a generated wren/lake/blossom is a
 * different photograph with the same layout slot.
 */

export interface SimilarityScores {
  ssimToRefSegment: number | null;
  histogramDistance: number | null;
  edgeDensityRatio: number | null;
}

const CROP_W = 256;
const CROP_H = 144;
const TINY_W = 128;
const TINY_H = 72;

/** Size-matched centre crop: scale to cover, then crop — removes aspect bias. */
async function framedCrop(input: string, out: string, width: number, height: number): Promise<void> {
  await ffmpegOk(
    [
      "-i",
      input,
      "-frames:v",
      "1",
      "-vf",
      `scale=${width}:${height}:force_original_aspect_ratio=increase:flags=lanczos,crop=${width}:${height}`,
      "-pix_fmt",
      "rgb24",
      "-y",
      out,
    ],
    { timeoutMs: 60_000 },
  );
}

async function ssimBetweenCrops(a: string, b: string): Promise<number | null> {
  try {
    const run = await ffmpeg(
      [
        "-i",
        a,
        "-i",
        b,
        "-filter_complex",
        "[0:v]format=yuv420p[r];[1:v]format=yuv420p[d];[r][d]ssim",
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

/** Decode a crop to tiny RGB; return 24-bucket histogram + Sobel edge density. */
async function statsFromRgb(file: string): Promise<{ histogram: number[]; edgeDensity: number } | null> {
  try {
    const result = await runBinary("ffmpeg", [
      "-v",
      "error",
      "-i",
      path.isAbsolute(file) ? file : path.resolve(file),
      "-frames:v",
      "1",
      "-vf",
      `scale=${TINY_W}:${TINY_H}:flags=area`,
      "-f",
      "rawvideo",
      "-pix_fmt",
      "rgb24",
      "-",
    ]);
    if (result.code !== 0 || result.stdout.length < TINY_W * TINY_H * 3) return null;
    const buf = result.stdout;
    const pixels = TINY_W * TINY_H;
    // 24-bucket RGB histogram: 4 R levels × 2 G levels × 3 B levels.
    const histogram = new Array<number>(24).fill(0);
    const gray = new Float64Array(pixels);
    for (let i = 0; i < pixels; i += 1) {
      const r = buf[i * 3] as number;
      const g = buf[i * 3 + 1] as number;
      const b = buf[i * 3 + 2] as number;
      const bucket = (r >> 6) * 6 + (g >> 7) * 3 + Math.min(2, Math.floor((b * 3) / 256));
      histogram[bucket] = (histogram[bucket] as number) + 1;
      gray[i] = 0.2126 * r + 0.7152 * g + 0.0722 * b;
    }
    for (let i = 0; i < 24; i += 1) histogram[i] = (histogram[i] as number) / pixels;
    // Sobel mean magnitude (normalized 0..1).
    let edgeSum = 0;
    let samples = 0;
    for (let y = 1; y < TINY_H - 1; y += 1) {
      for (let x = 1; x < TINY_W - 1; x += 1) {
        const at = (xx: number, yy: number) => gray[yy * TINY_W + xx] as number;
        const gx =
          -at(x - 1, y - 1) - 2 * at(x - 1, y) - at(x - 1, y + 1) +
          at(x + 1, y - 1) + 2 * at(x + 1, y) + at(x + 1, y + 1);
        const gy =
          -at(x - 1, y - 1) - 2 * at(x, y - 1) - at(x + 1, y - 1) +
          at(x - 1, y + 1) + 2 * at(x, y + 1) + at(x + 1, y + 1);
        edgeSum += Math.sqrt(gx * gx + gy * gy);
        samples += 1;
      }
    }
    return { histogram, edgeDensity: samples > 0 ? edgeSum / samples / 255 : 0 };
  } catch {
    return null;
  }
}

function histogramDistance(a: number[], b: number[]): number {
  let sum = 0;
  for (let i = 0; i < a.length; i += 1) sum += Math.abs((a[i] as number) - (b[i] as number));
  // Total variation ∈ [0, 2]; normalize to [0, 1].
  return round(sum / 2, 4);
}

let scratchCounter = 0;

/**
 * Compare an image asset to the reference frame its scene replaces.
 * `atSec` is normally the midpoint of the asset's target scene/segment.
 */
export async function compareAssetToReference(
  assetFile: string,
  referenceFile: string,
  atSec: number,
): Promise<SimilarityScores> {
  scratchCounter += 1;
  const scratch = path.join(ultraTmpDir(), `ultra-similarity-${process.pid}-${scratchCounter}`);
  await ensureDir(scratch);
  try {
    const refFrame = path.join(scratch, "ref.png");
    await extractFrameAt(referenceFile, Math.max(0, atSec), refFrame, 960);
    const assetCrop = path.join(scratch, "asset-crop.png");
    const refCrop = path.join(scratch, "ref-crop.png");
    await framedCrop(assetFile, assetCrop, CROP_W, CROP_H);
    await framedCrop(refFrame, refCrop, CROP_W, CROP_H);
    const [ssim, assetStats, refStats] = await Promise.all([
      ssimBetweenCrops(assetCrop, refCrop),
      statsFromRgb(assetCrop),
      statsFromRgb(refCrop),
    ]);
    const histogramDistanceValue =
      assetStats && refStats ? histogramDistance(assetStats.histogram, refStats.histogram) : null;
    let edgeDensityRatio: number | null = null;
    if (assetStats && refStats) {
      if (refStats.edgeDensity < 0.004) {
        // No texture in the reference crop (solid plate): ratio is meaningless.
        edgeDensityRatio = assetStats.edgeDensity < 0.004 ? 1 : null;
      } else {
        edgeDensityRatio = round(assetStats.edgeDensity / refStats.edgeDensity, 4);
      }
    }
    return { ssimToRefSegment: ssim, histogramDistance: histogramDistanceValue, edgeDensityRatio };
  } finally {
    await fs.rm(scratch, { recursive: true, force: true }).catch(() => undefined);
  }
}
