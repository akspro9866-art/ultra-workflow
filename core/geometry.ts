import path from "node:path";
import { runBinary } from "./ffmpeg.js";
import { ensureDir, round } from "./util.js";
import { ultraTmpDir } from "./env.js";

/**
 * [6] Zero-dependency geometry probe: long straight lines, dominant rectangles
 * and text-like regions per segment, measured on a downscaled frame with edge
 * projection profiles (no OpenCV, no new dependencies).
 */

export interface GeometryLine {
  orientation: "v" | "h";
  x?: number;
  y?: number;
  confidence: number;
}

export interface GeometryRect {
  x: number;
  y: number;
  w: number;
  h: number;
  confidence: number;
}

export interface GeometryTextRegion {
  x: number;
  y: number;
  w: number;
  h: number;
  confidence: number;
}

export interface GeometrySegment {
  segmentIndex: number;
  lines: GeometryLine[];
  rects: GeometryRect[];
  textRegions: GeometryTextRegion[];
}

interface Peak {
  index: number;
  strength: number;
  confidence: number;
}

function mean(value: number[]): number {
  return value.length === 0 ? 0 : value.reduce((a, b) => a + b, 0) / value.length;
}

function stdDev(value: number[], avg: number): number {
  if (value.length === 0) return 0;
  return Math.sqrt(value.reduce((a, b) => a + (b - avg) ** 2, 0) / value.length);
}

/** Local maxima above an adaptive threshold, refined by a ±2-pixel weighted centroid. */
function findPeaks(profile: number[], minDistance: number, sensitivity = 3): Peak[] {
  const avg = mean(profile);
  const sd = stdDev(profile, avg);
  const threshold = Math.max(0.012, avg + sensitivity * sd);
  const peaks: Peak[] = [];
  for (let i = 2; i < profile.length - 2; i += 1) {
    const value = profile[i] as number;
    if (value < threshold) continue;
    if (
      value < (profile[i - 1] as number) ||
      value < (profile[i + 1] as number) ||
      value < (profile[i - 2] as number) ||
      value < (profile[i + 2] as number)
    ) {
      continue;
    }
    let weight = 0;
    let weighted = 0;
    for (let d = -2; d <= 2; d += 1) {
      const v = profile[i + d] as number;
      weight += v;
      weighted += v * (i + d);
    }
    const refined = weight > 0 ? weighted / weight : i;
    peaks.push({ index: refined, strength: value, confidence: round(Math.min(1, (value - threshold) / 0.15 + 0.35), 3) });
  }
  // Strongest first, enforce minimum spacing.
  peaks.sort((a, b) => b.strength - a.strength);
  const kept: Peak[] = [];
  for (const peak of peaks) {
    if (kept.some((other) => Math.abs(other.index - peak.index) < minDistance)) continue;
    kept.push(peak);
  }
  return kept.sort((a, b) => a.index - b.index);
}

function profileVertical(gray: Float64Array, w: number, h: number): number[] {
  const profile = new Array<number>(w).fill(0);
  for (let x = 1; x < w - 1; x += 1) {
    let sum = 0;
    for (let y = 0; y < h; y += 1) {
      sum += Math.abs((gray[y * w + x + 1] as number) - (gray[y * w + x - 1] as number));
    }
    profile[x] = sum / h / 255;
  }
  return profile;
}

function profileHorizontal(gray: Float64Array, w: number, h: number): number[] {
  const profile = new Array<number>(h).fill(0);
  for (let y = 1; y < h - 1; y += 1) {
    let sum = 0;
    for (let x = 0; x < w; x += 1) {
      sum += Math.abs((gray[(y + 1) * w + x] as number) - (gray[(y - 1) * w + x] as number));
    }
    profile[y] = sum / w / 255;
  }
  return profile;
}

async function grayFrameAt(refPath: string, atSec: number, scaledWidth: number): Promise<{ gray: Float64Array; w: number; h: number } | null> {
  await ensureDir(ultraTmpDir());
  try {
    const result = await runBinary("ffmpeg", [
      "-v",
      "error",
      "-ss",
      atSec.toFixed(3),
      "-i",
      refPath,
      "-frames:v",
      "1",
      "-vf",
      `scale=${scaledWidth}:-2:flags=area,format=gray`,
      "-f",
      "rawvideo",
      "-pix_fmt",
      "gray",
      "-",
    ]);
    if (result.code !== 0) return null;
    // Derive the height from the byte count (scale keeps the aspect ratio).
    let scaledHeight = Math.round(result.stdout.length / scaledWidth);
    if (scaledHeight <= 0) return null;
    const bytes = result.stdout.subarray(0, scaledWidth * scaledHeight);
    const gray = new Float64Array(bytes.length);
    for (let i = 0; i < bytes.length; i += 1) gray[i] = bytes[i] as number;
    return { gray, w: scaledWidth, h: scaledHeight };
  } catch {
    return null;
  }
}

function rowEdgeDensity(gray: Float64Array, w: number, h: number): number[] {
  const rows = new Array<number>(h).fill(0);
  for (let y = 1; y < h - 1; y += 1) {
    let sum = 0;
    for (let x = 1; x < w - 1; x += 1) {
      const dx = Math.abs((gray[y * w + x + 1] as number) - (gray[y * w + x - 1] as number));
      const dy = Math.abs((gray[(y + 1) * w + x] as number) - (gray[(y - 1) * w + x] as number));
      sum += dx + dy;
    }
    rows[y] = sum / w / 510;
  }
  return rows;
}

function detectTextRegions(gray: Float64Array, w: number, h: number): GeometryTextRegion[] {
  const rows = rowEdgeDensity(gray, w, h);
  const avg = mean(rows);
  const sd = stdDev(rows, avg);
  const rowThreshold = Math.max(0.02, avg + 0.75 * sd);
  const regions: GeometryTextRegion[] = [];
  let start = -1;
  for (let y = 0; y <= h; y += 1) {
    const active = y < h && (rows[y] as number) > rowThreshold;
    if (active && start === -1) start = y;
    if (!active && start !== -1) {
      const end = y;
      if (end - start >= 5) {
        let left = w;
        let right = 0;
        for (let yy = start; yy < end; yy += 1) {
          for (let x = 1; x < w - 1; x += 1) {
            const dx = Math.abs((gray[yy * w + x + 1] as number) - (gray[yy * w + x - 1] as number));
            if (dx / 255 > 0.08) {
              left = Math.min(left, x);
              right = Math.max(right, x);
            }
          }
        }
        if (right - left >= 10) {
          regions.push({ x: left, y: start, w: right - left, h: end - start, confidence: round(Math.min(1, (end - start) / 24), 3) });
        }
      }
      start = -1;
    }
  }
  return regions.slice(0, 6);
}

export async function probeGeometry(
  refPath: string,
  segments: { index: number; startSec: number; endSec: number }[],
  width: number,
  height: number,
): Promise<GeometrySegment[]> {
  const out: GeometrySegment[] = [];
  const scaledWidth = Math.max(160, Math.min(960, width % 2 === 0 ? width : width - 1));
  for (const segment of segments) {
    const mid = (segment.startSec + segment.endSec) / 2;
    const frame = await grayFrameAt(refPath, mid, scaledWidth);
    if (!frame) {
      out.push({ segmentIndex: segment.index, lines: [], rects: [], textRegions: [] });
      continue;
    }
    const { gray, w, h } = frame;
    const scaleX = width / w;
    const scaleY = height / h;
    const vProfile = profileVertical(gray, w, h);
    const hProfile = profileHorizontal(gray, w, h);
    const vPeaks = findPeaks(vProfile, Math.max(4, Math.round(w * 0.01)));
    const hPeaks = findPeaks(hProfile, Math.max(4, Math.round(h * 0.01)));

    const lines: GeometryLine[] = [
      ...vPeaks.slice(0, 12).map((peak) => ({ orientation: "v" as const, x: Math.round(peak.index * scaleX), confidence: peak.confidence })),
      ...hPeaks.slice(0, 12).map((peak) => ({ orientation: "h" as const, y: Math.round(peak.index * scaleY), confidence: peak.confidence })),
    ];

    // Dominant rectangles: a pair of vertical lines + a pair of horizontal lines.
    const rects: GeometryRect[] = [];
    const strongV = vPeaks.filter((p) => p.confidence >= 0.4).slice(0, 6);
    const strongH = hPeaks.filter((p) => p.confidence >= 0.4).slice(0, 6);
    for (let i = 0; i < strongV.length; i += 1) {
      for (let j = i + 1; j < strongV.length; j += 1) {
        const x1 = strongV[i] as Peak;
        const x2 = strongV[j] as Peak;
        if (Math.abs(x2.index - x1.index) < w * 0.15) continue;
        for (let a = 0; a < strongH.length; a += 1) {
          for (let b = a + 1; b < strongH.length; b += 1) {
            const y1 = strongH[a] as Peak;
            const y2 = strongH[b] as Peak;
            if (Math.abs(y2.index - y1.index) < h * 0.1) continue;
            const confidence = round(Math.min(x1.confidence, x2.confidence, y1.confidence, y2.confidence), 3);
            rects.push({
              x: Math.round(Math.min(x1.index, x2.index) * scaleX),
              y: Math.round(Math.min(y1.index, y2.index) * scaleY),
              w: Math.round(Math.abs(x2.index - x1.index) * scaleX),
              h: Math.round(Math.abs(y2.index - y1.index) * scaleY),
              confidence,
            });
            if (rects.length >= 3) break;
          }
          if (rects.length >= 3) break;
        }
        if (rects.length >= 3) break;
      }
      if (rects.length >= 3) break;
    }

    const textRegions = detectTextRegions(gray, w, h).map((region) => ({
      x: Math.round(region.x * scaleX),
      y: Math.round(region.y * scaleY),
      w: Math.round(region.w * scaleX),
      h: Math.round(region.h * scaleY),
      confidence: region.confidence,
    }));

    out.push({ segmentIndex: segment.index, lines, rects, textRegions });
  }
  return out;
}

export function geometryFileName(workspace: string): string {
  return path.join(workspace, "geometry.json");
}
